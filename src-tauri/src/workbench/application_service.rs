use crate::db::DatabaseState;
use crate::engine::manager::{ConnectionRuntimeManager, SharedManagedSqlExecution};
use crate::engine::types::{
    ConnectionRuntimeInfo, ConnectionRuntimeSnapshot, ContainerRef, DataContainer, QueryResult,
    RedisCreateKeyValueRequest, RedisDeleteKeyRequest, RedisDeleteKeyResult,
    RedisKeyMutationResult, RedisKeyPrecondition, RedisKeyRef, RedisKeyValue,
    RedisRenameKeyRequest, RedisScanRequest, RedisScanResult, RedisSetKeyTtlRequest,
    RedisSetKeyValueRequest, SqlExecutionContext, SqlStatementClass, StartSqlExecutionRequest,
    TableBrowseQuery, TablePageStats, TableSchema,
};
use crate::error::{AppResult, IpcError, IpcResult};
use crate::repository::connection_repository::{ConnectionRepository, StoredConnectionRecord};
use crate::workbench::runtime_events::{
    ConnectionRuntimeChanged, RuntimeChangeOrigin, WorkbenchRuntimeEventSink,
};

pub async fn list_connections(database: &DatabaseState) -> AppResult<Vec<StoredConnectionRecord>> {
    ConnectionRepository::list(&database.pool).await
}

pub async fn get_connection(
    database: &DatabaseState,
    profile_id: &str,
) -> AppResult<Option<StoredConnectionRecord>> {
    ConnectionRepository::get(&database.pool, profile_id).await
}

pub struct OpenConnectionResult {
    pub profile: StoredConnectionRecord,
    pub snapshot: ConnectionRuntimeSnapshot,
    pub was_already_open: bool,
}

pub async fn connect_profile(
    database: &DatabaseState,
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
    origin: RuntimeChangeOrigin,
    event_sink: &dyn WorkbenchRuntimeEventSink,
) -> IpcResult<ConnectionRuntimeInfo> {
    let profile = require_connection(database, profile_id).await?;
    connect_stored_profile(runtime_manager, profile_id, &profile, origin, event_sink).await
}

pub async fn open_connection(
    database: &DatabaseState,
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
    origin: RuntimeChangeOrigin,
    event_sink: &dyn WorkbenchRuntimeEventSink,
) -> IpcResult<OpenConnectionResult> {
    let profile = require_connection(database, profile_id).await?;
    match runtime_manager.runtime_snapshot(profile_id) {
        Ok(snapshot) => {
            publish_current_runtime(runtime_manager, profile_id, origin, event_sink);
            Ok(OpenConnectionResult {
                profile,
                snapshot,
                was_already_open: true,
            })
        }
        Err(error) if error.code == crate::error::ErrorCode::ResourceNotFound => {
            connect_stored_profile(runtime_manager, profile_id, &profile, origin, event_sink)
                .await?;
            Ok(OpenConnectionResult {
                profile,
                snapshot: runtime_manager.runtime_snapshot(profile_id)?,
                was_already_open: false,
            })
        }
        Err(error) => Err(error),
    }
}

pub async fn disconnect_profile(
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
    origin: RuntimeChangeOrigin,
    event_sink: &dyn WorkbenchRuntimeEventSink,
) -> IpcResult<()> {
    let result = runtime_manager.disconnect_profile(profile_id).await;
    publish_current_runtime(runtime_manager, profile_id, origin, event_sink);
    result
}

pub async fn test_connection(
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
    origin: RuntimeChangeOrigin,
    event_sink: &dyn WorkbenchRuntimeEventSink,
) -> IpcResult<crate::engine::types::PingResult> {
    let result = runtime_manager.ping(profile_id).await;
    publish_current_runtime(runtime_manager, profile_id, origin, event_sink);
    result
}

pub async fn list_metadata_children(
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
    parent: Option<ContainerRef>,
) -> IpcResult<Vec<DataContainer>> {
    runtime_manager.list_containers(profile_id, parent).await
}

pub async fn describe_table(
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
    container: &ContainerRef,
) -> IpcResult<TableSchema> {
    runtime_manager.describe_table(profile_id, container).await
}

pub struct TableQueryResult {
    pub result: QueryResult,
    pub stats: TablePageStats,
}

pub async fn query_table(
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
    container: &ContainerRef,
    page: u32,
    page_size: u32,
    query: &TableBrowseQuery,
) -> IpcResult<TableQueryResult> {
    let stats = runtime_manager
        .get_table_page_stats(profile_id, None, container, page_size, query, Some(page))
        .await?;
    let result = runtime_manager
        .browse_table_data(profile_id, None, container, page, page_size, query)
        .await?;
    Ok(TableQueryResult { result, stats })
}

pub async fn execute_shared_sql(
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
    context: &SqlExecutionContext,
    sql: &str,
    page_size: u32,
) -> IpcResult<QueryResult> {
    runtime_manager
        .execute_shared_sql(profile_id, context, sql, 1, page_size)
        .await
}

pub async fn execute_shared_managed_sql(
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
    request: StartSqlExecutionRequest,
    statement_class: SqlStatementClass,
) -> IpcResult<SharedManagedSqlExecution> {
    runtime_manager
        .execute_shared_managed_sql(profile_id, request, statement_class)
        .await
}

