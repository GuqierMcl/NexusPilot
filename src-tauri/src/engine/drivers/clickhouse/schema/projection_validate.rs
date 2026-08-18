#![allow(dead_code)]

use crate::engine::types::SchemaMutationOperation;
use crate::error::{IpcError, IpcResult};

use super::alter_validate::validate_editable_table_baseline;
use super::change_types::{
    ClickHouseProjectionActionTarget, ClickHouseProjectionCreateTarget, ClickHouseProjectionTarget,
};
use super::create_validate::validate_identifier;
use super::sql_scan::validate_single_expression;
use super::types::ClickHouseSchemaEditabilityMode;

const FORBIDDEN_TOP_LEVEL_WORDS: &[&str] = &[
    "FROM", "JOIN", "UNION", "PREWHERE", "LIMIT", "OFFSET", "INTO", "FORMAT", "SETTINGS",
];

pub(super) fn validate_projection_create_target(
    target: &ClickHouseProjectionCreateTarget,
) -> IpcResult<()> {
    validate_editable_table_baseline(&target.baseline)?;
    validate_projection_definition(&target.projection)?;
    if target
        .baseline
        .projections
        .iter()
        .any(|projection| projection.name == target.projection.name)
    {
        return Err(validation(format!(
            "ClickHouse projection {} already exists in the baseline",
            target.projection.name
        )));
    }
    Ok(())
}

pub(super) fn validate_projection_action_target(
    target: &ClickHouseProjectionActionTarget,
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
            "ClickHouse projection actions support only drop, clear or materialize",
        ));
    }
    validate_identifier(&target.projection_name, "projectionAction.projectionName")?;
    let projection = target
        .baseline
        .projections
        .iter()
        .find(|projection| projection.name == target.projection_name)
        .ok_or_else(|| {
            validation(format!(
                "ClickHouse projection {} does not exist in the baseline",
                target.projection_name
            ))
        })?;
    if projection.editability.mode != ClickHouseSchemaEditabilityMode::Editable
        || !projection.editability.blockers.is_empty()
    {
        return Err(validation(format!(
            "ClickHouse projection {} is not editable",
            target.projection_name
        )));
    }
    Ok(())
}

pub(super) fn validate_projection_definition(
    projection: &ClickHouseProjectionTarget,
) -> IpcResult<()> {
    validate_identifier(&projection.name, "projection.name")?;
    validate_projection_query(&projection.query)
}

pub(super) fn validate_projection_query(query: &str) -> IpcResult<()> {
    validate_single_expression(query, "projection.query")?;
    let words = top_level_words(query)?;
    if words.first().map(String::as_str) != Some("SELECT") {
        return Err(validation(
            "ClickHouse projection query must start with one top-level SELECT",
        ));
    }
    if let Some(word) = words
        .iter()
        .find(|word| FORBIDDEN_TOP_LEVEL_WORDS.contains(&word.as_str()))
    {
        return Err(validation(format!(
            "ClickHouse projection query contains unsupported top-level {word}"
        )));
    }
    Ok(())
}

fn top_level_words(query: &str) -> IpcResult<Vec<String>> {
    let bytes = query.as_bytes();
    let mut words = Vec::new();
    let mut delimiters = Vec::new();
    let mut quote = None;
    let mut escaped = false;
    let mut index = 0;

    while index < bytes.len() {
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
                index += 1;
                continue;
            }
            if bytes[index] == b'\\' {
                escaped = true;
                index += 1;
                continue;
            }
            if bytes[index] == active_quote {
                if bytes.get(index + 1) == Some(&active_quote) {
                    index += 2;
                } else {
                    quote = None;
                    index += 1;
                }
                continue;
            }
            index += 1;
            continue;
        }

        match bytes[index] {
            quote_byte @ (b'\'' | b'"' | b'`') => {
                quote = Some(quote_byte);
                index += 1;
            }
            opening @ (b'(' | b'[' | b'{') => {
                delimiters.push(match opening {
                    b'(' => b')',
                    b'[' => b']',
                    b'{' => b'}',
                    _ => unreachable!(),
                });
                index += 1;
            }
            closing @ (b')' | b']' | b'}') => {
                if delimiters.pop() != Some(closing) {
                    return Err(validation(
                        "ClickHouse projection query contains mismatched delimiters",
                    ));
                }
                index += 1;
            }
            b';' => {
                return Err(validation(
                    "ClickHouse projection query must contain exactly one statement",
                ))
            }
            byte if delimiters.is_empty() && (byte.is_ascii_alphabetic() || byte == b'_') => {
                let start = index;
                index += 1;
                while index < bytes.len()
                    && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
                {
                    index += 1;
                }
                words.push(query[start..index].to_ascii_uppercase());
            }
            _ => index += 1,
        }
    }

    Ok(words)
}

