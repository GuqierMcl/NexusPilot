use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use clickhouse::Client;
use serde::Deserialize;

use crate::engine::manager::ConnectionRuntimeManager;
use crate::engine::sql_execution::SqlExecutionEventSink;
use crate::engine::types::{
    RuntimeHealthStatus, SqlExecutionContext, SqlExecutionEvent, SqlExecutionOptions,
    SqlExecutionSnapshot, SqlExecutionState, SqlResultMode, SqlStatementClass, SqlSummarySource,
    StartSqlExecutionRequest,
};
use crate::error::{ErrorCode, RuntimeErrorImpact};
use crate::repository::connection_repository::StoredConnectionRecord;

const PHASE_FOUR_TAB_ID: &str = "real-clickhouse-phase-four-tab";
const PHASE_FOUR_PROFILE_CLEANUP_TAB_ID: &str = "real-clickhouse-phase-four-profile-cleanup-tab";
const LONG_QUERY_ROWS: u64 = 50;
const TIMEOUT_QUERY_ROWS: u64 = 200;
const START_RETURN_LIMIT: Duration = Duration::from_secs(1);
const OBSERVATION_WAIT: Duration = Duration::from_secs(8);
const CANCEL_TERMINAL_WAIT: Duration = Duration::from_secs(12);
const TIMEOUT_TERMINAL_WAIT: Duration = Duration::from_secs(40);
const SNAPSHOT_POLL: Duration = Duration::from_millis(50);

fn phase_four_long_query_sql(rows: u64) -> String {
    format!("SELECT sleepEachRow(0.2) FROM numbers({rows}) SETTINGS max_block_size = 1")
}

#[derive(Default)]
struct RecordingExecutionSink {
    snapshots: Mutex<Vec<SqlExecutionSnapshot>>,
}

impl RecordingExecutionSink {
    fn snapshots(&self) -> Vec<SqlExecutionSnapshot> {
        self.snapshots.lock().expect("execution sink lock").clone()
    }
}

impl SqlExecutionEventSink for RecordingExecutionSink {
    fn publish(&self, event: SqlExecutionEvent) -> Result<(), String> {
        let SqlExecutionEvent::Snapshot { snapshot } = event;
        self.snapshots
            .lock()
            .map_err(|_| "Phase 4A execution sink lock poisoned".to_string())?
            .push(snapshot);
        Ok(())
    }
}

fn managed_request(
    database: &str,
    sql: String,
    timeout_ms: Option<u64>,
) -> StartSqlExecutionRequest {
    StartSqlExecutionRequest {
        context: SqlExecutionContext {
            database: Some(database.to_string()),
            schema: None,
        },
        sql,
        options: SqlExecutionOptions {
            result_mode: SqlResultMode::Grid,
            timeout_ms,
            page: 1,
            page_size: 100,
        },
    }
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

async fn wait_for_terminal(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    tab_id: &str,
    execution_id: &str,
    deadline: Duration,
) -> Result<SqlExecutionSnapshot, String> {
    tokio::time::timeout(deadline, async {
        loop {
            let snapshot = manager
                .get_sql_execution_snapshot(profile_id, tab_id, execution_id)
                .map_err(|error| error.message)?;
            if is_terminal(snapshot.state) {
                return Ok(snapshot);
            }
            tokio::time::sleep(SNAPSHOT_POLL).await;
        }
    })
    .await
    .map_err(|_| "Phase 4A execution did not reach a terminal state".to_string())?
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProgressEvidence {
    Live,
    Unavailable,
}

async fn wait_for_progress_evidence(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    execution_id: &str,
) -> Result<ProgressEvidence, String> {
    tokio::time::timeout(OBSERVATION_WAIT, async {
        loop {
            let snapshot = manager
                .get_sql_execution_snapshot(profile_id, PHASE_FOUR_TAB_ID, execution_id)
                .map_err(|error| error.message)?;
            if snapshot.progress_available {
                let summary = snapshot
                    .summary
                    .as_ref()
                    .ok_or_else(|| "live progress did not carry a summary".to_string())?;
                if !matches!(
                    summary.source,
                    SqlSummarySource::LivePoll | SqlSummarySource::Merged
                ) {
                    return Err("live progress used an unexpected summary source".to_string());
                }
                return Ok(ProgressEvidence::Live);
            }
            if !snapshot.observation_warnings.is_empty() {
                return Ok(ProgressEvidence::Unavailable);
            }
            if is_terminal(snapshot.state) {
                return Err(format!(
                    "managed query became terminal before progress or unavailable evidence: state={:?}; code={:?}; message={:?}; details={:?}; warnings={}; summary_present={}; outcome_present={}",
                    snapshot.state,
                    snapshot.failure.as_ref().map(|failure| failure.code),
                    snapshot
                        .failure
                        .as_ref()
                        .map(|failure| failure.message.as_str()),
                    snapshot
                        .failure
                        .as_ref()
                        .and_then(|failure| failure.details.as_deref()),
                    snapshot.observation_warnings.len(),
                    snapshot.summary.is_some(),
                    snapshot.outcome.is_some(),
                ));
            }
            tokio::time::sleep(SNAPSHOT_POLL).await;
        }
    })
    .await
    .map_err(|_| "no progress or unavailable evidence arrived within 8 seconds".to_string())?
}

#[derive(clickhouse::Row, Deserialize)]
struct ActiveQueryCount {
    active_count: u64,
}

async fn active_query_count(client: &Client, query_id: &str) -> Result<u64, String> {
    client
        .query("SELECT count() AS active_count FROM system.processes WHERE query_id = ?")
        .bind(query_id)
        .fetch_one::<ActiveQueryCount>()
        .await
        .map(|row| row.active_count)
        .map_err(|_| "ClickHouse active query lookup failed".to_string())
}

async fn wait_for_query_absent(client: &Client, query_id: &str) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if active_query_count(client, query_id).await? == 0 {
                return Ok(());
            }
            tokio::time::sleep(SNAPSHOT_POLL).await;
        }
    })
    .await
    .map_err(|_| "confirmed query remained in system.processes".to_string())?
}

