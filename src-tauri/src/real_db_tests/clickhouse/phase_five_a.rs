use std::collections::BTreeSet;

use clickhouse::Client;
use serde::Deserialize;

use crate::engine::drivers::clickhouse::schema::{
    ClickHouseColumnDefaultKind, ClickHouseColumnSchema, ClickHouseSchemaBlocker,
    ClickHouseSchemaEditabilityMode, ClickHouseTableSchema,
};
use crate::engine::manager::ConnectionRuntimeManager;
use crate::engine::native_schema::{NativeSchemaDescribeRequest, NativeSchemaDocument};
use crate::engine::types::{ContainerKind, ContainerRef};
use crate::error::{IpcError, IpcResult};

pub(super) struct PhaseFiveAEvidence {
    pub server_version: String,
    pub engines: Vec<String>,
    pub described_tables: usize,
}

#[derive(clickhouse::Row, Deserialize)]
struct VersionRow {
    version: String,
}

struct FixtureNames {
    merge_tree: String,
    replacing: String,
    collapsing: String,
}

impl FixtureNames {
    fn from_prefix(prefix: &str) -> Self {
        Self {
            merge_tree: format!("{prefix}phase5a_merge_tree"),
            replacing: format!("{prefix}phase5a_replacing"),
            collapsing: format!("{prefix}phase5a_collapsing"),
        }
    }

    fn qualified_targets(&self, database: &str) -> Vec<String> {
        [
            self.merge_tree.as_str(),
            self.replacing.as_str(),
            self.collapsing.as_str(),
        ]
        .into_iter()
        .map(|table| qualified_name(database, table))
        .collect()
    }
}

struct FixtureCleanupGuard {
    targets: Vec<String>,
}

impl FixtureCleanupGuard {
    fn new(database: &str, names: &FixtureNames) -> Self {
        Self {
            targets: names.qualified_targets(database),
        }
    }

    async fn cleanup(&self, client: &Client) -> IpcResult<()> {
        let mut failed = 0usize;
        for target in &self.targets {
            let sql = format!("DROP TABLE IF EXISTS {target}");
            if client.query(&sql).execute().await.is_err() {
                failed += 1;
            }
        }

        if failed == 0 {
            Ok(())
        } else {
            Err(checkpoint_error(
                "ClickHouse Phase 5A fixture cleanup failed",
                format!("operation=cleanup; failed_targets={failed}"),
            ))
        }
    }
}

pub(super) fn quote_identifier(identifier: &str) -> String {
    let escaped = identifier.replace('\\', "\\\\").replace('`', "\\`");
    format!("`{escaped}`")
}

pub(super) fn qualified_name(database: &str, table: &str) -> String {
    format!("{}.{}", quote_identifier(database), quote_identifier(table))
}

pub(super) fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn ascii_number_after<'a>(value: &'a str, marker: &str) -> Option<&'a str> {
    let remainder = value.split_once(marker)?.1.trim_start();
    let length = remainder
        .bytes()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    (length > 0).then(|| &remainder[..length])
}

pub(super) fn sanitize_bad_response_details(response: &str) -> String {
    let code = ascii_number_after(response, "Code:").unwrap_or("unknown");
    let position = ascii_number_after(response, "position").unwrap_or("unknown");
    format!("server_code={code}; syntax_position={position}")
}

pub(super) fn summarize_blocker_codes(blockers: &[ClickHouseSchemaBlocker]) -> String {
    let codes = blockers
        .iter()
        .map(|blocker| blocker.code.as_str())
        .collect::<BTreeSet<_>>();
    if codes.is_empty() {
        "none".to_string()
    } else {
        codes.into_iter().collect::<Vec<_>>().join(",")
    }
}

pub(super) fn summarize_blocker_paths(blockers: &[ClickHouseSchemaBlocker]) -> String {
    let paths = blockers
        .iter()
        .map(|blocker| blocker.path.as_str())
        .collect::<BTreeSet<_>>();
    if paths.is_empty() {
        "none".to_string()
    } else {
        paths.into_iter().collect::<Vec<_>>().join(",")
    }
}

pub(super) fn merge_checkpoint_and_cleanup<T>(
    checkpoint: IpcResult<T>,
    cleanup: IpcResult<()>,
) -> IpcResult<T> {
    match (checkpoint, cleanup) {
        (Ok(evidence), Ok(())) => Ok(evidence),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(cleanup_error)) => Err(cleanup_error),
        (Err(error), Err(_cleanup_error)) => Err(checkpoint_error(
            "ClickHouse Phase 5A checkpoint failed and cleanup was incomplete",
            format!(
                "checkpoint=phase_five_a; primary_code={:?}; cleanup_failed=true",
                error.code
            ),
        )),
    }
}

fn checkpoint_error(message: impl Into<String>, details: impl Into<String>) -> IpcError {
    IpcError::system_internal(message, details)
}

