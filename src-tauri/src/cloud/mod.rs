mod client;
mod desktop_state;
mod device_authorization;
mod device_proof;
mod error;
mod local_sync_control;
mod projection_cache;
mod sync_crypto;
mod sync_key_store;
mod sync_management;
// 9A 基础设施由后续上传/拉取批次消费；在接入同步调度前允许暂时没有运行时调用方。
#[allow(dead_code)]
mod sync_apply;
#[allow(dead_code)]
mod sync_coordinator;
#[allow(dead_code)]
mod sync_projection;
#[allow(dead_code)]
mod sync_pull;
mod sync_scheduler;
mod sync_setup;
#[allow(dead_code)]
mod sync_upload;
mod token_broker;
mod types;

use std::fs;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use arboard::Clipboard;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::Signer;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use tauri::{App, AppHandle, Emitter, Listener, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::auth::{AuthManager, AuthSessionSnapshot};

use client::{CloudApiClient, CloudClientError};
use local_sync_control::LocalSyncControlStore;
use projection_cache::{CloudProjectionCache, CloudProjectionCacheRecord};
use sync_key_store::{SyncKeyBundleInput, SystemSyncKeyStore};
use sync_setup::{SyncSetupCoordinator, SyncSetupError};
use token_broker::{CloudTokenBroker, CloudTokenBrokerError};

pub(crate) use desktop_state::{
    CloudDesktopStateProjection, CloudDesktopStateStore, CLOUD_DESKTOP_STATE_CHANGED_EVENT,
};
pub use error::{CloudErrorCode, CloudPublicError};
pub use sync_management::{
    CloudLocalDependencyList, CloudSyncConflictDecision, CloudSyncConflictView,
};
pub use sync_projection::LocalDependencyKind;
pub(crate) use sync_scheduler::CloudSyncRuntimeProjection;
pub(crate) use sync_scheduler::CloudSyncScheduler;
pub use sync_setup::BeginSyncSetupResult;
pub use types::{
    BeginDeviceAuthorizationResult, CloudAccountBootstrap, CloudAccountSummary,
    CloudConnectionSyncEntitlement, CloudDeviceAuthorization, CloudSubscriptionSummary,
    CloudSyncDevice, CloudSyncDevicesProjection, CloudSyncState, CloudSyncStateProjection,
    LocalSyncState, LocalSyncStatus,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudPendingDeviceAuthorizationList {
    pub evaluated_at: String,
    pub items: Vec<CloudDeviceAuthorization>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDeviceAuthorizationClaimResult {
    pub evaluated_at: String,
    pub request_id: String,
    pub device_id: String,
    pub key_generation: u64,
    pub claimed_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingDeviceAuthorizationStatus {
    pub evaluated_at: String,
    pub request_id: String,
    pub device_id: String,
    pub device_name: String,
    pub status: String,
    pub verification_code: String,
    pub code_version: u64,
    pub created_at: String,
    pub expires_at: String,
    pub code_expires_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncDeviceActionResult {
    pub evaluated_at: String,
    pub device: CloudSyncDevice,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CloudProjectionSource {
    Cloud,
    Cache,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncSetupContext {
    pub evaluated_at: String,
    pub account: CloudAccountSummary,
    pub subscription: CloudSubscriptionSummary,
    pub connection_sync: CloudConnectionSyncEntitlement,
    pub sync: CloudSyncState,
    pub local_sync: LocalSyncState,
    pub devices: Option<Vec<CloudSyncDevice>>,
    pub suggested_device_name: String,
    pub source: CloudProjectionSource,
    pub cached_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncDevicesView {
    pub evaluated_at: String,
    pub items: Option<Vec<CloudSyncDevice>>,
    pub source: CloudProjectionSource,
    pub cached_at: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncRunResult {
    pub uploaded: u64,
    pub deleted: u64,
    pub pulled: u64,
    pub conflicted: u64,
    pub ignored: u64,
    pub cursor: u64,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryKeyExportResult {
    pub completed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryKeyRotationResult {
    pub rotation_id: String,
    pub recovery_key: String,
    pub evaluated_at: String,
}

pub struct CloudAccountService {
    auth_manager: AuthManager,
    token_broker: CloudTokenBroker,
    client: Result<CloudApiClient, CloudClientError>,
    sync_setups: SyncSetupCoordinator,
    sync_key_store: SystemSyncKeyStore,
    projection_cache: CloudProjectionCache,
    local_sync_control: LocalSyncControlStore,
    rotation_key: Mutex<Option<(String, Zeroizing<String>)>>,
    desktop_state: CloudDesktopStateStore,
}

impl CloudAccountService {
    fn new(
        auth_manager: AuthManager,
        app_data_dir: Option<PathBuf>,
        desktop_state: CloudDesktopStateStore,
    ) -> Self {
        Self {
            token_broker: CloudTokenBroker::new(auth_manager.clone()),
            auth_manager,
            client: CloudApiClient::from_embedded(),
            sync_setups: SyncSetupCoordinator::default(),
            sync_key_store: SystemSyncKeyStore::new(),
            projection_cache: CloudProjectionCache::new(app_data_dir.clone()),
            local_sync_control: LocalSyncControlStore::new(app_data_dir),
            rotation_key: Mutex::new(None),
            desktop_state,
        }
    }

    pub async fn bootstrap_account(&self) -> Result<CloudAccountBootstrap, CloudPublicError> {
        let client = self
            .client
            .as_ref()
            .map_err(|error| public_client_error(*error))?;
        let access_token = self
            .token_broker
            .access_token()
            .await
            .map_err(public_broker_error)?;
        client
            .bootstrap_account(&access_token)
            .await
            .map_err(public_client_error)
    }

    pub async fn sync_setup_context(&self) -> Result<CloudSyncSetupContext, CloudPublicError> {
        self.desktop_state.begin_refresh();
        let identity_binding = identity_binding(&self.auth_manager.snapshot())?;
        let refreshed = async {
            let client = self.client()?;
            let access_token = self.access_token().await?;
            let (bootstrap, entitlements, state) = tokio::try_join!(
                async {
                    client
                        .bootstrap_account(&access_token)
                        .await
                        .map_err(public_client_error)
                },
                async {
                    client
                        .account_entitlements(&access_token)
                        .await
                        .map_err(public_client_error)
                },
                async {
                    client
                        .sync_state(&access_token)
                        .await
                        .map_err(public_client_error)
                },
            )?;
            let devices = if state.sync.initialized {
                self.sync_devices(&access_token, &bootstrap.account.id)
                    .await
            } else {
                Ok(CloudSyncDevicesProjection {
                    evaluated_at: state.evaluated_at.clone(),
                    items: Vec::new(),
                })
            };
            let devices = devices.ok().map(|projection| projection.items);
            let cached_at = entitlements.evaluated_at.clone();
            let local_sync =
                self.local_sync_state(&bootstrap.account.id, state.sync.key_generation);
            let context = CloudSyncSetupContext {
                evaluated_at: state.evaluated_at.clone(),
                account: bootstrap.account,
                subscription: entitlements.subscription,
                connection_sync: state.connection_sync,
                sync: state.sync,
                local_sync,
                devices,
                suggested_device_name: suggested_device_name(),
                source: CloudProjectionSource::Cloud,
                cached_at: Some(cached_at.clone()),
            };
            self.projection_cache.write(&CloudProjectionCacheRecord {
                version: projection_cache::cache_version(),
                identity_binding_sha256: identity_binding.clone(),
                cloud_account_id: context.account.id.clone(),
                account: context.account.clone(),
                subscription: context.subscription.clone(),
                connection_sync: context.connection_sync.clone(),
                sync: context.sync.clone(),
                devices: context.devices.clone(),
                cached_at,
            });
            Ok::<CloudSyncSetupContext, CloudPublicError>(context)
        }
        .await;

        let cached = self.projection_cache.read(&identity_binding);
        let cached_local_sync = cached.as_ref().map(|cached| {
            self.local_sync_state(&cached.cloud_account_id, cached.sync.key_generation)
        });
        let result = resolve_sync_setup_context(
            refreshed,
            cached,
            suggested_device_name(),
            cached_local_sync,
        );
        match result {
            Ok(context) => {
                self.desktop_state.set_context(context.clone());
                Ok(context)
            }
            Err(error) => {
                self.desktop_state.fail_refresh(error.clone());
                Err(error)
            }
        }
    }

    pub async fn cloud_sync_status(&self) -> Result<CloudSyncSetupContext, CloudPublicError> {
        self.sync_setup_context().await
    }

    pub(crate) fn desktop_state_snapshot(&self) -> CloudDesktopStateProjection {
        self.desktop_state.snapshot()
    }

    /// Return the last disk-backed projection without contacting Cloud.
    ///
    /// This is strictly a display hydration path.  It never authorizes an
    /// operation; every mutation and synchronization operation still refreshes
    /// and evaluates the authoritative Cloud response.
    pub fn cached_sync_setup_context(
        &self,
    ) -> Result<Option<CloudSyncSetupContext>, CloudPublicError> {
        let identity_binding = match identity_binding(&self.auth_manager.snapshot()) {
            Ok(value) => value,
            Err(error) if error.code == CloudErrorCode::Unauthenticated => return Ok(None),
            Err(error) => return Err(error),
        };
        let Some(cached) = self.projection_cache.read(&identity_binding) else {
            return Ok(None);
        };
        let cached_at = cached.cached_at.clone();
        let context = CloudSyncSetupContext {
            evaluated_at: cached_at.clone(),
            account: cached.account,
            subscription: cached.subscription,
            connection_sync: cached.connection_sync,
            sync: cached.sync.clone(),
            local_sync: self.local_sync_state(&cached.cloud_account_id, cached.sync.key_generation),
            devices: cached.devices,
            suggested_device_name: suggested_device_name(),
            source: CloudProjectionSource::Cache,
            cached_at: Some(cached_at),
        };
        self.desktop_state.hydrate_cached_context(context.clone());
        Ok(Some(context))
    }

    pub async fn cloud_devices(&self) -> Result<CloudSyncDevicesView, CloudPublicError> {
        let context = self.sync_setup_context().await?;
        Ok(CloudSyncDevicesView {
            evaluated_at: context.evaluated_at,
            items: context.devices,
            source: context.source,
            cached_at: context.cached_at,
        })
    }

    pub async fn local_dependencies(
        &self,
        pool: &SqlitePool,
    ) -> Result<CloudLocalDependencyList, CloudPublicError> {
        let cloud_account_id = self.current_cloud_account_id().await?;
        sync_management::list_local_dependencies(pool, &cloud_account_id)
            .await
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::ProtocolError))
    }

    pub async fn complete_local_dependency(
        &self,
        pool: &SqlitePool,
        asset_id: &str,
        dependency: LocalDependencyKind,
        path: &str,
    ) -> Result<CloudLocalDependencyList, CloudPublicError> {
        let cloud_account_id = self.current_cloud_account_id().await?;
        sync_management::complete_local_dependency(
            pool,
            &cloud_account_id,
            asset_id,
            dependency,
            path,
        )
        .await
        .map_err(|_| CloudPublicError::from_code(CloudErrorCode::ProtocolError))
    }

    pub async fn list_conflicts(
        &self,
        pool: &SqlitePool,
    ) -> Result<Vec<CloudSyncConflictView>, CloudPublicError> {
        let account_id = self.current_cloud_account_id().await?;
        let keys = self
            .sync_key_store
            .read_committed(&account_id)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?
            .ok_or_else(|| CloudPublicError::from_code(CloudErrorCode::SyncDeviceNotAuthorized))?;
        sync_management::list_conflicts(pool, &account_id, &keys)
            .await
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::ProtocolError))
    }

    pub async fn resolve_conflict(
        &self,
        pool: &SqlitePool,
        conflict_id: &str,
        decision: CloudSyncConflictDecision,
    ) -> Result<Vec<CloudSyncConflictView>, CloudPublicError> {
        let account_id = self.current_cloud_account_id().await?;
        let keys = self
            .sync_key_store
            .read_committed(&account_id)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?
            .ok_or_else(|| CloudPublicError::from_code(CloudErrorCode::SyncDeviceNotAuthorized))?;
        sync_management::resolve_conflict(pool, &account_id, conflict_id, decision, &keys)
            .await
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::ProtocolError))
    }

    async fn sync_devices(
        &self,
        access_token: &crate::auth::SecretString,
        account_id: &str,
    ) -> Result<CloudSyncDevicesProjection, CloudPublicError> {
        let keys = self
            .sync_key_store
            .read_committed(account_id)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?
            .ok_or_else(|| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?;
        let client = self.client()?;
        client
            .sync_devices(access_token, account_id, &keys)
            .await
            .map_err(public_client_error)
    }

    fn local_sync_state(
        &self,
        cloud_account_id: &str,
        cloud_key_generation: Option<u64>,
    ) -> LocalSyncState {
        match self.sync_key_store.read_committed(cloud_account_id) {
            Ok(Some(bundle)) => {
                let generation_matches = cloud_key_generation
                    .map(|generation| generation == u64::from(bundle.key_generation))
                    .unwrap_or(true);
                if generation_matches {
                    if self.local_sync_control.is_paused(cloud_account_id) {
                        return LocalSyncState {
                            status: LocalSyncStatus::Paused,
                            key_generation: Some(u64::from(bundle.key_generation)),
                        };
                    }
                    LocalSyncState {
                        status: LocalSyncStatus::Ready,
                        key_generation: Some(u64::from(bundle.key_generation)),
                    }
                } else {
                    LocalSyncState {
                        status: LocalSyncStatus::Corrupted,
                        key_generation: Some(u64::from(bundle.key_generation)),
                    }
                }
            }
            Ok(None) => LocalSyncState {
                status: LocalSyncStatus::Disabled,
                key_generation: None,
            },
            Err(sync_key_store::SyncKeyStoreError::Unavailable) => LocalSyncState {
                status: LocalSyncStatus::SecureStorageUnavailable,
                key_generation: None,
            },
            Err(_) => LocalSyncState {
                status: LocalSyncStatus::Corrupted,
                key_generation: None,
            },
        }
    }

    pub async fn begin_sync_setup(
        &self,
        device_name: &str,
    ) -> Result<BeginSyncSetupResult, CloudPublicError> {
        let device_name = normalize_device_name(device_name)?;
        let client = self.client()?;
        let access_token = self.access_token().await?;
        let bootstrap = client
            .bootstrap_account(&access_token)
            .await
            .map_err(public_client_error)?;
        let state = client
            .sync_state(&access_token)
            .await
            .map_err(public_client_error)?;
        if state.sync.initialized {
            return Err(CloudPublicError::from_code(
                CloudErrorCode::SyncAlreadyInitialized,
            ));
        }
        if !state.connection_sync.permissions.enroll_sync_device {
            let code = if state.connection_sync.phase == "not_entitled" {
                CloudErrorCode::ConnectionSyncNotEntitled
            } else {
                CloudErrorCode::ConnectionSyncRestricted
            };
            return Err(CloudPublicError::from_code(code));
        }
        if state.sync.active_device_count >= state.connection_sync.limits.max_sync_devices {
            return Err(CloudPublicError::from_code(
                CloudErrorCode::SyncDeviceLimitExceeded,
            ));
        }
        let identity_binding = identity_binding(&self.auth_manager.snapshot())?;
        self.sync_setups
            .begin(&bootstrap.account.id, &identity_binding, &device_name)
            .map_err(public_setup_error)
    }

    pub async fn begin_device_authorization(
        &self,
        device_name: &str,
    ) -> Result<BeginDeviceAuthorizationResult, CloudPublicError> {
        let device_name = normalize_device_name(device_name)?;
        let client = self.client()?;
        let access_token = self.access_token().await?;
        let bootstrap = client
            .bootstrap_account(&access_token)
            .await
            .map_err(public_client_error)?;
        let state = client
            .sync_state(&access_token)
            .await
            .map_err(public_client_error)?;
        if !state.sync.initialized {
            return Err(CloudPublicError::from_code(
                CloudErrorCode::SyncNotInitialized,
            ));
        }
        if !state.connection_sync.permissions.enroll_sync_device {
            let code = if state.connection_sync.phase == "not_entitled" {
                CloudErrorCode::ConnectionSyncNotEntitled
            } else {
                CloudErrorCode::ConnectionSyncRestricted
            };
            return Err(CloudPublicError::from_code(code));
        }
        if state.sync.active_device_count >= state.connection_sync.limits.max_sync_devices {
            return Err(CloudPublicError::from_code(
                CloudErrorCode::SyncDeviceLimitExceeded,
            ));
        }
        if self
            .sync_key_store
            .read_committed(&bootstrap.account.id)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?
            .is_some()
        {
            return Err(CloudPublicError::from_code(
                CloudErrorCode::SyncDeviceAlreadyConfigured,
            ));
        }
        let key_generation = state
            .sync
            .key_generation
            .ok_or_else(|| CloudPublicError::from_code(CloudErrorCode::ProtocolError))?;
        let identity_binding = identity_binding(&self.auth_manager.snapshot())?;
        let existing = self
            .sync_key_store
            .read_pending_device_authorization(&bootstrap.account.id)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?;
        let resumed = existing.is_some();
        let pending = match existing {
            Some(pending)
                if pending.identity_binding_sha256 == identity_binding
                    && pending.key_generation == key_generation =>
            {
                pending
            }
            Some(_) => {
                return Err(CloudPublicError::from_code(
                    CloudErrorCode::DeviceAuthorizationConflict,
                ))
            }
            None => {
                let pending = device_authorization::prepare(
                    &bootstrap.account.id,
                    &identity_binding,
                    key_generation,
                    &device_name,
                )
                .map_err(|_| {
                    CloudPublicError::from_code(CloudErrorCode::DeviceAuthorizationInvalid)
                })?;
                self.sync_key_store
                    .stage_device_authorization(&pending)
                    .map_err(|_| {
                        CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable)
                    })?;
                pending
            }
        };
        let request = device_authorization::create_request(&pending);
        let response = client
            .create_device_authorization(
                &access_token,
                &bootstrap.account.id,
                &request,
                &pending.signing_private_key,
            )
            .await;
        match response {
            Ok(response) => {
                validate_created_device_authorization(&pending, &response)?;
                Ok(BeginDeviceAuthorizationResult {
                    evaluated_at: response.evaluated_at,
                    request_id: response.authorization.id,
                    device_id: response.authorization.device.id,
                    device_name: response.authorization.device.display_name,
                    status: response.authorization.status,
                    verification_code: device_authorization::format_verification_code(
                        &pending.verification_code,
                    ),
                    code_version: response.authorization.binding.code_version,
                    created_at: response.authorization.created_at,
                    expires_at: response.authorization.expires_at,
                    code_expires_at: response.authorization.code_expires_at,
                    resumed,
                })
            }
            Err(error) => {
                if error.device_authorization_create_definitely_rejected()
                    && self
                        .sync_key_store
                        .discard_device_authorization(&bootstrap.account.id)
                        .is_err()
                {
                    return Err(CloudPublicError::from_code(
                        CloudErrorCode::SecureStorageUnavailable,
                    ));
                }
                Err(public_client_error(error))
            }
        }
    }

    pub async fn pending_device_authorizations(
        &self,
    ) -> Result<CloudPendingDeviceAuthorizationList, CloudPublicError> {
        let client = self.client()?;
        let access_token = self.access_token().await?;
        let bootstrap = client
            .bootstrap_account(&access_token)
            .await
            .map_err(public_client_error)?;
        let keys = self
            .sync_key_store
            .read_committed(&bootstrap.account.id)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?
            .ok_or_else(|| CloudPublicError::from_code(CloudErrorCode::SyncDeviceNotAuthorized))?;
        let response = client
            .list_pending_device_authorizations(&access_token, &bootstrap.account.id, &keys)
            .await
            .map_err(public_client_error)?;
        Ok(CloudPendingDeviceAuthorizationList {
            evaluated_at: response.evaluated_at,
            items: response.items,
        })
    }

    pub async fn pending_device_authorization_status(
        &self,
    ) -> Result<Option<PendingDeviceAuthorizationStatus>, CloudPublicError> {
        let client = self.client()?;
        let access_token = self.access_token().await?;
        let bootstrap = client
            .bootstrap_account(&access_token)
            .await
            .map_err(public_client_error)?;
        let Some(pending) = self
            .sync_key_store
            .read_pending_device_authorization(&bootstrap.account.id)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?
        else {
            return Ok(None);
        };
        if pending.identity_binding_sha256 != identity_binding(&self.auth_manager.snapshot())? {
            return Err(CloudPublicError::from_code(
                CloudErrorCode::DeviceAuthorizationConflict,
            ));
        }
        let response = client
            .get_pending_device_authorization(
                &access_token,
                &bootstrap.account.id,
                &pending.request_id,
                &pending.device_id,
                &pending.signing_private_key,
            )
            .await
            .map_err(public_client_error)?;
        validate_pending_device_authorization_status(&pending, &response.authorization)?;
        let status = PendingDeviceAuthorizationStatus {
            evaluated_at: response.evaluated_at,
            request_id: pending.request_id.clone(),
            device_id: pending.device_id.clone(),
            device_name: pending.display_name.clone(),
            status: response.authorization.status.clone(),
            verification_code: pending.verification_code.clone(),
            code_version: response.authorization.binding.code_version,
            created_at: response.authorization.created_at,
            expires_at: response.authorization.expires_at,
            code_expires_at: response.authorization.code_expires_at,
        };
        if matches!(status.status.as_str(), "rejected" | "expired" | "canceled") {
            self.sync_key_store
                .discard_device_authorization(&bootstrap.account.id)
                .map_err(|_| {
                    CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable)
                })?;
        }
        Ok(Some(status))
    }

    pub async fn approve_device_authorization(
        &self,
        request_id: &str,
        verification_code: &str,
    ) -> Result<CloudDeviceAuthorization, CloudPublicError> {
        let client = self.client()?;
        let access_token = self.access_token().await?;
        let bootstrap = client
            .bootstrap_account(&access_token)
            .await
            .map_err(public_client_error)?;
        let keys = self
            .sync_key_store
            .read_committed(&bootstrap.account.id)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?
            .ok_or_else(|| CloudPublicError::from_code(CloudErrorCode::SyncDeviceNotAuthorized))?;
        let request = client
            .get_device_authorization(&access_token, &bootstrap.account.id, request_id, &keys)
            .await
            .map_err(public_client_error)?;
        if request.authorization.status != "pending" {
            return Err(CloudPublicError::from_code(
                CloudErrorCode::DeviceAuthorizationNotPending,
            ));
        }
        let code = normalize_verification_code(verification_code)?;
        let envelope = sync_crypto::wrap_device_envelope(
            &bootstrap.account.id,
            &request.authorization.device.id,
            request.authorization.device.key_generation,
            &request.authorization.device.encryption_public_key,
            &keys.amk,
        )
        .map_err(|_| CloudPublicError::from_code(CloudErrorCode::ProtocolError))?;
        let input = types::ApproveDeviceAuthorizationRequest {
            operation_id: stable_operation_id(request_id, "approve"),
            expected_code_version: request.authorization.binding.code_version,
            binding_hash: request.authorization.binding.binding_hash.clone(),
            verification_code: code,
            device_envelope: envelope,
        };
        let result = client
            .approve_device_authorization(
                &access_token,
                &bootstrap.account.id,
                request_id,
                &input,
                &keys,
            )
            .await
            .map_err(public_client_error)?;
        Ok(result.authorization)
    }

    pub async fn reject_device_authorization(
        &self,
        request_id: &str,
    ) -> Result<CloudDeviceAuthorization, CloudPublicError> {
        self.operate_device_authorization(request_id, "reject")
            .await
    }

    pub async fn cancel_device_authorization(
        &self,
        request_id: &str,
    ) -> Result<CloudDeviceAuthorization, CloudPublicError> {
        let client = self.client()?;
        let access_token = self.access_token().await?;
        let bootstrap = client
            .bootstrap_account(&access_token)
            .await
            .map_err(public_client_error)?;
        let pending = self
            .sync_key_store
            .read_pending_device_authorization(&bootstrap.account.id)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?
            .ok_or_else(|| {
                CloudPublicError::from_code(CloudErrorCode::DeviceAuthorizationNotFound)
            })?;
        if pending.request_id != request_id {
            return Err(CloudPublicError::from_code(
                CloudErrorCode::DeviceAuthorizationNotFound,
            ));
        }
        let input = types::DeviceAuthorizationOperationRequest {
            operation_id: stable_operation_id(request_id, "cancel"),
        };
        let result = client
            .cancel_device_authorization(
                &access_token,
                &bootstrap.account.id,
                request_id,
                &input,
                &pending.device_id,
                &pending.signing_private_key,
            )
            .await
            .map_err(public_client_error)?;
        self.sync_key_store
            .discard_device_authorization(&bootstrap.account.id)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?;
        Ok(result.authorization)
    }

    async fn operate_device_authorization(
        &self,
        request_id: &str,
        action: &str,
    ) -> Result<CloudDeviceAuthorization, CloudPublicError> {
        let client = self.client()?;
        let access_token = self.access_token().await?;
        let bootstrap = client
            .bootstrap_account(&access_token)
            .await
            .map_err(public_client_error)?;
        let keys = self
            .sync_key_store
            .read_committed(&bootstrap.account.id)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?
            .ok_or_else(|| CloudPublicError::from_code(CloudErrorCode::SyncDeviceNotAuthorized))?;
        let input = types::DeviceAuthorizationOperationRequest {
            operation_id: stable_operation_id(request_id, action),
        };
        let result = client
            .operate_device_authorization(
                &access_token,
                &bootstrap.account.id,
                request_id,
                action,
                &input,
                &keys,
            )
            .await
            .map_err(public_client_error)?;
        Ok(result.authorization)
    }

    pub async fn claim_device_authorization(
        &self,
    ) -> Result<CloudDeviceAuthorizationClaimResult, CloudPublicError> {
        let client = self.client()?;
        let access_token = self.access_token().await?;
        let bootstrap = client
            .bootstrap_account(&access_token)
            .await
            .map_err(public_client_error)?;
        let pending = self
            .sync_key_store
            .read_pending_device_authorization(&bootstrap.account.id)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?
            .ok_or_else(|| {
                CloudPublicError::from_code(CloudErrorCode::DeviceAuthorizationNotFound)
            })?;
        let input = types::DeviceAuthorizationOperationRequest {
            operation_id: stable_operation_id(&pending.request_id, "claim"),
        };
        let response = client
            .claim_device_authorization(
                &access_token,
                &bootstrap.account.id,
                &pending.request_id,
                &input,
                &pending.device_id,
                &pending.signing_private_key,
            )
            .await
            .map_err(public_client_error)?;
        if response.request_id != pending.request_id
            || response.device_id != pending.device_id
            || response.key_generation != pending.key_generation
        {
            return Err(CloudPublicError::from_code(CloudErrorCode::ProtocolError));
        }
        let amk = sync_crypto::open_device_envelope(
            &pending.cloud_account_id,
            &pending.device_id,
            pending.key_generation,
            &pending.encryption_public_key,
            &pending.encryption_private_key,
            &response.device_envelope,
        )
        .map_err(|_| CloudPublicError::from_code(CloudErrorCode::ProtocolError))?;
        self.sync_key_store
            .commit_device_authorization(&pending, amk)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?;
        Ok(CloudDeviceAuthorizationClaimResult {
            evaluated_at: response.evaluated_at,
            request_id: response.request_id,
            device_id: response.device_id,
            key_generation: response.key_generation,
            claimed_at: response.claimed_at,
        })
    }

    pub fn set_local_sync_paused(
        &self,
        cloud_account_id: &str,
        paused: bool,
    ) -> Result<LocalSyncState, CloudPublicError> {
        let bundle = self
            .sync_key_store
            .read_committed(cloud_account_id)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?
            .ok_or_else(|| CloudPublicError::from_code(CloudErrorCode::SyncDeviceNotAuthorized))?;
        self.local_sync_control
            .set_paused(cloud_account_id, paused)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?;
        Ok(LocalSyncState {
            status: if paused {
                LocalSyncStatus::Paused
            } else {
                LocalSyncStatus::Ready
            },
            key_generation: Some(u64::from(bundle.key_generation)),
        })
    }

    pub async fn revoke_local_device(
        &self,
    ) -> Result<CloudSyncDeviceActionResult, CloudPublicError> {
        let client = self.client()?;
        let access_token = self.access_token().await?;
        let bootstrap = client
            .bootstrap_account(&access_token)
            .await
            .map_err(public_client_error)?;
        let keys = self
            .sync_key_store
            .read_committed(&bootstrap.account.id)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?
            .ok_or_else(|| CloudPublicError::from_code(CloudErrorCode::SyncDeviceNotAuthorized))?;
        let input = types::DeviceAuthorizationOperationRequest {
            operation_id: stable_operation_id(&keys.device_id, "revoke-self"),
        };
        let response = client
            .revoke_sync_device(
                &access_token,
                &bootstrap.account.id,
                &keys.device_id,
                &input,
                &keys,
            )
            .await
            .map_err(public_client_error)?;
        self.sync_key_store
            .discard_committed(&bootstrap.account.id)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?;
        self.local_sync_control
            .clear_account(&bootstrap.account.id)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?;
        Ok(CloudSyncDeviceActionResult {
            evaluated_at: response.evaluated_at,
            device: response.device,
        })
    }

    pub async fn recover_with_recovery_key(
        &self,
        recovery_key: &str,
        device_name: &str,
    ) -> Result<CloudSyncDeviceActionResult, CloudPublicError> {
        let device_name = normalize_device_name(device_name)?;
        let client = self.client()?;
        let access_token = self.access_token().await?;
        let bootstrap = client
            .bootstrap_account(&access_token)
            .await
            .map_err(public_client_error)?;
        let envelope = client
            .recovery_envelope(&access_token)
            .await
            .map_err(public_client_error)?;
        let secret = sync_crypto::decode_recovery_key(recovery_key)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::RecoveryKeyInvalid))?;
        let amk = sync_crypto::open_recovery_envelope(
            &bootstrap.account.id,
            envelope.envelope.key_generation,
            &secret,
            &envelope.envelope.salt,
            &envelope.envelope.nonce,
            &envelope.envelope.ciphertext,
        )
        .map_err(|_| CloudPublicError::from_code(CloudErrorCode::RecoveryKeyInvalid))?;
        let operation_id = stable_operation_id(
            &format!(
                "{}:{}",
                bootstrap.account.id, envelope.envelope.key_generation
            ),
            "recovery-register",
        );
        let binding = identity_binding(&self.auth_manager.snapshot())?;
        let pending = self
            .sync_key_store
            .read_pending(&bootstrap.account.id, &operation_id)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?;
        let (device, keys) = match pending {
            Some(pending) => {
                let device = sync_crypto::recovery_device_from_keys(
                    &pending.device_id,
                    &device_name,
                    &pending.encryption_private_key,
                    &pending.signing_private_key,
                )
                .map_err(|_| CloudPublicError::from_code(CloudErrorCode::ProtocolError))?;
                let keys = sync_crypto::SyncKeyMaterial {
                    amk: pending.amk,
                    encryption_private_key: pending.encryption_private_key,
                    signing_private_key: pending.signing_private_key,
                };
                (device, keys)
            }
            None => {
                let prepared = sync_crypto::prepare_recovery_device(&device_name, amk)
                    .map_err(|_| CloudPublicError::from_code(CloudErrorCode::ProtocolError))?;
                self.sync_key_store
                    .stage_verified(SyncKeyBundleInput {
                        cloud_account_id: &bootstrap.account.id,
                        device_id: &prepared.device.id,
                        initialization_id: &operation_id,
                        identity_binding_sha256: &binding,
                        keys: &prepared.keys,
                    })
                    .map_err(|_| {
                        CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable)
                    })?;
                (prepared.device, prepared.keys)
            }
        };
        let device_envelope = sync_crypto::wrap_device_envelope(
            &bootstrap.account.id,
            &device.id,
            envelope.envelope.key_generation,
            &device.encryption_public_key,
            &keys.amk,
        )
        .map_err(|_| CloudPublicError::from_code(CloudErrorCode::ProtocolError))?;
        let prepared_device = device.clone();
        let payload_device_envelope = device_envelope.clone();
        let payload = serde_json::json!({
            "accountId": bootstrap.account.id,
            "operationId": operation_id,
            "keyGeneration": envelope.envelope.key_generation,
            "device": prepared_device,
            "deviceEnvelope": payload_device_envelope,
        });
        let canonical = device_proof::canonicalize_payload(&payload)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::ProtocolError))?;
        let auth_key = sync_crypto::recovery_auth_signing_key(&secret)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::ProtocolError))?;
        let signature = URL_SAFE_NO_PAD.encode(auth_key.sign(canonical.as_bytes()).to_bytes());
        let device = payload
            .get("device")
            .cloned()
            .ok_or_else(|| CloudPublicError::from_code(CloudErrorCode::ProtocolError))?;
        let device: types::CreateCloudDeviceAuthorizationDevice = serde_json::from_value(device)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::ProtocolError))?;
        let device_envelope: types::CloudDeviceKeyEnvelope = serde_json::from_value(
            payload
                .get("deviceEnvelope")
                .cloned()
                .ok_or_else(|| CloudPublicError::from_code(CloudErrorCode::ProtocolError))?,
        )
        .map_err(|_| CloudPublicError::from_code(CloudErrorCode::ProtocolError))?;
        let operation_id = payload
            .get("operationId")
            .and_then(|value| value.as_str())
            .ok_or_else(|| CloudPublicError::from_code(CloudErrorCode::ProtocolError))?;
        let request = types::RegisterRecoveryDeviceRequest {
            operation_id: operation_id.to_string(),
            key_generation: envelope.envelope.key_generation,
            device,
            device_envelope,
            recovery_auth_signature: signature,
        };
        let response = client
            .register_recovery_device(&access_token, &request)
            .await;
        match response {
            Ok(response) => {
                self.sync_key_store
                    .commit_pending(SyncKeyBundleInput {
                        cloud_account_id: &bootstrap.account.id,
                        device_id: &request.device.id,
                        initialization_id: &request.operation_id,
                        identity_binding_sha256: &binding,
                        keys: &keys,
                    })
                    .map_err(|_| {
                        CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable)
                    })?;
                Ok(CloudSyncDeviceActionResult {
                    evaluated_at: response.evaluated_at,
                    device: response.device,
                })
            }
            Err(error) => {
                if !matches!(
                    error,
                    CloudClientError::TemporarilyUnavailable
                        | CloudClientError::ResponseTooLarge
                        | CloudClientError::InvalidResponse
                ) {
                    let _ = self
                        .sync_key_store
                        .discard_pending(&bootstrap.account.id, &request.operation_id);
                }
                Err(public_client_error(error))
            }
        }
    }

    pub async fn rotate_recovery_key(&self) -> Result<RecoveryKeyRotationResult, CloudPublicError> {
        let client = self.client()?;
        let access_token = self.access_token().await?;
        let bootstrap = client
            .bootstrap_account(&access_token)
            .await
            .map_err(public_client_error)?;
        let keys = self
            .sync_key_store
            .read_committed(&bootstrap.account.id)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?
            .ok_or_else(|| CloudPublicError::from_code(CloudErrorCode::SyncDeviceNotAuthorized))?;
        let current = client
            .recovery_envelope(&access_token)
            .await
            .map_err(public_client_error)?;
        let (recovery_key, envelope, recovery_auth_public_key) =
            sync_crypto::prepare_recovery_rotation(
                &bootstrap.account.id,
                current.envelope.key_generation,
                &keys.amk,
            )
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::ProtocolError))?;
        let operation_id = stable_operation_id(
            &format!("{}:{}", bootstrap.account.id, current.envelope.revision),
            "recovery-rotate",
        );
        let request = types::ReplaceRecoveryEnvelopeRequest {
            operation_id,
            expected_revision: current.envelope.revision,
            key_generation: current.envelope.key_generation,
            envelope,
            recovery_auth_public_key,
        };
        let response = client
            .replace_recovery_envelope(&access_token, &bootstrap.account.id, &request, &keys)
            .await
            .map_err(public_client_error)?;
        let rotation_id = Uuid::new_v4().to_string();
        self.rotation_key
            .lock()
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?
            .replace((rotation_id.clone(), Zeroizing::new(recovery_key.clone())));
        Ok(RecoveryKeyRotationResult {
            rotation_id,
            recovery_key,
            evaluated_at: response.evaluated_at,
        })
    }

    pub async fn delete_cloud_sync_data(&self) -> Result<String, CloudPublicError> {
        let client = self.client()?;
        let access_token = self.access_token().await?;
        let bootstrap = client
            .bootstrap_account(&access_token)
            .await
            .map_err(public_client_error)?;
        let keys = self
            .sync_key_store
            .read_committed(&bootstrap.account.id)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?
            .ok_or_else(|| CloudPublicError::from_code(CloudErrorCode::SyncDeviceNotAuthorized))?;
        let request = types::DeleteSyncDataRequest {
            operation_id: stable_operation_id(&keys.device_id, "delete-cloud-sync-data"),
            confirmation: "DELETE_CLOUD_SYNC_DATA".to_string(),
        };
        let response = client
            .delete_sync_data(&access_token, &bootstrap.account.id, &request, &keys)
            .await
            .map_err(public_client_error)?;
        self.sync_key_store
            .discard_committed(&bootstrap.account.id)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?;
        self.local_sync_control
            .clear_account(&bootstrap.account.id)
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::SecureStorageUnavailable))?;
        self.projection_cache.clear();
        Ok(response.evaluated_at)
    }

    pub fn copy_rotated_recovery_key(&self, rotation_id: &str) -> Result<(), CloudPublicError> {
        let guard = self
            .rotation_key
            .lock()
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::RecoveryKeyExportFailed))?;
        let Some((stored_id, key)) = guard.as_ref() else {
            return Err(CloudPublicError::from_code(
                CloudErrorCode::RecoveryKeyExportFailed,
            ));
        };
        if stored_id != rotation_id {
            return Err(CloudPublicError::from_code(
                CloudErrorCode::RecoveryKeyExportFailed,
            ));
        }
        Clipboard::new()
            .and_then(|mut clipboard| clipboard.set_text(key.as_str()))
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::RecoveryKeyExportFailed))
    }

    pub fn save_rotated_recovery_key<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        rotation_id: &str,
    ) -> Result<RecoveryKeyExportResult, CloudPublicError> {
        let key = {
            let guard = self.rotation_key.lock().map_err(|_| {
                CloudPublicError::from_code(CloudErrorCode::RecoveryKeyExportFailed)
            })?;
            let Some((stored_id, key)) = guard.as_ref() else {
                return Err(CloudPublicError::from_code(
                    CloudErrorCode::RecoveryKeyExportFailed,
                ));
            };
            if stored_id != rotation_id {
                return Err(CloudPublicError::from_code(
                    CloudErrorCode::RecoveryKeyExportFailed,
                ));
            }
            key.to_string()
        };
        let Some(path) = app
            .dialog()
            .file()
            .set_file_name("NexusPilot-Recovery-Key.txt")
            .blocking_save_file()
        else {
            return Ok(RecoveryKeyExportResult { completed: false });
        };
        let path = path
            .into_path()
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::RecoveryKeyExportFailed))?;
        fs::write(path, format!("{key}\n").as_bytes())
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::RecoveryKeyExportFailed))?;
        Ok(RecoveryKeyExportResult { completed: true })
    }

    pub fn copy_recovery_key(&self, setup_id: &str) -> Result<(), CloudPublicError> {
        let recovery_key = Zeroizing::new(
            self.sync_setups
                .recovery_key(setup_id)
                .map_err(public_setup_error)?,
        );
        let mut clipboard = Clipboard::new()
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::RecoveryKeyExportFailed))?;
        clipboard
            .set_text(recovery_key.as_str())
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::RecoveryKeyExportFailed))
    }

    pub fn save_recovery_key<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        setup_id: &str,
    ) -> Result<RecoveryKeyExportResult, CloudPublicError> {
        let recovery_key = Zeroizing::new(
            self.sync_setups
                .recovery_key(setup_id)
                .map_err(public_setup_error)?,
        );
        let selection = app
            .dialog()
            .file()
            .set_title("保存 NexusPilot 恢复密钥")
            .set_file_name("NexusPilot-Recovery-Key.txt")
            .blocking_save_file();
        let Some(selection) = selection else {
            return Ok(RecoveryKeyExportResult { completed: false });
        };
        let path = selection
            .into_path()
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::RecoveryKeyExportFailed))?;
        let content = Zeroizing::new(format!(
            "NexusPilot 恢复密钥\n\n{}\n\n请将此文件保存在安全位置。任何获得此密钥的人都可能解密你的同步数据。\n",
            recovery_key.as_str()
        ));
        fs::write(path, content.as_bytes())
            .map_err(|_| CloudPublicError::from_code(CloudErrorCode::RecoveryKeyExportFailed))?;
        Ok(RecoveryKeyExportResult { completed: true })
    }

    pub async fn finalize_sync_setup(
        &self,
        setup_id: &str,
    ) -> Result<CloudSyncStateProjection, CloudPublicError> {
        let pending = self
            .sync_setups
            .take(setup_id)
            .map_err(public_setup_error)?;
        let identity_binding = match identity_binding(&self.auth_manager.snapshot()) {
            Ok(binding) if binding == pending.identity_binding_sha256 => binding,
            _ => {
                return Err(CloudPublicError::from_code(
                    CloudErrorCode::SyncSetupInvalid,
                ))
            }
        };
        let client = match self.client() {
            Ok(client) => client,
            Err(error) => {
                self.sync_setups.put_back(pending);
                return Err(error);
            }
        };
        let access_token = match self.access_token().await {
            Ok(token) => token,
            Err(error) => {
                self.sync_setups.put_back(pending);
                return Err(error);
            }
        };
        if let Err(_error) = self.sync_key_store.stage_verified(SyncKeyBundleInput {
            cloud_account_id: &pending.cloud_account_id,
            device_id: &pending.device_id,
            initialization_id: &pending.initialization_id,
            identity_binding_sha256: &identity_binding,
            keys: &pending.prepared.keys,
        }) {
            self.sync_setups.put_back(pending);
            return Err(CloudPublicError::from_code(
                CloudErrorCode::SecureStorageUnavailable,
            ));
        }
        match client
            .initialize_sync(&access_token, &pending.prepared.request)
            .await
        {
            Ok(state) => {
                if let Err(_error) = self.sync_key_store.commit_pending(SyncKeyBundleInput {
                    cloud_account_id: &pending.cloud_account_id,
                    device_id: &pending.device_id,
                    initialization_id: &pending.initialization_id,
                    identity_binding_sha256: &identity_binding,
                    keys: &pending.prepared.keys,
                }) {
                    self.sync_setups.put_back(pending);
                    return Err(CloudPublicError::from_code(
                        CloudErrorCode::SecureStorageUnavailable,
                    ));
                }
                Ok(state)
            }
            Err(error) => {
                if !error.sync_initialization_outcome_unknown()
                    && self
                        .sync_key_store
                        .discard_pending(&pending.cloud_account_id, &pending.initialization_id)
                        .is_err()
                {
                    self.sync_setups.put_back(pending);
                    return Err(CloudPublicError::from_code(
                        CloudErrorCode::SecureStorageUnavailable,
                    ));
                }
                self.sync_setups.put_back(pending);
                Err(public_client_error(error))
            }
        }
    }

    pub fn cancel_sync_setup(&self, setup_id: &str) {
        self.sync_setups.cancel(setup_id);
    }

    pub fn clear_pending_sync_setups(&self) {
        self.sync_setups.clear_all();
    }

    fn client(&self) -> Result<&CloudApiClient, CloudPublicError> {
        self.client
            .as_ref()
            .map_err(|error| public_client_error(*error))
    }

    async fn access_token(&self) -> Result<crate::auth::SecretString, CloudPublicError> {
        self.token_broker
            .access_token()
            .await
            .map_err(public_broker_error)
    }

    async fn current_cloud_account_id(&self) -> Result<String, CloudPublicError> {
        let client = self.client()?;
        let access_token = self.access_token().await?;
        client
            .bootstrap_account(&access_token)
            .await
            .map(|projection| projection.account.id)
            .map_err(public_client_error)
    }
}