fn validation(message: impl Into<String>) -> IpcError {
    IpcError::validation_failed(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::engine::drivers::clickhouse::schema::{
        types::fixture_schema, ClickHouseProjectionActionTarget, ClickHouseProjectionCreateTarget,
        ClickHouseProjectionTarget,
    };
    use crate::engine::types::SchemaMutationOperation;
    use crate::error::ErrorCode;

    #[test]
    fn projection_query_accepts_only_the_phase_five_d_select_shape() {
        for query in [
            "SELECT tenant_id, count() GROUP BY tenant_id",
            "SELECT id, payload WHERE payload != '' ORDER BY id",
            "SELECT if(payload = 'FROM value', 1, 0) ORDER BY id",
        ] {
            validate_projection_query(query).expect(query);
        }

        for query in [
            "",
            "SELECT * FROM other",
            "SELECT id; DROP TABLE events",
            "SELECT id UNION ALL SELECT id",
            "SELECT id SETTINGS max_threads = 1",
            "SELECT id /* hidden */ ORDER BY id",
            "WITH id AS value SELECT value",
        ] {
            assert_eq!(
                validate_projection_query(query).unwrap_err().code,
                ErrorCode::ValidationFailed,
                "{query}"
            );
        }
    }

    #[test]
    fn projection_create_and_actions_require_editable_exact_objects() {
        let mut baseline = fixture_schema();
        let create = ClickHouseProjectionCreateTarget {
            baseline: baseline.clone(),
            projection: ClickHouseProjectionTarget {
                name: "new_projection".to_string(),
                query: "SELECT id ORDER BY id".to_string(),
            },
        };
        validate_projection_create_target(&create).expect("new projection");

        let duplicate = ClickHouseProjectionCreateTarget {
            baseline: baseline.clone(),
            projection: ClickHouseProjectionTarget {
                name: baseline.projections[0].name.clone(),
                query: "SELECT id".to_string(),
            },
        };
        assert_eq!(
            validate_projection_create_target(&duplicate)
                .unwrap_err()
                .code,
            ErrorCode::ValidationFailed
        );

        let action = ClickHouseProjectionActionTarget {
            baseline: baseline.clone(),
            projection_name: baseline.projections[0].name.clone(),
        };
        for operation in [
            SchemaMutationOperation::Drop,
            SchemaMutationOperation::Clear,
            SchemaMutationOperation::Materialize,
        ] {
            validate_projection_action_target(&action, operation).expect("supported action");
        }
        assert_eq!(
            validate_projection_action_target(&action, SchemaMutationOperation::Alter)
                .unwrap_err()
                .code,
            ErrorCode::ValidationFailed
        );

        baseline.projections[0].editability.mode =
            crate::engine::drivers::clickhouse::schema::ClickHouseSchemaEditabilityMode::Readonly;
        let readonly = ClickHouseProjectionActionTarget {
            projection_name: baseline.projections[0].name.clone(),
            baseline,
        };
        assert_eq!(
            validate_projection_action_target(&readonly, SchemaMutationOperation::Drop)
                .unwrap_err()
                .code,
            ErrorCode::ValidationFailed
        );
    }
}
