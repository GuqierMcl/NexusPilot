#![allow(dead_code)]

use std::future::pending;
use std::time::Duration;

use async_trait::async_trait;
use clickhouse::error::Error as ClickHouseError;
use tokio::sync::watch;
use uuid::Uuid;

use crate::engine::drivers::clickhouse::ClickHouseDriver;
use crate::engine::native_schema::{
    NativeSchemaChangeBaseline, NativeSchemaConfirmationInput, NativeSchemaRequiredConfirmation,
};
use crate::engine::types::ContainerRef;
use crate::error::{IpcError, IpcResult};

use super::describe::describe_table;
use super::schema_compare::table_baselines_equal;
use super::types::ClickHouseTableSchema;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ChangeCommandRequest {
    pub(super) statement: String,
    pub(super) query_id: String,
    settings: Vec<(&'static str, String)>,
}

impl ChangeCommandRequest {
    pub(super) fn new(statement: String, timeout: Duration) -> Self {
        Self {
            statement,
            query_id: Uuid::new_v4().to_string(),
            settings: vec![
                ("wait_end_of_query", "1".to_string()),
                ("max_execution_time", timeout.as_secs().max(1).to_string()),
            ],
        }
    }

    pub(super) fn has_setting(&self, name: &str, value: &str) -> bool {
        self.settings
            .iter()
            .any(|(candidate, candidate_value)| *candidate == name && candidate_value == value)
    }
}

#[async_trait]
pub(super) trait ChangeBackend: Send + Sync {
    async fn execute_statement(
        &self,
        request: &ChangeCommandRequest,
    ) -> Result<(), ClickHouseError>;

    async fn describe_table(&self, container: &ContainerRef) -> IpcResult<ClickHouseTableSchema>;
}

pub(super) struct DriverChangeBackend<'a> {
    driver: &'a ClickHouseDriver,
}

impl<'a> DriverChangeBackend<'a> {
    pub(super) fn new(driver: &'a ClickHouseDriver) -> Self {
        Self { driver }
    }
}

#[async_trait]
impl ChangeBackend for DriverChangeBackend<'_> {
    async fn execute_statement(
        &self,
        request: &ChangeCommandRequest,
    ) -> Result<(), ClickHouseError> {
        let mut query = self
            .driver
            .client
            .query(&request.statement)
            .with_setting("query_id", &request.query_id);
        for (name, value) in &request.settings {
            query = query.with_setting(*name, value);
        }
        query.execute().await
    }

    async fn describe_table(&self, container: &ContainerRef) -> IpcResult<ClickHouseTableSchema> {
        describe_table(self.driver, container).await
    }
}

pub(super) enum StatementOutcome {
    Acknowledged,
    Ambiguous,
    Failed(IpcError),
    CanceledBeforeSend(IpcError),
}

pub(super) fn validate_plan_hash(actual: &str, expected: &str) -> IpcResult<()> {
    if actual != expected {
        return Err(IpcError::validation_failed(
            "ClickHouse schema change preview is stale; preview again before applying",
        ));
    }
    Ok(())
}

pub(super) fn validate_request_table_baseline(
    baseline: &NativeSchemaChangeBaseline,
    target_baseline: &ClickHouseTableSchema,
) -> IpcResult<()> {
    let NativeSchemaChangeBaseline::ClickHouseTable(request_baseline) = baseline else {
        return Err(IpcError::validation_failed(
            "ClickHouse table schema change requires a table baseline",
        ));
    };
    if !table_baselines_equal(request_baseline, target_baseline)? {
        return Err(IpcError::resource_conflict(
            "ClickHouse schema change baseline no longer matches its target",
        ));
    }
    Ok(())
}

pub(super) fn validate_native_schema_confirmation(
    required: NativeSchemaRequiredConfirmation,
    confirmation: Option<&NativeSchemaConfirmationInput>,
    expected_object_name: &str,
    expected_cluster_name: Option<&str>,
) -> IpcResult<()> {
    match required {
        NativeSchemaRequiredConfirmation::None if confirmation.is_none() => Ok(()),
        NativeSchemaRequiredConfirmation::None => Err(IpcError::validation_failed(
            "ClickHouse schema change does not accept confirmation for this plan",
        )),
        NativeSchemaRequiredConfirmation::Confirm
            if confirmation.is_some_and(|confirmation| confirmation.accepted) =>
        {
            Ok(())
        }
        NativeSchemaRequiredConfirmation::TypeObjectName
            if confirmation.is_some_and(|confirmation| {
                confirmation.accepted
                    && confirmation.object_name.as_deref() == Some(expected_object_name)
            }) =>
        {
            Ok(())
        }
        NativeSchemaRequiredConfirmation::TypeObjectAndCluster
            if confirmation.is_some_and(|confirmation| {
                confirmation.accepted
                    && confirmation.object_name.as_deref() == Some(expected_object_name)
                    && confirmation.cluster_name.as_deref() == expected_cluster_name
                    && expected_cluster_name.is_some()
            }) =>
        {
            Ok(())
        }
        _ => Err(IpcError::validation_failed(
            "ClickHouse schema change requires the exact preview confirmation",
        )),
    }
}

