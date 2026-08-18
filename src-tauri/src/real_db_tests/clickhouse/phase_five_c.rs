use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use clickhouse::Client;
use serde::Deserialize;

use crate::engine::drivers::clickhouse::schema::{
    ClickHouseAlterTableTarget, ClickHouseColumnDataActionTarget, ClickHouseColumnDefaultKind,
    ClickHouseColumnRenameIntent, ClickHouseCreateColumnTarget, ClickHouseCreateDatabaseTarget,
    ClickHouseCreateEngineTarget, ClickHouseCreateSettingTarget, ClickHouseCreateTableTarget,
    ClickHouseDropDatabaseTarget, ClickHouseDropTableTarget, ClickHouseKeySchema,
    ClickHouseSchemaEditabilityMode, ClickHouseTableSchema,
};
use crate::engine::manager::ConnectionRuntimeManager;
use crate::engine::native_schema::{
    NativeSchemaChangePlan, NativeSchemaChangeResult, NativeSchemaChangeTarget,
    NativeSchemaConfirmationInput, NativeSchemaCreateResult, NativeSchemaCreateTarget,
    NativeSchemaDescribeRequest, NativeSchemaDocument, NativeSchemaExecuteChangeRequest,
    NativeSchemaExecuteCreateRequest, NativeSchemaExecutionStatus, NativeSchemaExtension,
};
use crate::engine::registry::DriverRegistry;
use crate::engine::types::{ContainerKind, DriverCapabilities, SchemaMutationOperation};
use crate::error::{IpcError, IpcResult};
use crate::repository::connection_repository::StoredConnectionRecord;

use super::phase_five_a::{is_lowercase_sha256, quote_identifier};

static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(clickhouse::Row, Deserialize)]
struct CountRow {
    count: u64,
}

#[derive(clickhouse::Row, Deserialize)]
struct VersionRow {
    version: String,
}

#[derive(Debug, Clone, Copy, clickhouse::Row, Deserialize, PartialEq, Eq)]
struct ColumnActionRow {
    source: u64,
    materialized_value: u64,
}

struct DatabaseCleanupGuard {
    database_name: String,
    scratch_prefix: String,
}

impl DatabaseCleanupGuard {
    fn new(database_name: String, scratch_prefix: &str) -> IpcResult<Self> {
        validate_database_scope(&database_name, scratch_prefix)?;
        Ok(Self {
            database_name,
            scratch_prefix: scratch_prefix.to_string(),
        })
    }

    async fn cleanup(&self, client: &Client) -> IpcResult<()> {
        validate_database_scope(&self.database_name, &self.scratch_prefix)?;
        let sql = format!(
            "DROP DATABASE IF EXISTS {}",
            quote_identifier(&self.database_name),
        );
        client.query(&sql).execute().await.map_err(|_| {
            checkpoint_error(
                "ClickHouse Phase 5C fixture cleanup failed",
                "checkpoint=phase_five_c; operation=drop_scratch_database",
            )
        })?;
        ensure(
            !database_exists(client, &self.database_name).await?,
            "ClickHouse Phase 5C scratch database remained after cleanup",
            "assertion=cleanup_absence",
        )
    }
}

pub(super) struct PhaseFiveCEvidence {
    pub server_version: String,
    pub safe_alter_operations: usize,
    pub destructive_rejections: usize,
    pub destructive_applied: usize,
    pub drift_conflicts: usize,
    pub unsupported_rejections: usize,
    pub submitted_actions: usize,
    pub dropped_columns: usize,
    pub dropped_tables: usize,
    pub dropped_databases: usize,
}

impl PhaseFiveCEvidence {
    pub(super) fn marker(&self) -> String {
        self.marker_with_prefix("ClickHouse Phase 5C direct change checkpoint passed")
    }

    pub(super) fn manager_marker(&self) -> String {
        self.marker_with_prefix("ClickHouse Phase 5C Manager-gated change checkpoint passed")
    }

    fn marker_with_prefix(&self, prefix: &str) -> String {
        format!(
            "{prefix}: server={}; safe_alter={}; destructive_rejections={}; destructive_applied={}; drift_conflicts={}; unsupported_rejections={}; submitted_actions={}; dropped_columns={}; dropped_tables={}; dropped_databases={}",
            self.server_version,
            self.safe_alter_operations,
            self.destructive_rejections,
            self.destructive_applied,
            self.drift_conflicts,
            self.unsupported_rejections,
            self.submitted_actions,
            self.dropped_columns,
            self.dropped_tables,
            self.dropped_databases,
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PhaseFiveCCapabilityExpectation {
    Closed,
    Published,
}

pub(super) fn unique_database_name(prefix: &str) -> IpcResult<String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| {
            checkpoint_error(
                "ClickHouse Phase 5C fixture clock was invalid",
                "checkpoint=phase_five_c; operation=fixture_identity",
            )
        })?
        .as_millis();
    let sequence = FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let name = format!("{prefix}phase5c_{timestamp}_{sequence}");
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
            && database_name.starts_with(&format!("{prefix}phase5c_"))
            && database_name.len() > prefix.len() + "phase5c_".len()
            && database_name
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_'),
        "ClickHouse Phase 5C refused an out-of-scope cleanup target",
        "assertion=scratch_prefix_scope",
    )
}

pub(super) fn validate_capability_expectation(
    capabilities: &DriverCapabilities,
    expectation: PhaseFiveCCapabilityExpectation,
) -> IpcResult<()> {
    let mutation = capabilities.schema_mutation.as_ref().ok_or_else(|| {
        checkpoint_error(
            "ClickHouse Phase 5C checkpoint expected a native schema capability",
            "checkpoint=phase_five_c; assertion=schema_mutation_present",
        )
    })?;
    match expectation {
        PhaseFiveCCapabilityExpectation::Closed => {
            let exact_objects = mutation.objects.len() == 2
                && mutation.objects.iter().any(|object| {
                    object.kind == ContainerKind::Database
                        && object.operations == [SchemaMutationOperation::Create]
                })
                && mutation.objects.iter().any(|object| {
                    object.kind == ContainerKind::Table
                        && object.operations == [SchemaMutationOperation::Create]
                });
            ensure(
                !capabilities.schema_mutator
                    && exact_objects
                    && mutation.ddl_preview
                    && !mutation.destructive_confirmation
                    && !mutation.remote_drift_protection,
                "ClickHouse Phase 5C implementation was published before its real gate",
                "assertion=phase_five_b_exact_matrix",
            )
        }
        PhaseFiveCCapabilityExpectation::Published => {
            let phase_five_c_objects = mutation.objects.iter().any(|object| {
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
            });
            let phase_five_d_objects = [ContainerKind::Projection, ContainerKind::Index]
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
            let exact_objects = phase_five_c_objects
                && (mutation.objects.len() == 3
                    || (mutation.objects.len() == 5 && phase_five_d_objects)
                    || (mutation.objects.len() == 7
                        && phase_five_d_objects
                        && phase_five_e_objects));
            ensure(
                !capabilities.schema_mutator
                    && exact_objects
                    && mutation.ddl_preview
                    && mutation.destructive_confirmation
                    && mutation.remote_drift_protection,
                "ClickHouse Phase 5C published capability matrix was not exact",
                "assertion=phase_five_c_exact_matrix",
            )
        }
    }
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
            "ClickHouse Phase 5C checkpoint failed and cleanup was incomplete",
            format!(
                "checkpoint=phase_five_c; primary_code={:?}; cleanup_failed=true",
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
            format!("checkpoint=phase_five_c; {assertion}"),
        ))
    }
}

