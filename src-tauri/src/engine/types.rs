use serde::{Deserialize, Serialize};

use crate::error::{ErrorCode, IpcError, RuntimeErrorImpact};

// ─── Runtime capabilities ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SqlStatementAccess {
    ReadOnly,
    Direct,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SqlExecutionFeatures {
    pub managed_lifecycle: bool,
    pub statement_access: SqlStatementAccess,
    pub active_cancel: bool,
    pub live_progress: bool,
    pub query_summary: bool,
    pub raw_result: bool,
    pub configurable_timeout: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SchemaMutationOperation {
    Create,
    Alter,
    Rename,
    Drop,
    Clear,
    Materialize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaMutationObjectFeatures {
    pub kind: ContainerKind,
    pub operations: Vec<SchemaMutationOperation>,
}

impl SchemaMutationObjectFeatures {
    pub fn new(
        kind: ContainerKind,
        operations: impl IntoIterator<Item = SchemaMutationOperation>,
    ) -> Self {
        let mut unique_operations = Vec::new();
        for operation in operations {
            if !unique_operations.contains(&operation) {
                unique_operations.push(operation);
            }
        }
        Self {
            kind,
            operations: unique_operations,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaMutationFeatures {
    pub objects: Vec<SchemaMutationObjectFeatures>,
    pub ddl_preview: bool,
    pub destructive_confirmation: bool,
    pub remote_drift_protection: bool,
}

impl SchemaMutationFeatures {
    pub fn new(
        objects: impl IntoIterator<Item = SchemaMutationObjectFeatures>,
        ddl_preview: bool,
        destructive_confirmation: bool,
        remote_drift_protection: bool,
    ) -> Self {
        let mut unique_objects: Vec<SchemaMutationObjectFeatures> = Vec::new();
        for object in objects {
            if let Some(existing) = unique_objects
                .iter_mut()
                .find(|existing| existing.kind == object.kind)
            {
                for operation in object.operations {
                    if !existing.operations.contains(&operation) {
                        existing.operations.push(operation);
                    }
                }
            } else {
                unique_objects.push(object);
            }
        }
        Self {
            objects: unique_objects,
            ddl_preview,
            destructive_confirmation,
            remote_drift_protection,
        }
    }

    #[allow(dead_code)]
    pub fn supports(&self, kind: ContainerKind, operation: SchemaMutationOperation) -> bool {
        self.objects
            .iter()
            .any(|object| object.kind == kind && object.operations.contains(&operation))
    }

    pub fn relational_database_and_table() -> Self {
        let operations = [
            SchemaMutationOperation::Create,
            SchemaMutationOperation::Alter,
            SchemaMutationOperation::Drop,
        ];
        Self::new(
            [
                SchemaMutationObjectFeatures::new(ContainerKind::Database, operations),
                SchemaMutationObjectFeatures::new(ContainerKind::Table, operations),
            ],
            true,
            true,
            true,
        )
    }

    pub fn relational_table_only() -> Self {
        Self::new(
            [SchemaMutationObjectFeatures::new(
                ContainerKind::Table,
                [
                    SchemaMutationOperation::Create,
                    SchemaMutationOperation::Alter,
                    SchemaMutationOperation::Drop,
                ],
            )],
            true,
            true,
            true,
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DriverCapabilities {
    pub schema_browser: bool,
    pub schema_mutator: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_mutation: Option<SchemaMutationFeatures>,
    pub data_table_browser: bool,
    pub table_row_mutator: bool,
    pub table_row_inserter: bool,
    pub transaction_manager: bool,
    pub sql_executor: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sql_execution: Option<SqlExecutionFeatures>,
    pub key_value_browser: bool,
    pub graph_queryer: bool,
    pub vector_searcher: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionRuntimeInfo {
    pub profile_id: String,
    pub driver_name: String,
    pub capabilities: DriverCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub latency_ms: u64,
    pub driver_name: String,
    pub endpoint: String,
    pub server_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_host_key_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDatabaseInput {
    pub name: String,
    pub character_set: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDatabaseResult {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaMutationPreview {
    pub statements: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub destructive: bool,
}

impl SchemaMutationPreview {
    pub fn from_statements(statements: Vec<String>) -> Self {
        Self {
            statements,
            warnings: Vec::new(),
            destructive: false,
        }
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDatabaseInput {
    pub container: ContainerRef,
    pub name: Option<String>,
    pub comment: Option<String>,
    pub tablespace: Option<String>,
    pub character_set: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDatabaseResult {
    pub old_name: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropDatabaseInput {
    pub container: ContainerRef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropDatabaseResult {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropTableInput {
    pub container: ContainerRef,
    #[serde(default)]
    pub confirm_destructive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropTableResult {
    pub container: ContainerRef,
    pub table_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCharacterSet {
    pub name: String,
    pub description: Option<String>,
    pub default_collation: String,
    pub maxlen: u32,
}

// ─── Table schema design metadata ────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TableIdentityGeneration {
    Always,
    ByDefault,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableIdentityOptions {
    pub generation: TableIdentityGeneration,
    pub start: Option<String>,
    pub increment: Option<String>,
    pub min_value: Option<String>,
    pub max_value: Option<String>,
    pub cache: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub cycle: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TableGeneratedColumnStorage {
    Virtual,
    Stored,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableGeneratedColumn {
    pub expression: String,
    pub storage: TableGeneratedColumnStorage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TableReferentialAction {
    NoAction,
    Restrict,
    Cascade,
    SetNull,
    SetDefault,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableForeignKeyReference {
    pub database_name: Option<String>,
    pub schema_name: Option<String>,
    pub table_name: String,
    pub columns: Vec<String>,
    pub on_update: Option<TableReferentialAction>,
    pub on_delete: Option<TableReferentialAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TablePartitionOptions {
    pub expression: Option<String>,
    pub raw_clause: Option<String>,
    pub readonly_description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableSchemaBasics {
    pub table_name: String,
    pub database_name: String,
    pub schema_name: String,
    pub engine: Option<String>,
    pub charset: Option<String>,
    pub collation: Option<String>,
    pub comment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partition: Option<TablePartitionOptions>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableColumnSchema {
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub is_primary_key: bool,
    pub is_unique: bool,
    pub is_identity: bool,
    pub comment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<TableIdentityOptions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated: Option<TableGeneratedColumn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub charset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableIndexSchema {
    pub name: String,
    pub columns: Vec<String>,
    pub is_unique: bool,
    pub method: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TableConstraintKind {
    PrimaryKey,
    Unique,
    ForeignKey,
    Check,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableConstraintSchema {
    pub name: String,
    pub kind: TableConstraintKind,
    pub columns: Vec<String>,
    pub reference: Option<String>,
    pub expression: Option<String>,
    pub comment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreign_key: Option<TableForeignKeyReference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enforced: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableSchema {
    pub basics: TableSchemaBasics,
    pub columns: Vec<TableColumnSchema>,
    pub indexes: Vec<TableIndexSchema>,
    pub constraints: Vec<TableConstraintSchema>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTableInput {
    pub basics: TableSchemaBasics,
    pub columns: Vec<TableColumnSchema>,
    pub indexes: Vec<TableIndexSchema>,
    pub constraints: Vec<TableConstraintSchema>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTableResult {
    pub container: ContainerRef,
    pub table_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableColumnRename {
    pub old_name: String,
    pub new_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTableInput {
    pub container: ContainerRef,
    pub baseline: TableSchema,
    pub target: TableSchema,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub column_renames: Vec<TableColumnRename>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub confirm_destructive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTableResult {
    pub container: ContainerRef,
    pub table_name: String,
}

// ─── Unified container tree ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContainerKind {
    AssetGroup,
    Database,
    Schema,
    Table,
    View,
    MaterializedView,
    Function,
    Procedure,
    Trigger,
    Index,
    Dictionary,
    Projection,
    Sequence,
    Extension,
    Event,
    Column,
    Collection,
    Document,
    Field,
    NodeLabel,
    RelationshipType,
    VectorCollection,
    Partition,
    SearchIndex,
    DataStream,
    MappingField,
    RedisDatabase,
    RedisKeyPrefix,
    RedisKey,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssetGroupType {
    Tables,
    Views,
    MaterializedViews,
    Functions,
    Procedures,
    Indexes,
    Dictionaries,
    Projections,
    Triggers,
    Sequences,
    Extensions,
    Events,
    Collections,
    Documents,
    Fields,
    NodeLabels,
    RelationshipTypes,
    VectorCollections,
    Partitions,
    SearchIndexes,
    DataStreams,
    Templates,
    Mappings,
    Constraints,
    Columns,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContainerRef {
    pub kind: ContainerKind,
    pub group_type: Option<AssetGroupType>,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub table: Option<String>,
    pub column: Option<String>,
    pub object_name: Option<String>,
    pub db_index: Option<u8>,
    pub key: Option<String>,
    pub pattern: Option<String>,
}

impl ContainerRef {
    pub fn database(name: impl Into<String>) -> Self {
        Self {
            kind: ContainerKind::Database,
            group_type: None,
            database: Some(name.into()),
            schema: None,
            table: None,
            column: None,
            object_name: None,
            db_index: None,
            key: None,
            pattern: None,
        }
    }

    pub fn schema(database: impl Into<String>, schema: impl Into<String>) -> Self {
        Self {
            kind: ContainerKind::Schema,
            group_type: None,
            database: Some(database.into()),
            schema: Some(schema.into()),
            table: None,
            column: None,
            object_name: None,
            db_index: None,
            key: None,
            pattern: None,
        }
    }

    pub fn asset_group(
        group_type: AssetGroupType,
        database: Option<String>,
        schema: Option<String>,
        table: Option<String>,
    ) -> Self {
        Self {
            kind: ContainerKind::AssetGroup,
            group_type: Some(group_type),
            database,
            schema,
            table,
            column: None,
            object_name: None,
            db_index: None,
            key: None,
            pattern: None,
        }
    }

    pub fn table(
        kind: ContainerKind,
        database: impl Into<String>,
        schema: Option<String>,
        table: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            group_type: None,
            database: Some(database.into()),
            schema,
            table: Some(table.into()),
            column: None,
            object_name: None,
            db_index: None,
            key: None,
            pattern: None,
        }
    }

    pub fn named_object(
        kind: ContainerKind,
        database: impl Into<String>,
        schema: Option<String>,
        object_name: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            group_type: None,
            database: Some(database.into()),
            schema,
            table: None,
            column: None,
            object_name: Some(object_name.into()),
            db_index: None,
            key: None,
            pattern: None,
        }
    }

    pub fn connection_named_object(kind: ContainerKind, object_name: impl Into<String>) -> Self {
        Self {
            kind,
            group_type: None,
            database: None,
            schema: None,
            table: None,
            column: None,
            object_name: Some(object_name.into()),
            db_index: None,
            key: None,
            pattern: None,
        }
    }

    pub fn table_named_object(
        kind: ContainerKind,
        database: impl Into<String>,
        table: impl Into<String>,
        object_name: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            group_type: None,
            database: Some(database.into()),
            schema: None,
            table: Some(table.into()),
            column: None,
            object_name: Some(object_name.into()),
            db_index: None,
            key: None,
            pattern: None,
        }
    }

    pub fn column(
        database: impl Into<String>,
        schema: Option<String>,
        table: impl Into<String>,
        column: impl Into<String>,
    ) -> Self {
        Self {
            kind: ContainerKind::Column,
            group_type: None,
            database: Some(database.into()),
            schema,
            table: Some(table.into()),
            column: Some(column.into()),
            object_name: None,
            db_index: None,
            key: None,
            pattern: None,
        }
    }

    pub fn redis_database(db_index: u8) -> Self {
        Self {
            kind: ContainerKind::RedisDatabase,
            group_type: None,
            database: None,
            schema: None,
            table: None,
            column: None,
            object_name: None,
            db_index: Some(db_index),
            key: None,
            pattern: Some("*".to_string()),
        }
    }

    pub fn redis_key_prefix(db_index: u8, pattern: impl Into<String>) -> Self {
        Self {
            kind: ContainerKind::RedisKeyPrefix,
            group_type: None,
            database: None,
            schema: None,
            table: None,
            column: None,
            object_name: None,
            db_index: Some(db_index),
            key: None,
            pattern: Some(pattern.into()),
        }
    }

    pub fn redis_key(db_index: u8, key: impl Into<String>) -> Self {
        Self {
            kind: ContainerKind::RedisKey,
            group_type: None,
            database: None,
            schema: None,
            table: None,
            column: None,
            object_name: None,
            db_index: Some(db_index),
            key: Some(key.into()),
            pattern: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContainerProperty {
    pub key: String,
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataContainer {
    pub id: String,
    pub name: String,
    pub kind: ContainerKind,
    pub is_leaf: bool,
    pub container: ContainerRef,
    pub type_name: Option<String>,
    pub nullable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub properties: Vec<ContainerProperty>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeHealthStatus {
    Healthy,
    Degraded,
    Error,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHealthSnapshot {
    pub profile_id: String,
    pub status: RuntimeHealthStatus,
    pub consecutive_failures: u32,
    pub last_success_at_ms: Option<u64>,
    pub last_failure_at_ms: Option<u64>,
    pub last_error_code: Option<ErrorCode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionRuntimeSnapshot {
    pub profile_id: String,
    pub runtime: ConnectionRuntimeInfo,
    pub health: RuntimeHealthSnapshot,
}

// ─── 元数据类型 ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ColumnDataCategory {
    String,
    Number,
    Boolean,
    Date,
    Time,
    Datetime,
    Json,
    Structured,
    Enum,
    Binary,
    Uuid,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub data_category: ColumnDataCategory,
    pub max_length: Option<i64>,
    pub numeric_precision: Option<i32>,
    pub numeric_scale: Option<i32>,
    pub enum_values: Option<Vec<String>>,
    pub is_primary_key: bool,
    pub primary_key_ordinal: Option<i32>,
    pub is_unique: bool,
    pub is_writable: bool,
}

impl ColumnMeta {
    pub fn readonly_query_column(
        name: impl Into<String>,
        type_name: impl Into<String>,
        nullable: bool,
    ) -> Self {
        Self {
            name: name.into(),
            type_name: type_name.into(),
            nullable,
            default_value: None,
            data_category: ColumnDataCategory::Unknown,
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
}

// ─── 查询结果 ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlExecutionContext {
    pub database: Option<String>,
    pub schema: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SqlExecutionState {
    Queued,
    Starting,
    Running,
    Canceling,
    Succeeded,
    Failed,
    TimedOut,
    Canceled,
    CancelFailed,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SqlStatementClass {
    Read,
    Ddl,
    Insert,
    Delete,
    Mutation,
    System,
    Command,
    Unknown,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SqlResultMode {
    Grid,
    Raw,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlExecutionOptions {
    pub result_mode: SqlResultMode,
    pub timeout_ms: Option<u64>,
    pub page: u32,
    pub page_size: u32,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSqlExecutionRequest {
    pub context: SqlExecutionContext,
    pub sql: String,
    pub options: SqlExecutionOptions,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SqlSummarySource {
    LivePoll,
    ResponseHeader,
    #[default]
    ClientObserved,
    Merged,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SqlSummaryCompleteness {
    Partial,
    Final,
    #[default]
    Unknown,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlExecutionSummary {
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_json_safe_u64_option"
    )]
    pub read_rows: Option<u64>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_json_safe_u64_option"
    )]
    pub read_bytes: Option<u64>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_json_safe_u64_option"
    )]
    pub written_rows: Option<u64>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_json_safe_u64_option"
    )]
    pub written_bytes: Option<u64>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_json_safe_u64_option"
    )]
    pub total_rows_to_read: Option<u64>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_json_safe_u64_option"
    )]
    pub result_rows: Option<u64>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_json_safe_u64_option"
    )]
    pub result_bytes: Option<u64>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_json_safe_u64_option"
    )]
    pub elapsed_ns: Option<u64>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_json_safe_u64_option"
    )]
    pub memory_usage: Option<u64>,
    pub source: SqlSummarySource,
    pub completeness: SqlSummaryCompleteness,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlExecutionFailure {
    pub code: ErrorCode,
    pub runtime_impact: RuntimeErrorImpact,
    pub message: String,
    pub details: Option<String>,
}

impl From<IpcError> for SqlExecutionFailure {
    fn from(error: IpcError) -> Self {
        Self {
            code: error.code,
            runtime_impact: error.runtime_impact,
            message: error.message,
            details: error.details,
        }
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SqlExecutionOutcome {
    Rows {
        result: QueryResult,
    },
    Command {
        statement_class: SqlStatementClass,
        completion_message: String,
        summary: Option<SqlExecutionSummary>,
        mutation_submitted: bool,
    },
    Raw {
        format: Option<String>,
        media_type: String,
        #[serde(serialize_with = "serialize_json_safe_u64")]
        byte_length: u64,
        preview: String,
        preview_truncated: bool,
        artifact_id: String,
    },
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlExecutionHandle {
    pub execution_id: String,
    pub query_id: String,
    pub tab_id: String,
    pub state: SqlExecutionState,
    pub started_at: u64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlExecutionSnapshot {
    pub execution_id: String,
    pub query_id: String,
    pub tab_id: String,
    pub state: SqlExecutionState,
    pub revision: u64,
    pub statement_class: SqlStatementClass,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub progress_available: bool,
    pub summary: Option<SqlExecutionSummary>,
    pub outcome: Option<SqlExecutionOutcome>,
    pub failure: Option<SqlExecutionFailure>,
    pub cancel_message: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub observation_warnings: Vec<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SqlExecutionEvent {
    Snapshot { snapshot: SqlExecutionSnapshot },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    /// 每一行为一个 JSON 值列表，顺序与列顺序一致。
    /// 超出 JavaScript 安全整数边界的 64-bit 整数以字符串传输。
    pub rows: Vec<Vec<serde_json::Value>>,
    /// DML 语句返回此字段；SELECT 语句为 None。
    pub affected_rows: Option<u64>,
    /// 是否存在超出当前页的更多行数据。
    pub has_next_page: bool,
    /// 数据来源是否整体可写。真实表且至少具备主键时才为 true。
    pub source_writable: bool,
    /// 数据来源是否允许新增行；不同于 update/delete 所需的主键可写性。
    pub source_insertable: bool,
    /// 当前数据来源的主键列名，按主键顺序排列。
    pub primary_key_columns: Vec<String>,
    /// 当前浏览结果使用的稳定排序列。无主键时为空。
    pub stable_order_columns: Vec<String>,
    /// DataTable 对已有行进行 update/delete 时使用的行定位策略。
    pub row_locator_strategy: Option<TableRowLocatorStrategy>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableBrowseQuery {
    #[serde(default)]
    pub filters: Vec<TableBrowseFilter>,
    #[serde(default)]
    pub sort: Vec<TableBrowseSort>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableBrowseFilter {
    pub column: String,
    pub operator: TableBrowseFilterOperator,
    pub value: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TableBrowseFilterOperator {
    Eq,
    NotEq,
    Gt,
    Gte,
    Lt,
    Lte,
    IsNull,
    IsNotNull,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableBrowseSort {
    pub column: String,
    pub direction: TableBrowseSortDirection,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TableBrowseSortDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablePageStats {
    #[serde(serialize_with = "serialize_json_safe_u64")]
    pub total_rows: u64,
    #[serde(serialize_with = "serialize_json_safe_u64")]
    pub total_pages: u64,
    pub page_size: u32,
}

const JS_MAX_SAFE_INTEGER_U64: u64 = 9_007_199_254_740_991;

fn serialize_json_safe_u64<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    if *value <= JS_MAX_SAFE_INTEGER_U64 {
        serializer.serialize_u64(*value)
    } else {
        serializer.serialize_str(&value.to_string())
    }
}

#[allow(dead_code)]
fn serialize_json_safe_u64_option<S>(value: &Option<u64>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    match value {
        Some(value) => serialize_json_safe_u64(value, serializer),
        None => serializer.serialize_none(),
    }
}

// ─── 表数据变更 ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TableRowKeyPart {
    pub column: String,
    pub value: serde_json::Value,
}

pub type TableRowKey = Vec<TableRowKeyPart>;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TableRowLocatorStrategy {
    PrimaryKey,
    RowSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind")]
pub enum TableRowLocator {
    #[serde(rename = "primaryKey")]
    PrimaryKey { parts: TableRowKey },
    #[serde(rename = "rowSnapshot")]
    RowSnapshot {
        parts: TableRowKey,
        #[serde(rename = "expectedMatches")]
        expected_matches: u64,
    },
}

impl TableRowLocator {
    pub fn primary_key(parts: TableRowKey) -> Self {
        Self::PrimaryKey { parts }
    }

    pub fn primary_key_parts(&self) -> Option<&TableRowKey> {
        match self {
            Self::PrimaryKey { parts } => Some(parts),
            Self::RowSnapshot { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableCellChange {
    pub column: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableMutationResult {
    pub affected_rows: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableChangeSetUpdate {
    pub locator: TableRowLocator,
    pub changes: Vec<TableCellChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableChangeSetInsert {
    pub values: Vec<TableCellChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableChangeSetRequest {
    pub inserts: Vec<TableChangeSetInsert>,
    pub updates: Vec<TableChangeSetUpdate>,
    pub deletes: Vec<TableRowLocator>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableChangeSetSummary {
    pub inserts: u32,
    pub updates: u32,
    pub deletes: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableChangeSetPreview {
    pub statements: Vec<String>,
    pub summary: TableChangeSetSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableChangeSetCommitResult {
    pub affected_rows: u64,
    pub preview: TableChangeSetPreview,
    pub outcome: TableChangeOutcome,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TableChangeOutcome {
    Applied,
    Submitted,
    OutcomeUnknown,
    Conflict,
}

// ─── 表数据事务 ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableTransactionState {
    pub in_transaction: bool,
    pub database: Option<String>,
}

// ─── 心跳（Ping）结果 ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResult {
    pub latency_ms: u64,
}

// ─── Redis browsing ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisScanRequest {
    pub db_index: u8,
    pub pattern: String,
    pub cursor: u64,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyRef {
    pub db_index: u8,
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyInfo {
    pub key: String,
    pub value_type: String,
    pub ttl: i64,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisScanResult {
    pub cursor: u64,
    pub keys: Vec<RedisKeyInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyTreeRequest {
    pub db_index: u8,
    pub pattern: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RedisKeyTreeNodeKind {
    Prefix,
    Key,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyTreeNode {
    pub id: String,
    pub label: String,
    pub node_type: RedisKeyTreeNodeKind,
    pub prefix: Option<String>,
    pub pattern: Option<String>,
    pub key: Option<String>,
    pub key_count: u64,
    pub value_type: Option<String>,
    pub children: Vec<RedisKeyTreeNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyTreeResult {
    pub db_index: u8,
    pub pattern: String,
    pub total_key_count: u64,
    pub nodes: Vec<RedisKeyTreeNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisHashEntry {
    pub field: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisSortedSetEntry {
    pub member: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisStreamEntry {
    pub id: String,
    pub fields: Vec<RedisHashEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum RedisValue {
    String(RedisStringValue),
    Json(String),
    Hash(Vec<RedisHashEntry>),
    List(Vec<String>),
    Set(Vec<String>),
    SortedSet(Vec<RedisSortedSetEntry>),
    Stream(Vec<RedisStreamEntry>),
    Unsupported(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "encoding", rename_all = "snake_case")]
pub enum RedisStringValue {
    Utf8 {
        value: Option<String>,
    },
    Binary {
        #[serde(rename = "byteLength")]
        byte_length: usize,
        #[serde(rename = "previewHex")]
        preview_hex: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyValue {
    pub key: String,
    pub value_type: String,
    pub ttl: i64,
    pub size: Option<u64>,
    pub fingerprint: String,
    pub value: RedisValue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyPrecondition {
    pub db_index: u8,
    pub key: String,
    pub value_type: String,
    pub ttl: i64,
    pub size: Option<u64>,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RedisTtlPolicy {
    Keep,
    Persist,
    Expire,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum RedisEditableValue {
    String(String),
    Json(String),
    Hash(Vec<RedisHashEntry>),
    List(Vec<String>),
    Set(Vec<String>),
    SortedSet(Vec<RedisSortedSetEntry>),
    Stream(Vec<RedisStreamEntry>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisSetKeyValueRequest {
    pub db_index: u8,
    pub key: String,
    pub value: RedisEditableValue,
    pub expected_fingerprint: String,
    pub expected_type: Option<String>,
    pub ttl_policy: Option<RedisTtlPolicy>,
    pub ttl_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisCreateKeyValueRequest {
    pub db_index: u8,
    pub key: String,
    pub value: RedisEditableValue,
    pub ttl_policy: Option<RedisTtlPolicy>,
    pub ttl_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisDeleteKeyRequest {
    pub db_index: u8,
    pub key: String,
    pub expected_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisDeleteKeyPrefixRequest {
    pub db_index: u8,
    pub pattern: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisRenameKeyRequest {
    pub db_index: u8,
    pub key: String,
    pub new_key: String,
    pub expected_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RedisSetKeyTtlMode {
    Expire,
    Persist,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisSetKeyTtlRequest {
    pub db_index: u8,
    pub key: String,
    pub expected_fingerprint: String,
    pub mode: RedisSetKeyTtlMode,
    pub ttl_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyMutationResult {
    pub db_index: u8,
    pub key: String,
    pub value_type: String,
    pub ttl: i64,
    pub size: Option<u64>,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisDeleteKeyResult {
    pub db_index: u8,
    pub key: Option<String>,
    pub pattern: Option<String>,
    pub deleted_count: u64,
}

// ─── Graph query (reserved for future graph drivers) ─────────────────────────

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphQueryRequest {
    pub query: String,
    pub database: Option<String>,
    pub parameters: Option<serde_json::Value>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub labels: Vec<String>,
    pub properties: serde_json::Value,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRelationship {
    pub id: String,
    pub rel_type: String,
    pub start_node_id: String,
    pub end_node_id: String,
    pub properties: serde_json::Value,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphQueryResult {
    pub columns: Vec<String>,
    pub nodes: Vec<GraphNode>,
    pub relationships: Vec<GraphRelationship>,
    pub rows: Vec<Vec<serde_json::Value>>,
}

// ─── Vector search (reserved for future vector drivers) ──────────────────────

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorSearchRequest {
    pub collection: String,
    pub vector: Vec<f32>,
    pub top_k: u32,
    pub filter: Option<serde_json::Value>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorSearchResult {
    pub id: String,
    pub score: f32,
    pub vector: Option<Vec<f32>>,
    pub metadata: Option<serde_json::Value>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorSearchResponse {
    pub results: Vec<VectorSearchResult>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_sql_execution_contract_is_camel_case_and_json_safe() {
        let features = SqlExecutionFeatures {
            managed_lifecycle: true,
            statement_access: SqlStatementAccess::ReadOnly,
            active_cancel: true,
            live_progress: true,
            query_summary: true,
            raw_result: false,
            configurable_timeout: true,
        };
        let json = serde_json::to_value(features).unwrap();
        assert_eq!(json["managedLifecycle"], true);
        assert_eq!(json["statementAccess"], "readOnly");

        let summary = SqlExecutionSummary {
            read_rows: Some(9_007_199_254_740_992),
            source: SqlSummarySource::Merged,
            completeness: SqlSummaryCompleteness::Partial,
            ..SqlExecutionSummary::default()
        };
        let json = serde_json::to_value(summary).unwrap();
        assert_eq!(json["readRows"], "9007199254740992");
        assert_eq!(json["source"], "merged");

        let outcome = SqlExecutionOutcome::Command {
            statement_class: SqlStatementClass::Ddl,
            completion_message: "执行完成".into(),
            summary: None,
            mutation_submitted: false,
        };
        assert_eq!(serde_json::to_value(outcome).unwrap()["kind"], "command");
    }

    #[test]
    fn schema_mutation_features_serialize_as_granular_operations() {
        let features = SchemaMutationFeatures::new(
            vec![SchemaMutationObjectFeatures::new(
                ContainerKind::Table,
                vec![
                    SchemaMutationOperation::Create,
                    SchemaMutationOperation::Alter,
                    SchemaMutationOperation::Drop,
                ],
            )],
            true,
            true,
            true,
        );

        let value = serde_json::to_value(features).expect("serialize schema features");
        assert_eq!(value["objects"][0]["kind"], "table");
        assert_eq!(value["objects"][0]["operations"][1], "alter");
        assert_eq!(value["ddlPreview"], true);
        assert_eq!(value["destructiveConfirmation"], true);
        assert_eq!(value["remoteDriftProtection"], true);
    }

    #[test]
    fn schema_rename_operation_has_a_stable_generic_tag() {
        assert_eq!(
            serde_json::to_value(SchemaMutationOperation::Rename)
                .expect("serialize rename operation"),
            "rename"
        );
    }

    #[test]
    fn schema_mutation_features_deduplicate_objects_and_operations() {
        let features = SchemaMutationFeatures::new(
            [
                SchemaMutationObjectFeatures::new(
                    ContainerKind::Table,
                    [
                        SchemaMutationOperation::Create,
                        SchemaMutationOperation::Create,
                    ],
                ),
                SchemaMutationObjectFeatures::new(
                    ContainerKind::Table,
                    [
                        SchemaMutationOperation::Alter,
                        SchemaMutationOperation::Create,
                    ],
                ),
            ],
            true,
            true,
            true,
        );

        assert_eq!(features.objects.len(), 1);
        assert_eq!(
            features.objects[0].operations,
            vec![
                SchemaMutationOperation::Create,
                SchemaMutationOperation::Alter,
            ]
        );
    }

    #[test]
    fn structured_category_and_table_stats_are_json_safe() {
        assert_eq!(
            serde_json::to_value(ColumnDataCategory::Structured).unwrap(),
            serde_json::json!("structured")
        );

        let safe = TablePageStats {
            total_rows: 9_007_199_254_740_991,
            total_pages: 42,
            page_size: 100,
        };
        let safe_json = serde_json::to_value(safe).unwrap();
        assert_eq!(
            safe_json["totalRows"],
            serde_json::json!(9_007_199_254_740_991_u64)
        );
        assert_eq!(safe_json["totalPages"], serde_json::json!(42));

        let unsafe_stats = TablePageStats {
            total_rows: 9_007_199_254_740_992,
            total_pages: u64::MAX,
            page_size: 1,
        };
        let unsafe_json = serde_json::to_value(unsafe_stats).unwrap();
        assert_eq!(unsafe_json["totalRows"], "9007199254740992");
        assert_eq!(unsafe_json["totalPages"], "18446744073709551615");
    }

    #[test]
    fn asset_group_container_ref_serializes_with_camel_case_group_type() {
        let container = ContainerRef::asset_group(
            AssetGroupType::MaterializedViews,
            Some("app".to_string()),
            Some("public".to_string()),
            None,
        );

        let value = serde_json::to_value(container).expect("serialize container ref");

        assert_eq!(value["kind"], "asset_group");
        assert_eq!(value["groupType"], "materialized_views");
        assert_eq!(value["database"], "app");
        assert_eq!(value["schema"], "public");
    }

    #[test]
    fn named_object_container_ref_serializes_future_entity_address() {
        let container = ContainerRef::named_object(
            ContainerKind::Function,
            "app",
            Some("public".to_string()),
            "calculate_score",
        );

        let value = serde_json::to_value(container).expect("serialize named object ref");

        assert_eq!(value["kind"], "function");
        assert_eq!(value["objectName"], "calculate_score");
    }

    #[test]
    fn clickhouse_phase_two_contract_serializes_new_kinds_and_properties() {
        let container = DataContainer {
            id: "clickhouse::database::analytics::projection::daily".to_string(),
            name: "daily".to_string(),
            kind: ContainerKind::Projection,
            is_leaf: true,
            container: ContainerRef::table_named_object(
                ContainerKind::Projection,
                "analytics",
                "events",
                "daily",
            ),
            type_name: None,
            nullable: None,
            item_count: None,
            properties: vec![ContainerProperty {
                key: "definition".to_string(),
                label: "定义".to_string(),
                value: "SELECT day, count() GROUP BY day".to_string(),
            }],
        };

        let value = serde_json::to_value(container).expect("serialize data container");
        assert_eq!(value["kind"], "projection");
        assert_eq!(value["container"]["kind"], "projection");
        assert_eq!(value["container"]["database"], "analytics");
        assert_eq!(value["container"]["table"], "events");
        assert_eq!(value["container"]["objectName"], "daily");
        assert_eq!(value["properties"][0]["key"], "definition");
    }

    #[test]
    fn connection_scoped_named_object_has_no_database_address() {
        let container = ContainerRef::connection_named_object(ContainerKind::Function, "arrayMap");
        let value = serde_json::to_value(container).expect("serialize function ref");

        assert_eq!(value["kind"], "function");
        assert_eq!(value["objectName"], "arrayMap");
        assert!(value["database"].is_null());
    }

    #[test]
    fn empty_properties_are_omitted_from_ipc_json() {
        let container = DataContainer {
            id: "database::default".to_string(),
            name: "default".to_string(),
            kind: ContainerKind::Database,
            is_leaf: false,
            container: ContainerRef::database("default"),
            type_name: None,
            nullable: None,
            item_count: None,
            properties: Vec::new(),
        };

        let value = serde_json::to_value(container).expect("serialize data container");
        assert!(value.get("properties").is_none());
    }

    #[test]
    fn query_result_serializes_source_insertable() {
        let result = QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            affected_rows: None,
            has_next_page: false,
            source_writable: false,
            source_insertable: true,
            primary_key_columns: Vec::new(),
            stable_order_columns: Vec::new(),
            row_locator_strategy: None,
        };

        let value = serde_json::to_value(result).expect("serialize query result");

        assert_eq!(value["sourceInsertable"], true);
    }

    #[test]
    fn table_row_locator_and_outcome_use_stable_camel_case_tags() {
        let locator = TableRowLocator::RowSnapshot {
            parts: vec![TableRowKeyPart {
                column: "id".to_string(),
                value: serde_json::json!("18446744073709551615"),
            }],
            expected_matches: 1,
        };
        let value = serde_json::to_value(locator).expect("serialize row locator");

        assert_eq!(value["kind"], "rowSnapshot");
        assert_eq!(value["expectedMatches"], 1);
        assert_eq!(value["parts"][0]["column"], "id");
        assert_eq!(
            serde_json::to_value(TableChangeOutcome::OutcomeUnknown)
                .expect("serialize change outcome"),
            "outcomeUnknown"
        );
    }
}
