#![allow(dead_code)]

use std::collections::BTreeMap;
use std::time::Duration;

use async_trait::async_trait;
use clickhouse::error::Error as ClickHouseError;
use serde::Deserialize;
use uuid::Uuid;

use crate::engine::drivers::clickhouse::ClickHouseDriver;
use crate::engine::native_schema::{
    NativeSchemaBackgroundWork, NativeSchemaBackgroundWorkKind, NativeSchemaBackgroundWorkState,
    NativeSchemaChangeBaseline, NativeSchemaChangeTarget, NativeSchemaExecuteChangeRequest,
    NativeSchemaExecuteCreateRequest, NativeSchemaExecutionStatus, NativeSchemaStatementProgress,
};
use crate::engine::types::{ContainerRef, SchemaMutationOperation};
use crate::error::{ErrorCode, IpcError, IpcResult};

use super::super::change_runtime::{validate_native_schema_confirmation, validate_plan_hash};
use super::validate::{validate_view_alter, validate_view_create};
use super::{
    aggregate_cluster_outcome, cluster_baseline_revision, describe_persistent_view,
    describe_temporary_view, plan_view_change, plan_view_change_with_cluster, plan_view_create,
    probe_view_runtime_support, read_cluster_baseline, validate_cluster_baseline_for_desired,
    validate_cluster_before_send, ClickHouseClusterViewBaseline, ClickHouseDesiredClusterState,
    ClickHouseViewAddress, ClickHouseViewChangeResult, ClickHouseViewChangeTarget,
    ClickHouseViewColumnDefinition, ClickHouseViewCreateResult, ClickHouseViewDefinitionTarget,
    ClickHouseViewFamily, ClickHouseViewFamilyDefinition, ClickHouseViewRuntimeSupport,
    ClickHouseViewSchema, ClickHouseViewScope, ClickHouseViewScopeTarget,
    ClientViewSupportExecutor, ClusterObjectFact, ClusterTopologyNode, ClusterViewExecutor,
    DriverClusterViewExecutor,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ViewStatementRequest {
    statement: String,
    query_id: String,
    settings: BTreeMap<String, String>,
    is_create: bool,
}

impl ViewStatementRequest {
    fn new(
        statement: String,
        planned_settings: BTreeMap<String, String>,
        timeout: Duration,
        is_create: bool,
    ) -> Self {
        let mut settings = planned_settings;
        settings.insert("wait_end_of_query".to_string(), "1".to_string());
        settings.insert(
            "max_execution_time".to_string(),
            timeout.as_secs().max(1).to_string(),
        );
        Self {
            statement,
            query_id: Uuid::new_v4().to_string(),
            settings,
            is_create,
        }
    }
}

pub(crate) enum ViewStatementOutcome {
    Acknowledged,
    Ambiguous,
    Failed(IpcError),
}

#[async_trait]
pub(crate) trait ViewExecutionExecutor: Send + Sync {
    fn timeout(&self) -> Duration;

    async fn runtime_support(
        &self,
        database: Option<&str>,
    ) -> IpcResult<ClickHouseViewRuntimeSupport>;

    async fn canonical_query(&self, query: &str) -> IpcResult<String> {
        Ok(query.to_string())
    }

    async fn describe_view(
        &self,
        address: &ClickHouseViewAddress,
        scope: &ClickHouseViewScopeTarget,
    ) -> IpcResult<Option<ClickHouseViewSchema>>;

    async fn pre_send_gate(&self, scope: &ClickHouseViewScopeTarget) -> IpcResult<()>;

    async fn execute_statement(&self, request: &ViewStatementRequest) -> ViewStatementOutcome;

    async fn background_work(
        &self,
        _schema: &ClickHouseViewSchema,
    ) -> Option<NativeSchemaBackgroundWork> {
        None
    }

    async fn record_temporary_view(&self, _name: &str, _present: bool) -> IpcResult<()> {
        Ok(())
    }
}

pub(crate) struct DriverViewExecutionExecutor<'a> {
    driver: &'a ClickHouseDriver,
    cluster: DriverClusterViewExecutor<'a>,
}

impl<'a> DriverViewExecutionExecutor<'a> {
    pub(crate) fn new(driver: &'a ClickHouseDriver) -> Self {
        Self {
            driver,
            cluster: DriverClusterViewExecutor::new(driver),
        }
    }

    async fn object_exists(
        &self,
        address: &ClickHouseViewAddress,
        scope: &ClickHouseViewScopeTarget,
    ) -> IpcResult<bool> {
        let (client, _guard) = self.driver.client_for_request().await?;
        let request = match scope {
            ClickHouseViewScopeTarget::Temporary { .. } => client
                .query("SELECT count() AS count FROM system.tables WHERE is_temporary AND name = ?")
                .bind(&address.name)
                .fetch_one::<ViewCountRow>(),
            ClickHouseViewScopeTarget::Local | ClickHouseViewScopeTarget::Cluster { .. } => {
                let database = address.database.as_deref().ok_or_else(|| {
                    IpcError::validation_failed(
                        "Persistent ClickHouse View execution requires a database",
                    )
                })?;
                client
                    .query(
                        "SELECT count() AS count FROM system.tables WHERE database = ? AND name = ?",
                    )
                    .bind(database)
                    .bind(&address.name)
                    .fetch_one::<ViewCountRow>()
            }
        };
        match tokio::time::timeout(self.driver.timeout, request).await {
            Ok(Ok(row)) => Ok(row.count > 0),
            Ok(Err(error)) => Err(
                crate::engine::drivers::clickhouse::error::classify_metadata_error(
                    error,
                    "verify View existence",
                ),
            ),
            Err(_) => Err(IpcError::network_timeout(
                "ClickHouse View existence check timed out",
                "operation=view_exists; category=timeout",
            )),
        }
    }

    async fn refresh_background_work(
        &self,
        schema: &ClickHouseViewSchema,
    ) -> NativeSchemaBackgroundWork {
        let Some(database) = schema.identity.address.database.as_deref() else {
            return background(
                NativeSchemaBackgroundWorkKind::InitialRefresh,
                NativeSchemaBackgroundWorkState::Unknown,
            );
        };
        let request = self
            .driver
            .client
            .query(
                "SELECT toString(status) AS status FROM system.view_refreshes WHERE database = ? AND view = ? LIMIT 1",
            )
            .bind(database)
            .bind(&schema.identity.address.name)
            .fetch_optional::<ViewRefreshStatusRow>();
        let state = match tokio::time::timeout(self.driver.timeout, request).await {
            Ok(Ok(Some(row))) => map_refresh_state(&row.status),
            _ => NativeSchemaBackgroundWorkState::Unknown,
        };
        background(NativeSchemaBackgroundWorkKind::InitialRefresh, state)
    }
}

#[derive(Debug, clickhouse::Row, Deserialize)]
struct ViewCountRow {
    count: u64,
}

#[derive(Debug, clickhouse::Row, Deserialize)]
struct ViewRefreshStatusRow {
    status: String,
}

#[derive(Debug, clickhouse::Row, Deserialize)]
struct ExplainSyntaxRow {
    explain: String,
}

#[async_trait]
impl ViewExecutionExecutor for DriverViewExecutionExecutor<'_> {
    fn timeout(&self) -> Duration {
        self.driver.timeout
    }

    async fn runtime_support(
        &self,
        database: Option<&str>,
    ) -> IpcResult<ClickHouseViewRuntimeSupport> {
        probe_view_runtime_support(&ClientViewSupportExecutor::new(self.driver), database).await
    }

    async fn canonical_query(&self, query: &str) -> IpcResult<String> {
        let (client, _guard) = self.driver.client_for_request().await?;
        let sql = format!("EXPLAIN SYNTAX {query}");
        let request = client.query(&sql).fetch_all::<ExplainSyntaxRow>();
        match tokio::time::timeout(self.driver.timeout, request).await {
            Ok(Ok(rows)) if !rows.is_empty() => Ok(rows
                .into_iter()
                .map(|row| row.explain)
                .collect::<Vec<_>>()
                .join("\n")),
            Ok(Ok(_)) => Err(IpcError::system_internal(
                "ClickHouse View query canonicalization returned no facts",
                "operation=view_query_canonicalization; category=empty",
            )),
            Ok(Err(error)) => Err(
                crate::engine::drivers::clickhouse::error::classify_metadata_error(
                    error,
                    "canonicalize View query",
                ),
            ),
            Err(_) => Err(IpcError::network_timeout(
                "ClickHouse View query canonicalization timed out",
                "operation=view_query_canonicalization; category=timeout",
            )),
        }
    }

    async fn describe_view(
        &self,
        address: &ClickHouseViewAddress,
        scope: &ClickHouseViewScopeTarget,
    ) -> IpcResult<Option<ClickHouseViewSchema>> {
        if !self.object_exists(address, scope).await? {
            return Ok(None);
        }
        let container = container_for_address(address);
        match scope {
            ClickHouseViewScopeTarget::Temporary {
                owner_tab_runtime_id,
            } => describe_temporary_view(self.driver, owner_tab_runtime_id, &container)
                .await
                .map(Some),
            ClickHouseViewScopeTarget::Local | ClickHouseViewScopeTarget::Cluster { .. } => {
                describe_persistent_view(self.driver, &container)
                    .await
                    .map(Some)
            }
        }
    }

    async fn pre_send_gate(&self, scope: &ClickHouseViewScopeTarget) -> IpcResult<()> {
        if *self.driver.shutdown.borrow() {
            return Err(IpcError::operation_canceled(
                "ClickHouse View execution canceled before send",
                "operation=view_execute; category=shutdown_before_send",
            ));
        }
        match scope {
            ClickHouseViewScopeTarget::Temporary {
                owner_tab_runtime_id,
            } => self
                .driver
                .session_for_owner(owner_tab_runtime_id)
                .and_then(|session| session.ensure_active(owner_tab_runtime_id)),
            ClickHouseViewScopeTarget::Local => Ok(()),
            ClickHouseViewScopeTarget::Cluster { .. } => Ok(()),
        }
    }

    async fn execute_statement(&self, request: &ViewStatementRequest) -> ViewStatementOutcome {
        if *self.driver.shutdown.borrow() {
            return ViewStatementOutcome::Failed(IpcError::operation_canceled(
                "ClickHouse View execution canceled before send",
                "operation=view_execute; category=shutdown_before_send",
            ));
        }
        let (client, _guard) =
            match tokio::time::timeout(self.driver.timeout, self.driver.client_for_request()).await
            {
                Ok(Ok(client)) => client,
                Ok(Err(error)) => return ViewStatementOutcome::Failed(error),
                Err(_) => {
                    return ViewStatementOutcome::Failed(IpcError::operation_timeout(
                        "ClickHouse View execution did not start before its deadline",
                        "operation=view_execute; category=pre_send_timeout",
                    ));
                }
            };

        let mut query = client
            .query(&request.statement)
            .with_setting("query_id", &request.query_id);
        for (name, value) in &request.settings {
            query = query.with_setting(name, value);
        }
        let response = tokio::time::timeout(self.driver.timeout, query.execute()).await;
        match response {
            Err(_) => ViewStatementOutcome::Ambiguous,
            Ok(Ok(())) => ViewStatementOutcome::Acknowledged,
            Ok(Err(ClickHouseError::Network(_) | ClickHouseError::TimedOut)) => {
                ViewStatementOutcome::Ambiguous
            }
            Ok(Err(error)) => {
                let error = if request.is_create {
                    crate::engine::drivers::clickhouse::error::classify_schema_create_error(
                        error,
                        "create View",
                    )
                } else {
                    crate::engine::drivers::clickhouse::error::classify_schema_change_error(
                        error,
                        "change View",
                    )
                };
                ViewStatementOutcome::Failed(error)
            }
        }
    }

    async fn background_work(
        &self,
        schema: &ClickHouseViewSchema,
    ) -> Option<NativeSchemaBackgroundWork> {
        match &schema.family_definition {
            ClickHouseViewFamilyDefinition::RefreshableMaterialized { .. } => {
                Some(self.refresh_background_work(schema).await)
            }
            ClickHouseViewFamilyDefinition::Materialized { populate: true, .. } => {
                Some(background(
                    NativeSchemaBackgroundWorkKind::Populate,
                    NativeSchemaBackgroundWorkState::Unknown,
                ))
            }
            ClickHouseViewFamilyDefinition::Window { populate: true, .. } => Some(background(
                NativeSchemaBackgroundWorkKind::WindowInitialization,
                NativeSchemaBackgroundWorkState::Unknown,
            )),
            _ => None,
        }
    }

    async fn record_temporary_view(&self, name: &str, present: bool) -> IpcResult<()> {
        let Some(owner) = self.driver.owner_tab_runtime_id() else {
            return Err(IpcError::resource_not_found(
                "ClickHouse Temporary View requires an active owner tab runtime",
            ));
        };
        let session = self.driver.session_for_owner(owner)?;
        if present {
            session.register_view(name).await
        } else {
            session.remove_view(name).await
        }
    }
}

