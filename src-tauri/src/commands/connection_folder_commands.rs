use tauri::State;

use crate::cloud::CloudSyncScheduler;
use crate::db::DatabaseState;
use crate::repository::connection_folder_repository::{
    ConnectionFolderRepository, CreateConnectionFolderInput, StoredConnectionFolder,
    UpdateConnectionFolderInput,
};

#[tauri::command]
pub async fn list_connection_folders(
    state: State<'_, DatabaseState>,
) -> Result<Vec<StoredConnectionFolder>, String> {
    ConnectionFolderRepository::list(&state.pool)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_connection_folder(
    id: String,
    state: State<'_, DatabaseState>,
) -> Result<Option<StoredConnectionFolder>, String> {
    ConnectionFolderRepository::get(&state.pool, &id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn create_connection_folder(
    input: CreateConnectionFolderInput,
    state: State<'_, DatabaseState>,
    scheduler: State<'_, CloudSyncScheduler>,
) -> Result<StoredConnectionFolder, String> {
    let result = ConnectionFolderRepository::create(&state.pool, input)
        .await
        .map_err(|error| error.to_string())?;
    scheduler.on_local_change();
    Ok(result)
}

#[tauri::command]
pub async fn update_connection_folder(
    input: UpdateConnectionFolderInput,
    state: State<'_, DatabaseState>,
    scheduler: State<'_, CloudSyncScheduler>,
) -> Result<StoredConnectionFolder, String> {
    let result = ConnectionFolderRepository::update(&state.pool, input)
        .await
        .map_err(|error| error.to_string())?;
    scheduler.on_local_change();
    Ok(result)
}

#[tauri::command]
pub async fn delete_connection_folder(
    id: String,
    state: State<'_, DatabaseState>,
    scheduler: State<'_, CloudSyncScheduler>,
) -> Result<bool, String> {
    let result = ConnectionFolderRepository::delete(&state.pool, &id)
        .await
        .map_err(|error| error.to_string())?;
    if result {
        scheduler.on_local_change();
    }
    Ok(result)
}
