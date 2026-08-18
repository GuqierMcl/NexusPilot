use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use super::sync_crypto::SyncKeyMaterial;

const MAX_RECORD_BYTES: usize = 2_048;
const RECORD_VERSION: u8 = 1;

#[cfg(debug_assertions)]
const KEYCHAIN_SERVICE: &str = "NexusPilot.Sync.dev.v1";
#[cfg(not(debug_assertions))]
const KEYCHAIN_SERVICE: &str = "NexusPilot.Sync.v1";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SyncKeyStoreError {
    Unavailable,
    Corrupted,
    TooLarge,
    Conflict,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum SyncKeyRecordState {
    Pending,
    Committed,
}

fn legacy_record_state() -> SyncKeyRecordState {
    SyncKeyRecordState::Committed
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncKeyBundleV1 {
    version: u8,
    #[serde(default = "legacy_record_state")]
    record_state: SyncKeyRecordState,
    cloud_account_id: String,
    device_id: String,
    initialization_id: String,
    identity_binding_sha256: String,
    key_generation: u8,
    amk: String,
    encryption_private_key: String,
    signing_private_key: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingDeviceAuthorizationRecordV1 {
    version: u8,
    cloud_account_id: String,
    identity_binding_sha256: String,
    request_id: String,
    device_id: String,
    display_name: String,
    key_generation: u64,
    pairing_nonce: String,
    verification_code: String,
    verification_code_hash: String,
    encryption_public_key: String,
    signing_public_key: String,
    encryption_private_key: String,
    signing_private_key: String,
}

impl Drop for PendingDeviceAuthorizationRecordV1 {
    fn drop(&mut self) {
        self.cloud_account_id.zeroize();
        self.identity_binding_sha256.zeroize();
        self.request_id.zeroize();
        self.device_id.zeroize();
        self.display_name.zeroize();
        self.pairing_nonce.zeroize();
        self.verification_code.zeroize();
        self.verification_code_hash.zeroize();
        self.encryption_public_key.zeroize();
        self.signing_public_key.zeroize();
        self.encryption_private_key.zeroize();
        self.signing_private_key.zeroize();
    }
}

impl Drop for SyncKeyBundleV1 {
    fn drop(&mut self) {
        self.cloud_account_id.zeroize();
        self.device_id.zeroize();
        self.initialization_id.zeroize();
        self.identity_binding_sha256.zeroize();
        self.amk.zeroize();
        self.encryption_private_key.zeroize();
        self.signing_private_key.zeroize();
    }
}

pub(crate) struct SyncKeyBundleInput<'a> {
    pub cloud_account_id: &'a str,
    pub device_id: &'a str,
    pub initialization_id: &'a str,
    pub identity_binding_sha256: &'a str,
    pub keys: &'a SyncKeyMaterial,
}

pub(crate) struct PendingDeviceAuthorizationInput<'a> {
    pub cloud_account_id: &'a str,
    pub identity_binding_sha256: &'a str,
    pub request_id: &'a str,
    pub device_id: &'a str,
    pub display_name: &'a str,
    pub key_generation: u64,
    pub pairing_nonce: &'a str,
    pub verification_code: &'a str,
    pub verification_code_hash: &'a str,
    pub encryption_public_key: &'a str,
    pub signing_public_key: &'a str,
    pub encryption_private_key: [u8; 32],
    pub signing_private_key: [u8; 32],
}

trait SyncCredentialBackend: Send + Sync {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<String>>, SyncKeyStoreError>;
    fn write(&self, account: &str, value: &str) -> Result<(), SyncKeyStoreError>;
    fn delete(&self, account: &str) -> Result<(), SyncKeyStoreError>;
}

#[derive(Clone, Copy)]
struct KeyringSyncCredentialBackend;

impl SyncCredentialBackend for KeyringSyncCredentialBackend {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<String>>, SyncKeyStoreError> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(map_keyring_error)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(map_keyring_error(error)),
        }
    }

    fn write(&self, account: &str, value: &str) -> Result<(), SyncKeyStoreError> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(map_keyring_error)?;
        entry.set_password(value).map_err(map_keyring_error)
    }

    fn delete(&self, account: &str) -> Result<(), SyncKeyStoreError> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(map_keyring_error)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(map_keyring_error(error)),
        }
    }
}