pub fn setup<R: Runtime>(app: &mut App<R>) {
    let auth_manager = app.state::<AuthManager>().inner().clone();
    let app_handle = app.handle().clone();
    let desktop_state = CloudDesktopStateStore::new(Arc::new(move |projection| {
        if let Err(error) = app_handle.emit(CLOUD_DESKTOP_STATE_CHANGED_EVENT, projection) {
            tauri_plugin_log::log::debug!(
                "Unable to publish Cloud desktop state projection: {error}"
            );
        }
    }));
    if !app.manage(desktop_state.clone()) {
        tauri_plugin_log::log::error!(
            "Cloud desktop state was already managed; Cloud state projection is unavailable"
        );
    }
    let service = CloudAccountService::new(
        auth_manager.clone(),
        app.path().app_data_dir().ok(),
        desktop_state.clone(),
    );
    if service.client.is_err() {
        tauri_plugin_log::log::error!(
            "Embedded Cloud API client configuration is invalid; local workbench will continue"
        );
    }
    if !app.manage(service) {
        tauri_plugin_log::log::error!(
            "Cloud account service state was already managed; Cloud features are unavailable"
        );
    }
    let app_handle = app.handle().clone();
    let desktop_state_refresh_scheduled = Arc::new(AtomicBool::new(false));
    let refresh_scheduled_for_events = desktop_state_refresh_scheduled.clone();
    app.listen(crate::auth::AUTH_SESSION_CHANGED_EVENT, move |event| {
        let phase = serde_json::from_str::<serde_json::Value>(event.payload())
            .ok()
            .and_then(|payload| payload.get("phase")?.as_str().map(str::to_string));
        if matches!(
            phase.as_deref(),
            Some("anonymous" | "reauthenticationRequired")
        ) {
            refresh_scheduled_for_events.store(false, Ordering::SeqCst);
            if let Some(service) = app_handle.try_state::<CloudAccountService>() {
                service.clear_pending_sync_setups();
                if phase.as_deref() == Some("anonymous") {
                    service.projection_cache.clear();
                }
            }
        }
        if let Some(scheduler) = app_handle.try_state::<CloudSyncScheduler>() {
            scheduler.handle_auth_session_event(phase.as_deref() == Some("authenticated"));
        }
        if let Some(desktop_state) = app_handle.try_state::<CloudDesktopStateStore>() {
            desktop_state.on_auth_session_event(phase.as_deref());
        }
        if phase.as_deref() == Some("authenticated")
            && !refresh_scheduled_for_events.swap(true, Ordering::SeqCst)
        {
            refresh_desktop_state_in_background(app_handle.clone());
        }
    });
    if identity_binding(&auth_manager.snapshot()).is_ok()
        && !desktop_state_refresh_scheduled.swap(true, Ordering::SeqCst)
    {
        refresh_desktop_state_in_background(app.handle().clone());
    }
}

