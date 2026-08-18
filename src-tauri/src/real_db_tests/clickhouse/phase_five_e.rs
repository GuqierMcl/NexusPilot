use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use clickhouse::Client;
use serde::Deserialize;

use crate::engine::driver::DatabaseDriver;
use crate::engine::drivers::clickhouse::schema::{
    view_queries_semantically_equal, ClickHouseCreateEngineTarget, ClickHouseMaterializedStorage,
    ClickHouseRefreshDefinition, ClickHouseRefreshMode, ClickHouseRefreshSettings,
    ClickHouseSchemaEditabilityMode, ClickHouseSupportState, ClickHouseViewAddress,
    ClickHouseViewAlterTarget, ClickHouseViewChangeResult, ClickHouseViewColumnDefinition,
    ClickHouseViewCreateTarget, ClickHouseViewDefinitionTarget, ClickHouseViewDropTarget,
    ClickHouseViewFamily, ClickHouseViewFamilyDefinition, ClickHouseViewInterval,
    ClickHouseViewIntervalUnit, ClickHouseViewParameter, ClickHouseViewRenameTarget,
    ClickHouseViewRuntimeSupport, ClickHouseViewSchema, ClickHouseViewScope,
    ClickHouseViewScopeTarget, ClickHouseViewSecurity, ClickHouseViewSqlSecurity,
    ClickHouseWindowWatermark,
};
use crate::engine::manager::ConnectionRuntimeManager;
use crate::engine::native_schema::{
    NativeSchemaChangePlan, NativeSchemaChangeResult, NativeSchemaChangeTarget,
    NativeSchemaConfirmationInput, NativeSchemaCreateResult, NativeSchemaCreateTarget,
    NativeSchemaDescribeRequest, NativeSchemaDocument, NativeSchemaExecuteChangeRequest,
    NativeSchemaExecuteCreateRequest, NativeSchemaExecutionStatus, NativeSchemaExtension,
    NativeSchemaMutationPreview, NativeSchemaRequiredConfirmation, NativeSchemaRiskFlag,
    NativeSchemaSupportDocument, NativeSchemaSupportRequest,
};
use crate::engine::registry::DriverRegistry;
use crate::engine::types::{
    ContainerKind, ContainerRef, DriverCapabilities, QueryResult, SchemaMutationOperation,
    SqlExecutionContext,
};
use crate::error::{ErrorCode, IpcError, IpcResult};
use crate::repository::connection_repository::StoredConnectionRecord;

use super::phase_five_a::quote_identifier;

const SOURCE_TABLE: &str = "view_source";
const DESTINATION_TABLE: &str = "view_destination";
const REFRESH_DESTINATION_TABLE: &str = "refresh_destination";
const WINDOW_DESTINATION_TABLE: &str = "window_destination";
const NORMAL_VIEW: &str = "normal_view";
const PARAMETERIZED_VIEW: &str = "parameterized_view";
const MATERIALIZED_VIEW: &str = "incremental_mv";
const INNER_MATERIALIZED_VIEW: &str = "inner_incremental_mv";
const REFRESHABLE_VIEW: &str = "refreshable_mv";
const REFRESH_DEPENDENCY_VIEW: &str = "refresh_dependency_view";
const WINDOW_VIEW: &str = "window_view";
const LIVE_VIEW: &str = "live_view";
const TEMPORARY_VIEW: &str = "temporary_view";
const OWNER_TAB_RUNTIME_ID: &str = "real-clickhouse-phase-5e-owner";

static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(clickhouse::Row, Deserialize)]
struct CountRow {
    count: u64,
}

struct PhaseFiveECleanupGuard {
    database_name: String,
    scratch_prefix: String,
}

impl PhaseFiveECleanupGuard {
    fn new(database_name: String, scratch_prefix: &str) -> IpcResult<Self> {
        cleanup_statements(&database_name, scratch_prefix)?;
        Ok(Self {
            database_name,
            scratch_prefix: scratch_prefix.to_string(),
        })
    }

    async fn cleanup(&self, client: &Client) -> IpcResult<()> {
        for statement in cleanup_statements(&self.database_name, &self.scratch_prefix)? {
            let _ = client.query(&statement).execute().await;
        }
        ensure(
            !database_exists(client, &self.database_name).await?,
            "ClickHouse Phase 5E scratch database remained after cleanup",
            "assertion=cleanup_absence",
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct PhaseFiveEEvidence {
    pub server_version: String,
    pub normal: usize,
    pub parameterized: usize,
    pub temporary: usize,
    pub materialized: usize,
    pub refreshable: usize,
    pub window_supported: usize,
    pub window_unavailable: usize,
    pub live_supported: usize,
    pub live_unavailable: usize,
    pub alters: usize,
    pub renames: usize,
    pub drops: usize,
    pub confirmation_rejections: usize,
    pub drift_conflicts: usize,
    pub background_observations: usize,
}

impl PhaseFiveEEvidence {
    pub(super) fn validate_counts(&self) -> IpcResult<()> {
        ensure(
            !self.server_version.trim().is_empty()
                && self.normal > 0
                && self.parameterized > 0
                && self.temporary > 0
                && self.materialized > 0
                && self.refreshable > 0
                && (self.window_supported > 0) ^ (self.window_unavailable > 0)
                && (self.live_supported > 0) ^ (self.live_unavailable > 0)
                && self.alters > 0
                && self.renames > 0
                && self.drops > 0
                && self.confirmation_rejections > 0
                && self.drift_conflicts > 0
                && self.background_observations > 0,
            "ClickHouse Phase 5E evidence matrix was incomplete",
            "assertion=nonzero_exclusive_evidence",
        )
    }

    pub(super) fn marker(&self) -> String {
        format!(
            "ClickHouse Phase 5E direct view checkpoint passed: server={}; normal={}; parameterized={}; temporary={}; materialized={}; refreshable={}; window_supported={}; window_unavailable={}; live_supported={}; live_unavailable={}; alters={}; renames={}; drops={}; confirmation_rejections={}; drift_conflicts={}; background_observations={}",
            self.server_version,
            self.normal,
            self.parameterized,
            self.temporary,
            self.materialized,
            self.refreshable,
            self.window_supported,
            self.window_unavailable,
            self.live_supported,
            self.live_unavailable,
            self.alters,
            self.renames,
            self.drops,
            self.confirmation_rejections,
            self.drift_conflicts,
            self.background_observations,
        )
    }

    pub(super) fn manager_marker(&self) -> String {
        self.marker()
            .replacen("direct view", "Manager-gated view", 1)
    }
}

pub(super) fn unique_database_name(prefix: &str) -> IpcResult<String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| checkpoint_error("ClickHouse Phase 5E fixture clock was invalid"))?
        .as_millis();
    let sequence = FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let name = format!("{prefix}phase5e_{timestamp}_{sequence}");
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
            && database_name.starts_with(&format!("{prefix}phase5e_"))
            && database_name.len() > prefix.len() + "phase5e_".len()
            && database_name
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_'),
        "ClickHouse Phase 5E refused an out-of-scope cleanup target",
        "assertion=scratch_prefix_scope",
    )
}

pub(super) fn cleanup_statements(database_name: &str, prefix: &str) -> IpcResult<Vec<String>> {
    validate_database_scope(database_name, prefix)?;
    let database = quote_identifier(database_name);
    let mut statements = [
        NORMAL_VIEW,
        PARAMETERIZED_VIEW,
        MATERIALIZED_VIEW,
        INNER_MATERIALIZED_VIEW,
        REFRESHABLE_VIEW,
        REFRESH_DEPENDENCY_VIEW,
        WINDOW_VIEW,
        LIVE_VIEW,
    ]
    .into_iter()
    .map(|name| {
        format!(
            "DROP VIEW IF EXISTS {database}.{} SYNC",
            quote_identifier(name)
        )
    })
    .collect::<Vec<_>>();
    statements.extend(
        [
            SOURCE_TABLE,
            DESTINATION_TABLE,
            REFRESH_DESTINATION_TABLE,
            WINDOW_DESTINATION_TABLE,
        ]
        .into_iter()
        .map(|name| {
            format!(
                "DROP TABLE IF EXISTS {database}.{} SYNC",
                quote_identifier(name)
            )
        }),
    );
    statements.push(format!("DROP DATABASE IF EXISTS {database} SYNC"));
    Ok(statements)
}

pub(super) fn validate_capability_closed(capabilities: &DriverCapabilities) -> IpcResult<()> {
    let mutation = capabilities.schema_mutation.as_ref().ok_or_else(|| {
        checkpoint_error("ClickHouse Phase 5E expected native schema capabilities")
    })?;
    let exact_phase_five_d = mutation.objects.len() == 5
        && mutation.supports(ContainerKind::Database, SchemaMutationOperation::Create)
        && mutation.supports(ContainerKind::Database, SchemaMutationOperation::Drop)
        && mutation.supports(ContainerKind::Table, SchemaMutationOperation::Create)
        && mutation.supports(ContainerKind::Table, SchemaMutationOperation::Alter)
        && mutation.supports(ContainerKind::Table, SchemaMutationOperation::Drop)
        && mutation.supports(ContainerKind::Column, SchemaMutationOperation::Clear)
        && mutation.supports(ContainerKind::Column, SchemaMutationOperation::Materialize)
        && [ContainerKind::Projection, ContainerKind::Index]
            .into_iter()
            .all(|kind| {
                [
                    SchemaMutationOperation::Create,
                    SchemaMutationOperation::Drop,
                    SchemaMutationOperation::Clear,
                    SchemaMutationOperation::Materialize,
                ]
                .into_iter()
                .all(|operation| mutation.supports(kind.clone(), operation))
            });
    let view_operations_closed = [ContainerKind::View, ContainerKind::MaterializedView]
        .into_iter()
        .all(|kind| {
            [
                SchemaMutationOperation::Create,
                SchemaMutationOperation::Alter,
                SchemaMutationOperation::Rename,
                SchemaMutationOperation::Drop,
            ]
            .into_iter()
            .all(|operation| !mutation.supports(kind.clone(), operation))
        });
    ensure(
        !capabilities.schema_mutator
            && exact_phase_five_d
            && view_operations_closed
            && mutation.ddl_preview
            && mutation.destructive_confirmation
            && mutation.remote_drift_protection,
        "ClickHouse View capability opened before the Phase 5E Direct gates",
        "assertion=phase_five_d_exact_matrix",
    )
}

