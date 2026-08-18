use std::{
    collections::VecDeque,
    error::Error,
    fmt::{Display, Formatter},
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc, Mutex, MutexGuard,
    },
};

use url::Url;

const DEFAULT_PENDING_CAPACITY_PER_ROUTE: usize = 8;
const MAX_DEEP_LINK_LENGTH: usize = 8 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DesktopDeepLinkRoute {
    id: &'static str,
    host: &'static str,
    path: &'static str,
}

impl DesktopDeepLinkRoute {
    pub const fn new(id: &'static str, host: &'static str, path: &'static str) -> Self {
        Self { id, host, path }
    }

    pub fn id(self) -> &'static str {
        self.id
    }

    fn is_valid(self) -> bool {
        !self.id.is_empty()
            && !self.host.is_empty()
            && self.host.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
            })
            && self.path.starts_with('/')
            && !self.path.contains('?')
            && !self.path.contains('#')
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DesktopDeepLinkSource {
    Launch,
    Runtime,
}

impl DesktopDeepLinkSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Launch => "launch",
            Self::Runtime => "runtime",
        }
    }
}

pub struct DesktopDeepLinkRequest {
    route: DesktopDeepLinkRoute,
    source: DesktopDeepLinkSource,
    url: Url,
}

impl DesktopDeepLinkRequest {
    pub fn route(&self) -> DesktopDeepLinkRoute {
        self.route
    }

    pub fn source(&self) -> DesktopDeepLinkSource {
        self.source
    }

    pub fn url(&self) -> &Url {
        &self.url
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DesktopDeepLinkHandlerError {
    code: &'static str,
}

impl DesktopDeepLinkHandlerError {
    pub const fn new(code: &'static str) -> Self {
        Self { code }
    }

    pub fn code(self) -> &'static str {
        self.code
    }
}

pub trait DesktopDeepLinkHandler: Send + Sync + 'static {
    fn handle(&self, request: DesktopDeepLinkRequest) -> Result<(), DesktopDeepLinkHandlerError>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DesktopDeepLinkRegistrationStatus {
    BundleManaged,
    Registered,
    Unavailable,
}

impl DesktopDeepLinkRegistrationStatus {
    fn as_u8(self) -> u8 {
        match self {
            Self::BundleManaged => 0,
            Self::Registered => 1,
            Self::Unavailable => 2,
        }
    }

    fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Registered,
            2 => Self::Unavailable,
            _ => Self::BundleManaged,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DesktopDeepLinkRejectionReason {
    TooLong,
    UnexpectedScheme,
    MissingHost,
    CredentialsNotAllowed,
    PortNotAllowed,
    FragmentNotAllowed,
    UnknownRoute,
}

impl DesktopDeepLinkRejectionReason {
    pub fn code(self) -> &'static str {
        match self {
            Self::TooLong => "too_long",
            Self::UnexpectedScheme => "unexpected_scheme",
            Self::MissingHost => "missing_host",
            Self::CredentialsNotAllowed => "credentials_not_allowed",
            Self::PortNotAllowed => "port_not_allowed",
            Self::FragmentNotAllowed => "fragment_not_allowed",
            Self::UnknownRoute => "unknown_route",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DesktopDeepLinkDispatchOutcome {
    Delivered {
        route_id: &'static str,
    },
    Queued {
        route_id: &'static str,
        dropped_oldest: bool,
    },
    Rejected {
        reason: DesktopDeepLinkRejectionReason,
    },
    HandlerRejected {
        route_id: &'static str,
        error_code: &'static str,
    },
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DesktopDeepLinkAttachReport {
    pub delivered: usize,
    pub rejected: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DesktopDeepLinkRouterError {
    InvalidRoute,
    DuplicateRoute,
    UnknownRoute,
    HandlerAlreadyAttached,
}

impl Display for DesktopDeepLinkRouterError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::InvalidRoute => "deep-link route definition is invalid",
            Self::DuplicateRoute => "deep-link route is already registered",
            Self::UnknownRoute => "deep-link route is not registered",
            Self::HandlerAlreadyAttached => "deep-link route already has a handler",
        };
        formatter.write_str(message)
    }
}

impl Error for DesktopDeepLinkRouterError {}

struct RouteEntry {
    route: DesktopDeepLinkRoute,
    handler: Option<Arc<dyn DesktopDeepLinkHandler>>,
    draining_pending: bool,
    pending: VecDeque<DesktopDeepLinkRequest>,
}

struct RouterInner {
    scheme: &'static str,
    pending_capacity_per_route: usize,
    routes: Mutex<Vec<RouteEntry>>,
    registration_status: AtomicU8,
}

#[derive(Clone)]
pub struct DesktopDeepLinkRouter {
    inner: Arc<RouterInner>,
}

impl DesktopDeepLinkRouter {
    pub fn new(scheme: &'static str) -> Self {
        Self::with_pending_capacity(scheme, DEFAULT_PENDING_CAPACITY_PER_ROUTE)
    }

