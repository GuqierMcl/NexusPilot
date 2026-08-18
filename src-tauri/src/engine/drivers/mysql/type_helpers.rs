use super::*;

pub(super) fn mysql_metadata_i32(row: &MySqlRow, column: &str) -> IpcResult<i32> {
    mysql_metadata_i32_value(row, column).ok_or_else(|| {
        IpcError::system_internal(
            format!("读取 MySQL 元数据列 '{column}' 失败"),
            "expected a signed/unsigned integer or numeric text value",
        )
    })
}

fn mysql_metadata_i32_value<I>(row: &MySqlRow, column: I) -> Option<i32>
where
    I: sqlx::ColumnIndex<MySqlRow> + Copy,
{
    row.try_get::<i32, _>(column)
        .ok()
        .or_else(|| {
            row.try_get::<i64, _>(column)
                .ok()
                .and_then(mysql_metadata_i32_from_i64)
        })
        .or_else(|| {
            row.try_get::<u64, _>(column)
                .ok()
                .and_then(mysql_metadata_i32_from_u64)
        })
        .or_else(|| {
            row.try_get::<String, _>(column)
                .ok()
                .and_then(|value| mysql_metadata_i32_from_text(&value))
        })
        .or_else(|| {
            row.try_get::<Vec<u8>, _>(column)
                .ok()
                .and_then(|value| String::from_utf8(value).ok())
                .and_then(|value| mysql_metadata_i32_from_text(&value))
        })
}

pub(super) fn mysql_metadata_u32_at(row: &MySqlRow, column: usize) -> IpcResult<u32> {
    mysql_metadata_u32_value(row, column).ok_or_else(|| {
        IpcError::system_internal(
            format!("读取 MySQL 元数据列索引 {column} 失败"),
            "expected a non-negative integer or numeric text value",
        )
    })
}

fn mysql_metadata_u32_value<I>(row: &MySqlRow, column: I) -> Option<u32>
where
    I: sqlx::ColumnIndex<MySqlRow> + Copy,
{
    row.try_get::<u32, _>(column)
        .ok()
        .or_else(|| {
            row.try_get::<i64, _>(column)
                .ok()
                .and_then(mysql_metadata_u32_from_i64)
        })
        .or_else(|| {
            row.try_get::<u64, _>(column)
                .ok()
                .and_then(mysql_metadata_u32_from_u64)
        })
        .or_else(|| {
            row.try_get::<String, _>(column)
                .ok()
                .and_then(|value| mysql_metadata_u32_from_text(&value))
        })
        .or_else(|| {
            row.try_get::<Vec<u8>, _>(column)
                .ok()
                .and_then(|value| String::from_utf8(value).ok())
                .and_then(|value| mysql_metadata_u32_from_text(&value))
        })
}

fn mysql_metadata_i32_from_i64(value: i64) -> Option<i32> {
    i32::try_from(value).ok()
}

fn mysql_metadata_i32_from_u64(value: u64) -> Option<i32> {
    i32::try_from(value).ok()
}

fn mysql_metadata_i32_from_text(value: &str) -> Option<i32> {
    value
        .trim()
        .parse::<i64>()
        .ok()
        .and_then(mysql_metadata_i32_from_i64)
}

fn mysql_metadata_u32_from_i64(value: i64) -> Option<u32> {
    u32::try_from(value).ok()
}

fn mysql_metadata_u32_from_u64(value: u64) -> Option<u32> {
    u32::try_from(value).ok()
}

fn mysql_metadata_u32_from_text(value: &str) -> Option<u32> {
    value
        .trim()
        .parse::<u64>()
        .ok()
        .and_then(mysql_metadata_u32_from_u64)
}

pub(super) fn asset_group_slug(group_type: &AssetGroupType) -> &'static str {
    match group_type {
        AssetGroupType::Tables => "tables",
        AssetGroupType::Views => "views",
        AssetGroupType::Functions => "functions",
        AssetGroupType::Procedures => "procedures",
        AssetGroupType::Indexes => "indexes",
        AssetGroupType::Triggers => "triggers",
        AssetGroupType::Events => "events",
        AssetGroupType::Columns => "columns",
        _ => "group",
    }
}

pub(super) fn ensure_mysql_table_data_container(kind: &ContainerKind) -> IpcResult<()> {
    if *kind == ContainerKind::Table || *kind == ContainerKind::View {
        return Ok(());
    }
    Err(IpcError::resource_not_found(
        "Selected container is not a table or view",
    ))
}

