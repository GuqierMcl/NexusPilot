use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};

use crate::error::{AppError, AppResult};

/// 本地同步资产的状态只描述 Desktop 自己知道的同步事实，不能被用作 Cloud 授权判断。
#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CloudSyncAssetStatus {
    LocalOnly,
    PendingUpload,
    Synced,
    PendingDelete,
    Conflicted,
    NeedsLocalFile,
    RemoteDeleted,
}

impl CloudSyncAssetStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::LocalOnly => "local_only",
            Self::PendingUpload => "pending_upload",
            Self::Synced => "synced",
            Self::PendingDelete => "pending_delete",
            Self::Conflicted => "conflicted",
            Self::NeedsLocalFile => "needs_local_file",
            Self::RemoteDeleted => "remote_deleted",
        }
    }
}

impl TryFrom<&str> for CloudSyncAssetStatus {
    type Error = AppError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "local_only" => Ok(Self::LocalOnly),
            "pending_upload" => Ok(Self::PendingUpload),
            "synced" => Ok(Self::Synced),
            "pending_delete" => Ok(Self::PendingDelete),
            "conflicted" => Ok(Self::Conflicted),
            "needs_local_file" => Ok(Self::NeedsLocalFile),
            "remote_deleted" => Ok(Self::RemoteDeleted),
            _ => Err(AppError::validation(format!(
                "Unsupported cloud sync asset status: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CloudSyncAssetType {
    Connection,
    ConnectionFolder,
}

impl CloudSyncAssetType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Connection => "connection",
            Self::ConnectionFolder => "connection_folder",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncAssetMetadata {
    pub cloud_account_id: String,
    pub asset_id: String,
    pub asset_type: CloudSyncAssetType,
    pub local_entity_id: String,
    pub remote_revision: Option<u64>,
    pub base_revision: Option<u64>,
    pub sync_status: CloudSyncAssetStatus,
    pub last_error_code: Option<String>,
    pub last_error_at: Option<i64>,
    pub last_attempt_at: Option<i64>,
    pub pending_operation_id: Option<String>,
    pub tombstone: bool,
    pub conflict_of: Option<String>,
    pub local_payload_hash: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, FromRow)]
struct CloudSyncAssetMetadataRow {
    cloud_account_id: String,
    asset_id: String,
    asset_type: String,
    local_entity_id: String,
    remote_revision: Option<i64>,
    base_revision: Option<i64>,
    sync_status: String,
    last_error_code: Option<String>,
    last_error_at: Option<i64>,
    last_attempt_at: Option<i64>,
    pending_operation_id: Option<String>,
    tombstone: i64,
    conflict_of: Option<String>,
    local_payload_hash: Option<String>,
    created_at: i64,
    updated_at: i64,
}

impl TryFrom<CloudSyncAssetMetadataRow> for CloudSyncAssetMetadata {
    type Error = AppError;

    fn try_from(row: CloudSyncAssetMetadataRow) -> Result<Self, Self::Error> {
        let remote_revision = row.remote_revision.map(to_revision).transpose()?;
        let base_revision = row.base_revision.map(to_revision).transpose()?;
        let asset_type = match row.asset_type.as_str() {
            "connection" => CloudSyncAssetType::Connection,
            "connection_folder" => CloudSyncAssetType::ConnectionFolder,
            other => {
                return Err(AppError::validation(format!(
                    "Unsupported cloud sync asset type: {other}"
                )))
            }
        };

        Ok(Self {
            cloud_account_id: row.cloud_account_id,
            asset_id: row.asset_id,
            asset_type,
            local_entity_id: row.local_entity_id,
            remote_revision,
            base_revision,
            sync_status: CloudSyncAssetStatus::try_from(row.sync_status.as_str())?,
            last_error_code: row.last_error_code,
            last_error_at: row.last_error_at,
            last_attempt_at: row.last_attempt_at,
            pending_operation_id: row.pending_operation_id,
            tombstone: row.tombstone != 0,
            conflict_of: row.conflict_of,
            local_payload_hash: row.local_payload_hash,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
    }
}

#[derive(Debug, Clone)]
pub struct UpsertCloudSyncAssetMetadata {
    pub cloud_account_id: String,
    pub asset_id: String,
    pub asset_type: CloudSyncAssetType,
    pub local_entity_id: String,
    pub remote_revision: Option<u64>,
    pub base_revision: Option<u64>,
    pub sync_status: CloudSyncAssetStatus,
    pub last_error_code: Option<String>,
    pub last_error_at: Option<i64>,
    pub last_attempt_at: Option<i64>,
    pub pending_operation_id: Option<String>,
    pub tombstone: bool,
    pub conflict_of: Option<String>,
    pub local_payload_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncConflictMetadata {
    pub id: String,
    pub cloud_account_id: String,
    pub asset_id: String,
    pub asset_type: CloudSyncAssetType,
    pub base_revision: Option<u64>,
    pub remote_revision: u64,
    pub local_payload_hash: String,
    pub remote_payload_hash: String,
    pub local_action: CloudSyncOperationAction,
    pub local_revision: Option<u64>,
    pub local_schema_version: Option<u16>,
    pub local_key_generation: Option<u64>,
    pub remote_schema_version: u16,
    pub remote_key_generation: u64,
    pub remote_tombstone: bool,
    pub pending_operation_id: Option<String>,
    pub status: String,
    pub detected_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, FromRow)]
struct CloudSyncConflictMetadataRow {
    id: String,
    cloud_account_id: String,
    asset_id: String,
    asset_type: String,
    base_revision: Option<i64>,
    remote_revision: i64,
    local_payload_hash: String,
    remote_payload_hash: String,
    local_action: String,
    local_revision: Option<i64>,
    local_schema_version: Option<i64>,
    local_key_generation: Option<i64>,
    remote_schema_version: i64,
    remote_key_generation: i64,
    remote_tombstone: i64,
    pending_operation_id: Option<String>,
    status: String,
    detected_at: i64,
    updated_at: i64,
}

impl TryFrom<CloudSyncConflictMetadataRow> for CloudSyncConflictMetadata {
    type Error = AppError;

    fn try_from(row: CloudSyncConflictMetadataRow) -> Result<Self, Self::Error> {
        let asset_type = match row.asset_type.as_str() {
            "connection" => CloudSyncAssetType::Connection,
            "connection_folder" => CloudSyncAssetType::ConnectionFolder,
            other => {
                return Err(AppError::validation(format!(
                    "Unsupported cloud sync conflict asset type: {other}"
                )))
            }
        };
        Ok(Self {
            id: row.id,
            cloud_account_id: row.cloud_account_id,
            asset_id: row.asset_id,
            asset_type,
            base_revision: row.base_revision.map(to_revision).transpose()?,
            remote_revision: to_revision(row.remote_revision)?,
            local_payload_hash: row.local_payload_hash,
            remote_payload_hash: row.remote_payload_hash,
            local_action: match row.local_action.as_str() {
                "put" => CloudSyncOperationAction::Put,
                "delete" => CloudSyncOperationAction::Delete,
                other => {
                    return Err(AppError::validation(format!(
                        "Unsupported cloud sync conflict action: {other}"
                    )))
                }
            },
            local_revision: row.local_revision.map(to_revision).transpose()?,
            local_schema_version: row
                .local_schema_version
                .map(|value| {
                    u16::try_from(value)
                        .map_err(|_| AppError::validation("Invalid local schema version"))
                })
                .transpose()?,
            local_key_generation: row.local_key_generation.map(to_revision).transpose()?,
            remote_schema_version: u16::try_from(row.remote_schema_version)
                .map_err(|_| AppError::validation("Invalid remote schema version"))?,
            remote_key_generation: to_revision(row.remote_key_generation)?,
            remote_tombstone: row.remote_tombstone != 0,
            pending_operation_id: row.pending_operation_id,
            status: row.status,
            detected_at: row.detected_at,
            updated_at: row.updated_at,
        })
    }
}

pub struct CloudSyncRepository;

impl CloudSyncRepository {
    pub async fn get_cursor(pool: &SqlitePool, cloud_account_id: &str) -> AppResult<u64> {
        let value = sqlx::query_scalar::<_, i64>(
            "SELECT cursor FROM cloud_sync_cursors WHERE cloud_account_id = ?1",
        )
        .bind(cloud_account_id)
        .fetch_optional(pool)
        .await?;
        value
            .map(to_revision)
            .transpose()
            .map(|value| value.unwrap_or(0))
    }

    pub async fn set_cursor(
        pool: &SqlitePool,
        cloud_account_id: &str,
        cursor: u64,
    ) -> AppResult<u64> {
        let cursor = to_sql_cursor(cursor)?;
        sqlx::query(
            r#"
            INSERT INTO cloud_sync_cursors (cloud_account_id, cursor, updated_at)
            VALUES (?1, ?2, strftime('%s','now') * 1000)
            ON CONFLICT (cloud_account_id) DO UPDATE SET
                cursor = excluded.cursor,
                updated_at = strftime('%s','now') * 1000
            "#,
        )
        .bind(cloud_account_id)
        .bind(cursor)
        .execute(pool)
        .await?;
        Ok(cursor as u64)
    }

    pub async fn upsert_asset(
        pool: &SqlitePool,
        input: UpsertCloudSyncAssetMetadata,
    ) -> AppResult<CloudSyncAssetMetadata> {
        let cloud_account_id = input.cloud_account_id.clone();
        let asset_id = input.asset_id.clone();
        sqlx::query(
            r#"
            INSERT INTO cloud_sync_assets (
                cloud_account_id, asset_id, asset_type, local_entity_id,
                remote_revision, base_revision, sync_status,
                last_error_code, last_error_at, last_attempt_at,
                pending_operation_id, tombstone, conflict_of, local_payload_hash,
                updated_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7,
                ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                strftime('%s','now') * 1000
            )
            ON CONFLICT (cloud_account_id, asset_id) DO UPDATE SET
                asset_type = excluded.asset_type,
                local_entity_id = excluded.local_entity_id,
                remote_revision = excluded.remote_revision,
                base_revision = excluded.base_revision,
                sync_status = excluded.sync_status,
                last_error_code = excluded.last_error_code,
                last_error_at = excluded.last_error_at,
                last_attempt_at = excluded.last_attempt_at,
                pending_operation_id = excluded.pending_operation_id,
                tombstone = excluded.tombstone,
                conflict_of = excluded.conflict_of,
                local_payload_hash = excluded.local_payload_hash,
                updated_at = strftime('%s','now') * 1000
            "#,
        )
        .bind(&input.cloud_account_id)
        .bind(&input.asset_id)
        .bind(input.asset_type.as_str())
        .bind(input.local_entity_id)
        .bind(input.remote_revision.map(to_sql_revision).transpose()?)
        .bind(input.base_revision.map(to_sql_revision).transpose()?)
        .bind(input.sync_status.as_str())
        .bind(input.last_error_code)
        .bind(input.last_error_at)
        .bind(input.last_attempt_at)
        .bind(input.pending_operation_id)
        .bind(if input.tombstone { 1_i64 } else { 0_i64 })
        .bind(input.conflict_of)
        .bind(input.local_payload_hash)
        .execute(pool)
        .await?;

        Self::get_asset(pool, &cloud_account_id, &asset_id)
            .await?
            .ok_or_else(|| AppError::not_found("Cloud sync asset metadata was not written"))
    }

    pub async fn get_asset(
        pool: &SqlitePool,
        cloud_account_id: &str,
        asset_id: &str,
    ) -> AppResult<Option<CloudSyncAssetMetadata>> {
        let row = sqlx::query_as::<_, CloudSyncAssetMetadataRow>(
            r#"
            SELECT cloud_account_id, asset_id, asset_type, local_entity_id,
                   remote_revision, base_revision, sync_status,
                   last_error_code, last_error_at, last_attempt_at,
                   pending_operation_id, tombstone, conflict_of, local_payload_hash,
                   created_at, updated_at
            FROM cloud_sync_assets
            WHERE cloud_account_id = ?1 AND asset_id = ?2
            "#,
        )
        .bind(cloud_account_id)
        .bind(asset_id)
        .fetch_optional(pool)
        .await?;

        row.map(TryInto::try_into).transpose()
    }

    pub async fn list_assets_by_status(
        pool: &SqlitePool,
        cloud_account_id: &str,
        status: CloudSyncAssetStatus,
    ) -> AppResult<Vec<CloudSyncAssetMetadata>> {
        let rows = sqlx::query_as::<_, CloudSyncAssetMetadataRow>(
            r#"
            SELECT cloud_account_id, asset_id, asset_type, local_entity_id,
                   remote_revision, base_revision, sync_status, last_error_code,
                   last_error_at, last_attempt_at, pending_operation_id, tombstone,
                   conflict_of, local_payload_hash, created_at, updated_at
            FROM cloud_sync_assets
            WHERE cloud_account_id = ?1 AND sync_status = ?2
            ORDER BY updated_at ASC, asset_id ASC
            "#,
        )
        .bind(cloud_account_id)
        .bind(status.as_str())
        .fetch_all(pool)
        .await?;
        rows.into_iter().map(TryInto::try_into).collect()
    }

    pub async fn list_assets(
        pool: &SqlitePool,
        cloud_account_id: &str,
    ) -> AppResult<Vec<CloudSyncAssetMetadata>> {
        let rows = sqlx::query_as::<_, CloudSyncAssetMetadataRow>(
            r#"
            SELECT cloud_account_id, asset_id, asset_type, local_entity_id,
                   remote_revision, base_revision, sync_status,
                   last_error_code, last_error_at, last_attempt_at,
                   pending_operation_id, tombstone, conflict_of, local_payload_hash,
                   created_at, updated_at
            FROM cloud_sync_assets
            WHERE cloud_account_id = ?1
            ORDER BY updated_at ASC, asset_id ASC
            "#,
        )
        .bind(cloud_account_id)
        .fetch_all(pool)
        .await?;

        rows.into_iter().map(TryInto::try_into).collect()
    }

    pub async fn record_conflict(
        pool: &SqlitePool,
        input: RecordCloudSyncConflict,
    ) -> AppResult<CloudSyncConflictMetadata> {
        let cloud_account_id = input.cloud_account_id.clone();
        let asset_id = input.asset_id.clone();
        let remote_revision = input.remote_revision;
        sqlx::query(
            r#"
            INSERT INTO cloud_sync_conflicts (
                id, cloud_account_id, asset_id, asset_type,
                base_revision, remote_revision, local_ciphertext, remote_ciphertext,
                local_nonce, remote_nonce, local_payload_hash, remote_payload_hash,
                local_action, local_revision, local_schema_version, local_key_generation,
                remote_schema_version, remote_key_generation, remote_tombstone,
                pending_operation_id
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                      ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
            ON CONFLICT (cloud_account_id, asset_id, remote_revision, status) DO UPDATE SET
                local_ciphertext = excluded.local_ciphertext,
                remote_ciphertext = excluded.remote_ciphertext,
                local_nonce = excluded.local_nonce,
                remote_nonce = excluded.remote_nonce,
                local_payload_hash = excluded.local_payload_hash,
                remote_payload_hash = excluded.remote_payload_hash,
                local_action = excluded.local_action,
                local_revision = excluded.local_revision,
                local_schema_version = excluded.local_schema_version,
                local_key_generation = excluded.local_key_generation,
                remote_schema_version = excluded.remote_schema_version,
                remote_key_generation = excluded.remote_key_generation,
                remote_tombstone = excluded.remote_tombstone,
                pending_operation_id = excluded.pending_operation_id,
                updated_at = strftime('%s','now') * 1000
            "#,
        )
        .bind(input.id)
        .bind(&input.cloud_account_id)
        .bind(&input.asset_id)
        .bind(input.asset_type.as_str())
        .bind(input.base_revision.map(to_sql_revision).transpose()?)
        .bind(to_sql_revision(input.remote_revision)?)
        .bind(input.local_ciphertext)
        .bind(input.remote_ciphertext)
        .bind(input.local_nonce)
        .bind(input.remote_nonce)
        .bind(input.local_payload_hash)
        .bind(input.remote_payload_hash)
        .bind(input.local_action.as_str())
        .bind(input.local_revision.map(to_sql_revision).transpose()?)
        .bind(input.local_schema_version.map(i64::from))
        .bind(
            input
                .local_key_generation
                .map(to_sql_revision)
                .transpose()?,
        )
        .bind(i64::from(input.remote_schema_version))
        .bind(to_sql_revision(input.remote_key_generation)?)
        .bind(if input.remote_tombstone { 1_i64 } else { 0_i64 })
        .bind(input.pending_operation_id)
        .execute(pool)
        .await?;

        let row = sqlx::query_as::<_, CloudSyncConflictMetadataRow>(
            r#"
            SELECT id, cloud_account_id, asset_id, asset_type,
                   base_revision, remote_revision, local_payload_hash,
                   remote_payload_hash, local_action, local_revision,
                   local_schema_version, local_key_generation, remote_schema_version,
                   remote_key_generation, remote_tombstone, pending_operation_id, status,
                   detected_at, updated_at
            FROM cloud_sync_conflicts
            WHERE cloud_account_id = ?1 AND asset_id = ?2
              AND remote_revision = ?3 AND status = 'pending'
            "#,
        )
        .bind(&cloud_account_id)
        .bind(&asset_id)
        .bind(to_sql_revision(remote_revision)?)
        .fetch_one(pool)
        .await?;

        row.try_into()
    }

    pub async fn list_pending_conflicts(
        pool: &SqlitePool,
        cloud_account_id: &str,
    ) -> AppResult<Vec<CloudSyncConflictMetadata>> {
        let rows = sqlx::query_as::<_, CloudSyncConflictMetadataRow>(
            r#"
            SELECT id, cloud_account_id, asset_id, asset_type,
                   base_revision, remote_revision, local_payload_hash,
                   remote_payload_hash, local_action, local_revision,
                   local_schema_version, local_key_generation, remote_schema_version,
                   remote_key_generation, remote_tombstone, pending_operation_id, status,
                   detected_at, updated_at
            FROM cloud_sync_conflicts
            WHERE cloud_account_id = ?1 AND status = 'pending'
            ORDER BY updated_at ASC, id ASC
            "#,
        )
        .bind(cloud_account_id)
        .fetch_all(pool)
        .await?;

        rows.into_iter().map(TryInto::try_into).collect()
    }

    pub async fn resolve_conflict(pool: &SqlitePool, id: &str) -> AppResult<bool> {
        let result = sqlx::query(
            r#"
            UPDATE cloud_sync_conflicts
            SET status = 'resolved', updated_at = strftime('%s','now') * 1000
            WHERE id = ?1 AND status = 'pending'
            "#,
        )
        .bind(id)
        .execute(pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn enqueue_operation(
        pool: &SqlitePool,
        input: EnqueueCloudSyncOperation,
    ) -> AppResult<CloudSyncOperation> {
        if let Some(existing) = Self::get_operation(pool, &input.operation_id).await? {
            if !operation_matches_input(&existing, &input) {
                return Err(AppError::validation(
                    "Cloud sync operation ID was reused with a different request",
                ));
            }
            return Ok(existing);
        }
        sqlx::query(
            r#"
            INSERT INTO cloud_sync_operations (
                operation_id, cloud_account_id, asset_id, asset_type, action,
                expected_revision, schema_version, key_generation, nonce, ciphertext,
                payload_hash, status, last_error_code, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', NULL,
                      strftime('%s','now') * 1000)
            ON CONFLICT (operation_id) DO UPDATE SET
                updated_at = strftime('%s','now') * 1000
            "#,
        )
        .bind(&input.operation_id)
        .bind(&input.cloud_account_id)
        .bind(&input.asset_id)
        .bind(input.asset_type.as_str())
        .bind(input.action.as_str())
        .bind(input.expected_revision.map(to_sql_revision).transpose()?)
        .bind(input.schema_version.map(i64::from))
        .bind(input.key_generation.map(to_sql_revision).transpose()?)
        .bind(&input.nonce)
        .bind(&input.ciphertext)
        .bind(&input.payload_hash)
        .execute(pool)
        .await?;

        let operation = Self::get_operation(pool, &input.operation_id)
            .await?
            .ok_or_else(|| AppError::not_found("Cloud sync operation was not written"))?;
        if !operation_matches_input(&operation, &input) {
            return Err(AppError::validation(
                "Cloud sync operation ID was reused with a different request",
            ));
        }
        Ok(operation)
    }

    pub async fn get_operation(
        pool: &SqlitePool,
        operation_id: &str,
    ) -> AppResult<Option<CloudSyncOperation>> {
        let row = sqlx::query_as::<_, CloudSyncOperationRow>(
            r#"
            SELECT operation_id, cloud_account_id, asset_id, asset_type, action,
                   expected_revision, schema_version, key_generation, nonce, ciphertext,
                   payload_hash, status, attempt_count, last_error_code,
                   last_attempt_at, created_at, updated_at
            FROM cloud_sync_operations
            WHERE operation_id = ?1
            "#,
        )
        .bind(operation_id)
        .fetch_optional(pool)
        .await?;
        row.map(TryInto::try_into).transpose()
    }

    pub async fn list_pending_operations(
        pool: &SqlitePool,
        cloud_account_id: &str,
    ) -> AppResult<Vec<CloudSyncOperation>> {
        let rows = sqlx::query_as::<_, CloudSyncOperationRow>(
            r#"
            SELECT operation_id, cloud_account_id, asset_id, asset_type, action,
                   expected_revision, schema_version, key_generation, nonce, ciphertext,
                   payload_hash, status, attempt_count, last_error_code,
                   last_attempt_at, created_at, updated_at
            FROM cloud_sync_operations
            WHERE cloud_account_id = ?1 AND status IN ('pending', 'unknown')
            ORDER BY created_at ASC, operation_id ASC
            "#,
        )
        .bind(cloud_account_id)
        .fetch_all(pool)
        .await?;
        rows.into_iter().map(TryInto::try_into).collect()
    }

    pub async fn get_pending_operation_for_asset(
        pool: &SqlitePool,
        cloud_account_id: &str,
        asset_id: &str,
    ) -> AppResult<Option<CloudSyncOperation>> {
        let row = sqlx::query_as::<_, CloudSyncOperationRow>(
            r#"
            SELECT operation_id, cloud_account_id, asset_id, asset_type, action,
                   expected_revision, schema_version, key_generation, nonce, ciphertext,
                   payload_hash, status, attempt_count, last_error_code,
                   last_attempt_at, created_at, updated_at
            FROM cloud_sync_operations
            WHERE cloud_account_id = ?1 AND asset_id = ?2
              AND status IN ('pending', 'unknown')
            ORDER BY created_at DESC, operation_id DESC
            LIMIT 1
            "#,
        )
        .bind(cloud_account_id)
        .bind(asset_id)
        .fetch_optional(pool)
        .await?;
        row.map(TryInto::try_into).transpose()
    }

    pub async fn mark_operation_attempt(pool: &SqlitePool, operation_id: &str) -> AppResult<bool> {
        let result = sqlx::query(
            r#"
            UPDATE cloud_sync_operations
            SET attempt_count = attempt_count + 1,
                last_attempt_at = strftime('%s','now') * 1000,
                updated_at = strftime('%s','now') * 1000
            WHERE operation_id = ?1
              AND status IN ('pending', 'unknown')
            "#,
        )
        .bind(operation_id)
        .execute(pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn mark_operation_status(
        pool: &SqlitePool,
        operation_id: &str,
        status: CloudSyncOperationStatus,
        error_code: Option<&str>,
    ) -> AppResult<bool> {
        let result = sqlx::query(
            r#"
            UPDATE cloud_sync_operations
            SET status = ?2,
                last_error_code = ?3,
                updated_at = strftime('%s','now') * 1000
            WHERE operation_id = ?1
            "#,
        )
        .bind(operation_id)
        .bind(status.as_str())
        .bind(error_code)
        .execute(pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CloudSyncOperationAction {
    Put,
    Delete,
}

impl CloudSyncOperationAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Put => "put",
            Self::Delete => "delete",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CloudSyncOperationStatus {
    Pending,
    Unknown,
    Applied,
    Conflicted,
    Rejected,
}

impl CloudSyncOperationStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Unknown => "unknown",
            Self::Applied => "applied",
            Self::Conflicted => "conflicted",
            Self::Rejected => "rejected",
        }
    }
}

#[derive(Debug, Clone)]
pub struct EnqueueCloudSyncOperation {
    pub operation_id: String,
    pub cloud_account_id: String,
    pub asset_id: String,
    pub asset_type: CloudSyncAssetType,
    pub action: CloudSyncOperationAction,
    pub expected_revision: Option<u64>,
    pub schema_version: Option<u16>,
    pub key_generation: Option<u64>,
    pub nonce: Option<String>,
    pub ciphertext: Option<String>,
    pub payload_hash: Option<String>,
}

fn operation_matches_input(
    existing: &CloudSyncOperation,
    input: &EnqueueCloudSyncOperation,
) -> bool {
    existing.cloud_account_id == input.cloud_account_id
        && existing.asset_id == input.asset_id
        && existing.asset_type == input.asset_type
        && existing.action == input.action
        && existing.expected_revision == input.expected_revision
        && existing.schema_version == input.schema_version
        && existing.key_generation == input.key_generation
        && existing.nonce == input.nonce
        && existing.ciphertext == input.ciphertext
        && existing.payload_hash == input.payload_hash
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncOperation {
    pub operation_id: String,
    pub cloud_account_id: String,
    pub asset_id: String,
    pub asset_type: CloudSyncAssetType,
    pub action: CloudSyncOperationAction,
    pub expected_revision: Option<u64>,
    pub schema_version: Option<u16>,
    pub key_generation: Option<u64>,
    pub nonce: Option<String>,
    pub ciphertext: Option<String>,
    pub payload_hash: Option<String>,
    pub status: CloudSyncOperationStatus,
    pub attempt_count: u64,
    pub last_error_code: Option<String>,
    pub last_attempt_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, FromRow)]
struct CloudSyncOperationRow {
    operation_id: String,
    cloud_account_id: String,
    asset_id: String,
    asset_type: String,
    action: String,
    expected_revision: Option<i64>,
    schema_version: Option<i64>,
    key_generation: Option<i64>,
    nonce: Option<String>,
    ciphertext: Option<String>,
    payload_hash: Option<String>,
    status: String,
    attempt_count: i64,
    last_error_code: Option<String>,
    last_attempt_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
}

impl TryFrom<CloudSyncOperationRow> for CloudSyncOperation {
    type Error = AppError;

    fn try_from(row: CloudSyncOperationRow) -> Result<Self, Self::Error> {
        let asset_type = match row.asset_type.as_str() {
            "connection" => CloudSyncAssetType::Connection,
            "connection_folder" => CloudSyncAssetType::ConnectionFolder,
            other => {
                return Err(AppError::validation(format!(
                    "Unsupported cloud sync operation asset type: {other}"
                )))
            }
        };
        let action = match row.action.as_str() {
            "put" => CloudSyncOperationAction::Put,
            "delete" => CloudSyncOperationAction::Delete,
            other => {
                return Err(AppError::validation(format!(
                    "Unsupported cloud sync operation action: {other}"
                )))
            }
        };
        let status = match row.status.as_str() {
            "pending" => CloudSyncOperationStatus::Pending,
            "unknown" => CloudSyncOperationStatus::Unknown,
            "applied" => CloudSyncOperationStatus::Applied,
            "conflicted" => CloudSyncOperationStatus::Conflicted,
            "rejected" => CloudSyncOperationStatus::Rejected,
            other => {
                return Err(AppError::validation(format!(
                    "Unsupported cloud sync operation status: {other}"
                )))
            }
        };
        let attempt_count = u64::try_from(row.attempt_count)
            .map_err(|_| AppError::validation("Cloud sync operation attempt count is negative"))?;
        let schema_version = row
            .schema_version
            .map(|value| {
                u16::try_from(value).map_err(|_| AppError::validation("Invalid schema version"))
            })
            .transpose()?;
        Ok(Self {
            operation_id: row.operation_id,
            cloud_account_id: row.cloud_account_id,
            asset_id: row.asset_id,
            asset_type,
            action,
            expected_revision: row.expected_revision.map(to_revision).transpose()?,
            schema_version,
            key_generation: row.key_generation.map(to_revision).transpose()?,
            nonce: row.nonce,
            ciphertext: row.ciphertext,
            payload_hash: row.payload_hash,
            status,
            attempt_count,
            last_error_code: row.last_error_code,
            last_attempt_at: row.last_attempt_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
    }
}

#[derive(Debug, Clone)]
pub struct RecordCloudSyncConflict {
    pub id: String,
    pub cloud_account_id: String,
    pub asset_id: String,
    pub asset_type: CloudSyncAssetType,
    pub base_revision: Option<u64>,
    pub remote_revision: u64,
    pub local_ciphertext: String,
    pub remote_ciphertext: String,
    pub local_nonce: String,
    pub remote_nonce: String,
    pub local_payload_hash: String,
    pub remote_payload_hash: String,
    pub local_action: CloudSyncOperationAction,
    pub local_revision: Option<u64>,
    pub local_schema_version: Option<u16>,
    pub local_key_generation: Option<u64>,
    pub remote_schema_version: u16,
    pub remote_key_generation: u64,
    pub remote_tombstone: bool,
    pub pending_operation_id: Option<String>,
}

fn to_sql_revision(value: u64) -> AppResult<i64> {
    i64::try_from(value)
        .map_err(|_| AppError::validation("Cloud sync revision exceeds SQLite range"))
}

fn to_sql_cursor(value: u64) -> AppResult<i64> {
    i64::try_from(value).map_err(|_| AppError::validation("Cloud sync cursor exceeds SQLite range"))
}

fn to_revision(value: i64) -> AppResult<u64> {
    u64::try_from(value).map_err(|_| AppError::validation("Cloud sync revision is negative"))
}

#[cfg(test)]
mod tests {
    use super::{to_revision, to_sql_cursor, CloudSyncAssetStatus, CloudSyncAssetType};

    #[test]
    fn serializes_sync_status_and_asset_type_as_contract_values() {
        assert_eq!(
            serde_json::to_string(&CloudSyncAssetStatus::PendingUpload).unwrap(),
            "\"pending_upload\""
        );
        assert_eq!(
            serde_json::to_string(&CloudSyncAssetType::ConnectionFolder).unwrap(),
            "\"connection_folder\""
        );
    }

    #[test]
    fn cursor_conversion_rejects_values_outside_sqlite_integer_range() {
        assert_eq!(to_sql_cursor(i64::MAX as u64).unwrap(), i64::MAX);
        assert!(to_sql_cursor(i64::MAX as u64 + 1).is_err());
        assert_eq!(to_revision(0).unwrap(), 0);
        assert!(to_revision(-1).is_err());
    }
}
