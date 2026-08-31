use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use std::str::FromStr;
use uuid::Uuid;

use crate::repository::connection_repository::ConnectionDriver;

use super::{
    sync_crypto::decrypt_connection_asset,
    sync_key_store::CommittedSyncKeyBundle,
    sync_projection::{
        ConnectionFolderSyncProjection, ConnectionSyncProjection, SYNC_SCHEMA_VERSION,
    },
    types::{
        CloudConnectionAssetChange, CloudConnectionAssetListResponse,
        CloudConnectionAssetProjection,
    },
};

/// A page that has passed all protocol, cursor, key-generation and AEAD checks.
///
/// The page is deliberately detached from the local SQLite repositories.  The caller can only
/// advance the durable cursor after it has applied every item (or persisted its conflict) in a
/// single transaction.
#[derive(Debug)]
pub(crate) struct ValidatedSyncPage {
    pub requested_cursor: u64,
    pub next_cursor: u64,
    pub has_more: bool,
    pub items: Vec<ValidatedSyncChange>,
}

#[derive(Debug)]
pub(crate) struct ValidatedSyncChange {
    pub change_cursor: u64,
    pub asset: CloudConnectionAssetProjection,
    pub projection: Option<DecryptedSyncProjection>,
    pub payload_hash: Option<String>,
}

