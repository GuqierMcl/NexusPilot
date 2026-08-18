use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Config};
use russh::keys::{key::PrivateKeyWithHashAlg, load_secret_key, ssh_key};
use russh::ChannelMsg;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::engine::profiles::{SshAuthMethod, SshHostVerificationMode, SshTunnelProfile};
use crate::error::{IpcError, IpcResult};

const LOCAL_TUNNEL_HOST: &str = "127.0.0.1";
const SSH_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

pub struct ResolvedEndpoint {
    pub host: String,
    pub port: u16,
    pub tunnel: Option<SshTunnelRuntime>,
}

pub struct SshTunnelRuntime {
    local_host: String,
    local_port: u16,
    captured_host_key_fingerprint: Option<String>,
    listener_task: JoinHandle<()>,
    _session: Arc<Mutex<client::Handle<SshClientHandler>>>,
}

impl SshTunnelRuntime {
    pub async fn connect(
        ssh_tunnel: &SshTunnelProfile,
        target_host: &str,
        target_port: u16,
    ) -> IpcResult<Self> {
        validate_ssh_tunnel_profile(ssh_tunnel)?;

        let captured_host_key_fingerprint = Arc::new(Mutex::new(None));
        let config = Arc::new(Config {
            nodelay: true,
            keepalive_interval: Some(Duration::from_secs(30)),
            keepalive_max: 3,
            ..Default::default()
        });
        let handler = SshClientHandler {
            profile: ssh_tunnel.clone(),
            captured_fingerprint: Arc::clone(&captured_host_key_fingerprint),
        };

        let connect_future =
            client::connect(config, (ssh_tunnel.host.as_str(), ssh_tunnel.port), handler);
        let mut session = tokio::time::timeout(SSH_CONNECT_TIMEOUT, connect_future)
            .await
            .map_err(|_| {
                IpcError::network_timeout(
                    "SSH connection timed out",
                    format!(
                        "Timed out connecting to {}:{}",
                        ssh_tunnel.host, ssh_tunnel.port
                    ),
                )
            })?
            .map_err(classify_ssh_connection_error)?;

        authenticate_session(&mut session, ssh_tunnel).await?;

        let listener = TcpListener::bind((LOCAL_TUNNEL_HOST, 0))
            .await
            .map_err(|error| {
                IpcError::system_internal("Failed to bind local SSH tunnel port", error.to_string())
            })?;
        let local_addr = listener.local_addr().map_err(|error| {
            IpcError::system_internal("Failed to read local SSH tunnel address", error.to_string())
        })?;
        let session = Arc::new(Mutex::new(session));
        let listener_session = Arc::clone(&session);
        let forward_host = target_host.to_string();
        let listener_task = tokio::spawn(async move {
            accept_loop(listener, listener_session, forward_host, target_port).await;
        });
        let fingerprint = captured_host_key_fingerprint.lock().await.clone();

        Ok(Self {
            local_host: LOCAL_TUNNEL_HOST.to_string(),
            local_port: local_addr.port(),
            captured_host_key_fingerprint: fingerprint,
            listener_task,
            _session: session,
        })
    }

    pub fn local_host(&self) -> &str {
        &self.local_host
    }

    pub fn local_port(&self) -> u16 {
        self.local_port
    }

    pub fn captured_host_key_fingerprint(&self) -> Option<&str> {
        self.captured_host_key_fingerprint.as_deref()
    }
}

impl Drop for SshTunnelRuntime {
    fn drop(&mut self) {
        self.listener_task.abort();
    }
}

struct SshClientHandler {
    profile: SshTunnelProfile,
    captured_fingerprint: Arc<Mutex<Option<String>>>,
}

impl client::Handler for SshClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = format!(
            "{}",
            server_public_key.fingerprint(ssh_key::HashAlg::Sha256)
        );
        *self.captured_fingerprint.lock().await = Some(fingerprint.clone());
        Ok(host_key_matches(&self.profile, &fingerprint))
    }
}

pub fn validate_ssh_tunnel_profile(ssh_tunnel: &SshTunnelProfile) -> IpcResult<()> {
    if !ssh_tunnel.enabled {
        return Ok(());
    }
    if ssh_tunnel.host.trim().is_empty() {
        return Err(IpcError::validation_failed("SSH host is required"));
    }
    if ssh_tunnel.port == 0 {
        return Err(IpcError::validation_failed(
            "SSH port must be between 1 and 65535",
        ));
    }
    if ssh_tunnel.username.trim().is_empty() {
        return Err(IpcError::validation_failed("SSH username is required"));
    }
    match ssh_tunnel.auth_method {
        SshAuthMethod::Password => {
            if ssh_tunnel
                .password
                .as_deref()
                .is_none_or(|password| password.trim().is_empty())
            {
                return Err(IpcError::validation_failed("SSH password is required"));
            }
        }
        SshAuthMethod::PrivateKey => {
            if ssh_tunnel
                .private_key_path
                .as_deref()
                .is_none_or(|path| path.trim().is_empty())
            {
                return Err(IpcError::validation_failed(
                    "SSH private key path is required",
                ));
            }
        }
    }
    Ok(())
}

