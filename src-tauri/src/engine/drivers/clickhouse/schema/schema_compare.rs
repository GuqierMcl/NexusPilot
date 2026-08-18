#![allow(dead_code)]

use crate::engine::types::ContainerKind;
use crate::error::IpcResult;

use super::canonical::revision_hash;
use super::change_types::{ClickHouseProjectionTarget, ClickHouseSkippingIndexTarget};
use super::create_types::{ClickHouseCodecTarget, ClickHouseCreateTableTarget};
use super::types::{
    ClickHouseProjectionSchema, ClickHouseSchemaEditabilityMode, ClickHouseSkippingIndexSchema,
    ClickHouseTableSchema,
};

pub(super) fn table_baselines_equal(
    expected: &ClickHouseTableSchema,
    current: &ClickHouseTableSchema,
) -> IpcResult<bool> {
    Ok(revision_hash(expected)? == revision_hash(current)?)
}

pub(super) fn table_schema_matches_target(
    target: &ClickHouseCreateTableTarget,
    schema: &ClickHouseTableSchema,
) -> bool {
    if schema.identity.database != target.database
        || schema.identity.name != target.name
        || schema.identity.object_kind != ContainerKind::Table
        || schema.editability.mode != ClickHouseSchemaEditabilityMode::Editable
        || !schema.editability.blockers.is_empty()
        || !schema.projections.is_empty()
        || !schema.skipping_indexes.is_empty()
        || schema.engine.family != target.engine.family
        || !expression_slices_equal(&schema.engine.arguments, &target.engine.arguments)
        || schema.columns.len() != target.columns.len()
    {
        return false;
    }

    for (index, (actual, expected)) in schema.columns.iter().zip(&target.columns).enumerate() {
        if actual.position != index as u64 + 1
            || actual.name != expected.name
            || !normalized_expression_equal(&actual.type_name, &expected.type_name)
            || actual.default_kind != expected.default_kind
            || !optional_normalized_expression_equal(
                actual.default_expression.as_deref(),
                expected.default_expression.as_deref(),
            )
            || !optional_ttl_expression_equal(
                actual.ttl_expression.as_deref(),
                expected.ttl_expression.as_deref(),
                false,
            )
            || actual.comment != expected.comment
            || actual.editability.mode != ClickHouseSchemaEditabilityMode::Editable
            || !actual.editability.blockers.is_empty()
            || !codec_matches(actual.codec_expression.as_deref(), &expected.codecs)
        {
            return false;
        }
    }

    optional_normalized_expression_equal(
        schema.keys.partition_by.as_deref(),
        target.keys.partition_by.as_deref(),
    ) && optional_normalized_expression_equal(
        schema.keys.primary_key.as_deref(),
        target.keys.primary_key.as_deref(),
    ) && normalized_expression_equal(&schema.keys.order_by, &target.keys.order_by)
        && optional_normalized_expression_equal(
            schema.keys.sample_by.as_deref(),
            target.keys.sample_by.as_deref(),
        )
        && optional_ttl_expression_equal(
            schema.table_ttl.as_deref(),
            target.table_ttl.as_deref(),
            true,
        )
        && schema.comment == target.comment
        && explicit_settings_match(target, schema)
}

pub(super) fn expression_slices_equal(actual: &[String], expected: &[String]) -> bool {
    actual.len() == expected.len()
        && actual
            .iter()
            .zip(expected)
            .all(|(actual, expected)| normalized_expression_equal(actual, expected))
}

pub(super) fn projection_matches(
    expected: &ClickHouseProjectionTarget,
    actual: &ClickHouseProjectionSchema,
) -> bool {
    expected.name == actual.name
        && normalized_expression_equal(&expected.query, &actual.query)
        && actual.editability.mode == ClickHouseSchemaEditabilityMode::Editable
        && actual.editability.blockers.is_empty()
}

pub(super) fn projection_is_absent(name: &str, schema: &ClickHouseTableSchema) -> bool {
    schema
        .projections
        .iter()
        .all(|projection| projection.name != name)
}

