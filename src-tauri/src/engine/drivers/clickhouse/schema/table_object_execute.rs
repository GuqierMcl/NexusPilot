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

use super::change_runtime::{
    execute_statement_once, validate_native_schema_confirmation, validate_plan_hash,
    validate_remote_baseline, validate_request_table_baseline, ChangeBackend, ChangeCommandRequest,
    DriverChangeBackend, StatementOutcome,
};
use super::change_types::{
    ClickHouseProjectionChangeResult, ClickHouseProjectionTarget,
    ClickHouseSkippingIndexChangeResult, ClickHouseSkippingIndexTarget,
};
use super::schema_compare::{
    projection_is_absent, projection_matches, skipping_index_is_absent, skipping_index_matches,
};
use super::table_object_render::{plan_projection_change, plan_skipping_index_change};
use super::types::ClickHouseTableSchema;

pub(super) async fn execute_projection_change(
    driver: &ClickHouseDriver,
    request: &NativeSchemaExecuteChangeRequest,
) -> IpcResult<ClickHouseProjectionChangeResult> {
    execute_projection_change_with(
        &DriverChangeBackend::new(driver),
        request,
        driver.timeout,
        driver.shutdown.subscribe(),
    )
    .await
}

pub(super) async fn execute_skipping_index_change(
    driver: &ClickHouseDriver,
    request: &NativeSchemaExecuteChangeRequest,
) -> IpcResult<ClickHouseSkippingIndexChangeResult> {
    execute_skipping_index_change_with(
        &DriverChangeBackend::new(driver),
        request,
        driver.timeout,
        driver.shutdown.subscribe(),
    )
    .await
}

async fn execute_projection_change_with(
    backend: &(impl ChangeBackend + ?Sized),
    request: &NativeSchemaExecuteChangeRequest,
    timeout: Duration,
    shutdown: watch::Receiver<bool>,
) -> IpcResult<ClickHouseProjectionChangeResult> {
    let change = projection_change(&request.target)?;
    let execution = execute_object_change_with(
        backend,
        request,
        timeout,
        shutdown,
        TableObjectFamily::Projection,
        &change,
    )
    .await?;
    Ok(ClickHouseProjectionChangeResult {
        status: execution.status,
        progress: execution.progress,
        container: execution.container,
        projection_name: change.name.to_string(),
        operation: change.operation,
        schema: execution.schema,
    })
}

async fn execute_skipping_index_change_with(
    backend: &(impl ChangeBackend + ?Sized),
    request: &NativeSchemaExecuteChangeRequest,
    timeout: Duration,
    shutdown: watch::Receiver<bool>,
) -> IpcResult<ClickHouseSkippingIndexChangeResult> {
    let change = skipping_index_change(&request.target)?;
    let execution = execute_object_change_with(
        backend,
        request,
        timeout,
        shutdown,
        TableObjectFamily::SkippingIndex,
        &change,
    )
    .await?;
    Ok(ClickHouseSkippingIndexChangeResult {
        status: execution.status,
        progress: execution.progress,
        container: execution.container,
        index_name: change.name.to_string(),
        operation: change.operation,
        schema: execution.schema,
    })
}

#[derive(Clone, Copy)]
enum TableObjectFamily {
    Projection,
    SkippingIndex,
}

enum TableObjectDefinition<'a> {
    Projection(&'a ClickHouseProjectionTarget),
    SkippingIndex(&'a ClickHouseSkippingIndexTarget),
    None,
}

struct TableObjectChange<'a> {
    baseline: &'a ClickHouseTableSchema,
    name: &'a str,
    operation: SchemaMutationOperation,
    definition: TableObjectDefinition<'a>,
}

struct TableObjectExecution {
    status: NativeSchemaExecutionStatus,
    progress: NativeSchemaStatementProgress,
    container: ContainerRef,
    schema: Option<ClickHouseTableSchema>,
}

