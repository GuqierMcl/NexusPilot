use std::collections::BTreeMap;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::sync_key_store::CommittedSyncKeyBundle;

const DEVICE_PROOF_DOMAIN: &str = "NexusPilot.Cloud.DeviceProof.v1";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DeviceProofHeaders {
    pub device_id: String,
    pub timestamp: String,
    pub nonce: String,
    pub signature: String,
}

pub(crate) fn build_device_proof(
    action: &str,
    account_id: &str,
    keys: &CommittedSyncKeyBundle,
    payload: &Value,
) -> Result<DeviceProofHeaders, DeviceProofError> {
    build_device_proof_with_signing_key(
        action,
        account_id,
        &keys.device_id,
        &keys.signing_private_key,
        payload,
    )
}

pub(crate) fn build_device_proof_with_signing_key(
    action: &str,
    account_id: &str,
    device_id: &str,
    signing_private_key: &[u8; 32],
    payload: &Value,
) -> Result<DeviceProofHeaders, DeviceProofError> {
    let timestamp = utc_now_millis_string();
    let mut nonce_bytes = [0_u8; 16];
    getrandom::fill(&mut nonce_bytes).map_err(|_| DeviceProofError::RandomUnavailable)?;
    let nonce = URL_SAFE_NO_PAD.encode(nonce_bytes);
    let payload_digest = digest_device_proof_json(payload)?;
    let message = build_device_proof_message(
        action,
        account_id,
        device_id,
        &timestamp,
        &nonce,
        &payload_digest,
    )?;
    let signing_key = SigningKey::from_bytes(signing_private_key);
    let signature = signing_key.sign(&message).to_bytes();

    Ok(DeviceProofHeaders {
        device_id: device_id.to_string(),
        timestamp,
        nonce,
        signature: URL_SAFE_NO_PAD.encode(signature),
    })
}

pub(crate) fn digest_device_proof_json(value: &Value) -> Result<String, DeviceProofError> {
    let canonical = canonicalize_json(value)?;
    Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(canonical.as_bytes())))
}

fn canonicalize_json(value: &Value) -> Result<String, DeviceProofError> {
    let normalized = normalize_json(value)?;
    serde_json::to_string(&normalized).map_err(|_| DeviceProofError::InvalidPayload)
}

pub(crate) fn canonicalize_payload(value: &Value) -> Result<String, ()> {
    canonicalize_json(value).map_err(|_| ())
}

fn normalize_json(value: &Value) -> Result<Value, DeviceProofError> {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => Ok(value.clone()),
        Value::Number(number) if number.is_i64() || number.is_u64() => Ok(value.clone()),
        Value::Number(_) => Err(DeviceProofError::InvalidPayload),
        Value::Array(items) => Ok(Value::Array(
            items
                .iter()
                .map(normalize_json)
                .collect::<Result<Vec<_>, _>>()?,
        )),
        Value::Object(object) => {
            let mut sorted = BTreeMap::new();
            for (key, child) in object {
                sorted.insert(key.clone(), normalize_json(child)?);
            }
            Ok(Value::Object(sorted.into_iter().collect()))
        }
    }
}

fn build_device_proof_message(
    action: &str,
    account_id: &str,
    device_id: &str,
    timestamp: &str,
    nonce: &str,
    payload_digest: &str,
) -> Result<Vec<u8>, DeviceProofError> {
    for value in [
        DEVICE_PROOF_DOMAIN,
        action,
        account_id,
        device_id,
        timestamp,
        nonce,
        payload_digest,
    ] {
        if value.is_empty() || value.len() > 512 {
            return Err(DeviceProofError::InvalidContext);
        }
    }
    let mut message = Vec::new();
    for value in [
        DEVICE_PROOF_DOMAIN,
        action,
        account_id,
        device_id,
        timestamp,
        nonce,
        payload_digest,
    ] {
        let bytes = value.as_bytes();
        let length = u32::try_from(bytes.len()).map_err(|_| DeviceProofError::InvalidContext)?;
        message.extend_from_slice(&length.to_be_bytes());
        message.extend_from_slice(bytes);
    }
    Ok(message)
}

fn utc_now_millis_string() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond(),
    )
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DeviceProofError {
    RandomUnavailable,
    InvalidPayload,
    InvalidContext,
}

#[cfg(test)]
mod tests {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use serde_json::json;

    use super::{build_device_proof_message, canonicalize_json, digest_device_proof_json};

    #[test]
    fn canonicalizes_nested_objects_by_unicode_key_order() {
        let value = json!({"z": 1, "a": {"z": true, "a": [3, 2, 1]}});
        assert_eq!(
            canonicalize_json(&value).expect("canonical JSON"),
            r#"{"a":{"a":[3,2,1],"z":true},"z":1}"#
        );
    }

    #[test]
    fn rejects_non_integer_numbers() {
        assert!(canonicalize_json(&json!({"value": 1.25})).is_err());
    }

    #[test]
    fn empty_payload_digest_is_stable() {
        assert_eq!(
            digest_device_proof_json(&json!({})).expect("digest"),
            "RBNvo1WzZ4oRRq0W9-hknpT7T8If536DEMBg9hyq_4o"
        );
    }

    #[test]
    fn matches_the_cloud_v1_contract_freeze_vector() {
        let account_id = "0198f5dc-4000-7000-8000-000000000001";
        let device_id = "0198f5dc-4000-7000-8000-000000000002";
        let payload = json!({
            "operationId": "0198f5dc-4000-7000-8000-000000000003",
            "confirmation": "DELETE_CLOUD_SYNC_DATA"
        });
        let canonical = canonicalize_json(&payload).expect("canonical JSON");
        let digest = digest_device_proof_json(&payload).expect("digest");
        let message = build_device_proof_message(
            "DELETE /v1/sync/data",
            account_id,
            device_id,
            "2026-08-07T08:00:00.000Z",
            "BwcHBwcHBwcHBwcHBwcHBw",
            &digest,
        )
        .expect("message");

        assert_eq!(
            canonical,
            r#"{"confirmation":"DELETE_CLOUD_SYNC_DATA","operationId":"0198f5dc-4000-7000-8000-000000000003"}"#
        );
        assert_eq!(digest, "KGFY9RV_osSwCDA3uwNfQCtly4bXAmT8bX2VTE4cudA");
        assert_eq!(
            URL_SAFE_NO_PAD.encode(message),
            "AAAAH05leHVzUGlsb3QuQ2xvdWQuRGV2aWNlUHJvb2YudjEAAAAUREVMRVRFIC92MS9zeW5jL2RhdGEAAAAkMDE5OGY1ZGMtNDAwMC03MDAwLTgwMDAtMDAwMDAwMDAwMDAxAAAAJDAxOThmNWRjLTQwMDAtNzAwMC04MDAwLTAwMDAwMDAwMDAwMgAAABgyMDI2LTA4LTA3VDA4OjAwOjAwLjAwMFoAAAAWQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCdwAAACtLR0ZZOVJWX29zU3dDREEzdXdOZlFDdGx5NGJYQW1UOGJYMlZURTRjdWRB"
        );
    }
}
