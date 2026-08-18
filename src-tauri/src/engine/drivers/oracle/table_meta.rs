use std::collections::{HashMap, HashSet};

use oracle_rs::{Row, Value};

use crate::engine::types::ColumnMeta;

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) struct OracleTableColumnMetadata {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub data_length: Option<i64>,
    pub data_precision: Option<i32>,
    pub data_scale: Option<i32>,
    pub identity_column: bool,
    pub virtual_column: bool,
    pub primary_key_position: Option<i32>,
    pub unique_column: bool,
}

#[allow(dead_code)]
pub(crate) fn oracle_table_columns_metadata_sql() -> &'static str {
    "SELECT \
        c.column_name, c.data_type, c.nullable, \
        CAST(NULL AS VARCHAR2(4000)) AS data_default, \
        c.data_length, c.data_precision, c.data_scale, \
        c.identity_column, COALESCE(vc.virtual_column, 'NO') AS virtual_column \
     FROM all_tab_columns c \
     LEFT JOIN all_tab_cols vc \
       ON vc.owner = c.owner \
      AND vc.table_name = c.table_name \
      AND vc.column_name = c.column_name \
     WHERE c.owner = :1 \
       AND c.table_name = :2 \
     ORDER BY c.column_id"
}

#[allow(dead_code)]
pub(crate) fn oracle_primary_key_columns_metadata_sql() -> &'static str {
    "SELECT cc.column_name, cc.position \
     FROM all_constraints cons \
     JOIN all_cons_columns cc \
       ON cc.owner = cons.owner \
      AND cc.constraint_name = cons.constraint_name \
      AND cc.table_name = cons.table_name \
     WHERE cons.constraint_type = 'P' \
       AND cons.owner = :1 \
       AND cons.table_name = :2 \
     ORDER BY cc.position"
}

#[allow(dead_code)]
pub(crate) fn oracle_unique_columns_metadata_sql() -> &'static str {
    "SELECT DISTINCT cc.column_name \
     FROM all_constraints cons \
     JOIN all_cons_columns cc \
       ON cc.owner = cons.owner \
      AND cc.constraint_name = cons.constraint_name \
      AND cc.table_name = cons.table_name \
     WHERE cons.constraint_type IN ('P', 'U') \
       AND cons.owner = :1 \
       AND cons.table_name = :2 \
     ORDER BY cc.column_name"
}

#[allow(dead_code)]
pub(crate) fn column_meta_from_oracle_table_column(
    column: &OracleTableColumnMetadata,
) -> ColumnMeta {
    let type_name = oracle_display_type_name(column);
    let is_lob = oracle_type_is_readonly_lob(&column.data_type);
    ColumnMeta {
        name: column.name.clone(),
        type_name: type_name.clone(),
        nullable: column.nullable,
        default_value: column
            .default_value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        data_category: super::value::data_category_from_type_name(&type_name),
        max_length: column.data_length,
        numeric_precision: column.data_precision,
        numeric_scale: column.data_scale,
        enum_values: None,
        is_primary_key: column.primary_key_position.is_some(),
        primary_key_ordinal: column.primary_key_position,
        is_unique: column.unique_column || column.primary_key_position.is_some(),
        is_writable: !column.virtual_column && !column.identity_column && !is_lob,
    }
}

#[allow(dead_code)]
pub(crate) fn oracle_display_type_name(column: &OracleTableColumnMetadata) -> String {
    let upper = column.data_type.to_ascii_uppercase();
    if upper == "NUMBER" {
        return match (column.data_precision, column.data_scale) {
            (Some(precision), Some(scale)) => format!("NUMBER({precision},{scale})"),
            (Some(precision), None) => format!("NUMBER({precision})"),
            _ => "NUMBER".to_string(),
        };
    }
    if matches!(
        upper.as_str(),
        "CHAR" | "NCHAR" | "VARCHAR2" | "NVARCHAR2" | "RAW"
    ) {
        if let Some(length) = column.data_length {
            return format!("{upper}({length})");
        }
    }
    upper
}

