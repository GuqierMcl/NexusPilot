#![allow(dead_code)]

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::engine::native_schema::{
    NativeSchemaChangeBaseline, NativeSchemaChangePlan, NativeSchemaMutationPreview,
    NativeSchemaOperationSummary, NativeSchemaRequiredConfirmation, NativeSchemaRiskFlag,
};
use crate::error::{IpcError, IpcResult};

use super::render::{
    enable_window_experimental, render_create_view, render_drop_view, render_modify_comment,
    render_modify_definer, render_modify_query, render_modify_refresh, render_modify_sql_security,
    render_rename_view,
};
use super::validate::{
    validate_view_alter, validate_view_create, validate_view_drop, validate_view_rename,
};
use super::{
    ClickHouseClusterViewBaseline, ClickHouseMaterializedStorage, ClickHousePlannedStatement,
    ClickHouseRefreshDefinition, ClickHouseRefreshSettings, ClickHouseViewAlterTarget,
    ClickHouseViewChangeTarget, ClickHouseViewCreateTarget, ClickHouseViewDefinitionTarget,
    ClickHouseViewFamily, ClickHouseViewFamilyDefinition, ClickHouseViewRuntimeSupport,
    ClickHouseViewSchema, ClickHouseViewScopeTarget,
};

const CREATE_PLAN_DOMAIN: &str = "nexuspilot.clickhouse.view.plan.create.v1";
const ALTER_PLAN_DOMAIN: &str = "nexuspilot.clickhouse.view.plan.alter.v1";
const RENAME_PLAN_DOMAIN: &str = "nexuspilot.clickhouse.view.plan.rename.v1";
const DROP_PLAN_DOMAIN: &str = "nexuspilot.clickhouse.view.plan.drop.v1";
const TARGET_REVISION_DOMAIN: &str = "nexuspilot.clickhouse.view.target-revision.v1";
const CLUSTER_CHANGE_PLAN_DOMAIN: &str = "nexuspilot.clickhouse.view.plan.cluster-change.v1";

pub fn plan_view_create(
    target: &ClickHouseViewCreateTarget,
    support: &ClickHouseViewRuntimeSupport,
    cluster_baseline: Option<&ClickHouseClusterViewBaseline>,
) -> IpcResult<NativeSchemaMutationPreview> {
    let desired = validate_view_create(target, support, cluster_baseline)?;
    let planned_statements = vec![render_create_view(&desired, false)?];
    let statements = statement_sql(&planned_statements);
    let mut risk_flags = family_risk_flags(desired.family);
    if has_background_work(&desired) {
        risk_flags.push(NativeSchemaRiskFlag::BackgroundWork);
    }
    let cluster_scope = matches!(desired.scope, ClickHouseViewScopeTarget::Cluster { .. });
    if cluster_scope {
        super::require_complete_cluster_support(&support.cluster_ddl)?;
        risk_flags.push(NativeSchemaRiskFlag::ClusterNonAtomic);
    }
    let required_confirmation = create_confirmation(&desired);
    let plan_hash = hash_plan(
        CREATE_PLAN_DOMAIN,
        &CreateHashInput {
            desired: &desired,
            support_revision: &support.support_revision,
            cluster_baseline,
            planned_statements: &planned_statements,
            risk_flags: &risk_flags,
            required_confirmation,
        },
    )?;
    Ok(NativeSchemaMutationPreview {
        statements,
        warnings: {
            let mut warnings = family_warnings(desired.family);
            if cluster_scope {
                warnings.push("ClickHouse ON CLUSTER DDL is non-atomic across nodes".to_string());
            }
            warnings
        },
        destructive: false,
        long_running: false,
        risk_flags,
        required_confirmation,
        plan_hash,
        baseline: cluster_baseline.map(|baseline| {
            NativeSchemaChangeBaseline::ClickHouseClusterView(Box::new(baseline.clone()))
        }),
    })
}

pub fn plan_view_change(
    target: &ClickHouseViewChangeTarget,
    support: &ClickHouseViewRuntimeSupport,
) -> IpcResult<NativeSchemaChangePlan> {
    plan_view_change_with_cluster(target, support, None)
}

pub fn plan_view_change_with_cluster(
    target: &ClickHouseViewChangeTarget,
    support: &ClickHouseViewRuntimeSupport,
    cluster_baseline: Option<&ClickHouseClusterViewBaseline>,
) -> IpcResult<NativeSchemaChangePlan> {
    let is_cluster = matches!(
        target_baseline(target).scope,
        super::ClickHouseViewScope::Cluster { .. }
    );
    if !is_cluster && cluster_baseline.is_some() {
        return Err(IpcError::validation_failed(
            "Local ClickHouse View change must not include a cluster baseline",
        ));
    }
    let mut plan = match target {
        ClickHouseViewChangeTarget::Alter(target) => plan_alter(target, support),
        ClickHouseViewChangeTarget::Rename(target) => {
            validate_view_rename(target, support)?;
            let statements = vec![render_rename_view(
                &target.baseline.identity.address,
                &target.baseline.scope,
                &target.destination,
            )?];
            change_plan(
                RENAME_PLAN_DOMAIN,
                target.as_ref(),
                statements,
                family_warnings(target.baseline.family),
                false,
                false,
                family_risk_flags(target.baseline.family),
                NativeSchemaRequiredConfirmation::None,
                Some(target.expected_destination_absence_revision.clone()),
                "view.rename",
                &target.baseline.identity.address.name,
                &target.baseline,
            )
        }
        ClickHouseViewChangeTarget::Drop(target) => {
            validate_view_drop(target, support)?;
            let statements = vec![render_drop_view(
                &target.baseline.identity.address,
                &target.baseline.scope,
            )?];
            let mut risk_flags = family_risk_flags(target.baseline.family);
            risk_flags.insert(0, NativeSchemaRiskFlag::Destructive);
            change_plan(
                DROP_PLAN_DOMAIN,
                target.as_ref(),
                statements,
                family_warnings(target.baseline.family),
                true,
                false,
                risk_flags,
                NativeSchemaRequiredConfirmation::TypeObjectName,
                Some(target.baseline.baseline.revision_hash.clone()),
                "view.drop",
                &target.baseline.identity.address.name,
                &target.baseline,
            )
        }
    }?;
    if !is_cluster {
        return Ok(plan);
    }

    super::require_complete_cluster_support(&support.cluster_ddl)?;
    let baseline = cluster_baseline.ok_or_else(|| {
        IpcError::resource_conflict("Cluster ClickHouse View change requires a full node baseline")
    })?;
    let cluster_name = match &target_baseline(target).scope {
        super::ClickHouseViewScope::Cluster { cluster_name } => cluster_name,
        _ => unreachable!("cluster scope checked above"),
    };
    if baseline.cluster_name != *cluster_name {
        return Err(IpcError::resource_conflict(
            "ClickHouse cluster View baseline targets a different cluster",
        ));
    }
    super::validate_cluster_baseline_for_desired(
        baseline,
        &super::ClickHouseDesiredClusterState::Present {
            family: target_baseline(target).family,
            revision_hash: target_baseline_revision(target).to_string(),
        },
    )?;
    if !plan
        .risk_flags
        .contains(&NativeSchemaRiskFlag::ClusterNonAtomic)
    {
        plan.risk_flags.push(NativeSchemaRiskFlag::ClusterNonAtomic);
    }
    plan.required_confirmation = NativeSchemaRequiredConfirmation::TypeObjectAndCluster;
    plan.warnings
        .push("ClickHouse ON CLUSTER DDL is non-atomic across nodes".to_string());
    plan.plan_hash = hash_plan(
        CLUSTER_CHANGE_PLAN_DOMAIN,
        &ClusterChangeHashInput {
            base_plan_hash: &plan.plan_hash,
            baseline,
            risk_flags: &plan.risk_flags,
            required_confirmation: plan.required_confirmation,
        },
    )?;
    plan.baseline = NativeSchemaChangeBaseline::ClickHouseClusterView(Box::new(baseline.clone()));
    Ok(plan)
}

fn target_baseline(target: &ClickHouseViewChangeTarget) -> &ClickHouseViewSchema {
    match target {
        ClickHouseViewChangeTarget::Alter(target) => &target.baseline,
        ClickHouseViewChangeTarget::Rename(target) => &target.baseline,
        ClickHouseViewChangeTarget::Drop(target) => &target.baseline,
    }
}

fn target_baseline_revision(target: &ClickHouseViewChangeTarget) -> &str {
    &target_baseline(target).baseline.revision_hash
}

