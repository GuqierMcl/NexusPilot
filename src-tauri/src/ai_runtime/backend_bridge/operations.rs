use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use super::contracts::{
    ConnectionDetail, ConnectionGetRequest, ConnectionGetResponse, ConnectionListItem,
    ConnectionListRequest, ConnectionListResponse, ConnectionOpenRequest, ConnectionOpenResponse,
    KeyValueCreateToolRequest, KeyValueDeleteToolRequest, KeyValueDeleteToolResponse,
    KeyValueGetRequest, KeyValueGetResponse, KeyValueMutationToolResponse,
    KeyValueRenameToolRequest, KeyValueScanRequest, KeyValueScanResponse, KeyValueSetToolRequest,
    KeyValueSetTtlToolRequest, MetadataDescribeTableRequest, MetadataDescribeTableResponse,
    MetadataListChildrenRequest, MetadataListChildrenResponse, OpenedConnection, TableQueryRequest,
    TableQueryResponse,
};
use super::frames::{GatewayError, GatewayExecutionContext, GatewayOutcome};
use super::gateway::GatewayOperation;
use super::handler::BackendBridgeHandlerResult;
use super::prepared_plans::PreparedPlanRegistry;
use super::prepared_plans::{PreparedPlanError, PreparedPlanSpec, DEFAULT_PREPARED_PLAN_TTL_MS};
use super::sql::{
    analyze_sql_for_driver, PreparedSqlPayload, SqlAnalysisStatus, SqlToolRequest,
    SqlToolStatementClass,
};
use crate::db::DatabaseState;
use crate::engine::manager::{ConnectionRuntimeManager, SharedManagedSqlExecution};
use crate::engine::profiles::{driver_profile_from_record, DriverProfile};
use crate::engine::types::{
    ConnectionRuntimeSnapshot, QueryResult, RedisCreateKeyValueRequest, RedisDeleteKeyRequest,
    RedisEditableValue, RedisKeyRef, RedisRenameKeyRequest, RedisSetKeyTtlMode,
    RedisSetKeyTtlRequest, RedisSetKeyValueRequest, SqlExecutionContext, SqlExecutionOptions,
    SqlExecutionOutcome, SqlResultMode, SqlStatementAccess, SqlStatementClass,
    StartSqlExecutionRequest,
};
use crate::error::{ErrorCode, IpcError};
use crate::workbench::application_service;
use crate::workbench::runtime_events::{RuntimeChangeOrigin, WorkbenchRuntimeEventSink};

#[cfg(test)]
pub fn backend_gateway_operations(
    database: DatabaseState,
    runtime_manager: ConnectionRuntimeManager,
    event_sink: Arc<dyn WorkbenchRuntimeEventSink>,
) -> Vec<Arc<dyn GatewayOperation>> {
    backend_gateway_operations_with_prepared_plans(
        database,
        runtime_manager,
        event_sink,
        PreparedPlanRegistry::default(),
    )
}

pub fn backend_gateway_operations_with_prepared_plans(
    database: DatabaseState,
    runtime_manager: ConnectionRuntimeManager,
    event_sink: Arc<dyn WorkbenchRuntimeEventSink>,
    prepared_plans: PreparedPlanRegistry,
) -> Vec<Arc<dyn GatewayOperation>> {
    vec![
        Arc::new(PreparedPlanCleanupRunOperation {
            prepared_plans: prepared_plans.clone(),
        }),
        Arc::new(SqlAnalyzeOperation {
            database: database.clone(),
            runtime_manager: runtime_manager.clone(),
            prepared_plans: prepared_plans.clone(),
        }),
        Arc::new(SqlExecuteOperation {
            database: database.clone(),
            runtime_manager: runtime_manager.clone(),
            prepared_plans: prepared_plans.clone(),
        }),
        Arc::new(KeyValuePrepareOperation::new(
            KeyValueMutationKind::Create,
            database.clone(),
            runtime_manager.clone(),
            prepared_plans.clone(),
        )),
        Arc::new(KeyValuePrepareOperation::new(
            KeyValueMutationKind::Set,
            database.clone(),
            runtime_manager.clone(),
            prepared_plans.clone(),
        )),
        Arc::new(KeyValuePrepareOperation::new(
            KeyValueMutationKind::Rename,
            database.clone(),
            runtime_manager.clone(),
            prepared_plans.clone(),
        )),
        Arc::new(KeyValuePrepareOperation::new(
            KeyValueMutationKind::SetTtl,
            database.clone(),
            runtime_manager.clone(),
            prepared_plans.clone(),
        )),
        Arc::new(KeyValuePrepareOperation::new(
            KeyValueMutationKind::Delete,
            database.clone(),
            runtime_manager.clone(),
            prepared_plans.clone(),
        )),
        Arc::new(KeyValueExecuteOperation::new(
            KeyValueMutationKind::Create,
            database.clone(),
            runtime_manager.clone(),
            prepared_plans.clone(),
        )),
        Arc::new(KeyValueExecuteOperation::new(
            KeyValueMutationKind::Set,
            database.clone(),
            runtime_manager.clone(),
            prepared_plans.clone(),
        )),
        Arc::new(KeyValueExecuteOperation::new(
            KeyValueMutationKind::Rename,
            database.clone(),
            runtime_manager.clone(),
            prepared_plans.clone(),
        )),
        Arc::new(KeyValueExecuteOperation::new(
            KeyValueMutationKind::SetTtl,
            database.clone(),
            runtime_manager.clone(),
            prepared_plans.clone(),
        )),
        Arc::new(KeyValueExecuteOperation::new(
            KeyValueMutationKind::Delete,
            database.clone(),
            runtime_manager.clone(),
            prepared_plans,
        )),
        Arc::new(ConnectionListOperation {
            database: database.clone(),
            runtime_manager: runtime_manager.clone(),
        }),
        Arc::new(ConnectionGetOperation {
            database: database.clone(),
            runtime_manager: runtime_manager.clone(),
        }),
        Arc::new(ConnectionOpenOperation {
            database: database.clone(),
            runtime_manager: runtime_manager.clone(),
            event_sink,
        }),
        Arc::new(MetadataListChildrenOperation {
            database: database.clone(),
            runtime_manager: runtime_manager.clone(),
        }),
        Arc::new(MetadataDescribeTableOperation {
            database: database.clone(),
            runtime_manager: runtime_manager.clone(),
        }),
        Arc::new(TableQueryOperation {
            database: database.clone(),
            runtime_manager: runtime_manager.clone(),
        }),
        Arc::new(KeyValueScanOperation {
            database: database.clone(),
            runtime_manager: runtime_manager.clone(),
        }),
        Arc::new(KeyValueGetOperation {
            database,
            runtime_manager,
        }),
    ]
}

struct PreparedPlanCleanupRunOperation {
    prepared_plans: PreparedPlanRegistry,
}

struct SqlAnalyzeOperation {
    database: DatabaseState,
    runtime_manager: ConnectionRuntimeManager,
    prepared_plans: PreparedPlanRegistry,
}

#[async_trait]
impl GatewayOperation for SqlAnalyzeOperation {
    fn id(&self) -> &'static str {
        "sql.analyze"
    }

    async fn execute(&self, _input: Value) -> BackendBridgeHandlerResult {
        Err(plan_error(
            "PLAN_MISMATCH",
            "SQL analysis requires trusted execution context.",
        ))
    }

    async fn execute_with_context(
        &self,
        input: Value,
        context: Option<GatewayExecutionContext>,
    ) -> BackendBridgeHandlerResult {
        let Some(context) = context else {
            return Err(plan_error(
                "PLAN_MISMATCH",
                "SQL analysis requires trusted execution context.",
            ));
        };
        if context.tool_id != "sql.execute" {
            return Err(plan_error(
                "PLAN_MISMATCH",
                "SQL analysis context does not match sql.execute.",
            ));
        }
        let request: SqlToolRequest = parse_request(input, self.id())?;
        request.validate().map_err(sql_rejected)?;
        let (profile, snapshot) = require_sql_executor(
            &self.database,
            &self.runtime_manager,
            &request.profile_id,
            GatewayOutcome::NotStarted,
        )
        .await?;
        let analysis =
            analyze_sql_for_driver(profile.driver.as_str(), &request.sql).map_err(sql_rejected)?;
        if profile.driver.as_str() == "clickhouse" {
            if request
                .schema
                .as_deref()
                .is_some_and(|schema| !schema.trim().is_empty())
            {
                return Err(sql_rejected(
                    "ClickHouse SQL accepts a database target but not a schema target",
                ));
            }
            let managed_direct = snapshot
                .runtime
                .capabilities
                .sql_execution
                .as_ref()
                .is_some_and(|features| {
                    features.managed_lifecycle
                        && features.statement_access == SqlStatementAccess::Direct
                });
            if !managed_direct {
                return Err(GatewayError {
                    code: "CAPABILITY_UNAVAILABLE".to_string(),
                    message: "ClickHouse SQL requires the direct managed execution lifecycle."
                        .to_string(),
                    retryable: false,
                    outcome: GatewayOutcome::NotStarted,
                });
            }
        }
        let read_only = sql_profile_read_only(&profile, GatewayOutcome::NotStarted)?;
        ensure_read_only_sql_policy(
            read_only,
            analysis.status,
            analysis.statement_class,
            GatewayOutcome::NotStarted,
        )?;
        let expires_at = unix_time_ms()
            .checked_add(DEFAULT_PREPARED_PLAN_TTL_MS)
            .ok_or_else(|| read_error("Prepared SQL plan expiry overflowed."))?;
        let payload = PreparedSqlPayload {
            request: request.clone(),
            expected_driver: snapshot.runtime.driver_name.clone(),
            expected_profile_updated_at: profile.updated_at,
            expected_read_only: read_only,
            analysis_status: analysis.status,
            statement_class: analysis.statement_class,
        };
        let exact_payload = serde_json::to_value(payload)
            .map_err(|_| read_error("Prepared SQL payload could not be serialized."))?;
        let handle = self
            .prepared_plans
            .prepare(PreparedPlanSpec {
                context,
                profile_id: request.profile_id.clone(),
                execute_operation: "sql.execute",
                exact_payload,
                expires_at_ms: expires_at,
            })
            .map_err(map_plan_error)?;
        let analysis_status = match analysis.status {
            SqlAnalysisStatus::Analyzed => "analyzed",
            SqlAnalysisStatus::Uncertain => "uncertain",
        };
        let statement_class = analysis.statement_class.as_str();
        let confirmation_prompt = format!(
            "确认在 {} {} 执行",
            profile.environment,
            profile.driver.as_str()
        );
        let mut outcome_warnings = vec![
            "超时、连接中断或未知后端错误可能导致数据库侧结果未知；系统不会自动重试。".to_string(),
        ];
        if profile.driver.as_str() == "clickhouse" {
            outcome_warnings.push(
                "ClickHouse 异步 mutation 的 accepted/submitted 只表示服务端已接收，不表示后台 mutation 已完成。"
                    .to_string(),
            );
        }
        let mut target = serde_json::Map::from_iter([
            (
                "profileId".to_string(),
                Value::String(request.profile_id.clone()),
            ),
            (
                "connectionName".to_string(),
                Value::String(profile.name.clone()),
            ),
            (
                "driver".to_string(),
                Value::String(profile.driver.as_str().to_string()),
            ),
            (
                "environment".to_string(),
                Value::String(profile.environment.clone()),
            ),
        ]);
        if let Some(database) = request.database.as_ref() {
            target.insert("database".to_string(), Value::String(database.clone()));
        }
        if let Some(schema) = request.schema.as_ref() {
            target.insert("schema".to_string(), Value::String(schema.clone()));
        }

        Ok(serde_json::json!({
            "planId": handle.plan_id,
            "expiresAt": handle.expires_at_ms,
            "risk": {
                "level": analysis.risk_level,
                "reversible": analysis.reversible,
                "sideEffects": analysis.side_effects,
            },
            "permission": {
                "inputSummary": format!("在连接“{}”执行一条 SQL", profile.name),
                "confirmationPrompt": confirmation_prompt,
                "presentation": {
                    "target": Value::Object(target),
                    "riskReasons": analysis.reasons,
                    "sql": {
                        "text": request.sql,
                        "analysisStatus": analysis_status,
                        "statementClass": statement_class,
                    },
                    "timeoutMs": 30_000,
                    "maxResultBytes": 1024 * 1024,
                    "outcomeWarnings": outcome_warnings,
                },
            },
        }))
    }
}

