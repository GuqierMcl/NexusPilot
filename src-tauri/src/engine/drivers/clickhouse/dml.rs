use std::collections::{BTreeMap, BTreeSet};

use clickhouse::error::Error as ClickHouseError;
use serde::Deserialize;

use crate::engine::types::{
    ContainerKind, ContainerRef, QueryResult, TableCellChange, TableChangeOutcome,
    TableChangeSetCommitResult, TableChangeSetPreview, TableChangeSetRequest,
    TableChangeSetSummary, TableRowKeyPart, TableRowLocator, TableRowLocatorStrategy,
};
use crate::error::{IpcError, IpcResult};

use super::schema::{
    self, ClickHouseColumnDefaultKind, ClickHouseColumnSchema, ClickHouseTableSchema,
};
use super::{error::classify_query_error, ClickHouseDriver};

const MAX_CHANGE_ROWS: usize = 100;
const MAX_CHANGE_CELLS: usize = 2_000;
const SUPPORTED_WRITE_ENGINES: &[&str] = &["MergeTree", "ReplacingMergeTree"];

#[derive(Debug, Clone, clickhouse::Row, Deserialize)]
struct CountRow {
    count: u64,
}

struct PreparedChangeSet {
    table: String,
    preview: TableChangeSetPreview,
    inserts: Vec<String>,
    updates: Vec<PreparedUpdate>,
    deletes: Vec<PreparedDelete>,
}

struct PreparedUpdate {
    statement: String,
    original_predicate: String,
    updated_predicate: String,
    expected_matches: u64,
}

struct PreparedDelete {
    statement: String,
    predicate: String,
    expected_matches: u64,
}

enum ExecuteStatus {
    Applied,
    OutcomeUnknown,
}

pub(super) async fn apply_table_write_capabilities(
    driver: &ClickHouseDriver,
    container: &ContainerRef,
    result: &mut QueryResult,
) {
    if container.kind != ContainerKind::Table {
        return;
    }
    let Ok(schema) = schema::describe_table(driver, container).await else {
        return;
    };
    if !SUPPORTED_WRITE_ENGINES.contains(&schema.engine.family.as_str()) {
        return;
    }

    let schema_columns = schema
        .columns
        .iter()
        .map(|column| (column.name.as_str(), column))
        .collect::<BTreeMap<_, _>>();
    let mut has_writable_column = false;
    let mut has_comparable_column = false;
    for column in &mut result.columns {
        let Some(schema_column) = schema_columns.get(column.name.as_str()) else {
            continue;
        };
        let supported = is_supported_scalar_type(&schema_column.type_name);
        let generated = matches!(
            schema_column.default_kind,
            ClickHouseColumnDefaultKind::Materialized
                | ClickHouseColumnDefaultKind::Alias
                | ClickHouseColumnDefaultKind::Ephemeral
        );
        column.is_writable = supported && !generated;
        has_writable_column |= column.is_writable;
        has_comparable_column |= supported;
        column.is_primary_key = false;
        column.primary_key_ordinal = None;
        column.is_unique = false;
    }

    result.source_insertable = has_writable_column;
    result.source_writable = has_writable_column && has_comparable_column;
    result.primary_key_columns.clear();
    result.row_locator_strategy = result
        .source_writable
        .then_some(TableRowLocatorStrategy::RowSnapshot);
}

pub(super) async fn preview_table_change_set(
    driver: &ClickHouseDriver,
    container: &ContainerRef,
    change_set: &TableChangeSetRequest,
) -> IpcResult<TableChangeSetPreview> {
    let prepared = prepare_change_set(driver, container, change_set).await?;
    verify_match_counts(driver, &prepared).await?;
    Ok(prepared.preview)
}

