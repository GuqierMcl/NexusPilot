use std::net::IpAddr;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::{header, redirect::Policy, StatusCode};
use serde::{Deserialize, Serialize};
use url::{Host, Url};

use crate::auth::SecretString;

use super::{
    device_proof::{build_device_proof, build_device_proof_with_signing_key, DeviceProofHeaders},
    sync_key_store::CommittedSyncKeyBundle,
    types::{
        ApproveDeviceAuthorizationRequest, ClaimDeviceAuthorizationResponse, CloudAccountBootstrap,
        CloudAccountEntitlements, CloudConnectionAssetConflictResponse,
        CloudConnectionAssetListResponse, CloudConnectionAssetMutationResponse,
        CloudDeviceAuthorizationListResponse, CloudDeviceAuthorizationResponse,
        CloudRecoveryEnvelopeResponse, CloudSyncDeviceResponse, CloudSyncDevicesProjection,
        CloudSyncStateProjection, CreateCloudDeviceAuthorizationRequest,
        DeleteCloudConnectionAssetRequest, DeleteSyncDataRequest, DeleteSyncDataResponse,
        DeviceAuthorizationOperationRequest, InitializeCloudSyncRequest,
        PutCloudConnectionAssetRequest, RegisterRecoveryDeviceRequest,
        ReplaceRecoveryEnvelopeRequest, ReplaceRecoveryEnvelopeResponse,
    },
};

const PRODUCTION_CLOUD_API_BASE_URL: &str = "https://api.nexuspilot.dev/v1/";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(7);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_BASE_URL_BYTES: usize = 2_048;

#[derive(Clone)]
pub(crate) struct CloudApiClient {
    base_url: Url,
    http: reqwest::Client,
    max_response_bytes: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CloudClientError {
    InvalidConfiguration,
    Unauthorized,
    InsufficientScope,
    TemporarilyUnavailable,
    ResponseTooLarge,
    InvalidResponse,
    AccountNotInitialized,
    ConnectionSyncNotEntitled,
    ConnectionSyncLifecycleRestricted,
    AccountUnavailable,
    SyncDeviceLimitExceeded,
    SyncAlreadyInitialized,
    SyncInitializationMismatch,
    SyncDeviceIdConflict,
    InvalidSyncRequest,
    SyncDeviceNotAuthorized,
    DeviceProofUnavailable,
    SyncNotInitialized,
    DeviceAuthorizationRequestMismatch,
    PendingDeviceAuthorizationLimitExceeded,
    DeviceAuthorizationNotFound,
    DeviceAuthorizationNotPending,
    ConnectionAssetOperationMismatch,
    ConnectionAssetTypeMismatch,
    ConnectionAssetCursorInvalid,
    EncryptedByteLimitExceeded,
    ConnectionAssetTooLarge,
    SyncKeyGenerationMismatch,
}

impl CloudClientError {
    /// A transport failure, oversized response, or invalid success/error envelope can occur after
    /// Cloud has committed the atomic initialization. Preserve the staged local key material for
    /// an idempotent retry with the same initialization ID in those cases.
    pub(crate) fn sync_initialization_outcome_unknown(self) -> bool {
        matches!(
            self,
            Self::TemporarilyUnavailable | Self::ResponseTooLarge | Self::InvalidResponse
        )
    }

    pub(crate) fn sync_operation_outcome_unknown(self) -> bool {
        matches!(
            self,
            Self::TemporarilyUnavailable | Self::ResponseTooLarge | Self::InvalidResponse
        )
    }

    pub(crate) fn device_authorization_create_definitely_rejected(self) -> bool {
        matches!(
            self,
            Self::ConnectionSyncNotEntitled
                | Self::ConnectionSyncLifecycleRestricted
                | Self::AccountUnavailable
                | Self::SyncDeviceLimitExceeded
                | Self::SyncNotInitialized
                | Self::InvalidSyncRequest
                | Self::SyncDeviceIdConflict
                | Self::DeviceAuthorizationRequestMismatch
        )
    }
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) enum CloudAssetPutError {
    Client(CloudClientError),
    Conflict(CloudConnectionAssetConflictResponse),
}

#[derive(Deserialize)]
struct CloudErrorEnvelope {
    error: CloudErrorBody,
}

#[derive(Deserialize)]
struct CloudErrorBody {
    code: String,
}

impl CloudApiClient {
    pub(crate) fn from_embedded() -> Result<Self, CloudClientError> {
        let source = embedded_cloud_api_base_url();
        Self::build(
            source,
            cfg!(debug_assertions),
            CONNECT_TIMEOUT,
            TOTAL_TIMEOUT,
            MAX_RESPONSE_BYTES,
        )
    }

    pub(crate) async fn bootstrap_account(
        &self,
        access_token: &SecretString,
    ) -> Result<CloudAccountBootstrap, CloudClientError> {
        let endpoint = self
            .base_url
            .join("account/bootstrap")
            .map_err(|_| CloudClientError::InvalidConfiguration)?;
        let response = self
            .http
            .post(endpoint)
            .header(header::ACCEPT, "application/json")
            .bearer_auth(access_token.expose())
            .send()
            .await
            .map_err(|_| CloudClientError::TemporarilyUnavailable)?;

        let status = response.status();
        let content_type_is_json = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(is_json_content_type);
        let body = read_bounded_body(response, self.max_response_bytes).await?;

        if status == StatusCode::OK {
            if !content_type_is_json || body.is_empty() {
                return Err(CloudClientError::InvalidResponse);
            }
            return serde_json::from_slice(&body).map_err(|_| CloudClientError::InvalidResponse);
        }

        let error_code = serde_json::from_slice::<CloudErrorEnvelope>(&body)
            .ok()
            .map(|envelope| envelope.error.code);
        match status {
            StatusCode::UNAUTHORIZED
                if matches!(
                    error_code.as_deref(),
                    Some("authentication_required" | "invalid_access_token")
                ) =>
            {
                Err(CloudClientError::Unauthorized)
            }
            StatusCode::FORBIDDEN if error_code.as_deref() == Some("insufficient_scope") => {
                Err(CloudClientError::InsufficientScope)
            }
            StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE => {
                Err(CloudClientError::TemporarilyUnavailable)
            }
            status if status.is_server_error() => Err(CloudClientError::TemporarilyUnavailable),
            _ => Err(CloudClientError::InvalidResponse),
        }
    }

    pub(crate) async fn sync_state(
        &self,
        access_token: &SecretString,
    ) -> Result<CloudSyncStateProjection, CloudClientError> {
        self.send_json::<(), CloudSyncStateProjection>(
            reqwest::Method::GET,
            "sync/state",
            access_token,
            None,
            None,
        )
        .await
    }

    pub(crate) async fn account_entitlements(
        &self,
        access_token: &SecretString,
    ) -> Result<CloudAccountEntitlements, CloudClientError> {
        self.send_json::<(), CloudAccountEntitlements>(
            reqwest::Method::GET,
            "account/entitlements",
            access_token,
            None,
            None,
        )
        .await
    }