pub(super) fn skipping_index_matches(
    expected: &ClickHouseSkippingIndexTarget,
    actual: &ClickHouseSkippingIndexSchema,
) -> bool {
    let index_type = expected.index_type.to_ascii_lowercase();
    expected.name == actual.name
        && index_type == actual.index_type.to_ascii_lowercase()
        && skipping_index_arguments_equal(
            &index_type,
            &expected.type_arguments,
            &actual.type_arguments,
        )
        && normalized_expression_equal(&expected.expression, &actual.expression)
        && actual.granularity == Some(expected.granularity)
        && actual.editability.mode == ClickHouseSchemaEditabilityMode::Editable
        && actual.editability.blockers.is_empty()
}

pub(super) fn skipping_index_is_absent(name: &str, schema: &ClickHouseTableSchema) -> bool {
    schema
        .skipping_indexes
        .iter()
        .all(|index| index.name != name)
}

fn skipping_index_arguments_equal(
    index_type: &str,
    expected: &[String],
    actual: &[String],
) -> bool {
    if expected.len() != actual.len() {
        return false;
    }
    if index_type == "bloom_filter" {
        return expected.iter().zip(actual).all(|(expected, actual)| {
            let Ok(expected) = expected.parse::<f64>() else {
                return false;
            };
            let Ok(actual) = actual.parse::<f64>() else {
                return false;
            };
            expected.is_finite() && actual.is_finite() && expected == actual
        });
    }
    if !matches!(index_type, "minmax" | "set" | "ngrambf_v1" | "tokenbf_v1") {
        return false;
    }
    expected.iter().zip(actual).all(|(expected, actual)| {
        match (expected.parse::<u64>(), actual.parse::<u64>()) {
            (Ok(expected), Ok(actual)) => expected == actual,
            _ => false,
        }
    })
}

pub(super) fn optional_normalized_expression_equal(
    actual: Option<&str>,
    expected: Option<&str>,
) -> bool {
    match (actual, expected) {
        (None, None) => true,
        (Some(actual), Some(expected)) => normalized_expression_equal(actual, expected),
        _ => false,
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

fn explicit_settings_match(
    target: &ClickHouseCreateTableTarget,
    schema: &ClickHouseTableSchema,
) -> bool {
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
                    || is_canonical_merge_tree_default_setting(&setting.name, &setting.value)
            })
}

fn is_canonical_merge_tree_default_setting(name: &str, value: &str) -> bool {
    name == "index_granularity" && value == "8192"
}

pub(super) fn normalized_expression_equal(left: &str, right: &str) -> bool {
    normalize_expression(left) == normalize_expression(right)
}

fn optional_ttl_expression_equal(
    actual: Option<&str>,
    expected: Option<&str>,
    default_delete_is_implicit: bool,
) -> bool {
    match (actual, expected) {
        (None, None) => true,
        (Some(actual), Some(expected)) => {
            canonicalize_ttl_expression(actual, default_delete_is_implicit)
                == canonicalize_ttl_expression(expected, default_delete_is_implicit)
        }
        _ => false,
    }
}

fn canonicalize_ttl_expression(value: &str, default_delete_is_implicit: bool) -> String {
    let mut normalized = normalize_expression(value);
    if default_delete_is_implicit {
        normalized = strip_trailing_default_delete(normalized);
    }
    canonicalize_interval_literals(&normalized)
}

fn strip_trailing_default_delete(value: String) -> String {
    const DELETE: &[u8] = b"DELETE";
    let bytes = value.as_bytes();
    if bytes.len() < DELETE.len()
        || !bytes[bytes.len() - DELETE.len()..].eq_ignore_ascii_case(DELETE)
    {
        return value;
    }
    let prefix = &value[..value.len() - DELETE.len()];
    if prefix.chars().last().is_some_and(|character| {
        character.is_whitespace() || (!character.is_alphanumeric() && character != '_')
    }) {
        prefix.trim_end().to_string()
    } else {
        value
    }
}