pub(super) async fn commit_table_change_set(
    driver: &ClickHouseDriver,
    container: &ContainerRef,
    change_set: &TableChangeSetRequest,
) -> IpcResult<TableChangeSetCommitResult> {
    let prepared = prepare_change_set(driver, container, change_set).await?;
    verify_match_counts(driver, &prepared).await?;
    let mut affected_rows = 0_u64;

    for statement in &prepared.inserts {
        let status = match execute_statement(driver, statement, false).await {
            Ok(status) => status,
            Err(_) if affected_rows > 0 => {
                return Ok(outcome_unknown(affected_rows, prepared.preview));
            }
            Err(error) => return Err(error),
        };
        match status {
            ExecuteStatus::Applied => affected_rows = affected_rows.saturating_add(1),
            ExecuteStatus::OutcomeUnknown => {
                return Ok(outcome_unknown(affected_rows, prepared.preview));
            }
        }
    }

    for update in &prepared.updates {
        if let Err(error) = verify_expected_count(
            driver,
            &prepared.table,
            &update.original_predicate,
            update.expected_matches,
        )
        .await
        {
            if affected_rows > 0 {
                return Ok(outcome_unknown(affected_rows, prepared.preview));
            }
            return Err(error);
        }
        let status = match execute_statement(driver, &update.statement, true).await {
            Ok(status) => status,
            Err(_) if affected_rows > 0 => {
                return Ok(outcome_unknown(affected_rows, prepared.preview));
            }
            Err(error) => return Err(error),
        };
        match status {
            ExecuteStatus::Applied => {}
            ExecuteStatus::OutcomeUnknown => {
                return Ok(outcome_unknown(affected_rows, prepared.preview));
            }
        }
        let old_count = count_predicate(driver, &prepared.table, &update.original_predicate).await;
        let new_count = count_predicate(driver, &prepared.table, &update.updated_predicate).await;
        match (old_count, new_count) {
            (Ok(0), Ok(count)) if count == update.expected_matches => {
                affected_rows = affected_rows.saturating_add(update.expected_matches);
            }
            _ => return Ok(outcome_unknown(affected_rows, prepared.preview)),
        }
    }

    for delete in &prepared.deletes {
        if let Err(error) = verify_expected_count(
            driver,
            &prepared.table,
            &delete.predicate,
            delete.expected_matches,
        )
        .await
        {
            if affected_rows > 0 {
                return Ok(outcome_unknown(affected_rows, prepared.preview));
            }
            return Err(error);
        }
        let status = match execute_statement(driver, &delete.statement, true).await {
            Ok(status) => status,
            Err(_) if affected_rows > 0 => {
                return Ok(outcome_unknown(affected_rows, prepared.preview));
            }
            Err(error) => return Err(error),
        };
        match status {
            ExecuteStatus::Applied => {}
            ExecuteStatus::OutcomeUnknown => {
                return Ok(outcome_unknown(affected_rows, prepared.preview));
            }
        }
        match count_predicate(driver, &prepared.table, &delete.predicate).await {
            Ok(0) => affected_rows = affected_rows.saturating_add(delete.expected_matches),
            _ => return Ok(outcome_unknown(affected_rows, prepared.preview)),
        }
    }

    Ok(TableChangeSetCommitResult {
        affected_rows,
        preview: prepared.preview,
        outcome: TableChangeOutcome::Applied,
    })
}

fn outcome_unknown(
    affected_rows: u64,
    preview: TableChangeSetPreview,
) -> TableChangeSetCommitResult {
    TableChangeSetCommitResult {
        affected_rows,
        preview,
        outcome: TableChangeOutcome::OutcomeUnknown,
    }
}

