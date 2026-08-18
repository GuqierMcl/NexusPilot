use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::watch;

use crate::engine::types::{
    SqlExecutionContext, SqlExecutionEvent, SqlExecutionFailure, SqlExecutionOptions,
    SqlExecutionOutcome, SqlExecutionSnapshot, SqlExecutionState, SqlExecutionSummary,
    SqlStatementClass,
};
use crate::error::{IpcError, IpcResult};

pub(crate) mod artifact;

use self::artifact::RawArtifactWriter;

const MAX_OBSERVATION_WARNINGS: usize = 4;
const MAX_OBSERVATION_WARNING_CHARS: usize = 256;

pub trait SqlExecutionEventSink: Send + Sync {
    fn publish(&self, event: SqlExecutionEvent) -> Result<(), String>;
}

pub struct ManagedSqlExecutionRequest {
    pub execution_id: String,
    pub query_id: String,
    pub context: SqlExecutionContext,
    pub sql: String,
    pub options: SqlExecutionOptions,
    pub statement_class: SqlStatementClass,
    pub raw_artifact: Option<RawArtifactWriter>,
}

#[derive(Debug, Clone)]
pub struct ManagedSqlCancelRequest {
    pub execution_id: String,
    pub query_id: String,
    pub tab_id: String,
}

#[derive(Debug, Clone)]
pub enum SqlCancelConfirmation {
    Confirmed(String),
    AlreadyFinished(String),
    Failed(SqlExecutionFailure),
}

pub trait SqlExecutionObserver: Send + Sync {
    fn publish_summary(&self, summary: SqlExecutionSummary, progress_available: bool);
    fn publish_warning(&self, message: String);
}

#[derive(Clone)]
pub struct SqlExecutionControl {
    cancel: watch::Receiver<bool>,
    observer: Arc<dyn SqlExecutionObserver>,
}

impl SqlExecutionControl {
    pub(crate) fn new(
        cancel: watch::Receiver<bool>,
        observer: Arc<dyn SqlExecutionObserver>,
    ) -> Self {
        Self { cancel, observer }
    }

    pub fn cancelled(&self) -> watch::Receiver<bool> {
        self.cancel.clone()
    }

    pub fn publish_summary(&self, summary: SqlExecutionSummary, progress_available: bool) {
        self.observer.publish_summary(summary, progress_available);
    }

    pub fn publish_warning(&self, message: String) {
        self.observer.publish_warning(message);
    }
}

struct NoopSqlExecutionEventSink;

impl SqlExecutionEventSink for NoopSqlExecutionEventSink {
    fn publish(&self, _event: SqlExecutionEvent) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct SqlExecutionStartInput {
    pub profile_id: String,
    pub tab_id: String,
    pub execution_id: String,
    pub query_id: String,
    pub statement_class: SqlStatementClass,
    pub started_at: u64,
}

#[derive(Debug)]
pub struct RegisteredSqlExecution {
    pub execution_id: String,
    pub query_id: String,
    pub tab_id: String,
    snapshot: SqlExecutionSnapshot,
    cancellation: watch::Receiver<bool>,
}

impl RegisteredSqlExecution {
    pub fn snapshot(&self) -> &SqlExecutionSnapshot {
        &self.snapshot
    }