#[derive(Debug)]
pub(crate) enum DecryptedSyncProjection {
    Connection(ConnectionSyncProjection),
    ConnectionFolder(ConnectionFolderSyncProjection),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SyncPullError {
    CursorInvalid,
    ProtocolViolation,
    InvalidAssetId,
    UnsupportedAssetType,
    UnsupportedSchemaVersion,
    KeyGenerationMismatch,
    MissingEncryption,
    UnexpectedEncryption,
    DecryptionFailed,
    InvalidProjection,
}

pub(crate) fn validate_and_decrypt_page(
    account_id: &str,
    local_cursor: u64,
    response: CloudConnectionAssetListResponse,
    keys: &CommittedSyncKeyBundle,
) -> Result<ValidatedSyncPage, SyncPullError> {
    let requested_cursor = parse_cursor(&response.cursor.requested)?;
    let next_cursor = parse_cursor(&response.cursor.next)?;
    if requested_cursor != local_cursor || next_cursor < requested_cursor {
        return Err(SyncPullError::CursorInvalid);
    }
    if response.cursor.has_more && next_cursor == requested_cursor {
        return Err(SyncPullError::ProtocolViolation);
    }

    let mut previous_change_cursor = requested_cursor;
    let has_items = !response.items.is_empty();
    let mut items = Vec::with_capacity(response.items.len());
    for change in response.items {
        let change_cursor = parse_cursor(&change.change_cursor)?;
        if change_cursor <= previous_change_cursor || change_cursor > next_cursor {
            return Err(SyncPullError::ProtocolViolation);
        }
        if parse_cursor(&change.asset.change_cursor)? < change_cursor {
            return Err(SyncPullError::ProtocolViolation);
        }
        let validated = validate_and_decrypt_change(account_id, change, keys)?;
        previous_change_cursor = change_cursor;
        items.push(validated);
    }
    if !has_items && next_cursor != requested_cursor {
        return Err(SyncPullError::ProtocolViolation);
    }
    if has_items && next_cursor != previous_change_cursor {
        return Err(SyncPullError::ProtocolViolation);
    }
    Ok(ValidatedSyncPage {
        requested_cursor,
        next_cursor,
        has_more: response.cursor.has_more,
        items,
    })
}

fn validate_and_decrypt_change(
    account_id: &str,
    change: CloudConnectionAssetChange,
    keys: &CommittedSyncKeyBundle,
) -> Result<ValidatedSyncChange, SyncPullError> {
    let change_cursor = parse_cursor(&change.change_cursor)?;
    let asset = change.asset;
    Uuid::parse_str(&asset.id).map_err(|_| SyncPullError::InvalidAssetId)?;
    Uuid::parse_str(&asset.updated_by_device_id).map_err(|_| SyncPullError::ProtocolViolation)?;
    let asset_type = asset_type_name(&asset)?;
    let revision = parse_revision(&asset.revision)?;
    if let Some(parent_revision) = asset.parent_revision.as_deref() {
        let parent_revision = parse_revision(parent_revision)?;
        if parent_revision >= revision {
            return Err(SyncPullError::ProtocolViolation);
        }
    }
    if asset.schema_version != SYNC_SCHEMA_VERSION as u16 {
        return Err(SyncPullError::UnsupportedSchemaVersion);
    }
    if asset.key_generation != u64::from(keys.key_generation) {
        return Err(SyncPullError::KeyGenerationMismatch);
    }
    if asset.tombstone {
        if asset.encryption.is_some() || asset.encrypted_bytes != 0 || asset.deleted_at.is_none() {
            return Err(SyncPullError::UnexpectedEncryption);
        }
        return Ok(ValidatedSyncChange {
            change_cursor,
            asset,
            projection: None,
            payload_hash: None,
        });
    }

    let encryption = asset
        .encryption
        .as_ref()
        .ok_or(SyncPullError::MissingEncryption)?;
    let nonce = URL_SAFE_NO_PAD
        .decode(&encryption.nonce)
        .map_err(|_| SyncPullError::DecryptionFailed)?;
    let ciphertext = URL_SAFE_NO_PAD
        .decode(&encryption.ciphertext)
        .map_err(|_| SyncPullError::DecryptionFailed)?;
    if nonce.len() != 24
        || ciphertext.len() < 16
        || asset.encrypted_bytes != ciphertext.len() as u64
    {
        return Err(SyncPullError::ProtocolViolation);
    }
    if asset.deleted_at.is_some() {
        return Err(SyncPullError::ProtocolViolation);
    }
    let plaintext = decrypt_connection_asset(
        account_id,
        &asset.id,
        asset_type,
        revision,
        asset.schema_version,
        asset.key_generation,
        encryption,
        &keys.amk,
    )
    .map_err(|_| SyncPullError::DecryptionFailed)?;
    let projection = match asset_type {
        "connection" => {
            let value: ConnectionSyncProjection = decode_projection(&plaintext)?;
            validate_projection_common(
                &value.schema_version,
                &value.asset_type,
                &value.id,
                &asset,
            )?;
            ConnectionDriver::from_str(&value.driver)
                .map_err(|_| SyncPullError::InvalidProjection)?;
            if value.name.trim().is_empty() {
                return Err(SyncPullError::InvalidProjection);
            }
            if let Some(folder_id) = value.folder_id.as_deref() {
                Uuid::parse_str(folder_id).map_err(|_| SyncPullError::InvalidProjection)?;
            }
            DecryptedSyncProjection::Connection(value)
        }
        "connection_folder" => {
            let value: ConnectionFolderSyncProjection = decode_projection(&plaintext)?;
            validate_projection_common(
                &value.schema_version,
                &value.asset_type,
                &value.id,
                &asset,
            )?;
            if value.name.trim().is_empty() {
                return Err(SyncPullError::InvalidProjection);
            }
            if let Some(parent_id) = value.parent_id.as_deref() {
                Uuid::parse_str(parent_id).map_err(|_| SyncPullError::InvalidProjection)?;
            }
            DecryptedSyncProjection::ConnectionFolder(value)
        }
        _ => return Err(SyncPullError::UnsupportedAssetType),
    };
    Ok(ValidatedSyncChange {
        change_cursor,
        asset,
        projection: Some(projection),
        payload_hash: Some(URL_SAFE_NO_PAD.encode(Sha256::digest(&plaintext))),
    })
}

fn validate_projection_common(
    schema_version: &u32,
    asset_type: &crate::repository::cloud_sync_repository::CloudSyncAssetType,
    id: &str,
    asset: &CloudConnectionAssetProjection,
) -> Result<(), SyncPullError> {
    if *schema_version != SYNC_SCHEMA_VERSION || id != asset.id {
        return Err(SyncPullError::InvalidProjection);
    }
    let expected = match asset_type {
        crate::repository::cloud_sync_repository::CloudSyncAssetType::Connection => "connection",
        crate::repository::cloud_sync_repository::CloudSyncAssetType::ConnectionFolder => {
            "connection_folder"
        }
    };
    if expected != asset.asset_type {
        return Err(SyncPullError::InvalidProjection);
    }
    Ok(())
}

fn decode_projection<T: DeserializeOwned>(plaintext: &[u8]) -> Result<T, SyncPullError> {
    serde_json::from_slice(plaintext).map_err(|_| SyncPullError::InvalidProjection)
}

fn asset_type_name(asset: &CloudConnectionAssetProjection) -> Result<&'static str, SyncPullError> {
    match asset.asset_type.as_str() {
        "connection" => Ok("connection"),
        "connection_folder" => Ok("connection_folder"),
        _ => Err(SyncPullError::UnsupportedAssetType),
    }
}

