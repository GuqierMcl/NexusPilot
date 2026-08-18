use std::collections::BTreeMap;

use oracle_rs::{Row, Value};

use crate::engine::types::{
    ContainerKind, ContainerRef, TableColumnSchema, TableConstraintKind, TableConstraintSchema,
    TableForeignKeyReference, TableGeneratedColumn, TableGeneratedColumnStorage,
    TableIdentityGeneration, TableIdentityOptions, TableIndexSchema, TablePartitionOptions,
    TableSchema, TableSchemaBasics,
};
use crate::error::{IpcError, IpcResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OracleTableDesignMetadata {
    pub database: String,
    pub owner: String,
    pub table: String,
    pub table_comment: Option<String>,
    pub columns: Vec<OracleTableDesignColumn>,
    pub indexes: Vec<OracleTableDesignIndex>,
    pub constraints: Vec<OracleTableDesignConstraint>,
    pub partition_description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OracleTableDesignColumn {
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub comment: Option<String>,
    pub primary_key_position: Option<i32>,
    pub unique_column: bool,
    pub identity_generation: Option<TableIdentityGeneration>,
    pub generated_expression: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OracleTableDesignIndex {
    pub name: String,
    pub columns: Vec<String>,
    pub is_unique: bool,
    pub constraint_backed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OracleTableDesignConstraint {
    pub name: String,
    pub kind: TableConstraintKind,
    pub columns: Vec<String>,
    pub expression: Option<String>,
    pub foreign_key: Option<TableForeignKeyReference>,
    pub enforced: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OracleTableDesignComments {
    pub table_comment: Option<String>,
    pub partition_description: Option<String>,
}

pub(crate) fn oracle_table_design_columns_sql() -> &'static str {
    "SELECT \
        c.column_name, c.data_type, c.nullable, c.data_default_vc, \
        c.data_length, c.data_precision, c.data_scale, \
        c.identity_column, COALESCE(tc.virtual_column, 'NO') AS virtual_column, \
        ic.generation_type, cc.comments \
     FROM all_tab_columns c \
     LEFT JOIN all_tab_cols tc \
       ON tc.owner = c.owner \
      AND tc.table_name = c.table_name \
      AND tc.column_name = c.column_name \
     LEFT JOIN all_tab_identity_cols ic \
       ON ic.owner = c.owner \
      AND ic.table_name = c.table_name \
      AND ic.column_name = c.column_name \
     LEFT JOIN all_col_comments cc \
       ON cc.owner = c.owner \
      AND cc.table_name = c.table_name \
      AND cc.column_name = c.column_name \
     WHERE c.owner = :1 \
       AND c.table_name = :2 \
     ORDER BY c.column_id"
}

pub(crate) fn oracle_table_design_constraints_sql() -> &'static str {
    "SELECT \
        cons.constraint_name, cons.constraint_type, cc.column_name, cc.position, \
        cons.search_condition_vc, cons.r_owner, rcc.table_name AS r_table_name, \
        rcc.column_name AS r_column_name, cons.delete_rule, cons.status, cons.generated \
     FROM all_constraints cons \
     LEFT JOIN all_cons_columns cc \
       ON cc.owner = cons.owner \
      AND cc.constraint_name = cons.constraint_name \
      AND cc.table_name = cons.table_name \
     LEFT JOIN all_constraints rcons \
       ON rcons.owner = cons.r_owner \
      AND rcons.constraint_name = cons.r_constraint_name \
     LEFT JOIN all_cons_columns rcc \
       ON rcc.owner = rcons.owner \
      AND rcc.constraint_name = rcons.constraint_name \
      AND rcc.position = cc.position \
     WHERE cons.owner = :1 \
       AND cons.table_name = :2 \
       AND cons.constraint_type IN ('P', 'U', 'R', 'C') \
     ORDER BY cons.constraint_name, cc.position"
}

pub(crate) fn oracle_table_design_indexes_sql() -> &'static str {
    "SELECT \
        i.index_name, ic.column_name, ic.column_position, i.uniqueness, \
        CASE WHEN cons.constraint_name IS NOT NULL THEN 'Y' ELSE 'N' END AS constraint_backed \
     FROM all_indexes i \
     JOIN all_ind_columns ic \
       ON ic.index_owner = i.owner \
      AND ic.index_name = i.index_name \
      AND ic.table_owner = i.table_owner \
      AND ic.table_name = i.table_name \
     LEFT JOIN all_constraints cons \
       ON cons.owner = i.owner \
      AND cons.index_name = i.index_name \
      AND cons.constraint_type IN ('P', 'U') \
     WHERE i.table_owner = :1 \
       AND i.table_name = :2 \
     ORDER BY i.index_name, ic.column_position"
}

pub(crate) fn oracle_table_design_comments_sql() -> &'static str {
    "SELECT \
        tc.comments, pt.partitioning_type, pt.subpartitioning_type, pt.partition_count \
     FROM all_tab_comments tc \
     LEFT JOIN all_part_tables pt \
       ON pt.owner = tc.owner \
      AND pt.table_name = tc.table_name \
     WHERE tc.owner = :1 \
       AND tc.table_name = :2"
}

pub(crate) fn oracle_describe_table_parts(
    container: &ContainerRef,
) -> IpcResult<(String, String, String)> {
    if container.kind != ContainerKind::Table {
        return Err(IpcError::resource_not_found(
            "Oracle Table Designer only supports ordinary tables",
        ));
    }

    let database = container
        .database
        .as_deref()
        .unwrap_or("oracle")
        .trim()
        .to_string();
    let schema = container
        .schema
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| IpcError::resource_not_found("Oracle schema context is missing"))?
        .to_string();
    let table = container
        .table
        .as_deref()
        .or(container.object_name.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| IpcError::resource_not_found("Oracle table context is missing"))?
        .to_string();

    Ok((database, schema, table))
}