    pub fn cancellation(&self) -> watch::Receiver<bool> {
        self.cancellation.clone()
    }
}

struct ActiveSqlExecution {
    profile_id: String,
    snapshot: SqlExecutionSnapshot,
    cancel: watch::Sender<bool>,
    sink: Arc<dyn SqlExecutionEventSink>,
}

#[derive(Clone)]
pub struct SqlExecutionCoordinator {
    entries: Arc<RwLock<HashMap<String, ActiveSqlExecution>>>,
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn coordinator_lock_error(context: &str) -> IpcError {
    IpcError::system_internal(
        format!("{context}: SQL execution coordinator lock poisoned"),
        "A previous operation panicked while holding the coordinator lock",
    )
}

fn execution_not_found(tab_id: &str, execution_id: &str) -> IpcError {
    IpcError::resource_not_found(format!(
        "SQL execution '{execution_id}' is not registered for tab '{tab_id}'"
    ))
}

fn is_terminal(state: SqlExecutionState) -> bool {
    matches!(
        state,
        SqlExecutionState::Succeeded
            | SqlExecutionState::Failed
            | SqlExecutionState::TimedOut
            | SqlExecutionState::Canceled
            | SqlExecutionState::CancelFailed
    )
}

fn normalize_warning(message: String) -> String {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return "SQL execution observation degraded".to_string();
    }
    trimmed
        .chars()
        .take(MAX_OBSERVATION_WARNING_CHARS)
        .collect()
}

fn is_valid_transition(from: SqlExecutionState, to: SqlExecutionState) -> bool {
    matches!(
        (from, to),
        (SqlExecutionState::Queued, SqlExecutionState::Starting)
            | (SqlExecutionState::Queued, SqlExecutionState::Canceling)
            | (SqlExecutionState::Starting, SqlExecutionState::Running)
            | (SqlExecutionState::Starting, SqlExecutionState::Canceling)
            | (SqlExecutionState::Starting, SqlExecutionState::Failed)
            | (SqlExecutionState::Starting, SqlExecutionState::TimedOut)
            | (SqlExecutionState::Starting, SqlExecutionState::Canceled)
            | (SqlExecutionState::Starting, SqlExecutionState::CancelFailed)
            | (SqlExecutionState::Running, SqlExecutionState::Canceling)
            | (SqlExecutionState::Running, SqlExecutionState::Succeeded)
            | (SqlExecutionState::Running, SqlExecutionState::Failed)
            | (SqlExecutionState::Running, SqlExecutionState::TimedOut)
            | (SqlExecutionState::Running, SqlExecutionState::Canceled)
            | (SqlExecutionState::Running, SqlExecutionState::CancelFailed)
            | (SqlExecutionState::Canceling, SqlExecutionState::Succeeded)
            | (SqlExecutionState::Canceling, SqlExecutionState::Failed)
            | (SqlExecutionState::Canceling, SqlExecutionState::TimedOut)
            | (SqlExecutionState::Canceling, SqlExecutionState::Canceled)
            | (
                SqlExecutionState::Canceling,
                SqlExecutionState::CancelFailed
            )
    )
}

impl SqlExecutionCoordinator {
    pub fn new() -> Self {
        Self {
            entries: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn register(&self, input: SqlExecutionStartInput) -> IpcResult<RegisteredSqlExecution> {
        self.register_with_sink(input, Arc::new(NoopSqlExecutionEventSink))
    }

    pub fn register_with_sink(
        &self,
        input: SqlExecutionStartInput,
        sink: Arc<dyn SqlExecutionEventSink>,
    ) -> IpcResult<RegisteredSqlExecution> {
        let mut entries = self
            .entries
            .write()
            .map_err(|_| coordinator_lock_error("register_sql_execution"))?;
        if let Some(existing) = entries.get(&input.tab_id) {
            if !is_terminal(existing.snapshot.state) {
                return Err(IpcError::resource_conflict(format!(
                    "Tab '{}' already has an active SQL execution",
                    input.tab_id
                )));
            }
        }

        let (cancel, cancellation) = watch::channel(false);
        let snapshot = SqlExecutionSnapshot {
            execution_id: input.execution_id.clone(),
            query_id: input.query_id.clone(),
            tab_id: input.tab_id.clone(),
            state: SqlExecutionState::Starting,
            revision: 1,
            statement_class: input.statement_class,
            started_at: input.started_at,
            finished_at: None,
            progress_available: false,
            summary: None,
            outcome: None,
            failure: None,
            cancel_message: None,
            observation_warnings: Vec::new(),
        };
        entries.insert(
            input.tab_id.clone(),
            ActiveSqlExecution {
                profile_id: input.profile_id,
                snapshot: snapshot.clone(),
                cancel,
                sink: sink.clone(),
            },
        );
        drop(entries);
        Self::publish_snapshot(&sink, &snapshot);

        Ok(RegisteredSqlExecution {
            execution_id: input.execution_id,
            query_id: input.query_id,
            tab_id: input.tab_id,
            snapshot,
            cancellation,
        })
    }

    pub fn snapshot(&self, tab_id: &str, execution_id: &str) -> IpcResult<SqlExecutionSnapshot> {
        let entries = self
            .entries
            .read()
            .map_err(|_| coordinator_lock_error("get_sql_execution_snapshot"))?;
        let entry = entries
            .get(tab_id)
            .filter(|entry| entry.snapshot.execution_id == execution_id)
            .ok_or_else(|| execution_not_found(tab_id, execution_id))?;
        Ok(entry.snapshot.clone())
    }

    pub fn snapshot_for_profile(
        &self,
        profile_id: &str,
        tab_id: &str,
        execution_id: &str,
    ) -> IpcResult<SqlExecutionSnapshot> {
        let entries = self
            .entries
            .read()
            .map_err(|_| coordinator_lock_error("get_owned_sql_execution_snapshot"))?;
        let entry = entries
            .get(tab_id)
            .filter(|entry| {
                entry.profile_id == profile_id && entry.snapshot.execution_id == execution_id
            })
            .ok_or_else(|| execution_not_found(tab_id, execution_id))?;
        Ok(entry.snapshot.clone())
    }

    pub fn transition(
        &self,
        tab_id: &str,
        execution_id: &str,
        state: SqlExecutionState,
    ) -> IpcResult<SqlExecutionSnapshot> {
        self.update_snapshot(
            tab_id,
            execution_id,
            "transition_sql_execution",
            |snapshot| {
                if !is_valid_transition(snapshot.state, state) {
                    return Err(IpcError::resource_conflict(format!(
                        "SQL execution cannot transition from {:?} to {:?}",
                        snapshot.state, state
                    )));
                }
                snapshot.state = state;
                if is_terminal(state) {
                    snapshot.finished_at = Some(now_unix_ms());
                }
                Ok(())
            },
        )
    }

    pub fn update_summary(
        &self,
        tab_id: &str,
        execution_id: &str,
        summary: SqlExecutionSummary,
        progress_available: bool,
    ) -> IpcResult<SqlExecutionSnapshot> {
        self.update_snapshot(
            tab_id,
            execution_id,
            "update_sql_execution_summary",
            |snapshot| {
                if is_terminal(snapshot.state) {
                    return Err(IpcError::resource_conflict(
                        "A terminal SQL execution cannot accept progress updates",
                    ));
                }
                snapshot.summary = Some(summary);
                snapshot.progress_available = progress_available;
                Ok(())
            },
        )
    }

    pub fn append_warning(
        &self,
        tab_id: &str,
        execution_id: &str,
        message: String,
    ) -> IpcResult<SqlExecutionSnapshot> {
        let message = normalize_warning(message);
        let (snapshot, sink, changed) = {
            let mut entries = self
                .entries
                .write()
                .map_err(|_| coordinator_lock_error("append_sql_execution_warning"))?;
            let entry = Self::entry_mut(&mut entries, tab_id, execution_id)?;
            if is_terminal(entry.snapshot.state) {
                return Err(IpcError::resource_conflict(
                    "A terminal SQL execution cannot accept observation warnings",
                ));
            }
            let changed = !entry
                .snapshot
                .observation_warnings
                .iter()
                .any(|item| item == &message)
                && entry.snapshot.observation_warnings.len() < MAX_OBSERVATION_WARNINGS;
            if changed {
                entry.snapshot.observation_warnings.push(message);
                entry.snapshot.revision =
                    entry.snapshot.revision.checked_add(1).ok_or_else(|| {
                        coordinator_lock_error("increment_sql_execution_revision")
                    })?;
            }
            (entry.snapshot.clone(), entry.sink.clone(), changed)
        };
        if changed {
            Self::publish_snapshot(&sink, &snapshot);
        }
        Ok(snapshot)
    }

    pub fn complete_success(
        &self,
        tab_id: &str,
        execution_id: &str,
        outcome: SqlExecutionOutcome,
    ) -> IpcResult<SqlExecutionSnapshot> {
        self.update_snapshot(tab_id, execution_id, "complete_sql_execution", |snapshot| {
            if !is_valid_transition(snapshot.state, SqlExecutionState::Succeeded) {
                return Err(IpcError::resource_conflict(
                    "SQL execution cannot complete successfully from its current state",
                ));
            }
            snapshot.state = SqlExecutionState::Succeeded;
            snapshot.finished_at = Some(now_unix_ms());
            snapshot.outcome = Some(outcome);
            snapshot.failure = None;
            Ok(())
        })
    }

    pub fn complete_failure(
        &self,
        tab_id: &str,
        execution_id: &str,
        state: SqlExecutionState,
        failure: SqlExecutionFailure,
    ) -> IpcResult<SqlExecutionSnapshot> {
        if !matches!(
            state,
            SqlExecutionState::Failed
                | SqlExecutionState::TimedOut
                | SqlExecutionState::CancelFailed
        ) {
            return Err(IpcError::validation_failed(
                "Failure completion requires failed, timedOut, or cancelFailed state",
            ));
        }
        self.update_snapshot(tab_id, execution_id, "fail_sql_execution", |snapshot| {
            if !is_valid_transition(snapshot.state, state) {
                return Err(IpcError::resource_conflict(
                    "SQL execution cannot fail from its current state",
                ));
            }
            snapshot.state = state;
            snapshot.finished_at = Some(now_unix_ms());
            snapshot.failure = Some(failure);
            snapshot.outcome = None;
            Ok(())
        })
    }

    pub fn begin_cancel(
        &self,
        tab_id: &str,
        execution_id: &str,
    ) -> IpcResult<SqlExecutionSnapshot> {
        let (snapshot, cancel) = {
            let mut entries = self
                .entries
                .write()
                .map_err(|_| coordinator_lock_error("begin_cancel_sql_execution"))?;
            let entry = Self::entry_mut(&mut entries, tab_id, execution_id)?;
            if entry.snapshot.state != SqlExecutionState::Canceling {
                if !is_valid_transition(entry.snapshot.state, SqlExecutionState::Canceling) {
                    return Err(IpcError::resource_conflict(
                        "SQL execution cannot be canceled from its current state",
                    ));
                }
                entry.snapshot.state = SqlExecutionState::Canceling;
                entry.snapshot.revision =
                    entry.snapshot.revision.checked_add(1).ok_or_else(|| {
                        coordinator_lock_error("increment_sql_execution_revision")
                    })?;
            }
            (
                (entry.snapshot.clone(), entry.sink.clone()),
                entry.cancel.clone(),
            )
        };
        cancel.send_replace(true);
        Self::publish_snapshot(&snapshot.1, &snapshot.0);
        Ok(snapshot.0)
    }

    pub fn complete_cancel(
        &self,
        tab_id: &str,
        execution_id: &str,
        message: String,
    ) -> IpcResult<SqlExecutionSnapshot> {
        self.update_snapshot(
            tab_id,
            execution_id,
            "complete_sql_execution_cancel",
            |snapshot| {
                if !is_valid_transition(snapshot.state, SqlExecutionState::Canceled) {
                    return Err(IpcError::resource_conflict(
                        "SQL execution cannot confirm cancellation from its current state",
                    ));
                }
                snapshot.state = SqlExecutionState::Canceled;
                snapshot.finished_at = Some(now_unix_ms());
                snapshot.cancel_message = Some(message);
                Ok(())
            },
        )
    }

    pub fn release(&self, tab_id: &str, execution_id: &str) -> IpcResult<()> {
        let mut entries = self
            .entries
            .write()
            .map_err(|_| coordinator_lock_error("release_sql_execution"))?;
        let entry = entries
            .get(tab_id)
            .filter(|entry| entry.snapshot.execution_id == execution_id)
            .ok_or_else(|| execution_not_found(tab_id, execution_id))?;
        if !is_terminal(entry.snapshot.state) {
            return Err(IpcError::resource_conflict(
                "An active SQL execution cannot be released",
            ));
        }
        entries.remove(tab_id);
        Ok(())
    }

    pub fn release_for_profile(
        &self,
        profile_id: &str,
        tab_id: &str,
        execution_id: &str,
    ) -> IpcResult<()> {
        self.snapshot_for_profile(profile_id, tab_id, execution_id)?;
        self.release(tab_id, execution_id)
    }

    pub fn discard_tab(&self, tab_id: &str) -> IpcResult<bool> {
        let removed = self
            .entries
            .write()
            .map_err(|_| coordinator_lock_error("discard_tab_sql_execution"))?
            .remove(tab_id);
        if let Some(entry) = removed {
            entry.cancel.send_replace(true);
            return Ok(true);
        }
        Ok(false)
    }

    pub fn discard_profile(&self, profile_id: &str) -> IpcResult<usize> {
        let mut entries = self
            .entries
            .write()
            .map_err(|_| coordinator_lock_error("discard_profile_sql_executions"))?;
        let tab_ids = entries
            .iter()
            .filter(|(_, entry)| entry.profile_id == profile_id)
            .map(|(tab_id, _)| tab_id.clone())
            .collect::<Vec<_>>();
        for tab_id in &tab_ids {
            if let Some(entry) = entries.remove(tab_id) {
                entry.cancel.send_replace(true);
            }
        }
        Ok(tab_ids.len())
    }

    pub fn discard_all(&self) -> IpcResult<usize> {
        let removed = {
            let mut entries = self
                .entries
                .write()
                .map_err(|_| coordinator_lock_error("discard_all_sql_executions"))?;
            entries.drain().map(|(_, entry)| entry).collect::<Vec<_>>()
        };
        let removed_count = removed.len();
        for entry in removed {
            entry.cancel.send_replace(true);
        }
        Ok(removed_count)
    }

    pub fn cancel_tab(&self, tab_id: &str) -> IpcResult<bool> {
        let execution_id = {
            let entries = self
                .entries
                .read()
                .map_err(|_| coordinator_lock_error("cancel_tab_sql_execution"))?;
            let Some(entry) = entries.get(tab_id) else {
                return Ok(false);
            };
            if is_terminal(entry.snapshot.state) {
                return Ok(false);
            }
            entry.snapshot.execution_id.clone()
        };
        self.begin_cancel(tab_id, &execution_id)?;
        Ok(true)
    }

    pub fn cancel_profile(&self, profile_id: &str) -> IpcResult<usize> {
        let executions = {
            let entries = self
                .entries
                .read()
                .map_err(|_| coordinator_lock_error("cancel_profile_sql_executions"))?;
            entries
                .iter()
                .filter(|(_, entry)| {
                    entry.profile_id == profile_id && !is_terminal(entry.snapshot.state)
                })
                .map(|(tab_id, entry)| (tab_id.clone(), entry.snapshot.execution_id.clone()))
                .collect::<Vec<_>>()
        };
        for (tab_id, execution_id) in &executions {
            self.begin_cancel(tab_id, execution_id)?;
        }
        Ok(executions.len())
    }

    #[cfg(test)]
    pub(crate) fn entry_count(&self) -> usize {
        self.entries
            .read()
            .expect("SQL execution entries lock")
            .len()
    }

    fn entry_mut<'a>(
        entries: &'a mut HashMap<String, ActiveSqlExecution>,
        tab_id: &str,
        execution_id: &str,
    ) -> IpcResult<&'a mut ActiveSqlExecution> {
        entries
            .get_mut(tab_id)
            .filter(|entry| entry.snapshot.execution_id == execution_id)
            .ok_or_else(|| execution_not_found(tab_id, execution_id))
    }