/// Refresh the authoritative Cloud account projection after an authenticated
/// account session is established. This covers exactly one refresh for each
/// restored session on application launch as well as a newly completed sign-in,
/// without making React or the sync scheduler responsible for account-state
/// freshness.
fn refresh_desktop_state_in_background<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let Some(service) = app.try_state::<CloudAccountService>() else {
            tauri_plugin_log::log::error!(
                "Cloud account service was unavailable; startup Cloud state refresh was skipped"
            );
            return;
        };
        if let Err(error) = service.sync_setup_context().await {
            tauri_plugin_log::log::debug!(
                "Cloud account state refresh after authentication did not complete: code={:?}",
                error.code
            );
        }
    });
}

pub(crate) fn start_sync_scheduler<R: Runtime>(app: &AppHandle<R>) {
    let Some(desktop_state) = app.try_state::<CloudDesktopStateStore>() else {
        tauri_plugin_log::log::error!(
            "Cloud desktop state was not managed; automatic synchronization is unavailable"
        );
        return;
    };
    let scheduler = sync_scheduler::CloudSyncScheduler::new(app, desktop_state.inner().clone());
    if !app.manage(scheduler.clone()) {
        tauri_plugin_log::log::error!(
            "Cloud sync scheduler state was already managed; automatic synchronization is unavailable"
        );
        return;
    }
    scheduler.start();
}