pub(super) fn validate_capability_published(capabilities: &DriverCapabilities) -> IpcResult<()> {
    let mutation = capabilities.schema_mutation.as_ref().ok_or_else(|| {
        checkpoint_error("ClickHouse Phase 5E expected native schema capabilities")
    })?;
    let exact_phase_five_e = mutation.objects.len() == 7
        && mutation.supports(ContainerKind::Database, SchemaMutationOperation::Create)
        && mutation.supports(ContainerKind::Database, SchemaMutationOperation::Drop)
        && mutation.supports(ContainerKind::Table, SchemaMutationOperation::Create)
        && mutation.supports(ContainerKind::Table, SchemaMutationOperation::Alter)
        && mutation.supports(ContainerKind::Table, SchemaMutationOperation::Drop)
        && mutation.supports(ContainerKind::Column, SchemaMutationOperation::Clear)
        && mutation.supports(ContainerKind::Column, SchemaMutationOperation::Materialize)
        && [ContainerKind::Projection, ContainerKind::Index]
            .into_iter()
            .all(|kind| {
                [
                    SchemaMutationOperation::Create,
                    SchemaMutationOperation::Drop,
                    SchemaMutationOperation::Clear,
                    SchemaMutationOperation::Materialize,
                ]
                .into_iter()
                .all(|operation| mutation.supports(kind.clone(), operation))
            })
        && [ContainerKind::View, ContainerKind::MaterializedView]
            .into_iter()
            .all(|kind| {
                [
                    SchemaMutationOperation::Create,
                    SchemaMutationOperation::Alter,
                    SchemaMutationOperation::Rename,
                    SchemaMutationOperation::Drop,
                ]
                .into_iter()
                .all(|operation| mutation.supports(kind.clone(), operation))
            });
    ensure(
        !capabilities.schema_mutator
            && exact_phase_five_e
            && mutation.ddl_preview
            && mutation.destructive_confirmation
            && mutation.remote_drift_protection,
        "ClickHouse Phase 5E published capability matrix was not exact",
        "assertion=phase_five_e_exact_matrix",
    )
}

#[async_trait]
trait PhaseFiveEDispatcher {
    async fn support(
        &self,
        request: &NativeSchemaSupportRequest,
    ) -> IpcResult<NativeSchemaSupportDocument>;
    async fn describe(
        &self,
        request: &NativeSchemaDescribeRequest,
        temporary: bool,
    ) -> IpcResult<NativeSchemaDocument>;
    async fn preview_create(
        &self,
        target: &NativeSchemaCreateTarget,
        temporary: bool,
    ) -> IpcResult<NativeSchemaMutationPreview>;
    async fn execute_create(
        &self,
        request: &NativeSchemaExecuteCreateRequest,
        temporary: bool,
    ) -> IpcResult<NativeSchemaCreateResult>;
    async fn preview_change(
        &self,
        target: &NativeSchemaChangeTarget,
        temporary: bool,
    ) -> IpcResult<NativeSchemaChangePlan>;
    async fn execute_change(
        &self,
        request: &NativeSchemaExecuteChangeRequest,
        temporary: bool,
    ) -> IpcResult<NativeSchemaChangeResult>;
    async fn query_temporary(&self, database: &str, sql: &str) -> IpcResult<QueryResult>;
    async fn expire_temporary_owner(&self) -> IpcResult<()>;
}

struct DirectPhaseFiveEDispatcher<'a> {
    extension: &'a dyn NativeSchemaExtension,
    tab_extension: &'a dyn NativeSchemaExtension,
    tab_driver: &'a dyn DatabaseDriver,
}

#[async_trait]
impl PhaseFiveEDispatcher for DirectPhaseFiveEDispatcher<'_> {
    async fn support(
        &self,
        request: &NativeSchemaSupportRequest,
    ) -> IpcResult<NativeSchemaSupportDocument> {
        self.extension.support(request).await
    }

    async fn describe(
        &self,
        request: &NativeSchemaDescribeRequest,
        temporary: bool,
    ) -> IpcResult<NativeSchemaDocument> {
        if temporary {
            self.tab_extension.describe(request).await
        } else {
            self.extension.describe(request).await
        }
    }

    async fn preview_create(
        &self,
        target: &NativeSchemaCreateTarget,
        temporary: bool,
    ) -> IpcResult<NativeSchemaMutationPreview> {
        if temporary {
            self.tab_extension.preview_create(target).await
        } else {
            self.extension.preview_create(target).await
        }
    }

    async fn execute_create(
        &self,
        request: &NativeSchemaExecuteCreateRequest,
        temporary: bool,
    ) -> IpcResult<NativeSchemaCreateResult> {
        if temporary {
            self.tab_extension.execute_create(request).await
        } else {
            self.extension.execute_create(request).await
        }
    }

    async fn preview_change(
        &self,
        target: &NativeSchemaChangeTarget,
        temporary: bool,
    ) -> IpcResult<NativeSchemaChangePlan> {
        if temporary {
            self.tab_extension.preview_change(target).await
        } else {
            self.extension.preview_change(target).await
        }
    }

    async fn execute_change(
        &self,
        request: &NativeSchemaExecuteChangeRequest,
        temporary: bool,
    ) -> IpcResult<NativeSchemaChangeResult> {
        if temporary {
            self.tab_extension.execute_change(request).await
        } else {
            self.extension.execute_change(request).await
        }
    }

    async fn query_temporary(&self, database: &str, sql: &str) -> IpcResult<QueryResult> {
        let executor = self
            .tab_driver
            .as_sql_executor()
            .ok_or_else(|| checkpoint_error("ClickHouse Phase 5E tab driver lost SQL execution"))?;
        executor
            .execute_sql(
                &SqlExecutionContext {
                    database: Some(database.to_string()),
                    schema: None,
                },
                sql,
                1,
                100,
            )
            .await
    }

    async fn expire_temporary_owner(&self) -> IpcResult<()> {
        self.tab_driver.close().await
    }
}

struct ManagerPhaseFiveEDispatcher<'a> {
    manager: &'a ConnectionRuntimeManager,
    profile_id: &'a str,
    owner_tab_runtime_id: &'a str,
}

impl ManagerPhaseFiveEDispatcher<'_> {
    fn owner_for_support<'a>(&'a self, request: &NativeSchemaSupportRequest) -> Option<&'a str> {
        match request {
            NativeSchemaSupportRequest::ClickHouseView { database: None, .. } => {
                Some(self.owner_tab_runtime_id)
            }
            NativeSchemaSupportRequest::ClickHouseView {
                database: Some(_), ..
            } => None,
        }
    }

    fn owner_for_scope(&self, temporary: bool) -> Option<&str> {
        temporary.then_some(self.owner_tab_runtime_id)
    }
}

#[async_trait]
impl PhaseFiveEDispatcher for ManagerPhaseFiveEDispatcher<'_> {
    async fn support(
        &self,
        request: &NativeSchemaSupportRequest,
    ) -> IpcResult<NativeSchemaSupportDocument> {
        self.manager
            .get_native_schema_support_in_runtime(
                self.profile_id,
                self.owner_for_support(request),
                request.clone(),
            )
            .await
    }

    async fn describe(
        &self,
        request: &NativeSchemaDescribeRequest,
        temporary: bool,
    ) -> IpcResult<NativeSchemaDocument> {
        self.manager
            .describe_native_schema_in_runtime(
                self.profile_id,
                self.owner_for_scope(temporary),
                request.clone(),
            )
            .await
    }

    async fn preview_create(
        &self,
        target: &NativeSchemaCreateTarget,
        temporary: bool,
    ) -> IpcResult<NativeSchemaMutationPreview> {
        self.manager
            .preview_native_schema_create_in_runtime(
                self.profile_id,
                self.owner_for_scope(temporary),
                target.clone(),
            )
            .await
    }

    async fn execute_create(
        &self,
        request: &NativeSchemaExecuteCreateRequest,
        temporary: bool,
    ) -> IpcResult<NativeSchemaCreateResult> {
        self.manager
            .execute_native_schema_create_in_runtime(
                self.profile_id,
                self.owner_for_scope(temporary),
                request.clone(),
            )
            .await
    }

    async fn preview_change(
        &self,
        target: &NativeSchemaChangeTarget,
        temporary: bool,
    ) -> IpcResult<NativeSchemaChangePlan> {
        self.manager
            .preview_native_schema_change_in_runtime(
                self.profile_id,
                self.owner_for_scope(temporary),
                target.clone(),
            )
            .await
    }

    async fn execute_change(
        &self,
        request: &NativeSchemaExecuteChangeRequest,
        temporary: bool,
    ) -> IpcResult<NativeSchemaChangeResult> {
        self.manager
            .execute_native_schema_change_in_runtime(
                self.profile_id,
                self.owner_for_scope(temporary),
                request.clone(),
            )
            .await
    }

    async fn query_temporary(&self, database: &str, sql: &str) -> IpcResult<QueryResult> {
        self.manager
            .execute_sql(
                self.profile_id,
                self.owner_tab_runtime_id,
                &SqlExecutionContext {
                    database: Some(database.to_string()),
                    schema: None,
                },
                sql,
                1,
                100,
            )
            .await
    }

    async fn expire_temporary_owner(&self) -> IpcResult<()> {
        self.manager
            .close_tab_runtime(self.owner_tab_runtime_id)
            .await
    }
}