fn canonicalize_interval_literals(value: &str) -> String {
    const INTERVAL: &[u8] = b"INTERVAL";
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    let mut quote = None;
    let mut escaped = false;

    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(active_quote) = quote {
            output.push(byte);
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == active_quote {
                quote = None;
            }
            index += 1;
            continue;
        }
        if matches!(byte, b'\'' | b'"' | b'`') {
            quote = Some(byte);
            output.push(byte);
            index += 1;
            continue;
        }

        let keyword_end = index + INTERVAL.len();
        let boundary_before = index == 0 || !is_expression_word_byte(bytes[index - 1]);
        if boundary_before
            && keyword_end < bytes.len()
            && bytes[index..keyword_end].eq_ignore_ascii_case(INTERVAL)
            && bytes[keyword_end].is_ascii_whitespace()
        {
            let mut cursor = keyword_end;
            while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
            let number_start = cursor;
            if cursor < bytes.len() && matches!(bytes[cursor], b'+' | b'-') {
                cursor += 1;
            }
            let digits_start = cursor;
            while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
                cursor += 1;
            }
            if cursor > digits_start && cursor < bytes.len() && bytes[cursor].is_ascii_whitespace()
            {
                let number_end = cursor;
                while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                    cursor += 1;
                }
                let unit_start = cursor;
                while cursor < bytes.len() && bytes[cursor].is_ascii_alphabetic() {
                    cursor += 1;
                }
                if let Some(unit) = interval_function_suffix(&bytes[unit_start..cursor]) {
                    output.extend_from_slice(b"toInterval");
                    output.extend_from_slice(unit.as_bytes());
                    output.push(b'(');
                    output.extend_from_slice(&bytes[number_start..number_end]);
                    output.push(b')');
                    index = cursor;
                    continue;
                }
            }
        }

        output.push(byte);
        index += 1;
    }

    String::from_utf8(output).expect("TTL canonicalization preserves UTF-8 bytes")
}

fn interval_function_suffix(unit: &[u8]) -> Option<&'static str> {
    [
        (b"NANOSECOND".as_slice(), "Nanosecond"),
        (b"MICROSECOND".as_slice(), "Microsecond"),
        (b"MILLISECOND".as_slice(), "Millisecond"),
        (b"SECOND".as_slice(), "Second"),
        (b"MINUTE".as_slice(), "Minute"),
        (b"HOUR".as_slice(), "Hour"),
        (b"DAY".as_slice(), "Day"),
        (b"WEEK".as_slice(), "Week"),
        (b"MONTH".as_slice(), "Month"),
        (b"QUARTER".as_slice(), "Quarter"),
        (b"YEAR".as_slice(), "Year"),
    ]
    .into_iter()
    .find_map(|(candidate, suffix)| unit.eq_ignore_ascii_case(candidate).then_some(suffix))
}

