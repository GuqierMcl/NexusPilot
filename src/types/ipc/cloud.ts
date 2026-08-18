export type CloudAccountStatus = "active" | "suspended" | "deleted";
/** 展示字段；不能用于在 Desktop 本地推导授权。 */
export type CloudSubscriptionPlan = string;
export type CloudSubscriptionStatus = string;
/** 服务端状态机投影；实际能力始终以 permissions/limits 为准。 */
export type CloudConnectionSyncPhase = string;

export interface CloudAccountSummary {
    id: string;
    status: CloudAccountStatus;
}

export interface CloudSubscriptionSummary {
    planCode: CloudSubscriptionPlan;
    status: CloudSubscriptionStatus;
    currentPeriodEnd: string | null;
}

export interface CloudConnectionSyncPermissions {
    readEncryptedAssets: boolean;
    writeEncryptedAssets: boolean;
    enrollSyncDevice: boolean;
    approveDeviceAuthorization: boolean;
    recoverExistingAssets: boolean;
}

export interface CloudConnectionSyncLimits {
    maxSyncDevices: number;
    maxEncryptedBytes: number;
}

export interface CloudConnectionSyncUsage {
    activeSyncDevices: number;
    encryptedBytes: number;
}

export interface CloudConnectionSyncEntitlement {
    phase: CloudConnectionSyncPhase;
    permissions: CloudConnectionSyncPermissions;
    limits: CloudConnectionSyncLimits;
    usage: CloudConnectionSyncUsage;
    effectiveAt: string | null;
    expiresAt: string | null;
    phaseEndsAt: string | null;
    deletionEligibleAt: string | null;
    entitlementVersion: number | null;
    policyVersion: number;
}

export interface CloudAccountBootstrap {
    account: CloudAccountSummary;
    evaluatedAt: string;
    subscription: CloudSubscriptionSummary;
    features: {
        connectionSync: CloudConnectionSyncEntitlement;
    };
}

export interface CloudSyncState {
    initialized: boolean;
    keyGeneration: number | null;
    activeDeviceCount: number;
    initializedAt: string | null;
}

export type CloudLocalSyncStatus =
    | "disabled"
    | "paused"
    | "ready"
    | "secure_storage_unavailable"
    | "corrupted";

export interface CloudLocalSyncState {
    status: CloudLocalSyncStatus;
    keyGeneration: number | null;
}

export interface CloudSyncStateProjection {
    evaluatedAt: string;
    connectionSync: CloudConnectionSyncEntitlement;
    sync: CloudSyncState;
}

export interface CloudSyncDevice {
    id: string;
    displayName: string;
    status: "pending_activation" | "active" | "revoked";
    keyGeneration: number;
    registeredAt: string;
    lastSeenAt: string | null;
    revokedAt: string | null;
}

export type CloudProjectionSource = "cloud" | "cache";

export type CloudConnectionPhase =
    | "unauthenticated"
    | "needs_refresh"
    | "refreshing"
    | "connected"
    | "cached"
    | "offline"
    | "reauthentication_required"
    | "permission_denied"
    | "unavailable";

export interface CloudCapabilityProjection {
    /** Stable capability identifier; new Cloud capabilities add entries instead of new UI branches. */
    code: string;
    phase: string;
    available: boolean;
}

export interface CloudRefreshProjection {
    inFlight: boolean;
    lastStartedAt: string | null;
    lastCompletedAt: string | null;
    lastSucceededAt: string | null;
    lastError: CloudPublicError | null;
}

export interface CloudDesktopStateProjection {
    connection: CloudConnectionPhase;
    context: CloudSyncSetupContext | null;
    capabilities: CloudCapabilityProjection[];
    runtime: CloudSyncRuntimeProjection;
    refresh: CloudRefreshProjection;
}

export interface CloudSyncDevicesView {
    evaluatedAt: string;
    items: CloudSyncDevice[] | null;
    source: CloudProjectionSource;
    cachedAt: string | null;
}

export interface CloudSyncRunResult {
    uploaded: number;
    deleted: number;
    pulled: number;
    conflicted: number;
    ignored: number;
    cursor: number;
}

export type CloudSyncRuntimePhase =
    | "disabled"
    | "idle"
    | "syncing"
    | "paused"
    | "offline"
    | "read_only"
    | "quota_exceeded"
    | "conflicted"
    | "device_revoked"
    | "recovery_required"
    | "unavailable";

export type CloudSyncTrigger =
    | "startup"
    | "authentication"
    | "foreground"
    | "local_change"
    | "retry"
    | "manual"
    | "resume";

export interface CloudSyncRuntimeProjection {
    phase: CloudSyncRuntimePhase;
    trigger: CloudSyncTrigger | null;
    lastStartedAt: string | null;
    lastCompletedAt: string | null;
    lastSucceededAt: string | null;
    nextRetryAt: string | null;
    retryAttempt: number;
    pendingOperations: number;
    conflicts: number;
    lastResult: CloudSyncRunResult | null;
    lastErrorCode: CloudErrorCode | null;
}

export interface CloudSyncSetupContext {
    evaluatedAt: string;
    account: CloudAccountSummary;
    subscription: CloudSubscriptionSummary;
    connectionSync: CloudConnectionSyncEntitlement;
    sync: CloudSyncState;
    localSync: CloudLocalSyncState;
    devices: CloudSyncDevice[] | null;
    suggestedDeviceName: string;
    source: CloudProjectionSource;
    cachedAt: string | null;
}

