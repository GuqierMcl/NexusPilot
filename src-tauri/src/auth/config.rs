use std::{
    error::Error,
    fmt::{Display, Formatter, Write},
};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use url::Url;

const EMBEDDED_AUTH_PROVIDER_CONFIG: &str = include_str!("../../auth-provider.json");
const CURRENT_SCHEMA_VERSION: u32 = 2;
const REQUIRED_IDENTITY_SCOPES: [&str; 4] = ["openid", "profile", "email", "offline_access"];
const CLOUD_RESOURCE_INDICATOR: &str = "https://api.nexuspilot.dev";
const REQUIRED_CLOUD_SCOPES: [&str; 1] = ["cloud:access"];
const REDIRECT_URI: &str = "dev.nexuspilot://auth/callback";
const POST_SIGN_OUT_REDIRECT_URI: &str = "dev.nexuspilot://auth/signed-out";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthProviderConfig {
    pub schema_version: u32,
    pub config_id: String,
    pub display_name: String,
    pub issuer: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub post_sign_out_redirect_uri: Option<String>,
    pub identity_scopes: Vec<String>,
    pub cloud_resource: CloudResourceConfig,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudResourceConfig {
    pub indicator: String,
    pub scopes: Vec<String>,
}

impl AuthProviderConfig {
    pub fn from_embedded() -> Result<Self, AuthProviderConfigError> {
        let config: Self = serde_json::from_str(EMBEDDED_AUTH_PROVIDER_CONFIG)
            .map_err(|_| AuthProviderConfigError::InvalidJson)?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), AuthProviderConfigError> {
        if self.schema_version != CURRENT_SCHEMA_VERSION {
            return Err(AuthProviderConfigError::UnsupportedSchemaVersion);
        }
        if self.config_id.trim().is_empty() || self.config_id.len() > 128 {
            return Err(AuthProviderConfigError::InvalidField("configId"));
        }
        if self.display_name.trim().is_empty() || self.display_name.len() > 128 {
            return Err(AuthProviderConfigError::InvalidField("displayName"));
        }
        if self.client_id.trim().is_empty() || self.client_id.len() > 256 {
            return Err(AuthProviderConfigError::InvalidField("clientId"));
        }

        let issuer = Url::parse(&self.issuer)
            .map_err(|_| AuthProviderConfigError::InvalidField("issuer"))?;
        if issuer.scheme() != "https"
            || issuer.host_str().is_none()
            || !issuer.username().is_empty()
            || issuer.password().is_some()
            || issuer.query().is_some()
            || issuer.fragment().is_some()
            || issuer.as_str().ends_with('/')
        {
            return Err(AuthProviderConfigError::InvalidField("issuer"));
        }

        if self.redirect_uri != REDIRECT_URI {
            return Err(AuthProviderConfigError::InvalidField("redirectUri"));
        }
        if self.post_sign_out_redirect_uri.as_deref() != Some(POST_SIGN_OUT_REDIRECT_URI) {
            return Err(AuthProviderConfigError::InvalidField(
                "postSignOutRedirectUri",
            ));
        }
        if !self
            .identity_scopes
            .iter()
            .map(String::as_str)
            .eq(REQUIRED_IDENTITY_SCOPES)
        {
            return Err(AuthProviderConfigError::InvalidField("identityScopes"));
        }

        let cloud_resource = Url::parse(&self.cloud_resource.indicator)
            .map_err(|_| AuthProviderConfigError::InvalidField("cloudResource.indicator"))?;
        if self.cloud_resource.indicator != CLOUD_RESOURCE_INDICATOR
            || cloud_resource.scheme() != "https"
            || cloud_resource.host_str().is_none()
            || !cloud_resource.username().is_empty()
            || cloud_resource.password().is_some()
            || cloud_resource.query().is_some()
            || cloud_resource.fragment().is_some()
            || self.cloud_resource.indicator.ends_with('/')
        {
            return Err(AuthProviderConfigError::InvalidField(
                "cloudResource.indicator",
            ));
        }
        if !self
            .cloud_resource
            .scopes
            .iter()
            .map(String::as_str)
            .eq(REQUIRED_CLOUD_SCOPES)
        {
            return Err(AuthProviderConfigError::InvalidField(
                "cloudResource.scopes",
            ));
        }

        Ok(())
    }

    pub fn fingerprint(&self) -> String {
        let normalized_issuer = Url::parse(&self.issuer)
            .map(|issuer| issuer.to_string())
            .unwrap_or_else(|_| self.issuer.clone());
        let mut hasher = Sha256::new();
        hasher.update(self.schema_version.to_be_bytes());
        for component in [
            self.config_id.as_bytes(),
            normalized_issuer.as_bytes(),
            self.client_id.as_bytes(),
            self.redirect_uri.as_bytes(),
            self.cloud_resource.indicator.as_bytes(),
        ] {
            hasher.update((component.len() as u64).to_be_bytes());
            hasher.update(component);
        }
        for scopes in [&self.identity_scopes, &self.cloud_resource.scopes] {
            hasher.update((scopes.len() as u64).to_be_bytes());
            for scope in scopes {
                hasher.update((scope.len() as u64).to_be_bytes());
                hasher.update(scope.as_bytes());
            }
        }
        let digest = hasher.finalize();
        let mut fingerprint = String::with_capacity(digest.len() * 2);
        for byte in digest {
            write!(&mut fingerprint, "{byte:02x}").expect("writing to a String cannot fail");
        }
        fingerprint
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthProviderConfigError {
    InvalidJson,
    UnsupportedSchemaVersion,
    InvalidField(&'static str),
}

impl AuthProviderConfigError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidJson => "invalid_json",
            Self::UnsupportedSchemaVersion => "unsupported_schema_version",
            Self::InvalidField(_) => "invalid_field",
        }
    }
}

impl Display for AuthProviderConfigError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidJson => formatter.write_str("embedded auth provider config is invalid"),
            Self::UnsupportedSchemaVersion => {
                formatter.write_str("embedded auth provider schema version is unsupported")
            }
            Self::InvalidField(field) => {
                write!(
                    formatter,
                    "embedded auth provider field is invalid: {field}"
                )
            }
        }
    }
}

