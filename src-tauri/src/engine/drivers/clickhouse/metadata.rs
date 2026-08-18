use std::collections::BTreeSet;
use std::future::Future;
use std::time::Duration;

use async_trait::async_trait;
use clickhouse::Client;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use super::catalog::{
    optional_nullable_column, optional_system_table_is_absent, optional_text_column,
    require_catalog_columns, SystemCatalogColumnProbe,
};
use super::ClickHouseDriver;
use crate::engine::driver::SchemaBrowser;
use crate::engine::types::{
    AssetGroupType, ContainerKind, ContainerProperty, ContainerRef, DataContainer,
};
use crate::error::{IpcError, IpcResult};

#[derive(Debug, Clone, PartialEq, Eq)]
enum MetadataRequest {
    Root,
    Functions,
    Database {
        database: String,
    },
    DatabaseGroup {
        group: AssetGroupType,
        database: String,
    },
    TableLike {
        kind: ContainerKind,
        database: String,
        table: String,
    },
    TableGroup {
        group: AssetGroupType,
        database: String,
        table: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum MetadataQuery {
    Databases,
    Functions,
    Tables { database: String },
    Dictionaries { database: String },
    Columns { database: String, table: String },
    Indexes { database: String, table: String },
    Projections { database: String, table: String },
    Partitions { database: String, table: String },
}

#[derive(Debug)]
enum MetadataRows {
    Databases(Vec<DatabaseRow>),
    Functions(Vec<FunctionRow>),
    Tables(Vec<TableRow>),
    Dictionaries(Vec<DictionaryRow>),
    Columns(Vec<ColumnRow>),
    Indexes(Vec<IndexRow>),
    Projections(Vec<ProjectionRow>),
    Partitions(Vec<PartitionRow>),
}

#[derive(Debug, Clone, clickhouse::Row, Deserialize, PartialEq, Eq)]
struct DatabaseRow {
    name: String,
}

#[derive(Debug, Clone, clickhouse::Row, Deserialize, PartialEq, Eq)]
struct FunctionRow {
    name: String,
    is_aggregate: Option<u8>,
    case_insensitive: Option<u8>,
    alias_to: String,
}

#[derive(Debug, Clone, clickhouse::Row, Deserialize, PartialEq, Eq)]
struct TableRow {
    name: String,
    engine: String,
    total_rows: Option<u64>,
    total_bytes: Option<u64>,
    comment: String,
    create_table_query: String,
}

#[derive(Debug, Clone, clickhouse::Row, Deserialize, PartialEq, Eq)]
struct DictionaryRow {
    name: String,
    status: String,
    origin: String,
    type_name: String,
}

#[derive(Debug, Clone, clickhouse::Row, Deserialize, PartialEq, Eq)]
struct ColumnRow {
    name: String,
    type_name: String,
    default_kind: String,
    default_expression: String,
    codec_expression: String,
    is_in_sorting_key: Option<u8>,
    is_in_primary_key: Option<u8>,
    is_in_partition_key: Option<u8>,
    is_in_sampling_key: Option<u8>,
    comment: String,
}

#[derive(Debug, Clone, clickhouse::Row, Deserialize, PartialEq, Eq)]
struct IndexRow {
    name: String,
    type_name: String,
    expression: String,
    granularity: Option<u64>,
}

#[derive(Debug, Clone, clickhouse::Row, Deserialize, PartialEq, Eq)]
struct ProjectionRow {
    name: String,
    query: String,
}

#[derive(Debug, Clone, clickhouse::Row, Deserialize, PartialEq, Eq)]
struct PartitionRow {
    partition_id: String,
    partition_value: String,
    rows: u64,
    bytes: u64,
}

#[derive(Debug, Clone, clickhouse::Row, Deserialize, PartialEq, Eq)]
struct SystemColumnRow {
    name: String,
}

#[async_trait]
trait MetadataExecutor: Send + Sync {
    async fn execute(&self, query: MetadataQuery) -> IpcResult<MetadataRows>;
}

struct ClientMetadataExecutor<'a> {
    client: &'a Client,
    timeout: Duration,
    shutdown: watch::Receiver<bool>,
}

#[async_trait]
impl SystemCatalogColumnProbe for ClientMetadataExecutor<'_> {
    async fn available_system_columns(
        &self,
        system_table: &'static str,
    ) -> IpcResult<BTreeSet<String>> {
        let rows = bounded_metadata(
            "inspect metadata columns",
            self.timeout,
            self.shutdown.clone(),
            self.client
                .query(LIST_SYSTEM_COLUMNS_SQL)
                .bind(system_table)
                .fetch_all::<SystemColumnRow>(),
        )
        .await?;
        Ok(rows.into_iter().map(|row| row.name).collect())
    }
}

const LIST_DATABASES_SQL: &str = "SELECT name FROM system.databases ORDER BY name";
const LIST_SYSTEM_COLUMNS_SQL: &str = r#"
    SELECT name
    FROM system.columns
    WHERE database = 'system' AND table = ?
    ORDER BY name
"#;
const LIST_PARTITIONS_SQL: &str = r#"
    SELECT partition_id, partition AS partition_value,
           sum(rows) AS rows, sum(bytes_on_disk) AS bytes
    FROM system.parts
    WHERE active = 1 AND database = ? AND table = ?
    GROUP BY partition_id, partition
    ORDER BY partition_id
"#;

fn build_functions_sql(available: &BTreeSet<String>) -> IpcResult<String> {
    require_catalog_columns(available, "functions", &["name"])?;
    Ok(format!(
        "SELECT name, {}, {}, {} FROM system.functions ORDER BY name",
        optional_nullable_column(available, "is_aggregate", "UInt8", "is_aggregate"),
        optional_nullable_column(available, "case_insensitive", "UInt8", "case_insensitive",),
        optional_text_column(available, "alias_to", "alias_to"),
    ))
}

fn build_tables_sql(available: &BTreeSet<String>) -> IpcResult<String> {
    require_catalog_columns(available, "tables", &["database", "name", "engine"])?;
    Ok(format!(
        "SELECT name, engine, {}, {}, {}, {} FROM system.tables \
         WHERE database = ? ORDER BY name",
        optional_nullable_column(available, "total_rows", "UInt64", "total_rows"),
        optional_nullable_column(available, "total_bytes", "UInt64", "total_bytes"),
        optional_text_column(available, "comment", "comment"),
        optional_text_column(available, "create_table_query", "create_table_query"),
    ))
}

fn build_dictionaries_sql(available: &BTreeSet<String>) -> IpcResult<String> {
    require_catalog_columns(available, "dictionaries", &["database", "name"])?;
    Ok(format!(
        "SELECT name, {}, {}, {} FROM system.dictionaries \
         WHERE database = ? ORDER BY name",
        optional_text_column(available, "status", "status"),
        optional_text_column(available, "origin", "origin"),
        optional_text_column(available, "type", "type_name"),
    ))
}

fn build_columns_sql(available: &BTreeSet<String>) -> IpcResult<String> {
    require_catalog_columns(available, "columns", &["database", "table", "name", "type"])?;
    let order_by = if available.contains("position") {
        "position"
    } else {
        "name"
    };
    Ok(format!(
        "SELECT name, type AS type_name, {}, {}, {}, {}, {}, {}, {}, {} \
         FROM system.columns WHERE database = ? AND table = ? ORDER BY {order_by}",
        optional_text_column(available, "default_kind", "default_kind"),
        optional_text_column(available, "default_expression", "default_expression"),
        optional_text_column(available, "compression_codec", "codec_expression"),
        optional_nullable_column(available, "is_in_sorting_key", "UInt8", "is_in_sorting_key"),
        optional_nullable_column(available, "is_in_primary_key", "UInt8", "is_in_primary_key"),
        optional_nullable_column(
            available,
            "is_in_partition_key",
            "UInt8",
            "is_in_partition_key",
        ),
        optional_nullable_column(
            available,
            "is_in_sampling_key",
            "UInt8",
            "is_in_sampling_key",
        ),
        optional_text_column(available, "comment", "comment"),
    ))
}

