#![allow(dead_code)]

use std::collections::BTreeMap;

use crate::error::{IpcError, IpcResult};

use super::{
    ClickHouseMaterializedStorage, ClickHousePlannedStatement, ClickHouseRefreshDefinition,
    ClickHouseRefreshMode, ClickHouseRefreshSettings, ClickHouseViewAddress,
    ClickHouseViewColumnDefinition, ClickHouseViewDefiner, ClickHouseViewDefinitionTarget,
    ClickHouseViewFamily, ClickHouseViewFamilyDefinition, ClickHouseViewInterval,
    ClickHouseViewIntervalUnit, ClickHouseViewScope, ClickHouseViewScopeTarget,
    ClickHouseViewSecurity, ClickHouseViewSqlSecurity, ClickHouseWindowWatermark,
};

pub(super) fn render_create_view(
    desired: &ClickHouseViewDefinitionTarget,
    replace: bool,
) -> IpcResult<ClickHousePlannedStatement> {
    let prefix = match (replace, desired.family) {
        (false, ClickHouseViewFamily::Normal | ClickHouseViewFamily::Parameterized) => {
            "CREATE VIEW"
        }
        (true, ClickHouseViewFamily::Normal | ClickHouseViewFamily::Parameterized) => {
            "CREATE OR REPLACE VIEW"
        }
        (false, ClickHouseViewFamily::Live) => "CREATE LIVE VIEW",
        (true, ClickHouseViewFamily::Live) => "CREATE OR REPLACE LIVE VIEW",
        (false, ClickHouseViewFamily::Materialized) => "CREATE MATERIALIZED VIEW",
        (true, ClickHouseViewFamily::Materialized) => "CREATE OR REPLACE MATERIALIZED VIEW",
        (false, ClickHouseViewFamily::RefreshableMaterialized) => "CREATE MATERIALIZED VIEW",
        (true, ClickHouseViewFamily::RefreshableMaterialized) => {
            "CREATE OR REPLACE MATERIALIZED VIEW"
        }
        (false, ClickHouseViewFamily::Window) => "CREATE WINDOW VIEW",
        (true, ClickHouseViewFamily::Window) => "CREATE OR REPLACE WINDOW VIEW",
        (false, ClickHouseViewFamily::Temporary) => "CREATE TEMPORARY VIEW",
        (true, ClickHouseViewFamily::Temporary) => {
            return Err(IpcError::feature_unavailable(
                "ClickHouse Temporary View replacement uses explicit Drop and Create",
            ));
        }
    };
    let rendered_address = if desired.family == ClickHouseViewFamily::Temporary {
        quote_identifier(&desired.address.name)
    } else {
        qualified_address(&desired.address)?
    };
    let mut statement = format!("{prefix} {rendered_address}");
    append_scope_target(&mut statement, &desired.scope);
    append_columns(&mut statement, &desired.columns);
    append_live_options(&mut statement, &desired.family_definition)?;
    append_materialized_options(
        &mut statement,
        &desired.family_definition,
        desired.address.database.as_deref(),
    )?;
    append_refreshable_options(
        &mut statement,
        &desired.family_definition,
        desired.address.database.as_deref(),
    )?;
    append_window_options(
        &mut statement,
        &desired.family_definition,
        desired.address.database.as_deref(),
    )?;
    append_security(&mut statement, &desired.security);
    statement.push_str("\nAS ");
    statement.push_str(&desired.query);
    if let Some(comment) = desired.comment.as_deref() {
        statement.push_str("\nCOMMENT ");
        statement.push_str(&quote_string_literal(comment));
    }
    let mut planned = planned(statement);
    if desired.family == ClickHouseViewFamily::Window {
        enable_window_experimental(&mut planned);
    }
    Ok(planned)
}

pub(super) fn render_modify_query(
    address: &ClickHouseViewAddress,
    scope: &ClickHouseViewScope,
    query: &str,
) -> IpcResult<ClickHousePlannedStatement> {
    let mut statement = format!("ALTER TABLE {}", qualified_address(address)?);
    append_scope(&mut statement, scope);
    statement.push_str(" MODIFY QUERY ");
    statement.push_str(query);
    Ok(planned(statement))
}

