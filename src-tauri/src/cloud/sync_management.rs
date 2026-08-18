use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use std::str::FromStr;
use uuid::Uuid;

use crate::cloud::sync_apply::merge_local_paths;
use crate::cloud::sync_crypto::{decrypt_connection_asset, CONNECTION_ASSET_SUITE};
use crate::cloud::sync_key_store::CommittedSyncKeyBundle;
use crate::cloud::sync_projection::{collect_local_dependencies, LocalDependencyKind};
use crate::cloud::sync_projection::{ConnectionFolderSyncProjection, ConnectionSyncProjection};
use crate::error::{AppError, AppResult};
use crate::repository::cloud_sync_repository::{
    CloudSyncAssetStatus, CloudSyncOperationAction, CloudSyncRepository, EnqueueCloudSyncOperation,
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
            mark_resolved(pool, cloud_account_id, &row.asset_id, conflict_id).await?;
        }
        CloudSyncConflictDecision::KeepLocal => {
            enqueue_local_candidate(pool, cloud_account_id, &row).await?;
            mark_conflict_resolved(pool, cloud_account_id, conflict_id).await?;
        }
        CloudSyncConflictDecision::KeepBoth => {
            apply_candidate(pool, cloud_account_id, &row, false, keys).await?;
            duplicate_local_candidate(pool, cloud_account_id, &row, keys).await?;
            mark_resolved(pool, cloud_account_id, &row.asset_id, conflict_id).await?;
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

async fn mark_resolved(
    pool: &SqlitePool,
    account: &str,
    asset_id: &str,
    conflict_id: &str,
) -> AppResult<()> {
    mark_conflict_resolved(pool, account, conflict_id).await?;
    sqlx::query("UPDATE cloud_sync_assets SET sync_status = 'synced', pending_operation_id = NULL, updated_at = strftime('%s','now') * 1000 WHERE cloud_account_id = ?1 AND asset_id = ?2")
        .bind(account).bind(asset_id).execute(pool).await?;
    Ok(())
}

async fn mark_conflict_resolved(
    pool: &SqlitePool,
    account: &str,
    conflict_id: &str,
) -> AppResult<()> {
    sqlx::query("UPDATE cloud_sync_conflicts SET status = 'resolved', updated_at = strftime('%s','now') * 1000 WHERE cloud_account_id = ?1 AND id = ?2")
        .bind(account).bind(conflict_id).execute(pool).await?;
    Ok(())
}

async fn enqueue_local_candidate(
    pool: &SqlitePool,
    account: &str,
    row: &ConflictRow,
) -> AppResult<()> {
    let operation_id = Uuid::new_v4().to_string();
    CloudSyncRepository::enqueue_operation(
        pool,
        EnqueueCloudSyncOperation {
            operation_id: operation_id.clone(),
            cloud_account_id: account.to_string(),
            asset_id: row.asset_id.clone(),
            asset_type: if row.asset_type == "connection" {
                crate::repository::cloud_sync_repository::CloudSyncAssetType::Connection
            } else {
                crate::repository::cloud_sync_repository::CloudSyncAssetType::ConnectionFolder
            },
            action: if row.local_action == "delete" {
                CloudSyncOperationAction::Delete
            } else {
                CloudSyncOperationAction::Put
            },
            expected_revision: u64::try_from(row.remote_revision).ok(),
            schema_version: row.local_schema_version.and_then(|v| u16::try_from(v).ok()),
            key_generation: row.local_key_generation.and_then(|v| u64::try_from(v).ok()),
            nonce: if row.local_nonce.is_empty() {
                None
            } else {
                Some(row.local_nonce.clone())
            },
            ciphertext: if row.local_ciphertext.is_empty() {
                None
            } else {
                Some(row.local_ciphertext.clone())
            },
            payload_hash: Some(row.local_payload_hash.clone()),
        },
    )
    .await?;
    sqlx::query("UPDATE cloud_sync_assets SET sync_status = 'pending_upload', pending_operation_id = ?3, updated_at = strftime('%s','now') * 1000 WHERE cloud_account_id = ?1 AND asset_id = ?2").bind(account).bind(&row.asset_id).bind(operation_id).execute(pool).await?;
    Ok(())
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
    let payload = current
        .map(|record| record.payload)
        .unwrap_or(projection.payload);
    ConnectionRepository::create(
        pool,
        CreateConnectionInput {
            id: new_id.clone(),
            name: format!("{}（本机版本）", projection.name),
            driver: ConnectionDriver::from_str(&projection.driver)?,
            environment: projection.environment,
            color: projection.color,
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
