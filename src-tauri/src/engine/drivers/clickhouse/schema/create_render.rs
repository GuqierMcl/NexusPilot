#![allow(dead_code)]

use sha2::{Digest, Sha256};

use crate::engine::native_schema::{NativeSchemaMutationPreview, NativeSchemaRequiredConfirmation};
use crate::error::IpcResult;

use super::create_types::{
    ClickHouseCreateColumnTarget, ClickHouseCreateDatabaseTarget, ClickHouseCreateTableTarget,
};
use super::create_validate::{validate_create_database_target, validate_create_table_target};
use super::types::ClickHouseColumnDefaultKind;

const CREATE_DATABASE_HASH_DOMAIN: &str = "nexpilot/native-schema/clickhouse/create-database/v1";
const CREATE_TABLE_HASH_DOMAIN: &str = "nexpilot/native-schema/clickhouse/create-table/v1";

pub(super) fn plan_create_database(
    target: &ClickHouseCreateDatabaseTarget,
) -> IpcResult<NativeSchemaMutationPreview> {
    validate_create_database_target(target)?;
    preview(
        CREATE_DATABASE_HASH_DOMAIN,
        format!("CREATE DATABASE {}", quote_identifier(&target.name)),
    )
}

pub(super) fn plan_create_table(
    target: &ClickHouseCreateTableTarget,
) -> IpcResult<NativeSchemaMutationPreview> {
    validate_create_table_target(target)?;
    preview(CREATE_TABLE_HASH_DOMAIN, render_create_table(target))
}

fn preview(domain: &str, statement: String) -> IpcResult<NativeSchemaMutationPreview> {
    let statements = vec![statement];
    Ok(NativeSchemaMutationPreview {
        plan_hash: plan_hash(domain, &statements),
        statements,
        warnings: Vec::new(),
        destructive: false,
        long_running: false,
        risk_flags: Vec::new(),
        required_confirmation: NativeSchemaRequiredConfirmation::None,
        baseline: None,
    })
}

fn render_create_table(target: &ClickHouseCreateTableTarget) -> String {
    let columns = target
        .columns
        .iter()
        .map(|column| format!("    {}", render_column_definition(column)))
        .collect::<Vec<_>>()
        .join(",\n");

    let engine = if target.engine.arguments.is_empty() {
        target.engine.family.clone()
    } else {
        format!(
            "{}({})",
            target.engine.family,
            target.engine.arguments.join(", ")
        )
    };
    let mut statement = format!(
        "CREATE TABLE {}.{}\n(\n{columns}\n)\nENGINE = {engine}",
        quote_identifier(&target.database),
        quote_identifier(&target.name),
    );
    if let Some(partition_by) = target.keys.partition_by.as_deref() {
        statement.push_str("\nPARTITION BY ");
        statement.push_str(partition_by);
    }
    if let Some(primary_key) = target.keys.primary_key.as_deref() {
        statement.push_str("\nPRIMARY KEY ");
        statement.push_str(primary_key);
    }
    statement.push_str("\nORDER BY ");
    statement.push_str(&target.keys.order_by);
    if let Some(sample_by) = target.keys.sample_by.as_deref() {
        statement.push_str("\nSAMPLE BY ");
        statement.push_str(sample_by);
    }
    if let Some(table_ttl) = target.table_ttl.as_deref() {
        statement.push_str("\nTTL ");
        statement.push_str(table_ttl);
    }
    if !target.settings.is_empty() {
        let settings = target
            .settings
            .iter()
            .map(|setting| format!("{} = {}", setting.name, setting.value))
            .collect::<Vec<_>>()
            .join(", ");
        statement.push_str("\nSETTINGS ");
        statement.push_str(&settings);
    }
    if let Some(comment) = target.comment.as_deref() {
        statement.push_str("\nCOMMENT ");
        statement.push_str(&quote_string_literal(comment));
    }
    statement
}

