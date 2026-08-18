#![allow(dead_code)]

use std::collections::HashSet;

use crate::engine::drivers::clickhouse::query::types::{parse_type, ClickHouseType};
use crate::engine::drivers::clickhouse::schema::create_validate::validate_identifier;
use crate::engine::drivers::clickhouse::schema::sql_scan::validate_single_expression;
use crate::engine::drivers::clickhouse::schema::types::ClickHouseSchemaEditabilityMode;
use crate::engine::types::ContainerKind;
use crate::error::{IpcError, IpcResult};

use super::super::create_types::{ClickHouseCreateEngineTarget, ClickHouseCreateSettingTarget};
use super::{
    require_view_operation_support, scan_view_query, ClickHouseClusterObjectState,
    ClickHouseClusterViewBaseline, ClickHouseMaterializedStorage, ClickHouseRefreshDefinition,
    ClickHouseRefreshMode, ClickHouseRefreshSettings, ClickHouseViewAddress,
    ClickHouseViewAlterTarget, ClickHouseViewColumnDefinition, ClickHouseViewCreateTarget,
    ClickHouseViewDefiner, ClickHouseViewDefinitionTarget, ClickHouseViewDropTarget,
    ClickHouseViewFamily, ClickHouseViewFamilyDefinition, ClickHouseViewFamilySupport,
    ClickHouseViewInterval, ClickHouseViewRenameTarget, ClickHouseViewRuntimeSupport,
    ClickHouseViewSchema, ClickHouseViewScope, ClickHouseViewScopeTarget,
    ClickHouseViewTypedColumn, ClickHouseWindowWatermark,
};

pub(super) fn validate_view_create(
    target: &ClickHouseViewCreateTarget,
    support: &ClickHouseViewRuntimeSupport,
    cluster_baseline: Option<&ClickHouseClusterViewBaseline>,
) -> IpcResult<ClickHouseViewDefinitionTarget> {
    validate_support_revision(&target.expected_support_revision, support)?;
    let family_support = family_support(support, target.desired.family)?;
    require_view_operation_support(&family_support.create)?;
    validate_create_scope(&target.desired, support, cluster_baseline)?;
    validate_and_normalize_definition(&target.desired)
}

pub(super) fn validate_view_alter(
    target: &ClickHouseViewAlterTarget,
    support: &ClickHouseViewRuntimeSupport,
) -> IpcResult<ClickHouseViewDefinitionTarget> {
    validate_support_revision(&target.expected_support_revision, support)?;
    validate_baseline(&target.baseline, support)?;
    require_view_operation_support(&family_support(support, target.baseline.family)?.alter)?;
    validate_persistent_change_scope(&target.baseline.scope, support)?;
    if target.baseline.identity.address != target.desired.address
        || target.baseline.family != target.desired.family
        || !scope_matches(&target.baseline.scope, &target.desired.scope)
    {
        return Err(validation(
            "ClickHouse View Alter must preserve address, family, and scope",
        ));
    }
    validate_and_normalize_definition(&target.desired)
}

pub(super) fn validate_view_rename(
    target: &ClickHouseViewRenameTarget,
    support: &ClickHouseViewRuntimeSupport,
) -> IpcResult<()> {
    validate_support_revision(&target.expected_support_revision, support)?;
    validate_baseline(&target.baseline, support)?;
    require_view_operation_support(&family_support(support, target.baseline.family)?.rename)?;
    validate_persistent_change_scope(&target.baseline.scope, support)?;
    validate_persistent_address(&target.destination, target.baseline.family)?;
    if target.destination == target.baseline.identity.address {
        return Err(validation(
            "ClickHouse View Rename destination must differ from the source",
        ));
    }
    if target
        .expected_destination_absence_revision
        .trim()
        .is_empty()
    {
        return Err(validation(
            "ClickHouse View Rename requires a destination absence baseline",
        ));
    }
    Ok(())
}

pub(super) fn validate_view_drop(
    target: &ClickHouseViewDropTarget,
    support: &ClickHouseViewRuntimeSupport,
) -> IpcResult<()> {
    validate_support_revision(&target.expected_support_revision, support)?;
    validate_baseline(&target.baseline, support)?;
    require_view_operation_support(&family_support(support, target.baseline.family)?.drop)?;
    validate_persistent_change_scope(&target.baseline.scope, support)
}