async fn prepare_change_set(
    driver: &ClickHouseDriver,
    container: &ContainerRef,
    change_set: &TableChangeSetRequest,
) -> IpcResult<PreparedChangeSet> {
    validate_change_set_limits(change_set)?;
    let schema = writable_schema(driver, container).await?;
    let table = qualified_table(container)?;
    let columns = schema
        .columns
        .iter()
        .map(|column| (column.name.as_str(), column))
        .collect::<BTreeMap<_, _>>();

    let inserts = change_set
        .inserts
        .iter()
        .map(|insert| render_insert(&table, &columns, &insert.values))
        .collect::<IpcResult<Vec<_>>>()?;
    let updates = change_set
        .updates
        .iter()
        .map(|update| {
            let (parts, expected_matches) = snapshot_locator(&update.locator)?;
            let original_predicate = render_snapshot_predicate(&columns, parts)?;
            let changes = validate_changes(&columns, &update.changes)?;
            if changes
                .iter()
                .any(|change| !parts.iter().any(|part| part.column == change.column))
            {
                return Err(IpcError::validation_failed(
                    "原始行快照缺少被修改列，请刷新表格后重新编辑",
                ));
            }
            let updated_parts = apply_changes_to_snapshot(parts, &changes);
            let updated_predicate = render_snapshot_predicate(&columns, &updated_parts)?;
            let assignments = changes
                .iter()
                .map(|change| {
                    let column = columns[change.column.as_str()];
                    Ok(format!(
                        "{} = {}",
                        quote_identifier(&change.column),
                        render_typed_value(column, &change.value)?
                    ))
                })
                .collect::<IpcResult<Vec<_>>>()?
                .join(", ");
            Ok(PreparedUpdate {
                statement: format!(
                    "ALTER TABLE {table} UPDATE {assignments} WHERE {original_predicate}"
                ),
                original_predicate,
                updated_predicate,
                expected_matches,
            })
        })
        .collect::<IpcResult<Vec<_>>>()?;
    let deletes = change_set
        .deletes
        .iter()
        .map(|locator| {
            let (parts, expected_matches) = snapshot_locator(locator)?;
            let predicate = render_snapshot_predicate(&columns, parts)?;
            Ok(PreparedDelete {
                statement: format!("ALTER TABLE {table} DELETE WHERE {predicate}"),
                predicate,
                expected_matches,
            })
        })
        .collect::<IpcResult<Vec<_>>>()?;

    let statements = inserts
        .iter()
        .cloned()
        .chain(updates.iter().map(|update| update.statement.clone()))
        .chain(deletes.iter().map(|delete| delete.statement.clone()))
        .collect();
    Ok(PreparedChangeSet {
        table,
        preview: TableChangeSetPreview {
            statements,
            summary: TableChangeSetSummary {
                inserts: inserts.len() as u32,
                updates: updates.len() as u32,
                deletes: deletes.len() as u32,
            },
        },
        inserts,
        updates,
        deletes,
    })
}

async fn writable_schema(
    driver: &ClickHouseDriver,
    container: &ContainerRef,
) -> IpcResult<ClickHouseTableSchema> {
    if container.kind != ContainerKind::Table {
        return Err(IpcError::validation_failed(
            "当前对象是只读的；ClickHouse DataTable 只能修改普通数据表",
        ));
    }
    let schema = schema::describe_table(driver, container).await?;
    if !SUPPORTED_WRITE_ENGINES.contains(&schema.engine.family.as_str()) {
        return Err(IpcError::feature_unavailable(format!(
            "当前表使用 {} 引擎，DataTable 暂不能安全写入；请在确认语义后使用 SQL 编辑器",
            schema.engine.family
        )));
    }
    Ok(schema)
}

fn validate_change_set_limits(change_set: &TableChangeSetRequest) -> IpcResult<()> {
    let row_count = change_set.inserts.len() + change_set.updates.len() + change_set.deletes.len();
    if row_count == 0 {
        return Err(IpcError::validation_failed("没有需要保存的数据变更"));
    }
    if row_count > MAX_CHANGE_ROWS {
        return Err(IpcError::validation_failed(format!(
            "一次最多保存 {MAX_CHANGE_ROWS} 行，请分批提交"
        )));
    }
    let cell_count = change_set
        .inserts
        .iter()
        .map(|insert| insert.values.len())
        .chain(change_set.updates.iter().map(|update| update.changes.len()))
        .sum::<usize>();
    if cell_count > MAX_CHANGE_CELLS {
        return Err(IpcError::validation_failed(format!(
            "一次最多保存 {MAX_CHANGE_CELLS} 个单元格，请分批提交"
        )));
    }
    let mut locator_ids = BTreeSet::new();
    for locator in change_set
        .updates
        .iter()
        .map(|update| &update.locator)
        .chain(change_set.deletes.iter())
    {
        let locator_id = serde_json::to_string(locator)
            .map_err(|error| IpcError::system_internal("生成行定位信息失败", error.to_string()))?;
        if !locator_ids.insert(locator_id) {
            return Err(IpcError::validation_failed(
                "同一原始行不能在一次保存中重复修改或删除",
            ));
        }
    }
    Ok(())
}

