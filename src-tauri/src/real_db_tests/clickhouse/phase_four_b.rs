use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use clickhouse::Client;
use serde::Deserialize;
use serde_json::json;

use crate::engine::manager::ConnectionRuntimeManager;
use crate::engine::sql_execution::SqlExecutionEventSink;
use crate::engine::types::{
    QueryResult, SqlExecutionContext, SqlExecutionEvent, SqlExecutionHandle, SqlExecutionOptions,
    SqlExecutionOutcome, SqlExecutionSnapshot, SqlExecutionState, SqlResultMode, SqlStatementClass,
    StartSqlExecutionRequest,
};
use crate::error::ErrorCode;
use crate::repository::connection_repository::StoredConnectionRecord;

const PHASE_FOUR_B_TAB_ID: &str = "real-clickhouse-phase-four-b-tab";
const TERMINAL_WAIT: Duration = Duration::from_secs(45);
const MUTATION_WAIT: Duration = Duration::from_secs(30);
const OBSERVATION_WAIT: Duration = Duration::from_secs(8);
const SNAPSHOT_POLL: Duration = Duration::from_millis(50);

fn table_name(prefix: &str) -> String {
    super::scratch_object_name(prefix, "phase4b_exec")
}

fn quoted_table(prefix: &str) -> String {
    super::quote_test_identifier(&table_name(prefix))
}

struct DiscardingExecutionSink;

impl SqlExecutionEventSink for DiscardingExecutionSink {
    fn publish(&self, _event: SqlExecutionEvent) -> Result<(), String> {
        Ok(())
    }
}

fn managed_request(database: &str, sql: String) -> StartSqlExecutionRequest {
    StartSqlExecutionRequest {
        context: SqlExecutionContext {
            database: Some(database.to_string()),
            schema: None,
        },
        sql,
        options: SqlExecutionOptions {
            result_mode: SqlResultMode::Grid,
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

fn start_execution(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    database: &str,
    sql: String,
    query_ids: &mut Vec<String>,
) -> Result<SqlExecutionHandle, String> {
    let handle = manager
        .start_sql_execution(
            profile_id,
            PHASE_FOUR_B_TAB_ID,
            managed_request(database, sql),
            Arc::new(DiscardingExecutionSink),
        )
        .map_err(|_| "Phase 4B managed execution did not start".to_string())?;
    query_ids.push(handle.query_id.clone());
    Ok(handle)
}

async fn wait_for_terminal(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    execution_id: &str,
    deadline: Duration,
) -> Result<SqlExecutionSnapshot, String> {
    tokio::time::timeout(deadline, async {
        loop {
            let snapshot = manager
                .get_sql_execution_snapshot(profile_id, PHASE_FOUR_B_TAB_ID, execution_id)
                .map_err(|_| "Phase 4B execution snapshot lookup failed".to_string())?;
            if is_terminal(snapshot.state) {
                return Ok(snapshot);
            }
            tokio::time::sleep(SNAPSHOT_POLL).await;
        }
    })
    .await
    .map_err(|_| "Phase 4B execution did not reach a terminal state".to_string())?
}

async fn execute_terminal(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    sql: String,
    database: &str,
    query_ids: &mut Vec<String>,
) -> Result<SqlExecutionSnapshot, String> {
    let handle = start_execution(manager, profile_id, database, sql, query_ids)?;
    let terminal =
        wait_for_terminal(manager, profile_id, &handle.execution_id, TERMINAL_WAIT).await?;
    manager
        .release_sql_execution(profile_id, PHASE_FOUR_B_TAB_ID, &handle.execution_id)
        .map_err(|_| "Phase 4B terminal execution ownership was not released".to_string())?;
    Ok(terminal)
}

fn expect_succeeded(snapshot: &SqlExecutionSnapshot, label: &str) -> Result<(), String> {
    if snapshot.state == SqlExecutionState::Succeeded && snapshot.failure.is_none() {
        Ok(())
    } else if snapshot
        .failure
        .as_ref()
        .is_some_and(|failure| failure.code == ErrorCode::ValidationFailed)
    {
        Err("Phase 4B direct command was blocked by read-only access".to_string())
    } else {
        Err(format!(
            "Phase 4B {label} reached an unexpected terminal state"
        ))
    }
}

fn expect_command(
    snapshot: &SqlExecutionSnapshot,
    class: SqlStatementClass,
    mutation_submitted: bool,
    label: &str,
) -> Result<(), String> {
    expect_succeeded(snapshot, label)?;
    match snapshot.outcome.as_ref() {
        Some(SqlExecutionOutcome::Command {
            statement_class,
            mutation_submitted: actual,
            ..
        }) if *statement_class == class && *actual == mutation_submitted => Ok(()),
        _ => Err(format!("Phase 4B {label} did not return a command outcome")),
    }
}

fn expect_rows<'a>(
    snapshot: &'a SqlExecutionSnapshot,
    label: &str,
) -> Result<&'a QueryResult, String> {
    expect_succeeded(snapshot, label)?;
    match snapshot.outcome.as_ref() {
        Some(SqlExecutionOutcome::Rows { result }) => Ok(result),
        _ => Err(format!("Phase 4B {label} did not return rows")),
    }
}

#[derive(clickhouse::Row, Deserialize)]
struct MutationStatus {
    is_done: u8,
    latest_fail_reason: String,
}

async fn wait_for_latest_mutation(
    client: &Client,
    database: &str,
    table: &str,
) -> Result<(), String> {
    tokio::time::timeout(MUTATION_WAIT, async {
        loop {
            let row = client
                .query(
                    "SELECT is_done, latest_fail_reason FROM system.mutations \
                     WHERE database = ? AND table = ? ORDER BY create_time DESC LIMIT 1",
                )
                .bind(database)
                .bind(table)
                .fetch_optional::<MutationStatus>()
                .await
                .map_err(|_| "Phase 4B mutation status lookup failed".to_string())?;
            match row {
                Some(row) if row.is_done == 1 && row.latest_fail_reason.is_empty() => return Ok(()),
                Some(row) if !row.latest_fail_reason.is_empty() => {
                    return Err("Phase 4B mutation reported a server failure".to_string());
                }
                _ => tokio::time::sleep(SNAPSHOT_POLL).await,
            }
        }
    })
    .await
    .map_err(|_| "Phase 4B mutation did not complete within the bounded wait".to_string())?
}

fn result_value<'a>(
    result: &QueryResult,
    row: &'a [serde_json::Value],
    column: &str,
) -> Result<&'a serde_json::Value, String> {
    let index = result
        .columns
        .iter()
        .position(|item| item.name == column)
        .ok_or_else(|| "Phase 4B fact result missed a required column".to_string())?;
    row.get(index)
        .ok_or_else(|| "Phase 4B fact result missed a required value".to_string())
}

