use std::path::Path;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures_util::TryStreamExt;
use serde_json::Value;
use sqlx::pool::PoolConnection;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::{Column, Executor, Row, Sqlite, TypeInfo, ValueRef};
use tokio::sync::Mutex;

use crate::engine::driver::{
    DataTableBrowser, DatabaseDriver, SchemaBrowser, SqlExecutor, TransactionManager,
};
use crate::engine::drivers::common::{
    build_table_change_set_preview, classify_sqlx_connection_error, classify_sqlx_query_error,
    ensure_real_table_for_mutation, json_i64_for_js_transport, leading_sql_keyword,
    ordered_primary_key_columns, sql_is_single_statement, sql_should_fetch_rows,
    sql_should_report_affected_rows, table_browse_sql_plan, table_page_stats, TableBrowseBindValue,
    TableBrowsePlaceholderStyle,
};
use crate::engine::profiles::SqliteProfile;
use crate::engine::types::{
    AssetGroupType, ColumnDataCategory, ColumnMeta, ContainerKind, ContainerRef, DataContainer,
    DriverCapabilities, PingResult, QueryResult, SqlExecutionContext, TableBrowseQuery,
    TableCellChange, TableChangeOutcome, TableChangeSetCommitResult, TableChangeSetPreview,
    TableChangeSetRequest, TableChangeSetUpdate, TableColumnSchema, TableConstraintSchema,
    TableIndexSchema, TableMutationResult, TablePageStats, TableRowKey, TableRowLocator,
    TableSchema, TableSchemaBasics, TableTransactionState,
};
use crate::error::{IpcError, IpcResult};

const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const SQLITE_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(5);

fn bind_sqlite_table_query<'q>(
    sql: &'q str,
    bindings: &'q [TableBrowseBindValue],
) -> sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
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

pub struct SqliteDriver {
    profile_id: String,
    database_name: String,
    is_read_only: bool,
    pool: SqlitePool,
    transaction: Mutex<Option<SqliteTransactionSession>>,
}

struct SqliteTransactionSession {
    database: String,
    connection: PoolConnection<Sqlite>,
}

#[derive(Debug, Clone)]
struct SqliteColumnInfo {
    name: String,
    type_name: String,
    nullable: bool,
    default_value: Option<String>,
    is_primary_key: bool,
    primary_key_ordinal: Option<i32>,
    is_unique: bool,
    is_generated: bool,
}

impl SqliteDriver {
    pub async fn connect(profile_id: String, profile: SqliteProfile) -> IpcResult<Self> {
        Self::validate_profile(&profile)?;
        let database_name = Self::database_name_from_path(&profile.db_file_path);
        let options = Self::connect_options(&profile);
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .acquire_timeout(SQLITE_ACQUIRE_TIMEOUT)
            .connect_with(options)
            .await
            .map_err(|error| classify_sqlx_connection_error(error, "SQLite"))?;

        Ok(Self {
            profile_id,
            database_name,
            is_read_only: profile.is_read_only,
            pool,
            transaction: Mutex::new(None),
        })
    }

    fn validate_profile(profile: &SqliteProfile) -> IpcResult<()> {
        let path = profile.db_file_path.trim();
        if path.is_empty() {
            return Err(IpcError::validation_failed("请填写 SQLite 数据库文件路径"));
        }
        if !Path::new(path).is_file() {
            return Err(IpcError::resource_not_found(format!(
                "SQLite database file '{path}' does not exist"
            )));
        }
        Ok(())
    }

    fn connect_options(profile: &SqliteProfile) -> SqliteConnectOptions {
        let path = profile.db_file_path.trim();
        SqliteConnectOptions::new()
            .filename(path)
            .read_only(profile.is_read_only)
            .create_if_missing(false)
            .foreign_keys(true)
            .busy_timeout(SQLITE_BUSY_TIMEOUT)
    }

    fn phase_five_capabilities() -> DriverCapabilities {
        DriverCapabilities {
            schema_browser: true,
            data_table_browser: true,
            sql_executor: true,
            table_row_mutator: true,
            table_row_inserter: true,
            transaction_manager: true,
            ..DriverCapabilities::default()
        }
    }

    fn ensure_writable_profile(&self) -> IpcResult<()> {
        if self.is_read_only {
            return Err(IpcError::validation_failed(
                "SQLite connection is read-only; reopen it with read-only mode disabled",
            ));
        }
        Ok(())
    }

    fn database_name_from_path(path: &str) -> String {
        Path::new(path.trim())
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("SQLite")
            .to_string()
    }

