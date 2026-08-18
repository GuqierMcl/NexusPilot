use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Cursor, Read, Write},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::{Path, PathBuf},
    time::Duration,
};

use futures_util::StreamExt;
use image::{codecs::png::PngEncoder, ColorType, ImageEncoder, ImageFormat, ImageReader, Limits};
use reqwest::{header, redirect::Policy, StatusCode};
use sha2::{Digest, Sha256};
use tokio::net::lookup_host;
use url::{Host, Url};
use uuid::Uuid;

use super::session::AuthUser;

const AVATAR_DIRECTORY_NAME: &str = "avatars";
const AVATAR_IDENTITY_DOMAIN: &[u8] = b"NexusPilot.AccountAuth.Avatar.Identity.v1";
const AVATAR_REVISION_DOMAIN: &[u8] = b"NexusPilot.AccountAuth.Avatar.Revision.v1";
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
const MAX_AVATAR_URL_BYTES: usize = 2_048;
const MAX_REMOTE_AVATAR_BYTES: usize = 1024 * 1024;
const MAX_CACHED_AVATAR_BYTES: usize = 512 * 1024;
const MAX_SOURCE_DIMENSION: u32 = 2_048;
const MAX_RENDERED_DIMENSION: u32 = 256;
const MAX_REDIRECTS: usize = 3;
const CONNECT_TIMEOUT_SECONDS: u64 = 5;
const TOTAL_TIMEOUT_SECONDS: u64 = 10;

#[derive(Clone, Debug)]
pub(crate) struct AuthAvatarStore {
    directory: Option<PathBuf>,
}

impl AuthAvatarStore {
    pub fn new(app_data_dir: &Path) -> Self {
        Self {
            directory: Some(app_data_dir.join("auth").join(AVATAR_DIRECTORY_NAME)),
        }
    }

    pub fn unavailable() -> Self {
        Self { directory: None }
    }

    pub fn load(&self, user: &AuthUser, expected_revision: &str) -> Option<Vec<u8>> {
        if !is_revision(expected_revision) {
            return None;
        }
        let path = self.path_for(user)?;
        let bytes = read_limited_file(&path, MAX_CACHED_AVATAR_BYTES).ok()?;
        if !bytes.starts_with(PNG_SIGNATURE) {
            let _ = fs::remove_file(path);
            return None;
        }
        if avatar_revision(user, &bytes) != expected_revision {
            return None;
        }
        Some(bytes)
    }

    pub fn current_revision(&self, user: &AuthUser) -> Option<String> {
        let path = self.path_for(user)?;
        let bytes = read_limited_file(&path, MAX_CACHED_AVATAR_BYTES).ok()?;
        if !bytes.starts_with(PNG_SIGNATURE) {
            let _ = fs::remove_file(path);
            return None;
        }
        Some(avatar_revision(user, &bytes))
    }

    pub fn store(&self, user: &AuthUser, png: &[u8]) -> Result<String, AvatarError> {
        if png.len() > MAX_CACHED_AVATAR_BYTES || !png.starts_with(PNG_SIGNATURE) {
            return Err(AvatarError::new("avatar_cache_payload_invalid"));
        }
        let path = self
            .path_for(user)
            .ok_or_else(|| AvatarError::new("avatar_cache_unavailable"))?;
        ensure_directory(
            path.parent()
                .ok_or_else(|| AvatarError::new("avatar_cache_path_invalid"))?,
        )?;
        atomic_write(&path, png)?;
        Ok(avatar_revision(user, png))
    }

    pub fn remove_for_user(&self, user: &AuthUser) -> Result<(), AvatarError> {
        let Some(path) = self.path_for(user) else {
            return Ok(());
        };
        remove_if_exists(&path)
    }

    pub async fn download_and_sanitize(&self, source: &str) -> Result<Vec<u8>, AvatarError> {
        if self.directory.is_none() {
            return Err(AvatarError::new("avatar_cache_unavailable"));
        }
        let source = validate_avatar_url(source)?;
        let downloaded = download_avatar(source).await?;
        sanitize_avatar(&downloaded.bytes, downloaded.content_type)
    }