pub(crate) struct SystemSyncKeyStore {
    backend: Arc<dyn SyncCredentialBackend>,
    operation_lock: Mutex<()>,
}

#[derive(Zeroize, ZeroizeOnDrop)]
pub(crate) struct CommittedSyncKeyBundle {
    pub cloud_account_id: String,
    pub device_id: String,
    pub key_generation: u8,
    pub amk: [u8; 32],
    pub encryption_private_key: [u8; 32],
    pub signing_private_key: [u8; 32],
}

#[derive(Zeroize, ZeroizeOnDrop)]
pub(crate) struct PendingSyncKeyBundle {
    pub cloud_account_id: String,
    pub device_id: String,
    pub initialization_id: String,
    pub identity_binding_sha256: String,
    pub key_generation: u8,
    pub amk: [u8; 32],
    pub encryption_private_key: [u8; 32],
    pub signing_private_key: [u8; 32],
}

#[derive(Zeroize, ZeroizeOnDrop)]
pub(crate) struct PendingDeviceAuthorizationBundle {
    pub cloud_account_id: String,
    pub identity_binding_sha256: String,
    pub request_id: String,
    pub device_id: String,
    pub display_name: String,
    pub key_generation: u64,
    pub pairing_nonce: String,
    pub verification_code: String,
    pub verification_code_hash: String,
    pub encryption_public_key: String,
    pub signing_public_key: String,
    pub encryption_private_key: [u8; 32],
    pub signing_private_key: [u8; 32],
}

impl PendingDeviceAuthorizationBundle {
    pub(crate) fn from_input(input: PendingDeviceAuthorizationInput<'_>) -> Self {
        Self {
            cloud_account_id: input.cloud_account_id.to_string(),
            identity_binding_sha256: input.identity_binding_sha256.to_string(),
            request_id: input.request_id.to_string(),
            device_id: input.device_id.to_string(),
            display_name: input.display_name.to_string(),
            key_generation: input.key_generation,
            pairing_nonce: input.pairing_nonce.to_string(),
            verification_code: input.verification_code.to_string(),
            verification_code_hash: input.verification_code_hash.to_string(),
            encryption_public_key: input.encryption_public_key.to_string(),
            signing_public_key: input.signing_public_key.to_string(),
            encryption_private_key: input.encryption_private_key,
            signing_private_key: input.signing_private_key,
        }
    }
}

impl SystemSyncKeyStore {
    pub(crate) fn new() -> Self {
        Self {
            backend: Arc::new(KeyringSyncCredentialBackend),
            operation_lock: Mutex::new(()),
        }
    }

