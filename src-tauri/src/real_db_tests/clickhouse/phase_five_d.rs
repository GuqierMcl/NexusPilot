use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use clickhouse::Client;
use serde::Deserialize;

use crate::engine::drivers::clickhouse::schema::{
    ClickHouseProjectionActionTarget, ClickHouseProjectionCreateTarget, ClickHouseProjectionTarget,
    ClickHouseSchemaEditabilityMode, ClickHouseSkippingIndexActionTarget,
    ClickHouseSkippingIndexCreateTarget, ClickHouseSkippingIndexTarget, ClickHouseTableSchema,
};
use crate::engine::manager::ConnectionRuntimeManager;
use crate::engine::native_schema::{
    NativeSchemaChangePlan, NativeSchemaChangeResult, NativeSchemaChangeTarget,
    NativeSchemaConfirmationInput, NativeSchemaDescribeRequest, NativeSchemaDocument,
    NativeSchemaExecuteChangeRequest, NativeSchemaExecutionStatus, NativeSchemaExtension,
};
use crate::engine::registry::DriverRegistry;
use crate::engine::types::{
    ContainerKind, ContainerRef, DriverCapabilities, SchemaMutationOperation,
};
use crate::error::{ErrorCode, IpcError, IpcResult};
use crate::repository::connection_repository::StoredConnectionRecord;

use super::phase_five_a::{is_lowercase_sha256, quote_identifier};

const TABLE_NAME: &str = "object_matrix";
const PROJECTION_AGGREGATE: &str = "by_tenant_aggregate";
const PROJECTION_ORDERED: &str = "by_tenant_ordered";
const INDEX_MINMAX: &str = "tenant_minmax";
const INDEX_SET: &str = "tenant_set";
const INDEX_BLOOM: &str = "message_bloom";
const INDEX_NGRAM: &str = "message_ngram";
const INDEX_TOKEN: &str = "message_token";

static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(clickhouse::Row, Deserialize)]
struct CountRow {
    count: u64,
}

#[derive(clickhouse::Row, Deserialize)]
struct VersionRow {
    version: String,
}

#[derive(Clone, Copy)]
struct ProjectionDefinition {
    name: &'static str,
    query: &'static str,
}

#[derive(Clone, Copy)]
struct IndexDefinition {
    name: &'static str,
    expression: &'static str,
    index_type: &'static str,
    type_arguments: &'static [&'static str],
    granularity: u64,
}

const PROJECTIONS: [ProjectionDefinition; 2] = [
    ProjectionDefinition {
        name: PROJECTION_AGGREGATE,
        query: "SELECT tenant_id, count() GROUP BY tenant_id",
    },
    ProjectionDefinition {
        name: PROJECTION_ORDERED,
        query: "SELECT id, tenant_id, message ORDER BY tenant_id, id",
    },
];

const INDEXES: [IndexDefinition; 5] = [
    IndexDefinition {
        name: INDEX_MINMAX,
        expression: "tenant_id",
        index_type: "minmax",
        type_arguments: &[],
        granularity: 1,
    },
    IndexDefinition {
        name: INDEX_SET,
        expression: "tenant_id",
        index_type: "set",
        type_arguments: &["100"],
        granularity: 1,
    },
    IndexDefinition {
        name: INDEX_BLOOM,
        expression: "message",
        index_type: "bloom_filter",
        type_arguments: &["0.01"],
        granularity: 1,
    },
    IndexDefinition {
        name: INDEX_NGRAM,
        expression: "message",
        index_type: "ngrambf_v1",
        type_arguments: &["3", "256", "2", "0"],
        granularity: 1,
    },
    IndexDefinition {
        name: INDEX_TOKEN,
        expression: "message",
        index_type: "tokenbf_v1",
        type_arguments: &["256", "2", "0"],
        granularity: 1,
    },
];

struct PhaseFiveDCleanupGuard {
    database_name: String,
    table_name: String,
    scratch_prefix: String,
}

impl PhaseFiveDCleanupGuard {
    fn new(database_name: String, table_name: &str, scratch_prefix: &str) -> IpcResult<Self> {
        cleanup_statements(&database_name, table_name, scratch_prefix)?;
        Ok(Self {
            database_name,
            table_name: table_name.to_string(),
            scratch_prefix: scratch_prefix.to_string(),
        })
    }

    async fn cleanup(&self, client: &Client) -> IpcResult<()> {
        let statements =
            cleanup_statements(&self.database_name, &self.table_name, &self.scratch_prefix)?;
        let mut failures = 0usize;
        for statement in statements {
            if client.query(&statement).execute().await.is_err() {
                failures += 1;
            }
        }
        if failures > 0 {
            return Err(checkpoint_error(
                "ClickHouse Phase 5D fixture cleanup failed",
                format!("checkpoint=phase_five_d; failed_cleanup_statements={failures}"),
            ));
        }
        ensure(
            !database_exists(client, &self.database_name).await?,
            "ClickHouse Phase 5D scratch database remained after cleanup",
            "assertion=cleanup_absence",
        )
    }
}

pub(super) struct PhaseFiveDEvidence {
    pub server_version: String,
    pub projections_created: usize,
    pub index_types_created: usize,
    pub destructive_rejections: usize,
    pub submitted_actions: usize,
    pub drift_conflicts: usize,
    pub unsupported_rejections: usize,
    pub projections_dropped: usize,
    pub indexes_dropped: usize,
}

impl PhaseFiveDEvidence {
    pub(super) fn validate_counts(&self) -> IpcResult<()> {
        ensure(
            !self.server_version.trim().is_empty()
                && self.projections_created == PROJECTIONS.len()
                && self.index_types_created == INDEXES.len()
                && self.destructive_rejections >= 11
                && self.submitted_actions == 4
                && self.drift_conflicts >= 1
                && self.unsupported_rejections >= 5
                && self.projections_dropped == PROJECTIONS.len()
                && self.indexes_dropped == INDEXES.len(),
            "ClickHouse Phase 5D evidence matrix was incomplete",
            "assertion=nonzero_evidence",
        )
    }

    pub(super) fn marker(&self) -> String {
        self.marker_with_prefix("ClickHouse Phase 5D direct object checkpoint passed")
    }

