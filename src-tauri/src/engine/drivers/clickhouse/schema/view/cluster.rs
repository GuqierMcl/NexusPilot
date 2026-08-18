#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};

use async_trait::async_trait;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::engine::drivers::clickhouse::ClickHouseDriver;
use crate::engine::native_schema::NativeSchemaExecutionStatus;
use crate::error::{ErrorCode, IpcError, IpcResult};

use super::{parse_clickhouse_view_create, probe_view_runtime_support};
use super::{
    ClickHouseClusterDdlSupport, ClickHouseClusterExecutionNode, ClickHouseClusterExecutionOutcome,
    ClickHouseClusterNodeExecutionState, ClickHouseClusterObjectState,
    ClickHouseClusterViewBaseline, ClickHouseClusterViewNodeBaseline, ClickHouseViewAddress,
    ClickHouseViewFamily, ClientViewSupportExecutor,
};

const TOPOLOGY_REVISION_DOMAIN: &[u8] = b"nexuspilot.clickhouse.view.cluster-topology.v1\0";
const NODE_IDENTITY_DOMAIN: &[u8] = b"nexuspilot.clickhouse.view.cluster-node.v1\0";
const BASELINE_REVISION_DOMAIN: &[u8] = b"nexuspilot.clickhouse.view.cluster-baseline.v1\0";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClusterTopologyNode {
    pub(crate) raw_identity: String,
    pub(crate) shard: u32,
    pub(crate) replica: u32,
    pub(crate) membership_revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClusterObjectFact {
    pub(crate) raw_identity: String,
    pub(crate) shard: u32,
    pub(crate) replica: u32,
    pub(crate) reachable: bool,
    pub(crate) object_state: ClickHouseClusterObjectState,
    pub(crate) family: Option<ClickHouseViewFamily>,
    pub(crate) revision_hash: Option<String>,
    pub(crate) error_code: Option<ErrorCode>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClickHouseDesiredClusterState {
    Absent,
    Present {
        family: ClickHouseViewFamily,
        revision_hash: String,
    },
}

#[async_trait]
pub(crate) trait ClusterViewExecutor: Send + Sync {
    fn mark_ddl_enqueued(&self) {}

    async fn topology(&self, cluster_name: &str) -> IpcResult<Vec<ClusterTopologyNode>>;

    async fn object_facts(
        &self,
        cluster_name: &str,
        address: &ClickHouseViewAddress,
    ) -> IpcResult<Vec<ClusterObjectFact>>;

    async fn distributed_ddl_enqueued(&self, cluster_name: &str) -> IpcResult<bool>;
}

pub(crate) struct DriverClusterViewExecutor<'a> {
    driver: &'a ClickHouseDriver,
    topology_cache: std::sync::Mutex<Option<(String, Vec<ClusterTopologyNode>)>>,
    ddl_enqueued: std::sync::atomic::AtomicBool,
}

impl<'a> DriverClusterViewExecutor<'a> {
    pub(crate) fn new(driver: &'a ClickHouseDriver) -> Self {
        Self {
            driver,
            topology_cache: std::sync::Mutex::new(None),
            ddl_enqueued: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub(crate) fn mark_ddl_enqueued(&self) {
        self.ddl_enqueued
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    async fn bounded<T, F>(&self, operation: &'static str, request: F) -> IpcResult<T>
    where
        F: std::future::Future<Output = Result<T, clickhouse::error::Error>>,
    {
        if *self.driver.shutdown.borrow() {
            return Err(IpcError::operation_canceled(
                "ClickHouse cluster View request canceled",
                format!("operation={operation}; category=shutdown_before_send"),
            ));
        }
        match tokio::time::timeout(self.driver.timeout, request).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(redact_cluster_error(
                crate::engine::drivers::clickhouse::error::classify_metadata_error(
                    error, operation,
                ),
                operation,
            )),
            Err(_) => Err(IpcError::network_timeout(
                "ClickHouse cluster View request timed out",
                format!("operation={operation}; category=timeout"),
            )),
        }
    }
}

#[derive(Debug, clickhouse::Row, Deserialize)]
struct ClientTopologyRow {
    raw_identity: String,
    shard: u32,
    replica: u32,
    port: u16,
}

#[derive(Debug, clickhouse::Row, Deserialize)]
struct ClientObjectFactRow {
    raw_identity: String,
    object_count: u64,
    create_query: String,
}

#[async_trait]
impl ClusterViewExecutor for DriverClusterViewExecutor<'_> {
    fn mark_ddl_enqueued(&self) {
        DriverClusterViewExecutor::mark_ddl_enqueued(self);
    }

    async fn topology(&self, cluster_name: &str) -> IpcResult<Vec<ClusterTopologyNode>> {
        cluster_name_literal(cluster_name)?;
        let rows = self
            .bounded(
                "read cluster topology",
                self.driver
                    .client
                    .query(
                        "SELECT host_name AS raw_identity, toUInt32(shard_num) AS shard, toUInt32(replica_num) AS replica, toUInt16(port) AS port FROM system.clusters WHERE cluster = ?",
                    )
                    .bind(cluster_name)
                    .fetch_all::<ClientTopologyRow>(),
            )
            .await?;
        let nodes = rows
            .into_iter()
            .map(|row| ClusterTopologyNode {
                membership_revision: format!("{}:{}", row.raw_identity, row.port),
                raw_identity: row.raw_identity,
                shard: row.shard,
                replica: row.replica,
            })
            .collect::<Vec<_>>();
        *self.topology_cache.lock().map_err(|_| {
            IpcError::system_internal(
                "ClickHouse cluster topology cache is unavailable",
                "operation=cluster_topology; category=lock",
            )
        })? = Some((cluster_name.to_string(), nodes.clone()));
        Ok(nodes)
    }

    async fn object_facts(
        &self,
        cluster_name: &str,
        address: &ClickHouseViewAddress,
    ) -> IpcResult<Vec<ClusterObjectFact>> {
        let database = address.database.as_deref().ok_or_else(|| {
            IpcError::validation_failed("Cluster ClickHouse View facts require a database")
        })?;
        let topology = self
            .topology_cache
            .lock()
            .map_err(|_| {
                IpcError::system_internal(
                    "ClickHouse cluster topology cache is unavailable",
                    "operation=cluster_object_facts; category=lock",
                )
            })?
            .as_ref()
            .filter(|(cached_cluster, _)| cached_cluster == cluster_name)
            .map(|(_, nodes)| nodes.clone())
            .ok_or_else(|| {
                IpcError::system_internal(
                    "ClickHouse cluster object facts require a topology snapshot",
                    "operation=cluster_object_facts; category=missing_topology",
                )
            })?;
        let literal = cluster_name_literal(cluster_name)?;
        let statement = format!(
            "SELECT hostName() AS raw_identity, countIf(database = ? AND name = ?) AS object_count, anyIf(create_table_query, database = ? AND name = ?) AS create_query FROM clusterAllReplicas({literal}, system.tables) GROUP BY raw_identity"
        );
        let rows = self
            .bounded(
                "read cluster View facts",
                self.driver
                    .client
                    .query(&statement)
                    .bind(database)
                    .bind(&address.name)
                    .bind(database)
                    .bind(&address.name)
                    .with_setting("skip_unavailable_shards", "1")
                    .fetch_all::<ClientObjectFactRow>(),
            )
            .await?;
        let support = probe_view_runtime_support(
            &ClientViewSupportExecutor::new(self.driver),
            Some(database),
        )
        .await?;
        let topology_by_identity = topology
            .into_iter()
            .map(|node| (node.raw_identity.clone(), node))
            .collect::<BTreeMap<_, _>>();
        let mut facts = Vec::with_capacity(rows.len());
        for row in rows {
            let Some(node) = topology_by_identity.get(&row.raw_identity) else {
                continue;
            };
            if row.object_count == 0 {
                facts.push(ClusterObjectFact {
                    raw_identity: row.raw_identity,
                    shard: node.shard,
                    replica: node.replica,
                    reachable: true,
                    object_state: ClickHouseClusterObjectState::Absent,
                    family: None,
                    revision_hash: None,
                    error_code: None,
                });
                continue;
            }
            match parse_clickhouse_view_create(&row.create_query, &support) {
                Ok(parsed) => facts.push(ClusterObjectFact {
                    raw_identity: row.raw_identity,
                    shard: node.shard,
                    replica: node.replica,
                    reachable: true,
                    object_state: ClickHouseClusterObjectState::Present,
                    family: Some(parsed.family),
                    revision_hash: Some(super::describe::view_revision_hash(
                        &row.create_query,
                        parsed.family,
                        &support.support_revision,
                    )),
                    error_code: None,
                }),
                Err(error) => facts.push(ClusterObjectFact {
                    raw_identity: row.raw_identity,
                    shard: node.shard,
                    replica: node.replica,
                    reachable: true,
                    object_state: ClickHouseClusterObjectState::Unknown,
                    family: None,
                    revision_hash: None,
                    error_code: Some(error.code),
                }),
            }
        }
        Ok(facts)
    }

    async fn distributed_ddl_enqueued(&self, _cluster_name: &str) -> IpcResult<bool> {
        Ok(self.ddl_enqueued.load(std::sync::atomic::Ordering::SeqCst))
    }
}

pub async fn read_cluster_baseline<E: ClusterViewExecutor>(
    executor: &E,
    cluster_name: &str,
    address: &ClickHouseViewAddress,
) -> IpcResult<ClickHouseClusterViewBaseline> {
    read_cluster_snapshot(executor, cluster_name, address)
        .await
        .map(|snapshot| snapshot.baseline)
}

pub async fn observe_cluster_outcome<E: ClusterViewExecutor>(
    executor: &E,
    expected: &ClickHouseClusterViewBaseline,
    address: &ClickHouseViewAddress,
    desired: &ClickHouseDesiredClusterState,
) -> IpcResult<ClickHouseClusterExecutionOutcome> {
    let snapshot = read_cluster_snapshot(executor, &expected.cluster_name, address).await?;
    let enqueued = executor
        .distributed_ddl_enqueued(&expected.cluster_name)
        .await?;
    let current_by_key = snapshot
        .baseline
        .nodes
        .iter()
        .map(|node| (public_node_key(node), node))
        .collect::<BTreeMap<_, _>>();
    let topology_matches = expected.topology_revision == snapshot.baseline.topology_revision;
    let mut nodes = Vec::with_capacity(expected.nodes.len());
    for expected_node in &expected.nodes {
        let key = public_node_key(expected_node);
        let (state, error_code) = if !topology_matches {
            (ClickHouseClusterNodeExecutionState::Unknown, None)
        } else if let Some(current) = current_by_key.get(&key) {
            let error = snapshot.error_codes.get(&key).copied().flatten();
            classify_observed_node(current, desired, enqueued, error)
        } else {
            (
                ClickHouseClusterNodeExecutionState::Unreachable,
                Some(ErrorCode::NetworkTimeout),
            )
        };
        nodes.push(ClickHouseClusterExecutionNode {
            node_identity_hash: expected_node.node_identity_hash.clone(),
            shard: expected_node.shard,
            replica: expected_node.replica,
            state,
            error_code,
        });
    }
    nodes.sort_by(cluster_execution_node_order);
    Ok(ClickHouseClusterExecutionOutcome {
        cluster_name: expected.cluster_name.clone(),
        expected_nodes: expected.nodes.len() as u32,
        observed_nodes: snapshot.baseline.nodes.len() as u32,
        nodes,
    })
}

pub(crate) async fn validate_cluster_before_send<E: ClusterViewExecutor>(
    executor: &E,
    expected: &ClickHouseClusterViewBaseline,
    address: &ClickHouseViewAddress,
    current_state: &ClickHouseDesiredClusterState,
) -> IpcResult<()> {
    let current = read_cluster_baseline(executor, &expected.cluster_name, address).await?;
    if &current != expected {
        return Err(IpcError::resource_conflict(
            "ClickHouse cluster topology or View definition changed after preview",
        ));
    }
    validate_cluster_baseline_for_desired(&current, current_state)
}

pub(crate) fn require_complete_cluster_support(
    support: &ClickHouseClusterDdlSupport,
) -> IpcResult<()> {
    if support.discoverable && support.executable && support.observable && support.drift_verifiable
    {
        Ok(())
    } else {
        Err(IpcError::feature_unavailable(
            "ClickHouse Cluster View execution requires complete topology, execution, observation, and drift support",
        ))
    }
}

pub(crate) fn validate_cluster_baseline_for_desired(
    baseline: &ClickHouseClusterViewBaseline,
    desired: &ClickHouseDesiredClusterState,
) -> IpcResult<()> {
    if baseline.nodes.is_empty() || baseline.nodes.iter().any(|node| !node.reachable) {
        return Err(IpcError::resource_conflict(
            "ClickHouse cluster View baseline has unreachable nodes",
        ));
    }
    let valid = match desired {
        ClickHouseDesiredClusterState::Absent => baseline.nodes.iter().all(|node| {
            node.object_state == ClickHouseClusterObjectState::Absent
                && node.family.is_none()
                && node.revision_hash.is_none()
        }),
        ClickHouseDesiredClusterState::Present {
            family,
            revision_hash,
        } => baseline.nodes.iter().all(|node| {
            node.object_state == ClickHouseClusterObjectState::Present
                && node.family == Some(*family)
                && node.revision_hash.as_deref() == Some(revision_hash.as_str())
        }),
    };
    if valid {
        Ok(())
    } else {
        Err(IpcError::resource_conflict(
            "ClickHouse cluster View baseline is incomplete or inconsistent",
        ))
    }
}

pub(crate) fn aggregate_cluster_outcome(
    outcome: &ClickHouseClusterExecutionOutcome,
    enqueue_accepted: bool,
) -> NativeSchemaExecutionStatus {
    if outcome.expected_nodes == 0 || outcome.nodes.is_empty() {
        return NativeSchemaExecutionStatus::OutcomeUnknown;
    }
    let applied = outcome
        .nodes
        .iter()
        .filter(|node| node.state == ClickHouseClusterNodeExecutionState::Applied)
        .count();
    let failed = outcome.nodes.iter().any(|node| {
        matches!(
            node.state,
            ClickHouseClusterNodeExecutionState::Failed
                | ClickHouseClusterNodeExecutionState::Unreachable
        )
    });
    let unknown = outcome
        .nodes
        .iter()
        .any(|node| node.state == ClickHouseClusterNodeExecutionState::Unknown);
    if applied == outcome.nodes.len() {
        NativeSchemaExecutionStatus::Applied
    } else if applied > 0 && failed {
        NativeSchemaExecutionStatus::PartiallyApplied
    } else if unknown {
        NativeSchemaExecutionStatus::OutcomeUnknown
    } else if enqueue_accepted
        && outcome.nodes.iter().all(|node| {
            matches!(
                node.state,
                ClickHouseClusterNodeExecutionState::Applied
                    | ClickHouseClusterNodeExecutionState::Pending
            )
        })
    {
        NativeSchemaExecutionStatus::Submitted
    } else {
        NativeSchemaExecutionStatus::OutcomeUnknown
    }
}

pub(crate) fn cluster_name_literal(cluster_name: &str) -> IpcResult<String> {
    let trimmed = cluster_name.trim();
    if trimmed.is_empty()
        || trimmed.len() > 256
        || trimmed.chars().any(|character| character.is_control())
    {
        return Err(IpcError::validation_failed(
            "ClickHouse cluster name is invalid",
        ));
    }
    let escaped = trimmed.replace('\\', "\\\\").replace('\'', "\\'");
    Ok(format!("'{escaped}'"))
}

pub(crate) fn cluster_baseline_revision(baseline: &ClickHouseClusterViewBaseline) -> String {
    let mut digest = Sha256::new();
    digest.update(BASELINE_REVISION_DOMAIN);
    digest.update(baseline.cluster_name.as_bytes());
    digest.update([0]);
    digest.update(baseline.topology_revision.as_bytes());
    for node in &baseline.nodes {
        digest.update([0]);
        digest.update(node.shard.to_be_bytes());
        digest.update(node.replica.to_be_bytes());
        digest.update(node.node_identity_hash.as_bytes());
        digest.update([u8::from(node.reachable)]);
        digest.update(format!("{:?}", node.object_state).as_bytes());
        if let Some(family) = node.family {
            digest.update(format!("{family:?}").as_bytes());
        }
        if let Some(revision) = &node.revision_hash {
            digest.update(revision.as_bytes());
        }
    }
    format!("{:x}", digest.finalize())
}

struct ClusterSnapshot {
    baseline: ClickHouseClusterViewBaseline,
    error_codes: BTreeMap<(u32, u32, String), Option<ErrorCode>>,
}

async fn read_cluster_snapshot<E: ClusterViewExecutor>(
    executor: &E,
    cluster_name: &str,
    address: &ClickHouseViewAddress,
) -> IpcResult<ClusterSnapshot> {
    cluster_name_literal(cluster_name)?;
    let mut topology = executor.topology(cluster_name).await?;
    if topology.is_empty() {
        return Err(IpcError::resource_not_found(
            "ClickHouse cluster topology is empty or unavailable",
        ));
    }
    topology.sort_by(topology_node_order);
    validate_unique_topology(&topology)?;
    let facts = executor.object_facts(cluster_name, address).await?;
    let mut facts_by_key = BTreeMap::new();
    for fact in facts {
        let key = raw_node_key(&fact.raw_identity, fact.shard, fact.replica);
        if facts_by_key.insert(key, fact).is_some() {
            return Err(IpcError::resource_conflict(
                "ClickHouse cluster returned duplicate View node facts",
            ));
        }
    }

    let topology_revision = hash_topology(cluster_name, &topology);
    let mut nodes = Vec::with_capacity(topology.len());
    let mut error_codes = BTreeMap::new();
    for topology_node in topology {
        let raw_key = raw_node_key(
            &topology_node.raw_identity,
            topology_node.shard,
            topology_node.replica,
        );
        let identity_hash = hash_node_identity(cluster_name, &topology_node);
        let public_key = (
            topology_node.shard,
            topology_node.replica,
            identity_hash.clone(),
        );
        if let Some(fact) = facts_by_key.remove(&raw_key) {
            error_codes.insert(public_key, fact.error_code);
            nodes.push(ClickHouseClusterViewNodeBaseline {
                node_identity_hash: identity_hash,
                shard: topology_node.shard,
                replica: topology_node.replica,
                reachable: fact.reachable,
                object_state: fact.object_state,
                family: fact.family,
                revision_hash: fact.revision_hash,
            });
        } else {
            error_codes.insert(public_key, Some(ErrorCode::NetworkTimeout));
            nodes.push(ClickHouseClusterViewNodeBaseline {
                node_identity_hash: identity_hash,
                shard: topology_node.shard,
                replica: topology_node.replica,
                reachable: false,
                object_state: ClickHouseClusterObjectState::Unknown,
                family: None,
                revision_hash: None,
            });
        }
    }
    nodes.sort_by(cluster_baseline_node_order);
    Ok(ClusterSnapshot {
        baseline: ClickHouseClusterViewBaseline {
            cluster_name: cluster_name.to_string(),
            topology_revision,
            nodes,
        },
        error_codes,
    })
}

fn classify_observed_node(
    node: &ClickHouseClusterViewNodeBaseline,
    desired: &ClickHouseDesiredClusterState,
    enqueue_accepted: bool,
    error_code: Option<ErrorCode>,
) -> (ClickHouseClusterNodeExecutionState, Option<ErrorCode>) {
    if !node.reachable {
        return (
            ClickHouseClusterNodeExecutionState::Unreachable,
            error_code.or(Some(ErrorCode::NetworkTimeout)),
        );
    }
    if desired_matches_node(desired, node) {
        return (ClickHouseClusterNodeExecutionState::Applied, None);
    }
    if node.object_state == ClickHouseClusterObjectState::Unknown {
        return (ClickHouseClusterNodeExecutionState::Unknown, error_code);
    }
    if let Some(error_code) = error_code {
        return (
            ClickHouseClusterNodeExecutionState::Failed,
            Some(error_code),
        );
    }
    if enqueue_accepted {
        (ClickHouseClusterNodeExecutionState::Pending, None)
    } else {
        (ClickHouseClusterNodeExecutionState::Unknown, None)
    }
}

fn desired_matches_node(
    desired: &ClickHouseDesiredClusterState,
    node: &ClickHouseClusterViewNodeBaseline,
) -> bool {
    match desired {
        ClickHouseDesiredClusterState::Absent => {
            node.object_state == ClickHouseClusterObjectState::Absent
        }
        ClickHouseDesiredClusterState::Present {
            family,
            revision_hash,
        } => {
            node.object_state == ClickHouseClusterObjectState::Present
                && node.family == Some(*family)
                && node.revision_hash.as_deref() == Some(revision_hash.as_str())
        }
    }
}

fn validate_unique_topology(topology: &[ClusterTopologyNode]) -> IpcResult<()> {
    let mut coordinates = BTreeSet::new();
    for node in topology {
        let coordinate = (node.shard, node.replica, node.raw_identity.as_str());
        if !coordinates.insert(coordinate) {
            return Err(IpcError::resource_conflict(
                "ClickHouse cluster topology contains duplicate nodes",
            ));
        }
    }
    Ok(())
}

fn hash_topology(cluster_name: &str, topology: &[ClusterTopologyNode]) -> String {
    let mut digest = Sha256::new();
    digest.update(TOPOLOGY_REVISION_DOMAIN);
    digest.update(cluster_name.as_bytes());
    for node in topology {
        digest.update([0]);
        digest.update(node.shard.to_be_bytes());
        digest.update(node.replica.to_be_bytes());
        digest.update(node.raw_identity.as_bytes());
        digest.update([0]);
        digest.update(node.membership_revision.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

fn hash_node_identity(cluster_name: &str, node: &ClusterTopologyNode) -> String {
    let mut digest = Sha256::new();
    digest.update(NODE_IDENTITY_DOMAIN);
    digest.update(cluster_name.as_bytes());
    digest.update([0]);
    digest.update(node.shard.to_be_bytes());
    digest.update(node.replica.to_be_bytes());
    digest.update(node.raw_identity.as_bytes());
    format!("{:x}", digest.finalize())
}

fn raw_node_key(identity: &str, shard: u32, replica: u32) -> (u32, u32, String) {
    (shard, replica, identity.to_string())
}

fn public_node_key(node: &ClickHouseClusterViewNodeBaseline) -> (u32, u32, String) {
    (node.shard, node.replica, node.node_identity_hash.clone())
}

fn topology_node_order(
    left: &ClusterTopologyNode,
    right: &ClusterTopologyNode,
) -> std::cmp::Ordering {
    (left.shard, left.replica, left.raw_identity.as_str()).cmp(&(
        right.shard,
        right.replica,
        right.raw_identity.as_str(),
    ))
}

fn cluster_baseline_node_order(
    left: &ClickHouseClusterViewNodeBaseline,
    right: &ClickHouseClusterViewNodeBaseline,
) -> std::cmp::Ordering {
    (left.shard, left.replica, left.node_identity_hash.as_str()).cmp(&(
        right.shard,
        right.replica,
        right.node_identity_hash.as_str(),
    ))
}

fn cluster_execution_node_order(
    left: &ClickHouseClusterExecutionNode,
    right: &ClickHouseClusterExecutionNode,
) -> std::cmp::Ordering {
    (left.shard, left.replica, left.node_identity_hash.as_str()).cmp(&(
        right.shard,
        right.replica,
        right.node_identity_hash.as_str(),
    ))
}

fn redact_cluster_error(error: IpcError, operation: &str) -> IpcError {
    IpcError {
        code: error.code,
        runtime_impact: error.runtime_impact,
        message: "ClickHouse cluster View operation failed".to_string(),
        details: Some(format!(
            "operation={operation}; category=redacted; error_code={:?}",
            error.code
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::*;
    use crate::engine::drivers::clickhouse::schema::{
        ClickHouseClusterDdlSupport, ClickHouseClusterNodeExecutionState,
        ClickHouseClusterObjectState, ClickHouseClusterViewBaseline, ClickHouseDesiredClusterState,
        ClickHouseViewAddress, ClickHouseViewFamily,
    };
    use crate::engine::native_schema::NativeSchemaExecutionStatus;
    use crate::engine::types::ContainerKind;
    use crate::error::{ErrorCode, IpcResult};

    struct FakeClusterExecutor {
        topologies: Mutex<VecDeque<Vec<ClusterTopologyNode>>>,
        facts: Mutex<VecDeque<Vec<ClusterObjectFact>>>,
        enqueue_accepted: bool,
        fact_reads: AtomicUsize,
    }

    impl FakeClusterExecutor {
        fn new(
            topologies: impl IntoIterator<Item = Vec<ClusterTopologyNode>>,
            facts: impl IntoIterator<Item = Vec<ClusterObjectFact>>,
            enqueue_accepted: bool,
        ) -> Self {
            Self {
                topologies: Mutex::new(topologies.into_iter().collect()),
                facts: Mutex::new(facts.into_iter().collect()),
                enqueue_accepted,
                fact_reads: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl ClusterViewExecutor for FakeClusterExecutor {
        async fn topology(&self, _cluster_name: &str) -> IpcResult<Vec<ClusterTopologyNode>> {
            Ok(self.topologies.lock().unwrap().pop_front().unwrap())
        }

        async fn object_facts(
            &self,
            _cluster_name: &str,
            _address: &ClickHouseViewAddress,
        ) -> IpcResult<Vec<ClusterObjectFact>> {
            self.fact_reads.fetch_add(1, Ordering::SeqCst);
            Ok(self.facts.lock().unwrap().pop_front().unwrap())
        }

        async fn distributed_ddl_enqueued(&self, _cluster_name: &str) -> IpcResult<bool> {
            Ok(self.enqueue_accepted)
        }
    }

    fn address() -> ClickHouseViewAddress {
        ClickHouseViewAddress {
            database: Some("analytics".to_string()),
            name: "events_view".to_string(),
            object_kind: ContainerKind::View,
        }
    }

    fn topology(identity: &str, shard: u32, replica: u32) -> ClusterTopologyNode {
        ClusterTopologyNode {
            raw_identity: identity.to_string(),
            shard,
            replica,
            membership_revision: format!("{identity}:8123"),
        }
    }

    fn fact(
        identity: &str,
        shard: u32,
        replica: u32,
        state: ClickHouseClusterObjectState,
        revision: Option<&str>,
    ) -> ClusterObjectFact {
        ClusterObjectFact {
            raw_identity: identity.to_string(),
            shard,
            replica,
            reachable: true,
            object_state: state,
            family: revision.map(|_| ClickHouseViewFamily::Normal),
            revision_hash: revision.map(str::to_string),
            error_code: None,
        }
    }

    fn two_nodes() -> Vec<ClusterTopologyNode> {
        vec![
            topology("node-a.internal", 1, 1),
            topology("10.0.0.8", 1, 2),
        ]
    }

    fn absent_facts() -> Vec<ClusterObjectFact> {
        vec![
            fact(
                "node-a.internal",
                1,
                1,
                ClickHouseClusterObjectState::Absent,
                None,
            ),
            fact("10.0.0.8", 1, 2, ClickHouseClusterObjectState::Absent, None),
        ]
    }

    fn present_facts(revision: &str) -> Vec<ClusterObjectFact> {
        vec![
            fact(
                "node-a.internal",
                1,
                1,
                ClickHouseClusterObjectState::Present,
                Some(revision),
            ),
            fact(
                "10.0.0.8",
                1,
                2,
                ClickHouseClusterObjectState::Present,
                Some(revision),
            ),
        ]
    }

    #[tokio::test]
    async fn cluster_baseline_is_order_stable_membership_sensitive_and_redacted() {
        let executor = FakeClusterExecutor::new(
            [two_nodes(), {
                let mut rows = two_nodes();
                rows.reverse();
                rows
            }],
            [absent_facts(), {
                let mut rows = absent_facts();
                rows.reverse();
                rows
            }],
            false,
        );
        let first = read_cluster_baseline(&executor, "analytics_cluster", &address())
            .await
            .unwrap();
        let second = read_cluster_baseline(&executor, "analytics_cluster", &address())
            .await
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(first.nodes.len(), 2);
        assert!(first
            .nodes
            .iter()
            .all(|node| node.node_identity_hash.len() == 64));

        let serialized = serde_json::to_string(&first).unwrap();
        for secret in [
            "node-a.internal",
            "10.0.0.8",
            "8123",
            "CREATE VIEW",
            "http://",
        ] {
            assert!(
                !serialized.contains(secret),
                "leaked {secret}: {serialized}"
            );
        }

        let mut changed = two_nodes();
        changed[1].membership_revision = "10.0.0.8:9440".to_string();
        let changed_executor = FakeClusterExecutor::new([changed], [absent_facts()], false);
        let changed = read_cluster_baseline(&changed_executor, "analytics_cluster", &address())
            .await
            .unwrap();
        assert_ne!(first.topology_revision, changed.topology_revision);

        assert_eq!(
            cluster_name_literal("analytics'cluster").unwrap(),
            "'analytics\\'cluster'"
        );
        assert!(cluster_name_literal("bad\ncluster").is_err());
    }

    #[test]
    fn cluster_support_and_full_node_baselines_fail_closed() {
        let complete = ClickHouseClusterDdlSupport {
            discoverable: true,
            executable: true,
            observable: true,
            drift_verifiable: true,
        };
        require_complete_cluster_support(&complete).unwrap();
        for index in 0..4 {
            let mut support = complete.clone();
            match index {
                0 => support.discoverable = false,
                1 => support.executable = false,
                2 => support.observable = false,
                _ => support.drift_verifiable = false,
            }
            assert_eq!(
                require_complete_cluster_support(&support).unwrap_err().code,
                ErrorCode::FeatureUnavailable
            );
        }

        let absent = baseline_from_public_nodes(ClickHouseClusterObjectState::Absent, None);
        validate_cluster_baseline_for_desired(&absent, &ClickHouseDesiredClusterState::Absent)
            .unwrap();
        let present =
            baseline_from_public_nodes(ClickHouseClusterObjectState::Present, Some("revision-v1"));
        validate_cluster_baseline_for_desired(
            &present,
            &ClickHouseDesiredClusterState::Present {
                family: ClickHouseViewFamily::Normal,
                revision_hash: "revision-v1".to_string(),
            },
        )
        .unwrap();

        for invalid in [
            {
                let mut value = present.clone();
                value.nodes[0].reachable = false;
                value
            },
            {
                let mut value = present.clone();
                value.nodes[0].family = Some(ClickHouseViewFamily::Live);
                value
            },
            {
                let mut value = present.clone();
                value.nodes[0].revision_hash = Some("drifted".to_string());
                value
            },
        ] {
            assert_eq!(
                validate_cluster_baseline_for_desired(
                    &invalid,
                    &ClickHouseDesiredClusterState::Present {
                        family: ClickHouseViewFamily::Normal,
                        revision_hash: "revision-v1".to_string(),
                    },
                )
                .unwrap_err()
                .code,
                ErrorCode::ResourceConflict
            );
        }
    }

    #[tokio::test]
    async fn execute_time_topology_or_definition_drift_blocks_before_send() {
        let expected_executor =
            FakeClusterExecutor::new([two_nodes()], [present_facts("revision-v1")], false);
        let expected = read_cluster_baseline(&expected_executor, "analytics_cluster", &address())
            .await
            .unwrap();

        let drifted_executor =
            FakeClusterExecutor::new([two_nodes()], [present_facts("revision-v2")], false);
        let error = validate_cluster_before_send(
            &drifted_executor,
            &expected,
            &address(),
            &ClickHouseDesiredClusterState::Present {
                family: ClickHouseViewFamily::Normal,
                revision_hash: "revision-v1".to_string(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceConflict);
        assert_eq!(drifted_executor.fact_reads.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cluster_outcomes_aggregate_applied_submitted_partial_and_unknown_without_retry() {
        let expected_executor =
            FakeClusterExecutor::new([two_nodes()], [present_facts("revision-v1")], false);
        let expected = read_cluster_baseline(&expected_executor, "analytics_cluster", &address())
            .await
            .unwrap();
        let desired = ClickHouseDesiredClusterState::Present {
            family: ClickHouseViewFamily::Normal,
            revision_hash: "revision-v2".to_string(),
        };
        let scenarios = [
            (
                present_facts("revision-v2"),
                false,
                NativeSchemaExecutionStatus::Applied,
            ),
            (
                present_facts("revision-v1"),
                true,
                NativeSchemaExecutionStatus::Submitted,
            ),
            (
                {
                    let mut facts = present_facts("revision-v2");
                    facts[1].reachable = false;
                    facts[1].object_state = ClickHouseClusterObjectState::Unknown;
                    facts[1].family = None;
                    facts[1].revision_hash = None;
                    facts[1].error_code = Some(ErrorCode::NetworkTimeout);
                    facts
                },
                true,
                NativeSchemaExecutionStatus::PartiallyApplied,
            ),
            (
                {
                    let mut facts = present_facts("revision-v1");
                    facts[0].object_state = ClickHouseClusterObjectState::Unknown;
                    facts[0].family = None;
                    facts[0].revision_hash = None;
                    facts
                },
                false,
                NativeSchemaExecutionStatus::OutcomeUnknown,
            ),
        ];

        for (facts, enqueued, expected_status) in scenarios {
            let executor = FakeClusterExecutor::new([two_nodes()], [facts], enqueued);
            let outcome = observe_cluster_outcome(&executor, &expected, &address(), &desired)
                .await
                .unwrap();
            assert_eq!(
                aggregate_cluster_outcome(&outcome, enqueued),
                expected_status
            );
            assert_eq!(executor.fact_reads.load(Ordering::SeqCst), 1);
        }

        let node = crate::engine::drivers::clickhouse::schema::ClickHouseClusterExecutionNode {
            node_identity_hash: "a".repeat(64),
            shard: 1,
            replica: 2,
            state: ClickHouseClusterNodeExecutionState::Applied,
            error_code: None,
        };
        assert_eq!(
            serde_json::to_value(node).unwrap(),
            serde_json::json!({
                "nodeIdentityHash": "a".repeat(64),
                "shard": 1,
                "replica": 2,
                "state": "applied",
                "errorCode": null
            })
        );
    }

    fn baseline_from_public_nodes(
        state: ClickHouseClusterObjectState,
        revision: Option<&str>,
    ) -> ClickHouseClusterViewBaseline {
        ClickHouseClusterViewBaseline {
            cluster_name: "analytics_cluster".to_string(),
            topology_revision: "topology-v1".to_string(),
            nodes: vec![
                crate::engine::drivers::clickhouse::schema::ClickHouseClusterViewNodeBaseline {
                    node_identity_hash: "a".repeat(64),
                    shard: 1,
                    replica: 1,
                    reachable: true,
                    object_state: state,
                    family: revision.map(|_| ClickHouseViewFamily::Normal),
                    revision_hash: revision.map(str::to_string),
                },
                crate::engine::drivers::clickhouse::schema::ClickHouseClusterViewNodeBaseline {
                    node_identity_hash: "b".repeat(64),
                    shard: 1,
                    replica: 2,
                    reachable: true,
                    object_state: state,
                    family: revision.map(|_| ClickHouseViewFamily::Normal),
                    revision_hash: revision.map(str::to_string),
                },
            ],
        }
    }
}
