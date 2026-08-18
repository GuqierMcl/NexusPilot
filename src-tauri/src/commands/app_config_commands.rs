use serde::Deserialize;
use tauri::AppHandle;

#[derive(Debug, Deserialize)]
struct UpdaterPluginConfig {
    endpoints: Vec<String>,
}

pub(crate) fn derive_release_public_base_url_from_endpoint(
    endpoint: &str,
) -> Result<String, String> {
    let normalized = endpoint.trim().trim_end_matches('/');
    let Some(base_url) = normalized.strip_suffix("/latest.json") else {
        return Err("Tauri updater endpoint 必须以 /latest.json 结尾".to_string());
    };

    if !base_url.starts_with("https://") && !base_url.starts_with("http://") {
        return Err("Tauri updater endpoint 必须是 http(s) URL".to_string());
    }

    Ok(base_url.to_string())
}

pub(crate) fn release_public_base_url_from_plugin_config(
    plugins: &tauri::utils::config::PluginConfig,
) -> Result<String, String> {
    let updater_value = plugins
        .0
        .get("updater")
        .ok_or_else(|| "tauri.conf.json 缺少 plugins.updater 配置".to_string())?;
    let updater_config: UpdaterPluginConfig = serde_json::from_value(updater_value.clone())
        .map_err(|error| format!("无法解析 plugins.updater 配置：{error}"))?;
    let endpoint = updater_config
        .endpoints
        .first()
        .ok_or_else(|| "plugins.updater.endpoints 至少需要配置一个 endpoint".to_string())?;

    derive_release_public_base_url_from_endpoint(endpoint)
}

#[tauri::command]
pub fn get_release_public_base_url(app: AppHandle) -> Result<String, String> {
    release_public_base_url_from_plugin_config(&app.config().plugins)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn derives_release_public_base_url_from_latest_endpoint() {
        let base_url = derive_release_public_base_url_from_endpoint(
            "https://dl.nexuspilot.dev/releases/latest.json",
        )
        .expect("endpoint should derive");

        assert_eq!(base_url, "https://dl.nexuspilot.dev/releases");
    }

    #[test]
    fn trims_trailing_slash_after_latest_json() {
        let base_url = derive_release_public_base_url_from_endpoint(
            "https://dl.nexuspilot.dev/releases/latest.json/",
        )
        .expect("endpoint should derive");

        assert_eq!(base_url, "https://dl.nexuspilot.dev/releases");
    }

    #[test]
    fn rejects_endpoint_that_is_not_latest_manifest() {
        let error = derive_release_public_base_url_from_endpoint(
            "https://dl.nexuspilot.dev/releases/index.json",
        )
        .expect_err("endpoint should be rejected");

        assert!(error.contains("/latest.json"));
    }

    #[test]
    fn reads_first_updater_endpoint_from_plugin_config() {
        let plugins = tauri::utils::config::PluginConfig(HashMap::from([(
            "updater".to_string(),
            json!({
                "pubkey": "test",
                "endpoints": [
                    "https://dl.nexuspilot.dev/releases/latest.json"
                ],
                "windows": {
                    "installMode": "passive"
                }
            }),
        )]));

        let base_url = release_public_base_url_from_plugin_config(&plugins)
            .expect("updater config should derive");

        assert_eq!(base_url, "https://dl.nexuspilot.dev/releases");
    }
}