pub(crate) fn table_schema_from_oracle_metadata(
    metadata: OracleTableDesignMetadata,
) -> TableSchema {
    let unique_columns = metadata
        .constraints
        .iter()
        .filter(|constraint| {
            matches!(
                constraint.kind,
                TableConstraintKind::PrimaryKey | TableConstraintKind::Unique
            )
        })
        .flat_map(|constraint| constraint.columns.iter().cloned())
        .collect::<Vec<_>>();
    let primary_key_columns = metadata
        .constraints
        .iter()
        .find(|constraint| constraint.kind == TableConstraintKind::PrimaryKey)
        .map(|constraint| constraint.columns.clone())
        .unwrap_or_else(|| {
            let mut columns = metadata
                .columns
                .iter()
                .filter_map(|column| {
                    column
                        .primary_key_position
                        .map(|position| (position, column.name.clone()))
                })
                .collect::<Vec<_>>();
            columns.sort_by_key(|(position, _)| *position);
            columns.into_iter().map(|(_, column)| column).collect()
        });

    let columns = metadata
        .columns
        .into_iter()
        .map(|column| {
            let column_name = column.name;
            let identity = column
                .identity_generation
                .map(|generation| TableIdentityOptions {
                    generation,
                    start: None,
                    increment: None,
                    min_value: None,
                    max_value: None,
                    cache: None,
                    cycle: false,
                });
            let generated = column
                .generated_expression
                .filter(|expression| !expression.trim().is_empty())
                .map(|expression| TableGeneratedColumn {
                    expression: expression.trim().to_string(),
                    storage: TableGeneratedColumnStorage::Virtual,
                });
            let is_primary_key = column.primary_key_position.is_some()
                || primary_key_columns
                    .iter()
                    .any(|primary_key| primary_key == &column_name);
            let is_unique = column.unique_column
                || is_primary_key
                || unique_columns.iter().any(|unique| unique == &column_name);
            TableColumnSchema {
                name: column_name,
                type_name: column.type_name,
                nullable: column.nullable,
                default_value: column
                    .default_value
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                is_primary_key,
                is_unique,
                is_identity: identity.is_some(),
                comment: column.comment,
                identity,
                generated,
                charset: None,
                collation: None,
            }
        })
        .collect::<Vec<_>>();

    let indexes = metadata
        .indexes
        .into_iter()
        .filter(|index| !index.constraint_backed)
        .map(|index| TableIndexSchema {
            name: index.name,
            columns: index.columns,
            is_unique: index.is_unique,
            method: None,
            comment: None,
        })
        .collect::<Vec<_>>();

    let partition = metadata
        .partition_description
        .filter(|description| !description.trim().is_empty())
        .map(|description| TablePartitionOptions {
            expression: None,
            raw_clause: None,
            readonly_description: Some(description),
        });

    TableSchema {
        basics: TableSchemaBasics {
            table_name: metadata.table,
            database_name: metadata.database,
            schema_name: metadata.owner,
            engine: None,
            charset: None,
            collation: None,
            comment: metadata.table_comment,
            partition,
        },
        columns,
        indexes,
        constraints: metadata
            .constraints
            .into_iter()
            .map(|constraint| TableConstraintSchema {
                name: constraint.name,
                kind: constraint.kind,
                columns: constraint.columns,
                reference: None,
                expression: constraint.expression,
                comment: None,
                foreign_key: constraint.foreign_key,
                enforced: constraint.enforced,
            })
            .collect(),
    }
}

