use std::{
    error::Error,
    fmt::{Display, Formatter},
    future::Future,
    pin::Pin,
    str::FromStr,
    sync::Arc,
    time::Duration,
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use openidconnect::{
    core::{
        CoreAuthDisplay, CoreClaimName, CoreClaimType, CoreClient, CoreClientAuthMethod,
        CoreErrorResponseType, CoreGrantType, CoreIdToken, CoreJsonWebKey,
        CoreJweContentEncryptionAlgorithm, CoreJweKeyManagementAlgorithm, CoreJwsSigningAlgorithm,
        CoreResponseMode, CoreResponseType, CoreSubjectIdentifierType, CoreTokenResponse,
        CoreUserInfoClaims,
    },
    url::Url,
    AccessToken, AdditionalProviderMetadata, AsyncHttpClient, AuthenticationFlow,
    AuthorizationCode, ClientId, CodeTokenRequest, CsrfToken, EndpointMaybeSet, EndpointNotSet,
    EndpointSet, HttpRequest, HttpResponse, IssuerUrl, Nonce, OAuth2TokenResponse,
    PkceCodeChallenge, PkceCodeVerifier, ProviderMetadata, RedirectUrl, RefreshToken,
    RequestTokenError, Scope, StandardErrorResponse, SubjectIdentifier, UserInfoError,
};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use super::{
    config::AuthProviderConfig,
    secret::SecretString,
    session::{now_epoch_seconds, AuthUser},
};

const HTTP_CONNECT_TIMEOUT_SECONDS: u64 = 10;
const HTTP_TOTAL_TIMEOUT_SECONDS: u64 = 20;
const MAX_OIDC_RESPONSE_BYTES: usize = 256 * 1024;
const ID_TOKEN_CLOCK_SKEW_SECONDS: i64 = 5 * 60;

type NexusProviderMetadata = ProviderMetadata<
    NexusAdditionalProviderMetadata,
    CoreAuthDisplay,
    CoreClientAuthMethod,
    CoreClaimName,
    CoreClaimType,
    CoreGrantType,
    CoreJweContentEncryptionAlgorithm,
    CoreJweKeyManagementAlgorithm,
    CoreJsonWebKey,
    CoreResponseMode,
    CoreResponseType,
    CoreSubjectIdentifierType,
>;

type NexusOidcClient = CoreClient<
    EndpointSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointMaybeSet,
    EndpointMaybeSet,
>;

type NexusCodeTokenRequest<'a> =
    CodeTokenRequest<'a, StandardErrorResponse<CoreErrorResponseType>, CoreTokenResponse>;

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
struct NexusAdditionalProviderMetadata {
    #[serde(default)]
    code_challenge_methods_supported: Vec<String>,
}

impl AdditionalProviderMetadata for NexusAdditionalProviderMetadata {}

#[derive(Clone)]
struct DiscoveredProvider {
    metadata: NexusProviderMetadata,
}

impl DiscoveredProvider {
    fn client(&self, config: &AuthProviderConfig) -> Result<NexusOidcClient, ProviderError> {
        let redirect = RedirectUrl::new(config.redirect_uri.clone())
            .map_err(|_| ProviderError::Configuration)?;
        Ok(CoreClient::from_provider_metadata(
            self.metadata.clone(),
            ClientId::new(config.client_id.clone()),
            None,
        )
        .set_redirect_uri(redirect))
    }
}

#[derive(Clone)]
pub(crate) struct StandardOidcProviderAdapter {
    config: AuthProviderConfig,
    http_client: BoundedHttpClient,
    discovered: Arc<RwLock<Option<Arc<DiscoveredProvider>>>>,
}

pub(crate) struct AuthorizationRequest {
    pub url: SecretString,
    pub state: SecretString,
    pub nonce: SecretString,
    pub pkce_verifier: SecretString,
}

pub(crate) struct ProviderTokenSet {
    pub access_token: SecretString,
    pub refresh_token: Option<SecretString>,
    pub access_token_expires_at: Option<i64>,
    pub user: AuthUser,
    pub avatar: ProviderAvatar,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ProviderAvatar {
    /// 本次刷新没有获得新的用户资料，保留现有本地头像。
    Unchanged,
    /// Provider 已明确返回用户资料，但没有 picture Claim。
    Absent,
    /// Provider 返回的候选 URL；仅交给 Rust 头像模块校验和下载。
    RemoteUrl(String),
}

struct ProviderIdentity {
    user: AuthUser,
    avatar: ProviderAvatar,
}

#[async_trait::async_trait]
pub(crate) trait OidcProvider: Send + Sync {
    async fn authorization_request(&self) -> Result<AuthorizationRequest, ProviderError>;

    async fn exchange_code(
        &self,
        code: &SecretString,
        pkce_verifier: &SecretString,
        nonce: &SecretString,
    ) -> Result<ProviderTokenSet, ProviderError>;

    async fn refresh(
        &self,
        refresh_token: &SecretString,
        expected_user: &AuthUser,
    ) -> Result<ProviderTokenSet, ProviderError>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProviderError {
    Unavailable,
    Unsupported,
    Configuration,
    TokenRejected,
    TokenExchange,
    TokenValidation,
}

impl Display for ProviderError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        let code = match self {
            Self::Unavailable => "provider_unavailable",
            Self::Unsupported => "provider_unsupported",
            Self::Configuration => "provider_configuration_invalid",
            Self::TokenRejected => "provider_token_rejected",
            Self::TokenExchange => "provider_token_exchange_failed",
            Self::TokenValidation => "provider_token_validation_failed",
        };
        formatter.write_str(code)
    }
}

impl Error for ProviderError {}

impl StandardOidcProviderAdapter {
    pub fn new(config: AuthProviderConfig) -> Result<Self, ProviderError> {
        let inner = reqwest::ClientBuilder::new()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(HTTP_CONNECT_TIMEOUT_SECONDS))
            .timeout(Duration::from_secs(HTTP_TOTAL_TIMEOUT_SECONDS))
            .user_agent("NexusPilot-Desktop-Auth/1")
            .build()
            .map_err(|_| ProviderError::Configuration)?;
        Ok(Self {
            config,
            http_client: BoundedHttpClient {
                inner,
                max_response_bytes: MAX_OIDC_RESPONSE_BYTES,
            },
            discovered: Arc::new(RwLock::new(None)),
        })
    }

    pub async fn authorization_request(&self) -> Result<AuthorizationRequest, ProviderError> {
        let discovered = self.discover(false).await?;
        let client = discovered.client(&self.config)?;
        let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();
        let mut request = client
            .authorize_url(
                AuthenticationFlow::<CoreResponseType>::AuthorizationCode,
                CsrfToken::new_random,
                Nonce::new_random,
            )
            .set_pkce_challenge(pkce_challenge)
            .add_extra_param("resource", self.config.cloud_resource.indicator.clone())
            .add_extra_param("prompt", "consent");
        for scope in self
            .config
            .identity_scopes
            .iter()
            .chain(self.config.cloud_resource.scopes.iter())
            .filter(|scope| scope.as_str() != "openid")
        {
            request = request.add_scope(Scope::new(scope.clone()));
        }
        let (url, state, nonce) = request.url();
        Ok(AuthorizationRequest {
            url: SecretString::new(url.to_string()),
            state: SecretString::new(state.secret().to_string()),
            nonce: SecretString::new(nonce.secret().to_string()),
            pkce_verifier: SecretString::new(pkce_verifier.secret().to_string()),
        })
    }

    pub async fn exchange_code(
        &self,
        code: &SecretString,
        pkce_verifier: &SecretString,
        nonce: &SecretString,
    ) -> Result<ProviderTokenSet, ProviderError> {
        let discovered = self.discover(false).await?;
        let client = discovered.client(&self.config)?;
        let response = build_code_token_request(
            &client,
            code,
            pkce_verifier,
            &self.config.cloud_resource.indicator,
        )?
        .request_async(&self.http_client)
        .await
        .map_err(|error| map_token_error(error, false))?;

        let id_token = response
            .extra_fields()
            .id_token()
            .ok_or(ProviderError::TokenValidation)?
            .to_string();
        let mut identity = self
            .validate_id_token(&discovered, &id_token, Some(nonce), None)
            .await?;
        if let Some(user_info) = self
            .request_user_info(&client, response.access_token(), &identity.user.subject)
            .await?
        {
            identity = user_info;
        }

        let refresh_token = response
            .refresh_token()
            .map(|token| SecretString::new(token.secret().to_string()))
            .ok_or(ProviderError::TokenValidation)?;
        Ok(ProviderTokenSet {
            access_token: SecretString::new(response.access_token().secret().to_string()),
            refresh_token: Some(refresh_token),
            access_token_expires_at: token_expiry(response.expires_in()),
            user: identity.user,
            avatar: identity.avatar,
        })
    }

    pub async fn refresh(
        &self,
        refresh_token: &SecretString,
        expected_user: &AuthUser,
    ) -> Result<ProviderTokenSet, ProviderError> {
        let discovered = self.discover(true).await?;
        let client = discovered.client(&self.config)?;
        let response = client
            .exchange_refresh_token(&RefreshToken::new(refresh_token.expose().to_string()))
            .map_err(|_| ProviderError::Configuration)?
            .add_extra_param("resource", self.config.cloud_resource.indicator.clone())
            .request_async(&self.http_client)
            .await
            .map_err(|error| map_token_error(error, true))?;

        let id_token = response.extra_fields().id_token().map(ToString::to_string);
        let mut identity = if let Some(id_token) = id_token.as_deref() {
            self.validate_id_token(
                &discovered,
                id_token,
                None,
                Some(expected_user.subject.as_str()),
            )
            .await?
        } else {
            ProviderIdentity {
                user: expected_user.clone(),
                avatar: ProviderAvatar::Unchanged,
            }
        };
        if let Some(user_info) = self
            .request_user_info(&client, response.access_token(), &expected_user.subject)
            .await?
        {
            identity = user_info;
        } else {
            identity.avatar = preserve_avatar_when_user_info_is_unavailable(identity.avatar);
        }
        if identity.user.subject != expected_user.subject
            || identity.user.issuer != expected_user.issuer
        {
            return Err(ProviderError::TokenValidation);
        }

        Ok(ProviderTokenSet {
            access_token: SecretString::new(response.access_token().secret().to_string()),
            refresh_token: response
                .refresh_token()
                .map(|token| SecretString::new(token.secret().to_string())),
            access_token_expires_at: token_expiry(response.expires_in()),
            user: identity.user,
            avatar: identity.avatar,
        })
    }

    async fn validate_id_token(
        &self,
        discovered: &Arc<DiscoveredProvider>,
        id_token: &str,
        nonce: Option<&SecretString>,
        expected_subject: Option<&str>,
    ) -> Result<ProviderIdentity, ProviderError> {
        match validate_id_token_once(&self.config, discovered, id_token, nonce, expected_subject) {
            Ok(user) => Ok(user),
            Err(_) => {
                let refreshed = self.discover(true).await?;
                validate_id_token_once(&self.config, &refreshed, id_token, nonce, expected_subject)
            }
        }
    }

    async fn request_user_info(
        &self,
        client: &NexusOidcClient,
        access_token: &AccessToken,
        expected_subject: &str,
    ) -> Result<Option<ProviderIdentity>, ProviderError> {
        let request = match client.user_info(
            access_token.clone(),
            Some(SubjectIdentifier::new(expected_subject.to_string())),
        ) {
            Ok(request) => request,
            Err(_) => return Ok(None),
        };
        let response: Result<CoreUserInfoClaims, _> =
            request.request_async(&self.http_client).await;
        match response {
            Ok(claims) => Ok(Some(auth_user_from_user_info(&self.config, &claims)?)),
            Err(UserInfoError::Request(_) | UserInfoError::Response(_, _, _)) => Ok(None),
            Err(_) => Err(ProviderError::TokenValidation),
        }
    }

    async fn discover(&self, force: bool) -> Result<Arc<DiscoveredProvider>, ProviderError> {
        if !force {
            if let Some(discovered) = self.discovered.read().await.clone() {
                return Ok(discovered);
            }
        }

        let issuer =
            IssuerUrl::new(self.config.issuer.clone()).map_err(|_| ProviderError::Configuration)?;
        let metadata = NexusProviderMetadata::discover_async(issuer, &self.http_client)
            .await
            .map_err(|_| ProviderError::Unavailable)?;
        let discovered = Arc::new(validate_metadata(&self.config, metadata)?);
        *self.discovered.write().await = Some(discovered.clone());
        Ok(discovered)
    }
}