    fn with_pending_capacity(scheme: &'static str, pending_capacity_per_route: usize) -> Self {
        Self {
            inner: Arc::new(RouterInner {
                scheme,
                pending_capacity_per_route: pending_capacity_per_route.max(1),
                routes: Mutex::new(Vec::new()),
                registration_status: AtomicU8::new(
                    DesktopDeepLinkRegistrationStatus::BundleManaged.as_u8(),
                ),
            }),
        }
    }

    pub fn register_route(
        &self,
        route: DesktopDeepLinkRoute,
    ) -> Result<(), DesktopDeepLinkRouterError> {
        if !route.is_valid() {
            return Err(DesktopDeepLinkRouterError::InvalidRoute);
        }

        let mut routes = self.lock_routes();
        if routes.iter().any(|entry| {
            entry.route.id == route.id
                || (entry.route.host == route.host && entry.route.path == route.path)
        }) {
            return Err(DesktopDeepLinkRouterError::DuplicateRoute);
        }

        routes.push(RouteEntry {
            route,
            handler: None,
            draining_pending: false,
            pending: VecDeque::new(),
        });
        Ok(())
    }

    pub fn attach_handler(
        &self,
        route: DesktopDeepLinkRoute,
        handler: Arc<dyn DesktopDeepLinkHandler>,
    ) -> Result<DesktopDeepLinkAttachReport, DesktopDeepLinkRouterError> {
        {
            let mut routes = self.lock_routes();
            let Some(entry) = routes.iter_mut().find(|entry| entry.route == route) else {
                return Err(DesktopDeepLinkRouterError::UnknownRoute);
            };
            if entry.handler.is_some() {
                return Err(DesktopDeepLinkRouterError::HandlerAlreadyAttached);
            }

            entry.handler = Some(handler.clone());
            entry.draining_pending = true;
        }

        let mut report = DesktopDeepLinkAttachReport::default();
        loop {
            let pending = {
                let mut routes = self.lock_routes();
                let entry = routes
                    .iter_mut()
                    .find(|entry| entry.route == route)
                    .expect("attached route must remain registered");
                if entry.pending.is_empty() {
                    entry.draining_pending = false;
                    break;
                }
                std::mem::take(&mut entry.pending)
            };

            for request in pending {
                match handler.handle(request) {
                    Ok(()) => report.delivered += 1,
                    Err(_) => report.rejected += 1,
                }
            }
        }
        Ok(report)
    }

    pub fn dispatch(
        &self,
        url: Url,
        source: DesktopDeepLinkSource,
    ) -> DesktopDeepLinkDispatchOutcome {
        if let Some(reason) = self.validate_structure(&url) {
            return DesktopDeepLinkDispatchOutcome::Rejected { reason };
        }

        let host = url.host_str().expect("validated URL must have a host");
        let path = url.path();

        let (route, handler, dropped_oldest) = {
            let mut routes = self.lock_routes();
            let Some(entry) = routes
                .iter_mut()
                .find(|entry| entry.route.host == host && entry.route.path == path)
            else {
                return DesktopDeepLinkDispatchOutcome::Rejected {
                    reason: DesktopDeepLinkRejectionReason::UnknownRoute,
                };
            };

            let route = entry.route;
            let ready_handler = if entry.draining_pending {
                None
            } else {
                entry.handler.clone()
            };
            if let Some(handler) = ready_handler {
                (route, Some(handler), false)
            } else {
                let dropped_oldest = entry.pending.len() >= self.inner.pending_capacity_per_route;
                if dropped_oldest {
                    entry.pending.pop_front();
                }
                entry.pending.push_back(DesktopDeepLinkRequest {
                    route,
                    source,
                    url: url.clone(),
                });
                (route, None, dropped_oldest)
            }
        };

        let Some(handler) = handler else {
            return DesktopDeepLinkDispatchOutcome::Queued {
                route_id: route.id,
                dropped_oldest,
            };
        };

        match handler.handle(DesktopDeepLinkRequest { route, source, url }) {
            Ok(()) => DesktopDeepLinkDispatchOutcome::Delivered { route_id: route.id },
            Err(error) => DesktopDeepLinkDispatchOutcome::HandlerRejected {
                route_id: route.id,
                error_code: error.code(),
            },
        }
    }

    pub fn set_registration_status(&self, status: DesktopDeepLinkRegistrationStatus) {
        self.inner
            .registration_status
            .store(status.as_u8(), Ordering::Release);
    }

    pub fn registration_status(&self) -> DesktopDeepLinkRegistrationStatus {
        DesktopDeepLinkRegistrationStatus::from_u8(
            self.inner.registration_status.load(Ordering::Acquire),
        )
    }

