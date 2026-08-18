#![allow(dead_code)]

use std::collections::HashSet;

use crate::engine::drivers::clickhouse::query::types::{parse_type, ClickHouseType};
use crate::error::{IpcError, IpcResult};

use super::create_types::{
    ClickHouseCodecTarget, ClickHouseCreateDatabaseTarget, ClickHouseCreateTableTarget,
};
use super::sql_scan::validate_single_expression;
use super::types::ClickHouseColumnDefaultKind;

pub(super) fn validate_create_database_target(
    target: &ClickHouseCreateDatabaseTarget,
) -> IpcResult<()> {
    validate_identifier(&target.name, "database.name")
}

pub(super) fn validate_create_table_target(target: &ClickHouseCreateTableTarget) -> IpcResult<()> {
    validate_identifier(&target.database, "table.database")?;
    validate_identifier(&target.name, "table.name")?;
    if target.columns.is_empty() {
        return Err(validation("ClickHouse table requires at least one column"));
    }

    let mut column_names = HashSet::with_capacity(target.columns.len());
    for (column_index, column) in target.columns.iter().enumerate() {
        let column_path = format!("columns.{column_index}");
        validate_identifier(&column.name, &format!("{column_path}.name"))?;
        if !column_names.insert(column.name.as_str()) {
            return Err(validation(format!(
                "ClickHouse {column_path}.name duplicates column identifier {}",
                column.name
            )));
        }

        let parsed_type = parse_type(&column.type_name).map_err(|error| {
            validation(format!(
                "ClickHouse {column_path}.typeName is invalid: {error}"
            ))
        })?;
        if matches!(parsed_type, ClickHouseType::Unknown { .. }) {
            return Err(validation(format!(
                "ClickHouse {column_path}.typeName is not supported for safe schema creation"
            )));
        }

        match (&column.default_kind, column.default_expression.as_deref()) {
            (ClickHouseColumnDefaultKind::None, None) => {}
            (ClickHouseColumnDefaultKind::None, Some(_)) => {
                return Err(validation(format!(
                    "ClickHouse {column_path}.defaultExpression must be absent when defaultKind is none"
                )));
            }
            (_, Some(expression)) => {
                validate_single_expression(expression, &format!("{column_path}.defaultExpression"))?
            }
            (_, None) => {
                return Err(validation(format!(
                    "ClickHouse {column_path}.defaultExpression is required for the selected defaultKind"
                )));
            }
        }

        for (codec_index, codec) in column.codecs.iter().enumerate() {
            validate_codec(codec, &format!("{column_path}.codecs.{codec_index}"))?;
        }
        if let Some(expression) = column.ttl_expression.as_deref() {
            validate_single_expression(expression, &format!("{column_path}.ttlExpression"))?;
        }
        validate_optional_comment(column.comment.as_deref(), &format!("{column_path}.comment"))?;
    }

    validate_engine(&target.engine.family, &target.engine.arguments)?;
    validate_single_expression(&target.keys.order_by, "keys.orderBy")?;
    validate_optional_expression(target.keys.partition_by.as_deref(), "keys.partitionBy")?;
    validate_optional_expression(target.keys.primary_key.as_deref(), "keys.primaryKey")?;
    validate_optional_expression(target.keys.sample_by.as_deref(), "keys.sampleBy")?;
    validate_optional_expression(target.table_ttl.as_deref(), "tableTtl")?;
    validate_optional_comment(target.comment.as_deref(), "comment")?;
    validate_settings(target)
}

pub(super) fn validate_identifier(value: &str, path: &str) -> IpcResult<()> {
    if value.is_empty() {
        return Err(validation(format!(
            "ClickHouse {path} requires a non-empty identifier"
        )));
    }
    if value.chars().any(char::is_control) {
        return Err(validation(format!(
            "ClickHouse {path} must not contain control characters"
        )));
    }
    Ok(())
}