#[async_trait]
trait PhaseFiveCChangeDispatcher: Send + Sync {
    async fn preview_change(
        &self,
        target: &NativeSchemaChangeTarget,
    ) -> IpcResult<NativeSchemaChangePlan>;

    async fn execute_change(
        &self,
        request: &NativeSchemaExecuteChangeRequest,
    ) -> IpcResult<NativeSchemaChangeResult>;

    async fn describe_table(
        &self,
        container: &crate::engine::types::ContainerRef,
    ) -> IpcResult<ClickHouseTableSchema>;
}

#[async_trait]
trait PhaseFiveCSetupDispatcher: Send + Sync {
    async fn preview_create(
        &self,
        target: &NativeSchemaCreateTarget,
    ) -> IpcResult<crate::engine::native_schema::NativeSchemaMutationPreview>;

    async fn execute_create(
        &self,
        request: &NativeSchemaExecuteCreateRequest,
    ) -> IpcResult<NativeSchemaCreateResult>;
}

struct DirectChangeDispatcher<'a> {
    extension: &'a dyn NativeSchemaExtension,
}

#[async_trait]
impl PhaseFiveCChangeDispatcher for DirectChangeDispatcher<'_> {
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

    async fn describe_table(
        &self,
        container: &crate::engine::types::ContainerRef,
    ) -> IpcResult<ClickHouseTableSchema> {
        let NativeSchemaDocument::ClickHouseTable(schema) = self
            .extension
            .describe(&NativeSchemaDescribeRequest::Table(container.clone()))
            .await?
        else {
            return Err(IpcError::system_internal(
                "ClickHouse Phase 5C Direct Describe returned the wrong document variant",
                "checkpoint=phase_five_c; assertion=direct_table_document_variant",
            ));
        };
        Ok(*schema)
    }
}

#[async_trait]
impl PhaseFiveCSetupDispatcher for DirectChangeDispatcher<'_> {
    async fn preview_create(
        &self,
        target: &NativeSchemaCreateTarget,
    ) -> IpcResult<crate::engine::native_schema::NativeSchemaMutationPreview> {
        self.extension.preview_create(target).await
    }

    async fn execute_create(
        &self,
        request: &NativeSchemaExecuteCreateRequest,
    ) -> IpcResult<NativeSchemaCreateResult> {
        self.extension.execute_create(request).await
    }
}

struct ManagerChangeDispatcher<'a> {
    manager: &'a ConnectionRuntimeManager,
    profile_id: &'a str,
}

#[async_trait]
impl PhaseFiveCChangeDispatcher for ManagerChangeDispatcher<'_> {
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

    async fn describe_table(
        &self,
        container: &crate::engine::types::ContainerRef,
    ) -> IpcResult<ClickHouseTableSchema> {
        let NativeSchemaDocument::ClickHouseTable(schema) = self
            .manager
            .describe_native_schema(
                self.profile_id,
                NativeSchemaDescribeRequest::Table(container.clone()),
            )
            .await?
        else {
            return Err(IpcError::system_internal(
                "ClickHouse Phase 5C Manager Describe returned the wrong document variant",
                "checkpoint=phase_five_c; assertion=manager_table_document_variant",
            ));
        };
        Ok(*schema)
    }
}

#[async_trait]
impl PhaseFiveCSetupDispatcher for ManagerChangeDispatcher<'_> {
    async fn preview_create(
        &self,
        target: &NativeSchemaCreateTarget,
    ) -> IpcResult<crate::engine::native_schema::NativeSchemaMutationPreview> {
        self.manager
            .preview_native_schema_create(self.profile_id, target.clone())
            .await
    }

    async fn execute_create(
        &self,
        request: &NativeSchemaExecuteCreateRequest,
    ) -> IpcResult<NativeSchemaCreateResult> {
        self.manager
            .execute_native_schema_create(self.profile_id, request.clone())
            .await
    }
}

fn table_container(database: &str, table: &str) -> crate::engine::types::ContainerRef {
    crate::engine::types::ContainerRef::table(ContainerKind::Table, database, None, table)
}

fn column(
    name: &str,
    type_name: &str,
    default_kind: ClickHouseColumnDefaultKind,
    default_expression: Option<&str>,
) -> ClickHouseCreateColumnTarget {
    ClickHouseCreateColumnTarget {
        name: name.to_string(),
        type_name: type_name.to_string(),
        default_kind,
        default_expression: default_expression.map(str::to_string),
        codecs: Vec::new(),
        ttl_expression: None,
        comment: None,
    }
}

fn main_table_target(database: &str) -> ClickHouseCreateTableTarget {
    ClickHouseCreateTableTarget {
        database: database.to_string(),
        name: "events".to_string(),
        columns: vec![
            column("id", "UInt64", ClickHouseColumnDefaultKind::None, None),
            column(
                "event_time",
                "DateTime",
                ClickHouseColumnDefaultKind::Default,
                Some("now()"),
            ),
            column("payload", "String", ClickHouseColumnDefaultKind::None, None),
            column(
                "rename_me",
                "String",
                ClickHouseColumnDefaultKind::None,
                None,
            ),
            column("drop_me", "String", ClickHouseColumnDefaultKind::None, None),
            column("type_me", "UInt32", ClickHouseColumnDefaultKind::None, None),
        ],
        engine: ClickHouseCreateEngineTarget {
            family: "MergeTree".to_string(),
            arguments: Vec::new(),
        },
        keys: ClickHouseKeySchema {
            order_by: "(id, cityHash64(id))".to_string(),
            partition_by: None,
            primary_key: Some("(id, cityHash64(id))".to_string()),
            sample_by: Some("id".to_string()),
        },
        table_ttl: None,
        comment: Some("phase 5c baseline".to_string()),
        settings: vec![ClickHouseCreateSettingTarget {
            name: "ttl_only_drop_parts".to_string(),
            value: "0".to_string(),
        }],
    }
}

fn action_table_target(database: &str) -> ClickHouseCreateTableTarget {
    ClickHouseCreateTableTarget {
        database: database.to_string(),
        name: "column_actions".to_string(),
        columns: vec![
            column("id", "UInt64", ClickHouseColumnDefaultKind::None, None),
            column(
                "source",
                "UInt64",
                ClickHouseColumnDefaultKind::Default,
                Some("7"),
            ),
            column(
                "materialized_value",
                "UInt64",
                ClickHouseColumnDefaultKind::Materialized,
                Some("source + 1"),
            ),
        ],
        engine: ClickHouseCreateEngineTarget {
            family: "MergeTree".to_string(),
            arguments: Vec::new(),
        },
        keys: ClickHouseKeySchema {
            order_by: "id".to_string(),
            partition_by: None,
            primary_key: None,
            sample_by: None,
        },
        table_ttl: None,
        comment: None,
        settings: Vec::new(),
    }
}