fn build_indexes_sql(available: &BTreeSet<String>) -> IpcResult<String> {
    require_catalog_columns(
        available,
        "data_skipping_indices",
        &["database", "table", "name"],
    )?;
    Ok(format!(
        "SELECT name, {}, {}, {} FROM system.data_skipping_indices \
         WHERE database = ? AND table = ? ORDER BY name",
        optional_text_column(available, "type", "type_name"),
        optional_text_column(available, "expr", "expression"),
        optional_nullable_column(available, "granularity", "UInt64", "granularity"),
    ))
}

fn build_projections_sql(available: &BTreeSet<String>) -> IpcResult<String> {
    require_catalog_columns(available, "projections", &["database", "table", "name"])?;
    Ok(format!(
        "SELECT name, {} FROM system.projections \
         WHERE database = ? AND table = ? ORDER BY name",
        optional_text_column(available, "query", "query"),
    ))
}

async fn bounded_metadata<T, F>(
    operation: &'static str,
    timeout: Duration,
    mut shutdown: watch::Receiver<bool>,
    request: F,
) -> IpcResult<T>
where
    F: Future<Output = Result<T, clickhouse::error::Error>>,
{
    if *shutdown.borrow() {
        return Err(IpcError::operation_canceled(
            "ClickHouse metadata request canceled",
            "The runtime is closing",
        ));
    }
    tokio::select! {
        biased;
        _ = shutdown.changed() => Err(IpcError::operation_canceled(
            "ClickHouse metadata request canceled",
            "The runtime closed while metadata was in flight",
        )),
        result = tokio::time::timeout(timeout, request) => match result {
            Ok(result) => result.map_err(|error| {
                super::error::classify_metadata_error(error, operation)
            }),
            Err(_) => Err(IpcError::network_timeout(
                format!("ClickHouse {operation} timed out"),
                format!("Metadata request exceeded {} ms", timeout.as_millis()),
            )),
        },
    }
}

#[async_trait]
impl MetadataExecutor for ClientMetadataExecutor<'_> {
    async fn execute(&self, query: MetadataQuery) -> IpcResult<MetadataRows> {
        match query {
            MetadataQuery::Databases => {
                let rows = bounded_metadata(
                    "list databases",
                    self.timeout,
                    self.shutdown.clone(),
                    self.client
                        .query(LIST_DATABASES_SQL)
                        .fetch_all::<DatabaseRow>(),
                )
                .await?;
                Ok(MetadataRows::Databases(rows))
            }
            MetadataQuery::Functions => {
                let available = self.available_system_columns("functions").await?;
                let sql = build_functions_sql(&available)?;
                let rows = bounded_metadata(
                    "list functions",
                    self.timeout,
                    self.shutdown.clone(),
                    self.client.query(&sql).fetch_all::<FunctionRow>(),
                )
                .await?;
                Ok(MetadataRows::Functions(rows))
            }
            MetadataQuery::Tables { database } => {
                let available = self.available_system_columns("tables").await?;
                let sql = build_tables_sql(&available)?;
                let rows = bounded_metadata(
                    "list tables",
                    self.timeout,
                    self.shutdown.clone(),
                    self.client
                        .query(&sql)
                        .bind(database)
                        .fetch_all::<TableRow>(),
                )
                .await?;
                Ok(MetadataRows::Tables(rows))
            }
            MetadataQuery::Dictionaries { database } => {
                let available = self.available_system_columns("dictionaries").await?;
                if optional_system_table_is_absent("dictionaries", &available) {
                    return Ok(MetadataRows::Dictionaries(Vec::new()));
                }
                let sql = build_dictionaries_sql(&available)?;
                let rows = bounded_metadata(
                    "list dictionaries",
                    self.timeout,
                    self.shutdown.clone(),
                    self.client
                        .query(&sql)
                        .bind(database)
                        .fetch_all::<DictionaryRow>(),
                )
                .await?;
                Ok(MetadataRows::Dictionaries(rows))
            }
            MetadataQuery::Columns { database, table } => {
                let available = self.available_system_columns("columns").await?;
                let sql = build_columns_sql(&available)?;
                let rows = bounded_metadata(
                    "list columns",
                    self.timeout,
                    self.shutdown.clone(),
                    self.client
                        .query(&sql)
                        .bind(database)
                        .bind(table)
                        .fetch_all::<ColumnRow>(),
                )
                .await?;
                Ok(MetadataRows::Columns(rows))
            }
            MetadataQuery::Indexes { database, table } => {
                let available = self
                    .available_system_columns("data_skipping_indices")
                    .await?;
                if optional_system_table_is_absent("data_skipping_indices", &available) {
                    return Ok(MetadataRows::Indexes(Vec::new()));
                }
                let sql = build_indexes_sql(&available)?;
                let rows = bounded_metadata(
                    "list indexes",
                    self.timeout,
                    self.shutdown.clone(),
                    self.client
                        .query(&sql)
                        .bind(database)
                        .bind(table)
                        .fetch_all::<IndexRow>(),
                )
                .await?;
                Ok(MetadataRows::Indexes(rows))
            }
            MetadataQuery::Projections { database, table } => {
                let available = self.available_system_columns("projections").await?;
                if optional_system_table_is_absent("projections", &available) {
                    return Ok(MetadataRows::Projections(Vec::new()));
                }
                let sql = build_projections_sql(&available)?;
                let rows = bounded_metadata(
                    "list projections",
                    self.timeout,
                    self.shutdown.clone(),
                    self.client
                        .query(&sql)
                        .bind(database)
                        .bind(table)
                        .fetch_all::<ProjectionRow>(),
                )
                .await?;
                Ok(MetadataRows::Projections(rows))
            }
            MetadataQuery::Partitions { database, table } => {
                let rows = bounded_metadata(
                    "list partitions",
                    self.timeout,
                    self.shutdown.clone(),
                    self.client
                        .query(LIST_PARTITIONS_SQL)
                        .bind(database)
                        .bind(table)
                        .fetch_all::<PartitionRow>(),
                )
                .await?;
                Ok(MetadataRows::Partitions(rows))
            }
        }
    }
}

fn required(value: &Option<String>, field: &str) -> IpcResult<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            IpcError::validation_failed(format!("Missing metadata address field: {field}"))
        })
}