    pub(crate) async fn sync_devices(
        &self,
        access_token: &SecretString,
        account_id: &str,
        keys: &CommittedSyncKeyBundle,
    ) -> Result<CloudSyncDevicesProjection, CloudClientError> {
        let proof = super::device_proof::build_device_proof(
            "GET /v1/sync/devices",
            account_id,
            keys,
            &serde_json::json!({}),
        )
        .map_err(|_| CloudClientError::DeviceProofUnavailable)?;
        self.send_json::<(), CloudSyncDevicesProjection>(
            reqwest::Method::GET,
            "sync/devices",
            access_token,
            None,
            Some(&proof),
        )
        .await
    }

    pub(crate) async fn initialize_sync(
        &self,
        access_token: &SecretString,
        request: &InitializeCloudSyncRequest,
    ) -> Result<CloudSyncStateProjection, CloudClientError> {
        self.send_json(
            reqwest::Method::POST,
            "sync/initialize",
            access_token,
            Some(request),
            None,
        )
        .await
    }

    pub(crate) async fn recovery_envelope(
        &self,
        access_token: &SecretString,
    ) -> Result<CloudRecoveryEnvelopeResponse, CloudClientError> {
        self.send_json::<(), CloudRecoveryEnvelopeResponse>(
            reqwest::Method::GET,
            "sync/recovery-envelope",
            access_token,
            None,
            None,
        )
        .await
    }

    pub(crate) async fn replace_recovery_envelope(
        &self,
        access_token: &SecretString,
        account_id: &str,
        request: &ReplaceRecoveryEnvelopeRequest,
        keys: &CommittedSyncKeyBundle,
    ) -> Result<ReplaceRecoveryEnvelopeResponse, CloudClientError> {
        let payload =
            serde_json::to_value(request).map_err(|_| CloudClientError::InvalidResponse)?;
        let proof =
            build_device_proof("PUT /v1/sync/recovery-envelope", account_id, keys, &payload)
                .map_err(|_| CloudClientError::DeviceProofUnavailable)?;
        self.send_json(
            reqwest::Method::PUT,
            "sync/recovery-envelope",
            access_token,
            Some(request),
            Some(&proof),
        )
        .await
    }

    pub(crate) async fn delete_sync_data(
        &self,
        access_token: &SecretString,
        account_id: &str,
        request: &DeleteSyncDataRequest,
        keys: &CommittedSyncKeyBundle,
    ) -> Result<DeleteSyncDataResponse, CloudClientError> {
        let payload =
            serde_json::to_value(request).map_err(|_| CloudClientError::InvalidResponse)?;
        let proof = build_device_proof("DELETE /v1/sync/data", account_id, keys, &payload)
            .map_err(|_| CloudClientError::DeviceProofUnavailable)?;
        self.send_json(
            reqwest::Method::DELETE,
            "sync/data",
            access_token,
            Some(request),
            Some(&proof),
        )
        .await
    }

    pub(crate) async fn register_recovery_device(
        &self,
        access_token: &SecretString,
        request: &RegisterRecoveryDeviceRequest,
    ) -> Result<CloudSyncDeviceResponse, CloudClientError> {
        self.send_json(
            reqwest::Method::POST,
            "sync/recovery-devices",
            access_token,
            Some(request),
            None,
        )
        .await
    }

    pub(crate) async fn create_device_authorization(
        &self,
        access_token: &SecretString,
        account_id: &str,
        request: &CreateCloudDeviceAuthorizationRequest,
        signing_private_key: &[u8; 32],
    ) -> Result<CloudDeviceAuthorizationResponse, CloudClientError> {
        let payload =
            serde_json::to_value(request).map_err(|_| CloudClientError::InvalidResponse)?;
        let proof = build_device_proof_with_signing_key(
            "POST /v1/sync/device-authorizations",
            account_id,
            &request.device.id,
            signing_private_key,
            &payload,
        )
        .map_err(|_| CloudClientError::DeviceProofUnavailable)?;
        self.send_json(
            reqwest::Method::POST,
            "sync/device-authorizations",
            access_token,
            Some(request),
            Some(&proof),
        )
        .await
    }

    pub(crate) async fn list_pending_device_authorizations(
        &self,
        access_token: &SecretString,
        account_id: &str,
        keys: &CommittedSyncKeyBundle,
    ) -> Result<CloudDeviceAuthorizationListResponse, CloudClientError> {
        let proof = build_device_proof(
            "GET /v1/sync/device-authorizations",
            account_id,
            keys,
            &serde_json::json!({}),
        )
        .map_err(|_| CloudClientError::DeviceProofUnavailable)?;
        self.send_json(
            reqwest::Method::GET,
            "sync/device-authorizations?status=pending",
            access_token,
            None::<&()>,
            Some(&proof),
        )
        .await
    }

    pub(crate) async fn get_device_authorization(
        &self,
        access_token: &SecretString,
        account_id: &str,
        request_id: &str,
        keys: &CommittedSyncKeyBundle,
    ) -> Result<CloudDeviceAuthorizationResponse, CloudClientError> {
        let path = format!("sync/device-authorizations/{request_id}");
        let proof = build_device_proof(
            &format!("GET /v1/sync/device-authorizations/{request_id}"),
            account_id,
            keys,
            &serde_json::json!({}),
        )
        .map_err(|_| CloudClientError::DeviceProofUnavailable)?;
        self.send_json(
            reqwest::Method::GET,
            &path,
            access_token,
            None::<&()>,
            Some(&proof),
        )
        .await
    }

    pub(crate) async fn get_pending_device_authorization(
        &self,
        access_token: &SecretString,
        account_id: &str,
        request_id: &str,
        device_id: &str,
        signing_private_key: &[u8; 32],
    ) -> Result<CloudDeviceAuthorizationResponse, CloudClientError> {
        let path = format!("sync/device-authorizations/{request_id}");
        let proof = build_device_proof_with_signing_key(
            &format!("GET /v1/sync/device-authorizations/{request_id}"),
            account_id,
            device_id,
            signing_private_key,
            &serde_json::json!({}),
        )
        .map_err(|_| CloudClientError::DeviceProofUnavailable)?;
        self.send_json(
            reqwest::Method::GET,
            &path,
            access_token,
            None::<&()>,
            Some(&proof),
        )
        .await
    }

    pub(crate) async fn operate_device_authorization(
        &self,
        access_token: &SecretString,
        account_id: &str,
        request_id: &str,
        action: &str,
        input: &DeviceAuthorizationOperationRequest,
        keys: &CommittedSyncKeyBundle,
    ) -> Result<CloudDeviceAuthorizationResponse, CloudClientError> {
        let path = format!("sync/device-authorizations/{request_id}/{action}");
        let operation_path = format!("POST /v1/sync/device-authorizations/{request_id}/{action}");
        let payload = serde_json::to_value(input).map_err(|_| CloudClientError::InvalidResponse)?;
        let proof = build_device_proof(&operation_path, account_id, keys, &payload)
            .map_err(|_| CloudClientError::DeviceProofUnavailable)?;
        self.send_json(
            reqwest::Method::POST,
            &path,
            access_token,
            Some(input),
            Some(&proof),
        )
        .await
    }

