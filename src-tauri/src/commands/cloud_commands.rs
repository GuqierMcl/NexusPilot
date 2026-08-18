use tauri::{AppHandle, Runtime, State};

use crate::cloud::{
    BeginDeviceAuthorizationResult, BeginSyncSetupResult, CloudAccountBootstrap,
    CloudAccountService, CloudDesktopStateProjection, CloudDesktopStateStore,
    CloudDeviceAuthorization, CloudDeviceAuthorizationClaimResult, CloudLocalDependencyList,
    CloudPendingDeviceAuthorizationList, CloudPublicError, CloudSyncConflictDecision,
    CloudSyncConflictView, CloudSyncDeviceActionResult, CloudSyncDevicesView, CloudSyncRunResult,
    CloudSyncRuntimeProjection, CloudSyncScheduler, CloudSyncSetupContext,
    CloudSyncStateProjection, LocalDependencyKind, LocalSyncState,
    PendingDeviceAuthorizationStatus, RecoveryKeyExportResult, RecoveryKeyRotationResult,
};
use crate::db::DatabaseState;

#[tauri::command]
pub async fn bootstrap_cloud_account(
    state: State<'_, CloudAccountService>,
) -> Result<CloudAccountBootstrap, CloudPublicError> {
    state.bootstrap_account().await
}

#[tauri::command]
pub async fn get_sync_setup_context(
    state: State<'_, CloudAccountService>,
) -> Result<CloudSyncSetupContext, CloudPublicError> {
    state.sync_setup_context().await
}

#[tauri::command]
pub async fn get_cloud_sync_status(
    state: State<'_, CloudAccountService>,
) -> Result<CloudSyncSetupContext, CloudPublicError> {
    state.cloud_sync_status().await
}

#[tauri::command]
pub fn get_cloud_desktop_state(
    state: State<'_, CloudDesktopStateStore>,
    service: State<'_, CloudAccountService>,
) -> CloudDesktopStateProjection {
    if state.snapshot().context.is_none() {
        let _ = service.cached_sync_setup_context();
    }
    state.snapshot()
}

#[tauri::command]
pub async fn refresh_cloud_desktop_state(
    state: State<'_, CloudAccountService>,
) -> Result<CloudDesktopStateProjection, CloudPublicError> {
    state.sync_setup_context().await?;
    Ok(state.desktop_state_snapshot())
}

#[tauri::command]
pub fn get_cached_sync_setup_context(
    state: State<'_, CloudAccountService>,
) -> Result<Option<CloudSyncSetupContext>, CloudPublicError> {
    state.cached_sync_setup_context()
}

#[tauri::command]
pub async fn sync_cloud_now(
    state: State<'_, CloudSyncScheduler>,
) -> Result<CloudSyncRunResult, CloudPublicError> {
    state.run_now().await
}

#[tauri::command]
pub fn get_cloud_sync_runtime_status(
    state: State<'_, CloudSyncScheduler>,
) -> CloudSyncRuntimeProjection {
    state.status()
}

#[tauri::command]
pub async fn list_cloud_devices(
    state: State<'_, CloudAccountService>,
) -> Result<CloudSyncDevicesView, CloudPublicError> {
    state.cloud_devices().await
}

#[tauri::command]
pub async fn begin_sync_setup(
    device_name: String,
    state: State<'_, CloudAccountService>,
) -> Result<BeginSyncSetupResult, CloudPublicError> {
    state.begin_sync_setup(&device_name).await
}

#[tauri::command]
pub async fn begin_device_authorization(
    device_name: String,
    state: State<'_, CloudAccountService>,
) -> Result<BeginDeviceAuthorizationResult, CloudPublicError> {
    state.begin_device_authorization(&device_name).await
}

#[tauri::command]
pub async fn list_pending_device_authorizations(
    state: State<'_, CloudAccountService>,
) -> Result<CloudPendingDeviceAuthorizationList, CloudPublicError> {
    state.pending_device_authorizations().await
}

#[tauri::command]
pub async fn get_pending_device_authorization(
    state: State<'_, CloudAccountService>,
) -> Result<Option<PendingDeviceAuthorizationStatus>, CloudPublicError> {
    state.pending_device_authorization_status().await
}

#[tauri::command]
pub async fn approve_device_authorization(
    request_id: String,
    verification_code: String,
    state: State<'_, CloudAccountService>,
) -> Result<CloudDeviceAuthorization, CloudPublicError> {
    state
        .approve_device_authorization(&request_id, &verification_code)
        .await
}

#[tauri::command]
pub async fn reject_device_authorization(
    request_id: String,
    state: State<'_, CloudAccountService>,
) -> Result<CloudDeviceAuthorization, CloudPublicError> {
    state.reject_device_authorization(&request_id).await
}

#[tauri::command]
pub async fn cancel_device_authorization(
    request_id: String,
    state: State<'_, CloudAccountService>,
) -> Result<CloudDeviceAuthorization, CloudPublicError> {
    state.cancel_device_authorization(&request_id).await
}