fn route(parent: Option<&ContainerRef>) -> IpcResult<MetadataRequest> {
    let Some(parent) = parent else {
        return Ok(MetadataRequest::Root);
    };
    match (&parent.kind, &parent.group_type) {
        (ContainerKind::Database, None) => Ok(MetadataRequest::Database {
            database: required(&parent.database, "database")?,
        }),
        (ContainerKind::AssetGroup, Some(AssetGroupType::Functions))
            if parent.database.is_none() && parent.schema.is_none() && parent.table.is_none() =>
        {
            Ok(MetadataRequest::Functions)
        }
        (ContainerKind::AssetGroup, Some(group))
            if parent.schema.is_none()
                && parent.table.is_some()
                && matches!(
                    group,
                    AssetGroupType::Columns
                        | AssetGroupType::Indexes
                        | AssetGroupType::Projections
                        | AssetGroupType::Partitions
                ) =>
        {
            Ok(MetadataRequest::TableGroup {
                group: group.clone(),
                database: required(&parent.database, "database")?,
                table: required(&parent.table, "table")?,
            })
        }
        (ContainerKind::AssetGroup, Some(group))
            if parent.schema.is_none()
                && parent.table.is_none()
                && matches!(
                    group,
                    AssetGroupType::Tables
                        | AssetGroupType::Views
                        | AssetGroupType::MaterializedViews
                        | AssetGroupType::Dictionaries
                ) =>
        {
            Ok(MetadataRequest::DatabaseGroup {
                group: group.clone(),
                database: required(&parent.database, "database")?,
            })
        }
        (
            kind @ (ContainerKind::Table | ContainerKind::View | ContainerKind::MaterializedView),
            None,
        ) if parent.schema.is_none() => Ok(MetadataRequest::TableLike {
            kind: kind.clone(),
            database: required(&parent.database, "database")?,
            table: required(&parent.table, "table")?,
        }),
        _ => Err(IpcError::validation_failed(
            "Unsupported ClickHouse metadata parent",
        )),
    }
}

fn classify_engine(engine: &str) -> ContainerKind {
    match engine {
        "View" | "WindowView" | "LiveView" => ContainerKind::View,
        "MaterializedView" => ContainerKind::MaterializedView,
        "Dictionary" => ContainerKind::Dictionary,
        _ => ContainerKind::Table,
    }
}

fn view_family(engine: &str, create_table_query: &str) -> Option<&'static str> {
    let query = create_table_query.to_ascii_uppercase();
    match engine {
        "WindowView" => Some("window"),
        "LiveView" => Some("live"),
        "MaterializedView" if query.contains(" REFRESH ") => Some("refreshable_materialized"),
        "MaterializedView" => Some("materialized"),
        "View" if query.contains("PARAMETERIZED VIEW") => Some("parameterized"),
        "View" => Some("normal"),
        _ => None,
    }
}

fn serialized_name<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

fn stable_id(address: &ContainerRef) -> String {
    let mut segments = vec![
        "clickhouse".to_string(),
        format!("kind={}", serialized_name(&address.kind)),
    ];
    if let Some(group_type) = &address.group_type {
        segments.push(format!("group={}", serialized_name(group_type)));
    }
    for (field, value) in [
        ("database", address.database.as_deref()),
        ("schema", address.schema.as_deref()),
        ("table", address.table.as_deref()),
        ("column", address.column.as_deref()),
        ("object", address.object_name.as_deref()),
        ("key", address.key.as_deref()),
        ("pattern", address.pattern.as_deref()),
    ] {
        if let Some(value) = value {
            segments.push(format!("{field}={value}"));
        }
    }
    if let Some(db_index) = address.db_index {
        segments.push(format!("dbIndex={db_index}"));
    }
    segments
        .into_iter()
        .map(|segment| format!("{}:{segment}", segment.len()))
        .collect::<Vec<_>>()
        .join("::")
}

fn property(
    key: impl Into<String>,
    label: impl Into<String>,
    value: impl Into<String>,
) -> ContainerProperty {
    ContainerProperty {
        key: key.into(),
        label: label.into(),
        value: value.into(),
    }
}

fn display_text(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(512)
        .collect::<String>()
        .trim()
        .to_string()
}

fn push_text_property(
    properties: &mut Vec<ContainerProperty>,
    key: &str,
    label: &str,
    value: &str,
) {
    let value = display_text(value);
    if !value.is_empty() {
        properties.push(property(key, label, value));
    }
}

fn origin_summary(origin: &str) -> String {
    let without_query = origin
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .replace('\\', "/");
    display_text(without_query.rsplit('/').next().unwrap_or_default())
}

fn wrapper_inner<'a>(type_name: &'a str, wrapper: &str) -> Option<&'a str> {
    type_name
        .strip_prefix(wrapper)
        .and_then(|value| value.strip_prefix('('))
        .and_then(|value| value.strip_suffix(')'))
}

fn is_nullable_type(type_name: &str) -> bool {
    let mut current = type_name.trim();
    loop {
        if wrapper_inner(current, "Nullable").is_some() {
            return true;
        }
        let Some(inner) = wrapper_inner(current, "LowCardinality") else {
            return false;
        };
        current = inner.trim();
    }
}

fn database_container(name: String) -> DataContainer {
    let address = ContainerRef::database(name.clone());
    DataContainer {
        id: stable_id(&address),
        name,
        kind: ContainerKind::Database,
        is_leaf: false,
        container: address,
        type_name: None,
        nullable: None,
        item_count: None,
        properties: Vec::new(),
    }
}

fn functions_group_container() -> DataContainer {
    let address = ContainerRef::asset_group(AssetGroupType::Functions, None, None, None);
    DataContainer {
        id: stable_id(&address),
        name: "Functions".to_string(),
        kind: ContainerKind::AssetGroup,
        is_leaf: false,
        container: address,
        type_name: None,
        nullable: None,
        item_count: None,
        properties: Vec::new(),
    }
}

fn function_container(row: FunctionRow) -> DataContainer {
    let address = ContainerRef::connection_named_object(ContainerKind::Function, row.name.clone());
    let mut properties = Vec::new();
    if let Some(is_aggregate) = row.is_aggregate {
        properties.push(property(
            "isAggregate",
            "聚合函数",
            (is_aggregate != 0).to_string(),
        ));
    }
    if let Some(case_insensitive) = row.case_insensitive {
        properties.push(property(
            "caseInsensitive",
            "大小写不敏感",
            (case_insensitive != 0).to_string(),
        ));
    }
    if !row.alias_to.trim().is_empty() {
        properties.push(property("aliasTo", "别名", row.alias_to));
    }
    DataContainer {
        id: stable_id(&address),
        name: row.name,
        kind: ContainerKind::Function,
        is_leaf: true,
        container: address,
        type_name: None,
        nullable: None,
        item_count: None,
        properties,
    }
}

fn asset_group_container(
    database: &str,
    table: Option<&str>,
    group_type: AssetGroupType,
    name: &str,
) -> DataContainer {
    let address = ContainerRef::asset_group(
        group_type,
        Some(database.to_string()),
        None,
        table.map(str::to_string),
    );
    DataContainer {
        id: stable_id(&address),
        name: name.to_string(),
        kind: ContainerKind::AssetGroup,
        is_leaf: false,
        container: address,
        type_name: None,
        nullable: None,
        item_count: None,
        properties: Vec::new(),
    }
}

fn database_asset_groups(database: &str) -> Vec<DataContainer> {
    [
        (AssetGroupType::Tables, "Tables"),
        (AssetGroupType::Views, "Views"),
        (AssetGroupType::MaterializedViews, "Materialized Views"),
        (AssetGroupType::Dictionaries, "Dictionaries"),
    ]
    .into_iter()
    .map(|(group, name)| asset_group_container(database, None, group, name))
    .collect()
}

