use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::engine::types::{
    ColumnDataCategory, ColumnMeta, ConnectionRuntimeSnapshot, ContainerKind, ContainerRef,
    DataContainer, DriverCapabilities, QueryResult, RedisCreateKeyValueRequest,
    RedisDeleteKeyRequest, RedisEditableValue, RedisKeyMutationResult, RedisKeyValue,
    RedisRenameKeyRequest, RedisScanRequest, RedisScanResult, RedisSetKeyTtlMode,
    RedisSetKeyTtlRequest, RedisSetKeyValueRequest, RedisTtlPolicy, RedisValue,
    RuntimeHealthStatus, TableBrowseFilter, TableBrowseQuery, TableBrowseSort, TablePageStats,
    TableSchema,
};
use crate::repository::connection_repository::{ConnectionRecordStatus, StoredConnectionRecord};

pub const METADATA_DEFAULT_LIMIT: u64 = 100;
pub const METADATA_MAX_LIMIT: u64 = 200;
pub const TABLE_QUERY_DEFAULT_PAGE_SIZE: u32 = 50;
pub const TABLE_QUERY_MAX_PAGE_SIZE: u32 = 100;
pub const TABLE_QUERY_MAX_COLUMNS: usize = 50;
pub const TABLE_QUERY_MAX_FILTERS: usize = 10;
pub const TABLE_QUERY_MAX_SORTS: usize = 5;
pub const KEY_VALUE_SCAN_DEFAULT_COUNT: u32 = 100;
pub const KEY_VALUE_SCAN_MAX_COUNT: u32 = 500;
pub const KEY_VALUE_MAX_PATTERN_CHARS: usize = 1024;
pub const KEY_VALUE_MAX_KEY_CHARS: usize = 4096;
pub const KEY_VALUE_MAX_VALUE_CHARS: usize = 256 * 1024;
pub const KEY_VALUE_MAX_COLLECTION_ITEMS: usize = 1000;
pub const KEY_VALUE_MAX_COLLECTION_TEXT_CHARS: usize = 4096;
pub const KEY_VALUE_MAX_STREAM_FIELDS: usize = 100;
pub const KEY_VALUE_MAX_STREAM_ID_CHARS: usize = 128;
pub const KEY_VALUE_MAX_TTL_SECONDS: u64 = 31_536_000;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectionListRequest {}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionListResponse {
    pub connections: Vec<ConnectionListItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionListItem {
    pub profile_id: String,
    pub name: String,
    pub driver: String,
    pub environment: String,
    pub location: AiConnectionLocation,
    pub connected: bool,
}

impl ConnectionListItem {
    pub fn from_record(record: &StoredConnectionRecord, connected: bool) -> Self {
        let settings = AiConnectionSettings::from_payload(&record.payload);
        Self {
            profile_id: record.id.clone(),
            name: record.name.clone(),
            driver: record.driver.as_str().to_string(),
            environment: record.environment.clone(),
            location: AiConnectionLocation::from_settings(&settings),
            connected,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionGetRequest {
    pub profile_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionGetResponse {
    pub connection: ConnectionDetail,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionOpenRequest {
    pub profile_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionOpenResponse {
    pub connection: OpenedConnection,
    pub was_already_open: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedConnection {
    pub profile_id: String,
    pub name: String,
    pub driver: String,
    pub connected: bool,
    pub runtime: AiConnectionRuntime,
}

impl OpenedConnection {
    pub fn from_record(
        record: &StoredConnectionRecord,
        runtime: &ConnectionRuntimeSnapshot,
    ) -> Self {
        Self {
            profile_id: record.id.clone(),
            name: record.name.clone(),
            driver: record.driver.as_str().to_string(),
            connected: true,
            runtime: AiConnectionRuntime::from_snapshot(runtime),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionDetail {
    pub profile_id: String,
    pub name: String,
    pub driver: String,
    pub environment: String,
    pub settings: AiConnectionSettings,
    pub connected: bool,
    pub runtime: Option<AiConnectionRuntime>,
    pub color: Option<String>,
    pub tag_label: String,
    pub tag_color: Option<String>,
    pub folder_id: Option<String>,
    pub sort_order: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_connected_at: Option<i64>,
    pub last_connection_status: Option<ConnectionRecordStatus>,
}

impl ConnectionDetail {
    pub fn from_record(
        record: &StoredConnectionRecord,
        runtime: Option<&ConnectionRuntimeSnapshot>,
    ) -> Self {
        Self {
            profile_id: record.id.clone(),
            name: record.name.clone(),
            driver: record.driver.as_str().to_string(),
            environment: record.environment.clone(),
            settings: AiConnectionSettings::from_payload(&record.payload),
            connected: runtime.is_some(),
            runtime: runtime.map(AiConnectionRuntime::from_snapshot),
            color: record.color.clone(),
            tag_label: record.tag_label.clone(),
            tag_color: record.tag_color.clone(),
            folder_id: record.folder_id.clone(),
            sort_order: record.sort_order,
            created_at: record.created_at,
            updated_at: record.updated_at,
            last_connected_at: record.last_connected_at,
            last_connection_status: record.last_connection_status.clone(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConnectionLocation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_database: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub db_index: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub db_file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_collection: Option<String>,
}

impl AiConnectionLocation {
    fn from_settings(settings: &AiConnectionSettings) -> Self {
        Self {
            host: settings.host.clone(),
            port: settings.port,
            username: settings.username.clone(),
            default_database: settings.default_database.clone(),
            schema: settings.schema.clone(),
            service_name: settings.service_name.clone(),
            sid: settings.sid.clone(),
            db_index: settings.db_index,
            db_file_path: settings.db_file_path.clone(),
            endpoint: settings.endpoint.clone(),
            database: settings.database.clone(),
            default_collection: settings.default_collection.clone(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConnectionSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_database: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssl_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connect_timeout_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connect_descriptor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub db_index: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_tls: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub db_file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_read_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replica_set: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index_prefix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_collection: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment_str: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encryption: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_tunnel: Option<AiSshTunnelSettings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_config: Option<AiLocalFileSettings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network_config: Option<AiNetworkSettings>,
}

impl AiConnectionSettings {
    pub fn from_payload(payload: &Value) -> Self {
        Self {
            host: string_field(payload, "host"),
            port: unsigned_field(payload, "port"),
            username: string_field(payload, "username"),
            default_database: string_field(payload, "defaultDatabase"),
            schema: string_field(payload, "schema"),
            ssl_mode: string_field(payload, "sslMode"),
            connect_timeout_seconds: unsigned_field(payload, "connectTimeoutSeconds"),
            protocol: string_field(payload, "protocol"),
            service_name: string_field(payload, "serviceName"),
            sid: string_field(payload, "sid"),
            connect_descriptor: string_field(payload, "connectDescriptor"),
            role: string_field(payload, "role"),
            db_index: unsigned_field(payload, "dbIndex"),
            use_tls: bool_field(payload, "useTLS"),
            db_file_path: string_field(payload, "dbFilePath"),
            is_read_only: bool_field(payload, "isReadOnly"),
            auth_source: string_field(payload, "authSource"),
            replica_set: string_field(payload, "replicaSet"),
            index_prefix: string_field(payload, "indexPrefix"),
            default_collection: string_field(payload, "defaultCollection"),
            endpoint: string_field(payload, "endpoint"),
            environment_str: string_field(payload, "environmentStr"),
            mode: string_field(payload, "mode"),
            database: string_field(payload, "database"),
            encryption: string_field(payload, "encryption"),
            ssh_tunnel: object_field(payload, "sshTunnel").map(AiSshTunnelSettings::from_value),
            local_config: object_field(payload, "localConfig").map(AiLocalFileSettings::from_value),
            network_config: object_field(payload, "networkConfig")
                .map(AiNetworkSettings::from_value),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSshTunnelSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_verification: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_key_fingerprint: Option<String>,
}

impl AiSshTunnelSettings {
    fn from_value(value: &Value) -> Self {
        Self {
            enabled: bool_field(value, "enabled"),
            host: string_field(value, "host"),
            port: unsigned_field(value, "port"),
            username: string_field(value, "username"),
            auth_method: string_field(value, "authMethod"),
            host_verification: string_field(value, "hostVerification"),
            host_key_fingerprint: string_field(value, "hostKeyFingerprint"),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiLocalFileSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub db_file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_read_only: Option<bool>,
}

impl AiLocalFileSettings {
    fn from_value(value: &Value) -> Self {
        Self {
            db_file_path: string_field(value, "dbFilePath"),
            is_read_only: bool_field(value, "isReadOnly"),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiNetworkSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connect_timeout_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_tunnel: Option<AiSshTunnelSettings>,
}

impl AiNetworkSettings {
    fn from_value(value: &Value) -> Self {
        Self {
            host: string_field(value, "host"),
            port: unsigned_field(value, "port"),
            username: string_field(value, "username"),
            connect_timeout_seconds: unsigned_field(value, "connectTimeoutSeconds"),
            ssh_tunnel: object_field(value, "sshTunnel").map(AiSshTunnelSettings::from_value),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConnectionRuntime {
    pub driver_name: String,
    pub health_status: String,
    pub available_capabilities: Vec<&'static str>,
    pub consecutive_failures: u32,
    pub last_success_at_ms: Option<u64>,
    pub last_failure_at_ms: Option<u64>,
    pub last_error_code: Option<crate::error::ErrorCode>,
}

impl AiConnectionRuntime {
    pub fn from_snapshot(snapshot: &ConnectionRuntimeSnapshot) -> Self {
        Self {
            driver_name: snapshot.runtime.driver_name.clone(),
            health_status: match snapshot.health.status {
                RuntimeHealthStatus::Healthy => "healthy",
                RuntimeHealthStatus::Degraded => "degraded",
                RuntimeHealthStatus::Error => "error",
            }
            .to_string(),
            available_capabilities: available_capabilities(&snapshot.runtime.capabilities),
            consecutive_failures: snapshot.health.consecutive_failures,
            last_success_at_ms: snapshot.health.last_success_at_ms,
            last_failure_at_ms: snapshot.health.last_failure_at_ms,
            last_error_code: snapshot.health.last_error_code,
        }
    }
}

fn available_capabilities(capabilities: &DriverCapabilities) -> Vec<&'static str> {
    let mut available = Vec::new();
    if capabilities.schema_browser {
        available.push("schema_browser");
    }
    if capabilities.schema_mutator {
        available.push("schema_mutator");
    }
    if capabilities.data_table_browser {
        available.push("data_table_browser");
    }
    if capabilities.table_row_mutator {
        available.push("table_row_mutator");
    }
    if capabilities.table_row_inserter {
        available.push("table_row_inserter");
    }
    if capabilities.transaction_manager {
        available.push("transaction_manager");
    }
    if capabilities.sql_executor {
        available.push("sql_executor");
    }
    if capabilities.key_value_browser {
        available.push("key_value_browser");
    }
    if capabilities.graph_queryer {
        available.push("graph_queryer");
    }
    if capabilities.vector_searcher {
        available.push("vector_searcher");
    }
    available
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetadataListChildrenRequest {
    pub profile_id: String,
    pub parent: Option<ContainerRef>,
    #[serde(default)]
    pub offset: u64,
    #[serde(
        default = "default_metadata_limit",
        deserialize_with = "deserialize_metadata_limit"
    )]
    pub limit: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataListChildrenResponse {
    pub children: Vec<DataContainer>,
    pub total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetadataDescribeTableRequest {
    pub profile_id: String,
    pub container: TableContainerRef,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataDescribeTableResponse {
    pub container: TableContainerRef,
    pub schema: TableSchema,
}

#[derive(Debug, Serialize)]
#[serde(transparent)]
pub struct TableContainerRef(ContainerRef);

impl TableContainerRef {
    pub fn new(container: ContainerRef) -> Result<Self, &'static str> {
        if container.kind != ContainerKind::Table {
            return Err("metadata.describe_table requires a table container");
        }
        Ok(Self(container))
    }

    pub fn as_container_ref(&self) -> &ContainerRef {
        &self.0
    }
}

impl<'de> Deserialize<'de> for TableContainerRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let container = ContainerRef::deserialize(deserializer)?;
        Self::new(container).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(transparent)]
pub struct TableDataContainerRef(ContainerRef);

impl TableDataContainerRef {
    pub fn new(container: ContainerRef) -> Result<Self, &'static str> {
        if !matches!(
            container.kind,
            ContainerKind::Table | ContainerKind::View | ContainerKind::MaterializedView
        ) {
            return Err("table.query requires a table, view, or materialized_view container");
        }
        if container.group_type.is_some()
            || container
                .table
                .as_deref()
                .is_none_or(|table| table.trim().is_empty())
            || container.column.is_some()
            || container.object_name.is_some()
            || container.db_index.is_some()
            || container.key.is_some()
            || container.pattern.is_some()
        {
            return Err("table.query requires an exact table-like container address");
        }
        Ok(Self(container))
    }

    pub fn as_container_ref(&self) -> &ContainerRef {
        &self.0
    }
}

impl<'de> Deserialize<'de> for TableDataContainerRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let container = ContainerRef::deserialize(deserializer)?;
        Self::new(container).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableQueryRequest {
    pub profile_id: String,
    pub source: TableDataContainerRef,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub filters: Vec<TableBrowseFilter>,
    #[serde(default)]
    pub sort: Vec<TableBrowseSort>,
    #[serde(default = "default_table_query_page")]
    #[serde(deserialize_with = "deserialize_table_query_page")]
    pub page: u32,
    #[serde(
        default = "default_table_query_page_size",
        deserialize_with = "deserialize_table_query_page_size"
    )]
    pub page_size: u32,
}

impl TableQueryRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.profile_id.trim().is_empty() {
            return Err("table.query profileId must not be empty");
        }
        if self.columns.len() > TABLE_QUERY_MAX_COLUMNS {
            return Err("table.query selects too many columns");
        }
        if self.filters.len() > TABLE_QUERY_MAX_FILTERS {
            return Err("table.query has too many filters");
        }
        if self.sort.len() > TABLE_QUERY_MAX_SORTS {
            return Err("table.query has too many sort fields");
        }
        if self.columns.iter().any(|column| column.trim().is_empty()) {
            return Err("table.query column names must not be empty");
        }
        if self
            .filters
            .iter()
            .any(|filter| filter.column.trim().is_empty())
        {
            return Err("table.query filter column names must not be empty");
        }
        if self.sort.iter().any(|sort| sort.column.trim().is_empty()) {
            return Err("table.query sort column names must not be empty");
        }
        for filter in &self.filters {
            use crate::engine::types::TableBrowseFilterOperator;
            match filter.operator {
                TableBrowseFilterOperator::IsNull | TableBrowseFilterOperator::IsNotNull => {
                    if filter.value.is_some() {
                        return Err("table.query null filters must not contain a value");
                    }
                }
                _ => match filter.value.as_ref() {
                    Some(Value::String(value)) if value.chars().count() <= 4096 => {}
                    Some(Value::Number(_)) | Some(Value::Bool(_)) => {}
                    _ => return Err("table.query value filters require a bounded scalar value"),
                },
            }
        }
        let mut selected = std::collections::HashSet::new();
        if self
            .columns
            .iter()
            .any(|column| !selected.insert(column.as_str()))
        {
            return Err("table.query columns must not contain duplicates");
        }
        let mut sorted = std::collections::HashSet::new();
        if self
            .sort
            .iter()
            .any(|sort| !sorted.insert(sort.column.as_str()))
        {
            return Err("table.query sort columns must not contain duplicates");
        }
        Ok(())
    }

    pub fn browse_query(&self) -> TableBrowseQuery {
        TableBrowseQuery {
            filters: self.filters.clone(),
            sort: self.sort.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableQueryResponse {
    pub source: TableDataContainerRef,
    pub columns: Vec<TableQueryColumn>,
    pub rows: Vec<Vec<Value>>,
    pub page: u32,
    pub page_size: u32,
    #[serde(serialize_with = "serialize_json_safe_u64")]
    pub total_rows: u64,
    #[serde(serialize_with = "serialize_json_safe_u64")]
    pub total_pages: u64,
    pub has_next_page: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableQueryColumn {
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
    pub data_category: ColumnDataCategory,
}

impl TableQueryResponse {
    pub fn new(
        source: TableDataContainerRef,
        mut result: QueryResult,
        stats: TablePageStats,
        page: u32,
        page_size: u32,
        selected_columns: &[String],
    ) -> Result<Self, &'static str> {
        if !selected_columns.is_empty() {
            let mut seen = std::collections::HashSet::new();
            let mut indices = Vec::with_capacity(selected_columns.len());
            for selected in selected_columns {
                if !seen.insert(selected.as_str()) {
                    return Err("table.query columns must not contain duplicates");
                }
                let index = result
                    .columns
                    .iter()
                    .position(|column| column.name == *selected)
                    .ok_or("table.query selected an unknown column")?;
                indices.push(index);
            }
            result.columns = indices
                .iter()
                .map(|index| result.columns[*index].clone())
                .collect();
            result.rows = result
                .rows
                .into_iter()
                .map(|row| {
                    indices
                        .iter()
                        .map(|index| row.get(*index).cloned().unwrap_or(Value::Null))
                        .collect()
                })
                .collect();
        }

        Ok(Self {
            source,
            columns: result
                .columns
                .into_iter()
                .map(TableQueryColumn::from)
                .collect(),
            rows: result.rows,
            page,
            page_size,
            total_rows: stats.total_rows,
            total_pages: stats.total_pages,
            has_next_page: result.has_next_page,
        })
    }
}

impl From<ColumnMeta> for TableQueryColumn {
    fn from(column: ColumnMeta) -> Self {
        Self {
            name: column.name,
            type_name: column.type_name,
            nullable: column.nullable,
            data_category: column.data_category,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyValueScanRequest {
    pub profile_id: String,
    pub db_index: u8,
    #[serde(default = "default_key_value_scan_pattern")]
    pub pattern: String,
    #[serde(
        default = "default_key_value_scan_cursor",
        deserialize_with = "deserialize_json_safe_u64"
    )]
    pub cursor: u64,
    #[serde(
        default = "default_key_value_scan_count",
        deserialize_with = "deserialize_key_value_scan_count"
    )]
    pub count: u32,
}

impl KeyValueScanRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.profile_id.trim().is_empty() {
            return Err("key_value.scan profileId must not be empty");
        }
        if self.pattern.is_empty() || self.pattern.chars().count() > KEY_VALUE_MAX_PATTERN_CHARS {
            return Err("key_value.scan pattern length is invalid");
        }
        Ok(())
    }

    pub fn scan_request(&self) -> RedisScanRequest {
        RedisScanRequest {
            db_index: self.db_index,
            pattern: self.pattern.clone(),
            cursor: self.cursor,
            count: self.count,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyValueScanResponse {
    pub db_index: u8,
    pub pattern: String,
    pub next_cursor: String,
    pub done: bool,
    pub keys: Vec<String>,
}

impl KeyValueScanResponse {
    pub fn new(request: KeyValueScanRequest, result: RedisScanResult) -> Self {
        Self {
            db_index: request.db_index,
            pattern: request.pattern,
            next_cursor: result.cursor.to_string(),
            done: result.cursor == 0,
            keys: result.keys.into_iter().map(|item| item.key).collect(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyValueGetRequest {
    pub profile_id: String,
    pub db_index: u8,
    pub key: String,
}

impl KeyValueGetRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.profile_id.trim().is_empty() {
            return Err("key_value.get profileId must not be empty");
        }
        if self.key.is_empty() || self.key.chars().count() > KEY_VALUE_MAX_KEY_CHARS {
            return Err("key_value.get key length is invalid");
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyValueGetResponse {
    pub key: String,
    pub value_type: String,
    pub ttl: i64,
    #[serde(serialize_with = "serialize_json_safe_option_u64")]
    pub size: Option<u64>,
    pub value: RedisValue,
}

impl From<RedisKeyValue> for KeyValueGetResponse {
    fn from(value: RedisKeyValue) -> Self {
        Self {
            key: value.key,
            value_type: value.value_type,
            ttl: value.ttl,
            size: value.size,
            value: value.value,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyValueCreateToolRequest {
    pub profile_id: String,
    pub db_index: u8,
    pub key: String,
    pub value: RedisEditableValue,
    pub ttl_seconds: Option<u64>,
}

impl KeyValueCreateToolRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_key_value_target(&self.profile_id, &self.key)?;
        validate_key_value_editable_value(&self.value)?;
        validate_optional_ttl_seconds(self.ttl_seconds)
    }

    pub fn mutation_request(&self) -> RedisCreateKeyValueRequest {
        RedisCreateKeyValueRequest {
            db_index: self.db_index,
            key: self.key.clone(),
            value: self.value.clone(),
            ttl_policy: self.ttl_seconds.map(|_| RedisTtlPolicy::Expire),
            ttl_seconds: self.ttl_seconds,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyValueSetToolRequest {
    pub profile_id: String,
    pub db_index: u8,
    pub key: String,
    pub value: RedisEditableValue,
    #[serde(default = "default_key_value_ttl_policy")]
    pub ttl_policy: RedisTtlPolicy,
    pub ttl_seconds: Option<u64>,
}

impl KeyValueSetToolRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_key_value_target(&self.profile_id, &self.key)?;
        validate_key_value_editable_value(&self.value)?;
        match (&self.ttl_policy, self.ttl_seconds) {
            (RedisTtlPolicy::Expire, Some(seconds)) => validate_ttl_seconds(seconds),
            (RedisTtlPolicy::Expire, None) => {
                Err("key_value.set ttlPolicy=expire requires ttlSeconds")
            }
            (_, Some(_)) => Err("key_value.set ttlSeconds is only valid for ttlPolicy=expire"),
            (_, None) => Ok(()),
        }
    }

    pub fn mutation_request(&self, expected_fingerprint: String) -> RedisSetKeyValueRequest {
        RedisSetKeyValueRequest {
            db_index: self.db_index,
            key: self.key.clone(),
            value: self.value.clone(),
            expected_fingerprint,
            expected_type: None,
            ttl_policy: Some(self.ttl_policy.clone()),
            ttl_seconds: self.ttl_seconds,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyValueRenameToolRequest {
    pub profile_id: String,
    pub db_index: u8,
    pub key: String,
    pub new_key: String,
}

impl KeyValueRenameToolRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_key_value_target(&self.profile_id, &self.key)?;
        validate_key(&self.new_key)?;
        if self.key == self.new_key {
            return Err("key_value.rename newKey must differ from key");
        }
        Ok(())
    }

    pub fn mutation_request(&self, expected_fingerprint: String) -> RedisRenameKeyRequest {
        RedisRenameKeyRequest {
            db_index: self.db_index,
            key: self.key.clone(),
            new_key: self.new_key.clone(),
            expected_fingerprint,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyValueSetTtlToolRequest {
    pub profile_id: String,
    pub db_index: u8,
    pub key: String,
    pub mode: RedisSetKeyTtlMode,
    pub ttl_seconds: Option<u64>,
}

impl KeyValueSetTtlToolRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_key_value_target(&self.profile_id, &self.key)?;
        match (&self.mode, self.ttl_seconds) {
            (RedisSetKeyTtlMode::Expire, Some(seconds)) => validate_ttl_seconds(seconds),
            (RedisSetKeyTtlMode::Expire, None) => {
                Err("key_value.set_ttl mode=expire requires ttlSeconds")
            }
            (RedisSetKeyTtlMode::Persist, Some(_)) => {
                Err("key_value.set_ttl ttlSeconds is only valid for mode=expire")
            }
            (RedisSetKeyTtlMode::Persist, None) => Ok(()),
        }
    }

    pub fn mutation_request(&self, expected_fingerprint: String) -> RedisSetKeyTtlRequest {
        RedisSetKeyTtlRequest {
            db_index: self.db_index,
            key: self.key.clone(),
            expected_fingerprint,
            mode: self.mode.clone(),
            ttl_seconds: self.ttl_seconds,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyValueDeleteToolRequest {
    pub profile_id: String,
    pub db_index: u8,
    pub key: String,
}

impl KeyValueDeleteToolRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_key_value_target(&self.profile_id, &self.key)
    }

    pub fn mutation_request(&self, expected_fingerprint: String) -> RedisDeleteKeyRequest {
        RedisDeleteKeyRequest {
            db_index: self.db_index,
            key: self.key.clone(),
            expected_fingerprint,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyValueMutationToolResponse {
    pub db_index: u8,
    pub key: String,
    pub value_type: String,
    pub ttl: i64,
    #[serde(serialize_with = "serialize_json_safe_option_u64")]
    pub size: Option<u64>,
    pub mutation_state: &'static str,
}

impl From<RedisKeyMutationResult> for KeyValueMutationToolResponse {
    fn from(value: RedisKeyMutationResult) -> Self {
        Self {
            db_index: value.db_index,
            key: value.key,
            value_type: value.value_type,
            ttl: value.ttl,
            size: value.size,
            mutation_state: "completed",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyValueDeleteToolResponse {
    pub db_index: u8,
    pub key: String,
    pub deleted_count: u64,
    pub mutation_state: &'static str,
}

fn default_key_value_ttl_policy() -> RedisTtlPolicy {
    RedisTtlPolicy::Keep
}

fn validate_key_value_target(profile_id: &str, key: &str) -> Result<(), &'static str> {
    if profile_id.trim().is_empty() {
        return Err("key_value mutation profileId must not be empty");
    }
    validate_key(key)
}

fn validate_key(key: &str) -> Result<(), &'static str> {
    if key.is_empty() || key.chars().count() > KEY_VALUE_MAX_KEY_CHARS {
        return Err("key_value mutation key length is invalid");
    }
    Ok(())
}

fn validate_optional_ttl_seconds(ttl_seconds: Option<u64>) -> Result<(), &'static str> {
    ttl_seconds.map_or(Ok(()), validate_ttl_seconds)
}

fn validate_ttl_seconds(ttl_seconds: u64) -> Result<(), &'static str> {
    if !(1..=KEY_VALUE_MAX_TTL_SECONDS).contains(&ttl_seconds) {
        return Err("key_value mutation ttlSeconds is out of range");
    }
    Ok(())
}

fn validate_key_value_editable_value(value: &RedisEditableValue) -> Result<(), &'static str> {
    match value {
        RedisEditableValue::String(text) => validate_value_text(text),
        RedisEditableValue::Json(text) => {
            validate_value_text(text)?;
            serde_json::from_str::<Value>(text)
                .map(|_| ())
                .map_err(|_| "key_value mutation JSON value is invalid")
        }
        RedisEditableValue::Hash(entries) => {
            validate_collection_len(entries.len())?;
            entries.iter().try_for_each(|entry| {
                validate_collection_text(&entry.field)?;
                validate_collection_text(&entry.value)
            })
        }
        RedisEditableValue::List(items) | RedisEditableValue::Set(items) => {
            validate_collection_len(items.len())?;
            items
                .iter()
                .try_for_each(|item| validate_collection_text(item))
        }
        RedisEditableValue::SortedSet(entries) => {
            validate_collection_len(entries.len())?;
            entries.iter().try_for_each(|entry| {
                validate_collection_text(&entry.member)?;
                if !entry.score.is_finite() {
                    return Err("key_value mutation sorted-set score must be finite");
                }
                Ok(())
            })
        }
        RedisEditableValue::Stream(entries) => {
            validate_collection_len(entries.len())?;
            entries.iter().try_for_each(|entry| {
                if entry.id.is_empty() || entry.id.chars().count() > KEY_VALUE_MAX_STREAM_ID_CHARS {
                    return Err("key_value mutation stream id length is invalid");
                }
                if entry.fields.is_empty() || entry.fields.len() > KEY_VALUE_MAX_STREAM_FIELDS {
                    return Err("key_value mutation stream field count is invalid");
                }
                entry.fields.iter().try_for_each(|field| {
                    validate_collection_text(&field.field)?;
                    validate_collection_text(&field.value)
                })
            })
        }
    }
}

fn validate_value_text(value: &str) -> Result<(), &'static str> {
    if value.chars().count() > KEY_VALUE_MAX_VALUE_CHARS {
        return Err("key_value mutation value is too large");
    }
    Ok(())
}

fn validate_collection_len(len: usize) -> Result<(), &'static str> {
    if len == 0 || len > KEY_VALUE_MAX_COLLECTION_ITEMS {
        return Err("key_value mutation collection size is invalid");
    }
    Ok(())
}

fn validate_collection_text(value: &str) -> Result<(), &'static str> {
    if value.chars().count() > KEY_VALUE_MAX_COLLECTION_TEXT_CHARS {
        return Err("key_value mutation collection text is too large");
    }
    Ok(())
}

fn default_table_query_page() -> u32 {
    1
}

fn default_table_query_page_size() -> u32 {
    TABLE_QUERY_DEFAULT_PAGE_SIZE
}

fn deserialize_table_query_page<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let page = u32::deserialize(deserializer)?;
    if page == 0 {
        return Err(serde::de::Error::custom(
            "table.query page must be greater than zero",
        ));
    }
    Ok(page)
}

fn deserialize_table_query_page_size<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let page_size = u32::deserialize(deserializer)?;
    if !(1..=TABLE_QUERY_MAX_PAGE_SIZE).contains(&page_size) {
        return Err(serde::de::Error::custom(format!(
            "table.query pageSize must be between 1 and {TABLE_QUERY_MAX_PAGE_SIZE}"
        )));
    }
    Ok(page_size)
}

fn serialize_json_safe_u64<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    if *value <= 9_007_199_254_740_991 {
        serializer.serialize_u64(*value)
    } else {
        serializer.serialize_str(&value.to_string())
    }
}

fn serialize_json_safe_option_u64<S>(value: &Option<u64>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    match value {
        None => serializer.serialize_none(),
        Some(value) if *value <= 9_007_199_254_740_991 => serializer.serialize_some(value),
        Some(value) => serializer.serialize_some(&value.to_string()),
    }
}

fn default_key_value_scan_pattern() -> String {
    "*".to_string()
}

fn default_key_value_scan_cursor() -> u64 {
    0
}

fn default_key_value_scan_count() -> u32 {
    KEY_VALUE_SCAN_DEFAULT_COUNT
}

#[derive(Deserialize)]
#[serde(untagged)]
enum JsonSafeUnsignedInteger {
    Number(u64),
    String(String),
}

fn deserialize_json_safe_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    match JsonSafeUnsignedInteger::deserialize(deserializer)? {
        JsonSafeUnsignedInteger::Number(value) => Ok(value),
        JsonSafeUnsignedInteger::String(value) => {
            value.parse::<u64>().map_err(serde::de::Error::custom)
        }
    }
}

fn deserialize_key_value_scan_count<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let count = u32::deserialize(deserializer)?;
    if !(1..=KEY_VALUE_SCAN_MAX_COUNT).contains(&count) {
        return Err(serde::de::Error::custom(format!(
            "key_value.scan count must be between 1 and {KEY_VALUE_SCAN_MAX_COUNT}"
        )));
    }
    Ok(count)
}

fn default_metadata_limit() -> u64 {
    METADATA_DEFAULT_LIMIT
}

fn deserialize_metadata_limit<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let limit = u64::deserialize(deserializer)?;
    if !(1..=METADATA_MAX_LIMIT).contains(&limit) {
        return Err(serde::de::Error::custom(format!(
            "metadata limit must be between 1 and {METADATA_MAX_LIMIT}"
        )));
    }
    Ok(limit)
}

fn object_field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object()?.get(key).filter(|item| item.is_object())
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.as_object()?.get(key)?.as_str().map(str::to_string)
}

fn unsigned_field(value: &Value, key: &str) -> Option<u64> {
    value.as_object()?.get(key)?.as_u64()
}

fn bool_field(value: &Value, key: &str) -> Option<bool> {
    value.as_object()?.get(key)?.as_bool()
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::{
        AiConnectionSettings, ConnectionDetail, ConnectionGetRequest, ConnectionListItem,
        ConnectionOpenRequest, KeyValueDeleteToolRequest, KeyValueGetRequest, KeyValueGetResponse,
        KeyValueScanRequest, KeyValueScanResponse, KeyValueSetToolRequest,
        KeyValueSetTtlToolRequest, MetadataDescribeTableRequest, MetadataListChildrenRequest,
        TableQueryRequest, KEY_VALUE_SCAN_DEFAULT_COUNT, METADATA_DEFAULT_LIMIT,
        TABLE_QUERY_DEFAULT_PAGE_SIZE,
    };
    use crate::engine::types::{
        RedisHashEntry, RedisKeyInfo, RedisKeyValue, RedisScanResult, RedisValue,
    };
    use crate::repository::connection_repository::{
        ConnectionDriver, ConnectionRecordStatus, StoredConnectionRecord,
    };

    fn record(payload: Value) -> StoredConnectionRecord {
        StoredConnectionRecord {
            id: "profile-1".to_string(),
            name: "Primary".to_string(),
            driver: ConnectionDriver::Mysql,
            environment: "development".to_string(),
            color: Some("#123456".to_string()),
            tag_label: "核心".to_string(),
            tag_color: Some("violet".to_string()),
            payload,
            folder_id: Some("folder-1".to_string()),
            created_at: 10,
            updated_at: 20,
            last_connected_at: Some(30),
            last_connection_status: Some(ConnectionRecordStatus::Connected),
            last_connection_error: Some(
                "password=last-error-secret token=last-error-token".to_string(),
            ),
            sort_order: Some(4),
        }
    }

    #[test]
    fn projects_only_allowlisted_connection_fields() {
        let record = record(json!({
            "host": "10.0.0.8",
            "port": 3306,
            "username": "developer",
            "password": "database-password-sentinel",
            "apiKey": "api-key-sentinel",
            "token": "token-sentinel",
            "privateKey": "private-key-sentinel",
            "connectTimeoutSeconds": 15,
            "defaultDatabase": "app",
            "sslMode": "require",
            "sshTunnel": {
                "enabled": true,
                "host": "jump.example.com",
                "port": 22,
                "username": "ops",
                "authMethod": "private-key",
                "password": "ssh-password-sentinel",
                "privateKeyPath": "private-key-path-sentinel",
                "privateKeyPassphrase": "private-key-passphrase-sentinel",
                "hostVerification": "trust-on-first-use",
                "hostKeyFingerprint": "SHA256:safe-fingerprint"
            },
            "customSecret": {
                "nestedPassword": "nested-password-sentinel"
            }
        }));

        let list_value = serde_json::to_value(ConnectionListItem::from_record(&record, true))
            .expect("list DTO should serialize");
        let detail_value = serde_json::to_value(ConnectionDetail::from_record(&record, None))
            .expect("detail DTO should serialize");
        let serialized = format!("{list_value}{detail_value}");

        for secret in [
            "database-password-sentinel",
            "api-key-sentinel",
            "token-sentinel",
            "private-key-sentinel",
            "ssh-password-sentinel",
            "private-key-path-sentinel",
            "private-key-passphrase-sentinel",
            "nested-password-sentinel",
            "last-error-secret",
            "last-error-token",
        ] {
            assert!(!serialized.contains(secret), "leaked secret: {secret}");
        }
        assert_eq!(list_value["location"]["host"], "10.0.0.8");
        assert_eq!(list_value["location"]["port"], 3306);
        assert_eq!(detail_value["settings"]["username"], "developer");
        assert_eq!(
            detail_value["settings"]["sshTunnel"]["hostKeyFingerprint"],
            "SHA256:safe-fingerprint"
        );
        assert_eq!(detail_value["color"], "#123456");
        assert_eq!(detail_value["folderId"], "folder-1");
        assert_eq!(detail_value["sortOrder"], 4);
    }

    #[test]
    fn request_contracts_reject_unknown_fields_and_apply_pagination_defaults() {
        assert!(serde_json::from_value::<ConnectionGetRequest>(
            json!({ "profileId": "profile-1", "extra": true })
        )
        .is_err());
        assert!(serde_json::from_value::<ConnectionOpenRequest>(
            json!({ "profileId": "profile-1", "password": "secret" })
        )
        .is_err());

        let request = serde_json::from_value::<MetadataListChildrenRequest>(
            json!({ "profileId": "profile-1" }),
        )
        .expect("metadata request should parse");
        assert_eq!(request.offset, 0);
        assert_eq!(request.limit, METADATA_DEFAULT_LIMIT);
        assert!(serde_json::from_value::<MetadataListChildrenRequest>(
            json!({ "profileId": "profile-1", "limit": 201 })
        )
        .is_err());
        assert!(
            serde_json::from_value::<MetadataDescribeTableRequest>(json!({
                "profileId": "profile-1",
                "container": {
                    "kind": "view",
                    "groupType": null,
                    "database": "app",
                    "schema": "public",
                    "table": "active_users",
                    "column": null,
                    "objectName": null,
                    "dbIndex": null,
                    "key": null,
                    "pattern": null
                }
            }))
            .is_err()
        );

        let table_query = serde_json::from_value::<TableQueryRequest>(json!({
            "profileId": "profile-1",
            "source": {
                "kind": "table",
                "database": "app",
                "table": "users"
            },
            "filters": [{
                "column": "active",
                "operator": "eq",
                "value": true
            }]
        }))
        .expect("semantic table query should parse");
        assert_eq!(table_query.page, 1);
        assert_eq!(table_query.page_size, TABLE_QUERY_DEFAULT_PAGE_SIZE);
        assert!(table_query.validate().is_ok());
        assert!(serde_json::from_value::<TableQueryRequest>(json!({
            "profileId": "profile-1",
            "source": {
                "kind": "table",
                "database": "app",
                "table": "users"
            },
            "page": 0
        }))
        .is_err());
        assert!(serde_json::from_value::<TableQueryRequest>(json!({
            "profileId": "profile-1",
            "source": {
                "kind": "table",
                "database": "app",
                "table": "users"
            },
            "sql": "SELECT * FROM users"
        }))
        .is_err());

        let scan = serde_json::from_value::<KeyValueScanRequest>(json!({
            "profileId": "redis-profile",
            "dbIndex": 2
        }))
        .expect("key scan request should parse");
        assert_eq!(scan.pattern, "*");
        assert_eq!(scan.cursor, 0);
        assert_eq!(scan.count, KEY_VALUE_SCAN_DEFAULT_COUNT);
        assert!(scan.validate().is_ok());
        let large_cursor = serde_json::from_value::<KeyValueScanRequest>(json!({
            "profileId": "redis-profile",
            "dbIndex": 2,
            "cursor": "18446744073709551615"
        }))
        .expect("u64 cursor string should parse");
        assert_eq!(large_cursor.cursor, u64::MAX);
        assert!(serde_json::from_value::<KeyValueScanRequest>(json!({
            "profileId": "redis-profile",
            "dbIndex": 2,
            "count": 501
        }))
        .is_err());
        assert!(serde_json::from_value::<KeyValueGetRequest>(json!({
            "profileId": "redis-profile",
            "dbIndex": 0,
            "key": "session:1",
            "command": "DEL session:1"
        }))
        .is_err());
    }

    #[test]
    fn key_value_responses_are_compact_and_json_safe() {
        let scan_request = serde_json::from_value::<KeyValueScanRequest>(json!({
            "profileId": "redis-profile",
            "dbIndex": 2,
            "pattern": "user:*",
            "cursor": "7",
            "count": 100
        }))
        .expect("key scan request should parse");
        let scan = serde_json::to_value(KeyValueScanResponse::new(
            scan_request,
            RedisScanResult {
                cursor: u64::MAX,
                keys: vec![RedisKeyInfo {
                    key: "user:1".to_string(),
                    value_type: "key".to_string(),
                    ttl: -1,
                    size: None,
                }],
            },
        ))
        .expect("key scan response should serialize");
        assert_eq!(scan["nextCursor"], u64::MAX.to_string());
        assert_eq!(scan["done"], false);
        assert_eq!(scan["keys"], json!(["user:1"]));
        assert!(!scan.to_string().contains("valueType"));

        let value = serde_json::to_value(KeyValueGetResponse::from(RedisKeyValue {
            key: "session:1".to_string(),
            value_type: "hash".to_string(),
            ttl: 300,
            size: Some(u64::MAX),
            fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
                .to_string(),
            value: RedisValue::Hash(vec![RedisHashEntry {
                field: "userId".to_string(),
                value: "42".to_string(),
            }]),
        }))
        .expect("key value response should serialize");
        assert_eq!(value["size"], u64::MAX.to_string());
        assert_eq!(value["value"]["kind"], "hash");
        assert_eq!(value["value"]["value"][0]["field"], "userId");
        assert!(value.get("fingerprint").is_none());
    }

    #[test]
    fn key_value_mutation_model_contract_rejects_internal_and_unbounded_fields() {
        let set = serde_json::from_value::<KeyValueSetToolRequest>(json!({
            "profileId": "redis-profile",
            "dbIndex": 0,
            "key": "session:1",
            "value": { "kind": "string", "value": "active" }
        }))
        .expect("bounded set request should parse");
        assert!(set.validate().is_ok());

        assert!(serde_json::from_value::<KeyValueSetToolRequest>(json!({
            "profileId": "redis-profile",
            "dbIndex": 0,
            "key": "session:1",
            "value": { "kind": "string", "value": "active" },
            "expectedFingerprint": format!("sha256:{}", "0".repeat(64))
        }))
        .is_err());
        assert!(serde_json::from_value::<KeyValueDeleteToolRequest>(json!({
            "profileId": "redis-profile",
            "dbIndex": 0,
            "key": "session:1",
            "planId": "client-plan"
        }))
        .is_err());

        let invalid_ttl = serde_json::from_value::<KeyValueSetTtlToolRequest>(json!({
            "profileId": "redis-profile",
            "dbIndex": 0,
            "key": "session:1",
            "mode": "persist",
            "ttlSeconds": 60
        }))
        .expect("shape should parse before semantic validation");
        assert!(invalid_ttl.validate().is_err());
    }

    #[test]
    fn settings_projection_does_not_copy_unknown_nested_objects() {
        let settings = AiConnectionSettings::from_payload(&json!({
            "mode": "network",
            "networkConfig": {
                "host": "db.example.com",
                "password": "network-secret",
                "sshTunnel": {
                    "host": "jump.example.com",
                    "privateKeyPassphrase": "tunnel-secret"
                }
            },
            "localConfig": {
                "dbFilePath": "C:\\data\\app.sqlite",
                "password": "local-secret"
            }
        }));
        let serialized = serde_json::to_string(&settings).expect("settings should serialize");

        assert!(serialized.contains("db.example.com"));
        assert!(serialized.contains("C:\\\\data\\\\app.sqlite"));
        assert!(!serialized.contains("network-secret"));
        assert!(!serialized.contains("tunnel-secret"));
        assert!(!serialized.contains("local-secret"));
    }
}
