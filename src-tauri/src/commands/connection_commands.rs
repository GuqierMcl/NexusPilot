use tauri::State;

use crate::cloud::CloudSyncScheduler;
use crate::db::DatabaseState;
use crate::repository::connection_repository::{
    ConnectionRepository, CreateConnectionInput, StoredConnectionRecord, UpdateConnectionInput,
};
use crate::repository::connection_tree_repository::{
    ConnectionTreeRepository, ReorderConnectionTreeInput, ReorderConnectionTreeResult,
};
use crate::workbench::application_service;

#[tauri::command]
pub async fn list_connections(
    state: State<'_, DatabaseState>,
) -> Result<Vec<StoredConnectionRecord>, String> {
    application_service::list_connections(&state)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_connection(
    id: String,
    state: State<'_, DatabaseState>,
) -> Result<Option<StoredConnectionRecord>, String> {
    application_service::get_connection(&state, &id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn create_connection(
    input: CreateConnectionInput,
    state: State<'_, DatabaseState>,
    scheduler: State<'_, CloudSyncScheduler>,
) -> Result<StoredConnectionRecord, String> {
    let result = ConnectionRepository::create(&state.pool, input)
        .await
        .map_err(|error| error.to_string())?;
    scheduler.on_local_change();
    Ok(result)
}

#[tauri::command]
pub async fn update_connection(
    input: UpdateConnectionInput,
    state: State<'_, DatabaseState>,
    scheduler: State<'_, CloudSyncScheduler>,
) -> Result<StoredConnectionRecord, String> {
    let result = ConnectionRepository::update(&state.pool, input)
        .await
        .map_err(|error| error.to_string())?;
    scheduler.on_local_change();
    Ok(result)
}

#[tauri::command]
pub async fn delete_connection(
    id: String,
    state: State<'_, DatabaseState>,
    scheduler: State<'_, CloudSyncScheduler>,
) -> Result<bool, String> {
    let result = ConnectionRepository::delete(&state.pool, &id)
        .await
        .map_err(|error| error.to_string())?;
    if result {
        scheduler.on_local_change();
    }
    Ok(result)
}

#[tauri::command]
pub async fn reorder_connection_tree(
    input: ReorderConnectionTreeInput,
    state: State<'_, DatabaseState>,
    scheduler: State<'_, CloudSyncScheduler>,
) -> Result<ReorderConnectionTreeResult, String> {
    let result = ConnectionTreeRepository::reorder(&state.pool, input)
        .await
        .map_err(|error| error.to_string())?;
    if result.updated_folders > 0 || result.updated_connections > 0 {
        scheduler.on_local_change();
    }
    Ok(result)
}