#[tauri::command]
pub async fn claim_device_authorization(
    state: State<'_, CloudAccountService>,
    scheduler: State<'_, CloudSyncScheduler>,
) -> Result<CloudDeviceAuthorizationClaimResult, CloudPublicError> {
    let result = state.claim_device_authorization().await?;
    scheduler.set_paused(false);
    Ok(result)
}

#[tauri::command]
pub fn set_local_sync_paused(
    cloud_account_id: String,
    paused: bool,
    state: State<'_, CloudAccountService>,
    scheduler: State<'_, CloudSyncScheduler>,
) -> Result<LocalSyncState, CloudPublicError> {
    let result = state.set_local_sync_paused(&cloud_account_id, paused)?;
    scheduler.set_paused(paused);
    Ok(result)
}

#[tauri::command]
pub async fn revoke_local_sync_device(
    state: State<'_, CloudAccountService>,
    scheduler: State<'_, CloudSyncScheduler>,
) -> Result<CloudSyncDeviceActionResult, CloudPublicError> {
    let result = state.revoke_local_device().await?;
    scheduler.mark_device_revoked();
    Ok(result)
}

#[tauri::command]
pub async fn recover_cloud_device_with_recovery_key(
    recovery_key: String,
    device_name: String,
    state: State<'_, CloudAccountService>,
    scheduler: State<'_, CloudSyncScheduler>,
) -> Result<CloudSyncDeviceActionResult, CloudPublicError> {
    let result = state
        .recover_with_recovery_key(&recovery_key, &device_name)
        .await?;
    scheduler.set_paused(false);
    Ok(result)
}

#[tauri::command]
pub async fn list_cloud_sync_local_dependencies(
    state: State<'_, CloudAccountService>,
    database: State<'_, DatabaseState>,
) -> Result<CloudLocalDependencyList, CloudPublicError> {
    state.local_dependencies(&database.pool).await
}

#[tauri::command]
pub async fn complete_cloud_sync_local_dependency(
    asset_id: String,
    dependency: LocalDependencyKind,
    path: String,
    state: State<'_, CloudAccountService>,
    database: State<'_, DatabaseState>,
) -> Result<CloudLocalDependencyList, CloudPublicError> {
    state
        .complete_local_dependency(&database.pool, &asset_id, dependency, &path)
        .await
}

#[tauri::command]
pub async fn list_cloud_sync_conflicts(
    state: State<'_, CloudAccountService>,
    database: State<'_, DatabaseState>,
) -> Result<Vec<CloudSyncConflictView>, CloudPublicError> {
    state.list_conflicts(&database.pool).await
}

#[tauri::command]
pub async fn resolve_cloud_sync_conflict(
    conflict_id: String,
    decision: CloudSyncConflictDecision,
    state: State<'_, CloudAccountService>,
    database: State<'_, DatabaseState>,
) -> Result<Vec<CloudSyncConflictView>, CloudPublicError> {
    state
        .resolve_conflict(&database.pool, &conflict_id, decision)
        .await
}

#[tauri::command]
pub async fn rotate_cloud_recovery_key(
    state: State<'_, CloudAccountService>,
) -> Result<RecoveryKeyRotationResult, CloudPublicError> {
    state.rotate_recovery_key().await
}

#[tauri::command]
pub fn copy_rotated_recovery_key(
    rotation_id: String,
    state: State<'_, CloudAccountService>,
) -> Result<(), CloudPublicError> {
    state.copy_rotated_recovery_key(&rotation_id)
}

#[tauri::command]
pub fn save_rotated_recovery_key<R: Runtime>(
    app: AppHandle<R>,
    rotation_id: String,
    state: State<'_, CloudAccountService>,
) -> Result<RecoveryKeyExportResult, CloudPublicError> {
    state.save_rotated_recovery_key(&app, &rotation_id)
}

#[tauri::command]
pub async fn delete_cloud_sync_data(
    state: State<'_, CloudAccountService>,
    scheduler: State<'_, CloudSyncScheduler>,
) -> Result<String, CloudPublicError> {
    let evaluated_at = state.delete_cloud_sync_data().await?;
    scheduler.shutdown();
    Ok(evaluated_at)
}

#[tauri::command]
pub fn copy_recovery_key(
    setup_id: String,
    state: State<'_, CloudAccountService>,
) -> Result<(), CloudPublicError> {
    state.copy_recovery_key(&setup_id)
}

#[tauri::command]
pub fn save_recovery_key<R: Runtime>(
    app: AppHandle<R>,
    setup_id: String,
    state: State<'_, CloudAccountService>,
) -> Result<RecoveryKeyExportResult, CloudPublicError> {
    state.save_recovery_key(&app, &setup_id)
}

#[tauri::command]
pub async fn finalize_sync_setup(
    setup_id: String,
    state: State<'_, CloudAccountService>,
    scheduler: State<'_, CloudSyncScheduler>,
) -> Result<CloudSyncStateProjection, CloudPublicError> {
    let result = state.finalize_sync_setup(&setup_id).await?;
    scheduler.set_paused(false);
    Ok(result)
}

#[tauri::command]
pub fn cancel_sync_setup(setup_id: String, state: State<'_, CloudAccountService>) {
    state.cancel_sync_setup(&setup_id);
}
