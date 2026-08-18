use std::collections::{HashMap, HashSet};
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures_util::TryStreamExt;
use serde_json::Value;
use sqlx::pool::PoolConnection;
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgQueryResult, PgRow, PgSslMode};
use sqlx::{Column, Executor, Postgres, Row, TypeInfo};
use tokio::sync::Mutex;

use crate::engine::driver::{
    DataTableBrowser, DatabaseDriver, SchemaBrowser, SchemaMutator, SqlExecutor, TransactionManager,
};
use crate::engine::drivers::common::{
    build_table_change_set_preview, classify_sqlx_connection_error, classify_sqlx_query_error,
    diff_table_schema_for_update_with_column_renames, ensure_real_table_for_mutation,
    json_i64_for_js_transport, normalized_non_empty_identifier, postgres_empty_insert_statement,
    quote_pg_identifier, render_sql_literal, sql_is_single_statement,
    sql_should_report_affected_rows, table_browse_sql_plan, table_page_stats, ColumnIdentityChange,
    TableBrowseBindValue, TableBrowsePlaceholderStyle, TableUpdateDiffOptions,
};
use crate::engine::profiles::PostgresProfile;
use crate::engine::ssh_tunnel::{self, SshTunnelRuntime};
use crate::engine::types::{
    AssetGroupType, ColumnDataCategory, ColumnMeta, ContainerKind, ContainerRef,
    CreateDatabaseInput, CreateDatabaseResult, CreateTableInput, CreateTableResult, DataContainer,
    DriverCapabilities, DropDatabaseInput, DropDatabaseResult, DropTableInput, DropTableResult,
    PingResult, QueryResult, SchemaMutationFeatures, SchemaMutationPreview, SqlExecutionContext,
    TableBrowseQuery, TableCellChange, TableChangeOutcome, TableChangeSetCommitResult,
    TableChangeSetPreview, TableChangeSetRequest, TableChangeSetUpdate, TableColumnSchema,
    TableConstraintKind, TableConstraintSchema, TableForeignKeyReference, TableIdentityGeneration,
    TableIdentityOptions, TableIndexSchema, TableMutationResult, TablePageStats,
    TableReferentialAction, TableRowKey, TableRowLocator, TableSchema, TableSchemaBasics,
    TableTransactionState, UpdateDatabaseInput, UpdateDatabaseResult, UpdateTableInput,
    UpdateTableResult,
};
use crate::error::{IpcError, IpcResult};

mod ddl;
mod row;
mod type_helpers;

fn bind_postgres_table_query<'q>(
    sql: &'q str,
    bindings: &'q [TableBrowseBindValue],
) -> sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments> {
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

pub struct PostgresDriver {
    profile_id: String,
    profile: PostgresProfile,
    pool: PgPool,
    db_pools: StdMutex<HashMap<String, PgPool>>,
    transaction: Mutex<Option<PostgresTransactionSession>>,
    _tunnel: Option<SshTunnelRuntime>,
}

struct PostgresTransactionSession {
    database: String,
    connection: PoolConnection<Postgres>,
}

struct PostgresSqlExecutionParts {
    database: String,
    schema: String,
}

struct PostgresColumnInfo {
    name: String,
    type_name: String,
    data_type: String,
    udt_schema: String,
    udt_name: String,
    nullable: bool,
    default_value: Option<String>,
    is_generated: String,
    is_identity: String,
    max_length: Option<i64>,
    numeric_precision: Option<i32>,
    numeric_scale: Option<i32>,
}

type PostgresTableDesignColumnRow = (String, String, bool, Option<String>, bool, Option<String>);

type PostgresForeignKeyRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

type PostgresColumnMetaRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    String,
    Option<i32>,
    Option<i32>,
    Option<i32>,
);

const MAINTENANCE_DATABASE: &str = "postgres";

fn postgres_lock_error(context: &str) -> IpcError {
    IpcError::system_internal(
        format!("{context}: internal lock poisoned"),
        "A previous operation panicked while holding a lock",
    )
}

impl PostgresDriver {
    pub async fn connect(profile_id: String, profile: PostgresProfile) -> IpcResult<Self> {
        Self::validate_runtime_profile(&profile)?;
        let database = profile
            .default_database
            .as_deref()
            .filter(|database| !database.trim().is_empty())
            .unwrap_or(MAINTENANCE_DATABASE);
        let endpoint =
            ssh_tunnel::resolve_endpoint(&profile.host, profile.port, profile.ssh_tunnel.as_ref())
                .await?;
        let options = Self::connect_options(&profile, &endpoint.host, endpoint.port, database)?;
        let pool = Self::pool_options(&profile)
            .connect_with(options)
            .await
            .map_err(|error| classify_sqlx_connection_error(error, "PostgreSQL"))?;

        Ok(Self {
            profile_id,
            profile,
            pool,
            db_pools: StdMutex::new(HashMap::new()),
            transaction: Mutex::new(None),
            _tunnel: endpoint.tunnel,
        })
    }

    fn validate_runtime_profile(profile: &PostgresProfile) -> IpcResult<()> {
        if profile.ssh_tunnel.as_ref().is_some_and(|ssh| ssh.enabled)
            && profile.ssl_mode.as_deref() == Some("verify-full")
        {
            return Err(IpcError::validation_failed(
                "SSH tunnel does not support PostgreSQL verify-full hostname verification",
            ));
        }
        Ok(())
    }

    fn connect_options(
        profile: &PostgresProfile,
        host: &str,
        port: u16,
        database: &str,
    ) -> IpcResult<PgConnectOptions> {
        Ok(PgConnectOptions::new()
            .host(host)
            .port(port)
            .username(&profile.username)
            .password(&profile.password)
            .database(database)
            .ssl_mode(Self::pg_ssl_mode(profile.ssl_mode.as_deref())?))
    }

    fn connect_timeout(profile: &PostgresProfile) -> Duration {
        Duration::from_secs(profile.connect_timeout_seconds.unwrap_or(5).clamp(1, 300))
    }

    fn pool_options(profile: &PostgresProfile) -> PgPoolOptions {
        PgPoolOptions::new()
            .max_connections(5)
            .acquire_timeout(Self::connect_timeout(profile))
    }

    fn pg_ssl_mode(mode: Option<&str>) -> IpcResult<PgSslMode> {
        match mode.unwrap_or("disable") {
            "disable" => Ok(PgSslMode::Disable),
            "require" => Ok(PgSslMode::Require),
            "verify-ca" => Ok(PgSslMode::VerifyCa),
            "verify-full" => Ok(PgSslMode::VerifyFull),
            value => Err(IpcError::validation_failed(format!(
                "Unsupported PostgreSQL SSL mode '{value}'"
            ))),
        }
    }

    fn connection_database(&self) -> &str {
        self.profile
            .default_database
            .as_deref()
            .filter(|database| !database.trim().is_empty())
            .unwrap_or(MAINTENANCE_DATABASE)
    }

    async fn pool_for_database(&self, database: &str) -> IpcResult<PgPool> {
        if database == self.connection_database() {
            return Ok(self.pool.clone());
        }

        {
            let pools = self
                .db_pools
                .lock()
                .map_err(|_| postgres_lock_error("pool_for_database"))?;
            if let Some(cached) = pools.get(database) {
                return Ok(cached.clone());
            }
        }

        let (host, port) = self.active_host_port();
        let options = Self::connect_options(&self.profile, host, port, database)?;
        let pool = Self::pool_options(&self.profile)
            .connect_with(options)
            .await
            .map_err(|error| classify_sqlx_connection_error(error, "PostgreSQL"))?;

        self.db_pools
            .lock()
            .map_err(|_| postgres_lock_error("pool_for_database"))?
            .insert(database.to_string(), pool.clone());
        Ok(pool)
    }

    fn active_host_port(&self) -> (&str, u16) {
        if let Some(tunnel) = self._tunnel.as_ref() {
            (tunnel.local_host(), tunnel.local_port())
        } else {
            (&self.profile.host, self.profile.port)
        }
    }

    fn configured_database(&self) -> Option<&str> {
        self.profile
            .default_database
            .as_deref()
            .filter(|database| !database.trim().is_empty())
    }

    fn default_schema(&self) -> String {
        self.profile
            .schema
            .clone()
            .unwrap_or_else(|| "public".to_string())
    }

    fn sql_execution_parts(
        profile: &PostgresProfile,
        context: &SqlExecutionContext,
    ) -> IpcResult<PostgresSqlExecutionParts> {
        let database = context
            .database
            .as_deref()
            .map(str::trim)
            .filter(|database| !database.is_empty())
            .or_else(|| {
                profile
                    .default_database
                    .as_deref()
                    .map(str::trim)
                    .filter(|database| !database.is_empty())
            })
            .unwrap_or(MAINTENANCE_DATABASE);

        let schema = context
            .schema
            .as_deref()
            .map(str::trim)
            .filter(|schema| !schema.is_empty())
            .or_else(|| {
                profile
                    .schema
                    .as_deref()
                    .map(str::trim)
                    .filter(|schema| !schema.is_empty())
            })
            .unwrap_or("public");

        let database = normalized_non_empty_identifier(database, "数据库名称")?;
        let schema = normalized_non_empty_identifier(schema, "Schema")?;
        Self::ensure_sql_execution_schema_name(&schema)?;

        Ok(PostgresSqlExecutionParts { database, schema })
    }