fn build_code_token_request<'a>(
    client: &'a NexusOidcClient,
    code: &SecretString,
    pkce_verifier: &SecretString,
    cloud_resource: &str,
) -> Result<NexusCodeTokenRequest<'a>, ProviderError> {
    Ok(client
        .exchange_code(AuthorizationCode::new(code.expose().to_string()))
        .map_err(|_| ProviderError::Configuration)?
        .set_pkce_verifier(PkceCodeVerifier::new(pkce_verifier.expose().to_string()))
        .add_extra_param("resource", cloud_resource.to_string()))
}

#[async_trait::async_trait]
impl OidcProvider for StandardOidcProviderAdapter {
    async fn authorization_request(&self) -> Result<AuthorizationRequest, ProviderError> {
        StandardOidcProviderAdapter::authorization_request(self).await
    }

    async fn exchange_code(
        &self,
        code: &SecretString,
        pkce_verifier: &SecretString,
        nonce: &SecretString,
    ) -> Result<ProviderTokenSet, ProviderError> {
        StandardOidcProviderAdapter::exchange_code(self, code, pkce_verifier, nonce).await
    }

    async fn refresh(
        &self,
        refresh_token: &SecretString,
        expected_user: &AuthUser,
    ) -> Result<ProviderTokenSet, ProviderError> {
        StandardOidcProviderAdapter::refresh(self, refresh_token, expected_user).await
    }
}