    fn path_for(&self, user: &AuthUser) -> Option<PathBuf> {
        self.directory
            .as_ref()
            .map(|directory| directory.join(format!("{}.png", avatar_identity_key(user))))
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct AvatarError {
    code: &'static str,
}

impl AvatarError {
    fn new(code: &'static str) -> Self {
        Self { code }
    }

    pub fn code(self) -> &'static str {
        self.code
    }
}

struct DownloadedAvatar {
    bytes: Vec<u8>,
    content_type: &'static str,
}

async fn download_avatar(mut current: Url) -> Result<DownloadedAvatar, AvatarError> {
    for redirect_count in 0..=MAX_REDIRECTS {
        let (host, addresses) = resolve_allowed_addresses(&current).await?;
        let client = reqwest::Client::builder()
            .https_only(true)
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECONDS))
            .timeout(Duration::from_secs(TOTAL_TIMEOUT_SECONDS))
            .resolve_to_addrs(&host, &addresses)
            .build()
            .map_err(|_| AvatarError::new("avatar_http_client_failed"))?;
        let response = client
            .get(current.clone())
            .header(header::ACCEPT, "image/png,image/jpeg,image/webp;q=0.9")
            .send()
            .await
            .map_err(|_| AvatarError::new("avatar_request_failed"))?;

        if response.status().is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                return Err(AvatarError::new("avatar_redirect_limit_exceeded"));
            }
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| AvatarError::new("avatar_redirect_invalid"))?;
            current = current
                .join(location)
                .map_err(|_| AvatarError::new("avatar_redirect_invalid"))?;
            current = validate_avatar_url(current.as_str())?;
            continue;
        }

        if response.status() != StatusCode::OK {
            return Err(AvatarError::new("avatar_response_status_rejected"));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_REMOTE_AVATAR_BYTES as u64)
        {
            return Err(AvatarError::new("avatar_response_too_large"));
        }
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(allowed_content_type)
            .ok_or_else(|| AvatarError::new("avatar_content_type_rejected"))?;

        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| AvatarError::new("avatar_response_read_failed"))?;
            if bytes.len().saturating_add(chunk.len()) > MAX_REMOTE_AVATAR_BYTES {
                return Err(AvatarError::new("avatar_response_too_large"));
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Err(AvatarError::new("avatar_response_empty"));
        }
        return Ok(DownloadedAvatar {
            bytes,
            content_type,
        });
    }

    Err(AvatarError::new("avatar_redirect_limit_exceeded"))
}

fn validate_avatar_url(source: &str) -> Result<Url, AvatarError> {
    let source = source.trim();
    if source.is_empty() || source.len() > MAX_AVATAR_URL_BYTES {
        return Err(AvatarError::new("avatar_url_length_invalid"));
    }
    let url = Url::parse(source).map_err(|_| AvatarError::new("avatar_url_invalid"))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return Err(AvatarError::new("avatar_url_rejected"));
    }
    match url.host() {
        Some(Host::Domain(domain)) if is_public_domain(domain) => {}
        Some(Host::Ipv4(address)) if is_public_ipv4(address) => {}
        Some(Host::Ipv6(address)) if is_public_ipv6(address) => {}
        _ => return Err(AvatarError::new("avatar_host_rejected")),
    }
    Ok(url)
}

async fn resolve_allowed_addresses(url: &Url) -> Result<(String, Vec<SocketAddr>), AvatarError> {
    let host = url
        .host_str()
        .ok_or_else(|| AvatarError::new("avatar_host_missing"))?
        .to_string();
    let addresses = lookup_host((host.as_str(), 443))
        .await
        .map_err(|_| AvatarError::new("avatar_dns_failed"))?;
    let (addresses, rejected_count) = filter_allowed_socket_addresses(addresses);
    if addresses.is_empty() {
        return Err(AvatarError::new("avatar_dns_target_rejected"));
    }
    if rejected_count > 0 {
        tauri_plugin_log::log::info!(
            "Discarded disallowed account avatar DNS targets before pinning: rejectedCount={rejected_count}"
        );
    }
    Ok((host, addresses))
}