    pub(crate) async fn approve_device_authorization(
        &self,
        access_token: &SecretString,
        account_id: &str,
        request_id: &str,
        input: &ApproveDeviceAuthorizationRequest,
        keys: &CommittedSyncKeyBundle,
    ) -> Result<CloudDeviceAuthorizationResponse, CloudClientError> {
        let path = format!("sync/device-authorizations/{request_id}/approve");
        let operation_path = format!("POST /v1/sync/device-authorizations/{request_id}/approve");
        let payload = serde_json::to_value(input).map_err(|_| CloudClientError::InvalidResponse)?;
        let proof = build_device_proof(&operation_path, account_id, keys, &payload)
            .map_err(|_| CloudClientError::DeviceProofUnavailable)?;
        self.send_json(
            reqwest::Method::POST,
            &path,
            access_token,
            Some(input),
            Some(&proof),
        )
        .await
    }

    pub(crate) async fn claim_device_authorization(
        &self,
        access_token: &SecretString,
        account_id: &str,
        request_id: &str,
        input: &DeviceAuthorizationOperationRequest,
        device_id: &str,
        signing_private_key: &[u8; 32],
    ) -> Result<ClaimDeviceAuthorizationResponse, CloudClientError> {
        let path = format!("sync/device-authorizations/{request_id}/envelope/claim");
        let operation_path =
            format!("POST /v1/sync/device-authorizations/{request_id}/envelope/claim");
        let payload = serde_json::to_value(input).map_err(|_| CloudClientError::InvalidResponse)?;
        let proof = build_device_proof_with_signing_key(
            &operation_path,
            account_id,
            device_id,
            signing_private_key,
            &payload,
        )
        .map_err(|_| CloudClientError::DeviceProofUnavailable)?;
        self.send_json(
            reqwest::Method::POST,
            &path,
            access_token,
            Some(input),
            Some(&proof),
        )
        .await
    }

    pub(crate) async fn cancel_device_authorization(
        &self,
        access_token: &SecretString,
        account_id: &str,
        request_id: &str,
        input: &DeviceAuthorizationOperationRequest,
        device_id: &str,
        signing_private_key: &[u8; 32],
    ) -> Result<CloudDeviceAuthorizationResponse, CloudClientError> {
        let path = format!("sync/device-authorizations/{request_id}/cancel");
        let operation_path = format!("POST /v1/sync/device-authorizations/{request_id}/cancel");
        let payload = serde_json::to_value(input).map_err(|_| CloudClientError::InvalidResponse)?;
        let proof = build_device_proof_with_signing_key(
            &operation_path,
            account_id,
            device_id,
            signing_private_key,
            &payload,
        )
        .map_err(|_| CloudClientError::DeviceProofUnavailable)?;
        self.send_json(
            reqwest::Method::POST,
            &path,
            access_token,
            Some(input),
            Some(&proof),
        )
        .await
    }

    pub(crate) async fn revoke_sync_device(
        &self,
        access_token: &SecretString,
        account_id: &str,
        device_id: &str,
        input: &DeviceAuthorizationOperationRequest,
        keys: &CommittedSyncKeyBundle,
    ) -> Result<CloudSyncDeviceResponse, CloudClientError> {
        let path = format!("sync/devices/{device_id}/revoke");
        let operation_path = format!("POST /v1/sync/devices/{device_id}/revoke");
        let payload = serde_json::to_value(input).map_err(|_| CloudClientError::InvalidResponse)?;
        let proof = build_device_proof(&operation_path, account_id, keys, &payload)
            .map_err(|_| CloudClientError::DeviceProofUnavailable)?;
        self.send_json(
            reqwest::Method::POST,
            &path,
            access_token,
            Some(input),
            Some(&proof),
        )
        .await
    }

    #[allow(dead_code)]
    pub(crate) async fn put_connection_asset(
        &self,
        access_token: &SecretString,
        account_id: &str,
        asset_id: &str,
        request: &PutCloudConnectionAssetRequest,
        keys: &CommittedSyncKeyBundle,
    ) -> Result<CloudConnectionAssetMutationResponse, CloudAssetPutError> {
        let payload = serde_json::to_value(request)
            .map_err(|_| CloudAssetPutError::Client(CloudClientError::InvalidResponse))?;
        let path = format!("sync/connection-assets/{asset_id}");
        let proof = build_device_proof(
            &format!("PUT /v1/sync/connection-assets/{asset_id}"),
            account_id,
            keys,
            &payload,
        )
        .map_err(|_| CloudAssetPutError::Client(CloudClientError::DeviceProofUnavailable))?;
        let endpoint = self
            .base_url
            .join(&path)
            .map_err(|_| CloudAssetPutError::Client(CloudClientError::InvalidConfiguration))?;
        let encoded = serde_json::to_vec(request)
            .map_err(|_| CloudAssetPutError::Client(CloudClientError::InvalidResponse))?;
        let response = self
            .http
            .put(endpoint)
            .header(header::ACCEPT, "application/json")
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-nexuspilot-device-id", &proof.device_id)
            .header("x-nexuspilot-device-timestamp", &proof.timestamp)
            .header("x-nexuspilot-device-nonce", &proof.nonce)
            .header("x-nexuspilot-device-signature", &proof.signature)
            .bearer_auth(access_token.expose())
            .body(encoded)
            .send()
            .await
            .map_err(|_| CloudAssetPutError::Client(CloudClientError::TemporarilyUnavailable))?;
        let status = response.status();
        let content_type_is_json = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(is_json_content_type);
        let body = read_bounded_body(response, self.max_response_bytes)
            .await
            .map_err(CloudAssetPutError::Client)?;
        if status == StatusCode::OK {
            if !content_type_is_json || body.is_empty() {
                return Err(CloudAssetPutError::Client(
                    CloudClientError::InvalidResponse,
                ));
            }
            return serde_json::from_slice(&body)
                .map_err(|_| CloudAssetPutError::Client(CloudClientError::InvalidResponse));
        }
        if status == StatusCode::CONFLICT {
            if let Ok(conflict) =
                serde_json::from_slice::<CloudConnectionAssetConflictResponse>(&body)
            {
                if conflict.error.code == "connection_asset_revision_conflict" {
                    return Err(CloudAssetPutError::Conflict(conflict));
                }
            }
        }
        let code = serde_json::from_slice::<CloudErrorEnvelope>(&body)
            .ok()
            .map(|envelope| envelope.error.code);
        Err(CloudAssetPutError::Client(map_error_response(
            status,
            code.as_deref(),
        )))
    }

