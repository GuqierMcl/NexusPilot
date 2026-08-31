use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use tauri::{ipc::Channel, AppHandle, State};

use crate::db::DatabaseState;
use crate::engine::diagnostics;
use crate::engine::drivers::clickhouse::build_endpoint as build_clickhouse_endpoint;
use crate::engine::drivers::clickhouse::schema::{
    ClickHouseAlterTableTarget, ClickHouseColumnActionResult, ClickHouseCreateDatabaseResult,
    ClickHouseCreateDatabaseTarget, ClickHouseCreateTableResult, ClickHouseCreateTableTarget,
    ClickHouseDropDatabaseResult, ClickHouseDropDatabaseTarget, ClickHouseDropTableResult,
    ClickHouseDropTableTarget, ClickHouseExecuteCreateDatabaseRequest,
    ClickHouseExecuteCreateTableRequest, ClickHouseProjectionChangeResult,
    ClickHouseSkippingIndexChangeResult, ClickHouseTableAlterResult, ClickHouseTableSchema,
    ClickHouseViewChangeResult, ClickHouseViewChangeTarget, ClickHouseViewCreateResult,
    ClickHouseViewCreateTarget, ClickHouseViewRuntimeSupport, ClickHouseViewSchema,
    ClickHouseViewScope, ClickHouseViewScopeTarget,
};
use crate::engine::manager::ConnectionRuntimeManager;
use crate::engine::native_schema::{
    NativeSchemaChangePlan, NativeSchemaChangeResult, NativeSchemaChangeTarget,
    NativeSchemaCreateResult, NativeSchemaCreateTarget, NativeSchemaDescribeRequest,
    NativeSchemaDocument, NativeSchemaExecuteChangeRequest, NativeSchemaExecuteCreateRequest,
    NativeSchemaMutationPreview, NativeSchemaSessionDocuments, NativeSchemaSessionListRequest,
    NativeSchemaSupportDocument, NativeSchemaSupportRequest,
};
use crate::engine::profiles::{driver_profile_from_record, DriverProfile, SshTunnelProfile};
use crate::engine::registry::DriverRegistry;
use crate::engine::sql_execution::SqlExecutionEventSink;
use crate::engine::types::{
    ConnectionRuntimeInfo, ConnectionTestResult, ContainerRef, CreateDatabaseInput,
    CreateDatabaseResult, CreateTableInput, CreateTableResult, DataContainer, DatabaseCharacterSet,
    DropDatabaseInput, DropDatabaseResult, DropTableInput, DropTableResult, PingResult,
    QueryResult, RedisCreateKeyValueRequest, RedisDeleteKeyPrefixRequest, RedisDeleteKeyRequest,
    RedisDeleteKeyResult, RedisKeyMutationResult, RedisKeyRef, RedisKeyTreeRequest,
    RedisKeyTreeResult, RedisKeyValue, RedisRenameKeyRequest, RedisScanRequest, RedisScanResult,
    RedisSetKeyTtlRequest, RedisSetKeyValueRequest, RuntimeHealthSnapshot, SchemaMutationPreview,
    SqlExecutionContext, SqlExecutionEvent, SqlExecutionHandle, SqlExecutionSnapshot,
    StartSqlExecutionRequest, TableBrowseQuery, TableCellChange, TableChangeSetCommitResult,
    TableChangeSetPreview, TableChangeSetRequest, TableMutationResult, TablePageStats, TableRowKey,
    TableSchema, TableTransactionState, UpdateDatabaseInput, UpdateDatabaseResult,
    UpdateTableInput, UpdateTableResult,
};
use crate::error::{IpcError, IpcResult};
use crate::repository::connection_repository::{ConnectionDriver, StoredConnectionRecord};
use crate::workbench::application_service;
use crate::workbench::runtime_events::{RuntimeChangeOrigin, TauriWorkbenchRuntimeEventSink};

struct TauriSqlExecutionEventSink {
    channel: Channel<SqlExecutionEvent>,
}

impl SqlExecutionEventSink for TauriSqlExecutionEventSink {
    fn publish(&self, event: SqlExecutionEvent) -> Result<(), String> {
        self.channel.send(event).map_err(|error| error.to_string())
    }
}

fn temporary_record(
    driver: ConnectionDriver,
    payload: serde_json::Value,
) -> StoredConnectionRecord {
    StoredConnectionRecord {
        id: "__connection_test__".to_string(),
        name: "Connection test".to_string(),
        driver,
        environment: "development".to_string(),
        color: None,
        note: String::new(),
        tag_label: String::new(),
        tag_color: None,
        payload,
        folder_id: None,
        created_at: 0,
        updated_at: 0,
        last_connected_at: None,
        last_connection_status: None,
        last_connection_error: None,
        sort_order: None,
    }
}

fn endpoint_for_profile(profile: &DriverProfile) -> String {
    match profile {
        DriverProfile::Clickhouse(profile) => {
            let database = profile
                .default_database
                .as_deref()
                .map(str::trim)
                .filter(|database| !database.is_empty())
                .unwrap_or("default");
            let endpoint = build_clickhouse_endpoint(profile.protocol, &profile.host, profile.port)
                .unwrap_or_else(|_| "invalid://clickhouse".to_string());
            endpoint_with_ssh_route(
                format!("{endpoint}/{database}"),
                profile.ssh_tunnel.as_ref(),
            )
        }
        DriverProfile::Mysql(profile) => {
            let database = profile
                .default_database
                .as_deref()
                .filter(|value| !value.trim().is_empty());
            let endpoint = match database {
                Some(database) => format!("{}:{}/{}", profile.host, profile.port, database),
                None => format!("{}:{}", profile.host, profile.port),
            };
            endpoint_with_ssh_route(endpoint, profile.ssh_tunnel.as_ref())
        }
        DriverProfile::Postgres(profile) => {
            let database = profile
                .default_database
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("postgres");
            endpoint_with_ssh_route(
                format!("{}:{}/{}", profile.host, profile.port, database),
                profile.ssh_tunnel.as_ref(),
            )
        }
        DriverProfile::Oracle(profile) => {
            if let Some(descriptor) = profile
                .connect_descriptor
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return endpoint_with_ssh_route(
                    descriptor.to_string(),
                    profile.ssh_tunnel.as_ref(),
                );
            }

            let endpoint = if let Some(service_name) = profile
                .service_name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                format!("{}:{}/{}", profile.host, profile.port, service_name)
            } else if let Some(sid) = profile
                .sid
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                format!("{}:{}:{}", profile.host, profile.port, sid)
            } else {
                format!("{}:{}", profile.host, profile.port)
            };
            endpoint_with_ssh_route(endpoint, profile.ssh_tunnel.as_ref())
        }
        DriverProfile::Redis(profile) => {
            let endpoint = match profile.db_index {
                Some(db_index) => format!("{}:{}/{}", profile.host, profile.port, db_index),
                None => format!("{}:{}", profile.host, profile.port),
            };
            endpoint_with_ssh_route(endpoint, profile.ssh_tunnel.as_ref())
        }
        DriverProfile::Sqlite(profile) => profile.db_file_path.clone(),
    }
}