fn drop_table_target(database: &str) -> ClickHouseCreateTableTarget {
    ClickHouseCreateTableTarget {
        database: database.to_string(),
        name: "drop_target".to_string(),
        columns: vec![column(
            "id",
            "UInt64",
            ClickHouseColumnDefaultKind::None,
            None,
        )],
        engine: ClickHouseCreateEngineTarget {
            family: "MergeTree".to_string(),
            arguments: Vec::new(),
        },
        keys: ClickHouseKeySchema {
            order_by: "id".to_string(),
            partition_by: None,
            primary_key: None,
            sample_by: None,
        },
        table_ttl: None,
        comment: None,
        settings: Vec::new(),
    }
}

fn target_from_schema(schema: &ClickHouseTableSchema) -> IpcResult<ClickHouseCreateTableTarget> {
    ensure(
        schema.editability.mode == ClickHouseSchemaEditabilityMode::Editable
            && schema.editability.blockers.is_empty()
            && schema.projections.is_empty()
            && schema.skipping_indexes.is_empty(),
        "ClickHouse Phase 5C fixture did not receive an editable baseline",
        "assertion=editable_baseline",
    )?;
    let columns = schema
        .columns
        .iter()
        .map(|source| {
            ensure(
                source.codec_expression.is_none(),
                "ClickHouse Phase 5C fixture unexpectedly received a codec expression",
                "assertion=no_fixture_codec",
            )?;
            Ok(ClickHouseCreateColumnTarget {
                name: source.name.clone(),
                type_name: source.type_name.clone(),
                default_kind: source.default_kind,
                default_expression: source.default_expression.clone(),
                codecs: Vec::new(),
                ttl_expression: source.ttl_expression.clone(),
                comment: source.comment.clone(),
            })
        })
        .collect::<IpcResult<Vec<_>>>()?;
    Ok(ClickHouseCreateTableTarget {
        database: schema.identity.database.clone(),
        name: schema.identity.name.clone(),
        columns,
        engine: ClickHouseCreateEngineTarget {
            family: schema.engine.family.clone(),
            arguments: schema.engine.arguments.clone(),
        },
        keys: schema.keys.clone(),
        table_ttl: schema.table_ttl.clone(),
        comment: schema.comment.clone(),
        settings: schema
            .settings
            .iter()
            .filter(|setting| setting.explicit)
            .map(|setting| ClickHouseCreateSettingTarget {
                name: setting.name.clone(),
                value: setting.value.clone(),
            })
            .collect(),
    })
}

async fn create_database(
    setup: &dyn PhaseFiveCSetupDispatcher,
    client: &Client,
    database: &str,
) -> IpcResult<()> {
    let target = NativeSchemaCreateTarget::ClickHouseDatabase(ClickHouseCreateDatabaseTarget {
        name: database.to_string(),
    });
    let preview = setup.preview_create(&target).await?;
    assert_create_preview(&preview)?;
    let result = setup
        .execute_create(&NativeSchemaExecuteCreateRequest {
            target,
            expected_plan_hash: preview.plan_hash,
            confirmation: None,
            baseline: None,
        })
        .await?;
    let NativeSchemaCreateResult::ClickHouseDatabase(result) = result else {
        return Err(checkpoint_error(
            "ClickHouse Phase 5C database setup returned the wrong result variant",
            "checkpoint=phase_five_c; assertion=database_create_variant",
        ));
    };
    ensure(
        result.name == database
            && result.container == crate::engine::types::ContainerRef::database(database)
            && database_exists(client, database).await?,
        "ClickHouse Phase 5C database setup was not verified",
        "assertion=database_create_verified",
    )
}

async fn create_table(
    setup: &dyn PhaseFiveCSetupDispatcher,
    target: &ClickHouseCreateTableTarget,
) -> IpcResult<ClickHouseTableSchema> {
    let tagged = NativeSchemaCreateTarget::ClickHouseTable(Box::new(target.clone()));
    let preview = setup.preview_create(&tagged).await?;
    assert_create_preview(&preview)?;
    let result = setup
        .execute_create(&NativeSchemaExecuteCreateRequest {
            target: tagged,
            expected_plan_hash: preview.plan_hash,
            confirmation: None,
            baseline: None,
        })
        .await?;
    let NativeSchemaCreateResult::ClickHouseTable(result) = result else {
        return Err(checkpoint_error(
            "ClickHouse Phase 5C table setup returned the wrong result variant",
            "checkpoint=phase_five_c; assertion=table_create_variant",
        ));
    };
    ensure(
        result.container == table_container(&target.database, &target.name)
            && result.table_name == target.name
            && is_lowercase_sha256(&result.schema.baseline.revision_hash),
        "ClickHouse Phase 5C table setup was not verified",
        "assertion=table_create_verified",
    )?;
    Ok(result.schema)
}

