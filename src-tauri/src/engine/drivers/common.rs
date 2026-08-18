use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::engine::types::{
    ColumnMeta, ContainerKind, TableBrowseQuery, TableCellChange, TableChangeSetPreview,
    TableChangeSetRequest, TableChangeSetSummary, TableColumnRename, TableColumnSchema,
    TableConstraintKind, TableConstraintSchema, TableForeignKeyReference, TableGeneratedColumn,
    TableIdentityOptions, TableIndexSchema, TablePageStats, TablePartitionOptions, TableRowKey,
    TableRowKeyPart, TableSchema,
};
use crate::error::{IpcError, IpcResult};

pub mod schema_diff;

pub use self::schema_diff::*;

pub fn classify_sqlx_connection_error(error: sqlx::Error, driver: &str) -> IpcError {
    let message = error.to_string();
    if message.contains("password")
        || message.contains("authentication")
        || message.contains("Access denied")
    {
        IpcError::auth_failed(
            format!("{driver} authentication failed. Please check your credentials."),
            message,
        )
    } else if message.contains("timed out")
        || message.contains("timeout")
        || message.contains("connection refused")
    {
        IpcError::network_timeout(
            format!("Could not reach the {driver} server. Please check the host and port."),
            message,
        )
    } else {
        IpcError::system_internal(format!("Failed to connect to {driver}."), message)
    }
}

pub fn classify_sqlx_query_error(error: sqlx::Error) -> IpcError {
    let message = error
        .as_database_error()
        .map(|database_error| database_error.message().to_string())
        .unwrap_or_else(|| error.to_string());
    if message.contains("syntax") || message.contains("Syntax") || message.contains("parse error") {
        IpcError::query_syntax(format!("SQL 语法错误：{message}"), error.to_string())
    } else if message.contains("does not exist")
        || message.contains("Unknown table")
        || message.contains("Unknown column")
    {
        IpcError::resource_not_found(message)
    } else if message.contains("already exists")
        || message.contains("already exist")
        || message.contains("exists")
        || message.contains("Duplicate")
        || message.contains("duplicate")
    {
        IpcError::resource_conflict(message)
    } else {
        IpcError::system_internal(format!("SQL 执行失败：{message}"), error.to_string())
    }
}

pub fn quote_pg_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

pub fn quote_mysql_identifier(identifier: &str) -> String {
    format!("`{}`", identifier.replace('`', "``"))
}

pub fn normalized_non_empty_identifier(identifier: &str, label: &str) -> IpcResult<String> {
    let name = identifier.trim();
    if name.is_empty() {
        return Err(IpcError::query_syntax(
            format!("请填写{label}"),
            format!("{label} identifier must not be empty"),
        ));
    }
    Ok(name.to_string())
}

pub fn mysql_empty_insert_statement(table: &str) -> String {
    format!("INSERT INTO {table} () VALUES ()")
}

pub fn postgres_empty_insert_statement(table: &str) -> String {
    format!("INSERT INTO {table} DEFAULT VALUES")
}

const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const JS_MAX_SAFE_INTEGER_U64: u64 = JS_MAX_SAFE_INTEGER as u64;

pub fn json_i64_for_js_transport(value: i64) -> Value {
    if (-JS_MAX_SAFE_INTEGER..=JS_MAX_SAFE_INTEGER).contains(&value) {
        serde_json::json!(value)
    } else {
        Value::String(value.to_string())
    }
}

pub fn json_u64_for_js_transport(value: u64) -> Value {
    if value <= JS_MAX_SAFE_INTEGER_U64 {
        serde_json::json!(value)
    } else {
        Value::String(value.to_string())
    }
}

pub fn render_sql_literal(value: &Value) -> IpcResult<String> {
    match value {
        Value::Null => Ok("NULL".to_string()),
        Value::Bool(value) => Ok(if *value { "TRUE" } else { "FALSE" }.to_string()),
        Value::Number(number) => {
            if let Some(value) = number.as_i64() {
                return Ok(value.to_string());
            }
            if let Some(value) = number.as_u64() {
                return Ok(value.to_string());
            }
            if let Some(value) = number.as_f64() {
                if value.is_finite() {
                    return Ok(value.to_string());
                }
            }
            Err(IpcError::system_internal(
                "不支持写入该数值",
                "Only finite JSON numbers can be written to table cells",
            ))
        }
        Value::String(value) => {
            if value.contains('\0') {
                return Err(IpcError::system_internal(
                    "不支持写入包含 NUL 字符的字符串",
                    "SQL string literals cannot contain NUL bytes",
                ));
            }
            Ok(format!("'{}'", value.replace('\'', "''")))
        }
        Value::Array(_) | Value::Object(_) => Err(IpcError::system_internal(
            "不支持写入对象或数组",
            "Table mutation values must be null, string, number, or boolean",
        )),
    }
}

pub fn ensure_real_table_for_mutation(kind: &ContainerKind) -> IpcResult<()> {
    if *kind == ContainerKind::Table {
        return Ok(());
    }

    Err(IpcError::resource_not_found(
        "只有真实表支持修改或删除数据，视图和其他对象不可写",
    ))
}

const MAX_TABLE_BROWSE_FILTERS: usize = 10;
const MAX_TABLE_BROWSE_SORTS: usize = 5;

#[derive(Debug, Clone, PartialEq)]
pub enum TableBrowseBindValue {
    String(String),
    Integer(i64),
    Float(f64),
    Boolean(bool),
}

#[derive(Debug, Clone, Copy)]
pub enum TableBrowsePlaceholderStyle {
    QuestionMark,
    DollarNumbered,
    ColonNumbered,
}

#[derive(Debug, Clone, Default)]
pub struct TableBrowseSqlPlan {
    pub where_clause: String,
    pub order_by_clause: String,
    pub bindings: Vec<TableBrowseBindValue>,
}