fn table_container(database: &str, row: TableRow) -> DataContainer {
    let kind = classify_engine(&row.engine);
    let address = ContainerRef::table(kind.clone(), database, None, row.name.clone());
    let mut properties = vec![property("engine", "引擎", display_text(&row.engine))];
    if let Some(family) = view_family(&row.engine, &row.create_table_query) {
        properties.push(property("viewFamily", "Family", family));
    }
    if let Some(total_rows) = row.total_rows {
        properties.push(property("totalRows", "总行数", total_rows.to_string()));
    }
    if let Some(total_bytes) = row.total_bytes {
        properties.push(property("totalBytes", "总字节数", total_bytes.to_string()));
    }
    push_text_property(&mut properties, "comment", "注释", &row.comment);
    DataContainer {
        id: stable_id(&address),
        name: row.name,
        kind,
        is_leaf: false,
        container: address,
        type_name: None,
        nullable: None,
        item_count: None,
        properties,
    }
}

fn table_group_accepts(group: &AssetGroupType, kind: &ContainerKind) -> bool {
    matches!(
        (group, kind),
        (AssetGroupType::Tables, ContainerKind::Table)
            | (AssetGroupType::Views, ContainerKind::View)
            | (
                AssetGroupType::MaterializedViews,
                ContainerKind::MaterializedView
            )
    )
}

fn dictionary_container(database: &str, row: DictionaryRow) -> DataContainer {
    let address =
        ContainerRef::named_object(ContainerKind::Dictionary, database, None, row.name.clone());
    let mut properties = Vec::new();
    push_text_property(&mut properties, "status", "状态", &row.status);
    push_text_property(
        &mut properties,
        "origin",
        "来源",
        &origin_summary(&row.origin),
    );
    push_text_property(&mut properties, "type", "类型", &row.type_name);
    DataContainer {
        id: stable_id(&address),
        name: row.name,
        kind: ContainerKind::Dictionary,
        is_leaf: true,
        container: address,
        type_name: None,
        nullable: None,
        item_count: None,
        properties,
    }
}

fn table_asset_groups(kind: &ContainerKind, database: &str, table: &str) -> Vec<DataContainer> {
    let groups: &[(AssetGroupType, &str)] = match kind {
        ContainerKind::Table => &[
            (AssetGroupType::Columns, "Columns"),
            (AssetGroupType::Indexes, "Indexes"),
            (AssetGroupType::Projections, "Projections"),
            (AssetGroupType::Partitions, "Partitions"),
        ],
        ContainerKind::View | ContainerKind::MaterializedView => {
            &[(AssetGroupType::Columns, "Columns")]
        }
        _ => return Vec::new(),
    };
    groups
        .iter()
        .map(|(group, name)| asset_group_container(database, Some(table), group.clone(), name))
        .collect()
}

fn column_container(database: &str, table: &str, row: ColumnRow) -> DataContainer {
    let address = ContainerRef::column(database, None, table, row.name.clone());
    let mut properties = Vec::new();
    push_text_property(
        &mut properties,
        "defaultKind",
        "默认值类型",
        &row.default_kind,
    );
    push_text_property(
        &mut properties,
        "defaultExpression",
        "默认值表达式",
        &row.default_expression,
    );
    push_text_property(&mut properties, "codec", "压缩编码", &row.codec_expression);
    for (key, label, value) in [
        ("isInSortingKey", "排序键", row.is_in_sorting_key),
        ("isInPrimaryKey", "主键", row.is_in_primary_key),
        ("isInPartitionKey", "分区键", row.is_in_partition_key),
        ("isInSamplingKey", "采样键", row.is_in_sampling_key),
    ] {
        if let Some(value) = value {
            properties.push(property(key, label, (value != 0).to_string()));
        }
    }
    push_text_property(&mut properties, "comment", "注释", &row.comment);
    DataContainer {
        id: stable_id(&address),
        name: row.name,
        kind: ContainerKind::Column,
        is_leaf: true,
        container: address,
        type_name: Some(row.type_name.clone()),
        nullable: Some(is_nullable_type(&row.type_name)),
        item_count: None,
        properties,
    }
}

fn index_container(database: &str, table: &str, row: IndexRow) -> DataContainer {
    let address =
        ContainerRef::table_named_object(ContainerKind::Index, database, table, row.name.clone());
    let mut properties = Vec::new();
    push_text_property(&mut properties, "type", "类型", &row.type_name);
    push_text_property(&mut properties, "expression", "表达式", &row.expression);
    if let Some(granularity) = row.granularity {
        properties.push(property("granularity", "粒度", granularity.to_string()));
    }
    DataContainer {
        id: stable_id(&address),
        name: row.name,
        kind: ContainerKind::Index,
        is_leaf: true,
        container: address,
        type_name: None,
        nullable: None,
        item_count: None,
        properties,
    }
}

fn projection_container(database: &str, table: &str, row: ProjectionRow) -> DataContainer {
    let address = ContainerRef::table_named_object(
        ContainerKind::Projection,
        database,
        table,
        row.name.clone(),
    );
    let mut properties = Vec::new();
    push_text_property(&mut properties, "definition", "定义", &row.query);
    DataContainer {
        id: stable_id(&address),
        name: row.name,
        kind: ContainerKind::Projection,
        is_leaf: true,
        container: address,
        type_name: None,
        nullable: None,
        item_count: None,
        properties,
    }
}

fn partition_container(database: &str, table: &str, row: PartitionRow) -> DataContainer {
    let address = ContainerRef::table_named_object(
        ContainerKind::Partition,
        database,
        table,
        row.partition_id.clone(),
    );
    let name = if row.partition_value.trim().is_empty() {
        row.partition_id.clone()
    } else {
        display_text(&row.partition_value)
    };
    let properties = vec![
        property("partitionId", "分区 ID", row.partition_id),
        property(
            "partitionValue",
            "分区值",
            display_text(&row.partition_value),
        ),
        property("rows", "行数", row.rows.to_string()),
        property("bytes", "字节数", row.bytes.to_string()),
    ];
    DataContainer {
        id: stable_id(&address),
        name,
        kind: ContainerKind::Partition,
        is_leaf: true,
        container: address,
        type_name: None,
        nullable: None,
        item_count: None,
        properties,
    }
}

