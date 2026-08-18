#![allow(dead_code)]

use std::collections::{HashMap, HashSet};

use crate::engine::types::ContainerKind;
use crate::error::{IpcError, IpcResult};

use super::change_types::{ClickHouseAlterTableTarget, ClickHouseColumnDataActionTarget};
use super::create_validate::{validate_create_table_target, validate_identifier};
use super::schema_compare::{
    expression_slices_equal, normalized_expression_equal, optional_normalized_expression_equal,
    table_schema_matches_target,
};
use super::sql_scan::expression_references_identifier;
use super::types::{
    ClickHouseColumnDefaultKind, ClickHouseSchemaEditabilityMode, ClickHouseTableSchema,
};

pub(super) fn validate_alter_target(target: &ClickHouseAlterTableTarget) -> IpcResult<()> {
    validate_editable_table_baseline(&target.baseline)?;
    validate_create_table_target(&target.desired)?;
    validate_identity_unchanged(target)?;
    validate_engine_and_immutable_keys_unchanged(target)?;
    validate_no_table_object_dependencies(&target.baseline)?;
    validate_setting_changes(target)?;
    let rename_by_source = validate_explicit_renames(target)?;
    validate_column_dependencies(target, &rename_by_source)?;
    validate_sample_by_change(target)?;

    if target.column_renames.is_empty()
        && table_schema_matches_target(&target.desired, &target.baseline)
    {
        return Err(validation(
            "ClickHouse table alter target does not contain any schema change",
        ));
    }
    Ok(())
}

pub(super) fn validate_column_action_target(
    target: &ClickHouseColumnDataActionTarget,
) -> IpcResult<()> {
    validate_editable_table_baseline(&target.baseline)?;
    validate_no_table_object_dependencies(&target.baseline)?;
    validate_identifier(&target.column_name, "columnAction.columnName")?;

    let column = target
        .baseline
        .columns
        .iter()
        .find(|column| column.name == target.column_name)
        .ok_or_else(|| {
            validation(format!(
                "ClickHouse column action target {} does not exist in the baseline",
                target.column_name
            ))
        })?;
    if column.editability.mode != ClickHouseSchemaEditabilityMode::Editable
        || !column.editability.blockers.is_empty()
    {
        return Err(validation(format!(
            "ClickHouse column action target {} is not editable",
            target.column_name
        )));
    }
    if matches!(
        column.default_kind,
        ClickHouseColumnDefaultKind::Alias | ClickHouseColumnDefaultKind::Ephemeral
    ) {
        return Err(validation(format!(
            "ClickHouse column action target {} is not a stored column",
            target.column_name
        )));
    }
    Ok(())
}

pub(super) fn validate_editable_table_baseline(schema: &ClickHouseTableSchema) -> IpcResult<()> {
    if schema.identity.object_kind != ContainerKind::Table
        || schema.identity.database.trim().is_empty()
        || schema.identity.name.trim().is_empty()
    {
        return Err(validation(
            "ClickHouse schema change requires a valid table baseline identity",
        ));
    }
    if schema.editability.mode != ClickHouseSchemaEditabilityMode::Editable
        || !schema.editability.blockers.is_empty()
    {
        return Err(validation(
            "ClickHouse schema change requires an editable table baseline",
        ));
    }
    if schema.columns.iter().any(|column| {
        column.editability.mode != ClickHouseSchemaEditabilityMode::Editable
            || !column.editability.blockers.is_empty()
    }) {
        return Err(validation(
            "ClickHouse schema change requires every baseline column to be editable",
        ));
    }
    Ok(())
}

fn validate_identity_unchanged(target: &ClickHouseAlterTableTarget) -> IpcResult<()> {
    if target.baseline.identity.database != target.desired.database
        || target.baseline.identity.name != target.desired.name
    {
        return Err(validation(
            "当前设计器不能修改 ClickHouse 表所属的数据库或表名",
        ));
    }
    Ok(())
}

fn validate_engine_and_immutable_keys_unchanged(
    target: &ClickHouseAlterTableTarget,
) -> IpcResult<()> {
    if target.baseline.engine.family != target.desired.engine.family
        || !expression_slices_equal(
            &target.baseline.engine.arguments,
            &target.desired.engine.arguments,
        )
    {
        return Err(validation("当前设计器不能修改 ClickHouse 表引擎或引擎参数"));
    }
    if !normalized_expression_equal(
        &target.baseline.keys.order_by,
        &target.desired.keys.order_by,
    ) || !optional_normalized_expression_equal(
        target.baseline.keys.partition_by.as_deref(),
        target.desired.keys.partition_by.as_deref(),
    ) || !optional_normalized_expression_equal(
        target.baseline.keys.primary_key.as_deref(),
        target.desired.keys.primary_key.as_deref(),
    ) {
        return Err(validation(
            "当前设计器只能修改 SAMPLE BY；ORDER BY、PARTITION BY 和 PRIMARY KEY 保持只读",
        ));
    }
    Ok(())
}