    pub(super) fn manager_marker(&self) -> String {
        self.marker_with_prefix("ClickHouse Phase 5D Manager-gated object checkpoint passed")
    }

    fn marker_with_prefix(&self, prefix: &str) -> String {
        format!(
            "{prefix}: server={}; projections_created={}; index_types_created={}; destructive_rejections={}; submitted_actions={}; drift_conflicts={}; unsupported_rejections={}; projections_dropped={}; indexes_dropped={}",
            self.server_version,
            self.projections_created,
            self.index_types_created,
            self.destructive_rejections,
            self.submitted_actions,
            self.drift_conflicts,
            self.unsupported_rejections,
            self.projections_dropped,
            self.indexes_dropped,
        )
    }
}

pub(super) fn unique_database_name(prefix: &str) -> IpcResult<String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| {
            checkpoint_error(
                "ClickHouse Phase 5D fixture clock was invalid",
                "checkpoint=phase_five_d; operation=fixture_identity",
            )
        })?
        .as_millis();
    let sequence = FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let name = format!("{prefix}phase5d_{timestamp}_{sequence}");
    validate_database_scope(&name, prefix)?;
    Ok(name)
}

pub(super) fn validate_database_scope(database_name: &str, prefix: &str) -> IpcResult<()> {
    let prefix_is_identifier = prefix
        .chars()
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && prefix
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_');
    ensure(
        prefix_is_identifier
            && database_name.starts_with(&format!("{prefix}phase5d_"))
            && database_name.len() > prefix.len() + "phase5d_".len()
            && database_name
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_'),
        "ClickHouse Phase 5D refused an out-of-scope cleanup target",
        "assertion=scratch_prefix_scope",
    )
}

pub(super) fn cleanup_statements(
    database_name: &str,
    table_name: &str,
    prefix: &str,
) -> IpcResult<Vec<String>> {
    validate_database_scope(database_name, prefix)?;
    ensure(
        !table_name.is_empty()
            && table_name
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_'),
        "ClickHouse Phase 5D refused an invalid cleanup table",
        "assertion=cleanup_table_scope",
    )?;
    Ok(vec![
        format!(
            "DROP TABLE IF EXISTS {}.{}",
            quote_identifier(database_name),
            quote_identifier(table_name),
        ),
        format!(
            "DROP DATABASE IF EXISTS {}",
            quote_identifier(database_name)
        ),
    ])
}

pub(super) fn validate_capability_closed(capabilities: &DriverCapabilities) -> IpcResult<()> {
    let mutation = capabilities.schema_mutation.as_ref().ok_or_else(|| {
        checkpoint_error(
            "ClickHouse Phase 5D checkpoint expected a native schema capability",
            "checkpoint=phase_five_d; assertion=schema_mutation_present",
        )
    })?;
    let exact_phase_five_c = mutation.objects.len() == 3
        && mutation.objects.iter().any(|object| {
            object.kind == ContainerKind::Database
                && object.operations
                    == [
                        SchemaMutationOperation::Create,
                        SchemaMutationOperation::Drop,
                    ]
        })
        && mutation.objects.iter().any(|object| {
            object.kind == ContainerKind::Table
                && object.operations
                    == [
                        SchemaMutationOperation::Create,
                        SchemaMutationOperation::Alter,
                        SchemaMutationOperation::Drop,
                    ]
        })
        && mutation.objects.iter().any(|object| {
            object.kind == ContainerKind::Column
                && object.operations
                    == [
                        SchemaMutationOperation::Clear,
                        SchemaMutationOperation::Materialize,
                    ]
        });
    let object_operations_closed = [ContainerKind::Projection, ContainerKind::Index]
        .into_iter()
        .all(|kind| {
            [
                SchemaMutationOperation::Create,
                SchemaMutationOperation::Drop,
                SchemaMutationOperation::Clear,
                SchemaMutationOperation::Materialize,
            ]
            .into_iter()
            .all(|operation| !mutation.supports(kind.clone(), operation))
        });
    ensure(
        !capabilities.schema_mutator
            && exact_phase_five_c
            && object_operations_closed
            && mutation.ddl_preview
            && mutation.destructive_confirmation
            && mutation.remote_drift_protection,
        "ClickHouse Phase 5D capability opened before its Direct real gate",
        "assertion=phase_five_c_exact_matrix",
    )
}

pub(super) fn validate_capability_published(capabilities: &DriverCapabilities) -> IpcResult<()> {
    let mutation = capabilities.schema_mutation.as_ref().ok_or_else(|| {
        checkpoint_error(
            "ClickHouse Phase 5D checkpoint expected a native schema capability",
            "checkpoint=phase_five_d; assertion=schema_mutation_present",
        )
    })?;
    let phase_five_d_objects = mutation.objects.iter().any(|object| {
        object.kind == ContainerKind::Database
            && object.operations
                == [
                    SchemaMutationOperation::Create,
                    SchemaMutationOperation::Drop,
                ]
    }) && mutation.objects.iter().any(|object| {
        object.kind == ContainerKind::Table
            && object.operations
                == [
                    SchemaMutationOperation::Create,
                    SchemaMutationOperation::Alter,
                    SchemaMutationOperation::Drop,
                ]
    }) && mutation.objects.iter().any(|object| {
        object.kind == ContainerKind::Column
            && object.operations
                == [
                    SchemaMutationOperation::Clear,
                    SchemaMutationOperation::Materialize,
                ]
    }) && [ContainerKind::Projection, ContainerKind::Index]
        .into_iter()
        .all(|kind| {
            mutation.objects.iter().any(|object| {
                object.kind == kind
                    && object.operations
                        == [
                            SchemaMutationOperation::Create,
                            SchemaMutationOperation::Drop,
                            SchemaMutationOperation::Clear,
                            SchemaMutationOperation::Materialize,
                        ]
            })
        });
    let phase_five_e_objects = [ContainerKind::View, ContainerKind::MaterializedView]
        .into_iter()
        .all(|kind| {
            mutation.objects.iter().any(|object| {
                object.kind == kind
                    && object.operations
                        == [
                            SchemaMutationOperation::Create,
                            SchemaMutationOperation::Alter,
                            SchemaMutationOperation::Rename,
                            SchemaMutationOperation::Drop,
                        ]
            })
        });
    let exact_phase_five_d = phase_five_d_objects
        && (mutation.objects.len() == 5 || (mutation.objects.len() == 7 && phase_five_e_objects));
    ensure(
        !capabilities.schema_mutator
            && exact_phase_five_d
            && mutation.ddl_preview
            && mutation.destructive_confirmation
            && mutation.remote_drift_protection,
        "ClickHouse Phase 5D published capability matrix was not exact",
        "assertion=phase_five_d_exact_matrix",
    )
}