fn validate_and_normalize_definition(
    desired: &ClickHouseViewDefinitionTarget,
) -> IpcResult<ClickHouseViewDefinitionTarget> {
    if desired.family == ClickHouseViewFamily::Temporary {
        validate_temporary_address(&desired.address)?;
    } else {
        validate_persistent_address(&desired.address, desired.family)?;
    }
    validate_columns(&desired.columns, desired.family)?;
    validate_security(&desired.security.definer)?;
    validate_comment(desired.comment.as_deref())?;
    let facts = scan_view_query(&desired.query)?;

    let mut normalized = desired.clone();
    normalized.query = normalized
        .query
        .trim()
        .strip_suffix(';')
        .unwrap_or(normalized.query.trim())
        .trim_end()
        .to_string();
    match (&desired.family, &desired.family_definition) {
        (ClickHouseViewFamily::Normal, ClickHouseViewFamilyDefinition::Normal) => {
            if !facts.parameters.is_empty() {
                return Err(validation(
                    "ClickHouse parameter placeholders require the Parameterized View family",
                ));
            }
        }
        (
            ClickHouseViewFamily::Parameterized,
            ClickHouseViewFamilyDefinition::Parameterized { .. },
        ) => {
            if facts.parameters.is_empty() {
                return Err(validation(
                    "ClickHouse Parameterized View requires at least one query parameter",
                ));
            }
            normalized.family_definition = ClickHouseViewFamilyDefinition::Parameterized {
                parameters: facts.parameters,
            };
        }
        (
            ClickHouseViewFamily::Live,
            ClickHouseViewFamilyDefinition::Live {
                timeout_seconds,
                refresh_seconds,
                canonical_legacy_options,
            },
        ) => {
            if !facts.parameters.is_empty() {
                return Err(validation(
                    "ClickHouse Live View does not accept parameter placeholders",
                ));
            }
            if timeout_seconds.is_some_and(|value| value == 0)
                || refresh_seconds.is_some_and(|value| value == 0)
            {
                return Err(validation(
                    "ClickHouse Live View timeout and refresh values must be positive",
                ));
            }
            if !canonical_legacy_options.is_empty() {
                return Err(IpcError::feature_unavailable(
                    "ClickHouse Live View contains legacy clauses that are read-only",
                ));
            }
        }
        (
            ClickHouseViewFamily::Materialized,
            ClickHouseViewFamilyDefinition::Materialized { storage, populate },
        ) => {
            if !facts.parameters.is_empty() {
                return Err(validation(
                    "ClickHouse Materialized View does not accept parameter placeholders",
                ));
            }
            validate_materialized_storage(storage, *populate)?;
        }
        (
            ClickHouseViewFamily::RefreshableMaterialized,
            ClickHouseViewFamilyDefinition::RefreshableMaterialized {
                storage, refresh, ..
            },
        ) => {
            if !facts.parameters.is_empty() {
                return Err(validation(
                    "ClickHouse Refreshable Materialized View does not accept parameters",
                ));
            }
            validate_materialized_storage(storage, false)?;
            let mut normalized_refresh = refresh.clone();
            validate_and_sort_refresh(&desired.address, &mut normalized_refresh)?;
            let ClickHouseViewFamilyDefinition::RefreshableMaterialized {
                refresh: target_refresh,
                ..
            } = &mut normalized.family_definition
            else {
                unreachable!("family definition matched above")
            };
            *target_refresh = normalized_refresh;
        }
        (
            ClickHouseViewFamily::Window,
            ClickHouseViewFamilyDefinition::Window {
                destination,
                inner_engine,
                result_engine,
                watermark,
                allowed_lateness,
                time_window_function,
                ..
            },
        ) => {
            if !facts.parameters.is_empty() {
                return Err(validation(
                    "ClickHouse Window View does not accept parameter placeholders",
                ));
            }
            validate_window_destination(destination.as_ref(), desired.address.database.as_deref())?;
            if destination.is_none() && result_engine.as_deref().is_none_or(str::is_empty) {
                return Err(validation(
                    "ClickHouse Window View without TO requires a result engine",
                ));
            }
            for engine in [inner_engine.as_deref(), result_engine.as_deref()]
                .into_iter()
                .flatten()
            {
                validate_single_expression(engine, "view.window.engine")?;
            }
            validate_watermark(watermark, allowed_lateness.as_ref())?;
            validate_identifier(time_window_function, "view.window.timeWindowFunction")?;
            let normalized_function = time_window_function.to_ascii_lowercase();
            if !matches!(
                normalized_function.as_str(),
                "tumble" | "hop" | "tumblingwindow" | "hoppingwindow"
            ) || !facts.has_top_level_group_by
                || !facts
                    .top_level_function_calls
                    .contains(&normalized_function)
            {
                return Err(validation(
                    "ClickHouse Window View query requires a supported top-level time-window GROUP BY",
                ));
            }
            if desired.security.definer.is_some() || desired.security.sql_security.is_some() {
                return Err(validation(
                    "ClickHouse Window View does not support SQL security clauses",
                ));
            }
        }
        (ClickHouseViewFamily::Temporary, ClickHouseViewFamilyDefinition::Temporary) => {
            if !facts.parameters.is_empty()
                || !matches!(desired.columns, ClickHouseViewColumnDefinition::None)
                || desired.security.definer.is_some()
                || desired.security.sql_security.is_some()
                || desired.comment.is_some()
            {
                return Err(validation(
                    "ClickHouse Temporary View accepts only an owner scope and query",
                ));
            }
        }
        _ => {
            return Err(validation(
                "ClickHouse View family and family definition do not match",
            ));
        }
    }
    Ok(normalized)
}