fn verify_initial_facts(result: &QueryResult) -> Result<(), String> {
    if result.rows.len() != 2 {
        return Err("Phase 4B final fact row count was incorrect".to_string());
    }
    let first = &result.rows[0];
    let second = &result.rows[1];
    if result_value(result, first, "id")? != &json!(1)
        || result_value(result, first, "value")? != &json!("one")
        || !result_value(result, first, "note")?.is_null()
        || result_value(result, second, "id")? != &json!(2)
        || result_value(result, second, "value")? != &json!("updated")
        || !result_value(result, second, "note")?.is_null()
    {
        return Err("Phase 4B final database facts were incorrect".to_string());
    }
    Ok(())
}

fn verify_sequence_ids(snapshots: &[&SqlExecutionSnapshot]) -> Result<(), String> {
    let execution_ids = snapshots
        .iter()
        .map(|snapshot| snapshot.execution_id.as_str())
        .collect::<HashSet<_>>();
    let query_ids = snapshots
        .iter()
        .map(|snapshot| snapshot.query_id.as_str())
        .collect::<HashSet<_>>();
    if execution_ids.len() != snapshots.len()
        || query_ids.len() != snapshots.len()
        || snapshots
            .iter()
            .any(|snapshot| snapshot.execution_id == snapshot.query_id)
    {
        return Err("Phase 4B sequence IDs were not distinct".to_string());
    }
    Ok(())
}

async fn verify_initial_direct_execution(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    client: &Client,
    database: &str,
    table: &str,
    quoted: &str,
    query_ids: &mut Vec<String>,
) -> Result<(), String> {
    let create = execute_terminal(
        manager,
        profile_id,
        format!("CREATE TABLE {quoted} (id UInt64, value String) ENGINE=MergeTree ORDER BY id"),
        database,
        query_ids,
    )
    .await?;
    expect_command(&create, SqlStatementClass::Ddl, false, "CREATE")?;

    let insert = execute_terminal(
        manager,
        profile_id,
        format!("INSERT INTO {quoted} VALUES (1,'one'),(2,'two'),(3,'three')"),
        database,
        query_ids,
    )
    .await?;
    expect_command(&insert, SqlStatementClass::Insert, false, "INSERT")?;
    if let Some(SqlExecutionOutcome::Command {
        summary: Some(summary),
        ..
    }) = insert.outcome.as_ref()
    {
        if summary.written_rows.is_some_and(|rows| rows != 3) {
            return Err("Phase 4B INSERT summary reported an incorrect row count".to_string());
        }
    }

    let alter = execute_terminal(
        manager,
        profile_id,
        format!("ALTER TABLE {quoted} ADD COLUMN note Nullable(String)"),
        database,
        query_ids,
    )
    .await?;
    expect_command(&alter, SqlStatementClass::Ddl, false, "ALTER")?;

    let mutation = execute_terminal(
        manager,
        profile_id,
        format!("ALTER TABLE {quoted} UPDATE value='updated' WHERE id=2"),
        database,
        query_ids,
    )
    .await?;
    expect_command(&mutation, SqlStatementClass::Mutation, true, "Mutation")?;
    wait_for_latest_mutation(client, database, table).await?;

    let delete = execute_terminal(
        manager,
        profile_id,
        format!("DELETE FROM {quoted} WHERE id=3"),
        database,
        query_ids,
    )
    .await?;
    expect_command(&delete, SqlStatementClass::Delete, false, "DELETE")?;

    let facts = execute_terminal(
        manager,
        profile_id,
        format!("SELECT id, value, note FROM {quoted} ORDER BY id"),
        database,
        query_ids,
    )
    .await?;
    verify_initial_facts(expect_rows(&facts, "fact SELECT")?)
}

