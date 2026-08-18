mod browse;
mod cancel;
mod classify;
mod command;
mod format;
mod managed;
mod policy;
mod progress;
mod raw;
mod sql;
mod summary;
pub(super) mod types;
mod values;

use std::time::Duration;

use async_trait::async_trait;
use clickhouse::error::Error as ClickHouseError;
use clickhouse::Client;
use tokio::sync::watch;

use self::format::{FormatDecoder, QueryLimits, RESULT_FORMAT};
use self::policy::ExecutionPolicy;
use crate::engine::drivers::common::TableBrowseBindValue;
use crate::engine::sql_execution::{ManagedSqlExecutionRequest, SqlExecutionControl};
use crate::engine::types::{
    ContainerRef, QueryResult, SqlExecutionContext, SqlExecutionOutcome, SqlExecutionSummary,
    SqlStatementAccess, SqlStatementClass, TableBrowseQuery, TablePageStats,
};
use crate::error::{IpcError, IpcResult};

const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
const QUERY_TIMEOUT_MS: u64 = 30_000;
const MAX_FREE_SQL_SKIP_ROWS: u64 = 100_000;
const MAX_PAGE_SIZE: usize = 1_000;

pub(super) async fn browse_table_data(
    driver: &super::ClickHouseDriver,
    container: &ContainerRef,
    page: u32,
    page_size: u32,
    query: &TableBrowseQuery,
) -> IpcResult<QueryResult> {
    browse::browse(driver, container, page, page_size, query).await
}

pub(super) async fn get_table_page_stats(
    driver: &super::ClickHouseDriver,
    container: &ContainerRef,
    page_size: u32,
    query: &TableBrowseQuery,
    requested_page: Option<u32>,
) -> IpcResult<TablePageStats> {
    browse::count(driver, container, page_size, query, requested_page).await
}

pub(super) async fn execute_sql(
    driver: &super::ClickHouseDriver,
    context: &SqlExecutionContext,
    sql: &str,
    page: u32,
    page_size: u32,
) -> IpcResult<QueryResult> {
    sql::execute(driver, context, sql, page, page_size).await
}

pub(super) fn classify_statement(sql: &str) -> IpcResult<SqlStatementClass> {
    classify::classify_statement(sql)
}

pub(super) fn classify_framed_statement(sql: &str) -> SqlStatementClass {
    classify::classify_framed_statement(sql)
}

pub(super) async fn execute_managed(
    driver: &super::ClickHouseDriver,
    request: ManagedSqlExecutionRequest,
    control: SqlExecutionControl,
    statement_access: SqlStatementAccess,
) -> IpcResult<SqlExecutionOutcome> {
    managed::execute(driver, request, control, statement_access).await
}

pub(super) async fn cancel_managed(
    client: &Client,
    request: crate::engine::sql_execution::ManagedSqlCancelRequest,
) -> IpcResult<crate::engine::sql_execution::SqlCancelConfirmation> {
    cancel::cancel(client, request).await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct QueryWindow {
    pub skip_rows: u64,
    pub page_size: usize,
}

#[derive(Debug)]
pub(super) struct DecodedQueryOutcome {
    pub result: QueryResult,
    pub summary: Option<SqlExecutionSummary>,
}

struct GridQueryRequest<'a> {
    sql: &'a str,
    bindings: &'a [TableBrowseBindValue],
    query_id: Option<&'a str>,
    policy: ExecutionPolicy,
    timeout_ms: Option<u64>,
    window: QueryWindow,
}

#[async_trait]
trait ByteChunkSource {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, ClickHouseError>;
    fn summary(&self) -> Option<SqlExecutionSummary> {
        None
    }
}

struct ClickHouseByteSource {
    cursor: clickhouse::query::BytesCursor,
}

#[async_trait]
impl ByteChunkSource for ClickHouseByteSource {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, ClickHouseError> {
        self.cursor
            .next()
            .await
            .map(|chunk| chunk.map(|bytes| bytes.to_vec()))
    }

    fn summary(&self) -> Option<SqlExecutionSummary> {
        self.cursor.summary().map(summary::from_clickhouse)
    }
}

async fn execute_dynamic_query(
    client: &Client,
    sql: &str,
    bindings: &[TableBrowseBindValue],
    policy: ExecutionPolicy,
    timeout_ms: Option<u64>,
    window: QueryWindow,
    shutdown: watch::Receiver<bool>,
) -> IpcResult<QueryResult> {
    match tokio::time::timeout(
        QUERY_TIMEOUT,
        execute_grid_query(
            client,
            GridQueryRequest {
                sql,
                bindings,
                query_id: None,
                policy,
                timeout_ms,
                window,
            },
            shutdown,
        ),
    )
    .await
    {
        Ok(result) => result.map(|outcome| outcome.result),
        Err(_) => Err(IpcError::network_timeout(
            "ClickHouse query timed out",
            format!("query exceeded {} ms", QUERY_TIMEOUT.as_millis()),
        )),
    }
}

