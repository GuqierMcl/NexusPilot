use std::sync::{
    atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    Arc, Mutex,
};

use async_trait::async_trait;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::Mutex as AsyncMutex;

use super::{
    desktop_state::CloudDesktopStateStore,
    sync_coordinator::{self, CloudSyncAccess, CloudSyncExecution, SyncRunGuard},
    CloudAccountService, CloudErrorCode, CloudPublicError, CloudSyncRunResult,
};
use crate::{
    auth::AuthManager, db::DatabaseState, repository::cloud_sync_repository::CloudSyncRepository,
};

pub const CLOUD_SYNC_RUNTIME_CHANGED_EVENT: &str = "cloud-sync-runtime-changed";

const LOCAL_CHANGE_DEBOUNCE_MS: u64 = 750;
const FOREGROUND_DEBOUNCE_MS: u64 = 50;
const RETRY_DELAYS_SECONDS: [u64; 4] = [5, 15, 60, 300];

#[derive(Clone, Copy)]
struct SchedulerDelays {
    local_change_ms: u64,
    foreground_ms: u64,
    retry_seconds: [u64; 4],
}

impl Default for SchedulerDelays {
    fn default() -> Self {
        Self {
            local_change_ms: LOCAL_CHANGE_DEBOUNCE_MS,
            foreground_ms: FOREGROUND_DEBOUNCE_MS,
            retry_seconds: RETRY_DELAYS_SECONDS,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CloudSyncRuntimePhase {
    Disabled,
    Idle,
    Syncing,
    Paused,
    Offline,
    ReadOnly,
    QuotaExceeded,
    Conflicted,
    DeviceRevoked,
    RecoveryRequired,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CloudSyncTrigger {
    Startup,
    Authentication,
    Foreground,
    LocalChange,
    Retry,
    Manual,
    Resume,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncRuntimeProjection {
    pub phase: CloudSyncRuntimePhase,
    pub trigger: Option<CloudSyncTrigger>,
    pub last_started_at: Option<String>,
    pub last_completed_at: Option<String>,
    pub last_succeeded_at: Option<String>,
    pub next_retry_at: Option<String>,
    pub retry_attempt: u32,
    pub pending_operations: u64,
    pub conflicts: u64,
    pub last_result: Option<CloudSyncRunResult>,
    pub last_error_code: Option<CloudErrorCode>,
}

impl Default for CloudSyncRuntimeProjection {
    fn default() -> Self {
        Self {
            phase: CloudSyncRuntimePhase::Disabled,
            trigger: None,
            last_started_at: None,
            last_completed_at: None,
            last_succeeded_at: None,
            next_retry_at: None,
            retry_attempt: 0,
            pending_operations: 0,
            conflicts: 0,
            last_result: None,
            last_error_code: None,
        }
    }
}

#[derive(Clone)]
pub(crate) struct CloudSyncScheduler {
    inner: Arc<CloudSyncSchedulerInner>,
}

struct CloudSyncSchedulerInner {
    executor: Arc<dyn CloudSyncExecutor>,
    identity_binding: Mutex<Option<String>>,
    generation: Arc<AtomicU64>,
    schedule_version: AtomicU64,
    retry_attempt: AtomicU32,
    in_background: AtomicBool,
    run_lock: AsyncMutex<()>,
    event_sink: Arc<dyn Fn(CloudSyncRuntimeProjection) + Send + Sync>,
    delays: SchedulerDelays,
    desktop_state: CloudDesktopStateStore,
}

#[async_trait]
trait CloudSyncExecutor: Send + Sync {
    fn identity_binding(&self) -> Option<String>;

    async fn run(&self, guard: SyncRunGuard) -> Result<CloudSyncExecution, CloudPublicError>;

    async fn counts(&self, account_id: &str) -> (u64, u64);
}

struct AppCloudSyncExecutor<R: Runtime> {
    app: AppHandle<R>,
}

#[async_trait]
impl<R: Runtime> CloudSyncExecutor for AppCloudSyncExecutor<R> {
    fn identity_binding(&self) -> Option<String> {
        let auth = self.app.try_state::<AuthManager>()?;
        let snapshot = auth.snapshot();
        super::identity_binding(&snapshot).ok()
    }

    async fn run(&self, guard: SyncRunGuard) -> Result<CloudSyncExecution, CloudPublicError> {
        let service = self
            .app
            .try_state::<CloudAccountService>()
            .ok_or_else(|| CloudPublicError::from_code(CloudErrorCode::ProtocolError))?;
        let database = self
            .app
            .try_state::<DatabaseState>()
            .ok_or_else(|| CloudPublicError::from_code(CloudErrorCode::ProtocolError))?;
        sync_coordinator::run_execution(service.inner(), &database.pool, guard).await
    }

    async fn counts(&self, account_id: &str) -> (u64, u64) {
        let Some(database) = self.app.try_state::<DatabaseState>() else {
            return (0, 0);
        };
        let pending_operations =
            CloudSyncRepository::list_pending_operations(&database.pool, account_id)
                .await
                .map(|items| items.len() as u64)
                .unwrap_or(0);
        let conflicts = CloudSyncRepository::list_pending_conflicts(&database.pool, account_id)
            .await
            .map(|items| items.len() as u64)
            .unwrap_or(0);
        (pending_operations, conflicts)
    }
}

impl CloudSyncScheduler {
    pub(crate) fn new<R: Runtime>(
        app: &AppHandle<R>,
        desktop_state: CloudDesktopStateStore,
    ) -> Self {
        let app_handle = app.clone();
        let executor = Arc::new(AppCloudSyncExecutor {
            app: app_handle.clone(),
        });
        let event_sink = Arc::new(move |projection: CloudSyncRuntimeProjection| {
            if let Err(error) = app_handle.emit(CLOUD_SYNC_RUNTIME_CHANGED_EVENT, projection) {
                tauri_plugin_log::log::debug!(
                    "Unable to publish Cloud sync runtime projection: {error}"
                );
            }
        });
        Self {
            inner: Arc::new(CloudSyncSchedulerInner {
                executor,
                identity_binding: Mutex::new(None),
                generation: Arc::new(AtomicU64::new(0)),
                schedule_version: AtomicU64::new(0),
                retry_attempt: AtomicU32::new(0),
                in_background: AtomicBool::new(false),
                run_lock: AsyncMutex::new(()),
                event_sink,
                delays: SchedulerDelays::default(),
                desktop_state,
            }),
        }
    }

    #[cfg(test)]
    fn for_test(executor: Arc<dyn CloudSyncExecutor>, delays: SchedulerDelays) -> Self {
        Self {
            inner: Arc::new(CloudSyncSchedulerInner {
                executor,
                identity_binding: Mutex::new(Some("identity-a".to_string())),
                generation: Arc::new(AtomicU64::new(1)),
                schedule_version: AtomicU64::new(0),
                retry_attempt: AtomicU32::new(0),
                in_background: AtomicBool::new(false),
                run_lock: AsyncMutex::new(()),
                event_sink: Arc::new(|_| {}),
                delays,
                desktop_state: CloudDesktopStateStore::default(),
            }),
        }
    }

    pub(crate) fn start(&self) {
        self.handle_auth_session_event(true);
        if self.inner.executor.identity_binding().is_some() {
            self.schedule(CloudSyncTrigger::Startup, 0);
        }
    }

    pub(crate) fn status(&self) -> CloudSyncRuntimeProjection {
        self.inner.desktop_state.snapshot().runtime
    }

    pub(crate) fn handle_auth_session_event(&self, authenticated: bool) {
        let current = authenticated
            .then(|| self.inner.executor.identity_binding())
            .flatten();
        let changed = {
            let mut identity = self
                .inner
                .identity_binding
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if *identity == current {
                false
            } else {
                *identity = current.clone();
                true
            }
        };

        if changed {
            self.cancel_scheduled_runs();
            self.inner.generation.fetch_add(1, Ordering::SeqCst);
            self.inner.retry_attempt.store(0, Ordering::SeqCst);
            self.update_projection(|projection| {
                *projection = CloudSyncRuntimeProjection::default();
                projection.phase = if current.is_some() {
                    CloudSyncRuntimePhase::Idle
                } else {
                    CloudSyncRuntimePhase::Disabled
                };
            });
        }
        if current.is_some() {
            self.schedule(CloudSyncTrigger::Authentication, 0);
        }
    }

    pub(crate) fn on_window_focus_changed(&self, focused: bool) {
        if !focused {
            self.inner.in_background.store(true, Ordering::SeqCst);
            return;
        }
        if self.inner.in_background.swap(false, Ordering::SeqCst) {
            self.schedule(
                CloudSyncTrigger::Foreground,
                self.inner.delays.foreground_ms,
            );
        }
    }

    pub(crate) fn on_local_change(&self) {
        self.schedule(
            CloudSyncTrigger::LocalChange,
            self.inner.delays.local_change_ms,
        );
    }

    pub(crate) fn set_paused(&self, paused: bool) {
        if paused {
            self.cancel_scheduled_runs();
            self.inner.generation.fetch_add(1, Ordering::SeqCst);
            self.update_projection(|projection| {
                projection.phase = CloudSyncRuntimePhase::Paused;
                projection.trigger = None;
                projection.next_retry_at = None;
            });
        } else {
            self.schedule(CloudSyncTrigger::Resume, 0);
        }
    }

    pub(crate) fn mark_device_revoked(&self) {
        self.cancel_scheduled_runs();
        self.inner.generation.fetch_add(1, Ordering::SeqCst);
        self.update_projection(|projection| {
            projection.phase = CloudSyncRuntimePhase::DeviceRevoked;
            projection.next_retry_at = None;
        });
    }

    pub(crate) fn shutdown(&self) {
        self.cancel_scheduled_runs();
        self.inner.generation.fetch_add(1, Ordering::SeqCst);
        self.update_projection(|projection| {
            projection.phase = CloudSyncRuntimePhase::Disabled;
            projection.trigger = None;
            projection.next_retry_at = None;
        });
    }

    pub(crate) async fn run_now(&self) -> Result<CloudSyncRunResult, CloudPublicError> {
        self.cancel_scheduled_runs();
        let generation = self.inner.generation.load(Ordering::SeqCst);
        self.execute(CloudSyncTrigger::Manual, generation, None, true)
            .await
    }

    fn schedule(&self, trigger: CloudSyncTrigger, delay_ms: u64) {
        if self.inner.executor.identity_binding().is_none() {
            return;
        }
        let version = self.inner.schedule_version.fetch_add(1, Ordering::SeqCst) + 1;
        let generation = self.inner.generation.load(Ordering::SeqCst);
        let scheduler = self.clone();
        // Scheduler callbacks can be triggered by synchronous Tauri setup and
        // event-handler code, where there is no Tokio runtime entered on the
        // current thread.  Always use Tauri's global runtime entry point so
        // scheduling is safe from both those callbacks and async callers.
        tauri::async_runtime::spawn(async move {
            if delay_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            }
            if scheduler.inner.schedule_version.load(Ordering::SeqCst) != version
                || scheduler.inner.generation.load(Ordering::SeqCst) != generation
            {
                return;
            }
            let _ = scheduler
                .execute(trigger, generation, Some(version), false)
                .await;
        });
    }

    fn cancel_scheduled_runs(&self) {
        self.inner.schedule_version.fetch_add(1, Ordering::SeqCst);
    }

    async fn execute(
        &self,
        trigger: CloudSyncTrigger,
        generation: u64,
        version: Option<u64>,
        manual: bool,
    ) -> Result<CloudSyncRunResult, CloudPublicError> {
        let _run_guard = self.inner.run_lock.lock().await;
        if self.inner.generation.load(Ordering::SeqCst) != generation
            || version
                .is_some_and(|value| self.inner.schedule_version.load(Ordering::SeqCst) != value)
        {
            return Err(CloudPublicError::from_code(CloudErrorCode::Unauthenticated));
        }
        let Some(identity) = self
            .inner
            .identity_binding
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
        else {
            self.update_projection(|projection| projection.phase = CloudSyncRuntimePhase::Disabled);
            return Err(CloudPublicError::from_code(CloudErrorCode::Unauthenticated));
        };

        let started_at = now_string();
        self.update_projection(|projection| {
            projection.phase = CloudSyncRuntimePhase::Syncing;
            projection.trigger = Some(trigger);
            projection.last_started_at = Some(started_at);
            projection.next_retry_at = None;
            projection.last_error_code = None;
        });

        let generation_ref = self.inner.generation.clone();
        let executor = self.inner.executor.clone();
        let expected_identity = identity.clone();
        let guard: SyncRunGuard = Arc::new(move || {
            generation_ref.load(Ordering::SeqCst) == generation
                && executor.identity_binding().as_deref() == Some(expected_identity.as_str())
        });
        let outcome = self.inner.executor.run(guard).await;

        if self.inner.generation.load(Ordering::SeqCst) != generation
            || self.inner.executor.identity_binding().as_deref() != Some(identity.as_str())
        {
            return Err(CloudPublicError::from_code(CloudErrorCode::Unauthenticated));
        }

        match outcome {
            Ok(execution) => {
                let (pending_operations, conflicts) =
                    self.inner.executor.counts(&execution.account_id).await;
                let completed_at = now_string();
                let phase = if conflicts > 0 || execution.result.conflicted > 0 {
                    CloudSyncRuntimePhase::Conflicted
                } else {
                    match execution.access {
                        CloudSyncAccess::Disabled => CloudSyncRuntimePhase::Disabled,
                        CloudSyncAccess::RecoveryRequired => {
                            CloudSyncRuntimePhase::RecoveryRequired
                        }
                        CloudSyncAccess::Paused => CloudSyncRuntimePhase::Paused,
                        CloudSyncAccess::ReadOnly => CloudSyncRuntimePhase::ReadOnly,
                        CloudSyncAccess::ReadWrite => CloudSyncRuntimePhase::Idle,
                        CloudSyncAccess::QuotaExceeded => CloudSyncRuntimePhase::QuotaExceeded,
                    }
                };
                self.inner.retry_attempt.store(0, Ordering::SeqCst);
                self.update_projection(|projection| {
                    projection.phase = phase;
                    projection.trigger = Some(trigger);
                    projection.last_completed_at = Some(completed_at.clone());
                    projection.last_succeeded_at = Some(completed_at);
                    projection.retry_attempt = 0;
                    projection.pending_operations = pending_operations;
                    projection.conflicts = conflicts;
                    projection.last_result = Some(execution.result);
                    projection.last_error_code = None;
                });
                if manual {
                    match execution.access {
                        CloudSyncAccess::Disabled => Err(CloudPublicError::from_code(
                            CloudErrorCode::SyncNotInitialized,
                        )),
                        CloudSyncAccess::RecoveryRequired => Err(CloudPublicError::from_code(
                            CloudErrorCode::SyncDeviceNotAuthorized,
                        )),
                        _ => Ok(execution.result),
                    }
                } else {
                    Ok(execution.result)
                }
            }
            Err(error) => {
                let attempt = self.inner.retry_attempt.fetch_add(1, Ordering::SeqCst) + 1;
                let phase = phase_for_error(error.code);
                let retry_at = if error.retryable {
                    let seconds =
                        retry_delay_seconds_with(self.inner.delays.retry_seconds, attempt);
                    Some(now_after_seconds(seconds))
                } else {
                    None
                };
                let completed_at = now_string();
                self.update_projection(|projection| {
                    projection.phase = phase;
                    projection.trigger = Some(trigger);
                    projection.last_completed_at = Some(completed_at);
                    projection.next_retry_at = retry_at.clone();
                    projection.retry_attempt = attempt;
                    projection.last_error_code = Some(error.code);
                });
                if error.retryable {
                    self.schedule(
                        CloudSyncTrigger::Retry,
                        retry_delay_seconds_with(self.inner.delays.retry_seconds, attempt) * 1_000,
                    );
                }
                if manual {
                    Err(error)
                } else {
                    Ok(CloudSyncRunResult {
                        uploaded: 0,
                        deleted: 0,
                        pulled: 0,
                        conflicted: 0,
                        ignored: 0,
                        cursor: self.status().last_result.map(|r| r.cursor).unwrap_or(0),
                    })
                }
            }
        }
    }

    fn update_projection(&self, update: impl FnOnce(&mut CloudSyncRuntimeProjection)) {
        let projection = self.inner.desktop_state.update_runtime(update);
        (self.inner.event_sink)(projection.clone());
    }
}

fn phase_for_error(code: CloudErrorCode) -> CloudSyncRuntimePhase {
    match code {
        CloudErrorCode::ConnectionSyncQuotaExceeded => CloudSyncRuntimePhase::QuotaExceeded,
        CloudErrorCode::ConnectionSyncConflict => CloudSyncRuntimePhase::Conflicted,
        CloudErrorCode::SyncDeviceNotAuthorized => CloudSyncRuntimePhase::DeviceRevoked,
        CloudErrorCode::SyncNotInitialized | CloudErrorCode::ConnectionSyncNotEntitled => {
            CloudSyncRuntimePhase::Disabled
        }
        CloudErrorCode::ConnectionSyncRestricted => CloudSyncRuntimePhase::ReadOnly,
        CloudErrorCode::SecureStorageUnavailable | CloudErrorCode::RecoveryKeyInvalid => {
            CloudSyncRuntimePhase::RecoveryRequired
        }
        _ if code == CloudErrorCode::TemporarilyUnavailable
            || code == CloudErrorCode::AuthTemporarilyUnavailable =>
        {
            CloudSyncRuntimePhase::Offline
        }
        _ => CloudSyncRuntimePhase::Unavailable,
    }
}

#[cfg(test)]
fn retry_delay_seconds(attempt: u32) -> u64 {
    retry_delay_seconds_with(RETRY_DELAYS_SECONDS, attempt)
}

fn retry_delay_seconds_with(delays: [u64; 4], attempt: u32) -> u64 {
    delays
        .get(attempt.saturating_sub(1) as usize)
        .copied()
        .unwrap_or(*delays.last().unwrap_or(&300))
}

fn now_string() -> String {
    let value = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        value.year(),
        u8::from(value.month()),
        value.day(),
        value.hour(),
        value.minute(),
        value.second()
    )
}

fn now_after_seconds(seconds: u64) -> String {
    let value = time::OffsetDateTime::now_utc() + time::Duration::seconds(seconds as i64);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        value.year(),
        u8::from(value.month()),
        value.day(),
        value.hour(),
        value.minute(),
        value.second()
    )
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    };

    use async_trait::async_trait;

    use super::{
        phase_for_error, retry_delay_seconds, CloudSyncAccess, CloudSyncExecution,
        CloudSyncExecutor, CloudSyncRuntimePhase, CloudSyncScheduler, SchedulerDelays,
        SyncRunGuard,
    };
    use crate::cloud::{CloudErrorCode, CloudPublicError, CloudSyncRunResult};

    struct FakeExecutor {
        identity: Mutex<Option<String>>,
        calls: AtomicU64,
        outcomes: Mutex<Vec<Result<CloudSyncExecution, CloudPublicError>>>,
    }

    impl FakeExecutor {
        fn new(outcomes: Vec<Result<CloudSyncExecution, CloudPublicError>>) -> Arc<Self> {
            Arc::new(Self {
                identity: Mutex::new(Some("identity-a".to_string())),
                calls: AtomicU64::new(0),
                outcomes: Mutex::new(outcomes),
            })
        }

        fn set_identity(&self, identity: Option<&str>) {
            *self.identity.lock().expect("identity lock") = identity.map(str::to_string);
        }
    }

    #[async_trait]
    impl CloudSyncExecutor for FakeExecutor {
        fn identity_binding(&self) -> Option<String> {
            self.identity.lock().expect("identity lock").clone()
        }

        async fn run(&self, guard: SyncRunGuard) -> Result<CloudSyncExecution, CloudPublicError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if !guard() {
                return Err(CloudPublicError::from_code(CloudErrorCode::Unauthenticated));
            }
            self.outcomes
                .lock()
                .expect("outcomes lock")
                .pop()
                .unwrap_or_else(|| Ok(execution()))
        }

        async fn counts(&self, _account_id: &str) -> (u64, u64) {
            (0, 0)
        }
    }

