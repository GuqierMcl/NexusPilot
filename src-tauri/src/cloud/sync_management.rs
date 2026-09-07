use crate::cloud::sync_upload::{prepare_connection_delete, prepare_connection_upload};
use crate::repository::cloud_sync_repository::CloudSyncAssetType;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use std::str::FromStr;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::cloud::sync_apply::merge_local_paths;
use crate::cloud::sync_crypto::{decrypt_connection_asset, CONNECTION_ASSET_SUITE};
use crate::cloud::sync_key_store::CommittedSyncKeyBundle;
use crate::cloud::sync_projection::{collect_local_dependencies, LocalDependencyKind};
use crate::cloud::sync_projection::{ConnectionFolderSyncProjection, ConnectionSyncProjection};
use crate::error::{AppError, AppResult};
use crate::repository::cloud_sync_repository::{
    CloudSyncAssetStatus, CloudSyncRepository, EnqueueCloudSyncOperation,
};
use crate::repository::connection_folder_repository::{
    ConnectionFolderRepository, CreateConnectionFolderInput,
};
use crate::repository::connection_repository::{
    ConnectionDriver, ConnectionRepository, CreateConnectionInput, UpdateConnectionInput,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudLocalDependency {
    pub asset_id: String,
    pub asset_name: String,
    pub dependency: LocalDependencyKind,
    pub current_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudLocalDependencyList {
    pub cloud_account_id: String,
    pub items: Vec<CloudLocalDependency>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncConflictView {
    pub id: String,
    pub asset_id: String,
    pub asset_type: String,
    pub local_action: String,
    pub remote_tombstone: bool,
    pub local_revision: Option<u64>,
    pub remote_revision: u64,
    pub local_name: Option<String>,
    pub remote_name: Option<String>,
    pub local_payload_hash: String,
    pub remote_payload_hash: String,
    pub detected_at: i64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CloudSyncConflictDecision {
    KeepLocal,
    KeepCloud,
    KeepBoth,
}

pub async fn list_conflicts(
    pool: &SqlitePool,
    cloud_account_id: &str,
    keys: &CommittedSyncKeyBundle,
) -> AppResult<Vec<CloudSyncConflictView>> {
    let rows = sqlx::query_as::<_, ConflictRow>(
        "SELECT id, asset_id, asset_type, remote_revision, local_ciphertext, remote_ciphertext, local_nonce, remote_nonce, local_payload_hash, remote_payload_hash, local_action, local_revision, local_schema_version, local_key_generation, remote_schema_version, remote_key_generation, remote_tombstone, detected_at FROM cloud_sync_conflicts WHERE cloud_account_id = ?1 AND status = 'pending' ORDER BY updated_at ASC, id ASC",
    )
    .bind(cloud_account_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            let local_name = decrypt_name(cloud_account_id, &row, true, keys);
            let remote_name = decrypt_name(cloud_account_id, &row, false, keys);
            Ok(CloudSyncConflictView {
                id: row.id,
                asset_id: row.asset_id,
                asset_type: row.asset_type,
                local_action: row.local_action,
                remote_tombstone: row.remote_tombstone != 0,
                local_revision: row
                    .local_revision
                    .and_then(|value| u64::try_from(value).ok()),
                remote_revision: u64::try_from(row.remote_revision)
                    .map_err(|_| AppError::validation("Invalid conflict revision"))?,
                local_name,
                remote_name,
                local_payload_hash: row.local_payload_hash,
                remote_payload_hash: row.remote_payload_hash,
                detected_at: row.detected_at,
            })
        })
        .collect()
}

pub async fn resolve_conflict(
    pool: &SqlitePool,
    cloud_account_id: &str,
    conflict_id: &str,
    decision: CloudSyncConflictDecision,
    keys: &CommittedSyncKeyBundle,
) -> AppResult<Vec<CloudSyncConflictView>> {
    let row = sqlx::query_as::<_, ConflictRow>(
        "SELECT id, asset_id, asset_type, remote_revision, local_ciphertext, remote_ciphertext, local_nonce, remote_nonce, local_payload_hash, remote_payload_hash, local_action, local_revision, local_schema_version, local_key_generation, remote_schema_version, remote_key_generation, remote_tombstone, detected_at FROM cloud_sync_conflicts WHERE cloud_account_id = ?1 AND id = ?2 AND status = 'pending'",
    )
    .bind(cloud_account_id)
    .bind(conflict_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::not_found("Cloud sync conflict was not found"))?;

    if matches!(decision, CloudSyncConflictDecision::KeepBoth) && row.asset_type != "connection" {
        return Err(AppError::validation(
            "Folder conflicts cannot keep both versions",
        ));
    }
    match decision {
        CloudSyncConflictDecision::KeepCloud => {
            apply_candidate(pool, cloud_account_id, &row, false, keys).await?;
            mark_resolved(pool, cloud_account_id, &row).await?;
        }
        CloudSyncConflictDecision::KeepLocal => {
            enqueue_local_candidate(pool, cloud_account_id, &row, keys).await?;
            mark_conflict_resolved(pool, cloud_account_id, conflict_id).await?;
        }
        CloudSyncConflictDecision::KeepBoth => {
            duplicate_local_candidate(pool, cloud_account_id, &row, keys).await?;
            apply_candidate(pool, cloud_account_id, &row, false, keys).await?;
            mark_resolved(pool, cloud_account_id, &row).await?;
        }
    }
    list_conflicts(pool, cloud_account_id, keys).await
}

#[derive(Debug, sqlx::FromRow)]
struct ConflictRow {
    id: String,
    asset_id: String,
    asset_type: String,
    remote_revision: i64,
    local_ciphertext: String,
    remote_ciphertext: String,
    local_nonce: String,
    remote_nonce: String,
    local_payload_hash: String,
    remote_payload_hash: String,
    local_action: String,
    local_revision: Option<i64>,
    local_schema_version: Option<i64>,
    local_key_generation: Option<i64>,
    remote_schema_version: i64,
    remote_key_generation: i64,
    remote_tombstone: i64,
    detected_at: i64,
}

fn decrypt_name(
    account: &str,
    row: &ConflictRow,
    local: bool,
    keys: &CommittedSyncKeyBundle,
) -> Option<String> {
    let (ciphertext, nonce, revision, schema, generation) = if local {
        (
            row.local_ciphertext.as_str(),
            row.local_nonce.as_str(),
            row.local_revision?,
            row.local_schema_version?,
            row.local_key_generation?,
        )
    } else {
        if row.remote_tombstone != 0 {
            return None;
        }
        (
            row.remote_ciphertext.as_str(),
            row.remote_nonce.as_str(),
            row.remote_revision,
            row.remote_schema_version,
            row.remote_key_generation,
        )
    };
    let encryption = crate::cloud::types::CloudConnectionAssetEncryption {
        suite: CONNECTION_ASSET_SUITE.to_string(),
        nonce: nonce.to_string(),
        ciphertext: ciphertext.to_string(),
    };
    let bytes = decrypt_connection_asset(
        account,
        &row.asset_id,
        &row.asset_type,
        u64::try_from(revision).ok()?,
        u16::try_from(schema).ok()?,
        u64::try_from(generation).ok()?,
        &encryption,
        &keys.amk,
    )
    .ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    value
        .get("name")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

async fn mark_resolved(pool: &SqlitePool, account: &str, row: &ConflictRow) -> AppResult<()> {
    let (status, hash) = if row.remote_tombstone != 0 {
        ("remote_deleted", None)
    } else if row.asset_type == "connection" {
        let record = ConnectionRepository::get(pool, &row.asset_id)
            .await?
            .ok_or_else(|| AppError::not_found("Resolved connection missing"))?;
        let missing_path = collect_local_dependencies(&record.driver, &record.payload)
            .iter()
            .any(|kind| {
                dependency_path(&record.payload, kind).is_none_or(|path| path.trim().is_empty())
            });
        (
            if missing_path {
                "needs_local_file"
            } else {
                "synced"
            },
            Some(
                crate::cloud::sync_projection::connection_projection(&record)?
                    .1
                    .as_base64url(),
            ),
        )
    } else {
        let record = ConnectionFolderRepository::get(pool, &row.asset_id)
            .await?
            .ok_or_else(|| AppError::not_found("Resolved folder missing"))?;
        (
            "synced",
            Some(
                crate::cloud::sync_projection::folder_projection(&record)?
                    .1
                    .as_base64url(),
            ),
        )
    };
    sqlx::query("UPDATE cloud_sync_assets SET sync_status = ?3, remote_revision = ?4, base_revision = ?4, local_payload_hash = ?5, tombstone = ?6, pending_operation_id = NULL, last_error_code = NULL, last_error_at = NULL, updated_at = strftime('%s','now') * 1000 WHERE cloud_account_id = ?1 AND asset_id = ?2")
        .bind(account).bind(&row.asset_id).bind(status).bind(row.remote_revision).bind(hash).bind(row.remote_tombstone).execute(pool).await?;
    mark_conflict_resolved(pool, account, &row.id).await?;
    Ok(())
}

async fn mark_conflict_resolved(
    pool: &SqlitePool,
    account: &str,
    conflict_id: &str,
) -> AppResult<()> {
    // Old conflicted writes must not be reconsidered by the next pull after a decision.
    sqlx::query("UPDATE cloud_sync_operations SET status = 'rejected', last_error_code = 'conflict_resolved' WHERE cloud_account_id = ?1 AND status = 'conflicted' AND asset_id = (SELECT asset_id FROM cloud_sync_conflicts WHERE cloud_account_id = ?1 AND id = ?2)")
        .bind(account).bind(conflict_id).execute(pool).await?;
    sqlx::query("UPDATE cloud_sync_conflicts SET status = 'resolved', updated_at = strftime('%s','now') * 1000 WHERE cloud_account_id = ?1 AND id = ?2")
        .bind(account).bind(conflict_id).execute(pool).await?;
    Ok(())
}

async fn enqueue_local_candidate(
    pool: &SqlitePool,
    account: &str,
    row: &ConflictRow,
    keys: &CommittedSyncKeyBundle,
) -> AppResult<()> {
    let operation = prepare_local_candidate(account, row, row.remote_revision, keys)?;
    let operation_id = operation.operation_id.clone();
    CloudSyncRepository::enqueue_operation(pool, operation).await?;
    sqlx::query("UPDATE cloud_sync_assets SET sync_status = 'pending_upload', pending_operation_id = ?3, updated_at = strftime('%s','now') * 1000 WHERE cloud_account_id = ?1 AND asset_id = ?2").bind(account).bind(&row.asset_id).bind(operation_id).execute(pool).await?;
    Ok(())
}

fn prepare_local_candidate(
    account: &str,
    row: &ConflictRow,
    expected_revision: i64,
    keys: &CommittedSyncKeyBundle,
) -> AppResult<EnqueueCloudSyncOperation> {
    if keys.cloud_account_id != account {
        return Err(AppError::validation("Conflict account mismatch"));
    }
    let asset_type = match row.asset_type.as_str() {
        "connection" => CloudSyncAssetType::Connection,
        "connection_folder" => CloudSyncAssetType::ConnectionFolder,
        _ => return Err(AppError::validation("Invalid conflict asset type")),
    };
    let expected = u64::try_from(expected_revision)
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| AppError::validation("Invalid conflict remote revision"))?;
    if row.local_action == "delete" {
        return prepare_connection_delete(account, &row.asset_id, asset_type, expected)
            .map_err(|_| AppError::validation("Failed to prepare conflict deletion"));
    }
    if row.local_action != "put" {
        return Err(AppError::validation("Invalid conflict action"));
    }
    let revision = row
        .local_revision
        .and_then(|v| u64::try_from(v).ok())
        .ok_or_else(|| AppError::validation("Invalid local candidate revision"))?;
    let schema = row
        .local_schema_version
        .and_then(|v| u16::try_from(v).ok())
        .ok_or_else(|| AppError::validation("Invalid local candidate schema"))?;
    let generation = row
        .local_key_generation
        .and_then(|v| u64::try_from(v).ok())
        .ok_or_else(|| AppError::validation("Invalid local candidate generation"))?;
    if generation != u64::from(keys.key_generation) {
        return Err(AppError::validation("Conflict key generation mismatch"));
    }
    let encryption = crate::cloud::types::CloudConnectionAssetEncryption {
        suite: CONNECTION_ASSET_SUITE.into(),
        nonce: row.local_nonce.clone(),
        ciphertext: row.local_ciphertext.clone(),
    };
    let plaintext = Zeroizing::new(
        decrypt_connection_asset(
            account,
            &row.asset_id,
            &row.asset_type,
            revision,
            schema,
            generation,
            &encryption,
            &keys.amk,
        )
        .map_err(|_| AppError::validation("Cannot decrypt local conflict candidate"))?,
    );
    // Revision is authenticated AAD: changing the CAS base requires fresh encryption.
    prepare_connection_upload(
        account,
        &row.asset_id,
        asset_type,
        Some(expected),
        schema,
        generation,
        &plaintext,
        &keys.amk,
    )
    .map(|prepared| prepared.operation)
    .map_err(|_| AppError::validation("Failed to reencrypt local conflict candidate"))
}

/// Repair only the exact legacy KeepLocal ciphertext this device demonstrably uploaded.
/// A remote-only device cannot infer the original authenticated revision and must fail closed.
pub(crate) async fn prepare_legacy_conflict_repair(
    pool: &SqlitePool,
    account: &str,
    asset: &crate::cloud::types::CloudConnectionAssetProjection,
    keys: &CommittedSyncKeyBundle,
) -> AppResult<Option<EnqueueCloudSyncOperation>> {
    if asset.tombstone
        || asset.updated_by_device_id != keys.device_id
        || account != keys.cloud_account_id
    {
        return Ok(None);
    }
    let Some(encryption) = asset.encryption.as_ref() else {
        return Ok(None);
    };
    if encryption.suite != CONNECTION_ASSET_SUITE {
        return Ok(None);
    }
    let revision = asset
        .revision
        .parse::<i64>()
        .ok()
        .filter(|v| *v > 1)
        .ok_or_else(|| AppError::validation("Invalid legacy repair revision"))?;
    let parent = asset
        .parent_revision
        .as_deref()
        .and_then(|v| v.parse::<i64>().ok());
    if parent != Some(revision - 1) {
        return Ok(None);
    }
    let row = sqlx::query_as::<_, ConflictRow>(
        "SELECT c.id, c.asset_id, c.asset_type, c.remote_revision, c.local_ciphertext, c.remote_ciphertext, c.local_nonce, c.remote_nonce, c.local_payload_hash, c.remote_payload_hash, c.local_action, c.local_revision, c.local_schema_version, c.local_key_generation, c.remote_schema_version, c.remote_key_generation, c.remote_tombstone, c.detected_at FROM cloud_sync_conflicts c WHERE c.cloud_account_id = ?1 AND c.asset_id = ?2 AND c.asset_type = ?3 AND c.status = 'resolved' AND c.local_action = 'put' AND c.local_ciphertext = ?4 AND c.local_nonce = ?5 AND c.remote_revision = ?6 AND c.local_revision != ?7 AND c.local_schema_version = ?8 AND c.local_key_generation = ?9 AND EXISTS (SELECT 1 FROM cloud_sync_operations o WHERE o.cloud_account_id = c.cloud_account_id AND o.asset_id = c.asset_id AND o.asset_type = c.asset_type AND o.action = 'put' AND o.status IN ('applied', 'unknown') AND o.expected_revision = c.remote_revision AND o.nonce = c.local_nonce AND o.ciphertext = c.local_ciphertext AND o.payload_hash = c.local_payload_hash AND o.schema_version = c.local_schema_version AND o.key_generation = c.local_key_generation) LIMIT 1"
    ).bind(account).bind(&asset.id).bind(&asset.asset_type).bind(&encryption.ciphertext).bind(&encryption.nonce)
        .bind(revision - 1).bind(revision).bind(i64::from(asset.schema_version)).bind(i64::try_from(asset.key_generation).unwrap_or(-1))
        .fetch_optional(pool).await?;
    let Some(row) = row else { return Ok(None) };
    // This decrypts using the recorded original AAD, then authenticates the new revision.
    let mut prepared = prepare_local_candidate(account, &row, revision, keys)?;
    if prepared.payload_hash.as_deref() != Some(row.local_payload_hash.as_str()) {
        return Err(AppError::validation(
            "Legacy conflict candidate hash mismatch",
        ));
    }
    // Reuse a previously staged repair verbatim after a transport failure/restart.
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(serde_json::to_vec(&(
        "legacy-keep-local-repair-v1",
        account,
        &asset.id,
        revision,
        &row.id,
    ))?);
    let mut bytes = [0; 16];
    bytes.copy_from_slice(&digest[..16]);
    prepared.operation_id = Uuid::from_bytes(bytes).to_string();
    if let Some(existing) = CloudSyncRepository::get_operation(pool, &prepared.operation_id).await?
    {
        if existing.expected_revision != Some(revision as u64)
            || existing.payload_hash != prepared.payload_hash
            || existing.cloud_account_id != account
            || existing.asset_id != asset.id
        {
            return Err(AppError::validation("Legacy repair operation mismatch"));
        }
        prepared.nonce = existing.nonce;
        prepared.ciphertext = existing.ciphertext;
    }
    Ok(Some(prepared))
}

async fn apply_candidate(
    pool: &SqlitePool,
    account: &str,
    row: &ConflictRow,
    local: bool,
    keys: &CommittedSyncKeyBundle,
) -> AppResult<()> {
    let tombstone = !local && row.remote_tombstone != 0;
    if tombstone {
        if row.asset_type == "connection" {
            sqlx::query("DELETE FROM connections WHERE id = ?1")
                .bind(&row.asset_id)
                .execute(pool)
                .await?;
        } else {
            let children: i64 = sqlx::query_scalar("SELECT (SELECT COUNT(1) FROM connections WHERE folder_id = ?1) + (SELECT COUNT(1) FROM connection_folders WHERE parent_id = ?1)").bind(&row.asset_id).fetch_one(pool).await?;
            if children > 0 {
                return Err(AppError::validation("文件夹仍包含内容，无法接受删除"));
            }
            sqlx::query("DELETE FROM connection_folders WHERE id = ?1")
                .bind(&row.asset_id)
                .execute(pool)
                .await?;
        }
        return Ok(());
    }
    let (ciphertext, nonce, revision, schema, generation) = if local {
        (
            row.local_ciphertext.as_str(),
            row.local_nonce.as_str(),
            row.local_revision
                .ok_or_else(|| AppError::validation("Local conflict revision missing"))?,
            row.local_schema_version
                .ok_or_else(|| AppError::validation("Local conflict schema missing"))?,
            row.local_key_generation
                .ok_or_else(|| AppError::validation("Local conflict key generation missing"))?,
        )
    } else {
        (
            row.remote_ciphertext.as_str(),
            row.remote_nonce.as_str(),
            row.remote_revision,
            row.remote_schema_version,
            row.remote_key_generation,
        )
    };
    let encryption = crate::cloud::types::CloudConnectionAssetEncryption {
        suite: CONNECTION_ASSET_SUITE.to_string(),
        nonce: nonce.to_string(),
        ciphertext: ciphertext.to_string(),
    };
    let bytes = decrypt_connection_asset(
        account,
        &row.asset_id,
        &row.asset_type,
        u64::try_from(revision).map_err(|_| AppError::validation("Invalid revision"))?,
        u16::try_from(schema).map_err(|_| AppError::validation("Invalid schema"))?,
        u64::try_from(generation).map_err(|_| AppError::validation("Invalid key generation"))?,
        &encryption,
        &keys.amk,
    )
    .map_err(|_| AppError::validation("无法解密冲突候选"))?;
    let value: Value = serde_json::from_slice(&bytes)?;
    if row.asset_type == "connection" {
        let projection: ConnectionSyncProjection = serde_json::from_value(value)?;
        let current = ConnectionRepository::get(pool, &projection.id).await?;
        let payload = merge_local_paths(
            &projection.payload,
            current.as_ref().map(|v| &v.payload),
            &projection.local_dependencies,
        );
        let input = UpdateConnectionInput {
            id: projection.id.clone(),
            name: projection.name,
            driver: ConnectionDriver::from_str(&projection.driver)?,
            environment: projection.environment,
            color: projection.color,
            note: projection.note,
            tag_label: projection.tag_label,
            tag_color: projection.tag_color,
            payload,
            folder_id: projection.folder_id,
            sort_order: projection.sort_order,
        };
        if current.is_some() {
            ConnectionRepository::update(pool, input).await?;
        } else {
            ConnectionRepository::create(
                pool,
                CreateConnectionInput {
                    id: input.id,
                    name: input.name,
                    driver: input.driver,
                    environment: input.environment,
                    color: input.color,
                    note: input.note,
                    tag_label: input.tag_label,
                    tag_color: input.tag_color,
                    payload: input.payload,
                    folder_id: input.folder_id,
                    sort_order: input.sort_order,
                },
            )
            .await?;
        }
    } else {
        let projection: ConnectionFolderSyncProjection = serde_json::from_slice(&bytes)?;
        if ConnectionFolderRepository::get(pool, &projection.id)
            .await?
            .is_some()
        {
            ConnectionFolderRepository::update(
                pool,
                crate::repository::connection_folder_repository::UpdateConnectionFolderInput {
                    id: projection.id,
                    name: projection.name,
                    parent_id: projection.parent_id,
                    sort_order: projection.sort_order,
                },
            )
            .await?;
        } else {
            ConnectionFolderRepository::create(
                pool,
                CreateConnectionFolderInput {
                    id: projection.id,
                    name: projection.name,
                    parent_id: projection.parent_id,
                    sort_order: projection.sort_order,
                },
            )
            .await?;
        }
    }
    Ok(())
}

async fn duplicate_local_candidate(
    pool: &SqlitePool,
    account: &str,
    row: &ConflictRow,
    keys: &CommittedSyncKeyBundle,
) -> AppResult<()> {
    let old_id = row.asset_id.clone();
    let encryption = crate::cloud::types::CloudConnectionAssetEncryption {
        suite: CONNECTION_ASSET_SUITE.to_string(),
        nonce: row.local_nonce.clone(),
        ciphertext: row.local_ciphertext.clone(),
    };
    let bytes = decrypt_connection_asset(
        account,
        &old_id,
        "connection",
        u64::try_from(
            row.local_revision
                .ok_or_else(|| AppError::validation("Local revision missing"))?,
        )
        .map_err(|_| AppError::validation("Invalid revision"))?,
        u16::try_from(
            row.local_schema_version
                .ok_or_else(|| AppError::validation("Local schema missing"))?,
        )
        .map_err(|_| AppError::validation("Invalid schema"))?,
        u64::try_from(
            row.local_key_generation
                .ok_or_else(|| AppError::validation("Local key generation missing"))?,
        )
        .map_err(|_| AppError::validation("Invalid key generation"))?,
        &encryption,
        &keys.amk,
    )
    .map_err(|_| AppError::validation("无法解密本机候选"))?;
    let projection: ConnectionSyncProjection = serde_json::from_slice(&bytes)?;
    let new_id = Uuid::new_v4().to_string();
    let current = ConnectionRepository::get(pool, &old_id).await?;
    let payload = merge_local_paths(
        &projection.payload,
        current.as_ref().map(|record| &record.payload),
        &projection.local_dependencies,
    );
    ConnectionRepository::create(
        pool,
        CreateConnectionInput {
            id: new_id.clone(),
            name: format!("{}（本机版本）", projection.name),
            driver: ConnectionDriver::from_str(&projection.driver)?,
            environment: projection.environment,
            color: projection.color,
            note: projection.note,
            tag_label: projection.tag_label,
            tag_color: projection.tag_color,
            payload,
            folder_id: projection.folder_id,
            sort_order: None,
        },
    )
    .await?;
    CloudSyncRepository::upsert_asset(
        pool,
        crate::repository::cloud_sync_repository::UpsertCloudSyncAssetMetadata {
            cloud_account_id: account.to_string(),
            asset_id: new_id.clone(),
            asset_type: crate::repository::cloud_sync_repository::CloudSyncAssetType::Connection,
            local_entity_id: new_id,
            remote_revision: None,
            base_revision: None,
            sync_status: CloudSyncAssetStatus::LocalOnly,
            last_error_code: None,
            last_error_at: None,
            last_attempt_at: None,
            pending_operation_id: None,
            tombstone: false,
            conflict_of: Some(old_id),
            local_payload_hash: None,
        },
    )
    .await?;
    Ok(())
}

pub async fn list_local_dependencies(
    pool: &SqlitePool,
    cloud_account_id: &str,
) -> AppResult<CloudLocalDependencyList> {
    let assets = CloudSyncRepository::list_assets_by_status(
        pool,
        cloud_account_id,
        CloudSyncAssetStatus::NeedsLocalFile,
    )
    .await?;
    let mut items = Vec::new();
    for asset in assets {
        if asset.asset_type
            != crate::repository::cloud_sync_repository::CloudSyncAssetType::Connection
        {
            continue;
        }
        let Some(record) = ConnectionRepository::get(pool, &asset.local_entity_id).await? else {
            continue;
        };
        for dependency in collect_local_dependencies(&record.driver, &record.payload) {
            let current_path = dependency_path(&record.payload, &dependency)
                .filter(|value| !value.trim().is_empty());
            if current_path.is_none() {
                items.push(CloudLocalDependency {
                    asset_id: record.id.clone(),
                    asset_name: record.name.clone(),
                    dependency,
                    current_path,
                });
            }
        }
    }
    Ok(CloudLocalDependencyList {
        cloud_account_id: cloud_account_id.to_string(),
        items,
    })
}

pub async fn complete_local_dependency(
    pool: &SqlitePool,
    cloud_account_id: &str,
    asset_id: &str,
    dependency: LocalDependencyKind,
    local_path: &str,
) -> AppResult<CloudLocalDependencyList> {
    let local_path = local_path.trim();
    if local_path.is_empty()
        || local_path.chars().count() > 4096
        || local_path.chars().any(char::is_control)
    {
        return Err(AppError::validation(
            "Local path cannot be empty or contain control characters",
        ));
    }
    let asset = CloudSyncRepository::get_asset(pool, cloud_account_id, asset_id)
        .await?
        .ok_or_else(|| AppError::not_found("Cloud sync asset was not found"))?;
    if asset.asset_type != crate::repository::cloud_sync_repository::CloudSyncAssetType::Connection
    {
        return Err(AppError::validation(
            "Only connection local paths can be completed",
        ));
    }
    let record = ConnectionRepository::get(pool, &asset.local_entity_id)
        .await?
        .ok_or_else(|| AppError::not_found("Local connection was not found"))?;
    let required = collect_local_dependencies(&record.driver, &record.payload);
    if !required.contains(&dependency) {
        return Err(AppError::validation(
            "This connection does not declare that local dependency",
        ));
    }
    let mut payload = record.payload.clone();
    set_dependency_path(&mut payload, &dependency, local_path)?;
    ConnectionRepository::update(
        pool,
        UpdateConnectionInput {
            id: record.id.clone(),
            name: record.name.clone(),
            driver: record.driver.clone(),
            environment: record.environment.clone(),
            color: record.color.clone(),
            note: record.note.clone(),
            tag_label: record.tag_label.clone(),
            tag_color: record.tag_color.clone(),
            payload,
            folder_id: record.folder_id.clone(),
            sort_order: record.sort_order,
        },
    )
    .await?;

    let updated = ConnectionRepository::get(pool, &record.id)
        .await?
        .ok_or_else(|| AppError::not_found("Updated local connection was not found"))?;
    let complete = required.iter().all(|kind| {
        dependency_path(&updated.payload, kind).is_some_and(|value| !value.trim().is_empty())
    });
    if complete {
        sqlx::query(
            "UPDATE cloud_sync_assets SET sync_status = 'synced', updated_at = strftime('%s','now') * 1000 WHERE cloud_account_id = ?1 AND asset_id = ?2 AND sync_status = 'needs_local_file'",
        )
        .bind(cloud_account_id)
        .bind(asset_id)
        .execute(pool)
        .await?;
    }
    list_local_dependencies(pool, cloud_account_id).await
}

fn dependency_path(payload: &Value, dependency: &LocalDependencyKind) -> Option<String> {
    let path = match dependency {
        LocalDependencyKind::DatabaseFile if payload.get("localConfig").is_some() => {
            &["localConfig", "dbFilePath"][..]
        }
        LocalDependencyKind::DatabaseFile => &["dbFilePath"][..],
        LocalDependencyKind::SshPrivateKey => &["sshTunnel", "privateKeyPath"][..],
    };
    let mut current = payload;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(ToOwned::to_owned)
}

fn set_dependency_path(
    payload: &mut Value,
    dependency: &LocalDependencyKind,
    local_path: &str,
) -> AppResult<()> {
    let keys = match dependency {
        LocalDependencyKind::DatabaseFile if payload.get("localConfig").is_some() => {
            &["localConfig", "dbFilePath"][..]
        }
        LocalDependencyKind::DatabaseFile => &["dbFilePath"][..],
        LocalDependencyKind::SshPrivateKey => &["sshTunnel", "privateKeyPath"][..],
    };
    let mut current = payload;
    for key in &keys[..keys.len() - 1] {
        current = current
            .get_mut(*key)
            .ok_or_else(|| AppError::validation("Local path field is unavailable"))?;
    }
    current
        .as_object_mut()
        .ok_or_else(|| AppError::validation("Local path field is unavailable"))?
        .insert(
            keys[keys.len() - 1].to_string(),
            Value::String(local_path.to_string()),
        );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::sync_crypto::encrypt_connection_asset;
    use crate::cloud::sync_projection::{connection_projection, SYNC_SCHEMA_VERSION};
    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    const ASSET: &str = "0198f5dc-0000-7000-8000-000000000003";
    fn keys() -> CommittedSyncKeyBundle {
        CommittedSyncKeyBundle {
            cloud_account_id: "account-1".into(),
            device_id: "0198f5dc-0000-7000-8000-000000000002".into(),
            key_generation: 1,
            amk: [7; 32],
            encryption_private_key: [2; 32],
            signing_private_key: [3; 32],
        }
    }

    async fn fixture() -> (SqlitePool, Vec<u8>) {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().in_memory(true))
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query("INSERT INTO connections (id,name,driver,payload) VALUES (?1,'Local','postgres','{\"host\":\"local.example\"}')").bind(ASSET).execute(&pool).await.unwrap();
        let local = ConnectionRepository::get(&pool, ASSET)
            .await
            .unwrap()
            .unwrap();
        let (local_bytes, local_hash) = connection_projection(&local).unwrap();
        let mut remote = local.clone();
        remote.name = "Cloud".into();
        remote.payload = json!({"host":"cloud.example"});
        let (remote_bytes, remote_hash) = connection_projection(&remote).unwrap();
        let local_enc = encrypt_connection_asset(
            "account-1",
            ASSET,
            "connection",
            2,
            1,
            1,
            &local_bytes,
            &keys().amk,
        )
        .unwrap();
        let remote_enc = encrypt_connection_asset(
            "account-1",
            ASSET,
            "connection",
            3,
            1,
            1,
            &remote_bytes,
            &keys().amk,
        )
        .unwrap();
        sqlx::query("INSERT INTO cloud_sync_assets (cloud_account_id,asset_id,asset_type,local_entity_id,remote_revision,base_revision,sync_status,local_payload_hash) VALUES ('account-1',?1,'connection',?1,3,1,'conflicted',?2)")
            .bind(ASSET).bind(local_hash.as_base64url()).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO cloud_sync_conflicts (id,cloud_account_id,asset_id,asset_type,remote_revision,local_ciphertext,remote_ciphertext,local_nonce,remote_nonce,local_payload_hash,remote_payload_hash,local_revision,local_schema_version,local_key_generation) VALUES ('conflict-1','account-1',?1,'connection',3,?2,?3,?4,?5,?6,?7,2,1,1)")
            .bind(ASSET).bind(local_enc.ciphertext).bind(remote_enc.ciphertext).bind(local_enc.nonce).bind(remote_enc.nonce)
            .bind(local_hash.as_base64url()).bind(remote_hash.as_base64url()).execute(&pool).await.unwrap();
        (pool, local_bytes)
    }

    #[tokio::test]
    async fn keep_local_reencrypts_for_the_new_cloud_revision() {
        let (pool, original) = fixture().await;
        resolve_conflict(
            &pool,
            "account-1",
            "conflict-1",
            CloudSyncConflictDecision::KeepLocal,
            &keys(),
        )
        .await
        .unwrap();
        let operations = CloudSyncRepository::list_pending_operations(&pool, "account-1")
            .await
            .unwrap();
        assert_eq!(operations.len(), 1);
        let op = &operations[0];
        assert_eq!(op.expected_revision, Some(3));
        let plaintext = decrypt_connection_asset(
            "account-1",
            ASSET,
            "connection",
            4,
            SYNC_SCHEMA_VERSION as u16,
            1,
            &crate::cloud::types::CloudConnectionAssetEncryption {
                suite: CONNECTION_ASSET_SUITE.into(),
                nonce: op.nonce.clone().unwrap(),
                ciphertext: op.ciphertext.clone().unwrap(),
            },
            &keys().amk,
        )
        .unwrap();
        assert_eq!(plaintext, original);
    }

    #[tokio::test]
    async fn repairs_only_exact_legacy_uploads_and_reuses_staged_ciphertext() {
        use crate::cloud::types::{CloudConnectionAssetEncryption, CloudConnectionAssetProjection};
        let (pool, original) = fixture().await;
        let (nonce, ciphertext, hash): (String, String, String) = sqlx::query_as(
            "SELECT local_nonce,local_ciphertext,local_payload_hash FROM cloud_sync_conflicts WHERE id='conflict-1'"
        ).fetch_one(&pool).await.unwrap();
        let mut asset = CloudConnectionAssetProjection {
            id: ASSET.into(),
            asset_type: "connection".into(),
            revision: "4".into(),
            parent_revision: Some("3".into()),
            change_cursor: "34".into(),
            schema_version: 1,
            key_generation: 1,
            encryption: Some(CloudConnectionAssetEncryption {
                suite: CONNECTION_ASSET_SUITE.into(),
                nonce: nonce.clone(),
                ciphertext: ciphertext.clone(),
            }),
            encrypted_bytes: 0,
            tombstone: false,
            updated_by_device_id: keys().device_id.clone(),
            created_at: "2026-09-07T00:00:00.000Z".into(),
            updated_at: "2026-09-07T00:00:00.000Z".into(),
            deleted_at: None,
        };
        assert!(
            prepare_legacy_conflict_repair(&pool, "account-1", &asset, &keys())
                .await
                .unwrap()
                .is_none()
        );
        sqlx::query("UPDATE cloud_sync_conflicts SET status='resolved' WHERE id='conflict-1'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            prepare_legacy_conflict_repair(&pool, "account-1", &asset, &keys())
                .await
                .unwrap()
                .is_none()
        );
        // Reproduce the old writer: ciphertext authenticated revision 2, CAS requests revision 4.
        sqlx::query("INSERT INTO cloud_sync_operations (operation_id,cloud_account_id,asset_id,asset_type,action,expected_revision,schema_version,key_generation,nonce,ciphertext,payload_hash,status) VALUES ('legacy-upload','account-1',?1,'connection','put',3,1,1,?2,?3,?4,'applied')")
            .bind(ASSET).bind(&nonce).bind(&ciphertext).bind(&hash).execute(&pool).await.unwrap();
        assert!(decrypt_connection_asset(
            "account-1",
            ASSET,
            "connection",
            4,
            1,
            1,
            asset.encryption.as_ref().unwrap(),
            &keys().amk
        )
        .is_err());
        let repair = prepare_legacy_conflict_repair(&pool, "account-1", &asset, &keys())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(repair.expected_revision, Some(4));
        let encryption = CloudConnectionAssetEncryption {
            suite: CONNECTION_ASSET_SUITE.into(),
            nonce: repair.nonce.clone().unwrap(),
            ciphertext: repair.ciphertext.clone().unwrap(),
        };
        assert_eq!(
            decrypt_connection_asset(
                "account-1",
                ASSET,
                "connection",
                5,
                1,
                1,
                &encryption,
                &keys().amk
            )
            .unwrap(),
            original
        );
        let operation_id = repair.operation_id.clone();
        CloudSyncRepository::enqueue_operation(&pool, repair)
            .await
            .unwrap();
        let retried = prepare_legacy_conflict_repair(&pool, "account-1", &asset, &keys())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(retried.operation_id, operation_id);
        assert_eq!(
            retried.ciphertext.as_deref(),
            Some(encryption.ciphertext.as_str())
        );
        assert_eq!(retried.nonce.as_deref(), Some(encryption.nonce.as_str()));
        asset.updated_by_device_id = "other-device".into();
        assert!(
            prepare_legacy_conflict_repair(&pool, "account-1", &asset, &keys())
                .await
                .unwrap()
                .is_none()
        );
        asset.updated_by_device_id = keys().device_id.clone();
        asset.encryption.as_mut().unwrap().ciphertext.push('A');
        assert!(
            prepare_legacy_conflict_repair(&pool, "account-1", &asset, &keys())
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn keep_local_delete_does_not_require_or_reuse_ciphertext() {
        let (pool, _) = fixture().await;
        sqlx::query("UPDATE cloud_sync_conflicts SET local_action='delete',local_revision=NULL,local_schema_version=NULL,local_key_generation=NULL,local_nonce='',local_ciphertext='' WHERE id='conflict-1'").execute(&pool).await.unwrap();
        resolve_conflict(
            &pool,
            "account-1",
            "conflict-1",
            CloudSyncConflictDecision::KeepLocal,
            &keys(),
        )
        .await
        .unwrap();
        let ops = CloudSyncRepository::list_pending_operations(&pool, "account-1")
            .await
            .unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(
            ops[0].action,
            crate::repository::cloud_sync_repository::CloudSyncOperationAction::Delete
        );
        assert_eq!(ops[0].expected_revision, Some(3));
        assert!(ops[0].ciphertext.is_none());
    }

    #[tokio::test]
    async fn keep_both_preserves_distinct_connection_payloads() {
        let (pool, _) = fixture().await;
        resolve_conflict(
            &pool,
            "account-1",
            "conflict-1",
            CloudSyncConflictDecision::KeepBoth,
            &keys(),
        )
        .await
        .unwrap();
        let rows = ConnectionRepository::list(&pool).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows.iter().find(|r| r.id == ASSET).unwrap().payload["host"],
            "cloud.example"
        );
        assert_eq!(
            rows.iter().find(|r| r.id != ASSET).unwrap().payload["host"],
            "local.example"
        );
    }

    #[tokio::test]
    async fn keep_cloud_updates_the_synced_hash_and_base_revision() {
        let (pool, _) = fixture().await;
        resolve_conflict(
            &pool,
            "account-1",
            "conflict-1",
            CloudSyncConflictDecision::KeepCloud,
            &keys(),
        )
        .await
        .unwrap();
        let local = ConnectionRepository::get(&pool, ASSET)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(local.payload["host"], "cloud.example");
        let metadata = CloudSyncRepository::get_asset(&pool, "account-1", ASSET)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            metadata.local_payload_hash,
            Some(connection_projection(&local).unwrap().1.as_base64url())
        );
        assert_eq!(metadata.base_revision, Some(3));
    }
}