struct SqlExecuteOperation {
    database: DatabaseState,
    runtime_manager: ConnectionRuntimeManager,
    prepared_plans: PreparedPlanRegistry,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SqlPlanRequest {
    plan_id: String,
}

#[async_trait]
impl GatewayOperation for SqlExecuteOperation {
    fn id(&self) -> &'static str {
        "sql.execute"
    }

    async fn execute(&self, _input: Value) -> BackendBridgeHandlerResult {
        Err(plan_error(
            "PLAN_MISMATCH",
            "Prepared SQL execution requires trusted execution context.",
        ))
    }

    async fn execute_with_context(
        &self,
        input: Value,
        context: Option<GatewayExecutionContext>,
    ) -> BackendBridgeHandlerResult {
        let Some(context) = context else {
            return Err(plan_error(
                "PLAN_MISMATCH",
                "Prepared SQL execution requires trusted execution context.",
            ));
        };
        let request: SqlPlanRequest = parse_request(input, self.id())?;
        let consumed = self
            .prepared_plans
            .consume(&request.plan_id, &context, self.id(), unix_time_ms())
            .map_err(map_plan_error)?;
        let prepared: PreparedSqlPayload = serde_json::from_value(consumed.exact_payload)
            .map_err(|_| plan_error("PLAN_MISMATCH", "Prepared SQL payload is invalid."))?;
        let (profile, snapshot) = require_sql_executor(
            &self.database,
            &self.runtime_manager,
            &consumed.profile_id,
            GatewayOutcome::NoEffect,
        )
        .await?;
        if profile.driver.as_str() != prepared.expected_driver
            || snapshot.runtime.driver_name != prepared.expected_driver
            || profile.updated_at != prepared.expected_profile_updated_at
            || sql_profile_read_only(&profile, GatewayOutcome::NoEffect)?
                != prepared.expected_read_only
        {
            return Err(GatewayError {
                code: "TARGET_CHANGED".to_string(),
                message: "The approved SQL target changed before execution.".to_string(),
                retryable: false,
                outcome: GatewayOutcome::NoEffect,
            });
        }
        ensure_read_only_sql_policy(
            prepared.expected_read_only,
            prepared.analysis_status,
            prepared.statement_class,
            GatewayOutcome::NoEffect,
        )?;

        let started = Instant::now();
        let clickhouse = prepared.expected_driver == "clickhouse";
        let response = if clickhouse {
            let result = application_service::execute_shared_managed_sql(
                &self.runtime_manager,
                &consumed.profile_id,
                StartSqlExecutionRequest {
                    context: SqlExecutionContext {
                        database: prepared.request.database.clone(),
                        schema: prepared.request.schema.clone(),
                    },
                    sql: prepared.request.sql.clone(),
                    options: SqlExecutionOptions {
                        result_mode: SqlResultMode::Grid,
                        timeout_ms: Some(30_000),
                        page: 1,
                        page_size: prepared.request.page_size,
                    },
                },
                clickhouse_statement_class(prepared.statement_class),
            )
            .await
            .map_err(map_sql_execute_ipc_error)?;
            let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
            managed_sql_execution_response(prepared, result, duration_ms)?
        } else {
            let result = application_service::execute_shared_sql(
                &self.runtime_manager,
                &consumed.profile_id,
                &SqlExecutionContext {
                    database: prepared.request.database.clone(),
                    schema: prepared.request.schema.clone(),
                },
                &prepared.request.sql,
                prepared.request.page_size,
            )
            .await
            .map_err(map_sql_execute_ipc_error)?;
            let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
            sql_execution_response(prepared, result, duration_ms)
        };
        serialize_response(response, self.id())
    }
}

#[async_trait]
impl GatewayOperation for PreparedPlanCleanupRunOperation {
    fn id(&self) -> &'static str {
        "prepared_plan.cleanup_run"
    }

    async fn execute(&self, _input: Value) -> BackendBridgeHandlerResult {
        Err(plan_error(
            "PLAN_MISMATCH",
            "Prepared plan cleanup requires trusted execution context.",
        ))
    }

    async fn execute_with_context(
        &self,
        input: Value,
        context: Option<GatewayExecutionContext>,
    ) -> BackendBridgeHandlerResult {
        let _: EmptyInternalRequest = parse_request(input, self.id())?;
        let Some(context) = context else {
            return Err(plan_error(
                "PLAN_MISMATCH",
                "Prepared plan cleanup requires trusted execution context.",
            ));
        };
        let removed = self.prepared_plans.clear_run(&context.run_id);
        serialize_response(PreparedPlanCleanupResponse { removed }, self.id())
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyInternalRequest {}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedPlanCleanupResponse {
    removed: usize,
}

struct ConnectionListOperation {
    database: DatabaseState,
    runtime_manager: ConnectionRuntimeManager,
}

#[async_trait]
impl GatewayOperation for ConnectionListOperation {
    fn id(&self) -> &'static str {
        "connection.list"
    }

    async fn execute(&self, input: Value) -> BackendBridgeHandlerResult {
        let _: ConnectionListRequest = parse_request(input, self.id())?;
        let records = application_service::list_connections(&self.database)
            .await
            .map_err(|_| read_error("Failed to list connection profiles."))?;
        let snapshots = self
            .runtime_manager
            .runtime_snapshots()
            .map_err(map_read_ipc_error)?;
        let connected = snapshots
            .into_iter()
            .map(|snapshot| (snapshot.profile_id, ()))
            .collect::<HashMap<_, _>>();
        serialize_response(
            ConnectionListResponse {
                connections: records
                    .iter()
                    .map(|record| {
                        ConnectionListItem::from_record(record, connected.contains_key(&record.id))
                    })
                    .collect(),
            },
            self.id(),
        )
    }
}

struct ConnectionGetOperation {
    database: DatabaseState,
    runtime_manager: ConnectionRuntimeManager,
}

#[async_trait]
impl GatewayOperation for ConnectionGetOperation {
    fn id(&self) -> &'static str {
        "connection.get"
    }

    async fn execute(&self, input: Value) -> BackendBridgeHandlerResult {
        let request: ConnectionGetRequest = parse_request(input, self.id())?;
        let record = application_service::require_connection(&self.database, &request.profile_id)
            .await
            .map_err(map_precondition_ipc_error)?;
        let runtime = optional_runtime_snapshot(&self.runtime_manager, &request.profile_id)?;
        serialize_response(
            ConnectionGetResponse {
                connection: ConnectionDetail::from_record(&record, runtime.as_ref()),
            },
            self.id(),
        )
    }
}

struct ConnectionOpenOperation {
    database: DatabaseState,
    runtime_manager: ConnectionRuntimeManager,
    event_sink: Arc<dyn WorkbenchRuntimeEventSink>,
}

#[async_trait]
impl GatewayOperation for ConnectionOpenOperation {
    fn id(&self) -> &'static str {
        "connection.open"
    }

    async fn execute(&self, input: Value) -> BackendBridgeHandlerResult {
        let request: ConnectionOpenRequest = parse_request(input, self.id())?;
        let opened = application_service::open_connection(
            &self.database,
            &self.runtime_manager,
            &request.profile_id,
            RuntimeChangeOrigin::AiRuntime,
            self.event_sink.as_ref(),
        )
        .await
        .map_err(map_open_ipc_error)?;
        serialize_response(
            ConnectionOpenResponse {
                connection: OpenedConnection::from_record(&opened.profile, &opened.snapshot),
                was_already_open: opened.was_already_open,
            },
            self.id(),
        )
    }
}

struct MetadataListChildrenOperation {
    database: DatabaseState,
    runtime_manager: ConnectionRuntimeManager,
}

#[async_trait]
impl GatewayOperation for MetadataListChildrenOperation {
    fn id(&self) -> &'static str {
        "metadata.list_children"
    }

    async fn execute(&self, input: Value) -> BackendBridgeHandlerResult {
        let request: MetadataListChildrenRequest = parse_request(input, self.id())?;
        require_schema_browser(&self.database, &self.runtime_manager, &request.profile_id).await?;
        let children = application_service::list_metadata_children(
            &self.runtime_manager,
            &request.profile_id,
            request.parent,
        )
        .await
        .map_err(map_read_ipc_error)?;
        let total = u64::try_from(children.len()).unwrap_or(u64::MAX);
        let start = usize::try_from(request.offset)
            .unwrap_or(usize::MAX)
            .min(children.len());
        let requested_end = request.offset.saturating_add(request.limit);
        let end = usize::try_from(requested_end)
            .unwrap_or(usize::MAX)
            .min(children.len());
        let next_offset = (end < children.len()).then(|| u64::try_from(end).unwrap_or(u64::MAX));

        serialize_response(
            MetadataListChildrenResponse {
                children: children
                    .into_iter()
                    .skip(start)
                    .take(end.saturating_sub(start))
                    .collect(),
                total,
                next_offset,
            },
            self.id(),
        )
    }
}

struct MetadataDescribeTableOperation {
    database: DatabaseState,
    runtime_manager: ConnectionRuntimeManager,
}

#[async_trait]
impl GatewayOperation for MetadataDescribeTableOperation {
    fn id(&self) -> &'static str {
        "metadata.describe_table"
    }

    async fn execute(&self, input: Value) -> BackendBridgeHandlerResult {
        let request: MetadataDescribeTableRequest = parse_request(input, self.id())?;
        require_schema_browser(&self.database, &self.runtime_manager, &request.profile_id).await?;
        let schema = application_service::describe_table(
            &self.runtime_manager,
            &request.profile_id,
            request.container.as_container_ref(),
        )
        .await
        .map_err(map_read_ipc_error)?;
        serialize_response(
            MetadataDescribeTableResponse {
                container: request.container,
                schema,
            },
            self.id(),
        )
    }
}