fn validate_no_table_object_dependencies(schema: &ClickHouseTableSchema) -> IpcResult<()> {
    if !schema.projections.is_empty() || !schema.skipping_indexes.is_empty() {
        return Err(validation(
            "ClickHouse table-field changes remain blocked while Projection or data-skipping Index dependencies exist; manage those objects in their dedicated sections first",
        ));
    }
    Ok(())
}

fn validate_setting_changes(target: &ClickHouseAlterTableTarget) -> IpcResult<()> {
    const MUTABLE_SETTINGS: &[&str] = &["ttl_only_drop_parts"];
    let baseline = target
        .baseline
        .settings
        .iter()
        .filter(|setting| setting.explicit)
        .map(|setting| (setting.name.as_str(), setting.value.as_str()))
        .collect::<HashMap<_, _>>();
    let desired = target
        .desired
        .settings
        .iter()
        .map(|setting| (setting.name.as_str(), setting.value.as_str()))
        .collect::<HashMap<_, _>>();
    let names = baseline
        .keys()
        .chain(desired.keys())
        .copied()
        .collect::<HashSet<_>>();

    for name in names {
        if baseline.get(name) != desired.get(name) && !MUTABLE_SETTINGS.contains(&name) {
            return Err(validation(format!(
                "ClickHouse 表设置 {name} 当前为只读，不能通过设计器修改"
            )));
        }
    }
    Ok(())
}

fn validate_explicit_renames(
    target: &ClickHouseAlterTableTarget,
) -> IpcResult<HashMap<String, String>> {
    let baseline_names = target
        .baseline
        .columns
        .iter()
        .map(|column| column.name.as_str())
        .collect::<HashSet<_>>();
    let desired_names = target
        .desired
        .columns
        .iter()
        .map(|column| column.name.as_str())
        .collect::<HashSet<_>>();
    let mut sources = HashSet::with_capacity(target.column_renames.len());
    let mut targets = HashSet::with_capacity(target.column_renames.len());
    let mut rename_by_source = HashMap::with_capacity(target.column_renames.len());

    for rename in &target.column_renames {
        validate_identifier(&rename.from, "columnRenames.from")?;
        validate_identifier(&rename.to, "columnRenames.to")?;
        if rename.from == rename.to
            || !baseline_names.contains(rename.from.as_str())
            || !desired_names.contains(rename.to.as_str())
            || !sources.insert(rename.from.as_str())
            || !targets.insert(rename.to.as_str())
        {
            return Err(validation(
                "ClickHouse column rename intents require unique existing sources and unique desired targets",
            ));
        }
        rename_by_source.insert(rename.from.clone(), rename.to.clone());
    }

    for rename in &target.column_renames {
        if sources.contains(rename.to.as_str()) {
            return Err(validation(
                "不能一次执行链式或循环列重命名，请拆分为多次修改",
            ));
        }
        if baseline_names.contains(rename.to.as_str()) && !sources.contains(rename.to.as_str()) {
            return Err(validation(format!(
                "ClickHouse column rename target {} collides with a retained baseline column",
                rename.to
            )));
        }
    }
    Ok(rename_by_source)
}

fn validate_column_dependencies(
    target: &ClickHouseAlterTableTarget,
    rename_by_source: &HashMap<String, String>,
) -> IpcResult<()> {
    let desired_names = target
        .desired
        .columns
        .iter()
        .map(|column| column.name.as_str())
        .collect::<HashSet<_>>();

    for baseline_column in &target.baseline.columns {
        let renamed = rename_by_source.contains_key(&baseline_column.name);
        let dropped = !renamed && !desired_names.contains(baseline_column.name.as_str());
        if (renamed || dropped) && immutable_semantics_reference(target, &baseline_column.name) {
            return Err(validation(format!(
                "ClickHouse column {} is referenced by immutable engine or key semantics",
                baseline_column.name
            )));
        }
    }
    Ok(())
}