fn validate_persistent_address(
    address: &ClickHouseViewAddress,
    family: ClickHouseViewFamily,
) -> IpcResult<()> {
    let database = address
        .database
        .as_deref()
        .ok_or_else(|| validation("Persistent ClickHouse View address requires a database"))?;
    validate_identifier(database, "view.address.database")?;
    validate_identifier(&address.name, "view.address.name")?;
    let expected_kind = match family {
        ClickHouseViewFamily::Normal
        | ClickHouseViewFamily::Parameterized
        | ClickHouseViewFamily::Temporary
        | ClickHouseViewFamily::Window
        | ClickHouseViewFamily::Live => ContainerKind::View,
        ClickHouseViewFamily::Materialized | ClickHouseViewFamily::RefreshableMaterialized => {
            ContainerKind::MaterializedView
        }
    };
    if address.object_kind != expected_kind {
        return Err(validation(
            "ClickHouse View address object kind does not match the family",
        ));
    }
    Ok(())
}

fn validate_temporary_address(address: &ClickHouseViewAddress) -> IpcResult<()> {
    if address.database.is_some() || address.object_kind != ContainerKind::View {
        return Err(validation(
            "ClickHouse Temporary View address must be an unqualified View name",
        ));
    }
    validate_identifier(&address.name, "view.address.name")
}

fn validate_columns(
    columns: &ClickHouseViewColumnDefinition,
    family: ClickHouseViewFamily,
) -> IpcResult<()> {
    match (family, columns) {
        (
            ClickHouseViewFamily::Normal | ClickHouseViewFamily::Parameterized,
            ClickHouseViewColumnDefinition::None,
        )
        | (ClickHouseViewFamily::Live, ClickHouseViewColumnDefinition::None) => Ok(()),
        (
            ClickHouseViewFamily::Normal | ClickHouseViewFamily::Parameterized,
            ClickHouseViewColumnDefinition::Aliases(aliases),
        )
        | (ClickHouseViewFamily::Live, ClickHouseViewColumnDefinition::Aliases(aliases)) => {
            validate_aliases(aliases)
        }
        (
            ClickHouseViewFamily::Normal
            | ClickHouseViewFamily::Parameterized
            | ClickHouseViewFamily::Live,
            ClickHouseViewColumnDefinition::Typed(_),
        ) => Err(validation(
            "This ClickHouse View family does not accept typed columns",
        )),
        (
            ClickHouseViewFamily::Materialized | ClickHouseViewFamily::RefreshableMaterialized,
            ClickHouseViewColumnDefinition::None,
        ) => Ok(()),
        (
            ClickHouseViewFamily::Materialized | ClickHouseViewFamily::RefreshableMaterialized,
            ClickHouseViewColumnDefinition::Typed(columns),
        ) => validate_typed_columns(columns),
        (
            ClickHouseViewFamily::Materialized | ClickHouseViewFamily::RefreshableMaterialized,
            ClickHouseViewColumnDefinition::Aliases(_),
        ) => Err(validation(
            "ClickHouse Materialized View columns require explicit types",
        )),
        (ClickHouseViewFamily::Window, ClickHouseViewColumnDefinition::None) => Ok(()),
        (ClickHouseViewFamily::Window, _) => Err(validation(
            "ClickHouse Window View result columns are derived from its query",
        )),
        (ClickHouseViewFamily::Temporary, ClickHouseViewColumnDefinition::None) => Ok(()),
        (ClickHouseViewFamily::Temporary, _) => Err(validation(
            "ClickHouse Temporary View does not accept a column list",
        )),
    }
}