pub fn table_browse_sql_plan(
    query: &TableBrowseQuery,
    columns: &[ColumnMeta],
    quote_identifier: impl Fn(&str) -> String,
    placeholder_style: TableBrowsePlaceholderStyle,
) -> IpcResult<TableBrowseSqlPlan> {
    use crate::engine::types::{TableBrowseFilterOperator, TableBrowseSortDirection};

    if query.filters.len() > MAX_TABLE_BROWSE_FILTERS {
        return Err(IpcError::validation_failed(format!(
            "Table browsing supports at most {MAX_TABLE_BROWSE_FILTERS} filters"
        )));
    }
    if query.sort.len() > MAX_TABLE_BROWSE_SORTS {
        return Err(IpcError::validation_failed(format!(
            "Table browsing supports at most {MAX_TABLE_BROWSE_SORTS} sort fields"
        )));
    }

    let available = columns
        .iter()
        .map(|column| column.name.as_str())
        .collect::<std::collections::HashSet<_>>();
    let mut bindings = Vec::with_capacity(query.filters.len());
    let mut predicates = Vec::with_capacity(query.filters.len());

    for filter in &query.filters {
        require_table_browse_column(&filter.column, &available)?;
        let column = quote_identifier(&filter.column);
        let predicate = match filter.operator {
            TableBrowseFilterOperator::IsNull | TableBrowseFilterOperator::IsNotNull => {
                if filter.value.is_some() {
                    return Err(IpcError::validation_failed(format!(
                        "Filter '{}' does not accept a value",
                        filter.column
                    )));
                }
                let operator = if filter.operator == TableBrowseFilterOperator::IsNull {
                    "IS NULL"
                } else {
                    "IS NOT NULL"
                };
                format!("{column} {operator}")
            }
            operator => {
                let value = filter.value.as_ref().ok_or_else(|| {
                    IpcError::validation_failed(format!(
                        "Filter '{}' requires a scalar value",
                        filter.column
                    ))
                })?;
                bindings.push(table_browse_bind_value(value)?);
                let placeholder = table_browse_placeholder(placeholder_style, bindings.len());
                let operator = match operator {
                    TableBrowseFilterOperator::Eq => "=",
                    TableBrowseFilterOperator::NotEq => "<>",
                    TableBrowseFilterOperator::Gt => ">",
                    TableBrowseFilterOperator::Gte => ">=",
                    TableBrowseFilterOperator::Lt => "<",
                    TableBrowseFilterOperator::Lte => "<=",
                    TableBrowseFilterOperator::IsNull | TableBrowseFilterOperator::IsNotNull => {
                        unreachable!()
                    }
                };
                format!("{column} {operator} {placeholder}")
            }
        };
        predicates.push(predicate);
    }

    let mut seen_sort_columns = std::collections::HashSet::new();
    let mut orderings = Vec::with_capacity(query.sort.len());
    for sort in &query.sort {
        require_table_browse_column(&sort.column, &available)?;
        if !seen_sort_columns.insert(sort.column.as_str()) {
            return Err(IpcError::validation_failed(format!(
                "Sort column '{}' is duplicated",
                sort.column
            )));
        }
        let direction = match sort.direction {
            TableBrowseSortDirection::Asc => "ASC",
            TableBrowseSortDirection::Desc => "DESC",
        };
        orderings.push(format!("{} {direction}", quote_identifier(&sort.column)));
    }

    Ok(TableBrowseSqlPlan {
        where_clause: if predicates.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", predicates.join(" AND "))
        },
        order_by_clause: if orderings.is_empty() {
            String::new()
        } else {
            format!(" ORDER BY {}", orderings.join(", "))
        },
        bindings,
    })
}

fn require_table_browse_column(
    column: &str,
    available: &std::collections::HashSet<&str>,
) -> IpcResult<()> {
    if column.trim().is_empty() || !available.contains(column) {
        return Err(IpcError::validation_failed(format!(
            "Unknown table query column '{column}'"
        )));
    }
    Ok(())
}

fn table_browse_bind_value(value: &serde_json::Value) -> IpcResult<TableBrowseBindValue> {
    match value {
        serde_json::Value::String(value) => {
            if value.chars().count() > 4096 {
                return Err(IpcError::validation_failed(
                    "Table query filter strings cannot exceed 4096 characters",
                ));
            }
            Ok(TableBrowseBindValue::String(value.clone()))
        }
        serde_json::Value::Bool(value) => Ok(TableBrowseBindValue::Boolean(*value)),
        serde_json::Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                Ok(TableBrowseBindValue::Integer(value))
            } else if let Some(value) = value.as_f64().filter(|value| value.is_finite()) {
                Ok(TableBrowseBindValue::Float(value))
            } else {
                Err(IpcError::validation_failed(
                    "Table query filter numbers must be finite signed values",
                ))
            }
        }
        _ => Err(IpcError::validation_failed(
            "Table query filter values must be strings, numbers, or booleans",
        )),
    }
}

fn table_browse_placeholder(style: TableBrowsePlaceholderStyle, position: usize) -> String {
    match style {
        TableBrowsePlaceholderStyle::QuestionMark => "?".to_string(),
        TableBrowsePlaceholderStyle::DollarNumbered => format!("${position}"),
        TableBrowsePlaceholderStyle::ColonNumbered => format!(":{position}"),
    }
}

pub fn table_page_stats(
    total_rows: u64,
    page_size: u32,
    requested_page: Option<u32>,
) -> IpcResult<TablePageStats> {
    let safe_page_size = page_size.max(1);
    let total_pages = if total_rows == 0 {
        1
    } else {
        total_rows.div_ceil(safe_page_size as u64)
    };

    if let Some(page) = requested_page {
        if page == 0 || page as u64 > total_pages {
            return Err(IpcError::query_syntax(
                format!("页码超出范围，请输入 1 到 {total_pages} 之间的整数"),
                format!("requested page {page} is outside 1..={total_pages}"),
            ));
        }
    }

    Ok(TablePageStats {
        total_rows,
        total_pages,
        page_size: safe_page_size,
    })
}

pub fn ordered_primary_key_columns(columns: &[ColumnMeta]) -> Vec<String> {
    let mut primary_key_columns = columns
        .iter()
        .filter_map(|column| {
            column
                .primary_key_ordinal
                .map(|ordinal| (ordinal, column.name.clone()))
        })
        .collect::<Vec<_>>();
    primary_key_columns.sort_by_key(|(ordinal, _)| *ordinal);
    primary_key_columns
        .into_iter()
        .map(|(_, column)| column)
        .collect()
}

pub fn validate_primary_key(
    columns: &[ColumnMeta],
    primary_key: &TableRowKey,
) -> IpcResult<Vec<TableRowKeyPart>> {
    let primary_key_columns = ordered_primary_key_columns(columns);
    if primary_key_columns.is_empty() {
        return Err(IpcError::system_internal(
            "该表没有主键，暂不支持修改或删除数据",
            "Table mutation requires a complete primary key",
        ));
    }

    let provided: HashMap<&str, &Value> = primary_key
        .iter()
        .map(|part| (part.column.as_str(), &part.value))
        .collect();
    if provided.len() != primary_key.len() {
        return Err(IpcError::system_internal(
            "主键参数重复，无法执行数据变更",
            "Duplicate primary key columns were provided",
        ));
    }

    let expected: HashSet<&str> = primary_key_columns.iter().map(String::as_str).collect();
    let provided_names: HashSet<&str> = provided.keys().copied().collect();
    if expected != provided_names {
        return Err(IpcError::system_internal(
            "主键参数不完整，无法执行数据变更",
            "Provided primary key columns must exactly match the table primary key",
        ));
    }

    primary_key_columns
        .into_iter()
        .map(|column| {
            let value = provided
                .get(column.as_str())
                .ok_or_else(|| {
                    IpcError::system_internal(
                        "主键参数不完整，无法执行数据变更",
                        "Primary key column is missing",
                    )
                })?
                .to_owned();
            Ok(TableRowKeyPart {
                column,
                value: (*value).clone(),
            })
        })
        .collect()
}

pub fn validate_cell_changes(
    columns: &[ColumnMeta],
    changes: &[TableCellChange],
) -> IpcResult<Vec<TableCellChange>> {
    if changes.is_empty() {
        return Err(IpcError::system_internal(
            "没有需要更新的单元格",
            "update_table_row requires at least one change",
        ));
    }

    let column_map: HashMap<&str, &ColumnMeta> = columns
        .iter()
        .map(|column| (column.name.as_str(), column))
        .collect();
    let mut seen = HashSet::new();

    changes
        .iter()
        .map(|change| {
            if !seen.insert(change.column.as_str()) {
                return Err(IpcError::system_internal(
                    "更新参数包含重复列",
                    "Duplicate changed columns were provided",
                ));
            }

            let column = column_map.get(change.column.as_str()).ok_or_else(|| {
                IpcError::resource_not_found(format!("Column '{}' was not found", change.column))
            })?;

            if column.is_primary_key {
                return Err(IpcError::system_internal(
                    "暂不支持修改主键列",
                    "Primary key columns are not editable in table cell mutation",
                ));
            }
            if !column.is_writable {
                return Err(IpcError::system_internal(
                    format!("列 '{}' 不可直接写入", change.column),
                    "Column metadata marks this column as read-only",
                ));
            }

            render_sql_literal(&change.value)?;
            Ok(change.clone())
        })
        .collect()
}