fn validate_metadata(
    config: &AuthProviderConfig,
    mut metadata: NexusProviderMetadata,
) -> Result<DiscoveredProvider, ProviderError> {
    if metadata.issuer().as_str() != config.issuer {
        return Err(ProviderError::Unsupported);
    }
    ensure_safe_https(metadata.authorization_endpoint().as_str())?;
    ensure_safe_https(metadata.jwks_uri().as_str())?;
    let token_endpoint = metadata
        .token_endpoint()
        .ok_or(ProviderError::Unsupported)?;
    ensure_safe_https(token_endpoint.as_str())?;
    if let Some(user_info) = metadata.userinfo_endpoint() {
        ensure_safe_https(user_info.as_str())?;
    }

    if !metadata.response_types_supported().iter().any(|types| {
        types.len() == 1
            && types
                .first()
                .is_some_and(|value| value == &CoreResponseType::Code)
    }) {
        return Err(ProviderError::Unsupported);
    }
    let grants = metadata
        .grant_types_supported()
        .ok_or(ProviderError::Unsupported)?;
    if !grants.contains(&CoreGrantType::AuthorizationCode)
        || !grants.contains(&CoreGrantType::RefreshToken)
    {
        return Err(ProviderError::Unsupported);
    }
    let auth_methods = metadata
        .token_endpoint_auth_methods_supported()
        .ok_or(ProviderError::Unsupported)?;
    if !auth_methods.contains(&CoreClientAuthMethod::None) {
        return Err(ProviderError::Unsupported);
    }
    if !metadata
        .additional_metadata()
        .code_challenge_methods_supported
        .iter()
        .any(|method| method == "S256")
    {
        return Err(ProviderError::Unsupported);
    }
    if let Some(scopes) = metadata.scopes_supported() {
        // API Resource permissions are intentionally absent from OIDC
        // `scopes_supported` in Logto and are validated by NexusPilot Cloud.
        for required in &config.identity_scopes {
            if !scopes.iter().any(|scope| scope.as_ref() == required) {
                return Err(ProviderError::Unsupported);
            }
        }
    }

    let allowed_signing_algorithms = metadata
        .id_token_signing_alg_values_supported()
        .iter()
        .filter(|algorithm| is_allowed_public_signing_algorithm(algorithm))
        .cloned()
        .collect::<Vec<_>>();
    if allowed_signing_algorithms.is_empty() {
        return Err(ProviderError::Unsupported);
    }
    metadata = metadata.set_id_token_signing_alg_values_supported(allowed_signing_algorithms);

    Ok(DiscoveredProvider { metadata })
}

