use std::collections::HashSet;

use serde_json::Value;

use crate::engine::drivers::common::{
    diff_table_schema_for_update_with_column_renames, normalized_non_empty_identifier,
    render_sql_literal, TableUpdateDiffOptions,
};
use crate::engine::types::{
    ContainerKind, CreateTableInput, DropTableInput, SchemaMutationPreview, TableColumnSchema,
    TableConstraintKind, TableConstraintSchema, TableForeignKeyReference,
    TableGeneratedColumnStorage, TableIdentityGeneration, TableIndexSchema, TablePartitionOptions,
    TableReferentialAction, TableSchema, UpdateTableInput,
};
use crate::error::{IpcError, IpcResult};

use super::quote_oracle_identifier;

#[derive(Clone)]
struct NamedColumnList {
    name: Option<String>,
    columns: Vec<String>,
}

struct NormalizedCreateTable {
    columns: Vec<TableColumnSchema>,
    column_names: HashSet<String>,
    primary_key_columns: Vec<String>,
    primary_key_name: Option<String>,
    unique_constraints: Vec<NamedColumnList>,
    table_constraints: Vec<TableConstraintSchema>,
    indexes: Vec<TableIndexSchema>,
}

pub(crate) fn oracle_create_table_statements(input: &CreateTableInput) -> IpcResult<Vec<String>> {
    ensure_oracle_table_options(
        &input.basics.engine,
        &input.basics.charset,
        &input.basics.collation,
    )?;
    let schema_name = normalized_non_empty_identifier(&input.basics.schema_name, "Schema")?;
    let table_name = normalized_non_empty_identifier(&input.basics.table_name, "表名")?;
    let qualified_table = oracle_qualified_table_name(&schema_name, &table_name);
    let schema = normalize_create_table_input(input)?;
    let mut definitions = Vec::new();

    for column in &schema.columns {
        definitions.push(oracle_column_definition(column)?);
    }

    if !schema.primary_key_columns.is_empty() {
        let prefix = schema
            .primary_key_name
            .as_deref()
            .map(|name| format!("CONSTRAINT {} ", quote_oracle_identifier(name)))
            .unwrap_or_default();
        definitions.push(format!(
            "{prefix}PRIMARY KEY ({})",
            quote_column_list(&schema.primary_key_columns)
        ));
    }

    for unique in &schema.unique_constraints {
        let prefix = unique
            .name
            .as_deref()
            .map(|name| format!("CONSTRAINT {} ", quote_oracle_identifier(name)))
            .unwrap_or_default();
        definitions.push(format!(
            "{prefix}UNIQUE ({})",
            quote_column_list(&unique.columns)
        ));
    }

    for constraint in &schema.table_constraints {
        definitions.push(oracle_table_constraint_definition(constraint)?);
    }

    let body = definitions
        .into_iter()
        .map(|definition| format!("  {definition}"))
        .collect::<Vec<_>>()
        .join(",\n");
    let mut create_statement = format!("CREATE TABLE {qualified_table} (\n{body}\n)");
    if let Some(partition) = oracle_partition_raw_clause(input.basics.partition.as_ref())? {
        create_statement.push(' ');
        create_statement.push_str(&partition);
    }

    let mut statements = vec![create_statement];
    statements.extend(oracle_comment_statements(&qualified_table, input)?);
    for index in &schema.indexes {
        statements.push(oracle_index_statement(
            &schema_name,
            &qualified_table,
            index,
            &schema.column_names,
        )?);
    }

    Ok(statements)
}

pub(crate) fn oracle_create_table_parts(
    input: &CreateTableInput,
    default_database: &str,
) -> IpcResult<(String, String, String)> {
    let database = normalized_optional_text(Some(input.basics.database_name.as_str()))
        .unwrap_or_else(|| default_database.to_string());
    let database = normalized_non_empty_identifier(&database, "数据库名称")?;
    let schema = normalized_non_empty_identifier(&input.basics.schema_name, "Schema")?;
    let table = normalized_non_empty_identifier(&input.basics.table_name, "表名")?;
    Ok((database, schema, table))
}

#[cfg(test)]
pub(crate) fn oracle_update_table_statements(input: &UpdateTableInput) -> IpcResult<Vec<String>> {
    let (_, _, _, statements) = oracle_update_table_parts_and_statements(input, None)?;
    Ok(statements)
}