impl Error for AuthProviderConfigError {}

#[cfg(test)]
mod tests {
    use super::{AuthProviderConfig, AuthProviderConfigError};

    #[test]
    fn embedded_production_config_is_valid() {
        let config = AuthProviderConfig::from_embedded().expect("embedded config should be valid");

        assert_eq!(config.schema_version, 2);
        assert_eq!(config.config_id, "nexuspilot-account-production-v3");
        assert_eq!(config.issuer, "https://auth.nieex.com/oidc");
        assert_eq!(config.client_id, "tpg7jhxz09x0y9z5fcav7");
        assert_eq!(config.redirect_uri, "dev.nexuspilot://auth/callback");
        assert_eq!(
            config.cloud_resource.indicator,
            "https://api.nexuspilot.dev"
        );
        assert_eq!(config.cloud_resource.scopes, ["cloud:access"]);
        assert_eq!(
            config.post_sign_out_redirect_uri.as_deref(),
            Some("dev.nexuspilot://auth/signed-out")
        );
        assert_eq!(config.fingerprint().len(), 64);
    }

    #[test]
    fn fingerprint_changes_when_provider_identity_changes() {
        let config = AuthProviderConfig::from_embedded().expect("embedded config should be valid");
        let original = config.fingerprint();
        let mut changed = config.clone();
        changed.client_id.push_str("-next");

        assert_ne!(original, changed.fingerprint());

        let mut changed_resource = config.clone();
        changed_resource.cloud_resource.scopes[0] = "cloud:other".to_string();
        assert_ne!(original, changed_resource.fingerprint());
    }

    #[test]
    fn rejects_non_https_issuer() {
        let mut config =
            AuthProviderConfig::from_embedded().expect("embedded config should be valid");
        config.issuer = "http://auth.nieex.com/oidc".to_string();

        assert_eq!(
            config.validate(),
            Err(AuthProviderConfigError::InvalidField("issuer"))
        );
    }

    #[test]
    fn rejects_redirect_or_scope_drift() {
        let mut redirect =
            AuthProviderConfig::from_embedded().expect("embedded config should be valid");
        redirect.redirect_uri = "dev.nexuspilot://other/callback".to_string();
        assert_eq!(
            redirect.validate(),
            Err(AuthProviderConfigError::InvalidField("redirectUri"))
        );

        let mut scopes =
            AuthProviderConfig::from_embedded().expect("embedded config should be valid");
        scopes.identity_scopes.pop();
        assert_eq!(
            scopes.validate(),
            Err(AuthProviderConfigError::InvalidField("identityScopes"))
        );

        let mut resource =
            AuthProviderConfig::from_embedded().expect("embedded config should be valid");
        resource.cloud_resource.indicator = "https://api.example.test".to_string();
        assert_eq!(
            resource.validate(),
            Err(AuthProviderConfigError::InvalidField(
                "cloudResource.indicator"
            ))
        );
    }
}
