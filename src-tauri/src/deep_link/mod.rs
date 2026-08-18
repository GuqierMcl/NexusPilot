pub(crate) mod router;

use tauri::{App, Manager, Runtime};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

pub use router::{
    DesktopDeepLinkDispatchOutcome, DesktopDeepLinkRegistrationStatus, DesktopDeepLinkRoute,
    DesktopDeepLinkRouter, DesktopDeepLinkSource,
};

pub const APP_DEEP_LINK_SCHEME: &str = "dev.nexuspilot";

pub fn setup<R: Runtime>(app: &mut App<R>, router: DesktopDeepLinkRouter) {
    configure_platform_registration(app, &router);
    tauri_plugin_log::log::info!(
        "Desktop deep-link registration state initialized: status={:?}",
        router.registration_status()
    );

    let launch_urls = match app.deep_link().get_current() {
        Ok(urls) => urls,
        Err(error) => {
            tauri_plugin_log::log::warn!(
                "Unable to read launch deep links; local workbench will continue: {error}"
            );
            None
        }
    };

    let runtime_router = router.clone();
    app.deep_link().on_open_url(move |event| {
        receive_open_urls(
            &runtime_router,
            event.urls(),
            DesktopDeepLinkSource::Runtime,
        );
    });

    if !app.manage(router.clone()) {
        tauri_plugin_log::log::error!(
            "Desktop deep-link router state was already managed; authentication links are unavailable"
        );
        router.set_registration_status(DesktopDeepLinkRegistrationStatus::Unavailable);
    }

    if let Some(urls) = launch_urls {
        receive_open_urls(&router, urls, DesktopDeepLinkSource::Launch);
    }
}

pub fn uses_configured_scheme(value: &str) -> bool {
    Url::parse(value)
        .map(|url| url.scheme() == APP_DEEP_LINK_SCHEME)
        .unwrap_or_else(|_| {
            value
                .get(..APP_DEEP_LINK_SCHEME.len())
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(APP_DEEP_LINK_SCHEME))
                && value
                    .get(APP_DEEP_LINK_SCHEME.len()..)
                    .is_some_and(|suffix| suffix.starts_with(':'))
        })
}

fn receive_open_urls(
    router: &DesktopDeepLinkRouter,
    urls: Vec<Url>,
    source: DesktopDeepLinkSource,
) {
    for url in urls {
        match router.dispatch(url, source) {
            DesktopDeepLinkDispatchOutcome::Delivered { route_id } => {
                tauri_plugin_log::log::info!(
                    "Delivered desktop deep link: source={}, route={route_id}",
                    source.as_str()
                );
            }
            DesktopDeepLinkDispatchOutcome::Queued {
                route_id,
                dropped_oldest,
            } => {
                tauri_plugin_log::log::info!(
                    "Queued desktop deep link until its Rust handler is ready: source={}, route={}, droppedOldest={}",
                    source.as_str(),
                    route_id,
                    dropped_oldest
                );
            }
            DesktopDeepLinkDispatchOutcome::Rejected { reason } => {
                tauri_plugin_log::log::warn!(
                    "Rejected desktop deep link: source={}, reason={}",
                    source.as_str(),
                    reason.code()
                );
            }
            DesktopDeepLinkDispatchOutcome::HandlerRejected {
                route_id,
                error_code,
            } => {
                tauri_plugin_log::log::warn!(
                    "Desktop deep-link handler rejected request: source={}, route={}, code={}",
                    source.as_str(),
                    route_id,
                    error_code
                );
            }
        }
    }
}

#[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
fn configure_platform_registration<R: Runtime>(app: &App<R>, router: &DesktopDeepLinkRouter) {
    if let Err(error) = app.deep_link().register_all() {
        router.set_registration_status(DesktopDeepLinkRegistrationStatus::Unavailable);
        tauri_plugin_log::log::warn!(
            "Unable to register desktop deep-link scheme; local workbench will continue: {error}"
        );
        return;
    }

    match app.deep_link().is_registered(APP_DEEP_LINK_SCHEME) {
        Ok(true) => {
            router.set_registration_status(DesktopDeepLinkRegistrationStatus::Registered);
        }
        Ok(false) => {
            router.set_registration_status(DesktopDeepLinkRegistrationStatus::Unavailable);
            tauri_plugin_log::log::warn!(
                "Desktop deep-link scheme is not registered; local workbench will continue"
            );
        }
        Err(error) => {
            router.set_registration_status(DesktopDeepLinkRegistrationStatus::Unavailable);
            tauri_plugin_log::log::warn!(
                "Unable to verify desktop deep-link registration; local workbench will continue: {error}"
            );
        }
    }
}

#[cfg(all(windows, not(debug_assertions)))]
fn configure_platform_registration<R: Runtime>(app: &App<R>, router: &DesktopDeepLinkRouter) {
    match app.deep_link().is_registered(APP_DEEP_LINK_SCHEME) {
        Ok(true) => {
            router.set_registration_status(DesktopDeepLinkRegistrationStatus::Registered);
        }
        Ok(false) => {
            router.set_registration_status(DesktopDeepLinkRegistrationStatus::Unavailable);
            tauri_plugin_log::log::warn!(
                "Installed desktop deep-link scheme is unavailable; local workbench will continue"
            );
        }
        Err(error) => {
            router.set_registration_status(DesktopDeepLinkRegistrationStatus::Unavailable);
            tauri_plugin_log::log::warn!(
                "Unable to verify installed deep-link scheme; local workbench will continue: {error}"
            );
        }
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
fn configure_platform_registration<R: Runtime>(_app: &App<R>, router: &DesktopDeepLinkRouter) {
    router.set_registration_status(DesktopDeepLinkRegistrationStatus::BundleManaged);
}

#[cfg(test)]
mod tests {
    use super::uses_configured_scheme;

    #[test]
    fn detects_configured_scheme_without_accepting_lookalikes() {
        assert!(uses_configured_scheme(
            "dev.nexuspilot://auth/callback?code=secret"
        ));
        assert!(uses_configured_scheme(
            "DEV.NEXUSPILOT://auth/callback?code=secret"
        ));
        assert!(!uses_configured_scheme(
            "dev.nexuspilot.attacker://auth/callback"
        ));
        assert!(!uses_configured_scheme("--from-shortcut"));
    }
}