    fn update_snapshot(
        &self,
        tab_id: &str,
        execution_id: &str,
        context: &str,
        update: impl FnOnce(&mut SqlExecutionSnapshot) -> IpcResult<()>,
    ) -> IpcResult<SqlExecutionSnapshot> {
        let (snapshot, sink) = {
            let mut entries = self
                .entries
                .write()
                .map_err(|_| coordinator_lock_error(context))?;
            let entry = Self::entry_mut(&mut entries, tab_id, execution_id)?;
            update(&mut entry.snapshot)?;
            entry.snapshot.revision = entry
                .snapshot
                .revision
                .checked_add(1)
                .ok_or_else(|| coordinator_lock_error("increment_sql_execution_revision"))?;
            (entry.snapshot.clone(), entry.sink.clone())
        };
        Self::publish_snapshot(&sink, &snapshot);
        Ok(snapshot)
    }

    fn publish_snapshot(sink: &Arc<dyn SqlExecutionEventSink>, snapshot: &SqlExecutionSnapshot) {
        if let Err(error) = sink.publish(SqlExecutionEvent::Snapshot {
            snapshot: snapshot.clone(),
        }) {
            tauri_plugin_log::log::debug!(
                "SQL execution event delivery failed: tab_id={}, execution_id={}, error={}",
                snapshot.tab_id,
                snapshot.execution_id,
                error
            );
        }
    }
}

impl Default for SqlExecutionCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::engine::types::{
        QueryResult, SqlExecutionEvent, SqlExecutionOutcome, SqlExecutionState,
        SqlExecutionSummary, SqlStatementClass, SqlSummaryCompleteness, SqlSummarySource,
    };
    use crate::error::{ErrorCode, IpcError};