pub(super) fn render_modify_comment(
    address: &ClickHouseViewAddress,
    scope: &ClickHouseViewScope,
    comment: Option<&str>,
) -> IpcResult<ClickHousePlannedStatement> {
    let mut statement = format!("ALTER TABLE {}", qualified_address(address)?);
    append_scope(&mut statement, scope);
    statement.push_str(" MODIFY COMMENT ");
    statement.push_str(&quote_string_literal(comment.unwrap_or_default()));
    Ok(planned(statement))
}

pub(super) fn render_modify_definer(
    address: &ClickHouseViewAddress,
    scope: &ClickHouseViewScope,
    definer: Option<&ClickHouseViewDefiner>,
) -> IpcResult<ClickHousePlannedStatement> {
    let mut statement = format!("ALTER TABLE {}", qualified_address(address)?);
    append_scope(&mut statement, scope);
    statement.push_str(" MODIFY DEFINER = ");
    match definer {
        Some(ClickHouseViewDefiner::NamedUser(user)) => {
            statement.push_str(&quote_identifier(user));
        }
        Some(ClickHouseViewDefiner::CurrentUser) | None => statement.push_str("CURRENT_USER"),
    }
    Ok(planned(statement))
}

pub(super) fn render_modify_sql_security(
    address: &ClickHouseViewAddress,
    scope: &ClickHouseViewScope,
    sql_security: ClickHouseViewSqlSecurity,
) -> IpcResult<ClickHousePlannedStatement> {
    let mut statement = format!("ALTER TABLE {}", qualified_address(address)?);
    append_scope(&mut statement, scope);
    statement.push_str(" MODIFY SQL SECURITY ");
    statement.push_str(render_sql_security(sql_security));
    Ok(planned(statement))
}

pub(super) fn render_modify_refresh(
    address: &ClickHouseViewAddress,
    scope: &ClickHouseViewScope,
    refresh: &ClickHouseRefreshDefinition,
) -> IpcResult<ClickHousePlannedStatement> {
    let mut statement = format!("ALTER TABLE {}", qualified_address(address)?);
    append_scope(&mut statement, scope);
    statement.push_str(" MODIFY ");
    append_refresh_clause(&mut statement, refresh)?;
    Ok(planned(statement))
}

pub(super) fn enable_window_experimental(statement: &mut ClickHousePlannedStatement) {
    statement.settings.insert(
        "allow_experimental_window_view".to_string(),
        "1".to_string(),
    );
}

pub(super) fn render_rename_view(
    source: &ClickHouseViewAddress,
    scope: &ClickHouseViewScope,
    destination: &ClickHouseViewAddress,
) -> IpcResult<ClickHousePlannedStatement> {
    let mut statement = format!(
        "RENAME TABLE {} TO {}",
        address_for_scope(source, scope)?,
        address_for_scope(destination, scope)?
    );
    append_scope(&mut statement, scope);
    Ok(planned(statement))
}

pub(super) fn render_drop_view(
    address: &ClickHouseViewAddress,
    scope: &ClickHouseViewScope,
) -> IpcResult<ClickHousePlannedStatement> {
    let mut statement = format!("DROP VIEW {}", address_for_scope(address, scope)?);
    append_scope(&mut statement, scope);
    statement.push_str(" SYNC");
    Ok(planned(statement))
}

fn append_scope_target(statement: &mut String, scope: &ClickHouseViewScopeTarget) {
    if let ClickHouseViewScopeTarget::Cluster { cluster_name } = scope {
        statement.push_str(" ON CLUSTER ");
        statement.push_str(&quote_string_literal(cluster_name));
    }
}

fn append_scope(statement: &mut String, scope: &ClickHouseViewScope) {
    if let ClickHouseViewScope::Cluster { cluster_name } = scope {
        statement.push_str(" ON CLUSTER ");
        statement.push_str(&quote_string_literal(cluster_name));
    }
}

