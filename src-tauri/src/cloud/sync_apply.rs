use std::{collections::HashSet, str::FromStr};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use super::{
    sync_crypto::encrypt_connection_asset,
    sync_key_store::CommittedSyncKeyBundle,
    sync_projection::{
        connection_projection, folder_projection, ConnectionFolderSyncProjection,
        ConnectionSyncProjection, LocalDependencyKind, SYNC_SCHEMA_VERSION,
    },
    sync_pull::{DecryptedSyncProjection, ValidatedSyncChange, ValidatedSyncPage},
};
use crate::{
    error::{AppError, AppResult},
    repository::{
        cloud_sync_repository::CloudSyncOperationAction,
        connection_folder_repository::StoredConnectionFolder,
        connection_repository::{
            normalize_connection_note, ConnectionDriver, StoredConnectionRecord,
        },
    },
};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct SyncApplySummary {
    pub applied: usize,
    pub deleted: usize,
    pub conflicted: usize,
    pub ignored: usize,
    pub next_cursor: u64,
}

#[derive(Debug, FromRow)]
struct SyncAssetRow {
    local_entity_id: String,
    remote_revision: Option<i64>,
    base_revision: Option<i64>,
    sync_status: String,
    pending_operation_id: Option<String>,
    local_payload_hash: Option<String>,
}

#[derive(Debug, FromRow)]
struct PendingOperationRow {
    operation_id: String,
    action: String,
    expected_revision: Option<i64>,
    schema_version: Option<i64>,
    key_generation: Option<i64>,
    nonce: Option<String>,
    ciphertext: Option<String>,
    payload_hash: Option<String>,
}

#[derive(Debug, FromRow)]
struct LocalConnectionRow {
    id: String,
    name: String,
    driver: String,
    environment: String,
    color: Option<String>,
    note: String,
    tag_label: String,
    tag_color: Option<String>,
    payload: String,
    folder_id: Option<String>,
    sort_order: Option<i64>,
}

#[derive(Debug, FromRow)]
struct LocalFolderRow {
    id: String,
    name: String,
    parent_id: Option<String>,
    sort_order: Option<i64>,
}

struct LocalCandidate {
    action: CloudSyncOperationAction,
    revision: Option<u64>,
    schema_version: Option<u16>,
    key_generation: Option<u64>,
    nonce: String,
    ciphertext: String,
    payload_hash: String,
    operation_id: Option<String>,
}

/// Applies a fully validated Cloud page and advances its cursor in the same SQLite transaction.
/// A conflict is considered a successfully persisted outcome for that asset and therefore does not
/// block unrelated assets or cursor progress.
pub(crate) async fn apply_validated_page(
    pool: &SqlitePool,
    account_id: &str,
    page: ValidatedSyncPage,
    keys: &CommittedSyncKeyBundle,
) -> AppResult<SyncApplySummary> {
    if account_id != keys.cloud_account_id {
        return Err(AppError::validation(
            "Cloud sync account does not match the committed key bundle",
        ));
    }
    let mut transaction = pool.begin().await?;
    let durable_cursor = read_cursor(&mut transaction, account_id).await?;
    if durable_cursor != page.requested_cursor {
        return Err(AppError::validation(
            "Cloud sync page no longer starts at the durable cursor",
        ));
    }

    let mut changes = deduplicate_current_assets(page.items)?;
    changes.sort_by_key(apply_order);
    let mut summary = SyncApplySummary {
        next_cursor: page.next_cursor,
        ..SyncApplySummary::default()
    };
    for change in changes {
        apply_change(&mut transaction, account_id, change, keys, &mut summary).await?;
    }
    write_cursor(&mut transaction, account_id, page.next_cursor).await?;
    transaction.commit().await?;
    Ok(summary)
}

fn deduplicate_current_assets(
    changes: Vec<ValidatedSyncChange>,
) -> AppResult<Vec<ValidatedSyncChange>> {
    let mut seen = HashSet::new();
    let mut deduplicated = Vec::new();
    for change in changes.into_iter().rev() {
        let key = format!("{}:{}", change.asset.id, change.asset.revision);
        if seen.insert(key) {
            deduplicated.push(change);
        }
    }
    deduplicated.reverse();
    Ok(deduplicated)
}

fn apply_order(change: &ValidatedSyncChange) -> u8 {
    match (change.asset.tombstone, change.asset.asset_type.as_str()) {
        (false, "connection_folder") => 0,
        (false, "connection") => 1,
        (true, "connection") => 2,
        (true, "connection_folder") => 3,
        _ => 4,
    }
}