pub(super) async fn validate_remote_baseline(
    backend: &(impl ChangeBackend + ?Sized),
    container: &ContainerRef,
    expected: &ClickHouseTableSchema,
) -> IpcResult<()> {
    let current = backend.describe_table(container).await?;
    if !table_baselines_equal(expected, &current)? {
        return Err(IpcError::resource_conflict(
            "ClickHouse table changed after preview; refresh before applying",
        ));
    }
    Ok(())
}

pub(super) fn reject_shutdown_before_send(
    shutdown: &watch::Receiver<bool>,
    operation: &str,
) -> IpcResult<()> {
    if *shutdown.borrow() {
        return Err(IpcError::operation_canceled(
            "ClickHouse schema change canceled before execution",
            format!("operation={operation}; category=shutdown_before_send"),
        ));
    }
    Ok(())
}

pub(super) async fn execute_statement_once(
    backend: &(impl ChangeBackend + ?Sized),
    request: &ChangeCommandRequest,
    operation: &str,
    shutdown: watch::Receiver<bool>,
    timeout: Duration,
) -> StatementOutcome {
    if let Err(error) = reject_shutdown_before_send(&shutdown, operation) {
        return StatementOutcome::CanceledBeforeSend(error);
    }

    let shutdown_future = wait_for_shutdown(shutdown);
    let statement_future = tokio::time::timeout(timeout, backend.execute_statement(request));
    tokio::pin!(shutdown_future);
    tokio::pin!(statement_future);

    tokio::select! {
        biased;
        _ = &mut shutdown_future => StatementOutcome::Ambiguous,
        response = &mut statement_future => match response {
            Err(_) => StatementOutcome::Ambiguous,
            Ok(Ok(())) => StatementOutcome::Acknowledged,
            Ok(Err(error)) if is_ambiguous_transport(&error) => StatementOutcome::Ambiguous,
            Ok(Err(error)) => StatementOutcome::Failed(
                crate::engine::drivers::clickhouse::error::classify_schema_change_error(
                    error,
                    operation,
                ),
            ),
        },
    }
}

async fn wait_for_shutdown(mut shutdown: watch::Receiver<bool>) {
    loop {
        match shutdown.changed().await {
            Ok(()) if *shutdown.borrow() => return,
            Ok(()) => continue,
            Err(_) => pending::<()>().await,
        }
    }
}

fn is_ambiguous_transport(error: &ClickHouseError) -> bool {
    matches!(
        error,
        ClickHouseError::Network(_) | ClickHouseError::TimedOut
    )
}

#[cfg(test)]
mod tests {
    use std::future::pending;
    use std::sync::Mutex;
    use std::time::Duration;

    use async_trait::async_trait;
    use clickhouse::error::Error as ClickHouseError;
    use tokio::sync::watch;

    use super::*;
    use crate::engine::drivers::clickhouse::schema::types::fixture_schema;
    use crate::engine::types::ContainerRef;
    use crate::error::IpcResult;

    #[derive(Clone, Copy)]
    enum FakeResponse {
        Acknowledge,
        Fail,
        Wait,
    }

    struct FakeBackend {
        response: FakeResponse,
        calls: Mutex<Vec<ChangeCommandRequest>>,
    }

    impl FakeBackend {
        fn new(response: FakeResponse) -> Self {
            Self {
                response,
                calls: Mutex::new(Vec::new()),
            }
        }

        fn call_count(&self) -> usize {
            self.calls.lock().unwrap().len()
        }
    }

    #[async_trait]
    impl ChangeBackend for FakeBackend {
        async fn execute_statement(
            &self,
            request: &ChangeCommandRequest,
        ) -> Result<(), ClickHouseError> {
            self.calls.lock().unwrap().push(request.clone());
            match self.response {
                FakeResponse::Acknowledge => Ok(()),
                FakeResponse::Fail => Err(ClickHouseError::BadResponse(
                    "Code: 62. SECRET_OBJECT query=ALTER TABLE analytics.events password=secret"
                        .to_string(),
                )),
                FakeResponse::Wait => pending().await,
            }
        }

