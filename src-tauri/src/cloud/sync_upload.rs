use uuid::Uuid;

use super::{
    client::{CloudApiClient, CloudAssetPutError},
    sync_crypto::{encrypt_connection_asset, SyncCryptoError},
    sync_key_store::CommittedSyncKeyBundle,
    types::{
        CloudConnectionAssetMutationResponse, DeleteCloudConnectionAssetRequest,
        PutCloudConnectionAssetRequest,
    },
};
use crate::repository::cloud_sync_repository::{
    CloudSyncAssetType, CloudSyncOperation, CloudSyncOperationAction, EnqueueCloudSyncOperation,
};

pub(crate) struct PreparedConnectionUpload {
    pub operation: EnqueueCloudSyncOperation,
    pub next_revision: u64,
}

pub(crate) fn prepare_connection_delete(
    cloud_account_id: &str,
    asset_id: &str,
    asset_type: CloudSyncAssetType,
    expected_revision: u64,
) -> Result<EnqueueCloudSyncOperation, SyncCryptoError> {
    if cloud_account_id.is_empty() || asset_id.is_empty() || expected_revision == 0 {
        return Err(SyncCryptoError::EncodingFailed);
    }
    Ok(EnqueueCloudSyncOperation {
        operation_id: Uuid::new_v4().to_string(),
        cloud_account_id: cloud_account_id.to_string(),
        asset_id: asset_id.to_string(),
        asset_type,
        action: CloudSyncOperationAction::Delete,
        expected_revision: Some(expected_revision),
        schema_version: None,
        key_generation: None,
        nonce: None,
        ciphertext: None,
        payload_hash: None,
    })
}

pub(crate) fn prepare_connection_upload(
    cloud_account_id: &str,
    asset_id: &str,
    asset_type: CloudSyncAssetType,
    expected_revision: Option<u64>,
    schema_version: u16,
    key_generation: u64,
    plaintext: &[u8],
    amk: &[u8; 32],
) -> Result<PreparedConnectionUpload, SyncCryptoError> {
    let next_revision = expected_revision
        .map(|revision| {
            revision
                .checked_add(1)
                .ok_or(SyncCryptoError::EncodingFailed)
        })
        .transpose()?
        .unwrap_or(1);
    let asset_type_value = match asset_type {
        CloudSyncAssetType::Connection => "connection",
        CloudSyncAssetType::ConnectionFolder => "connection_folder",
    };
    let encryption = encrypt_connection_asset(
        cloud_account_id,
        asset_id,
        asset_type_value,
        next_revision,
        schema_version,
        key_generation,
        plaintext,
        amk,
    )?;
    let payload_hash = sha256_base64url(plaintext);
    Ok(PreparedConnectionUpload {
        next_revision,
        operation: EnqueueCloudSyncOperation {
            operation_id: Uuid::new_v4().to_string(),
            cloud_account_id: cloud_account_id.to_string(),
            asset_id: asset_id.to_string(),
            asset_type,
            action: CloudSyncOperationAction::Put,
            expected_revision,
            schema_version: Some(schema_version),
            key_generation: Some(key_generation),
            nonce: Some(encryption.nonce),
            ciphertext: Some(encryption.ciphertext),
            payload_hash: Some(payload_hash),
        },
    })
}

