use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use super::{error::AuthPublicError, secret::SecretString};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthSessionPhase {
    Restoring,
    Anonymous,
    Authenticated,
    ReauthenticationRequired,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthOperation {
    Idle,
    SigningIn,
    Refreshing,
    SigningOut,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthProviderAvailability {
    Unknown,
    Available,
    TemporarilyUnavailable,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthProviderSummary {
    pub id: String,
    pub display_name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub provider_id: String,
    pub issuer: String,
    pub subject: String,
    pub display_name: Option<String>,
    pub handle: Option<String>,
    pub email: Option<String>,
    pub email_verified: Option<bool>,
    /// 本地净化头像的内容版本；不包含 Provider 原始 picture URL。
    pub avatar_revision: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSessionSnapshot {
    pub phase: AuthSessionPhase,
    pub operation: AuthOperation,
    pub provider_availability: AuthProviderAvailability,
    pub provider: Option<AuthProviderSummary>,
    pub user: Option<AuthUser>,
    pub has_usable_access_token: bool,
    pub access_token_expires_at: Option<String>,
    pub last_authenticated_at: Option<String>,
    pub last_refreshed_at: Option<String>,
    pub error: Option<AuthPublicError>,
}

impl AuthSessionSnapshot {
    pub fn restoring(provider: Option<AuthProviderSummary>) -> Self {
        Self {
            phase: AuthSessionPhase::Restoring,
            operation: AuthOperation::Idle,
            provider_availability: AuthProviderAvailability::Unknown,
            provider,
            user: None,
            has_usable_access_token: false,
            access_token_expires_at: None,
            last_authenticated_at: None,
            last_refreshed_at: None,
            error: None,
        }
    }
}

#[derive(Clone)]
pub(crate) struct PersistedAuthSession {
    pub generation_id: String,
    pub provider_fingerprint: String,
    pub user: AuthUser,
    pub refresh_token: SecretString,
    pub last_authenticated_at: i64,
    pub last_refreshed_at: Option<i64>,
}

#[derive(Clone)]
pub(crate) struct PendingLogin {
    pub transaction_id: String,
    pub provider_fingerprint: String,
    pub state: SecretString,
    pub nonce: SecretString,
    pub pkce_verifier: SecretString,
    pub authorization_url: SecretString,
    pub created_at: i64,
    pub expires_at: i64,
}

impl PendingLogin {
    pub fn is_expired(&self, now: i64) -> bool {
        now >= self.expires_at
    }
}

pub(crate) struct RuntimeTokens {
    pub access_token: SecretString,
    pub access_token_expires_at: Option<i64>,
}

impl RuntimeTokens {
    pub fn has_usable_access_token(&self, now: i64, refresh_window_seconds: i64) -> bool {
        self.access_token_expires_at
            .is_none_or(|expires_at| expires_at.saturating_sub(now) > refresh_window_seconds)
    }
}

#[derive(Clone, Default)]
pub(crate) struct StoredAuthState {
    pub session: Option<PersistedAuthSession>,
    pub pending_login: Option<PendingLogin>,
}

pub(crate) fn now_epoch_seconds() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

pub(crate) fn epoch_seconds_to_string(timestamp: i64) -> Option<String> {
    let value = OffsetDateTime::from_unix_timestamp(timestamp).ok()?;
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        value.year(),
        u8::from(value.month()),
        value.day(),
        value.hour(),
        value.minute(),
        value.second(),
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        AuthOperation, AuthProviderAvailability, AuthSessionPhase, AuthSessionSnapshot, AuthUser,
        PendingLogin, RuntimeTokens,
    };
    use crate::auth::secret::SecretString;

    #[test]
    fn pending_login_expiration_is_closed_at_the_boundary() {
        let pending = PendingLogin {
            transaction_id: "transaction".to_string(),
            provider_fingerprint: "fingerprint".to_string(),
            state: SecretString::new("state".to_string()),
            nonce: SecretString::new("nonce".to_string()),
            pkce_verifier: SecretString::new("verifier".to_string()),
            authorization_url: SecretString::new("https://example.test/auth".to_string()),
            created_at: 100,
            expires_at: 200,
        };

        assert!(!pending.is_expired(199));
        assert!(pending.is_expired(200));
    }

    #[test]
    fn access_token_enters_refresh_window_before_expiry() {
        let tokens = RuntimeTokens {
            access_token: SecretString::new("access".to_string()),
            access_token_expires_at: Some(1_000),
        };

        assert!(tokens.has_usable_access_token(900, 60));
        assert!(!tokens.has_usable_access_token(940, 60));
    }

    #[test]
    fn public_snapshot_contract_cannot_serialize_tokens_or_oidc_transients() {
        let snapshot = AuthSessionSnapshot {
            phase: AuthSessionPhase::Authenticated,
            operation: AuthOperation::Idle,
            provider_availability: AuthProviderAvailability::Available,
            provider: None,
            user: Some(AuthUser {
                provider_id: "provider".to_string(),
                issuer: "https://issuer.test".to_string(),
                subject: "subject".to_string(),
                display_name: Some("Demo".to_string()),
                handle: Some("demo".to_string()),
                email: Some("demo@example.test".to_string()),
                email_verified: Some(true),
                avatar_revision: Some(
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string(),
                ),
            }),
            has_usable_access_token: true,
            access_token_expires_at: Some("2030-01-01T00:00:00Z".to_string()),
            last_authenticated_at: Some("2029-01-01T00:00:00Z".to_string()),
            last_refreshed_at: None,
            error: None,
        };

        let serialized = serde_json::to_string(&snapshot).expect("serialize public snapshot");
        for forbidden_field in [
            "refreshToken",
            "accessToken\"",
            "idToken",
            "authorizationCode",
            "pkceVerifier",
            "nonce",
            "state\"",
            "callbackUrl",
            "avatarUrl",
            "picture",
        ] {
            assert!(!serialized.contains(forbidden_field));
        }
    }
}