pub(crate) fn oracle_update_table_parts_and_statements(
    input: &UpdateTableInput,
    default_database: Option<&str>,
) -> IpcResult<(String, String, String, Vec<String>)> {
    let (database, schema, table) = oracle_update_table_parts(input, default_database)?;
    let qualified_table = oracle_qualified_table_name(&schema, &table);
    let diff = diff_table_schema_for_update_with_column_renames(
        &input.baseline,
        &input.target,
        TableUpdateDiffOptions {
            allow_column_comments: true,
        },
        &input.column_renames,
    )?;

    if diff.is_empty() {
        return Err(IpcError::validation_failed("没有可执行的表结构变更"));
    }
    if diff.table_engine_change.is_some()
        || diff.table_charset_change.is_some()
        || diff.table_collation_change.is_some()
    {
        return Err(IpcError::validation_failed(
            "Oracle 表设计不支持 engine、charset 或 collation 变更",
        ));
    }
    if let Some(change) = diff.generated_column_changes.first() {
        return Err(IpcError::validation_failed(format!(
            "暂不支持修改已有 Oracle 生成列 '{}'",
            change.column_name
        )));
    }
    if let Some(change) = diff.identity_changes.first() {
        return Err(IpcError::validation_failed(format!(
            "暂不支持修改已有 Oracle identity 列 '{}'",
            change.column_name
        )));
    }
    if let Some(change) = diff.column_charset_changes.first() {
        return Err(IpcError::validation_failed(format!(
            "Oracle 列 '{}' 不支持 charset 或 collation 变更",
            change.column_name
        )));
    }

    let column_names = input
        .target
        .columns
        .iter()
        .map(|column| column.name.clone())
        .collect::<HashSet<_>>();
    let mut statements = Vec::new();

    if let Some(change) = diff.table_comment_change {
        let literal = match change.comment {
            Some(comment) => render_sql_literal(&Value::String(comment))?,
            None => "NULL".to_string(),
        };
        statements.push(format!("COMMENT ON TABLE {qualified_table} IS {literal}"));
    }

    for column in &diff.added_columns {
        statements.push(format!(
            "ALTER TABLE {qualified_table} ADD ({})",
            oracle_column_definition(column)?
        ));
        if let Some(comment) = normalized_optional_text(column.comment.as_deref()) {
            statements.push(format!(
                "COMMENT ON COLUMN {}.{} IS {}",
                qualified_table,
                quote_oracle_identifier(&column.name),
                render_sql_literal(&Value::String(comment))?
            ));
        }
    }

    for rename in &diff.renamed_columns {
        statements.push(format!(
            "ALTER TABLE {qualified_table} RENAME COLUMN {} TO {}",
            quote_oracle_identifier(&rename.old_name),
            quote_oracle_identifier(&rename.new_name)
        ));
    }

    for change in &diff.column_type_changes {
        let column_name = normalized_non_empty_identifier(&change.column_name, "列名")?;
        let type_name = normalized_sql_fragment(&change.type_name, "列类型")?;
        statements.push(format!(
            "ALTER TABLE {qualified_table} MODIFY ({} {type_name})",
            quote_oracle_identifier(&column_name)
        ));
    }

    for change in &diff.column_default_changes {
        let column_name = normalized_non_empty_identifier(&change.column_name, "列名")?;
        let default_value =
            match normalized_optional_fragment(change.default_value.as_deref(), "默认值")? {
                Some(default_value) => default_value,
                None => "NULL".to_string(),
            };
        statements.push(format!(
            "ALTER TABLE {qualified_table} MODIFY ({} DEFAULT {default_value})",
            quote_oracle_identifier(&column_name)
        ));
    }

    for change in &diff.column_nullability_changes {
        let column_name = normalized_non_empty_identifier(&change.column_name, "列名")?;
        let action = if change.nullable { "NULL" } else { "NOT NULL" };
        statements.push(format!(
            "ALTER TABLE {qualified_table} MODIFY ({} {action})",
            quote_oracle_identifier(&column_name)
        ));
    }

    for change in &diff.column_comment_changes {
        let literal = match &change.comment {
            Some(comment) => render_sql_literal(&Value::String(comment.clone()))?,
            None => "NULL".to_string(),
        };
        statements.push(format!(
            "COMMENT ON COLUMN {}.{} IS {}",
            qualified_table,
            quote_oracle_identifier(&change.column_name),
            literal
        ));
    }

    if let Some(change) = &diff.primary_key_change {
        if !change.old_columns.is_empty() {
            let Some(name) = normalized_optional_text(change.old_constraint_name.as_deref()) else {
                return Err(IpcError::validation_failed(
                    "无法确定当前 Oracle 主键约束名，请刷新表结构后重试",
                ));
            };
            statements.push(format!(
                "ALTER TABLE {qualified_table} DROP CONSTRAINT {}",
                quote_oracle_identifier(&name)
            ));
        }
        if !change.new_columns.is_empty() {
            let name = target_primary_key_name(&input.target)
                .unwrap_or_else(|| format!("PK_{}", table.chars().take(27).collect::<String>()));
            statements.push(format!(
                "ALTER TABLE {qualified_table} ADD CONSTRAINT {} PRIMARY KEY ({})",
                quote_oracle_identifier(&name),
                quote_column_list(&change.new_columns)
            ));
        }
    }

    for constraint in &diff.dropped_constraints {
        let name = normalized_non_empty_identifier(&constraint.name, "约束名")?;
        statements.push(format!(
            "ALTER TABLE {qualified_table} DROP CONSTRAINT {}",
            quote_oracle_identifier(&name)
        ));
    }

    for constraint in &diff.added_constraints {
        statements.push(format!(
            "ALTER TABLE {qualified_table} ADD {}",
            oracle_table_constraint_definition(constraint)?
        ));
    }

    for index in &diff.dropped_indexes {
        let name = normalized_non_empty_identifier(&index.name, "索引名")?;
        statements.push(format!(
            "DROP INDEX {}.{}",
            quote_oracle_identifier(&schema),
            quote_oracle_identifier(&name)
        ));
    }

    for column in &diff.dropped_columns {
        let name = normalized_non_empty_identifier(&column.name, "列名")?;
        statements.push(format!(
            "ALTER TABLE {qualified_table} DROP COLUMN {}",
            quote_oracle_identifier(&name)
        ));
    }

    for index in &diff.added_indexes {
        statements.push(oracle_index_statement(
            &schema,
            &qualified_table,
            index,
            &column_names,
        )?);
    }

    Ok((database, schema, table, statements))
}

