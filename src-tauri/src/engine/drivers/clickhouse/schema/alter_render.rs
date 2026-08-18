#![allow(dead_code)]

use sha2::{Digest, Sha256};

use crate::engine::native_schema::{
    NativeSchemaChangeBaseline, NativeSchemaChangePlan, NativeSchemaOperationSummary,
    NativeSchemaRequiredConfirmation, NativeSchemaRiskFlag,
};
use crate::error::{IpcError, IpcResult};

use super::alter_diff::{diff_alter_table, ClickHouseAlterOperation, ColumnPosition};
use super::alter_validate::validate_column_action_target;
use super::change_types::{ClickHouseAlterTableTarget, ClickHouseColumnDataActionTarget};
use super::create_render::{
    plan_hash, quote_identifier, quote_string_literal, render_column_definition,
};

const ALTER_TABLE_HASH_DOMAIN: &str = "nexpilot/native-schema/clickhouse/alter-table/v1";
const COLUMN_CLEAR_HASH_DOMAIN: &str = "nexpilot/native-schema/clickhouse/column-clear/v1";
const COLUMN_MATERIALIZE_HASH_DOMAIN: &str =
    "nexpilot/native-schema/clickhouse/column-materialize/v1";
const ALTER_TARGET_REVISION_DOMAIN: &[u8] = b"nexpilot.clickhouse.alter-target.v1\0";

pub(super) fn plan_alter_table(
    target: &ClickHouseAlterTableTarget,
) -> IpcResult<NativeSchemaChangePlan> {
    let operations = diff_alter_table(target)?;
    let table = qualified_table_name(&target.desired.database, &target.desired.name);
    let rendered = operations
        .iter()
        .map(|operation| render_operation(&table, operation))
        .collect::<Vec<_>>();
    let statements = rendered
        .iter()
        .map(|operation| operation.statement.clone())
        .collect::<Vec<_>>();
    let summaries = rendered
        .into_iter()
        .map(|operation| operation.summary)
        .collect::<Vec<_>>();
    let destructive = summaries.iter().any(|summary| summary.destructive);
    let long_running = summaries.iter().any(|summary| summary.long_running);
    let mut risk_flags = Vec::new();
    if destructive {
        risk_flags.push(NativeSchemaRiskFlag::Destructive);
    }
    if long_running {
        risk_flags.push(NativeSchemaRiskFlag::LongRunning);
    }

    Ok(NativeSchemaChangePlan {
        plan_hash: plan_hash(ALTER_TABLE_HASH_DOMAIN, &statements),
        statements,
        warnings: Vec::new(),
        destructive,
        long_running,
        risk_flags,
        required_confirmation: if destructive {
            NativeSchemaRequiredConfirmation::Confirm
        } else {
            NativeSchemaRequiredConfirmation::None
        },
        expected_target_revision: Some(target_revision(target)?),
        operations: summaries,
        baseline: NativeSchemaChangeBaseline::ClickHouseTable(Box::new(target.baseline.clone())),
    })
}

pub(super) fn plan_column_clear(
    target: &ClickHouseColumnDataActionTarget,
) -> IpcResult<NativeSchemaChangePlan> {
    plan_column_action(
        target,
        "CLEAR COLUMN",
        "clear_column",
        COLUMN_CLEAR_HASH_DOMAIN,
    )
}

pub(super) fn plan_column_materialize(
    target: &ClickHouseColumnDataActionTarget,
) -> IpcResult<NativeSchemaChangePlan> {
    plan_column_action(
        target,
        "MATERIALIZE COLUMN",
        "materialize_column",
        COLUMN_MATERIALIZE_HASH_DOMAIN,
    )
}

fn plan_column_action(
    target: &ClickHouseColumnDataActionTarget,
    clause: &str,
    code: &str,
    hash_domain: &str,
) -> IpcResult<NativeSchemaChangePlan> {
    validate_column_action_target(target)?;
    let table = qualified_table_name(
        &target.baseline.identity.database,
        &target.baseline.identity.name,
    );
    let statements = vec![format!(
        "ALTER TABLE {table} {clause} {}",
        quote_identifier(&target.column_name)
    )];
    Ok(NativeSchemaChangePlan {
        plan_hash: plan_hash(hash_domain, &statements),
        statements,
        warnings: Vec::new(),
        destructive: true,
        long_running: true,
        risk_flags: vec![
            NativeSchemaRiskFlag::Destructive,
            NativeSchemaRiskFlag::LongRunning,
            NativeSchemaRiskFlag::BackgroundWork,
        ],
        required_confirmation: NativeSchemaRequiredConfirmation::Confirm,
        expected_target_revision: None,
        operations: vec![summary(code, &target.column_name, true, true)],
        baseline: NativeSchemaChangeBaseline::ClickHouseTable(Box::new(target.baseline.clone())),
    })
}