fn validate_typed_columns(columns: &[ClickHouseViewTypedColumn]) -> IpcResult<()> {
    if columns.is_empty() {
        return Err(validation(
            "ClickHouse Materialized View typed columns must not be empty",
        ));
    }
    let mut names = HashSet::with_capacity(columns.len());
    for column in columns {
        validate_identifier(&column.name, "view.columns.typed.name")?;
        if !names.insert(column.name.as_str()) {
            return Err(validation(
                "ClickHouse Materialized View typed column names must be unique",
            ));
        }
        let parsed = parse_type(&column.type_name)
            .map_err(|_| validation("ClickHouse Materialized View column type is invalid"))?;
        if matches!(parsed, ClickHouseType::Unknown { .. }) {
            return Err(validation(
                "ClickHouse Materialized View column type is unsupported",
            ));
        }
    }
    Ok(())
}

fn validate_materialized_storage(
    storage: &ClickHouseMaterializedStorage,
    populate: bool,
) -> IpcResult<()> {
    match storage {
        ClickHouseMaterializedStorage::ToTable {
            target,
            target_columns,
        } => {
            if populate {
                return Err(validation(
                    "ClickHouse Materialized View TO storage cannot use POPULATE",
                ));
            }
            if target.kind != ContainerKind::Table
                || target.table.as_deref().is_none_or(str::is_empty)
                || target.schema.is_some()
                || target.column.is_some()
                || target.object_name.is_some()
                || target.db_index.is_some()
                || target.key.is_some()
                || target.pattern.is_some()
            {
                return Err(validation(
                    "ClickHouse Materialized View TO target must be one table",
                ));
            }
            if let Some(database) = target.database.as_deref() {
                validate_identifier(database, "view.storage.to.database")?;
            }
            validate_identifier(
                target.table.as_deref().expect("checked table name"),
                "view.storage.to.table",
            )?;
            validate_aliases_if_present(target_columns, "TO target columns")
        }
        ClickHouseMaterializedStorage::InnerTable {
            engine,
            order_by,
            partition_by,
            settings,
        } => {
            validate_inner_engine(engine)?;
            validate_single_expression(order_by, "view.storage.orderBy")?;
            if let Some(partition_by) = partition_by.as_deref() {
                validate_single_expression(partition_by, "view.storage.partitionBy")?;
            }
            validate_inner_settings(settings)
        }
    }
}

fn validate_and_sort_refresh(
    desired_address: &ClickHouseViewAddress,
    refresh: &mut ClickHouseRefreshDefinition,
) -> IpcResult<()> {
    match refresh.mode {
        ClickHouseRefreshMode::Every | ClickHouseRefreshMode::After => {
            validate_interval(refresh.interval.as_ref(), "refresh.interval")?;
        }
        ClickHouseRefreshMode::DependsOnly => {
            if refresh.interval.is_some() || refresh.dependencies.is_empty() {
                return Err(validation(
                    "ClickHouse DEPENDS ONLY requires dependencies and no interval",
                ));
            }
        }
    }
    if let Some(offset) = refresh.offset.as_ref() {
        validate_interval(Some(offset), "refresh.offset")?;
    }
    if let Some(randomize) = refresh.randomize_for.as_ref() {
        validate_interval(Some(randomize), "refresh.randomizeFor")?;
    }
    validate_refresh_settings(&refresh.settings)?;

    for dependency in &refresh.dependencies {
        validate_dependency_address(dependency)?;
        if dependency.database == desired_address.database
            && dependency.name == desired_address.name
        {
            return Err(validation(
                "ClickHouse Refreshable Materialized View has a local dependency cycle",
            ));
        }
    }
    refresh.dependencies.sort_by_key(dependency_key);
    if refresh
        .dependencies
        .windows(2)
        .any(|pair| pair[0] == pair[1])
    {
        return Err(validation("ClickHouse refresh dependencies must be unique"));
    }
    Ok(())
}

