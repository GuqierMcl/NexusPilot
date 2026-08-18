use crate::engine::types::{ContainerKind, ContainerRef};
use crate::error::{IpcError, IpcResult};

use super::{quote_oracle_identifier, OracleDriver};

pub fn table_browse_sql(
    table: &str,
    select_columns: &[String],
    stable_order_columns: &[String],
    where_clause: &str,
    requested_order_by: &str,
    offset: u64,
    limit: u64,
) -> String {
    let columns = if select_columns.is_empty() {
        "*".to_string()
    } else {
        select_columns.join(", ")
    };
    let order_by = if !requested_order_by.is_empty() {
        requested_order_by.to_string()
    } else if stable_order_columns.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", stable_order_columns.join(", "))
    };
    format!(
        "SELECT {columns} FROM {table}{where_clause}{order_by} OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY"
    )
}

pub fn table_count_sql(table: &str, where_clause: &str) -> String {
    format!("SELECT COUNT(*) AS TOTAL_ROWS FROM {table}{where_clause}")
}

pub fn current_schema_sql(schema: &str) -> String {
    let schema = schema.trim();
    if schema.is_empty() {
        String::new()
    } else {
        format!(
            "ALTER SESSION SET CURRENT_SCHEMA = {}",
            super::quote_oracle_identifier(schema)
        )
    }
}

pub fn current_schema_plsql(schema: &str) -> String {
    let statement = current_schema_sql(schema).replace('\'', "''");
    if statement.is_empty() {
        String::new()
    } else {
        format!("BEGIN EXECUTE IMMEDIATE '{statement}'; END;")
    }
}

fn ensure_oracle_table_like_container(kind: &ContainerKind) -> IpcResult<()> {
    match kind {
        ContainerKind::Table | ContainerKind::View | ContainerKind::MaterializedView => Ok(()),
        _ => Err(IpcError::resource_not_found(
            "Oracle table browsing requires a table, view, or materialized view container",
        )),
    }
}

impl OracleDriver {
    pub(crate) fn table_parts(&self, container: &ContainerRef) -> IpcResult<(String, String)> {
        ensure_oracle_table_like_container(&container.kind)?;
        let schema = container
            .schema
            .as_deref()
            .ok_or_else(|| IpcError::resource_not_found("Oracle schema context is missing"))?;
        let table = container
            .table
            .as_deref()
            .ok_or_else(|| IpcError::resource_not_found("Oracle table name is missing"))?;
        Ok((schema.to_string(), table.to_string()))
    }

    pub(crate) fn qualified_table_name(&self, container: &ContainerRef) -> IpcResult<String> {
        let (schema, table) = self.table_parts(container)?;
        Ok(format!(
            "{}.{}",
            quote_oracle_identifier(&schema),
            quote_oracle_identifier(&table)
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_table_browse_sql_with_columns_order_and_oracle_pagination() {
        let sql = table_browse_sql(
            "\"APP\".\"USERS\"",
            &["\"ID\"".to_string(), "\"NAME\"".to_string()],
            &["\"ID\"".to_string()],
            "",
            "",
            0,
            51,
        );

        assert_eq!(
            sql,
            "SELECT \"ID\", \"NAME\" FROM \"APP\".\"USERS\" ORDER BY \"ID\" OFFSET 0 ROWS FETCH NEXT 51 ROWS ONLY"
        );
    }

    #[test]
    fn builds_table_browse_sql_without_order_when_no_primary_key() {
        let sql = table_browse_sql(
            "\"APP\".\"LOGS\"",
            &["\"MESSAGE\"".to_string()],
            &[],
            "",
            "",
            50,
            51,
        );

        assert_eq!(
            sql,
            "SELECT \"MESSAGE\" FROM \"APP\".\"LOGS\" OFFSET 50 ROWS FETCH NEXT 51 ROWS ONLY"
        );
    }

    #[test]
    fn builds_page_stats_sql() {
        let sql = table_count_sql("\"APP\".\"USERS\"", "");

        assert_eq!(sql, "SELECT COUNT(*) AS TOTAL_ROWS FROM \"APP\".\"USERS\"");
    }

    #[test]
    fn builds_current_schema_statement() {
        assert_eq!(
            current_schema_sql("APP"),
            "ALTER SESSION SET CURRENT_SCHEMA = \"APP\""
        );
    }

    #[test]
    fn builds_current_schema_plsql_statement() {
        assert_eq!(
            current_schema_plsql("APP"),
            "BEGIN EXECUTE IMMEDIATE 'ALTER SESSION SET CURRENT_SCHEMA = \"APP\"'; END;"
        );
    }

    #[test]
    fn empty_schema_has_no_current_schema_statement() {
        assert_eq!(current_schema_sql("   "), "");
    }
}
