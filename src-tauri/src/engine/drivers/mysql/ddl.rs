use super::*;

#[derive(Clone)]
pub(super) struct NamedColumnList {
    pub(super) name: Option<String>,
    pub(super) columns: Vec<String>,
}

pub(super) struct NormalizedCreateTable {
    pub(super) columns: Vec<TableColumnSchema>,
    pub(super) column_names: HashSet<String>,
    pub(super) primary_key_columns: Vec<String>,
    pub(super) unique_constraints: Vec<NamedColumnList>,
    pub(super) table_constraints: Vec<TableConstraintSchema>,
    pub(super) indexes: Vec<TableIndexSchema>,
}

pub(super) fn normalize_create_table_input(
    input: &CreateTableInput,
) -> IpcResult<NormalizedCreateTable> {
    if input.columns.is_empty() {
        return Err(IpcError::validation_failed("请至少添加一列"));
    }

    let mut seen_columns = HashSet::new();
    let mut column_names = HashSet::new();
    let mut columns = Vec::with_capacity(input.columns.len());
    let mut primary_key_from_columns = Vec::new();
    let mut unique_constraints = Vec::new();
    let mut table_constraints = Vec::new();

    for column in &input.columns {
        let name = normalized_non_empty_identifier(&column.name, "列名")?;
        let duplicate_key = name.to_ascii_lowercase();
        if !seen_columns.insert(duplicate_key) {
            return Err(IpcError::validation_failed(format!("列名 '{name}' 重复")));
        }
        let type_name = normalized_sql_fragment(&column.type_name, "列类型")?;
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
            charset: normalized_optional_fragment(column.charset.as_deref(), "列字符集")?,
            collation: normalized_optional_fragment(column.collation.as_deref(), "列排序规则")?,
            comment,
        });
    }

    let mut primary_key_from_constraints: Option<Vec<String>> = None;
    for constraint in &input.constraints {
        match constraint.kind {
            TableConstraintKind::PrimaryKey => {
                if primary_key_from_constraints.is_some() {
                    return Err(IpcError::validation_failed("只能定义一个主键约束"));
                }
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
            TableConstraintKind::ForeignKey => {
                let name = normalized_non_empty_identifier(&constraint.name, "外键约束名")?;
                let columns = validate_column_refs(&constraint.columns, &column_names, "外键列")?;
                let Some(foreign_key) = constraint.foreign_key.as_ref() else {
                    return Err(IpcError::validation_failed(format!(
                        "外键约束 '{}' 需要引用表和引用列",
                        name
                    )));
                };
                let referenced_table =
                    normalized_non_empty_identifier(&foreign_key.table_name, "引用表")?;
                let referenced_columns = foreign_key
                    .columns
                    .iter()
                    .map(|column| normalized_non_empty_identifier(column, "引用列"))
                    .collect::<IpcResult<Vec<_>>>()?;
                if referenced_columns.len() != columns.len() {
                    return Err(IpcError::validation_failed(format!(
                        "外键约束 '{}' 的本地列与引用列数量必须一致",
                        name
                    )));
                }
                table_constraints.push(TableConstraintSchema {
                    name,
                    kind: TableConstraintKind::ForeignKey,
                    columns,
                    reference: None,
                    expression: None,
                    comment: normalized_optional_text(constraint.comment.as_deref()),
                    foreign_key: Some(crate::engine::types::TableForeignKeyReference {
                        database_name: normalized_optional_text(
                            foreign_key.database_name.as_deref(),
                        ),
                        schema_name: normalized_optional_text(foreign_key.schema_name.as_deref()),
                        table_name: referenced_table,
                        columns: referenced_columns,
                        on_update: foreign_key.on_update.clone(),
                        on_delete: foreign_key.on_delete.clone(),
                    }),
                    enforced: constraint.enforced,
                });
            }
            TableConstraintKind::Check => {
                let name = normalized_non_empty_identifier(&constraint.name, "CHECK 约束名")?;
                let expression = normalized_sql_fragment(
                    constraint.expression.as_deref().unwrap_or_default(),
                    "CHECK 表达式",
                )?;
                table_constraints.push(TableConstraintSchema {
                    name,
                    kind: TableConstraintKind::Check,
                    columns: validate_optional_column_refs(
                        &constraint.columns,
                        &column_names,
                        "CHECK 约束列",
                    )?,
                    reference: None,
                    expression: Some(expression),
                    comment: normalized_optional_text(constraint.comment.as_deref()),
                    foreign_key: None,
                    enforced: constraint.enforced,
                });
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
            let method = normalized_optional_fragment(index.method.as_deref(), "索引方法")?;
            let comment = normalized_optional_text(index.comment.as_deref());
            Ok(TableIndexSchema {
                name,
                columns: validate_column_refs(&index.columns, &column_names, "索引列")?,
                is_unique: index.is_unique,
                method,
                comment,
            })
        })
        .collect::<IpcResult<Vec<_>>>()?;

    Ok(NormalizedCreateTable {
        columns,
        column_names,
        primary_key_columns,
        unique_constraints,
        table_constraints,
        indexes,
    })
}

pub(super) fn mysql_column_definition(column: &TableColumnSchema) -> IpcResult<String> {
    let mut definition = format!(
        "{} {}",
        quote_mysql_identifier(&column.name),
        normalized_sql_fragment(&column.type_name, "列类型")?
    );

    if let Some(charset) = normalized_optional_fragment(column.charset.as_deref(), "列字符集")?
    {
        definition.push_str(" CHARACTER SET ");
        definition.push_str(&charset);
    }

    if let Some(collation) =
        normalized_optional_fragment(column.collation.as_deref(), "列排序规则")?
    {
        definition.push_str(" COLLATE ");
        definition.push_str(&collation);
    }

    if let Some(generated) = column.generated.as_ref() {
        if normalized_optional_text(column.default_value.as_deref()).is_some() {
            return Err(IpcError::validation_failed("生成列不能同时设置默认值"));
        }
        definition.push_str(" GENERATED ALWAYS AS (");
        definition.push_str(&normalized_sql_fragment(
            &generated.expression,
            "生成列表达式",
        )?);
        definition.push(')');
        definition.push_str(match generated.storage {
            crate::engine::types::TableGeneratedColumnStorage::Virtual => " VIRTUAL",
            crate::engine::types::TableGeneratedColumnStorage::Stored => " STORED",
        });
        if let Some(comment) = normalized_optional_text(column.comment.as_deref()) {
            definition.push_str(" COMMENT ");
            definition.push_str(&render_sql_literal(&Value::String(comment))?);
        }
        return Ok(definition);
    }

    let is_identity = column.is_identity || column.identity.is_some();
    if column.is_primary_key || is_identity || !column.nullable {
        definition.push_str(" NOT NULL");
    } else {
        definition.push_str(" NULL");
    }

    if let Some(default_value) =
        normalized_optional_fragment(column.default_value.as_deref(), "默认值")?
    {
        definition.push_str(" DEFAULT ");
        definition.push_str(&default_value);
    }

    if is_identity {
        definition.push_str(" AUTO_INCREMENT");
    }

    if let Some(comment) = normalized_optional_text(column.comment.as_deref()) {
        definition.push_str(" COMMENT ");
        definition.push_str(&render_sql_literal(&Value::String(comment))?);
    }

    Ok(definition)
}

pub(super) fn mysql_table_constraint_definition(
    constraint: &TableConstraintSchema,
) -> IpcResult<String> {
    let name = normalized_non_empty_identifier(&constraint.name, "约束名")?;
    match constraint.kind {
        TableConstraintKind::ForeignKey => {
            let Some(foreign_key) = constraint.foreign_key.as_ref() else {
                return Err(IpcError::validation_failed(format!(
                    "外键约束 '{}' 需要引用表和引用列",
                    name
                )));
            };
            let referenced_table = mysql_referenced_table_name(
                foreign_key.database_name.as_deref(),
                &foreign_key.table_name,
            )?;
            let mut definition = format!(
                "CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
                quote_mysql_identifier(&name),
                quote_column_list(&constraint.columns, quote_mysql_identifier),
                referenced_table,
                quote_column_list(&foreign_key.columns, quote_mysql_identifier)
            );
            if let Some(action) = foreign_key.on_update.as_ref() {
                definition.push_str(" ON UPDATE ");
                definition.push_str(mysql_referential_action(action));
            }
            if let Some(action) = foreign_key.on_delete.as_ref() {
                definition.push_str(" ON DELETE ");
                definition.push_str(mysql_referential_action(action));
            }
            Ok(definition)
        }
        TableConstraintKind::Check => {
            let expression = normalized_sql_fragment(
                constraint.expression.as_deref().unwrap_or_default(),
                "CHECK 表达式",
            )?;
            let mut definition = format!(
                "CONSTRAINT {} CHECK ({})",
                quote_mysql_identifier(&name),
                expression
            );
            if let Some(enforced) = constraint.enforced {
                definition.push_str(if enforced {
                    " ENFORCED"
                } else {
                    " NOT ENFORCED"
                });
            }
            Ok(definition)
        }
        TableConstraintKind::PrimaryKey | TableConstraintKind::Unique => Err(
            IpcError::validation_failed("该约束类型不应通过 MySQL advanced renderer 渲染"),
        ),
    }
}

pub(super) fn mysql_drop_constraint_statement(
    table_name: &str,
    constraint: &TableConstraintSchema,
) -> IpcResult<String> {
    let name = normalized_non_empty_identifier(&constraint.name, "约束名")?;
    let keyword = match constraint.kind {
        TableConstraintKind::ForeignKey => "DROP FOREIGN KEY",
        TableConstraintKind::Check => "DROP CHECK",
        TableConstraintKind::Unique => "DROP INDEX",
        TableConstraintKind::PrimaryKey => "DROP PRIMARY KEY",
    };
    if constraint.kind == TableConstraintKind::PrimaryKey {
        Ok(format!("ALTER TABLE {table_name} {keyword}"))
    } else {
        Ok(format!(
            "ALTER TABLE {table_name} {keyword} {}",
            quote_mysql_identifier(&name)
        ))
    }
}

pub(super) fn mysql_referenced_table_name(
    database: Option<&str>,
    table: &str,
) -> IpcResult<String> {
    let table = normalized_non_empty_identifier(table, "引用表")?;
    match normalized_optional_text(database) {
        Some(database) => Ok(format!(
            "{}.{}",
            quote_mysql_identifier(&database),
            quote_mysql_identifier(&table)
        )),
        None => Ok(quote_mysql_identifier(&table)),
    }
}

pub(super) fn mysql_referential_action(
    action: &crate::engine::types::TableReferentialAction,
) -> &'static str {
    match action {
        crate::engine::types::TableReferentialAction::NoAction => "NO ACTION",
        crate::engine::types::TableReferentialAction::Restrict => "RESTRICT",
        crate::engine::types::TableReferentialAction::Cascade => "CASCADE",
        crate::engine::types::TableReferentialAction::SetNull => "SET NULL",
        crate::engine::types::TableReferentialAction::SetDefault => "SET DEFAULT",
    }
}

