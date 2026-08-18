#![allow(dead_code)]

use std::future::Future;

use async_trait::async_trait;
use clickhouse::error::Error as ClickHouseError;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::engine::types::{ContainerKind, ContainerRef};
use crate::error::{IpcError, IpcResult};

use super::super::types::{
    ClickHouseSchemaBlocker, ClickHouseSchemaEditability, ClickHouseSchemaEditabilityMode,
};
use super::{
    parse_clickhouse_view_create, ClickHouseSupportState, ClickHouseViewAddress,
    ClickHouseViewBaseline, ClickHouseViewColumnDefinition, ClickHouseViewFamily,
    ClickHouseViewFamilySupport, ClickHouseViewIdentity, ClickHouseViewRuntimeSupport,
    ClickHouseViewSchema, ClickHouseViewScope, ClickHouseViewTypedColumn,
};
use super::{probe_view_runtime_support, ClientViewSupportExecutor};
use crate::engine::drivers::clickhouse::ClickHouseDriver;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ViewCatalogRow {
    pub database: String,
    pub name: String,
    pub engine: String,
    pub uuid: Option<String>,
    pub create_query: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ViewColumnCatalogRow {
    pub name: String,
    pub type_name: String,
    pub position: u64,
}

#[async_trait]
pub(crate) trait ViewDescribeExecutor: Send + Sync {
    async fn object(&self, database: &str, name: &str) -> IpcResult<ViewCatalogRow>;
    async fn columns(&self, database: &str, name: &str) -> IpcResult<Vec<ViewColumnCatalogRow>>;
    async fn show_create(&self, database: &str, name: &str) -> IpcResult<String>;
    async fn refresh_exists(&self, database: &str, name: &str) -> IpcResult<Option<bool>>;
}

pub(crate) struct ClientViewDescribeExecutor<'a> {
    driver: &'a ClickHouseDriver,
}

impl<'a> ClientViewDescribeExecutor<'a> {
    pub(crate) fn new(driver: &'a ClickHouseDriver) -> Self {
        Self { driver }
    }

    async fn bounded<T, F>(&self, operation: &'static str, request: F) -> IpcResult<T>
    where
        F: Future<Output = Result<T, ClickHouseError>>,
    {
        if *self.driver.shutdown.borrow() {
            return Err(IpcError::operation_canceled(
                "ClickHouse View Describe canceled",
                "The runtime is closing",
            ));
        }
        let mut shutdown = self.driver.shutdown.subscribe();
        tokio::select! {
            biased;
            _ = shutdown.changed() => Err(IpcError::operation_canceled(
                "ClickHouse View Describe canceled",
                "The runtime closed while View Describe was in flight",
            )),
            result = tokio::time::timeout(self.driver.timeout, request) => match result {
                Err(_) => Err(IpcError::network_timeout(
                    "ClickHouse View Describe timed out",
                    format!("operation={operation}; category=timeout"),
                )),
                Ok(Ok(value)) => Ok(value),
                Ok(Err(error)) => Err(
                    super::super::super::error::classify_metadata_error(error, operation)
                ),
            }
        }
    }
}

#[derive(Debug, clickhouse::Row, Deserialize)]
struct ClientViewCatalogRow {
    database: String,
    name: String,
    engine: String,
    uuid: Option<String>,
    create_query: String,
}

#[derive(Debug, clickhouse::Row, Deserialize)]
struct ClientViewColumnRow {
    name: String,
    type_name: String,
    position: u64,
}

#[derive(Debug, clickhouse::Row, Deserialize)]
struct ShowCreateRow {
    statement: String,
}

#[derive(Debug, clickhouse::Row, Deserialize)]
struct CountRow {
    count: u64,
}

#[async_trait]
impl ViewDescribeExecutor for ClientViewDescribeExecutor<'_> {
    async fn object(&self, database: &str, name: &str) -> IpcResult<ViewCatalogRow> {
        let row = self
            .bounded(
                "describe View identity",
                self.driver
                    .client
                    .query(
                        "SELECT database, name, engine, nullIf(toString(uuid), '00000000-0000-0000-0000-000000000000') AS uuid, create_table_query AS create_query FROM system.tables WHERE database = ? AND name = ? LIMIT 1",
                    )
                    .bind(database)
                    .bind(name)
                    .fetch_optional::<ClientViewCatalogRow>(),
            )
            .await?
            .ok_or_else(|| IpcError::resource_not_found("ClickHouse View was not found"))?;
        Ok(ViewCatalogRow {
            database: row.database,
            name: row.name,
            engine: row.engine,
            uuid: row.uuid,
            create_query: row.create_query,
        })
    }

