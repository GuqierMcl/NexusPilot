#![allow(dead_code)]

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::engine::native_schema::{
    NativeSchemaChangeBaseline, NativeSchemaChangePlan, NativeSchemaChangeTarget,
    NativeSchemaOperationSummary, NativeSchemaRequiredConfirmation, NativeSchemaRiskFlag,
};
use crate::engine::types::SchemaMutationOperation;
use crate::error::{IpcError, IpcResult};

use super::create_render::{plan_hash, quote_identifier};
use super::projection_validate::{
    validate_projection_action_target, validate_projection_create_target,
};
use super::skipping_index_validate::{
    validate_skipping_index_action_target, validate_skipping_index_create_target,
};

const PROJECTION_PLAN_DOMAIN: &str = "nexpilot/native-schema/clickhouse/projection-change/v1";
const PROJECTION_TARGET_REVISION_DOMAIN: &[u8] = b"nexpilot.clickhouse.projection-target.v1\0";
const SKIPPING_INDEX_PLAN_DOMAIN: &[u8] = b"nexpilot.clickhouse.skipping-index-change.v1\0";
const SKIPPING_INDEX_TARGET_REVISION_DOMAIN: &[u8] =
    b"nexpilot.clickhouse.skipping-index-target.v1\0";

pub(super) fn plan_projection_change(
    target: &NativeSchemaChangeTarget,
) -> IpcResult<NativeSchemaChangePlan> {
    let (baseline, statement, code, object_name, operation, destructive, long_running) =
        match target {
            NativeSchemaChangeTarget::ClickHouseProjectionCreate(target) => {
                validate_projection_create_target(target)?;
                (
                    &target.baseline,
                    format!(
                        "ALTER TABLE {} ADD PROJECTION {} ({})",
                        qualified_table_name(
                            &target.baseline.identity.database,
                            &target.baseline.identity.name,
                        ),
                        quote_identifier(&target.projection.name),
                        target.projection.query.trim(),
                    ),
                    "projection.create",
                    target.projection.name.as_str(),
                    SchemaMutationOperation::Create,
                    false,
                    false,
                )
            }
            NativeSchemaChangeTarget::ClickHouseProjectionDrop(target) => {
                validate_projection_action_target(target, SchemaMutationOperation::Drop)?;
                (
                    &target.baseline,
                    format!(
                        "ALTER TABLE {} DROP PROJECTION {}",
                        qualified_table_name(
                            &target.baseline.identity.database,
                            &target.baseline.identity.name,
                        ),
                        quote_identifier(&target.projection_name),
                    ),
                    "projection.drop",
                    target.projection_name.as_str(),
                    SchemaMutationOperation::Drop,
                    true,
                    true,
                )
            }
            NativeSchemaChangeTarget::ClickHouseProjectionMaterialize(target) => {
                validate_projection_action_target(target, SchemaMutationOperation::Materialize)?;
                (
                    &target.baseline,
                    format!(
                        "ALTER TABLE {} MATERIALIZE PROJECTION {}",
                        qualified_table_name(
                            &target.baseline.identity.database,
                            &target.baseline.identity.name,
                        ),
                        quote_identifier(&target.projection_name),
                    ),
                    "projection.materialize",
                    target.projection_name.as_str(),
                    SchemaMutationOperation::Materialize,
                    true,
                    true,
                )
            }
            NativeSchemaChangeTarget::ClickHouseProjectionClear(target) => {
                validate_projection_action_target(target, SchemaMutationOperation::Clear)?;
                (
                    &target.baseline,
                    format!(
                        "ALTER TABLE {} CLEAR PROJECTION {}",
                        qualified_table_name(
                            &target.baseline.identity.database,
                            &target.baseline.identity.name,
                        ),
                        quote_identifier(&target.projection_name),
                    ),
                    "projection.clear",
                    target.projection_name.as_str(),
                    SchemaMutationOperation::Clear,
                    true,
                    true,
                )
            }
            _ => {
                return Err(IpcError::validation_failed(
                    "ClickHouse projection planner requires a projection target",
                ))
            }
        };

    let statements = vec![statement];
    Ok(NativeSchemaChangePlan {
        plan_hash: plan_hash(PROJECTION_PLAN_DOMAIN, &statements),
        statements,
        warnings: Vec::new(),
        destructive,
        long_running,
        risk_flags: object_risk_flags(destructive, long_running, operation),
        required_confirmation: required_confirmation(destructive),
        expected_target_revision: projection_target_revision(target, operation)?,
        operations: vec![NativeSchemaOperationSummary {
            code: code.to_string(),
            object_name: object_name.to_string(),
            destructive,
            long_running,
        }],
        baseline: NativeSchemaChangeBaseline::ClickHouseTable(Box::new(baseline.clone())),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionTargetRevision<'a> {
    database: &'a str,
    table: &'a str,
    operation: SchemaMutationOperation,
    projection_name: &'a str,
    query: Option<&'a str>,
}

fn projection_target_revision(
    target: &NativeSchemaChangeTarget,
    operation: SchemaMutationOperation,
) -> IpcResult<Option<String>> {
    let revision = match target {
        NativeSchemaChangeTarget::ClickHouseProjectionCreate(target) => ProjectionTargetRevision {
            database: &target.baseline.identity.database,
            table: &target.baseline.identity.name,
            operation,
            projection_name: &target.projection.name,
            query: Some(target.projection.query.trim()),
        },
        NativeSchemaChangeTarget::ClickHouseProjectionDrop(target) => ProjectionTargetRevision {
            database: &target.baseline.identity.database,
            table: &target.baseline.identity.name,
            operation,
            projection_name: &target.projection_name,
            query: None,
        },
        NativeSchemaChangeTarget::ClickHouseProjectionMaterialize(_)
        | NativeSchemaChangeTarget::ClickHouseProjectionClear(_) => return Ok(None),
        _ => {
            return Err(IpcError::validation_failed(
                "ClickHouse projection target revision requires a projection target",
            ))
        }
    };
    let serialized = serde_json::to_vec(&revision).map_err(|error| {
        IpcError::system_internal(
            "Failed to serialize the ClickHouse projection target revision",
            format!("category=projection_target_serialization; error={error}"),
        )
    })?;
    let mut digest = Sha256::new();
    digest.update(PROJECTION_TARGET_REVISION_DOMAIN);
    digest.update(serialized);
    Ok(Some(format!("{:x}", digest.finalize())))
}

pub(super) fn plan_skipping_index_change(
    target: &NativeSchemaChangeTarget,
) -> IpcResult<NativeSchemaChangePlan> {
    let (baseline, statement, code, object_name, operation, destructive, long_running) =
        match target {
            NativeSchemaChangeTarget::ClickHouseSkippingIndexCreate(target) => {
                validate_skipping_index_create_target(target)?;
                let index_type = target.index.index_type.to_ascii_lowercase();
                let arguments =
                    canonical_skipping_index_arguments(&index_type, &target.index.type_arguments)?;
                let rendered_type = if arguments.is_empty() {
                    index_type
                } else {
                    format!("{}({})", index_type, arguments.join(", "))
                };
                (
                    &target.baseline,
                    format!(
                        "ALTER TABLE {} ADD INDEX {} {} TYPE {} GRANULARITY {}",
                        qualified_table_name(
                            &target.baseline.identity.database,
                            &target.baseline.identity.name,
                        ),
                        quote_identifier(&target.index.name),
                        target.index.expression.trim(),
                        rendered_type,
                        target.index.granularity,
                    ),
                    "skipping_index.create",
                    target.index.name.as_str(),
                    SchemaMutationOperation::Create,
                    false,
                    false,
                )
            }
            NativeSchemaChangeTarget::ClickHouseSkippingIndexDrop(target) => {
                validate_skipping_index_action_target(target, SchemaMutationOperation::Drop)?;
                (
                    &target.baseline,
                    format!(
                        "ALTER TABLE {} DROP INDEX {}",
                        qualified_table_name(
                            &target.baseline.identity.database,
                            &target.baseline.identity.name,
                        ),
                        quote_identifier(&target.index_name),
                    ),
                    "skipping_index.drop",
                    target.index_name.as_str(),
                    SchemaMutationOperation::Drop,
                    true,
                    true,
                )
            }
            NativeSchemaChangeTarget::ClickHouseSkippingIndexMaterialize(target) => {
                validate_skipping_index_action_target(
                    target,
                    SchemaMutationOperation::Materialize,
                )?;
                (
                    &target.baseline,
                    format!(
                        "ALTER TABLE {} MATERIALIZE INDEX {}",
                        qualified_table_name(
                            &target.baseline.identity.database,
                            &target.baseline.identity.name,
                        ),
                        quote_identifier(&target.index_name),
                    ),
                    "skipping_index.materialize",
                    target.index_name.as_str(),
                    SchemaMutationOperation::Materialize,
                    true,
                    true,
                )
            }
            NativeSchemaChangeTarget::ClickHouseSkippingIndexClear(target) => {
                validate_skipping_index_action_target(target, SchemaMutationOperation::Clear)?;
                (
                    &target.baseline,
                    format!(
                        "ALTER TABLE {} CLEAR INDEX {}",
                        qualified_table_name(
                            &target.baseline.identity.database,
                            &target.baseline.identity.name,
                        ),
                        quote_identifier(&target.index_name),
                    ),
                    "skipping_index.clear",
                    target.index_name.as_str(),
                    SchemaMutationOperation::Clear,
                    true,
                    true,
                )
            }
            _ => {
                return Err(IpcError::validation_failed(
                    "ClickHouse skipping-index planner requires a skipping-index target",
                ))
            }
        };

    let statements = vec![statement];
    Ok(NativeSchemaChangePlan {
        plan_hash: skipping_index_plan_hash(&statements),
        statements,
        warnings: Vec::new(),
        destructive,
        long_running,
        risk_flags: object_risk_flags(destructive, long_running, operation),
        required_confirmation: required_confirmation(destructive),
        expected_target_revision: skipping_index_target_revision(target, operation)?,
        operations: vec![NativeSchemaOperationSummary {
            code: code.to_string(),
            object_name: object_name.to_string(),
            destructive,
            long_running,
        }],
        baseline: NativeSchemaChangeBaseline::ClickHouseTable(Box::new(baseline.clone())),
    })
}

fn object_risk_flags(
    destructive: bool,
    long_running: bool,
    operation: SchemaMutationOperation,
) -> Vec<NativeSchemaRiskFlag> {
    let mut flags = Vec::new();
    if destructive {
        flags.push(NativeSchemaRiskFlag::Destructive);
    }
    if long_running {
        flags.push(NativeSchemaRiskFlag::LongRunning);
    }
    if matches!(
        operation,
        SchemaMutationOperation::Clear | SchemaMutationOperation::Materialize
    ) {
        flags.push(NativeSchemaRiskFlag::BackgroundWork);
    }
    flags
}

fn required_confirmation(destructive: bool) -> NativeSchemaRequiredConfirmation {
    if destructive {
        NativeSchemaRequiredConfirmation::Confirm
    } else {
        NativeSchemaRequiredConfirmation::None
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SkippingIndexTargetRevision<'a> {
    database: &'a str,
    table: &'a str,
    operation: SchemaMutationOperation,
    index_name: &'a str,
    definition: Option<SkippingIndexRevisionDefinition<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SkippingIndexRevisionDefinition<'a> {
    expression: &'a str,
    index_type: String,
    type_arguments: Vec<String>,
    granularity: u64,
}

fn skipping_index_target_revision(
    target: &NativeSchemaChangeTarget,
    operation: SchemaMutationOperation,
) -> IpcResult<Option<String>> {
    let revision = match target {
        NativeSchemaChangeTarget::ClickHouseSkippingIndexCreate(target) => {
            let index_type = target.index.index_type.to_ascii_lowercase();
            SkippingIndexTargetRevision {
                database: &target.baseline.identity.database,
                table: &target.baseline.identity.name,
                operation,
                index_name: &target.index.name,
                definition: Some(SkippingIndexRevisionDefinition {
                    expression: target.index.expression.trim(),
                    type_arguments: canonical_skipping_index_arguments(
                        &index_type,
                        &target.index.type_arguments,
                    )?,
                    index_type,
                    granularity: target.index.granularity,
                }),
            }
        }
        NativeSchemaChangeTarget::ClickHouseSkippingIndexDrop(target) => {
            SkippingIndexTargetRevision {
                database: &target.baseline.identity.database,
                table: &target.baseline.identity.name,
                operation,
                index_name: &target.index_name,
                definition: None,
            }
        }
        NativeSchemaChangeTarget::ClickHouseSkippingIndexMaterialize(_)
        | NativeSchemaChangeTarget::ClickHouseSkippingIndexClear(_) => return Ok(None),
        _ => {
            return Err(IpcError::validation_failed(
                "ClickHouse skipping-index target revision requires a skipping-index target",
            ))
        }
    };
    let serialized = serde_json::to_vec(&revision).map_err(|error| {
        IpcError::system_internal(
            "Failed to serialize the ClickHouse skipping-index target revision",
            format!("category=skipping_index_target_serialization; error={error}"),
        )
    })?;
    let mut digest = Sha256::new();
    digest.update(SKIPPING_INDEX_TARGET_REVISION_DOMAIN);
    digest.update(serialized);
    Ok(Some(format!("{:x}", digest.finalize())))
}

fn canonical_skipping_index_arguments(
    index_type: &str,
    arguments: &[String],
) -> IpcResult<Vec<String>> {
    if index_type == "bloom_filter" {
        return arguments
            .iter()
            .map(|argument| {
                argument
                    .parse::<f64>()
                    .map(|value| value.to_string())
                    .map_err(|_| {
                        IpcError::validation_failed(
                            "ClickHouse bloom_filter argument must be a finite number",
                        )
                    })
            })
            .collect();
    }
    arguments
        .iter()
        .map(|argument| {
            argument
                .parse::<u64>()
                .map(|value| value.to_string())
                .map_err(|_| {
                    IpcError::validation_failed(
                        "ClickHouse skipping-index argument must be an unsigned integer",
                    )
                })
        })
        .collect()
}

fn skipping_index_plan_hash(statements: &[String]) -> String {
    let mut digest = Sha256::new();
    digest.update(SKIPPING_INDEX_PLAN_DOMAIN);
    for statement in statements {
        digest.update(statement.as_bytes());
        digest.update([0]);
    }
    format!("{:x}", digest.finalize())
}

fn qualified_table_name(database: &str, table: &str) -> String {
    format!("{}.{}", quote_identifier(database), quote_identifier(table))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::engine::drivers::clickhouse::schema::{
        types::fixture_schema, ClickHouseProjectionActionTarget, ClickHouseProjectionCreateTarget,
        ClickHouseProjectionTarget, ClickHouseSkippingIndexActionTarget,
        ClickHouseSkippingIndexCreateTarget, ClickHouseSkippingIndexTarget,
    };
    use crate::engine::native_schema::{NativeSchemaChangeBaseline, NativeSchemaChangeTarget};

    fn create_target() -> NativeSchemaChangeTarget {
        NativeSchemaChangeTarget::ClickHouseProjectionCreate(Box::new(
            ClickHouseProjectionCreateTarget {
                baseline: fixture_schema(),
                projection: ClickHouseProjectionTarget {
                    name: "by_tenant".to_string(),
                    query: "SELECT tenant_id, count() GROUP BY tenant_id".to_string(),
                },
            },
        ))
    }

    fn action_target(operation: &str) -> NativeSchemaChangeTarget {
        let target = Box::new(ClickHouseProjectionActionTarget {
            baseline: fixture_schema(),
            projection_name: "a_projection".to_string(),
        });
        match operation {
            "drop" => NativeSchemaChangeTarget::ClickHouseProjectionDrop(target),
            "materialize" => NativeSchemaChangeTarget::ClickHouseProjectionMaterialize(target),
            "clear" => NativeSchemaChangeTarget::ClickHouseProjectionClear(target),
            _ => unreachable!("unsupported fixture operation"),
        }
    }

    #[test]
    fn projection_plans_are_exact_and_domain_separated() {
        let cases = [
            (
                create_target(),
                "ALTER TABLE `analytics`.`events` ADD PROJECTION `by_tenant` (SELECT tenant_id, count() GROUP BY tenant_id)",
                "projection.create",
                false,
                false,
                true,
            ),
            (
                action_target("drop"),
                "ALTER TABLE `analytics`.`events` DROP PROJECTION `a_projection`",
                "projection.drop",
                true,
                true,
                true,
            ),
            (
                action_target("materialize"),
                "ALTER TABLE `analytics`.`events` MATERIALIZE PROJECTION `a_projection`",
                "projection.materialize",
                true,
                true,
                false,
            ),
            (
                action_target("clear"),
                "ALTER TABLE `analytics`.`events` CLEAR PROJECTION `a_projection`",
                "projection.clear",
                true,
                true,
                false,
            ),
        ];

        let mut hashes = std::collections::BTreeSet::new();
        for (target, statement, code, destructive, long_running, has_revision) in cases {
            let plan = plan_projection_change(&target).expect("plan projection change");
            assert_eq!(plan.statements, [statement]);
            assert_eq!(plan.operations.len(), 1);
            assert_eq!(plan.operations[0].code, code);
            assert_eq!(plan.operations[0].object_name, target_object_name(&target));
            assert_eq!(plan.destructive, destructive);
            assert_eq!(plan.long_running, long_running);
            assert_eq!(plan.expected_target_revision.is_some(), has_revision);
            assert_eq!(plan.plan_hash.len(), 64);
            assert!(plan
                .plan_hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')));
            assert!(hashes.insert(plan.plan_hash));
            assert!(matches!(
                plan.baseline,
                NativeSchemaChangeBaseline::ClickHouseTable(_)
            ));
        }
    }

    fn target_object_name(target: &NativeSchemaChangeTarget) -> &str {
        match target {
            NativeSchemaChangeTarget::ClickHouseProjectionCreate(target) => &target.projection.name,
            NativeSchemaChangeTarget::ClickHouseProjectionDrop(target)
            | NativeSchemaChangeTarget::ClickHouseProjectionMaterialize(target)
            | NativeSchemaChangeTarget::ClickHouseProjectionClear(target) => {
                &target.projection_name
            }
            _ => unreachable!("projection fixture target"),
        }
    }

    #[test]
    fn projection_plan_changes_with_typed_target_not_warning_text() {
        let first = plan_projection_change(&create_target()).unwrap();
        let mut changed = create_target();
        let NativeSchemaChangeTarget::ClickHouseProjectionCreate(target) = &mut changed else {
            unreachable!()
        };
        target.projection.query = "SELECT tenant_id ORDER BY tenant_id".to_string();
        let second = plan_projection_change(&changed).unwrap();

        assert_ne!(first.plan_hash, second.plan_hash);
        assert_ne!(
            first.expected_target_revision,
            second.expected_target_revision
        );
    }

    fn skipping_index_create_target(
        index_type: &str,
        type_arguments: &[&str],
    ) -> NativeSchemaChangeTarget {
        NativeSchemaChangeTarget::ClickHouseSkippingIndexCreate(Box::new(
            ClickHouseSkippingIndexCreateTarget {
                baseline: fixture_schema(),
                index: ClickHouseSkippingIndexTarget {
                    name: "payload_bf".to_string(),
                    expression: "payload".to_string(),
                    index_type: index_type.to_string(),
                    type_arguments: type_arguments
                        .iter()
                        .map(|argument| (*argument).to_string())
                        .collect(),
                    granularity: 1,
                },
            },
        ))
    }

    fn skipping_index_action_target(operation: &str) -> NativeSchemaChangeTarget {
        let target = Box::new(ClickHouseSkippingIndexActionTarget {
            baseline: fixture_schema(),
            index_name: "a_index".to_string(),
        });
        match operation {
            "drop" => NativeSchemaChangeTarget::ClickHouseSkippingIndexDrop(target),
            "materialize" => NativeSchemaChangeTarget::ClickHouseSkippingIndexMaterialize(target),
            "clear" => NativeSchemaChangeTarget::ClickHouseSkippingIndexClear(target),
            _ => unreachable!("unsupported fixture operation"),
        }
    }

    #[test]
    fn skipping_index_plans_are_exact_and_domain_separated() {
        let create_cases = [
            ("minmax", vec![], "TYPE minmax"),
            ("set", vec!["100"], "TYPE set(100)"),
            ("bloom_filter", vec!["0.01"], "TYPE bloom_filter(0.01)"),
            (
                "ngrambf_v1",
                vec!["3", "256", "2", "0"],
                "TYPE ngrambf_v1(3, 256, 2, 0)",
            ),
            (
                "tokenbf_v1",
                vec!["256", "2", "0"],
                "TYPE tokenbf_v1(256, 2, 0)",
            ),
        ];

        let mut hashes = std::collections::BTreeSet::new();
        let mut revisions = std::collections::BTreeSet::new();
        for (index_type, arguments, rendered_type) in create_cases {
            let target = skipping_index_create_target(index_type, &arguments);
            let plan = plan_skipping_index_change(&target).expect("plan index create");
            assert_eq!(
                plan.statements,
                [format!(
                    "ALTER TABLE `analytics`.`events` ADD INDEX `payload_bf` payload {rendered_type} GRANULARITY 1"
                )]
            );
            assert_eq!(plan.operations[0].code, "skipping_index.create");
            assert_eq!(plan.operations[0].object_name, "payload_bf");
            assert!(!plan.destructive);
            assert!(!plan.long_running);
            assert!(hashes.insert(plan.plan_hash));
            assert!(revisions.insert(
                plan.expected_target_revision
                    .expect("create target revision")
            ));
        }

        for (operation, statement, code) in [
            (
                "drop",
                "ALTER TABLE `analytics`.`events` DROP INDEX `a_index`",
                "skipping_index.drop",
            ),
            (
                "materialize",
                "ALTER TABLE `analytics`.`events` MATERIALIZE INDEX `a_index`",
                "skipping_index.materialize",
            ),
            (
                "clear",
                "ALTER TABLE `analytics`.`events` CLEAR INDEX `a_index`",
                "skipping_index.clear",
            ),
        ] {
            let plan = plan_skipping_index_change(&skipping_index_action_target(operation))
                .expect("plan index action");
            assert_eq!(plan.statements, [statement]);
            assert_eq!(plan.operations[0].code, code);
            assert_eq!(plan.operations[0].object_name, "a_index");
            assert!(plan.destructive);
            assert!(plan.long_running);
            assert_eq!(plan.expected_target_revision.is_some(), operation == "drop");
            assert!(hashes.insert(plan.plan_hash));
        }

        for statement in hashes {
            assert_eq!(statement.len(), 64);
        }
        let all_statements = [
            plan_skipping_index_change(&skipping_index_create_target("minmax", &[])).unwrap(),
            plan_skipping_index_change(&skipping_index_action_target("drop")).unwrap(),
            plan_skipping_index_change(&skipping_index_action_target("materialize")).unwrap(),
            plan_skipping_index_change(&skipping_index_action_target("clear")).unwrap(),
        ]
        .into_iter()
        .flat_map(|plan| plan.statements)
        .collect::<Vec<_>>()
        .join("\n");
        assert!(!all_statements.contains("IF EXISTS"));
        assert!(!all_statements.contains("IF NOT EXISTS"));
        assert!(!all_statements.contains("IN PARTITION"));
    }
}