    pub(crate) fn read_committed(
        &self,
        cloud_account_id: &str,
    ) -> Result<Option<CommittedSyncKeyBundle>, SyncKeyStoreError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SyncKeyStoreError::Unavailable)?;
        let account = committed_keychain_account(cloud_account_id);
        let Some(payload) = self.backend.read(&account)? else {
            return Ok(None);
        };
        let record = decode_record(&payload)?;
        if record.record_state != SyncKeyRecordState::Committed
            || record.cloud_account_id != cloud_account_id
        {
            return Err(SyncKeyStoreError::Corrupted);
        }
        Ok(Some(CommittedSyncKeyBundle {
            cloud_account_id: record.cloud_account_id.clone(),
            device_id: record.device_id.clone(),
            key_generation: record.key_generation,
            amk: decode_key_field(&record.amk)?,
            encryption_private_key: decode_key_field(&record.encryption_private_key)?,
            signing_private_key: decode_key_field(&record.signing_private_key)?,
        }))
    }

    pub(crate) fn read_pending(
        &self,
        cloud_account_id: &str,
        initialization_id: &str,
    ) -> Result<Option<PendingSyncKeyBundle>, SyncKeyStoreError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SyncKeyStoreError::Unavailable)?;
        let account = pending_keychain_account(cloud_account_id, initialization_id);
        let Some(payload) = self.backend.read(&account)? else {
            return Ok(None);
        };
        let record = decode_record(&payload)?;
        if record.record_state != SyncKeyRecordState::Pending
            || record.cloud_account_id != cloud_account_id
            || record.initialization_id != initialization_id
        {
            return Err(SyncKeyStoreError::Corrupted);
        }
        Ok(Some(PendingSyncKeyBundle {
            cloud_account_id: record.cloud_account_id.clone(),
            device_id: record.device_id.clone(),
            initialization_id: record.initialization_id.clone(),
            identity_binding_sha256: record.identity_binding_sha256.clone(),
            key_generation: record.key_generation,
            amk: decode_key_field(&record.amk)?,
            encryption_private_key: decode_key_field(&record.encryption_private_key)?,
            signing_private_key: decode_key_field(&record.signing_private_key)?,
        }))
    }

    /// Stages key material under an initialization-specific account. This must never write the
    /// committed account, because Cloud has not accepted the initialization yet.
    pub(crate) fn stage_verified(
        &self,
        input: SyncKeyBundleInput<'_>,
    ) -> Result<(), SyncKeyStoreError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SyncKeyStoreError::Unavailable)?;
        let account = pending_keychain_account(input.cloud_account_id, input.initialization_id);
        let record = bundle_from_input(input, SyncKeyRecordState::Pending);
        let payload = encode_record(&record)?;

        if let Some(existing) = self.backend.read(&account)? {
            let mut decoded = decode_record(&existing)?;
            if decoded.record_state != SyncKeyRecordState::Pending {
                return Err(SyncKeyStoreError::Corrupted);
            }
            decoded.record_state = SyncKeyRecordState::Pending;
            let canonical = encode_record(&decoded)?;
            if !constant_time_eq(&canonical, &payload) {
                return Err(SyncKeyStoreError::Conflict);
            }
            return Ok(());
        }

        self.write_verified(&account, &payload)
    }

    /// Promotes exactly one staged initialization to the committed account. A committed bundle
    /// from another initialization is never overwritten.
    pub(crate) fn commit_pending(
        &self,
        input: SyncKeyBundleInput<'_>,
    ) -> Result<(), SyncKeyStoreError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SyncKeyStoreError::Unavailable)?;
        let pending_account =
            pending_keychain_account(input.cloud_account_id, input.initialization_id);
        let pending_payload = self
            .backend
            .read(&pending_account)?
            .ok_or(SyncKeyStoreError::Corrupted)?;
        let mut decoded_pending = decode_record(&pending_payload)?;
        if decoded_pending.record_state != SyncKeyRecordState::Pending {
            return Err(SyncKeyStoreError::Corrupted);
        }
        decoded_pending.record_state = SyncKeyRecordState::Pending;
        let canonical_pending = encode_record(&decoded_pending)?;

        let mut expected = bundle_from_input(input, SyncKeyRecordState::Pending);
        let expected_pending = encode_record(&expected)?;
        if !constant_time_eq(&canonical_pending, &expected_pending) {
            return Err(SyncKeyStoreError::Conflict);
        }

        expected.record_state = SyncKeyRecordState::Committed;
        let committed_payload = encode_record(&expected)?;
        let committed_account = committed_keychain_account(expected.cloud_account_id.as_str());
        match self.backend.read(&committed_account)? {
            Some(existing) => {
                let mut decoded = decode_record(&existing)?;
                if decoded.record_state != SyncKeyRecordState::Committed {
                    return Err(SyncKeyStoreError::Corrupted);
                }
                decoded.record_state = SyncKeyRecordState::Committed;
                let canonical = encode_record(&decoded)?;
                if !constant_time_eq(&canonical, &committed_payload) {
                    return Err(SyncKeyStoreError::Conflict);
                }
            }
            None => self.write_verified(&committed_account, &committed_payload)?,
        }

        self.delete_verified_absent(&pending_account)
    }

    pub(crate) fn discard_pending(
        &self,
        cloud_account_id: &str,
        initialization_id: &str,
    ) -> Result<(), SyncKeyStoreError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SyncKeyStoreError::Unavailable)?;
        let account = pending_keychain_account(cloud_account_id, initialization_id);
        let Some(payload) = self.backend.read(&account)? else {
            return Ok(());
        };
        let pending = decode_record(&payload)?;
        if pending.record_state != SyncKeyRecordState::Pending
            || pending.cloud_account_id != cloud_account_id
            || pending.initialization_id != initialization_id
        {
            return Err(SyncKeyStoreError::Corrupted);
        }
        self.delete_verified_absent(&account)
    }

    pub(crate) fn read_pending_device_authorization(
        &self,
        cloud_account_id: &str,
    ) -> Result<Option<PendingDeviceAuthorizationBundle>, SyncKeyStoreError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SyncKeyStoreError::Unavailable)?;
        let account = pending_authorization_keychain_account(cloud_account_id);
        let Some(payload) = self.backend.read(&account)? else {
            return Ok(None);
        };
        let record = decode_pending_authorization_record(&payload)?;
        if record.cloud_account_id != cloud_account_id {
            return Err(SyncKeyStoreError::Corrupted);
        }
        Ok(Some(pending_bundle_from_record(record)?))
    }

    pub(crate) fn stage_device_authorization(
        &self,
        bundle: &PendingDeviceAuthorizationBundle,
    ) -> Result<(), SyncKeyStoreError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SyncKeyStoreError::Unavailable)?;
        let account = pending_authorization_keychain_account(&bundle.cloud_account_id);
        let record = pending_authorization_record_from_bundle(bundle);
        let payload = encode_pending_authorization_record(&record)?;
        if let Some(existing) = self.backend.read(&account)? {
            let decoded = decode_pending_authorization_record(&existing)?;
            let canonical = encode_pending_authorization_record(&decoded)?;
            if !constant_time_eq(&canonical, &payload) {
                return Err(SyncKeyStoreError::Conflict);
            }
            return Ok(());
        }
        self.write_verified(&account, &payload)
    }

    pub(crate) fn discard_device_authorization(
        &self,
        cloud_account_id: &str,
    ) -> Result<(), SyncKeyStoreError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SyncKeyStoreError::Unavailable)?;
        let account = pending_authorization_keychain_account(cloud_account_id);
        self.delete_verified_absent(&account)
    }

    pub(crate) fn discard_committed(
        &self,
        cloud_account_id: &str,
    ) -> Result<(), SyncKeyStoreError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SyncKeyStoreError::Unavailable)?;
        let account = committed_keychain_account(cloud_account_id);
        self.delete_verified_absent(&account)
    }

    /// Promotes an authorized device envelope into the committed device key record. The pending
    /// authorization material is retained until the committed record has been verified.
    pub(crate) fn commit_device_authorization(
        &self,
        pending: &PendingDeviceAuthorizationBundle,
        amk: [u8; 32],
    ) -> Result<(), SyncKeyStoreError> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| SyncKeyStoreError::Unavailable)?;
        let pending_account = pending_authorization_keychain_account(&pending.cloud_account_id);
        let payload = self
            .backend
            .read(&pending_account)?
            .ok_or(SyncKeyStoreError::Corrupted)?;
        let decoded = decode_pending_authorization_record(&payload)?;
        let canonical = encode_pending_authorization_record(&decoded)?;
        if !constant_time_eq(&canonical, &payload)
            || decoded.request_id != pending.request_id
            || decoded.device_id != pending.device_id
            || decoded.key_generation != pending.key_generation
        {
            return Err(SyncKeyStoreError::Conflict);
        }

        let keys = SyncKeyMaterial {
            amk,
            encryption_private_key: pending.encryption_private_key,
            signing_private_key: pending.signing_private_key,
        };
        let input = SyncKeyBundleInput {
            cloud_account_id: &pending.cloud_account_id,
            device_id: &pending.device_id,
            initialization_id: &pending.request_id,
            identity_binding_sha256: &pending.identity_binding_sha256,
            keys: &keys,
        };
        let committed_account = committed_keychain_account(&pending.cloud_account_id);
        let record = bundle_from_input(input, SyncKeyRecordState::Committed);
        let committed_payload = encode_record(&record)?;
        match self.backend.read(&committed_account)? {
            Some(existing) => {
                let decoded = decode_record(&existing)?;
                if decoded.record_state != SyncKeyRecordState::Committed
                    || !constant_time_eq(&encode_record(&decoded)?, &committed_payload)
                {
                    return Err(SyncKeyStoreError::Conflict);
                }
            }
            None => self.write_verified(&committed_account, &committed_payload)?,
        }
        self.delete_verified_absent(&pending_account)
    }

    fn write_verified(&self, account: &str, payload: &str) -> Result<(), SyncKeyStoreError> {
        if payload.len() > MAX_RECORD_BYTES {
            return Err(SyncKeyStoreError::TooLarge);
        }
        self.backend.write(account, payload)?;
        let persisted = self
            .backend
            .read(account)?
            .ok_or(SyncKeyStoreError::Corrupted)?;
        if !constant_time_eq(&persisted, payload) {
            return Err(SyncKeyStoreError::Corrupted);
        }
        Ok(())
    }

    fn delete_verified_absent(&self, account: &str) -> Result<(), SyncKeyStoreError> {
        self.backend.delete(account)?;
        if self.backend.read(account)?.is_some() {
            return Err(SyncKeyStoreError::Corrupted);
        }
        Ok(())
    }
}