async fn execute_grid_query(
    client: &Client,
    request: GridQueryRequest<'_>,
    shutdown: watch::Receiver<bool>,
) -> IpcResult<DecodedQueryOutcome> {
    let operation = if request.query_id.is_some() {
        "start managed query"
    } else {
        "start query"
    };
    let mut query = request
        .policy
        .apply(client.query(request.sql), request.timeout_ms);
    for binding in request.bindings {
        query = match binding {
            TableBrowseBindValue::String(value) => query.bind(value.as_str()),
            TableBrowseBindValue::Integer(value) => query.bind(*value),
            TableBrowseBindValue::Float(value) => query.bind(*value),
            TableBrowseBindValue::Boolean(value) => query.bind(*value),
        };
    }
    if let Some(query_id) = request.query_id {
        query = query.with_setting("query_id", query_id);
    }
    let cursor = query
        .fetch_bytes(RESULT_FORMAT)
        .map_err(|error| super::error::classify_query_error(error, operation))?;
    let mut source = ClickHouseByteSource { cursor };
    decode_window_until_shutdown(
        &mut source,
        request.window,
        QueryLimits::default(),
        shutdown,
    )
    .await
}

#[cfg(test)]
async fn decode_window<S: ByteChunkSource>(
    source: &mut S,
    window: QueryWindow,
    limits: QueryLimits,
    shutdown: watch::Receiver<bool>,
) -> IpcResult<DecodedQueryOutcome> {
    decode_window_with_timeout(source, window, limits, shutdown, QUERY_TIMEOUT).await
}

#[cfg(test)]
async fn decode_window_with_timeout<S: ByteChunkSource>(
    source: &mut S,
    window: QueryWindow,
    limits: QueryLimits,
    shutdown: watch::Receiver<bool>,
    timeout: Duration,
) -> IpcResult<DecodedQueryOutcome> {
    match tokio::time::timeout(
        timeout,
        decode_window_until_shutdown(source, window, limits, shutdown),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(IpcError::network_timeout(
            "ClickHouse query timed out",
            format!("query exceeded {} ms", timeout.as_millis()),
        )),
    }
}

async fn decode_window_until_shutdown<S: ByteChunkSource>(
    source: &mut S,
    window: QueryWindow,
    limits: QueryLimits,
    mut shutdown: watch::Receiver<bool>,
) -> IpcResult<DecodedQueryOutcome> {
    validate_free_sql_window(window.skip_rows, window.page_size)?;
    if *shutdown.borrow() {
        return Err(query_canceled());
    }

    let retained_limit = window
        .page_size
        .checked_add(1)
        .ok_or_else(|| IpcError::validation_failed("ClickHouse page size is too large"))?;
    let mut decoder = FormatDecoder::new(limits);
    let mut skipped_rows = 0_u64;
    let mut retained_rows = Vec::with_capacity(retained_limit);

    loop {
        let next_chunk = tokio::select! {
            biased;
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return Err(query_canceled());
                }
                continue;
            }
            result = source.next_chunk() => result,
        }
        .map_err(|error| super::error::classify_query_error(error, "read query result"))?;

        let Some(chunk) = next_chunk else {
            let decoded = decoder.finish()?;
            return Ok(DecodedQueryOutcome {
                result: readonly_query_result(decoded.columns, retained_rows, window.page_size),
                summary: source.summary(),
            });
        };

        let stopped = decoder.push_with_rows(&chunk, |row| {
            if skipped_rows < window.skip_rows {
                skipped_rows += 1;
                return false;
            }
            retained_rows.push(row);
            retained_rows.len() >= retained_limit
        })?;
        if stopped {
            let columns = decoder.columns().ok_or_else(|| {
                IpcError::system_internal(
                    "ClickHouse query result is missing headers",
                    "decoder stopped before headers were complete",
                )
            })?;
            return Ok(DecodedQueryOutcome {
                result: readonly_query_result(columns.to_vec(), retained_rows, window.page_size),
                summary: source.summary(),
            });
        }
    }
}

fn validate_free_sql_window(skip_rows: u64, page_size: usize) -> IpcResult<()> {
    if skip_rows > MAX_FREE_SQL_SKIP_ROWS {
        return Err(IpcError::validation_failed(format!(
            "ClickHouse SQL paging can skip at most {MAX_FREE_SQL_SKIP_ROWS} rows; add a filter or LIMIT"
        )));
    }
    if !(1..=MAX_PAGE_SIZE).contains(&page_size) {
        return Err(IpcError::validation_failed(format!(
            "ClickHouse page size must be between 1 and {MAX_PAGE_SIZE}"
        )));
    }
    Ok(())
}