    #[allow(dead_code)]
    pub(crate) async fn delete_connection_asset(
        &self,
        access_token: &SecretString,
        account_id: &str,
        asset_id: &str,
        request: &DeleteCloudConnectionAssetRequest,
        keys: &CommittedSyncKeyBundle,
    ) -> Result<CloudConnectionAssetMutationResponse, CloudAssetPutError> {
        let payload = serde_json::to_value(request)
            .map_err(|_| CloudAssetPutError::Client(CloudClientError::InvalidResponse))?;
        let path = format!("sync/connection-assets/{asset_id}");
        let proof = build_device_proof(
            &format!("DELETE /v1/sync/connection-assets/{asset_id}"),
            account_id,
            keys,
            &payload,
        )
        .map_err(|_| CloudAssetPutError::Client(CloudClientError::DeviceProofUnavailable))?;
        let endpoint = self
            .base_url
            .join(&path)
            .map_err(|_| CloudAssetPutError::Client(CloudClientError::InvalidConfiguration))?;
        let encoded = serde_json::to_vec(request)
            .map_err(|_| CloudAssetPutError::Client(CloudClientError::InvalidResponse))?;
        let response = self
            .http
            .delete(endpoint)
            .header(header::ACCEPT, "application/json")
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-nexuspilot-device-id", &proof.device_id)
            .header("x-nexuspilot-device-timestamp", &proof.timestamp)
            .header("x-nexuspilot-device-nonce", &proof.nonce)
            .header("x-nexuspilot-device-signature", &proof.signature)
            .bearer_auth(access_token.expose())
            .body(encoded)
            .send()
            .await
            .map_err(|_| CloudAssetPutError::Client(CloudClientError::TemporarilyUnavailable))?;
        let status = response.status();
        let content_type_is_json = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(is_json_content_type);
        let body = read_bounded_body(response, self.max_response_bytes)
            .await
            .map_err(CloudAssetPutError::Client)?;
        if status == StatusCode::OK {
            if !content_type_is_json || body.is_empty() {
                return Err(CloudAssetPutError::Client(
                    CloudClientError::InvalidResponse,
                ));
            }
            return serde_json::from_slice(&body)
                .map_err(|_| CloudAssetPutError::Client(CloudClientError::InvalidResponse));
        }
        if status == StatusCode::CONFLICT {
            if let Ok(conflict) =
                serde_json::from_slice::<CloudConnectionAssetConflictResponse>(&body)
            {
                if conflict.error.code == "connection_asset_revision_conflict" {
                    return Err(CloudAssetPutError::Conflict(conflict));
                }
            }
        }
        let code = serde_json::from_slice::<CloudErrorEnvelope>(&body)
            .ok()
            .map(|envelope| envelope.error.code);
        Err(CloudAssetPutError::Client(map_error_response(
            status,
            code.as_deref(),
        )))
    }

    pub(crate) async fn list_connection_assets(
        &self,
        access_token: &SecretString,
        account_id: &str,
        cursor: u64,
        limit: u16,
        keys: &CommittedSyncKeyBundle,
    ) -> Result<CloudConnectionAssetListResponse, CloudClientError> {
        if limit == 0 || limit > 500 {
            return Err(CloudClientError::InvalidResponse);
        }
        let payload = serde_json::json!({
            "cursor": cursor.to_string(),
            "limit": u64::from(limit),
        });
        let proof =
            build_device_proof("GET /v1/sync/connection-assets", account_id, keys, &payload)
                .map_err(|_| CloudClientError::DeviceProofUnavailable)?;
        self.send_json(
            reqwest::Method::GET,
            &format!("sync/connection-assets?cursor={cursor}&limit={limit}"),
            access_token,
            None::<&()>,
            Some(&proof),
        )
        .await
    }

    async fn send_json<B: Serialize + ?Sized, T: for<'de> Deserialize<'de>>(
        &self,
        method: reqwest::Method,
        path: &str,
        access_token: &SecretString,
        body: Option<&B>,
        proof: Option<&DeviceProofHeaders>,
    ) -> Result<T, CloudClientError> {
        let endpoint = self
            .base_url
            .join(path)
            .map_err(|_| CloudClientError::InvalidConfiguration)?;
        let mut request = self
            .http
            .request(method, endpoint)
            .header(header::ACCEPT, "application/json")
            .bearer_auth(access_token.expose());
        if let Some(proof) = proof {
            request = request
                .header("x-nexuspilot-device-id", &proof.device_id)
                .header("x-nexuspilot-device-timestamp", &proof.timestamp)
                .header("x-nexuspilot-device-nonce", &proof.nonce)
                .header("x-nexuspilot-device-signature", &proof.signature);
        }
        if let Some(body) = body {
            let encoded =
                serde_json::to_vec(body).map_err(|_| CloudClientError::InvalidResponse)?;
            request = request
                .header(header::CONTENT_TYPE, "application/json")
                .body(encoded);
        }
        let response = request
            .send()
            .await
            .map_err(|_| CloudClientError::TemporarilyUnavailable)?;
        let status = response.status();
        let content_type_is_json = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(is_json_content_type);
        let bytes = read_bounded_body(response, self.max_response_bytes).await?;
        if status == StatusCode::OK {
            if !content_type_is_json || bytes.is_empty() {
                return Err(CloudClientError::InvalidResponse);
            }
            return serde_json::from_slice(&bytes).map_err(|_| CloudClientError::InvalidResponse);
        }
        let code = serde_json::from_slice::<CloudErrorEnvelope>(&bytes)
            .ok()
            .map(|envelope| envelope.error.code);
        Err(map_error_response(status, code.as_deref()))
    }

    fn build(
        source: &str,
        allow_debug_loopback_http: bool,
        connect_timeout: Duration,
        total_timeout: Duration,
        max_response_bytes: usize,
    ) -> Result<Self, CloudClientError> {
        let base_url = validate_cloud_api_base_url(source, allow_debug_loopback_http)?;
        let http = reqwest::Client::builder()
            .https_only(base_url.scheme() == "https")
            .redirect(Policy::none())
            .connect_timeout(connect_timeout)
            .timeout(total_timeout)
            .user_agent(format!(
                "NexusPilot/{} CloudClient/1",
                env!("CARGO_PKG_VERSION")
            ))
            .build()
            .map_err(|_| CloudClientError::InvalidConfiguration)?;
        Ok(Self {
            base_url,
            http,
            max_response_bytes,
        })
    }

