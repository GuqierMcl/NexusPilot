use super::*;

pub(super) fn pg_table_rows_to_result(
    mut rows: Vec<PgRow>,
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
                .map(|index| pg_value_to_json(row, index))
                .collect()
        })
        .collect();

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

pub(super) fn rows_affected(result: &PgQueryResult) -> u64 {
    result.rows_affected()
}

pub(super) fn pg_columns_from_row(row: &PgRow) -> Vec<ColumnMeta> {
    row.columns()
        .iter()
        .map(|column| {
            ColumnMeta::readonly_query_column(
                column.name().to_string(),
                column.type_info().name().to_string(),
                true,
            )
        })
        .collect()
}

pub(super) fn pg_columns_from_describe(
    describe: &sqlx::Describe<sqlx::Postgres>,
) -> Vec<ColumnMeta> {
    describe
        .columns()
        .iter()
        .enumerate()
        .map(|(index, column)| {
            ColumnMeta::readonly_query_column(
                column.name().to_string(),
                column.type_info().name().to_string(),
                describe.nullable(index).unwrap_or(true),
            )
        })
        .collect()
}

pub(super) fn ensure_pg_row_shape(row: &PgRow, expected: &[ColumnMeta]) -> IpcResult<()> {
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

pub(super) fn pg_result_rows(rows: &[PgRow]) -> Vec<Vec<Value>> {
    rows.iter()
        .map(|row| {
            (0..row.columns().len())
                .map(|index| pg_value_to_json(row, index))
                .collect()
        })
        .collect()
}

pub(super) fn pg_value_to_json(row: &PgRow, index: usize) -> Value {
    let type_name = row.columns()[index].type_info().name();
    macro_rules! try_get_map {
        ($T:ty, $map:expr) => {
            if let Ok(value) = row.try_get::<Option<$T>, _>(index) {
                return match value {
                    Some(value) => $map(value),
                    None => Value::Null,
                };
            }
        };
    }
    macro_rules! try_get {
        ($T:ty) => {
            try_get_map!($T, |value| serde_json::json!(value))
        };
    }
    match pg_normalize_type_name(type_name).as_str() {
        "int2" | "smallint" => try_get!(i16),
        "int4" | "integer" => try_get!(i32),
        "int8" | "bigint" => try_get_map!(i64, json_i64_for_js_transport),
        "float4" | "real" => try_get!(f32),
        "float8" | "double precision" => try_get!(f64),
        "bool" | "boolean" => try_get!(bool),
        _ => try_get!(String),
    }
    Value::Null
}

pub(super) fn pg_normalize_type_name(type_name: &str) -> String {
    type_name.trim().to_ascii_lowercase()
}
