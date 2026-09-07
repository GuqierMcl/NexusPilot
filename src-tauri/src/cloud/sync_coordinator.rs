use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use sqlx::SqlitePool;

use super::{
    client::CloudAssetPutError,
    public_client_error,
    sync_apply::{apply_staged_pull, begin_staged_pull, stage_validated_page},
    sync_key_store::CommittedSyncKeyBundle,
    sync_projection::{connection_projection, folder_projection, SYNC_SCHEMA_VERSION},
    sync_pull::validate_and_decrypt_page,
    sync_upload::{prepare_connection_delete, prepare_connection_upload},
    CloudAccountService, CloudPublicError, CloudSyncRunResult,
};
use crate::repository::{
    cloud_sync_repository::{
        CloudSyncAssetMetadata, CloudSyncAssetStatus, CloudSyncAssetType, CloudSyncOperation,
        CloudSyncOperationAction, CloudSyncOperationStatus, CloudSyncRepository,
        UpsertCloudSyncAssetMetadata,
    },
    connection_folder_repository::ConnectionFolderRepository,
    connection_repository::ConnectionRepository,
};

const PAGE_SIZE: u16 = 100;
const MAX_PAGES_PER_RUN: usize = 1_000;

pub(crate) type SyncRunGuard = Arc<dyn Fn() -> bool + Send + Sync>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CloudSyncAccess {
    Disabled,
    RecoveryRequired,
    Paused,
    ReadOnly,
    ReadWrite,
    QuotaExceeded,
}

pub(crate) struct CloudSyncExecution {
    pub result: CloudSyncRunResult,
    pub account_id: String,
    pub access: CloudSyncAccess,
}

pub(crate) async fn run(
    service: &CloudAccountService,
    pool: &SqlitePool,
) -> Result<CloudSyncRunResult, CloudPublicError> {
    let execution = run_execution(service, pool, Arc::new(|| true)).await?;
    match execution.access {
        CloudSyncAccess::Disabled => Err(CloudPublicError::from_code(
            super::CloudErrorCode::SyncNotInitialized,
        )),
        CloudSyncAccess::RecoveryRequired => Err(CloudPublicError::from_code(
            super::CloudErrorCode::SyncDeviceNotAuthorized,
        )),
        _ => Ok(execution.result),
    }
}

pub(crate) async fn run_execution(
    service: &CloudAccountService,
    pool: &SqlitePool,
    guard: SyncRunGuard,
) -> Result<CloudSyncExecution, CloudPublicError> {
    if !guard() {
        return Err(CloudPublicError::from_code(
            super::CloudErrorCode::Unauthenticated,
        ));
    }
    let client = service.client()?;
    let access_token = service.access_token().await?;
    let bootstrap = client
        .bootstrap_account(&access_token)
        .await
        .map_err(|error| {
            tauri_plugin_log::log::warn!("Cloud sync failed: stage=bootstrap reason={error:?}");
            public_client_error(error)
        })?;
    let state = client.sync_state(&access_token).await.map_err(|error| {
        tauri_plugin_log::log::warn!("Cloud sync failed: stage=sync_state reason={error:?}");
        public_client_error(error)
    })?;
    let account_id = bootstrap.account.id;
    if !guard() {
        return Err(CloudPublicError::from_code(
            super::CloudErrorCode::Unauthenticated,
        ));
    }
    if service.local_sync_control.is_paused(&account_id) {
        let cursor = CloudSyncRepository::get_cursor(pool, &account_id)
            .await
            .map_err(|_| CloudPublicError::from_code(super::CloudErrorCode::ProtocolError))?;
        return Ok(CloudSyncExecution {
            result: CloudSyncRunResult {
                uploaded: 0,
                deleted: 0,
                pulled: 0,
                conflicted: 0,
                ignored: 0,
                cursor,
            },
            account_id,
            access: CloudSyncAccess::Paused,
        });
    }
    if !state.sync.initialized {
        return Ok(CloudSyncExecution {
            result: CloudSyncRunResult {
                uploaded: 0,
                deleted: 0,
                pulled: 0,
                conflicted: 0,
                ignored: 0,
                cursor: CloudSyncRepository::get_cursor(pool, &account_id)
                    .await
                    .map_err(|_| {
                        CloudPublicError::from_code(super::CloudErrorCode::ProtocolError)
                    })?,
            },
            account_id,
            access: CloudSyncAccess::Disabled,
        });
    }
    let Some(keys) = service
        .sync_key_store
        .read_committed(&account_id)
        .map_err(|_| {
            CloudPublicError::from_code(super::CloudErrorCode::SecureStorageUnavailable)
        })?
    else {
        return Ok(CloudSyncExecution {
            result: CloudSyncRunResult {
                uploaded: 0,
                deleted: 0,
                pulled: 0,
                conflicted: 0,
                ignored: 0,
                cursor: CloudSyncRepository::get_cursor(pool, &account_id)
                    .await
                    .map_err(|_| {
                        CloudPublicError::from_code(super::CloudErrorCode::ProtocolError)
                    })?,
            },
            account_id,
            access: CloudSyncAccess::RecoveryRequired,
        });
    };

    bind_sync_key(pool, &account_id, &keys.amk, false).await?;
    let mut result = CloudSyncRunResult {
        uploaded: 0,
        deleted: 0,
        pulled: 0,
        conflicted: 0,
        ignored: 0,
        cursor: CloudSyncRepository::get_cursor(pool, &account_id)
            .await
            .map_err(|_| CloudPublicError::from_code(super::CloudErrorCode::ProtocolError))?,
    };

    let mut access = if state.connection_sync.permissions.write_encrypted_assets {
        CloudSyncAccess::ReadWrite
    } else if state.connection_sync.permissions.read_encrypted_assets {
        CloudSyncAccess::ReadOnly
    } else {
        CloudSyncAccess::Disabled
    };

    if !guard() {
        return Err(CloudPublicError::from_code(
            super::CloudErrorCode::Unauthenticated,
        ));
    }

    if state.connection_sync.permissions.write_encrypted_assets {
        reconcile_local_assets(pool, &account_id, &keys, &guard)
            .await
            .map_err(|error| {
                if guard() {
                    tauri_plugin_log::log::warn!(
                        "Cloud sync failed: stage=reconcile reason={}",
                        local_sync_error_reason(&error)
                    );
                    CloudPublicError::from_code(super::CloudErrorCode::ProtocolError)
                } else {
                    CloudPublicError::from_code(super::CloudErrorCode::Unauthenticated)
                }
            })?;
        if let Some(error) = flush_pending_operations(
            pool,
            client,
            &access_token,
            &account_id,
            &keys,
            &mut result,
            &guard,
        )
        .await
        {
            if error.code == super::CloudErrorCode::ConnectionSyncQuotaExceeded {
                access = CloudSyncAccess::QuotaExceeded;
            } else {
                return Err(error);
            }
        }
    }
    if state.connection_sync.permissions.read_encrypted_assets {
        pull_pages(
            pool,
            client,
            &access_token,
            &account_id,
            &keys,
            &mut result,
            &guard,
            state.connection_sync.permissions.write_encrypted_assets,
        )
        .await?;
    }
    Ok(CloudSyncExecution {
        result,
        account_id,
        access,
    })
}