        async fn describe_table(
            &self,
            _container: &ContainerRef,
        ) -> IpcResult<ClickHouseTableSchema> {
            Ok(fixture_schema())
        }
    }

    #[test]
    fn command_requests_have_distinct_ids_and_bounded_wait_settings() {
        let timeout = Duration::from_secs(7);
        let first = ChangeCommandRequest::new("ALTER ONE".to_string(), timeout);
        let second = ChangeCommandRequest::new("ALTER TWO".to_string(), timeout);

        assert!(!first.query_id.is_empty());
        assert_ne!(first.query_id, second.query_id);
        assert!(first.has_setting("wait_end_of_query", "1"));
        assert!(first.has_setting("max_execution_time", "7"));
    }

    #[test]
    fn typed_confirmation_levels_validate_exact_user_intent() {
        let accepted = NativeSchemaConfirmationInput {
            accepted: true,
            object_name: Some("events_mv".to_string()),
            cluster_name: Some("analytics_cluster".to_string()),
        };

        assert!(validate_native_schema_confirmation(
            NativeSchemaRequiredConfirmation::None,
            None,
            "events_mv",
            None,
        )
        .is_ok());
        assert!(validate_native_schema_confirmation(
            NativeSchemaRequiredConfirmation::None,
            Some(&accepted),
            "events_mv",
            None,
        )
        .is_err());
        assert!(validate_native_schema_confirmation(
            NativeSchemaRequiredConfirmation::Confirm,
            Some(&accepted),
            "events_mv",
            None,
        )
        .is_ok());
        assert!(validate_native_schema_confirmation(
            NativeSchemaRequiredConfirmation::TypeObjectName,
            Some(&accepted),
            "events_mv",
            None,
        )
        .is_ok());
        assert!(validate_native_schema_confirmation(
            NativeSchemaRequiredConfirmation::TypeObjectName,
            Some(&accepted),
            "other_mv",
            None,
        )
        .is_err());
        assert!(validate_native_schema_confirmation(
            NativeSchemaRequiredConfirmation::TypeObjectAndCluster,
            Some(&accepted),
            "events_mv",
            Some("analytics_cluster"),
        )
        .is_ok());
        assert!(validate_native_schema_confirmation(
            NativeSchemaRequiredConfirmation::TypeObjectAndCluster,
            Some(&accepted),
            "events_mv",
            Some("other_cluster"),
        )
        .is_err());
    }

    #[tokio::test]
    async fn canceled_before_send_never_calls_backend_or_leaks_statement() {
        let backend = FakeBackend::new(FakeResponse::Acknowledge);
        let (_sender, shutdown) = watch::channel(true);
        let request = ChangeCommandRequest::new(
            "ALTER TABLE analytics.events SECRET_OBJECT".to_string(),
            Duration::from_secs(1),
        );

        let StatementOutcome::CanceledBeforeSend(error) = execute_statement_once(
            &backend,
            &request,
            "projection create",
            shutdown,
            Duration::from_secs(1),
        )
        .await
        else {
            panic!("expected canceled-before-send outcome");
        };

        assert_eq!(backend.call_count(), 0);
        let diagnostic = format!("{error:?}");
        assert!(!diagnostic.contains("SECRET_OBJECT"));
        assert!(!diagnostic.contains("analytics.events"));
    }

    #[tokio::test]
    async fn statement_failures_and_timeouts_are_sent_once_without_sensitive_diagnostics() {
        let failed_backend = FakeBackend::new(FakeResponse::Fail);
        let (_sender, shutdown) = watch::channel(false);
        let request = ChangeCommandRequest::new(
            "ALTER TABLE analytics.events SECRET_OBJECT".to_string(),
            Duration::from_secs(1),
        );
        let StatementOutcome::Failed(error) = execute_statement_once(
            &failed_backend,
            &request,
            "projection create",
            shutdown,
            Duration::from_secs(1),
        )
        .await
        else {
            panic!("expected failed outcome");
        };
        assert_eq!(failed_backend.call_count(), 1);
        let diagnostic = format!("{error:?}");
        assert!(!diagnostic.contains("SECRET_OBJECT"));
        assert!(!diagnostic.contains("analytics.events"));
        assert!(!diagnostic.contains("secret"));

        let timeout_backend = FakeBackend::new(FakeResponse::Wait);
        let (_sender, shutdown) = watch::channel(false);
        assert!(matches!(
            execute_statement_once(
                &timeout_backend,
                &request,
                "projection create",
                shutdown,
                Duration::from_millis(1),
            )
            .await,
            StatementOutcome::Ambiguous
        ));
        assert_eq!(timeout_backend.call_count(), 1);
    }
}