fn public_broker_error(error: CloudTokenBrokerError) -> CloudPublicError {
    let code = match error {
        CloudTokenBrokerError::Unauthenticated => CloudErrorCode::Unauthenticated,
        CloudTokenBrokerError::TemporarilyUnavailable => CloudErrorCode::AuthTemporarilyUnavailable,
        CloudTokenBrokerError::ReauthenticationRequired => CloudErrorCode::ReauthenticationRequired,
        CloudTokenBrokerError::SystemInternal => CloudErrorCode::AuthTemporarilyUnavailable,
    };
    CloudPublicError::from_code(code)
}

fn public_client_error(error: CloudClientError) -> CloudPublicError {
    let code = match error {
        CloudClientError::Unauthorized => CloudErrorCode::ReauthenticationRequired,
        CloudClientError::InsufficientScope => CloudErrorCode::InsufficientScope,
        CloudClientError::TemporarilyUnavailable => CloudErrorCode::TemporarilyUnavailable,
        CloudClientError::InvalidConfiguration
        | CloudClientError::ResponseTooLarge
        | CloudClientError::InvalidResponse => CloudErrorCode::ProtocolError,
        CloudClientError::AccountNotInitialized => CloudErrorCode::AccountNotInitialized,
        CloudClientError::ConnectionSyncNotEntitled => CloudErrorCode::ConnectionSyncNotEntitled,
        CloudClientError::ConnectionSyncLifecycleRestricted => {
            CloudErrorCode::ConnectionSyncRestricted
        }
        CloudClientError::AccountUnavailable => CloudErrorCode::AccountUnavailable,
        CloudClientError::SyncDeviceLimitExceeded => CloudErrorCode::SyncDeviceLimitExceeded,
        CloudClientError::SyncNotInitialized => CloudErrorCode::SyncNotInitialized,
        CloudClientError::DeviceAuthorizationRequestMismatch => {
            CloudErrorCode::DeviceAuthorizationConflict
        }
        CloudClientError::PendingDeviceAuthorizationLimitExceeded => {
            CloudErrorCode::DeviceAuthorizationPendingLimitExceeded
        }
        CloudClientError::DeviceAuthorizationNotFound => {
            CloudErrorCode::DeviceAuthorizationNotFound
        }
        CloudClientError::DeviceAuthorizationNotPending => {
            CloudErrorCode::DeviceAuthorizationNotPending
        }
        CloudClientError::SyncDeviceIdConflict => CloudErrorCode::DeviceAuthorizationConflict,
        CloudClientError::SyncAlreadyInitialized => CloudErrorCode::SyncAlreadyInitialized,
        CloudClientError::SyncInitializationMismatch | CloudClientError::InvalidSyncRequest => {
            CloudErrorCode::SyncInitializationMismatch
        }
        CloudClientError::SyncDeviceNotAuthorized => CloudErrorCode::SyncDeviceNotAuthorized,
        CloudClientError::ConnectionAssetOperationMismatch
        | CloudClientError::ConnectionAssetTypeMismatch => CloudErrorCode::ConnectionSyncConflict,
        CloudClientError::EncryptedByteLimitExceeded => CloudErrorCode::ConnectionSyncQuotaExceeded,
        CloudClientError::ConnectionAssetTooLarge => CloudErrorCode::ConnectionSyncAssetTooLarge,
        CloudClientError::ConnectionAssetCursorInvalid
        | CloudClientError::SyncKeyGenerationMismatch => CloudErrorCode::ProtocolError,
        CloudClientError::DeviceProofUnavailable => CloudErrorCode::SecureStorageUnavailable,
    };
    CloudPublicError::from_code(code)
}