#[async_trait]
impl ClusterViewExecutor for DriverViewExecutionExecutor<'_> {
    fn mark_ddl_enqueued(&self) {
        self.cluster.mark_ddl_enqueued();
    }

    async fn topology(&self, cluster_name: &str) -> IpcResult<Vec<ClusterTopologyNode>> {
        self.cluster.topology(cluster_name).await
    }

    async fn object_facts(
        &self,
        cluster_name: &str,
        address: &ClickHouseViewAddress,
    ) -> IpcResult<Vec<ClusterObjectFact>> {
        self.cluster.object_facts(cluster_name, address).await
    }

    async fn distributed_ddl_enqueued(&self, cluster_name: &str) -> IpcResult<bool> {
        self.cluster.distributed_ddl_enqueued(cluster_name).await
    }
}

pub async fn execute_view_create<E: ViewExecutionExecutor>(
    executor: &E,
    request: &NativeSchemaExecuteCreateRequest,
) -> IpcResult<ClickHouseViewCreateResult> {
    let crate::engine::native_schema::NativeSchemaCreateTarget::ClickHouseView(target) =
        &request.target
    else {
        return Err(IpcError::validation_failed(
            "ClickHouse View create executor requires a View target",
        ));
    };
    ensure_local_or_temporary_scope(&target.desired.scope)?;
    if request.baseline.is_some() {
        return Err(IpcError::validation_failed(
            "Local ClickHouse View create must not include a cluster baseline",
        ));
    }
    let support = executor
        .runtime_support(target.desired.address.database.as_deref())
        .await
        .map_err(|error| redact_external_error(error, "view_support"))?;
    let preview = plan_view_create(target, &support, None)?;
    validate_plan_hash(&preview.plan_hash, &request.expected_plan_hash)?;
    validate_native_schema_confirmation(
        preview.required_confirmation,
        request.confirmation.as_ref(),
        &target.desired.address.name,
        cluster_name_from_target_scope(&target.desired.scope),
    )?;
    let desired = validate_view_create(target, &support, None)?;
    let current = executor
        .describe_view(&target.desired.address, &target.desired.scope)
        .await
        .map_err(|error| redact_external_error(error, "view_create_baseline"))?;
    if current.is_some() {
        return Err(IpcError::resource_conflict(
            "ClickHouse View create target already exists",
        ));
    }
    executor
        .pre_send_gate(&target.desired.scope)
        .await
        .map_err(|error| redact_external_error(error, "view_pre_send"))?;

    let mut progress = NativeSchemaStatementProgress {
        applied_count: 0,
        failed_statement_index: None,
        remaining_count: preview.statements.len() as u32,
        query_ids: Vec::with_capacity(preview.statements.len()),
    };
    let mut ambiguous = false;
    for (index, statement) in preview.statements.iter().enumerate() {
        let command = ViewStatementRequest::new(
            statement.clone(),
            planned_settings(target.desired.family),
            executor.timeout(),
            true,
        );
        let query_id = command.query_id.clone();
        match executor.execute_statement(&command).await {
            ViewStatementOutcome::Acknowledged => {
                progress.applied_count += 1;
                progress.query_ids.push(query_id);
                progress.remaining_count = preview.statements.len() as u32 - progress.applied_count;
                if target.desired.family == ClickHouseViewFamily::Temporary
                    && executor
                        .record_temporary_view(&target.desired.address.name, true)
                        .await
                        .is_err()
                {
                    ambiguous = true;
                    break;
                }
            }
            ViewStatementOutcome::Ambiguous => {
                progress.query_ids.push(query_id);
                progress.remaining_count = preview.statements.len() as u32 - index as u32 - 1;
                ambiguous = true;
                break;
            }
            ViewStatementOutcome::Failed(error) => {
                progress.query_ids.push(query_id);
                progress.failed_statement_index = Some(index as u32);
                progress.remaining_count = preview.statements.len() as u32 - index as u32 - 1;
                return Err(redact_external_error(error, "view_create_statement"));
            }
        }
    }

    let actual = executor
        .describe_view(&target.desired.address, &target.desired.scope)
        .await
        .ok()
        .flatten();
    let applied = actual
        .as_ref()
        .is_some_and(|schema| view_schema_matches_target(schema, &desired));
    if applied {
        progress.applied_count = preview.statements.len() as u32;
        progress.failed_statement_index = None;
        progress.remaining_count = 0;
    }
    let background_work = match actual.as_ref() {
        Some(schema) => executor.background_work(schema).await,
        None => None,
    };
    let _ = ambiguous;
    Ok(ClickHouseViewCreateResult {
        status: if applied {
            NativeSchemaExecutionStatus::Applied
        } else {
            NativeSchemaExecutionStatus::OutcomeUnknown
        },
        progress,
        container: container_for_address(&target.desired.address),
        schema: actual,
        background_work,
        cluster_outcome: None,
    })
}

pub async fn execute_cluster_view_create<E>(
    executor: &E,
    request: &NativeSchemaExecuteCreateRequest,
    expected_baseline: &ClickHouseClusterViewBaseline,
) -> IpcResult<ClickHouseViewCreateResult>
where
    E: ViewExecutionExecutor + ClusterViewExecutor,
{
    let crate::engine::native_schema::NativeSchemaCreateTarget::ClickHouseView(target) =
        &request.target
    else {
        return Err(IpcError::validation_failed(
            "ClickHouse Cluster View create executor requires a View target",
        ));
    };
    let ClickHouseViewScopeTarget::Cluster { cluster_name } = &target.desired.scope else {
        return Err(IpcError::validation_failed(
            "ClickHouse Cluster View create executor requires a cluster scope",
        ));
    };
    if expected_baseline.cluster_name != *cluster_name {
        return Err(IpcError::resource_conflict(
            "ClickHouse Cluster View create baseline targets a different cluster",
        ));
    }
    let Some(NativeSchemaChangeBaseline::ClickHouseClusterView(request_baseline)) =
        &request.baseline
    else {
        return Err(IpcError::validation_failed(
            "ClickHouse Cluster View create requires a full node baseline",
        ));
    };
    if request_baseline.as_ref() != expected_baseline {
        return Err(IpcError::resource_conflict(
            "ClickHouse Cluster View create request baseline changed after preview",
        ));
    }
    let support = executor
        .runtime_support(target.desired.address.database.as_deref())
        .await
        .map_err(|error| redact_external_error(error, "cluster_view_support"))?;
    super::require_complete_cluster_support(&support.cluster_ddl)?;
    let preview = plan_view_create(target, &support, Some(expected_baseline))?;
    validate_plan_hash(&preview.plan_hash, &request.expected_plan_hash)?;
    validate_native_schema_confirmation(
        preview.required_confirmation,
        request.confirmation.as_ref(),
        &target.desired.address.name,
        Some(cluster_name),
    )?;
    let desired = validate_view_create(target, &support, Some(expected_baseline))?;
    validate_cluster_baseline_for_desired(
        expected_baseline,
        &ClickHouseDesiredClusterState::Absent,
    )?;
    validate_cluster_before_send(
        executor,
        expected_baseline,
        &target.desired.address,
        &ClickHouseDesiredClusterState::Absent,
    )
    .await?;
    executor
        .pre_send_gate(&target.desired.scope)
        .await
        .map_err(|error| redact_external_error(error, "cluster_view_pre_send"))?;

    let [statement] = preview.statements.as_slice() else {
        return Err(IpcError::system_internal(
            "ClickHouse Cluster View create plan must contain exactly one statement",
            "operation=cluster_view_create; category=statement_count",
        ));
    };
    let command = ViewStatementRequest::new(
        statement.clone(),
        planned_settings(target.desired.family),
        executor.timeout(),
        true,
    );
    let acknowledged = match executor.execute_statement(&command).await {
        ViewStatementOutcome::Acknowledged => {
            executor.mark_ddl_enqueued();
            true
        }
        ViewStatementOutcome::Ambiguous => false,
        ViewStatementOutcome::Failed(error) => {
            return Err(redact_external_error(
                error,
                "cluster_view_create_statement",
            ));
        }
    };

    let actual = executor
        .describe_view(&target.desired.address, &target.desired.scope)
        .await
        .ok()
        .flatten();
    let desired_revision = actual
        .as_ref()
        .filter(|schema| view_schema_matches_target(schema, &desired))
        .map(|schema| schema.baseline.revision_hash.clone())
        .unwrap_or_else(|| "unverified-target-revision".to_string());
    let cluster_desired = ClickHouseDesiredClusterState::Present {
        family: target.desired.family,
        revision_hash: desired_revision,
    };
    let cluster_outcome = super::observe_cluster_outcome(
        executor,
        expected_baseline,
        &target.desired.address,
        &cluster_desired,
    )
    .await?;
    let enqueue_accepted = executor.distributed_ddl_enqueued(cluster_name).await?;
    let status = aggregate_cluster_outcome(&cluster_outcome, enqueue_accepted);
    let background_work = match actual.as_ref() {
        Some(schema) => executor.background_work(schema).await,
        None => None,
    };
    Ok(ClickHouseViewCreateResult {
        status,
        progress: NativeSchemaStatementProgress {
            applied_count: u32::from(acknowledged),
            failed_statement_index: None,
            remaining_count: 0,
            query_ids: vec![command.query_id],
        },
        container: container_for_address(&target.desired.address),
        schema: actual,
        background_work,
        cluster_outcome: Some(cluster_outcome),
    })
}