    struct FailingSink;

    #[derive(Default)]
    struct RecordingObserver {
        summaries: Mutex<Vec<(SqlExecutionSummary, bool)>>,
        warnings: Mutex<Vec<String>>,
    }

    impl SqlExecutionObserver for RecordingObserver {
        fn publish_summary(&self, summary: SqlExecutionSummary, progress_available: bool) {
            self.summaries
                .lock()
                .expect("summaries lock")
                .push((summary, progress_available));
        }

        fn publish_warning(&self, message: String) {
            self.warnings.lock().expect("warnings lock").push(message);
        }
    }

    impl SqlExecutionEventSink for FailingSink {
        fn publish(&self, _event: SqlExecutionEvent) -> Result<(), String> {
            Err("channel closed".to_string())
        }
    }

    fn start_input(profile_id: &str, tab_id: &str) -> SqlExecutionStartInput {
        SqlExecutionStartInput {
            profile_id: profile_id.to_string(),
            tab_id: tab_id.to_string(),
            execution_id: format!("execution-{profile_id}-{tab_id}"),
            query_id: format!("query-{profile_id}-{tab_id}"),
            statement_class: SqlStatementClass::Read,
            started_at: 1,
        }
    }

    fn rows_outcome() -> SqlExecutionOutcome {
        SqlExecutionOutcome::Rows {
            result: QueryResult {
                columns: Vec::new(),
                rows: Vec::new(),
                affected_rows: None,
                has_next_page: false,
                source_writable: false,
                source_insertable: false,
                primary_key_columns: Vec::new(),
                stable_order_columns: Vec::new(),
                row_locator_strategy: None,
            },
        }
    }