async fn runtime_support<D: PhaseFiveEDispatcher>(
    dispatcher: &D,
    database: Option<&str>,
) -> IpcResult<ClickHouseViewRuntimeSupport> {
    match dispatcher
        .support(&NativeSchemaSupportRequest::ClickHouseView {
            database: database.map(str::to_string),
            cluster_name: None,
        })
        .await?
    {
        NativeSchemaSupportDocument::ClickHouseView(support) => Ok(support),
    }
}

fn address(
    database: Option<&str>,
    name: &str,
    object_kind: ContainerKind,
) -> ClickHouseViewAddress {
    ClickHouseViewAddress {
        database: database.map(str::to_string),
        name: name.to_string(),
        object_kind,
    }
}

fn container(address: &ClickHouseViewAddress) -> ContainerRef {
    let mut container = ContainerRef::table(
        address.object_kind.clone(),
        address.database.as_deref().unwrap_or_default(),
        None,
        &address.name,
    );
    if address.database.is_none() {
        container.database = None;
    }
    container
}

fn empty_security() -> ClickHouseViewSecurity {
    ClickHouseViewSecurity {
        definer: None,
        sql_security: None,
    }
}

fn normal_definition(database: &str, name: &str, query: String) -> ClickHouseViewDefinitionTarget {
    ClickHouseViewDefinitionTarget {
        address: address(Some(database), name, ContainerKind::View),
        family: ClickHouseViewFamily::Normal,
        scope: ClickHouseViewScopeTarget::Local,
        columns: ClickHouseViewColumnDefinition::None,
        query,
        security: empty_security(),
        comment: None,
        family_definition: ClickHouseViewFamilyDefinition::Normal,
    }
}

fn definition_from_schema(schema: &ClickHouseViewSchema) -> ClickHouseViewDefinitionTarget {
    ClickHouseViewDefinitionTarget {
        address: schema.identity.address.clone(),
        family: schema.family,
        scope: match &schema.scope {
            ClickHouseViewScope::Local => ClickHouseViewScopeTarget::Local,
            ClickHouseViewScope::Cluster { cluster_name } => ClickHouseViewScopeTarget::Cluster {
                cluster_name: cluster_name.clone(),
            },
            ClickHouseViewScope::Temporary {
                owner_tab_runtime_id,
                ..
            } => ClickHouseViewScopeTarget::Temporary {
                owner_tab_runtime_id: owner_tab_runtime_id.clone(),
            },
        },
        columns: schema.columns.clone(),
        query: schema.query.clone(),
        security: schema.security.clone(),
        comment: schema.comment.clone(),
        family_definition: schema.family_definition.clone(),
    }
}

fn target_mismatch_labels(
    schema: &ClickHouseViewSchema,
    desired: &ClickHouseViewDefinitionTarget,
) -> Vec<&'static str> {
    let mut labels = Vec::new();
    if schema.identity.address != desired.address {
        labels.push("address");
    }
    if schema.family != desired.family {
        labels.push("family");
    }
    if schema.columns != desired.columns {
        labels.push("columns");
    }
    if !view_queries_semantically_equal(&schema.query, &desired.query) {
        labels.push("query");
    }
    if schema.security != desired.security {
        labels.push("security");
        if schema.security.definer != desired.security.definer {
            labels.push("definer");
        }
        if schema.security.sql_security != desired.security.sql_security {
            labels.push("sql_security");
        }
    }
    if schema.comment != desired.comment {
        labels.push("comment");
    }
    if schema.family_definition != desired.family_definition {
        labels.push("family_definition");
        if let (
            ClickHouseViewFamilyDefinition::Materialized {
                storage: actual_storage,
                populate: actual_populate,
            },
            ClickHouseViewFamilyDefinition::Materialized {
                storage: desired_storage,
                populate: desired_populate,
            },
        ) = (&schema.family_definition, &desired.family_definition)
        {
            if actual_populate != desired_populate {
                labels.push("populate");
            }
            match (actual_storage, desired_storage) {
                (
                    ClickHouseMaterializedStorage::InnerTable {
                        engine: actual_engine,
                        order_by: actual_order,
                        partition_by: actual_partition,
                        settings: actual_settings,
                    },
                    ClickHouseMaterializedStorage::InnerTable {
                        engine: desired_engine,
                        order_by: desired_order,
                        partition_by: desired_partition,
                        settings: desired_settings,
                    },
                ) => {
                    if actual_engine != desired_engine {
                        labels.push("inner_engine");
                    }
                    if actual_order != desired_order {
                        labels.push("inner_order_by");
                    }
                    if actual_partition != desired_partition {
                        labels.push("inner_partition_by");
                    }
                    if actual_settings != desired_settings {
                        labels.push("inner_settings");
                    }
                }
                (
                    ClickHouseMaterializedStorage::ToTable { .. },
                    ClickHouseMaterializedStorage::ToTable { .. },
                ) => labels.push("to_storage"),
                _ => labels.push("storage_kind"),
            }
        }
        if let (
            ClickHouseViewFamilyDefinition::RefreshableMaterialized {
                storage: actual_storage,
                refresh: actual_refresh,
                append: actual_append,
                empty: actual_empty,
            },
            ClickHouseViewFamilyDefinition::RefreshableMaterialized {
                storage: desired_storage,
                refresh: desired_refresh,
                append: desired_append,
                empty: desired_empty,
            },
        ) = (&schema.family_definition, &desired.family_definition)
        {
            match (actual_storage, desired_storage) {
                (
                    ClickHouseMaterializedStorage::ToTable {
                        target: actual_target,
                        target_columns: actual_columns,
                    },
                    ClickHouseMaterializedStorage::ToTable {
                        target: desired_target,
                        target_columns: desired_columns,
                    },
                ) => {
                    if actual_target != desired_target {
                        labels.push("to_target");
                    }
                    if actual_columns != desired_columns {
                        labels.push("target_columns");
                    }
                }
                (
                    ClickHouseMaterializedStorage::InnerTable {
                        engine: actual_engine,
                        order_by: actual_order,
                        partition_by: actual_partition,
                        settings: actual_settings,
                    },
                    ClickHouseMaterializedStorage::InnerTable {
                        engine: desired_engine,
                        order_by: desired_order,
                        partition_by: desired_partition,
                        settings: desired_settings,
                    },
                ) => {
                    if actual_engine != desired_engine {
                        labels.push("inner_engine");
                    }
                    if actual_order != desired_order {
                        labels.push("inner_order_by");
                    }
                    if actual_partition != desired_partition {
                        labels.push("inner_partition_by");
                    }
                    if actual_settings != desired_settings {
                        labels.push("inner_settings");
                    }
                }
                _ => labels.push("storage_kind"),
            }
            if actual_refresh.mode != desired_refresh.mode {
                labels.push("refresh_mode");
            }
            if actual_refresh.interval != desired_refresh.interval {
                labels.push("refresh_interval");
            }
            if actual_refresh.offset != desired_refresh.offset {
                labels.push("refresh_offset");
            }
            if actual_refresh.randomize_for != desired_refresh.randomize_for {
                labels.push("refresh_randomize_for");
            }
            if actual_refresh.dependencies != desired_refresh.dependencies {
                labels.push("refresh_dependencies");
            }
            if actual_refresh.settings.refresh_retries != desired_refresh.settings.refresh_retries {
                labels.push("refresh_retries");
            }
            if actual_refresh.settings.refresh_retry_initial_backoff_ms
                != desired_refresh.settings.refresh_retry_initial_backoff_ms
            {
                labels.push("refresh_retry_initial_backoff_ms");
            }
            if actual_refresh.settings.refresh_retry_max_backoff_ms
                != desired_refresh.settings.refresh_retry_max_backoff_ms
            {
                labels.push("refresh_retry_max_backoff_ms");
            }
            if actual_refresh.settings.all_replicas != desired_refresh.settings.all_replicas {
                labels.push("refresh_all_replicas");
            }
            if actual_append != desired_append {
                labels.push("append");
            }
            if actual_empty != desired_empty {
                labels.push("empty");
            }
        }
    }
    labels
}

fn query_keyword_shape(query: &str) -> String {
    query
        .split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
        .map(str::to_ascii_lowercase)
        .filter(|word| {
            matches!(
                word.as_str(),
                "select"
                    | "with"
                    | "as"
                    | "from"
                    | "where"
                    | "and"
                    | "or"
                    | "group"
                    | "by"
                    | "order"
                    | "having"
                    | "join"
                    | "on"
                    | "union"
            )
        })
        .collect::<Vec<_>>()
        .join("-")
}

fn confirmation(
    required: NativeSchemaRequiredConfirmation,
    object_name: &str,
) -> Option<NativeSchemaConfirmationInput> {
    match required {
        NativeSchemaRequiredConfirmation::None => None,
        NativeSchemaRequiredConfirmation::Confirm => Some(NativeSchemaConfirmationInput {
            accepted: true,
            object_name: None,
            cluster_name: None,
        }),
        NativeSchemaRequiredConfirmation::TypeObjectName => Some(NativeSchemaConfirmationInput {
            accepted: true,
            object_name: Some(object_name.to_string()),
            cluster_name: None,
        }),
        NativeSchemaRequiredConfirmation::TypeObjectAndCluster => unreachable!("single-node gate"),
    }
}

async fn describe_view<D: PhaseFiveEDispatcher>(
    dispatcher: &D,
    view_address: &ClickHouseViewAddress,
    temporary: bool,
) -> IpcResult<ClickHouseViewSchema> {
    match dispatcher
        .describe(
            &NativeSchemaDescribeRequest::View(container(view_address)),
            temporary,
        )
        .await?
    {
        NativeSchemaDocument::ClickHouseView(schema) => Ok(*schema),
        NativeSchemaDocument::ClickHouseTable(_) => Err(checkpoint_error(
            "ClickHouse Phase 5E Describe returned a table document",
        )),
    }
}