    fn validate_structure(&self, url: &Url) -> Option<DesktopDeepLinkRejectionReason> {
        if url.as_str().len() > MAX_DEEP_LINK_LENGTH {
            return Some(DesktopDeepLinkRejectionReason::TooLong);
        }
        if url.scheme() != self.inner.scheme {
            return Some(DesktopDeepLinkRejectionReason::UnexpectedScheme);
        }
        if url.host_str().is_none() {
            return Some(DesktopDeepLinkRejectionReason::MissingHost);
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Some(DesktopDeepLinkRejectionReason::CredentialsNotAllowed);
        }
        if url.port().is_some() {
            return Some(DesktopDeepLinkRejectionReason::PortNotAllowed);
        }
        if url.fragment().is_some() {
            return Some(DesktopDeepLinkRejectionReason::FragmentNotAllowed);
        }
        None
    }

    fn lock_routes(&self) -> MutexGuard<'_, Vec<RouteEntry>> {
        self.inner
            .routes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{mpsc, Arc, Mutex},
        thread,
    };

    use super::{
        DesktopDeepLinkDispatchOutcome, DesktopDeepLinkHandler, DesktopDeepLinkHandlerError,
        DesktopDeepLinkRegistrationStatus, DesktopDeepLinkRequest, DesktopDeepLinkRoute,
        DesktopDeepLinkRouter, DesktopDeepLinkRouterError, DesktopDeepLinkSource,
    };
    use url::Url;

    const AUTH_CALLBACK: DesktopDeepLinkRoute =
        DesktopDeepLinkRoute::new("auth.callback", "auth", "/callback");

    #[derive(Default)]
    struct RecordingHandler {
        urls: Mutex<Vec<String>>,
    }

    impl DesktopDeepLinkHandler for RecordingHandler {
        fn handle(
            &self,
            request: DesktopDeepLinkRequest,
        ) -> Result<(), DesktopDeepLinkHandlerError> {
            self.urls
                .lock()
                .expect("recording handler lock should not be poisoned")
                .push(request.url().as_str().to_string());
            Ok(())
        }
    }

    struct BlockingFirstHandler {
        urls: Mutex<Vec<String>>,
        first_started: mpsc::Sender<()>,
        release_first: Mutex<mpsc::Receiver<()>>,
    }

    impl DesktopDeepLinkHandler for BlockingFirstHandler {
        fn handle(
            &self,
            request: DesktopDeepLinkRequest,
        ) -> Result<(), DesktopDeepLinkHandlerError> {
            let is_first = {
                let mut urls = self.urls.lock().expect("blocking handler lock");
                urls.push(request.url().as_str().to_string());
                urls.len() == 1
            };
            if is_first {
                self.first_started
                    .send(())
                    .expect("test should observe first delivery");
                self.release_first
                    .lock()
                    .expect("release lock")
                    .recv()
                    .expect("test should release first delivery");
            }
            Ok(())
        }
    }

    fn parse(value: &str) -> Url {
        Url::parse(value).expect("test deep link should parse")
    }

    #[test]
    fn queues_cold_start_until_handler_is_attached() {
        let router = DesktopDeepLinkRouter::new("dev.nexuspilot");
        router
            .register_route(AUTH_CALLBACK)
            .expect("route should register");

        let outcome = router.dispatch(
            parse("dev.nexuspilot://auth/callback?code=code&state=state"),
            DesktopDeepLinkSource::Launch,
        );
        assert_eq!(
            outcome,
            DesktopDeepLinkDispatchOutcome::Queued {
                route_id: "auth.callback",
                dropped_oldest: false
            }
        );

        let handler = Arc::new(RecordingHandler::default());
        let report = router
            .attach_handler(AUTH_CALLBACK, handler.clone())
            .expect("handler should attach");
        assert_eq!(report.delivered, 1);
        assert_eq!(report.rejected, 0);
        assert_eq!(handler.urls.lock().expect("handler lock").len(), 1);
    }

    #[test]
    fn dispatches_runtime_url_to_attached_handler() {
        let router = DesktopDeepLinkRouter::new("dev.nexuspilot");
        router
            .register_route(AUTH_CALLBACK)
            .expect("route should register");
        let handler = Arc::new(RecordingHandler::default());
        router
            .attach_handler(AUTH_CALLBACK, handler.clone())
            .expect("handler should attach");

        let outcome = router.dispatch(
            parse("dev.nexuspilot://auth/callback?code=code&state=state"),
            DesktopDeepLinkSource::Runtime,
        );

        assert_eq!(
            outcome,
            DesktopDeepLinkDispatchOutcome::Delivered {
                route_id: "auth.callback"
            }
        );
        assert_eq!(handler.urls.lock().expect("handler lock").len(), 1);
    }