fn bundle_from_input(
    input: SyncKeyBundleInput<'_>,
    record_state: SyncKeyRecordState,
) -> SyncKeyBundleV1 {
    SyncKeyBundleV1 {
        version: RECORD_VERSION,
        record_state,
        cloud_account_id: input.cloud_account_id.to_string(),
        device_id: input.device_id.to_string(),
        initialization_id: input.initialization_id.to_string(),
        identity_binding_sha256: input.identity_binding_sha256.to_string(),
        key_generation: 1,
        amk: URL_SAFE_NO_PAD.encode(input.keys.amk),
        encryption_private_key: URL_SAFE_NO_PAD.encode(input.keys.encryption_private_key),
        signing_private_key: URL_SAFE_NO_PAD.encode(input.keys.signing_private_key),
    }
}

fn encode_record(value: &SyncKeyBundleV1) -> Result<Zeroizing<String>, SyncKeyStoreError> {
    let payload =
        Zeroizing::new(serde_json::to_string(value).map_err(|_| SyncKeyStoreError::Corrupted)?);
    if payload.len() > MAX_RECORD_BYTES {
        return Err(SyncKeyStoreError::TooLarge);
    }
    Ok(payload)
}

fn decode_record(value: &str) -> Result<SyncKeyBundleV1, SyncKeyStoreError> {
    let decoded: SyncKeyBundleV1 =
        serde_json::from_str(value).map_err(|_| SyncKeyStoreError::Corrupted)?;
    if decoded.version != RECORD_VERSION || decoded.key_generation != 1 {
        return Err(SyncKeyStoreError::Corrupted);
    }
    Ok(decoded)
}

