use async_trait::async_trait;

use super::classify::validate_managed_sql;
use super::policy::ExecutionPolicy;
use super::{execute_dynamic_query, QueryWindow, QUERY_TIMEOUT_MS};
use crate::engine::drivers::clickhouse::ClickHouseDriver;
use crate::engine::types::{QueryResult, SqlExecutionContext, SqlResultMode};
use crate::error::{IpcError, IpcResult};

#[async_trait]
trait SqlQueryExecutor: Send + Sync {
    async fn execute(
        &self,
        database: Option<&str>,
        sql: &str,
        policy: ExecutionPolicy,
        timeout_ms: Option<u64>,
        window: QueryWindow,
    ) -> IpcResult<QueryResult>;
}

#[async_trait]
impl SqlQueryExecutor for ClickHouseDriver {
    async fn execute(
        &self,
        database: Option<&str>,
        sql: &str,
        policy: ExecutionPolicy,
        timeout_ms: Option<u64>,
        window: QueryWindow,
    ) -> IpcResult<QueryResult> {
        let (base_client, _session_guard) = self.client_for_request().await?;
        let client = database
            .map(|database| base_client.clone().with_database(database))
            .unwrap_or(base_client);
        execute_dynamic_query(
            &client,
            sql,
            &[],
            policy,
            timeout_ms,
            window,
            self.shutdown.subscribe(),
        )
        .await
    }
}

pub(in crate::engine::drivers::clickhouse::query) async fn execute(
    driver: &ClickHouseDriver,
    context: &SqlExecutionContext,
    sql: &str,
    page: u32,
    page_size: u32,
) -> IpcResult<QueryResult> {
    execute_sql_with(driver, context, sql, page, page_size).await
}

async fn execute_sql_with<E: SqlQueryExecutor>(
    executor: &E,
    context: &SqlExecutionContext,
    sql: &str,
    page: u32,
    page_size: u32,
) -> IpcResult<QueryResult> {
    let database = validate_context(context)?;
    validate_managed_sql(sql, SqlResultMode::Grid)?;
    if page == 0 {
        return Err(IpcError::validation_failed(
            "ClickHouse SQL page must be at least 1",
        ));
    }
    let skip_rows = u64::from(page - 1)
        .checked_mul(u64::from(page_size))
        .ok_or_else(|| IpcError::validation_failed("ClickHouse SQL page offset is too large"))?;
    let page_size = usize::try_from(page_size)
        .map_err(|_| IpcError::validation_failed("ClickHouse SQL page size is too large"))?;
    super::validate_free_sql_window(skip_rows, page_size)?;

    executor
        .execute(
            database.as_deref(),
            sql,
            ExecutionPolicy::ReadOnlyGrid,
            Some(QUERY_TIMEOUT_MS),
            QueryWindow {
                skip_rows,
                page_size,
            },
        )
        .await
}

