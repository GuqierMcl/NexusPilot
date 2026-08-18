use oracle_rs::{Row, Value};

use crate::engine::types::{AssetGroupType, ContainerKind, ContainerRef, DataContainer};
use crate::error::{IpcError, IpcResult};

use super::{connect, OracleDriver};

const HIDDEN_SYSTEM_SCHEMAS: &[&str] = &[
    "SYS",
    "SYSTEM",
    "OUTLN",
    "DBSNMP",
    "XDB",
    "MDSYS",
    "ORDSYS",
    "WMSYS",
    "CTXSYS",
    "LBACSYS",
    "GSMADMIN_INTERNAL",
];

pub fn is_hidden_system_schema(schema: &str) -> bool {
    let upper = schema.trim().to_ascii_uppercase();
    HIDDEN_SYSTEM_SCHEMAS.contains(&upper.as_str())
}

pub fn schema_container(database: &str, schema: &str) -> DataContainer {
    DataContainer {
        id: format!("oracle::database::{database}::schema::{schema}"),
        name: schema.to_string(),
        kind: ContainerKind::Schema,
        is_leaf: false,
        container: ContainerRef::schema(database, schema),
        type_name: None,
        nullable: None,
        item_count: None,
        properties: Vec::new(),
    }
}

pub fn schema_containers_from_users<'a>(
    database: &str,
    schemas: impl IntoIterator<Item = &'a str>,
) -> Vec<DataContainer> {
    schemas
        .into_iter()
        .filter(|schema| !is_hidden_system_schema(schema))
        .map(|schema| schema_container(database, schema))
        .collect()
}

pub fn schema_asset_groups(database: &str, schema: &str) -> Vec<DataContainer> {
    [
        (AssetGroupType::Tables, "表"),
        (AssetGroupType::Views, "视图"),
        (AssetGroupType::MaterializedViews, "物化视图"),
        (AssetGroupType::Sequences, "序列"),
        (AssetGroupType::Functions, "函数"),
        (AssetGroupType::Procedures, "存储过程"),
        (AssetGroupType::Indexes, "索引"),
        (AssetGroupType::Triggers, "触发器"),
    ]
    .into_iter()
    .map(|(group_type, name)| DataContainer {
        id: format!("oracle::database::{database}::schema::{schema}::group::{group_type:?}"),
        name: name.to_string(),
        kind: ContainerKind::AssetGroup,
        is_leaf: false,
        container: ContainerRef::asset_group(
            group_type,
            Some(database.to_string()),
            Some(schema.to_string()),
            None,
        ),
        type_name: None,
        nullable: None,
        item_count: None,
        properties: Vec::new(),
    })
    .collect()
}

fn string_bind(value: &str) -> Value {
    Value::String(value.to_string())
}

fn metadata_string(row: &Row, index: usize) -> Option<&str> {
    row.get(index).and_then(Value::as_str)
}

fn object_container(
    database: &str,
    schema: &str,
    name: &str,
    kind: ContainerKind,
    is_leaf: bool,
) -> DataContainer {
    let container = match &kind {
        ContainerKind::Table | ContainerKind::View | ContainerKind::MaterializedView => {
            ContainerRef::table(kind.clone(), database, Some(schema.to_string()), name)
        }
        _ => ContainerRef::named_object(kind.clone(), database, Some(schema.to_string()), name),
    };
    DataContainer {
        id: format!("oracle::database::{database}::schema::{schema}::{kind:?}::{name}"),
        name: name.to_string(),
        kind,
        is_leaf,
        container,
        type_name: None,
        nullable: None,
        item_count: None,
        properties: Vec::new(),
    }
}

fn column_container(
    database: &str,
    schema: &str,
    table: &str,
    name: &str,
    type_name: Option<String>,
    nullable: Option<bool>,
) -> DataContainer {
    DataContainer {
        id: format!(
            "oracle::database::{database}::schema::{schema}::table::{table}::column::{name}"
        ),
        name: name.to_string(),
        kind: ContainerKind::Column,
        is_leaf: true,
        container: ContainerRef::column(database, Some(schema.to_string()), table, name),
        type_name,
        nullable,
        item_count: None,
        properties: Vec::new(),
    }
}

impl OracleDriver {
    pub(crate) async fn list_root_containers(&self) -> IpcResult<Vec<DataContainer>> {
        let database = self.database_label();
        self.list_schemas(&database).await
    }

    pub(crate) async fn list_schemas(&self, database: &str) -> IpcResult<Vec<DataContainer>> {
        let connection = self.connection().await?;
        let result = connection
            .query("SELECT username FROM all_users ORDER BY username", &[])
            .await
            .map_err(connect::classify_oracle_query_error)?;

        Ok(schema_containers_from_users(
            database,
            result.rows.iter().filter_map(|row| metadata_string(row, 0)),
        ))
    }

