use super::*;

#[derive(Debug, Clone, Copy)]
pub struct TableUpdateDiffOptions {
    pub allow_column_comments: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommentChange {
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnCommentChange {
    pub column_name: String,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnDefaultChange {
    pub column_name: String,
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnNullabilityChange {
    pub column_name: String,
    pub nullable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnRenameChange {
    pub old_name: String,
    pub new_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnTypeChange {
    pub column_name: String,
    pub type_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnGeneratedChange {
    pub column_name: String,
    pub old_generated: Option<TableGeneratedColumn>,
    pub new_generated: Option<TableGeneratedColumn>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnIdentityChange {
    pub column_name: String,
    pub old_identity: Option<TableIdentityOptions>,
    pub new_identity: Option<TableIdentityOptions>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnCharsetChange {
    pub column_name: String,
    pub charset: Option<String>,
    pub collation: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrimaryKeyChange {
    pub old_constraint_name: Option<String>,
    pub old_columns: Vec<String>,
    pub new_columns: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TableSchemaUpdateDiff {
    pub table_comment_change: Option<CommentChange>,
    pub table_engine_change: Option<String>,
    pub table_charset_change: Option<String>,
    pub table_collation_change: Option<String>,
    pub table_partition_change: Option<TablePartitionOptions>,
    pub primary_key_change: Option<PrimaryKeyChange>,
    pub renamed_columns: Vec<ColumnRenameChange>,
    pub added_columns: Vec<TableColumnSchema>,
    pub dropped_columns: Vec<TableColumnSchema>,
    pub added_indexes: Vec<TableIndexSchema>,
    pub dropped_indexes: Vec<TableIndexSchema>,
    pub added_constraints: Vec<TableConstraintSchema>,
    pub dropped_constraints: Vec<TableConstraintSchema>,
    pub added_or_modified_constraints: Vec<TableConstraintSchema>,
    pub column_type_changes: Vec<ColumnTypeChange>,
    pub column_comment_changes: Vec<ColumnCommentChange>,
    pub column_default_changes: Vec<ColumnDefaultChange>,
    pub column_nullability_changes: Vec<ColumnNullabilityChange>,
    pub generated_column_changes: Vec<ColumnGeneratedChange>,
    pub identity_changes: Vec<ColumnIdentityChange>,
    pub column_charset_changes: Vec<ColumnCharsetChange>,
}

impl TableSchemaUpdateDiff {
    pub fn is_empty(&self) -> bool {
        self.table_comment_change.is_none()
            && self.table_engine_change.is_none()
            && self.table_charset_change.is_none()
            && self.table_collation_change.is_none()
            && self.table_partition_change.is_none()
            && self.primary_key_change.is_none()
            && self.renamed_columns.is_empty()
            && self.added_columns.is_empty()
            && self.dropped_columns.is_empty()
            && self.added_indexes.is_empty()
            && self.dropped_indexes.is_empty()
            && self.added_constraints.is_empty()
            && self.dropped_constraints.is_empty()
            && self.added_or_modified_constraints.is_empty()
            && self.column_type_changes.is_empty()
            && self.column_comment_changes.is_empty()
            && self.column_default_changes.is_empty()
            && self.column_nullability_changes.is_empty()
            && self.generated_column_changes.is_empty()
            && self.identity_changes.is_empty()
            && self.column_charset_changes.is_empty()
    }

    pub fn is_destructive(&self) -> bool {
        !self.dropped_columns.is_empty()
            || !self.column_type_changes.is_empty()
            || !self.dropped_constraints.is_empty()
            || !self.generated_column_changes.is_empty()
            || self
                .identity_changes
                .iter()
                .any(|change| change.old_identity.is_some())
            || self.primary_key_change.is_some()
    }
}

#[cfg(test)]
pub fn diff_table_schema_for_update(
    baseline: &TableSchema,
    target: &TableSchema,
    options: TableUpdateDiffOptions,
) -> IpcResult<TableSchemaUpdateDiff> {
    diff_table_schema_for_update_with_column_renames(baseline, target, options, &[])
}

pub fn diff_table_schema_for_update_with_column_renames(
    baseline: &TableSchema,
    target: &TableSchema,
    options: TableUpdateDiffOptions,
    column_renames: &[TableColumnRename],
) -> IpcResult<TableSchemaUpdateDiff> {
    ensure_same_table_identity(baseline, target)?;

    let baseline_columns = schema_columns_by_name(&baseline.columns)?;
    let target_columns = schema_columns_by_name(&target.columns)?;
    validate_target_column_references(&target.columns, &target.indexes, &target.constraints)?;
    let rename_map = validate_column_renames(column_renames, &baseline_columns, &target_columns)?;
    let mut diff = TableSchemaUpdateDiff::default();

    let baseline_engine = normalized_optional_text(baseline.basics.engine.as_deref());
    let target_engine = normalized_optional_text(target.basics.engine.as_deref());
    if baseline_engine != target_engine {
        diff.table_engine_change = target_engine;
    }

    let baseline_charset = normalized_optional_text(baseline.basics.charset.as_deref());
    let target_charset = normalized_optional_text(target.basics.charset.as_deref());
    if baseline_charset != target_charset {
        diff.table_charset_change = target_charset;
    }

    let baseline_collation = normalized_optional_text(baseline.basics.collation.as_deref());
    let target_collation = normalized_optional_text(target.basics.collation.as_deref());
    if baseline_collation != target_collation {
        diff.table_collation_change = target_collation;
    }

    if normalized_partition_options(baseline.basics.partition.as_ref())
        != normalized_partition_options(target.basics.partition.as_ref())
    {
        return unsupported_table_update("暂不支持修改已有表分区；请通过手写 DDL 管理分区迁移");
    }

    diff.renamed_columns = column_renames
        .iter()
        .map(|rename| ColumnRenameChange {
            old_name: rename.old_name.trim().to_string(),
            new_name: rename.new_name.trim().to_string(),
        })
        .collect();

    let baseline_primary_key = primary_key_definition(baseline)?;
    let target_primary_key = primary_key_definition(target)?;
    if baseline_primary_key.columns != target_primary_key.columns {
        diff.primary_key_change = Some(PrimaryKeyChange {
            old_constraint_name: baseline_primary_key.name,
            old_columns: baseline_primary_key.columns,
            new_columns: target_primary_key.columns,
        });
    }

    diff_non_primary_constraints(baseline, target, &mut diff)?;

    let baseline_comment = normalized_optional_text(baseline.basics.comment.as_deref());
    let target_comment = normalized_optional_text(target.basics.comment.as_deref());
    if baseline_comment != target_comment {
        diff.table_comment_change = Some(CommentChange {
            comment: target_comment,
        });
    }

    for column in &baseline.columns {
        let target_name = rename_map
            .get(column.name.as_str())
            .map(String::as_str)
            .unwrap_or(column.name.as_str());
        let Some(target_column) = target_columns.get(target_name) else {
            diff.dropped_columns.push(column.clone());
            continue;
        };

        ensure_supported_column_update(column, target_column, options)?;
        if normalized_sql_type(&column.type_name) != normalized_sql_type(&target_column.type_name) {
            diff.column_type_changes.push(ColumnTypeChange {
                column_name: target_column.name.clone(),
                type_name: target_column.type_name.trim().to_string(),
            });
        }
        let baseline_default = normalized_optional_text(column.default_value.as_deref());
        let target_default = normalized_optional_text(target_column.default_value.as_deref());
        if baseline_default != target_default {
            diff.column_default_changes.push(ColumnDefaultChange {
                column_name: target_column.name.clone(),
                default_value: target_default,
            });
        }

        if column.nullable != target_column.nullable {
            diff.column_nullability_changes
                .push(ColumnNullabilityChange {
                    column_name: target_column.name.clone(),
                    nullable: target_column.nullable,
                });
        }

        let baseline_generated = normalized_generated_column(column.generated.as_ref())?;
        let target_generated = normalized_generated_column(target_column.generated.as_ref())?;
        if baseline_generated != target_generated {
            diff.generated_column_changes.push(ColumnGeneratedChange {
                column_name: target_column.name.clone(),
                old_generated: baseline_generated,
                new_generated: target_generated,
            });
        }

        let baseline_identity = normalized_column_identity(column);
        let target_identity = normalized_column_identity(target_column);
        if baseline_identity != target_identity {
            diff.identity_changes.push(ColumnIdentityChange {
                column_name: target_column.name.clone(),
                old_identity: baseline_identity,
                new_identity: target_identity,
            });
        }

        let baseline_charset = normalized_optional_text(column.charset.as_deref());
        let target_charset = normalized_optional_text(target_column.charset.as_deref());
        let baseline_collation = normalized_optional_text(column.collation.as_deref());
        let target_collation = normalized_optional_text(target_column.collation.as_deref());
        if baseline_charset != target_charset || baseline_collation != target_collation {
            diff.column_charset_changes.push(ColumnCharsetChange {
                column_name: target_column.name.clone(),
                charset: target_charset,
                collation: target_collation,
            });
        }

        let baseline_comment = normalized_optional_text(column.comment.as_deref());
        let target_comment = normalized_optional_text(target_column.comment.as_deref());
        if baseline_comment != target_comment {
            if options.allow_column_comments {
                diff.column_comment_changes.push(ColumnCommentChange {
                    column_name: target_column.name.clone(),
                    comment: target_comment,
                });
            } else {
                return unsupported_table_update(format!(
                    "暂不支持修改列 '{}' 的备注",
                    column.name
                ));
            }
        }
    }

    for column in &target.columns {
        let is_renamed_target = rename_map
            .values()
            .any(|new_name| new_name.as_str() == column.name.as_str());
        if !baseline_columns.contains_key(column.name.as_str()) && !is_renamed_target {
            validate_added_column_for_update(column)?;
            diff.added_columns.push(column.clone());
        }
    }

    let baseline_indexes = schema_indexes_by_name(&baseline.indexes)?;
    let target_indexes = schema_indexes_by_name(&target.indexes)?;

    for index in &baseline.indexes {
        match target_indexes.get(index.name.as_str()) {
            Some(target_index) => {
                if index_changed(index, target_index) {
                    diff.dropped_indexes.push(index.clone());
                    diff.added_indexes.push((*target_index).clone());
                }
            }
            None => diff.dropped_indexes.push(index.clone()),
        }
    }

    for index in &target.indexes {
        if !baseline_indexes.contains_key(index.name.as_str()) {
            diff.added_indexes.push(index.clone());
        }
    }

    Ok(diff)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PrimaryKeyDefinition {
    name: Option<String>,
    columns: Vec<String>,
}

fn validate_column_renames(
    column_renames: &[TableColumnRename],
    baseline_columns: &HashMap<&str, &TableColumnSchema>,
    target_columns: &HashMap<&str, &TableColumnSchema>,
) -> IpcResult<HashMap<String, String>> {
    let mut by_old = HashMap::new();
    let mut seen_new = HashSet::new();

    for rename in column_renames {
        let old_name = normalized_non_empty_identifier(&rename.old_name, "原列名")?;
        let new_name = normalized_non_empty_identifier(&rename.new_name, "新列名")?;
        if old_name == new_name {
            continue;
        }
        if !baseline_columns.contains_key(old_name.as_str()) {
            return Err(IpcError::validation_failed(format!(
                "原列 '{}' 不存在，无法重命名",
                old_name
            )));
        }
        if !target_columns.contains_key(new_name.as_str()) {
            return Err(IpcError::validation_failed(format!(
                "目标列 '{}' 不存在，无法重命名",
                new_name
            )));
        }
        if by_old.insert(old_name.clone(), new_name.clone()).is_some() {
            return Err(IpcError::validation_failed(format!(
                "列 '{}' 的重命名规则重复",
                old_name
            )));
        }
        if !seen_new.insert(new_name.clone()) {
            return Err(IpcError::validation_failed(format!(
                "目标列 '{}' 的重命名规则重复",
                new_name
            )));
        }
    }

    Ok(by_old)
}

fn primary_key_definition(schema: &TableSchema) -> IpcResult<PrimaryKeyDefinition> {
    let mut primary_constraints = schema
        .constraints
        .iter()
        .filter(|constraint| constraint.kind == TableConstraintKind::PrimaryKey);
    let primary_constraint = primary_constraints.next();
    if primary_constraints.next().is_some() {
        return Err(IpcError::validation_failed("只能定义一个主键约束"));
    }

    let columns_from_flags = schema
        .columns
        .iter()
        .filter(|column| column.is_primary_key)
        .map(|column| column.name.clone())
        .collect::<Vec<_>>();

    match primary_constraint {
        Some(constraint) => {
            let columns = constraint
                .columns
                .iter()
                .map(|column| normalized_non_empty_identifier(column, "主键列"))
                .collect::<IpcResult<Vec<_>>>()?;
            if !columns_from_flags.is_empty() && columns_from_flags != columns {
                return Err(IpcError::validation_failed(
                    "列定义中的主键与约束区主键不一致",
                ));
            }
            Ok(PrimaryKeyDefinition {
                name: normalized_optional_text(Some(constraint.name.as_str())),
                columns,
            })
        }
        None => Ok(PrimaryKeyDefinition {
            name: None,
            columns: columns_from_flags,
        }),
    }
}

fn normalized_sql_type(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn diff_non_primary_constraints(
    baseline: &TableSchema,
    target: &TableSchema,
    diff: &mut TableSchemaUpdateDiff,
) -> IpcResult<()> {
    let baseline_constraints = schema_non_primary_constraints_by_name(&baseline.constraints)?;
    let target_constraints = schema_non_primary_constraints_by_name(&target.constraints)?;

    for (name, baseline_constraint) in &baseline_constraints {
        match target_constraints.get(name.as_str()) {
            Some(target_constraint) => {
                if baseline_constraint != target_constraint {
                    diff.dropped_constraints.push(baseline_constraint.clone());
                    diff.added_constraints.push(target_constraint.clone());
                    diff.added_or_modified_constraints
                        .push(target_constraint.clone());
                }
            }
            None => diff.dropped_constraints.push(baseline_constraint.clone()),
        }
    }

    for (name, target_constraint) in &target_constraints {
        if !baseline_constraints.contains_key(name.as_str()) {
            diff.added_constraints.push(target_constraint.clone());
            diff.added_or_modified_constraints
                .push(target_constraint.clone());
        }
    }

    Ok(())
}

fn schema_non_primary_constraints_by_name(
    constraints: &[TableConstraintSchema],
) -> IpcResult<HashMap<String, TableConstraintSchema>> {
    let mut map = HashMap::new();
    for constraint in constraints
        .iter()
        .filter(|constraint| constraint.kind != TableConstraintKind::PrimaryKey)
    {
        let normalized = normalized_non_primary_constraint(constraint)?;
        if map
            .insert(normalized.name.to_ascii_lowercase(), normalized.clone())
            .is_some()
        {
            return Err(IpcError::validation_failed(format!(
                "约束 '{}' 重复",
                normalized.name
            )));
        }
    }
    Ok(map)
}

fn normalized_non_primary_constraint(
    constraint: &TableConstraintSchema,
) -> IpcResult<TableConstraintSchema> {
    let name = normalized_non_empty_identifier(&constraint.name, "约束名")?;
    let columns = constraint
        .columns
        .iter()
        .map(|column| normalized_non_empty_identifier(column, "约束列"))
        .collect::<IpcResult<Vec<_>>>()?;
    let reference = normalized_optional_text(constraint.reference.as_deref());
    let expression = normalized_optional_fragment(constraint.expression.as_deref(), "约束表达式")?;
    let comment = normalized_optional_text(constraint.comment.as_deref());
    let foreign_key = normalized_foreign_key_reference(constraint.foreign_key.as_ref())?;

    match constraint.kind {
        TableConstraintKind::ForeignKey => {
            let Some(foreign_key) = foreign_key.as_ref() else {
                return Err(IpcError::validation_failed(format!(
                    "外键约束 '{}' 需要引用表和引用列",
                    name
                )));
            };
            if columns.is_empty() {
                return Err(IpcError::validation_failed(format!(
                    "外键约束 '{}' 需要本地列",
                    name
                )));
            }
            if foreign_key.columns.len() != columns.len() {
                return Err(IpcError::validation_failed(format!(
                    "外键约束 '{}' 的本地列与引用列数量必须一致",
                    name
                )));
            }
        }
        TableConstraintKind::Check => {
            if expression.is_none() {
                return Err(IpcError::validation_failed(format!(
                    "CHECK 约束 '{}' 需要表达式",
                    name
                )));
            }
        }
        TableConstraintKind::Unique => {
            if columns.is_empty() {
                return Err(IpcError::validation_failed(format!(
                    "唯一约束 '{}' 需要至少一个列",
                    name
                )));
            }
        }
        TableConstraintKind::PrimaryKey => {}
    }

    Ok(TableConstraintSchema {
        name,
        kind: constraint.kind.clone(),
        columns,
        reference,
        expression,
        comment,
        foreign_key,
        enforced: constraint.enforced,
    })
}

fn normalized_foreign_key_reference(
    reference: Option<&TableForeignKeyReference>,
) -> IpcResult<Option<TableForeignKeyReference>> {
    let Some(reference) = reference else {
        return Ok(None);
    };
    let table_name = normalized_non_empty_identifier(&reference.table_name, "引用表")?;
    let columns = reference
        .columns
        .iter()
        .map(|column| normalized_non_empty_identifier(column, "引用列"))
        .collect::<IpcResult<Vec<_>>>()?;
    if columns.is_empty() {
        return Err(IpcError::validation_failed("外键约束需要至少一个引用列"));
    }

    Ok(Some(TableForeignKeyReference {
        database_name: normalized_optional_text(reference.database_name.as_deref()),
        schema_name: normalized_optional_text(reference.schema_name.as_deref()),
        table_name,
        columns,
        on_update: reference.on_update.clone(),
        on_delete: reference.on_delete.clone(),
    }))
}

fn normalized_generated_column(
    generated: Option<&TableGeneratedColumn>,
) -> IpcResult<Option<TableGeneratedColumn>> {
    let Some(generated) = generated else {
        return Ok(None);
    };
    let expression = normalized_sql_fragment(&generated.expression, "生成列表达式")?;
    Ok(Some(TableGeneratedColumn {
        expression,
        storage: generated.storage.clone(),
    }))
}

fn normalized_column_identity(column: &TableColumnSchema) -> Option<TableIdentityOptions> {
    column.identity.clone().or(if column.is_identity {
        Some(TableIdentityOptions {
            generation: crate::engine::types::TableIdentityGeneration::ByDefault,
            start: None,
            increment: None,
            min_value: None,
            max_value: None,
            cache: None,
            cycle: false,
        })
    } else {
        None
    })
}

fn normalized_partition_options(
    partition: Option<&TablePartitionOptions>,
) -> Option<TablePartitionOptions> {
    partition.and_then(|partition| {
        let expression = normalized_optional_text(partition.expression.as_deref());
        let raw_clause = normalized_optional_text(partition.raw_clause.as_deref());
        let readonly_description =
            normalized_optional_text(partition.readonly_description.as_deref());
        if expression.is_none() && raw_clause.is_none() && readonly_description.is_none() {
            None
        } else {
            Some(TablePartitionOptions {
                expression,
                raw_clause,
                readonly_description,
            })
        }
    })
}

fn ensure_same_table_identity(baseline: &TableSchema, target: &TableSchema) -> IpcResult<()> {
    let baseline_identity = (
        baseline.basics.database_name.trim(),
        baseline.basics.schema_name.trim(),
        baseline.basics.table_name.trim(),
    );
    let target_identity = (
        target.basics.database_name.trim(),
        target.basics.schema_name.trim(),
        target.basics.table_name.trim(),
    );

    if baseline_identity == target_identity {
        Ok(())
    } else {
        unsupported_table_update("暂不支持通过表设计器重命名或移动表")
    }
}

fn ensure_supported_column_update(
    baseline: &TableColumnSchema,
    target: &TableColumnSchema,
    _options: TableUpdateDiffOptions,
) -> IpcResult<()> {
    if normalized_sql_type(&baseline.type_name) != normalized_sql_type(&target.type_name)
        && (baseline.is_identity || target.is_identity)
    {
        return unsupported_table_update(format!(
            "暂不支持修改自增列 '{}' 的数据类型",
            baseline.name
        ));
    }
    if baseline.nullable != target.nullable {
        if baseline.is_primary_key {
            return unsupported_table_update(format!(
                "暂不支持修改主键列 '{}' 的可空属性",
                baseline.name
            ));
        }
        if baseline.is_identity {
            return unsupported_table_update(format!(
                "暂不支持修改自增列 '{}' 的可空属性",
                baseline.name
            ));
        }
    }
    if baseline.is_identity
        && normalized_optional_text(baseline.default_value.as_deref())
            != normalized_optional_text(target.default_value.as_deref())
    {
        return unsupported_table_update(format!(
            "暂不支持修改自增列 '{}' 的默认值",
            baseline.name
        ));
    }
    if baseline.is_primary_key != target.is_primary_key && target.is_primary_key && target.nullable
    {
        return Err(IpcError::validation_failed(format!(
            "主键列 '{}' 必须为 NOT NULL",
            target.name
        )));
    }
    if baseline.is_unique != target.is_unique {
        return unsupported_table_update(format!(
            "暂不支持直接修改列 '{}' 的唯一属性；请在索引区管理唯一索引",
            baseline.name
        ));
    }
    Ok(())
}

fn index_changed(baseline: &TableIndexSchema, target: &TableIndexSchema) -> bool {
    baseline.columns != target.columns
        || baseline.is_unique != target.is_unique
        || normalized_optional_text(baseline.method.as_deref())
            != normalized_optional_text(target.method.as_deref())
        || normalized_optional_text(baseline.comment.as_deref())
            != normalized_optional_text(target.comment.as_deref())
}

fn validate_added_column_for_update(column: &TableColumnSchema) -> IpcResult<()> {
    normalized_non_empty_identifier(&column.name, "列名")?;
    if column.is_primary_key {
        return unsupported_table_update(format!("暂不支持新增主键列 '{}'", column.name));
    }
    if column.is_unique {
        return unsupported_table_update(format!("暂不支持直接新增唯一列 '{}'", column.name));
    }
    if !column.nullable
        && !column.is_identity
        && normalized_optional_text(column.default_value.as_deref()).is_none()
    {
        return Err(IpcError::validation_failed(format!(
            "新增 NOT NULL 列 '{}' 需要默认值",
            column.name
        )));
    }
    Ok(())
}

fn validate_target_column_references(
    columns: &[TableColumnSchema],
    indexes: &[TableIndexSchema],
    constraints: &[TableConstraintSchema],
) -> IpcResult<()> {
    let names = columns
        .iter()
        .map(|column| column.name.as_str())
        .collect::<HashSet<_>>();

    for index in indexes {
        for column in &index.columns {
            if !names.contains(column.as_str()) {
                return Err(IpcError::validation_failed(format!(
                    "索引 '{}' 引用了不存在的列 '{}'",
                    index.name, column
                )));
            }
        }
    }

    for constraint in constraints {
        for column in &constraint.columns {
            if !names.contains(column.as_str()) {
                return Err(IpcError::validation_failed(format!(
                    "约束 '{}' 引用了不存在的列 '{}'",
                    constraint.name, column
                )));
            }
        }
    }

    Ok(())
}

fn schema_columns_by_name(
    columns: &[TableColumnSchema],
) -> IpcResult<HashMap<&str, &TableColumnSchema>> {
    let mut map = HashMap::new();
    for column in columns {
        normalized_non_empty_identifier(&column.name, "列名")?;
        if map.insert(column.name.as_str(), column).is_some() {
            return Err(IpcError::validation_failed(format!(
                "列 '{}' 重复",
                column.name
            )));
        }
    }
    Ok(map)
}

fn schema_indexes_by_name(
    indexes: &[TableIndexSchema],
) -> IpcResult<HashMap<&str, &TableIndexSchema>> {
    let mut map = HashMap::new();
    for index in indexes {
        normalized_non_empty_identifier(&index.name, "索引名")?;
        if map.insert(index.name.as_str(), index).is_some() {
            return Err(IpcError::validation_failed(format!(
                "索引 '{}' 重复",
                index.name
            )));
        }
    }
    Ok(map)
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

fn unsupported_table_update<T>(message: impl Into<String>) -> IpcResult<T> {
    Err(IpcError::validation_failed(message))
}