fn readonly_query_result(
    columns: Vec<crate::engine::types::ColumnMeta>,
    mut rows: Vec<Vec<serde_json::Value>>,
    page_size: usize,
) -> QueryResult {
    let has_next_page = rows.len() > page_size;
    rows.truncate(page_size);
    QueryResult {
        columns,
        rows,
        affected_rows: None,
        has_next_page,
        source_writable: false,
        source_insertable: false,
        primary_key_columns: Vec::new(),
        stable_order_columns: Vec::new(),
        row_locator_strategy: None,
    }
}

fn query_canceled() -> IpcError {
    IpcError::operation_canceled("ClickHouse query canceled", "the owning runtime is closing")
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::future::pending;
    use std::time::Duration;

    use async_trait::async_trait;
    use clickhouse::error::Error as ClickHouseError;
    use serde_json::json;
    use tokio::sync::watch;

    use super::*;
    use crate::error::ErrorCode;

    struct FakeByteSource {
        chunks: VecDeque<Result<Vec<u8>, ClickHouseError>>,
        calls: usize,
    }

    impl FakeByteSource {
        fn lines(lines: &[&str]) -> Self {
            Self {
                chunks: lines
                    .iter()
                    .map(|line| Ok(format!("{line}\n").into_bytes()))
                    .collect(),
                calls: 0,
            }
        }
    }

    #[async_trait]
    impl ByteChunkSource for FakeByteSource {
        async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, ClickHouseError> {
            self.calls += 1;
            self.chunks.pop_front().transpose()
        }
    }

    struct PendingByteSource;

    #[async_trait]
    impl ByteChunkSource for PendingByteSource {
        async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, ClickHouseError> {
            pending().await
        }
    }

    #[tokio::test]
    async fn query_window_skips_collects_extra_and_releases_source_early() {
        let mut source = FakeByteSource::lines(&[
            r#"["id"]"#,
            r#"["UInt64"]"#,
            "[1]",
            "[2]",
            "[3]",
            "[4]",
            "[5]",
        ]);
        let (_shutdown_sender, shutdown) = watch::channel(false);
        let result = decode_window(
            &mut source,
            QueryWindow {
                skip_rows: 1,
                page_size: 2,
            },
            QueryLimits::default(),
            shutdown,
        )
        .await
        .unwrap();
        let result = result.result;

        assert_eq!(result.rows, vec![vec![json!(2)], vec![json!(3)]]);
        assert!(result.has_next_page);
        assert_eq!(source.calls, 6);
        assert!(!result.source_writable);
        assert!(!result.source_insertable);
        assert!(result.primary_key_columns.is_empty());
        assert!(result.stable_order_columns.is_empty());
    }

    #[tokio::test]
    async fn bounded_query_honors_shutdown_timeout_and_max_skip() {
        let mut canceled_source = PendingByteSource;
        let (shutdown_sender, shutdown) = watch::channel(false);
        let canceled_query = decode_window_with_timeout(
            &mut canceled_source,
            QueryWindow {
                skip_rows: 0,
                page_size: 100,
            },
            QueryLimits::default(),
            shutdown,
            Duration::from_secs(1),
        );
        tokio::pin!(canceled_query);
        tokio::task::yield_now().await;
        shutdown_sender.send_replace(true);
        let canceled = canceled_query.await.unwrap_err();
        assert_eq!(canceled.code, ErrorCode::OperationCanceled);

        let mut timed_source = PendingByteSource;
        let (_shutdown_sender, shutdown) = watch::channel(false);
        let timed_out = decode_window_with_timeout(
            &mut timed_source,
            QueryWindow {
                skip_rows: 0,
                page_size: 100,
            },
            QueryLimits::default(),
            shutdown,
            Duration::from_millis(5),
        )
        .await
        .unwrap_err();
        assert_eq!(timed_out.code, ErrorCode::NetworkTimeout);

        assert!(validate_free_sql_window(100_001, 100).is_err());
        assert!(validate_free_sql_window(0, 0).is_err());
        assert!(validate_free_sql_window(0, 1_001).is_err());
    }

    #[tokio::test]
    async fn zero_byte_success_produces_an_empty_readonly_status_result() {
        let mut source = FakeByteSource::lines(&[]);
        let (_shutdown_sender, shutdown) = watch::channel(false);
        let result = decode_window(
            &mut source,
            QueryWindow {
                skip_rows: 0,
                page_size: 100,
            },
            QueryLimits::default(),
            shutdown,
        )
        .await
        .unwrap();
        let result = result.result;
        assert!(result.columns.is_empty());
        assert!(result.rows.is_empty());
        assert!(!result.has_next_page);
        assert_eq!(result.affected_rows, None);
    }
}
