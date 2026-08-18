#![allow(dead_code)]

use std::time::Duration;

use tokio::sync::watch;

use crate::engine::drivers::clickhouse::ClickHouseDriver;
use crate::engine::native_schema::{
    NativeSchemaChangeTarget, NativeSchemaExecuteChangeRequest, NativeSchemaExecutionStatus,
    NativeSchemaStatementProgress,
};
use crate::engine::types::{ContainerKind, ContainerRef, SchemaMutationOperation};
use crate::error::{IpcError, IpcResult};

use super::alter_render::{plan_alter_table, plan_column_clear, plan_column_materialize};
use super::change_runtime::{
    execute_statement_once, reject_shutdown_before_send, validate_native_schema_confirmation,
    validate_plan_hash, validate_remote_baseline, validate_request_table_baseline, ChangeBackend,
    ChangeCommandRequest, DriverChangeBackend, StatementOutcome,
};
use super::change_types::{ClickHouseColumnActionResult, ClickHouseTableAlterResult};
use super::schema_compare::table_schema_matches_target;

pub(super) async fn execute_table_alter(
    driver: &ClickHouseDriver,
    request: &NativeSchemaExecuteChangeRequest,
) -> IpcResult<ClickHouseTableAlterResult> {
    execute_table_alter_with(
        &DriverChangeBackend::new(driver),
        request,
        driver.timeout,
        driver.shutdown.subscribe(),
    )
    .await
}

pub(super) async fn execute_column_action(
    driver: &ClickHouseDriver,
    request: &NativeSchemaExecuteChangeRequest,
    operation: SchemaMutationOperation,
) -> IpcResult<ClickHouseColumnActionResult> {
    execute_column_action_with(
        &DriverChangeBackend::new(driver),
        request,
        operation,
        driver.timeout,
        driver.shutdown.subscribe(),
    )
    .await
}

async fn execute_table_alter_with(
    backend: &(impl ChangeBackend + ?Sized),
    request: &NativeSchemaExecuteChangeRequest,
    timeout: Duration,
    shutdown: watch::Receiver<bool>,
) -> IpcResult<ClickHouseTableAlterResult> {
    let NativeSchemaChangeTarget::ClickHouseTableAlter(target) = &request.target else {
        return Err(IpcError::validation_failed(
            "ClickHouse table ALTER executor requires a table alter target",
        ));
    };
    let plan = plan_alter_table(target)?;
    validate_plan_hash(&plan.plan_hash, &request.expected_plan_hash)?;
    validate_request_table_baseline(&request.baseline, &target.baseline)?;
    validate_native_schema_confirmation(
        plan.required_confirmation,
        request.confirmation.as_ref(),
        &target.desired.name,
        None,
    )?;

    let container = ContainerRef::table(
        ContainerKind::Table,
        &target.desired.database,
        None,
        &target.desired.name,
    );
    validate_remote_baseline(backend, &container, &target.baseline).await?;
    reject_shutdown_before_send(&shutdown, "alter table")?;

    let statement_count = plan.statements.len() as u32;
    let mut applied_count = 0_u32;
    let mut failed_statement_index = None;
    let mut query_ids = Vec::with_capacity(plan.statements.len());
    let mut terminal_error = None;
    let mut ambiguous = false;

    for (index, statement) in plan.statements.iter().enumerate() {
        let command = ChangeCommandRequest::new(statement.clone(), timeout);
        match execute_statement_once(backend, &command, "alter table", shutdown.clone(), timeout)
            .await
        {
            StatementOutcome::Acknowledged => {
                query_ids.push(command.query_id);
                applied_count += 1;
            }
            StatementOutcome::Ambiguous => {
                query_ids.push(command.query_id);
                ambiguous = true;
                break;
            }
            StatementOutcome::Failed(error) => {
                query_ids.push(command.query_id);
                failed_statement_index = Some(index as u32);
                terminal_error = Some(error);
                break;
            }
            StatementOutcome::CanceledBeforeSend(error) => {
                if applied_count == 0 {
                    return Err(error);
                }
                ambiguous = true;
                break;
            }
        }
    }

    let remote = backend.describe_table(&container).await;
    if applied_count == 0 {
        if let Some(error) = terminal_error {
            return Err(error);
        }
    }

    let sent_count = query_ids.len() as u32;
    let mut progress = NativeSchemaStatementProgress {
        applied_count,
        failed_statement_index,
        remaining_count: statement_count.saturating_sub(sent_count),
        query_ids,
    };
    let (status, schema) = match remote {
        Ok(schema) if table_schema_matches_target(&target.desired, &schema) => {
            progress.applied_count = statement_count;
            progress.failed_statement_index = None;
            progress.remaining_count = 0;
            (NativeSchemaExecutionStatus::Applied, Some(schema))
        }
        Ok(schema) if applied_count > 0 => {
            (NativeSchemaExecutionStatus::PartiallyApplied, Some(schema))
        }
        Ok(schema) => (NativeSchemaExecutionStatus::OutcomeUnknown, Some(schema)),
        Err(_) => (NativeSchemaExecutionStatus::OutcomeUnknown, None),
    };

    debug_assert!(
        ambiguous
            || terminal_error.is_some()
            || applied_count == statement_count
            || status == NativeSchemaExecutionStatus::OutcomeUnknown
    );
    Ok(ClickHouseTableAlterResult {
        status,
        progress,
        container,
        table_name: target.desired.name.clone(),
        schema,
    })
}

