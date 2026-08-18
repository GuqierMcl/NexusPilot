import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
    BeginDeviceAuthorizationResult,
    BeginSyncSetupResult,
    CloudDeviceAuthorization,
    CloudDeviceAuthorizationClaimResult,
    CloudSyncDeviceActionResult,
    CloudLocalSyncState,
    CloudPendingDeviceAuthorizationList,
    PendingDeviceAuthorizationStatus,
    CloudAccountBootstrap,
    CloudSyncDevicesView,
    CloudSyncSetupContext,
    CloudSyncRunResult,
    CloudSyncRuntimeProjection,
    CloudLocalDependencyKind,
    CloudLocalDependencyList,
    CloudSyncConflictDecision,
    CloudSyncConflictView,
    RecoveryKeyRotationResult,
    CloudSyncStateProjection,
    RecoveryKeyExportResult,
    CloudDesktopStateProjection,
} from "@/types/ipc";

export const CLOUD_SYNC_RUNTIME_CHANGED_EVENT = "cloud-sync-runtime-changed";
export const CLOUD_DESKTOP_STATE_CHANGED_EVENT = "cloud-desktop-state-changed";

let cachedSyncSetupContext: CloudSyncSetupContext | null = null;
let syncSetupContextRequest: Promise<CloudSyncSetupContext> | null = null;
let cloudDesktopRefreshRequest: Promise<CloudDesktopStateProjection> | null = null;
let syncSetupContextGeneration = 0;
let syncSetupContextRefreshedAt = 0;
const AUTOMATIC_REFRESH_DEDUP_MS = 10_000;

/**
 * 触发 Rust-only Token Broker 与 Cloud API Client 完成账户 Bootstrap。
 * WebView 只能获得脱敏账户/权益投影，不能获得 Access Token 或原始 OIDC Claim。
 */
export function bootstrapCloudAccount(): Promise<CloudAccountBootstrap> {
    return invoke<CloudAccountBootstrap>("bootstrap_cloud_account");
}

export function peekSyncSetupContext(): CloudSyncSetupContext | null {
    return cachedSyncSetupContext;
}

/** Hydrate the display cache from Rust without waiting for a Cloud refresh. */
export function peekCachedSyncSetupContext(): Promise<CloudSyncSetupContext | null> {
    return invoke<CloudSyncSetupContext | null>("get_cached_sync_setup_context");
}

export function clearSyncSetupContextCache(): void {
    cachedSyncSetupContext = null;
    syncSetupContextGeneration += 1;
    syncSetupContextRequest = null;
    cloudDesktopRefreshRequest = null;
    syncSetupContextRefreshedAt = 0;
}

export function getSyncSetupContext(
    { force = true }: { force?: boolean } = {},
): Promise<CloudSyncSetupContext> {
    if (syncSetupContextRequest) return syncSetupContextRequest;
    if (
        !force &&
        cachedSyncSetupContext &&
        Date.now() - syncSetupContextRefreshedAt < AUTOMATIC_REFRESH_DEDUP_MS
    ) {
        return Promise.resolve(cachedSyncSetupContext);
    }

    const generation = ++syncSetupContextGeneration;
    syncSetupContextRequest = invoke<CloudSyncSetupContext>("get_sync_setup_context")
        .then((context) => {
            if (generation === syncSetupContextGeneration) {
                cachedSyncSetupContext = context;
                syncSetupContextRefreshedAt = Date.now();
            }
            return context;
        })
        .finally(() => {
            if (generation === syncSetupContextGeneration) {
                syncSetupContextRequest = null;
            }
        });
    return syncSetupContextRequest;
}

export function getCloudSyncStatus(): Promise<CloudSyncSetupContext> {
    return invoke<CloudSyncSetupContext>("get_cloud_sync_status");
}

/** 执行一次 Rust-only 的本地事实重算、上传/删除 flush 和 Cloud 增量拉取。 */
export function syncCloudNow(): Promise<CloudSyncRunResult> {
    return invoke<CloudSyncRunResult>("sync_cloud_now");
}

export function getCloudSyncRuntimeStatus(): Promise<CloudSyncRuntimeProjection> {
    return invoke<CloudSyncRuntimeProjection>("get_cloud_sync_runtime_status");
}

export function getCloudDesktopState(): Promise<CloudDesktopStateProjection> {
    return invoke<CloudDesktopStateProjection>("get_cloud_desktop_state");
}

export function refreshCloudDesktopState(): Promise<CloudDesktopStateProjection> {
    if (cloudDesktopRefreshRequest) return cloudDesktopRefreshRequest;
    cloudDesktopRefreshRequest = invoke<CloudDesktopStateProjection>(
        "refresh_cloud_desktop_state",
    ).finally(() => {
        cloudDesktopRefreshRequest = null;
    });
    return cloudDesktopRefreshRequest;
}

export function listenToCloudDesktopStateChanges(
    handler: (projection: CloudDesktopStateProjection) => void,
): Promise<UnlistenFn> {
    return listen<CloudDesktopStateProjection>(
        CLOUD_DESKTOP_STATE_CHANGED_EVENT,
        (event) => handler(event.payload),
    );
}

