use crate::engine::drivers::common::{
    ordered_primary_key_columns, render_sql_literal, validate_cell_changes, validate_insert_values,
    validate_primary_key,
};
use crate::engine::types::{
    ColumnMeta, TableChangeSetInsert, TableChangeSetPreview, TableChangeSetRequest,
    TableChangeSetUpdate,
};
use crate::error::{IpcError, IpcResult};

use super::quote_oracle_identifier;

pub(crate) fn oracle_empty_insert_statement(table: &str) -> String {
    format!("INSERT INTO {table} DEFAULT VALUES")
}

pub(crate) fn ensure_oracle_table_has_primary_key(columns: &[ColumnMeta]) -> IpcResult<()> {
    if ordered_primary_key_columns(columns).is_empty() {
        return Err(IpcError::system_internal(
            "该 Oracle 表没有主键，无法安全定位要修改或删除的行；当前仅支持浏览数据",
            "Oracle DataTable mutation requires a primary key",
        ));
    }
    Ok(())
}

pub(crate) fn preview_oracle_change_set(
    table: &str,
    columns: &[ColumnMeta],
    change_set: &TableChangeSetRequest,
) -> IpcResult<TableChangeSetPreview> {
    ensure_oracle_table_has_primary_key(columns)?;
    let statements = build_oracle_dml_statements(table, columns, change_set)?;

    Ok(TableChangeSetPreview {
        statements: statements
            .into_iter()
            .map(|statement| statement.sql)
            .collect(),
        summary: crate::engine::types::TableChangeSetSummary {
            inserts: change_set.inserts.len() as u32,
            updates: change_set.updates.len() as u32,
            deletes: change_set.deletes.len() as u32,
        },
    })
}

pub(crate) struct OracleDmlStatement {
    pub sql: String,
    pub expected_rows: Option<u64>,
}

pub(crate) fn build_oracle_insert_statement(
    table: &str,
    columns: &[ColumnMeta],
    insert: &TableChangeSetInsert,
) -> IpcResult<OracleDmlStatement> {
    let values = validate_insert_values(columns, &insert.values)?;
    let sql = build_oracle_insert_row_statement(table, columns, &values)?;

    Ok(OracleDmlStatement {
        sql,
        expected_rows: Some(1),
    })
}

pub(crate) fn build_oracle_update_statement(
    table: &str,
    columns: &[ColumnMeta],
    update: &TableChangeSetUpdate,
) -> IpcResult<OracleDmlStatement> {
    let changes = validate_cell_changes(columns, &update.changes)?;
    let primary_key = update.locator.primary_key_parts().ok_or_else(|| {
        IpcError::validation_failed("当前 Oracle 数据表需要使用主键定位行，请刷新后重试")
    })?;
    let primary_key = validate_primary_key(columns, primary_key)?;
    let sql = build_oracle_update_row_statement(table, columns, &primary_key, &changes)?;

    Ok(OracleDmlStatement {
        sql,
        expected_rows: Some(1),
    })
}

pub(crate) fn build_oracle_delete_statement(
    table: &str,
    columns: &[ColumnMeta],
    deletes: &[crate::engine::types::TableRowLocator],
) -> IpcResult<OracleDmlStatement> {
    if deletes.is_empty() {
        return Err(IpcError::system_internal(
            "没有需要删除的行",
            "delete_table_rows requires at least one primary key",
        ));
    }

    let primary_keys = deletes
        .iter()
        .map(|locator| {
            let primary_key = locator.primary_key_parts().ok_or_else(|| {
                IpcError::validation_failed("当前 Oracle 数据表需要使用主键定位行，请刷新后重试")
            })?;
            validate_primary_key(columns, primary_key)
        })
        .collect::<IpcResult<Vec<_>>>()?;
    let sql = build_oracle_delete_rows_statement(table, columns, &primary_keys)?;

    Ok(OracleDmlStatement {
        sql,
        expected_rows: Some(deletes.len() as u64),
    })
}