pub(super) fn merge_checkpoint_and_cleanup<T>(
    checkpoint: IpcResult<T>,
    cleanup: IpcResult<()>,
) -> IpcResult<T> {
    match (checkpoint, cleanup) {
        (Ok(evidence), Ok(())) => Ok(evidence),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(cleanup_error)) => Err(cleanup_error),
        (Err(error), Err(_cleanup_error)) => Err(checkpoint_error(
            "ClickHouse Phase 5D checkpoint failed and cleanup was incomplete",
            format!(
                "checkpoint=phase_five_d; primary_code={:?}; cleanup_failed=true",
                error.code
            ),
        )),
    }
}

fn merge_cleanup_and_close(cleanup: IpcResult<()>, close: IpcResult<()>) -> IpcResult<()> {
    match (cleanup, close) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) => Err(error),
        (Ok(()), Err(error)) => Err(checkpoint_error(
            "ClickHouse Phase 5D isolated driver close failed",
            format!(
                "checkpoint=phase_five_d; operation=close_driver; code={:?}",
                error.code
            ),
        )),
        (Err(error), Err(_close_error)) => Err(checkpoint_error(
            "ClickHouse Phase 5D cleanup and isolated driver close both failed",
            format!(
                "checkpoint=phase_five_d; cleanup_code={:?}; close_failed=true",
                error.code
            ),
        )),
    }
}

fn checkpoint_error(message: impl Into<String>, details: impl Into<String>) -> IpcError {
    IpcError::system_internal(message, details)
}

fn ensure(condition: bool, message: &'static str, assertion: &'static str) -> IpcResult<()> {
    if condition {
        Ok(())
    } else {
        Err(checkpoint_error(
            message,
            format!("checkpoint=phase_five_d; {assertion}"),
        ))
    }
}

#[async_trait]
trait PhaseFiveDDispatcher: Send + Sync {
    async fn preview_change(
        &self,
        target: &NativeSchemaChangeTarget,
    ) -> IpcResult<NativeSchemaChangePlan>;

    async fn execute_change(
        &self,
        request: &NativeSchemaExecuteChangeRequest,
    ) -> IpcResult<NativeSchemaChangeResult>;

    async fn describe_table(&self, container: &ContainerRef) -> IpcResult<ClickHouseTableSchema>;
}

struct DirectPhaseFiveDDispatcher<'a> {
    extension: &'a dyn NativeSchemaExtension,
}

#[async_trait]
impl PhaseFiveDDispatcher for DirectPhaseFiveDDispatcher<'_> {
    async fn preview_change(
        &self,
        target: &NativeSchemaChangeTarget,
    ) -> IpcResult<NativeSchemaChangePlan> {
        self.extension.preview_change(target).await
    }

    async fn execute_change(
        &self,
        request: &NativeSchemaExecuteChangeRequest,
    ) -> IpcResult<NativeSchemaChangeResult> {
        self.extension.execute_change(request).await
    }

    async fn describe_table(&self, container: &ContainerRef) -> IpcResult<ClickHouseTableSchema> {
        let NativeSchemaDocument::ClickHouseTable(schema) = self
            .extension
            .describe(&NativeSchemaDescribeRequest::Table(container.clone()))
            .await?
        else {
            return Err(IpcError::system_internal(
                "ClickHouse Phase 5D Direct Describe returned the wrong document variant",
                "checkpoint=phase_five_d; assertion=direct_table_document_variant",
            ));
        };
        Ok(*schema)
    }
}

fn table_container(database: &str) -> ContainerRef {
    ContainerRef::table(ContainerKind::Table, database, None, TABLE_NAME)
}

struct ManagerPhaseFiveDDispatcher<'a> {
    manager: &'a ConnectionRuntimeManager,
    profile_id: &'a str,
}

#[async_trait]
impl PhaseFiveDDispatcher for ManagerPhaseFiveDDispatcher<'_> {
    async fn preview_change(
        &self,
        target: &NativeSchemaChangeTarget,
    ) -> IpcResult<NativeSchemaChangePlan> {
        self.manager
            .preview_native_schema_change(self.profile_id, target.clone())
            .await
    }

    async fn execute_change(
        &self,
        request: &NativeSchemaExecuteChangeRequest,
    ) -> IpcResult<NativeSchemaChangeResult> {
        self.manager
            .execute_native_schema_change(self.profile_id, request.clone())
            .await
    }

    async fn describe_table(&self, container: &ContainerRef) -> IpcResult<ClickHouseTableSchema> {
        let NativeSchemaDocument::ClickHouseTable(schema) = self
            .manager
            .describe_native_schema(
                self.profile_id,
                NativeSchemaDescribeRequest::Table(container.clone()),
            )
            .await?
        else {
            return Err(IpcError::system_internal(
                "ClickHouse Phase 5D Manager Describe returned the wrong document variant",
                "checkpoint=phase_five_d; assertion=manager_table_document_variant",
            ));
        };
        Ok(*schema)
    }
}

fn projection_create_target(
    baseline: ClickHouseTableSchema,
    definition: ProjectionDefinition,
) -> NativeSchemaChangeTarget {
    NativeSchemaChangeTarget::ClickHouseProjectionCreate(Box::new(
        ClickHouseProjectionCreateTarget {
            baseline,
            projection: ClickHouseProjectionTarget {
                name: definition.name.to_string(),
                query: definition.query.to_string(),
            },
        },
    ))
}