pub async fn execute_cluster_view_change<E>(
    executor: &E,
    request: &NativeSchemaExecuteChangeRequest,
    expected_baseline: &ClickHouseClusterViewBaseline,
) -> IpcResult<ClickHouseViewChangeResult>
where
    E: ViewExecutionExecutor + ClusterViewExecutor,
{
    let target = typed_change_target(&request.target)?;
    let baseline = target_baseline(&target);
    let ClickHouseViewScope::Cluster { cluster_name } = &baseline.scope else {
        return Err(IpcError::validation_failed(
            "ClickHouse Cluster View change executor requires a cluster scope",
        ));
    };
    let NativeSchemaChangeBaseline::ClickHouseClusterView(request_baseline) = &request.baseline
    else {
        return Err(IpcError::validation_failed(
            "ClickHouse Cluster View change requires a full node baseline",
        ));
    };
    if request_baseline.as_ref() != expected_baseline
        || expected_baseline.cluster_name != *cluster_name
    {
        return Err(IpcError::resource_conflict(
            "ClickHouse Cluster View request baseline does not match its target",
        ));
    }
    let support = executor
        .runtime_support(baseline.identity.address.database.as_deref())
        .await
        .map_err(|error| redact_external_error(error, "cluster_view_support"))?;
    super::require_complete_cluster_support(&support.cluster_ddl)?;
    let plan = plan_view_change_with_cluster(&target, &support, Some(expected_baseline))?;
    validate_plan_hash(&plan.plan_hash, &request.expected_plan_hash)?;
    validate_native_schema_confirmation(
        plan.required_confirmation,
        request.confirmation.as_ref(),
        &baseline.identity.address.name,
        Some(cluster_name),
    )?;
    validate_cluster_baseline_for_desired(
        expected_baseline,
        &ClickHouseDesiredClusterState::Present {
            family: baseline.family,
            revision_hash: baseline.baseline.revision_hash.clone(),
        },
    )?;
    validate_cluster_before_send(
        executor,
        expected_baseline,
        &baseline.identity.address,
        &ClickHouseDesiredClusterState::Present {
            family: baseline.family,
            revision_hash: baseline.baseline.revision_hash.clone(),
        },
    )
    .await?;
    if let ClickHouseViewChangeTarget::Rename(rename) = &target {
        let destination =
            read_cluster_baseline(executor, cluster_name, &rename.destination).await?;
        validate_cluster_baseline_for_desired(
            &destination,
            &ClickHouseDesiredClusterState::Absent,
        )?;
        if cluster_baseline_revision(&destination) != rename.expected_destination_absence_revision {
            return Err(IpcError::resource_conflict(
                "ClickHouse Cluster View Rename destination changed after preview",
            ));
        }
    }
    executor
        .pre_send_gate(&scope_target_from_schema(&baseline.scope))
        .await
        .map_err(|error| redact_external_error(error, "cluster_view_pre_send"))?;

    let mut progress = NativeSchemaStatementProgress {
        applied_count: 0,
        failed_statement_index: None,
        remaining_count: plan.statements.len() as u32,
        query_ids: Vec::with_capacity(plan.statements.len()),
    };
    for (index, statement) in plan.statements.iter().enumerate() {
        let command = ViewStatementRequest::new(
            statement.clone(),
            planned_settings(baseline.family),
            executor.timeout(),
            false,
        );
        progress.query_ids.push(command.query_id.clone());
        match executor.execute_statement(&command).await {
            ViewStatementOutcome::Acknowledged => {
                progress.applied_count += 1;
                progress.remaining_count = plan.statements.len() as u32 - progress.applied_count;
                executor.mark_ddl_enqueued();
            }
            ViewStatementOutcome::Ambiguous => {
                progress.remaining_count = plan.statements.len() as u32 - index as u32 - 1;
                break;
            }
            ViewStatementOutcome::Failed(error) if progress.applied_count == 0 => {
                return Err(redact_external_error(
                    error,
                    "cluster_view_change_statement",
                ));
            }
            ViewStatementOutcome::Failed(_) => {
                progress.failed_statement_index = Some(index as u32);
                progress.remaining_count = plan.statements.len() as u32 - index as u32 - 1;
                break;
            }
        }
    }

    let operation = change_operation(&target);
    let outcome_address = change_destination(&target).unwrap_or(&baseline.identity.address);
    let scope = scope_target_from_schema(&baseline.scope);
    let actual = if operation == SchemaMutationOperation::Drop {
        None
    } else {
        executor
            .describe_view(outcome_address, &scope)
            .await
            .ok()
            .flatten()
    };
    let desired = match operation {
        SchemaMutationOperation::Drop => ClickHouseDesiredClusterState::Absent,
        SchemaMutationOperation::Alter | SchemaMutationOperation::Rename => {
            ClickHouseDesiredClusterState::Present {
                family: baseline.family,
                revision_hash: actual
                    .as_ref()
                    .map(|schema| schema.baseline.revision_hash.clone())
                    .unwrap_or_else(|| "unverified-target-revision".to_string()),
            }
        }
        _ => unreachable!("View change operation is exact"),
    };
    let cluster_outcome =
        super::observe_cluster_outcome(executor, expected_baseline, outcome_address, &desired)
            .await?;
    let enqueue_accepted = executor.distributed_ddl_enqueued(cluster_name).await?;
    let status = aggregate_cluster_outcome(&cluster_outcome, enqueue_accepted);
    let background_work = match actual.as_ref() {
        Some(schema) => executor.background_work(schema).await,
        None => None,
    };
    Ok(ClickHouseViewChangeResult {
        status,
        progress,
        operation,
        source: container_for_address(&baseline.identity.address),
        destination: change_destination(&target).map(container_for_address),
        schema: actual,
        background_work,
        cluster_outcome: Some(cluster_outcome),
    })
}

pub async fn execute_view_change<E: ViewExecutionExecutor>(
    executor: &E,
    request: &NativeSchemaExecuteChangeRequest,
) -> IpcResult<ClickHouseViewChangeResult> {
    let target = typed_change_target(&request.target)?;
    let baseline = target_baseline(&target);
    let scope = scope_target_from_schema(&baseline.scope);
    ensure_local_or_temporary_scope(&scope)?;
    validate_request_view_baseline(&request.baseline, baseline)?;

    let support = executor
        .runtime_support(baseline.identity.address.database.as_deref())
        .await
        .map_err(|error| redact_external_error(error, "view_support"))?;
    let plan = plan_view_change(&target, &support)?;
    validate_plan_hash(&plan.plan_hash, &request.expected_plan_hash)?;
    validate_native_schema_confirmation(
        plan.required_confirmation,
        request.confirmation.as_ref(),
        &baseline.identity.address.name,
        cluster_name_from_schema_scope(&baseline.scope),
    )?;

    let mut normalized_desired = match &target {
        ClickHouseViewChangeTarget::Alter(target) => Some(validate_view_alter(target, &support)?),
        ClickHouseViewChangeTarget::Rename(_) | ClickHouseViewChangeTarget::Drop(_) => None,
    };
    if let (ClickHouseViewChangeTarget::Alter(target), Some(desired)) =
        (&target, normalized_desired.as_mut())
    {
        if target.baseline.family != ClickHouseViewFamily::Parameterized
            && !super::view_queries_semantically_equal(&target.baseline.query, &desired.query)
        {
            desired.query = executor
                .canonical_query(&desired.query)
                .await
                .map_err(|error| redact_external_error(error, "view_query_canonicalization"))?;
        }
    }
    let current = executor
        .describe_view(&baseline.identity.address, &scope)
        .await
        .map_err(|error| redact_external_error(error, "view_change_baseline"))?;
    if current.as_ref() != Some(baseline) {
        return Err(IpcError::resource_conflict(
            "ClickHouse View changed after preview; refresh facts before applying",
        ));
    }
    if let ClickHouseViewChangeTarget::Rename(target) = &target {
        let destination = executor
            .describe_view(&target.destination, &scope)
            .await
            .map_err(|error| redact_external_error(error, "view_rename_destination"))?;
        if destination.is_some() {
            return Err(IpcError::resource_conflict(
                "ClickHouse View Rename destination is no longer absent",
            ));
        }
    }
    executor
        .pre_send_gate(&scope)
        .await
        .map_err(|error| redact_external_error(error, "view_pre_send"))?;

    let operation = change_operation(&target);
    let mut progress = NativeSchemaStatementProgress {
        applied_count: 0,
        failed_statement_index: None,
        remaining_count: plan.statements.len() as u32,
        query_ids: Vec::with_capacity(plan.statements.len()),
    };
    let mut terminal_error = None;
    let mut ambiguous = false;
    for (index, statement) in plan.statements.iter().enumerate() {
        let command = ViewStatementRequest::new(
            statement.clone(),
            planned_settings(baseline.family),
            executor.timeout(),
            false,
        );
        let query_id = command.query_id.clone();
        match executor.execute_statement(&command).await {
            ViewStatementOutcome::Acknowledged => {
                progress.applied_count += 1;
                progress.query_ids.push(query_id);
                progress.remaining_count = plan.statements.len() as u32 - progress.applied_count;
                if let Some(present) = temporary_presence_after_statement(&target, index) {
                    if executor
                        .record_temporary_view(&baseline.identity.address.name, present)
                        .await
                        .is_err()
                    {
                        ambiguous = true;
                        break;
                    }
                }
            }
            ViewStatementOutcome::Ambiguous => {
                progress.query_ids.push(query_id);
                progress.remaining_count = plan.statements.len() as u32 - index as u32 - 1;
                ambiguous = true;
                break;
            }
            ViewStatementOutcome::Failed(error) => {
                progress.query_ids.push(query_id);
                progress.failed_statement_index = Some(index as u32);
                progress.remaining_count = plan.statements.len() as u32 - index as u32 - 1;
                if progress.applied_count == 0 {
                    return Err(redact_external_error(error, "view_change_statement"));
                }
                terminal_error = Some(error);
                break;
            }
        }
    }

    let post = post_change_facts(executor, &target, &scope).await;
    let proof = evaluate_change_proof(&target, normalized_desired.as_ref(), &post);
    let status = if proof.applied {
        progress.applied_count = plan.statements.len() as u32;
        progress.failed_statement_index = None;
        progress.remaining_count = 0;
        NativeSchemaExecutionStatus::Applied
    } else if progress.applied_count > 0 && plan.statements.len() > 1 {
        NativeSchemaExecutionStatus::PartiallyApplied
    } else {
        NativeSchemaExecutionStatus::OutcomeUnknown
    };
    debug_assert!(
        proof.applied
            || ambiguous
            || terminal_error.is_some()
            || progress.applied_count == plan.statements.len() as u32
    );
    let background_work = match proof.schema.as_ref() {
        Some(schema) => executor.background_work(schema).await,
        None => None,
    };
    Ok(ClickHouseViewChangeResult {
        status,
        progress,
        operation,
        source: container_for_address(&baseline.identity.address),
        destination: change_destination(&target).map(container_for_address),
        schema: proof.schema,
        background_work,
        cluster_outcome: None,
    })
}