struct TableQueryOperation {
    database: DatabaseState,
    runtime_manager: ConnectionRuntimeManager,
}

#[async_trait]
impl GatewayOperation for TableQueryOperation {
    fn id(&self) -> &'static str {
        "table.query"
    }

    async fn execute(&self, input: Value) -> BackendBridgeHandlerResult {
        let request: TableQueryRequest = parse_request(input, self.id())?;
        request
            .validate()
            .map_err(|message| invalid_request(self.id(), message))?;
        require_data_table_browser(&self.database, &self.runtime_manager, &request.profile_id)
            .await?;

        let query = request.browse_query();
        let queried = application_service::query_table(
            &self.runtime_manager,
            &request.profile_id,
            request.source.as_container_ref(),
            request.page,
            request.page_size,
            &query,
        )
        .await
        .map_err(map_read_ipc_error)?;
        let response = TableQueryResponse::new(
            request.source,
            queried.result,
            queried.stats,
            request.page,
            request.page_size,
            &request.columns,
        )
        .map_err(|message| invalid_request(self.id(), message))?;
        serialize_response(response, self.id())
    }
}

struct KeyValueScanOperation {
    database: DatabaseState,
    runtime_manager: ConnectionRuntimeManager,
}

#[async_trait]
impl GatewayOperation for KeyValueScanOperation {
    fn id(&self) -> &'static str {
        "key_value.scan"
    }

    async fn execute(&self, input: Value) -> BackendBridgeHandlerResult {
        let request: KeyValueScanRequest = parse_request(input, self.id())?;
        request
            .validate()
            .map_err(|message| invalid_request(self.id(), message))?;
        require_key_value_browser(&self.database, &self.runtime_manager, &request.profile_id)
            .await?;
        let scan_request = request.scan_request();
        let result = application_service::scan_key_values(
            &self.runtime_manager,
            &request.profile_id,
            &scan_request,
        )
        .await
        .map_err(map_read_ipc_error)?;
        serialize_response(KeyValueScanResponse::new(request, result), self.id())
    }
}

struct KeyValueGetOperation {
    database: DatabaseState,
    runtime_manager: ConnectionRuntimeManager,
}

#[async_trait]
impl GatewayOperation for KeyValueGetOperation {
    fn id(&self) -> &'static str {
        "key_value.get"
    }

    async fn execute(&self, input: Value) -> BackendBridgeHandlerResult {
        let request: KeyValueGetRequest = parse_request(input, self.id())?;
        request
            .validate()
            .map_err(|message| invalid_request(self.id(), message))?;
        require_key_value_browser(&self.database, &self.runtime_manager, &request.profile_id)
            .await?;
        let value = application_service::get_key_value(
            &self.runtime_manager,
            &request.profile_id,
            &RedisKeyRef {
                db_index: request.db_index,
                key: request.key,
            },
        )
        .await
        .map_err(map_read_ipc_error)?;
        serialize_response(KeyValueGetResponse::from(value), self.id())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyValueMutationKind {
    Create,
    Set,
    Rename,
    SetTtl,
    Delete,
}

impl KeyValueMutationKind {
    fn prepare_operation(self) -> &'static str {
        match self {
            Self::Create => "key_value.prepare_create",
            Self::Set => "key_value.prepare_set",
            Self::Rename => "key_value.prepare_rename",
            Self::SetTtl => "key_value.prepare_set_ttl",
            Self::Delete => "key_value.prepare_delete",
        }
    }

    fn execute_operation(self) -> &'static str {
        match self {
            Self::Create => "key_value.create",
            Self::Set => "key_value.set",
            Self::Rename => "key_value.rename",
            Self::SetTtl => "key_value.set_ttl",
            Self::Delete => "key_value.delete",
        }
    }
}

#[derive(Debug, Clone)]
enum KeyValueToolInput {
    Create(KeyValueCreateToolRequest),
    Set(KeyValueSetToolRequest),
    Rename(KeyValueRenameToolRequest),
    SetTtl(KeyValueSetTtlToolRequest),
    Delete(KeyValueDeleteToolRequest),
}

impl KeyValueToolInput {
    fn parse(
        kind: KeyValueMutationKind,
        input: Value,
        operation: &str,
    ) -> Result<Self, GatewayError> {
        match kind {
            KeyValueMutationKind::Create => {
                let request: KeyValueCreateToolRequest = parse_request(input, operation)?;
                request
                    .validate()
                    .map_err(|message| invalid_request(operation, message))?;
                Ok(Self::Create(request))
            }
            KeyValueMutationKind::Set => {
                let request: KeyValueSetToolRequest = parse_request(input, operation)?;
                request
                    .validate()
                    .map_err(|message| invalid_request(operation, message))?;
                Ok(Self::Set(request))
            }
            KeyValueMutationKind::Rename => {
                let request: KeyValueRenameToolRequest = parse_request(input, operation)?;
                request
                    .validate()
                    .map_err(|message| invalid_request(operation, message))?;
                Ok(Self::Rename(request))
            }
            KeyValueMutationKind::SetTtl => {
                let request: KeyValueSetTtlToolRequest = parse_request(input, operation)?;
                request
                    .validate()
                    .map_err(|message| invalid_request(operation, message))?;
                Ok(Self::SetTtl(request))
            }
            KeyValueMutationKind::Delete => {
                let request: KeyValueDeleteToolRequest = parse_request(input, operation)?;
                request
                    .validate()
                    .map_err(|message| invalid_request(operation, message))?;
                Ok(Self::Delete(request))
            }
        }
    }

    fn profile_id(&self) -> &str {
        match self {
            Self::Create(request) => &request.profile_id,
            Self::Set(request) => &request.profile_id,
            Self::Rename(request) => &request.profile_id,
            Self::SetTtl(request) => &request.profile_id,
            Self::Delete(request) => &request.profile_id,
        }
    }

    fn db_index(&self) -> u8 {
        match self {
            Self::Create(request) => request.db_index,
            Self::Set(request) => request.db_index,
            Self::Rename(request) => request.db_index,
            Self::SetTtl(request) => request.db_index,
            Self::Delete(request) => request.db_index,
        }
    }

    fn key(&self) -> &str {
        match self {
            Self::Create(request) => &request.key,
            Self::Set(request) => &request.key,
            Self::Rename(request) => &request.key,
            Self::SetTtl(request) => &request.key,
            Self::Delete(request) => &request.key,
        }
    }
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(tag = "operation", content = "request", rename_all = "snake_case")]
enum PreparedKeyValueMutation {
    Create(RedisCreateKeyValueRequest),
    Set(RedisSetKeyValueRequest),
    Rename(RedisRenameKeyRequest),
    SetTtl(RedisSetKeyTtlRequest),
    Delete(RedisDeleteKeyRequest),
}

impl PreparedKeyValueMutation {
    fn kind(&self) -> KeyValueMutationKind {
        match self {
            Self::Create(_) => KeyValueMutationKind::Create,
            Self::Set(_) => KeyValueMutationKind::Set,
            Self::Rename(_) => KeyValueMutationKind::Rename,
            Self::SetTtl(_) => KeyValueMutationKind::SetTtl,
            Self::Delete(_) => KeyValueMutationKind::Delete,
        }
    }

    fn db_index(&self) -> u8 {
        match self {
            Self::Create(request) => request.db_index,
            Self::Set(request) => request.db_index,
            Self::Rename(request) => request.db_index,
            Self::SetTtl(request) => request.db_index,
            Self::Delete(request) => request.db_index,
        }
    }

    fn key(&self) -> &str {
        match self {
            Self::Create(request) => &request.key,
            Self::Set(request) => &request.key,
            Self::Rename(request) => &request.key,
            Self::SetTtl(request) => &request.key,
            Self::Delete(request) => &request.key,
        }
    }
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreparedKeyValuePayload {
    expected_driver: String,
    expected_profile_updated_at: i64,
    mutation: PreparedKeyValueMutation,
}

struct KeyValuePrepareOperation {
    kind: KeyValueMutationKind,
    database: DatabaseState,
    runtime_manager: ConnectionRuntimeManager,
    prepared_plans: PreparedPlanRegistry,
}

impl KeyValuePrepareOperation {
    fn new(
        kind: KeyValueMutationKind,
        database: DatabaseState,
        runtime_manager: ConnectionRuntimeManager,
        prepared_plans: PreparedPlanRegistry,
    ) -> Self {
        Self {
            kind,
            database,
            runtime_manager,
            prepared_plans,
        }
    }
}

#[async_trait]
impl GatewayOperation for KeyValuePrepareOperation {
    fn id(&self) -> &'static str {
        self.kind.prepare_operation()
    }

    async fn execute(&self, _input: Value) -> BackendBridgeHandlerResult {
        Err(plan_error(
            "PLAN_MISMATCH",
            "Key/Value preparation requires trusted execution context.",
        ))
    }

