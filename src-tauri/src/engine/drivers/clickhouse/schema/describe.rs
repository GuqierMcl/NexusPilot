use std::{collections::BTreeSet, future::Future, time::Duration};

use async_trait::async_trait;
use clickhouse::Client;
use serde::Deserialize;
use tokio::sync::watch;

use crate::{
    engine::types::{ContainerKind, ContainerRef},
    error::{IpcError, IpcResult},
};

use super::{
    canonical::refresh_revision,
    change_types::{ClickHouseProjectionTarget, ClickHouseSkippingIndexTarget},
    parser::{parse_engine, parse_table_clauses, ParsedTableClauses},
    projection_validate::validate_projection_definition,
    skipping_index_validate::validate_skipping_index_definition,
    types::{
        ClickHouseColumnDefaultKind, ClickHouseColumnSchema, ClickHouseEngineSchema,
        ClickHouseKeySchema, ClickHouseProjectionSchema, ClickHouseSchemaBaseline,
        ClickHouseSchemaBlocker, ClickHouseSchemaEditability, ClickHouseSchemaEditabilityMode,
        ClickHouseSettingSchema, ClickHouseSkippingIndexSchema, ClickHouseTableIdentity,
        ClickHouseTableSchema,
    },
};
use crate::engine::drivers::clickhouse::{
    catalog::{
        optional_nullable_column, optional_system_table_is_absent, optional_text_column,
        require_catalog_columns, SystemCatalogColumnProbe,
    },
    ClickHouseDriver,
};

const SUPPORTED_ENGINE_FAMILIES: &[&str] = &[
    "MergeTree",
    "ReplacingMergeTree",
    "SummingMergeTree",
    "AggregatingMergeTree",
    "CollapsingMergeTree",
    "VersionedCollapsingMergeTree",
];

const LIST_SYSTEM_COLUMNS_SQL: &str = r#"
    SELECT name
    FROM system.columns
    WHERE database = 'system' AND table = ?
    ORDER BY name
"#;

#[derive(Debug, Clone, clickhouse::Row, Deserialize, PartialEq, Eq)]
struct SystemColumnRow {
    name: String,
}

struct ClientSchemaCatalog<'a> {
    client: &'a Client,
    timeout: Duration,
    shutdown: watch::Receiver<bool>,
}

impl<'a> ClientSchemaCatalog<'a> {
    fn new(driver: &'a ClickHouseDriver) -> Self {
        Self {
            client: &driver.client,
            timeout: driver.timeout,
            shutdown: driver.shutdown.subscribe(),
        }
    }
}

pub(crate) async fn describe_table(
    driver: &ClickHouseDriver,
    container: &ContainerRef,
) -> IpcResult<ClickHouseTableSchema> {
    describe_table_with(&ClientSchemaCatalog::new(driver), container).await
}

#[derive(Debug, Clone, clickhouse::Row, Deserialize, PartialEq, Eq)]
pub(super) struct TableSchemaRow {
    pub database: String,
    pub name: String,
    pub engine: String,
    pub uuid: Option<String>,
    pub create_table_query: Option<String>,
    pub comment: Option<String>,
    pub sorting_key: Option<String>,
    pub primary_key: Option<String>,
    pub partition_key: Option<String>,
    pub sampling_key: Option<String>,
}

#[derive(Debug, Clone, clickhouse::Row, Deserialize, PartialEq, Eq)]
pub(super) struct ColumnSchemaRow {
    pub database: String,
    pub table: String,
    pub name: String,
    pub type_name: String,
    pub position: u64,
    pub default_kind: Option<String>,
    pub default_expression: Option<String>,
    pub codec_expression: Option<String>,
    pub ttl_expression: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, clickhouse::Row, Deserialize, PartialEq, Eq)]
pub(super) struct ProjectionSchemaRow {
    pub name: String,
    pub query: String,
}

#[derive(Debug, Clone, clickhouse::Row, Deserialize, PartialEq, Eq)]
pub(super) struct SkippingIndexSchemaRow {
    pub name: String,
    pub type_name: String,
    pub expression: String,
    pub granularity: Option<u64>,
}

#[async_trait]
pub(super) trait ClickHouseSchemaCatalog: Send + Sync {
    async fn table(&self, database: &str, table: &str) -> IpcResult<TableSchemaRow>;
    async fn columns(&self, database: &str, table: &str) -> IpcResult<Vec<ColumnSchemaRow>>;
    async fn projections(&self, database: &str, table: &str)
        -> IpcResult<Vec<ProjectionSchemaRow>>;
    async fn skipping_indexes(
        &self,
        database: &str,
        table: &str,
    ) -> IpcResult<Vec<SkippingIndexSchemaRow>>;
}

