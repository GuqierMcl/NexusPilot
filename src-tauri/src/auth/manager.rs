use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, MutexGuard,
};

use tauri_plugin_opener::open_url;
use tokio::sync::Mutex as AsyncMutex;
use url::Url;
use uuid::Uuid;

use super::{
    avatar::AuthAvatarStore,
    callback::{parse_auth_callback, AuthCallbackResult},
    config::AuthProviderConfig,
    credential_store::AuthCredentialStore,
    error::{AuthError, AuthErrorKind, AuthPublicError},
    provider::{
        OidcProvider, ProviderAvatar, ProviderError, ProviderTokenSet, StandardOidcProviderAdapter,
    },
    session::{
        epoch_seconds_to_string, now_epoch_seconds, AuthOperation, AuthProviderAvailability,
        AuthProviderSummary, AuthSessionPhase, AuthSessionSnapshot, AuthUser, PendingLogin,
        PersistedAuthSession, RuntimeTokens, StoredAuthState,
    },
};

const PENDING_LOGIN_TTL_SECONDS: i64 = 10 * 60;
const ACCESS_TOKEN_REFRESH_WINDOW_SECONDS: i64 = 60;

type SnapshotSink = Arc<dyn Fn(AuthSessionSnapshot) + Send + Sync>;
type BrowserOpener = Arc<dyn Fn(&str) -> Result<(), ()> + Send + Sync>;

#[derive(Clone)]
pub struct AuthManager {
    inner: Arc<AuthManagerInner>,
}

struct AuthManagerInner {
    config: Option<AuthProviderConfig>,
    provider: Option<Arc<dyn OidcProvider>>,
    credential_store: Arc<dyn AuthCredentialStore>,
    avatar_store: AuthAvatarStore,
    avatar_generation: AtomicU64,
    state: Mutex<AuthManagerState>,
    operation_lock: AsyncMutex<()>,
    snapshot_sink: SnapshotSink,
    browser_opener: BrowserOpener,
}

struct AuthManagerState {
    credentials: StoredAuthState,
    runtime_tokens: Option<RuntimeTokens>,
    snapshot: AuthSessionSnapshot,
    credentials_loaded: bool,
    auth_disabled: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AuthAccessTokenError {
    Unauthenticated,
    TemporarilyUnavailable,
    ReauthenticationRequired,
    SystemInternal,
}

impl AuthManager {
    pub fn new(
        config: Result<AuthProviderConfig, AuthError>,
        credential_store: Arc<dyn AuthCredentialStore>,
        avatar_store: AuthAvatarStore,
        snapshot_sink: SnapshotSink,
    ) -> Self {
        let browser_opener: BrowserOpener =
            Arc::new(|url| open_url(url, None::<&str>).map_err(|_| ()));
        Self::with_dependencies(
            config,
            credential_store,
            avatar_store,
            snapshot_sink,
            browser_opener,
        )
    }

    fn with_dependencies(
        config: Result<AuthProviderConfig, AuthError>,
        credential_store: Arc<dyn AuthCredentialStore>,
        avatar_store: AuthAvatarStore,
        snapshot_sink: SnapshotSink,
        browser_opener: BrowserOpener,
    ) -> Self {
        let (config, provider, snapshot) = match config {
            Ok(config) => {
                let summary = AuthProviderSummary {
                    id: config.config_id.clone(),
                    display_name: config.display_name.clone(),
                };
                match StandardOidcProviderAdapter::new(config.clone()) {
                    Ok(provider) => (
                        Some(config),
                        Some(Arc::new(provider) as Arc<dyn OidcProvider>),
                        AuthSessionSnapshot::restoring(Some(summary)),
                    ),
                    Err(_) => {
                        let mut snapshot = AuthSessionSnapshot::restoring(Some(summary.clone()));
                        snapshot.phase = AuthSessionPhase::Anonymous;
                        snapshot.provider_availability =
                            AuthProviderAvailability::TemporarilyUnavailable;
                        snapshot.error =
                            Some(AuthPublicError::from_kind(AuthErrorKind::ConfigInvalid));
                        (Some(config), None, snapshot)
                    }
                }
            }
            Err(error) => {
                let mut snapshot = AuthSessionSnapshot::restoring(None);
                snapshot.phase = AuthSessionPhase::Anonymous;
                snapshot.provider_availability = AuthProviderAvailability::TemporarilyUnavailable;
                snapshot.error = Some(error.public());
                (None, None, snapshot)
            }
        };

        Self {
            inner: Arc::new(AuthManagerInner {
                config,
                provider,
                credential_store,
                avatar_store,
                avatar_generation: AtomicU64::new(0),
                state: Mutex::new(AuthManagerState {
                    credentials: StoredAuthState::default(),
                    runtime_tokens: None,
                    snapshot,
                    credentials_loaded: false,
                    auth_disabled: false,
                }),
                operation_lock: AsyncMutex::new(()),
                snapshot_sink,
                browser_opener,
            }),
        }
    }

    pub fn snapshot(&self) -> AuthSessionSnapshot {
        self.lock_state().snapshot.clone()
    }

    /// 向 Rust 内部受信任调用方借出当前可用 Access Token 的短生命周期副本。
    ///
    /// 此接口不会读取或返回 Refresh Token，也不会穿过 Tauri IPC。所有刷新继续复用
    /// AuthManager 的单一 operation lock，从而保证 Refresh Token Rotation 串行执行。
    pub(crate) async fn usable_access_token(
        &self,
    ) -> Result<super::secret::SecretString, AuthAccessTokenError> {
        let _operation = self.inner.operation_lock.lock().await;
        self.ensure_auth_available()
            .map_err(|error| access_token_error_from_public(&error))?;
        self.ensure_credentials_loaded()
            .await
            .map_err(|error| access_token_error_from_public(&error))?;

        let now = now_epoch_seconds();
        if let Some(access_token) = self
            .lock_state()
            .runtime_tokens
            .as_ref()
            .and_then(|tokens| {
                (tokens.has_usable_access_token(now, ACCESS_TOKEN_REFRESH_WINDOW_SECONDS)
                    && !tokens.access_token.expose().is_empty())
                .then(|| tokens.access_token.clone())
            })
        {
            return Ok(access_token);
        }

        if self.lock_state().credentials.session.is_none() {
            return Err(AuthAccessTokenError::Unauthenticated);
        }

        if let Err(error) = self.refresh_current_session().await {
            return Err(access_token_error_from_public(&error));
        }

        let now = now_epoch_seconds();
        self.lock_state()
            .runtime_tokens
            .as_ref()
            .and_then(|tokens| {
                (tokens.has_usable_access_token(now, ACCESS_TOKEN_REFRESH_WINDOW_SECONDS)
                    && !tokens.access_token.expose().is_empty())
                .then(|| tokens.access_token.clone())
            })
            .ok_or(AuthAccessTokenError::SystemInternal)
    }

    /// 返回与当前公开 Snapshot revision 精确对应的本地 PNG；竞态或缓存异常时返回空响应。
    pub fn avatar_bytes(&self, expected_revision: &str) -> Vec<u8> {
        let user = {
            let state = self.lock_state();
            if state.snapshot.phase != AuthSessionPhase::Authenticated {
                return Vec::new();
            }
            let Some(user) = state.snapshot.user.as_ref() else {
                return Vec::new();
            };
            if user.avatar_revision.as_deref() != Some(expected_revision) {
                return Vec::new();
            }
            user.clone()
        };
        match self.inner.avatar_store.load(&user, expected_revision) {
            Some(bytes) => bytes,
            None => {
                tauri_plugin_log::log::warn!(
                    "Local account avatar IPC request could not be satisfied: code=avatar_cache_revision_unavailable"
                );
                Vec::new()
            }
        }
    }