pub(super) fn mysql_parse_referential_action(
    value: Option<&str>,
) -> Option<TableReferentialAction> {
    match value?.trim().to_ascii_uppercase().as_str() {
        "NO ACTION" => Some(TableReferentialAction::NoAction),
        "RESTRICT" => Some(TableReferentialAction::Restrict),
        "CASCADE" => Some(TableReferentialAction::Cascade),
        "SET NULL" => Some(TableReferentialAction::SetNull),
        "SET DEFAULT" => Some(TableReferentialAction::SetDefault),
        _ => None,
    }
}

pub(super) fn validate_column_refs(
    columns: &[String],
    column_names: &HashSet<String>,
    label: &str,
) -> IpcResult<Vec<String>> {
    if columns.is_empty() {
        return Err(IpcError::validation_failed(format!(
            "请至少填写一个{label}"
        )));
    }

    let mut seen = HashSet::new();
    let mut refs = Vec::with_capacity(columns.len());
    for column in columns {
        let column = normalized_non_empty_identifier(column, label)?;
        if !column_names.contains(&column) {
            return Err(IpcError::validation_failed(format!(
                "{label} '{column}' 不存在"
            )));
        }
        if !seen.insert(column.clone()) {
            return Err(IpcError::validation_failed(format!(
                "{label} '{column}' 重复"
            )));
        }
        refs.push(column);
    }

    Ok(refs)
}

