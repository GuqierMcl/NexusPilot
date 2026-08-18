use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::engine::diagnostics;
use crate::engine::driver::{runtime_info, DatabaseDriver};
use crate::engine::native_schema::{
    NativeSchemaChangePlan, NativeSchemaChangeResult, NativeSchemaChangeTarget,
    NativeSchemaCreateResult, NativeSchemaCreateTarget, NativeSchemaDescribeRequest,
    NativeSchemaDocument, NativeSchemaExecuteChangeRequest, NativeSchemaExecuteCreateRequest,
    NativeSchemaMutationPreview, NativeSchemaSessionDocuments, NativeSchemaSessionListRequest,
    NativeSchemaSupportDocument, NativeSchemaSupportRequest,
};
use crate::engine::registry::DriverRegistry;
use crate::engine::sql_execution::artifact::{RawArtifactOwner, RawArtifactStore};
use crate::engine::sql_execution::{
    ManagedSqlCancelRequest, ManagedSqlExecutionRequest, SqlCancelConfirmation,
    SqlExecutionControl, SqlExecutionCoordinator, SqlExecutionEventSink, SqlExecutionObserver,
    SqlExecutionStartInput,
};
use crate::engine::types::{
    ConnectionRuntimeInfo, ConnectionRuntimeSnapshot, ContainerRef, CreateDatabaseInput,
    CreateDatabaseResult, CreateTableInput, CreateTableResult, DataContainer, DatabaseCharacterSet,
    DropDatabaseInput, DropDatabaseResult, DropTableInput, DropTableResult, PingResult,
    QueryResult, RedisCreateKeyValueRequest, RedisDeleteKeyPrefixRequest, RedisDeleteKeyRequest,
    RedisDeleteKeyResult, RedisKeyMutationResult, RedisKeyPrecondition, RedisKeyRef,
    RedisKeyTreeRequest, RedisKeyTreeResult, RedisKeyValue, RedisRenameKeyRequest,
    RedisScanRequest, RedisScanResult, RedisSetKeyTtlRequest, RedisSetKeyValueRequest,
    RuntimeHealthSnapshot, SchemaMutationOperation, SchemaMutationPreview, SqlExecutionContext,
    SqlExecutionHandle, SqlExecutionOutcome, SqlExecutionSnapshot, SqlExecutionState,
    SqlExecutionSummary, SqlResultMode, SqlStatementAccess, SqlStatementClass,
    StartSqlExecutionRequest, TableBrowseQuery, TableCellChange, TableChangeSetCommitResult,
    TableChangeSetPreview, TableChangeSetRequest, TableMutationResult, TablePageStats, TableRowKey,
    TableSchema, TableTransactionState, UpdateDatabaseInput, UpdateDatabaseResult,
    UpdateTableInput, UpdateTableResult,
};
use crate::error::{ErrorCode, IpcError, IpcResult};
use crate::repository::connection_repository::StoredConnectionRecord;
use tokio::sync::watch;

#[derive(Clone)]
struct TabRuntime {
    profile_id: String,
    driver: Arc<dyn DatabaseDriver>,
}

#[derive(Clone)]
struct ProfileRuntime {
    driver: Arc<dyn DatabaseDriver>,
    health: Arc<RwLock<RuntimeHealthSnapshot>>,
}

#[derive(Clone)]
struct RuntimeConnectAttempt {
    id: u64,
    profile_id: String,
    cancel: watch::Sender<bool>,
}

#[derive(Clone)]
pub struct ConnectionRuntimeManager {
    shared: Arc<RwLock<HashMap<String, ProfileRuntime>>>,
    tabs: Arc<RwLock<HashMap<String, TabRuntime>>>,
    shared_connect_attempts: Arc<RwLock<HashMap<String, RuntimeConnectAttempt>>>,
    tab_connect_attempts: Arc<RwLock<HashMap<String, RuntimeConnectAttempt>>>,
    next_connect_attempt_id: Arc<AtomicU64>,
    sql_executions: SqlExecutionCoordinator,
    raw_artifacts: RawArtifactStore,
}

#[derive(Debug)]
pub struct SharedManagedSqlExecution {
    pub execution_id: String,
    pub statement_class: SqlStatementClass,
    pub outcome: SqlExecutionOutcome,
    pub observation_warnings: Vec<String>,
}

#[derive(Default)]
struct SharedManagedSqlObserver {
    warnings: Mutex<Vec<String>>,
}

impl SharedManagedSqlObserver {
    fn warnings(&self) -> Vec<String> {
        self.warnings
            .lock()
            .map(|warnings| warnings.clone())
            .unwrap_or_else(|_| {
                vec!["Managed SQL observation warnings could not be read.".to_string()]
            })
    }
}

impl SqlExecutionObserver for SharedManagedSqlObserver {
    fn publish_summary(&self, _summary: SqlExecutionSummary, _progress_available: bool) {}

