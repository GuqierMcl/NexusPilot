use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::SigningKey;
use hpke::{kem::X25519HkdfSha256, Kem, Serializable};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::Zeroizing;

use super::{
    sync_key_store::{PendingDeviceAuthorizationBundle, PendingDeviceAuthorizationInput},
    types::{CreateCloudDeviceAuthorizationDevice, CreateCloudDeviceAuthorizationRequest},
};

const BINDING_DOMAIN: &str = "NexusPilot.Cloud.DeviceAuthorizationCode.v1";
const CODE_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

pub(crate) fn prepare(
    cloud_account_id: &str,
    identity_binding_sha256: &str,
    key_generation: u64,
    display_name: &str,
) -> Result<PendingDeviceAuthorizationBundle, DeviceAuthorizationError> {
    let request_id = Uuid::new_v4().to_string();
    let device_id = Uuid::new_v4().to_string();
    let pairing_nonce = random_base64(32)?;
    let verification_code = random_verification_code()?;
    let (encryption_private_key, encryption_public_key) = X25519HkdfSha256::gen_keypair();
    let signing_seed = Zeroizing::new(random_bytes::<32>()?);
    let signing_key = SigningKey::from_bytes(&signing_seed);

    let encryption_private_key = encryption_private_key.to_bytes();
    let encryption_public_key = URL_SAFE_NO_PAD.encode(encryption_public_key.to_bytes());
    let signing_public_key = URL_SAFE_NO_PAD.encode(signing_key.verifying_key().to_bytes());
    let verification_code_hash = compute_binding_hash(
        cloud_account_id,
        &request_id,
        &device_id,
        key_generation,
        &encryption_public_key,
        &signing_public_key,
        &pairing_nonce,
        1,
        &verification_code,
    )?;

    Ok(PendingDeviceAuthorizationBundle::from_input(
        PendingDeviceAuthorizationInput {
            cloud_account_id,
            identity_binding_sha256,
            request_id: &request_id,
            device_id: &device_id,
            display_name,
            key_generation,
            pairing_nonce: &pairing_nonce,
            verification_code: &verification_code,
            verification_code_hash: &verification_code_hash,
            encryption_public_key: &encryption_public_key,
            signing_public_key: &signing_public_key,
            encryption_private_key: encryption_private_key.into(),
            signing_private_key: signing_key.to_bytes(),
        },
    ))
}

pub(crate) fn create_request(
    pending: &PendingDeviceAuthorizationBundle,
) -> CreateCloudDeviceAuthorizationRequest {
    CreateCloudDeviceAuthorizationRequest {
        request_id: pending.request_id.clone(),
        key_generation: pending.key_generation,
        device: CreateCloudDeviceAuthorizationDevice {
            id: pending.device_id.clone(),
            display_name: pending.display_name.clone(),
            encryption_public_key: pending.encryption_public_key.clone(),
            signing_public_key: pending.signing_public_key.clone(),
        },
        pairing_nonce: pending.pairing_nonce.clone(),
        verification_code_hash: pending.verification_code_hash.clone(),
    }
}

pub(crate) fn format_verification_code(value: &str) -> String {
    value
        .as_bytes()
        .chunks(4)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or_default())
        .collect::<Vec<_>>()
        .join("-")
}

pub(crate) fn compute_binding_hash(
    account_id: &str,
    request_id: &str,
    device_id: &str,
    key_generation: u64,
    encryption_public_key: &str,
    signing_public_key: &str,
    pairing_nonce: &str,
    code_version: u64,
    verification_code: &str,
) -> Result<String, DeviceAuthorizationError> {
    let fields = [
        BINDING_DOMAIN.to_string(),
        account_id.to_string(),
        request_id.to_string(),
        device_id.to_string(),
        key_generation.to_string(),
        encryption_public_key.to_string(),
        signing_public_key.to_string(),
        pairing_nonce.to_string(),
        code_version.to_string(),
        verification_code.to_string(),
    ];
    if fields
        .iter()
        .any(|field| field.is_empty() || field.len() > 512)
    {
        return Err(DeviceAuthorizationError::InvalidContext);
    }
    let mut hasher = Sha256::new();
    for field in fields {
        let bytes = field.as_bytes();
        let length =
            u32::try_from(bytes.len()).map_err(|_| DeviceAuthorizationError::InvalidContext)?;
        hasher.update(length.to_be_bytes());
        hasher.update(bytes);
    }
    Ok(URL_SAFE_NO_PAD.encode(hasher.finalize()))
}

fn random_verification_code() -> Result<String, DeviceAuthorizationError> {
    let mut random = [0_u8; 12];
    getrandom::fill(&mut random).map_err(|_| DeviceAuthorizationError::RandomUnavailable)?;
    Ok(random
        .iter()
        .map(|value| CODE_ALPHABET[usize::from(value & 31)] as char)
        .collect())
}

fn random_base64(length: usize) -> Result<String, DeviceAuthorizationError> {
    let mut bytes = vec![0_u8; length];
    getrandom::fill(&mut bytes).map_err(|_| DeviceAuthorizationError::RandomUnavailable)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn random_bytes<const N: usize>() -> Result<[u8; N], DeviceAuthorizationError> {
    let mut bytes = [0_u8; N];
    getrandom::fill(&mut bytes).map_err(|_| DeviceAuthorizationError::RandomUnavailable)?;
    Ok(bytes)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DeviceAuthorizationError {
    RandomUnavailable,
    InvalidContext,
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;

    use super::{compute_binding_hash, format_verification_code, prepare};

    #[test]
    fn computes_the_same_binding_hash_as_cloud_v1() {
        let hash = compute_binding_hash(
            "0198f5dc-0000-7000-8000-000000000001",
            "0198f5dc-0000-7000-8000-000000000002",
            "0198f5dc-0000-7000-8000-000000000003",
            1,
            &base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([1_u8; 32]),
            &base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([2_u8; 32]),
            &base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([3_u8; 32]),
            1,
            "F7KM82QPV4ND",
        )
        .expect("binding hash");
        assert_eq!(hash, "acVEtPGWNFv5c-iVoEac9jmnANrOqVbRe196_HPh5nU");
    }

    #[test]
    fn prepares_a_pending_request_without_amk_or_recovery_material() {
        let pending = prepare("account", "identity", 1, "DESKTOP-01").expect("prepare");
        assert_eq!(pending.request_id.len(), 36);
        assert_eq!(pending.verification_code.len(), 12);
        assert_eq!(
            format_verification_code(&pending.verification_code).len(),
            14
        );
        assert_eq!(pending.encryption_private_key.len(), 32);
        assert_eq!(pending.signing_private_key.len(), 32);
    }
}