async fn create_view<D: PhaseFiveEDispatcher>(
    dispatcher: &D,
    desired: ClickHouseViewDefinitionTarget,
    support: &ClickHouseViewRuntimeSupport,
    temporary: bool,
    reject_confirmation: bool,
    confirmation_rejections: &mut usize,
) -> IpcResult<ClickHouseViewSchema> {
    let object_name = desired.address.name.clone();
    let target = NativeSchemaCreateTarget::ClickHouseView(Box::new(ClickHouseViewCreateTarget {
        desired: desired.clone(),
        expected_support_revision: support.support_revision.clone(),
    }));
    let preview = dispatcher.preview_create(&target, temporary).await?;
    if reject_confirmation {
        ensure(
            preview.required_confirmation != NativeSchemaRequiredConfirmation::None,
            "ClickHouse Phase 5E expected a create confirmation",
            "assertion=create_confirmation_required",
        )?;
        let error = dispatcher
            .execute_create(
                &NativeSchemaExecuteCreateRequest {
                    target: target.clone(),
                    expected_plan_hash: preview.plan_hash.clone(),
                    confirmation: None,
                    baseline: preview.baseline.clone(),
                },
                temporary,
            )
            .await
            .expect_err("missing confirmation must reject before DDL");
        ensure(
            error.code == ErrorCode::ValidationFailed,
            "ClickHouse Phase 5E create confirmation used the wrong error",
            "assertion=create_confirmation_code",
        )?;
        *confirmation_rejections += 1;
    }
    let result = dispatcher
        .execute_create(
            &NativeSchemaExecuteCreateRequest {
                target,
                expected_plan_hash: preview.plan_hash,
                confirmation: confirmation(preview.required_confirmation, &object_name),
                baseline: preview.baseline,
            },
            temporary,
        )
        .await
        .map_err(|error| {
            if error.code == ErrorCode::FeatureUnavailable {
                return error;
            }
            let diagnostic = error.details.as_deref().unwrap_or("details=none");
            IpcError::system_internal(
                format!(
                    "ClickHouse Phase 5E {:?} create execution failed ({:?}; {diagnostic})",
                    desired.family, error.code,
                ),
                "checkpoint=phase_five_e; operation=create",
            )
        })?;
    let NativeSchemaCreateResult::ClickHouseView(result) = result else {
        return Err(checkpoint_error(
            "ClickHouse Phase 5E create returned the wrong result type",
        ));
    };
    if result.status != NativeSchemaExecutionStatus::Applied {
        let mismatch = match result.schema.as_ref() {
            Some(schema) => target_mismatch_labels(schema, &desired).join(","),
            None => match dispatcher
                .describe(
                    &NativeSchemaDescribeRequest::View(container(&desired.address)),
                    temporary,
                )
                .await
            {
                Ok(_) => "describe_unavailable_during_post_verify".to_string(),
                Err(error) => format!("describe_error={:?}:{}", error.code, error.message),
            },
        };
        return Err(IpcError::system_internal(
            format!(
                "ClickHouse Phase 5E {:?} create for {} was not proven applied ({:?}; mismatch={mismatch})",
                desired.family, desired.address.name, result.status,
            ),
            "checkpoint=phase_five_e; assertion=create_applied",
        ));
    }
    result.schema.ok_or_else(|| {
        checkpoint_error("ClickHouse Phase 5E create did not return the canonical schema")
    })
}

async fn apply_change<D: PhaseFiveEDispatcher>(
    dispatcher: &D,
    target: NativeSchemaChangeTarget,
    temporary: bool,
    reject_confirmation: bool,
    confirmation_rejections: &mut usize,
) -> IpcResult<ClickHouseViewChangeResult> {
    let expected_desired = match &target {
        NativeSchemaChangeTarget::ClickHouseViewAlter(target) => Some(target.desired.clone()),
        _ => None,
    };
    let family = match &target {
        NativeSchemaChangeTarget::ClickHouseViewAlter(target) => target.baseline.family,
        NativeSchemaChangeTarget::ClickHouseViewRename(target) => target.baseline.family,
        NativeSchemaChangeTarget::ClickHouseViewDrop(target) => target.baseline.family,
        _ => unreachable!("View target checked below"),
    };
    let query_changed = match &target {
        NativeSchemaChangeTarget::ClickHouseViewAlter(target) => {
            !view_queries_semantically_equal(&target.baseline.query, &target.desired.query)
        }
        _ => false,
    };
    let operation = target.operation();
    let source_name = match &target {
        NativeSchemaChangeTarget::ClickHouseViewAlter(target) => {
            &target.baseline.identity.address.name
        }
        NativeSchemaChangeTarget::ClickHouseViewRename(target) => {
            &target.baseline.identity.address.name
        }
        NativeSchemaChangeTarget::ClickHouseViewDrop(target) => {
            &target.baseline.identity.address.name
        }
        _ => {
            return Err(checkpoint_error(
                "ClickHouse Phase 5E change target was not a View",
            ))
        }
    }
    .clone();
    let preview = dispatcher.preview_change(&target, temporary).await?;
    if reject_confirmation {
        ensure(
            preview.required_confirmation != NativeSchemaRequiredConfirmation::None,
            "ClickHouse Phase 5E expected a change confirmation",
            "assertion=change_confirmation_required",
        )?;
        let error = dispatcher
            .execute_change(
                &NativeSchemaExecuteChangeRequest {
                    target: target.clone(),
                    baseline: preview.baseline.clone(),
                    expected_plan_hash: preview.plan_hash.clone(),
                    confirmation: None,
                },
                temporary,
            )
            .await
            .expect_err("missing confirmation must reject before DDL");
        ensure(
            error.code == ErrorCode::ValidationFailed,
            "ClickHouse Phase 5E change confirmation used the wrong error",
            "assertion=change_confirmation_code",
        )?;
        *confirmation_rejections += 1;
    }
    let result = dispatcher
        .execute_change(
            &NativeSchemaExecuteChangeRequest {
                target,
                baseline: preview.baseline,
                expected_plan_hash: preview.plan_hash,
                confirmation: confirmation(preview.required_confirmation, &source_name),
            },
            temporary,
        )
        .await
        .map_err(|error| {
            IpcError::system_internal(
                format!(
                    "ClickHouse Phase 5E {family:?} {operation:?} execution failed ({:?})",
                    error.code
                ),
                "checkpoint=phase_five_e; operation=change",
            )
        })?;
    let NativeSchemaChangeResult::ClickHouseViewChange(result) = result else {
        return Err(checkpoint_error(
            "ClickHouse Phase 5E change returned the wrong result type",
        ));
    };
    if result.status != NativeSchemaExecutionStatus::Applied {
        let mismatch = match (result.schema.as_ref(), expected_desired.as_ref()) {
            (Some(schema), Some(desired)) => format!(
                "{}; query_shape={}/{}:{}/{}",
                target_mismatch_labels(schema, desired).join(","),
                schema.query.chars().count(),
                desired.query.chars().count(),
                query_keyword_shape(&schema.query),
                query_keyword_shape(&desired.query),
            ),
            (None, _) => "describe_unavailable".to_string(),
            _ => "not_applicable".to_string(),
        };
        return Err(IpcError::system_internal(
            format!(
                "ClickHouse Phase 5E {operation:?} change for {source_name} was not proven applied ({:?}; query_changed={query_changed}; mismatch={mismatch})",
                result.status,
            ),
            "checkpoint=phase_five_e; assertion=change_applied",
        ));
    }
    Ok(*result)
}

fn alter_target(
    baseline: ClickHouseViewSchema,
    desired: ClickHouseViewDefinitionTarget,
) -> NativeSchemaChangeTarget {
    let support_revision = baseline.server_support.support_revision.clone();
    NativeSchemaChangeTarget::ClickHouseViewAlter(Box::new(ClickHouseViewAlterTarget {
        baseline,
        desired,
        expected_support_revision: support_revision,
    }))
}

fn rename_target(
    baseline: ClickHouseViewSchema,
    destination: ClickHouseViewAddress,
) -> NativeSchemaChangeTarget {
    let support_revision = baseline.server_support.support_revision.clone();
    NativeSchemaChangeTarget::ClickHouseViewRename(Box::new(ClickHouseViewRenameTarget {
        baseline,
        destination,
        expected_destination_absence_revision: "a".repeat(64),
        expected_support_revision: support_revision,
    }))
}

fn drop_target(baseline: ClickHouseViewSchema) -> NativeSchemaChangeTarget {
    let support_revision = baseline.server_support.support_revision.clone();
    NativeSchemaChangeTarget::ClickHouseViewDrop(Box::new(ClickHouseViewDropTarget {
        baseline,
        expected_support_revision: support_revision,
    }))
}

fn to_storage(database: &str, table: &str) -> ClickHouseMaterializedStorage {
    ClickHouseMaterializedStorage::ToTable {
        target: ContainerRef::table(ContainerKind::Table, database, None, table),
        target_columns: vec!["id".to_string(), "value".to_string()],
    }
}

fn inner_storage(order_by: &str) -> ClickHouseMaterializedStorage {
    ClickHouseMaterializedStorage::InnerTable {
        engine: ClickHouseCreateEngineTarget {
            family: "MergeTree".to_string(),
            arguments: Vec::new(),
        },
        order_by: order_by.to_string(),
        partition_by: None,
        settings: Vec::new(),
    }
}

fn materialized_definition(
    database: &str,
    name: &str,
    storage: ClickHouseMaterializedStorage,
) -> ClickHouseViewDefinitionTarget {
    ClickHouseViewDefinitionTarget {
        address: address(Some(database), name, ContainerKind::MaterializedView),
        family: ClickHouseViewFamily::Materialized,
        scope: ClickHouseViewScopeTarget::Local,
        columns: ClickHouseViewColumnDefinition::None,
        query: format!(
            "SELECT id, value FROM {}.{}",
            quote_identifier(database),
            quote_identifier(SOURCE_TABLE),
        ),
        security: empty_security(),
        comment: None,
        family_definition: ClickHouseViewFamilyDefinition::Materialized {
            storage,
            populate: false,
        },
    }
}