async fn execute_object_change_with(
    backend: &(impl ChangeBackend + ?Sized),
    request: &NativeSchemaExecuteChangeRequest,
    timeout: Duration,
    shutdown: watch::Receiver<bool>,
    family: TableObjectFamily,
    change: &TableObjectChange<'_>,
) -> IpcResult<TableObjectExecution> {
    let plan = match family {
        TableObjectFamily::Projection => plan_projection_change(&request.target)?,
        TableObjectFamily::SkippingIndex => plan_skipping_index_change(&request.target)?,
    };
    validate_plan_hash(&plan.plan_hash, &request.expected_plan_hash)?;
    validate_request_table_baseline(&request.baseline, change.baseline)?;
    validate_native_schema_confirmation(
        plan.required_confirmation,
        request.confirmation.as_ref(),
        change.name,
        None,
    )?;

    let container = ContainerRef::table(
        ContainerKind::Table,
        &change.baseline.identity.database,
        None,
        &change.baseline.identity.name,
    );
    validate_remote_baseline(backend, &container, change.baseline).await?;

    let [statement] = plan.statements.as_slice() else {
        return Err(IpcError::system_internal(
            "ClickHouse table-object plan must contain exactly one statement",
            "operation=table_object_change; category=invalid_plan_statement_count",
        ));
    };
    let operation = operation_category(family, change.operation);
    let command = ChangeCommandRequest::new(statement.clone(), timeout);
    let outcome = execute_statement_once(backend, &command, operation, shutdown, timeout).await;
    let acknowledged = match outcome {
        StatementOutcome::Acknowledged => true,
        StatementOutcome::Ambiguous => false,
        StatementOutcome::Failed(error) => {
            let _ = backend.describe_table(&container).await;
            return Err(error);
        }
        StatementOutcome::CanceledBeforeSend(error) => return Err(error),
    };
    let remote = backend.describe_table(&container).await;
    let is_metadata_change = matches!(
        change.operation,
        SchemaMutationOperation::Create | SchemaMutationOperation::Drop
    );
    let (status, schema) = if !is_metadata_change {
        if acknowledged {
            (NativeSchemaExecutionStatus::Submitted, remote.ok())
        } else {
            (NativeSchemaExecutionStatus::OutcomeUnknown, remote.ok())
        }
    } else {
        match remote {
            Ok(schema) if object_change_is_proven(family, change, &schema) => {
                (NativeSchemaExecutionStatus::Applied, Some(schema))
            }
            Ok(schema) if acknowledged => {
                (NativeSchemaExecutionStatus::PartiallyApplied, Some(schema))
            }
            Ok(schema) => (NativeSchemaExecutionStatus::OutcomeUnknown, Some(schema)),
            Err(_) => (NativeSchemaExecutionStatus::OutcomeUnknown, None),
        }
    };
    let applied_count = if acknowledged || status == NativeSchemaExecutionStatus::Applied {
        1
    } else {
        0
    };

    Ok(TableObjectExecution {
        status,
        progress: NativeSchemaStatementProgress {
            applied_count,
            failed_statement_index: None,
            remaining_count: 0,
            query_ids: vec![command.query_id],
        },
        container,
        schema,
    })
}

fn operation_category(
    family: TableObjectFamily,
    operation: SchemaMutationOperation,
) -> &'static str {
    match (family, operation) {
        (TableObjectFamily::Projection, SchemaMutationOperation::Create) => "projection create",
        (TableObjectFamily::Projection, SchemaMutationOperation::Drop) => "projection drop",
        (TableObjectFamily::Projection, SchemaMutationOperation::Materialize) => {
            "projection materialize"
        }
        (TableObjectFamily::Projection, SchemaMutationOperation::Clear) => "projection clear",
        (TableObjectFamily::SkippingIndex, SchemaMutationOperation::Create) => {
            "skipping-index create"
        }
        (TableObjectFamily::SkippingIndex, SchemaMutationOperation::Drop) => "skipping-index drop",
        (TableObjectFamily::SkippingIndex, SchemaMutationOperation::Materialize) => {
            "skipping-index materialize"
        }
        (TableObjectFamily::SkippingIndex, SchemaMutationOperation::Clear) => {
            "skipping-index clear"
        }
        _ => "table-object change",
    }
}

