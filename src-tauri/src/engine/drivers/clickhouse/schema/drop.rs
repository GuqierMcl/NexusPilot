#![allow(dead_code)]

use std::future::pending;
use std::time::Duration;

use async_trait::async_trait;
use clickhouse::error::Error as ClickHouseError;
use serde::Deserialize;
use tokio::sync::watch;
use uuid::Uuid;

use crate::engine::drivers::clickhouse::ClickHouseDriver;
use crate::engine::native_schema::{
    NativeSchemaChangeBaseline, NativeSchemaChangePlan, NativeSchemaChangeTarget,
    NativeSchemaExecuteChangeRequest, NativeSchemaExecutionStatus, NativeSchemaOperationSummary,
    NativeSchemaRequiredConfirmation, NativeSchemaRiskFlag, NativeSchemaStatementProgress,
};
use crate::engine::types::{ContainerKind, ContainerRef};
use crate::error::{ErrorCode, IpcError, IpcResult};

use super::change_runtime::validate_native_schema_confirmation;
use super::change_types::{
    ClickHouseDatabaseBaseline, ClickHouseDatabaseObjectBaseline, ClickHouseDropDatabaseResult,
    ClickHouseDropDatabaseTarget, ClickHouseDropTableResult, ClickHouseDropTableTarget,
};
use super::create_render::{plan_hash, quote_identifier};
use super::describe::describe_table;
use super::schema_compare::table_baselines_equal;
use super::types::ClickHouseTableSchema;

const DROP_TABLE_HASH_DOMAIN: &str = "nexpilot/native-schema/clickhouse/drop-table/v1";
const DROP_DATABASE_HASH_DOMAIN: &str = "nexpilot/native-schema/clickhouse/drop-database/v1";
const PHASE_FIVE_C_TABLE_ENGINES: &[&str] = &[
    "MergeTree",
    "ReplacingMergeTree",
    "SummingMergeTree",
    "AggregatingMergeTree",
    "CollapsingMergeTree",
    "VersionedCollapsingMergeTree",
];

#[derive(Debug, Clone, PartialEq, Eq, clickhouse::Row, Deserialize)]
struct DatabaseIdentityRow {
    name: String,
    engine: String,
    uuid: String,
}

#[derive(Debug, Clone, PartialEq, Eq, clickhouse::Row, Deserialize)]
struct DatabaseObjectRow {
    name: String,
    engine: String,
    uuid: String,
    create_table_query: String,
}

#[derive(Debug, clickhouse::Row, Deserialize)]
struct ObjectCountRow {
    count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DropCommandRequest {
    statement: String,
    query_id: String,
    settings: Vec<(&'static str, String)>,
}

impl DropCommandRequest {
    fn new(statement: String, timeout: Duration) -> Self {
        Self {
            statement,
            query_id: Uuid::new_v4().to_string(),
            settings: vec![
                ("wait_end_of_query", "1".to_string()),
                ("max_execution_time", timeout.as_secs().max(1).to_string()),
            ],
        }
    }

    fn has_setting(&self, name: &str, value: &str) -> bool {
        self.settings
            .iter()
            .any(|(candidate, candidate_value)| *candidate == name && candidate_value == value)
    }
}

#[async_trait]
trait DropBackend: Send + Sync {
    async fn execute_statement(&self, request: &DropCommandRequest) -> Result<(), ClickHouseError>;

    async fn describe_table(&self, container: &ContainerRef) -> IpcResult<ClickHouseTableSchema>;

    async fn database_identity_rows(&self, name: &str) -> IpcResult<Vec<DatabaseIdentityRow>>;

    async fn database_object_rows(&self, name: &str) -> IpcResult<Vec<DatabaseObjectRow>>;

    async fn table_exists(&self, container: &ContainerRef) -> IpcResult<bool>;

    async fn database_exists(&self, name: &str) -> IpcResult<bool>;
}

struct DriverDropBackend<'a> {
    driver: &'a ClickHouseDriver,
}

#[async_trait]
impl DropBackend for DriverDropBackend<'_> {
    async fn execute_statement(&self, request: &DropCommandRequest) -> Result<(), ClickHouseError> {
        let mut query = self
            .driver
            .client
            .query(&request.statement)
            .with_setting("query_id", &request.query_id);
        for (name, value) in &request.settings {
            query = query.with_setting(*name, value);
        }
        query.execute().await
    }

    async fn describe_table(&self, container: &ContainerRef) -> IpcResult<ClickHouseTableSchema> {
        describe_table(self.driver, container).await
    }

    async fn database_identity_rows(&self, name: &str) -> IpcResult<Vec<DatabaseIdentityRow>> {
        const SQL: &str =
            "SELECT name, engine, toString(uuid) AS uuid FROM system.databases WHERE name = ?";
        let request = self
            .driver
            .client
            .query(SQL)
            .bind(name)
            .fetch_all::<DatabaseIdentityRow>();
        match tokio::time::timeout(self.driver.timeout, request).await {
            Ok(result) => result.map_err(|error| {
                crate::engine::drivers::clickhouse::error::classify_metadata_error(
                    error,
                    "read database drop baseline",
                )
            }),
            Err(_) => Err(catalog_timeout(
                "read_database_drop_baseline",
                self.driver.timeout,
            )),
        }
    }