fn interval(value: u64, unit: ClickHouseViewIntervalUnit) -> ClickHouseViewInterval {
    ClickHouseViewInterval { value, unit }
}

fn empty_refresh_settings() -> ClickHouseRefreshSettings {
    ClickHouseRefreshSettings {
        refresh_retries: None,
        refresh_retry_initial_backoff_ms: None,
        refresh_retry_max_backoff_ms: None,
        all_replicas: None,
    }
}

fn refreshable_definition(database: &str) -> ClickHouseViewDefinitionTarget {
    ClickHouseViewDefinitionTarget {
        address: address(
            Some(database),
            REFRESHABLE_VIEW,
            ContainerKind::MaterializedView,
        ),
        family: ClickHouseViewFamily::RefreshableMaterialized,
        scope: ClickHouseViewScopeTarget::Local,
        columns: ClickHouseViewColumnDefinition::None,
        query: format!(
            "SELECT id, value FROM {}.{}",
            quote_identifier(database),
            quote_identifier(SOURCE_TABLE),
        ),
        security: empty_security(),
        comment: None,
        family_definition: ClickHouseViewFamilyDefinition::RefreshableMaterialized {
            storage: to_storage(database, REFRESH_DESTINATION_TABLE),
            refresh: ClickHouseRefreshDefinition {
                mode: ClickHouseRefreshMode::Every,
                interval: Some(interval(1, ClickHouseViewIntervalUnit::Hour)),
                offset: Some(interval(1, ClickHouseViewIntervalUnit::Minute)),
                randomize_for: Some(interval(1, ClickHouseViewIntervalUnit::Minute)),
                dependencies: vec![address(
                    Some(database),
                    REFRESH_DEPENDENCY_VIEW,
                    ContainerKind::View,
                )],
                settings: ClickHouseRefreshSettings {
                    refresh_retries: Some(2),
                    refresh_retry_initial_backoff_ms: Some(100),
                    refresh_retry_max_backoff_ms: Some(500),
                    all_replicas: Some(false),
                },
            },
            append: true,
            empty: true,
        },
    }
}

async fn database_exists(client: &Client, database: &str) -> IpcResult<bool> {
    client
        .query("SELECT count() AS count FROM system.databases WHERE name = ?")
        .bind(database)
        .fetch_one::<CountRow>()
        .await
        .map(|row| row.count > 0)
        .map_err(|_| checkpoint_error("ClickHouse Phase 5E database cleanup probe failed"))
}

async fn object_exists(client: &Client, database: &str, name: &str) -> IpcResult<bool> {
    client
        .query("SELECT count() AS count FROM system.tables WHERE database = ? AND name = ?")
        .bind(database)
        .bind(name)
        .fetch_one::<CountRow>()
        .await
        .map(|row| row.count > 0)
        .map_err(|_| checkpoint_error("ClickHouse Phase 5E object existence probe failed"))
}

async fn create_fixture(client: &Client, database: &str) -> IpcResult<()> {
    let database = quote_identifier(database);
    let statements = [
        format!("CREATE DATABASE {database}"),
        format!(
            "CREATE TABLE {database}.{} (id UInt64, tenant UInt64, value String, ts DateTime) ENGINE = MergeTree ORDER BY id",
            quote_identifier(SOURCE_TABLE),
        ),
        format!(
            "CREATE TABLE {database}.{} (id UInt64, value String) ENGINE = MergeTree ORDER BY id",
            quote_identifier(DESTINATION_TABLE),
        ),
        format!(
            "CREATE TABLE {database}.{} (id UInt64, value String) ENGINE = MergeTree ORDER BY id",
            quote_identifier(REFRESH_DESTINATION_TABLE),
        ),
        format!(
            "CREATE TABLE {database}.{} (window_start DateTime, events UInt64) ENGINE = MergeTree ORDER BY window_start",
            quote_identifier(WINDOW_DESTINATION_TABLE),
        ),
        format!(
            "INSERT INTO {database}.{} VALUES (1, 1, 'one', now()), (2, 2, 'two', now())",
            quote_identifier(SOURCE_TABLE),
        ),
        format!(
            "CREATE VIEW {database}.{} AS SELECT id, value FROM {database}.{}",
            quote_identifier(REFRESH_DEPENDENCY_VIEW),
            quote_identifier(SOURCE_TABLE),
        ),
    ];
    for statement in statements {
        client
            .query(&statement)
            .execute()
            .await
            .map_err(|_| checkpoint_error("ClickHouse Phase 5E fixture creation failed"))?;
    }
    Ok(())
}

async fn expect_feature_unavailable<T>(result: IpcResult<T>, assertion: &str) -> IpcResult<()> {
    let error = result
        .err()
        .ok_or_else(|| checkpoint_error("ClickHouse Phase 5E unavailable feature was accepted"))?;
    ensure(
        error.code == ErrorCode::FeatureUnavailable,
        "ClickHouse Phase 5E unavailable feature used the wrong error",
        assertion,
    )
}

fn schema_from_change(result: ClickHouseViewChangeResult) -> IpcResult<ClickHouseViewSchema> {
    result.schema.ok_or_else(|| {
        checkpoint_error("ClickHouse Phase 5E change did not return the canonical schema")
    })
}

