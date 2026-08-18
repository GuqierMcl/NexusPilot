use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use crate::engine::types::ConnectionRuntimeSnapshot;

pub const CONNECTION_RUNTIME_CHANGED_EVENT: &str = "connection-runtime-changed";

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeChangeOrigin {
    Frontend,
    AiRuntime,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ConnectionRuntimeChanged {
    Upsert {
        origin: RuntimeChangeOrigin,
        snapshot: ConnectionRuntimeSnapshot,
    },
    Removed {
        origin: RuntimeChangeOrigin,
        #[serde(rename = "profileId")]
        profile_id: String,
    },
}

pub trait WorkbenchRuntimeEventSink: Send + Sync {
    fn publish(&self, event: ConnectionRuntimeChanged) -> Result<(), String>;
}

pub struct TauriWorkbenchRuntimeEventSink<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> TauriWorkbenchRuntimeEventSink<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> WorkbenchRuntimeEventSink for TauriWorkbenchRuntimeEventSink<R> {
    fn publish(&self, event: ConnectionRuntimeChanged) -> Result<(), String> {
        self.app
            .emit(CONNECTION_RUNTIME_CHANGED_EVENT, event)
            .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{ConnectionRuntimeChanged, RuntimeChangeOrigin};
    use crate::engine::types::{
        ConnectionRuntimeInfo, ConnectionRuntimeSnapshot, DriverCapabilities,
        RuntimeHealthSnapshot, RuntimeHealthStatus,
    };

    #[test]
    fn runtime_change_contract_uses_stable_camel_case_tags() {
        let event = ConnectionRuntimeChanged::Upsert {
            origin: RuntimeChangeOrigin::AiRuntime,
            snapshot: ConnectionRuntimeSnapshot {
                profile_id: "profile-1".to_string(),
                runtime: ConnectionRuntimeInfo {
                    profile_id: "profile-1".to_string(),
                    driver_name: "mysql".to_string(),
                    capabilities: DriverCapabilities::default(),
                },
                health: RuntimeHealthSnapshot {
                    profile_id: "profile-1".to_string(),
                    status: RuntimeHealthStatus::Healthy,
                    consecutive_failures: 0,
                    last_success_at_ms: Some(10),
                    last_failure_at_ms: None,
                    last_error_code: None,
                },
            },
        };

        let value = serde_json::to_value(event).expect("event should serialize");
        assert_eq!(value["kind"], json!("upsert"));
        assert_eq!(value["origin"], json!("aiRuntime"));
        assert_eq!(value["snapshot"]["profileId"], json!("profile-1"));
        assert_eq!(value["snapshot"]["health"]["status"], json!("healthy"));

        let removed = serde_json::to_value(ConnectionRuntimeChanged::Removed {
            origin: RuntimeChangeOrigin::Frontend,
            profile_id: "profile-2".to_string(),
        })
        .expect("removed event should serialize");
        assert_eq!(
            removed,
            json!({
                "kind": "removed",
                "origin": "frontend",
                "profileId": "profile-2"
            })
        );
    }
}