#[async_trait]
impl SystemCatalogColumnProbe for ClientSchemaCatalog<'_> {
    async fn available_system_columns(
        &self,
        system_table: &'static str,
    ) -> IpcResult<BTreeSet<String>> {
        let rows = bounded_schema_request(
            "inspect schema catalog columns",
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

#[async_trait]
impl ClickHouseSchemaCatalog for ClientSchemaCatalog<'_> {
    async fn table(&self, database: &str, table: &str) -> IpcResult<TableSchemaRow> {
        let available = self.available_system_columns("tables").await?;
        let sql = build_table_schema_sql(&available)?;
        let row = bounded_schema_request(
            "describe table identity",
            self.timeout,
            self.shutdown.clone(),
            self.client
                .query(&sql)
                .bind(database)
                .bind(table)
                .fetch_optional::<TableSchemaRow>(),
        )
        .await?;
        row.ok_or_else(|| {
            IpcError::resource_not_found(format!(
                "ClickHouse table '{database}.{table}' was not found"
            ))
        })
    }

    async fn columns(&self, database: &str, table: &str) -> IpcResult<Vec<ColumnSchemaRow>> {
        let available = self.available_system_columns("columns").await?;
        let sql = build_column_schema_sql(&available)?;
        bounded_schema_request(
            "describe table columns",
            self.timeout,
            self.shutdown.clone(),
            self.client
                .query(&sql)
                .bind(database)
                .bind(table)
                .fetch_all::<ColumnSchemaRow>(),
        )
        .await
    }

    async fn projections(
        &self,
        database: &str,
        table: &str,
    ) -> IpcResult<Vec<ProjectionSchemaRow>> {
        let available = self.available_system_columns("projections").await?;
        if optional_system_table_is_absent("projections", &available) {
            return Ok(Vec::new());
        }
        let sql = build_projection_schema_sql(&available)?;
        bounded_schema_request(
            "describe table projections",
            self.timeout,
            self.shutdown.clone(),
            self.client
                .query(&sql)
                .bind(database)
                .bind(table)
                .fetch_all::<ProjectionSchemaRow>(),
        )
        .await
    }

    async fn skipping_indexes(
        &self,
        database: &str,
        table: &str,
    ) -> IpcResult<Vec<SkippingIndexSchemaRow>> {
        let available = self
            .available_system_columns("data_skipping_indices")
            .await?;
        if optional_system_table_is_absent("data_skipping_indices", &available) {
            return Ok(Vec::new());
        }
        let sql = build_skipping_index_schema_sql(&available)?;
        bounded_schema_request(
            "describe table skipping indexes",
            self.timeout,
            self.shutdown.clone(),
            self.client
                .query(&sql)
                .bind(database)
                .bind(table)
                .fetch_all::<SkippingIndexSchemaRow>(),
        )
        .await
    }
}

fn build_table_schema_sql(available: &BTreeSet<String>) -> IpcResult<String> {
    require_catalog_columns(available, "tables", &["database", "name", "engine"])?;
    Ok(format!(
        "SELECT database, name, engine, {}, {}, {}, {}, {}, {}, {} \
         FROM system.tables WHERE database = ? AND name = ? LIMIT 1",
        optional_nullable_column(available, "uuid", "String", "uuid"),
        optional_nullable_column(
            available,
            "create_table_query",
            "String",
            "create_table_query",
        ),
        optional_nullable_column(available, "comment", "String", "comment"),
        optional_nullable_column(available, "sorting_key", "String", "sorting_key"),
        optional_nullable_column(available, "primary_key", "String", "primary_key"),
        optional_nullable_column(available, "partition_key", "String", "partition_key"),
        optional_nullable_column(available, "sampling_key", "String", "sampling_key"),
    ))
}

fn build_column_schema_sql(available: &BTreeSet<String>) -> IpcResult<String> {
    require_catalog_columns(
        available,
        "columns",
        &["database", "table", "name", "type", "position"],
    )?;
    Ok(format!(
        "SELECT database, table, name, type AS type_name, position, {}, {}, {}, {}, {} \
         FROM system.columns WHERE database = ? AND table = ? ORDER BY position",
        optional_nullable_column(available, "default_kind", "String", "default_kind"),
        optional_nullable_column(
            available,
            "default_expression",
            "String",
            "default_expression",
        ),
        optional_nullable_column(available, "compression_codec", "String", "codec_expression",),
        optional_nullable_column(available, "ttl_expression", "String", "ttl_expression",),
        optional_nullable_column(available, "comment", "String", "comment"),
    ))
}

fn build_projection_schema_sql(available: &BTreeSet<String>) -> IpcResult<String> {
    require_catalog_columns(available, "projections", &["database", "table", "name"])?;
    Ok(format!(
        "SELECT name, {} FROM system.projections \
         WHERE database = ? AND table = ? ORDER BY name",
        optional_text_column(available, "query", "query"),
    ))
}

fn build_skipping_index_schema_sql(available: &BTreeSet<String>) -> IpcResult<String> {
    require_catalog_columns(
        available,
        "data_skipping_indices",
        &["database", "table", "name"],
    )?;
    let type_name = if available.contains("type_full") {
        optional_text_column(available, "type_full", "type_name")
    } else {
        optional_text_column(available, "type", "type_name")
    };
    Ok(format!(
        "SELECT name, {}, {}, {} FROM system.data_skipping_indices \
         WHERE database = ? AND table = ? ORDER BY name",
        type_name,
        optional_text_column(available, "expr", "expression"),
        optional_nullable_column(available, "granularity", "UInt64", "granularity"),
    ))
}

async fn bounded_schema_request<T, F>(
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
            "ClickHouse schema request canceled",
            "The runtime is closing",
        ));
    }
    tokio::select! {
        biased;
        _ = shutdown.changed() => Err(IpcError::operation_canceled(
            "ClickHouse schema request canceled",
            "The runtime closed while schema Describe was in flight",
        )),
        result = tokio::time::timeout(timeout, request) => match result {
            Ok(result) => result.map_err(|error| {
                super::super::error::classify_metadata_error(error, operation)
            }),
            Err(_) => Err(IpcError::network_timeout(
                format!("ClickHouse {operation} timed out"),
                format!("Schema request exceeded {} ms", timeout.as_millis()),
            )),
        },
    }
}

