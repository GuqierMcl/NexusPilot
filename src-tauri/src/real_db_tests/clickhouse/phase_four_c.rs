use std::sync::Arc;
use std::time::Duration;

use clickhouse::Client;
use serde::Deserialize;

use crate::engine::manager::ConnectionRuntimeManager;
use crate::engine::sql_execution::artifact::{RawArtifactLimits, RawArtifactStore};
use crate::engine::sql_execution::SqlExecutionEventSink;
use crate::engine::types::{
    SqlExecutionContext, SqlExecutionEvent, SqlExecutionHandle, SqlExecutionOptions,
    SqlExecutionOutcome, SqlExecutionSnapshot, SqlExecutionState, SqlResultMode,
    StartSqlExecutionRequest,
};
use crate::error::ErrorCode;
use crate::repository::connection_repository::StoredConnectionRecord;

const PHASE_FOUR_C_TAB_ID: &str = "real-clickhouse-phase-four-c-tab";
const PHASE_FOUR_C_LIMIT_TAB_ID: &str = "real-clickhouse-phase-four-c-limit-tab";
const PHASE_FOUR_C_CANCEL_TAB_ID: &str = "real-clickhouse-phase-four-c-cancel-tab";
const PHASE_FOUR_C_PROFILE_TAB_ID: &str = "real-clickhouse-phase-four-c-profile-tab";
const PHASE_FOUR_C_APP_TAB_ID: &str = "real-clickhouse-phase-four-c-app-tab";
const TERMINAL_WAIT: Duration = Duration::from_secs(45);
const OBSERVATION_WAIT: Duration = Duration::from_secs(8);
const CLEANUP_WAIT: Duration = Duration::from_secs(5);
const SNAPSHOT_POLL: Duration = Duration::from_millis(50);

pub(super) const PHASE_FOUR_C_MARKER: &str =
    "ClickHouse Phase 4C real HTTP checkpoint passed: raw-format/text-binary-preview/artifact-save/limit/cancel/release/tab-profile-app-cleanup";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ExpectedRawPresentation {
    format: &'static str,
    media_type: &'static str,
    binary_preview: bool,
}

fn expected_raw_presentations() -> [ExpectedRawPresentation; 3] {
    [
        ExpectedRawPresentation {
            format: "CSVWithNames",
            media_type: "text/csv",
            binary_preview: false,
        },
        ExpectedRawPresentation {
            format: "JSONEachRow",
            media_type: "application/json",
            binary_preview: false,
        },
        ExpectedRawPresentation {
            format: "Parquet",
            media_type: "application/vnd.apache.parquet",
            binary_preview: true,
        },
    ]
}

fn expected_presentation(format: &str) -> ExpectedRawPresentation {
    expected_raw_presentations()
        .into_iter()
        .find(|presentation| presentation.format == format)
        .expect("Phase 4C format presentation fixture")
}

fn small_artifact_limits() -> RawArtifactLimits {
    RawArtifactLimits {
        max_bytes: 64,
        preview_bytes: 32,
        binary_preview_bytes: 8,
    }
}

struct DiscardingExecutionSink;

impl SqlExecutionEventSink for DiscardingExecutionSink {
    fn publish(&self, _event: SqlExecutionEvent) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Debug)]
struct RawArtifactEvidence {
    execution_id: String,
    artifact_id: String,
}

