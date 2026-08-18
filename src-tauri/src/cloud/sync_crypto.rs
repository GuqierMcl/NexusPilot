use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use bech32::{Bech32m, Hrp};
use chacha20poly1305::{
    aead::{Aead, Payload},
    KeyInit, XChaCha20Poly1305, XNonce,
};
use ed25519_dalek::SigningKey;
use hkdf::Hkdf;
use hpke::{
    aead::ChaCha20Poly1305, kdf::HkdfSha256, kem::X25519HkdfSha256, setup_sender, Deserializable,
    Kem as _, OpModeR, OpModeS, Serializable,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use super::types::{
    CloudConnectionAssetEncryption, CloudDeviceKeyEnvelope, CloudRecoveryEnvelope,
    CreateCloudDeviceAuthorizationDevice, InitializeCloudSyncDevice, InitializeCloudSyncRequest,
};

const DEVICE_SUITE: &str = "HPKE-X25519-HKDF-SHA256-CHACHA20POLY1305";
const RECOVERY_SUITE: &str = "XCHACHA20POLY1305-HKDF-SHA256";
const HPKE_INFO: &[u8] = b"NexusPilot/Cloud/device-envelope/v1";
const RECOVERY_KDF_INFO: &[u8] = b"NexusPilot/Cloud/recovery-envelope-key/v1";
const RECOVERY_AUTH_INFO: &[u8] = b"NexusPilot/Cloud/recovery-auth-key/v1";
#[allow(dead_code)]
pub(crate) const CONNECTION_ASSET_SUITE: &str = "XCHACHA20-POLY1305";
#[allow(dead_code)]
const CONNECTION_ASSET_AAD_PURPOSE: &str = "NexusPilot.ConnectionAsset.v1";

pub(crate) fn recovery_auth_signing_key(
    recovery_secret: &[u8; 32],
) -> Result<SigningKey, SyncCryptoError> {
    let hkdf = Hkdf::<Sha256>::new(None, recovery_secret);
    let mut seed = [0_u8; 32];
    hkdf.expand(RECOVERY_AUTH_INFO, &mut seed)
        .map_err(|_| SyncCryptoError::EncryptionFailed)?;
    Ok(SigningKey::from_bytes(&seed))
}

pub(crate) fn decode_recovery_key(value: &str) -> Result<[u8; 32], SyncCryptoError> {
    let (hrp, bytes) = bech32::decode(value).map_err(|_| SyncCryptoError::EncodingFailed)?;
    if hrp != Hrp::parse("nprk").map_err(|_| SyncCryptoError::EncodingFailed)? || bytes.len() != 32
    {
        return Err(SyncCryptoError::EncodingFailed);
    }
    bytes
        .try_into()
        .map_err(|_| SyncCryptoError::EncodingFailed)
}

pub(crate) struct PreparedRecoveryDevice {
    pub device: CreateCloudDeviceAuthorizationDevice,
    pub keys: SyncKeyMaterial,
}

pub(crate) fn prepare_recovery_device(
    device_name: &str,
    amk: [u8; 32],
) -> Result<PreparedRecoveryDevice, SyncCryptoError> {
    let (encryption_private, encryption_public) = X25519HkdfSha256::gen_keypair();
    let signing_seed = Zeroizing::new(random_bytes::<32>()?);
    let signing_key = SigningKey::from_bytes(&signing_seed);
    let encryption_private_key = encryption_private.to_bytes();
    let device = CreateCloudDeviceAuthorizationDevice {
        id: Uuid::new_v4().to_string(),
        display_name: device_name.to_string(),
        encryption_public_key: encode(encryption_public.to_bytes().as_slice()),
        signing_public_key: encode(signing_key.verifying_key().to_bytes().as_slice()),
    };
    Ok(PreparedRecoveryDevice {
        device,
        keys: SyncKeyMaterial {
            amk,
            encryption_private_key: encryption_private_key.into(),
            signing_private_key: signing_key.to_bytes(),
        },
    })
}

pub(crate) fn recovery_device_from_keys(
    device_id: &str,
    display_name: &str,
    encryption_private_key: &[u8; 32],
    signing_private_key: &[u8; 32],
) -> Result<CreateCloudDeviceAuthorizationDevice, SyncCryptoError> {
    let private = <X25519HkdfSha256 as hpke::Kem>::PrivateKey::from_bytes(encryption_private_key)
        .map_err(|_| SyncCryptoError::EncodingFailed)?;
    let public = X25519HkdfSha256::sk_to_pk(&private);
    let signing = SigningKey::from_bytes(signing_private_key);
    Ok(CreateCloudDeviceAuthorizationDevice {
        id: device_id.to_string(),
        display_name: display_name.to_string(),
        encryption_public_key: encode(public.to_bytes().as_slice()),
        signing_public_key: encode(signing.verifying_key().to_bytes().as_slice()),
    })
}

pub(crate) fn open_recovery_envelope(
    cloud_account_id: &str,
    key_generation: u64,
    recovery_secret: &[u8; 32],
    salt_value: &str,
    nonce_value: &str,
    ciphertext_value: &str,
) -> Result<[u8; 32], SyncCryptoError> {
    if key_generation > u64::from(u8::MAX) {
        return Err(SyncCryptoError::EncodingFailed);
    }
    let salt = URL_SAFE_NO_PAD
        .decode(salt_value)
        .map_err(|_| SyncCryptoError::EncodingFailed)?;
    let nonce = URL_SAFE_NO_PAD
        .decode(nonce_value)
        .map_err(|_| SyncCryptoError::EncodingFailed)?;
    let ciphertext = URL_SAFE_NO_PAD
        .decode(ciphertext_value)
        .map_err(|_| SyncCryptoError::EncodingFailed)?;
    if salt.len() != 32 || nonce.len() != 24 || ciphertext.len() != 48 {
        return Err(SyncCryptoError::EncodingFailed);
    }
    let aad = recovery_envelope_aad(cloud_account_id, key_generation as u8)?;
    let hkdf = Hkdf::<Sha256>::new(Some(&salt), recovery_secret);
    let mut key = [0_u8; 32];
    hkdf.expand(RECOVERY_KDF_INFO, &mut key)
        .map_err(|_| SyncCryptoError::EncryptionFailed)?;
    let plaintext = XChaCha20Poly1305::new((&key).into())
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| SyncCryptoError::EncryptionFailed)?;
    plaintext
        .try_into()
        .map_err(|_| SyncCryptoError::EncodingFailed)
}

