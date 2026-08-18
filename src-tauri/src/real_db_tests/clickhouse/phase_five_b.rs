use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use clickhouse::Client;
use serde::Deserialize;

use crate::engine::drivers::clickhouse::schema::{
    ClickHouseCodecTarget, ClickHouseColumnDefaultKind, ClickHouseCreateColumnTarget,
    ClickHouseCreateDatabaseTarget, ClickHouseCreateEngineTarget, ClickHouseCreateSettingTarget,
    ClickHouseCreateTableTarget, ClickHouseKeySchema, ClickHouseSchemaEditabilityMode,
    ClickHouseTableSchema,
};
use crate::engine::manager::ConnectionRuntimeManager;
use crate::engine::native_schema::{
    NativeSchemaCreateResult, NativeSchemaCreateTarget, NativeSchemaDescribeRequest,
    NativeSchemaDocument, NativeSchemaExecuteCreateRequest, NativeSchemaExtension,
    NativeSchemaMutationPreview,
};
use crate::engine::registry::DriverRegistry;
use crate::engine::types::{
    ContainerKind, ContainerRef, DriverCapabilities, SchemaMutationOperation,
};
use crate::error::{ErrorCode, IpcError, IpcResult};
use crate::repository::connection_repository::StoredConnectionRecord;

use super::phase_five_a::{is_lowercase_sha256, quote_identifier};

static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(super) struct PhaseFiveBEvidence {
    pub server_version: String,
    pub database_created: bool,
    pub engines: Vec<String>,
    pub described_tables: usize,
    pub duplicate_conflicts: usize,
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub(super) enum PhaseFiveBCapabilityExpectation {
    Closed,
    Published,
}

#[derive(clickhouse::Row, Deserialize)]
struct CountRow {
    count: u64,
}

#[derive(clickhouse::Row, Deserialize)]
struct VersionRow {
    version: String,
}

struct DatabaseCleanupGuard {
    database_name: String,
    scratch_prefix: String,
}

impl DatabaseCleanupGuard {
    fn new(database_name: String, scratch_prefix: &str) -> IpcResult<Self> {
        validate_database_scope(&database_name, scratch_prefix)?;
        Ok(Self {
            database_name,
            scratch_prefix: scratch_prefix.to_string(),
        })
    }

    async fn cleanup(&self, client: &Client) -> IpcResult<()> {
        validate_database_scope(&self.database_name, &self.scratch_prefix)?;
        let sql = format!(
            "DROP DATABASE IF EXISTS {}",
            quote_identifier(&self.database_name),
        );
        client.query(&sql).execute().await.map_err(|_| {
            checkpoint_error(
                "ClickHouse Phase 5B fixture cleanup failed",
                "checkpoint=phase_five_b; operation=drop_scratch_database",
            )
        })?;
        ensure(
            !database_exists(client, &self.database_name).await?,
            "ClickHouse Phase 5B scratch database remained after cleanup",
            "assertion=cleanup_absence",
        )
    }
}

fn checkpoint_error(message: impl Into<String>, details: impl Into<String>) -> IpcError {
    IpcError::system_internal(message, details)
}

fn ensure(condition: bool, message: &'static str, assertion: &'static str) -> IpcResult<()> {
    if condition {
        Ok(())
    } else {
        Err(checkpoint_error(
            message,
            format!("checkpoint=phase_five_b; {assertion}"),
        ))
    }
}

fn validate_database_scope(database_name: &str, prefix: &str) -> IpcResult<()> {
    ensure(
        !prefix.is_empty()
            && database_name.starts_with(prefix)
            && database_name.len() > prefix.len()
            && database_name
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_'),
        "ClickHouse Phase 5B refused an out-of-scope cleanup target",
        "assertion=scratch_prefix_scope",
    )
}

fn unique_database_name(prefix: &str) -> IpcResult<String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| {
            checkpoint_error(
                "ClickHouse Phase 5B fixture clock was invalid",
                "checkpoint=phase_five_b; operation=fixture_identity",
            )
        })?
        .as_millis();
    let sequence = FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let name = format!("{prefix}phase5b_{timestamp}_{sequence}");
    validate_database_scope(&name, prefix)?;
    Ok(name)
}