    async fn database_object_rows(&self, name: &str) -> IpcResult<Vec<DatabaseObjectRow>> {
        const SQL: &str = "SELECT name, engine, toString(uuid) AS uuid, create_table_query FROM system.tables WHERE database = ? ORDER BY name";
        let request = self
            .driver
            .client
            .query(SQL)
            .bind(name)
            .fetch_all::<DatabaseObjectRow>();
        match tokio::time::timeout(self.driver.timeout, request).await {
            Ok(result) => result.map_err(|error| {
                crate::engine::drivers::clickhouse::error::classify_metadata_error(
                    error,
                    "read database object drop baseline",
                )
            }),
            Err(_) => Err(catalog_timeout(
                "read_database_object_drop_baseline",
                self.driver.timeout,
            )),
        }
    }

    async fn table_exists(&self, container: &ContainerRef) -> IpcResult<bool> {
        let (database, table) = table_address(container)?;
        const SQL: &str =
            "SELECT count() AS count FROM system.tables WHERE database = ? AND name = ?";
        let request = self
            .driver
            .client
            .query(SQL)
            .bind(database)
            .bind(table)
            .fetch_one::<ObjectCountRow>();
        match tokio::time::timeout(self.driver.timeout, request).await {
            Ok(result) => result.map(|row| row.count > 0).map_err(|error| {
                crate::engine::drivers::clickhouse::error::classify_metadata_error(
                    error,
                    "verify dropped table",
                )
            }),
            Err(_) => Err(catalog_timeout("verify_drop_table", self.driver.timeout)),
        }
    }

    async fn database_exists(&self, name: &str) -> IpcResult<bool> {
        const SQL: &str = "SELECT count() AS count FROM system.databases WHERE name = ?";
        let request = self
            .driver
            .client
            .query(SQL)
            .bind(name)
            .fetch_one::<ObjectCountRow>();
        match tokio::time::timeout(self.driver.timeout, request).await {
            Ok(result) => result.map(|row| row.count > 0).map_err(|error| {
                crate::engine::drivers::clickhouse::error::classify_metadata_error(
                    error,
                    "verify dropped database",
                )
            }),
            Err(_) => Err(catalog_timeout("verify_drop_database", self.driver.timeout)),
        }
    }
}

enum DropStatementOutcome {
    Acknowledged,
    Ambiguous,
}

pub(super) async fn preview_table_drop(
    driver: &ClickHouseDriver,
    target: &ClickHouseDropTableTarget,
) -> IpcResult<NativeSchemaChangePlan> {
    preview_table_drop_with(&DriverDropBackend { driver }, target).await
}

pub(super) async fn preview_database_drop(
    driver: &ClickHouseDriver,
    target: &ClickHouseDropDatabaseTarget,
) -> IpcResult<NativeSchemaChangePlan> {
    preview_database_drop_with(&DriverDropBackend { driver }, target).await
}

pub(super) async fn execute_table_drop(
    driver: &ClickHouseDriver,
    request: &NativeSchemaExecuteChangeRequest,
) -> IpcResult<ClickHouseDropTableResult> {
    execute_table_drop_with(
        &DriverDropBackend { driver },
        request,
        driver.timeout,
        driver.shutdown.subscribe(),
    )
    .await
}

pub(super) async fn execute_database_drop(
    driver: &ClickHouseDriver,
    request: &NativeSchemaExecuteChangeRequest,
) -> IpcResult<ClickHouseDropDatabaseResult> {
    execute_database_drop_with(
        &DriverDropBackend { driver },
        request,
        driver.timeout,
        driver.shutdown.subscribe(),
    )
    .await
}

async fn preview_table_drop_with(
    backend: &(impl DropBackend + ?Sized),
    target: &ClickHouseDropTableTarget,
) -> IpcResult<NativeSchemaChangePlan> {
    table_address(&target.container)?;
    let baseline = backend.describe_table(&target.container).await?;
    plan_table_drop(target, baseline)
}

async fn preview_database_drop_with(
    backend: &(impl DropBackend + ?Sized),
    target: &ClickHouseDropDatabaseTarget,
) -> IpcResult<NativeSchemaChangePlan> {
    let name = database_name(&target.container)?;
    let baseline = read_database_baseline(backend, &name).await?;
    plan_database_drop(target, baseline)
}