    pub(crate) async fn list_group_children(
        &self,
        parent: &ContainerRef,
    ) -> IpcResult<Vec<DataContainer>> {
        let database = parent
            .database
            .as_deref()
            .ok_or_else(|| IpcError::resource_not_found("Oracle database context is missing"))?;
        let schema = parent
            .schema
            .as_deref()
            .ok_or_else(|| IpcError::resource_not_found("Oracle schema context is missing"))?;
        let group_type = parent
            .group_type
            .as_ref()
            .ok_or_else(|| IpcError::resource_not_found("Oracle asset group type is missing"))?;

        match group_type {
            AssetGroupType::Tables => {
                self.list_objects(database, schema, "TABLE", ContainerKind::Table)
                    .await
            }
            AssetGroupType::Views => {
                self.list_objects(database, schema, "VIEW", ContainerKind::View)
                    .await
            }
            AssetGroupType::MaterializedViews => {
                self.list_objects(
                    database,
                    schema,
                    "MATERIALIZED VIEW",
                    ContainerKind::MaterializedView,
                )
                .await
            }
            AssetGroupType::Sequences => {
                self.list_named_objects(database, schema, "SEQUENCE", ContainerKind::Sequence)
                    .await
            }
            AssetGroupType::Functions => {
                self.list_named_objects(database, schema, "FUNCTION", ContainerKind::Function)
                    .await
            }
            AssetGroupType::Procedures => {
                self.list_named_objects(database, schema, "PROCEDURE", ContainerKind::Procedure)
                    .await
            }
            AssetGroupType::Indexes => {
                self.list_indexes(database, schema, parent.table.as_deref())
                    .await
            }
            AssetGroupType::Triggers => {
                self.list_triggers(database, schema, parent.table.as_deref())
                    .await
            }
            AssetGroupType::Columns => {
                let table = parent.table.as_deref().ok_or_else(|| {
                    IpcError::resource_not_found("Oracle table context is missing")
                })?;
                self.list_columns(database, schema, table).await
            }
            _ => Ok(Vec::new()),
        }
    }

    pub(crate) fn list_table_child_groups(
        &self,
        parent: &ContainerRef,
    ) -> IpcResult<Vec<DataContainer>> {
        let database = parent
            .database
            .as_deref()
            .ok_or_else(|| IpcError::resource_not_found("Oracle database context is missing"))?;
        let schema = parent
            .schema
            .as_deref()
            .ok_or_else(|| IpcError::resource_not_found("Oracle schema context is missing"))?;
        let table = parent
            .table
            .as_deref()
            .ok_or_else(|| IpcError::resource_not_found("Oracle table context is missing"))?;

        Ok([
            (AssetGroupType::Columns, "列"),
            (AssetGroupType::Indexes, "索引"),
            (AssetGroupType::Triggers, "触发器"),
        ]
        .into_iter()
        .map(|(group_type, name)| DataContainer {
            id: format!(
                "oracle::database::{database}::schema::{schema}::table::{table}::group::{group_type:?}"
            ),
            name: name.to_string(),
            kind: ContainerKind::AssetGroup,
            is_leaf: false,
            container: ContainerRef::asset_group(
                group_type,
                Some(database.to_string()),
                Some(schema.to_string()),
                Some(table.to_string()),
            ),
            type_name: None,
            nullable: None,
            item_count: None,
            properties: Vec::new(),
        })
        .collect())
    }

    pub(crate) async fn list_objects(
        &self,
        database: &str,
        schema: &str,
        object_type: &str,
        kind: ContainerKind,
    ) -> IpcResult<Vec<DataContainer>> {
        let connection = self.connection().await?;
        let result = connection
            .query(
                "SELECT object_name FROM all_objects WHERE owner = :1 AND object_type = :2 ORDER BY object_name",
                &[string_bind(schema), string_bind(object_type)],
            )
            .await
            .map_err(connect::classify_oracle_query_error)?;
        Ok(result
            .rows
            .iter()
            .filter_map(|row| metadata_string(row, 0))
            .map(|name| object_container(database, schema, name, kind.clone(), false))
            .collect())
    }

    pub(crate) async fn list_named_objects(
        &self,
        database: &str,
        schema: &str,
        object_type: &str,
        kind: ContainerKind,
    ) -> IpcResult<Vec<DataContainer>> {
        let connection = self.connection().await?;
        let result = connection
            .query(
                "SELECT object_name FROM all_objects WHERE owner = :1 AND object_type = :2 ORDER BY object_name",
                &[string_bind(schema), string_bind(object_type)],
            )
            .await
            .map_err(connect::classify_oracle_query_error)?;
        Ok(result
            .rows
            .iter()
            .filter_map(|row| metadata_string(row, 0))
            .map(|name| object_container(database, schema, name, kind.clone(), true))
            .collect())
    }

    pub(crate) async fn list_columns(
        &self,
        database: &str,
        schema: &str,
        table: &str,
    ) -> IpcResult<Vec<DataContainer>> {
        let connection = self.connection().await?;
        let result = connection
            .query(
                "SELECT column_name, data_type, nullable FROM all_tab_columns WHERE owner = :1 AND table_name = :2 ORDER BY column_id",
                &[string_bind(schema), string_bind(table)],
            )
            .await
            .map_err(connect::classify_oracle_query_error)?;
        Ok(result
            .rows
            .iter()
            .filter_map(|row| {
                let name = metadata_string(row, 0)?;
                let type_name = metadata_string(row, 1).map(str::to_string);
                let nullable = metadata_string(row, 2).map(|value| value.eq_ignore_ascii_case("Y"));
                Some(column_container(
                    database, schema, table, name, type_name, nullable,
                ))
            })
            .collect())
    }