fn render_insert(
    table: &str,
    columns: &BTreeMap<&str, &ClickHouseColumnSchema>,
    values: &[TableCellChange],
) -> IpcResult<String> {
    let values = validate_changes(columns, values)?;
    if values.is_empty() {
        return Err(IpcError::validation_failed(
            "新增行至少需要填写一个可写列；带默认值的其他列可以留空",
        ));
    }
    let names = values
        .iter()
        .map(|value| quote_identifier(&value.column))
        .collect::<Vec<_>>()
        .join(", ");
    let literals = values
        .iter()
        .map(|value| render_typed_value(columns[value.column.as_str()], &value.value))
        .collect::<IpcResult<Vec<_>>>()?
        .join(", ");
    Ok(format!("INSERT INTO {table} ({names}) VALUES ({literals})"))
}

fn validate_changes<'a>(
    columns: &BTreeMap<&str, &ClickHouseColumnSchema>,
    changes: &'a [TableCellChange],
) -> IpcResult<Vec<&'a TableCellChange>> {
    if changes.is_empty() {
        return Err(IpcError::validation_failed("没有可保存的单元格变更"));
    }
    let mut names = BTreeSet::new();
    for change in changes {
        if !names.insert(change.column.as_str()) {
            return Err(IpcError::validation_failed(format!(
                "列 '{}' 在同一行中重复出现",
                change.column
            )));
        }
        let column = columns.get(change.column.as_str()).ok_or_else(|| {
            IpcError::resource_conflict(format!(
                "列 '{}' 已不存在，请刷新表格后重新编辑",
                change.column
            ))
        })?;
        if !is_writable_column(column) {
            return Err(IpcError::feature_unavailable(format!(
                "列 '{}' 由数据库生成或类型暂不支持写入，请移除该修改",
                change.column
            )));
        }
        let _ = render_typed_value(column, &change.value)?;
    }
    Ok(changes.iter().collect())
}

fn snapshot_locator(locator: &TableRowLocator) -> IpcResult<(&[TableRowKeyPart], u64)> {
    let TableRowLocator::RowSnapshot {
        parts,
        expected_matches,
    } = locator
    else {
        return Err(IpcError::validation_failed(
            "当前 ClickHouse 数据表需要使用原始行快照定位，请刷新后重试",
        ));
    };
    if *expected_matches != 1 || parts.is_empty() {
        return Err(IpcError::validation_failed(
            "原始行快照必须且只能定位一行；请刷新后重试",
        ));
    }
    Ok((parts, *expected_matches))
}

fn render_snapshot_predicate(
    columns: &BTreeMap<&str, &ClickHouseColumnSchema>,
    parts: &[TableRowKeyPart],
) -> IpcResult<String> {
    let mut names = BTreeSet::new();
    let predicates = parts
        .iter()
        .map(|part| {
            if !names.insert(part.column.as_str()) {
                return Err(IpcError::validation_failed("原始行快照包含重复列"));
            }
            let column = columns.get(part.column.as_str()).ok_or_else(|| {
                IpcError::resource_conflict(format!(
                    "列 '{}' 已变化，请刷新表格后重新编辑",
                    part.column
                ))
            })?;
            if !is_supported_scalar_type(&column.type_name) {
                return Err(IpcError::feature_unavailable(format!(
                    "列 '{}' 的类型暂不能用于安全定位，请使用 SQL 编辑器处理",
                    part.column
                )));
            }
            let identifier = quote_identifier(&part.column);
            if part.value.is_null() {
                Ok(format!("isNull({identifier})"))
            } else {
                Ok(format!(
                    "{identifier} = {}",
                    render_typed_value(column, &part.value)?
                ))
            }
        })
        .collect::<IpcResult<Vec<_>>>()?;
    if predicates.is_empty() {
        return Err(IpcError::validation_failed(
            "没有可用于安全定位该行的列；当前仅支持浏览数据",
        ));
    }
    Ok(predicates.join(" AND "))
}

fn apply_changes_to_snapshot(
    parts: &[TableRowKeyPart],
    changes: &[&TableCellChange],
) -> Vec<TableRowKeyPart> {
    let values = changes
        .iter()
        .map(|change| (change.column.as_str(), &change.value))
        .collect::<BTreeMap<_, _>>();
    parts
        .iter()
        .map(|part| TableRowKeyPart {
            column: part.column.clone(),
            value: values
                .get(part.column.as_str())
                .map_or_else(|| part.value.clone(), |value| (*value).clone()),
        })
        .collect()
}