fn immutable_semantics_reference(target: &ClickHouseAlterTableTarget, identifier: &str) -> bool {
    target
        .baseline
        .engine
        .arguments
        .iter()
        .any(|expression| expression_references_identifier(expression, identifier))
        || expression_references_identifier(&target.baseline.keys.order_by, identifier)
        || target
            .baseline
            .keys
            .partition_by
            .as_deref()
            .is_some_and(|expression| expression_references_identifier(expression, identifier))
        || target
            .baseline
            .keys
            .primary_key
            .as_deref()
            .is_some_and(|expression| expression_references_identifier(expression, identifier))
}

fn validate_sample_by_change(target: &ClickHouseAlterTableTarget) -> IpcResult<()> {
    if optional_normalized_expression_equal(
        target.baseline.keys.sample_by.as_deref(),
        target.desired.keys.sample_by.as_deref(),
    ) {
        return Ok(());
    }
    let Some(sample_by) = target.desired.keys.sample_by.as_deref() else {
        return Ok(());
    };
    let effective_primary = target
        .desired
        .keys
        .primary_key
        .as_deref()
        .unwrap_or(&target.desired.keys.order_by);
    let referenced_columns = target
        .desired
        .columns
        .iter()
        .filter(|column| expression_references_identifier(sample_by, &column.name))
        .collect::<Vec<_>>();
    if referenced_columns.is_empty()
        || referenced_columns
            .iter()
            .any(|column| !expression_references_identifier(effective_primary, &column.name))
    {
        return Err(validation(
            "ClickHouse SAMPLE BY must reference desired columns contained in the effective primary key",
        ));
    }
    Ok(())
}