pub fn validate_insert_values(
    columns: &[ColumnMeta],
    values: &[TableCellChange],
) -> IpcResult<Vec<TableCellChange>> {
    let column_map: HashMap<&str, &ColumnMeta> = columns
        .iter()
        .map(|column| (column.name.as_str(), column))
        .collect();
    let mut seen = HashSet::new();

    values
        .iter()
        .map(|value| {
            if !seen.insert(value.column.as_str()) {
                return Err(IpcError::system_internal(
                    "新增参数包含重复列",
                    "Duplicate insert columns were provided",
                ));
            }

            let column = column_map.get(value.column.as_str()).ok_or_else(|| {
                IpcError::resource_not_found(format!("Column '{}' was not found", value.column))
            })?;

            if !column.is_writable {
                return Err(IpcError::system_internal(
                    format!("列 '{}' 不可直接写入", value.column),
                    "Column metadata marks this column as read-only",
                ));
            }

            render_sql_literal(&value.value)?;
            Ok(value.clone())
        })
        .collect()
}

pub fn build_insert_row_statement(
    table: &str,
    quote_identifier: fn(&str) -> String,
    values: &[TableCellChange],
    empty_insert_sql: fn(&str) -> String,
) -> IpcResult<String> {
    if values.is_empty() {
        return Ok(empty_insert_sql(table));
    }

    let columns = values
        .iter()
        .map(|value| quote_identifier(&value.column))
        .collect::<Vec<_>>()
        .join(", ");
    let literals = values
        .iter()
        .map(|value| render_sql_literal(&value.value))
        .collect::<IpcResult<Vec<_>>>()?
        .join(", ");

    Ok(format!(
        "INSERT INTO {table} ({columns}) VALUES ({literals})"
    ))
}

pub fn build_update_row_statement(
    table: &str,
    quote_identifier: fn(&str) -> String,
    primary_key: &[TableRowKeyPart],
    changes: &[TableCellChange],
) -> IpcResult<String> {
    let assignments = changes
        .iter()
        .map(|change| {
            Ok(format!(
                "{} = {}",
                quote_identifier(&change.column),
                render_sql_literal(&change.value)?
            ))
        })
        .collect::<IpcResult<Vec<_>>>()?
        .join(", ");
    let where_clause = primary_key
        .iter()
        .map(|part| {
            Ok(format!(
                "{} = {}",
                quote_identifier(&part.column),
                render_sql_literal(&part.value)?
            ))
        })
        .collect::<IpcResult<Vec<_>>>()?
        .join(" AND ");

    Ok(format!(
        "UPDATE {table} SET {assignments} WHERE {where_clause}"
    ))
}

pub fn build_delete_rows_statement(
    table: &str,
    quote_identifier: fn(&str) -> String,
    primary_keys: &[Vec<TableRowKeyPart>],
) -> IpcResult<String> {
    if primary_keys.is_empty() {
        return Err(IpcError::system_internal(
            "没有需要删除的行",
            "delete_table_rows requires at least one primary key",
        ));
    }

    let where_clause = primary_keys
        .iter()
        .map(|primary_key| {
            let condition = primary_key
                .iter()
                .map(|part| {
                    Ok(format!(
                        "{} = {}",
                        quote_identifier(&part.column),
                        render_sql_literal(&part.value)?
                    ))
                })
                .collect::<IpcResult<Vec<_>>>()?
                .join(" AND ");
            Ok(format!("({condition})"))
        })
        .collect::<IpcResult<Vec<_>>>()?
        .join(" OR ");

    Ok(format!("DELETE FROM {table} WHERE {where_clause}"))
}

pub fn build_table_change_set_preview(
    columns: &[ColumnMeta],
    table: &str,
    quote_identifier: fn(&str) -> String,
    empty_insert_sql: fn(&str) -> String,
    change_set: &TableChangeSetRequest,
) -> IpcResult<TableChangeSetPreview> {
    if change_set.inserts.is_empty()
        && change_set.updates.is_empty()
        && change_set.deletes.is_empty()
    {
        return Err(IpcError::system_internal(
            "没有需要提交的表格变更",
            "table change set must contain at least one insert, update, or delete",
        ));
    }

    let mut statements = Vec::new();

    for insert in &change_set.inserts {
        let values = validate_insert_values(columns, &insert.values)?;
        statements.push(build_insert_row_statement(
            table,
            quote_identifier,
            &values,
            empty_insert_sql,
        )?);
    }

    for update in &change_set.updates {
        let primary_key = update.locator.primary_key_parts().ok_or_else(|| {
            IpcError::validation_failed("当前数据源需要使用主键定位行，请刷新数据后重新编辑")
        })?;
        let primary_key = validate_primary_key(columns, primary_key)?;
        let changes = validate_cell_changes(columns, &update.changes)?;
        statements.push(build_update_row_statement(
            table,
            quote_identifier,
            &primary_key,
            &changes,
        )?);
    }

    if !change_set.deletes.is_empty() {
        let primary_keys = change_set
            .deletes
            .iter()
            .map(|locator| {
                let primary_key = locator.primary_key_parts().ok_or_else(|| {
                    IpcError::validation_failed(
                        "当前数据源需要使用主键定位行，请刷新数据后重新编辑",
                    )
                })?;
                validate_primary_key(columns, primary_key)
            })
            .collect::<IpcResult<Vec<_>>>()?;
        statements.push(build_delete_rows_statement(
            table,
            quote_identifier,
            &primary_keys,
        )?);
    }

    Ok(TableChangeSetPreview {
        statements,
        summary: TableChangeSetSummary {
            inserts: change_set.inserts.len() as u32,
            updates: change_set.updates.len() as u32,
            deletes: change_set.deletes.len() as u32,
        },
    })
}

pub fn classify_redis_error(error: redis::RedisError, context: &str) -> IpcError {
    let message = error.to_string();
    if message.contains("WRONGPASS") || message.contains("NOAUTH") || message.contains("AUTH") {
        IpcError::auth_failed(format!("Redis {context} failed"), message)
    } else if message.contains("timed out") || message.contains("connection refused") {
        IpcError::network_timeout(format!("Redis {context} failed"), message)
    } else {
        IpcError::system_internal(format!("Redis {context} failed"), message)
    }
}

pub fn sql_should_report_affected_rows(sql: &str) -> bool {
    matches!(
        leading_sql_keyword(sql).as_deref(),
        Some(
            "INSERT"
                | "UPDATE"
                | "DELETE"
                | "REPLACE"
                | "MERGE"
                | "UPSERT"
                | "CREATE"
                | "ALTER"
                | "DROP"
                | "TRUNCATE"
                | "RENAME"
                | "GRANT"
                | "REVOKE"
                | "CALL"
                | "DO"
                | "SET"
                | "USE"
                | "BEGIN"
                | "COMMIT"
                | "ROLLBACK"
        )
    )
}

pub fn sql_should_fetch_rows(sql: &str) -> bool {
    matches!(leading_sql_keyword(sql).as_deref(), Some("SELECT" | "WITH"))
}