fn append_columns(statement: &mut String, columns: &ClickHouseViewColumnDefinition) {
    match columns {
        ClickHouseViewColumnDefinition::Aliases(aliases) => {
            statement.push_str(" (");
            statement.push_str(
                &aliases
                    .iter()
                    .map(|alias| quote_identifier(alias))
                    .collect::<Vec<_>>()
                    .join(", "),
            );
            statement.push(')');
        }
        ClickHouseViewColumnDefinition::Typed(columns) => {
            statement.push_str(" (");
            statement.push_str(
                &columns
                    .iter()
                    .map(|column| {
                        format!("{} {}", quote_identifier(&column.name), column.type_name)
                    })
                    .collect::<Vec<_>>()
                    .join(", "),
            );
            statement.push(')');
        }
        ClickHouseViewColumnDefinition::None => {}
    }
}

fn append_materialized_options(
    statement: &mut String,
    definition: &ClickHouseViewFamilyDefinition,
    default_database: Option<&str>,
) -> IpcResult<()> {
    let ClickHouseViewFamilyDefinition::Materialized { storage, populate } = definition else {
        return Ok(());
    };
    append_storage(statement, storage, *populate, default_database)
}

fn append_refreshable_options(
    statement: &mut String,
    definition: &ClickHouseViewFamilyDefinition,
    default_database: Option<&str>,
) -> IpcResult<()> {
    let ClickHouseViewFamilyDefinition::RefreshableMaterialized {
        storage,
        refresh,
        append,
        empty,
    } = definition
    else {
        return Ok(());
    };
    statement.push('\n');
    append_refresh_clause(statement, refresh)?;
    if *append {
        statement.push_str("\nAPPEND");
    }
    append_storage(statement, storage, false, default_database)?;
    if *empty {
        statement.push_str("\nEMPTY");
    }
    Ok(())
}

fn append_storage(
    statement: &mut String,
    storage: &ClickHouseMaterializedStorage,
    populate: bool,
    default_database: Option<&str>,
) -> IpcResult<()> {
    match storage {
        ClickHouseMaterializedStorage::ToTable {
            target,
            target_columns,
        } => {
            let table = target.table.as_deref().ok_or_else(|| {
                IpcError::validation_failed("ClickHouse Materialized View TO target is missing")
            })?;
            let database = target.database.as_deref().or(default_database);
            statement.push_str("\nTO ");
            if let Some(database) = database {
                statement.push_str(&quote_identifier(database));
                statement.push('.');
            }
            statement.push_str(&quote_identifier(table));
            if !target_columns.is_empty() {
                statement.push_str(" (");
                statement.push_str(
                    &target_columns
                        .iter()
                        .map(|column| quote_identifier(column))
                        .collect::<Vec<_>>()
                        .join(", "),
                );
                statement.push(')');
            }
        }
        ClickHouseMaterializedStorage::InnerTable {
            engine,
            order_by,
            partition_by,
            settings,
        } => {
            statement.push_str("\nENGINE = ");
            statement.push_str(&engine.family);
            if !engine.arguments.is_empty() {
                statement.push('(');
                statement.push_str(&engine.arguments.join(", "));
                statement.push(')');
            }
            if let Some(partition_by) = partition_by {
                statement.push_str("\nPARTITION BY ");
                statement.push_str(partition_by);
            }
            statement.push_str("\nORDER BY ");
            statement.push_str(order_by);
            if !settings.is_empty() {
                statement.push_str("\nSETTINGS ");
                statement.push_str(
                    &settings
                        .iter()
                        .map(|setting| format!("{} = {}", setting.name, setting.value))
                        .collect::<Vec<_>>()
                        .join(", "),
                );
            }
        }
    }
    if populate {
        statement.push_str("\nPOPULATE");
    }
    Ok(())
}