async fn execute_column_action_with(
    backend: &(impl ChangeBackend + ?Sized),
    request: &NativeSchemaExecuteChangeRequest,
    operation: SchemaMutationOperation,
    timeout: Duration,
    shutdown: watch::Receiver<bool>,
) -> IpcResult<ClickHouseColumnActionResult> {
    let target = match (&request.target, operation) {
        (
            NativeSchemaChangeTarget::ClickHouseColumnClear(target),
            SchemaMutationOperation::Clear,
        ) => target.as_ref(),
        (
            NativeSchemaChangeTarget::ClickHouseColumnMaterialize(target),
            SchemaMutationOperation::Materialize,
        ) => target.as_ref(),
        _ => {
            return Err(IpcError::validation_failed(
                "ClickHouse column action executor target does not match its operation",
            ));
        }
    };
    let plan = match operation {
        SchemaMutationOperation::Clear => plan_column_clear(target)?,
        SchemaMutationOperation::Materialize => plan_column_materialize(target)?,
        _ => {
            return Err(IpcError::validation_failed(
                "ClickHouse column action executor supports only CLEAR or MATERIALIZE",
            ));
        }
    };
    validate_plan_hash(&plan.plan_hash, &request.expected_plan_hash)?;
    validate_request_table_baseline(&request.baseline, &target.baseline)?;
    validate_native_schema_confirmation(
        plan.required_confirmation,
        request.confirmation.as_ref(),
        &target.column_name,
        None,
    )?;

    let container = ContainerRef::table(
        ContainerKind::Table,
        &target.baseline.identity.database,
        None,
        &target.baseline.identity.name,
    );
    validate_remote_baseline(backend, &container, &target.baseline).await?;
    reject_shutdown_before_send(&shutdown, "column action")?;

    let [statement] = plan.statements.as_slice() else {
        return Err(IpcError::system_internal(
            "ClickHouse column action plan must contain exactly one statement",
            "operation=column_action; category=invalid_plan_statement_count",
        ));
    };
    let command = ChangeCommandRequest::new(statement.clone(), timeout);
    let outcome =
        execute_statement_once(backend, &command, "column action", shutdown, timeout).await;
    let remote = match &outcome {
        StatementOutcome::CanceledBeforeSend(_) => None,
        _ => backend.describe_table(&container).await.ok(),
    };
    let (status, applied_count) = match outcome {
        StatementOutcome::Acknowledged => (NativeSchemaExecutionStatus::Submitted, 1),
        StatementOutcome::Ambiguous => (NativeSchemaExecutionStatus::OutcomeUnknown, 0),
        StatementOutcome::Failed(error) | StatementOutcome::CanceledBeforeSend(error) => {
            return Err(error);
        }
    };

    Ok(ClickHouseColumnActionResult {
        status,
        progress: NativeSchemaStatementProgress {
            applied_count,
            failed_statement_index: None,
            remaining_count: 0,
            query_ids: vec![command.query_id],
        },
        container,
        column_name: target.column_name.clone(),
        operation,
        schema: remote,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;
    use std::time::Duration;

    use async_trait::async_trait;
    use clickhouse::error::Error as ClickHouseError;
    use tokio::sync::watch;

    use super::super::alter_render::{
        plan_alter_table, plan_column_clear, plan_column_materialize,
    };
    use super::*;
    use crate::engine::drivers::clickhouse::schema::{
        ClickHouseAlterTableTarget, ClickHouseColumnDataActionTarget, ClickHouseColumnDefaultKind,
        ClickHouseColumnSchema, ClickHouseCreateColumnTarget, ClickHouseCreateEngineTarget,
        ClickHouseCreateTableTarget, ClickHouseEngineSchema, ClickHouseKeySchema,
        ClickHouseSchemaBaseline, ClickHouseSchemaEditability, ClickHouseTableIdentity,
        ClickHouseTableSchema,
    };
    use crate::engine::native_schema::{
        NativeSchemaChangeBaseline, NativeSchemaChangeTarget, NativeSchemaConfirmationInput,
        NativeSchemaExecuteChangeRequest, NativeSchemaExecutionStatus,
    };
    use crate::engine::types::{ContainerKind, ContainerRef, SchemaMutationOperation};
    use crate::error::{ErrorCode, IpcError, IpcResult, RuntimeErrorImpact};

    enum FakeStatementResponse {
        Success,
        Error(ClickHouseError),
    }

    enum FakeDescribeResponse {
        Schema(ClickHouseTableSchema),
        Error,
    }

    struct FakeChangeBackend {
        responses: Mutex<VecDeque<FakeStatementResponse>>,
        describes: Mutex<VecDeque<FakeDescribeResponse>>,
        requests: Mutex<Vec<ChangeCommandRequest>>,
        describe_containers: Mutex<Vec<ContainerRef>>,
    }

    impl FakeChangeBackend {
        fn new(
            describes: impl IntoIterator<Item = FakeDescribeResponse>,
            responses: impl IntoIterator<Item = FakeStatementResponse>,
        ) -> Self {
            Self {
                responses: Mutex::new(responses.into_iter().collect()),
                describes: Mutex::new(describes.into_iter().collect()),
                requests: Mutex::new(Vec::new()),
                describe_containers: Mutex::new(Vec::new()),
            }
        }

        fn requests(&self) -> Vec<ChangeCommandRequest> {
            self.requests.lock().unwrap().clone()
        }

        fn describe_count(&self) -> usize {
            self.describe_containers.lock().unwrap().len()
        }
    }

    #[async_trait]
    impl ChangeBackend for FakeChangeBackend {
        async fn execute_statement(
            &self,
            request: &ChangeCommandRequest,
        ) -> Result<(), ClickHouseError> {
            self.requests.lock().unwrap().push(request.clone());
            match self.responses.lock().unwrap().pop_front().unwrap() {
                FakeStatementResponse::Success => Ok(()),
                FakeStatementResponse::Error(error) => Err(error),
            }
        }

        async fn describe_table(
            &self,
            container: &ContainerRef,
        ) -> IpcResult<ClickHouseTableSchema> {
            self.describe_containers
                .lock()
                .unwrap()
                .push(container.clone());
            match self.describes.lock().unwrap().pop_front().unwrap() {
                FakeDescribeResponse::Schema(schema) => Ok(schema),
                FakeDescribeResponse::Error => Err(IpcError::network_timeout(
                    "describe failed",
                    "category=test",
                )),
            }
        }
    }

    fn schema_column(name: &str, type_name: &str, position: u64) -> ClickHouseColumnSchema {
        ClickHouseColumnSchema {
            name: name.to_string(),
            type_name: type_name.to_string(),
            position,
            default_kind: ClickHouseColumnDefaultKind::None,
            default_expression: None,
            codec_expression: None,
            ttl_expression: None,
            comment: None,
            editability: ClickHouseSchemaEditability::editable(),
        }
    }

    fn baseline() -> ClickHouseTableSchema {
        ClickHouseTableSchema {
            identity: ClickHouseTableIdentity {
                database: "analytics".to_string(),
                name: "events".to_string(),
                object_kind: ContainerKind::Table,
                uuid: Some("00000000-0000-0000-0000-000000000001".to_string()),
            },
            engine: ClickHouseEngineSchema {
                family: "MergeTree".to_string(),
                arguments: Vec::new(),
                raw_expression: "MergeTree".to_string(),
            },
            columns: vec![
                schema_column("id", "UInt64", 1),
                schema_column("payload", "String", 2),
                schema_column("legacy", "String", 3),
            ],
            keys: ClickHouseKeySchema {
                order_by: "id".to_string(),
                partition_by: None,
                primary_key: Some("id".to_string()),
                sample_by: None,
            },
            table_ttl: None,
            comment: Some("events".to_string()),
            settings: Vec::new(),
            projections: Vec::new(),
            skipping_indexes: Vec::new(),
            editability: ClickHouseSchemaEditability::editable(),
            baseline: ClickHouseSchemaBaseline {
                canonical_create_query: "CREATE TABLE analytics.events".to_string(),
                revision_hash: "a".repeat(64),
            },
        }
    }

    fn target_column(column: &ClickHouseColumnSchema) -> ClickHouseCreateColumnTarget {
        ClickHouseCreateColumnTarget {
            name: column.name.clone(),
            type_name: column.type_name.clone(),
            default_kind: column.default_kind,
            default_expression: column.default_expression.clone(),
            codecs: Vec::new(),
            ttl_expression: column.ttl_expression.clone(),
            comment: column.comment.clone(),
        }
    }

    fn desired_from_baseline(schema: &ClickHouseTableSchema) -> ClickHouseCreateTableTarget {
        ClickHouseCreateTableTarget {
            database: schema.identity.database.clone(),
            name: schema.identity.name.clone(),
            columns: schema.columns.iter().map(target_column).collect(),
            engine: ClickHouseCreateEngineTarget {
                family: schema.engine.family.clone(),
                arguments: schema.engine.arguments.clone(),
            },
            keys: schema.keys.clone(),
            table_ttl: schema.table_ttl.clone(),
            comment: schema.comment.clone(),
            settings: Vec::new(),
        }
    }

    fn alter_target(
        mutate: impl FnOnce(&mut ClickHouseCreateTableTarget),
    ) -> ClickHouseAlterTableTarget {
        let baseline = baseline();
        let mut desired = desired_from_baseline(&baseline);
        mutate(&mut desired);
        ClickHouseAlterTableTarget {
            baseline,
            desired,
            column_renames: Vec::new(),
        }
    }

    fn safe_target() -> ClickHouseAlterTableTarget {
        alter_target(|desired| desired.comment = Some("safe change".to_string()))
    }

    fn destructive_target() -> ClickHouseAlterTableTarget {
        alter_target(|desired| {
            desired.columns.retain(|column| column.name != "payload");
        })
    }

    fn full_target() -> ClickHouseAlterTableTarget {
        alter_target(|desired| {
            desired.columns.retain(|column| column.name != "legacy");
            desired.columns.push(ClickHouseCreateColumnTarget {
                name: "source".to_string(),
                type_name: "String".to_string(),
                default_kind: ClickHouseColumnDefaultKind::None,
                default_expression: None,
                codecs: Vec::new(),
                ttl_expression: None,
                comment: None,
            });
            desired.comment = Some("changed".to_string());
        })
    }

    fn schema_from_target(target: &ClickHouseAlterTableTarget) -> ClickHouseTableSchema {
        let mut schema = target.baseline.clone();
        schema.columns = target
            .desired
            .columns
            .iter()
            .enumerate()
            .map(|(index, column)| ClickHouseColumnSchema {
                name: column.name.clone(),
                type_name: column.type_name.clone(),
                position: index as u64 + 1,
                default_kind: column.default_kind,
                default_expression: column.default_expression.clone(),
                codec_expression: None,
                ttl_expression: column.ttl_expression.clone(),
                comment: column.comment.clone(),
                editability: ClickHouseSchemaEditability::editable(),
            })
            .collect();
        schema.keys = target.desired.keys.clone();
        schema.table_ttl = target.desired.table_ttl.clone();
        schema.comment = target.desired.comment.clone();
        schema
    }

    fn actual_after_first_statement() -> ClickHouseTableSchema {
        let mut schema = baseline();
        schema
            .columns
            .insert(2, schema_column("source", "String", 3));
        schema.columns[3].position = 4;
        schema
    }

    fn drifted_baseline() -> ClickHouseTableSchema {
        let mut schema = baseline();
        schema.columns[1].type_name = "LowCardinality(String)".to_string();
        schema
    }

    fn table_request(
        target: ClickHouseAlterTableTarget,
        confirm_destructive: bool,
    ) -> NativeSchemaExecuteChangeRequest {
        let plan = plan_alter_table(&target).unwrap();
        NativeSchemaExecuteChangeRequest {
            baseline: NativeSchemaChangeBaseline::ClickHouseTable(Box::new(
                target.baseline.clone(),
            )),
            target: NativeSchemaChangeTarget::ClickHouseTableAlter(Box::new(target)),
            expected_plan_hash: plan.plan_hash,
            confirmation: confirm_destructive.then_some(NativeSchemaConfirmationInput {
                accepted: true,
                object_name: None,
                cluster_name: None,
            }),
        }
    }

    fn action_request(
        operation: SchemaMutationOperation,
        confirm_destructive: bool,
    ) -> NativeSchemaExecuteChangeRequest {
        let target = ClickHouseColumnDataActionTarget {
            baseline: baseline(),
            column_name: "payload".to_string(),
        };
        let plan = match operation {
            SchemaMutationOperation::Clear => plan_column_clear(&target).unwrap(),
            SchemaMutationOperation::Materialize => plan_column_materialize(&target).unwrap(),
            _ => unreachable!(),
        };
        let tagged = match operation {
            SchemaMutationOperation::Clear => {
                NativeSchemaChangeTarget::ClickHouseColumnClear(Box::new(target.clone()))
            }
            SchemaMutationOperation::Materialize => {
                NativeSchemaChangeTarget::ClickHouseColumnMaterialize(Box::new(target.clone()))
            }
            _ => unreachable!(),
        };
        NativeSchemaExecuteChangeRequest {
            target: tagged,
            baseline: NativeSchemaChangeBaseline::ClickHouseTable(Box::new(target.baseline)),
            expected_plan_hash: plan.plan_hash,
            confirmation: confirm_destructive.then_some(NativeSchemaConfirmationInput {
                accepted: true,
                object_name: None,
                cluster_name: None,
            }),
        }
    }

    fn timeout() -> Duration {
        Duration::from_secs(5)
    }

    fn shutdown() -> watch::Receiver<bool> {
        watch::channel(false).1
    }

    #[tokio::test]
    async fn destructive_and_drift_gates_run_before_first_statement() {
        let backend = FakeChangeBackend::new([], []);
        let error = execute_table_alter_with(
            &backend,
            &table_request(destructive_target(), false),
            timeout(),
            shutdown(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ValidationFailed);
        assert!(backend.requests().is_empty());
        assert_eq!(backend.describe_count(), 0);

        let backend =
            FakeChangeBackend::new([FakeDescribeResponse::Schema(drifted_baseline())], []);
        let error = execute_table_alter_with(
            &backend,
            &table_request(safe_target(), false),
            timeout(),
            shutdown(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceConflict);
        assert_eq!(error.runtime_impact, RuntimeErrorImpact::BusinessOnly);
        assert!(backend.requests().is_empty());
        assert_eq!(backend.describe_count(), 1);
    }

    #[tokio::test]
    async fn stale_plan_and_request_baseline_mismatch_send_nothing() {
        let mut stale = table_request(safe_target(), false);
        stale.expected_plan_hash = "0".repeat(64);
        let backend = FakeChangeBackend::new([], []);
        let error = execute_table_alter_with(&backend, &stale, timeout(), shutdown())
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ValidationFailed);
        assert!(backend.requests().is_empty());

        let mut mismatch = table_request(safe_target(), false);
        mismatch.baseline =
            NativeSchemaChangeBaseline::ClickHouseTable(Box::new(drifted_baseline()));
        let error = execute_table_alter_with(&backend, &mismatch, timeout(), shutdown())
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceConflict);
        assert!(backend.requests().is_empty());
        assert_eq!(backend.describe_count(), 0);
    }

    #[tokio::test]
    async fn executor_stops_after_first_failure_and_reports_partial_progress() {
        let target = full_target();
        let expected_statement_count = plan_alter_table(&target).unwrap().statements.len() as u32;
        let actual = actual_after_first_statement();
        let backend = FakeChangeBackend::new(
            [
                FakeDescribeResponse::Schema(baseline()),
                FakeDescribeResponse::Schema(actual.clone()),
            ],
            [
                FakeStatementResponse::Success,
                FakeStatementResponse::Error(ClickHouseError::BadResponse(
                    "Code: 44. ILLEGAL_COLUMN query=ALTER password=secret".to_string(),
                )),
            ],
        );

        let result = execute_table_alter_with(
            &backend,
            &table_request(target, true),
            timeout(),
            shutdown(),
        )
        .await
        .unwrap();

        assert_eq!(result.status, NativeSchemaExecutionStatus::PartiallyApplied);
        assert_eq!(result.progress.applied_count, 1);
        assert_eq!(result.progress.failed_statement_index, Some(1));
        assert_eq!(
            result.progress.remaining_count,
            expected_statement_count - 2
        );
        assert_eq!(result.progress.query_ids.len(), 2);
        assert_eq!(backend.requests().len(), 2);
        assert_eq!(result.schema, Some(actual));
    }

    #[tokio::test]
    async fn ambiguous_response_is_applied_only_when_post_describe_matches_target() {
        let target = safe_target();
        for (remote, expected_status) in [
            (
                schema_from_target(&target),
                NativeSchemaExecutionStatus::Applied,
            ),
            (baseline(), NativeSchemaExecutionStatus::OutcomeUnknown),
        ] {
            let backend = FakeChangeBackend::new(
                [
                    FakeDescribeResponse::Schema(baseline()),
                    FakeDescribeResponse::Schema(remote.clone()),
                ],
                [FakeStatementResponse::Error(ClickHouseError::TimedOut)],
            );
            let result = execute_table_alter_with(
                &backend,
                &table_request(target.clone(), false),
                timeout(),
                shutdown(),
            )
            .await
            .unwrap();
            assert_eq!(result.status, expected_status);
            assert_eq!(result.schema, Some(remote));
            let requests = backend.requests();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].query_id.len(), 36);
            assert!(requests[0].has_setting("wait_end_of_query", "1"));
            assert!(requests[0].has_setting("max_execution_time", "5"));
        }
    }

    #[tokio::test]
    async fn first_server_error_remains_structured_and_never_becomes_partial() {
        let backend = FakeChangeBackend::new(
            [
                FakeDescribeResponse::Schema(baseline()),
                FakeDescribeResponse::Schema(baseline()),
            ],
            [FakeStatementResponse::Error(ClickHouseError::BadResponse(
                "Code: 44. ILLEGAL_COLUMN query=ALTER password=secret".to_string(),
            ))],
        );
        let error = execute_table_alter_with(
            &backend,
            &table_request(safe_target(), false),
            timeout(),
            shutdown(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceConflict);
        assert_eq!(error.runtime_impact, RuntimeErrorImpact::BusinessOnly);
        assert!(!format!("{error:?}").contains("secret"));
        assert_eq!(backend.describe_count(), 2);
    }

    #[tokio::test]
    async fn column_actions_are_submitted_or_unknown_and_share_all_presend_gates() {
        let no_confirm = action_request(SchemaMutationOperation::Clear, false);
        let backend = FakeChangeBackend::new([], []);
        let error = execute_column_action_with(
            &backend,
            &no_confirm,
            SchemaMutationOperation::Clear,
            timeout(),
            shutdown(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ValidationFailed);
        assert!(backend.requests().is_empty());

        for (operation, response, expected_status, applied_count) in [
            (
                SchemaMutationOperation::Clear,
                FakeStatementResponse::Success,
                NativeSchemaExecutionStatus::Submitted,
                1,
            ),
            (
                SchemaMutationOperation::Materialize,
                FakeStatementResponse::Error(ClickHouseError::TimedOut),
                NativeSchemaExecutionStatus::OutcomeUnknown,
                0,
            ),
        ] {
            let backend = FakeChangeBackend::new(
                [
                    FakeDescribeResponse::Schema(baseline()),
                    FakeDescribeResponse::Schema(baseline()),
                ],
                [response],
            );
            let result = execute_column_action_with(
                &backend,
                &action_request(operation, true),
                operation,
                timeout(),
                shutdown(),
            )
            .await
            .unwrap();
            assert_eq!(result.status, expected_status);
            assert_eq!(result.progress.applied_count, applied_count);
            assert_eq!(result.operation, operation);
            assert_eq!(result.schema, Some(baseline()));
            assert_eq!(backend.requests().len(), 1);
        }
    }

    #[tokio::test]
    async fn post_describe_failure_never_synthesizes_the_desired_schema() {
        let backend = FakeChangeBackend::new(
            [
                FakeDescribeResponse::Schema(baseline()),
                FakeDescribeResponse::Error,
            ],
            [FakeStatementResponse::Success],
        );
        let result = execute_table_alter_with(
            &backend,
            &table_request(safe_target(), false),
            timeout(),
            shutdown(),
        )
        .await
        .unwrap();
        assert_eq!(result.status, NativeSchemaExecutionStatus::OutcomeUnknown);
        assert_eq!(result.schema, None);
    }
}
