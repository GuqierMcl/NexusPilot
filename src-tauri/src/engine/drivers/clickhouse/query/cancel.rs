use std::time::Duration;

use async_trait::async_trait;
use clickhouse::Client;
use serde::Deserialize;

use super::policy::ExecutionPolicy;
use crate::engine::sql_execution::{ManagedSqlCancelRequest, SqlCancelConfirmation};
use crate::error::{IpcError, IpcResult};

const KILL_QUERY_SQL: &str = "KILL QUERY WHERE query_id = ? SYNC";
const CONTROL_TIMEOUT_MS: u64 = 5_000;

#[derive(Debug, Clone, PartialEq, Eq)]
struct CancelQueryCall {
    target_query_id: String,
    control_query_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct KillQueryResult {
    kill_status: String,
    query_id: String,
}

#[derive(clickhouse::Row, Deserialize)]
struct KillQueryRow {
    kill_status: String,
    query_id: String,
    user: String,
    query: String,
}

#[async_trait]
trait CancelExecutor: Send + Sync {
    async fn execute_cancel(&self, call: CancelQueryCall) -> IpcResult<Vec<KillQueryResult>>;
}

struct ClientCancelExecutor<'a> {
    client: &'a Client,
}

#[async_trait]
impl CancelExecutor for ClientCancelExecutor<'_> {
    async fn execute_cancel(&self, call: CancelQueryCall) -> IpcResult<Vec<KillQueryResult>> {
        let query = ExecutionPolicy::Control.apply(
            self.client
                .query(KILL_QUERY_SQL)
                .bind(call.target_query_id.as_str())
                .with_setting("query_id", call.control_query_id.as_str()),
            Some(CONTROL_TIMEOUT_MS),
        );
        let rows = tokio::time::timeout(
            Duration::from_millis(CONTROL_TIMEOUT_MS),
            query.fetch_all::<KillQueryRow>(),
        )
        .await
        .map_err(|_| {
            IpcError::network_timeout(
                "ClickHouse query cancellation timed out",
                "operation=cancel query; category=transport_timeout",
            )
        })?
        .map_err(|error| super::super::error::classify_query_error(error, "cancel query"))?;

        Ok(rows
            .into_iter()
            .map(|row| {
                let _ = (row.user, row.query);
                KillQueryResult {
                    kill_status: row.kill_status,
                    query_id: row.query_id,
                }
            })
            .collect())
    }
}

pub(super) async fn cancel(
    client: &Client,
    request: ManagedSqlCancelRequest,
) -> IpcResult<SqlCancelConfirmation> {
    cancel_with(&ClientCancelExecutor { client }, request).await
}

pub(super) async fn cancel_target(
    client: &Client,
    target_query_id: &str,
) -> IpcResult<SqlCancelConfirmation> {
    cancel_with(
        &ClientCancelExecutor { client },
        ManagedSqlCancelRequest {
            execution_id: String::new(),
            query_id: target_query_id.to_string(),
            tab_id: String::new(),
        },
    )
    .await
}