pub(crate) fn build_oracle_dml_statements(
    table: &str,
    columns: &[ColumnMeta],
    change_set: &TableChangeSetRequest,
) -> IpcResult<Vec<OracleDmlStatement>> {
    ensure_oracle_table_has_primary_key(columns)?;
    let mut statements = Vec::new();
    for insert in &change_set.inserts {
        statements.push(build_oracle_insert_statement(table, columns, insert)?);
    }
    for update in &change_set.updates {
        statements.push(build_oracle_update_statement(table, columns, update)?);
    }
    if !change_set.deletes.is_empty() {
        statements.push(build_oracle_delete_statement(
            table,
            columns,
            &change_set.deletes,
        )?);
    }
    Ok(statements)
}

fn build_oracle_insert_row_statement(
    table: &str,
    columns: &[ColumnMeta],
    values: &[crate::engine::types::TableCellChange],
) -> IpcResult<String> {
    if values.is_empty() {
        return Ok(oracle_empty_insert_statement(table));
    }

    let column_names = values
        .iter()
        .map(|value| quote_oracle_identifier(&value.column))
        .collect::<Vec<_>>()
        .join(", ");
    let literals = values
        .iter()
        .map(|value| {
            let column = find_oracle_column(columns, &value.column)?;
            render_oracle_sql_literal(column, &value.value)
        })
        .collect::<IpcResult<Vec<_>>>()?
        .join(", ");

    Ok(format!(
        "INSERT INTO {table} ({column_names}) VALUES ({literals})"
    ))
}

fn build_oracle_update_row_statement(
    table: &str,
    columns: &[ColumnMeta],
    primary_key: &[crate::engine::types::TableRowKeyPart],
    changes: &[crate::engine::types::TableCellChange],
) -> IpcResult<String> {
    let assignments = changes
        .iter()
        .map(|change| {
            let column = find_oracle_column(columns, &change.column)?;
            Ok(format!(
                "{} = {}",
                quote_oracle_identifier(&change.column),
                render_oracle_sql_literal(column, &change.value)?
            ))
        })
        .collect::<IpcResult<Vec<_>>>()?
        .join(", ");
    let where_clause = oracle_primary_key_where_clause(columns, primary_key)?;

    Ok(format!(
        "UPDATE {table} SET {assignments} WHERE {where_clause}"
    ))
}

fn build_oracle_delete_rows_statement(
    table: &str,
    columns: &[ColumnMeta],
    primary_keys: &[Vec<crate::engine::types::TableRowKeyPart>],
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
            Ok(format!(
                "({})",
                oracle_primary_key_where_clause(columns, primary_key)?
            ))
        })
        .collect::<IpcResult<Vec<_>>>()?
        .join(" OR ");

    Ok(format!("DELETE FROM {table} WHERE {where_clause}"))
}

fn oracle_primary_key_where_clause(
    columns: &[ColumnMeta],
    primary_key: &[crate::engine::types::TableRowKeyPart],
) -> IpcResult<String> {
    primary_key
        .iter()
        .map(|part| {
            let column = find_oracle_column(columns, &part.column)?;
            Ok(format!(
                "{} = {}",
                quote_oracle_identifier(&part.column),
                render_oracle_sql_literal(column, &part.value)?
            ))
        })
        .collect::<IpcResult<Vec<_>>>()
        .map(|parts| parts.join(" AND "))
}

fn find_oracle_column<'a>(columns: &'a [ColumnMeta], name: &str) -> IpcResult<&'a ColumnMeta> {
    columns
        .iter()
        .find(|column| column.name == name)
        .ok_or_else(|| IpcError::resource_not_found(format!("Column '{name}' was not found")))
}

fn render_oracle_sql_literal(column: &ColumnMeta, value: &serde_json::Value) -> IpcResult<String> {
    let upper_type = column.type_name.to_ascii_uppercase();
    if upper_type.starts_with("TIMESTAMP") {
        return render_oracle_timestamp_literal(column, value);
    }
    if upper_type == "DATE" {
        return render_oracle_date_literal(column, value);
    }
    render_sql_literal(value)
}