fn public_setup_error(error: SyncSetupError) -> CloudPublicError {
    let code = match error {
        SyncSetupError::Expired => CloudErrorCode::SyncSetupExpired,
        SyncSetupError::Invalid | SyncSetupError::Crypto => CloudErrorCode::SyncSetupInvalid,
    };
    CloudPublicError::from_code(code)
}

fn normalize_verification_code(value: &str) -> Result<String, CloudPublicError> {
    let code = value
        .chars()
        .filter(|character| *character != '-')
        .flat_map(char::to_uppercase)
        .collect::<String>();
    if code.len() != 12
        || !code
            .bytes()
            .all(|byte| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&byte))
    {
        return Err(CloudPublicError::from_code(
            CloudErrorCode::DeviceAuthorizationInvalid,
        ));
    }
    Ok(code)
}

fn stable_operation_id(request_id: &str, action: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"NexusPilot.Cloud.DeviceAuthorization.Operation.v1");
    hasher.update((request_id.len() as u32).to_be_bytes());
    hasher.update(request_id.as_bytes());
    hasher.update((action.len() as u32).to_be_bytes());
    hasher.update(action.as_bytes());
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&hasher.finalize()[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).to_string()
}

fn identity_binding(snapshot: &AuthSessionSnapshot) -> Result<String, CloudPublicError> {
    let user = snapshot
        .user
        .as_ref()
        .ok_or_else(|| CloudPublicError::from_code(CloudErrorCode::Unauthenticated))?;
    let mut hasher = Sha256::new();
    hasher.update(user.issuer.as_bytes());
    hasher.update([0]);
    hasher.update(user.subject.as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(hasher.finalize()))
}