    fn publish_warning(&self, message: String) {
        let trimmed = message.trim();
        let message = if trimmed.is_empty() {
            "SQL execution observation degraded".to_string()
        } else {
            trimmed.chars().take(256).collect()
        };
        if let Ok(mut warnings) = self.warnings.lock() {
            if warnings.len() < 4 && !warnings.iter().any(|warning| warning == &message) {
                warnings.push(message);
            }
        }
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn lock_error(context: &str) -> IpcError {
    IpcError::system_internal(
        format!("{context}: internal lock poisoned"),
        "A previous operation panicked while holding a lock",
    )
}

struct CoordinatorSqlExecutionObserver {
    coordinator: SqlExecutionCoordinator,
    tab_id: String,
    execution_id: String,
}

impl SqlExecutionObserver for CoordinatorSqlExecutionObserver {
    fn publish_summary(&self, summary: SqlExecutionSummary, progress_available: bool) {
        if let Err(error) = self.coordinator.update_summary(
            &self.tab_id,
            &self.execution_id,
            summary,
            progress_available,
        ) {
            tauri_plugin_log::log::debug!(
                "SQL execution summary update ignored: tab_id={}, execution_id={}, code={:?}",
                self.tab_id,
                self.execution_id,
                error.code
            );
        }
    }

    fn publish_warning(&self, message: String) {
        let safe_message = message.trim().chars().take(256).collect::<String>();
        match self
            .coordinator
            .append_warning(&self.tab_id, &self.execution_id, message)
        {
            Ok(_) => tauri_plugin_log::log::debug!(
                "SQL execution warning: tab_id={}, execution_id={}, message={}",
                self.tab_id,
                self.execution_id,
                safe_message
            ),
            Err(error) => tauri_plugin_log::log::debug!(
                "SQL execution warning ignored: tab_id={}, execution_id={}, code={:?}",
                self.tab_id,
                self.execution_id,
                error.code
            ),
        }
    }
}

#[derive(Clone, Copy)]
enum SqlScanState {
    Normal,
    SingleQuoted,
    DoubleQuoted,
    BacktickQuoted,
    LineComment,
    BlockComment,
}

fn sql_statement_count(sql: &str) -> usize {
    let chars = sql.chars().collect::<Vec<_>>();
    let mut index = 0;
    let mut state = SqlScanState::Normal;
    let mut statement_has_token = false;
    let mut statements = 0;
    while index < chars.len() {
        let current = chars[index];
        let next = chars.get(index + 1).copied();
        match state {
            SqlScanState::Normal => match (current, next) {
                ('-', Some('-')) => {
                    state = SqlScanState::LineComment;
                    index += 1;
                }
                ('/', Some('*')) => {
                    state = SqlScanState::BlockComment;
                    index += 1;
                }
                ('\'', _) => {
                    statement_has_token = true;
                    state = SqlScanState::SingleQuoted;
                }
                ('"', _) => {
                    statement_has_token = true;
                    state = SqlScanState::DoubleQuoted;
                }
                ('`', _) => {
                    statement_has_token = true;
                    state = SqlScanState::BacktickQuoted;
                }
                (';', _) => {
                    if statement_has_token {
                        statements += 1;
                        statement_has_token = false;
                    }
                }
                _ if !current.is_whitespace() => statement_has_token = true,
                _ => {}
            },
            SqlScanState::SingleQuoted => {
                if current == '\\' {
                    index += usize::from(next.is_some());
                } else if current == '\'' {
                    if next == Some('\'') {
                        index += 1;
                    } else {
                        state = SqlScanState::Normal;
                    }
                }
            }
            SqlScanState::DoubleQuoted => {
                if current == '\\' {
                    index += usize::from(next.is_some());
                } else if current == '"' {
                    if next == Some('"') {
                        index += 1;
                    } else {
                        state = SqlScanState::Normal;
                    }
                }
            }
            SqlScanState::BacktickQuoted => {
                if current == '`' {
                    if next == Some('`') {
                        index += 1;
                    } else {
                        state = SqlScanState::Normal;
                    }
                }
            }
            SqlScanState::LineComment => {
                if current == '\n' || current == '\r' {
                    state = SqlScanState::Normal;
                }
            }
            SqlScanState::BlockComment => {
                if current == '*' && next == Some('/') {
                    state = SqlScanState::Normal;
                    index += 1;
                }
            }
        }
        index += 1;
    }
    statements + usize::from(statement_has_token)
}

fn validate_start_sql_execution(request: &StartSqlExecutionRequest) -> IpcResult<()> {
    match sql_statement_count(&request.sql) {
        0 => return Err(IpcError::validation_failed("SQL must not be empty")),
        1 => {}
        _ => {
            return Err(IpcError::validation_failed(
                "Managed SQL execution accepts exactly one statement",
            ));
        }
    }
    if !matches!(
        request.options.timeout_ms,
        None | Some(30_000 | 60_000 | 300_000 | 900_000 | 3_600_000)
    ) {
        return Err(IpcError::validation_failed(
            "SQL execution timeout is not an allowed value",
        ));
    }
    if request.options.page == 0 {
        return Err(IpcError::validation_failed(
            "SQL result page must be at least 1",
        ));
    }
    if request.options.result_mode == SqlResultMode::Raw && request.options.page != 1 {
        return Err(IpcError::validation_failed(
            "Raw SQL results only support page 1",
        ));
    }
    if !(1..=1_000).contains(&request.options.page_size) {
        return Err(IpcError::validation_failed(
            "SQL result page size must be between 1 and 1000",
        ));
    }
    let skip = u64::from(request.options.page - 1)
        .checked_mul(u64::from(request.options.page_size))
        .ok_or_else(|| IpcError::validation_failed("SQL result page offset is too large"))?;
    if skip > 100_000 {
        return Err(IpcError::validation_failed(
            "SQL result page offset exceeds 100000 rows",
        ));
    }
    Ok(())
}

fn is_terminal_sql_execution_state(state: SqlExecutionState) -> bool {
    matches!(
        state,
        SqlExecutionState::Succeeded
            | SqlExecutionState::Failed
            | SqlExecutionState::TimedOut
            | SqlExecutionState::Canceled
            | SqlExecutionState::CancelFailed
    )
}

impl ConnectionRuntimeManager {
    pub fn new() -> Self {
        Self::with_raw_artifact_store(RawArtifactStore::production())
    }

    fn with_raw_artifact_store(raw_artifacts: RawArtifactStore) -> Self {
        Self {
            shared: Arc::new(RwLock::new(HashMap::new())),
            tabs: Arc::new(RwLock::new(HashMap::new())),
            shared_connect_attempts: Arc::new(RwLock::new(HashMap::new())),
            tab_connect_attempts: Arc::new(RwLock::new(HashMap::new())),
            next_connect_attempt_id: Arc::new(AtomicU64::new(1)),
            sql_executions: SqlExecutionCoordinator::new(),
            raw_artifacts,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_raw_artifact_store_for_test(raw_artifacts: RawArtifactStore) -> Self {
        Self::with_raw_artifact_store(raw_artifacts)
    }

    fn next_connect_attempt_id(&self) -> u64 {
        self.next_connect_attempt_id.fetch_add(1, Ordering::Relaxed)
    }

    fn begin_shared_connect_attempt(
        &self,
        profile_id: &str,
    ) -> IpcResult<(u64, watch::Receiver<bool>)> {
        let id = self.next_connect_attempt_id();
        let (cancel, receiver) = watch::channel(false);
        let attempt = RuntimeConnectAttempt {
            id,
            profile_id: profile_id.to_string(),
            cancel,
        };
        let replaced = self
            .shared_connect_attempts
            .write()
            .map_err(|_| lock_error("begin_shared_connect_attempt"))?
            .insert(profile_id.to_string(), attempt);
        if let Some(replaced) = replaced {
            replaced.cancel.send_replace(true);
        }
        Ok((id, receiver))
    }

    #[cfg(test)]
    fn shared_connect_attempt_is_current(
        &self,
        profile_id: &str,
        attempt_id: u64,
    ) -> IpcResult<bool> {
        self.shared_connect_attempts
            .read()
            .map_err(|_| lock_error("shared_connect_attempt_is_current"))
            .map(|attempts| attempts.get(profile_id).map(|attempt| attempt.id) == Some(attempt_id))
    }

    fn clear_shared_connect_attempt_if_current(
        &self,
        profile_id: &str,
        attempt_id: u64,
    ) -> IpcResult<bool> {
        let mut attempts = self
            .shared_connect_attempts
            .write()
            .map_err(|_| lock_error("clear_shared_connect_attempt"))?;
        if attempts.get(profile_id).map(|attempt| attempt.id) != Some(attempt_id) {
            return Ok(false);
        }
        attempts.remove(profile_id);
        Ok(true)
    }

    fn cancel_shared_connect_attempt(&self, profile_id: &str) -> IpcResult<bool> {
        let removed = self
            .shared_connect_attempts
            .write()
            .map_err(|_| lock_error("cancel_shared_connect_attempt"))?
            .remove(profile_id);
        if let Some(attempt) = removed {
            attempt.cancel.send_replace(true);
            return Ok(true);
        }
        Ok(false)
    }

    fn begin_tab_connect_attempt(
        &self,
        profile_id: &str,
        tab_id: &str,
    ) -> IpcResult<(u64, watch::Receiver<bool>)> {
        let id = self.next_connect_attempt_id();
        let (cancel, receiver) = watch::channel(false);
        let attempt = RuntimeConnectAttempt {
            id,
            profile_id: profile_id.to_string(),
            cancel,
        };
        let replaced = self
            .tab_connect_attempts
            .write()
            .map_err(|_| lock_error("begin_tab_connect_attempt"))?
            .insert(tab_id.to_string(), attempt);
        if let Some(replaced) = replaced {
            replaced.cancel.send_replace(true);
        }
        Ok((id, receiver))
    }

    fn clear_tab_connect_attempt_if_current(
        &self,
        tab_id: &str,
        attempt_id: u64,
    ) -> IpcResult<bool> {
        let mut attempts = self
            .tab_connect_attempts
            .write()
            .map_err(|_| lock_error("clear_tab_connect_attempt"))?;
        if attempts.get(tab_id).map(|attempt| attempt.id) != Some(attempt_id) {
            return Ok(false);
        }
        attempts.remove(tab_id);
        Ok(true)
    }

    fn cancel_tab_connect_attempt(&self, tab_id: &str) -> IpcResult<bool> {
        let removed = self
            .tab_connect_attempts
            .write()
            .map_err(|_| lock_error("cancel_tab_connect_attempt"))?
            .remove(tab_id);
        if let Some(attempt) = removed {
            attempt.cancel.send_replace(true);
            return Ok(true);
        }
        Ok(false)
    }

    fn cancel_tab_connect_attempts_for_profile(&self, profile_id: &str) -> IpcResult<usize> {
        let mut attempts = self
            .tab_connect_attempts
            .write()
            .map_err(|_| lock_error("cancel_tab_connect_attempts_for_profile"))?;
        let tab_ids = attempts
            .iter()
            .filter(|(_, attempt)| attempt.profile_id == profile_id)
            .map(|(tab_id, _)| tab_id.clone())
            .collect::<Vec<_>>();
        for tab_id in &tab_ids {
            if let Some(attempt) = attempts.remove(tab_id) {
                attempt.cancel.send_replace(true);
            }
        }
        Ok(tab_ids.len())
    }

    pub async fn connect_profile(
        &self,
        profile_id: &str,
        profile: &StoredConnectionRecord,
    ) -> IpcResult<ConnectionRuntimeInfo> {
        let (attempt_id, mut cancellation) = self.begin_shared_connect_attempt(profile_id)?;
        let driver_result = tokio::select! {
            result = DriverRegistry::create_driver(profile_id, profile) => result,
            _ = cancellation.changed() => {
                self.clear_shared_connect_attempt_if_current(profile_id, attempt_id)?;
                return Err(IpcError::operation_canceled(
                    "Connection attempt canceled",
                    format!("Profile '{profile_id}' was disconnected before runtime registration"),
                ));
            }
        };
        let driver = match driver_result {
            Ok(driver) => driver,
            Err(error) => {
                self.clear_shared_connect_attempt_if_current(profile_id, attempt_id)?;
                diagnostics::log_engine_error_by_driver(
                    "connect_profile",
                    profile.driver.as_str(),
                    profile_id,
                    None,
                    None,
                    &error,
                );
                return Err(error);
            }
        };
        let info = runtime_info(driver.as_ref());
        let runtime = ProfileRuntime {
            driver,
            health: Arc::new(RwLock::new(RuntimeHealthSnapshot::healthy(
                profile_id,
                now_unix_ms(),
            ))),
        };
        let mut pending = Some(runtime);
        let replaced = {
            let mut attempts = self
                .shared_connect_attempts
                .write()
                .map_err(|_| lock_error("connect_profile.attempt"))?;
            if attempts.get(profile_id).map(|attempt| attempt.id) != Some(attempt_id) {
                None
            } else {
                let mut shared = self
                    .shared
                    .write()
                    .map_err(|_| lock_error("connect_profile"))?;
                attempts.remove(profile_id);
                Some(shared.insert(
                    profile_id.to_string(),
                    pending.take().expect("pending runtime"),
                ))
            }
        };
        if let Some(stale) = pending {
            let _ = stale.driver.close().await;
            return Err(IpcError::operation_canceled(
                "Connection attempt canceled",
                format!("Profile '{profile_id}' changed before runtime registration"),
            ));
        }
        if let Some(Some(previous)) = replaced {
            previous.driver.close().await?;
        }
        Ok(info)
    }

    pub async fn disconnect_profile(&self, profile_id: &str) -> IpcResult<()> {
        let canceled_shared = self.cancel_shared_connect_attempt(profile_id)?;
        let canceled_tabs = self.cancel_tab_connect_attempts_for_profile(profile_id)?;
        self.sql_executions.discard_profile(profile_id)?;
        self.raw_artifacts.release_profile(profile_id)?;
        let shared = self
            .shared
            .write()
            .map_err(|_| lock_error("disconnect_profile"))?
            .remove(profile_id);
        let tab_drivers = {
            let mut tabs = self
                .tabs
                .write()
                .map_err(|_| lock_error("disconnect_profile"))?;
            let tab_ids: Vec<String> = tabs
                .iter()
                .filter(|(_, runtime)| runtime.profile_id == profile_id)
                .map(|(tab_id, _)| tab_id.clone())
                .collect();
            tab_ids
                .into_iter()
                .filter_map(|tab_id| tabs.remove(&tab_id).map(|runtime| (tab_id, runtime.driver)))
                .collect::<Vec<_>>()
        };

        if shared.is_none() && tab_drivers.is_empty() && !canceled_shared && canceled_tabs == 0 {
            return Err(IpcError::resource_not_found(format!(
                "No active runtime for profile '{profile_id}'"
            )));
        }

        if let Some(runtime) = shared {
            let result = runtime.driver.close().await;
            Self::log_result(
                "disconnect_profile",
                profile_id,
                None,
                runtime.driver.as_ref(),
                None,
                result,
            )?;
        }
        for (tab_id, driver) in tab_drivers {
            let result = driver.close().await;
            Self::log_result(
                "disconnect_profile",
                profile_id,
                Some(&tab_id),
                driver.as_ref(),
                None,
                result,
            )?;
        }
        Ok(())
    }

    pub async fn open_tab_runtime(
        &self,
        profile_id: &str,
        tab_id: &str,
        profile: &StoredConnectionRecord,
    ) -> IpcResult<ConnectionRuntimeInfo> {
        let (attempt_id, mut cancellation) = self.begin_tab_connect_attempt(profile_id, tab_id)?;
        let driver_result = tokio::select! {
            result = DriverRegistry::create_tab_driver(profile_id, tab_id, profile) => result,
            _ = cancellation.changed() => {
                self.clear_tab_connect_attempt_if_current(tab_id, attempt_id)?;
                return Err(IpcError::operation_canceled(
                    "Tab runtime connection canceled",
                    format!("Tab '{tab_id}' was closed before runtime registration"),
                ));
            }
        };
        let driver = match driver_result {
            Ok(driver) => driver,
            Err(error) => {
                self.clear_tab_connect_attempt_if_current(tab_id, attempt_id)?;
                diagnostics::log_engine_error_by_driver(
                    "open_tab_runtime",
                    profile.driver.as_str(),
                    profile_id,
                    Some(tab_id),
                    None,
                    &error,
                );
                return Err(error);
            }
        };
        let info = runtime_info(driver.as_ref());
        let mut pending = Some(TabRuntime {
            profile_id: profile_id.to_string(),
            driver,
        });
        let replaced = {
            let mut attempts = self
                .tab_connect_attempts
                .write()
                .map_err(|_| lock_error("open_tab_runtime.attempt"))?;
            if attempts.get(tab_id).map(|attempt| attempt.id) != Some(attempt_id) {
                None
            } else {
                let mut tabs = self
                    .tabs
                    .write()
                    .map_err(|_| lock_error("open_tab_runtime"))?;
                attempts.remove(tab_id);
                Some(tabs.insert(
                    tab_id.to_string(),
                    pending.take().expect("pending tab runtime"),
                ))
            }
        };
        if let Some(stale) = pending {
            let _ = stale.driver.close().await;
            return Err(IpcError::operation_canceled(
                "Tab runtime connection canceled",
                format!("Tab '{tab_id}' changed before runtime registration"),
            ));
        }
        if let Some(Some(previous)) = replaced {
            previous.driver.close().await?;
        }
        Ok(info)
    }

    pub async fn close_tab_runtime(&self, tab_id: &str) -> IpcResult<()> {
        self.cancel_tab_connect_attempt(tab_id)?;
        self.sql_executions.discard_tab(tab_id)?;
        self.raw_artifacts.release_tab(tab_id)?;
        let removed = self
            .tabs
            .write()
            .map_err(|_| lock_error("close_tab_runtime"))?
            .remove(tab_id);
        if let Some(runtime) = removed {
            let result = runtime.driver.close().await;
            Self::log_result(
                "close_tab_runtime",
                &runtime.profile_id,
                Some(tab_id),
                runtime.driver.as_ref(),
                None,
                result,
            )?;
        }
        Ok(())
    }

    pub fn capabilities(&self, profile_id: &str) -> IpcResult<ConnectionRuntimeInfo> {
        let driver = self.shared_driver(profile_id)?;
        Ok(runtime_info(driver.as_ref()))
    }

    pub fn health(&self, profile_id: &str) -> IpcResult<RuntimeHealthSnapshot> {
        let runtime = self.shared_runtime(profile_id)?;
        runtime
            .health
            .read()
            .map_err(|_| lock_error("health"))
            .map(|health| health.clone())
    }

    pub fn runtime_snapshot(&self, profile_id: &str) -> IpcResult<ConnectionRuntimeSnapshot> {
        let runtime = self
            .shared
            .read()
            .map_err(|_| lock_error("runtime_snapshot"))?
            .get(profile_id)
            .cloned()
            .ok_or_else(|| {
                IpcError::resource_not_found(format!(
                    "No active runtime for profile '{profile_id}'"
                ))
            })?;
        let health = runtime
            .health
            .read()
            .map_err(|_| lock_error("runtime_snapshot"))?
            .clone();
        Ok(ConnectionRuntimeSnapshot {
            profile_id: profile_id.to_string(),
            runtime: runtime_info(runtime.driver.as_ref()),
            health,
        })
    }

    pub fn runtime_snapshots(&self) -> IpcResult<Vec<ConnectionRuntimeSnapshot>> {
        let runtimes = self
            .shared
            .read()
            .map_err(|_| lock_error("runtime_snapshots"))?
            .iter()
            .map(|(profile_id, runtime)| (profile_id.clone(), runtime.clone()))
            .collect::<Vec<_>>();
        let mut snapshots = runtimes
            .into_iter()
            .map(|(profile_id, runtime)| {
                let health = runtime
                    .health
                    .read()
                    .map_err(|_| lock_error("runtime_snapshots"))?
                    .clone();
                Ok(ConnectionRuntimeSnapshot {
                    profile_id,
                    runtime: runtime_info(runtime.driver.as_ref()),
                    health,
                })
            })
            .collect::<IpcResult<Vec<_>>>()?;
        snapshots.sort_by(|left, right| left.profile_id.cmp(&right.profile_id));
        Ok(snapshots)
    }

    pub async fn ping(&self, profile_id: &str) -> IpcResult<PingResult> {
        let runtime = self.shared_runtime(profile_id)?;
        let result = runtime.driver.ping().await;
        {
            let mut health = runtime
                .health
                .write()
                .map_err(|_| lock_error("ping.health"))?;
            match &result {
                Ok(_) => health.record_success(now_unix_ms()),
                Err(error) => health.record_failure(error, now_unix_ms()),
            }
        }
        Self::log_result(
            "ping",
            profile_id,
            None,
            runtime.driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn list_containers(
        &self,
        profile_id: &str,
        parent: Option<ContainerRef>,
    ) -> IpcResult<Vec<DataContainer>> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_schema_browser() {
            Some(browser) => browser.list_containers(parent.as_ref()).await,
            None => Err(IpcError::feature_unavailable(
                "This connection does not support schema browsing",
            )),
        };
        Self::log_result_with_container(
            "list_containers",
            profile_id,
            None,
            driver.as_ref(),
            parent.as_ref(),
            result,
        )
    }

    pub async fn describe_table(
        &self,
        profile_id: &str,
        container: &ContainerRef,
    ) -> IpcResult<TableSchema> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_schema_browser() {
            Some(browser) => browser.describe_table(container).await,
            None => Err(IpcError::feature_unavailable(
                "This connection does not support schema browsing",
            )),
        };
        Self::log_result_with_container(
            "describe_table",
            profile_id,
            None,
            driver.as_ref(),
            Some(container),
            result,
        )
    }

    pub async fn describe_native_schema(
        &self,
        profile_id: &str,
        request: NativeSchemaDescribeRequest,
    ) -> IpcResult<NativeSchemaDocument> {
        self.describe_native_schema_in_runtime(profile_id, None, request)
            .await
    }

    #[allow(dead_code)]
    pub async fn get_native_schema_support(
        &self,
        profile_id: &str,
        request: NativeSchemaSupportRequest,
    ) -> IpcResult<NativeSchemaSupportDocument> {
        self.get_native_schema_support_in_runtime(profile_id, None, request)
            .await
    }

    #[allow(dead_code)]
    pub async fn get_native_schema_support_in_runtime(
        &self,
        profile_id: &str,
        owner_tab_runtime_id: Option<&str>,
        request: NativeSchemaSupportRequest,
    ) -> IpcResult<NativeSchemaSupportDocument> {
        let driver = self.native_schema_driver(profile_id, owner_tab_runtime_id)?;
        let result = match driver.as_native_schema_extension() {
            Some(extension) => extension.support(&request).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support native schema capability discovery",
            )),
        };
        Self::log_result(
            "get_native_schema_support",
            profile_id,
            owner_tab_runtime_id,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn describe_native_schema_in_runtime(
        &self,
        profile_id: &str,
        owner_tab_runtime_id: Option<&str>,
        request: NativeSchemaDescribeRequest,
    ) -> IpcResult<NativeSchemaDocument> {
        let driver = self.native_schema_driver(profile_id, owner_tab_runtime_id)?;
        let result = match driver.as_native_schema_extension() {
            Some(extension) => extension.describe(&request).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support native schema description",
            )),
        };
        Self::log_result_with_container(
            "describe_native_schema",
            profile_id,
            owner_tab_runtime_id,
            driver.as_ref(),
            Some(request.container()),
            result,
        )
    }

    #[allow(dead_code)]
    pub async fn list_native_schema_session_documents(
        &self,
        profile_id: &str,
        owner_tab_runtime_id: &str,
        request: NativeSchemaSessionListRequest,
    ) -> IpcResult<NativeSchemaSessionDocuments> {
        let driver = self.native_schema_driver(profile_id, Some(owner_tab_runtime_id))?;
        let result = match driver.as_native_schema_extension() {
            Some(extension) => extension.list_session_documents(&request).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support tab-scoped schema documents",
            )),
        };
        Self::log_result(
            "list_native_schema_session_documents",
            profile_id,
            Some(owner_tab_runtime_id),
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn preview_native_schema_create(
        &self,
        profile_id: &str,
        target: NativeSchemaCreateTarget,
    ) -> IpcResult<NativeSchemaMutationPreview> {
        self.preview_native_schema_create_in_runtime(profile_id, None, target)
            .await
    }

    pub async fn preview_native_schema_create_in_runtime(
        &self,
        profile_id: &str,
        owner_tab_runtime_id: Option<&str>,
        target: NativeSchemaCreateTarget,
    ) -> IpcResult<NativeSchemaMutationPreview> {
        let driver = self.native_schema_driver(profile_id, owner_tab_runtime_id)?;
        let supported = driver
            .capabilities()
            .schema_mutation
            .as_ref()
            .is_some_and(|features| {
                features.supports(target.object_kind(), SchemaMutationOperation::Create)
            });
        let result = if !supported {
            Err(IpcError::resource_not_found(
                "This connection does not support the requested native schema create operation",
            ))
        } else {
            match driver.as_native_schema_extension() {
                Some(extension) => extension.preview_create(&target).await,
                None => Err(IpcError::resource_not_found(
                    "This connection does not support native schema creation",
                )),
            }
        };
        Self::log_result(
            "preview_native_schema_create",
            profile_id,
            owner_tab_runtime_id,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn execute_native_schema_create(
        &self,
        profile_id: &str,
        request: NativeSchemaExecuteCreateRequest,
    ) -> IpcResult<NativeSchemaCreateResult> {
        self.execute_native_schema_create_in_runtime(profile_id, None, request)
            .await
    }

    pub async fn execute_native_schema_create_in_runtime(
        &self,
        profile_id: &str,
        owner_tab_runtime_id: Option<&str>,
        request: NativeSchemaExecuteCreateRequest,
    ) -> IpcResult<NativeSchemaCreateResult> {
        let driver = self.native_schema_driver(profile_id, owner_tab_runtime_id)?;
        let supported = driver
            .capabilities()
            .schema_mutation
            .as_ref()
            .is_some_and(|features| {
                features.supports(
                    request.target.object_kind(),
                    SchemaMutationOperation::Create,
                )
            });
        let result = if !supported {
            Err(IpcError::resource_not_found(
                "This connection does not support the requested native schema create operation",
            ))
        } else {
            match driver.as_native_schema_extension() {
                Some(extension) => extension.execute_create(&request).await,
                None => Err(IpcError::resource_not_found(
                    "This connection does not support native schema creation",
                )),
            }
        };
        Self::log_result(
            "execute_native_schema_create",
            profile_id,
            owner_tab_runtime_id,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn preview_native_schema_change(
        &self,
        profile_id: &str,
        target: NativeSchemaChangeTarget,
    ) -> IpcResult<NativeSchemaChangePlan> {
        self.preview_native_schema_change_in_runtime(profile_id, None, target)
            .await
    }

    pub async fn preview_native_schema_change_in_runtime(
        &self,
        profile_id: &str,
        owner_tab_runtime_id: Option<&str>,
        target: NativeSchemaChangeTarget,
    ) -> IpcResult<NativeSchemaChangePlan> {
        let driver = self.native_schema_driver(profile_id, owner_tab_runtime_id)?;
        let capabilities = driver.capabilities();
        let result = match capabilities.schema_mutation.as_ref() {
            Some(features)
                if features.supports(target.object_kind(), target.operation())
                    && (!target.requires_remote_drift_protection()
                        || features.remote_drift_protection) =>
            {
                match driver.as_native_schema_extension() {
                    Some(extension) => match extension.preview_change(&target).await {
                        Ok(plan) if plan.destructive && !features.destructive_confirmation => {
                            Err(IpcError::resource_not_found(
                                "This connection does not advertise destructive confirmation for the requested native schema change",
                            ))
                        }
                        result => result,
                    },
                    None => Err(IpcError::resource_not_found(
                        "This connection does not support native schema changes",
                    )),
                }
            }
            _ => Err(IpcError::resource_not_found(
                "This connection does not support the requested native schema change operation and protections",
            )),
        };
        Self::log_result(
            "preview_native_schema_change",
            profile_id,
            owner_tab_runtime_id,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn execute_native_schema_change(
        &self,
        profile_id: &str,
        request: NativeSchemaExecuteChangeRequest,
    ) -> IpcResult<NativeSchemaChangeResult> {
        self.execute_native_schema_change_in_runtime(profile_id, None, request)
            .await
    }

    pub async fn execute_native_schema_change_in_runtime(
        &self,
        profile_id: &str,
        owner_tab_runtime_id: Option<&str>,
        request: NativeSchemaExecuteChangeRequest,
    ) -> IpcResult<NativeSchemaChangeResult> {
        let driver = self.native_schema_driver(profile_id, owner_tab_runtime_id)?;
        let capabilities = driver.capabilities();
        let target = &request.target;
        let result = match capabilities.schema_mutation.as_ref() {
            Some(features)
                if features.supports(target.object_kind(), target.operation())
                    && (!target.requires_remote_drift_protection()
                        || features.remote_drift_protection) =>
            {
                match driver.as_native_schema_extension() {
                    Some(extension) => match extension.preview_change(target).await {
                        Ok(plan) if plan.destructive && !features.destructive_confirmation => {
                            Err(IpcError::resource_not_found(
                                "This connection does not advertise destructive confirmation for the requested native schema change",
                            ))
                        }
                        Ok(_) => extension.execute_change(&request).await,
                        Err(error) => Err(error),
                    },
                    None => Err(IpcError::resource_not_found(
                        "This connection does not support native schema changes",
                    )),
                }
            }
            _ => Err(IpcError::resource_not_found(
                "This connection does not support the requested native schema change operation and protections",
            )),
        };
        Self::log_result(
            "execute_native_schema_change",
            profile_id,
            owner_tab_runtime_id,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn create_database(
        &self,
        profile_id: &str,
        input: &CreateDatabaseInput,
    ) -> IpcResult<CreateDatabaseResult> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_schema_mutator() {
            Some(mutator) => mutator.create_database(input).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support schema mutation",
            )),
        };
        Self::log_result(
            "create_database",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn preview_create_database(
        &self,
        profile_id: &str,
        input: &CreateDatabaseInput,
    ) -> IpcResult<SchemaMutationPreview> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_schema_mutator() {
            Some(mutator) => mutator.preview_create_database(input).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support schema mutation",
            )),
        };
        Self::log_result(
            "preview_create_database",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn preview_update_database(
        &self,
        profile_id: &str,
        input: &UpdateDatabaseInput,
    ) -> IpcResult<SchemaMutationPreview> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_schema_mutator() {
            Some(mutator) => mutator.preview_update_database(input).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support schema mutation",
            )),
        };
        Self::log_result(
            "preview_update_database",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn update_database(
        &self,
        profile_id: &str,
        input: &UpdateDatabaseInput,
    ) -> IpcResult<UpdateDatabaseResult> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_schema_mutator() {
            Some(mutator) => mutator.update_database(input).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support schema mutation",
            )),
        };
        Self::log_result(
            "update_database",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn preview_drop_database(
        &self,
        profile_id: &str,
        input: &DropDatabaseInput,
    ) -> IpcResult<SchemaMutationPreview> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_schema_mutator() {
            Some(mutator) => mutator.preview_drop_database(input).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support schema mutation",
            )),
        };
        Self::log_result(
            "preview_drop_database",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn drop_database(
        &self,
        profile_id: &str,
        input: &DropDatabaseInput,
    ) -> IpcResult<DropDatabaseResult> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_schema_mutator() {
            Some(mutator) => mutator.drop_database(input).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support schema mutation",
            )),
        };
        Self::log_result(
            "drop_database",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn list_mysql_character_sets(
        &self,
        profile_id: &str,
    ) -> IpcResult<Vec<DatabaseCharacterSet>> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_schema_mutator() {
            Some(mutator) => mutator.list_mysql_character_sets().await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support schema mutation",
            )),
        };
        Self::log_result(
            "list_mysql_character_sets",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn get_mysql_database_character_set(
        &self,
        profile_id: &str,
        container: &ContainerRef,
    ) -> IpcResult<Option<String>> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_schema_mutator() {
            Some(mutator) => mutator.get_mysql_database_character_set(container).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support schema mutation",
            )),
        };
        Self::log_result_with_container(
            "get_mysql_database_character_set",
            profile_id,
            None,
            driver.as_ref(),
            Some(container),
            result,
        )
    }

