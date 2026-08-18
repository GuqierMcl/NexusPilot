use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures_util::TryStreamExt;
use serde_json::Value;
use sqlx::mysql::{
    MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlQueryResult, MySqlRow, MySqlSslMode,
};
use sqlx::pool::PoolConnection;
use sqlx::{Column, Executor, MySql, Row, TypeInfo, ValueRef};
use tokio::sync::Mutex;

use crate::engine::driver::{
    DataTableBrowser, DatabaseDriver, SchemaBrowser, SchemaMutator, SqlExecutor, TransactionManager,
};
use crate::engine::drivers::common::{
    build_table_change_set_preview, classify_sqlx_connection_error, classify_sqlx_query_error,
    diff_table_schema_for_update_with_column_renames, ensure_real_table_for_mutation,
    json_i64_for_js_transport, json_u64_for_js_transport, mysql_empty_insert_statement,
    normalized_non_empty_identifier, quote_mysql_identifier, render_sql_literal,
    sql_is_single_statement, sql_should_report_affected_rows, table_browse_sql_plan,
    table_page_stats, TableBrowseBindValue, TableBrowsePlaceholderStyle, TableUpdateDiffOptions,
};
use crate::engine::profiles::MysqlProfile;
use crate::engine::ssh_tunnel::{self, SshTunnelRuntime};
use crate::engine::types::{
    AssetGroupType, ColumnDataCategory, ColumnMeta, ContainerKind, ContainerRef,
    CreateDatabaseInput, CreateDatabaseResult, CreateTableInput, CreateTableResult, DataContainer,
    DatabaseCharacterSet, DriverCapabilities, DropDatabaseInput, DropDatabaseResult,
    DropTableInput, DropTableResult, PingResult, QueryResult, SchemaMutationFeatures,
    SchemaMutationPreview, SqlExecutionContext, TableBrowseQuery, TableCellChange,
    TableChangeOutcome, TableChangeSetCommitResult, TableChangeSetPreview, TableChangeSetRequest,
    TableChangeSetUpdate, TableColumnSchema, TableConstraintKind, TableConstraintSchema,
    TableForeignKeyReference, TableGeneratedColumn, TableGeneratedColumnStorage,
    TableIdentityGeneration, TableIdentityOptions, TableIndexSchema, TableMutationResult,
    TablePageStats, TableReferentialAction, TableRowKey, TableRowLocator, TableSchema,
    TableSchemaBasics, TableTransactionState, UpdateDatabaseInput, UpdateDatabaseResult,
    UpdateTableInput, UpdateTableResult,
};
use crate::error::{IpcError, IpcResult};

mod ddl;
mod row;
mod type_helpers;

fn bind_mysql_table_query<'q>(
    sql: &'q str,
    bindings: &'q [TableBrowseBindValue],
) -> sqlx::query::Query<'q, MySql, sqlx::mysql::MySqlArguments> {
    let mut query = sqlx::query(sql);
    for binding in bindings {
        query = match binding {
            TableBrowseBindValue::String(value) => query.bind(value.as_str()),
            TableBrowseBindValue::Integer(value) => query.bind(*value),
            TableBrowseBindValue::Float(value) => query.bind(*value),
            TableBrowseBindValue::Boolean(value) => query.bind(*value),
        };
    }
    query
}

use self::ddl::*;
use self::row::*;
use self::type_helpers::*;

// Temporary local fail-closed markers for MySQL metadata that still cannot be
// safely round-tripped from information_schema.
const MYSQL_UNSAFE_ON_UPDATE_TYPE_MARKER: &str = "/* nexus_pilot:mysql_unsafe_on_update */";
const MYSQL_UNSAFE_DEFAULT_TYPE_MARKER: &str = "/* nexus_pilot:mysql_unsafe_default */";

pub struct MysqlDriver {
    profile_id: String,
    profile: MysqlProfile,
    pool: MySqlPool,
    transaction: Mutex<Option<MysqlTransactionSession>>,
    _tunnel: Option<SshTunnelRuntime>,
}

struct MysqlTransactionSession {
    database: String,
    connection: PoolConnection<MySql>,
}

struct MysqlColumnInfo {
    name: String,
    type_name: String,
    data_type: String,
    nullable: bool,
    default_value: Option<String>,
    extra: String,
    generation_expression: Option<String>,
    max_length: Option<i64>,
    numeric_precision: Option<i32>,
    numeric_scale: Option<i32>,
}

type MysqlColumnRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<i64>,
    Option<i64>,
    Option<i64>,
);

type MysqlTableInfoRow = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