fn validate_optional_expression(expression: Option<&str>, path: &str) -> IpcResult<()> {
    if let Some(expression) = expression {
        validate_single_expression(expression, path)?;
    }
    Ok(())
}

fn validate_optional_comment(comment: Option<&str>, path: &str) -> IpcResult<()> {
    if comment.is_some_and(|value| value.trim().is_empty()) {
        return Err(validation(format!(
            "ClickHouse {path} must be absent instead of empty"
        )));
    }
    Ok(())
}

fn validate_engine(family: &str, arguments: &[String]) -> IpcResult<()> {
    let valid_arity = match family {
        "MergeTree" | "AggregatingMergeTree" => arguments.is_empty(),
        "ReplacingMergeTree" | "SummingMergeTree" => arguments.len() <= 1,
        "CollapsingMergeTree" => arguments.len() == 1,
        "VersionedCollapsingMergeTree" => arguments.len() == 2,
        _ => false,
    };
    if !valid_arity {
        return Err(validation(format!(
            "ClickHouse engine {family} is unsupported or has invalid argument arity"
        )));
    }
    for (argument_index, argument) in arguments.iter().enumerate() {
        validate_single_expression(argument, &format!("engine.arguments.{argument_index}"))?;
    }
    Ok(())
}

fn validate_codec(codec: &ClickHouseCodecTarget, path: &str) -> IpcResult<()> {
    if !matches!(
        codec.name.as_str(),
        "LZ4" | "ZSTD" | "Delta" | "DoubleDelta" | "Gorilla" | "T64" | "FPC"
    ) {
        return Err(validation(format!(
            "ClickHouse {path}.name contains an unsupported codec"
        )));
    }
    for (argument_index, argument) in codec.arguments.iter().enumerate() {
        validate_single_expression(argument, &format!("{path}.arguments.{argument_index}"))?;
    }
    Ok(())
}

fn validate_settings(target: &ClickHouseCreateTableTarget) -> IpcResult<()> {
    let mut names = HashSet::with_capacity(target.settings.len());
    for (setting_index, setting) in target.settings.iter().enumerate() {
        let path = format!("settings.{setting_index}");
        if !names.insert(setting.name.as_str()) {
            return Err(validation(format!(
                "ClickHouse {path}.name duplicates setting {}",
                setting.name
            )));
        }
        match setting.name.as_str() {
            "index_granularity" => {
                let value = parse_u64_setting(&setting.value, &path)?;
                if value == 0 {
                    return Err(validation(format!(
                        "ClickHouse {path}.value must be a positive u64"
                    )));
                }
            }
            "index_granularity_bytes" => {
                parse_u64_setting(&setting.value, &path)?;
            }
            "allow_nullable_key" | "ttl_only_drop_parts" => {
                if !matches!(setting.value.as_str(), "0" | "1") {
                    return Err(validation(format!(
                        "ClickHouse {path}.value must be 0 or 1"
                    )));
                }
            }
            _ => {
                return Err(validation(format!(
                    "ClickHouse {path}.name contains an unsupported setting"
                )));
            }
        }
    }
    Ok(())
}

fn parse_u64_setting(value: &str, path: &str) -> IpcResult<u64> {
    value.parse::<u64>().map_err(|_| {
        validation(format!(
            "ClickHouse {path}.value must be an unsigned 64-bit integer"
        ))
    })
}