    #[test]
    fn observation_warnings_are_revisioned_deduplicated_and_bounded() {
        let coordinator = SqlExecutionCoordinator::new();
        let entry = coordinator
            .register(start_input("profile", "tab"))
            .expect("register first execution");

        let first = coordinator
            .append_warning("tab", &entry.execution_id, "progress unavailable".into())
            .expect("append first warning");
        assert_eq!(first.revision, 2);
        assert_eq!(
            first.observation_warnings,
            vec!["progress unavailable".to_string()]
        );

        let duplicate = coordinator
            .append_warning("tab", &entry.execution_id, "progress unavailable".into())
            .expect("ignore duplicate warning");
        assert_eq!(duplicate.revision, 2);

        for warning in ["two", "three", "four", "five"] {
            coordinator
                .append_warning("tab", &entry.execution_id, warning.into())
                .expect("append bounded warning");
        }
        let snapshot = coordinator
            .snapshot("tab", &entry.execution_id)
            .expect("read bounded warnings");
        assert_eq!(snapshot.observation_warnings.len(), 4);
        assert_eq!(snapshot.observation_warnings[0], "progress unavailable");
        assert!(!snapshot.observation_warnings.contains(&"five".to_string()));

        let second = coordinator
            .register(start_input("profile", "tab-2"))
            .expect("register second execution");
        coordinator
            .append_warning("tab-2", &second.execution_id, "界".repeat(300))
            .expect("append truncated warning");
        assert_eq!(
            coordinator
                .snapshot("tab-2", &second.execution_id)
                .expect("read truncated warning")
                .observation_warnings[0]
                .chars()
                .count(),
            256,
        );
    }