fn plan_alter(
    target: &ClickHouseViewAlterTarget,
    support: &ClickHouseViewRuntimeSupport,
) -> IpcResult<NativeSchemaChangePlan> {
    let desired = validate_view_alter(target, support)?;
    match target.baseline.family {
        ClickHouseViewFamily::Materialized => plan_materialized_alter(target, desired, support),
        ClickHouseViewFamily::RefreshableMaterialized => {
            plan_refreshable_alter(target, desired, support)
        }
        ClickHouseViewFamily::Window => plan_window_alter(target, desired),
        ClickHouseViewFamily::Temporary => plan_temporary_alter(target, desired),
        _ => plan_standard_alter(target, desired),
    }
}

fn plan_temporary_alter(
    target: &ClickHouseViewAlterTarget,
    desired: ClickHouseViewDefinitionTarget,
) -> IpcResult<NativeSchemaChangePlan> {
    if baseline_matches_desired(&target.baseline, &desired) {
        return Err(IpcError::validation_failed(
            "ClickHouse Temporary View Alter has no schema changes",
        ));
    }
    let statements = vec![
        render_drop_view(&target.baseline.identity.address, &target.baseline.scope)?,
        render_create_view(&desired, false)?,
    ];
    change_plan(
        ALTER_PLAN_DOMAIN,
        &AlterHashInput {
            baseline: &target.baseline,
            desired: &desired,
            expected_support_revision: &target.expected_support_revision,
        },
        statements,
        vec!["Temporary View replacement is non-atomic and may be partially applied".to_string()],
        true,
        false,
        vec![NativeSchemaRiskFlag::Destructive],
        NativeSchemaRequiredConfirmation::TypeObjectName,
        Some(target_revision(&desired)?),
        "temporary_view.drop_create",
        &target.baseline.identity.address.name,
        &target.baseline,
    )
}

fn plan_standard_alter(
    target: &ClickHouseViewAlterTarget,
    desired: ClickHouseViewDefinitionTarget,
) -> IpcResult<NativeSchemaChangePlan> {
    let security_only = baseline_matches_desired_except_sql_security(&target.baseline, &desired)
        && target.baseline.security.sql_security != desired.security.sql_security;
    let (statements, destructive, code) = if security_only {
        let sql_security = desired.security.sql_security.ok_or_else(|| {
            IpcError::validation_failed(
                "ClickHouse SQL SECURITY removal requires a full View replacement",
            )
        })?;
        (
            vec![render_modify_sql_security(
                &target.baseline.identity.address,
                &target.baseline.scope,
                sql_security,
            )?],
            false,
            "view.modify_security",
        )
    } else if baseline_matches_desired(&target.baseline, &desired) {
        return Err(IpcError::validation_failed(
            "ClickHouse View Alter has no schema changes",
        ));
    } else {
        (
            vec![render_create_view(&desired, true)?],
            true,
            "view.replace",
        )
    };
    let mut risk_flags = family_risk_flags(target.baseline.family);
    if destructive {
        risk_flags.insert(0, NativeSchemaRiskFlag::Destructive);
    }
    change_plan(
        ALTER_PLAN_DOMAIN,
        &AlterHashInput {
            baseline: &target.baseline,
            desired: &desired,
            expected_support_revision: &target.expected_support_revision,
        },
        statements,
        family_warnings(target.baseline.family),
        destructive,
        false,
        risk_flags,
        if destructive {
            NativeSchemaRequiredConfirmation::Confirm
        } else {
            NativeSchemaRequiredConfirmation::None
        },
        Some(target_revision(&desired)?),
        code,
        &target.baseline.identity.address.name,
        &target.baseline,
    )
}

fn plan_materialized_alter(
    target: &ClickHouseViewAlterTarget,
    desired: ClickHouseViewDefinitionTarget,
    support: &ClickHouseViewRuntimeSupport,
) -> IpcResult<NativeSchemaChangePlan> {
    let immutable_changed = target.baseline.columns != desired.columns
        || target.baseline.family_definition != desired.family_definition;
    let mut statements = Vec::new();
    let mut destructive = false;
    let mut risk_flags = Vec::new();
    let mut required_confirmation = NativeSchemaRequiredConfirmation::None;
    let operation_code;

    if immutable_changed {
        if support
            .database_engine
            .as_deref()
            .is_some_and(|engine| engine.eq_ignore_ascii_case("ordinary"))
        {
            return Err(IpcError::feature_unavailable(
                "ClickHouse Ordinary databases do not support safe Materialized View replacement",
            ));
        }
        statements.push(render_create_view(&desired, true)?);
        destructive = true;
        risk_flags.push(NativeSchemaRiskFlag::Destructive);
        if materialized_inner_storage(&desired) {
            risk_flags.push(NativeSchemaRiskFlag::DataLoss);
            required_confirmation = match &desired.scope {
                ClickHouseViewScopeTarget::Cluster { .. } => {
                    NativeSchemaRequiredConfirmation::TypeObjectAndCluster
                }
                _ => NativeSchemaRequiredConfirmation::TypeObjectName,
            };
        } else {
            required_confirmation = match &desired.scope {
                ClickHouseViewScopeTarget::Cluster { .. } => {
                    NativeSchemaRequiredConfirmation::TypeObjectAndCluster
                }
                _ => NativeSchemaRequiredConfirmation::Confirm,
            };
        }
        if materialized_populate(&desired) {
            risk_flags.push(NativeSchemaRiskFlag::BackgroundWork);
        }
        operation_code = "materialized_view.replace";
    } else {
        if target.baseline.query.trim() != desired.query {
            statements.push(render_modify_query(
                &target.baseline.identity.address,
                &target.baseline.scope,
                &desired.query,
            )?);
            destructive = true;
            risk_flags.push(NativeSchemaRiskFlag::Destructive);
            required_confirmation = NativeSchemaRequiredConfirmation::Confirm;
        }
        if target.baseline.security.definer != desired.security.definer {
            statements.push(render_modify_definer(
                &target.baseline.identity.address,
                &target.baseline.scope,
                desired.security.definer.as_ref(),
            )?);
        }
        if target.baseline.security.sql_security != desired.security.sql_security {
            statements.push(render_modify_sql_security(
                &target.baseline.identity.address,
                &target.baseline.scope,
                desired
                    .security
                    .sql_security
                    .unwrap_or(super::ClickHouseViewSqlSecurity::None),
            )?);
        }
        if target.baseline.comment != desired.comment {
            statements.push(render_modify_comment(
                &target.baseline.identity.address,
                &target.baseline.scope,
                desired.comment.as_deref(),
            )?);
        }
        if statements.is_empty() {
            return Err(IpcError::validation_failed(
                "ClickHouse Materialized View Alter has no schema changes",
            ));
        }
        operation_code = if statements.len() == 1 && target.baseline.query.trim() != desired.query {
            "materialized_view.modify_query"
        } else {
            "materialized_view.modify_metadata"
        };
    }

    change_plan(
        ALTER_PLAN_DOMAIN,
        &AlterHashInput {
            baseline: &target.baseline,
            desired: &desired,
            expected_support_revision: &target.expected_support_revision,
        },
        statements,
        Vec::new(),
        destructive,
        false,
        risk_flags,
        required_confirmation,
        Some(target_revision(&desired)?),
        operation_code,
        &target.baseline.identity.address.name,
        &target.baseline,
    )
}

fn plan_refreshable_alter(
    target: &ClickHouseViewAlterTarget,
    desired: ClickHouseViewDefinitionTarget,
    support: &ClickHouseViewRuntimeSupport,
) -> IpcResult<NativeSchemaChangePlan> {
    let immutable_changed = target.baseline.columns != desired.columns
        || refreshable_immutable_changed(
            &target.baseline.family_definition,
            &desired.family_definition,
        )?;
    let mut statements = Vec::new();
    let mut destructive = false;
    let mut risk_flags = Vec::new();
    let mut required_confirmation = NativeSchemaRequiredConfirmation::None;
    let operation_code;

    if immutable_changed {
        require_replace_database(support)?;
        statements.push(render_create_view(&desired, true)?);
        destructive = true;
        risk_flags.push(NativeSchemaRiskFlag::Destructive);
        risk_flags.push(NativeSchemaRiskFlag::BackgroundWork);
        required_confirmation = if materialized_inner_storage(&desired) {
            risk_flags.push(NativeSchemaRiskFlag::DataLoss);
            replacement_confirmation(&desired, true)
        } else {
            replacement_confirmation(&desired, false)
        };
        operation_code = "refreshable_materialized_view.replace";
    } else {
        if target.baseline.query.trim() != desired.query {
            statements.push(render_modify_query(
                &target.baseline.identity.address,
                &target.baseline.scope,
                &desired.query,
            )?);
            destructive = true;
            risk_flags.push(NativeSchemaRiskFlag::Destructive);
            required_confirmation = NativeSchemaRequiredConfirmation::Confirm;
        }
        if refreshable_mutable_changed(
            &target.baseline.family_definition,
            &desired.family_definition,
        )? {
            statements.push(render_modify_refresh(
                &target.baseline.identity.address,
                &target.baseline.scope,
                refreshable_definition(&desired.family_definition)?.1,
            )?);
            risk_flags.push(NativeSchemaRiskFlag::BackgroundWork);
        }
        append_metadata_alters(&mut statements, &target.baseline, &desired)?;
        if statements.is_empty() {
            return Err(IpcError::validation_failed(
                "ClickHouse Refreshable Materialized View Alter has no schema changes",
            ));
        }
        operation_code = "refreshable_materialized_view.alter";
    }

    change_plan(
        ALTER_PLAN_DOMAIN,
        &AlterHashInput {
            baseline: &target.baseline,
            desired: &desired,
            expected_support_revision: &target.expected_support_revision,
        },
        statements,
        Vec::new(),
        destructive,
        false,
        risk_flags,
        required_confirmation,
        Some(target_revision(&desired)?),
        operation_code,
        &target.baseline.identity.address.name,
        &target.baseline,
    )
}