fn assert_create_preview(
    preview: &crate::engine::native_schema::NativeSchemaMutationPreview,
) -> IpcResult<()> {
    ensure(
        preview.statements.len() == 1
            && !preview.destructive
            && !preview.long_running
            && is_lowercase_sha256(&preview.plan_hash),
        "ClickHouse Phase 5C setup create preview was invalid",
        "assertion=create_preview",
    )
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

fn assert_change_plan(plan: &NativeSchemaChangePlan, destructive: bool) -> IpcResult<()> {
    if plan.statements.is_empty()
        || plan.statements.len() != plan.operations.len()
        || plan.destructive != destructive
        || !is_lowercase_sha256(&plan.plan_hash)
    {
        let operation_codes = plan
            .operations
            .iter()
            .map(|operation| operation.code.as_str())
            .collect::<Vec<_>>()
            .join(",");
        return Err(checkpoint_error(
            format!(
                "ClickHouse Phase 5C change preview was invalid: expected_destructive={destructive}; actual_destructive={}; statements={}; operations={}; operation_codes={operation_codes}",
                plan.destructive,
                plan.statements.len(),
                plan.operations.len(),
            ),
            "checkpoint=phase_five_c; assertion=change_preview",
        ));
    }
    Ok(())
}

async fn expect_execute_error(
    dispatcher: &dyn PhaseFiveCChangeDispatcher,
    target: NativeSchemaChangeTarget,
    plan: &NativeSchemaChangePlan,
    confirm_destructive: bool,
    expected: crate::error::ErrorCode,
    assertion: &'static str,
) -> IpcResult<()> {
    let error = match dispatcher
        .execute_change(&change_request(target, plan, confirm_destructive))
        .await
    {
        Err(error) => error,
        Ok(_) => {
            return Err(checkpoint_error(
                "ClickHouse Phase 5C negative execution unexpectedly succeeded",
                format!("checkpoint=phase_five_c; {assertion}"),
            ));
        }
    };
    ensure(
        error.code == expected,
        "ClickHouse Phase 5C negative execution returned the wrong error",
        assertion,
    )
}

async fn execute_applied_alter(
    dispatcher: &dyn PhaseFiveCChangeDispatcher,
    target: NativeSchemaChangeTarget,
    plan: &NativeSchemaChangePlan,
    confirm_destructive: bool,
    stage: &'static str,
) -> IpcResult<ClickHouseTableSchema> {
    let desired = match &target {
        NativeSchemaChangeTarget::ClickHouseTableAlter(target) => target.desired.clone(),
        _ => {
            return Err(checkpoint_error(
                "ClickHouse Phase 5C ALTER helper received the wrong target",
                "checkpoint=phase_five_c; assertion=alter_helper_target",
            ));
        }
    };
    let result = dispatcher
        .execute_change(&change_request(target, plan, confirm_destructive))
        .await?;
    let NativeSchemaChangeResult::ClickHouseTableAlter(result) = result else {
        return Err(checkpoint_error(
            "ClickHouse Phase 5C ALTER returned the wrong result variant",
            "checkpoint=phase_five_c; assertion=alter_result_variant",
        ));
    };
    let schema = result.schema.ok_or_else(|| {
        checkpoint_error(
            "ClickHouse Phase 5C ALTER did not return a verified schema",
            "checkpoint=phase_five_c; assertion=alter_verified_schema",
        )
    })?;
    if result.status != NativeSchemaExecutionStatus::Applied
        || result.progress.applied_count != plan.statements.len() as u32
        || result.progress.remaining_count != 0
        || result.progress.query_ids.len() != plan.statements.len()
        || !is_lowercase_sha256(&schema.baseline.revision_hash)
    {
        let operation_codes = plan
            .operations
            .iter()
            .map(|operation| operation.code.as_str())
            .collect::<Vec<_>>()
            .join(",");
        let mismatch_categories = schema_mismatch_categories(&desired, &schema).join(",");
        return Err(checkpoint_error(
            format!(
                "ClickHouse Phase 5C ALTER was not fully applied: stage={stage}; status={:?}; planned={}; applied={}; failed_index={:?}; remaining={}; query_ids={}; operation_codes={operation_codes}; mismatches={mismatch_categories}",
                result.status,
                plan.statements.len(),
                result.progress.applied_count,
                result.progress.failed_statement_index,
                result.progress.remaining_count,
                result.progress.query_ids.len(),
            ),
            format!(
                "checkpoint=phase_five_c; assertion=alter_applied; stage={stage}; status={:?}; planned={}; applied={}; remaining={}; query_ids={}; schema_present=true",
                result.status,
                plan.statements.len(),
                result.progress.applied_count,
                result.progress.remaining_count,
                result.progress.query_ids.len(),
            ),
        ));
    }
    Ok(schema)
}

fn schema_mismatch_categories(
    desired: &ClickHouseCreateTableTarget,
    schema: &ClickHouseTableSchema,
) -> Vec<&'static str> {
    let mut categories = Vec::new();
    if desired.database != schema.identity.database || desired.name != schema.identity.name {
        categories.push("identity");
    }
    if desired.engine.family != schema.engine.family
        || desired.engine.arguments.len() != schema.engine.arguments.len()
    {
        categories.push("engine");
    }
    if desired.columns.len() != schema.columns.len() {
        categories.push("columns.count");
    } else {
        for (expected, actual) in desired.columns.iter().zip(&schema.columns) {
            if expected.name != actual.name {
                categories.push("columns.name");
                break;
            }
            if normalize_expression(&expected.type_name) != normalize_expression(&actual.type_name)
            {
                categories.push("columns.type");
                break;
            }
            if expected.default_kind != actual.default_kind
                || normalized_optional(expected.default_expression.as_deref())
                    != normalized_optional(actual.default_expression.as_deref())
            {
                categories.push("columns.default");
                break;
            }
            if normalized_optional(expected.ttl_expression.as_deref())
                != normalized_optional(actual.ttl_expression.as_deref())
            {
                categories.push("columns.ttl");
                break;
            }
            if expected.comment != actual.comment {
                categories.push("columns.comment");
                break;
            }
        }
    }
    if normalize_expression(&desired.keys.order_by) != normalize_expression(&schema.keys.order_by)
        || normalized_optional(desired.keys.partition_by.as_deref())
            != normalized_optional(schema.keys.partition_by.as_deref())
        || normalized_optional(desired.keys.primary_key.as_deref())
            != normalized_optional(schema.keys.primary_key.as_deref())
        || normalized_optional(desired.keys.sample_by.as_deref())
            != normalized_optional(schema.keys.sample_by.as_deref())
    {
        categories.push("keys");
    }
    if normalized_optional(desired.table_ttl.as_deref())
        != normalized_optional(schema.table_ttl.as_deref())
    {
        let actual = schema
            .table_ttl
            .as_deref()
            .map(normalize_expression)
            .unwrap_or_default();
        if actual == normalize_expression("event_time + toIntervalDay(30)") {
            categories.push("table_ttl.to_interval_day_without_delete");
        } else if actual == normalize_expression("event_time + toIntervalDay(30) DELETE") {
            categories.push("table_ttl.to_interval_day_with_delete");
        } else if actual == normalize_expression("event_time + INTERVAL 30 DAY") {
            categories.push("table_ttl.interval_without_delete");
        } else {
            categories.push("table_ttl.other_canonical_form");
        }
    }
    if desired.comment != schema.comment {
        categories.push("table_comment");
    }
    let mut desired_settings = desired
        .settings
        .iter()
        .map(|setting| (&setting.name, &setting.value))
        .collect::<Vec<_>>();
    desired_settings.sort_unstable();
    let mut actual_settings = schema
        .settings
        .iter()
        .filter(|setting| setting.explicit && setting.name != "index_granularity")
        .map(|setting| (&setting.name, &setting.value))
        .collect::<Vec<_>>();
    actual_settings.sort_unstable();
    if desired_settings
        .iter()
        .filter(|(name, _)| name.as_str() != "index_granularity")
        .ne(actual_settings.iter())
    {
        categories.push("settings");
    }
    categories
}

fn normalized_optional(value: Option<&str>) -> Option<String> {
    value.map(normalize_expression)
}

fn normalize_expression(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect()
}

