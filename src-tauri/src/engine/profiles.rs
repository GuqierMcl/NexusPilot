use std::fmt;

use serde::{Deserialize, Serialize};

use crate::error::{IpcError, IpcResult};
use crate::repository::connection_repository::StoredConnectionRecord;

fn default_host() -> String {
    "localhost".to_string()
}

fn default_mysql_port() -> u16 {
    3306
}

fn default_postgres_port() -> u16 {
    5432
}

fn default_oracle_port() -> u16 {
    1521
}

fn default_clickhouse_port() -> u16 {
    8123
}

fn default_clickhouse_username() -> String {
    "default".to_string()
}

fn default_redis_port() -> u16 {
    6379
}

fn default_sqlite_read_only() -> bool {
    true
}

fn default_ssh_port() -> u16 {
    22
}

fn default_ssh_auth_method() -> SshAuthMethod {
    SshAuthMethod::Password
}

fn default_ssh_host_verification() -> SshHostVerificationMode {
    SshHostVerificationMode::TrustOnFirstUse
}

fn default_oracle_role() -> OracleRole {
    OracleRole::Normal
}

fn default_clickhouse_protocol() -> ClickHouseProtocol {
    ClickHouseProtocol::Http
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SshAuthMethod {
    Password,
    PrivateKey,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SshHostVerificationMode {
    TrustOnFirstUse,
    Skip,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelProfile {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default = "default_ssh_auth_method")]
    pub auth_method: SshAuthMethod,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub private_key_path: Option<String>,
    #[serde(default)]
    pub private_key_passphrase: Option<String>,
    #[serde(default = "default_ssh_host_verification")]
    pub host_verification: SshHostVerificationMode,
    #[serde(default)]
    pub host_key_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "driver", rename_all = "lowercase")]