pub(super) fn render_column_definition(column: &ClickHouseCreateColumnTarget) -> String {
    let mut rendered = format!("{} {}", quote_identifier(&column.name), column.type_name);
    if column.default_kind != ClickHouseColumnDefaultKind::None {
        let keyword = match column.default_kind {
            ClickHouseColumnDefaultKind::None => unreachable!("none handled above"),
            ClickHouseColumnDefaultKind::Default => "DEFAULT",
            ClickHouseColumnDefaultKind::Materialized => "MATERIALIZED",
            ClickHouseColumnDefaultKind::Alias => "ALIAS",
            ClickHouseColumnDefaultKind::Ephemeral => "EPHEMERAL",
        };
        rendered.push(' ');
        rendered.push_str(keyword);
        rendered.push(' ');
        rendered.push_str(
            column
                .default_expression
                .as_deref()
                .expect("validated default expression"),
        );
    }
    if let Some(comment) = column.comment.as_deref() {
        rendered.push_str(" COMMENT ");
        rendered.push_str(&quote_string_literal(comment));
    }
    if !column.codecs.is_empty() {
        let codecs = column
            .codecs
            .iter()
            .map(|codec| {
                if codec.arguments.is_empty() {
                    codec.name.clone()
                } else {
                    format!("{}({})", codec.name, codec.arguments.join(", "))
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        rendered.push_str(" CODEC(");
        rendered.push_str(&codecs);
        rendered.push(')');
    }
    if let Some(ttl_expression) = column.ttl_expression.as_deref() {
        rendered.push_str(" TTL ");
        rendered.push_str(ttl_expression);
    }
    rendered
}

pub(super) fn quote_identifier(identifier: &str) -> String {
    let escaped = identifier.replace('\\', "\\\\").replace('`', "\\`");
    format!("`{escaped}`")
}

pub(super) fn quote_string_literal(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('\'', "\\'");
    format!("'{escaped}'")
}

pub(super) fn plan_hash(domain: &str, statements: &[String]) -> String {
    let mut digest = Sha256::new();
    digest.update(domain.as_bytes());
    digest.update([0]);
    for statement in statements {
        digest.update(statement.as_bytes());
        digest.update([0]);
    }
    format!("{:x}", digest.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::engine::drivers::clickhouse::schema::{
        ClickHouseCodecTarget, ClickHouseColumnDefaultKind, ClickHouseCreateColumnTarget,
        ClickHouseCreateDatabaseTarget, ClickHouseCreateEngineTarget,
        ClickHouseCreateSettingTarget, ClickHouseCreateTableTarget, ClickHouseKeySchema,
    };

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

    fn full_table_target() -> ClickHouseCreateTableTarget {
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
                    "created_at",
                    "DateTime64(3, 'UTC')",
                    ClickHouseColumnDefaultKind::Default,
                    Some("now64(3)"),
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
                expires_at,
            ],
            engine: ClickHouseCreateEngineTarget {
                family: "ReplacingMergeTree".to_string(),
                arguments: vec!["version".to_string()],
            },
            keys: ClickHouseKeySchema {
                order_by: "(id, created_at)".to_string(),
                partition_by: Some("toYYYYMM(created_at)".to_string()),
                primary_key: Some("(id, created_at)".to_string()),
                sample_by: Some("id".to_string()),
            },
            table_ttl: Some("created_at + INTERVAL 30 DAY DELETE".to_string()),
            comment: Some("phase 5b table".to_string()),
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

    #[test]
    fn database_renderer_quotes_identifiers_and_never_adds_idempotency_syntax() {
        let preview = plan_create_database(&ClickHouseCreateDatabaseTarget {
            name: "analytics-prod".to_string(),
        })
        .expect("plan database create");

        assert_eq!(preview.statements, ["CREATE DATABASE `analytics-prod`"]);
        assert!(!preview.statements[0].contains("IF NOT EXISTS"));
        assert!(!preview.statements[0].ends_with(';'));
        assert!(preview.warnings.is_empty());
        assert!(!preview.destructive);
        assert!(!preview.long_running);
    }

    #[test]
    fn table_renderer_has_exact_deterministic_clause_order() {
        let preview = plan_create_table(&full_table_target()).expect("plan table create");
        assert_eq!(
            preview.statements[0],
            "CREATE TABLE `analytics`.`events`\n(\n    `id` UInt64 COMMENT 'event id' CODEC(ZSTD(1)),\n    `created_at` DateTime64(3, 'UTC') DEFAULT now64(3),\n    `event_date` Date MATERIALIZED toDate(created_at),\n    `alias_id` UInt64 ALIAS id,\n    `expires_at` DateTime TTL expires_at + INTERVAL 7 DAY\n)\nENGINE = ReplacingMergeTree(version)\nPARTITION BY toYYYYMM(created_at)\nPRIMARY KEY (id, created_at)\nORDER BY (id, created_at)\nSAMPLE BY id\nTTL created_at + INTERVAL 30 DAY DELETE\nSETTINGS index_granularity = 8192, ttl_only_drop_parts = 1\nCOMMENT 'phase 5b table'"
        );
        assert!(preview.statements[0].contains("`id` UInt64 COMMENT 'event id' CODEC(ZSTD(1))"));
        assert!(!preview.statements[0].contains("CODEC(ZSTD(1)) COMMENT"));
        assert!(!preview.statements[0].contains("IF NOT EXISTS"));
        assert!(!preview.statements[0].ends_with(';'));
    }

    #[test]
    fn renderer_escapes_identifiers_and_comments_without_rewriting_expressions() {
        let mut target = full_table_target();
        target.database = "a\\b`c".to_string();
        target.name = "t`x".to_string();
        target.columns[0].name = "c`d".to_string();
        target.columns[0].comment = Some("slash \\ and quote '".to_string());
        target.keys.order_by = " tuple( id ) ".to_string();

        let statement = &plan_create_table(&target).unwrap().statements[0];
        assert!(statement.starts_with("CREATE TABLE `a\\\\b\\`c`.`t\\`x`"));
        assert!(statement.contains("`c\\`d` UInt64 COMMENT 'slash \\\\ and quote \\''"));
        assert!(statement.contains("ORDER BY  tuple( id ) "));
    }

    #[test]
    fn zero_argument_engines_render_without_parentheses() {
        let mut target = full_table_target();
        target.engine.family = "MergeTree".to_string();
        target.engine.arguments.clear();
        let statement = &plan_create_table(&target).unwrap().statements[0];
        assert!(statement.contains("\nENGINE = MergeTree\n"));
        assert!(!statement.contains("ENGINE = MergeTree()"));
    }

    #[test]
    fn plan_hash_is_stable_lowercase_sensitive_and_domain_separated() {
        let target = full_table_target();
        let first = plan_create_table(&target).unwrap();
        let second = plan_create_table(&target).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.plan_hash.len(), 64);
        assert!(first
            .plan_hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')));

        let statement = first.statements[0].clone();
        assert_ne!(
            plan_hash(CREATE_DATABASE_HASH_DOMAIN, &[statement.clone()]),
            plan_hash(CREATE_TABLE_HASH_DOMAIN, &[statement]),
        );

        let mut changed = target;
        changed.comment = Some("phase 5b table!".to_string());
        assert_ne!(
            first.plan_hash,
            plan_create_table(&changed).unwrap().plan_hash
        );
    }
}
