use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::{Store, StoreExt};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::AppResult;

pub const INSTALLATION_STORE_FILE_NAME: &str = "nexus_pilot_installation.json";
pub const INSTALLATION_IDENTITY_SCHEMA_VERSION: u64 = 1;

const KEY_SCHEMA_VERSION: &str = "schemaVersion";
const KEY_INSTALLATION_ID: &str = "installationId";
const KEY_CREATED_AT: &str = "createdAt";
const KEY_CREATED_BY_VERSION: &str = "createdByVersion";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallationIdentity {
    pub schema_version: u64,
    pub installation_id: String,
    pub created_at: String,
    pub created_by_version: String,
}

#[derive(Clone)]
pub struct InstallationIdentityState {
    identity: InstallationIdentity,
}

impl InstallationIdentityState {
    pub fn new(identity: InstallationIdentity) -> Self {
        Self { identity }
    }

    pub fn identity(&self) -> &InstallationIdentity {
        &self.identity
    }
}

#[derive(Debug, Default)]
struct InstallationIdentityStoreValues {
    schema_version: Option<u64>,
    installation_id: Option<String>,
    created_at: Option<String>,
    created_by_version: Option<String>,
}

pub fn ensure_installation_identity<R: Runtime>(
    app: &AppHandle<R>,
) -> AppResult<InstallationIdentity> {
    let store = app.store(INSTALLATION_STORE_FILE_NAME)?;
    let current_values = read_store_values(&store);
    let fallback = new_installation_identity(app.package_info().version.to_string());
    let (identity, should_persist) = resolve_installation_identity(current_values, fallback);

    if should_persist {
        write_identity_to_store(&store, &identity)?;
    }

    Ok(identity)
}

fn new_installation_identity(created_by_version: String) -> InstallationIdentity {
    InstallationIdentity {
        schema_version: INSTALLATION_IDENTITY_SCHEMA_VERSION,
        installation_id: Uuid::new_v4().to_string(),
        created_at: utc_now_millis_string(),
        created_by_version,
    }
}

fn read_store_values<R: Runtime>(store: &Store<R>) -> InstallationIdentityStoreValues {
    InstallationIdentityStoreValues {
        schema_version: store
            .get(KEY_SCHEMA_VERSION)
            .and_then(|value| value.as_u64()),
        installation_id: store
            .get(KEY_INSTALLATION_ID)
            .and_then(|value| value.as_str().map(str::to_string)),
        created_at: store
            .get(KEY_CREATED_AT)
            .and_then(|value| value.as_str().map(str::to_string)),
        created_by_version: store
            .get(KEY_CREATED_BY_VERSION)
            .and_then(|value| value.as_str().map(str::to_string)),
    }
}

fn write_identity_to_store<R: Runtime>(
    store: &Store<R>,
    identity: &InstallationIdentity,
) -> AppResult<()> {
    store.set(KEY_SCHEMA_VERSION, json!(identity.schema_version));
    store.set(KEY_INSTALLATION_ID, json!(identity.installation_id));
    store.set(KEY_CREATED_AT, json!(identity.created_at));
    store.set(KEY_CREATED_BY_VERSION, json!(identity.created_by_version));
    store.save()?;

    Ok(())
}

fn resolve_installation_identity(
    values: InstallationIdentityStoreValues,
    fallback: InstallationIdentity,
) -> (InstallationIdentity, bool) {
    let Some(installation_id) = values
        .installation_id
        .filter(|value| is_valid_installation_id(value))
    else {
        return (fallback, true);
    };

    let created_at = values
        .created_at
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| fallback.created_at.clone());
    let created_by_version = values
        .created_by_version
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| fallback.created_by_version.clone());
    let identity = InstallationIdentity {
        schema_version: INSTALLATION_IDENTITY_SCHEMA_VERSION,
        installation_id,
        created_at,
        created_by_version,
    };
    let should_persist = values.schema_version != Some(INSTALLATION_IDENTITY_SCHEMA_VERSION)
        || values.created_at.as_deref() != Some(identity.created_at.as_str())
        || values.created_by_version.as_deref() != Some(identity.created_by_version.as_str());

    (identity, should_persist)
}

fn is_valid_installation_id(value: &str) -> bool {
    Uuid::parse_str(value).is_ok()
}

fn utc_now_millis_string() -> String {
    let now = OffsetDateTime::now_utc();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_valid_installation_id_and_repairs_missing_metadata() {
        let fallback = InstallationIdentity {
            schema_version: INSTALLATION_IDENTITY_SCHEMA_VERSION,
            installation_id: "11111111-1111-4111-8111-111111111111".to_string(),
            created_at: "2026-07-08T00:00:00.000Z".to_string(),
            created_by_version: "0.6.0".to_string(),
        };
        let existing = InstallationIdentityStoreValues {
            schema_version: None,
            installation_id: Some("3d7c0f74-7a5e-4f50-9e5c-9eac0f7b6d2e".to_string()),
            created_at: Some("2026-07-07T10:20:30.000Z".to_string()),
            created_by_version: None,
        };

        let (identity, should_persist) = resolve_installation_identity(existing, fallback);

        assert!(should_persist);
        assert_eq!(
            identity.schema_version,
            INSTALLATION_IDENTITY_SCHEMA_VERSION
        );
        assert_eq!(
            identity.installation_id,
            "3d7c0f74-7a5e-4f50-9e5c-9eac0f7b6d2e"
        );
        assert_eq!(identity.created_at, "2026-07-07T10:20:30.000Z");
        assert_eq!(identity.created_by_version, "0.6.0");
    }

    #[test]
    fn replaces_invalid_installation_id_with_generated_identity() {
        let fallback = InstallationIdentity {
            schema_version: INSTALLATION_IDENTITY_SCHEMA_VERSION,
            installation_id: "11111111-1111-4111-8111-111111111111".to_string(),
            created_at: "2026-07-08T00:00:00.000Z".to_string(),
            created_by_version: "0.6.0".to_string(),
        };
        let existing = InstallationIdentityStoreValues {
            schema_version: Some(INSTALLATION_IDENTITY_SCHEMA_VERSION),
            installation_id: Some("not-a-uuid".to_string()),
            created_at: Some("2026-07-07T10:20:30.000Z".to_string()),
            created_by_version: Some("0.5.0".to_string()),
        };

        let (identity, should_persist) = resolve_installation_identity(existing, fallback);

        assert!(should_persist);
        assert_eq!(
            identity.installation_id,
            "11111111-1111-4111-8111-111111111111"
        );
        assert_eq!(identity.created_at, "2026-07-08T00:00:00.000Z");
        assert_eq!(identity.created_by_version, "0.6.0");
    }
}