fn validation(message: impl Into<String>) -> IpcError {
    IpcError::validation_failed(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::engine::drivers::clickhouse::schema::types::fixture_schema;
    use crate::engine::drivers::clickhouse::schema::{
        ClickHouseAlterTableTarget, ClickHouseCodecTarget, ClickHouseColumnDataActionTarget,
        ClickHouseColumnDefaultKind, ClickHouseColumnRenameIntent, ClickHouseCreateColumnTarget,
        ClickHouseCreateEngineTarget, ClickHouseCreateSettingTarget, ClickHouseCreateTableTarget,
        ClickHouseSettingSchema, ClickHouseTableSchema,
    };
    use crate::error::ErrorCode;

    fn editable_baseline() -> ClickHouseTableSchema {
        let mut schema = fixture_schema();
        schema.projections.clear();
        schema.skipping_indexes.clear();
        schema
    }

    fn desired_from_baseline(schema: &ClickHouseTableSchema) -> ClickHouseCreateTableTarget {
        ClickHouseCreateTableTarget {
            database: schema.identity.database.clone(),
            name: schema.identity.name.clone(),
            columns: schema
                .columns
                .iter()
                .map(|column| ClickHouseCreateColumnTarget {
                    name: column.name.clone(),
                    type_name: column.type_name.clone(),
                    default_kind: column.default_kind,
                    default_expression: column.default_expression.clone(),
                    codecs: if column.name == "id" {
                        vec![
                            ClickHouseCodecTarget {
                                name: "Delta".to_string(),
                                arguments: Vec::new(),
                            },
                            ClickHouseCodecTarget {
                                name: "ZSTD".to_string(),
                                arguments: vec!["1".to_string()],
                            },
                        ]
                    } else {
                        Vec::new()
                    },
                    ttl_expression: column.ttl_expression.clone(),
                    comment: column.comment.clone(),
                })
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

    fn fixture_alter_target() -> ClickHouseAlterTableTarget {
        let baseline = editable_baseline();
        let desired = desired_from_baseline(&baseline);
        ClickHouseAlterTableTarget {
            baseline,
            desired,
            column_renames: Vec::new(),
        }
    }

    fn assert_validation_error(result: crate::error::IpcResult<()>) {
        assert_eq!(result.unwrap_err().code, ErrorCode::ValidationFailed);
    }

    #[test]
    fn alter_validation_requires_explicit_non_chained_rename_intent() {
        let mut target = fixture_alter_target();
        target.desired.columns[1].name = "event_day".to_string();
        validate_alter_target(&target).unwrap();

        target.column_renames = vec![ClickHouseColumnRenameIntent {
            from: "day".to_string(),
            to: "event_day".to_string(),
        }];
        validate_alter_target(&target).unwrap();

        target.column_renames.push(ClickHouseColumnRenameIntent {
            from: "event_day".to_string(),
            to: "again".to_string(),
        });
        assert_validation_error(validate_alter_target(&target));
    }

    #[test]
    fn phase_five_c_key_allowlist_only_accepts_sample_by() {
        for mutation in ["engine", "order_by", "partition_by", "primary_key"] {
            let mut target = fixture_alter_target();
            match mutation {
                "engine" => target.desired.engine.family = "MergeTree".to_string(),
                "order_by" => target.desired.keys.order_by = "tuple()".to_string(),
                "partition_by" => target.desired.keys.partition_by = None,
                "primary_key" => target.desired.keys.primary_key = None,
                _ => unreachable!(),
            }
            assert_validation_error(validate_alter_target(&target));
        }

        let mut target = fixture_alter_target();
        target.desired.keys.sample_by = Some("cityHash64(id)".to_string());
        validate_alter_target(&target).unwrap();
    }

    #[test]
    fn validation_rejects_unknown_types_table_object_dependencies_and_noop() {
        let target = fixture_alter_target();
        assert_validation_error(validate_alter_target(&target));

        let mut target = fixture_alter_target();
        target.desired.columns[1].type_name = "FutureType(1)".to_string();
        assert_validation_error(validate_alter_target(&target));

        let mut target = fixture_alter_target();
        target.baseline.projections = fixture_schema().projections;
        target.desired.comment = Some("changed".to_string());
        let error = validate_alter_target(&target).unwrap_err();
        assert_eq!(
            error.message,
            "ClickHouse table-field changes remain blocked while Projection or data-skipping Index dependencies exist; manage those objects in their dedicated sections first"
        );
    }

    #[test]
    fn validation_rejects_key_dependency_rename_or_drop() {
        let mut renamed = fixture_alter_target();
        renamed.desired.columns[0].name = "event_id".to_string();
        renamed.column_renames = vec![ClickHouseColumnRenameIntent {
            from: "id".to_string(),
            to: "event_id".to_string(),
        }];
        assert_validation_error(validate_alter_target(&renamed));

        let mut dropped = fixture_alter_target();
        dropped.desired.columns.remove(0);
        assert_validation_error(validate_alter_target(&dropped));
    }

    #[test]
    fn column_action_requires_an_editable_stored_column() {
        let baseline = editable_baseline();
        let missing = ClickHouseColumnDataActionTarget {
            baseline: baseline.clone(),
            column_name: "missing".to_string(),
        };
        assert_validation_error(validate_column_action_target(&missing));

        let mut alias_baseline = baseline;
        alias_baseline.columns[1].default_kind = ClickHouseColumnDefaultKind::Alias;
        let alias = ClickHouseColumnDataActionTarget {
            baseline: alias_baseline,
            column_name: "day".to_string(),
        };
        assert_validation_error(validate_column_action_target(&alias));

        let valid = ClickHouseColumnDataActionTarget {
            baseline: editable_baseline(),
            column_name: "id".to_string(),
        };
        validate_column_action_target(&valid).unwrap();
    }

    #[test]
    fn phase_five_c_alter_settings_fail_closed_except_for_real_verified_mutable_setting() {
        for (name, initial, changed) in [
            ("index_granularity", "8192", "4096"),
            ("index_granularity_bytes", "10485760", "0"),
            ("allow_nullable_key", "1", "0"),
        ] {
            let mut modified = fixture_alter_target();
            if !modified
                .baseline
                .settings
                .iter()
                .any(|setting| setting.name == name)
            {
                modified.baseline.settings.push(ClickHouseSettingSchema {
                    name: name.to_string(),
                    value: initial.to_string(),
                    explicit: true,
                });
                modified
                    .desired
                    .settings
                    .push(ClickHouseCreateSettingTarget {
                        name: name.to_string(),
                        value: initial.to_string(),
                    });
            }
            modified
                .desired
                .settings
                .iter_mut()
                .find(|setting| setting.name == name)
                .expect("readonly setting fixture")
                .value = changed.to_string();
            assert_validation_error(validate_alter_target(&modified));

            let mut reset = fixture_alter_target();
            if !reset
                .baseline
                .settings
                .iter()
                .any(|setting| setting.name == name)
            {
                reset.baseline.settings.push(ClickHouseSettingSchema {
                    name: name.to_string(),
                    value: initial.to_string(),
                    explicit: true,
                });
            }
            reset
                .desired
                .settings
                .retain(|setting| setting.name != name);
            assert_validation_error(validate_alter_target(&reset));
        }

        let mut writable = fixture_alter_target();
        writable.baseline.settings.push(ClickHouseSettingSchema {
            name: "ttl_only_drop_parts".to_string(),
            value: "0".to_string(),
            explicit: true,
        });
        writable
            .desired
            .settings
            .push(ClickHouseCreateSettingTarget {
                name: "ttl_only_drop_parts".to_string(),
                value: "1".to_string(),
            });
        validate_alter_target(&writable).expect("real-verified mutable setting should pass");
    }
}