    async fn columns(&self, database: &str, name: &str) -> IpcResult<Vec<ViewColumnCatalogRow>> {
        let rows = self
            .bounded(
                "describe View columns",
                self.driver
                    .client
                    .query(
                        "SELECT name, type AS type_name, toUInt64(position) AS position FROM system.columns WHERE database = ? AND table = ? ORDER BY position",
                    )
                    .bind(database)
                    .bind(name)
                    .fetch_all::<ClientViewColumnRow>(),
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|row| ViewColumnCatalogRow {
                name: row.name,
                type_name: row.type_name,
                position: row.position,
            })
            .collect())
    }

    async fn show_create(&self, database: &str, name: &str) -> IpcResult<String> {
        let sql = format!(
            "SHOW CREATE TABLE {}.{}",
            quote_identifier(database)?,
            quote_identifier(name)?
        );
        self.bounded(
            "show View canonical definition",
            self.driver.client.query(&sql).fetch_one::<ShowCreateRow>(),
        )
        .await
        .map(|row| row.statement)
    }

    async fn refresh_exists(&self, database: &str, name: &str) -> IpcResult<Option<bool>> {
        let result = self
            .bounded(
                "describe refreshable View runtime",
                self.driver
                    .client
                    .query(
                        "SELECT count() AS count FROM system.view_refreshes WHERE database = ? AND view = ?",
                    )
                    .bind(database)
                    .bind(name)
                    .fetch_one::<CountRow>(),
            )
            .await;
        match result {
            Ok(row) => Ok(Some(row.count > 0)),
            Err(error)
                if matches!(
                    error.code,
                    crate::error::ErrorCode::FeatureUnavailable
                        | crate::error::ErrorCode::PermissionDenied
                ) =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }
}

pub(crate) async fn describe_persistent_view(
    driver: &ClickHouseDriver,
    container: &ContainerRef,
) -> IpcResult<ClickHouseViewSchema> {
    let database = container.database.as_deref();
    let support =
        probe_view_runtime_support(&ClientViewSupportExecutor::new(driver), database).await?;
    describe_persistent_view_with(
        &ClientViewDescribeExecutor::new(driver),
        container,
        &support,
    )
    .await
}

pub(crate) async fn describe_persistent_view_with<E: ViewDescribeExecutor>(
    executor: &E,
    container: &ContainerRef,
    support: &ClickHouseViewRuntimeSupport,
) -> IpcResult<ClickHouseViewSchema> {
    let (database, name) = validate_persistent_view_container(container)?;
    let object = executor.object(database, name).await?;
    let mut columns = executor.columns(database, name).await?;
    let canonical_create_query = executor.show_create(database, name).await?;
    let parsed = parse_clickhouse_view_create(&canonical_create_query, support)?;
    if parsed.family == ClickHouseViewFamily::Temporary {
        return Err(IpcError::feature_unavailable(
            "Temporary View Describe requires an owner tab runtime session",
        ));
    }
    let mut blockers = Vec::new();

    if object.database != database || object.name != name {
        blockers.push(blocker(
            "catalog_identity_conflict",
            "identity",
            "ClickHouse catalog identity does not match the requested View",
        ));
    }
    if !catalog_definition_matches(&object.create_query, &canonical_create_query, support) {
        blockers.push(blocker(
            "catalog_create_conflict",
            "baseline",
            "ClickHouse catalog and SHOW CREATE definitions disagree",
        ));
    }
    if !engine_matches_family(&object.engine, parsed.family) {
        blockers.push(blocker(
            "catalog_family_conflict",
            "family",
            "ClickHouse catalog engine and canonical View family disagree",
        ));
    }

    let object_kind = object_kind(parsed.family);
    if container.kind != object_kind {
        blockers.push(blocker(
            "container_kind_conflict",
            "identity.address.objectKind",
            "ClickHouse container kind and canonical View family disagree",
        ));
    }

    columns.sort_by_key(|column| column.position);
    cross_check_columns(&parsed.columns, &columns, &mut blockers);
    if !parsed.unknown_clauses.is_empty() {
        blockers.push(blocker(
            "unknown_canonical_clause",
            "familyDefinition",
            "ClickHouse View contains canonical clauses that are not modeled",
        ));
    }

    if parsed.family == ClickHouseViewFamily::RefreshableMaterialized
        && executor.refresh_exists(database, name).await? == Some(false)
    {
        blockers.push(blocker(
            "refresh_catalog_conflict",
            "familyDefinition.refresh",
            "ClickHouse refresh catalog does not contain the described View",
        ));
    }

    let family_support = family_support(support, parsed.family);
    if family_support.describe.state != ClickHouseSupportState::Supported {
        blockers.push(blocker(
            "describe_support_unverified",
            "serverSupport",
            "ClickHouse View Describe support is not verified",
        ));
    }

    let revision_hash = view_revision_hash(
        &canonical_create_query,
        parsed.family,
        &support.support_revision,
    );
    let editability = if blockers.is_empty() {
        ClickHouseSchemaEditability::editable()
    } else {
        ClickHouseSchemaEditability {
            mode: ClickHouseSchemaEditabilityMode::Readonly,
            blockers,
        }
    };

    Ok(ClickHouseViewSchema {
        identity: ClickHouseViewIdentity {
            address: ClickHouseViewAddress {
                database: Some(object.database),
                name: object.name,
                object_kind,
            },
            uuid: object.uuid.filter(|uuid| !uuid.trim().is_empty()),
        },
        family: parsed.family,
        scope: ClickHouseViewScope::Local,
        columns: parsed.columns,
        query: parsed.query,
        security: parsed.security,
        comment: parsed.comment,
        family_definition: parsed.family_definition,
        server_support: support.clone(),
        editability,
        baseline: ClickHouseViewBaseline {
            canonical_create_query,
            revision_hash,
            server_version: support.server_version.clone(),
            family: parsed.family,
            support_revision: support.support_revision.clone(),
        },
    })
}

