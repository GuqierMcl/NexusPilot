#![allow(dead_code)]

use std::future::pending;
use std::time::Duration;

use async_trait::async_trait;
use clickhouse::error::Error as ClickHouseError;
use serde::Deserialize;
use tokio::sync::watch;
use uuid::Uuid;

use crate::engine::types::{ContainerKind, ContainerRef};
use crate::error::{IpcError, IpcResult};

use super::create_render::{plan_create_database, plan_create_table};
use super::create_types::{
    ClickHouseCreateDatabaseResult, ClickHouseCreateDatabaseTarget, ClickHouseCreateTableResult,
    ClickHouseCreateTableTarget,
};
use super::describe::describe_table;
use super::schema_compare::table_schema_matches_target;
use super::types::ClickHouseTableSchema;
use crate::engine::drivers::clickhouse::ClickHouseDriver;

#[derive(Debug, Clone, PartialEq, Eq)]
struct CreateCommandRequest {
    statement: String,
    query_id: String,
    settings: Vec<(&'static str, String)>,
}

impl CreateCommandRequest {
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

    fn has_setting_name(&self, name: &str) -> bool {
        self.settings
            .iter()
            .any(|(candidate, _)| *candidate == name)
    }
}

#[async_trait]
trait CreateBackend: Send + Sync {
    async fn execute_statement(
        &self,
        request: &CreateCommandRequest,
    ) -> Result<(), ClickHouseError>;

    async fn database_exists(&self, name: &str) -> IpcResult<bool>;

    async fn describe_table(&self, container: &ContainerRef) -> IpcResult<ClickHouseTableSchema>;
}

struct DriverCreateBackend<'a> {
    driver: &'a ClickHouseDriver,
}

#[derive(Debug, clickhouse::Row, Deserialize)]
struct DatabaseCountRow {
    count: u64,
}

#[async_trait]
impl CreateBackend for DriverCreateBackend<'_> {
    async fn execute_statement(
        &self,
        request: &CreateCommandRequest,
    ) -> Result<(), ClickHouseError> {
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

    async fn database_exists(&self, name: &str) -> IpcResult<bool> {
        const SQL: &str = "SELECT count() AS count FROM system.databases WHERE name = ?";
        let request = self
            .driver
            .client
            .query(SQL)
            .bind(name)
            .fetch_one::<DatabaseCountRow>();
        match tokio::time::timeout(self.driver.timeout, request).await {
            Ok(result) => result.map(|row| row.count > 0).map_err(|error| {
                crate::engine::drivers::clickhouse::error::classify_metadata_error(
                    error,
                    "verify created database",
                )
            }),
            Err(_) => Err(IpcError::network_timeout(
                "ClickHouse database verification timed out",
                format!(
                    "operation=verify_create_database; timeout_ms={}",
                    self.driver.timeout.as_millis()
                ),
            )),
        }
    }

    async fn describe_table(&self, container: &ContainerRef) -> IpcResult<ClickHouseTableSchema> {
        describe_table(self.driver, container).await
    }
}

enum StatementOutcome {
    Acknowledged,
    Ambiguous,
}

pub(super) async fn execute_create_database(
    driver: &ClickHouseDriver,
    target: &ClickHouseCreateDatabaseTarget,
    expected_plan_hash: &str,
) -> IpcResult<ClickHouseCreateDatabaseResult> {
    execute_create_database_with(
        &DriverCreateBackend { driver },
        target,
        expected_plan_hash,
        driver.timeout,
        driver.shutdown.subscribe(),
    )
    .await
}

pub(super) async fn execute_create_table(
    driver: &ClickHouseDriver,
    target: &ClickHouseCreateTableTarget,
    expected_plan_hash: &str,
) -> IpcResult<ClickHouseCreateTableResult> {
    execute_create_table_with(
        &DriverCreateBackend { driver },
        target,
        expected_plan_hash,
        driver.timeout,
        driver.shutdown.subscribe(),
    )
    .await
}