    #[cfg(test)]
    fn for_test(
        source: &str,
        total_timeout: Duration,
        max_response_bytes: usize,
    ) -> Result<Self, CloudClientError> {
        Self::build(
            source,
            true,
            total_timeout,
            total_timeout,
            max_response_bytes,
        )
    }
}

fn map_error_response(status: StatusCode, code: Option<&str>) -> CloudClientError {
    match (status, code) {
        (StatusCode::UNAUTHORIZED, Some("authentication_required" | "invalid_access_token")) => {
            CloudClientError::Unauthorized
        }
        (StatusCode::FORBIDDEN, Some("insufficient_scope")) => CloudClientError::InsufficientScope,
        (StatusCode::NOT_FOUND, Some("cloud_account_not_initialized")) => {
            CloudClientError::AccountNotInitialized
        }
        (StatusCode::FORBIDDEN, Some("connection_sync_not_entitled")) => {
            CloudClientError::ConnectionSyncNotEntitled
        }
        (StatusCode::FORBIDDEN, Some("connection_sync_lifecycle_restricted")) => {
            CloudClientError::ConnectionSyncLifecycleRestricted
        }
        (StatusCode::FORBIDDEN, Some("cloud_account_unavailable")) => {
            CloudClientError::AccountUnavailable
        }
        (StatusCode::FORBIDDEN, Some("sync_device_limit_exceeded")) => {
            CloudClientError::SyncDeviceLimitExceeded
        }
        (StatusCode::CONFLICT, Some("sync_already_initialized")) => {
            CloudClientError::SyncAlreadyInitialized
        }
        (StatusCode::CONFLICT, Some("sync_initialization_mismatch")) => {
            CloudClientError::SyncInitializationMismatch
        }
        (StatusCode::CONFLICT, Some("sync_device_id_conflict")) => {
            CloudClientError::SyncDeviceIdConflict
        }
        (StatusCode::CONFLICT, Some("device_authorization_request_mismatch")) => {
            CloudClientError::DeviceAuthorizationRequestMismatch
        }
        (StatusCode::NOT_FOUND, Some("sync_not_initialized")) => {
            CloudClientError::SyncNotInitialized
        }
        (StatusCode::NOT_FOUND, Some("device_authorization_not_found")) => {
            CloudClientError::DeviceAuthorizationNotFound
        }
        (StatusCode::CONFLICT, Some("device_authorization_not_pending")) => {
            CloudClientError::DeviceAuthorizationNotPending
        }
        (StatusCode::BAD_REQUEST, Some("sync_invalid_request")) => {
            CloudClientError::InvalidSyncRequest
        }
        (StatusCode::TOO_MANY_REQUESTS, Some("pending_device_authorization_limit_exceeded")) => {
            CloudClientError::PendingDeviceAuthorizationLimitExceeded
        }
        (StatusCode::FORBIDDEN, Some("sync_device_not_authorized")) => {
            CloudClientError::SyncDeviceNotAuthorized
        }
        (StatusCode::CONFLICT, Some("connection_asset_operation_mismatch")) => {
            CloudClientError::ConnectionAssetOperationMismatch
        }
        (StatusCode::CONFLICT, Some("connection_asset_type_mismatch")) => {
            CloudClientError::ConnectionAssetTypeMismatch
        }
        (StatusCode::CONFLICT, Some("connection_asset_cursor_invalid")) => {
            CloudClientError::ConnectionAssetCursorInvalid
        }
        (StatusCode::CONFLICT, Some("sync_key_generation_mismatch")) => {
            CloudClientError::SyncKeyGenerationMismatch
        }
        (StatusCode::FORBIDDEN, Some("encrypted_byte_limit_exceeded")) => {
            CloudClientError::EncryptedByteLimitExceeded
        }
        (StatusCode::PAYLOAD_TOO_LARGE, Some("connection_asset_too_large")) => {
            CloudClientError::ConnectionAssetTooLarge
        }
        (StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE, _) => {
            CloudClientError::TemporarilyUnavailable
        }
        (status, _) if status.is_server_error() => CloudClientError::TemporarilyUnavailable,
        _ => CloudClientError::InvalidResponse,
    }
}

fn embedded_cloud_api_base_url() -> &'static str {
    #[cfg(debug_assertions)]
    if let Some(value) = option_env!("NEXUSPILOT_CLOUD_API_BASE_URL") {
        return value;
    }
    PRODUCTION_CLOUD_API_BASE_URL
}

fn validate_cloud_api_base_url(
    source: &str,
    allow_debug_loopback_http: bool,
) -> Result<Url, CloudClientError> {
    let source = source.trim();
    if source.is_empty() || source.len() > MAX_BASE_URL_BYTES {
        return Err(CloudClientError::InvalidConfiguration);
    }
    let url = Url::parse(source).map_err(|_| CloudClientError::InvalidConfiguration)?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/v1/"
    {
        return Err(CloudClientError::InvalidConfiguration);
    }
    match url.scheme() {
        "https" => {}
        "http" if allow_debug_loopback_http && is_loopback_host(&url) => {}
        _ => return Err(CloudClientError::InvalidConfiguration),
    }
    Ok(url)
}

fn is_loopback_host(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => IpAddr::V4(address).is_loopback(),
        Some(Host::Ipv6(address)) => IpAddr::V6(address).is_loopback(),
        None => false,
    }
}

fn is_json_content_type(value: &str) -> bool {
    value
        .split(';')
        .next()
        .is_some_and(|media_type| media_type.trim().eq_ignore_ascii_case("application/json"))
}