pub(crate) fn wrap_device_envelope(
    cloud_account_id: &str,
    device_id: &str,
    key_generation: u64,
    encryption_public_key: &str,
    amk: &[u8; 32],
) -> Result<CloudDeviceKeyEnvelope, SyncCryptoError> {
    let public_bytes = URL_SAFE_NO_PAD
        .decode(encryption_public_key)
        .map_err(|_| SyncCryptoError::EncodingFailed)?;
    if public_bytes.len() != 32 || key_generation > u64::from(u8::MAX) {
        return Err(SyncCryptoError::EncodingFailed);
    }
    let public_key = <X25519HkdfSha256 as hpke::Kem>::PublicKey::from_bytes(&public_bytes)
        .map_err(|_| SyncCryptoError::EncodingFailed)?;
    let aad = device_envelope_aad(
        cloud_account_id,
        device_id,
        key_generation as u8,
        &public_bytes,
    )?;
    let (encapsulated_key, mut context) = setup_sender::<
        ChaCha20Poly1305,
        HkdfSha256,
        X25519HkdfSha256,
    >(&OpModeS::Base, &public_key, HPKE_INFO)
    .map_err(|_| SyncCryptoError::EncryptionFailed)?;
    let ciphertext = context
        .seal(amk, &aad)
        .map_err(|_| SyncCryptoError::EncryptionFailed)?;
    Ok(CloudDeviceKeyEnvelope {
        format_version: 1,
        suite: DEVICE_SUITE.to_string(),
        encapsulated_key: encode(encapsulated_key.to_bytes().as_slice()),
        ciphertext: encode(&ciphertext),
    })
}