fn endpoint_with_ssh_route(endpoint: String, ssh_tunnel: Option<&SshTunnelProfile>) -> String {
    if let Some(ssh) = ssh_tunnel.filter(|ssh| ssh.enabled) {
        format!("{endpoint} via SSH {}:{}", ssh.host, ssh.port)
    } else {
        endpoint
    }
}

#[tauri::command]
pub async fn connect_profile(
    profile_id: String,
    app: AppHandle,
    db_state: State<'_, DatabaseState>,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<ConnectionRuntimeInfo> {
    let events = TauriWorkbenchRuntimeEventSink::new(app);
    application_service::connect_profile(
        &db_state,
        &runtime_manager,
        &profile_id,
        RuntimeChangeOrigin::Frontend,
        &events,
    )
    .await
}

#[tauri::command]
pub async fn disconnect_profile(
    profile_id: String,
    app: AppHandle,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
    prepared_plans: State<'_, crate::ai_runtime::backend_bridge::PreparedPlanRegistry>,
) -> IpcResult<()> {
    let events = TauriWorkbenchRuntimeEventSink::new(app);
    let result = application_service::disconnect_profile(
        &runtime_manager,
        &profile_id,
        RuntimeChangeOrigin::Frontend,
        &events,
    )
    .await;
    prepared_plans.clear_profile(&profile_id);
    result
}