pub(super) async fn describe_table_with(
    catalog: &(impl ClickHouseSchemaCatalog + ?Sized),
    container: &ContainerRef,
) -> IpcResult<ClickHouseTableSchema> {
    let (database, table_name) = validate_table_container(container)?;
    let table = catalog.table(&database, &table_name).await?;
    validate_table_row(&table, &database, &table_name)?;

    let mut column_rows = catalog.columns(&database, &table_name).await?;
    validate_and_sort_columns(&mut column_rows, &database, &table_name)?;
    let projection_rows = catalog.projections(&database, &table_name).await?;
    let skipping_index_rows = catalog.skipping_indexes(&database, &table_name).await?;

    let create_query = table
        .create_table_query
        .as_deref()
        .map(str::trim)
        .filter(|query| !query.is_empty())
        .map(str::to_string);
    let parsed = create_query.as_deref().map(parse_table_clauses).transpose();

    let mut blockers = Vec::new();
    let parsed = match parsed {
        Ok(parsed) => parsed,
        Err(error) => {
            blockers.push(blocker(
                "unparseable_create_query",
                "createTable",
                format!(
                    "ClickHouse canonical CREATE could not be parsed without loss: {}",
                    error.message
                ),
            ));
            None
        }
    };

    if create_query.is_none() {
        blockers.push(blocker(
            "missing_create_query",
            "createTable",
            "ClickHouse did not expose a canonical CREATE TABLE query",
        ));
    }

    let (engine, keys, table_ttl, settings, comment) =
        merge_parsed_table_facts(&table, parsed.as_ref(), &mut blockers);
    if let Some(parsed) = parsed.as_ref() {
        blockers.extend(parsed.blockers.clone());
        check_catalog_create_conflicts(&table, &column_rows, parsed, &mut blockers);
    }

    if !SUPPORTED_ENGINE_FAMILIES.contains(&engine.family.as_str()) {
        blockers.push(blocker(
            "unsupported_engine",
            "engine",
            format!(
                "当前设计器无法安全编辑 ClickHouse 表引擎 '{}'，该表将保持只读",
                engine.family
            ),
        ));
    }

    let columns = map_columns(column_rows, parsed.as_ref(), &mut blockers);
    let projections = map_projections(projection_rows, &mut blockers)?;
    let skipping_indexes = map_skipping_indexes(skipping_index_rows, &mut blockers)?;

    let mut schema = ClickHouseTableSchema {
        identity: ClickHouseTableIdentity {
            database,
            name: table_name,
            object_kind: ContainerKind::Table,
            uuid: normalized_optional(&table.uuid),
        },
        engine,
        columns,
        keys,
        table_ttl,
        comment,
        settings,
        projections,
        skipping_indexes,
        editability: editability(blockers),
        baseline: ClickHouseSchemaBaseline {
            canonical_create_query: create_query.unwrap_or_default(),
            revision_hash: String::new(),
        },
    };
    refresh_revision(&mut schema)?;
    Ok(schema)
}

fn validate_table_container(container: &ContainerRef) -> IpcResult<(String, String)> {
    if container.kind != ContainerKind::Table {
        return Err(IpcError::validation_failed(
            "ClickHouse schema Describe requires a table container",
        ));
    }
    if container.schema.is_some() {
        return Err(IpcError::validation_failed(
            "ClickHouse table containers must not include a schema context",
        ));
    }
    let database = required_address(&container.database, "database")?;
    let table = required_address(&container.table, "table")?;
    Ok((database, table))
}

fn required_address(value: &Option<String>, field: &str) -> IpcResult<String> {
    value
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .ok_or_else(|| {
            IpcError::validation_failed(format!(
                "ClickHouse schema Describe requires a non-empty {field}"
            ))
        })
}

fn validate_table_row(row: &TableSchemaRow, database: &str, table: &str) -> IpcResult<()> {
    for (field, value) in [
        ("database", row.database.as_str()),
        ("name", row.name.as_str()),
        ("engine", row.engine.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(invalid_catalog_fact("system.tables", field));
        }
    }
    if row.database != database || row.name != table {
        return Err(IpcError::system_internal(
            "ClickHouse schema catalog returned a mismatched table identity",
            format!(
                "requested={database}.{table}; returned={}.{}",
                row.database, row.name
            ),
        ));
    }
    Ok(())
}

fn validate_and_sort_columns(
    rows: &mut [ColumnSchemaRow],
    database: &str,
    table: &str,
) -> IpcResult<()> {
    let mut names = BTreeSet::new();
    let mut positions = BTreeSet::new();
    for row in rows.iter() {
        for (field, value) in [
            ("database", row.database.as_str()),
            ("table", row.table.as_str()),
            ("name", row.name.as_str()),
            ("type", row.type_name.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(invalid_catalog_fact("system.columns", field));
            }
        }
        if row.position == 0 {
            return Err(invalid_catalog_fact("system.columns", "position"));
        }
        if row.database != database || row.table != table {
            return Err(IpcError::system_internal(
                "ClickHouse schema catalog returned a mismatched column identity",
                format!(
                    "requested={database}.{table}; returned={}.{}",
                    row.database, row.table
                ),
            ));
        }
        if !names.insert(row.name.clone()) || !positions.insert(row.position) {
            return Err(IpcError::system_internal(
                "ClickHouse schema catalog returned duplicate column identity facts",
                format!("column={}; position={}", row.name, row.position),
            ));
        }
    }
    rows.sort_by_key(|row| row.position);
    Ok(())
}

fn invalid_catalog_fact(system_table: &str, field: &str) -> IpcError {
    IpcError::system_internal(
        "ClickHouse schema catalog omitted a required fact",
        format!("system.{system_table}.{field} is empty or unavailable"),
    )
}

fn merge_parsed_table_facts(
    table: &TableSchemaRow,
    parsed: Option<&ParsedTableClauses>,
    blockers: &mut Vec<ClickHouseSchemaBlocker>,
) -> (
    ClickHouseEngineSchema,
    ClickHouseKeySchema,
    Option<String>,
    Vec<ClickHouseSettingSchema>,
    Option<String>,
) {
    if let Some(parsed) = parsed {
        return (
            parsed.engine.clone(),
            parsed.keys.clone(),
            parsed.table_ttl.clone(),
            parsed.settings.clone(),
            parsed.comment.clone(),
        );
    }

    blockers.push(blocker(
        "catalog_only_schema",
        "createTable",
        "Schema is shown from catalog facts only and cannot be written back",
    ));
    (
        ClickHouseEngineSchema {
            family: table.engine.trim().to_string(),
            arguments: Vec::new(),
            raw_expression: table.engine.trim().to_string(),
        },
        ClickHouseKeySchema {
            order_by: normalized_optional(&table.sorting_key).unwrap_or_default(),
            partition_by: normalized_optional(&table.partition_key),
            primary_key: normalized_optional(&table.primary_key),
            sample_by: normalized_optional(&table.sampling_key),
        },
        None,
        Vec::new(),
        normalized_optional(&table.comment),
    )
}