fn is_writable_column(column: &ClickHouseColumnSchema) -> bool {
    is_supported_scalar_type(&column.type_name)
        && !matches!(
            column.default_kind,
            ClickHouseColumnDefaultKind::Materialized
                | ClickHouseColumnDefaultKind::Alias
                | ClickHouseColumnDefaultKind::Ephemeral
        )
}

fn is_supported_scalar_type(type_name: &str) -> bool {
    let mut normalized = type_name.trim();
    loop {
        let Some(inner) = unwrap_type(normalized, "Nullable")
            .or_else(|| unwrap_type(normalized, "LowCardinality"))
        else {
            break;
        };
        normalized = inner.trim();
    }
    [
        "Int8", "Int16", "Int32", "Int64", "Int128", "Int256", "UInt8", "UInt16", "UInt32",
        "UInt64", "UInt128", "UInt256", "Float32", "Float64", "Bool", "String", "Date", "Date32",
        "DateTime", "UUID", "IPv4", "IPv6",
    ]
    .contains(&normalized)
        || [
            "FixedString(",
            "Decimal(",
            "Decimal32(",
            "Decimal64(",
            "Decimal128(",
            "Decimal256(",
            "DateTime(",
            "DateTime64(",
            "Enum8(",
            "Enum16(",
        ]
        .iter()
        .any(|prefix| normalized.starts_with(prefix) && normalized.ends_with(')'))
}

fn unwrap_type<'a>(type_name: &'a str, wrapper: &str) -> Option<&'a str> {
    type_name
        .strip_prefix(wrapper)?
        .strip_prefix('(')?
        .strip_suffix(')')
}

fn scalar_base_type(type_name: &str) -> &str {
    let mut normalized = type_name.trim();
    loop {
        let Some(inner) = unwrap_type(normalized, "Nullable")
            .or_else(|| unwrap_type(normalized, "LowCardinality"))
        else {
            return normalized;
        };
        normalized = inner.trim();
    }
}

fn type_allows_null(type_name: &str) -> bool {
    let normalized = type_name.trim();
    unwrap_type(normalized, "Nullable").is_some()
        || unwrap_type(normalized, "LowCardinality").is_some_and(type_allows_null)
}

fn render_typed_value(
    column: &ClickHouseColumnSchema,
    value: &serde_json::Value,
) -> IpcResult<String> {
    if !is_supported_scalar_type(&column.type_name) {
        return Err(IpcError::feature_unavailable(format!(
            "列 '{}' 的类型 {} 暂不支持 DataTable 写入",
            column.name, column.type_name
        )));
    }
    if value.is_null() {
        if type_allows_null(&column.type_name) {
            return Ok("NULL".to_string());
        }
        return Err(IpcError::validation_failed(format!(
            "列 '{}' 不允许 NULL",
            column.name
        )));
    }
    let text = match value {
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::Bool(value) => {
            if *value {
                "1".to_string()
            } else {
                "0".to_string()
            }
        }
        _ => {
            return Err(IpcError::validation_failed(format!(
                "列 '{}' 需要标量值，数组或对象暂不支持写入",
                column.name
            )));
        }
    };
    let is_non_finite_float = matches!(
        text.trim().to_ascii_lowercase().as_str(),
        "nan" | "+nan" | "-nan" | "inf" | "+inf" | "-inf" | "infinity" | "+infinity" | "-infinity"
    );
    if matches!(scalar_base_type(&column.type_name), "Float32" | "Float64") && is_non_finite_float {
        return Err(IpcError::feature_unavailable(format!(
            "列 '{}' 的非有限浮点值暂不能用于安全写入或定位",
            column.name
        )));
    }
    Ok(format!(
        "CAST('{}' AS {})",
        quote_string(&text),
        column.type_name
    ))
}

async fn verify_match_counts(
    driver: &ClickHouseDriver,
    prepared: &PreparedChangeSet,
) -> IpcResult<()> {
    for update in &prepared.updates {
        verify_expected_count(
            driver,
            &prepared.table,
            &update.original_predicate,
            update.expected_matches,
        )
        .await?;
    }
    for delete in &prepared.deletes {
        verify_expected_count(
            driver,
            &prepared.table,
            &delete.predicate,
            delete.expected_matches,
        )
        .await?;
    }
    Ok(())
}