pub(crate) fn oracle_table_schema_matches_update_baseline(
    current: &TableSchema,
    baseline: &TableSchema,
) -> bool {
    let mut current = current.clone();
    let mut baseline = baseline.clone();
    normalize_oracle_schema_for_update_drift_check(&mut current);
    normalize_oracle_schema_for_update_drift_check(&mut baseline);
    current == baseline
}

fn normalize_oracle_schema_for_update_drift_check(schema: &mut TableSchema) {
    for constraint in &mut schema.constraints {
        if matches!(
            constraint.kind,
            TableConstraintKind::PrimaryKey | TableConstraintKind::Unique
        ) && constraint.enforced == Some(true)
        {
            constraint.enforced = None;
        }
    }
}

pub(crate) fn oracle_columns_from_rows(rows: &[Row]) -> Vec<OracleTableDesignColumn> {
    rows.iter()
        .filter_map(oracle_column_from_row)
        .collect::<Vec<_>>()
}

pub(crate) fn oracle_constraints_from_rows(rows: &[Row]) -> Vec<OracleTableDesignConstraint> {
    let mut grouped = BTreeMap::<String, Vec<&Row>>::new();
    for row in rows {
        if let Some(name) = row_string(row, 0) {
            grouped.entry(name).or_default().push(row);
        }
    }

    grouped
        .into_values()
        .filter_map(|rows| oracle_constraint_from_rows(&rows))
        .collect()
}

pub(crate) fn oracle_indexes_from_rows(rows: &[Row]) -> Vec<OracleTableDesignIndex> {
    let mut grouped = BTreeMap::<String, Vec<&Row>>::new();
    for row in rows {
        if let Some(name) = row_string(row, 0) {
            grouped.entry(name).or_default().push(row);
        }
    }

    grouped
        .into_iter()
        .map(|(name, rows)| {
            let mut columns = rows
                .iter()
                .filter_map(|row| Some((row_i32(row, 2).unwrap_or(0), row_string(row, 1)?)))
                .collect::<Vec<_>>();
            columns.sort_by_key(|(position, _)| *position);
            OracleTableDesignIndex {
                name,
                columns: columns.into_iter().map(|(_, column)| column).collect(),
                is_unique: rows
                    .first()
                    .and_then(|row| row_string(row, 3))
                    .map(|value| value.eq_ignore_ascii_case("UNIQUE"))
                    .unwrap_or(false),
                constraint_backed: rows
                    .first()
                    .and_then(|row| row_string(row, 4))
                    .map(|value| value.eq_ignore_ascii_case("Y"))
                    .unwrap_or(false),
            }
        })
        .collect()
}

