use super::*;

pub(super) fn mysql_table_rows_to_result(
    mut rows: Vec<MySqlRow>,
    page_size: u32,
    columns: Vec<ColumnMeta>,
    source_writable: bool,
    source_insertable: bool,
    primary_key_columns: Vec<String>,
    stable_order_columns: Vec<String>,
) -> IpcResult<QueryResult> {
    let has_next_page = rows.len() > page_size as usize;
    if has_next_page {
        rows.pop();
    }

    let result_rows: Vec<Vec<Value>> = rows
        .iter()
        .map(|row| {
            (0..row.columns().len())
                .map(|index| mysql_value_to_json(row, index))
                .collect::<IpcResult<Vec<_>>>()
        })
        .collect::<IpcResult<Vec<_>>>()?;

    Ok(QueryResult {
        columns,
        rows: result_rows,
        affected_rows: None,
        has_next_page,
        source_writable,
        source_insertable,
        primary_key_columns,
        stable_order_columns,
        row_locator_strategy: source_writable
            .then_some(crate::engine::types::TableRowLocatorStrategy::PrimaryKey),
    })
}

pub(super) fn rows_affected(result: &MySqlQueryResult) -> u64 {
    result.rows_affected()
}

pub(super) fn mysql_columns_from_row(row: &MySqlRow) -> Vec<ColumnMeta> {
    row.columns()
        .iter()
        .map(|column| {
            mysql_readonly_query_column(
                column.name().to_string(),
                column.type_info().name().to_string(),
                true,
            )
        })
        .collect()
}

pub(super) fn mysql_columns_from_describe(
    describe: &sqlx::Describe<sqlx::MySql>,
) -> Vec<ColumnMeta> {
    describe
        .columns()
        .iter()
        .enumerate()
        .map(|(index, column)| {
            mysql_readonly_query_column(
                column.name().to_string(),
                column.type_info().name().to_string(),
                describe.nullable(index).unwrap_or(true),
            )
        })
        .collect()
}

pub(super) fn ensure_mysql_row_shape(row: &MySqlRow, expected: &[ColumnMeta]) -> IpcResult<()> {
    if row.columns().len() != expected.len() {
        return Err(IpcError::system_internal(
            "SQL execution returned multiple incompatible result sets",
            "Result-set column counts did not match",
        ));
    }

    for (column, expected_column) in row.columns().iter().zip(expected.iter()) {
        if column.name() != expected_column.name
            || column.type_info().name() != expected_column.type_name
        {
            return Err(IpcError::system_internal(
                "SQL execution returned multiple incompatible result sets",
                "Result-set schemas did not match",
            ));
        }
    }

    Ok(())
}

pub(super) fn mysql_result_rows(rows: &[MySqlRow]) -> IpcResult<Vec<Vec<Value>>> {
    rows.iter()
        .map(|row| {
            (0..row.columns().len())
                .map(|index| mysql_value_to_json(row, index))
                .collect::<IpcResult<Vec<_>>>()
        })
        .collect()
}

pub(super) fn mysql_value_to_json(row: &MySqlRow, index: usize) -> IpcResult<Value> {
    let column = &row.columns()[index];
    let column_name = column.name();
    let type_name = column.type_info().name();
    let raw = row
        .try_get_raw(index)
        .map_err(|error| mysql_value_decode_error(column_name, type_name, error.to_string()))?;
    if raw.is_null() {
        return Ok(Value::Null);
    }

    macro_rules! decode_map {
        ($T:ty, $map:expr) => {
            row.try_get::<$T, _>(index).map($map).map_err(|error| {
                mysql_value_decode_error(column_name, type_name, error.to_string())
            })
        };
    }
    macro_rules! decode_json {
        ($T:ty) => {
            decode_map!($T, |value| serde_json::json!(value))
        };
    }

    match type_name {
        "BOOLEAN" | "BOOL" => decode_json!(bool),
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" => {
            decode_map!(i64, json_i64_for_js_transport)
        }
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED"
        | "BIGINT UNSIGNED" => {
            decode_map!(u64, json_u64_for_js_transport)
        }
        "FLOAT" => decode_json!(f32),
        "DOUBLE" => decode_json!(f64),
        "DECIMAL" => decode_map!(bigdecimal::BigDecimal, |value| {
            Value::String(value.to_string())
        }),
        "BIT" => decode_map!(u64, json_u64_for_js_transport),
        "YEAR" => decode_map!(u64, |value| Value::String(value.to_string())),
        "DATE" => decode_map!(time::Date, |value| Value::String(value.to_string())),
        "TIME" => decode_map!(sqlx::mysql::types::MySqlTime, |value| {
            Value::String(mysql_time_text(value))
        }),
        "DATETIME" | "TIMESTAMP" => decode_map!(time::OffsetDateTime, |value| {
            Value::String(mysql_datetime_text(value.date(), value.time()))
        }),
        "JSON" => decode_map!(
            sqlx::types::Json<Box<serde_json::value::RawValue>>,
            |value| Value::String(value.0.get().to_string())
        ),
        "BINARY" | "VARBINARY" | "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" | "GEOMETRY" => {
            row.try_get_unchecked::<Vec<u8>, _>(index)
                .map(|bytes| Value::String(hex_encode(&bytes)))
                .map_err(|error| {
                    mysql_value_decode_error(column_name, type_name, error.to_string())
                })
        }
        _ => decode_json!(String),
    }
}

