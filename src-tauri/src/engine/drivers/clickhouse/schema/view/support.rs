#![allow(dead_code)]

use std::future::Future;

use async_trait::async_trait;
use clickhouse::error::Error as ClickHouseError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{IpcError, IpcResult};

use super::{
    ClickHouseClusterDdlSupport, ClickHouseSupportState, ClickHouseViewFamilySupport,
    ClickHouseViewOperationSupport, ClickHouseViewRuntimeSupport,
};
use crate::engine::drivers::clickhouse::{error::server_error_code, ClickHouseDriver};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ViewProbeState {
    Available,
    Absent,
    PermissionDenied,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ViewSupportProbeFacts {
    pub server_version: String,
    pub database_engine: Option<String>,
    pub is_cloud: bool,
    pub cluster_execution_published: bool,
    pub tables_catalog: ViewProbeState,
    pub columns_catalog: ViewProbeState,
    pub view_refreshes_catalog: ViewProbeState,
    pub clusters_catalog: ViewProbeState,
    pub distributed_ddl_queue_catalog: ViewProbeState,
    pub parameterized_views: ViewProbeState,
    pub window_views: ViewProbeState,
    pub live_views: ViewProbeState,
    pub topology_revision: Option<String>,
}

#[async_trait]
pub(crate) trait ViewSupportExecutor: Send + Sync {
    async fn probe_facts(&self, database: Option<&str>) -> IpcResult<ViewSupportProbeFacts>;
}

pub(crate) struct ClientViewSupportExecutor<'a> {
    driver: &'a ClickHouseDriver,
}

impl<'a> ClientViewSupportExecutor<'a> {
    pub(crate) fn new(driver: &'a ClickHouseDriver) -> Self {
        Self { driver }
    }

    async fn catalog_state(&self, table: &'static str) -> IpcResult<ViewProbeState> {
        let request = self
            .driver
            .client
            .query(
                "SELECT name FROM system.columns WHERE database = 'system' AND table = ? LIMIT 1",
            )
            .bind(table)
            .fetch_optional::<NameRow>();
        self.optional_row_state("inspect View support catalog", request)
            .await
    }

    async fn named_row_state(
        &self,
        sql: &'static str,
        name: &'static str,
    ) -> IpcResult<ViewProbeState> {
        let request = self
            .driver
            .client
            .query(sql)
            .bind(name)
            .fetch_optional::<NameRow>();
        self.optional_row_state("inspect View feature", request)
            .await
    }

    async fn optional_row_state<F>(
        &self,
        operation: &'static str,
        request: F,
    ) -> IpcResult<ViewProbeState>
    where
        F: Future<Output = Result<Option<NameRow>, ClickHouseError>>,
    {
        match self.run_probe(operation, request).await? {
            ProbeValue::Value(Some(_)) => Ok(ViewProbeState::Available),
            ProbeValue::Value(None) | ProbeValue::Absent => Ok(ViewProbeState::Absent),
            ProbeValue::PermissionDenied => Ok(ViewProbeState::PermissionDenied),
        }
    }

    async fn database_engine(&self, database: &str) -> IpcResult<Option<String>> {
        let request = self
            .driver
            .client
            .query("SELECT engine FROM system.databases WHERE name = ? LIMIT 1")
            .bind(database)
            .fetch_optional::<EngineRow>();
        match self
            .run_probe("inspect View database engine", request)
            .await?
        {
            ProbeValue::Value(row) => Ok(row.map(|row| row.engine)),
            ProbeValue::Absent | ProbeValue::PermissionDenied => Ok(None),
        }
    }

    async fn topology_revision(&self) -> IpcResult<Option<String>> {
        let request = self
            .driver
            .client
            .query(
                "SELECT cluster, toUInt32(shard_num) AS shard, toUInt32(replica_num) AS replica, host_name FROM system.clusters ORDER BY cluster, shard, replica, host_name",
            )
            .fetch_all::<TopologyRow>();
        match self
            .run_probe("inspect View cluster topology", request)
            .await?
        {
            ProbeValue::Value(rows) => {
                let bytes = serde_json::to_vec(&rows).map_err(|_| {
                    IpcError::system_internal(
                        "ClickHouse View topology facts could not be normalized",
                        "operation=view_topology_revision; category=serialization",
                    )
                })?;
                let mut digest = Sha256::new();
                digest.update(b"nexuspilot.clickhouse.view.topology.v1\0");
                digest.update(bytes);
                Ok(Some(format!("{:x}", digest.finalize())))
            }
            ProbeValue::Absent | ProbeValue::PermissionDenied => Ok(None),
        }
    }