fn plan_window_alter(
    target: &ClickHouseViewAlterTarget,
    desired: ClickHouseViewDefinitionTarget,
) -> IpcResult<NativeSchemaChangePlan> {
    let definition_changed = target.baseline.family_definition != desired.family_definition
        || target.baseline.columns != desired.columns;
    let query_changed = target.baseline.query.trim() != desired.query;
    let mut statements = Vec::new();
    let mut destructive = false;
    let mut long_running = false;
    let mut risk_flags = vec![NativeSchemaRiskFlag::Experimental];
    let mut required_confirmation = NativeSchemaRequiredConfirmation::None;
    let operation_code;

    if definition_changed {
        statements.push(render_create_view(&desired, true)?);
        destructive = true;
        long_running = true;
        risk_flags.extend([
            NativeSchemaRiskFlag::Destructive,
            NativeSchemaRiskFlag::LongRunning,
        ]);
        if has_background_work(&desired) {
            risk_flags.push(NativeSchemaRiskFlag::BackgroundWork);
        }
        required_confirmation = replacement_confirmation(&desired, true);
        operation_code = "window_view.replace";
    } else {
        if query_changed {
            let mut statement = render_modify_query(
                &target.baseline.identity.address,
                &target.baseline.scope,
                &desired.query,
            )?;
            enable_window_experimental(&mut statement);
            statements.push(statement);
            destructive = true;
            long_running = true;
            risk_flags.extend([
                NativeSchemaRiskFlag::Destructive,
                NativeSchemaRiskFlag::LongRunning,
            ]);
            required_confirmation = match &desired.scope {
                ClickHouseViewScopeTarget::Cluster { .. } => {
                    NativeSchemaRequiredConfirmation::TypeObjectAndCluster
                }
                _ => NativeSchemaRequiredConfirmation::TypeObjectName,
            };
        }
        if target.baseline.comment != desired.comment {
            let mut statement = render_modify_comment(
                &target.baseline.identity.address,
                &target.baseline.scope,
                desired.comment.as_deref(),
            )?;
            enable_window_experimental(&mut statement);
            statements.push(statement);
        }
        if statements.is_empty() {
            return Err(IpcError::validation_failed(
                "ClickHouse Window View Alter has no schema changes",
            ));
        }
        operation_code = if query_changed {
            "window_view.modify_query"
        } else {
            "window_view.modify_comment"
        };
    }

    change_plan(
        ALTER_PLAN_DOMAIN,
        &AlterHashInput {
            baseline: &target.baseline,
            desired: &desired,
            expected_support_revision: &target.expected_support_revision,
        },
        statements,
        family_warnings(ClickHouseViewFamily::Window),
        destructive,
        long_running,
        risk_flags,
        required_confirmation,
        Some(target_revision(&desired)?),
        operation_code,
        &target.baseline.identity.address.name,
        &target.baseline,
    )
}