fn safe_alter_target(baseline: ClickHouseTableSchema) -> IpcResult<ClickHouseAlterTableTarget> {
    let mut desired = target_from_schema(&baseline)?;
    let rename_index = desired
        .columns
        .iter()
        .position(|column| column.name == "rename_me")
        .ok_or_else(|| {
            checkpoint_error(
                "ClickHouse Phase 5C safe fixture lost its rename source",
                "checkpoint=phase_five_c; assertion=rename_source",
            )
        })?;
    desired.columns[rename_index].name = "renamed".to_string();
    let payload = desired
        .columns
        .iter_mut()
        .find(|column| column.name == "payload")
        .ok_or_else(|| {
            checkpoint_error(
                "ClickHouse Phase 5C safe fixture lost its payload column",
                "checkpoint=phase_five_c; assertion=payload_column",
            )
        })?;
    payload.comment = Some("phase 5c payload".to_string());
    desired.columns.insert(
        1,
        column(
            "added",
            "UInt32",
            ClickHouseColumnDefaultKind::Default,
            Some("7"),
        ),
    );
    let drop_index = desired
        .columns
        .iter()
        .position(|column| column.name == "drop_me")
        .ok_or_else(|| {
            checkpoint_error(
                "ClickHouse Phase 5C safe fixture lost its drop column",
                "checkpoint=phase_five_c; assertion=drop_column",
            )
        })?;
    let type_index = desired
        .columns
        .iter()
        .position(|column| column.name == "type_me")
        .ok_or_else(|| {
            checkpoint_error(
                "ClickHouse Phase 5C safe fixture lost its type column",
                "checkpoint=phase_five_c; assertion=type_column",
            )
        })?;
    desired.columns.swap(drop_index, type_index);
    desired.keys.sample_by = Some("cityHash64(id)".to_string());
    desired.comment = Some("phase 5c safe".to_string());
    let ttl_only_drop_parts = desired
        .settings
        .iter_mut()
        .find(|setting| setting.name == "ttl_only_drop_parts")
        .ok_or_else(|| {
            checkpoint_error(
                "ClickHouse Phase 5C safe fixture lost its mutable setting",
                "checkpoint=phase_five_c; assertion=mutable_setting",
            )
        })?;
    ttl_only_drop_parts.value = "1".to_string();
    Ok(ClickHouseAlterTableTarget {
        baseline,
        desired,
        column_renames: vec![ClickHouseColumnRenameIntent {
            from: "rename_me".to_string(),
            to: "renamed".to_string(),
        }],
    })
}

fn reset_setting_target(baseline: ClickHouseTableSchema) -> IpcResult<ClickHouseAlterTableTarget> {
    let mut desired = target_from_schema(&baseline)?;
    desired
        .settings
        .retain(|setting| setting.name != "ttl_only_drop_parts");
    Ok(ClickHouseAlterTableTarget {
        baseline,
        desired,
        column_renames: Vec::new(),
    })
}

fn destructive_alter_target(
    baseline: ClickHouseTableSchema,
) -> IpcResult<ClickHouseAlterTableTarget> {
    let mut desired = target_from_schema(&baseline)?;
    desired
        .columns
        .iter_mut()
        .find(|column| column.name == "type_me")
        .ok_or_else(|| {
            checkpoint_error(
                "ClickHouse Phase 5C destructive fixture lost its type column",
                "checkpoint=phase_five_c; assertion=type_column",
            )
        })?
        .type_name = "UInt64".to_string();
    desired.columns.retain(|column| column.name != "drop_me");
    desired.table_ttl = Some("event_time + INTERVAL 30 DAY DELETE".to_string());
    Ok(ClickHouseAlterTableTarget {
        baseline,
        desired,
        column_renames: Vec::new(),
    })
}

fn remove_ttl_target(baseline: ClickHouseTableSchema) -> IpcResult<ClickHouseAlterTableTarget> {
    let mut desired = target_from_schema(&baseline)?;
    desired.table_ttl = None;
    Ok(ClickHouseAlterTableTarget {
        baseline,
        desired,
        column_renames: Vec::new(),
    })
}

async fn run_safe_and_destructive_alter(
    dispatcher: &dyn PhaseFiveCChangeDispatcher,
    baseline: ClickHouseTableSchema,
    evidence: &mut PhaseFiveCEvidence,
) -> IpcResult<ClickHouseTableSchema> {
    let safe_target = safe_alter_target(baseline)?;
    let safe_tagged = NativeSchemaChangeTarget::ClickHouseTableAlter(Box::new(safe_target));
    let safe_plan = dispatcher.preview_change(&safe_tagged).await?;
    assert_change_plan(&safe_plan, false)?;
    for required_code in [
        "rename_column",
        "add_column",
        "reorder_column",
        "comment_column",
        "modify_sample_by",
        "modify_setting",
        "modify_table_comment",
    ] {
        ensure(
            safe_plan
                .operations
                .iter()
                .any(|operation| operation.code == required_code),
            "ClickHouse Phase 5C safe ALTER plan was incomplete",
            "assertion=safe_operation_matrix",
        )?;
    }
    ensure(
        safe_plan
            .expected_target_revision
            .as_deref()
            .is_some_and(is_lowercase_sha256),
        "ClickHouse Phase 5C safe ALTER lacked a target revision",
        "assertion=safe_target_revision",
    )?;
    let safe_schema =
        execute_applied_alter(dispatcher, safe_tagged, &safe_plan, false, "safe").await?;
    evidence.safe_alter_operations += safe_plan.operations.len();

    let reset_setting = reset_setting_target(safe_schema)?;
    let reset_setting_tagged =
        NativeSchemaChangeTarget::ClickHouseTableAlter(Box::new(reset_setting));
    let reset_setting_plan = dispatcher.preview_change(&reset_setting_tagged).await?;
    assert_change_plan(&reset_setting_plan, false)?;
    ensure(
        reset_setting_plan
            .operations
            .iter()
            .any(|operation| operation.code == "reset_setting"),
        "ClickHouse Phase 5C safe setting reset was not planned",
        "assertion=reset_setting_planned",
    )?;
    let safe_schema = execute_applied_alter(
        dispatcher,
        reset_setting_tagged,
        &reset_setting_plan,
        false,
        "reset_setting",
    )
    .await?;
    evidence.safe_alter_operations += reset_setting_plan.operations.len();

    let destructive_target = destructive_alter_target(safe_schema.clone())?;
    let destructive_tagged =
        NativeSchemaChangeTarget::ClickHouseTableAlter(Box::new(destructive_target));
    let destructive_plan = dispatcher.preview_change(&destructive_tagged).await?;
    assert_change_plan(&destructive_plan, true)?;
    let before_rejection = safe_schema.baseline.revision_hash.clone();
    expect_execute_error(
        dispatcher,
        destructive_tagged.clone(),
        &destructive_plan,
        false,
        crate::error::ErrorCode::ValidationFailed,
        "assertion=destructive_confirmation",
    )
    .await?;
    evidence.destructive_rejections += 1;
    let after_rejection = dispatcher
        .describe_table(&table_container(
            &safe_schema.identity.database,
            &safe_schema.identity.name,
        ))
        .await?;
    ensure(
        after_rejection.baseline.revision_hash == before_rejection,
        "ClickHouse Phase 5C rejected ALTER changed the remote table",
        "assertion=destructive_rejection_noop",
    )?;
    let dropped_columns = destructive_plan
        .operations
        .iter()
        .filter(|operation| operation.code == "drop_column")
        .count();
    let destructive_schema = execute_applied_alter(
        dispatcher,
        destructive_tagged,
        &destructive_plan,
        true,
        "destructive",
    )
    .await?;
    evidence.destructive_applied += destructive_plan.operations.len();
    evidence.dropped_columns += dropped_columns;

    let remove_ttl = remove_ttl_target(destructive_schema)?;
    let remove_ttl_tagged = NativeSchemaChangeTarget::ClickHouseTableAlter(Box::new(remove_ttl));
    let remove_ttl_plan = dispatcher.preview_change(&remove_ttl_tagged).await?;
    assert_change_plan(&remove_ttl_plan, true)?;
    expect_execute_error(
        dispatcher,
        remove_ttl_tagged.clone(),
        &remove_ttl_plan,
        false,
        crate::error::ErrorCode::ValidationFailed,
        "assertion=remove_ttl_confirmation",
    )
    .await?;
    evidence.destructive_rejections += 1;
    let schema = execute_applied_alter(
        dispatcher,
        remove_ttl_tagged,
        &remove_ttl_plan,
        true,
        "remove_ttl",
    )
    .await?;
    evidence.destructive_applied += remove_ttl_plan.operations.len();
    Ok(schema)
}