fn render_oracle_timestamp_literal(
    column: &ColumnMeta,
    value: &serde_json::Value,
) -> IpcResult<String> {
    match value {
        serde_json::Value::Null => Ok("NULL".to_string()),
        serde_json::Value::String(value) => {
            let Some(value) = normalize_oracle_datetime_literal(column, value, true)? else {
                return Ok("NULL".to_string());
            };
            Ok(format!("TIMESTAMP '{value}'"))
        }
        _ => Err(IpcError::system_internal(
            format!("列 '{}' 需要日期时间字符串", column.name),
            "Oracle TIMESTAMP values must be sent as strings",
        )),
    }
}

fn render_oracle_date_literal(column: &ColumnMeta, value: &serde_json::Value) -> IpcResult<String> {
    match value {
        serde_json::Value::Null => Ok("NULL".to_string()),
        serde_json::Value::String(value) => {
            let Some(value) = normalize_oracle_datetime_literal(column, value, false)? else {
                return Ok("NULL".to_string());
            };
            Ok(format!("TO_DATE('{value}', 'YYYY-MM-DD HH24:MI:SS')"))
        }
        _ => Err(IpcError::system_internal(
            format!("列 '{}' 需要日期字符串", column.name),
            "Oracle DATE values must be sent as strings",
        )),
    }
}

fn normalize_oracle_datetime_literal(
    column: &ColumnMeta,
    value: &str,
    allow_fraction: bool,
) -> IpcResult<Option<String>> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }

    let normalized = value.replace('T', " ");
    let parts = normalized.split_whitespace().collect::<Vec<_>>();
    if parts.is_empty() || parts.len() > 2 {
        return Err(invalid_oracle_datetime_error(column));
    }

    let date = parts[0];
    validate_oracle_date_part(date).map_err(|_| invalid_oracle_datetime_error(column))?;

    let time = if let Some(time) = parts.get(1) {
        normalize_oracle_time_part(time, allow_fraction)
            .map_err(|_| invalid_oracle_datetime_error(column))?
    } else {
        "00:00:00".to_string()
    };

    Ok(Some(format!("{date} {time}")))
}

fn validate_oracle_date_part(value: &str) -> Result<(), ()> {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return Err(());
    }
    if !bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
    {
        return Err(());
    }

    let month = value[5..7].parse::<u32>().map_err(|_| ())?;
    let day = value[8..10].parse::<u32>().map_err(|_| ())?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(());
    }
    Ok(())
}

fn normalize_oracle_time_part(value: &str, allow_fraction: bool) -> Result<String, ()> {
    let (time, fraction) = value
        .split_once('.')
        .map_or((value, None), |(time, fraction)| (time, Some(fraction)));
    let time = if time.len() == 5 {
        format!("{time}:00")
    } else {
        time.to_string()
    };
    let bytes = time.as_bytes();
    if bytes.len() != 8 || bytes[2] != b':' || bytes[5] != b':' {
        return Err(());
    }
    if !bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| matches!(index, 2 | 5) || byte.is_ascii_digit())
    {
        return Err(());
    }

    let hour = time[0..2].parse::<u32>().map_err(|_| ())?;
    let minute = time[3..5].parse::<u32>().map_err(|_| ())?;
    let second = time[6..8].parse::<u32>().map_err(|_| ())?;
    if hour > 23 || minute > 59 || second > 59 {
        return Err(());
    }

    match fraction {
        Some(fraction)
            if allow_fraction
                && !fraction.is_empty()
                && fraction.len() <= 9
                && fraction.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            Ok(format!("{time}.{fraction}"))
        }
        Some(_) => Err(()),
        None => Ok(time),
    }
}