struct RenderedOperation {
    statement: String,
    summary: NativeSchemaOperationSummary,
}

fn render_operation(table: &str, operation: &ClickHouseAlterOperation) -> RenderedOperation {
    let (clause, code, object_name, destructive, long_running) = match operation {
        ClickHouseAlterOperation::RenameColumn { from, to, .. } => (
            format!(
                "RENAME COLUMN {} TO {}",
                quote_identifier(from),
                quote_identifier(to)
            ),
            "rename_column",
            to.as_str(),
            false,
            false,
        ),
        ClickHouseAlterOperation::AddColumn { column, position } => (
            format!(
                "ADD COLUMN {} {}",
                render_column_definition(column),
                render_column_position(position)
            ),
            "add_column",
            column.name.as_str(),
            false,
            false,
        ),
        ClickHouseAlterOperation::ModifyColumn {
            column,
            position,
            definition_changed,
            position_changed,
            type_changed,
            codec_changed,
            ttl_changed,
            ..
        } => {
            let code = if *position_changed && !definition_changed {
                "reorder_column"
            } else {
                "modify_column"
            };
            (
                format!(
                    "MODIFY COLUMN {} {}",
                    render_column_definition(column),
                    render_column_position(position)
                ),
                code,
                column.name.as_str(),
                *definition_changed,
                *type_changed || *codec_changed || *ttl_changed,
            )
        }
        ClickHouseAlterOperation::CommentColumn { name, comment, .. } => (
            format!(
                "COMMENT COLUMN {} {}",
                quote_identifier(name),
                quote_string_literal(comment)
            ),
            "comment_column",
            name.as_str(),
            false,
            false,
        ),
        ClickHouseAlterOperation::ModifySampleBy { expression } => (
            format!("MODIFY SAMPLE BY {expression}"),
            "modify_sample_by",
            "sample_by",
            false,
            false,
        ),
        ClickHouseAlterOperation::RemoveSampleBy => (
            "REMOVE SAMPLE BY".to_string(),
            "remove_sample_by",
            "sample_by",
            false,
            false,
        ),
        ClickHouseAlterOperation::ModifyTableTtl { expression } => (
            format!("MODIFY TTL {expression}"),
            "modify_table_ttl",
            "ttl",
            true,
            true,
        ),
        ClickHouseAlterOperation::RemoveTableTtl => (
            "REMOVE TTL".to_string(),
            "remove_table_ttl",
            "ttl",
            true,
            true,
        ),
        ClickHouseAlterOperation::ModifySetting { name, value } => (
            format!("MODIFY SETTING {name} = {value}"),
            "modify_setting",
            name.as_str(),
            false,
            false,
        ),
        ClickHouseAlterOperation::ResetSetting { name } => (
            format!("RESET SETTING {name}"),
            "reset_setting",
            name.as_str(),
            false,
            false,
        ),
        ClickHouseAlterOperation::ModifyTableComment { comment } => (
            format!("MODIFY COMMENT {}", quote_string_literal(comment)),
            "modify_table_comment",
            "comment",
            false,
            false,
        ),
        ClickHouseAlterOperation::DropColumn { name, .. } => (
            format!("DROP COLUMN {}", quote_identifier(name)),
            "drop_column",
            name.as_str(),
            true,
            false,
        ),
    };
    RenderedOperation {
        statement: format!("ALTER TABLE {table} {clause}"),
        summary: summary(code, object_name, destructive, long_running),
    }
}

fn render_column_position(position: &ColumnPosition) -> String {
    match position {
        ColumnPosition::First => "FIRST".to_string(),
        ColumnPosition::After(column) => format!("AFTER {}", quote_identifier(column)),
    }
}