fn validate_interval(interval: Option<&ClickHouseViewInterval>, label: &str) -> IpcResult<()> {
    if interval.is_none_or(|interval| interval.value == 0) {
        return Err(validation(format!(
            "ClickHouse {label} requires a positive typed interval"
        )));
    }
    Ok(())
}

fn validate_refresh_settings(settings: &ClickHouseRefreshSettings) -> IpcResult<()> {
    if settings
        .refresh_retry_initial_backoff_ms
        .is_some_and(|value| value == 0)
        || settings
            .refresh_retry_max_backoff_ms
            .is_some_and(|value| value == 0)
        || matches!(
            (
                settings.refresh_retry_initial_backoff_ms,
                settings.refresh_retry_max_backoff_ms,
            ),
            (Some(initial), Some(maximum)) if initial > maximum
        )
    {
        return Err(validation(
            "ClickHouse refresh retry backoff values are invalid",
        ));
    }
    Ok(())
}

fn validate_dependency_address(address: &ClickHouseViewAddress) -> IpcResult<()> {
    let database = address
        .database
        .as_deref()
        .ok_or_else(|| validation("ClickHouse refresh dependency requires a database"))?;
    validate_identifier(database, "view.refresh.dependency.database")?;
    validate_identifier(&address.name, "view.refresh.dependency.name")?;
    if !matches!(
        address.object_kind,
        ContainerKind::View | ContainerKind::MaterializedView
    ) {
        return Err(validation(
            "ClickHouse refresh dependency must reference a View",
        ));
    }
    Ok(())
}

fn dependency_key(address: &ClickHouseViewAddress) -> (String, String, u8) {
    (
        address.database.clone().unwrap_or_default(),
        address.name.clone(),
        u8::from(address.object_kind == ContainerKind::MaterializedView),
    )
}

fn validate_window_destination(
    destination: Option<&crate::engine::types::ContainerRef>,
    default_database: Option<&str>,
) -> IpcResult<()> {
    let Some(destination) = destination else {
        return Ok(());
    };
    if destination.kind != ContainerKind::Table
        || destination.table.as_deref().is_none_or(str::is_empty)
        || destination
            .database
            .as_deref()
            .or(default_database)
            .is_none()
        || destination.schema.is_some()
        || destination.column.is_some()
        || destination.object_name.is_some()
    {
        return Err(validation(
            "ClickHouse Window View destination must be one table",
        ));
    }
    Ok(())
}

fn validate_watermark(
    watermark: &ClickHouseWindowWatermark,
    allowed_lateness: Option<&ClickHouseViewInterval>,
) -> IpcResult<()> {
    if let ClickHouseWindowWatermark::Bounded(interval) = watermark {
        validate_interval(Some(interval), "window.watermark")?;
    }
    if let Some(lateness) = allowed_lateness {
        if matches!(watermark, ClickHouseWindowWatermark::None) {
            return Err(validation(
                "ClickHouse Window View lateness requires a watermark",
            ));
        }
        validate_interval(Some(lateness), "window.allowedLateness")?;
    }
    Ok(())
}

fn validate_aliases_if_present(values: &[String], label: &str) -> IpcResult<()> {
    let mut names = HashSet::with_capacity(values.len());
    for value in values {
        validate_identifier(value, label)?;
        if !names.insert(value.as_str()) {
            return Err(validation(
                "ClickHouse Materialized View target columns must be unique",
            ));
        }
    }
    Ok(())
}

fn validate_inner_engine(engine: &ClickHouseCreateEngineTarget) -> IpcResult<()> {
    let valid_arity = match engine.family.as_str() {
        "MergeTree" | "AggregatingMergeTree" => engine.arguments.is_empty(),
        "ReplacingMergeTree" | "SummingMergeTree" => engine.arguments.len() <= 1,
        "CollapsingMergeTree" => engine.arguments.len() == 1,
        "VersionedCollapsingMergeTree" => engine.arguments.len() == 2,
        _ => false,
    };
    if !valid_arity {
        return Err(validation(
            "ClickHouse Materialized View inner engine is unsupported",
        ));
    }
    for argument in &engine.arguments {
        validate_single_expression(argument, "view.storage.engine.argument")?;
    }
    Ok(())
}