async fn run_normal_matrix<D: PhaseFiveEDispatcher>(
    dispatcher: &D,
    client: &Client,
    database: &str,
    support: &ClickHouseViewRuntimeSupport,
    evidence: &mut PhaseFiveEEvidence,
) -> IpcResult<()> {
    let source = format!(
        "{}.{}",
        quote_identifier(database),
        quote_identifier(SOURCE_TABLE)
    );
    let mut schema = create_view(
        dispatcher,
        normal_definition(
            database,
            NORMAL_VIEW,
            format!("SELECT id, value FROM {source}"),
        ),
        support,
        false,
        false,
        &mut evidence.confirmation_rejections,
    )
    .await?;
    evidence.normal += 1;

    if schema.editability.mode != ClickHouseSchemaEditabilityMode::Editable {
        return Err(IpcError::system_internal(
            format!(
                "ClickHouse Phase 5E Normal Describe was not editable (blockers={})",
                schema
                    .editability
                    .blockers
                    .iter()
                    .map(|blocker| blocker.code.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            "checkpoint=phase_five_e; assertion=normal_editable",
        ));
    }

    let described = describe_view(dispatcher, &schema.identity.address, false).await?;
    ensure(
        described.baseline.revision_hash == schema.baseline.revision_hash,
        "ClickHouse Phase 5E Normal Describe revision changed unexpectedly",
        "assertion=normal_describe_revision",
    )?;
    evidence.normal += 1;

    let mut desired = definition_from_schema(&schema);
    desired.security.sql_security = Some(ClickHouseViewSqlSecurity::Invoker);
    schema = schema_from_change(
        apply_change(
            dispatcher,
            alter_target(schema, desired),
            false,
            false,
            &mut evidence.confirmation_rejections,
        )
        .await?,
    )?;
    evidence.alters += 1;
    evidence.normal += 1;

    let mut desired = definition_from_schema(&schema);
    desired.query.push_str(" WHERE tenant > 0");
    schema = schema_from_change(
        apply_change(
            dispatcher,
            alter_target(schema, desired),
            false,
            true,
            &mut evidence.confirmation_rejections,
        )
        .await?,
    )?;
    evidence.alters += 1;
    evidence.normal += 1;

    let stale_target =
        NativeSchemaCreateTarget::ClickHouseView(Box::new(ClickHouseViewCreateTarget {
            desired: normal_definition(
                database,
                "normal_stale_support",
                format!("SELECT id FROM {source}"),
            ),
            expected_support_revision: "0".repeat(64),
        }));
    let stale_support = dispatcher.preview_create(&stale_target, false).await;
    ensure(
        stale_support
            .err()
            .is_some_and(|error| error.code == ErrorCode::ResourceConflict),
        "ClickHouse Phase 5E stale support revision was not rejected",
        "assertion=stale_support_conflict",
    )?;
    ensure(
        !object_exists(client, database, "normal_stale_support").await?,
        "ClickHouse Phase 5E stale support rejection sent DDL",
        "assertion=stale_support_before_ddl",
    )?;
    evidence.drift_conflicts += 1;

    let mut stale_baseline = schema.clone();
    stale_baseline.baseline.revision_hash = "0".repeat(64);
    let mut stale_desired = definition_from_schema(&stale_baseline);
    stale_desired.comment = Some("stale baseline must not apply".to_string());
    let stale_change = alter_target(stale_baseline, stale_desired);
    let stale_plan = dispatcher.preview_change(&stale_change, false).await?;
    let stale_error = dispatcher
        .execute_change(
            &NativeSchemaExecuteChangeRequest {
                target: stale_change,
                baseline: stale_plan.baseline,
                expected_plan_hash: stale_plan.plan_hash,
                confirmation: confirmation(stale_plan.required_confirmation, NORMAL_VIEW),
            },
            false,
        )
        .await
        .expect_err("stale baseline must conflict before DDL");
    ensure(
        stale_error.code == ErrorCode::ResourceConflict,
        "ClickHouse Phase 5E stale baseline used the wrong error",
        "assertion=stale_baseline_conflict",
    )?;
    evidence.drift_conflicts += 1;

    let conflict_name = "normal_rename_conflict";
    let conflict_address = address(Some(database), conflict_name, ContainerKind::View);
    let conflict_target = rename_target(schema.clone(), conflict_address.clone());
    let conflict_plan = dispatcher.preview_change(&conflict_target, false).await?;
    client
        .query(&format!(
            "CREATE VIEW {}.{} AS SELECT id FROM {source}",
            quote_identifier(database),
            quote_identifier(conflict_name),
        ))
        .execute()
        .await
        .map_err(|_| checkpoint_error("ClickHouse Phase 5E rename drift injection failed"))?;
    let conflict_error = dispatcher
        .execute_change(
            &NativeSchemaExecuteChangeRequest {
                target: conflict_target,
                baseline: conflict_plan.baseline,
                expected_plan_hash: conflict_plan.plan_hash,
                confirmation: None,
            },
            false,
        )
        .await
        .expect_err("occupied rename destination must conflict");
    ensure(
        conflict_error.code == ErrorCode::ResourceConflict,
        "ClickHouse Phase 5E rename destination drift used the wrong error",
        "assertion=destination_drift_conflict",
    )?;
    client
        .query(&format!(
            "DROP VIEW {}.{} SYNC",
            quote_identifier(database),
            quote_identifier(conflict_name),
        ))
        .execute()
        .await
        .map_err(|_| checkpoint_error("ClickHouse Phase 5E rename drift cleanup failed"))?;
    evidence.drift_conflicts += 1;

    let renamed_address = address(Some(database), "normal_view_renamed", ContainerKind::View);
    schema = schema_from_change(
        apply_change(
            dispatcher,
            rename_target(schema, renamed_address),
            false,
            false,
            &mut evidence.confirmation_rejections,
        )
        .await?,
    )?;
    evidence.renames += 1;
    evidence.normal += 1;

    apply_change(
        dispatcher,
        drop_target(schema),
        false,
        true,
        &mut evidence.confirmation_rejections,
    )
    .await?;
    evidence.drops += 1;
    ensure(
        !object_exists(client, database, "normal_view_renamed").await?,
        "ClickHouse Phase 5E Normal View remained after Drop",
        "assertion=normal_drop_absence",
    )
}

async fn run_parameterized_matrix<D: PhaseFiveEDispatcher>(
    dispatcher: &D,
    client: &Client,
    database: &str,
    support: &ClickHouseViewRuntimeSupport,
    evidence: &mut PhaseFiveEEvidence,
) -> IpcResult<()> {
    let mut desired = normal_definition(
        database,
        PARAMETERIZED_VIEW,
        format!(
            "SELECT id, value FROM {}.{} WHERE tenant = {{tenant:UInt64}}",
            quote_identifier(database),
            quote_identifier(SOURCE_TABLE),
        ),
    );
    desired.family = ClickHouseViewFamily::Parameterized;
    desired.family_definition = ClickHouseViewFamilyDefinition::Parameterized {
        parameters: vec![ClickHouseViewParameter {
            name: "tenant".to_string(),
            type_name: "UInt64".to_string(),
            occurrences: 1,
        }],
    };
    let mut schema = create_view(
        dispatcher,
        desired,
        support,
        false,
        false,
        &mut evidence.confirmation_rejections,
    )
    .await?;
    evidence.parameterized += 1;

    let invoked = client
        .query(&format!(
            "SELECT count() AS count FROM {}.{}(tenant = 1)",
            quote_identifier(database),
            quote_identifier(PARAMETERIZED_VIEW),
        ))
        .fetch_one::<CountRow>()
        .await
        .map_err(|_| checkpoint_error("ClickHouse Phase 5E parameterized invocation failed"))?;
    ensure(
        invoked.count == 1,
        "ClickHouse Phase 5E parameterized invocation returned the wrong rows",
        "assertion=parameterized_invocation",
    )?;
    evidence.parameterized += 1;

    let mut desired = definition_from_schema(&schema);
    desired.query = format!(
        "SELECT id, value FROM {}.{} WHERE tenant >= {{tenant:UInt64}}",
        quote_identifier(database),
        quote_identifier(SOURCE_TABLE),
    );
    schema = schema_from_change(
        apply_change(
            dispatcher,
            alter_target(schema, desired),
            false,
            true,
            &mut evidence.confirmation_rejections,
        )
        .await?,
    )?;
    evidence.alters += 1;
    evidence.parameterized += 1;

    schema = schema_from_change(
        apply_change(
            dispatcher,
            rename_target(
                schema,
                address(
                    Some(database),
                    "parameterized_view_renamed",
                    ContainerKind::View,
                ),
            ),
            false,
            false,
            &mut evidence.confirmation_rejections,
        )
        .await?,
    )?;
    evidence.renames += 1;
    evidence.parameterized += 1;
    apply_change(
        dispatcher,
        drop_target(schema),
        false,
        true,
        &mut evidence.confirmation_rejections,
    )
    .await?;
    evidence.drops += 1;
    evidence.parameterized += 1;
    Ok(())
}

async fn run_materialized_matrix<D: PhaseFiveEDispatcher>(
    dispatcher: &D,
    client: &Client,
    database: &str,
    support: &ClickHouseViewRuntimeSupport,
    evidence: &mut PhaseFiveEEvidence,
) -> IpcResult<()> {
    let invalid = {
        let mut desired = materialized_definition(
            database,
            "invalid_populate_mv",
            to_storage(database, DESTINATION_TABLE),
        );
        desired.family_definition = ClickHouseViewFamilyDefinition::Materialized {
            storage: to_storage(database, DESTINATION_TABLE),
            populate: true,
        };
        NativeSchemaCreateTarget::ClickHouseView(Box::new(ClickHouseViewCreateTarget {
            desired,
            expected_support_revision: support.support_revision.clone(),
        }))
    };
    let invalid_error = dispatcher
        .preview_create(&invalid, false)
        .await
        .expect_err("TO plus POPULATE must be rejected locally");
    ensure(
        invalid_error.code == ErrorCode::ValidationFailed,
        "ClickHouse Phase 5E TO plus POPULATE used the wrong error",
        "assertion=to_populate_validation",
    )?;
    evidence.materialized += 1;

    let mut schema = create_view(
        dispatcher,
        materialized_definition(
            database,
            MATERIALIZED_VIEW,
            to_storage(database, DESTINATION_TABLE),
        ),
        support,
        false,
        false,
        &mut evidence.confirmation_rejections,
    )
    .await?;
    evidence.materialized += 1;

    client
        .query(&format!(
            "INSERT INTO {}.{} VALUES (10, 10, 'materialized', now())",
            quote_identifier(database),
            quote_identifier(SOURCE_TABLE),
        ))
        .execute()
        .await
        .map_err(|_| checkpoint_error("ClickHouse Phase 5E MV source insert failed"))?;
    let destination_count = client
        .query(&format!(
            "SELECT count() AS count FROM {}.{} WHERE id = 10",
            quote_identifier(database),
            quote_identifier(DESTINATION_TABLE),
        ))
        .fetch_one::<CountRow>()
        .await
        .map_err(|_| checkpoint_error("ClickHouse Phase 5E MV destination query failed"))?;
    ensure(
        destination_count.count == 1,
        "ClickHouse Phase 5E MV did not write its TO target",
        "assertion=materialized_to_target",
    )?;
    evidence.materialized += 1;

    let mut desired = definition_from_schema(&schema);
    desired.query.push_str(" WHERE tenant >= 0");
    schema = schema_from_change(
        apply_change(
            dispatcher,
            alter_target(schema, desired),
            false,
            true,
            &mut evidence.confirmation_rejections,
        )
        .await?,
    )?;
    evidence.alters += 1;
    evidence.materialized += 1;

    let mut desired = definition_from_schema(&schema);
    if let ClickHouseViewFamilyDefinition::Materialized { storage, .. } =
        &mut desired.family_definition
    {
        *storage = to_storage(database, REFRESH_DESTINATION_TABLE);
    }
    let replace_target = alter_target(schema, desired);
    let replace_plan = dispatcher.preview_change(&replace_target, false).await?;
    ensure(
        replace_plan
            .statements
            .iter()
            .any(|statement| statement.contains("CREATE OR REPLACE MATERIALIZED VIEW")),
        "ClickHouse Phase 5E immutable MV change did not plan Replace",
        "assertion=materialized_replace_plan",
    )?;
    schema = schema_from_change(
        apply_change(
            dispatcher,
            replace_target,
            false,
            true,
            &mut evidence.confirmation_rejections,
        )
        .await?,
    )?;
    evidence.alters += 1;
    evidence.materialized += 1;

    schema = schema_from_change(
        apply_change(
            dispatcher,
            rename_target(
                schema,
                address(
                    Some(database),
                    "incremental_mv_renamed",
                    ContainerKind::MaterializedView,
                ),
            ),
            false,
            false,
            &mut evidence.confirmation_rejections,
        )
        .await?,
    )?;
    evidence.renames += 1;
    apply_change(
        dispatcher,
        drop_target(schema),
        false,
        true,
        &mut evidence.confirmation_rejections,
    )
    .await?;
    evidence.drops += 1;
    evidence.materialized += 2;

    let mut inner = create_view(
        dispatcher,
        materialized_definition(database, INNER_MATERIALIZED_VIEW, inner_storage("id")),
        support,
        false,
        false,
        &mut evidence.confirmation_rejections,
    )
    .await?;
    evidence.materialized += 1;
    let mut desired = definition_from_schema(&inner);
    if let ClickHouseViewFamilyDefinition::Materialized { storage, .. } =
        &mut desired.family_definition
    {
        *storage = inner_storage("tuple()");
    }
    let data_loss_target = alter_target(inner, desired);
    let data_loss_plan = dispatcher.preview_change(&data_loss_target, false).await?;
    ensure(
        data_loss_plan
            .risk_flags
            .contains(&NativeSchemaRiskFlag::DataLoss)
            && data_loss_plan.required_confirmation
                == NativeSchemaRequiredConfirmation::TypeObjectName,
        "ClickHouse Phase 5E inner MV Replace lost its typed data-loss confirmation",
        "assertion=inner_replace_data_loss",
    )?;
    inner = schema_from_change(
        apply_change(
            dispatcher,
            data_loss_target,
            false,
            true,
            &mut evidence.confirmation_rejections,
        )
        .await?,
    )?;
    evidence.alters += 1;
    evidence.materialized += 1;
    inner = schema_from_change(
        apply_change(
            dispatcher,
            rename_target(
                inner,
                address(
                    Some(database),
                    "inner_incremental_mv_renamed",
                    ContainerKind::MaterializedView,
                ),
            ),
            false,
            false,
            &mut evidence.confirmation_rejections,
        )
        .await?,
    )?;
    evidence.renames += 1;
    apply_change(
        dispatcher,
        drop_target(inner),
        false,
        true,
        &mut evidence.confirmation_rejections,
    )
    .await?;
    evidence.drops += 1;
    evidence.materialized += 2;
    Ok(())
}

async fn run_refreshable_matrix<D: PhaseFiveEDispatcher>(
    dispatcher: &D,
    database: &str,
    support: &ClickHouseViewRuntimeSupport,
    evidence: &mut PhaseFiveEEvidence,
) -> IpcResult<()> {
    ensure(
        support.refreshable_materialized.create.state == ClickHouseSupportState::Supported,
        "ClickHouse Phase 5E requires Refreshable MV support",
        "assertion=refreshable_supported",
    )?;
    let desired = refreshable_definition(database);
    let target = NativeSchemaCreateTarget::ClickHouseView(Box::new(ClickHouseViewCreateTarget {
        desired: desired.clone(),
        expected_support_revision: support.support_revision.clone(),
    }));
    let preview = dispatcher.preview_create(&target, false).await?;
    let result = dispatcher
        .execute_create(
            &NativeSchemaExecuteCreateRequest {
                target,
                expected_plan_hash: preview.plan_hash,
                confirmation: confirmation(preview.required_confirmation, REFRESHABLE_VIEW),
                baseline: preview.baseline,
            },
            false,
        )
        .await?;
    let NativeSchemaCreateResult::ClickHouseView(result) = result else {
        return Err(checkpoint_error(
            "ClickHouse Phase 5E Refreshable create returned the wrong result",
        ));
    };
    if result.status != NativeSchemaExecutionStatus::Applied || result.background_work.is_none() {
        let mismatch = result
            .schema
            .as_ref()
            .map(|schema| target_mismatch_labels(schema, &desired).join(","))
            .unwrap_or_else(|| "describe_unavailable".to_string());
        return Err(IpcError::system_internal(
            format!(
                "ClickHouse Phase 5E Refreshable schema/background proof failed (status={:?}; background={}; mismatch={mismatch})",
                result.status,
                result.background_work.is_some(),
            ),
            "checkpoint=phase_five_e; assertion=refreshable_background",
        ));
    }
    evidence.background_observations += 1;
    let mut schema = result.schema.ok_or_else(|| {
        checkpoint_error("ClickHouse Phase 5E Refreshable create lacked its schema")
    })?;
    evidence.refreshable += 1;

    let mut desired = definition_from_schema(&schema);
    let ClickHouseViewFamilyDefinition::RefreshableMaterialized { refresh, .. } =
        &mut desired.family_definition
    else {
        return Err(checkpoint_error(
            "ClickHouse Phase 5E Refreshable Describe lost its family definition",
        ));
    };
    refresh.mode = ClickHouseRefreshMode::After;
    refresh.interval = Some(interval(2, ClickHouseViewIntervalUnit::Hour));
    refresh.offset = None;
    refresh.randomize_for = None;
    refresh.dependencies.clear();
    refresh.settings = empty_refresh_settings();
    schema = schema_from_change(
        apply_change(
            dispatcher,
            alter_target(schema, desired),
            false,
            false,
            &mut evidence.confirmation_rejections,
        )
        .await?,
    )?;
    evidence.alters += 1;
    evidence.refreshable += 1;

    let mut desired = definition_from_schema(&schema);
    desired.query.push_str(" WHERE tenant >= 0");
    schema = schema_from_change(
        apply_change(
            dispatcher,
            alter_target(schema, desired),
            false,
            true,
            &mut evidence.confirmation_rejections,
        )
        .await?,
    )?;
    evidence.alters += 1;
    evidence.refreshable += 1;

    schema = schema_from_change(
        apply_change(
            dispatcher,
            rename_target(
                schema,
                address(
                    Some(database),
                    "refreshable_mv_renamed",
                    ContainerKind::MaterializedView,
                ),
            ),
            false,
            false,
            &mut evidence.confirmation_rejections,
        )
        .await?,
    )?;
    evidence.renames += 1;
    evidence.refreshable += 1;
    apply_change(
        dispatcher,
        drop_target(schema),
        false,
        true,
        &mut evidence.confirmation_rejections,
    )
    .await?;
    evidence.drops += 1;
    evidence.refreshable += 1;
    Ok(())
}

fn window_definition(database: &str) -> ClickHouseViewDefinitionTarget {
    let source = format!(
        "{}.{}",
        quote_identifier(database),
        quote_identifier(SOURCE_TABLE)
    );
    ClickHouseViewDefinitionTarget {
        address: address(Some(database), WINDOW_VIEW, ContainerKind::View),
        family: ClickHouseViewFamily::Window,
        scope: ClickHouseViewScopeTarget::Local,
        columns: ClickHouseViewColumnDefinition::None,
        query: format!(
            "SELECT tumbleStart(window_id) AS window_start, count() AS events FROM {source} GROUP BY tumble(ts, INTERVAL '5' SECOND) AS window_id"
        ),
        security: empty_security(),
        comment: None,
        family_definition: ClickHouseViewFamilyDefinition::Window {
            destination: Some(ContainerRef::table(
                ContainerKind::Table,
                database,
                None,
                WINDOW_DESTINATION_TABLE,
            )),
            inner_engine: None,
            result_engine: None,
            watermark: ClickHouseWindowWatermark::Bounded(interval(
                1,
                ClickHouseViewIntervalUnit::Second,
            )),
            allowed_lateness: Some(interval(1, ClickHouseViewIntervalUnit::Second)),
            populate: false,
            time_window_function: "tumble".to_string(),
        },
    }
}

async fn run_window_matrix<D: PhaseFiveEDispatcher>(
    dispatcher: &D,
    database: &str,
    support: &ClickHouseViewRuntimeSupport,
    evidence: &mut PhaseFiveEEvidence,
) -> IpcResult<()> {
    let desired = window_definition(database);
    match support.window.create.state {
        ClickHouseSupportState::Unsupported => {
            expect_feature_unavailable(
                dispatcher
                    .preview_create(
                        &NativeSchemaCreateTarget::ClickHouseView(Box::new(
                            ClickHouseViewCreateTarget {
                                desired,
                                expected_support_revision: support.support_revision.clone(),
                            },
                        )),
                        false,
                    )
                    .await,
                "assertion=window_feature_unavailable",
            )
            .await?;
            evidence.window_unavailable = 1;
            return Ok(());
        }
        ClickHouseSupportState::Unknown => {
            return Err(checkpoint_error(
                "ClickHouse Phase 5E Window support remained unknown",
            ))
        }
        ClickHouseSupportState::Supported => {}
    }

    let mut schema = match create_view(
        dispatcher,
        desired,
        support,
        false,
        true,
        &mut evidence.confirmation_rejections,
    )
    .await
    {
        Ok(schema) => schema,
        Err(error) if error.code == ErrorCode::FeatureUnavailable => {
            evidence.window_unavailable = 1;
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    evidence.window_supported += 1;

    let mut desired = definition_from_schema(&schema);
    desired.query = format!(
        "SELECT tumbleStart(window_id) AS window_start, count() AS events FROM {}.{} WHERE tenant >= 0 GROUP BY tumble(ts, INTERVAL '5' SECOND) AS window_id",
        quote_identifier(database),
        quote_identifier(SOURCE_TABLE),
    );
    let change = alter_target(schema, desired);
    let plan = dispatcher.preview_change(&change, false).await?;
    ensure(
        plan.destructive
            && plan.long_running
            && plan
                .risk_flags
                .contains(&NativeSchemaRiskFlag::Experimental),
        "ClickHouse Phase 5E Window Modify Query lost its state-loss classification",
        "assertion=window_modify_risk",
    )?;
    schema = schema_from_change(
        apply_change(
            dispatcher,
            change,
            false,
            true,
            &mut evidence.confirmation_rejections,
        )
        .await?,
    )?;
    evidence.alters += 1;
    evidence.window_supported += 1;
    schema = schema_from_change(
        apply_change(
            dispatcher,
            rename_target(
                schema,
                address(Some(database), "window_view_renamed", ContainerKind::View),
            ),
            false,
            false,
            &mut evidence.confirmation_rejections,
        )
        .await?,
    )?;
    evidence.renames += 1;
    apply_change(
        dispatcher,
        drop_target(schema),
        false,
        true,
        &mut evidence.confirmation_rejections,
    )
    .await?;
    evidence.drops += 1;
    evidence.window_supported += 2;
    Ok(())
}

fn live_definition(database: &str) -> ClickHouseViewDefinitionTarget {
    ClickHouseViewDefinitionTarget {
        address: address(Some(database), LIVE_VIEW, ContainerKind::View),
        family: ClickHouseViewFamily::Live,
        scope: ClickHouseViewScopeTarget::Local,
        columns: ClickHouseViewColumnDefinition::None,
        query: format!(
            "SELECT id, value FROM {}.{}",
            quote_identifier(database),
            quote_identifier(SOURCE_TABLE),
        ),
        security: empty_security(),
        comment: None,
        family_definition: ClickHouseViewFamilyDefinition::Live {
            timeout_seconds: Some(5),
            refresh_seconds: Some(1),
            canonical_legacy_options: Vec::new(),
        },
    }
}

async fn run_live_matrix<D: PhaseFiveEDispatcher>(
    dispatcher: &D,
    database: &str,
    support: &ClickHouseViewRuntimeSupport,
    evidence: &mut PhaseFiveEEvidence,
) -> IpcResult<()> {
    let desired = live_definition(database);
    match support.live.create.state {
        ClickHouseSupportState::Unsupported => {
            expect_feature_unavailable(
                dispatcher
                    .preview_create(
                        &NativeSchemaCreateTarget::ClickHouseView(Box::new(
                            ClickHouseViewCreateTarget {
                                desired,
                                expected_support_revision: support.support_revision.clone(),
                            },
                        )),
                        false,
                    )
                    .await,
                "assertion=live_feature_unavailable",
            )
            .await?;
            evidence.live_unavailable = 1;
            return Ok(());
        }
        ClickHouseSupportState::Unknown => {
            return Err(checkpoint_error(
                "ClickHouse Phase 5E Live support remained unknown",
            ))
        }
        ClickHouseSupportState::Supported => {}
    }

    let mut schema = create_view(
        dispatcher,
        desired,
        support,
        false,
        true,
        &mut evidence.confirmation_rejections,
    )
    .await?;
    evidence.live_supported += 1;
    let mut desired = definition_from_schema(&schema);
    desired.query.push_str(" WHERE tenant >= 0");
    schema = schema_from_change(
        apply_change(
            dispatcher,
            alter_target(schema, desired),
            false,
            true,
            &mut evidence.confirmation_rejections,
        )
        .await?,
    )?;
    evidence.alters += 1;
    evidence.live_supported += 1;
    schema = schema_from_change(
        apply_change(
            dispatcher,
            rename_target(
                schema,
                address(Some(database), "live_view_renamed", ContainerKind::View),
            ),
            false,
            false,
            &mut evidence.confirmation_rejections,
        )
        .await?,
    )?;
    evidence.renames += 1;
    apply_change(
        dispatcher,
        drop_target(schema),
        false,
        true,
        &mut evidence.confirmation_rejections,
    )
    .await?;
    evidence.drops += 1;
    evidence.live_supported += 2;
    Ok(())
}

async fn run_temporary_matrix<D: PhaseFiveEDispatcher>(
    dispatcher: &D,
    database: &str,
    support: &ClickHouseViewRuntimeSupport,
    evidence: &mut PhaseFiveEEvidence,
) -> IpcResult<()> {
    let temporary_address = address(None, TEMPORARY_VIEW, ContainerKind::View);
    let desired = ClickHouseViewDefinitionTarget {
        address: temporary_address.clone(),
        family: ClickHouseViewFamily::Temporary,
        scope: ClickHouseViewScopeTarget::Temporary {
            owner_tab_runtime_id: OWNER_TAB_RUNTIME_ID.to_string(),
        },
        columns: ClickHouseViewColumnDefinition::None,
        query: format!(
            "SELECT id, value FROM {}.{}",
            quote_identifier(database),
            quote_identifier(SOURCE_TABLE),
        ),
        security: empty_security(),
        comment: None,
        family_definition: ClickHouseViewFamilyDefinition::Temporary,
    };
    let mut schema = create_view(
        dispatcher,
        desired.clone(),
        support,
        true,
        false,
        &mut evidence.confirmation_rejections,
    )
    .await?;
    evidence.temporary += 1;
    let query = dispatcher
        .query_temporary(
            database,
            &format!(
                "SELECT count() AS count FROM {}",
                quote_identifier(TEMPORARY_VIEW)
            ),
        )
        .await?;
    ensure(
        query.rows.len() == 1,
        "ClickHouse Phase 5E Temporary View was not visible to its owner session",
        "assertion=temporary_same_owner_query",
    )?;
    evidence.temporary += 1;
    describe_view(dispatcher, &temporary_address, true).await?;
    evidence.temporary += 1;

    let mut changed = definition_from_schema(&schema);
    changed.query.push_str(" WHERE tenant >= 0");
    schema = schema_from_change(
        apply_change(
            dispatcher,
            alter_target(schema, changed),
            true,
            true,
            &mut evidence.confirmation_rejections,
        )
        .await?,
    )?;
    evidence.alters += 1;
    evidence.temporary += 1;
    apply_change(
        dispatcher,
        drop_target(schema),
        true,
        true,
        &mut evidence.confirmation_rejections,
    )
    .await?;
    evidence.drops += 1;
    evidence.temporary += 1;

    create_view(
        dispatcher,
        desired,
        support,
        true,
        false,
        &mut evidence.confirmation_rejections,
    )
    .await?;
    dispatcher.expire_temporary_owner().await?;
    let expired = dispatcher
        .describe(
            &NativeSchemaDescribeRequest::View(container(&temporary_address)),
            true,
        )
        .await
        .expect_err("expired Temporary owner must not recreate the session");
    ensure(
        matches!(
            expired.code,
            ErrorCode::ResourceNotFound | ErrorCode::OperationCanceled
        ),
        "ClickHouse Phase 5E expired Temporary owner used the wrong error",
        "assertion=temporary_session_expired",
    )?;
    evidence.temporary += 1;
    Ok(())
}

async fn run_checkpoint<D: PhaseFiveEDispatcher>(
    dispatcher: &D,
    client: &Client,
    database: &str,
) -> IpcResult<PhaseFiveEEvidence> {
    let support = runtime_support(dispatcher, Some(database)).await?;
    let temporary_support = runtime_support(dispatcher, None).await?;
    ensure(
        !support.cluster_ddl.executable && !temporary_support.cluster_ddl.executable,
        "ClickHouse Phase 5E baseline unexpectedly published Cluster execution",
        "assertion=cluster_execution_unpublished",
    )?;
    let mut evidence = PhaseFiveEEvidence {
        server_version: support.server_version.clone(),
        normal: 0,
        parameterized: 0,
        temporary: 0,
        materialized: 0,
        refreshable: 0,
        window_supported: 0,
        window_unavailable: 0,
        live_supported: 0,
        live_unavailable: 0,
        alters: 0,
        renames: 0,
        drops: 0,
        confirmation_rejections: 0,
        drift_conflicts: 0,
        background_observations: 0,
    };

    run_normal_matrix(dispatcher, client, database, &support, &mut evidence).await?;
    run_parameterized_matrix(dispatcher, client, database, &support, &mut evidence).await?;
    run_materialized_matrix(dispatcher, client, database, &support, &mut evidence).await?;
    run_refreshable_matrix(dispatcher, database, &support, &mut evidence).await?;
    run_window_matrix(dispatcher, database, &support, &mut evidence).await?;
    run_live_matrix(dispatcher, database, &support, &mut evidence).await?;
    run_temporary_matrix(dispatcher, database, &temporary_support, &mut evidence).await?;

    evidence.validate_counts()?;
    Ok(evidence)
}

pub(super) async fn run_direct(
    record: &StoredConnectionRecord,
    client: &Client,
    prefix: &str,
) -> IpcResult<PhaseFiveEEvidence> {
    let database_name = unique_database_name(prefix)?;
    let cleanup = PhaseFiveECleanupGuard::new(database_name.clone(), prefix)?;
    cleanup.cleanup(client).await?;
    create_fixture(client, &database_name).await?;

    let driver = DriverRegistry::create_driver("real-clickhouse-phase-5e-direct", record).await?;
    let tab_driver = DriverRegistry::create_tab_driver(
        "real-clickhouse-phase-5e-direct",
        OWNER_TAB_RUNTIME_ID,
        record,
    )
    .await?;
    let checkpoint = async {
        validate_capability_published(&driver.capabilities())?;
        validate_capability_published(&tab_driver.capabilities())?;
        ensure(
            driver.as_schema_mutator().is_none()
                && tab_driver.as_schema_mutator().is_none()
                && driver.as_native_schema_extension().is_some()
                && tab_driver.as_native_schema_extension().is_some(),
            "ClickHouse Phase 5E direct drivers exposed the wrong extension set",
            "assertion=driver_extensions",
        )?;
        let dispatcher = DirectPhaseFiveEDispatcher {
            extension: driver
                .as_native_schema_extension()
                .expect("checked shared extension"),
            tab_extension: tab_driver
                .as_native_schema_extension()
                .expect("checked tab extension"),
            tab_driver: tab_driver.as_ref(),
        };
        run_checkpoint(&dispatcher, client, &database_name).await
    }
    .await;

    let tab_close = tab_driver.close().await;
    let driver_close = driver.close().await;
    let cleanup_result = cleanup.cleanup(client).await;
    if let Err(error) = checkpoint {
        return Err(error);
    }
    tab_close?;
    driver_close?;
    cleanup_result?;
    checkpoint
}

pub(super) async fn run_manager(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    record: &StoredConnectionRecord,
    client: &Client,
    prefix: &str,
) -> IpcResult<PhaseFiveEEvidence> {
    let database_name = unique_database_name(prefix)?;
    let cleanup = PhaseFiveECleanupGuard::new(database_name.clone(), prefix)?;
    cleanup.cleanup(client).await?;
    create_fixture(client, &database_name).await?;

    let checkpoint = async {
        validate_capability_published(&manager.capabilities(profile_id)?.capabilities)?;
        let tab_info = manager
            .open_tab_runtime(profile_id, OWNER_TAB_RUNTIME_ID, record)
            .await?;
        validate_capability_published(&tab_info.capabilities)?;
        let dispatcher = ManagerPhaseFiveEDispatcher {
            manager,
            profile_id,
            owner_tab_runtime_id: OWNER_TAB_RUNTIME_ID,
        };
        run_checkpoint(&dispatcher, client, &database_name).await
    }
    .await;

    let tab_close = manager.close_tab_runtime(OWNER_TAB_RUNTIME_ID).await;
    let cleanup_result = cleanup.cleanup(client).await;
    if let Err(error) = checkpoint {
        return Err(error);
    }
    tab_close?;
    cleanup_result?;
    checkpoint
}

fn ensure(condition: bool, message: &str, details: &str) -> IpcResult<()> {
    if condition {
        Ok(())
    } else {
        Err(IpcError::system_internal(message, details))
    }
}

fn checkpoint_error(message: &str) -> IpcError {
    IpcError::system_internal(message, "checkpoint=phase_five_e")
}