fn filter_allowed_socket_addresses(
    addresses: impl IntoIterator<Item = SocketAddr>,
) -> (Vec<SocketAddr>, usize) {
    let mut unique = HashSet::new();
    let mut public_addresses = Vec::new();
    let mut rejected_count = 0;

    for address in addresses {
        if !unique.insert(address) {
            continue;
        }
        if is_allowed_resolved_ip(address.ip()) {
            public_addresses.push(address);
        } else {
            rejected_count += 1;
        }
    }

    (public_addresses, rejected_count)
}

fn is_public_domain(domain: &str) -> bool {
    let domain = domain.trim_end_matches('.').to_ascii_lowercase();
    domain.contains('.')
        && domain != "localhost"
        && !domain.ends_with(".localhost")
        && !domain.ends_with(".local")
        && !domain.ends_with(".internal")
        && !domain.ends_with(".home.arpa")
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_allowed_resolved_ip(address: IpAddr) -> bool {
    is_public_ip(address) || is_tun_fake_ip(address)
}

/// Clash/Mihomo TUN 的 Fake-IP 只可作为域名 DNS 解析结果使用。
/// 直接以此类 IP 构造头像 URL 仍会被 `validate_avatar_url` 拒绝。
fn is_tun_fake_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let [first, second, _, _] = address.octets();
            first == 198 && (second == 18 || second == 19)
        }
        IpAddr::V6(address) => {
            let segments = address.segments();
            segments[0] == 0xfdfe
                && segments[1] == 0xdcba
                && segments[2] == 0x9876
                && segments[3] == 0
        }
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    !(a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 88 && c == 99)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224)
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    if let Some(mapped) = address.to_ipv4_mapped() {
        return is_public_ipv4(mapped);
    }
    let segments = address.segments();
    !(address.is_unspecified()
        || address.is_loopback()
        || address.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] == 0x0064 && segments[1] == 0xff9b)
        || segments[0] == 0x2002
        || (segments[0] == 0x2001 && segments[1] == 0x0000)
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || (segments[0] == 0x2001 && segments[1] == 0x0002)
        || (segments[0] == 0 && segments[1] == 0 && segments[2] == 0 && segments[3] == 0))
}

fn allowed_content_type(value: &str) -> Option<&'static str> {
    match value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/png" => Some("image/png"),
        "image/jpeg" => Some("image/jpeg"),
        "image/webp" => Some("image/webp"),
        _ => None,
    }
}

fn sanitize_avatar(bytes: &[u8], content_type: &str) -> Result<Vec<u8>, AvatarError> {
    let format =
        image::guess_format(bytes).map_err(|_| AvatarError::new("avatar_image_format_invalid"))?;
    let expected_format = match content_type {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        "image/webp" => ImageFormat::WebP,
        _ => return Err(AvatarError::new("avatar_content_type_rejected")),
    };
    if format != expected_format {
        return Err(AvatarError::new("avatar_content_type_mismatch"));
    }

    let mut dimensions_reader = ImageReader::with_format(Cursor::new(bytes), format);
    dimensions_reader.limits(Limits::default());
    let (width, height) = dimensions_reader
        .into_dimensions()
        .map_err(|_| AvatarError::new("avatar_dimensions_invalid"))?;
    if width == 0 || height == 0 || width > MAX_SOURCE_DIMENSION || height > MAX_SOURCE_DIMENSION {
        return Err(AvatarError::new("avatar_dimensions_rejected"));
    }

    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SOURCE_DIMENSION);
    limits.max_image_height = Some(MAX_SOURCE_DIMENSION);
    limits.max_alloc = Some(32 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|_| AvatarError::new("avatar_decode_failed"))?;
    let rendered = decoded.thumbnail(MAX_RENDERED_DIMENSION, MAX_RENDERED_DIMENSION);
    let rgba = rendered.to_rgba8();
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(
            rgba.as_raw(),
            rgba.width(),
            rgba.height(),
            ColorType::Rgba8.into(),
        )
        .map_err(|_| AvatarError::new("avatar_encode_failed"))?;
    if png.len() > MAX_CACHED_AVATAR_BYTES {
        return Err(AvatarError::new("avatar_cache_payload_too_large"));
    }
    Ok(png)
}