fn is_expression_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn normalize_expression(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut quote = None;
    let mut escaped = false;
    let mut pending_space = false;
    let mut previous_was_word = false;

    for character in value.trim().chars() {
        if let Some(active_quote) = quote {
            normalized.push(character);
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == active_quote {
                quote = None;
                previous_was_word = true;
            }
            continue;
        }
        if matches!(character, '\'' | '"' | '`') {
            if pending_space && previous_was_word {
                normalized.push(' ');
            }
            pending_space = false;
            quote = Some(character);
            normalized.push(character);
            previous_was_word = false;
        } else if character.is_whitespace() {
            pending_space = true;
        } else {
            let current_is_word = character.is_alphanumeric() || character == '_';
            if pending_space && previous_was_word && current_is_word {
                normalized.push(' ');
            }
            pending_space = false;
            normalized.push(character);
            previous_was_word = current_is_word;
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::engine::drivers::clickhouse::schema::types::fixture_schema;
    use crate::engine::drivers::clickhouse::schema::{
        ClickHouseCodecTarget, ClickHouseCreateColumnTarget, ClickHouseCreateEngineTarget,
        ClickHouseCreateSettingTarget, ClickHouseCreateTableTarget,
    };

    fn target_from_schema(schema: &ClickHouseTableSchema) -> ClickHouseCreateTableTarget {
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

    #[test]
    fn baseline_comparison_uses_canonical_semantics_not_supplied_hash_only() {
        let expected = fixture_schema();
        let mut current = expected.clone();
        current.baseline.revision_hash = "f".repeat(64);
        assert!(table_baselines_equal(&expected, &current).unwrap());

        current.columns[0].type_name = "UInt32".to_string();
        current.baseline.revision_hash = expected.baseline.revision_hash.clone();
        assert!(!table_baselines_equal(&expected, &current).unwrap());
    }

    #[test]
    fn baseline_comparison_detects_remote_object_identity_drift() {
        let expected = fixture_schema();
        let mut current = expected.clone();
        current.identity.uuid = Some("00000000-0000-0000-0000-000000000002".to_string());

        assert!(!table_baselines_equal(&expected, &current).unwrap());
    }

    #[test]
    fn target_ttl_comparison_accepts_clickhouse_interval_and_default_delete_canonicalization() {
        let mut schema = fixture_schema();
        schema.projections.clear();
        schema.skipping_indexes.clear();
        schema.table_ttl = Some("created_at + toIntervalDay(30)".to_string());
        let mut target = target_from_schema(&schema);
        target.table_ttl = Some("created_at + INTERVAL 30 DAY DELETE".to_string());

        assert!(table_schema_matches_target(&target, &schema));

        target.table_ttl = Some("created_at + toIntervalDay(30) DELETE".to_string());
        assert!(table_schema_matches_target(&target, &schema));

        target.table_ttl = Some("created_at + INTERVAL 30 DAY DELETE WHERE id = 0".to_string());
        assert!(!table_schema_matches_target(&target, &schema));
    }

    #[test]
    fn projection_semantic_match_is_quote_aware_and_absence_is_exact() {
        let schema = fixture_schema();
        let expected = crate::engine::drivers::clickhouse::schema::ClickHouseProjectionTarget {
            name: "a_projection".to_string(),
            query: "SELECT day, count()   GROUP BY day".to_string(),
        };
        let actual = schema
            .projections
            .iter()
            .find(|projection| projection.name == "a_projection")
            .expect("a_projection fixture");
        assert!(projection_matches(&expected, actual));
        assert!(!projection_is_absent("a_projection", &schema));
        assert!(projection_is_absent("missing_projection", &schema));

        let quoted = crate::engine::drivers::clickhouse::schema::ClickHouseProjectionTarget {
            name: "a_projection".to_string(),
            query: "SELECT 'GROUP  BY'".to_string(),
        };
        let mut actual = actual.clone();
        actual.query = "SELECT 'GROUP BY'".to_string();
        assert!(!projection_matches(&quoted, &actual));
    }

    #[test]
    fn skipping_index_semantic_match_canonicalizes_family_arguments_and_expression() {
        let schema = fixture_schema();
        let actual = schema
            .skipping_indexes
            .iter()
            .find(|index| index.name == "a_index")
            .expect("a_index fixture");
        let expected = crate::engine::drivers::clickhouse::schema::ClickHouseSkippingIndexTarget {
            name: "a_index".to_string(),
            expression: "  day  ".to_string(),
            index_type: "SET".to_string(),
            type_arguments: vec!["0100".to_string()],
            granularity: 4,
        };

        assert!(skipping_index_matches(&expected, actual));
        assert!(!skipping_index_is_absent("a_index", &schema));
        assert!(skipping_index_is_absent("missing_index", &schema));

        let mut changed = actual.clone();
        changed.expression = "'a b'".to_string();
        let quoted = crate::engine::drivers::clickhouse::schema::ClickHouseSkippingIndexTarget {
            expression: "'a  b'".to_string(),
            ..expected.clone()
        };
        assert!(!skipping_index_matches(&quoted, &changed));

        changed = actual.clone();
        changed.granularity = None;
        assert!(!skipping_index_matches(&expected, &changed));
    }
}