fn append_metadata_alters(
    statements: &mut Vec<ClickHousePlannedStatement>,
    baseline: &ClickHouseViewSchema,
    desired: &ClickHouseViewDefinitionTarget,
) -> IpcResult<()> {
    if baseline.security.definer != desired.security.definer {
        statements.push(render_modify_definer(
            &baseline.identity.address,
            &baseline.scope,
            desired.security.definer.as_ref(),
        )?);
    }
    if baseline.security.sql_security != desired.security.sql_security {
        statements.push(render_modify_sql_security(
            &baseline.identity.address,
            &baseline.scope,
            desired
                .security
                .sql_security
                .unwrap_or(super::ClickHouseViewSqlSecurity::None),
        )?);
    }
    if baseline.comment != desired.comment {
        statements.push(render_modify_comment(
            &baseline.identity.address,
            &baseline.scope,
            desired.comment.as_deref(),
        )?);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn change_plan<T: Serialize>(
    domain: &str,
    hash_target: &T,
    planned_statements: Vec<ClickHousePlannedStatement>,
    warnings: Vec<String>,
    destructive: bool,
    long_running: bool,
    risk_flags: Vec<NativeSchemaRiskFlag>,
    required_confirmation: NativeSchemaRequiredConfirmation,
    expected_target_revision: Option<String>,
    operation_code: &str,
    object_name: &str,
    baseline: &ClickHouseViewSchema,
) -> IpcResult<NativeSchemaChangePlan> {
    let statements = statement_sql(&planned_statements);
    let operation = NativeSchemaOperationSummary {
        code: operation_code.to_string(),
        object_name: object_name.to_string(),
        destructive,
        long_running,
    };
    let plan_hash = hash_plan(
        domain,
        &ChangeHashInput {
            target: hash_target,
            planned_statements: &planned_statements,
            warnings: &warnings,
            destructive,
            long_running,
            risk_flags: &risk_flags,
            required_confirmation,
            expected_target_revision: &expected_target_revision,
            operation: &operation,
        },
    )?;
    Ok(NativeSchemaChangePlan {
        statements,
        warnings,
        destructive,
        long_running,
        risk_flags,
        required_confirmation,
        plan_hash,
        expected_target_revision,
        operations: vec![operation],
        baseline: NativeSchemaChangeBaseline::ClickHouseView(Box::new(baseline.clone())),
    })
}

fn baseline_matches_desired(
    baseline: &ClickHouseViewSchema,
    desired: &ClickHouseViewDefinitionTarget,
) -> bool {
    baseline.identity.address == desired.address
        && baseline.family == desired.family
        && scope_matches(&baseline.scope, &desired.scope)
        && baseline.columns == desired.columns
        && baseline.query.trim() == desired.query
        && baseline.security == desired.security
        && baseline.comment == desired.comment
        && normalized_family_definition_matches(
            &baseline.family_definition,
            &desired.family_definition,
        )
}

fn baseline_matches_desired_except_sql_security(
    baseline: &ClickHouseViewSchema,
    desired: &ClickHouseViewDefinitionTarget,
) -> bool {
    baseline.identity.address == desired.address
        && baseline.family == desired.family
        && scope_matches(&baseline.scope, &desired.scope)
        && baseline.columns == desired.columns
        && baseline.query.trim() == desired.query
        && baseline.security.definer == desired.security.definer
        && baseline.comment == desired.comment
        && normalized_family_definition_matches(
            &baseline.family_definition,
            &desired.family_definition,
        )
}

fn normalized_family_definition_matches(
    baseline: &super::ClickHouseViewFamilyDefinition,
    desired: &super::ClickHouseViewFamilyDefinition,
) -> bool {
    baseline == desired
}

fn scope_matches(
    baseline: &super::ClickHouseViewScope,
    desired: &super::ClickHouseViewScopeTarget,
) -> bool {
    match (baseline, desired) {
        (super::ClickHouseViewScope::Local, super::ClickHouseViewScopeTarget::Local) => true,
        (
            super::ClickHouseViewScope::Cluster {
                cluster_name: baseline,
            },
            super::ClickHouseViewScopeTarget::Cluster {
                cluster_name: desired,
            },
        ) => baseline == desired,
        (
            super::ClickHouseViewScope::Temporary {
                owner_tab_runtime_id: baseline,
                ..
            },
            super::ClickHouseViewScopeTarget::Temporary {
                owner_tab_runtime_id: desired,
            },
        ) => baseline == desired,
        _ => false,
    }
}

fn family_risk_flags(family: ClickHouseViewFamily) -> Vec<NativeSchemaRiskFlag> {
    match family {
        ClickHouseViewFamily::Live => vec![NativeSchemaRiskFlag::Deprecated],
        ClickHouseViewFamily::Window => vec![NativeSchemaRiskFlag::Experimental],
        _ => Vec::new(),
    }
}

fn family_warnings(family: ClickHouseViewFamily) -> Vec<String> {
    match family {
        ClickHouseViewFamily::Live => {
            vec!["ClickHouse Live View is deprecated by the server".to_string()]
        }
        ClickHouseViewFamily::Window => vec![
            "ClickHouse Window View is experimental and may lose intermediate state".to_string(),
        ],
        _ => Vec::new(),
    }
}

fn materialized_inner_storage(desired: &ClickHouseViewDefinitionTarget) -> bool {
    matches!(
        &desired.family_definition,
        ClickHouseViewFamilyDefinition::Materialized {
            storage: ClickHouseMaterializedStorage::InnerTable { .. },
            ..
        } | ClickHouseViewFamilyDefinition::RefreshableMaterialized {
            storage: ClickHouseMaterializedStorage::InnerTable { .. },
            ..
        }
    )
}

fn materialized_populate(desired: &ClickHouseViewDefinitionTarget) -> bool {
    matches!(
        &desired.family_definition,
        ClickHouseViewFamilyDefinition::Materialized { populate: true, .. }
    )
}

fn has_background_work(desired: &ClickHouseViewDefinitionTarget) -> bool {
    materialized_populate(desired)
        || matches!(
            &desired.family_definition,
            ClickHouseViewFamilyDefinition::RefreshableMaterialized { .. }
                | ClickHouseViewFamilyDefinition::Window { populate: true, .. }
        )
}

fn replacement_confirmation(
    desired: &ClickHouseViewDefinitionTarget,
    type_object_name: bool,
) -> NativeSchemaRequiredConfirmation {
    match &desired.scope {
        ClickHouseViewScopeTarget::Cluster { .. } => {
            NativeSchemaRequiredConfirmation::TypeObjectAndCluster
        }
        _ if type_object_name => NativeSchemaRequiredConfirmation::TypeObjectName,
        _ => NativeSchemaRequiredConfirmation::Confirm,
    }
}

fn require_replace_database(support: &ClickHouseViewRuntimeSupport) -> IpcResult<()> {
    if support
        .database_engine
        .as_deref()
        .is_some_and(|engine| engine.eq_ignore_ascii_case("ordinary"))
    {
        Err(IpcError::feature_unavailable(
            "ClickHouse Ordinary databases do not support safe Materialized View replacement",
        ))
    } else {
        Ok(())
    }
}

fn refreshable_definition(
    definition: &ClickHouseViewFamilyDefinition,
) -> IpcResult<(
    &ClickHouseMaterializedStorage,
    &ClickHouseRefreshDefinition,
    bool,
    bool,
)> {
    match definition {
        ClickHouseViewFamilyDefinition::RefreshableMaterialized {
            storage,
            refresh,
            append,
            empty,
        } => Ok((storage, refresh, *append, *empty)),
        _ => Err(IpcError::validation_failed(
            "ClickHouse Refreshable Materialized View definition is invalid",
        )),
    }
}

fn refreshable_immutable_changed(
    baseline: &ClickHouseViewFamilyDefinition,
    desired: &ClickHouseViewFamilyDefinition,
) -> IpcResult<bool> {
    let (baseline_storage, baseline_refresh, baseline_append, baseline_empty) =
        refreshable_definition(baseline)?;
    let (desired_storage, desired_refresh, desired_append, desired_empty) =
        refreshable_definition(desired)?;
    Ok(baseline_storage != desired_storage
        || baseline_append != desired_append
        || baseline_empty != desired_empty
        || baseline_refresh.settings.all_replicas != desired_refresh.settings.all_replicas)
}

fn refreshable_mutable_changed(
    baseline: &ClickHouseViewFamilyDefinition,
    desired: &ClickHouseViewFamilyDefinition,
) -> IpcResult<bool> {
    let (_, baseline, _, _) = refreshable_definition(baseline)?;
    let (_, desired, _, _) = refreshable_definition(desired)?;
    Ok(baseline.mode != desired.mode
        || baseline.interval != desired.interval
        || baseline.offset != desired.offset
        || baseline.randomize_for != desired.randomize_for
        || baseline.dependencies != desired.dependencies
        || refresh_mutable_settings(&baseline.settings)
            != refresh_mutable_settings(&desired.settings))
}

fn refresh_mutable_settings(
    settings: &ClickHouseRefreshSettings,
) -> (Option<u64>, Option<u64>, Option<u64>) {
    (
        settings.refresh_retries,
        settings.refresh_retry_initial_backoff_ms,
        settings.refresh_retry_max_backoff_ms,
    )
}

fn target_revision(desired: &ClickHouseViewDefinitionTarget) -> IpcResult<String> {
    hash_plan(TARGET_REVISION_DOMAIN, desired)
}

fn create_confirmation(
    desired: &ClickHouseViewDefinitionTarget,
) -> NativeSchemaRequiredConfirmation {
    if matches!(
        desired.scope,
        super::ClickHouseViewScopeTarget::Cluster { .. }
    ) {
        NativeSchemaRequiredConfirmation::TypeObjectAndCluster
    } else if matches!(
        desired.family,
        ClickHouseViewFamily::Window | ClickHouseViewFamily::Live
    ) {
        NativeSchemaRequiredConfirmation::TypeObjectName
    } else {
        NativeSchemaRequiredConfirmation::None
    }
}

fn hash_plan(domain: &str, value: &impl Serialize) -> IpcResult<String> {
    let bytes = serde_json::to_vec(value).map_err(|_| {
        IpcError::system_internal(
            "ClickHouse View plan could not be normalized",
            "operation=view_plan_hash; category=serialization",
        )
    })?;
    let mut digest = Sha256::new();
    digest.update(domain.as_bytes());
    digest.update([0]);
    digest.update(bytes);
    Ok(format!("{:x}", digest.finalize()))
}

fn statement_sql(statements: &[ClickHousePlannedStatement]) -> Vec<String> {
    statements
        .iter()
        .map(|statement| statement.sql.clone())
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateHashInput<'a> {
    desired: &'a ClickHouseViewDefinitionTarget,
    support_revision: &'a str,
    cluster_baseline: Option<&'a ClickHouseClusterViewBaseline>,
    planned_statements: &'a [ClickHousePlannedStatement],
    risk_flags: &'a [NativeSchemaRiskFlag],
    required_confirmation: NativeSchemaRequiredConfirmation,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClusterChangeHashInput<'a> {
    base_plan_hash: &'a str,
    baseline: &'a ClickHouseClusterViewBaseline,
    risk_flags: &'a [NativeSchemaRiskFlag],
    required_confirmation: NativeSchemaRequiredConfirmation,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AlterHashInput<'a> {
    baseline: &'a ClickHouseViewSchema,
    desired: &'a ClickHouseViewDefinitionTarget,
    expected_support_revision: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangeHashInput<'a, T> {
    target: &'a T,
    planned_statements: &'a [ClickHousePlannedStatement],
    warnings: &'a [String],
    destructive: bool,
    long_running: bool,
    risk_flags: &'a [NativeSchemaRiskFlag],
    required_confirmation: NativeSchemaRequiredConfirmation,
    expected_target_revision: &'a Option<String>,
    operation: &'a NativeSchemaOperationSummary,
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::engine::drivers::clickhouse::schema::{
        ClickHouseClusterDdlSupport, ClickHouseClusterObjectState,
        ClickHouseClusterViewNodeBaseline, ClickHouseCreateEngineTarget,
        ClickHouseMaterializedStorage, ClickHouseRefreshDefinition, ClickHouseRefreshMode,
        ClickHouseRefreshSettings, ClickHouseSchemaEditability, ClickHouseSchemaEditabilityMode,
        ClickHouseSupportState, ClickHouseViewAddress, ClickHouseViewAlterTarget,
        ClickHouseViewBaseline, ClickHouseViewChangeTarget, ClickHouseViewColumnDefinition,
        ClickHouseViewCreateTarget, ClickHouseViewDefinitionTarget, ClickHouseViewDropTarget,
        ClickHouseViewFamily, ClickHouseViewFamilyDefinition, ClickHouseViewFamilySupport,
        ClickHouseViewIdentity, ClickHouseViewInterval, ClickHouseViewIntervalUnit,
        ClickHouseViewOperationSupport, ClickHouseViewParameter, ClickHouseViewRenameTarget,
        ClickHouseViewRuntimeSupport, ClickHouseViewSchema, ClickHouseViewScope,
        ClickHouseViewScopeTarget, ClickHouseViewSecurity, ClickHouseViewSqlSecurity,
        ClickHouseViewTypedColumn, ClickHouseWindowWatermark,
    };
    use crate::engine::native_schema::{
        NativeSchemaChangeBaseline, NativeSchemaRequiredConfirmation, NativeSchemaRiskFlag,
    };
    use crate::engine::types::{ContainerKind, ContainerRef};
    use crate::error::ErrorCode;

    #[test]
    fn normal_view_lifecycle_renders_deterministically_without_idempotency_clauses() {
        let support = runtime_support();
        let create_target = ClickHouseViewCreateTarget {
            desired: definition(
                "v_events",
                "SELECT id FROM `analytics`.`events`",
                ClickHouseViewSecurity {
                    definer: None,
                    sql_security: Some(ClickHouseViewSqlSecurity::Invoker),
                },
                Some("events view"),
            ),
            expected_support_revision: support.support_revision.clone(),
        };

        let create = plan_view_create(&create_target, &support, None).unwrap();
        assert_eq!(
            create.statements,
            vec![concat!(
                "CREATE VIEW `analytics`.`v_events`\n",
                "SQL SECURITY INVOKER\n",
                "AS SELECT id FROM `analytics`.`events`\n",
                "COMMENT 'events view'"
            )]
        );
        assert_eq!(
            create,
            plan_view_create(&create_target, &support, None).unwrap()
        );
        assert_lowercase_sha256(&create.plan_hash);

        let baseline = schema(
            definition(
                "v_events",
                "SELECT id FROM `analytics`.`events`",
                ClickHouseViewSecurity {
                    definer: None,
                    sql_security: Some(ClickHouseViewSqlSecurity::Invoker),
                },
                None,
            ),
            &support,
        );
        let mut security_desired = definition(
            "v_events",
            "SELECT id FROM `analytics`.`events`",
            ClickHouseViewSecurity {
                definer: None,
                sql_security: Some(ClickHouseViewSqlSecurity::Definer),
            },
            None,
        );
        let security_plan = plan_view_change(
            &ClickHouseViewChangeTarget::Alter(Box::new(ClickHouseViewAlterTarget {
                baseline: baseline.clone(),
                desired: security_desired.clone(),
                expected_support_revision: support.support_revision.clone(),
            })),
            &support,
        )
        .unwrap();
        assert_eq!(
            security_plan.statements,
            vec!["ALTER TABLE `analytics`.`v_events` MODIFY SQL SECURITY DEFINER"]
        );

        security_desired.security = ClickHouseViewSecurity {
            definer: None,
            sql_security: None,
        };
        security_desired.query = "SELECT id, tenant_id FROM `analytics`.`events`".to_string();
        let replace = plan_view_change(
            &ClickHouseViewChangeTarget::Alter(Box::new(ClickHouseViewAlterTarget {
                baseline: baseline.clone(),
                desired: security_desired,
                expected_support_revision: support.support_revision.clone(),
            })),
            &support,
        )
        .unwrap();
        assert_eq!(
            replace.statements,
            vec![concat!(
                "CREATE OR REPLACE VIEW `analytics`.`v_events`\n",
                "AS SELECT id, tenant_id FROM `analytics`.`events`"
            )]
        );

        let rename = plan_view_change(
            &ClickHouseViewChangeTarget::Rename(Box::new(ClickHouseViewRenameTarget {
                baseline: baseline.clone(),
                destination: address("v_events_v2"),
                expected_destination_absence_revision: "absent-v2".to_string(),
                expected_support_revision: support.support_revision.clone(),
            })),
            &support,
        )
        .unwrap();
        assert_eq!(
            rename.statements,
            vec![concat!(
                "RENAME TABLE `analytics`.`v_events` TO ",
                "`analytics`.`v_events_v2`"
            )]
        );
        assert_eq!(rename.operations.len(), 1);
        assert_eq!(
            rename.expected_target_revision.as_deref(),
            Some("absent-v2")
        );
        assert!(matches!(
            rename.baseline,
            NativeSchemaChangeBaseline::ClickHouseView(_)
        ));

        let mut renamed = baseline;
        renamed.identity.address = address("v_events_v2");
        let drop = plan_view_change(
            &ClickHouseViewChangeTarget::Drop(Box::new(ClickHouseViewDropTarget {
                baseline: renamed,
                expected_support_revision: support.support_revision.clone(),
            })),
            &support,
        )
        .unwrap();
        assert_eq!(
            drop.statements,
            vec!["DROP VIEW `analytics`.`v_events_v2` SYNC"]
        );
        assert!(drop.destructive);
        assert_eq!(
            drop.required_confirmation,
            NativeSchemaRequiredConfirmation::TypeObjectName
        );

        let all_sql = create
            .statements
            .iter()
            .chain(security_plan.statements.iter())
            .chain(replace.statements.iter())
            .chain(rename.statements.iter())
            .chain(drop.statements.iter())
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!all_sql.contains("IF EXISTS"));
        assert!(!all_sql.contains("IF NOT EXISTS"));
    }

    #[test]
    fn cluster_create_binds_full_absence_baseline_and_non_atomic_risk() {
        let mut support = runtime_support();
        support.cluster_ddl = ClickHouseClusterDdlSupport {
            discoverable: true,
            executable: true,
            observable: true,
            drift_verifiable: true,
        };
        let mut desired = definition(
            "v_events",
            "SELECT id FROM `analytics`.`events`",
            ClickHouseViewSecurity {
                definer: None,
                sql_security: None,
            },
            None,
        );
        desired.scope = ClickHouseViewScopeTarget::Cluster {
            cluster_name: "analytics_cluster".to_string(),
        };
        let target = ClickHouseViewCreateTarget {
            desired,
            expected_support_revision: support.support_revision.clone(),
        };
        let baseline = ClickHouseClusterViewBaseline {
            cluster_name: "analytics_cluster".to_string(),
            topology_revision: "topology-v1".to_string(),
            nodes: vec![ClickHouseClusterViewNodeBaseline {
                node_identity_hash: "a".repeat(64),
                shard: 1,
                replica: 1,
                reachable: true,
                object_state: ClickHouseClusterObjectState::Absent,
                family: None,
                revision_hash: None,
            }],
        };

        let plan = plan_view_create(&target, &support, Some(&baseline)).unwrap();

        assert!(plan
            .risk_flags
            .contains(&NativeSchemaRiskFlag::ClusterNonAtomic));
        assert_eq!(
            plan.required_confirmation,
            NativeSchemaRequiredConfirmation::TypeObjectAndCluster
        );
        assert!(plan.statements[0].contains("ON CLUSTER 'analytics_cluster'"));
    }

    #[test]
    fn parameterized_parameters_are_derived_and_live_support_is_fail_closed() {
        let mut support = runtime_support();
        let mut desired = definition(
            "v_by_tenant",
            "SELECT {tenant:UInt64}, {tenant:UInt64} FROM `analytics`.`events`",
            ClickHouseViewSecurity {
                definer: None,
                sql_security: None,
            },
            None,
        );
        desired.family = ClickHouseViewFamily::Parameterized;
        desired.family_definition = ClickHouseViewFamilyDefinition::Parameterized {
            parameters: vec![ClickHouseViewParameter {
                name: "frontend_value_is_ignored".to_string(),
                type_name: "String".to_string(),
                occurrences: 99,
            }],
        };
        let first_target = ClickHouseViewCreateTarget {
            desired: desired.clone(),
            expected_support_revision: support.support_revision.clone(),
        };
        let first = plan_view_create(&first_target, &support, None).unwrap();
        desired.family_definition = ClickHouseViewFamilyDefinition::Parameterized {
            parameters: Vec::new(),
        };
        let second = plan_view_create(
            &ClickHouseViewCreateTarget {
                desired,
                expected_support_revision: support.support_revision.clone(),
            },
            &support,
            None,
        )
        .unwrap();
        assert_eq!(first, second);
        assert!(first.statements[0].contains("{tenant:UInt64}"));

        let mut live = definition(
            "live_events",
            "SELECT id FROM `analytics`.`events`",
            ClickHouseViewSecurity {
                definer: None,
                sql_security: None,
            },
            None,
        );
        live.family = ClickHouseViewFamily::Live;
        live.family_definition = ClickHouseViewFamilyDefinition::Live {
            timeout_seconds: Some(10),
            refresh_seconds: Some(1),
            canonical_legacy_options: Vec::new(),
        };
        let live_target = ClickHouseViewCreateTarget {
            desired: live,
            expected_support_revision: support.support_revision.clone(),
        };
        let live_plan = plan_view_create(&live_target, &support, None).unwrap();
        assert!(live_plan
            .risk_flags
            .contains(&NativeSchemaRiskFlag::Deprecated));
        assert_eq!(
            live_plan.required_confirmation,
            NativeSchemaRequiredConfirmation::TypeObjectName
        );

        support.live.create = operation_support(ClickHouseSupportState::Unsupported);
        let error = plan_view_create(&live_target, &support, None).unwrap_err();
        assert_eq!(error.code, ErrorCode::FeatureUnavailable);
    }

    #[test]
    fn materialized_view_rejects_populate_with_to_and_plans_query_security_comment_alters() {
        let support = runtime_support();
        let invalid = materialized_definition(to_storage("events_sink"), true);
        let error = plan_view_create(
            &ClickHouseViewCreateTarget {
                desired: invalid,
                expected_support_revision: support.support_revision.clone(),
            },
            &support,
            None,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ValidationFailed);

        let baseline = schema(
            materialized_definition(to_storage("events_sink"), false),
            &support,
        );
        let mut query_desired = definition_from_schema(&baseline);
        query_desired.query = "SELECT id + 1 AS id FROM `analytics`.`events`".to_string();
        let query_plan = plan_view_change(
            &ClickHouseViewChangeTarget::Alter(Box::new(ClickHouseViewAlterTarget {
                baseline: baseline.clone(),
                desired: query_desired,
                expected_support_revision: support.support_revision.clone(),
            })),
            &support,
        )
        .unwrap();
        assert_eq!(
            query_plan.statements,
            vec![concat!(
                "ALTER TABLE `analytics`.`events_mv` MODIFY QUERY ",
                "SELECT id + 1 AS id FROM `analytics`.`events`"
            )]
        );

        let mut metadata_desired = definition_from_schema(&baseline);
        metadata_desired.security.sql_security = Some(ClickHouseViewSqlSecurity::Definer);
        metadata_desired.comment = Some("updated materialized view".to_string());
        let metadata_plan = plan_view_change(
            &ClickHouseViewChangeTarget::Alter(Box::new(ClickHouseViewAlterTarget {
                baseline: baseline.clone(),
                desired: metadata_desired,
                expected_support_revision: support.support_revision.clone(),
            })),
            &support,
        )
        .unwrap();
        assert_eq!(
            metadata_plan.statements,
            vec![
                "ALTER TABLE `analytics`.`events_mv` MODIFY SQL SECURITY DEFINER",
                "ALTER TABLE `analytics`.`events_mv` MODIFY COMMENT 'updated materialized view'",
            ]
        );
        assert!(!metadata_plan.destructive);
    }

    #[test]
    fn materialized_view_replace_is_atomic_in_plan_and_classifies_inner_storage_risk() {
        let mut support = runtime_support();
        let baseline = schema(
            materialized_definition(to_storage("events_sink"), false),
            &support,
        );
        let mut desired = definition_from_schema(&baseline);
        desired.family_definition = ClickHouseViewFamilyDefinition::Materialized {
            storage: inner_storage("id"),
            populate: true,
        };
        let target = ClickHouseViewChangeTarget::Alter(Box::new(ClickHouseViewAlterTarget {
            baseline: baseline.clone(),
            desired: desired.clone(),
            expected_support_revision: support.support_revision.clone(),
        }));
        let first = plan_view_change(&target, &support).unwrap();
        let second = plan_view_change(&target, &support).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.statements.len(), 1);
        assert!(first.statements[0]
            .starts_with("CREATE OR REPLACE MATERIALIZED VIEW `analytics`.`events_mv`"));
        assert!(first.statements[0].contains("\nENGINE = MergeTree"));
        assert!(first.statements[0].contains("\nORDER BY id"));
        assert!(first.statements[0].contains("\nPOPULATE"));
        assert!(first.risk_flags.contains(&NativeSchemaRiskFlag::DataLoss));
        assert!(first
            .risk_flags
            .contains(&NativeSchemaRiskFlag::BackgroundWork));
        assert_eq!(
            first.required_confirmation,
            NativeSchemaRequiredConfirmation::TypeObjectName
        );
        assert_lowercase_sha256(first.expected_target_revision.as_deref().unwrap());

        desired.query = "SELECT id + 1 AS id FROM `analytics`.`events`".to_string();
        let changed = plan_view_change(
            &ClickHouseViewChangeTarget::Alter(Box::new(ClickHouseViewAlterTarget {
                baseline: baseline.clone(),
                desired,
                expected_support_revision: support.support_revision.clone(),
            })),
            &support,
        )
        .unwrap();
        assert_ne!(
            first.expected_target_revision,
            changed.expected_target_revision
        );

        let mut cluster_baseline = baseline.clone();
        cluster_baseline.scope = ClickHouseViewScope::Cluster {
            cluster_name: "analytics_cluster".to_string(),
        };
        let mut cluster_desired = definition_from_schema(&cluster_baseline);
        cluster_desired.scope = ClickHouseViewScopeTarget::Cluster {
            cluster_name: "analytics_cluster".to_string(),
        };
        cluster_desired.family_definition = ClickHouseViewFamilyDefinition::Materialized {
            storage: inner_storage("tenant_id"),
            populate: false,
        };
        support.cluster_ddl = ClickHouseClusterDdlSupport {
            discoverable: true,
            executable: true,
            observable: true,
            drift_verifiable: true,
        };
        let cluster_target =
            ClickHouseViewChangeTarget::Alter(Box::new(ClickHouseViewAlterTarget {
                baseline: cluster_baseline,
                desired: cluster_desired,
                expected_support_revision: support.support_revision.clone(),
            }));
        assert_eq!(
            plan_view_change(&cluster_target, &support)
                .unwrap_err()
                .code,
            ErrorCode::ResourceConflict
        );
        let source_baseline = ClickHouseClusterViewBaseline {
            cluster_name: "analytics_cluster".to_string(),
            topology_revision: "topology-v1".to_string(),
            nodes: vec![ClickHouseClusterViewNodeBaseline {
                node_identity_hash: "a".repeat(64),
                shard: 1,
                replica: 1,
                reachable: true,
                object_state: ClickHouseClusterObjectState::Present,
                family: Some(ClickHouseViewFamily::Materialized),
                revision_hash: Some(target_baseline_revision(&cluster_target).to_string()),
            }],
        };
        let cluster =
            plan_view_change_with_cluster(&cluster_target, &support, Some(&source_baseline))
                .unwrap();
        assert_eq!(
            cluster.required_confirmation,
            NativeSchemaRequiredConfirmation::TypeObjectAndCluster
        );
        assert!(matches!(
            cluster.baseline,
            NativeSchemaChangeBaseline::ClickHouseClusterView(_)
        ));

        support.database_engine = Some("Ordinary".to_string());
        let error = plan_view_change(&target, &support).unwrap_err();
        assert_eq!(error.code, ErrorCode::FeatureUnavailable);
    }

    #[test]
    fn refreshable_materialized_view_normalizes_dependencies_and_plans_refresh_or_replace() {
        let support = runtime_support();
        let mut first_target = refreshable_definition();
        let mut reordered = first_target.clone();
        let ClickHouseViewFamilyDefinition::RefreshableMaterialized {
            refresh: reordered_refresh,
            ..
        } = &mut reordered.family_definition
        else {
            unreachable!()
        };
        reordered_refresh.dependencies.reverse();
        let first = plan_view_create(
            &ClickHouseViewCreateTarget {
                desired: first_target.clone(),
                expected_support_revision: support.support_revision.clone(),
            },
            &support,
            None,
        )
        .unwrap();
        let second = plan_view_create(
            &ClickHouseViewCreateTarget {
                desired: reordered,
                expected_support_revision: support.support_revision.clone(),
            },
            &support,
            None,
        )
        .unwrap();
        assert_eq!(first, second);
        assert!(first.statements[0].contains("REFRESH EVERY 1 HOUR"));
        assert!(first.statements[0].contains(concat!(
            "DEPENDS ON `analytics`.`a_refresh`, ",
            "`analytics`.`z_refresh`"
        )));
        assert!(first.statements[0].contains("\nEMPTY"));
        assert!(first
            .risk_flags
            .contains(&NativeSchemaRiskFlag::BackgroundWork));

        let baseline = schema(first_target.clone(), &support);
        let mut refresh_desired = definition_from_schema(&baseline);
        let ClickHouseViewFamilyDefinition::RefreshableMaterialized { refresh, .. } =
            &mut refresh_desired.family_definition
        else {
            unreachable!()
        };
        refresh.interval = Some(interval(2, ClickHouseViewIntervalUnit::Hour));
        refresh.settings.refresh_retries = Some(4);
        let refresh_plan = plan_view_change(
            &ClickHouseViewChangeTarget::Alter(Box::new(ClickHouseViewAlterTarget {
                baseline: baseline.clone(),
                desired: refresh_desired,
                expected_support_revision: support.support_revision.clone(),
            })),
            &support,
        )
        .unwrap();
        assert_eq!(refresh_plan.statements.len(), 1);
        assert!(refresh_plan.statements[0]
            .starts_with("ALTER TABLE `analytics`.`refresh_mv` MODIFY REFRESH EVERY 2 HOUR"));
        assert!(refresh_plan.statements[0].contains("refresh_retries = 4"));

        let mut replace_desired = definition_from_schema(&baseline);
        let ClickHouseViewFamilyDefinition::RefreshableMaterialized {
            append, refresh, ..
        } = &mut replace_desired.family_definition
        else {
            unreachable!()
        };
        *append = true;
        refresh.settings.all_replicas = Some(true);
        let replace = plan_view_change(
            &ClickHouseViewChangeTarget::Alter(Box::new(ClickHouseViewAlterTarget {
                baseline,
                desired: replace_desired,
                expected_support_revision: support.support_revision.clone(),
            })),
            &support,
        )
        .unwrap();
        assert_eq!(replace.statements.len(), 1);
        assert!(replace.statements[0]
            .starts_with("CREATE OR REPLACE MATERIALIZED VIEW `analytics`.`refresh_mv`"));
        assert!(replace.statements[0].contains("\nAPPEND"));
        assert!(replace.statements[0].contains("all_replicas = 1"));

        let ClickHouseViewFamilyDefinition::RefreshableMaterialized { refresh, .. } =
            &mut first_target.family_definition
        else {
            unreachable!()
        };
        refresh.interval = Some(interval(0, ClickHouseViewIntervalUnit::Hour));
        let error = plan_view_create(
            &ClickHouseViewCreateTarget {
                desired: first_target,
                expected_support_revision: support.support_revision.clone(),
            },
            &support,
            None,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ValidationFailed);
    }

    #[test]
    fn refreshable_materialized_view_rejects_cycles_and_invalid_backoff_domains() {
        let support = runtime_support();
        let mut cycle = refreshable_definition();
        let cycle_address = cycle.address.clone();
        let ClickHouseViewFamilyDefinition::RefreshableMaterialized { refresh, .. } =
            &mut cycle.family_definition
        else {
            unreachable!()
        };
        refresh.dependencies.push(cycle_address);
        let error = plan_view_create(
            &ClickHouseViewCreateTarget {
                desired: cycle,
                expected_support_revision: support.support_revision.clone(),
            },
            &support,
            None,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ValidationFailed);

        let mut invalid_backoff = refreshable_definition();
        let ClickHouseViewFamilyDefinition::RefreshableMaterialized { refresh, .. } =
            &mut invalid_backoff.family_definition
        else {
            unreachable!()
        };
        refresh.settings.refresh_retry_initial_backoff_ms = Some(2_000);
        refresh.settings.refresh_retry_max_backoff_ms = Some(1_000);
        let error = plan_view_create(
            &ClickHouseViewCreateTarget {
                desired: invalid_backoff,
                expected_support_revision: support.support_revision.clone(),
            },
            &support,
            None,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ValidationFailed);
    }

    #[test]
    fn window_view_requires_runtime_support_and_uses_request_local_experimental_setting() {
        let mut support = runtime_support();
        let desired = window_definition();
        let target = ClickHouseViewCreateTarget {
            desired: desired.clone(),
            expected_support_revision: support.support_revision.clone(),
        };
        let preview = plan_view_create(&target, &support, None).unwrap();
        assert!(preview.statements[0].starts_with("CREATE WINDOW VIEW `analytics`.`events_window`"));
        assert!(preview.statements[0].contains("WATERMARK=INTERVAL '5' SECOND"));
        assert!(preview.statements[0].contains("ALLOWED_LATENESS=INTERVAL '10' SECOND"));
        assert!(preview
            .risk_flags
            .contains(&NativeSchemaRiskFlag::Experimental));
        assert_eq!(
            preview.required_confirmation,
            NativeSchemaRequiredConfirmation::TypeObjectName
        );
        assert!(!preview.statements[0].contains("allow_experimental_window_view"));
        assert!(!preview.statements[0].contains("SET allow_experimental"));

        let rendered = render_create_view(&desired, false).unwrap();
        assert_eq!(
            rendered.settings.get("allow_experimental_window_view"),
            Some(&"1".to_string())
        );

        let baseline = schema(desired, &support);
        let mut changed = definition_from_schema(&baseline);
        changed.query = concat!(
            "SELECT tumble(ts), count() FROM `analytics`.`events` ",
            "WHERE tenant_id > 0 GROUP BY tumble(ts)"
        )
        .to_string();
        let plan = plan_view_change(
            &ClickHouseViewChangeTarget::Alter(Box::new(ClickHouseViewAlterTarget {
                baseline,
                desired: changed,
                expected_support_revision: support.support_revision.clone(),
            })),
            &support,
        )
        .unwrap();
        assert_eq!(plan.statements.len(), 1);
        assert!(plan.statements[0].contains(" MODIFY QUERY "));
        assert!(plan.destructive);
        assert!(plan.long_running);
        assert!(plan
            .risk_flags
            .contains(&NativeSchemaRiskFlag::Experimental));
        assert!(plan.risk_flags.contains(&NativeSchemaRiskFlag::LongRunning));
        assert_eq!(
            plan.required_confirmation,
            NativeSchemaRequiredConfirmation::TypeObjectName
        );

        support.window.create = operation_support(ClickHouseSupportState::Unsupported);
        let error = plan_view_create(&target, &support, None).unwrap_err();
        assert_eq!(error.code, ErrorCode::FeatureUnavailable);
    }

    #[test]
    fn window_view_validates_destination_window_function_and_typed_intervals() {
        let support = runtime_support();
        let mut invalid = window_definition();
        let ClickHouseViewFamilyDefinition::Window {
            destination,
            result_engine,
            ..
        } = &mut invalid.family_definition
        else {
            unreachable!()
        };
        *destination = None;
        *result_engine = None;
        let error = plan_view_create(
            &ClickHouseViewCreateTarget {
                desired: invalid,
                expected_support_revision: support.support_revision.clone(),
            },
            &support,
            None,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ValidationFailed);

        let mut invalid_query = window_definition();
        invalid_query.query = "SELECT count() FROM `analytics`.`events`".to_string();
        let error = plan_view_create(
            &ClickHouseViewCreateTarget {
                desired: invalid_query,
                expected_support_revision: support.support_revision.clone(),
            },
            &support,
            None,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ValidationFailed);

        let mut invalid_interval = window_definition();
        let ClickHouseViewFamilyDefinition::Window {
            allowed_lateness, ..
        } = &mut invalid_interval.family_definition
        else {
            unreachable!()
        };
        *allowed_lateness = Some(interval(0, ClickHouseViewIntervalUnit::Second));
        let error = plan_view_create(
            &ClickHouseViewCreateTarget {
                desired: invalid_interval,
                expected_support_revision: support.support_revision.clone(),
            },
            &support,
            None,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ValidationFailed);
    }

    #[test]
    fn temporary_view_requires_owner_scope_and_uses_drop_create_for_changes() {
        let support = runtime_support();
        let desired = temporary_definition("tab-runtime-1");
        let create = plan_view_create(
            &ClickHouseViewCreateTarget {
                desired: desired.clone(),
                expected_support_revision: support.support_revision.clone(),
            },
            &support,
            None,
        )
        .unwrap();
        assert_eq!(
            create.statements,
            vec![concat!(
                "CREATE TEMPORARY VIEW `temp_events`\n",
                "AS SELECT id FROM `analytics`.`events`"
            )]
        );

        let mut baseline = schema(desired.clone(), &support);
        baseline.scope = ClickHouseViewScope::Temporary {
            owner_tab_runtime_id: "tab-runtime-1".to_string(),
            session_state: super::super::ClickHouseTemporarySessionState::Active,
        };
        let mut changed = desired;
        changed.query = "SELECT id, tenant_id FROM `analytics`.`events`".to_string();
        let plan = plan_view_change(
            &ClickHouseViewChangeTarget::Alter(Box::new(ClickHouseViewAlterTarget {
                baseline,
                desired: changed,
                expected_support_revision: support.support_revision.clone(),
            })),
            &support,
        )
        .unwrap();
        assert_eq!(
            plan.statements,
            vec![
                "DROP VIEW `temp_events` SYNC",
                concat!(
                    "CREATE TEMPORARY VIEW `temp_events`\n",
                    "AS SELECT id, tenant_id FROM `analytics`.`events`"
                ),
            ]
        );
        assert!(plan.destructive);
        assert_eq!(
            plan.required_confirmation,
            NativeSchemaRequiredConfirmation::TypeObjectName
        );
    }

    #[test]
    fn temporary_view_rejects_database_cluster_and_expired_session_shapes() {
        let support = runtime_support();
        let mut with_database = temporary_definition("tab-runtime-1");
        with_database.address.database = Some("analytics".to_string());
        assert_eq!(
            plan_view_create(
                &ClickHouseViewCreateTarget {
                    desired: with_database,
                    expected_support_revision: support.support_revision.clone(),
                },
                &support,
                None,
            )
            .unwrap_err()
            .code,
            ErrorCode::ValidationFailed
        );

        let mut cluster = temporary_definition("tab-runtime-1");
        cluster.scope = ClickHouseViewScopeTarget::Cluster {
            cluster_name: "cluster".to_string(),
        };
        assert!(plan_view_create(
            &ClickHouseViewCreateTarget {
                desired: cluster,
                expected_support_revision: support.support_revision.clone(),
            },
            &support,
            None,
        )
        .is_err());

        let desired = temporary_definition("tab-runtime-1");
        let mut baseline = schema(desired.clone(), &support);
        baseline.scope = ClickHouseViewScope::Temporary {
            owner_tab_runtime_id: "tab-runtime-1".to_string(),
            session_state: super::super::ClickHouseTemporarySessionState::Expired,
        };
        let error = plan_view_change(
            &ClickHouseViewChangeTarget::Alter(Box::new(ClickHouseViewAlterTarget {
                baseline,
                desired,
                expected_support_revision: support.support_revision.clone(),
            })),
            &support,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceNotFound);
    }

    fn address(name: &str) -> ClickHouseViewAddress {
        ClickHouseViewAddress {
            database: Some("analytics".to_string()),
            name: name.to_string(),
            object_kind: ContainerKind::View,
        }
    }

    fn definition(
        name: &str,
        query: &str,
        security: ClickHouseViewSecurity,
        comment: Option<&str>,
    ) -> ClickHouseViewDefinitionTarget {
        ClickHouseViewDefinitionTarget {
            address: address(name),
            family: ClickHouseViewFamily::Normal,
            scope: ClickHouseViewScopeTarget::Local,
            columns: ClickHouseViewColumnDefinition::None,
            query: query.to_string(),
            security,
            comment: comment.map(str::to_string),
            family_definition: ClickHouseViewFamilyDefinition::Normal,
        }
    }

    fn materialized_definition(
        storage: ClickHouseMaterializedStorage,
        populate: bool,
    ) -> ClickHouseViewDefinitionTarget {
        let mut desired = definition(
            "events_mv",
            "SELECT id FROM `analytics`.`events`",
            ClickHouseViewSecurity {
                definer: None,
                sql_security: None,
            },
            None,
        );
        desired.address.object_kind = ContainerKind::MaterializedView;
        desired.family = ClickHouseViewFamily::Materialized;
        desired.columns = ClickHouseViewColumnDefinition::Typed(vec![ClickHouseViewTypedColumn {
            name: "id".to_string(),
            type_name: "UInt64".to_string(),
        }]);
        desired.family_definition =
            ClickHouseViewFamilyDefinition::Materialized { storage, populate };
        desired
    }

    fn definition_from_schema(schema: &ClickHouseViewSchema) -> ClickHouseViewDefinitionTarget {
        ClickHouseViewDefinitionTarget {
            address: schema.identity.address.clone(),
            family: schema.family,
            scope: match &schema.scope {
                ClickHouseViewScope::Local => ClickHouseViewScopeTarget::Local,
                ClickHouseViewScope::Cluster { cluster_name } => {
                    ClickHouseViewScopeTarget::Cluster {
                        cluster_name: cluster_name.clone(),
                    }
                }
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

    fn to_storage(table: &str) -> ClickHouseMaterializedStorage {
        ClickHouseMaterializedStorage::ToTable {
            target: ContainerRef::table(ContainerKind::Table, "analytics", None, table),
            target_columns: vec!["id".to_string()],
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

    fn refreshable_definition() -> ClickHouseViewDefinitionTarget {
        let mut desired = materialized_definition(to_storage("refresh_sink"), false);
        desired.address.name = "refresh_mv".to_string();
        desired.query = "SELECT count() AS id FROM `analytics`.`events`".to_string();
        desired.family = ClickHouseViewFamily::RefreshableMaterialized;
        desired.family_definition = ClickHouseViewFamilyDefinition::RefreshableMaterialized {
            storage: to_storage("refresh_sink"),
            refresh: ClickHouseRefreshDefinition {
                mode: ClickHouseRefreshMode::Every,
                interval: Some(interval(1, ClickHouseViewIntervalUnit::Hour)),
                offset: None,
                randomize_for: Some(interval(5, ClickHouseViewIntervalUnit::Minute)),
                dependencies: vec![
                    address_with_kind("z_refresh", ContainerKind::MaterializedView),
                    address_with_kind("a_refresh", ContainerKind::MaterializedView),
                ],
                settings: ClickHouseRefreshSettings {
                    refresh_retries: Some(3),
                    refresh_retry_initial_backoff_ms: Some(100),
                    refresh_retry_max_backoff_ms: Some(1_000),
                    all_replicas: Some(false),
                },
            },
            append: false,
            empty: true,
        };
        desired
    }

    fn window_definition() -> ClickHouseViewDefinitionTarget {
        let mut desired = definition(
            "events_window",
            concat!(
                "SELECT tumble(ts), count() FROM `analytics`.`events` ",
                "GROUP BY tumble(ts)"
            ),
            ClickHouseViewSecurity {
                definer: None,
                sql_security: None,
            },
            Some("windowed events"),
        );
        desired.family = ClickHouseViewFamily::Window;
        desired.family_definition = ClickHouseViewFamilyDefinition::Window {
            destination: Some(ContainerRef::table(
                ContainerKind::Table,
                "analytics",
                None,
                "events_window_sink",
            )),
            inner_engine: None,
            result_engine: None,
            watermark: ClickHouseWindowWatermark::Bounded(interval(
                5,
                ClickHouseViewIntervalUnit::Second,
            )),
            allowed_lateness: Some(interval(10, ClickHouseViewIntervalUnit::Second)),
            populate: false,
            time_window_function: "tumble".to_string(),
        };
        desired
    }

    fn temporary_definition(owner_tab_runtime_id: &str) -> ClickHouseViewDefinitionTarget {
        let mut desired = definition(
            "temp_events",
            "SELECT id FROM `analytics`.`events`",
            ClickHouseViewSecurity {
                definer: None,
                sql_security: None,
            },
            None,
        );
        desired.address.database = None;
        desired.family = ClickHouseViewFamily::Temporary;
        desired.scope = ClickHouseViewScopeTarget::Temporary {
            owner_tab_runtime_id: owner_tab_runtime_id.to_string(),
        };
        desired.columns = ClickHouseViewColumnDefinition::None;
        desired.family_definition = ClickHouseViewFamilyDefinition::Temporary;
        desired
    }

    fn address_with_kind(name: &str, object_kind: ContainerKind) -> ClickHouseViewAddress {
        ClickHouseViewAddress {
            database: Some("analytics".to_string()),
            name: name.to_string(),
            object_kind,
        }
    }

    fn interval(value: u64, unit: ClickHouseViewIntervalUnit) -> ClickHouseViewInterval {
        ClickHouseViewInterval { value, unit }
    }

    fn schema(
        desired: ClickHouseViewDefinitionTarget,
        support: &ClickHouseViewRuntimeSupport,
    ) -> ClickHouseViewSchema {
        ClickHouseViewSchema {
            identity: ClickHouseViewIdentity {
                address: desired.address.clone(),
                uuid: Some("uuid-v-events".to_string()),
            },
            family: desired.family,
            scope: ClickHouseViewScope::Local,
            columns: desired.columns.clone(),
            query: desired.query,
            security: desired.security,
            comment: desired.comment,
            family_definition: desired.family_definition,
            server_support: support.clone(),
            editability: ClickHouseSchemaEditability {
                mode: ClickHouseSchemaEditabilityMode::Editable,
                blockers: Vec::new(),
            },
            baseline: ClickHouseViewBaseline {
                canonical_create_query:
                    "CREATE VIEW analytics.v_events AS SELECT id FROM analytics.events".to_string(),
                revision_hash: "source-revision".to_string(),
                server_version: support.server_version.clone(),
                family: desired.family,
                support_revision: support.support_revision.clone(),
            },
        }
    }

    fn operation_support(state: ClickHouseSupportState) -> ClickHouseViewOperationSupport {
        ClickHouseViewOperationSupport {
            state,
            reason: (state != ClickHouseSupportState::Supported)
                .then(|| "feature_absent".to_string()),
        }
    }

    fn family_support() -> ClickHouseViewFamilySupport {
        let supported = operation_support(ClickHouseSupportState::Supported);
        ClickHouseViewFamilySupport {
            describe: supported.clone(),
            create: supported.clone(),
            alter: supported.clone(),
            rename: supported.clone(),
            drop: supported,
        }
    }

    fn runtime_support() -> ClickHouseViewRuntimeSupport {
        let supported = family_support();
        ClickHouseViewRuntimeSupport {
            server_version: "25.3.1".to_string(),
            database_engine: Some("Atomic".to_string()),
            normal: supported.clone(),
            parameterized: supported.clone(),
            temporary: supported.clone(),
            materialized: supported.clone(),
            refreshable_materialized: supported.clone(),
            window: supported.clone(),
            live: supported,
            cluster_ddl: ClickHouseClusterDdlSupport {
                discoverable: false,
                executable: false,
                observable: false,
                drift_verifiable: false,
            },
            support_revision: "support-revision".to_string(),
        }
    }

    fn assert_lowercase_sha256(value: &str) {
        assert_eq!(value.len(), 64);
        assert!(value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')));
    }
}