fn typed_change_target(target: &NativeSchemaChangeTarget) -> IpcResult<ClickHouseViewChangeTarget> {
    match target {
        NativeSchemaChangeTarget::ClickHouseViewAlter(target) => {
            Ok(ClickHouseViewChangeTarget::Alter(target.clone()))
        }
        NativeSchemaChangeTarget::ClickHouseViewRename(target) => {
            Ok(ClickHouseViewChangeTarget::Rename(target.clone()))
        }
        NativeSchemaChangeTarget::ClickHouseViewDrop(target) => {
            Ok(ClickHouseViewChangeTarget::Drop(target.clone()))
        }
        _ => Err(IpcError::validation_failed(
            "ClickHouse View change executor requires a View change target",
        )),
    }
}

fn target_baseline(target: &ClickHouseViewChangeTarget) -> &ClickHouseViewSchema {
    match target {
        ClickHouseViewChangeTarget::Alter(target) => &target.baseline,
        ClickHouseViewChangeTarget::Rename(target) => &target.baseline,
        ClickHouseViewChangeTarget::Drop(target) => &target.baseline,
    }
}

fn validate_request_view_baseline(
    baseline: &NativeSchemaChangeBaseline,
    target: &ClickHouseViewSchema,
) -> IpcResult<()> {
    let NativeSchemaChangeBaseline::ClickHouseView(request) = baseline else {
        return Err(IpcError::validation_failed(
            "ClickHouse View change requires a View baseline",
        ));
    };
    if request.as_ref() != target {
        return Err(IpcError::resource_conflict(
            "ClickHouse View request baseline does not match its target",
        ));
    }
    Ok(())
}

fn ensure_local_or_temporary_scope(scope: &ClickHouseViewScopeTarget) -> IpcResult<()> {
    match scope {
        ClickHouseViewScopeTarget::Local | ClickHouseViewScopeTarget::Temporary { .. } => Ok(()),
        ClickHouseViewScopeTarget::Cluster { .. } => Err(IpcError::feature_unavailable(
            "ClickHouse Cluster View execution is not published",
        )),
    }
}

fn planned_settings(family: ClickHouseViewFamily) -> BTreeMap<String, String> {
    if family == ClickHouseViewFamily::Window {
        BTreeMap::from([(
            "allow_experimental_window_view".to_string(),
            "1".to_string(),
        )])
    } else {
        BTreeMap::new()
    }
}

fn container_for_address(address: &ClickHouseViewAddress) -> ContainerRef {
    ContainerRef {
        kind: address.object_kind.clone(),
        group_type: None,
        database: address.database.clone(),
        schema: None,
        table: Some(address.name.clone()),
        column: None,
        object_name: None,
        db_index: None,
        key: None,
        pattern: None,
    }
}

fn scope_target_from_schema(scope: &ClickHouseViewScope) -> ClickHouseViewScopeTarget {
    match scope {
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
    }
}

fn cluster_name_from_target_scope(scope: &ClickHouseViewScopeTarget) -> Option<&str> {
    match scope {
        ClickHouseViewScopeTarget::Cluster { cluster_name } => Some(cluster_name),
        _ => None,
    }
}

fn cluster_name_from_schema_scope(scope: &ClickHouseViewScope) -> Option<&str> {
    match scope {
        ClickHouseViewScope::Cluster { cluster_name } => Some(cluster_name),
        _ => None,
    }
}

fn change_operation(target: &ClickHouseViewChangeTarget) -> SchemaMutationOperation {
    match target {
        ClickHouseViewChangeTarget::Alter(_) => SchemaMutationOperation::Alter,
        ClickHouseViewChangeTarget::Rename(_) => SchemaMutationOperation::Rename,
        ClickHouseViewChangeTarget::Drop(_) => SchemaMutationOperation::Drop,
    }
}

fn change_destination(target: &ClickHouseViewChangeTarget) -> Option<&ClickHouseViewAddress> {
    match target {
        ClickHouseViewChangeTarget::Rename(target) => Some(&target.destination),
        _ => None,
    }
}

fn temporary_presence_after_statement(
    target: &ClickHouseViewChangeTarget,
    statement_index: usize,
) -> Option<bool> {
    match target {
        ClickHouseViewChangeTarget::Alter(target)
            if target.baseline.family == ClickHouseViewFamily::Temporary =>
        {
            Some(statement_index > 0)
        }
        ClickHouseViewChangeTarget::Drop(target)
            if target.baseline.family == ClickHouseViewFamily::Temporary =>
        {
            Some(false)
        }
        _ => None,
    }
}

enum PostChangeFacts {
    Alter(ObservedView),
    Rename {
        source: ObservedView,
        destination: ObservedView,
    },
    Drop(ObservedView),
}

enum ObservedView {
    Absent,
    Present(Box<ClickHouseViewSchema>),
    Unknown,
}

async fn post_change_facts<E: ViewExecutionExecutor>(
    executor: &E,
    target: &ClickHouseViewChangeTarget,
    scope: &ClickHouseViewScopeTarget,
) -> PostChangeFacts {
    match target {
        ClickHouseViewChangeTarget::Alter(target) => PostChangeFacts::Alter(
            observe_view(executor, &target.baseline.identity.address, scope).await,
        ),
        ClickHouseViewChangeTarget::Rename(target) => {
            let source = observe_view(executor, &target.baseline.identity.address, scope).await;
            let destination = observe_view(executor, &target.destination, scope).await;
            PostChangeFacts::Rename {
                source,
                destination,
            }
        }
        ClickHouseViewChangeTarget::Drop(target) => PostChangeFacts::Drop(
            observe_view(executor, &target.baseline.identity.address, scope).await,
        ),
    }
}

async fn observe_view<E: ViewExecutionExecutor>(
    executor: &E,
    address: &ClickHouseViewAddress,
    scope: &ClickHouseViewScopeTarget,
) -> ObservedView {
    match executor.describe_view(address, scope).await {
        Ok(Some(schema)) => ObservedView::Present(Box::new(schema)),
        Ok(None) => ObservedView::Absent,
        Err(_) => ObservedView::Unknown,
    }
}

struct ChangeProof {
    applied: bool,
    schema: Option<ClickHouseViewSchema>,
}

fn evaluate_change_proof(
    target: &ClickHouseViewChangeTarget,
    desired: Option<&ClickHouseViewDefinitionTarget>,
    facts: &PostChangeFacts,
) -> ChangeProof {
    match (target, facts) {
        (ClickHouseViewChangeTarget::Alter(target), PostChangeFacts::Alter(actual)) => {
            ChangeProof {
                applied: matches!(actual, ObservedView::Present(schema) if {
                    desired.is_some_and(|desired| view_schema_matches_alter(schema, target, desired))
                }),
                schema: observed_schema(actual),
            }
        }
        (
            ClickHouseViewChangeTarget::Rename(target),
            PostChangeFacts::Rename {
                source,
                destination,
            },
        ) => ChangeProof {
            applied: matches!(source, ObservedView::Absent)
                && matches!(destination, ObservedView::Present(schema) if {
                    renamed_schema_matches_baseline(schema, &target.destination, &target.baseline)
                }),
            schema: observed_schema(destination),
        },
        (ClickHouseViewChangeTarget::Drop(_), PostChangeFacts::Drop(actual)) => ChangeProof {
            applied: matches!(actual, ObservedView::Absent),
            schema: observed_schema(actual),
        },
        _ => ChangeProof {
            applied: false,
            schema: None,
        },
    }
}

fn view_schema_matches_alter(
    schema: &ClickHouseViewSchema,
    target: &super::ClickHouseViewAlterTarget,
    desired: &ClickHouseViewDefinitionTarget,
) -> bool {
    let baseline = &target.baseline;
    schema.identity.address == desired.address
        && schema.family == desired.family
        && scope_matches_target(&schema.scope, &desired.scope)
        && (baseline.columns == desired.columns
            || columns_match_target(&schema.columns, &desired.columns))
        && (super::view_queries_semantically_equal(&baseline.query, &desired.query)
            || super::view_queries_semantically_equal(&schema.query, &desired.query))
        && (baseline.security == desired.security
            || security_matches_target(&schema.security, &desired.security))
        && (baseline.comment == desired.comment || schema.comment == desired.comment)
        && (baseline.family_definition == desired.family_definition
            || family_definition_matches_target(
                &schema.family_definition,
                &desired.family_definition,
            ))
}

