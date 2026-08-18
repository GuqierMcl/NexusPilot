use std::{fs, path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};

use super::types::{
    CloudAccountSummary, CloudConnectionSyncEntitlement, CloudSubscriptionSummary, CloudSyncDevice,
    CloudSyncState,
};

const CACHE_VERSION: u8 = 1;
const CACHE_FILE_NAME: &str = "nexus_pilot_cloud_projection.json";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CloudProjectionCacheRecord {
    pub version: u8,
    pub identity_binding_sha256: String,
    pub cloud_account_id: String,
    pub account: CloudAccountSummary,
    pub subscription: CloudSubscriptionSummary,
    pub connection_sync: CloudConnectionSyncEntitlement,
    pub sync: CloudSyncState,
    pub devices: Option<Vec<CloudSyncDevice>>,
    pub cached_at: String,
}

pub(crate) struct CloudProjectionCache {
    path: Option<PathBuf>,
    lock: Mutex<()>,
}

impl CloudProjectionCache {
    pub(crate) fn new(app_data_dir: Option<PathBuf>) -> Self {
        Self {
            path: app_data_dir.map(|directory| directory.join(CACHE_FILE_NAME)),
            lock: Mutex::new(()),
        }
    }

    pub(crate) fn read(&self, identity_binding_sha256: &str) -> Option<CloudProjectionCacheRecord> {
        let path = self.path.as_ref()?;
        let _guard = self.lock.lock().ok()?;
        let bytes = fs::read(path).ok()?;
        let record = serde_json::from_slice::<CloudProjectionCacheRecord>(&bytes).ok()?;
        if record.version != CACHE_VERSION
            || record.identity_binding_sha256 != identity_binding_sha256
        {
            return None;
        }
        Some(record)
    }

    pub(crate) fn write(&self, record: &CloudProjectionCacheRecord) {
        let Some(path) = self.path.as_ref() else {
            return;
        };
        let Ok(_guard) = self.lock.lock() else {
            return;
        };
        let Some(parent) = path.parent() else {
            return;
        };
        if fs::create_dir_all(parent).is_err() {
            return;
        }
        let Ok(payload) = serde_json::to_vec(record) else {
            return;
        };
        let temporary = path.with_extension("json.tmp");
        if fs::write(&temporary, payload).is_ok() && fs::rename(&temporary, path).is_err() {
            let _ = fs::remove_file(path);
            let _ = fs::rename(&temporary, path);
        }
    }

    pub(crate) fn clear(&self) {
        let Some(path) = self.path.as_ref() else {
            return;
        };
        let Ok(_guard) = self.lock.lock() else {
            return;
        };
        let _ = fs::remove_file(path);
    }
}

pub(crate) const fn cache_version() -> u8 {
    CACHE_VERSION
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tempfile::tempdir;

    use super::{cache_version, CloudProjectionCache, CloudProjectionCacheRecord};
    use crate::cloud::types::{
        CloudAccountStatus, CloudConnectionSyncEntitlement, CloudConnectionSyncLimits,
        CloudConnectionSyncPermissions, CloudConnectionSyncUsage, CloudSubscriptionSummary,
        CloudSyncState,
    };

    fn record() -> CloudProjectionCacheRecord {
        CloudProjectionCacheRecord {
            version: cache_version(),
            identity_binding_sha256: "identity".to_string(),
            cloud_account_id: "account".to_string(),
            account: super::CloudAccountSummary {
                id: "account".to_string(),
                status: CloudAccountStatus::Active,
            },
            subscription: CloudSubscriptionSummary {
                plan_code: "plus".to_string(),
                status: "active".to_string(),
                current_period_end: None,
            },
            connection_sync: CloudConnectionSyncEntitlement {
                phase: "active".to_string(),
                permissions: CloudConnectionSyncPermissions {
                    read_encrypted_assets: true,
                    write_encrypted_assets: true,
                    enroll_sync_device: true,
                    approve_device_authorization: true,
                    recover_existing_assets: true,
                },
                limits: CloudConnectionSyncLimits {
                    max_sync_devices: 3,
                    max_encrypted_bytes: 10,
                },
                usage: CloudConnectionSyncUsage {
                    active_sync_devices: 1,
                    encrypted_bytes: 0,
                },
                effective_at: None,
                expires_at: None,
                phase_ends_at: None,
                deletion_eligible_at: None,
                entitlement_version: Some(1),
                policy_version: 1,
            },
            sync: CloudSyncState {
                initialized: true,
                key_generation: Some(1),
                active_device_count: 1,
                initialized_at: None,
            },
            devices: Some(Vec::new()),
            cached_at: "2026-08-08T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn cache_is_versioned_and_account_scoped() {
        let directory = tempdir().expect("temp directory");
        let cache = Arc::new(CloudProjectionCache::new(Some(
            directory.path().to_path_buf(),
        )));
        cache.write(&record());
        assert_eq!(cache.read("identity"), Some(record()));
        assert_eq!(cache.read("another-identity"), None);
        cache.clear();
        assert_eq!(cache.read("identity"), None);
    }

    #[test]
    fn corrupted_or_unknown_cache_is_ignored() {
        let directory = tempdir().expect("temp directory");
        let cache = CloudProjectionCache::new(Some(directory.path().to_path_buf()));
        let path = directory.path().join(super::CACHE_FILE_NAME);

        std::fs::write(&path, b"not-json").expect("write corrupted cache");
        assert_eq!(cache.read("identity"), None);

        let mut unknown = record();
        unknown.version = cache_version() + 1;
        std::fs::write(
            &path,
            serde_json::to_vec(&unknown).expect("serialize unknown cache"),
        )
        .expect("write unknown cache");
        assert_eq!(cache.read("identity"), None);
    }
}
