use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::commands::app_config_commands::release_public_base_url_from_plugin_config;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CurrentReleaseNotes {
    pub version: String,
    pub body: String,
    pub source: ReleaseNotesSource,
    pub fetched_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReleaseNotesSource {
    Cache,
    Remote,
}

fn normalize_version_tag(version: &str) -> String {
    if version.starts_with('v') {
        version.to_string()
    } else {
        format!("v{version}")
    }
}

fn create_release_notes_url(version: &str, release_public_base_url: &str) -> String {
    let version_tag = normalize_version_tag(version);
    let base_url = release_public_base_url.trim().trim_end_matches('/');

    format!("{base_url}/{version_tag}/notes.md")
}

fn release_notes_cache_path(cache_dir: &Path, version: &str) -> PathBuf {
    cache_dir
        .join("release-notes")
        .join(format!("{}.md", normalize_version_tag(version)))
}

fn unix_timestamp_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

async fn read_cached_notes(path: &Path) -> Option<String> {
    match tokio::fs::read_to_string(path).await {
        Ok(body) if !body.trim().is_empty() => Some(body),
        _ => None,
    }
}

async fn write_cached_notes(path: &Path, body: &str) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Err("发布日志缓存路径无效。".to_string());
    };

    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("创建发布日志缓存目录失败：{error}"))?;
    tokio::fs::write(path, body)
        .await
        .map_err(|error| format!("写入发布日志缓存失败：{error}"))?;

    Ok(())
}

async fn fetch_notes_from_remote(url: &str) -> Result<String, String> {
    let client = tauri_plugin_http::reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("创建发布日志 HTTP 客户端失败：{error}"))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("请求当前版本发布日志失败：{error}"))?;

    if !response.status().is_success() {
        return Err(format!("读取当前版本发布日志失败：{}", response.status()));
    }

    response
        .text()
        .await
        .map_err(|error| format!("读取当前版本发布日志正文失败：{error}"))
}

#[tauri::command]
pub async fn get_current_release_notes(app: AppHandle) -> Result<CurrentReleaseNotes, String> {
    let version = app.package_info().version.to_string();
    let cache_path = release_notes_cache_path(
        &app.path()
            .app_cache_dir()
            .map_err(|error| format!("读取应用缓存目录失败：{error}"))?,
        &version,
    );

    if let Some(body) = read_cached_notes(&cache_path).await {
        return Ok(CurrentReleaseNotes {
            version,
            body,
            source: ReleaseNotesSource::Cache,
            fetched_at: None,
        });
    }

    let release_public_base_url =
        release_public_base_url_from_plugin_config(&app.config().plugins)?;
    let url = create_release_notes_url(&version, &release_public_base_url);
    let body = fetch_notes_from_remote(&url).await?;
    write_cached_notes(&cache_path, &body).await?;

    Ok(CurrentReleaseNotes {
        version,
        body,
        source: ReleaseNotesSource::Remote,
        fetched_at: Some(unix_timestamp_seconds()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_versioned_release_notes_url() {
        assert_eq!(
            create_release_notes_url("0.4.1", "https://dl.nexuspilot.dev/releases"),
            "https://dl.nexuspilot.dev/releases/v0.4.1/notes.md"
        );
        assert_eq!(
            create_release_notes_url("v0.4.1", "https://dl.nexuspilot.dev/releases/"),
            "https://dl.nexuspilot.dev/releases/v0.4.1/notes.md"
        );
    }

    #[test]
    fn creates_versioned_cache_path() {
        let path = release_notes_cache_path(Path::new("cache-root"), "0.4.1");

        assert_eq!(
            path,
            Path::new("cache-root")
                .join("release-notes")
                .join("v0.4.1.md")
        );
    }
}