    pub fn restore_in_background(&self) {
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            manager.restore_session().await;
        });
    }

    pub async fn start_sign_in(&self) -> Result<AuthSessionSnapshot, AuthPublicError> {
        let _operation = self.inner.operation_lock.lock().await;
        self.ensure_auth_available()?;
        self.ensure_credentials_loaded().await?;

        let now = now_epoch_seconds();
        let (reusable_url, expired_credentials) = {
            let mut state = self.lock_state();
            let mut expired_credentials = None;
            if state
                .credentials
                .pending_login
                .as_ref()
                .is_some_and(|pending| pending.is_expired(now))
            {
                state.credentials.pending_login = None;
                expired_credentials = Some(state.credentials.clone());
            }
            let reusable_url = state
                .credentials
                .pending_login
                .as_ref()
                .and_then(|pending| {
                    (pending.provider_fingerprint == self.provider_fingerprint())
                        .then(|| pending.authorization_url.expose().to_string())
                });
            (reusable_url, expired_credentials)
        };
        if let Some(credentials) = expired_credentials {
            if let Err(error) = self.write_credentials(credentials).await {
                return Err(self.record_error(error.kind(), AuthProviderAvailability::Unknown));
            }
        }

        if let Some(url) = reusable_url {
            self.set_signing_in(None);
            if (self.inner.browser_opener)(&url).is_err() {
                return Err(self.record_error(
                    AuthErrorKind::BrowserOpenFailed,
                    AuthProviderAvailability::Available,
                ));
            }
            return Ok(self.snapshot());
        }

        self.set_signing_in(None);
        let provider = self.provider()?;
        let request = match provider.authorization_request().await {
            Ok(request) => request,
            Err(error) => return Err(self.record_provider_error(error, false)),
        };
        let pending = PendingLogin {
            transaction_id: Uuid::new_v4().to_string(),
            provider_fingerprint: self.provider_fingerprint(),
            state: request.state,
            nonce: request.nonce,
            pkce_verifier: request.pkce_verifier,
            authorization_url: request.url,
            created_at: now,
            expires_at: now.saturating_add(PENDING_LOGIN_TTL_SECONDS),
        };
        let authorization_url = pending.authorization_url.expose().to_string();

        let credentials = {
            let mut state = self.lock_state();
            state.credentials.pending_login = Some(pending);
            state.credentials.clone()
        };
        if let Err(error) = self.write_credentials(credentials).await {
            {
                let mut state = self.lock_state();
                state.credentials.pending_login = None;
            }
            return Err(self.record_error(error.kind(), AuthProviderAvailability::Unknown));
        }
        {
            let mut state = self.lock_state();
            state.snapshot.provider_availability = AuthProviderAvailability::Available;
            state.snapshot.error = None;
        }
        self.publish_current();

        if (self.inner.browser_opener)(&authorization_url).is_err() {
            return Err(self.record_error(
                AuthErrorKind::BrowserOpenFailed,
                AuthProviderAvailability::Available,
            ));
        }
        Ok(self.snapshot())
    }

    pub async fn cancel_sign_in(&self) -> Result<AuthSessionSnapshot, AuthPublicError> {
        let _operation = self.inner.operation_lock.lock().await;
        self.ensure_credentials_loaded().await?;
        let credentials = {
            let mut state = self.lock_state();
            state.credentials.pending_login = None;
            state.credentials.clone()
        };
        if let Err(error) = self.write_credentials(credentials).await {
            return Err(self.record_error(error.kind(), AuthProviderAvailability::Unknown));
        }
        let mut state = self.lock_state();
        state.snapshot.operation = AuthOperation::Idle;
        state.snapshot.phase = phase_for_session(&state.credentials);
        state.snapshot.error = None;
        let snapshot = state.snapshot.clone();
        drop(state);
        self.publish(snapshot.clone());
        Ok(snapshot)
    }

    pub async fn retry_session(&self) -> Result<AuthSessionSnapshot, AuthPublicError> {
        let _operation = self.inner.operation_lock.lock().await;
        self.ensure_auth_available()?;
        self.ensure_credentials_loaded().await?;
        if self.lock_state().credentials.session.is_none() {
            return Err(self.record_error(
                AuthErrorKind::ReauthenticationRequired,
                AuthProviderAvailability::Available,
            ));
        }
        self.refresh_current_session().await
    }

    pub async fn sign_out(&self) -> Result<AuthSessionSnapshot, AuthPublicError> {
        let _operation = self.inner.operation_lock.lock().await;
        self.invalidate_avatar_sync();
        // 即使系统凭据读取失败，也继续尝试 Tombstone/删除；本地退出优先于远端退出。
        let _ = self.ensure_credentials_loaded().await;
        {
            let mut state = self.lock_state();
            state.snapshot.operation = AuthOperation::SigningOut;
            state.snapshot.error = None;
        }
        self.publish_current();

        let avatar_user = {
            let mut state = self.lock_state();
            let avatar_user = state
                .credentials
                .session
                .take()
                .map(|session| session.user)
                .or_else(|| state.snapshot.user.clone());
            state.credentials.pending_login = None;
            state.runtime_tokens = None;
            avatar_user
        };

        if let Some(user) = avatar_user.as_ref() {
            if let Err(error) = self.inner.avatar_store.remove_for_user(user) {
                tauri_plugin_log::log::warn!(
                    "Unable to clear local account avatar cache after sign-out: code={}",
                    error.code()
                );
            }
        }

        if let Err(error) = self.persist_guaranteed_local_logout().await {
            let mut state = self.lock_state();
            state.auth_disabled = true;
            state.snapshot.phase = AuthSessionPhase::Anonymous;
            state.snapshot.operation = AuthOperation::Idle;
            state.snapshot.user = None;
            state.snapshot.has_usable_access_token = false;
            state.snapshot.access_token_expires_at = None;
            return Err(self.record_error_locked(
                &mut state,
                error.kind(),
                AuthProviderAvailability::TemporarilyUnavailable,
            ));
        }

        let snapshot = {
            let mut state = self.lock_state();
            state.credentials = StoredAuthState::default();
            state.runtime_tokens = None;
            state.snapshot.phase = AuthSessionPhase::Anonymous;
            state.snapshot.operation = AuthOperation::Idle;
            state.snapshot.provider_availability = AuthProviderAvailability::Available;
            state.snapshot.user = None;
            state.snapshot.has_usable_access_token = false;
            state.snapshot.access_token_expires_at = None;
            state.snapshot.last_authenticated_at = None;
            state.snapshot.last_refreshed_at = None;
            state.snapshot.error = None;
            state.snapshot.clone()
        };
        self.publish(snapshot.clone());
        tauri_plugin_log::log::info!(
            "Completed local account sign-out without contacting the authentication provider"
        );

        Ok(snapshot)
    }

    pub fn handle_callback_in_background(&self, url: Url) {
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = manager.handle_callback(url).await {
                tauri_plugin_log::log::warn!(
                    "Authentication callback was not completed: code={}",
                    error.code
                );
            }
        });
    }

    pub fn handle_signed_out_callback(&self) {
        tauri_plugin_log::log::debug!("Received provider signed-out callback");
    }

    async fn handle_callback(&self, url: Url) -> Result<AuthSessionSnapshot, AuthPublicError> {
        let parsed = parse_auth_callback(&url).map_err(|_| {
            self.record_error(
                AuthErrorKind::CallbackInvalid,
                AuthProviderAvailability::Available,
            )
        })?;
        let _operation = self.inner.operation_lock.lock().await;
        self.ensure_auth_available()?;
        self.ensure_credentials_loaded().await?;

        let (callback_state, callback_issuer) = match &parsed {
            AuthCallbackResult::AuthorizationCode { state, issuer, .. }
            | AuthCallbackResult::ProviderError { state, issuer, .. } => (state, issuer),
        };
        let now = now_epoch_seconds();
        let pending = {
            let mut state = self.lock_state();
            let Some(pending) = state.credentials.pending_login.as_ref() else {
                return Err(self.record_error_locked(
                    &mut state,
                    AuthErrorKind::CallbackInvalid,
                    AuthProviderAvailability::Available,
                ));
            };
            if pending.is_expired(now) {
                state.credentials.pending_login = None;
                None
            } else {
                if pending.provider_fingerprint != self.provider_fingerprint()
                    || !pending.state.constant_time_eq(callback_state.expose())
                    || callback_issuer
                        .as_deref()
                        .is_some_and(|issuer| Some(issuer) != self.issuer())
                {
                    return Err(self.record_error_locked(
                        &mut state,
                        AuthErrorKind::CallbackInvalid,
                        AuthProviderAvailability::Available,
                    ));
                }
                Some(
                    state
                        .credentials
                        .pending_login
                        .take()
                        .expect("validated pending login must exist"),
                )
            }
        };
        let Some(pending) = pending else {
            let credentials = self.lock_state().credentials.clone();
            let _ = self.write_credentials(credentials).await;
            return Err(self.record_error(
                AuthErrorKind::SignInExpired,
                AuthProviderAvailability::Available,
            ));
        };

        let credentials = self.lock_state().credentials.clone();
        if let Err(error) = self.write_credentials(credentials).await {
            {
                let mut state = self.lock_state();
                state.credentials.pending_login = Some(pending);
            }
            return Err(self.record_error(error.kind(), AuthProviderAvailability::Unknown));
        }

        match parsed {
            AuthCallbackResult::ProviderError { canceled, .. } => {
                let kind = if canceled {
                    AuthErrorKind::SignInCanceled
                } else {
                    AuthErrorKind::TokenExchangeFailed
                };
                let mut state = self.lock_state();
                state.snapshot.operation = AuthOperation::Idle;
                state.snapshot.phase = phase_for_session(&state.credentials);
                Err(self.record_error_locked(&mut state, kind, AuthProviderAvailability::Available))
            }
            AuthCallbackResult::AuthorizationCode { code, .. } => {
                self.set_signing_in(None);
                let provider = self.provider()?;
                match provider
                    .exchange_code(&code, &pending.pkce_verifier, &pending.nonce)
                    .await
                {
                    Ok(tokens) => self.establish_authenticated_session(tokens, now).await,
                    Err(error) => Err(self.record_provider_error(error, false)),
                }
            }
        }
    }

    async fn restore_session(&self) {
        let _operation = self.inner.operation_lock.lock().await;
        if self.inner.config.is_none() || self.inner.provider.is_none() {
            return;
        }
        let loaded = match self.load_credentials().await {
            Ok(loaded) => loaded,
            Err(error) => {
                self.invalidate_avatar_sync();
                let recovered_from_corruption = error.kind()
                    == AuthErrorKind::SecureStorageCorrupted
                    && self.clear_credentials().await.is_ok();
                let mut state = self.lock_state();
                if recovered_from_corruption {
                    state.credentials = StoredAuthState::default();
                }
                state.credentials_loaded = recovered_from_corruption;
                state.snapshot.phase = AuthSessionPhase::ReauthenticationRequired;
                state.snapshot.operation = AuthOperation::Idle;
                let _ = self.record_error_locked(
                    &mut state,
                    error.kind(),
                    AuthProviderAvailability::Unknown,
                );
                return;
            }
        };
        let expired_credentials = {
            let mut state = self.lock_state();
            state.credentials = loaded;
            state.credentials_loaded = true;
            if state
                .credentials
                .pending_login
                .as_ref()
                .is_some_and(|pending| pending.is_expired(now_epoch_seconds()))
            {
                state.credentials.pending_login = None;
                Some(state.credentials.clone())
            } else {
                None
            }
        };
        if let Some(credentials) = expired_credentials {
            let _ = self.write_credentials(credentials).await;
        }

        let fingerprint_matches = self
            .lock_state()
            .credentials
            .session
            .as_ref()
            .is_none_or(|session| session.provider_fingerprint == self.provider_fingerprint());
        if !fingerprint_matches {
            self.invalidate_avatar_sync();
            let avatar_user = self
                .lock_state()
                .credentials
                .session
                .as_ref()
                .map(|session| session.user.clone());
            if let Some(user) = avatar_user.as_ref() {
                let _ = self.inner.avatar_store.remove_for_user(user);
            }
            {
                let mut state = self.lock_state();
                state.credentials = StoredAuthState::default();
                state.runtime_tokens = None;
            }
            let _ = self.write_credentials(StoredAuthState::default()).await;
            let mut state = self.lock_state();
            state.snapshot.phase = AuthSessionPhase::ReauthenticationRequired;
            state.snapshot.operation = AuthOperation::Idle;
            let _ = self.record_error_locked(
                &mut state,
                AuthErrorKind::ProviderChanged,
                AuthProviderAvailability::Available,
            );
            return;
        }

        let already_restored = {
            let mut state = self.lock_state();
            let session = state.credentials.session.clone();
            let token_is_usable = state.runtime_tokens.as_ref().is_some_and(|tokens| {
                tokens.has_usable_access_token(
                    now_epoch_seconds(),
                    ACCESS_TOKEN_REFRESH_WINDOW_SECONDS,
                ) && !tokens.access_token.expose().is_empty()
            });
            if let Some(session) = session.filter(|_| token_is_usable) {
                apply_authenticated_snapshot(
                    &mut state,
                    &session,
                    AuthProviderAvailability::Available,
                );
                Some(state.snapshot.clone())
            } else {
                None
            }
        };
        if let Some(snapshot) = already_restored {
            self.publish(snapshot);
            return;
        }

        if self.lock_state().credentials.session.is_some() {
            let _ = self.refresh_current_session().await;
            return;
        }

        let snapshot = {
            let mut state = self.lock_state();
            state.snapshot.phase = AuthSessionPhase::Anonymous;
            state.snapshot.operation = if state.credentials.pending_login.is_some() {
                AuthOperation::SigningIn
            } else {
                AuthOperation::Idle
            };
            state.snapshot.provider_availability = AuthProviderAvailability::Unknown;
            state.snapshot.error = None;
            state.snapshot.clone()
        };
        self.publish(snapshot);
    }

    async fn refresh_current_session(&self) -> Result<AuthSessionSnapshot, AuthPublicError> {
        let session = self
            .lock_state()
            .credentials
            .session
            .clone()
            .ok_or_else(|| AuthPublicError::from_kind(AuthErrorKind::ReauthenticationRequired))?;
        {
            let mut state = self.lock_state();
            state.snapshot.phase = AuthSessionPhase::Authenticated;
            state.snapshot.operation = AuthOperation::Refreshing;
            state.snapshot.user = Some(session.user.clone());
            state.snapshot.error = None;
        }
        self.publish_current();

        let provider = self.provider()?;
        match provider
            .refresh(&session.refresh_token, &session.user)
            .await
        {
            Ok(tokens) => self.apply_refreshed_session(session, tokens).await,
            Err(ProviderError::TokenRejected | ProviderError::TokenValidation) => {
                self.invalidate_avatar_sync();
                let _ = self.inner.avatar_store.remove_for_user(&session.user);
                let credentials = {
                    let mut state = self.lock_state();
                    state.credentials.session = None;
                    state.runtime_tokens = None;
                    state.credentials.clone()
                };
                if let Err(error) = self.write_credentials(credentials).await {
                    tauri_plugin_log::log::warn!(
                        "Rejected account session could not be physically removed after the provider invalidated it: code={}",
                        error.kind().code()
                    );
                }
                let mut state = self.lock_state();
                state.snapshot.phase = AuthSessionPhase::ReauthenticationRequired;
                state.snapshot.operation = AuthOperation::Idle;
                state.snapshot.has_usable_access_token = false;
                state.snapshot.access_token_expires_at = None;
                Err(self.record_error_locked(
                    &mut state,
                    AuthErrorKind::RefreshRejected,
                    AuthProviderAvailability::Available,
                ))
            }
            Err(error) => {
                let mut state = self.lock_state();
                state.snapshot.phase = AuthSessionPhase::Authenticated;
                state.snapshot.operation = AuthOperation::Idle;
                state.snapshot.user = Some(session.user);
                state.snapshot.has_usable_access_token = false;
                state.snapshot.access_token_expires_at = None;
                Err(self.record_error_locked(
                    &mut state,
                    provider_error_kind(error, true),
                    AuthProviderAvailability::TemporarilyUnavailable,
                ))
            }
        }
    }

    async fn establish_authenticated_session(
        &self,
        mut tokens: ProviderTokenSet,
        authenticated_at: i64,
    ) -> Result<AuthSessionSnapshot, AuthPublicError> {
        let refresh_token = tokens.refresh_token.take().ok_or_else(|| {
            self.record_error(
                AuthErrorKind::TokenValidationFailed,
                AuthProviderAvailability::Available,
            )
        })?;
        let avatar = std::mem::replace(&mut tokens.avatar, ProviderAvatar::Unchanged);
        let mut user = tokens.user.clone();
        self.reconcile_avatar(&mut user, None, &avatar);
        let session = PersistedAuthSession {
            generation_id: Uuid::new_v4().to_string(),
            provider_fingerprint: self.provider_fingerprint(),
            user,
            refresh_token,
            last_authenticated_at: authenticated_at,
            last_refreshed_at: None,
        };
        let new_credentials = StoredAuthState {
            session: Some(session.clone()),
            pending_login: None,
        };
        if let Err(error) = self.write_credentials(new_credentials.clone()).await {
            let _ = self.clear_credentials().await;
            return Err(self.record_error(error.kind(), AuthProviderAvailability::Available));
        }

        let snapshot = {
            let mut state = self.lock_state();
            state.credentials = new_credentials;
            state.runtime_tokens = Some(RuntimeTokens {
                access_token: tokens.access_token,
                access_token_expires_at: tokens.access_token_expires_at,
            });
            apply_authenticated_snapshot(&mut state, &session, AuthProviderAvailability::Available);
            state.snapshot.clone()
        };
        self.publish(snapshot.clone());
        self.schedule_avatar_sync(session.user, avatar);
        Ok(snapshot)
    }

    async fn apply_refreshed_session(
        &self,
        previous: PersistedAuthSession,
        mut tokens: ProviderTokenSet,
    ) -> Result<AuthSessionSnapshot, AuthPublicError> {
        let refreshed_at = now_epoch_seconds();
        let avatar = std::mem::replace(&mut tokens.avatar, ProviderAvatar::Unchanged);
        let mut user = tokens.user.clone();
        self.reconcile_avatar(&mut user, Some(&previous.user), &avatar);
        let session = PersistedAuthSession {
            generation_id: previous.generation_id,
            provider_fingerprint: previous.provider_fingerprint,
            user,
            refresh_token: tokens
                .refresh_token
                .take()
                .unwrap_or(previous.refresh_token),
            last_authenticated_at: previous.last_authenticated_at,
            last_refreshed_at: Some(refreshed_at),
        };
        let pending_login = self.lock_state().credentials.pending_login.clone();
        let new_credentials = StoredAuthState {
            session: Some(session.clone()),
            pending_login,
        };
        if let Err(error) = self.write_credentials(new_credentials.clone()).await {
            let _ = self.clear_credentials().await;
            let mut state = self.lock_state();
            state.credentials.session = None;
            state.runtime_tokens = None;
            state.snapshot.phase = AuthSessionPhase::ReauthenticationRequired;
            state.snapshot.operation = AuthOperation::Idle;
            state.snapshot.has_usable_access_token = false;
            state.snapshot.access_token_expires_at = None;
            return Err(self.record_error_locked(
                &mut state,
                error.kind(),
                AuthProviderAvailability::TemporarilyUnavailable,
            ));
        }

        let snapshot = {
            let mut state = self.lock_state();
            state.credentials = new_credentials;
            state.runtime_tokens = Some(RuntimeTokens {
                access_token: tokens.access_token,
                access_token_expires_at: tokens.access_token_expires_at,
            });
            apply_authenticated_snapshot(&mut state, &session, AuthProviderAvailability::Available);
            state.snapshot.clone()
        };
        self.publish(snapshot.clone());
        self.schedule_avatar_sync(session.user, avatar);
        Ok(snapshot)
    }

    fn reconcile_avatar(
        &self,
        user: &mut AuthUser,
        previous: Option<&AuthUser>,
        avatar: &ProviderAvatar,
    ) {
        let previous_revision = previous
            .filter(|previous| same_user_identity(previous, user))
            .and_then(|previous| previous.avatar_revision.clone());
        match avatar {
            ProviderAvatar::Unchanged => {
                tauri_plugin_log::log::debug!(
                    "Account avatar source was unchanged; retaining the local cache when available"
                );
                user.avatar_revision =
                    previous_revision.or_else(|| self.inner.avatar_store.current_revision(user));
            }
            ProviderAvatar::Absent => {
                tauri_plugin_log::log::info!(
                    "Account profile did not expose a picture claim; using the local initials fallback"
                );
                self.invalidate_avatar_sync();
                user.avatar_revision = None;
                if let Err(error) = self.inner.avatar_store.remove_for_user(user) {
                    tauri_plugin_log::log::debug!(
                        "Unable to remove absent account avatar cache: code={}",
                        error.code()
                    );
                }
            }
            ProviderAvatar::RemoteUrl(_) => {
                tauri_plugin_log::log::info!(
                    "Account profile exposed a picture claim; scheduling secure local avatar refresh"
                );
                user.avatar_revision =
                    previous_revision.or_else(|| self.inner.avatar_store.current_revision(user));
            }
        }
    }

    fn schedule_avatar_sync(&self, user: AuthUser, avatar: ProviderAvatar) {
        let ProviderAvatar::RemoteUrl(source) = avatar else {
            return;
        };
        let generation = self
            .inner
            .avatar_generation
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1);
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            tauri_plugin_log::log::info!("Started optional account avatar refresh");
            let png = match manager
                .inner
                .avatar_store
                .download_and_sanitize(&source)
                .await
            {
                Ok(png) => png,
                Err(error) => {
                    tauri_plugin_log::log::warn!(
                        "Optional account avatar refresh was skipped: code={}",
                        error.code()
                    );
                    return;
                }
            };

            let _operation = manager.inner.operation_lock.lock().await;
            if manager.inner.avatar_generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let current_matches = manager
                .lock_state()
                .credentials
                .session
                .as_ref()
                .is_some_and(|session| same_user_identity(&session.user, &user));
            if !current_matches {
                return;
            }
            let revision = match manager.inner.avatar_store.store(&user, &png) {
                Ok(revision) => revision,
                Err(error) => {
                    tauri_plugin_log::log::warn!(
                        "Optional account avatar cache write was skipped: code={}",
                        error.code()
                    );
                    return;
                }
            };

            let new_credentials = {
                let state = manager.lock_state();
                let mut credentials = state.credentials.clone();
                let Some(session) = credentials.session.as_mut() else {
                    return;
                };
                if !same_user_identity(&session.user, &user) {
                    return;
                }
                if session.user.avatar_revision.as_deref() == Some(revision.as_str()) {
                    tauri_plugin_log::log::info!(
                        "Completed optional account avatar refresh; the local cache revision was already current"
                    );
                    return;
                }
                session.user.avatar_revision = Some(revision);
                credentials
            };
            if let Err(error) = manager.write_credentials(new_credentials.clone()).await {
                tauri_plugin_log::log::warn!(
                    "Unable to persist refreshed account avatar revision: code={}",
                    error
                );
                return;
            }

            let snapshot = {
                let mut state = manager.lock_state();
                state.credentials = new_credentials;
                if state.snapshot.phase == AuthSessionPhase::Authenticated {
                    state.snapshot.user = state
                        .credentials
                        .session
                        .as_ref()
                        .map(|session| session.user.clone());
                }
                state.snapshot.clone()
            };
            manager.publish(snapshot);
            tauri_plugin_log::log::info!(
                "Completed optional account avatar refresh and published the local cache revision"
            );
        });
    }

    fn invalidate_avatar_sync(&self) {
        self.inner.avatar_generation.fetch_add(1, Ordering::SeqCst);
    }

    fn ensure_auth_available(&self) -> Result<(), AuthPublicError> {
        let state = self.lock_state();
        if state.auth_disabled || self.inner.config.is_none() || self.inner.provider.is_none() {
            return Err(state
                .snapshot
                .error
                .clone()
                .unwrap_or_else(|| AuthPublicError::from_kind(AuthErrorKind::ConfigInvalid)));
        }
        Ok(())
    }

    async fn ensure_credentials_loaded(&self) -> Result<(), AuthPublicError> {
        if self.lock_state().credentials_loaded {
            return Ok(());
        }
        match self.load_credentials().await {
            Ok(credentials) => {
                let mut state = self.lock_state();
                state.credentials = credentials;
                state.credentials_loaded = true;
                Ok(())
            }
            Err(error) if error.kind() == AuthErrorKind::SecureStorageCorrupted => {
                if let Err(clear_error) = self.clear_credentials().await {
                    let mut state = self.lock_state();
                    state.credentials_loaded = false;
                    return Err(self.record_error_locked(
                        &mut state,
                        clear_error.kind(),
                        AuthProviderAvailability::Unknown,
                    ));
                }
                let mut state = self.lock_state();
                state.credentials = StoredAuthState::default();
                state.credentials_loaded = true;
                Ok(())
            }
            Err(error) => {
                let mut state = self.lock_state();
                state.credentials_loaded = false;
                Err(self.record_error_locked(
                    &mut state,
                    error.kind(),
                    AuthProviderAvailability::Unknown,
                ))
            }
        }
    }

    async fn load_credentials(&self) -> Result<StoredAuthState, AuthError> {
        let store = self.inner.credential_store.clone();
        tokio::task::spawn_blocking(move || store.load())
            .await
            .map_err(|_| secure_storage_worker_failed())?
    }

    async fn write_credentials(&self, credentials: StoredAuthState) -> Result<(), AuthError> {
        let store = self.inner.credential_store.clone();
        tokio::task::spawn_blocking(move || store.write(&credentials))
            .await
            .map_err(|_| secure_storage_worker_failed())?
    }

    async fn clear_credentials(&self) -> Result<(), AuthError> {
        let store = self.inner.credential_store.clone();
        tokio::task::spawn_blocking(move || store.clear())
            .await
            .map_err(|_| secure_storage_worker_failed())?
    }

    async fn persist_guaranteed_local_logout(&self) -> Result<(), AuthError> {
        self.clear_credentials().await?;
        let verified = self.load_credentials().await?;
        if verified.session.is_none() && verified.pending_login.is_none() {
            return Ok(());
        }
        Err(AuthError::new(
            AuthErrorKind::PersistentLogoutNotGuaranteed,
            "persistent_logout_not_guaranteed",
        ))
    }

    fn set_signing_in(&self, error: Option<AuthPublicError>) {
        let snapshot = {
            let mut state = self.lock_state();
            state.snapshot.operation = AuthOperation::SigningIn;
            state.snapshot.provider_availability = AuthProviderAvailability::Unknown;
            state.snapshot.error = error;
            state.snapshot.clone()
        };
        self.publish(snapshot);
    }

    fn record_provider_error(&self, error: ProviderError, refresh: bool) -> AuthPublicError {
        let availability = if matches!(error, ProviderError::Unavailable) {
            AuthProviderAvailability::TemporarilyUnavailable
        } else {
            AuthProviderAvailability::Available
        };
        self.record_error(provider_error_kind(error, refresh), availability)
    }

    fn record_error(
        &self,
        kind: AuthErrorKind,
        availability: AuthProviderAvailability,
    ) -> AuthPublicError {
        let mut state = self.lock_state();
        self.record_error_locked(&mut state, kind, availability)
    }

    fn record_error_locked(
        &self,
        state: &mut AuthManagerState,
        kind: AuthErrorKind,
        availability: AuthProviderAvailability,
    ) -> AuthPublicError {
        let error = AuthPublicError::from_kind(kind);
        state.snapshot.error = Some(error.clone());
        state.snapshot.provider_availability = availability;
        state.snapshot.operation = AuthOperation::Idle;
        let snapshot = state.snapshot.clone();
        (self.inner.snapshot_sink)(snapshot);
        error
    }

    fn provider(&self) -> Result<Arc<dyn OidcProvider>, AuthPublicError> {
        self.inner
            .provider
            .clone()
            .ok_or_else(|| AuthPublicError::from_kind(AuthErrorKind::ConfigInvalid))
    }

    fn provider_fingerprint(&self) -> String {
        self.inner
            .config
            .as_ref()
            .map(AuthProviderConfig::fingerprint)
            .unwrap_or_default()
    }

    fn issuer(&self) -> Option<&str> {
        self.inner
            .config
            .as_ref()
            .map(|config| config.issuer.as_str())
    }

    fn publish_current(&self) {
        self.publish(self.snapshot());
    }

    fn publish(&self, snapshot: AuthSessionSnapshot) {
        (self.inner.snapshot_sink)(snapshot);
    }

    fn lock_state(&self) -> MutexGuard<'_, AuthManagerState> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn phase_for_session(credentials: &StoredAuthState) -> AuthSessionPhase {
    if credentials.session.is_some() {
        AuthSessionPhase::Authenticated
    } else {
        AuthSessionPhase::Anonymous
    }
}