fn catalog_definition_matches(
    catalog: &str,
    canonical: &str,
    support: &ClickHouseViewRuntimeSupport,
) -> bool {
    if catalog.trim() == canonical.trim() {
        return true;
    }
    let (Ok(catalog), Ok(canonical)) = (
        parse_clickhouse_view_create(catalog, support),
        parse_clickhouse_view_create(canonical, support),
    ) else {
        return false;
    };
    catalog.family == canonical.family
        && catalog.columns == canonical.columns
        && super::view_queries_semantically_equal(&catalog.query, &canonical.query)
        && catalog.security == canonical.security
        && catalog.comment == canonical.comment
        && catalog.family_definition == canonical.family_definition
        && catalog.unknown_clauses == canonical.unknown_clauses
}

fn validate_persistent_view_container(container: &ContainerRef) -> IpcResult<(&str, &str)> {
    if !matches!(
        container.kind,
        ContainerKind::View | ContainerKind::MaterializedView
    ) || container.group_type.is_some()
        || container.schema.is_some()
        || container.column.is_some()
        || container.object_name.is_some()
        || container.db_index.is_some()
        || container.key.is_some()
        || container.pattern.is_some()
    {
        return Err(IpcError::validation_failed(
            "ClickHouse persistent View container is invalid",
        ));
    }
    let database = container
        .database
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| IpcError::validation_failed("ClickHouse View database is required"))?;
    let name = container
        .table
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| IpcError::validation_failed("ClickHouse View name is required"))?;
    Ok((database, name))
}

fn engine_matches_family(engine: &str, family: ClickHouseViewFamily) -> bool {
    matches!(
        (engine.trim().to_ascii_lowercase().as_str(), family),
        (
            "view",
            ClickHouseViewFamily::Normal | ClickHouseViewFamily::Parameterized
        ) | (
            "materializedview",
            ClickHouseViewFamily::Materialized | ClickHouseViewFamily::RefreshableMaterialized
        ) | ("windowview", ClickHouseViewFamily::Window)
            | ("liveview", ClickHouseViewFamily::Live)
    )
}

fn object_kind(family: ClickHouseViewFamily) -> ContainerKind {
    match family {
        ClickHouseViewFamily::Materialized | ClickHouseViewFamily::RefreshableMaterialized => {
            ContainerKind::MaterializedView
        }
        ClickHouseViewFamily::Normal
        | ClickHouseViewFamily::Parameterized
        | ClickHouseViewFamily::Temporary
        | ClickHouseViewFamily::Window
        | ClickHouseViewFamily::Live => ContainerKind::View,
    }
}

fn family_support(
    support: &ClickHouseViewRuntimeSupport,
    family: ClickHouseViewFamily,
) -> &ClickHouseViewFamilySupport {
    match family {
        ClickHouseViewFamily::Normal => &support.normal,
        ClickHouseViewFamily::Parameterized => &support.parameterized,
        ClickHouseViewFamily::Temporary => &support.temporary,
        ClickHouseViewFamily::Materialized => &support.materialized,
        ClickHouseViewFamily::RefreshableMaterialized => &support.refreshable_materialized,
        ClickHouseViewFamily::Window => &support.window,
        ClickHouseViewFamily::Live => &support.live,
    }
}