fn append_refresh_clause(
    statement: &mut String,
    refresh: &ClickHouseRefreshDefinition,
) -> IpcResult<()> {
    statement.push_str("REFRESH ");
    match refresh.mode {
        ClickHouseRefreshMode::Every => {
            statement.push_str("EVERY ");
            statement.push_str(&render_required_interval(refresh.interval.as_ref())?);
        }
        ClickHouseRefreshMode::After => {
            statement.push_str("AFTER ");
            statement.push_str(&render_required_interval(refresh.interval.as_ref())?);
        }
        ClickHouseRefreshMode::DependsOnly => statement.push_str("DEPENDS ONLY"),
    }
    if let Some(offset) = refresh.offset.as_ref() {
        statement.push_str(" OFFSET ");
        statement.push_str(&render_interval(offset));
    }
    if let Some(randomize_for) = refresh.randomize_for.as_ref() {
        statement.push_str(" RANDOMIZE FOR ");
        statement.push_str(&render_interval(randomize_for));
    }
    if !refresh.dependencies.is_empty() {
        statement.push_str(" DEPENDS ON ");
        statement.push_str(
            &refresh
                .dependencies
                .iter()
                .map(qualified_address)
                .collect::<IpcResult<Vec<_>>>()?
                .join(", "),
        );
    }
    append_refresh_settings(statement, &refresh.settings);
    Ok(())
}

fn append_refresh_settings(statement: &mut String, settings: &ClickHouseRefreshSettings) {
    let mut values = Vec::new();
    if let Some(value) = settings.refresh_retries {
        values.push(format!("refresh_retries = {value}"));
    }
    if let Some(value) = settings.refresh_retry_initial_backoff_ms {
        values.push(format!("refresh_retry_initial_backoff_ms = {value}"));
    }
    if let Some(value) = settings.refresh_retry_max_backoff_ms {
        values.push(format!("refresh_retry_max_backoff_ms = {value}"));
    }
    if let Some(value) = settings.all_replicas {
        values.push(format!("all_replicas = {}", u8::from(value)));
    }
    if !values.is_empty() {
        statement.push_str(" SETTINGS ");
        statement.push_str(&values.join(", "));
    }
}

fn append_window_options(
    statement: &mut String,
    definition: &ClickHouseViewFamilyDefinition,
    default_database: Option<&str>,
) -> IpcResult<()> {
    let ClickHouseViewFamilyDefinition::Window {
        destination,
        inner_engine,
        result_engine,
        watermark,
        allowed_lateness,
        populate,
        ..
    } = definition
    else {
        return Ok(());
    };
    if let Some(destination) = destination {
        statement.push_str("\nTO ");
        statement.push_str(&qualified_container(destination, default_database)?);
    }
    if let Some(inner_engine) = inner_engine {
        statement.push_str("\nINNER ENGINE = ");
        statement.push_str(inner_engine);
    }
    if let Some(result_engine) = result_engine {
        statement.push_str("\nENGINE = ");
        statement.push_str(result_engine);
    }
    match watermark {
        ClickHouseWindowWatermark::None => {}
        ClickHouseWindowWatermark::StrictlyAscending => {
            statement.push_str("\nWATERMARK=STRICTLY_ASCENDING");
        }
        ClickHouseWindowWatermark::Ascending => {
            statement.push_str("\nWATERMARK=ASCENDING");
        }
        ClickHouseWindowWatermark::Bounded(interval) => {
            statement.push_str("\nWATERMARK=INTERVAL ");
            statement.push_str(&render_window_interval(interval));
        }
    }
    if let Some(lateness) = allowed_lateness {
        statement.push_str("\nALLOWED_LATENESS=INTERVAL ");
        statement.push_str(&render_window_interval(lateness));
    }
    if *populate {
        statement.push_str("\nPOPULATE");
    }
    Ok(())
}

fn qualified_container(
    target: &crate::engine::types::ContainerRef,
    default_database: Option<&str>,
) -> IpcResult<String> {
    let table = target.table.as_deref().ok_or_else(|| {
        IpcError::validation_failed("ClickHouse View destination is missing a table")
    })?;
    Ok(match target.database.as_deref().or(default_database) {
        Some(database) => format!("{}.{}", quote_identifier(database), quote_identifier(table)),
        None => quote_identifier(table),
    })
}

fn render_required_interval(interval: Option<&ClickHouseViewInterval>) -> IpcResult<String> {
    interval
        .map(render_interval)
        .ok_or_else(|| IpcError::validation_failed("ClickHouse refresh interval is required"))
}