fn ensure_safe_https(value: &str) -> Result<(), ProviderError> {
    let url = Url::parse(value).map_err(|_| ProviderError::Unsupported)?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(ProviderError::Unsupported);
    }
    Ok(())
}

fn is_allowed_public_signing_algorithm(value: &CoreJwsSigningAlgorithm) -> bool {
    matches!(
        value,
        CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha256
            | CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha384
            | CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha512
            | CoreJwsSigningAlgorithm::RsaSsaPssSha256
            | CoreJwsSigningAlgorithm::RsaSsaPssSha384
            | CoreJwsSigningAlgorithm::RsaSsaPssSha512
            | CoreJwsSigningAlgorithm::EcdsaP256Sha256
            | CoreJwsSigningAlgorithm::EcdsaP384Sha384
            | CoreJwsSigningAlgorithm::EdDsa
    )
}

fn validate_id_token_once(
    config: &AuthProviderConfig,
    discovered: &DiscoveredProvider,
    id_token: &str,
    nonce: Option<&SecretString>,
    expected_subject: Option<&str>,
) -> Result<ProviderIdentity, ProviderError> {
    let parsed = CoreIdToken::from_str(id_token).map_err(|_| ProviderError::TokenValidation)?;
    let client = discovered.client(config)?;
    let verifier = client
        .id_token_verifier()
        .set_issue_time_verifier_fn(|issued_at| {
            let latest_accepted = now_epoch_seconds().saturating_add(ID_TOKEN_CLOCK_SKEW_SECONDS);
            if issued_at.timestamp() <= latest_accepted {
                Ok(())
            } else {
                Err("ID token issue time is in the future".to_string())
            }
        });
    let claims = match nonce {
        Some(nonce) => parsed.claims(&verifier, &Nonce::new(nonce.expose().to_string())),
        None => parsed.claims(&verifier, |_nonce: Option<&Nonce>| Ok(())),
    }
    .map_err(|_| ProviderError::TokenValidation)?;
    validate_optional_not_before(id_token)?;

    if claims.audiences().len() > 1 && claims.authorized_party().is_none() {
        return Err(ProviderError::TokenValidation);
    }
    if let Some(party) = claims.authorized_party() {
        if party.as_str() != config.client_id {
            return Err(ProviderError::TokenValidation);
        }
    }
    if expected_subject.is_some_and(|subject| claims.subject().as_str() != subject) {
        return Err(ProviderError::TokenValidation);
    }
    auth_user_from_id_token(config, claims)
}