pub(crate) fn open_device_envelope(
    cloud_account_id: &str,
    device_id: &str,
    key_generation: u64,
    encryption_public_key: &str,
    encryption_private_key: &[u8; 32],
    envelope: &CloudDeviceKeyEnvelope,
) -> Result<[u8; 32], SyncCryptoError> {
    if envelope.format_version != 1
        || envelope.suite != DEVICE_SUITE
        || key_generation > u64::from(u8::MAX)
    {
        return Err(SyncCryptoError::EncodingFailed);
    }
    let public_bytes = URL_SAFE_NO_PAD
        .decode(encryption_public_key)
        .map_err(|_| SyncCryptoError::EncodingFailed)?;
    let encapsulated = URL_SAFE_NO_PAD
        .decode(&envelope.encapsulated_key)
        .map_err(|_| SyncCryptoError::EncodingFailed)?;
    let ciphertext = URL_SAFE_NO_PAD
        .decode(&envelope.ciphertext)
        .map_err(|_| SyncCryptoError::EncodingFailed)?;
    if public_bytes.len() != 32 || encapsulated.len() != 32 || ciphertext.len() != 48 {
        return Err(SyncCryptoError::EncodingFailed);
    }
    let private_key =
        <X25519HkdfSha256 as hpke::Kem>::PrivateKey::from_bytes(encryption_private_key)
            .map_err(|_| SyncCryptoError::EncodingFailed)?;
    let encapsulated_key = <X25519HkdfSha256 as hpke::Kem>::EncappedKey::from_bytes(&encapsulated)
        .map_err(|_| SyncCryptoError::EncodingFailed)?;
    let aad = device_envelope_aad(
        cloud_account_id,
        device_id,
        key_generation as u8,
        &public_bytes,
    )?;
    let mut context = hpke::setup_receiver::<ChaCha20Poly1305, HkdfSha256, X25519HkdfSha256>(
        &OpModeR::Base,
        &private_key,
        &encapsulated_key,
        HPKE_INFO,
    )
    .map_err(|_| SyncCryptoError::EncryptionFailed)?;
    let plaintext = context
        .open(&ciphertext, &aad)
        .map_err(|_| SyncCryptoError::EncryptionFailed)?;
    plaintext
        .try_into()
        .map_err(|_| SyncCryptoError::EncodingFailed)
}

#[derive(Zeroize, ZeroizeOnDrop)]
pub(crate) struct SyncKeyMaterial {
    pub amk: [u8; 32],
    pub encryption_private_key: [u8; 32],
    pub signing_private_key: [u8; 32],
}

pub(crate) struct PreparedSyncInitialization {
    pub request: InitializeCloudSyncRequest,
    pub keys: SyncKeyMaterial,
    pub recovery_key: String,
}