async fn verify_count(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    database: &str,
    quoted: &str,
    predicate: &str,
    expected: u64,
    query_ids: &mut Vec<String>,
) -> Result<(), String> {
    let snapshot = execute_terminal(
        manager,
        profile_id,
        format!("SELECT countIf({predicate}) AS count FROM {quoted}"),
        database,
        query_ids,
    )
    .await?;
    let result = expect_rows(&snapshot, "sequence fact SELECT")?;
    if result.rows.first().and_then(|row| row.first()) != Some(&json!(expected)) {
        return Err("Phase 4B sequence side-effect fact was incorrect".to_string());
    }
    Ok(())
}

async fn wait_for_running(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    execution_id: &str,
    require_observation: bool,
) -> Result<(), String> {
    tokio::time::timeout(OBSERVATION_WAIT, async {
        loop {
            let snapshot = manager
                .get_sql_execution_snapshot(profile_id, PHASE_FOUR_B_TAB_ID, execution_id)
                .map_err(|_| "Phase 4B active execution snapshot lookup failed".to_string())?;
            if snapshot.state == SqlExecutionState::Running
                && (!require_observation
                    || snapshot.progress_available
                    || !snapshot.observation_warnings.is_empty())
            {
                return Ok(());
            }
            if is_terminal(snapshot.state) {
                return Err("Phase 4B long execution ended before required evidence".to_string());
            }
            tokio::time::sleep(SNAPSHOT_POLL).await;
        }
    })
    .await
    .map_err(|_| "Phase 4B long execution did not expose required evidence".to_string())?
}

async fn finish_started_execution(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    handle: &SqlExecutionHandle,
) -> Result<SqlExecutionSnapshot, String> {
    let terminal =
        wait_for_terminal(manager, profile_id, &handle.execution_id, TERMINAL_WAIT).await?;
    manager
        .release_sql_execution(profile_id, PHASE_FOUR_B_TAB_ID, &handle.execution_id)
        .map_err(|_| "Phase 4B long execution ownership was not released".to_string())?;
    Ok(terminal)
}