fn projection_action_target(
    baseline: ClickHouseTableSchema,
    name: &str,
    operation: SchemaMutationOperation,
) -> NativeSchemaChangeTarget {
    let target = Box::new(ClickHouseProjectionActionTarget {
        baseline,
        projection_name: name.to_string(),
    });
    match operation {
        SchemaMutationOperation::Drop => NativeSchemaChangeTarget::ClickHouseProjectionDrop(target),
        SchemaMutationOperation::Clear => {
            NativeSchemaChangeTarget::ClickHouseProjectionClear(target)
        }
        SchemaMutationOperation::Materialize => {
            NativeSchemaChangeTarget::ClickHouseProjectionMaterialize(target)
        }
        _ => unreachable!("Projection actions only use drop, clear, or materialize"),
    }
}

fn index_create_target(
    baseline: ClickHouseTableSchema,
    definition: IndexDefinition,
) -> NativeSchemaChangeTarget {
    NativeSchemaChangeTarget::ClickHouseSkippingIndexCreate(Box::new(
        ClickHouseSkippingIndexCreateTarget {
            baseline,
            index: ClickHouseSkippingIndexTarget {
                name: definition.name.to_string(),
                expression: definition.expression.to_string(),
                index_type: definition.index_type.to_string(),
                type_arguments: definition
                    .type_arguments
                    .iter()
                    .map(|argument| (*argument).to_string())
                    .collect(),
                granularity: definition.granularity,
            },
        },
    ))
}

fn index_action_target(
    baseline: ClickHouseTableSchema,
    name: &str,
    operation: SchemaMutationOperation,
) -> NativeSchemaChangeTarget {
    let target = Box::new(ClickHouseSkippingIndexActionTarget {
        baseline,
        index_name: name.to_string(),
    });
    match operation {
        SchemaMutationOperation::Drop => {
            NativeSchemaChangeTarget::ClickHouseSkippingIndexDrop(target)
        }
        SchemaMutationOperation::Clear => {
            NativeSchemaChangeTarget::ClickHouseSkippingIndexClear(target)
        }
        SchemaMutationOperation::Materialize => {
            NativeSchemaChangeTarget::ClickHouseSkippingIndexMaterialize(target)
        }
        _ => unreachable!("Index actions only use drop, clear, or materialize"),
    }
}

fn change_request(
    target: NativeSchemaChangeTarget,
    plan: &NativeSchemaChangePlan,
    confirm_destructive: bool,
) -> NativeSchemaExecuteChangeRequest {
    NativeSchemaExecuteChangeRequest {
        target,
        baseline: plan.baseline.clone(),
        expected_plan_hash: plan.plan_hash.clone(),
        confirmation: confirm_destructive.then_some(NativeSchemaConfirmationInput {
            accepted: true,
            object_name: None,
            cluster_name: None,
        }),
    }
}

fn assert_plan(
    plan: &NativeSchemaChangePlan,
    expected_code: &str,
    destructive: bool,
) -> IpcResult<()> {
    let statement = plan
        .statements
        .first()
        .map(String::as_str)
        .unwrap_or_default();
    ensure(
        plan.statements.len() == 1
            && plan.operations.len() == 1
            && plan.operations[0].code == expected_code
            && plan.destructive == destructive
            && plan.long_running == destructive
            && plan.operations[0].destructive == destructive
            && plan.operations[0].long_running == destructive
            && is_lowercase_sha256(&plan.plan_hash)
            && !statement.contains("IF EXISTS")
            && !statement.contains("IF NOT EXISTS")
            && !statement.contains("IN PARTITION"),
        "ClickHouse Phase 5D preview was invalid",
        "assertion=change_preview",
    )
}

fn assert_progress(
    stage: &'static str,
    expected_status: NativeSchemaExecutionStatus,
    actual_status: NativeSchemaExecutionStatus,
    progress: &crate::engine::native_schema::NativeSchemaStatementProgress,
) -> IpcResult<()> {
    if actual_status == expected_status
        && progress.applied_count == 1
        && progress.failed_statement_index.is_none()
        && progress.remaining_count == 0
        && progress.query_ids.len() == 1
        && !progress.query_ids[0].trim().is_empty()
    {
        Ok(())
    } else {
        Err(checkpoint_error(
            format!(
                "ClickHouse Phase 5D result progress was invalid: stage={stage}; expected_status={expected_status:?}; actual_status={actual_status:?}; applied={}; failed_index_present={}; remaining={}; query_id_count={}",
                progress.applied_count,
                progress.failed_statement_index.is_some(),
                progress.remaining_count,
                progress.query_ids.len(),
            ),
            "checkpoint=phase_five_d; assertion=result_progress",
        ))
    }
}