type MysqlTableDesignColumnRow = (
    String,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

type MysqlForeignKeyRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

impl MysqlDriver {
    pub async fn connect(profile_id: String, profile: MysqlProfile) -> IpcResult<Self> {
        Self::validate_runtime_profile(&profile)?;
        let endpoint =
            ssh_tunnel::resolve_endpoint(&profile.host, profile.port, profile.ssh_tunnel.as_ref())
                .await?;
        let options = Self::connect_options(&profile, &endpoint.host, endpoint.port)?;
        let pool = Self::pool_options(&profile)
            .connect_with(options)
            .await
            .map_err(|error| classify_sqlx_connection_error(error, "MySQL"))?;

        Ok(Self {
            profile_id,
            profile,
            pool,
            transaction: Mutex::new(None),
            _tunnel: endpoint.tunnel,
        })
    }

    fn validate_runtime_profile(profile: &MysqlProfile) -> IpcResult<()> {
        if profile.ssh_tunnel.as_ref().is_some_and(|ssh| ssh.enabled)
            && profile.ssl_mode.as_deref() == Some("verify-identity")
        {
            return Err(IpcError::validation_failed(
                "SSH tunnel does not support MySQL verify-identity hostname verification",
            ));
        }
        Ok(())
    }

    fn connect_options(
        profile: &MysqlProfile,
        host: &str,
        port: u16,
    ) -> IpcResult<MySqlConnectOptions> {
        let mut options = MySqlConnectOptions::new()
            .host(host)
            .port(port)
            .username(&profile.username)
            .password(&profile.password)
            .ssl_mode(Self::mysql_ssl_mode(profile.ssl_mode.as_deref())?);

        if let Some(database) = profile
            .default_database
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            options = options.database(database);
        }

        Ok(options)
    }

    fn sql_execution_database(
        profile: &MysqlProfile,
        context: &SqlExecutionContext,
    ) -> IpcResult<Option<String>> {
        if context
            .schema
            .as_deref()
            .is_some_and(|schema| !schema.trim().is_empty())
        {
            return Err(IpcError::validation_failed(
                "MySQL query context does not support schema",
            ));
        }

        Ok(context
            .database
            .as_deref()
            .map(str::trim)
            .filter(|database| !database.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| {
                profile
                    .default_database
                    .as_deref()
                    .map(str::trim)
                    .filter(|database| !database.is_empty())
                    .map(ToOwned::to_owned)
            }))
    }

    fn connect_timeout(profile: &MysqlProfile) -> Duration {
        Duration::from_secs(profile.connect_timeout_seconds.unwrap_or(5).clamp(1, 300))
    }

    fn pool_options(profile: &MysqlProfile) -> MySqlPoolOptions {
        MySqlPoolOptions::new()
            .max_connections(5)
            .acquire_timeout(Self::connect_timeout(profile))
    }

    fn mysql_ssl_mode(mode: Option<&str>) -> IpcResult<MySqlSslMode> {
        match mode.unwrap_or("disable") {
            "disable" => Ok(MySqlSslMode::Disabled),
            "require" => Ok(MySqlSslMode::Required),
            "verify-ca" => Ok(MySqlSslMode::VerifyCa),
            "verify-identity" => Ok(MySqlSslMode::VerifyIdentity),
            value => Err(IpcError::validation_failed(format!(
                "Unsupported MySQL SSL mode '{value}'"
            ))),
        }
    }

    fn mysql_use_database_sql(database: &str) -> String {
        format!("USE {}", quote_mysql_identifier(database))
    }

    fn ensure_single_sql_statement_for_editor(sql: &str) -> IpcResult<()> {
        if sql.trim().is_empty() {
            return Err(IpcError::validation_failed("SQL cannot be empty"));
        }
        if !sql_is_single_statement(sql) {
            return Err(IpcError::validation_failed(
                "一次只能执行一条 SQL 语句；请选择一条语句后重试，或分别执行多条语句",
            ));
        }
        Ok(())
    }

    fn create_database_sql(name: &str, character_set: Option<&str>) -> IpcResult<String> {
        let name = normalized_non_empty_identifier(name, "数据库名称")?;
        let mut sql = format!("CREATE DATABASE {}", quote_mysql_identifier(&name));
        if let Some(character_set) = character_set {
            let character_set = normalized_non_empty_identifier(character_set, "字符集")?;
            sql.push_str(" DEFAULT CHARACTER SET ");
            sql.push_str(&quote_mysql_identifier(&character_set));
        }
        Ok(sql)
    }

    fn alter_database_charset_sql(name: &str, character_set: &str) -> IpcResult<String> {
        let name = normalized_non_empty_identifier(name, "数据库名称")?;
        let character_set = normalized_non_empty_identifier(character_set, "字符集")?;
        Ok(format!(
            "ALTER DATABASE {} DEFAULT CHARACTER SET {}",
            quote_mysql_identifier(&name),
            quote_mysql_identifier(&character_set)
        ))
    }

    fn drop_database_sql(name: &str) -> IpcResult<String> {
        let name = normalized_non_empty_identifier(name, "数据库名称")?;
        Ok(format!("DROP DATABASE {}", quote_mysql_identifier(&name)))
    }

    fn drop_table_sql(
        input: &DropTableInput,
        default_database: Option<&str>,
    ) -> IpcResult<(String, String, String)> {
        if input.container.kind != ContainerKind::Table {
            return Err(IpcError::validation_failed(
                "Selected container is not a table",
            ));
        }

        let database = input
            .container
            .database
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .or(default_database)
            .unwrap_or_default();
        let table = input
            .container
            .table
            .as_deref()
            .or(input.container.object_name.as_deref())
            .unwrap_or_default();

        let database = normalized_non_empty_identifier(database, "数据库名称")?;
        let table = normalized_non_empty_identifier(table, "表名")?;
        let sql = format!(
            "DROP TABLE {}.{}",
            quote_mysql_identifier(&database),
            quote_mysql_identifier(&table)
        );

        Ok((database, table, sql))
    }

    fn create_table_sql(
        input: &CreateTableInput,
        default_database: Option<&str>,
    ) -> IpcResult<String> {
        let (database, table) = Self::create_table_parts(input, default_database)?;
        let table_name = format!(
            "{}.{}",
            quote_mysql_identifier(&database),
            quote_mysql_identifier(&table)
        );
        let schema = normalize_create_table_input(input)?;
        let mut definitions = Vec::new();

        for column in &schema.columns {
            definitions.push(mysql_column_definition(column)?);
        }

        if !schema.primary_key_columns.is_empty() {
            definitions.push(format!(
                "PRIMARY KEY ({})",
                quote_column_list(&schema.primary_key_columns, quote_mysql_identifier)
            ));
        }

        for unique in &schema.unique_constraints {
            let name = unique.name.as_deref().unwrap_or("");
            let prefix = if name.trim().is_empty() {
                "UNIQUE KEY".to_string()
            } else {
                format!("UNIQUE KEY {}", quote_mysql_identifier(name.trim()))
            };
            definitions.push(format!(
                "{prefix} ({})",
                quote_column_list(&unique.columns, quote_mysql_identifier)
            ));
        }

        for constraint in &schema.table_constraints {
            definitions.push(mysql_table_constraint_definition(constraint)?);
        }

        for index in &schema.indexes {
            let name = normalized_non_empty_identifier(&index.name, "索引名")?;
            let columns = validate_column_refs(&index.columns, &schema.column_names, "索引列")?;
            let keyword = if index.is_unique { "UNIQUE KEY" } else { "KEY" };
            definitions.push(format!(
                "{keyword} {} ({})",
                quote_mysql_identifier(&name),
                quote_column_list(&columns, quote_mysql_identifier)
            ));
        }

        let body = definitions
            .into_iter()
            .map(|definition| format!("  {definition}"))
            .collect::<Vec<_>>()
            .join(",\n");
        let mut sql = format!("CREATE TABLE {table_name} (\n{body}\n)");

        if let Some(engine) =
            normalized_optional_fragment(input.basics.engine.as_deref(), "表引擎")?
        {
            sql.push_str(" ENGINE=");
            sql.push_str(&engine);
        }
        if let Some(charset) =
            normalized_optional_fragment(input.basics.charset.as_deref(), "字符集")?
        {
            sql.push_str(" DEFAULT CHARSET=");
            sql.push_str(&charset);
        }
        if let Some(collation) =
            normalized_optional_fragment(input.basics.collation.as_deref(), "排序规则")?
        {
            sql.push_str(" COLLATE=");
            sql.push_str(&collation);
        }
        if let Some(comment) = normalized_optional_text(input.basics.comment.as_deref()) {
            sql.push_str(" COMMENT=");
            sql.push_str(&render_sql_literal(&Value::String(comment))?);
        }
        if let Some(partition_options) = input.basics.partition.as_ref() {
            if let Some(partition) =
                normalized_optional_fragment(partition_options.raw_clause.as_deref(), "分区子句")?
            {
                sql.push(' ');
                sql.push_str(&partition);
            }
        }

        Ok(sql)
    }

    fn create_table_parts(
        input: &CreateTableInput,
        default_database: Option<&str>,
    ) -> IpcResult<(String, String)> {
        let database = if input.basics.database_name.trim().is_empty() {
            default_database.unwrap_or_default()
        } else {
            input.basics.database_name.as_str()
        };
        let database = normalized_non_empty_identifier(database, "数据库名称")?;
        let table = normalized_non_empty_identifier(&input.basics.table_name, "表名")?;
        Ok((database, table))
    }

    fn update_table_parts(
        input: &UpdateTableInput,
        default_database: Option<&str>,
    ) -> IpcResult<(String, String)> {
        if input.container.kind != ContainerKind::Table {
            return Err(IpcError::resource_not_found(
                "Selected container is not a table",
            ));
        }

        let database = input
            .container
            .database
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .or(default_database)
            .unwrap_or(input.target.basics.database_name.as_str());
        let table = input
            .container
            .table
            .as_deref()
            .or(input.container.object_name.as_deref())
            .unwrap_or(input.target.basics.table_name.as_str());

        let database = normalized_non_empty_identifier(database, "数据库名称")?;
        let table = normalized_non_empty_identifier(table, "表名")?;

        ensure_schema_matches_mysql_table_parts(&input.baseline, &database, &table)?;
        ensure_schema_matches_mysql_table_parts(&input.target, &database, &table)?;

        Ok((database, table))
    }

    fn update_table_sql(
        input: &UpdateTableInput,
        default_database: Option<&str>,
    ) -> IpcResult<(String, String, Vec<String>)> {
        let (database, table) = Self::update_table_parts(input, default_database)?;
        let table_name = format!(
            "{}.{}",
            quote_mysql_identifier(&database),
            quote_mysql_identifier(&table)
        );
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

        let diff_destructive = diff.is_destructive();
        let column_names = input
            .target
            .columns
            .iter()
            .map(|column| column.name.clone())
            .collect::<HashSet<_>>();
        let mut statements = Vec::new();

        if let Some(change) = diff.table_comment_change {
            let comment = change.comment.unwrap_or_default();
            statements.push(format!(
                "ALTER TABLE {table_name} COMMENT = {}",
                render_sql_literal(&Value::String(comment))?
            ));
        }
        if let Some(engine) = diff.table_engine_change {
            statements.push(format!(
                "ALTER TABLE {table_name} ENGINE={}",
                normalized_sql_fragment(&engine, "表引擎")?
            ));
        }
        if diff.table_charset_change.is_some() || diff.table_collation_change.is_some() {
            let mut statement = format!("ALTER TABLE {table_name}");
            if let Some(charset) = diff.table_charset_change {
                statement.push_str(" DEFAULT CHARACTER SET ");
                statement.push_str(&normalized_sql_fragment(&charset, "字符集")?);
            }
            if let Some(collation) = diff.table_collation_change {
                statement.push_str(" COLLATE ");
                statement.push_str(&normalized_sql_fragment(&collation, "排序规则")?);
            }
            statements.push(statement);
        }

        for column in &diff.added_columns {
            statements.push(format!(
                "ALTER TABLE {table_name} ADD COLUMN {}",
                mysql_column_definition(column)?
            ));
        }

        let mut changed_column_names = HashSet::new();
        for change in &diff.column_default_changes {
            changed_column_names.insert(change.column_name.clone());
        }
        for change in &diff.column_nullability_changes {
            changed_column_names.insert(change.column_name.clone());
        }
        for change in &diff.column_comment_changes {
            changed_column_names.insert(change.column_name.clone());
        }
        for change in &diff.generated_column_changes {
            changed_column_names.insert(change.column_name.clone());
        }
        for change in &diff.identity_changes {
            changed_column_names.insert(change.column_name.clone());
        }
        for change in &diff.column_charset_changes {
            changed_column_names.insert(change.column_name.clone());
        }
        let column_type_change_names = diff
            .column_type_changes
            .iter()
            .map(|change| change.column_name.clone())
            .collect::<HashSet<_>>();
        for change in &diff.column_type_changes {
            changed_column_names.insert(change.column_name.clone());
        }
        let rename_by_new_name = diff
            .renamed_columns
            .iter()
            .map(|rename| (rename.new_name.clone(), rename.old_name.clone()))
            .collect::<HashMap<_, _>>();
        let mut handled_rename_targets = HashSet::new();

        for target_column in &input.target.columns {
            if changed_column_names.remove(&target_column.name) {
                if let Some(reason) = mysql_unsupported_table_design_modify_reason(target_column) {
                    return Err(IpcError::validation_failed(reason));
                }

                if let Some(old_name) = rename_by_new_name.get(&target_column.name) {
                    statements.push(format!(
                        "ALTER TABLE {table_name} CHANGE COLUMN {} {}",
                        quote_mysql_identifier(old_name),
                        mysql_column_definition(target_column)?
                    ));
                    handled_rename_targets.insert(target_column.name.clone());
                } else if column_type_change_names.contains(&target_column.name) {
                    statements.push(format!(
                        "ALTER TABLE {table_name} CHANGE COLUMN {} {}",
                        quote_mysql_identifier(&target_column.name),
                        mysql_column_definition(target_column)?
                    ));
                } else {
                    statements.push(format!(
                        "ALTER TABLE {table_name} MODIFY COLUMN {}",
                        mysql_column_definition(target_column)?
                    ));
                }
            }
        }

        if let Some(column_name) = changed_column_names.into_iter().next() {
            return Err(IpcError::validation_failed(format!(
                "列 '{}' 不存在",
                column_name
            )));
        }

        for rename in &diff.renamed_columns {
            if handled_rename_targets.contains(&rename.new_name) {
                continue;
            }
            statements.push(format!(
                "ALTER TABLE {table_name} RENAME COLUMN {} TO {}",
                quote_mysql_identifier(&rename.old_name),
                quote_mysql_identifier(&rename.new_name)
            ));
        }

        if let Some(change) = &diff.primary_key_change {
            if !change.old_columns.is_empty() {
                statements.push(format!("ALTER TABLE {table_name} DROP PRIMARY KEY"));
            }
            if !change.new_columns.is_empty() {
                statements.push(format!(
                    "ALTER TABLE {table_name} ADD PRIMARY KEY ({})",
                    quote_column_list(&change.new_columns, quote_mysql_identifier)
                ));
            }
        }

        for constraint in &diff.dropped_constraints {
            statements.push(mysql_drop_constraint_statement(&table_name, constraint)?);
        }

        for constraint in &diff.added_constraints {
            statements.push(format!(
                "ALTER TABLE {table_name} ADD {}",
                mysql_table_constraint_definition(constraint)?
            ));
        }

        for index in &diff.dropped_indexes {
            let name = normalized_non_empty_identifier(&index.name, "索引名")?;
            statements.push(format!(
                "DROP INDEX {} ON {table_name}",
                quote_mysql_identifier(&name)
            ));
        }

        if !diff.dropped_columns.is_empty() {
            for column in &diff.dropped_columns {
                let name = normalized_non_empty_identifier(&column.name, "列名")?;
                statements.push(format!(
                    "ALTER TABLE {table_name} DROP COLUMN {}",
                    quote_mysql_identifier(&name)
                ));
            }
        }

        for index in &diff.added_indexes {
            if normalized_optional_text(index.method.as_deref()).is_some() {
                return Err(IpcError::validation_failed("暂不支持 MySQL 索引方法"));
            }
            let name = normalized_non_empty_identifier(&index.name, "索引名")?;
            let columns = validate_column_refs(&index.columns, &column_names, "索引列")?;
            let unique = if index.is_unique { "UNIQUE " } else { "" };
            statements.push(format!(
                "CREATE {unique}INDEX {} ON {table_name} ({})",
                quote_mysql_identifier(&name),
                quote_column_list(&columns, quote_mysql_identifier)
            ));
        }

        debug_assert_eq!(
            diff_destructive,
            Self::table_update_statements_are_destructive(&statements)
        );

        Ok((database, table, statements))
    }

    fn table_update_statements_are_destructive(statements: &[String]) -> bool {
        statements.iter().any(|statement| {
            statement.contains(" DROP COLUMN ")
                || statement.contains(" CHANGE COLUMN ")
                || statement.contains(" DROP PRIMARY KEY")
                || statement.contains(" ADD PRIMARY KEY ")
        })
    }

    fn ensure_destructive_table_update_confirmed(
        input: &UpdateTableInput,
        statements: &[String],
    ) -> IpcResult<()> {
        if Self::table_update_statements_are_destructive(statements) && !input.confirm_destructive {
            return Err(IpcError::validation_failed(
                "破坏性表结构变更需要确认后才能执行",
            ));
        }

        Ok(())
    }

    fn ensure_destructive_drop_table_confirmed(input: &DropTableInput) -> IpcResult<()> {
        if !input.confirm_destructive {
            return Err(IpcError::validation_failed("删除表需要确认后才能执行"));
        }

        Ok(())
    }

    fn mark_drop_table_preview(preview: &mut SchemaMutationPreview) {
        preview.destructive = true;
        preview
            .warnings
            .push("删除表会永久删除表结构和表内数据".to_string());
    }

    fn mark_destructive_table_update_preview(preview: &mut SchemaMutationPreview) {
        if Self::table_update_statements_are_destructive(&preview.statements) {
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
            .any(|statement| statement.contains(" CHANGE COLUMN "))
        {
            preview
                .warnings
                .push("将修改列类型；数据库可能拒绝转换，转换也可能造成数据截断".to_string());
        }
        if preview.statements.iter().any(|statement| {
            statement.contains(" DROP PRIMARY KEY") || statement.contains(" ADD PRIMARY KEY ")
        }) {
            preview
                .warnings
                .push("将修改主键；该操作可能影响依赖主键的查询、索引和应用逻辑".to_string());
        }
    }

    fn database_name_from_container(container: &ContainerRef) -> IpcResult<String> {
        if container.kind != ContainerKind::Database {
            return Err(IpcError::resource_not_found(
                "Selected container is not a database",
            ));
        }
        normalized_non_empty_identifier(
            container.database.as_deref().unwrap_or_default(),
            "数据库名称",
        )
    }

    async fn list_databases(&self) -> IpcResult<Vec<DataContainer>> {
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT CAST(schema_name AS CHAR) \
             FROM information_schema.schemata \
             ORDER BY schema_name",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        Ok(rows
            .into_iter()
            .map(|(database,)| DataContainer {
                id: format!("{}::database::{database}", self.profile_id),
                name: database.clone(),
                kind: ContainerKind::Database,
                is_leaf: false,
                container: ContainerRef::database(database),
                type_name: None,
                nullable: None,
                item_count: None,
                properties: Vec::new(),
            })
            .collect())
    }

    fn asset_group(
        &self,
        database: &str,
        table: Option<&str>,
        group_type: AssetGroupType,
        name: &str,
    ) -> DataContainer {
        let group_slug = asset_group_slug(&group_type);
        let id = match table {
            Some(table) => format!(
                "{}::{database}::{table}::group::{group_slug}",
                self.profile_id
            ),
            None => format!("{}::{database}::group::{group_slug}", self.profile_id),
        };
        DataContainer {
            id,
            name: name.to_string(),
            kind: ContainerKind::AssetGroup,
            is_leaf: false,
            container: ContainerRef::asset_group(
                group_type,
                Some(database.to_string()),
                None,
                table.map(str::to_string),
            ),
            type_name: None,
            nullable: None,
            item_count: None,
            properties: Vec::new(),
        }
    }

    fn database_asset_groups(&self, database: &str) -> Vec<DataContainer> {
        vec![
            self.asset_group(database, None, AssetGroupType::Tables, "Tables"),
            self.asset_group(database, None, AssetGroupType::Views, "Views"),
            self.asset_group(database, None, AssetGroupType::Functions, "Functions"),
            self.asset_group(database, None, AssetGroupType::Procedures, "Procedures"),
            self.asset_group(database, None, AssetGroupType::Triggers, "Triggers"),
            self.asset_group(database, None, AssetGroupType::Events, "Events"),
        ]
    }

    fn table_asset_groups(&self, database: &str, table: &str) -> Vec<DataContainer> {
        vec![
            self.asset_group(database, Some(table), AssetGroupType::Columns, "Columns"),
            self.asset_group(database, Some(table), AssetGroupType::Indexes, "Indexes"),
            self.asset_group(database, Some(table), AssetGroupType::Triggers, "Triggers"),
        ]
    }

    async fn list_table_like(
        &self,
        database: &str,
        group_type: &AssetGroupType,
    ) -> IpcResult<Vec<DataContainer>> {
        let table_type = match group_type {
            AssetGroupType::Tables => "BASE TABLE",
            AssetGroupType::Views => "VIEW",
            _ => return Ok(Vec::new()),
        };
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT CAST(TABLE_NAME AS CHAR), CAST(TABLE_TYPE AS CHAR) \
             FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ? \
             ORDER BY TABLE_TYPE, TABLE_NAME",
        )
        .bind(database)
        .bind(table_type)
        .fetch_all(&self.pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        Ok(rows
            .into_iter()
            .map(|(table, table_type)| {
                let kind = if table_type.eq_ignore_ascii_case("VIEW") {
                    ContainerKind::View
                } else {
                    ContainerKind::Table
                };
                let container =
                    ContainerRef::table(kind.clone(), database.to_string(), None, table.clone());
                DataContainer {
                    id: format!("{}::{database}::{table}", self.profile_id),
                    name: table,
                    kind,
                    is_leaf: false,
                    container,
                    type_name: Some(table_type),
                    nullable: None,
                    item_count: None,
                    properties: Vec::new(),
                }
            })
            .collect())
    }

    async fn list_routines(
        &self,
        database: &str,
        group_type: &AssetGroupType,
    ) -> IpcResult<Vec<DataContainer>> {
        let (routine_type, kind) = match group_type {
            AssetGroupType::Functions => ("FUNCTION", ContainerKind::Function),
            AssetGroupType::Procedures => ("PROCEDURE", ContainerKind::Procedure),
            _ => return Ok(Vec::new()),
        };
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT CAST(ROUTINE_NAME AS CHAR) \
             FROM information_schema.ROUTINES \
             WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = ? \
             ORDER BY ROUTINE_NAME",
        )
        .bind(database)
        .bind(routine_type)
        .fetch_all(&self.pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        Ok(rows
            .into_iter()
            .map(|(name,)| DataContainer {
                id: format!(
                    "{}::{database}::routine::{routine_type}::{name}",
                    self.profile_id
                ),
                name: name.clone(),
                kind: kind.clone(),
                is_leaf: true,
                container: ContainerRef::named_object(
                    kind.clone(),
                    database.to_string(),
                    None,
                    name,
                ),
                type_name: Some(routine_type.to_string()),
                nullable: None,
                item_count: None,
                properties: Vec::new(),
            })
            .collect())
    }

    async fn list_triggers(
        &self,
        database: &str,
        table: Option<&str>,
    ) -> IpcResult<Vec<DataContainer>> {
        let mut query = String::from(
            "SELECT CAST(TRIGGER_NAME AS CHAR), CAST(EVENT_OBJECT_TABLE AS CHAR) \
             FROM information_schema.TRIGGERS \
             WHERE TRIGGER_SCHEMA = ?",
        );
        if table.is_some() {
            query.push_str(" AND EVENT_OBJECT_TABLE = ?");
        }
        query.push_str(" ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME");

        let mut sql = sqlx::query_as::<_, (String, String)>(&query).bind(database);
        if let Some(table) = table {
            sql = sql.bind(table);
        }
        let rows = sql
            .fetch_all(&self.pool)
            .await
            .map_err(classify_sqlx_query_error)?;

        Ok(rows
            .into_iter()
            .map(|(name, table_name)| DataContainer {
                id: format!(
                    "{}::{database}::{table_name}::trigger::{name}",
                    self.profile_id
                ),
                name: name.clone(),
                kind: ContainerKind::Trigger,
                is_leaf: true,
                container: ContainerRef::named_object(
                    ContainerKind::Trigger,
                    database.to_string(),
                    None,
                    name,
                ),
                type_name: Some(table_name),
                nullable: None,
                item_count: None,
                properties: Vec::new(),
            })
            .collect())
    }

    async fn list_events(&self, database: &str) -> IpcResult<Vec<DataContainer>> {
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT CAST(EVENT_NAME AS CHAR) \
             FROM information_schema.EVENTS \
             WHERE EVENT_SCHEMA = ? \
             ORDER BY EVENT_NAME",
        )
        .bind(database)
        .fetch_all(&self.pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        Ok(rows
            .into_iter()
            .map(|(name,)| DataContainer {
                id: format!("{}::{database}::event::{name}", self.profile_id),
                name: name.clone(),
                kind: ContainerKind::Event,
                is_leaf: true,
                container: ContainerRef::named_object(
                    ContainerKind::Event,
                    database.to_string(),
                    None,
                    name,
                ),
                type_name: None,
                nullable: None,
                item_count: None,
                properties: Vec::new(),
            })
            .collect())
    }

    async fn load_primary_key_rows(
        &self,
        database: &str,
        table: &str,
    ) -> IpcResult<Vec<(String, i32)>> {
        let rows = sqlx::query(
            "SELECT \
                    CAST(COLUMN_NAME AS CHAR) AS column_name, \
                    CAST(ORDINAL_POSITION AS SIGNED) AS ordinal_position \
             FROM information_schema.KEY_COLUMN_USAGE \
             WHERE CONSTRAINT_SCHEMA = ? \
               AND TABLE_SCHEMA = ? \
               AND TABLE_NAME = ? \
               AND CONSTRAINT_NAME = 'PRIMARY' \
             ORDER BY ORDINAL_POSITION",
        )
        .bind(database)
        .bind(database)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        rows.into_iter()
            .map(|row| {
                let column: String = row
                    .try_get("column_name")
                    .map_err(classify_sqlx_query_error)?;
                let ordinal = mysql_metadata_i32(&row, "ordinal_position")?;
                Ok((column, ordinal))
            })
            .collect()
    }

    async fn list_indexes(&self, database: &str, table: &str) -> IpcResult<Vec<DataContainer>> {
        let rows = sqlx::query(
            "SELECT \
                    CAST(INDEX_NAME AS CHAR) AS index_name, \
                    CAST(NON_UNIQUE AS SIGNED) AS non_unique \
             FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
             GROUP BY INDEX_NAME, NON_UNIQUE \
             ORDER BY INDEX_NAME",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        rows.into_iter()
            .map(|row| {
                let name: String = row
                    .try_get("index_name")
                    .map_err(classify_sqlx_query_error)?;
                let non_unique = mysql_metadata_i32(&row, "non_unique")?;
                Ok(DataContainer {
                    id: format!("{}::{database}::{table}::index::{name}", self.profile_id),
                    name: name.clone(),
                    kind: ContainerKind::Index,
                    is_leaf: true,
                    container: ContainerRef::named_object(
                        ContainerKind::Index,
                        database.to_string(),
                        None,
                        name,
                    ),
                    type_name: Some(if non_unique == 0 { "UNIQUE" } else { "INDEX" }.to_string()),
                    nullable: None,
                    item_count: None,
                    properties: Vec::new(),
                })
            })
            .collect()
    }

    async fn describe_table_schema(&self, container: &ContainerRef) -> IpcResult<TableSchema> {
        if container.kind != ContainerKind::Table {
            return Err(IpcError::resource_not_found(
                "Only real tables can be described by the table designer",
            ));
        }

        let database = container
            .database
            .as_deref()
            .ok_or_else(|| IpcError::resource_not_found("Database name is missing"))?;
        let table = container
            .table
            .as_deref()
            .ok_or_else(|| IpcError::resource_not_found("Table name is missing"))?;

        let table_info: Option<MysqlTableInfoRow> = sqlx::query_as(
            "SELECT \
                    CAST(t.ENGINE AS CHAR), \
                    CAST(c.CHARACTER_SET_NAME AS CHAR), \
                    CAST(t.TABLE_COLLATION AS CHAR), \
                    CAST(t.TABLE_COMMENT AS CHAR) \
                 FROM information_schema.TABLES t \
                 LEFT JOIN information_schema.COLLATIONS c \
                   ON c.COLLATION_NAME = t.TABLE_COLLATION \
                 WHERE t.TABLE_SCHEMA = ? AND t.TABLE_NAME = ?",
        )
        .bind(database)
        .bind(table)
        .fetch_optional(&self.pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        let Some((engine, charset, collation, comment)) = table_info else {
            return Err(IpcError::resource_not_found(format!(
                "Table '{database}.{table}' was not found"
            )));
        };

        let column_rows: Vec<MysqlTableDesignColumnRow> = sqlx::query_as(
            "SELECT \
                    CAST(COLUMN_NAME AS CHAR), \
                    CAST(COLUMN_TYPE AS CHAR), \
                    CAST(IS_NULLABLE AS CHAR), \
                    CAST(COLUMN_DEFAULT AS CHAR), \
                    CAST(EXTRA AS CHAR), \
                    CAST(GENERATION_EXPRESSION AS CHAR), \
                    CAST(CHARACTER_SET_NAME AS CHAR), \
                    CAST(COLLATION_NAME AS CHAR), \
                    CAST(COLUMN_COMMENT AS CHAR) \
                 FROM information_schema.COLUMNS \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
                 ORDER BY ORDINAL_POSITION",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        let primary_key_rows = self.load_primary_key_rows(database, table).await?;

        let primary_key_ordinals: HashMap<String, i32> = primary_key_rows
            .iter()
            .map(|(column, ordinal)| (column.clone(), *ordinal))
            .collect();

        let unique_rows: Vec<(String,)> = sqlx::query_as(
            "SELECT DISTINCT CAST(COLUMN_NAME AS CHAR) \
             FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = ? \
               AND TABLE_NAME = ? \
               AND NON_UNIQUE = 0 \
               AND INDEX_NAME <> 'PRIMARY'",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        let unique_columns: HashSet<String> =
            unique_rows.into_iter().map(|(column,)| column).collect();

        let columns = column_rows
            .into_iter()
            .map(
                |(
                    name,
                    type_name,
                    nullable,
                    default_value,
                    extra,
                    generation_expression,
                    character_set_name,
                    collation_name,
                    comment,
                )| {
                    let type_name = mysql_table_design_type_name(
                        type_name,
                        &extra,
                        generation_expression.as_deref(),
                        default_value.as_deref(),
                        character_set_name.as_deref(),
                        collation_name.as_deref(),
                        charset.as_deref(),
                        collation.as_deref(),
                    );
                    let default_value = mysql_table_design_default_fragment(default_value, &extra);

                    let is_identity = extra.to_ascii_lowercase().contains("auto_increment");
                    let generated = mysql_generated_column_from_metadata(
                        &extra,
                        generation_expression.as_deref(),
                    );

                    TableColumnSchema {
                        is_primary_key: primary_key_ordinals.contains_key(&name),
                        is_unique: unique_columns.contains(&name),
                        is_identity,
                        identity: is_identity.then_some(TableIdentityOptions {
                            generation: TableIdentityGeneration::ByDefault,
                            start: None,
                            increment: None,
                            min_value: None,
                            max_value: None,
                            cache: None,
                            cycle: false,
                        }),
                        generated,
                        charset: normalized_optional_text(character_set_name.as_deref()),
                        collation: normalized_optional_text(collation_name.as_deref()),
                        nullable: nullable.eq_ignore_ascii_case("YES"),
                        name,
                        type_name,
                        default_value,
                        comment: comment.filter(|value| !value.trim().is_empty()),
                    }
                },
            )
            .collect();

        let index_rows = sqlx::query(
            "SELECT \
                CAST(INDEX_NAME AS CHAR) AS index_name, \
                CAST(NON_UNIQUE AS SIGNED) AS non_unique, \
                CAST(INDEX_TYPE AS CHAR) AS index_type, \
                GROUP_CONCAT(CAST(COLUMN_NAME AS CHAR) ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS column_names \
             FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME <> 'PRIMARY' \
             GROUP BY INDEX_NAME, NON_UNIQUE, INDEX_TYPE \
             ORDER BY MIN(SEQ_IN_INDEX), INDEX_NAME",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        let indexes: Vec<TableIndexSchema> = index_rows
            .into_iter()
            .map(|row| {
                let name: String = row
                    .try_get("index_name")
                    .map_err(classify_sqlx_query_error)?;
                let non_unique = mysql_metadata_i32(&row, "non_unique")?;
                let method: String = row
                    .try_get("index_type")
                    .map_err(classify_sqlx_query_error)?;
                let columns: Option<String> = row
                    .try_get("column_names")
                    .map_err(classify_sqlx_query_error)?;
                Ok(TableIndexSchema {
                    name,
                    columns: split_schema_columns(columns.as_deref()),
                    is_unique: non_unique == 0,
                    method: Some(method),
                    comment: None,
                })
            })
            .collect::<IpcResult<_>>()?;

        let mut constraints = Vec::new();
        let primary_key_columns = primary_key_rows
            .into_iter()
            .map(|(column, _)| column)
            .collect::<Vec<_>>();
        if !primary_key_columns.is_empty() {
            constraints.push(TableConstraintSchema {
                name: "PRIMARY".to_string(),
                kind: TableConstraintKind::PrimaryKey,
                columns: primary_key_columns,
                reference: None,
                expression: None,
                comment: None,
                foreign_key: None,
                enforced: None,
            });
        }

        let unique_constraint_rows: Vec<(String, Option<String>)> = sqlx::query_as(
            "SELECT \
                CAST(tc.CONSTRAINT_NAME AS CHAR), \
                GROUP_CONCAT(CAST(kcu.COLUMN_NAME AS CHAR) ORDER BY kcu.ORDINAL_POSITION SEPARATOR ',') \
             FROM information_schema.TABLE_CONSTRAINTS tc \
             JOIN information_schema.KEY_COLUMN_USAGE kcu \
               ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA \
              AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA \
              AND kcu.TABLE_NAME = tc.TABLE_NAME \
              AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME \
             WHERE tc.CONSTRAINT_SCHEMA = ? \
               AND tc.TABLE_SCHEMA = ? \
               AND tc.TABLE_NAME = ? \
               AND tc.CONSTRAINT_TYPE = 'UNIQUE' \
             GROUP BY tc.CONSTRAINT_NAME \
             ORDER BY tc.CONSTRAINT_NAME",
        )
        .bind(database)
        .bind(database)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        constraints.extend(unique_constraint_rows.into_iter().map(|(name, columns)| {
            TableConstraintSchema {
                name,
                kind: TableConstraintKind::Unique,
                columns: split_schema_columns(columns.as_deref()),
                reference: None,
                expression: None,
                comment: None,
                foreign_key: None,
                enforced: None,
            }
        }));

        let foreign_key_rows: Vec<MysqlForeignKeyRow> = sqlx::query_as(
            "SELECT \
                CAST(kcu.CONSTRAINT_NAME AS CHAR), \
                GROUP_CONCAT(CAST(kcu.COLUMN_NAME AS CHAR) ORDER BY kcu.ORDINAL_POSITION SEPARATOR ','), \
                CAST(kcu.REFERENCED_TABLE_SCHEMA AS CHAR), \
                CAST(kcu.REFERENCED_TABLE_NAME AS CHAR), \
                GROUP_CONCAT(CAST(kcu.REFERENCED_COLUMN_NAME AS CHAR) ORDER BY kcu.ORDINAL_POSITION SEPARATOR ','), \
                CAST(rc.UPDATE_RULE AS CHAR), \
                CAST(rc.DELETE_RULE AS CHAR) \
             FROM information_schema.KEY_COLUMN_USAGE kcu \
             JOIN information_schema.REFERENTIAL_CONSTRAINTS rc \
               ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA \
              AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME \
             WHERE kcu.CONSTRAINT_SCHEMA = ? \
               AND kcu.TABLE_SCHEMA = ? \
               AND kcu.TABLE_NAME = ? \
               AND kcu.REFERENCED_TABLE_NAME IS NOT NULL \
             GROUP BY kcu.CONSTRAINT_NAME, kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME, rc.UPDATE_RULE, rc.DELETE_RULE \
             ORDER BY kcu.CONSTRAINT_NAME",
        )
        .bind(database)
        .bind(database)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        constraints.extend(foreign_key_rows.into_iter().map(
            |(
                name,
                columns,
                reference_database,
                reference_table,
                reference_columns,
                update_rule,
                delete_rule,
            )| {
                TableConstraintSchema {
                    name,
                    kind: TableConstraintKind::ForeignKey,
                    columns: split_schema_columns(columns.as_deref()),
                    reference: None,
                    expression: None,
                    comment: None,
                    foreign_key: reference_table.map(|table_name| TableForeignKeyReference {
                        database_name: reference_database,
                        schema_name: None,
                        table_name,
                        columns: split_schema_columns(reference_columns.as_deref()),
                        on_update: mysql_parse_referential_action(update_rule.as_deref()),
                        on_delete: mysql_parse_referential_action(delete_rule.as_deref()),
                    }),
                    enforced: Some(true),
                }
            },
        ));

        let check_rows: Vec<(String, Option<String>)> = sqlx::query_as(
            "SELECT \
                CAST(tc.CONSTRAINT_NAME AS CHAR), \
                CAST(cc.CHECK_CLAUSE AS CHAR) \
             FROM information_schema.TABLE_CONSTRAINTS tc \
             JOIN information_schema.CHECK_CONSTRAINTS cc \
               ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA \
              AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME \
             WHERE tc.CONSTRAINT_SCHEMA = ? \
               AND tc.TABLE_SCHEMA = ? \
               AND tc.TABLE_NAME = ? \
               AND tc.CONSTRAINT_TYPE = 'CHECK' \
             ORDER BY tc.CONSTRAINT_NAME",
        )
        .bind(database)
        .bind(database)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        constraints.extend(check_rows.into_iter().map(|(name, expression)| {
            TableConstraintSchema {
                name,
                kind: TableConstraintKind::Check,
                columns: Vec::new(),
                reference: None,
                expression,
                comment: None,
                foreign_key: None,
                enforced: Some(true),
            }
        }));

        Ok(TableSchema {
            basics: TableSchemaBasics {
                table_name: table.to_string(),
                database_name: database.to_string(),
                schema_name: String::new(),
                engine,
                charset,
                collation,
                comment: comment.filter(|value| !value.trim().is_empty()),
                partition: None,
            },
            columns,
            indexes,
            constraints,
        })
    }

    async fn list_asset_group(&self, container: &ContainerRef) -> IpcResult<Vec<DataContainer>> {
        let database = container
            .database
            .as_deref()
            .ok_or_else(|| IpcError::resource_not_found("Database name is missing"))?;
        let group_type = container
            .group_type
            .as_ref()
            .ok_or_else(|| IpcError::resource_not_found("Asset group type is missing"))?;

        match group_type {
            AssetGroupType::Tables | AssetGroupType::Views => {
                self.list_table_like(database, group_type).await
            }
            AssetGroupType::Functions | AssetGroupType::Procedures => {
                self.list_routines(database, group_type).await
            }
            AssetGroupType::Triggers => {
                self.list_triggers(database, container.table.as_deref())
                    .await
            }
            AssetGroupType::Events => self.list_events(database).await,
            AssetGroupType::Indexes => {
                let table = container
                    .table
                    .as_deref()
                    .ok_or_else(|| IpcError::resource_not_found("Table name is missing"))?;
                self.list_indexes(database, table).await
            }
            AssetGroupType::Columns => {
                let table = container
                    .table
                    .as_deref()
                    .ok_or_else(|| IpcError::resource_not_found("Table name is missing"))?;
                self.list_columns_for_table(database, table, false).await
            }
            _ => Ok(Vec::new()),
        }
    }

    async fn load_table_columns_meta(
        &self,
        database: &str,
        table: &str,
        is_view: bool,
    ) -> IpcResult<Vec<ColumnMeta>> {
        let column_rows: Vec<MysqlColumnRow> = sqlx::query_as(
            "SELECT \
                    CAST(COLUMN_NAME AS CHAR), \
                    CAST(COLUMN_TYPE AS CHAR), \
                    CAST(DATA_TYPE AS CHAR), \
                    CAST(IS_NULLABLE AS CHAR), \
                    CAST(COLUMN_DEFAULT AS CHAR), \
                    CAST(EXTRA AS CHAR), \
                    CAST(GENERATION_EXPRESSION AS CHAR), \
                    CAST(CHARACTER_MAXIMUM_LENGTH AS SIGNED), \
                    CAST(NUMERIC_PRECISION AS SIGNED), \
                    CAST(NUMERIC_SCALE AS SIGNED) \
             FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
             ORDER BY ORDINAL_POSITION",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        let columns: Vec<MysqlColumnInfo> = column_rows
            .into_iter()
            .map(
                |(
                    name,
                    type_name,
                    data_type,
                    nullable,
                    default_value,
                    extra,
                    generation_expression,
                    max_length,
                    numeric_precision,
                    numeric_scale,
                )| {
                    MysqlColumnInfo {
                        name,
                        type_name,
                        data_type,
                        nullable: nullable.eq_ignore_ascii_case("YES"),
                        default_value,
                        extra,
                        generation_expression,
                        max_length,
                        numeric_precision: numeric_precision
                            .and_then(|value| i32::try_from(value).ok()),
                        numeric_scale: numeric_scale.and_then(|value| i32::try_from(value).ok()),
                    }
                },
            )
            .collect();

        let primary_key_rows = self.load_primary_key_rows(database, table).await?;

        let primary_key_ordinals: HashMap<String, i32> = primary_key_rows.into_iter().collect();

        let unique_rows: Vec<(String,)> = sqlx::query_as(
            "SELECT DISTINCT CAST(COLUMN_NAME AS CHAR) \
             FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = ? \
               AND TABLE_NAME = ? \
               AND NON_UNIQUE = 0",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        let unique_columns: HashSet<String> =
            unique_rows.into_iter().map(|(column,)| column).collect();

        Ok(columns
            .into_iter()
            .map(|column| {
                let generation_expression =
                    column.generation_expression.as_deref().unwrap_or("").trim();
                let is_generated = column.extra.to_ascii_uppercase().contains("GENERATED")
                    || !generation_expression.is_empty();

                ColumnMeta {
                    name: column.name.clone(),
                    type_name: column.type_name.clone(),
                    nullable: column.nullable,
                    default_value: column.default_value,
                    data_category: Self::classify_column_data_category(
                        &column.data_type,
                        &column.type_name,
                    ),
                    max_length: column.max_length,
                    numeric_precision: column.numeric_precision,
                    numeric_scale: column.numeric_scale,
                    enum_values: Self::parse_enum_values(&column.type_name),
                    is_primary_key: primary_key_ordinals.contains_key(&column.name),
                    primary_key_ordinal: primary_key_ordinals.get(&column.name).copied(),
                    is_unique: unique_columns.contains(&column.name),
                    is_writable: !is_view && !is_generated,
                }
            })
            .collect())
    }

    async fn list_columns_for_table(
        &self,
        database: &str,
        table: &str,
        is_view: bool,
    ) -> IpcResult<Vec<DataContainer>> {
        let columns = self
            .load_table_columns_meta(database, table, is_view)
            .await?;

        Ok(columns
            .into_iter()
            .map(|column| {
                let container = ContainerRef::column(
                    database.to_string(),
                    None,
                    table.to_string(),
                    column.name.clone(),
                );
                DataContainer {
                    id: format!(
                        "{}::{database}::{table}::column::{}",
                        self.profile_id, column.name
                    ),
                    name: column.name,
                    kind: ContainerKind::Column,
                    is_leaf: true,
                    container,
                    type_name: Some(column.type_name),
                    nullable: Some(column.nullable),
                    item_count: None,
                    properties: Vec::new(),
                }
            })
            .collect())
    }

    fn table_parts(&self, container: &ContainerRef) -> IpcResult<(String, String)> {
        ensure_mysql_table_data_container(&container.kind)?;
        let database = container
            .database
            .as_deref()
            .or(self.profile.default_database.as_deref())
            .ok_or_else(|| IpcError::resource_not_found("Database name is missing"))?;
        let table = container
            .table
            .as_deref()
            .ok_or_else(|| IpcError::resource_not_found("Table name is missing"))?;
        Ok((database.to_string(), table.to_string()))
    }

    fn table_identifier(&self, container: &ContainerRef) -> IpcResult<String> {
        let (database, table) = self.table_parts(container)?;
        Ok(format!(
            "{}.{}",
            quote_mysql_identifier(&database),
            quote_mysql_identifier(&table)
        ))
    }

    fn classify_column_data_category(data_type: &str, type_name: &str) -> ColumnDataCategory {
        let data_type = data_type.to_ascii_lowercase();
        let type_name = type_name.to_ascii_lowercase();

        if data_type == "enum" {
            return ColumnDataCategory::Enum;
        }
        if data_type == "json" {
            return ColumnDataCategory::Json;
        }
        if data_type == "date" {
            return ColumnDataCategory::Date;
        }
        if data_type == "time" {
            return ColumnDataCategory::Time;
        }
        if matches!(data_type.as_str(), "datetime" | "timestamp") {
            return ColumnDataCategory::Datetime;
        }
        if matches!(data_type.as_str(), "boolean" | "bool") {
            return ColumnDataCategory::Boolean;
        }
        if data_type == "tinyint" && type_name.starts_with("tinyint(1)") {
            return ColumnDataCategory::Boolean;
        }
        if matches!(
            data_type.as_str(),
            "tinyint"
                | "smallint"
                | "mediumint"
                | "int"
                | "integer"
                | "bigint"
                | "decimal"
                | "numeric"
                | "float"
                | "double"
                | "real"
                | "bit"
                | "year"
        ) {
            return ColumnDataCategory::Number;
        }
        if matches!(
            data_type.as_str(),
            "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob"
        ) {
            return ColumnDataCategory::Binary;
        }
        if data_type == "uuid" {
            return ColumnDataCategory::Uuid;
        }
        if matches!(
            data_type.as_str(),
            "char" | "varchar" | "tinytext" | "text" | "mediumtext" | "longtext" | "set"
        ) {
            return ColumnDataCategory::String;
        }

        ColumnDataCategory::Unknown
    }

    fn parse_enum_values(type_name: &str) -> Option<Vec<String>> {
        let trimmed = type_name.trim();
        let inner = trimmed
            .strip_prefix("enum(")
            .and_then(|value| value.strip_suffix(')'))?;
        let mut values = Vec::new();
        let mut current = String::new();
        let mut in_quote = false;
        let mut chars = inner.chars().peekable();

        while let Some(ch) = chars.next() {
            match ch {
                '\'' if in_quote && chars.peek() == Some(&'\'') => {
                    current.push('\'');
                    chars.next();
                }
                '\'' => {
                    if in_quote {
                        values.push(current.clone());
                        current.clear();
                    }
                    in_quote = !in_quote;
                }
                _ if in_quote => current.push(ch),
                _ => {}
            }
        }

        Some(values)
    }

    fn ensure_transaction_database(expected: &str, actual: &str) -> IpcResult<()> {
        if expected == actual {
            return Ok(());
        }

        Err(IpcError::system_internal(
            "当前事务已绑定到其他数据库",
            format!("transaction database is '{expected}', requested database is '{actual}'"),
        ))
    }

    fn transaction_state_from_session(
        session: Option<&MysqlTransactionSession>,
    ) -> TableTransactionState {
        TableTransactionState {
            in_transaction: session.is_some(),
            database: session.map(|session| session.database.clone()),
        }
    }

    async fn rollback_active_transaction(&self) -> IpcResult<()> {
        let mut transaction = self.transaction.lock().await;
        let Some(mut session) = transaction.take() else {
            return Ok(());
        };

        let _ = (&mut *session.connection).execute("ROLLBACK").await;
        Ok(())
    }
}

fn mysql_capabilities() -> DriverCapabilities {
    DriverCapabilities {
        schema_browser: true,
        schema_mutator: true,
        schema_mutation: Some(SchemaMutationFeatures::relational_database_and_table()),
        data_table_browser: true,
        table_row_mutator: true,
        table_row_inserter: true,
        transaction_manager: true,
        sql_executor: true,
        sql_execution: None,
        key_value_browser: false,
        graph_queryer: false,
        vector_searcher: false,
    }
}

#[async_trait]
impl DatabaseDriver for MysqlDriver {
    fn profile_id(&self) -> &str {
        &self.profile_id
    }

    fn driver_name(&self) -> &'static str {
        "mysql"
    }

    fn capabilities(&self) -> DriverCapabilities {
        mysql_capabilities()
    }

    async fn ping(&self) -> IpcResult<PingResult> {
        let start = Instant::now();
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .map_err(|error| IpcError::network_timeout("Ping failed", error.to_string()))?;
        Ok(PingResult {
            latency_ms: start.elapsed().as_millis() as u64,
        })
    }

    async fn server_version(&self) -> IpcResult<Option<String>> {
        let version = sqlx::query_scalar::<_, String>("SELECT VERSION()")
            .fetch_one(&self.pool)
            .await
            .map_err(classify_sqlx_query_error)?;
        Ok(Some(version))
    }

    fn ssh_host_key_fingerprint(&self) -> Option<&str> {
        self._tunnel
            .as_ref()
            .and_then(SshTunnelRuntime::captured_host_key_fingerprint)
    }

    async fn close(&self) -> IpcResult<()> {
        self.rollback_active_transaction().await?;
        self.pool.close().await;
        Ok(())
    }

    fn as_schema_browser(&self) -> Option<&dyn SchemaBrowser> {
        Some(self)
    }

    fn as_schema_mutator(&self) -> Option<&dyn SchemaMutator> {
        Some(self)
    }

    fn as_data_table_browser(&self) -> Option<&dyn DataTableBrowser> {
        Some(self)
    }

    fn as_sql_executor(&self) -> Option<&dyn SqlExecutor> {
        Some(self)
    }

    fn as_transaction_manager(&self) -> Option<&dyn TransactionManager> {
        Some(self)
    }
}

#[async_trait]
impl SchemaMutator for MysqlDriver {
    async fn preview_create_database(
        &self,
        input: &CreateDatabaseInput,
    ) -> IpcResult<SchemaMutationPreview> {
        Ok(SchemaMutationPreview::from_statements(vec![
            Self::create_database_sql(&input.name, input.character_set.as_deref())?,
        ]))
    }

    async fn create_database(
        &self,
        input: &CreateDatabaseInput,
    ) -> IpcResult<CreateDatabaseResult> {
        let name = normalized_non_empty_identifier(&input.name, "数据库名称")?;
        let sql = Self::create_database_sql(&name, input.character_set.as_deref())?;
        self.pool
            .execute(sql.as_str())
            .await
            .map_err(classify_sqlx_query_error)?;
        Ok(CreateDatabaseResult { name })
    }

    async fn preview_update_database(
        &self,
        input: &UpdateDatabaseInput,
    ) -> IpcResult<SchemaMutationPreview> {
        let database = Self::database_name_from_container(&input.container)?;
        let character_set = input
            .character_set
            .as_deref()
            .ok_or_else(|| IpcError::validation_failed("请为数据库选择字符集"))?;
        Ok(SchemaMutationPreview::from_statements(vec![
            Self::alter_database_charset_sql(&database, character_set)?,
        ]))
    }

    async fn update_database(
        &self,
        input: &UpdateDatabaseInput,
    ) -> IpcResult<UpdateDatabaseResult> {
        let database = Self::database_name_from_container(&input.container)?;
        let character_set = input
            .character_set
            .as_deref()
            .ok_or_else(|| IpcError::validation_failed("请为数据库选择字符集"))?;
        let sql = Self::alter_database_charset_sql(&database, character_set)?;
        self.pool
            .execute(sql.as_str())
            .await
            .map_err(classify_sqlx_query_error)?;
        Ok(UpdateDatabaseResult {
            old_name: database.clone(),
            name: database,
        })
    }

    async fn preview_drop_database(
        &self,
        input: &DropDatabaseInput,
    ) -> IpcResult<SchemaMutationPreview> {
        let database = Self::database_name_from_container(&input.container)?;
        Ok(SchemaMutationPreview::from_statements(vec![
            Self::drop_database_sql(&database)?,
        ]))
    }

    async fn drop_database(&self, input: &DropDatabaseInput) -> IpcResult<DropDatabaseResult> {
        let database = Self::database_name_from_container(&input.container)?;
        let sql = Self::drop_database_sql(&database)?;
        self.pool
            .execute(sql.as_str())
            .await
            .map_err(classify_sqlx_query_error)?;
        Ok(DropDatabaseResult { name: database })
    }

    async fn list_mysql_character_sets(&self) -> IpcResult<Vec<DatabaseCharacterSet>> {
        let rows = sqlx::query("SHOW CHARACTER SET")
            .fetch_all(&self.pool)
            .await
            .map_err(classify_sqlx_query_error)?;

        rows.into_iter()
            .map(|row| {
                let name: String = row.try_get(0).map_err(classify_sqlx_query_error)?;
                let description: Option<String> =
                    row.try_get(1).map_err(classify_sqlx_query_error)?;
                let default_collation: String =
                    row.try_get(2).map_err(classify_sqlx_query_error)?;
                let maxlen = mysql_metadata_u32_at(&row, 3)?;
                Ok(DatabaseCharacterSet {
                    name,
                    description,
                    default_collation,
                    maxlen,
                })
            })
            .collect()
    }

    async fn get_mysql_database_character_set(
        &self,
        container: &ContainerRef,
    ) -> IpcResult<Option<String>> {
        let database = Self::database_name_from_container(container)?;
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT CAST(DEFAULT_CHARACTER_SET_NAME AS CHAR) \
             FROM information_schema.SCHEMATA \
             WHERE SCHEMA_NAME = ?",
        )
        .bind(&database)
        .fetch_optional(&self.pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        match row {
            Some((character_set,)) => Ok(Some(character_set)),
            None => Err(IpcError::resource_not_found("Database not found")),
        }
    }

    async fn preview_create_table(
        &self,
        input: &CreateTableInput,
    ) -> IpcResult<SchemaMutationPreview> {
        Ok(SchemaMutationPreview::from_statements(vec![
            Self::create_table_sql(input, self.profile.default_database.as_deref())?,
        ]))
    }

    async fn create_table(&self, input: &CreateTableInput) -> IpcResult<CreateTableResult> {
        let sql = Self::create_table_sql(input, self.profile.default_database.as_deref())?;
        self.pool
            .execute(sql.as_str())
            .await
            .map_err(classify_sqlx_query_error)?;

        let (database, table_name) =
            Self::create_table_parts(input, self.profile.default_database.as_deref())?;
        Ok(CreateTableResult {
            container: ContainerRef::table(
                ContainerKind::Table,
                database,
                None,
                table_name.clone(),
            ),
            table_name,
        })
    }

    async fn preview_update_table(
        &self,
        input: &UpdateTableInput,
    ) -> IpcResult<SchemaMutationPreview> {
        let (_, _, statements) =
            Self::update_table_sql(input, self.profile.default_database.as_deref())?;
        let mut preview = SchemaMutationPreview::from_statements(statements);
        Self::mark_destructive_table_update_preview(&mut preview);
        let rename_by_old_name = input
            .column_renames
            .iter()
            .map(|rename| (rename.old_name.as_str(), rename.new_name.as_str()))
            .collect::<HashMap<_, _>>();
        for baseline_column in &input.baseline.columns {
            let target_name = rename_by_old_name
                .get(baseline_column.name.as_str())
                .copied()
                .unwrap_or(baseline_column.name.as_str());
            let Some(target_column) = input
                .target
                .columns
                .iter()
                .find(|column| column.name == target_name)
            else {
                continue;
            };
            if baseline_column.nullable && !target_column.nullable {
                preview.warnings.push(format!(
                    "列 '{}' 将改为 NOT NULL；如果已有数据包含 NULL，数据库会拒绝执行",
                    baseline_column.name
                ));
            }
        }
        Ok(preview)
    }

    async fn update_table(&self, input: &UpdateTableInput) -> IpcResult<UpdateTableResult> {
        let current = self.describe_table(&input.container).await?;
        if current != input.baseline {
            return Err(IpcError::resource_conflict("表结构已变化，请刷新后重试"));
        }

        let (database, table_name, statements) =
            Self::update_table_sql(input, self.profile.default_database.as_deref())?;
        Self::ensure_destructive_table_update_confirmed(input, &statements)?;
        for statement in statements {
            self.pool
                .execute(statement.as_str())
                .await
                .map_err(classify_sqlx_query_error)?;
        }

        Ok(UpdateTableResult {
            container: ContainerRef::table(
                ContainerKind::Table,
                database,
                None,
                table_name.clone(),
            ),
            table_name,
        })
    }

    async fn preview_drop_table(&self, input: &DropTableInput) -> IpcResult<SchemaMutationPreview> {
        let (_, _, sql) = Self::drop_table_sql(input, self.profile.default_database.as_deref())?;
        let mut preview = SchemaMutationPreview::from_statements(vec![sql]);
        Self::mark_drop_table_preview(&mut preview);
        Ok(preview)
    }

    async fn drop_table(&self, input: &DropTableInput) -> IpcResult<DropTableResult> {
        Self::ensure_destructive_drop_table_confirmed(input)?;
        let (database, table_name, sql) =
            Self::drop_table_sql(input, self.profile.default_database.as_deref())?;

        self.pool
            .execute(sql.as_str())
            .await
            .map_err(classify_sqlx_query_error)?;

        Ok(DropTableResult {
            container: ContainerRef::table(
                ContainerKind::Table,
                database,
                None,
                table_name.clone(),
            ),
            table_name,
        })
    }
}

#[async_trait]
impl SchemaBrowser for MysqlDriver {
    async fn list_containers(
        &self,
        parent: Option<&ContainerRef>,
    ) -> IpcResult<Vec<DataContainer>> {
        match parent.map(|container| &container.kind) {
            None => self.list_databases().await,
            Some(ContainerKind::Database) => {
                let database = parent
                    .and_then(|container| container.database.as_deref())
                    .ok_or_else(|| IpcError::resource_not_found("Database name is missing"))?;
                Ok(self.database_asset_groups(database))
            }
            Some(ContainerKind::AssetGroup) => {
                self.list_asset_group(parent.expect("checked parent")).await
            }
            Some(ContainerKind::Table) | Some(ContainerKind::View) => {
                let container = parent.expect("checked parent");
                let database = container
                    .database
                    .as_deref()
                    .ok_or_else(|| IpcError::resource_not_found("Database name is missing"))?;
                let table = container
                    .table
                    .as_deref()
                    .ok_or_else(|| IpcError::resource_not_found("Table name is missing"))?;
                Ok(self.table_asset_groups(database, table))
            }
            _ => Ok(Vec::new()),
        }
    }

    async fn describe_table(&self, container: &ContainerRef) -> IpcResult<TableSchema> {
        self.describe_table_schema(container).await
    }
}

#[async_trait]
impl DataTableBrowser for MysqlDriver {
    async fn browse_table_data(
        &self,
        container: &ContainerRef,
        page: u32,
        page_size: u32,
        query: &TableBrowseQuery,
    ) -> IpcResult<QueryResult> {
        let offset = page.saturating_sub(1) as u64 * page_size as u64;
        let limit = page_size as u64 + 1;
        let (database, table_name) = self.table_parts(container)?;
        let is_view = container.kind == ContainerKind::View;
        let columns = self
            .load_table_columns_meta(&database, &table_name, is_view)
            .await?;
        let primary_key_columns = primary_key_columns(&columns);
        let stable_order_columns = if primary_key_columns.is_empty() {
            Vec::new()
        } else {
            primary_key_columns.clone()
        };
        let source_writable = !is_view && !primary_key_columns.is_empty();
        let source_insertable = !is_view;
        let query_plan = table_browse_sql_plan(
            query,
            &columns,
            quote_mysql_identifier,
            TableBrowsePlaceholderStyle::QuestionMark,
        )?;

        if columns.is_empty() {
            return Ok(QueryResult {
                columns,
                rows: Vec::new(),
                affected_rows: None,
                has_next_page: false,
                source_writable,
                source_insertable,
                primary_key_columns,
                stable_order_columns,
                row_locator_strategy: source_writable
                    .then_some(crate::engine::types::TableRowLocatorStrategy::PrimaryKey),
            });
        }

        let table = self.table_identifier(container)?;
        let select_columns = columns
            .iter()
            .map(mysql_table_select_expression)
            .collect::<Vec<_>>()
            .join(", ");
        let order_by = if !query_plan.order_by_clause.is_empty() {
            query_plan.order_by_clause.clone()
        } else if stable_order_columns.is_empty() {
            String::new()
        } else {
            format!(
                " ORDER BY {}",
                stable_order_columns
                    .iter()
                    .map(|column| quote_mysql_identifier(column))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        let sql = format!(
            "SELECT {select_columns} FROM {table}{}{order_by} LIMIT {limit} OFFSET {offset}",
            query_plan.where_clause
        );
        let mut transaction = self.transaction.lock().await;
        let rows: Vec<MySqlRow> = if let Some(session) = transaction.as_mut() {
            Self::ensure_transaction_database(&session.database, &database)?;
            bind_mysql_table_query(&sql, &query_plan.bindings)
                .fetch_all(&mut *session.connection)
                .await
                .map_err(classify_sqlx_query_error)?
        } else {
            drop(transaction);
            bind_mysql_table_query(&sql, &query_plan.bindings)
                .fetch_all(&self.pool)
                .await
                .map_err(classify_sqlx_query_error)?
        };
        mysql_table_rows_to_result(
            rows,
            page_size,
            columns,
            source_writable,
            source_insertable,
            primary_key_columns,
            stable_order_columns,
        )
    }

    async fn get_table_page_stats(
        &self,
        container: &ContainerRef,
        page_size: u32,
        query: &TableBrowseQuery,
        requested_page: Option<u32>,
    ) -> IpcResult<TablePageStats> {
        let (database, table_name) = self.table_parts(container)?;
        let is_view = container.kind == ContainerKind::View;
        let columns = self
            .load_table_columns_meta(&database, &table_name, is_view)
            .await?;
        let query_plan = table_browse_sql_plan(
            query,
            &columns,
            quote_mysql_identifier,
            TableBrowsePlaceholderStyle::QuestionMark,
        )?;
        let table = self.table_identifier(container)?;
        let sql = mysql_table_page_stats_sql(&table, &query_plan.where_clause);
        let mut transaction = self.transaction.lock().await;
        let total_rows: String = if let Some(session) = transaction.as_mut() {
            Self::ensure_transaction_database(&session.database, &database)?;
            bind_mysql_table_query(&sql, &query_plan.bindings)
                .fetch_one(&mut *session.connection)
                .await
                .map_err(classify_sqlx_query_error)?
                .try_get(0)
                .map_err(classify_sqlx_query_error)?
        } else {
            drop(transaction);
            bind_mysql_table_query(&sql, &query_plan.bindings)
                .fetch_one(&self.pool)
                .await
                .map_err(classify_sqlx_query_error)?
                .try_get(0)
                .map_err(classify_sqlx_query_error)?
        };
        let total_rows = total_rows
            .parse::<u64>()
            .map_err(|error| IpcError::system_internal("分页统计结果无效", error.to_string()))?;

        table_page_stats(total_rows, page_size, requested_page)
    }

    async fn update_table_row(
        &self,
        container: &ContainerRef,
        primary_key: &TableRowKey,
        changes: &[TableCellChange],
    ) -> IpcResult<TableMutationResult> {
        let result = self
            .commit_table_change_set(
                container,
                &TableChangeSetRequest {
                    inserts: Vec::new(),
                    updates: vec![TableChangeSetUpdate {
                        locator: TableRowLocator::primary_key(primary_key.clone()),
                        changes: changes.to_vec(),
                    }],
                    deletes: Vec::new(),
                },
            )
            .await?;
        Ok(TableMutationResult {
            affected_rows: result.affected_rows,
        })
    }

    async fn delete_table_rows(
        &self,
        container: &ContainerRef,
        primary_keys: &[TableRowKey],
    ) -> IpcResult<TableMutationResult> {
        let result = self
            .commit_table_change_set(
                container,
                &TableChangeSetRequest {
                    inserts: Vec::new(),
                    updates: Vec::new(),
                    deletes: primary_keys
                        .iter()
                        .cloned()
                        .map(TableRowLocator::primary_key)
                        .collect(),
                },
            )
            .await?;
        Ok(TableMutationResult {
            affected_rows: result.affected_rows,
        })
    }

    async fn preview_table_change_set(
        &self,
        container: &ContainerRef,
        change_set: &TableChangeSetRequest,
    ) -> IpcResult<TableChangeSetPreview> {
        ensure_real_table_for_mutation(&container.kind)?;
        let (database, table_name) = self.table_parts(container)?;
        let columns = self
            .load_table_columns_meta(&database, &table_name, false)
            .await?;
        let table = self.table_identifier(container)?;
        build_table_change_set_preview(
            &columns,
            &table,
            quote_mysql_identifier,
            mysql_empty_insert_statement,
            change_set,
        )
    }

    async fn commit_table_change_set(
        &self,
        container: &ContainerRef,
        change_set: &TableChangeSetRequest,
    ) -> IpcResult<TableChangeSetCommitResult> {
        let preview = self.preview_table_change_set(container, change_set).await?;
        let insert_statement_count = preview.summary.inserts as usize;
        let update_statement_count = preview.summary.updates as usize;
        let mut affected_rows = 0;

        let (database, _) = self.table_parts(container)?;
        let mut transaction = self.transaction.lock().await;
        for (index, statement) in preview.statements.iter().enumerate() {
            let result = if let Some(session) = transaction.as_mut() {
                Self::ensure_transaction_database(&session.database, &database)?;
                (&mut *session.connection)
                    .execute(statement.as_str())
                    .await
                    .map_err(classify_sqlx_query_error)?
            } else {
                self.pool
                    .execute(statement.as_str())
                    .await
                    .map_err(classify_sqlx_query_error)?
            };
            let statement_affected_rows = rows_affected(&result);

            if index >= insert_statement_count
                && index < insert_statement_count + update_statement_count
                && statement_affected_rows > 1
            {
                return Err(IpcError::system_internal(
                    "更新影响了多行，已拒绝该结果",
                    "table change set update must affect at most one row",
                ));
            }

            affected_rows += statement_affected_rows;
        }

        Ok(TableChangeSetCommitResult {
            affected_rows,
            preview,
            outcome: TableChangeOutcome::Applied,
        })
    }
}

#[async_trait]
impl TransactionManager for MysqlDriver {
    async fn begin_transaction(
        &self,
        container: &ContainerRef,
    ) -> IpcResult<TableTransactionState> {
        let (database, _) = self.table_parts(container)?;
        let mut transaction = self.transaction.lock().await;
        if transaction.is_some() {
            return Err(IpcError::system_internal(
                "当前标签页已有活动事务",
                "transaction already active for this tab runtime",
            ));
        }

        let mut connection = self.pool.acquire().await.map_err(|error| {
            IpcError::system_internal("开启事务失败：无法获取数据库连接", error.to_string())
        })?;
        (&mut *connection)
            .execute("START TRANSACTION")
            .await
            .map_err(|error| {
                IpcError::system_internal("开启事务失败：数据库拒绝启动事务", error.to_string())
            })?;
        *transaction = Some(MysqlTransactionSession {
            database,
            connection,
        });

        Ok(Self::transaction_state_from_session(transaction.as_ref()))
    }

    async fn commit_transaction(&self) -> IpcResult<TableTransactionState> {
        let mut transaction = self.transaction.lock().await;
        let Some(mut session) = transaction.take() else {
            return Err(IpcError::system_internal(
                "当前标签页没有活动事务",
                "no active transaction for this tab runtime",
            ));
        };

        (&mut *session.connection)
            .execute("COMMIT")
            .await
            .map_err(classify_sqlx_query_error)?;
        Ok(Self::transaction_state_from_session(None))
    }

    async fn rollback_transaction(&self) -> IpcResult<TableTransactionState> {
        let mut transaction = self.transaction.lock().await;
        let Some(mut session) = transaction.take() else {
            return Err(IpcError::system_internal(
                "当前标签页没有活动事务",
                "no active transaction for this tab runtime",
            ));
        };

        (&mut *session.connection)
            .execute("ROLLBACK")
            .await
            .map_err(classify_sqlx_query_error)?;
        Ok(Self::transaction_state_from_session(None))
    }

    async fn transaction_state(&self) -> IpcResult<TableTransactionState> {
        let transaction = self.transaction.lock().await;
        Ok(Self::transaction_state_from_session(transaction.as_ref()))
    }
}

#[async_trait]
impl SqlExecutor for MysqlDriver {
    async fn execute_sql(
        &self,
        context: &SqlExecutionContext,
        sql: &str,
        page: u32,
        page_size: u32,
    ) -> IpcResult<QueryResult> {
        Self::ensure_single_sql_statement_for_editor(sql)?;
        let database = Self::sql_execution_database(&self.profile, context)?;
        let offset = page.saturating_sub(1) as u64 * page_size as u64;
        let mut connection = self.pool.acquire().await.map_err(|error| {
            IpcError::system_internal(
                "SQL execution failed: cannot acquire connection",
                error.to_string(),
            )
        })?;
        // SQL editor executions can mutate session state; close this checked-out
        // connection instead of returning it to the pool.
        connection.close_on_drop();
        if let Some(database) = database.as_deref() {
            (&mut *connection)
                .execute(Self::mysql_use_database_sql(database).as_str())
                .await
                .map_err(classify_sqlx_query_error)?;
        }

        let describe = if sql_is_single_statement(sql) {
            Some(
                (&mut *connection)
                    .describe(sql)
                    .await
                    .map_err(classify_sqlx_query_error)?,
            )
        } else {
            None
        };
        let expects_rows = describe
            .as_ref()
            .is_some_and(|describe| !describe.columns().is_empty());
        let should_report_affected_rows = sql_should_report_affected_rows(sql);
        let mut stream = sqlx::raw_sql(sql).fetch_many(&mut *connection);
        let mut rows: Vec<MySqlRow> = Vec::new();
        let mut columns: Option<Vec<ColumnMeta>> = None;
        let mut skipped = 0_u64;
        let mut affected_rows = 0_u64;
        let mut has_next_page = false;

        while let Some(step) = stream.try_next().await.map_err(classify_sqlx_query_error)? {
            match step {
                sqlx::Either::Left(result) => {
                    affected_rows = affected_rows.saturating_add(rows_affected(&result));
                }
                sqlx::Either::Right(row) => {
                    if let Some(ref cols) = columns {
                        ensure_mysql_row_shape(&row, cols)?;
                    } else {
                        columns = Some(mysql_columns_from_row(&row));
                    }

                    if skipped < offset {
                        skipped += 1;
                        continue;
                    }

                    if rows.len() >= page_size as usize {
                        has_next_page = true;
                        break;
                    }

                    rows.push(row);
                }
            }
        }

        if !expects_rows && columns.is_none() {
            return Ok(QueryResult {
                columns: Vec::new(),
                rows: Vec::new(),
                affected_rows: Some(affected_rows),
                has_next_page: false,
                source_writable: false,
                source_insertable: false,
                primary_key_columns: Vec::new(),
                stable_order_columns: Vec::new(),
                row_locator_strategy: None,
            });
        }

        Ok(QueryResult {
            columns: columns.unwrap_or_else(|| {
                describe
                    .as_ref()
                    .map(mysql_columns_from_describe)
                    .unwrap_or_default()
            }),
            rows: mysql_result_rows(&rows)?,
            affected_rows: should_report_affected_rows.then_some(affected_rows),
            has_next_page,
            source_writable: false,
            source_insertable: false,
            primary_key_columns: Vec::new(),
            stable_order_columns: Vec::new(),
            row_locator_strategy: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::profiles::{SshAuthMethod, SshHostVerificationMode, SshTunnelProfile};
    use crate::engine::types::{
        DropTableInput, SqlExecutionContext, TableColumnRename, TableForeignKeyReference,
        TableGeneratedColumn, TableGeneratedColumnStorage, TablePartitionOptions,
        TableReferentialAction,
    };

    #[test]
    fn mysql_schema_capabilities_cover_database_and_table_mutation() {
        let capabilities = mysql_capabilities();
        let schema_mutation = capabilities
            .schema_mutation
            .as_ref()
            .expect("MySQL schema mutation features should be declared");

        for kind in [ContainerKind::Database, ContainerKind::Table] {
            for operation in [
                crate::engine::types::SchemaMutationOperation::Create,
                crate::engine::types::SchemaMutationOperation::Alter,
                crate::engine::types::SchemaMutationOperation::Drop,
            ] {
                assert!(schema_mutation.supports(kind.clone(), operation));
            }
        }
        assert!(capabilities.schema_mutator);
    }

    fn test_column(name: &str, type_name: &str, data_category: ColumnDataCategory) -> ColumnMeta {
        ColumnMeta {
            name: name.to_string(),
            type_name: type_name.to_string(),
            nullable: false,
            default_value: None,
            data_category,
            max_length: None,
            numeric_precision: None,
            numeric_scale: None,
            enum_values: None,
            is_primary_key: false,
            primary_key_ordinal: None,
            is_unique: false,
            is_writable: true,
        }
    }

    fn enabled_ssh_tunnel() -> SshTunnelProfile {
        SshTunnelProfile {
            enabled: true,
            host: "bastion.example.com".to_string(),
            port: 22,
            username: "deploy".to_string(),
            auth_method: SshAuthMethod::Password,
            password: Some("secret".to_string()),
            private_key_path: None,
            private_key_passphrase: None,
            host_verification: SshHostVerificationMode::TrustOnFirstUse,
            host_key_fingerprint: None,
        }
    }

    #[test]
    fn maps_mysql_ssl_modes() {
        assert!(matches!(
            MysqlDriver::mysql_ssl_mode(None).unwrap(),
            sqlx::mysql::MySqlSslMode::Disabled
        ));
        assert!(matches!(
            MysqlDriver::mysql_ssl_mode(Some("require")).unwrap(),
            sqlx::mysql::MySqlSslMode::Required
        ));
        assert!(matches!(
            MysqlDriver::mysql_ssl_mode(Some("verify-ca")).unwrap(),
            sqlx::mysql::MySqlSslMode::VerifyCa
        ));
        assert!(matches!(
            MysqlDriver::mysql_ssl_mode(Some("verify-identity")).unwrap(),
            sqlx::mysql::MySqlSslMode::VerifyIdentity
        ));
        assert!(MysqlDriver::mysql_ssl_mode(Some("preferred")).is_err());
    }

    #[test]
    fn builds_mysql_connect_options_for_resolved_endpoint() {
        let mut profile = MysqlProfile {
            host: "mysql.example.com".to_string(),
            port: 3306,
            username: "root".to_string(),
            password: "secret".to_string(),
            default_database: Some("app".to_string()),
            connect_timeout_seconds: Some(11),
            ssh_tunnel: None,
            ssl_mode: Some("verify-ca".to_string()),
        };

        let options =
            MysqlDriver::connect_options(&profile, "127.0.0.1", 49152).expect("connect options");

        assert_eq!(options.get_host(), "127.0.0.1");
        assert_eq!(options.get_port(), 49152);
        assert_eq!(options.get_username(), "root");
        assert_eq!(options.get_database(), Some("app"));
        assert!(matches!(options.get_ssl_mode(), MySqlSslMode::VerifyCa));
        assert_eq!(
            MysqlDriver::connect_timeout(&profile),
            Duration::from_secs(11)
        );
        assert_eq!(
            MysqlDriver::pool_options(&profile).get_acquire_timeout(),
            Duration::from_secs(11)
        );

        profile.default_database = Some("   ".to_string());
        let options =
            MysqlDriver::connect_options(&profile, "127.0.0.1", 49152).expect("connect options");
        assert_eq!(options.get_database(), None);
    }

    #[test]
    fn rejects_mysql_verify_identity_with_ssh_tunnel() {
        let profile = MysqlProfile {
            host: "mysql.example.com".to_string(),
            port: 3306,
            username: "root".to_string(),
            password: "secret".to_string(),
            default_database: Some("app".to_string()),
            connect_timeout_seconds: None,
            ssh_tunnel: Some(enabled_ssh_tunnel()),
            ssl_mode: Some("verify-identity".to_string()),
        };

        assert!(MysqlDriver::validate_runtime_profile(&profile).is_err());
    }

    #[test]
    fn asset_group_is_not_a_table_data_container() {
        assert!(ensure_mysql_table_data_container(&ContainerKind::AssetGroup).is_err());
    }

    #[test]
    fn resolves_mysql_sql_execution_database_context() {
        let profile = MysqlProfile {
            host: "localhost".to_string(),
            port: 3306,
            username: "root".to_string(),
            password: String::new(),
            default_database: Some("default_db".to_string()),
            connect_timeout_seconds: None,
            ssh_tunnel: None,
            ssl_mode: None,
        };

        let context = SqlExecutionContext {
            database: Some("selected_db".to_string()),
            schema: None,
        };

        assert_eq!(
            MysqlDriver::sql_execution_database(&profile, &context).unwrap(),
            Some("selected_db".to_string())
        );

        let empty_context = SqlExecutionContext::default();
        assert_eq!(
            MysqlDriver::sql_execution_database(&profile, &empty_context).unwrap(),
            Some("default_db".to_string())
        );
    }

    #[test]
    fn rejects_mysql_schema_sql_execution_context() {
        let profile = MysqlProfile {
            host: "localhost".to_string(),
            port: 3306,
            username: "root".to_string(),
            password: String::new(),
            default_database: None,
            connect_timeout_seconds: None,
            ssh_tunnel: None,
            ssl_mode: None,
        };
        let context = SqlExecutionContext {
            database: Some("app".to_string()),
            schema: Some("public".to_string()),
        };

        assert!(MysqlDriver::sql_execution_database(&profile, &context).is_err());
    }

    #[test]
    fn resolves_mysql_sql_execution_context_without_database() {
        let profile = MysqlProfile {
            host: "localhost".to_string(),
            port: 3306,
            username: "root".to_string(),
            password: String::new(),
            default_database: None,
            connect_timeout_seconds: None,
            ssh_tunnel: None,
            ssl_mode: None,
        };

        assert_eq!(
            MysqlDriver::sql_execution_database(&profile, &SqlExecutionContext::default()).unwrap(),
            None
        );
    }

    #[test]
    fn builds_mysql_sql_execution_context_use_database_sql() {
        assert_eq!(
            MysqlDriver::mysql_use_database_sql("odd`name"),
            "USE `odd``name`"
        );
    }

    #[test]
    fn rejects_mysql_multi_statement_sql_execution_context() {
        assert!(MysqlDriver::ensure_single_sql_statement_for_editor("   ").is_err());
        assert!(MysqlDriver::ensure_single_sql_statement_for_editor("SELECT 1; SELECT 2").is_err());
        assert!(MysqlDriver::ensure_single_sql_statement_for_editor("SELECT ';'").is_ok());
    }

    #[test]
    fn builds_mysql_create_database_sql() {
        assert_eq!(
            MysqlDriver::create_database_sql("app", None).unwrap(),
            "CREATE DATABASE `app`"
        );
        assert_eq!(
            MysqlDriver::create_database_sql("odd`name", None).unwrap(),
            "CREATE DATABASE `odd``name`"
        );
        assert_eq!(
            MysqlDriver::create_database_sql("app", Some("utf8mb4")).unwrap(),
            "CREATE DATABASE `app` DEFAULT CHARACTER SET `utf8mb4`"
        );
        assert!(MysqlDriver::create_database_sql("  ", None).is_err());
    }

    #[test]
    fn builds_mysql_alter_database_charset_sql() {
        assert_eq!(
            MysqlDriver::alter_database_charset_sql("app", "utf8mb4").unwrap(),
            "ALTER DATABASE `app` DEFAULT CHARACTER SET `utf8mb4`"
        );
        assert_eq!(
            MysqlDriver::alter_database_charset_sql("odd`name", "utf8mb4").unwrap(),
            "ALTER DATABASE `odd``name` DEFAULT CHARACTER SET `utf8mb4`"
        );
    }

    #[test]
    fn builds_mysql_drop_database_sql() {
        assert_eq!(
            MysqlDriver::drop_database_sql("app").unwrap(),
            "DROP DATABASE `app`"
        );
    }

    #[test]
    fn builds_mysql_create_table_sql() {
        let input = CreateTableInput {
            basics: TableSchemaBasics {
                table_name: "users".to_string(),
                database_name: "app".to_string(),
                schema_name: "".to_string(),
                engine: Some("InnoDB".to_string()),
                charset: Some("utf8mb4".to_string()),
                collation: Some("utf8mb4_0900_ai_ci".to_string()),
                comment: Some("User table".to_string()),
                partition: None,
            },
            columns: vec![
                TableColumnSchema {
                    name: "id".to_string(),
                    type_name: "bigint".to_string(),
                    nullable: false,
                    default_value: None,
                    is_primary_key: true,
                    is_unique: false,
                    is_identity: true,
                    identity: None,
                    generated: None,
                    charset: None,
                    collation: None,
                    comment: Some("Identifier".to_string()),
                },
                TableColumnSchema {
                    name: "name".to_string(),
                    type_name: "varchar(255)".to_string(),
                    nullable: false,
                    default_value: Some("'anonymous'".to_string()),
                    is_primary_key: false,
                    is_unique: false,
                    is_identity: false,
                    identity: None,
                    generated: None,
                    charset: None,
                    collation: None,
                    comment: None,
                },
                TableColumnSchema {
                    name: "email".to_string(),
                    type_name: "varchar(255)".to_string(),
                    nullable: true,
                    default_value: None,
                    is_primary_key: false,
                    is_unique: true,
                    is_identity: false,
                    identity: None,
                    generated: None,
                    charset: None,
                    collation: None,
                    comment: None,
                },
            ],
            indexes: vec![TableIndexSchema {
                name: "idx_users_name".to_string(),
                columns: vec!["name".to_string()],
                is_unique: false,
                method: None,
                comment: None,
            }],
            constraints: Vec::new(),
        };

        assert_eq!(
            MysqlDriver::create_table_sql(&input, None).unwrap(),
            "CREATE TABLE `app`.`users` (\n  `id` bigint NOT NULL AUTO_INCREMENT COMMENT 'Identifier',\n  `name` varchar(255) NOT NULL DEFAULT 'anonymous',\n  `email` varchar(255) NULL,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY (`email`),\n  KEY `idx_users_name` (`name`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='User table'"
        );
    }

    #[test]
    fn builds_mysql_create_table_with_foreign_key_and_check() {
        let mut input = minimal_create_table_input();
        input.columns.push(TableColumnSchema {
            name: "org_id".to_string(),
            type_name: "bigint".to_string(),
            nullable: false,
            default_value: None,
            is_primary_key: false,
            is_unique: false,
            is_identity: false,
            identity: None,
            generated: None,
            charset: None,
            collation: None,
            comment: None,
        });
        input.constraints.push(TableConstraintSchema {
            name: "fk_users_org".to_string(),
            kind: TableConstraintKind::ForeignKey,
            columns: vec!["org_id".to_string()],
            reference: None,
            expression: None,
            comment: None,
            foreign_key: Some(TableForeignKeyReference {
                database_name: None,
                schema_name: None,
                table_name: "orgs".to_string(),
                columns: vec!["id".to_string()],
                on_update: Some(TableReferentialAction::Cascade),
                on_delete: Some(TableReferentialAction::Restrict),
            }),
            enforced: Some(true),
        });
        input.constraints.push(TableConstraintSchema {
            name: "ck_users_org_id".to_string(),
            kind: TableConstraintKind::Check,
            columns: vec!["org_id".to_string()],
            reference: None,
            expression: Some("`org_id` > 0".to_string()),
            comment: None,
            foreign_key: None,
            enforced: Some(true),
        });
        input.constraints.push(TableConstraintSchema {
            name: "ck_users_name_not_empty".to_string(),
            kind: TableConstraintKind::Check,
            columns: Vec::new(),
            reference: None,
            expression: Some("char_length(`name`) > 0".to_string()),
            comment: None,
            foreign_key: None,
            enforced: Some(true),
        });

        let sql = MysqlDriver::create_table_sql(&input, None).unwrap();

        assert!(sql.contains(
            "CONSTRAINT `fk_users_org` FOREIGN KEY (`org_id`) REFERENCES `orgs` (`id`) ON UPDATE CASCADE ON DELETE RESTRICT"
        ));
        assert!(sql.contains("CONSTRAINT `ck_users_org_id` CHECK (`org_id` > 0) ENFORCED"));
        assert!(sql.contains(
            "CONSTRAINT `ck_users_name_not_empty` CHECK (char_length(`name`) > 0) ENFORCED"
        ));
    }

    #[test]
    fn builds_mysql_create_table_with_generated_columns_and_charset() {
        let mut input = minimal_create_table_input();
        input.columns.push(TableColumnSchema {
            name: "full_name".to_string(),
            type_name: "varchar(255)".to_string(),
            nullable: true,
            default_value: None,
            is_primary_key: false,
            is_unique: false,
            is_identity: false,
            identity: None,
            generated: Some(TableGeneratedColumn {
                expression: "concat(`first_name`, ' ', `last_name`)".to_string(),
                storage: TableGeneratedColumnStorage::Stored,
            }),
            charset: Some("utf8mb4".to_string()),
            collation: Some("utf8mb4_0900_ai_ci".to_string()),
            comment: None,
        });

        let sql = MysqlDriver::create_table_sql(&input, None).unwrap();

        assert!(sql.contains(
            "`full_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci GENERATED ALWAYS AS (concat(`first_name`, ' ', `last_name`)) STORED"
        ));
    }

    #[test]
    fn builds_mysql_create_table_with_partition_clause() {
        let mut input = minimal_create_table_input();
        input.basics.partition = Some(TablePartitionOptions {
            expression: Some("HASH(id)".to_string()),
            raw_clause: Some("PARTITION BY HASH(id) PARTITIONS 4".to_string()),
            readonly_description: None,
        });

        let sql = MysqlDriver::create_table_sql(&input, None).unwrap();

        assert!(sql.ends_with("PARTITION BY HASH(id) PARTITIONS 4"));
    }

    #[test]
    fn builds_mysql_drop_table_sql() {
        let input = DropTableInput {
            container: ContainerRef::table(
                ContainerKind::Table,
                "app".to_string(),
                None,
                "users".to_string(),
            ),
            confirm_destructive: false,
        };

        let (_, table_name, sql) = MysqlDriver::drop_table_sql(&input, None).unwrap();

        assert_eq!(table_name, "users");
        assert_eq!(sql, "DROP TABLE `app`.`users`");
    }

    #[test]
    fn rejects_mysql_drop_table_for_non_table_container() {
        let input = DropTableInput {
            container: ContainerRef::table(
                ContainerKind::View,
                "app".to_string(),
                None,
                "users_view".to_string(),
            ),
            confirm_destructive: true,
        };

        let error = MysqlDriver::drop_table_sql(&input, None).unwrap_err();

        assert_eq!(format!("{:?}", error.code), "ValidationFailed");
    }

    #[test]
    fn mysql_drop_table_requires_destructive_confirmation() {
        let input = DropTableInput {
            container: ContainerRef::table(
                ContainerKind::Table,
                "app".to_string(),
                None,
                "users".to_string(),
            ),
            confirm_destructive: false,
        };

        let error = MysqlDriver::ensure_destructive_drop_table_confirmed(&input).unwrap_err();

        assert_eq!(format!("{:?}", error.code), "ValidationFailed");
    }

    #[test]
    fn builds_mysql_update_table_sql() {
        let mut input = update_table_input();
        input.target.basics.comment = Some("Updated table".to_string());
        input.target.columns.push(TableColumnSchema {
            name: "email".to_string(),
            type_name: "varchar(255)".to_string(),
            nullable: true,
            default_value: None,
            is_primary_key: false,
            is_unique: false,
            is_identity: false,
            identity: None,
            generated: None,
            charset: None,
            collation: None,
            comment: None,
        });
        input.target.indexes.clear();
        input.target.indexes.push(TableIndexSchema {
            name: "idx_users_email".to_string(),
            columns: vec!["email".to_string()],
            is_unique: false,
            method: None,
            comment: None,
        });

        let (_, _, statements) = MysqlDriver::update_table_sql(&input, None).unwrap();

        assert_eq!(
            statements,
            vec![
                "ALTER TABLE `app`.`users` COMMENT = 'Updated table'".to_string(),
                "ALTER TABLE `app`.`users` ADD COLUMN `email` varchar(255) NULL".to_string(),
                "DROP INDEX `idx_users_name` ON `app`.`users`".to_string(),
                "CREATE INDEX `idx_users_email` ON `app`.`users` (`email`)".to_string(),
            ]
        );
    }

    #[test]
    fn builds_mysql_update_table_constraints() {
        let mut input = update_table_input();
        input.target.columns.push(TableColumnSchema {
            name: "org_id".to_string(),
            type_name: "bigint".to_string(),
            nullable: true,
            default_value: None,
            is_primary_key: false,
            is_unique: false,
            is_identity: false,
            identity: None,
            generated: None,
            charset: None,
            collation: None,
            comment: None,
        });
        input.target.constraints.push(TableConstraintSchema {
            name: "fk_users_org".to_string(),
            kind: TableConstraintKind::ForeignKey,
            columns: vec!["org_id".to_string()],
            reference: None,
            expression: None,
            comment: None,
            foreign_key: Some(TableForeignKeyReference {
                database_name: None,
                schema_name: None,
                table_name: "orgs".to_string(),
                columns: vec!["id".to_string()],
                on_update: Some(TableReferentialAction::Cascade),
                on_delete: Some(TableReferentialAction::Restrict),
            }),
            enforced: Some(true),
        });
        input.target.constraints.push(TableConstraintSchema {
            name: "ck_users_org_id".to_string(),
            kind: TableConstraintKind::Check,
            columns: vec!["org_id".to_string()],
            reference: None,
            expression: Some("`org_id` > 0".to_string()),
            comment: None,
            foreign_key: None,
            enforced: Some(true),
        });

        let (_, _, statements) = MysqlDriver::update_table_sql(&input, None).unwrap();

        assert!(statements.contains(&"ALTER TABLE `app`.`users` ADD CONSTRAINT `fk_users_org` FOREIGN KEY (`org_id`) REFERENCES `orgs` (`id`) ON UPDATE CASCADE ON DELETE RESTRICT".to_string()));
        assert!(statements.contains(
            &"ALTER TABLE `app`.`users` ADD CONSTRAINT `ck_users_org_id` CHECK (`org_id` > 0) ENFORCED".to_string()
        ));
    }

    #[test]
    fn builds_mysql_update_table_engine_charset_collation() {
        let mut input = update_table_input();
        input.target.basics.engine = Some("InnoDB".to_string());
        input.target.basics.charset = Some("utf8mb4".to_string());
        input.target.basics.collation = Some("utf8mb4_0900_ai_ci".to_string());

        let (_, _, statements) = MysqlDriver::update_table_sql(&input, None).unwrap();

        assert_eq!(
            statements,
            vec![
                "ALTER TABLE `app`.`users` ENGINE=InnoDB".to_string(),
                "ALTER TABLE `app`.`users` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci".to_string(),
            ]
        );
    }

    #[test]
    fn builds_mysql_drop_column_update_table_sql() {
        let mut input = update_table_input();
        input.target.indexes.clear();
        input.target.columns.retain(|column| column.name != "name");

        let (_, _, statements) = MysqlDriver::update_table_sql(&input, None).unwrap();

        assert_eq!(
            statements,
            vec![
                "DROP INDEX `idx_users_name` ON `app`.`users`".to_string(),
                "ALTER TABLE `app`.`users` DROP COLUMN `name`".to_string(),
            ]
        );
    }

    #[test]
    fn rejects_mysql_destructive_update_without_confirmation() {
        let input = update_table_input();
        let statements = vec!["ALTER TABLE `app`.`users` DROP COLUMN `name`".to_string()];

        let error = MysqlDriver::ensure_destructive_table_update_confirmed(&input, &statements)
            .unwrap_err();

        assert_eq!(error.message, "破坏性表结构变更需要确认后才能执行");
    }

    #[test]
    fn accepts_mysql_destructive_update_with_confirmation() {
        let mut input = update_table_input();
        input.confirm_destructive = true;
        let statements = vec!["ALTER TABLE `app`.`users` DROP COLUMN `name`".to_string()];

        MysqlDriver::ensure_destructive_table_update_confirmed(&input, &statements).unwrap();
    }

    #[test]
    fn marks_mysql_destructive_update_preview() {
        let mut preview = SchemaMutationPreview::from_statements(vec![
            "ALTER TABLE `app`.`users` DROP COLUMN `name`".to_string(),
        ]);

        MysqlDriver::mark_destructive_table_update_preview(&mut preview);

        assert!(preview.destructive);
        assert_eq!(preview.warnings.len(), 1);
        assert!(preview.warnings[0].contains("永久删除"));
    }

    #[test]
    fn builds_mysql_existing_column_alter_sql() {
        let mut input = update_table_input();
        input.target.basics.comment = Some("Updated table".to_string());
        input.baseline.columns[1].nullable = true;
        input.baseline.columns[1].default_value = None;
        input.baseline.columns[1].comment = None;

        input.target.columns[1].nullable = false;
        input.target.columns[1].default_value = Some("'anonymous'".to_string());
        input.target.columns[1].comment = Some("Display name".to_string());
        input.target.columns.push(TableColumnSchema {
            name: "email".to_string(),
            type_name: "varchar(255)".to_string(),
            nullable: true,
            default_value: None,
            is_primary_key: false,
            is_unique: false,
            is_identity: false,
            identity: None,
            generated: None,
            charset: None,
            collation: None,
            comment: None,
        });
        input.target.indexes.clear();
        input.target.indexes.push(TableIndexSchema {
            name: "idx_users_email".to_string(),
            columns: vec!["email".to_string()],
            is_unique: false,
            method: None,
            comment: None,
        });

        let (_, _, statements) = MysqlDriver::update_table_sql(&input, None).unwrap();

        assert_eq!(
            statements,
            vec![
                "ALTER TABLE `app`.`users` COMMENT = 'Updated table'".to_string(),
                "ALTER TABLE `app`.`users` ADD COLUMN `email` varchar(255) NULL".to_string(),
                "ALTER TABLE `app`.`users` MODIFY COLUMN `name` varchar(255) NOT NULL DEFAULT 'anonymous' COMMENT 'Display name'".to_string(),
                "DROP INDEX `idx_users_name` ON `app`.`users`".to_string(),
                "CREATE INDEX `idx_users_email` ON `app`.`users` (`email`)".to_string(),
            ]
        );
        assert_eq!(
            statements
                .iter()
                .filter(|statement| statement.contains(" MODIFY COLUMN "))
                .count(),
            1
        );
    }

    #[test]
    fn builds_mysql_column_rename_and_type_update_sql() {
        let mut input = update_table_input();
        input.column_renames.push(TableColumnRename {
            old_name: "name".to_string(),
            new_name: "display_name".to_string(),
        });
        input.target.columns[1].name = "display_name".to_string();
        input.target.columns[1].type_name = "text".to_string();
        input.target.columns[1].comment = Some("Display name".to_string());
        input.target.indexes[0].columns = vec!["display_name".to_string()];

        let (_, _, statements) = MysqlDriver::update_table_sql(&input, None).unwrap();

        assert_eq!(
            statements,
            vec![
                "ALTER TABLE `app`.`users` CHANGE COLUMN `name` `display_name` text NOT NULL COMMENT 'Display name'".to_string(),
                "DROP INDEX `idx_users_name` ON `app`.`users`".to_string(),
                "CREATE INDEX `idx_users_name` ON `app`.`users` (`display_name`)".to_string(),
            ]
        );
        assert!(MysqlDriver::table_update_statements_are_destructive(
            &statements
        ));
    }

    #[test]
    fn builds_mysql_primary_key_change_sql() {
        let mut input = update_table_input();
        input.baseline.columns[0].is_identity = false;
        input.target.columns[0].is_primary_key = false;
        input.target.columns[0].is_identity = false;
        input.target.columns[1].is_primary_key = true;

        let (_, _, statements) = MysqlDriver::update_table_sql(&input, None).unwrap();

        assert_eq!(
            statements,
            vec![
                "ALTER TABLE `app`.`users` DROP PRIMARY KEY".to_string(),
                "ALTER TABLE `app`.`users` ADD PRIMARY KEY (`name`)".to_string(),
            ]
        );
        assert!(MysqlDriver::table_update_statements_are_destructive(
            &statements
        ));
    }

    #[test]
    fn warns_when_mysql_column_is_tightened_to_not_null() {
        let mut input = update_table_input();
        input.baseline.columns[1].nullable = true;
        input.target.columns[1].nullable = false;

        let (_, _, statements) = MysqlDriver::update_table_sql(&input, None).unwrap();
        assert!(statements
            .iter()
            .any(|statement| statement.contains("MODIFY COLUMN")));
    }

    #[test]
    fn preserves_mysql_on_update_fragment_in_existing_column_modify_sql() {
        let mut input = update_table_input();
        input.baseline.columns[1].type_name = "timestamp".to_string();
        input.baseline.columns[1].nullable = false;
        input.baseline.columns[1].default_value = mysql_table_design_default_fragment(
            Some("CURRENT_TIMESTAMP".to_string()),
            "on update CURRENT_TIMESTAMP",
        );
        input.target.columns[1] = input.baseline.columns[1].clone();
        input.target.columns[1].comment = Some("Touched at".to_string());

        let (_, _, statements) = MysqlDriver::update_table_sql(&input, None).unwrap();

        assert_eq!(
            statements,
            vec![
                "ALTER TABLE `app`.`users` MODIFY COLUMN `name` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Touched at'".to_string()
            ]
        );
    }

    #[test]
    fn rejects_mysql_on_update_column_without_explicit_default_modify_sql() {
        let mut input = update_table_input();
        input.baseline.columns[1].type_name = mysql_table_design_type_name(
            "timestamp".to_string(),
            "on update CURRENT_TIMESTAMP",
            None,
            None,
            None,
            None,
            None,
            None,
        );
        input.baseline.columns[1].nullable = true;
        input.baseline.columns[1].default_value =
            mysql_table_design_default_fragment(None, "on update CURRENT_TIMESTAMP");
        input.target.columns[1] = input.baseline.columns[1].clone();
        input.target.columns[1].comment = Some("Touched at".to_string());

        let error = MysqlDriver::update_table_sql(&input, None).unwrap_err();

        assert_eq!(
            error.message,
            "暂不支持修改包含 ON UPDATE 且无显式默认值的 MySQL 列 'name'"
        );
    }

    #[test]
    fn rejects_mysql_unquoted_string_default_metadata_modify_sql() {
        let mut input = update_table_input();
        input.baseline.columns[1].type_name = mysql_table_design_type_name(
            "varchar(255)".to_string(),
            "",
            None,
            Some("anonymous"),
            None,
            None,
            None,
            None,
        );
        input.baseline.columns[1].default_value =
            mysql_table_design_default_fragment(Some("anonymous".to_string()), "");
        input.target.columns[1] = input.baseline.columns[1].clone();
        input.target.columns[1].comment = Some("Display name".to_string());

        match MysqlDriver::update_table_sql(&input, None) {
            Ok((_, _, statements)) => panic!(
                "expected unsafe default metadata to be rejected, got SQL: {}",
                statements.join("; ")
            ),
            Err(error) => assert_eq!(
                error.message,
                "暂不支持修改包含无法安全回放默认值元数据的 MySQL 列 'name'"
            ),
        }
    }

    #[test]
    fn builds_mysql_column_charset_collation_modify_sql() {
        let mut input = update_table_input();
        input.baseline.basics.charset = Some("utf8mb4".to_string());
        input.baseline.basics.collation = Some("utf8mb4_0900_ai_ci".to_string());
        input.target.basics.charset = input.baseline.basics.charset.clone();
        input.target.basics.collation = input.baseline.basics.collation.clone();
        input.baseline.columns[1].charset = Some("latin1".to_string());
        input.baseline.columns[1].collation = Some("latin1_swedish_ci".to_string());
        input.target.columns[1] = input.baseline.columns[1].clone();
        input.target.columns[1].comment = Some("Display name".to_string());

        let (_, _, statements) = MysqlDriver::update_table_sql(&input, None).unwrap();

        assert_eq!(
            statements,
            vec![
                "ALTER TABLE `app`.`users` MODIFY COLUMN `name` varchar(255) CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL COMMENT 'Display name'".to_string(),
            ]
        );
    }

    #[test]
    fn builds_mysql_enum_literal_collate_charset_collation_modify_sql() {
        let mut input = update_table_input();
        input.baseline.basics.charset = Some("utf8mb4".to_string());
        input.baseline.basics.collation = Some("utf8mb4_0900_ai_ci".to_string());
        input.target.basics.charset = input.baseline.basics.charset.clone();
        input.target.basics.collation = input.baseline.basics.collation.clone();
        input.baseline.columns[1].type_name = "enum('collate')".to_string();
        input.baseline.columns[1].charset = Some("latin1".to_string());
        input.baseline.columns[1].collation = Some("latin1_swedish_ci".to_string());
        input.target.columns[1] = input.baseline.columns[1].clone();
        input.target.columns[1].comment = Some("Display name".to_string());

        let (_, _, statements) = MysqlDriver::update_table_sql(&input, None).unwrap();

        assert_eq!(
            statements,
            vec![
                "ALTER TABLE `app`.`users` MODIFY COLUMN `name` enum('collate') CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL COMMENT 'Display name'".to_string(),
            ]
        );
    }

    #[test]
    fn builds_mysql_generated_column_existing_column_modify_sql() {
        let mut input = update_table_input();
        input.baseline.columns[1].type_name = "int".to_string();
        input.baseline.columns[1].generated = Some(TableGeneratedColumn {
            expression: "`id` + 1".to_string(),
            storage: TableGeneratedColumnStorage::Virtual,
        });
        input.target.columns[1] = input.baseline.columns[1].clone();
        input.target.columns[1].comment = Some("Generated value".to_string());

        let (_, _, statements) = MysqlDriver::update_table_sql(&input, None).unwrap();

        assert_eq!(
            statements,
            vec![
                "ALTER TABLE `app`.`users` MODIFY COLUMN `name` int GENERATED ALWAYS AS (`id` + 1) VIRTUAL COMMENT 'Generated value'".to_string(),
            ]
        );
    }

    #[test]
    fn rejects_mysql_private_marker_type_name_in_column_definition() {
        for marker in [
            MYSQL_UNSAFE_ON_UPDATE_TYPE_MARKER,
            MYSQL_UNSAFE_DEFAULT_TYPE_MARKER,
        ] {
            let column = TableColumnSchema {
                name: "unsafe_column".to_string(),
                type_name: format!("timestamp {marker}"),
                nullable: true,
                default_value: None,
                is_primary_key: false,
                is_unique: false,
                is_identity: false,
                identity: None,
                generated: None,
                charset: None,
                collation: None,
                comment: None,
            };

            assert!(mysql_column_definition(&column).is_err());
        }
    }

    #[test]
    fn rejects_mysql_create_table_foreign_key_for_phase_three() {
        let mut input = minimal_create_table_input();
        input.constraints.push(TableConstraintSchema {
            name: "fk_users_org".to_string(),
            kind: TableConstraintKind::ForeignKey,
            columns: vec!["id".to_string()],
            reference: Some("orgs(id)".to_string()),
            expression: None,
            comment: None,
            foreign_key: None,
            enforced: None,
        });

        assert!(MysqlDriver::create_table_sql(&input, None).is_err());
    }

    #[test]
    fn table_and_view_are_table_data_containers() {
        assert!(ensure_mysql_table_data_container(&ContainerKind::Table).is_ok());
        assert!(ensure_mysql_table_data_container(&ContainerKind::View).is_ok());
    }

    #[test]
    fn classifies_mysql_column_data_categories() {
        assert_eq!(
            MysqlDriver::classify_column_data_category("tinyint", "tinyint(1)"),
            ColumnDataCategory::Boolean
        );
        assert_eq!(
            MysqlDriver::classify_column_data_category("int", "int unsigned"),
            ColumnDataCategory::Number
        );
        assert_eq!(
            MysqlDriver::classify_column_data_category("datetime", "datetime"),
            ColumnDataCategory::Datetime
        );
        assert_eq!(
            MysqlDriver::classify_column_data_category("json", "json"),
            ColumnDataCategory::Json
        );
        assert_eq!(
            MysqlDriver::classify_column_data_category("blob", "blob"),
            ColumnDataCategory::Binary
        );
    }

    #[test]
    fn parses_mysql_enum_values() {
        assert_eq!(
            MysqlDriver::parse_enum_values("enum('draft','published','it''s ok')"),
            Some(vec![
                "draft".to_string(),
                "published".to_string(),
                "it's ok".to_string()
            ])
        );
        assert_eq!(MysqlDriver::parse_enum_values("varchar(255)"), None);
    }

    #[test]
    fn casts_mysql_temporal_table_values_to_text_for_json_transport() {
        let column = test_column("created_at", "datetime", ColumnDataCategory::Datetime);

        assert_eq!(
            mysql_table_select_expression(&column),
            "CAST(`created_at` AS CHAR) AS `created_at`"
        );
    }

    #[test]
    fn keeps_mysql_numeric_table_values_typed() {
        let mut column = test_column("score", "int", ColumnDataCategory::Number);
        column.numeric_precision = Some(10);
        column.numeric_scale = Some(0);

        assert_eq!(mysql_table_select_expression(&column), "`score`");
    }

    #[test]
    fn casts_mysql_bigint_table_values_to_text_for_json_transport() {
        for type_name in ["bigint", "bigint unsigned"] {
            let column = test_column("id", type_name, ColumnDataCategory::Number);

            assert_eq!(
                mysql_table_select_expression(&column),
                "CAST(`id` AS CHAR) AS `id`"
            );
        }
    }

    #[test]
    fn casts_mysql_exact_or_display_numeric_values_to_text_for_table_display() {
        for type_name in ["decimal(12,2)", "year"] {
            let column = test_column("value", type_name, ColumnDataCategory::Number);

            assert_eq!(
                mysql_table_select_expression(&column),
                "CAST(`value` AS CHAR) AS `value`"
            );
        }
    }

    #[test]
    fn keeps_mysql_mediumint_table_values_typed() {
        for type_name in ["mediumint", "mediumint unsigned"] {
            let column = test_column("value", type_name, ColumnDataCategory::Number);

            assert_eq!(mysql_table_select_expression(&column), "`value`");
        }
    }

    #[test]
    fn casts_mysql_bit_values_to_readable_text_for_table_display() {
        let column = test_column("flags", "bit(8)", ColumnDataCategory::Number);

        assert_eq!(
            mysql_table_select_expression(&column),
            "LPAD(BIN(CAST(`flags` AS UNSIGNED)), 8, '0') AS `flags`"
        );
    }

    #[test]
    fn renders_mysql_binary_values_as_marker_for_table_display() {
        for type_name in ["binary(16)", "varbinary(255)", "blob"] {
            let column = test_column("payload", type_name, ColumnDataCategory::Binary);

            assert_eq!(
                mysql_table_select_expression(&column),
                "CASE WHEN `payload` IS NULL THEN NULL ELSE '<BINARY>' END AS `payload`"
            );
        }
    }

    #[test]
    fn casts_mysql_geometry_values_to_wkt_for_table_display() {
        let column = test_column("location", "point", ColumnDataCategory::Unknown);

        assert_eq!(
            mysql_table_select_expression(&column),
            "ST_AsText(`location`) AS `location`"
        );
    }

    #[test]
    fn builds_mysql_table_page_stats_sql() {
        assert_eq!(
            mysql_table_page_stats_sql("`app`.`users`", ""),
            "SELECT CAST(COUNT(*) AS CHAR) FROM `app`.`users`"
        );
    }

    fn minimal_create_table_input() -> CreateTableInput {
        CreateTableInput {
            basics: TableSchemaBasics {
                table_name: "users".to_string(),
                database_name: "app".to_string(),
                schema_name: "".to_string(),
                engine: None,
                charset: None,
                collation: None,
                comment: None,
                partition: None,
            },
            columns: vec![TableColumnSchema {
                name: "id".to_string(),
                type_name: "bigint".to_string(),
                nullable: false,
                default_value: None,
                is_primary_key: true,
                is_unique: false,
                is_identity: true,
                identity: None,
                generated: None,
                charset: None,
                collation: None,
                comment: None,
            }],
            indexes: Vec::new(),
            constraints: Vec::new(),
        }
    }

    fn update_table_input() -> UpdateTableInput {
        let schema = TableSchema {
            basics: TableSchemaBasics {
                table_name: "users".to_string(),
                database_name: "app".to_string(),
                schema_name: "".to_string(),
                engine: None,
                charset: None,
                collation: None,
                comment: Some("User table".to_string()),
                partition: None,
            },
            columns: vec![
                TableColumnSchema {
                    name: "id".to_string(),
                    type_name: "bigint".to_string(),
                    nullable: false,
                    default_value: None,
                    is_primary_key: true,
                    is_unique: false,
                    is_identity: true,
                    identity: None,
                    generated: None,
                    charset: None,
                    collation: None,
                    comment: None,
                },
                TableColumnSchema {
                    name: "name".to_string(),
                    type_name: "varchar(255)".to_string(),
                    nullable: false,
                    default_value: None,
                    is_primary_key: false,
                    is_unique: false,
                    is_identity: false,
                    identity: None,
                    generated: None,
                    charset: None,
                    collation: None,
                    comment: None,
                },
            ],
            indexes: vec![TableIndexSchema {
                name: "idx_users_name".to_string(),
                columns: vec!["name".to_string()],
                is_unique: false,
                method: None,
                comment: None,
            }],
            constraints: Vec::new(),
        };

        UpdateTableInput {
            container: ContainerRef::table(ContainerKind::Table, "app", None, "users"),
            baseline: schema.clone(),
            target: schema,
            column_renames: Vec::new(),
            confirm_destructive: false,
        }
    }
}