pub fn sql_is_single_statement(sql: &str) -> bool {
    let mut chars = sql.char_indices().peekable();
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut in_backtick = false;

    while let Some((index, ch)) = chars.next() {
        if in_single_quote {
            if ch == '\\' {
                chars.next();
                continue;
            }
            if ch == '\'' {
                if matches!(chars.peek(), Some((_, '\''))) {
                    chars.next();
                } else {
                    in_single_quote = false;
                }
            }
            continue;
        }

        if in_double_quote {
            if ch == '"' {
                if matches!(chars.peek(), Some((_, '"'))) {
                    chars.next();
                } else {
                    in_double_quote = false;
                }
            }
            continue;
        }

        if in_backtick {
            if ch == '`' {
                if matches!(chars.peek(), Some((_, '`'))) {
                    chars.next();
                } else {
                    in_backtick = false;
                }
            }
            continue;
        }

        match ch {
            '\'' => in_single_quote = true,
            '"' => in_double_quote = true,
            '`' => in_backtick = true,
            '$' => {
                if let Some(delimiter) = postgres_dollar_quote_delimiter_at(&sql[index..]) {
                    let body = &sql[index + delimiter.len()..];
                    let skip_until = body
                        .find(delimiter)
                        .map(|closing_index| {
                            index + delimiter.len() + closing_index + delimiter.len()
                        })
                        .unwrap_or(sql.len());
                    while matches!(chars.peek(), Some((next_index, _)) if *next_index < skip_until)
                    {
                        chars.next();
                    }
                }
            }
            '-' if matches!(chars.peek(), Some((_, '-'))) => {
                chars.next();
                for (_, comment_ch) in chars.by_ref() {
                    if comment_ch == '\n' {
                        break;
                    }
                }
            }
            '#' => {
                for (_, comment_ch) in chars.by_ref() {
                    if comment_ch == '\n' {
                        break;
                    }
                }
            }
            '/' if matches!(chars.peek(), Some((_, '*'))) => {
                chars.next();
                let mut previous = '\0';
                for (_, comment_ch) in chars.by_ref() {
                    if previous == '*' && comment_ch == '/' {
                        break;
                    }
                    previous = comment_ch;
                }
            }
            ';' => return !has_sql_after_comments(&sql[index + ch.len_utf8()..]),
            _ => {}
        }
    }

    true
}

fn postgres_dollar_quote_delimiter_at(sql: &str) -> Option<&str> {
    let rest = sql.strip_prefix('$')?;
    let tag_end = rest.find('$')?;
    let tag = &rest[..tag_end];
    if tag
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    {
        Some(&sql[..tag_end + 2])
    } else {
        None
    }
}

pub(crate) fn leading_sql_keyword(sql: &str) -> Option<String> {
    let mut remaining = sql.trim_start();

    loop {
        if let Some(comment) = remaining.strip_prefix("--") {
            let newline = comment.find('\n')?;
            remaining = comment[newline + 1..].trim_start();
            continue;
        }

        if let Some(comment) = remaining.strip_prefix('#') {
            let newline = comment.find('\n')?;
            remaining = comment[newline + 1..].trim_start();
            continue;
        }

        if let Some(comment) = remaining.strip_prefix("/*") {
            let end = comment.find("*/")?;
            remaining = comment[end + 2..].trim_start();
            continue;
        }

        break;
    }

    let keyword_end = remaining
        .find(|ch: char| ch.is_whitespace() || ch == '(' || ch == ';')
        .unwrap_or(remaining.len());

    if keyword_end == 0 {
        None
    } else {
        Some(remaining[..keyword_end].to_ascii_uppercase())
    }
}