    async fn run_probe<T, F>(&self, operation: &'static str, request: F) -> IpcResult<ProbeValue<T>>
    where
        F: Future<Output = Result<T, ClickHouseError>>,
    {
        if *self.driver.shutdown.borrow() {
            return Err(IpcError::operation_canceled(
                "ClickHouse View support probe canceled",
                "The runtime is closing",
            ));
        }
        let mut shutdown = self.driver.shutdown.subscribe();
        tokio::select! {
            biased;
            _ = shutdown.changed() => Err(IpcError::operation_canceled(
                "ClickHouse View support probe canceled",
                "The runtime closed while support probing was in flight",
            )),
            result = tokio::time::timeout(self.driver.timeout, request) => match result {
                Err(_) => Err(IpcError::network_timeout(
                    "ClickHouse View support probe timed out",
                    format!("operation={operation}; category=timeout"),
                )),
                Ok(Ok(value)) => Ok(ProbeValue::Value(value)),
                Ok(Err(error)) if super::super::super::error::is_permission_denied(&error) => {
                    Ok(ProbeValue::PermissionDenied)
                }
                Ok(Err(ClickHouseError::BadResponse(details)))
                    if matches!(server_error_code(&details), Some(47 | 60 | 81)) =>
                {
                    Ok(ProbeValue::Absent)
                }
                Ok(Err(error)) => Err(
                    super::super::super::error::classify_metadata_error(error, operation)
                ),
            }
        }
    }
}

#[derive(Debug)]
enum ProbeValue<T> {
    Value(T),
    Absent,
    PermissionDenied,
}

#[derive(Debug, clickhouse::Row, Deserialize)]
struct NameRow {
    name: String,
}

#[derive(Debug, clickhouse::Row, Deserialize)]
struct EngineRow {
    engine: String,
}

#[derive(Debug, clickhouse::Row, Deserialize, Serialize)]
struct TopologyRow {
    cluster: String,
    shard: u32,
    replica: u32,
    host_name: String,
}

#[async_trait]
impl ViewSupportExecutor for ClientViewSupportExecutor<'_> {
    async fn probe_facts(&self, database: Option<&str>) -> IpcResult<ViewSupportProbeFacts> {
        let tables_catalog = self.catalog_state("tables").await?;
        let columns_catalog = self.catalog_state("columns").await?;
        let view_refreshes_catalog = self.catalog_state("view_refreshes").await?;
        let clusters_catalog = self.catalog_state("clusters").await?;
        let distributed_ddl_queue_catalog = self.catalog_state("distributed_ddl_queue").await?;
        let database_engine = match database {
            Some(database) => self.database_engine(database).await?,
            None => None,
        };
        let parameterized_views =
            if server_major(&self.driver.server_version).is_some_and(|major| major >= 23) {
                ViewProbeState::Available
            } else {
                ViewProbeState::Absent
            };
        let window_setting = self
            .named_row_state(
                "SELECT name FROM system.settings WHERE name = ? LIMIT 1",
                "allow_experimental_window_view",
            )
            .await?;
        let window_function = self
            .named_row_state(
                "SELECT name FROM system.functions WHERE name = ? LIMIT 1",
                "tumble",
            )
            .await?;
        let live_views = self
            .named_row_state(
                "SELECT name FROM system.settings WHERE name = ? LIMIT 1",
                "allow_experimental_live_view",
            )
            .await?;
        let window_views = combine_probe_states(window_setting, window_function);
        let topology_revision = if clusters_catalog == ViewProbeState::Available {
            self.topology_revision().await?
        } else {
            None
        };
        let is_cloud = self
            .driver
            .server_version
            .to_ascii_lowercase()
            .contains("cloud")
            || database_engine
                .as_deref()
                .is_some_and(|engine| engine.to_ascii_lowercase().starts_with("shared"));

        Ok(ViewSupportProbeFacts {
            server_version: self.driver.server_version.clone(),
            database_engine,
            is_cloud,
            cluster_execution_published: false,
            tables_catalog,
            columns_catalog,
            view_refreshes_catalog,
            clusters_catalog,
            distributed_ddl_queue_catalog,
            parameterized_views,
            window_views,
            live_views,
            topology_revision,
        })
    }
}