fn qualified_table_name(database: &str, table: &str) -> String {
    format!("{}.{}", quote_identifier(database), quote_identifier(table))
}

fn summary(
    code: &str,
    object_name: &str,
    destructive: bool,
    long_running: bool,
) -> NativeSchemaOperationSummary {
    NativeSchemaOperationSummary {
        code: code.to_string(),
        object_name: object_name.to_string(),
        destructive,
        long_running,
    }
}

fn target_revision(target: &ClickHouseAlterTableTarget) -> IpcResult<String> {
    let serialized = serde_json::to_vec(&target.desired).map_err(|error| {
        IpcError::system_internal(
            "Failed to serialize the ClickHouse ALTER target",
            format!("category=alter_target_serialization; error={error}"),
        )
    })?;
    let mut digest = Sha256::new();
    digest.update(ALTER_TARGET_REVISION_DOMAIN);
    digest.update(serialized);
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::engine::drivers::clickhouse::schema::{
        ClickHouseAlterTableTarget, ClickHouseCodecTarget, ClickHouseColumnDataActionTarget,
        ClickHouseColumnDefaultKind, ClickHouseColumnRenameIntent, ClickHouseColumnSchema,
        ClickHouseCreateColumnTarget, ClickHouseCreateEngineTarget, ClickHouseCreateSettingTarget,
        ClickHouseCreateTableTarget, ClickHouseEngineSchema, ClickHouseKeySchema,
        ClickHouseSchemaBaseline, ClickHouseSchemaEditability, ClickHouseSettingSchema,
        ClickHouseTableIdentity, ClickHouseTableSchema,
    };
    use crate::engine::types::ContainerKind;

    fn schema_column(name: &str, type_name: &str, position: u64) -> ClickHouseColumnSchema {
        ClickHouseColumnSchema {
            name: name.to_string(),
            type_name: type_name.to_string(),
            position,
            default_kind: ClickHouseColumnDefaultKind::None,
            default_expression: None,
            codec_expression: None,
            ttl_expression: None,
            comment: None,
            editability: ClickHouseSchemaEditability::editable(),
        }
    }

    fn target_column(name: &str, type_name: &str) -> ClickHouseCreateColumnTarget {
        ClickHouseCreateColumnTarget {
            name: name.to_string(),
            type_name: type_name.to_string(),
            default_kind: ClickHouseColumnDefaultKind::None,
            default_expression: None,
            codecs: Vec::new(),
            ttl_expression: None,
            comment: None,
        }
    }

    fn baseline() -> ClickHouseTableSchema {
        let mut received_at = schema_column("received_at", "DateTime", 3);
        received_at.default_kind = ClickHouseColumnDefaultKind::Default;
        received_at.default_expression = Some("now()".to_string());
        ClickHouseTableSchema {
            identity: ClickHouseTableIdentity {
                database: "analytics".to_string(),
                name: "events".to_string(),
                object_kind: ContainerKind::Table,
                uuid: Some("00000000-0000-0000-0000-000000000001".to_string()),
            },
            engine: ClickHouseEngineSchema {
                family: "MergeTree".to_string(),
                arguments: Vec::new(),
                raw_expression: "MergeTree".to_string(),
            },
            columns: vec![
                schema_column("id", "UInt64", 1),
                schema_column("payload", "String", 2),
                received_at,
                schema_column("legacy", "String", 4),
            ],
            keys: ClickHouseKeySchema {
                order_by: "id".to_string(),
                partition_by: None,
                primary_key: Some("id".to_string()),
                sample_by: Some("id".to_string()),
            },
            table_ttl: None,
            comment: Some("events".to_string()),
            settings: vec![
                ClickHouseSettingSchema {
                    name: "index_granularity_bytes".to_string(),
                    value: "10485760".to_string(),
                    explicit: true,
                },
                ClickHouseSettingSchema {
                    name: "ttl_only_drop_parts".to_string(),
                    value: "0".to_string(),
                    explicit: true,
                },
            ],
            projections: Vec::new(),
            skipping_indexes: Vec::new(),
            editability: ClickHouseSchemaEditability::editable(),
            baseline: ClickHouseSchemaBaseline {
                canonical_create_query: "CREATE TABLE analytics.events".to_string(),
                revision_hash: "a".repeat(64),
            },
        }
    }

    fn target_column_from_schema(column: &ClickHouseColumnSchema) -> ClickHouseCreateColumnTarget {
        ClickHouseCreateColumnTarget {
            name: column.name.clone(),
            type_name: column.type_name.clone(),
            default_kind: column.default_kind,
            default_expression: column.default_expression.clone(),
            codecs: Vec::new(),
            ttl_expression: column.ttl_expression.clone(),
            comment: column.comment.clone(),
        }
    }

    fn desired_from_baseline(schema: &ClickHouseTableSchema) -> ClickHouseCreateTableTarget {
        ClickHouseCreateTableTarget {
            database: schema.identity.database.clone(),
            name: schema.identity.name.clone(),
            columns: schema
                .columns
                .iter()
                .map(target_column_from_schema)
                .collect(),
            engine: ClickHouseCreateEngineTarget {
                family: schema.engine.family.clone(),
                arguments: schema.engine.arguments.clone(),
            },
            keys: schema.keys.clone(),
            table_ttl: schema.table_ttl.clone(),
            comment: schema.comment.clone(),
            settings: schema
                .settings
                .iter()
                .filter(|setting| setting.explicit)
                .map(|setting| ClickHouseCreateSettingTarget {
                    name: setting.name.clone(),
                    value: setting.value.clone(),
                })
                .collect(),
        }
    }

    fn fixture_full_alter_target() -> ClickHouseAlterTableTarget {
        let baseline = baseline();
        let mut desired = desired_from_baseline(&baseline);
        let mut body = target_column("body", "String");
        body.comment = Some("body".to_string());
        body.codecs = vec![ClickHouseCodecTarget {
            name: "ZSTD".to_string(),
            arguments: vec!["1".to_string()],
        }];
        desired.columns = vec![
            target_column("id", "UInt64"),
            target_column_from_schema(&baseline.columns[2]),
            body,
            target_column("source", "String"),
        ];
        desired.keys.sample_by = Some("cityHash64(id)".to_string());
        desired.table_ttl = Some("received_at + INTERVAL 30 DAY DELETE".to_string());
        desired.comment = Some("phase 5c events".to_string());
        desired.settings = vec![
            ClickHouseCreateSettingTarget {
                name: "index_granularity_bytes".to_string(),
                value: "10485760".to_string(),
            },
            ClickHouseCreateSettingTarget {
                name: "ttl_only_drop_parts".to_string(),
                value: "1".to_string(),
            },
        ];
        ClickHouseAlterTableTarget {
            baseline,
            desired,
            column_renames: vec![ClickHouseColumnRenameIntent {
                from: "payload".to_string(),
                to: "body".to_string(),
            }],
        }
    }

    fn fixture_remove_target() -> ClickHouseAlterTableTarget {
        let mut baseline = baseline();
        baseline.columns = vec![
            schema_column("id", "UInt64", 1),
            schema_column("note", "String", 2),
        ];
        baseline.columns[1].comment = Some("note".to_string());
        baseline.table_ttl = Some("now() + INTERVAL 1 DAY DELETE".to_string());
        baseline.comment = Some("remove me".to_string());
        let mut desired = desired_from_baseline(&baseline);
        desired.columns[1].comment = None;
        desired.keys.sample_by = None;
        desired.table_ttl = None;
        desired.comment = None;
        desired
            .settings
            .retain(|setting| setting.name != "ttl_only_drop_parts");
        ClickHouseAlterTableTarget {
            baseline,
            desired,
            column_renames: Vec::new(),
        }
    }

    fn single_change(
        mutator: impl FnOnce(&mut ClickHouseCreateTableTarget),
    ) -> NativeSchemaChangePlan {
        let baseline = baseline();
        let mut desired = desired_from_baseline(&baseline);
        mutator(&mut desired);
        plan_alter_table(&ClickHouseAlterTableTarget {
            baseline,
            desired,
            column_renames: Vec::new(),
        })
        .unwrap()
    }

    #[test]
    fn renderer_emits_exact_statement_order_and_quoting() {
        let plan = plan_alter_table(&fixture_full_alter_target()).unwrap();
        assert_eq!(
            plan.statements,
            [
                "ALTER TABLE `analytics`.`events` RENAME COLUMN `payload` TO `body`",
                "ALTER TABLE `analytics`.`events` ADD COLUMN `source` String AFTER `body`",
                "ALTER TABLE `analytics`.`events` MODIFY COLUMN `received_at` DateTime DEFAULT now() AFTER `id`",
                "ALTER TABLE `analytics`.`events` MODIFY COLUMN `body` String COMMENT 'body' CODEC(ZSTD(1)) AFTER `received_at`",
                "ALTER TABLE `analytics`.`events` MODIFY SAMPLE BY cityHash64(id)",
                "ALTER TABLE `analytics`.`events` MODIFY TTL received_at + INTERVAL 30 DAY DELETE",
                "ALTER TABLE `analytics`.`events` MODIFY SETTING ttl_only_drop_parts = 1",
                "ALTER TABLE `analytics`.`events` MODIFY COMMENT 'phase 5c events'",
                "ALTER TABLE `analytics`.`events` DROP COLUMN `legacy`",
            ]
        );
        assert!(plan.destructive);
        assert!(plan.long_running);
        assert_eq!(plan.operations.last().unwrap().code, "drop_column");
        assert!(plan
            .expected_target_revision
            .as_deref()
            .is_some_and(is_lowercase_sha256));
    }

    #[test]
    fn remove_forms_and_comment_clear_are_explicit() {
        let plan = plan_alter_table(&fixture_remove_target()).unwrap();
        assert!(plan
            .statements
            .iter()
            .any(|sql| sql.ends_with("COMMENT COLUMN `note` ''")));
        assert!(plan
            .statements
            .iter()
            .any(|sql| sql.ends_with("REMOVE SAMPLE BY")));
        assert!(plan
            .statements
            .iter()
            .any(|sql| sql.ends_with("REMOVE TTL")));
        assert!(plan
            .statements
            .iter()
            .any(|sql| sql.ends_with("MODIFY COMMENT ''")));
        assert!(plan
            .statements
            .iter()
            .any(|sql| sql.ends_with("RESET SETTING ttl_only_drop_parts")));
    }

    #[test]
    fn classification_is_conservative_and_plan_hash_is_domain_separated() {
        let comment = single_change(|target| target.comment = Some("changed".to_string()));
        assert_eq!((comment.destructive, comment.long_running), (false, false));

        let reorder = single_change(|target| target.columns.swap(1, 2));
        assert_eq!((reorder.destructive, reorder.long_running), (false, false));

        let type_change = single_change(|target| {
            target.columns[1].type_name = "LowCardinality(String)".to_string()
        });
        assert_eq!(
            (type_change.destructive, type_change.long_running),
            (true, true)
        );

        let ttl_change = single_change(|target| {
            target.columns[2].ttl_expression = Some("received_at + INTERVAL 1 DAY".to_string())
        });
        assert_eq!(
            (ttl_change.destructive, ttl_change.long_running),
            (true, true)
        );

        let drop_column = single_change(|target| {
            target.columns.remove(1);
        });
        assert_eq!(
            (drop_column.destructive, drop_column.long_running),
            (true, false)
        );

        assert_ne!(
            plan_hash(ALTER_TABLE_HASH_DOMAIN, &["same".to_string()]),
            plan_hash(
                "nexpilot/native-schema/clickhouse/create-table/v1",
                &["same".to_string()]
            )
        );
    }

    #[test]
    fn column_actions_have_distinct_exact_plans_and_submitted_classification() {
        let target = ClickHouseColumnDataActionTarget {
            baseline: baseline(),
            column_name: "payload".to_string(),
        };
        let clear = plan_column_clear(&target).unwrap();
        let materialize = plan_column_materialize(&target).unwrap();
        assert_eq!(
            clear.statements,
            ["ALTER TABLE `analytics`.`events` CLEAR COLUMN `payload`"]
        );
        assert_eq!(
            materialize.statements,
            ["ALTER TABLE `analytics`.`events` MATERIALIZE COLUMN `payload`"]
        );
        assert!(clear.destructive && clear.long_running);
        assert!(materialize.destructive && materialize.long_running);
        assert_eq!(clear.operations[0].code, "clear_column");
        assert_eq!(materialize.operations[0].code, "materialize_column");
        assert_ne!(clear.plan_hash, materialize.plan_hash);
    }

    fn is_lowercase_sha256(value: &str) -> bool {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    }
}