fn validation(message: impl Into<String>) -> IpcError {
    IpcError::validation_failed(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::engine::drivers::clickhouse::schema::{
        ClickHouseCodecTarget, ClickHouseColumnDefaultKind, ClickHouseCreateColumnTarget,
        ClickHouseCreateDatabaseTarget, ClickHouseCreateEngineTarget,
        ClickHouseCreateSettingTarget, ClickHouseCreateTableTarget, ClickHouseKeySchema,
    };
    use crate::error::ErrorCode;

    fn column(name: &str, type_name: &str) -> ClickHouseCreateColumnTarget {
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

    fn target() -> ClickHouseCreateTableTarget {
        ClickHouseCreateTableTarget {
            database: "analytics".to_string(),
            name: "events".to_string(),
            columns: vec![column("id", "UInt64"), column("note", "Nullable(String)")],
            engine: ClickHouseCreateEngineTarget {
                family: "MergeTree".to_string(),
                arguments: Vec::new(),
            },
            keys: ClickHouseKeySchema {
                order_by: "(id, cityHash64(note))".to_string(),
                partition_by: Some("toYYYYMM(now())".to_string()),
                primary_key: Some("id".to_string()),
                sample_by: Some("cityHash64(id)".to_string()),
            },
            table_ttl: Some("now() + INTERVAL 30 DAY DELETE".to_string()),
            comment: Some("event facts".to_string()),
            settings: vec![ClickHouseCreateSettingTarget {
                name: "index_granularity".to_string(),
                value: "8192".to_string(),
            }],
        }
    }

    fn assert_validation_error(result: crate::error::IpcResult<()>) {
        assert_eq!(
            result.expect_err("input must fail").code,
            ErrorCode::ValidationFailed
        );
    }

    #[test]
    fn engine_allowlist_enforces_family_and_argument_arity() {
        let valid = [
            ("MergeTree", vec![]),
            ("ReplacingMergeTree", vec![]),
            ("ReplacingMergeTree", vec!["version"]),
            ("SummingMergeTree", vec![]),
            ("SummingMergeTree", vec!["(amount, tax)"]),
            ("AggregatingMergeTree", vec![]),
            ("CollapsingMergeTree", vec!["sign"]),
            ("VersionedCollapsingMergeTree", vec!["sign", "version"]),
        ];
        for (family, arguments) in valid {
            let arguments = arguments
                .into_iter()
                .map(str::to_string)
                .collect::<Vec<_>>();
            assert!(validate_engine(family, &arguments).is_ok(), "{family}");
        }

        for (family, arguments) in [
            ("ReplicatedMergeTree", vec![]),
            ("SharedMergeTree", vec![]),
            ("Distributed", vec![]),
            ("MergeTree", vec!["version"]),
            ("CollapsingMergeTree", vec![]),
            ("CollapsingMergeTree", vec!["sign", "version"]),
            ("VersionedCollapsingMergeTree", vec!["sign"]),
            ("ReplacingMergeTree", vec!["version", "extra"]),
        ] {
            let arguments = arguments
                .into_iter()
                .map(str::to_string)
                .collect::<Vec<_>>();
            assert_validation_error(validate_engine(family, &arguments));
        }
        assert_validation_error(validate_engine("ReplacingMergeTree", &[" ".to_string()]));
    }

    #[test]
    fn codec_allowlist_validates_every_argument_as_one_expression() {
        for name in [
            "LZ4",
            "ZSTD",
            "Delta",
            "DoubleDelta",
            "Gorilla",
            "T64",
            "FPC",
        ] {
            assert!(validate_codec(
                &ClickHouseCodecTarget {
                    name: name.to_string(),
                    arguments: Vec::new(),
                },
                "columns.0.codecs.0"
            )
            .is_ok());
        }
        assert!(validate_codec(
            &ClickHouseCodecTarget {
                name: "ZSTD".to_string(),
                arguments: vec!["1 + 2".to_string()],
            },
            "columns.0.codecs.0"
        )
        .is_ok());

        assert_validation_error(validate_codec(
            &ClickHouseCodecTarget {
                name: "UNKNOWN".to_string(),
                arguments: Vec::new(),
            },
            "columns.0.codecs.0",
        ));
        assert_validation_error(validate_codec(
            &ClickHouseCodecTarget {
                name: "ZSTD".to_string(),
                arguments: vec![String::new()],
            },
            "columns.0.codecs.0",
        ));
    }

    #[test]
    fn settings_allowlist_enforces_numeric_domains_and_unique_names() {
        let mut valid = target();
        valid.settings = vec![
            ClickHouseCreateSettingTarget {
                name: "index_granularity".to_string(),
                value: "8192".to_string(),
            },
            ClickHouseCreateSettingTarget {
                name: "index_granularity_bytes".to_string(),
                value: "0".to_string(),
            },
            ClickHouseCreateSettingTarget {
                name: "allow_nullable_key".to_string(),
                value: "1".to_string(),
            },
            ClickHouseCreateSettingTarget {
                name: "ttl_only_drop_parts".to_string(),
                value: "0".to_string(),
            },
        ];
        assert!(validate_create_table_target(&valid).is_ok());

        for (name, value) in [
            ("unknown", "1"),
            ("index_granularity", "0"),
            ("index_granularity", "18446744073709551616"),
            ("index_granularity_bytes", "-1"),
            ("allow_nullable_key", "2"),
            ("ttl_only_drop_parts", "true"),
        ] {
            let mut invalid = target();
            invalid.settings = vec![ClickHouseCreateSettingTarget {
                name: name.to_string(),
                value: value.to_string(),
            }];
            assert_validation_error(validate_create_table_target(&invalid));
        }

        let mut duplicate = target();
        duplicate.settings.push(ClickHouseCreateSettingTarget {
            name: "index_granularity".to_string(),
            value: "4096".to_string(),
        });
        assert_validation_error(validate_create_table_target(&duplicate));
    }

    #[test]
    fn table_target_rejects_unknown_types_bad_pairing_and_duplicate_columns() {
        assert!(validate_create_table_target(&target()).is_ok());

        let mut empty = target();
        empty.columns.clear();
        assert_validation_error(validate_create_table_target(&empty));

        let mut duplicate = target();
        duplicate.columns.push(column("id", "UInt32"));
        assert_validation_error(validate_create_table_target(&duplicate));

        let mut unknown = target();
        unknown.columns[0].type_name = "FutureType(UInt64)".to_string();
        assert_validation_error(validate_create_table_target(&unknown));

        let mut none_with_expression = target();
        none_with_expression.columns[0].default_expression = Some("1".to_string());
        assert_validation_error(validate_create_table_target(&none_with_expression));

        for kind in [
            ClickHouseColumnDefaultKind::Default,
            ClickHouseColumnDefaultKind::Materialized,
            ClickHouseColumnDefaultKind::Alias,
            ClickHouseColumnDefaultKind::Ephemeral,
        ] {
            let mut missing = target();
            missing.columns[0].default_kind = kind;
            assert_validation_error(validate_create_table_target(&missing));

            missing.columns[0].default_expression = Some("toUInt64(1)".to_string());
            assert!(validate_create_table_target(&missing).is_ok());
        }
    }

    #[test]
    fn identifiers_comments_and_required_order_by_fail_closed_without_rewriting() {
        for name in ["", "bad\0name", "bad\nname"] {
            let target = ClickHouseCreateDatabaseTarget {
                name: name.to_string(),
            };
            assert_validation_error(validate_create_database_target(&target));
        }
        let byte_preserving = ClickHouseCreateDatabaseTarget {
            name: " 分析库 `原样` ".to_string(),
        };
        assert!(validate_create_database_target(&byte_preserving).is_ok());

        let mut empty_comment = target();
        empty_comment.comment = Some(String::new());
        assert_validation_error(validate_create_table_target(&empty_comment));

        let mut empty_column_comment = target();
        empty_column_comment.columns[0].comment = Some(" ".to_string());
        assert_validation_error(validate_create_table_target(&empty_column_comment));

        let mut no_order_by = target();
        no_order_by.keys.order_by.clear();
        assert_validation_error(validate_create_table_target(&no_order_by));
    }
}