fn server_major(version: &str) -> Option<u32> {
    version.split('.').next()?.parse().ok()
}

fn combine_probe_states(first: ViewProbeState, second: ViewProbeState) -> ViewProbeState {
    if matches!(first, ViewProbeState::PermissionDenied)
        || matches!(second, ViewProbeState::PermissionDenied)
    {
        ViewProbeState::PermissionDenied
    } else if matches!(first, ViewProbeState::Absent) || matches!(second, ViewProbeState::Absent) {
        ViewProbeState::Absent
    } else {
        ViewProbeState::Available
    }
}

pub(crate) async fn probe_view_runtime_support<E: ViewSupportExecutor>(
    executor: &E,
    database: Option<&str>,
) -> IpcResult<ClickHouseViewRuntimeSupport> {
    let facts = executor.probe_facts(database).await?;
    let support_revision = support_revision(&facts)?;
    let base = combine_required_catalogs(facts.tables_catalog, facts.columns_catalog);
    let normal = uniform_family_support(base.clone());
    let parameterized = create_gated_family_support(base.clone(), facts.parameterized_views, None);
    let temporary = uniform_family_support(base.clone());
    let materialized = uniform_family_support(base.clone());
    let refreshable_materialized =
        create_gated_family_support(base.clone(), facts.view_refreshes_catalog, None);
    let window = create_gated_family_support(
        base.clone(),
        facts.window_views,
        facts.is_cloud.then_some("window_view_cloud_unsupported"),
    );
    let live_removed = server_major(&facts.server_version).is_some_and(|major| major >= 26);
    let live = create_gated_family_support(
        base,
        facts.live_views,
        live_removed.then_some("live_view_removed_in_server_version"),
    );

    Ok(ClickHouseViewRuntimeSupport {
        server_version: facts.server_version,
        database_engine: facts.database_engine,
        normal,
        parameterized,
        temporary,
        materialized,
        refreshable_materialized,
        window,
        live,
        cluster_ddl: ClickHouseClusterDdlSupport {
            discoverable: facts.clusters_catalog == ViewProbeState::Available,
            executable: facts.cluster_execution_published
                && facts.clusters_catalog == ViewProbeState::Available,
            observable: facts.distributed_ddl_queue_catalog == ViewProbeState::Available,
            drift_verifiable: facts.clusters_catalog == ViewProbeState::Available,
        },
        support_revision,
    })
}

pub(crate) fn require_view_operation_support(
    support: &ClickHouseViewOperationSupport,
) -> IpcResult<()> {
    match support.state {
        ClickHouseSupportState::Supported => Ok(()),
        ClickHouseSupportState::Unsupported => Err(IpcError::feature_unavailable(
            "ClickHouse server does not support this View operation",
        )),
        ClickHouseSupportState::Unknown => Err(IpcError::permission_denied(
            "ClickHouse View operation support could not be verified with current permissions",
        )),
    }
}

fn support_revision(facts: &ViewSupportProbeFacts) -> IpcResult<String> {
    let bytes = serde_json::to_vec(facts).map_err(|_| {
        IpcError::system_internal(
            "ClickHouse View support facts could not be normalized",
            "operation=view_support_revision; category=serialization",
        )
    })?;
    let mut digest = Sha256::new();
    digest.update(b"nexuspilot.clickhouse.view.support.v1\0");
    digest.update(bytes);
    Ok(format!("{:x}", digest.finalize()))
}

fn combine_required_catalogs(
    tables: ViewProbeState,
    columns: ViewProbeState,
) -> ClickHouseViewOperationSupport {
    if matches!(tables, ViewProbeState::PermissionDenied)
        || matches!(columns, ViewProbeState::PermissionDenied)
    {
        operation_support(ClickHouseSupportState::Unknown, "permission_denied")
    } else if matches!(tables, ViewProbeState::Absent) || matches!(columns, ViewProbeState::Absent)
    {
        operation_support(
            ClickHouseSupportState::Unsupported,
            "required_catalog_absent",
        )
    } else {
        operation_support(ClickHouseSupportState::Supported, "supported")
    }
}