fn pending_authorization_record_from_bundle(
    bundle: &PendingDeviceAuthorizationBundle,
) -> PendingDeviceAuthorizationRecordV1 {
    PendingDeviceAuthorizationRecordV1 {
        version: RECORD_VERSION,
        cloud_account_id: bundle.cloud_account_id.clone(),
        identity_binding_sha256: bundle.identity_binding_sha256.clone(),
        request_id: bundle.request_id.clone(),
        device_id: bundle.device_id.clone(),
        display_name: bundle.display_name.clone(),
        key_generation: bundle.key_generation,
        pairing_nonce: bundle.pairing_nonce.clone(),
        verification_code: bundle.verification_code.clone(),
        verification_code_hash: bundle.verification_code_hash.clone(),
        encryption_public_key: bundle.encryption_public_key.clone(),
        signing_public_key: bundle.signing_public_key.clone(),
        encryption_private_key: URL_SAFE_NO_PAD.encode(bundle.encryption_private_key),
        signing_private_key: URL_SAFE_NO_PAD.encode(bundle.signing_private_key),
    }
}

fn encode_pending_authorization_record(
    value: &PendingDeviceAuthorizationRecordV1,
) -> Result<Zeroizing<String>, SyncKeyStoreError> {
    let payload =
        Zeroizing::new(serde_json::to_string(value).map_err(|_| SyncKeyStoreError::Corrupted)?);
    if payload.len() > MAX_RECORD_BYTES {
        return Err(SyncKeyStoreError::TooLarge);
    }
    Ok(payload)
}

fn decode_pending_authorization_record(
    value: &str,
) -> Result<PendingDeviceAuthorizationRecordV1, SyncKeyStoreError> {
    let decoded: PendingDeviceAuthorizationRecordV1 =
        serde_json::from_str(value).map_err(|_| SyncKeyStoreError::Corrupted)?;
    if decoded.version != RECORD_VERSION {
        return Err(SyncKeyStoreError::Corrupted);
    }
    Ok(decoded)
}

