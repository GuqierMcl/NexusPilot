use crate::engine::types::{
    RedisCreateKeyValueRequest, RedisDeleteKeyPrefixRequest, RedisDeleteKeyRequest,
    RedisEditableValue, RedisRenameKeyRequest, RedisSetKeyTtlMode, RedisSetKeyTtlRequest,
    RedisTtlPolicy,
};
use crate::error::{IpcError, IpcResult};

pub(super) fn ensure_non_empty_key(key: &str, label: &str) -> IpcResult<()> {
    if key.trim().is_empty() {
        return Err(IpcError::validation_failed(format!(
            "Redis {label} must not be empty"
        )));
    }
    Ok(())
}

pub(super) fn validate_expected_fingerprint(fingerprint: &str) -> IpcResult<()> {
    let digest = fingerprint
        .strip_prefix("sha256:")
        .ok_or_else(|| IpcError::validation_failed("Redis fingerprint is invalid"))?;
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(IpcError::validation_failed("Redis fingerprint is invalid"));
    }
    Ok(())
}

pub(super) fn validate_editable_value(value: &RedisEditableValue) -> IpcResult<()> {
    match value {
        RedisEditableValue::String(_) => Ok(()),
        RedisEditableValue::Json(text) => {
            serde_json::from_str::<serde_json::Value>(text).map_err(|error| {
                IpcError::validation_failed(format!("Redis JSON value is invalid: {error}"))
            })?;
            Ok(())
        }
        RedisEditableValue::Hash(entries) => {
            if entries.is_empty() {
                return Err(IpcError::validation_failed(
                    "Redis hash value must contain at least one field",
                ));
            }
            for entry in entries {
                if entry.field.is_empty() {
                    return Err(IpcError::validation_failed(
                        "Redis hash field must not be empty",
                    ));
                }
            }
            Ok(())
        }
        RedisEditableValue::List(items) => {
            if items.is_empty() {
                return Err(IpcError::validation_failed(
                    "Redis list value must contain at least one item",
                ));
            }
            Ok(())
        }
        RedisEditableValue::Set(items) => {
            if items.is_empty() {
                return Err(IpcError::validation_failed(
                    "Redis set value must contain at least one member",
                ));
            }
            Ok(())
        }
        RedisEditableValue::SortedSet(entries) => {
            if entries.is_empty() {
                return Err(IpcError::validation_failed(
                    "Redis sorted set value must contain at least one member",
                ));
            }
            for entry in entries {
                if entry.member.is_empty() {
                    return Err(IpcError::validation_failed(
                        "Redis sorted set member must not be empty",
                    ));
                }
                if !entry.score.is_finite() {
                    return Err(IpcError::validation_failed(
                        "Redis sorted set score must be a finite number",
                    ));
                }
            }
            Ok(())
        }
        RedisEditableValue::Stream(entries) => {
            if entries.is_empty() {
                return Err(IpcError::validation_failed(
                    "Redis stream value must contain at least one entry",
                ));
            }
            for entry in entries {
                if entry.id.trim().is_empty() {
                    return Err(IpcError::validation_failed(
                        "Redis stream entry id must not be empty",
                    ));
                }
                if entry.fields.is_empty() {
                    return Err(IpcError::validation_failed(
                        "Redis stream entry must contain at least one field",
                    ));
                }
                for field in &entry.fields {
                    if field.field.is_empty() {
                        return Err(IpcError::validation_failed(
                            "Redis stream field name must not be empty",
                        ));
                    }
                }
            }
            Ok(())
        }
    }
}

pub(super) fn validate_rename_request(request: &RedisRenameKeyRequest) -> IpcResult<()> {
    ensure_non_empty_key(&request.key, "key")?;
    ensure_non_empty_key(&request.new_key, "new key")?;
    validate_expected_fingerprint(&request.expected_fingerprint)?;
    Ok(())
}

pub(super) fn validate_value_ttl_policy(
    ttl_policy: Option<&RedisTtlPolicy>,
    ttl_seconds: Option<u64>,
) -> IpcResult<()> {
    if ttl_policy == Some(&RedisTtlPolicy::Expire)
        && ttl_seconds.filter(|value| *value > 0).is_none()
    {
        return Err(IpcError::validation_failed(
            "Redis expire ttlPolicy requires a positive ttlSeconds value",
        ));
    }
    Ok(())
}

pub(super) fn validate_ttl_request(request: &RedisSetKeyTtlRequest) -> IpcResult<()> {
    ensure_non_empty_key(&request.key, "key")?;
    validate_expected_fingerprint(&request.expected_fingerprint)?;
    if request.mode == RedisSetKeyTtlMode::Expire
        && request.ttl_seconds.filter(|value| *value > 0).is_none()
    {
        return Err(IpcError::validation_failed(
            "Redis expire mode requires a positive ttlSeconds value",
        ));
    }
    Ok(())
}

pub(super) fn validate_create_key_value_request(
    request: &RedisCreateKeyValueRequest,
) -> IpcResult<()> {
    ensure_non_empty_key(&request.key, "key")?;
    validate_editable_value(&request.value)?;
    validate_value_ttl_policy(request.ttl_policy.as_ref(), request.ttl_seconds)?;
    Ok(())
}

pub(super) fn validate_delete_key_request(request: &RedisDeleteKeyRequest) -> IpcResult<()> {
    ensure_non_empty_key(&request.key, "key")?;
    validate_expected_fingerprint(&request.expected_fingerprint)?;
    Ok(())
}

pub(super) fn validate_delete_key_prefix_request(
    request: &RedisDeleteKeyPrefixRequest,
) -> IpcResult<()> {
    let pattern = request.pattern.trim();
    if pattern.is_empty() {
        return Err(IpcError::validation_failed(
            "Redis delete prefix pattern must not be empty",
        ));
    }
    if pattern == "*" {
        return Err(IpcError::validation_failed(
            "Redis delete prefix pattern must not be global wildcard '*'",
        ));
    }
    Ok(())
}