#[derive(Deserialize)]
struct JwtTemporalClaims {
    #[serde(default)]
    nbf: Option<i64>,
}

fn validate_optional_not_before(id_token: &str) -> Result<(), ProviderError> {
    let mut segments = id_token.split('.');
    let _header = segments.next().ok_or(ProviderError::TokenValidation)?;
    let payload = segments.next().ok_or(ProviderError::TokenValidation)?;
    let _signature = segments.next().ok_or(ProviderError::TokenValidation)?;
    if segments.next().is_some() {
        return Err(ProviderError::TokenValidation);
    }

    let payload = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| ProviderError::TokenValidation)?;
    let temporal = serde_json::from_slice::<JwtTemporalClaims>(&payload)
        .map_err(|_| ProviderError::TokenValidation)?;
    if temporal.nbf.is_some_and(|not_before| {
        not_before > now_epoch_seconds().saturating_add(ID_TOKEN_CLOCK_SKEW_SECONDS)
    }) {
        return Err(ProviderError::TokenValidation);
    }
    Ok(())
}

fn auth_user_from_id_token(
    config: &AuthProviderConfig,
    claims: &openidconnect::core::CoreIdTokenClaims,
) -> Result<ProviderIdentity, ProviderError> {
    build_auth_user(
        config,
        claims.subject().as_str(),
        claims
            .nickname()
            .as_ref()
            .and_then(|value| value.get(None))
            .map(|value| value.as_str().to_string()),
        claims
            .name()
            .as_ref()
            .and_then(|value| value.get(None))
            .map(|value| value.as_str().to_string()),
        claims
            .preferred_username()
            .as_ref()
            .map(|value| value.as_str().to_string()),
        claims
            .email()
            .as_ref()
            .map(|value| value.as_str().to_string()),
        claims.email_verified(),
        claims
            .picture()
            .as_ref()
            .and_then(|value| value.get(None))
            .map(|value| value.as_str().to_string()),
    )
}