    #[test]
    fn terminal_execution_rejects_new_observation_warnings() {
        let coordinator = SqlExecutionCoordinator::new();
        let entry = coordinator
            .register(start_input("profile", "tab"))
            .expect("register execution");
        coordinator
            .transition("tab", &entry.execution_id, SqlExecutionState::Running)
            .expect("mark execution running");
        coordinator
            .complete_success("tab", &entry.execution_id, rows_outcome())
            .expect("complete execution");

        let error = coordinator
            .append_warning("tab", &entry.execution_id, "late warning".into())
            .expect_err("terminal execution must reject warnings");
        assert_eq!(error.code, ErrorCode::ResourceConflict);
    }

    #[test]
    fn coordinator_allows_one_active_execution_and_monotonic_terminal_snapshots() {
        let coordinator = SqlExecutionCoordinator::new();
        let first = coordinator
            .register(start_input("profile", "tab"))
            .expect("register first execution");
        assert_eq!(first.snapshot().state, SqlExecutionState::Starting);
        assert_eq!(
            coordinator
                .register(start_input("profile", "tab"))
                .expect_err("reject second active execution")
                .code,
            ErrorCode::ResourceConflict
        );

        coordinator
            .transition("tab", &first.execution_id, SqlExecutionState::Running)
            .expect("transition to running");
        let finished = coordinator
            .complete_success("tab", &first.execution_id, rows_outcome())
            .expect("complete execution");
        assert_eq!(finished.state, SqlExecutionState::Succeeded);
        assert!(coordinator
            .transition("tab", &first.execution_id, SqlExecutionState::Running,)
            .is_err());
        assert!(finished.revision >= 3);
    }

