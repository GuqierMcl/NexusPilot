use async_trait::async_trait;

use super::policy::ExecutionPolicy;
use super::{execute_dynamic_query, QueryWindow, QUERY_TIMEOUT_MS};
use crate::engine::drivers::clickhouse::ClickHouseDriver;
use crate::engine::drivers::common::{
    table_browse_sql_plan, table_page_stats, TableBrowseBindValue, TableBrowsePlaceholderStyle,
};
use crate::engine::types::{
    ColumnMeta, ContainerKind, ContainerRef, QueryResult, TableBrowseQuery, TablePageStats,
};
use crate::error::{IpcError, IpcResult};

const MAX_PAGE_SIZE: u32 = 1_000;

#[async_trait]
trait DynamicQueryExecutor: Send + Sync {
    async fn execute(
        &self,
        sql: &str,
        bindings: &[TableBrowseBindValue],
        policy: ExecutionPolicy,
        timeout_ms: Option<u64>,
        window: QueryWindow,
    ) -> IpcResult<QueryResult>;
}

#[async_trait]
impl DynamicQueryExecutor for ClickHouseDriver {
    async fn execute(
        &self,
        sql: &str,
        bindings: &[TableBrowseBindValue],
        policy: ExecutionPolicy,
        timeout_ms: Option<u64>,
        window: QueryWindow,
    ) -> IpcResult<QueryResult> {
        let (client, _session_guard) = self.client_for_request().await?;
        execute_dynamic_query(
            &client,
            sql,
            bindings,
            policy,
            timeout_ms,
            window,
            self.shutdown.subscribe(),
        )
        .await
    }
}

pub(in crate::engine::drivers::clickhouse::query) async fn browse(
    driver: &ClickHouseDriver,
    container: &ContainerRef,
    page: u32,
    page_size: u32,
    query: &TableBrowseQuery,
) -> IpcResult<QueryResult> {
    browse_with(driver, container, page, page_size, query).await
}

pub(in crate::engine::drivers::clickhouse::query) async fn count(
    driver: &ClickHouseDriver,
    container: &ContainerRef,
    page_size: u32,
    query: &TableBrowseQuery,
    requested_page: Option<u32>,
) -> IpcResult<TablePageStats> {
    count_with(driver, container, page_size, query, requested_page).await
}

async fn browse_with<E: DynamicQueryExecutor>(
    executor: &E,
    container: &ContainerRef,
    page: u32,
    page_size: u32,
    query: &TableBrowseQuery,
) -> IpcResult<QueryResult> {
    let (sql, bindings) = build_browse_sql(container, page, page_size, query)?;
    let mut result = executor
        .execute(
            &sql,
            &bindings,
            ExecutionPolicy::ReadOnlyGrid,
            Some(QUERY_TIMEOUT_MS),
            QueryWindow {
                skip_rows: 0,
                page_size: page_size as usize,
            },
        )
        .await?;
    if result.rows.len() > page_size as usize {
        result.has_next_page = true;
        result.rows.truncate(page_size as usize);
    }
    force_readonly_result(&mut result);
    Ok(result)
}

async fn count_with<E: DynamicQueryExecutor>(
    executor: &E,
    container: &ContainerRef,
    page_size: u32,
    query: &TableBrowseQuery,
    requested_page: Option<u32>,
) -> IpcResult<TablePageStats> {
    validate_page_size(page_size)?;
    let (sql, bindings) = build_count_sql(container, query)?;
    let result = executor
        .execute(
            &sql,
            &bindings,
            ExecutionPolicy::ReadOnlyGrid,
            Some(QUERY_TIMEOUT_MS),
            QueryWindow {
                skip_rows: 0,
                page_size: 1,
            },
        )
        .await?;
    let total_rows = parse_count_result(&result)?;
    table_page_stats(total_rows, page_size, requested_page)
}

fn parse_count_result(result: &QueryResult) -> IpcResult<u64> {
    let value = result
        .rows
        .first()
        .and_then(|row| row.first())
        .ok_or_else(|| {
            IpcError::system_internal(
                "ClickHouse count returned no value",
                "count result was missing row 0 column 0",
            )
        })?;
    match value {
        serde_json::Value::Number(value) => value.as_u64().ok_or_else(invalid_count_error),
        serde_json::Value::String(value) => value.parse::<u64>().map_err(|_| invalid_count_error()),
        _ => Err(invalid_count_error()),
    }
}