pub(super) fn validate_context(context: &SqlExecutionContext) -> IpcResult<Option<String>> {
    if context
        .schema
        .as_deref()
        .map(str::trim)
        .is_some_and(|schema| !schema.is_empty())
    {
        return Err(IpcError::validation_failed(
            "ClickHouse SQL execution accepts a database context but not a schema context",
        ));
    }

    Ok(context
        .database
        .as_deref()
        .map(str::trim)
        .filter(|database| !database.is_empty())
        .map(str::to_string))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use serde_json::json;

    use super::*;
    use crate::engine::types::{QueryResult, SqlExecutionContext};
    use crate::error::{ErrorCode, IpcError, IpcResult, RuntimeErrorImpact};

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct RecordedCall {
        database: Option<String>,
        sql: String,
        policy: ExecutionPolicy,
        timeout_ms: Option<u64>,
        window: QueryWindow,
    }

    struct RecordingExecutor {
        calls: Mutex<Vec<RecordedCall>>,
        result: Mutex<Option<IpcResult<QueryResult>>>,
    }

    impl RecordingExecutor {
        fn returning(result: IpcResult<QueryResult>) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                result: Mutex::new(Some(result)),
            }
        }

        fn rows(rows: Vec<Vec<serde_json::Value>>) -> Self {
            Self::returning(Ok(readonly_result(rows)))
        }

        fn calls(&self) -> Vec<RecordedCall> {
            self.calls.lock().expect("calls lock").clone()
        }
    }

    #[async_trait]
    impl SqlQueryExecutor for RecordingExecutor {
        async fn execute(
            &self,
            database: Option<&str>,
            sql: &str,
            policy: ExecutionPolicy,
            timeout_ms: Option<u64>,
            window: QueryWindow,
        ) -> IpcResult<QueryResult> {
            self.calls.lock().expect("calls lock").push(RecordedCall {
                database: database.map(str::to_string),
                sql: sql.to_string(),
                policy,
                timeout_ms,
                window,
            });
            self.result
                .lock()
                .expect("result lock")
                .take()
                .expect("one fake result")
        }
    }

    fn context(database: Option<&str>, schema: Option<&str>) -> SqlExecutionContext {
        SqlExecutionContext {
            database: database.map(str::to_string),
            schema: schema.map(str::to_string),
        }
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

    #[test]
    fn validates_database_only_context_without_rewriting_sql() {
        assert_eq!(
            validate_context(&context(Some(" analytics "), None)).unwrap(),
            Some("analytics".to_string())
        );
        assert_eq!(validate_context(&context(None, None)).unwrap(), None);
        assert_eq!(validate_context(&context(Some("  "), None)).unwrap(), None);

        let error = validate_context(&context(None, Some("public"))).unwrap_err();
        assert_eq!(error.code, ErrorCode::ValidationFailed);
    }

    #[tokio::test]
    async fn free_sql_uses_database_client_original_sql_readonly_and_checked_window() {
        let executor = RecordingExecutor::rows(vec![vec![json!(2)], vec![json!(3)]]);
        let sql = "SELECT number FROM numbers(4)";

        let result = execute_sql_with(&executor, &context(Some("analytics"), None), sql, 2, 2)
            .await
            .unwrap();

        assert_eq!(result.rows, vec![vec![json!(2)], vec![json!(3)]]);
        assert_eq!(
            executor.calls(),
            vec![RecordedCall {
                database: Some("analytics".to_string()),
                sql: sql.to_string(),
                policy: ExecutionPolicy::ReadOnlyGrid,
                timeout_ms: Some(QUERY_TIMEOUT_MS),
                window: QueryWindow {
                    skip_rows: 2,
                    page_size: 2,
                },
            }]
        );
    }

    #[tokio::test]
    async fn default_context_uses_the_connection_clients_database() {
        let executor = RecordingExecutor::rows(Vec::new());

        execute_sql_with(&executor, &context(None, None), "SHOW TABLES", 1, 100)
            .await
            .unwrap();

        assert_eq!(executor.calls()[0].database, None);
    }

    #[tokio::test]
    async fn rejects_invalid_page_window_and_protocol_conflicts_before_execution() {
        for (sql, page, page_size) in [
            ("SELECT 1", 0, 100),
            ("SELECT 1", 1, 0),
            ("SELECT 1", 1, 1_001),
            ("SELECT 1", 102, 1_000),
            ("", 1, 100),
            ("SELECT 1; SELECT 2", 1, 100),
            ("SELECT 1 FORMAT JSON", 1, 100),
            ("SELECT 1 INTO OUTFILE 'x'", 1, 100),
        ] {
            let executor = RecordingExecutor::rows(Vec::new());
            let error = execute_sql_with(&executor, &context(None, None), sql, page, page_size)
                .await
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::ValidationFailed, "{sql}");
            assert!(executor.calls().is_empty(), "{sql}");
        }
    }

    #[tokio::test]
    async fn preserves_zero_byte_status_and_readonly_business_error_without_retry() {
        let zero_byte = RecordingExecutor::rows(Vec::new());
        let result = execute_sql_with(&zero_byte, &context(None, None), "EXPLAIN SELECT 1", 1, 100)
            .await
            .unwrap();
        assert!(result.columns.is_empty());
        assert!(result.rows.is_empty());
        assert_eq!(result.affected_rows, None);
        assert!(!result.source_writable);
        assert!(!result.source_insertable);

        let readonly_error = IpcError::validation_failed(
            "ClickHouse rejected the statement under the read-only policy",
        );
        let rejected = RecordingExecutor::returning(Err(readonly_error));
        let error = execute_sql_with(
            &rejected,
            &context(None, None),
            "INSERT INTO events VALUES (1)",
            1,
            100,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ValidationFailed);
        assert_eq!(error.runtime_impact, RuntimeErrorImpact::BusinessOnly);
        assert_eq!(rejected.calls().len(), 1);
        assert_eq!(rejected.calls()[0].policy, ExecutionPolicy::ReadOnlyGrid);
        assert_eq!(rejected.calls()[0].timeout_ms, Some(QUERY_TIMEOUT_MS));
    }
}