async fn list_containers_with(
    executor: &dyn MetadataExecutor,
    parent: Option<&ContainerRef>,
) -> IpcResult<Vec<DataContainer>> {
    match route(parent)? {
        MetadataRequest::Root => {
            let MetadataRows::Databases(rows) = executor.execute(MetadataQuery::Databases).await?
            else {
                return Err(IpcError::system_internal(
                    "ClickHouse database metadata returned an unexpected shape",
                    "Expected database rows",
                ));
            };
            let mut containers = rows
                .into_iter()
                .map(|row| database_container(row.name))
                .collect::<Vec<_>>();
            containers.sort_by(|left, right| left.name.cmp(&right.name));
            containers.push(functions_group_container());
            Ok(containers)
        }
        MetadataRequest::Functions => {
            let MetadataRows::Functions(rows) = executor.execute(MetadataQuery::Functions).await?
            else {
                return Err(IpcError::system_internal(
                    "ClickHouse function metadata returned an unexpected shape",
                    "Expected function rows",
                ));
            };
            let mut containers = rows.into_iter().map(function_container).collect::<Vec<_>>();
            containers.sort_by(|left, right| left.name.cmp(&right.name));
            Ok(containers)
        }
        MetadataRequest::Database { database } => Ok(database_asset_groups(&database)),
        MetadataRequest::DatabaseGroup { group, database } => match group {
            AssetGroupType::Dictionaries => {
                let MetadataRows::Dictionaries(rows) = executor
                    .execute(MetadataQuery::Dictionaries {
                        database: database.clone(),
                    })
                    .await?
                else {
                    return Err(IpcError::system_internal(
                        "ClickHouse dictionary metadata returned an unexpected shape",
                        "Expected dictionary rows",
                    ));
                };
                let mut containers = rows
                    .into_iter()
                    .map(|row| dictionary_container(&database, row))
                    .collect::<Vec<_>>();
                containers.sort_by(|left, right| left.name.cmp(&right.name));
                Ok(containers)
            }
            AssetGroupType::Tables | AssetGroupType::Views | AssetGroupType::MaterializedViews => {
                let MetadataRows::Tables(rows) = executor
                    .execute(MetadataQuery::Tables {
                        database: database.clone(),
                    })
                    .await?
                else {
                    return Err(IpcError::system_internal(
                        "ClickHouse table metadata returned an unexpected shape",
                        "Expected table rows",
                    ));
                };
                let mut containers = rows
                    .into_iter()
                    .map(|row| table_container(&database, row))
                    .filter(|container| table_group_accepts(&group, &container.kind))
                    .collect::<Vec<_>>();
                containers.sort_by(|left, right| left.name.cmp(&right.name));
                Ok(containers)
            }
            _ => Err(IpcError::validation_failed(
                "Unsupported ClickHouse database metadata group",
            )),
        },
        MetadataRequest::TableLike {
            kind,
            database,
            table,
        } => Ok(table_asset_groups(&kind, &database, &table)),
        MetadataRequest::TableGroup {
            group,
            database,
            table,
        } => {
            let mut containers = match group {
                AssetGroupType::Columns => {
                    let MetadataRows::Columns(rows) = executor
                        .execute(MetadataQuery::Columns {
                            database: database.clone(),
                            table: table.clone(),
                        })
                        .await?
                    else {
                        return Err(IpcError::system_internal(
                            "ClickHouse column metadata returned an unexpected shape",
                            "Expected column rows",
                        ));
                    };
                    rows.into_iter()
                        .map(|row| column_container(&database, &table, row))
                        .collect::<Vec<_>>()
                }
                AssetGroupType::Indexes => {
                    let MetadataRows::Indexes(rows) = executor
                        .execute(MetadataQuery::Indexes {
                            database: database.clone(),
                            table: table.clone(),
                        })
                        .await?
                    else {
                        return Err(IpcError::system_internal(
                            "ClickHouse index metadata returned an unexpected shape",
                            "Expected index rows",
                        ));
                    };
                    rows.into_iter()
                        .map(|row| index_container(&database, &table, row))
                        .collect::<Vec<_>>()
                }
                AssetGroupType::Projections => {
                    let MetadataRows::Projections(rows) = executor
                        .execute(MetadataQuery::Projections {
                            database: database.clone(),
                            table: table.clone(),
                        })
                        .await?
                    else {
                        return Err(IpcError::system_internal(
                            "ClickHouse projection metadata returned an unexpected shape",
                            "Expected projection rows",
                        ));
                    };
                    rows.into_iter()
                        .map(|row| projection_container(&database, &table, row))
                        .collect::<Vec<_>>()
                }
                AssetGroupType::Partitions => {
                    let MetadataRows::Partitions(rows) = executor
                        .execute(MetadataQuery::Partitions {
                            database: database.clone(),
                            table: table.clone(),
                        })
                        .await?
                    else {
                        return Err(IpcError::system_internal(
                            "ClickHouse partition metadata returned an unexpected shape",
                            "Expected partition rows",
                        ));
                    };
                    rows.into_iter()
                        .map(|row| partition_container(&database, &table, row))
                        .collect::<Vec<_>>()
                }
                _ => {
                    return Err(IpcError::validation_failed(
                        "Unsupported ClickHouse table metadata group",
                    ));
                }
            };
            containers.sort_by(|left, right| left.name.cmp(&right.name));
            Ok(containers)
        }
    }
}