impl Drop for PreparedSyncInitialization {
    fn drop(&mut self) {
        self.recovery_key.zeroize();
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SyncCryptoError {
    RandomUnavailable,
    EncryptionFailed,
    EncodingFailed,
}

#[allow(dead_code)]
pub(crate) fn encrypt_connection_asset(
    cloud_account_id: &str,
    asset_id: &str,
    asset_type: &str,
    revision: u64,
    schema_version: u16,
    key_generation: u64,
    plaintext: &[u8],
    amk: &[u8; 32],
) -> Result<CloudConnectionAssetEncryption, SyncCryptoError> {
    if revision == 0 || key_generation == 0 || asset_type.is_empty() {
        return Err(SyncCryptoError::EncodingFailed);
    }
    let nonce = random_bytes::<24>()?;
    let aad = connection_asset_aad(
        cloud_account_id,
        asset_id,
        asset_type,
        revision,
        schema_version,
        key_generation,
    );
    let ciphertext = XChaCha20Poly1305::new(amk.into())
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| SyncCryptoError::EncryptionFailed)?;
    Ok(CloudConnectionAssetEncryption {
        suite: CONNECTION_ASSET_SUITE.to_string(),
        nonce: encode(&nonce),
        ciphertext: encode(&ciphertext),
    })
}

#[allow(dead_code)]
pub(crate) fn decrypt_connection_asset(
    cloud_account_id: &str,
    asset_id: &str,
    asset_type: &str,
    revision: u64,
    schema_version: u16,
    key_generation: u64,
    encryption: &CloudConnectionAssetEncryption,
    amk: &[u8; 32],
) -> Result<Vec<u8>, SyncCryptoError> {
    if encryption.suite != CONNECTION_ASSET_SUITE
        || revision == 0
        || key_generation == 0
        || asset_type.is_empty()
    {
        return Err(SyncCryptoError::EncodingFailed);
    }
    let nonce = URL_SAFE_NO_PAD
        .decode(&encryption.nonce)
        .map_err(|_| SyncCryptoError::EncodingFailed)?;
    let ciphertext = URL_SAFE_NO_PAD
        .decode(&encryption.ciphertext)
        .map_err(|_| SyncCryptoError::EncodingFailed)?;
    if nonce.len() != 24 || ciphertext.len() < 16 {
        return Err(SyncCryptoError::EncodingFailed);
    }
    let aad = connection_asset_aad(
        cloud_account_id,
        asset_id,
        asset_type,
        revision,
        schema_version,
        key_generation,
    );
    XChaCha20Poly1305::new(amk.into())
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| SyncCryptoError::EncryptionFailed)
}

#[allow(dead_code)]
fn connection_asset_aad(
    cloud_account_id: &str,
    asset_id: &str,
    asset_type: &str,
    revision: u64,
    schema_version: u16,
    key_generation: u64,
) -> Vec<u8> {
    length_prefixed(&[
        CONNECTION_ASSET_AAD_PURPOSE,
        cloud_account_id,
        asset_id,
        asset_type,
        &revision.to_string(),
        &schema_version.to_string(),
        &key_generation.to_string(),
        CONNECTION_ASSET_SUITE,
    ])
}