fn invalid_count_error() -> IpcError {
    IpcError::system_internal(
        "ClickHouse count returned an invalid value",
        "count result was not an unsigned 64-bit integer",
    )
}

fn force_readonly_result(result: &mut QueryResult) {
    result.affected_rows = None;
    result.source_writable = false;
    result.source_insertable = false;
    result.primary_key_columns.clear();
    result.stable_order_columns.clear();
    for column in &mut result.columns {
        column.is_writable = false;
        column.is_primary_key = false;
        column.primary_key_ordinal = None;
        column.is_unique = false;
    }
}

pub(super) fn build_browse_sql(
    container: &ContainerRef,
    page: u32,
    page_size: u32,
    query: &TableBrowseQuery,
) -> IpcResult<(String, Vec<TableBrowseBindValue>)> {
    let (database, object) = validate_table_like_address(container)?;
    if page == 0 {
        return Err(IpcError::validation_failed(
            "ClickHouse table page must be at least 1",
        ));
    }
    validate_page_size(page_size)?;
    let offset = u64::from(page - 1)
        .checked_mul(u64::from(page_size))
        .ok_or_else(|| IpcError::validation_failed("ClickHouse table offset is too large"))?;
    let limit = u64::from(page_size)
        .checked_add(1)
        .ok_or_else(|| IpcError::validation_failed("ClickHouse table limit is too large"))?;
    let query_plan = clickhouse_table_browse_plan(query)?;
    Ok((
        format!(
            "SELECT * FROM {}.{}{}{} LIMIT {limit} OFFSET {offset}",
            quote_identifier(database),
            quote_identifier(object),
            query_plan.where_clause,
            query_plan.order_by_clause,
        ),
        query_plan.bindings,
    ))
}

fn validate_page_size(page_size: u32) -> IpcResult<()> {
    if !(1..=MAX_PAGE_SIZE).contains(&page_size) {
        return Err(IpcError::validation_failed(format!(
            "ClickHouse table page size must be between 1 and {MAX_PAGE_SIZE}"
        )));
    }
    Ok(())
}

pub(super) fn build_count_sql(
    container: &ContainerRef,
    query: &TableBrowseQuery,
) -> IpcResult<(String, Vec<TableBrowseBindValue>)> {
    let (database, object) = validate_table_like_address(container)?;
    let query_plan = clickhouse_table_browse_plan(query)?;
    Ok((
        format!(
            "SELECT count() AS count FROM {}.{}{}",
            quote_identifier(database),
            quote_identifier(object),
            query_plan.where_clause,
        ),
        query_plan.bindings,
    ))
}

pub(super) fn quote_identifier(identifier: &str) -> String {
    let mut quoted = String::with_capacity(identifier.len() + 2);
    quoted.push('`');
    for character in identifier.chars() {
        match character {
            '\\' => quoted.push_str("\\\\"),
            '`' => quoted.push_str("\\`"),
            _ => quoted.push(character),
        }
    }
    quoted.push('`');
    quoted
}

fn clickhouse_table_browse_plan(
    query: &TableBrowseQuery,
) -> IpcResult<crate::engine::drivers::common::TableBrowseSqlPlan> {
    let mut names = Vec::new();
    for column in query
        .filters
        .iter()
        .map(|filter| filter.column.as_str())
        .chain(query.sort.iter().map(|sort| sort.column.as_str()))
    {
        if !names.iter().any(|existing: &String| existing == column) {
            names.push(column.to_string());
        }
    }
    let columns = names
        .into_iter()
        .map(|name| ColumnMeta::readonly_query_column(name, "unknown", true))
        .collect::<Vec<_>>();
    table_browse_sql_plan(
        query,
        &columns,
        quote_identifier,
        TableBrowsePlaceholderStyle::QuestionMark,
    )
}

