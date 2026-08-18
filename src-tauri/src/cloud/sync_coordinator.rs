use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use sqlx::SqlitePool;

use super::{
    client::CloudAssetPutError,
    public_client_error,
    sync_apply::apply_validated_page,
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
        .map_err(public_client_error)?;
    let state = client
        .sync_state(&access_token)
        .await
        .map_err(public_client_error)?;
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
            .map_err(|_| {
                if guard() {
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
        )
        .await?;
    }
    Ok(CloudSyncExecution {
        result,
        account_id,
        access,
    })
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
        if matches!(value.sync_status, CloudSyncAssetStatus::RemoteDeleted) {
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
) -> Result<(), CloudPublicError> {
    for _ in 0..MAX_PAGES_PER_RUN {
        if !guard() {
            return Err(CloudPublicError::from_code(
                super::CloudErrorCode::Unauthenticated,
            ));
        }
        let cursor = CloudSyncRepository::get_cursor(pool, account_id)
            .await
            .map_err(|_| CloudPublicError::from_code(super::CloudErrorCode::ProtocolError))?;
        let response = client
            .list_connection_assets(access_token, account_id, cursor, PAGE_SIZE, keys)
            .await
            .map_err(public_client_error)?;
        let page = validate_and_decrypt_page(account_id, cursor, response, keys)
            .map_err(|_| CloudPublicError::from_code(super::CloudErrorCode::ProtocolError))?;
        if !guard() {
            return Err(CloudPublicError::from_code(
                super::CloudErrorCode::Unauthenticated,
            ));
        }
        let has_more = page.has_more;
        let summary = apply_validated_page(pool, account_id, page, keys)
            .await
            .map_err(|_| CloudPublicError::from_code(super::CloudErrorCode::ProtocolError))?;
        result.pulled += (summary.applied + summary.deleted) as u64;
        result.conflicted += summary.conflicted as u64;
        result.ignored += summary.ignored as u64;
        result.cursor = summary.next_cursor;
        if !has_more {
            return Ok(());
        }
    }
    Err(CloudPublicError::from_code(
        super::CloudErrorCode::ProtocolError,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::sync_key_store::CommittedSyncKeyBundle;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;
    use std::sync::Arc;

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
}
