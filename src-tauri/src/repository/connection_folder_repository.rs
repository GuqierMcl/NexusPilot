use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredConnectionFolder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateConnectionFolderInput {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConnectionFolderInput {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone, FromRow)]
struct ConnectionFolderRow {
    id: String,
    name: String,
    parent_id: Option<String>,
    created_at: String,
    updated_at: String,
    sort_order: Option<i64>,
}

impl From<ConnectionFolderRow> for StoredConnectionFolder {
    fn from(row: ConnectionFolderRow) -> Self {
        Self {
            id: row.id,
            name: row.name,
            parent_id: row.parent_id,
            created_at: row.created_at,
            updated_at: row.updated_at,
            sort_order: row.sort_order,
        }
    }
}

pub struct ConnectionFolderRepository;

impl ConnectionFolderRepository {
    pub async fn list(pool: &SqlitePool) -> AppResult<Vec<StoredConnectionFolder>> {
        let rows = sqlx::query_as::<_, ConnectionFolderRow>(
            r#"
            SELECT
                id,
                name,
                parent_id,
                created_at,
                updated_at,
                sort_order
            FROM connection_folders
            ORDER BY
                parent_id IS NOT NULL,
                parent_id ASC,
                sort_order IS NULL,
                sort_order ASC,
                created_at ASC
            "#,
        )
        .fetch_all(pool)
        .await?;

        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn get(pool: &SqlitePool, id: &str) -> AppResult<Option<StoredConnectionFolder>> {
        let row = sqlx::query_as::<_, ConnectionFolderRow>(
            r#"
            SELECT
                id,
                name,
                parent_id,
                created_at,
                updated_at,
                sort_order
            FROM connection_folders
            WHERE id = ?1
            "#,
        )
        .bind(id)
        .fetch_optional(pool)
        .await?;

        Ok(row.map(Into::into))
    }

    pub async fn create(
        pool: &SqlitePool,
        input: CreateConnectionFolderInput,
    ) -> AppResult<StoredConnectionFolder> {
        validate_folder_payload(&input.id, &input.name)?;
        ensure_valid_parent_folder(pool, &input.id, input.parent_id.as_deref()).await?;

        sqlx::query(
            r#"
            INSERT INTO connection_folders (
                id,
                name,
                parent_id,
                created_at,
                updated_at,
                sort_order
            )
            VALUES (
                ?1,
                ?2,
                ?3,
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                ?4
            )
            "#,
        )
        .bind(&input.id)
        .bind(&input.name)
        .bind(input.parent_id.as_deref())
        .bind(input.sort_order)
        .execute(pool)
        .await?;

        Self::get(pool, &input.id)
            .await?
            .ok_or_else(|| AppError::not_found("Failed to load created connection folder"))
    }

    pub async fn update(
        pool: &SqlitePool,
        input: UpdateConnectionFolderInput,
    ) -> AppResult<StoredConnectionFolder> {
        validate_folder_payload(&input.id, &input.name)?;
        ensure_valid_parent_folder(pool, &input.id, input.parent_id.as_deref()).await?;
        ensure_no_parent_cycle(pool, &input.id, input.parent_id.as_deref()).await?;

        let result = sqlx::query(
            r#"
            UPDATE connection_folders
            SET
                name = ?2,
                parent_id = ?3,
                sort_order = ?4,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ?1
            "#,
        )
        .bind(&input.id)
        .bind(&input.name)
        .bind(input.parent_id.as_deref())
        .bind(input.sort_order)
        .execute(pool)
        .await?;

        if result.rows_affected() == 0 {
            return Err(AppError::not_found(format!(
                "Connection folder {} not found",
                input.id
            )));
        }

        Self::get(pool, &input.id)
            .await?
            .ok_or_else(|| AppError::not_found("Failed to load updated connection folder"))
    }

    pub async fn delete(pool: &SqlitePool, id: &str) -> AppResult<bool> {
        let child_folder_count = sqlx::query_scalar::<_, i64>(
            r#"
            SELECT COUNT(1)
            FROM connection_folders
            WHERE parent_id = ?1
            "#,
        )
        .bind(id)
        .fetch_one(pool)
        .await?;

        if child_folder_count > 0 {
            return Err(AppError::validation(
                "Cannot delete folder that still contains child folders",
            ));
        }

        let child_connection_count = sqlx::query_scalar::<_, i64>(
            r#"
            SELECT COUNT(1)
            FROM connections
            WHERE folder_id = ?1
            "#,
        )
        .bind(id)
        .fetch_one(pool)
        .await?;

        if child_connection_count > 0 {
            return Err(AppError::validation(
                "Cannot delete folder that still contains connections",
            ));
        }

        let result = sqlx::query(
            r#"
            DELETE FROM connection_folders
            WHERE id = ?1
            "#,
        )
        .bind(id)
        .execute(pool)
        .await?;

        Ok(result.rows_affected() > 0)
    }
}

fn validate_folder_payload(id: &str, name: &str) -> AppResult<()> {
    if id.trim().is_empty() {
        return Err(AppError::validation("Connection folder id cannot be empty"));
    }

    if name.trim().is_empty() {
        return Err(AppError::validation(
            "Connection folder name cannot be empty",
        ));
    }

    Ok(())
}

async fn ensure_valid_parent_folder(
    pool: &SqlitePool,
    folder_id: &str,
    parent_id: Option<&str>,
) -> AppResult<()> {
    let Some(parent_id) = parent_id else {
        return Ok(());
    };

    if parent_id.trim().is_empty() {
        return Err(AppError::validation(
            "Connection folder parent id cannot be empty",
        ));
    }

    if parent_id == folder_id {
        return Err(AppError::validation(
            "Connection folder parent id cannot reference itself",
        ));
    }

    let parent_exists = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(1)
        FROM connection_folders
        WHERE id = ?1
        "#,
    )
    .bind(parent_id)
    .fetch_one(pool)
    .await?;

    if parent_exists == 0 {
        return Err(AppError::validation(format!(
            "Connection folder parent {} does not exist",
            parent_id
        )));
    }

    Ok(())
}

async fn ensure_no_parent_cycle(
    pool: &SqlitePool,
    folder_id: &str,
    parent_id: Option<&str>,
) -> AppResult<()> {
    let Some(parent_id) = parent_id else {
        return Ok(());
    };

    let cycle_count = sqlx::query_scalar::<_, i64>(
        r#"
        WITH RECURSIVE folder_ancestors(id, parent_id) AS (
            SELECT id, parent_id
            FROM connection_folders
            WHERE id = ?1

            UNION ALL

            SELECT folders.id, folders.parent_id
            FROM connection_folders AS folders
            INNER JOIN folder_ancestors AS ancestors
                ON folders.id = ancestors.parent_id
        )
        SELECT COUNT(1)
        FROM folder_ancestors
        WHERE id = ?2
        "#,
    )
    .bind(parent_id)
    .bind(folder_id)
    .fetch_one(pool)
    .await?;

    if cycle_count > 0 {
        return Err(AppError::validation(
            "Connection folder parent would create a cycle",
        ));
    }

    Ok(())
}
