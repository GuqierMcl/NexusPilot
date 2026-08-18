use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::deep_link;

pub const SINGLE_INSTANCE_EVENT: &str = "single-instance";
const MAIN_WINDOW_LABEL: &str = "main";

#[derive(Clone, Serialize)]
pub struct SingleInstancePayload {
    pub args: Vec<String>,
    pub cwd: String,
}

pub fn handle_single_instance<R: Runtime>(app: &AppHandle<R>, args: Vec<String>, cwd: String) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        if let Err(error) = window.show() {
            tauri_plugin_log::log::error!(
                "Failed to show main window for secondary launch: {error}"
            );
        }

        if let Err(error) = window.unminimize() {
            tauri_plugin_log::log::error!(
                "Failed to unminimize main window for secondary launch: {error}"
            );
        }

        if let Err(error) = window.set_focus() {
            tauri_plugin_log::log::error!(
                "Failed to focus main window for secondary launch: {error}"
            );
        }
    } else {
        tauri_plugin_log::log::error!("Main window was not found during secondary launch handling");
    }

    // tauri-plugin-single-instance 的 deep-link feature 已先把 URL 转交给
    // tauri-plugin-deep-link。这里继续发通用激活事件，但不把认证回调参数暴露给 WebView。
    let payload = SingleInstancePayload {
        args: sanitize_activation_args(args),
        cwd,
    };
    if let Err(error) = app.emit(SINGLE_INSTANCE_EVENT, payload) {
        tauri_plugin_log::log::error!("Failed to emit single-instance event: {error}");
    }
}

fn sanitize_activation_args(args: Vec<String>) -> Vec<String> {
    args.into_iter()
        .filter(|argument| !deep_link::uses_configured_scheme(argument))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{sanitize_activation_args, SingleInstancePayload, SINGLE_INSTANCE_EVENT};

    #[test]
    fn single_instance_event_name_is_stable() {
        assert_eq!(SINGLE_INSTANCE_EVENT, "single-instance");
    }

    #[test]
    fn single_instance_payload_serializes_args_and_cwd() {
        let payload = SingleInstancePayload {
            args: vec!["NexusPilot.exe".to_string(), "--from-shortcut".to_string()],
            cwd: "C:\\Users\\demo".to_string(),
        };

        let value = serde_json::to_value(payload).expect("payload should serialize");

        assert_eq!(value["args"][0], "NexusPilot.exe");
        assert_eq!(value["args"][1], "--from-shortcut");
        assert_eq!(value["cwd"], "C:\\Users\\demo");
    }

    #[test]
    fn auth_deep_link_is_not_forwarded_to_the_webview() {
        let args = vec![
            "NexusPilot.exe".to_string(),
            "dev.nexuspilot://auth/callback?code=secret&state=state".to_string(),
        ];

        assert_eq!(sanitize_activation_args(args), vec!["NexusPilot.exe"]);
    }

    #[test]
    fn ordinary_activation_args_are_preserved() {
        let args = vec!["NexusPilot.exe".to_string(), "--from-shortcut".to_string()];

        assert_eq!(
            sanitize_activation_args(args),
            vec!["NexusPilot.exe", "--from-shortcut"]
        );
    }
}