fn observed_schema(observed: &ObservedView) -> Option<ClickHouseViewSchema> {
    match observed {
        ObservedView::Present(schema) => Some(schema.as_ref().clone()),
        ObservedView::Absent | ObservedView::Unknown => None,
    }
}

fn view_schema_matches_target(
    schema: &ClickHouseViewSchema,
    desired: &ClickHouseViewDefinitionTarget,
) -> bool {
    schema.identity.address == desired.address
        && schema.family == desired.family
        && scope_matches_target(&schema.scope, &desired.scope)
        && columns_match_target(&schema.columns, &desired.columns)
        && super::view_queries_semantically_equal(&schema.query, &desired.query)
        && security_matches_target(&schema.security, &desired.security)
        && schema.comment == desired.comment
        && family_definition_matches_target(&schema.family_definition, &desired.family_definition)
}

fn security_matches_target(
    schema: &super::ClickHouseViewSecurity,
    desired: &super::ClickHouseViewSecurity,
) -> bool {
    desired
        .definer
        .as_ref()
        .is_none_or(|definer| schema.definer.as_ref() == Some(definer))
        && desired
            .sql_security
            .is_none_or(|security| schema.sql_security == Some(security))
}

fn family_definition_matches_target(
    schema: &ClickHouseViewFamilyDefinition,
    desired: &ClickHouseViewFamilyDefinition,
) -> bool {
    if schema == desired {
        return true;
    }
    match (schema, desired) {
        (
            ClickHouseViewFamilyDefinition::Materialized {
                storage: schema_storage,
                ..
            },
            ClickHouseViewFamilyDefinition::Materialized {
                storage: desired_storage,
                ..
            },
        ) => schema_storage == desired_storage,
        (
            ClickHouseViewFamilyDefinition::RefreshableMaterialized {
                storage: schema_storage,
                refresh: schema_refresh,
                append: schema_append,
                ..
            },
            ClickHouseViewFamilyDefinition::RefreshableMaterialized {
                storage: desired_storage,
                refresh: desired_refresh,
                append: desired_append,
                ..
            },
        ) => {
            schema_storage == desired_storage
                && schema_refresh == desired_refresh
                && schema_append == desired_append
        }
        _ => false,
    }
}

fn columns_match_target(
    schema: &ClickHouseViewColumnDefinition,
    desired: &ClickHouseViewColumnDefinition,
) -> bool {
    matches!(desired, ClickHouseViewColumnDefinition::None) || schema == desired
}

fn renamed_schema_matches_baseline(
    schema: &ClickHouseViewSchema,
    destination: &ClickHouseViewAddress,
    baseline: &ClickHouseViewSchema,
) -> bool {
    schema.identity.address == *destination
        && schema.family == baseline.family
        && schema.scope == baseline.scope
        && columns_match_target(&schema.columns, &baseline.columns)
        && super::view_queries_semantically_equal(&schema.query, &baseline.query)
        && schema.security == baseline.security
        && schema.comment == baseline.comment
        && schema.family_definition == baseline.family_definition
}

fn scope_matches_target(scope: &ClickHouseViewScope, target: &ClickHouseViewScopeTarget) -> bool {
    match (scope, target) {
        (ClickHouseViewScope::Local, ClickHouseViewScopeTarget::Local) => true,
        (
            ClickHouseViewScope::Cluster {
                cluster_name: actual,
            },
            ClickHouseViewScopeTarget::Cluster {
                cluster_name: expected,
            },
        ) => actual == expected,
        (
            ClickHouseViewScope::Temporary {
                owner_tab_runtime_id: actual,
                ..
            },
            ClickHouseViewScopeTarget::Temporary {
                owner_tab_runtime_id: expected,
            },
        ) => actual == expected,
        _ => false,
    }
}

fn redact_external_error(error: IpcError, operation: &str) -> IpcError {
    let message = match error.code {
        ErrorCode::OperationTimeout => {
            "ClickHouse View execution did not start before its deadline".to_string()
        }
        ErrorCode::OperationOutcomeUnknown => {
            "ClickHouse View execution outcome could not be verified".to_string()
        }
        _ => "ClickHouse View operation failed".to_string(),
    };
    let server_code = error
        .details
        .as_deref()
        .and_then(|details| {
            details
                .split(';')
                .find_map(|part| part.trim().strip_prefix("server_code="))
        })
        .filter(|value| *value == "unknown" || value.bytes().all(|byte| byte.is_ascii_digit()))
        .unwrap_or("unknown");
    IpcError {
        code: error.code,
        runtime_impact: error.runtime_impact,
        message,
        details: Some(format!(
            "operation={operation}; category=redacted; error_code={:?}; server_code={server_code}",
            error.code,
        )),
    }
}

fn background(
    kind: NativeSchemaBackgroundWorkKind,
    state: NativeSchemaBackgroundWorkState,
) -> NativeSchemaBackgroundWork {
    NativeSchemaBackgroundWork { kind, state }
}

