use crate::engine::types::{RuntimeHealthSnapshot, RuntimeHealthStatus};
use crate::error::{IpcError, RuntimeErrorImpact};

impl RuntimeHealthSnapshot {
    pub fn healthy(profile_id: impl Into<String>, now_ms: u64) -> Self {
        Self {
            profile_id: profile_id.into(),
            status: RuntimeHealthStatus::Healthy,
            consecutive_failures: 0,
            last_success_at_ms: Some(now_ms),
            last_failure_at_ms: None,
            last_error_code: None,
        }
    }

    pub fn record_success(&mut self, now_ms: u64) {
        self.status = RuntimeHealthStatus::Healthy;
        self.consecutive_failures = 0;
        self.last_success_at_ms = Some(now_ms);
        self.last_error_code = None;
    }

    pub fn record_failure(&mut self, error: &IpcError, now_ms: u64) {
        self.status = match error.runtime_impact {
            RuntimeErrorImpact::BusinessOnly => return,
            RuntimeErrorImpact::Retryable => RuntimeHealthStatus::Degraded,
            RuntimeErrorImpact::Terminal => RuntimeHealthStatus::Error,
        };
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        self.last_failure_at_ms = Some(now_ms);
        self.last_error_code = Some(error.code);
    }
}

#[cfg(test)]
mod tests {
    use crate::engine::types::{RuntimeHealthSnapshot, RuntimeHealthStatus};
    use crate::error::{IpcError, RuntimeErrorImpact};

    #[test]
    fn ipc_error_constructors_declare_runtime_impact() {
        let network_error = IpcError::network_timeout("network", "connection refused");
        let auth_error = IpcError::auth_failed("auth", "password rejected");
        let syntax_error = IpcError::query_syntax("syntax", "bad statement");
        let operation_timeout = IpcError::operation_timeout("query timeout", "elapsed");

        assert_eq!(network_error.runtime_impact, RuntimeErrorImpact::Retryable);
        assert_eq!(auth_error.runtime_impact, RuntimeErrorImpact::Terminal);
        assert_eq!(
            syntax_error.runtime_impact,
            RuntimeErrorImpact::BusinessOnly
        );
        assert_eq!(
            operation_timeout.runtime_impact,
            RuntimeErrorImpact::BusinessOnly
        );
    }

    #[test]
    fn retryable_probe_failure_degrades_and_success_recovers_snapshot() {
        let mut snapshot = RuntimeHealthSnapshot::healthy("profile-1", 10);
        let error = IpcError::network_timeout("network", "connection refused");

        snapshot.record_failure(&error, 20);
        assert_eq!(snapshot.status, RuntimeHealthStatus::Degraded);
        assert_eq!(snapshot.consecutive_failures, 1);
        assert_eq!(snapshot.last_success_at_ms, Some(10));
        assert_eq!(snapshot.last_failure_at_ms, Some(20));
        assert_eq!(snapshot.last_error_code, Some(error.code));

        snapshot.record_success(30);
        assert_eq!(snapshot.status, RuntimeHealthStatus::Healthy);
        assert_eq!(snapshot.consecutive_failures, 0);
        assert_eq!(snapshot.last_success_at_ms, Some(30));
        assert_eq!(snapshot.last_failure_at_ms, Some(20));
        assert_eq!(snapshot.last_error_code, None);
    }

    #[test]
    fn business_only_failure_does_not_change_runtime_health() {
        let mut snapshot = RuntimeHealthSnapshot::healthy("profile-1", 10);
        let error = IpcError::operation_timeout("query timeout", "elapsed");

        snapshot.record_failure(&error, 20);

        assert_eq!(snapshot.status, RuntimeHealthStatus::Healthy);
        assert_eq!(snapshot.consecutive_failures, 0);
        assert_eq!(snapshot.last_failure_at_ms, None);
        assert_eq!(snapshot.last_error_code, None);
    }

    #[test]
    fn terminal_failure_moves_runtime_health_to_error() {
        let mut snapshot = RuntimeHealthSnapshot::healthy("profile-1", 10);
        let error = IpcError::auth_failed("auth", "password rejected");

        snapshot.record_failure(&error, 25);

        assert_eq!(snapshot.status, RuntimeHealthStatus::Error);
        assert_eq!(snapshot.consecutive_failures, 1);
        assert_eq!(snapshot.last_failure_at_ms, Some(25));
        assert_eq!(snapshot.last_error_code, Some(error.code));
    }

    #[test]
    fn consecutive_retryable_failures_are_counted() {
        let mut snapshot = RuntimeHealthSnapshot::healthy("profile-1", 10);
        let error = IpcError::network_timeout("network", "connection refused");

        snapshot.record_failure(&error, 20);
        snapshot.record_failure(&error, 30);

        assert_eq!(snapshot.status, RuntimeHealthStatus::Degraded);
        assert_eq!(snapshot.consecutive_failures, 2);
        assert_eq!(snapshot.last_failure_at_ms, Some(30));
    }
}
