use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTreePatch {
    pub id: String,
    pub parent_id: Option<String>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTreePatch {
    pub id: String,
    pub folder_id: Option<String>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderConnectionTreeInput {
    pub folder_patches: Vec<FolderTreePatch>,
    pub connection_patches: Vec<ConnectionTreePatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderConnectionTreeResult {
    pub updated_folders: usize,
    pub updated_connections: usize,
}

pub struct ConnectionTreeRepository;

impl ConnectionTreeRepository {
    pub async fn reorder(
        pool: &SqlitePool,
        input: ReorderConnectionTreeInput,
    ) -> AppResult<ReorderConnectionTreeResult> {
        validate_reorder_input(pool, &input).await?;

        let mut tx = pool.begin().await?;
        let mut updated_folders = 0usize;
        let mut updated_connections = 0usize;

        for patch in &input.folder_patches {
            let result = sqlx::query(
                r#"
                UPDATE connection_folders
                SET
                    parent_id = ?2,
                    sort_order = ?3,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?1
                "#,
            )
            .bind(&patch.id)
            .bind(patch.parent_id.as_deref())
            .bind(patch.sort_order)
            .execute(&mut *tx)
            .await?;

            if result.rows_affected() != 1 {
                return Err(AppError::not_found(format!(
                    "Connection folder {} not found",
                    patch.id
                )));
            }
            updated_folders += 1;
        }

        for patch in &input.connection_patches {
            let result = sqlx::query(
                r#"
                UPDATE connections
                SET
                    folder_id = ?2,
                    sort_order = ?3,
                    updated_at = strftime('%s','now') * 1000
                WHERE id = ?1
                "#,
            )
            .bind(&patch.id)
            .bind(patch.folder_id.as_deref())
            .bind(patch.sort_order)
            .execute(&mut *tx)
            .await?;

            if result.rows_affected() != 1 {
                return Err(AppError::not_found(format!(
                    "Connection {} not found",
                    patch.id
                )));
            }
            updated_connections += 1;
        }

        tx.commit().await?;

        Ok(ReorderConnectionTreeResult {
            updated_folders,
            updated_connections,
        })
    }
}

async fn validate_reorder_input(
    pool: &SqlitePool,
    input: &ReorderConnectionTreeInput,
) -> AppResult<()> {
    let folder_rows = sqlx::query_as::<_, (String, Option<String>)>(
        r#"
        SELECT id, parent_id
        FROM connection_folders
        "#,
    )
    .fetch_all(pool)
    .await?;

    let mut folder_parent_map: HashMap<String, Option<String>> = folder_rows.into_iter().collect();
    let folder_ids: HashSet<String> = folder_parent_map.keys().cloned().collect();

    let mut patched_folder_ids = HashSet::new();
    for patch in &input.folder_patches {
        if patch.id.trim().is_empty() {
            return Err(AppError::validation("Connection folder id cannot be empty"));
        }
        if !patched_folder_ids.insert(patch.id.clone()) {
            return Err(AppError::validation(format!(
                "Duplicate folder patch: {}",
                patch.id
            )));
        }
        if !folder_ids.contains(&patch.id) {
            return Err(AppError::not_found(format!(
                "Connection folder {} not found",
                patch.id
            )));
        }
        if let Some(parent_id) = patch.parent_id.as_deref() {
            if parent_id.trim().is_empty() {
                return Err(AppError::validation(
                    "Connection folder parent id cannot be empty",
                ));
            }
            if parent_id == patch.id {
                return Err(AppError::validation(
                    "Connection folder parent id cannot reference itself",
                ));
            }
            if !folder_ids.contains(parent_id) {
                return Err(AppError::validation(format!(
                    "Connection folder parent {} does not exist",
                    parent_id
                )));
            }
        }
        folder_parent_map.insert(patch.id.clone(), patch.parent_id.clone());
    }

    for folder_id in folder_parent_map.keys() {
        ensure_no_cycle_after_patches(folder_id, &folder_parent_map)?;
    }

    let mut patched_connection_ids = HashSet::new();
    for patch in &input.connection_patches {
        if patch.id.trim().is_empty() {
            return Err(AppError::validation("Connection id cannot be empty"));
        }
        if !patched_connection_ids.insert(patch.id.clone()) {
            return Err(AppError::validation(format!(
                "Duplicate connection patch: {}",
                patch.id
            )));
        }
        if let Some(folder_id) = patch.folder_id.as_deref() {
            if folder_id.trim().is_empty() {
                return Err(AppError::validation("Connection folder id cannot be empty"));
            }
            if !folder_ids.contains(folder_id) {
                return Err(AppError::validation(format!(
                    "Connection folder {} does not exist",
                    folder_id
                )));
            }
        }
    }

    Ok(())
}

fn ensure_no_cycle_after_patches(
    folder_id: &str,
    folder_parent_map: &HashMap<String, Option<String>>,
) -> AppResult<()> {
    let mut seen = HashSet::new();
    let mut current = folder_parent_map
        .get(folder_id)
        .and_then(|parent| parent.as_deref());

    while let Some(parent_id) = current {
        if parent_id == folder_id || !seen.insert(parent_id.to_string()) {
            return Err(AppError::validation(
                "Connection folder parent would create a cycle",
            ));
        }

        current = folder_parent_map
            .get(parent_id)
            .and_then(|parent| parent.as_deref());
    }

    Ok(())
}