pub(crate) fn mark_oracle_table_update_preview(preview: &mut SchemaMutationPreview) {
    if oracle_table_update_statements_are_destructive(&preview.statements) {
        preview.destructive = true;
    }
    if preview
        .statements
        .iter()
        .any(|statement| statement.contains(" DROP COLUMN "))
    {
        preview
            .warnings
            .push("将删除已有列；该操作会永久删除该列中的数据".to_string());
    }
    if preview
        .statements
        .iter()
        .any(|statement| is_oracle_type_modify_statement(statement))
    {
        preview
            .warnings
            .push("将修改列类型；数据库可能拒绝转换，转换也可能造成数据截断".to_string());
    }
    if preview.statements.iter().any(|statement| {
        statement.contains(" DROP CONSTRAINT ") || statement.contains(" PRIMARY KEY ")
    }) {
        preview
            .warnings
            .push("将修改约束；该操作可能影响依赖这些约束的查询、索引和应用逻辑".to_string());
    }
}

pub(crate) fn ensure_oracle_destructive_update_confirmed(
    input: &UpdateTableInput,
    statements: &[String],
) -> IpcResult<()> {
    if oracle_table_update_statements_are_destructive(statements) && !input.confirm_destructive {
        return Err(IpcError::validation_failed(
            "破坏性表结构变更需要确认后才能执行",
        ));
    }
    Ok(())
}

pub(crate) fn oracle_drop_table_parts_and_statement(
    input: &DropTableInput,
    default_database: Option<&str>,
) -> IpcResult<(String, String, String, String)> {
    if input.container.kind != ContainerKind::Table {
        return Err(IpcError::validation_failed(
            "Selected Oracle container is not a table",
        ));
    }

    let database = input
        .container
        .database
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .or(default_database)
        .unwrap_or_default();
    let schema = input
        .container
        .schema
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_default();
    let table = input
        .container
        .table
        .as_deref()
        .or(input.container.object_name.as_deref())
        .unwrap_or_default();

    let database = normalized_non_empty_identifier(database, "数据库名称")?;
    let schema = normalized_non_empty_identifier(schema, "Schema")?;
    let table = normalized_non_empty_identifier(table, "表名")?;
    let statement = format!(
        "DROP TABLE {}",
        oracle_qualified_table_name(&schema, &table)
    );

    Ok((database, schema, table, statement))
}

pub(crate) fn ensure_oracle_destructive_drop_table_confirmed(
    input: &DropTableInput,
) -> IpcResult<()> {
    if !input.confirm_destructive {
        return Err(IpcError::validation_failed("删除表需要确认后才能执行"));
    }

    Ok(())
}

pub(crate) fn mark_oracle_drop_table_preview(preview: &mut SchemaMutationPreview) {
    preview.destructive = true;
    preview
        .warnings
        .push("删除表会永久删除表结构和表内数据".to_string());
}

fn oracle_update_table_parts(
    input: &UpdateTableInput,
    default_database: Option<&str>,
) -> IpcResult<(String, String, String)> {
    if input.container.kind != crate::engine::types::ContainerKind::Table {
        return Err(IpcError::resource_not_found(
            "Selected Oracle container is not a table",
        ));
    }

    let database = input
        .container
        .database
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .or(default_database)
        .unwrap_or(input.target.basics.database_name.as_str());
    let schema = input
        .container
        .schema
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(input.target.basics.schema_name.as_str());
    let table = input
        .container
        .table
        .as_deref()
        .or(input.container.object_name.as_deref())
        .unwrap_or(input.target.basics.table_name.as_str());

    let database = normalized_non_empty_identifier(database, "数据库名称")?;
    let schema = normalized_non_empty_identifier(schema, "Schema")?;
    let table = normalized_non_empty_identifier(table, "表名")?;

    ensure_schema_matches_oracle_table_parts(&input.baseline, &database, &schema, &table)?;
    ensure_schema_matches_oracle_table_parts(&input.target, &database, &schema, &table)?;
    ensure_oracle_table_options(
        &input.target.basics.engine,
        &input.target.basics.charset,
        &input.target.basics.collation,
    )?;

    Ok((database, schema, table))
}

fn ensure_schema_matches_oracle_table_parts(
    schema: &TableSchema,
    database: &str,
    owner: &str,
    table: &str,
) -> IpcResult<()> {
    if schema.basics.database_name.trim() == database
        && schema.basics.schema_name.trim() == owner
        && schema.basics.table_name.trim() == table
    {
        Ok(())
    } else {
        Err(IpcError::validation_failed(
            "表结构快照与目标 Oracle 表不一致，请刷新后重试",
        ))
    }
}

fn target_primary_key_name(schema: &TableSchema) -> Option<String> {
    schema
        .constraints
        .iter()
        .find(|constraint| constraint.kind == TableConstraintKind::PrimaryKey)
        .and_then(|constraint| normalized_optional_text(Some(constraint.name.as_str())))
}

fn oracle_table_update_statements_are_destructive(statements: &[String]) -> bool {
    statements.iter().any(|statement| {
        statement.contains(" DROP COLUMN ")
            || statement.contains(" DROP CONSTRAINT ")
            || statement.contains(" PRIMARY KEY ")
            || is_oracle_type_modify_statement(statement)
    })
}

fn is_oracle_type_modify_statement(statement: &str) -> bool {
    statement.contains(" MODIFY (")
        && !statement.contains(" DEFAULT ")
        && !statement.contains(" NOT NULL)")
        && !statement.contains(" NULL)")
}