    fn execution() -> CloudSyncExecution {
        CloudSyncExecution {
            result: CloudSyncRunResult {
                uploaded: 1,
                deleted: 0,
                pulled: 1,
                conflicted: 0,
                ignored: 0,
                cursor: 1,
            },
            account_id: "account-a".to_string(),
            access: CloudSyncAccess::ReadWrite,
        }
    }

    fn fast_delays() -> SchedulerDelays {
        SchedulerDelays {
            local_change_ms: 5,
            foreground_ms: 1,
            retry_seconds: [0, 0, 0, 0],
        }
    }

    #[test]
    fn retry_delays_are_bounded_and_exponential() {
        assert_eq!(retry_delay_seconds(1), 5);
        assert_eq!(retry_delay_seconds(2), 15);
        assert_eq!(retry_delay_seconds(3), 60);
        assert_eq!(retry_delay_seconds(4), 300);
        assert_eq!(retry_delay_seconds(99), 300);
    }

    #[test]
    fn runtime_phase_mapping_keeps_user_actionable_states() {
        assert_eq!(
            phase_for_error(CloudErrorCode::TemporarilyUnavailable),
            CloudSyncRuntimePhase::Offline
        );
        assert_eq!(
            phase_for_error(CloudErrorCode::ConnectionSyncQuotaExceeded),
            CloudSyncRuntimePhase::QuotaExceeded
        );
        assert_eq!(
            phase_for_error(CloudErrorCode::SyncDeviceNotAuthorized),
            CloudSyncRuntimePhase::DeviceRevoked
        );
    }