fn normalize_device_name(value: &str) -> Result<String, CloudPublicError> {
    let value = value.trim();
    let invalid = value.is_empty()
        || value.chars().count() > 64
        || value.len() > 256
        || value.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '\u{061c}'
                        | '\u{200e}'
                        | '\u{200f}'
                        | '\u{202a}'..='\u{202e}'
                        | '\u{2066}'..='\u{2069}'
                )
        });
    if invalid {
        return Err(CloudPublicError::from_code(
            CloudErrorCode::SyncSetupInvalid,
        ));
    }
    Ok(value.to_string())
}

fn validate_created_device_authorization(
    pending: &sync_key_store::PendingDeviceAuthorizationBundle,
    response: &types::CloudDeviceAuthorizationResponse,
) -> Result<(), CloudPublicError> {
    let authorization = &response.authorization;
    let matches = authorization.id == pending.request_id
        && authorization.device.id == pending.device_id
        && authorization.device.display_name == pending.display_name
        && authorization.device.key_generation == pending.key_generation
        && authorization.device.encryption_public_key == pending.encryption_public_key
        && authorization.device.signing_public_key == pending.signing_public_key
        && authorization.binding.pairing_nonce == pending.pairing_nonce
        && authorization.binding.binding_hash == pending.verification_code_hash
        && authorization.binding.code_version == 1;
    if matches {
        Ok(())
    } else {
        Err(CloudPublicError::from_code(CloudErrorCode::ProtocolError))
    }
}