async fn run_unsupported_matrix(
    dispatcher: &dyn PhaseFiveCChangeDispatcher,
    baseline: &ClickHouseTableSchema,
    evidence: &mut PhaseFiveCEvidence,
) -> IpcResult<()> {
    for mutation in ["engine", "order_by", "partition_by", "primary_key"] {
        let mut desired = target_from_schema(baseline)?;
        match mutation {
            "engine" => {
                desired.engine.family = "ReplacingMergeTree".to_string();
                desired.engine.arguments = vec!["id".to_string()];
            }
            "order_by" => desired.keys.order_by = "id".to_string(),
            "partition_by" => desired.keys.partition_by = Some("toYYYYMM(event_time)".to_string()),
            "primary_key" => desired.keys.primary_key = Some("id".to_string()),
            _ => {
                return Err(checkpoint_error(
                    "ClickHouse Phase 5C unsupported fixture contained an unknown mutation",
                    "checkpoint=phase_five_c; assertion=unsupported_fixture_kind",
                ));
            }
        }
        let target =
            NativeSchemaChangeTarget::ClickHouseTableAlter(Box::new(ClickHouseAlterTableTarget {
                baseline: baseline.clone(),
                desired,
                column_renames: Vec::new(),
            }));
        let error = match dispatcher.preview_change(&target).await {
            Err(error) => error,
            Ok(_) => {
                return Err(checkpoint_error(
                    "ClickHouse Phase 5C unsupported ALTER unexpectedly planned",
                    "checkpoint=phase_five_c; assertion=unsupported_alter_planned",
                ));
            }
        };
        ensure(
            error.code == crate::error::ErrorCode::ValidationFailed,
            "ClickHouse Phase 5C unsupported ALTER returned the wrong error",
            "assertion=unsupported_alter",
        )?;
        evidence.unsupported_rejections += 1;
    }
    let remote = dispatcher
        .describe_table(&table_container(
            &baseline.identity.database,
            &baseline.identity.name,
        ))
        .await?;
    ensure(
        remote.baseline.revision_hash == baseline.baseline.revision_hash,
        "ClickHouse Phase 5C unsupported ALTER changed the remote table",
        "assertion=unsupported_noop",
    )
}

async fn run_table_drift(
    dispatcher: &dyn PhaseFiveCChangeDispatcher,
    client: &Client,
    baseline: ClickHouseTableSchema,
    evidence: &mut PhaseFiveCEvidence,
) -> IpcResult<ClickHouseTableSchema> {
    let mut desired = target_from_schema(&baseline)?;
    desired.comment = Some("phase 5c stale".to_string());
    let target =
        NativeSchemaChangeTarget::ClickHouseTableAlter(Box::new(ClickHouseAlterTableTarget {
            baseline: baseline.clone(),
            desired,
            column_renames: Vec::new(),
        }));
    let plan = dispatcher.preview_change(&target).await?;
    assert_change_plan(&plan, false)?;
    let sql = format!(
        "ALTER TABLE {}.{} MODIFY COMMENT 'phase 5c remote drift'",
        quote_identifier(&baseline.identity.database),
        quote_identifier(&baseline.identity.name),
    );
    execute_test_sql(client, &sql, "table_drift").await?;
    expect_execute_error(
        dispatcher,
        target,
        &plan,
        false,
        crate::error::ErrorCode::ResourceConflict,
        "assertion=table_drift_conflict",
    )
    .await?;
    evidence.drift_conflicts += 1;
    let remote = dispatcher
        .describe_table(&table_container(
            &baseline.identity.database,
            &baseline.identity.name,
        ))
        .await?;
    ensure(
        remote.comment.as_deref() == Some("phase 5c remote drift")
            && remote.comment.as_deref() != Some("phase 5c stale"),
        "ClickHouse Phase 5C table drift guard did not preserve the remote fact",
        "assertion=table_drift_preserved",
    )?;
    Ok(remote)
}

async fn run_column_actions(
    setup: &dyn PhaseFiveCSetupDispatcher,
    dispatcher: &dyn PhaseFiveCChangeDispatcher,
    client: &Client,
    database: &str,
    evidence: &mut PhaseFiveCEvidence,
) -> IpcResult<()> {
    let target = action_table_target(database);
    let schema = create_table(setup, &target).await?;
    let insert = format!(
        "INSERT INTO {}.{} (id, source) VALUES (1, 42)",
        quote_identifier(database),
        quote_identifier(&target.name),
    );
    execute_test_sql(client, &insert, "column_action_insert").await?;
    ensure(
        fetch_action_row(client, database, &target.name).await?
            == ColumnActionRow {
                source: 42,
                materialized_value: 43,
            },
        "ClickHouse Phase 5C column action seed row was incorrect",
        "assertion=column_action_seed",
    )?;

    let clear = NativeSchemaChangeTarget::ClickHouseColumnClear(Box::new(
        ClickHouseColumnDataActionTarget {
            baseline: schema,
            column_name: "source".to_string(),
        },
    ));
    let clear_plan = dispatcher.preview_change(&clear).await?;
    assert_change_plan(&clear_plan, true)?;
    expect_execute_error(
        dispatcher,
        clear.clone(),
        &clear_plan,
        false,
        crate::error::ErrorCode::ValidationFailed,
        "assertion=clear_confirmation",
    )
    .await?;
    evidence.destructive_rejections += 1;
    ensure(
        fetch_action_row(client, database, &target.name)
            .await?
            .source
            == 42,
        "ClickHouse Phase 5C rejected CLEAR changed data",
        "assertion=clear_rejection_noop",
    )?;
    assert_submitted_action(
        dispatcher
            .execute_change(&change_request(clear, &clear_plan, true))
            .await?,
        SchemaMutationOperation::Clear,
        "source",
    )?;
    wait_for_action_row(
        client,
        database,
        &target.name,
        "clear",
        ColumnActionRow {
            source: 7,
            materialized_value: 1,
        },
    )
    .await?;
    evidence.submitted_actions += 1;

    let materialize_schema = dispatcher
        .describe_table(&table_container(database, &target.name))
        .await?;
    let materialize = NativeSchemaChangeTarget::ClickHouseColumnMaterialize(Box::new(
        ClickHouseColumnDataActionTarget {
            baseline: materialize_schema,
            column_name: "materialized_value".to_string(),
        },
    ));
    let materialize_plan = dispatcher.preview_change(&materialize).await?;
    assert_change_plan(&materialize_plan, true)?;
    expect_execute_error(
        dispatcher,
        materialize.clone(),
        &materialize_plan,
        false,
        crate::error::ErrorCode::ValidationFailed,
        "assertion=materialize_confirmation",
    )
    .await?;
    evidence.destructive_rejections += 1;
    ensure(
        fetch_action_row(client, database, &target.name)
            .await?
            .materialized_value
            == 1,
        "ClickHouse Phase 5C rejected MATERIALIZE changed data",
        "assertion=materialize_rejection_noop",
    )?;
    assert_submitted_action(
        dispatcher
            .execute_change(&change_request(materialize, &materialize_plan, true))
            .await?,
        SchemaMutationOperation::Materialize,
        "materialized_value",
    )?;
    wait_for_action_row(
        client,
        database,
        &target.name,
        "materialize",
        ColumnActionRow {
            source: 7,
            materialized_value: 8,
        },
    )
    .await?;
    evidence.submitted_actions += 1;
    Ok(())
}