async fn apply_change(
    transaction: &mut Transaction<'_, Sqlite>,
    account_id: &str,
    change: ValidatedSyncChange,
    keys: &CommittedSyncKeyBundle,
    summary: &mut SyncApplySummary,
) -> AppResult<()> {
    let remote_revision = parse_positive(&change.asset.revision, "remote revision")?;
    let metadata = load_metadata(transaction, account_id, &change.asset.id).await?;
    if metadata
        .as_ref()
        .and_then(|value| value.remote_revision)
        .is_some_and(|value| value >= remote_revision as i64)
    {
        summary.ignored += 1;
        return Ok(());
    }
    let operation = load_pending_operation(transaction, account_id, &change.asset.id).await?;

    if let Some(operation) = operation.as_ref() {
        if operation_matches_remote(operation, &change, remote_revision)? {
            apply_remote_projection(transaction, account_id, &change, remote_revision).await?;
            mark_operation_applied(transaction, &operation.operation_id).await?;
            if change.asset.tombstone {
                summary.deleted += 1;
            } else {
                summary.applied += 1;
            }
            return Ok(());
        }
        let expected = operation.expected_revision.unwrap_or(0);
        if remote_revision <= expected as u64 {
            summary.ignored += 1;
            return Ok(());
        }
    }

    let local_fact_changed = local_fact_changed(transaction, metadata.as_ref(), &change).await?;
    let status_requires_conflict = metadata.as_ref().is_some_and(|value| {
        matches!(
            value.sync_status.as_str(),
            "local_only" | "pending_upload" | "pending_delete" | "conflicted"
        )
    });
    let local_entity_exists = local_entity_exists(transaction, &change).await?;
    let blocked_folder_delete = change.asset.tombstone
        && change.asset.asset_type == "connection_folder"
        && folder_has_children(transaction, &change.asset.id).await?;
    if operation.is_some()
        || status_requires_conflict
        || local_fact_changed
        || (metadata.is_none() && local_entity_exists)
        || blocked_folder_delete
    {
        persist_conflict(
            transaction,
            account_id,
            &change,
            remote_revision,
            metadata.as_ref(),
            operation.as_ref(),
            keys,
        )
        .await?;
        summary.conflicted += 1;
        return Ok(());
    }

    apply_remote_projection(transaction, account_id, &change, remote_revision).await?;
    if change.asset.tombstone {
        summary.deleted += 1;
    } else {
        summary.applied += 1;
    }
    Ok(())
}

async fn apply_remote_projection(
    transaction: &mut Transaction<'_, Sqlite>,
    account_id: &str,
    change: &ValidatedSyncChange,
    remote_revision: u64,
) -> AppResult<()> {
    if change.asset.tombstone {
        match change.asset.asset_type.as_str() {
            "connection" => {
                sqlx::query("DELETE FROM connections WHERE id = ?1")
                    .bind(&change.asset.id)
                    .execute(&mut **transaction)
                    .await?;
            }
            "connection_folder" => {
                sqlx::query("DELETE FROM connection_folders WHERE id = ?1")
                    .bind(&change.asset.id)
                    .execute(&mut **transaction)
                    .await?;
            }
            _ => return Err(AppError::validation("Unsupported sync asset type")),
        }
        upsert_metadata(
            transaction,
            account_id,
            change,
            remote_revision,
            "remote_deleted",
            None,
        )
        .await?;
        return Ok(());
    }

    let projection = change
        .projection
        .as_ref()
        .ok_or_else(|| AppError::validation("Active Cloud asset is missing its projection"))?;
    let mut status = "synced";
    match projection {
        DecryptedSyncProjection::ConnectionFolder(folder) => {
            ensure_parent_folder_exists(transaction, folder.parent_id.as_deref()).await?;
            upsert_folder(transaction, folder).await?;
        }
        DecryptedSyncProjection::Connection(connection) => {
            ensure_parent_folder_exists(transaction, connection.folder_id.as_deref()).await?;
            let existing_payload = load_connection_payload(transaction, &connection.id).await?;
            let payload = merge_local_paths(
                &connection.payload,
                existing_payload.as_ref(),
                &connection.local_dependencies,
            );
            if connection
                .local_dependencies
                .iter()
                .any(|kind| !dependency_is_present(&payload, kind))
            {
                status = "needs_local_file";
            }
            upsert_connection(transaction, connection, &payload).await?;
        }
    }
    upsert_metadata(
        transaction,
        account_id,
        change,
        remote_revision,
        status,
        change.payload_hash.as_deref(),
    )
    .await
}