    async fn execute_with_context(
        &self,
        input: Value,
        context: Option<GatewayExecutionContext>,
    ) -> BackendBridgeHandlerResult {
        let Some(context) = context else {
            return Err(plan_error(
                "PLAN_MISMATCH",
                "Key/Value preparation requires trusted execution context.",
            ));
        };
        if context.tool_id != self.kind.execute_operation() {
            return Err(plan_error(
                "PLAN_MISMATCH",
                "Key/Value preparation context does not match the requested tool.",
            ));
        }

        let input = KeyValueToolInput::parse(self.kind, input, self.id())?;
        let profile_id = input.profile_id().to_string();
        let db_index = input.db_index();
        let key = input.key().to_string();
        let (profile, snapshot) = require_redis_key_value_browser(
            &self.database,
            &self.runtime_manager,
            &profile_id,
            GatewayOutcome::NotStarted,
        )
        .await?;

        let precondition = if self.kind == KeyValueMutationKind::Create {
            None
        } else {
            Some(
                application_service::get_key_precondition(
                    &self.runtime_manager,
                    &profile_id,
                    &RedisKeyRef {
                        db_index,
                        key: key.clone(),
                    },
                )
                .await
                .map_err(map_precondition_ipc_error)?,
            )
        };

        let mutation = match input {
            KeyValueToolInput::Create(request) => {
                PreparedKeyValueMutation::Create(request.mutation_request())
            }
            KeyValueToolInput::Set(request) => PreparedKeyValueMutation::Set(
                request.mutation_request(required_key_fingerprint(precondition.as_ref())?),
            ),
            KeyValueToolInput::Rename(request) => PreparedKeyValueMutation::Rename(
                request.mutation_request(required_key_fingerprint(precondition.as_ref())?),
            ),
            KeyValueToolInput::SetTtl(request) => PreparedKeyValueMutation::SetTtl(
                request.mutation_request(required_key_fingerprint(precondition.as_ref())?),
            ),
            KeyValueToolInput::Delete(request) => PreparedKeyValueMutation::Delete(
                request.mutation_request(required_key_fingerprint(precondition.as_ref())?),
            ),
        };

        let expires_at = unix_time_ms()
            .checked_add(DEFAULT_PREPARED_PLAN_TTL_MS)
            .ok_or_else(|| read_error("Prepared Key/Value plan expiry overflowed."))?;
        let exact_payload = serde_json::to_value(PreparedKeyValuePayload {
            expected_driver: snapshot.runtime.driver_name.clone(),
            expected_profile_updated_at: profile.updated_at,
            mutation: mutation.clone(),
        })
        .map_err(|_| read_error("Prepared Key/Value payload could not be serialized."))?;
        let handle = self
            .prepared_plans
            .prepare(PreparedPlanSpec {
                context,
                profile_id: profile_id.clone(),
                execute_operation: self.kind.execute_operation(),
                exact_payload,
                expires_at_ms: expires_at,
            })
            .map_err(map_plan_error)?;

        let presentation = key_value_permission_presentation(&mutation, precondition.as_ref());
        let (risk_level, reversible, side_effects, risk_reasons, confirmation_prompt) =
            key_value_permission_risk(&mutation);

        Ok(serde_json::json!({
            "planId": handle.plan_id,
            "expiresAt": handle.expires_at_ms,
            "risk": {
                "level": risk_level,
                "reversible": reversible,
                "sideEffects": side_effects,
            },
            "permission": {
                "inputSummary": key_value_input_summary(&mutation, &profile.name),
                "confirmationPrompt": confirmation_prompt,
                "presentation": {
                    "target": {
                        "profileId": profile_id,
                        "connectionName": profile.name,
                        "driver": profile.driver.as_str(),
                        "environment": profile.environment,
                        "redisDbIndex": mutation.db_index(),
                    },
                    "riskReasons": risk_reasons,
                    "keyValue": presentation,
                    "timeoutMs": 30_000,
                    "maxResultBytes": 256 * 1024,
                    "outcomeWarnings": [
                        "请求发出后的超时、连接中断或未知后端错误可能导致结果未知；系统不会自动重试。",
                        "审批后的 Key 值指纹或重命名目标发生漂移时，本次操作无效果并返回冲突。",
                    ],
                },
            },
        }))
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyValuePlanRequest {
    plan_id: String,
}

struct KeyValueExecuteOperation {
    kind: KeyValueMutationKind,
    database: DatabaseState,
    runtime_manager: ConnectionRuntimeManager,
    prepared_plans: PreparedPlanRegistry,
}

impl KeyValueExecuteOperation {
    fn new(
        kind: KeyValueMutationKind,
        database: DatabaseState,
        runtime_manager: ConnectionRuntimeManager,
        prepared_plans: PreparedPlanRegistry,
    ) -> Self {
        Self {
            kind,
            database,
            runtime_manager,
            prepared_plans,
        }
    }
}

#[async_trait]
impl GatewayOperation for KeyValueExecuteOperation {
    fn id(&self) -> &'static str {
        self.kind.execute_operation()
    }

    async fn execute(&self, _input: Value) -> BackendBridgeHandlerResult {
        Err(plan_error(
            "PLAN_MISMATCH",
            "Prepared Key/Value execution requires trusted execution context.",
        ))
    }

    async fn execute_with_context(
        &self,
        input: Value,
        context: Option<GatewayExecutionContext>,
    ) -> BackendBridgeHandlerResult {
        let Some(context) = context else {
            return Err(plan_error(
                "PLAN_MISMATCH",
                "Prepared Key/Value execution requires trusted execution context.",
            ));
        };
        let request: KeyValuePlanRequest = parse_request(input, self.id())?;
        let consumed = self
            .prepared_plans
            .consume(&request.plan_id, &context, self.id(), unix_time_ms())
            .map_err(map_plan_error)?;
        let prepared: PreparedKeyValuePayload = serde_json::from_value(consumed.exact_payload)
            .map_err(|_| plan_error("PLAN_MISMATCH", "Prepared Key/Value payload is invalid."))?;
        if prepared.mutation.kind() != self.kind {
            return Err(plan_error(
                "PLAN_MISMATCH",
                "Prepared Key/Value operation does not match the executor.",
            ));
        }
        let (profile, snapshot) = require_redis_key_value_browser(
            &self.database,
            &self.runtime_manager,
            &consumed.profile_id,
            GatewayOutcome::NoEffect,
        )
        .await?;
        if profile.driver.as_str() != prepared.expected_driver
            || snapshot.runtime.driver_name != prepared.expected_driver
            || profile.updated_at != prepared.expected_profile_updated_at
        {
            return Err(GatewayError {
                code: "TARGET_CHANGED".to_string(),
                message: "The approved Redis target changed before execution.".to_string(),
                retryable: false,
                outcome: GatewayOutcome::NoEffect,
            });
        }

        match prepared.mutation {
            PreparedKeyValueMutation::Create(request) => {
                let result = application_service::create_key_value(
                    &self.runtime_manager,
                    &consumed.profile_id,
                    &request,
                )
                .await
                .map_err(map_key_value_mutation_ipc_error)?;
                serialize_response(KeyValueMutationToolResponse::from(result), self.id())
            }
            PreparedKeyValueMutation::Set(request) => {
                let result = application_service::set_key_value(
                    &self.runtime_manager,
                    &consumed.profile_id,
                    &request,
                )
                .await
                .map_err(map_key_value_mutation_ipc_error)?;
                serialize_response(KeyValueMutationToolResponse::from(result), self.id())
            }
            PreparedKeyValueMutation::Rename(request) => {
                let result = application_service::rename_key(
                    &self.runtime_manager,
                    &consumed.profile_id,
                    &request,
                )
                .await
                .map_err(map_key_value_mutation_ipc_error)?;
                serialize_response(KeyValueMutationToolResponse::from(result), self.id())
            }
            PreparedKeyValueMutation::SetTtl(request) => {
                let result = application_service::set_key_ttl(
                    &self.runtime_manager,
                    &consumed.profile_id,
                    &request,
                )
                .await
                .map_err(map_key_value_mutation_ipc_error)?;
                serialize_response(KeyValueMutationToolResponse::from(result), self.id())
            }
            PreparedKeyValueMutation::Delete(request) => {
                let key = request.key.clone();
                let db_index = request.db_index;
                let result = application_service::delete_key(
                    &self.runtime_manager,
                    &consumed.profile_id,
                    &request,
                )
                .await
                .map_err(map_key_value_mutation_ipc_error)?;
                if result.deleted_count != 1 || result.key.as_deref() != Some(key.as_str()) {
                    return Err(GatewayError {
                        code: "OPERATION_OUTCOME_UNKNOWN".to_string(),
                        message: "Redis delete returned an unexpected outcome.".to_string(),
                        retryable: false,
                        outcome: GatewayOutcome::Unknown,
                    });
                }
                serialize_response(
                    KeyValueDeleteToolResponse {
                        db_index,
                        key,
                        deleted_count: 1,
                        mutation_state: "completed",
                    },
                    self.id(),
                )
            }
        }
    }
}

fn required_key_fingerprint(
    precondition: Option<&crate::engine::types::RedisKeyPrecondition>,
) -> Result<String, GatewayError> {
    precondition
        .map(|value| value.fingerprint.clone())
        .ok_or_else(|| read_error("Prepared Key/Value precondition is missing."))
}

fn redis_editable_value_type(value: &RedisEditableValue) -> &'static str {
    match value {
        RedisEditableValue::String(_) => "string",
        RedisEditableValue::Json(_) => "json",
        RedisEditableValue::Hash(_) => "hash",
        RedisEditableValue::List(_) => "list",
        RedisEditableValue::Set(_) => "set",
        RedisEditableValue::SortedSet(_) => "zset",
        RedisEditableValue::Stream(_) => "stream",
    }
}

fn key_value_permission_presentation(
    mutation: &PreparedKeyValueMutation,
    precondition: Option<&crate::engine::types::RedisKeyPrecondition>,
) -> Value {
    let (operation, new_key, value_type, ttl_mode, ttl_seconds) = match mutation {
        PreparedKeyValueMutation::Create(request) => (
            "create",
            None,
            Some(redis_editable_value_type(&request.value)),
            Some(if request.ttl_seconds.is_some() {
                "expire"
            } else {
                "persist"
            }),
            request.ttl_seconds,
        ),
        PreparedKeyValueMutation::Set(request) => (
            "set",
            None,
            Some(redis_editable_value_type(&request.value)),
            request.ttl_policy.as_ref().map(|policy| match policy {
                crate::engine::types::RedisTtlPolicy::Keep => "keep",
                crate::engine::types::RedisTtlPolicy::Persist => "persist",
                crate::engine::types::RedisTtlPolicy::Expire => "expire",
            }),
            request.ttl_seconds,
        ),
        PreparedKeyValueMutation::Rename(request) => (
            "rename",
            Some(request.new_key.as_str()),
            precondition.map(|value| value.value_type.as_str()),
            None,
            None,
        ),
        PreparedKeyValueMutation::SetTtl(request) => (
            "set_ttl",
            None,
            precondition.map(|value| value.value_type.as_str()),
            Some(match request.mode {
                RedisSetKeyTtlMode::Expire => "expire",
                RedisSetKeyTtlMode::Persist => "persist",
            }),
            request.ttl_seconds,
        ),
        PreparedKeyValueMutation::Delete(_) => (
            "delete",
            None,
            precondition.map(|value| value.value_type.as_str()),
            None,
            None,
        ),
    };
    let mut presentation = serde_json::Map::from_iter([
        (
            "operation".to_string(),
            Value::String(operation.to_string()),
        ),
        ("key".to_string(), Value::String(mutation.key().to_string())),
    ]);
    if let Some(new_key) = new_key {
        presentation.insert("newKey".to_string(), Value::String(new_key.to_string()));
    }
    if let Some(value_type) = value_type {
        presentation.insert(
            "valueType".to_string(),
            Value::String(value_type.to_string()),
        );
    }
    if let Some(ttl_mode) = ttl_mode {
        presentation.insert("ttlMode".to_string(), Value::String(ttl_mode.to_string()));
    }
    if let Some(ttl_seconds) = ttl_seconds {
        presentation.insert("ttlSeconds".to_string(), Value::Number(ttl_seconds.into()));
    }
    Value::Object(presentation)
}