fn invalid_oracle_datetime_error(column: &ColumnMeta) -> IpcError {
    IpcError::system_internal(
        format!(
            "列 '{}' 需要 YYYY-MM-DD HH:MM:SS 格式的日期时间",
            column.name
        ),
        "Oracle datetime literals must use YYYY-MM-DD HH:MM:SS[.fraction]",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::types::{
        ColumnDataCategory, ColumnMeta, TableCellChange, TableChangeSetInsert,
        TableChangeSetRequest, TableChangeSetUpdate, TableRowKeyPart, TableRowLocator,
    };

    fn primary_key(parts: Vec<TableRowKeyPart>) -> TableRowLocator {
        TableRowLocator::primary_key(parts)
    }

    fn column(name: &str, primary_key_ordinal: Option<i32>, writable: bool) -> ColumnMeta {
        ColumnMeta {
            name: name.to_string(),
            type_name: "NUMBER".to_string(),
            nullable: false,
            default_value: None,
            data_category: ColumnDataCategory::Number,
            max_length: None,
            numeric_precision: Some(10),
            numeric_scale: Some(0),
            enum_values: None,
            is_primary_key: primary_key_ordinal.is_some(),
            primary_key_ordinal,
            is_unique: primary_key_ordinal.is_some(),
            is_writable: writable,
        }
    }

    #[test]
    fn previews_insert_update_and_delete_in_stable_order() {
        let columns = vec![column("ID", Some(1), true), column("NAME", None, true)];
        let change_set = TableChangeSetRequest {
            inserts: vec![TableChangeSetInsert {
                values: vec![TableCellChange {
                    column: "NAME".to_string(),
                    value: serde_json::json!("Alice"),
                }],
            }],
            updates: vec![TableChangeSetUpdate {
                locator: primary_key(vec![TableRowKeyPart {
                    column: "ID".to_string(),
                    value: serde_json::json!("1"),
                }]),
                changes: vec![TableCellChange {
                    column: "NAME".to_string(),
                    value: serde_json::json!("Bob"),
                }],
            }],
            deletes: vec![primary_key(vec![TableRowKeyPart {
                column: "ID".to_string(),
                value: serde_json::json!("2"),
            }])],
        };

        let preview =
            preview_oracle_change_set("\"APP\".\"USERS\"", &columns, &change_set).expect("preview");

        assert_eq!(preview.summary.inserts, 1);
        assert_eq!(preview.summary.updates, 1);
        assert_eq!(preview.summary.deletes, 1);
        assert_eq!(
            preview.statements,
            vec![
                "INSERT INTO \"APP\".\"USERS\" (\"NAME\") VALUES ('Alice')",
                "UPDATE \"APP\".\"USERS\" SET \"NAME\" = 'Bob' WHERE \"ID\" = '1'",
                "DELETE FROM \"APP\".\"USERS\" WHERE (\"ID\" = '2')",
            ]
        );
    }

    #[test]
    fn rejects_insert_when_oracle_table_has_no_primary_key() {
        let columns = vec![column("NAME", None, true)];
        let change_set = TableChangeSetRequest {
            inserts: vec![TableChangeSetInsert {
                values: vec![TableCellChange {
                    column: "NAME".to_string(),
                    value: serde_json::json!("Alice"),
                }],
            }],
            updates: Vec::new(),
            deletes: Vec::new(),
        };

        let error =
            preview_oracle_change_set("\"APP\".\"LOGS\"", &columns, &change_set).unwrap_err();

        assert!(error.message.contains("没有主键"));
        assert!(error.message.contains("当前仅支持浏览数据"));
        assert!(!error.message.to_ascii_lowercase().contains("phase"));
    }

    #[test]
    fn rejects_writes_to_readonly_columns() {
        let columns = vec![column("ID", Some(1), true), column("BODY", None, false)];
        let change_set = TableChangeSetRequest {
            inserts: Vec::new(),
            updates: vec![TableChangeSetUpdate {
                locator: primary_key(vec![TableRowKeyPart {
                    column: "ID".to_string(),
                    value: serde_json::json!("1"),
                }]),
                changes: vec![TableCellChange {
                    column: "BODY".to_string(),
                    value: serde_json::json!("text"),
                }],
            }],
            deletes: Vec::new(),
        };

        let error =
            preview_oracle_change_set("\"APP\".\"DOCS\"", &columns, &change_set).unwrap_err();

        assert!(error.message.contains("不可直接写入"));
    }

    #[test]
    fn builds_executable_update_as_literal_sql_without_binds() {
        let columns = vec![column("ID", Some(1), true), column("NAME", None, true)];
        let update = TableChangeSetUpdate {
            locator: primary_key(vec![TableRowKeyPart {
                column: "ID".to_string(),
                value: serde_json::json!("1"),
            }]),
            changes: vec![TableCellChange {
                column: "NAME".to_string(),
                value: serde_json::json!("O'Reilly"),
            }],
        };

        let statement = build_oracle_update_statement("\"APP\".\"USERS\"", &columns, &update)
            .expect("statement");

        assert_eq!(
            statement.sql,
            "UPDATE \"APP\".\"USERS\" SET \"NAME\" = 'O''Reilly' WHERE \"ID\" = '1'"
        );
        assert!(!statement.sql.contains(":1"));
        assert_eq!(statement.expected_rows, Some(1));
    }

    #[test]
    fn builds_insert_with_typed_timestamp_literal() {
        let mut created_at = column("CREATED_AT", None, true);
        created_at.type_name = "TIMESTAMP(6)".to_string();
        created_at.data_category = ColumnDataCategory::Datetime;
        let columns = vec![column("ID", Some(1), true), created_at];
        let insert = TableChangeSetInsert {
            values: vec![TableCellChange {
                column: "CREATED_AT".to_string(),
                value: serde_json::json!("2026-07-06 18:21:54"),
            }],
        };

        let statement = build_oracle_insert_statement("\"APP\".\"USERS\"", &columns, &insert)
            .expect("statement");

        assert_eq!(
            statement.sql,
            "INSERT INTO \"APP\".\"USERS\" (\"CREATED_AT\") VALUES (TIMESTAMP '2026-07-06 18:21:54')"
        );
        assert_eq!(statement.expected_rows, Some(1));
    }

    #[test]
    fn previews_insert_with_typed_timestamp_literal() {
        let mut created_at = column("CREATED_AT", None, true);
        created_at.type_name = "TIMESTAMP(6)".to_string();
        created_at.data_category = ColumnDataCategory::Datetime;
        let columns = vec![column("ID", Some(1), true), created_at];
        let change_set = TableChangeSetRequest {
            inserts: vec![TableChangeSetInsert {
                values: vec![TableCellChange {
                    column: "CREATED_AT".to_string(),
                    value: serde_json::json!("2026-07-06 18:21:54"),
                }],
            }],
            updates: Vec::new(),
            deletes: Vec::new(),
        };

        let preview =
            preview_oracle_change_set("\"APP\".\"USERS\"", &columns, &change_set).expect("preview");

        assert_eq!(
            preview.statements,
            vec![
                "INSERT INTO \"APP\".\"USERS\" (\"CREATED_AT\") VALUES (TIMESTAMP '2026-07-06 18:21:54')"
            ]
        );
    }

    #[test]
    fn builds_update_literal_statement_with_values_after_assignments() {
        let columns = vec![column("ID", Some(1), true), column("NAME", None, true)];
        let update = TableChangeSetUpdate {
            locator: primary_key(vec![TableRowKeyPart {
                column: "ID".to_string(),
                value: serde_json::json!("1"),
            }]),
            changes: vec![TableCellChange {
                column: "NAME".to_string(),
                value: serde_json::json!("Bob"),
            }],
        };

        let statement = build_oracle_update_statement("\"APP\".\"USERS\"", &columns, &update)
            .expect("statement");

        assert_eq!(
            statement.sql,
            "UPDATE \"APP\".\"USERS\" SET \"NAME\" = 'Bob' WHERE \"ID\" = '1'"
        );
        assert_eq!(statement.expected_rows, Some(1));
    }

    #[test]
    fn builds_delete_literal_statement_for_multiple_primary_keys() {
        let columns = vec![column("ID", Some(1), true)];
        let deletes = vec![
            primary_key(vec![TableRowKeyPart {
                column: "ID".to_string(),
                value: serde_json::json!("1"),
            }]),
            primary_key(vec![TableRowKeyPart {
                column: "ID".to_string(),
                value: serde_json::json!("2"),
            }]),
        ];

        let statement = build_oracle_delete_statement("\"APP\".\"USERS\"", &columns, &deletes)
            .expect("statement");

        assert_eq!(
            statement.sql,
            "DELETE FROM \"APP\".\"USERS\" WHERE (\"ID\" = '1') OR (\"ID\" = '2')"
        );
        assert_eq!(statement.expected_rows, Some(2));
    }
}