fn plan_table_drop(
    target: &ClickHouseDropTableTarget,
    baseline: ClickHouseTableSchema,
) -> IpcResult<NativeSchemaChangePlan> {
    let (database, table) = table_address(&target.container)?;
    if baseline.identity.database != database
        || baseline.identity.name != table
        || baseline.identity.object_kind != ContainerKind::Table
    {
        return Err(IpcError::resource_conflict(
            "ClickHouse table drop baseline does not match its target identity",
        ));
    }
    if !PHASE_FIVE_C_TABLE_ENGINES.contains(&baseline.engine.family.as_str()) {
        return Err(IpcError::validation_failed(
            "当前设计器只能安全删除已支持的非复制 MergeTree 表；其他表引擎请在确认影响后使用 SQL 编辑器处理",
        ));
    }
    let statements = vec![format!(
        "DROP TABLE {}.{}",
        quote_identifier(&database),
        quote_identifier(&table)
    )];
    Ok(drop_plan(
        DROP_TABLE_HASH_DOMAIN,
        statements,
        "drop_table",
        &table,
        NativeSchemaChangeBaseline::ClickHouseTable(Box::new(baseline)),
    ))
}

fn plan_database_drop(
    target: &ClickHouseDropDatabaseTarget,
    baseline: ClickHouseDatabaseBaseline,
) -> IpcResult<NativeSchemaChangePlan> {
    let name = database_name(&target.container)?;
    if baseline.name != name {
        return Err(IpcError::resource_conflict(
            "ClickHouse database drop baseline does not match its target identity",
        ));
    }
    let statements = vec![format!("DROP DATABASE {}", quote_identifier(&name))];
    Ok(drop_plan(
        DROP_DATABASE_HASH_DOMAIN,
        statements,
        "drop_database",
        &name,
        NativeSchemaChangeBaseline::ClickHouseDatabase(baseline),
    ))
}

fn drop_plan(
    hash_domain: &str,
    statements: Vec<String>,
    operation_code: &str,
    object_name: &str,
    baseline: NativeSchemaChangeBaseline,
) -> NativeSchemaChangePlan {
    NativeSchemaChangePlan {
        plan_hash: plan_hash(hash_domain, &statements),
        statements,
        warnings: Vec::new(),
        destructive: true,
        long_running: false,
        risk_flags: vec![NativeSchemaRiskFlag::Destructive],
        required_confirmation: NativeSchemaRequiredConfirmation::Confirm,
        expected_target_revision: None,
        operations: vec![NativeSchemaOperationSummary {
            code: operation_code.to_string(),
            object_name: object_name.to_string(),
            destructive: true,
            long_running: false,
        }],
        baseline,
    }
}

async fn read_database_baseline(
    backend: &(impl DropBackend + ?Sized),
    name: &str,
) -> IpcResult<ClickHouseDatabaseBaseline> {
    let rows = backend.database_identity_rows(name).await?;
    let [row] = rows.as_slice() else {
        return if rows.is_empty() {
            Err(IpcError::resource_not_found(format!(
                "ClickHouse database {name} does not exist"
            )))
        } else {
            Err(IpcError::system_internal(
                "ClickHouse database catalog returned duplicate identities",
                format!("operation=database_drop_baseline; row_count={}", rows.len()),
            ))
        };
    };
    if row.name != name || row.name.trim().is_empty() || row.engine.trim().is_empty() {
        return Err(IpcError::system_internal(
            "ClickHouse database catalog returned an invalid identity",
            "operation=database_drop_baseline; category=invalid_database_identity",
        ));
    }

    let mut objects = backend.database_object_rows(name).await?;
    objects.sort_by(|left, right| left.name.cmp(&right.name));
    for (index, object) in objects.iter().enumerate() {
        if object.name.trim().is_empty()
            || object.engine.trim().is_empty()
            || object.create_table_query.trim().is_empty()
            || (index > 0 && objects[index - 1].name == object.name)
        {
            return Err(IpcError::system_internal(
                "ClickHouse database catalog returned an invalid object baseline",
                format!("operation=database_drop_baseline; object_index={index}"),
            ));
        }
    }
    Ok(ClickHouseDatabaseBaseline {
        name: row.name.clone(),
        engine: row.engine.clone(),
        uuid: normalized_uuid(&row.uuid),
        objects: objects
            .into_iter()
            .map(|object| ClickHouseDatabaseObjectBaseline {
                name: object.name,
                engine: object.engine,
                uuid: normalized_uuid(&object.uuid),
                canonical_create_query: object.create_table_query,
            })
            .collect(),
    })
}

async fn execute_table_drop_with(
    backend: &(impl DropBackend + ?Sized),
    request: &NativeSchemaExecuteChangeRequest,
    timeout: Duration,
    shutdown: watch::Receiver<bool>,
) -> IpcResult<ClickHouseDropTableResult> {
    let NativeSchemaChangeTarget::ClickHouseTableDrop(target) = &request.target else {
        return Err(IpcError::validation_failed(
            "ClickHouse table drop executor requires a table drop target",
        ));
    };
    let NativeSchemaChangeBaseline::ClickHouseTable(baseline) = &request.baseline else {
        return Err(IpcError::validation_failed(
            "ClickHouse table drop executor requires a table baseline",
        ));
    };
    let plan = plan_table_drop(target, baseline.as_ref().clone())?;
    validate_drop_request(&plan, request)?;

    let current = backend
        .describe_table(&target.container)
        .await
        .map_err(drop_preflight_error)?;
    if !table_baselines_equal(baseline, &current)? {
        return Err(drop_drift_conflict("table"));
    }
    let command = prepare_drop_command(&plan, timeout)?;
    let outcome = execute_drop_once(backend, &command, "drop table", shutdown, timeout).await?;
    let absent = matches!(backend.table_exists(&target.container).await, Ok(false));
    let status = if absent {
        NativeSchemaExecutionStatus::Applied
    } else {
        NativeSchemaExecutionStatus::OutcomeUnknown
    };
    let applied_count = u32::from(matches!(outcome, DropStatementOutcome::Acknowledged));
    let table_name = target
        .container
        .table
        .clone()
        .expect("validated table drop target");
    Ok(ClickHouseDropTableResult {
        status,
        progress: drop_progress(command.query_id, applied_count),
        container: target.container.clone(),
        table_name,
        absent,
    })
}