fn normalize_create_table_input(input: &CreateTableInput) -> IpcResult<NormalizedCreateTable> {
    if input.columns.is_empty() {
        return Err(IpcError::validation_failed("请至少添加一列"));
    }

    let mut seen_columns = HashSet::new();
    let mut column_names = HashSet::new();
    let mut columns = Vec::with_capacity(input.columns.len());
    let mut primary_key_from_columns = Vec::new();
    let mut unique_constraints = Vec::new();
    let mut table_constraints = Vec::new();
    let mut primary_key_name = None;

    for column in &input.columns {
        let name = normalized_non_empty_identifier(&column.name, "列名")?;
        let duplicate_key = name.to_ascii_lowercase();
        if !seen_columns.insert(duplicate_key) {
            return Err(IpcError::validation_failed(format!("列名 '{name}' 重复")));
        }
        let type_name = normalized_sql_fragment(&column.type_name, "列类型")?;
        ensure_oracle_column_options(column)?;
        let default_value =
            normalized_optional_fragment(column.default_value.as_deref(), "默认值")?;
        let comment = normalized_optional_text(column.comment.as_deref());

        if column.is_primary_key {
            primary_key_from_columns.push(name.clone());
        }
        if column.is_unique && !column.is_primary_key {
            unique_constraints.push(NamedColumnList {
                name: None,
                columns: vec![name.clone()],
            });
        }

        column_names.insert(name.clone());
        columns.push(TableColumnSchema {
            name,
            type_name,
            nullable: column.nullable,
            default_value,
            is_primary_key: column.is_primary_key,
            is_unique: column.is_unique,
            is_identity: column.is_identity,
            identity: column.identity.clone(),
            generated: column.generated.clone(),
            charset: None,
            collation: None,
            comment,
        });
    }

    let mut primary_key_from_constraints: Option<Vec<String>> = None;
    for constraint in &input.constraints {
        ensure_oracle_constraint_supported(constraint)?;
        match constraint.kind {
            TableConstraintKind::PrimaryKey => {
                if primary_key_from_constraints.is_some() {
                    return Err(IpcError::validation_failed("只能定义一个主键约束"));
                }
                primary_key_name = normalized_optional_text(Some(constraint.name.as_str()));
                primary_key_from_constraints = Some(validate_column_refs(
                    &constraint.columns,
                    &column_names,
                    "主键列",
                )?);
            }
            TableConstraintKind::Unique => {
                unique_constraints.push(NamedColumnList {
                    name: normalized_optional_text(Some(constraint.name.as_str())),
                    columns: validate_column_refs(
                        &constraint.columns,
                        &column_names,
                        "唯一约束列",
                    )?,
                });
            }
            TableConstraintKind::ForeignKey | TableConstraintKind::Check => {
                table_constraints.push(normalize_table_constraint(constraint, &column_names)?);
            }
        }
    }

    let primary_key_columns = match primary_key_from_constraints {
        Some(columns) => {
            if !primary_key_from_columns.is_empty() && primary_key_from_columns != columns {
                return Err(IpcError::validation_failed(
                    "列定义中的主键与约束区主键不一致",
                ));
            }
            columns
        }
        None => primary_key_from_columns,
    };

    let indexes = input
        .indexes
        .iter()
        .map(|index| {
            let name = normalized_non_empty_identifier(&index.name, "索引名")?;
            if normalized_optional_text(index.method.as_deref()).is_some() {
                return Err(IpcError::validation_failed(
                    "Oracle 普通索引暂不支持通过表设计器设置索引方法",
                ));
            }
            let comment = normalized_optional_text(index.comment.as_deref());
            if comment.is_some() {
                return Err(IpcError::validation_failed(
                    "Oracle 索引备注暂不支持通过表设计器设置",
                ));
            }
            Ok(TableIndexSchema {
                name,
                columns: validate_column_refs(&index.columns, &column_names, "索引列")?,
                is_unique: index.is_unique,
                method: None,
                comment: None,
            })
        })
        .collect::<IpcResult<Vec<_>>>()?;

    Ok(NormalizedCreateTable {
        columns,
        column_names,
        primary_key_columns,
        primary_key_name,
        unique_constraints,
        table_constraints,
        indexes,
    })
}

fn normalize_table_constraint(
    constraint: &TableConstraintSchema,
    column_names: &HashSet<String>,
) -> IpcResult<TableConstraintSchema> {
    let name = normalized_non_empty_identifier(&constraint.name, "约束名")?;
    let columns = match constraint.kind {
        TableConstraintKind::Check => {
            validate_optional_column_refs(&constraint.columns, column_names, "CHECK 约束列")?
        }
        _ => validate_column_refs(&constraint.columns, column_names, "约束列")?,
    };
    let expression = match constraint.kind {
        TableConstraintKind::Check => Some(normalized_sql_fragment(
            constraint.expression.as_deref().unwrap_or_default(),
            "CHECK 表达式",
        )?),
        _ => None,
    };
    let foreign_key = match constraint.kind {
        TableConstraintKind::ForeignKey => Some(normalize_foreign_key(constraint, &columns)?),
        _ => None,
    };

    Ok(TableConstraintSchema {
        name,
        kind: constraint.kind.clone(),
        columns,
        reference: None,
        expression,
        comment: normalized_optional_text(constraint.comment.as_deref()),
        foreign_key,
        enforced: constraint.enforced,
    })
}