pub(crate) async fn flush_put_operation(
    client: &CloudApiClient,
    access_token: &crate::auth::SecretString,
    account_id: &str,
    operation: &CloudSyncOperation,
    keys: &CommittedSyncKeyBundle,
) -> Result<CloudConnectionAssetMutationResponse, CloudAssetPutError> {
    if operation.action != CloudSyncOperationAction::Put
        || operation.cloud_account_id != account_id
        || operation.key_generation != Some(u64::from(keys.key_generation))
    {
        return Err(CloudAssetPutError::Client(
            super::client::CloudClientError::InvalidResponse,
        ));
    }
    let asset_type = match operation.asset_type {
        CloudSyncAssetType::Connection => "connection",
        CloudSyncAssetType::ConnectionFolder => "connection_folder",
    };
    let schema_version = operation.schema_version.ok_or(CloudAssetPutError::Client(
        super::client::CloudClientError::InvalidResponse,
    ))?;
    let key_generation = operation.key_generation.ok_or(CloudAssetPutError::Client(
        super::client::CloudClientError::InvalidResponse,
    ))?;
    let nonce = operation.nonce.clone().ok_or(CloudAssetPutError::Client(
        super::client::CloudClientError::InvalidResponse,
    ))?;
    let ciphertext = operation
        .ciphertext
        .clone()
        .ok_or(CloudAssetPutError::Client(
            super::client::CloudClientError::InvalidResponse,
        ))?;
    let request = PutCloudConnectionAssetRequest {
        operation_id: operation.operation_id.clone(),
        expected_revision: operation.expected_revision.map(|value| value.to_string()),
        asset_type: asset_type.to_string(),
        schema_version,
        key_generation,
        encryption: super::types::CloudConnectionAssetEncryption {
            suite: "XCHACHA20-POLY1305".to_string(),
            nonce,
            ciphertext,
        },
    };
    client
        .put_connection_asset(
            access_token,
            account_id,
            &operation.asset_id,
            &request,
            keys,
        )
        .await
}

pub(crate) async fn flush_delete_operation(
    client: &CloudApiClient,
    access_token: &crate::auth::SecretString,
    account_id: &str,
    operation: &CloudSyncOperation,
    keys: &CommittedSyncKeyBundle,
) -> Result<CloudConnectionAssetMutationResponse, CloudAssetPutError> {
    if operation.action != CloudSyncOperationAction::Delete
        || operation.cloud_account_id != account_id
        || operation.expected_revision.is_none()
    {
        return Err(CloudAssetPutError::Client(
            super::client::CloudClientError::InvalidResponse,
        ));
    }
    let request = DeleteCloudConnectionAssetRequest {
        operation_id: operation.operation_id.clone(),
        expected_revision: operation.expected_revision.unwrap().to_string(),
    };
    client
        .delete_connection_asset(
            access_token,
            account_id,
            &operation.asset_id,
            &request,
            keys,
        )
        .await
}

fn sha256_base64url(value: &[u8]) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use sha2::{Digest, Sha256};

    URL_SAFE_NO_PAD.encode(Sha256::digest(value))
}

#[cfg(test)]
mod tests {
    use super::{prepare_connection_delete, prepare_connection_upload};
    use crate::repository::cloud_sync_repository::{CloudSyncAssetType, CloudSyncOperationAction};

    #[test]
    fn prepares_a_stable_shape_with_revision_one_for_new_assets() {
        let prepared = prepare_connection_upload(
            "account-1",
            "asset-1",
            CloudSyncAssetType::Connection,
            None,
            1,
            1,
            br#"{"schemaVersion":1}"#,
            &[9_u8; 32],
        )
        .expect("upload should be prepared");
        assert_eq!(prepared.next_revision, 1);
        assert_eq!(prepared.operation.expected_revision, None);
        assert_eq!(prepared.operation.schema_version, Some(1));
        assert!(prepared.operation.nonce.is_some());
        assert!(prepared.operation.ciphertext.is_some());
    }

    #[test]
    fn prepares_next_revision_from_cloud_parent() {
        let prepared = prepare_connection_upload(
            "account-1",
            "asset-1",
            CloudSyncAssetType::ConnectionFolder,
            Some(7),
            1,
            1,
            b"folder",
            &[9_u8; 32],
        )
        .expect("upload should be prepared");
        assert_eq!(prepared.next_revision, 8);
        assert_eq!(prepared.operation.expected_revision, Some(7));
    }

    #[test]
    fn prepares_a_delete_with_the_remote_revision_precondition() {
        let operation =
            prepare_connection_delete("account-1", "asset-1", CloudSyncAssetType::Connection, 4)
                .expect("delete should be prepared");
        assert_eq!(operation.action, CloudSyncOperationAction::Delete);
        assert_eq!(operation.expected_revision, Some(4));
        assert_eq!(operation.ciphertext, None);
    }
}