fn check_catalog_create_conflicts(
    table: &TableSchemaRow,
    columns: &[ColumnSchemaRow],
    parsed: &ParsedTableClauses,
    blockers: &mut Vec<ClickHouseSchemaBlocker>,
) {
    if table.engine.trim() != parsed.engine.family {
        push_conflict(
            blockers,
            "engine",
            format!(
                "Catalog engine '{}' differs from canonical CREATE engine '{}'",
                table.engine, parsed.engine.family
            ),
        );
    }
    let catalog_columns = columns
        .iter()
        .map(|column| column.name.as_str())
        .collect::<Vec<_>>();
    let parsed_columns = parsed
        .column_names
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    if catalog_columns != parsed_columns {
        push_conflict(
            blockers,
            "columns",
            "Catalog column order differs from canonical CREATE column order",
        );
    }

    compare_optional_catalog_fact(
        blockers,
        "comment",
        &table.comment,
        parsed.comment.as_deref().and_then(optional_trimmed),
    );
}

fn compare_optional_catalog_fact(
    blockers: &mut Vec<ClickHouseSchemaBlocker>,
    path: &str,
    catalog: &Option<String>,
    parsed: Option<&str>,
) {
    let Some(catalog) = catalog.as_deref() else {
        return;
    };
    if optional_trimmed(catalog) != parsed {
        push_conflict(
            blockers,
            path,
            format!("Catalog and canonical CREATE disagree at {path}"),
        );
    }
}

fn push_conflict(
    blockers: &mut Vec<ClickHouseSchemaBlocker>,
    path: &str,
    message: impl Into<String>,
) {
    blockers.push(blocker("catalog_create_conflict", path, message));
}

fn map_columns(
    rows: Vec<ColumnSchemaRow>,
    parsed: Option<&ParsedTableClauses>,
    blockers: &mut Vec<ClickHouseSchemaBlocker>,
) -> Vec<ClickHouseColumnSchema> {
    rows.into_iter()
        .map(|row| {
            let path = format!("columns.{}.defaultKind", row.name);
            let mut column_blockers = parsed
                .and_then(|parsed| parsed.column_blockers.get(&row.name))
                .cloned()
                .unwrap_or_default();
            for (value, field) in [
                (&row.default_expression, "defaultExpression"),
                (&row.codec_expression, "codecExpression"),
                (&row.comment, "comment"),
            ] {
                if value.is_none() {
                    column_blockers.push(blocker(
                        "missing_column_catalog_fact",
                        format!("columns.{}.{}", row.name, field),
                        format!(
                            "ClickHouse catalog does not expose column '{}' field '{}'",
                            row.name, field
                        ),
                    ));
                }
            }

            let parsed_ttl = parsed
                .and_then(|parsed| parsed.column_ttl_expressions.get(&row.name));
            let ttl_expression = match row.ttl_expression.as_deref() {
                Some(catalog_ttl) => {
                    let catalog_ttl = optional_trimmed(catalog_ttl).map(str::to_string);
                    if let Some(parsed_ttl) = parsed_ttl {
                        if catalog_ttl.as_deref() != parsed_ttl.as_deref() {
                            column_blockers.push(blocker(
                                "catalog_create_conflict",
                                format!("columns.{}.ttlExpression", row.name),
                                format!(
                                    "Catalog and canonical CREATE disagree on column '{}' TTL",
                                    row.name
                                ),
                            ));
                        }
                    }
                    catalog_ttl
                }
                None => match parsed_ttl {
                    Some(parsed_ttl) => parsed_ttl.clone(),
                    None => {
                        column_blockers.push(blocker(
                            "missing_column_catalog_fact",
                            format!("columns.{}.ttlExpression", row.name),
                            format!(
                                "ClickHouse catalog and canonical CREATE do not expose column '{}' TTL",
                                row.name
                            ),
                        ));
                        None
                    }
                },
            };

            let default_kind = match row.default_kind.as_deref() {
                None => {
                    column_blockers.push(blocker(
                        "missing_column_catalog_fact",
                        &path,
                        format!(
                            "ClickHouse catalog does not expose column '{}' default kind",
                            row.name
                        ),
                    ));
                    ClickHouseColumnDefaultKind::None
                }
                Some(raw) => match raw.trim().to_ascii_uppercase().as_str() {
                    "" => ClickHouseColumnDefaultKind::None,
                    "DEFAULT" => ClickHouseColumnDefaultKind::Default,
                    "MATERIALIZED" => ClickHouseColumnDefaultKind::Materialized,
                    "ALIAS" => ClickHouseColumnDefaultKind::Alias,
                    "EPHEMERAL" => ClickHouseColumnDefaultKind::Ephemeral,
                    unsupported => {
                        column_blockers.push(blocker(
                            "unsupported_default_kind",
                            &path,
                            format!(
                                "ClickHouse column '{}' uses unsupported default kind '{}'",
                                row.name, unsupported
                            ),
                        ));
                        ClickHouseColumnDefaultKind::None
                    }
                },
            };
            blockers.extend(column_blockers.clone());
            ClickHouseColumnSchema {
                name: row.name,
                type_name: row.type_name,
                position: row.position,
                default_kind,
                default_expression: normalized_optional(&row.default_expression),
                codec_expression: normalized_optional(&row.codec_expression),
                ttl_expression,
                comment: normalized_optional(&row.comment),
                editability: editability(column_blockers),
            }
        })
        .collect()
}