struct ConfirmedCancelEvidence {
    execution_id: String,
}

async fn verify_confirmed_cancel(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    client: &Client,
    database: &str,
) -> Result<ConfirmedCancelEvidence, String> {
    let sink = Arc::new(RecordingExecutionSink::default());
    let started = Instant::now();
    let handle = manager
        .start_sql_execution(
            profile_id,
            PHASE_FOUR_TAB_ID,
            managed_request(
                database,
                phase_four_long_query_sql(LONG_QUERY_ROWS),
                Some(30_000),
            ),
            sink.clone(),
        )
        .map_err(|error| error.message)?;

    if started.elapsed() >= START_RETURN_LIMIT {
        return Err("managed start did not return within one second".to_string());
    }
    if handle.state != SqlExecutionState::Starting {
        return Err("managed start handle was not starting".to_string());
    }
    if !backend_id_is_uuid_v4(&handle.execution_id)
        || !backend_id_is_uuid_v4(&handle.query_id)
        || handle.execution_id == handle.query_id
    {
        return Err("managed execution/query IDs were not distinct UUID v4 values".to_string());
    }

    let progress = wait_for_progress_evidence(manager, profile_id, &handle.execution_id).await?;
    let canceling = manager
        .cancel_sql_execution(profile_id, PHASE_FOUR_TAB_ID, &handle.execution_id)
        .await
        .map_err(|error| error.message)?;
    if canceling.state != SqlExecutionState::Canceling {
        return Err("cancel IPC did not return canceling".to_string());
    }

    let terminal = wait_for_terminal(
        manager,
        profile_id,
        PHASE_FOUR_TAB_ID,
        &handle.execution_id,
        CANCEL_TERMINAL_WAIT,
    )
    .await?;
    if terminal.state != SqlExecutionState::Canceled
        || terminal.cancel_message.is_none()
        || terminal.failure.is_some()
        || terminal.statement_class != SqlStatementClass::Read
    {
        return Err("ClickHouse did not produce a confirmed canceled snapshot".to_string());
    }

    let events = sink.snapshots();
    if !events
        .iter()
        .any(|snapshot| snapshot.state == SqlExecutionState::Running)
        || !events
            .iter()
            .any(|snapshot| snapshot.state == SqlExecutionState::Canceling)
        || !events
            .iter()
            .any(|snapshot| snapshot.state == SqlExecutionState::Canceled)
        || !events
            .windows(2)
            .all(|pair| pair[0].revision < pair[1].revision)
    {
        return Err("managed Channel evidence was missing or non-monotonic".to_string());
    }

    match progress {
        ProgressEvidence::Live => {
            wait_for_query_absent(client, &handle.query_id).await?;
            eprintln!("ClickHouse Phase 4A progress evidence observed");
        }
        ProgressEvidence::Unavailable => {
            eprintln!(
                "ClickHouse Phase 4A progress unavailable evidence observed; confirmed cancel remains mandatory"
            );
        }
    }

    Ok(ConfirmedCancelEvidence {
        execution_id: handle.execution_id,
    })
}

async fn verify_operation_timeout(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    client: &Client,
    database: &str,
) -> Result<String, String> {
    let sink = Arc::new(RecordingExecutionSink::default());
    let handle = manager
        .start_sql_execution(
            profile_id,
            PHASE_FOUR_TAB_ID,
            managed_request(
                database,
                phase_four_long_query_sql(TIMEOUT_QUERY_ROWS),
                Some(30_000),
            ),
            sink,
        )
        .map_err(|error| error.message)?;
    let terminal = wait_for_terminal(
        manager,
        profile_id,
        PHASE_FOUR_TAB_ID,
        &handle.execution_id,
        TIMEOUT_TERMINAL_WAIT,
    )
    .await?;
    let failure = terminal
        .failure
        .as_ref()
        .ok_or_else(|| "timed out execution did not carry failure context".to_string())?;
    if failure.code == ErrorCode::NetworkTimeout {
        return Err("operation timeout was reported as NETWORK_TIMEOUT".to_string());
    }
    if terminal.state != SqlExecutionState::TimedOut
        || failure.code != ErrorCode::OperationTimeout
        || failure.runtime_impact != RuntimeErrorImpact::BusinessOnly
        || terminal.outcome.is_some()
    {
        return Err("operation timeout was not timedOut/businessOnly".to_string());
    }

    if terminal.progress_available {
        wait_for_query_absent(client, &handle.query_id).await?;
    } else if !terminal.observation_warnings.is_empty() {
        eprintln!("ClickHouse Phase 4A timeout cleanup produced bounded unavailable evidence");
    }
    Ok(handle.execution_id)
}