#[tauri::command]
pub async fn test_connection(
    profile_id: String,
    app: AppHandle,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<PingResult> {
    let events = TauriWorkbenchRuntimeEventSink::new(app);
    application_service::test_connection(
        &runtime_manager,
        &profile_id,
        RuntimeChangeOrigin::Frontend,
        &events,
    )
    .await
}

#[tauri::command]
pub fn list_connection_runtime_snapshots(
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<Vec<crate::engine::types::ConnectionRuntimeSnapshot>> {
    let snapshots = runtime_manager.runtime_snapshots()?;
    tauri_plugin_log::log::debug!(
        "Workbench runtime snapshot reconciliation requested: runtime_count={}",
        snapshots.len()
    );
    Ok(snapshots)
}

#[tauri::command]
pub fn get_connection_runtime_health(
    profile_id: String,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<RuntimeHealthSnapshot> {
    runtime_manager.health(&profile_id)
}

#[tauri::command]
pub async fn test_connection_config(
    driver: ConnectionDriver,
    payload: serde_json::Value,
) -> IpcResult<ConnectionTestResult> {
    let record = temporary_record(driver, payload);
    let profile = match driver_profile_from_record(&record) {
        Ok(profile) => profile,
        Err(error) => {
            diagnostics::log_engine_error_by_driver(
                "test_connection_config.profile",
                record.driver.as_str(),
                &record.id,
                None,
                None,
                &error,
            );
            return Err(error);
        }
    };
    let endpoint = endpoint_for_profile(&profile);
    let driver =
        match DriverRegistry::create_driver_from_profile("__connection_test__", profile).await {
            Ok(driver) => driver,
            Err(error) => {
                diagnostics::log_engine_error_by_driver(
                    "test_connection_config.connect",
                    record.driver.as_str(),
                    &record.id,
                    None,
                    None,
                    &error,
                );
                return Err(error);
            }
        };
    let ping = match driver.ping().await {
        Ok(ping) => ping,
        Err(error) => {
            diagnostics::log_engine_error(
                "test_connection_config.ping",
                &record.id,
                None,
                driver.as_ref(),
                None,
                &error,
            );
            let _ = driver.close().await;
            return Err(error);
        }
    };
    let server_version = driver.server_version().await.unwrap_or(None);
    let driver_name = driver.driver_name().to_string();
    let ssh_host_key_fingerprint = driver.ssh_host_key_fingerprint().map(str::to_string);
    if let Err(error) = driver.close().await {
        diagnostics::log_engine_error(
            "test_connection_config.close",
            &record.id,
            None,
            driver.as_ref(),
            None,
            &error,
        );
        return Err(error);
    }

    Ok(ConnectionTestResult {
        latency_ms: ping.latency_ms,
        driver_name,
        endpoint,
        server_version,
        ssh_host_key_fingerprint,
    })
}

#[tauri::command]
pub async fn get_connection_capabilities(
    profile_id: String,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<ConnectionRuntimeInfo> {
    runtime_manager.capabilities(&profile_id)
}

#[tauri::command]
pub async fn open_tab_runtime(
    profile_id: String,
    tab_id: String,
    db_state: State<'_, DatabaseState>,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<ConnectionRuntimeInfo> {
    let profile = application_service::require_connection(&db_state, &profile_id).await?;
    runtime_manager
        .open_tab_runtime(&profile_id, &tab_id, &profile)
        .await
}

#[tauri::command]
pub async fn close_tab_runtime(
    tab_id: String,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<()> {
    runtime_manager.close_tab_runtime(&tab_id).await
}

#[tauri::command]
pub async fn list_containers(
    profile_id: String,
    parent: Option<ContainerRef>,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<Vec<DataContainer>> {
    application_service::list_metadata_children(&runtime_manager, &profile_id, parent).await
}

#[tauri::command]
pub async fn describe_table(
    profile_id: String,
    container: ContainerRef,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<TableSchema> {
    application_service::describe_table(&runtime_manager, &profile_id, &container).await
}

#[tauri::command]
pub async fn describe_clickhouse_table_schema(
    profile_id: String,
    container: ContainerRef,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<ClickHouseTableSchema> {
    match runtime_manager
        .describe_native_schema(&profile_id, NativeSchemaDescribeRequest::Table(container))
        .await?
    {
        NativeSchemaDocument::ClickHouseTable(schema) => Ok(*schema),
        NativeSchemaDocument::ClickHouseView(_) => Err(IpcError::system_internal(
            "ClickHouse table Describe returned an unexpected result type",
            "operation=describe_clickhouse_table_schema; category=unexpected_native_result_variant",
        )),
    }
}

#[tauri::command]
pub async fn get_clickhouse_view_runtime_support(
    profile_id: String,
    owner_tab_runtime_id: Option<String>,
    database: Option<String>,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<ClickHouseViewRuntimeSupport> {
    match runtime_manager
        .get_native_schema_support_in_runtime(
            &profile_id,
            owner_tab_runtime_id.as_deref(),
            NativeSchemaSupportRequest::ClickHouseView {
                database,
                cluster_name: None,
            },
        )
        .await?
    {
        NativeSchemaSupportDocument::ClickHouseView(support) => Ok(support),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseViewDescribeCommandRequest {
    container: ContainerRef,
    owner_tab_runtime_id: Option<String>,
}

#[tauri::command]
pub async fn describe_clickhouse_view_schema(
    profile_id: String,
    request: ClickHouseViewDescribeCommandRequest,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<ClickHouseViewSchema> {
    validate_view_describe_owner(&request)?;
    match runtime_manager
        .describe_native_schema_in_runtime(
            &profile_id,
            request.owner_tab_runtime_id.as_deref(),
            NativeSchemaDescribeRequest::View(request.container),
        )
        .await?
    {
        NativeSchemaDocument::ClickHouseView(schema) => Ok(*schema),
        NativeSchemaDocument::ClickHouseTable(_) => Err(IpcError::system_internal(
            "ClickHouse View Describe returned an unexpected result type",
            "operation=describe_clickhouse_view_schema; category=unexpected_native_result_variant",
        )),
    }
}

#[tauri::command]
pub async fn preview_create_clickhouse_view(
    profile_id: String,
    target: ClickHouseViewCreateTarget,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<NativeSchemaMutationPreview> {
    let owner_tab_runtime_id = view_target_owner(&target.desired.scope).map(str::to_string);
    runtime_manager
        .preview_native_schema_create_in_runtime(
            &profile_id,
            owner_tab_runtime_id.as_deref(),
            NativeSchemaCreateTarget::ClickHouseView(Box::new(target)),
        )
        .await
}

#[tauri::command]
pub async fn create_clickhouse_view(
    profile_id: String,
    request: NativeSchemaExecuteCreateRequest,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<ClickHouseViewCreateResult> {
    let NativeSchemaCreateTarget::ClickHouseView(target) = &request.target else {
        return Err(IpcError::validation_failed(
            "ClickHouse View create command requires a View target",
        ));
    };
    let owner_tab_runtime_id = view_target_owner(&target.desired.scope).map(str::to_string);
    match runtime_manager
        .execute_native_schema_create_in_runtime(
            &profile_id,
            owner_tab_runtime_id.as_deref(),
            request,
        )
        .await?
    {
        NativeSchemaCreateResult::ClickHouseView(result) => Ok(*result),
        NativeSchemaCreateResult::ClickHouseDatabase(_)
        | NativeSchemaCreateResult::ClickHouseTable(_) => Err(IpcError::system_internal(
            "ClickHouse View create returned an unexpected result type",
            "operation=create_clickhouse_view; category=unexpected_native_result_variant",
        )),
    }
}

#[tauri::command]
pub async fn preview_change_clickhouse_view(
    profile_id: String,
    target: ClickHouseViewChangeTarget,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<NativeSchemaChangePlan> {
    let owner_tab_runtime_id = view_change_owner(&target).map(str::to_string);
    runtime_manager
        .preview_native_schema_change_in_runtime(
            &profile_id,
            owner_tab_runtime_id.as_deref(),
            native_view_change_target(target),
        )
        .await
}

#[tauri::command]
pub async fn execute_clickhouse_view_change(
    profile_id: String,
    request: NativeSchemaExecuteChangeRequest,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<ClickHouseViewChangeResult> {
    let target = match &request.target {
        NativeSchemaChangeTarget::ClickHouseViewAlter(target) => {
            ClickHouseViewChangeTarget::Alter(target.clone())
        }
        NativeSchemaChangeTarget::ClickHouseViewRename(target) => {
            ClickHouseViewChangeTarget::Rename(target.clone())
        }
        NativeSchemaChangeTarget::ClickHouseViewDrop(target) => {
            ClickHouseViewChangeTarget::Drop(target.clone())
        }
        _ => {
            return Err(IpcError::validation_failed(
                "ClickHouse View change command requires a View target",
            ));
        }
    };
    let owner_tab_runtime_id = view_change_owner(&target).map(str::to_string);
    match runtime_manager
        .execute_native_schema_change_in_runtime(
            &profile_id,
            owner_tab_runtime_id.as_deref(),
            request,
        )
        .await?
    {
        NativeSchemaChangeResult::ClickHouseViewChange(result) => Ok(*result),
        _ => Err(unexpected_native_change_result(
            "execute_clickhouse_view_change",
        )),
    }
}

#[tauri::command]
pub async fn list_clickhouse_temporary_views(
    profile_id: String,
    owner_tab_runtime_id: String,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<Vec<ClickHouseViewSchema>> {
    if owner_tab_runtime_id.trim().is_empty() {
        return Err(IpcError::validation_failed(
            "ClickHouse Temporary View listing requires an owner tab runtime",
        ));
    }
    match runtime_manager
        .list_native_schema_session_documents(
            &profile_id,
            &owner_tab_runtime_id,
            NativeSchemaSessionListRequest::ClickHouseTemporaryViews,
        )
        .await?
    {
        NativeSchemaSessionDocuments::ClickHouseViews(schemas) => Ok(schemas),
    }
}

fn native_view_change_target(target: ClickHouseViewChangeTarget) -> NativeSchemaChangeTarget {
    match target {
        ClickHouseViewChangeTarget::Alter(target) => {
            NativeSchemaChangeTarget::ClickHouseViewAlter(target)
        }
        ClickHouseViewChangeTarget::Rename(target) => {
            NativeSchemaChangeTarget::ClickHouseViewRename(target)
        }
        ClickHouseViewChangeTarget::Drop(target) => {
            NativeSchemaChangeTarget::ClickHouseViewDrop(target)
        }
    }
}

fn view_change_owner(target: &ClickHouseViewChangeTarget) -> Option<&str> {
    let scope = match target {
        ClickHouseViewChangeTarget::Alter(target) => &target.baseline.scope,
        ClickHouseViewChangeTarget::Rename(target) => &target.baseline.scope,
        ClickHouseViewChangeTarget::Drop(target) => &target.baseline.scope,
    };
    match scope {
        ClickHouseViewScope::Temporary {
            owner_tab_runtime_id,
            ..
        } => Some(owner_tab_runtime_id),
        ClickHouseViewScope::Local | ClickHouseViewScope::Cluster { .. } => None,
    }
}

fn view_target_owner(scope: &ClickHouseViewScopeTarget) -> Option<&str> {
    match scope {
        ClickHouseViewScopeTarget::Temporary {
            owner_tab_runtime_id,
        } => Some(owner_tab_runtime_id),
        ClickHouseViewScopeTarget::Local | ClickHouseViewScopeTarget::Cluster { .. } => None,
    }
}

fn validate_view_describe_owner(request: &ClickHouseViewDescribeCommandRequest) -> IpcResult<()> {
    match (
        request.container.database.as_deref(),
        request.owner_tab_runtime_id.as_deref(),
    ) {
        (Some(database), None) if !database.trim().is_empty() => Ok(()),
        (None, Some(owner)) if !owner.trim().is_empty() => Ok(()),
        _ => Err(IpcError::validation_failed(
            "ClickHouse View Describe ownership does not match persistent or Temporary scope",
        )),
    }
}

#[tauri::command]
pub async fn preview_create_clickhouse_database(
    profile_id: String,
    target: ClickHouseCreateDatabaseTarget,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<NativeSchemaMutationPreview> {
    runtime_manager
        .preview_native_schema_create(
            &profile_id,
            NativeSchemaCreateTarget::ClickHouseDatabase(target),
        )
        .await
}

#[tauri::command]
pub async fn create_clickhouse_database(
    profile_id: String,
    request: ClickHouseExecuteCreateDatabaseRequest,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<ClickHouseCreateDatabaseResult> {
    match runtime_manager
        .execute_native_schema_create(
            &profile_id,
            NativeSchemaExecuteCreateRequest {
                target: NativeSchemaCreateTarget::ClickHouseDatabase(request.target),
                expected_plan_hash: request.expected_plan_hash,
                confirmation: request.confirmation,
                baseline: None,
            },
        )
        .await?
    {
        NativeSchemaCreateResult::ClickHouseDatabase(result) => Ok(result),
        NativeSchemaCreateResult::ClickHouseTable(_)
        | NativeSchemaCreateResult::ClickHouseView(_) => Err(IpcError::system_internal(
            "ClickHouse database create returned an unexpected result type",
            "operation=create_clickhouse_database; category=unexpected_native_result_variant",
        )),
    }
}

#[tauri::command]
pub async fn preview_create_clickhouse_table(
    profile_id: String,
    target: ClickHouseCreateTableTarget,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<NativeSchemaMutationPreview> {
    runtime_manager
        .preview_native_schema_create(
            &profile_id,
            NativeSchemaCreateTarget::ClickHouseTable(Box::new(target)),
        )
        .await
}

#[tauri::command]
pub async fn create_clickhouse_table(
    profile_id: String,
    request: ClickHouseExecuteCreateTableRequest,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<ClickHouseCreateTableResult> {
    match runtime_manager
        .execute_native_schema_create(
            &profile_id,
            NativeSchemaExecuteCreateRequest {
                target: NativeSchemaCreateTarget::ClickHouseTable(Box::new(request.target)),
                expected_plan_hash: request.expected_plan_hash,
                confirmation: request.confirmation,
                baseline: None,
            },
        )
        .await?
    {
        NativeSchemaCreateResult::ClickHouseTable(result) => Ok(*result),
        NativeSchemaCreateResult::ClickHouseDatabase(_)
        | NativeSchemaCreateResult::ClickHouseView(_) => Err(IpcError::system_internal(
            "ClickHouse table create returned an unexpected result type",
            "operation=create_clickhouse_table; category=unexpected_native_result_variant",
        )),
    }
}

#[tauri::command]
pub async fn preview_alter_clickhouse_table(
    profile_id: String,
    target: ClickHouseAlterTableTarget,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<NativeSchemaChangePlan> {
    runtime_manager
        .preview_native_schema_change(
            &profile_id,
            NativeSchemaChangeTarget::ClickHouseTableAlter(Box::new(target)),
        )
        .await
}

#[tauri::command]
pub async fn alter_clickhouse_table(
    profile_id: String,
    request: NativeSchemaExecuteChangeRequest,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<ClickHouseTableAlterResult> {
    if !matches!(
        &request.target,
        NativeSchemaChangeTarget::ClickHouseTableAlter(_)
    ) {
        return Err(IpcError::validation_failed(
            "ClickHouse table alter command requires a table alter target",
        ));
    }
    match runtime_manager
        .execute_native_schema_change(&profile_id, request)
        .await?
    {
        NativeSchemaChangeResult::ClickHouseTableAlter(result) => Ok(*result),
        _ => Err(unexpected_native_change_result("alter_clickhouse_table")),
    }
}

#[tauri::command]
pub async fn preview_clickhouse_column_action(
    profile_id: String,
    target: NativeSchemaChangeTarget,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<NativeSchemaChangePlan> {
    if !matches!(
        &target,
        NativeSchemaChangeTarget::ClickHouseColumnClear(_)
            | NativeSchemaChangeTarget::ClickHouseColumnMaterialize(_)
    ) {
        return Err(IpcError::validation_failed(
            "ClickHouse column action command requires a CLEAR or MATERIALIZE target",
        ));
    }
    runtime_manager
        .preview_native_schema_change(&profile_id, target)
        .await
}

#[tauri::command]
pub async fn execute_clickhouse_column_action(
    profile_id: String,
    request: NativeSchemaExecuteChangeRequest,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<ClickHouseColumnActionResult> {
    if !matches!(
        &request.target,
        NativeSchemaChangeTarget::ClickHouseColumnClear(_)
            | NativeSchemaChangeTarget::ClickHouseColumnMaterialize(_)
    ) {
        return Err(IpcError::validation_failed(
            "ClickHouse column action command requires a CLEAR or MATERIALIZE target",
        ));
    }
    match runtime_manager
        .execute_native_schema_change(&profile_id, request)
        .await?
    {
        NativeSchemaChangeResult::ClickHouseColumnAction(result) => Ok(*result),
        _ => Err(unexpected_native_change_result(
            "execute_clickhouse_column_action",
        )),
    }
}

#[tauri::command]
pub async fn preview_clickhouse_projection_change(
    profile_id: String,
    target: NativeSchemaChangeTarget,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<NativeSchemaChangePlan> {
    if !matches!(
        &target,
        NativeSchemaChangeTarget::ClickHouseProjectionCreate(_)
            | NativeSchemaChangeTarget::ClickHouseProjectionDrop(_)
            | NativeSchemaChangeTarget::ClickHouseProjectionMaterialize(_)
            | NativeSchemaChangeTarget::ClickHouseProjectionClear(_)
    ) {
        return Err(IpcError::validation_failed(
            "ClickHouse projection change command requires a projection target",
        ));
    }
    runtime_manager
        .preview_native_schema_change(&profile_id, target)
        .await
}

#[tauri::command]
pub async fn execute_clickhouse_projection_change(
    profile_id: String,
    request: NativeSchemaExecuteChangeRequest,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<ClickHouseProjectionChangeResult> {
    if !matches!(
        &request.target,
        NativeSchemaChangeTarget::ClickHouseProjectionCreate(_)
            | NativeSchemaChangeTarget::ClickHouseProjectionDrop(_)
            | NativeSchemaChangeTarget::ClickHouseProjectionMaterialize(_)
            | NativeSchemaChangeTarget::ClickHouseProjectionClear(_)
    ) {
        return Err(IpcError::validation_failed(
            "ClickHouse projection change command requires a projection target",
        ));
    }
    match runtime_manager
        .execute_native_schema_change(&profile_id, request)
        .await?
    {
        NativeSchemaChangeResult::ClickHouseProjectionChange(result) => Ok(*result),
        _ => Err(unexpected_native_change_result(
            "execute_clickhouse_projection_change",
        )),
    }
}

#[tauri::command]
pub async fn preview_clickhouse_skipping_index_change(
    profile_id: String,
    target: NativeSchemaChangeTarget,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<NativeSchemaChangePlan> {
    if !matches!(
        &target,
        NativeSchemaChangeTarget::ClickHouseSkippingIndexCreate(_)
            | NativeSchemaChangeTarget::ClickHouseSkippingIndexDrop(_)
            | NativeSchemaChangeTarget::ClickHouseSkippingIndexMaterialize(_)
            | NativeSchemaChangeTarget::ClickHouseSkippingIndexClear(_)
    ) {
        return Err(IpcError::validation_failed(
            "ClickHouse skipping-index change command requires a skipping-index target",
        ));
    }
    runtime_manager
        .preview_native_schema_change(&profile_id, target)
        .await
}

#[tauri::command]
pub async fn execute_clickhouse_skipping_index_change(
    profile_id: String,
    request: NativeSchemaExecuteChangeRequest,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<ClickHouseSkippingIndexChangeResult> {
    if !matches!(
        &request.target,
        NativeSchemaChangeTarget::ClickHouseSkippingIndexCreate(_)
            | NativeSchemaChangeTarget::ClickHouseSkippingIndexDrop(_)
            | NativeSchemaChangeTarget::ClickHouseSkippingIndexMaterialize(_)
            | NativeSchemaChangeTarget::ClickHouseSkippingIndexClear(_)
    ) {
        return Err(IpcError::validation_failed(
            "ClickHouse skipping-index change command requires a skipping-index target",
        ));
    }
    match runtime_manager
        .execute_native_schema_change(&profile_id, request)
        .await?
    {
        NativeSchemaChangeResult::ClickHouseSkippingIndexChange(result) => Ok(*result),
        _ => Err(unexpected_native_change_result(
            "execute_clickhouse_skipping_index_change",
        )),
    }
}

#[tauri::command]
pub async fn preview_drop_clickhouse_table(
    profile_id: String,
    target: ClickHouseDropTableTarget,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<NativeSchemaChangePlan> {
    runtime_manager
        .preview_native_schema_change(
            &profile_id,
            NativeSchemaChangeTarget::ClickHouseTableDrop(target),
        )
        .await
}

#[tauri::command]
pub async fn drop_clickhouse_table(
    profile_id: String,
    request: NativeSchemaExecuteChangeRequest,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<ClickHouseDropTableResult> {
    if !matches!(
        &request.target,
        NativeSchemaChangeTarget::ClickHouseTableDrop(_)
    ) {
        return Err(IpcError::validation_failed(
            "ClickHouse table drop command requires a table drop target",
        ));
    }
    match runtime_manager
        .execute_native_schema_change(&profile_id, request)
        .await?
    {
        NativeSchemaChangeResult::ClickHouseTableDrop(result) => Ok(result),
        _ => Err(unexpected_native_change_result("drop_clickhouse_table")),
    }
}

#[tauri::command]
pub async fn preview_drop_clickhouse_database(
    profile_id: String,
    target: ClickHouseDropDatabaseTarget,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<NativeSchemaChangePlan> {
    runtime_manager
        .preview_native_schema_change(
            &profile_id,
            NativeSchemaChangeTarget::ClickHouseDatabaseDrop(target),
        )
        .await
}

#[tauri::command]
pub async fn drop_clickhouse_database(
    profile_id: String,
    request: NativeSchemaExecuteChangeRequest,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<ClickHouseDropDatabaseResult> {
    if !matches!(
        &request.target,
        NativeSchemaChangeTarget::ClickHouseDatabaseDrop(_)
    ) {
        return Err(IpcError::validation_failed(
            "ClickHouse database drop command requires a database drop target",
        ));
    }
    match runtime_manager
        .execute_native_schema_change(&profile_id, request)
        .await?
    {
        NativeSchemaChangeResult::ClickHouseDatabaseDrop(result) => Ok(result),
        _ => Err(unexpected_native_change_result("drop_clickhouse_database")),
    }
}

fn unexpected_native_change_result(operation: &str) -> IpcError {
    IpcError::system_internal(
        "ClickHouse schema change returned an unexpected result type",
        format!("operation={operation}; category=unexpected_native_result_variant"),
    )
}

#[tauri::command]
pub async fn create_database(
    profile_id: String,
    input: CreateDatabaseInput,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<CreateDatabaseResult> {
    runtime_manager.create_database(&profile_id, &input).await
}

#[tauri::command]
pub async fn preview_create_database(
    profile_id: String,
    input: CreateDatabaseInput,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<SchemaMutationPreview> {
    runtime_manager
        .preview_create_database(&profile_id, &input)
        .await
}

#[tauri::command]
pub async fn preview_update_database(
    profile_id: String,
    input: UpdateDatabaseInput,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<SchemaMutationPreview> {
    runtime_manager
        .preview_update_database(&profile_id, &input)
        .await
}

#[tauri::command]
pub async fn update_database(
    profile_id: String,
    input: UpdateDatabaseInput,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<UpdateDatabaseResult> {
    runtime_manager.update_database(&profile_id, &input).await
}

#[tauri::command]
pub async fn preview_drop_database(
    profile_id: String,
    input: DropDatabaseInput,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<SchemaMutationPreview> {
    runtime_manager
        .preview_drop_database(&profile_id, &input)
        .await
}

#[tauri::command]
pub async fn drop_database(
    profile_id: String,
    input: DropDatabaseInput,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<DropDatabaseResult> {
    runtime_manager.drop_database(&profile_id, &input).await
}

#[tauri::command]
pub async fn list_mysql_character_sets(
    profile_id: String,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<Vec<DatabaseCharacterSet>> {
    runtime_manager.list_mysql_character_sets(&profile_id).await
}

#[tauri::command]
pub async fn get_mysql_database_character_set(
    profile_id: String,
    container: ContainerRef,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<Option<String>> {
    runtime_manager
        .get_mysql_database_character_set(&profile_id, &container)
        .await
}

#[tauri::command]
pub async fn preview_create_table(
    profile_id: String,
    input: CreateTableInput,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<SchemaMutationPreview> {
    runtime_manager
        .preview_create_table(&profile_id, &input)
        .await
}

#[tauri::command]
pub async fn create_table(
    profile_id: String,
    input: CreateTableInput,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<CreateTableResult> {
    runtime_manager.create_table(&profile_id, &input).await
}

#[tauri::command]
pub async fn preview_update_table(
    profile_id: String,
    input: UpdateTableInput,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<SchemaMutationPreview> {
    runtime_manager
        .preview_update_table(&profile_id, &input)
        .await
}

#[tauri::command]
pub async fn update_table(
    profile_id: String,
    input: UpdateTableInput,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<UpdateTableResult> {
    runtime_manager.update_table(&profile_id, &input).await
}

#[tauri::command]
pub async fn preview_drop_table(
    profile_id: String,
    input: DropTableInput,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<SchemaMutationPreview> {
    runtime_manager
        .preview_drop_table(&profile_id, &input)
        .await
}

#[tauri::command]
pub async fn drop_table(
    profile_id: String,
    input: DropTableInput,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<DropTableResult> {
    runtime_manager.drop_table(&profile_id, &input).await
}

#[tauri::command]
pub async fn browse_table_data(
    profile_id: String,
    tab_id: Option<String>,
    container: ContainerRef,
    page: u32,
    page_size: u32,
    query: Option<TableBrowseQuery>,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<QueryResult> {
    let safe_page = page.max(1);
    let safe_page_size = page_size.clamp(1, 1000);
    let query = query.unwrap_or_default();
    runtime_manager
        .browse_table_data(
            &profile_id,
            tab_id.as_deref(),
            &container,
            safe_page,
            safe_page_size,
            &query,
        )
        .await
}

#[tauri::command]
pub async fn get_table_page_stats(
    profile_id: String,
    tab_id: Option<String>,
    container: ContainerRef,
    page_size: u32,
    query: Option<TableBrowseQuery>,
    requested_page: Option<u32>,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<TablePageStats> {
    let safe_page_size = page_size.clamp(1, 1000);
    let query = query.unwrap_or_default();
    runtime_manager
        .get_table_page_stats(
            &profile_id,
            tab_id.as_deref(),
            &container,
            safe_page_size,
            &query,
            requested_page,
        )
        .await
}

#[tauri::command]
pub async fn update_table_row(
    profile_id: String,
    tab_id: Option<String>,
    container: ContainerRef,
    primary_key: TableRowKey,
    changes: Vec<TableCellChange>,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<TableMutationResult> {
    runtime_manager
        .update_table_row(
            &profile_id,
            tab_id.as_deref(),
            &container,
            &primary_key,
            &changes,
        )
        .await
}

#[tauri::command]
pub async fn delete_table_rows(
    profile_id: String,
    tab_id: Option<String>,
    container: ContainerRef,
    primary_keys: Vec<TableRowKey>,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<TableMutationResult> {
    runtime_manager
        .delete_table_rows(&profile_id, tab_id.as_deref(), &container, &primary_keys)
        .await
}

#[tauri::command]
pub async fn preview_table_change_set(
    profile_id: String,
    tab_id: Option<String>,
    container: ContainerRef,
    change_set: TableChangeSetRequest,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<TableChangeSetPreview> {
    runtime_manager
        .preview_table_change_set(&profile_id, tab_id.as_deref(), &container, &change_set)
        .await
}

#[tauri::command]
pub async fn commit_table_change_set(
    profile_id: String,
    tab_id: Option<String>,
    container: ContainerRef,
    change_set: TableChangeSetRequest,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<TableChangeSetCommitResult> {
    runtime_manager
        .commit_table_change_set(&profile_id, tab_id.as_deref(), &container, &change_set)
        .await
}

#[tauri::command]
pub async fn execute_sql(
    profile_id: String,
    tab_id: String,
    context: Option<SqlExecutionContext>,
    sql: String,
    page: u32,
    page_size: u32,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<QueryResult> {
    let safe_page = page.max(1);
    let safe_page_size = page_size.clamp(1, 1000);
    let context = context.unwrap_or_default();
    runtime_manager
        .execute_sql(
            &profile_id,
            &tab_id,
            &context,
            &sql,
            safe_page,
            safe_page_size,
        )
        .await
}

#[tauri::command]
pub async fn start_sql_execution(
    profile_id: String,
    tab_id: String,
    request: StartSqlExecutionRequest,
    on_event: Channel<SqlExecutionEvent>,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<SqlExecutionHandle> {
    runtime_manager.start_sql_execution(
        &profile_id,
        &tab_id,
        request,
        Arc::new(TauriSqlExecutionEventSink { channel: on_event }),
    )
}

#[tauri::command]
pub fn get_sql_execution_snapshot(
    profile_id: String,
    tab_id: String,
    execution_id: String,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<SqlExecutionSnapshot> {
    runtime_manager.get_sql_execution_snapshot(&profile_id, &tab_id, &execution_id)
}

#[tauri::command]
pub async fn cancel_sql_execution(
    profile_id: String,
    tab_id: String,
    execution_id: String,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<SqlExecutionSnapshot> {
    runtime_manager
        .cancel_sql_execution(&profile_id, &tab_id, &execution_id)
        .await
}

#[tauri::command]
pub fn release_sql_execution(
    profile_id: String,
    tab_id: String,
    execution_id: String,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<()> {
    runtime_manager.release_sql_execution(&profile_id, &tab_id, &execution_id)
}

#[tauri::command]
pub async fn save_sql_execution_artifact(
    profile_id: String,
    tab_id: String,
    execution_id: String,
    artifact_id: String,
    destination_path: String,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<()> {
    runtime_manager
        .save_sql_execution_artifact(
            &profile_id,
            &tab_id,
            &execution_id,
            &artifact_id,
            PathBuf::from(destination_path),
        )
        .await
}

#[tauri::command]
pub async fn begin_tab_transaction(
    profile_id: String,
    tab_id: String,
    container: ContainerRef,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<TableTransactionState> {
    runtime_manager
        .begin_tab_transaction(&profile_id, &tab_id, &container)
        .await
}

#[tauri::command]
pub async fn commit_tab_transaction(
    profile_id: String,
    tab_id: String,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<TableTransactionState> {
    runtime_manager
        .commit_tab_transaction(&profile_id, &tab_id)
        .await
}

#[tauri::command]
pub async fn rollback_tab_transaction(
    profile_id: String,
    tab_id: String,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<TableTransactionState> {
    runtime_manager
        .rollback_tab_transaction(&profile_id, &tab_id)
        .await
}

#[tauri::command]
pub async fn get_tab_transaction_state(
    profile_id: String,
    tab_id: String,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<TableTransactionState> {
    runtime_manager
        .get_tab_transaction_state(&profile_id, &tab_id)
        .await
}

#[tauri::command]
pub async fn scan_key_values(
    profile_id: String,
    request: RedisScanRequest,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<RedisScanResult> {
    application_service::scan_key_values(&runtime_manager, &profile_id, &request).await
}

#[tauri::command]
pub async fn browse_key_tree(
    profile_id: String,
    request: RedisKeyTreeRequest,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<RedisKeyTreeResult> {
    runtime_manager.browse_key_tree(&profile_id, &request).await
}

#[tauri::command]
pub async fn get_key_value(
    profile_id: String,
    key_ref: RedisKeyRef,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<RedisKeyValue> {
    application_service::get_key_value(&runtime_manager, &profile_id, &key_ref).await
}

#[tauri::command]
pub async fn set_key_value(
    profile_id: String,
    request: RedisSetKeyValueRequest,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<RedisKeyMutationResult> {
    runtime_manager.set_key_value(&profile_id, &request).await
}

#[tauri::command]
pub async fn create_key_value(
    profile_id: String,
    request: RedisCreateKeyValueRequest,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<RedisKeyMutationResult> {
    runtime_manager
        .create_key_value(&profile_id, &request)
        .await
}

#[tauri::command]
pub async fn delete_key(
    profile_id: String,
    request: RedisDeleteKeyRequest,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<RedisDeleteKeyResult> {
    runtime_manager.delete_key(&profile_id, &request).await
}

#[tauri::command]
pub async fn delete_key_prefix(
    profile_id: String,
    request: RedisDeleteKeyPrefixRequest,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<RedisDeleteKeyResult> {
    runtime_manager
        .delete_key_prefix(&profile_id, &request)
        .await
}

#[tauri::command]
pub async fn rename_key(
    profile_id: String,
    request: RedisRenameKeyRequest,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<RedisKeyMutationResult> {
    runtime_manager.rename_key(&profile_id, &request).await
}

#[tauri::command]
pub async fn set_key_ttl(
    profile_id: String,
    request: RedisSetKeyTtlRequest,
    runtime_manager: State<'_, ConnectionRuntimeManager>,
) -> IpcResult<RedisKeyMutationResult> {
    runtime_manager.set_key_ttl(&profile_id, &request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::profiles::{
        ClickHouseProfile, ClickHouseProtocol, MysqlProfile, OracleProfile, OracleRole,
        PostgresProfile, RedisProfile, SqliteProfile, SshAuthMethod, SshHostVerificationMode,
        SshTunnelProfile,
    };

    #[test]
    fn clickhouse_phase_five_c_command_surface_is_strongly_named() {
        let _ = preview_alter_clickhouse_table;
        let _ = alter_clickhouse_table;
        let _ = preview_clickhouse_column_action;
        let _ = execute_clickhouse_column_action;
        let _ = preview_drop_clickhouse_table;
        let _ = drop_clickhouse_table;
        let _ = preview_drop_clickhouse_database;
        let _ = drop_clickhouse_database;
    }

    #[test]
    fn clickhouse_phase_five_d_command_surface_is_strongly_named() {
        let _ = preview_clickhouse_projection_change;
        let _ = execute_clickhouse_projection_change;
        let _ = preview_clickhouse_skipping_index_change;
        let _ = execute_clickhouse_skipping_index_change;
    }

    #[test]
    fn clickhouse_phase_five_e_command_surface_is_strongly_named() {
        let _ = get_clickhouse_view_runtime_support;
        let _ = describe_clickhouse_view_schema;
        let _ = preview_create_clickhouse_view;
        let _ = create_clickhouse_view;
        let _ = preview_change_clickhouse_view;
        let _ = execute_clickhouse_view_change;
        let _ = list_clickhouse_temporary_views;
    }

    fn ssh_tunnel() -> SshTunnelProfile {
        SshTunnelProfile {
            enabled: true,
            host: "bastion.example.com".to_string(),
            port: 22,
            username: "deploy".to_string(),
            auth_method: SshAuthMethod::Password,
            password: Some("secret".to_string()),
            private_key_path: None,
            private_key_passphrase: None,
            host_verification: SshHostVerificationMode::TrustOnFirstUse,
            host_key_fingerprint: None,
        }
    }

    #[test]
    fn mysql_endpoint_mentions_ssh_route() {
        let profile = DriverProfile::Mysql(MysqlProfile {
            host: "mysql.internal".to_string(),
            port: 3306,
            username: "root".to_string(),
            password: String::new(),
            default_database: Some("app".to_string()),
            connect_timeout_seconds: None,
            ssh_tunnel: Some(ssh_tunnel()),
            ssl_mode: None,
        });

        assert_eq!(
            endpoint_for_profile(&profile),
            "mysql.internal:3306/app via SSH bastion.example.com:22"
        );
    }

    #[test]
    fn clickhouse_profile_endpoint_is_protocol_aware_and_redacted() {
        let profile = DriverProfile::Clickhouse(ClickHouseProfile {
            host: "cloud.example.com".to_string(),
            port: 8443,
            username: "analytics-user".to_string(),
            password: "top-secret".to_string(),
            default_database: Some("events".to_string()),
            protocol: ClickHouseProtocol::Https,
            connect_timeout_seconds: Some(5),
            ssh_tunnel: None,
        });

        let endpoint = endpoint_for_profile(&profile);
        assert_eq!(endpoint, "https://cloud.example.com:8443/events");
        assert!(!endpoint.contains("analytics-user"));
        assert!(!endpoint.contains("top-secret"));
    }

    #[test]
    fn clickhouse_profile_endpoint_brackets_ipv6_hosts() {
        let profile = DriverProfile::Clickhouse(ClickHouseProfile {
            host: "2001:db8::1".to_string(),
            port: 8443,
            username: "default".to_string(),
            password: String::new(),
            default_database: Some("default".to_string()),
            protocol: ClickHouseProtocol::Https,
            connect_timeout_seconds: Some(5),
            ssh_tunnel: None,
        });

        assert_eq!(
            endpoint_for_profile(&profile),
            "https://[2001:db8::1]:8443/default"
        );
    }

    #[test]
    fn postgres_endpoint_mentions_ssh_route() {
        let profile = DriverProfile::Postgres(PostgresProfile {
            host: "pg.internal".to_string(),
            port: 5432,
            username: "postgres".to_string(),
            password: String::new(),
            default_database: None,
            schema: None,
            ssl_mode: None,
            connect_timeout_seconds: None,
            ssh_tunnel: Some(ssh_tunnel()),
        });

        assert_eq!(
            endpoint_for_profile(&profile),
            "pg.internal:5432/postgres via SSH bastion.example.com:22"
        );
    }

    #[test]
    fn redis_endpoint_mentions_ssh_route() {
        let profile = DriverProfile::Redis(RedisProfile {
            host: "redis.internal".to_string(),
            port: 6379,
            username: None,
            password: String::new(),
            db_index: Some(2),
            use_tls: false,
            connect_timeout_seconds: None,
            ssh_tunnel: Some(ssh_tunnel()),
        });

        assert_eq!(
            endpoint_for_profile(&profile),
            "redis.internal:6379/2 via SSH bastion.example.com:22"
        );
    }

    #[test]
    fn oracle_service_endpoint_mentions_ssh_route() {
        let profile = DriverProfile::Oracle(OracleProfile {
            host: "oracle.internal".to_string(),
            port: 1521,
            username: "app".to_string(),
            password: String::new(),
            service_name: Some("FREEPDB1".to_string()),
            sid: None,
            connect_descriptor: None,
            role: OracleRole::Normal,
            connect_timeout_seconds: None,
            ssh_tunnel: Some(ssh_tunnel()),
        });

        assert_eq!(
            endpoint_for_profile(&profile),
            "oracle.internal:1521/FREEPDB1 via SSH bastion.example.com:22"
        );
    }

    #[test]
    fn oracle_descriptor_endpoint_uses_descriptor_alias() {
        let profile = DriverProfile::Oracle(OracleProfile {
            host: "ignored.example.com".to_string(),
            port: 1521,
            username: "app".to_string(),
            password: String::new(),
            service_name: None,
            sid: None,
            connect_descriptor: Some("//db.example.com:1521/FREEPDB1".to_string()),
            role: OracleRole::Normal,
            connect_timeout_seconds: None,
            ssh_tunnel: None,
        });

        assert_eq!(
            endpoint_for_profile(&profile),
            "//db.example.com:1521/FREEPDB1"
        );
    }

    #[test]
    fn sqlite_endpoint_uses_local_file_path() {
        let profile = DriverProfile::Sqlite(SqliteProfile {
            db_file_path: "D:/data/app.sqlite3".to_string(),
            is_read_only: true,
        });

        assert_eq!(endpoint_for_profile(&profile), "D:/data/app.sqlite3");
    }
}