fn normalize_foreign_key(
    constraint: &TableConstraintSchema,
    local_columns: &[String],
) -> IpcResult<TableForeignKeyReference> {
    let Some(foreign_key) = constraint.foreign_key.as_ref() else {
        return Err(IpcError::validation_failed(format!(
            "外键约束 '{}' 需要引用表和引用列",
            constraint.name
        )));
    };
    if normalized_optional_text(foreign_key.database_name.as_deref()).is_some() {
        return Err(IpcError::validation_failed(
            "Oracle 外键不支持跨 database 引用",
        ));
    }
    if foreign_key.on_update.is_some() {
        return Err(IpcError::validation_failed(
            "Oracle 外键不支持 ON UPDATE 动作",
        ));
    }
    let referenced_table = normalized_non_empty_identifier(&foreign_key.table_name, "引用表")?;
    let referenced_columns = foreign_key
        .columns
        .iter()
        .map(|column| normalized_non_empty_identifier(column, "引用列"))
        .collect::<IpcResult<Vec<_>>>()?;
    if referenced_columns.len() != local_columns.len() {
        return Err(IpcError::validation_failed(format!(
            "外键约束 '{}' 的本地列与引用列数量必须一致",
            constraint.name
        )));
    }
    if !matches!(
        foreign_key.on_delete,
        None | Some(TableReferentialAction::Cascade) | Some(TableReferentialAction::SetNull)
    ) {
        return Err(IpcError::validation_failed(
            "Oracle 外键仅支持 ON DELETE CASCADE 或 SET NULL",
        ));
    }

    Ok(TableForeignKeyReference {
        database_name: None,
        schema_name: normalized_optional_text(foreign_key.schema_name.as_deref()),
        table_name: referenced_table,
        columns: referenced_columns,
        on_update: None,
        on_delete: foreign_key.on_delete.clone(),
    })
}

fn oracle_column_definition(column: &TableColumnSchema) -> IpcResult<String> {
    ensure_oracle_column_options(column)?;
    let mut definition = format!(
        "{} {}",
        quote_oracle_identifier(&column.name),
        normalized_sql_fragment(&column.type_name, "列类型")?
    );

    if let Some(generated) = column.generated.as_ref() {
        if generated.storage != TableGeneratedColumnStorage::Virtual {
            return Err(IpcError::validation_failed("Oracle 生成列只支持 VIRTUAL"));
        }
        if normalized_optional_text(column.default_value.as_deref()).is_some()
            || column.is_identity
            || column.identity.is_some()
        {
            return Err(IpcError::validation_failed(
                "Oracle 生成列不能同时设置默认值或 identity",
            ));
        }
        definition.push_str(" GENERATED ALWAYS AS (");
        definition.push_str(&normalized_sql_fragment(
            &generated.expression,
            "生成列表达式",
        )?);
        definition.push_str(") VIRTUAL");
    } else {
        if column.is_identity || column.identity.is_some() {
            let generation = column
                .identity
                .as_ref()
                .map(|identity| identity.generation.clone())
                .unwrap_or(TableIdentityGeneration::ByDefault);
            match generation {
                TableIdentityGeneration::Always => {
                    definition.push_str(" GENERATED ALWAYS AS IDENTITY")
                }
                TableIdentityGeneration::ByDefault => {
                    definition.push_str(" GENERATED BY DEFAULT AS IDENTITY")
                }
            }
        }
        if let Some(default_value) =
            normalized_optional_fragment(column.default_value.as_deref(), "默认值")?
        {
            definition.push_str(" DEFAULT ");
            definition.push_str(&default_value);
        }
    }

    if !column.nullable {
        definition.push_str(" NOT NULL");
    }

    Ok(definition)
}

fn oracle_table_constraint_definition(constraint: &TableConstraintSchema) -> IpcResult<String> {
    ensure_oracle_constraint_supported(constraint)?;
    let name = normalized_non_empty_identifier(&constraint.name, "约束名")?;
    let prefix = format!("CONSTRAINT {} ", quote_oracle_identifier(&name));
    match constraint.kind {
        TableConstraintKind::PrimaryKey => Ok(format!(
            "{prefix}PRIMARY KEY ({})",
            quote_column_list(&constraint.columns)
        )),
        TableConstraintKind::Unique => Ok(format!(
            "{prefix}UNIQUE ({})",
            quote_column_list(&constraint.columns)
        )),
        TableConstraintKind::Check => {
            let expression = normalized_sql_fragment(
                constraint.expression.as_deref().unwrap_or_default(),
                "CHECK 表达式",
            )?;
            Ok(format!("{prefix}CHECK ({expression})"))
        }
        TableConstraintKind::ForeignKey => {
            let local_columns = constraint
                .columns
                .iter()
                .map(|column| normalized_non_empty_identifier(column, "外键列"))
                .collect::<IpcResult<Vec<_>>>()?;
            let foreign_key = normalize_foreign_key(constraint, &local_columns)?;
            let referenced_table = match foreign_key.schema_name.as_deref() {
                Some(schema) => format!(
                    "{}.{}",
                    quote_oracle_identifier(schema),
                    quote_oracle_identifier(&foreign_key.table_name)
                ),
                None => quote_oracle_identifier(&foreign_key.table_name),
            };
            let mut sql = format!(
                "{prefix}FOREIGN KEY ({}) REFERENCES {referenced_table} ({})",
                quote_column_list(&local_columns),
                quote_column_list(&foreign_key.columns)
            );
            match foreign_key.on_delete {
                Some(TableReferentialAction::Cascade) => sql.push_str(" ON DELETE CASCADE"),
                Some(TableReferentialAction::SetNull) => sql.push_str(" ON DELETE SET NULL"),
                None => {}
                Some(_) => unreachable!("normalize_foreign_key rejects unsupported actions"),
            }
            Ok(sql)
        }
    }
}