fn raw_request(database: &str, sql: String) -> StartSqlExecutionRequest {
    StartSqlExecutionRequest {
        context: SqlExecutionContext {
            database: Some(database.to_string()),
            schema: None,
        },
        sql,
        options: SqlExecutionOptions {
            result_mode: SqlResultMode::Raw,
            timeout_ms: Some(30_000),
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

fn start_raw_execution(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    tab_id: &str,
    database: &str,
    sql: String,
) -> Result<SqlExecutionHandle, String> {
    manager
        .start_sql_execution(
            profile_id,
            tab_id,
            raw_request(database, sql),
            Arc::new(DiscardingExecutionSink),
        )
        .map_err(|error| format!("Phase 4C Raw start failed with code {:?}", error.code))
}

async fn wait_for_terminal(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    tab_id: &str,
    execution_id: &str,
) -> Result<SqlExecutionSnapshot, String> {
    tokio::time::timeout(TERMINAL_WAIT, async {
        loop {
            let snapshot = manager
                .get_sql_execution_snapshot(profile_id, tab_id, execution_id)
                .map_err(|_| "Phase 4C execution snapshot lookup failed".to_string())?;
            if is_terminal(snapshot.state) {
                return Ok(snapshot);
            }
            tokio::time::sleep(SNAPSHOT_POLL).await;
        }
    })
    .await
    .map_err(|_| "Phase 4C execution did not reach a terminal state".to_string())?
}

async fn execute_raw_terminal(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    tab_id: &str,
    database: &str,
    sql: String,
) -> Result<SqlExecutionSnapshot, String> {
    let handle = start_raw_execution(manager, profile_id, tab_id, database, sql)?;
    wait_for_terminal(manager, profile_id, tab_id, &handle.execution_id).await
}

fn expect_raw_artifact(
    snapshot: &SqlExecutionSnapshot,
    expected: ExpectedRawPresentation,
) -> Result<RawArtifactEvidence, String> {
    if snapshot.state != SqlExecutionState::Succeeded || snapshot.failure.is_some() {
        return Err("Phase 4C Raw execution did not succeed".to_string());
    }
    let SqlExecutionOutcome::Raw {
        format,
        media_type,
        byte_length,
        preview,
        artifact_id,
        ..
    } = snapshot
        .outcome
        .as_ref()
        .ok_or_else(|| "Phase 4C Raw execution did not return an outcome".to_string())?
    else {
        return Err("Phase 4C execution did not return a Raw artifact".to_string());
    };
    if format.as_deref() != Some(expected.format)
        || media_type != expected.media_type
        || *byte_length == 0
        || preview.is_empty()
        || artifact_id.is_empty()
    {
        return Err("Phase 4C Raw artifact metadata was incorrect".to_string());
    }
    if expected.binary_preview != preview.starts_with("[hex] ") {
        return Err("Phase 4C Raw preview mode was incorrect".to_string());
    }
    if uuid::Uuid::parse_str(artifact_id).is_err() {
        return Err("Phase 4C Raw artifact ID was not opaque".to_string());
    }
    Ok(RawArtifactEvidence {
        execution_id: snapshot.execution_id.clone(),
        artifact_id: artifact_id.clone(),
    })
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

fn artifact_directory_is_empty(root: &tempfile::TempDir) -> Result<bool, String> {
    std::fs::read_dir(root.path())
        .map(|mut entries| entries.next().is_none())
        .map_err(|_| "Phase 4C artifact fixture could not be inspected".to_string())
}

async fn connect_and_open(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    tab_id: &str,
    record: &StoredConnectionRecord,
) -> Result<(), String> {
    manager
        .connect_profile(profile_id, record)
        .await
        .map_err(|_| "Phase 4C shared runtime did not connect".to_string())?;
    manager
        .open_tab_runtime(profile_id, tab_id, record)
        .await
        .map_err(|_| "Phase 4C tab runtime did not open".to_string())?;
    Ok(())
}

async fn close_and_disconnect(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    tab_id: &str,
) -> Result<(), String> {
    manager
        .close_tab_runtime(tab_id)
        .await
        .map_err(|_| "Phase 4C tab runtime cleanup failed".to_string())?;
    manager
        .disconnect_profile(profile_id)
        .await
        .map_err(|_| "Phase 4C shared runtime cleanup failed".to_string())
}

async fn verify_runtime_ping(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
) -> Result<(), String> {
    manager
        .ping(profile_id)
        .await
        .map(|_| ())
        .map_err(|_| "Phase 4C runtime ping failed after a bounded operation".to_string())
}

async fn wait_for_store_empty(store: &RawArtifactStore) -> Result<(), String> {
    tokio::time::timeout(CLEANUP_WAIT, async {
        loop {
            if store.entry_count_for_test() == 0 {
                return;
            }
            tokio::time::sleep(SNAPSHOT_POLL).await;
        }
    })
    .await
    .map_err(|_| "Phase 4C Raw artifact ownership was not cleaned up".to_string())
}

async fn verify_formats_save_retry_and_release(
    profile_id: &str,
    record: &StoredConnectionRecord,
    database: &str,
) -> Result<(), String> {
    let artifact_root = tempfile::tempdir()
        .map_err(|_| "Phase 4C artifact fixture could not be created".to_string())?;
    let store = RawArtifactStore::for_test(
        artifact_root.path().to_path_buf(),
        RawArtifactLimits::default(),
    );
    let manager = ConnectionRuntimeManager::with_raw_artifact_store_for_test(store.clone());
    connect_and_open(&manager, profile_id, PHASE_FOUR_C_TAB_ID, record).await?;

    let csv = execute_raw_terminal(
        &manager,
        profile_id,
        PHASE_FOUR_C_TAB_ID,
        database,
        "SELECT 'nexpilot-phase4c' AS marker FORMAT CSVWithNames".to_string(),
    )
    .await?;
    let csv_evidence = expect_raw_artifact(&csv, expected_presentation("CSVWithNames"))?;
    if !matches!(
        csv.outcome.as_ref(),
        Some(SqlExecutionOutcome::Raw { preview, .. }) if preview.contains("nexpilot-phase4c")
    ) {
        return Err("Phase 4C CSV preview did not contain the known result".to_string());
    }

    let destinations = tempfile::tempdir()
        .map_err(|_| "Phase 4C save fixture could not be created".to_string())?;
    let first = destinations.path().join("first.csv");
    let second = destinations.path().join("second.csv");
    manager
        .save_sql_execution_artifact(
            profile_id,
            PHASE_FOUR_C_TAB_ID,
            &csv_evidence.execution_id,
            &csv_evidence.artifact_id,
            first.clone(),
        )
        .await
        .map_err(|_| "Phase 4C first artifact save failed".to_string())?;
    manager
        .save_sql_execution_artifact(
            profile_id,
            PHASE_FOUR_C_TAB_ID,
            &csv_evidence.execution_id,
            &csv_evidence.artifact_id,
            second.clone(),
        )
        .await
        .map_err(|_| "Phase 4C retry artifact save failed".to_string())?;
    let first_bytes = std::fs::read(&first)
        .map_err(|_| "Phase 4C first saved artifact was unreadable".to_string())?;
    let second_bytes = std::fs::read(&second)
        .map_err(|_| "Phase 4C second saved artifact was unreadable".to_string())?;
    if first_bytes.is_empty()
        || first_bytes != second_bytes
        || !contains_bytes(&first_bytes, b"nexpilot-phase4c")
        || store.entry_count_for_test() != 1
    {
        return Err("Phase 4C saved artifact bytes were incorrect".to_string());
    }
    manager
        .release_sql_execution(profile_id, PHASE_FOUR_C_TAB_ID, &csv_evidence.execution_id)
        .map_err(|_| "Phase 4C Raw execution release failed".to_string())?;
    let released = manager
        .save_sql_execution_artifact(
            profile_id,
            PHASE_FOUR_C_TAB_ID,
            &csv_evidence.execution_id,
            &csv_evidence.artifact_id,
            destinations.path().join("released.csv"),
        )
        .await
        .expect_err("released Phase 4C artifact must not be saveable");
    if released.code != ErrorCode::ResourceNotFound || store.entry_count_for_test() != 0 {
        return Err("Phase 4C released artifact retained ownership".to_string());
    }

    let json = execute_raw_terminal(
        &manager,
        profile_id,
        PHASE_FOUR_C_TAB_ID,
        database,
        "SELECT 42 AS answer FORMAT JSONEachRow".to_string(),
    )
    .await?;
    let json_evidence = expect_raw_artifact(&json, expected_presentation("JSONEachRow"))?;
    if !matches!(
        json.outcome.as_ref(),
        Some(SqlExecutionOutcome::Raw { preview, .. })
            if preview.contains("answer") && preview.contains("42")
    ) {
        return Err("Phase 4C JSON preview did not contain the known result".to_string());
    }
    manager
        .release_sql_execution(profile_id, PHASE_FOUR_C_TAB_ID, &json_evidence.execution_id)
        .map_err(|_| "Phase 4C JSON execution release failed".to_string())?;

    let parquet = execute_raw_terminal(
        &manager,
        profile_id,
        PHASE_FOUR_C_TAB_ID,
        database,
        "SELECT 42 AS answer FORMAT Parquet".to_string(),
    )
    .await?;
    let parquet_evidence = expect_raw_artifact(&parquet, expected_presentation("Parquet"))?;
    manager
        .release_sql_execution(
            profile_id,
            PHASE_FOUR_C_TAB_ID,
            &parquet_evidence.execution_id,
        )
        .map_err(|_| "Phase 4C Parquet execution release failed".to_string())?;
    if store.entry_count_for_test() != 0 {
        return Err("Phase 4C format probes retained Raw artifacts".to_string());
    }
    close_and_disconnect(&manager, profile_id, PHASE_FOUR_C_TAB_ID).await
}

async fn verify_artifact_limit(
    profile_id: &str,
    record: &StoredConnectionRecord,
    database: &str,
) -> Result<(), String> {
    let artifact_root = tempfile::tempdir()
        .map_err(|_| "Phase 4C limit fixture could not be created".to_string())?;
    let store =
        RawArtifactStore::for_test(artifact_root.path().to_path_buf(), small_artifact_limits());
    let manager = ConnectionRuntimeManager::with_raw_artifact_store_for_test(store.clone());
    connect_and_open(&manager, profile_id, PHASE_FOUR_C_LIMIT_TAB_ID, record).await?;
    let terminal = execute_raw_terminal(
        &manager,
        profile_id,
        PHASE_FOUR_C_LIMIT_TAB_ID,
        database,
        "SELECT number FROM numbers(100) FORMAT CSV".to_string(),
    )
    .await?;
    if terminal.state != SqlExecutionState::Failed
        || terminal.outcome.is_some()
        || terminal.failure.as_ref().map(|failure| failure.code)
            != Some(ErrorCode::ValidationFailed)
    {
        return Err("Phase 4C Raw size limit did not fail safely".to_string());
    }
    wait_for_store_empty(&store).await?;
    if !artifact_directory_is_empty(&artifact_root)? {
        return Err("Phase 4C Raw size limit retained a partial file".to_string());
    }
    verify_runtime_ping(&manager, profile_id).await?;
    manager
        .release_sql_execution(
            profile_id,
            PHASE_FOUR_C_LIMIT_TAB_ID,
            &terminal.execution_id,
        )
        .map_err(|_| "Phase 4C limit execution release failed".to_string())?;
    close_and_disconnect(&manager, profile_id, PHASE_FOUR_C_LIMIT_TAB_ID).await
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
        .map_err(|_| "Phase 4C active query lookup failed".to_string())
}

async fn wait_for_active_query(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    client: &Client,
    handle: &SqlExecutionHandle,
) -> Result<(), String> {
    tokio::time::timeout(OBSERVATION_WAIT, async {
        loop {
            let snapshot = manager
                .get_sql_execution_snapshot(
                    profile_id,
                    PHASE_FOUR_C_CANCEL_TAB_ID,
                    &handle.execution_id,
                )
                .map_err(|_| "Phase 4C cancel snapshot lookup failed".to_string())?;
            if is_terminal(snapshot.state) {
                return Err("Phase 4C cancel query ended before observation".to_string());
            }
            if snapshot.state == SqlExecutionState::Running
                && active_query_count(client, &handle.query_id).await? > 0
            {
                return Ok(());
            }
            tokio::time::sleep(SNAPSHOT_POLL).await;
        }
    })
    .await
    .map_err(|_| "Phase 4C cancel query did not become observable".to_string())?
}

async fn wait_for_query_absent(client: &Client, query_id: &str) -> Result<(), String> {
    tokio::time::timeout(CLEANUP_WAIT, async {
        loop {
            if active_query_count(client, query_id).await? == 0 {
                return Ok(());
            }
            tokio::time::sleep(SNAPSHOT_POLL).await;
        }
    })
    .await
    .map_err(|_| "Phase 4C canceled query remained active".to_string())?
}

async fn verify_cancel_cleanup(
    profile_id: &str,
    record: &StoredConnectionRecord,
    client: &Client,
    database: &str,
) -> Result<(), String> {
    let artifact_root = tempfile::tempdir()
        .map_err(|_| "Phase 4C cancel fixture could not be created".to_string())?;
    let store = RawArtifactStore::for_test(
        artifact_root.path().to_path_buf(),
        RawArtifactLimits::default(),
    );
    let manager = ConnectionRuntimeManager::with_raw_artifact_store_for_test(store.clone());
    connect_and_open(&manager, profile_id, PHASE_FOUR_C_CANCEL_TAB_ID, record).await?;
    let handle = start_raw_execution(
        &manager,
        profile_id,
        PHASE_FOUR_C_CANCEL_TAB_ID,
        database,
        "SELECT sleepEachRow(0.2), number FROM numbers(50) SETTINGS max_block_size = 1".to_string(),
    )?;
    wait_for_active_query(&manager, profile_id, client, &handle).await?;
    let canceling = manager
        .cancel_sql_execution(profile_id, PHASE_FOUR_C_CANCEL_TAB_ID, &handle.execution_id)
        .await
        .map_err(|_| "Phase 4C Raw cancel request failed".to_string())?;
    if canceling.state != SqlExecutionState::Canceling {
        return Err("Phase 4C Raw cancel did not enter canceling".to_string());
    }
    let terminal = wait_for_terminal(
        &manager,
        profile_id,
        PHASE_FOUR_C_CANCEL_TAB_ID,
        &handle.execution_id,
    )
    .await?;
    if terminal.state != SqlExecutionState::Canceled
        || terminal.cancel_message.is_none()
        || terminal.failure.is_some()
        || terminal.outcome.is_some()
    {
        return Err("Phase 4C Raw cancel was not server-confirmed".to_string());
    }
    wait_for_query_absent(client, &handle.query_id).await?;
    wait_for_store_empty(&store).await?;
    if !artifact_directory_is_empty(&artifact_root)? {
        return Err("Phase 4C Raw cancel retained a partial file".to_string());
    }
    verify_runtime_ping(&manager, profile_id).await?;
    manager
        .release_sql_execution(profile_id, PHASE_FOUR_C_CANCEL_TAB_ID, &handle.execution_id)
        .map_err(|_| "Phase 4C canceled execution release failed".to_string())?;
    close_and_disconnect(&manager, profile_id, PHASE_FOUR_C_CANCEL_TAB_ID).await
}

async fn terminal_cleanup_artifact(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    tab_id: &str,
    database: &str,
) -> Result<String, String> {
    let terminal = execute_raw_terminal(
        manager,
        profile_id,
        tab_id,
        database,
        "SELECT 1 AS cleanup FORMAT CSV".to_string(),
    )
    .await?;
    expect_raw_artifact(
        &terminal,
        ExpectedRawPresentation {
            format: "CSV",
            media_type: "text/csv",
            binary_preview: false,
        },
    )?;
    Ok(terminal.execution_id)
}

async fn verify_lifecycle_cleanup(
    profile_id: &str,
    record: &StoredConnectionRecord,
    database: &str,
) -> Result<(), String> {
    let artifact_root = tempfile::tempdir()
        .map_err(|_| "Phase 4C cleanup fixture could not be created".to_string())?;
    let store = RawArtifactStore::for_test(
        artifact_root.path().to_path_buf(),
        RawArtifactLimits::default(),
    );
    let manager = ConnectionRuntimeManager::with_raw_artifact_store_for_test(store.clone());

    connect_and_open(&manager, profile_id, PHASE_FOUR_C_TAB_ID, record).await?;
    let tab_execution =
        terminal_cleanup_artifact(&manager, profile_id, PHASE_FOUR_C_TAB_ID, database).await?;
    if store.entry_count_for_test() != 1 {
        return Err("Phase 4C tab cleanup probe missed its artifact".to_string());
    }
    manager
        .close_tab_runtime(PHASE_FOUR_C_TAB_ID)
        .await
        .map_err(|_| "Phase 4C tab cleanup failed".to_string())?;
    if store.entry_count_for_test() != 0
        || manager
            .get_sql_execution_snapshot(profile_id, PHASE_FOUR_C_TAB_ID, &tab_execution)
            .expect_err("closed Phase 4C tab must discard its execution")
            .code
            != ErrorCode::ResourceNotFound
    {
        return Err("Phase 4C tab cleanup retained ownership".to_string());
    }

    manager
        .open_tab_runtime(profile_id, PHASE_FOUR_C_PROFILE_TAB_ID, record)
        .await
        .map_err(|_| "Phase 4C profile cleanup tab did not open".to_string())?;
    let profile_execution =
        terminal_cleanup_artifact(&manager, profile_id, PHASE_FOUR_C_PROFILE_TAB_ID, database)
            .await?;
    manager
        .disconnect_profile(profile_id)
        .await
        .map_err(|_| "Phase 4C profile cleanup failed".to_string())?;
    if store.entry_count_for_test() != 0
        || manager
            .get_sql_execution_snapshot(profile_id, PHASE_FOUR_C_PROFILE_TAB_ID, &profile_execution)
            .expect_err("disconnected Phase 4C profile must discard its execution")
            .code
            != ErrorCode::ResourceNotFound
    {
        return Err("Phase 4C profile cleanup retained ownership".to_string());
    }

    connect_and_open(&manager, profile_id, PHASE_FOUR_C_APP_TAB_ID, record).await?;
    let app_execution =
        terminal_cleanup_artifact(&manager, profile_id, PHASE_FOUR_C_APP_TAB_ID, database).await?;
    manager
        .shutdown_sql_execution_state()
        .map_err(|_| "Phase 4C app SQL teardown failed".to_string())?;
    if store.entry_count_for_test() != 0
        || manager
            .get_sql_execution_snapshot(profile_id, PHASE_FOUR_C_APP_TAB_ID, &app_execution)
            .expect_err("Phase 4C app teardown must discard its execution")
            .code
            != ErrorCode::ResourceNotFound
    {
        return Err("Phase 4C app teardown retained ownership".to_string());
    }
    if !artifact_directory_is_empty(&artifact_root)? {
        return Err("Phase 4C lifecycle cleanup retained an artifact file".to_string());
    }
    close_and_disconnect(&manager, profile_id, PHASE_FOUR_C_APP_TAB_ID).await
}

pub(super) async fn run(
    profile_id: &str,
    record: &StoredConnectionRecord,
    client: &Client,
    database: &str,
) -> Result<(), String> {
    verify_formats_save_retry_and_release(profile_id, record, database).await?;
    verify_artifact_limit(profile_id, record, database).await?;
    verify_cancel_cleanup(profile_id, record, client, database).await?;
    verify_lifecycle_cleanup(profile_id, record, database).await
}

#[cfg(test)]
mod tests {
    use super::{expected_raw_presentations, small_artifact_limits, PHASE_FOUR_C_MARKER};

    #[test]
    fn phase_four_c_helper_contract_is_stable_and_secret_free() {
        assert_eq!(
            PHASE_FOUR_C_MARKER,
            "ClickHouse Phase 4C real HTTP checkpoint passed: raw-format/text-binary-preview/artifact-save/limit/cancel/release/tab-profile-app-cleanup",
        );

        let presentations = expected_raw_presentations();
        assert_eq!(presentations[0].format, "CSVWithNames");
        assert_eq!(presentations[0].media_type, "text/csv");
        assert!(!presentations[0].binary_preview);
        assert_eq!(presentations[1].format, "JSONEachRow");
        assert_eq!(presentations[1].media_type, "application/json");
        assert!(!presentations[1].binary_preview);
        assert_eq!(presentations[2].format, "Parquet");
        assert_eq!(
            presentations[2].media_type,
            "application/vnd.apache.parquet"
        );
        assert!(presentations[2].binary_preview);

        let limits = small_artifact_limits();
        assert_eq!(limits.max_bytes, 64);
        assert_eq!(limits.preview_bytes, 32);
        assert_eq!(limits.binary_preview_bytes, 8);
        assert!(!PHASE_FOUR_C_MARKER.contains("password"));
        assert!(!PHASE_FOUR_C_MARKER.contains("SELECT"));
        assert!(!PHASE_FOUR_C_MARKER.contains('\\'));
    }
}