async fn execute_database_drop_with(
    backend: &(impl DropBackend + ?Sized),
    request: &NativeSchemaExecuteChangeRequest,
    timeout: Duration,
    shutdown: watch::Receiver<bool>,
) -> IpcResult<ClickHouseDropDatabaseResult> {
    let NativeSchemaChangeTarget::ClickHouseDatabaseDrop(target) = &request.target else {
        return Err(IpcError::validation_failed(
            "ClickHouse database drop executor requires a database drop target",
        ));
    };
    let NativeSchemaChangeBaseline::ClickHouseDatabase(baseline) = &request.baseline else {
        return Err(IpcError::validation_failed(
            "ClickHouse database drop executor requires a database baseline",
        ));
    };
    let plan = plan_database_drop(target, baseline.clone())?;
    validate_drop_request(&plan, request)?;

    let name = database_name(&target.container)?;
    let current = read_database_baseline(backend, &name)
        .await
        .map_err(drop_preflight_error)?;
    if &current != baseline {
        return Err(drop_drift_conflict("database"));
    }
    let command = prepare_drop_command(&plan, timeout)?;
    let outcome = execute_drop_once(backend, &command, "drop database", shutdown, timeout).await?;
    let absent = matches!(backend.database_exists(&name).await, Ok(false));
    let status = if absent {
        NativeSchemaExecutionStatus::Applied
    } else {
        NativeSchemaExecutionStatus::OutcomeUnknown
    };
    let applied_count = u32::from(matches!(outcome, DropStatementOutcome::Acknowledged));
    Ok(ClickHouseDropDatabaseResult {
        status,
        progress: drop_progress(command.query_id, applied_count),
        container: target.container.clone(),
        name,
        absent,
    })
}

fn validate_drop_request(
    plan: &NativeSchemaChangePlan,
    request: &NativeSchemaExecuteChangeRequest,
) -> IpcResult<()> {
    if plan.plan_hash != request.expected_plan_hash {
        return Err(IpcError::validation_failed(
            "ClickHouse drop preview is stale; preview again before applying",
        ));
    }
    if plan.baseline != request.baseline {
        return Err(IpcError::resource_conflict(
            "ClickHouse drop request baseline no longer matches its preview",
        ));
    }
    let object_name = plan
        .operations
        .first()
        .map(|operation| operation.object_name.as_str())
        .unwrap_or_default();
    validate_native_schema_confirmation(
        plan.required_confirmation,
        request.confirmation.as_ref(),
        object_name,
        None,
    )
}

fn prepare_drop_command(
    plan: &NativeSchemaChangePlan,
    timeout: Duration,
) -> IpcResult<DropCommandRequest> {
    let [statement] = plan.statements.as_slice() else {
        return Err(IpcError::system_internal(
            "ClickHouse drop plan must contain exactly one statement",
            "operation=drop; category=invalid_plan_statement_count",
        ));
    };
    Ok(DropCommandRequest::new(statement.clone(), timeout))
}

async fn execute_drop_once(
    backend: &(impl DropBackend + ?Sized),
    request: &DropCommandRequest,
    operation: &str,
    shutdown: watch::Receiver<bool>,
    timeout: Duration,
) -> IpcResult<DropStatementOutcome> {
    if *shutdown.borrow() {
        return Err(IpcError::operation_canceled(
            "ClickHouse drop canceled before execution",
            format!("operation={operation}; category=shutdown_before_send"),
        ));
    }
    let shutdown_future = wait_for_shutdown(shutdown);
    let statement_future = tokio::time::timeout(timeout, backend.execute_statement(request));
    tokio::pin!(shutdown_future);
    tokio::pin!(statement_future);

    tokio::select! {
        biased;
        _ = &mut shutdown_future => Ok(DropStatementOutcome::Ambiguous),
        response = &mut statement_future => match response {
            Err(_) => Ok(DropStatementOutcome::Ambiguous),
            Ok(Ok(())) => Ok(DropStatementOutcome::Acknowledged),
            Ok(Err(error)) if is_ambiguous_transport(&error) => Ok(DropStatementOutcome::Ambiguous),
            Ok(Err(error)) => Err(
                crate::engine::drivers::clickhouse::error::classify_schema_change_error(
                    error,
                    operation,
                ),
            ),
        },
    }
}

