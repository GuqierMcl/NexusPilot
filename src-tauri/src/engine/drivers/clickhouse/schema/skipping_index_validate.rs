#![allow(dead_code)]

use crate::engine::types::SchemaMutationOperation;
use crate::error::{IpcError, IpcResult};

use super::alter_validate::validate_editable_table_baseline;
use super::change_types::{
    ClickHouseSkippingIndexActionTarget, ClickHouseSkippingIndexCreateTarget,
    ClickHouseSkippingIndexTarget,
};
use super::create_validate::validate_identifier;
use super::sql_scan::validate_single_expression;
use super::types::ClickHouseSchemaEditabilityMode;

pub(super) fn validate_skipping_index_create_target(
    target: &ClickHouseSkippingIndexCreateTarget,
) -> IpcResult<()> {
    validate_editable_table_baseline(&target.baseline)?;
    validate_skipping_index_definition(&target.index)?;
    if target
        .baseline
        .skipping_indexes
        .iter()
        .any(|index| index.name == target.index.name)
    {
        return Err(validation(format!(
            "ClickHouse data-skipping index {} already exists in the baseline",
            target.index.name
        )));
    }
    Ok(())
}

pub(super) fn validate_skipping_index_action_target(
    target: &ClickHouseSkippingIndexActionTarget,
    operation: SchemaMutationOperation,
) -> IpcResult<()> {
    validate_editable_table_baseline(&target.baseline)?;
    if !matches!(
        operation,
        SchemaMutationOperation::Drop
            | SchemaMutationOperation::Clear
            | SchemaMutationOperation::Materialize
    ) {
        return Err(validation(
            "ClickHouse data-skipping index actions support only drop, clear or materialize",
        ));
    }
    validate_identifier(&target.index_name, "skippingIndexAction.indexName")?;
    let index = target
        .baseline
        .skipping_indexes
        .iter()
        .find(|index| index.name == target.index_name)
        .ok_or_else(|| {
            validation(format!(
                "ClickHouse data-skipping index {} does not exist in the baseline",
                target.index_name
            ))
        })?;
    if index.editability.mode != ClickHouseSchemaEditabilityMode::Editable
        || !index.editability.blockers.is_empty()
    {
        return Err(validation(format!(
            "ClickHouse data-skipping index {} is not editable",
            target.index_name
        )));
    }
    Ok(())
}

pub(super) fn validate_skipping_index_definition(
    index: &ClickHouseSkippingIndexTarget,
) -> IpcResult<()> {
    validate_identifier(&index.name, "skippingIndex.name")?;
    validate_single_expression(&index.expression, "skippingIndex.expression")?;
    if index.granularity == 0 {
        return Err(validation(
            "ClickHouse data-skipping index granularity must be greater than zero",
        ));
    }

    match index.index_type.to_ascii_lowercase().as_str() {
        "minmax" => require_arity(index, 0),
        "set" => {
            require_arity(index, 1)?;
            parse_u64_argument(index, 0).map(|_| ())
        }
        "bloom_filter" => validate_bloom_filter(index),
        "ngrambf_v1" => {
            require_arity(index, 4)?;
            let values = parse_u64_arguments(index)?;
            if values[..3].contains(&0) {
                return Err(validation(
                    "ClickHouse ngrambf_v1 size arguments must be greater than zero",
                ));
            }
            Ok(())
        }
        "tokenbf_v1" => {
            require_arity(index, 3)?;
            let values = parse_u64_arguments(index)?;
            if values[..2].contains(&0) {
                return Err(validation(
                    "ClickHouse tokenbf_v1 size arguments must be greater than zero",
                ));
            }
            Ok(())
        }
        _ => Err(validation(format!(
            "ClickHouse data-skipping index type {} is unsupported",
            index.index_type
        ))),
    }
}

fn require_arity(index: &ClickHouseSkippingIndexTarget, expected: usize) -> IpcResult<()> {
    if index.type_arguments.len() != expected {
        return Err(validation(format!(
            "ClickHouse data-skipping index type {} requires {expected} arguments",
            index.index_type
        )));
    }
    Ok(())
}

fn parse_u64_argument(index: &ClickHouseSkippingIndexTarget, position: usize) -> IpcResult<u64> {
    index.type_arguments[position].parse::<u64>().map_err(|_| {
        validation(format!(
            "ClickHouse data-skipping index type {} argument {} must be an unsigned integer",
            index.index_type,
            position + 1
        ))
    })
}