#[async_trait]
impl SchemaBrowser for ClickHouseDriver {
    async fn list_containers(
        &self,
        parent: Option<&ContainerRef>,
    ) -> IpcResult<Vec<DataContainer>> {
        list_containers_with(
            &ClientMetadataExecutor {
                client: &self.client,
                timeout: self.timeout,
                shutdown: self.shutdown.subscribe(),
            },
            parent,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::collections::VecDeque;
    use std::sync::Mutex;
    use std::time::Duration;

    use super::*;
    use crate::engine::types::{AssetGroupType, ContainerKind, ContainerRef};
    use crate::error::{ErrorCode, RuntimeErrorImpact};

    fn catalog_columns(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|name| (*name).to_string()).collect()
    }

    #[test]
    fn metadata_queries_replace_missing_optional_columns_with_safe_defaults() {
        let functions = build_functions_sql(&catalog_columns(&["name", "is_aggregate"]))
            .expect("function query should keep missing properties optional");
        assert!(functions.contains("CAST(is_aggregate, 'Nullable(UInt8)') AS is_aggregate"));
        assert!(functions.contains("CAST(NULL, 'Nullable(UInt8)') AS case_insensitive"));
        assert!(functions.contains("'' AS alias_to"));

        let tables = build_tables_sql(&catalog_columns(&["database", "name", "engine"]))
            .expect("table query should keep statistics optional");
        assert!(tables.contains("CAST(NULL, 'Nullable(UInt64)') AS total_rows"));
        assert!(tables.contains("CAST(NULL, 'Nullable(UInt64)') AS total_bytes"));
        assert!(tables.contains("'' AS comment"));

        let columns = build_columns_sql(&catalog_columns(&[
            "database", "table", "name", "type", "position",
        ]))
        .expect("column query should keep descriptive properties optional");
        assert!(columns.contains("'' AS default_kind"));
        assert!(columns.contains("'' AS codec_expression"));
        assert!(columns.contains("CAST(NULL, 'Nullable(UInt8)') AS is_in_sorting_key"));
        assert!(columns.contains("ORDER BY position"));
    }

    #[test]
    fn metadata_queries_reject_missing_required_identity_columns() {
        let error = build_tables_sql(&catalog_columns(&["database", "name", "comment"]))
            .expect_err("engine is required for object classification");
        assert_eq!(error.code, ErrorCode::SystemInternal);
        assert_eq!(error.runtime_impact, RuntimeErrorImpact::BusinessOnly);
        assert!(!error.details.unwrap_or_default().contains("SELECT"));
    }

    #[test]
    fn optional_system_tables_are_empty_only_when_catalog_has_no_columns() {
        assert!(optional_system_table_is_absent(
            "dictionaries",
            &BTreeSet::new()
        ));
        assert!(optional_system_table_is_absent(
            "data_skipping_indices",
            &BTreeSet::new()
        ));
        assert!(optional_system_table_is_absent(
            "projections",
            &BTreeSet::new()
        ));
        assert!(!optional_system_table_is_absent("tables", &BTreeSet::new()));
        assert!(!optional_system_table_is_absent(
            "projections",
            &catalog_columns(&["name"])
        ));
    }

    #[test]
    fn unavailable_optional_columns_do_not_create_false_properties() {
        let function = function_container(FunctionRow {
            name: "legacyFunction".to_string(),
            is_aggregate: None,
            case_insensitive: None,
            alias_to: String::new(),
        });
        assert!(function.properties.is_empty());

        let column = column_container(
            "analytics",
            "events",
            ColumnRow {
                name: "value".to_string(),
                type_name: "UInt64".to_string(),
                default_kind: String::new(),
                default_expression: String::new(),
                codec_expression: String::new(),
                is_in_sorting_key: None,
                is_in_primary_key: None,
                is_in_partition_key: None,
                is_in_sampling_key: None,
                comment: String::new(),
            },
        );
        assert!(column.properties.is_empty());

        let index = index_container(
            "analytics",
            "events",
            IndexRow {
                name: "legacy_index".to_string(),
                type_name: String::new(),
                expression: String::new(),
                granularity: None,
            },
        );
        assert!(index.properties.is_empty());
    }

    #[test]
    fn optional_object_queries_only_use_catalog_columns_or_fixed_fallbacks() {
        let dictionaries = build_dictionaries_sql(&catalog_columns(&["database", "name"]))
            .expect("dictionary properties should be optional");
        assert!(dictionaries.contains("'' AS status"));
        assert!(dictionaries.contains("'' AS origin"));
        assert!(dictionaries.contains("'' AS type_name"));

        let indexes = build_indexes_sql(&catalog_columns(&["database", "table", "name"]))
            .expect("index properties should be optional");
        assert!(indexes.contains("'' AS type_name"));
        assert!(indexes.contains("'' AS expression"));
        assert!(indexes.contains("CAST(NULL, 'Nullable(UInt64)') AS granularity"));

        let projections = build_projections_sql(&catalog_columns(&["database", "table", "name"]))
            .expect("projection definition should be optional");
        assert!(projections.contains("'' AS query"));
    }

    struct FakeMetadataExecutor {
        responses: Mutex<VecDeque<IpcResult<MetadataRows>>>,
        queries: Mutex<Vec<MetadataQuery>>,
    }

    impl FakeMetadataExecutor {
        fn new(responses: Vec<IpcResult<MetadataRows>>) -> Self {
            Self {
                responses: Mutex::new(responses.into()),
                queries: Mutex::new(Vec::new()),
            }
        }

        fn queries(&self) -> Vec<MetadataQuery> {
            self.queries.lock().expect("fake queries").clone()
        }

        fn empty() -> Self {
            Self::new(Vec::new())
        }
    }

    #[async_trait::async_trait]
    impl MetadataExecutor for FakeMetadataExecutor {
        async fn execute(&self, query: MetadataQuery) -> IpcResult<MetadataRows> {
            self.queries.lock().expect("fake queries").push(query);
            self.responses
                .lock()
                .expect("fake responses")
                .pop_front()
                .expect("fake response")
        }
    }

    fn property<'a>(
        container: &'a crate::engine::types::DataContainer,
        key: &str,
    ) -> Option<&'a str> {
        container
            .properties
            .iter()
            .find(|property| property.key == key)
            .map(|property| property.value.as_str())
    }

    #[test]
    fn routes_only_the_approved_phase_two_hierarchy() {
        assert_eq!(route(None).unwrap(), MetadataRequest::Root);
        assert_eq!(
            route(Some(&ContainerRef::database("analytics"))).unwrap(),
            MetadataRequest::Database {
                database: "analytics".to_string(),
            },
        );
        assert_eq!(
            route(Some(&ContainerRef::asset_group(
                AssetGroupType::Functions,
                None,
                None,
                None,
            )))
            .unwrap(),
            MetadataRequest::Functions,
        );
        assert!(route(Some(&ContainerRef::named_object(
            ContainerKind::Dictionary,
            "analytics",
            None,
            "geo",
        )))
        .is_err());
    }

    #[test]
    fn rejects_incomplete_or_unsupported_metadata_addresses() {
        let incomplete = ContainerRef::asset_group(AssetGroupType::Tables, None, None, None);
        let unsupported =
            ContainerRef::connection_named_object(ContainerKind::Function, "arrayMap");

        assert!(route(Some(&incomplete)).is_err());
        assert!(route(Some(&unsupported)).is_err());
    }

    #[test]
    fn routes_database_table_and_table_child_groups() {
        let database_group = ContainerRef::asset_group(
            AssetGroupType::Views,
            Some("analytics".to_string()),
            None,
            None,
        );
        let table = ContainerRef::table(ContainerKind::Table, "analytics", None, "events");
        let table_group = ContainerRef::asset_group(
            AssetGroupType::Projections,
            Some("analytics".to_string()),
            None,
            Some("events".to_string()),
        );

        assert_eq!(
            route(Some(&database_group)).unwrap(),
            MetadataRequest::DatabaseGroup {
                group: AssetGroupType::Views,
                database: "analytics".to_string(),
            },
        );
        assert_eq!(
            route(Some(&table)).unwrap(),
            MetadataRequest::TableLike {
                kind: ContainerKind::Table,
                database: "analytics".to_string(),
                table: "events".to_string(),
            },
        );
        assert_eq!(
            route(Some(&table_group)).unwrap(),
            MetadataRequest::TableGroup {
                group: AssetGroupType::Projections,
                database: "analytics".to_string(),
                table: "events".to_string(),
            },
        );
    }

    #[test]
    fn classifies_engines_without_losing_unknown_tables() {
        assert_eq!(classify_engine("View"), ContainerKind::View);
        assert_eq!(
            classify_engine("MaterializedView"),
            ContainerKind::MaterializedView,
        );
        assert_eq!(classify_engine("Dictionary"), ContainerKind::Dictionary);
        assert_eq!(classify_engine("MergeTree"), ContainerKind::Table);
        assert_eq!(classify_engine("ReplicatedMergeTree"), ContainerKind::Table);
        assert_eq!(classify_engine("Distributed"), ContainerKind::Table);
        assert_eq!(classify_engine("FutureEngine"), ContainerKind::Table);
        assert_eq!(classify_engine("WindowView"), ContainerKind::View);
        assert_eq!(classify_engine("LiveView"), ContainerKind::View);
        assert_eq!(
            view_family(
                "MaterializedView",
                "CREATE MATERIALIZED VIEW mv REFRESH EVERY 1 HOUR AS SELECT 1"
            ),
            Some("refreshable_materialized")
        );
        assert_eq!(
            view_family("WindowView", "CREATE WINDOW VIEW w AS SELECT 1"),
            Some("window")
        );
    }

    #[test]
    fn stable_id_uses_the_complete_address_not_label_or_properties() {
        let address = ContainerRef::table_named_object(
            ContainerKind::Projection,
            "analytics",
            "events",
            "daily",
        );
        assert_eq!(
            stable_id(&address),
            "10:clickhouse::15:kind=projection::18:database=analytics::12:table=events::12:object=daily",
        );
    }

    #[test]
    fn stable_id_distinguishes_asset_group_types() {
        let tables = ContainerRef::asset_group(
            AssetGroupType::Tables,
            Some("analytics".to_string()),
            None,
            None,
        );
        let views = ContainerRef::asset_group(
            AssetGroupType::Views,
            Some("analytics".to_string()),
            None,
            None,
        );

        assert_ne!(stable_id(&tables), stable_id(&views));
    }

    #[test]
    fn stable_id_length_prefix_prevents_separator_collisions() {
        let first =
            ContainerRef::table_named_object(ContainerKind::Projection, "a::b", "events", "daily");
        let second =
            ContainerRef::table_named_object(ContainerKind::Projection, "a", "b::events", "daily");

        assert_ne!(stable_id(&first), stable_id(&second));
    }

    #[tokio::test]
    async fn root_returns_ordinary_databases_and_global_functions_group() {
        let executor = FakeMetadataExecutor::new(vec![Ok(MetadataRows::Databases(vec![
            DatabaseRow {
                name: "system".to_string(),
            },
            DatabaseRow {
                name: "analytics".to_string(),
            },
        ]))]);

        let containers = list_containers_with(&executor, None).await.unwrap();

        assert_eq!(
            containers
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            vec!["analytics", "system", "Functions"],
        );
        assert_eq!(containers[1].container, ContainerRef::database("system"));
        assert_eq!(
            containers[2].container,
            ContainerRef::asset_group(AssetGroupType::Functions, None, None, None),
        );
        assert_eq!(executor.queries(), vec![MetadataQuery::Databases]);
    }

    #[tokio::test]
    async fn functions_are_connection_scoped_leaf_nodes() {
        let executor =
            FakeMetadataExecutor::new(vec![Ok(MetadataRows::Functions(vec![FunctionRow {
                name: "arrayMap".to_string(),
                is_aggregate: Some(0),
                case_insensitive: Some(0),
                alias_to: String::new(),
            }]))]);
        let parent = ContainerRef::asset_group(AssetGroupType::Functions, None, None, None);

        let containers = list_containers_with(&executor, Some(&parent))
            .await
            .unwrap();

        assert_eq!(
            containers[0].container,
            ContainerRef::connection_named_object(ContainerKind::Function, "arrayMap"),
        );
        assert!(containers[0].is_leaf);
        assert_eq!(property(&containers[0], "isAggregate"), Some("false"));
        assert_eq!(property(&containers[0], "caseInsensitive"), Some("false"));
        assert_eq!(property(&containers[0], "aliasTo"), None);
        assert_eq!(executor.queries(), vec![MetadataQuery::Functions]);
    }

    #[tokio::test]
    async fn bounded_metadata_honors_shutdown_and_timeout() {
        let (_shutdown, closed) = watch::channel(true);
        let canceled = bounded_metadata("list databases", Duration::from_secs(1), closed, async {
            Ok::<u8, clickhouse::error::Error>(1)
        })
        .await
        .expect_err("closed runtime should cancel metadata");
        assert_eq!(canceled.code, ErrorCode::OperationCanceled);
        assert_eq!(canceled.runtime_impact, RuntimeErrorImpact::BusinessOnly);

        let (_shutdown, open) = watch::channel(false);
        let timed_out = bounded_metadata("list databases", Duration::from_millis(1), open, async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            Ok::<u8, clickhouse::error::Error>(1)
        })
        .await
        .expect_err("slow metadata should time out");
        assert_eq!(timed_out.code, ErrorCode::NetworkTimeout);
        assert_eq!(timed_out.runtime_impact, RuntimeErrorImpact::Retryable);
    }

    #[tokio::test]
    async fn database_expands_to_four_approved_groups() {
        let parent = ContainerRef::database("analytics");

        let groups = list_containers_with(&FakeMetadataExecutor::empty(), Some(&parent))
            .await
            .unwrap();

        assert_eq!(
            groups
                .iter()
                .map(|item| item.container.group_type.clone().unwrap())
                .collect::<Vec<_>>(),
            vec![
                AssetGroupType::Tables,
                AssetGroupType::Views,
                AssetGroupType::MaterializedViews,
                AssetGroupType::Dictionaries,
            ],
        );
        assert!(groups.iter().all(|group| {
            group.container.database.as_deref() == Some("analytics") && !group.is_leaf
        }));
    }

    #[tokio::test]
    async fn table_query_classifies_engines_and_filters_the_requested_group() {
        let executor = FakeMetadataExecutor::new(vec![Ok(MetadataRows::Tables(vec![
            TableRow {
                name: "events".to_string(),
                engine: "MergeTree".to_string(),
                create_table_query:
                    "CREATE TABLE events (value UInt64) ENGINE = MergeTree ORDER BY tuple()"
                        .to_string(),
                total_rows: Some(42),
                total_bytes: Some(512),
                comment: "event facts".to_string(),
            },
            TableRow {
                name: "events_view".to_string(),
                engine: "View".to_string(),
                create_table_query: "CREATE VIEW events_view AS SELECT 1".to_string(),
                total_rows: None,
                total_bytes: None,
                comment: String::new(),
            },
            TableRow {
                name: "events_mv".to_string(),
                engine: "MaterializedView".to_string(),
                create_table_query: "CREATE MATERIALIZED VIEW events_mv AS SELECT 1".to_string(),
                total_rows: None,
                total_bytes: None,
                comment: String::new(),
            },
            TableRow {
                name: "future".to_string(),
                engine: "FutureEngine".to_string(),
                create_table_query: String::new(),
                total_rows: None,
                total_bytes: None,
                comment: String::new(),
            },
        ]))]);
        let parent = ContainerRef::asset_group(
            AssetGroupType::Tables,
            Some("analytics".to_string()),
            None,
            None,
        );

        let containers = list_containers_with(&executor, Some(&parent))
            .await
            .unwrap();

        assert_eq!(
            containers
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            vec!["events", "future"],
        );
        assert_eq!(property(&containers[0], "engine"), Some("MergeTree"));
        assert_eq!(property(&containers[0], "totalRows"), Some("42"));
        assert_eq!(property(&containers[1], "engine"), Some("FutureEngine"));
        assert_eq!(
            executor.queries(),
            vec![MetadataQuery::Tables {
                database: "analytics".to_string(),
            }],
        );
    }

    #[tokio::test]
    async fn views_and_materialized_views_use_their_own_groups() {
        let rows = vec![
            TableRow {
                name: "events_view".to_string(),
                engine: "View".to_string(),
                create_table_query: "CREATE VIEW events_view AS SELECT 1".to_string(),
                total_rows: None,
                total_bytes: None,
                comment: String::new(),
            },
            TableRow {
                name: "events_mv".to_string(),
                engine: "MaterializedView".to_string(),
                create_table_query: "CREATE MATERIALIZED VIEW events_mv AS SELECT 1".to_string(),
                total_rows: None,
                total_bytes: None,
                comment: String::new(),
            },
        ];
        let views = FakeMetadataExecutor::new(vec![Ok(MetadataRows::Tables(rows.clone()))]);
        let materialized = FakeMetadataExecutor::new(vec![Ok(MetadataRows::Tables(rows))]);

        let view_nodes = list_containers_with(
            &views,
            Some(&ContainerRef::asset_group(
                AssetGroupType::Views,
                Some("analytics".to_string()),
                None,
                None,
            )),
        )
        .await
        .unwrap();
        let materialized_nodes = list_containers_with(
            &materialized,
            Some(&ContainerRef::asset_group(
                AssetGroupType::MaterializedViews,
                Some("analytics".to_string()),
                None,
                None,
            )),
        )
        .await
        .unwrap();
        assert_eq!(property(&view_nodes[0], "viewFamily"), Some("normal"));
        assert_eq!(
            property(&materialized_nodes[0], "viewFamily"),
            Some("materialized")
        );

        assert_eq!(view_nodes[0].kind, ContainerKind::View);
        assert_eq!(view_nodes[0].name, "events_view");
        assert_eq!(materialized_nodes[0].kind, ContainerKind::MaterializedView);
        assert_eq!(materialized_nodes[0].name, "events_mv");
    }

    #[tokio::test]
    async fn dictionaries_are_leaf_nodes_with_safe_properties() {
        let executor =
            FakeMetadataExecutor::new(vec![Ok(MetadataRows::Dictionaries(vec![DictionaryRow {
                name: "geo".to_string(),
                status: "LOADED".to_string(),
                origin: "https://admin:secret@example.test/config/geo.xml?token=hidden".to_string(),
                type_name: "FLAT".to_string(),
            }]))]);
        let parent = ContainerRef::asset_group(
            AssetGroupType::Dictionaries,
            Some("analytics".to_string()),
            None,
            None,
        );

        let result = list_containers_with(&executor, Some(&parent))
            .await
            .unwrap();

        assert_eq!(result[0].kind, ContainerKind::Dictionary);
        assert!(result[0].is_leaf);
        assert_eq!(property(&result[0], "status"), Some("LOADED"));
        assert_eq!(property(&result[0], "origin"), Some("geo.xml"));
        assert_eq!(property(&result[0], "type"), Some("FLAT"));
        assert!(result[0].properties.iter().all(|property| {
            !property.value.contains("secret")
                && !property.value.contains("token")
                && !property.value.contains("://")
        }));
    }

    fn table_group(database: &str, table: &str, group: AssetGroupType) -> ContainerRef {
        ContainerRef::asset_group(
            group,
            Some(database.to_string()),
            None,
            Some(table.to_string()),
        )
    }

    #[tokio::test]
    async fn table_and_views_expose_only_approved_child_groups() {
        let table = ContainerRef::table(ContainerKind::Table, "analytics", None, "events");
        let view = ContainerRef::table(ContainerKind::View, "analytics", None, "events_view");
        let materialized = ContainerRef::table(
            ContainerKind::MaterializedView,
            "analytics",
            None,
            "events_mv",
        );

        let table_groups = list_containers_with(&FakeMetadataExecutor::empty(), Some(&table))
            .await
            .unwrap();
        let view_groups = list_containers_with(&FakeMetadataExecutor::empty(), Some(&view))
            .await
            .unwrap();
        let materialized_groups =
            list_containers_with(&FakeMetadataExecutor::empty(), Some(&materialized))
                .await
                .unwrap();

        assert_eq!(
            table_groups
                .iter()
                .map(|group| group.container.group_type.clone().unwrap())
                .collect::<Vec<_>>(),
            vec![
                AssetGroupType::Columns,
                AssetGroupType::Indexes,
                AssetGroupType::Projections,
                AssetGroupType::Partitions,
            ],
        );
        assert_eq!(
            view_groups[0].container.group_type,
            Some(AssetGroupType::Columns),
        );
        assert_eq!(view_groups.len(), 1);
        assert_eq!(materialized_groups.len(), 1);
        assert_eq!(
            materialized_groups[0].container.group_type,
            Some(AssetGroupType::Columns),
        );
    }

    #[test]
    fn nullable_parser_only_accepts_column_level_nullable_wrappers() {
        assert!(is_nullable_type("Nullable(String)"));
        assert!(is_nullable_type("LowCardinality(Nullable(String))"));
        assert!(!is_nullable_type("String"));
        assert!(!is_nullable_type("Array(Nullable(String))"));
    }

    #[tokio::test]
    async fn columns_preserve_type_default_codec_and_key_flags() {
        let executor = FakeMetadataExecutor::new(vec![Ok(MetadataRows::Columns(vec![
            ColumnRow {
                name: "event_date".to_string(),
                type_name: "Date".to_string(),
                default_kind: "DEFAULT".to_string(),
                default_expression: "today()".to_string(),
                codec_expression: "CODEC(Delta, ZSTD)".to_string(),
                is_in_sorting_key: Some(1),
                is_in_primary_key: Some(1),
                is_in_partition_key: Some(1),
                is_in_sampling_key: Some(0),
                comment: "event date".to_string(),
            },
            ColumnRow {
                name: "label".to_string(),
                type_name: "LowCardinality(Nullable(String))".to_string(),
                default_kind: String::new(),
                default_expression: String::new(),
                codec_expression: String::new(),
                is_in_sorting_key: Some(0),
                is_in_primary_key: Some(0),
                is_in_partition_key: Some(0),
                is_in_sampling_key: Some(0),
                comment: String::new(),
            },
        ]))]);
        let parent = table_group("analytics", "events", AssetGroupType::Columns);

        let result = list_containers_with(&executor, Some(&parent))
            .await
            .unwrap();

        assert_eq!(result[0].type_name.as_deref(), Some("Date"));
        assert_eq!(result[0].nullable, Some(false));
        assert_eq!(property(&result[0], "defaultKind"), Some("DEFAULT"));
        assert_eq!(property(&result[0], "defaultExpression"), Some("today()"));
        assert_eq!(property(&result[0], "codec"), Some("CODEC(Delta, ZSTD)"));
        assert_eq!(property(&result[0], "isInPartitionKey"), Some("true"));
        assert_eq!(result[1].nullable, Some(true));
        assert_eq!(
            executor.queries(),
            vec![MetadataQuery::Columns {
                database: "analytics".to_string(),
                table: "events".to_string(),
            }],
        );
    }

    #[tokio::test]
    async fn indexes_and_projections_keep_table_scoped_addresses() {
        let indexes = FakeMetadataExecutor::new(vec![Ok(MetadataRows::Indexes(vec![IndexRow {
            name: "value_minmax".to_string(),
            type_name: "minmax".to_string(),
            expression: "value".to_string(),
            granularity: Some(1),
        }]))]);
        let projections =
            FakeMetadataExecutor::new(vec![Ok(MetadataRows::Projections(vec![ProjectionRow {
                name: "daily".to_string(),
                query: "SELECT event_date, sum(value) GROUP BY event_date".to_string(),
            }]))]);

        let index_nodes = list_containers_with(
            &indexes,
            Some(&table_group("analytics", "events", AssetGroupType::Indexes)),
        )
        .await
        .unwrap();
        let projection_nodes = list_containers_with(
            &projections,
            Some(&table_group(
                "analytics",
                "events",
                AssetGroupType::Projections,
            )),
        )
        .await
        .unwrap();

        assert_eq!(
            index_nodes[0].container,
            ContainerRef::table_named_object(
                ContainerKind::Index,
                "analytics",
                "events",
                "value_minmax",
            ),
        );
        assert_eq!(property(&index_nodes[0], "type"), Some("minmax"));
        assert_eq!(property(&index_nodes[0], "expression"), Some("value"));
        assert_eq!(
            projection_nodes[0].container,
            ContainerRef::table_named_object(
                ContainerKind::Projection,
                "analytics",
                "events",
                "daily",
            ),
        );
        assert_eq!(
            property(&projection_nodes[0], "definition"),
            Some("SELECT event_date, sum(value) GROUP BY event_date"),
        );
    }

    #[tokio::test]
    async fn active_parts_are_returned_only_as_aggregated_partition_nodes() {
        let executor = FakeMetadataExecutor::new(vec![Ok(MetadataRows::Partitions(vec![
            PartitionRow {
                partition_id: "202607".to_string(),
                partition_value: "2026-07\n".to_string(),
                rows: 30,
                bytes: 350,
            },
            PartitionRow {
                partition_id: "202608".to_string(),
                partition_value: "2026-08".to_string(),
                rows: 5,
                bytes: 80,
            },
        ]))]);
        let parent = table_group("analytics", "events", AssetGroupType::Partitions);

        let partitions = list_containers_with(&executor, Some(&parent))
            .await
            .unwrap();

        assert_eq!(partitions.len(), 2);
        assert!(partitions
            .iter()
            .all(|container| container.kind == ContainerKind::Partition && container.is_leaf));
        assert_eq!(property(&partitions[0], "partitionId"), Some("202607"));
        assert_eq!(property(&partitions[0], "partitionValue"), Some("2026-07"));
        assert_eq!(property(&partitions[0], "rows"), Some("30"));
        assert_eq!(property(&partitions[0], "bytes"), Some("350"));
        assert!(LIST_PARTITIONS_SQL.contains("active = 1"));
        assert!(LIST_PARTITIONS_SQL.contains("GROUP BY partition_id, partition"));
    }
}