fn has_sql_after_comments(mut remaining: &str) -> bool {
    loop {
        remaining = remaining.trim_start();

        if remaining.is_empty() {
            return false;
        }

        if let Some(comment) = remaining.strip_prefix("--") {
            let Some(newline) = comment.find('\n') else {
                return false;
            };
            remaining = &comment[newline + 1..];
            continue;
        }

        if let Some(comment) = remaining.strip_prefix('#') {
            let Some(newline) = comment.find('\n') else {
                return false;
            };
            remaining = &comment[newline + 1..];
            continue;
        }

        if let Some(comment) = remaining.strip_prefix("/*") {
            let Some(end) = comment.find("*/") else {
                return false;
            };
            remaining = &comment[end + 2..];
            continue;
        }

        return true;
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_table_change_set_preview, diff_table_schema_for_update,
        diff_table_schema_for_update_with_column_renames, json_i64_for_js_transport,
        json_u64_for_js_transport, mysql_empty_insert_statement, normalized_non_empty_identifier,
        ordered_primary_key_columns, postgres_empty_insert_statement, quote_mysql_identifier,
        quote_pg_identifier, render_sql_literal, sql_is_single_statement, sql_should_fetch_rows,
        sql_should_report_affected_rows, table_browse_sql_plan, table_page_stats,
        validate_cell_changes, validate_insert_values, validate_primary_key, TableBrowseBindValue,
        TableBrowsePlaceholderStyle, TableUpdateDiffOptions,
    };
    use crate::engine::types::{
        ColumnDataCategory, ColumnMeta, TableBrowseFilter, TableBrowseFilterOperator,
        TableBrowseQuery, TableBrowseSort, TableBrowseSortDirection, TableCellChange,
        TableChangeSetInsert, TableChangeSetRequest, TableChangeSetUpdate, TableColumnRename,
        TableColumnSchema, TableConstraintKind, TableConstraintSchema, TableForeignKeyReference,
        TableGeneratedColumn, TableGeneratedColumnStorage, TableIdentityGeneration,
        TableIdentityOptions, TableIndexSchema, TablePartitionOptions, TableReferentialAction,
        TableRowKeyPart, TableRowLocator, TableSchema, TableSchemaBasics,
    };
    use serde_json::json;

    #[test]
    fn quotes_postgres_identifiers() {
        assert_eq!(quote_pg_identifier("public"), "\"public\"");
        assert_eq!(quote_pg_identifier("weird\"name"), "\"weird\"\"name\"");
    }

    #[test]
    fn quotes_mysql_identifiers() {
        assert_eq!(quote_mysql_identifier("app"), "`app`");
        assert_eq!(quote_mysql_identifier("odd`name"), "`odd``name`");
    }

    #[test]
    fn validates_non_empty_identifiers() {
        assert_eq!(
            normalized_non_empty_identifier(" app ", "数据库名称").unwrap(),
            "app"
        );
        assert!(normalized_non_empty_identifier("  ", "数据库名称").is_err());
    }

    #[test]
    fn identifies_sql_that_should_report_affected_rows() {
        assert!(sql_should_report_affected_rows(
            "/* leading */\nUPDATE users SET active = TRUE"
        ));
        assert!(sql_should_report_affected_rows(
            "# mysql comment\nDELETE FROM audit_logs"
        ));
        assert!(!sql_should_report_affected_rows(
            "-- pg comment\nSELECT * FROM users"
        ));
        assert!(!sql_should_report_affected_rows(
            "WITH recent AS (SELECT * FROM users) SELECT * FROM recent"
        ));
    }

    #[test]
    fn identifies_sql_that_should_fetch_rows() {
        assert!(sql_should_fetch_rows("-- leading\nSELECT * FROM users"));
        assert!(sql_should_fetch_rows(
            "/* leading */\nWITH recent AS (SELECT * FROM users) SELECT * FROM recent"
        ));
        assert!(!sql_should_fetch_rows("UPDATE users SET active = TRUE"));
        assert!(!sql_should_fetch_rows("BEGIN NULL; END;"));
    }

    #[test]
    fn builds_parameterized_table_browse_plan() {
        let query = TableBrowseQuery {
            filters: vec![TableBrowseFilter {
                column: "name".to_string(),
                operator: TableBrowseFilterOperator::Eq,
                value: Some(json!("Ada")),
            }],
            sort: vec![TableBrowseSort {
                column: "id".to_string(),
                direction: TableBrowseSortDirection::Desc,
            }],
        };
        let columns = vec![
            ColumnMeta::readonly_query_column("id", "INTEGER", false),
            ColumnMeta::readonly_query_column("name", "TEXT", false),
        ];
        let plan = table_browse_sql_plan(
            &query,
            &columns,
            quote_pg_identifier,
            TableBrowsePlaceholderStyle::DollarNumbered,
        )
        .unwrap();

        assert_eq!(plan.where_clause, " WHERE \"name\" = $1");
        assert_eq!(plan.order_by_clause, " ORDER BY \"id\" DESC");
        assert_eq!(
            plan.bindings,
            vec![TableBrowseBindValue::String("Ada".to_string())]
        );
    }

    #[test]
    fn builds_and_validates_table_page_stats() {
        let stats = table_page_stats(0, 100, Some(1)).unwrap();
        assert_eq!(stats.total_rows, 0);
        assert_eq!(stats.total_pages, 1);
        assert_eq!(stats.page_size, 100);

        let stats = table_page_stats(201, 100, Some(3)).unwrap();
        assert_eq!(stats.total_pages, 3);

        assert!(table_page_stats(201, 100, Some(0)).is_err());
        assert!(table_page_stats(201, 100, Some(4)).is_err());
    }

    #[test]
    fn detects_single_sql_statement_for_describe() {
        assert!(sql_is_single_statement("SELECT ';' AS delimiter;"));
        assert!(sql_is_single_statement("SELECT $$a;b$$;"));
        assert!(sql_is_single_statement("SELECT $tag$a;b$tag$;"));
        assert!(sql_is_single_statement(
            "DO $$ BEGIN PERFORM 1; PERFORM 2; END $$;"
        ));
        assert!(sql_is_single_statement("SELECT * FROM users; -- trailing"));
        assert!(sql_is_single_statement(
            "/* leading */\nSELECT * FROM users /* trailing */"
        ));
        assert!(!sql_is_single_statement(
            "UPDATE users SET active = TRUE; SELECT * FROM users"
        ));
        assert!(!sql_is_single_statement("SELECT $$a;b$$; SELECT 2"));
        assert!(!sql_is_single_statement(
            "SELECT * FROM users; /* next */ SELECT * FROM audit_logs"
        ));
    }

    #[test]
    fn renders_safe_sql_literals() {
        assert_eq!(render_sql_literal(&json!(null)).unwrap(), "NULL");
        assert_eq!(render_sql_literal(&json!(true)).unwrap(), "TRUE");
        assert_eq!(render_sql_literal(&json!(42)).unwrap(), "42");
        assert_eq!(
            render_sql_literal(&json!("O'Reilly")).unwrap(),
            "'O''Reilly'"
        );
        assert!(render_sql_literal(&json!({ "nested": true })).is_err());
    }

    #[test]
    fn encodes_unsafe_integers_as_strings_for_js_transport() {
        assert_eq!(
            json_i64_for_js_transport(9_007_199_254_740_991),
            json!(9_007_199_254_740_991_i64)
        );
        assert_eq!(
            json_i64_for_js_transport(9_007_199_254_740_992),
            json!("9007199254740992")
        );
        assert_eq!(
            json_i64_for_js_transport(-9_007_199_254_740_992),
            json!("-9007199254740992")
        );
        assert_eq!(
            json_u64_for_js_transport(9_007_199_254_740_991),
            json!(9_007_199_254_740_991_u64)
        );
        assert_eq!(
            json_u64_for_js_transport(18_446_744_073_709_551_615),
            json!("18446744073709551615")
        );
    }

    #[test]
    fn validates_complete_primary_key_in_ordinal_order() {
        let columns = mutation_columns();
        assert_eq!(
            ordered_primary_key_columns(&columns),
            vec!["tenant_id".to_string(), "id".to_string()]
        );

        let primary_key = validate_primary_key(
            &columns,
            &vec![
                TableRowKeyPart {
                    column: "id".to_string(),
                    value: json!(7),
                },
                TableRowKeyPart {
                    column: "tenant_id".to_string(),
                    value: json!(2),
                },
            ],
        )
        .unwrap();

        assert_eq!(primary_key[0].column, "tenant_id");
        assert_eq!(primary_key[1].column, "id");
    }

    #[test]
    fn rejects_incomplete_primary_key_and_readonly_changes() {
        let columns = mutation_columns();

        assert!(validate_primary_key(
            &columns,
            &vec![TableRowKeyPart {
                column: "id".to_string(),
                value: json!(7),
            }]
        )
        .is_err());

        assert!(validate_cell_changes(
            &columns,
            &vec![TableCellChange {
                column: "id".to_string(),
                value: json!(8),
            }]
        )
        .is_err());
        assert!(validate_cell_changes(
            &columns,
            &vec![TableCellChange {
                column: "generated_name".to_string(),
                value: json!("x"),
            }]
        )
        .is_err());
    }

    #[test]
    fn builds_change_set_preview_for_update_and_delete() {
        let columns = mutation_columns();
        let primary_key = vec![
            TableRowKeyPart {
                column: "tenant_id".to_string(),
                value: json!(2),
            },
            TableRowKeyPart {
                column: "id".to_string(),
                value: json!(7),
            },
        ];
        let preview = build_table_change_set_preview(
            &columns,
            "\"public\".\"users\"",
            quote_pg_identifier,
            postgres_empty_insert_statement,
            &TableChangeSetRequest {
                inserts: Vec::new(),
                updates: vec![TableChangeSetUpdate {
                    locator: TableRowLocator::primary_key(primary_key.clone()),
                    changes: vec![TableCellChange {
                        column: "name".to_string(),
                        value: json!("O'Reilly"),
                    }],
                }],
                deletes: vec![TableRowLocator::primary_key(primary_key)],
            },
        )
        .unwrap();

        assert_eq!(preview.summary.inserts, 0);
        assert_eq!(preview.summary.updates, 1);
        assert_eq!(preview.summary.deletes, 1);
        assert_eq!(
            preview.statements[0],
            "UPDATE \"public\".\"users\" SET \"name\" = 'O''Reilly' WHERE \"tenant_id\" = 2 AND \"id\" = 7"
        );
        assert_eq!(
            preview.statements[1],
            "DELETE FROM \"public\".\"users\" WHERE (\"tenant_id\" = 2 AND \"id\" = 7)"
        );
    }

    #[test]
    fn builds_insert_previews_for_postgres_and_mysql() {
        let columns = mutation_columns();
        let preview = build_table_change_set_preview(
            &columns,
            "\"public\".\"users\"",
            quote_pg_identifier,
            postgres_empty_insert_statement,
            &TableChangeSetRequest {
                inserts: vec![TableChangeSetInsert {
                    values: vec![
                        TableCellChange {
                            column: "tenant_id".to_string(),
                            value: json!(2),
                        },
                        TableCellChange {
                            column: "name".to_string(),
                            value: json!("Ada"),
                        },
                    ],
                }],
                updates: Vec::new(),
                deletes: Vec::new(),
            },
        )
        .unwrap();

        assert_eq!(preview.summary.inserts, 1);
        assert_eq!(
            preview.statements[0],
            "INSERT INTO \"public\".\"users\" (\"tenant_id\", \"name\") VALUES (2, 'Ada')"
        );

        let mysql_preview = build_table_change_set_preview(
            &columns,
            "`users`",
            quote_mysql_identifier,
            mysql_empty_insert_statement,
            &TableChangeSetRequest {
                inserts: vec![TableChangeSetInsert { values: Vec::new() }],
                updates: Vec::new(),
                deletes: Vec::new(),
            },
        )
        .unwrap();

        assert_eq!(
            mysql_preview.statements[0],
            "INSERT INTO `users` () VALUES ()"
        );

        let pg_default_preview = build_table_change_set_preview(
            &columns,
            "\"public\".\"users\"",
            quote_pg_identifier,
            postgres_empty_insert_statement,
            &TableChangeSetRequest {
                inserts: vec![TableChangeSetInsert { values: Vec::new() }],
                updates: Vec::new(),
                deletes: Vec::new(),
            },
        )
        .unwrap();

        assert_eq!(
            pg_default_preview.statements[0],
            "INSERT INTO \"public\".\"users\" DEFAULT VALUES"
        );
    }

    #[test]
    fn builds_mixed_change_set_preview_in_insert_update_delete_order() {
        let columns = mutation_columns();
        let primary_key = vec![
            TableRowKeyPart {
                column: "tenant_id".to_string(),
                value: json!(2),
            },
            TableRowKeyPart {
                column: "id".to_string(),
                value: json!(7),
            },
        ];
        let preview = build_table_change_set_preview(
            &columns,
            "\"public\".\"users\"",
            quote_pg_identifier,
            postgres_empty_insert_statement,
            &TableChangeSetRequest {
                inserts: vec![TableChangeSetInsert {
                    values: vec![TableCellChange {
                        column: "name".to_string(),
                        value: json!("Ada"),
                    }],
                }],
                updates: vec![TableChangeSetUpdate {
                    locator: TableRowLocator::primary_key(primary_key.clone()),
                    changes: vec![TableCellChange {
                        column: "name".to_string(),
                        value: json!("Grace"),
                    }],
                }],
                deletes: vec![TableRowLocator::primary_key(primary_key)],
            },
        )
        .unwrap();

        assert_eq!(preview.summary.inserts, 1);
        assert_eq!(preview.summary.updates, 1);
        assert_eq!(preview.summary.deletes, 1);
        assert!(preview.statements[0].starts_with("INSERT INTO"));
        assert!(preview.statements[1].starts_with("UPDATE"));
        assert!(preview.statements[2].starts_with("DELETE FROM"));
    }

    #[test]
    fn rejects_readonly_insert_values() {
        assert!(validate_insert_values(
            &mutation_columns(),
            &vec![TableCellChange {
                column: "generated_name".to_string(),
                value: json!("x"),
            }]
        )
        .is_err());
    }

    #[test]
    fn rejects_empty_change_set_preview() {
        assert!(build_table_change_set_preview(
            &mutation_columns(),
            "`users`",
            quote_mysql_identifier,
            mysql_empty_insert_statement,
            &TableChangeSetRequest {
                inserts: Vec::new(),
                updates: Vec::new(),
                deletes: Vec::new(),
            },
        )
        .is_err());
    }

    #[test]
    fn diffs_safe_table_schema_updates() {
        let baseline = table_schema();
        let mut target = baseline.clone();
        target.basics.comment = Some("Updated table".to_string());
        target.columns.push(TableColumnSchema {
            name: "email".to_string(),
            type_name: "varchar(255)".to_string(),
            nullable: true,
            default_value: None,
            is_primary_key: false,
            is_unique: false,
            is_identity: false,
            identity: None,
            generated: None,
            charset: None,
            collation: None,
            comment: Some("Contact email".to_string()),
        });
        target.indexes.push(TableIndexSchema {
            name: "idx_users_email".to_string(),
            columns: vec!["email".to_string()],
            is_unique: false,
            method: Some("btree".to_string()),
            comment: None,
        });

        let diff = diff_table_schema_for_update(
            &baseline,
            &target,
            TableUpdateDiffOptions {
                allow_column_comments: true,
            },
        )
        .unwrap();

        assert_eq!(
            diff.table_comment_change
                .as_ref()
                .and_then(|change| change.comment.as_deref()),
            Some("Updated table")
        );
        assert_eq!(diff.added_columns.len(), 1);
        assert_eq!(diff.added_columns[0].name, "email");
        assert_eq!(diff.added_indexes.len(), 1);
        assert_eq!(diff.added_indexes[0].name, "idx_users_email");
        assert!(diff.dropped_indexes.is_empty());
        assert!(diff.column_comment_changes.is_empty());
        assert!(diff.column_default_changes.is_empty());
        assert!(diff.column_nullability_changes.is_empty());
    }

    #[test]
    fn diffs_existing_column_default_and_nullability_changes() {
        let baseline = table_schema();
        let mut target = baseline.clone();
        target.columns[1].nullable = true;
        target.columns[1].default_value = Some("'anonymous'".to_string());

        let diff = diff_table_schema_for_update(
            &baseline,
            &target,
            TableUpdateDiffOptions {
                allow_column_comments: true,
            },
        )
        .unwrap();

        assert_eq!(diff.column_nullability_changes.len(), 1);
        assert_eq!(diff.column_nullability_changes[0].column_name, "name");
        assert!(diff.column_nullability_changes[0].nullable);
        assert_eq!(diff.column_default_changes.len(), 1);
        assert_eq!(diff.column_default_changes[0].column_name, "name");
        assert_eq!(
            diff.column_default_changes[0].default_value.as_deref(),
            Some("'anonymous'")
        );
    }

    #[test]
    fn diffs_existing_column_default_removal() {
        let mut baseline = table_schema();
        baseline.columns[1].default_value = Some("'anonymous'".to_string());
        let mut target = baseline.clone();
        target.columns[1].default_value = None;

        let diff = diff_table_schema_for_update(
            &baseline,
            &target,
            TableUpdateDiffOptions {
                allow_column_comments: true,
            },
        )
        .unwrap();

        assert_eq!(diff.column_default_changes.len(), 1);
        assert_eq!(diff.column_default_changes[0].column_name, "name");
        assert_eq!(diff.column_default_changes[0].default_value, None);
        assert!(diff.column_nullability_changes.is_empty());
    }

    #[test]
    fn diffs_non_primary_constraint_add_drop_and_modify() {
        let baseline = table_schema();
        let mut target = baseline.clone();
        target.columns.push(TableColumnSchema {
            name: "org_id".to_string(),
            type_name: "bigint".to_string(),
            nullable: true,
            default_value: None,
            is_primary_key: false,
            is_unique: false,
            is_identity: false,
            identity: None,
            generated: None,
            charset: None,
            collation: None,
            comment: None,
        });
        target.constraints.push(TableConstraintSchema {
            name: "fk_users_org".to_string(),
            kind: TableConstraintKind::ForeignKey,
            columns: vec!["org_id".to_string()],
            reference: Some("orgs(id)".to_string()),
            expression: None,
            comment: None,
            foreign_key: Some(TableForeignKeyReference {
                database_name: None,
                schema_name: None,
                table_name: "orgs".to_string(),
                columns: vec!["id".to_string()],
                on_update: Some(TableReferentialAction::Cascade),
                on_delete: Some(TableReferentialAction::Restrict),
            }),
            enforced: Some(true),
        });

        let diff = diff_table_schema_for_update(
            &baseline,
            &target,
            TableUpdateDiffOptions {
                allow_column_comments: true,
            },
        )
        .unwrap();

        assert_eq!(diff.added_constraints.len(), 1);
        assert_eq!(diff.added_constraints[0].name, "fk_users_org");

        let mut modified = target.clone();
        modified.constraints[0]
            .foreign_key
            .as_mut()
            .unwrap()
            .on_delete = Some(TableReferentialAction::Cascade);
        let diff = diff_table_schema_for_update(
            &target,
            &modified,
            TableUpdateDiffOptions {
                allow_column_comments: true,
            },
        )
        .unwrap();

        assert_eq!(diff.dropped_constraints.len(), 1);
        assert_eq!(diff.added_constraints.len(), 1);
        assert_eq!(
            diff.added_constraints[0]
                .foreign_key
                .as_ref()
                .and_then(|foreign_key| foreign_key.on_delete.as_ref()),
            Some(&TableReferentialAction::Cascade)
        );
    }

    #[test]
    fn diffs_check_constraint_changes() {
        let baseline = table_schema();
        let mut target = baseline.clone();
        target.constraints.push(TableConstraintSchema {
            name: "ck_users_name".to_string(),
            kind: TableConstraintKind::Check,
            columns: vec!["name".to_string()],
            reference: None,
            expression: Some("char_length(name) > 0".to_string()),
            comment: None,
            foreign_key: None,
            enforced: Some(true),
        });

        let diff = diff_table_schema_for_update(
            &baseline,
            &target,
            TableUpdateDiffOptions {
                allow_column_comments: true,
            },
        )
        .unwrap();

        assert_eq!(diff.added_constraints.len(), 1);
        assert_eq!(diff.added_constraints[0].kind, TableConstraintKind::Check);
    }

    #[test]
    fn diffs_generated_identity_charset_and_table_options() {
        let baseline = table_schema();
        let mut target = baseline.clone();
        target.basics.engine = Some("InnoDB".to_string());
        target.basics.charset = Some("utf8mb4".to_string());
        target.basics.collation = Some("utf8mb4_0900_ai_ci".to_string());
        target.columns[1].generated = Some(TableGeneratedColumn {
            expression: "lower(name)".to_string(),
            storage: TableGeneratedColumnStorage::Stored,
        });
        target.columns[1].charset = Some("utf8mb4".to_string());
        target.columns[1].collation = Some("utf8mb4_0900_ai_ci".to_string());
        target.columns[0].identity = Some(TableIdentityOptions {
            generation: TableIdentityGeneration::Always,
            start: Some("100".to_string()),
            increment: Some("5".to_string()),
            min_value: None,
            max_value: None,
            cache: None,
            cycle: false,
        });

        let diff = diff_table_schema_for_update(
            &baseline,
            &target,
            TableUpdateDiffOptions {
                allow_column_comments: true,
            },
        )
        .unwrap();

        assert_eq!(diff.table_engine_change.as_deref(), Some("InnoDB"));
        assert_eq!(diff.table_charset_change.as_deref(), Some("utf8mb4"));
        assert_eq!(
            diff.table_collation_change.as_deref(),
            Some("utf8mb4_0900_ai_ci")
        );
        assert_eq!(diff.generated_column_changes.len(), 1);
        assert_eq!(diff.identity_changes.len(), 1);
        assert_eq!(diff.column_charset_changes.len(), 1);
    }

    #[test]
    fn rejects_existing_partition_update() {
        let mut baseline = table_schema();
        baseline.basics.partition = Some(TablePartitionOptions {
            expression: Some("HASH(id)".to_string()),
            raw_clause: None,
            readonly_description: Some("PARTITION BY HASH (`id`) PARTITIONS 4".to_string()),
        });
        let mut target = baseline.clone();
        target.basics.partition = Some(TablePartitionOptions {
            expression: Some("HASH(id)".to_string()),
            raw_clause: Some("PARTITION BY HASH(id) PARTITIONS 8".to_string()),
            readonly_description: None,
        });

        let error = diff_table_schema_for_update(
            &baseline,
            &target,
            TableUpdateDiffOptions {
                allow_column_comments: true,
            },
        )
        .unwrap_err();

        assert!(error.message.contains("暂不支持修改已有表分区"));
    }

    #[test]
    fn ignores_whitespace_only_column_default_against_none() {
        let baseline = table_schema();
        let mut target = baseline.clone();
        target.columns[1].default_value = Some("   ".to_string());

        let diff = diff_table_schema_for_update(
            &baseline,
            &target,
            TableUpdateDiffOptions {
                allow_column_comments: true,
            },
        )
        .unwrap();

        assert!(diff.column_default_changes.is_empty());
        assert!(diff.column_nullability_changes.is_empty());
    }

    #[test]
    fn emits_trimmed_column_default_changes() {
        let baseline = table_schema();
        let mut target = baseline.clone();
        target.columns[1].default_value = Some("  'anonymous'  ".to_string());

        let diff = diff_table_schema_for_update(
            &baseline,
            &target,
            TableUpdateDiffOptions {
                allow_column_comments: true,
            },
        )
        .unwrap();

        assert_eq!(diff.column_default_changes.len(), 1);
        assert_eq!(
            diff.column_default_changes[0].default_value.as_deref(),
            Some("'anonymous'")
        );
        assert!(diff.column_nullability_changes.is_empty());
    }

    #[test]
    fn diffs_dropped_indexes_and_column_comments() {
        let baseline = table_schema();
        let mut target = baseline.clone();
        target.indexes.clear();
        target.columns[1].comment = Some("Visible name".to_string());

        let diff = diff_table_schema_for_update(
            &baseline,
            &target,
            TableUpdateDiffOptions {
                allow_column_comments: true,
            },
        )
        .unwrap();

        assert_eq!(diff.dropped_indexes.len(), 1);
        assert_eq!(diff.dropped_indexes[0].name, "idx_users_name");
        assert_eq!(diff.column_comment_changes.len(), 1);
        assert_eq!(diff.column_comment_changes[0].column_name, "name");
        assert_eq!(
            diff.column_comment_changes[0].comment.as_deref(),
            Some("Visible name")
        );
        assert!(diff.column_default_changes.is_empty());
        assert!(diff.column_nullability_changes.is_empty());
    }

    #[test]
    fn diffs_dropped_existing_columns_as_destructive() {
        let baseline = table_schema();
        let mut target = baseline.clone();
        target.indexes.clear();
        target.columns.retain(|column| column.name != "name");

        let diff = diff_table_schema_for_update(
            &baseline,
            &target,
            TableUpdateDiffOptions {
                allow_column_comments: true,
            },
        )
        .unwrap();

        assert_eq!(diff.dropped_columns.len(), 1);
        assert_eq!(diff.dropped_columns[0].name, "name");
        assert!(diff.is_destructive());
    }

    #[test]
    fn diffs_column_renames_and_type_changes() {
        let baseline = table_schema();
        let mut target = baseline.clone();
        target.columns[1].name = "display_name".to_string();
        target.columns[1].type_name = "text".to_string();
        target.indexes[0].columns = vec!["display_name".to_string()];

        let diff = diff_table_schema_for_update_with_column_renames(
            &baseline,
            &target,
            TableUpdateDiffOptions {
                allow_column_comments: true,
            },
            &[TableColumnRename {
                old_name: "name".to_string(),
                new_name: "display_name".to_string(),
            }],
        )
        .unwrap();

        assert_eq!(diff.renamed_columns.len(), 1);
        assert_eq!(diff.renamed_columns[0].old_name, "name");
        assert_eq!(diff.renamed_columns[0].new_name, "display_name");
        assert_eq!(diff.column_type_changes.len(), 1);
        assert_eq!(diff.column_type_changes[0].column_name, "display_name");
        assert_eq!(diff.column_type_changes[0].type_name, "text");
        assert!(diff.added_columns.is_empty());
        assert!(diff.dropped_columns.is_empty());
        assert!(diff.is_destructive());
    }

    #[test]
    fn diffs_changed_indexes_as_drop_and_add() {
        let baseline = table_schema();
        let mut target = baseline.clone();
        target.indexes[0].is_unique = true;
        target.indexes[0].method = Some("hash".to_string());

        let diff = diff_table_schema_for_update(
            &baseline,
            &target,
            TableUpdateDiffOptions {
                allow_column_comments: true,
            },
        )
        .unwrap();

        assert_eq!(diff.dropped_indexes.len(), 1);
        assert_eq!(diff.dropped_indexes[0].name, "idx_users_name");
        assert_eq!(diff.added_indexes.len(), 1);
        assert_eq!(diff.added_indexes[0].name, "idx_users_name");
        assert!(diff.added_indexes[0].is_unique);
        assert_eq!(diff.added_indexes[0].method.as_deref(), Some("hash"));
    }

    #[test]
    fn diffs_primary_key_changes_from_column_flags() {
        let mut baseline = table_schema();
        baseline.columns[0].is_identity = false;
        let mut target = baseline.clone();
        target.columns[0].is_primary_key = false;
        target.columns[1].is_primary_key = true;

        let diff = diff_table_schema_for_update(
            &baseline,
            &target,
            TableUpdateDiffOptions {
                allow_column_comments: true,
            },
        )
        .unwrap();

        let change = diff.primary_key_change.as_ref().unwrap();
        assert_eq!(change.old_columns, vec!["id".to_string()]);
        assert_eq!(change.new_columns, vec!["name".to_string()]);
        assert!(diff.is_destructive());
    }

    #[test]
    fn rejects_dropped_column_when_target_index_still_references_it() {
        let baseline = table_schema();
        let mut target = baseline.clone();
        target.columns.retain(|column| column.name != "name");

        let error = diff_table_schema_for_update(
            &baseline,
            &target,
            TableUpdateDiffOptions {
                allow_column_comments: true,
            },
        )
        .unwrap_err();

        assert!(error.message.contains("索引"));
        assert!(error.message.contains("name"));
    }

    #[test]
    fn rejects_unsupported_table_schema_updates() {
        let baseline = table_schema();

        let mut changed_unique = baseline.clone();
        changed_unique.columns[1].is_unique = true;
        assert!(diff_table_schema_for_update(
            &baseline,
            &changed_unique,
            TableUpdateDiffOptions {
                allow_column_comments: true,
            },
        )
        .is_err());

        let mut changed_identity = baseline.clone();
        changed_identity.columns[1].is_identity = true;
        let identity_diff = diff_table_schema_for_update(
            &baseline,
            &changed_identity,
            TableUpdateDiffOptions {
                allow_column_comments: true,
            },
        )
        .unwrap();
        assert_eq!(identity_diff.identity_changes.len(), 1);

        let mut primary_key_column = baseline.clone();
        primary_key_column.columns[1].is_primary_key = true;
        let mut changed_primary_key_nullability = primary_key_column.clone();
        changed_primary_key_nullability.columns[1].nullable = true;
        assert!(diff_table_schema_for_update(
            &primary_key_column,
            &changed_primary_key_nullability,
            TableUpdateDiffOptions {
                allow_column_comments: true,
            },
        )
        .is_err());

        let mut identity_column = baseline.clone();
        identity_column.columns[1].is_identity = true;
        let mut changed_identity_nullability = identity_column.clone();
        changed_identity_nullability.columns[1].nullable = true;
        assert!(diff_table_schema_for_update(
            &identity_column,
            &changed_identity_nullability,
            TableUpdateDiffOptions {
                allow_column_comments: true,
            },
        )
        .is_err());

        let mut changed_identity_default = identity_column.clone();
        changed_identity_default.columns[1].default_value = Some("42".to_string());
        assert!(diff_table_schema_for_update(
            &identity_column,
            &changed_identity_default,
            TableUpdateDiffOptions {
                allow_column_comments: true,
            },
        )
        .is_err());

        let mut renamed_table = baseline.clone();
        renamed_table.basics.table_name = "people".to_string();
        assert!(diff_table_schema_for_update(
            &baseline,
            &renamed_table,
            TableUpdateDiffOptions {
                allow_column_comments: true,
            },
        )
        .is_err());
    }

    fn mutation_columns() -> Vec<ColumnMeta> {
        vec![
            ColumnMeta {
                name: "id".to_string(),
                type_name: "INT".to_string(),
                nullable: false,
                default_value: None,
                data_category: ColumnDataCategory::Number,
                max_length: None,
                numeric_precision: Some(10),
                numeric_scale: Some(0),
                enum_values: None,
                is_primary_key: true,
                primary_key_ordinal: Some(2),
                is_unique: true,
                is_writable: true,
            },
            ColumnMeta {
                name: "tenant_id".to_string(),
                type_name: "INT".to_string(),
                nullable: false,
                default_value: None,
                data_category: ColumnDataCategory::Number,
                max_length: None,
                numeric_precision: Some(10),
                numeric_scale: Some(0),
                enum_values: None,
                is_primary_key: true,
                primary_key_ordinal: Some(1),
                is_unique: true,
                is_writable: true,
            },
            ColumnMeta {
                name: "name".to_string(),
                type_name: "VARCHAR".to_string(),
                nullable: true,
                default_value: None,
                data_category: ColumnDataCategory::String,
                max_length: Some(255),
                numeric_precision: None,
                numeric_scale: None,
                enum_values: None,
                is_primary_key: false,
                primary_key_ordinal: None,
                is_unique: false,
                is_writable: true,
            },
            ColumnMeta {
                name: "generated_name".to_string(),
                type_name: "VARCHAR".to_string(),
                nullable: true,
                default_value: None,
                data_category: ColumnDataCategory::String,
                max_length: Some(255),
                numeric_precision: None,
                numeric_scale: None,
                enum_values: None,
                is_primary_key: false,
                primary_key_ordinal: None,
                is_unique: false,
                is_writable: false,
            },
        ]
    }

    fn table_schema() -> TableSchema {
        TableSchema {
            basics: TableSchemaBasics {
                table_name: "users".to_string(),
                database_name: "app".to_string(),
                schema_name: "public".to_string(),
                engine: None,
                charset: None,
                collation: None,
                comment: Some("User table".to_string()),
                partition: None,
            },
            columns: vec![
                TableColumnSchema {
                    name: "id".to_string(),
                    type_name: "bigint".to_string(),
                    nullable: false,
                    default_value: None,
                    is_primary_key: true,
                    is_unique: false,
                    is_identity: true,
                    identity: None,
                    generated: None,
                    charset: None,
                    collation: None,
                    comment: None,
                },
                TableColumnSchema {
                    name: "name".to_string(),
                    type_name: "varchar(255)".to_string(),
                    nullable: false,
                    default_value: None,
                    is_primary_key: false,
                    is_unique: false,
                    is_identity: false,
                    identity: None,
                    generated: None,
                    charset: None,
                    collation: None,
                    comment: Some("Display name".to_string()),
                },
            ],
            indexes: vec![TableIndexSchema {
                name: "idx_users_name".to_string(),
                columns: vec!["name".to_string()],
                is_unique: false,
                method: Some("btree".to_string()),
                comment: None,
            }],
            constraints: Vec::new(),
        }
    }
}