fn parse_u64_arguments(index: &ClickHouseSkippingIndexTarget) -> IpcResult<Vec<u64>> {
    (0..index.type_arguments.len())
        .map(|position| parse_u64_argument(index, position))
        .collect()
}

fn validate_bloom_filter(index: &ClickHouseSkippingIndexTarget) -> IpcResult<()> {
    if index.type_arguments.is_empty() {
        return Ok(());
    }
    require_arity(index, 1)?;
    let value = index.type_arguments[0].parse::<f64>().map_err(|_| {
        validation("ClickHouse bloom_filter false-positive rate must be a finite number")
    })?;
    if !value.is_finite() || !(0.0..1.0).contains(&value) || value == 0.0 {
        return Err(validation(
            "ClickHouse bloom_filter false-positive rate must satisfy 0 < value < 1",
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

    use crate::engine::drivers::clickhouse::schema::{
        types::fixture_schema, ClickHouseSkippingIndexActionTarget,
        ClickHouseSkippingIndexCreateTarget, ClickHouseSkippingIndexTarget,
    };
    use crate::engine::types::SchemaMutationOperation;
    use crate::error::ErrorCode;

    fn definition(index_type: &str, arguments: &[&str]) -> ClickHouseSkippingIndexTarget {
        ClickHouseSkippingIndexTarget {
            name: "payload_idx".to_string(),
            expression: "payload".to_string(),
            index_type: index_type.to_string(),
            type_arguments: arguments
                .iter()
                .map(|argument| (*argument).to_string())
                .collect(),
            granularity: 1,
        }
    }

    #[test]
    fn skipping_index_allowlist_enforces_exact_argument_domains() {
        for valid in [
            definition("minmax", &[]),
            definition("set", &["0"]),
            definition("bloom_filter", &[]),
            definition("bloom_filter", &["0.01"]),
            definition("ngrambf_v1", &["3", "256", "2", "0"]),
            definition("tokenbf_v1", &["256", "2", "0"]),
        ] {
            validate_skipping_index_definition(&valid).expect(&valid.index_type);
        }

        let mut invalid = vec![
            definition("future_index", &["1"]),
            definition("minmax", &["1"]),
            definition("set", &[]),
            definition("set", &["-1"]),
            definition("bloom_filter", &["0"]),
            definition("bloom_filter", &["1"]),
            definition("bloom_filter", &["NaN"]),
            definition("ngrambf_v1", &["0", "256", "2", "0"]),
            definition("ngrambf_v1", &["3", "256", "2"]),
            definition("tokenbf_v1", &["256", "0", "0"]),
            definition("tokenbf_v1", &["256", "2", "0", "1"]),
        ];
        let mut blank_expression = definition("minmax", &[]);
        blank_expression.expression.clear();
        invalid.push(blank_expression);
        let mut zero_granularity = definition("minmax", &[]);
        zero_granularity.granularity = 0;
        invalid.push(zero_granularity);

        for target in invalid {
            assert_eq!(
                validate_skipping_index_definition(&target)
                    .unwrap_err()
                    .code,
                ErrorCode::ValidationFailed,
                "{} {:?}",
                target.index_type,
                target.type_arguments
            );
        }
    }

    #[test]
    fn skipping_index_create_and_actions_require_editable_exact_objects() {
        let baseline = fixture_schema();
        let create = ClickHouseSkippingIndexCreateTarget {
            baseline: baseline.clone(),
            index: definition("minmax", &[]),
        };
        validate_skipping_index_create_target(&create).expect("new index");

        let duplicate = ClickHouseSkippingIndexCreateTarget {
            baseline: baseline.clone(),
            index: ClickHouseSkippingIndexTarget {
                name: baseline.skipping_indexes[0].name.clone(),
                ..definition("minmax", &[])
            },
        };
        assert_eq!(
            validate_skipping_index_create_target(&duplicate)
                .unwrap_err()
                .code,
            ErrorCode::ValidationFailed
        );

        let action = ClickHouseSkippingIndexActionTarget {
            baseline: baseline.clone(),
            index_name: baseline.skipping_indexes[0].name.clone(),
        };
        for operation in [
            SchemaMutationOperation::Drop,
            SchemaMutationOperation::Clear,
            SchemaMutationOperation::Materialize,
        ] {
            validate_skipping_index_action_target(&action, operation).expect("supported action");
        }
        assert_eq!(
            validate_skipping_index_action_target(&action, SchemaMutationOperation::Create)
                .unwrap_err()
                .code,
            ErrorCode::ValidationFailed
        );
    }
}