fn key_value_input_summary(mutation: &PreparedKeyValueMutation, connection_name: &str) -> String {
    match mutation {
        PreparedKeyValueMutation::Create(request) => format!(
            "在连接“{connection_name}”的 Redis DB {} 创建 Key {}",
            request.db_index, request.key
        ),
        PreparedKeyValueMutation::Set(request) => format!(
            "在连接“{connection_name}”的 Redis DB {} 整体替换 Key {}",
            request.db_index, request.key
        ),
        PreparedKeyValueMutation::Rename(request) => format!(
            "在连接“{connection_name}”的 Redis DB {} 重命名 Key {} → {}",
            request.db_index, request.key, request.new_key
        ),
        PreparedKeyValueMutation::SetTtl(request) => format!(
            "在连接“{connection_name}”的 Redis DB {} 修改 Key {} 的 TTL",
            request.db_index, request.key
        ),
        PreparedKeyValueMutation::Delete(request) => format!(
            "在连接“{connection_name}”的 Redis DB {} 删除 Key {}",
            request.db_index, request.key
        ),
    }
}

fn key_value_permission_risk(
    mutation: &PreparedKeyValueMutation,
) -> (
    &'static str,
    bool,
    Vec<&'static str>,
    Vec<&'static str>,
    String,
) {
    match mutation {
        PreparedKeyValueMutation::Create(request) => (
            "high",
            false,
            vec!["business_write"],
            vec!["将在 Redis 中创建新的业务数据。"],
            format!(
                "确认在 Redis DB {} 中创建 Key {}",
                request.db_index, request.key
            ),
        ),
        PreparedKeyValueMutation::Set(request) => (
            "high",
            false,
            vec!["business_write"],
            vec!["将整体替换现有 Key 的类型化值。"],
            format!(
                "确认在 Redis DB {} 中替换 Key {}",
                request.db_index, request.key
            ),
        ),
        PreparedKeyValueMutation::Rename(request) => (
            "high",
            false,
            vec!["business_write"],
            vec!["将改变业务 Key 的名称和访问标识。"],
            format!(
                "确认在 Redis DB {} 中将 Key {} 重命名为 {}",
                request.db_index, request.key, request.new_key
            ),
        ),
        PreparedKeyValueMutation::SetTtl(request) if request.mode == RedisSetKeyTtlMode::Expire => {
            (
                "critical",
                false,
                vec!["business_write", "destructive"],
                vec!["设置过期时间会安排该 Key 在未来被永久删除。"],
                format!(
                    "确认将 Redis DB {} 中的 Key {} 设置为 {} 秒后过期",
                    request.db_index,
                    request.key,
                    request.ttl_seconds.unwrap_or_default()
                ),
            )
        }
        PreparedKeyValueMutation::SetTtl(request) => (
            "high",
            true,
            vec!["business_write"],
            vec!["移除 TTL 会改变业务数据的生命周期。"],
            format!(
                "确认移除 Redis DB {} 中 Key {} 的过期时间",
                request.db_index, request.key
            ),
        ),
        PreparedKeyValueMutation::Delete(request) => (
            "critical",
            false,
            vec!["business_write", "destructive"],
            vec!["该操作会永久删除一个精确 Redis Key。"],
            format!(
                "确认删除 Redis DB {} 中的 Key {}",
                request.db_index, request.key
            ),
        ),
    }
}

async fn require_schema_browser(
    database: &DatabaseState,
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
) -> Result<ConnectionRuntimeSnapshot, GatewayError> {
    application_service::require_connection(database, profile_id)
        .await
        .map_err(map_precondition_ipc_error)?;
    let snapshot = runtime_manager
        .runtime_snapshot(profile_id)
        .map_err(|error| {
            if error.code == ErrorCode::ResourceNotFound {
                GatewayError {
                    code: "CONNECTION_NOT_OPEN".to_string(),
                    message: "The connection is not open.".to_string(),
                    retryable: false,
                    outcome: GatewayOutcome::NotStarted,
                }
            } else {
                map_precondition_ipc_error(error)
            }
        })?;
    if !snapshot.runtime.capabilities.schema_browser {
        return Err(GatewayError {
            code: "CAPABILITY_UNAVAILABLE".to_string(),
            message: "This connection does not support metadata browsing.".to_string(),
            retryable: false,
            outcome: GatewayOutcome::NotStarted,
        });
    }
    Ok(snapshot)
}

async fn require_sql_executor(
    database: &DatabaseState,
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
    outcome: GatewayOutcome,
) -> Result<
    (
        crate::repository::connection_repository::StoredConnectionRecord,
        ConnectionRuntimeSnapshot,
    ),
    GatewayError,
> {
    let profile = application_service::require_connection(database, profile_id)
        .await
        .map_err(|error| with_outcome(map_precondition_ipc_error(error), outcome))?;
    let snapshot = runtime_manager
        .runtime_snapshot(profile_id)
        .map_err(|error| {
            if error.code == ErrorCode::ResourceNotFound {
                GatewayError {
                    code: "CONNECTION_NOT_OPEN".to_string(),
                    message: "The connection is not open.".to_string(),
                    retryable: false,
                    outcome,
                }
            } else {
                with_outcome(map_precondition_ipc_error(error), outcome)
            }
        })?;
    if !snapshot.runtime.capabilities.sql_executor {
        return Err(GatewayError {
            code: "CAPABILITY_UNAVAILABLE".to_string(),
            message: "This connection does not support SQL execution.".to_string(),
            retryable: false,
            outcome,
        });
    }
    Ok((profile, snapshot))
}

fn sql_profile_read_only(
    profile: &crate::repository::connection_repository::StoredConnectionRecord,
    outcome: GatewayOutcome,
) -> Result<bool, GatewayError> {
    let parsed = driver_profile_from_record(profile)
        .map_err(|error| with_outcome(map_precondition_ipc_error(error), outcome))?;
    match parsed {
        DriverProfile::Sqlite(profile) => Ok(profile.is_read_only),
        DriverProfile::Mysql(_)
        | DriverProfile::Postgres(_)
        | DriverProfile::Oracle(_)
        | DriverProfile::Clickhouse(_) => Ok(false),
        _ => Err(GatewayError {
            code: "CAPABILITY_UNAVAILABLE".to_string(),
            message: "SQL execution for this driver has not passed its safety enablement gate."
                .to_string(),
            retryable: false,
            outcome,
        }),
    }
}

fn ensure_read_only_sql_policy(
    read_only: bool,
    analysis_status: SqlAnalysisStatus,
    statement_class: SqlToolStatementClass,
    outcome: GatewayOutcome,
) -> Result<(), GatewayError> {
    if read_only
        && (analysis_status != SqlAnalysisStatus::Analyzed
            || statement_class != SqlToolStatementClass::Read)
    {
        return Err(GatewayError {
            code: "PERMISSION_DENIED".to_string(),
            message: "The read-only SQLite profile only permits SQL proven to be read-only."
                .to_string(),
            retryable: false,
            outcome,
        });
    }
    Ok(())
}

async fn require_data_table_browser(
    database: &DatabaseState,
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
) -> Result<ConnectionRuntimeSnapshot, GatewayError> {
    application_service::require_connection(database, profile_id)
        .await
        .map_err(map_precondition_ipc_error)?;
    let snapshot = runtime_manager
        .runtime_snapshot(profile_id)
        .map_err(|error| {
            if error.code == ErrorCode::ResourceNotFound {
                GatewayError {
                    code: "CONNECTION_NOT_OPEN".to_string(),
                    message: "The connection is not open.".to_string(),
                    retryable: false,
                    outcome: GatewayOutcome::NotStarted,
                }
            } else {
                map_precondition_ipc_error(error)
            }
        })?;
    if !snapshot.runtime.capabilities.data_table_browser {
        return Err(GatewayError {
            code: "CAPABILITY_UNAVAILABLE".to_string(),
            message: "This connection does not support structured table queries.".to_string(),
            retryable: false,
            outcome: GatewayOutcome::NotStarted,
        });
    }
    Ok(snapshot)
}

async fn require_key_value_browser(
    database: &DatabaseState,
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
) -> Result<ConnectionRuntimeSnapshot, GatewayError> {
    application_service::require_connection(database, profile_id)
        .await
        .map_err(map_precondition_ipc_error)?;
    let snapshot = runtime_manager
        .runtime_snapshot(profile_id)
        .map_err(|error| {
            if error.code == ErrorCode::ResourceNotFound {
                GatewayError {
                    code: "CONNECTION_NOT_OPEN".to_string(),
                    message: "The connection is not open.".to_string(),
                    retryable: false,
                    outcome: GatewayOutcome::NotStarted,
                }
            } else {
                map_precondition_ipc_error(error)
            }
        })?;
    if !snapshot.runtime.capabilities.key_value_browser {
        return Err(GatewayError {
            code: "CAPABILITY_UNAVAILABLE".to_string(),
            message: "This connection does not support Key/Value browsing.".to_string(),
            retryable: false,
            outcome: GatewayOutcome::NotStarted,
        });
    }
    Ok(snapshot)
}

async fn require_redis_key_value_browser(
    database: &DatabaseState,
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
    outcome: GatewayOutcome,
) -> Result<
    (
        crate::repository::connection_repository::StoredConnectionRecord,
        ConnectionRuntimeSnapshot,
    ),
    GatewayError,
> {
    let profile = application_service::require_connection(database, profile_id)
        .await
        .map_err(|error| with_outcome(map_precondition_ipc_error(error), outcome))?;
    if profile.driver.as_str() != "redis" {
        return Err(GatewayError {
            code: "CAPABILITY_UNAVAILABLE".to_string(),
            message: "Key/Value mutations are enabled only for Redis profiles.".to_string(),
            retryable: false,
            outcome,
        });
    }
    let snapshot = runtime_manager
        .runtime_snapshot(profile_id)
        .map_err(|error| {
            if error.code == ErrorCode::ResourceNotFound {
                GatewayError {
                    code: "CONNECTION_NOT_OPEN".to_string(),
                    message: "The Redis connection is not open.".to_string(),
                    retryable: false,
                    outcome,
                }
            } else {
                with_outcome(map_precondition_ipc_error(error), outcome)
            }
        })?;
    if snapshot.runtime.driver_name != "redis" || !snapshot.runtime.capabilities.key_value_browser {
        return Err(GatewayError {
            code: "CAPABILITY_UNAVAILABLE".to_string(),
            message: "This connection does not support Redis Key/Value mutations.".to_string(),
            retryable: false,
            outcome,
        });
    }
    Ok((profile, snapshot))
}

fn optional_runtime_snapshot(
    runtime_manager: &ConnectionRuntimeManager,
    profile_id: &str,
) -> Result<Option<ConnectionRuntimeSnapshot>, GatewayError> {
    match runtime_manager.runtime_snapshot(profile_id) {
        Ok(snapshot) => Ok(Some(snapshot)),
        Err(error) if error.code == ErrorCode::ResourceNotFound => Ok(None),
        Err(error) => Err(map_read_ipc_error(error)),
    }
}

fn parse_request<T: DeserializeOwned>(input: Value, operation: &str) -> Result<T, GatewayError> {
    serde_json::from_value(input).map_err(|_| GatewayError {
        code: "GATEWAY_INVALID_REQUEST".to_string(),
        message: format!("Invalid request for '{operation}'."),
        retryable: false,
        outcome: GatewayOutcome::NotStarted,
    })
}