pub(crate) fn prepare_initialization(
    cloud_account_id: &str,
    device_id: &str,
    initialization_id: &str,
    device_name: &str,
) -> Result<PreparedSyncInitialization, SyncCryptoError> {
    let amk = Zeroizing::new(random_bytes()?);
    let recovery_secret = Zeroizing::new(random_bytes::<32>()?);
    let (encryption_private, encryption_public) = X25519HkdfSha256::gen_keypair();
    let encryption_private_key = to_array(encryption_private.to_bytes().as_slice())?;
    let encryption_public_key = encryption_public.to_bytes();

    let signing_seed = Zeroizing::new(random_bytes()?);
    let signing_key = SigningKey::from_bytes(&signing_seed);
    let signing_public_key = signing_key.verifying_key().to_bytes();

    let device_aad = device_envelope_aad(
        cloud_account_id,
        device_id,
        1,
        encryption_public_key.as_slice(),
    )?;
    let (encapsulated_key, mut hpke_context) = setup_sender::<
        ChaCha20Poly1305,
        HkdfSha256,
        X25519HkdfSha256,
    >(&OpModeS::Base, &encryption_public, HPKE_INFO)
    .map_err(|_| SyncCryptoError::EncryptionFailed)?;
    let device_ciphertext = hpke_context
        .seal(amk.as_ref(), &device_aad)
        .map_err(|_| SyncCryptoError::EncryptionFailed)?;

    let recovery_aad = recovery_envelope_aad(cloud_account_id, 1)?;
    let recovery_salt = Zeroizing::new(random_bytes::<32>()?);
    let recovery_nonce = Zeroizing::new(random_bytes::<24>()?);
    let hkdf = Hkdf::<Sha256>::new(Some(recovery_salt.as_ref()), recovery_secret.as_ref());
    let mut recovery_encryption_key = Zeroizing::new([0_u8; 32]);
    hkdf.expand(RECOVERY_KDF_INFO, recovery_encryption_key.as_mut())
        .map_err(|_| SyncCryptoError::EncryptionFailed)?;
    let recovery_cipher = XChaCha20Poly1305::new((&*recovery_encryption_key).into());
    let recovery_ciphertext = recovery_cipher
        .encrypt(
            XNonce::from_slice(recovery_nonce.as_ref()),
            Payload {
                msg: amk.as_ref(),
                aad: &recovery_aad,
            },
        )
        .map_err(|_| SyncCryptoError::EncryptionFailed)?;
    let recovery_key = bech32::encode::<Bech32m>(
        Hrp::parse("nprk").map_err(|_| SyncCryptoError::EncodingFailed)?,
        recovery_secret.as_ref(),
    )
    .map_err(|_| SyncCryptoError::EncodingFailed)?;

    let keys = SyncKeyMaterial {
        amk: *amk,
        encryption_private_key,
        signing_private_key: signing_key.to_bytes(),
    };

    let request = InitializeCloudSyncRequest {
        initialization_id: initialization_id.to_string(),
        key_generation: 1,
        device: InitializeCloudSyncDevice {
            id: device_id.to_string(),
            display_name: device_name.to_string(),
            encryption_public_key: encode(encryption_public_key.as_slice()),
            signing_public_key: encode(&signing_public_key),
        },
        device_envelope: CloudDeviceKeyEnvelope {
            format_version: 1,
            suite: DEVICE_SUITE.to_string(),
            encapsulated_key: encode(encapsulated_key.to_bytes().as_slice()),
            ciphertext: encode(&device_ciphertext),
        },
        recovery_envelope: CloudRecoveryEnvelope {
            format_version: 1,
            suite: RECOVERY_SUITE,
            salt: encode(recovery_salt.as_ref()),
            nonce: encode(recovery_nonce.as_ref()),
            ciphertext: encode(&recovery_ciphertext),
        },
        recovery_auth_public_key: encode(
            recovery_auth_signing_key(&recovery_secret)
                .map_err(|_| SyncCryptoError::EncryptionFailed)?
                .verifying_key()
                .as_bytes(),
        ),
    };
    Ok(PreparedSyncInitialization {
        request,
        keys,
        recovery_key,
    })
}

pub(crate) fn prepare_recovery_rotation(
    cloud_account_id: &str,
    key_generation: u64,
    amk: &[u8; 32],
) -> Result<(String, CloudRecoveryEnvelope, String), SyncCryptoError> {
    let generation = u8::try_from(key_generation).map_err(|_| SyncCryptoError::EncodingFailed)?;
    let recovery_secret = Zeroizing::new(random_bytes::<32>()?);
    let salt = Zeroizing::new(random_bytes::<32>()?);
    let nonce = Zeroizing::new(random_bytes::<24>()?);
    let aad = recovery_envelope_aad(cloud_account_id, generation)?;
    let hkdf = Hkdf::<Sha256>::new(Some(salt.as_ref()), recovery_secret.as_ref());
    let mut encryption_key = Zeroizing::new([0_u8; 32]);
    hkdf.expand(RECOVERY_KDF_INFO, encryption_key.as_mut())
        .map_err(|_| SyncCryptoError::EncryptionFailed)?;
    let ciphertext = XChaCha20Poly1305::new((&*encryption_key).into())
        .encrypt(
            XNonce::from_slice(nonce.as_ref()),
            Payload {
                msg: amk,
                aad: &aad,
            },
        )
        .map_err(|_| SyncCryptoError::EncryptionFailed)?;
    let recovery_key = bech32::encode::<Bech32m>(
        Hrp::parse("nprk").map_err(|_| SyncCryptoError::EncodingFailed)?,
        recovery_secret.as_ref(),
    )
    .map_err(|_| SyncCryptoError::EncodingFailed)?;
    let auth_key = recovery_auth_signing_key(&recovery_secret)?;
    let public_key = URL_SAFE_NO_PAD.encode(auth_key.verifying_key().as_bytes());
    Ok((
        recovery_key,
        CloudRecoveryEnvelope {
            format_version: 1,
            suite: RECOVERY_SUITE,
            salt: encode(salt.as_ref()),
            nonce: encode(nonce.as_ref()),
            ciphertext: encode(&ciphertext),
        },
        public_key,
    ))
}