fn avatar_identity_key(user: &AuthUser) -> String {
    let mut hasher = Sha256::new();
    hasher.update(AVATAR_IDENTITY_DOMAIN);
    update_length_prefixed(&mut hasher, user.provider_id.as_bytes());
    update_length_prefixed(&mut hasher, user.issuer.as_bytes());
    update_length_prefixed(&mut hasher, user.subject.as_bytes());
    hex_lower(&hasher.finalize())
}

fn avatar_revision(user: &AuthUser, bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(AVATAR_REVISION_DOMAIN);
    update_length_prefixed(&mut hasher, user.provider_id.as_bytes());
    update_length_prefixed(&mut hasher, user.issuer.as_bytes());
    update_length_prefixed(&mut hasher, user.subject.as_bytes());
    update_length_prefixed(&mut hasher, bytes);
    hex_lower(&hasher.finalize())
}

fn update_length_prefixed(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update((bytes.len() as u64).to_be_bytes());
    hasher.update(bytes);
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn is_revision(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn ensure_directory(path: &Path) -> Result<(), AvatarError> {
    fs::create_dir_all(path)
        .map_err(|_| AvatarError::new("avatar_cache_directory_create_failed"))?;
    set_directory_permissions(path)
}

fn read_limited_file(path: &Path, max_bytes: usize) -> Result<Vec<u8>, AvatarError> {
    let metadata =
        fs::metadata(path).map_err(|_| AvatarError::new("avatar_cache_metadata_read_failed"))?;
    if metadata.len() > max_bytes as u64 {
        return Err(AvatarError::new("avatar_cache_file_too_large"));
    }
    let mut file =
        File::open(path).map_err(|_| AvatarError::new("avatar_cache_file_open_failed"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| AvatarError::new("avatar_cache_file_read_failed"))?;
    Ok(bytes)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), AvatarError> {
    let parent = path
        .parent()
        .ok_or_else(|| AvatarError::new("avatar_cache_path_invalid"))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AvatarError::new("avatar_cache_path_invalid"))?;
    let temporary = parent.join(format!(".{file_name}.{}.tmp", Uuid::new_v4()));
    write_secure_file(&temporary, bytes)?;
    let result = replace_file(&temporary, path);
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn write_secure_file(path: &Path, bytes: &[u8]) -> Result<(), AvatarError> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| AvatarError::new("avatar_cache_temporary_open_failed"))?;
    file.write_all(bytes)
        .map_err(|_| AvatarError::new("avatar_cache_temporary_write_failed"))?;
    file.sync_all()
        .map_err(|_| AvatarError::new("avatar_cache_temporary_sync_failed"))?;
    set_file_permissions(path)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), AvatarError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let flags = MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH;
    let moved = unsafe { MoveFileExW(source_wide.as_ptr(), destination_wide.as_ptr(), flags) };
    if moved == 0 {
        return Err(AvatarError::new("avatar_cache_atomic_replace_failed"));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), AvatarError> {
    fs::rename(source, destination)
        .map_err(|_| AvatarError::new("avatar_cache_atomic_replace_failed"))
}

#[cfg(unix)]
fn set_directory_permissions(path: &Path) -> Result<(), AvatarError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| AvatarError::new("avatar_cache_directory_permissions_failed"))
}