fn validate_pending_device_authorization_status(
    pending: &sync_key_store::PendingDeviceAuthorizationBundle,
    authorization: &types::CloudDeviceAuthorization,
) -> Result<(), CloudPublicError> {
    let matches = authorization.id == pending.request_id
        && authorization.device.id == pending.device_id
        && authorization.device.display_name == pending.display_name
        && authorization.device.key_generation == pending.key_generation
        && authorization.device.encryption_public_key == pending.encryption_public_key
        && authorization.device.signing_public_key == pending.signing_public_key
        && authorization.binding.pairing_nonce == pending.pairing_nonce
        && authorization.binding.binding_hash == pending.verification_code_hash
        && authorization.binding.code_version == 1;
    if matches {
        Ok(())
    } else {
        Err(CloudPublicError::from_code(CloudErrorCode::ProtocolError))
    }
}

fn suggested_device_name() -> String {
    let hostname = tauri_plugin_os::hostname();
    let trimmed = hostname.trim();
    if trimmed.is_empty() {
        return "NexusPilot Device".to_string();
    }
    trimmed
        .split('.')
        .next()
        .unwrap_or(trimmed)
        .chars()
        .take(64)
        .collect()
}

fn resolve_sync_setup_context(
    refreshed: Result<CloudSyncSetupContext, CloudPublicError>,
    cached: Option<CloudProjectionCacheRecord>,
    suggested_device_name: String,
    cached_local_sync: Option<LocalSyncState>,
) -> Result<CloudSyncSetupContext, CloudPublicError> {
    match refreshed {
        Ok(context) => Ok(context),
        Err(error) if error.retryable => cached
            .map(|cached| CloudSyncSetupContext {
                evaluated_at: cached.cached_at.clone(),
                account: cached.account,
                subscription: cached.subscription,
                connection_sync: cached.connection_sync,
                sync: cached.sync,
                local_sync: cached_local_sync.unwrap_or(LocalSyncState {
                    status: LocalSyncStatus::Disabled,
                    key_generation: None,
                }),
                devices: cached.devices,
                suggested_device_name,
                source: CloudProjectionSource::Cache,
                cached_at: Some(cached.cached_at),
            })
            .ok_or(error),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        device_authorization, projection_cache, public_broker_error, public_client_error,
        resolve_sync_setup_context, validate_created_device_authorization,
        validate_pending_device_authorization_status, CloudClientError, CloudErrorCode,
        CloudProjectionCacheRecord, CloudProjectionSource, CloudPublicError, CloudSyncSetupContext,
        CloudTokenBrokerError, LocalSyncState, LocalSyncStatus,
    };

    const CONTEXT_JSON: &str = r#"{
        "evaluatedAt":"2026-08-08T00:00:00.000Z",
        "account":{"id":"account","status":"active"},
        "subscription":{"planCode":"plus","status":"active","currentPeriodEnd":null},
        "connectionSync":{
            "phase":"active",
            "permissions":{"readEncryptedAssets":true,"writeEncryptedAssets":true,"enrollSyncDevice":true,"approveDeviceAuthorization":true,"recoverExistingAssets":true},
            "limits":{"maxSyncDevices":3,"maxEncryptedBytes":10485760},
            "usage":{"activeSyncDevices":1,"encryptedBytes":0},
            "effectiveAt":null,"expiresAt":null,"phaseEndsAt":null,"deletionEligibleAt":null,"entitlementVersion":1,"policyVersion":1
        },
        "sync":{"initialized":true,"keyGeneration":1,"activeDeviceCount":1,"initializedAt":null},
        "localSync":{"status":"ready","keyGeneration":1},
        "devices":[],
        "suggestedDeviceName":"desktop",
        "source":"cloud",
        "cachedAt":"2026-08-08T00:00:00.000Z"
    }"#;

    #[test]
    fn internal_failures_map_to_stable_token_free_public_errors() {
        let cases = [
            (
                public_broker_error(CloudTokenBrokerError::Unauthenticated),
                CloudErrorCode::Unauthenticated,
            ),
            (
                public_broker_error(CloudTokenBrokerError::TemporarilyUnavailable),
                CloudErrorCode::AuthTemporarilyUnavailable,
            ),
            (
                public_client_error(CloudClientError::Unauthorized),
                CloudErrorCode::ReauthenticationRequired,
            ),
            (
                public_client_error(CloudClientError::InsufficientScope),
                CloudErrorCode::InsufficientScope,
            ),
            (
                public_client_error(CloudClientError::TemporarilyUnavailable),
                CloudErrorCode::TemporarilyUnavailable,
            ),
        ];

        for (error, expected_code) in cases {
            assert_eq!(error.code, expected_code);
            let serialized = serde_json::to_string(&error).expect("public error should serialize");
            for forbidden in [
                "accessToken",
                "refreshToken",
                "authorization",
                "Bearer ",
                "issuer",
                "subject",
                "claims",
            ] {
                assert!(!serialized.contains(forbidden));
            }
        }
    }

    #[test]
    fn retryable_refresh_failure_uses_display_cache_but_permanent_failure_does_not() {
        let context: CloudSyncSetupContext =
            serde_json::from_str(CONTEXT_JSON).expect("test context");
        let cached = CloudProjectionCacheRecord {
            version: projection_cache::cache_version(),
            identity_binding_sha256: "identity".to_string(),
            cloud_account_id: context.account.id.clone(),
            account: context.account.clone(),
            subscription: context.subscription.clone(),
            connection_sync: context.connection_sync.clone(),
            sync: context.sync.clone(),
            devices: context.devices.clone(),
            cached_at: "2026-08-08T00:00:00.000Z".to_string(),
        };

        let fallback = resolve_sync_setup_context(
            Err(CloudPublicError::from_code(
                CloudErrorCode::TemporarilyUnavailable,
            )),
            Some(cached.clone()),
            "desktop".to_string(),
            Some(LocalSyncState {
                status: LocalSyncStatus::Ready,
                key_generation: Some(1),
            }),
        )
        .expect("retryable error should use cache");
        assert_eq!(fallback.source, CloudProjectionSource::Cache);
        assert_eq!(fallback.account.id, "account");
        assert_eq!(fallback.local_sync.status, LocalSyncStatus::Ready);

        let permanent = resolve_sync_setup_context(
            Err(CloudPublicError::from_code(
                CloudErrorCode::InsufficientScope,
            )),
            Some(cached),
            "desktop".to_string(),
            Some(LocalSyncState {
                status: LocalSyncStatus::Ready,
                key_generation: Some(1),
            }),
        )
        .expect_err("permanent error must not be hidden by cache");
        assert_eq!(permanent.code, CloudErrorCode::InsufficientScope);
    }

    #[test]
    fn device_authorization_response_must_match_pending_public_projection() {
        let pending = device_authorization::prepare("account", "identity", 1, "DESKTOP-01")
            .expect("pending authorization");
        let response = super::types::CloudDeviceAuthorizationResponse {
            evaluated_at: "2026-08-08T00:00:00.000Z".to_string(),
            authorization: super::types::CloudDeviceAuthorization {
                id: pending.request_id.clone(),
                status: "pending".to_string(),
                device: super::types::CloudDeviceAuthorizationDevice {
                    id: pending.device_id.clone(),
                    display_name: pending.display_name.clone(),
                    key_generation: pending.key_generation,
                    encryption_public_key: pending.encryption_public_key.clone(),
                    signing_public_key: pending.signing_public_key.clone(),
                },
                binding: super::types::CloudDeviceAuthorizationBinding {
                    pairing_nonce: pending.pairing_nonce.clone(),
                    code_version: 1,
                    binding_hash: pending.verification_code_hash.clone(),
                },
                created_at: "2026-08-08T00:00:00.000Z".to_string(),
                expires_at: "2026-08-15T00:00:00.000Z".to_string(),
                code_expires_at: "2026-08-08T00:20:00.000Z".to_string(),
                approved_at: None,
            },
        };
        validate_created_device_authorization(&pending, &response)
            .expect("matching Cloud projection should be accepted");
        validate_pending_device_authorization_status(&pending, &response.authorization)
            .expect("matching pending authorization status should be accepted");

        let mut mismatched = response;
        mismatched.authorization.device.signing_public_key = "different".to_string();
        assert_eq!(
            validate_created_device_authorization(&pending, &mismatched)
                .expect_err("changed public key must fail closed")
                .code,
            CloudErrorCode::ProtocolError
        );
        assert_eq!(
            validate_pending_device_authorization_status(&pending, &mismatched.authorization)
                .expect_err("changed pending authorization status must fail closed")
                .code,
            CloudErrorCode::ProtocolError
        );
    }
}