fn cross_check_columns(
    parsed: &ClickHouseViewColumnDefinition,
    catalog: &[ViewColumnCatalogRow],
    blockers: &mut Vec<ClickHouseSchemaBlocker>,
) {
    let conflict = match parsed {
        ClickHouseViewColumnDefinition::None => false,
        ClickHouseViewColumnDefinition::Aliases(aliases) => {
            aliases.len() != catalog.len()
                || aliases
                    .iter()
                    .zip(catalog)
                    .any(|(alias, column)| alias != &column.name)
        }
        ClickHouseViewColumnDefinition::Typed(typed) => {
            typed.len() != catalog.len()
                || typed.iter().zip(catalog).any(
                    |(ClickHouseViewTypedColumn { name, type_name }, column)| {
                        name != &column.name || type_name != &column.type_name
                    },
                )
        }
    };
    if conflict {
        blockers.push(blocker(
            "catalog_column_conflict",
            "columns",
            "ClickHouse catalog columns and canonical View columns disagree",
        ));
    }
}

pub(super) fn view_revision_hash(
    canonical_create_query: &str,
    family: ClickHouseViewFamily,
    support_revision: &str,
) -> String {
    let mut digest = Sha256::new();
    digest.update(b"nexuspilot.clickhouse.view.baseline.v1\0");
    digest.update(canonical_create_query.as_bytes());
    digest.update(b"\0");
    digest.update(format!("{family:?}").as_bytes());
    digest.update(b"\0");
    digest.update(support_revision.as_bytes());
    format!("{:x}", digest.finalize())
}

fn blocker(code: &str, path: &str, message: &str) -> ClickHouseSchemaBlocker {
    ClickHouseSchemaBlocker {
        code: code.to_string(),
        path: path.to_string(),
        message: message.to_string(),
    }
}