pub(super) fn validate_optional_column_refs(
    columns: &[String],
    column_names: &HashSet<String>,
    label: &str,
) -> IpcResult<Vec<String>> {
    if columns.is_empty() {
        return Ok(Vec::new());
    }

    validate_column_refs(columns, column_names, label)
}

pub(super) fn quote_column_list(
    columns: &[String],
    quote_identifier: fn(&str) -> String,
) -> String {
    columns
        .iter()
        .map(|column| quote_identifier(column))
        .collect::<Vec<_>>()
        .join(", ")
}

pub(super) fn normalized_optional_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub(super) fn normalized_optional_fragment(
    value: Option<&str>,
    label: &str,
) -> IpcResult<Option<String>> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| normalized_sql_fragment(value, label))
        .transpose()
}

pub(super) fn normalized_sql_fragment(value: &str, label: &str) -> IpcResult<String> {
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

pub(super) fn ensure_schema_matches_mysql_table_parts(
    schema: &TableSchema,
    database: &str,
    table: &str,
) -> IpcResult<()> {
    if schema.basics.database_name.trim() == database && schema.basics.table_name.trim() == table {
        Ok(())
    } else {
        Err(IpcError::validation_failed(
            "表结构草稿与当前表不匹配，请刷新后重试",
        ))
    }
}
