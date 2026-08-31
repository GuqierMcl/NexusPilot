use sqlx::SqlitePool;
use tauri::State;

use crate::cloud::CloudSyncScheduler;
use crate::db::DatabaseState;
use crate::error::{AppError, IpcError, IpcResult};
use crate::repository::connection_repository::{
    ConnectionRepository, CreateConnectionInput, StoredConnectionRecord, UpdateConnectionInput,
};
use crate::repository::connection_tree_repository::{
    ConnectionTreeRepository, ReorderConnectionTreeInput, ReorderConnectionTreeResult,
};
use crate::workbench::application_service;

fn map_connection_repository_error(error: AppError) -> IpcError {
    match error {
        AppError::Validation(message) => IpcError::validation_failed(message),
        AppError::NotFound(message) => IpcError::resource_not_found(message),
        error => {
            IpcError::system_internal("Connection storage operation failed", error.to_string())
        }
    }
}

async fn create_connection_record(
    pool: &SqlitePool,
    input: CreateConnectionInput,
) -> IpcResult<StoredConnectionRecord> {
    ConnectionRepository::create(pool, input)
        .await
        .map_err(map_connection_repository_error)
}

async fn update_connection_record(
    pool: &SqlitePool,
    input: UpdateConnectionInput,
) -> IpcResult<StoredConnectionRecord> {
    ConnectionRepository::update(pool, input)
        .await
        .map_err(map_connection_repository_error)
}

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
) -> IpcResult<StoredConnectionRecord> {
    let result = create_connection_record(&state.pool, input).await?;
    scheduler.on_local_change();
    Ok(result)
}

#[tauri::command]
pub async fn update_connection(
    input: UpdateConnectionInput,
    state: State<'_, DatabaseState>,
    scheduler: State<'_, CloudSyncScheduler>,
) -> IpcResult<StoredConnectionRecord> {
    let result = update_connection_record(&state.pool, input).await?;
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

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    use super::{create_connection_record, update_connection_record};
    use crate::error::{ErrorCode, RuntimeErrorImpact};
    use crate::repository::connection_repository::{
        ConnectionDriver, ConnectionRepository, CreateConnectionInput, UpdateConnectionInput,
    };

    async fn create_test_pool() -> sqlx::SqlitePool {
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
            .expect("test database migrations should apply");
        pool
    }

    fn create_input(id: &str, note: String) -> CreateConnectionInput {
        CreateConnectionInput {
            id: id.to_string(),
            name: "Command boundary test".to_string(),
            driver: ConnectionDriver::Sqlite,
            environment: "development".to_string(),
            color: None,
            note,
            tag_label: String::new(),
            tag_color: None,
            payload: json!({ "path": "command-boundary.sqlite3" }),
            folder_id: None,
            sort_order: None,
        }
    }

    #[test]
    fn create_and_update_expose_structured_note_validation_errors() {
        tauri::async_runtime::block_on(async {
            let pool = create_test_pool().await;

            let create_error =
                create_connection_record(&pool, create_input("too-long-create", "🚀".repeat(51)))
                    .await
                    .expect_err("overlong create should fail at the command boundary");
            assert_eq!(create_error.code, ErrorCode::ValidationFailed);
            assert_eq!(
                create_error.runtime_impact,
                RuntimeErrorImpact::BusinessOnly
            );
            let serialized =
                serde_json::to_value(&create_error).expect("IPC error should serialize");
            assert_eq!(serialized["code"], "VALIDATION_FAILED");
            assert_eq!(serialized["runtimeImpact"], "businessOnly");

            let created = create_connection_record(
                &pool,
                create_input("valid-connection", "Original note".to_string()),
            )
            .await
            .expect("valid connection should be created");

            let update_error = update_connection_record(
                &pool,
                UpdateConnectionInput {
                    id: created.id.clone(),
                    name: created.name,
                    driver: created.driver,
                    environment: created.environment,
                    color: created.color,
                    note: "🚀".repeat(51),
                    tag_label: created.tag_label,
                    tag_color: created.tag_color,
                    payload: created.payload,
                    folder_id: created.folder_id,
                    sort_order: created.sort_order,
                },
            )
            .await
            .expect_err("overlong update should fail at the command boundary");
            assert_eq!(update_error.code, ErrorCode::ValidationFailed);

            let reloaded = ConnectionRepository::get(&pool, &created.id)
                .await
                .expect("connection should reload")
                .expect("connection should still exist");
            assert_eq!(reloaded.note, "Original note");

            pool.close().await;
        });
    }
}