    #[test]
    fn scheduling_from_a_synchronous_setup_context_does_not_require_a_tokio_reactor() {
        let fake = FakeExecutor::new(vec![Ok(execution())]);
        let scheduler = CloudSyncScheduler::for_test(fake.clone(), fast_delays());

        // This test intentionally runs outside a #[tokio::test] context.  The
        // real application invokes the scheduler from Tauri's synchronous
        // setup hook, which is the context that previously panicked.
        scheduler.start();
        tauri::async_runtime::block_on(async {
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        });

        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn local_changes_are_bounded_and_coalesced() {
        let fake = FakeExecutor::new(vec![Ok(execution())]);
        let scheduler = CloudSyncScheduler::for_test(fake.clone(), fast_delays());
        scheduler.on_local_change();
        scheduler.on_local_change();
        scheduler.on_local_change();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
        assert_eq!(scheduler.status().phase, CloudSyncRuntimePhase::Idle);
    }

    #[tokio::test]
    async fn pause_cancels_a_debounced_local_change() {
        let fake = FakeExecutor::new(Vec::new());
        let scheduler = CloudSyncScheduler::for_test(fake.clone(), fast_delays());
        scheduler.on_local_change();
        scheduler.set_paused(true);
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
        assert_eq!(scheduler.status().phase, CloudSyncRuntimePhase::Paused);
    }

    #[tokio::test]
    async fn retryable_failure_is_retried_without_blocking_local_state() {
        let fake = FakeExecutor::new(vec![
            Ok(execution()),
            Err(CloudPublicError::from_code(
                CloudErrorCode::TemporarilyUnavailable,
            )),
        ]);
        let scheduler = CloudSyncScheduler::for_test(fake.clone(), fast_delays());
        scheduler.handle_auth_session_event(true);
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
        assert_eq!(scheduler.status().phase, CloudSyncRuntimePhase::Idle);
        assert_eq!(scheduler.status().retry_attempt, 0);
    }

    #[tokio::test]
    async fn a_changed_account_invalidates_a_queued_run() {
        let fake = FakeExecutor::new(vec![Ok(execution())]);
        let scheduler = CloudSyncScheduler::for_test(fake.clone(), fast_delays());
        scheduler.on_local_change();
        fake.set_identity(Some("identity-b"));
        scheduler.handle_auth_session_event(true);
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
        assert_eq!(scheduler.status().phase, CloudSyncRuntimePhase::Idle);
    }
}