fn map_refresh_state(value: &str) -> NativeSchemaBackgroundWorkState {
    let value = value.trim().to_ascii_lowercase();
    if value.contains("running") {
        NativeSchemaBackgroundWorkState::Running
    } else if value.contains("scheduled") || value.contains("pending") {
        NativeSchemaBackgroundWorkState::Submitted
    } else if value.contains("success") || value.contains("finished") {
        NativeSchemaBackgroundWorkState::Succeeded
    } else if value.contains("fail") {
        NativeSchemaBackgroundWorkState::Failed
    } else {
        NativeSchemaBackgroundWorkState::Unknown
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, VecDeque};
    use std::sync::Mutex;
    use std::time::Duration;

    use async_trait::async_trait;

    use super::*;
    use crate::engine::drivers::clickhouse::schema::{
        ClickHouseClusterDdlSupport, ClickHouseMaterializedStorage, ClickHouseRefreshDefinition,
        ClickHouseRefreshMode, ClickHouseRefreshSettings, ClickHouseSchemaEditability,
        ClickHouseSupportState, ClickHouseTemporarySessionState, ClickHouseViewAddress,
        ClickHouseViewAlterTarget, ClickHouseViewBaseline, ClickHouseViewColumnDefinition,
        ClickHouseViewCreateTarget, ClickHouseViewDefiner, ClickHouseViewDefinitionTarget,
        ClickHouseViewDropTarget, ClickHouseViewFamily, ClickHouseViewFamilyDefinition,
        ClickHouseViewFamilySupport, ClickHouseViewIdentity, ClickHouseViewInterval,
        ClickHouseViewIntervalUnit, ClickHouseViewOperationSupport, ClickHouseViewRenameTarget,
        ClickHouseViewRuntimeSupport, ClickHouseViewSchema, ClickHouseViewScope,
        ClickHouseViewScopeTarget, ClickHouseViewSecurity, ClickHouseViewSqlSecurity,
    };
    use crate::engine::native_schema::{
        NativeSchemaBackgroundWork, NativeSchemaBackgroundWorkKind,
        NativeSchemaBackgroundWorkState, NativeSchemaChangeBaseline, NativeSchemaChangeTarget,
        NativeSchemaConfirmationInput, NativeSchemaCreateTarget, NativeSchemaExecuteChangeRequest,
        NativeSchemaExecuteCreateRequest, NativeSchemaExecutionStatus,
    };
    use crate::engine::types::{ContainerKind, SchemaMutationOperation};
    use crate::error::{ErrorCode, IpcError, IpcResult, RuntimeErrorImpact};

    #[derive(Clone, Copy)]
    enum FakeStatementOutcome {
        Acknowledged,
        Ambiguous,
        UnsafeFailure,
    }

    #[derive(Clone, Copy)]
    enum FakeDescribeOutcome {
        Absent,
        Schema(usize),
        Unavailable,
    }

    struct FakeViewExecutor {
        support: ClickHouseViewRuntimeSupport,
        schemas: Vec<ClickHouseViewSchema>,
        describes: Mutex<VecDeque<FakeDescribeOutcome>>,
        outcomes: Mutex<VecDeque<FakeStatementOutcome>>,
        requests: Mutex<Vec<ViewStatementRequest>>,
        pre_send_timeout: bool,
        background_work: Option<NativeSchemaBackgroundWork>,
    }

    impl FakeViewExecutor {
        fn new(
            schemas: Vec<ClickHouseViewSchema>,
            describes: impl IntoIterator<Item = FakeDescribeOutcome>,
            outcomes: impl IntoIterator<Item = FakeStatementOutcome>,
        ) -> Self {
            Self {
                support: support(),
                schemas,
                describes: Mutex::new(describes.into_iter().collect()),
                outcomes: Mutex::new(outcomes.into_iter().collect()),
                requests: Mutex::new(Vec::new()),
                pre_send_timeout: false,
                background_work: None,
            }
        }

        fn requests(&self) -> Vec<ViewStatementRequest> {
            self.requests.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl ViewExecutionExecutor for FakeViewExecutor {
        fn timeout(&self) -> Duration {
            Duration::from_secs(7)
        }

        async fn runtime_support(
            &self,
            _database: Option<&str>,
        ) -> IpcResult<ClickHouseViewRuntimeSupport> {
            Ok(self.support.clone())
        }

        async fn describe_view(
            &self,
            _address: &ClickHouseViewAddress,
            _scope: &ClickHouseViewScopeTarget,
        ) -> IpcResult<Option<ClickHouseViewSchema>> {
            match self.describes.lock().unwrap().pop_front().unwrap() {
                FakeDescribeOutcome::Absent => Ok(None),
                FakeDescribeOutcome::Schema(index) => Ok(Some(self.schemas[index].clone())),
                FakeDescribeOutcome::Unavailable => Err(IpcError::network_timeout(
                    "describe failed",
                    "host=10.0.0.8; query=SHOW CREATE; password=secret",
                )),
            }
        }

        async fn pre_send_gate(&self, _scope: &ClickHouseViewScopeTarget) -> IpcResult<()> {
            if self.pre_send_timeout {
                Err(IpcError::operation_timeout(
                    "View execution did not start in time",
                    "host=10.0.0.8; session_id=secret-session",
                ))
            } else {
                Ok(())
            }
        }

        async fn execute_statement(&self, request: &ViewStatementRequest) -> ViewStatementOutcome {
            self.requests.lock().unwrap().push(request.clone());
            match self.outcomes.lock().unwrap().pop_front().unwrap() {
                FakeStatementOutcome::Acknowledged => ViewStatementOutcome::Acknowledged,
                FakeStatementOutcome::Ambiguous => ViewStatementOutcome::Ambiguous,
                FakeStatementOutcome::UnsafeFailure => ViewStatementOutcome::Failed(IpcError {
                    code: ErrorCode::ResourceConflict,
                    runtime_impact: RuntimeErrorImpact::BusinessOnly,
                    message: "query=DROP VIEW host=10.0.0.8".to_string(),
                    details: Some(
                        "password=secret; session_id=secret-session; raw server error".to_string(),
                    ),
                }),
            }
        }

        async fn background_work(
            &self,
            _schema: &ClickHouseViewSchema,
        ) -> Option<NativeSchemaBackgroundWork> {
            self.background_work.clone()
        }
    }

    fn operation_support() -> ClickHouseViewOperationSupport {
        ClickHouseViewOperationSupport {
            state: ClickHouseSupportState::Supported,
            reason: None,
        }
    }

    fn family_support() -> ClickHouseViewFamilySupport {
        let operation = operation_support();
        ClickHouseViewFamilySupport {
            describe: operation.clone(),
            create: operation.clone(),
            alter: operation.clone(),
            rename: operation.clone(),
            drop: operation,
        }
    }

    fn support() -> ClickHouseViewRuntimeSupport {
        let family = family_support();
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
            support_revision: "support-v1".to_string(),
        }
    }

    fn address(name: &str) -> ClickHouseViewAddress {
        ClickHouseViewAddress {
            database: Some("analytics".to_string()),
            name: name.to_string(),
            object_kind: ContainerKind::View,
        }
    }

    fn desired(name: &str) -> ClickHouseViewDefinitionTarget {
        ClickHouseViewDefinitionTarget {
            address: address(name),
            family: ClickHouseViewFamily::Normal,
            scope: ClickHouseViewScopeTarget::Local,
            columns: ClickHouseViewColumnDefinition::None,
            query: "SELECT 1 AS value".to_string(),
            security: ClickHouseViewSecurity {
                definer: None,
                sql_security: None,
            },
            comment: None,
            family_definition: ClickHouseViewFamilyDefinition::Normal,
        }
    }

    #[test]
    fn post_verify_accepts_server_inferred_columns_and_canonical_query_whitespace() {
        let mut desired = desired("events_view");
        desired.query = "SELECT id FROM analytics.events".to_string();
        let mut actual = schema_from(&desired, "revision-v1");
        actual.columns = ClickHouseViewColumnDefinition::Aliases(vec!["id".to_string()]);
        actual.query = "SELECT\n    `id`\nFROM `analytics`.`events`".to_string();

        assert!(view_schema_matches_target(&actual, &desired));
    }

    #[test]
    fn post_verify_accepts_refreshable_server_security_defaults_and_consumed_empty() {
        let mut desired = desired("refresh_mv");
        desired.address.object_kind = ContainerKind::MaterializedView;
        desired.family = ClickHouseViewFamily::RefreshableMaterialized;
        desired.family_definition = ClickHouseViewFamilyDefinition::RefreshableMaterialized {
            storage: ClickHouseMaterializedStorage::ToTable {
                target: ContainerRef::table(ContainerKind::Table, "analytics", None, "events_sink"),
                target_columns: Vec::new(),
            },
            refresh: ClickHouseRefreshDefinition {
                mode: ClickHouseRefreshMode::Every,
                interval: Some(ClickHouseViewInterval {
                    value: 1,
                    unit: ClickHouseViewIntervalUnit::Hour,
                }),
                offset: None,
                randomize_for: None,
                dependencies: Vec::new(),
                settings: ClickHouseRefreshSettings {
                    refresh_retries: None,
                    refresh_retry_initial_backoff_ms: None,
                    refresh_retry_max_backoff_ms: None,
                    all_replicas: None,
                },
            },
            append: false,
            empty: true,
        };
        let mut actual = schema_from(&desired, "revision-v1");
        actual.security = ClickHouseViewSecurity {
            definer: Some(ClickHouseViewDefiner::NamedUser("default".to_string())),
            sql_security: Some(ClickHouseViewSqlSecurity::Definer),
        };
        let ClickHouseViewFamilyDefinition::RefreshableMaterialized { empty, .. } =
            &mut actual.family_definition
        else {
            unreachable!("test schema must stay refreshable")
        };
        *empty = false;

        assert!(view_schema_matches_target(&actual, &desired));
    }

    #[test]
    fn alter_proof_verifies_changed_fields_without_rejecting_unchanged_query_canonicalization() {
        let desired_target = desired("events_view");
        let baseline = schema_from(&desired_target, "revision-v1");
        let mut desired_target = desired_target;
        desired_target.security.sql_security = Some(ClickHouseViewSqlSecurity::Invoker);
        let target = ClickHouseViewChangeTarget::Alter(Box::new(ClickHouseViewAlterTarget {
            baseline: baseline.clone(),
            desired: desired_target.clone(),
            expected_support_revision: "support-v1".to_string(),
        }));
        let mut actual = baseline;
        actual.security = desired_target.security.clone();
        actual.query = "SELECT events.value AS value FROM analytics.events AS events".to_string();

        let proof = evaluate_change_proof(
            &target,
            Some(&desired_target),
            &PostChangeFacts::Alter(ObservedView::Present(Box::new(actual))),
        );

        assert!(proof.applied);
    }

    fn temporary_desired(name: &str, query: &str) -> ClickHouseViewDefinitionTarget {
        ClickHouseViewDefinitionTarget {
            address: ClickHouseViewAddress {
                database: None,
                name: name.to_string(),
                object_kind: ContainerKind::View,
            },
            family: ClickHouseViewFamily::Temporary,
            scope: ClickHouseViewScopeTarget::Temporary {
                owner_tab_runtime_id: "tab-runtime-1".to_string(),
            },
            columns: ClickHouseViewColumnDefinition::None,
            query: query.to_string(),
            security: ClickHouseViewSecurity {
                definer: None,
                sql_security: None,
            },
            comment: None,
            family_definition: ClickHouseViewFamilyDefinition::Temporary,
        }
    }

    fn schema_from(
        desired: &ClickHouseViewDefinitionTarget,
        revision: &str,
    ) -> ClickHouseViewSchema {
        let scope = match &desired.scope {
            ClickHouseViewScopeTarget::Local => ClickHouseViewScope::Local,
            ClickHouseViewScopeTarget::Cluster { cluster_name } => ClickHouseViewScope::Cluster {
                cluster_name: cluster_name.clone(),
            },
            ClickHouseViewScopeTarget::Temporary {
                owner_tab_runtime_id,
            } => ClickHouseViewScope::Temporary {
                owner_tab_runtime_id: owner_tab_runtime_id.clone(),
                session_state: ClickHouseTemporarySessionState::Active,
            },
        };
        ClickHouseViewSchema {
            identity: ClickHouseViewIdentity {
                address: desired.address.clone(),
                uuid: None,
            },
            family: desired.family,
            scope,
            columns: desired.columns.clone(),
            query: desired.query.clone(),
            security: desired.security.clone(),
            comment: desired.comment.clone(),
            family_definition: desired.family_definition.clone(),
            server_support: support(),
            editability: ClickHouseSchemaEditability::editable(),
            baseline: ClickHouseViewBaseline {
                canonical_create_query: format!("CREATE VIEW {}", desired.address.name),
                revision_hash: revision.to_string(),
                server_version: "25.3.1".to_string(),
                family: desired.family,
                support_revision: "support-v1".to_string(),
            },
        }
    }

    fn create_request(target: ClickHouseViewCreateTarget) -> NativeSchemaExecuteCreateRequest {
        let preview = plan_view_create(&target, &support(), None).unwrap();
        NativeSchemaExecuteCreateRequest {
            target: NativeSchemaCreateTarget::ClickHouseView(Box::new(target)),
            expected_plan_hash: preview.plan_hash,
            confirmation: None,
            baseline: None,
        }
    }

    fn change_request(
        target: ClickHouseViewChangeTarget,
        confirmation: Option<NativeSchemaConfirmationInput>,
    ) -> NativeSchemaExecuteChangeRequest {
        let plan = plan_view_change(&target, &support()).unwrap();
        let baseline = match &target {
            ClickHouseViewChangeTarget::Alter(target) => target.baseline.clone(),
            ClickHouseViewChangeTarget::Rename(target) => target.baseline.clone(),
            ClickHouseViewChangeTarget::Drop(target) => target.baseline.clone(),
        };
        let tagged = match target {
            ClickHouseViewChangeTarget::Alter(target) => {
                NativeSchemaChangeTarget::ClickHouseViewAlter(target)
            }
            ClickHouseViewChangeTarget::Rename(target) => {
                NativeSchemaChangeTarget::ClickHouseViewRename(target)
            }
            ClickHouseViewChangeTarget::Drop(target) => {
                NativeSchemaChangeTarget::ClickHouseViewDrop(target)
            }
        };
        NativeSchemaExecuteChangeRequest {
            target: tagged,
            baseline: NativeSchemaChangeBaseline::ClickHouseView(Box::new(baseline)),
            expected_plan_hash: plan.plan_hash,
            confirmation,
        }
    }

    #[tokio::test]
    async fn view_execute_checks_support_plan_baseline_confirmation_and_timeout_before_ddl() {
        let target = ClickHouseViewCreateTarget {
            desired: desired("events_view"),
            expected_support_revision: "stale-support".to_string(),
        };
        let executor = FakeViewExecutor::new(Vec::new(), [], []);
        let error = execute_view_create(
            &executor,
            &NativeSchemaExecuteCreateRequest {
                target: NativeSchemaCreateTarget::ClickHouseView(Box::new(target)),
                expected_plan_hash: "stale-plan".to_string(),
                confirmation: None,
                baseline: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceConflict);
        assert!(executor.requests().is_empty());

        let baseline = schema_from(&desired("events_view"), "baseline-v1");
        let drop = ClickHouseViewChangeTarget::Drop(Box::new(ClickHouseViewDropTarget {
            baseline: baseline.clone(),
            expected_support_revision: "support-v1".to_string(),
        }));
        let mut request = change_request(drop, None);
        request.baseline = NativeSchemaChangeBaseline::ClickHouseView(Box::new(schema_from(
            &desired("other_view"),
            "other-v1",
        )));
        let executor = FakeViewExecutor::new(Vec::new(), [], []);
        let error = execute_view_change(&executor, &request).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceConflict);
        assert!(executor.requests().is_empty());

        let target = ClickHouseViewCreateTarget {
            desired: desired("events_view"),
            expected_support_revision: "support-v1".to_string(),
        };
        let mut executor = FakeViewExecutor::new(Vec::new(), [FakeDescribeOutcome::Absent], []);
        executor.pre_send_timeout = true;
        let error = execute_view_create(&executor, &create_request(target))
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::OperationTimeout);
        assert!(executor.requests().is_empty());
        let diagnostic = format!("{error:?}");
        assert!(!diagnostic.contains("session_id"));
        assert!(!diagnostic.contains("10.0.0.8"));
    }

    #[tokio::test]
    async fn view_execute_uses_unique_query_ids_wait_settings_and_exact_post_describe() {
        let baseline_target = temporary_desired("session_view", "SELECT 1 AS value");
        let desired_target = temporary_desired("session_view", "SELECT 2 AS value");
        let baseline = schema_from(&baseline_target, "temporary-v1");
        let actual = schema_from(&desired_target, "temporary-v2");
        let target = ClickHouseViewChangeTarget::Alter(Box::new(ClickHouseViewAlterTarget {
            baseline: baseline.clone(),
            desired: desired_target,
            expected_support_revision: "support-v1".to_string(),
        }));
        let executor = FakeViewExecutor::new(
            vec![baseline, actual],
            [
                FakeDescribeOutcome::Schema(0),
                FakeDescribeOutcome::Schema(1),
            ],
            [
                FakeStatementOutcome::Acknowledged,
                FakeStatementOutcome::Acknowledged,
            ],
        );

        let result = execute_view_change(
            &executor,
            &change_request(
                target,
                Some(NativeSchemaConfirmationInput {
                    accepted: true,
                    object_name: Some("session_view".to_string()),
                    cluster_name: None,
                }),
            ),
        )
        .await
        .unwrap();

        assert_eq!(result.status, NativeSchemaExecutionStatus::Applied);
        let requests = executor.requests();
        assert_eq!(requests.len(), 2);
        assert_ne!(requests[0].query_id, requests[1].query_id);
        for request in requests {
            assert_eq!(
                request.settings.get("wait_end_of_query"),
                Some(&"1".to_string())
            );
            assert_eq!(
                request.settings.get("max_execution_time"),
                Some(&"7".to_string())
            );
            assert!(!request.settings.contains_key("session_id"));
        }
    }

    #[tokio::test]
    async fn temporary_drop_then_create_failure_stops_and_is_partial() {
        let baseline_target = temporary_desired("session_view", "SELECT 1 AS value");
        let desired_target = temporary_desired("session_view", "SELECT 2 AS value");
        let baseline = schema_from(&baseline_target, "temporary-v1");
        let target = ClickHouseViewChangeTarget::Alter(Box::new(ClickHouseViewAlterTarget {
            baseline: baseline.clone(),
            desired: desired_target,
            expected_support_revision: "support-v1".to_string(),
        }));
        let executor = FakeViewExecutor::new(
            vec![baseline],
            [FakeDescribeOutcome::Schema(0), FakeDescribeOutcome::Absent],
            [
                FakeStatementOutcome::Acknowledged,
                FakeStatementOutcome::UnsafeFailure,
                FakeStatementOutcome::Acknowledged,
            ],
        );

        let result = execute_view_change(
            &executor,
            &change_request(
                target,
                Some(NativeSchemaConfirmationInput {
                    accepted: true,
                    object_name: Some("session_view".to_string()),
                    cluster_name: None,
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(result.status, NativeSchemaExecutionStatus::PartiallyApplied);
        assert_eq!(result.progress.applied_count, 1);
        assert_eq!(result.progress.failed_statement_index, Some(1));
        assert_eq!(executor.requests().len(), 2);
    }

    #[tokio::test]
    async fn ambiguous_or_unverifiable_create_never_becomes_applied() {
        let target = ClickHouseViewCreateTarget {
            desired: desired("events_view"),
            expected_support_revision: "support-v1".to_string(),
        };
        for outcome in [
            FakeStatementOutcome::Acknowledged,
            FakeStatementOutcome::Ambiguous,
        ] {
            let executor = FakeViewExecutor::new(
                Vec::new(),
                [
                    FakeDescribeOutcome::Absent,
                    FakeDescribeOutcome::Unavailable,
                ],
                [outcome],
            );
            let result = execute_view_create(&executor, &create_request(target.clone()))
                .await
                .unwrap();
            assert_eq!(result.status, NativeSchemaExecutionStatus::OutcomeUnknown);
            assert!(result.schema.is_none());
        }
    }

    #[tokio::test]
    async fn rename_and_drop_require_exact_absence_and_destination_proofs() {
        let source_target = desired("events_view");
        let baseline = schema_from(&source_target, "source-v1");
        let mut renamed_target = source_target.clone();
        renamed_target.address = address("events_view_v2");
        let renamed = schema_from(&renamed_target, "destination-v1");
        let rename = ClickHouseViewChangeTarget::Rename(Box::new(ClickHouseViewRenameTarget {
            baseline: baseline.clone(),
            destination: renamed_target.address.clone(),
            expected_destination_absence_revision: "absent-v1".to_string(),
            expected_support_revision: "support-v1".to_string(),
        }));
        let executor = FakeViewExecutor::new(
            vec![baseline.clone(), renamed],
            [
                FakeDescribeOutcome::Schema(0),
                FakeDescribeOutcome::Absent,
                FakeDescribeOutcome::Absent,
                FakeDescribeOutcome::Schema(1),
            ],
            [FakeStatementOutcome::Acknowledged],
        );
        let result = execute_view_change(&executor, &change_request(rename, None))
            .await
            .unwrap();
        assert_eq!(result.status, NativeSchemaExecutionStatus::Applied);
        assert_eq!(
            result
                .destination
                .as_ref()
                .and_then(|value| value.table.as_deref()),
            Some("events_view_v2")
        );

        let drop = ClickHouseViewChangeTarget::Drop(Box::new(ClickHouseViewDropTarget {
            baseline: baseline.clone(),
            expected_support_revision: "support-v1".to_string(),
        }));
        let executor = FakeViewExecutor::new(
            vec![baseline],
            [FakeDescribeOutcome::Schema(0), FakeDescribeOutcome::Absent],
            [FakeStatementOutcome::Acknowledged],
        );
        let result = execute_view_change(
            &executor,
            &change_request(
                drop,
                Some(NativeSchemaConfirmationInput {
                    accepted: true,
                    object_name: Some("events_view".to_string()),
                    cluster_name: None,
                }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(result.status, NativeSchemaExecutionStatus::Applied);
        assert!(result.schema.is_none());
    }

    #[tokio::test]
    async fn failed_post_describe_is_not_treated_as_drop_absence_proof() {
        let baseline = schema_from(&desired("events_view"), "source-v1");
        let drop = ClickHouseViewChangeTarget::Drop(Box::new(ClickHouseViewDropTarget {
            baseline: baseline.clone(),
            expected_support_revision: "support-v1".to_string(),
        }));
        let executor = FakeViewExecutor::new(
            vec![baseline],
            [
                FakeDescribeOutcome::Schema(0),
                FakeDescribeOutcome::Unavailable,
            ],
            [FakeStatementOutcome::Acknowledged],
        );

        let result = execute_view_change(
            &executor,
            &change_request(
                drop,
                Some(NativeSchemaConfirmationInput {
                    accepted: true,
                    object_name: Some("events_view".to_string()),
                    cluster_name: None,
                }),
            ),
        )
        .await
        .unwrap();

        assert_eq!(result.status, NativeSchemaExecutionStatus::OutcomeUnknown);
    }

    #[tokio::test]
    async fn first_statement_error_is_redacted_and_background_comes_from_actual_facts() {
        let target = ClickHouseViewCreateTarget {
            desired: desired("events_view"),
            expected_support_revision: "support-v1".to_string(),
        };
        let executor = FakeViewExecutor::new(
            Vec::new(),
            [FakeDescribeOutcome::Absent],
            [FakeStatementOutcome::UnsafeFailure],
        );
        let error = execute_view_create(&executor, &create_request(target.clone()))
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceConflict);
        let diagnostic = format!("{error:?}");
        for secret in [
            "DROP VIEW",
            "10.0.0.8",
            "password",
            "session_id",
            "raw server",
        ] {
            assert!(
                !diagnostic.contains(secret),
                "leaked {secret}: {diagnostic}"
            );
        }

        let actual = schema_from(&target.desired, "created-v1");
        let mut executor = FakeViewExecutor::new(
            vec![actual],
            [FakeDescribeOutcome::Absent, FakeDescribeOutcome::Schema(0)],
            [FakeStatementOutcome::Acknowledged],
        );
        executor.background_work = Some(NativeSchemaBackgroundWork {
            kind: NativeSchemaBackgroundWorkKind::InitialRefresh,
            state: NativeSchemaBackgroundWorkState::Running,
        });
        let result = execute_view_create(&executor, &create_request(target))
            .await
            .unwrap();
        assert_eq!(result.status, NativeSchemaExecutionStatus::Applied);
        assert_eq!(
            result.background_work,
            Some(NativeSchemaBackgroundWork {
                kind: NativeSchemaBackgroundWorkKind::InitialRefresh,
                state: NativeSchemaBackgroundWorkState::Running,
            })
        );
    }

    #[test]
    fn view_statement_request_never_serializes_session_state() {
        let request = ViewStatementRequest {
            statement: "CREATE VIEW secret_view AS SELECT 1".to_string(),
            query_id: "query-1".to_string(),
            settings: BTreeMap::from([("wait_end_of_query".to_string(), "1".to_string())]),
            is_create: true,
        };
        assert!(!request.settings.contains_key("session_id"));
    }

    struct FakeClusterExecution {
        view: FakeViewExecutor,
        topologies:
            Mutex<VecDeque<Vec<crate::engine::drivers::clickhouse::schema::ClusterTopologyNode>>>,
        facts: Mutex<VecDeque<Vec<crate::engine::drivers::clickhouse::schema::ClusterObjectFact>>>,
        enqueued: std::sync::atomic::AtomicBool,
    }

    #[async_trait]
    impl ViewExecutionExecutor for FakeClusterExecution {
        fn timeout(&self) -> Duration {
            self.view.timeout()
        }

        async fn runtime_support(
            &self,
            database: Option<&str>,
        ) -> IpcResult<ClickHouseViewRuntimeSupport> {
            self.view.runtime_support(database).await
        }

        async fn describe_view(
            &self,
            address: &ClickHouseViewAddress,
            scope: &ClickHouseViewScopeTarget,
        ) -> IpcResult<Option<ClickHouseViewSchema>> {
            self.view.describe_view(address, scope).await
        }

        async fn pre_send_gate(&self, _scope: &ClickHouseViewScopeTarget) -> IpcResult<()> {
            Ok(())
        }

        async fn execute_statement(&self, request: &ViewStatementRequest) -> ViewStatementOutcome {
            self.view.execute_statement(request).await
        }

        async fn background_work(
            &self,
            schema: &ClickHouseViewSchema,
        ) -> Option<NativeSchemaBackgroundWork> {
            self.view.background_work(schema).await
        }
    }

    #[async_trait]
    impl crate::engine::drivers::clickhouse::schema::ClusterViewExecutor for FakeClusterExecution {
        fn mark_ddl_enqueued(&self) {
            self.enqueued
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }

        async fn topology(
            &self,
            _cluster_name: &str,
        ) -> IpcResult<Vec<crate::engine::drivers::clickhouse::schema::ClusterTopologyNode>>
        {
            Ok(self.topologies.lock().unwrap().pop_front().unwrap())
        }

        async fn object_facts(
            &self,
            _cluster_name: &str,
            _address: &ClickHouseViewAddress,
        ) -> IpcResult<Vec<crate::engine::drivers::clickhouse::schema::ClusterObjectFact>> {
            Ok(self.facts.lock().unwrap().pop_front().unwrap())
        }

        async fn distributed_ddl_enqueued(&self, _cluster_name: &str) -> IpcResult<bool> {
            Ok(self.enqueued.load(std::sync::atomic::Ordering::SeqCst))
        }
    }

    fn cluster_topology() -> Vec<crate::engine::drivers::clickhouse::schema::ClusterTopologyNode> {
        vec![
            crate::engine::drivers::clickhouse::schema::ClusterTopologyNode {
                raw_identity: "node-a.internal".to_string(),
                shard: 1,
                replica: 1,
                membership_revision: "node-a.internal:8123".to_string(),
            },
        ]
    }

    fn cluster_fact(
        state: crate::engine::drivers::clickhouse::schema::ClickHouseClusterObjectState,
        revision: Option<&str>,
    ) -> Vec<crate::engine::drivers::clickhouse::schema::ClusterObjectFact> {
        vec![
            crate::engine::drivers::clickhouse::schema::ClusterObjectFact {
                raw_identity: "node-a.internal".to_string(),
                shard: 1,
                replica: 1,
                reachable: true,
                object_state: state,
                family: revision.map(|_| ClickHouseViewFamily::Normal),
                revision_hash: revision.map(str::to_string),
                error_code: None,
            },
        ]
    }

    #[tokio::test]
    async fn cluster_create_rechecks_baseline_sends_once_and_uses_all_node_proof() {
        let baseline_reader = FakeClusterExecution {
            view: FakeViewExecutor::new(Vec::new(), [], []),
            topologies: Mutex::new([cluster_topology()].into_iter().collect()),
            facts: Mutex::new(
                [cluster_fact(
                    crate::engine::drivers::clickhouse::schema::ClickHouseClusterObjectState::Absent,
                    None,
                )]
                .into_iter()
                .collect(),
            ),
            enqueued: std::sync::atomic::AtomicBool::new(false),
        };
        let expected = crate::engine::drivers::clickhouse::schema::read_cluster_baseline(
            &baseline_reader,
            "analytics_cluster",
            &address("events_view"),
        )
        .await
        .unwrap();

        let mut support = support();
        support.cluster_ddl = ClickHouseClusterDdlSupport {
            discoverable: true,
            executable: true,
            observable: true,
            drift_verifiable: true,
        };
        let mut target_definition = desired("events_view");
        target_definition.scope = ClickHouseViewScopeTarget::Cluster {
            cluster_name: "analytics_cluster".to_string(),
        };
        let target = ClickHouseViewCreateTarget {
            desired: target_definition.clone(),
            expected_support_revision: "support-v1".to_string(),
        };
        let preview = plan_view_create(&target, &support, Some(&expected)).unwrap();
        assert!(matches!(
            preview.baseline,
            Some(NativeSchemaChangeBaseline::ClickHouseClusterView(_))
        ));
        let actual = schema_from(&target_definition, "revision-v2");
        let execution = FakeClusterExecution {
            view: FakeViewExecutor {
                support,
                schemas: vec![actual],
                describes: Mutex::new([FakeDescribeOutcome::Schema(0)].into_iter().collect()),
                outcomes: Mutex::new(
                    [FakeStatementOutcome::Acknowledged]
                        .into_iter()
                        .collect(),
                ),
                requests: Mutex::new(Vec::new()),
                pre_send_timeout: false,
                background_work: None,
            },
            topologies: Mutex::new(
                [cluster_topology(), cluster_topology()]
                    .into_iter()
                    .collect(),
            ),
            facts: Mutex::new(
                [
                    cluster_fact(
                        crate::engine::drivers::clickhouse::schema::ClickHouseClusterObjectState::Absent,
                        None,
                    ),
                    cluster_fact(
                        crate::engine::drivers::clickhouse::schema::ClickHouseClusterObjectState::Present,
                        Some("revision-v2"),
                    ),
                ]
                .into_iter()
                .collect(),
            ),
            enqueued: std::sync::atomic::AtomicBool::new(false),
        };
        let result = execute_cluster_view_create(
            &execution,
            &NativeSchemaExecuteCreateRequest {
                target: NativeSchemaCreateTarget::ClickHouseView(Box::new(target)),
                expected_plan_hash: preview.plan_hash,
                confirmation: Some(NativeSchemaConfirmationInput {
                    accepted: true,
                    object_name: Some("events_view".to_string()),
                    cluster_name: Some("analytics_cluster".to_string()),
                }),
                baseline: Some(NativeSchemaChangeBaseline::ClickHouseClusterView(Box::new(
                    expected.clone(),
                ))),
            },
            &expected,
        )
        .await
        .unwrap();

        assert_eq!(result.status, NativeSchemaExecutionStatus::Applied);
        assert_eq!(execution.view.requests().len(), 1);
        assert_eq!(result.cluster_outcome.unwrap().nodes[0].state,
            crate::engine::drivers::clickhouse::schema::ClickHouseClusterNodeExecutionState::Applied);
    }

    #[tokio::test]
    async fn cluster_drop_rechecks_definition_and_proves_absence_without_retry() {
        let mut baseline_definition = desired("events_view");
        baseline_definition.scope = ClickHouseViewScopeTarget::Cluster {
            cluster_name: "analytics_cluster".to_string(),
        };
        let baseline_schema = schema_from(&baseline_definition, "revision-v1");
        let baseline_reader = FakeClusterExecution {
            view: FakeViewExecutor::new(Vec::new(), [], []),
            topologies: Mutex::new([cluster_topology()].into_iter().collect()),
            facts: Mutex::new(
                [cluster_fact(
                    crate::engine::drivers::clickhouse::schema::ClickHouseClusterObjectState::Present,
                    Some("revision-v1"),
                )]
                .into_iter()
                .collect(),
            ),
            enqueued: std::sync::atomic::AtomicBool::new(false),
        };
        let expected = crate::engine::drivers::clickhouse::schema::read_cluster_baseline(
            &baseline_reader,
            "analytics_cluster",
            &baseline_schema.identity.address,
        )
        .await
        .unwrap();
        let mut support = support();
        support.cluster_ddl = ClickHouseClusterDdlSupport {
            discoverable: true,
            executable: true,
            observable: true,
            drift_verifiable: true,
        };
        let target = ClickHouseViewChangeTarget::Drop(Box::new(ClickHouseViewDropTarget {
            baseline: baseline_schema.clone(),
            expected_support_revision: "support-v1".to_string(),
        }));
        let preview = crate::engine::drivers::clickhouse::schema::plan_view_change_with_cluster(
            &target,
            &support,
            Some(&expected),
        )
        .unwrap();
        let execution = FakeClusterExecution {
            view: FakeViewExecutor {
                support,
                schemas: Vec::new(),
                describes: Mutex::new(VecDeque::new()),
                outcomes: Mutex::new(
                    [FakeStatementOutcome::Acknowledged]
                        .into_iter()
                        .collect(),
                ),
                requests: Mutex::new(Vec::new()),
                pre_send_timeout: false,
                background_work: None,
            },
            topologies: Mutex::new(
                [cluster_topology(), cluster_topology()]
                    .into_iter()
                    .collect(),
            ),
            facts: Mutex::new(
                [
                    cluster_fact(
                        crate::engine::drivers::clickhouse::schema::ClickHouseClusterObjectState::Present,
                        Some("revision-v1"),
                    ),
                    cluster_fact(
                        crate::engine::drivers::clickhouse::schema::ClickHouseClusterObjectState::Absent,
                        None,
                    ),
                ]
                .into_iter()
                .collect(),
            ),
            enqueued: std::sync::atomic::AtomicBool::new(false),
        };
        let request = NativeSchemaExecuteChangeRequest {
            target: NativeSchemaChangeTarget::ClickHouseViewDrop(match target {
                ClickHouseViewChangeTarget::Drop(target) => target,
                _ => unreachable!(),
            }),
            baseline: NativeSchemaChangeBaseline::ClickHouseClusterView(Box::new(expected.clone())),
            expected_plan_hash: preview.plan_hash,
            confirmation: Some(NativeSchemaConfirmationInput {
                accepted: true,
                object_name: Some("events_view".to_string()),
                cluster_name: Some("analytics_cluster".to_string()),
            }),
        };

        let result = execute_cluster_view_change(&execution, &request, &expected)
            .await
            .unwrap();

        assert_eq!(result.status, NativeSchemaExecutionStatus::Applied);
        assert_eq!(result.operation, SchemaMutationOperation::Drop);
        assert_eq!(execution.view.requests().len(), 1);
    }
}
