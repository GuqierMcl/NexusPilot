use super::*;

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

pub(super) fn pg_table_select_expression(column: &ColumnMeta) -> String {
    let identifier = quote_pg_identifier(&column.name);
    if column.data_category == ColumnDataCategory::Enum
        || pg_should_select_as_text(&column.type_name)
    {
        format!("{identifier}::text AS {identifier}")
    } else {
        identifier
    }
}

pub(super) fn pg_table_page_stats_sql(table: &str, where_clause: &str) -> String {
    format!("SELECT COUNT(*) FROM {table}{where_clause}")
}

pub(super) fn pg_should_select_as_text(type_name: &str) -> bool {
    matches!(
        type_name.to_ascii_lowercase().as_str(),
        "array"
            | "bigint"
            | "bytea"
            | "box"
            | "cidr"
            | "circle"
            | "date"
            | "daterange"
            | "datemultirange"
            | "inet"
            | "int4range"
            | "int4multirange"
            | "int8"
            | "int8range"
            | "int8multirange"
            | "interval"
            | "json"
            | "jsonb"
            | "line"
            | "lseg"
            | "macaddr"
            | "macaddr8"
            | "money"
            | "numeric"
            | "numrange"
            | "nummultirange"
            | "path"
            | "point"
            | "polygon"
            | "time with time zone"
            | "time without time zone"
            | "tsrange"
            | "tsmultirange"
            | "tstzrange"
            | "tstzmultirange"
            | "timestamp with time zone"
            | "timestamp without time zone"
            | "tsvector"
            | "uuid"
            | "xml"
    )
}

pub(super) fn asset_group_slug(group_type: &AssetGroupType) -> &'static str {
    match group_type {
        AssetGroupType::Tables => "tables",
        AssetGroupType::Views => "views",
        AssetGroupType::MaterializedViews => "materialized-views",
        AssetGroupType::Functions => "functions",
        AssetGroupType::Procedures => "procedures",
        AssetGroupType::Indexes => "indexes",
        AssetGroupType::Triggers => "triggers",
        AssetGroupType::Sequences => "sequences",
        AssetGroupType::Extensions => "extensions",
        AssetGroupType::Columns => "columns",
        _ => "group",
    }
}

pub(super) fn ensure_postgres_table_data_container(kind: &ContainerKind) -> IpcResult<()> {
    if *kind == ContainerKind::Table
        || *kind == ContainerKind::View
        || *kind == ContainerKind::MaterializedView
    {
        return Ok(());
    }
    Err(IpcError::resource_not_found(
        "Selected container is not a table or view",
    ))
}
