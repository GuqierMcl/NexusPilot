use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CloudAccountStatus {
    Active,
    Suspended,
    Deleted,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAccountBootstrap {
    pub account: CloudAccountSummary,
    pub evaluated_at: String,
    pub subscription: CloudSubscriptionSummary,
    pub features: CloudFeatureSummary,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAccountEntitlements {
    pub evaluated_at: String,
    pub subscription: CloudSubscriptionSummary,
    pub features: CloudFeatureSummary,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAccountSummary {
    pub id: String,
    pub status: CloudAccountStatus,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSubscriptionSummary {
    /// 展示字段；Desktop 不得用套餐代码自行推导授权。
    pub plan_code: String,
    pub status: String,
    pub current_period_end: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudFeatureSummary {
    pub connection_sync: CloudConnectionSyncEntitlement,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudConnectionSyncEntitlement {
    /// 服务端状态机投影；实际能力始终以 permissions/limits 为准。
    pub phase: String,
    pub permissions: CloudConnectionSyncPermissions,
    pub limits: CloudConnectionSyncLimits,
    pub usage: CloudConnectionSyncUsage,
    pub effective_at: Option<String>,
    pub expires_at: Option<String>,
    pub phase_ends_at: Option<String>,
    pub deletion_eligible_at: Option<String>,
    pub entitlement_version: Option<u64>,
    pub policy_version: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudConnectionSyncPermissions {
    pub read_encrypted_assets: bool,
    pub write_encrypted_assets: bool,
    pub enroll_sync_device: bool,
    pub approve_device_authorization: bool,
    pub recover_existing_assets: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudConnectionSyncLimits {
    pub max_sync_devices: u64,
    pub max_encrypted_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudConnectionSyncUsage {
    pub active_sync_devices: u64,
    pub encrypted_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncStateProjection {
    pub evaluated_at: String,
    pub connection_sync: CloudConnectionSyncEntitlement,
    pub sync: CloudSyncState,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncState {
    pub initialized: bool,
    pub key_generation: Option<u64>,
    pub active_device_count: u64,
    pub initialized_at: Option<String>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PutCloudConnectionAssetRequest {
    pub operation_id: String,
    pub expected_revision: Option<String>,
    pub asset_type: String,
    pub schema_version: u16,
    pub key_generation: u64,
    pub encryption: CloudConnectionAssetEncryption,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteCloudConnectionAssetRequest {
    pub operation_id: String,
    pub expected_revision: String,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudConnectionAssetEncryption {
    pub suite: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudConnectionAssetMutationResponse {
    pub evaluated_at: String,
    pub operation: CloudConnectionAssetOperation,
    pub asset: CloudConnectionAssetProjection,
    pub usage: CloudConnectionAssetUsage,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudConnectionAssetOperation {
    pub id: String,
    pub applied_revision: String,
    pub applied_cursor: String,
    pub replayed: bool,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudConnectionAssetProjection {
    pub id: String,
    pub asset_type: String,
    pub revision: String,
    pub parent_revision: Option<String>,
    pub change_cursor: String,
    pub schema_version: u16,
    pub key_generation: u64,
    pub encryption: Option<CloudConnectionAssetEncryption>,
    pub encrypted_bytes: u64,
    pub tombstone: bool,
    pub updated_by_device_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudConnectionAssetUsage {
    pub encrypted_bytes: u64,
    pub max_encrypted_bytes: u64,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudConnectionAssetConflictResponse {
    pub error: CloudConnectionAssetConflictError,
    pub current: Option<CloudConnectionAssetProjection>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct CloudConnectionAssetConflictError {
    pub code: String,
    pub message: String,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudConnectionAssetListResponse {
    pub evaluated_at: String,
    pub cursor: CloudConnectionAssetCursor,
    pub items: Vec<CloudConnectionAssetChange>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudConnectionAssetCursor {
    pub requested: String,
    pub next: String,
    pub has_more: bool,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudConnectionAssetChange {
    pub change_cursor: String,
    pub asset: CloudConnectionAssetProjection,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalSyncStatus {
    Disabled,
    Paused,
    Ready,
    SecureStorageUnavailable,
    Corrupted,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSyncState {
    pub status: LocalSyncStatus,
    pub key_generation: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncDevice {
    pub id: String,
    pub display_name: String,
    pub status: String,
    pub key_generation: u64,
    pub registered_at: String,
    pub last_seen_at: Option<String>,
    pub revoked_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncDevicesProjection {
    pub evaluated_at: String,
    pub items: Vec<CloudSyncDevice>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDeviceAuthorizationResponse {
    pub evaluated_at: String,
    pub authorization: CloudDeviceAuthorization,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDeviceAuthorization {
    pub id: String,
    pub status: String,
    pub device: CloudDeviceAuthorizationDevice,
    pub binding: CloudDeviceAuthorizationBinding,
    pub created_at: String,
    pub expires_at: String,
    pub code_expires_at: String,
    pub approved_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDeviceAuthorizationDevice {
    pub id: String,
    pub display_name: String,
    pub key_generation: u64,
    pub encryption_public_key: String,
    pub signing_public_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDeviceAuthorizationBinding {
    pub pairing_nonce: String,
    pub code_version: u64,
    pub binding_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudDeviceAuthorizationListResponse {
    pub evaluated_at: String,
    pub items: Vec<CloudDeviceAuthorization>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceAuthorizationOperationRequest {
    pub operation_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudSyncDeviceResponse {
    pub evaluated_at: String,
    pub device: CloudSyncDevice,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApproveDeviceAuthorizationRequest {
    pub operation_id: String,
    pub expected_code_version: u64,
    pub binding_hash: String,
    pub verification_code: String,
    pub device_envelope: CloudDeviceKeyEnvelope,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaimDeviceAuthorizationResponse {
    pub evaluated_at: String,
    pub request_id: String,
    pub device_id: String,
    pub key_generation: u64,
    pub device_envelope: CloudDeviceKeyEnvelope,
    pub claimed_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudRecoveryEnvelopeResponse {
    pub evaluated_at: String,
    pub envelope: CloudRecoveryEnvelopeProjection,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudRecoveryEnvelopeProjection {
    pub key_generation: u64,
    pub revision: String,
    pub format_version: u8,
    pub suite: String,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegisterRecoveryDeviceRequest {
    pub operation_id: String,
    pub key_generation: u64,
    pub device: CreateCloudDeviceAuthorizationDevice,
    pub device_envelope: CloudDeviceKeyEnvelope,
    pub recovery_auth_signature: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateCloudDeviceAuthorizationRequest {
    pub request_id: String,
    pub key_generation: u64,
    pub device: CreateCloudDeviceAuthorizationDevice,
    pub pairing_nonce: String,
    pub verification_code_hash: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateCloudDeviceAuthorizationDevice {
    pub id: String,
    pub display_name: String,
    pub encryption_public_key: String,
    pub signing_public_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginDeviceAuthorizationResult {
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
    pub resumed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InitializeCloudSyncRequest {
    pub initialization_id: String,
    pub key_generation: u8,
    pub device: InitializeCloudSyncDevice,
    pub device_envelope: CloudDeviceKeyEnvelope,
    pub recovery_envelope: CloudRecoveryEnvelope,
    pub recovery_auth_public_key: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InitializeCloudSyncDevice {
    pub id: String,
    pub display_name: String,
    pub encryption_public_key: String,
    pub signing_public_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudDeviceKeyEnvelope {
    pub format_version: u8,
    pub suite: String,
    pub encapsulated_key: String,
    pub ciphertext: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudRecoveryEnvelope {
    pub format_version: u8,
    pub suite: &'static str,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReplaceRecoveryEnvelopeRequest {
    pub operation_id: String,
    pub expected_revision: String,
    pub key_generation: u64,
    pub envelope: CloudRecoveryEnvelope,
    pub recovery_auth_public_key: String,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReplaceRecoveryEnvelopeResponse {
    pub evaluated_at: String,
    pub operation: ReplaceRecoveryEnvelopeOperation,
    pub envelope: CloudRecoveryEnvelopeProjection,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReplaceRecoveryEnvelopeOperation {
    pub id: String,
    pub applied_revision: String,
    pub replayed: bool,
    pub superseded: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteSyncDataRequest {
    pub operation_id: String,
    pub confirmation: String,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteSyncDataResponse {
    pub evaluated_at: String,
    pub operation: DeleteSyncDataOperation,
    pub sync: DeleteSyncDataState,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteSyncDataOperation {
    pub id: String,
    pub replayed: bool,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteSyncDataState {
    pub initialized: bool,
}

#[cfg(test)]
mod tests {
    use super::CloudAccountBootstrap;

    const BOOTSTRAP_JSON: &str = r#"{
        "account":{"id":"0198f5dc-0000-7000-8000-000000000001","status":"active"},
        "evaluatedAt":"2026-08-05T12:00:00.000Z",
        "subscription":{"planCode":"free","status":"active","currentPeriodEnd":null},
        "features":{"connectionSync":{
            "phase":"not_entitled",
            "permissions":{"readEncryptedAssets":false,"writeEncryptedAssets":false,"enrollSyncDevice":false,"approveDeviceAuthorization":false,"recoverExistingAssets":false},
            "limits":{"maxSyncDevices":0,"maxEncryptedBytes":0},
            "usage":{"activeSyncDevices":0,"encryptedBytes":0},
            "effectiveAt":null,"expiresAt":null,"phaseEndsAt":null,"deletionEligibleAt":null,"entitlementVersion":null,"policyVersion":1
        }}
    }"#;

    #[test]
    fn bootstrap_contract_round_trips_without_identity_or_token_fields() {
        let projection: CloudAccountBootstrap =
            serde_json::from_str(BOOTSTRAP_JSON).expect("Cloud contract should deserialize");
        let serialized = serde_json::to_string(&projection).expect("projection should serialize");

        assert_eq!(projection.features.connection_sync.policy_version, 1);
        for forbidden in [
            "accessToken",
            "refreshToken",
            "authorization",
            "issuer",
            "subject",
            "scope",
            "claims",
        ] {
            assert!(!serialized.contains(forbidden));
        }
    }
}
