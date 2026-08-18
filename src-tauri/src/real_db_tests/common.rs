use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};

use serde_json::Value as JsonValue;

const ENV_FILE: &str = ".env.test";

pub(super) fn run_async<F>(future: F)
where
    F: Future<Output = ()>,
{
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build test runtime")
        .block_on(future);
}

pub(super) struct TestEnv {
    values: HashMap<String, String>,
}

impl TestEnv {
    pub(super) fn load() -> Option<Self> {
        let path = find_env_file()?;
        let contents = std::fs::read_to_string(&path).unwrap_or_else(|error| {
            panic!(
                "failed to read {} for real database tests: {error}",
                path.display()
            )
        });
        Some(Self {
            values: parse_env_file(&contents),
        })
    }

    pub(super) fn enabled(&self, key: &str) -> bool {
        self.bool_or(key, false)
    }

    pub(super) fn required(&self, key: &str) -> String {
        self.optional(key)
            .unwrap_or_else(|| panic!("{key} must be set in {ENV_FILE} when its driver is enabled"))
    }

    pub(super) fn optional(&self, key: &str) -> Option<String> {
        self.values
            .get(key)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    pub(super) fn bool_or(&self, key: &str, default: bool) -> bool {
        self.optional(key)
            .map(|value| {
                matches!(
                    value.to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            })
            .unwrap_or(default)
    }

    pub(super) fn u8_or(&self, key: &str, default: u8) -> u8 {
        self.optional(key)
            .map(|value| {
                value
                    .parse()
                    .unwrap_or_else(|_| panic!("{key} must be an integer"))
            })
            .unwrap_or(default)
    }

    pub(super) fn u16_or(&self, key: &str, default: u16) -> u16 {
        self.optional(key)
            .map(|value| {
                value
                    .parse()
                    .unwrap_or_else(|_| panic!("{key} must be an integer"))
            })
            .unwrap_or(default)
    }

    pub(super) fn u64_or(&self, key: &str, default: u64) -> u64 {
        self.optional(key)
            .map(|value| {
                value
                    .parse()
                    .unwrap_or_else(|_| panic!("{key} must be an integer"))
            })
            .unwrap_or(default)
    }
}

fn find_env_file() -> Option<PathBuf> {
    let mut current = std::env::current_dir().ok()?;
    loop {
        let candidate = current.join(ENV_FILE);
        if candidate.exists() {
            return Some(candidate);
        }
        if !current.pop() {
            break;
        }
    }

    let repo_root_candidate = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(ENV_FILE);
    repo_root_candidate.exists().then_some(repo_root_candidate)
}

fn parse_env_file(contents: &str) -> HashMap<String, String> {
    contents
        .lines()
        .filter_map(parse_env_line)
        .collect::<HashMap<_, _>>()
}

fn parse_env_line(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let (key, value) = line.split_once('=')?;
    let key = key.trim();
    if key.is_empty() {
        return None;
    }
    Some((key.to_string(), unquote_env_value(value.trim()).to_string()))
}

fn unquote_env_value(value: &str) -> &str {
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        if (bytes[0] == b'"' && bytes[value.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'')
        {
            return &value[1..value.len() - 1];
        }
    }
    value
}

pub(super) fn json_cell_text(value: &JsonValue) -> String {
    match value {
        JsonValue::String(value) => value.clone(),
        JsonValue::Number(value) => value.to_string(),
        JsonValue::Bool(value) => value.to_string(),
        JsonValue::Null => "null".to_string(),
        other => other.to_string(),
    }
}