fn assert_submitted_action(
    result: NativeSchemaChangeResult,
    operation: SchemaMutationOperation,
    column_name: &str,
) -> IpcResult<()> {
    let NativeSchemaChangeResult::ClickHouseColumnAction(result) = result else {
        return Err(checkpoint_error(
            "ClickHouse Phase 5C column action returned the wrong result variant",
            "checkpoint=phase_five_c; assertion=column_action_variant",
        ));
    };
    ensure(
        result.status == NativeSchemaExecutionStatus::Submitted
            && result.operation == operation
            && result.column_name == column_name
            && result.progress.applied_count == 1
            && result.progress.query_ids.len() == 1,
        "ClickHouse Phase 5C column action was not reported as submitted",
        "assertion=column_action_submitted",
    )
}

async fn run_table_drop(
    setup: &dyn PhaseFiveCSetupDispatcher,
    dispatcher: &dyn PhaseFiveCChangeDispatcher,
    client: &Client,
    database: &str,
    evidence: &mut PhaseFiveCEvidence,
) -> IpcResult<()> {
    let create_target = drop_table_target(database);
    create_table(setup, &create_target).await?;
    let container = table_container(database, &create_target.name);
    let target = NativeSchemaChangeTarget::ClickHouseTableDrop(ClickHouseDropTableTarget {
        container: container.clone(),
    });
    let plan = dispatcher.preview_change(&target).await?;
    assert_change_plan(&plan, true)?;
    ensure(
        plan.statements.len() == 1 && !plan.statements[0].contains("IF EXISTS"),
        "ClickHouse Phase 5C table drop preview hid absence",
        "assertion=table_drop_exact_sql",
    )?;
    expect_execute_error(
        dispatcher,
        target.clone(),
        &plan,
        false,
        crate::error::ErrorCode::ValidationFailed,
        "assertion=table_drop_confirmation",
    )
    .await?;
    evidence.destructive_rejections += 1;
    ensure(
        table_exists(client, database, &create_target.name).await?,
        "ClickHouse Phase 5C rejected table drop removed the table",
        "assertion=table_drop_rejection_noop",
    )?;
    let result = dispatcher
        .execute_change(&change_request(target, &plan, true))
        .await?;
    let NativeSchemaChangeResult::ClickHouseTableDrop(result) = result else {
        return Err(checkpoint_error(
            "ClickHouse Phase 5C table drop returned the wrong result variant",
            "checkpoint=phase_five_c; assertion=table_drop_variant",
        ));
    };
    ensure(
        result.status == NativeSchemaExecutionStatus::Applied
            && result.absent
            && result.container == container
            && !table_exists(client, database, &create_target.name).await?,
        "ClickHouse Phase 5C table drop did not prove absence",
        "assertion=table_drop_applied",
    )?;
    evidence.dropped_tables += 1;
    Ok(())
}

async fn run_database_drop(
    dispatcher: &dyn PhaseFiveCChangeDispatcher,
    client: &Client,
    database: &str,
    evidence: &mut PhaseFiveCEvidence,
) -> IpcResult<()> {
    let target = NativeSchemaChangeTarget::ClickHouseDatabaseDrop(ClickHouseDropDatabaseTarget {
        container: crate::engine::types::ContainerRef::database(database),
    });
    let stale_plan = dispatcher.preview_change(&target).await?;
    assert_change_plan(&stale_plan, true)?;
    let drift_child = format!(
        "CREATE TABLE {}.{} (id UInt64) ENGINE = MergeTree ORDER BY id",
        quote_identifier(database),
        quote_identifier("database_drift_child"),
    );
    execute_test_sql(client, &drift_child, "database_drift").await?;
    expect_execute_error(
        dispatcher,
        target.clone(),
        &stale_plan,
        true,
        crate::error::ErrorCode::ResourceConflict,
        "assertion=database_drift_conflict",
    )
    .await?;
    evidence.drift_conflicts += 1;
    ensure(
        database_exists(client, database).await?
            && table_exists(client, database, "database_drift_child").await?,
        "ClickHouse Phase 5C database drift guard changed the remote database",
        "assertion=database_drift_preserved",
    )?;

    let plan = dispatcher.preview_change(&target).await?;
    assert_change_plan(&plan, true)?;
    expect_execute_error(
        dispatcher,
        target.clone(),
        &plan,
        false,
        crate::error::ErrorCode::ValidationFailed,
        "assertion=database_drop_confirmation",
    )
    .await?;
    evidence.destructive_rejections += 1;
    let result = dispatcher
        .execute_change(&change_request(target, &plan, true))
        .await?;
    let NativeSchemaChangeResult::ClickHouseDatabaseDrop(result) = result else {
        return Err(checkpoint_error(
            "ClickHouse Phase 5C database drop returned the wrong result variant",
            "checkpoint=phase_five_c; assertion=database_drop_variant",
        ));
    };
    ensure(
        result.status == NativeSchemaExecutionStatus::Applied
            && result.absent
            && result.name == database
            && !database_exists(client, database).await?,
        "ClickHouse Phase 5C database drop did not prove absence",
        "assertion=database_drop_applied",
    )?;
    evidence.dropped_databases += 1;
    Ok(())
}

async fn run_checkpoint(
    setup: &dyn PhaseFiveCSetupDispatcher,
    dispatcher: &dyn PhaseFiveCChangeDispatcher,
    client: &Client,
    database: &str,
) -> IpcResult<PhaseFiveCEvidence> {
    let mut evidence = PhaseFiveCEvidence {
        server_version: server_version(client).await?,
        safe_alter_operations: 0,
        destructive_rejections: 0,
        destructive_applied: 0,
        drift_conflicts: 0,
        unsupported_rejections: 0,
        submitted_actions: 0,
        dropped_columns: 0,
        dropped_tables: 0,
        dropped_databases: 0,
    };
    create_database(setup, client, database).await?;
    let baseline = create_table(setup, &main_table_target(database)).await?;
    let altered = run_safe_and_destructive_alter(dispatcher, baseline, &mut evidence).await?;
    run_unsupported_matrix(dispatcher, &altered, &mut evidence).await?;
    run_table_drift(dispatcher, client, altered, &mut evidence).await?;
    run_column_actions(setup, dispatcher, client, database, &mut evidence).await?;
    run_table_drop(setup, dispatcher, client, database, &mut evidence).await?;
    run_database_drop(dispatcher, client, database, &mut evidence).await?;
    ensure(
        evidence.safe_alter_operations > 0
            && evidence.destructive_rejections > 0
            && evidence.destructive_applied > 0
            && evidence.drift_conflicts == 2
            && evidence.unsupported_rejections == 4
            && evidence.submitted_actions == 2
            && evidence.dropped_columns > 0
            && evidence.dropped_tables == 1
            && evidence.dropped_databases == 1,
        "ClickHouse Phase 5C evidence matrix was incomplete",
        "assertion=nonzero_evidence",
    )?;
    Ok(evidence)
}