    pub(crate) async fn list_indexes(
        &self,
        database: &str,
        schema: &str,
        table: Option<&str>,
    ) -> IpcResult<Vec<DataContainer>> {
        let (sql, binds) = if let Some(table) = table {
            (
                "SELECT index_name FROM all_indexes WHERE owner = :1 AND table_name = :2 ORDER BY index_name",
                vec![string_bind(schema), string_bind(table)],
            )
        } else {
            (
                "SELECT index_name FROM all_indexes WHERE owner = :1 ORDER BY index_name",
                vec![string_bind(schema)],
            )
        };
        let connection = self.connection().await?;
        let result = connection
            .query(sql, &binds)
            .await
            .map_err(connect::classify_oracle_query_error)?;
        Ok(result
            .rows
            .iter()
            .filter_map(|row| metadata_string(row, 0))
            .map(|name| object_container(database, schema, name, ContainerKind::Index, true))
            .collect())
    }

    pub(crate) async fn list_triggers(
        &self,
        database: &str,
        schema: &str,
        table: Option<&str>,
    ) -> IpcResult<Vec<DataContainer>> {
        let (sql, binds) = if let Some(table) = table {
            (
                "SELECT trigger_name FROM all_triggers WHERE owner = :1 AND table_name = :2 ORDER BY trigger_name",
                vec![string_bind(schema), string_bind(table)],
            )
        } else {
            (
                "SELECT trigger_name FROM all_triggers WHERE owner = :1 ORDER BY trigger_name",
                vec![string_bind(schema)],
            )
        };
        let connection = self.connection().await?;
        let result = connection
            .query(sql, &binds)
            .await
            .map_err(connect::classify_oracle_query_error)?;
        Ok(result
            .rows
            .iter()
            .filter_map(|row| metadata_string(row, 0))
            .map(|name| object_container(database, schema, name, ContainerKind::Trigger, true))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::types::{AssetGroupType, ContainerKind};

    #[test]
    fn schema_container_preserves_oracle_service_context() {
        let container = schema_container("FREEPDB1", "APP");

        assert_eq!(container.kind, ContainerKind::Schema);
        assert_eq!(container.name, "APP");
        assert_eq!(container.container.database.as_deref(), Some("FREEPDB1"));
        assert_eq!(container.container.schema.as_deref(), Some("APP"));
        assert!(!container.is_leaf);
    }

    #[test]
    fn oracle_root_user_mapping_returns_schema_containers() {
        let containers = schema_containers_from_users("FREEPDB1", ["APP", "SYS"]);

        assert_eq!(containers.len(), 1);
        assert_eq!(containers[0].kind, ContainerKind::Schema);
        assert_eq!(containers[0].name, "APP");
        assert_eq!(
            containers[0].container.database.as_deref(),
            Some("FREEPDB1")
        );
        assert_eq!(containers[0].container.schema.as_deref(), Some("APP"));
        assert!(!containers[0]
            .id
            .contains("::database::FREEPDB1::database::"));
    }

    #[test]
    fn schema_groups_include_phase_one_oracle_assets() {
        let groups = schema_asset_groups("APP", "APP");
        let group_types = groups
            .iter()
            .map(|container| container.container.group_type.clone())
            .collect::<Vec<_>>();

        assert!(group_types.contains(&Some(AssetGroupType::Tables)));
        assert!(group_types.contains(&Some(AssetGroupType::Views)));
        assert!(group_types.contains(&Some(AssetGroupType::MaterializedViews)));
        assert!(group_types.contains(&Some(AssetGroupType::Sequences)));
        assert!(group_types.contains(&Some(AssetGroupType::Functions)));
        assert!(group_types.contains(&Some(AssetGroupType::Procedures)));
        assert!(group_types.contains(&Some(AssetGroupType::Indexes)));
        assert!(group_types.contains(&Some(AssetGroupType::Triggers)));
    }

    #[test]
    fn hides_known_system_schemas() {
        assert!(is_hidden_system_schema("SYS"));
        assert!(is_hidden_system_schema("SYSTEM"));
        assert!(is_hidden_system_schema("XDB"));
        assert!(!is_hidden_system_schema("APP"));
    }

    #[test]
    fn metadata_string_reads_unnamed_oracle_rows_by_position() {
        let row = oracle_rs::Row::new(vec![Value::String("APP".to_string())]);

        assert!(row.get_by_name("USERNAME").is_none());
        assert_eq!(metadata_string(&row, 0), Some("APP"));
    }

    #[test]
    fn quotes_oracle_identifiers() {
        assert_eq!(super::super::quote_oracle_identifier("APP"), "\"APP\"");
        assert_eq!(super::super::quote_oracle_identifier("A\"B"), "\"A\"\"B\"");
    }
}