fn secure_storage_worker_failed() -> AuthError {
    AuthError::new(
        AuthErrorKind::SecureStorageUnavailable,
        "keychain_blocking_worker_failed",
    )
}

fn same_user_identity(left: &AuthUser, right: &AuthUser) -> bool {
    left.provider_id == right.provider_id
        && left.issuer == right.issuer
        && left.subject == right.subject
}

fn apply_authenticated_snapshot(
    state: &mut AuthManagerState,
    session: &PersistedAuthSession,
    availability: AuthProviderAvailability,
) {
    let now = now_epoch_seconds();
    state.snapshot.phase = AuthSessionPhase::Authenticated;
    state.snapshot.operation = AuthOperation::Idle;
    state.snapshot.provider_availability = availability;
    state.snapshot.user = Some(session.user.clone());
    state.snapshot.has_usable_access_token = state.runtime_tokens.as_ref().is_some_and(|tokens| {
        tokens.has_usable_access_token(now, ACCESS_TOKEN_REFRESH_WINDOW_SECONDS)
            && !tokens.access_token.expose().is_empty()
    });
    state.snapshot.access_token_expires_at = state
        .runtime_tokens
        .as_ref()
        .and_then(|tokens| tokens.access_token_expires_at)
        .and_then(epoch_seconds_to_string);
    state.snapshot.last_authenticated_at = epoch_seconds_to_string(session.last_authenticated_at);
    state.snapshot.last_refreshed_at = session.last_refreshed_at.and_then(epoch_seconds_to_string);
    state.snapshot.error = None;
}