async fn verify_expected_count(
    driver: &ClickHouseDriver,
    table: &str,
    predicate: &str,
    expected: u64,
) -> IpcResult<()> {
    let actual = count_predicate(driver, table, predicate).await?;
    if actual != expected {
        return Err(IpcError::resource_conflict(format!(
            "远端数据已变化：预期匹配 {expected} 行，实际匹配 {actual} 行；请刷新后重新编辑"
        )));
    }
    Ok(())
}

async fn count_predicate(
    driver: &ClickHouseDriver,
    table: &str,
    predicate: &str,
) -> IpcResult<u64> {
    let sql = format!("SELECT count() AS count FROM {table} WHERE {predicate}");
    let (client, _guard) = driver.client_for_request().await?;
    let request = client.query(&sql).fetch_one::<CountRow>();
    match tokio::time::timeout(driver.timeout, request).await {
        Ok(Ok(row)) => Ok(row.count),
        Ok(Err(error)) => Err(classify_query_error(error, "DataTable match verification")),
        Err(_) => Err(IpcError::network_timeout(
            "核对 ClickHouse 目标行超时，尚未发送写入操作",
            format!("timeout_ms={}", driver.timeout.as_millis()),
        )),
    }
}

async fn execute_statement(
    driver: &ClickHouseDriver,
    statement: &str,
    mutation: bool,
) -> IpcResult<ExecuteStatus> {
    let (client, _guard) = driver.client_for_request().await?;
    let mut query = client
        .query(statement)
        .with_setting("wait_end_of_query", "1");
    if mutation {
        query = query.with_setting("mutations_sync", "1");
    }
    match tokio::time::timeout(driver.timeout, query.execute()).await {
        Ok(Ok(())) => Ok(ExecuteStatus::Applied),
        Ok(Err(ClickHouseError::Network(_) | ClickHouseError::TimedOut)) | Err(_) => {
            Ok(ExecuteStatus::OutcomeUnknown)
        }
        Ok(Err(error)) => Err(classify_query_error(error, "DataTable write")),
    }
}

fn qualified_table(container: &ContainerRef) -> IpcResult<String> {
    let database = container
        .database
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| IpcError::validation_failed("ClickHouse 数据库名称不能为空"))?;
    let table = container
        .table
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| IpcError::validation_failed("ClickHouse 表名不能为空"))?;
    Ok(format!(
        "{}.{}",
        quote_identifier(database),
        quote_identifier(table)
    ))
}

fn quote_identifier(value: &str) -> String {
    format!("`{}`", value.replace('\\', "\\\\").replace('`', "\\`"))
}

