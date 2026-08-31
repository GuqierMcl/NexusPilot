use std::collections::BTreeSet;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::repository::cloud_sync_repository::CloudSyncAssetType;
use crate::repository::connection_folder_repository::StoredConnectionFolder;
use crate::repository::connection_repository::StoredConnectionRecord;

pub const SYNC_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalDependencyKind {
    DatabaseFile,
    SshPrivateKey,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSyncProjection {
    pub schema_version: u32,
    pub asset_type: CloudSyncAssetType,
    pub id: String,
    pub name: String,
    pub driver: String,
    pub environment: String,
    pub color: Option<String>,
    #[serde(default)]
    pub note: String,
    pub tag_label: String,
    pub tag_color: Option<String>,
    pub folder_id: Option<String>,
    pub sort_order: Option<i64>,
    pub payload: Value,
    pub local_dependencies: Vec<LocalDependencyKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionFolderSyncProjection {
    pub schema_version: u32,
    pub asset_type: CloudSyncAssetType,
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct SyncProjectionDigest {
    pub payload_hash: [u8; 32],
}

impl SyncProjectionDigest {
    pub fn as_base64url(self) -> String {
        URL_SAFE_NO_PAD.encode(self.payload_hash)
    }
}

pub fn connection_projection(
    record: &StoredConnectionRecord,
) -> Result<(Vec<u8>, SyncProjectionDigest), serde_json::Error> {
    let dependency_set = collect_local_dependencies(&record.driver, &record.payload);
    let projection = ConnectionSyncProjection {
        schema_version: SYNC_SCHEMA_VERSION,
        asset_type: CloudSyncAssetType::Connection,
        id: record.id.clone(),
        name: record.name.clone(),
        driver: record.driver.as_str().to_string(),
        environment: record.environment.clone(),
        color: record.color.clone(),
        note: record.note.clone(),
        tag_label: record.tag_label.clone(),
        tag_color: record.tag_color.clone(),
        folder_id: record.folder_id.clone(),
        sort_order: record.sort_order,
        payload: sanitize_payload(&record.payload),
        local_dependencies: dependency_set,
    };
    serialize_with_digest(&projection)
}

pub fn folder_projection(
    record: &StoredConnectionFolder,
) -> Result<(Vec<u8>, SyncProjectionDigest), serde_json::Error> {
    let projection = ConnectionFolderSyncProjection {
        schema_version: SYNC_SCHEMA_VERSION,
        asset_type: CloudSyncAssetType::ConnectionFolder,
        id: record.id.clone(),
        name: record.name.clone(),
        parent_id: record.parent_id.clone(),
        sort_order: record.sort_order,
    };
    serialize_with_digest(&projection)
}

fn serialize_with_digest<T: Serialize>(
    projection: &T,
) -> Result<(Vec<u8>, SyncProjectionDigest), serde_json::Error> {
    let canonical = canonicalize_json(serde_json::to_value(projection)?);
    let bytes = serde_json::to_vec(&canonical)?;
    let mut digest = Sha256::new();
    digest.update(&bytes);
    let payload_hash: [u8; 32] = digest.finalize().into();
    Ok((bytes, SyncProjectionDigest { payload_hash }))
}

#[derive(Debug, Clone, Copy, Eq, Ord, PartialEq, PartialOrd)]
enum DependencyName {
    DatabaseFile,
    SshPrivateKey,
}

pub(crate) fn collect_local_dependencies(
    driver: &crate::repository::connection_repository::ConnectionDriver,
    payload: &Value,
) -> Vec<LocalDependencyKind> {
    let mut dependencies = BTreeSet::new();

    match driver {
        crate::repository::connection_repository::ConnectionDriver::Sqlite => {
            dependencies.insert(DependencyName::DatabaseFile);
        }
        crate::repository::connection_repository::ConnectionDriver::Chroma
            if payload.get("mode").and_then(Value::as_str) == Some("local") =>
        {
            dependencies.insert(DependencyName::DatabaseFile);
        }
        _ => {}
    }

    let ssh_tunnel = payload.get("sshTunnel").and_then(Value::as_object);
    if ssh_tunnel
        .and_then(|value| value.get("enabled"))
        .and_then(Value::as_bool)
        == Some(true)
        && ssh_tunnel
            .and_then(|value| value.get("authMethod"))
            .and_then(Value::as_str)
            == Some("private-key")
    {
        dependencies.insert(DependencyName::SshPrivateKey);
    }

    dependencies
        .into_iter()
        .map(|kind| match kind {
            DependencyName::DatabaseFile => LocalDependencyKind::DatabaseFile,
            DependencyName::SshPrivateKey => LocalDependencyKind::SshPrivateKey,
        })
        .collect()
}

fn sanitize_payload(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut sanitized = Map::new();
            for (key, value) in object {
                if matches!(key.as_str(), "dbFilePath" | "privateKeyPath") {
                    continue;
                }
                sanitized.insert(key.clone(), sanitize_payload(value));
            }
            Value::Object(sanitized)
        }
        Value::Array(items) => Value::Array(items.iter().map(sanitize_payload).collect()),
        _ => value.clone(),
    }
}

fn canonicalize_json(value: Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut entries = object.into_iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key, canonicalize_json(value)))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.into_iter().map(canonicalize_json).collect()),
        _ => value,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{connection_projection, folder_projection, LocalDependencyKind};
    use crate::repository::connection_folder_repository::StoredConnectionFolder;
    use crate::repository::connection_repository::{ConnectionDriver, StoredConnectionRecord};

    #[test]
    fn connection_projection_strips_machine_paths_and_records_dependencies() {
        let record = StoredConnectionRecord {
            id: "connection-1".to_string(),
            name: "Local SQLite".to_string(),
            driver: ConnectionDriver::Sqlite,
            environment: "development".to_string(),
            color: None,
            note: "Local development database".to_string(),
            tag_label: String::new(),
            tag_color: None,
            payload: json!({
                "driver": "sqlite",
                "dbFilePath": "C:/private/database.sqlite",
                "sshTunnel": {
                    "enabled": true,
                    "authMethod": "private-key",
                    "privateKeyPath": "C:/private/id_ed25519"
                }
            }),
            folder_id: None,
            created_at: 1,
            updated_at: 2,
            last_connected_at: Some(3),
            last_connection_status: None,
            last_connection_error: Some("must not sync".to_string()),
            sort_order: Some(4),
        };

        let (bytes, digest) = connection_projection(&record).unwrap();
        let projection: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(projection
            .get("payload")
            .unwrap()
            .get("dbFilePath")
            .is_none());
        assert!(projection
            .get("payload")
            .unwrap()
            .get("sshTunnel")
            .unwrap()
            .get("privateKeyPath")
            .is_none());
        assert_eq!(
            projection.get("localDependencies").unwrap(),
            &json!(["database_file", "ssh_private_key"])
        );
        assert_eq!(
            projection.get("note").unwrap(),
            "Local development database"
        );
        assert!(!bytes.windows(10).any(|window| window == b"database.s"));
        assert!(!digest.as_base64url().is_empty());
    }

    #[test]
    fn folder_projection_is_stable_for_same_content() {
        let folder = StoredConnectionFolder {
            id: "folder-1".to_string(),
            name: "Production".to_string(),
            parent_id: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            sort_order: Some(1),
        };
        let first = folder_projection(&folder).unwrap();
        let second = folder_projection(&folder).unwrap();
        assert_eq!(first.0, second.0);
        assert_eq!(first.1, second.1);
    }

    #[test]
    fn dependency_enum_serializes_as_stable_user_independent_values() {
        assert_eq!(
            serde_json::to_string(&LocalDependencyKind::DatabaseFile).unwrap(),
            "\"database_file\""
        );
    }

    #[test]
    fn connection_note_changes_digest_and_defaults_for_legacy_projections() {
        let record = StoredConnectionRecord {
            id: "connection-1".to_string(),
            name: "Postgres".to_string(),
            driver: ConnectionDriver::Postgres,
            environment: "development".to_string(),
            color: None,
            note: "Primary".to_string(),
            tag_label: String::new(),
            tag_color: None,
            payload: json!({ "host": "db.example.com" }),
            folder_id: None,
            created_at: 0,
            updated_at: 0,
            last_connected_at: None,
            last_connection_status: None,
            last_connection_error: None,
            sort_order: None,
        };

        let (_, first_digest) = connection_projection(&record).unwrap();
        let changed = StoredConnectionRecord {
            note: "Replica".to_string(),
            ..record
        };
        let (_, second_digest) = connection_projection(&changed).unwrap();
        assert_ne!(first_digest, second_digest);

        let legacy = json!({
            "schemaVersion": 1,
            "assetType": "connection",
            "id": "legacy-1",
            "name": "Legacy",
            "driver": "postgres",
            "environment": "development",
            "color": null,
            "tagLabel": "",
            "tagColor": null,
            "folderId": null,
            "sortOrder": null,
            "payload": {},
            "localDependencies": []
        });
        let projection: super::ConnectionSyncProjection =
            serde_json::from_value(legacy).expect("legacy projection should parse");
        assert_eq!(projection.note, "");
    }

    #[test]
    fn local_dependencies_follow_connection_semantics_not_field_names() {
        let sqlite = StoredConnectionRecord {
            id: "sqlite-1".to_string(),
            name: "SQLite".to_string(),
            driver: ConnectionDriver::Sqlite,
            environment: "development".to_string(),
            color: None,
            note: String::new(),
            tag_label: String::new(),
            tag_color: None,
            payload: json!({ "driver": "sqlite", "dbFilePath": "" }),
            folder_id: None,
            created_at: 0,
            updated_at: 0,
            last_connected_at: None,
            last_connection_status: None,
            last_connection_error: None,
            sort_order: None,
        };
        let (_, sqlite_digest) = connection_projection(&sqlite).unwrap();

        let network = StoredConnectionRecord {
            driver: ConnectionDriver::Postgres,
            payload: json!({
                "driver": "postgres",
                "sshTunnel": {
                    "enabled": false,
                    "authMethod": "private-key",
                    "privateKeyPath": "old-key"
                }
            }),
            ..sqlite.clone()
        };
        let (network_bytes, _) = connection_projection(&network).unwrap();
        let network_projection: serde_json::Value = serde_json::from_slice(&network_bytes).unwrap();
        assert_eq!(network_projection["localDependencies"], json!([]));

        let ssh_network = StoredConnectionRecord {
            payload: json!({
                "driver": "postgres",
                "sshTunnel": {
                    "enabled": true,
                    "authMethod": "private-key",
                    "privateKeyPath": "old-key"
                }
            }),
            ..network
        };
        let (ssh_bytes, _) = connection_projection(&ssh_network).unwrap();
        let ssh_projection: serde_json::Value = serde_json::from_slice(&ssh_bytes).unwrap();
        assert_eq!(
            ssh_projection["localDependencies"],
            json!(["ssh_private_key"])
        );
        assert_ne!(
            sqlite_digest,
            connection_projection(&ssh_network).unwrap().1
        );
    }
}