async fn verify_managed_sequences(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    database: &str,
    quoted: &str,
    query_ids: &mut Vec<String>,
) -> Result<(), String> {
    let create = execute_terminal(
        manager,
        profile_id,
        format!(
            "CREATE TABLE IF NOT EXISTS {quoted} (id UInt64, value String, note Nullable(String)) ENGINE=MergeTree ORDER BY id"
        ),
        database,
        query_ids,
    )
    .await?;
    let insert = execute_terminal(
        manager,
        profile_id,
        format!("INSERT INTO {quoted} (id, value) VALUES (10, 'ten')"),
        database,
        query_ids,
    )
    .await?;
    let select = execute_terminal(
        manager,
        profile_id,
        format!("SELECT id FROM {quoted} WHERE id=10"),
        database,
        query_ids,
    )
    .await?;
    expect_command(&create, SqlStatementClass::Ddl, false, "sequence CREATE")?;
    expect_command(&insert, SqlStatementClass::Insert, false, "sequence INSERT")?;
    let select_result = expect_rows(&select, "sequence SELECT")?;
    if select_result.rows.first().and_then(|row| row.first()) != Some(&json!(10)) {
        return Err("Phase 4B successful sequence SELECT fact was incorrect".to_string());
    }
    verify_sequence_ids(&[&create, &insert, &select])?;

    let sequence = [
        format!("INSERT INTO {quoted} (id, value) VALUES (20, 'valid')"),
        format!("INSERT INTO {quoted} (missing_column) VALUES (21)"),
        format!("INSERT INTO {quoted} (id, value) VALUES (21, 'must-not-run')"),
    ];
    let mut attempted = 0_usize;
    for sql in sequence {
        let terminal = execute_terminal(manager, profile_id, sql, database, query_ids).await?;
        attempted += 1;
        if terminal.state != SqlExecutionState::Succeeded {
            break;
        }
    }
    if attempted != 2 {
        return Err("Phase 4B stop-on-error sequence did not stop at the failure".to_string());
    }
    verify_count(
        manager, profile_id, database, quoted, "id = 20", 1, query_ids,
    )
    .await?;
    verify_count(
        manager, profile_id, database, quoted, "id = 21", 0, query_ids,
    )
    .await?;

    let stop_handle = start_execution(
        manager,
        profile_id,
        database,
        "SELECT sleepEachRow(0.2) FROM numbers(5) SETTINGS max_block_size=1".to_string(),
        query_ids,
    )?;
    wait_for_running(manager, profile_id, &stop_handle.execution_id, false).await?;
    let stop_requested = true;
    let stopped = finish_started_execution(manager, profile_id, &stop_handle).await?;
    if !stop_requested || stopped.state != SqlExecutionState::Succeeded {
        return Err("Phase 4B Stop Queue changed the active statement outcome".to_string());
    }
    verify_count(
        manager, profile_id, database, quoted, "id = 30", 0, query_ids,
    )
    .await?;

    let cancel_handle = start_execution(
        manager,
        profile_id,
        database,
        "SELECT sleepEachRow(0.2) FROM numbers(50) SETTINGS max_block_size=1".to_string(),
        query_ids,
    )?;
    wait_for_running(manager, profile_id, &cancel_handle.execution_id, true).await?;
    let canceling = manager
        .cancel_sql_execution(profile_id, PHASE_FOUR_B_TAB_ID, &cancel_handle.execution_id)
        .await
        .map_err(|_| "Phase 4B Cancel Active request failed".to_string())?;
    if canceling.state != SqlExecutionState::Canceling {
        return Err("Phase 4B Cancel Active did not enter canceling".to_string());
    }
    let canceled = finish_started_execution(manager, profile_id, &cancel_handle).await?;
    if canceled.state != SqlExecutionState::Canceled
        || canceled.cancel_message.is_none()
        || canceled.failure.is_some()
    {
        return Err("Phase 4B Cancel Active was not server-confirmed".to_string());
    }
    verify_count(
        manager, profile_id, database, quoted, "id = 40", 0, query_ids,
    )
    .await
}

async fn run_inner(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    client: &Client,
    database: &str,
    prefix: &str,
    query_ids: &mut Vec<String>,
) -> Result<(), String> {
    let name = table_name(prefix);
    let quoted = quoted_table(prefix);
    verify_initial_direct_execution(
        manager, profile_id, client, database, &name, &quoted, query_ids,
    )
    .await?;
    verify_managed_sequences(manager, profile_id, database, &quoted, query_ids).await
}

async fn drop_scratch_table(client: &Client, quoted: &str) -> Result<(), String> {
    client
        .query(&format!("DROP TABLE IF EXISTS {quoted}"))
        .with_setting("wait_end_of_query", "1")
        .with_setting("max_execution_time", "30")
        .execute()
        .await
        .map_err(|_| "Phase 4B scratch table cleanup failed".to_string())
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
        .map_err(|_| "Phase 4B active query cleanup lookup failed".to_string())
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
    .map_err(|_| "Phase 4B query remained active after cleanup".to_string())?
}

pub(super) async fn run(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    record: &StoredConnectionRecord,
    client: &Client,
    database: &str,
    prefix: &str,
) -> Result<(), String> {
    let quoted = quoted_table(prefix);
    drop_scratch_table(client, &quoted).await?;
    manager
        .open_tab_runtime(profile_id, PHASE_FOUR_B_TAB_ID, record)
        .await
        .map_err(|_| "Phase 4B tab runtime did not open".to_string())?;

    let mut query_ids = Vec::new();
    let result = run_inner(
        manager,
        profile_id,
        client,
        database,
        prefix,
        &mut query_ids,
    )
    .await;

    let close_result = manager.close_tab_runtime(PHASE_FOUR_B_TAB_ID).await;
    let drop_result = drop_scratch_table(client, &quoted).await;
    let mut active_cleanup_failed = false;
    for query_id in &query_ids {
        if wait_for_query_absent(client, query_id).await.is_err() {
            active_cleanup_failed = true;
        }
    }
    if close_result.is_err() || drop_result.is_err() || active_cleanup_failed {
        return Err("Phase 4B cleanup failed".to_string());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{quoted_table, table_name};

    #[test]
    fn phase_four_b_uses_only_the_validated_scratch_namespace() {
        assert_eq!(table_name("nexpilot_it_"), "nexpilot_it_phase4b_exec");
        assert_eq!(quoted_table("nexpilot_it_"), "`nexpilot_it_phase4b_exec`");
    }
}