pub enum DriverProfile {
    Clickhouse(ClickHouseProfile),
    Mysql(MysqlProfile),
    Postgres(PostgresProfile),
    Oracle(OracleProfile),
    Redis(RedisProfile),
    Sqlite(SqliteProfile),
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ClickHouseProtocol {
    Http,
    Https,
    #[serde(other)]
    Unsupported,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseProfile {
    #[serde(default = "default_host")]
    pub host: String,
    #[serde(default = "default_clickhouse_port")]
    pub port: u16,
    #[serde(default = "default_clickhouse_username")]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub default_database: Option<String>,
    #[serde(default = "default_clickhouse_protocol")]
    pub protocol: ClickHouseProtocol,
    #[serde(default)]
    pub connect_timeout_seconds: Option<u64>,
    #[serde(default)]
    pub ssh_tunnel: Option<SshTunnelProfile>,
}

impl fmt::Debug for ClickHouseProfile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClickHouseProfile")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("password", &"[REDACTED]")
            .field("default_database", &self.default_database)
            .field("protocol", &self.protocol)
            .field("connect_timeout_seconds", &self.connect_timeout_seconds)
            .field(
                "ssh_tunnel",
                &self.ssh_tunnel.as_ref().map(|tunnel| {
                    format!(
                        "enabled={} host={} port={} username={} credentials=[REDACTED]",
                        tunnel.enabled, tunnel.host, tunnel.port, tunnel.username
                    )
                }),
            )
            .finish()
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MysqlProfile {
    #[serde(default = "default_host")]
    pub host: String,
    #[serde(default = "default_mysql_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub default_database: Option<String>,
    #[serde(default)]
    pub connect_timeout_seconds: Option<u64>,
    #[serde(default)]
    pub ssh_tunnel: Option<SshTunnelProfile>,
    #[serde(default)]
    pub ssl_mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresProfile {
    #[serde(default = "default_host")]
    pub host: String,
    #[serde(default = "default_postgres_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub default_database: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(default)]
    pub ssl_mode: Option<String>,
    #[serde(default)]
    pub connect_timeout_seconds: Option<u64>,
    #[serde(default)]
    pub ssh_tunnel: Option<SshTunnelProfile>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OracleRole {
    Normal,
    Sysdba,
    Sysoper,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleProfile {
    #[serde(default = "default_host")]
    pub host: String,
    #[serde(default = "default_oracle_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub service_name: Option<String>,
    #[serde(default)]
    pub sid: Option<String>,
    #[serde(default)]
    pub connect_descriptor: Option<String>,
    #[serde(default = "default_oracle_role")]
    pub role: OracleRole,
    #[serde(default)]
    pub connect_timeout_seconds: Option<u64>,
    #[serde(default)]
    pub ssh_tunnel: Option<SshTunnelProfile>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisProfile {
    #[serde(default = "default_host")]
    pub host: String,
    #[serde(default = "default_redis_port")]
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub db_index: Option<u8>,
    #[serde(default)]
    pub use_tls: bool,
    #[serde(default)]
    pub connect_timeout_seconds: Option<u64>,
    #[serde(default)]
    pub ssh_tunnel: Option<SshTunnelProfile>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteProfile {
    #[serde(default)]
    pub db_file_path: String,
    #[serde(default = "default_sqlite_read_only")]
    pub is_read_only: bool,
}

pub fn driver_profile_from_record(record: &StoredConnectionRecord) -> IpcResult<DriverProfile> {
    let mut payload = record.payload.clone();
    let payload_object = payload.as_object_mut().ok_or_else(|| {
        IpcError::system_internal(
            "Connection payload must be a JSON object",
            format!("Profile '{}' has invalid payload", record.id),
        )
    })?;

    payload_object.insert(
        "driver".to_string(),
        serde_json::Value::String(record.driver.as_str().to_string()),
    );
    normalize_optional_string(payload_object, "defaultDatabase");
    normalize_optional_string(payload_object, "serviceName");
    normalize_optional_string(payload_object, "sid");
    normalize_optional_string(payload_object, "connectDescriptor");

    serde_json::from_value(payload).map_err(|error| {
        IpcError::system_internal("Failed to parse connection profile", error.to_string())
    })
}

fn normalize_optional_string(payload: &mut serde_json::Map<String, serde_json::Value>, key: &str) {
    let should_clear = payload
        .get(key)
        .and_then(|value| value.as_str())
        .is_some_and(|value| value.trim().is_empty());

    if should_clear {
        payload.insert(key.to_string(), serde_json::Value::Null);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::repository::connection_repository::ConnectionDriver;

    fn record(driver: ConnectionDriver, payload: serde_json::Value) -> StoredConnectionRecord {
        StoredConnectionRecord {
            id: "profile-1".to_string(),
            name: "Test".to_string(),
            driver,
            environment: "development".to_string(),
            color: None,
            tag_label: String::new(),
            tag_color: None,
            payload,
            folder_id: None,
            created_at: 0,
            updated_at: 0,
            last_connected_at: None,
            last_connection_status: None,
            last_connection_error: None,
            sort_order: None,
        }
    }

    #[test]
    fn injects_driver_before_profile_deserialization() {
        let parsed = driver_profile_from_record(&record(
            ConnectionDriver::Mysql,
            json!({
                "host": "127.0.0.1",
                "port": 3307,
                "username": "root",
                "password": "secret",
                "defaultDatabase": "app"
            }),
        ))
        .expect("profile should parse");

        match parsed {
            DriverProfile::Mysql(profile) => {
                assert_eq!(profile.host, "127.0.0.1");
                assert_eq!(profile.port, 3307);
                assert_eq!(profile.default_database.as_deref(), Some("app"));
            }
            _ => panic!("expected mysql profile"),
        }
    }

    #[test]
    fn parses_redis_profile_defaults() {
        let parsed = driver_profile_from_record(&record(
            ConnectionDriver::Redis,
            json!({
                "password": "secret",
                "dbIndex": 2
            }),
        ))
        .expect("profile should parse");

        match parsed {
            DriverProfile::Redis(profile) => {
                assert_eq!(profile.host, "localhost");
                assert_eq!(profile.port, 6379);
                assert_eq!(profile.db_index, Some(2));
                assert!(!profile.use_tls);
            }
            _ => panic!("expected redis profile"),
        }
    }

    #[test]
    fn clickhouse_profile_defaults_to_http_transport() {
        let parsed = driver_profile_from_record(&record(
            ConnectionDriver::Clickhouse,
            json!({
                "password": "secret"
            }),
        ))
        .expect("ClickHouse profile should parse");

        match parsed {
            DriverProfile::Clickhouse(profile) => {
                assert_eq!(profile.host, "localhost");
                assert_eq!(profile.port, 8123);
                assert_eq!(profile.username, "default");
                assert_eq!(profile.default_database, None);
                assert_eq!(profile.protocol, ClickHouseProtocol::Http);
            }
            _ => panic!("expected ClickHouse profile"),
        }
    }

    #[test]
    fn clickhouse_profile_normalizes_blank_database_and_parses_https() {
        let parsed = driver_profile_from_record(&record(
            ConnectionDriver::Clickhouse,
            json!({
                "host": "cloud.example.com",
                "port": 8443,
                "username": "default",
                "password": "secret",
                "defaultDatabase": "   ",
                "protocol": "https"
            }),
        ))
        .expect("ClickHouse HTTPS profile should parse");

        match parsed {
            DriverProfile::Clickhouse(profile) => {
                assert_eq!(profile.port, 8443);
                assert_eq!(profile.default_database, None);
                assert_eq!(profile.protocol, ClickHouseProtocol::Https);
            }
            _ => panic!("expected ClickHouse profile"),
        }
    }

    #[test]
    fn clickhouse_profile_preserves_unsupported_protocol_for_runtime_validation() {
        let parsed = driver_profile_from_record(&record(
            ConnectionDriver::Clickhouse,
            json!({
                "host": "localhost",
                "protocol": "ftp"
            }),
        ))
        .expect("unsupported protocol should reach explicit runtime validation");

        match parsed {
            DriverProfile::Clickhouse(profile) => {
                assert_eq!(profile.protocol, ClickHouseProtocol::Unsupported);
            }
            _ => panic!("expected ClickHouse profile"),
        }
    }

    #[test]
    fn clickhouse_profile_debug_redacts_database_and_ssh_secrets() {
        let profile = DriverProfile::Clickhouse(ClickHouseProfile {
            host: "localhost".to_string(),
            port: 8123,
            username: "default".to_string(),
            password: "database-secret".to_string(),
            default_database: Some("default".to_string()),
            protocol: ClickHouseProtocol::Http,
            connect_timeout_seconds: Some(5),
            ssh_tunnel: Some(SshTunnelProfile {
                enabled: true,
                host: "bastion.example.com".to_string(),
                port: 22,
                username: "deploy".to_string(),
                auth_method: SshAuthMethod::Password,
                password: Some("ssh-secret".to_string()),
                private_key_path: None,
                private_key_passphrase: Some("key-secret".to_string()),
                host_verification: SshHostVerificationMode::TrustOnFirstUse,
                host_key_fingerprint: None,
            }),
        });

        let debug = format!("{profile:?}");
        assert!(!debug.contains("database-secret"));
        assert!(!debug.contains("ssh-secret"));
        assert!(!debug.contains("key-secret"));
        assert!(debug.contains("[REDACTED]"));
    }

    #[test]
    fn parses_missing_postgres_database_as_none() {
        let parsed = driver_profile_from_record(&record(
            ConnectionDriver::Postgres,
            json!({
                "host": "127.0.0.1",
                "username": "postgres",
                "password": "secret"
            }),
        ))
        .expect("profile should parse");

        match parsed {
            DriverProfile::Postgres(profile) => {
                assert_eq!(profile.default_database, None);
            }
            _ => panic!("expected postgres profile"),
        }
    }

    #[test]
    fn parses_null_postgres_database_as_none() {
        let parsed = driver_profile_from_record(&record(
            ConnectionDriver::Postgres,
            json!({
                "host": "127.0.0.1",
                "username": "postgres",
                "password": "secret",
                "defaultDatabase": null
            }),
        ))
        .expect("profile should parse");

        match parsed {
            DriverProfile::Postgres(profile) => {
                assert_eq!(profile.default_database, None);
            }
            _ => panic!("expected postgres profile"),
        }
    }

    #[test]
    fn parses_empty_postgres_database_as_none() {
        let parsed = driver_profile_from_record(&record(
            ConnectionDriver::Postgres,
            json!({
                "host": "127.0.0.1",
                "username": "postgres",
                "password": "secret",
                "defaultDatabase": "   "
            }),
        ))
        .expect("profile should parse");

        match parsed {
            DriverProfile::Postgres(profile) => {
                assert_eq!(profile.default_database, None);
            }
            _ => panic!("expected postgres profile"),
        }
    }

    #[test]
    fn parses_missing_redis_db_index_as_none() {
        let parsed = driver_profile_from_record(&record(
            ConnectionDriver::Redis,
            json!({
                "password": "secret"
            }),
        ))
        .expect("profile should parse");

        match parsed {
            DriverProfile::Redis(profile) => {
                assert_eq!(profile.db_index, None);
            }
            _ => panic!("expected redis profile"),
        }
    }

    #[test]
    fn parses_sqlite_profile_defaults_to_read_only() {
        let parsed = driver_profile_from_record(&record(
            ConnectionDriver::Sqlite,
            json!({
                "dbFilePath": "D:/data/app.sqlite3"
            }),
        ))
        .expect("profile should parse");

        match parsed {
            DriverProfile::Sqlite(profile) => {
                assert_eq!(profile.db_file_path, "D:/data/app.sqlite3");
                assert!(profile.is_read_only);
            }
            _ => panic!("expected sqlite profile"),
        }
    }

    #[test]
    fn parses_sqlite_profile_writable_when_explicit() {
        let parsed = driver_profile_from_record(&record(
            ConnectionDriver::Sqlite,
            json!({
                "dbFilePath": "D:/data/app.sqlite3",
                "isReadOnly": false
            }),
        ))
        .expect("profile should parse");

        match parsed {
            DriverProfile::Sqlite(profile) => {
                assert_eq!(profile.db_file_path, "D:/data/app.sqlite3");
                assert!(!profile.is_read_only);
            }
            _ => panic!("expected sqlite profile"),
        }
    }

    #[test]
    fn parses_null_redis_db_index_as_none() {
        let parsed = driver_profile_from_record(&record(
            ConnectionDriver::Redis,
            json!({
                "password": "secret",
                "dbIndex": null
            }),
        ))
        .expect("profile should parse");

        match parsed {
            DriverProfile::Redis(profile) => {
                assert_eq!(profile.db_index, None);
            }
            _ => panic!("expected redis profile"),
        }
    }

    #[test]
    fn parses_postgres_ssh_tunnel_defaults() {
        let parsed = driver_profile_from_record(&record(
            ConnectionDriver::Postgres,
            json!({
                "host": "db.internal",
                "port": 5432,
                "username": "postgres",
                "password": "secret",
                "sshTunnel": {
                    "enabled": true,
                    "host": "bastion.internal",
                    "port": 22,
                    "username": "deploy",
                    "authMethod": "password",
                    "password": "ssh-secret"
                },
                "connectTimeoutSeconds": 7
            }),
        ))
        .expect("profile should parse");

        match parsed {
            DriverProfile::Postgres(profile) => {
                assert_eq!(profile.connect_timeout_seconds, Some(7));
                let ssh = profile.ssh_tunnel.expect("ssh profile");
                assert!(ssh.enabled);
                assert_eq!(ssh.host, "bastion.internal");
                assert_eq!(ssh.auth_method, SshAuthMethod::Password);
                assert_eq!(
                    ssh.host_verification,
                    SshHostVerificationMode::TrustOnFirstUse
                );
            }
            _ => panic!("expected postgres profile"),
        }
    }

    #[test]
    fn parses_mysql_ssl_mode() {
        let parsed = driver_profile_from_record(&record(
            ConnectionDriver::Mysql,
            json!({
                "host": "127.0.0.1",
                "username": "root",
                "password": "secret",
                "sslMode": "verify-ca"
            }),
        ))
        .expect("profile should parse");

        match parsed {
            DriverProfile::Mysql(profile) => {
                assert_eq!(profile.ssl_mode.as_deref(), Some("verify-ca"));
            }
            _ => panic!("expected mysql profile"),
        }
    }

    #[test]
    fn parses_oracle_profile_defaults_and_normalizes_optional_strings() {
        let parsed = driver_profile_from_record(&record(
            ConnectionDriver::Oracle,
            json!({
                "username": "app",
                "password": "secret",
                "serviceName": "   ",
                "sid": "",
                "connectDescriptor": "  "
            }),
        ))
        .expect("profile should parse");

        match parsed {
            DriverProfile::Oracle(profile) => {
                assert_eq!(profile.host, "localhost");
                assert_eq!(profile.port, 1521);
                assert_eq!(profile.username, "app");
                assert_eq!(profile.service_name, None);
                assert_eq!(profile.sid, None);
                assert_eq!(profile.connect_descriptor, None);
                assert_eq!(profile.role, OracleRole::Normal);
            }
            _ => panic!("expected oracle profile"),
        }
    }

    #[test]
    fn parses_oracle_profile_service_name_and_timeout() {
        let parsed = driver_profile_from_record(&record(
            ConnectionDriver::Oracle,
            json!({
                "host": "db.internal",
                "port": 1522,
                "username": "app",
                "password": "secret",
                "serviceName": "FREEPDB1",
                "connectTimeoutSeconds": 11
            }),
        ))
        .expect("profile should parse");

        match parsed {
            DriverProfile::Oracle(profile) => {
                assert_eq!(profile.host, "db.internal");
                assert_eq!(profile.port, 1522);
                assert_eq!(profile.service_name.as_deref(), Some("FREEPDB1"));
                assert_eq!(profile.connect_timeout_seconds, Some(11));
                assert_eq!(profile.role, OracleRole::Normal);
            }
            _ => panic!("expected oracle profile"),
        }
    }
}