#[allow(dead_code)]
fn oracle_type_is_readonly_lob(data_type: &str) -> bool {
    let upper = data_type.to_ascii_uppercase();
    upper.contains("LOB") || upper == "LONG" || upper == "LONG RAW"
}

fn row_string(row: &Row, index: usize) -> Option<String> {
    row.get(index)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn row_i32(row: &Row, index: usize) -> Option<i32> {
    row_i64(row, index).and_then(|value| i32::try_from(value).ok())
}

fn row_i64(row: &Row, index: usize) -> Option<i64> {
    match row.get(index)? {
        Value::Integer(value) => Some(*value),
        Value::Number(value) => value.as_str().trim().parse::<i64>().ok(),
        Value::String(value) => value.trim().parse::<i64>().ok(),
        other => other.as_i64(),
    }
}

pub(crate) fn table_column_metadata_from_row(row: &Row) -> Option<OracleTableColumnMetadata> {
    Some(OracleTableColumnMetadata {
        name: row_string(row, 0)?,
        data_type: row_string(row, 1)?,
        nullable: row_string(row, 2)
            .map(|value| value.eq_ignore_ascii_case("Y"))
            .unwrap_or(true),
        default_value: row_string(row, 3),
        data_length: row_i64(row, 4),
        data_precision: row_i32(row, 5),
        data_scale: row_i32(row, 6),
        identity_column: row_string(row, 7)
            .map(|value| value.eq_ignore_ascii_case("YES") || value.eq_ignore_ascii_case("Y"))
            .unwrap_or(false),
        virtual_column: row_string(row, 8)
            .map(|value| value.eq_ignore_ascii_case("YES") || value.eq_ignore_ascii_case("Y"))
            .unwrap_or(false),
        primary_key_position: None,
        unique_column: false,
    })
}

pub(crate) fn primary_key_column_from_row(row: &Row) -> Option<(String, i32)> {
    Some((row_string(row, 0)?, row_i32(row, 1)?))
}

pub(crate) fn unique_column_name_from_row(row: &Row) -> Option<String> {
    row_string(row, 0)
}

pub(crate) fn apply_primary_key_metadata(
    columns: &mut [OracleTableColumnMetadata],
    primary_keys: impl IntoIterator<Item = (String, i32)>,
) {
    let primary_keys = primary_keys.into_iter().collect::<HashMap<_, _>>();
    for column in columns {
        column.primary_key_position = primary_keys.get(&column.name).copied();
    }
}

pub(crate) fn apply_unique_column_metadata(
    columns: &mut [OracleTableColumnMetadata],
    unique_columns: impl IntoIterator<Item = String>,
) {
    let unique_columns = unique_columns.into_iter().collect::<HashSet<_>>();
    for column in columns {
        column.unique_column = unique_columns.contains(&column.name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::types::ColumnDataCategory;

    fn column(name: &str, data_type: &str) -> OracleTableColumnMetadata {
        OracleTableColumnMetadata {
            name: name.to_string(),
            data_type: data_type.to_string(),
            nullable: true,
            default_value: None,
            data_length: None,
            data_precision: None,
            data_scale: None,
            identity_column: false,
            virtual_column: false,
            primary_key_position: None,
            unique_column: false,
        }
    }

    #[test]
    fn maps_primary_key_column_as_writable_key_metadata() {
        let mut raw = column("ID", "NUMBER");
        raw.nullable = false;
        raw.data_precision = Some(10);
        raw.data_scale = Some(0);
        raw.primary_key_position = Some(1);
        raw.unique_column = true;

        let meta = column_meta_from_oracle_table_column(&raw);

        assert_eq!(meta.name, "ID");
        assert_eq!(meta.type_name, "NUMBER(10,0)");
        assert_eq!(meta.data_category, ColumnDataCategory::Number);
        assert!(meta.is_primary_key);
        assert_eq!(meta.primary_key_ordinal, Some(1));
        assert!(meta.is_unique);
        assert!(meta.is_writable);
    }

    #[test]
    fn marks_virtual_identity_and_lob_columns_readonly() {
        let mut virtual_column = column("FULL_NAME", "VARCHAR2");
        virtual_column.virtual_column = true;
        assert!(!column_meta_from_oracle_table_column(&virtual_column).is_writable);

        let mut identity_column = column("ID", "NUMBER");
        identity_column.identity_column = true;
        assert!(!column_meta_from_oracle_table_column(&identity_column).is_writable);

        let lob_column = column("BODY", "CLOB");
        assert!(!column_meta_from_oracle_table_column(&lob_column).is_writable);
    }

    #[test]
    fn formats_oracle_type_names_with_length_and_scale() {
        let mut varchar = column("NAME", "VARCHAR2");
        varchar.data_length = Some(120);
        assert_eq!(
            column_meta_from_oracle_table_column(&varchar).type_name,
            "VARCHAR2(120)"
        );

        let mut number = column("AMOUNT", "NUMBER");
        number.data_precision = Some(12);
        number.data_scale = Some(2);
        assert_eq!(
            column_meta_from_oracle_table_column(&number).type_name,
            "NUMBER(12,2)"
        );
    }

    #[test]
    fn applies_primary_key_and_unique_metadata_to_base_columns() {
        let mut columns = vec![column("ID", "NUMBER"), column("NAME", "VARCHAR2")];

        apply_primary_key_metadata(&mut columns, [("ID".to_string(), 1)]);
        apply_unique_column_metadata(&mut columns, ["ID".to_string(), "NAME".to_string()]);

        assert_eq!(columns[0].primary_key_position, Some(1));
        assert!(columns[0].unique_column);
        assert_eq!(columns[1].primary_key_position, None);
        assert!(columns[1].unique_column);
    }

    #[test]
    fn parses_numeric_metadata_from_oracle_string_values() {
        let row = Row::new(vec![
            Value::String("ID".to_string()),
            Value::String("1".to_string()),
        ]);

        assert_eq!(
            primary_key_column_from_row(&row),
            Some(("ID".to_string(), 1))
        );
    }

    #[test]
    fn metadata_sql_splits_columns_primary_key_and_unique_lookups() {
        let columns_sql = oracle_table_columns_metadata_sql();
        let primary_key_sql = oracle_primary_key_columns_metadata_sql();
        let unique_sql = oracle_unique_columns_metadata_sql();

        assert!(columns_sql.contains("FROM all_tab_columns c"));
        assert!(!columns_sql.contains("all_constraints"));
        assert!(columns_sql.contains("CAST(NULL AS VARCHAR2(4000)) AS data_default"));
        assert!(!columns_sql.contains("c.data_default"));

        assert!(primary_key_sql.contains("FROM all_constraints cons"));
        assert!(primary_key_sql.contains("cons.constraint_type = 'P'"));
        assert!(unique_sql.contains("FROM all_constraints cons"));
        assert!(unique_sql.contains("cons.constraint_type IN ('P', 'U')"));
    }

    #[test]
    fn metadata_sql_queries_each_use_one_bind_pair() {
        for sql in [
            oracle_table_columns_metadata_sql(),
            oracle_primary_key_columns_metadata_sql(),
            oracle_unique_columns_metadata_sql(),
        ] {
            assert_eq!(sql.matches(":1").count(), 1);
            assert_eq!(sql.matches(":2").count(), 1);
            assert!(!sql.contains("WITH target AS"));
            assert_eq!(oracle_rs::Statement::new(sql).bind_info().len(), 2);
        }
    }

    #[test]
    fn metadata_sql_reads_virtual_column_from_all_tab_cols() {
        let sql = oracle_table_columns_metadata_sql();

        assert!(sql.contains("FROM all_tab_columns c"));
        assert!(sql.contains("LEFT JOIN all_tab_cols vc"));
        assert!(sql.contains("vc.virtual_column"));
        assert!(!sql.contains(", c.virtual_column"));
        assert!(!sql.contains(" c.virtual_column"));
    }
}