#[cfg(not(unix))]
fn set_directory_permissions(_path: &Path) -> Result<(), AvatarError> {
    Ok(())
}

#[cfg(unix)]
fn set_file_permissions(path: &Path) -> Result<(), AvatarError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| AvatarError::new("avatar_cache_file_permissions_failed"))
}

#[cfg(not(unix))]
fn set_file_permissions(_path: &Path) -> Result<(), AvatarError> {
    Ok(())
}

fn remove_if_exists(path: &Path) -> Result<(), AvatarError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(AvatarError::new("avatar_cache_remove_failed")),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        net::{Ipv6Addr, SocketAddr},
    };

    use image::{DynamicImage, ImageFormat};
    use tempfile::tempdir;

    use super::{
        filter_allowed_socket_addresses, is_allowed_resolved_ip, is_public_ipv4, is_public_ipv6,
        is_tun_fake_ip, sanitize_avatar, validate_avatar_url, AuthAvatarStore, PNG_SIGNATURE,
    };
    use crate::auth::session::AuthUser;

    fn user(subject: &str) -> AuthUser {
        AuthUser {
            provider_id: "provider".to_string(),
            issuer: "https://issuer.test".to_string(),
            subject: subject.to_string(),
            display_name: Some("Demo".to_string()),
            handle: Some("demo".to_string()),
            email: Some("demo@example.test".to_string()),
            email_verified: Some(true),
            avatar_revision: None,
        }
    }

    fn test_png(width: u32, height: u32) -> Vec<u8> {
        let image = DynamicImage::new_rgba8(width, height);
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .expect("encode png");
        bytes
    }

    use std::io::Cursor;

    #[test]
    fn avatar_urls_fail_closed_for_non_https_credentials_fragments_and_private_targets() {
        assert!(validate_avatar_url("https://cdn.example.com/avatar.png").is_ok());
        for rejected in [
            "http://cdn.example.com/avatar.png",
            "https://user:password@cdn.example.com/avatar.png",
            "https://cdn.example.com/avatar.png#fragment",
            "https://localhost/avatar.png",
            "https://service.internal/avatar.png",
            "https://127.0.0.1/avatar.png",
            "https://192.168.1.2/avatar.png",
            "https://cdn.example.com:8443/avatar.png",
        ] {
            assert!(
                validate_avatar_url(rejected).is_err(),
                "accepted {rejected}"
            );
        }
    }

    #[test]
    fn public_address_filter_rejects_local_special_and_documentation_ranges() {
        assert!(is_public_ipv4("8.8.8.8".parse().expect("public ipv4")));
        for rejected in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.0.2.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
        ] {
            assert!(!is_public_ipv4(rejected.parse().expect("ipv4")));
        }
        assert!(is_public_ipv6(
            "2606:4700:4700::1111".parse().expect("public ipv6")
        ));
        for rejected in [
            "::",
            "::1",
            "64:ff9b::c0a8:101",
            "fc00::1",
            "fe80::1",
            "2001::1",
            "2001:db8::1",
            "2002:c0a8:0101::1",
        ] {
            assert!(!is_public_ipv6(rejected.parse::<Ipv6Addr>().expect("ipv6")));
        }
    }

    #[test]
    fn dns_address_filter_pins_only_unique_allowed_targets_from_mixed_answers() {
        let public_ipv4: SocketAddr = "8.8.8.8:443".parse().expect("public ipv4");
        let public_ipv6: SocketAddr = "[2606:4700:4700::1111]:443".parse().expect("public ipv6");
        let private_ipv4: SocketAddr = "192.168.1.2:443".parse().expect("private ipv4");
        let loopback_ipv6: SocketAddr = "[::1]:443".parse().expect("loopback ipv6");

        let (addresses, rejected_count) = filter_allowed_socket_addresses([
            private_ipv4,
            public_ipv4,
            public_ipv4,
            loopback_ipv6,
            public_ipv6,
        ]);

        assert_eq!(addresses, vec![public_ipv4, public_ipv6]);
        assert_eq!(rejected_count, 2);
    }

    #[test]
    fn dns_address_filter_rejects_answers_without_an_allowed_target() {
        let private_ipv4: SocketAddr = "10.0.0.1:443".parse().expect("private ipv4");
        let loopback_ipv6: SocketAddr = "[::1]:443".parse().expect("loopback ipv6");

        let (addresses, rejected_count) =
            filter_allowed_socket_addresses([private_ipv4, loopback_ipv6, private_ipv4]);

        assert!(addresses.is_empty());
        assert_eq!(rejected_count, 2);
    }

    #[test]
    fn dns_address_filter_accepts_only_standard_tun_fake_ip_ranges() {
        let fake_ipv4: SocketAddr = "198.18.42.10:443".parse().expect("fake ipv4");
        let fake_ipv6: SocketAddr = "[fdfe:dcba:9876::1]:443".parse().expect("fake ipv6");
        let private_ipv4: SocketAddr = "192.168.1.2:443".parse().expect("private ipv4");

        let (addresses, rejected_count) =
            filter_allowed_socket_addresses([fake_ipv4, fake_ipv6, private_ipv4]);

        assert_eq!(addresses, vec![fake_ipv4, fake_ipv6]);
        assert_eq!(rejected_count, 1);
        assert!(is_tun_fake_ip("198.19.255.254".parse().expect("fake ipv4")));
        assert!(!is_tun_fake_ip(
            "198.20.0.1".parse().expect("non-fake ipv4")
        ));
        assert!(is_tun_fake_ip(
            "fdfe:dcba:9876:0:ffff::1".parse().expect("fake ipv6")
        ));
        assert!(!is_tun_fake_ip("fd00::1".parse().expect("non-fake ipv6")));
        assert!(is_allowed_resolved_ip(
            "198.18.42.10".parse().expect("fake ipv4")
        ));
    }

    #[test]
    fn sanitizer_reencodes_supported_images_and_rejects_mismatched_or_oversized_input() {
        let input = test_png(512, 256);
        let output = sanitize_avatar(&input, "image/png").expect("sanitize png");
        assert!(output.starts_with(PNG_SIGNATURE));
        let decoded = image::load_from_memory(&output).expect("decode output");
        assert_eq!((decoded.width(), decoded.height()), (256, 128));
        assert!(sanitize_avatar(&input, "image/jpeg").is_err());
        assert!(sanitize_avatar(&test_png(2_049, 1), "image/png").is_err());
        assert!(sanitize_avatar(b"<svg></svg>", "image/png").is_err());
    }

    #[test]
    fn cache_is_identity_bound_revision_checked_and_clearable() {
        let root = tempdir().expect("tempdir");
        let store = AuthAvatarStore::new(root.path());
        let first = user("first");
        let second = user("second");
        let first_png = sanitize_avatar(&test_png(32, 32), "image/png").expect("sanitize png");
        let second_png = first_png.clone();
        let first_revision = store.store(&first, &first_png).expect("store first avatar");
        let second_revision = store
            .store(&second, &second_png)
            .expect("store second avatar");
        assert_ne!(first_revision, second_revision);

        assert_eq!(
            store.load(&first, &first_revision).expect("load avatar"),
            first_png
        );
        assert!(store.load(&first, &second_revision).is_none());
        assert!(store.load(&first, &first_revision).is_some());
        assert!(store.load(&first, "not-a-revision").is_none());

        store.remove_for_user(&second).expect("remove second");
        assert!(store.load(&first, &first_revision).is_some());
        assert!(store.load(&second, &second_revision).is_none());

        let first_path = store.path_for(&first).expect("first path");
        fs::write(&first_path, b"tampered").expect("tamper avatar");
        assert!(store.load(&first, &first_revision).is_none());

        store.store(&first, &first_png).expect("restore avatar");
        store.remove_for_user(&first).expect("remove first");
        assert!(store.load(&first, &first_revision).is_none());
    }
}