async fn database_exists(client: &Client, database_name: &str) -> IpcResult<bool> {
    client
        .query("SELECT count() AS count FROM system.databases WHERE name = ?")
        .bind(database_name)
        .fetch_one::<CountRow>()
        .await
        .map(|row| row.count > 0)
        .map_err(|_| {
            checkpoint_error(
                "ClickHouse Phase 5B database verification failed",
                "checkpoint=phase_five_b; operation=verify_database",
            )
        })
}

async fn server_version(client: &Client) -> IpcResult<String> {
    let row = client
        .query("SELECT version() AS version")
        .fetch_one::<VersionRow>()
        .await
        .map_err(|_| {
            checkpoint_error(
                "ClickHouse Phase 5B version probe failed",
                "checkpoint=phase_five_b; operation=version_probe",
            )
        })?;
    ensure(
        !row.version.trim().is_empty(),
        "ClickHouse Phase 5B version probe returned an empty value",
        "assertion=server_version",
    )?;
    Ok(row.version)
}

fn capability_supports(
    capabilities: &DriverCapabilities,
    kind: ContainerKind,
    operation: SchemaMutationOperation,
) -> bool {
    capabilities
        .schema_mutation
        .as_ref()
        .is_some_and(|features| {
            features
                .objects
                .iter()
                .any(|object| object.kind == kind && object.operations.contains(&operation))
        })
}

fn validate_capability_expectation(
    capabilities: &DriverCapabilities,
    expectation: PhaseFiveBCapabilityExpectation,
) -> IpcResult<()> {
    ensure(
        !capabilities.schema_mutator,
        "ClickHouse Phase 5B unexpectedly enabled the relational schema mutator",
        "assertion=schema_mutator_false",
    )?;
    match expectation {
        PhaseFiveBCapabilityExpectation::Closed => ensure(
            capabilities.schema_mutation.is_none(),
            "ClickHouse Phase 5B direct checkpoint expected capability to remain closed",
            "assertion=schema_mutation_closed",
        ),
        PhaseFiveBCapabilityExpectation::Published => {
            let mutation = capabilities.schema_mutation.as_ref().ok_or_else(|| {
                checkpoint_error(
                    "ClickHouse Phase 5B expected published create capability",
                    "checkpoint=phase_five_b; assertion=schema_mutation_published",
                )
            })?;
            ensure(
                capability_supports(
                    capabilities,
                    ContainerKind::Database,
                    SchemaMutationOperation::Create,
                ) && capability_supports(
                    capabilities,
                    ContainerKind::Table,
                    SchemaMutationOperation::Create,
                ) && mutation.ddl_preview,
                "ClickHouse Phase 5B published create capability was unavailable",
                "assertion=schema_mutation_create_subset",
            )
        }
    }
}

#[async_trait]
trait PhaseFiveBCreateDispatcher: Send + Sync {
    async fn preview_create(
        &self,
        target: &NativeSchemaCreateTarget,
    ) -> IpcResult<NativeSchemaMutationPreview>;

    async fn execute_create(
        &self,
        request: &NativeSchemaExecuteCreateRequest,
    ) -> IpcResult<NativeSchemaCreateResult>;

    async fn describe_table(
        &self,
        target: &ClickHouseCreateTableTarget,
    ) -> IpcResult<ClickHouseTableSchema>;
}

struct DirectCreateDispatcher<'a> {
    extension: &'a dyn NativeSchemaExtension,
}

#[async_trait]
impl PhaseFiveBCreateDispatcher for DirectCreateDispatcher<'_> {
    async fn preview_create(
        &self,
        target: &NativeSchemaCreateTarget,
    ) -> IpcResult<NativeSchemaMutationPreview> {
        self.extension.preview_create(target).await
    }

    async fn execute_create(
        &self,
        request: &NativeSchemaExecuteCreateRequest,
    ) -> IpcResult<NativeSchemaCreateResult> {
        self.extension.execute_create(request).await
    }

    async fn describe_table(
        &self,
        target: &ClickHouseCreateTableTarget,
    ) -> IpcResult<ClickHouseTableSchema> {
        describe_through_extension(self.extension, target).await
    }
}

struct ManagerCreateDispatcher<'a> {
    manager: &'a ConnectionRuntimeManager,
    profile_id: &'a str,
}