    pub async fn preview_create_table(
        &self,
        profile_id: &str,
        input: &CreateTableInput,
    ) -> IpcResult<SchemaMutationPreview> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_schema_mutator() {
            Some(mutator) => mutator.preview_create_table(input).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support schema mutation",
            )),
        };
        Self::log_result(
            "preview_create_table",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn create_table(
        &self,
        profile_id: &str,
        input: &CreateTableInput,
    ) -> IpcResult<CreateTableResult> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_schema_mutator() {
            Some(mutator) => mutator.create_table(input).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support schema mutation",
            )),
        };
        Self::log_result(
            "create_table",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn preview_update_table(
        &self,
        profile_id: &str,
        input: &UpdateTableInput,
    ) -> IpcResult<SchemaMutationPreview> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_schema_mutator() {
            Some(mutator) => mutator.preview_update_table(input).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support schema mutation",
            )),
        };
        Self::log_result(
            "preview_update_table",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn update_table(
        &self,
        profile_id: &str,
        input: &UpdateTableInput,
    ) -> IpcResult<UpdateTableResult> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_schema_mutator() {
            Some(mutator) => mutator.update_table(input).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support schema mutation",
            )),
        };
        Self::log_result(
            "update_table",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn preview_drop_table(
        &self,
        profile_id: &str,
        input: &DropTableInput,
    ) -> IpcResult<SchemaMutationPreview> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_schema_mutator() {
            Some(mutator) => mutator.preview_drop_table(input).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support schema mutation",
            )),
        };
        Self::log_result(
            "preview_drop_table",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn drop_table(
        &self,
        profile_id: &str,
        input: &DropTableInput,
    ) -> IpcResult<DropTableResult> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_schema_mutator() {
            Some(mutator) => mutator.drop_table(input).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support schema mutation",
            )),
        };
        Self::log_result(
            "drop_table",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn browse_table_data(
        &self,
        profile_id: &str,
        tab_id: Option<&str>,
        container: &ContainerRef,
        page: u32,
        page_size: u32,
        query: &TableBrowseQuery,
    ) -> IpcResult<QueryResult> {
        let driver = self.driver_for_profile_or_tab(profile_id, tab_id, "browse_table_data")?;
        let result = match driver.as_data_table_browser() {
            Some(browser) => {
                browser
                    .browse_table_data(container, page, page_size, query)
                    .await
            }
            None => Err(IpcError::resource_not_found(
                "This connection does not support table browsing",
            )),
        };
        Self::log_result_with_container(
            "browse_table_data",
            profile_id,
            tab_id,
            driver.as_ref(),
            Some(container),
            result,
        )
    }

    pub async fn get_table_page_stats(
        &self,
        profile_id: &str,
        tab_id: Option<&str>,
        container: &ContainerRef,
        page_size: u32,
        query: &TableBrowseQuery,
        requested_page: Option<u32>,
    ) -> IpcResult<TablePageStats> {
        let driver = self.driver_for_profile_or_tab(profile_id, tab_id, "get_table_page_stats")?;
        let result = match driver.as_data_table_browser() {
            Some(browser) => {
                browser
                    .get_table_page_stats(container, page_size, query, requested_page)
                    .await
            }
            None => Err(IpcError::resource_not_found(
                "This connection does not support table browsing",
            )),
        };
        Self::log_result_with_container(
            "get_table_page_stats",
            profile_id,
            tab_id,
            driver.as_ref(),
            Some(container),
            result,
        )
    }

    pub async fn update_table_row(
        &self,
        profile_id: &str,
        tab_id: Option<&str>,
        container: &ContainerRef,
        primary_key: &TableRowKey,
        changes: &[TableCellChange],
    ) -> IpcResult<TableMutationResult> {
        let driver = self.driver_for_profile_or_tab(profile_id, tab_id, "update_table_row")?;
        let result = match driver.as_data_table_browser() {
            Some(browser) => {
                browser
                    .update_table_row(container, primary_key, changes)
                    .await
            }
            None => Err(IpcError::resource_not_found(
                "This connection does not support table mutation",
            )),
        };
        Self::log_result_with_container(
            "update_table_row",
            profile_id,
            tab_id,
            driver.as_ref(),
            Some(container),
            result,
        )
    }

    pub async fn delete_table_rows(
        &self,
        profile_id: &str,
        tab_id: Option<&str>,
        container: &ContainerRef,
        primary_keys: &[TableRowKey],
    ) -> IpcResult<TableMutationResult> {
        let driver = self.driver_for_profile_or_tab(profile_id, tab_id, "delete_table_rows")?;
        let result = match driver.as_data_table_browser() {
            Some(browser) => browser.delete_table_rows(container, primary_keys).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support table mutation",
            )),
        };
        Self::log_result_with_container(
            "delete_table_rows",
            profile_id,
            tab_id,
            driver.as_ref(),
            Some(container),
            result,
        )
    }

    pub async fn preview_table_change_set(
        &self,
        profile_id: &str,
        tab_id: Option<&str>,
        container: &ContainerRef,
        change_set: &TableChangeSetRequest,
    ) -> IpcResult<TableChangeSetPreview> {
        let driver =
            self.driver_for_profile_or_tab(profile_id, tab_id, "preview_table_change_set")?;
        let result = match driver.as_data_table_browser() {
            Some(browser) => {
                browser
                    .preview_table_change_set(container, change_set)
                    .await
            }
            None => Err(IpcError::resource_not_found(
                "This connection does not support table mutation",
            )),
        };
        Self::log_result_with_container(
            "preview_table_change_set",
            profile_id,
            tab_id,
            driver.as_ref(),
            Some(container),
            result,
        )
    }

    pub async fn commit_table_change_set(
        &self,
        profile_id: &str,
        tab_id: Option<&str>,
        container: &ContainerRef,
        change_set: &TableChangeSetRequest,
    ) -> IpcResult<TableChangeSetCommitResult> {
        let driver =
            self.driver_for_profile_or_tab(profile_id, tab_id, "commit_table_change_set")?;
        let result = match driver.as_data_table_browser() {
            Some(browser) => browser.commit_table_change_set(container, change_set).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support table mutation",
            )),
        };
        Self::log_result_with_container(
            "commit_table_change_set",
            profile_id,
            tab_id,
            driver.as_ref(),
            Some(container),
            result,
        )
    }

    pub async fn execute_sql(
        &self,
        profile_id: &str,
        tab_id: &str,
        context: &SqlExecutionContext,
        sql: &str,
        page: u32,
        page_size: u32,
    ) -> IpcResult<QueryResult> {
        let driver = self.driver_for_profile_or_tab(profile_id, Some(tab_id), "execute_sql")?;
        let result = match driver.as_sql_executor() {
            Some(executor) => executor.execute_sql(context, sql, page, page_size).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support SQL execution",
            )),
        };
        Self::log_result(
            "execute_sql",
            profile_id,
            Some(tab_id),
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn execute_shared_sql(
        &self,
        profile_id: &str,
        context: &SqlExecutionContext,
        sql: &str,
        page: u32,
        page_size: u32,
    ) -> IpcResult<QueryResult> {
        let driver = self.driver_for_profile_or_tab(profile_id, None, "execute_shared_sql")?;
        let result = match driver.as_sql_executor() {
            Some(executor) => executor.execute_sql(context, sql, page, page_size).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support SQL execution",
            )),
        };
        Self::log_result(
            "execute_shared_sql",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn execute_shared_managed_sql(
        &self,
        profile_id: &str,
        request: StartSqlExecutionRequest,
        statement_class: SqlStatementClass,
    ) -> IpcResult<SharedManagedSqlExecution> {
        let driver =
            self.driver_for_profile_or_tab(profile_id, None, "execute_shared_managed_sql")?;
        let features = driver.capabilities().sql_execution.ok_or_else(|| {
            IpcError::feature_unavailable("This connection does not support managed SQL execution")
        })?;
        if !features.managed_lifecycle
            || features.statement_access != SqlStatementAccess::Direct
            || request.options.result_mode != SqlResultMode::Grid
        {
            return Err(IpcError::feature_unavailable(
                "This connection does not support direct managed Grid SQL execution",
            ));
        }
        if request.options.page != 1 || !(1..=100).contains(&request.options.page_size) {
            return Err(IpcError::validation_failed(
                "Managed AI SQL requires page 1 and a page size between 1 and 100",
            ));
        }
        if request.options.timeout_ms != Some(30_000) {
            return Err(IpcError::validation_failed(
                "Managed AI SQL requires the fixed 30 second backend timeout",
            ));
        }
        let executor = driver
            .as_managed_sql_executor()
            .ok_or_else(|| IpcError::feature_unavailable("Managed SQL executor is unavailable"))?;
        let execution_id = uuid::Uuid::new_v4().to_string();
        let query_id = uuid::Uuid::new_v4().to_string();
        let observer = Arc::new(SharedManagedSqlObserver::default());
        let (_cancel_tx, cancel_rx) = watch::channel(false);
        let control = SqlExecutionControl::new(cancel_rx, observer.clone());
        let managed_request = ManagedSqlExecutionRequest {
            execution_id: execution_id.clone(),
            query_id,
            context: request.context,
            sql: request.sql,
            options: request.options,
            statement_class,
            raw_artifact: None,
        };
        let mut result = executor.execute_managed_sql(managed_request, control).await;
        let warnings = observer.warnings();
        if let Err(error) = &mut result {
            if error.code == ErrorCode::OperationTimeout && !warnings.is_empty() {
                error.message = format!("{}; {}", error.message, warnings.join(" "));
            }
        }
        let result = result.map(|outcome| SharedManagedSqlExecution {
            execution_id,
            statement_class,
            outcome,
            observation_warnings: warnings,
        });
        Self::log_result(
            "execute_shared_managed_sql",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub fn start_sql_execution(
        &self,
        profile_id: &str,
        tab_id: &str,
        request: StartSqlExecutionRequest,
        sink: Arc<dyn SqlExecutionEventSink>,
    ) -> IpcResult<SqlExecutionHandle> {
        let driver =
            self.driver_for_profile_or_tab(profile_id, Some(tab_id), "start_sql_execution")?;
        let capabilities = driver.capabilities();
        let features = capabilities.sql_execution.as_ref().ok_or_else(|| {
            IpcError::resource_not_found("This connection does not support managed SQL execution")
        })?;
        if !features.managed_lifecycle {
            return Err(IpcError::resource_not_found(
                "This connection does not support managed SQL execution",
            ));
        }
        validate_start_sql_execution(&request)?;
        if request.options.result_mode == SqlResultMode::Raw && !features.raw_result {
            return Err(IpcError::validation_failed(
                "This connection does not support Raw SQL results",
            ));
        }
        let executor = driver
            .as_managed_sql_executor()
            .ok_or_else(|| IpcError::resource_not_found("Managed SQL executor is unavailable"))?;
        let runtime = tokio::runtime::Handle::try_current().map_err(|error| {
            IpcError::system_internal(
                "Managed SQL execution runtime is unavailable",
                format!("start_sql_execution requires a Tokio runtime: {error}"),
            )
        })?;

        let execution_id = uuid::Uuid::new_v4().to_string();
        let query_id = uuid::Uuid::new_v4().to_string();
        let statement_class = executor.classify_statement(&request.sql)?;
        let registered = self.sql_executions.register_with_sink(
            SqlExecutionStartInput {
                profile_id: profile_id.to_string(),
                tab_id: tab_id.to_string(),
                execution_id: execution_id.clone(),
                query_id: query_id.clone(),
                statement_class,
                started_at: now_unix_ms(),
            },
            sink,
        )?;
        if let Err(error) = self.raw_artifacts.release_tab(tab_id) {
            let _ = self.sql_executions.discard_tab(tab_id);
            return Err(error);
        }
        let artifact_owner = RawArtifactOwner {
            profile_id: profile_id.to_string(),
            tab_id: tab_id.to_string(),
            execution_id: execution_id.clone(),
        };
        let raw_artifact = if request.options.result_mode == SqlResultMode::Raw {
            match self.raw_artifacts.start(artifact_owner.clone()) {
                Ok(writer) => Some(writer),
                Err(error) => {
                    let _ = self.sql_executions.discard_tab(tab_id);
                    return Err(error);
                }
            }
        } else {
            None
        };
        let handle = SqlExecutionHandle {
            execution_id: execution_id.clone(),
            query_id: query_id.clone(),
            tab_id: tab_id.to_string(),
            state: registered.snapshot().state,
            started_at: registered.snapshot().started_at,
        };
        let observer: Arc<dyn SqlExecutionObserver> = Arc::new(CoordinatorSqlExecutionObserver {
            coordinator: self.sql_executions.clone(),
            tab_id: tab_id.to_string(),
            execution_id: execution_id.clone(),
        });
        let control = SqlExecutionControl::new(registered.cancellation(), observer);
        let managed_request = ManagedSqlExecutionRequest {
            execution_id: execution_id.clone(),
            query_id,
            context: request.context,
            sql: request.sql,
            options: request.options,
            statement_class,
            raw_artifact,
        };
        let coordinator = self.sql_executions.clone();
        let raw_artifacts = self.raw_artifacts.clone();
        let tab_id = tab_id.to_string();
        runtime.spawn(async move {
            tokio::task::yield_now().await;
            if coordinator
                .transition(&tab_id, &execution_id, SqlExecutionState::Running)
                .is_err()
            {
                return;
            }
            let Some(executor) = driver.as_managed_sql_executor() else {
                let _ = coordinator.complete_failure(
                    &tab_id,
                    &execution_id,
                    SqlExecutionState::Failed,
                    IpcError::resource_not_found("Managed SQL executor became unavailable").into(),
                );
                return;
            };
            match executor.execute_managed_sql(managed_request, control).await {
                Ok(outcome) => {
                    let keep_artifact = matches!(outcome, SqlExecutionOutcome::Raw { .. });
                    if coordinator
                        .complete_success(&tab_id, &execution_id, outcome)
                        .is_err()
                        || !keep_artifact
                    {
                        let _ = raw_artifacts.release_execution(&artifact_owner);
                    }
                }
                Err(error) if error.code == ErrorCode::OperationCanceled => {
                    let _ = raw_artifacts.release_execution(&artifact_owner);
                    match coordinator.snapshot(&tab_id, &execution_id) {
                        Ok(snapshot) if snapshot.state == SqlExecutionState::Canceling => {
                            // Local result consumption stopped. The independent control request
                            // owns the confirmed cancellation terminal state.
                        }
                        Ok(_) => {
                            let _ = coordinator.complete_failure(
                                &tab_id,
                                &execution_id,
                                SqlExecutionState::Failed,
                                error.into(),
                            );
                        }
                        Err(_) => {
                            // Runtime teardown discarded ownership; ignore late completion.
                        }
                    }
                }
                Err(error) => {
                    let _ = raw_artifacts.release_execution(&artifact_owner);
                    let state = if error.code == ErrorCode::OperationTimeout {
                        SqlExecutionState::TimedOut
                    } else {
                        SqlExecutionState::Failed
                    };
                    let _ =
                        coordinator.complete_failure(&tab_id, &execution_id, state, error.into());
                }
            }
        });
        Ok(handle)
    }

    pub fn get_sql_execution_snapshot(
        &self,
        profile_id: &str,
        tab_id: &str,
        execution_id: &str,
    ) -> IpcResult<SqlExecutionSnapshot> {
        self.sql_executions
            .snapshot_for_profile(profile_id, tab_id, execution_id)
    }

    pub async fn cancel_sql_execution(
        &self,
        profile_id: &str,
        tab_id: &str,
        execution_id: &str,
    ) -> IpcResult<SqlExecutionSnapshot> {
        let driver =
            self.driver_for_profile_or_tab(profile_id, Some(tab_id), "cancel_sql_execution")?;
        let features = driver.capabilities().sql_execution.ok_or_else(|| {
            IpcError::resource_not_found("This connection does not support managed SQL execution")
        })?;
        if !features.managed_lifecycle || !features.active_cancel {
            return Err(IpcError::resource_not_found(
                "This connection does not support active SQL cancellation",
            ));
        }
        if driver.as_managed_sql_executor().is_none() {
            return Err(IpcError::resource_not_found(
                "Managed SQL cancel executor is unavailable",
            ));
        }
        let snapshot =
            self.sql_executions
                .snapshot_for_profile(profile_id, tab_id, execution_id)?;
        if snapshot.state == SqlExecutionState::Canceling {
            return Ok(snapshot);
        }
        let cancel_request = ManagedSqlCancelRequest {
            execution_id: snapshot.execution_id.clone(),
            query_id: snapshot.query_id.clone(),
            tab_id: tab_id.to_string(),
        };
        let canceling = self.sql_executions.begin_cancel(tab_id, execution_id)?;

        let coordinator = self.sql_executions.clone();
        let control_driver = driver.clone();
        let control_tab_id = tab_id.to_string();
        let control_execution_id = execution_id.to_string();
        tokio::spawn(async move {
            let Some(executor) = control_driver.as_managed_sql_executor() else {
                let _ = coordinator.complete_failure(
                    &control_tab_id,
                    &control_execution_id,
                    SqlExecutionState::CancelFailed,
                    IpcError::resource_not_found("Managed SQL cancel executor became unavailable")
                        .into(),
                );
                return;
            };
            match executor.cancel_managed_sql(cancel_request).await {
                Ok(SqlCancelConfirmation::Confirmed(message)) => {
                    let _ = coordinator.complete_cancel(
                        &control_tab_id,
                        &control_execution_id,
                        message,
                    );
                }
                Ok(SqlCancelConfirmation::AlreadyFinished(message)) => {
                    let _ = coordinator.complete_failure(
                        &control_tab_id,
                        &control_execution_id,
                        SqlExecutionState::CancelFailed,
                        IpcError::validation_failed(message).into(),
                    );
                }
                Ok(SqlCancelConfirmation::Failed(failure)) => {
                    let _ = coordinator.complete_failure(
                        &control_tab_id,
                        &control_execution_id,
                        SqlExecutionState::CancelFailed,
                        failure,
                    );
                }
                Err(error) => {
                    let _ = coordinator.complete_failure(
                        &control_tab_id,
                        &control_execution_id,
                        SqlExecutionState::CancelFailed,
                        error.into(),
                    );
                }
            }
        });

        Ok(canceling)
    }

    pub async fn save_sql_execution_artifact(
        &self,
        profile_id: &str,
        tab_id: &str,
        execution_id: &str,
        artifact_id: &str,
        destination_path: PathBuf,
    ) -> IpcResult<()> {
        let snapshot =
            self.sql_executions
                .snapshot_for_profile(profile_id, tab_id, execution_id)?;
        if !is_terminal_sql_execution_state(snapshot.state) {
            return Err(IpcError::resource_conflict(
                "An active SQL execution artifact cannot be saved",
            ));
        }
        let matches_artifact = matches!(
            snapshot.outcome,
            Some(SqlExecutionOutcome::Raw {
                artifact_id: ref current,
                ..
            }) if current == artifact_id
        );
        if !matches_artifact {
            return Err(IpcError::resource_not_found(
                "Raw SQL artifact is not available for this execution",
            ));
        }
        let owner = RawArtifactOwner {
            profile_id: profile_id.to_string(),
            tab_id: tab_id.to_string(),
            execution_id: execution_id.to_string(),
        };
        let artifact_id = artifact_id.to_string();
        let store = self.raw_artifacts.clone();
        tokio::task::spawn_blocking(move || {
            store.save_completed(&owner, &artifact_id, &destination_path)
        })
        .await
        .map_err(|_| {
            IpcError::system_internal(
                "Raw SQL artifact save failed",
                "artifact save worker did not complete",
            )
        })?
    }

    pub fn release_sql_execution(
        &self,
        profile_id: &str,
        tab_id: &str,
        execution_id: &str,
    ) -> IpcResult<()> {
        let snapshot =
            self.sql_executions
                .snapshot_for_profile(profile_id, tab_id, execution_id)?;
        if !is_terminal_sql_execution_state(snapshot.state) {
            return Err(IpcError::resource_conflict(
                "An active SQL execution cannot be released",
            ));
        }
        self.raw_artifacts.release_execution(&RawArtifactOwner {
            profile_id: profile_id.to_string(),
            tab_id: tab_id.to_string(),
            execution_id: execution_id.to_string(),
        })?;
        self.sql_executions
            .release_for_profile(profile_id, tab_id, execution_id)
    }

    pub fn shutdown_sql_execution_state(&self) -> IpcResult<()> {
        let execution_result = self.sql_executions.discard_all().map(|_| ());
        let artifact_result = self.raw_artifacts.release_all();
        execution_result.and(artifact_result)
    }

    pub async fn begin_tab_transaction(
        &self,
        profile_id: &str,
        tab_id: &str,
        container: &ContainerRef,
    ) -> IpcResult<TableTransactionState> {
        let driver =
            self.driver_for_profile_or_tab(profile_id, Some(tab_id), "begin_tab_transaction")?;
        let result = match driver.as_transaction_manager() {
            Some(manager) => manager.begin_transaction(container).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support transaction management",
            )),
        };
        Self::log_result_with_container(
            "begin_tab_transaction",
            profile_id,
            Some(tab_id),
            driver.as_ref(),
            Some(container),
            result,
        )
    }

    pub async fn commit_tab_transaction(
        &self,
        profile_id: &str,
        tab_id: &str,
    ) -> IpcResult<TableTransactionState> {
        let driver =
            self.driver_for_profile_or_tab(profile_id, Some(tab_id), "commit_tab_transaction")?;
        let result = match driver.as_transaction_manager() {
            Some(manager) => manager.commit_transaction().await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support transaction management",
            )),
        };
        Self::log_result(
            "commit_tab_transaction",
            profile_id,
            Some(tab_id),
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn rollback_tab_transaction(
        &self,
        profile_id: &str,
        tab_id: &str,
    ) -> IpcResult<TableTransactionState> {
        let driver =
            self.driver_for_profile_or_tab(profile_id, Some(tab_id), "rollback_tab_transaction")?;
        let result = match driver.as_transaction_manager() {
            Some(manager) => manager.rollback_transaction().await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support transaction management",
            )),
        };
        Self::log_result(
            "rollback_tab_transaction",
            profile_id,
            Some(tab_id),
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn get_tab_transaction_state(
        &self,
        profile_id: &str,
        tab_id: &str,
    ) -> IpcResult<TableTransactionState> {
        let driver =
            self.driver_for_profile_or_tab(profile_id, Some(tab_id), "get_tab_transaction_state")?;
        let result = match driver.as_transaction_manager() {
            Some(manager) => manager.transaction_state().await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support transaction management",
            )),
        };
        Self::log_result(
            "get_tab_transaction_state",
            profile_id,
            Some(tab_id),
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn scan_key_values(
        &self,
        profile_id: &str,
        request: &RedisScanRequest,
    ) -> IpcResult<RedisScanResult> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_key_value_browser() {
            Some(browser) => browser.scan_key_values(request).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support key-value browsing",
            )),
        };
        Self::log_result(
            "scan_key_values",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn get_key_value(
        &self,
        profile_id: &str,
        key_ref: &RedisKeyRef,
    ) -> IpcResult<RedisKeyValue> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_key_value_browser() {
            Some(browser) => browser.get_key_value(key_ref).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support key-value browsing",
            )),
        };
        Self::log_result(
            "get_key_value",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn get_key_precondition(
        &self,
        profile_id: &str,
        key_ref: &RedisKeyRef,
    ) -> IpcResult<RedisKeyPrecondition> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_key_value_browser() {
            Some(browser) => browser.get_key_precondition(key_ref).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support key-value browsing",
            )),
        };
        Self::log_result(
            "get_key_precondition",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn browse_key_tree(
        &self,
        profile_id: &str,
        request: &RedisKeyTreeRequest,
    ) -> IpcResult<RedisKeyTreeResult> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_key_value_browser() {
            Some(browser) => browser.browse_key_tree(request).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support key-value browsing",
            )),
        };
        Self::log_result(
            "browse_key_tree",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn set_key_value(
        &self,
        profile_id: &str,
        request: &RedisSetKeyValueRequest,
    ) -> IpcResult<RedisKeyMutationResult> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_key_value_browser() {
            Some(browser) => browser.set_key_value(request).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support key-value mutation",
            )),
        };
        Self::log_result(
            "set_key_value",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn create_key_value(
        &self,
        profile_id: &str,
        request: &RedisCreateKeyValueRequest,
    ) -> IpcResult<RedisKeyMutationResult> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_key_value_browser() {
            Some(browser) => browser.create_key_value(request).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support key-value mutation",
            )),
        };
        Self::log_result(
            "create_key_value",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn delete_key(
        &self,
        profile_id: &str,
        request: &RedisDeleteKeyRequest,
    ) -> IpcResult<RedisDeleteKeyResult> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_key_value_browser() {
            Some(browser) => browser.delete_key(request).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support key-value mutation",
            )),
        };
        Self::log_result(
            "delete_key",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn delete_key_prefix(
        &self,
        profile_id: &str,
        request: &RedisDeleteKeyPrefixRequest,
    ) -> IpcResult<RedisDeleteKeyResult> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_key_value_browser() {
            Some(browser) => browser.delete_key_prefix(request).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support key-value mutation",
            )),
        };
        Self::log_result(
            "delete_key_prefix",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn rename_key(
        &self,
        profile_id: &str,
        request: &RedisRenameKeyRequest,
    ) -> IpcResult<RedisKeyMutationResult> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_key_value_browser() {
            Some(browser) => browser.rename_key(request).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support key-value mutation",
            )),
        };
        Self::log_result(
            "rename_key",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    pub async fn set_key_ttl(
        &self,
        profile_id: &str,
        request: &RedisSetKeyTtlRequest,
    ) -> IpcResult<RedisKeyMutationResult> {
        let driver = self.shared_driver(profile_id)?;
        let result = match driver.as_key_value_browser() {
            Some(browser) => browser.set_key_ttl(request).await,
            None => Err(IpcError::resource_not_found(
                "This connection does not support key-value mutation",
            )),
        };
        Self::log_result(
            "set_key_ttl",
            profile_id,
            None,
            driver.as_ref(),
            None,
            result,
        )
    }

    fn shared_runtime(&self, profile_id: &str) -> IpcResult<ProfileRuntime> {
        self.shared
            .read()
            .map_err(|_| lock_error("shared_driver"))?
            .get(profile_id)
            .cloned()
            .ok_or_else(|| {
                IpcError::resource_not_found(format!(
                    "No active runtime for profile '{profile_id}'. Connect first."
                ))
            })
    }

    fn shared_driver(&self, profile_id: &str) -> IpcResult<Arc<dyn DatabaseDriver>> {
        Ok(self.shared_runtime(profile_id)?.driver)
    }

    fn native_schema_driver(
        &self,
        profile_id: &str,
        owner_tab_runtime_id: Option<&str>,
    ) -> IpcResult<Arc<dyn DatabaseDriver>> {
        self.driver_for_profile_or_tab(profile_id, owner_tab_runtime_id, "native_schema_driver")
    }

    fn driver_for_profile_or_tab(
        &self,
        profile_id: &str,
        tab_id: Option<&str>,
        context: &str,
    ) -> IpcResult<Arc<dyn DatabaseDriver>> {
        let Some(tab_id) = tab_id else {
            return self.shared_driver(profile_id);
        };

        let tabs = self.tabs.read().map_err(|_| lock_error(context))?;
        let runtime = tabs.get(tab_id).ok_or_else(|| {
            IpcError::resource_not_found(format!(
                "No active tab runtime '{tab_id}'. Open the tab runtime first."
            ))
        })?;

        if runtime.profile_id != profile_id {
            return Err(IpcError::resource_not_found(format!(
                "Tab runtime '{tab_id}' does not belong to profile '{profile_id}'"
            )));
        }

        Ok(runtime.driver.clone())
    }

    fn log_result<T>(
        operation: &str,
        profile_id: &str,
        tab_id: Option<&str>,
        driver: &dyn DatabaseDriver,
        container: Option<&ContainerRef>,
        result: IpcResult<T>,
    ) -> IpcResult<T> {
        if let Err(error) = &result {
            diagnostics::log_engine_error(operation, profile_id, tab_id, driver, container, error);
        }
        result
    }

    fn log_result_with_container<T>(
        operation: &str,
        profile_id: &str,
        tab_id: Option<&str>,
        driver: &dyn DatabaseDriver,
        container: Option<&ContainerRef>,
        result: IpcResult<T>,
    ) -> IpcResult<T> {
        Self::log_result(operation, profile_id, tab_id, driver, container, result)
    }
}

