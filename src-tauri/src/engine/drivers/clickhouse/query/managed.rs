use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::watch;

use super::classify::{raw_sql_directives, validate_managed_sql};
use super::policy::ExecutionPolicy;
use super::raw::{RawQueryCall, RawQueryOutcome};
use super::{execute_grid_query, DecodedQueryOutcome, GridQueryRequest, QueryWindow};
use crate::engine::drivers::clickhouse::ClickHouseDriver;
use crate::engine::sql_execution::artifact::RawArtifactWriter;
use crate::engine::sql_execution::{
    ManagedSqlExecutionRequest, SqlCancelConfirmation, SqlExecutionControl,
};
use crate::engine::types::{
    SqlExecutionOutcome, SqlExecutionSummary, SqlResultMode, SqlStatementAccess, SqlStatementClass,
};
use crate::error::{IpcError, IpcResult};

#[derive(Debug, Clone, PartialEq, Eq)]
struct ManagedGridCall {
    database: Option<String>,
    sql: String,
    query_id: String,
    policy: ExecutionPolicy,
    timeout_ms: Option<u64>,
    window: QueryWindow,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ManagedCommandCall {
    database: Option<String>,
    sql: String,
    query_id: String,
    policy: ExecutionPolicy,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ManagedStatementRoute {
    Grid(ExecutionPolicy),
    Command,
    Raw,
}

enum ManagedQueryOutcome {
    Grid(DecodedQueryOutcome),
    Command(Option<SqlExecutionSummary>),
    Raw(RawQueryOutcome),
}

#[async_trait]
trait ManagedQueryExecutor: Send + Sync {
    async fn execute_grid(&self, call: ManagedGridCall) -> IpcResult<DecodedQueryOutcome>;
    async fn execute_command(
        &self,
        call: ManagedCommandCall,
    ) -> IpcResult<Option<SqlExecutionSummary>>;
    async fn execute_raw(
        &self,
        call: RawQueryCall,
        writer: RawArtifactWriter,
        cancellation: watch::Receiver<bool>,
    ) -> IpcResult<RawQueryOutcome>;
    async fn cancel_target_query(&self, target_query_id: &str) -> IpcResult<SqlCancelConfirmation>;
    async fn poll_progress(
        &self,
        target_query_id: String,
        control: SqlExecutionControl,
        stop: watch::Receiver<bool>,
    ) -> super::progress::ProgressObservation;
}

#[async_trait]
impl ManagedQueryExecutor for ClickHouseDriver {
    async fn execute_grid(&self, call: ManagedGridCall) -> IpcResult<DecodedQueryOutcome> {
        let (base_client, _session_guard) = self.client_for_request().await?;
        let client = call
            .database
            .as_deref()
            .map(|database| base_client.clone().with_database(database))
            .unwrap_or(base_client);
        execute_grid_query(
            &client,
            GridQueryRequest {
                sql: &call.sql,
                bindings: &[],
                query_id: Some(&call.query_id),
                policy: call.policy,
                timeout_ms: call.timeout_ms,
                window: call.window,
            },
            self.shutdown.subscribe(),
        )
        .await
    }

    async fn execute_command(
        &self,
        call: ManagedCommandCall,
    ) -> IpcResult<Option<SqlExecutionSummary>> {
        debug_assert_eq!(call.policy, ExecutionPolicy::DirectGrid);
        let (base_client, _session_guard) = self.client_for_request().await?;
        let client = call
            .database
            .as_deref()
            .map(|database| base_client.clone().with_database(database))
            .unwrap_or(base_client);
        super::command::execute(
            &client,
            super::command::CommandQueryRequest {
                sql: &call.sql,
                query_id: &call.query_id,
                timeout_ms: call.timeout_ms,
            },
        )
        .await?;
        Ok(None)
    }

    async fn execute_raw(
        &self,
        call: RawQueryCall,
        writer: RawArtifactWriter,
        cancellation: watch::Receiver<bool>,
    ) -> IpcResult<RawQueryOutcome> {
        super::raw::execute_raw(self, call, writer, cancellation).await
    }

    async fn cancel_target_query(&self, target_query_id: &str) -> IpcResult<SqlCancelConfirmation> {
        super::cancel::cancel_target(&self.client, target_query_id).await
    }

    async fn poll_progress(
        &self,
        target_query_id: String,
        control: SqlExecutionControl,
        stop: watch::Receiver<bool>,
    ) -> super::progress::ProgressObservation {
        super::progress::poll_progress(self.client.clone(), target_query_id, control, stop).await
    }
}

pub(super) async fn execute(
    driver: &ClickHouseDriver,
    request: ManagedSqlExecutionRequest,
    control: SqlExecutionControl,
    statement_access: SqlStatementAccess,
) -> IpcResult<SqlExecutionOutcome> {
    execute_managed_with(driver, request, control, statement_access).await
}

async fn execute_managed_with<E: ManagedQueryExecutor>(
    executor: &E,
    mut request: ManagedSqlExecutionRequest,
    control: SqlExecutionControl,
    statement_access: SqlStatementAccess,
) -> IpcResult<SqlExecutionOutcome> {
    let result_mode = request.options.result_mode;
    let raw_directives = match result_mode {
        SqlResultMode::Grid => {
            validate_managed_sql(&request.sql, SqlResultMode::Grid)?;
            None
        }
        SqlResultMode::Raw => Some(raw_sql_directives(&request.sql)?),
    };
    let raw_artifact = if result_mode == SqlResultMode::Raw {
        Some(request.raw_artifact.take().ok_or_else(|| {
            IpcError::system_internal(
                "Raw SQL artifact writer is unavailable",
                "manager did not attach a Raw artifact writer",
            )
        })?)
    } else {
        None
    };
    let database = super::sql::validate_context(&request.context)?;
    if request.options.page == 0 {
        return Err(IpcError::validation_failed(
            "ClickHouse SQL page must be at least 1",
        ));
    }
    let skip_rows = u64::from(request.options.page - 1)
        .checked_mul(u64::from(request.options.page_size))
        .ok_or_else(|| IpcError::validation_failed("ClickHouse SQL page offset is too large"))?;
    let page_size = usize::try_from(request.options.page_size)
        .map_err(|_| IpcError::validation_failed("ClickHouse SQL page size is too large"))?;
    super::validate_free_sql_window(skip_rows, page_size)?;

    let statement_class = request.statement_class;
    let route = statement_route(result_mode, statement_access, statement_class);
    let timeout_ms = request.options.timeout_ms;
    let execution_id = request.execution_id.clone();
    let target_query_id = request.query_id.clone();
    let sql = request.sql;
    let query_id = request.query_id;
    let window = QueryWindow {
        skip_rows,
        page_size,
    };
    let (progress_stop_tx, progress_stop_rx) = watch::channel(false);
    let progress =
        executor.poll_progress(target_query_id.clone(), control.clone(), progress_stop_rx);
    let query = async {
        let mut cancellation = control.cancelled();
        if *cancellation.borrow() {
            return Err(managed_query_canceled());
        }
        let raw_cancellation = cancellation.clone();
        let execution = async {
            match route {
                ManagedStatementRoute::Grid(policy) => executor
                    .execute_grid(ManagedGridCall {
                        database,
                        sql,
                        query_id,
                        policy,
                        timeout_ms,
                        window,
                    })
                    .await
                    .map(ManagedQueryOutcome::Grid),
                ManagedStatementRoute::Command => executor
                    .execute_command(ManagedCommandCall {
                        database,
                        sql,
                        query_id,
                        policy: ExecutionPolicy::DirectGrid,
                        timeout_ms,
                    })
                    .await
                    .map(ManagedQueryOutcome::Command),
                ManagedStatementRoute::Raw => executor
                    .execute_raw(
                        RawQueryCall {
                            database,
                            sql,
                            query_id,
                            timeout_ms,
                            directives: raw_directives
                                .expect("Raw route has validated SQL directives"),
                        },
                        raw_artifact.expect("Raw route has an artifact writer"),
                        raw_cancellation,
                    )
                    .await
                    .map(ManagedQueryOutcome::Raw),
            }
        };
        tokio::pin!(execution);
        tokio::select! {
            biased;
            changed = cancellation.changed() => {
                let _ = changed;
                Err(managed_query_canceled())
            }
            result = &mut execution => result,
            elapsed_timeout_ms = execution_deadline(timeout_ms) => {
                if !matches!(
                    executor.cancel_target_query(&target_query_id).await,
                    Ok(SqlCancelConfirmation::Confirmed(_))
                ) {
                    control.publish_warning(
                        "执行超时后未确认 ClickHouse 服务端查询停止".to_string(),
                    );
                }
                Err(super::super::error::managed_query_timeout(
                    &execution_id,
                    elapsed_timeout_ms,
                ))
            }
        }
    };
    let query_with_progress_stop = async {
        let result = query.await;
        progress_stop_tx.send_replace(true);
        result
    };
    let (observation, outcome) = tokio::join!(progress, query_with_progress_stop);
    match outcome? {
        ManagedQueryOutcome::Grid(decoded) => {
            let summary = super::summary::merge_summary(observation.latest, decoded.summary);
            if let Some(summary) = summary.clone() {
                control.publish_summary(summary, observation.available);
            }
            if statement_class == SqlStatementClass::Unknown
                && decoded.result.columns.is_empty()
                && decoded.result.rows.is_empty()
            {
                Ok(command_completion(statement_class, summary))
            } else {
                Ok(SqlExecutionOutcome::Rows {
                    result: decoded.result,
                })
            }
        }
        ManagedQueryOutcome::Command(command_summary) => {
            let progress_summary =
                super::summary::merge_summary(observation.latest, command_summary.clone());
            if let Some(summary) = progress_summary {
                control.publish_summary(summary, observation.available);
            }
            Ok(command_completion(statement_class, command_summary))
        }
        ManagedQueryOutcome::Raw(RawQueryOutcome::Artifact {
            format,
            media_type,
            descriptor,
            summary,
        }) => {
            let merged = super::summary::merge_summary(observation.latest, summary.clone());
            if let Some(summary) = merged {
                control.publish_summary(summary, observation.available);
            }
            Ok(SqlExecutionOutcome::Raw {
                format: Some(format),
                media_type,
                byte_length: descriptor.byte_length,
                preview: descriptor.preview,
                preview_truncated: descriptor.preview_truncated,
                artifact_id: descriptor.artifact_id,
            })
        }
        ManagedQueryOutcome::Raw(RawQueryOutcome::ServerOutfile { summary }) => {
            let merged = super::summary::merge_summary(observation.latest, summary.clone());
            if let Some(summary) = merged {
                control.publish_summary(summary, observation.available);
            }
            Ok(SqlExecutionOutcome::Command {
                statement_class,
                completion_message: "服务端 INTO OUTFILE 执行完成".to_string(),
                summary,
                mutation_submitted: false,
            })
        }
    }
}

fn statement_route(
    result_mode: SqlResultMode,
    access: SqlStatementAccess,
    class: SqlStatementClass,
) -> ManagedStatementRoute {
    if result_mode == SqlResultMode::Raw {
        return ManagedStatementRoute::Raw;
    }
    match access {
        SqlStatementAccess::ReadOnly => ManagedStatementRoute::Grid(ExecutionPolicy::ReadOnlyGrid),
        SqlStatementAccess::Direct => match class {
            SqlStatementClass::Read => ManagedStatementRoute::Grid(ExecutionPolicy::ReadOnlyGrid),
            SqlStatementClass::Unknown => ManagedStatementRoute::Grid(ExecutionPolicy::DirectGrid),
            SqlStatementClass::Ddl
            | SqlStatementClass::Insert
            | SqlStatementClass::Delete
            | SqlStatementClass::Mutation
            | SqlStatementClass::System
            | SqlStatementClass::Command => ManagedStatementRoute::Command,
        },
    }
}

fn command_completion(
    class: SqlStatementClass,
    summary: Option<SqlExecutionSummary>,
) -> SqlExecutionOutcome {
    let (completion_message, mutation_submitted) = match class {
        SqlStatementClass::Ddl => ("DDL 执行完成", false),
        SqlStatementClass::Insert => ("INSERT 执行完成", false),
        SqlStatementClass::Delete => ("DELETE 请求执行完成", false),
        SqlStatementClass::Mutation => ("Mutation 请求已提交", true),
        SqlStatementClass::System => ("SYSTEM 命令执行完成", false),
        SqlStatementClass::Command | SqlStatementClass::Unknown => ("命令执行完成", false),
        SqlStatementClass::Read => ("查询执行完成", false),
    };
    SqlExecutionOutcome::Command {
        statement_class: class,
        completion_message: completion_message.to_string(),
        summary,
        mutation_submitted,
    }
}

async fn execution_deadline(timeout_ms: Option<u64>) -> u64 {
    match timeout_ms {
        Some(value) => {
            tokio::time::sleep(Duration::from_millis(value)).await;
            value
        }
        None => std::future::pending::<u64>().await,
    }
}

fn managed_query_canceled() -> IpcError {
    IpcError::operation_canceled(
        "ClickHouse query canceled",
        "managed execution cancellation was requested",
    )
}

#[cfg(test)]
mod tests {
    use std::future::pending;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use serde_json::json;
    use tokio::sync::watch;

    use super::*;
    use crate::engine::drivers::clickhouse::query::raw::{RawQueryCall, RawQueryOutcome};
    use crate::engine::sql_execution::artifact::{
        RawArtifactLimits, RawArtifactOwner, RawArtifactPreviewMode, RawArtifactStore,
        RawArtifactWriter,
    };
    use crate::engine::sql_execution::{
        ManagedSqlExecutionRequest, SqlCancelConfirmation, SqlExecutionControl,
        SqlExecutionObserver,
    };
    use crate::engine::types::{
        QueryResult, SqlExecutionContext, SqlExecutionOptions, SqlExecutionOutcome,
        SqlExecutionSummary, SqlResultMode, SqlStatementAccess, SqlStatementClass,
        SqlSummaryCompleteness, SqlSummarySource,
    };
    use crate::error::{ErrorCode, IpcResult, RuntimeErrorImpact};

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct RecordedCommandCall {
        sql: String,
        policy: ExecutionPolicy,
    }

    struct RecordingManagedExecutor {
        calls: Mutex<Vec<ManagedGridCall>>,
        result: Mutex<Option<IpcResult<DecodedQueryOutcome>>>,
        command_calls: Mutex<Vec<RecordedCommandCall>>,
        command_result: Mutex<Option<IpcResult<Option<SqlExecutionSummary>>>>,
        raw_calls: Mutex<Vec<RawQueryCall>>,
        raw_result: Mutex<Option<RecordingRawResult>>,
        pending: bool,
        cancel_calls: Mutex<Vec<String>>,
        cancel_result: Mutex<Option<IpcResult<SqlCancelConfirmation>>>,
        progress_calls: AtomicUsize,
        progress_stops: AtomicUsize,
        progress_observation: Mutex<Option<super::super::progress::ProgressObservation>>,
    }

    enum RecordingRawResult {
        Artifact {
            bytes: Vec<u8>,
            summary: Option<SqlExecutionSummary>,
        },
        ServerOutfile {
            summary: Option<SqlExecutionSummary>,
        },
    }

    impl RecordingManagedExecutor {
        fn returning_grid(result: IpcResult<DecodedQueryOutcome>) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                result: Mutex::new(Some(result)),
                command_calls: Mutex::new(Vec::new()),
                command_result: Mutex::new(None),
                raw_calls: Mutex::new(Vec::new()),
                raw_result: Mutex::new(None),
                pending: false,
                cancel_calls: Mutex::new(Vec::new()),
                cancel_result: Mutex::new(Some(Ok(SqlCancelConfirmation::Confirmed(
                    "fake timeout cleanup confirmed".to_string(),
                )))),
                progress_calls: AtomicUsize::new(0),
                progress_stops: AtomicUsize::new(0),
                progress_observation: Mutex::new(Some(
                    super::super::progress::ProgressObservation::default(),
                )),
            }
        }

        fn returning(result: IpcResult<DecodedQueryOutcome>) -> Self {
            Self::returning_grid(result)
        }

        fn returning_command(summary: Option<SqlExecutionSummary>) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                result: Mutex::new(None),
                command_calls: Mutex::new(Vec::new()),
                command_result: Mutex::new(Some(Ok(summary))),
                raw_calls: Mutex::new(Vec::new()),
                raw_result: Mutex::new(None),
                pending: false,
                cancel_calls: Mutex::new(Vec::new()),
                cancel_result: Mutex::new(Some(Ok(SqlCancelConfirmation::Confirmed(
                    "fake timeout cleanup confirmed".to_string(),
                )))),
                progress_calls: AtomicUsize::new(0),
                progress_stops: AtomicUsize::new(0),
                progress_observation: Mutex::new(Some(
                    super::super::progress::ProgressObservation::default(),
                )),
            }
        }

        fn returning_raw(bytes: &[u8], summary: Option<SqlExecutionSummary>) -> Self {
            let executor = Self::unused();
            *executor.raw_result.lock().expect("Raw result lock") =
                Some(RecordingRawResult::Artifact {
                    bytes: bytes.to_vec(),
                    summary,
                });
            executor
        }

        fn returning_server_outfile(summary: Option<SqlExecutionSummary>) -> Self {
            let executor = Self::unused();
            *executor.raw_result.lock().expect("Raw result lock") =
                Some(RecordingRawResult::ServerOutfile { summary });
            executor
        }

        fn pending() -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                result: Mutex::new(None),
                command_calls: Mutex::new(Vec::new()),
                command_result: Mutex::new(None),
                raw_calls: Mutex::new(Vec::new()),
                raw_result: Mutex::new(None),
                pending: true,
                cancel_calls: Mutex::new(Vec::new()),
                cancel_result: Mutex::new(Some(Ok(SqlCancelConfirmation::Confirmed(
                    "fake timeout cleanup confirmed".to_string(),
                )))),
                progress_calls: AtomicUsize::new(0),
                progress_stops: AtomicUsize::new(0),
                progress_observation: Mutex::new(Some(
                    super::super::progress::ProgressObservation::default(),
                )),
            }
        }

        fn returning_with_progress(
            result: IpcResult<DecodedQueryOutcome>,
            observation: super::super::progress::ProgressObservation,
        ) -> Self {
            let executor = Self::returning_grid(result);
            *executor
                .progress_observation
                .lock()
                .expect("progress observation lock") = Some(observation);
            executor
        }

        fn pending_with_cancel_result(result: IpcResult<SqlCancelConfirmation>) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                result: Mutex::new(None),
                command_calls: Mutex::new(Vec::new()),
                command_result: Mutex::new(None),
                raw_calls: Mutex::new(Vec::new()),
                raw_result: Mutex::new(None),
                pending: true,
                cancel_calls: Mutex::new(Vec::new()),
                cancel_result: Mutex::new(Some(result)),
                progress_calls: AtomicUsize::new(0),
                progress_stops: AtomicUsize::new(0),
                progress_observation: Mutex::new(Some(
                    super::super::progress::ProgressObservation::default(),
                )),
            }
        }

        fn unused() -> Self {
            Self::returning(Ok(empty_decoded_outcome()))
        }

        fn calls(&self) -> Vec<ManagedGridCall> {
            self.calls.lock().expect("calls lock").clone()
        }

        fn grid_calls(&self) -> Vec<ManagedGridCall> {
            self.calls()
        }

        fn command_calls(&self) -> Vec<RecordedCommandCall> {
            self.command_calls
                .lock()
                .expect("command calls lock")
                .clone()
        }

        fn raw_calls(&self) -> Vec<RawQueryCall> {
            self.raw_calls.lock().expect("Raw calls lock").clone()
        }

        fn cancel_calls(&self) -> Vec<String> {
            self.cancel_calls.lock().expect("cancel calls lock").clone()
        }

        fn progress_counts(&self) -> (usize, usize) {
            (
                self.progress_calls.load(Ordering::SeqCst),
                self.progress_stops.load(Ordering::SeqCst),
            )
        }
    }

    #[async_trait]
    impl ManagedQueryExecutor for RecordingManagedExecutor {
        async fn execute_grid(&self, call: ManagedGridCall) -> IpcResult<DecodedQueryOutcome> {
            self.calls.lock().expect("calls lock").push(call);
            if self.pending {
                return pending().await;
            }
            self.result
                .lock()
                .expect("result lock")
                .take()
                .expect("one fake result")
        }

        async fn execute_command(
            &self,
            call: ManagedCommandCall,
        ) -> IpcResult<Option<SqlExecutionSummary>> {
            self.command_calls
                .lock()
                .expect("command calls lock")
                .push(RecordedCommandCall {
                    sql: call.sql,
                    policy: call.policy,
                });
            self.command_result
                .lock()
                .expect("command result lock")
                .take()
                .expect("one fake command result")
        }

        async fn execute_raw(
            &self,
            call: RawQueryCall,
            mut writer: RawArtifactWriter,
            _cancellation: watch::Receiver<bool>,
        ) -> IpcResult<RawQueryOutcome> {
            self.raw_calls.lock().expect("Raw calls lock").push(call);
            if self.pending {
                return pending().await;
            }
            match self
                .raw_result
                .lock()
                .expect("Raw result lock")
                .take()
                .expect("one fake Raw result")
            {
                RecordingRawResult::Artifact { bytes, summary } => {
                    writer.write_chunk(&bytes)?;
                    let descriptor = writer.finish(RawArtifactPreviewMode::Text)?;
                    Ok(RawQueryOutcome::Artifact {
                        format: "CSV".to_string(),
                        media_type: "text/csv".to_string(),
                        descriptor,
                        summary,
                    })
                }
                RecordingRawResult::ServerOutfile { summary } => {
                    writer.abort()?;
                    Ok(RawQueryOutcome::ServerOutfile { summary })
                }
            }
        }

        async fn cancel_target_query(
            &self,
            target_query_id: &str,
        ) -> IpcResult<SqlCancelConfirmation> {
            self.cancel_calls
                .lock()
                .expect("cancel calls lock")
                .push(target_query_id.to_string());
            self.cancel_result
                .lock()
                .expect("cancel result lock")
                .take()
                .expect("one fake cancel result")
        }

        async fn poll_progress(
            &self,
            _target_query_id: String,
            _control: SqlExecutionControl,
            mut stop: watch::Receiver<bool>,
        ) -> super::super::progress::ProgressObservation {
            self.progress_calls.fetch_add(1, Ordering::SeqCst);
            if !*stop.borrow() {
                let _ = stop.changed().await;
            }
            self.progress_stops.fetch_add(1, Ordering::SeqCst);
            self.progress_observation
                .lock()
                .expect("progress observation lock")
                .take()
                .expect("one fake progress observation")
        }
    }

    #[derive(Default)]
    struct RecordingObserver {
        summaries: Mutex<Vec<(SqlExecutionSummary, bool)>>,
        warnings: Mutex<Vec<String>>,
    }

    impl SqlExecutionObserver for RecordingObserver {
        fn publish_summary(&self, summary: SqlExecutionSummary, available: bool) {
            self.summaries
                .lock()
                .expect("summaries lock")
                .push((summary, available));
        }

        fn publish_warning(&self, message: String) {
            self.warnings.lock().expect("warnings lock").push(message);
        }
    }

    struct RecordingControl {
        control: SqlExecutionControl,
        _cancel: watch::Sender<bool>,
        observer: Arc<RecordingObserver>,
    }

    fn recording_control() -> RecordingControl {
        let (cancel, receiver) = watch::channel(false);
        let observer = Arc::new(RecordingObserver::default());
        RecordingControl {
            control: SqlExecutionControl::new(receiver, observer.clone()),
            _cancel: cancel,
            observer,
        }
    }

    fn managed_request(sql: &str, timeout_ms: Option<u64>) -> ManagedSqlExecutionRequest {
        managed_request_with_mode(sql, SqlResultMode::Grid, timeout_ms)
    }

    fn managed_request_with_class(
        sql: &str,
        statement_class: SqlStatementClass,
    ) -> ManagedSqlExecutionRequest {
        let mut request = managed_request(sql, Some(30_000));
        request.statement_class = statement_class;
        request
    }

    fn managed_request_with_mode(
        sql: &str,
        result_mode: SqlResultMode,
        timeout_ms: Option<u64>,
    ) -> ManagedSqlExecutionRequest {
        ManagedSqlExecutionRequest {
            execution_id: "execution-1".to_string(),
            query_id: "query-1".to_string(),
            context: SqlExecutionContext {
                database: Some("analytics".to_string()),
                schema: None,
            },
            sql: sql.to_string(),
            options: SqlExecutionOptions {
                result_mode,
                timeout_ms,
                page: 1,
                page_size: 100,
            },
            statement_class: SqlStatementClass::Unknown,
            raw_artifact: None,
        }
    }

    fn managed_raw_request(
        sql: &str,
        timeout_ms: Option<u64>,
    ) -> (
        tempfile::TempDir,
        RawArtifactStore,
        ManagedSqlExecutionRequest,
    ) {
        let root = tempfile::tempdir().expect("managed Raw root");
        let store = RawArtifactStore::for_test(
            root.path().to_path_buf(),
            RawArtifactLimits {
                max_bytes: 1_024,
                preview_bytes: 64,
                binary_preview_bytes: 16,
            },
        );
        let writer = store
            .start(RawArtifactOwner {
                profile_id: "profile-1".to_string(),
                tab_id: "tab-1".to_string(),
                execution_id: "execution-1".to_string(),
            })
            .expect("managed Raw writer");
        let mut request = managed_request_with_mode(sql, SqlResultMode::Raw, timeout_ms);
        request.raw_artifact = Some(writer);
        (root, store, request)
    }

    fn readonly_result(rows: Vec<Vec<serde_json::Value>>) -> QueryResult {
        QueryResult {
            columns: Vec::new(),
            rows,
            affected_rows: None,
            has_next_page: false,
            source_writable: false,
            source_insertable: false,
            primary_key_columns: Vec::new(),
            stable_order_columns: Vec::new(),
            row_locator_strategy: None,
        }
    }

    fn header_summary(read_rows: u64, result_rows: u64) -> SqlExecutionSummary {
        SqlExecutionSummary {
            read_rows: Some(read_rows),
            result_rows: Some(result_rows),
            source: SqlSummarySource::ResponseHeader,
            completeness: SqlSummaryCompleteness::Unknown,
            ..SqlExecutionSummary::default()
        }
    }

    fn empty_decoded_outcome() -> DecodedQueryOutcome {
        DecodedQueryOutcome {
            result: readonly_result(Vec::new()),
            summary: None,
        }
    }

    #[tokio::test]
    async fn read_only_access_never_selects_the_direct_command_path() {
        let executor = RecordingManagedExecutor::returning(Err(IpcError::validation_failed(
            "fake readonly server rejection",
        )));
        let fixture = recording_control();
        let request = managed_request_with_class(
            "CREATE TABLE t (id UInt64) ENGINE=Memory",
            SqlStatementClass::Ddl,
        );

        let error = execute_managed_with(
            &executor,
            request,
            fixture.control,
            SqlStatementAccess::ReadOnly,
        )
        .await
        .expect_err("read-only access must not execute a direct command");

        assert_eq!(error.code, ErrorCode::ValidationFailed);
        assert_eq!(executor.calls().len(), 1);
        assert_eq!(executor.calls()[0].policy, ExecutionPolicy::ReadOnlyGrid);
    }

    #[tokio::test]
    async fn managed_direct_commands_preserve_sql_and_never_invent_affected_rows() {
        for (sql, class, mutation_submitted) in [
            (
                "CREATE TABLE t (id UInt64) ENGINE=Memory",
                SqlStatementClass::Ddl,
                false,
            ),
            ("INSERT INTO t VALUES (1)", SqlStatementClass::Insert, false),
            (
                "ALTER TABLE t UPDATE id = 2 WHERE id = 1",
                SqlStatementClass::Mutation,
                true,
            ),
        ] {
            let executor = RecordingManagedExecutor::returning_command(None);
            let fixture = recording_control();
            let outcome = execute_managed_with(
                &executor,
                managed_request_with_class(sql, class),
                fixture.control,
                SqlStatementAccess::Direct,
            )
            .await
            .expect("direct command succeeds");

            assert!(matches!(
                outcome,
                SqlExecutionOutcome::Command {
                    statement_class,
                    summary: None,
                    mutation_submitted: actual,
                    ..
                } if statement_class == class && actual == mutation_submitted
            ));
            assert_eq!(executor.command_calls()[0].sql, sql);
            assert_eq!(
                executor.command_calls()[0].policy,
                ExecutionPolicy::DirectGrid,
            );
            assert!(executor.grid_calls().is_empty());
        }
    }

    #[tokio::test]
    async fn command_outcome_does_not_promote_partial_live_progress_to_final_summary() {
        let executor = RecordingManagedExecutor::returning_command(None);
        *executor
            .progress_observation
            .lock()
            .expect("progress observation lock") =
            Some(super::super::progress::ProgressObservation {
                latest: Some(SqlExecutionSummary {
                    written_rows: Some(1),
                    source: SqlSummarySource::LivePoll,
                    completeness: SqlSummaryCompleteness::Partial,
                    ..SqlExecutionSummary::default()
                }),
                available: true,
            });
        let fixture = recording_control();

        let outcome = execute_managed_with(
            &executor,
            managed_request_with_class("INSERT INTO t VALUES (1)", SqlStatementClass::Insert),
            fixture.control,
            SqlStatementAccess::Direct,
        )
        .await
        .expect("direct insert succeeds");

        assert!(matches!(
            outcome,
            SqlExecutionOutcome::Command { summary: None, .. }
        ));
        let summaries = fixture.observer.summaries.lock().expect("summaries lock");
        let published = summaries
            .last()
            .expect("partial progress remains observable");
        assert_eq!(published.0.written_rows, Some(1));
        assert_eq!(published.0.source, SqlSummarySource::LivePoll);
        assert_eq!(published.0.completeness, SqlSummaryCompleteness::Partial);
        assert!(published.1);
    }

    #[tokio::test]
    async fn direct_read_stays_on_bounded_readonly_grid_and_unknown_is_server_authoritative() {
        let read = RecordingManagedExecutor::returning_grid(Ok(empty_decoded_outcome()));
        execute_managed_with(
            &read,
            managed_request_with_class("SELECT 1", SqlStatementClass::Read),
            recording_control().control,
            SqlStatementAccess::Direct,
        )
        .await
        .expect("read succeeds");
        assert_eq!(read.grid_calls()[0].policy, ExecutionPolicy::ReadOnlyGrid);

        let unknown = RecordingManagedExecutor::returning_grid(Ok(empty_decoded_outcome()));
        let outcome = execute_managed_with(
            &unknown,
            managed_request_with_class("FUTURE COMMAND", SqlStatementClass::Unknown),
            recording_control().control,
            SqlStatementAccess::Direct,
        )
        .await
        .expect("unknown reaches ClickHouse");
        assert_eq!(unknown.grid_calls()[0].policy, ExecutionPolicy::DirectGrid);
        assert!(matches!(outcome, SqlExecutionOutcome::Command { .. }));
    }

    #[tokio::test]
    async fn managed_read_preserves_query_id_context_window_and_rows_outcome() {
        let executor = RecordingManagedExecutor::returning(Ok(DecodedQueryOutcome {
            result: readonly_result(vec![vec![json!(1)]]),
            summary: Some(header_summary(10, 1)),
        }));
        let fixture = recording_control();
        let request = managed_request("SELECT 1", Some(60_000));
        let query_id = request.query_id.clone();

        let outcome = execute_managed_with(
            &executor,
            request,
            fixture.control.clone(),
            SqlStatementAccess::ReadOnly,
        )
        .await
        .unwrap();

        assert!(matches!(outcome, SqlExecutionOutcome::Rows { .. }));
        assert_eq!(
            executor.calls(),
            vec![ManagedGridCall {
                database: Some("analytics".to_string()),
                sql: "SELECT 1".to_string(),
                query_id,
                policy: ExecutionPolicy::ReadOnlyGrid,
                timeout_ms: Some(60_000),
                window: QueryWindow {
                    skip_rows: 0,
                    page_size: 100,
                },
            }]
        );
        let summaries = fixture.observer.summaries.lock().expect("summaries lock");
        assert_eq!(summaries.last().unwrap().0.read_rows, Some(10));
        assert!(!summaries.last().unwrap().1);
        assert_eq!(executor.progress_counts(), (1, 1));
    }

    #[tokio::test]
    async fn managed_query_merges_live_progress_with_header_and_joins_poller() {
        let executor = RecordingManagedExecutor::returning_with_progress(
            Ok(DecodedQueryOutcome {
                result: readonly_result(vec![vec![json!(1)]]),
                summary: Some(header_summary(10, 1)),
            }),
            super::super::progress::ProgressObservation {
                latest: Some(SqlExecutionSummary {
                    read_rows: Some(20),
                    memory_usage: Some(4_096),
                    source: SqlSummarySource::LivePoll,
                    completeness: SqlSummaryCompleteness::Partial,
                    ..SqlExecutionSummary::default()
                }),
                available: true,
            },
        );
        let fixture = recording_control();

        execute_managed_with(
            &executor,
            managed_request("SELECT 1", Some(30_000)),
            fixture.control,
            SqlStatementAccess::ReadOnly,
        )
        .await
        .unwrap();

        let summaries = fixture.observer.summaries.lock().expect("summaries lock");
        let final_summary = &summaries.last().expect("merged summary").0;
        assert_eq!(final_summary.read_rows, Some(20));
        assert_eq!(final_summary.result_rows, Some(1));
        assert_eq!(final_summary.memory_usage, Some(4_096));
        assert_eq!(final_summary.source, SqlSummarySource::Merged);
        assert_eq!(executor.progress_counts(), (1, 1));
    }

    #[tokio::test]
    async fn managed_timeout_is_business_operation_timeout() {
        let executor = RecordingManagedExecutor::pending();
        let fixture = recording_control();
        let error = execute_managed_with(
            &executor,
            managed_request("SELECT sleep(1)", Some(5)),
            fixture.control,
            SqlStatementAccess::ReadOnly,
        )
        .await
        .unwrap_err();

        assert_eq!(error.code, ErrorCode::OperationTimeout);
        assert_eq!(error.runtime_impact, RuntimeErrorImpact::BusinessOnly);
        assert_eq!(executor.cancel_calls(), ["query-1"]);
        assert!(fixture
            .observer
            .warnings
            .lock()
            .expect("warnings lock")
            .is_empty());
    }

    #[tokio::test]
    async fn timeout_cleanup_failure_is_a_warning_and_never_changes_timeout() {
        let executor = RecordingManagedExecutor::pending_with_cancel_result(Ok(
            SqlCancelConfirmation::Failed(
                IpcError::validation_failed("fake server stop was not confirmed").into(),
            ),
        ));
        let fixture = recording_control();
        let error = execute_managed_with(
            &executor,
            managed_request("SELECT sleep(1)", Some(5)),
            fixture.control,
            SqlStatementAccess::ReadOnly,
        )
        .await
        .unwrap_err();

        assert_eq!(error.code, ErrorCode::OperationTimeout);
        assert_eq!(executor.cancel_calls(), ["query-1"]);
        assert_eq!(
            fixture
                .observer
                .warnings
                .lock()
                .expect("warnings lock")
                .as_slice(),
            ["执行超时后未确认 ClickHouse 服务端查询停止"],
        );
    }

    #[tokio::test]
    async fn unknown_grid_sql_stays_server_authoritative() {
        let unknown = RecordingManagedExecutor::returning(Ok(empty_decoded_outcome()));
        let unknown_fixture = recording_control();
        execute_managed_with(
            &unknown,
            managed_request("FUTURE COMMAND", Some(30_000)),
            unknown_fixture.control,
            SqlStatementAccess::ReadOnly,
        )
        .await
        .unwrap();
        assert_eq!(unknown.calls().len(), 1);
    }

    #[tokio::test]
    async fn managed_raw_routes_with_writer_and_maps_artifact_and_summary() {
        let executor =
            RecordingManagedExecutor::returning_raw(b"id\n1\n", Some(header_summary(10, 1)));
        let fixture = recording_control();
        let (_root, store, mut request) = managed_raw_request("SELECT 1 FORMAT CSV", Some(60_000));
        request.statement_class = SqlStatementClass::Ddl;

        let outcome = execute_managed_with(
            &executor,
            request,
            fixture.control,
            SqlStatementAccess::ReadOnly,
        )
        .await
        .expect("managed Raw succeeds");

        assert!(matches!(
            outcome,
            SqlExecutionOutcome::Raw {
                format: Some(ref format),
                ref media_type,
                byte_length: 5,
                ref preview,
                preview_truncated: false,
                ..
            } if format == "CSV" && media_type == "text/csv" && preview == "id\n1\n"
        ));
        assert_eq!(store.entry_count_for_test(), 1);
        let calls = executor.raw_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].database.as_deref(), Some("analytics"));
        assert_eq!(calls[0].sql, "SELECT 1 FORMAT CSV");
        assert_eq!(calls[0].query_id, "query-1");
        assert_eq!(calls[0].timeout_ms, Some(60_000));
        assert_eq!(calls[0].directives.format.as_deref(), Some("CSV"));
        assert!(executor.grid_calls().is_empty());
        assert!(executor.command_calls().is_empty());
        let summaries = fixture.observer.summaries.lock().expect("summaries lock");
        assert_eq!(summaries.last().expect("Raw summary").0.read_rows, Some(10));
    }

    #[tokio::test]
    async fn managed_raw_requires_writer_before_executor_call() {
        let executor = RecordingManagedExecutor::unused();
        let fixture = recording_control();
        let request =
            managed_request_with_mode("SELECT 1 FORMAT CSV", SqlResultMode::Raw, Some(30_000));

        let error = execute_managed_with(
            &executor,
            request,
            fixture.control,
            SqlStatementAccess::Direct,
        )
        .await
        .expect_err("Raw writer is required");

        assert_eq!(error.code, ErrorCode::SystemInternal);
        assert!(executor.raw_calls().is_empty());
    }

    #[tokio::test]
    async fn managed_server_outfile_maps_to_command_without_local_artifact() {
        let executor = RecordingManagedExecutor::returning_server_outfile(None);
        let fixture = recording_control();
        let (_root, store, request) = managed_raw_request(
            "SELECT 1 INTO OUTFILE 'server.csv' FORMAT CSV",
            Some(30_000),
        );

        let outcome = execute_managed_with(
            &executor,
            request,
            fixture.control,
            SqlStatementAccess::Direct,
        )
        .await
        .expect("server outfile succeeds");

        assert!(matches!(
            outcome,
            SqlExecutionOutcome::Command {
                ref completion_message,
                summary: None,
                mutation_submitted: false,
                ..
            } if completion_message == "服务端 INTO OUTFILE 执行完成"
        ));
        assert_eq!(store.entry_count_for_test(), 0);
    }

    #[tokio::test]
    async fn managed_raw_cancel_and_timeout_drop_partial_artifacts() {
        let canceled_executor = RecordingManagedExecutor::pending();
        let canceled_fixture = recording_control();
        let (_canceled_root, canceled_store, canceled_request) =
            managed_raw_request("SELECT 1 FORMAT CSV", None);
        let canceled = execute_managed_with(
            &canceled_executor,
            canceled_request,
            canceled_fixture.control,
            SqlStatementAccess::Direct,
        );
        tokio::pin!(canceled);
        tokio::task::yield_now().await;
        canceled_fixture._cancel.send_replace(true);
        assert_eq!(
            canceled.await.expect_err("Raw cancel expected").code,
            ErrorCode::OperationCanceled,
        );
        assert_eq!(canceled_store.entry_count_for_test(), 0);

        let timeout_executor = RecordingManagedExecutor::pending();
        let timeout_fixture = recording_control();
        let (_timeout_root, timeout_store, timeout_request) =
            managed_raw_request("SELECT 1 FORMAT CSV", Some(5));
        assert_eq!(
            execute_managed_with(
                &timeout_executor,
                timeout_request,
                timeout_fixture.control,
                SqlStatementAccess::Direct,
            )
            .await
            .expect_err("Raw timeout expected")
            .code,
            ErrorCode::OperationTimeout,
        );
        assert_eq!(timeout_store.entry_count_for_test(), 0);
    }
}