async fn persist_conflict(
    transaction: &mut Transaction<'_, Sqlite>,
    account_id: &str,
    change: &ValidatedSyncChange,
    remote_revision: u64,
    metadata: Option<&SyncAssetRow>,
    operation: Option<&PendingOperationRow>,
    keys: &CommittedSyncKeyBundle,
) -> AppResult<()> {
    let local = build_local_candidate(
        transaction,
        account_id,
        change,
        remote_revision,
        operation,
        keys,
    )
    .await?;
    let (remote_nonce, remote_ciphertext) = change
        .asset
        .encryption
        .as_ref()
        .map(|value| (value.nonce.clone(), value.ciphertext.clone()))
        .unwrap_or_default();
    let remote_payload_hash = change
        .payload_hash
        .clone()
        .unwrap_or_else(empty_payload_hash);
    sqlx::query(
        r#"
        INSERT INTO cloud_sync_conflicts (
            id, cloud_account_id, asset_id, asset_type, base_revision, remote_revision,
            local_ciphertext, remote_ciphertext, local_nonce, remote_nonce,
            local_payload_hash, remote_payload_hash, local_action, local_revision,
            local_schema_version, local_key_generation, remote_schema_version,
            remote_key_generation, remote_tombstone, pending_operation_id
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                  ?14, ?15, ?16, ?17, ?18, ?19, ?20)
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
    .bind(Uuid::new_v4().to_string())
    .bind(account_id)
    .bind(&change.asset.id)
    .bind(&change.asset.asset_type)
    .bind(metadata.and_then(|value| value.base_revision))
    .bind(to_i64(remote_revision, "remote revision")?)
    .bind(local.ciphertext)
    .bind(remote_ciphertext)
    .bind(local.nonce)
    .bind(remote_nonce)
    .bind(&local.payload_hash)
    .bind(remote_payload_hash)
    .bind(match local.action {
        CloudSyncOperationAction::Put => "put",
        CloudSyncOperationAction::Delete => "delete",
    })
    .bind(
        local
            .revision
            .map(|value| to_i64(value, "local revision"))
            .transpose()?,
    )
    .bind(local.schema_version.map(i64::from))
    .bind(
        local
            .key_generation
            .map(|value| to_i64(value, "local key generation"))
            .transpose()?,
    )
    .bind(i64::from(change.asset.schema_version))
    .bind(to_i64(
        change.asset.key_generation,
        "remote key generation",
    )?)
    .bind(if change.asset.tombstone { 1_i64 } else { 0_i64 })
    .bind(local.operation_id.as_deref())
    .execute(&mut **transaction)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO cloud_sync_assets (
            cloud_account_id, asset_id, asset_type, local_entity_id,
            remote_revision, base_revision, sync_status, pending_operation_id,
            tombstone, local_payload_hash, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'conflicted', ?7, 0, ?8,
                  strftime('%s','now') * 1000)
        ON CONFLICT (cloud_account_id, asset_id) DO UPDATE SET
            remote_revision = excluded.remote_revision,
            sync_status = 'conflicted',
            pending_operation_id = excluded.pending_operation_id,
            tombstone = 0,
            local_payload_hash = excluded.local_payload_hash,
            updated_at = strftime('%s','now') * 1000
        "#,
    )
    .bind(account_id)
    .bind(&change.asset.id)
    .bind(&change.asset.asset_type)
    .bind(
        metadata
            .map(|value| value.local_entity_id.as_str())
            .unwrap_or(&change.asset.id),
    )
    .bind(to_i64(remote_revision, "remote revision")?)
    .bind(metadata.and_then(|value| value.base_revision))
    .bind(local.operation_id.as_deref())
    .bind(&local.payload_hash)
    .execute(&mut **transaction)
    .await?;
    if let Some(operation_id) = local.operation_id {
        sqlx::query(
            "UPDATE cloud_sync_operations SET status = 'conflicted', updated_at = strftime('%s','now') * 1000 WHERE operation_id = ?1",
        )
        .bind(operation_id)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}

async fn build_local_candidate(
    transaction: &mut Transaction<'_, Sqlite>,
    account_id: &str,
    change: &ValidatedSyncChange,
    remote_revision: u64,
    operation: Option<&PendingOperationRow>,
    keys: &CommittedSyncKeyBundle,
) -> AppResult<LocalCandidate> {
    if let Some(operation) = operation {
        let action = match operation.action.as_str() {
            "put" => CloudSyncOperationAction::Put,
            "delete" => CloudSyncOperationAction::Delete,
            _ => return Err(AppError::validation("Unsupported pending sync action")),
        };
        let revision = operation
            .expected_revision
            .unwrap_or(0)
            .checked_add(1)
            .and_then(|value| u64::try_from(value).ok());
        return Ok(LocalCandidate {
            action,
            revision,
            schema_version: operation
                .schema_version
                .map(u16::try_from)
                .transpose()
                .map_err(|_| AppError::validation("Invalid pending operation schema version"))?,
            key_generation: operation
                .key_generation
                .map(u64::try_from)
                .transpose()
                .map_err(|_| AppError::validation("Invalid pending operation key generation"))?,
            nonce: operation.nonce.clone().unwrap_or_default(),
            ciphertext: operation.ciphertext.clone().unwrap_or_default(),
            payload_hash: operation
                .payload_hash
                .clone()
                .unwrap_or_else(empty_payload_hash),
            operation_id: Some(operation.operation_id.clone()),
        });
    }

    if let Some(existing) =
        load_existing_conflict_candidate(transaction, account_id, &change.asset.id).await?
    {
        return Ok(existing);
    }
    let (plaintext, payload_hash) = load_local_projection(transaction, change).await?;
    let local_revision = remote_revision
        .checked_add(1)
        .ok_or_else(|| AppError::validation("Local candidate revision overflow"))?;
    let encrypted = encrypt_connection_asset(
        account_id,
        &change.asset.id,
        &change.asset.asset_type,
        local_revision,
        SYNC_SCHEMA_VERSION as u16,
        u64::from(keys.key_generation),
        &plaintext,
        &keys.amk,
    )
    .map_err(|_| AppError::validation("Failed to preserve the local conflict candidate"))?;
    Ok(LocalCandidate {
        action: CloudSyncOperationAction::Put,
        revision: Some(local_revision),
        schema_version: Some(SYNC_SCHEMA_VERSION as u16),
        key_generation: Some(u64::from(keys.key_generation)),
        nonce: encrypted.nonce,
        ciphertext: encrypted.ciphertext,
        payload_hash,
        operation_id: None,
    })
}

async fn load_existing_conflict_candidate(
    transaction: &mut Transaction<'_, Sqlite>,
    account_id: &str,
    asset_id: &str,
) -> AppResult<Option<LocalCandidate>> {
    let row = sqlx::query_as::<
        _,
        (
            String,
            Option<i64>,
            Option<i64>,
            Option<i64>,
            String,
            String,
            String,
            Option<String>,
        ),
    >(
        r#"
        SELECT local_action, local_revision, local_schema_version, local_key_generation,
               local_nonce, local_ciphertext, local_payload_hash, pending_operation_id
        FROM cloud_sync_conflicts
        WHERE cloud_account_id = ?1 AND asset_id = ?2 AND status = 'pending'
        ORDER BY remote_revision DESC
        LIMIT 1
        "#,
    )
    .bind(account_id)
    .bind(asset_id)
    .fetch_optional(&mut **transaction)
    .await?;
    row.map(|row| {
        Ok(LocalCandidate {
            action: if row.0 == "delete" {
                CloudSyncOperationAction::Delete
            } else {
                CloudSyncOperationAction::Put
            },
            revision: row
                .1
                .map(u64::try_from)
                .transpose()
                .map_err(|_| AppError::validation("Invalid stored local revision"))?,
            schema_version: row
                .2
                .map(u16::try_from)
                .transpose()
                .map_err(|_| AppError::validation("Invalid stored schema version"))?,
            key_generation: row
                .3
                .map(u64::try_from)
                .transpose()
                .map_err(|_| AppError::validation("Invalid stored key generation"))?,
            nonce: row.4,
            ciphertext: row.5,
            payload_hash: row.6,
            operation_id: row.7,
        })
    })
    .transpose()
}

async fn load_local_projection(
    transaction: &mut Transaction<'_, Sqlite>,
    change: &ValidatedSyncChange,
) -> AppResult<(Vec<u8>, String)> {
    match change.asset.asset_type.as_str() {
        "connection" => {
            let row = load_connection(transaction, &change.asset.id)
                .await?
                .ok_or_else(|| AppError::not_found("Local conflict connection is missing"))?;
            let record = connection_record(row)?;
            let (bytes, digest) = connection_projection(&record)?;
            Ok((bytes, digest.as_base64url()))
        }
        "connection_folder" => {
            let row = load_folder(transaction, &change.asset.id)
                .await?
                .ok_or_else(|| AppError::not_found("Local conflict folder is missing"))?;
            let record = folder_record(row);
            let (bytes, digest) = folder_projection(&record)?;
            Ok((bytes, digest.as_base64url()))
        }
        _ => Err(AppError::validation("Unsupported sync asset type")),
    }
}

async fn local_fact_changed(
    transaction: &mut Transaction<'_, Sqlite>,
    metadata: Option<&SyncAssetRow>,
    change: &ValidatedSyncChange,
) -> AppResult<bool> {
    let Some(metadata) = metadata else {
        return Ok(false);
    };
    if metadata.sync_status != "synced" {
        return Ok(false);
    }
    let Some(expected_hash) = metadata.local_payload_hash.as_deref() else {
        return Ok(false);
    };
    let local = match load_local_projection(transaction, change).await {
        Ok(value) => value,
        Err(AppError::NotFound(_)) if change.asset.tombstone => return Ok(false),
        Err(error) => return Err(error),
    };
    Ok(local.1 != expected_hash)
}

async fn local_entity_exists(
    transaction: &mut Transaction<'_, Sqlite>,
    change: &ValidatedSyncChange,
) -> AppResult<bool> {
    let table = match change.asset.asset_type.as_str() {
        "connection" => "connections",
        "connection_folder" => "connection_folders",
        _ => return Err(AppError::validation("Unsupported sync asset type")),
    };
    let query = format!("SELECT COUNT(1) FROM {table} WHERE id = ?1");
    let count = sqlx::query_scalar::<_, i64>(&query)
        .bind(&change.asset.id)
        .fetch_one(&mut **transaction)
        .await?;
    Ok(count > 0)
}

async fn folder_has_children(
    transaction: &mut Transaction<'_, Sqlite>,
    folder_id: &str,
) -> AppResult<bool> {
    let count = sqlx::query_scalar::<_, i64>(
        "SELECT (SELECT COUNT(1) FROM connections WHERE folder_id = ?1) + (SELECT COUNT(1) FROM connection_folders WHERE parent_id = ?1)",
    )
    .bind(folder_id)
    .fetch_one(&mut **transaction)
    .await?;
    Ok(count > 0)
}

fn operation_matches_remote(
    operation: &PendingOperationRow,
    change: &ValidatedSyncChange,
    remote_revision: u64,
) -> AppResult<bool> {
    let expected_revision = u64::try_from(operation.expected_revision.unwrap_or(0))
        .map_err(|_| AppError::validation("Invalid pending operation revision"))?;
    if expected_revision.checked_add(1) != Some(remote_revision) {
        return Ok(false);
    }
    Ok(match operation.action.as_str() {
        "put" => {
            !change.asset.tombstone
                && operation.payload_hash.as_deref() == change.payload_hash.as_deref()
        }
        "delete" => change.asset.tombstone,
        _ => return Err(AppError::validation("Unsupported pending sync action")),
    })
}

async fn load_metadata(
    transaction: &mut Transaction<'_, Sqlite>,
    account_id: &str,
    asset_id: &str,
) -> AppResult<Option<SyncAssetRow>> {
    Ok(sqlx::query_as::<_, SyncAssetRow>(
        r#"
        SELECT local_entity_id, remote_revision, base_revision, sync_status,
               pending_operation_id, local_payload_hash
        FROM cloud_sync_assets
        WHERE cloud_account_id = ?1 AND asset_id = ?2
        "#,
    )
    .bind(account_id)
    .bind(asset_id)
    .fetch_optional(&mut **transaction)
    .await?)
}

async fn load_pending_operation(
    transaction: &mut Transaction<'_, Sqlite>,
    account_id: &str,
    asset_id: &str,
) -> AppResult<Option<PendingOperationRow>> {
    Ok(sqlx::query_as::<_, PendingOperationRow>(
        r#"
        SELECT operation_id, action, expected_revision, schema_version, key_generation,
               nonce, ciphertext, payload_hash
        FROM cloud_sync_operations
        WHERE cloud_account_id = ?1 AND asset_id = ?2
          AND status IN ('pending', 'unknown', 'conflicted')
        ORDER BY created_at DESC, operation_id DESC
        LIMIT 1
        "#,
    )
    .bind(account_id)
    .bind(asset_id)
    .fetch_optional(&mut **transaction)
    .await?)
}

async fn upsert_folder(
    transaction: &mut Transaction<'_, Sqlite>,
    projection: &ConnectionFolderSyncProjection,
) -> AppResult<()> {
    sqlx::query(
        r#"
        INSERT INTO connection_folders (id, name, parent_id, created_at, updated_at, sort_order)
        VALUES (?1, ?2, ?3, strftime('%s','now') * 1000, strftime('%s','now') * 1000, ?4)
        ON CONFLICT (id) DO UPDATE SET
            name = excluded.name,
            parent_id = excluded.parent_id,
            sort_order = excluded.sort_order,
            updated_at = strftime('%s','now') * 1000
        "#,
    )
    .bind(&projection.id)
    .bind(&projection.name)
    .bind(projection.parent_id.as_deref())
    .bind(projection.sort_order)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn upsert_connection(
    transaction: &mut Transaction<'_, Sqlite>,
    projection: &ConnectionSyncProjection,
    payload: &Value,
) -> AppResult<()> {
    ConnectionDriver::from_str(&projection.driver)?;
    let note = normalize_connection_note(&projection.note)?;
    let payload = serde_json::to_string(payload)?;
    sqlx::query(
        r#"
        INSERT INTO connections (
            id, name, driver, environment, color, note, tag_label, tag_color, payload,
            folder_id, created_at, updated_at, sort_order
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                  strftime('%s','now') * 1000, strftime('%s','now') * 1000, ?11)
        ON CONFLICT (id) DO UPDATE SET
            name = excluded.name,
            driver = excluded.driver,
            environment = excluded.environment,
            color = excluded.color,
            note = excluded.note,
            tag_label = excluded.tag_label,
            tag_color = excluded.tag_color,
            payload = excluded.payload,
            folder_id = excluded.folder_id,
            sort_order = excluded.sort_order,
            updated_at = strftime('%s','now') * 1000
        "#,
    )
    .bind(&projection.id)
    .bind(&projection.name)
    .bind(&projection.driver)
    .bind(&projection.environment)
    .bind(projection.color.as_deref())
    .bind(&note)
    .bind(&projection.tag_label)
    .bind(projection.tag_color.as_deref())
    .bind(payload)
    .bind(projection.folder_id.as_deref())
    .bind(projection.sort_order)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn upsert_metadata(
    transaction: &mut Transaction<'_, Sqlite>,
    account_id: &str,
    change: &ValidatedSyncChange,
    remote_revision: u64,
    status: &str,
    payload_hash: Option<&str>,
) -> AppResult<()> {
    sqlx::query(
        r#"
        INSERT INTO cloud_sync_assets (
            cloud_account_id, asset_id, asset_type, local_entity_id,
            remote_revision, base_revision, sync_status, pending_operation_id,
            tombstone, local_payload_hash, updated_at
        ) VALUES (?1, ?2, ?3, ?2, ?4, ?4, ?5, NULL, ?6, ?7,
                  strftime('%s','now') * 1000)
        ON CONFLICT (cloud_account_id, asset_id) DO UPDATE SET
            asset_type = excluded.asset_type,
            remote_revision = excluded.remote_revision,
            base_revision = excluded.base_revision,
            sync_status = excluded.sync_status,
            last_error_code = NULL,
            last_error_at = NULL,
            pending_operation_id = NULL,
            tombstone = excluded.tombstone,
            local_payload_hash = excluded.local_payload_hash,
            updated_at = strftime('%s','now') * 1000
        "#,
    )
    .bind(account_id)
    .bind(&change.asset.id)
    .bind(&change.asset.asset_type)
    .bind(to_i64(remote_revision, "remote revision")?)
    .bind(status)
    .bind(if change.asset.tombstone { 1_i64 } else { 0_i64 })
    .bind(payload_hash)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn mark_operation_applied(
    transaction: &mut Transaction<'_, Sqlite>,
    operation_id: &str,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE cloud_sync_operations SET status = 'applied', last_error_code = NULL, updated_at = strftime('%s','now') * 1000 WHERE operation_id = ?1",
    )
    .bind(operation_id)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn read_cursor(
    transaction: &mut Transaction<'_, Sqlite>,
    account_id: &str,
) -> AppResult<u64> {
    let cursor = sqlx::query_scalar::<_, i64>(
        "SELECT cursor FROM cloud_sync_cursors WHERE cloud_account_id = ?1",
    )
    .bind(account_id)
    .fetch_optional(&mut **transaction)
    .await?
    .unwrap_or(0);
    u64::try_from(cursor).map_err(|_| AppError::validation("Cloud sync cursor is negative"))
}

async fn write_cursor(
    transaction: &mut Transaction<'_, Sqlite>,
    account_id: &str,
    cursor: u64,
) -> AppResult<()> {
    sqlx::query(
        r#"
        INSERT INTO cloud_sync_cursors (cloud_account_id, cursor, updated_at)
        VALUES (?1, ?2, strftime('%s','now') * 1000)
        ON CONFLICT (cloud_account_id) DO UPDATE SET
            cursor = excluded.cursor,
            updated_at = strftime('%s','now') * 1000
        "#,
    )
    .bind(account_id)
    .bind(to_i64(cursor, "cursor")?)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn ensure_parent_folder_exists(
    transaction: &mut Transaction<'_, Sqlite>,
    folder_id: Option<&str>,
) -> AppResult<()> {
    let Some(folder_id) = folder_id else {
        return Ok(());
    };
    let exists =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(1) FROM connection_folders WHERE id = ?1")
            .bind(folder_id)
            .fetch_one(&mut **transaction)
            .await?;
    if exists == 0 {
        return Err(AppError::validation(
            "Cloud sync projection references a missing parent folder",
        ));
    }
    Ok(())
}

async fn load_connection_payload(
    transaction: &mut Transaction<'_, Sqlite>,
    id: &str,
) -> AppResult<Option<Value>> {
    let payload = sqlx::query_scalar::<_, String>("SELECT payload FROM connections WHERE id = ?1")
        .bind(id)
        .fetch_optional(&mut **transaction)
        .await?;
    payload
        .map(|value| serde_json::from_str(&value))
        .transpose()
        .map_err(Into::into)
}

async fn load_connection(
    transaction: &mut Transaction<'_, Sqlite>,
    id: &str,
) -> AppResult<Option<LocalConnectionRow>> {
    Ok(sqlx::query_as::<_, LocalConnectionRow>(
        r#"
        SELECT id, name, driver, environment, color, note, tag_label, tag_color,
               payload, folder_id, sort_order
        FROM connections WHERE id = ?1
        "#,
    )
    .bind(id)
    .fetch_optional(&mut **transaction)
    .await?)
}

async fn load_folder(
    transaction: &mut Transaction<'_, Sqlite>,
    id: &str,
) -> AppResult<Option<LocalFolderRow>> {
    Ok(sqlx::query_as::<_, LocalFolderRow>(
        "SELECT id, name, parent_id, sort_order FROM connection_folders WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(&mut **transaction)
    .await?)
}

fn connection_record(row: LocalConnectionRow) -> AppResult<StoredConnectionRecord> {
    Ok(StoredConnectionRecord {
        id: row.id,
        name: row.name,
        driver: ConnectionDriver::from_str(&row.driver)?,
        environment: row.environment,
        color: row.color,
        note: row.note,
        tag_label: row.tag_label,
        tag_color: row.tag_color,
        payload: serde_json::from_str(&row.payload)?,
        folder_id: row.folder_id,
        created_at: 0,
        updated_at: 0,
        last_connected_at: None,
        last_connection_status: None,
        last_connection_error: None,
        sort_order: row.sort_order,
    })
}

fn folder_record(row: LocalFolderRow) -> StoredConnectionFolder {
    StoredConnectionFolder {
        id: row.id,
        name: row.name,
        parent_id: row.parent_id,
        created_at: String::new(),
        updated_at: String::new(),
        sort_order: row.sort_order,
    }
}

pub(crate) fn merge_local_paths(
    remote: &Value,
    local: Option<&Value>,
    dependencies: &[LocalDependencyKind],
) -> Value {
    match (remote, local) {
        (Value::Object(remote), Some(Value::Object(local))) => {
            let mut merged = Map::new();
            for (key, value) in remote {
                merged.insert(
                    key.clone(),
                    merge_local_paths(value, local.get(key), dependencies),
                );
            }
            for key in ["dbFilePath", "privateKeyPath"] {
                let dependency_allowed = match key {
                    "dbFilePath" => dependencies
                        .iter()
                        .any(|kind| matches!(kind, LocalDependencyKind::DatabaseFile)),
                    "privateKeyPath" => dependencies
                        .iter()
                        .any(|kind| matches!(kind, LocalDependencyKind::SshPrivateKey)),
                    _ => false,
                };
                if dependency_allowed {
                    if let Some(value) = local.get(key) {
                        merged.insert(key.to_string(), value.clone());
                    }
                }
            }
            Value::Object(merged)
        }
        // 当前同步 Schema 的本地依赖只出现在对象字段中。数组没有稳定的
        // 资产身份，不能按 index 猜测路径属于哪个元素。
        (Value::Array(_), Some(Value::Array(_))) => remote.clone(),
        _ => remote.clone(),
    }
}

fn dependency_is_present(payload: &Value, dependency: &LocalDependencyKind) -> bool {
    match dependency {
        LocalDependencyKind::DatabaseFile => {
            non_empty_string_at(payload, &["dbFilePath"])
                || non_empty_string_at(payload, &["localConfig", "dbFilePath"])
        }
        LocalDependencyKind::SshPrivateKey => {
            non_empty_string_at(payload, &["sshTunnel", "privateKeyPath"])
        }
    }
}

fn non_empty_string_at(value: &Value, path: &[&str]) -> bool {
    let mut current = value;
    for key in path {
        let Some(next) = current.get(*key) else {
            return false;
        };
        current = next;
    }
    current
        .as_str()
        .is_some_and(|value| !value.trim().is_empty())
}

fn parse_positive(value: &str, field: &str) -> AppResult<u64> {
    let value = value
        .parse::<u64>()
        .map_err(|_| AppError::validation(format!("Invalid Cloud sync {field}")))?;
    if value == 0 {
        return Err(AppError::validation(format!(
            "Cloud sync {field} must be positive"
        )));
    }
    Ok(value)
}

fn to_i64(value: u64, field: &str) -> AppResult<i64> {
    i64::try_from(value)
        .map_err(|_| AppError::validation(format!("Cloud sync {field} exceeds SQLite range")))
}

fn empty_payload_hash() -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest([]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::{
        sync_projection::ConnectionSyncProjection,
        sync_pull::{ValidatedSyncChange, ValidatedSyncPage},
        types::CloudConnectionAssetEncryption,
    };
    use crate::repository::cloud_sync_repository::CloudSyncAssetType;
    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    async fn pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    fn keys() -> CommittedSyncKeyBundle {
        CommittedSyncKeyBundle {
            cloud_account_id: "account-1".to_string(),
            device_id: "0198f5dc-0000-7000-8000-000000000002".to_string(),
            key_generation: 1,
            amk: [7; 32],
            encryption_private_key: [2; 32],
            signing_private_key: [3; 32],
        }
    }

    fn asset(
        asset_type: &str,
        id: &str,
        revision: &str,
        cursor: &str,
        tombstone: bool,
    ) -> super::super::types::CloudConnectionAssetProjection {
        super::super::types::CloudConnectionAssetProjection {
            id: id.to_string(),
            asset_type: asset_type.to_string(),
            revision: revision.to_string(),
            parent_revision: None,
            change_cursor: cursor.to_string(),
            schema_version: 1,
            key_generation: 1,
            encryption: (!tombstone).then(|| CloudConnectionAssetEncryption {
                suite: "XCHACHA20-POLY1305".to_string(),
                nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string(),
                ciphertext: "AQ".to_string(),
            }),
            encrypted_bytes: if tombstone { 0 } else { 17 },
            tombstone,
            updated_by_device_id: keys().device_id.clone(),
            created_at: "2026-08-08T00:00:00.000Z".to_string(),
            updated_at: "2026-08-08T00:00:00.000Z".to_string(),
            deleted_at: tombstone.then(|| "2026-08-08T00:00:00.000Z".to_string()),
        }
    }

    fn connection_change(id: &str, cursor: &str, name: &str) -> ValidatedSyncChange {
        let projection = ConnectionSyncProjection {
            schema_version: 1,
            asset_type: CloudSyncAssetType::Connection,
            id: id.to_string(),
            name: name.to_string(),
            driver: "postgres".to_string(),
            environment: "production".to_string(),
            color: None,
            note: "Production owner: data team".to_string(),
            tag_label: String::new(),
            tag_color: None,
            folder_id: None,
            sort_order: Some(1),
            payload: json!({"host":"db.example.com"}),
            local_dependencies: Vec::new(),
        };
        let plaintext = serde_json::to_vec(&projection).unwrap();
        ValidatedSyncChange {
            change_cursor: cursor.parse().unwrap(),
            asset: asset("connection", id, "1", cursor, false),
            projection: Some(DecryptedSyncProjection::Connection(projection)),
            payload_hash: Some(URL_SAFE_NO_PAD.encode(Sha256::digest(plaintext))),
        }
    }

    fn tombstone_change(asset_type: &str, id: &str, cursor: &str) -> ValidatedSyncChange {
        ValidatedSyncChange {
            change_cursor: cursor.parse().unwrap(),
            asset: asset(asset_type, id, "2", cursor, true),
            projection: None,
            payload_hash: None,
        }
    }

    fn page(items: Vec<ValidatedSyncChange>, next: u64) -> ValidatedSyncPage {
        ValidatedSyncPage {
            requested_cursor: 0,
            next_cursor: next,
            has_more: false,
            items,
        }
    }

    #[test]
    fn local_paths_are_not_reintroduced_without_a_declared_dependency() {
        let remote = json!({
            "driver": "postgres",
            "sshTunnel": { "enabled": false, "authMethod": "password" }
        });
        let local = json!({
            "driver": "sqlite",
            "dbFilePath": "C:/old/database.sqlite",
            "sshTunnel": {
                "enabled": false,
                "authMethod": "private-key",
                "privateKeyPath": "C:/old/id_ed25519"
            }
        });

        let merged = merge_local_paths(&remote, Some(&local), &[]);
        assert_eq!(merged, remote);
    }

    #[test]
    fn declared_dependencies_preserve_only_the_matching_local_path() {
        let remote = json!({
            "driver": "postgres",
            "sshTunnel": { "enabled": true, "authMethod": "private-key" }
        });
        let local = json!({
            "driver": "postgres",
            "dbFilePath": "C:/old/database.sqlite",
            "sshTunnel": { "privateKeyPath": "C:/local/id_ed25519" }
        });

        let merged =
            merge_local_paths(&remote, Some(&local), &[LocalDependencyKind::SshPrivateKey]);
        assert!(merged.get("dbFilePath").is_none());
        assert_eq!(merged["sshTunnel"]["privateKeyPath"], "C:/local/id_ed25519");
        assert!(dependency_is_present(
            &merged,
            &LocalDependencyKind::SshPrivateKey
        ));
    }

    #[test]
    fn array_positions_are_not_used_to_guess_local_paths() {
        let remote = json!([{ "name": "remote" }]);
        let local = json!([{ "dbFilePath": "C:/old/database.sqlite" }]);
        let merged = merge_local_paths(&remote, Some(&local), &[LocalDependencyKind::DatabaseFile]);
        assert_eq!(merged, remote);
    }

    #[tokio::test]
    async fn applies_remote_projection_and_advances_cursor_atomically() {
        let pool = pool().await;
        let id = "0198f5dc-0000-7000-8000-000000000003";
        let summary = apply_validated_page(
            &pool,
            "account-1",
            page(vec![connection_change(id, "1", "Remote")], 1),
            &keys(),
        )
        .await
        .unwrap();
        assert_eq!(summary.applied, 1);
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT cursor FROM cloud_sync_cursors WHERE cloud_account_id = 'account-1'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT name FROM connections WHERE id = ?1")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap(),
            "Remote"
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT note FROM connections WHERE id = ?1")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap(),
            "Production owner: data team"
        );
    }

    #[tokio::test]
    async fn applies_connection_tombstone_before_folder_tombstone() {
        let pool = pool().await;
        let folder_id = "0198f5dc-0000-7000-8000-000000000004";
        let connection_id = "0198f5dc-0000-7000-8000-000000000005";
        sqlx::query("INSERT INTO connection_folders (id, name) VALUES (?1, 'Folder')")
            .bind(folder_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO connections (id, name, driver, payload, folder_id) VALUES (?1, 'Connection', 'postgres', '{}', ?2)")
            .bind(connection_id)
            .bind(folder_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO cloud_sync_assets (cloud_account_id, asset_id, asset_type, local_entity_id, remote_revision, base_revision, sync_status) VALUES ('account-1', ?1, 'connection_folder', ?1, 1, 1, 'synced'), ('account-1', ?2, 'connection', ?2, 1, 1, 'synced')")
            .bind(folder_id)
            .bind(connection_id)
            .execute(&pool)
            .await
            .unwrap();
        let summary = apply_validated_page(
            &pool,
            "account-1",
            page(
                vec![
                    tombstone_change("connection_folder", folder_id, "2"),
                    tombstone_change("connection", connection_id, "1"),
                ],
                2,
            ),
            &keys(),
        )
        .await
        .unwrap();
        assert_eq!(summary.deleted, 2);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(1) FROM connections WHERE id = ?1")
                .bind(connection_id)
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(1) FROM connection_folders WHERE id = ?1")
                .bind(folder_id)
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn persists_conflict_and_marks_pending_operation_without_overwriting_local_data() {
        let pool = pool().await;
        let id = "0198f5dc-0000-7000-8000-000000000006";
        sqlx::query("INSERT INTO connections (id, name, driver, payload) VALUES (?1, 'Local', 'postgres', '{\"host\":\"local\"}')")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO cloud_sync_assets (cloud_account_id, asset_id, asset_type, local_entity_id, sync_status, local_payload_hash) VALUES ('account-1', ?1, 'connection', ?1, 'pending_upload', 'local-hash')")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO cloud_sync_operations (operation_id, cloud_account_id, asset_id, asset_type, action, expected_revision, schema_version, key_generation, nonce, ciphertext, payload_hash, status) VALUES ('op-1', 'account-1', ?1, 'connection', 'put', 1, 1, 1, 'local-nonce', 'local-ciphertext', 'local-hash', 'pending')")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        let mut remote = connection_change(id, "2", "Cloud");
        remote.asset.revision = "2".to_string();
        remote.asset.parent_revision = Some("1".to_string());
        remote.asset.encryption = Some(CloudConnectionAssetEncryption {
            suite: "XCHACHA20-POLY1305".to_string(),
            nonce: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB".to_string(),
            ciphertext: "Ag".to_string(),
        });
        let summary = apply_validated_page(&pool, "account-1", page(vec![remote], 2), &keys())
            .await
            .unwrap();
        assert_eq!(summary.conflicted, 1);
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT name FROM connections WHERE id = ?1")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap(),
            "Local"
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT status FROM cloud_sync_operations WHERE operation_id = 'op-1'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            "conflicted"
        );
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT COUNT(1) FROM cloud_sync_conflicts WHERE cloud_account_id = 'account-1' AND asset_id = ?1 AND status = 'pending'").bind(id).fetch_one(&pool).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn cursor_is_not_advanced_when_transaction_cannot_apply_a_page() {
        let pool = pool().await;
        let id = "0198f5dc-0000-7000-0000-000000000007";
        let mut change = connection_change(id, "1", "Broken");
        if let Some(DecryptedSyncProjection::Connection(ref mut projection)) = change.projection {
            projection.folder_id = Some("missing-folder".to_string());
        }
        assert!(
            apply_validated_page(&pool, "account-1", page(vec![change], 1), &keys())
                .await
                .is_err()
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(1) FROM cloud_sync_cursors WHERE cloud_account_id = 'account-1'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            0
        );
    }
}