async fn verify_post_operation_health(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
) -> Result<(), String> {
    manager
        .ping(profile_id)
        .await
        .map_err(|error| error.message)?;
    let health = manager.health(profile_id).map_err(|error| error.message)?;
    if health.status != RuntimeHealthStatus::Healthy
        || health.consecutive_failures != 0
        || health.last_error_code.is_some()
    {
        return Err("cancel/timeout changed ClickHouse runtime health".to_string());
    }
    Ok(())
}

async fn verify_tab_cleanup(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    tab_id: &str,
    execution_id: &str,
) -> Result<(), String> {
    manager
        .close_tab_runtime(tab_id)
        .await
        .map_err(|error| error.message)?;
    let error = manager
        .get_sql_execution_snapshot(profile_id, tab_id, execution_id)
        .expect_err("closed tab must discard timeout snapshot ownership");
    if error.code != ErrorCode::ResourceNotFound {
        return Err("closed tab retained SQL execution ownership".to_string());
    }
    Ok(())
}

async fn prepare_profile_cleanup_execution(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    record: &StoredConnectionRecord,
    database: &str,
) -> Result<PhaseFourProfileCleanupEvidence, String> {
    manager
        .open_tab_runtime(profile_id, PHASE_FOUR_PROFILE_CLEANUP_TAB_ID, record)
        .await
        .map_err(|error| error.message)?;
    let handle = manager
        .start_sql_execution(
            profile_id,
            PHASE_FOUR_PROFILE_CLEANUP_TAB_ID,
            managed_request(database, phase_four_long_query_sql(1), Some(30_000)),
            Arc::new(RecordingExecutionSink::default()),
        )
        .map_err(|error| error.message)?;
    let terminal = wait_for_terminal(
        manager,
        profile_id,
        PHASE_FOUR_PROFILE_CLEANUP_TAB_ID,
        &handle.execution_id,
        CANCEL_TERMINAL_WAIT,
    )
    .await?;
    if terminal.state != SqlExecutionState::Succeeded {
        return Err("profile cleanup probe did not complete successfully".to_string());
    }
    Ok(PhaseFourProfileCleanupEvidence {
        tab_id: PHASE_FOUR_PROFILE_CLEANUP_TAB_ID.to_string(),
        execution_id: handle.execution_id,
    })
}

pub(super) fn assert_profile_cleanup(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    evidence: &PhaseFourProfileCleanupEvidence,
) {
    let error = manager
        .get_sql_execution_snapshot(profile_id, &evidence.tab_id, &evidence.execution_id)
        .expect_err("profile disconnect must discard SQL execution ownership");
    assert_eq!(error.code, ErrorCode::ResourceNotFound);
}

pub(super) struct PhaseFourProfileCleanupEvidence {
    pub(super) tab_id: String,
    pub(super) execution_id: String,
}

pub(super) async fn run(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    record: &StoredConnectionRecord,
    client: &Client,
    database: &str,
) -> Result<PhaseFourProfileCleanupEvidence, String> {
    manager
        .open_tab_runtime(profile_id, PHASE_FOUR_TAB_ID, record)
        .await
        .map_err(|error| error.message)?;
    let cancel = verify_confirmed_cancel(manager, profile_id, client, database).await?;
    manager
        .release_sql_execution(profile_id, PHASE_FOUR_TAB_ID, &cancel.execution_id)
        .map_err(|error| error.message)?;
    let timeout_execution_id =
        verify_operation_timeout(manager, profile_id, client, database).await?;
    verify_post_operation_health(manager, profile_id).await?;
    verify_tab_cleanup(
        manager,
        profile_id,
        PHASE_FOUR_TAB_ID,
        &timeout_execution_id,
    )
    .await?;
    prepare_profile_cleanup_execution(manager, profile_id, record, database).await
}

fn backend_id_is_uuid_v4(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .ok()
        .and_then(|id| id.get_version())
        .is_some_and(|version| version == uuid::Version::Random)
}

#[cfg(test)]
mod tests {
    use super::{backend_id_is_uuid_v4, phase_four_long_query_sql};

    #[test]
    fn phase_four_long_query_and_backend_ids_are_bounded_and_safe() {
        assert_eq!(
            phase_four_long_query_sql(5),
            "SELECT sleepEachRow(0.2) FROM numbers(5) SETTINGS max_block_size = 1",
        );
        assert!(backend_id_is_uuid_v4(&uuid::Uuid::new_v4().to_string(),));
        assert!(!backend_id_is_uuid_v4("nexpilot_it_phase4_cancel_fake"));
        assert!(!backend_id_is_uuid_v4("SELECT 1"));
    }
}