fn normalized(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

fn assert_editable_schema(schema: &ClickHouseTableSchema, database: &str) -> IpcResult<()> {
    ensure(
        schema.identity.database == database
            && schema.identity.name == TABLE_NAME
            && schema.identity.object_kind == ContainerKind::Table
            && schema.editability.mode == ClickHouseSchemaEditabilityMode::Editable
            && schema.editability.blockers.is_empty()
            && is_lowercase_sha256(&schema.baseline.revision_hash),
        "ClickHouse Phase 5D fixture schema became readonly or changed identity",
        "assertion=editable_schema",
    )
}

async fn describe_table(
    dispatcher: &dyn PhaseFiveDDispatcher,
    database: &str,
) -> IpcResult<ClickHouseTableSchema> {
    let schema = dispatcher
        .describe_table(&table_container(database))
        .await?;
    assert_editable_schema(&schema, database)?;
    Ok(schema)
}

async fn create_projection(
    dispatcher: &dyn PhaseFiveDDispatcher,
    database: &str,
    definition: ProjectionDefinition,
) -> IpcResult<()> {
    let baseline = describe_table(dispatcher, database).await?;
    let target = projection_create_target(baseline, definition);
    let plan = dispatcher.preview_change(&target).await?;
    assert_plan(&plan, "projection.create", false)?;
    let result = dispatcher
        .execute_change(&change_request(target, &plan, false))
        .await?;
    let NativeSchemaChangeResult::ClickHouseProjectionChange(result) = result else {
        return Err(checkpoint_error(
            "ClickHouse Phase 5D projection create returned the wrong result",
            "checkpoint=phase_five_d; assertion=projection_create_result",
        ));
    };
    assert_progress(
        "projection_create",
        NativeSchemaExecutionStatus::Applied,
        result.status,
        &result.progress,
    )?;
    ensure(
        result.status == NativeSchemaExecutionStatus::Applied
            && result.operation == SchemaMutationOperation::Create
            && result.projection_name == definition.name
            && result.schema.is_some(),
        "ClickHouse Phase 5D projection create was not verified",
        "assertion=projection_create_applied",
    )?;
    let described = describe_table(dispatcher, database).await?;
    let projection = described
        .projections
        .iter()
        .find(|projection| projection.name == definition.name);
    ensure(
        projection.is_some_and(|projection| {
            projection.editability.mode == ClickHouseSchemaEditabilityMode::Editable
                && projection.editability.blockers.is_empty()
                && normalized(&projection.query) == normalized(definition.query)
        }),
        "ClickHouse Phase 5D projection definition did not round-trip",
        "assertion=projection_definition",
    )
}

async fn create_index(
    dispatcher: &dyn PhaseFiveDDispatcher,
    database: &str,
    definition: IndexDefinition,
) -> IpcResult<()> {
    let baseline = describe_table(dispatcher, database).await?;
    let target = index_create_target(baseline, definition);
    let plan = dispatcher.preview_change(&target).await?;
    assert_plan(&plan, "skipping_index.create", false)?;
    let result = dispatcher
        .execute_change(&change_request(target, &plan, false))
        .await?;
    let NativeSchemaChangeResult::ClickHouseSkippingIndexChange(result) = result else {
        return Err(checkpoint_error(
            "ClickHouse Phase 5D index create returned the wrong result",
            "checkpoint=phase_five_d; assertion=index_create_result",
        ));
    };
    if result.status != NativeSchemaExecutionStatus::Applied {
        let actual = result.schema.as_ref().and_then(|schema| {
            schema
                .skipping_indexes
                .iter()
                .find(|index| index.name == definition.name)
        });
        return Err(checkpoint_error(
            format!(
                "ClickHouse Phase 5D index create verification mismatch: family={}; status={:?}; expected_arguments={:?}; actual_type={}; actual_arguments={:?}; actual_granularity={:?}; actual_mode={:?}; blocker_codes={}",
                definition.index_type,
                result.status,
                definition.type_arguments,
                actual.map(|index| index.index_type.as_str()).unwrap_or("missing"),
                actual
                    .map(|index| index.type_arguments.as_slice())
                    .unwrap_or_default(),
                actual.and_then(|index| index.granularity),
                actual.map(|index| index.editability.mode),
                actual
                    .map(|index| {
                        index
                            .editability
                            .blockers
                            .iter()
                            .map(|blocker| blocker.code.as_str())
                            .collect::<Vec<_>>()
                            .join(",")
                    })
                    .unwrap_or_else(|| "missing".to_string()),
            ),
            "checkpoint=phase_five_d; assertion=index_create_verification",
        ));
    }
    assert_progress(
        definition.index_type,
        NativeSchemaExecutionStatus::Applied,
        result.status,
        &result.progress,
    )?;
    ensure(
        result.status == NativeSchemaExecutionStatus::Applied
            && result.operation == SchemaMutationOperation::Create
            && result.index_name == definition.name
            && result.schema.is_some(),
        "ClickHouse Phase 5D index create was not verified",
        "assertion=index_create_applied",
    )?;
    let described = describe_table(dispatcher, database).await?;
    let index = described
        .skipping_indexes
        .iter()
        .find(|index| index.name == definition.name);
    ensure(
        index.is_some_and(|index| {
            index.editability.mode == ClickHouseSchemaEditabilityMode::Editable
                && index.editability.blockers.is_empty()
                && normalized(&index.expression) == normalized(definition.expression)
                && index.index_type.eq_ignore_ascii_case(definition.index_type)
                && index.type_arguments
                    == definition
                        .type_arguments
                        .iter()
                        .map(|argument| (*argument).to_string())
                        .collect::<Vec<_>>()
                && index.granularity == Some(definition.granularity)
        }),
        "ClickHouse Phase 5D index definition did not round-trip",
        "assertion=index_definition",
    )
}

async fn expect_execute_error(
    dispatcher: &dyn PhaseFiveDDispatcher,
    target: NativeSchemaChangeTarget,
    plan: &NativeSchemaChangePlan,
    confirm_destructive: bool,
    expected: ErrorCode,
    assertion: &'static str,
) -> IpcResult<()> {
    let error = match dispatcher
        .execute_change(&change_request(target, plan, confirm_destructive))
        .await
    {
        Ok(_) => {
            return Err(checkpoint_error(
                "ClickHouse Phase 5D negative execute unexpectedly succeeded",
                format!("checkpoint=phase_five_d; {assertion}"),
            ));
        }
        Err(error) => error,
    };
    ensure(
        error.code == expected,
        "ClickHouse Phase 5D negative execute returned the wrong error",
        assertion,
    )
}

async fn run_drift_conflict(
    dispatcher: &dyn PhaseFiveDDispatcher,
    client: &Client,
    database: &str,
    evidence: &mut PhaseFiveDEvidence,
) -> IpcResult<()> {
    let baseline = describe_table(dispatcher, database).await?;
    let original_revision = baseline.baseline.revision_hash.clone();
    let definition = ProjectionDefinition {
        name: "stale_projection",
        query: "SELECT id ORDER BY id",
    };
    let target = projection_create_target(baseline, definition);
    let plan = dispatcher.preview_change(&target).await?;
    assert_plan(&plan, "projection.create", false)?;
    let drift_sql = format!(
        "ALTER TABLE {}.{} MODIFY COMMENT 'phase 5d drift'",
        quote_identifier(database),
        quote_identifier(TABLE_NAME),
    );
    execute_test_sql(client, &drift_sql, "introduce_remote_drift").await?;
    let drifted = describe_table(dispatcher, database).await?;
    ensure(
        drifted.baseline.revision_hash != original_revision,
        "ClickHouse Phase 5D drift fixture did not change the baseline",
        "assertion=drift_revision",
    )?;
    expect_execute_error(
        dispatcher,
        target,
        &plan,
        false,
        ErrorCode::ResourceConflict,
        "assertion=stale_plan_conflict",
    )
    .await?;
    let after = describe_table(dispatcher, database).await?;
    ensure(
        after
            .projections
            .iter()
            .all(|projection| projection.name != definition.name),
        "ClickHouse Phase 5D stale plan created an object",
        "assertion=stale_object_absent",
    )?;
    evidence.drift_conflicts += 1;
    Ok(())
}

async fn expect_preview_validation(
    dispatcher: &dyn PhaseFiveDDispatcher,
    target: NativeSchemaChangeTarget,
) -> IpcResult<()> {
    let error = dispatcher
        .preview_change(&target)
        .await
        .expect_err("Phase 5D unsupported target must fail preview");
    ensure(
        error.code == ErrorCode::ValidationFailed,
        "ClickHouse Phase 5D unsupported target returned the wrong error",
        "assertion=unsupported_validation",
    )
}

async fn run_unsupported_matrix(
    dispatcher: &dyn PhaseFiveDDispatcher,
    database: &str,
    evidence: &mut PhaseFiveDEvidence,
) -> IpcResult<()> {
    let baseline = describe_table(dispatcher, database).await?;
    let targets = [
        projection_create_target(
            baseline.clone(),
            ProjectionDefinition {
                name: "unsupported_projection",
                query: "SELECT tenant_id FROM external_table",
            },
        ),
        index_create_target(
            baseline.clone(),
            IndexDefinition {
                name: "unsupported_family",
                expression: "message",
                index_type: "custom_family",
                type_arguments: &[],
                granularity: 1,
            },
        ),
        index_create_target(
            baseline.clone(),
            IndexDefinition {
                name: "bad_set_arity",
                expression: "tenant_id",
                index_type: "set",
                type_arguments: &[],
                granularity: 1,
            },
        ),
        index_create_target(
            baseline.clone(),
            IndexDefinition {
                name: "bad_bloom_probability",
                expression: "message",
                index_type: "bloom_filter",
                type_arguments: &["1.5"],
                granularity: 1,
            },
        ),
        index_create_target(
            baseline,
            IndexDefinition {
                name: "zero_granularity",
                expression: "tenant_id",
                index_type: "minmax",
                type_arguments: &[],
                granularity: 0,
            },
        ),
    ];
    for target in targets {
        expect_preview_validation(dispatcher, target).await?;
        evidence.unsupported_rejections += 1;
    }
    let after = describe_table(dispatcher, database).await?;
    ensure(
        [
            "unsupported_projection",
            "unsupported_family",
            "bad_set_arity",
            "bad_bloom_probability",
            "zero_granularity",
        ]
        .iter()
        .all(|name| {
            after.projections.iter().all(|item| item.name != *name)
                && after.skipping_indexes.iter().all(|item| item.name != *name)
        }),
        "ClickHouse Phase 5D unsupported matrix changed remote objects",
        "assertion=unsupported_objects_absent",
    )
}

async fn execute_projection_action(
    dispatcher: &dyn PhaseFiveDDispatcher,
    client: &Client,
    database: &str,
    name: &str,
    operation: SchemaMutationOperation,
    evidence: &mut PhaseFiveDEvidence,
) -> IpcResult<()> {
    let baseline = describe_table(dispatcher, database).await?;
    let target = projection_action_target(baseline, name, operation);
    let plan = dispatcher.preview_change(&target).await?;
    assert_plan(
        &plan,
        match operation {
            SchemaMutationOperation::Materialize => "projection.materialize",
            SchemaMutationOperation::Clear => "projection.clear",
            _ => unreachable!(),
        },
        true,
    )?;
    expect_execute_error(
        dispatcher,
        target.clone(),
        &plan,
        false,
        ErrorCode::ValidationFailed,
        "assertion=projection_action_confirmation",
    )
    .await?;
    evidence.destructive_rejections += 1;
    let result = dispatcher
        .execute_change(&change_request(target, &plan, true))
        .await?;
    let NativeSchemaChangeResult::ClickHouseProjectionChange(result) = result else {
        return Err(checkpoint_error(
            "ClickHouse Phase 5D projection action returned the wrong result",
            "checkpoint=phase_five_d; assertion=projection_action_result",
        ));
    };
    assert_progress(
        "projection_action",
        NativeSchemaExecutionStatus::Submitted,
        result.status,
        &result.progress,
    )?;
    ensure(
        result.status == NativeSchemaExecutionStatus::Submitted
            && result.operation == operation
            && result.projection_name == name,
        "ClickHouse Phase 5D projection action was not submitted",
        "assertion=projection_action_submitted",
    )?;
    evidence.submitted_actions += 1;
    wait_for_mutations(client, database).await
}

async fn execute_index_action(
    dispatcher: &dyn PhaseFiveDDispatcher,
    client: &Client,
    database: &str,
    name: &str,
    operation: SchemaMutationOperation,
    evidence: &mut PhaseFiveDEvidence,
) -> IpcResult<()> {
    let baseline = describe_table(dispatcher, database).await?;
    let target = index_action_target(baseline, name, operation);
    let plan = dispatcher.preview_change(&target).await?;
    assert_plan(
        &plan,
        match operation {
            SchemaMutationOperation::Materialize => "skipping_index.materialize",
            SchemaMutationOperation::Clear => "skipping_index.clear",
            _ => unreachable!(),
        },
        true,
    )?;
    expect_execute_error(
        dispatcher,
        target.clone(),
        &plan,
        false,
        ErrorCode::ValidationFailed,
        "assertion=index_action_confirmation",
    )
    .await?;
    evidence.destructive_rejections += 1;
    let result = dispatcher
        .execute_change(&change_request(target, &plan, true))
        .await?;
    let NativeSchemaChangeResult::ClickHouseSkippingIndexChange(result) = result else {
        return Err(checkpoint_error(
            "ClickHouse Phase 5D index action returned the wrong result",
            "checkpoint=phase_five_d; assertion=index_action_result",
        ));
    };
    assert_progress(
        "index_action",
        NativeSchemaExecutionStatus::Submitted,
        result.status,
        &result.progress,
    )?;
    ensure(
        result.status == NativeSchemaExecutionStatus::Submitted
            && result.operation == operation
            && result.index_name == name,
        "ClickHouse Phase 5D index action was not submitted",
        "assertion=index_action_submitted",
    )?;
    evidence.submitted_actions += 1;
    wait_for_mutations(client, database).await
}

async fn drop_projection(
    dispatcher: &dyn PhaseFiveDDispatcher,
    database: &str,
    name: &str,
    evidence: &mut PhaseFiveDEvidence,
) -> IpcResult<()> {
    let baseline = describe_table(dispatcher, database).await?;
    let target = projection_action_target(baseline, name, SchemaMutationOperation::Drop);
    let plan = dispatcher.preview_change(&target).await?;
    assert_plan(&plan, "projection.drop", true)?;
    expect_execute_error(
        dispatcher,
        target.clone(),
        &plan,
        false,
        ErrorCode::ValidationFailed,
        "assertion=projection_drop_confirmation",
    )
    .await?;
    evidence.destructive_rejections += 1;
    let result = dispatcher
        .execute_change(&change_request(target, &plan, true))
        .await?;
    let NativeSchemaChangeResult::ClickHouseProjectionChange(result) = result else {
        return Err(checkpoint_error(
            "ClickHouse Phase 5D projection drop returned the wrong result",
            "checkpoint=phase_five_d; assertion=projection_drop_result",
        ));
    };
    assert_progress(
        "projection_drop",
        NativeSchemaExecutionStatus::Applied,
        result.status,
        &result.progress,
    )?;
    ensure(
        result.status == NativeSchemaExecutionStatus::Applied
            && result.operation == SchemaMutationOperation::Drop
            && result.projection_name == name
            && result.schema.is_some(),
        "ClickHouse Phase 5D projection drop was not verified",
        "assertion=projection_drop_applied",
    )?;
    let after = describe_table(dispatcher, database).await?;
    ensure(
        after
            .projections
            .iter()
            .all(|projection| projection.name != name),
        "ClickHouse Phase 5D projection remained after Drop",
        "assertion=projection_drop_absence",
    )?;
    evidence.projections_dropped += 1;
    Ok(())
}

async fn drop_index(
    dispatcher: &dyn PhaseFiveDDispatcher,
    database: &str,
    name: &str,
    evidence: &mut PhaseFiveDEvidence,
) -> IpcResult<()> {
    let baseline = describe_table(dispatcher, database).await?;
    let target = index_action_target(baseline, name, SchemaMutationOperation::Drop);
    let plan = dispatcher.preview_change(&target).await?;
    assert_plan(&plan, "skipping_index.drop", true)?;
    expect_execute_error(
        dispatcher,
        target.clone(),
        &plan,
        false,
        ErrorCode::ValidationFailed,
        "assertion=index_drop_confirmation",
    )
    .await?;
    evidence.destructive_rejections += 1;
    let result = dispatcher
        .execute_change(&change_request(target, &plan, true))
        .await?;
    let NativeSchemaChangeResult::ClickHouseSkippingIndexChange(result) = result else {
        return Err(checkpoint_error(
            "ClickHouse Phase 5D index drop returned the wrong result",
            "checkpoint=phase_five_d; assertion=index_drop_result",
        ));
    };
    assert_progress(
        "index_drop",
        NativeSchemaExecutionStatus::Applied,
        result.status,
        &result.progress,
    )?;
    ensure(
        result.status == NativeSchemaExecutionStatus::Applied
            && result.operation == SchemaMutationOperation::Drop
            && result.index_name == name
            && result.schema.is_some(),
        "ClickHouse Phase 5D index drop was not verified",
        "assertion=index_drop_applied",
    )?;
    let after = describe_table(dispatcher, database).await?;
    ensure(
        after
            .skipping_indexes
            .iter()
            .all(|index| index.name != name),
        "ClickHouse Phase 5D index remained after Drop",
        "assertion=index_drop_absence",
    )?;
    evidence.indexes_dropped += 1;
    Ok(())
}

async fn setup_fixture(client: &Client, database: &str) -> IpcResult<()> {
    let create_database = format!("CREATE DATABASE {}", quote_identifier(database));
    execute_test_sql(client, &create_database, "create_database").await?;
    let create_table = format!(
        "CREATE TABLE {}.{} (id UInt64, tenant_id UInt32, message String) ENGINE = MergeTree ORDER BY id",
        quote_identifier(database),
        quote_identifier(TABLE_NAME),
    );
    execute_test_sql(client, &create_table, "create_table").await?;
    let insert = format!(
        "INSERT INTO {}.{} (id, tenant_id, message) VALUES (1, 10, 'alpha token'), (2, 10, 'beta token'), (3, 20, 'gamma value'), (4, 30, 'delta value')",
        quote_identifier(database),
        quote_identifier(TABLE_NAME),
    );
    execute_test_sql(client, &insert, "insert_rows").await?;
    ensure(
        table_row_count(client, database).await? >= 4,
        "ClickHouse Phase 5D fixture rows were not inserted",
        "assertion=fixture_rows",
    )
}

async fn run_checkpoint(
    dispatcher: &dyn PhaseFiveDDispatcher,
    client: &Client,
    database: &str,
) -> IpcResult<PhaseFiveDEvidence> {
    let mut evidence = PhaseFiveDEvidence {
        server_version: server_version(client).await?,
        projections_created: 0,
        index_types_created: 0,
        destructive_rejections: 0,
        submitted_actions: 0,
        drift_conflicts: 0,
        unsupported_rejections: 0,
        projections_dropped: 0,
        indexes_dropped: 0,
    };
    setup_fixture(client, database).await?;
    describe_table(dispatcher, database).await?;

    for definition in PROJECTIONS {
        create_projection(dispatcher, database, definition).await?;
        evidence.projections_created += 1;
    }
    for definition in INDEXES {
        create_index(dispatcher, database, definition).await?;
        evidence.index_types_created += 1;
    }

    run_drift_conflict(dispatcher, client, database, &mut evidence).await?;
    run_unsupported_matrix(dispatcher, database, &mut evidence).await?;

    execute_projection_action(
        dispatcher,
        client,
        database,
        PROJECTION_AGGREGATE,
        SchemaMutationOperation::Materialize,
        &mut evidence,
    )
    .await?;
    execute_projection_action(
        dispatcher,
        client,
        database,
        PROJECTION_AGGREGATE,
        SchemaMutationOperation::Clear,
        &mut evidence,
    )
    .await?;
    execute_index_action(
        dispatcher,
        client,
        database,
        INDEX_MINMAX,
        SchemaMutationOperation::Materialize,
        &mut evidence,
    )
    .await?;
    execute_index_action(
        dispatcher,
        client,
        database,
        INDEX_MINMAX,
        SchemaMutationOperation::Clear,
        &mut evidence,
    )
    .await?;

    for definition in PROJECTIONS {
        drop_projection(dispatcher, database, definition.name, &mut evidence).await?;
    }
    for definition in INDEXES {
        drop_index(dispatcher, database, definition.name, &mut evidence).await?;
    }
    let final_schema = describe_table(dispatcher, database).await?;
    ensure(
        final_schema.projections.is_empty() && final_schema.skipping_indexes.is_empty(),
        "ClickHouse Phase 5D object cleanup was incomplete before fixture cleanup",
        "assertion=object_matrix_empty",
    )?;
    evidence.validate_counts()?;
    Ok(evidence)
}

pub(super) async fn run_direct(
    record: &StoredConnectionRecord,
    client: &Client,
    prefix: &str,
) -> IpcResult<PhaseFiveDEvidence> {
    let database_name = unique_database_name(prefix)?;
    let cleanup = PhaseFiveDCleanupGuard::new(database_name.clone(), TABLE_NAME, prefix)?;
    let driver = DriverRegistry::create_driver("real-clickhouse-phase-5d-direct", record).await?;
    let capability_check = validate_capability_published(&driver.capabilities());
    let extension_check = ensure(
        driver.as_schema_mutator().is_none() && driver.as_native_schema_extension().is_some(),
        "ClickHouse Phase 5D direct driver exposed the wrong extension set",
        "assertion=driver_extensions",
    );
    let initial_cleanup = cleanup.cleanup(client).await;
    let checkpoint = match (capability_check, extension_check, initial_cleanup) {
        (Ok(()), Ok(()), Ok(())) => match driver.as_native_schema_extension() {
            Some(extension) => {
                let dispatcher = DirectPhaseFiveDDispatcher { extension };
                run_checkpoint(&dispatcher, client, &database_name).await
            }
            None => Err(checkpoint_error(
                "ClickHouse Phase 5D native schema extension disappeared",
                "checkpoint=phase_five_d; assertion=extension_stable",
            )),
        },
        (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => Err(error),
    };
    let cleanup_result = cleanup.cleanup(client).await;
    let close_result = driver.close().await;
    let teardown = merge_cleanup_and_close(cleanup_result, close_result);
    merge_checkpoint_and_cleanup(checkpoint, teardown)
}

pub(super) async fn run_manager(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    client: &Client,
    prefix: &str,
) -> IpcResult<PhaseFiveDEvidence> {
    let database_name = unique_database_name(prefix)?;
    let cleanup = PhaseFiveDCleanupGuard::new(database_name.clone(), TABLE_NAME, prefix)?;
    let runtime = manager.capabilities(profile_id)?;
    let capability_check = validate_capability_published(&runtime.capabilities);
    let initial_cleanup = cleanup.cleanup(client).await;
    let checkpoint = match (capability_check, initial_cleanup) {
        (Ok(()), Ok(())) => {
            let dispatcher = ManagerPhaseFiveDDispatcher {
                manager,
                profile_id,
            };
            run_checkpoint(&dispatcher, client, &database_name).await
        }
        (Err(error), _) | (_, Err(error)) => Err(error),
    };
    let cleanup_result = cleanup.cleanup(client).await;
    merge_checkpoint_and_cleanup(checkpoint, cleanup_result)
}

async fn server_version(client: &Client) -> IpcResult<String> {
    let row = client
        .query("SELECT version() AS version")
        .fetch_one::<VersionRow>()
        .await
        .map_err(|_| {
            checkpoint_error(
                "ClickHouse Phase 5D version probe failed",
                "checkpoint=phase_five_d; operation=version_probe",
            )
        })?;
    ensure(
        !row.version.trim().is_empty(),
        "ClickHouse Phase 5D version probe returned an empty value",
        "assertion=server_version",
    )?;
    Ok(row.version)
}

async fn database_exists(client: &Client, database: &str) -> IpcResult<bool> {
    client
        .query("SELECT count() AS count FROM system.databases WHERE name = ?")
        .bind(database)
        .fetch_one::<CountRow>()
        .await
        .map(|row| row.count > 0)
        .map_err(|_| {
            checkpoint_error(
                "ClickHouse Phase 5D database verification failed",
                "checkpoint=phase_five_d; operation=verify_database",
            )
        })
}

async fn table_row_count(client: &Client, database: &str) -> IpcResult<u64> {
    let sql = format!(
        "SELECT count() AS count FROM {}.{}",
        quote_identifier(database),
        quote_identifier(TABLE_NAME),
    );
    client
        .query(&sql)
        .fetch_one::<CountRow>()
        .await
        .map(|row| row.count)
        .map_err(|_| {
            checkpoint_error(
                "ClickHouse Phase 5D row count failed",
                "checkpoint=phase_five_d; operation=count_rows",
            )
        })
}

async fn pending_mutations(client: &Client, database: &str) -> IpcResult<u64> {
    client
        .query(
            "SELECT count() AS count FROM system.mutations WHERE database = ? AND table = ? AND is_done = 0",
        )
        .bind(database)
        .bind(TABLE_NAME)
        .fetch_one::<CountRow>()
        .await
        .map(|row| row.count)
        .map_err(|_| {
            checkpoint_error(
                "ClickHouse Phase 5D mutation status query failed",
                "checkpoint=phase_five_d; operation=query_mutations",
            )
        })
}

async fn wait_for_mutations(client: &Client, database: &str) -> IpcResult<()> {
    for _ in 0..300 {
        if pending_mutations(client, database).await? == 0 {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(checkpoint_error(
        "ClickHouse Phase 5D mutation did not finish within 30 seconds",
        "checkpoint=phase_five_d; assertion=mutation_converged",
    ))
}

async fn execute_test_sql(client: &Client, sql: &str, operation: &'static str) -> IpcResult<()> {
    client.query(sql).execute().await.map_err(|_| {
        checkpoint_error(
            format!("ClickHouse Phase 5D independent fixture operation failed: {operation}"),
            format!("checkpoint=phase_five_d; operation={operation}"),
        )
    })
}