fn map_projections(
    mut rows: Vec<ProjectionSchemaRow>,
    blockers: &mut Vec<ClickHouseSchemaBlocker>,
) -> IpcResult<Vec<ClickHouseProjectionSchema>> {
    rows.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then(left.query.cmp(&right.query))
    });
    let mut names = BTreeSet::new();
    rows.into_iter()
        .map(|row| {
            if row.name.trim().is_empty() || !names.insert(row.name.clone()) {
                return Err(invalid_catalog_fact("system.projections", "name"));
            }
            let projection = ClickHouseProjectionTarget {
                name: row.name.clone(),
                query: row.query.clone(),
            };
            let object_blockers = if row.query.trim().is_empty() {
                vec![blocker(
                    "incomplete_projection_definition",
                    format!("projections.{}", row.name),
                    format!("ClickHouse projection '{}' has no visible query", row.name),
                )]
            } else if let Err(error) = validate_projection_definition(&projection) {
                vec![blocker(
                    "unsupported_projection_query",
                    format!("projections.{}", row.name),
                    error.message,
                )]
            } else {
                Vec::new()
            };
            blockers.extend(object_blockers.clone());
            Ok(ClickHouseProjectionSchema {
                name: row.name,
                query: row.query,
                editability: editability(object_blockers),
            })
        })
        .collect()
}

fn map_skipping_indexes(
    mut rows: Vec<SkippingIndexSchemaRow>,
    blockers: &mut Vec<ClickHouseSchemaBlocker>,
) -> IpcResult<Vec<ClickHouseSkippingIndexSchema>> {
    rows.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then(left.expression.cmp(&right.expression))
            .then(left.type_name.cmp(&right.type_name))
    });
    let mut names = BTreeSet::new();
    rows.into_iter()
        .map(|row| {
            if row.name.trim().is_empty() || !names.insert(row.name.clone()) {
                return Err(invalid_catalog_fact("system.data_skipping_indices", "name"));
            }
            let mut object_blockers = Vec::new();
            if row.granularity.is_none() {
                object_blockers.push(blocker(
                    "incomplete_skipping_index_definition",
                    format!("skippingIndexes.{}.granularity", row.name),
                    format!(
                        "ClickHouse skipping index '{}' has no visible granularity",
                        row.name
                    ),
                ));
            }
            let parsed_type = parse_engine(&row.type_name);
            let (index_type, type_arguments) = match parsed_type {
                Ok(parsed) if !row.expression.trim().is_empty() => {
                    (parsed.family, parsed.arguments)
                }
                Ok(parsed) => {
                    object_blockers.push(blocker(
                        "incomplete_skipping_index_definition",
                        format!("skippingIndexes.{}", row.name),
                        format!(
                            "ClickHouse skipping index '{}' has no visible expression",
                            row.name
                        ),
                    ));
                    (parsed.family, parsed.arguments)
                }
                Err(_) => {
                    object_blockers.push(blocker(
                        "unsupported_skipping_index_type",
                        format!("skippingIndexes.{}.indexType", row.name),
                        format!(
                            "ClickHouse skipping index '{}' has unsupported type '{}'",
                            row.name, row.type_name
                        ),
                    ));
                    (row.type_name.clone(), Vec::new())
                }
            };
            let index = ClickHouseSkippingIndexSchema {
                name: row.name,
                expression: row.expression,
                index_type,
                type_arguments,
                granularity: row.granularity,
                editability: ClickHouseSchemaEditability::editable(),
            };
            if object_blockers.is_empty() {
                if let Some(granularity) = index.granularity {
                    let target = ClickHouseSkippingIndexTarget {
                        name: index.name.clone(),
                        expression: index.expression.clone(),
                        index_type: index.index_type.clone(),
                        type_arguments: index.type_arguments.clone(),
                        granularity,
                    };
                    if let Err(error) = validate_skipping_index_definition(&target) {
                        object_blockers.push(blocker(
                            "unsupported_skipping_index_definition",
                            format!("skippingIndexes.{}", index.name),
                            error.message,
                        ));
                    }
                }
            }
            blockers.extend(object_blockers.clone());
            Ok(ClickHouseSkippingIndexSchema {
                editability: editability(object_blockers),
                ..index
            })
        })
        .collect()
}

fn normalized_optional(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .and_then(optional_trimmed)
        .map(str::to_string)
}

