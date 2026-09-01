use std::error::Error;
use std::fs;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use super::AI_RUNTIME_LOG_TARGET;

const AI_RUNTIME_SIDECAR_NAME: &str = "ai-runtime";
const AI_RUNTIME_DIR_NAME: &str = "ai-runtime";
const AI_RUNTIME_DATA_DIR_ENV: &str = "NEXUS_PILOT_DATA_DIR";
const AI_RUNTIME_CACHE_DIR_ENV: &str = "NEXUS_PILOT_CACHE_DIR";
const AI_RUNTIME_ACCESS_TOKEN_ENV: &str = "NEXUS_PILOT_AI_RUNTIME_ACCESS_TOKEN";
const AI_RUNTIME_LOG_FORMAT_ENV: &str = "NEXUS_PILOT_LOG_FORMAT";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub struct AiRuntimeSidecar {
    child: Option<CommandChild>,
    pid: u32,
}

impl AiRuntimeSidecar {
    pub fn pid(&self) -> u32 {
        self.pid
    }
}

impl Drop for AiRuntimeSidecar {
    fn drop(&mut self) {
        if let Some(child) = self.child.take() {
            if let Err(error) = kill_sidecar_process_tree(self.pid, child) {
                tauri_plugin_log::log::error!(
                    "Failed to kill AI Runtime sidecar {}: {error}",
                    self.pid
                );
            }
        }
    }
}

#[cfg(windows)]
fn kill_sidecar_process_tree(pid: u32, child: CommandChild) -> Result<(), Box<dyn Error>> {
    let status = Command::new("taskkill")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();

    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(_) | Err(_) => {
            child.kill()?;
            Ok(())
        }
    }
}

#[cfg(not(windows))]
fn kill_sidecar_process_tree(_pid: u32, child: CommandChild) -> Result<(), Box<dyn Error>> {
    child.kill()?;
    Ok(())
}

pub fn start_ai_runtime_sidecar<R: Runtime>(
    app: &AppHandle<R>,
    host: &str,
    port: u16,
    access_token: &str,
) -> Result<AiRuntimeSidecar, Box<dyn Error>> {
    let data_dir = app.path().app_data_dir()?.join(AI_RUNTIME_DIR_NAME);
    let cache_dir = app.path().app_cache_dir()?.join(AI_RUNTIME_DIR_NAME);
    fs::create_dir_all(&data_dir)?;
    fs::create_dir_all(&cache_dir)?;

    let data_dir_arg = data_dir.to_string_lossy().into_owned();
    let cache_dir_arg = cache_dir.to_string_lossy().into_owned();

    let (mut events, child) = app
        .shell()
        .sidecar(AI_RUNTIME_SIDECAR_NAME)?
        .args(build_ai_runtime_sidecar_args(
            host,
            port,
            &data_dir_arg,
            &cache_dir_arg,
        ))
        .env(AI_RUNTIME_DATA_DIR_ENV, data_dir_arg)
        .env(AI_RUNTIME_CACHE_DIR_ENV, cache_dir_arg)
        .env(AI_RUNTIME_ACCESS_TOKEN_ENV, access_token)
        .env(AI_RUNTIME_LOG_FORMAT_ENV, "json")
        .env("NO_COLOR", "1")
        .spawn()?;

    let pid = child.pid();

    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    forward_ai_runtime_log_line(pid, &line);
                }
                CommandEvent::Stderr(line) => {
                    let line = String::from_utf8_lossy(&line);
                    tauri_plugin_log::log::warn!(
                        target: AI_RUNTIME_LOG_TARGET,
                        "[ai-runtime:{pid}] {}",
                        line.trim_end()
                    );
                }
                CommandEvent::Error(error) => {
                    tauri_plugin_log::log::error!(
                        target: AI_RUNTIME_LOG_TARGET,
                        "[ai-runtime:{pid}] event error: {error}"
                    );
                }
                CommandEvent::Terminated(payload) => {
                    let message = format!(
                        "[ai-runtime:{pid}] terminated with code {:?}, signal {:?}",
                        payload.code, payload.signal
                    );
                    if payload.code == Some(0) {
                        tauri_plugin_log::log::info!(target: AI_RUNTIME_LOG_TARGET, "{message}");
                    } else {
                        tauri_plugin_log::log::warn!(target: AI_RUNTIME_LOG_TARGET, "{message}");
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(AiRuntimeSidecar {
        child: Some(child),
        pid,
    })
}

fn build_ai_runtime_sidecar_args(
    host: &str,
    port: u16,
    data_dir: &str,
    cache_dir: &str,
) -> Vec<String> {
    vec![
        "--host".to_string(),
        host.to_string(),
        "--port".to_string(),
        port.to_string(),
        "--data-dir".to_string(),
        data_dir.to_string(),
        "--cache-dir".to_string(),
        cache_dir.to_string(),
    ]
}

fn forward_ai_runtime_log_line(pid: u32, line: &[u8]) {
    let line = String::from_utf8_lossy(line);
    let message = format!("[ai-runtime:{pid}] {}", line.trim_end());
    let level = serde_json::from_str::<serde_json::Value>(&line)
        .ok()
        .and_then(|payload| payload.get("level").and_then(serde_json::Value::as_u64));

    match level {
        Some(50..) => tauri_plugin_log::log::error!(target: AI_RUNTIME_LOG_TARGET, "{message}"),
        Some(40..) => tauri_plugin_log::log::warn!(target: AI_RUNTIME_LOG_TARGET, "{message}"),
        Some(20..) => tauri_plugin_log::log::debug!(target: AI_RUNTIME_LOG_TARGET, "{message}"),
        Some(10..) => tauri_plugin_log::log::trace!(target: AI_RUNTIME_LOG_TARGET, "{message}"),
        _ => tauri_plugin_log::log::info!(target: AI_RUNTIME_LOG_TARGET, "{message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::build_ai_runtime_sidecar_args;

    #[test]
    fn builds_sidecar_args_with_independent_data_and_cache_directories() {
        let args = build_ai_runtime_sidecar_args(
            "127.0.0.1",
            8787,
            "C:/NexusPilot/data/ai-runtime",
            "C:/NexusPilot/cache/ai-runtime",
        );

        assert_eq!(
            args,
            vec![
                "--host",
                "127.0.0.1",
                "--port",
                "8787",
                "--data-dir",
                "C:/NexusPilot/data/ai-runtime",
                "--cache-dir",
                "C:/NexusPilot/cache/ai-runtime",
            ]
        );
    }
}