fn validate_inner_settings(settings: &[ClickHouseCreateSettingTarget]) -> IpcResult<()> {
    let mut names = HashSet::with_capacity(settings.len());
    for setting in settings {
        if !names.insert(setting.name.as_str())
            || !matches!(
                setting.name.as_str(),
                "index_granularity"
                    | "index_granularity_bytes"
                    | "allow_nullable_key"
                    | "ttl_only_drop_parts"
            )
        {
            return Err(validation(
                "ClickHouse Materialized View inner setting is unsupported or duplicated",
            ));
        }
        validate_single_expression(&setting.value, "view.storage.setting.value")?;
    }
    Ok(())
}

fn validate_aliases(aliases: &[String]) -> IpcResult<()> {
    if aliases.is_empty() {
        return Err(validation(
            "ClickHouse View aliases must not be an empty list",
        ));
    }
    let mut names = HashSet::with_capacity(aliases.len());
    for alias in aliases {
        validate_identifier(alias, "view.columns.alias")?;
        if !names.insert(alias.as_str()) {
            return Err(validation("ClickHouse View aliases must be unique"));
        }
    }
    Ok(())
}

fn validate_security(definer: &Option<ClickHouseViewDefiner>) -> IpcResult<()> {
    if let Some(ClickHouseViewDefiner::NamedUser(user)) = definer {
        validate_identifier(user, "view.security.definer")?;
    }
    Ok(())
}

fn validate_comment(comment: Option<&str>) -> IpcResult<()> {
    if comment.is_some_and(|value| value.chars().any(char::is_control)) {
        return Err(validation(
            "ClickHouse View comment must not contain control characters",
        ));
    }
    Ok(())
}

fn validate_support_revision(
    expected: &str,
    support: &ClickHouseViewRuntimeSupport,
) -> IpcResult<()> {
    if expected != support.support_revision {
        return Err(IpcError::resource_conflict(
            "ClickHouse View runtime support changed; refresh facts before previewing",
        ));
    }
    Ok(())
}

fn validate_baseline(
    baseline: &ClickHouseViewSchema,
    support: &ClickHouseViewRuntimeSupport,
) -> IpcResult<()> {
    if baseline.editability.mode != ClickHouseSchemaEditabilityMode::Editable {
        return Err(IpcError::feature_unavailable(
            "ClickHouse View baseline is read-only",
        ));
    }
    if baseline.baseline.revision_hash.trim().is_empty()
        || baseline.baseline.family != baseline.family
        || baseline.baseline.support_revision != support.support_revision
    {
        return Err(IpcError::resource_conflict(
            "ClickHouse View baseline changed; refresh facts before previewing",
        ));
    }
    if baseline.family == ClickHouseViewFamily::Temporary {
        validate_temporary_address(&baseline.identity.address)?;
        match &baseline.scope {
            ClickHouseViewScope::Temporary {
                owner_tab_runtime_id,
                session_state: super::ClickHouseTemporarySessionState::Active,
            } if !owner_tab_runtime_id.trim().is_empty() => Ok(()),
            ClickHouseViewScope::Temporary { .. } => Err(IpcError::resource_not_found(
                "ClickHouse Temporary View session is expired",
            )),
            _ => Err(validation(
                "ClickHouse Temporary View baseline requires an owner session scope",
            )),
        }
    } else {
        validate_persistent_address(&baseline.identity.address, baseline.family)
    }
}

