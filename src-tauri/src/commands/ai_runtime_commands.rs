use tauri::State;

use crate::ai_runtime::endpoint::AiRuntimeEndpoint;
use crate::ai_runtime::state::AiRuntimeState;

/// 返回当前已解析的 AI Runtime endpoint（host、port、mode、base_url）。
/// 前端启动阶段调用此命令，将结果写入 `useAiRuntimeEndpointStore`，
/// 所有后续 AI Runtime API 调用必须复用这里的 `base_url`。
#[tauri::command]
pub fn get_ai_runtime_endpoint(state: State<'_, AiRuntimeState>) -> AiRuntimeEndpoint {
    state.endpoint()
}

/// 显式关闭 Rust 托管的 AI Runtime sidecar。
/// 自动更新安装前调用，避免 Windows 上运行中的 sidecar 锁住随包二进制资源。
#[tauri::command]
pub fn shutdown_ai_runtime_sidecar(state: State<'_, AiRuntimeState>) -> Result<(), String> {
    state.shutdown_sidecar();
    Ok(())
}
