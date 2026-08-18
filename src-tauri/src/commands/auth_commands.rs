use tauri::State;

use crate::auth::{AuthManager, AuthPublicError, AuthSessionSnapshot};

#[tauri::command]
pub fn get_auth_snapshot(state: State<'_, AuthManager>) -> AuthSessionSnapshot {
    state.snapshot()
}

/// 原始 PNG 二进制响应；revision 不匹配、已退出或缓存异常时返回空数据。
#[tauri::command]
pub fn get_auth_avatar(state: State<'_, AuthManager>, revision: String) -> tauri::ipc::Response {
    tauri::ipc::Response::new(state.avatar_bytes(&revision))
}

#[tauri::command]
pub async fn start_auth_sign_in(
    state: State<'_, AuthManager>,
) -> Result<AuthSessionSnapshot, AuthPublicError> {
    state.start_sign_in().await
}

#[tauri::command]
pub async fn cancel_auth_sign_in(
    state: State<'_, AuthManager>,
) -> Result<AuthSessionSnapshot, AuthPublicError> {
    state.cancel_sign_in().await
}

#[tauri::command]
pub async fn retry_auth_session(
    state: State<'_, AuthManager>,
) -> Result<AuthSessionSnapshot, AuthPublicError> {
    state.retry_session().await
}

#[tauri::command]
pub async fn sign_out_auth_session(
    state: State<'_, AuthManager>,
) -> Result<AuthSessionSnapshot, AuthPublicError> {
    state.sign_out().await
}