fn random_bytes<const N: usize>() -> Result<[u8; N], SyncCryptoError> {
    let mut bytes = [0_u8; N];
    getrandom::fill(&mut bytes).map_err(|_| SyncCryptoError::RandomUnavailable)?;
    Ok(bytes)
}

fn to_array(bytes: &[u8]) -> Result<[u8; 32], SyncCryptoError> {
    bytes
        .try_into()
        .map_err(|_| SyncCryptoError::EncodingFailed)
}

fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

#[allow(dead_code)]
fn length_prefixed(fields: &[&str]) -> Vec<u8> {
    let mut output = Vec::new();
    for field in fields {
        let bytes = field.as_bytes();
        output.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        output.extend_from_slice(bytes);
    }
    output
}

fn device_envelope_aad(
    cloud_account_id: &str,
    device_id: &str,
    generation: u8,
    encryption_public_key: &[u8],
) -> Result<Vec<u8>, SyncCryptoError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Aad<'a> {
        purpose: &'static str,
        format_version: u8,
        cloud_account_id: &'a str,
        device_id: &'a str,
        key_generation: u8,
        encryption_public_key_sha256: String,
    }

    serde_json::to_vec(&Aad {
        purpose: "nexuspilot-cloud-amk-envelope",
        format_version: 1,
        cloud_account_id,
        device_id,
        key_generation: generation,
        encryption_public_key_sha256: encode(&Sha256::digest(encryption_public_key)),
    })
    .map_err(|_| SyncCryptoError::EncodingFailed)
}

fn recovery_envelope_aad(
    cloud_account_id: &str,
    generation: u8,
) -> Result<Vec<u8>, SyncCryptoError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Aad<'a> {
        purpose: &'static str,
        format_version: u8,
        cloud_account_id: &'a str,
        key_generation: u8,
    }

    serde_json::to_vec(&Aad {
        purpose: "nexuspilot-cloud-amk-recovery-envelope",
        format_version: 1,
        cloud_account_id,
        key_generation: generation,
    })
    .map_err(|_| SyncCryptoError::EncodingFailed)
}

#[cfg(test)]
mod tests {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use chacha20poly1305::{
        aead::{Aead, Payload},
        KeyInit, XChaCha20Poly1305, XNonce,
    };
    use hkdf::Hkdf;
    use hpke::{
        aead::ChaCha20Poly1305, kdf::HkdfSha256, kem::X25519HkdfSha256, setup_receiver,
        Deserializable, OpModeR,
    };
    use sha2::Sha256;

    use super::{
        decrypt_connection_asset, device_envelope_aad, encrypt_connection_asset, length_prefixed,
        prepare_initialization, recovery_envelope_aad, HPKE_INFO, RECOVERY_KDF_INFO,
    };