async fn cancel_with<E: CancelExecutor>(
    executor: &E,
    request: ManagedSqlCancelRequest,
) -> IpcResult<SqlCancelConfirmation> {
    if request.query_id.trim().is_empty() {
        return Err(IpcError::validation_failed(
            "ClickHouse cancellation requires a target query ID",
        ));
    }
    let target_query_id = request.query_id;
    let call = CancelQueryCall {
        target_query_id: target_query_id.clone(),
        control_query_id: uuid::Uuid::new_v4().to_string(),
    };
    let rows = match executor.execute_cancel(call).await {
        Ok(rows) => rows,
        Err(error) => return Ok(SqlCancelConfirmation::Failed(error.into())),
    };
    if rows.is_empty() {
        return Ok(SqlCancelConfirmation::AlreadyFinished(
            "目标查询已不在 ClickHouse 活动进程中".to_string(),
        ));
    }

    let exact_target_rows = rows
        .iter()
        .filter(|row| row.query_id == target_query_id)
        .collect::<Vec<_>>();
    if matches!(
        exact_target_rows.as_slice(),
        [row] if row.kill_status.eq_ignore_ascii_case("finished")
    ) {
        return Ok(SqlCancelConfirmation::Confirmed(
            "ClickHouse 已确认查询终止".to_string(),
        ));
    }

    Ok(SqlCancelConfirmation::Failed(
        IpcError::validation_failed("ClickHouse 未确认目标查询终止").into(),
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::*;
    use crate::engine::sql_execution::{ManagedSqlCancelRequest, SqlCancelConfirmation};
    use crate::error::{IpcError, IpcResult, RuntimeErrorImpact};

    struct RecordingCancelExecutor {
        calls: Mutex<Vec<CancelQueryCall>>,
        response: Mutex<Option<IpcResult<Vec<KillQueryResult>>>>,
    }

    impl RecordingCancelExecutor {
        fn rows(rows: Vec<KillQueryResult>) -> Self {
            Self::response(Ok(rows))
        }

        fn permission_denied() -> Self {
            Self::response(Err(IpcError::validation_failed(
                "ClickHouse denied query cancellation",
            )))
        }

        fn transport_failed() -> Self {
            Self::response(Err(IpcError::network_timeout(
                "ClickHouse cancellation transport failed",
                "operation=cancel query; category=transport",
            )))
        }

        fn response(response: IpcResult<Vec<KillQueryResult>>) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                response: Mutex::new(Some(response)),
            }
        }

        fn calls(&self) -> Vec<CancelQueryCall> {
            self.calls.lock().expect("calls lock").clone()
        }
    }

    #[async_trait]
    impl CancelExecutor for RecordingCancelExecutor {
        async fn execute_cancel(&self, call: CancelQueryCall) -> IpcResult<Vec<KillQueryResult>> {
            self.calls.lock().expect("calls lock").push(call);
            self.response
                .lock()
                .expect("response lock")
                .take()
                .expect("one fake response")
        }
    }

    fn cancel_request(query_id: &str) -> ManagedSqlCancelRequest {
        ManagedSqlCancelRequest {
            execution_id: "execution-1".to_string(),
            query_id: query_id.to_string(),
            tab_id: "tab-1".to_string(),
        }
    }

    #[tokio::test]
    async fn finished_exact_target_is_the_only_confirmed_cancel_result() {
        let executor = RecordingCancelExecutor::rows(vec![KillQueryResult {
            kill_status: "finished".to_string(),
            query_id: "target-query".to_string(),
        }]);

        let result = cancel_with(&executor, cancel_request("target-query"))
            .await
            .unwrap();

        assert!(matches!(result, SqlCancelConfirmation::Confirmed(_)));
        assert_eq!(executor.calls()[0].target_query_id, "target-query");
        assert_ne!(executor.calls()[0].control_query_id, "target-query");
    }

    #[tokio::test]
    async fn waiting_empty_mismatch_and_permission_are_not_confirmation() {
        let cases = [
            RecordingCancelExecutor::rows(vec![KillQueryResult {
                kill_status: "waiting".to_string(),
                query_id: "target-query".to_string(),
            }]),
            RecordingCancelExecutor::rows(Vec::new()),
            RecordingCancelExecutor::rows(vec![KillQueryResult {
                kill_status: "finished".to_string(),
                query_id: "other-query".to_string(),
            }]),
            RecordingCancelExecutor::permission_denied(),
        ];

        for executor in cases {
            let result = cancel_with(&executor, cancel_request("target-query"))
                .await
                .unwrap();
            assert!(matches!(
                result,
                SqlCancelConfirmation::AlreadyFinished(_) | SqlCancelConfirmation::Failed(_)
            ));
        }
    }

    #[tokio::test]
    async fn control_failures_preserve_impact_and_do_not_expose_sensitive_payloads() {
        for (executor, expected_impact) in [
            (
                RecordingCancelExecutor::permission_denied(),
                RuntimeErrorImpact::BusinessOnly,
            ),
            (
                RecordingCancelExecutor::transport_failed(),
                RuntimeErrorImpact::Retryable,
            ),
        ] {
            let result = cancel_with(&executor, cancel_request("target-query"))
                .await
                .unwrap();
            let SqlCancelConfirmation::Failed(failure) = result else {
                panic!("control error must be an unconfirmed cancellation");
            };
            assert_eq!(failure.runtime_impact, expected_impact);
            let serialized = format!("{} {:?}", failure.message, failure.details);
            assert!(!serialized.contains("password"));
            assert!(!serialized.contains("KILL QUERY"));
        }
    }
}