pub(super) fn mysql_table_select_expression(column: &ColumnMeta) -> String {
    let identifier = quote_mysql_identifier(&column.name);
    if column.data_category == ColumnDataCategory::Binary {
        format!("CASE WHEN {identifier} IS NULL THEN NULL ELSE '<BINARY>' END AS {identifier}")
    } else if mysql_should_select_bit_as_text(column) {
        let bit_width = mysql_bit_width(&column.type_name);
        format!("LPAD(BIN(CAST({identifier} AS UNSIGNED)), {bit_width}, '0') AS {identifier}")
    } else if mysql_should_select_geometry_as_text(column) {
        format!("ST_AsText({identifier}) AS {identifier}")
    } else if mysql_should_select_as_text(column) {
        format!("CAST({identifier} AS CHAR) AS {identifier}")
    } else {
        identifier
    }
}

pub(super) fn mysql_table_page_stats_sql(table: &str, where_clause: &str) -> String {
    format!("SELECT CAST(COUNT(*) AS CHAR) FROM {table}{where_clause}")
}

pub(super) fn mysql_should_select_as_text(column: &ColumnMeta) -> bool {
    if matches!(
        column.data_category,
        ColumnDataCategory::Date
            | ColumnDataCategory::Time
            | ColumnDataCategory::Datetime
            | ColumnDataCategory::Json
            | ColumnDataCategory::Enum
    ) {
        return true;
    }

    matches!(
        mysql_column_base_type(&column.type_name).as_str(),
        "bigint" | "decimal" | "numeric" | "year"
    )
}

pub(super) fn mysql_should_select_bit_as_text(column: &ColumnMeta) -> bool {
    mysql_column_base_type(&column.type_name) == "bit"
}

pub(super) fn mysql_bit_width(type_name: &str) -> u32 {
    type_name
        .trim()
        .strip_prefix("bit(")
        .and_then(|value| value.strip_suffix(')'))
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|width| *width > 0)
        .unwrap_or(1)
}

pub(super) fn mysql_should_select_geometry_as_text(column: &ColumnMeta) -> bool {
    matches!(
        mysql_column_base_type(&column.type_name).as_str(),
        "geometry"
            | "point"
            | "linestring"
            | "polygon"
            | "multipoint"
            | "multilinestring"
            | "multipolygon"
            | "geometrycollection"
    )
}

pub(super) fn mysql_column_base_type(type_name: &str) -> String {
    type_name
        .trim()
        .to_ascii_lowercase()
        .split('(')
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_string()
}

#[allow(clippy::too_many_arguments)]
pub(super) fn mysql_table_design_type_name(
    type_name: String,
    extra: &str,
    _generation_expression: Option<&str>,
    default_value: Option<&str>,
    _character_set_name: Option<&str>,
    _collation_name: Option<&str>,
    _table_charset: Option<&str>,
    _table_collation: Option<&str>,
) -> String {
    if mysql_on_update_clause(extra).is_some() && normalized_optional_text(default_value).is_none()
    {
        format!("{type_name} {MYSQL_UNSAFE_ON_UPDATE_TYPE_MARKER}")
    } else if default_value
        .map(|default_value| !mysql_default_is_render_safe(&type_name, default_value))
        .unwrap_or(false)
    {
        format!("{type_name} {MYSQL_UNSAFE_DEFAULT_TYPE_MARKER}")
    } else {
        type_name
    }
}

pub(super) fn mysql_generated_column_from_metadata(
    extra: &str,
    generation_expression: Option<&str>,
) -> Option<TableGeneratedColumn> {
    let expression = normalized_optional_text(generation_expression)?;
    let storage = if extra.to_ascii_uppercase().contains("VIRTUAL GENERATED") {
        TableGeneratedColumnStorage::Virtual
    } else {
        TableGeneratedColumnStorage::Stored
    };
    Some(TableGeneratedColumn {
        expression,
        storage,
    })
}

pub(super) fn mysql_default_is_render_safe(type_name: &str, default_value: &str) -> bool {
    let default_value = default_value.trim();
    if default_value.is_empty()
        || default_value.eq_ignore_ascii_case("NULL")
        || mysql_default_is_quoted_literal(default_value)
    {
        return true;
    }

    if mysql_type_has_unquoted_string_default_risk(type_name) {
        return false;
    }

    mysql_default_is_numeric_literal(default_value)
        || mysql_default_is_current_temporal_function(default_value)
}

pub(super) fn mysql_type_has_unquoted_string_default_risk(type_name: &str) -> bool {
    matches!(
        mysql_column_base_type(type_name).as_str(),
        "char" | "varchar" | "tinytext" | "text" | "mediumtext" | "longtext" | "enum" | "set"
    )
}