pub(crate) async fn bind_sync_key(
    pool: &SqlitePool,
    account_id: &str,
    amk: &[u8; 32],
    reset_unbound: bool,
) -> Result<(), CloudPublicError> {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    digest.update(b"NexusPilot cloud sync local key binding v1");
    digest.update(account_id.as_bytes());
    digest.update(amk);
    let fingerprint = format!("{:x}", digest.finalize());
    CloudSyncRepository::bind_key(pool, account_id, &fingerprint, reset_unbound)
        .await
        .map_err(|_| CloudPublicError::from_code(super::CloudErrorCode::ProtocolError))
}

async fn reconcile_local_assets(
    pool: &SqlitePool,
    account_id: &str,
    keys: &CommittedSyncKeyBundle,
    guard: &SyncRunGuard,
) -> crate::error::AppResult<()> {
    let metadata = CloudSyncRepository::list_assets(pool, account_id).await?;
    let mut metadata_by_key = metadata
        .iter()
        .map(|value| ((value.asset_type, value.asset_id.clone()), value.clone()))
        .collect::<HashMap<_, _>>();
    let pending = CloudSyncRepository::list_pending_operations(pool, account_id).await?;
    let pending_keys = pending
        .iter()
        .map(|value| (value.asset_type, value.asset_id.clone()))
        .collect::<HashSet<_>>();
    let connections = ConnectionRepository::list(pool).await?;
    let folders = ConnectionFolderRepository::list(pool).await?;
    let mut seen = HashSet::new();

    for record in connections {
        if !guard() {
            return Err(crate::error::AppError::validation(
                "Cloud sync run was canceled",
            ));
        }
        let (plaintext, digest) = connection_projection(&record)?;
        let key = (CloudSyncAssetType::Connection, record.id.clone());
        seen.insert(key.clone());
        reconcile_present_asset(
            pool,
            account_id,
            keys,
            CloudSyncAssetType::Connection,
            &record.id,
            plaintext,
            digest.as_base64url(),
            metadata_by_key.remove(&key),
            pending_keys.contains(&key),
            guard,
        )
        .await?;
    }
    for record in folders {
        if !guard() {
            return Err(crate::error::AppError::validation(
                "Cloud sync run was canceled",
            ));
        }
        let (plaintext, digest) = folder_projection(&record)?;
        let key = (CloudSyncAssetType::ConnectionFolder, record.id.clone());
        seen.insert(key.clone());
        reconcile_present_asset(
            pool,
            account_id,
            keys,
            CloudSyncAssetType::ConnectionFolder,
            &record.id,
            plaintext,
            digest.as_base64url(),
            metadata_by_key.remove(&key),
            pending_keys.contains(&key),
            guard,
        )
        .await?;
    }

    for value in metadata {
        if !guard() {
            return Err(crate::error::AppError::validation(
                "Cloud sync run was canceled",
            ));
        }
        let key = (value.asset_type, value.asset_id.clone());
        if seen.contains(&key) || pending_keys.contains(&key) {
            continue;
        }
        let Some(remote_revision) = value.remote_revision else {
            continue;
        };
        if matches!(
            value.sync_status,
            CloudSyncAssetStatus::RemoteDeleted | CloudSyncAssetStatus::Conflicted
        ) {
            continue;
        }
        let operation = prepare_connection_delete(
            account_id,
            &value.asset_id,
            value.asset_type,
            remote_revision,
        )
        .map_err(|_| {
            crate::error::AppError::validation("Failed to prepare a Cloud delete operation")
        })?;
        let operation_id = operation.operation_id.clone();
        CloudSyncRepository::enqueue_operation(pool, operation).await?;
        CloudSyncRepository::upsert_asset(
            pool,
            UpsertCloudSyncAssetMetadata {
                cloud_account_id: account_id.to_string(),
                asset_id: value.asset_id,
                asset_type: value.asset_type,
                local_entity_id: value.local_entity_id,
                remote_revision: value.remote_revision,
                base_revision: value.base_revision,
                sync_status: CloudSyncAssetStatus::PendingDelete,
                last_error_code: None,
                last_error_at: None,
                last_attempt_at: None,
                pending_operation_id: Some(operation_id),
                tombstone: true,
                conflict_of: value.conflict_of,
                local_payload_hash: value.local_payload_hash,
            },
        )
        .await?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn reconcile_present_asset(
    pool: &SqlitePool,
    account_id: &str,
    keys: &CommittedSyncKeyBundle,
    asset_type: CloudSyncAssetType,
    asset_id: &str,
    plaintext: Vec<u8>,
    payload_hash: String,
    metadata: Option<CloudSyncAssetMetadata>,
    has_pending_operation: bool,
    guard: &SyncRunGuard,
) -> crate::error::AppResult<()> {
    if !guard() {
        return Err(crate::error::AppError::validation(
            "Cloud sync run was canceled",
        ));
    }
    if has_pending_operation {
        return Ok(());
    }
    if metadata
        .as_ref()
        .and_then(|value| value.local_payload_hash.as_deref())
        .is_some_and(|value| value == payload_hash)
        && matches!(
            metadata.as_ref().map(|value| value.sync_status),
            Some(
                CloudSyncAssetStatus::Synced
                    | CloudSyncAssetStatus::NeedsLocalFile
                    | CloudSyncAssetStatus::PendingUpload,
            )
        )
    {
        return Ok(());
    }
    if matches!(
        metadata.as_ref().map(|value| value.sync_status),
        Some(CloudSyncAssetStatus::Conflicted)
    ) {
        return Ok(());
    }
    let expected_revision = metadata.as_ref().and_then(|value| value.remote_revision);
    let prepared = prepare_connection_upload(
        account_id,
        asset_id,
        asset_type,
        expected_revision,
        SYNC_SCHEMA_VERSION as u16,
        u64::from(keys.key_generation),
        &plaintext,
        &keys.amk,
    )
    .map_err(|_| {
        crate::error::AppError::validation("Failed to prepare a Cloud upload operation")
    })?;
    let operation_id = prepared.operation.operation_id.clone();
    CloudSyncRepository::enqueue_operation(pool, prepared.operation).await?;
    CloudSyncRepository::upsert_asset(
        pool,
        UpsertCloudSyncAssetMetadata {
            cloud_account_id: account_id.to_string(),
            asset_id: asset_id.to_string(),
            asset_type,
            local_entity_id: asset_id.to_string(),
            remote_revision: metadata.as_ref().and_then(|value| value.remote_revision),
            base_revision: metadata.as_ref().and_then(|value| value.base_revision),
            sync_status: CloudSyncAssetStatus::PendingUpload,
            last_error_code: None,
            last_error_at: None,
            last_attempt_at: None,
            pending_operation_id: Some(operation_id),
            tombstone: false,
            conflict_of: metadata.and_then(|value| value.conflict_of),
            local_payload_hash: Some(payload_hash),
        },
    )
    .await?;
    Ok(())
}

async fn flush_pending_operations(
    pool: &SqlitePool,
    client: &super::client::CloudApiClient,
    access_token: &crate::auth::SecretString,
    account_id: &str,
    keys: &CommittedSyncKeyBundle,
    result: &mut CloudSyncRunResult,
    guard: &SyncRunGuard,
) -> Option<CloudPublicError> {
    let operations = match CloudSyncRepository::list_pending_operations(pool, account_id).await {
        Ok(value) => value,
        Err(_) => {
            return Some(CloudPublicError::from_code(
                super::CloudErrorCode::ProtocolError,
            ))
        }
    };
    let mut first_error = None;
    for operation in operations {
        if !guard() {
            return Some(CloudPublicError::from_code(
                super::CloudErrorCode::Unauthenticated,
            ));
        }
        if CloudSyncRepository::mark_operation_attempt(pool, &operation.operation_id)
            .await
            .is_err()
        {
            continue;
        }
        let outcome = match operation.action {
            CloudSyncOperationAction::Put => {
                super::sync_upload::flush_put_operation(
                    client,
                    access_token,
                    account_id,
                    &operation,
                    keys,
                )
                .await
            }
            CloudSyncOperationAction::Delete => {
                super::sync_upload::flush_delete_operation(
                    client,
                    access_token,
                    account_id,
                    &operation,
                    keys,
                )
                .await
            }
        };
        if !guard() {
            return Some(CloudPublicError::from_code(
                super::CloudErrorCode::Unauthenticated,
            ));
        }
        match outcome {
            Ok(response) => {
                let status = if operation.action == CloudSyncOperationAction::Delete {
                    CloudSyncAssetStatus::RemoteDeleted
                } else {
                    CloudSyncAssetStatus::Synced
                };
                let revision = response.operation.applied_revision.parse::<u64>().ok();
                if let Some(revision) = revision {
                    let _ = CloudSyncRepository::upsert_asset(
                        pool,
                        UpsertCloudSyncAssetMetadata {
                            cloud_account_id: account_id.to_string(),
                            asset_id: operation.asset_id.clone(),
                            asset_type: operation.asset_type,
                            local_entity_id: operation.asset_id.clone(),
                            remote_revision: Some(revision),
                            base_revision: Some(revision),
                            sync_status: status,
                            last_error_code: None,
                            last_error_at: None,
                            last_attempt_at: None,
                            pending_operation_id: None,
                            tombstone: operation.action == CloudSyncOperationAction::Delete,
                            conflict_of: None,
                            local_payload_hash: operation.payload_hash.clone(),
                        },
                    )
                    .await;
                }
                let _ = CloudSyncRepository::mark_operation_status(
                    pool,
                    &operation.operation_id,
                    CloudSyncOperationStatus::Applied,
                    None,
                )
                .await;
                if operation.action == CloudSyncOperationAction::Delete {
                    result.deleted += 1;
                } else {
                    result.uploaded += 1;
                }
            }
            Err(CloudAssetPutError::Conflict(_)) => {
                mark_asset_conflicted(pool, account_id, &operation).await;
                let _ = CloudSyncRepository::mark_operation_status(
                    pool,
                    &operation.operation_id,
                    CloudSyncOperationStatus::Conflicted,
                    Some("connection_asset_revision_conflict"),
                )
                .await;
                result.conflicted += 1;
            }
            Err(CloudAssetPutError::Client(error)) => {
                tauri_plugin_log::log::warn!("Cloud sync failed: stage=upload reason={error:?}");
                let (status, code) = if error.sync_operation_outcome_unknown() {
                    (
                        CloudSyncOperationStatus::Unknown,
                        "cloud_temporarily_unavailable",
                    )
                } else {
                    (
                        CloudSyncOperationStatus::Rejected,
                        "cloud_sync_operation_rejected",
                    )
                };
                if first_error.is_none() {
                    first_error = Some(public_client_error(error));
                }
                let _ = CloudSyncRepository::mark_operation_status(
                    pool,
                    &operation.operation_id,
                    status,
                    Some(code),
                )
                .await;
            }
        }
    }
    first_error
}

async fn mark_asset_conflicted(
    pool: &SqlitePool,
    account_id: &str,
    operation: &CloudSyncOperation,
) {
    let Ok(Some(value)) =
        CloudSyncRepository::get_asset(pool, account_id, &operation.asset_id).await
    else {
        return;
    };
    let _ = CloudSyncRepository::upsert_asset(
        pool,
        UpsertCloudSyncAssetMetadata {
            cloud_account_id: value.cloud_account_id,
            asset_id: value.asset_id,
            asset_type: value.asset_type,
            local_entity_id: value.local_entity_id,
            remote_revision: value.remote_revision,
            base_revision: value.base_revision,
            sync_status: CloudSyncAssetStatus::Conflicted,
            last_error_code: Some("connection_asset_revision_conflict".to_string()),
            last_error_at: None,
            last_attempt_at: None,
            pending_operation_id: Some(operation.operation_id.clone()),
            tombstone: value.tombstone,
            conflict_of: value.conflict_of,
            local_payload_hash: value.local_payload_hash,
        },
    )
    .await;
}

async fn pull_pages(
    pool: &SqlitePool,
    client: &super::client::CloudApiClient,
    access_token: &crate::auth::SecretString,
    account_id: &str,
    keys: &CommittedSyncKeyBundle,
    result: &mut CloudSyncRunResult,
    guard: &SyncRunGuard,
    allow_repair: bool,
) -> Result<(), CloudPublicError> {
    let mut repaired_cursors = HashSet::new();
    let (initial_cursor, mut cursor) =
        begin_staged_pull(pool, account_id).await.map_err(|error| {
            tauri_plugin_log::log::warn!(
                "Cloud sync failed: stage=pull.resume reason={}",
                local_sync_error_reason(&error)
            );
            CloudPublicError::from_code(super::CloudErrorCode::ProtocolError)
        })?;
    let mut page_size = PAGE_SIZE;
    for _ in 0..MAX_PAGES_PER_RUN {
        if !guard() {
            return Err(CloudPublicError::from_code(
                super::CloudErrorCode::Unauthenticated,
            ));
        }
        let response = match client
            .list_connection_assets(access_token, account_id, cursor, page_size, keys)
            .await
        {
            Ok(response) => response,
            Err(super::client::CloudClientError::ResponseTooLarge) if page_size > 1 => {
                page_size = (page_size / 2).max(1);
                continue;
            }
            Err(error) => {
                tauri_plugin_log::log::warn!(
                    "Cloud sync failed: stage=pull.request cursor={cursor} reason={error:?}"
                );
                return Err(public_client_error(error));
            }
        };
        let page = match validate_and_decrypt_page(account_id, cursor, response.clone(), keys) {
            Ok(page) => page,
            Err(super::sync_pull::SyncPullError::DecryptionFailed)
                if allow_repair && !repaired_cursors.contains(&cursor) =>
            {
                let mut repairs = Vec::new();
                for change in &response.items {
                    if super::sync_pull::validate_and_decrypt_change(
                        account_id,
                        change.clone(),
                        keys,
                    )
                    .is_err()
                    {
                        let repair = super::sync_management::prepare_legacy_conflict_repair(
                            pool,
                            account_id,
                            &change.asset,
                            keys,
                        )
                        .await
                        .map_err(|_| {
                            CloudPublicError::from_code(super::CloudErrorCode::ProtocolError)
                        })?;
                        let Some(repair) = repair else {
                            tauri_plugin_log::log::warn!("Cloud sync failed: stage=pull.validate cursor={cursor} reason=DecryptionFailed legacy_repair=unavailable");
                            return Err(CloudPublicError::from_code(
                                super::CloudErrorCode::ProtocolError,
                            ));
                        };
                        if !repairs.iter().any(|value: &crate::repository::cloud_sync_repository::EnqueueCloudSyncOperation| value.operation_id == repair.operation_id) {
                            repairs.push(repair);
                        }
                    }
                }
                if repairs.is_empty() || !guard() {
                    return Err(CloudPublicError::from_code(
                        super::CloudErrorCode::ProtocolError,
                    ));
                }
                for repair in repairs {
                    CloudSyncRepository::enqueue_operation(pool, repair)
                        .await
                        .map_err(|_| {
                            CloudPublicError::from_code(super::CloudErrorCode::ProtocolError)
                        })?;
                }
                repaired_cursors.insert(cursor);
                if let Some(error) = flush_pending_operations(
                    pool,
                    client,
                    access_token,
                    account_id,
                    keys,
                    result,
                    guard,
                )
                .await
                {
                    return Err(error);
                }
                tauri_plugin_log::log::info!(
                    "Cloud sync legacy conflict repair uploaded; refetching cursor={cursor}"
                );
                continue;
            }
            Err(error) => {
                tauri_plugin_log::log::warn!(
                    "Cloud sync failed: stage=pull.validate cursor={cursor} reason={error:?}"
                );
                return Err(CloudPublicError::from_code(
                    super::CloudErrorCode::ProtocolError,
                ));
            }
        };
        if !guard() {
            return Err(CloudPublicError::from_code(
                super::CloudErrorCode::Unauthenticated,
            ));
        }
        let has_more = page.has_more;
        let next_cursor = page.next_cursor;
        stage_validated_page(pool, account_id, page)
            .await
            .map_err(|error| {
                tauri_plugin_log::log::warn!(
                    "Cloud sync failed: stage=pull.stage cursor={cursor} reason={}",
                    local_sync_error_reason(&error)
                );
                CloudPublicError::from_code(super::CloudErrorCode::ProtocolError)
            })?;
        cursor = next_cursor;
        if has_more {
            continue;
        }
        let summary = apply_staged_pull(pool, account_id, initial_cursor, cursor, keys, guard)
            .await
            .map_err(|error| {
                tauri_plugin_log::log::warn!(
                    "Cloud sync failed: stage=pull.apply cursor={cursor} reason={}",
                    local_sync_error_reason(&error)
                );
                CloudPublicError::from_code(super::CloudErrorCode::ProtocolError)
            })?;
        result.pulled += (summary.applied + summary.deleted) as u64;
        result.conflicted += summary.conflicted as u64;
        result.ignored += summary.ignored as u64;
        result.cursor = summary.next_cursor;
        return Ok(());
    }
    // Persisted ciphertext and its fetch cursor allow the next bounded run to continue.
    Err(CloudPublicError::from_code(
        super::CloudErrorCode::TemporarilyUnavailable,
    ))
}

// Only stable, allowlisted categories reach logs; AppError can contain SQL values or plaintext.
fn local_sync_error_reason(error: &crate::error::AppError) -> &'static str {
    use crate::error::AppError;
    match error {
        AppError::Validation(message)
            if message == "Cloud sync projection references a missing parent folder" =>
        {
            "missing_parent_folder"
        }
        AppError::Validation(_) => "validation",
        AppError::Sqlx(sqlx::Error::ColumnDecode { index, .. }) => match index.as_str() {
            "\"created_at\"" => "local_column_decode_created_at",
            "\"updated_at\"" => "local_column_decode_updated_at",
            _ => "local_column_decode",
        },
        AppError::Sqlx(_) | AppError::SqlxMigrate(_) => "local_database",
        AppError::SerdeJson(_) => "local_json",
        AppError::NotFound(_) => "local_entity_missing",
        _ => "local_storage",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::sync_key_store::CommittedSyncKeyBundle;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;
    use std::sync::Arc;

    #[test]
    fn local_sync_diagnostics_do_not_include_error_contents() {
        use crate::error::AppError;
        assert_eq!(
            local_sync_error_reason(&AppError::validation("secret connection value")),
            "validation"
        );
        assert_eq!(
            local_sync_error_reason(&AppError::not_found("private connection name")),
            "local_entity_missing"
        );
        assert_eq!(
            local_sync_error_reason(&AppError::validation(
                "Cloud sync projection references a missing parent folder"
            )),
            "missing_parent_folder"
        );
        for (index, expected) in [
            ("\"created_at\"", "local_column_decode_created_at"),
            ("\"updated_at\"", "local_column_decode_updated_at"),
            ("private column value", "local_column_decode"),
        ] {
            let error = AppError::Sqlx(sqlx::Error::ColumnDecode {
                index: index.to_string(),
                source: "private database value".into(),
            });
            assert_eq!(local_sync_error_reason(&error), expected);
        }
    }

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

    #[tokio::test]
    async fn reconciliation_reads_folders_previously_downloaded_from_cloud() {
        let pool = pool().await;
        // Cloud's folder upsert used the migration's INTEGER millisecond timestamps,
        // while folders created locally used ISO 8601 TEXT in those same columns.
        sqlx::query("INSERT INTO connection_folders (id, name) VALUES ('0198f5dc-0000-7000-8000-000000000020', 'Downloaded folder')")
            .execute(&pool).await.unwrap();
        let guard: SyncRunGuard = Arc::new(|| true);
        reconcile_local_assets(&pool, "account-1", &keys(), &guard)
            .await
            .unwrap();
        assert_eq!(
            CloudSyncRepository::list_pending_operations(&pool, "account-1")
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn reconciliation_enqueues_local_assets_once_and_tracks_the_local_hash() {
        let pool = pool().await;
        let connection_id = "0198f5dc-0000-7000-8000-000000000003";
        sqlx::query("INSERT INTO connections (id, name, driver, payload) VALUES (?1, 'Local', 'postgres', '{\"host\":\"localhost\"}')")
            .bind(connection_id)
            .execute(&pool)
            .await
            .unwrap();
        let guard: SyncRunGuard = Arc::new(|| true);
        reconcile_local_assets(&pool, "account-1", &keys(), &guard)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(1) FROM cloud_sync_operations WHERE cloud_account_id = 'account-1'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT sync_status FROM cloud_sync_assets WHERE cloud_account_id = 'account-1' AND asset_id = ?1")
                .bind(connection_id)
                .fetch_one(&pool)
                .await
                .unwrap(),
            "pending_upload"
        );
        reconcile_local_assets(&pool, "account-1", &keys(), &guard)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(1) FROM cloud_sync_operations WHERE cloud_account_id = 'account-1'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn reconciliation_turns_a_missing_remote_asset_into_a_delete_operation() {
        let pool = pool().await;
        let connection_id = "0198f5dc-0000-7000-8000-000000000004";
        sqlx::query("INSERT INTO cloud_sync_assets (cloud_account_id, asset_id, asset_type, local_entity_id, remote_revision, base_revision, sync_status) VALUES ('account-1', ?1, 'connection', ?1, 4, 4, 'synced')")
            .bind(connection_id)
            .execute(&pool)
            .await
            .unwrap();
        let guard: SyncRunGuard = Arc::new(|| true);
        reconcile_local_assets(&pool, "account-1", &keys(), &guard)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT action FROM cloud_sync_operations WHERE cloud_account_id = 'account-1' AND asset_id = ?1")
                .bind(connection_id)
                .fetch_one(&pool)
                .await
                .unwrap(),
            "delete"
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT sync_status FROM cloud_sync_assets WHERE cloud_account_id = 'account-1' AND asset_id = ?1")
                .bind(connection_id)
                .fetch_one(&pool)
                .await
                .unwrap(),
            "pending_delete"
        );
    }

    #[tokio::test]
    async fn repeated_reconciliation_preserves_an_unresolved_local_delete() {
        let pool = pool().await;
        let id = "0198f5dc-0000-7000-8000-000000000004";
        sqlx::query("INSERT INTO cloud_sync_assets (cloud_account_id, asset_id, asset_type, local_entity_id, remote_revision, base_revision, sync_status, tombstone) VALUES ('account-1', ?1, 'connection', ?1, 5, 4, 'conflicted', 1)")
            .bind(id).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO cloud_sync_operations (operation_id, cloud_account_id, asset_id, asset_type, action, expected_revision, status) VALUES ('old-delete', 'account-1', ?1, 'connection', 'delete', 4, 'conflicted')")
            .bind(id).execute(&pool).await.unwrap();
        let guard: SyncRunGuard = Arc::new(|| true);
        for _ in 0..3 {
            reconcile_local_assets(&pool, "account-1", &keys(), &guard)
                .await
                .unwrap();
        }
        assert!(
            CloudSyncRepository::list_pending_operations(&pool, "account-1")
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT sync_status FROM cloud_sync_assets WHERE asset_id = ?1"
            )
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap(),
            "conflicted"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM cloud_sync_operations")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
    }

    fn remote_folder(id: &str, parent: Option<&str>, cursor: u64) -> serde_json::Value {
        let projection = serde_json::json!({"schemaVersion": 1, "assetType": "connection_folder", "id": id, "name": "Remote folder", "parentId": parent, "sortOrder": 0});
        let plaintext = serde_json::to_vec(&projection).unwrap();
        let encryption = super::super::sync_crypto::encrypt_connection_asset(
            "account-1",
            id,
            "connection_folder",
            1,
            1,
            1,
            &plaintext,
            &keys().amk,
        )
        .unwrap();
        serde_json::json!({"changeCursor": cursor.to_string(), "asset": {
            "id": id, "assetType": "connection_folder", "revision": "1", "parentRevision": null,
            "changeCursor": cursor.to_string(), "schemaVersion": 1, "keyGeneration": 1,
            "encryption": encryption, "encryptedBytes": plaintext.len()+16, "tombstone": false,
            "updatedByDeviceId": keys().device_id, "createdAt": "2026-09-07T00:00:00Z", "updatedAt": "2026-09-07T00:00:00Z", "deletedAt": null
        }})
    }

    async fn pull_from_mock(
        pool: &SqlitePool,
        responses: Vec<Option<serde_json::Value>>,
    ) -> (Result<(), CloudPublicError>, Vec<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut targets = Vec::new();
            for response in responses {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 4096];
                while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                    let read = stream.read(&mut buffer).await.unwrap();
                    assert!(read > 0);
                    request.extend_from_slice(&buffer[..read]);
                }
                targets.push(
                    String::from_utf8(request)
                        .unwrap()
                        .lines()
                        .next()
                        .unwrap()
                        .to_string(),
                );
                let wire = match response {
                    Some(body) => { let body = body.to_string(); format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()) },
                    None => "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 33554433\r\nConnection: close\r\n\r\n".to_string(),
                };
                stream.write_all(wire.as_bytes()).await.unwrap();
            }
            targets
        });
        let client = super::super::client::CloudApiClient::for_test(
            &base,
            std::time::Duration::from_secs(2),
            256 * 1024,
        )
        .unwrap();
        let mut summary = CloudSyncRunResult {
            uploaded: 0,
            deleted: 0,
            pulled: 0,
            conflicted: 0,
            ignored: 0,
            cursor: 0,
        };
        let guard: SyncRunGuard = Arc::new(|| true);
        let result = pull_pages(
            pool,
            &client,
            &crate::auth::SecretString::new("test-token".into()),
            "account-1",
            &keys(),
            &mut summary,
            &guard,
            false,
        )
        .await;
        let requests = tokio::time::timeout(std::time::Duration::from_secs(3), server)
            .await
            .unwrap()
            .unwrap();
        (result, requests)
    }

    #[tokio::test]
    async fn pull_fetches_later_parent_pages_and_retries_oversized_pages_without_skipping() {
        let pool = pool().await;
        let parent = "0198f5dc-0000-7000-8000-000000000020";
        let child = "0198f5dc-0000-7000-8000-000000000021";
        let first = serde_json::json!({"evaluatedAt":"2026-09-07T00:00:00Z", "cursor":{"requested":"0","next":"1","hasMore":true}, "items":[remote_folder(child, Some(parent), 1)]});
        let second = serde_json::json!({"evaluatedAt":"2026-09-07T00:00:00Z", "cursor":{"requested":"1","next":"2","hasMore":false}, "items":[remote_folder(parent, None, 2)]});
        let (result, requests) = pull_from_mock(&pool, vec![None, Some(first), Some(second)]).await;
        result.unwrap();
        assert!(requests[0].contains("cursor=0&limit=100"));
        assert!(requests[1].contains("cursor=0&limit=50"));
        assert!(requests[2].contains("cursor=1&limit=50"));
        assert_eq!(
            CloudSyncRepository::get_cursor(&pool, "account-1")
                .await
                .unwrap(),
            2
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT parent_id FROM connection_folders WHERE id = ?1"
            )
            .bind(child)
            .fetch_one(&pool)
            .await
            .unwrap(),
            parent
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM cloud_sync_pull_staging")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn failure_on_later_page_preserves_the_durable_cursor_and_local_data() {
        let pool = pool().await;
        let parent = "0198f5dc-0000-7000-8000-000000000020";
        let child = "0198f5dc-0000-7000-8000-000000000021";
        let first = serde_json::json!({"evaluatedAt":"2026-09-07T00:00:00Z", "cursor":{"requested":"0","next":"1","hasMore":true}, "items":[remote_folder(child, Some(parent), 1)]});
        let mut invalid = remote_folder(parent, None, 2);
        invalid["asset"]["revision"] = serde_json::json!("2"); // Ciphertext still binds revision 1.
        invalid["asset"]["parentRevision"] = serde_json::json!("1");
        let second = serde_json::json!({"evaluatedAt":"2026-09-07T00:00:00Z", "cursor":{"requested":"1","next":"2","hasMore":false}, "items":[invalid]});
        assert!(pull_from_mock(&pool, vec![Some(first), Some(second)])
            .await
            .0
            .is_err());
        assert_eq!(
            CloudSyncRepository::get_cursor(&pool, "account-1")
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM connection_folders")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
        let staged: String = sqlx::query_scalar("SELECT change_json FROM cloud_sync_pull_staging")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(!staged.contains("Remote folder"));
        // Restarting resumes only after the validated first page; the failed page is retried.
        let repaired = serde_json::json!({"evaluatedAt":"2026-09-07T00:00:00Z", "cursor":{"requested":"1","next":"2","hasMore":false}, "items":[remote_folder(parent, None, 2)]});
        let (result, requests) = pull_from_mock(&pool, vec![Some(repaired)]).await;
        result.unwrap();
        assert!(requests[0].contains("cursor=1&limit=100"));
        assert_eq!(
            CloudSyncRepository::get_cursor(&pool, "account-1")
                .await
                .unwrap(),
            2
        );
    }

    #[tokio::test]
    async fn changing_the_master_key_resets_only_cloud_state_and_requeues_local_assets() {
        let pool = pool().await;
        let guard: SyncRunGuard = Arc::new(|| true);
        sqlx::query("INSERT INTO connections (id, name, driver, payload) VALUES ('0198f5dc-0000-7000-8000-000000000004', 'Local', 'postgres', '{}')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO connection_folders (id, name) VALUES ('0198f5dc-0000-7000-8000-000000000005', 'Local folder')").execute(&pool).await.unwrap();
        reconcile_local_assets(&pool, "account-1", &keys(), &guard)
            .await
            .unwrap();
        CloudSyncRepository::set_cursor(&pool, "account-1", 33)
            .await
            .unwrap();
        CloudSyncRepository::set_cursor(&pool, "other-account", 9)
            .await
            .unwrap();
        // Adopting a legacy installation and reusing the same AMK preserve existing work.
        bind_sync_key(&pool, "account-1", &keys().amk, false)
            .await
            .unwrap();
        bind_sync_key(&pool, "account-1", &keys().amk, true)
            .await
            .unwrap();
        assert_eq!(
            CloudSyncRepository::get_cursor(&pool, "account-1")
                .await
                .unwrap(),
            33
        );
        assert_eq!(
            CloudSyncRepository::list_pending_operations(&pool, "account-1")
                .await
                .unwrap()
                .len(),
            2
        );
        sqlx::query("INSERT INTO cloud_sync_conflicts (id, cloud_account_id, asset_id, asset_type, remote_revision, local_ciphertext, remote_ciphertext, local_payload_hash, remote_payload_hash) VALUES ('conflict', 'account-1', 'asset', 'connection', 2, 'old', 'old', 'hash', 'hash')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO cloud_sync_pull_staging VALUES ('account-1', 'asset', 1, 'connection', 0, NULL, 'old encrypted page')").execute(&pool).await.unwrap();
        let mut new_keys = keys();
        new_keys.amk = [8; 32];
        bind_sync_key(&pool, "account-1", &new_keys.amk, true)
            .await
            .unwrap();
        assert_eq!(
            CloudSyncRepository::get_cursor(&pool, "account-1")
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            CloudSyncRepository::get_cursor(&pool, "other-account")
                .await
                .unwrap(),
            9
        );
        for table in [
            "cloud_sync_assets",
            "cloud_sync_operations",
            "cloud_sync_conflicts",
            "cloud_sync_pull_staging",
        ] {
            assert_eq!(
                sqlx::query_scalar::<_, i64>(&format!(
                    "SELECT COUNT(*) FROM {table} WHERE cloud_account_id = 'account-1'"
                ))
                .fetch_one(&pool)
                .await
                .unwrap(),
                0
            );
        }
        reconcile_local_assets(&pool, "account-1", &new_keys, &guard)
            .await
            .unwrap();
        let queued = CloudSyncRepository::list_pending_operations(&pool, "account-1")
            .await
            .unwrap();
        assert_eq!(queued.len(), 2);
        assert!(queued.iter().all(|op| op.expected_revision.is_none()));
        CloudSyncRepository::reset_account(&pool, "account-1")
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM connections")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM connection_folders")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
    }
}