fn oracle_index_statement(
    schema_name: &str,
    qualified_table: &str,
    index: &TableIndexSchema,
    column_names: &HashSet<String>,
) -> IpcResult<String> {
    let name = normalized_non_empty_identifier(&index.name, "索引名")?;
    let columns = validate_column_refs(&index.columns, column_names, "索引列")?;
    let unique = if index.is_unique { "UNIQUE " } else { "" };
    Ok(format!(
        "CREATE {unique}INDEX {}.{} ON {qualified_table} ({})",
        quote_oracle_identifier(schema_name),
        quote_oracle_identifier(&name),
        quote_column_list(&columns)
    ))
}

fn oracle_comment_statements(
    qualified_table: &str,
    input: &CreateTableInput,
) -> IpcResult<Vec<String>> {
    let mut statements = Vec::new();
    if let Some(comment) = normalized_optional_text(input.basics.comment.as_deref()) {
        statements.push(format!(
            "COMMENT ON TABLE {qualified_table} IS {}",
            render_sql_literal(&Value::String(comment))?
        ));
    }
    for column in &input.columns {
        if let Some(comment) = normalized_optional_text(column.comment.as_deref()) {
            let column_name = normalized_non_empty_identifier(&column.name, "列名")?;
            statements.push(format!(
                "COMMENT ON COLUMN {qualified_table}.{} IS {}",
                quote_oracle_identifier(&column_name),
                render_sql_literal(&Value::String(comment))?
            ));
        }
    }
    Ok(statements)
}

fn oracle_partition_raw_clause(
    partition: Option<&TablePartitionOptions>,
) -> IpcResult<Option<String>> {
    partition
        .and_then(|partition| partition.raw_clause.as_deref())
        .map(|value| normalized_sql_fragment(value, "分区子句"))
        .transpose()
}

fn ensure_oracle_table_options(
    engine: &Option<String>,
    charset: &Option<String>,
    collation: &Option<String>,
) -> IpcResult<()> {
    if normalized_optional_text(engine.as_deref()).is_some()
        || normalized_optional_text(charset.as_deref()).is_some()
        || normalized_optional_text(collation.as_deref()).is_some()
    {
        return Err(IpcError::validation_failed(
            "Oracle 表设计不支持 engine、charset 或 collation 选项",
        ));
    }
    Ok(())
}

fn ensure_oracle_column_options(column: &TableColumnSchema) -> IpcResult<()> {
    if normalized_optional_text(column.charset.as_deref()).is_some()
        || normalized_optional_text(column.collation.as_deref()).is_some()
    {
        return Err(IpcError::validation_failed(
            "Oracle 列设计不支持 charset 或 collation 选项",
        ));
    }
    Ok(())
}

fn ensure_oracle_constraint_supported(constraint: &TableConstraintSchema) -> IpcResult<()> {
    if constraint.enforced == Some(false) {
        return Err(IpcError::validation_failed(
            "Oracle 表设计暂不支持创建未启用约束",
        ));
    }
    if normalized_optional_text(constraint.comment.as_deref()).is_some() {
        return Err(IpcError::validation_failed(
            "Oracle 约束备注暂不支持通过表设计器设置",
        ));
    }
    if constraint.kind == TableConstraintKind::ForeignKey {
        let Some(foreign_key) = constraint.foreign_key.as_ref() else {
            return Err(IpcError::validation_failed(format!(
                "外键约束 '{}' 需要引用表和引用列",
                constraint.name
            )));
        };
        if foreign_key.on_update.is_some() {
            return Err(IpcError::validation_failed(
                "Oracle 外键不支持 ON UPDATE 动作",
            ));
        }
    }
    Ok(())
}

fn oracle_qualified_table_name(schema: &str, table: &str) -> String {
    format!(
        "{}.{}",
        quote_oracle_identifier(schema),
        quote_oracle_identifier(table)
    )
}

fn quote_column_list(columns: &[String]) -> String {
    columns
        .iter()
        .map(|column| quote_oracle_identifier(column))
        .collect::<Vec<_>>()
        .join(", ")
}

fn validate_column_refs(
    columns: &[String],
    column_names: &HashSet<String>,
    label: &str,
) -> IpcResult<Vec<String>> {
    let columns = columns
        .iter()
        .map(|column| normalized_non_empty_identifier(column, label))
        .collect::<IpcResult<Vec<_>>>()?;
    if columns.is_empty() {
        return Err(IpcError::validation_failed(format!("{label}不能为空")));
    }
    for column in &columns {
        if !column_names.contains(column) {
            return Err(IpcError::validation_failed(format!(
                "{label}引用了不存在的列 '{column}'"
            )));
        }
    }
    Ok(columns)
}

fn validate_optional_column_refs(
    columns: &[String],
    column_names: &HashSet<String>,
    label: &str,
) -> IpcResult<Vec<String>> {
    if columns.is_empty() {
        return Ok(Vec::new());
    }
    validate_column_refs(columns, column_names, label)
}

fn normalized_optional_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn normalized_optional_fragment(value: Option<&str>, label: &str) -> IpcResult<Option<String>> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| normalized_sql_fragment(value, label))
        .transpose()
}

fn normalized_sql_fragment(value: &str, label: &str) -> IpcResult<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(IpcError::validation_failed(format!("请填写{label}")));
    }
    if value.contains('\0')
        || value.contains(';')
        || value.contains("--")
        || value.contains("/*")
        || value.contains("*/")
    {
        return Err(IpcError::validation_failed(format!(
            "{label}不能包含多语句或注释片段"
        )));
    }
    Ok(value.to_string())
}

#[cfg(test)]
mod tests {
    use crate::engine::types::{
        ContainerKind, ContainerRef, CreateTableInput, DropTableInput, TableColumnSchema,
        TableConstraintKind, TableConstraintSchema, TableForeignKeyReference, TableGeneratedColumn,
        TableGeneratedColumnStorage, TableIdentityGeneration, TableIdentityOptions,
        TableIndexSchema, TableReferentialAction, TableSchema, TableSchemaBasics, UpdateTableInput,
    };