pub(crate) fn oracle_comments_from_rows(rows: &[Row]) -> OracleTableDesignComments {
    let Some(row) = rows.first() else {
        return OracleTableDesignComments {
            table_comment: None,
            partition_description: None,
        };
    };

    let partitioning_type = row_string(row, 1);
    let subpartitioning_type = row_string(row, 2);
    let partition_count = row_i64(row, 3);
    let partition_description = partitioning_type.map(|partitioning_type| {
        let mut description = format!("PARTITION BY {partitioning_type}");
        if let Some(subpartitioning_type) = subpartitioning_type {
            description.push_str(&format!(" SUBPARTITION BY {subpartitioning_type}"));
        }
        if let Some(partition_count) = partition_count {
            description.push_str(&format!(" PARTITIONS {partition_count}"));
        }
        description
    });

    OracleTableDesignComments {
        table_comment: row_string(row, 0),
        partition_description,
    }
}

fn oracle_column_from_row(row: &Row) -> Option<OracleTableDesignColumn> {
    let data_type = row_string(row, 1)?;
    let type_name = oracle_type_name(
        &data_type,
        row_i64(row, 4),
        row_i32(row, 5),
        row_i32(row, 6),
    );
    let default_value = row_string(row, 3);
    let is_virtual = row_bool_yes(row, 8);
    let identity_generation = row_string(row, 9).and_then(|generation| {
        if generation.to_ascii_uppercase().contains("ALWAYS") {
            Some(TableIdentityGeneration::Always)
        } else if generation.to_ascii_uppercase().contains("BY DEFAULT") {
            Some(TableIdentityGeneration::ByDefault)
        } else {
            None
        }
    });

    Some(OracleTableDesignColumn {
        name: row_string(row, 0)?,
        type_name,
        nullable: row_string(row, 2)
            .map(|value| value.eq_ignore_ascii_case("Y"))
            .unwrap_or(true),
        default_value: if is_virtual {
            None
        } else {
            default_value.clone()
        },
        comment: row_string(row, 10),
        primary_key_position: None,
        unique_column: false,
        identity_generation,
        generated_expression: is_virtual.then_some(default_value).flatten(),
    })
}

fn oracle_constraint_from_rows(rows: &[&Row]) -> Option<OracleTableDesignConstraint> {
    let first = rows.first()?;
    let name = row_string(first, 0)?;
    let constraint_type = row_string(first, 1)?;
    let kind = match constraint_type.as_str() {
        "P" => TableConstraintKind::PrimaryKey,
        "U" => TableConstraintKind::Unique,
        "R" => TableConstraintKind::ForeignKey,
        "C" => TableConstraintKind::Check,
        _ => return None,
    };
    if kind == TableConstraintKind::Check && is_generated_not_null_check(first) {
        return None;
    }

    let mut local_columns = rows
        .iter()
        .filter_map(|row| Some((row_i32(row, 3).unwrap_or(0), row_string(row, 2)?)))
        .collect::<Vec<_>>();
    local_columns.sort_by_key(|(position, _)| *position);
    let columns = local_columns
        .into_iter()
        .map(|(_, column)| column)
        .collect::<Vec<_>>();

    let foreign_key = if kind == TableConstraintKind::ForeignKey {
        let mut referenced_columns = rows
            .iter()
            .filter_map(|row| Some((row_i32(row, 3).unwrap_or(0), row_string(row, 7)?)))
            .collect::<Vec<_>>();
        referenced_columns.sort_by_key(|(position, _)| *position);
        Some(TableForeignKeyReference {
            database_name: None,
            schema_name: row_string(first, 5),
            table_name: row_string(first, 6)?,
            columns: referenced_columns
                .into_iter()
                .map(|(_, column)| column)
                .collect(),
            on_update: None,
            on_delete: oracle_delete_rule_action(row_string(first, 8).as_deref()),
        })
    } else {
        None
    };

    Some(OracleTableDesignConstraint {
        name,
        kind,
        columns,
        expression: row_string(first, 4),
        foreign_key,
        enforced: Some(
            row_string(first, 9)
                .map(|value| value.eq_ignore_ascii_case("ENABLED"))
                .unwrap_or(true),
        ),
    })
}

fn is_generated_not_null_check(row: &Row) -> bool {
    let is_generated = row_string(row, 10)
        .map(|value| value.eq_ignore_ascii_case("GENERATED NAME"))
        .unwrap_or(false);
    if !is_generated {
        return false;
    }

    row_string(row, 4)
        .map(|expression| {
            let upper = expression.to_ascii_uppercase();
            upper.contains(" IS NOT NULL") && !upper.contains(" OR ") && !upper.contains(" AND ")
        })
        .unwrap_or(false)
}