fn ensure(condition: bool, message: &'static str) -> IpcResult<()> {
    if condition {
        Ok(())
    } else {
        Err(checkpoint_error(message, "checkpoint=phase_five_a"))
    }
}

async fn execute_fixture_sql(client: &Client, operation: &'static str, sql: &str) -> IpcResult<()> {
    client.query(sql).execute().await.map_err(|error| {
        let diagnostic = match error {
            clickhouse::error::Error::BadResponse(response) => {
                sanitize_bad_response_details(&response)
            }
            _ => "server_code=unavailable; syntax_position=unavailable".to_string(),
        };
        checkpoint_error(
            "ClickHouse Phase 5A fixture statement failed",
            format!("checkpoint=phase_five_a; operation={operation}; {diagnostic}"),
        )
    })
}

pub(super) fn merge_tree_fixture_sql(database: &str, table: &str) -> String {
    format!(
        r#"CREATE TABLE {}
        (
            id UInt64,
            tenant_id UInt32,
            created_at DateTime64(3, 'UTC') DEFAULT now64(3),
            event_date Date MATERIALIZED toDate(created_at),
            alias_id UInt64 ALIAS id,
            payload String COMMENT 'payload' CODEC(ZSTD(1)),
            expires_at DateTime TTL expires_at + INTERVAL 7 DAY,
            INDEX created_at_minmax created_at TYPE minmax GRANULARITY 1,
            PROJECTION by_tenant
            (
                SELECT tenant_id, count()
                GROUP BY tenant_id
            )
        )
        ENGINE = MergeTree
        PARTITION BY toYYYYMM(created_at)
        PRIMARY KEY (tenant_id, id)
        ORDER BY (tenant_id, id)
        TTL created_at + INTERVAL 30 DAY DELETE
        SETTINGS index_granularity = 8192
        COMMENT 'phase 5a merge tree'"#,
        qualified_name(database, table),
    )
}

async fn create_fixtures(client: &Client, database: &str, names: &FixtureNames) -> IpcResult<()> {
    let merge_tree_sql = merge_tree_fixture_sql(database, &names.merge_tree);
    let replacing_sql = format!(
        r#"CREATE TABLE {}
        (
            id UInt64,
            tenant_id UInt32,
            version UInt64,
            created_at DateTime64(3, 'UTC')
        )
        ENGINE = ReplacingMergeTree(version)
        PARTITION BY toYYYYMM(created_at)
        ORDER BY (tenant_id, id, created_at)"#,
        qualified_name(database, &names.replacing),
    );
    let collapsing_sql = format!(
        r#"CREATE TABLE {}
        (
            id UInt64,
            tenant_id UInt32,
            sign Int8,
            created_at DateTime64(3, 'UTC')
        )
        ENGINE = CollapsingMergeTree(sign)
        ORDER BY (tenant_id, id)"#,
        qualified_name(database, &names.collapsing),
    );

    execute_fixture_sql(client, "create_merge_tree", &merge_tree_sql).await?;
    execute_fixture_sql(client, "create_replacing_merge_tree", &replacing_sql).await?;
    execute_fixture_sql(client, "create_collapsing_merge_tree", &collapsing_sql).await
}

async fn server_version(client: &Client) -> IpcResult<String> {
    let row = client
        .query("SELECT version() AS version")
        .fetch_one::<VersionRow>()
        .await
        .map_err(|_| {
            checkpoint_error(
                "ClickHouse Phase 5A version probe failed",
                "checkpoint=phase_five_a; operation=version_probe",
            )
        })?;
    ensure(
        !row.version.trim().is_empty(),
        "ClickHouse Phase 5A version probe returned an empty value",
    )?;
    Ok(row.version)
}

async fn describe_table(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    database: &str,
    table: &str,
) -> IpcResult<ClickHouseTableSchema> {
    let document = manager
        .describe_native_schema(
            profile_id,
            NativeSchemaDescribeRequest::Table(ContainerRef::table(
                ContainerKind::Table,
                database,
                None,
                table,
            )),
        )
        .await?;
    let NativeSchemaDocument::ClickHouseTable(schema) = document else {
        return Err(IpcError::system_internal(
            "ClickHouse Phase 5A Describe returned the wrong document variant",
            "checkpoint=phase_five_a; assertion=table_document_variant",
        ));
    };
    Ok(*schema)
}