    #[test]
    fn event_delivery_failure_does_not_lose_authoritative_snapshot() {
        let coordinator = SqlExecutionCoordinator::new();
        let entry = coordinator
            .register_with_sink(start_input("p", "t"), Arc::new(FailingSink))
            .expect("register execution");

        coordinator
            .transition("t", &entry.execution_id, SqlExecutionState::Running)
            .expect("transition despite event failure");

        assert_eq!(
            coordinator
                .snapshot("t", &entry.execution_id)
                .expect("authoritative snapshot remains")
                .state,
            SqlExecutionState::Running
        );
    }

    #[test]
    fn summary_updates_are_revisioned_without_changing_execution_state() {
        let coordinator = SqlExecutionCoordinator::new();
        let entry = coordinator
            .register(start_input("p", "t"))
            .expect("register execution");
        let initial_revision = entry.snapshot().revision;
        let summary = SqlExecutionSummary {
            read_rows: Some(42),
            source: SqlSummarySource::LivePoll,
            completeness: SqlSummaryCompleteness::Partial,
            ..SqlExecutionSummary::default()
        };

        let updated = coordinator
            .update_summary("t", &entry.execution_id, summary, true)
            .expect("update summary");

        assert_eq!(updated.state, SqlExecutionState::Starting);
        assert_eq!(updated.revision, initial_revision + 1);
        assert_eq!(updated.summary.expect("summary").read_rows, Some(42));
        assert!(updated.progress_available);
    }

    #[test]
    fn profile_and_tab_cancellation_only_signal_matching_executions() {
        let coordinator = SqlExecutionCoordinator::new();
        let first = coordinator
            .register(start_input("p1", "t1"))
            .expect("register first execution");
        let second = coordinator
            .register(start_input("p2", "t2"))
            .expect("register second execution");
        let first_cancel = first.cancellation();
        let second_cancel = second.cancellation();

        assert_eq!(coordinator.cancel_profile("p1").expect("cancel profile"), 1);
        assert!(*first_cancel.borrow());
        assert!(!*second_cancel.borrow());
        assert_eq!(
            coordinator
                .snapshot("t1", &first.execution_id)
                .expect("first snapshot")
                .state,
            SqlExecutionState::Canceling
        );

        assert!(coordinator.cancel_tab("t2").expect("cancel tab"));
        assert!(*second_cancel.borrow());
    }