    #[test]
    fn device_and_recovery_envelopes_open_to_the_same_amk() {
        let prepared = prepare_initialization(
            "cloud-account",
            "device-id",
            "initialization-id",
            "DESKTOP-01",
        )
        .expect("initialization should be prepared");
        let request = &prepared.request;
        let public_key = URL_SAFE_NO_PAD
            .decode(&request.device.encryption_public_key)
            .expect("public key");
        let device_aad =
            device_envelope_aad("cloud-account", "device-id", 1, &public_key).expect("aad");
        let recovery_aad = recovery_envelope_aad("cloud-account", 1).expect("recovery aad");

        let private_key = <X25519HkdfSha256 as hpke::Kem>::PrivateKey::from_bytes(
            &prepared.keys.encryption_private_key,
        )
        .expect("private key");
        let encapsulated_key = <X25519HkdfSha256 as hpke::Kem>::EncappedKey::from_bytes(
            &URL_SAFE_NO_PAD
                .decode(&request.device_envelope.encapsulated_key)
                .expect("encapsulated key"),
        )
        .expect("encapsulated key format");
        let mut receiver = setup_receiver::<ChaCha20Poly1305, HkdfSha256, X25519HkdfSha256>(
            &OpModeR::Base,
            &private_key,
            &encapsulated_key,
            HPKE_INFO,
        )
        .expect("receiver context");
        let device_plaintext = receiver
            .open(
                &URL_SAFE_NO_PAD
                    .decode(&request.device_envelope.ciphertext)
                    .expect("device ciphertext"),
                &device_aad,
            )
            .expect("device envelope should open");
        let mut wrong_aad = device_aad.clone();
        wrong_aad.push(0);
        let mut wrong_aad_receiver =
            setup_receiver::<ChaCha20Poly1305, HkdfSha256, X25519HkdfSha256>(
                &OpModeR::Base,
                &private_key,
                &encapsulated_key,
                HPKE_INFO,
            )
            .expect("receiver context");
        assert!(wrong_aad_receiver
            .open(
                &URL_SAFE_NO_PAD
                    .decode(&request.device_envelope.ciphertext)
                    .expect("device ciphertext"),
                &wrong_aad,
            )
            .is_err());

        let (_, recovery_secret) = bech32::decode(&prepared.recovery_key).expect("recovery key");
        let recovery_salt = URL_SAFE_NO_PAD
            .decode(&request.recovery_envelope.salt)
            .expect("recovery salt");
        let recovery_nonce = URL_SAFE_NO_PAD
            .decode(&request.recovery_envelope.nonce)
            .expect("recovery nonce");
        let mut recovery_encryption_key = [0_u8; 32];
        Hkdf::<Sha256>::new(Some(&recovery_salt), &recovery_secret)
            .expand(RECOVERY_KDF_INFO, &mut recovery_encryption_key)
            .expect("recovery key derivation");
        let recovery_plaintext = XChaCha20Poly1305::new((&recovery_encryption_key).into())
            .decrypt(
                XNonce::from_slice(&recovery_nonce),
                Payload {
                    msg: &URL_SAFE_NO_PAD
                        .decode(&request.recovery_envelope.ciphertext)
                        .expect("recovery ciphertext"),
                    aad: &recovery_aad,
                },
            )
            .expect("recovery envelope should open");
        let mut wrong_recovery_secret = recovery_secret.clone();
        wrong_recovery_secret[0] ^= 1;
        let mut wrong_recovery_key = [0_u8; 32];
        Hkdf::<Sha256>::new(Some(&recovery_salt), &wrong_recovery_secret)
            .expand(RECOVERY_KDF_INFO, &mut wrong_recovery_key)
            .expect("wrong recovery key derivation");
        assert!(XChaCha20Poly1305::new((&wrong_recovery_key).into())
            .decrypt(
                XNonce::from_slice(&recovery_nonce),
                Payload {
                    msg: &URL_SAFE_NO_PAD
                        .decode(&request.recovery_envelope.ciphertext)
                        .expect("recovery ciphertext"),
                    aad: &recovery_aad,
                },
            )
            .is_err());

        assert_eq!(device_plaintext, prepared.keys.amk);
        assert_eq!(recovery_plaintext, prepared.keys.amk);
        let serialized = serde_json::to_string(request).expect("request should serialize");
        assert!(!serialized.contains(&prepared.recovery_key));
        assert!(!serialized.contains(&URL_SAFE_NO_PAD.encode(prepared.keys.amk)));
    }