fn invalid_request(operation: &str, message: &str) -> GatewayError {
    GatewayError {
        code: "GATEWAY_INVALID_REQUEST".to_string(),
        message: format!("Invalid request for '{operation}': {message}."),
        retryable: false,
        outcome: GatewayOutcome::NotStarted,
    }
}

fn serialize_response<T: Serialize>(output: T, operation: &str) -> BackendBridgeHandlerResult {
    serde_json::to_value(output).map_err(|_| {
        tauri_plugin_log::log::error!(
            "AI Runtime Gateway response serialization failed: operation={operation}"
        );
        read_error("Backend Gateway could not serialize the response.")
    })
}

fn map_precondition_ipc_error(error: IpcError) -> GatewayError {
    let mut mapped = map_ipc_error(error);
    mapped.outcome = GatewayOutcome::NotStarted;
    mapped
}

fn map_read_ipc_error(error: IpcError) -> GatewayError {
    let mut mapped = map_ipc_error(error);
    mapped.outcome = GatewayOutcome::NoEffect;
    mapped
}

fn map_open_ipc_error(error: IpcError) -> GatewayError {
    let code = error.code;
    let mut mapped = map_ipc_error(error);
    mapped.outcome = match code {
        ErrorCode::OperationOutcomeUnknown | ErrorCode::SystemInternal => GatewayOutcome::Unknown,
        ErrorCode::ResourceNotFound | ErrorCode::ValidationFailed | ErrorCode::ResourceConflict => {
            GatewayOutcome::NotStarted
        }
        _ => GatewayOutcome::NoEffect,
    };
    mapped
}

fn map_sql_execute_ipc_error(error: IpcError) -> GatewayError {
    let code = error.code;
    let mut mapped = map_ipc_error(error);
    mapped.outcome = match code {
        ErrorCode::NetworkTimeout
        | ErrorCode::OperationTimeout
        | ErrorCode::OperationOutcomeUnknown
        | ErrorCode::SystemInternal
        | ErrorCode::OperationCanceled => GatewayOutcome::Unknown,
        _ => GatewayOutcome::NoEffect,
    };
    mapped
}

fn map_key_value_mutation_ipc_error(error: IpcError) -> GatewayError {
    let code = error.code;
    let mut mapped = map_ipc_error(error);
    mapped.outcome = match code {
        ErrorCode::NetworkTimeout
        | ErrorCode::OperationTimeout
        | ErrorCode::OperationOutcomeUnknown
        | ErrorCode::SystemInternal
        | ErrorCode::OperationCanceled => GatewayOutcome::Unknown,
        _ => GatewayOutcome::NoEffect,
    };
    mapped.retryable = false;
    mapped
}

fn map_ipc_error(error: IpcError) -> GatewayError {
    let (code, retryable) = match error.code {
        ErrorCode::AuthFailed => ("AUTH_FAILED", false),
        ErrorCode::NetworkTimeout => ("NETWORK_TIMEOUT", true),
        ErrorCode::OperationTimeout => ("OPERATION_TIMEOUT", true),
        ErrorCode::OperationOutcomeUnknown => ("OPERATION_OUTCOME_UNKNOWN", false),
        ErrorCode::QuerySyntaxError => ("QUERY_SYNTAX_ERROR", false),
        ErrorCode::ResourceNotFound => ("RESOURCE_NOT_FOUND", false),
        ErrorCode::ValidationFailed => ("VALIDATION_FAILED", false),
        ErrorCode::ResourceConflict => ("RESOURCE_CONFLICT", false),
        ErrorCode::FeatureUnavailable => ("CAPABILITY_UNAVAILABLE", false),
        ErrorCode::PermissionDenied => ("PERMISSION_DENIED", false),
        ErrorCode::SystemInternal => ("SYSTEM_INTERNAL", false),
        ErrorCode::OperationCanceled => ("OPERATION_CANCELED", false),
    };
    GatewayError {
        code: code.to_string(),
        message: error.message,
        retryable,
        outcome: GatewayOutcome::NoEffect,
    }
}

fn read_error(message: &str) -> GatewayError {
    GatewayError {
        code: "SYSTEM_INTERNAL".to_string(),
        message: message.to_string(),
        retryable: false,
        outcome: GatewayOutcome::NoEffect,
    }
}

fn plan_error(code: &str, message: &str) -> GatewayError {
    GatewayError {
        code: code.to_string(),
        message: message.to_string(),
        retryable: false,
        outcome: GatewayOutcome::NotStarted,
    }
}

fn map_plan_error(error: PreparedPlanError) -> GatewayError {
    plan_error(error.code(), "Prepared plan validation failed.")
}

fn sql_rejected(message: &str) -> GatewayError {
    GatewayError {
        code: "SQL_ANALYSIS_REJECTED".to_string(),
        message: message.to_string(),
        retryable: false,
        outcome: GatewayOutcome::NotStarted,
    }
}