fn quote_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::types::{TableChangeSetInsert, TableChangeSetUpdate, TableRowKeyPart};
    use crate::error::ErrorCode;

    fn column(name: &str, type_name: &str) -> ClickHouseColumnSchema {
        ClickHouseColumnSchema {
            name: name.to_string(),
            type_name: type_name.to_string(),
            position: 1,
            default_kind: ClickHouseColumnDefaultKind::None,
            default_expression: None,
            codec_expression: None,
            ttl_expression: None,
            comment: None,
            editability: schema::ClickHouseSchemaEditability::editable(),
        }
    }

    #[test]
    fn renders_typed_scalar_values_without_raw_user_sql() {
        let string = column("name", "String");
        let integer = column("id", "UInt64");

        assert_eq!(
            render_typed_value(&string, &serde_json::json!("O'Reilly")).unwrap(),
            "CAST('O\\'Reilly' AS String)"
        );
        assert_eq!(
            render_typed_value(&integer, &serde_json::json!("18446744073709551615")).unwrap(),
            "CAST('18446744073709551615' AS UInt64)"
        );
        assert_eq!(
            render_typed_value(&string, &serde_json::json!("NaN")).unwrap(),
            "CAST('NaN' AS String)"
        );
    }

    #[test]
    fn supports_datetime_and_nullable_low_cardinality_scalars() {
        let datetime = column("created_at", "DateTime");
        let nullable_label = column("label", "LowCardinality(Nullable(String))");

        assert!(is_supported_scalar_type(&datetime.type_name));
        assert_eq!(
            render_typed_value(&datetime, &serde_json::json!("2026-07-18 12:00:00")).unwrap(),
            "CAST('2026-07-18 12:00:00' AS DateTime)"
        );
        assert_eq!(
            render_typed_value(&nullable_label, &serde_json::Value::Null).unwrap(),
            "NULL"
        );
    }

    #[test]
    fn rejects_non_finite_float_values_but_not_similar_strings() {
        let float = column("score", "Nullable(Float64)");
        let error = render_typed_value(&float, &serde_json::json!("-Infinity")).unwrap_err();

        assert_eq!(error.code, ErrorCode::FeatureUnavailable);
        assert!(error.message.contains("非有限浮点值"));
    }

    #[test]
    fn rejects_generated_and_complex_column_changes() {
        let mut generated = column("normalized", "String");
        generated.default_kind = ClickHouseColumnDefaultKind::Materialized;
        let complex = column("tags", "Array(String)");
        let columns = BTreeMap::from([
            (generated.name.as_str(), &generated),
            (complex.name.as_str(), &complex),
        ]);

        let generated_error = validate_changes(
            &columns,
            &[TableCellChange {
                column: "normalized".to_string(),
                value: serde_json::json!("manual"),
            }],
        )
        .unwrap_err();
        let complex_error = validate_changes(
            &columns,
            &[TableCellChange {
                column: "tags".to_string(),
                value: serde_json::json!(["a"]),
            }],
        )
        .unwrap_err();

        assert_eq!(generated_error.code, ErrorCode::FeatureUnavailable);
        assert_eq!(complex_error.code, ErrorCode::FeatureUnavailable);
    }

    #[test]
    fn enforces_change_set_limits_and_unique_row_targets() {
        let locator = TableRowLocator::RowSnapshot {
            parts: vec![TableRowKeyPart {
                column: "id".to_string(),
                value: serde_json::json!(1),
            }],
            expected_matches: 1,
        };
        let duplicate = TableChangeSetRequest {
            inserts: Vec::new(),
            updates: vec![TableChangeSetUpdate {
                locator: locator.clone(),
                changes: vec![TableCellChange {
                    column: "name".to_string(),
                    value: serde_json::json!("after"),
                }],
            }],
            deletes: vec![locator],
        };
        let too_many_rows = TableChangeSetRequest {
            inserts: (0..=MAX_CHANGE_ROWS)
                .map(|_| TableChangeSetInsert {
                    values: vec![TableCellChange {
                        column: "id".to_string(),
                        value: serde_json::json!(1),
                    }],
                })
                .collect(),
            updates: Vec::new(),
            deletes: Vec::new(),
        };
        let too_many_cells = TableChangeSetRequest {
            inserts: vec![TableChangeSetInsert {
                values: (0..=MAX_CHANGE_CELLS)
                    .map(|index| TableCellChange {
                        column: format!("column_{index}"),
                        value: serde_json::json!(index),
                    })
                    .collect(),
            }],
            updates: Vec::new(),
            deletes: Vec::new(),
        };

        assert!(validate_change_set_limits(&duplicate)
            .unwrap_err()
            .message
            .contains("重复修改或删除"));
        assert!(validate_change_set_limits(&too_many_rows)
            .unwrap_err()
            .message
            .contains("100 行"));
        assert!(validate_change_set_limits(&too_many_cells)
            .unwrap_err()
            .message
            .contains("2000 个单元格"));
    }

    #[test]
    fn quotes_clickhouse_identifiers_and_strings() {
        assert_eq!(quote_identifier("odd\\name`part"), "`odd\\\\name\\`part`");
        assert_eq!(
            quote_string("C:\\temp\\O'Reilly"),
            "C:\\\\temp\\\\O\\'Reilly"
        );
    }

    #[test]
    fn row_snapshot_contract_keeps_primary_key_semantics_separate() {
        let locator = TableRowLocator::RowSnapshot {
            parts: vec![TableRowKeyPart {
                column: "id".to_string(),
                value: serde_json::json!(1),
            }],
            expected_matches: 1,
        };
        let update = TableChangeSetUpdate {
            locator,
            changes: vec![TableCellChange {
                column: "name".to_string(),
                value: serde_json::json!("Ada"),
            }],
        };

        assert!(matches!(
            update.locator,
            TableRowLocator::RowSnapshot {
                expected_matches: 1,
                ..
            }
        ));
    }
}