    #[test]
    fn envelope_and_connection_asset_aad_match_cloud_v1_vectors() {
        let public_key: Vec<u8> = (0_u8..32).collect();
        let device_aad = device_envelope_aad(
            "0198f5dc-4000-7000-8000-000000000001",
            "0198f5dc-4000-7000-8000-000000000002",
            1,
            &public_key,
        )
        .expect("device aad");
        let recovery_aad =
            recovery_envelope_aad("0198f5dc-4000-7000-8000-000000000001", 1).expect("recovery aad");

        assert_eq!(
            URL_SAFE_NO_PAD.encode(device_aad),
            "eyJwdXJwb3NlIjoibmV4dXNwaWxvdC1jbG91ZC1hbWstZW52ZWxvcGUiLCJmb3JtYXRWZXJzaW9uIjoxLCJjbG91ZEFjY291bnRJZCI6IjAxOThmNWRjLTQwMDAtNzAwMC04MDAwLTAwMDAwMDAwMDAwMSIsImRldmljZUlkIjoiMDE5OGY1ZGMtNDAwMC03MDAwLTgwMDAtMDAwMDAwMDAwMDAyIiwia2V5R2VuZXJhdGlvbiI6MSwiZW5jcnlwdGlvblB1YmxpY0tleVNoYTI1NiI6Ill3M05LV2JFTTJhUkVsUkl1N0piVF9RU3BKeHpMYkxJcThHNFdCdlhFTjAifQ"
        );
        assert_eq!(
            URL_SAFE_NO_PAD.encode(recovery_aad),
            "eyJwdXJwb3NlIjoibmV4dXNwaWxvdC1jbG91ZC1hbWstcmVjb3ZlcnktZW52ZWxvcGUiLCJmb3JtYXRWZXJzaW9uIjoxLCJjbG91ZEFjY291bnRJZCI6IjAxOThmNWRjLTQwMDAtNzAwMC04MDAwLTAwMDAwMDAwMDAwMSIsImtleUdlbmVyYXRpb24iOjF9"
        );
        assert_eq!(
            URL_SAFE_NO_PAD.encode(length_prefixed(&[
                "NexusPilot.ConnectionAsset.v1",
                "0198f5dc-4000-7000-8000-000000000001",
                "0198f5dc-4000-7000-8000-000000000004",
                "connection",
                "1",
                "1",
                "1",
                "XCHACHA20-POLY1305",
            ])),
            "AAAAHU5leHVzUGlsb3QuQ29ubmVjdGlvbkFzc2V0LnYxAAAAJDAxOThmNWRjLTQwMDAtNzAwMC04MDAwLTAwMDAwMDAwMDAwMQAAACQwMTk4ZjVkYy00MDAwLTcwMDAtODAwMC0wMDAwMDAwMDAwMDQAAAAKY29ubmVjdGlvbgAAAAExAAAAATEAAAABMQAAABJYQ0hBQ0hBMjAtUE9MWTEzMDU"
        );
    }

    #[test]
    fn connection_asset_encryption_round_trips_and_binds_revision() {
        let amk = [7_u8; 32];
        let encryption = encrypt_connection_asset(
            "account-1",
            "asset-1",
            "connection",
            1,
            1,
            1,
            b"secret connection projection",
            &amk,
        )
        .expect("asset encryption should succeed");
        let plaintext = decrypt_connection_asset(
            "account-1",
            "asset-1",
            "connection",
            1,
            1,
            1,
            &encryption,
            &amk,
        )
        .expect("asset decryption should succeed");
        assert_eq!(plaintext, b"secret connection projection");
        assert!(decrypt_connection_asset(
            "account-1",
            "asset-1",
            "connection",
            2,
            1,
            1,
            &encryption,
            &amk,
        )
        .is_err());
        assert!(!encryption.ciphertext.contains("secret"));
    }
}