fn parse_cursor(value: &str) -> Result<u64, SyncPullError> {
    value
        .parse::<u64>()
        .map_err(|_| SyncPullError::CursorInvalid)
}

fn parse_revision(value: &str) -> Result<u64, SyncPullError> {
    let revision = value
        .parse::<u64>()
        .map_err(|_| SyncPullError::ProtocolViolation)?;
    (revision > 0)
        .then_some(revision)
        .ok_or(SyncPullError::ProtocolViolation)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::{
        sync_crypto::encrypt_connection_asset, types::CloudConnectionAssetEncryption,
    };
    use serde_json::json;

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
        encryption: Option<CloudConnectionAssetEncryption>,
        tombstone: bool,
    ) -> CloudConnectionAssetProjection {
        CloudConnectionAssetProjection {
            id: "0198f5dc-0000-7000-8000-000000000003".to_string(),
            asset_type: "connection".to_string(),
            revision: "1".to_string(),
            parent_revision: None,
            change_cursor: "1".to_string(),
            schema_version: 1,
            key_generation: 1,
            encryption,
            encrypted_bytes: if tombstone { 0 } else { 0 },
            tombstone,
            updated_by_device_id: keys().device_id.clone(),
            created_at: "2026-08-08T00:00:00.000Z".to_string(),
            updated_at: "2026-08-08T00:00:00.000Z".to_string(),
            deleted_at: tombstone.then(|| "2026-08-08T00:00:00.000Z".to_string()),
        }
    }

    fn page(asset: CloudConnectionAssetProjection) -> CloudConnectionAssetListResponse {
        CloudConnectionAssetListResponse {
            evaluated_at: "2026-08-08T00:00:00.000Z".to_string(),
            cursor: super::super::types::CloudConnectionAssetCursor {
                requested: "0".to_string(),
                next: "1".to_string(),
                has_more: false,
            },
            items: vec![CloudConnectionAssetChange {
                change_cursor: "1".to_string(),
                asset,
            }],
        }
    }

    #[test]
    fn decrypts_and_validates_a_connection_page_before_returning_it() {
        let plaintext = serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "assetType": "connection",
            "id": "0198f5dc-0000-7000-8000-000000000003",
            "name": "Production",
            "driver": "postgres",
            "environment": "production",
            "color": null,
            "tagLabel": "",
            "tagColor": null,
            "folderId": null,
            "sortOrder": 1,
            "payload": {"host": "db.example.com"},
            "localDependencies": []
        }))
        .unwrap();
        let encrypted = encrypt_connection_asset(
            "account-1",
            "0198f5dc-0000-7000-8000-000000000003",
            "connection",
            1,
            1,
            1,
            &plaintext,
            &keys().amk,
        )
        .unwrap();
        let mut remote = asset(Some(encrypted), false);
        remote.encrypted_bytes = URL_SAFE_NO_PAD
            .decode(&remote.encryption.as_ref().unwrap().ciphertext)
            .unwrap()
            .len() as u64;
        let result = validate_and_decrypt_page("account-1", 0, page(remote), &keys()).unwrap();
        assert_eq!(result.next_cursor, 1);
        match &result.items[0].projection {
            Some(DecryptedSyncProjection::Connection(projection)) => {
                assert_eq!(projection.note, "");
            }
            other => panic!("expected connection projection, got {other:?}"),
        }
    }

    #[test]
    fn rejects_cursor_gaps_and_key_generation_mismatch() {
        let mut response = page(asset(None, true));
        response.cursor.next = "2".to_string();
        assert_eq!(
            validate_and_decrypt_page("account-1", 0, response, &keys()).unwrap_err(),
            SyncPullError::ProtocolViolation
        );
        let mut response = page(asset(None, true));
        response.items[0].asset.key_generation = 2;
        assert_eq!(
            validate_and_decrypt_page("account-1", 0, response, &keys()).unwrap_err(),
            SyncPullError::KeyGenerationMismatch
        );
    }

    #[test]
    fn tombstones_are_accepted_only_without_ciphertext() {
        let mut response = page(asset(None, true));
        assert!(validate_and_decrypt_page("account-1", 0, response.clone(), &keys()).is_ok());
        response.items[0].asset.encryption = Some(CloudConnectionAssetEncryption {
            suite: "XCHACHA20-POLY1305".to_string(),
            nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string(),
            ciphertext: "AQ".to_string(),
        });
        assert_eq!(
            validate_and_decrypt_page("account-1", 0, response, &keys()).unwrap_err(),
            SyncPullError::UnexpectedEncryption
        );
    }
}