export interface BeginSyncSetupResult {
    setupId: string;
    /** 只在 begin IPC 的成功响应中出现；调用方必须仅保存在当前 Dialog 状态。 */
    recoveryKey: string;
}

export interface BeginDeviceAuthorizationResult {
    evaluatedAt: string;
    requestId: string;
    deviceId: string;
    deviceName: string;
    status: string;
    verificationCode: string;
    codeVersion: number;
    createdAt: string;
    expiresAt: string;
    codeExpiresAt: string;
    resumed: boolean;
}

export interface PendingDeviceAuthorizationStatus {
    evaluatedAt: string;
    requestId: string;
    deviceId: string;
    deviceName: string;
    status: "pending" | "approved" | "rejected" | "expired" | "canceled";
    verificationCode: string;
    codeVersion: number;
    createdAt: string;
    expiresAt: string;
    codeExpiresAt: string;
}

export interface CloudDeviceAuthorization {
    id: string;
    status: "pending" | "approved" | "rejected" | "expired" | "canceled";
    device: {
        id: string;
        displayName: string;
        keyGeneration: number;
        encryptionPublicKey: string;
        signingPublicKey: string;
    };
    binding: {
        pairingNonce: string;
        codeVersion: number;
        bindingHash: string;
    };
    createdAt: string;
    expiresAt: string;
    codeExpiresAt: string;
    approvedAt: string | null;
}

export interface CloudPendingDeviceAuthorizationList {
    evaluatedAt: string;
    items: CloudDeviceAuthorization[];
}

export interface CloudDeviceAuthorizationClaimResult {
    evaluatedAt: string;
    requestId: string;
    deviceId: string;
    keyGeneration: number;
    claimedAt: string;
}

export interface CloudSyncDeviceActionResult {
    evaluatedAt: string;
    device: CloudSyncDevice;
}

export type CloudLocalDependencyKind = "database_file" | "ssh_private_key";

export interface CloudLocalDependency {
    assetId: string;
    assetName: string;
    dependency: CloudLocalDependencyKind;
    currentPath: string | null;
}

export interface CloudLocalDependencyList {
    cloudAccountId: string;
    items: CloudLocalDependency[];
}

export type CloudSyncConflictDecision = "keep_local" | "keep_cloud" | "keep_both";

export interface CloudSyncConflictView {
    id: string;
    assetId: string;
    assetType: "connection" | "connection_folder" | string;
    localAction: "put" | "delete" | string;
    remoteTombstone: boolean;
    localRevision: number | null;
    remoteRevision: number;
    localName: string | null;
    remoteName: string | null;
    localPayloadHash: string;
    remotePayloadHash: string;
    detectedAt: number;
}

export interface RecoveryKeyExportResult {
    completed: boolean;
}

export interface RecoveryKeyRotationResult {
    rotationId: string;
    recoveryKey: string;
    evaluatedAt: string;
}

export type CloudErrorCode =
    | "CLOUD_UNAUTHENTICATED"
    | "CLOUD_REAUTHENTICATION_REQUIRED"
    | "CLOUD_AUTH_TEMPORARILY_UNAVAILABLE"
    | "CLOUD_INSUFFICIENT_SCOPE"
    | "CLOUD_TEMPORARILY_UNAVAILABLE"
    | "CLOUD_PROTOCOL_ERROR"
    | "CLOUD_ACCOUNT_NOT_INITIALIZED"
    | "CLOUD_CONNECTION_SYNC_NOT_ENTITLED"
    | "CLOUD_CONNECTION_SYNC_RESTRICTED"
    | "CLOUD_ACCOUNT_UNAVAILABLE"
    | "CLOUD_SYNC_DEVICE_LIMIT_EXCEEDED"
    | "CLOUD_SYNC_DEVICE_ALREADY_CONFIGURED"
    | "CLOUD_SYNC_NOT_INITIALIZED"
    | "CLOUD_DEVICE_AUTHORIZATION_CONFLICT"
    | "CLOUD_DEVICE_AUTHORIZATION_INVALID"
    | "CLOUD_DEVICE_AUTHORIZATION_PENDING_LIMIT_EXCEEDED"
    | "CLOUD_DEVICE_AUTHORIZATION_NOT_FOUND"
    | "CLOUD_DEVICE_AUTHORIZATION_NOT_PENDING"
    | "CLOUD_SYNC_ALREADY_INITIALIZED"
    | "CLOUD_SYNC_INITIALIZATION_MISMATCH"
    | "CLOUD_SYNC_DEVICE_NOT_AUTHORIZED"
    | "CLOUD_SYNC_SETUP_INVALID"
    | "CLOUD_SYNC_SETUP_EXPIRED"
    | "CLOUD_SECURE_STORAGE_UNAVAILABLE"
    | "CLOUD_RECOVERY_KEY_EXPORT_FAILED"
    | "CLOUD_RECOVERY_KEY_INVALID"
    | "CLOUD_CONNECTION_SYNC_CONFLICT"
    | "CLOUD_CONNECTION_SYNC_QUOTA_EXCEEDED"
    | "CLOUD_CONNECTION_SYNC_ASSET_TOO_LARGE";

export interface CloudPublicError {
    code: CloudErrorCode;
    message: string;
    retryable: boolean;
    occurredAt: string;
}
