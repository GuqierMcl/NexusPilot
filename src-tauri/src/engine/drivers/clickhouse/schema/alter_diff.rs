#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::error::{IpcError, IpcResult};

use super::alter_validate::validate_alter_target;
use super::change_types::ClickHouseAlterTableTarget;
use super::create_types::{ClickHouseCodecTarget, ClickHouseCreateColumnTarget};
use super::schema_compare::{normalized_expression_equal, optional_normalized_expression_equal};
use super::types::ClickHouseColumnSchema;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ClickHouseAlterOperation {
    RenameColumn {
        from: String,
        to: String,
        baseline_position: u64,
    },
    AddColumn {
        column: ClickHouseCreateColumnTarget,
        position: ColumnPosition,
    },
    ModifyColumn {
        column: ClickHouseCreateColumnTarget,
        position: ColumnPosition,
        source_name: String,
        definition_changed: bool,
        position_changed: bool,
        type_changed: bool,
        codec_changed: bool,
        ttl_changed: bool,
    },
    CommentColumn {
        name: String,
        comment: String,
        desired_position: u64,
    },
    ModifySampleBy {
        expression: String,
    },
    RemoveSampleBy,
    ModifyTableTtl {
        expression: String,
    },
    RemoveTableTtl,
    ModifySetting {
        name: String,
        value: String,
    },
    ResetSetting {
        name: String,
    },
    ModifyTableComment {
        comment: String,
    },
    DropColumn {
        name: String,
        baseline_position: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ColumnPosition {
    First,
    After(String),
}

pub(super) fn diff_alter_table(
    target: &ClickHouseAlterTableTarget,
) -> IpcResult<Vec<ClickHouseAlterOperation>> {
    validate_alter_target(target)?;

    let baseline_by_name = target
        .baseline
        .columns
        .iter()
        .map(|column| (column.name.as_str(), column))
        .collect::<HashMap<_, _>>();
    let rename_by_source = target
        .column_renames
        .iter()
        .map(|rename| (rename.from.as_str(), rename.to.as_str()))
        .collect::<HashMap<_, _>>();
    let source_by_target = target
        .column_renames
        .iter()
        .map(|rename| (rename.to.as_str(), rename.from.as_str()))
        .collect::<HashMap<_, _>>();

    let source_for_target = |name: &str| {
        source_by_target
            .get(name)
            .map(|source| (*source).to_string())
            .or_else(|| {
                (baseline_by_name.contains_key(name) && !rename_by_source.contains_key(name))
                    .then(|| name.to_string())
            })
    };
    let matched_sources = target
        .desired
        .columns
        .iter()
        .filter_map(|column| source_for_target(&column.name))
        .collect::<HashSet<_>>();

    let mut rename_operations = target
        .column_renames
        .iter()
        .map(|rename| {
            let baseline_position = baseline_by_name
                .get(rename.from.as_str())
                .expect("validated rename source")
                .position;
            ClickHouseAlterOperation::RenameColumn {
                from: rename.from.clone(),
                to: rename.to.clone(),
                baseline_position,
            }
        })
        .collect::<Vec<_>>();
    rename_operations.sort_by_key(|operation| match operation {
        ClickHouseAlterOperation::RenameColumn {
            baseline_position, ..
        } => *baseline_position,
        _ => unreachable!("rename operation list contains only renames"),
    });

    let mut simulated_order = target
        .baseline
        .columns
        .iter()
        .filter(|column| matched_sources.contains(column.name.as_str()))
        .map(|column| {
            rename_by_source
                .get(column.name.as_str())
                .copied()
                .unwrap_or(column.name.as_str())
                .to_string()
        })
        .collect::<Vec<_>>();

    let mut add_operations = Vec::new();
    let mut added_names = HashSet::new();
    for (index, column) in target.desired.columns.iter().enumerate() {
        if source_for_target(&column.name).is_some() {
            continue;
        }
        let position = desired_position(&target.desired.columns, index);
        insert_at_position(&mut simulated_order, &column.name, &position)?;
        added_names.insert(column.name.as_str());
        add_operations.push(ClickHouseAlterOperation::AddColumn {
            column: column.clone(),
            position,
        });
    }

    let mut modify_operations = Vec::new();
    let mut comment_operations = Vec::new();
    for (desired_index, desired) in target.desired.columns.iter().enumerate() {
        if added_names.contains(desired.name.as_str()) {
            continue;
        }
        let source_name = source_for_target(&desired.name).expect("validated matched column");
        let baseline = baseline_by_name
            .get(source_name.as_str())
            .expect("validated baseline column");
        let current_index = simulated_order
            .iter()
            .position(|name| name == &desired.name)
            .ok_or_else(|| {
                IpcError::system_internal(
                    "ClickHouse ALTER diff lost a matched column",
                    format!("column={}; category=diff_order_invariant", desired.name),
                )
            })?;
        let position_changed = current_index != desired_index;
        if position_changed {
            let name = simulated_order.remove(current_index);
            simulated_order.insert(desired_index, name);
        }

        let changes = compare_column_definition(baseline, desired);
        let position = desired_position(&target.desired.columns, desired_index);
        if changes.comment_changed && !changes.non_comment_changed && !position_changed {
            comment_operations.push(ClickHouseAlterOperation::CommentColumn {
                name: desired.name.clone(),
                comment: desired.comment.clone().unwrap_or_default(),
                desired_position: desired_index as u64 + 1,
            });
        } else if changes.definition_changed || position_changed {
            modify_operations.push(ClickHouseAlterOperation::ModifyColumn {
                column: desired.clone(),
                position,
                source_name,
                definition_changed: changes.definition_changed,
                position_changed,
                type_changed: changes.type_changed,
                codec_changed: changes.codec_changed,
                ttl_changed: changes.ttl_changed,
            });
        }
    }

    let mut operations = rename_operations;
    operations.extend(add_operations);
    operations.extend(modify_operations);
    operations.extend(comment_operations);

    if !optional_normalized_expression_equal(
        target.baseline.keys.sample_by.as_deref(),
        target.desired.keys.sample_by.as_deref(),
    ) {
        match target.desired.keys.sample_by.as_deref() {
            Some(expression) => operations.push(ClickHouseAlterOperation::ModifySampleBy {
                expression: expression.to_string(),
            }),
            None => operations.push(ClickHouseAlterOperation::RemoveSampleBy),
        }
    }

    if !optional_normalized_expression_equal(
        target.baseline.table_ttl.as_deref(),
        target.desired.table_ttl.as_deref(),
    ) {
        match target.desired.table_ttl.as_deref() {
            Some(expression) => operations.push(ClickHouseAlterOperation::ModifyTableTtl {
                expression: expression.to_string(),
            }),
            None => operations.push(ClickHouseAlterOperation::RemoveTableTtl),
        }
    }

    let baseline_settings = target
        .baseline
        .settings
        .iter()
        .filter(|setting| setting.explicit)
        .map(|setting| (setting.name.as_str(), setting.value.as_str()))
        .collect::<BTreeMap<_, _>>();
    let desired_settings = target
        .desired
        .settings
        .iter()
        .map(|setting| (setting.name.as_str(), setting.value.as_str()))
        .collect::<BTreeMap<_, _>>();
    for name in baseline_settings
        .keys()
        .filter(|name| !desired_settings.contains_key(**name))
    {
        operations.push(ClickHouseAlterOperation::ResetSetting {
            name: (*name).to_string(),
        });
    }
    for (name, value) in desired_settings
        .iter()
        .filter(|(name, value)| baseline_settings.get(**name).copied() != Some(**value))
    {
        operations.push(ClickHouseAlterOperation::ModifySetting {
            name: (*name).to_string(),
            value: (*value).to_string(),
        });
    }

    if target.baseline.comment != target.desired.comment {
        operations.push(ClickHouseAlterOperation::ModifyTableComment {
            comment: target.desired.comment.clone().unwrap_or_default(),
        });
    }

    let mut drop_operations = target
        .baseline
        .columns
        .iter()
        .filter(|column| !matched_sources.contains(column.name.as_str()))
        .map(|column| ClickHouseAlterOperation::DropColumn {
            name: column.name.clone(),
            baseline_position: column.position,
        })
        .collect::<Vec<_>>();
    drop_operations.sort_by_key(|operation| match operation {
        ClickHouseAlterOperation::DropColumn {
            baseline_position, ..
        } => *baseline_position,
        _ => unreachable!("drop operation list contains only drops"),
    });
    operations.extend(drop_operations);

    if operations.is_empty() {
        return Err(IpcError::validation_failed(
            "ClickHouse table alter target does not contain any schema change",
        ));
    }
    Ok(operations)
}

#[derive(Debug, Clone, Copy)]
struct ColumnDefinitionChanges {
    definition_changed: bool,
    non_comment_changed: bool,
    comment_changed: bool,
    type_changed: bool,
    codec_changed: bool,
    ttl_changed: bool,
}

fn compare_column_definition(
    baseline: &ClickHouseColumnSchema,
    desired: &ClickHouseCreateColumnTarget,
) -> ColumnDefinitionChanges {
    let type_changed = !normalized_expression_equal(&baseline.type_name, &desired.type_name);
    let default_changed = baseline.default_kind != desired.default_kind
        || !optional_normalized_expression_equal(
            baseline.default_expression.as_deref(),
            desired.default_expression.as_deref(),
        );
    let codec_changed = !codec_matches(baseline.codec_expression.as_deref(), &desired.codecs);
    let ttl_changed = !optional_normalized_expression_equal(
        baseline.ttl_expression.as_deref(),
        desired.ttl_expression.as_deref(),
    );
    let comment_changed = baseline.comment != desired.comment;
    let non_comment_changed = type_changed || default_changed || codec_changed || ttl_changed;
    ColumnDefinitionChanges {
        definition_changed: non_comment_changed || comment_changed,
        non_comment_changed,
        comment_changed,
        type_changed,
        codec_changed,
        ttl_changed,
    }
}

fn codec_matches(actual: Option<&str>, expected: &[ClickHouseCodecTarget]) -> bool {
    let expected = if expected.is_empty() {
        None
    } else {
        Some(format!(
            "CODEC({})",
            expected
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
    optional_normalized_expression_equal(actual, expected.as_deref())
}

fn desired_position(columns: &[ClickHouseCreateColumnTarget], index: usize) -> ColumnPosition {
    if index == 0 {
        ColumnPosition::First
    } else {
        ColumnPosition::After(columns[index - 1].name.clone())
    }
}

fn insert_at_position(
    order: &mut Vec<String>,
    name: &str,
    position: &ColumnPosition,
) -> IpcResult<()> {
    let index = match position {
        ColumnPosition::First => 0,
        ColumnPosition::After(previous) => order
            .iter()
            .position(|candidate| candidate == previous)
            .map(|index| index + 1)
            .ok_or_else(|| {
                IpcError::system_internal(
                    "ClickHouse ALTER diff could not place a column",
                    format!("column={name}; after={previous}; category=diff_order_invariant"),
                )
            })?,
    };
    order.insert(index, name.to_string());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::engine::drivers::clickhouse::schema::{
        ClickHouseAlterTableTarget, ClickHouseCodecTarget, ClickHouseColumnDefaultKind,
        ClickHouseColumnRenameIntent, ClickHouseColumnSchema, ClickHouseCreateColumnTarget,
        ClickHouseCreateEngineTarget, ClickHouseCreateSettingTarget, ClickHouseCreateTableTarget,
        ClickHouseEngineSchema, ClickHouseKeySchema, ClickHouseSchemaBaseline,
        ClickHouseSchemaEditability, ClickHouseSettingSchema, ClickHouseTableIdentity,
        ClickHouseTableSchema,
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
                schema_column("received_at", "DateTime", 3),
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

    fn desired_from_baseline(schema: &ClickHouseTableSchema) -> ClickHouseCreateTableTarget {
        ClickHouseCreateTableTarget {
            database: schema.identity.database.clone(),
            name: schema.identity.name.clone(),
            columns: schema
                .columns
                .iter()
                .map(|column| target_column(&column.name, &column.type_name))
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
            target_column("received_at", "DateTime"),
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

    fn fixture_reorder_target() -> ClickHouseAlterTableTarget {
        let baseline = baseline();
        let mut desired = desired_from_baseline(&baseline);
        desired.columns.swap(1, 2);
        ClickHouseAlterTableTarget {
            baseline,
            desired,
            column_renames: Vec::new(),
        }
    }

    fn fixture_drop_add_same_position() -> ClickHouseAlterTableTarget {
        let mut baseline = baseline();
        baseline.columns = vec![
            schema_column("id", "UInt64", 1),
            schema_column("old", "String", 2),
        ];
        let mut desired = desired_from_baseline(&baseline);
        desired.columns[1] = target_column("new", "String");
        ClickHouseAlterTableTarget {
            baseline,
            desired,
            column_renames: Vec::new(),
        }
    }

    fn operation_codes(operations: &[ClickHouseAlterOperation]) -> Vec<String> {
        operations
            .iter()
            .map(|operation| match operation {
                ClickHouseAlterOperation::RenameColumn { from, to, .. } => {
                    format!("rename_column:{from}:{to}")
                }
                ClickHouseAlterOperation::AddColumn { column, .. } => {
                    format!("add_column:{}", column.name)
                }
                ClickHouseAlterOperation::ModifyColumn {
                    column,
                    definition_changed,
                    position_changed,
                    ..
                } => {
                    if *position_changed && !definition_changed {
                        format!("reorder_column:{}", column.name)
                    } else {
                        format!("modify_column:{}", column.name)
                    }
                }
                ClickHouseAlterOperation::CommentColumn { name, .. } => {
                    format!("comment_column:{name}")
                }
                ClickHouseAlterOperation::ModifySampleBy { .. } => "modify_sample_by".to_string(),
                ClickHouseAlterOperation::RemoveSampleBy => "remove_sample_by".to_string(),
                ClickHouseAlterOperation::ModifyTableTtl { .. } => "modify_table_ttl".to_string(),
                ClickHouseAlterOperation::RemoveTableTtl => "remove_table_ttl".to_string(),
                ClickHouseAlterOperation::ModifySetting { name, .. } => {
                    format!("modify_setting:{name}")
                }
                ClickHouseAlterOperation::ResetSetting { name } => {
                    format!("reset_setting:{name}")
                }
                ClickHouseAlterOperation::ModifyTableComment { .. } => {
                    "modify_table_comment".to_string()
                }
                ClickHouseAlterOperation::DropColumn { name, .. } => {
                    format!("drop_column:{name}")
                }
            })
            .collect()
    }

    #[test]
    fn diff_uses_explicit_rename_and_fixed_dependency_order() {
        let operations = diff_alter_table(&fixture_full_alter_target()).unwrap();
        assert_eq!(
            operation_codes(&operations),
            [
                "rename_column:payload:body",
                "add_column:source",
                "reorder_column:received_at",
                "modify_column:body",
                "modify_sample_by",
                "modify_table_ttl",
                "modify_setting:ttl_only_drop_parts",
                "modify_table_comment",
                "drop_column:legacy",
            ]
        );
    }

    #[test]
    fn position_only_change_is_reorder_not_drop_add_or_rename() {
        let operations = diff_alter_table(&fixture_reorder_target()).unwrap();
        assert!(matches!(
            operations.as_slice(),
            [ClickHouseAlterOperation::ModifyColumn {
                definition_changed: false,
                position_changed: true,
                ..
            }]
        ));
    }

    #[test]
    fn missing_rename_intent_becomes_explicit_drop_and_add() {
        let operations = diff_alter_table(&fixture_drop_add_same_position()).unwrap();
        assert_eq!(
            operation_codes(&operations),
            ["add_column:new", "drop_column:old"]
        );
    }

    #[test]
    fn diff_is_deterministic_across_repeated_clones() {
        let target = fixture_full_alter_target();
        let expected = diff_alter_table(&target).unwrap();
        for _ in 0..100 {
            assert_eq!(diff_alter_table(&target.clone()).unwrap(), expected);
        }
    }
}