fn state_support(
    state: ViewProbeState,
    unsupported_reason: &'static str,
) -> ClickHouseViewOperationSupport {
    match state {
        ViewProbeState::Available => {
            operation_support(ClickHouseSupportState::Supported, "supported")
        }
        ViewProbeState::Absent => {
            operation_support(ClickHouseSupportState::Unsupported, unsupported_reason)
        }
        ViewProbeState::PermissionDenied => {
            operation_support(ClickHouseSupportState::Unknown, "permission_denied")
        }
    }
}

fn operation_support(
    state: ClickHouseSupportState,
    reason: &'static str,
) -> ClickHouseViewOperationSupport {
    ClickHouseViewOperationSupport {
        state,
        reason: (state != ClickHouseSupportState::Supported).then(|| reason.to_string()),
    }
}

fn uniform_family_support(
    operation: ClickHouseViewOperationSupport,
) -> ClickHouseViewFamilySupport {
    ClickHouseViewFamilySupport {
        describe: operation.clone(),
        create: operation.clone(),
        alter: operation.clone(),
        rename: operation.clone(),
        drop: operation,
    }
}

fn create_gated_family_support(
    base: ClickHouseViewOperationSupport,
    feature: ViewProbeState,
    forced_unsupported_reason: Option<&'static str>,
) -> ClickHouseViewFamilySupport {
    let create = if base.state != ClickHouseSupportState::Supported {
        base.clone()
    } else if let Some(reason) = forced_unsupported_reason {
        operation_support(ClickHouseSupportState::Unsupported, reason)
    } else {
        state_support(feature, "feature_absent")
    };
    ClickHouseViewFamilySupport {
        describe: base.clone(),
        create: create.clone(),
        alter: create,
        rename: base.clone(),
        drop: base,
    }
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;

    use super::*;
    use crate::engine::drivers::clickhouse::schema::ClickHouseSupportState;

    struct FakeSupportExecutor {
        facts: ViewSupportProbeFacts,
    }

    #[async_trait]
    impl ViewSupportExecutor for FakeSupportExecutor {
        async fn probe_facts(&self, _database: Option<&str>) -> IpcResult<ViewSupportProbeFacts> {
            Ok(self.facts.clone())
        }
    }

    fn facts() -> ViewSupportProbeFacts {
        ViewSupportProbeFacts {
            server_version: "25.3.1".to_string(),
            database_engine: Some("Atomic".to_string()),
            is_cloud: false,
            cluster_execution_published: false,
            tables_catalog: ViewProbeState::Available,
            columns_catalog: ViewProbeState::Available,
            view_refreshes_catalog: ViewProbeState::Available,
            clusters_catalog: ViewProbeState::Available,
            distributed_ddl_queue_catalog: ViewProbeState::Available,
            parameterized_views: ViewProbeState::Available,
            window_views: ViewProbeState::Available,
            live_views: ViewProbeState::Available,
            topology_revision: Some("topology-a".to_string()),
        }
    }

    #[tokio::test]
    async fn cluster_catalog_facts_do_not_publish_baseline_execution() {
        let support =
            probe_view_runtime_support(&FakeSupportExecutor { facts: facts() }, Some("analytics"))
                .await
                .unwrap();

        assert!(support.cluster_ddl.discoverable);
        assert!(support.cluster_ddl.observable);
        assert!(support.cluster_ddl.drift_verifiable);
        assert!(
            !support.cluster_ddl.executable,
            "the single-node baseline must not publish ON CLUSTER execution"
        );
        assert_eq!(
            crate::engine::drivers::clickhouse::schema::require_complete_cluster_support(
                &support.cluster_ddl,
            )
            .unwrap_err()
            .code,
            crate::error::ErrorCode::FeatureUnavailable,
            "Cluster preview must fail before a statement can be sent"
        );
        assert_eq!(
            support.normal.create.state,
            ClickHouseSupportState::Supported,
            "closing Cluster execution must not close Local View support"
        );
        assert_eq!(
            support.temporary.create.state,
            ClickHouseSupportState::Supported,
            "closing Cluster execution must not close Temporary View support"
        );
    }

    #[tokio::test]
    async fn cluster_execution_requires_both_product_publication_and_catalog_support() {
        let mut published = facts();
        published.cluster_execution_published = true;
        let support = probe_view_runtime_support(
            &FakeSupportExecutor { facts: published },
            Some("analytics"),
        )
        .await
        .unwrap();
        assert!(support.cluster_ddl.executable);

        let mut missing_catalog = facts();
        missing_catalog.cluster_execution_published = true;
        missing_catalog.clusters_catalog = ViewProbeState::Absent;
        let support = probe_view_runtime_support(
            &FakeSupportExecutor {
                facts: missing_catalog,
            },
            Some("analytics"),
        )
        .await
        .unwrap();
        assert!(!support.cluster_ddl.executable);
    }

    #[tokio::test]
    async fn explicit_absence_is_unsupported_while_permission_is_unknown() {
        let mut absent = facts();
        absent.parameterized_views = ViewProbeState::Absent;
        let support =
            probe_view_runtime_support(&FakeSupportExecutor { facts: absent }, Some("analytics"))
                .await
                .unwrap();
        assert_eq!(
            support.parameterized.create.state,
            ClickHouseSupportState::Unsupported
        );
        assert_eq!(
            support.window.create.state,
            ClickHouseSupportState::Supported
        );

        let mut missing_refresh_and_window = facts();
        missing_refresh_and_window.view_refreshes_catalog = ViewProbeState::Absent;
        missing_refresh_and_window.window_views = ViewProbeState::Absent;
        let support = probe_view_runtime_support(
            &FakeSupportExecutor {
                facts: missing_refresh_and_window,
            },
            Some("analytics"),
        )
        .await
        .unwrap();
        assert_eq!(
            support.refreshable_materialized.create.state,
            ClickHouseSupportState::Unsupported
        );
        assert_eq!(
            support.window.create.state,
            ClickHouseSupportState::Unsupported
        );

        let mut denied = facts();
        denied.tables_catalog = ViewProbeState::PermissionDenied;
        let support =
            probe_view_runtime_support(&FakeSupportExecutor { facts: denied }, Some("analytics"))
                .await
                .unwrap();
        assert_eq!(
            support.normal.describe.state,
            ClickHouseSupportState::Unknown
        );
        assert_eq!(
            require_view_operation_support(&support.normal.create)
                .unwrap_err()
                .code,
            crate::error::ErrorCode::PermissionDenied
        );
    }

    #[tokio::test]
    async fn cloud_window_and_removed_live_create_are_explicitly_unsupported() {
        let mut probe = facts();
        probe.is_cloud = true;
        probe.server_version = "26.5.1".to_string();
        probe.live_views = ViewProbeState::Available;
        let support =
            probe_view_runtime_support(&FakeSupportExecutor { facts: probe }, Some("analytics"))
                .await
                .unwrap();

        assert_eq!(
            support.window.create.state,
            ClickHouseSupportState::Unsupported
        );
        assert_eq!(
            support.live.create.state,
            ClickHouseSupportState::Unsupported
        );
        assert_eq!(
            support.live.describe.state,
            ClickHouseSupportState::Supported
        );
        assert_eq!(support.live.rename.state, ClickHouseSupportState::Supported);
        assert_eq!(support.live.drop.state, ClickHouseSupportState::Supported);
    }

    #[tokio::test]
    async fn support_revision_changes_with_version_engine_and_topology_only() {
        let first =
            probe_view_runtime_support(&FakeSupportExecutor { facts: facts() }, Some("analytics"))
                .await
                .unwrap();
        let second =
            probe_view_runtime_support(&FakeSupportExecutor { facts: facts() }, Some("analytics"))
                .await
                .unwrap();
        assert_eq!(first.support_revision, second.support_revision);
        assert_eq!(first.support_revision.len(), 64);

        let mut changed = facts();
        changed.topology_revision = Some("topology-b".to_string());
        let changed =
            probe_view_runtime_support(&FakeSupportExecutor { facts: changed }, Some("analytics"))
                .await
                .unwrap();
        assert_ne!(first.support_revision, changed.support_revision);

        let mut changed_engine = facts();
        changed_engine.database_engine = Some("Replicated".to_string());
        let changed_engine = probe_view_runtime_support(
            &FakeSupportExecutor {
                facts: changed_engine,
            },
            Some("analytics"),
        )
        .await
        .unwrap();
        assert_ne!(first.support_revision, changed_engine.support_revision);

        let mut changed_version = facts();
        changed_version.server_version = "25.4.1".to_string();
        let changed_version = probe_view_runtime_support(
            &FakeSupportExecutor {
                facts: changed_version,
            },
            Some("analytics"),
        )
        .await
        .unwrap();
        assert_ne!(first.support_revision, changed_version.support_revision);
    }
}
