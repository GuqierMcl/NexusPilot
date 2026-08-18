mod avatar;
mod callback;
mod config;
mod credential_store;
mod error;
mod manager;
mod provider;
mod secret;
mod session;

use std::sync::Arc;

use tauri::{App, Emitter, Manager, Runtime};

use crate::deep_link::{
    router::{DesktopDeepLinkHandler, DesktopDeepLinkHandlerError, DesktopDeepLinkRequest},
    DesktopDeepLinkRoute, DesktopDeepLinkRouter, APP_DEEP_LINK_SCHEME,
};

pub use error::AuthPublicError;
pub use manager::AuthManager;
pub use session::AuthSessionSnapshot;

pub(crate) use manager::AuthAccessTokenError;
pub(crate) use secret::SecretString;

use avatar::AuthAvatarStore;
use config::AuthProviderConfig;
use credential_store::SystemAuthCredentialStore;
use error::{AuthError, AuthErrorKind};

pub const AUTH_SESSION_CHANGED_EVENT: &str = "auth-session-changed";

pub const AUTH_CALLBACK_ROUTE: DesktopDeepLinkRoute =
    DesktopDeepLinkRoute::new("auth.callback", "auth", "/callback");
pub const AUTH_SIGNED_OUT_ROUTE: DesktopDeepLinkRoute =
    DesktopDeepLinkRoute::new("auth.signed-out", "auth", "/signed-out");

struct AuthDeepLinkHandler {
    manager: AuthManager,
}

impl DesktopDeepLinkHandler for AuthDeepLinkHandler {
    fn handle(&self, request: DesktopDeepLinkRequest) -> Result<(), DesktopDeepLinkHandlerError> {
        tauri_plugin_log::log::debug!(
            "Dispatching authentication deep link: route={}, source={:?}",
            request.route().id(),
            request.source()
        );
        if request.url().scheme() != APP_DEEP_LINK_SCHEME {
            return Err(DesktopDeepLinkHandlerError::new("auth_scheme_mismatch"));
        }
        match request.route() {
            AUTH_CALLBACK_ROUTE => self
                .manager
                .handle_callback_in_background(request.url().clone()),
            AUTH_SIGNED_OUT_ROUTE => self.manager.handle_signed_out_callback(),
            _ => return Err(DesktopDeepLinkHandlerError::new("auth_route_mismatch")),
        }
        Ok(())
    }
}

pub fn setup<R: Runtime>(app: &mut App<R>, router: &DesktopDeepLinkRouter) {
    let mut routes_available = true;
    for route in [AUTH_CALLBACK_ROUTE, AUTH_SIGNED_OUT_ROUTE] {
        if let Err(error) = router.register_route(route) {
            routes_available = false;
            tauri_plugin_log::log::error!(
                "Unable to register authentication deep-link route; local workbench will continue: route={}, error={}",
                route.id(),
                error
            );
        }
    }

    let config = AuthProviderConfig::from_embedded().map_err(|error| {
        tauri_plugin_log::log::error!(
            "Embedded auth provider config is unavailable; local workbench will continue: code={}",
            error.code()
        );
        AuthError::new(AuthErrorKind::ConfigInvalid, error.code())
    });
    if let Ok(config) = &config {
        tauri_plugin_log::log::info!(
            "Loaded embedded auth provider config: configId={}, fingerprint={}",
            config.config_id,
            config.fingerprint()
        );
    }

    let manager_config = config.and_then(|config| {
        if !routes_available {
            return Err(AuthError::new(
                AuthErrorKind::SystemInternal,
                "auth_deep_link_routes_unavailable",
            ));
        }
        Ok(config)
    });
    let credential_store = Arc::new(SystemAuthCredentialStore::new());
    let app_data_dir = app.path().app_data_dir().ok();
    let avatar_store = app_data_dir
        .as_deref()
        .map(AuthAvatarStore::new)
        .unwrap_or_else(AuthAvatarStore::unavailable);
    let app_handle = app.handle().clone();
    let snapshot_sink = Arc::new(move |snapshot: AuthSessionSnapshot| {
        if let Err(error) = app_handle.emit(AUTH_SESSION_CHANGED_EVENT, snapshot) {
            tauri_plugin_log::log::warn!(
                "Unable to publish authentication session snapshot: {error}"
            );
        }
    });
    let manager = AuthManager::new(
        manager_config,
        credential_store,
        avatar_store,
        snapshot_sink,
    );
    let handler = Arc::new(AuthDeepLinkHandler {
        manager: manager.clone(),
    });

    for route in [AUTH_CALLBACK_ROUTE, AUTH_SIGNED_OUT_ROUTE] {
        if let Err(error) = router.attach_handler(route, handler.clone()) {
            tauri_plugin_log::log::error!(
                "Unable to attach authentication deep-link handler; local workbench will continue: route={}, error={}",
                route.id(),
                error
            );
        }
    }

    if !app.manage(manager.clone()) {
        tauri_plugin_log::log::error!(
            "Authentication manager state was already managed; account login is unavailable"
        );
        return;
    }
    manager.restore_in_background();
}

#[cfg(test)]
mod tests {
    use crate::deep_link::{
        DesktopDeepLinkDispatchOutcome, DesktopDeepLinkRouter, DesktopDeepLinkSource,
        APP_DEEP_LINK_SCHEME,
    };
    use url::Url;

    use super::{AUTH_CALLBACK_ROUTE, AUTH_SIGNED_OUT_ROUTE};

    #[test]
    fn authentication_routes_are_explicit_and_non_overlapping() {
        let router = DesktopDeepLinkRouter::new(APP_DEEP_LINK_SCHEME);
        router
            .register_route(AUTH_CALLBACK_ROUTE)
            .expect("callback route should register");
        router
            .register_route(AUTH_SIGNED_OUT_ROUTE)
            .expect("signed-out route should register");

        let callback = router.dispatch(
            Url::parse("dev.nexuspilot://auth/callback?code=code&state=state")
                .expect("callback should parse"),
            DesktopDeepLinkSource::Runtime,
        );
        let signed_out = router.dispatch(
            Url::parse("dev.nexuspilot://auth/signed-out").expect("signed-out should parse"),
            DesktopDeepLinkSource::Runtime,
        );

        assert!(matches!(
            callback,
            DesktopDeepLinkDispatchOutcome::Queued {
                route_id: "auth.callback",
                ..
            }
        ));
        assert!(matches!(
            signed_out,
            DesktopDeepLinkDispatchOutcome::Queued {
                route_id: "auth.signed-out",
                ..
            }
        ));
    }
}