    fn postgres_set_search_path_sql(schema: &str) -> String {
        format!("SET search_path TO {}", quote_pg_identifier(schema))
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

    fn create_database_sql(name: &str) -> IpcResult<String> {
        let name = normalized_non_empty_identifier(name, "数据库名称")?;
        Ok(format!("CREATE DATABASE {}", quote_pg_identifier(&name)))
    }

    fn create_table_statements(
        input: &CreateTableInput,
        default_database: &str,
        default_schema: &str,
    ) -> IpcResult<Vec<String>> {
        let (_, schema, table) = Self::create_table_parts(input, default_database, default_schema)?;
        let table_name = format!(
            "{}.{}",
            quote_pg_identifier(&schema),
            quote_pg_identifier(&table)
        );
        let schema = normalize_create_table_input(input)?;
        let mut definitions = Vec::new();

        for column in &schema.columns {
            definitions.push(postgres_column_definition(column)?);
        }

        if !schema.primary_key_columns.is_empty() {
            definitions.push(format!(
                "PRIMARY KEY ({})",
                quote_column_list(&schema.primary_key_columns, quote_pg_identifier)
            ));
        }

        for unique in &schema.unique_constraints {
            let prefix = unique
                .name
                .as_deref()
                .map(|name| format!("CONSTRAINT {} ", quote_pg_identifier(name)))
                .unwrap_or_default();
            definitions.push(format!(
                "{prefix}UNIQUE ({})",
                quote_column_list(&unique.columns, quote_pg_identifier)
            ));
        }

        for constraint in &schema.table_constraints {
            definitions.push(postgres_table_constraint_definition(constraint)?);
        }

        let body = definitions
            .into_iter()
            .map(|definition| format!("  {definition}"))
            .collect::<Vec<_>>()
            .join(",\n");
        let mut create_statement = format!("CREATE TABLE {table_name} (\n{body}\n)");
        if let Some(partition_options) = input.basics.partition.as_ref() {
            if let Some(partition) =
                normalized_optional_fragment(partition_options.raw_clause.as_deref(), "分区子句")?
            {
                create_statement.push(' ');
                create_statement.push_str(&partition);
            }
        }
        let mut statements = vec![create_statement];

        if let Some(comment) = normalized_optional_text(input.basics.comment.as_deref()) {
            statements.push(format!(
                "COMMENT ON TABLE {table_name} IS {}",
                render_sql_literal(&Value::String(comment))?
            ));
        }

        for column in &schema.columns {
            if let Some(comment) = normalized_optional_text(column.comment.as_deref()) {
                statements.push(format!(
                    "COMMENT ON COLUMN {}.{} IS {}",
                    table_name,
                    quote_pg_identifier(&column.name),
                    render_sql_literal(&Value::String(comment))?
                ));
            }
        }

        for index in &schema.indexes {
            let name = normalized_non_empty_identifier(&index.name, "索引名")?;
            let columns = validate_column_refs(&index.columns, &schema.column_names, "索引列")?;
            let method = normalized_optional_fragment(index.method.as_deref(), "索引方法")?
                .unwrap_or_else(|| "btree".to_string());
            let unique = if index.is_unique { "UNIQUE " } else { "" };
            statements.push(format!(
                "CREATE {unique}INDEX {} ON {table_name} USING {method} ({})",
                quote_pg_identifier(&name),
                quote_column_list(&columns, quote_pg_identifier)
            ));
        }

        Ok(statements)
    }

    fn create_table_parts(
        input: &CreateTableInput,
        default_database: &str,
        default_schema: &str,
    ) -> IpcResult<(String, String, String)> {
        let database = if input.basics.database_name.trim().is_empty() {
            default_database
        } else {
            input.basics.database_name.as_str()
        };
        let schema = if input.basics.schema_name.trim().is_empty() {
            default_schema
        } else {
            input.basics.schema_name.as_str()
        };
        let database = normalized_non_empty_identifier(database, "数据库名称")?;
        let schema = normalized_non_empty_identifier(schema, "Schema")?;
        Self::ensure_user_schema_name(&schema)?;
        let table = normalized_non_empty_identifier(&input.basics.table_name, "表名")?;
        Ok((database, schema, table))
    }

    fn update_table_parts(
        input: &UpdateTableInput,
        default_database: &str,
        default_schema: &str,
    ) -> IpcResult<(String, String, String)> {
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
            .unwrap_or(default_database);
        let schema = input
            .container
            .schema
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(default_schema);
        let table = input
            .container
            .table
            .as_deref()
            .or(input.container.object_name.as_deref())
            .unwrap_or(input.target.basics.table_name.as_str());

        let database = normalized_non_empty_identifier(database, "数据库名称")?;
        let schema = normalized_non_empty_identifier(schema, "Schema")?;
        Self::ensure_user_schema_name(&schema)?;
        let table = normalized_non_empty_identifier(table, "表名")?;

        ensure_schema_matches_postgres_table_parts(&input.baseline, &database, &schema, &table)?;
        ensure_schema_matches_postgres_table_parts(&input.target, &database, &schema, &table)?;

        Ok((database, schema, table))
    }

    fn update_table_statements(
        input: &UpdateTableInput,
        default_database: &str,
        default_schema: &str,
    ) -> IpcResult<(String, String, String, Vec<String>)> {
        let (database, schema, table) =
            Self::update_table_parts(input, default_database, default_schema)?;
        let table_name = format!(
            "{}.{}",
            quote_pg_identifier(&schema),
            quote_pg_identifier(&table)
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
            let literal = match change.comment {
                Some(comment) => render_sql_literal(&Value::String(comment))?,
                None => "NULL".to_string(),
            };
            statements.push(format!("COMMENT ON TABLE {table_name} IS {literal}"));
        }

        for column in &diff.added_columns {
            statements.push(format!(
                "ALTER TABLE {table_name} ADD COLUMN {}",
                postgres_column_definition(column)?
            ));
            if let Some(comment) = normalized_optional_text(column.comment.as_deref()) {
                statements.push(format!(
                    "COMMENT ON COLUMN {}.{} IS {}",
                    table_name,
                    quote_pg_identifier(&column.name),
                    render_sql_literal(&Value::String(comment))?
                ));
            }
        }

        for rename in &diff.renamed_columns {
            statements.push(format!(
                "ALTER TABLE {table_name} RENAME COLUMN {} TO {}",
                quote_pg_identifier(&rename.old_name),
                quote_pg_identifier(&rename.new_name)
            ));
        }

        for change in &diff.column_type_changes {
            let column_name = normalized_non_empty_identifier(&change.column_name, "列名")?;
            let type_name = normalized_sql_fragment(&change.type_name, "列类型")?;
            statements.push(format!(
                "ALTER TABLE {table_name} ALTER COLUMN {} TYPE {}",
                quote_pg_identifier(&column_name),
                type_name
            ));
        }

        for change in &diff.column_default_changes {
            let column_name = normalized_non_empty_identifier(&change.column_name, "列名")?;
            match normalized_optional_fragment(change.default_value.as_deref(), "默认值")? {
                Some(default_value) => statements.push(format!(
                    "ALTER TABLE {table_name} ALTER COLUMN {} SET DEFAULT {}",
                    quote_pg_identifier(&column_name),
                    default_value
                )),
                None => statements.push(format!(
                    "ALTER TABLE {table_name} ALTER COLUMN {} DROP DEFAULT",
                    quote_pg_identifier(&column_name)
                )),
            }
        }

        for change in &diff.column_nullability_changes {
            let column_name = normalized_non_empty_identifier(&change.column_name, "列名")?;
            let action = if change.nullable {
                "DROP NOT NULL"
            } else {
                "SET NOT NULL"
            };
            statements.push(format!(
                "ALTER TABLE {table_name} ALTER COLUMN {} {action}",
                quote_pg_identifier(&column_name)
            ));
        }

        for change in &diff.column_comment_changes {
            let literal = match &change.comment {
                Some(comment) => render_sql_literal(&Value::String(comment.clone()))?,
                None => "NULL".to_string(),
            };
            statements.push(format!(
                "COMMENT ON COLUMN {}.{} IS {}",
                table_name,
                quote_pg_identifier(&change.column_name),
                literal
            ));
        }

        if let Some(change) = diff.generated_column_changes.first() {
            return Err(IpcError::validation_failed(format!(
                "暂不支持修改已有 PostgreSQL 生成列 '{}'",
                change.column_name
            )));
        }

        for change in &diff.identity_changes {
            statements.extend(postgres_identity_change_statements(&table_name, change)?);
        }

        if let Some(change) = &diff.primary_key_change {
            if !change.old_columns.is_empty() {
                let Some(name) = normalized_optional_text(change.old_constraint_name.as_deref())
                else {
                    return Err(IpcError::validation_failed(
                        "无法确定当前 PostgreSQL 主键约束名，请刷新表结构后重试",
                    ));
                };
                statements.push(format!(
                    "ALTER TABLE {table_name} DROP CONSTRAINT {}",
                    quote_pg_identifier(&name)
                ));
            }
            if !change.new_columns.is_empty() {
                statements.push(format!(
                    "ALTER TABLE {table_name} ADD PRIMARY KEY ({})",
                    quote_column_list(&change.new_columns, quote_pg_identifier)
                ));
            }
        }

        for constraint in &diff.dropped_constraints {
            statements.push(postgres_drop_constraint_statement(&table_name, constraint)?);
        }

        for constraint in &diff.added_constraints {
            statements.push(format!(
                "ALTER TABLE {table_name} ADD {}",
                postgres_table_constraint_definition(constraint)?
            ));
        }

        for index in &diff.dropped_indexes {
            let name = normalized_non_empty_identifier(&index.name, "索引名")?;
            statements.push(format!(
                "DROP INDEX {}.{}",
                quote_pg_identifier(&schema),
                quote_pg_identifier(&name)
            ));
        }

        if !diff.dropped_columns.is_empty() {
            for column in &diff.dropped_columns {
                let name = normalized_non_empty_identifier(&column.name, "列名")?;
                statements.push(format!(
                    "ALTER TABLE {table_name} DROP COLUMN {}",
                    quote_pg_identifier(&name)
                ));
            }
        }

        for index in &diff.added_indexes {
            let name = normalized_non_empty_identifier(&index.name, "索引名")?;
            let columns = validate_column_refs(&index.columns, &column_names, "索引列")?;
            let method = normalized_optional_fragment(index.method.as_deref(), "索引方法")?
                .unwrap_or_else(|| "btree".to_string());
            let unique = if index.is_unique { "UNIQUE " } else { "" };
            statements.push(format!(
                "CREATE {unique}INDEX {} ON {table_name} USING {method} ({})",
                quote_pg_identifier(&name),
                quote_column_list(&columns, quote_pg_identifier)
            ));
        }

        debug_assert_eq!(
            diff_destructive,
            Self::table_update_statements_are_destructive(&statements)
        );

        Ok((database, schema, table, statements))
    }

    fn table_update_statements_are_destructive(statements: &[String]) -> bool {
        statements.iter().any(|statement| {
            statement.contains(" DROP COLUMN ")
                || statement.contains(" TYPE ")
                || statement.contains(" DROP CONSTRAINT ")
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
            .any(|statement| statement.contains(" TYPE "))
        {
            preview
                .warnings
                .push("将修改列类型；数据库可能拒绝转换，转换也可能造成数据截断".to_string());
        }
        if preview.statements.iter().any(|statement| {
            statement.contains(" DROP CONSTRAINT ") || statement.contains(" ADD PRIMARY KEY ")
        }) {
            preview
                .warnings
                .push("将修改主键；该操作可能影响依赖主键的查询、索引和应用逻辑".to_string());
        }
    }

    fn is_user_schema_name(schema: &str) -> bool {
        let schema = schema.trim().to_ascii_lowercase();
        !matches!(schema.as_str(), "information_schema" | "pg_catalog")
            && !schema.starts_with("pg_toast")
            && !schema.starts_with("pg_temp")
    }

    fn ensure_user_schema_name(schema: &str) -> IpcResult<()> {
        if Self::is_user_schema_name(schema) {
            Ok(())
        } else {
            Err(IpcError::validation_failed(
                "不能在 PostgreSQL 系统或临时 Schema 中创建表",
            ))
        }
    }

    fn ensure_sql_execution_schema_name(schema: &str) -> IpcResult<()> {
        if Self::is_user_schema_name(schema) {
            Ok(())
        } else {
            Err(IpcError::validation_failed(
                "不能在 PostgreSQL 系统或临时 Schema 中执行 SQL",
            ))
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

    fn update_database_sql(
        input: &UpdateDatabaseInput,
    ) -> IpcResult<(String, String, Vec<String>)> {
        let old_name = Self::database_name_from_container(&input.container)?;
        let requested_name = input
            .name
            .as_deref()
            .map(|name| normalized_non_empty_identifier(name, "数据库名称"))
            .transpose()?;
        let new_name = requested_name.unwrap_or_else(|| old_name.clone());
        let mut statements = Vec::new();

        if new_name != old_name {
            statements.push(format!(
                "ALTER DATABASE {} RENAME TO {}",
                quote_pg_identifier(&old_name),
                quote_pg_identifier(&new_name)
            ));
        }

        if let Some(comment) = input
            .comment
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            statements.push(format!(
                "COMMENT ON DATABASE {} IS {}",
                quote_pg_identifier(&new_name),
                render_sql_literal(&serde_json::Value::String(comment.to_string()))?
            ));
        }

        if let Some(tablespace) = input
            .tablespace
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let tablespace = normalized_non_empty_identifier(tablespace, "表空间")?;
            statements.push(format!(
                "ALTER DATABASE {} SET TABLESPACE {}",
                quote_pg_identifier(&new_name),
                quote_pg_identifier(&tablespace)
            ));
        }

        if statements.is_empty() {
            return Err(IpcError::validation_failed("没有可执行的数据库编辑内容"));
        }

        Ok((old_name, new_name, statements))
    }

    fn drop_database_sql(name: &str) -> IpcResult<String> {
        let name = normalized_non_empty_identifier(name, "数据库名称")?;
        Ok(format!("DROP DATABASE {}", quote_pg_identifier(&name)))
    }

    fn drop_table_sql(
        input: &DropTableInput,
        default_database: &str,
        default_schema: &str,
    ) -> IpcResult<(String, String, String, String)> {
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
            .unwrap_or(default_database);
        let schema = input
            .container
            .schema
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(default_schema);
        let table = input
            .container
            .table
            .as_deref()
            .or(input.container.object_name.as_deref())
            .unwrap_or_default();

        let database = normalized_non_empty_identifier(database, "数据库名称")?;
        let schema = normalized_non_empty_identifier(schema, "Schema")?;
        Self::ensure_user_schema_name(&schema)?;
        let table = normalized_non_empty_identifier(table, "表名")?;
        let sql = format!(
            "DROP TABLE {}.{}",
            quote_pg_identifier(&schema),
            quote_pg_identifier(&table)
        );

        Ok((database, schema, table, sql))
    }

    async fn list_databases(&self) -> IpcResult<Vec<DataContainer>> {
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT datname \
             FROM pg_database \
             WHERE datistemplate = false \
               AND datallowconn = true \
             ORDER BY datname",
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

    async fn list_schemas(&self, database: &str) -> IpcResult<Vec<DataContainer>> {
        let pool = self.pool_for_database(database).await?;
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT schema_name \
             FROM information_schema.schemata \
             WHERE schema_name NOT IN ('information_schema', 'pg_catalog') \
               AND schema_name NOT LIKE 'pg_toast%' \
               AND schema_name NOT LIKE 'pg_temp%' \
             ORDER BY schema_name",
        )
        .fetch_all(&pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        Ok(rows
            .into_iter()
            .map(|(schema,)| {
                let container = ContainerRef::schema(database.to_string(), schema.clone());
                DataContainer {
                    id: format!("{}::{database}::schema::{schema}", self.profile_id),
                    name: schema,
                    kind: ContainerKind::Schema,
                    is_leaf: false,
                    container,
                    type_name: None,
                    nullable: None,
                    item_count: None,
                    properties: Vec::new(),
                }
            })
            .collect())
    }

    fn asset_group(
        &self,
        database: &str,
        schema: Option<&str>,
        table: Option<&str>,
        group_type: AssetGroupType,
        name: &str,
    ) -> DataContainer {
        let group_slug = asset_group_slug(&group_type);
        let id = match (schema, table) {
            (Some(schema), Some(table)) => {
                format!(
                    "{}::{database}::{schema}::{table}::group::{group_slug}",
                    self.profile_id
                )
            }
            (Some(schema), None) => {
                format!(
                    "{}::{database}::{schema}::group::{group_slug}",
                    self.profile_id
                )
            }
            (None, _) => format!("{}::{database}::group::{group_slug}", self.profile_id),
        };
        DataContainer {
            id,
            name: name.to_string(),
            kind: ContainerKind::AssetGroup,
            is_leaf: false,
            container: ContainerRef::asset_group(
                group_type,
                Some(database.to_string()),
                schema.map(str::to_string),
                table.map(str::to_string),
            ),
            type_name: None,
            nullable: None,
            item_count: None,
            properties: Vec::new(),
        }
    }

    fn schema_asset_groups(&self, database: &str, schema: &str) -> Vec<DataContainer> {
        vec![
            self.asset_group(
                database,
                Some(schema),
                None,
                AssetGroupType::Tables,
                "Tables",
            ),
            self.asset_group(database, Some(schema), None, AssetGroupType::Views, "Views"),
            self.asset_group(
                database,
                Some(schema),
                None,
                AssetGroupType::MaterializedViews,
                "Materialized Views",
            ),
            self.asset_group(
                database,
                Some(schema),
                None,
                AssetGroupType::Functions,
                "Functions",
            ),
            self.asset_group(
                database,
                Some(schema),
                None,
                AssetGroupType::Procedures,
                "Procedures",
            ),
            self.asset_group(
                database,
                Some(schema),
                None,
                AssetGroupType::Sequences,
                "Sequences",
            ),
            self.asset_group(
                database,
                Some(schema),
                None,
                AssetGroupType::Extensions,
                "Extensions",
            ),
        ]
    }

    fn table_asset_groups(&self, database: &str, schema: &str, table: &str) -> Vec<DataContainer> {
        vec![
            self.asset_group(
                database,
                Some(schema),
                Some(table),
                AssetGroupType::Columns,
                "Columns",
            ),
            self.asset_group(
                database,
                Some(schema),
                Some(table),
                AssetGroupType::Indexes,
                "Indexes",
            ),
            self.asset_group(
                database,
                Some(schema),
                Some(table),
                AssetGroupType::Triggers,
                "Triggers",
            ),
        ]
    }

    async fn list_table_like(
        &self,
        database: &str,
        schema: &str,
        group_type: &AssetGroupType,
    ) -> IpcResult<Vec<DataContainer>> {
        let pool = self.pool_for_database(database).await?;
        if group_type == &AssetGroupType::MaterializedViews {
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT matviewname \
                 FROM pg_matviews \
                 WHERE schemaname = $1 \
                 ORDER BY matviewname",
            )
            .bind(schema)
            .fetch_all(&pool)
            .await
            .map_err(classify_sqlx_query_error)?;

            return Ok(rows
                .into_iter()
                .map(|(table,)| {
                    let container = ContainerRef::table(
                        ContainerKind::MaterializedView,
                        database.to_string(),
                        Some(schema.to_string()),
                        table.clone(),
                    );
                    DataContainer {
                        id: format!(
                            "{}::{database}::{schema}::matview::{table}",
                            self.profile_id
                        ),
                        name: table,
                        kind: ContainerKind::MaterializedView,
                        is_leaf: false,
                        container,
                        type_name: Some("MATERIALIZED VIEW".to_string()),
                        nullable: None,
                        item_count: None,
                        properties: Vec::new(),
                    }
                })
                .collect());
        }

        let table_type = match group_type {
            AssetGroupType::Tables => "BASE TABLE",
            AssetGroupType::Views => "VIEW",
            _ => return Ok(Vec::new()),
        };
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT table_name, table_type \
             FROM information_schema.tables \
             WHERE table_schema = $1 AND table_type = $2 \
             ORDER BY table_type, table_name",
        )
        .bind(schema)
        .bind(table_type)
        .fetch_all(&pool)
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
                let container = ContainerRef::table(
                    kind.clone(),
                    database.to_string(),
                    Some(schema.to_string()),
                    table.clone(),
                );
                DataContainer {
                    id: format!("{}::{database}::{schema}::{table}", self.profile_id),
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
        schema: &str,
        group_type: &AssetGroupType,
    ) -> IpcResult<Vec<DataContainer>> {
        let (routine_type, kind) = match group_type {
            AssetGroupType::Functions => ("FUNCTION", ContainerKind::Function),
            AssetGroupType::Procedures => ("PROCEDURE", ContainerKind::Procedure),
            _ => return Ok(Vec::new()),
        };
        let pool = self.pool_for_database(database).await?;
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT routine_name \
             FROM information_schema.routines \
             WHERE specific_schema = $1 AND routine_type = $2 \
             ORDER BY routine_name",
        )
        .bind(schema)
        .bind(routine_type)
        .fetch_all(&pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        Ok(rows
            .into_iter()
            .map(|(name,)| DataContainer {
                id: format!(
                    "{}::{database}::{schema}::routine::{routine_type}::{name}",
                    self.profile_id
                ),
                name: name.clone(),
                kind: kind.clone(),
                is_leaf: true,
                container: ContainerRef::named_object(
                    kind.clone(),
                    database.to_string(),
                    Some(schema.to_string()),
                    name,
                ),
                type_name: Some(routine_type.to_string()),
                nullable: None,
                item_count: None,
                properties: Vec::new(),
            })
            .collect())
    }

    async fn list_sequences(&self, database: &str, schema: &str) -> IpcResult<Vec<DataContainer>> {
        let pool = self.pool_for_database(database).await?;
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT sequence_name \
             FROM information_schema.sequences \
             WHERE sequence_schema = $1 \
             ORDER BY sequence_name",
        )
        .bind(schema)
        .fetch_all(&pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        Ok(rows
            .into_iter()
            .map(|(name,)| DataContainer {
                id: format!(
                    "{}::{database}::{schema}::sequence::{name}",
                    self.profile_id
                ),
                name: name.clone(),
                kind: ContainerKind::Sequence,
                is_leaf: true,
                container: ContainerRef::named_object(
                    ContainerKind::Sequence,
                    database.to_string(),
                    Some(schema.to_string()),
                    name,
                ),
                type_name: None,
                nullable: None,
                item_count: None,
                properties: Vec::new(),
            })
            .collect())
    }

    async fn list_extensions(&self, database: &str, schema: &str) -> IpcResult<Vec<DataContainer>> {
        let pool = self.pool_for_database(database).await?;
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT e.extname \
             FROM pg_extension e \
             JOIN pg_namespace n ON n.oid = e.extnamespace \
             WHERE n.nspname = $1 \
             ORDER BY e.extname",
        )
        .bind(schema)
        .fetch_all(&pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        Ok(rows
            .into_iter()
            .map(|(name,)| DataContainer {
                id: format!(
                    "{}::{database}::{schema}::extension::{name}",
                    self.profile_id
                ),
                name: name.clone(),
                kind: ContainerKind::Extension,
                is_leaf: true,
                container: ContainerRef::named_object(
                    ContainerKind::Extension,
                    database.to_string(),
                    Some(schema.to_string()),
                    name,
                ),
                type_name: None,
                nullable: None,
                item_count: None,
                properties: Vec::new(),
            })
            .collect())
    }

    async fn list_indexes(
        &self,
        database: &str,
        schema: &str,
        table: &str,
    ) -> IpcResult<Vec<DataContainer>> {
        let pool = self.pool_for_database(database).await?;
        let rows: Vec<(String, bool)> = sqlx::query_as(
            "SELECT c.relname, i.indisunique \
             FROM pg_index i \
             JOIN pg_class c ON c.oid = i.indexrelid \
             JOIN pg_class t ON t.oid = i.indrelid \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             WHERE n.nspname = $1 AND t.relname = $2 \
             ORDER BY c.relname",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        Ok(rows
            .into_iter()
            .map(|(name, is_unique)| DataContainer {
                id: format!(
                    "{}::{database}::{schema}::{table}::index::{name}",
                    self.profile_id
                ),
                name: name.clone(),
                kind: ContainerKind::Index,
                is_leaf: true,
                container: ContainerRef::named_object(
                    ContainerKind::Index,
                    database.to_string(),
                    Some(schema.to_string()),
                    name,
                ),
                type_name: Some(if is_unique { "UNIQUE" } else { "INDEX" }.to_string()),
                nullable: None,
                item_count: None,
                properties: Vec::new(),
            })
            .collect())
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
        let schema_name = container
            .schema
            .clone()
            .unwrap_or_else(|| self.default_schema());
        let schema = schema_name.as_str();
        let table = container
            .table
            .as_deref()
            .ok_or_else(|| IpcError::resource_not_found("Table name is missing"))?;
        let pool = self.pool_for_database(database).await?;

        let table_info: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT c.relname, obj_description(c.oid, 'pg_class') \
             FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 \
               AND c.relname = $2 \
               AND c.relkind IN ('r', 'p')",
        )
        .bind(schema)
        .bind(table)
        .fetch_optional(&pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        if table_info.is_none() {
            return Err(IpcError::resource_not_found(format!(
                "Table '{database}.{schema}.{table}' was not found"
            )));
        }
        let (_, table_comment) = table_info.expect("checked is_some");

        let column_rows: Vec<PostgresTableDesignColumnRow> = sqlx::query_as(
            "SELECT \
                    a.attname, \
                    pg_catalog.format_type(a.atttypid, a.atttypmod), \
                    NOT a.attnotnull, \
                    pg_get_expr(d.adbin, d.adrelid), \
                    a.attidentity <> '', \
                    col_description(a.attrelid, a.attnum) \
                 FROM pg_attribute a \
                 JOIN pg_class t ON t.oid = a.attrelid \
                 JOIN pg_namespace n ON n.oid = t.relnamespace \
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                 WHERE n.nspname = $1 \
                   AND t.relname = $2 \
                   AND a.attnum > 0 \
                   AND NOT a.attisdropped \
                 ORDER BY a.attnum",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        let primary_key_rows: Vec<(String, i32)> = sqlx::query_as(
            "SELECT a.attname, key_column.ordinality::int \
             FROM pg_index i \
             JOIN pg_class t ON t.oid = i.indrelid \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key_column(attnum, ordinality) ON true \
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key_column.attnum \
             WHERE n.nspname = $1 \
               AND t.relname = $2 \
               AND i.indisprimary \
             ORDER BY key_column.ordinality",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        let primary_key_ordinals: HashMap<String, i32> = primary_key_rows.iter().cloned().collect();

        let unique_rows: Vec<(String,)> = sqlx::query_as(
            "SELECT DISTINCT a.attname \
             FROM pg_index i \
             JOIN pg_class t ON t.oid = i.indrelid \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             JOIN LATERAL unnest(i.indkey) AS key_column(attnum) ON true \
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key_column.attnum \
             WHERE n.nspname = $1 \
               AND t.relname = $2 \
               AND i.indisunique",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        let unique_columns: HashSet<String> =
            unique_rows.into_iter().map(|(column,)| column).collect();

        let columns = column_rows
            .into_iter()
            .map(
                |(name, type_name, nullable, default_value, is_identity, comment)| {
                    TableColumnSchema {
                        is_primary_key: primary_key_ordinals.contains_key(&name),
                        is_unique: unique_columns.contains(&name),
                        name,
                        type_name,
                        nullable,
                        default_value,
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
                        generated: None,
                        charset: None,
                        collation: None,
                        comment: comment.filter(|value| !value.trim().is_empty()),
                    }
                },
            )
            .collect();

        let index_rows: Vec<(String, bool, String, Option<String>)> = sqlx::query_as(
            "SELECT \
                c.relname, \
                i.indisunique, \
                am.amname, \
                string_agg(a.attname, ',' ORDER BY key_column.ordinality) \
             FROM pg_index i \
             JOIN pg_class c ON c.oid = i.indexrelid \
             JOIN pg_am am ON am.oid = c.relam \
             JOIN pg_class t ON t.oid = i.indrelid \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key_column(attnum, ordinality) \
               ON key_column.attnum <> 0 \
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key_column.attnum \
             WHERE n.nspname = $1 \
               AND t.relname = $2 \
               AND NOT i.indisprimary \
             GROUP BY c.relname, i.indisunique, am.amname \
             ORDER BY c.relname",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        let indexes = index_rows
            .into_iter()
            .map(|(name, is_unique, method, columns)| TableIndexSchema {
                name,
                columns: split_schema_columns(columns.as_deref()),
                is_unique,
                method: Some(method),
                comment: None,
            })
            .collect();

        let constraint_rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
            "SELECT \
                con.conname, \
                con.contype::text, \
                string_agg(a.attname, ',' ORDER BY key_column.ordinality) \
             FROM pg_constraint con \
             JOIN pg_class t ON t.oid = con.conrelid \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key_column(attnum, ordinality) ON true \
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key_column.attnum \
             WHERE n.nspname = $1 \
               AND t.relname = $2 \
               AND con.contype IN ('p', 'u') \
             GROUP BY con.conname, con.contype \
             ORDER BY CASE con.contype WHEN 'p' THEN 0 ELSE 1 END, con.conname",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        let constraints = constraint_rows
            .into_iter()
            .map(|(name, kind, columns)| TableConstraintSchema {
                name,
                kind: if kind == "p" {
                    TableConstraintKind::PrimaryKey
                } else {
                    TableConstraintKind::Unique
                },
                columns: split_schema_columns(columns.as_deref()),
                reference: None,
                expression: None,
                comment: None,
                foreign_key: None,
                enforced: None,
            })
            .collect::<Vec<_>>();

        let mut constraints = constraints;

        let foreign_key_rows: Vec<PostgresForeignKeyRow> = sqlx::query_as(
            "SELECT \
                con.conname, \
                string_agg(local_attr.attname, ',' ORDER BY local_key.ordinality), \
                foreign_ns.nspname, \
                foreign_table.relname, \
                string_agg(foreign_attr.attname, ',' ORDER BY foreign_key.ordinality), \
                con.confupdtype::text, \
                con.confdeltype::text \
             FROM pg_constraint con \
             JOIN pg_class local_table ON local_table.oid = con.conrelid \
             JOIN pg_namespace local_ns ON local_ns.oid = local_table.relnamespace \
             JOIN pg_class foreign_table ON foreign_table.oid = con.confrelid \
             JOIN pg_namespace foreign_ns ON foreign_ns.oid = foreign_table.relnamespace \
             JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS local_key(attnum, ordinality) ON true \
             JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS foreign_key(attnum, ordinality) \
               ON foreign_key.ordinality = local_key.ordinality \
             JOIN pg_attribute local_attr ON local_attr.attrelid = local_table.oid AND local_attr.attnum = local_key.attnum \
             JOIN pg_attribute foreign_attr ON foreign_attr.attrelid = foreign_table.oid AND foreign_attr.attnum = foreign_key.attnum \
             WHERE local_ns.nspname = $1 \
               AND local_table.relname = $2 \
               AND con.contype = 'f' \
             GROUP BY con.conname, foreign_ns.nspname, foreign_table.relname, con.confupdtype, con.confdeltype \
             ORDER BY con.conname",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        constraints.extend(foreign_key_rows.into_iter().map(
            |(
                name,
                columns,
                reference_schema,
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
                        database_name: None,
                        schema_name: reference_schema,
                        table_name,
                        columns: split_schema_columns(reference_columns.as_deref()),
                        on_update: postgres_parse_referential_action(update_rule.as_deref()),
                        on_delete: postgres_parse_referential_action(delete_rule.as_deref()),
                    }),
                    enforced: Some(true),
                }
            },
        ));

        let check_rows: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT \
                con.conname, \
                string_agg(a.attname, ',' ORDER BY key_column.ordinality), \
                pg_get_constraintdef(con.oid, true) \
             FROM pg_constraint con \
             JOIN pg_class t ON t.oid = con.conrelid \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             LEFT JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key_column(attnum, ordinality) ON true \
             LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key_column.attnum \
             WHERE n.nspname = $1 \
               AND t.relname = $2 \
               AND con.contype = 'c' \
             GROUP BY con.oid, con.conname \
             ORDER BY con.conname",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        constraints.extend(check_rows.into_iter().map(|(name, columns, expression)| {
            TableConstraintSchema {
                name,
                kind: TableConstraintKind::Check,
                columns: split_schema_columns(columns.as_deref()),
                reference: None,
                expression: expression.and_then(|value| {
                    value
                        .strip_prefix("CHECK (")
                        .and_then(|inner| inner.strip_suffix(')'))
                        .map(ToString::to_string)
                        .or(Some(value))
                }),
                comment: None,
                foreign_key: None,
                enforced: Some(true),
            }
        }));

        Ok(TableSchema {
            basics: TableSchemaBasics {
                table_name: table.to_string(),
                database_name: database.to_string(),
                schema_name: schema.to_string(),
                engine: None,
                charset: None,
                collation: None,
                comment: table_comment.filter(|value| !value.trim().is_empty()),
                partition: None,
            },
            columns,
            indexes,
            constraints,
        })
    }

    async fn list_triggers(
        &self,
        database: &str,
        schema: &str,
        table: &str,
    ) -> IpcResult<Vec<DataContainer>> {
        let pool = self.pool_for_database(database).await?;
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT trigger_name \
             FROM information_schema.triggers \
             WHERE trigger_schema = $1 AND event_object_table = $2 \
             ORDER BY trigger_name",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        Ok(rows
            .into_iter()
            .map(|(name,)| DataContainer {
                id: format!(
                    "{}::{database}::{schema}::{table}::trigger::{name}",
                    self.profile_id
                ),
                name: name.clone(),
                kind: ContainerKind::Trigger,
                is_leaf: true,
                container: ContainerRef::named_object(
                    ContainerKind::Trigger,
                    database.to_string(),
                    Some(schema.to_string()),
                    name,
                ),
                type_name: None,
                nullable: None,
                item_count: None,
                properties: Vec::new(),
            })
            .collect())
    }

    async fn list_asset_group(&self, container: &ContainerRef) -> IpcResult<Vec<DataContainer>> {
        let database = self.container_database(container)?.to_string();
        let schema = container
            .schema
            .clone()
            .unwrap_or_else(|| self.default_schema());
        let group_type = container
            .group_type
            .as_ref()
            .ok_or_else(|| IpcError::resource_not_found("Asset group type is missing"))?;

        match group_type {
            AssetGroupType::Tables | AssetGroupType::Views | AssetGroupType::MaterializedViews => {
                self.list_table_like(&database, &schema, group_type).await
            }
            AssetGroupType::Functions | AssetGroupType::Procedures => {
                self.list_routines(&database, &schema, group_type).await
            }
            AssetGroupType::Sequences => self.list_sequences(&database, &schema).await,
            AssetGroupType::Extensions => self.list_extensions(&database, &schema).await,
            AssetGroupType::Columns => {
                let table = container
                    .table
                    .as_deref()
                    .ok_or_else(|| IpcError::resource_not_found("Table name is missing"))?;
                self.list_columns_for_table(&database, &schema, table, false)
                    .await
            }
            AssetGroupType::Indexes => {
                let table = container
                    .table
                    .as_deref()
                    .ok_or_else(|| IpcError::resource_not_found("Table name is missing"))?;
                self.list_indexes(&database, &schema, table).await
            }
            AssetGroupType::Triggers => {
                let table = container
                    .table
                    .as_deref()
                    .ok_or_else(|| IpcError::resource_not_found("Table name is missing"))?;
                self.list_triggers(&database, &schema, table).await
            }
            _ => Ok(Vec::new()),
        }
    }

    async fn load_table_columns_meta(
        &self,
        database: &str,
        schema: &str,
        table: &str,
        is_view: bool,
    ) -> IpcResult<Vec<ColumnMeta>> {
        let pool = self.pool_for_database(database).await?;
        let column_rows: Vec<PostgresColumnMetaRow> = sqlx::query_as(
            "SELECT \
                    column_name, \
                    CASE \
                        WHEN data_type = 'USER-DEFINED' THEN udt_name \
                        ELSE data_type \
                    END AS type_name, \
                    data_type, \
                    udt_schema, \
                    udt_name, \
                    is_nullable, \
                    column_default, \
                    is_generated, \
                    is_identity, \
                    character_maximum_length, \
                    numeric_precision, \
                    numeric_scale \
             FROM information_schema.columns \
             WHERE table_schema = $1 AND table_name = $2 \
             ORDER BY ordinal_position",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        let columns: Vec<PostgresColumnInfo> = column_rows
            .into_iter()
            .map(
                |(
                    name,
                    type_name,
                    data_type,
                    udt_schema,
                    udt_name,
                    nullable,
                    default_value,
                    is_generated,
                    is_identity,
                    max_length,
                    numeric_precision,
                    numeric_scale,
                )| {
                    PostgresColumnInfo {
                        name,
                        type_name,
                        data_type,
                        udt_schema,
                        udt_name,
                        nullable: nullable.eq_ignore_ascii_case("YES"),
                        default_value,
                        is_generated,
                        is_identity,
                        max_length: max_length.map(i64::from),
                        numeric_precision,
                        numeric_scale,
                    }
                },
            )
            .collect();

        let enum_rows: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT n.nspname, t.typname, e.enumlabel \
             FROM pg_type t \
             JOIN pg_namespace n ON n.oid = t.typnamespace \
             JOIN pg_enum e ON e.enumtypid = t.oid \
             ORDER BY n.nspname, t.typname, e.enumsortorder",
        )
        .fetch_all(&pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        let enum_values_by_type = enum_rows.into_iter().fold(
            HashMap::<(String, String), Vec<String>>::new(),
            |mut map, (schema, type_name, value)| {
                map.entry((schema, type_name)).or_default().push(value);
                map
            },
        );

        let primary_key_rows: Vec<(String, i32)> = sqlx::query_as(
            "SELECT a.attname, key_column.ordinality::int \
             FROM pg_index i \
             JOIN pg_class t ON t.oid = i.indrelid \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key_column(attnum, ordinality) ON true \
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key_column.attnum \
             WHERE n.nspname = $1 \
               AND t.relname = $2 \
               AND i.indisprimary \
             ORDER BY key_column.ordinality",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        let primary_key_ordinals: HashMap<String, i32> = primary_key_rows.into_iter().collect();

        let unique_rows: Vec<(String,)> = sqlx::query_as(
            "SELECT DISTINCT a.attname \
             FROM pg_index i \
             JOIN pg_class t ON t.oid = i.indrelid \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             JOIN LATERAL unnest(i.indkey) AS key_column(attnum) ON true \
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key_column.attnum \
             WHERE n.nspname = $1 \
               AND t.relname = $2 \
               AND i.indisunique",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        let unique_columns: HashSet<String> =
            unique_rows.into_iter().map(|(column,)| column).collect();

        Ok(columns
            .into_iter()
            .map(|column| {
                let is_generated = column.is_generated.eq_ignore_ascii_case("ALWAYS");
                let is_identity = column.is_identity.eq_ignore_ascii_case("YES");
                let enum_values = enum_values_by_type
                    .get(&(column.udt_schema.clone(), column.udt_name.clone()))
                    .cloned();

                ColumnMeta {
                    name: column.name.clone(),
                    type_name: column.type_name.clone(),
                    nullable: column.nullable,
                    default_value: column.default_value,
                    data_category: Self::classify_column_data_category(
                        &column.data_type,
                        &column.type_name,
                        enum_values.as_ref(),
                    ),
                    max_length: column.max_length,
                    numeric_precision: column.numeric_precision,
                    numeric_scale: column.numeric_scale,
                    enum_values,
                    is_primary_key: primary_key_ordinals.contains_key(&column.name),
                    primary_key_ordinal: primary_key_ordinals.get(&column.name).copied(),
                    is_unique: unique_columns.contains(&column.name),
                    is_writable: !is_view && !is_generated && !is_identity,
                }
            })
            .collect())
    }

    async fn list_columns_for_table(
        &self,
        database: &str,
        schema: &str,
        table: &str,
        is_view: bool,
    ) -> IpcResult<Vec<DataContainer>> {
        let columns = self
            .load_table_columns_meta(database, schema, table, is_view)
            .await?;

        Ok(columns
            .into_iter()
            .map(|column| {
                let container = ContainerRef::column(
                    database.to_string(),
                    Some(schema.to_string()),
                    table.to_string(),
                    column.name.clone(),
                );
                DataContainer {
                    id: format!(
                        "{}::{database}::{schema}::{table}::column::{}",
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

    fn container_database<'a>(&'a self, container: &'a ContainerRef) -> IpcResult<&'a str> {
        container
            .database
            .as_deref()
            .or_else(|| self.configured_database())
            .ok_or_else(|| IpcError::resource_not_found("Database name is missing"))
    }

    fn table_identifier(&self, container: &ContainerRef) -> IpcResult<String> {
        ensure_postgres_table_data_container(&container.kind)?;
        let schema = container
            .schema
            .clone()
            .unwrap_or_else(|| self.default_schema());
        let table = container
            .table
            .as_deref()
            .ok_or_else(|| IpcError::resource_not_found("Table name is missing"))?;
        Ok(format!(
            "{}.{}",
            quote_pg_identifier(&schema),
            quote_pg_identifier(table)
        ))
    }

    fn table_parts(&self, container: &ContainerRef) -> IpcResult<(String, String, String)> {
        ensure_postgres_table_data_container(&container.kind)?;
        let database = self.container_database(container)?.to_string();
        let schema = container
            .schema
            .clone()
            .unwrap_or_else(|| self.default_schema());
        let table = container
            .table
            .clone()
            .ok_or_else(|| IpcError::resource_not_found("Table name is missing"))?;
        Ok((database, schema, table))
    }

    fn classify_column_data_category(
        data_type: &str,
        type_name: &str,
        enum_values: Option<&Vec<String>>,
    ) -> ColumnDataCategory {
        let data_type = data_type.to_ascii_lowercase();
        let type_name = type_name.to_ascii_lowercase();

        if enum_values.is_some() {
            return ColumnDataCategory::Enum;
        }
        if matches!(data_type.as_str(), "json" | "jsonb")
            || matches!(type_name.as_str(), "json" | "jsonb")
        {
            return ColumnDataCategory::Json;
        }
        if data_type == "uuid" || type_name == "uuid" {
            return ColumnDataCategory::Uuid;
        }
        if data_type == "boolean" || type_name == "bool" {
            return ColumnDataCategory::Boolean;
        }
        if data_type == "date" {
            return ColumnDataCategory::Date;
        }
        if data_type.starts_with("time ") || data_type == "time" {
            return ColumnDataCategory::Time;
        }
        if data_type.starts_with("timestamp ") || data_type == "timestamp" {
            return ColumnDataCategory::Datetime;
        }
        if matches!(
            data_type.as_str(),
            "smallint"
                | "integer"
                | "bigint"
                | "decimal"
                | "numeric"
                | "real"
                | "double precision"
                | "serial"
                | "bigserial"
                | "smallserial"
        ) || matches!(
            type_name.as_str(),
            "int2" | "int4" | "int8" | "float4" | "float8" | "numeric"
        ) {
            return ColumnDataCategory::Number;
        }
        if data_type == "bytea" {
            return ColumnDataCategory::Binary;
        }
        if data_type == "text"
            || data_type.starts_with("character")
            || matches!(type_name.as_str(), "text" | "varchar" | "bpchar" | "citext")
        {
            return ColumnDataCategory::String;
        }

        ColumnDataCategory::Unknown
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
        session: Option<&PostgresTransactionSession>,
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

fn postgres_capabilities() -> DriverCapabilities {
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
impl DatabaseDriver for PostgresDriver {
    fn profile_id(&self) -> &str {
        &self.profile_id
    }

    fn driver_name(&self) -> &'static str {
        "postgres"
    }

    fn capabilities(&self) -> DriverCapabilities {
        postgres_capabilities()
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
        let version = sqlx::query_scalar::<_, String>("SHOW server_version")
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
        let pools: Vec<PgPool> = self
            .db_pools
            .lock()
            .map(|guard| guard.values().cloned().collect())
            .map_err(|_| postgres_lock_error("close"))?;
        for pool in pools {
            pool.close().await;
        }
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
impl SchemaMutator for PostgresDriver {
    async fn preview_create_database(
        &self,
        input: &CreateDatabaseInput,
    ) -> IpcResult<SchemaMutationPreview> {
        Ok(SchemaMutationPreview::from_statements(vec![
            Self::create_database_sql(&input.name)?,
        ]))
    }

    async fn create_database(
        &self,
        input: &CreateDatabaseInput,
    ) -> IpcResult<CreateDatabaseResult> {
        let name = normalized_non_empty_identifier(&input.name, "数据库名称")?;
        let sql = Self::create_database_sql(&name)?;
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
        let (_, _, statements) = Self::update_database_sql(input)?;
        Ok(SchemaMutationPreview::from_statements(statements))
    }

    async fn update_database(
        &self,
        input: &UpdateDatabaseInput,
    ) -> IpcResult<UpdateDatabaseResult> {
        let (old_name, name, statements) = Self::update_database_sql(input)?;
        for statement in statements {
            self.pool
                .execute(statement.as_str())
                .await
                .map_err(classify_sqlx_query_error)?;
        }
        Ok(UpdateDatabaseResult { old_name, name })
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

    async fn preview_create_table(
        &self,
        input: &CreateTableInput,
    ) -> IpcResult<SchemaMutationPreview> {
        Ok(SchemaMutationPreview::from_statements(
            Self::create_table_statements(
                input,
                self.connection_database(),
                &self.default_schema(),
            )?,
        ))
    }

    async fn create_table(&self, input: &CreateTableInput) -> IpcResult<CreateTableResult> {
        let statements = Self::create_table_statements(
            input,
            self.connection_database(),
            &self.default_schema(),
        )?;
        let (database, schema, table_name) =
            Self::create_table_parts(input, self.connection_database(), &self.default_schema())?;
        let pool = self.pool_for_database(&database).await?;

        for statement in statements {
            pool.execute(statement.as_str())
                .await
                .map_err(classify_sqlx_query_error)?;
        }

        Ok(CreateTableResult {
            container: ContainerRef::table(
                ContainerKind::Table,
                database,
                Some(schema),
                table_name.clone(),
            ),
            table_name,
        })
    }

    async fn preview_update_table(
        &self,
        input: &UpdateTableInput,
    ) -> IpcResult<SchemaMutationPreview> {
        let (_, _, _, statements) = Self::update_table_statements(
            input,
            self.connection_database(),
            &self.default_schema(),
        )?;
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

        let (database, schema, table_name, statements) = Self::update_table_statements(
            input,
            self.connection_database(),
            &self.default_schema(),
        )?;
        Self::ensure_destructive_table_update_confirmed(input, &statements)?;
        let pool = self.pool_for_database(&database).await?;

        for statement in statements {
            pool.execute(statement.as_str())
                .await
                .map_err(classify_sqlx_query_error)?;
        }

        Ok(UpdateTableResult {
            container: ContainerRef::table(
                ContainerKind::Table,
                database,
                Some(schema),
                table_name.clone(),
            ),
            table_name,
        })
    }

    async fn preview_drop_table(&self, input: &DropTableInput) -> IpcResult<SchemaMutationPreview> {
        let (_, _, _, sql) =
            Self::drop_table_sql(input, self.connection_database(), &self.default_schema())?;
        let mut preview = SchemaMutationPreview::from_statements(vec![sql]);
        Self::mark_drop_table_preview(&mut preview);
        Ok(preview)
    }

    async fn drop_table(&self, input: &DropTableInput) -> IpcResult<DropTableResult> {
        Self::ensure_destructive_drop_table_confirmed(input)?;
        let (database, schema, table_name, sql) =
            Self::drop_table_sql(input, self.connection_database(), &self.default_schema())?;
        let pool = self.pool_for_database(&database).await?;

        pool.execute(sql.as_str())
            .await
            .map_err(classify_sqlx_query_error)?;

        Ok(DropTableResult {
            container: ContainerRef::table(
                ContainerKind::Table,
                database,
                Some(schema),
                table_name.clone(),
            ),
            table_name,
        })
    }
}

#[async_trait]
impl SchemaBrowser for PostgresDriver {
    async fn list_containers(
        &self,
        parent: Option<&ContainerRef>,
    ) -> IpcResult<Vec<DataContainer>> {
        match parent.map(|container| &container.kind) {
            None => {
                if let Some(database) = self.configured_database() {
                    Ok(vec![DataContainer {
                        id: format!("{}::database::{database}", self.profile_id),
                        name: database.to_string(),
                        kind: ContainerKind::Database,
                        is_leaf: false,
                        container: ContainerRef::database(database.to_string()),
                        type_name: None,
                        nullable: None,
                        item_count: None,
                        properties: Vec::new(),
                    }])
                } else {
                    self.list_databases().await
                }
            }
            Some(ContainerKind::Database) => {
                let database = parent
                    .and_then(|container| container.database.as_deref())
                    .ok_or_else(|| IpcError::resource_not_found("Database name is missing"))?;
                self.list_schemas(database).await
            }
            Some(ContainerKind::Schema) => {
                let container = parent.expect("checked parent");
                let database = self.container_database(container)?;
                let schema = container.schema.as_deref().unwrap_or("public");
                Ok(self.schema_asset_groups(database, schema))
            }
            Some(ContainerKind::AssetGroup) => {
                self.list_asset_group(parent.expect("checked parent")).await
            }
            Some(ContainerKind::Table)
            | Some(ContainerKind::View)
            | Some(ContainerKind::MaterializedView) => {
                let container = parent.expect("checked parent");
                let database = self.container_database(container)?;
                let schema = container
                    .schema
                    .clone()
                    .unwrap_or_else(|| self.default_schema());
                let table = container
                    .table
                    .as_deref()
                    .ok_or_else(|| IpcError::resource_not_found("Table name is missing"))?;
                Ok(self.table_asset_groups(database, &schema, table))
            }
            _ => Ok(Vec::new()),
        }
    }

    async fn describe_table(&self, container: &ContainerRef) -> IpcResult<TableSchema> {
        self.describe_table_schema(container).await
    }
}

#[async_trait]
impl DataTableBrowser for PostgresDriver {
    async fn browse_table_data(
        &self,
        container: &ContainerRef,
        page: u32,
        page_size: u32,
        query: &TableBrowseQuery,
    ) -> IpcResult<QueryResult> {
        let offset = page.saturating_sub(1) as i64 * page_size as i64;
        let limit = page_size as i64 + 1;
        let (database, schema, table_name) = self.table_parts(container)?;
        let pool = self.pool_for_database(&database).await?;
        let is_view = container.kind == ContainerKind::View
            || container.kind == ContainerKind::MaterializedView;
        let columns = self
            .load_table_columns_meta(&database, &schema, &table_name, is_view)
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
            quote_pg_identifier,
            TableBrowsePlaceholderStyle::DollarNumbered,
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
            .map(pg_table_select_expression)
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
                    .map(|column| quote_pg_identifier(column))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        let sql = format!(
            "SELECT {select_columns} FROM {table}{}{order_by} LIMIT {limit} OFFSET {offset}",
            query_plan.where_clause
        );
        let mut transaction = self.transaction.lock().await;
        let rows: Vec<PgRow> = if let Some(session) = transaction.as_mut() {
            Self::ensure_transaction_database(&session.database, &database)?;
            bind_postgres_table_query(&sql, &query_plan.bindings)
                .fetch_all(&mut *session.connection)
                .await
                .map_err(classify_sqlx_query_error)?
        } else {
            drop(transaction);
            bind_postgres_table_query(&sql, &query_plan.bindings)
                .fetch_all(&pool)
                .await
                .map_err(classify_sqlx_query_error)?
        };
        pg_table_rows_to_result(
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
        let (database, schema, table_name) = self.table_parts(container)?;
        let pool = self.pool_for_database(&database).await?;
        let is_view = container.kind == ContainerKind::View
            || container.kind == ContainerKind::MaterializedView;
        let columns = self
            .load_table_columns_meta(&database, &schema, &table_name, is_view)
            .await?;
        let query_plan = table_browse_sql_plan(
            query,
            &columns,
            quote_pg_identifier,
            TableBrowsePlaceholderStyle::DollarNumbered,
        )?;
        let table = self.table_identifier(container)?;
        let sql = pg_table_page_stats_sql(&table, &query_plan.where_clause);
        let mut transaction = self.transaction.lock().await;
        let total_rows: i64 = if let Some(session) = transaction.as_mut() {
            Self::ensure_transaction_database(&session.database, &database)?;
            bind_postgres_table_query(&sql, &query_plan.bindings)
                .fetch_one(&mut *session.connection)
                .await
                .map_err(classify_sqlx_query_error)?
                .try_get(0)
                .map_err(classify_sqlx_query_error)?
        } else {
            drop(transaction);
            bind_postgres_table_query(&sql, &query_plan.bindings)
                .fetch_one(&pool)
                .await
                .map_err(classify_sqlx_query_error)?
                .try_get(0)
                .map_err(classify_sqlx_query_error)?
        };
        let total_rows = u64::try_from(total_rows)
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
        let (database, schema, table_name) = self.table_parts(container)?;
        let columns = self
            .load_table_columns_meta(&database, &schema, &table_name, false)
            .await?;
        let table = self.table_identifier(container)?;
        build_table_change_set_preview(
            &columns,
            &table,
            quote_pg_identifier,
            postgres_empty_insert_statement,
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
        let (database, _, _) = self.table_parts(container)?;
        let mut affected_rows = 0;
        let mut transaction = self.transaction.lock().await;
        let pool = if transaction.is_none() {
            Some(self.pool_for_database(&database).await?)
        } else {
            None
        };

        for (index, statement) in preview.statements.iter().enumerate() {
            let result = if let Some(session) = transaction.as_mut() {
                Self::ensure_transaction_database(&session.database, &database)?;
                (&mut *session.connection)
                    .execute(statement.as_str())
                    .await
                    .map_err(classify_sqlx_query_error)?
            } else {
                pool.as_ref()
                    .expect("pool exists outside transaction")
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
impl TransactionManager for PostgresDriver {
    async fn begin_transaction(
        &self,
        container: &ContainerRef,
    ) -> IpcResult<TableTransactionState> {
        let (database, _, _) = self.table_parts(container)?;
        let pool = self.pool_for_database(&database).await?;
        let mut transaction = self.transaction.lock().await;
        if transaction.is_some() {
            return Err(IpcError::system_internal(
                "当前标签页已有活动事务",
                "transaction already active for this tab runtime",
            ));
        }

        let mut connection = pool.acquire().await.map_err(|error| {
            IpcError::system_internal("开启事务失败：无法获取数据库连接", error.to_string())
        })?;
        (&mut *connection).execute("BEGIN").await.map_err(|error| {
            IpcError::system_internal("开启事务失败：数据库拒绝启动事务", error.to_string())
        })?;
        *transaction = Some(PostgresTransactionSession {
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
impl SqlExecutor for PostgresDriver {
    async fn execute_sql(
        &self,
        context: &SqlExecutionContext,
        sql: &str,
        page: u32,
        page_size: u32,
    ) -> IpcResult<QueryResult> {
        Self::ensure_single_sql_statement_for_editor(sql)?;
        let parts = Self::sql_execution_parts(&self.profile, context)?;
        let pool = self.pool_for_database(&parts.database).await?;
        let offset = page.saturating_sub(1) as i64 * page_size as i64;
        let mut connection = pool.acquire().await.map_err(|error| {
            IpcError::system_internal(
                "SQL execution failed: cannot acquire connection",
                error.to_string(),
            )
        })?;
        // SQL editor executions can mutate session state; close this checked-out
        // connection instead of returning it to the pool.
        connection.close_on_drop();
        (&mut *connection)
            .execute(Self::postgres_set_search_path_sql(&parts.schema).as_str())
            .await
            .map_err(classify_sqlx_query_error)?;

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
        let mut rows: Vec<PgRow> = Vec::new();
        let mut columns: Option<Vec<ColumnMeta>> = None;
        let mut skipped = 0_i64;
        let mut affected_rows = 0_u64;
        let mut has_next_page = false;

        while let Some(step) = stream.try_next().await.map_err(classify_sqlx_query_error)? {
            match step {
                sqlx::Either::Left(result) => {
                    affected_rows = affected_rows.saturating_add(rows_affected(&result));
                }
                sqlx::Either::Right(row) => {
                    if let Some(ref cols) = columns {
                        ensure_pg_row_shape(&row, cols)?;
                    } else {
                        columns = Some(pg_columns_from_row(&row));
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
                    .map(pg_columns_from_describe)
                    .unwrap_or_default()
            }),
            rows: pg_result_rows(&rows),
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
        TableGeneratedColumn, TableGeneratedColumnStorage, TableIdentityGeneration,
        TableIdentityOptions, TablePartitionOptions, TableReferentialAction,
    };

    #[test]
    fn postgres_schema_capabilities_cover_database_and_table_mutation() {
        let capabilities = postgres_capabilities();
        let schema_mutation = capabilities
            .schema_mutation
            .as_ref()
            .expect("PostgreSQL schema mutation features should be declared");

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

    fn profile(default_database: Option<String>) -> PostgresProfile {
        PostgresProfile {
            host: "localhost".to_string(),
            port: 5432,
            username: "postgres".to_string(),
            password: String::new(),
            default_database,
            schema: None,
            ssl_mode: None,
            connect_timeout_seconds: None,
            ssh_tunnel: None,
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
    fn maps_postgres_ssl_modes() {
        assert!(matches!(
            PostgresDriver::pg_ssl_mode(None).unwrap(),
            sqlx::postgres::PgSslMode::Disable
        ));
        assert!(matches!(
            PostgresDriver::pg_ssl_mode(Some("require")).unwrap(),
            sqlx::postgres::PgSslMode::Require
        ));
        assert!(matches!(
            PostgresDriver::pg_ssl_mode(Some("verify-ca")).unwrap(),
            sqlx::postgres::PgSslMode::VerifyCa
        ));
        assert!(matches!(
            PostgresDriver::pg_ssl_mode(Some("verify-full")).unwrap(),
            sqlx::postgres::PgSslMode::VerifyFull
        ));
        assert!(PostgresDriver::pg_ssl_mode(Some("preferred")).is_err());
    }

    #[test]
    fn builds_postgres_connect_options_for_resolved_endpoint() {
        let mut profile = profile(Some("app".to_string()));
        profile.ssl_mode = Some("verify-ca".to_string());
        profile.connect_timeout_seconds = Some(12);

        let options = PostgresDriver::connect_options(&profile, "127.0.0.1", 49152, "app")
            .expect("connect options");

        assert_eq!(options.get_host(), "127.0.0.1");
        assert_eq!(options.get_port(), 49152);
        assert_eq!(options.get_username(), "postgres");
        assert_eq!(options.get_database(), Some("app"));
        assert!(matches!(options.get_ssl_mode(), PgSslMode::VerifyCa));
        assert_eq!(
            PostgresDriver::connect_timeout(&profile),
            Duration::from_secs(12)
        );
        assert_eq!(
            PostgresDriver::pool_options(&profile).get_acquire_timeout(),
            Duration::from_secs(12)
        );
    }

    #[test]
    fn rejects_postgres_verify_full_with_ssh_tunnel() {
        let mut profile = profile(Some("app".to_string()));
        profile.ssl_mode = Some("verify-full".to_string());
        profile.ssh_tunnel = Some(enabled_ssh_tunnel());

        assert!(PostgresDriver::validate_runtime_profile(&profile).is_err());
    }

    #[test]
    fn resolves_postgres_sql_execution_context() {
        let profile = profile(Some("default_db".to_string()));
        let context = SqlExecutionContext {
            database: Some("selected_db".to_string()),
            schema: Some("analytics".to_string()),
        };

        let resolved = PostgresDriver::sql_execution_parts(&profile, &context).unwrap();
        assert_eq!(resolved.database, "selected_db");
        assert_eq!(resolved.schema, "analytics");

        let empty_context = SqlExecutionContext::default();
        let resolved = PostgresDriver::sql_execution_parts(&profile, &empty_context).unwrap();
        assert_eq!(resolved.database, "default_db");
        assert_eq!(resolved.schema, "public");
    }

    #[test]
    fn builds_postgres_sql_execution_context_search_path_sql() {
        assert_eq!(
            PostgresDriver::postgres_set_search_path_sql("odd\"schema"),
            "SET search_path TO \"odd\"\"schema\""
        );
    }

    #[test]
    fn rejects_postgres_multi_statement_sql_execution_context() {
        assert!(PostgresDriver::ensure_single_sql_statement_for_editor("   ").is_err());
        assert!(
            PostgresDriver::ensure_single_sql_statement_for_editor("SELECT 1; SELECT 2").is_err()
        );
        assert!(PostgresDriver::ensure_single_sql_statement_for_editor("SELECT ';'").is_ok());
    }

    #[test]
    fn rejects_postgres_sql_execution_context_system_schema_without_table_message() {
        let profile = profile(Some("default_db".to_string()));
        let context = SqlExecutionContext {
            database: None,
            schema: Some("pg_catalog".to_string()),
        };

        let error = match PostgresDriver::sql_execution_parts(&profile, &context) {
            Ok(_) => panic!("system schema should be rejected for SQL execution"),
            Err(error) => error,
        };

        assert!(error.message.contains("SQL"));
        assert!(!error.message.contains("创建表"));
    }

    #[test]
    fn asset_group_is_not_a_table_data_container() {
        assert!(ensure_postgres_table_data_container(&ContainerKind::AssetGroup).is_err());
    }

    #[test]
    fn builds_postgres_create_database_sql() {
        assert_eq!(
            PostgresDriver::create_database_sql("app").unwrap(),
            "CREATE DATABASE \"app\""
        );
        assert_eq!(
            PostgresDriver::create_database_sql("odd\"name").unwrap(),
            "CREATE DATABASE \"odd\"\"name\""
        );
        assert!(PostgresDriver::create_database_sql("  ").is_err());
    }

    #[test]
    fn builds_postgres_update_database_sql() {
        let input = UpdateDatabaseInput {
            container: ContainerRef::database("app"),
            name: Some("app2".to_string()),
            comment: Some("O'Reilly app".to_string()),
            tablespace: Some("fast_space".to_string()),
            character_set: None,
        };
        let (_old_name, _name, statements) = PostgresDriver::update_database_sql(&input).unwrap();

        assert_eq!(
            statements,
            vec![
                "ALTER DATABASE \"app\" RENAME TO \"app2\"",
                "COMMENT ON DATABASE \"app2\" IS 'O''Reilly app'",
                "ALTER DATABASE \"app2\" SET TABLESPACE \"fast_space\"",
            ]
        );
    }

    #[test]
    fn builds_postgres_drop_database_sql() {
        assert_eq!(
            PostgresDriver::drop_database_sql("app").unwrap(),
            "DROP DATABASE \"app\""
        );
    }

    #[test]
    fn builds_postgres_create_table_statements() {
        let input = CreateTableInput {
            basics: TableSchemaBasics {
                table_name: "users".to_string(),
                database_name: "app".to_string(),
                schema_name: "public".to_string(),
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
                    default_value: Some("'anonymous'".to_string()),
                    is_primary_key: false,
                    is_unique: false,
                    is_identity: false,
                    identity: None,
                    generated: None,
                    charset: None,
                    collation: None,
                    comment: Some("Display name".to_string()),
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
                method: Some("btree".to_string()),
                comment: None,
            }],
            constraints: Vec::new(),
        };

        assert_eq!(
            PostgresDriver::create_table_statements(&input, "app", "public").unwrap(),
            vec![
                "CREATE TABLE \"public\".\"users\" (\n  \"id\" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,\n  \"name\" varchar(255) DEFAULT 'anonymous' NOT NULL,\n  \"email\" varchar(255),\n  PRIMARY KEY (\"id\"),\n  UNIQUE (\"email\")\n)".to_string(),
                "COMMENT ON TABLE \"public\".\"users\" IS 'User table'".to_string(),
                "COMMENT ON COLUMN \"public\".\"users\".\"name\" IS 'Display name'".to_string(),
                "CREATE INDEX \"idx_users_name\" ON \"public\".\"users\" USING btree (\"name\")".to_string(),
            ]
        );
    }

    #[test]
    fn builds_postgres_create_table_with_foreign_key_and_check() {
        let mut input = minimal_create_table_input();
        input.columns.push(TableColumnSchema {
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
        input.constraints.push(TableConstraintSchema {
            name: "fk_users_org".to_string(),
            kind: TableConstraintKind::ForeignKey,
            columns: vec!["org_id".to_string()],
            reference: None,
            expression: None,
            comment: None,
            foreign_key: Some(TableForeignKeyReference {
                database_name: None,
                schema_name: Some("public".to_string()),
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
            expression: Some("\"org_id\" > 0".to_string()),
            comment: None,
            foreign_key: None,
            enforced: Some(true),
        });

        let statements = PostgresDriver::create_table_statements(&input, "app", "public").unwrap();

        assert!(statements[0].contains(
            "CONSTRAINT \"fk_users_org\" FOREIGN KEY (\"org_id\") REFERENCES \"public\".\"orgs\" (\"id\") ON UPDATE CASCADE ON DELETE RESTRICT"
        ));
        assert!(statements[0].contains("CONSTRAINT \"ck_users_org_id\" CHECK (\"org_id\" > 0)"));
    }

    #[test]
    fn builds_postgres_create_table_with_generated_column_identity_and_partition() {
        let mut input = minimal_create_table_input();
        input.columns[0].identity = Some(TableIdentityOptions {
            generation: TableIdentityGeneration::Always,
            start: None,
            increment: None,
            min_value: None,
            max_value: None,
            cache: None,
            cycle: false,
        });
        input.columns.push(TableColumnSchema {
            name: "full_name".to_string(),
            type_name: "text".to_string(),
            nullable: true,
            default_value: None,
            is_primary_key: false,
            is_unique: false,
            is_identity: false,
            identity: None,
            generated: Some(TableGeneratedColumn {
                expression: "first_name || ' ' || last_name".to_string(),
                storage: TableGeneratedColumnStorage::Stored,
            }),
            charset: None,
            collation: Some("\"en_US\"".to_string()),
            comment: None,
        });
        input.basics.partition = Some(TablePartitionOptions {
            expression: Some("RANGE (id)".to_string()),
            raw_clause: Some("PARTITION BY RANGE (\"id\")".to_string()),
            readonly_description: None,
        });

        let statements = PostgresDriver::create_table_statements(&input, "app", "public").unwrap();

        assert!(statements[0].contains("\"id\" bigint GENERATED ALWAYS AS IDENTITY NOT NULL"));
        assert!(statements[0].contains(
            "\"full_name\" text COLLATE \"en_US\" GENERATED ALWAYS AS (first_name || ' ' || last_name) STORED"
        ));
        assert!(statements[0].ends_with("PARTITION BY RANGE (\"id\")"));
    }

    #[test]
    fn builds_postgres_drop_table_sql() {
        let input = DropTableInput {
            container: ContainerRef::table(
                ContainerKind::Table,
                "app".to_string(),
                Some("public".to_string()),
                "users".to_string(),
            ),
            confirm_destructive: false,
        };

        let (_, schema, table, sql) =
            PostgresDriver::drop_table_sql(&input, "app", "public").unwrap();

        assert_eq!(schema, "public");
        assert_eq!(table, "users");
        assert_eq!(sql, "DROP TABLE \"public\".\"users\"");
    }

    #[test]
    fn rejects_postgres_drop_table_in_internal_schema() {
        for schema in [
            "information_schema",
            "pg_catalog",
            "pg_toast",
            "pg_temp_3",
            "pg_toast_temp_3",
        ] {
            let input = DropTableInput {
                container: ContainerRef::table(
                    ContainerKind::Table,
                    "app".to_string(),
                    Some(schema.to_string()),
                    "users".to_string(),
                ),
                confirm_destructive: true,
            };

            let error = PostgresDriver::drop_table_sql(&input, "app", "public")
                .expect_err("internal schema should be rejected");

            assert_eq!(format!("{:?}", error.code), "ValidationFailed");
        }
    }

    #[test]
    fn postgres_drop_table_requires_destructive_confirmation() {
        let input = DropTableInput {
            container: ContainerRef::table(
                ContainerKind::Table,
                "app".to_string(),
                Some("public".to_string()),
                "users".to_string(),
            ),
            confirm_destructive: false,
        };

        let error = PostgresDriver::ensure_destructive_drop_table_confirmed(&input).unwrap_err();

        assert_eq!(format!("{:?}", error.code), "ValidationFailed");
    }

    #[test]
    fn builds_postgres_update_table_statements() {
        let mut input = update_table_input();
        input.target.basics.comment = Some("Updated table".to_string());
        input.target.columns[1].comment = Some("Visible name".to_string());
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
            comment: Some("Contact email".to_string()),
        });
        input.target.indexes.clear();
        input.target.indexes.push(TableIndexSchema {
            name: "idx_users_email".to_string(),
            columns: vec!["email".to_string()],
            is_unique: false,
            method: Some("btree".to_string()),
            comment: None,
        });

        let (_, _, _, statements) =
            PostgresDriver::update_table_statements(&input, "app", "public").unwrap();

        assert_eq!(
            statements,
            vec![
                "COMMENT ON TABLE \"public\".\"users\" IS 'Updated table'".to_string(),
                "ALTER TABLE \"public\".\"users\" ADD COLUMN \"email\" varchar(255)".to_string(),
                "COMMENT ON COLUMN \"public\".\"users\".\"email\" IS 'Contact email'".to_string(),
                "COMMENT ON COLUMN \"public\".\"users\".\"name\" IS 'Visible name'".to_string(),
                "DROP INDEX \"public\".\"idx_users_name\"".to_string(),
                "CREATE INDEX \"idx_users_email\" ON \"public\".\"users\" USING btree (\"email\")"
                    .to_string(),
            ]
        );
    }

    #[test]
    fn builds_postgres_update_table_constraints() {
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
                schema_name: Some("public".to_string()),
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
            expression: Some("\"org_id\" > 0".to_string()),
            comment: None,
            foreign_key: None,
            enforced: Some(true),
        });

        let (_, _, _, statements) =
            PostgresDriver::update_table_statements(&input, "app", "public").unwrap();

        assert!(statements.contains(&"ALTER TABLE \"public\".\"users\" ADD CONSTRAINT \"fk_users_org\" FOREIGN KEY (\"org_id\") REFERENCES \"public\".\"orgs\" (\"id\") ON UPDATE CASCADE ON DELETE RESTRICT".to_string()));
        assert!(statements.contains(
            &"ALTER TABLE \"public\".\"users\" ADD CONSTRAINT \"ck_users_org_id\" CHECK (\"org_id\" > 0)".to_string()
        ));
    }

    #[test]
    fn builds_postgres_update_identity() {
        let mut input = update_table_input();
        input.baseline.columns[0].is_identity = false;
        input.target.columns[0].is_identity = true;
        input.target.columns[0].identity = Some(TableIdentityOptions {
            generation: TableIdentityGeneration::Always,
            start: None,
            increment: None,
            min_value: None,
            max_value: None,
            cache: None,
            cycle: false,
        });

        let (_, _, _, statements) =
            PostgresDriver::update_table_statements(&input, "app", "public").unwrap();

        assert_eq!(
            statements,
            vec![
                "ALTER TABLE \"public\".\"users\" ALTER COLUMN \"id\" ADD GENERATED ALWAYS AS IDENTITY".to_string()
            ]
        );
    }

    #[test]
    fn builds_postgres_drop_column_update_table_sql() {
        let mut input = update_table_input();
        input.target.indexes.clear();
        input.target.columns.retain(|column| column.name != "name");

        let (_, _, _, statements) =
            PostgresDriver::update_table_statements(&input, "app", "public").unwrap();

        assert_eq!(
            statements,
            vec![
                "DROP INDEX \"public\".\"idx_users_name\"".to_string(),
                "ALTER TABLE \"public\".\"users\" DROP COLUMN \"name\"".to_string(),
            ]
        );
    }

    #[test]
    fn rejects_postgres_destructive_update_without_confirmation() {
        let input = update_table_input();
        let statements = vec!["ALTER TABLE \"public\".\"users\" DROP COLUMN \"name\"".to_string()];

        let error = PostgresDriver::ensure_destructive_table_update_confirmed(&input, &statements)
            .unwrap_err();

        assert_eq!(error.message, "破坏性表结构变更需要确认后才能执行");
    }

    #[test]
    fn accepts_postgres_destructive_update_with_confirmation() {
        let mut input = update_table_input();
        input.confirm_destructive = true;
        let statements = vec!["ALTER TABLE \"public\".\"users\" DROP COLUMN \"name\"".to_string()];

        PostgresDriver::ensure_destructive_table_update_confirmed(&input, &statements).unwrap();
    }

    #[test]
    fn marks_postgres_destructive_update_preview() {
        let mut preview = SchemaMutationPreview::from_statements(vec![
            "ALTER TABLE \"public\".\"users\" DROP COLUMN \"name\"".to_string(),
        ]);

        PostgresDriver::mark_destructive_table_update_preview(&mut preview);

        assert!(preview.destructive);
        assert_eq!(preview.warnings.len(), 1);
        assert!(preview.warnings[0].contains("永久删除"));
    }

    #[test]
    fn builds_postgres_existing_column_default_and_nullability_sql() {
        let mut input = update_table_input();
        input.baseline.columns[1].nullable = true;
        input.baseline.columns[1].default_value = None;

        input.target.columns[1].nullable = false;
        input.target.columns[1].default_value = Some("'anonymous'".to_string());

        let (_, _, _, statements) =
            PostgresDriver::update_table_statements(&input, "app", "public").unwrap();

        assert_eq!(
            statements,
            vec![
                "ALTER TABLE \"public\".\"users\" ALTER COLUMN \"name\" SET DEFAULT 'anonymous'"
                    .to_string(),
                "ALTER TABLE \"public\".\"users\" ALTER COLUMN \"name\" SET NOT NULL".to_string(),
            ]
        );
    }

    #[test]
    fn builds_postgres_existing_column_drop_default_and_drop_not_null_sql() {
        let mut input = update_table_input();
        input.baseline.columns[1].nullable = false;
        input.baseline.columns[1].default_value = Some("'anonymous'".to_string());

        input.target.columns[1].nullable = true;
        input.target.columns[1].default_value = None;

        let (_, _, _, statements) =
            PostgresDriver::update_table_statements(&input, "app", "public").unwrap();

        assert_eq!(
            statements,
            vec![
                "ALTER TABLE \"public\".\"users\" ALTER COLUMN \"name\" DROP DEFAULT".to_string(),
                "ALTER TABLE \"public\".\"users\" ALTER COLUMN \"name\" DROP NOT NULL".to_string(),
            ]
        );
    }

    #[test]
    fn builds_postgres_column_rename_and_type_update_sql() {
        let mut input = update_table_input();
        input.column_renames.push(TableColumnRename {
            old_name: "name".to_string(),
            new_name: "display_name".to_string(),
        });
        input.baseline.columns[1].comment = None;
        input.target.columns[1].name = "display_name".to_string();
        input.target.columns[1].type_name = "text".to_string();
        input.target.columns[1].comment = Some("Display name".to_string());
        input.target.indexes[0].columns = vec!["display_name".to_string()];

        let (_, _, _, statements) =
            PostgresDriver::update_table_statements(&input, "app", "public").unwrap();

        assert_eq!(
            statements,
            vec![
                "ALTER TABLE \"public\".\"users\" RENAME COLUMN \"name\" TO \"display_name\""
                    .to_string(),
                "ALTER TABLE \"public\".\"users\" ALTER COLUMN \"display_name\" TYPE text"
                    .to_string(),
                "COMMENT ON COLUMN \"public\".\"users\".\"display_name\" IS 'Display name'"
                    .to_string(),
                "DROP INDEX \"public\".\"idx_users_name\"".to_string(),
                "CREATE INDEX \"idx_users_name\" ON \"public\".\"users\" USING btree (\"display_name\")"
                    .to_string(),
            ]
        );
        assert!(PostgresDriver::table_update_statements_are_destructive(
            &statements
        ));
    }

    #[test]
    fn builds_postgres_primary_key_change_sql() {
        let mut input = update_table_input();
        input.baseline.columns[0].is_identity = false;
        input.baseline.constraints.push(TableConstraintSchema {
            name: "users_pkey".to_string(),
            kind: TableConstraintKind::PrimaryKey,
            columns: vec!["id".to_string()],
            reference: None,
            expression: None,
            comment: None,
            foreign_key: None,
            enforced: None,
        });
        input.target.columns[0].is_primary_key = false;
        input.target.columns[0].is_identity = false;
        input.target.columns[1].is_primary_key = true;
        input.target.constraints.push(TableConstraintSchema {
            name: "users_pkey".to_string(),
            kind: TableConstraintKind::PrimaryKey,
            columns: vec!["name".to_string()],
            reference: None,
            expression: None,
            comment: None,
            foreign_key: None,
            enforced: None,
        });

        let (_, _, _, statements) =
            PostgresDriver::update_table_statements(&input, "app", "public").unwrap();

        assert_eq!(
            statements,
            vec![
                "ALTER TABLE \"public\".\"users\" DROP CONSTRAINT \"users_pkey\"".to_string(),
                "ALTER TABLE \"public\".\"users\" ADD PRIMARY KEY (\"name\")".to_string(),
            ]
        );
        assert!(PostgresDriver::table_update_statements_are_destructive(
            &statements
        ));
    }

    #[test]
    fn rejects_postgres_primary_key_drop_without_constraint_name() {
        let mut input = update_table_input();
        input.baseline.columns[0].is_identity = false;
        input.target.columns[0].is_primary_key = false;
        input.target.columns[0].is_identity = false;
        input.target.columns[1].is_primary_key = true;

        let error = PostgresDriver::update_table_statements(&input, "app", "public").unwrap_err();

        assert_eq!(
            error.message,
            "无法确定当前 PostgreSQL 主键约束名，请刷新表结构后重试"
        );
    }

    #[test]
    fn hides_postgres_internal_schemas_from_browser() {
        for schema in [
            "information_schema",
            "pg_catalog",
            "pg_toast",
            "pg_toast_123",
            "pg_temp",
            "pg_temp_3",
            "pg_toast_temp",
            "pg_toast_temp_3",
        ] {
            assert!(
                !PostgresDriver::is_user_schema_name(schema),
                "{schema} should be hidden"
            );
        }

        for schema in ["public", "app", "app_schema", "tenant_pg_temp_data"] {
            assert!(
                PostgresDriver::is_user_schema_name(schema),
                "{schema} should be visible"
            );
        }
    }

    #[test]
    fn rejects_postgres_create_table_in_internal_schema() {
        for schema in [
            "information_schema",
            "pg_catalog",
            "pg_toast_123",
            "pg_temp_3",
            "pg_toast_temp_3",
        ] {
            let mut input = minimal_create_table_input();
            input.basics.schema_name = schema.to_string();

            let error = PostgresDriver::create_table_statements(&input, "app", "public")
                .expect_err("internal schema should be rejected");

            assert!(
                matches!(error.code, crate::error::ErrorCode::ValidationFailed),
                "unexpected code for {schema}: {:?}",
                error.code
            );
        }
    }

    #[test]
    fn builds_postgres_create_table_check_constraint() {
        let mut input = minimal_create_table_input();
        input.constraints.push(TableConstraintSchema {
            name: "ck_users_id".to_string(),
            kind: TableConstraintKind::Check,
            columns: Vec::new(),
            reference: None,
            expression: Some("id > 0".to_string()),
            comment: None,
            foreign_key: None,
            enforced: None,
        });

        let statements = PostgresDriver::create_table_statements(&input, "app", "public").unwrap();

        assert!(statements[0].contains("CONSTRAINT \"ck_users_id\" CHECK (id > 0)"));
    }

    #[test]
    fn table_view_and_materialized_view_are_table_data_containers() {
        assert!(ensure_postgres_table_data_container(&ContainerKind::Table).is_ok());
        assert!(ensure_postgres_table_data_container(&ContainerKind::View).is_ok());
        assert!(ensure_postgres_table_data_container(&ContainerKind::MaterializedView).is_ok());
    }

    #[test]
    fn casts_postgres_uuid_table_values_to_text_for_json_transport() {
        let column = ColumnMeta {
            name: "id".to_string(),
            type_name: "uuid".to_string(),
            nullable: false,
            default_value: None,
            data_category: ColumnDataCategory::Uuid,
            max_length: None,
            numeric_precision: None,
            numeric_scale: None,
            enum_values: None,
            is_primary_key: true,
            primary_key_ordinal: Some(1),
            is_unique: true,
            is_writable: false,
        };

        assert_eq!(
            pg_table_select_expression(&column),
            "\"id\"::text AS \"id\""
        );
    }

    #[test]
    fn casts_postgres_special_display_types_to_text_for_table_display() {
        for type_name in ["point", "inet", "daterange", "money"] {
            let column = ColumnMeta {
                name: "value".to_string(),
                type_name: type_name.to_string(),
                nullable: false,
                default_value: None,
                data_category: ColumnDataCategory::Unknown,
                max_length: None,
                numeric_precision: None,
                numeric_scale: None,
                enum_values: None,
                is_primary_key: false,
                primary_key_ordinal: None,
                is_unique: false,
                is_writable: true,
            };

            assert_eq!(
                pg_table_select_expression(&column),
                "\"value\"::text AS \"value\""
            );
        }
    }

    #[test]
    fn keeps_postgres_numeric_table_values_typed() {
        let column = ColumnMeta {
            name: "score".to_string(),
            type_name: "integer".to_string(),
            nullable: false,
            default_value: None,
            data_category: ColumnDataCategory::Number,
            max_length: None,
            numeric_precision: Some(32),
            numeric_scale: Some(0),
            enum_values: None,
            is_primary_key: false,
            primary_key_ordinal: None,
            is_unique: false,
            is_writable: true,
        };

        assert_eq!(pg_table_select_expression(&column), "\"score\"");
    }

    #[test]
    fn casts_postgres_bigint_table_values_to_text_for_json_transport() {
        for type_name in ["bigint", "int8"] {
            let column = ColumnMeta {
                name: "id".to_string(),
                type_name: type_name.to_string(),
                nullable: false,
                default_value: None,
                data_category: ColumnDataCategory::Number,
                max_length: None,
                numeric_precision: Some(64),
                numeric_scale: Some(0),
                enum_values: None,
                is_primary_key: true,
                primary_key_ordinal: Some(1),
                is_unique: true,
                is_writable: true,
            };

            assert_eq!(
                pg_table_select_expression(&column),
                "\"id\"::text AS \"id\""
            );
        }
    }

    #[test]
    fn casts_postgres_exact_numeric_table_values_to_text() {
        let column = ColumnMeta {
            name: "amount".to_string(),
            type_name: "numeric".to_string(),
            nullable: false,
            default_value: None,
            data_category: ColumnDataCategory::Number,
            max_length: None,
            numeric_precision: Some(12),
            numeric_scale: Some(2),
            enum_values: None,
            is_primary_key: false,
            primary_key_ordinal: None,
            is_unique: false,
            is_writable: true,
        };

        assert_eq!(
            pg_table_select_expression(&column),
            "\"amount\"::text AS \"amount\""
        );
    }

    #[test]
    fn casts_postgres_enum_table_values_to_text() {
        let column = ColumnMeta {
            name: "status".to_string(),
            type_name: "employee_status_enum".to_string(),
            nullable: false,
            default_value: None,
            data_category: ColumnDataCategory::Enum,
            max_length: None,
            numeric_precision: None,
            numeric_scale: None,
            enum_values: Some(vec!["active".to_string(), "inactive".to_string()]),
            is_primary_key: false,
            primary_key_ordinal: None,
            is_unique: false,
            is_writable: true,
        };

        assert_eq!(
            pg_table_select_expression(&column),
            "\"status\"::text AS \"status\""
        );
    }

    #[test]
    fn normalizes_postgres_runtime_type_names() {
        assert_eq!(pg_normalize_type_name("INT4"), "int4");
        assert_eq!(pg_normalize_type_name(" integer "), "integer");
        assert_eq!(
            pg_normalize_type_name("DOUBLE PRECISION"),
            "double precision"
        );
    }

    #[test]
    fn builds_postgres_table_page_stats_sql() {
        assert_eq!(
            pg_table_page_stats_sql("\"public\".\"users\"", ""),
            "SELECT COUNT(*) FROM \"public\".\"users\""
        );
    }

    fn minimal_create_table_input() -> CreateTableInput {
        CreateTableInput {
            basics: TableSchemaBasics {
                table_name: "users".to_string(),
                database_name: "app".to_string(),
                schema_name: "public".to_string(),
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
                schema_name: "public".to_string(),
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
                    comment: Some("Display name".to_string()),
                },
            ],
            indexes: vec![TableIndexSchema {
                name: "idx_users_name".to_string(),
                columns: vec!["name".to_string()],
                is_unique: false,
                method: Some("btree".to_string()),
                comment: None,
            }],
            constraints: Vec::new(),
        };

        UpdateTableInput {
            container: ContainerRef::table(
                ContainerKind::Table,
                "app",
                Some("public".to_string()),
                "users",
            ),
            baseline: schema.clone(),
            target: schema,
            column_renames: Vec::new(),
            confirm_destructive: false,
        }
    }

    #[test]
    fn classifies_postgres_column_data_categories() {
        assert_eq!(
            PostgresDriver::classify_column_data_category("jsonb", "jsonb", None),
            ColumnDataCategory::Json
        );
        assert_eq!(
            PostgresDriver::classify_column_data_category("uuid", "uuid", None),
            ColumnDataCategory::Uuid
        );
        assert_eq!(
            PostgresDriver::classify_column_data_category("boolean", "bool", None),
            ColumnDataCategory::Boolean
        );
        assert_eq!(
            PostgresDriver::classify_column_data_category(
                "timestamp without time zone",
                "timestamp",
                None
            ),
            ColumnDataCategory::Datetime
        );
        assert_eq!(
            PostgresDriver::classify_column_data_category("bytea", "bytea", None),
            ColumnDataCategory::Binary
        );
        assert_eq!(
            PostgresDriver::classify_column_data_category(
                "USER-DEFINED",
                "mood",
                Some(&vec!["happy".to_string(), "sad".to_string()])
            ),
            ColumnDataCategory::Enum
        );
    }
}