pub(super) fn mysql_default_is_quoted_literal(default_value: &str) -> bool {
    if default_value.len() >= 2 && default_value.starts_with('\'') && default_value.ends_with('\'')
    {
        return true;
    }

    let Some(quote_index) = default_value.find('\'') else {
        return false;
    };
    if !default_value.ends_with('\'') {
        return false;
    }

    let prefix = default_value[..quote_index].trim();
    if prefix.eq_ignore_ascii_case("n")
        || prefix.eq_ignore_ascii_case("x")
        || prefix.eq_ignore_ascii_case("b")
    {
        return true;
    }

    prefix
        .strip_prefix('_')
        .map(|charset| {
            !charset.is_empty()
                && charset
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        })
        .unwrap_or(false)
}

pub(super) fn mysql_default_is_numeric_literal(default_value: &str) -> bool {
    default_value
        .parse::<f64>()
        .map(|value| value.is_finite())
        .unwrap_or(false)
}

pub(super) fn mysql_default_is_current_temporal_function(default_value: &str) -> bool {
    let value = default_value.trim().to_ascii_uppercase();
    mysql_matches_current_temporal_function(&value, "CURRENT_TIMESTAMP", true)
        || mysql_matches_current_temporal_function(&value, "CURRENT_TIME", true)
        || mysql_matches_current_temporal_function(&value, "CURRENT_DATE", false)
}

pub(super) fn mysql_matches_current_temporal_function(
    value: &str,
    name: &str,
    allow_precision: bool,
) -> bool {
    if value == name {
        return true;
    }

    let Some(rest) = value.strip_prefix(name) else {
        return false;
    };
    if !rest.starts_with('(') || !rest.ends_with(')') {
        return false;
    }

    let precision = &rest[1..rest.len() - 1];
    precision.is_empty() || (allow_precision && precision.chars().all(|ch| ch.is_ascii_digit()))
}

pub(super) fn mysql_table_design_default_fragment(
    default_value: Option<String>,
    extra: &str,
) -> Option<String> {
    let default_value = normalized_optional_text(default_value.as_deref());
    let on_update = mysql_on_update_clause(extra);

    match (default_value, on_update) {
        (Some(default_value), Some(on_update)) => Some(format!("{default_value} {on_update}")),
        (default_value, _) => default_value,
    }
}

pub(super) fn mysql_on_update_clause(extra: &str) -> Option<String> {
    let lower_extra = extra.to_ascii_lowercase();
    let start = lower_extra.find("on update")?;
    let rest = extra[start + "on update".len()..].trim();
    if rest.is_empty() {
        None
    } else {
        Some(format!("ON UPDATE {rest}"))
    }
}

pub(super) fn mysql_unsupported_table_design_modify_reason(
    column: &TableColumnSchema,
) -> Option<String> {
    if column
        .type_name
        .contains(MYSQL_UNSAFE_ON_UPDATE_TYPE_MARKER)
    {
        return Some(format!(
            "暂不支持修改包含 ON UPDATE 且无显式默认值的 MySQL 列 '{}'",
            column.name
        ));
    }

    if column.type_name.contains(MYSQL_UNSAFE_DEFAULT_TYPE_MARKER) {
        return Some(format!(
            "暂不支持修改包含无法安全回放默认值元数据的 MySQL 列 '{}'",
            column.name
        ));
    }

    None
}

pub(super) fn primary_key_columns(columns: &[ColumnMeta]) -> Vec<String> {
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

pub(super) fn split_schema_columns(columns: Option<&str>) -> Vec<String> {
    columns
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|column| !column.is_empty())
        .map(ToString::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_i32_accepts_signed_unsigned_and_text_values() {
        assert_eq!(mysql_metadata_i32_from_i64(65), Some(65));
        assert_eq!(mysql_metadata_i32_from_u64(65), Some(65));
        assert_eq!(mysql_metadata_i32_from_text(" 65 "), Some(65));
        assert_eq!(mysql_metadata_i32_from_text("-1"), Some(-1));
    }

    #[test]
    fn metadata_numeric_conversions_reject_overflow() {
        assert_eq!(mysql_metadata_i32_from_i64(i64::from(i32::MAX) + 1), None);
        assert_eq!(
            mysql_metadata_i32_from_u64(u64::from(i32::MAX as u32) + 1),
            None
        );
        assert_eq!(mysql_metadata_u32_from_i64(-1), None);
        assert_eq!(mysql_metadata_u32_from_u64(u64::from(u32::MAX) + 1), None);
        assert_eq!(mysql_metadata_u32_from_text("not-a-number"), None);
    }
}