fn assert_common_schema(
    schema: &ClickHouseTableSchema,
    database: &str,
    table: &str,
) -> IpcResult<()> {
    ensure(
        schema.identity.database == database,
        "ClickHouse Phase 5A Describe returned the wrong database identity",
    )?;
    ensure(
        schema.identity.name == table,
        "ClickHouse Phase 5A Describe returned the wrong table identity",
    )?;
    ensure(
        schema.identity.object_kind == ContainerKind::Table,
        "ClickHouse Phase 5A Describe returned the wrong object kind",
    )?;
    if schema.editability.mode == ClickHouseSchemaEditabilityMode::Readonly {
        return Err(checkpoint_error(
            "ClickHouse Phase 5A supported fixture became readonly",
            format!(
                "checkpoint=phase_five_a; blocker_codes={}; blocker_paths={}",
                summarize_blocker_codes(&schema.editability.blockers),
                summarize_blocker_paths(&schema.editability.blockers),
            ),
        ));
    }
    ensure(
        is_lowercase_sha256(&schema.baseline.revision_hash),
        "ClickHouse Phase 5A Describe returned an invalid revision hash",
    )
}

async fn describe_stable_table(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    database: &str,
    table: &str,
) -> IpcResult<ClickHouseTableSchema> {
    let first = describe_table(manager, profile_id, database, table).await?;
    assert_common_schema(&first, database, table)?;
    let second = describe_table(manager, profile_id, database, table).await?;
    assert_common_schema(&second, database, table)?;
    ensure(
        first.baseline.revision_hash == second.baseline.revision_hash,
        "ClickHouse Phase 5A Describe revision was not stable",
    )?;
    Ok(first)
}

fn column<'a>(
    schema: &'a ClickHouseTableSchema,
    name: &str,
) -> IpcResult<&'a ClickHouseColumnSchema> {
    schema
        .columns
        .iter()
        .find(|column| column.name == name)
        .ok_or_else(|| {
            checkpoint_error(
                "ClickHouse Phase 5A Describe omitted an expected column",
                "checkpoint=phase_five_a; assertion=column_identity",
            )
        })
}

fn columns_equal(schema: &ClickHouseTableSchema, expected: &[&str]) -> bool {
    schema
        .columns
        .iter()
        .map(|column| column.name.as_str())
        .eq(expected.iter().copied())
}

fn contains(value: Option<&str>, needle: &str) -> bool {
    value.is_some_and(|value| value.contains(needle))
}

fn assert_merge_tree(schema: &ClickHouseTableSchema) -> IpcResult<()> {
    ensure(
        schema.engine.family == "MergeTree" && schema.engine.arguments.is_empty(),
        "ClickHouse Phase 5A MergeTree engine facts were incorrect",
    )?;
    ensure(
        columns_equal(
            schema,
            &[
                "id",
                "tenant_id",
                "created_at",
                "event_date",
                "alias_id",
                "payload",
                "expires_at",
            ],
        ),
        "ClickHouse Phase 5A MergeTree column order was incorrect",
    )?;

    let created_at = column(schema, "created_at")?;
    ensure(
        created_at.default_kind == ClickHouseColumnDefaultKind::Default
            && contains(created_at.default_expression.as_deref(), "now64(3)"),
        "ClickHouse Phase 5A default expression facts were incorrect",
    )?;
    let event_date = column(schema, "event_date")?;
    ensure(
        event_date.default_kind == ClickHouseColumnDefaultKind::Materialized
            && contains(
                event_date.default_expression.as_deref(),
                "toDate(created_at)",
            ),
        "ClickHouse Phase 5A materialized expression facts were incorrect",
    )?;
    let alias_id = column(schema, "alias_id")?;
    ensure(
        alias_id.default_kind == ClickHouseColumnDefaultKind::Alias
            && contains(alias_id.default_expression.as_deref(), "id"),
        "ClickHouse Phase 5A alias expression facts were incorrect",
    )?;
    let payload = column(schema, "payload")?;
    ensure(
        contains(payload.codec_expression.as_deref(), "ZSTD")
            && payload.comment.as_deref() == Some("payload"),
        "ClickHouse Phase 5A codec or column comment facts were incorrect",
    )?;
    let column_ttl = column(schema, "expires_at")?
        .ttl_expression
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    ensure(
        column_ttl.contains("expires_at") && column_ttl.contains('7') && column_ttl.contains("day"),
        "ClickHouse Phase 5A column TTL facts were incorrect",
    )?;
    ensure(
        schema.keys.order_by.contains("tenant_id")
            && schema.keys.order_by.contains("id")
            && contains(schema.keys.partition_by.as_deref(), "created_at")
            && contains(schema.keys.primary_key.as_deref(), "tenant_id")
            && contains(schema.keys.primary_key.as_deref(), "id"),
        "ClickHouse Phase 5A MergeTree key facts were incorrect",
    )?;
    let table_ttl = schema
        .table_ttl
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    // ClickHouse canonical CREATE may omit the default DELETE action; absence of
    // every non-delete action is therefore equivalent evidence.
    let table_ttl_facts = (
        table_ttl.contains("created_at"),
        table_ttl.contains("30"),
        table_ttl.contains("day"),
        table_ttl.contains("delete")
            || !["to disk", "to volume", "recompress", "group by"]
                .iter()
                .any(|action| table_ttl.contains(action)),
    );
    if table_ttl_facts != (true, true, true, true) {
        return Err(checkpoint_error(
            "ClickHouse Phase 5A table TTL facts were incorrect",
            format!(
                "checkpoint=phase_five_a; has_column={}; has_interval_value={}; has_day_unit={}; has_delete_semantics={}",
                table_ttl_facts.0, table_ttl_facts.1, table_ttl_facts.2, table_ttl_facts.3,
            ),
        ));
    }
    ensure(
        schema.comment.as_deref() == Some("phase 5a merge tree"),
        "ClickHouse Phase 5A table comment facts were incorrect",
    )?;
    ensure(
        schema.settings.iter().any(|setting| {
            setting.name == "index_granularity" && setting.value == "8192" && setting.explicit
        }),
        "ClickHouse Phase 5A explicit setting facts were incorrect",
    )?;
    ensure(
        schema.projections.iter().any(|projection| {
            projection.name == "by_tenant" && projection.query.contains("tenant_id")
        }),
        "ClickHouse Phase 5A projection facts were incorrect",
    )?;
    ensure(
        schema.skipping_indexes.iter().any(|index| {
            index.name == "created_at_minmax"
                && index.expression.contains("created_at")
                && index.index_type == "minmax"
                && index.type_arguments.is_empty()
                && index.granularity == Some(1)
        }),
        "ClickHouse Phase 5A data-skipping index facts were incorrect",
    )
}