impl Default for ConnectionRuntimeManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use async_trait::async_trait;
    use tokio::sync::Notify;

    use crate::engine::driver::ManagedSqlExecutor;
    use crate::engine::drivers::clickhouse::ClickHouseDriver;
    use crate::engine::sql_execution::artifact::{
        RawArtifactLimits, RawArtifactPreviewMode, RawArtifactStore,
    };
    use crate::engine::sql_execution::{
        ManagedSqlCancelRequest, ManagedSqlExecutionRequest, SqlCancelConfirmation,
        SqlExecutionControl, SqlExecutionEventSink,
    };
    use crate::engine::types::{
        DriverCapabilities, SqlExecutionEvent, SqlExecutionFeatures, SqlExecutionHandle,
        SqlExecutionOptions, SqlExecutionOutcome, SqlExecutionSnapshot, SqlExecutionState,
        SqlResultMode, SqlStatementAccess, SqlStatementClass, StartSqlExecutionRequest,
    };
    use crate::error::{ErrorCode, IpcResult, RuntimeErrorImpact};

    struct RecordingSink;

    impl SqlExecutionEventSink for RecordingSink {
        fn publish(&self, _event: SqlExecutionEvent) -> Result<(), String> {
            Ok(())
        }
    }

    struct FakeManagedDriver {
        profile_id: String,
        managed_feature: bool,
        raw_result: bool,
        active_cancel: bool,
        result: FakeManagedResult,
        release: Arc<Notify>,
        execution_calls: Arc<AtomicUsize>,
        statement_class: SqlStatementClass,
        statement_access: SqlStatementAccess,
        ignore_local_cancellation: bool,
        raw_finished: Arc<Notify>,
        cancel_release: Arc<Notify>,
        cancel_calls: Arc<AtomicUsize>,
        cancel_result: Mutex<Option<IpcResult<SqlCancelConfirmation>>>,
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum FakeManagedResult {
        Success,
        Raw,
        TimedOut,
        Canceled,
        Failed,
    }

    impl FakeManagedDriver {
        fn new(profile_id: &str, managed_feature: bool) -> Arc<Self> {
            Arc::new(Self {
                profile_id: profile_id.to_string(),
                managed_feature,
                raw_result: false,
                active_cancel: false,
                result: FakeManagedResult::Success,
                release: Arc::new(Notify::new()),
                execution_calls: Arc::new(AtomicUsize::new(0)),
                statement_class: SqlStatementClass::Unknown,
                statement_access: SqlStatementAccess::ReadOnly,
                ignore_local_cancellation: false,
                raw_finished: Arc::new(Notify::new()),
                cancel_release: Arc::new(Notify::new()),
                cancel_calls: Arc::new(AtomicUsize::new(0)),
                cancel_result: Mutex::new(Some(Ok(SqlCancelConfirmation::AlreadyFinished(
                    "fake query finished".to_string(),
                )))),
            })
        }

        fn with_result(profile_id: &str, result: FakeManagedResult) -> Arc<Self> {
            Arc::new(Self {
                profile_id: profile_id.to_string(),
                managed_feature: true,
                raw_result: false,
                active_cancel: false,
                result,
                release: Arc::new(Notify::new()),
                execution_calls: Arc::new(AtomicUsize::new(0)),
                statement_class: SqlStatementClass::Unknown,
                statement_access: SqlStatementAccess::ReadOnly,
                ignore_local_cancellation: false,
                raw_finished: Arc::new(Notify::new()),
                cancel_release: Arc::new(Notify::new()),
                cancel_calls: Arc::new(AtomicUsize::new(0)),
                cancel_result: Mutex::new(Some(Ok(SqlCancelConfirmation::AlreadyFinished(
                    "fake query finished".to_string(),
                )))),
            })
        }

        fn cancelable(
            profile_id: &str,
            ignore_local_cancellation: bool,
            cancel_result: IpcResult<SqlCancelConfirmation>,
        ) -> Arc<Self> {
            Arc::new(Self {
                profile_id: profile_id.to_string(),
                managed_feature: true,
                raw_result: false,
                active_cancel: true,
                result: FakeManagedResult::Success,
                release: Arc::new(Notify::new()),
                execution_calls: Arc::new(AtomicUsize::new(0)),
                statement_class: SqlStatementClass::Read,
                statement_access: SqlStatementAccess::ReadOnly,
                ignore_local_cancellation,
                raw_finished: Arc::new(Notify::new()),
                cancel_release: Arc::new(Notify::new()),
                cancel_calls: Arc::new(AtomicUsize::new(0)),
                cancel_result: Mutex::new(Some(cancel_result)),
            })
        }

        fn with_statement_class(
            mut self: Arc<Self>,
            statement_class: SqlStatementClass,
        ) -> Arc<Self> {
            Arc::get_mut(&mut self)
                .expect("fake managed driver builder must have unique ownership")
                .statement_class = statement_class;
            self
        }

        fn with_raw_result(mut self: Arc<Self>, raw_result: bool) -> Arc<Self> {
            Arc::get_mut(&mut self)
                .expect("fake managed driver builder must have unique ownership")
                .raw_result = raw_result;
            self
        }

        fn with_direct_access(mut self: Arc<Self>) -> Arc<Self> {
            Arc::get_mut(&mut self)
                .expect("fake managed driver builder must have unique ownership")
                .statement_access = SqlStatementAccess::Direct;
            self
        }
    }

    #[async_trait]
    impl ManagedSqlExecutor for FakeManagedDriver {
        fn classify_statement(&self, _sql: &str) -> IpcResult<SqlStatementClass> {
            Ok(self.statement_class)
        }

        async fn execute_managed_sql(
            &self,
            mut request: ManagedSqlExecutionRequest,
            control: SqlExecutionControl,
        ) -> IpcResult<SqlExecutionOutcome> {
            self.execution_calls.fetch_add(1, Ordering::SeqCst);
            if request.options.result_mode == SqlResultMode::Raw {
                let mut writer = request.raw_artifact.take().ok_or_else(|| {
                    IpcError::system_internal(
                        "Fake Raw artifact writer is unavailable",
                        "manager omitted the test writer",
                    )
                })?;
                writer.write_chunk(b"raw bytes")?;
                let descriptor = writer.finish(RawArtifactPreviewMode::Text)?;
                self.raw_finished.notify_one();
                self.release.notified().await;
                return Ok(SqlExecutionOutcome::Raw {
                    format: Some("CSV".to_string()),
                    media_type: "text/csv".to_string(),
                    byte_length: descriptor.byte_length,
                    preview: descriptor.preview,
                    preview_truncated: descriptor.preview_truncated,
                    artifact_id: descriptor.artifact_id,
                });
            }
            if request.raw_artifact.is_some() {
                return Err(IpcError::validation_failed(
                    "Grid execution received an unexpected Raw artifact writer",
                ));
            }
            if self.ignore_local_cancellation {
                self.release.notified().await;
                return Ok(empty_rows_outcome());
            }
            wait_for_fake_result(&self.release, self.result, control).await
        }

        async fn cancel_managed_sql(
            &self,
            _request: ManagedSqlCancelRequest,
        ) -> IpcResult<SqlCancelConfirmation> {
            self.cancel_calls.fetch_add(1, Ordering::SeqCst);
            self.cancel_release.notified().await;
            self.cancel_result
                .lock()
                .expect("cancel result lock")
                .take()
                .expect("one fake cancel result")
        }
    }

    #[async_trait]
    impl DatabaseDriver for FakeManagedDriver {
        fn profile_id(&self) -> &str {
            &self.profile_id
        }

        fn driver_name(&self) -> &'static str {
            "fake-managed"
        }

        fn capabilities(&self) -> DriverCapabilities {
            DriverCapabilities {
                sql_executor: true,
                sql_execution: self.managed_feature.then_some(SqlExecutionFeatures {
                    managed_lifecycle: true,
                    statement_access: self.statement_access,
                    active_cancel: self.active_cancel,
                    live_progress: false,
                    query_summary: false,
                    raw_result: self.raw_result,
                    configurable_timeout: true,
                }),
                ..DriverCapabilities::default()
            }
        }

        async fn ping(&self) -> IpcResult<PingResult> {
            Ok(PingResult { latency_ms: 1 })
        }

        async fn close(&self) -> IpcResult<()> {
            Ok(())
        }

        fn as_managed_sql_executor(&self) -> Option<&dyn ManagedSqlExecutor> {
            Some(self)
        }
    }

    fn manager_with_managed_tab(
        profile_id: &str,
        tab_id: &str,
        driver: Arc<FakeManagedDriver>,
    ) -> ConnectionRuntimeManager {
        let manager = ConnectionRuntimeManager::new();
        let driver: Arc<dyn DatabaseDriver> = driver;
        manager.tabs.write().expect("tab runtimes lock").insert(
            tab_id.to_string(),
            TabRuntime {
                profile_id: profile_id.to_string(),
                driver,
            },
        );
        manager
    }

    fn manager_with_managed_shared(
        profile_id: &str,
        driver: Arc<FakeManagedDriver>,
    ) -> ConnectionRuntimeManager {
        let manager = ConnectionRuntimeManager::new();
        let driver: Arc<dyn DatabaseDriver> = driver;
        manager
            .shared
            .write()
            .expect("shared runtimes lock")
            .insert(
                profile_id.to_string(),
                ProfileRuntime {
                    driver,
                    health: Arc::new(RwLock::new(RuntimeHealthSnapshot::healthy(
                        profile_id,
                        now_unix_ms(),
                    ))),
                },
            );
        manager
    }

    fn manager_with_managed_tab_and_store(
        profile_id: &str,
        tab_id: &str,
        driver: Arc<FakeManagedDriver>,
        store: RawArtifactStore,
    ) -> ConnectionRuntimeManager {
        let manager = ConnectionRuntimeManager::with_raw_artifact_store_for_test(store);
        let driver: Arc<dyn DatabaseDriver> = driver;
        manager.tabs.write().expect("tab runtimes lock").insert(
            tab_id.to_string(),
            TabRuntime {
                profile_id: profile_id.to_string(),
                driver,
            },
        );
        manager
    }

    fn manager_with_profile_and_tab_store(
        profile_id: &str,
        tab_id: &str,
        driver: Arc<FakeManagedDriver>,
        store: RawArtifactStore,
    ) -> ConnectionRuntimeManager {
        let manager = ConnectionRuntimeManager::with_raw_artifact_store_for_test(store);
        let shared_driver: Arc<dyn DatabaseDriver> = driver.clone();
        manager
            .shared
            .write()
            .expect("shared runtimes lock")
            .insert(
                profile_id.to_string(),
                ProfileRuntime {
                    driver: shared_driver,
                    health: Arc::new(RwLock::new(RuntimeHealthSnapshot::healthy(
                        profile_id,
                        now_unix_ms(),
                    ))),
                },
            );
        let tab_driver: Arc<dyn DatabaseDriver> = driver;
        manager.tabs.write().expect("tab runtimes lock").insert(
            tab_id.to_string(),
            TabRuntime {
                profile_id: profile_id.to_string(),
                driver: tab_driver,
            },
        );
        manager
    }

    fn manager_with_two_managed_tabs(
        profile_id: &str,
        drivers: [(&str, Arc<FakeManagedDriver>); 2],
    ) -> ConnectionRuntimeManager {
        let manager = ConnectionRuntimeManager::new();
        let shared_driver: Arc<dyn DatabaseDriver> = drivers[0].1.clone();
        manager
            .shared
            .write()
            .expect("shared runtimes lock")
            .insert(
                profile_id.to_string(),
                ProfileRuntime {
                    driver: shared_driver,
                    health: Arc::new(RwLock::new(RuntimeHealthSnapshot::healthy(
                        profile_id,
                        now_unix_ms(),
                    ))),
                },
            );
        for (tab_id, driver) in drivers {
            let driver: Arc<dyn DatabaseDriver> = driver;
            manager.tabs.write().expect("tab runtimes lock").insert(
                tab_id.to_string(),
                TabRuntime {
                    profile_id: profile_id.to_string(),
                    driver,
                },
            );
        }
        manager
    }

    #[test]
    fn runtime_snapshots_project_only_shared_runtime_facts() {
        let manager = manager_with_two_managed_tabs(
            "profile",
            [
                ("tab-1", FakeManagedDriver::new("profile", true)),
                ("tab-2", FakeManagedDriver::new("profile", true)),
            ],
        );

        let snapshots = manager
            .runtime_snapshots()
            .expect("runtime snapshots should read");
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].profile_id, "profile");
        assert_eq!(snapshots[0].runtime.profile_id, "profile");
        assert_eq!(
            snapshots[0].health.status,
            crate::engine::types::RuntimeHealthStatus::Healthy
        );
    }

    async fn wait_for_fake_result(
        release: &Notify,
        result: FakeManagedResult,
        control: SqlExecutionControl,
    ) -> IpcResult<SqlExecutionOutcome> {
        let mut cancellation = control.cancelled();
        tokio::select! {
            _ = release.notified() => match result {
                FakeManagedResult::Success => Ok(empty_rows_outcome()),
                FakeManagedResult::Raw => Ok(empty_rows_outcome()),
                FakeManagedResult::TimedOut => Err(IpcError::operation_timeout(
                    "query timed out",
                    "fake timeout",
                )),
                FakeManagedResult::Canceled => Err(IpcError::operation_canceled(
                    "query canceled",
                    "fake cancellation",
                )),
                FakeManagedResult::Failed => {
                    Err(IpcError::validation_failed("fake query failure"))
                }
            },
            changed = cancellation.changed() => {
                changed.map_err(|error| IpcError::system_internal(
                    "Fake cancellation channel closed",
                    error.to_string(),
                ))?;
                Err(IpcError::operation_canceled(
                    "Fake managed query canceled",
                    "runtime cleanup signaled cancellation",
                ))
            }
        }
    }

    fn empty_rows_outcome() -> SqlExecutionOutcome {
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

    fn managed_request(sql: &str) -> StartSqlExecutionRequest {
        StartSqlExecutionRequest {
            context: SqlExecutionContext::default(),
            sql: sql.to_string(),
            options: SqlExecutionOptions {
                result_mode: SqlResultMode::Grid,
                timeout_ms: Some(30_000),
                page: 1,
                page_size: 100,
            },
        }
    }

    fn managed_request_with_mode(
        sql: &str,
        result_mode: SqlResultMode,
    ) -> StartSqlExecutionRequest {
        StartSqlExecutionRequest {
            context: SqlExecutionContext::default(),
            sql: sql.to_string(),
            options: SqlExecutionOptions {
                result_mode,
                timeout_ms: Some(30_000),
                page: 1,
                page_size: 100,
            },
        }
    }

    async fn wait_for_managed_terminal(
        manager: &ConnectionRuntimeManager,
        profile_id: &str,
        tab_id: &str,
        execution_id: &str,
    ) -> SqlExecutionSnapshot {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let snapshot = manager
                    .get_sql_execution_snapshot(profile_id, tab_id, execution_id)
                    .expect("read managed snapshot");
                if matches!(
                    snapshot.state,
                    SqlExecutionState::Succeeded
                        | SqlExecutionState::Failed
                        | SqlExecutionState::TimedOut
                        | SqlExecutionState::Canceled
                        | SqlExecutionState::CancelFailed
                ) {
                    return snapshot;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("managed execution reaches terminal state")
    }

    async fn wait_for_managed_state(
        manager: &ConnectionRuntimeManager,
        profile_id: &str,
        tab_id: &str,
        execution_id: &str,
        expected: SqlExecutionState,
    ) -> SqlExecutionSnapshot {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let snapshot = manager
                    .get_sql_execution_snapshot(profile_id, tab_id, execution_id)
                    .expect("read managed snapshot");
                if snapshot.state == expected {
                    return snapshot;
                }
                assert!(
                    !matches!(
                        snapshot.state,
                        SqlExecutionState::Succeeded
                            | SqlExecutionState::Failed
                            | SqlExecutionState::TimedOut
                            | SqlExecutionState::Canceled
                            | SqlExecutionState::CancelFailed
                    ),
                    "execution reached {:?} before {:?}",
                    snapshot.state,
                    expected,
                );
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("managed execution reaches expected state")
    }

    async fn wait_for_cancel_calls(driver: &FakeManagedDriver, expected: usize) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while driver.cancel_calls.load(Ordering::SeqCst) != expected {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancel call count reached expected value");
    }

    async fn wait_for_raw_finish(driver: &FakeManagedDriver) {
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            driver.raw_finished.notified(),
        )
        .await
        .expect("Raw artifact reaches finished state");
    }

    fn start_managed(
        manager: &ConnectionRuntimeManager,
        profile_id: &str,
        tab_id: &str,
        request: StartSqlExecutionRequest,
    ) -> IpcResult<SqlExecutionHandle> {
        manager.start_sql_execution(profile_id, tab_id, request, Arc::new(RecordingSink))
    }

    #[tokio::test]
    async fn shared_managed_sql_uses_direct_executor_without_a_tab_runtime() {
        let driver = FakeManagedDriver::new("profile", true)
            .with_statement_class(SqlStatementClass::Mutation)
            .with_direct_access();
        let release = driver.release.clone();
        let calls = driver.execution_calls.clone();
        let manager = manager_with_managed_shared("profile", driver);
        let task = tokio::spawn(async move {
            manager
                .execute_shared_managed_sql(
                    "profile",
                    managed_request("ALTER TABLE events DELETE WHERE id = 1"),
                    SqlStatementClass::Mutation,
                )
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while calls.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("shared managed executor should be called");
        release.notify_one();

        let result = task
            .await
            .expect("shared managed task should join")
            .expect("shared managed SQL should succeed");
        assert!(!result.execution_id.is_empty());
        assert_eq!(result.statement_class, SqlStatementClass::Mutation);
        assert!(matches!(result.outcome, SqlExecutionOutcome::Rows { .. }));
        assert!(result.observation_warnings.is_empty());
    }

    #[tokio::test]
    async fn shared_managed_sql_rejects_non_direct_capability_before_dispatch() {
        let driver = FakeManagedDriver::new("profile", true);
        let calls = driver.execution_calls.clone();
        let manager = manager_with_managed_shared("profile", driver);

        let error = manager
            .execute_shared_managed_sql(
                "profile",
                managed_request("SELECT 1"),
                SqlStatementClass::Read,
            )
            .await
            .expect_err("read-only managed capability must not satisfy direct execution");
        assert_eq!(error.code, ErrorCode::FeatureUnavailable);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn managed_sql_uses_driver_classification_before_registering_snapshot() {
        let driver =
            FakeManagedDriver::new("profile", true).with_statement_class(SqlStatementClass::Ddl);
        let manager = manager_with_managed_tab("profile", "tab", driver);

        let handle = start_managed(
            &manager,
            "profile",
            "tab",
            managed_request("CREATE TABLE t (id UInt64) ENGINE=Memory"),
        )
        .expect("start classified managed execution");
        let snapshot = manager
            .get_sql_execution_snapshot("profile", "tab", &handle.execution_id)
            .expect("read classified starting snapshot");
        assert_eq!(snapshot.statement_class, SqlStatementClass::Ddl);
    }

    #[tokio::test]
    async fn managed_sql_start_returns_immediately_completes_and_releases_terminal_entry() {
        let driver = FakeManagedDriver::new("profile", true);
        let manager = manager_with_managed_tab("profile", "tab", driver.clone());

        let handle = start_managed(&manager, "profile", "tab", managed_request("SELECT 1"))
            .expect("start managed execution");
        assert_eq!(handle.state, SqlExecutionState::Starting);
        assert_eq!(
            manager
                .get_sql_execution_snapshot("other", "tab", &handle.execution_id)
                .expect_err("snapshot profile ownership is enforced")
                .code,
            ErrorCode::ResourceNotFound
        );
        assert_eq!(
            manager
                .release_sql_execution("other", "tab", &handle.execution_id)
                .expect_err("release profile ownership is enforced")
                .code,
            ErrorCode::ResourceNotFound
        );
        assert_eq!(
            manager
                .get_sql_execution_snapshot("profile", "tab", &handle.execution_id)
                .expect("starting snapshot")
                .state,
            SqlExecutionState::Starting
        );

        driver.release.notify_one();
        let terminal =
            wait_for_managed_terminal(&manager, "profile", "tab", &handle.execution_id).await;
        assert_eq!(terminal.state, SqlExecutionState::Succeeded);
        manager
            .release_sql_execution("profile", "tab", &handle.execution_id)
            .expect("release terminal execution");
        assert_eq!(
            manager
                .get_sql_execution_snapshot("profile", "tab", &handle.execution_id)
                .expect_err("released execution is absent")
                .code,
            ErrorCode::ResourceNotFound
        );
    }

    #[test]
    fn managed_sql_start_without_tokio_runtime_fails_before_registration() {
        let driver = FakeManagedDriver::new("profile", true);
        let execution_calls = driver.execution_calls.clone();
        let manager = manager_with_managed_tab("profile", "tab", driver);

        let error = start_managed(&manager, "profile", "tab", managed_request("SELECT 1"))
            .expect_err("a synchronous caller without a Tokio runtime must be rejected");

        assert_eq!(error.code, ErrorCode::SystemInternal);
        assert_eq!(error.runtime_impact, RuntimeErrorImpact::BusinessOnly);
        assert_eq!(manager.sql_executions.entry_count(), 0);
        assert_eq!(execution_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn managed_sql_rejects_missing_feature_and_profile_mismatch_before_driver_call() {
        let unsupported = FakeManagedDriver::new("profile", false);
        let manager = manager_with_managed_tab("profile", "tab", unsupported.clone());
        assert_eq!(
            start_managed(&manager, "profile", "tab", managed_request("SELECT 1"))
                .expect_err("missing feature is rejected")
                .code,
            ErrorCode::ResourceNotFound
        );
        assert_eq!(unsupported.execution_calls.load(Ordering::SeqCst), 0);

        let supported = FakeManagedDriver::new("profile", true);
        let manager = manager_with_managed_tab("profile", "tab", supported.clone());
        assert_eq!(
            start_managed(&manager, "other", "tab", managed_request("SELECT 1"))
                .expect_err("profile mismatch is rejected")
                .code,
            ErrorCode::ResourceNotFound
        );
        assert_eq!(supported.execution_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn managed_sql_rejects_raw_before_registration_when_capability_is_false() {
        let driver = FakeManagedDriver::new("profile", true).with_raw_result(false);
        let execution_calls = driver.execution_calls.clone();
        let manager = manager_with_managed_tab("profile", "tab", driver);

        let error = manager
            .start_sql_execution(
                "profile",
                "tab",
                managed_request_with_mode("SELECT 1 FORMAT CSV", SqlResultMode::Raw),
                Arc::new(RecordingSink),
            )
            .expect_err("Raw must fail before registration");

        assert_eq!(error.code, ErrorCode::ValidationFailed);
        assert_eq!(manager.sql_executions.entry_count(), 0);
        assert_eq!(execution_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn managed_sql_rejects_raw_pagination_before_registration() {
        let driver = FakeManagedDriver::new("profile", true).with_raw_result(true);
        let execution_calls = driver.execution_calls.clone();
        let manager = manager_with_managed_tab("profile", "tab", driver);
        let mut request = managed_request_with_mode("SELECT 1 FORMAT CSV", SqlResultMode::Raw);
        request.options.page = 2;

        let error = manager
            .start_sql_execution("profile", "tab", request, Arc::new(RecordingSink))
            .expect_err("Raw pagination must fail before registration");

        assert_eq!(error.code, ErrorCode::ValidationFailed);
        assert_eq!(manager.sql_executions.entry_count(), 0);
        assert_eq!(execution_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn raw_artifact_is_owned_saved_retried_and_released_with_terminal_execution() {
        let root = tempfile::tempdir().expect("artifact root");
        let destination_root = tempfile::tempdir().expect("destination root");
        let store = RawArtifactStore::for_test(
            root.path().to_path_buf(),
            RawArtifactLimits {
                max_bytes: 1_024,
                preview_bytes: 64,
                binary_preview_bytes: 32,
            },
        );
        let driver =
            FakeManagedDriver::with_result("profile", FakeManagedResult::Raw).with_raw_result(true);
        let manager =
            manager_with_managed_tab_and_store("profile", "tab", driver.clone(), store.clone());
        let handle = start_managed(
            &manager,
            "profile",
            "tab",
            managed_request_with_mode("SELECT 1 FORMAT CSV", SqlResultMode::Raw),
        )
        .expect("start Raw execution");

        wait_for_raw_finish(&driver).await;
        driver.release.notify_one();
        let terminal =
            wait_for_managed_terminal(&manager, "profile", "tab", &handle.execution_id).await;
        let artifact_id = match terminal.outcome.as_ref().expect("Raw outcome") {
            SqlExecutionOutcome::Raw { artifact_id, .. } => artifact_id.clone(),
            _ => panic!("Raw outcome expected"),
        };
        assert_eq!(store.entry_count_for_test(), 1);

        let destination = destination_root.path().join("result.csv");
        for (profile_id, tab_id, execution_id) in [
            ("other-profile", "tab", handle.execution_id.as_str()),
            ("profile", "other-tab", handle.execution_id.as_str()),
            ("profile", "tab", "other-execution"),
        ] {
            assert_eq!(
                manager
                    .save_sql_execution_artifact(
                        profile_id,
                        tab_id,
                        execution_id,
                        &artifact_id,
                        destination.clone(),
                    )
                    .await
                    .expect_err("artifact ownership mismatch must fail")
                    .code,
                ErrorCode::ResourceNotFound,
            );
        }
        assert_eq!(
            manager
                .save_sql_execution_artifact(
                    "profile",
                    "tab",
                    &handle.execution_id,
                    "wrong-artifact",
                    destination.clone(),
                )
                .await
                .expect_err("artifact mismatch must fail")
                .code,
            ErrorCode::ResourceNotFound,
        );
        assert!(!destination.exists());
        manager
            .save_sql_execution_artifact(
                "profile",
                "tab",
                &handle.execution_id,
                &artifact_id,
                destination.clone(),
            )
            .await
            .expect("save Raw artifact");
        assert_eq!(
            std::fs::read(destination).expect("saved bytes"),
            b"raw bytes"
        );

        manager
            .release_sql_execution("profile", "tab", &handle.execution_id)
            .expect("release Raw execution");
        assert_eq!(store.entry_count_for_test(), 0);
    }

    #[tokio::test]
    async fn new_execution_removes_the_previous_terminal_raw_artifact() {
        let root = tempfile::tempdir().expect("artifact root");
        let store = RawArtifactStore::for_test(
            root.path().to_path_buf(),
            RawArtifactLimits {
                max_bytes: 1_024,
                preview_bytes: 64,
                binary_preview_bytes: 32,
            },
        );
        let driver =
            FakeManagedDriver::with_result("profile", FakeManagedResult::Raw).with_raw_result(true);
        let manager =
            manager_with_managed_tab_and_store("profile", "tab", driver.clone(), store.clone());
        let raw = start_managed(
            &manager,
            "profile",
            "tab",
            managed_request_with_mode("SELECT 1 FORMAT CSV", SqlResultMode::Raw),
        )
        .expect("start Raw execution");
        wait_for_raw_finish(&driver).await;
        driver.release.notify_one();
        wait_for_managed_terminal(&manager, "profile", "tab", &raw.execution_id).await;
        assert_eq!(store.entry_count_for_test(), 1);

        let grid = start_managed(&manager, "profile", "tab", managed_request("SELECT 2"))
            .expect("replace terminal execution");
        assert_eq!(store.entry_count_for_test(), 0);
        driver.release.notify_one();
        wait_for_managed_terminal(&manager, "profile", "tab", &grid.execution_id).await;
        manager
            .release_sql_execution("profile", "tab", &grid.execution_id)
            .expect("release Grid execution");
    }

    #[tokio::test]
    async fn active_conflict_keeps_artifact_until_tab_cleanup_and_late_completion_stays_clean() {
        let root = tempfile::tempdir().expect("artifact root");
        let destination_root = tempfile::tempdir().expect("destination root");
        let store = RawArtifactStore::for_test(
            root.path().to_path_buf(),
            RawArtifactLimits {
                max_bytes: 1_024,
                preview_bytes: 64,
                binary_preview_bytes: 32,
            },
        );
        let driver =
            FakeManagedDriver::with_result("profile", FakeManagedResult::Raw).with_raw_result(true);
        let manager =
            manager_with_managed_tab_and_store("profile", "tab", driver.clone(), store.clone());
        let raw = start_managed(
            &manager,
            "profile",
            "tab",
            managed_request_with_mode("SELECT 1 FORMAT CSV", SqlResultMode::Raw),
        )
        .expect("start Raw execution");
        wait_for_raw_finish(&driver).await;
        assert_eq!(store.entry_count_for_test(), 1);

        let destination = destination_root.path().join("active.csv");
        assert_eq!(
            manager
                .save_sql_execution_artifact(
                    "profile",
                    "tab",
                    &raw.execution_id,
                    "opaque-unpublished-artifact",
                    destination.clone(),
                )
                .await
                .expect_err("active execution artifact cannot be saved")
                .code,
            ErrorCode::ResourceConflict,
        );
        assert!(!destination.exists());

        assert_eq!(
            start_managed(&manager, "profile", "tab", managed_request("SELECT 2"))
                .expect_err("active conflict")
                .code,
            ErrorCode::ResourceConflict,
        );
        assert_eq!(store.entry_count_for_test(), 1);

        manager
            .close_tab_runtime("tab")
            .await
            .expect("close Raw tab");
        assert_eq!(store.entry_count_for_test(), 0);
        assert_eq!(manager.sql_executions.entry_count(), 0);
        driver.release.notify_one();
        tokio::task::yield_now().await;
        assert_eq!(store.entry_count_for_test(), 0);
        assert_eq!(
            manager
                .get_sql_execution_snapshot("profile", "tab", &raw.execution_id)
                .expect_err("closed tab has no snapshot")
                .code,
            ErrorCode::ResourceNotFound,
        );
    }

    #[tokio::test]
    async fn disconnect_and_app_shutdown_remove_raw_execution_ownership() {
        let disconnect_root = tempfile::tempdir().expect("disconnect root");
        let disconnect_store = RawArtifactStore::for_test(
            disconnect_root.path().to_path_buf(),
            RawArtifactLimits {
                max_bytes: 1_024,
                preview_bytes: 64,
                binary_preview_bytes: 32,
            },
        );
        let disconnect_driver =
            FakeManagedDriver::with_result("profile", FakeManagedResult::Raw).with_raw_result(true);
        let disconnect_manager = manager_with_profile_and_tab_store(
            "profile",
            "tab",
            disconnect_driver,
            disconnect_store.clone(),
        );
        start_managed(
            &disconnect_manager,
            "profile",
            "tab",
            managed_request_with_mode("SELECT 1 FORMAT CSV", SqlResultMode::Raw),
        )
        .expect("start disconnect Raw execution");
        assert_eq!(disconnect_store.entry_count_for_test(), 1);
        disconnect_manager
            .disconnect_profile("profile")
            .await
            .expect("disconnect profile");
        assert_eq!(disconnect_store.entry_count_for_test(), 0);
        assert_eq!(disconnect_manager.sql_executions.entry_count(), 0);

        let shutdown_root = tempfile::tempdir().expect("shutdown root");
        let shutdown_store = RawArtifactStore::for_test(
            shutdown_root.path().to_path_buf(),
            RawArtifactLimits {
                max_bytes: 1_024,
                preview_bytes: 64,
                binary_preview_bytes: 32,
            },
        );
        let shutdown_driver =
            FakeManagedDriver::with_result("profile", FakeManagedResult::Raw).with_raw_result(true);
        let shutdown_manager = manager_with_managed_tab_and_store(
            "profile",
            "tab",
            shutdown_driver,
            shutdown_store.clone(),
        );
        start_managed(
            &shutdown_manager,
            "profile",
            "tab",
            managed_request_with_mode("SELECT 1 FORMAT CSV", SqlResultMode::Raw),
        )
        .expect("start shutdown Raw execution");
        shutdown_manager
            .shutdown_sql_execution_state()
            .expect("shutdown execution state");
        assert_eq!(shutdown_store.entry_count_for_test(), 0);
        assert_eq!(shutdown_manager.sql_executions.entry_count(), 0);
    }

    #[tokio::test]
    async fn managed_sql_rejects_second_active_start_without_second_driver_call() {
        let driver = FakeManagedDriver::new("profile", true);
        let manager = manager_with_managed_tab("profile", "tab", driver.clone());
        let first = start_managed(&manager, "profile", "tab", managed_request("SELECT 1"))
            .expect("start first execution");

        assert_eq!(
            start_managed(&manager, "profile", "tab", managed_request("SELECT 2"))
                .expect_err("second active execution is rejected")
                .code,
            ErrorCode::ResourceConflict
        );
        driver.release.notify_one();
        wait_for_managed_terminal(&manager, "profile", "tab", &first.execution_id).await;
        assert_eq!(driver.execution_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn managed_sql_validates_sql_timeout_and_paging_before_driver_call() {
        let driver = FakeManagedDriver::new("profile", true);
        let manager = manager_with_managed_tab("profile", "tab", driver.clone());

        let mut invalid = vec![
            managed_request("  "),
            managed_request("SELECT 1; SELECT 2"),
            managed_request("SELECT 1"),
            managed_request("SELECT 1"),
            managed_request("SELECT 1"),
        ];
        invalid[2].options.timeout_ms = Some(42);
        invalid[3].options.page = 0;
        invalid[4].options.page_size = 1_001;

        for request in invalid {
            assert_eq!(
                start_managed(&manager, "profile", "tab", request)
                    .expect_err("invalid managed request is rejected")
                    .code,
                ErrorCode::ValidationFailed
            );
        }
        assert_eq!(driver.execution_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn managed_sql_maps_driver_errors_without_unconfirmed_canceled_state() {
        for (result, expected) in [
            (FakeManagedResult::TimedOut, SqlExecutionState::TimedOut),
            (FakeManagedResult::Canceled, SqlExecutionState::Failed),
            (FakeManagedResult::Failed, SqlExecutionState::Failed),
        ] {
            let driver = FakeManagedDriver::with_result("profile", result);
            let manager = manager_with_managed_tab("profile", "tab", driver.clone());
            let handle = start_managed(&manager, "profile", "tab", managed_request("SELECT 1"))
                .expect("start managed execution");
            driver.release.notify_one();

            let terminal =
                wait_for_managed_terminal(&manager, "profile", "tab", &handle.execution_id).await;
            assert_eq!(terminal.state, expected);
        }
    }

    #[tokio::test]
    async fn managed_cancel_returns_canceling_then_requires_control_confirmation() {
        let driver = FakeManagedDriver::cancelable(
            "profile",
            false,
            Ok(SqlCancelConfirmation::Confirmed(
                "fake server confirmed cancellation".to_string(),
            )),
        );
        let manager = manager_with_managed_tab("profile", "tab", driver.clone());
        let handle = start_managed(
            &manager,
            "profile",
            "tab",
            managed_request("SELECT sleep(10)"),
        )
        .expect("start managed execution");
        wait_for_managed_state(
            &manager,
            "profile",
            "tab",
            &handle.execution_id,
            SqlExecutionState::Running,
        )
        .await;

        let canceling = manager
            .cancel_sql_execution("profile", "tab", &handle.execution_id)
            .await
            .expect("begin managed cancellation");
        assert_eq!(canceling.state, SqlExecutionState::Canceling);

        wait_for_cancel_calls(&driver, 1).await;
        driver.cancel_release.notify_one();
        let terminal =
            wait_for_managed_terminal(&manager, "profile", "tab", &handle.execution_id).await;
        assert_eq!(terminal.state, SqlExecutionState::Canceled);
        assert!(terminal.cancel_message.is_some());
    }

    #[tokio::test]
    async fn query_success_wins_before_cancel_confirmation() {
        let driver = FakeManagedDriver::cancelable(
            "profile",
            true,
            Ok(SqlCancelConfirmation::Confirmed(
                "late fake confirmation".to_string(),
            )),
        );
        let manager = manager_with_managed_tab("profile", "tab", driver.clone());
        let handle = start_managed(&manager, "profile", "tab", managed_request("SELECT 1"))
            .expect("start managed execution");
        wait_for_managed_state(
            &manager,
            "profile",
            "tab",
            &handle.execution_id,
            SqlExecutionState::Running,
        )
        .await;

        let canceling = manager
            .cancel_sql_execution("profile", "tab", &handle.execution_id)
            .await
            .expect("begin managed cancellation");
        assert_eq!(canceling.state, SqlExecutionState::Canceling);
        wait_for_cancel_calls(&driver, 1).await;

        driver.release.notify_one();
        let terminal =
            wait_for_managed_terminal(&manager, "profile", "tab", &handle.execution_id).await;
        assert_eq!(terminal.state, SqlExecutionState::Succeeded);

        driver.cancel_release.notify_one();
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            manager
                .get_sql_execution_snapshot("profile", "tab", &handle.execution_id)
                .expect("query-wins snapshot remains")
                .state,
            SqlExecutionState::Succeeded,
        );
    }

    #[tokio::test]
    async fn unconfirmed_cancel_is_cancel_failed_and_never_canceled() {
        let driver = FakeManagedDriver::cancelable(
            "profile",
            false,
            Ok(SqlCancelConfirmation::Failed(
                IpcError::validation_failed("fake cancel permission denied").into(),
            )),
        );
        let manager = manager_with_managed_tab("profile", "tab", driver.clone());
        let handle = start_managed(
            &manager,
            "profile",
            "tab",
            managed_request("SELECT sleep(10)"),
        )
        .expect("start managed execution");
        wait_for_managed_state(
            &manager,
            "profile",
            "tab",
            &handle.execution_id,
            SqlExecutionState::Running,
        )
        .await;

        let canceling = manager
            .cancel_sql_execution("profile", "tab", &handle.execution_id)
            .await
            .expect("begin managed cancellation");
        assert_eq!(canceling.state, SqlExecutionState::Canceling);
        wait_for_cancel_calls(&driver, 1).await;
        driver.cancel_release.notify_one();

        let terminal =
            wait_for_managed_terminal(&manager, "profile", "tab", &handle.execution_id).await;
        assert_eq!(terminal.state, SqlExecutionState::CancelFailed);
        assert_eq!(
            terminal.failure.expect("cancel failure").runtime_impact,
            RuntimeErrorImpact::BusinessOnly,
        );
    }

    #[tokio::test]
    async fn duplicate_cancel_reuses_snapshot_and_profile_or_terminal_mismatch_is_rejected() {
        let driver = FakeManagedDriver::cancelable(
            "profile",
            false,
            Ok(SqlCancelConfirmation::Confirmed("confirmed".to_string())),
        );
        let manager = manager_with_managed_tab("profile", "tab", driver.clone());
        let handle = start_managed(
            &manager,
            "profile",
            "tab",
            managed_request("SELECT sleep(10)"),
        )
        .expect("start managed execution");
        wait_for_managed_state(
            &manager,
            "profile",
            "tab",
            &handle.execution_id,
            SqlExecutionState::Running,
        )
        .await;

        assert_eq!(
            manager
                .cancel_sql_execution("other", "tab", &handle.execution_id)
                .await
                .expect_err("profile mismatch is rejected")
                .code,
            ErrorCode::ResourceNotFound,
        );
        let first = manager
            .cancel_sql_execution("profile", "tab", &handle.execution_id)
            .await
            .expect("first cancel");
        let duplicate = manager
            .cancel_sql_execution("profile", "tab", &handle.execution_id)
            .await
            .expect("duplicate cancel");
        assert_eq!(first.state, SqlExecutionState::Canceling);
        assert_eq!(duplicate.revision, first.revision);
        wait_for_cancel_calls(&driver, 1).await;

        driver.cancel_release.notify_one();
        let terminal =
            wait_for_managed_terminal(&manager, "profile", "tab", &handle.execution_id).await;
        assert_eq!(terminal.state, SqlExecutionState::Canceled);
        assert_eq!(
            manager
                .cancel_sql_execution("profile", "tab", &handle.execution_id)
                .await
                .expect_err("terminal cancel is rejected")
                .code,
            ErrorCode::ResourceConflict,
        );
    }

    #[tokio::test]
    async fn managed_sql_close_tab_discards_execution_before_driver_close() {
        let driver = FakeManagedDriver::new("profile", true);
        let manager = manager_with_managed_tab("profile", "tab", driver);
        let handle = start_managed(&manager, "profile", "tab", managed_request("SELECT 1"))
            .expect("start managed execution");

        manager
            .close_tab_runtime("tab")
            .await
            .expect("close tab runtime");

        assert_eq!(
            manager
                .get_sql_execution_snapshot("profile", "tab", &handle.execution_id)
                .expect_err("closed tab execution is absent")
                .code,
            ErrorCode::ResourceNotFound,
        );
    }

    #[tokio::test]
    async fn managed_sql_disconnect_discards_all_profile_executions() {
        let first = FakeManagedDriver::new("profile", true);
        let second = FakeManagedDriver::new("profile", true);
        let manager =
            manager_with_two_managed_tabs("profile", [("tab-1", first), ("tab-2", second)]);
        let first_handle = start_managed(&manager, "profile", "tab-1", managed_request("SELECT 1"))
            .expect("start first managed execution");
        let second_handle =
            start_managed(&manager, "profile", "tab-2", managed_request("SELECT 2"))
                .expect("start second managed execution");

        manager
            .disconnect_profile("profile")
            .await
            .expect("disconnect profile");

        for (tab_id, execution_id) in [
            ("tab-1", first_handle.execution_id),
            ("tab-2", second_handle.execution_id),
        ] {
            assert_eq!(
                manager
                    .get_sql_execution_snapshot("profile", tab_id, &execution_id)
                    .expect_err("disconnected profile execution is absent")
                    .code,
                ErrorCode::ResourceNotFound,
            );
        }
    }

    #[tokio::test]
    async fn clickhouse_tab_routes_browse_and_sql_then_closes_without_losing_shared_metadata() {
        let manager = ConnectionRuntimeManager::new();
        let shared_driver: Arc<dyn DatabaseDriver> =
            Arc::new(ClickHouseDriver::new_for_test("26.5.1.882"));
        let tab_driver: Arc<dyn DatabaseDriver> =
            Arc::new(ClickHouseDriver::new_for_test("26.5.1.882"));
        manager
            .shared
            .write()
            .expect("shared runtimes lock")
            .insert(
                "clickhouse-profile".to_string(),
                ProfileRuntime {
                    driver: shared_driver,
                    health: Arc::new(RwLock::new(RuntimeHealthSnapshot::healthy(
                        "clickhouse-profile",
                        now_unix_ms(),
                    ))),
                },
            );
        manager.tabs.write().expect("tab runtimes lock").insert(
            "clickhouse-tab".to_string(),
            TabRuntime {
                profile_id: "clickhouse-profile".to_string(),
                driver: tab_driver,
            },
        );

        let browse_driver = manager
            .driver_for_profile_or_tab(
                "clickhouse-profile",
                Some("clickhouse-tab"),
                "browse_table_data",
            )
            .expect("route ClickHouse table browsing");
        let sql_driver = manager
            .driver_for_profile_or_tab("clickhouse-profile", Some("clickhouse-tab"), "execute_sql")
            .expect("route ClickHouse SQL execution");
        assert!(Arc::ptr_eq(&browse_driver, &sql_driver));
        assert!(browse_driver.as_data_table_browser().is_some());
        assert!(sql_driver.as_sql_executor().is_some());

        manager
            .close_tab_runtime("clickhouse-tab")
            .await
            .expect("close ClickHouse tab runtime");
        let closed_tab = match manager.driver_for_profile_or_tab(
            "clickhouse-profile",
            Some("clickhouse-tab"),
            "execute_sql",
        ) {
            Ok(_) => panic!("closed tab must not remain routable"),
            Err(error) => error,
        };
        assert_eq!(closed_tab.code, ErrorCode::ResourceNotFound);
        assert!(manager
            .shared_driver("clickhouse-profile")
            .expect("shared metadata runtime remains connected")
            .as_schema_browser()
            .is_some());

        manager
            .disconnect_profile("clickhouse-profile")
            .await
            .expect("disconnect ClickHouse profile");
        let disconnected = match manager.shared_driver("clickhouse-profile") {
            Ok(_) => panic!("disconnected shared runtime must not remain routable"),
            Err(error) => error,
        };
        assert_eq!(disconnected.code, ErrorCode::ResourceNotFound);
    }

    #[test]
    fn disconnect_invalidates_and_signals_an_inflight_shared_connect() {
        let manager = ConnectionRuntimeManager::new();
        let (attempt_id, receiver) = manager
            .begin_shared_connect_attempt("profile-1")
            .expect("begin shared connect");

        assert!(manager
            .shared_connect_attempt_is_current("profile-1", attempt_id)
            .expect("read shared attempt"));
        assert!(manager
            .cancel_shared_connect_attempt("profile-1")
            .expect("cancel shared attempt"));
        assert!(*receiver.borrow());
        assert!(!manager
            .shared_connect_attempt_is_current("profile-1", attempt_id)
            .expect("read canceled shared attempt"));
    }

    #[test]
    fn newer_shared_connect_supersedes_and_signals_the_older_attempt() {
        let manager = ConnectionRuntimeManager::new();
        let (first_id, first_receiver) = manager
            .begin_shared_connect_attempt("profile-1")
            .expect("begin first shared connect");
        let (second_id, _) = manager
            .begin_shared_connect_attempt("profile-1")
            .expect("begin second shared connect");

        assert!(*first_receiver.borrow());
        assert_ne!(first_id, second_id);
        assert!(!manager
            .shared_connect_attempt_is_current("profile-1", first_id)
            .expect("read old shared attempt"));
        assert!(manager
            .shared_connect_attempt_is_current("profile-1", second_id)
            .expect("read new shared attempt"));
    }

    #[test]
    fn profile_disconnect_cancels_inflight_tab_connects_for_that_profile_only() {
        let manager = ConnectionRuntimeManager::new();
        let (_, profile_one_receiver) = manager
            .begin_tab_connect_attempt("profile-1", "tab-1")
            .expect("begin profile one tab connect");
        let (_, profile_two_receiver) = manager
            .begin_tab_connect_attempt("profile-2", "tab-2")
            .expect("begin profile two tab connect");

        assert_eq!(
            manager
                .cancel_tab_connect_attempts_for_profile("profile-1")
                .expect("cancel profile tab attempts"),
            1
        );
        assert!(*profile_one_receiver.borrow());
        assert!(!*profile_two_receiver.borrow());
    }
}

#[cfg(test)]
mod native_schema_tests {
    use super::*;

    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;

    use crate::engine::driver::DatabaseDriver;
    use crate::engine::drivers::clickhouse::schema::{
        ClickHouseAlterTableTarget, ClickHouseClusterDdlSupport, ClickHouseColumnActionResult,
        ClickHouseColumnDataActionTarget, ClickHouseCreateDatabaseResult,
        ClickHouseCreateDatabaseTarget, ClickHouseCreateEngineTarget, ClickHouseCreateTableResult,
        ClickHouseCreateTableTarget, ClickHouseDropDatabaseResult, ClickHouseDropDatabaseTarget,
        ClickHouseDropTableResult, ClickHouseDropTableTarget, ClickHouseEngineSchema,
        ClickHouseKeySchema, ClickHouseProjectionActionTarget, ClickHouseProjectionChangeResult,
        ClickHouseProjectionCreateTarget, ClickHouseProjectionTarget, ClickHouseSchemaBaseline,
        ClickHouseSchemaEditability, ClickHouseSkippingIndexActionTarget,
        ClickHouseSkippingIndexChangeResult, ClickHouseSkippingIndexCreateTarget,
        ClickHouseSkippingIndexTarget, ClickHouseTableAlterResult, ClickHouseTableIdentity,
        ClickHouseTableSchema, ClickHouseViewAddress, ClickHouseViewBaseline,
        ClickHouseViewColumnDefinition, ClickHouseViewCreateTarget, ClickHouseViewDefinitionTarget,
        ClickHouseViewDropTarget, ClickHouseViewFamily, ClickHouseViewFamilyDefinition,
        ClickHouseViewFamilySupport, ClickHouseViewIdentity, ClickHouseViewOperationSupport,
        ClickHouseViewRuntimeSupport, ClickHouseViewSchema, ClickHouseViewScope,
        ClickHouseViewScopeTarget, ClickHouseViewSecurity,
    };
    use crate::engine::native_schema::{
        NativeSchemaChangeBaseline, NativeSchemaChangePlan, NativeSchemaChangeResult,
        NativeSchemaChangeTarget, NativeSchemaConfirmationInput, NativeSchemaCreateResult,
        NativeSchemaCreateTarget, NativeSchemaDescribeRequest, NativeSchemaDocument,
        NativeSchemaExecuteChangeRequest, NativeSchemaExecuteCreateRequest,
        NativeSchemaExecutionStatus, NativeSchemaExtension, NativeSchemaMutationPreview,
        NativeSchemaOperationSummary, NativeSchemaRequiredConfirmation, NativeSchemaRiskFlag,
        NativeSchemaStatementProgress,
    };
    use crate::engine::types::{
        ContainerKind, DriverCapabilities, SchemaMutationFeatures, SchemaMutationObjectFeatures,
        SchemaMutationOperation,
    };
    use crate::error::ErrorCode;

    struct FakeNativeSchemaDriver {
        profile_id: String,
        exposes_extension: bool,
        capabilities: DriverCapabilities,
        schema: ClickHouseTableSchema,
        preview_calls: AtomicUsize,
        execute_calls: AtomicUsize,
        change_plan: NativeSchemaChangePlan,
        preview_change_calls: AtomicUsize,
        execute_change_calls: AtomicUsize,
    }

    impl FakeNativeSchemaDriver {
        fn new(profile_id: &str, exposes_extension: bool) -> Arc<Self> {
            Arc::new(Self {
                profile_id: profile_id.to_string(),
                exposes_extension,
                capabilities: DriverCapabilities::default(),
                schema: clickhouse_schema_fixture(),
                preview_calls: AtomicUsize::new(0),
                execute_calls: AtomicUsize::new(0),
                change_plan: safe_change_plan(),
                preview_change_calls: AtomicUsize::new(0),
                execute_change_calls: AtomicUsize::new(0),
            })
        }

        fn with_capabilities(
            profile_id: &str,
            exposes_extension: bool,
            capabilities: DriverCapabilities,
        ) -> Arc<Self> {
            Arc::new(Self {
                profile_id: profile_id.to_string(),
                exposes_extension,
                capabilities,
                schema: clickhouse_schema_fixture(),
                preview_calls: AtomicUsize::new(0),
                execute_calls: AtomicUsize::new(0),
                change_plan: safe_change_plan(),
                preview_change_calls: AtomicUsize::new(0),
                execute_change_calls: AtomicUsize::new(0),
            })
        }

        fn with_change_plan(
            profile_id: &str,
            capabilities: DriverCapabilities,
            change_plan: NativeSchemaChangePlan,
        ) -> Arc<Self> {
            Arc::new(Self {
                profile_id: profile_id.to_string(),
                exposes_extension: true,
                capabilities,
                schema: clickhouse_schema_fixture(),
                preview_calls: AtomicUsize::new(0),
                execute_calls: AtomicUsize::new(0),
                change_plan,
                preview_change_calls: AtomicUsize::new(0),
                execute_change_calls: AtomicUsize::new(0),
            })
        }
    }

    #[async_trait]
    impl DatabaseDriver for FakeNativeSchemaDriver {
        fn profile_id(&self) -> &str {
            &self.profile_id
        }

        fn driver_name(&self) -> &'static str {
            "fake-native-schema"
        }

        fn capabilities(&self) -> DriverCapabilities {
            self.capabilities.clone()
        }

        async fn ping(&self) -> IpcResult<PingResult> {
            Ok(PingResult { latency_ms: 0 })
        }

        async fn close(&self) -> IpcResult<()> {
            Ok(())
        }

        fn as_native_schema_extension(&self) -> Option<&dyn NativeSchemaExtension> {
            self.exposes_extension.then_some(self)
        }
    }

    #[async_trait]
    impl NativeSchemaExtension for FakeNativeSchemaDriver {
        async fn list_session_documents(
            &self,
            _request: &NativeSchemaSessionListRequest,
        ) -> IpcResult<NativeSchemaSessionDocuments> {
            Ok(NativeSchemaSessionDocuments::ClickHouseViews(Vec::new()))
        }

        async fn describe(
            &self,
            _request: &NativeSchemaDescribeRequest,
        ) -> IpcResult<NativeSchemaDocument> {
            Ok(NativeSchemaDocument::ClickHouseTable(Box::new(
                self.schema.clone(),
            )))
        }

        async fn preview_create(
            &self,
            _target: &NativeSchemaCreateTarget,
        ) -> IpcResult<NativeSchemaMutationPreview> {
            self.preview_calls.fetch_add(1, Ordering::SeqCst);
            Ok(NativeSchemaMutationPreview {
                statements: vec!["CREATE redacted".to_string()],
                warnings: Vec::new(),
                destructive: false,
                long_running: false,
                risk_flags: Vec::new(),
                required_confirmation: NativeSchemaRequiredConfirmation::None,
                plan_hash: "a".repeat(64),
                baseline: None,
            })
        }

        async fn execute_create(
            &self,
            request: &NativeSchemaExecuteCreateRequest,
        ) -> IpcResult<NativeSchemaCreateResult> {
            self.execute_calls.fetch_add(1, Ordering::SeqCst);
            match &request.target {
                NativeSchemaCreateTarget::ClickHouseDatabase(target) => Ok(
                    NativeSchemaCreateResult::ClickHouseDatabase(ClickHouseCreateDatabaseResult {
                        name: target.name.clone(),
                        container: ContainerRef::database(&target.name),
                    }),
                ),
                NativeSchemaCreateTarget::ClickHouseTable(target) => {
                    Ok(NativeSchemaCreateResult::ClickHouseTable(Box::new(
                        ClickHouseCreateTableResult {
                            container: ContainerRef::table(
                                ContainerKind::Table,
                                &target.database,
                                None,
                                &target.name,
                            ),
                            table_name: target.name.clone(),
                            schema: self.schema.clone(),
                        },
                    )))
                }
                NativeSchemaCreateTarget::ClickHouseView(_) => Err(IpcError::feature_unavailable(
                    "ClickHouse View schema capability is not published",
                )),
            }
        }

        async fn preview_change(
            &self,
            _target: &NativeSchemaChangeTarget,
        ) -> IpcResult<NativeSchemaChangePlan> {
            self.preview_change_calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.change_plan.clone())
        }

        async fn execute_change(
            &self,
            request: &NativeSchemaExecuteChangeRequest,
        ) -> IpcResult<NativeSchemaChangeResult> {
            self.execute_change_calls.fetch_add(1, Ordering::SeqCst);
            let progress = NativeSchemaStatementProgress {
                applied_count: 1,
                failed_statement_index: None,
                remaining_count: 0,
                query_ids: vec!["query-1".to_string()],
            };
            match &request.target {
                NativeSchemaChangeTarget::ClickHouseTableAlter(target) => {
                    Ok(NativeSchemaChangeResult::ClickHouseTableAlter(Box::new(
                        ClickHouseTableAlterResult {
                            status: NativeSchemaExecutionStatus::Applied,
                            progress,
                            container: table_container(),
                            table_name: target.desired.name.clone(),
                            schema: Some(self.schema.clone()),
                        },
                    )))
                }
                NativeSchemaChangeTarget::ClickHouseColumnClear(target)
                | NativeSchemaChangeTarget::ClickHouseColumnMaterialize(target) => {
                    Ok(NativeSchemaChangeResult::ClickHouseColumnAction(Box::new(
                        ClickHouseColumnActionResult {
                            status: NativeSchemaExecutionStatus::Submitted,
                            progress,
                            container: table_container(),
                            column_name: target.column_name.clone(),
                            operation: request.target.operation(),
                            schema: Some(self.schema.clone()),
                        },
                    )))
                }
                NativeSchemaChangeTarget::ClickHouseTableDrop(target) => Ok(
                    NativeSchemaChangeResult::ClickHouseTableDrop(ClickHouseDropTableResult {
                        status: NativeSchemaExecutionStatus::Applied,
                        progress,
                        container: target.container.clone(),
                        table_name: "events".to_string(),
                        absent: true,
                    }),
                ),
                NativeSchemaChangeTarget::ClickHouseDatabaseDrop(target) => {
                    Ok(NativeSchemaChangeResult::ClickHouseDatabaseDrop(
                        ClickHouseDropDatabaseResult {
                            status: NativeSchemaExecutionStatus::Applied,
                            progress,
                            container: target.container.clone(),
                            name: "analytics".to_string(),
                            absent: true,
                        },
                    ))
                }
                NativeSchemaChangeTarget::ClickHouseProjectionCreate(target) => {
                    Ok(NativeSchemaChangeResult::ClickHouseProjectionChange(
                        Box::new(ClickHouseProjectionChangeResult {
                            status: NativeSchemaExecutionStatus::Applied,
                            progress,
                            container: table_container(),
                            projection_name: target.projection.name.clone(),
                            operation: request.target.operation(),
                            schema: Some(self.schema.clone()),
                        }),
                    ))
                }
                NativeSchemaChangeTarget::ClickHouseProjectionDrop(target)
                | NativeSchemaChangeTarget::ClickHouseProjectionMaterialize(target)
                | NativeSchemaChangeTarget::ClickHouseProjectionClear(target) => {
                    Ok(NativeSchemaChangeResult::ClickHouseProjectionChange(
                        Box::new(ClickHouseProjectionChangeResult {
                            status: if request.target.operation() == SchemaMutationOperation::Drop {
                                NativeSchemaExecutionStatus::Applied
                            } else {
                                NativeSchemaExecutionStatus::Submitted
                            },
                            progress,
                            container: table_container(),
                            projection_name: target.projection_name.clone(),
                            operation: request.target.operation(),
                            schema: Some(self.schema.clone()),
                        }),
                    ))
                }
                NativeSchemaChangeTarget::ClickHouseSkippingIndexCreate(target) => {
                    Ok(NativeSchemaChangeResult::ClickHouseSkippingIndexChange(
                        Box::new(ClickHouseSkippingIndexChangeResult {
                            status: NativeSchemaExecutionStatus::Applied,
                            progress,
                            container: table_container(),
                            index_name: target.index.name.clone(),
                            operation: request.target.operation(),
                            schema: Some(self.schema.clone()),
                        }),
                    ))
                }
                NativeSchemaChangeTarget::ClickHouseSkippingIndexDrop(target)
                | NativeSchemaChangeTarget::ClickHouseSkippingIndexMaterialize(target)
                | NativeSchemaChangeTarget::ClickHouseSkippingIndexClear(target) => {
                    Ok(NativeSchemaChangeResult::ClickHouseSkippingIndexChange(
                        Box::new(ClickHouseSkippingIndexChangeResult {
                            status: if request.target.operation() == SchemaMutationOperation::Drop {
                                NativeSchemaExecutionStatus::Applied
                            } else {
                                NativeSchemaExecutionStatus::Submitted
                            },
                            progress,
                            container: table_container(),
                            index_name: target.index_name.clone(),
                            operation: request.target.operation(),
                            schema: Some(self.schema.clone()),
                        }),
                    ))
                }
                NativeSchemaChangeTarget::ClickHouseViewAlter(_)
                | NativeSchemaChangeTarget::ClickHouseViewRename(_)
                | NativeSchemaChangeTarget::ClickHouseViewDrop(_) => {
                    Err(IpcError::feature_unavailable(
                        "ClickHouse View schema capability is not published",
                    ))
                }
            }
        }
    }

    fn create_capabilities(
        kind: ContainerKind,
        operation: SchemaMutationOperation,
    ) -> DriverCapabilities {
        DriverCapabilities {
            schema_mutator: false,
            schema_mutation: Some(SchemaMutationFeatures::new(
                [SchemaMutationObjectFeatures::new(kind, [operation])],
                true,
                false,
                false,
            )),
            ..DriverCapabilities::default()
        }
    }

    fn change_capabilities(
        kind: ContainerKind,
        operation: SchemaMutationOperation,
        destructive_confirmation: bool,
        remote_drift_protection: bool,
    ) -> DriverCapabilities {
        DriverCapabilities {
            schema_mutator: false,
            schema_mutation: Some(SchemaMutationFeatures::new(
                [SchemaMutationObjectFeatures::new(kind, [operation])],
                true,
                destructive_confirmation,
                remote_drift_protection,
            )),
            ..DriverCapabilities::default()
        }
    }

    fn phase_five_b_capabilities() -> DriverCapabilities {
        DriverCapabilities {
            schema_mutator: false,
            schema_mutation: Some(SchemaMutationFeatures::new(
                [
                    SchemaMutationObjectFeatures::new(
                        ContainerKind::Database,
                        [SchemaMutationOperation::Create],
                    ),
                    SchemaMutationObjectFeatures::new(
                        ContainerKind::Table,
                        [SchemaMutationOperation::Create],
                    ),
                ],
                true,
                false,
                false,
            )),
            ..DriverCapabilities::default()
        }
    }

    fn phase_five_c_capabilities() -> DriverCapabilities {
        DriverCapabilities {
            schema_mutator: false,
            schema_mutation: Some(SchemaMutationFeatures::new(
                [
                    SchemaMutationObjectFeatures::new(
                        ContainerKind::Database,
                        [
                            SchemaMutationOperation::Create,
                            SchemaMutationOperation::Drop,
                        ],
                    ),
                    SchemaMutationObjectFeatures::new(
                        ContainerKind::Table,
                        [
                            SchemaMutationOperation::Create,
                            SchemaMutationOperation::Alter,
                            SchemaMutationOperation::Drop,
                        ],
                    ),
                    SchemaMutationObjectFeatures::new(
                        ContainerKind::Column,
                        [
                            SchemaMutationOperation::Clear,
                            SchemaMutationOperation::Materialize,
                        ],
                    ),
                ],
                true,
                true,
                true,
            )),
            ..DriverCapabilities::default()
        }
    }

    fn phase_five_d_capabilities() -> DriverCapabilities {
        let mut capabilities = phase_five_c_capabilities();
        capabilities
            .schema_mutation
            .as_mut()
            .expect("Phase 5C schema mutation fixture")
            .objects
            .extend([
                SchemaMutationObjectFeatures::new(
                    ContainerKind::Projection,
                    [
                        SchemaMutationOperation::Create,
                        SchemaMutationOperation::Drop,
                        SchemaMutationOperation::Clear,
                        SchemaMutationOperation::Materialize,
                    ],
                ),
                SchemaMutationObjectFeatures::new(
                    ContainerKind::Index,
                    [
                        SchemaMutationOperation::Create,
                        SchemaMutationOperation::Drop,
                        SchemaMutationOperation::Clear,
                        SchemaMutationOperation::Materialize,
                    ],
                ),
            ]);
        capabilities
    }

    fn safe_change_plan() -> NativeSchemaChangePlan {
        NativeSchemaChangePlan {
            statements: vec!["ALTER TABLE redacted MODIFY COMMENT 'safe'".to_string()],
            warnings: Vec::new(),
            destructive: false,
            long_running: false,
            risk_flags: Vec::new(),
            required_confirmation: NativeSchemaRequiredConfirmation::None,
            plan_hash: "b".repeat(64),
            expected_target_revision: Some("c".repeat(64)),
            operations: vec![NativeSchemaOperationSummary {
                code: "modify_table_comment".to_string(),
                object_name: "events".to_string(),
                destructive: false,
                long_running: false,
            }],
            baseline: NativeSchemaChangeBaseline::ClickHouseTable(Box::new(
                clickhouse_schema_fixture(),
            )),
        }
    }

    fn destructive_change_plan() -> NativeSchemaChangePlan {
        let mut plan = safe_change_plan();
        plan.destructive = true;
        plan.risk_flags = vec![NativeSchemaRiskFlag::Destructive];
        plan.required_confirmation = NativeSchemaRequiredConfirmation::Confirm;
        plan.operations[0].destructive = true;
        plan
    }

    fn table_container() -> ContainerRef {
        ContainerRef::table(ContainerKind::Table, "analytics", None, "events")
    }

    fn table_alter_target() -> NativeSchemaChangeTarget {
        NativeSchemaChangeTarget::ClickHouseTableAlter(Box::new(ClickHouseAlterTableTarget {
            baseline: clickhouse_schema_fixture(),
            desired: table_create_target(),
            column_renames: Vec::new(),
        }))
    }

    fn table_drop_target() -> NativeSchemaChangeTarget {
        NativeSchemaChangeTarget::ClickHouseTableDrop(ClickHouseDropTableTarget {
            container: table_container(),
        })
    }

    fn database_drop_target() -> NativeSchemaChangeTarget {
        NativeSchemaChangeTarget::ClickHouseDatabaseDrop(ClickHouseDropDatabaseTarget {
            container: ContainerRef::database("analytics"),
        })
    }

    fn column_target(operation: SchemaMutationOperation) -> NativeSchemaChangeTarget {
        let target = Box::new(ClickHouseColumnDataActionTarget {
            baseline: clickhouse_schema_fixture(),
            column_name: "id".to_string(),
        });
        match operation {
            SchemaMutationOperation::Clear => {
                NativeSchemaChangeTarget::ClickHouseColumnClear(target)
            }
            SchemaMutationOperation::Materialize => {
                NativeSchemaChangeTarget::ClickHouseColumnMaterialize(target)
            }
            _ => unreachable!(),
        }
    }

    fn phase_five_d_targets() -> Vec<NativeSchemaChangeTarget> {
        let baseline = clickhouse_schema_fixture();
        let projection_create = NativeSchemaChangeTarget::ClickHouseProjectionCreate(Box::new(
            ClickHouseProjectionCreateTarget {
                baseline: baseline.clone(),
                projection: ClickHouseProjectionTarget {
                    name: "by_tenant".to_string(),
                    query: "SELECT tenant_id ORDER BY tenant_id".to_string(),
                },
            },
        ));
        let projection_action = |operation| {
            let target = Box::new(ClickHouseProjectionActionTarget {
                baseline: baseline.clone(),
                projection_name: "by_tenant".to_string(),
            });
            match operation {
                SchemaMutationOperation::Drop => {
                    NativeSchemaChangeTarget::ClickHouseProjectionDrop(target)
                }
                SchemaMutationOperation::Clear => {
                    NativeSchemaChangeTarget::ClickHouseProjectionClear(target)
                }
                SchemaMutationOperation::Materialize => {
                    NativeSchemaChangeTarget::ClickHouseProjectionMaterialize(target)
                }
                _ => unreachable!(),
            }
        };
        let index_create = NativeSchemaChangeTarget::ClickHouseSkippingIndexCreate(Box::new(
            ClickHouseSkippingIndexCreateTarget {
                baseline: baseline.clone(),
                index: ClickHouseSkippingIndexTarget {
                    name: "tenant_minmax".to_string(),
                    expression: "tenant_id".to_string(),
                    index_type: "minmax".to_string(),
                    type_arguments: Vec::new(),
                    granularity: 1,
                },
            },
        ));
        let index_action = |operation| {
            let target = Box::new(ClickHouseSkippingIndexActionTarget {
                baseline: baseline.clone(),
                index_name: "tenant_minmax".to_string(),
            });
            match operation {
                SchemaMutationOperation::Drop => {
                    NativeSchemaChangeTarget::ClickHouseSkippingIndexDrop(target)
                }
                SchemaMutationOperation::Clear => {
                    NativeSchemaChangeTarget::ClickHouseSkippingIndexClear(target)
                }
                SchemaMutationOperation::Materialize => {
                    NativeSchemaChangeTarget::ClickHouseSkippingIndexMaterialize(target)
                }
                _ => unreachable!(),
            }
        };
        vec![
            projection_create,
            projection_action(SchemaMutationOperation::Drop),
            projection_action(SchemaMutationOperation::Materialize),
            projection_action(SchemaMutationOperation::Clear),
            index_create,
            index_action(SchemaMutationOperation::Drop),
            index_action(SchemaMutationOperation::Materialize),
            index_action(SchemaMutationOperation::Clear),
        ]
    }

    fn change_request(target: NativeSchemaChangeTarget) -> NativeSchemaExecuteChangeRequest {
        NativeSchemaExecuteChangeRequest {
            target,
            baseline: safe_change_plan().baseline,
            expected_plan_hash: "b".repeat(64),
            confirmation: Some(NativeSchemaConfirmationInput {
                accepted: true,
                object_name: None,
                cluster_name: None,
            }),
        }
    }

    fn table_create_target() -> ClickHouseCreateTableTarget {
        ClickHouseCreateTableTarget {
            database: "analytics".to_string(),
            name: "events".to_string(),
            columns: Vec::new(),
            engine: ClickHouseCreateEngineTarget {
                family: "MergeTree".to_string(),
                arguments: Vec::new(),
            },
            keys: ClickHouseKeySchema {
                order_by: "tuple()".to_string(),
                partition_by: None,
                primary_key: None,
                sample_by: None,
            },
            table_ttl: None,
            comment: None,
            settings: Vec::new(),
        }
    }

    fn clickhouse_schema_fixture() -> ClickHouseTableSchema {
        ClickHouseTableSchema {
            identity: ClickHouseTableIdentity {
                database: "analytics".to_string(),
                name: "events".to_string(),
                object_kind: ContainerKind::Table,
                uuid: None,
            },
            engine: ClickHouseEngineSchema {
                family: "MergeTree".to_string(),
                arguments: Vec::new(),
                raw_expression: "MergeTree".to_string(),
            },
            columns: Vec::new(),
            keys: ClickHouseKeySchema {
                order_by: "tuple()".to_string(),
                partition_by: None,
                primary_key: None,
                sample_by: None,
            },
            table_ttl: None,
            comment: None,
            settings: Vec::new(),
            projections: Vec::new(),
            skipping_indexes: Vec::new(),
            editability: ClickHouseSchemaEditability::editable(),
            baseline: ClickHouseSchemaBaseline {
                canonical_create_query:
                    "CREATE TABLE analytics.events ENGINE = MergeTree ORDER BY tuple()".to_string(),
                revision_hash: "0".repeat(64),
            },
        }
    }

    fn clickhouse_view_support_fixture() -> ClickHouseViewRuntimeSupport {
        let operation = ClickHouseViewOperationSupport {
            state: crate::engine::drivers::clickhouse::schema::ClickHouseSupportState::Supported,
            reason: None,
        };
        let family = ClickHouseViewFamilySupport {
            describe: operation.clone(),
            create: operation.clone(),
            alter: operation.clone(),
            rename: operation.clone(),
            drop: operation,
        };
        ClickHouseViewRuntimeSupport {
            server_version: "25.3.1".to_string(),
            database_engine: Some("Atomic".to_string()),
            normal: family.clone(),
            parameterized: family.clone(),
            temporary: family.clone(),
            materialized: family.clone(),
            refreshable_materialized: family.clone(),
            window: family.clone(),
            live: family,
            cluster_ddl: ClickHouseClusterDdlSupport {
                discoverable: false,
                executable: false,
                observable: false,
                drift_verifiable: false,
            },
            support_revision: "1".repeat(64),
        }
    }

    fn clickhouse_view_schema_fixture() -> ClickHouseViewSchema {
        ClickHouseViewSchema {
            identity: ClickHouseViewIdentity {
                address: ClickHouseViewAddress {
                    database: Some("analytics".to_string()),
                    name: "events_view".to_string(),
                    object_kind: ContainerKind::View,
                },
                uuid: None,
            },
            family: ClickHouseViewFamily::Normal,
            scope: ClickHouseViewScope::Local,
            columns: ClickHouseViewColumnDefinition::None,
            query: "SELECT 1".to_string(),
            security: ClickHouseViewSecurity {
                definer: None,
                sql_security: None,
            },
            comment: None,
            family_definition: ClickHouseViewFamilyDefinition::Normal,
            server_support: clickhouse_view_support_fixture(),
            editability: ClickHouseSchemaEditability::editable(),
            baseline: ClickHouseViewBaseline {
                canonical_create_query: "CREATE VIEW `analytics`.`events_view` AS SELECT 1"
                    .to_string(),
                revision_hash: "2".repeat(64),
                server_version: "25.3.1".to_string(),
                family: ClickHouseViewFamily::Normal,
                support_revision: "1".repeat(64),
            },
        }
    }

    fn clickhouse_view_create_target() -> NativeSchemaCreateTarget {
        NativeSchemaCreateTarget::ClickHouseView(Box::new(ClickHouseViewCreateTarget {
            desired: ClickHouseViewDefinitionTarget {
                address: ClickHouseViewAddress {
                    database: Some("analytics".to_string()),
                    name: "events_view".to_string(),
                    object_kind: ContainerKind::View,
                },
                family: ClickHouseViewFamily::Normal,
                scope: ClickHouseViewScopeTarget::Local,
                columns: ClickHouseViewColumnDefinition::None,
                query: "SELECT 1".to_string(),
                security: ClickHouseViewSecurity {
                    definer: None,
                    sql_security: None,
                },
                comment: None,
                family_definition: ClickHouseViewFamilyDefinition::Normal,
            },
            expected_support_revision: "1".repeat(64),
        }))
    }

    fn clickhouse_view_drop_target() -> NativeSchemaChangeTarget {
        NativeSchemaChangeTarget::ClickHouseViewDrop(Box::new(ClickHouseViewDropTarget {
            baseline: clickhouse_view_schema_fixture(),
            expected_support_revision: "1".repeat(64),
        }))
    }

    fn manager_with_native_driver(
        profile_id: &str,
        driver: Arc<FakeNativeSchemaDriver>,
    ) -> ConnectionRuntimeManager {
        let manager = ConnectionRuntimeManager::new();
        let driver: Arc<dyn DatabaseDriver> = driver;
        manager
            .shared
            .write()
            .expect("shared runtimes lock")
            .insert(
                profile_id.to_string(),
                ProfileRuntime {
                    driver,
                    health: Arc::new(RwLock::new(RuntimeHealthSnapshot::healthy(
                        profile_id,
                        now_unix_ms(),
                    ))),
                },
            );
        manager
    }

    fn manager_with_native_tab_driver(
        profile_id: &str,
        tab_id: &str,
        driver: Arc<FakeNativeSchemaDriver>,
    ) -> ConnectionRuntimeManager {
        let manager = ConnectionRuntimeManager::new();
        let driver: Arc<dyn DatabaseDriver> = driver;
        manager.tabs.write().expect("tab runtimes lock").insert(
            tab_id.to_string(),
            TabRuntime {
                profile_id: profile_id.to_string(),
                driver,
            },
        );
        manager
    }

    #[tokio::test]
    async fn native_schema_dispatch_returns_clickhouse_table_document() {
        let manager =
            manager_with_native_driver("profile-1", FakeNativeSchemaDriver::new("profile-1", true));

        let result = manager
            .describe_native_schema(
                "profile-1",
                NativeSchemaDescribeRequest::Table(ContainerRef::table(
                    ContainerKind::Table,
                    "analytics",
                    None,
                    "events",
                )),
            )
            .await
            .expect("native schema describe");

        let NativeSchemaDocument::ClickHouseTable(schema) = result else {
            panic!("native table Describe returned the wrong document variant");
        };
        assert_eq!(schema.identity.database, "analytics");
        assert_eq!(schema.identity.name, "events");
    }

    #[tokio::test]
    async fn native_schema_dispatch_rejects_driver_without_extension() {
        let manager = manager_with_native_driver(
            "profile-1",
            FakeNativeSchemaDriver::new("profile-1", false),
        );

        let error = manager
            .describe_native_schema(
                "profile-1",
                NativeSchemaDescribeRequest::Table(ContainerRef::table(
                    ContainerKind::Table,
                    "app",
                    None,
                    "users",
                )),
            )
            .await
            .expect_err("missing native extension must fail");

        assert_eq!(error.code, ErrorCode::ResourceNotFound);
    }

    #[tokio::test]
    async fn native_create_gate_rejects_closed_capability_before_extension_dispatch() {
        let driver = FakeNativeSchemaDriver::new("profile-1", true);
        let manager = manager_with_native_driver("profile-1", driver.clone());

        let error = manager
            .preview_native_schema_create(
                "profile-1",
                NativeSchemaCreateTarget::ClickHouseDatabase(ClickHouseCreateDatabaseTarget {
                    name: "scratch".to_string(),
                }),
            )
            .await
            .expect_err("closed capability must reject preview");

        assert_eq!(error.code, ErrorCode::ResourceNotFound);
        assert_eq!(driver.preview_calls.load(Ordering::SeqCst), 0);

        let error = manager
            .execute_native_schema_create(
                "profile-1",
                NativeSchemaExecuteCreateRequest {
                    target: NativeSchemaCreateTarget::ClickHouseDatabase(
                        ClickHouseCreateDatabaseTarget {
                            name: "scratch".to_string(),
                        },
                    ),
                    expected_plan_hash: "a".repeat(64),
                    confirmation: None,
                    baseline: None,
                },
            )
            .await
            .expect_err("closed capability must reject execute");

        assert_eq!(error.code, ErrorCode::ResourceNotFound);
        assert_eq!(driver.execute_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn phase_five_e_view_capability_stays_closed_before_extension_dispatch() {
        let driver = FakeNativeSchemaDriver::new("profile-view-closed", true);
        let manager = manager_with_native_driver("profile-view-closed", driver.clone());
        let create = clickhouse_view_create_target();

        let error = manager
            .preview_native_schema_create("profile-view-closed", create.clone())
            .await
            .expect_err("View create preview must stay capability-closed");
        assert_eq!(error.code, ErrorCode::ResourceNotFound);
        assert_eq!(driver.preview_calls.load(Ordering::SeqCst), 0);

        let error = manager
            .execute_native_schema_create(
                "profile-view-closed",
                NativeSchemaExecuteCreateRequest {
                    target: create,
                    expected_plan_hash: "a".repeat(64),
                    confirmation: None,
                    baseline: None,
                },
            )
            .await
            .expect_err("View create execute must stay capability-closed");
        assert_eq!(error.code, ErrorCode::ResourceNotFound);
        assert_eq!(driver.execute_calls.load(Ordering::SeqCst), 0);

        let change = clickhouse_view_drop_target();
        let error = manager
            .preview_native_schema_change("profile-view-closed", change.clone())
            .await
            .expect_err("View change preview must stay capability-closed");
        assert_eq!(error.code, ErrorCode::ResourceNotFound);
        assert_eq!(driver.preview_change_calls.load(Ordering::SeqCst), 0);

        let error = manager
            .execute_native_schema_change(
                "profile-view-closed",
                NativeSchemaExecuteChangeRequest {
                    target: change,
                    baseline: NativeSchemaChangeBaseline::ClickHouseView(Box::new(
                        clickhouse_view_schema_fixture(),
                    )),
                    expected_plan_hash: "b".repeat(64),
                    confirmation: None,
                },
            )
            .await
            .expect_err("View change execute must stay capability-closed");
        assert_eq!(error.code, ErrorCode::ResourceNotFound);
        assert_eq!(driver.execute_change_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn native_create_dispatches_exact_advertised_variants_without_schema_mutator() {
        let capabilities = DriverCapabilities {
            schema_mutator: false,
            schema_mutation: Some(SchemaMutationFeatures::new(
                [
                    SchemaMutationObjectFeatures::new(
                        ContainerKind::Database,
                        [SchemaMutationOperation::Create],
                    ),
                    SchemaMutationObjectFeatures::new(
                        ContainerKind::Table,
                        [SchemaMutationOperation::Create],
                    ),
                ],
                true,
                false,
                false,
            )),
            ..DriverCapabilities::default()
        };
        let driver = FakeNativeSchemaDriver::with_capabilities("profile-1", true, capabilities);
        assert!(!driver.capabilities().schema_mutator);
        let manager = manager_with_native_driver("profile-1", driver.clone());

        let preview = manager
            .preview_native_schema_create(
                "profile-1",
                NativeSchemaCreateTarget::ClickHouseDatabase(ClickHouseCreateDatabaseTarget {
                    name: "scratch".to_string(),
                }),
            )
            .await
            .expect("database preview dispatch");
        assert_eq!(preview.plan_hash, "a".repeat(64));
        assert_eq!(driver.preview_calls.load(Ordering::SeqCst), 1);

        let result = manager
            .execute_native_schema_create(
                "profile-1",
                NativeSchemaExecuteCreateRequest {
                    target: NativeSchemaCreateTarget::ClickHouseTable(Box::new(
                        table_create_target(),
                    )),
                    expected_plan_hash: "a".repeat(64),
                    confirmation: None,
                    baseline: None,
                },
            )
            .await
            .expect("table execute dispatch");
        assert!(matches!(
            result,
            NativeSchemaCreateResult::ClickHouseTable(_)
        ));
        assert_eq!(driver.execute_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn native_create_rejects_wrong_operation_or_missing_extension_before_dispatch() {
        let alter_only = FakeNativeSchemaDriver::with_capabilities(
            "alter-only",
            true,
            create_capabilities(ContainerKind::Table, SchemaMutationOperation::Alter),
        );
        let manager = manager_with_native_driver("alter-only", alter_only.clone());
        let error = manager
            .preview_native_schema_create(
                "alter-only",
                NativeSchemaCreateTarget::ClickHouseTable(Box::new(table_create_target())),
            )
            .await
            .expect_err("table alter must not authorize table create");
        assert_eq!(error.code, ErrorCode::ResourceNotFound);
        assert_eq!(alter_only.preview_calls.load(Ordering::SeqCst), 0);

        let missing_extension = FakeNativeSchemaDriver::with_capabilities(
            "missing-extension",
            false,
            create_capabilities(ContainerKind::Database, SchemaMutationOperation::Create),
        );
        let manager = manager_with_native_driver("missing-extension", missing_extension.clone());
        let error = manager
            .preview_native_schema_create(
                "missing-extension",
                NativeSchemaCreateTarget::ClickHouseDatabase(ClickHouseCreateDatabaseTarget {
                    name: "scratch".to_string(),
                }),
            )
            .await
            .expect_err("advertised operation still requires native extension");
        assert_eq!(error.code, ErrorCode::ResourceNotFound);
        assert_eq!(missing_extension.preview_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn phase_five_b_capability_rejects_all_phase_five_c_changes_before_dispatch() {
        for (index, target) in [
            table_alter_target(),
            table_drop_target(),
            database_drop_target(),
            column_target(SchemaMutationOperation::Clear),
            column_target(SchemaMutationOperation::Materialize),
        ]
        .into_iter()
        .enumerate()
        {
            let profile_id = format!("phase-five-b-{index}");
            let driver = FakeNativeSchemaDriver::with_capabilities(
                &profile_id,
                true,
                phase_five_b_capabilities(),
            );
            let manager = manager_with_native_driver(&profile_id, driver.clone());

            let preview_error = manager
                .preview_native_schema_change(&profile_id, target.clone())
                .await
                .expect_err("Phase 5B must reject Phase 5C preview");
            assert_eq!(preview_error.code, ErrorCode::ResourceNotFound);

            let execute_error = manager
                .execute_native_schema_change(&profile_id, change_request(target))
                .await
                .expect_err("Phase 5B must reject Phase 5C execute");
            assert_eq!(execute_error.code, ErrorCode::ResourceNotFound);
            assert_eq!(driver.preview_change_calls.load(Ordering::SeqCst), 0);
            assert_eq!(driver.execute_change_calls.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn phase_five_d_targets_require_exact_capabilities() {
        let targets = phase_five_d_targets();
        let phase_five_c = phase_five_c_capabilities();
        let published_mutation = phase_five_c
            .schema_mutation
            .as_ref()
            .expect("Phase 5C schema mutation capability");
        assert_eq!(published_mutation.objects.len(), 3);
        for kind in [ContainerKind::Projection, ContainerKind::Index] {
            for operation in [
                SchemaMutationOperation::Create,
                SchemaMutationOperation::Drop,
                SchemaMutationOperation::Clear,
                SchemaMutationOperation::Materialize,
            ] {
                assert!(!published_mutation.supports(kind.clone(), operation));
            }
        }
        for (index, target) in targets.iter().cloned().enumerate() {
            assert!(target.requires_remote_drift_protection());
            let profile_id = format!("phase-five-c-{index}");
            let driver = FakeNativeSchemaDriver::with_capabilities(
                &profile_id,
                true,
                phase_five_c_capabilities(),
            );
            assert!(!driver.capabilities().schema_mutator);
            let manager = manager_with_native_driver(&profile_id, driver.clone());

            assert_eq!(
                manager
                    .preview_native_schema_change(&profile_id, target.clone())
                    .await
                    .unwrap_err()
                    .code,
                ErrorCode::ResourceNotFound
            );
            assert_eq!(
                manager
                    .execute_native_schema_change(&profile_id, change_request(target))
                    .await
                    .unwrap_err()
                    .code,
                ErrorCode::ResourceNotFound
            );
            assert_eq!(driver.preview_change_calls.load(Ordering::SeqCst), 0);
            assert_eq!(driver.execute_change_calls.load(Ordering::SeqCst), 0);
        }

        for (index, target) in targets.iter().cloned().enumerate() {
            let profile_id = format!("phase-five-d-published-{index}");
            let driver = FakeNativeSchemaDriver::with_capabilities(
                &profile_id,
                true,
                phase_five_d_capabilities(),
            );
            assert!(!driver.capabilities().schema_mutator);
            let manager = manager_with_native_driver(&profile_id, driver.clone());
            manager
                .preview_native_schema_change(&profile_id, target)
                .await
                .expect("published Phase 5D matrix must dispatch every exact target");
            assert_eq!(driver.preview_change_calls.load(Ordering::SeqCst), 1);
        }

        for (index, target) in targets.iter().cloned().enumerate() {
            let profile_id = format!("phase-five-d-exact-{index}");
            let driver = FakeNativeSchemaDriver::with_capabilities(
                &profile_id,
                true,
                change_capabilities(target.object_kind(), target.operation(), true, true),
            );
            assert!(!driver.capabilities().schema_mutator);
            let manager = manager_with_native_driver(&profile_id, driver.clone());

            manager
                .preview_native_schema_change(&profile_id, target.clone())
                .await
                .expect("exact object operation must dispatch");
            let sibling = targets
                .iter()
                .find(|candidate| {
                    candidate.object_kind() == target.object_kind()
                        && candidate.operation() != target.operation()
                })
                .expect("same-object sibling operation")
                .clone();
            assert_eq!(
                manager
                    .preview_native_schema_change(&profile_id, sibling)
                    .await
                    .unwrap_err()
                    .code,
                ErrorCode::ResourceNotFound
            );
            assert_eq!(driver.preview_change_calls.load(Ordering::SeqCst), 1);
        }

        let create_target = targets[0].clone();
        let driver = FakeNativeSchemaDriver::with_change_plan(
            "phase-five-d-execute",
            change_capabilities(
                create_target.object_kind(),
                create_target.operation(),
                true,
                true,
            ),
            safe_change_plan(),
        );
        let manager = manager_with_native_driver("phase-five-d-execute", driver.clone());
        let result = manager
            .execute_native_schema_change("phase-five-d-execute", change_request(create_target))
            .await
            .expect("explicit native capability must work without SchemaMutator");
        assert!(matches!(
            result,
            NativeSchemaChangeResult::ClickHouseProjectionChange(_)
        ));
        assert_eq!(driver.preview_change_calls.load(Ordering::SeqCst), 1);
        assert_eq!(driver.execute_change_calls.load(Ordering::SeqCst), 1);

        let no_drift_target = targets[4].clone();
        let driver = FakeNativeSchemaDriver::with_capabilities(
            "phase-five-d-no-drift",
            true,
            change_capabilities(
                no_drift_target.object_kind(),
                no_drift_target.operation(),
                true,
                false,
            ),
        );
        let manager = manager_with_native_driver("phase-five-d-no-drift", driver.clone());
        assert_eq!(
            manager
                .preview_native_schema_change("phase-five-d-no-drift", no_drift_target)
                .await
                .unwrap_err()
                .code,
            ErrorCode::ResourceNotFound
        );
        assert_eq!(driver.preview_change_calls.load(Ordering::SeqCst), 0);

        let destructive_target = targets[1].clone();
        let driver = FakeNativeSchemaDriver::with_change_plan(
            "phase-five-d-no-confirmation",
            change_capabilities(
                destructive_target.object_kind(),
                destructive_target.operation(),
                false,
                true,
            ),
            destructive_change_plan(),
        );
        let manager = manager_with_native_driver("phase-five-d-no-confirmation", driver.clone());
        assert_eq!(
            manager
                .preview_native_schema_change(
                    "phase-five-d-no-confirmation",
                    destructive_target.clone(),
                )
                .await
                .unwrap_err()
                .code,
            ErrorCode::ResourceNotFound
        );
        assert_eq!(
            manager
                .execute_native_schema_change(
                    "phase-five-d-no-confirmation",
                    change_request(destructive_target),
                )
                .await
                .unwrap_err()
                .code,
            ErrorCode::ResourceNotFound
        );
        assert_eq!(driver.preview_change_calls.load(Ordering::SeqCst), 2);
        assert_eq!(driver.execute_change_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn native_change_gate_requires_exact_object_operation_before_dispatch() {
        for (index, (target, advertised)) in [
            (
                table_alter_target(),
                (ContainerKind::Table, SchemaMutationOperation::Drop),
            ),
            (
                table_drop_target(),
                (ContainerKind::Table, SchemaMutationOperation::Alter),
            ),
            (
                database_drop_target(),
                (ContainerKind::Database, SchemaMutationOperation::Create),
            ),
            (
                column_target(SchemaMutationOperation::Clear),
                (ContainerKind::Column, SchemaMutationOperation::Materialize),
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let profile_id = format!("mismatch-{index}");
            let driver = FakeNativeSchemaDriver::with_capabilities(
                &profile_id,
                true,
                change_capabilities(advertised.0, advertised.1, true, true),
            );
            let manager = manager_with_native_driver(&profile_id, driver.clone());
            let error = manager
                .preview_native_schema_change(&profile_id, target)
                .await
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::ResourceNotFound);
            assert_eq!(driver.preview_change_calls.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn manager_rejects_plans_without_required_protection_capabilities() {
        let no_drift = FakeNativeSchemaDriver::with_change_plan(
            "no-drift",
            change_capabilities(
                ContainerKind::Table,
                SchemaMutationOperation::Alter,
                true,
                false,
            ),
            safe_change_plan(),
        );
        let manager = manager_with_native_driver("no-drift", no_drift.clone());
        let error = manager
            .preview_native_schema_change("no-drift", table_alter_target())
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceNotFound);
        assert_eq!(no_drift.preview_change_calls.load(Ordering::SeqCst), 0);

        let no_confirmation = FakeNativeSchemaDriver::with_change_plan(
            "no-confirmation",
            change_capabilities(
                ContainerKind::Table,
                SchemaMutationOperation::Alter,
                false,
                true,
            ),
            destructive_change_plan(),
        );
        let manager = manager_with_native_driver("no-confirmation", no_confirmation.clone());
        let error = manager
            .preview_native_schema_change("no-confirmation", table_alter_target())
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceNotFound);
        assert_eq!(
            no_confirmation.preview_change_calls.load(Ordering::SeqCst),
            1
        );
        assert_eq!(
            no_confirmation.execute_change_calls.load(Ordering::SeqCst),
            0
        );
    }

    #[tokio::test]
    async fn native_change_execute_repeats_preview_and_protection_gate_before_dispatch() {
        let driver = FakeNativeSchemaDriver::with_change_plan(
            "execute-no-confirmation",
            change_capabilities(
                ContainerKind::Table,
                SchemaMutationOperation::Alter,
                false,
                true,
            ),
            destructive_change_plan(),
        );
        let manager = manager_with_native_driver("execute-no-confirmation", driver.clone());
        let error = manager
            .execute_native_schema_change(
                "execute-no-confirmation",
                change_request(table_alter_target()),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceNotFound);
        assert_eq!(driver.preview_change_calls.load(Ordering::SeqCst), 1);
        assert_eq!(driver.execute_change_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn native_change_dispatches_exact_advertised_operation_without_schema_mutator() {
        let driver = FakeNativeSchemaDriver::with_change_plan(
            "table-alter",
            change_capabilities(
                ContainerKind::Table,
                SchemaMutationOperation::Alter,
                true,
                true,
            ),
            safe_change_plan(),
        );
        assert!(!driver.capabilities().schema_mutator);
        let manager = manager_with_native_driver("table-alter", driver.clone());

        let plan = manager
            .preview_native_schema_change("table-alter", table_alter_target())
            .await
            .expect("preview native alter");
        assert_eq!(plan.plan_hash, "b".repeat(64));

        let result = manager
            .execute_native_schema_change("table-alter", change_request(table_alter_target()))
            .await
            .expect("execute native alter");
        assert!(matches!(
            result,
            NativeSchemaChangeResult::ClickHouseTableAlter(_)
        ));
        assert_eq!(driver.preview_change_calls.load(Ordering::SeqCst), 2);
        assert_eq!(driver.execute_change_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn native_schema_runtime_routes_only_to_the_matching_profile_and_owner_tab() {
        let driver = FakeNativeSchemaDriver::with_change_plan(
            "temporary-owner",
            change_capabilities(
                ContainerKind::View,
                SchemaMutationOperation::Alter,
                true,
                true,
            ),
            safe_change_plan(),
        );
        let manager = manager_with_native_tab_driver("profile-a", "tab-a", driver);

        let documents = manager
            .list_native_schema_session_documents(
                "profile-a",
                "tab-a",
                NativeSchemaSessionListRequest::ClickHouseTemporaryViews,
            )
            .await
            .expect("route owner session documents");
        assert!(matches!(
            documents,
            NativeSchemaSessionDocuments::ClickHouseViews(ref views) if views.is_empty()
        ));
        assert_eq!(
            manager
                .list_native_schema_session_documents(
                    "wrong-profile",
                    "tab-a",
                    NativeSchemaSessionListRequest::ClickHouseTemporaryViews,
                )
                .await
                .unwrap_err()
                .code,
            ErrorCode::ResourceNotFound
        );
        assert_eq!(
            manager
                .list_native_schema_session_documents(
                    "profile-a",
                    "missing-tab",
                    NativeSchemaSessionListRequest::ClickHouseTemporaryViews,
                )
                .await
                .unwrap_err()
                .code,
            ErrorCode::ResourceNotFound
        );
    }
}