fn oracle_delete_rule_action(
    value: Option<&str>,
) -> Option<crate::engine::types::TableReferentialAction> {
    match value.map(str::to_ascii_uppercase).as_deref() {
        Some("CASCADE") => Some(crate::engine::types::TableReferentialAction::Cascade),
        Some("SET NULL") => Some(crate::engine::types::TableReferentialAction::SetNull),
        _ => None,
    }
}

fn oracle_type_name(
    data_type: &str,
    data_length: Option<i64>,
    data_precision: Option<i32>,
    data_scale: Option<i32>,
) -> String {
    let upper = data_type.to_ascii_uppercase();
    if upper == "NUMBER" {
        return match (data_precision, data_scale) {
            (Some(precision), Some(scale)) => format!("NUMBER({precision},{scale})"),
            (Some(precision), None) => format!("NUMBER({precision})"),
            _ => "NUMBER".to_string(),
        };
    }
    if upper == "TIMESTAMP" || upper.starts_with("TIMESTAMP(") {
        return upper;
    }
    if matches!(
        upper.as_str(),
        "CHAR" | "NCHAR" | "VARCHAR2" | "NVARCHAR2" | "RAW"
    ) {
        if let Some(length) = data_length {
            return format!("{upper}({length})");
        }
    }
    upper
}

fn row_bool_yes(row: &Row, index: usize) -> bool {
    row_string(row, index)
        .map(|value| value.eq_ignore_ascii_case("YES") || value.eq_ignore_ascii_case("Y"))
        .unwrap_or(false)
}