pub(super) fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02X}")).collect()
}

fn mysql_readonly_query_column(name: String, type_name: String, nullable: bool) -> ColumnMeta {
    let mut column = ColumnMeta::readonly_query_column(name, type_name.clone(), nullable);
    let data_type = mysql_column_base_type(&type_name);
    column.data_category = MysqlDriver::classify_column_data_category(&data_type, &type_name);
    column
}

fn mysql_value_decode_error(column_name: &str, type_name: &str, error: String) -> IpcError {
    IpcError::system_internal(
        format!("Failed to decode MySQL result column '{column_name}'"),
        format!("column={column_name}; type={type_name}; error={error}"),
    )
}

fn mysql_time_text(value: sqlx::mysql::types::MySqlTime) -> String {
    let sign = if value.sign().is_negative() { "-" } else { "" };
    let base = format!(
        "{sign}{:02}:{:02}:{:02}",
        value.hours(),
        value.minutes(),
        value.seconds()
    );
    mysql_append_microseconds(base, value.microseconds())
}

fn mysql_datetime_text(date: time::Date, time: time::Time) -> String {
    let base = format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        date.year(),
        u8::from(date.month()),
        date.day(),
        time.hour(),
        time.minute(),
        time.second()
    );
    mysql_append_microseconds(base, time.nanosecond() / 1_000)
}

fn mysql_append_microseconds(mut base: String, microseconds: u32) -> String {
    if microseconds != 0 {
        base.push('.');
        base.push_str(&format!("{microseconds:06}"));
    }
    base
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::mysql::types::{MySqlTime, MySqlTimeSign};
    use time::{Date, Month, Time};

    #[test]
    fn formats_mysql_temporal_values_with_stable_padding() {
        let time =
            MySqlTime::new(MySqlTimeSign::Positive, 5, 12, 2, 123_456).expect("valid MySQL time");
        assert_eq!(mysql_time_text(time), "05:12:02.123456");

        let negative = MySqlTime::new(MySqlTimeSign::Negative, 38, 1, 9, 0)
            .expect("valid negative MySQL time");
        assert_eq!(mysql_time_text(negative), "-38:01:09");

        let date = Date::from_calendar_date(2026, Month::May, 9).expect("valid date");
        let time = Time::from_hms_micro(5, 12, 2, 123_456).expect("valid time");
        assert_eq!(
            mysql_datetime_text(date, time),
            "2026-05-09 05:12:02.123456"
        );
    }

    #[test]
    fn classifies_dynamic_mysql_query_columns() {
        assert_eq!(
            mysql_readonly_query_column("amount".into(), "DECIMAL".into(), true).data_category,
            ColumnDataCategory::Number
        );
        assert_eq!(
            mysql_readonly_query_column("payload".into(), "JSON".into(), true).data_category,
            ColumnDataCategory::Json
        );
        assert_eq!(
            mysql_readonly_query_column("counter".into(), "BIGINT UNSIGNED".into(), true)
                .data_category,
            ColumnDataCategory::Number
        );
        assert_eq!(
            mysql_readonly_query_column("created_at".into(), "TIMESTAMP".into(), true)
                .data_category,
            ColumnDataCategory::Datetime
        );
    }
}