async fn execute_create_database_with(
    backend: &(impl CreateBackend + ?Sized),
    target: &ClickHouseCreateDatabaseTarget,
    expected_plan_hash: &str,
    timeout: Duration,
    shutdown: watch::Receiver<bool>,
) -> IpcResult<ClickHouseCreateDatabaseResult> {
    let preview = plan_create_database(target)?;
    let request = prepare_request(preview, expected_plan_hash, timeout)?;
    execute_once(backend, &request, "create database", shutdown, timeout).await?;

    match backend.database_exists(&target.name).await {
        Ok(true) => Ok(ClickHouseCreateDatabaseResult {
            name: target.name.clone(),
            container: ContainerRef::database(&target.name),
        }),
        Ok(false) | Err(_) => Err(outcome_unknown("create_database", &request.query_id)),
    }
}

async fn execute_create_table_with(
    backend: &(impl CreateBackend + ?Sized),
    target: &ClickHouseCreateTableTarget,
    expected_plan_hash: &str,
    timeout: Duration,
    shutdown: watch::Receiver<bool>,
) -> IpcResult<ClickHouseCreateTableResult> {
    let preview = plan_create_table(target)?;
    let request = prepare_request(preview, expected_plan_hash, timeout)?;
    execute_once(backend, &request, "create table", shutdown, timeout).await?;

    let container = ContainerRef::table(ContainerKind::Table, &target.database, None, &target.name);
    match backend.describe_table(&container).await {
        Ok(schema) if table_schema_matches_target(target, &schema) => {
            Ok(ClickHouseCreateTableResult {
                container,
                table_name: target.name.clone(),
                schema,
            })
        }
        Ok(_) | Err(_) => Err(outcome_unknown("create_table", &request.query_id)),
    }
}

fn prepare_request(
    preview: crate::engine::native_schema::NativeSchemaMutationPreview,
    expected_plan_hash: &str,
    timeout: Duration,
) -> IpcResult<CreateCommandRequest> {
    if preview.plan_hash != expected_plan_hash {
        return Err(IpcError::validation_failed(
            "ClickHouse schema create preview is stale; preview again before applying",
        ));
    }
    let [statement] = preview.statements.as_slice() else {
        return Err(IpcError::system_internal(
            "ClickHouse schema create plan must contain exactly one statement",
            "operation=schema_create; category=invalid_plan_statement_count",
        ));
    };
    if statement.is_empty() {
        return Err(IpcError::system_internal(
            "ClickHouse schema create plan contains an empty statement",
            "operation=schema_create; category=empty_plan_statement",
        ));
    }
    Ok(CreateCommandRequest::new(statement.clone(), timeout))
}