fn render_interval(interval: &ClickHouseViewInterval) -> String {
    let unit = match interval.unit {
        ClickHouseViewIntervalUnit::Second => "SECOND",
        ClickHouseViewIntervalUnit::Minute => "MINUTE",
        ClickHouseViewIntervalUnit::Hour => "HOUR",
        ClickHouseViewIntervalUnit::Day => "DAY",
        ClickHouseViewIntervalUnit::Week => "WEEK",
        ClickHouseViewIntervalUnit::Month => "MONTH",
        ClickHouseViewIntervalUnit::Year => "YEAR",
    };
    format!("{} {unit}", interval.value)
}

fn render_window_interval(interval: &ClickHouseViewInterval) -> String {
    let rendered = render_interval(interval);
    let (value, unit) = rendered
        .split_once(' ')
        .expect("typed ClickHouse interval always contains a unit");
    format!("'{value}' {unit}")
}

fn append_live_options(
    statement: &mut String,
    definition: &ClickHouseViewFamilyDefinition,
) -> IpcResult<()> {
    let ClickHouseViewFamilyDefinition::Live {
        timeout_seconds,
        refresh_seconds,
        canonical_legacy_options,
    } = definition
    else {
        return Ok(());
    };
    if !canonical_legacy_options.is_empty() {
        return Err(IpcError::feature_unavailable(
            "ClickHouse Live View contains legacy clauses that cannot be rendered safely",
        ));
    }
    let mut options = Vec::new();
    if let Some(timeout) = timeout_seconds {
        options.push(format!("TIMEOUT {timeout}"));
    }
    if let Some(refresh) = refresh_seconds {
        options.push(format!("REFRESH {refresh}"));
    }
    if !options.is_empty() {
        statement.push_str("\nWITH ");
        statement.push_str(&options.join(" AND "));
    }
    Ok(())
}

fn append_security(statement: &mut String, security: &ClickHouseViewSecurity) {
    if let Some(definer) = &security.definer {
        statement.push_str("\nDEFINER = ");
        match definer {
            ClickHouseViewDefiner::CurrentUser => statement.push_str("CURRENT_USER"),
            ClickHouseViewDefiner::NamedUser(user) => {
                statement.push_str(&quote_identifier(user));
            }
        }
    }
    if let Some(sql_security) = security.sql_security {
        statement.push_str("\nSQL SECURITY ");
        statement.push_str(render_sql_security(sql_security));
    }
}

fn render_sql_security(sql_security: ClickHouseViewSqlSecurity) -> &'static str {
    match sql_security {
        ClickHouseViewSqlSecurity::Definer => "DEFINER",
        ClickHouseViewSqlSecurity::Invoker => "INVOKER",
        ClickHouseViewSqlSecurity::None => "NONE",
    }
}

fn qualified_address(address: &ClickHouseViewAddress) -> IpcResult<String> {
    let database = address.database.as_deref().ok_or_else(|| {
        IpcError::validation_failed("Persistent ClickHouse View address requires a database")
    })?;
    Ok(format!(
        "{}.{}",
        quote_identifier(database),
        quote_identifier(&address.name)
    ))
}

fn address_for_scope(
    address: &ClickHouseViewAddress,
    scope: &ClickHouseViewScope,
) -> IpcResult<String> {
    if matches!(scope, ClickHouseViewScope::Temporary { .. }) {
        Ok(quote_identifier(&address.name))
    } else {
        qualified_address(address)
    }
}

pub(super) fn quote_identifier(identifier: &str) -> String {
    let escaped = identifier.replace('\\', "\\\\").replace('`', "\\`");
    format!("`{escaped}`")
}

pub(super) fn quote_string_literal(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('\'', "\\'");
    format!("'{escaped}'")
}

fn planned(sql: String) -> ClickHousePlannedStatement {
    ClickHousePlannedStatement {
        sql,
        settings: BTreeMap::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renderer_owns_identifier_and_literal_escaping() {
        assert_eq!(quote_identifier("odd`name\\x"), "`odd\\`name\\\\x`");
        assert_eq!(quote_string_literal("it's\\safe"), "'it\\'s\\\\safe'");
    }
}