pub fn host_key_matches(ssh_tunnel: &SshTunnelProfile, fingerprint: &str) -> bool {
    match ssh_tunnel.host_verification {
        SshHostVerificationMode::Skip => true,
        SshHostVerificationMode::TrustOnFirstUse => ssh_tunnel
            .host_key_fingerprint
            .as_deref()
            .filter(|saved| !saved.trim().is_empty())
            .is_none_or(|saved| saved == fingerprint),
    }
}

pub async fn resolve_endpoint(
    host: &str,
    port: u16,
    ssh_tunnel: Option<&SshTunnelProfile>,
) -> IpcResult<ResolvedEndpoint> {
    let Some(ssh_tunnel) = ssh_tunnel.filter(|profile| profile.enabled) else {
        return Ok(ResolvedEndpoint {
            host: host.to_string(),
            port,
            tunnel: None,
        });
    };

    let tunnel = SshTunnelRuntime::connect(ssh_tunnel, host, port).await?;
    Ok(ResolvedEndpoint {
        host: tunnel.local_host().to_string(),
        port: tunnel.local_port(),
        tunnel: Some(tunnel),
    })
}

async fn authenticate_session(
    session: &mut client::Handle<SshClientHandler>,
    ssh_tunnel: &SshTunnelProfile,
) -> IpcResult<()> {
    let authenticated = match ssh_tunnel.auth_method {
        SshAuthMethod::Password => {
            let password = ssh_tunnel.password.as_deref().unwrap_or_default();
            session
                .authenticate_password(ssh_tunnel.username.clone(), password)
                .await
                .map_err(classify_ssh_auth_error)?
                .success()
        }
        SshAuthMethod::PrivateKey => {
            let key_path = ssh_tunnel.private_key_path.as_deref().unwrap_or_default();
            let passphrase = ssh_tunnel
                .private_key_passphrase
                .as_deref()
                .filter(|value| !value.is_empty());
            let key_pair = load_secret_key(key_path, passphrase).map_err(|error| {
                IpcError::auth_failed("Failed to read SSH private key", error.to_string())
            })?;
            let rsa_hash = session
                .best_supported_rsa_hash()
                .await
                .map_err(classify_ssh_auth_error)?
                .flatten();
            session
                .authenticate_publickey(
                    ssh_tunnel.username.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(key_pair), rsa_hash),
                )
                .await
                .map_err(classify_ssh_auth_error)?
                .success()
        }
    };

    if authenticated {
        Ok(())
    } else {
        Err(IpcError::auth_failed(
            "SSH authentication failed",
            "The SSH server rejected the configured credentials",
        ))
    }
}

async fn accept_loop(
    listener: TcpListener,
    session: Arc<Mutex<client::Handle<SshClientHandler>>>,
    target_host: String,
    target_port: u16,
) {
    loop {
        let Ok((stream, originator_addr)) = listener.accept().await else {
            break;
        };
        let session = Arc::clone(&session);
        let target_host = target_host.clone();
        tokio::spawn(async move {
            let _ =
                forward_stream(stream, originator_addr, session, target_host, target_port).await;
        });
    }
}

async fn forward_stream(
    mut stream: TcpStream,
    originator_addr: SocketAddr,
    session: Arc<Mutex<client::Handle<SshClientHandler>>>,
    target_host: String,
    target_port: u16,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut channel = {
        let session = session.lock().await;
        session
            .channel_open_direct_tcpip(
                target_host,
                u32::from(target_port),
                originator_ip(originator_addr).to_string(),
                u32::from(originator_addr.port()),
            )
            .await?
    };
    let mut stream_closed = false;
    let mut buffer = vec![0_u8; 65_536];

    loop {
        tokio::select! {
            read = stream.read(&mut buffer), if !stream_closed => {
                match read {
                    Ok(0) => {
                        stream_closed = true;
                        channel.eof().await?;
                    }
                    Ok(size) => channel.data(&buffer[..size]).await?,
                    Err(error) => return Err(Box::new(error)),
                }
            }
            message = channel.wait() => {
                match message {
                    Some(ChannelMsg::Data { ref data }) => stream.write_all(data).await?,
                    Some(ChannelMsg::Eof) => {
                        if !stream_closed {
                            channel.eof().await?;
                        }
                        break;
                    }
                    Some(ChannelMsg::Close) | None => break,
                    Some(ChannelMsg::WindowAdjusted { .. }) => {}
                    Some(_) => {}
                }
            }
        }
    }

    Ok(())
}