    #[test]
    fn preserves_order_when_urls_arrive_during_handler_attachment() {
        let router = DesktopDeepLinkRouter::new("dev.nexuspilot");
        router
            .register_route(AUTH_CALLBACK)
            .expect("route should register");
        router.dispatch(
            parse("dev.nexuspilot://auth/callback?code=first&state=state"),
            DesktopDeepLinkSource::Launch,
        );

        let (first_started_tx, first_started_rx) = mpsc::channel();
        let (release_first_tx, release_first_rx) = mpsc::channel();
        let handler = Arc::new(BlockingFirstHandler {
            urls: Mutex::new(Vec::new()),
            first_started: first_started_tx,
            release_first: Mutex::new(release_first_rx),
        });
        let attach_router = router.clone();
        let attach_handler = handler.clone();
        let attach_thread = thread::spawn(move || {
            attach_router
                .attach_handler(AUTH_CALLBACK, attach_handler)
                .expect("handler should attach")
        });

        first_started_rx
            .recv()
            .expect("first queued request should begin delivery");
        assert_eq!(
            router.dispatch(
                parse("dev.nexuspilot://auth/callback?code=second&state=state"),
                DesktopDeepLinkSource::Runtime,
            ),
            DesktopDeepLinkDispatchOutcome::Queued {
                route_id: "auth.callback",
                dropped_oldest: false
            }
        );
        release_first_tx
            .send(())
            .expect("first delivery should be released");

        let report = attach_thread.join().expect("attach thread should finish");
        assert_eq!(report.delivered, 2);
        let urls = handler.urls.lock().expect("handler lock");
        assert!(urls[0].contains("code=first"));
        assert!(urls[1].contains("code=second"));
    }

    #[test]
    fn bounds_pending_urls_per_route() {
        let router = DesktopDeepLinkRouter::with_pending_capacity("dev.nexuspilot", 2);
        router
            .register_route(AUTH_CALLBACK)
            .expect("route should register");

        for index in 0..3 {
            let outcome = router.dispatch(
                parse(&format!(
                    "dev.nexuspilot://auth/callback?code={index}&state=state"
                )),
                DesktopDeepLinkSource::Launch,
            );
            assert_eq!(
                outcome,
                DesktopDeepLinkDispatchOutcome::Queued {
                    route_id: "auth.callback",
                    dropped_oldest: index == 2
                }
            );
        }

        let handler = Arc::new(RecordingHandler::default());
        let report = router
            .attach_handler(AUTH_CALLBACK, handler.clone())
            .expect("handler should attach");
        assert_eq!(report.delivered, 2);
        let urls = handler.urls.lock().expect("handler lock");
        assert!(urls[0].contains("code=1"));
        assert!(urls[1].contains("code=2"));
    }

    #[test]
    fn rejects_unknown_or_structurally_invalid_routes() {
        let router = DesktopDeepLinkRouter::new("dev.nexuspilot");
        router
            .register_route(AUTH_CALLBACK)
            .expect("route should register");

        let rejected = [
            "other://auth/callback?code=code",
            "dev.nexuspilot://other/callback?code=code",
            "dev.nexuspilot://auth/callback/extra?code=code",
            "dev.nexuspilot://auth:1234/callback?code=code",
            "dev.nexuspilot://user@auth/callback?code=code",
            "dev.nexuspilot://auth/callback?code=code#fragment",
        ];

        for value in rejected {
            assert!(matches!(
                router.dispatch(parse(value), DesktopDeepLinkSource::Runtime),
                DesktopDeepLinkDispatchOutcome::Rejected { .. }
            ));
        }
    }

    #[test]
    fn rejects_duplicate_routes_and_handlers() {
        let router = DesktopDeepLinkRouter::new("dev.nexuspilot");
        router
            .register_route(AUTH_CALLBACK)
            .expect("route should register");
        assert_eq!(
            router.register_route(AUTH_CALLBACK),
            Err(DesktopDeepLinkRouterError::DuplicateRoute)
        );

        let handler = Arc::new(RecordingHandler::default());
        router
            .attach_handler(AUTH_CALLBACK, handler.clone())
            .expect("handler should attach");
        assert_eq!(
            router.attach_handler(AUTH_CALLBACK, handler),
            Err(DesktopDeepLinkRouterError::HandlerAlreadyAttached)
        );
    }

    #[test]
    fn registration_status_is_observable_without_affecting_routing() {
        let router = DesktopDeepLinkRouter::new("dev.nexuspilot");
        assert_eq!(
            router.registration_status(),
            DesktopDeepLinkRegistrationStatus::BundleManaged
        );
        router.set_registration_status(DesktopDeepLinkRegistrationStatus::Unavailable);
        assert_eq!(
            router.registration_status(),
            DesktopDeepLinkRegistrationStatus::Unavailable
        );
    }
}