fn validate_create_scope(
    desired: &ClickHouseViewDefinitionTarget,
    support: &ClickHouseViewRuntimeSupport,
    cluster_baseline: Option<&ClickHouseClusterViewBaseline>,
) -> IpcResult<()> {
    if desired.family == ClickHouseViewFamily::Temporary {
        return match (&desired.scope, cluster_baseline) {
            (
                ClickHouseViewScopeTarget::Temporary {
                    owner_tab_runtime_id,
                },
                None,
            ) if !owner_tab_runtime_id.trim().is_empty() => Ok(()),
            _ => Err(validation(
                "ClickHouse Temporary View requires only a non-empty owner tab runtime",
            )),
        };
    }
    match &desired.scope {
        ClickHouseViewScopeTarget::Local if cluster_baseline.is_none() => Ok(()),
        ClickHouseViewScopeTarget::Local => Err(validation(
            "Local ClickHouse View Create must not include a cluster baseline",
        )),
        ClickHouseViewScopeTarget::Temporary { .. } => Err(validation(
            "Persistent ClickHouse View family cannot use a Temporary scope",
        )),
        ClickHouseViewScopeTarget::Cluster { cluster_name } => {
            validate_identifier(cluster_name, "view.scope.clusterName")?;
            let cluster = cluster_baseline.ok_or_else(|| {
                validation("Cluster ClickHouse View Create requires a full node baseline")
            })?;
            if cluster.cluster_name != *cluster_name
                || !(support.cluster_ddl.discoverable
                    && support.cluster_ddl.executable
                    && support.cluster_ddl.observable
                    && support.cluster_ddl.drift_verifiable)
                || cluster.nodes.iter().any(|node| {
                    !node.reachable || node.object_state != ClickHouseClusterObjectState::Absent
                })
            {
                return Err(IpcError::resource_conflict(
                    "ClickHouse cluster View baseline is incomplete or inconsistent",
                ));
            }
            Ok(())
        }
    }
}

fn validate_persistent_change_scope(
    scope: &ClickHouseViewScope,
    support: &ClickHouseViewRuntimeSupport,
) -> IpcResult<()> {
    match scope {
        ClickHouseViewScope::Local => Ok(()),
        ClickHouseViewScope::Cluster { cluster_name }
            if !cluster_name.trim().is_empty()
                && support.cluster_ddl.discoverable
                && support.cluster_ddl.executable
                && support.cluster_ddl.observable
                && support.cluster_ddl.drift_verifiable =>
        {
            Ok(())
        }
        ClickHouseViewScope::Cluster { .. } => Err(IpcError::feature_unavailable(
            "Cluster ClickHouse View changes require complete cluster support",
        )),
        ClickHouseViewScope::Temporary {
            owner_tab_runtime_id,
            session_state: super::ClickHouseTemporarySessionState::Active,
        } if !owner_tab_runtime_id.trim().is_empty() => Ok(()),
        ClickHouseViewScope::Temporary { .. } => Err(IpcError::resource_not_found(
            "ClickHouse Temporary View session is expired",
        )),
    }
}

fn scope_matches(current: &ClickHouseViewScope, desired: &ClickHouseViewScopeTarget) -> bool {
    match (current, desired) {
        (ClickHouseViewScope::Local, ClickHouseViewScopeTarget::Local) => true,
        (
            ClickHouseViewScope::Cluster {
                cluster_name: current,
            },
            ClickHouseViewScopeTarget::Cluster {
                cluster_name: desired,
            },
        ) => current == desired,
        (
            ClickHouseViewScope::Temporary {
                owner_tab_runtime_id: current,
                ..
            },
            ClickHouseViewScopeTarget::Temporary {
                owner_tab_runtime_id: desired,
            },
        ) => current == desired,
        _ => false,
    }
}

pub(super) fn family_support(
    support: &ClickHouseViewRuntimeSupport,
    family: ClickHouseViewFamily,
) -> IpcResult<&ClickHouseViewFamilySupport> {
    Ok(match family {
        ClickHouseViewFamily::Normal => &support.normal,
        ClickHouseViewFamily::Parameterized => &support.parameterized,
        ClickHouseViewFamily::Temporary => &support.temporary,
        ClickHouseViewFamily::Materialized => &support.materialized,
        ClickHouseViewFamily::RefreshableMaterialized => &support.refreshable_materialized,
        ClickHouseViewFamily::Window => &support.window,
        ClickHouseViewFamily::Live => &support.live,
    })
}

fn validation(message: impl Into<String>) -> IpcError {
    IpcError::validation_failed(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alias_and_comment_validation_rejects_ambiguous_input() {
        assert!(validate_aliases(&["id".to_string(), "id".to_string()]).is_err());
        assert!(validate_aliases(&[]).is_err());
        assert!(validate_comment(Some("line\nbreak")).is_err());
        assert!(validate_aliases(&["id".to_string(), "tenant".to_string()]).is_ok());
    }
}