fn optional_trimmed(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

fn blocker(
    code: impl Into<String>,
    path: impl Into<String>,
    message: impl Into<String>,
) -> ClickHouseSchemaBlocker {
    ClickHouseSchemaBlocker {
        code: code.into(),
        path: path.into(),
        message: message.into(),
    }
}

fn editability(blockers: Vec<ClickHouseSchemaBlocker>) -> ClickHouseSchemaEditability {
    if blockers.is_empty() {
        ClickHouseSchemaEditability::editable()
    } else {
        ClickHouseSchemaEditability {
            mode: ClickHouseSchemaEditabilityMode::Readonly,
            blockers,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use async_trait::async_trait;

    use super::*;
    use crate::{
        engine::types::{ContainerKind, ContainerRef},
        error::ErrorCode,
    };

    const CREATE_QUERY: &str = r#"CREATE TABLE analytics.events
(
    `id` UInt64 CODEC(Delta, ZSTD(1)) TTL id + INTERVAL 1 DAY,
    `day` Date MATERIALIZED toDate(ts),
    INDEX day_idx day TYPE set(100) GRANULARITY 4,
    PROJECTION by_day (SELECT day, count() GROUP BY day)
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(ts)
PRIMARY KEY id
ORDER BY id
SAMPLE BY id
TTL ts + INTERVAL 90 DAY DELETE
SETTINGS index_granularity = 8192
COMMENT 'events'"#;

    #[derive(Clone)]
    struct FakeSchemaCatalog {
        table: TableSchemaRow,
        columns: Vec<ColumnSchemaRow>,
        projections: Vec<ProjectionSchemaRow>,
        skipping_indexes: Vec<SkippingIndexSchemaRow>,
    }

    #[async_trait]
    impl ClickHouseSchemaCatalog for FakeSchemaCatalog {
        async fn table(&self, _database: &str, _table: &str) -> IpcResult<TableSchemaRow> {
            Ok(self.table.clone())
        }

        async fn columns(&self, _database: &str, _table: &str) -> IpcResult<Vec<ColumnSchemaRow>> {
            Ok(self.columns.clone())
        }

        async fn projections(
            &self,
            _database: &str,
            _table: &str,
        ) -> IpcResult<Vec<ProjectionSchemaRow>> {
            Ok(self.projections.clone())
        }

        async fn skipping_indexes(
            &self,
            _database: &str,
            _table: &str,
        ) -> IpcResult<Vec<SkippingIndexSchemaRow>> {
            Ok(self.skipping_indexes.clone())
        }
    }

    fn fixture_catalog() -> FakeSchemaCatalog {
        FakeSchemaCatalog {
            table: TableSchemaRow {
                database: "analytics".to_string(),
                name: "events".to_string(),
                engine: "ReplacingMergeTree".to_string(),
                uuid: Some("00000000-0000-0000-0000-000000000001".to_string()),
                create_table_query: Some(CREATE_QUERY.to_string()),
                comment: Some("events".to_string()),
                sorting_key: Some("id".to_string()),
                primary_key: Some("id".to_string()),
                partition_key: Some("toYYYYMM(ts)".to_string()),
                sampling_key: Some("id".to_string()),
            },
            columns: vec![
                ColumnSchemaRow {
                    database: "analytics".to_string(),
                    table: "events".to_string(),
                    name: "day".to_string(),
                    type_name: "Date".to_string(),
                    position: 2,
                    default_kind: Some("MATERIALIZED".to_string()),
                    default_expression: Some("toDate(ts)".to_string()),
                    codec_expression: Some(String::new()),
                    ttl_expression: Some(String::new()),
                    comment: Some(String::new()),
                },
                ColumnSchemaRow {
                    database: "analytics".to_string(),
                    table: "events".to_string(),
                    name: "id".to_string(),
                    type_name: "UInt64".to_string(),
                    position: 1,
                    default_kind: Some(String::new()),
                    default_expression: Some(String::new()),
                    codec_expression: Some("CODEC(Delta, ZSTD(1))".to_string()),
                    ttl_expression: Some("id + INTERVAL 1 DAY".to_string()),
                    comment: Some("identifier".to_string()),
                },
            ],
            projections: vec![ProjectionSchemaRow {
                name: "by_day".to_string(),
                query: "SELECT day, count() GROUP BY day".to_string(),
            }],
            skipping_indexes: vec![SkippingIndexSchemaRow {
                name: "day_idx".to_string(),
                type_name: "set(100)".to_string(),
                expression: "day".to_string(),
                granularity: Some(4),
            }],
        }
    }

    fn table_container() -> ContainerRef {
        ContainerRef::table(ContainerKind::Table, "analytics", None, "events")
    }

    #[test]
    fn schema_sql_builders_require_lossless_catalog_fields() {
        let table_columns = BTreeSet::from([
            "database".to_string(),
            "name".to_string(),
            "engine".to_string(),
            "uuid".to_string(),
            "create_table_query".to_string(),
            "comment".to_string(),
            "sorting_key".to_string(),
            "primary_key".to_string(),
            "partition_key".to_string(),
            "sampling_key".to_string(),
        ]);
        let table_sql = build_table_schema_sql(&table_columns).expect("build table schema SQL");
        assert!(table_sql.contains("FROM system.tables"));
        assert!(table_sql.contains("CAST(uuid, 'Nullable(String)') AS uuid"));
        assert!(table_sql.contains("WHERE database = ? AND name = ?"));

        let column_columns = BTreeSet::from([
            "database".to_string(),
            "table".to_string(),
            "name".to_string(),
            "type".to_string(),
            "position".to_string(),
            "default_kind".to_string(),
            "default_expression".to_string(),
            "compression_codec".to_string(),
            "ttl_expression".to_string(),
            "comment".to_string(),
        ]);
        let column_sql = build_column_schema_sql(&column_columns).expect("build column schema SQL");
        assert!(column_sql.contains("type AS type_name"));
        assert!(column_sql.contains("ttl_expression"));
        assert!(column_sql.contains("ORDER BY position"));

        let mut missing_position = column_columns;
        missing_position.remove("position");
        let error = build_column_schema_sql(&missing_position)
            .expect_err("Describe cannot fall back to name ordering");
        assert_eq!(error.code, ErrorCode::SystemInternal);

        let skipping_index_columns = BTreeSet::from([
            "database".to_string(),
            "table".to_string(),
            "name".to_string(),
            "type".to_string(),
            "type_full".to_string(),
            "expr".to_string(),
            "granularity".to_string(),
        ]);
        let skipping_index_sql = build_skipping_index_schema_sql(&skipping_index_columns)
            .expect("build skipping-index schema SQL");
        assert!(skipping_index_sql.contains("type_full AS type_name"));
        assert!(!skipping_index_sql.contains("type AS type_name"));

        let legacy_skipping_index_columns = BTreeSet::from([
            "database".to_string(),
            "table".to_string(),
            "name".to_string(),
            "type".to_string(),
            "expr".to_string(),
            "granularity".to_string(),
        ]);
        let legacy_skipping_index_sql =
            build_skipping_index_schema_sql(&legacy_skipping_index_columns)
                .expect("build legacy skipping-index schema SQL");
        assert!(legacy_skipping_index_sql.contains("type AS type_name"));
    }

    #[tokio::test]
    async fn clickhouse_describe_merges_catalog_and_create_query() {
        let schema = describe_table_with(&fixture_catalog(), &table_container())
            .await
            .expect("describe supported table");

        assert_eq!(
            schema.editability.mode,
            ClickHouseSchemaEditabilityMode::Editable
        );
        assert_eq!(schema.identity.database, "analytics");
        assert_eq!(schema.identity.name, "events");
        assert_eq!(schema.engine.family, "ReplacingMergeTree");
        assert_eq!(schema.engine.arguments, vec!["version"]);
        assert_eq!(schema.columns[0].name, "id");
        assert_eq!(
            schema.columns[0].ttl_expression.as_deref(),
            Some("id + INTERVAL 1 DAY")
        );
        assert_eq!(
            schema.columns[1].default_kind,
            ClickHouseColumnDefaultKind::Materialized
        );
        assert_eq!(schema.settings[0].name, "index_granularity");
        assert_eq!(schema.projections[0].name, "by_day");
        assert_eq!(schema.skipping_indexes[0].index_type, "set");
        assert_eq!(schema.skipping_indexes[0].type_arguments, vec!["100"]);
        assert_eq!(schema.baseline.revision_hash.len(), 64);
    }

    #[tokio::test]
    async fn canonical_create_recovers_unavailable_column_ttl_catalog() {
        let mut catalog = fixture_catalog();
        for column in &mut catalog.columns {
            column.ttl_expression = None;
        }

        let schema = describe_table_with(&catalog, &table_container())
            .await
            .expect("recover column TTL from canonical CREATE");

        assert_eq!(
            schema.editability.mode,
            ClickHouseSchemaEditabilityMode::Editable
        );
        assert_eq!(
            schema.columns[0].ttl_expression.as_deref(),
            Some("id + INTERVAL 1 DAY")
        );
        assert_eq!(schema.columns[1].ttl_expression, None);
        assert!(!schema
            .editability
            .blockers
            .iter()
            .any(|blocker| blocker.code == "missing_column_catalog_fact"));
    }

    #[tokio::test]
    async fn unmodeled_column_clause_is_readonly_and_column_scoped() {
        let mut catalog = fixture_catalog();
        catalog.table.create_table_query =
            Some(CREATE_QUERY.replace("`id` UInt64 CODEC", "`id` UInt64 STATISTICS(minmax) CODEC"));

        let schema = describe_table_with(&catalog, &table_container())
            .await
            .expect("describe unsupported column clause");

        assert_eq!(
            schema.editability.mode,
            ClickHouseSchemaEditabilityMode::Readonly
        );
        assert_eq!(
            schema.columns[0].editability.mode,
            ClickHouseSchemaEditabilityMode::Readonly
        );
        assert!(schema.columns[0]
            .editability
            .blockers
            .iter()
            .any(|blocker| blocker.code == "unsupported_column_clause"));
    }

    #[tokio::test]
    async fn phase_five_a_engine_profile_recognizes_six_mergetree_families() {
        for family in [
            "MergeTree",
            "ReplacingMergeTree",
            "SummingMergeTree",
            "AggregatingMergeTree",
            "CollapsingMergeTree",
            "VersionedCollapsingMergeTree",
        ] {
            let mut catalog = fixture_catalog();
            catalog.table.engine = family.to_string();
            catalog.table.create_table_query =
                Some(CREATE_QUERY.replace("ReplacingMergeTree(version)", &format!("{family}()")));

            let schema = describe_table_with(&catalog, &table_container())
                .await
                .expect("describe supported engine family");
            assert_eq!(
                schema.editability.mode,
                ClickHouseSchemaEditabilityMode::Editable
            );
            assert!(!schema
                .editability
                .blockers
                .iter()
                .any(|blocker| blocker.code == "unsupported_engine"));
        }
    }

    #[tokio::test]
    async fn unknown_engine_and_default_kind_fail_closed_with_visible_blockers() {
        let mut catalog = fixture_catalog();
        catalog.table.engine = "SharedMergeTree".to_string();
        catalog.table.create_table_query =
            Some(CREATE_QUERY.replace("ReplacingMergeTree(version)", "SharedMergeTree()"));
        catalog.columns[0].default_kind = Some("FUTURE_DEFAULT".to_string());

        let schema = describe_table_with(&catalog, &table_container())
            .await
            .expect("unsupported facts remain describable");

        assert_eq!(
            schema.editability.mode,
            ClickHouseSchemaEditabilityMode::Readonly
        );
        assert!(schema
            .editability
            .blockers
            .iter()
            .any(|blocker| blocker.code == "unsupported_engine"));
        assert!(schema.editability.blockers.iter().any(|blocker| {
            blocker.code == "unsupported_default_kind" && blocker.message.contains("FUTURE_DEFAULT")
        }));
        assert_eq!(
            schema.columns[1].editability.mode,
            ClickHouseSchemaEditabilityMode::Readonly
        );
    }

    #[tokio::test]
    async fn absent_optional_catalogs_are_empty_without_false_blockers() {
        let mut catalog = fixture_catalog();
        catalog.projections.clear();
        catalog.skipping_indexes.clear();

        let schema = describe_table_with(&catalog, &table_container())
            .await
            .expect("describe without optional catalogs");

        assert!(schema.projections.is_empty());
        assert!(schema.skipping_indexes.is_empty());
        assert_eq!(
            schema.editability.mode,
            ClickHouseSchemaEditabilityMode::Editable
        );
    }

    #[tokio::test]
    async fn unavailable_noncanonical_column_detail_catalog_fails_closed() {
        let mut catalog = fixture_catalog();
        catalog.columns[0].codec_expression = None;

        let schema = describe_table_with(&catalog, &table_container())
            .await
            .expect("missing optional detail remains describable");

        assert_eq!(
            schema.editability.mode,
            ClickHouseSchemaEditabilityMode::Readonly
        );
        assert!(schema.editability.blockers.iter().any(|blocker| {
            blocker.code == "missing_column_catalog_fact"
                && blocker.path == "columns.day.codecExpression"
        }));
        assert_eq!(
            schema.columns[1].editability.mode,
            ClickHouseSchemaEditabilityMode::Readonly
        );
    }

    #[tokio::test]
    async fn unavailable_skipping_index_granularity_fails_closed() {
        let mut catalog = fixture_catalog();
        catalog.skipping_indexes[0].granularity = None;

        let schema = describe_table_with(&catalog, &table_container())
            .await
            .expect("missing granularity remains describable");

        assert_eq!(
            schema.editability.mode,
            ClickHouseSchemaEditabilityMode::Readonly
        );
        assert!(schema.editability.blockers.iter().any(|blocker| {
            blocker.code == "incomplete_skipping_index_definition"
                && blocker.path == "skippingIndexes.day_idx.granularity"
        }));
    }

    #[tokio::test]
    async fn unsupported_projection_and_index_definitions_are_readonly_and_preserved() {
        let mut catalog = fixture_catalog();
        catalog.projections[0].query = "SELECT id FROM external_table".to_string();
        catalog.skipping_indexes[0].type_name = "future_index(7)".to_string();

        let schema = describe_table_with(&catalog, &table_container())
            .await
            .expect("unsupported objects remain describable");

        assert_eq!(
            schema.editability.mode,
            ClickHouseSchemaEditabilityMode::Readonly
        );
        assert_eq!(schema.projections[0].query, "SELECT id FROM external_table");
        assert_eq!(
            schema.projections[0].editability.mode,
            ClickHouseSchemaEditabilityMode::Readonly
        );
        assert_eq!(schema.skipping_indexes[0].index_type, "future_index");
        assert_eq!(schema.skipping_indexes[0].type_arguments, ["7"]);
        assert_eq!(
            schema.skipping_indexes[0].editability.mode,
            ClickHouseSchemaEditabilityMode::Readonly
        );
    }

    #[test]
    fn container_validation_preserves_non_empty_identifier_bytes() {
        let container = ContainerRef::table(ContainerKind::Table, " analytics ", None, " events ");

        let (database, table) =
            validate_table_container(&container).expect("validate quoted-name payload");

        assert_eq!(database, " analytics ");
        assert_eq!(table, " events ");
    }

    #[tokio::test]
    async fn catalog_rows_require_identity_and_position_facts() {
        let mut missing_table_identity = fixture_catalog();
        missing_table_identity.table.database.clear();
        let error = describe_table_with(&missing_table_identity, &table_container())
            .await
            .expect_err("missing table identity must fail");
        assert_eq!(error.code, ErrorCode::SystemInternal);

        let mut missing_column_identity = fixture_catalog();
        missing_column_identity.columns[0].name.clear();
        let error = describe_table_with(&missing_column_identity, &table_container())
            .await
            .expect_err("missing column identity must fail");
        assert_eq!(error.code, ErrorCode::SystemInternal);

        let mut missing_position = fixture_catalog();
        missing_position.columns[0].position = 0;
        let error = describe_table_with(&missing_position, &table_container())
            .await
            .expect_err("missing column position must fail");
        assert_eq!(error.code, ErrorCode::SystemInternal);
    }

    #[tokio::test]
    async fn unordered_object_rows_produce_the_same_revision() {
        let mut first = fixture_catalog();
        first.projections.push(ProjectionSchemaRow {
            name: "another_projection".to_string(),
            query: "SELECT id".to_string(),
        });
        first.skipping_indexes.push(SkippingIndexSchemaRow {
            name: "another_index".to_string(),
            type_name: "minmax".to_string(),
            expression: "id".to_string(),
            granularity: Some(1),
        });
        let mut reordered = first.clone();
        reordered.projections.reverse();
        reordered.skipping_indexes.reverse();

        let first_schema = describe_table_with(&first, &table_container())
            .await
            .expect("first describe");
        let reordered_schema = describe_table_with(&reordered, &table_container())
            .await
            .expect("reordered describe");

        assert_eq!(
            first_schema.baseline.revision_hash,
            reordered_schema.baseline.revision_hash
        );
    }

    #[tokio::test]
    async fn missing_create_and_catalog_conflicts_are_readonly() {
        let mut missing_create = fixture_catalog();
        missing_create.table.create_table_query = None;
        let schema = describe_table_with(&missing_create, &table_container())
            .await
            .expect("missing create remains describable");
        assert_eq!(
            schema.editability.mode,
            ClickHouseSchemaEditabilityMode::Readonly
        );
        assert!(schema
            .editability
            .blockers
            .iter()
            .any(|blocker| blocker.code == "missing_create_query"));

        let mut conflict = fixture_catalog();
        conflict.table.engine = "MergeTree".to_string();
        let schema = describe_table_with(&conflict, &table_container())
            .await
            .expect("conflict remains describable");
        assert!(schema.editability.blockers.iter().any(|blocker| {
            blocker.code == "catalog_create_conflict" && blocker.path == "engine"
        }));

        let mut column_conflict = fixture_catalog();
        column_conflict.columns[0].name = "other".to_string();
        let schema = describe_table_with(&column_conflict, &table_container())
            .await
            .expect("column conflict remains describable");
        assert!(schema.editability.blockers.iter().any(|blocker| {
            blocker.code == "catalog_create_conflict" && blocker.path == "columns"
        }));
    }

    #[tokio::test]
    async fn describe_validates_clickhouse_table_container_shape() {
        for invalid in [
            ContainerRef::table(ContainerKind::View, "analytics", None, "events"),
            ContainerRef::table(
                ContainerKind::Table,
                "analytics",
                Some("public".to_string()),
                "events",
            ),
            ContainerRef::table(ContainerKind::Table, "", None, "events"),
            ContainerRef::table(ContainerKind::Table, "analytics", None, ""),
        ] {
            let error = describe_table_with(&fixture_catalog(), &invalid)
                .await
                .expect_err("invalid container must fail");
            assert_eq!(error.code, ErrorCode::ValidationFailed);
        }
    }
}