    use super::*;

    #[test]
    fn builds_oracle_create_table_statements() {
        let input = oracle_minimal_create_table_input();
        let statements = oracle_create_table_statements(&input).unwrap();

        assert_eq!(
            statements[0],
            "CREATE TABLE \"NEXUS\".\"EMPLOYEES\" (\n  \"ID\" NUMBER(10,0) GENERATED BY DEFAULT AS IDENTITY NOT NULL,\n  \"NAME\" VARCHAR2(80) DEFAULT 'unknown' NOT NULL,\n  CONSTRAINT \"PK_EMPLOYEES\" PRIMARY KEY (\"ID\")\n)"
        );
        assert!(statements
            .iter()
            .any(|sql| sql == "COMMENT ON TABLE \"NEXUS\".\"EMPLOYEES\" IS 'Employees'"));
    }

    #[test]
    fn builds_oracle_drop_table_statement_without_purge() {
        let input = DropTableInput {
            container: ContainerRef::table(
                ContainerKind::Table,
                "ORCL".to_string(),
                Some("NEXUS".to_string()),
                "EMPLOYEES".to_string(),
            ),
            confirm_destructive: false,
        };

        let (_, schema, table, statement) =
            oracle_drop_table_parts_and_statement(&input, Some("ORCL")).unwrap();

        assert_eq!(schema, "NEXUS");
        assert_eq!(table, "EMPLOYEES");
        assert_eq!(statement, "DROP TABLE \"NEXUS\".\"EMPLOYEES\"");
        assert!(!statement.contains("PURGE"));
    }

    #[test]
    fn rejects_oracle_drop_table_for_non_table_container() {
        let input = DropTableInput {
            container: ContainerRef::table(
                ContainerKind::MaterializedView,
                "ORCL".to_string(),
                Some("NEXUS".to_string()),
                "EMPLOYEE_MV".to_string(),
            ),
            confirm_destructive: true,
        };

        let error = oracle_drop_table_parts_and_statement(&input, Some("ORCL")).unwrap_err();

        assert_eq!(format!("{:?}", error.code), "ValidationFailed");
    }

    #[test]
    fn oracle_drop_table_requires_destructive_confirmation() {
        let input = DropTableInput {
            container: ContainerRef::table(
                ContainerKind::Table,
                "ORCL".to_string(),
                Some("NEXUS".to_string()),
                "EMPLOYEES".to_string(),
            ),
            confirm_destructive: false,
        };

        let error = ensure_oracle_destructive_drop_table_confirmed(&input).unwrap_err();

        assert_eq!(format!("{:?}", error.code), "ValidationFailed");
    }

    #[test]
    fn rejects_oracle_unsupported_fk_on_update() {
        let mut input = oracle_minimal_create_table_input();
        input
            .constraints
            .push(oracle_fk_constraint_with_on_update());

        let error = oracle_create_table_statements(&input).unwrap_err();

        assert!(error.message.contains("ON UPDATE"));
    }

    #[test]
    fn builds_oracle_safe_update_table_statements() {
        let mut input = oracle_update_table_input();
        input.target.basics.comment = Some("Updated".to_string());
        input
            .target
            .columns
            .push(oracle_column("EMAIL", "VARCHAR2(255)", true));
        input.target.columns[1].default_value = Some("'unknown'".to_string());
        input.target.columns[1].nullable = false;
        input
            .target
            .indexes
            .push(oracle_index("IDX_EMP_EMAIL", &["EMAIL"], false));

        let statements = oracle_update_table_statements(&input).unwrap();

        assert!(statements
            .iter()
            .any(|sql| sql == "COMMENT ON TABLE \"NEXUS\".\"EMPLOYEES\" IS 'Updated'"));
        assert!(statements
            .iter()
            .any(|sql| sql.contains("ALTER TABLE \"NEXUS\".\"EMPLOYEES\" ADD")));
        assert!(statements.iter().any(|sql| sql.contains("MODIFY")));
        assert!(statements.iter().any(|sql| {
            sql == "CREATE INDEX \"NEXUS\".\"IDX_EMP_EMAIL\" ON \"NEXUS\".\"EMPLOYEES\" (\"EMAIL\")"
        }));
    }

    #[test]
    fn marks_oracle_drop_column_as_destructive() {
        let mut input = oracle_update_table_input();
        input.target.indexes.clear();
        input.target.columns.retain(|column| column.name != "NAME");
        let statements = oracle_update_table_statements(&input).unwrap();
        let mut preview = SchemaMutationPreview::from_statements(statements.clone());

        mark_oracle_table_update_preview(&mut preview);

        assert!(preview.destructive);
        assert!(statements
            .iter()
            .any(|sql| sql == "ALTER TABLE \"NEXUS\".\"EMPLOYEES\" DROP COLUMN \"NAME\""));
    }

    #[test]
    fn rejects_oracle_destructive_update_without_confirmation() {
        let input = oracle_update_table_input();
        let statements =
            vec!["ALTER TABLE \"NEXUS\".\"EMPLOYEES\" DROP COLUMN \"NAME\"".to_string()];

        let error = ensure_oracle_destructive_update_confirmed(&input, &statements).unwrap_err();

        assert!(error.message.contains("破坏性"));
    }