fn auth_user_from_user_info(
    config: &AuthProviderConfig,
    claims: &CoreUserInfoClaims,
) -> Result<ProviderIdentity, ProviderError> {
    build_auth_user(
        config,
        claims.subject().as_str(),
        claims
            .nickname()
            .as_ref()
            .and_then(|value| value.get(None))
            .map(|value| value.as_str().to_string()),
        claims
            .name()
            .as_ref()
            .and_then(|value| value.get(None))
            .map(|value| value.as_str().to_string()),
        claims
            .preferred_username()
            .as_ref()
            .map(|value| value.as_str().to_string()),
        claims
            .email()
            .as_ref()
            .map(|value| value.as_str().to_string()),
        claims.email_verified(),
        claims
            .picture()
            .as_ref()
            .and_then(|value| value.get(None))
            .map(|value| value.as_str().to_string()),
    )
}

#[allow(clippy::too_many_arguments)]
fn build_auth_user(
    config: &AuthProviderConfig,
    subject: &str,
    nickname: Option<String>,
    name: Option<String>,
    preferred_username: Option<String>,
    email: Option<String>,
    email_verified: Option<bool>,
    picture: Option<String>,
) -> Result<ProviderIdentity, ProviderError> {
    let subject = normalized_optional(subject.to_string()).ok_or(ProviderError::TokenValidation)?;
    let email = email.and_then(normalized_optional);
    let handle = preferred_username
        .and_then(normalized_optional)
        .map(|value| value.to_lowercase());
    let display_name = nickname
        .and_then(normalized_optional)
        .or_else(|| name.and_then(normalized_optional))
        .or_else(|| handle.clone())
        .or_else(|| email.clone());
    let avatar = picture
        .and_then(normalized_avatar_source)
        .map(ProviderAvatar::RemoteUrl)
        .unwrap_or(ProviderAvatar::Absent);
    Ok(ProviderIdentity {
        user: AuthUser {
            provider_id: config.config_id.clone(),
            issuer: config.issuer.clone(),
            subject,
            display_name,
            handle,
            email,
            email_verified,
            avatar_revision: None,
        },
        avatar,
    })
}

fn normalized_optional(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty() && trimmed.len() <= 512).then(|| trimmed.to_string())
}

fn normalized_avatar_source(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty() && trimmed.len() <= 2_048).then(|| trimmed.to_string())
}

fn preserve_avatar_when_user_info_is_unavailable(avatar: ProviderAvatar) -> ProviderAvatar {
    match avatar {
        // ID Token 可以合法省略 profile Claims；只有成功的 UserInfo 缺少 picture
        // 才能被视为 Provider 明确返回“无头像”。
        ProviderAvatar::Absent => ProviderAvatar::Unchanged,
        avatar => avatar,
    }
}

fn token_expiry(expires_in: Option<Duration>) -> Option<i64> {
    expires_in.and_then(|duration| {
        i64::try_from(duration.as_secs())
            .ok()
            .map(|seconds| now_epoch_seconds().saturating_add(seconds))
    })
}

