use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::engine::drivers::clickhouse::schema::{
    ClickHouseAlterTableTarget, ClickHouseClusterViewBaseline, ClickHouseColumnActionResult,
    ClickHouseColumnDataActionTarget, ClickHouseCreateDatabaseResult,
    ClickHouseCreateDatabaseTarget, ClickHouseCreateTableResult, ClickHouseCreateTableTarget,
    ClickHouseDatabaseBaseline, ClickHouseDropDatabaseResult, ClickHouseDropDatabaseTarget,
    ClickHouseDropTableResult, ClickHouseDropTableTarget, ClickHouseProjectionActionTarget,
    ClickHouseProjectionChangeResult, ClickHouseProjectionCreateTarget,
    ClickHouseSkippingIndexActionTarget, ClickHouseSkippingIndexChangeResult,
    ClickHouseSkippingIndexCreateTarget, ClickHouseTableAlterResult, ClickHouseTableSchema,
    ClickHouseViewAlterTarget, ClickHouseViewChangeResult, ClickHouseViewCreateResult,
    ClickHouseViewCreateTarget, ClickHouseViewDropTarget, ClickHouseViewRenameTarget,
    ClickHouseViewRuntimeSupport, ClickHouseViewSchema,
};
use crate::engine::types::{ContainerKind, ContainerRef, SchemaMutationOperation};
use crate::error::{IpcError, IpcResult};

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
pub enum NativeSchemaDescribeRequest {
    Table(ContainerRef),
    View(ContainerRef),
}