fn assert_replacing_merge_tree(schema: &ClickHouseTableSchema) -> IpcResult<()> {
    ensure(
        schema.engine.family == "ReplacingMergeTree" && schema.engine.arguments == ["version"],
        "ClickHouse Phase 5A ReplacingMergeTree engine facts were incorrect",
    )?;
    ensure(
        columns_equal(schema, &["id", "tenant_id", "version", "created_at"]),
        "ClickHouse Phase 5A ReplacingMergeTree column order was incorrect",
    )?;
    ensure(
        schema.keys.order_by.contains("tenant_id")
            && schema.keys.order_by.contains("id")
            && schema.keys.order_by.contains("created_at")
            && contains(schema.keys.partition_by.as_deref(), "created_at"),
        "ClickHouse Phase 5A ReplacingMergeTree key facts were incorrect",
    )
}

fn assert_collapsing_merge_tree(schema: &ClickHouseTableSchema) -> IpcResult<()> {
    ensure(
        schema.engine.family == "CollapsingMergeTree" && schema.engine.arguments == ["sign"],
        "ClickHouse Phase 5A CollapsingMergeTree engine facts were incorrect",
    )?;
    ensure(
        columns_equal(schema, &["id", "tenant_id", "sign", "created_at"]),
        "ClickHouse Phase 5A CollapsingMergeTree column order was incorrect",
    )?;
    ensure(
        schema.keys.order_by.contains("tenant_id") && schema.keys.order_by.contains("id"),
        "ClickHouse Phase 5A CollapsingMergeTree key facts were incorrect",
    )
}

async fn run_checkpoint(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    client: &Client,
    database: &str,
    names: &FixtureNames,
) -> IpcResult<PhaseFiveAEvidence> {
    let runtime = manager.capabilities(profile_id)?;
    ensure(
        runtime.capabilities.schema_browser && !runtime.capabilities.schema_mutator,
        "ClickHouse Phase 5A requires schema browsing without the legacy schema mutator",
    )?;

    let server_version = server_version(client).await?;
    create_fixtures(client, database, names).await?;
    let merge_tree =
        describe_stable_table(manager, profile_id, database, &names.merge_tree).await?;
    let replacing = describe_stable_table(manager, profile_id, database, &names.replacing).await?;
    let collapsing =
        describe_stable_table(manager, profile_id, database, &names.collapsing).await?;

    assert_merge_tree(&merge_tree)?;
    assert_replacing_merge_tree(&replacing)?;
    assert_collapsing_merge_tree(&collapsing)?;

    Ok(PhaseFiveAEvidence {
        server_version,
        engines: vec![
            merge_tree.engine.family,
            replacing.engine.family,
            collapsing.engine.family,
        ],
        described_tables: 3,
    })
}

pub(super) async fn run(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    client: &Client,
    database: &str,
    prefix: &str,
) -> IpcResult<PhaseFiveAEvidence> {
    let names = FixtureNames::from_prefix(prefix);
    let cleanup = FixtureCleanupGuard::new(database, &names);
    cleanup.cleanup(client).await?;

    let checkpoint = run_checkpoint(manager, profile_id, client, database, &names).await;
    let cleanup_result = cleanup.cleanup(client).await;

    merge_checkpoint_and_cleanup(checkpoint, cleanup_result)
}