fn map_token_error(
    error: RequestTokenError<AuthHttpClientError, StandardErrorResponse<CoreErrorResponseType>>,
    refresh: bool,
) -> ProviderError {
    match error {
        RequestTokenError::ServerResponse(response)
            if response.error() == &CoreErrorResponseType::InvalidGrant =>
        {
            if refresh {
                ProviderError::TokenRejected
            } else {
                ProviderError::TokenExchange
            }
        }
        RequestTokenError::Request(_) => ProviderError::Unavailable,
        RequestTokenError::ServerResponse(_)
        | RequestTokenError::Parse(_, _)
        | RequestTokenError::Other(_) => ProviderError::TokenExchange,
    }
}

#[derive(Clone)]
struct BoundedHttpClient {
    inner: reqwest::Client,
    max_response_bytes: usize,
}

#[derive(Debug)]
enum AuthHttpClientError {
    InvalidRequest,
    Request,
    ResponseTooLarge,
    InvalidResponse,
}

impl Display for AuthHttpClientError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        let code = match self {
            Self::InvalidRequest => "invalid_request",
            Self::Request => "request_failed",
            Self::ResponseTooLarge => "response_too_large",
            Self::InvalidResponse => "invalid_response",
        };
        formatter.write_str(code)
    }
}

impl Error for AuthHttpClientError {}

impl<'c> AsyncHttpClient<'c> for BoundedHttpClient {
    type Error = AuthHttpClientError;
    type Future = Pin<Box<dyn Future<Output = Result<HttpResponse, Self::Error>> + Send + 'c>>;