fn quote_identifier(identifier: &str) -> IpcResult<String> {
    if identifier.trim().is_empty() || identifier.bytes().any(|byte| byte == 0) {
        return Err(IpcError::validation_failed(
            "ClickHouse View identifier is invalid",
        ));
    }
    Ok(format!("`{}`", identifier.replace('`', "``")))
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;

    use super::*;
    use crate::engine::drivers::clickhouse::schema::{
        ClickHouseClusterDdlSupport, ClickHouseSchemaEditabilityMode, ClickHouseSupportState,
        ClickHouseViewFamilySupport, ClickHouseViewOperationSupport, ClickHouseViewRuntimeSupport,
    };
    use crate::engine::types::{ContainerKind, ContainerRef};
    use crate::error::IpcResult;

    struct FakeViewDescribeExecutor {
        object: ViewCatalogRow,
        columns: Vec<ViewColumnCatalogRow>,
        create: String,
        refresh_exists: Option<bool>,
    }

    #[async_trait]
    impl ViewDescribeExecutor for FakeViewDescribeExecutor {
        async fn object(&self, _database: &str, _name: &str) -> IpcResult<ViewCatalogRow> {
            Ok(self.object.clone())
        }

        async fn columns(
            &self,
            _database: &str,
            _name: &str,
        ) -> IpcResult<Vec<ViewColumnCatalogRow>> {
            Ok(self.columns.clone())
        }

        async fn show_create(&self, _database: &str, _name: &str) -> IpcResult<String> {
            Ok(self.create.clone())
        }

        async fn refresh_exists(&self, _database: &str, _name: &str) -> IpcResult<Option<bool>> {
            Ok(self.refresh_exists)
        }
    }

    fn support() -> ClickHouseViewRuntimeSupport {
        let operation = ClickHouseViewOperationSupport {
            state: ClickHouseSupportState::Supported,
            reason: None,
        };
        let family = ClickHouseViewFamilySupport {
            describe: operation.clone(),
            create: operation.clone(),
            alter: operation.clone(),
            rename: operation.clone(),
            drop: operation,
        };
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
                discoverable: false,
                executable: false,
                observable: false,
                drift_verifiable: false,
            },
            support_revision: "a".repeat(64),
        }
    }

    fn executor(create: &str) -> FakeViewDescribeExecutor {
        FakeViewDescribeExecutor {
            object: ViewCatalogRow {
                database: "analytics".to_string(),
                name: "events_view".to_string(),
                engine: "View".to_string(),
                uuid: Some("view-uuid".to_string()),
                create_query: create.to_string(),
            },
            columns: vec![ViewColumnCatalogRow {
                name: "tenant".to_string(),
                type_name: "UInt64".to_string(),
                position: 1,
            }],
            create: create.to_string(),
            refresh_exists: None,
        }
    }

    fn container(kind: ContainerKind) -> ContainerRef {
        ContainerRef::table(kind, "analytics", None, "events_view")
    }

    #[tokio::test]
    async fn persistent_describe_cross_checks_catalog_and_returns_real_baseline() {
        let create = "CREATE VIEW `analytics`.`events_view` (`tenant` UInt64) AS SELECT toUInt64(1) AS tenant";
        let schema = describe_persistent_view_with(
            &executor(create),
            &container(ContainerKind::View),
            &support(),
        )
        .await
        .unwrap();

        assert_eq!(schema.identity.address.name, "events_view");
        assert_eq!(schema.identity.uuid.as_deref(), Some("view-uuid"));
        assert_eq!(
            schema.editability.mode,
            ClickHouseSchemaEditabilityMode::Editable
        );
        assert_eq!(schema.baseline.canonical_create_query, create);
        assert_eq!(schema.baseline.revision_hash.len(), 64);
    }

    #[tokio::test]
    async fn persistent_describe_accepts_semantically_equal_catalog_formatting() {
        let show_create = "CREATE VIEW `analytics`.`events_view` (`tenant` UInt64) AS SELECT toUInt64(1) AS tenant";
        let mut fake = executor(show_create);
        fake.object.create_query =
            "CREATE VIEW analytics.events_view (tenant UInt64)\nAS SELECT\n  toUInt64(1) AS tenant"
                .to_string();

        let schema =
            describe_persistent_view_with(&fake, &container(ContainerKind::View), &support())
                .await
                .unwrap();

        assert_eq!(
            schema.editability.mode,
            ClickHouseSchemaEditabilityMode::Editable
        );
        assert!(!schema
            .editability
            .blockers
            .iter()
            .any(|blocker| blocker.code == "catalog_create_conflict"));
    }

    #[tokio::test]
    async fn catalog_create_conflicts_and_unknown_clauses_force_readonly() {
        let create = "CREATE LIVE VIEW `analytics`.`events_view` (`tenant` UInt64) FUTURE OPTION AS SELECT 1";
        let mut fake = executor(create);
        fake.object.engine = "MaterializedView".to_string();
        fake.object.create_query =
            "CREATE LIVE VIEW `analytics`.`events_view` AS SELECT 2".to_string();
        fake.columns[0].name = "conflicting_column".to_string();
        let schema =
            describe_persistent_view_with(&fake, &container(ContainerKind::View), &support())
                .await
                .unwrap();

        assert_eq!(
            schema.editability.mode,
            ClickHouseSchemaEditabilityMode::Readonly
        );
        assert!(schema.editability.blockers.len() >= 4);
        for code in [
            "catalog_create_conflict",
            "catalog_family_conflict",
            "catalog_column_conflict",
            "unknown_canonical_clause",
        ] {
            assert!(schema
                .editability
                .blockers
                .iter()
                .any(|blocker| blocker.code == code));
        }
        assert!(!format!("{:?}", schema.editability.blockers).contains("SELECT 1"));
    }

    #[tokio::test]
    async fn refreshable_describe_requires_view_refreshes_fact_when_catalog_is_available() {
        let create = "CREATE MATERIALIZED VIEW `analytics`.`events_view` REFRESH EVERY 1 HOUR TO `analytics`.`sink` AS SELECT 1";
        let mut fake = executor(create);
        fake.object.engine = "MaterializedView".to_string();
        fake.refresh_exists = Some(false);
        let schema = describe_persistent_view_with(
            &fake,
            &container(ContainerKind::MaterializedView),
            &support(),
        )
        .await
        .unwrap();
        assert_eq!(
            schema.editability.mode,
            ClickHouseSchemaEditabilityMode::Readonly
        );
        assert!(schema
            .editability
            .blockers
            .iter()
            .any(|blocker| blocker.code == "refresh_catalog_conflict"));
    }

    #[tokio::test]
    async fn persistent_describe_rejects_temporary_without_an_owner_session() {
        let create = "CREATE TEMPORARY VIEW `events_view` AS SELECT 1";
        let error = describe_persistent_view_with(
            &executor(create),
            &container(ContainerKind::View),
            &support(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::FeatureUnavailable);
    }
}