impl NativeSchemaDescribeRequest {
    pub fn container(&self) -> &ContainerRef {
        match self {
            Self::Table(container) | Self::View(container) => container,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeSchemaDocument {
    ClickHouseTable(Box<ClickHouseTableSchema>),
    ClickHouseView(Box<ClickHouseViewSchema>),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
#[allow(dead_code)]
pub enum NativeSchemaSupportRequest {
    #[serde(rename = "clickhouse_view")]
    ClickHouseView {
        database: Option<String>,
        cluster_name: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "document")]
#[allow(dead_code)]
pub enum NativeSchemaSupportDocument {
    #[serde(rename = "clickhouse_view")]
    ClickHouseView(ClickHouseViewRuntimeSupport),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum NativeSchemaSessionListRequest {
    #[serde(rename = "clickhouse_temporary_views")]
    ClickHouseTemporaryViews,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "documents")]
#[allow(dead_code)]
pub enum NativeSchemaSessionDocuments {
    #[serde(rename = "clickhouse_views")]
    ClickHouseViews(Vec<ClickHouseViewSchema>),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "target")]
#[allow(dead_code)]
#[allow(clippy::enum_variant_names)]
pub enum NativeSchemaCreateTarget {
    #[serde(rename = "clickhouse_database")]
    ClickHouseDatabase(ClickHouseCreateDatabaseTarget),
    #[serde(rename = "clickhouse_table")]
    ClickHouseTable(Box<ClickHouseCreateTableTarget>),
    #[serde(rename = "clickhouse_view")]
    ClickHouseView(Box<ClickHouseViewCreateTarget>),
}

#[allow(dead_code)]
impl NativeSchemaCreateTarget {
    pub fn object_kind(&self) -> ContainerKind {
        match self {
            Self::ClickHouseDatabase(_) => ContainerKind::Database,
            Self::ClickHouseTable(_) => ContainerKind::Table,
            Self::ClickHouseView(target) => target.desired.address.object_kind.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct NativeSchemaExecuteCreateRequest {
    pub target: NativeSchemaCreateTarget,
    pub expected_plan_hash: String,
    pub confirmation: Option<NativeSchemaConfirmationInput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline: Option<NativeSchemaChangeBaseline>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct NativeSchemaMutationPreview {
    pub statements: Vec<String>,
    pub warnings: Vec<String>,
    pub destructive: bool,
    pub long_running: bool,
    pub risk_flags: Vec<NativeSchemaRiskFlag>,
    pub required_confirmation: NativeSchemaRequiredConfirmation,
    pub plan_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline: Option<NativeSchemaChangeBaseline>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "result")]
#[allow(dead_code)]
#[allow(clippy::enum_variant_names)]
pub enum NativeSchemaCreateResult {
    #[serde(rename = "clickhouse_database")]
    ClickHouseDatabase(ClickHouseCreateDatabaseResult),
    #[serde(rename = "clickhouse_table")]
    ClickHouseTable(Box<ClickHouseCreateTableResult>),
    #[serde(rename = "clickhouse_view")]
    ClickHouseView(Box<ClickHouseViewCreateResult>),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub enum NativeSchemaExecutionStatus {
    Applied,
    Submitted,
    PartiallyApplied,
    OutcomeUnknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NativeSchemaRiskFlag {
    Destructive,
    DataLoss,
    LongRunning,
    BackgroundWork,
    ClusterNonAtomic,
    Experimental,
    Deprecated,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NativeSchemaRequiredConfirmation {
    None,
    Confirm,
    TypeObjectName,
    TypeObjectAndCluster,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSchemaConfirmationInput {
    pub accepted: bool,
    pub object_name: Option<String>,
    pub cluster_name: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NativeSchemaBackgroundWorkKind {
    InitialRefresh,
    Populate,
    WindowInitialization,
    DistributedDdl,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NativeSchemaBackgroundWorkState {
    Submitted,
    Running,
    Succeeded,
    Failed,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSchemaBackgroundWork {
    pub kind: NativeSchemaBackgroundWorkKind,
    pub state: NativeSchemaBackgroundWorkState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct NativeSchemaStatementProgress {
    pub applied_count: u32,
    pub failed_statement_index: Option<u32>,
    pub remaining_count: u32,
    pub query_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "target")]
#[allow(dead_code)]
#[allow(clippy::enum_variant_names)]
pub enum NativeSchemaChangeTarget {
    #[serde(rename = "clickhouse_table_alter")]
    ClickHouseTableAlter(Box<ClickHouseAlterTableTarget>),
    #[serde(rename = "clickhouse_table_drop")]
    ClickHouseTableDrop(ClickHouseDropTableTarget),
    #[serde(rename = "clickhouse_database_drop")]
    ClickHouseDatabaseDrop(ClickHouseDropDatabaseTarget),
    #[serde(rename = "clickhouse_column_clear")]
    ClickHouseColumnClear(Box<ClickHouseColumnDataActionTarget>),
    #[serde(rename = "clickhouse_column_materialize")]
    ClickHouseColumnMaterialize(Box<ClickHouseColumnDataActionTarget>),
    #[serde(rename = "clickhouse_projection_create")]
    ClickHouseProjectionCreate(Box<ClickHouseProjectionCreateTarget>),
    #[serde(rename = "clickhouse_projection_drop")]
    ClickHouseProjectionDrop(Box<ClickHouseProjectionActionTarget>),
    #[serde(rename = "clickhouse_projection_materialize")]
    ClickHouseProjectionMaterialize(Box<ClickHouseProjectionActionTarget>),
    #[serde(rename = "clickhouse_projection_clear")]
    ClickHouseProjectionClear(Box<ClickHouseProjectionActionTarget>),
    #[serde(rename = "clickhouse_skipping_index_create")]
    ClickHouseSkippingIndexCreate(Box<ClickHouseSkippingIndexCreateTarget>),
    #[serde(rename = "clickhouse_skipping_index_drop")]
    ClickHouseSkippingIndexDrop(Box<ClickHouseSkippingIndexActionTarget>),
    #[serde(rename = "clickhouse_skipping_index_materialize")]
    ClickHouseSkippingIndexMaterialize(Box<ClickHouseSkippingIndexActionTarget>),
    #[serde(rename = "clickhouse_skipping_index_clear")]
    ClickHouseSkippingIndexClear(Box<ClickHouseSkippingIndexActionTarget>),
    #[serde(rename = "clickhouse_view_alter")]
    ClickHouseViewAlter(Box<ClickHouseViewAlterTarget>),
    #[serde(rename = "clickhouse_view_rename")]
    ClickHouseViewRename(Box<ClickHouseViewRenameTarget>),
    #[serde(rename = "clickhouse_view_drop")]
    ClickHouseViewDrop(Box<ClickHouseViewDropTarget>),
}

#[allow(dead_code)]
impl NativeSchemaChangeTarget {
    pub fn object_kind(&self) -> ContainerKind {
        match self {
            Self::ClickHouseTableAlter(_) | Self::ClickHouseTableDrop(_) => ContainerKind::Table,
            Self::ClickHouseDatabaseDrop(_) => ContainerKind::Database,
            Self::ClickHouseColumnClear(_) | Self::ClickHouseColumnMaterialize(_) => {
                ContainerKind::Column
            }
            Self::ClickHouseProjectionCreate(_)
            | Self::ClickHouseProjectionDrop(_)
            | Self::ClickHouseProjectionMaterialize(_)
            | Self::ClickHouseProjectionClear(_) => ContainerKind::Projection,
            Self::ClickHouseSkippingIndexCreate(_)
            | Self::ClickHouseSkippingIndexDrop(_)
            | Self::ClickHouseSkippingIndexMaterialize(_)
            | Self::ClickHouseSkippingIndexClear(_) => ContainerKind::Index,
            Self::ClickHouseViewAlter(target) => {
                target.baseline.identity.address.object_kind.clone()
            }
            Self::ClickHouseViewRename(target) => {
                target.baseline.identity.address.object_kind.clone()
            }
            Self::ClickHouseViewDrop(target) => {
                target.baseline.identity.address.object_kind.clone()
            }
        }
    }

    pub fn operation(&self) -> SchemaMutationOperation {
        match self {
            Self::ClickHouseTableAlter(_) => SchemaMutationOperation::Alter,
            Self::ClickHouseTableDrop(_) | Self::ClickHouseDatabaseDrop(_) => {
                SchemaMutationOperation::Drop
            }
            Self::ClickHouseColumnClear(_) => SchemaMutationOperation::Clear,
            Self::ClickHouseColumnMaterialize(_) => SchemaMutationOperation::Materialize,
            Self::ClickHouseProjectionCreate(_) | Self::ClickHouseSkippingIndexCreate(_) => {
                SchemaMutationOperation::Create
            }
            Self::ClickHouseProjectionDrop(_) | Self::ClickHouseSkippingIndexDrop(_) => {
                SchemaMutationOperation::Drop
            }
            Self::ClickHouseProjectionClear(_) | Self::ClickHouseSkippingIndexClear(_) => {
                SchemaMutationOperation::Clear
            }
            Self::ClickHouseProjectionMaterialize(_)
            | Self::ClickHouseSkippingIndexMaterialize(_) => SchemaMutationOperation::Materialize,
            Self::ClickHouseViewAlter(_) => SchemaMutationOperation::Alter,
            Self::ClickHouseViewRename(_) => SchemaMutationOperation::Rename,
            Self::ClickHouseViewDrop(_) => SchemaMutationOperation::Drop,
        }
    }

    pub fn requires_remote_drift_protection(&self) -> bool {
        true
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "baseline")]
#[allow(dead_code)]
#[allow(clippy::enum_variant_names)]
pub enum NativeSchemaChangeBaseline {
    #[serde(rename = "clickhouse_table")]
    ClickHouseTable(Box<ClickHouseTableSchema>),
    #[serde(rename = "clickhouse_database")]
    ClickHouseDatabase(ClickHouseDatabaseBaseline),
    #[serde(rename = "clickhouse_view")]
    ClickHouseView(Box<ClickHouseViewSchema>),
    #[serde(rename = "clickhouse_cluster_view")]
    ClickHouseClusterView(Box<ClickHouseClusterViewBaseline>),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct NativeSchemaOperationSummary {
    pub code: String,
    pub object_name: String,
    pub destructive: bool,
    pub long_running: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct NativeSchemaChangePlan {
    pub statements: Vec<String>,
    pub warnings: Vec<String>,
    pub destructive: bool,
    pub long_running: bool,
    pub risk_flags: Vec<NativeSchemaRiskFlag>,
    pub required_confirmation: NativeSchemaRequiredConfirmation,
    pub plan_hash: String,
    pub expected_target_revision: Option<String>,
    pub operations: Vec<NativeSchemaOperationSummary>,
    pub baseline: NativeSchemaChangeBaseline,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct NativeSchemaExecuteChangeRequest {
    pub target: NativeSchemaChangeTarget,
    pub baseline: NativeSchemaChangeBaseline,
    pub expected_plan_hash: String,
    pub confirmation: Option<NativeSchemaConfirmationInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "result")]
#[allow(dead_code)]
#[allow(clippy::enum_variant_names)]
pub enum NativeSchemaChangeResult {
    #[serde(rename = "clickhouse_table_alter")]
    ClickHouseTableAlter(Box<ClickHouseTableAlterResult>),
    #[serde(rename = "clickhouse_column_action")]
    ClickHouseColumnAction(Box<ClickHouseColumnActionResult>),
    #[serde(rename = "clickhouse_table_drop")]
    ClickHouseTableDrop(ClickHouseDropTableResult),
    #[serde(rename = "clickhouse_database_drop")]
    ClickHouseDatabaseDrop(ClickHouseDropDatabaseResult),
    #[serde(rename = "clickhouse_projection_change")]
    ClickHouseProjectionChange(Box<ClickHouseProjectionChangeResult>),
    #[serde(rename = "clickhouse_skipping_index_change")]
    ClickHouseSkippingIndexChange(Box<ClickHouseSkippingIndexChangeResult>),
    #[serde(rename = "clickhouse_view_change")]
    ClickHouseViewChange(Box<ClickHouseViewChangeResult>),
}

#[async_trait]
pub trait NativeSchemaExtension: Send + Sync {
    #[allow(dead_code)]
    async fn support(
        &self,
        _request: &NativeSchemaSupportRequest,
    ) -> IpcResult<NativeSchemaSupportDocument> {
        Err(IpcError::feature_unavailable(
            "This connection does not support native schema capability discovery",
        ))
    }

    #[allow(dead_code)]
    async fn list_session_documents(
        &self,
        _request: &NativeSchemaSessionListRequest,
    ) -> IpcResult<NativeSchemaSessionDocuments> {
        Err(IpcError::feature_unavailable(
            "This connection does not support tab-scoped native schema documents",
        ))
    }

    async fn describe(
        &self,
        request: &NativeSchemaDescribeRequest,
    ) -> IpcResult<NativeSchemaDocument>;

    #[allow(dead_code)]
    async fn preview_create(
        &self,
        target: &NativeSchemaCreateTarget,
    ) -> IpcResult<NativeSchemaMutationPreview>;

    #[allow(dead_code)]
    async fn execute_create(
        &self,
        request: &NativeSchemaExecuteCreateRequest,
    ) -> IpcResult<NativeSchemaCreateResult>;

    #[allow(dead_code)]
    async fn preview_change(
        &self,
        _target: &NativeSchemaChangeTarget,
    ) -> IpcResult<NativeSchemaChangePlan> {
        Err(IpcError::resource_not_found(
            "This connection does not support native schema changes",
        ))
    }

    #[allow(dead_code)]
    async fn execute_change(
        &self,
        _request: &NativeSchemaExecuteChangeRequest,
    ) -> IpcResult<NativeSchemaChangeResult> {
        Err(IpcError::resource_not_found(
            "This connection does not support native schema changes",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::engine::drivers::clickhouse::schema::{
        ClickHouseAlterTableTarget, ClickHouseClusterDdlSupport, ClickHouseClusterExecutionOutcome,
        ClickHouseClusterViewBaseline, ClickHouseCodecTarget, ClickHouseColumnDataActionTarget,
        ClickHouseColumnDefaultKind, ClickHouseColumnRenameIntent, ClickHouseCreateColumnTarget,
        ClickHouseCreateDatabaseResult, ClickHouseCreateEngineTarget, ClickHouseCreateTableResult,
        ClickHouseCreateTableTarget, ClickHouseDropDatabaseTarget, ClickHouseDropTableTarget,
        ClickHouseEngineSchema, ClickHouseKeySchema, ClickHouseProjectionActionTarget,
        ClickHouseProjectionChangeResult, ClickHouseProjectionCreateTarget,
        ClickHouseProjectionTarget, ClickHouseSchemaBaseline, ClickHouseSchemaEditability,
        ClickHouseSkippingIndexActionTarget, ClickHouseSkippingIndexChangeResult,
        ClickHouseSkippingIndexCreateTarget, ClickHouseSkippingIndexTarget, ClickHouseSupportState,
        ClickHouseTableIdentity, ClickHouseTableSchema, ClickHouseViewAddress,
        ClickHouseViewAlterTarget, ClickHouseViewBaseline, ClickHouseViewColumnDefinition,
        ClickHouseViewCreateResult, ClickHouseViewCreateTarget, ClickHouseViewDefinitionTarget,
        ClickHouseViewDropTarget, ClickHouseViewFamily, ClickHouseViewFamilyDefinition,
        ClickHouseViewFamilySupport, ClickHouseViewIdentity, ClickHouseViewOperationSupport,
        ClickHouseViewRenameTarget, ClickHouseViewRuntimeSupport, ClickHouseViewSchema,
        ClickHouseViewScope, ClickHouseViewScopeTarget, ClickHouseViewSecurity,
    };
    use crate::engine::types::SchemaMutationOperation;

    fn table_target() -> ClickHouseCreateTableTarget {
        ClickHouseCreateTableTarget {
            database: "analytics".to_string(),
            name: "events".to_string(),
            columns: vec![ClickHouseCreateColumnTarget {
                name: "id".to_string(),
                type_name: "UInt64".to_string(),
                default_kind: ClickHouseColumnDefaultKind::None,
                default_expression: None,
                codecs: vec![ClickHouseCodecTarget {
                    name: "ZSTD".to_string(),
                    arguments: vec!["1".to_string()],
                }],
                ttl_expression: None,
                comment: Some("event id".to_string()),
            }],
            engine: ClickHouseCreateEngineTarget {
                family: "MergeTree".to_string(),
                arguments: Vec::new(),
            },
            keys: ClickHouseKeySchema {
                order_by: "tuple()".to_string(),
                partition_by: None,
                primary_key: None,
                sample_by: None,
            },
            table_ttl: None,
            comment: None,
            settings: Vec::new(),
        }
    }

    fn described_schema() -> ClickHouseTableSchema {
        ClickHouseTableSchema {
            identity: ClickHouseTableIdentity {
                database: "analytics".to_string(),
                name: "events".to_string(),
                object_kind: crate::engine::types::ContainerKind::Table,
                uuid: None,
            },
            engine: ClickHouseEngineSchema {
                family: "MergeTree".to_string(),
                arguments: Vec::new(),
                raw_expression: "MergeTree".to_string(),
            },
            columns: Vec::new(),
            keys: ClickHouseKeySchema {
                order_by: "tuple()".to_string(),
                partition_by: None,
                primary_key: None,
                sample_by: None,
            },
            table_ttl: None,
            comment: None,
            settings: Vec::new(),
            projections: Vec::new(),
            skipping_indexes: Vec::new(),
            editability: ClickHouseSchemaEditability::editable(),
            baseline: ClickHouseSchemaBaseline {
                canonical_create_query: "CREATE TABLE `analytics`.`events` (`id` UInt64) ENGINE = MergeTree ORDER BY tuple()".to_string(),
                revision_hash: "0".repeat(64),
            },
        }
    }

    fn view_operation_support() -> ClickHouseViewOperationSupport {
        ClickHouseViewOperationSupport {
            state: ClickHouseSupportState::Supported,
            reason: None,
        }
    }

    fn view_family_support() -> ClickHouseViewFamilySupport {
        let operation = view_operation_support();
        ClickHouseViewFamilySupport {
            describe: operation.clone(),
            create: operation.clone(),
            alter: operation.clone(),
            rename: operation.clone(),
            drop: operation,
        }
    }

    fn view_runtime_support() -> ClickHouseViewRuntimeSupport {
        let family = view_family_support();
        ClickHouseViewRuntimeSupport {
            server_version: "25.3.1".to_string(),
            database_engine: Some("Atomic".to_string()),
            normal: family.clone(),
            parameterized: family.clone(),
            temporary: family.clone(),
            materialized: family.clone(),
            refreshable_materialized: family.clone(),
            window: family.clone(),
            live: family,
            cluster_ddl: ClickHouseClusterDdlSupport {
                discoverable: true,
                executable: false,
                observable: false,
                drift_verifiable: false,
            },
            support_revision: "1".repeat(64),
        }
    }

    fn view_definition_target() -> ClickHouseViewDefinitionTarget {
        ClickHouseViewDefinitionTarget {
            address: ClickHouseViewAddress {
                database: Some("analytics".to_string()),
                name: "events_view".to_string(),
                object_kind: ContainerKind::View,
            },
            family: ClickHouseViewFamily::Normal,
            scope: ClickHouseViewScopeTarget::Local,
            columns: ClickHouseViewColumnDefinition::None,
            query: "SELECT 1".to_string(),
            security: ClickHouseViewSecurity {
                definer: None,
                sql_security: None,
            },
            comment: None,
            family_definition: ClickHouseViewFamilyDefinition::Normal,
        }
    }

    fn view_schema() -> ClickHouseViewSchema {
        let desired = view_definition_target();
        ClickHouseViewSchema {
            identity: ClickHouseViewIdentity {
                address: desired.address,
                uuid: None,
            },
            family: desired.family,
            scope: ClickHouseViewScope::Local,
            columns: desired.columns,
            query: desired.query,
            security: desired.security,
            comment: desired.comment,
            family_definition: desired.family_definition,
            server_support: view_runtime_support(),
            editability: ClickHouseSchemaEditability::editable(),
            baseline: ClickHouseViewBaseline {
                canonical_create_query: "CREATE VIEW `analytics`.`events_view` AS SELECT 1"
                    .to_string(),
                revision_hash: "2".repeat(64),
                server_version: "25.3.1".to_string(),
                family: ClickHouseViewFamily::Normal,
                support_revision: "1".repeat(64),
            },
        }
    }

    fn table_alter_target() -> NativeSchemaChangeTarget {
        NativeSchemaChangeTarget::ClickHouseTableAlter(Box::new(ClickHouseAlterTableTarget {
            baseline: described_schema(),
            desired: table_target(),
            column_renames: vec![ClickHouseColumnRenameIntent {
                from: "id".to_string(),
                to: "event_id".to_string(),
            }],
        }))
    }

    fn table_drop_target() -> NativeSchemaChangeTarget {
        NativeSchemaChangeTarget::ClickHouseTableDrop(ClickHouseDropTableTarget {
            container: crate::engine::types::ContainerRef::table(
                crate::engine::types::ContainerKind::Table,
                "analytics",
                None,
                "events",
            ),
        })
    }

    fn database_drop_target() -> NativeSchemaChangeTarget {
        NativeSchemaChangeTarget::ClickHouseDatabaseDrop(ClickHouseDropDatabaseTarget {
            container: crate::engine::types::ContainerRef::database("analytics"),
        })
    }

    fn column_action_target(materialize: bool) -> NativeSchemaChangeTarget {
        let target = Box::new(ClickHouseColumnDataActionTarget {
            baseline: described_schema(),
            column_name: "id".to_string(),
        });
        if materialize {
            NativeSchemaChangeTarget::ClickHouseColumnMaterialize(target)
        } else {
            NativeSchemaChangeTarget::ClickHouseColumnClear(target)
        }
    }

    fn projection_target(operation: SchemaMutationOperation) -> NativeSchemaChangeTarget {
        let baseline = described_schema();
        match operation {
            SchemaMutationOperation::Create => {
                NativeSchemaChangeTarget::ClickHouseProjectionCreate(Box::new(
                    ClickHouseProjectionCreateTarget {
                        baseline,
                        projection: ClickHouseProjectionTarget {
                            name: "by_tenant".to_string(),
                            query: "SELECT tenant_id, count() GROUP BY tenant_id".to_string(),
                        },
                    },
                ))
            }
            SchemaMutationOperation::Drop => NativeSchemaChangeTarget::ClickHouseProjectionDrop(
                Box::new(ClickHouseProjectionActionTarget {
                    baseline,
                    projection_name: "by_tenant".to_string(),
                }),
            ),
            SchemaMutationOperation::Clear => NativeSchemaChangeTarget::ClickHouseProjectionClear(
                Box::new(ClickHouseProjectionActionTarget {
                    baseline,
                    projection_name: "by_tenant".to_string(),
                }),
            ),
            SchemaMutationOperation::Materialize => {
                NativeSchemaChangeTarget::ClickHouseProjectionMaterialize(Box::new(
                    ClickHouseProjectionActionTarget {
                        baseline,
                        projection_name: "by_tenant".to_string(),
                    },
                ))
            }
            SchemaMutationOperation::Alter | SchemaMutationOperation::Rename => {
                unreachable!("projection ALTER/RENAME is unsupported")
            }
        }
    }

    fn skipping_index_target(operation: SchemaMutationOperation) -> NativeSchemaChangeTarget {
        let baseline = described_schema();
        match operation {
            SchemaMutationOperation::Create => {
                NativeSchemaChangeTarget::ClickHouseSkippingIndexCreate(Box::new(
                    ClickHouseSkippingIndexCreateTarget {
                        baseline,
                        index: ClickHouseSkippingIndexTarget {
                            name: "payload_bf".to_string(),
                            expression: "payload".to_string(),
                            index_type: "tokenbf_v1".to_string(),
                            type_arguments: vec![
                                "256".to_string(),
                                "2".to_string(),
                                "0".to_string(),
                            ],
                            granularity: 1,
                        },
                    },
                ))
            }
            SchemaMutationOperation::Drop => NativeSchemaChangeTarget::ClickHouseSkippingIndexDrop(
                Box::new(ClickHouseSkippingIndexActionTarget {
                    baseline,
                    index_name: "payload_bf".to_string(),
                }),
            ),
            SchemaMutationOperation::Clear => {
                NativeSchemaChangeTarget::ClickHouseSkippingIndexClear(Box::new(
                    ClickHouseSkippingIndexActionTarget {
                        baseline,
                        index_name: "payload_bf".to_string(),
                    },
                ))
            }
            SchemaMutationOperation::Materialize => {
                NativeSchemaChangeTarget::ClickHouseSkippingIndexMaterialize(Box::new(
                    ClickHouseSkippingIndexActionTarget {
                        baseline,
                        index_name: "payload_bf".to_string(),
                    },
                ))
            }
            SchemaMutationOperation::Alter | SchemaMutationOperation::Rename => {
                unreachable!("index ALTER/RENAME is unsupported")
            }
        }
    }

    #[test]
    fn native_create_target_and_preview_serialize_with_stable_tags() {
        let target = table_target();
        let untagged = serde_json::to_value(&target).expect("serialize table target");
        assert!(untagged.get("kind").is_none());

        let tagged = NativeSchemaCreateTarget::ClickHouseTable(Box::new(target));
        let tagged_value = serde_json::to_value(tagged).expect("serialize tagged target");
        assert_eq!(tagged_value["kind"], "clickhouse_table");
        assert_eq!(tagged_value["target"]["database"], "analytics");

        let preview = NativeSchemaMutationPreview {
            statements: vec!["CREATE TABLE `analytics`.`events` (`id` UInt64) ENGINE = MergeTree ORDER BY tuple()".to_string()],
            warnings: Vec::new(),
            destructive: false,
            long_running: false,
            risk_flags: Vec::new(),
            required_confirmation: NativeSchemaRequiredConfirmation::None,
            plan_hash: "a".repeat(64),
            baseline: None,
        };
        let preview_value = serde_json::to_value(preview).expect("serialize preview");
        assert_eq!(preview_value["planHash"], "a".repeat(64));
        assert_eq!(preview_value["longRunning"], false);
        assert_eq!(preview_value["riskFlags"], serde_json::json!([]));
        assert_eq!(preview_value["requiredConfirmation"], "none");
    }

    #[test]
    fn native_schema_risk_and_confirmation_contract_has_stable_tags() {
        assert_eq!(
            serde_json::to_value(NativeSchemaRiskFlag::BackgroundWork)
                .expect("serialize risk flag"),
            "backgroundWork"
        );
        assert_eq!(
            serde_json::to_value(NativeSchemaRequiredConfirmation::TypeObjectAndCluster)
                .expect("serialize confirmation level"),
            "typeObjectAndCluster"
        );

        let confirmation = NativeSchemaConfirmationInput {
            accepted: true,
            object_name: Some("events_mv".to_string()),
            cluster_name: Some("analytics_cluster".to_string()),
        };
        let value = serde_json::to_value(confirmation).expect("serialize confirmation input");
        assert_eq!(value["accepted"], true);
        assert_eq!(value["objectName"], "events_mv");
        assert_eq!(value["clusterName"], "analytics_cluster");

        let background_work = NativeSchemaBackgroundWork {
            kind: NativeSchemaBackgroundWorkKind::InitialRefresh,
            state: NativeSchemaBackgroundWorkState::Running,
        };
        let value = serde_json::to_value(background_work).expect("serialize background work");
        assert_eq!(value["kind"], "initialRefresh");
        assert_eq!(value["state"], "running");
    }

    #[test]
    fn native_schema_plans_and_requests_use_one_typed_confirmation_model() {
        let baseline = NativeSchemaChangeBaseline::ClickHouseTable(Box::new(described_schema()));
        let plan = NativeSchemaChangePlan {
            statements: vec!["DROP TABLE `analytics`.`events` SYNC".to_string()],
            warnings: Vec::new(),
            destructive: true,
            long_running: false,
            risk_flags: vec![NativeSchemaRiskFlag::Destructive],
            required_confirmation: NativeSchemaRequiredConfirmation::Confirm,
            plan_hash: "b".repeat(64),
            expected_target_revision: None,
            operations: vec![NativeSchemaOperationSummary {
                code: "table.drop".to_string(),
                object_name: "analytics.events".to_string(),
                destructive: true,
                long_running: false,
            }],
            baseline: baseline.clone(),
        };
        let value = serde_json::to_value(plan).expect("serialize change plan");
        assert_eq!(value["riskFlags"], serde_json::json!(["destructive"]));
        assert_eq!(value["requiredConfirmation"], "confirm");

        let confirmation = Some(NativeSchemaConfirmationInput {
            accepted: true,
            object_name: None,
            cluster_name: None,
        });
        let create_request = NativeSchemaExecuteCreateRequest {
            target: NativeSchemaCreateTarget::ClickHouseTable(Box::new(table_target())),
            expected_plan_hash: "a".repeat(64),
            confirmation: confirmation.clone(),
            baseline: None,
        };
        let change_request = NativeSchemaExecuteChangeRequest {
            target: table_drop_target(),
            baseline,
            expected_plan_hash: "b".repeat(64),
            confirmation,
        };

        for value in [
            serde_json::to_value(create_request).expect("serialize create request"),
            serde_json::to_value(change_request).expect("serialize change request"),
        ] {
            assert_eq!(value["confirmation"]["accepted"], true);
            assert!(value.get("confirmDestructive").is_none());
        }
    }

    #[test]
    fn native_create_results_keep_clickhouse_result_variants_typed() {
        let database_result =
            NativeSchemaCreateResult::ClickHouseDatabase(ClickHouseCreateDatabaseResult {
                name: "analytics".to_string(),
                container: crate::engine::types::ContainerRef::database("analytics"),
            });
        let database_value =
            serde_json::to_value(database_result).expect("serialize database result");
        assert_eq!(database_value["kind"], "clickhouse_database");
        assert_eq!(database_value["result"]["name"], "analytics");

        let table_result = ClickHouseCreateTableResult {
            container: crate::engine::types::ContainerRef::table(
                crate::engine::types::ContainerKind::Table,
                "analytics",
                None,
                "events",
            ),
            table_name: "events".to_string(),
            schema: described_schema(),
        };
        let table_value = serde_json::to_value(NativeSchemaCreateResult::ClickHouseTable(
            Box::new(table_result),
        ))
        .expect("serialize table result");
        assert_eq!(table_value["kind"], "clickhouse_table");
        assert_eq!(table_value["result"]["tableName"], "events");
        assert_eq!(
            table_value["result"]["schema"]["identity"]["name"],
            "events"
        );
    }

    #[test]
    fn native_change_contract_serializes_stable_tags_and_progress() {
        let value = serde_json::to_value(table_alter_target()).expect("serialize alter target");
        assert_eq!(value["kind"], "clickhouse_table_alter");
        assert_eq!(value["target"]["columnRenames"][0]["from"], "id");
        assert_eq!(value["target"]["columnRenames"][0]["to"], "event_id");

        for (target, expected_kind) in [
            (table_drop_target(), "clickhouse_table_drop"),
            (database_drop_target(), "clickhouse_database_drop"),
            (column_action_target(false), "clickhouse_column_clear"),
            (column_action_target(true), "clickhouse_column_materialize"),
        ] {
            let value = serde_json::to_value(target).expect("serialize native change target");
            assert_eq!(value["kind"], expected_kind);
        }

        let progress = NativeSchemaStatementProgress {
            applied_count: 1,
            failed_statement_index: Some(1),
            remaining_count: 2,
            query_ids: vec!["query-1".to_string(), "query-2".to_string()],
        };
        let value = serde_json::to_value(progress).expect("serialize statement progress");
        assert_eq!(value["appliedCount"], 1);
        assert_eq!(value["failedStatementIndex"], 1);
        assert_eq!(value["remainingCount"], 2);
        assert_eq!(value["queryIds"][1], "query-2");

        let statuses = [
            NativeSchemaExecutionStatus::Applied,
            NativeSchemaExecutionStatus::Submitted,
            NativeSchemaExecutionStatus::PartiallyApplied,
            NativeSchemaExecutionStatus::OutcomeUnknown,
        ];
        let value = serde_json::to_value(statuses).expect("serialize execution statuses");
        assert_eq!(
            value,
            serde_json::json!(["applied", "submitted", "partiallyApplied", "outcomeUnknown"])
        );
    }

    #[test]
    fn native_change_target_reports_exact_capability_key() {
        assert_eq!(
            table_alter_target().object_kind(),
            crate::engine::types::ContainerKind::Table
        );
        assert_eq!(
            table_alter_target().operation(),
            SchemaMutationOperation::Alter
        );
        assert_eq!(
            table_drop_target().operation(),
            SchemaMutationOperation::Drop
        );
        assert_eq!(
            database_drop_target().object_kind(),
            crate::engine::types::ContainerKind::Database
        );
        assert_eq!(
            column_action_target(false).object_kind(),
            crate::engine::types::ContainerKind::Column
        );
        assert_eq!(
            column_action_target(false).operation(),
            SchemaMutationOperation::Clear
        );
        assert_eq!(
            column_action_target(true).operation(),
            SchemaMutationOperation::Materialize
        );
    }

    #[test]
    fn native_table_object_targets_serialize_stable_tags() {
        let cases = [
            (
                projection_target(SchemaMutationOperation::Create),
                "clickhouse_projection_create",
                crate::engine::types::ContainerKind::Projection,
                SchemaMutationOperation::Create,
            ),
            (
                projection_target(SchemaMutationOperation::Drop),
                "clickhouse_projection_drop",
                crate::engine::types::ContainerKind::Projection,
                SchemaMutationOperation::Drop,
            ),
            (
                projection_target(SchemaMutationOperation::Clear),
                "clickhouse_projection_clear",
                crate::engine::types::ContainerKind::Projection,
                SchemaMutationOperation::Clear,
            ),
            (
                projection_target(SchemaMutationOperation::Materialize),
                "clickhouse_projection_materialize",
                crate::engine::types::ContainerKind::Projection,
                SchemaMutationOperation::Materialize,
            ),
            (
                skipping_index_target(SchemaMutationOperation::Create),
                "clickhouse_skipping_index_create",
                crate::engine::types::ContainerKind::Index,
                SchemaMutationOperation::Create,
            ),
            (
                skipping_index_target(SchemaMutationOperation::Drop),
                "clickhouse_skipping_index_drop",
                crate::engine::types::ContainerKind::Index,
                SchemaMutationOperation::Drop,
            ),
            (
                skipping_index_target(SchemaMutationOperation::Clear),
                "clickhouse_skipping_index_clear",
                crate::engine::types::ContainerKind::Index,
                SchemaMutationOperation::Clear,
            ),
            (
                skipping_index_target(SchemaMutationOperation::Materialize),
                "clickhouse_skipping_index_materialize",
                crate::engine::types::ContainerKind::Index,
                SchemaMutationOperation::Materialize,
            ),
        ];

        for (target, expected_tag, expected_kind, expected_operation) in cases {
            let value = serde_json::to_value(&target).expect("serialize table object target");
            assert_eq!(value["kind"], expected_tag);
            assert_eq!(target.object_kind(), expected_kind);
            assert_eq!(target.operation(), expected_operation);
            assert!(target.requires_remote_drift_protection());
        }
    }

    #[test]
    fn native_table_object_results_keep_typed_tags() {
        let progress = NativeSchemaStatementProgress {
            applied_count: 1,
            failed_statement_index: None,
            remaining_count: 0,
            query_ids: vec!["query-1".to_string()],
        };
        let projection = NativeSchemaChangeResult::ClickHouseProjectionChange(Box::new(
            ClickHouseProjectionChangeResult {
                status: NativeSchemaExecutionStatus::Applied,
                progress: progress.clone(),
                container: crate::engine::types::ContainerRef::table(
                    crate::engine::types::ContainerKind::Table,
                    "analytics",
                    None,
                    "events",
                ),
                projection_name: "by_tenant".to_string(),
                operation: SchemaMutationOperation::Create,
                schema: Some(described_schema()),
            },
        ));
        let index = NativeSchemaChangeResult::ClickHouseSkippingIndexChange(Box::new(
            ClickHouseSkippingIndexChangeResult {
                status: NativeSchemaExecutionStatus::Submitted,
                progress,
                container: crate::engine::types::ContainerRef::table(
                    crate::engine::types::ContainerKind::Table,
                    "analytics",
                    None,
                    "events",
                ),
                index_name: "payload_bf".to_string(),
                operation: SchemaMutationOperation::Materialize,
                schema: Some(described_schema()),
            },
        ));

        assert_eq!(
            serde_json::to_value(projection).unwrap()["kind"],
            "clickhouse_projection_change"
        );
        assert_eq!(
            serde_json::to_value(index).unwrap()["kind"],
            "clickhouse_skipping_index_change"
        );
    }

    #[test]
    fn native_view_targets_baselines_results_and_support_have_stable_tags() {
        let desired = view_definition_target();
        let create =
            NativeSchemaCreateTarget::ClickHouseView(Box::new(ClickHouseViewCreateTarget {
                desired: desired.clone(),
                expected_support_revision: "1".repeat(64),
            }));
        assert_eq!(
            serde_json::to_value(&create).unwrap()["kind"],
            "clickhouse_view"
        );
        assert_eq!(create.object_kind(), ContainerKind::View);

        let schema = view_schema();
        let changes = [
            (
                NativeSchemaChangeTarget::ClickHouseViewAlter(Box::new(
                    ClickHouseViewAlterTarget {
                        baseline: schema.clone(),
                        desired: desired.clone(),
                        expected_support_revision: "1".repeat(64),
                    },
                )),
                "clickhouse_view_alter",
                SchemaMutationOperation::Alter,
            ),
            (
                NativeSchemaChangeTarget::ClickHouseViewRename(Box::new(
                    ClickHouseViewRenameTarget {
                        baseline: schema.clone(),
                        destination: ClickHouseViewAddress {
                            name: "renamed_view".to_string(),
                            ..desired.address.clone()
                        },
                        expected_destination_absence_revision: "3".repeat(64),
                        expected_support_revision: "1".repeat(64),
                    },
                )),
                "clickhouse_view_rename",
                SchemaMutationOperation::Rename,
            ),
            (
                NativeSchemaChangeTarget::ClickHouseViewDrop(Box::new(ClickHouseViewDropTarget {
                    baseline: schema.clone(),
                    expected_support_revision: "1".repeat(64),
                })),
                "clickhouse_view_drop",
                SchemaMutationOperation::Drop,
            ),
        ];
        for (target, expected_tag, expected_operation) in changes {
            assert_eq!(serde_json::to_value(&target).unwrap()["kind"], expected_tag);
            assert_eq!(target.object_kind(), ContainerKind::View);
            assert_eq!(target.operation(), expected_operation);
        }

        let local_baseline = NativeSchemaChangeBaseline::ClickHouseView(Box::new(schema.clone()));
        let cluster_baseline = NativeSchemaChangeBaseline::ClickHouseClusterView(Box::new(
            ClickHouseClusterViewBaseline {
                cluster_name: "analytics_cluster".to_string(),
                topology_revision: "4".repeat(64),
                nodes: Vec::new(),
            },
        ));
        assert_eq!(
            serde_json::to_value(local_baseline).unwrap()["kind"],
            "clickhouse_view"
        );
        assert_eq!(
            serde_json::to_value(cluster_baseline).unwrap()["kind"],
            "clickhouse_cluster_view"
        );

        let progress = NativeSchemaStatementProgress {
            applied_count: 1,
            failed_statement_index: None,
            remaining_count: 0,
            query_ids: vec!["query-1".to_string()],
        };
        let create_result =
            NativeSchemaCreateResult::ClickHouseView(Box::new(ClickHouseViewCreateResult {
                status: NativeSchemaExecutionStatus::Applied,
                progress: progress.clone(),
                container: ContainerRef::table(
                    ContainerKind::View,
                    "analytics",
                    None,
                    "events_view",
                ),
                schema: Some(schema.clone()),
                background_work: None,
                cluster_outcome: None,
            }));
        let change_result =
            NativeSchemaChangeResult::ClickHouseViewChange(Box::new(ClickHouseViewChangeResult {
                status: NativeSchemaExecutionStatus::Applied,
                progress,
                operation: SchemaMutationOperation::Alter,
                source: ContainerRef::table(ContainerKind::View, "analytics", None, "events_view"),
                destination: None,
                schema: Some(schema.clone()),
                background_work: None,
                cluster_outcome: None::<ClickHouseClusterExecutionOutcome>,
            }));
        assert_eq!(
            serde_json::to_value(create_result).unwrap()["kind"],
            "clickhouse_view"
        );
        assert_eq!(
            serde_json::to_value(change_result).unwrap()["kind"],
            "clickhouse_view_change"
        );

        let support_request = NativeSchemaSupportRequest::ClickHouseView {
            database: Some("analytics".to_string()),
            cluster_name: Some("analytics_cluster".to_string()),
        };
        let request_json = serde_json::to_value(support_request).unwrap();
        assert_eq!(request_json["kind"], "clickhouse_view");
        assert_eq!(request_json["clusterName"], "analytics_cluster");
        assert_eq!(
            serde_json::to_value(NativeSchemaSupportDocument::ClickHouseView(
                view_runtime_support()
            ))
            .unwrap()["kind"],
            "clickhouse_view"
        );
        assert_eq!(
            serde_json::to_value(NativeSchemaSessionListRequest::ClickHouseTemporaryViews).unwrap(),
            "clickhouse_temporary_views"
        );
        assert_eq!(
            serde_json::to_value(NativeSchemaSessionDocuments::ClickHouseViews(vec![schema]))
                .unwrap()["kind"],
            "clickhouse_views"
        );
    }
}