fn validate_table_like_address(container: &ContainerRef) -> IpcResult<(&str, &str)> {
    if !matches!(
        container.kind,
        ContainerKind::Table | ContainerKind::View | ContainerKind::MaterializedView
    ) || container.group_type.is_some()
        || container.schema.is_some()
        || container.column.is_some()
        || container.object_name.is_some()
        || container.db_index.is_some()
        || container.key.is_some()
        || container.pattern.is_some()
    {
        return Err(IpcError::validation_failed(
            "ClickHouse table browsing requires a complete table-like address",
        ));
    }
    let database = container
        .database
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| IpcError::validation_failed("ClickHouse database name is required"))?;
    let object = container
        .table
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| IpcError::validation_failed("ClickHouse object name is required"))?;
    Ok((database, object))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use serde_json::json;

    use super::*;
    use crate::engine::types::{
        ContainerKind, ContainerRef, QueryResult, TableBrowseFilter, TableBrowseFilterOperator,
        TableBrowseQuery, TableBrowseSort, TableBrowseSortDirection,
    };

    type RecordedCall = (
        String,
        Vec<TableBrowseBindValue>,
        ExecutionPolicy,
        Option<u64>,
        QueryWindow,
    );

    struct RecordingExecutor {
        calls: Mutex<Vec<RecordedCall>>,
        results: Mutex<Vec<QueryResult>>,
    }

    impl RecordingExecutor {
        fn new(results: Vec<QueryResult>) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                results: Mutex::new(results.into_iter().rev().collect()),
            }
        }

        fn calls(&self) -> Vec<RecordedCall> {
            self.calls.lock().expect("calls lock").clone()
        }
    }

    #[async_trait]
    impl DynamicQueryExecutor for RecordingExecutor {
        async fn execute(
            &self,
            sql: &str,
            bindings: &[TableBrowseBindValue],
            policy: ExecutionPolicy,
            timeout_ms: Option<u64>,
            window: QueryWindow,
        ) -> IpcResult<QueryResult> {
            self.calls.lock().expect("calls lock").push((
                sql.to_string(),
                bindings.to_vec(),
                policy,
                timeout_ms,
                window,
            ));
            self.results
                .lock()
                .expect("results lock")
                .pop()
                .ok_or_else(|| IpcError::system_internal("missing fake result", "test fixture"))
        }
    }

    fn query_result(rows: Vec<Vec<serde_json::Value>>) -> QueryResult {
        QueryResult {
            columns: Vec::new(),
            rows,
            affected_rows: Some(99),
            has_next_page: false,
            source_writable: true,
            source_insertable: true,
            primary_key_columns: vec!["id".to_string()],
            stable_order_columns: vec!["id".to_string()],
            row_locator_strategy: None,
        }
    }

    fn table_ref() -> ContainerRef {
        ContainerRef::table(ContainerKind::Table, "analytics", None, "events")
    }

    #[test]
    fn builds_only_approved_table_like_queries() {
        let table = table_ref();
        assert_eq!(
            build_browse_sql(&table, 2, 100, &TableBrowseQuery::default()).unwrap(),
            (
                "SELECT * FROM `analytics`.`events` LIMIT 101 OFFSET 100".to_string(),
                Vec::new()
            )
        );
        assert_eq!(
            build_count_sql(&table, &TableBrowseQuery::default()).unwrap(),
            (
                "SELECT count() AS count FROM `analytics`.`events`".to_string(),
                Vec::new()
            )
        );
        assert!(build_browse_sql(
            &ContainerRef::database("analytics"),
            1,
            100,
            &TableBrowseQuery::default(),
        )
        .is_err());
        for kind in [
            ContainerKind::Table,
            ContainerKind::View,
            ContainerKind::MaterializedView,
        ] {
            let object = ContainerRef::table(kind, "analytics", None, "events");
            assert!(build_browse_sql(&object, 1, 100, &TableBrowseQuery::default()).is_ok());
        }
    }

    #[test]
    fn builds_filter_sort_and_rejects_invalid_pages_and_incomplete_addresses() {
        let table = table_ref();
        let query = TableBrowseQuery {
            filters: vec![TableBrowseFilter {
                column: "id".to_string(),
                operator: TableBrowseFilterOperator::Eq,
                value: Some(json!(1)),
            }],
            sort: vec![TableBrowseSort {
                column: "id".to_string(),
                direction: TableBrowseSortDirection::Asc,
            }],
        };
        assert_eq!(
            build_browse_sql(&table, 1, 100, &query).unwrap(),
            (
                "SELECT * FROM `analytics`.`events` WHERE `id` = ? ORDER BY `id` ASC LIMIT 101 OFFSET 0"
                    .to_string(),
                vec![TableBrowseBindValue::Integer(1)]
            )
        );
        assert!(build_browse_sql(&table, 0, 100, &TableBrowseQuery::default()).is_err());
        assert!(build_browse_sql(&table, 1, 0, &TableBrowseQuery::default()).is_err());
        assert!(build_browse_sql(&table, 1, 1001, &TableBrowseQuery::default()).is_err());
        assert!(build_browse_sql(
            &ContainerRef::table(
                ContainerKind::Table,
                "analytics",
                Some("public".to_string()),
                "events",
            ),
            1,
            100,
            &TableBrowseQuery::default(),
        )
        .is_err());
    }

    #[test]
    fn quotes_backticks_and_backslashes_without_identifier_fragment_escape() {
        assert_eq!(quote_identifier("events"), "`events`");
        assert_eq!(quote_identifier("a`b\\c"), "`a\\`b\\\\c`");
        let object = ContainerRef::table(
            ContainerKind::Table,
            "analytics`prod",
            None,
            "events\\archive",
        );
        let (sql, bindings) =
            build_browse_sql(&object, 1, 10, &TableBrowseQuery::default()).unwrap();
        assert_eq!(
            sql,
            "SELECT * FROM `analytics\\`prod`.`events\\\\archive` LIMIT 11 OFFSET 0"
        );
        assert!(bindings.is_empty());
    }

    #[tokio::test]
    async fn browse_uses_readonly_server_window_and_forces_readonly_resources() {
        let executor = RecordingExecutor::new(vec![query_result(vec![
            vec![json!(1)],
            vec![json!(2)],
            vec![json!(3)],
        ])]);
        let result = browse_with(&executor, &table_ref(), 1, 2, &TableBrowseQuery::default())
            .await
            .unwrap();

        assert_eq!(result.rows, vec![vec![json!(1)], vec![json!(2)]]);
        assert!(result.has_next_page);
        assert_eq!(result.affected_rows, None);
        assert!(!result.source_writable);
        assert!(!result.source_insertable);
        assert!(result.primary_key_columns.is_empty());
        assert!(result.stable_order_columns.is_empty());
        assert_eq!(
            executor.calls(),
            vec![(
                "SELECT * FROM `analytics`.`events` LIMIT 3 OFFSET 0".to_string(),
                Vec::new(),
                ExecutionPolicy::ReadOnlyGrid,
                Some(QUERY_TIMEOUT_MS),
                QueryWindow {
                    skip_rows: 0,
                    page_size: 2,
                },
            )]
        );
    }

    #[tokio::test]
    async fn count_is_exact_lazy_and_uses_common_page_validation() {
        let executor = RecordingExecutor::new(vec![query_result(vec![vec![json!("5")]])]);
        let stats = count_with(
            &executor,
            &table_ref(),
            2,
            &TableBrowseQuery::default(),
            Some(3),
        )
        .await
        .unwrap();
        assert_eq!(stats.total_rows, 5);
        assert_eq!(stats.total_pages, 3);
        assert_eq!(stats.page_size, 2);
        assert_eq!(
            executor.calls(),
            vec![(
                "SELECT count() AS count FROM `analytics`.`events`".to_string(),
                Vec::new(),
                ExecutionPolicy::ReadOnlyGrid,
                Some(QUERY_TIMEOUT_MS),
                QueryWindow {
                    skip_rows: 0,
                    page_size: 1,
                },
            )]
        );

        let invalid_executor =
            RecordingExecutor::new(vec![query_result(vec![vec![json!("not-a-count")]])]);
        assert!(count_with(
            &invalid_executor,
            &table_ref(),
            100,
            &TableBrowseQuery::default(),
            None,
        )
        .await
        .is_err());
    }
}