    #[test]
    fn discard_tab_signals_cancellation_and_removes_active_entry() {
        let coordinator = SqlExecutionCoordinator::new();
        let entry = coordinator
            .register(start_input("p", "t"))
            .expect("register execution");
        let cancellation = entry.cancellation();

        assert!(coordinator.discard_tab("t").expect("discard tab"));
        assert!(*cancellation.borrow());
        assert_eq!(
            coordinator
                .snapshot("t", &entry.execution_id)
                .expect_err("discarded execution is absent")
                .code,
            ErrorCode::ResourceNotFound,
        );
    }

    #[test]
    fn discard_profile_only_removes_owned_entries() {
        let coordinator = SqlExecutionCoordinator::new();
        let first = coordinator
            .register(start_input("p1", "t1"))
            .expect("register first execution");
        let second = coordinator
            .register(start_input("p2", "t2"))
            .expect("register second execution");

        assert_eq!(
            coordinator
                .discard_profile("p1")
                .expect("discard profile executions"),
            1
        );
        assert_eq!(
            coordinator
                .snapshot("t1", &first.execution_id)
                .expect_err("owned execution is absent")
                .code,
            ErrorCode::ResourceNotFound,
        );
        assert_eq!(
            coordinator
                .snapshot("t2", &second.execution_id)
                .expect("other profile execution remains")
                .state,
            SqlExecutionState::Starting,
        );
    }

    #[test]
    fn release_requires_a_terminal_execution_and_removes_it() {
        let coordinator = SqlExecutionCoordinator::new();
        let entry = coordinator
            .register(start_input("p", "t"))
            .expect("register execution");
        assert_eq!(
            coordinator
                .release("t", &entry.execution_id)
                .expect_err("active execution cannot be released")
                .code,
            ErrorCode::ResourceConflict
        );

        coordinator
            .complete_failure(
                "t",
                &entry.execution_id,
                SqlExecutionState::Failed,
                IpcError::validation_failed("query failed").into(),
            )
            .expect("complete failure");
        coordinator
            .release("t", &entry.execution_id)
            .expect("release terminal execution");
        assert_eq!(
            coordinator
                .snapshot("t", &entry.execution_id)
                .expect_err("released execution is absent")
                .code,
            ErrorCode::ResourceNotFound
        );
    }

    #[test]
    fn confirmed_cancellation_is_terminal_and_records_confirmation() {
        let coordinator = SqlExecutionCoordinator::new();
        let entry = coordinator
            .register(start_input("p", "t"))
            .expect("register execution");
        coordinator
            .begin_cancel("t", &entry.execution_id)
            .expect("begin cancellation");

        let canceled = coordinator
            .complete_cancel("t", &entry.execution_id, "服务端已确认取消".to_string())
            .expect("confirm cancellation");

        assert_eq!(canceled.state, SqlExecutionState::Canceled);
        assert_eq!(canceled.cancel_message.as_deref(), Some("服务端已确认取消"));
        assert!(canceled.finished_at.is_some());
        assert!(coordinator
            .transition("t", &entry.execution_id, SqlExecutionState::Running,)
            .is_err());
    }

    #[test]
    fn execution_control_forwards_cancellation_summary_and_warning_to_observer() {
        let (cancel, receiver) = watch::channel(false);
        let observer = Arc::new(RecordingObserver::default());
        let control = SqlExecutionControl::new(receiver, observer.clone());
        let summary = SqlExecutionSummary {
            read_rows: Some(7),
            ..SqlExecutionSummary::default()
        };

        control.publish_summary(summary, true);
        control.publish_warning("progress unavailable".to_string());
        cancel.send_replace(true);

        assert!(*control.cancelled().borrow());
        let summaries = observer.summaries.lock().expect("summaries lock");
        assert_eq!(summaries[0].0.read_rows, Some(7));
        assert!(summaries[0].1);
        assert_eq!(
            observer.warnings.lock().expect("warnings lock").as_slice(),
            ["progress unavailable"]
        );
    }
}
