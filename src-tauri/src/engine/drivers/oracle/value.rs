use oracle_rs::{ColumnInfo, Row, Value};
use serde_json::Value as JsonValue;

use crate::engine::types::{ColumnDataCategory, ColumnMeta};

pub fn column_meta_from_oracle(column: &ColumnInfo) -> ColumnMeta {
    let type_name = format!("{:?}", column.oracle_type);
    ColumnMeta {
        name: column.name.clone(),
        type_name: type_name.clone(),
        nullable: column.nullable,
        default_value: None,
        data_category: data_category_from_type_name(&type_name),
        max_length: None,
        numeric_precision: None,
        numeric_scale: None,
        enum_values: None,
        is_primary_key: false,
        primary_key_ordinal: None,
        is_unique: false,
        is_writable: false,
    }
}

pub fn data_category_from_type_name(type_name: &str) -> ColumnDataCategory {
    let upper = type_name.to_ascii_uppercase();
    if upper.contains("NUMBER") || upper.contains("FLOAT") || upper.contains("BINARY_DOUBLE") {
        ColumnDataCategory::Number
    } else if upper.contains("DATE") || upper.contains("TIMESTAMP") {
        ColumnDataCategory::Datetime
    } else if upper.contains("CLOB") || upper.contains("CHAR") || upper.contains("VARCHAR") {
        ColumnDataCategory::String
    } else if upper.contains("BLOB") || upper.contains("RAW") {
        ColumnDataCategory::Binary
    } else if upper.contains("JSON") {
        ColumnDataCategory::Json
    } else {
        ColumnDataCategory::Unknown
    }
}

pub fn row_to_json_values(row: &Row, columns: &[ColumnInfo]) -> Vec<JsonValue> {
    columns
        .iter()
        .enumerate()
        .map(|(index, _)| {
            row.get(index)
                .map(oracle_value_to_json)
                .unwrap_or(JsonValue::Null)
        })
        .collect()
}

pub fn oracle_value_to_json(value: &Value) -> JsonValue {
    match value {
        Value::Null => JsonValue::Null,
        Value::String(value) => JsonValue::String(value.clone()),
        Value::Integer(value) => JsonValue::String(value.to_string()),
        Value::Number(value) => JsonValue::String(value.as_str().to_string()),
        Value::Float(value) => serde_json::json!(value),
        Value::Boolean(value) => serde_json::json!(value),
        Value::Date(value) => JsonValue::String(format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
            value.year, value.month, value.day, value.hour, value.minute, value.second
        )),
        Value::Timestamp(value) => JsonValue::String(format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:06}",
            value.year,
            value.month,
            value.day,
            value.hour,
            value.minute,
            value.second,
            value.microsecond
        )),
        Value::Bytes(value) => JsonValue::String(format!("<{} bytes>", value.len())),
        Value::Lob(_) => JsonValue::String("<LOB>".to_string()),
        Value::Json(value) => value.clone(),
        other => JsonValue::String(format!("{other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use oracle_rs::types::OracleNumber;
    use oracle_rs::Value;

    use super::*;
    use crate::engine::types::ColumnDataCategory;

    #[test]
    fn classifies_oracle_type_names_for_table_display() {
        assert_eq!(
            data_category_from_type_name("NUMBER"),
            ColumnDataCategory::Number
        );
        assert_eq!(
            data_category_from_type_name("TIMESTAMP"),
            ColumnDataCategory::Datetime
        );
        assert_eq!(
            data_category_from_type_name("VARCHAR2"),
            ColumnDataCategory::String
        );
        assert_eq!(
            data_category_from_type_name("RAW"),
            ColumnDataCategory::Binary
        );
        assert_eq!(
            data_category_from_type_name("JSON"),
            ColumnDataCategory::Json
        );
    }

    #[test]
    fn converts_oracle_values_conservatively_for_json_transport() {
        assert_eq!(
            oracle_value_to_json(&Value::Integer(42)),
            serde_json::json!("42")
        );
        assert_eq!(
            oracle_value_to_json(&Value::Number(OracleNumber::new("9007199254740993"))),
            serde_json::json!("9007199254740993")
        );
        assert_eq!(
            oracle_value_to_json(&Value::Float(3.5)),
            serde_json::json!(3.5)
        );
        assert_eq!(
            oracle_value_to_json(&Value::Bytes(vec![1, 2, 3])),
            serde_json::json!("<3 bytes>")
        );
    }
}