async fn read_bounded_body(
    response: reqwest::Response,
    max_response_bytes: usize,
) -> Result<Vec<u8>, CloudClientError> {
    if response
        .content_length()
        .is_some_and(|length| length > max_response_bytes as u64)
    {
        return Err(CloudClientError::ResponseTooLarge);
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| CloudClientError::TemporarilyUnavailable)?;
        if body.len().saturating_add(chunk.len()) > max_response_bytes {
            return Err(CloudClientError::ResponseTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::{
        validate_cloud_api_base_url, CloudApiClient, CloudAssetPutError, CloudClientError, Duration,
    };
    use crate::auth::SecretString;
    use crate::cloud::sync_key_store::CommittedSyncKeyBundle;

    const BOOTSTRAP_JSON: &str = r#"{"account":{"id":"0198f5dc-0000-7000-8000-000000000001","status":"active"},"evaluatedAt":"2026-08-05T12:00:00.000Z","subscription":{"planCode":"free","status":"active","currentPeriodEnd":null},"features":{"connectionSync":{"phase":"not_entitled","permissions":{"readEncryptedAssets":false,"writeEncryptedAssets":false,"enrollSyncDevice":false,"approveDeviceAuthorization":false,"recoverExistingAssets":false},"limits":{"maxSyncDevices":0,"maxEncryptedBytes":0},"usage":{"activeSyncDevices":0,"encryptedBytes":0},"effectiveAt":null,"expiresAt":null,"phaseEndsAt":null,"deletionEligibleAt":null,"entitlementVersion":null,"policyVersion":1}}}"#;
    const DEVICES_JSON: &str = r#"{"evaluatedAt":"2026-08-08T00:00:00.000Z","items":[]}"#;
    const AUTHORIZATION_JSON: &str = r#"{
        "evaluatedAt":"2026-08-08T00:00:00.000Z",
        "authorization":{
            "id":"0198f5dc-0000-7000-8000-000000000002",
            "status":"pending",
            "device":{
                "id":"0198f5dc-0000-7000-8000-000000000003",
                "displayName":"DESKTOP-01",
                "keyGeneration":1,
                "encryptionPublicKey":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
                "signingPublicKey":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI"
            },
            "binding":{
                "pairingNonce":"AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
                "codeVersion":1,
                "bindingHash":"BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ"
            },
            "createdAt":"2026-08-08T00:00:00.000Z",
            "expiresAt":"2026-08-15T00:00:00.000Z",
            "codeExpiresAt":"2026-08-08T00:20:00.000Z",
            "approvedAt":null
        }
    }"#;
    const ASSET_MUTATION_JSON: &str = r#"{
        "evaluatedAt":"2026-08-08T00:00:00.000Z",
        "operation":{"id":"0198f5dc-0000-7000-8000-000000000004","appliedRevision":"1","appliedCursor":"1","replayed":false},
        "asset":{
            "id":"0198f5dc-0000-7000-8000-000000000003",
            "assetType":"connection",
            "revision":"1",
            "parentRevision":null,
            "changeCursor":"1",
            "schemaVersion":1,
            "keyGeneration":1,
            "encryption":{"suite":"XCHACHA20-POLY1305","nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","ciphertext":"AQ"},
            "encryptedBytes":1,
            "tombstone":false,
            "updatedByDeviceId":"0198f5dc-0000-7000-8000-000000000002",
            "createdAt":"2026-08-08T00:00:00.000Z",
            "updatedAt":"2026-08-08T00:00:00.000Z",
            "deletedAt":null
        },
        "usage":{"encryptedBytes":1,"maxEncryptedBytes":10485760}
    }"#;
    const ASSET_LIST_JSON: &str = r#"{
        "evaluatedAt":"2026-08-08T00:00:00.000Z",
        "cursor":{"requested":"0","next":"1","hasMore":false},
        "items":[{"changeCursor":"1","asset":{
            "id":"0198f5dc-0000-7000-8000-000000000003",
            "assetType":"connection",
            "revision":"1",
            "parentRevision":null,
            "changeCursor":"1",
            "schemaVersion":1,
            "keyGeneration":1,
            "encryption":null,
            "encryptedBytes":0,
            "tombstone":true,
            "updatedByDeviceId":"0198f5dc-0000-7000-8000-000000000002",
            "createdAt":"2026-08-08T00:00:00.000Z",
            "updatedAt":"2026-08-08T00:00:00.000Z",
            "deletedAt":"2026-08-08T00:00:00.000Z"
        }}]
    }"#;

    async fn serve_once(
        status: &str,
        content_type: &str,
        body: String,
        delay: Duration,
    ) -> (String, Arc<Mutex<String>>, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener should bind");
        let address = listener.local_addr().expect("listener address");
        let request_capture = Arc::new(Mutex::new(String::new()));
        let observed_request = request_capture.clone();
        let status = status.to_string();
        let content_type = content_type.to_string();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("client should connect");
            let mut request = Vec::new();
            let mut buffer = [0_u8; 1024];
            loop {
                let read = stream.read(&mut buffer).await.expect("request should read");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                if let Some(header_end) = request
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                    .map(|offset| offset + 4)
                {
                    let headers = String::from_utf8_lossy(&request[..header_end]);
                    let content_length = headers.lines().find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    });
                    if request.len() >= header_end + content_length.unwrap_or(0) {
                        break;
                    }
                }
            }
            *observed_request.lock().expect("request capture") =
                String::from_utf8_lossy(&request).into_owned();
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
        });
        (
            format!("http://127.0.0.1:{}/v1/", address.port()),
            request_capture,
            server,
        )
    }

    #[tokio::test]
    async fn bootstrap_sends_bearer_only_in_rust_and_parses_projection() {
        let (base_url, request, server) = serve_once(
            "200 OK",
            "application/json; charset=utf-8",
            BOOTSTRAP_JSON.to_string(),
            Duration::ZERO,
        )
        .await;
        let client = CloudApiClient::for_test(&base_url, Duration::from_secs(2), 64 * 1024)
            .expect("test client");

        let projection = client
            .bootstrap_account(&SecretString::new("test-access-token".to_string()))
            .await
            .expect("bootstrap should succeed");
        server.await.expect("server should finish");

        assert_eq!(
            projection.account.id,
            "0198f5dc-0000-7000-8000-000000000001"
        );
        let request = request.lock().expect("request capture");
        assert!(request.starts_with("POST /v1/account/bootstrap HTTP/1.1"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer test-access-token"));
    }

    #[tokio::test]
    async fn device_list_adds_a_fresh_rust_only_device_proof() {
        let (base_url, request, server) = serve_once(
            "200 OK",
            "application/json",
            DEVICES_JSON.to_string(),
            Duration::ZERO,
        )
        .await;
        let client = CloudApiClient::for_test(&base_url, Duration::from_secs(2), 64 * 1024)
            .expect("test client");
        let keys = CommittedSyncKeyBundle {
            cloud_account_id: "0198f5dc-0000-7000-8000-000000000001".to_string(),
            device_id: "0198f5dc-0000-7000-8000-000000000002".to_string(),
            key_generation: 1,
            amk: [1; 32],
            encryption_private_key: [2; 32],
            signing_private_key: [3; 32],
        };

        let projection = client
            .sync_devices(
                &SecretString::new("test-access-token".to_string()),
                &keys.cloud_account_id,
                &keys,
            )
            .await
            .expect("device list should succeed");
        server.await.expect("server should finish");

        assert!(projection.items.is_empty());
        let request = request.lock().expect("request capture").clone();
        let normalized_request = request.to_ascii_lowercase();
        assert!(normalized_request.starts_with("get /v1/sync/devices http/1.1"));
        assert!(normalized_request.contains("authorization: bearer test-access-token"));
        for header in [
            "x-nexuspilot-device-id:",
            "x-nexuspilot-device-timestamp:",
            "x-nexuspilot-device-nonce:",
            "x-nexuspilot-device-signature:",
        ] {
            assert!(normalized_request.contains(header));
        }
        assert!(!request.contains(&URL_SAFE_NO_PAD.encode(keys.signing_private_key)));
    }

    #[tokio::test]
    async fn device_authorization_creation_uses_the_new_device_proof_boundary() {
        let (base_url, request_capture, server) = serve_once(
            "200 OK",
            "application/json",
            AUTHORIZATION_JSON.to_string(),
            Duration::ZERO,
        )
        .await;
        let client = CloudApiClient::for_test(&base_url, Duration::from_secs(2), 64 * 1024)
            .expect("test client");
        let request = super::super::types::CreateCloudDeviceAuthorizationRequest {
            request_id: "0198f5dc-0000-7000-8000-000000000002".to_string(),
            key_generation: 1,
            device: super::super::types::CreateCloudDeviceAuthorizationDevice {
                id: "0198f5dc-0000-7000-8000-000000000003".to_string(),
                display_name: "DESKTOP-01".to_string(),
                encryption_public_key: URL_SAFE_NO_PAD.encode([1_u8; 32]),
                signing_public_key: URL_SAFE_NO_PAD.encode([2_u8; 32]),
            },
            pairing_nonce: URL_SAFE_NO_PAD.encode([3_u8; 32]),
            verification_code_hash: URL_SAFE_NO_PAD.encode([4_u8; 32]),
        };
        let response = client
            .create_device_authorization(
                &SecretString::new("test-access-token".to_string()),
                "0198f5dc-0000-7000-8000-000000000001",
                &request,
                &[7_u8; 32],
            )
            .await
            .expect("authorization request should succeed");
        server.await.expect("server should finish");
        assert_eq!(response.authorization.status, "pending");
        let captured = request_capture.lock().expect("request capture").clone();
        let normalized = captured.to_ascii_lowercase();
        assert!(captured.starts_with("POST /v1/sync/device-authorizations HTTP/1.1"));
        assert!(normalized.contains("authorization: bearer test-access-token"));
        for header in [
            "x-nexuspilot-device-id:",
            "x-nexuspilot-device-timestamp:",
            "x-nexuspilot-device-nonce:",
            "x-nexuspilot-device-signature:",
        ] {
            assert!(normalized.contains(header));
        }
        assert!(!captured.contains(&URL_SAFE_NO_PAD.encode([7_u8; 32])));
    }

    #[tokio::test]
    async fn connection_asset_put_sends_rust_only_proof_and_parses_mutation() {
        let (base_url, request_capture, server) = serve_once(
            "200 OK",
            "application/json",
            ASSET_MUTATION_JSON.to_string(),
            Duration::ZERO,
        )
        .await;
        let client = CloudApiClient::for_test(&base_url, Duration::from_secs(2), 64 * 1024)
            .expect("test client");
        let keys = CommittedSyncKeyBundle {
            cloud_account_id: "0198f5dc-0000-7000-8000-000000000001".to_string(),
            device_id: "0198f5dc-0000-7000-8000-000000000002".to_string(),
            key_generation: 1,
            amk: [1; 32],
            encryption_private_key: [2; 32],
            signing_private_key: [3; 32],
        };
        let request = super::super::types::PutCloudConnectionAssetRequest {
            operation_id: "0198f5dc-0000-7000-8000-000000000004".to_string(),
            expected_revision: None,
            asset_type: "connection".to_string(),
            schema_version: 1,
            key_generation: 1,
            encryption: super::super::types::CloudConnectionAssetEncryption {
                suite: "XCHACHA20-POLY1305".to_string(),
                nonce: URL_SAFE_NO_PAD.encode([0_u8; 24]),
                ciphertext: "AQ".to_string(),
            },
        };
        let result = client
            .put_connection_asset(
                &SecretString::new("test-access-token".to_string()),
                &keys.cloud_account_id,
                "0198f5dc-0000-7000-8000-000000000003",
                &request,
                &keys,
            )
            .await
            .expect("asset put should succeed");
        server.await.expect("server should finish");
        assert_eq!(result.operation.applied_revision, "1");
        let captured = request_capture.lock().expect("request capture").clone();
        let normalized = captured.to_ascii_lowercase();
        assert!(
            captured.starts_with("PUT /v1/sync/connection-assets/")
                && normalized.contains("authorization: bearer test-access-token")
        );
        for header in [
            "x-nexuspilot-device-id:",
            "x-nexuspilot-device-timestamp:",
            "x-nexuspilot-device-nonce:",
            "x-nexuspilot-device-signature:",
        ] {
            assert!(normalized.contains(header));
        }
        assert!(!captured.contains(&URL_SAFE_NO_PAD.encode(keys.amk)));
        assert!(!captured.contains(&URL_SAFE_NO_PAD.encode(keys.signing_private_key)));
    }

    #[tokio::test]
    async fn connection_asset_delete_sends_rust_only_proof_and_parses_tombstone_response() {
        let (base_url, request_capture, server) = serve_once(
            "200 OK",
            "application/json",
            ASSET_MUTATION_JSON.to_string(),
            Duration::ZERO,
        )
        .await;
        let client = CloudApiClient::for_test(&base_url, Duration::from_secs(2), 64 * 1024)
            .expect("test client");
        let keys = CommittedSyncKeyBundle {
            cloud_account_id: "0198f5dc-0000-7000-8000-000000000001".to_string(),
            device_id: "0198f5dc-0000-7000-8000-000000000002".to_string(),
            key_generation: 1,
            amk: [1; 32],
            encryption_private_key: [2; 32],
            signing_private_key: [3; 32],
        };
        let request = super::super::types::DeleteCloudConnectionAssetRequest {
            operation_id: "0198f5dc-0000-7000-8000-000000000004".to_string(),
            expected_revision: "1".to_string(),
        };
        let response = client
            .delete_connection_asset(
                &SecretString::new("test-access-token".to_string()),
                &keys.cloud_account_id,
                "0198f5dc-0000-7000-8000-000000000003",
                &request,
                &keys,
            )
            .await
            .expect("asset delete should succeed");
        server.await.expect("server should finish");
        assert_eq!(response.operation.applied_revision, "1");
        let captured = request_capture.lock().expect("request capture").clone();
        let normalized = captured.to_ascii_lowercase();
        assert!(captured.starts_with("DELETE /v1/sync/connection-assets/"));
        assert!(normalized.contains("authorization: bearer test-access-token"));
        for header in [
            "x-nexuspilot-device-id:",
            "x-nexuspilot-device-timestamp:",
            "x-nexuspilot-device-nonce:",
            "x-nexuspilot-device-signature:",
        ] {
            assert!(normalized.contains(header));
        }
        assert!(!captured.contains(&URL_SAFE_NO_PAD.encode(keys.amk)));
        assert!(!captured.contains(&URL_SAFE_NO_PAD.encode(keys.signing_private_key)));
    }

    #[tokio::test]
    async fn connection_asset_list_sends_cursor_query_and_rust_only_proof() {
        let (base_url, request_capture, server) = serve_once(
            "200 OK",
            "application/json",
            ASSET_LIST_JSON.to_string(),
            Duration::ZERO,
        )
        .await;
        let client = CloudApiClient::for_test(&base_url, Duration::from_secs(2), 64 * 1024)
            .expect("test client");
        let keys = CommittedSyncKeyBundle {
            cloud_account_id: "0198f5dc-0000-7000-8000-000000000001".to_string(),
            device_id: "0198f5dc-0000-7000-8000-000000000002".to_string(),
            key_generation: 1,
            amk: [1; 32],
            encryption_private_key: [2; 32],
            signing_private_key: [3; 32],
        };
        let response = client
            .list_connection_assets(
                &SecretString::new("test-access-token".to_string()),
                &keys.cloud_account_id,
                0,
                50,
                &keys,
            )
            .await
            .expect("asset list should succeed");
        server.await.expect("server should finish");
        assert_eq!(response.cursor.next, "1");
        assert_eq!(response.items.len(), 1);
        let captured = request_capture.lock().expect("request capture").clone();
        let normalized = captured.to_ascii_lowercase();
        assert!(captured.starts_with("GET /v1/sync/connection-assets?cursor=0&limit=50 HTTP/1.1"));
        assert!(normalized.contains("authorization: bearer test-access-token"));
        for header in [
            "x-nexuspilot-device-id:",
            "x-nexuspilot-device-timestamp:",
            "x-nexuspilot-device-nonce:",
            "x-nexuspilot-device-signature:",
        ] {
            assert!(normalized.contains(header));
        }
        assert!(!captured.contains(&URL_SAFE_NO_PAD.encode(keys.amk)));
        assert!(!captured.contains(&URL_SAFE_NO_PAD.encode(keys.signing_private_key)));
    }

    #[tokio::test]
    async fn connection_asset_list_maps_server_cursor_invalid_error() {
        let (base_url, _, server) = serve_once(
            "409 Conflict",
            "application/json",
            r#"{"error":{"code":"connection_asset_cursor_invalid","message":"cursor is stale"}}"#
                .to_string(),
            Duration::ZERO,
        )
        .await;
        let client = CloudApiClient::for_test(&base_url, Duration::from_secs(2), 64 * 1024)
            .expect("test client");
        let keys = CommittedSyncKeyBundle {
            cloud_account_id: "account-1".to_string(),
            device_id: "0198f5dc-0000-7000-8000-000000000002".to_string(),
            key_generation: 1,
            amk: [1; 32],
            encryption_private_key: [2; 32],
            signing_private_key: [3; 32],
        };
        let error = client
            .list_connection_assets(
                &SecretString::new("test-access-token".to_string()),
                &keys.cloud_account_id,
                12,
                50,
                &keys,
            )
            .await
            .expect_err("stale cursor should fail closed");
        server.await.expect("server should finish");
        assert_eq!(error, CloudClientError::ConnectionAssetCursorInvalid);
    }

    #[tokio::test]
    async fn connection_asset_revision_conflict_preserves_cloud_candidate() {
        let body = r#"{"error":{"code":"connection_asset_revision_conflict","message":"conflict"},"current":null}"#;
        let (base_url, _, server) = serve_once(
            "409 Conflict",
            "application/json",
            body.to_string(),
            Duration::ZERO,
        )
        .await;
        let client = CloudApiClient::for_test(&base_url, Duration::from_secs(2), 64 * 1024)
            .expect("test client");
        let keys = CommittedSyncKeyBundle {
            cloud_account_id: "account-1".to_string(),
            device_id: "device-1".to_string(),
            key_generation: 1,
            amk: [1; 32],
            encryption_private_key: [2; 32],
            signing_private_key: [3; 32],
        };
        let request = super::super::types::PutCloudConnectionAssetRequest {
            operation_id: "0198f5dc-0000-7000-8000-000000000004".to_string(),
            expected_revision: Some("1".to_string()),
            asset_type: "connection".to_string(),
            schema_version: 1,
            key_generation: 1,
            encryption: super::super::types::CloudConnectionAssetEncryption {
                suite: "XCHACHA20-POLY1305".to_string(),
                nonce: URL_SAFE_NO_PAD.encode([0_u8; 24]),
                ciphertext: "AQ".to_string(),
            },
        };
        let error = client
            .put_connection_asset(
                &SecretString::new("test-access-token".to_string()),
                &keys.cloud_account_id,
                "0198f5dc-0000-7000-8000-000000000003",
                &request,
                &keys,
            )
            .await
            .expect_err("revision conflict should not be reported as success");
        server.await.expect("server should finish");
        assert!(
            matches!(error, CloudAssetPutError::Conflict(response) if response.current.is_none())
        );
    }

    #[tokio::test]
    async fn maps_versioned_auth_and_availability_errors_without_returning_body() {
        for (status, body, expected) in [
            (
                "401 Unauthorized",
                r#"{"error":{"code":"invalid_access_token","message":"secret detail"}}"#,
                CloudClientError::Unauthorized,
            ),
            (
                "403 Forbidden",
                r#"{"error":{"code":"insufficient_scope","message":"secret detail"}}"#,
                CloudClientError::InsufficientScope,
            ),
            (
                "503 Service Unavailable",
                r#"{"error":{"code":"cloud_temporarily_unavailable","message":"secret detail"}}"#,
                CloudClientError::TemporarilyUnavailable,
            ),
        ] {
            let (base_url, _, server) =
                serve_once(status, "application/json", body.to_string(), Duration::ZERO).await;
            let client = CloudApiClient::for_test(&base_url, Duration::from_secs(2), 64 * 1024)
                .expect("test client");
            let error = client
                .bootstrap_account(&SecretString::new("test-access-token".to_string()))
                .await
                .expect_err("response should fail");
            server.await.expect("server should finish");
            assert_eq!(error, expected);
        }
    }

    #[tokio::test]
    async fn rejects_oversized_success_response_and_times_out_safely() {
        let (base_url, _, oversized_server) = serve_once(
            "200 OK",
            "application/json",
            "x".repeat(1_024),
            Duration::ZERO,
        )
        .await;
        let client =
            CloudApiClient::for_test(&base_url, Duration::from_secs(2), 128).expect("test client");
        assert_eq!(
            client
                .bootstrap_account(&SecretString::new("oversized-token".to_string()))
                .await
                .expect_err("oversized response should fail"),
            CloudClientError::ResponseTooLarge
        );
        oversized_server.await.expect("server should finish");

        let (base_url, _, delayed_server) = serve_once(
            "200 OK",
            "application/json",
            BOOTSTRAP_JSON.to_string(),
            Duration::from_millis(200),
        )
        .await;
        let client = CloudApiClient::for_test(&base_url, Duration::from_millis(30), 64 * 1024)
            .expect("test client");
        assert_eq!(
            client
                .bootstrap_account(&SecretString::new("timeout-token".to_string()))
                .await
                .expect_err("request should time out"),
            CloudClientError::TemporarilyUnavailable
        );
        delayed_server.await.expect("server should finish");
    }

    #[test]
    fn production_and_debug_base_url_rules_fail_closed() {
        assert!(validate_cloud_api_base_url("https://api.nexuspilot.dev/v1/", false).is_ok());
        assert!(validate_cloud_api_base_url("http://127.0.0.1:8788/v1/", true).is_ok());
        assert!(validate_cloud_api_base_url("http://localhost:8788/v1/", true).is_ok());
        for rejected in [
            "http://api.nexuspilot.dev/v1/",
            "https://user:pass@api.nexuspilot.dev/v1/",
            "https://api.nexuspilot.dev/v2/",
            "https://api.nexuspilot.dev/v1/?target=elsewhere",
        ] {
            assert_eq!(
                validate_cloud_api_base_url(rejected, false),
                Err(CloudClientError::InvalidConfiguration)
            );
        }
    }

    #[test]
    fn initialization_errors_distinguish_definite_rejection_from_unknown_outcome() {
        for error in [
            CloudClientError::TemporarilyUnavailable,
            CloudClientError::ResponseTooLarge,
            CloudClientError::InvalidResponse,
        ] {
            assert!(error.sync_initialization_outcome_unknown());
        }
        for error in [
            CloudClientError::Unauthorized,
            CloudClientError::InsufficientScope,
            CloudClientError::ConnectionSyncNotEntitled,
            CloudClientError::ConnectionSyncLifecycleRestricted,
            CloudClientError::SyncDeviceLimitExceeded,
            CloudClientError::SyncAlreadyInitialized,
            CloudClientError::SyncInitializationMismatch,
            CloudClientError::SyncDeviceIdConflict,
            CloudClientError::InvalidSyncRequest,
        ] {
            assert!(!error.sync_initialization_outcome_unknown());
        }
    }
}