fn table_address(container: &ContainerRef) -> IpcResult<(String, String)> {
    if container.kind != ContainerKind::Table
        || container.group_type.is_some()
        || container.schema.is_some()
        || container.column.is_some()
        || container.object_name.is_some()
        || container.db_index.is_some()
        || container.key.is_some()
        || container.pattern.is_some()
    {
        return Err(IpcError::validation_failed(
            "ClickHouse table drop requires an exact table container",
        ));
    }
    Ok((
        required_container_name(&container.database, "database")?,
        required_container_name(&container.table, "table")?,
    ))
}

fn database_name(container: &ContainerRef) -> IpcResult<String> {
    if container.kind != ContainerKind::Database
        || container.group_type.is_some()
        || container.schema.is_some()
        || container.table.is_some()
        || container.column.is_some()
        || container.object_name.is_some()
        || container.db_index.is_some()
        || container.key.is_some()
        || container.pattern.is_some()
    {
        return Err(IpcError::validation_failed(
            "ClickHouse database drop requires an exact database container",
        ));
    }
    required_container_name(&container.database, "database")
}

fn required_container_name(value: &Option<String>, field: &str) -> IpcResult<String> {
    value
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .ok_or_else(|| {
            IpcError::validation_failed(format!("ClickHouse drop requires a non-empty {field}"))
        })
}

fn normalized_uuid(value: &str) -> Option<String> {
    (!value.trim().is_empty()).then(|| value.to_string())
}

fn drop_preflight_error(error: IpcError) -> IpcError {
    if error.code == ErrorCode::ResourceNotFound {
        drop_drift_conflict("object")
    } else {
        error
    }
}

fn drop_drift_conflict(object_kind: &str) -> IpcError {
    IpcError::resource_conflict(format!(
        "ClickHouse {object_kind} changed or disappeared after preview"
    ))
}

fn drop_progress(query_id: String, applied_count: u32) -> NativeSchemaStatementProgress {
    NativeSchemaStatementProgress {
        applied_count,
        failed_statement_index: None,
        remaining_count: 0,
        query_ids: vec![query_id],
    }
}

fn catalog_timeout(operation: &str, timeout: Duration) -> IpcError {
    IpcError::network_timeout(
        "ClickHouse drop catalog request timed out",
        format!("operation={operation}; timeout_ms={}", timeout.as_millis()),
    )
}

async fn wait_for_shutdown(mut shutdown: watch::Receiver<bool>) {
    loop {
        match shutdown.changed().await {
            Ok(()) if *shutdown.borrow() => return,
            Ok(()) => continue,
            Err(_) => pending::<()>().await,
        }
    }
}

