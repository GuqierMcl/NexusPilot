use std::time::Duration;

use deadpool_oracle::{Pool, PoolBuilder};
use oracle_rs::{Config, Error as OracleError};

use crate::engine::profiles::{OracleProfile, OracleRole};
use crate::engine::ssh_tunnel::{self, SshTunnelRuntime};
use crate::error::{IpcError, IpcResult};

pub struct OraclePoolRuntime {
    pub pool: Pool,
    pub tunnel: Option<SshTunnelRuntime>,
}

pub async fn connect_oracle_pool(profile: &OracleProfile) -> IpcResult<OraclePoolRuntime> {
    validate_oracle_runtime_profile(profile)?;

    let (host, port, tunnel) = if has_connect_descriptor(profile) {
        (profile.host.clone(), profile.port, None)
    } else {
        let endpoint =
            ssh_tunnel::resolve_endpoint(&profile.host, profile.port, profile.ssh_tunnel.as_ref())
                .await?;
        (endpoint.host, endpoint.port, endpoint.tunnel)
    };

    let config = build_oracle_config(profile, &host, port)?;
    let timeout = connect_timeout(profile);
    let pool = PoolBuilder::new(config)
        .max_size(5)
        .wait_timeout(Some(timeout))
        .create_timeout(Some(timeout))
        .recycle_timeout(Some(timeout))
        .build()
        .map_err(|error| {
            IpcError::system_internal("Failed to build Oracle connection pool", error.to_string())
        })?;

    let connection = pool.get().await.map_err(classify_oracle_pool_error)?;
    connection
        .ping()
        .await
        .map_err(classify_oracle_connection_error)?;
    drop(connection);

    Ok(OraclePoolRuntime { pool, tunnel })
}

pub fn validate_oracle_runtime_profile(profile: &OracleProfile) -> IpcResult<()> {
    if profile.username.trim().is_empty() {
        return Err(IpcError::validation_failed("Oracle username is required"));
    }
    if normalized(profile.service_name.as_deref()).is_some()
        && normalized(profile.sid.as_deref()).is_some()
    {
        return Err(IpcError::validation_failed(
            "Oracle service name and SID are mutually exclusive",
        ));
    }
    if normalized(profile.connect_descriptor.as_deref()).is_none()
        && normalized(profile.service_name.as_deref()).is_none()
        && normalized(profile.sid.as_deref()).is_none()
    {
        return Err(IpcError::validation_failed(
            "Oracle service name, SID, or EZConnect descriptor is required",
        ));
    }
    if let Some(descriptor) = normalized(profile.connect_descriptor.as_deref()) {
        if descriptor.starts_with('(') {
            return Err(IpcError::validation_failed(
                "暂不支持完整的 Oracle TNS DESCRIPTION，请改用 EZConnect 格式",
            ));
        }
        if profile.ssh_tunnel.as_ref().is_some_and(|ssh| ssh.enabled) {
            return Err(IpcError::validation_failed(
                "Oracle EZConnect 暂不能与 SSH 隧道同时使用，请关闭 SSH 隧道或改用 Service Name/SID",
            ));
        }
    }
    match profile.role {
        OracleRole::Normal => Ok(()),
        OracleRole::Sysdba => Err(IpcError::validation_failed(
            "暂不支持使用 Oracle SYSDBA 角色建立连接，请改用普通用户",
        )),
        OracleRole::Sysoper => Err(IpcError::validation_failed(
            "暂不支持使用 Oracle SYSOPER 角色建立连接，请改用普通用户",
        )),
    }
}

pub fn build_oracle_config(
    profile: &OracleProfile,
    resolved_host: &str,
    resolved_port: u16,
) -> IpcResult<Config> {
    validate_oracle_runtime_profile(profile)?;
    let timeout = connect_timeout(profile);

    if let Some(descriptor) = normalized(profile.connect_descriptor.as_deref()) {
        let mut config = descriptor.parse::<Config>().map_err(|error| {
            IpcError::validation_failed(format!("Invalid Oracle EZConnect descriptor: {error}"))
        })?;
        config.set_username(profile.username.clone());
        config.set_password(profile.password.clone());
        return Ok(config.connect_timeout(timeout).with_statement_cache_size(0));
    }

    if let Some(sid) = normalized(profile.sid.as_deref()) {
        return Ok(Config::with_sid(
            resolved_host,
            resolved_port,
            sid,
            profile.username.clone(),
            profile.password.clone(),
        )
        .connect_timeout(timeout)
        .with_statement_cache_size(0));
    }

    let service_name = normalized(profile.service_name.as_deref()).ok_or_else(|| {
        IpcError::validation_failed("Oracle service name, SID, or EZConnect descriptor is required")
    })?;
    Ok(Config::new(
        resolved_host,
        resolved_port,
        service_name,
        profile.username.clone(),
        profile.password.clone(),
    )
    .connect_timeout(timeout)
    .with_statement_cache_size(0))
}

pub fn classify_oracle_pool_error(error: deadpool_oracle::PoolError) -> IpcError {
    classify_oracle_message(&error.to_string(), "Failed to acquire Oracle connection")
}