fn pending_bundle_from_record(
    record: PendingDeviceAuthorizationRecordV1,
) -> Result<PendingDeviceAuthorizationBundle, SyncKeyStoreError> {
    let encryption_private_key = decode_key_field(&record.encryption_private_key)?;
    let signing_private_key = decode_key_field(&record.signing_private_key)?;
    Ok(PendingDeviceAuthorizationBundle {
        cloud_account_id: record.cloud_account_id.clone(),
        identity_binding_sha256: record.identity_binding_sha256.clone(),
        request_id: record.request_id.clone(),
        device_id: record.device_id.clone(),
        display_name: record.display_name.clone(),
        key_generation: record.key_generation,
        pairing_nonce: record.pairing_nonce.clone(),
        verification_code: record.verification_code.clone(),
        verification_code_hash: record.verification_code_hash.clone(),
        encryption_public_key: record.encryption_public_key.clone(),
        signing_public_key: record.signing_public_key.clone(),
        encryption_private_key,
        signing_private_key,
    })
}

fn decode_key_field(value: &str) -> Result<[u8; 32], SyncKeyStoreError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| SyncKeyStoreError::Corrupted)?;
    decoded.try_into().map_err(|_| SyncKeyStoreError::Corrupted)
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    bool::from(left.as_bytes().ct_eq(right.as_bytes()))
}

fn committed_keychain_account(cloud_account_id: &str) -> String {
    format!("device-key-bundle:{cloud_account_id}")
}

fn pending_keychain_account(cloud_account_id: &str, initialization_id: &str) -> String {
    format!("pending-device-key-bundle:{cloud_account_id}:{initialization_id}")
}

fn pending_authorization_keychain_account(cloud_account_id: &str) -> String {
    format!("pending-device-authorization:{cloud_account_id}")
}