    fn call(&'c self, request: HttpRequest) -> Self::Future {
        Box::pin(async move {
            let request = reqwest::Request::try_from(request)
                .map_err(|_| AuthHttpClientError::InvalidRequest)?;
            let mut response = self
                .inner
                .execute(request)
                .await
                .map_err(|_| AuthHttpClientError::Request)?;
            if response
                .content_length()
                .is_some_and(|length| length > self.max_response_bytes as u64)
            {
                return Err(AuthHttpClientError::ResponseTooLarge);
            }

            let status = response.status();
            let version = response.version();
            let headers = response.headers().clone();
            let mut body = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| AuthHttpClientError::Request)?
            {
                if body.len().saturating_add(chunk.len()) > self.max_response_bytes {
                    return Err(AuthHttpClientError::ResponseTooLarge);
                }
                body.extend_from_slice(&chunk);
            }

            let mut builder = openidconnect::http::Response::builder()
                .status(status)
                .version(version);
            for (name, value) in &headers {
                builder = builder.header(name, value);
            }
            builder
                .body(body)
                .map_err(|_| AuthHttpClientError::InvalidResponse)
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use openidconnect::{
        core::CoreJwsSigningAlgorithm,
        http::{header::CONTENT_TYPE, HeaderValue, StatusCode},
        url::form_urlencoded,
        HttpRequest, HttpResponse,
    };

    use super::{
        build_auth_user, build_code_token_request, ensure_safe_https,
        is_allowed_public_signing_algorithm, preserve_avatar_when_user_info_is_unavailable,
        validate_metadata, validate_optional_not_before, NexusProviderMetadata, ProviderAvatar,
        SecretString,
    };
    use crate::auth::{config::AuthProviderConfig, session::now_epoch_seconds};

    #[test]
    fn endpoint_validation_rejects_non_https_credentials_and_fragments() {
        assert!(ensure_safe_https("https://issuer.test/oidc/token").is_ok());
        assert!(ensure_safe_https("http://issuer.test/token").is_err());
        assert!(ensure_safe_https("https://user@issuer.test/token").is_err());
        assert!(ensure_safe_https("https://issuer.test/token#fragment").is_err());
    }

    #[test]
    fn public_client_algorithms_reject_shared_secret_and_none() {
        assert!(is_allowed_public_signing_algorithm(
            &CoreJwsSigningAlgorithm::EcdsaP384Sha384
        ));
        assert!(is_allowed_public_signing_algorithm(
            &CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha256
        ));
        assert!(!is_allowed_public_signing_algorithm(
            &CoreJwsSigningAlgorithm::HmacSha256
        ));
        assert!(!is_allowed_public_signing_algorithm(
            &CoreJwsSigningAlgorithm::None
        ));
    }

    #[test]
    fn authorization_code_token_exchange_includes_cloud_resource() {
        let config = AuthProviderConfig::from_embedded().expect("embedded config");
        let metadata = serde_json::from_value::<NexusProviderMetadata>(serde_json::json!({
            "issuer": config.issuer,
            "authorization_endpoint": "https://auth.nieex.com/oidc/auth",
            "token_endpoint": "https://auth.nieex.com/oidc/token",
            "jwks_uri": "https://auth.nieex.com/oidc/jwks",
            "response_types_supported": ["code"],
            "subject_types_supported": ["public"],
            "id_token_signing_alg_values_supported": ["ES384"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "token_endpoint_auth_methods_supported": ["none"],
            "code_challenge_methods_supported": ["S256"]
        }))
        .expect("provider metadata");
        let discovered = validate_metadata(&config, metadata).expect("validated metadata");
        let client = discovered.client(&config).expect("OIDC client");
        let request = build_code_token_request(
            &client,
            &SecretString::new("authorization-code".to_string()),
            &SecretString::new("pkce-verifier".to_string()),
            &config.cloud_resource.indicator,
        )
        .expect("code token request");

        request
            .request(
                &|request: HttpRequest| -> Result<HttpResponse, std::io::Error> {
                    let parameters = form_urlencoded::parse(request.body())
                        .into_owned()
                        .collect::<HashMap<String, String>>();
                    assert_eq!(
                        parameters.get("grant_type").map(String::as_str),
                        Some("authorization_code")
                    );
                    assert_eq!(
                        parameters.get("code_verifier").map(String::as_str),
                        Some("pkce-verifier")
                    );
                    assert_eq!(
                        parameters.get("resource").map(String::as_str),
                        Some("https://api.nexuspilot.dev")
                    );

                    let mut response = HttpResponse::new(
                        br#"{"access_token":"access-token","token_type":"Bearer"}"#.to_vec(),
                    );
                    *response.status_mut() = StatusCode::OK;
                    response
                        .headers_mut()
                        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                    Ok(response)
                },
            )
            .expect("parsed token response");
    }

    #[test]
    fn optional_not_before_rejects_tokens_that_are_not_yet_valid() {
        let future_payload = serde_json::json!({ "nbf": now_epoch_seconds() + 3_600 });
        let current_payload = serde_json::json!({ "nbf": now_epoch_seconds() - 1 });
        let token = |payload: serde_json::Value| {
            format!(
                "header.{}.signature",
                URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("encode payload"))
            )
        };

        assert!(validate_optional_not_before(&token(current_payload)).is_ok());
        assert!(validate_optional_not_before(&token(future_payload)).is_err());
    }

    #[test]
    fn standard_picture_claim_is_kept_internal_and_never_becomes_a_public_url_field() {
        let config = AuthProviderConfig::from_embedded().expect("embedded config");
        let identity = build_auth_user(
            &config,
            "subject",
            Some("Demo".to_string()),
            None,
            Some("demo".to_string()),
            Some("demo@example.test".to_string()),
            Some(true),
            Some("https://cdn.example.com/avatar.png".to_string()),
        )
        .expect("provider identity");

        assert_eq!(
            identity.avatar,
            ProviderAvatar::RemoteUrl("https://cdn.example.com/avatar.png".to_string())
        );
        assert!(identity.user.avatar_revision.is_none());
        let public_user = serde_json::to_string(&identity.user).expect("serialize auth user");
        assert!(!public_user.contains("cdn.example.com"));
        assert!(!public_user.contains("picture"));
        assert!(!public_user.contains("avatarUrl"));
    }

    #[test]
    fn missing_refresh_user_info_preserves_the_last_avatar_unless_a_new_picture_is_verified() {
        assert_eq!(
            preserve_avatar_when_user_info_is_unavailable(ProviderAvatar::Absent),
            ProviderAvatar::Unchanged
        );
        let remote = ProviderAvatar::RemoteUrl("https://cdn.example.com/avatar.png".to_string());
        assert_eq!(
            preserve_avatar_when_user_info_is_unavailable(remote.clone()),
            remote
        );
    }
}