fn provider_error_kind(error: ProviderError, refresh: bool) -> AuthErrorKind {
    match error {
        ProviderError::Unavailable => AuthErrorKind::ProviderUnavailable,
        ProviderError::Unsupported | ProviderError::Configuration => {
            AuthErrorKind::ProviderUnsupported
        }
        ProviderError::TokenRejected if refresh => AuthErrorKind::RefreshRejected,
        ProviderError::TokenRejected | ProviderError::TokenExchange => {
            AuthErrorKind::TokenExchangeFailed
        }
        ProviderError::TokenValidation => AuthErrorKind::TokenValidationFailed,
    }
}

fn access_token_error_from_public(error: &AuthPublicError) -> AuthAccessTokenError {
    match error.code.as_str() {
        "AUTH_REFRESH_REJECTED"
        | "AUTH_PROVIDER_CHANGED"
        | "AUTH_REAUTHENTICATION_REQUIRED"
        | "AUTH_TOKEN_VALIDATION_FAILED" => AuthAccessTokenError::ReauthenticationRequired,
        "AUTH_PROVIDER_UNAVAILABLE"
        | "AUTH_SECURE_STORAGE_UNAVAILABLE"
        | "AUTH_SECURE_STORAGE_ACCESS_DENIED" => AuthAccessTokenError::TemporarilyUnavailable,
        _ => AuthAccessTokenError::SystemInternal,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        },
    };

    use tempfile::tempdir;
    use url::Url;

    use super::{
        phase_for_session, AsyncMutex, AuthAccessTokenError, AuthAvatarStore, AuthManager,
        AuthManagerInner, AuthManagerState, AuthOperation, AuthProviderAvailability,
        AuthProviderSummary, AuthSessionPhase, BrowserOpener, Mutex as StateMutex, OidcProvider,
        PendingLogin, PersistedAuthSession, ProviderAvatar, ProviderError, ProviderTokenSet,
        RuntimeTokens, SnapshotSink, StoredAuthState,
    };
    use crate::auth::{
        config::AuthProviderConfig,
        credential_store::{AuthCredentialStore, InMemoryAuthCredentialStore},
        provider::AuthorizationRequest,
        secret::SecretString,
        session::{now_epoch_seconds, AuthSessionSnapshot, AuthUser},
    };

    struct FakeProvider {
        authorization_requests: AtomicUsize,
        exchange_results: Mutex<VecDeque<Result<ProviderTokenSet, ProviderError>>>,
        refresh_results: Mutex<VecDeque<Result<ProviderTokenSet, ProviderError>>>,
        refreshed_with: Mutex<Vec<String>>,
    }

    impl FakeProvider {
        fn new(
            exchange_results: Vec<Result<ProviderTokenSet, ProviderError>>,
            refresh_results: Vec<Result<ProviderTokenSet, ProviderError>>,
        ) -> Self {
            Self {
                authorization_requests: AtomicUsize::new(0),
                exchange_results: Mutex::new(exchange_results.into()),
                refresh_results: Mutex::new(refresh_results.into()),
                refreshed_with: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait::async_trait]
    impl OidcProvider for FakeProvider {
        async fn authorization_request(&self) -> Result<AuthorizationRequest, ProviderError> {
            self.authorization_requests.fetch_add(1, Ordering::SeqCst);
            Ok(AuthorizationRequest {
                url: SecretString::new(
                    "https://issuer.test/authorize?state=expected-state".to_string(),
                ),
                state: SecretString::new("expected-state".to_string()),
                nonce: SecretString::new("expected-nonce".to_string()),
                pkce_verifier: SecretString::new("expected-pkce-verifier".to_string()),
            })
        }

        async fn exchange_code(
            &self,
            _code: &SecretString,
            _pkce_verifier: &SecretString,
            _nonce: &SecretString,
        ) -> Result<ProviderTokenSet, ProviderError> {
            self.exchange_results
                .lock()
                .expect("exchange result lock")
                .pop_front()
                .unwrap_or(Err(ProviderError::TokenExchange))
        }

        async fn refresh(
            &self,
            refresh_token: &SecretString,
            _expected_user: &AuthUser,
        ) -> Result<ProviderTokenSet, ProviderError> {
            self.refreshed_with
                .lock()
                .expect("refresh capture lock")
                .push(refresh_token.expose().to_string());
            self.refresh_results
                .lock()
                .expect("refresh result lock")
                .pop_front()
                .unwrap_or(Err(ProviderError::Unavailable))
        }
    }

    fn user() -> AuthUser {
        AuthUser {
            provider_id: "nexuspilot-account-production-v3".to_string(),
            issuer: "https://auth.nieex.com/oidc".to_string(),
            subject: "subject-1".to_string(),
            display_name: Some("Demo User".to_string()),
            handle: Some("demo".to_string()),
            email: Some("demo@example.test".to_string()),
            email_verified: Some(true),
            avatar_revision: None,
        }
    }

    fn token_set(refresh_token: Option<&str>) -> ProviderTokenSet {
        token_set_with_access("access-token", refresh_token)
    }

    fn token_set_with_access(access_token: &str, refresh_token: Option<&str>) -> ProviderTokenSet {
        ProviderTokenSet {
            access_token: SecretString::new(access_token.to_string()),
            refresh_token: refresh_token.map(|value| SecretString::new(value.to_string())),
            access_token_expires_at: Some(now_epoch_seconds() + 3_600),
            user: user(),
            avatar: ProviderAvatar::Unchanged,
        }
    }

    fn persisted_session(config: &AuthProviderConfig, fingerprint: &str) -> PersistedAuthSession {
        PersistedAuthSession {
            generation_id: "test-generation".to_string(),
            provider_fingerprint: if fingerprint.is_empty() {
                config.fingerprint()
            } else {
                fingerprint.to_string()
            },
            user: user(),
            refresh_token: SecretString::new("refresh-token-1".to_string()),
            last_authenticated_at: now_epoch_seconds() - 300,
            last_refreshed_at: None,
        }
    }

    fn test_manager(
        credential_store: InMemoryAuthCredentialStore,
        provider: Arc<dyn OidcProvider>,
        opened_urls: Arc<Mutex<Vec<String>>>,
    ) -> AuthManager {
        test_manager_with_avatar_store(
            credential_store,
            AuthAvatarStore::unavailable(),
            provider,
            opened_urls,
        )
    }

    fn test_manager_with_avatar_store(
        credential_store: InMemoryAuthCredentialStore,
        avatar_store: AuthAvatarStore,
        provider: Arc<dyn OidcProvider>,
        opened_urls: Arc<Mutex<Vec<String>>>,
    ) -> AuthManager {
        let config = AuthProviderConfig::from_embedded().expect("embedded auth config");
        let summary = AuthProviderSummary {
            id: config.config_id.clone(),
            display_name: config.display_name.clone(),
        };
        let browser_opener: BrowserOpener = Arc::new(move |url| {
            opened_urls
                .lock()
                .expect("opened URL lock")
                .push(url.to_string());
            Ok(())
        });
        let snapshot_sink: SnapshotSink = Arc::new(|_| {});

        AuthManager {
            inner: Arc::new(AuthManagerInner {
                config: Some(config),
                provider: Some(provider),
                credential_store: Arc::new(credential_store),
                avatar_store,
                avatar_generation: super::AtomicU64::new(0),
                state: StateMutex::new(AuthManagerState {
                    credentials: StoredAuthState::default(),
                    runtime_tokens: None::<RuntimeTokens>,
                    snapshot: AuthSessionSnapshot::restoring(Some(summary)),
                    credentials_loaded: false,
                    auth_disabled: false,
                }),
                operation_lock: AsyncMutex::new(()),
                snapshot_sink,
                browser_opener,
            }),
        }
    }

    #[test]
    fn anonymous_is_the_normal_phase_without_a_persisted_session() {
        assert_eq!(
            phase_for_session(&StoredAuthState::default()),
            AuthSessionPhase::Anonymous
        );
    }

    #[tokio::test]
    async fn repeated_sign_in_reuses_pending_transaction_and_cancel_clears_it() {
        let fake = Arc::new(FakeProvider::new(Vec::new(), Vec::new()));
        let opened_urls = Arc::new(Mutex::new(Vec::new()));
        let manager = test_manager(
            InMemoryAuthCredentialStore::new(),
            fake.clone(),
            opened_urls.clone(),
        );
        manager.restore_session().await;

        let first = manager.start_sign_in().await.expect("first sign in");
        let second = manager.start_sign_in().await.expect("reused sign in");

        assert_eq!(first.operation, AuthOperation::SigningIn);
        assert_eq!(second.operation, AuthOperation::SigningIn);
        assert_eq!(fake.authorization_requests.load(Ordering::SeqCst), 1);
        assert_eq!(opened_urls.lock().expect("opened URLs").len(), 2);
        assert!(manager.lock_state().credentials.pending_login.is_some());

        let canceled = manager.cancel_sign_in().await.expect("cancel sign in");
        assert_eq!(canceled.phase, AuthSessionPhase::Anonymous);
        assert_eq!(canceled.operation, AuthOperation::Idle);
        assert!(manager.lock_state().credentials.pending_login.is_none());
    }

    #[tokio::test]
    async fn unavailable_keychain_blocks_sign_in_before_opening_the_browser() {
        let fake = Arc::new(FakeProvider::new(Vec::new(), Vec::new()));
        let opened_urls = Arc::new(Mutex::new(Vec::new()));
        let manager = test_manager(
            InMemoryAuthCredentialStore::unavailable(),
            fake.clone(),
            opened_urls.clone(),
        );

        manager.restore_session().await;
        let error = manager
            .start_sign_in()
            .await
            .expect_err("secure storage must be available before sign in");

        assert_eq!(error.code, "AUTH_SECURE_STORAGE_UNAVAILABLE");
        assert_eq!(fake.authorization_requests.load(Ordering::SeqCst), 0);
        assert!(opened_urls.lock().expect("opened URLs").is_empty());
    }

    #[tokio::test]
    async fn corrupted_keychain_is_cleared_and_allows_explicit_reauthentication() {
        let fake = Arc::new(FakeProvider::new(Vec::new(), Vec::new()));
        let opened_urls = Arc::new(Mutex::new(Vec::new()));
        let keychain = InMemoryAuthCredentialStore::corrupted();
        let manager = test_manager(keychain.clone(), fake, opened_urls.clone());

        manager.restore_session().await;
        assert_eq!(
            manager.snapshot().phase,
            AuthSessionPhase::ReauthenticationRequired
        );
        assert_eq!(
            manager.snapshot().error.expect("corruption error").code,
            "AUTH_SECURE_STORAGE_CORRUPTED"
        );
        assert!(keychain.load().expect("cleared keychain").session.is_none());

        let signing_in = manager
            .start_sign_in()
            .await
            .expect("explicit sign in should recover after corrupted credentials are cleared");
        assert_eq!(signing_in.operation, AuthOperation::SigningIn);
        assert_eq!(opened_urls.lock().expect("opened URLs").len(), 1);
    }

    #[tokio::test]
    async fn state_mismatch_does_not_consume_pending_login() {
        let fake = Arc::new(FakeProvider::new(
            vec![Ok(token_set(Some("refresh-token-1")))],
            Vec::new(),
        ));
        let manager = test_manager(
            InMemoryAuthCredentialStore::new(),
            fake,
            Arc::new(Mutex::new(Vec::new())),
        );
        manager.restore_session().await;
        manager.start_sign_in().await.expect("start sign in");

        let invalid = manager
            .handle_callback(
                Url::parse("dev.nexuspilot://auth/callback?code=code&state=wrong-state")
                    .expect("invalid callback URL"),
            )
            .await
            .expect_err("state mismatch must fail");
        assert_eq!(invalid.code, "AUTH_CALLBACK_INVALID");
        assert!(manager.lock_state().credentials.pending_login.is_some());

        let authenticated = manager
            .handle_callback(
                Url::parse("dev.nexuspilot://auth/callback?code=code&state=expected-state")
                    .expect("valid callback URL"),
            )
            .await
            .expect("matching callback should authenticate");
        assert_eq!(authenticated.phase, AuthSessionPhase::Authenticated);
        assert!(authenticated.has_usable_access_token);
        assert!(manager.lock_state().credentials.pending_login.is_none());
    }

    #[tokio::test]
    async fn refresh_rotation_replaces_persisted_refresh_token() {
        let fake = Arc::new(FakeProvider::new(
            vec![Ok(token_set(Some("refresh-token-1")))],
            vec![Ok(token_set(Some("refresh-token-2")))],
        ));
        let keychain = InMemoryAuthCredentialStore::new();
        let manager = test_manager(
            keychain.clone(),
            fake.clone(),
            Arc::new(Mutex::new(Vec::new())),
        );
        manager.restore_session().await;
        manager.start_sign_in().await.expect("start sign in");
        manager
            .handle_callback(
                Url::parse("dev.nexuspilot://auth/callback?code=code&state=expected-state")
                    .expect("callback URL"),
            )
            .await
            .expect("establish session");

        let refreshed = manager.retry_session().await.expect("refresh session");
        assert_eq!(refreshed.phase, AuthSessionPhase::Authenticated);
        assert_eq!(
            fake.refreshed_with
                .lock()
                .expect("refreshed token")
                .as_slice(),
            ["refresh-token-1"]
        );
        assert_eq!(
            keychain
                .load()
                .expect("load rotated keychain")
                .session
                .expect("persisted session")
                .refresh_token
                .expose(),
            "refresh-token-2"
        );
    }

    #[tokio::test]
    async fn usable_access_token_reuses_current_memory_token_without_refresh() {
        let config = AuthProviderConfig::from_embedded().expect("embedded auth config");
        let fake = Arc::new(FakeProvider::new(Vec::new(), Vec::new()));
        let manager = test_manager(
            InMemoryAuthCredentialStore::new(),
            fake.clone(),
            Arc::new(Mutex::new(Vec::new())),
        );
        {
            let mut state = manager.lock_state();
            state.credentials = StoredAuthState {
                session: Some(persisted_session(&config, "")),
                pending_login: None,
            };
            state.credentials_loaded = true;
            state.runtime_tokens = Some(RuntimeTokens {
                access_token: SecretString::new("current-access-token".to_string()),
                access_token_expires_at: Some(now_epoch_seconds() + 3_600),
            });
        }

        let token = manager
            .usable_access_token()
            .await
            .expect("current token should be usable");

        assert_eq!(token.expose(), "current-access-token");
        assert!(fake
            .refreshed_with
            .lock()
            .expect("refresh capture")
            .is_empty());
    }

    #[tokio::test]
    async fn concurrent_access_token_requests_share_one_refresh_rotation() {
        let config = AuthProviderConfig::from_embedded().expect("embedded auth config");
        let fake = Arc::new(FakeProvider::new(
            Vec::new(),
            vec![Ok(token_set_with_access(
                "refreshed-access-token",
                Some("refresh-token-2"),
            ))],
        ));
        let keychain = InMemoryAuthCredentialStore::new();
        let session = persisted_session(&config, "");
        keychain
            .write(&StoredAuthState {
                session: Some(session.clone()),
                pending_login: None,
            })
            .expect("write persisted session");
        let manager = test_manager(
            keychain.clone(),
            fake.clone(),
            Arc::new(Mutex::new(Vec::new())),
        );
        {
            let mut state = manager.lock_state();
            state.credentials = StoredAuthState {
                session: Some(session),
                pending_login: None,
            };
            state.credentials_loaded = true;
            state.runtime_tokens = Some(RuntimeTokens {
                access_token: SecretString::new("expiring-access-token".to_string()),
                access_token_expires_at: Some(now_epoch_seconds() + 30),
            });
        }

        let results = futures_util::future::join_all((0..8).map(|_| {
            let manager = manager.clone();
            async move { manager.usable_access_token().await }
        }))
        .await;

        for result in results {
            assert_eq!(
                result
                    .expect("all callers should receive refreshed token")
                    .expose(),
                "refreshed-access-token"
            );
        }
        assert_eq!(
            fake.refreshed_with
                .lock()
                .expect("refresh capture")
                .as_slice(),
            ["refresh-token-1"]
        );
        assert_eq!(
            keychain
                .load()
                .expect("load rotated keychain")
                .session
                .expect("persisted session")
                .refresh_token
                .expose(),
            "refresh-token-2"
        );
    }

    #[tokio::test]
    async fn cloud_access_before_background_restore_does_not_rotate_twice() {
        let config = AuthProviderConfig::from_embedded().expect("embedded auth config");
        let keychain = InMemoryAuthCredentialStore::new();
        keychain
            .write(&StoredAuthState {
                session: Some(persisted_session(&config, "")),
                pending_login: None,
            })
            .expect("write persisted session");
        let fake = Arc::new(FakeProvider::new(
            Vec::new(),
            vec![Ok(token_set_with_access(
                "refreshed-access-token",
                Some("refresh-token-2"),
            ))],
        ));
        let manager = test_manager(keychain, fake.clone(), Arc::new(Mutex::new(Vec::new())));

        let token = manager
            .usable_access_token()
            .await
            .expect("Cloud request should restore the session");
        manager.restore_session().await;

        assert_eq!(token.expose(), "refreshed-access-token");
        assert_eq!(
            fake.refreshed_with
                .lock()
                .expect("refresh capture")
                .as_slice(),
            ["refresh-token-1"]
        );
        assert!(manager.snapshot().has_usable_access_token);
    }

    #[tokio::test]
    async fn access_token_is_unavailable_after_local_sign_out() {
        let config = AuthProviderConfig::from_embedded().expect("embedded auth config");
        let keychain = InMemoryAuthCredentialStore::new();
        let session = persisted_session(&config, "");
        keychain
            .write(&StoredAuthState {
                session: Some(session.clone()),
                pending_login: None,
            })
            .expect("write persisted session");
        let manager = test_manager(
            keychain,
            Arc::new(FakeProvider::new(Vec::new(), Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
        );
        {
            let mut state = manager.lock_state();
            state.credentials = StoredAuthState {
                session: Some(session),
                pending_login: None,
            };
            state.credentials_loaded = true;
            state.runtime_tokens = Some(RuntimeTokens {
                access_token: SecretString::new("access-token".to_string()),
                access_token_expires_at: Some(now_epoch_seconds() + 3_600),
            });
        }

        manager.sign_out().await.expect("local sign out");
        let error = match manager.usable_access_token().await {
            Ok(_) => panic!("signed-out manager must not lend a token"),
            Err(error) => error,
        };

        assert_eq!(error, AuthAccessTokenError::Unauthenticated);
    }

    #[tokio::test]
    async fn refresh_rotation_storage_failure_requires_reauthentication() {
        let fake = Arc::new(FakeProvider::new(
            vec![Ok(token_set(Some("refresh-token-1")))],
            vec![Ok(token_set(Some("refresh-token-2")))],
        ));
        let keychain = InMemoryAuthCredentialStore::new();
        let manager = test_manager(keychain.clone(), fake, Arc::new(Mutex::new(Vec::new())));
        manager.restore_session().await;
        manager.start_sign_in().await.expect("start sign in");
        manager
            .handle_callback(
                Url::parse("dev.nexuspilot://auth/callback?code=code&state=expected-state")
                    .expect("callback URL"),
            )
            .await
            .expect("establish session");
        keychain.fail_on_write(4);

        let error = manager
            .retry_session()
            .await
            .expect_err("rotated token must not remain memory-only");

        assert_eq!(error.code, "AUTH_SECURE_STORAGE_UNAVAILABLE");
        assert_eq!(
            manager.snapshot().phase,
            AuthSessionPhase::ReauthenticationRequired
        );
        assert!(!manager.snapshot().has_usable_access_token);
        assert!(keychain.load().expect("cleared keychain").session.is_none());
    }

    #[tokio::test]
    async fn rejected_refresh_requires_reauthentication_and_clears_session() {
        let config = AuthProviderConfig::from_embedded().expect("embedded auth config");
        let keychain = InMemoryAuthCredentialStore::new();
        keychain
            .write(&StoredAuthState {
                session: Some(persisted_session(&config, "")),
                pending_login: None::<PendingLogin>,
            })
            .expect("write persisted session");
        let fake = Arc::new(FakeProvider::new(
            Vec::new(),
            vec![Err(ProviderError::TokenRejected)],
        ));
        let manager = test_manager(keychain.clone(), fake, Arc::new(Mutex::new(Vec::new())));

        manager.restore_session().await;

        let snapshot = manager.snapshot();
        assert_eq!(snapshot.phase, AuthSessionPhase::ReauthenticationRequired);
        assert_eq!(
            snapshot.provider_availability,
            AuthProviderAvailability::Available
        );
        assert_eq!(
            snapshot.error.expect("refresh error").code,
            "AUTH_REFRESH_REJECTED"
        );
        assert!(keychain.load().expect("cleared keychain").session.is_none());
    }

    #[tokio::test]
    async fn temporary_refresh_failure_preserves_local_identity() {
        let config = AuthProviderConfig::from_embedded().expect("embedded auth config");
        let keychain = InMemoryAuthCredentialStore::new();
        keychain
            .write(&StoredAuthState {
                session: Some(persisted_session(&config, "")),
                pending_login: None,
            })
            .expect("write persisted session");
        let manager = test_manager(
            keychain.clone(),
            Arc::new(FakeProvider::new(
                Vec::new(),
                vec![Err(ProviderError::Unavailable)],
            )),
            Arc::new(Mutex::new(Vec::new())),
        );

        manager.restore_session().await;

        let snapshot = manager.snapshot();
        assert_eq!(snapshot.phase, AuthSessionPhase::Authenticated);
        assert!(snapshot.user.is_some());
        assert!(!snapshot.has_usable_access_token);
        assert_eq!(
            snapshot.provider_availability,
            AuthProviderAvailability::TemporarilyUnavailable
        );
        assert!(keychain
            .load()
            .expect("preserved keychain")
            .session
            .is_some());
    }

    #[tokio::test]
    async fn provider_fingerprint_change_fails_closed_without_refresh() {
        let config = AuthProviderConfig::from_embedded().expect("embedded auth config");
        let keychain = InMemoryAuthCredentialStore::new();
        keychain
            .write(&StoredAuthState {
                session: Some(persisted_session(&config, "old-provider-fingerprint")),
                pending_login: None,
            })
            .expect("write old provider session");
        let fake = Arc::new(FakeProvider::new(Vec::new(), Vec::new()));
        let manager = test_manager(
            keychain.clone(),
            fake.clone(),
            Arc::new(Mutex::new(Vec::new())),
        );

        manager.restore_session().await;

        let snapshot = manager.snapshot();
        assert_eq!(snapshot.phase, AuthSessionPhase::ReauthenticationRequired);
        assert_eq!(
            snapshot.error.expect("provider change error").code,
            "AUTH_PROVIDER_CHANGED"
        );
        assert!(fake
            .refreshed_with
            .lock()
            .expect("refresh capture")
            .is_empty());
        assert!(keychain
            .load()
            .expect("cleared changed session")
            .session
            .is_none());
    }

    #[tokio::test]
    async fn sign_out_clears_keychain_session_and_local_state() {
        let config = AuthProviderConfig::from_embedded().expect("embedded auth config");
        let keychain = InMemoryAuthCredentialStore::new();
        keychain
            .write(&StoredAuthState {
                session: Some(persisted_session(&config, "")),
                pending_login: None,
            })
            .expect("write persisted session");
        let manager = test_manager(
            keychain.clone(),
            Arc::new(FakeProvider::new(Vec::new(), Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
        );
        manager.restore_session().await;

        let signed_out = manager.sign_out().await.expect("local sign out");

        assert_eq!(signed_out.phase, AuthSessionPhase::Anonymous);
        assert!(signed_out.user.is_none());
        assert!(keychain
            .load()
            .expect("empty keychain after sign out")
            .session
            .is_none());
    }

    #[tokio::test]
    async fn rejected_avatar_source_does_not_change_authenticated_session() {
        let root = tempdir().expect("temporary directory");
        let keychain = InMemoryAuthCredentialStore::new();
        let avatar_store = AuthAvatarStore::new(root.path());
        let mut tokens = token_set(Some("refresh-token-1"));
        tokens.avatar =
            ProviderAvatar::RemoteUrl("https://127.0.0.1/private-avatar.png".to_string());
        let manager = test_manager_with_avatar_store(
            keychain.clone(),
            avatar_store,
            Arc::new(FakeProvider::new(vec![Ok(tokens)], Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
        );
        manager.restore_session().await;
        manager.start_sign_in().await.expect("start sign in");

        let authenticated = manager
            .handle_callback(
                Url::parse("dev.nexuspilot://auth/callback?code=code&state=expected-state")
                    .expect("callback URL"),
            )
            .await
            .expect("establish session");
        tokio::task::yield_now().await;

        assert_eq!(authenticated.phase, AuthSessionPhase::Authenticated);
        assert!(authenticated
            .user
            .expect("authenticated user")
            .avatar_revision
            .is_none());
        assert_eq!(manager.snapshot().phase, AuthSessionPhase::Authenticated);
        assert!(keychain
            .load()
            .expect("persisted keychain")
            .session
            .is_some());
    }

    #[tokio::test]
    async fn local_sign_out_clears_avatar_without_provider_network_or_browser() {
        let root = tempdir().expect("temporary directory");
        let config = AuthProviderConfig::from_embedded().expect("embedded auth config");
        let keychain = InMemoryAuthCredentialStore::new();
        let avatar_store = AuthAvatarStore::new(root.path());
        let mut persisted = persisted_session(&config, "");
        let png = b"\x89PNG\r\n\x1a\nlocal-avatar";
        let revision = avatar_store
            .store(&persisted.user, png)
            .expect("store avatar");
        persisted.user.avatar_revision = Some(revision.clone());
        keychain
            .write(&StoredAuthState {
                session: Some(persisted),
                pending_login: None,
            })
            .expect("write persisted session");
        let provider = Arc::new(FakeProvider::new(
            Vec::new(),
            vec![Err(ProviderError::Unavailable)],
        ));
        let opened_urls = Arc::new(Mutex::new(Vec::new()));
        let manager = test_manager_with_avatar_store(
            keychain,
            avatar_store.clone(),
            provider.clone(),
            opened_urls.clone(),
        );
        manager.restore_session().await;

        assert_eq!(manager.avatar_bytes(&revision), png);
        let signed_out = manager.sign_out().await.expect("local sign out");

        assert_eq!(signed_out.phase, AuthSessionPhase::Anonymous);
        assert!(manager.avatar_bytes(&revision).is_empty());
        assert!(avatar_store.load(&user(), &revision).is_none());
        assert!(opened_urls.lock().expect("opened URL lock").is_empty());
    }
}