    fn container_database<'a>(&'a self, container: &'a ContainerRef) -> &'a str {
        container
            .database
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&self.database_name)
    }

    fn ensure_transaction_database(expected: &str, actual: &str) -> IpcResult<()> {
        if expected == actual {
            return Ok(());
        }

        Err(IpcError::system_internal(
            "当前事务已绑定到其他 SQLite 文件",
            format!(
                "SQLite transaction database is '{expected}', requested database is '{actual}'"
            ),
        ))
    }

    fn transaction_state_from_session(
        session: Option<&SqliteTransactionSession>,
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

    fn table_name_from_container(container: &ContainerRef) -> IpcResult<&str> {
        container
            .table
            .as_deref()
            .or(container.object_name.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| IpcError::resource_not_found("SQLite table name is missing"))
    }

    fn root_database_container(&self) -> DataContainer {
        DataContainer {
            id: format!("{}::sqlite::database", self.profile_id),
            name: self.database_name.clone(),
            kind: ContainerKind::Database,
            is_leaf: false,
            container: ContainerRef::database(self.database_name.clone()),
            type_name: Some("sqlite_file".to_string()),
            nullable: None,
            item_count: None,
            properties: Vec::new(),
        }
    }

    fn asset_group(
        &self,
        database: &str,
        table: Option<&str>,
        group_type: AssetGroupType,
        name: &str,
    ) -> DataContainer {
        let group_slug = sqlite_asset_group_slug(&group_type);
        let id = match table {
            Some(table) => format!(
                "{}::sqlite::{database}::{table}::group::{group_slug}",
                self.profile_id
            ),
            None => format!(
                "{}::sqlite::{database}::group::{group_slug}",
                self.profile_id
            ),
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
            self.asset_group(database, None, AssetGroupType::Indexes, "Indexes"),
            self.asset_group(database, None, AssetGroupType::Triggers, "Triggers"),
        ]
    }

    fn table_asset_groups(&self, database: &str, table: &str) -> Vec<DataContainer> {
        vec![
            self.asset_group(database, Some(table), AssetGroupType::Columns, "Columns"),
            self.asset_group(database, Some(table), AssetGroupType::Indexes, "Indexes"),
            self.asset_group(database, Some(table), AssetGroupType::Triggers, "Triggers"),
        ]
    }

    fn view_asset_groups(&self, database: &str, view: &str) -> Vec<DataContainer> {
        vec![
            self.asset_group(database, Some(view), AssetGroupType::Columns, "Columns"),
            self.asset_group(database, Some(view), AssetGroupType::Triggers, "Triggers"),
        ]
    }

    async fn load_unique_columns(
        &self,
        table: &str,
    ) -> IpcResult<std::collections::HashSet<String>> {
        let sql = format!("PRAGMA index_list({})", sqlite_quote_identifier(table));
        let index_rows = sqlx::query(&sql)
            .fetch_all(&self.pool)
            .await
            .map_err(classify_sqlx_query_error)?;
        let mut unique_columns = std::collections::HashSet::new();

        for index_row in index_rows {
            let is_unique: i64 = index_row
                .try_get("unique")
                .map_err(classify_sqlx_query_error)?;
            if is_unique == 0 {
                continue;
            }

            let index_name: String = index_row
                .try_get("name")
                .map_err(classify_sqlx_query_error)?;
            if index_name.trim().is_empty() {
                continue;
            }

            let index_sql = format!(
                "PRAGMA index_info({})",
                sqlite_quote_identifier(&index_name)
            );
            let column_rows = sqlx::query(&index_sql)
                .fetch_all(&self.pool)
                .await
                .map_err(classify_sqlx_query_error)?;
            if column_rows.len() != 1 {
                continue;
            }

            let column_name: String = column_rows[0]
                .try_get("name")
                .map_err(classify_sqlx_query_error)?;
            if !column_name.trim().is_empty() {
                unique_columns.insert(column_name);
            }
        }

        Ok(unique_columns)
    }

    async fn load_sqlite_column_info(&self, table: &str) -> IpcResult<Vec<SqliteColumnInfo>> {
        let unique_columns = self.load_unique_columns(table).await?;
        let sql = format!("PRAGMA table_xinfo({})", sqlite_quote_identifier(table));
        let rows = sqlx::query(&sql)
            .fetch_all(&self.pool)
            .await
            .map_err(classify_sqlx_query_error)?;
        let mut columns = Vec::new();

        for row in rows {
            let name: String = row.try_get("name").map_err(classify_sqlx_query_error)?;
            if name.trim().is_empty() {
                continue;
            }
            let type_name: String = row.try_get("type").map_err(classify_sqlx_query_error)?;
            let not_null: i64 = row.try_get("notnull").map_err(classify_sqlx_query_error)?;
            let default_value: Option<String> = row
                .try_get("dflt_value")
                .map_err(classify_sqlx_query_error)?;
            let pk: i64 = row.try_get("pk").map_err(classify_sqlx_query_error)?;
            let hidden: i64 = row.try_get("hidden").map_err(classify_sqlx_query_error)?;
            if hidden == 1 {
                continue;
            }

            columns.push(SqliteColumnInfo {
                is_unique: pk > 0 || unique_columns.contains(&name),
                nullable: not_null == 0 && pk == 0,
                default_value,
                is_primary_key: pk > 0,
                primary_key_ordinal: if pk > 0 { Some(pk as i32) } else { None },
                is_generated: hidden == 2 || hidden == 3,
                name,
                type_name,
            });
        }

        Ok(columns)
    }

    async fn load_table_columns_meta(
        &self,
        container: &ContainerRef,
    ) -> IpcResult<Vec<ColumnMeta>> {
        let table = Self::table_name_from_container(container)?;
        let columns = self.load_sqlite_column_info(table).await?;
        let is_real_table = container.kind == ContainerKind::Table;
        let profile_is_writable = !self.is_read_only;

        Ok(columns
            .into_iter()
            .map(|column| {
                let data_category = classify_sqlite_type_name(&column.type_name);
                let is_writable = profile_is_writable
                    && is_real_table
                    && !column.is_generated
                    && data_category != ColumnDataCategory::Binary;

                ColumnMeta {
                    name: column.name,
                    type_name: column.type_name,
                    nullable: column.nullable,
                    default_value: column.default_value,
                    data_category,
                    max_length: None,
                    numeric_precision: None,
                    numeric_scale: None,
                    enum_values: None,
                    is_primary_key: column.is_primary_key,
                    primary_key_ordinal: column.primary_key_ordinal,
                    is_unique: column.is_unique,
                    is_writable,
                }
            })
            .collect())
    }

    fn sqlite_columns_to_table_schema(
        &self,
        database: &str,
        table: &str,
        columns: Vec<SqliteColumnInfo>,
    ) -> TableSchema {
        TableSchema {
            basics: TableSchemaBasics {
                table_name: table.to_string(),
                database_name: database.to_string(),
                schema_name: String::new(),
                engine: None,
                charset: None,
                collation: None,
                comment: None,
                partition: None,
            },
            columns: columns
                .into_iter()
                .map(|column| TableColumnSchema {
                    name: column.name,
                    type_name: column.type_name,
                    nullable: column.nullable,
                    default_value: column.default_value,
                    is_primary_key: column.is_primary_key,
                    is_unique: column.is_unique,
                    is_identity: false,
                    comment: None,
                    identity: None,
                    generated: None,
                    charset: None,
                    collation: None,
                })
                .collect(),
            indexes: Vec::<TableIndexSchema>::new(),
            constraints: Vec::<TableConstraintSchema>::new(),
        }
    }

    fn ensure_sql_editor_request(&self, context: &SqlExecutionContext, sql: &str) -> IpcResult<()> {
        if sql.trim().is_empty() {
            return Err(IpcError::validation_failed("SQL cannot be empty"));
        }
        if !sql_is_single_statement(sql) {
            return Err(IpcError::validation_failed(
                "SQL editor execution accepts one statement per IPC call",
            ));
        }
        if context
            .schema
            .as_deref()
            .map(str::trim)
            .is_some_and(|schema| !schema.is_empty())
        {
            return Err(IpcError::validation_failed(
                "SQLite does not support schemas; use the file database context only",
            ));
        }
        if context
            .database
            .as_deref()
            .map(str::trim)
            .is_some_and(|database| !database.is_empty() && database != self.database_name)
        {
            return Err(IpcError::validation_failed(
                "SQLite SQL target does not match the connected database file",
            ));
        }
        if self.is_read_only
            && !matches!(
                leading_sql_keyword(sql).as_deref(),
                Some("SELECT" | "VALUES" | "EXPLAIN")
            )
        {
            return Err(IpcError::permission_denied(
                "SQLite connection is read-only; this SQL is not provably read-only",
            ));
        }
        Ok(())
    }

    async fn execute_sqlite_query_rows(
        &self,
        sql: &str,
        page: u32,
        page_size: u32,
    ) -> IpcResult<QueryResult> {
        let safe_page_size = page_size.max(1);
        let offset = page.saturating_sub(1) as usize * safe_page_size as usize;
        let limit = safe_page_size as usize + 1;
        let mut stream = sqlx::query(sql).fetch(&self.pool);
        let mut skipped = 0_usize;
        let mut rows = Vec::new();
        let mut columns: Option<Vec<ColumnMeta>> = None;

        while let Some(row) = stream.try_next().await.map_err(classify_sqlx_query_error)? {
            if columns.is_none() {
                columns = Some(sqlite_columns_from_row(&row));
            }
            if skipped < offset {
                skipped += 1;
                continue;
            }
            if rows.len() < limit {
                rows.push(row);
            } else {
                break;
            }
        }

        let columns = match columns {
            Some(columns) => columns,
            None => {
                let describe = self
                    .pool
                    .describe(sql)
                    .await
                    .map_err(classify_sqlx_query_error)?;
                describe
                    .columns()
                    .iter()
                    .map(|column| {
                        let type_name = column.type_info().name().to_string();
                        let mut meta = ColumnMeta::readonly_query_column(
                            column.name(),
                            type_name.clone(),
                            true,
                        );
                        meta.data_category = classify_sqlite_type_name(&type_name);
                        meta
                    })
                    .collect()
            }
        };

        sqlite_rows_to_query_result(
            rows,
            safe_page_size,
            columns,
            false,
            false,
            Vec::new(),
            Vec::new(),
        )
    }

    async fn list_table_like(
        &self,
        database: &str,
        group_type: &AssetGroupType,
    ) -> IpcResult<Vec<DataContainer>> {
        let (object_type, kind) = match group_type {
            AssetGroupType::Tables => ("table", ContainerKind::Table),
            AssetGroupType::Views => ("view", ContainerKind::View),
            _ => return Ok(Vec::new()),
        };

        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT name, type
             FROM sqlite_schema
             WHERE type = ? AND name NOT GLOB 'sqlite_*'
             ORDER BY name",
        )
        .bind(object_type)
        .fetch_all(&self.pool)
        .await
        .map_err(classify_sqlx_query_error)?;

        Ok(rows
            .into_iter()
            .map(|(name, type_name)| {
                let container =
                    ContainerRef::table(kind.clone(), database.to_string(), None, name.clone());
                DataContainer {
                    id: format!(
                        "{}::sqlite::{database}::{object_type}::{name}",
                        self.profile_id
                    ),
                    name,
                    kind: kind.clone(),
                    is_leaf: false,
                    container,
                    type_name: Some(type_name),
                    nullable: None,
                    item_count: None,
                    properties: Vec::new(),
                }
            })
            .collect())
    }

    async fn list_columns(&self, database: &str, table: &str) -> IpcResult<Vec<DataContainer>> {
        let mut columns = Vec::new();
        for column in self.load_sqlite_column_info(table).await? {
            let container = ContainerRef::column(
                database.to_string(),
                None,
                table.to_string(),
                column.name.clone(),
            );
            columns.push(DataContainer {
                id: format!(
                    "{}::sqlite::{database}::{table}::column::{}",
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
            });
        }

        Ok(columns)
    }

    async fn list_indexes(
        &self,
        database: &str,
        table: Option<&str>,
    ) -> IpcResult<Vec<DataContainer>> {
        let rows: Vec<(String, String)> = match table {
            Some(table) => {
                sqlx::query_as(
                    "SELECT name, tbl_name
                     FROM sqlite_schema
                     WHERE type = 'index'
                       AND tbl_name = ?
                       AND name NOT GLOB 'sqlite_*'
                     ORDER BY name",
                )
                .bind(table)
                .fetch_all(&self.pool)
                .await
            }
            None => {
                sqlx::query_as(
                    "SELECT name, tbl_name
                     FROM sqlite_schema
                     WHERE type = 'index'
                       AND name NOT GLOB 'sqlite_*'
                     ORDER BY tbl_name, name",
                )
                .fetch_all(&self.pool)
                .await
            }
        }
        .map_err(classify_sqlx_query_error)?;

        Ok(rows
            .into_iter()
            .map(|(name, table_name)| DataContainer {
                id: format!(
                    "{}::sqlite::{database}::{table_name}::index::{name}",
                    self.profile_id
                ),
                name: name.clone(),
                kind: ContainerKind::Index,
                is_leaf: true,
                container: ContainerRef {
                    kind: ContainerKind::Index,
                    group_type: None,
                    database: Some(database.to_string()),
                    schema: None,
                    table: Some(table_name.clone()),
                    column: None,
                    object_name: Some(name),
                    db_index: None,
                    key: None,
                    pattern: None,
                },
                type_name: Some(table_name),
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
        let rows: Vec<(String, String)> = match table {
            Some(table) => {
                sqlx::query_as(
                    "SELECT name, tbl_name
                     FROM sqlite_schema
                     WHERE type = 'trigger'
                       AND tbl_name = ?
                       AND name NOT GLOB 'sqlite_*'
                     ORDER BY name",
                )
                .bind(table)
                .fetch_all(&self.pool)
                .await
            }
            None => {
                sqlx::query_as(
                    "SELECT name, tbl_name
                     FROM sqlite_schema
                     WHERE type = 'trigger'
                       AND name NOT GLOB 'sqlite_*'
                     ORDER BY tbl_name, name",
                )
                .fetch_all(&self.pool)
                .await
            }
        }
        .map_err(classify_sqlx_query_error)?;

        Ok(rows
            .into_iter()
            .map(|(name, table_name)| DataContainer {
                id: format!(
                    "{}::sqlite::{database}::{table_name}::trigger::{name}",
                    self.profile_id
                ),
                name: name.clone(),
                kind: ContainerKind::Trigger,
                is_leaf: true,
                container: ContainerRef {
                    kind: ContainerKind::Trigger,
                    group_type: None,
                    database: Some(database.to_string()),
                    schema: None,
                    table: Some(table_name.clone()),
                    column: None,
                    object_name: Some(name),
                    db_index: None,
                    key: None,
                    pattern: None,
                },
                type_name: Some(table_name),
                nullable: None,
                item_count: None,
                properties: Vec::new(),
            })
            .collect())
    }

    async fn list_asset_group(&self, container: &ContainerRef) -> IpcResult<Vec<DataContainer>> {
        let database = self.container_database(container).to_string();
        let group_type = container
            .group_type
            .as_ref()
            .ok_or_else(|| IpcError::resource_not_found("SQLite asset group type is missing"))?;

        match group_type {
            AssetGroupType::Tables | AssetGroupType::Views => {
                self.list_table_like(&database, group_type).await
            }
            AssetGroupType::Columns => {
                let table = Self::table_name_from_container(container)?;
                self.list_columns(&database, table).await
            }
            AssetGroupType::Indexes => {
                self.list_indexes(&database, container.table.as_deref())
                    .await
            }
            AssetGroupType::Triggers => {
                self.list_triggers(&database, container.table.as_deref())
                    .await
            }
            _ => Ok(Vec::new()),
        }
    }
}

fn sqlite_asset_group_slug(group_type: &AssetGroupType) -> &'static str {
    match group_type {
        AssetGroupType::Tables => "tables",
        AssetGroupType::Views => "views",
        AssetGroupType::Columns => "columns",
        AssetGroupType::Indexes => "indexes",
        AssetGroupType::Triggers => "triggers",
        _ => "unsupported",
    }
}

fn sqlite_quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn classify_sqlite_type_name(type_name: &str) -> ColumnDataCategory {
    let normalized = type_name.trim().to_ascii_uppercase();
    if normalized.contains("INT") {
        return ColumnDataCategory::Number;
    }
    if normalized.contains("REAL")
        || normalized.contains("FLOA")
        || normalized.contains("DOUB")
        || normalized.contains("NUM")
        || normalized.contains("DEC")
    {
        return ColumnDataCategory::Number;
    }
    if normalized.contains("BOOL") {
        return ColumnDataCategory::Boolean;
    }
    if normalized.contains("JSON") {
        return ColumnDataCategory::Json;
    }
    if normalized.contains("BLOB") {
        return ColumnDataCategory::Binary;
    }
    if normalized.contains("DATETIME") || normalized.contains("TIMESTAMP") {
        return ColumnDataCategory::Datetime;
    }
    if normalized == "DATE" || normalized.contains(" DATE") {
        return ColumnDataCategory::Date;
    }
    if normalized == "TIME" || normalized.contains(" TIME") {
        return ColumnDataCategory::Time;
    }
    if normalized.contains("CHAR") || normalized.contains("CLOB") || normalized.contains("TEXT") {
        return ColumnDataCategory::String;
    }
    if normalized.is_empty() {
        return ColumnDataCategory::Binary;
    }
    ColumnDataCategory::Unknown
}

fn sqlite_empty_insert_statement(table: &str) -> String {
    format!("INSERT INTO {table} DEFAULT VALUES")
}

fn sqlite_has_mutation_safe_primary_key(columns: &[ColumnMeta]) -> bool {
    let primary_key_columns = ordered_primary_key_columns(columns);
    !primary_key_columns.is_empty()
        && primary_key_columns.iter().all(|primary_key| {
            columns.iter().any(|column| {
                column.name == *primary_key && column.data_category != ColumnDataCategory::Binary
            })
        })
}

fn ensure_sqlite_table_has_mutation_safe_primary_key(columns: &[ColumnMeta]) -> IpcResult<()> {
    let primary_key_columns = ordered_primary_key_columns(columns);
    if primary_key_columns.is_empty() {
        return Err(IpcError::system_internal(
            "该 SQLite 表没有显式主键，无法安全定位要修改或删除的行；当前仅支持浏览数据",
            "SQLite DataTable mutation requires an explicit primary key",
        ));
    }
    if !sqlite_has_mutation_safe_primary_key(columns) {
        return Err(IpcError::system_internal(
            "该 SQLite 表使用二进制主键，当前无法安全定位要修改或删除的行；当前仅支持浏览数据",
            "SQLite DataTable mutation does not support binary primary keys",
        ));
    }
    Ok(())
}

fn sqlite_trim_trailing_semicolon(sql: &str) -> &str {
    sql.trim().trim_end_matches(';').trim()
}

fn sqlite_cell_to_json(row: &SqliteRow, index: usize) -> IpcResult<Value> {
    let raw = row.try_get_raw(index).map_err(classify_sqlx_query_error)?;
    if raw.is_null() {
        return Ok(Value::Null);
    }

    let storage_type = raw.type_info().name().to_ascii_uppercase();
    match storage_type.as_str() {
        "INTEGER" => {
            let value: i64 = row.try_get(index).map_err(classify_sqlx_query_error)?;
            Ok(json_i64_for_js_transport(value))
        }
        "REAL" => {
            let value: f64 = row.try_get(index).map_err(classify_sqlx_query_error)?;
            Ok(serde_json::Number::from_f64(value)
                .map(Value::Number)
                .unwrap_or(Value::Null))
        }
        "TEXT" => {
            let value: String = row.try_get(index).map_err(classify_sqlx_query_error)?;
            Ok(Value::String(value))
        }
        "BLOB" => Ok(Value::String("<BINARY>".to_string())),
        _ => {
            if let Ok(value) = row.try_get::<String, _>(index) {
                return Ok(Value::String(value));
            }
            if let Ok(value) = row.try_get::<i64, _>(index) {
                return Ok(json_i64_for_js_transport(value));
            }
            if let Ok(value) = row.try_get::<f64, _>(index) {
                return Ok(serde_json::Number::from_f64(value)
                    .map(Value::Number)
                    .unwrap_or(Value::Null));
            }
            Ok(Value::String("<BINARY>".to_string()))
        }
    }
}

fn sqlite_rows_to_query_result(
    rows: Vec<SqliteRow>,
    page_size: u32,
    columns: Vec<ColumnMeta>,
    source_writable: bool,
    source_insertable: bool,
    primary_key_columns: Vec<String>,
    stable_order_columns: Vec<String>,
) -> IpcResult<QueryResult> {
    let limit = page_size.max(1) as usize;
    let has_next_page = rows.len() > limit;
    let mut result_rows = Vec::new();

    for row in rows.into_iter().take(limit) {
        let mut values = Vec::with_capacity(columns.len());
        for index in 0..columns.len() {
            values.push(sqlite_cell_to_json(&row, index)?);
        }
        result_rows.push(values);
    }

    Ok(QueryResult {
        columns,
        rows: result_rows,
        affected_rows: None,
        has_next_page,
        source_writable,
        source_insertable,
        primary_key_columns,
        stable_order_columns,
        row_locator_strategy: source_writable
            .then_some(crate::engine::types::TableRowLocatorStrategy::PrimaryKey),
    })
}

fn sqlite_columns_from_row(row: &SqliteRow) -> Vec<ColumnMeta> {
    row.columns()
        .iter()
        .map(|column| {
            let type_name = column.type_info().name().to_string();
            let mut meta =
                ColumnMeta::readonly_query_column(column.name(), type_name.clone(), true);
            meta.data_category = classify_sqlite_type_name(&type_name);
            meta
        })
        .collect()
}

#[async_trait]
impl DatabaseDriver for SqliteDriver {
    fn profile_id(&self) -> &str {
        &self.profile_id
    }

    fn driver_name(&self) -> &'static str {
        "sqlite"
    }

    fn capabilities(&self) -> DriverCapabilities {
        Self::phase_five_capabilities()
    }

    async fn ping(&self) -> IpcResult<PingResult> {
        let started = Instant::now();
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .map_err(classify_sqlx_query_error)?;

        Ok(PingResult {
            latency_ms: started.elapsed().as_millis() as u64,
        })
    }

    async fn close(&self) -> IpcResult<()> {
        self.rollback_active_transaction().await?;
        self.pool.close().await;
        Ok(())
    }

    async fn server_version(&self) -> IpcResult<Option<String>> {
        let row = sqlx::query("SELECT sqlite_version() AS version")
            .fetch_one(&self.pool)
            .await
            .map_err(classify_sqlx_query_error)?;
        let version: String = row.try_get("version").map_err(classify_sqlx_query_error)?;
        Ok(Some(version))
    }

    fn as_schema_browser(&self) -> Option<&dyn SchemaBrowser> {
        Some(self)
    }

    fn as_data_table_browser(&self) -> Option<&dyn DataTableBrowser> {
        Some(self)
    }

    fn as_transaction_manager(&self) -> Option<&dyn TransactionManager> {
        Some(self)
    }

    fn as_sql_executor(&self) -> Option<&dyn SqlExecutor> {
        Some(self)
    }
}

#[async_trait]
impl SchemaBrowser for SqliteDriver {
    async fn list_containers(
        &self,
        parent: Option<&ContainerRef>,
    ) -> IpcResult<Vec<DataContainer>> {
        match parent.map(|container| &container.kind) {
            None => Ok(vec![self.root_database_container()]),
            Some(ContainerKind::Database) => {
                let database = parent
                    .map(|container| self.container_database(container))
                    .unwrap_or(&self.database_name);
                Ok(self.database_asset_groups(database))
            }
            Some(ContainerKind::Table) => {
                let container = parent.expect("checked parent");
                let database = self.container_database(container);
                let table = Self::table_name_from_container(container)?;
                Ok(self.table_asset_groups(database, table))
            }
            Some(ContainerKind::View) => {
                let container = parent.expect("checked parent");
                let database = self.container_database(container);
                let view = Self::table_name_from_container(container)?;
                Ok(self.view_asset_groups(database, view))
            }
            Some(ContainerKind::AssetGroup) => {
                self.list_asset_group(parent.expect("checked parent")).await
            }
            _ => Ok(Vec::new()),
        }
    }

    async fn describe_table(&self, container: &ContainerRef) -> IpcResult<TableSchema> {
        if container.kind != ContainerKind::Table && container.kind != ContainerKind::View {
            return Err(IpcError::resource_not_found(
                "SQLite table description requires a table or view container",
            ));
        }

        let database = self.container_database(container).to_string();
        let table = Self::table_name_from_container(container)?.to_string();
        let columns = self.load_sqlite_column_info(&table).await?;
        Ok(self.sqlite_columns_to_table_schema(&database, &table, columns))
    }
}

#[async_trait]
impl DataTableBrowser for SqliteDriver {
    async fn browse_table_data(
        &self,
        container: &ContainerRef,
        page: u32,
        page_size: u32,
        query: &TableBrowseQuery,
    ) -> IpcResult<QueryResult> {
        if container.kind != ContainerKind::Table && container.kind != ContainerKind::View {
            return Err(IpcError::resource_not_found(
                "SQLite data browsing requires a table or view container",
            ));
        }

        let columns = self.load_table_columns_meta(container).await?;
        let primary_key_columns = if container.kind == ContainerKind::Table {
            ordered_primary_key_columns(&columns)
        } else {
            Vec::new()
        };
        let stable_order_columns = primary_key_columns.clone();
        let source_writable = !self.is_read_only
            && container.kind == ContainerKind::Table
            && sqlite_has_mutation_safe_primary_key(&columns);
        let source_insertable = source_writable;
        let query_plan = table_browse_sql_plan(
            query,
            &columns,
            sqlite_quote_identifier,
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

        let table = sqlite_quote_identifier(Self::table_name_from_container(container)?);
        let select_columns = columns
            .iter()
            .map(|column| sqlite_quote_identifier(&column.name))
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
                    .map(|column| sqlite_quote_identifier(column))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        let safe_page_size = page_size.max(1);
        let limit = safe_page_size as i64 + 1;
        let offset = page.saturating_sub(1) as i64 * safe_page_size as i64;
        let sql = format!(
            "SELECT {select_columns} FROM {table}{}{order_by} LIMIT {limit} OFFSET {offset}",
            query_plan.where_clause
        );

        let database = self.container_database(container).to_string();
        let mut transaction = self.transaction.lock().await;
        let rows = if let Some(session) = transaction.as_mut() {
            Self::ensure_transaction_database(&session.database, &database)?;
            bind_sqlite_table_query(&sql, &query_plan.bindings)
                .fetch_all(&mut *session.connection)
                .await
                .map_err(classify_sqlx_query_error)?
        } else {
            drop(transaction);
            bind_sqlite_table_query(&sql, &query_plan.bindings)
                .fetch_all(&self.pool)
                .await
                .map_err(classify_sqlx_query_error)?
        };

        sqlite_rows_to_query_result(
            rows,
            safe_page_size,
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
        if container.kind != ContainerKind::Table && container.kind != ContainerKind::View {
            return Err(IpcError::resource_not_found(
                "SQLite page stats requires a table or view container",
            ));
        }

        let columns = self.load_table_columns_meta(container).await?;
        let query_plan = table_browse_sql_plan(
            query,
            &columns,
            sqlite_quote_identifier,
            TableBrowsePlaceholderStyle::QuestionMark,
        )?;
        let table = sqlite_quote_identifier(Self::table_name_from_container(container)?);
        let sql = format!("SELECT COUNT(*) FROM {table}{}", query_plan.where_clause);
        let database = self.container_database(container).to_string();
        let mut transaction = self.transaction.lock().await;
        let total_rows: i64 = if let Some(session) = transaction.as_mut() {
            Self::ensure_transaction_database(&session.database, &database)?;
            bind_sqlite_table_query(&sql, &query_plan.bindings)
                .fetch_one(&mut *session.connection)
                .await
                .map_err(classify_sqlx_query_error)?
                .try_get(0)
                .map_err(classify_sqlx_query_error)?
        } else {
            drop(transaction);
            bind_sqlite_table_query(&sql, &query_plan.bindings)
                .fetch_one(&self.pool)
                .await
                .map_err(classify_sqlx_query_error)?
                .try_get(0)
                .map_err(classify_sqlx_query_error)?
        };
        table_page_stats(total_rows.max(0) as u64, page_size, requested_page)
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
        self.ensure_writable_profile()?;
        ensure_real_table_for_mutation(&container.kind)?;
        let columns = self.load_table_columns_meta(container).await?;
        ensure_sqlite_table_has_mutation_safe_primary_key(&columns)?;
        let table = sqlite_quote_identifier(Self::table_name_from_container(container)?);

        build_table_change_set_preview(
            &columns,
            &table,
            sqlite_quote_identifier,
            sqlite_empty_insert_statement,
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
        let database = self.container_database(container).to_string();
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
            let statement_affected_rows = result.rows_affected();
            let is_update = index >= insert_statement_count
                && index < insert_statement_count + update_statement_count;
            if is_update && statement_affected_rows > 1 {
                return Err(IpcError::system_internal(
                    "更新影响了多行，已拒绝该结果",
                    "SQLite table change set update must affect at most one row",
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
impl TransactionManager for SqliteDriver {
    async fn begin_transaction(
        &self,
        container: &ContainerRef,
    ) -> IpcResult<TableTransactionState> {
        self.ensure_writable_profile()?;
        ensure_real_table_for_mutation(&container.kind)?;
        let database = self.container_database(container).to_string();
        Self::ensure_transaction_database(&self.database_name, &database)?;
        let columns = self.load_table_columns_meta(container).await?;
        ensure_sqlite_table_has_mutation_safe_primary_key(&columns)?;

        let mut transaction = self.transaction.lock().await;
        if transaction.is_some() {
            return Err(IpcError::system_internal(
                "当前标签页已有活动事务",
                "transaction already active for this tab runtime",
            ));
        }

        let mut connection = self.pool.acquire().await.map_err(|error| {
            IpcError::system_internal(
                "开启 SQLite 事务失败：无法获取数据库连接",
                error.to_string(),
            )
        })?;
        (&mut *connection)
            .execute("BEGIN IMMEDIATE")
            .await
            .map_err(|error| {
                IpcError::system_internal(
                    "开启 SQLite 事务失败：数据库文件可能正被其他写入者占用",
                    error.to_string(),
                )
            })?;
        *transaction = Some(SqliteTransactionSession {
            database,
            connection,
        });

        Ok(Self::transaction_state_from_session(transaction.as_ref()))
    }

    async fn commit_transaction(&self) -> IpcResult<TableTransactionState> {
        let mut transaction = self.transaction.lock().await;
        let Some(session) = transaction.as_mut() else {
            return Err(IpcError::system_internal(
                "当前标签页没有活动事务",
                "no active transaction for this tab runtime",
            ));
        };

        (&mut *session.connection)
            .execute("COMMIT")
            .await
            .map_err(classify_sqlx_query_error)?;
        let _ = transaction.take();
        Ok(Self::transaction_state_from_session(None))
    }

    async fn rollback_transaction(&self) -> IpcResult<TableTransactionState> {
        let mut transaction = self.transaction.lock().await;
        let Some(session) = transaction.as_mut() else {
            return Err(IpcError::system_internal(
                "当前标签页没有活动事务",
                "no active transaction for this tab runtime",
            ));
        };

        (&mut *session.connection)
            .execute("ROLLBACK")
            .await
            .map_err(classify_sqlx_query_error)?;
        let _ = transaction.take();
        Ok(Self::transaction_state_from_session(None))
    }

    async fn transaction_state(&self) -> IpcResult<TableTransactionState> {
        let transaction = self.transaction.lock().await;
        Ok(Self::transaction_state_from_session(transaction.as_ref()))
    }
}

#[async_trait]
impl SqlExecutor for SqliteDriver {
    async fn execute_sql(
        &self,
        context: &SqlExecutionContext,
        sql: &str,
        page: u32,
        page_size: u32,
    ) -> IpcResult<QueryResult> {
        self.ensure_sql_editor_request(context, sql)?;
        let sql = sqlite_trim_trailing_semicolon(sql);

        if sql_should_fetch_rows(sql) {
            return self.execute_sqlite_query_rows(sql, page, page_size).await;
        }

        let result = sqlx::query(sql)
            .execute(&self.pool)
            .await
            .map_err(classify_sqlx_query_error)?;
        let affected_rows = if sql_should_report_affected_rows(sql) {
            Some(result.rows_affected())
        } else {
            None
        };

        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            affected_rows,
            has_next_page: false,
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
    use std::future::Future;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use crate::engine::driver::{DatabaseDriver, SchemaBrowser, TransactionManager};
    use crate::engine::profiles::SqliteProfile;
    use crate::engine::types::{
        AssetGroupType, ColumnDataCategory, ContainerKind, ContainerRef, DataContainer,
        SqlExecutionContext, TableBrowseQuery, TableCellChange, TableChangeSetInsert,
        TableChangeSetRequest, TableChangeSetUpdate, TableRowKeyPart, TableRowLocator,
    };

    use super::*;

    fn primary_key_locator(parts: Vec<TableRowKeyPart>) -> TableRowLocator {
        TableRowLocator::primary_key(parts)
    }

    fn run_async<F>(future: F)
    where
        F: Future<Output = ()>,
    {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("build test runtime")
            .block_on(future);
    }

    fn profile(path: &str, is_read_only: bool) -> SqliteProfile {
        SqliteProfile {
            db_file_path: path.to_string(),
            is_read_only,
        }
    }

    fn temp_sqlite_path(marker: &str) -> PathBuf {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_millis();
        std::env::temp_dir().join(format!(
            "nexpilot_sqlite_{marker}_{}_{}.sqlite3",
            std::process::id(),
            millis
        ))
    }

    async fn create_metadata_fixture(path: &Path) {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("create SQLite metadata fixture");

        sqlx::query(
            "CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                name_upper TEXT GENERATED ALWAYS AS (upper(name)) VIRTUAL
            )",
        )
        .execute(&pool)
        .await
        .expect("create users table");
        sqlx::query("CREATE INDEX idx_users_name ON users(name)")
            .execute(&pool)
            .await
            .expect("create users index");
        sqlx::query("CREATE VIEW active_users AS SELECT id, name FROM users")
            .execute(&pool)
            .await
            .expect("create users view");
        sqlx::query(
            "CREATE TRIGGER users_ai AFTER INSERT ON users
             BEGIN
                 UPDATE users SET name = NEW.name WHERE id = NEW.id;
             END",
        )
        .execute(&pool)
        .await
        .expect("create users trigger");

        pool.close().await;
    }

    async fn create_read_data_fixture(path: &Path) {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("create SQLite read-data fixture");

        sqlx::query(
            "CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                age INTEGER,
                score REAL,
                active BOOLEAN,
                payload JSON,
                avatar BLOB,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                name_upper TEXT GENERATED ALWAYS AS (upper(name)) VIRTUAL
            )",
        )
        .execute(&pool)
        .await
        .expect("create users table");

        sqlx::query(
            "INSERT INTO users (id, name, age, score, active, payload, avatar, created_at)
             VALUES
                 (1, 'Ada', 37, 98.5, 1, '{\"role\":\"admin\"}', X'0102', '2026-01-01T10:00:00Z'),
                 (2, 'Linus', 55, 88.25, 0, '{\"role\":\"user\"}', X'0304', '2026-01-02T10:00:00Z'),
                 (3, 'Grace', NULL, NULL, 1, NULL, NULL, '2026-01-03T10:00:00Z')",
        )
        .execute(&pool)
        .await
        .expect("insert users");

        sqlx::query("CREATE VIEW active_users AS SELECT id, name FROM users WHERE active = 1")
            .execute(&pool)
            .await
            .expect("create active_users view");

        sqlx::query(
            "CREATE TABLE memberships (
                account_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                role TEXT NOT NULL DEFAULT 'member',
                role_upper TEXT GENERATED ALWAYS AS (upper(role)) STORED,
                PRIMARY KEY (account_id, user_id)
            )",
        )
        .execute(&pool)
        .await
        .expect("create memberships table");

        sqlx::query(
            "INSERT INTO memberships (account_id, user_id, role)
             VALUES (10, 1, 'owner'), (10, 2, 'member')",
        )
        .execute(&pool)
        .await
        .expect("insert memberships");

        sqlx::query(
            "CREATE TABLE notes_without_pk (
                body TEXT NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .expect("create notes_without_pk table");

        sqlx::query("INSERT INTO notes_without_pk (body) VALUES ('read only through DataTable')")
            .execute(&pool)
            .await
            .expect("insert notes_without_pk");

        sqlx::query(
            "CREATE TABLE binary_keys (
                id BLOB PRIMARY KEY,
                label TEXT NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .expect("create binary_keys table");

        sqlx::query("INSERT INTO binary_keys (id, label) VALUES (X'0102', 'binary key')")
            .execute(&pool)
            .await
            .expect("insert binary_keys");

        pool.close().await;
    }

    fn sqlite_context(database: &str) -> SqlExecutionContext {
        SqlExecutionContext {
            database: Some(database.to_string()),
            schema: None,
        }
    }

    fn find_group(containers: &[DataContainer], group_type: AssetGroupType) -> &DataContainer {
        containers
            .iter()
            .find(|container| container.container.group_type == Some(group_type.clone()))
            .unwrap_or_else(|| panic!("missing asset group {group_type:?}"))
    }

    fn find_container<'a>(
        containers: &'a [DataContainer],
        kind: ContainerKind,
        name: &str,
    ) -> &'a DataContainer {
        containers
            .iter()
            .find(|container| container.kind == kind && container.name == name)
            .unwrap_or_else(|| panic!("missing {kind:?} container named {name}"))
    }

    fn users_table(database: &str) -> ContainerRef {
        ContainerRef::table(
            ContainerKind::Table,
            database.to_string(),
            None,
            "users".to_string(),
        )
    }

    fn insert_user(id: i64, name: &str) -> TableChangeSetInsert {
        TableChangeSetInsert {
            values: vec![
                TableCellChange {
                    column: "id".to_string(),
                    value: json!(id),
                },
                TableCellChange {
                    column: "name".to_string(),
                    value: json!(name),
                },
            ],
        }
    }

    fn query_column_index(result: &QueryResult, column_name: &str) -> usize {
        result
            .columns
            .iter()
            .position(|column| column.name == column_name)
            .unwrap_or_else(|| panic!("missing query column {column_name}"))
    }

    fn query_row_by_id<'a>(result: &'a QueryResult, id: i64) -> &'a Vec<Value> {
        let id_index = query_column_index(result, "id");
        result
            .rows
            .iter()
            .find(|row| row[id_index] == json!(id))
            .unwrap_or_else(|| panic!("missing query row with id {id}"))
    }

    #[test]
    fn sqlite_phase_five_capabilities_enable_datatable_transactions() {
        let capabilities = SqliteDriver::phase_five_capabilities();

        assert!(capabilities.schema_browser);
        assert!(capabilities.data_table_browser);
        assert!(capabilities.sql_executor);
        assert!(!capabilities.schema_mutator);
        assert!(capabilities.table_row_mutator);
        assert!(capabilities.table_row_inserter);
        assert!(capabilities.transaction_manager);
        assert!(!capabilities.key_value_browser);
        assert!(!capabilities.graph_queryer);
        assert!(!capabilities.vector_searcher);
    }

    #[test]
    fn sqlite_database_name_from_path_trims_profile_path() {
        assert_eq!(
            SqliteDriver::database_name_from_path("  D:/data/app.sqlite3  "),
            "app.sqlite3"
        );
    }

    #[test]
    fn sqlite_schema_browser_lists_file_database_and_object_groups() {
        run_async(async {
            let path = temp_sqlite_path("metadata");
            create_metadata_fixture(&path).await;

            let driver = SqliteDriver::connect(
                "sqlite-metadata-test".to_string(),
                SqliteProfile {
                    db_file_path: path.to_string_lossy().to_string(),
                    is_read_only: true,
                },
            )
            .await
            .expect("connect SQLite metadata fixture");

            let root = driver
                .list_containers(None)
                .await
                .expect("list SQLite root containers");
            assert_eq!(root.len(), 1);
            assert_eq!(root[0].kind, ContainerKind::Database);
            assert_eq!(
                root[0].name,
                path.file_name()
                    .and_then(|value| value.to_str())
                    .expect("fixture file name")
            );
            assert!(driver.as_schema_browser().is_some());

            let groups = driver
                .list_containers(Some(&root[0].container))
                .await
                .expect("list SQLite database asset groups");
            find_group(&groups, AssetGroupType::Tables);
            find_group(&groups, AssetGroupType::Views);
            find_group(&groups, AssetGroupType::Indexes);
            find_group(&groups, AssetGroupType::Triggers);

            let tables_group = find_group(&groups, AssetGroupType::Tables);
            let tables = driver
                .list_containers(Some(&tables_group.container))
                .await
                .expect("list SQLite tables");
            let users = find_container(&tables, ContainerKind::Table, "users");
            assert!(
                tables
                    .iter()
                    .all(|table| !table.name.starts_with("sqlite_")),
                "internal SQLite tables should be hidden"
            );

            let views_group = find_group(&groups, AssetGroupType::Views);
            let views = driver
                .list_containers(Some(&views_group.container))
                .await
                .expect("list SQLite views");
            let active_users = find_container(&views, ContainerKind::View, "active_users");

            let table_groups = driver
                .list_containers(Some(&users.container))
                .await
                .expect("list SQLite table asset groups");
            let columns_group = find_group(&table_groups, AssetGroupType::Columns);
            let table_indexes_group = find_group(&table_groups, AssetGroupType::Indexes);
            let table_triggers_group = find_group(&table_groups, AssetGroupType::Triggers);

            let columns = driver
                .list_containers(Some(&columns_group.container))
                .await
                .expect("list SQLite table columns");
            let name_column = find_container(&columns, ContainerKind::Column, "name");
            assert_eq!(name_column.type_name.as_deref(), Some("TEXT"));
            assert_eq!(name_column.nullable, Some(false));
            find_container(&columns, ContainerKind::Column, "name_upper");

            let table_indexes = driver
                .list_containers(Some(&table_indexes_group.container))
                .await
                .expect("list SQLite table indexes");
            find_container(&table_indexes, ContainerKind::Index, "idx_users_name");

            let table_triggers = driver
                .list_containers(Some(&table_triggers_group.container))
                .await
                .expect("list SQLite table triggers");
            find_container(&table_triggers, ContainerKind::Trigger, "users_ai");

            let view_groups = driver
                .list_containers(Some(&active_users.container))
                .await
                .expect("list SQLite view asset groups");
            find_group(&view_groups, AssetGroupType::Columns);
            find_group(&view_groups, AssetGroupType::Triggers);

            let indexes_group = find_group(&groups, AssetGroupType::Indexes);
            let indexes = driver
                .list_containers(Some(&indexes_group.container))
                .await
                .expect("list SQLite indexes");
            find_container(&indexes, ContainerKind::Index, "idx_users_name");
            assert!(
                indexes
                    .iter()
                    .all(|index| !index.name.starts_with("sqlite_")),
                "internal SQLite indexes should be hidden"
            );

            let triggers_group = find_group(&groups, AssetGroupType::Triggers);
            let triggers = driver
                .list_containers(Some(&triggers_group.container))
                .await
                .expect("list SQLite triggers");
            find_container(&triggers, ContainerKind::Trigger, "users_ai");

            driver.close().await.expect("close SQLite metadata fixture");
            let _ = std::fs::remove_file(path);
        });
    }

    #[test]
    fn sqlite_data_table_browser_pages_table_and_view_rows() {
        run_async(async {
            let path = temp_sqlite_path("read_data");
            create_read_data_fixture(&path).await;

            let driver = SqliteDriver::connect(
                "sqlite-read-data-test".to_string(),
                SqliteProfile {
                    db_file_path: path.to_string_lossy().to_string(),
                    is_read_only: true,
                },
            )
            .await
            .expect("connect SQLite read-data fixture");

            let database = SqliteDriver::database_name_from_path(&path.to_string_lossy());
            let table = ContainerRef::table(
                ContainerKind::Table,
                database.clone(),
                None,
                "users".to_string(),
            );
            let view = ContainerRef::table(
                ContainerKind::View,
                database.clone(),
                None,
                "active_users".to_string(),
            );
            let browser = driver
                .as_data_table_browser()
                .expect("SQLite Phase 3 should expose data table browser");

            let first_page = browser
                .browse_table_data(&table, 1, 2, &TableBrowseQuery::default())
                .await
                .expect("browse first SQLite table page");
            assert_eq!(first_page.rows.len(), 2);
            assert!(first_page.has_next_page);
            assert!(!first_page.source_writable);
            assert!(!first_page.source_insertable);
            assert_eq!(first_page.primary_key_columns, vec!["id"]);
            assert_eq!(first_page.stable_order_columns, vec!["id"]);
            assert!(first_page.columns.iter().all(|column| !column.is_writable));

            let id_column = first_page
                .columns
                .iter()
                .find(|column| column.name == "id")
                .expect("id column");
            assert!(id_column.is_primary_key);
            assert_eq!(id_column.primary_key_ordinal, Some(1));
            assert_eq!(id_column.data_category, ColumnDataCategory::Number);

            let payload_column = first_page
                .columns
                .iter()
                .find(|column| column.name == "payload")
                .expect("payload column");
            assert_eq!(payload_column.data_category, ColumnDataCategory::Json);

            let avatar_column = first_page
                .columns
                .iter()
                .find(|column| column.name == "avatar")
                .expect("avatar column");
            assert_eq!(avatar_column.data_category, ColumnDataCategory::Binary);

            assert_eq!(first_page.rows[0][0], json!(1));
            assert_eq!(first_page.rows[0][1], json!("Ada"));
            assert_eq!(first_page.rows[0][6], json!("<BINARY>"));

            let second_page = browser
                .browse_table_data(&table, 2, 2, &TableBrowseQuery::default())
                .await
                .expect("browse second SQLite table page");
            assert_eq!(second_page.rows.len(), 1);
            assert!(!second_page.has_next_page);
            assert_eq!(second_page.rows[0][0], json!(3));

            let stats = browser
                .get_table_page_stats(&table, 2, &TableBrowseQuery::default(), Some(2))
                .await
                .expect("get SQLite page stats");
            assert_eq!(stats.total_rows, 3);
            assert_eq!(stats.total_pages, 2);
            assert_eq!(stats.page_size, 2);

            let view_result = browser
                .browse_table_data(&view, 1, 10, &TableBrowseQuery::default())
                .await
                .expect("browse SQLite view data");
            assert_eq!(view_result.rows.len(), 2);
            assert!(!view_result.source_writable);
            assert!(!view_result.source_insertable);
            assert_eq!(view_result.primary_key_columns, Vec::<String>::new());

            driver
                .close()
                .await
                .expect("close SQLite read-data fixture");
            let _ = std::fs::remove_file(path);
        });
    }

    #[test]
    fn sqlite_writable_table_exposes_safe_mutation_metadata() {
        run_async(async {
            let path = temp_sqlite_path("writable_metadata");
            create_read_data_fixture(&path).await;

            let driver = SqliteDriver::connect(
                "sqlite-writable-metadata-test".to_string(),
                profile(&path.to_string_lossy(), false),
            )
            .await
            .expect("connect writable SQLite fixture");
            let database = SqliteDriver::database_name_from_path(&path.to_string_lossy());
            let table =
                ContainerRef::table(ContainerKind::Table, database, None, "users".to_string());
            let result = driver
                .as_data_table_browser()
                .expect("SQLite should expose DataTableBrowser")
                .browse_table_data(&table, 1, 10, &TableBrowseQuery::default())
                .await
                .expect("browse writable SQLite table");

            assert!(result.source_writable);
            assert!(result.source_insertable);
            assert_eq!(result.primary_key_columns, vec!["id"]);
            assert_eq!(result.stable_order_columns, vec!["id"]);

            let id = result
                .columns
                .iter()
                .find(|column| column.name == "id")
                .expect("id column");
            assert!(id.is_writable);
            let name = result
                .columns
                .iter()
                .find(|column| column.name == "name")
                .expect("name column");
            assert!(name.is_writable);
            let generated = result
                .columns
                .iter()
                .find(|column| column.name == "name_upper")
                .expect("generated column");
            assert!(!generated.is_writable);
            let avatar = result
                .columns
                .iter()
                .find(|column| column.name == "avatar")
                .expect("avatar column");
            assert!(!avatar.is_writable);

            driver.close().await.expect("close writable SQLite fixture");
            let _ = std::fs::remove_file(path);
        });
    }

    #[test]
    fn sqlite_read_only_view_and_no_pk_resources_stay_read_only() {
        run_async(async {
            let path = temp_sqlite_path("resource_guards");
            create_read_data_fixture(&path).await;
            let database = SqliteDriver::database_name_from_path(&path.to_string_lossy());
            let table = ContainerRef::table(
                ContainerKind::Table,
                database.clone(),
                None,
                "users".to_string(),
            );

            let read_only_driver = SqliteDriver::connect(
                "sqlite-read-only-resource-test".to_string(),
                profile(&path.to_string_lossy(), true),
            )
            .await
            .expect("connect read-only SQLite fixture");
            let read_only_result = read_only_driver
                .as_data_table_browser()
                .expect("SQLite should expose DataTableBrowser")
                .browse_table_data(&table, 1, 10, &TableBrowseQuery::default())
                .await
                .expect("browse read-only SQLite table");
            assert!(!read_only_result.source_writable);
            assert!(!read_only_result.source_insertable);
            assert!(read_only_result
                .columns
                .iter()
                .all(|column| !column.is_writable));
            read_only_driver
                .close()
                .await
                .expect("close read-only SQLite fixture");

            let writable_driver = SqliteDriver::connect(
                "sqlite-resource-guards-test".to_string(),
                profile(&path.to_string_lossy(), false),
            )
            .await
            .expect("connect writable SQLite fixture");
            let browser = writable_driver
                .as_data_table_browser()
                .expect("SQLite should expose DataTableBrowser");
            let view = ContainerRef::table(
                ContainerKind::View,
                database.clone(),
                None,
                "active_users".to_string(),
            );
            let view_result = browser
                .browse_table_data(&view, 1, 10, &TableBrowseQuery::default())
                .await
                .expect("browse SQLite view");
            assert!(!view_result.source_writable);
            assert!(!view_result.source_insertable);
            assert!(view_result.columns.iter().all(|column| !column.is_writable));

            let no_pk_table = ContainerRef::table(
                ContainerKind::Table,
                database,
                None,
                "notes_without_pk".to_string(),
            );
            let no_pk_result = browser
                .browse_table_data(&no_pk_table, 1, 10, &TableBrowseQuery::default())
                .await
                .expect("browse SQLite table without primary key");
            assert!(!no_pk_result.source_writable);
            assert!(!no_pk_result.source_insertable);
            assert!(no_pk_result.primary_key_columns.is_empty());

            let binary_key_table = ContainerRef::table(
                ContainerKind::Table,
                SqliteDriver::database_name_from_path(&path.to_string_lossy()),
                None,
                "binary_keys".to_string(),
            );
            let binary_key_result = browser
                .browse_table_data(&binary_key_table, 1, 10, &TableBrowseQuery::default())
                .await
                .expect("browse SQLite table with binary primary key");
            assert!(!binary_key_result.source_writable);
            assert!(!binary_key_result.source_insertable);
            assert_eq!(binary_key_result.primary_key_columns, vec!["id"]);

            writable_driver
                .close()
                .await
                .expect("close writable SQLite fixture");
            let _ = std::fs::remove_file(path);
        });
    }

    #[test]
    fn sqlite_describe_table_returns_schema_for_completion() {
        run_async(async {
            let path = temp_sqlite_path("describe");
            create_read_data_fixture(&path).await;

            let driver = SqliteDriver::connect(
                "sqlite-describe-test".to_string(),
                SqliteProfile {
                    db_file_path: path.to_string_lossy().to_string(),
                    is_read_only: true,
                },
            )
            .await
            .expect("connect SQLite describe fixture");

            let database = SqliteDriver::database_name_from_path(&path.to_string_lossy());
            let table = ContainerRef::table(
                ContainerKind::Table,
                database.clone(),
                None,
                "users".to_string(),
            );

            let schema = driver
                .describe_table(&table)
                .await
                .expect("describe SQLite table");
            assert_eq!(schema.basics.database_name, database);
            assert_eq!(schema.basics.schema_name, "");
            assert_eq!(schema.basics.table_name, "users");
            assert!(schema.columns.iter().any(|column| column.name == "name"
                && column.type_name == "TEXT"
                && !column.nullable));
            assert!(schema
                .columns
                .iter()
                .any(|column| column.name == "id" && column.is_primary_key));
            assert!(schema.indexes.is_empty());
            assert!(schema.constraints.is_empty());

            driver.close().await.expect("close SQLite describe fixture");
            let _ = std::fs::remove_file(path);
        });
    }

    #[test]
    fn sqlite_sql_executor_runs_select_and_dml() {
        run_async(async {
            let path = temp_sqlite_path("sql_editor");
            create_read_data_fixture(&path).await;

            let driver = SqliteDriver::connect(
                "sqlite-sql-editor-test".to_string(),
                SqliteProfile {
                    db_file_path: path.to_string_lossy().to_string(),
                    is_read_only: false,
                },
            )
            .await
            .expect("connect writable SQLite SQL fixture");

            let database = SqliteDriver::database_name_from_path(&path.to_string_lossy());
            let executor = driver
                .as_sql_executor()
                .expect("SQLite Phase 3 should expose SQL executor");
            let context = sqlite_context(&database);

            let first_page = executor
                .execute_sql(&context, "SELECT id, name FROM users ORDER BY id", 1, 2)
                .await
                .expect("execute SQLite SELECT first page");
            assert_eq!(first_page.columns.len(), 2);
            assert_eq!(first_page.rows.len(), 2);
            assert!(first_page.has_next_page);
            assert_eq!(first_page.rows[0], vec![json!(1), json!("Ada")]);
            assert!(!first_page.source_writable);
            assert!(!first_page.source_insertable);
            assert!(first_page.primary_key_columns.is_empty());
            assert!(first_page.stable_order_columns.is_empty());

            let second_page = executor
                .execute_sql(&context, "SELECT id, name FROM users ORDER BY id", 2, 2)
                .await
                .expect("execute SQLite SELECT second page");
            assert_eq!(second_page.rows, vec![vec![json!(3), json!("Grace")]]);
            assert!(!second_page.has_next_page);

            let insert_result = executor
                .execute_sql(
                    &context,
                    "INSERT INTO users (id, name, age, active) VALUES (4, 'Marie', 66, 1)",
                    1,
                    100,
                )
                .await
                .expect("execute SQLite INSERT");
            assert_eq!(insert_result.affected_rows, Some(1));
            assert!(insert_result.columns.is_empty());
            assert!(insert_result.rows.is_empty());

            let count_result = executor
                .execute_sql(&context, "SELECT COUNT(*) AS total FROM users", 1, 100)
                .await
                .expect("execute SQLite count after INSERT");
            assert_eq!(count_result.rows[0][0], json!(4));

            driver.close().await.expect("close SQLite SQL fixture");
            let _ = std::fs::remove_file(path);
        });
    }

    #[test]
    fn sqlite_sql_executor_preserves_columns_for_empty_select() {
        run_async(async {
            let path = temp_sqlite_path("sql_empty_select");
            create_read_data_fixture(&path).await;

            let driver = SqliteDriver::connect(
                "sqlite-sql-empty-select-test".to_string(),
                SqliteProfile {
                    db_file_path: path.to_string_lossy().to_string(),
                    is_read_only: true,
                },
            )
            .await
            .expect("connect SQLite empty SELECT fixture");

            let database = SqliteDriver::database_name_from_path(&path.to_string_lossy());
            let executor = driver
                .as_sql_executor()
                .expect("SQLite Phase 3 should expose SQL executor");
            let result = executor
                .execute_sql(
                    &sqlite_context(&database),
                    "SELECT id, name FROM users WHERE 1 = 0",
                    1,
                    10,
                )
                .await
                .expect("execute SQLite empty SELECT");

            assert_eq!(result.columns.len(), 2);
            assert_eq!(result.columns[0].name, "id");
            assert_eq!(result.columns[1].name, "name");
            assert!(result.rows.is_empty());
            assert!(!result.has_next_page);

            driver
                .close()
                .await
                .expect("close SQLite empty SELECT fixture");
            let _ = std::fs::remove_file(path);
        });
    }

    #[test]
    fn sqlite_sql_executor_rejects_schema_context_and_multiple_statements() {
        run_async(async {
            let path = temp_sqlite_path("sql_guards");
            create_read_data_fixture(&path).await;

            let driver = SqliteDriver::connect(
                "sqlite-sql-guards-test".to_string(),
                SqliteProfile {
                    db_file_path: path.to_string_lossy().to_string(),
                    is_read_only: true,
                },
            )
            .await
            .expect("connect SQLite guard fixture");

            let executor = driver
                .as_sql_executor()
                .expect("SQLite Phase 3 should expose SQL executor");
            let database = SqliteDriver::database_name_from_path(&path.to_string_lossy());
            let schema_error = executor
                .execute_sql(
                    &SqlExecutionContext {
                        database: Some(database),
                        schema: Some("main".to_string()),
                    },
                    "SELECT 1",
                    1,
                    10,
                )
                .await
                .expect_err("SQLite should reject schema context");
            assert!(schema_error
                .message
                .contains("SQLite does not support schemas"));

            let multi_error = executor
                .execute_sql(&SqlExecutionContext::default(), "SELECT 1; SELECT 2", 1, 10)
                .await
                .expect_err("SQLite should reject multiple statements per IPC call");
            assert!(multi_error.message.contains("one statement"));

            let wrong_database_error = executor
                .execute_sql(
                    &SqlExecutionContext {
                        database: Some("another.sqlite3".to_string()),
                        schema: None,
                    },
                    "SELECT 1",
                    1,
                    10,
                )
                .await
                .expect_err("SQLite should reject a mismatched database target");
            assert!(wrong_database_error.message.contains("does not match"));

            let mutation_error = executor
                .execute_sql(
                    &SqlExecutionContext::default(),
                    "UPDATE users SET active = 0 WHERE id = 1",
                    1,
                    10,
                )
                .await
                .expect_err("read-only SQLite should reject mutation before dispatch");
            assert_eq!(
                mutation_error.code,
                crate::error::ErrorCode::PermissionDenied
            );
            assert!(mutation_error.message.contains("not provably read-only"));

            let busy_timeout_ms: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
                .fetch_one(&driver.pool)
                .await
                .expect("SQLite connection should expose its configured busy timeout");
            assert_eq!(
                busy_timeout_ms,
                i64::try_from(SQLITE_BUSY_TIMEOUT.as_millis()).expect("timeout fits i64")
            );

            driver.close().await.expect("close SQLite guard fixture");
            let _ = std::fs::remove_file(path);
        });
    }

    #[test]
    fn sqlite_change_set_preview_and_commit_insert_update_delete() {
        run_async(async {
            let path = temp_sqlite_path("change_set");
            create_read_data_fixture(&path).await;

            let driver = SqliteDriver::connect(
                "sqlite-change-set-test".to_string(),
                profile(&path.to_string_lossy(), false),
            )
            .await
            .expect("connect writable SQLite change-set fixture");

            let database = SqliteDriver::database_name_from_path(&path.to_string_lossy());
            let table =
                ContainerRef::table(ContainerKind::Table, database, None, "users".to_string());
            let browser = driver
                .as_data_table_browser()
                .expect("SQLite should expose DataTableBrowser");
            let change_set = TableChangeSetRequest {
                inserts: vec![TableChangeSetInsert {
                    values: vec![
                        TableCellChange {
                            column: "id".to_string(),
                            value: json!(4),
                        },
                        TableCellChange {
                            column: "name".to_string(),
                            value: json!("O'Reilly"),
                        },
                    ],
                }],
                updates: vec![TableChangeSetUpdate {
                    locator: primary_key_locator(vec![TableRowKeyPart {
                        column: "id".to_string(),
                        value: json!(1),
                    }]),
                    changes: vec![TableCellChange {
                        column: "name".to_string(),
                        value: json!("Ada Lovelace"),
                    }],
                }],
                deletes: vec![primary_key_locator(vec![TableRowKeyPart {
                    column: "id".to_string(),
                    value: json!(2),
                }])],
            };

            let preview = browser
                .preview_table_change_set(&table, &change_set)
                .await
                .expect("preview SQLite change set");
            assert_eq!(preview.summary.inserts, 1);
            assert_eq!(preview.summary.updates, 1);
            assert_eq!(preview.summary.deletes, 1);
            assert_eq!(
                preview.statements,
                vec![
                    "INSERT INTO \"users\" (\"id\", \"name\") VALUES (4, 'O''Reilly')",
                    "UPDATE \"users\" SET \"name\" = 'Ada Lovelace' WHERE \"id\" = 1",
                    "DELETE FROM \"users\" WHERE (\"id\" = 2)",
                ]
            );

            let commit = browser
                .commit_table_change_set(&table, &change_set)
                .await
                .expect("commit SQLite change set");
            assert_eq!(commit.affected_rows, 3);

            let result = browser
                .browse_table_data(&table, 1, 10, &TableBrowseQuery::default())
                .await
                .expect("browse SQLite rows after change set");
            let id_index = result
                .columns
                .iter()
                .position(|column| column.name == "id")
                .expect("id column index");
            let name_index = result
                .columns
                .iter()
                .position(|column| column.name == "name")
                .expect("name column index");
            let created_at_index = result
                .columns
                .iter()
                .position(|column| column.name == "created_at")
                .expect("created_at column index");
            let generated_index = result
                .columns
                .iter()
                .position(|column| column.name == "name_upper")
                .expect("name_upper column index");
            assert_eq!(
                result
                    .rows
                    .iter()
                    .map(|row| row[id_index].clone())
                    .collect::<Vec<_>>(),
                vec![json!(1), json!(3), json!(4)]
            );
            let updated = result
                .rows
                .iter()
                .find(|row| row[id_index] == json!(1))
                .expect("updated row");
            assert_eq!(updated[name_index], json!("Ada Lovelace"));
            assert_eq!(updated[generated_index], json!("ADA LOVELACE"));
            let inserted = result
                .rows
                .iter()
                .find(|row| row[id_index] == json!(4))
                .expect("inserted row");
            assert_eq!(inserted[name_index], json!("O'Reilly"));
            assert_ne!(inserted[created_at_index], Value::Null);

            driver
                .close()
                .await
                .expect("close SQLite change-set fixture");
            let _ = std::fs::remove_file(path);
        });
    }

    #[test]
    fn sqlite_update_requires_complete_explicit_composite_primary_key() {
        run_async(async {
            let path = temp_sqlite_path("composite_pk");
            create_read_data_fixture(&path).await;
            let driver = SqliteDriver::connect(
                "sqlite-composite-pk-test".to_string(),
                profile(&path.to_string_lossy(), false),
            )
            .await
            .expect("connect writable SQLite composite-primary-key fixture");
            let database = SqliteDriver::database_name_from_path(&path.to_string_lossy());
            let table = ContainerRef::table(
                ContainerKind::Table,
                database,
                None,
                "memberships".to_string(),
            );
            let browser = driver
                .as_data_table_browser()
                .expect("SQLite should expose DataTableBrowser");
            let changes = vec![TableCellChange {
                column: "role".to_string(),
                value: json!("editor"),
            }];

            let incomplete_error = browser
                .update_table_row(
                    &table,
                    &vec![TableRowKeyPart {
                        column: "account_id".to_string(),
                        value: json!(10),
                    }],
                    &changes,
                )
                .await
                .expect_err("incomplete composite primary key must be rejected");
            assert!(incomplete_error.message.contains("主键参数不完整"));

            let rowid_error = browser
                .update_table_row(
                    &table,
                    &vec![TableRowKeyPart {
                        column: "rowid".to_string(),
                        value: json!(2),
                    }],
                    &changes,
                )
                .await
                .expect_err("rowid fallback must be rejected");
            assert!(rowid_error.message.contains("主键参数不完整"));

            let update = browser
                .update_table_row(
                    &table,
                    &vec![
                        TableRowKeyPart {
                            column: "user_id".to_string(),
                            value: json!(2),
                        },
                        TableRowKeyPart {
                            column: "account_id".to_string(),
                            value: json!(10),
                        },
                    ],
                    &changes,
                )
                .await
                .expect("update with complete composite primary key");
            assert_eq!(update.affected_rows, 1);

            let result = browser
                .browse_table_data(&table, 1, 10, &TableBrowseQuery::default())
                .await
                .expect("browse memberships after update");
            assert_eq!(result.primary_key_columns, vec!["account_id", "user_id"]);
            assert_eq!(result.rows[1][2], json!("editor"));
            assert_eq!(result.rows[1][3], json!("EDITOR"));

            driver
                .close()
                .await
                .expect("close SQLite composite-primary-key fixture");
            let _ = std::fs::remove_file(path);
        });
    }

    #[test]
    fn sqlite_mutation_rejects_read_only_view_no_pk_generated_and_pk_updates() {
        run_async(async {
            let path = temp_sqlite_path("mutation_guards");
            create_read_data_fixture(&path).await;
            let database = SqliteDriver::database_name_from_path(&path.to_string_lossy());
            let table = ContainerRef::table(
                ContainerKind::Table,
                database.clone(),
                None,
                "users".to_string(),
            );
            let valid_insert = TableChangeSetRequest {
                inserts: vec![TableChangeSetInsert {
                    values: vec![
                        TableCellChange {
                            column: "id".to_string(),
                            value: json!(4),
                        },
                        TableCellChange {
                            column: "name".to_string(),
                            value: json!("Marie"),
                        },
                    ],
                }],
                updates: Vec::new(),
                deletes: Vec::new(),
            };

            let read_only_driver = SqliteDriver::connect(
                "sqlite-read-only-mutation-test".to_string(),
                profile(&path.to_string_lossy(), true),
            )
            .await
            .expect("connect read-only SQLite fixture");
            let read_only_error = read_only_driver
                .as_data_table_browser()
                .expect("SQLite should expose DataTableBrowser")
                .preview_table_change_set(&table, &valid_insert)
                .await
                .expect_err("read-only SQLite mutation must be rejected");
            assert!(read_only_error.message.contains("read-only"));
            read_only_driver
                .close()
                .await
                .expect("close read-only SQLite fixture");

            let writable_driver = SqliteDriver::connect(
                "sqlite-mutation-guards-test".to_string(),
                profile(&path.to_string_lossy(), false),
            )
            .await
            .expect("connect writable SQLite mutation guard fixture");
            let browser = writable_driver
                .as_data_table_browser()
                .expect("SQLite should expose DataTableBrowser");

            let view = ContainerRef::table(
                ContainerKind::View,
                database.clone(),
                None,
                "active_users".to_string(),
            );
            let view_error = browser
                .preview_table_change_set(&view, &valid_insert)
                .await
                .expect_err("view mutation must be rejected");
            assert!(view_error.message.contains("真实表"));

            let no_pk_table = ContainerRef::table(
                ContainerKind::Table,
                database,
                None,
                "notes_without_pk".to_string(),
            );
            let no_pk_error = browser
                .preview_table_change_set(
                    &no_pk_table,
                    &TableChangeSetRequest {
                        inserts: vec![TableChangeSetInsert {
                            values: vec![TableCellChange {
                                column: "body".to_string(),
                                value: json!("unsafe insert"),
                            }],
                        }],
                        updates: Vec::new(),
                        deletes: Vec::new(),
                    },
                )
                .await
                .expect_err("no-primary-key table mutation must be rejected");
            assert!(no_pk_error.message.contains("没有显式主键"));
            assert!(no_pk_error.message.contains("当前仅支持浏览数据"));
            assert!(!no_pk_error.message.to_ascii_lowercase().contains("phase"));

            let binary_key_table = ContainerRef::table(
                ContainerKind::Table,
                SqliteDriver::database_name_from_path(&path.to_string_lossy()),
                None,
                "binary_keys".to_string(),
            );
            let binary_key_error = browser
                .preview_table_change_set(
                    &binary_key_table,
                    &TableChangeSetRequest {
                        inserts: vec![TableChangeSetInsert {
                            values: vec![TableCellChange {
                                column: "label".to_string(),
                                value: json!("unsafe binary key"),
                            }],
                        }],
                        updates: Vec::new(),
                        deletes: Vec::new(),
                    },
                )
                .await
                .expect_err("binary-primary-key table mutation must be rejected");
            assert!(binary_key_error.message.contains("二进制主键"));
            assert!(binary_key_error.message.contains("当前仅支持浏览数据"));
            assert!(!binary_key_error
                .message
                .to_ascii_lowercase()
                .contains("phase"));

            let primary_key_error = browser
                .update_table_row(
                    &table,
                    &vec![TableRowKeyPart {
                        column: "id".to_string(),
                        value: json!(1),
                    }],
                    &[TableCellChange {
                        column: "id".to_string(),
                        value: json!(9),
                    }],
                )
                .await
                .expect_err("primary-key update must be rejected");
            assert!(primary_key_error.message.contains("暂不支持修改主键列"));

            let generated_error = browser
                .preview_table_change_set(
                    &table,
                    &TableChangeSetRequest {
                        inserts: vec![TableChangeSetInsert {
                            values: vec![TableCellChange {
                                column: "name_upper".to_string(),
                                value: json!("MARIE"),
                            }],
                        }],
                        updates: Vec::new(),
                        deletes: Vec::new(),
                    },
                )
                .await
                .expect_err("generated-column insert must be rejected");
            assert!(generated_error.message.contains("不可直接写入"));

            let binary_error = browser
                .update_table_row(
                    &table,
                    &vec![TableRowKeyPart {
                        column: "id".to_string(),
                        value: json!(1),
                    }],
                    &[TableCellChange {
                        column: "avatar".to_string(),
                        value: json!("<BINARY>"),
                    }],
                )
                .await
                .expect_err("binary-column update must be rejected");
            assert!(binary_error.message.contains("不可直接写入"));

            let empty_error = browser
                .preview_table_change_set(
                    &table,
                    &TableChangeSetRequest {
                        inserts: Vec::new(),
                        updates: Vec::new(),
                        deletes: Vec::new(),
                    },
                )
                .await
                .expect_err("empty change set must be rejected");
            assert!(empty_error.message.contains("没有需要提交的表格变更"));

            writable_driver
                .close()
                .await
                .expect("close writable SQLite mutation guard fixture");
            let _ = std::fs::remove_file(path);
        });
    }

    #[test]
    fn sqlite_transaction_lifecycle_reports_state_and_rejects_invalid_transitions() {
        run_async(async {
            let path = temp_sqlite_path("transaction_lifecycle");
            create_read_data_fixture(&path).await;
            let driver = SqliteDriver::connect(
                "sqlite-transaction-lifecycle-test".to_string(),
                profile(&path.to_string_lossy(), false),
            )
            .await
            .expect("connect writable SQLite transaction fixture");
            let database = SqliteDriver::database_name_from_path(&path.to_string_lossy());
            let table = users_table(&database);

            assert!(driver.as_transaction_manager().is_some());
            let initial = TransactionManager::transaction_state(&driver)
                .await
                .expect("read initial SQLite transaction state");
            assert!(!initial.in_transaction);
            assert_eq!(initial.database, None);

            let active = TransactionManager::begin_transaction(&driver, &table)
                .await
                .expect("begin SQLite DataTable transaction");
            assert!(active.in_transaction);
            assert_eq!(active.database.as_deref(), Some(database.as_str()));

            let duplicate_error = TransactionManager::begin_transaction(&driver, &table)
                .await
                .expect_err("duplicate SQLite transaction begin must fail");
            assert!(duplicate_error.message.contains("当前标签页已有活动事务"));

            let rolled_back = TransactionManager::rollback_transaction(&driver)
                .await
                .expect("roll back SQLite DataTable transaction");
            assert!(!rolled_back.in_transaction);
            assert_eq!(rolled_back.database, None);

            let rollback_error = TransactionManager::rollback_transaction(&driver)
                .await
                .expect_err("rollback without active SQLite transaction must fail");
            assert!(rollback_error.message.contains("当前标签页没有活动事务"));

            let commit_error = TransactionManager::commit_transaction(&driver)
                .await
                .expect_err("commit without active SQLite transaction must fail");
            assert!(commit_error.message.contains("当前标签页没有活动事务"));

            driver
                .close()
                .await
                .expect("close SQLite transaction lifecycle fixture");
            let _ = std::fs::remove_file(path);
        });
    }

    #[test]
    fn sqlite_transaction_routes_browse_stats_and_change_set_to_pinned_connection() {
        run_async(async {
            let path = temp_sqlite_path("transaction_rollback_visibility");
            create_read_data_fixture(&path).await;
            let database = SqliteDriver::database_name_from_path(&path.to_string_lossy());
            let table = users_table(&database);
            let owner = SqliteDriver::connect(
                "sqlite-transaction-owner-test".to_string(),
                profile(&path.to_string_lossy(), false),
            )
            .await
            .expect("connect writable SQLite transaction owner");
            let observer = SqliteDriver::connect(
                "sqlite-transaction-observer-test".to_string(),
                profile(&path.to_string_lossy(), true),
            )
            .await
            .expect("connect read-only SQLite transaction observer");

            TransactionManager::begin_transaction(&owner, &table)
                .await
                .expect("begin SQLite rollback-visibility transaction");
            owner
                .commit_table_change_set(
                    &table,
                    &TableChangeSetRequest {
                        inserts: vec![insert_user(4, "Marie")],
                        updates: vec![TableChangeSetUpdate {
                            locator: primary_key_locator(vec![TableRowKeyPart {
                                column: "id".to_string(),
                                value: json!(1),
                            }]),
                            changes: vec![TableCellChange {
                                column: "name".to_string(),
                                value: json!("Ada Lovelace"),
                            }],
                        }],
                        deletes: Vec::new(),
                    },
                )
                .await
                .expect("save SQLite change set inside transaction");

            let owner_result = owner
                .browse_table_data(&table, 1, 10, &TableBrowseQuery::default())
                .await
                .expect("owner browses uncommitted SQLite rows");
            assert_eq!(owner_result.rows.len(), 4);
            assert_eq!(
                query_row_by_id(&owner_result, 1)[query_column_index(&owner_result, "name")],
                json!("Ada Lovelace")
            );
            assert_eq!(
                query_row_by_id(&owner_result, 4)[query_column_index(&owner_result, "name")],
                json!("Marie")
            );
            let owner_stats = owner
                .get_table_page_stats(&table, 10, &TableBrowseQuery::default(), Some(1))
                .await
                .expect("owner reads transactional SQLite page stats");
            assert_eq!(owner_stats.total_rows, 4);

            let observer_result = observer
                .browse_table_data(&table, 1, 10, &TableBrowseQuery::default())
                .await
                .expect("observer browses last committed SQLite rows");
            assert_eq!(observer_result.rows.len(), 3);
            assert_eq!(
                query_row_by_id(&observer_result, 1)[query_column_index(&observer_result, "name")],
                json!("Ada")
            );

            TransactionManager::rollback_transaction(&owner)
                .await
                .expect("roll back SQLite DataTable changes");
            let owner_after_rollback = owner
                .browse_table_data(&table, 1, 10, &TableBrowseQuery::default())
                .await
                .expect("owner browses SQLite rows after rollback");
            let observer_after_rollback = observer
                .browse_table_data(&table, 1, 10, &TableBrowseQuery::default())
                .await
                .expect("observer browses SQLite rows after rollback");
            assert_eq!(owner_after_rollback.rows.len(), 3);
            assert_eq!(observer_after_rollback.rows.len(), 3);
            assert_eq!(
                query_row_by_id(&owner_after_rollback, 1)
                    [query_column_index(&owner_after_rollback, "name")],
                json!("Ada")
            );

            observer
                .close()
                .await
                .expect("close SQLite transaction observer");
            owner.close().await.expect("close SQLite transaction owner");
            let _ = std::fs::remove_file(path);
        });
    }

    #[test]
    fn sqlite_transaction_commit_persists_change_set() {
        run_async(async {
            let path = temp_sqlite_path("transaction_commit_visibility");
            create_read_data_fixture(&path).await;
            let database = SqliteDriver::database_name_from_path(&path.to_string_lossy());
            let table = users_table(&database);
            let owner = SqliteDriver::connect(
                "sqlite-transaction-commit-owner-test".to_string(),
                profile(&path.to_string_lossy(), false),
            )
            .await
            .expect("connect writable SQLite commit fixture");

            TransactionManager::begin_transaction(&owner, &table)
                .await
                .expect("begin SQLite commit transaction");
            owner
                .commit_table_change_set(
                    &table,
                    &TableChangeSetRequest {
                        inserts: vec![insert_user(4, "Marie")],
                        updates: vec![TableChangeSetUpdate {
                            locator: primary_key_locator(vec![TableRowKeyPart {
                                column: "id".to_string(),
                                value: json!(1),
                            }]),
                            changes: vec![TableCellChange {
                                column: "name".to_string(),
                                value: json!("Ada Lovelace"),
                            }],
                        }],
                        deletes: vec![primary_key_locator(vec![TableRowKeyPart {
                            column: "id".to_string(),
                            value: json!(2),
                        }])],
                    },
                )
                .await
                .expect("save SQLite commit change set");

            let owner_result = owner
                .browse_table_data(&table, 1, 10, &TableBrowseQuery::default())
                .await
                .expect("owner browses SQLite rows before commit");
            assert_eq!(
                owner_result
                    .rows
                    .iter()
                    .map(|row| row[query_column_index(&owner_result, "id")].clone())
                    .collect::<Vec<_>>(),
                vec![json!(1), json!(3), json!(4)]
            );

            let committed = TransactionManager::commit_transaction(&owner)
                .await
                .expect("commit SQLite DataTable transaction");
            assert!(!committed.in_transaction);
            assert_eq!(committed.database, None);
            let state = TransactionManager::transaction_state(&owner)
                .await
                .expect("read committed SQLite transaction state");
            assert!(!state.in_transaction);

            let observer = SqliteDriver::connect(
                "sqlite-transaction-commit-observer-test".to_string(),
                profile(&path.to_string_lossy(), true),
            )
            .await
            .expect("connect SQLite observer after commit");
            let observer_result = observer
                .browse_table_data(&table, 1, 10, &TableBrowseQuery::default())
                .await
                .expect("observer browses committed SQLite rows");
            assert_eq!(
                observer_result
                    .rows
                    .iter()
                    .map(|row| row[query_column_index(&observer_result, "id")].clone())
                    .collect::<Vec<_>>(),
                vec![json!(1), json!(3), json!(4)]
            );
            let updated = query_row_by_id(&observer_result, 1);
            assert_eq!(
                updated[query_column_index(&observer_result, "name")],
                json!("Ada Lovelace")
            );
            assert_eq!(
                updated[query_column_index(&observer_result, "name_upper")],
                json!("ADA LOVELACE")
            );

            observer
                .close()
                .await
                .expect("close SQLite commit observer");
            owner.close().await.expect("close SQLite commit owner");
            let _ = std::fs::remove_file(path);
        });
    }

    #[test]
    fn sqlite_commit_failure_keeps_session_active_for_retry() {
        run_async(async {
            let path = temp_sqlite_path("transaction_commit_retry");
            create_read_data_fixture(&path).await;
            let database = SqliteDriver::database_name_from_path(&path.to_string_lossy());
            let table = users_table(&database);
            let owner = SqliteDriver::connect(
                "sqlite-transaction-commit-retry-test".to_string(),
                profile(&path.to_string_lossy(), false),
            )
            .await
            .expect("connect writable SQLite commit-retry fixture");

            TransactionManager::begin_transaction(&owner, &table)
                .await
                .expect("begin SQLite commit-retry transaction");
            owner
                .commit_table_change_set(
                    &table,
                    &TableChangeSetRequest {
                        inserts: vec![insert_user(4, "Marie")],
                        updates: Vec::new(),
                        deletes: Vec::new(),
                    },
                )
                .await
                .expect("save SQLite row before blocked commit");

            let blocker_options = SqliteConnectOptions::new()
                .filename(&path)
                .read_only(true)
                .create_if_missing(false)
                .foreign_keys(true);
            let blocker_pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(blocker_options)
                .await
                .expect("connect SQLite commit blocker");
            let mut blocker_connection = blocker_pool
                .acquire()
                .await
                .expect("acquire SQLite commit blocker connection");
            (&mut *blocker_connection)
                .execute("BEGIN")
                .await
                .expect("begin SQLite blocker read transaction");
            let committed_row_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
                .fetch_one(&mut *blocker_connection)
                .await
                .expect("hold SQLite read lock before owner commit");
            assert_eq!(committed_row_count, 3);

            TransactionManager::commit_transaction(&owner)
                .await
                .expect_err("SQLite commit should fail while another reader holds a shared lock");
            let active_after_failure = TransactionManager::transaction_state(&owner)
                .await
                .expect("read SQLite state after blocked commit");
            assert!(active_after_failure.in_transaction);
            assert_eq!(
                active_after_failure.database.as_deref(),
                Some(database.as_str())
            );

            (&mut *blocker_connection)
                .execute("ROLLBACK")
                .await
                .expect("release SQLite commit blocker");
            drop(blocker_connection);
            blocker_pool.close().await;

            let committed = TransactionManager::commit_transaction(&owner)
                .await
                .expect("retry SQLite commit after releasing reader lock");
            assert!(!committed.in_transaction);

            let observer = SqliteDriver::connect(
                "sqlite-transaction-commit-retry-observer-test".to_string(),
                profile(&path.to_string_lossy(), true),
            )
            .await
            .expect("connect SQLite observer after retried commit");
            let observer_result = observer
                .browse_table_data(&table, 1, 10, &TableBrowseQuery::default())
                .await
                .expect("browse SQLite rows after retried commit");
            assert_eq!(observer_result.rows.len(), 4);
            assert_eq!(
                query_row_by_id(&observer_result, 4)[query_column_index(&observer_result, "name")],
                json!("Marie")
            );

            observer
                .close()
                .await
                .expect("close SQLite commit-retry observer");
            owner
                .close()
                .await
                .expect("close SQLite commit-retry owner");
            let _ = std::fs::remove_file(path);
        });
    }

    #[test]
    fn sqlite_transaction_keeps_session_active_after_change_set_failure() {
        run_async(async {
            let path = temp_sqlite_path("transaction_failed_change_set");
            create_read_data_fixture(&path).await;
            let database = SqliteDriver::database_name_from_path(&path.to_string_lossy());
            let table = users_table(&database);
            let owner = SqliteDriver::connect(
                "sqlite-transaction-failed-change-set-test".to_string(),
                profile(&path.to_string_lossy(), false),
            )
            .await
            .expect("connect writable SQLite failed-change-set fixture");

            TransactionManager::begin_transaction(&owner, &table)
                .await
                .expect("begin SQLite failed-change-set transaction");
            let save_error = owner
                .commit_table_change_set(
                    &table,
                    &TableChangeSetRequest {
                        inserts: vec![insert_user(4, "Marie"), insert_user(1, "Duplicate")],
                        updates: Vec::new(),
                        deletes: Vec::new(),
                    },
                )
                .await
                .expect_err("duplicate SQLite insert must fail inside transaction");
            assert!(
                save_error.message.contains("UNIQUE")
                    || save_error.message.contains("constraint")
                    || save_error
                        .details
                        .as_deref()
                        .map(|details| details.contains("UNIQUE"))
                        .unwrap_or(false)
            );

            let active = TransactionManager::transaction_state(&owner)
                .await
                .expect("read SQLite state after failed change set");
            assert!(active.in_transaction);
            let owner_result = owner
                .browse_table_data(&table, 1, 10, &TableBrowseQuery::default())
                .await
                .expect("owner browses partial uncommitted SQLite change set");
            assert_eq!(owner_result.rows.len(), 4);
            assert_eq!(
                query_row_by_id(&owner_result, 4)[query_column_index(&owner_result, "name")],
                json!("Marie")
            );

            TransactionManager::rollback_transaction(&owner)
                .await
                .expect("roll back failed SQLite change set");
            let observer = SqliteDriver::connect(
                "sqlite-transaction-failed-change-set-observer-test".to_string(),
                profile(&path.to_string_lossy(), true),
            )
            .await
            .expect("connect observer after failed SQLite change set rollback");
            let observer_result = observer
                .browse_table_data(&table, 1, 10, &TableBrowseQuery::default())
                .await
                .expect("observer browses SQLite rows after failed change set rollback");
            assert_eq!(observer_result.rows.len(), 3);
            assert!(observer_result
                .rows
                .iter()
                .all(|row| row[query_column_index(&observer_result, "id")] != json!(4)));

            observer
                .close()
                .await
                .expect("close failed-change-set observer");
            owner.close().await.expect("close failed-change-set owner");
            let _ = std::fs::remove_file(path);
        });
    }

    #[test]
    fn sqlite_close_rolls_back_active_transaction() {
        run_async(async {
            let path = temp_sqlite_path("transaction_close_rollback");
            create_read_data_fixture(&path).await;
            let database = SqliteDriver::database_name_from_path(&path.to_string_lossy());
            let table = users_table(&database);
            let owner = SqliteDriver::connect(
                "sqlite-transaction-close-test".to_string(),
                profile(&path.to_string_lossy(), false),
            )
            .await
            .expect("connect writable SQLite close-rollback fixture");

            TransactionManager::begin_transaction(&owner, &table)
                .await
                .expect("begin SQLite close-rollback transaction");
            owner
                .commit_table_change_set(
                    &table,
                    &TableChangeSetRequest {
                        inserts: vec![insert_user(4, "Marie")],
                        updates: Vec::new(),
                        deletes: Vec::new(),
                    },
                )
                .await
                .expect("save SQLite row before close rollback");
            owner
                .close()
                .await
                .expect("close SQLite driver with active transaction");

            let observer = SqliteDriver::connect(
                "sqlite-transaction-close-observer-test".to_string(),
                profile(&path.to_string_lossy(), true),
            )
            .await
            .expect("reconnect after SQLite close rollback");
            let observer_result = observer
                .browse_table_data(&table, 1, 10, &TableBrowseQuery::default())
                .await
                .expect("browse SQLite rows after close rollback");
            assert_eq!(observer_result.rows.len(), 3);
            assert!(observer_result
                .rows
                .iter()
                .all(|row| row[query_column_index(&observer_result, "id")] != json!(4)));

            observer
                .close()
                .await
                .expect("close SQLite close-rollback observer");
            let _ = std::fs::remove_file(path);
        });
    }

    #[test]
    fn sqlite_transaction_begin_rejects_unsafe_resources() {
        run_async(async {
            let path = temp_sqlite_path("transaction_begin_guards");
            create_read_data_fixture(&path).await;
            let database = SqliteDriver::database_name_from_path(&path.to_string_lossy());
            let table = users_table(&database);
            let read_only_driver = SqliteDriver::connect(
                "sqlite-transaction-read-only-guard-test".to_string(),
                profile(&path.to_string_lossy(), true),
            )
            .await
            .expect("connect read-only SQLite transaction guard fixture");
            let read_only_error = TransactionManager::begin_transaction(&read_only_driver, &table)
                .await
                .expect_err("read-only SQLite profile must reject transaction begin");
            assert!(read_only_error.message.contains("read-only"));
            read_only_driver
                .close()
                .await
                .expect("close read-only SQLite transaction guard fixture");

            let driver = SqliteDriver::connect(
                "sqlite-transaction-resource-guards-test".to_string(),
                profile(&path.to_string_lossy(), false),
            )
            .await
            .expect("connect writable SQLite transaction guard fixture");
            let view = ContainerRef::table(
                ContainerKind::View,
                database.clone(),
                None,
                "active_users".to_string(),
            );
            let view_error = TransactionManager::begin_transaction(&driver, &view)
                .await
                .expect_err("SQLite view must reject transaction begin");
            assert!(view_error.message.contains("真实表"));

            let no_pk_table = ContainerRef::table(
                ContainerKind::Table,
                database.clone(),
                None,
                "notes_without_pk".to_string(),
            );
            let no_pk_error = TransactionManager::begin_transaction(&driver, &no_pk_table)
                .await
                .expect_err("SQLite table without primary key must reject transaction begin");
            assert!(no_pk_error.message.contains("没有显式主键"));

            let binary_key_table = ContainerRef::table(
                ContainerKind::Table,
                database.clone(),
                None,
                "binary_keys".to_string(),
            );
            let binary_key_error =
                TransactionManager::begin_transaction(&driver, &binary_key_table)
                    .await
                    .expect_err("SQLite binary-primary-key table must reject transaction begin");
            assert!(binary_key_error.message.contains("二进制主键"));

            let wrong_database_table = users_table("other.sqlite3");
            let wrong_database_error =
                TransactionManager::begin_transaction(&driver, &wrong_database_table)
                    .await
                    .expect_err("wrong SQLite file context must reject transaction begin");
            assert!(wrong_database_error.message.contains("其他 SQLite 文件"));

            driver
                .close()
                .await
                .expect("close SQLite transaction guard fixture");
            let _ = std::fs::remove_file(path);
        });
    }

    #[test]
    fn sqlite_profile_requires_file_path() {
        let error = SqliteDriver::validate_profile(&profile("   ", true))
            .expect_err("empty SQLite file path should be rejected");

        assert_eq!(error.message, "请填写 SQLite 数据库文件路径");
    }

    #[test]
    fn sqlite_profile_requires_existing_file() {
        let error = SqliteDriver::validate_profile(&profile(
            "Z:/nexpilot/does-not-exist/app.sqlite3",
            true,
        ))
        .expect_err("missing SQLite file should be rejected");

        assert!(error.message.contains("does not exist"));
    }
}