fn map_keyring_error(error: keyring::Error) -> SyncKeyStoreError {
    match error {
        keyring::Error::TooLong(_, _) => SyncKeyStoreError::TooLarge,
        keyring::Error::BadEncoding(_)
        | keyring::Error::BadDataFormat(_, _)
        | keyring::Error::BadStoreFormat(_)
        | keyring::Error::Ambiguous(_) => SyncKeyStoreError::Corrupted,
        _ => SyncKeyStoreError::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    use zeroize::Zeroizing;

    use super::{
        committed_keychain_account, pending_authorization_keychain_account,
        pending_keychain_account, PendingDeviceAuthorizationInput, SyncCredentialBackend,
        SyncKeyBundleInput, SyncKeyStoreError, SystemSyncKeyStore, KEYCHAIN_SERVICE,
        MAX_RECORD_BYTES,
    };
    use crate::cloud::sync_crypto::SyncKeyMaterial;

    #[derive(Default)]
    struct MemoryBackend {
        items: Mutex<HashMap<String, String>>,
    }

    impl SyncCredentialBackend for MemoryBackend {
        fn read(&self, account: &str) -> Result<Option<Zeroizing<String>>, SyncKeyStoreError> {
            Ok(self
                .items
                .lock()
                .expect("memory backend lock")
                .get(account)
                .cloned()
                .map(Zeroizing::new))
        }

        fn write(&self, account: &str, value: &str) -> Result<(), SyncKeyStoreError> {
            self.items
                .lock()
                .expect("memory backend lock")
                .insert(account.to_string(), value.to_string());
            Ok(())
        }

        fn delete(&self, account: &str) -> Result<(), SyncKeyStoreError> {
            self.items
                .lock()
                .expect("memory backend lock")
                .remove(account);
            Ok(())
        }
    }

    fn store(backend: Arc<MemoryBackend>) -> SystemSyncKeyStore {
        SystemSyncKeyStore {
            backend,
            operation_lock: Mutex::new(()),
        }
    }

    fn keys(fill: u8) -> SyncKeyMaterial {
        SyncKeyMaterial {
            amk: [fill; 32],
            encryption_private_key: [fill.wrapping_add(1); 32],
            signing_private_key: [fill.wrapping_add(2); 32],
        }
    }

    fn input<'a>(
        initialization_id: &'a str,
        device_id: &'a str,
        keys: &'a SyncKeyMaterial,
    ) -> SyncKeyBundleInput<'a> {
        SyncKeyBundleInput {
            cloud_account_id: "cloud-account",
            device_id,
            initialization_id,
            identity_binding_sha256: "identity-binding",
            keys,
        }
    }

    #[test]
    fn keychain_namespace_separates_pending_and_committed_records() {
        assert!(KEYCHAIN_SERVICE.starts_with("NexusPilot.Sync."));
        assert_eq!(
            committed_keychain_account("cloud-account"),
            "device-key-bundle:cloud-account"
        );
        assert_eq!(
            pending_keychain_account("cloud-account", "initialization"),
            "pending-device-key-bundle:cloud-account:initialization"
        );
        assert!(MAX_RECORD_BYTES <= 2_048);
    }

    #[test]
    fn a_second_pending_initialization_never_overwrites_the_committed_bundle() {
        let backend = Arc::new(MemoryBackend::default());
        let store = store(backend.clone());
        let first_keys = keys(1);
        store
            .stage_verified(input("initialization-a", "device-a", &first_keys))
            .expect("first pending bundle should stage");
        store
            .commit_pending(input("initialization-a", "device-a", &first_keys))
            .expect("first pending bundle should commit");

        let committed_account = committed_keychain_account("cloud-account");
        let committed_before = backend
            .read(&committed_account)
            .expect("committed read")
            .expect("committed value");
        let second_keys = keys(9);
        store
            .stage_verified(input("initialization-b", "device-b", &second_keys))
            .expect("second initialization should use its own pending account");

        assert_eq!(
            store.commit_pending(input("initialization-b", "device-b", &second_keys)),
            Err(SyncKeyStoreError::Conflict)
        );
        let committed_after = backend
            .read(&committed_account)
            .expect("committed read")
            .expect("committed value");
        assert_eq!(committed_before.as_str(), committed_after.as_str());
        assert!(backend
            .read(&pending_keychain_account(
                "cloud-account",
                "initialization-b"
            ))
            .expect("pending read")
            .is_some());
    }

    #[test]
    fn deterministic_rejection_can_discard_only_its_pending_bundle() {
        let backend = Arc::new(MemoryBackend::default());
        let store = store(backend.clone());
        let material = keys(4);
        store
            .stage_verified(input("initialization", "device", &material))
            .expect("pending bundle should stage");
        store
            .discard_pending("cloud-account", "initialization")
            .expect("pending bundle should be discarded");

        assert!(backend
            .read(&pending_keychain_account("cloud-account", "initialization"))
            .expect("pending read")
            .is_none());
        assert!(backend
            .read(&committed_keychain_account("cloud-account"))
            .expect("committed read")
            .is_none());
    }

    #[test]
    fn pending_device_authorization_round_trips_without_touching_committed_keys() {
        let backend = Arc::new(MemoryBackend::default());
        let store = store(backend.clone());
        let encryption_private_key = [7_u8; 32];
        let signing_private_key = [8_u8; 32];
        let pending =
            super::PendingDeviceAuthorizationBundle::from_input(PendingDeviceAuthorizationInput {
                cloud_account_id: "cloud-account",
                identity_binding_sha256: "identity",
                request_id: "request",
                device_id: "device",
                display_name: "DESKTOP-01",
                key_generation: 1,
                pairing_nonce: "nonce",
                verification_code: "F7KM82QPV4ND",
                verification_code_hash: "hash",
                encryption_public_key: "encryption-public",
                signing_public_key: "signing-public",
                encryption_private_key,
                signing_private_key,
            });

        store
            .stage_device_authorization(&pending)
            .expect("pending authorization should stage");
        let loaded = store
            .read_pending_device_authorization("cloud-account")
            .expect("pending authorization should read")
            .expect("pending authorization should exist");
        assert_eq!(loaded.request_id, "request");
        assert_eq!(loaded.device_id, "device");
        assert_eq!(loaded.encryption_private_key, encryption_private_key);
        assert_eq!(loaded.signing_private_key, signing_private_key);
        assert!(backend
            .read(&pending_authorization_keychain_account("cloud-account"))
            .expect("pending keychain read")
            .is_some());
        assert!(backend
            .read(&committed_keychain_account("cloud-account"))
            .expect("committed keychain read")
            .is_none());

        store
            .discard_device_authorization("cloud-account")
            .expect("pending authorization should discard");
        assert!(store
            .read_pending_device_authorization("cloud-account")
            .expect("pending authorization should read")
            .is_none());
    }
}