pub fn classify_oracle_connection_error(error: OracleError) -> IpcError {
    match error {
        OracleError::AuthenticationFailed(message) => {
            IpcError::auth_failed("Oracle authentication failed", message)
        }
        OracleError::InvalidCredentials => IpcError::auth_failed(
            "Oracle authentication failed",
            "invalid username or password",
        ),
        OracleError::OracleError {
            code: 1017,
            message,
        } => IpcError::auth_failed("Oracle authentication failed", message),
        OracleError::ConnectionTimeout(duration) => IpcError::network_timeout(
            "Could not reach the Oracle server before the connection timeout",
            format!("connection timeout after {duration:?}"),
        ),
        OracleError::ConnectionRefused { message, .. }
        | OracleError::InvalidServiceName { message, .. }
        | OracleError::InvalidSid { message, .. } => IpcError::network_timeout(
            "Could not reach the Oracle listener or requested service",
            message.unwrap_or_else(|| "listener or service unavailable".to_string()),
        ),
        OracleError::InvalidConnectionString(message) => {
            IpcError::validation_failed(format!("Invalid Oracle connection string: {message}"))
        }
        OracleError::Io(error) => IpcError::network_timeout(
            "Could not reach the Oracle server. Please check the host and port.",
            error.to_string(),
        ),
        other => IpcError::system_internal("Failed to connect to Oracle", other.to_string()),
    }
}

pub fn classify_oracle_query_error(error: OracleError) -> IpcError {
    match error {
        OracleError::OracleError { code, message } => {
            if matches!(code, 900 | 903 | 904 | 911 | 917 | 936 | 933) {
                IpcError::query_syntax(format!("Oracle SQL 语法错误：{message}"), message)
            } else if matches!(code, 942 | 4043 | 1403) {
                IpcError::resource_not_found(message)
            } else if code == 1017 {
                IpcError::auth_failed("Oracle authentication failed", message)
            } else {
                IpcError::system_internal(format!("Oracle SQL 执行失败：{message}"), message)
            }
        }
        OracleError::SqlError(message) => {
            IpcError::query_syntax(format!("Oracle SQL 执行失败：{message}"), message)
        }
        other if other.is_connection_error() => IpcError::network_timeout(
            "Oracle connection was interrupted while executing SQL",
            other.to_string(),
        ),
        other => IpcError::system_internal("Oracle SQL execution failed", other.to_string()),
    }
}

fn has_connect_descriptor(profile: &OracleProfile) -> bool {
    normalized(profile.connect_descriptor.as_deref()).is_some()
}

fn connect_timeout(profile: &OracleProfile) -> Duration {
    Duration::from_secs(profile.connect_timeout_seconds.unwrap_or(5).clamp(1, 300))
}

fn normalized(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn classify_oracle_message(message: &str, context: &str) -> IpcError {
    let lower = message.to_ascii_lowercase();
    if lower.contains("ora-01017")
        || lower.contains("authentication")
        || lower.contains("invalid username")
        || lower.contains("invalid credentials")
    {
        IpcError::auth_failed("Oracle authentication failed", message)
    } else if lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("connection refused")
        || lower.contains("ora-125")
    {
        IpcError::network_timeout(
            "Could not reach the Oracle server. Please check the host, port, and service.",
            message,
        )
    } else {
        IpcError::system_internal(context, message)
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::engine::profiles::{OracleProfile, OracleRole};

    fn profile() -> OracleProfile {
        OracleProfile {
            host: "oracle.internal".to_string(),
            port: 1521,
            username: "app".to_string(),
            password: "secret".to_string(),
            service_name: Some("FREEPDB1".to_string()),
            sid: None,
            connect_descriptor: None,
            role: OracleRole::Normal,
            connect_timeout_seconds: Some(7),
            ssh_tunnel: None,
        }
    }

    #[test]
    fn builds_service_name_config_with_resolved_endpoint() {
        let config = build_oracle_config(&profile(), "127.0.0.1", 1522).expect("oracle config");

        assert_eq!(config.to_string(), "127.0.0.1:1522/FREEPDB1");
        assert_eq!(config.username, "app");
        assert_eq!(config.connect_timeout, Duration::from_secs(7));
    }

    #[test]
    fn builds_sid_config_with_resolved_endpoint() {
        let mut profile = profile();
        profile.service_name = None;
        profile.sid = Some("ORCL".to_string());

        let config = build_oracle_config(&profile, "127.0.0.1", 1522).expect("oracle config");

        assert_eq!(config.to_string(), "127.0.0.1:1522:ORCL");
    }

    #[test]
    fn parses_ezconnect_descriptor_and_sets_credentials() {
        let mut profile = profile();
        profile.service_name = None;
        profile.connect_descriptor = Some("//db.example.com:1521/FREEPDB1".to_string());

        let config = build_oracle_config(&profile, "ignored", 1522).expect("oracle config");

        assert_eq!(config.to_string(), "db.example.com:1521/FREEPDB1");
        assert_eq!(config.username, "app");
    }

    #[test]
    fn rejects_full_tns_descriptor_for_phase_one() {
        let mut profile = profile();
        profile.service_name = None;
        profile.connect_descriptor =
            Some("(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db)(PORT=1521)))".to_string());

        let error = build_oracle_config(&profile, "ignored", 1522)
            .expect_err("full TNS descriptor should be rejected");

        assert!(error.message.contains("TNS"));
        assert!(error.message.contains("EZConnect"));
        assert!(!error.message.to_ascii_lowercase().contains("phase"));
    }

    #[test]
    fn rejects_non_normal_role_for_phase_one() {
        let mut profile = profile();
        profile.role = OracleRole::Sysdba;

        let error = validate_oracle_runtime_profile(&profile)
            .expect_err("SYSDBA should be rejected in phase one");

        assert!(error.message.contains("SYSDBA"));
        assert!(error.message.contains("普通用户"));
        assert!(!error.message.to_ascii_lowercase().contains("phase"));
    }
}