pub(super) async fn run_direct(
    record: &StoredConnectionRecord,
    client: &Client,
    prefix: &str,
) -> IpcResult<PhaseFiveCEvidence> {
    let database_name = unique_database_name(prefix)?;
    let cleanup = DatabaseCleanupGuard::new(database_name.clone(), prefix)?;
    let driver = DriverRegistry::create_driver("real-clickhouse-phase-5c-direct", record).await?;
    let capability_check = validate_capability_expectation(
        &driver.capabilities(),
        PhaseFiveCCapabilityExpectation::Published,
    );
    let extension_check = ensure(
        driver.as_schema_mutator().is_none() && driver.as_native_schema_extension().is_some(),
        "ClickHouse Phase 5C direct driver exposed the wrong extension set",
        "assertion=driver_extensions",
    );
    let initial_cleanup = cleanup.cleanup(client).await;
    let checkpoint = match (capability_check, extension_check, initial_cleanup) {
        (Ok(()), Ok(()), Ok(())) => match driver.as_native_schema_extension() {
            Some(extension) => {
                let dispatcher = DirectChangeDispatcher { extension };
                run_checkpoint(&dispatcher, &dispatcher, client, &database_name).await
            }
            None => Err(checkpoint_error(
                "ClickHouse Phase 5C native schema extension disappeared",
                "checkpoint=phase_five_c; assertion=extension_stable",
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
) -> IpcResult<PhaseFiveCEvidence> {
    let database_name = unique_database_name(prefix)?;
    let cleanup = DatabaseCleanupGuard::new(database_name.clone(), prefix)?;
    let runtime = manager.capabilities(profile_id)?;
    let capability_check = validate_capability_expectation(
        &runtime.capabilities,
        PhaseFiveCCapabilityExpectation::Published,
    );
    let initial_cleanup = cleanup.cleanup(client).await;
    let checkpoint = match (capability_check, initial_cleanup) {
        (Ok(()), Ok(())) => {
            let dispatcher = ManagerChangeDispatcher {
                manager,
                profile_id,
            };
            run_checkpoint(&dispatcher, &dispatcher, client, &database_name).await
        }
        (Err(error), _) | (_, Err(error)) => Err(error),
    };
    let cleanup_result = cleanup.cleanup(client).await;
    merge_checkpoint_and_cleanup(checkpoint, cleanup_result)
}

fn merge_cleanup_and_close(cleanup: IpcResult<()>, close: IpcResult<()>) -> IpcResult<()> {
    match (cleanup, close) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) => Err(error),
        (Ok(()), Err(error)) => Err(checkpoint_error(
            "ClickHouse Phase 5C isolated driver close failed",
            format!(
                "checkpoint=phase_five_c; operation=close_driver; code={:?}",
                error.code
            ),
        )),
        (Err(error), Err(_close_error)) => Err(checkpoint_error(
            "ClickHouse Phase 5C cleanup and isolated driver close both failed",
            format!(
                "checkpoint=phase_five_c; cleanup_code={:?}; close_failed=true",
                error.code
            ),
        )),
    }
}

async fn server_version(client: &Client) -> IpcResult<String> {
    let row = client
        .query("SELECT version() AS version")
        .fetch_one::<VersionRow>()
        .await
        .map_err(|_| {
            checkpoint_error(
                "ClickHouse Phase 5C version probe failed",
                "checkpoint=phase_five_c; operation=version_probe",
            )
        })?;
    ensure(
        !row.version.trim().is_empty(),
        "ClickHouse Phase 5C version probe returned an empty value",
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
                "ClickHouse Phase 5C database verification failed",
                "checkpoint=phase_five_c; operation=verify_database",
            )
        })
}

async fn table_exists(client: &Client, database: &str, table: &str) -> IpcResult<bool> {
    client
        .query("SELECT count() AS count FROM system.tables WHERE database = ? AND name = ?")
        .bind(database)
        .bind(table)
        .fetch_one::<CountRow>()
        .await
        .map(|row| row.count > 0)
        .map_err(|_| {
            checkpoint_error(
                "ClickHouse Phase 5C table verification failed",
                "checkpoint=phase_five_c; operation=verify_table",
            )
        })
}

async fn execute_test_sql(client: &Client, sql: &str, operation: &'static str) -> IpcResult<()> {
    client.query(sql).execute().await.map_err(|_| {
        checkpoint_error(
            "ClickHouse Phase 5C independent test operation failed",
            format!("checkpoint=phase_five_c; operation={operation}"),
        )
    })
}

async fn fetch_action_row(
    client: &Client,
    database: &str,
    table: &str,
) -> IpcResult<ColumnActionRow> {
    let sql = format!(
        "SELECT source, materialized_value FROM {}.{} WHERE id = 1",
        quote_identifier(database),
        quote_identifier(table),
    );
    client
        .query(&sql)
        .fetch_one::<ColumnActionRow>()
        .await
        .map_err(|_| {
            checkpoint_error(
                "ClickHouse Phase 5C column action evidence query failed",
                "checkpoint=phase_five_c; operation=query_column_action_row",
            )
        })
}

async fn pending_mutations(client: &Client, database: &str, table: &str) -> IpcResult<u64> {
    client
        .query(
            "SELECT count() AS count FROM system.mutations WHERE database = ? AND table = ? AND is_done = 0",
        )
        .bind(database)
        .bind(table)
        .fetch_one::<CountRow>()
        .await
        .map(|row| row.count)
        .map_err(|_| {
            checkpoint_error(
                "ClickHouse Phase 5C mutation evidence query failed",
                "checkpoint=phase_five_c; operation=query_mutation_status",
            )
        })
}

async fn wait_for_action_row(
    client: &Client,
    database: &str,
    table: &str,
    stage: &'static str,
    expected: ColumnActionRow,
) -> IpcResult<()> {
    let mut last_row = None;
    let mut last_pending = None;
    for _ in 0..100 {
        let row = fetch_action_row(client, database, table).await?;
        let pending = pending_mutations(client, database, table).await?;
        if row == expected && pending == 0 {
            return Ok(());
        }
        last_row = Some(row);
        last_pending = Some(pending);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(checkpoint_error(
        format!(
            "ClickHouse Phase 5C column action evidence did not converge: stage={stage}; last_row={last_row:?}; pending={last_pending:?}"
        ),
        "checkpoint=phase_five_c; assertion=column_action_converged",
    ))
}