fn originator_ip(originator_addr: SocketAddr) -> IpAddr {
    match originator_addr.ip() {
        IpAddr::V4(ip) => IpAddr::V4(ip),
        IpAddr::V6(ip) if ip.is_loopback() => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(ip) => IpAddr::V6(ip),
    }
}

fn classify_ssh_connection_error(error: russh::Error) -> IpcError {
    let details = error.to_string();
    match error {
        russh::Error::ConnectionTimeout
        | russh::Error::KeepaliveTimeout
        | russh::Error::InactivityTimeout
        | russh::Error::IO(_) => {
            IpcError::network_timeout("Failed to connect to SSH server", details)
        }
        russh::Error::UnknownKey | russh::Error::KeyChanged { .. } => {
            IpcError::validation_failed("SSH host key verification failed")
        }
        russh::Error::NoAuthMethod | russh::Error::UnsupportedAuthMethod => {
            IpcError::auth_failed("SSH authentication failed", details)
        }
        _ => IpcError::system_internal("Failed to establish SSH tunnel", details),
    }
}

fn classify_ssh_auth_error(error: russh::Error) -> IpcError {
    IpcError::auth_failed("SSH authentication failed", error.to_string())
}

#[cfg(test)]
mod tests {
    use crate::engine::profiles::{SshAuthMethod, SshHostVerificationMode, SshTunnelProfile};

    fn profile() -> SshTunnelProfile {
        SshTunnelProfile {
            enabled: true,
            host: "bastion.example.com".to_string(),
            port: 22,
            username: "deploy".to_string(),
            auth_method: SshAuthMethod::Password,
            password: Some("secret".to_string()),
            private_key_path: None,
            private_key_passphrase: None,
            host_verification: SshHostVerificationMode::TrustOnFirstUse,
            host_key_fingerprint: None,
        }
    }

    #[test]
    fn disabled_profile_skips_validation() {
        let mut ssh = profile();
        ssh.enabled = false;
        ssh.host.clear();
        ssh.username.clear();
        ssh.password = None;

        assert!(super::validate_ssh_tunnel_profile(&ssh).is_ok());
    }

    #[test]
    fn rejects_enabled_tunnel_without_host() {
        let mut ssh = profile();
        ssh.host = "   ".to_string();

        assert!(super::validate_ssh_tunnel_profile(&ssh).is_err());
    }

    #[test]
    fn rejects_enabled_tunnel_without_username() {
        let mut ssh = profile();
        ssh.username = "   ".to_string();

        assert!(super::validate_ssh_tunnel_profile(&ssh).is_err());
    }

    #[test]
    fn rejects_zero_ssh_port() {
        let mut ssh = profile();
        ssh.port = 0;

        assert!(super::validate_ssh_tunnel_profile(&ssh).is_err());
    }

    #[test]
    fn rejects_password_auth_without_password() {
        let mut ssh = profile();
        ssh.password = Some("   ".to_string());

        assert!(super::validate_ssh_tunnel_profile(&ssh).is_err());
    }

    #[test]
    fn rejects_private_key_auth_without_key_path() {
        let mut ssh = profile();
        ssh.auth_method = SshAuthMethod::PrivateKey;
        ssh.private_key_path = Some("   ".to_string());

        assert!(super::validate_ssh_tunnel_profile(&ssh).is_err());
    }

    #[test]
    fn trust_on_first_use_accepts_first_fingerprint() {
        let ssh = profile();

        assert!(super::host_key_matches(&ssh, "SHA256:abc"));
    }

    #[test]
    fn trust_on_first_use_rejects_changed_fingerprint() {
        let mut ssh = profile();
        ssh.host_key_fingerprint = Some("SHA256:abc".to_string());

        assert!(!super::host_key_matches(&ssh, "SHA256:def"));
    }

    #[test]
    fn skip_verification_accepts_changed_fingerprint() {
        let mut ssh = profile();
        ssh.host_verification = SshHostVerificationMode::Skip;
        ssh.host_key_fingerprint = Some("SHA256:abc".to_string());

        assert!(super::host_key_matches(&ssh, "SHA256:def"));
    }
}