fn projection_change(target: &NativeSchemaChangeTarget) -> IpcResult<TableObjectChange<'_>> {
    match target {
        NativeSchemaChangeTarget::ClickHouseProjectionCreate(target) => Ok(TableObjectChange {
            baseline: &target.baseline,
            name: &target.projection.name,
            operation: SchemaMutationOperation::Create,
            definition: TableObjectDefinition::Projection(&target.projection),
        }),
        NativeSchemaChangeTarget::ClickHouseProjectionDrop(target) => Ok(TableObjectChange {
            baseline: &target.baseline,
            name: &target.projection_name,
            operation: SchemaMutationOperation::Drop,
            definition: TableObjectDefinition::None,
        }),
        NativeSchemaChangeTarget::ClickHouseProjectionMaterialize(target) => {
            Ok(TableObjectChange {
                baseline: &target.baseline,
                name: &target.projection_name,
                operation: SchemaMutationOperation::Materialize,
                definition: TableObjectDefinition::None,
            })
        }
        NativeSchemaChangeTarget::ClickHouseProjectionClear(target) => Ok(TableObjectChange {
            baseline: &target.baseline,
            name: &target.projection_name,
            operation: SchemaMutationOperation::Clear,
            definition: TableObjectDefinition::None,
        }),
        _ => Err(IpcError::validation_failed(
            "ClickHouse projection executor requires a projection target",
        )),
    }
}

fn skipping_index_change(target: &NativeSchemaChangeTarget) -> IpcResult<TableObjectChange<'_>> {
    match target {
        NativeSchemaChangeTarget::ClickHouseSkippingIndexCreate(target) => Ok(TableObjectChange {
            baseline: &target.baseline,
            name: &target.index.name,
            operation: SchemaMutationOperation::Create,
            definition: TableObjectDefinition::SkippingIndex(&target.index),
        }),
        NativeSchemaChangeTarget::ClickHouseSkippingIndexDrop(target) => Ok(TableObjectChange {
            baseline: &target.baseline,
            name: &target.index_name,
            operation: SchemaMutationOperation::Drop,
            definition: TableObjectDefinition::None,
        }),
        NativeSchemaChangeTarget::ClickHouseSkippingIndexMaterialize(target) => {
            Ok(TableObjectChange {
                baseline: &target.baseline,
                name: &target.index_name,
                operation: SchemaMutationOperation::Materialize,
                definition: TableObjectDefinition::None,
            })
        }
        NativeSchemaChangeTarget::ClickHouseSkippingIndexClear(target) => Ok(TableObjectChange {
            baseline: &target.baseline,
            name: &target.index_name,
            operation: SchemaMutationOperation::Clear,
            definition: TableObjectDefinition::None,
        }),
        _ => Err(IpcError::validation_failed(
            "ClickHouse skipping-index executor requires a skipping-index target",
        )),
    }
}