fn is_ambiguous_transport(error: &ClickHouseError) -> bool {
    matches!(
        error,
        ClickHouseError::Network(_) | ClickHouseError::TimedOut
    )
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;
    use std::time::Duration;

    use async_trait::async_trait;
    use clickhouse::error::Error as ClickHouseError;
    use tokio::sync::watch;

    use super::*;
    use crate::engine::drivers::clickhouse::schema::{
        ClickHouseColumnDefaultKind, ClickHouseColumnSchema, ClickHouseDropDatabaseTarget,
        ClickHouseDropTableTarget, ClickHouseEngineSchema, ClickHouseKeySchema,
        ClickHouseSchemaBaseline, ClickHouseSchemaEditability, ClickHouseTableIdentity,
        ClickHouseTableSchema,
    };
    use crate::engine::native_schema::{
        NativeSchemaChangeBaseline, NativeSchemaChangeTarget, NativeSchemaConfirmationInput,
        NativeSchemaExecuteChangeRequest, NativeSchemaExecutionStatus,
    };
    use crate::engine::types::{ContainerKind, ContainerRef};
    use crate::error::{ErrorCode, IpcError, IpcResult, RuntimeErrorImpact};

    enum FakeStatementResponse {
        Success,
        Error(ClickHouseError),
    }

    enum FakeDescribeResponse {
        Schema(ClickHouseTableSchema),
        Error,
    }

    enum FakeExistsResponse {
        Exists(bool),
        Error,
    }

    struct FakeDropBackend {
        database_rows: Mutex<VecDeque<Vec<DatabaseIdentityRow>>>,
        object_rows: Mutex<VecDeque<Vec<DatabaseObjectRow>>>,
        table_describes: Mutex<VecDeque<FakeDescribeResponse>>,
        table_exists: Mutex<VecDeque<FakeExistsResponse>>,
        database_exists: Mutex<VecDeque<FakeExistsResponse>>,
        statement_responses: Mutex<VecDeque<FakeStatementResponse>>,
        requests: Mutex<Vec<DropCommandRequest>>,
    }

    impl FakeDropBackend {
        fn empty() -> Self {
            Self {
                database_rows: Mutex::new(VecDeque::new()),
                object_rows: Mutex::new(VecDeque::new()),
                table_describes: Mutex::new(VecDeque::new()),
                table_exists: Mutex::new(VecDeque::new()),
                database_exists: Mutex::new(VecDeque::new()),
                statement_responses: Mutex::new(VecDeque::new()),
                requests: Mutex::new(Vec::new()),
            }
        }

        fn database(
            identities: impl IntoIterator<Item = Vec<DatabaseIdentityRow>>,
            objects: impl IntoIterator<Item = Vec<DatabaseObjectRow>>,
        ) -> Self {
            let backend = Self::empty();
            *backend.database_rows.lock().unwrap() = identities.into_iter().collect();
            *backend.object_rows.lock().unwrap() = objects.into_iter().collect();
            backend
        }

        fn table(describes: impl IntoIterator<Item = FakeDescribeResponse>) -> Self {
            let backend = Self::empty();
            *backend.table_describes.lock().unwrap() = describes.into_iter().collect();
            backend
        }

        fn with_execution(
            mut self,
            responses: impl IntoIterator<Item = FakeStatementResponse>,
            table_exists: impl IntoIterator<Item = FakeExistsResponse>,
            database_exists: impl IntoIterator<Item = FakeExistsResponse>,
        ) -> Self {
            self.statement_responses = Mutex::new(responses.into_iter().collect());
            self.table_exists = Mutex::new(table_exists.into_iter().collect());
            self.database_exists = Mutex::new(database_exists.into_iter().collect());
            self
        }

        fn requests(&self) -> Vec<DropCommandRequest> {
            self.requests.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl DropBackend for FakeDropBackend {
        async fn execute_statement(
            &self,
            request: &DropCommandRequest,
        ) -> Result<(), ClickHouseError> {
            self.requests.lock().unwrap().push(request.clone());
            match self
                .statement_responses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap()
            {
                FakeStatementResponse::Success => Ok(()),
                FakeStatementResponse::Error(error) => Err(error),
            }
        }

        async fn describe_table(
            &self,
            _container: &ContainerRef,
        ) -> IpcResult<ClickHouseTableSchema> {
            match self.table_describes.lock().unwrap().pop_front().unwrap() {
                FakeDescribeResponse::Schema(schema) => Ok(schema),
                FakeDescribeResponse::Error => Err(IpcError::network_timeout(
                    "describe failed",
                    "category=test",
                )),
            }
        }

        async fn database_identity_rows(&self, _name: &str) -> IpcResult<Vec<DatabaseIdentityRow>> {
            Ok(self.database_rows.lock().unwrap().pop_front().unwrap())
        }

        async fn database_object_rows(&self, _name: &str) -> IpcResult<Vec<DatabaseObjectRow>> {
            Ok(self.object_rows.lock().unwrap().pop_front().unwrap())
        }

        async fn table_exists(&self, _container: &ContainerRef) -> IpcResult<bool> {
            match self.table_exists.lock().unwrap().pop_front().unwrap() {
                FakeExistsResponse::Exists(exists) => Ok(exists),
                FakeExistsResponse::Error => {
                    Err(IpcError::network_timeout("verify failed", "category=test"))
                }
            }
        }

        async fn database_exists(&self, _name: &str) -> IpcResult<bool> {
            match self.database_exists.lock().unwrap().pop_front().unwrap() {
                FakeExistsResponse::Exists(exists) => Ok(exists),
                FakeExistsResponse::Error => {
                    Err(IpcError::network_timeout("verify failed", "category=test"))
                }
            }
        }
    }

    fn database_row(name: &str, engine: &str, uuid: &str) -> DatabaseIdentityRow {
        DatabaseIdentityRow {
            name: name.to_string(),
            engine: engine.to_string(),
            uuid: uuid.to_string(),
        }
    }

    fn object_row(name: &str, engine: &str, uuid: &str) -> DatabaseObjectRow {
        DatabaseObjectRow {
            name: name.to_string(),
            engine: engine.to_string(),
            uuid: uuid.to_string(),
            create_table_query: format!("CREATE {engine} {name}"),
        }
    }

    fn table_schema() -> ClickHouseTableSchema {
        ClickHouseTableSchema {
            identity: ClickHouseTableIdentity {
                database: "scratch".to_string(),
                name: "events".to_string(),
                object_kind: ContainerKind::Table,
                uuid: Some("table-uuid".to_string()),
            },
            engine: ClickHouseEngineSchema {
                family: "MergeTree".to_string(),
                arguments: Vec::new(),
                raw_expression: "MergeTree".to_string(),
            },
            columns: vec![ClickHouseColumnSchema {
                name: "id".to_string(),
                type_name: "UInt64".to_string(),
                position: 1,
                default_kind: ClickHouseColumnDefaultKind::None,
                default_expression: None,
                codec_expression: None,
                ttl_expression: None,
                comment: None,
                editability: ClickHouseSchemaEditability::editable(),
            }],
            keys: ClickHouseKeySchema {
                order_by: "id".to_string(),
                partition_by: None,
                primary_key: Some("id".to_string()),
                sample_by: None,
            },
            table_ttl: None,
            comment: None,
            settings: Vec::new(),
            projections: Vec::new(),
            skipping_indexes: Vec::new(),
            editability: ClickHouseSchemaEditability::editable(),
            baseline: ClickHouseSchemaBaseline {
                canonical_create_query: "CREATE TABLE scratch.events".to_string(),
                revision_hash: "a".repeat(64),
            },
        }
    }

    fn table_target() -> ClickHouseDropTableTarget {
        ClickHouseDropTableTarget {
            container: ContainerRef::table(ContainerKind::Table, "scratch", None, "events"),
        }
    }

    fn database_target() -> ClickHouseDropDatabaseTarget {
        ClickHouseDropDatabaseTarget {
            container: ContainerRef::database("scratch"),
        }
    }

    fn table_request(
        plan: crate::engine::native_schema::NativeSchemaChangePlan,
        confirm_destructive: bool,
    ) -> NativeSchemaExecuteChangeRequest {
        NativeSchemaExecuteChangeRequest {
            target: NativeSchemaChangeTarget::ClickHouseTableDrop(table_target()),
            baseline: plan.baseline,
            expected_plan_hash: plan.plan_hash,
            confirmation: confirm_destructive.then_some(NativeSchemaConfirmationInput {
                accepted: true,
                object_name: None,
                cluster_name: None,
            }),
        }
    }

    fn database_request(
        plan: crate::engine::native_schema::NativeSchemaChangePlan,
        confirm_destructive: bool,
    ) -> NativeSchemaExecuteChangeRequest {
        NativeSchemaExecuteChangeRequest {
            target: NativeSchemaChangeTarget::ClickHouseDatabaseDrop(database_target()),
            baseline: plan.baseline,
            expected_plan_hash: plan.plan_hash,
            confirmation: confirm_destructive.then_some(NativeSchemaConfirmationInput {
                accepted: true,
                object_name: None,
                cluster_name: None,
            }),
        }
    }

    fn timeout() -> Duration {
        Duration::from_secs(5)
    }

    fn shutdown() -> watch::Receiver<bool> {
        watch::channel(false).1
    }

    #[tokio::test]
    async fn database_preview_captures_sorted_object_baseline() {
        let backend = FakeDropBackend::database(
            [vec![database_row("scratch", "Atomic", "db-uuid")]],
            [vec![
                object_row("z", "MergeTree", "z-uuid"),
                object_row("a", "View", "a-uuid"),
            ]],
        );
        let plan = preview_database_drop_with(&backend, &database_target())
            .await
            .unwrap();
        let NativeSchemaChangeBaseline::ClickHouseDatabase(baseline) = plan.baseline else {
            panic!("expected database baseline")
        };
        assert_eq!(
            baseline
                .objects
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            ["a", "z"]
        );
        assert_eq!(baseline.uuid.as_deref(), Some("db-uuid"));
        assert_eq!(plan.statements, ["DROP DATABASE `scratch`"]);
        assert!(plan.destructive);
        assert!(!plan.long_running);
        assert!(!plan.statements[0].contains("IF EXISTS"));
        assert_eq!(plan.operations[0].code, "drop_database");
    }

    #[tokio::test]
    async fn database_baseline_requires_exact_single_identity_and_normalizes_empty_uuid() {
        for rows in [
            Vec::new(),
            vec![
                database_row("scratch", "Atomic", "a"),
                database_row("scratch", "Atomic", "b"),
            ],
        ] {
            let backend = FakeDropBackend::database([rows], [Vec::new()]);
            let error = preview_database_drop_with(&backend, &database_target())
                .await
                .unwrap_err();
            assert!(matches!(
                error.code,
                ErrorCode::ResourceNotFound | ErrorCode::SystemInternal
            ));
        }

        let backend = FakeDropBackend::database(
            [vec![database_row("scratch", "Atomic", "")]],
            [vec![object_row("events", "MergeTree", "")]],
        );
        let plan = preview_database_drop_with(&backend, &database_target())
            .await
            .unwrap();
        let NativeSchemaChangeBaseline::ClickHouseDatabase(baseline) = plan.baseline else {
            panic!("expected database baseline")
        };
        assert_eq!(baseline.uuid, None);
        assert_eq!(baseline.objects[0].uuid, None);
        assert!(!baseline.objects[0].canonical_create_query.is_empty());
    }

    #[tokio::test]
    async fn table_preview_uses_full_describe_and_exact_non_idempotent_sql() {
        let schema = table_schema();
        let backend = FakeDropBackend::table([FakeDescribeResponse::Schema(schema.clone())]);
        let plan = preview_table_drop_with(&backend, &table_target())
            .await
            .unwrap();
        assert_eq!(plan.statements, ["DROP TABLE `scratch`.`events`"]);
        assert_eq!(
            plan.baseline,
            NativeSchemaChangeBaseline::ClickHouseTable(Box::new(schema))
        );
        assert!(plan.destructive);
        assert!(!plan.long_running);
        assert_eq!(plan.operations[0].code, "drop_table");
        assert!(!plan.statements[0].contains("IF EXISTS"));
    }

    #[tokio::test]
    async fn table_preview_rejects_engines_outside_the_phase_five_c_scope() {
        let mut schema = table_schema();
        schema.engine.family = "ReplicatedMergeTree".to_string();
        schema.engine.raw_expression = "ReplicatedMergeTree('/path', '{replica}')".to_string();
        let backend = FakeDropBackend::table([FakeDescribeResponse::Schema(schema)]);

        let error = preview_table_drop_with(&backend, &table_target())
            .await
            .unwrap_err();

        assert_eq!(error.code, ErrorCode::ValidationFailed);
    }

    #[tokio::test]
    async fn database_object_drift_conflicts_before_drop() {
        let preview_backend = FakeDropBackend::database(
            [vec![database_row("scratch", "Atomic", "db-uuid")]],
            [vec![object_row("a", "MergeTree", "uuid-a")]],
        );
        let preview = preview_database_drop_with(&preview_backend, &database_target())
            .await
            .unwrap();
        let backend = FakeDropBackend::database(
            [vec![database_row("scratch", "Atomic", "db-uuid")]],
            [vec![
                object_row("a", "MergeTree", "uuid-a"),
                object_row("new", "MergeTree", "uuid-new"),
            ]],
        );
        let error = execute_database_drop_with(
            &backend,
            &database_request(preview, true),
            timeout(),
            shutdown(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceConflict);
        assert_eq!(error.runtime_impact, RuntimeErrorImpact::BusinessOnly);
        assert!(backend.requests().is_empty());
    }

    #[tokio::test]
    async fn confirmation_and_table_drift_run_before_drop_send() {
        let preview_backend =
            FakeDropBackend::table([FakeDescribeResponse::Schema(table_schema())]);
        let preview = preview_table_drop_with(&preview_backend, &table_target())
            .await
            .unwrap();
        let backend = FakeDropBackend::empty();
        let error = execute_table_drop_with(
            &backend,
            &table_request(preview.clone(), false),
            timeout(),
            shutdown(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ValidationFailed);
        assert!(backend.requests().is_empty());

        let mut drifted = table_schema();
        drifted.columns[0].type_name = "UInt32".to_string();
        let backend = FakeDropBackend::table([FakeDescribeResponse::Schema(drifted)]);
        let error = execute_table_drop_with(
            &backend,
            &table_request(preview, true),
            timeout(),
            shutdown(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceConflict);
        assert!(backend.requests().is_empty());
    }

    #[tokio::test]
    async fn ambiguous_table_drop_is_applied_only_after_absence_is_proved() {
        let preview_backend =
            FakeDropBackend::table([FakeDescribeResponse::Schema(table_schema())]);
        let preview = preview_table_drop_with(&preview_backend, &table_target())
            .await
            .unwrap();

        for (exists, expected_status) in [
            (false, NativeSchemaExecutionStatus::Applied),
            (true, NativeSchemaExecutionStatus::OutcomeUnknown),
        ] {
            let backend = FakeDropBackend::table([FakeDescribeResponse::Schema(table_schema())])
                .with_execution(
                    [FakeStatementResponse::Error(ClickHouseError::TimedOut)],
                    [FakeExistsResponse::Exists(exists)],
                    [],
                );
            let result = execute_table_drop_with(
                &backend,
                &table_request(preview.clone(), true),
                timeout(),
                shutdown(),
            )
            .await
            .unwrap();
            assert_eq!(result.status, expected_status);
            assert_eq!(result.absent, !exists);
            assert_eq!(backend.requests().len(), 1);
        }
    }

    #[tokio::test]
    async fn acknowledged_database_drop_requires_proven_absence() {
        let preview_backend = FakeDropBackend::database(
            [vec![database_row("scratch", "Atomic", "db-uuid")]],
            [vec![object_row("a", "MergeTree", "uuid-a")]],
        );
        let preview = preview_database_drop_with(&preview_backend, &database_target())
            .await
            .unwrap();

        for (verification, expected_status, absent) in [
            (
                FakeExistsResponse::Exists(false),
                NativeSchemaExecutionStatus::Applied,
                true,
            ),
            (
                FakeExistsResponse::Exists(true),
                NativeSchemaExecutionStatus::OutcomeUnknown,
                false,
            ),
            (
                FakeExistsResponse::Error,
                NativeSchemaExecutionStatus::OutcomeUnknown,
                false,
            ),
        ] {
            let backend = FakeDropBackend::database(
                [vec![database_row("scratch", "Atomic", "db-uuid")]],
                [vec![object_row("a", "MergeTree", "uuid-a")]],
            )
            .with_execution([FakeStatementResponse::Success], [], [verification]);
            let result = execute_database_drop_with(
                &backend,
                &database_request(preview.clone(), true),
                timeout(),
                shutdown(),
            )
            .await
            .unwrap();
            assert_eq!(result.status, expected_status);
            assert_eq!(result.absent, absent);
            let requests = backend.requests();
            assert_eq!(requests.len(), 1);
            assert!(requests[0].has_setting("wait_end_of_query", "1"));
            assert!(requests[0].has_setting("max_execution_time", "5"));
        }
    }
}