export function listenToCloudSyncRuntimeChanges(
    handler: (projection: CloudSyncRuntimeProjection) => void,
): Promise<UnlistenFn> {
    return listen<CloudSyncRuntimeProjection>(
        CLOUD_SYNC_RUNTIME_CHANGED_EVENT,
        (event) => handler(event.payload),
    );
}

export function listCloudDevices(): Promise<CloudSyncDevicesView> {
    return invoke<CloudSyncDevicesView>("list_cloud_devices");
}

export function beginSyncSetup(deviceName: string): Promise<BeginSyncSetupResult> {
    return invoke<BeginSyncSetupResult>("begin_sync_setup", { deviceName });
}

export function beginDeviceAuthorization(
    deviceName: string,
): Promise<BeginDeviceAuthorizationResult> {
    return invoke<BeginDeviceAuthorizationResult>("begin_device_authorization", {
        deviceName,
    });
}

export function listPendingDeviceAuthorizations(): Promise<CloudPendingDeviceAuthorizationList> {
    return invoke<CloudPendingDeviceAuthorizationList>(
        "list_pending_device_authorizations",
    );
}

export function getPendingDeviceAuthorization(): Promise<PendingDeviceAuthorizationStatus | null> {
    return invoke<PendingDeviceAuthorizationStatus | null>(
        "get_pending_device_authorization",
    );
}

export function approveDeviceAuthorization(
    requestId: string,
    verificationCode: string,
): Promise<CloudDeviceAuthorization> {
    return invoke<CloudDeviceAuthorization>("approve_device_authorization", {
        requestId,
        verificationCode,
    });
}

export function rejectDeviceAuthorization(
    requestId: string,
): Promise<CloudDeviceAuthorization> {
    return invoke<CloudDeviceAuthorization>("reject_device_authorization", {
        requestId,
    });
}

export function cancelDeviceAuthorization(
    requestId: string,
): Promise<CloudDeviceAuthorization> {
    return invoke<CloudDeviceAuthorization>("cancel_device_authorization", {
        requestId,
    });
}

export function claimDeviceAuthorization(): Promise<CloudDeviceAuthorizationClaimResult> {
    return invoke<CloudDeviceAuthorizationClaimResult>(
        "claim_device_authorization",
    );
}

export function setLocalSyncPaused(
    cloudAccountId: string,
    paused: boolean,
): Promise<CloudLocalSyncState> {
    return invoke<CloudLocalSyncState>("set_local_sync_paused", {
        cloudAccountId,
        paused,
    });
}

export function revokeLocalSyncDevice(): Promise<CloudSyncDeviceActionResult> {
    return invoke<CloudSyncDeviceActionResult>("revoke_local_sync_device");
}

export function recoverCloudDeviceWithRecoveryKey(
    recoveryKey: string,
    deviceName: string,
): Promise<CloudSyncDeviceActionResult> {
    return invoke<CloudSyncDeviceActionResult>(
        "recover_cloud_device_with_recovery_key",
        { recoveryKey, deviceName },
    );
}

export function listCloudSyncLocalDependencies(): Promise<CloudLocalDependencyList> {
    return invoke<CloudLocalDependencyList>("list_cloud_sync_local_dependencies");
}

export function completeCloudSyncLocalDependency(
    assetId: string,
    dependency: CloudLocalDependencyKind,
    path: string,
): Promise<CloudLocalDependencyList> {
    return invoke<CloudLocalDependencyList>("complete_cloud_sync_local_dependency", {
        assetId,
        dependency,
        path,
    });
}

export function listCloudSyncConflicts(): Promise<CloudSyncConflictView[]> {
    return invoke<CloudSyncConflictView[]>("list_cloud_sync_conflicts");
}

export function resolveCloudSyncConflict(
    conflictId: string,
    decision: CloudSyncConflictDecision,
): Promise<CloudSyncConflictView[]> {
    return invoke<CloudSyncConflictView[]>("resolve_cloud_sync_conflict", { conflictId, decision });
}

export function rotateCloudRecoveryKey(): Promise<RecoveryKeyRotationResult> {
    return invoke<RecoveryKeyRotationResult>("rotate_cloud_recovery_key");
}

export function copyRotatedRecoveryKey(rotationId: string): Promise<void> {
    return invoke<void>("copy_rotated_recovery_key", { rotationId });
}

export function saveRotatedRecoveryKey(rotationId: string): Promise<RecoveryKeyExportResult> {
    return invoke<RecoveryKeyExportResult>("save_rotated_recovery_key", { rotationId });
}

export function deleteCloudSyncData(): Promise<string> {
    return invoke<string>("delete_cloud_sync_data");
}

export function copyRecoveryKey(setupId: string): Promise<void> {
    return invoke<void>("copy_recovery_key", { setupId });
}

export function saveRecoveryKey(
    setupId: string,
): Promise<RecoveryKeyExportResult> {
    return invoke<RecoveryKeyExportResult>("save_recovery_key", { setupId });
}

export function finalizeSyncSetup(
    setupId: string,
): Promise<CloudSyncStateProjection> {
    return invoke<CloudSyncStateProjection>("finalize_sync_setup", { setupId });
}

export function cancelSyncSetup(setupId: string): Promise<void> {
    return invoke<void>("cancel_sync_setup", { setupId });
}
