use std::error::Error;
use std::sync::{Arc, Mutex};

use super::backend_bridge::{
    backend_gateway_operations_with_prepared_plans, spawn_backend_bridge_client,
    BackendBridgeClientHandle, GatewayDispatcher, PreparedPlanRegistry,
};
use super::endpoint::{generate_access_token, AiRuntimeEndpoint, AiRuntimeMode};
use super::port::{resolve_development_port, resolve_production_port, AI_RUNTIME_HOST};
use super::process::{start_ai_runtime_sidecar, AiRuntimeSidecar};
use crate::db::DatabaseState;
use crate::engine::manager::ConnectionRuntimeManager;
use crate::workbench::runtime_events::TauriWorkbenchRuntimeEventSink;
use tauri::{AppHandle, Runtime};

/// Tauri managed state，持有已解析的 AI Runtime endpoint。
/// 在 `setup()` 阶段初始化一次，通过 `get_ai_runtime_endpoint` IPC 命令暴露给前端。
pub struct AiRuntimeState {
    endpoint: AiRuntimeEndpoint,
    bridge_client: Mutex<Option<BackendBridgeClientHandle>>,
    sidecar: Mutex<Option<AiRuntimeSidecar>>,
    prepared_plans: PreparedPlanRegistry,
}

impl AiRuntimeState {
    pub fn initialize<R: Runtime>(
        app: &AppHandle<R>,
        database: DatabaseState,
        runtime_manager: ConnectionRuntimeManager,
        prepared_plans: PreparedPlanRegistry,
    ) -> Result<Self, Box<dyn Error>> {
        let mode = runtime_mode();
        let port = match mode {
            AiRuntimeMode::Development => resolve_development_port(),
            AiRuntimeMode::Production => resolve_production_port()?,
        };
        let access_token = match mode {
            AiRuntimeMode::Development => None,
            AiRuntimeMode::Production => Some(generate_access_token()?),
        };
        let endpoint = AiRuntimeEndpoint::new(AI_RUNTIME_HOST, port, mode, access_token.clone());

        let sidecar = match mode {
            AiRuntimeMode::Development => None,
            AiRuntimeMode::Production => {
                let sidecar = start_ai_runtime_sidecar(
                    app,
                    AI_RUNTIME_HOST,
                    port,
                    access_token
                        .as_deref()
                        .expect("production token must exist"),
                )?;
                tauri_plugin_log::log::info!(
                    "AI Runtime sidecar started with pid {}",
                    sidecar.pid()
                );
                Some(sidecar)
            }
        };

        let gateway = GatewayDispatcher::new(backend_gateway_operations_with_prepared_plans(
            database,
            runtime_manager,
            Arc::new(TauriWorkbenchRuntimeEventSink::new(app.clone())),
            prepared_plans.clone(),
        ))
        .expect("static Gateway registry must be valid")
        .with_prepared_plans(prepared_plans.clone());
        let bridge_client = spawn_backend_bridge_client(endpoint.clone(), Arc::new(gateway));

        Ok(Self {
            endpoint,
            bridge_client: Mutex::new(Some(bridge_client)),
            sidecar: Mutex::new(sidecar),
            prepared_plans,
        })
    }

    pub fn endpoint(&self) -> AiRuntimeEndpoint {
        self.endpoint.clone()
    }

    pub fn shutdown_sidecar(&self) {
        self.prepared_plans.clear_all();
        match self.bridge_client.lock() {
            Ok(mut bridge_client) => {
                if let Some(mut bridge_client) = bridge_client.take() {
                    bridge_client.shutdown();
                }
            }
            Err(error) => {
                tauri_plugin_log::log::error!(
                    "Failed to lock AI Runtime Backend Bridge state: {error}"
                );
            }
        }
        match self.sidecar.lock() {
            Ok(mut sidecar) => {
                sidecar.take();
            }
            Err(error) => {
                tauri_plugin_log::log::error!(
                    "Failed to lock AI Runtime sidecar state for shutdown: {error}"
                );
            }
        }
    }
}

impl Drop for AiRuntimeState {
    fn drop(&mut self) {
        self.prepared_plans.clear_all();
        match self.bridge_client.get_mut() {
            Ok(bridge_client) => {
                if let Some(mut bridge_client) = bridge_client.take() {
                    bridge_client.shutdown();
                }
            }
            Err(error) => {
                tauri_plugin_log::log::error!(
                    "Failed to access AI Runtime Backend Bridge during drop: {error}"
                );
            }
        }
        match self.sidecar.get_mut() {
            Ok(sidecar) => {
                sidecar.take();
            }
            Err(error) => {
                tauri_plugin_log::log::error!(
                    "Failed to access AI Runtime sidecar state during drop: {error}"
                );
            }
        }
    }
}

fn runtime_mode() -> AiRuntimeMode {
    if cfg!(debug_assertions) {
        AiRuntimeMode::Development
    } else {
        AiRuntimeMode::Production
    }
}