#[async_trait]
impl PhaseFiveBCreateDispatcher for ManagerCreateDispatcher<'_> {
    async fn preview_create(
        &self,
        target: &NativeSchemaCreateTarget,
    ) -> IpcResult<NativeSchemaMutationPreview> {
        self.manager
            .preview_native_schema_create(self.profile_id, target.clone())
            .await
    }

    async fn execute_create(
        &self,
        request: &NativeSchemaExecuteCreateRequest,
    ) -> IpcResult<NativeSchemaCreateResult> {
        self.manager
            .execute_native_schema_create(self.profile_id, request.clone())
            .await
    }

    async fn describe_table(
        &self,
        target: &ClickHouseCreateTableTarget,
    ) -> IpcResult<ClickHouseTableSchema> {
        let document = self
            .manager
            .describe_native_schema(
                self.profile_id,
                NativeSchemaDescribeRequest::Table(ContainerRef::table(
                    ContainerKind::Table,
                    &target.database,
                    None,
                    &target.name,
                )),
            )
            .await?;
        let NativeSchemaDocument::ClickHouseTable(schema) = document else {
            return Err(IpcError::system_internal(
                "ClickHouse Phase 5B Manager Describe returned the wrong document variant",
                "checkpoint=phase_five_b; assertion=manager_table_document_variant",
            ));
        };
        Ok(*schema)
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

fn merge_tree_target(database: &str) -> ClickHouseCreateTableTarget {
    let mut payload = column("payload", "String", ClickHouseColumnDefaultKind::None, None);
    payload.comment = Some("phase 5b payload".to_string());
    payload.codecs = vec![ClickHouseCodecTarget {
        name: "ZSTD".to_string(),
        arguments: vec!["1".to_string()],
    }];
    payload.ttl_expression = Some("created_at".to_string());

    ClickHouseCreateTableTarget {
        database: database.to_string(),
        name: "merge_tree".to_string(),
        columns: vec![
            column(
                "tenant_id",
                "UInt64",
                ClickHouseColumnDefaultKind::None,
                None,
            ),
            column("id", "UInt64", ClickHouseColumnDefaultKind::None, None),
            column(
                "created_at",
                "DateTime",
                ClickHouseColumnDefaultKind::Default,
                Some("now()"),
            ),
            column(
                "event_date",
                "Date",
                ClickHouseColumnDefaultKind::Materialized,
                Some("toDate(created_at)"),
            ),
            column(
                "alias_id",
                "UInt64",
                ClickHouseColumnDefaultKind::Alias,
                Some("id"),
            ),
            payload,
        ],
        engine: ClickHouseCreateEngineTarget {
            family: "MergeTree".to_string(),
            arguments: Vec::new(),
        },
        keys: ClickHouseKeySchema {
            order_by: "(tenant_id, id, created_at)".to_string(),
            partition_by: Some("toYYYYMM(created_at)".to_string()),
            primary_key: Some("(tenant_id, id)".to_string()),
            sample_by: Some("id".to_string()),
        },
        table_ttl: Some("created_at".to_string()),
        comment: Some("phase 5b merge tree".to_string()),
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

fn replacing_target(database: &str) -> ClickHouseCreateTableTarget {
    ClickHouseCreateTableTarget {
        database: database.to_string(),
        name: "replacing".to_string(),
        columns: vec![
            column("id", "UInt64", ClickHouseColumnDefaultKind::None, None),
            column("version", "UInt64", ClickHouseColumnDefaultKind::None, None),
            column(
                "created_at",
                "DateTime",
                ClickHouseColumnDefaultKind::Default,
                Some("now()"),
            ),
        ],
        engine: ClickHouseCreateEngineTarget {
            family: "ReplacingMergeTree".to_string(),
            arguments: vec!["version".to_string()],
        },
        keys: ClickHouseKeySchema {
            order_by: "(id, created_at)".to_string(),
            partition_by: None,
            primary_key: None,
            sample_by: None,
        },
        table_ttl: None,
        comment: None,
        settings: Vec::new(),
    }
}

fn collapsing_target(database: &str) -> ClickHouseCreateTableTarget {
    ClickHouseCreateTableTarget {
        database: database.to_string(),
        name: "collapsing".to_string(),
        columns: vec![
            column("id", "UInt64", ClickHouseColumnDefaultKind::None, None),
            column("sign", "Int8", ClickHouseColumnDefaultKind::None, None),
            column(
                "created_at",
                "DateTime",
                ClickHouseColumnDefaultKind::Default,
                Some("now()"),
            ),
        ],
        engine: ClickHouseCreateEngineTarget {
            family: "CollapsingMergeTree".to_string(),
            arguments: vec!["sign".to_string()],
        },
        keys: ClickHouseKeySchema {
            order_by: "(id, created_at)".to_string(),
            partition_by: None,
            primary_key: None,
            sample_by: None,
        },
        table_ttl: None,
        comment: None,
        settings: Vec::new(),
    }
}

fn assert_preview(preview: &NativeSchemaMutationPreview) -> IpcResult<()> {
    ensure(
        preview.statements.len() == 1,
        "ClickHouse Phase 5B preview did not contain exactly one statement",
        "assertion=single_statement",
    )?;
    ensure(
        !preview.statements[0].contains("IF NOT EXISTS"),
        "ClickHouse Phase 5B preview unexpectedly hid duplicate conflicts",
        "assertion=no_if_not_exists",
    )?;
    ensure(
        !preview.destructive && !preview.long_running,
        "ClickHouse Phase 5B create preview had unsafe classification",
        "assertion=create_classification",
    )?;
    ensure(
        is_lowercase_sha256(&preview.plan_hash),
        "ClickHouse Phase 5B preview returned an invalid plan hash",
        "assertion=plan_hash",
    )
}

fn normalize_expression(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut quote = None;
    let mut escaped = false;
    for character in value.trim().chars() {
        if let Some(active_quote) = quote {
            normalized.push(character);
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == active_quote {
                quote = None;
            }
        } else if matches!(character, '\'' | '"' | '`') {
            quote = Some(character);
            normalized.push(character);
        } else if !character.is_whitespace() {
            normalized.push(character);
        }
    }
    normalized
}

fn optional_expression_equal(actual: Option<&str>, expected: Option<&str>) -> bool {
    match (actual, expected) {
        (None, None) => true,
        (Some(actual), Some(expected)) => {
            normalize_expression(actual) == normalize_expression(expected)
        }
        _ => false,
    }
}

fn assert_schema_matches_target(
    schema: &ClickHouseTableSchema,
    target: &ClickHouseCreateTableTarget,
) -> IpcResult<()> {
    ensure(
        schema.identity.database == target.database
            && schema.identity.name == target.name
            && schema.identity.object_kind == ContainerKind::Table,
        "ClickHouse Phase 5B Describe returned the wrong table identity",
        "assertion=table_identity",
    )?;
    ensure(
        schema.editability.mode == ClickHouseSchemaEditabilityMode::Editable
            && schema.editability.blockers.is_empty()
            && schema.projections.is_empty()
            && schema.skipping_indexes.is_empty(),
        "ClickHouse Phase 5B created table was not an editable supported baseline",
        "assertion=editability",
    )?;
    ensure(
        schema.engine.family == target.engine.family
            && schema.engine.arguments.len() == target.engine.arguments.len()
            && schema
                .engine
                .arguments
                .iter()
                .zip(&target.engine.arguments)
                .all(|(actual, expected)| {
                    normalize_expression(actual) == normalize_expression(expected)
                }),
        "ClickHouse Phase 5B Describe returned the wrong engine facts",
        "assertion=engine",
    )?;
    ensure(
        schema.columns.len() == target.columns.len(),
        "ClickHouse Phase 5B Describe returned the wrong column count",
        "assertion=column_count",
    )?;
    for (index, (actual, expected)) in schema.columns.iter().zip(&target.columns).enumerate() {
        let expected_codec = if expected.codecs.is_empty() {
            None
        } else {
            Some(format!(
                "CODEC({})",
                expected
                    .codecs
                    .iter()
                    .map(|codec| if codec.arguments.is_empty() {
                        codec.name.clone()
                    } else {
                        format!("{}({})", codec.name, codec.arguments.join(", "))
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        };
        ensure(
            actual.position == index as u64 + 1
                && actual.name == expected.name
                && normalize_expression(&actual.type_name)
                    == normalize_expression(&expected.type_name)
                && actual.default_kind == expected.default_kind
                && optional_expression_equal(
                    actual.default_expression.as_deref(),
                    expected.default_expression.as_deref(),
                )
                && optional_expression_equal(
                    actual.codec_expression.as_deref(),
                    expected_codec.as_deref(),
                )
                && optional_expression_equal(
                    actual.ttl_expression.as_deref(),
                    expected.ttl_expression.as_deref(),
                )
                && actual.comment == expected.comment
                && actual.editability.mode == ClickHouseSchemaEditabilityMode::Editable
                && actual.editability.blockers.is_empty(),
            "ClickHouse Phase 5B Describe returned different ordered column semantics",
            "assertion=column_semantics",
        )?;
    }
    ensure(
        normalize_expression(&schema.keys.order_by) == normalize_expression(&target.keys.order_by)
            && optional_expression_equal(
                schema.keys.partition_by.as_deref(),
                target.keys.partition_by.as_deref(),
            )
            && optional_expression_equal(
                schema.keys.primary_key.as_deref(),
                target.keys.primary_key.as_deref(),
            )
            && optional_expression_equal(
                schema.keys.sample_by.as_deref(),
                target.keys.sample_by.as_deref(),
            )
            && optional_expression_equal(schema.table_ttl.as_deref(), target.table_ttl.as_deref())
            && schema.comment == target.comment,
        "ClickHouse Phase 5B Describe returned different key, TTL, or comment semantics",
        "assertion=table_semantics",
    )?;

    let target_setting_exists = |name: &str, value: &str| {
        target
            .settings
            .iter()
            .any(|setting| setting.name == name && setting.value == value)
    };
    let schema_setting_exists = |name: &str, value: &str| {
        schema
            .settings
            .iter()
            .any(|setting| setting.name == name && setting.value == value)
    };
    ensure(
        target
            .settings
            .iter()
            .all(|setting| schema_setting_exists(&setting.name, &setting.value))
            && schema
                .settings
                .iter()
                .filter(|setting| setting.explicit)
                .all(|setting| {
                    target_setting_exists(&setting.name, &setting.value)
                        || (setting.name == "index_granularity" && setting.value == "8192")
                }),
        "ClickHouse Phase 5B Describe returned different explicit settings",
        "assertion=explicit_settings",
    )?;
    ensure(
        is_lowercase_sha256(&schema.baseline.revision_hash),
        "ClickHouse Phase 5B Describe returned an invalid revision hash",
        "assertion=revision_hash",
    )
}

async fn describe_through_extension(
    extension: &dyn NativeSchemaExtension,
    target: &ClickHouseCreateTableTarget,
) -> IpcResult<ClickHouseTableSchema> {
    let document = extension
        .describe(&NativeSchemaDescribeRequest::Table(ContainerRef::table(
            ContainerKind::Table,
            &target.database,
            None,
            &target.name,
        )))
        .await?;
    let NativeSchemaDocument::ClickHouseTable(schema) = document else {
        return Err(IpcError::system_internal(
            "ClickHouse Phase 5B Direct Describe returned the wrong document variant",
            "checkpoint=phase_five_b; assertion=direct_table_document_variant",
        ));
    };
    Ok(*schema)
}

async fn create_table(
    dispatcher: &dyn PhaseFiveBCreateDispatcher,
    target: &ClickHouseCreateTableTarget,
) -> IpcResult<ClickHouseTableSchema> {
    let tagged_target = NativeSchemaCreateTarget::ClickHouseTable(Box::new(target.clone()));
    let preview = dispatcher.preview_create(&tagged_target).await?;
    assert_preview(&preview)?;
    if target.engine.family == "MergeTree" {
        let statement = &preview.statements[0];
        let comment_position = statement.find("COMMENT 'phase 5b payload'");
        let codec_position = statement.find("CODEC(ZSTD(1))");
        ensure(
            comment_position.is_some()
                && codec_position.is_some()
                && comment_position < codec_position,
            "ClickHouse Phase 5B preview did not render comment before codec",
            "assertion=comment_before_codec",
        )?;
    }

    let execute_result = dispatcher
        .execute_create(&NativeSchemaExecuteCreateRequest {
            target: tagged_target,
            expected_plan_hash: preview.plan_hash,
            confirmation: None,
            baseline: None,
        })
        .await;
    let result = match execute_result {
        Ok(result) => result,
        Err(error) if error.code == ErrorCode::OperationOutcomeUnknown => {
            match dispatcher.describe_table(target).await {
                Ok(schema) => match assert_schema_matches_target(&schema, target) {
                    Ok(()) => {
                        return Err(checkpoint_error(
                            "ClickHouse Phase 5B executor rejected a matching remote schema",
                            "checkpoint=phase_five_b; assertion=executor_verify_divergence",
                        ));
                    }
                    Err(diagnostic) => return Err(diagnostic),
                },
                Err(describe_error) => {
                    return Err(checkpoint_error(
                        "ClickHouse Phase 5B outcome was unknown and diagnostic Describe failed",
                        format!(
                            "checkpoint=phase_five_b; operation=diagnostic_describe; execute_code={:?}; describe_code={:?}",
                            error.code, describe_error.code,
                        ),
                    ));
                }
            }
        }
        Err(error) => return Err(error),
    };
    let NativeSchemaCreateResult::ClickHouseTable(result) = result else {
        return Err(checkpoint_error(
            "ClickHouse Phase 5B table create returned the wrong result variant",
            "checkpoint=phase_five_b; assertion=table_result_variant",
        ));
    };
    ensure(
        result.table_name == target.name
            && result.container
                == ContainerRef::table(ContainerKind::Table, &target.database, None, &target.name),
        "ClickHouse Phase 5B table create returned the wrong container",
        "assertion=table_result_container",
    )?;
    assert_schema_matches_target(&result.schema, target)?;

    let described = dispatcher.describe_table(target).await?;
    assert_schema_matches_target(&described, target)?;
    ensure(
        result.schema.baseline.revision_hash == described.baseline.revision_hash,
        "ClickHouse Phase 5B Describe revision was not stable",
        "assertion=stable_revision",
    )?;
    Ok(result.schema)
}

async fn require_duplicate_conflict(
    dispatcher: &dyn PhaseFiveBCreateDispatcher,
    target: NativeSchemaCreateTarget,
) -> IpcResult<()> {
    let preview = dispatcher.preview_create(&target).await?;
    assert_preview(&preview)?;
    let error = dispatcher
        .execute_create(&NativeSchemaExecuteCreateRequest {
            target,
            expected_plan_hash: preview.plan_hash,
            confirmation: None,
            baseline: None,
        })
        .await
        .expect_err("duplicate ClickHouse create must fail");
    ensure(
        error.code == ErrorCode::ResourceConflict,
        "ClickHouse Phase 5B duplicate create did not return RESOURCE_CONFLICT",
        "assertion=duplicate_conflict",
    )
}

async fn run_checkpoint(
    dispatcher: &dyn PhaseFiveBCreateDispatcher,
    client: &Client,
    database_name: &str,
) -> IpcResult<PhaseFiveBEvidence> {
    let server_version = server_version(client).await?;
    let database_target =
        NativeSchemaCreateTarget::ClickHouseDatabase(ClickHouseCreateDatabaseTarget {
            name: database_name.to_string(),
        });
    let database_preview = dispatcher.preview_create(&database_target).await?;
    assert_preview(&database_preview)?;
    let database_result = dispatcher
        .execute_create(&NativeSchemaExecuteCreateRequest {
            target: database_target.clone(),
            expected_plan_hash: database_preview.plan_hash,
            confirmation: None,
            baseline: None,
        })
        .await?;
    let NativeSchemaCreateResult::ClickHouseDatabase(database_result) = database_result else {
        return Err(checkpoint_error(
            "ClickHouse Phase 5B database create returned the wrong result variant",
            "checkpoint=phase_five_b; assertion=database_result_variant",
        ));
    };
    ensure(
        database_result.name == database_name
            && database_result.container == ContainerRef::database(database_name),
        "ClickHouse Phase 5B database create returned the wrong container",
        "assertion=database_result_container",
    )?;
    ensure(
        database_exists(client, database_name).await?,
        "ClickHouse Phase 5B created database was not visible in system.databases",
        "assertion=database_exists",
    )?;
    require_duplicate_conflict(dispatcher, database_target).await?;

    let targets = [
        merge_tree_target(database_name),
        replacing_target(database_name),
        collapsing_target(database_name),
    ];
    let mut engines = Vec::with_capacity(targets.len());
    for target in &targets {
        let schema = create_table(dispatcher, target).await?;
        engines.push(schema.engine.family);
    }
    require_duplicate_conflict(
        dispatcher,
        NativeSchemaCreateTarget::ClickHouseTable(Box::new(targets[0].clone())),
    )
    .await?;

    Ok(PhaseFiveBEvidence {
        server_version,
        database_created: true,
        engines,
        described_tables: targets.len(),
        duplicate_conflicts: 2,
    })
}

fn merge_checkpoint_and_cleanup<T>(
    checkpoint: IpcResult<T>,
    cleanup: IpcResult<()>,
) -> IpcResult<T> {
    match (checkpoint, cleanup) {
        (Ok(evidence), Ok(())) => Ok(evidence),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(cleanup_error)) => Err(cleanup_error),
        (Err(error), Err(_cleanup_error)) => Err(checkpoint_error(
            "ClickHouse Phase 5B checkpoint failed and cleanup was incomplete",
            format!(
                "checkpoint=phase_five_b; primary_code={:?}; cleanup_failed=true",
                error.code
            ),
        )),
    }
}

fn merge_cleanup_and_close(cleanup: IpcResult<()>, close: IpcResult<()>) -> IpcResult<()> {
    match (cleanup, close) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) => Err(error),
        (Ok(()), Err(error)) => Err(checkpoint_error(
            "ClickHouse Phase 5B isolated driver close failed",
            format!(
                "checkpoint=phase_five_b; operation=close_driver; code={:?}",
                error.code
            ),
        )),
        (Err(error), Err(_close_error)) => Err(checkpoint_error(
            "ClickHouse Phase 5B cleanup and isolated driver close both failed",
            format!(
                "checkpoint=phase_five_b; cleanup_code={:?}; close_failed=true",
                error.code
            ),
        )),
    }
}

pub(super) async fn run_direct(
    record: &StoredConnectionRecord,
    client: &Client,
    prefix: &str,
    capability_expectation: PhaseFiveBCapabilityExpectation,
) -> IpcResult<PhaseFiveBEvidence> {
    let database_name = unique_database_name(prefix)?;
    let cleanup = DatabaseCleanupGuard::new(database_name.clone(), prefix)?;
    let driver = DriverRegistry::create_driver("real-clickhouse-phase-5b-direct", record).await?;
    let capabilities = driver.capabilities();
    let capability_check = validate_capability_expectation(&capabilities, capability_expectation);
    let extension_check = ensure(
        driver.as_schema_mutator().is_none() && driver.as_native_schema_extension().is_some(),
        "ClickHouse Phase 5B direct driver exposed the wrong extension set",
        "assertion=driver_extensions",
    );
    let initial_cleanup = cleanup.cleanup(client).await;

    let checkpoint = match (capability_check, extension_check, initial_cleanup) {
        (Ok(()), Ok(()), Ok(())) => {
            let extension = driver
                .as_native_schema_extension()
                .expect("validated ClickHouse native schema extension");
            let dispatcher = DirectCreateDispatcher { extension };
            run_checkpoint(&dispatcher, client, &database_name).await
        }
        (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => Err(error),
    };
    let cleanup_result = cleanup.cleanup(client).await;
    let close_result = driver.close().await;
    let teardown_result = merge_cleanup_and_close(cleanup_result, close_result);

    merge_checkpoint_and_cleanup(checkpoint, teardown_result)
}

pub(super) async fn run_manager(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    client: &Client,
    prefix: &str,
) -> IpcResult<PhaseFiveBEvidence> {
    let database_name = unique_database_name(prefix)?;
    let cleanup = DatabaseCleanupGuard::new(database_name.clone(), prefix)?;
    let runtime = manager.capabilities(profile_id)?;
    let capability_check = validate_capability_expectation(
        &runtime.capabilities,
        PhaseFiveBCapabilityExpectation::Published,
    );
    let initial_cleanup = cleanup.cleanup(client).await;
    let checkpoint = match (capability_check, initial_cleanup) {
        (Ok(()), Ok(())) => {
            let dispatcher = ManagerCreateDispatcher {
                manager,
                profile_id,
            };
            run_checkpoint(&dispatcher, client, &database_name).await
        }
        (Err(error), _) | (_, Err(error)) => Err(error),
    };
    let cleanup_result = cleanup.cleanup(client).await;

    merge_checkpoint_and_cleanup(checkpoint, cleanup_result)
}