fn with_outcome(mut error: GatewayError, outcome: GatewayOutcome) -> GatewayError {
    error.outcome = outcome;
    error
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

fn sql_execution_response(
    prepared: PreparedSqlPayload,
    result: QueryResult,
    duration_ms: u64,
) -> Value {
    let affected_rows = result.affected_rows.map(json_safe_u64);
    let warnings = if prepared.analysis_status == SqlAnalysisStatus::Uncertain {
        vec!["The SQL was executed after conservative critical-risk analysis."]
    } else {
        Vec::new()
    };
    serde_json::json!({
        "executionId": format!("sql_exec_{}", uuid::Uuid::new_v4().simple()),
        "statementClass": prepared.statement_class.as_str(),
        "analysisStatus": match prepared.analysis_status {
            SqlAnalysisStatus::Analyzed => "analyzed",
            SqlAnalysisStatus::Uncertain => "uncertain",
        },
        "result": {
            "columns": result.columns,
            "rows": result.rows,
            "affectedRows": affected_rows,
            "hasNextPage": result.has_next_page,
        },
        "durationMs": duration_ms,
        "completionMessage": Value::Null,
        "mutationState": if prepared.statement_class.is_mutation() {
            "completed"
        } else {
            "not_applicable"
        },
        "warnings": warnings,
    })
}

fn clickhouse_statement_class(statement_class: SqlToolStatementClass) -> SqlStatementClass {
    match statement_class {
        SqlToolStatementClass::Read => SqlStatementClass::Read,
        SqlToolStatementClass::Insert => SqlStatementClass::Insert,
        SqlToolStatementClass::Update | SqlToolStatementClass::Mutation => {
            SqlStatementClass::Mutation
        }
        SqlToolStatementClass::Delete => SqlStatementClass::Delete,
        SqlToolStatementClass::Ddl => SqlStatementClass::Ddl,
        SqlToolStatementClass::Command => SqlStatementClass::Command,
        SqlToolStatementClass::Unknown => SqlStatementClass::Unknown,
    }
}

fn managed_sql_execution_response(
    prepared: PreparedSqlPayload,
    execution: SharedManagedSqlExecution,
    duration_ms: u64,
) -> Result<Value, GatewayError> {
    if execution.statement_class != clickhouse_statement_class(prepared.statement_class) {
        return Err(GatewayError {
            code: "SYSTEM_INTERNAL".to_string(),
            message: "Managed SQL execution returned a mismatched statement class.".to_string(),
            retryable: false,
            outcome: GatewayOutcome::Unknown,
        });
    }
    let mut warnings = execution.observation_warnings;
    if prepared.analysis_status == SqlAnalysisStatus::Uncertain {
        warnings
            .push("The SQL was executed after conservative critical-risk analysis.".to_string());
    }
    let (result, completion_message, mutation_state) = match execution.outcome {
        SqlExecutionOutcome::Rows { result } => (result, None, "not_applicable"),
        SqlExecutionOutcome::Command {
            completion_message,
            mutation_submitted,
            ..
        } => {
            let mutation_state = if mutation_submitted {
                "submitted"
            } else if prepared.statement_class.is_mutation() {
                "completed"
            } else {
                "not_applicable"
            };
            (
                QueryResult {
                    columns: Vec::new(),
                    rows: Vec::new(),
                    affected_rows: None,
                    has_next_page: false,
                    source_writable: false,
                    source_insertable: false,
                    primary_key_columns: Vec::new(),
                    stable_order_columns: Vec::new(),
                    row_locator_strategy: None,
                },
                Some(completion_message),
                mutation_state,
            )
        }
        SqlExecutionOutcome::Raw { .. } => {
            return Err(GatewayError {
                code: "SYSTEM_INTERNAL".to_string(),
                message: "Managed Grid SQL unexpectedly returned a Raw artifact.".to_string(),
                retryable: false,
                outcome: GatewayOutcome::Unknown,
            });
        }
    };
    let affected_rows = result.affected_rows.map(json_safe_u64);
    Ok(serde_json::json!({
        "executionId": execution.execution_id,
        "statementClass": prepared.statement_class.as_str(),
        "analysisStatus": match prepared.analysis_status {
            SqlAnalysisStatus::Analyzed => "analyzed",
            SqlAnalysisStatus::Uncertain => "uncertain",
        },
        "result": {
            "columns": result.columns,
            "rows": result.rows,
            "affectedRows": affected_rows,
            "hasNextPage": result.has_next_page,
        },
        "durationMs": duration_ms,
        "completionMessage": completion_message,
        "mutationState": mutation_state,
        "warnings": warnings,
    }))
}

fn json_safe_u64(value: u64) -> Value {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    if value <= MAX_SAFE_INTEGER {
        Value::from(value)
    } else {
        Value::String(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;
    use std::sync::{Arc, Mutex};

    use serde_json::{json, Value};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::{
        backend_gateway_operations, backend_gateway_operations_with_prepared_plans,
        managed_sql_execution_response, GatewayOutcome,
    };
    use crate::ai_runtime::backend_bridge::frames::GatewayExecutionContext;
    use crate::ai_runtime::backend_bridge::gateway::GatewayDispatcher;
    use crate::ai_runtime::backend_bridge::handler::BackendBridgeRequestHandler;
    use crate::ai_runtime::backend_bridge::prepared_plans::{
        PreparedPlanRegistry, PreparedPlanSpec,
    };
    use crate::ai_runtime::backend_bridge::sql::{
        PreparedSqlPayload, SqlAnalysisStatus, SqlToolRequest, SqlToolStatementClass,
    };
    use crate::db::DatabaseState;
    use crate::engine::manager::ConnectionRuntimeManager;
    use crate::engine::manager::SharedManagedSqlExecution;
    use crate::engine::types::{SqlExecutionOutcome, SqlStatementClass};
    use crate::error::IpcError;
    use crate::repository::connection_repository::{
        ConnectionDriver, ConnectionRepository, CreateConnectionInput,
    };
    use crate::workbench::runtime_events::{ConnectionRuntimeChanged, WorkbenchRuntimeEventSink};

    #[derive(Default)]
    struct RecordingEventSink {
        events: Mutex<Vec<ConnectionRuntimeChanged>>,
    }

    impl WorkbenchRuntimeEventSink for RecordingEventSink {
        fn publish(&self, event: ConnectionRuntimeChanged) -> Result<(), String> {
            self.events
                .lock()
                .map_err(|error| error.to_string())?
                .push(event);
            Ok(())
        }
    }

    async fn test_database() -> DatabaseState {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("SQLite memory options should parse")
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("test database should open");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("migrations should apply");
        DatabaseState { pool }
    }

    #[tokio::test]
    async fn registers_static_key_value_prepare_and_execute_operations() {
        let operations = backend_gateway_operations(
            test_database().await,
            ConnectionRuntimeManager::new(),
            Arc::new(RecordingEventSink::default()),
        );
        let ids = operations
            .iter()
            .map(|operation| operation.id())
            .collect::<Vec<_>>();

        for expected in [
            "key_value.prepare_create",
            "key_value.prepare_set",
            "key_value.prepare_rename",
            "key_value.prepare_set_ttl",
            "key_value.prepare_delete",
            "key_value.create",
            "key_value.set",
            "key_value.rename",
            "key_value.set_ttl",
            "key_value.delete",
        ] {
            assert!(ids.contains(&expected), "missing operation {expected}");
        }
        assert!(!ids.contains(&"key_value.delete_prefix"));
        assert!(!ids.contains(&"key_value.command"));
    }

    #[test]
    fn key_value_mutation_conflicts_are_no_effect_and_never_retryable() {
        let error = super::map_key_value_mutation_ipc_error(IpcError::resource_conflict(
            "Redis key changed",
        ));

        assert_eq!(error.code, "RESOURCE_CONFLICT");
        assert!(!error.retryable);
        assert!(matches!(error.outcome, GatewayOutcome::NoEffect));
    }

    #[tokio::test]
    async fn clears_prepared_plans_only_for_the_trusted_run_context() {
        let database = test_database().await;
        let registry = PreparedPlanRegistry::default();
        let context = GatewayExecutionContext {
            conversation_id: "conv_1".to_string(),
            run_id: "run_1".to_string(),
            message_id: "msg_1".to_string(),
            tool_call_id: "tool_1".to_string(),
            tool_id: "sql.execute".to_string(),
        };
        registry
            .prepare(PreparedPlanSpec {
                context: context.clone(),
                profile_id: "profile_1".to_string(),
                execute_operation: "sql.execute",
                exact_payload: json!({ "sql": "DELETE FROM users" }),
                expires_at_ms: u64::MAX,
            })
            .expect("plan should prepare");
        let dispatcher = GatewayDispatcher::new(backend_gateway_operations_with_prepared_plans(
            database,
            ConnectionRuntimeManager::new(),
            Arc::new(RecordingEventSink::default()),
            registry.clone(),
        ))
        .expect("Gateway registry should build")
        .with_prepared_plans(registry.clone());

        let response = dispatcher
            .handle_with_context("prepared_plan.cleanup_run", json!({}), Some(context))
            .await
            .expect("cleanup should succeed");
        assert_eq!(response["removed"], 1);
        assert_eq!(registry.len(), 0);

        let error = dispatcher
            .handle("prepared_plan.cleanup_run", json!({}))
            .await
            .expect_err("untrusted cleanup must fail");
        assert_eq!(error.code, "PLAN_MISMATCH");
    }

    async fn create_connection(
        database: &DatabaseState,
        id: &str,
        driver: ConnectionDriver,
        payload: Value,
    ) -> crate::repository::connection_repository::StoredConnectionRecord {
        ConnectionRepository::create(
            &database.pool,
            CreateConnectionInput {
                id: id.to_string(),
                name: "Gateway Test".to_string(),
                driver,
                environment: "development".to_string(),
                color: Some("#123456".to_string()),
                tag_label: "测试".to_string(),
                tag_color: Some("sky".to_string()),
                payload,
                folder_id: None,
                sort_order: Some(1),
            },
        )
        .await
        .expect("connection should be created")
    }

    #[tokio::test]
    async fn dispatches_connection_operations_over_shared_repository_state() {
        let database = test_database().await;
        create_connection(
            &database,
            "profile-1",
            ConnectionDriver::Mysql,
            json!({
                "host": "10.0.0.8",
                "port": 3306,
                "username": "developer",
                "password": "database-password-sentinel"
            }),
        )
        .await;
        let dispatcher = GatewayDispatcher::new(backend_gateway_operations(
            database,
            ConnectionRuntimeManager::new(),
            Arc::new(RecordingEventSink::default()),
        ))
        .expect("Gateway registry should build");

        let listed = dispatcher
            .handle("connection.list", json!({}))
            .await
            .expect("connection.list should succeed");
        let detail = dispatcher
            .handle("connection.get", json!({ "profileId": "profile-1" }))
            .await
            .expect("connection.get should succeed");
        let serialized = format!("{listed}{detail}");

        assert_eq!(listed["connections"][0]["profileId"], "profile-1");
        assert_eq!(detail["connection"]["settings"]["host"], "10.0.0.8");
        assert!(!serialized.contains("database-password-sentinel"));
        assert_eq!(
            dispatcher
                .handle("connection.get", json!({ "profileId": "missing" }))
                .await
                .expect_err("missing profile should fail")
                .code,
            "RESOURCE_NOT_FOUND"
        );
        let missing_open = dispatcher
            .handle("connection.open", json!({ "profileId": "missing" }))
            .await
            .expect_err("missing profile must not start a connection");
        assert_eq!(missing_open.code, "RESOURCE_NOT_FOUND");
        assert!(matches!(missing_open.outcome, GatewayOutcome::NotStarted));
    }

    #[tokio::test]
    async fn metadata_operations_share_the_active_sqlite_runtime() {
        let database = test_database().await;
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("gateway.sqlite3");
        let target_options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let target_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(target_options)
            .await
            .expect("target SQLite should open");
        sqlx::query(
            "CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                active INTEGER NOT NULL
            )",
        )
        .execute(&target_pool)
        .await
        .expect("fixture table should be created");
        sqlx::query(
            "INSERT INTO users (id, name, active) VALUES
                (1, 'Ada', 1),
                (2, 'Grace', 1),
                (3, 'Linus', 0)",
        )
        .execute(&target_pool)
        .await
        .expect("fixture rows should be created");
        target_pool.close().await;

        create_connection(
            &database,
            "sqlite-profile",
            ConnectionDriver::Sqlite,
            json!({
                "dbFilePath": path.to_string_lossy(),
                "isReadOnly": true
            }),
        )
        .await;
        let runtime_manager = ConnectionRuntimeManager::new();
        let event_sink = Arc::new(RecordingEventSink::default());
        let dispatcher = GatewayDispatcher::new(backend_gateway_operations(
            database,
            runtime_manager.clone(),
            event_sink.clone(),
        ))
        .expect("Gateway registry should build");

        let opened = dispatcher
            .handle("connection.open", json!({ "profileId": "sqlite-profile" }))
            .await
            .expect("connection.open should create the shared runtime");
        assert_eq!(opened["connection"]["profileId"], "sqlite-profile");
        assert_eq!(opened["connection"]["connected"], true);
        assert_eq!(opened["connection"]["runtime"]["healthStatus"], "healthy");
        assert_eq!(opened["wasAlreadyOpen"], false);
        assert_eq!(
            dispatcher
                .handle("connection.open", json!({ "profileId": "sqlite-profile" }))
                .await
                .expect("connection.open should reuse the shared runtime")["wasAlreadyOpen"],
            true
        );
        {
            let events = event_sink.events.lock().expect("events should lock");
            assert_eq!(events.len(), 2);
            assert!(events.iter().all(|event| matches!(
                event,
                ConnectionRuntimeChanged::Upsert {
                    origin: crate::workbench::runtime_events::RuntimeChangeOrigin::AiRuntime,
                    ..
                }
            )));
        }
        assert_eq!(
            runtime_manager
                .runtime_snapshots()
                .expect("runtime snapshots should list")
                .len(),
            1
        );

        let root = dispatcher
            .handle(
                "metadata.list_children",
                json!({ "profileId": "sqlite-profile", "offset": 0, "limit": 100 }),
            )
            .await
            .expect("metadata root should list");
        assert_eq!(root["total"], 1);
        assert_eq!(root["children"][0]["kind"], "database");

        let described = dispatcher
            .handle(
                "metadata.describe_table",
                json!({
                    "profileId": "sqlite-profile",
                    "container": {
                        "kind": "table",
                        "groupType": null,
                        "database": path.file_stem().and_then(|value| value.to_str()),
                        "schema": null,
                        "table": "users",
                        "column": null,
                        "objectName": null,
                        "dbIndex": null,
                        "key": null,
                        "pattern": null
                    }
                }),
            )
            .await
            .expect("SQLite table should describe");
        assert_eq!(described["schema"]["basics"]["tableName"], "users");
        assert_eq!(described["schema"]["columns"][0]["name"], "id");

        let table_query_source = json!({
            "kind": "table",
            "groupType": null,
            "database": path.file_stem().and_then(|value| value.to_str()),
            "schema": null,
            "table": "users",
            "column": null,
            "objectName": null,
            "dbIndex": null,
            "key": null,
            "pattern": null
        });
        let queried = dispatcher
            .handle(
                "table.query",
                json!({
                    "profileId": "sqlite-profile",
                    "source": table_query_source,
                    "columns": ["name", "id"],
                    "filters": [{
                        "column": "active",
                        "operator": "eq",
                        "value": 1
                    }],
                    "sort": [{
                        "column": "id",
                        "direction": "desc"
                    }],
                    "page": 1,
                    "pageSize": 1
                }),
            )
            .await
            .expect("structured table query should use the shared runtime");
        assert_eq!(queried["columns"][0]["name"], "name");
        assert_eq!(queried["columns"][1]["name"], "id");
        assert_eq!(queried["rows"], json!([["Grace", 2]]));
        assert_eq!(queried["totalRows"], 2);
        assert_eq!(queried["totalPages"], 2);
        assert_eq!(queried["hasNextPage"], true);

        let injection_attempt = dispatcher
            .handle(
                "table.query",
                json!({
                    "profileId": "sqlite-profile",
                    "source": {
                        "kind": "table",
                        "database": path.file_stem().and_then(|value| value.to_str()),
                        "table": "users"
                    },
                    "filters": [{
                        "column": "name",
                        "operator": "eq",
                        "value": "Ada' OR 1=1 --"
                    }]
                }),
            )
            .await
            .expect("filter values should be bound instead of becoming SQL");
        assert_eq!(injection_attempt["rows"], json!([]));
        assert_eq!(injection_attempt["totalRows"], 0);

        let unsupported_key_value = dispatcher
            .handle(
                "key_value.scan",
                json!({
                    "profileId": "sqlite-profile",
                    "dbIndex": 0
                }),
            )
            .await
            .expect_err("SQLite should not expose KeyValueBrowser");
        assert_eq!(unsupported_key_value.code, "CAPABILITY_UNAVAILABLE");
        assert!(matches!(
            unsupported_key_value.outcome,
            GatewayOutcome::NotStarted
        ));

        runtime_manager
            .disconnect_profile("sqlite-profile")
            .await
            .expect("shared SQLite runtime should close");
    }

    #[tokio::test]
    async fn sql_analyze_and_execute_use_one_approved_plan_without_retry() {
        let database = test_database().await;
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("sql-tool.sqlite3");
        let target_options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let target_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(target_options)
            .await
            .expect("target SQLite should open");
        sqlx::query("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
            .execute(&target_pool)
            .await
            .expect("fixture table should be created");
        target_pool.close().await;

        create_connection(
            &database,
            "sql-profile",
            ConnectionDriver::Sqlite,
            json!({
                "dbFilePath": path.to_string_lossy(),
                "isReadOnly": false
            }),
        )
        .await;
        create_connection(
            &database,
            "sql-readonly-profile",
            ConnectionDriver::Sqlite,
            json!({
                "dbFilePath": path.to_string_lossy(),
                "isReadOnly": true
            }),
        )
        .await;
        let runtime_manager = ConnectionRuntimeManager::new();
        let prepared_plans = PreparedPlanRegistry::default();
        let dispatcher = GatewayDispatcher::new(backend_gateway_operations_with_prepared_plans(
            database,
            runtime_manager.clone(),
            Arc::new(RecordingEventSink::default()),
            prepared_plans.clone(),
        ))
        .expect("Gateway registry should build")
        .with_prepared_plans(prepared_plans.clone());
        dispatcher
            .handle("connection.open", json!({ "profileId": "sql-profile" }))
            .await
            .expect("connection should open explicitly");
        dispatcher
            .handle(
                "connection.open",
                json!({ "profileId": "sql-readonly-profile" }),
            )
            .await
            .expect("read-only connection should open explicitly");

        let context = GatewayExecutionContext {
            conversation_id: "conv_sql".to_string(),
            run_id: "run_sql".to_string(),
            message_id: "msg_sql".to_string(),
            tool_call_id: "tool_sql".to_string(),
            tool_id: "sql.execute".to_string(),
        };
        let rejected = dispatcher
            .handle_with_context(
                "sql.analyze",
                json!({
                    "profileId": "sql-profile",
                    "sql": "SELECT 1; SELECT 2",
                    "pageSize": 50
                }),
                Some(context.clone()),
            )
            .await
            .expect_err("multi-statement SQL must be rejected");
        assert_eq!(rejected.code, "SQL_ANALYSIS_REJECTED");
        assert_eq!(prepared_plans.len(), 0);

        let read_only_denied = dispatcher
            .handle_with_context(
                "sql.analyze",
                json!({
                    "profileId": "sql-readonly-profile",
                    "sql": "UPDATE users SET name = 'changed' WHERE id = 1",
                    "pageSize": 50
                }),
                Some(GatewayExecutionContext {
                    tool_call_id: "tool_sql_readonly".to_string(),
                    ..context.clone()
                }),
            )
            .await
            .expect_err("read-only SQLite must reject mutation before preparing");
        assert_eq!(read_only_denied.code, "PERMISSION_DENIED");
        assert!(matches!(
            read_only_denied.outcome,
            GatewayOutcome::NotStarted
        ));
        assert_eq!(prepared_plans.len(), 0);

        let analyzed = dispatcher
            .handle_with_context(
                "sql.analyze",
                json!({
                    "profileId": "sql-profile",
                    "sql": "INSERT INTO users (id, name) VALUES (1, 'Ada')",
                    "pageSize": 50
                }),
                Some(context.clone()),
            )
            .await
            .expect("single INSERT should prepare");
        assert_eq!(analyzed["risk"]["level"], "high");
        assert_eq!(
            analyzed["permission"]["presentation"]["sql"]["analysisStatus"],
            "analyzed"
        );
        assert_eq!(
            analyzed["permission"]["presentation"]["sql"]["text"],
            "INSERT INTO users (id, name) VALUES (1, 'Ada')"
        );
        let target = analyzed["permission"]["presentation"]["target"]
            .as_object()
            .expect("permission target should be an object");
        assert!(!target.contains_key("database"));
        assert!(!target.contains_key("schema"));
        assert_eq!(prepared_plans.len(), 1);

        let plan_id = analyzed["planId"]
            .as_str()
            .expect("plan id should exist")
            .to_string();
        let mismatched = dispatcher
            .handle_with_context(
                "sql.execute",
                json!({ "planId": plan_id }),
                Some(GatewayExecutionContext {
                    tool_call_id: "tool_other".to_string(),
                    ..context.clone()
                }),
            )
            .await
            .expect_err("another ToolCall must not consume the plan");
        assert_eq!(mismatched.code, "PLAN_MISMATCH");

        let executed = dispatcher
            .handle_with_context(
                "sql.execute",
                json!({ "planId": plan_id }),
                Some(context.clone()),
            )
            .await
            .expect("approved plan should execute");
        assert_eq!(executed["statementClass"], "insert");
        assert_eq!(executed["result"]["affectedRows"], 1);
        assert_eq!(executed["mutationState"], "completed");

        let repeated = dispatcher
            .handle_with_context(
                "sql.execute",
                json!({ "planId": plan_id }),
                Some(context.clone()),
            )
            .await
            .expect_err("plan must be single consume");
        assert_eq!(repeated.code, "PLAN_ALREADY_CONSUMED");

        let uncertain_context = GatewayExecutionContext {
            tool_call_id: "tool_sql_read".to_string(),
            ..context.clone()
        };
        let uncertain = dispatcher
            .handle_with_context(
                "sql.analyze",
                json!({
                    "profileId": "sql-profile",
                    "sql": "WITH picked AS (SELECT * FROM users) SELECT * FROM picked",
                    "pageSize": 50
                }),
                Some(uncertain_context.clone()),
            )
            .await
            .expect("bounded but imprecise SQL should prepare conservatively");
        assert_eq!(uncertain["risk"]["level"], "critical");
        assert_eq!(
            uncertain["permission"]["presentation"]["sql"]["analysisStatus"],
            "uncertain"
        );
        assert_eq!(
            uncertain["risk"]["sideEffects"],
            json!(["business_read", "business_write", "destructive"])
        );
        let uncertain_plan = uncertain["planId"]
            .as_str()
            .expect("uncertain plan should exist");
        let selected = dispatcher
            .handle_with_context(
                "sql.execute",
                json!({ "planId": uncertain_plan }),
                Some(uncertain_context),
            )
            .await
            .expect("strong-confirmed uncertain plan should execute once");
        assert_eq!(selected["result"]["rows"], json!([[1, "Ada"]]));
        assert_eq!(selected["warnings"].as_array().map(Vec::len), Some(1));

        let stale_context = GatewayExecutionContext {
            tool_call_id: "tool_sql_stale".to_string(),
            ..context
        };
        let stale = dispatcher
            .handle_with_context(
                "sql.analyze",
                json!({
                    "profileId": "sql-profile",
                    "sql": "SELECT 1",
                    "pageSize": 50
                }),
                Some(stale_context.clone()),
            )
            .await
            .expect("read should prepare");
        runtime_manager
            .disconnect_profile("sql-profile")
            .await
            .expect("connection should disconnect");
        let stale_error = dispatcher
            .handle_with_context(
                "sql.execute",
                json!({ "planId": stale["planId"] }),
                Some(stale_context),
            )
            .await
            .expect_err("stale target must fail without effect");
        assert_eq!(stale_error.code, "CONNECTION_NOT_OPEN");
        assert!(matches!(stale_error.outcome, GatewayOutcome::NoEffect));
    }

    #[tokio::test]
    async fn metadata_does_not_open_disconnected_connections_implicitly() {
        let database = test_database().await;
        create_connection(
            &database,
            "profile-1",
            ConnectionDriver::Mysql,
            json!({ "host": "127.0.0.1" }),
        )
        .await;
        let dispatcher = GatewayDispatcher::new(backend_gateway_operations(
            database,
            ConnectionRuntimeManager::new(),
            Arc::new(RecordingEventSink::default()),
        ))
        .expect("Gateway registry should build");

        let error = dispatcher
            .handle(
                "metadata.list_children",
                json!({ "profileId": "profile-1" }),
            )
            .await
            .expect_err("disconnected profile must fail");

        assert_eq!(error.code, "CONNECTION_NOT_OPEN");
        assert!(!error.retryable);

        let key_value_error = dispatcher
            .handle(
                "key_value.get",
                json!({
                    "profileId": "profile-1",
                    "dbIndex": 0,
                    "key": "session:1"
                }),
            )
            .await
            .expect_err("disconnected profile must fail before Key/Value execution");
        assert_eq!(key_value_error.code, "CONNECTION_NOT_OPEN");
        assert!(matches!(
            key_value_error.outcome,
            GatewayOutcome::NotStarted
        ));
    }

    #[test]
    fn maps_unsupported_driver_behavior_to_gateway_capability_error() {
        let error = super::map_read_ipc_error(IpcError::feature_unavailable(
            "Table schema description is not supported.",
        ));

        assert_eq!(error.code, "CAPABILITY_UNAVAILABLE");
        assert!(!error.retryable);
    }

    #[test]
    fn clickhouse_managed_response_preserves_async_mutation_submission() {
        let prepared = PreparedSqlPayload {
            request: SqlToolRequest {
                profile_id: "clickhouse-profile".to_string(),
                database: Some("analytics".to_string()),
                schema: None,
                sql: "ALTER TABLE events DELETE WHERE id = 1".to_string(),
                page_size: 50,
            },
            expected_driver: "clickhouse".to_string(),
            expected_profile_updated_at: 1,
            expected_read_only: false,
            analysis_status: SqlAnalysisStatus::Analyzed,
            statement_class: SqlToolStatementClass::Mutation,
        };
        let response = managed_sql_execution_response(
            prepared,
            SharedManagedSqlExecution {
                execution_id: "managed-execution".to_string(),
                statement_class: SqlStatementClass::Mutation,
                outcome: SqlExecutionOutcome::Command {
                    statement_class: SqlStatementClass::Mutation,
                    completion_message: "Mutation 请求已提交".to_string(),
                    summary: None,
                    mutation_submitted: true,
                },
                observation_warnings: vec!["progress unavailable".to_string()],
            },
            12,
        )
        .expect("managed mutation response should serialize");

        assert_eq!(response["executionId"], "managed-execution");
        assert_eq!(response["statementClass"], "mutation");
        assert_eq!(response["mutationState"], "submitted");
        assert_eq!(response["completionMessage"], "Mutation 请求已提交");
        assert_eq!(response["result"]["rows"], json!([]));
        assert_eq!(response["warnings"], json!(["progress unavailable"]));
    }
}
