use std::sync::{Arc, RwLock};

use serde::Serialize;
use time::OffsetDateTime;

use super::{
    sync_scheduler::CloudSyncRuntimeProjection, CloudErrorCode, CloudProjectionSource,
    CloudPublicError, CloudSyncSetupContext,
};

pub(crate) const CLOUD_DESKTOP_STATE_CHANGED_EVENT: &str = "cloud-desktop-state-changed";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CloudConnectionPhase {
    Unauthenticated,
    NeedsRefresh,
    Refreshing,
    Connected,
    Cached,
    Offline,
    ReauthenticationRequired,
    PermissionDenied,
    Unavailable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudCapabilityProjection {
    pub code: String,
    pub phase: String,
    pub available: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudRefreshProjection {
    pub in_flight: bool,
    pub last_started_at: Option<String>,
    pub last_completed_at: Option<String>,
    pub last_succeeded_at: Option<String>,
    pub last_error: Option<CloudPublicError>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDesktopStateProjection {
    pub connection: CloudConnectionPhase,
    pub context: Option<CloudSyncSetupContext>,
    pub capabilities: Vec<CloudCapabilityProjection>,
    pub runtime: CloudSyncRuntimeProjection,
    pub refresh: CloudRefreshProjection,
}

impl Default for CloudDesktopStateProjection {
    fn default() -> Self {
        Self {
            connection: CloudConnectionPhase::Unauthenticated,
            context: None,
            capabilities: Vec::new(),
            runtime: CloudSyncRuntimeProjection::default(),
            refresh: CloudRefreshProjection::default(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct CloudDesktopStateStore {
    inner: Arc<CloudDesktopStateStoreInner>,
}

struct CloudDesktopStateStoreInner {
    projection: RwLock<CloudDesktopStateProjection>,
    event_sink: Arc<dyn Fn(CloudDesktopStateProjection) + Send + Sync>,
}

impl Default for CloudDesktopStateStore {
    fn default() -> Self {
        Self::new(Arc::new(|_| {}))
    }
}

impl CloudDesktopStateStore {
    pub(crate) fn new(event_sink: Arc<dyn Fn(CloudDesktopStateProjection) + Send + Sync>) -> Self {
        Self {
            inner: Arc::new(CloudDesktopStateStoreInner {
                projection: RwLock::new(CloudDesktopStateProjection::default()),
                event_sink,
            }),
        }
    }

    pub(crate) fn snapshot(&self) -> CloudDesktopStateProjection {
        self.inner
            .projection
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub(crate) fn on_auth_session_event(&self, phase: Option<&str>) {
        self.update(|projection| match phase {
            Some("authenticated") => {
                projection.connection = CloudConnectionPhase::NeedsRefresh;
            }
            Some("reauthenticationRequired") => {
                projection.connection = CloudConnectionPhase::ReauthenticationRequired;
                projection.context = None;
                projection.capabilities.clear();
            }
            Some("anonymous") => {
                *projection = CloudDesktopStateProjection::default();
            }
            _ => {}
        });
    }

    pub(crate) fn begin_refresh(&self) {
        self.update(|projection| {
            projection.connection = CloudConnectionPhase::Refreshing;
            projection.refresh.in_flight = true;
            projection.refresh.last_started_at = Some(now_string());
            projection.refresh.last_error = None;
        });
    }

    pub(crate) fn set_context(&self, context: CloudSyncSetupContext) {
        self.update(|projection| {
            apply_context(projection, context);
        });
    }

    /// Hydrate a display-only cache without overwriting a live refresh or a
    /// newer projection that was already established by another operation.
    pub(crate) fn hydrate_cached_context(&self, context: CloudSyncSetupContext) -> bool {
        let snapshot = {
            let mut projection = self
                .inner
                .projection
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if projection.refresh.in_flight || projection.context.is_some() {
                return false;
            }
            apply_context(&mut projection, context);
            projection.clone()
        };
        (self.inner.event_sink)(snapshot);
        true
    }

    pub(crate) fn fail_refresh(&self, error: CloudPublicError) {
        self.update(|projection| {
            projection.connection = connection_phase_for_error(&error);
            projection.refresh.in_flight = false;
            projection.refresh.last_completed_at = Some(now_string());
            projection.refresh.last_error = Some(error.clone());
            if !error.retryable {
                projection.context = None;
                projection.capabilities.clear();
            }
        });
    }

    pub(crate) fn update_runtime(
        &self,
        update: impl FnOnce(&mut CloudSyncRuntimeProjection),
    ) -> CloudSyncRuntimeProjection {
        self.update(|projection| update(&mut projection.runtime))
            .runtime
    }

    fn update(
        &self,
        update: impl FnOnce(&mut CloudDesktopStateProjection),
    ) -> CloudDesktopStateProjection {
        let snapshot = {
            let mut projection = self
                .inner
                .projection
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            update(&mut projection);
            projection.clone()
        };
        (self.inner.event_sink)(snapshot.clone());
        snapshot
    }
}

fn capability_projection(context: &CloudSyncSetupContext) -> Vec<CloudCapabilityProjection> {
    vec![CloudCapabilityProjection {
        code: "connection_sync".to_string(),
        phase: context.connection_sync.phase.clone(),
        available: context.connection_sync.phase != "not_entitled",
    }]
}

fn apply_context(projection: &mut CloudDesktopStateProjection, context: CloudSyncSetupContext) {
    projection.connection = match context.source {
        CloudProjectionSource::Cloud => CloudConnectionPhase::Connected,
        CloudProjectionSource::Cache => CloudConnectionPhase::Cached,
    };
    projection.capabilities = capability_projection(&context);
    projection.context = Some(context);
    projection.refresh.in_flight = false;
    projection.refresh.last_completed_at = Some(now_string());
    if projection.connection == CloudConnectionPhase::Connected {
        projection.refresh.last_succeeded_at = projection.refresh.last_completed_at.clone();
        projection.refresh.last_error = None;
    }
}

fn connection_phase_for_error(error: &CloudPublicError) -> CloudConnectionPhase {
    match error.code {
        CloudErrorCode::Unauthenticated => CloudConnectionPhase::Unauthenticated,
        CloudErrorCode::ReauthenticationRequired => CloudConnectionPhase::ReauthenticationRequired,
        CloudErrorCode::InsufficientScope => CloudConnectionPhase::PermissionDenied,
        CloudErrorCode::TemporarilyUnavailable | CloudErrorCode::AuthTemporarilyUnavailable
            if error.retryable =>
        {
            CloudConnectionPhase::Offline
        }
        _ => CloudConnectionPhase::Unavailable,
    }
}

fn now_string() -> String {
    let value = OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        value.year(),
        u8::from(value.month()),
        value.day(),
        value.hour(),
        value.minute(),
        value.second(),
    )
}

#[cfg(test)]
mod tests {
    use super::{connection_phase_for_error, CloudConnectionPhase, CloudDesktopStateStore};
    use crate::cloud::{CloudErrorCode, CloudPublicError, CloudSyncSetupContext};

    fn cached_context() -> CloudSyncSetupContext {
        serde_json::from_value(serde_json::json!({
            "evaluatedAt": "2026-08-10T00:00:00Z",
            "account": { "id": "account", "status": "active" },
            "subscription": { "planCode": "free", "status": "active", "currentPeriodEnd": null },
            "connectionSync": {
                "phase": "not_entitled",
                "permissions": {
                    "readEncryptedAssets": false,
                    "writeEncryptedAssets": false,
                    "enrollSyncDevice": false,
                    "approveDeviceAuthorization": false,
                    "recoverExistingAssets": false
                },
                "limits": { "maxSyncDevices": 0, "maxEncryptedBytes": 0 },
                "usage": { "activeSyncDevices": 0, "encryptedBytes": 0 },
                "effectiveAt": null,
                "expiresAt": null,
                "phaseEndsAt": null,
                "deletionEligibleAt": null,
                "entitlementVersion": null,
                "policyVersion": 1
            },
            "sync": {
                "initialized": false,
                "keyGeneration": null,
                "activeDeviceCount": 0,
                "initializedAt": null
            },
            "localSync": { "status": "disabled", "keyGeneration": null },
            "devices": [],
            "suggestedDeviceName": "desktop",
            "source": "cache",
            "cachedAt": "2026-08-10T00:00:00Z"
        }))
        .expect("test context should deserialize")
    }

    #[test]
    fn insufficient_scope_is_not_reported_as_reauthentication() {
        let error = CloudPublicError::from_code(CloudErrorCode::InsufficientScope);
        assert_eq!(
            connection_phase_for_error(&error),
            CloudConnectionPhase::PermissionDenied
        );
    }

    #[test]
    fn authentication_failure_keeps_reauthentication_semantics() {
        let error = CloudPublicError::from_code(CloudErrorCode::ReauthenticationRequired);
        assert_eq!(
            connection_phase_for_error(&error),
            CloudConnectionPhase::ReauthenticationRequired
        );
    }

    #[test]
    fn retryable_cloud_failure_is_offline() {
        let error = CloudPublicError::from_code(CloudErrorCode::TemporarilyUnavailable);
        assert_eq!(
            connection_phase_for_error(&error),
            CloudConnectionPhase::Offline
        );
    }

    #[test]
    fn cache_hydration_never_overwrites_an_in_flight_refresh() {
        let store = CloudDesktopStateStore::default();
        store.begin_refresh();

        assert!(!store.hydrate_cached_context(cached_context()));
        let snapshot = store.snapshot();
        assert_eq!(snapshot.connection, CloudConnectionPhase::Refreshing);
        assert!(snapshot.context.is_none());
    }
}