async fn execute_once(
    backend: &(impl CreateBackend + ?Sized),
    request: &CreateCommandRequest,
    operation: &str,
    shutdown: watch::Receiver<bool>,
    timeout: Duration,
) -> IpcResult<StatementOutcome> {
    if *shutdown.borrow() {
        return Err(IpcError::operation_canceled(
            "ClickHouse schema create canceled before execution",
            format!("operation={operation}; category=shutdown_before_send"),
        ));
    }

    let shutdown_future = wait_for_shutdown(shutdown);
    let statement_future = tokio::time::timeout(timeout, backend.execute_statement(request));
    tokio::pin!(shutdown_future);
    tokio::pin!(statement_future);

    tokio::select! {
        biased;
        _ = &mut shutdown_future => Ok(StatementOutcome::Ambiguous),
        response = &mut statement_future => match response {
            Err(_) => Ok(StatementOutcome::Ambiguous),
            Ok(Ok(())) => Ok(StatementOutcome::Acknowledged),
            Ok(Err(error)) if is_ambiguous_transport(&error) => Ok(StatementOutcome::Ambiguous),
            Ok(Err(error)) => Err(
                crate::engine::drivers::clickhouse::error::classify_schema_create_error(
                    error,
                    operation,
                ),
            ),
        },
    }
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

fn outcome_unknown(operation: &str, query_id: &str) -> IpcError {
    IpcError::operation_outcome_unknown(
        "ClickHouse schema create result could not be verified",
        format!("operation={operation}; category=outcome_unknown; query_id={query_id}"),
    )
}

#[cfg(test)]
mod tests {
    use std::future::pending;
    use std::sync::Mutex;
    use std::time::Duration;

    use async_trait::async_trait;
    use clickhouse::error::Error as ClickHouseError;
    use tokio::sync::watch;

    use super::*;

    use crate::engine::drivers::clickhouse::schema::{
        ClickHouseCodecTarget, ClickHouseColumnDefaultKind, ClickHouseColumnSchema,
        ClickHouseCreateColumnTarget, ClickHouseCreateDatabaseTarget, ClickHouseCreateEngineTarget,
        ClickHouseCreateSettingTarget, ClickHouseCreateTableTarget, ClickHouseEngineSchema,
        ClickHouseKeySchema, ClickHouseSchemaBaseline, ClickHouseSchemaEditability,
        ClickHouseSettingSchema, ClickHouseTableIdentity, ClickHouseTableSchema,
    };
    use crate::engine::types::{ContainerKind, ContainerRef};
    use crate::error::{ErrorCode, IpcError, IpcResult, RuntimeErrorImpact};

    enum FakeStatementResponse {
        Success,
        Error(ClickHouseError),
        Pending,
    }

    enum FakeDatabaseVerification {
        Exists(bool),
        Error,
    }

    enum FakeTableVerification {
        Schema(ClickHouseTableSchema),
        Missing,
        Error,
    }

    struct FakeCreateBackend {
        response: Mutex<Option<FakeStatementResponse>>,
        database_verification: Mutex<Option<FakeDatabaseVerification>>,
        table_verification: Mutex<Option<FakeTableVerification>>,
        requests: Mutex<Vec<CreateCommandRequest>>,
        database_names: Mutex<Vec<String>>,
        table_containers: Mutex<Vec<ContainerRef>>,
    }

    impl FakeCreateBackend {
        fn table(response: FakeStatementResponse, verification: FakeTableVerification) -> Self {
            Self {
                response: Mutex::new(Some(response)),
                database_verification: Mutex::new(None),
                table_verification: Mutex::new(Some(verification)),
                requests: Mutex::new(Vec::new()),
                database_names: Mutex::new(Vec::new()),
                table_containers: Mutex::new(Vec::new()),
            }
        }

        fn database(
            response: FakeStatementResponse,
            verification: FakeDatabaseVerification,
        ) -> Self {
            Self {
                response: Mutex::new(Some(response)),
                database_verification: Mutex::new(Some(verification)),
                table_verification: Mutex::new(None),
                requests: Mutex::new(Vec::new()),
                database_names: Mutex::new(Vec::new()),
                table_containers: Mutex::new(Vec::new()),
            }
        }

        fn requests(&self) -> Vec<CreateCommandRequest> {
            self.requests.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl CreateBackend for FakeCreateBackend {
        async fn execute_statement(
            &self,
            request: &CreateCommandRequest,
        ) -> Result<(), ClickHouseError> {
            self.requests.lock().unwrap().push(request.clone());
            let response = self.response.lock().unwrap().take().unwrap();
            match response {
                FakeStatementResponse::Success => Ok(()),
                FakeStatementResponse::Error(error) => Err(error),
                FakeStatementResponse::Pending => pending().await,
            }
        }

        async fn database_exists(&self, name: &str) -> IpcResult<bool> {
            self.database_names.lock().unwrap().push(name.to_string());
            match self.database_verification.lock().unwrap().take().unwrap() {
                FakeDatabaseVerification::Exists(exists) => Ok(exists),
                FakeDatabaseVerification::Error => {
                    Err(IpcError::network_timeout("verify failed", "category=test"))
                }
            }
        }

        async fn describe_table(
            &self,
            container: &ContainerRef,
        ) -> IpcResult<ClickHouseTableSchema> {
            self.table_containers
                .lock()
                .unwrap()
                .push(container.clone());
            match self.table_verification.lock().unwrap().take().unwrap() {
                FakeTableVerification::Schema(schema) => Ok(schema),
                FakeTableVerification::Missing => {
                    Err(IpcError::resource_not_found("test table missing"))
                }
                FakeTableVerification::Error => {
                    Err(IpcError::network_timeout("verify failed", "category=test"))
                }
            }
        }
    }

    fn column(
        name: &str,
        type_name: &str,
        default_kind: ClickHouseColumnDefaultKind,
        default_expression: Option<&str>,
    ) -> ClickHouseCreateColumnTarget {
        ClickHouseCreateColumnTarget {
            name: name.to_string(),
            type_name: type_name.to_string(),
            default_kind,
            default_expression: default_expression.map(str::to_string),
            codecs: Vec::new(),
            ttl_expression: None,
            comment: None,
        }
    }

    fn fixture_create_table_target() -> ClickHouseCreateTableTarget {
        let mut id = column("id", "UInt64", ClickHouseColumnDefaultKind::None, None);
        id.comment = Some("event id".to_string());
        id.codecs = vec![ClickHouseCodecTarget {
            name: "ZSTD".to_string(),
            arguments: vec!["1".to_string()],
        }];
        let mut expires_at = column(
            "expires_at",
            "DateTime",
            ClickHouseColumnDefaultKind::None,
            None,
        );
        expires_at.ttl_expression = Some("expires_at + INTERVAL 7 DAY".to_string());
        ClickHouseCreateTableTarget {
            database: "analytics".to_string(),
            name: "events".to_string(),
            columns: vec![
                id,
                column(
                    "version",
                    "UInt64",
                    ClickHouseColumnDefaultKind::Default,
                    Some("1"),
                ),
                column(
                    "event_date",
                    "Date",
                    ClickHouseColumnDefaultKind::Materialized,
                    Some("toDate(now())"),
                ),
                column(
                    "alias_id",
                    "UInt64",
                    ClickHouseColumnDefaultKind::Alias,
                    Some("id"),
                ),
                expires_at,
            ],
            engine: ClickHouseCreateEngineTarget {
                family: "ReplacingMergeTree".to_string(),
                arguments: vec!["version".to_string()],
            },
            keys: ClickHouseKeySchema {
                order_by: "(id, version)".to_string(),
                partition_by: Some("toYYYYMM(now())".to_string()),
                primary_key: Some("id".to_string()),
                sample_by: Some("id".to_string()),
            },
            table_ttl: Some("now() + INTERVAL 30 DAY DELETE".to_string()),
            comment: Some("events".to_string()),
            settings: vec![
                ClickHouseCreateSettingTarget {
                    name: "index_granularity".to_string(),
                    value: "8192".to_string(),
                },
                ClickHouseCreateSettingTarget {
                    name: "ttl_only_drop_parts".to_string(),
                    value: "1".to_string(),
                },
            ],
        }
    }

    fn fixture_described_schema() -> ClickHouseTableSchema {
        let target = fixture_create_table_target();
        ClickHouseTableSchema {
            identity: ClickHouseTableIdentity {
                database: target.database.clone(),
                name: target.name.clone(),
                object_kind: ContainerKind::Table,
                uuid: Some("00000000-0000-0000-0000-000000000001".to_string()),
            },
            engine: ClickHouseEngineSchema {
                family: target.engine.family.clone(),
                arguments: target.engine.arguments.clone(),
                raw_expression: "ReplacingMergeTree(version)".to_string(),
            },
            columns: target
                .columns
                .iter()
                .enumerate()
                .map(|(index, column)| ClickHouseColumnSchema {
                    name: column.name.clone(),
                    type_name: column.type_name.clone(),
                    position: index as u64 + 1,
                    default_kind: column.default_kind,
                    default_expression: column.default_expression.clone(),
                    codec_expression: (!column.codecs.is_empty())
                        .then(|| "CODEC(ZSTD(1))".to_string()),
                    ttl_expression: column.ttl_expression.clone(),
                    comment: column.comment.clone(),
                    editability: ClickHouseSchemaEditability::editable(),
                })
                .collect(),
            keys: target.keys.clone(),
            table_ttl: target.table_ttl.clone(),
            comment: target.comment.clone(),
            settings: target
                .settings
                .iter()
                .map(|setting| ClickHouseSettingSchema {
                    name: setting.name.clone(),
                    value: setting.value.clone(),
                    explicit: true,
                })
                .collect(),
            projections: Vec::new(),
            skipping_indexes: Vec::new(),
            editability: ClickHouseSchemaEditability::editable(),
            baseline: ClickHouseSchemaBaseline {
                canonical_create_query: "server canonical create".to_string(),
                revision_hash: "a".repeat(64),
            },
        }
    }

    fn timeout() -> Duration {
        Duration::from_secs(5)
    }

    fn shutdown() -> watch::Receiver<bool> {
        watch::channel(false).1
    }

    #[tokio::test]
    async fn execute_uses_preview_bytes_and_returns_real_describe() {
        let schema = fixture_described_schema();
        let backend = FakeCreateBackend::table(
            FakeStatementResponse::Success,
            FakeTableVerification::Schema(schema.clone()),
        );
        let target = fixture_create_table_target();
        let preview = plan_create_table(&target).unwrap();

        let result =
            execute_create_table_with(&backend, &target, &preview.plan_hash, timeout(), shutdown())
                .await
                .unwrap();

        let requests = backend.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].statement, preview.statements[0]);
        assert!(!requests[0].query_id.is_empty());
        assert!(requests[0].has_setting("wait_end_of_query", "1"));
        assert!(requests[0].has_setting("max_execution_time", "5"));
        assert!(!requests[0].has_setting_name("readonly"));
        assert_eq!(result.schema, schema);
    }

    #[tokio::test]
    async fn stale_plan_hash_and_pre_send_shutdown_never_touch_network() {
        let backend = FakeCreateBackend::table(
            FakeStatementResponse::Success,
            FakeTableVerification::Schema(fixture_described_schema()),
        );
        let target = fixture_create_table_target();
        let error =
            execute_create_table_with(&backend, &target, &"0".repeat(64), timeout(), shutdown())
                .await
                .unwrap_err();
        assert_eq!(error.code, ErrorCode::ValidationFailed);
        assert!(backend.requests().is_empty());

        let backend = FakeCreateBackend::table(
            FakeStatementResponse::Success,
            FakeTableVerification::Schema(fixture_described_schema()),
        );
        let preview = plan_create_table(&target).unwrap();
        let (sender, receiver) = watch::channel(true);
        let error =
            execute_create_table_with(&backend, &target, &preview.plan_hash, timeout(), receiver)
                .await
                .unwrap_err();
        drop(sender);
        assert_eq!(error.code, ErrorCode::OperationCanceled);
        assert!(backend.requests().is_empty());
    }

    #[tokio::test]
    async fn success_or_ambiguous_transport_requires_matching_remote_verification() {
        for (response, verification, expected) in [
            (
                FakeStatementResponse::Success,
                FakeTableVerification::Error,
                ErrorCode::OperationOutcomeUnknown,
            ),
            (
                FakeStatementResponse::Error(ClickHouseError::TimedOut),
                FakeTableVerification::Schema(fixture_described_schema()),
                ErrorCode::SystemInternal,
            ),
            (
                FakeStatementResponse::Error(ClickHouseError::TimedOut),
                FakeTableVerification::Missing,
                ErrorCode::OperationOutcomeUnknown,
            ),
        ] {
            let backend = FakeCreateBackend::table(response, verification);
            let target = fixture_create_table_target();
            let preview = plan_create_table(&target).unwrap();
            let result = execute_create_table_with(
                &backend,
                &target,
                &preview.plan_hash,
                timeout(),
                shutdown(),
            )
            .await;
            if expected == ErrorCode::SystemInternal {
                assert_eq!(result.unwrap().schema, fixture_described_schema());
            } else {
                let error = result.unwrap_err();
                assert_eq!(error.code, expected);
                assert_eq!(error.runtime_impact, RuntimeErrorImpact::Retryable);
            }
            assert_eq!(backend.requests().len(), 1);
        }
    }

    #[tokio::test]
    async fn server_conflict_is_not_retried_or_reclassified_as_ambiguous() {
        let backend = FakeCreateBackend::table(
            FakeStatementResponse::Error(ClickHouseError::BadResponse(
                "Code: 57. target=analytics.events query=CREATE password=secret".to_string(),
            )),
            FakeTableVerification::Schema(fixture_described_schema()),
        );
        let target = fixture_create_table_target();
        let preview = plan_create_table(&target).unwrap();
        let error =
            execute_create_table_with(&backend, &target, &preview.plan_hash, timeout(), shutdown())
                .await
                .unwrap_err();

        assert_eq!(error.code, ErrorCode::ResourceConflict);
        assert_eq!(error.runtime_impact, RuntimeErrorImpact::BusinessOnly);
        assert_eq!(backend.requests().len(), 1);
        assert!(backend.table_containers.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn shutdown_after_send_verifies_and_never_claims_noop_cancellation() {
        let backend = FakeCreateBackend::table(
            FakeStatementResponse::Pending,
            FakeTableVerification::Schema(fixture_described_schema()),
        );
        let target = fixture_create_table_target();
        let preview = plan_create_table(&target).unwrap();
        let (sender, receiver) = watch::channel(false);
        let execution =
            execute_create_table_with(&backend, &target, &preview.plan_hash, timeout(), receiver);
        tokio::pin!(execution);
        tokio::select! {
            biased;
            result = &mut execution => panic!("execution completed before shutdown: {result:?}"),
            _ = tokio::task::yield_now() => {}
        }
        assert_eq!(backend.requests().len(), 1);
        sender.send_replace(true);

        let result = execution.await.unwrap();
        assert_eq!(result.schema, fixture_described_schema());
        assert_eq!(backend.requests().len(), 1);
    }

    #[tokio::test]
    async fn database_verify_uses_exact_name_and_requires_existence() {
        let target = ClickHouseCreateDatabaseTarget {
            name: " analytics `raw` ".to_string(),
        };
        let preview = plan_create_database(&target).unwrap();
        let backend = FakeCreateBackend::database(
            FakeStatementResponse::Success,
            FakeDatabaseVerification::Exists(true),
        );
        let result = execute_create_database_with(
            &backend,
            &target,
            &preview.plan_hash,
            timeout(),
            shutdown(),
        )
        .await
        .unwrap();
        assert_eq!(result.name, target.name);
        assert_eq!(
            backend.database_names.lock().unwrap().as_slice(),
            [target.name.clone()]
        );

        let backend = FakeCreateBackend::database(
            FakeStatementResponse::Success,
            FakeDatabaseVerification::Exists(false),
        );
        let error = execute_create_database_with(
            &backend,
            &target,
            &preview.plan_hash,
            timeout(),
            shutdown(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::OperationOutcomeUnknown);
    }

    #[tokio::test]
    async fn table_verify_rejects_semantic_mismatch_and_readonly_schema() {
        let target = fixture_create_table_target();
        let preview = plan_create_table(&target).unwrap();
        let mut mismatch = fixture_described_schema();
        mismatch.columns[0].type_name = "UInt32".to_string();
        mismatch.identity.uuid = None;
        let mut readonly = fixture_described_schema();
        readonly.editability.mode =
            crate::engine::drivers::clickhouse::schema::ClickHouseSchemaEditabilityMode::Readonly;
        for schema in [mismatch, readonly] {
            let backend = FakeCreateBackend::table(
                FakeStatementResponse::Success,
                FakeTableVerification::Schema(schema),
            );
            let error = execute_create_table_with(
                &backend,
                &target,
                &preview.plan_hash,
                timeout(),
                shutdown(),
            )
            .await
            .unwrap_err();
            assert_eq!(error.code, ErrorCode::OperationOutcomeUnknown);
        }
    }

    #[test]
    fn semantic_verification_ignores_server_formatting_uuid_and_setting_order() {
        let target = fixture_create_table_target();
        let mut schema = fixture_described_schema();
        schema.identity.uuid = Some("server-generated".to_string());
        schema.engine.arguments[0] = " version ".to_string();
        schema.keys.order_by = "(id,version)".to_string();
        schema.keys.partition_by = Some("toYYYYMM( now() )".to_string());
        schema.table_ttl = Some("now()+INTERVAL 30 DAY DELETE".to_string());
        schema.settings.reverse();

        assert!(table_schema_matches_target(&target, &schema));
    }

    #[test]
    fn semantic_verification_allows_only_the_canonical_merge_tree_default_setting() {
        let mut target = fixture_create_table_target();
        target.settings.clear();
        let mut schema = fixture_described_schema();
        schema.settings = vec![ClickHouseSettingSchema {
            name: "index_granularity".to_string(),
            value: "8192".to_string(),
            explicit: true,
        }];

        assert!(table_schema_matches_target(&target, &schema));

        schema.settings[0].value = "4096".to_string();
        assert!(!table_schema_matches_target(&target, &schema));

        schema.settings[0] = ClickHouseSettingSchema {
            name: "ttl_only_drop_parts".to_string(),
            value: "0".to_string(),
            explicit: true,
        };
        assert!(!table_schema_matches_target(&target, &schema));

        target.settings = vec![ClickHouseCreateSettingTarget {
            name: "ttl_only_drop_parts".to_string(),
            value: "1".to_string(),
        }];
        schema.settings = vec![ClickHouseSettingSchema {
            name: "index_granularity".to_string(),
            value: "8192".to_string(),
            explicit: true,
        }];
        assert!(!table_schema_matches_target(&target, &schema));
    }
}
