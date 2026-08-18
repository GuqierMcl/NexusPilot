use tauri::State;

use crate::db::DatabaseState;
use crate::repository::saved_query_repository::{
    CreateSavedQueryInput, SavedQuery, SavedQueryRepository, UpdateSavedQueryInput,
};

#[tauri::command]
pub async fn list_saved_queries(
    profile_id: String,
    state: State<'_, DatabaseState>,
) -> Result<Vec<SavedQuery>, String> {
    SavedQueryRepository::list_by_profile(&state.pool, &profile_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_saved_query(
    id: String,
    state: State<'_, DatabaseState>,
) -> Result<Option<SavedQuery>, String> {
    SavedQueryRepository::get(&state.pool, &id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn create_saved_query(
    input: CreateSavedQueryInput,
    state: State<'_, DatabaseState>,
) -> Result<SavedQuery, String> {
    SavedQueryRepository::create(&state.pool, input)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn update_saved_query(
    input: UpdateSavedQueryInput,
    state: State<'_, DatabaseState>,
) -> Result<SavedQuery, String> {
    SavedQueryRepository::update(&state.pool, input)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn delete_saved_query(
    id: String,
    state: State<'_, DatabaseState>,
) -> Result<bool, String> {
    SavedQueryRepository::delete(&state.pool, &id)
        .await
        .map_err(|error| error.to_string())
}