fn object_change_is_proven(
    family: TableObjectFamily,
    change: &TableObjectChange<'_>,
    schema: &ClickHouseTableSchema,
) -> bool {
    match (&change.definition, change.operation) {
        (TableObjectDefinition::Projection(expected), SchemaMutationOperation::Create) => schema
            .projections
            .iter()
            .find(|projection| projection.name == change.name)
            .is_some_and(|actual| projection_matches(expected, actual)),
        (TableObjectDefinition::SkippingIndex(expected), SchemaMutationOperation::Create) => schema
            .skipping_indexes
            .iter()
            .find(|index| index.name == change.name)
            .is_some_and(|actual| skipping_index_matches(expected, actual)),
        (TableObjectDefinition::None, SchemaMutationOperation::Drop) => match family {
            TableObjectFamily::Projection => projection_is_absent(change.name, schema),
            TableObjectFamily::SkippingIndex => skipping_index_is_absent(change.name, schema),
        },
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;
    use std::time::Duration;

    use async_trait::async_trait;
    use clickhouse::error::Error as ClickHouseError;
    use tokio::sync::watch;

    use super::*;
    use crate::engine::drivers::clickhouse::schema::change_runtime::{
        ChangeBackend, ChangeCommandRequest,
    };
    use crate::engine::drivers::clickhouse::schema::table_object_render::{
        plan_projection_change, plan_skipping_index_change,
    };
    use crate::engine::drivers::clickhouse::schema::types::fixture_schema;
    use crate::engine::drivers::clickhouse::schema::{
        ClickHouseProjectionActionTarget, ClickHouseProjectionCreateTarget,
        ClickHouseProjectionSchema, ClickHouseProjectionTarget, ClickHouseSchemaEditability,
        ClickHouseSkippingIndexActionTarget, ClickHouseSkippingIndexCreateTarget,
        ClickHouseSkippingIndexSchema, ClickHouseSkippingIndexTarget, ClickHouseTableSchema,
    };
    use crate::engine::native_schema::{
        NativeSchemaChangeBaseline, NativeSchemaChangeTarget, NativeSchemaConfirmationInput,
        NativeSchemaExecuteChangeRequest, NativeSchemaExecutionStatus,
    };
    use crate::engine::types::{ContainerRef, SchemaMutationOperation};
    use crate::error::{ErrorCode, IpcError, IpcResult, RuntimeErrorImpact};

    #[derive(Clone, Copy)]
    enum FakeStatementResponse {
        Acknowledge,
        Ambiguous,
        Fail,
    }

    struct FakeBackend {
        statement_response: FakeStatementResponse,
        statements: Mutex<Vec<ChangeCommandRequest>>,
        describes: Mutex<VecDeque<IpcResult<ClickHouseTableSchema>>>,
    }

    impl FakeBackend {
        fn new(
            statement_response: FakeStatementResponse,
            describes: impl IntoIterator<Item = IpcResult<ClickHouseTableSchema>>,
        ) -> Self {
            Self {
                statement_response,
                statements: Mutex::new(Vec::new()),
                describes: Mutex::new(describes.into_iter().collect()),
            }
        }

        fn statement_count(&self) -> usize {
            self.statements.lock().unwrap().len()
        }

        fn describe_count(&self) -> usize {
            self.describes.lock().unwrap().len()
        }
    }

    #[async_trait]
    impl ChangeBackend for FakeBackend {
        async fn execute_statement(
            &self,
            request: &ChangeCommandRequest,
        ) -> Result<(), ClickHouseError> {
            self.statements.lock().unwrap().push(request.clone());
            match self.statement_response {
                FakeStatementResponse::Acknowledge => Ok(()),
                FakeStatementResponse::Ambiguous => Err(ClickHouseError::TimedOut),
                FakeStatementResponse::Fail => Err(ClickHouseError::BadResponse(
                    "Code: 62. query=ALTER TABLE analytics.events password=secret".to_string(),
                )),
            }
        }

        async fn describe_table(
            &self,
            _container: &ContainerRef,
        ) -> IpcResult<ClickHouseTableSchema> {
            self.describes
                .lock()
                .unwrap()
                .pop_front()
                .expect("queued describe response")
        }
    }

    fn projection_create_target() -> NativeSchemaChangeTarget {
        NativeSchemaChangeTarget::ClickHouseProjectionCreate(Box::new(
            ClickHouseProjectionCreateTarget {
                baseline: fixture_schema(),
                projection: ClickHouseProjectionTarget {
                    name: "by_tenant".to_string(),
                    query: "SELECT tenant_id, count() GROUP BY tenant_id".to_string(),
                },
            },
        ))
    }

    fn projection_action_target(operation: SchemaMutationOperation) -> NativeSchemaChangeTarget {
        let target = Box::new(ClickHouseProjectionActionTarget {
            baseline: fixture_schema(),
            projection_name: "a_projection".to_string(),
        });
        match operation {
            SchemaMutationOperation::Drop => {
                NativeSchemaChangeTarget::ClickHouseProjectionDrop(target)
            }
            SchemaMutationOperation::Materialize => {
                NativeSchemaChangeTarget::ClickHouseProjectionMaterialize(target)
            }
            SchemaMutationOperation::Clear => {
                NativeSchemaChangeTarget::ClickHouseProjectionClear(target)
            }
            _ => unreachable!("unsupported projection action fixture"),
        }
    }

    fn skipping_index_create_target() -> NativeSchemaChangeTarget {
        NativeSchemaChangeTarget::ClickHouseSkippingIndexCreate(Box::new(
            ClickHouseSkippingIndexCreateTarget {
                baseline: fixture_schema(),
                index: ClickHouseSkippingIndexTarget {
                    name: "payload_bf".to_string(),
                    expression: "payload".to_string(),
                    index_type: "tokenbf_v1".to_string(),
                    type_arguments: vec!["256".to_string(), "2".to_string(), "0".to_string()],
                    granularity: 1,
                },
            },
        ))
    }

    fn skipping_index_action_target(
        operation: SchemaMutationOperation,
    ) -> NativeSchemaChangeTarget {
        let target = Box::new(ClickHouseSkippingIndexActionTarget {
            baseline: fixture_schema(),
            index_name: "a_index".to_string(),
        });
        match operation {
            SchemaMutationOperation::Drop => {
                NativeSchemaChangeTarget::ClickHouseSkippingIndexDrop(target)
            }
            SchemaMutationOperation::Materialize => {
                NativeSchemaChangeTarget::ClickHouseSkippingIndexMaterialize(target)
            }
            SchemaMutationOperation::Clear => {
                NativeSchemaChangeTarget::ClickHouseSkippingIndexClear(target)
            }
            _ => unreachable!("unsupported index action fixture"),
        }
    }

    fn request(
        target: NativeSchemaChangeTarget,
        confirmed: bool,
    ) -> NativeSchemaExecuteChangeRequest {
        let plan = match &target {
            NativeSchemaChangeTarget::ClickHouseProjectionCreate(_)
            | NativeSchemaChangeTarget::ClickHouseProjectionDrop(_)
            | NativeSchemaChangeTarget::ClickHouseProjectionMaterialize(_)
            | NativeSchemaChangeTarget::ClickHouseProjectionClear(_) => {
                plan_projection_change(&target).unwrap()
            }
            _ => plan_skipping_index_change(&target).unwrap(),
        };
        NativeSchemaExecuteChangeRequest {
            target,
            baseline: plan.baseline,
            expected_plan_hash: plan.plan_hash,
            confirmation: confirmed.then_some(NativeSchemaConfirmationInput {
                accepted: true,
                object_name: None,
                cluster_name: None,
            }),
        }
    }

    fn shutdown() -> watch::Receiver<bool> {
        watch::channel(false).1
    }

    fn schema_with_projection() -> ClickHouseTableSchema {
        let mut schema = fixture_schema();
        schema.projections.push(ClickHouseProjectionSchema {
            name: "by_tenant".to_string(),
            query: "SELECT tenant_id, count() GROUP BY tenant_id".to_string(),
            editability: ClickHouseSchemaEditability::editable(),
        });
        schema
    }

    fn schema_without_projection() -> ClickHouseTableSchema {
        let mut schema = fixture_schema();
        schema
            .projections
            .retain(|projection| projection.name != "a_projection");
        schema
    }

    fn schema_with_index() -> ClickHouseTableSchema {
        let mut schema = fixture_schema();
        schema.skipping_indexes.push(ClickHouseSkippingIndexSchema {
            name: "payload_bf".to_string(),
            expression: "payload".to_string(),
            index_type: "tokenbf_v1".to_string(),
            type_arguments: vec!["256".to_string(), "2".to_string(), "0".to_string()],
            granularity: Some(1),
            editability: ClickHouseSchemaEditability::editable(),
        });
        schema
    }

    fn schema_without_index() -> ClickHouseTableSchema {
        let mut schema = fixture_schema();
        schema
            .skipping_indexes
            .retain(|index| index.name != "a_index");
        schema
    }

    #[tokio::test]
    async fn all_presend_gates_reject_without_sending_a_statement() {
        let mut stale = request(projection_create_target(), false);
        stale.expected_plan_hash = "stale".to_string();
        let backend = FakeBackend::new(FakeStatementResponse::Acknowledge, []);
        assert_eq!(
            execute_projection_change_with(&backend, &stale, Duration::from_secs(1), shutdown())
                .await
                .unwrap_err()
                .code,
            ErrorCode::ValidationFailed
        );
        assert_eq!(backend.statement_count(), 0);

        let mut mismatched = request(projection_create_target(), false);
        let mut drifted = fixture_schema();
        drifted.comment = Some("request drift".to_string());
        mismatched.baseline = NativeSchemaChangeBaseline::ClickHouseTable(Box::new(drifted));
        let backend = FakeBackend::new(FakeStatementResponse::Acknowledge, []);
        assert_eq!(
            execute_projection_change_with(
                &backend,
                &mismatched,
                Duration::from_secs(1),
                shutdown(),
            )
            .await
            .unwrap_err()
            .code,
            ErrorCode::ResourceConflict
        );
        assert_eq!(backend.statement_count(), 0);

        let mut remote_drift = fixture_schema();
        remote_drift.comment = Some("remote drift".to_string());
        let backend = FakeBackend::new(FakeStatementResponse::Acknowledge, [Ok(remote_drift)]);
        assert_eq!(
            execute_projection_change_with(
                &backend,
                &request(projection_create_target(), false),
                Duration::from_secs(1),
                shutdown(),
            )
            .await
            .unwrap_err()
            .code,
            ErrorCode::ResourceConflict
        );
        assert_eq!(backend.statement_count(), 0);

        let backend = FakeBackend::new(FakeStatementResponse::Acknowledge, []);
        assert_eq!(
            execute_skipping_index_change_with(
                &backend,
                &request(
                    skipping_index_action_target(SchemaMutationOperation::Drop),
                    false,
                ),
                Duration::from_secs(1),
                shutdown(),
            )
            .await
            .unwrap_err()
            .code,
            ErrorCode::ValidationFailed
        );
        assert_eq!(backend.statement_count(), 0);
        assert_eq!(backend.describe_count(), 0);
    }

    #[tokio::test]
    async fn acknowledged_create_and_drop_require_exact_post_describe_proof() {
        let backend = FakeBackend::new(
            FakeStatementResponse::Acknowledge,
            [Ok(fixture_schema()), Ok(schema_with_projection())],
        );
        let result = execute_projection_change_with(
            &backend,
            &request(projection_create_target(), false),
            Duration::from_secs(1),
            shutdown(),
        )
        .await
        .unwrap();
        assert_eq!(result.status, NativeSchemaExecutionStatus::Applied);
        assert_eq!(result.progress.applied_count, 1);

        let backend = FakeBackend::new(
            FakeStatementResponse::Acknowledge,
            [Ok(fixture_schema()), Ok(fixture_schema())],
        );
        let result = execute_skipping_index_change_with(
            &backend,
            &request(skipping_index_create_target(), false),
            Duration::from_secs(1),
            shutdown(),
        )
        .await
        .unwrap();
        assert_eq!(result.status, NativeSchemaExecutionStatus::PartiallyApplied);
        assert_eq!(result.schema, Some(fixture_schema()));

        let backend = FakeBackend::new(
            FakeStatementResponse::Acknowledge,
            [
                Ok(fixture_schema()),
                Err(IpcError::resource_not_found("post describe unavailable")),
            ],
        );
        let result = execute_projection_change_with(
            &backend,
            &request(projection_create_target(), false),
            Duration::from_secs(1),
            shutdown(),
        )
        .await
        .unwrap();
        assert_eq!(result.status, NativeSchemaExecutionStatus::OutcomeUnknown);
        assert_eq!(result.schema, None);

        let backend = FakeBackend::new(
            FakeStatementResponse::Acknowledge,
            [Ok(fixture_schema()), Ok(schema_without_projection())],
        );
        let result = execute_projection_change_with(
            &backend,
            &request(
                projection_action_target(SchemaMutationOperation::Drop),
                true,
            ),
            Duration::from_secs(1),
            shutdown(),
        )
        .await
        .unwrap();
        assert_eq!(result.status, NativeSchemaExecutionStatus::Applied);

        let backend = FakeBackend::new(
            FakeStatementResponse::Acknowledge,
            [Ok(fixture_schema()), Ok(schema_without_index())],
        );
        let result = execute_skipping_index_change_with(
            &backend,
            &request(
                skipping_index_action_target(SchemaMutationOperation::Drop),
                true,
            ),
            Duration::from_secs(1),
            shutdown(),
        )
        .await
        .unwrap();
        assert_eq!(result.status, NativeSchemaExecutionStatus::Applied);
    }

    #[tokio::test]
    async fn acknowledged_actions_are_submitted_even_when_schema_is_unchanged() {
        for target in [
            projection_action_target(SchemaMutationOperation::Materialize),
            projection_action_target(SchemaMutationOperation::Clear),
        ] {
            let backend = FakeBackend::new(
                FakeStatementResponse::Acknowledge,
                [Ok(fixture_schema()), Ok(fixture_schema())],
            );
            let result = execute_projection_change_with(
                &backend,
                &request(target, true),
                Duration::from_secs(1),
                shutdown(),
            )
            .await
            .unwrap();
            assert_eq!(result.status, NativeSchemaExecutionStatus::Submitted);
            assert_eq!(result.progress.applied_count, 1);
        }

        for target in [
            skipping_index_action_target(SchemaMutationOperation::Materialize),
            skipping_index_action_target(SchemaMutationOperation::Clear),
        ] {
            let backend = FakeBackend::new(
                FakeStatementResponse::Acknowledge,
                [Ok(fixture_schema()), Ok(fixture_schema())],
            );
            let result = execute_skipping_index_change_with(
                &backend,
                &request(target, true),
                Duration::from_secs(1),
                shutdown(),
            )
            .await
            .unwrap();
            assert_eq!(result.status, NativeSchemaExecutionStatus::Submitted);
        }
    }

    #[tokio::test]
    async fn ambiguous_results_require_proof_and_actions_remain_unknown() {
        let backend = FakeBackend::new(
            FakeStatementResponse::Ambiguous,
            [Ok(fixture_schema()), Ok(schema_with_index())],
        );
        let result = execute_skipping_index_change_with(
            &backend,
            &request(skipping_index_create_target(), false),
            Duration::from_secs(1),
            shutdown(),
        )
        .await
        .unwrap();
        assert_eq!(result.status, NativeSchemaExecutionStatus::Applied);

        let backend = FakeBackend::new(
            FakeStatementResponse::Ambiguous,
            [Ok(fixture_schema()), Ok(fixture_schema())],
        );
        let result = execute_projection_change_with(
            &backend,
            &request(projection_create_target(), false),
            Duration::from_secs(1),
            shutdown(),
        )
        .await
        .unwrap();
        assert_eq!(result.status, NativeSchemaExecutionStatus::OutcomeUnknown);

        let backend = FakeBackend::new(
            FakeStatementResponse::Ambiguous,
            [Ok(fixture_schema()), Ok(fixture_schema())],
        );
        let result = execute_skipping_index_change_with(
            &backend,
            &request(
                skipping_index_action_target(SchemaMutationOperation::Clear),
                true,
            ),
            Duration::from_secs(1),
            shutdown(),
        )
        .await
        .unwrap();
        assert_eq!(result.status, NativeSchemaExecutionStatus::OutcomeUnknown);
    }

    #[tokio::test]
    async fn server_failure_is_not_retried_and_preserves_structured_impact() {
        let backend = FakeBackend::new(
            FakeStatementResponse::Fail,
            [Ok(fixture_schema()), Ok(fixture_schema())],
        );
        let error = execute_projection_change_with(
            &backend,
            &request(projection_create_target(), false),
            Duration::from_secs(1),
            shutdown(),
        )
        .await
        .unwrap_err();
        assert_eq!(backend.statement_count(), 1);
        assert_eq!(error.code, ErrorCode::QuerySyntaxError);
        assert_eq!(error.runtime_impact, RuntimeErrorImpact::BusinessOnly);
        let diagnostic = format!("{error:?}");
        assert!(!diagnostic.contains("analytics.events"));
        assert!(!diagnostic.contains("secret"));
    }
}