pub async fn scan_key_values(
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
    request: &RedisScanRequest,
) -> IpcResult<RedisScanResult> {
    runtime_manager.scan_key_values(profile_id, request).await
}

pub async fn get_key_value(
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
    key_ref: &RedisKeyRef,
) -> IpcResult<RedisKeyValue> {
    runtime_manager.get_key_value(profile_id, key_ref).await
}

pub async fn get_key_precondition(
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
    key_ref: &RedisKeyRef,
) -> IpcResult<RedisKeyPrecondition> {
    runtime_manager
        .get_key_precondition(profile_id, key_ref)
        .await
}

pub async fn set_key_value(
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
    request: &RedisSetKeyValueRequest,
) -> IpcResult<RedisKeyMutationResult> {
    runtime_manager.set_key_value(profile_id, request).await
}

pub async fn create_key_value(
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
    request: &RedisCreateKeyValueRequest,
) -> IpcResult<RedisKeyMutationResult> {
    runtime_manager.create_key_value(profile_id, request).await
}

pub async fn delete_key(
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
    request: &RedisDeleteKeyRequest,
) -> IpcResult<RedisDeleteKeyResult> {
    runtime_manager.delete_key(profile_id, request).await
}

pub async fn rename_key(
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
    request: &RedisRenameKeyRequest,
) -> IpcResult<RedisKeyMutationResult> {
    runtime_manager.rename_key(profile_id, request).await
}

pub async fn set_key_ttl(
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
    request: &RedisSetKeyTtlRequest,
) -> IpcResult<RedisKeyMutationResult> {
    runtime_manager.set_key_ttl(profile_id, request).await
}

pub async fn require_connection(
    database: &DatabaseState,
    profile_id: &str,
) -> IpcResult<StoredConnectionRecord> {
    get_connection(database, profile_id)
        .await
        .map_err(|error| {
            IpcError::system_internal(
                "Failed to load connection profile from local storage",
                error.to_string(),
            )
        })?
        .ok_or_else(|| {
            IpcError::resource_not_found(format!("Connection profile '{profile_id}' not found"))
        })
}

async fn connect_stored_profile(
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
    profile: &StoredConnectionRecord,
    origin: RuntimeChangeOrigin,
    event_sink: &dyn WorkbenchRuntimeEventSink,
) -> IpcResult<ConnectionRuntimeInfo> {
    let result = runtime_manager.connect_profile(profile_id, profile).await;
    publish_current_runtime(runtime_manager, profile_id, origin, event_sink);
    result
}

fn publish_current_runtime(
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
    origin: RuntimeChangeOrigin,
    event_sink: &dyn WorkbenchRuntimeEventSink,
) {
    let event = match runtime_manager.runtime_snapshot(profile_id) {
        Ok(snapshot) => ConnectionRuntimeChanged::Upsert { origin, snapshot },
        Err(error) if error.code == crate::error::ErrorCode::ResourceNotFound => {
            ConnectionRuntimeChanged::Removed {
                origin,
                profile_id: profile_id.to_string(),
            }
        }
        Err(error) => {
            tauri_plugin_log::log::warn!(
                "Workbench runtime snapshot unavailable after state change: profile_id={}, code={:?}",
                profile_id,
                error.code
            );
            return;
        }
    };
    if let Err(error) = event_sink.publish(event) {
        tauri_plugin_log::log::warn!(
            "Workbench runtime event delivery failed: profile_id={}, error={}",
            profile_id,
            error
        );
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::{get_connection, list_connections, require_connection};
    use crate::db::DatabaseState;
    use crate::error::ErrorCode;
    use crate::repository::connection_repository::{
        ConnectionDriver, ConnectionRepository, CreateConnectionInput,
    };

    async fn test_database() -> DatabaseState {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite memory options should parse")
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("test sqlite pool should open");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("runtime migrations should apply");
        DatabaseState { pool }
    }

    #[tokio::test]
    async fn connection_reads_share_the_repository_state() {
        let database = test_database().await;
        ConnectionRepository::create(
            &database.pool,
            CreateConnectionInput {
                id: "profile-1".to_string(),
                name: "Primary".to_string(),
                driver: ConnectionDriver::Mysql,
                environment: "development".to_string(),
                color: None,
                tag_label: String::new(),
                tag_color: None,
                payload: json!({ "host": "127.0.0.1", "password": "secret" }),
                folder_id: None,
                sort_order: None,
            },
        )
        .await
        .expect("connection should be created");

        let listed = list_connections(&database)
            .await
            .expect("connections should list");
        let found = get_connection(&database, "profile-1")
            .await
            .expect("connection should load")
            .expect("connection should exist");

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, found.id);
        assert_eq!(found.name, "Primary");
    }

    #[tokio::test]
    async fn required_connection_maps_missing_profiles_to_engine_error() {
        let database = test_database().await;
        let error = require_connection(&database, "missing")
            .await
            .expect_err("missing profile should fail");

        assert_eq!(error.code, ErrorCode::ResourceNotFound);
        assert_eq!(error.message, "Connection profile 'missing' not found");
    }
}