    #[test]
    fn accepts_oracle_destructive_update_with_confirmation() {
        let mut input = oracle_update_table_input();
        input.confirm_destructive = true;
        let statements =
            vec!["ALTER TABLE \"NEXUS\".\"EMPLOYEES\" DROP COLUMN \"NAME\"".to_string()];

        ensure_oracle_destructive_update_confirmed(&input, &statements).unwrap();
    }

    fn oracle_minimal_create_table_input() -> CreateTableInput {
        CreateTableInput {
            basics: TableSchemaBasics {
                table_name: "EMPLOYEES".to_string(),
                database_name: "FREEPDB1".to_string(),
                schema_name: "NEXUS".to_string(),
                engine: None,
                charset: None,
                collation: None,
                comment: Some("Employees".to_string()),
                partition: None,
            },
            columns: vec![
                TableColumnSchema {
                    name: "ID".to_string(),
                    type_name: "NUMBER(10,0)".to_string(),
                    nullable: false,
                    default_value: None,
                    is_primary_key: true,
                    is_unique: false,
                    is_identity: true,
                    comment: Some("Primary key".to_string()),
                    identity: Some(TableIdentityOptions {
                        generation: TableIdentityGeneration::ByDefault,
                        start: None,
                        increment: None,
                        min_value: None,
                        max_value: None,
                        cache: None,
                        cycle: false,
                    }),
                    generated: None,
                    charset: None,
                    collation: None,
                },
                TableColumnSchema {
                    name: "NAME".to_string(),
                    type_name: "VARCHAR2(80)".to_string(),
                    nullable: false,
                    default_value: Some("'unknown'".to_string()),
                    is_primary_key: false,
                    is_unique: false,
                    is_identity: false,
                    comment: None,
                    identity: None,
                    generated: None,
                    charset: None,
                    collation: None,
                },
            ],
            indexes: vec![TableIndexSchema {
                name: "IDX_EMP_NAME".to_string(),
                columns: vec!["NAME".to_string()],
                is_unique: false,
                method: None,
                comment: None,
            }],
            constraints: vec![TableConstraintSchema {
                name: "PK_EMPLOYEES".to_string(),
                kind: TableConstraintKind::PrimaryKey,
                columns: vec!["ID".to_string()],
                reference: None,
                expression: None,
                comment: None,
                foreign_key: None,
                enforced: Some(true),
            }],
        }
    }

    fn oracle_fk_constraint_with_on_update() -> TableConstraintSchema {
        TableConstraintSchema {
            name: "FK_EMP_DEPT".to_string(),
            kind: TableConstraintKind::ForeignKey,
            columns: vec!["DEPT_ID".to_string()],
            reference: None,
            expression: None,
            comment: None,
            foreign_key: Some(TableForeignKeyReference {
                database_name: None,
                schema_name: Some("NEXUS".to_string()),
                table_name: "DEPARTMENTS".to_string(),
                columns: vec!["ID".to_string()],
                on_update: Some(TableReferentialAction::Cascade),
                on_delete: None,
            }),
            enforced: Some(true),
        }
    }

    fn oracle_update_table_input() -> UpdateTableInput {
        let baseline = oracle_table_schema();
        UpdateTableInput {
            container: ContainerRef::table(
                ContainerKind::Table,
                "FREEPDB1",
                Some("NEXUS".to_string()),
                "EMPLOYEES",
            ),
            baseline: baseline.clone(),
            target: baseline,
            column_renames: Vec::new(),
            confirm_destructive: false,
        }
    }

    fn oracle_table_schema() -> TableSchema {
        TableSchema {
            basics: TableSchemaBasics {
                table_name: "EMPLOYEES".to_string(),
                database_name: "FREEPDB1".to_string(),
                schema_name: "NEXUS".to_string(),
                engine: None,
                charset: None,
                collation: None,
                comment: Some("Employees".to_string()),
                partition: None,
            },
            columns: vec![
                oracle_column("ID", "NUMBER(10,0)", false),
                oracle_column("NAME", "VARCHAR2(80)", true),
            ],
            indexes: vec![oracle_index("IDX_EMP_NAME", &["NAME"], false)],
            constraints: vec![TableConstraintSchema {
                name: "PK_EMPLOYEES".to_string(),
                kind: TableConstraintKind::PrimaryKey,
                columns: vec!["ID".to_string()],
                reference: None,
                expression: None,
                comment: None,
                foreign_key: None,
                enforced: Some(true),
            }],
        }
    }

    fn oracle_column(name: &str, type_name: &str, nullable: bool) -> TableColumnSchema {
        TableColumnSchema {
            name: name.to_string(),
            type_name: type_name.to_string(),
            nullable,
            default_value: None,
            is_primary_key: name == "ID",
            is_unique: name == "ID",
            is_identity: false,
            comment: None,
            identity: None,
            generated: None,
            charset: None,
            collation: None,
        }
    }

    fn oracle_index(name: &str, columns: &[&str], is_unique: bool) -> TableIndexSchema {
        TableIndexSchema {
            name: name.to_string(),
            columns: columns.iter().map(|column| (*column).to_string()).collect(),
            is_unique,
            method: None,
            comment: None,
        }
    }

    #[allow(dead_code)]
    fn oracle_virtual_column(name: &str) -> TableColumnSchema {
        TableColumnSchema {
            name: name.to_string(),
            type_name: "VARCHAR2(80)".to_string(),
            nullable: true,
            default_value: None,
            is_primary_key: false,
            is_unique: false,
            is_identity: false,
            comment: None,
            identity: None,
            generated: Some(TableGeneratedColumn {
                expression: "UPPER(\"NAME\")".to_string(),
                storage: TableGeneratedColumnStorage::Virtual,
            }),
            charset: None,
            collation: None,
        }
    }
}