fn row_string(row: &Row, index: usize) -> Option<String> {
    row.get(index)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn row_i32(row: &Row, index: usize) -> Option<i32> {
    row_i64(row, index).and_then(|value| i32::try_from(value).ok())
}

fn row_i64(row: &Row, index: usize) -> Option<i64> {
    match row.get(index)? {
        Value::Integer(value) => Some(*value),
        Value::Number(value) => value.as_str().trim().parse::<i64>().ok(),
        Value::String(value) => value.trim().parse::<i64>().ok(),
        other => other.as_i64(),
    }
}

#[cfg(test)]
mod tests {
    use crate::engine::types::{ContainerKind, ContainerRef};
    use crate::engine::types::{
        TableConstraintKind, TableConstraintSchema, TableGeneratedColumnStorage,
        TableIdentityGeneration, TableSchemaBasics,
    };

    use super::*;

    #[test]
    fn oracle_describe_sql_uses_dictionary_views_with_single_owner_table_bind_pair() {
        for sql in [
            oracle_table_design_columns_sql(),
            oracle_table_design_constraints_sql(),
            oracle_table_design_indexes_sql(),
            oracle_table_design_comments_sql(),
        ] {
            assert!(sql.contains("all_"));
            assert!(sql.contains(":1"));
            assert!(sql.contains(":2"));
            assert_eq!(sql.matches(":1").count(), 1);
            assert_eq!(sql.matches(":2").count(), 1);
        }
    }

    #[test]
    fn maps_oracle_table_design_metadata_to_table_schema() {
        let schema = table_schema_from_oracle_metadata(OracleTableDesignMetadata {
            database: "FREEPDB1".to_string(),
            owner: "NEXUS".to_string(),
            table: "EMPLOYEES".to_string(),
            table_comment: Some("Employees".to_string()),
            columns: vec![
                OracleTableDesignColumn {
                    name: "ID".to_string(),
                    type_name: "NUMBER(10,0)".to_string(),
                    nullable: false,
                    default_value: None,
                    comment: Some("Primary key".to_string()),
                    primary_key_position: Some(1),
                    unique_column: true,
                    identity_generation: Some(TableIdentityGeneration::ByDefault),
                    generated_expression: None,
                },
                OracleTableDesignColumn {
                    name: "NAME_UPPER".to_string(),
                    type_name: "VARCHAR2(255)".to_string(),
                    nullable: true,
                    default_value: None,
                    comment: None,
                    primary_key_position: None,
                    unique_column: false,
                    identity_generation: None,
                    generated_expression: Some("UPPER(\"NAME\")".to_string()),
                },
            ],
            indexes: vec![OracleTableDesignIndex {
                name: "IDX_EMP_NAME".to_string(),
                columns: vec!["NAME_UPPER".to_string()],
                is_unique: false,
                constraint_backed: false,
            }],
            constraints: vec![OracleTableDesignConstraint {
                name: "PK_EMP".to_string(),
                kind: TableConstraintKind::PrimaryKey,
                columns: vec!["ID".to_string()],
                expression: None,
                foreign_key: None,
                enforced: Some(true),
            }],
            partition_description: None,
        });

        assert_eq!(schema.basics.database_name, "FREEPDB1");
        assert_eq!(schema.basics.schema_name, "NEXUS");
        assert_eq!(schema.basics.table_name, "EMPLOYEES");
        assert_eq!(schema.basics.comment.as_deref(), Some("Employees"));
        assert!(schema.basics.engine.is_none());
        assert!(schema.basics.charset.is_none());
        assert!(schema.basics.collation.is_none());
        assert!(schema.columns[0].is_identity);
        assert_eq!(
            schema.columns[0]
                .identity
                .as_ref()
                .map(|identity| &identity.generation),
            Some(&TableIdentityGeneration::ByDefault)
        );
        assert_eq!(
            schema.columns[1].generated.as_ref().unwrap().storage,
            TableGeneratedColumnStorage::Virtual
        );
        assert_eq!(schema.indexes[0].name, "IDX_EMP_NAME");
        assert_eq!(schema.constraints[0].name, "PK_EMP");
    }

    #[test]
    fn oracle_update_baseline_match_ignores_enabled_pk_unique_roundtrip() {
        let mut current = TableSchema {
            basics: TableSchemaBasics {
                table_name: "EMPLOYEES".to_string(),
                database_name: "FREEPDB1".to_string(),
                schema_name: "NEXUS".to_string(),
                engine: None,
                charset: None,
                collation: None,
                comment: None,
                partition: None,
            },
            columns: Vec::new(),
            indexes: Vec::new(),
            constraints: vec![
                TableConstraintSchema {
                    name: "PK_EMP".to_string(),
                    kind: TableConstraintKind::PrimaryKey,
                    columns: vec!["ID".to_string()],
                    reference: None,
                    expression: None,
                    comment: None,
                    foreign_key: None,
                    enforced: Some(true),
                },
                TableConstraintSchema {
                    name: "UK_EMP".to_string(),
                    kind: TableConstraintKind::Unique,
                    columns: vec!["CODE".to_string()],
                    reference: None,
                    expression: None,
                    comment: None,
                    foreign_key: None,
                    enforced: Some(true),
                },
            ],
        };
        let mut frontend_roundtrip = current.clone();
        for constraint in &mut frontend_roundtrip.constraints {
            constraint.enforced = None;
        }

        assert!(oracle_table_schema_matches_update_baseline(
            &current,
            &frontend_roundtrip
        ));

        current.constraints[0].enforced = Some(false);
        assert!(!oracle_table_schema_matches_update_baseline(
            &current,
            &frontend_roundtrip
        ));
    }

    #[test]
    fn oracle_describe_table_rejects_non_table_container() {
        let container = ContainerRef::table(
            ContainerKind::View,
            "FREEPDB1",
            Some("NEXUS".to_string()),
            "EMP_VIEW",
        );
        let error = oracle_describe_table_parts(&container).unwrap_err();

        assert!(error.message.contains("table") || error.message.contains("表"));
    }

    #[test]
    fn skips_oracle_generated_not_null_check_constraints() {
        let rows = vec![Row::new(vec![
            Value::String("SYS_C001".to_string()),
            Value::String("C".to_string()),
            Value::String("NAME".to_string()),
            Value::Integer(1),
            Value::String("\"NAME\" IS NOT NULL".to_string()),
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Null,
            Value::String("ENABLED".to_string()),
            Value::String("GENERATED NAME".to_string()),
        ])];

        let constraints = oracle_constraints_from_rows(&rows);

        assert!(constraints.is_empty());
    }
}
