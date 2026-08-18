#![allow(dead_code)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::engine::native_schema::{
    NativeSchemaBackgroundWork, NativeSchemaExecutionStatus, NativeSchemaStatementProgress,
};
use crate::engine::types::{ContainerKind, ContainerRef, SchemaMutationOperation};
use crate::error::ErrorCode;

use super::super::create_types::{ClickHouseCreateEngineTarget, ClickHouseCreateSettingTarget};
use super::super::types::ClickHouseSchemaEditability;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClickHousePlannedStatement {
    pub sql: String,
    pub settings: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClickHouseViewFamily {
    Normal,
    Parameterized,
    Temporary,
    Materialized,
    RefreshableMaterialized,
    Window,
    Live,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ClickHouseSupportState {
    Supported,
    Unsupported,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ClickHouseViewScope {
    Local,
    Cluster {
        cluster_name: String,
    },
    Temporary {
        owner_tab_runtime_id: String,
        session_state: ClickHouseTemporarySessionState,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ClickHouseTemporarySessionState {
    Active,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ClickHouseViewScopeTarget {
    Local,
    Cluster { cluster_name: String },
    Temporary { owner_tab_runtime_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseViewAddress {
    pub database: Option<String>,
    pub name: String,
    pub object_kind: ContainerKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseViewIdentity {
    pub address: ClickHouseViewAddress,
    pub uuid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ClickHouseViewColumnDefinition {
    None,
    Aliases(Vec<String>),
    Typed(Vec<ClickHouseViewTypedColumn>),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClickHouseViewTypedColumn {
    pub name: String,
    pub type_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseViewSecurity {
    pub definer: Option<ClickHouseViewDefiner>,
    pub sql_security: Option<ClickHouseViewSqlSecurity>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ClickHouseViewDefiner {
    CurrentUser,
    NamedUser(String),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ClickHouseViewSqlSecurity {
    Definer,
    Invoker,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseViewParameter {
    pub name: String,
    pub type_name: String,
    pub occurrences: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseViewInterval {
    pub value: u64,
    pub unit: ClickHouseViewIntervalUnit,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ClickHouseViewIntervalUnit {
    Second,
    Minute,
    Hour,
    Day,
    Week,
    Month,
    Year,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ClickHouseMaterializedStorage {
    ToTable {
        target: ContainerRef,
        target_columns: Vec<String>,
    },
    InnerTable {
        engine: ClickHouseCreateEngineTarget,
        order_by: String,
        partition_by: Option<String>,
        settings: Vec<ClickHouseCreateSettingTarget>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ClickHouseRefreshMode {
    Every,
    After,
    DependsOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseRefreshSettings {
    pub refresh_retries: Option<u64>,
    pub refresh_retry_initial_backoff_ms: Option<u64>,
    pub refresh_retry_max_backoff_ms: Option<u64>,
    pub all_replicas: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseRefreshDefinition {
    pub mode: ClickHouseRefreshMode,
    pub interval: Option<ClickHouseViewInterval>,
    pub offset: Option<ClickHouseViewInterval>,
    pub randomize_for: Option<ClickHouseViewInterval>,
    pub dependencies: Vec<ClickHouseViewAddress>,
    pub settings: ClickHouseRefreshSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ClickHouseWindowWatermark {
    None,
    StrictlyAscending,
    Ascending,
    Bounded(ClickHouseViewInterval),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ClickHouseViewFamilyDefinition {
    Normal,
    Parameterized {
        parameters: Vec<ClickHouseViewParameter>,
    },
    Temporary,
    Materialized {
        storage: ClickHouseMaterializedStorage,
        populate: bool,
    },
    RefreshableMaterialized {
        storage: ClickHouseMaterializedStorage,
        refresh: ClickHouseRefreshDefinition,
        append: bool,
        empty: bool,
    },
    Window {
        destination: Option<ContainerRef>,
        inner_engine: Option<String>,
        result_engine: Option<String>,
        watermark: ClickHouseWindowWatermark,
        allowed_lateness: Option<ClickHouseViewInterval>,
        populate: bool,
        time_window_function: String,
    },
    Live {
        timeout_seconds: Option<u64>,
        refresh_seconds: Option<u64>,
        canonical_legacy_options: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseViewSchema {
    pub identity: ClickHouseViewIdentity,
    pub family: ClickHouseViewFamily,
    pub scope: ClickHouseViewScope,
    pub columns: ClickHouseViewColumnDefinition,
    pub query: String,
    pub security: ClickHouseViewSecurity,
    pub comment: Option<String>,
    pub family_definition: ClickHouseViewFamilyDefinition,
    pub server_support: ClickHouseViewRuntimeSupport,
    pub editability: ClickHouseSchemaEditability,
    pub baseline: ClickHouseViewBaseline,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseViewDefinitionTarget {
    pub address: ClickHouseViewAddress,
    pub family: ClickHouseViewFamily,
    pub scope: ClickHouseViewScopeTarget,
    pub columns: ClickHouseViewColumnDefinition,
    pub query: String,
    pub security: ClickHouseViewSecurity,
    pub comment: Option<String>,
    pub family_definition: ClickHouseViewFamilyDefinition,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseViewBaseline {
    pub canonical_create_query: String,
    pub revision_hash: String,
    pub server_version: String,
    pub family: ClickHouseViewFamily,
    pub support_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseViewOperationSupport {
    pub state: ClickHouseSupportState,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseViewFamilySupport {
    pub describe: ClickHouseViewOperationSupport,
    pub create: ClickHouseViewOperationSupport,
    pub alter: ClickHouseViewOperationSupport,
    pub rename: ClickHouseViewOperationSupport,
    pub drop: ClickHouseViewOperationSupport,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseViewRuntimeSupport {
    pub server_version: String,
    pub database_engine: Option<String>,
    pub normal: ClickHouseViewFamilySupport,
    pub parameterized: ClickHouseViewFamilySupport,
    pub temporary: ClickHouseViewFamilySupport,
    pub materialized: ClickHouseViewFamilySupport,
    pub refreshable_materialized: ClickHouseViewFamilySupport,
    pub window: ClickHouseViewFamilySupport,
    pub live: ClickHouseViewFamilySupport,
    pub cluster_ddl: ClickHouseClusterDdlSupport,
    pub support_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseClusterDdlSupport {
    pub discoverable: bool,
    pub executable: bool,
    pub observable: bool,
    pub drift_verifiable: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ClickHouseClusterObjectState {
    Absent,
    Present,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseClusterViewBaseline {
    pub cluster_name: String,
    pub topology_revision: String,
    pub nodes: Vec<ClickHouseClusterViewNodeBaseline>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseClusterViewNodeBaseline {
    pub node_identity_hash: String,
    pub shard: u32,
    pub replica: u32,
    pub reachable: bool,
    pub object_state: ClickHouseClusterObjectState,
    pub family: Option<ClickHouseViewFamily>,
    pub revision_hash: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ClickHouseClusterNodeExecutionState {
    Pending,
    Applied,
    Failed,
    Unreachable,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseClusterExecutionOutcome {
    pub cluster_name: String,
    pub expected_nodes: u32,
    pub observed_nodes: u32,
    pub nodes: Vec<ClickHouseClusterExecutionNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseClusterExecutionNode {
    pub node_identity_hash: String,
    pub shard: u32,
    pub replica: u32,
    pub state: ClickHouseClusterNodeExecutionState,
    pub error_code: Option<ErrorCode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseViewCreateTarget {
    pub desired: ClickHouseViewDefinitionTarget,
    pub expected_support_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseViewAlterTarget {
    pub baseline: ClickHouseViewSchema,
    pub desired: ClickHouseViewDefinitionTarget,
    pub expected_support_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseViewRenameTarget {
    pub baseline: ClickHouseViewSchema,
    pub destination: ClickHouseViewAddress,
    pub expected_destination_absence_revision: String,
    pub expected_support_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseViewDropTarget {
    pub baseline: ClickHouseViewSchema,
    pub expected_support_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "target", rename_all = "snake_case")]
pub enum ClickHouseViewChangeTarget {
    Alter(Box<ClickHouseViewAlterTarget>),
    Rename(Box<ClickHouseViewRenameTarget>),
    Drop(Box<ClickHouseViewDropTarget>),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseViewCreateResult {
    pub status: NativeSchemaExecutionStatus,
    pub progress: NativeSchemaStatementProgress,
    pub container: ContainerRef,
    pub schema: Option<ClickHouseViewSchema>,
    pub background_work: Option<NativeSchemaBackgroundWork>,
    pub cluster_outcome: Option<ClickHouseClusterExecutionOutcome>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseViewChangeResult {
    pub status: NativeSchemaExecutionStatus,
    pub progress: NativeSchemaStatementProgress,
    pub operation: SchemaMutationOperation,
    pub source: ContainerRef,
    pub destination: Option<ContainerRef>,
    pub schema: Option<ClickHouseViewSchema>,
    pub background_work: Option<NativeSchemaBackgroundWork>,
    pub cluster_outcome: Option<ClickHouseClusterExecutionOutcome>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_families_and_nested_domain_values_have_stable_tags() {
        let families = [
            (ClickHouseViewFamily::Normal, "normal"),
            (ClickHouseViewFamily::Parameterized, "parameterized"),
            (ClickHouseViewFamily::Temporary, "temporary"),
            (ClickHouseViewFamily::Materialized, "materialized"),
            (
                ClickHouseViewFamily::RefreshableMaterialized,
                "refreshable_materialized",
            ),
            (ClickHouseViewFamily::Window, "window"),
            (ClickHouseViewFamily::Live, "live"),
        ];

        for (family, tag) in families {
            assert_eq!(serde_json::to_value(family).unwrap(), tag);
        }

        assert_eq!(
            serde_json::to_value(ClickHouseViewScopeTarget::Temporary {
                owner_tab_runtime_id: "tab-runtime-1".to_string(),
            })
            .unwrap(),
            serde_json::json!({
                "kind": "temporary",
                "value": { "ownerTabRuntimeId": "tab-runtime-1" }
            })
        );
        assert_eq!(
            serde_json::to_value(ClickHouseViewFamilyDefinition::Parameterized {
                parameters: vec![ClickHouseViewParameter {
                    name: "tenant".to_string(),
                    type_name: "UInt64".to_string(),
                    occurrences: 2,
                }],
            })
            .unwrap(),
            serde_json::json!({
                "kind": "parameterized",
                "value": {
                    "parameters": [{
                        "name": "tenant",
                        "typeName": "UInt64",
                        "occurrences": 2
                    }]
                }
            })
        );
    }

    #[test]
    fn temporary_scope_never_serializes_a_physical_session_id() {
        let value = serde_json::to_value(ClickHouseViewScope::Temporary {
            owner_tab_runtime_id: "tab-runtime-1".to_string(),
            session_state: ClickHouseTemporarySessionState::Active,
        })
        .unwrap();
        let serialized = value.to_string();

        assert!(serialized.contains("ownerTabRuntimeId"));
        assert!(!serialized.contains("sessionId"));
        assert!(!serialized.contains("session_id"));
    }

    #[test]
    fn materialized_view_storage_and_typed_columns_reject_ambiguous_payloads() {
        let both_storage_shapes = serde_json::json!({
            "kind": "to_table",
            "value": {
                "target": {
                    "kind": "table",
                    "groupType": null,
                    "database": "analytics",
                    "schema": null,
                    "table": "sink",
                    "column": null,
                    "objectName": null,
                    "dbIndex": null,
                    "key": null,
                    "pattern": null
                },
                "targetColumns": [],
                "engine": { "family": "MergeTree", "arguments": [] },
                "orderBy": "tuple()",
                "partitionBy": null,
                "settings": []
            }
        });
        assert!(
            serde_json::from_value::<ClickHouseMaterializedStorage>(both_storage_shapes).is_err()
        );
        assert!(
            serde_json::from_value::<ClickHouseMaterializedStorage>(serde_json::json!({
                "value": {}
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<ClickHouseViewTypedColumn>(serde_json::json!({
                "name": "id",
                "typeName": "UInt64",
                "defaultKind": "default",
                "codec": "ZSTD(1)",
                "ttl": "now()"
            }))
            .is_err()
        );
    }

    #[test]
    fn refreshable_materialized_result_keeps_schema_and_background_state_separate() {
        use crate::engine::native_schema::{
            NativeSchemaBackgroundWorkKind, NativeSchemaBackgroundWorkState,
        };

        let result = ClickHouseViewCreateResult {
            status: NativeSchemaExecutionStatus::Applied,
            progress: NativeSchemaStatementProgress {
                applied_count: 1,
                failed_statement_index: None,
                remaining_count: 0,
                query_ids: vec!["query-1".to_string()],
            },
            container: ContainerRef::table(
                ContainerKind::MaterializedView,
                "analytics",
                None,
                "refresh_mv",
            ),
            schema: None,
            background_work: Some(NativeSchemaBackgroundWork {
                kind: NativeSchemaBackgroundWorkKind::InitialRefresh,
                state: NativeSchemaBackgroundWorkState::Running,
            }),
            cluster_outcome: None,
        };

        assert_eq!(result.status, NativeSchemaExecutionStatus::Applied);
        assert!(matches!(
            result.background_work,
            Some(NativeSchemaBackgroundWork {
                kind: NativeSchemaBackgroundWorkKind::InitialRefresh,
                state: NativeSchemaBackgroundWorkState::Running,
            })
        ));
        assert!(
            serde_json::from_value::<ClickHouseViewInterval>(serde_json::json!({
                "value": 1,
                "unit": "fortnight"
            }))
            .is_err()
        );
    }
}
