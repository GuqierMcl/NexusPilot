mod connect;
mod ddl;
mod dml;
mod metadata;
mod query;
mod schema;
mod table_meta;
mod value;

use std::time::Instant;

use async_trait::async_trait;
use tokio::sync::Mutex;

use crate::engine::diagnostics;
use crate::engine::driver::{
    DataTableBrowser, DatabaseDriver, SchemaBrowser, SchemaMutator, SqlExecutor, TransactionManager,
};
use crate::engine::drivers::common::{
    table_browse_sql_plan, TableBrowseBindValue, TableBrowsePlaceholderStyle,
};
use crate::engine::profiles::OracleProfile;
use crate::engine::ssh_tunnel::SshTunnelRuntime;
use crate::engine::types::{
    ColumnMeta, ContainerKind, ContainerRef, CreateDatabaseInput, CreateDatabaseResult,
    CreateTableInput, CreateTableResult, DataContainer, DriverCapabilities, DropDatabaseInput,
    DropDatabaseResult, DropTableInput, DropTableResult, PingResult, QueryResult,
    SchemaMutationFeatures, SchemaMutationPreview, SqlExecutionContext, TableBrowseQuery,
    TableCellChange, TableChangeOutcome, TableChangeSetCommitResult, TableChangeSetPreview,
    TableChangeSetRequest, TableChangeSetUpdate, TableMutationResult, TablePageStats, TableRowKey,
    TableRowLocator, TableSchema, TableTransactionState, UpdateDatabaseInput, UpdateDatabaseResult,
    UpdateTableInput, UpdateTableResult,
};
use crate::error::{IpcError, IpcResult};

pub struct OracleDriver {
    profile_id: String,
    profile: OracleProfile,
    pool: deadpool_oracle::Pool,
    transaction: Mutex<Option<OracleTransactionSession>>,
    _tunnel: Option<SshTunnelRuntime>,
}

fn oracle_table_query_bind_value(value: &TableBrowseBindValue) -> oracle_rs::Value {
    match value {
        TableBrowseBindValue::String(value) => oracle_rs::Value::String(value.clone()),
        TableBrowseBindValue::Integer(value) => oracle_rs::Value::Integer(*value),
        TableBrowseBindValue::Float(value) => oracle_rs::Value::Float(*value),
        TableBrowseBindValue::Boolean(value) => oracle_rs::Value::Boolean(*value),
    }
}

struct OracleTransactionSession {
    database: String,
    connection: deadpool_oracle::Object,
}

pub(crate) fn quote_oracle_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

impl OracleDriver {
    pub async fn connect(profile_id: String, profile: OracleProfile) -> IpcResult<Self> {
        let runtime = connect::connect_oracle_pool(&profile).await?;
        Ok(Self {
            profile_id,
            profile,
            pool: runtime.pool,
            transaction: Mutex::new(None),
            _tunnel: runtime.tunnel,
        })
    }

    pub(crate) async fn connection(&self) -> IpcResult<deadpool_oracle::Object> {
        self.pool
            .get()
            .await
            .map_err(connect::classify_oracle_pool_error)
    }

    async fn load_table_columns_meta(
        &self,
        schema: &str,
        table: &str,
    ) -> IpcResult<Vec<ColumnMeta>> {
        let connection = self.connection().await?;
        let columns_result = self
            .query_table_metadata(
                &connection,
                "oracle_load_table_columns_base_meta",
                schema,
                table,
                table_meta::oracle_table_columns_metadata_sql(),
            )
            .await?;
        let mut columns = columns_result
            .rows
            .iter()
            .filter_map(table_meta::table_column_metadata_from_row)
            .collect::<Vec<_>>();

        let primary_key_result = self
            .query_table_metadata(
                &connection,
                "oracle_load_table_primary_key_meta",
                schema,
                table,
                table_meta::oracle_primary_key_columns_metadata_sql(),
            )
            .await?;
        table_meta::apply_primary_key_metadata(
            &mut columns,
            primary_key_result
                .rows
                .iter()
                .filter_map(table_meta::primary_key_column_from_row),
        );

        let unique_result = self
            .query_table_metadata(
                &connection,
                "oracle_load_table_unique_column_meta",
                schema,
                table,
                table_meta::oracle_unique_columns_metadata_sql(),
            )
            .await?;
        table_meta::apply_unique_column_metadata(
            &mut columns,
            unique_result
                .rows
                .iter()
                .filter_map(table_meta::unique_column_name_from_row),
        );

        Ok(columns
            .iter()
            .map(table_meta::column_meta_from_oracle_table_column)
            .collect())
    }

    async fn describe_oracle_table_schema(
        &self,
        container: &crate::engine::types::ContainerRef,
    ) -> IpcResult<TableSchema> {
        let (database, owner, table) = schema::oracle_describe_table_parts(container)?;
        let connection = self.connection().await?;

        let columns_result = self
            .query_table_metadata(
                &connection,
                "oracle_describe_table_columns",
                &owner,
                &table,
                schema::oracle_table_design_columns_sql(),
            )
            .await?;
        let columns = schema::oracle_columns_from_rows(&columns_result.rows);
        if columns.is_empty() {
            return Err(IpcError::resource_not_found(format!(
                "Oracle table '{}.{}' was not found",
                owner, table
            )));
        }

        let constraints_result = self
            .query_table_metadata(
                &connection,
                "oracle_describe_table_constraints",
                &owner,
                &table,
                schema::oracle_table_design_constraints_sql(),
            )
            .await?;
        let indexes_result = self
            .query_table_metadata(
                &connection,
                "oracle_describe_table_indexes",
                &owner,
                &table,
                schema::oracle_table_design_indexes_sql(),
            )
            .await?;
        let comments_result = self
            .query_table_metadata(
                &connection,
                "oracle_describe_table_comments",
                &owner,
                &table,
                schema::oracle_table_design_comments_sql(),
            )
            .await?;
        let comments = schema::oracle_comments_from_rows(&comments_result.rows);

        Ok(schema::table_schema_from_oracle_metadata(
            schema::OracleTableDesignMetadata {
                database,
                owner,
                table,
                table_comment: comments.table_comment,
                columns,
                indexes: schema::oracle_indexes_from_rows(&indexes_result.rows),
                constraints: schema::oracle_constraints_from_rows(&constraints_result.rows),
                partition_description: comments.partition_description,
            },
        ))
    }

    async fn query_table_metadata(
        &self,
        connection: &deadpool_oracle::Object,
        operation: &str,
        schema: &str,
        table: &str,
        sql: &str,
    ) -> IpcResult<oracle_rs::QueryResult> {
        match connection
            .query(
                sql,
                &[
                    oracle_rs::Value::String(schema.to_string()),
                    oracle_rs::Value::String(table.to_string()),
                ],
            )
            .await
            .map_err(connect::classify_oracle_query_error)
        {
            Ok(result) => Ok(result),
            Err(error) => {
                tauri_plugin_log::log::error!(
                    target: "nexpilot::engine::oracle",
                    "operation={} profile_id={} schema={} table={} sql=\"{}\" code={:?} message={} details={}",
                    operation,
                    self.profile_id,
                    diagnostics::truncate_for_log(schema),
                    diagnostics::truncate_for_log(table),
                    diagnostics::truncate_for_log(sql),
                    error.code,
                    diagnostics::truncate_for_log(&error.message),
                    error
                        .details
                        .as_deref()
                        .map(diagnostics::truncate_for_log)
                        .unwrap_or_else(|| "none".to_string())
                );
                Err(error)
            }
        }
    }

    async fn execute_oracle_dml_batch(
        &self,
        connection: &deadpool_oracle::Object,
        statements: &[dml::OracleDmlStatement],
        in_existing_transaction: bool,
    ) -> IpcResult<u64> {
        let mut affected_rows = 0;

        for statement in statements {
            let rows = match connection
                .execute(&statement.sql, &[])
                .await
                .map_err(connect::classify_oracle_query_error)
            {
                Ok(result) => result.rows_affected,
                Err(error) => {
                    tauri_plugin_log::log::error!(
                        target: "nexpilot::engine::oracle",
                        "operation=oracle_dml_execute profile_id={} in_existing_transaction={} expected_rows={:?} sql=\"{}\" code={:?} message={} details={}",
                        self.profile_id,
                        in_existing_transaction,
                        statement.expected_rows,
                        diagnostics::truncate_for_log(&statement.sql),
                        error.code,
                        diagnostics::truncate_for_log(&error.message),
                        error
                            .details
                            .as_deref()
                            .map(diagnostics::truncate_for_log)
                            .unwrap_or_else(|| "none".to_string())
                    );
                    if !in_existing_transaction {
                        if let Err(rollback_error) = connection.rollback().await {
                            let rollback_error =
                                connect::classify_oracle_query_error(rollback_error);
                            tauri_plugin_log::log::warn!(
                                target: "nexpilot::engine::oracle",
                                "operation=oracle_dml_rollback_after_failure profile_id={} sql=\"{}\" code={:?} message={} details={}",
                                self.profile_id,
                                diagnostics::truncate_for_log(&statement.sql),
                                rollback_error.code,
                                diagnostics::truncate_for_log(&rollback_error.message),
                                rollback_error
                                    .details
                                    .as_deref()
                                    .map(diagnostics::truncate_for_log)
                                    .unwrap_or_else(|| "none".to_string())
                            );
                        }
                    }
                    return Err(error);
                }
            };

            if let Some(expected) = statement.expected_rows {
                let validation_error = if expected == 1 && rows > 1 {
                    Some(IpcError::system_internal(
                        "更新影响了多行，已拒绝该结果",
                        "Oracle DML statement affected more than one row",
                    ))
                } else if expected == 1 && rows == 0 {
                    Some(IpcError::resource_conflict(
                        "远端行可能已变化或被删除，请刷新后重试",
                    ))
                } else if rows > expected {
                    Some(IpcError::system_internal(
                        "删除影响的行数超过请求行数，已拒绝该结果",
                        "Oracle delete affected more rows than requested",
                    ))
                } else {
                    None
                };

                if let Some(error) = validation_error {
                    if !in_existing_transaction {
                        if let Err(rollback_error) = connection.rollback().await {
                            let rollback_error =
                                connect::classify_oracle_query_error(rollback_error);
                            tauri_plugin_log::log::warn!(
                                target: "nexpilot::engine::oracle",
                                "operation=oracle_dml_rollback_after_validation_failure profile_id={} sql=\"{}\" rows={} expected_rows={:?} code={:?} message={} details={}",
                                self.profile_id,
                                diagnostics::truncate_for_log(&statement.sql),
                                rows,
                                statement.expected_rows,
                                rollback_error.code,
                                diagnostics::truncate_for_log(&rollback_error.message),
                                rollback_error
                                    .details
                                    .as_deref()
                                    .map(diagnostics::truncate_for_log)
                                    .unwrap_or_else(|| "none".to_string())
                            );
                        }
                    }
                    return Err(error);
                }
            }

            affected_rows += rows;
        }

        if !in_existing_transaction {
            if let Err(error) = connection.commit().await {
                let error = connect::classify_oracle_query_error(error);
                tauri_plugin_log::log::error!(
                    target: "nexpilot::engine::oracle",
                    "operation=oracle_dml_commit profile_id={} statements={} code={:?} message={} details={}",
                    self.profile_id,
                    statements.len(),
                    error.code,
                    diagnostics::truncate_for_log(&error.message),
                    error
                        .details
                        .as_deref()
                        .map(diagnostics::truncate_for_log)
                        .unwrap_or_else(|| "none".to_string())
                );
                return Err(error);
            }
        }

        Ok(affected_rows)
    }

    async fn execute_oracle_ddl_batch(
        &self,
        connection: &deadpool_oracle::Object,
        operation: &str,
        statements: &[String],
    ) -> IpcResult<()> {
        for statement in statements {
            if let Err(error) = connection.execute(statement, &[]).await {
                let error = connect::classify_oracle_query_error(error);
                tauri_plugin_log::log::error!(
                    target: "nexpilot::engine::oracle",
                    "operation={} profile_id={} sql=\"{}\" code={:?} message={} details={}",
                    operation,
                    self.profile_id,
                    diagnostics::truncate_for_log(statement),
                    error.code,
                    diagnostics::truncate_for_log(&error.message),
                    error
                        .details
                        .as_deref()
                        .map(diagnostics::truncate_for_log)
                        .unwrap_or_else(|| "none".to_string())
                );
                if let Err(rollback_error) = connection.rollback().await {
                    let rollback_error = connect::classify_oracle_query_error(rollback_error);
                    tauri_plugin_log::log::warn!(
                        target: "nexpilot::engine::oracle",
                        "operation={}_rollback_after_failure profile_id={} sql=\"{}\" code={:?} message={} details={}",
                        operation,
                        self.profile_id,
                        diagnostics::truncate_for_log(statement),
                        rollback_error.code,
                        diagnostics::truncate_for_log(&rollback_error.message),
                        rollback_error
                            .details
                            .as_deref()
                            .map(diagnostics::truncate_for_log)
                            .unwrap_or_else(|| "none".to_string())
                    );
                }
                return Err(error);
            }
        }

        if let Err(error) = connection.commit().await {
            let error = connect::classify_oracle_query_error(error);
            tauri_plugin_log::log::error!(
                target: "nexpilot::engine::oracle",
                "operation={}_commit profile_id={} statements={} code={:?} message={} details={}",
                operation,
                self.profile_id,
                statements.len(),
                error.code,
                diagnostics::truncate_for_log(&error.message),
                error
                    .details
                    .as_deref()
                    .map(diagnostics::truncate_for_log)
                    .unwrap_or_else(|| "none".to_string())
            );
            return Err(error);
        }

        Ok(())
    }

    fn phase_three_capabilities() -> DriverCapabilities {
        DriverCapabilities {
            schema_browser: true,
            schema_mutator: true,
            schema_mutation: Some(SchemaMutationFeatures::relational_table_only()),
            data_table_browser: true,
            sql_executor: true,
            table_row_mutator: true,
            table_row_inserter: true,
            transaction_manager: true,
            ..DriverCapabilities::default()
        }
    }

    fn transaction_state_from_session(
        session: Option<&OracleTransactionSession>,
    ) -> TableTransactionState {
        TableTransactionState {
            in_transaction: session.is_some(),
            database: session.map(|session| session.database.clone()),
        }
    }

    fn ensure_transaction_database(session_database: &str, database: &str) -> IpcResult<()> {
        if session_database == database {
            return Ok(());
        }

        Err(IpcError::system_internal(
            "当前事务属于另一个 Oracle 连接上下文，请提交或回滚后重试",
            "Oracle transaction database context mismatch",
        ))
    }

    async fn rollback_active_transaction(&self) -> IpcResult<()> {
        let mut transaction = self.transaction.lock().await;
        let Some(session) = transaction.take() else {
            return Ok(());
        };

        let _ = session.connection.rollback().await;
        Ok(())
    }

    fn database_label(&self) -> String {
        self.profile
            .connect_descriptor
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                self.profile
                    .service_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            })
            .or_else(|| {
                self.profile
                    .sid
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            })
            .unwrap_or("oracle")
            .to_string()
    }

    fn ensure_sql_execution_database(
        expected_database: &str,
        context: &SqlExecutionContext,
    ) -> IpcResult<()> {
        let Some(requested_database) = context
            .database
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return Ok(());
        };
        if requested_database == expected_database {
            return Ok(());
        }
        Err(IpcError::validation_failed(
            "Oracle SQL target does not match the connected database service",
        ))
    }

    fn query_result_from_oracle_browse_result(
        mut result: oracle_rs::QueryResult,
        columns: Vec<ColumnMeta>,
        source_writable: bool,
        source_insertable: bool,
        primary_key_columns: Vec<String>,
        stable_order_columns: Vec<String>,
        page_size: u32,
    ) -> QueryResult {
        let has_next_page = result.rows.len() > page_size as usize;
        if has_next_page {
            result.rows.truncate(page_size as usize);
        }

        let rows = result
            .rows
            .iter()
            .map(|row| value::row_to_json_values(row, &result.columns))
            .collect::<Vec<_>>();

        QueryResult {
            columns,
            rows,
            affected_rows: None,
            has_next_page,
            source_writable,
            source_insertable,
            primary_key_columns,
            stable_order_columns,
            row_locator_strategy: source_writable
                .then_some(crate::engine::types::TableRowLocatorStrategy::PrimaryKey),
        }
    }

    fn read_only_query_result_from_oracle_result(
        result: oracle_rs::QueryResult,
        page_size: u32,
    ) -> QueryResult {
        let columns = result
            .columns
            .iter()
            .map(value::column_meta_from_oracle)
            .collect::<Vec<_>>();
        Self::query_result_from_oracle_browse_result(
            result,
            columns,
            false,
            false,
            Vec::new(),
            Vec::new(),
            page_size,
        )
    }

    async fn sql_editor_query_result_from_oracle_result(
        connection: &oracle_rs::Connection,
        mut result: oracle_rs::QueryResult,
        page: u32,
        page_size: u32,
    ) -> IpcResult<QueryResult> {
        let page_size = page_size.max(1);
        let page_size_usize = page_size as usize;
        let offset = (page.saturating_sub(1) as usize).saturating_mul(page_size_usize);
        let target_len = offset.saturating_add(page_size_usize).saturating_add(1);

        while result.rows.len() < target_len && result.has_more_rows && result.cursor_id > 0 {
            let fetch_size = (target_len - result.rows.len()).min(u32::MAX as usize) as u32;
            let next = connection
                .fetch_more(result.cursor_id, &result.columns, fetch_size)
                .await
                .map_err(connect::classify_oracle_query_error)?;
            result.rows.extend(next.rows);
            result.has_more_rows = next.has_more_rows;
            result.cursor_id = next.cursor_id;
        }

        let page_end = offset.saturating_add(page_size_usize);
        let has_next_page = result.rows.len() > page_end || result.has_more_rows;
        result.rows = if offset >= result.rows.len() {
            Vec::new()
        } else {
            result.rows[offset..result.rows.len().min(page_end)].to_vec()
        };

        let columns = result
            .columns
            .iter()
            .map(value::column_meta_from_oracle)
            .collect::<Vec<_>>();
        let rows = result
            .rows
            .iter()
            .map(|row| value::row_to_json_values(row, &result.columns))
            .collect::<Vec<_>>();

        Ok(QueryResult {
            columns,
            rows,
            affected_rows: None,
            has_next_page,
            source_writable: false,
            source_insertable: false,
            primary_key_columns: Vec::new(),
            stable_order_columns: Vec::new(),
            row_locator_strategy: None,
        })
    }

    async fn query_table_data_sql(
        &self,
        container: &crate::engine::types::ContainerRef,
        sql: &str,
        bindings: &[TableBrowseBindValue],
    ) -> IpcResult<oracle_rs::QueryResult> {
        let database = container.database.as_deref().unwrap_or("oracle");
        let bindings = bindings
            .iter()
            .map(oracle_table_query_bind_value)
            .collect::<Vec<_>>();
        let mut transaction = self.transaction.lock().await;
        if let Some(session) = transaction.as_mut() {
            Self::ensure_transaction_database(&session.database, database)?;
            return session
                .connection
                .query(sql, &bindings)
                .await
                .map_err(connect::classify_oracle_query_error);
        }

        drop(transaction);
        let connection = self.connection().await?;
        connection
            .query(sql, &bindings)
            .await
            .map_err(connect::classify_oracle_query_error)
    }

    async fn browse_table_data_read_only(
        &self,
        container: &crate::engine::types::ContainerRef,
        page: u32,
        page_size: u32,
    ) -> IpcResult<QueryResult> {
        let table = self.qualified_table_name(container)?;
        let offset = page.saturating_sub(1) as u64 * page_size as u64;
        let limit = page_size as u64 + 1;
        let sql = query::table_browse_sql(&table, &[], &[], "", "", offset, limit);
        let result = self.query_table_data_sql(container, &sql, &[]).await?;
        Ok(Self::read_only_query_result_from_oracle_result(
            result, page_size,
        ))
    }

    fn ensure_single_sql_statement_for_editor(sql: &str) -> IpcResult<()> {
        if sql.trim().is_empty() {
            return Err(IpcError::validation_failed("SQL cannot be empty"));
        }
        if !crate::engine::drivers::common::sql_is_single_statement(sql) {
            return Err(IpcError::validation_failed(
                "一次只能执行一条 SQL 语句；请选择一条语句后重试，或分别执行多条语句",
            ));
        }
        Ok(())
    }
}

#[async_trait]
impl DatabaseDriver for OracleDriver {
    fn profile_id(&self) -> &str {
        &self.profile_id
    }

    fn driver_name(&self) -> &'static str {
        "oracle"
    }

    fn capabilities(&self) -> DriverCapabilities {
        Self::phase_three_capabilities()
    }

    async fn ping(&self) -> IpcResult<PingResult> {
        let start = Instant::now();
        let connection = self.connection().await?;
        connection
            .ping()
            .await
            .map_err(connect::classify_oracle_connection_error)?;
        Ok(PingResult {
            latency_ms: start.elapsed().as_millis() as u64,
        })
    }

    async fn close(&self) -> IpcResult<()> {
        self.rollback_active_transaction().await?;
        self.pool.close();
        Ok(())
    }

    async fn server_version(&self) -> IpcResult<Option<String>> {
        let connection = self.connection().await?;
        let info = connection.server_info().await;
        Ok([info.version, info.banner]
            .into_iter()
            .map(|value| value.trim().to_string())
            .find(|value| !value.is_empty()))
    }

    fn ssh_host_key_fingerprint(&self) -> Option<&str> {
        self._tunnel
            .as_ref()
            .and_then(|tunnel| tunnel.captured_host_key_fingerprint())
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
impl SchemaBrowser for OracleDriver {
    async fn list_containers(
        &self,
        parent: Option<&crate::engine::types::ContainerRef>,
    ) -> IpcResult<Vec<DataContainer>> {
        match parent.map(|container| &container.kind) {
            None => self.list_root_containers().await,
            Some(ContainerKind::Database) => {
                let fallback_database = self.database_label();
                let database = parent
                    .and_then(|container| container.database.as_deref())
                    .unwrap_or(fallback_database.as_str());
                self.list_schemas(database).await
            }
            Some(ContainerKind::Schema) => {
                let container = parent.expect("checked Some above");
                let database = container.database.as_deref().ok_or_else(|| {
                    IpcError::resource_not_found("Oracle database context is missing")
                })?;
                let schema = container.schema.as_deref().ok_or_else(|| {
                    IpcError::resource_not_found("Oracle schema context is missing")
                })?;
                Ok(metadata::schema_asset_groups(database, schema))
            }
            Some(ContainerKind::AssetGroup) => {
                let container = parent.expect("checked Some above");
                self.list_group_children(container).await
            }
            Some(ContainerKind::Table)
            | Some(ContainerKind::View)
            | Some(ContainerKind::MaterializedView) => {
                let container = parent.expect("checked Some above");
                self.list_table_child_groups(container)
            }
            _ => Ok(Vec::new()),
        }
    }

    async fn describe_table(
        &self,
        container: &crate::engine::types::ContainerRef,
    ) -> IpcResult<TableSchema> {
        self.describe_oracle_table_schema(container).await
    }
}

#[async_trait]
impl DataTableBrowser for OracleDriver {
    async fn browse_table_data(
        &self,
        container: &crate::engine::types::ContainerRef,
        page: u32,
        page_size: u32,
        query: &TableBrowseQuery,
    ) -> IpcResult<QueryResult> {
        let (schema, table_name) = self.table_parts(container)?;
        let columns = match self.load_table_columns_meta(&schema, &table_name).await {
            Ok(columns) if !columns.is_empty() => columns,
            Ok(_) | Err(_) if query.filters.is_empty() && query.sort.is_empty() => {
                return self
                    .browse_table_data_read_only(container, page, page_size)
                    .await;
            }
            Ok(_) => {
                return Err(IpcError::resource_not_found(
                    "Oracle table columns are unavailable for structured querying",
                ));
            }
            Err(error) => return Err(error),
        };
        let primary_key_columns =
            crate::engine::drivers::common::ordered_primary_key_columns(&columns);
        let stable_order_columns = if primary_key_columns.is_empty() {
            Vec::new()
        } else {
            primary_key_columns.clone()
        };
        let is_real_table = container.kind == ContainerKind::Table;
        let source_writable = is_real_table && !primary_key_columns.is_empty();
        let source_insertable = source_writable;
        let query_plan = table_browse_sql_plan(
            query,
            &columns,
            quote_oracle_identifier,
            TableBrowsePlaceholderStyle::ColonNumbered,
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

        let table = self.qualified_table_name(container)?;
        let offset = page.saturating_sub(1) as u64 * page_size as u64;
        let limit = page_size as u64 + 1;
        let select_columns = columns
            .iter()
            .map(|column| quote_oracle_identifier(&column.name))
            .collect::<Vec<_>>();
        let stable_order_column_refs = stable_order_columns
            .iter()
            .map(|column| quote_oracle_identifier(column))
            .collect::<Vec<_>>();
        let sql = query::table_browse_sql(
            &table,
            &select_columns,
            &stable_order_column_refs,
            &query_plan.where_clause,
            &query_plan.order_by_clause,
            offset,
            limit,
        );
        let result = match self
            .query_table_data_sql(container, &sql, &query_plan.bindings)
            .await
        {
            Ok(result) => result,
            Err(_) if query.filters.is_empty() && query.sort.is_empty() => {
                return self
                    .browse_table_data_read_only(container, page, page_size)
                    .await;
            }
            Err(error) => return Err(error),
        };

        Ok(Self::query_result_from_oracle_browse_result(
            result,
            columns,
            source_writable,
            source_insertable,
            primary_key_columns,
            stable_order_columns,
            page_size,
        ))
    }

    async fn get_table_page_stats(
        &self,
        container: &crate::engine::types::ContainerRef,
        page_size: u32,
        query: &TableBrowseQuery,
        requested_page: Option<u32>,
    ) -> IpcResult<TablePageStats> {
        let (schema, table_name) = self.table_parts(container)?;
        let columns = self.load_table_columns_meta(&schema, &table_name).await?;
        let query_plan = table_browse_sql_plan(
            query,
            &columns,
            quote_oracle_identifier,
            TableBrowsePlaceholderStyle::ColonNumbered,
        )?;
        let table = self.qualified_table_name(container)?;
        let sql = query::table_count_sql(&table, &query_plan.where_clause);
        let bindings = query_plan
            .bindings
            .iter()
            .map(oracle_table_query_bind_value)
            .collect::<Vec<_>>();
        let database = container.database.as_deref().unwrap_or("oracle");
        let mut transaction = self.transaction.lock().await;
        let result = if let Some(session) = transaction.as_mut() {
            Self::ensure_transaction_database(&session.database, database)?;
            session
                .connection
                .query(&sql, &bindings)
                .await
                .map_err(connect::classify_oracle_query_error)?
        } else {
            drop(transaction);
            let connection = self.connection().await?;
            connection
                .query(&sql, &bindings)
                .await
                .map_err(connect::classify_oracle_query_error)?
        };
        let total_rows = result
            .rows
            .first()
            .and_then(|row| row.get(0))
            .and_then(|value| value.as_i64())
            .map(|value| value.max(0) as u64)
            .unwrap_or(0);

        crate::engine::drivers::common::table_page_stats(total_rows, page_size, requested_page)
    }

    async fn update_table_row(
        &self,
        container: &crate::engine::types::ContainerRef,
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
        container: &crate::engine::types::ContainerRef,
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
        container: &crate::engine::types::ContainerRef,
        change_set: &TableChangeSetRequest,
    ) -> IpcResult<TableChangeSetPreview> {
        crate::engine::drivers::common::ensure_real_table_for_mutation(&container.kind)?;
        let (schema, table_name) = self.table_parts(container)?;
        let columns = self.load_table_columns_meta(&schema, &table_name).await?;
        let table = self.qualified_table_name(container)?;
        dml::preview_oracle_change_set(&table, &columns, change_set)
    }

    async fn commit_table_change_set(
        &self,
        container: &crate::engine::types::ContainerRef,
        change_set: &TableChangeSetRequest,
    ) -> IpcResult<TableChangeSetCommitResult> {
        let preview = self.preview_table_change_set(container, change_set).await?;
        let (schema, table_name) = self.table_parts(container)?;
        let columns = self.load_table_columns_meta(&schema, &table_name).await?;
        let table = self.qualified_table_name(container)?;
        let statements = dml::build_oracle_dml_statements(&table, &columns, change_set)?;

        let database = container.database.as_deref().unwrap_or("oracle");
        let mut transaction = self.transaction.lock().await;
        let affected_rows = if let Some(session) = transaction.as_mut() {
            Self::ensure_transaction_database(&session.database, database)?;
            self.execute_oracle_dml_batch(&session.connection, &statements, true)
                .await?
        } else {
            drop(transaction);
            let connection = self.connection().await?;
            self.execute_oracle_dml_batch(&connection, &statements, false)
                .await?
        };

        Ok(TableChangeSetCommitResult {
            affected_rows,
            preview,
            outcome: TableChangeOutcome::Applied,
        })
    }
}

#[async_trait]
impl SchemaMutator for OracleDriver {
    async fn preview_create_database(
        &self,
        _input: &CreateDatabaseInput,
    ) -> IpcResult<SchemaMutationPreview> {
        Err(IpcError::resource_not_found(
            "Oracle Table Designer does not support database or PDB creation",
        ))
    }

    async fn create_database(
        &self,
        _input: &CreateDatabaseInput,
    ) -> IpcResult<CreateDatabaseResult> {
        Err(IpcError::resource_not_found(
            "Oracle Table Designer does not support database or PDB creation",
        ))
    }

    async fn preview_update_database(
        &self,
        _input: &UpdateDatabaseInput,
    ) -> IpcResult<SchemaMutationPreview> {
        Err(IpcError::resource_not_found(
            "Oracle Table Designer does not support database or PDB mutation",
        ))
    }

    async fn update_database(
        &self,
        _input: &UpdateDatabaseInput,
    ) -> IpcResult<UpdateDatabaseResult> {
        Err(IpcError::resource_not_found(
            "Oracle Table Designer does not support database or PDB mutation",
        ))
    }

    async fn preview_drop_database(
        &self,
        _input: &DropDatabaseInput,
    ) -> IpcResult<SchemaMutationPreview> {
        Err(IpcError::resource_not_found(
            "Oracle Table Designer does not support database or PDB drop",
        ))
    }

    async fn drop_database(&self, _input: &DropDatabaseInput) -> IpcResult<DropDatabaseResult> {
        Err(IpcError::resource_not_found(
            "Oracle Table Designer does not support database or PDB drop",
        ))
    }

    async fn preview_create_table(
        &self,
        input: &CreateTableInput,
    ) -> IpcResult<SchemaMutationPreview> {
        Ok(SchemaMutationPreview::from_statements(
            ddl::oracle_create_table_statements(input)?,
        ))
    }

    async fn create_table(&self, input: &CreateTableInput) -> IpcResult<CreateTableResult> {
        let statements = ddl::oracle_create_table_statements(input)?;
        let (database, schema, table_name) =
            ddl::oracle_create_table_parts(input, &self.database_label())?;
        let connection = self.connection().await?;
        self.execute_oracle_ddl_batch(&connection, "oracle_create_table_execute", &statements)
            .await?;

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
        let (_, _, _, statements) =
            ddl::oracle_update_table_parts_and_statements(input, Some(&self.database_label()))?;
        let mut preview = SchemaMutationPreview::from_statements(statements);
        ddl::mark_oracle_table_update_preview(&mut preview);
        for baseline_column in &input.baseline.columns {
            let target_name = input
                .column_renames
                .iter()
                .find(|rename| rename.old_name == baseline_column.name)
                .map(|rename| rename.new_name.as_str())
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
        let current = self.describe_oracle_table_schema(&input.container).await?;
        if !schema::oracle_table_schema_matches_update_baseline(&current, &input.baseline) {
            return Err(IpcError::resource_conflict(
                "远端表结构已变化，请刷新后重试",
            ));
        }

        let (database, schema, table_name, statements) =
            ddl::oracle_update_table_parts_and_statements(input, Some(&self.database_label()))?;
        ddl::ensure_oracle_destructive_update_confirmed(input, &statements)?;
        let connection = self.connection().await?;
        self.execute_oracle_ddl_batch(&connection, "oracle_update_table_execute", &statements)
            .await?;

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
        let (_, _, _, statement) =
            ddl::oracle_drop_table_parts_and_statement(input, Some(&self.database_label()))?;
        let mut preview = SchemaMutationPreview::from_statements(vec![statement]);
        ddl::mark_oracle_drop_table_preview(&mut preview);
        Ok(preview)
    }

    async fn drop_table(&self, input: &DropTableInput) -> IpcResult<DropTableResult> {
        ddl::ensure_oracle_destructive_drop_table_confirmed(input)?;
        let (database, schema, table_name, statement) =
            ddl::oracle_drop_table_parts_and_statement(input, Some(&self.database_label()))?;
        let connection = self.connection().await?;
        self.execute_oracle_ddl_batch(&connection, "oracle_drop_table_execute", &[statement])
            .await?;

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
impl TransactionManager for OracleDriver {
    async fn begin_transaction(
        &self,
        container: &crate::engine::types::ContainerRef,
    ) -> IpcResult<TableTransactionState> {
        crate::engine::drivers::common::ensure_real_table_for_mutation(&container.kind)?;
        let database = container
            .database
            .as_deref()
            .unwrap_or("oracle")
            .to_string();
        let mut transaction = self.transaction.lock().await;
        if transaction.is_some() {
            return Err(IpcError::system_internal(
                "当前标签页已有活动事务",
                "transaction already active for this tab runtime",
            ));
        }

        let connection = self.connection().await?;
        *transaction = Some(OracleTransactionSession {
            database,
            connection,
        });
        Ok(Self::transaction_state_from_session(transaction.as_ref()))
    }

    async fn commit_transaction(&self) -> IpcResult<TableTransactionState> {
        let mut transaction = self.transaction.lock().await;
        let Some(session) = transaction.take() else {
            return Err(IpcError::system_internal(
                "当前标签页没有活动事务",
                "no active transaction for this tab runtime",
            ));
        };

        session
            .connection
            .commit()
            .await
            .map_err(connect::classify_oracle_query_error)?;
        Ok(Self::transaction_state_from_session(None))
    }

    async fn rollback_transaction(&self) -> IpcResult<TableTransactionState> {
        let mut transaction = self.transaction.lock().await;
        let Some(session) = transaction.take() else {
            return Err(IpcError::system_internal(
                "当前标签页没有活动事务",
                "no active transaction for this tab runtime",
            ));
        };

        session
            .connection
            .rollback()
            .await
            .map_err(connect::classify_oracle_query_error)?;
        Ok(Self::transaction_state_from_session(None))
    }

    async fn transaction_state(&self) -> IpcResult<TableTransactionState> {
        let transaction = self.transaction.lock().await;
        Ok(Self::transaction_state_from_session(transaction.as_ref()))
    }
}

#[async_trait]
impl SqlExecutor for OracleDriver {
    async fn execute_sql(
        &self,
        context: &SqlExecutionContext,
        sql: &str,
        page: u32,
        page_size: u32,
    ) -> IpcResult<QueryResult> {
        Self::ensure_single_sql_statement_for_editor(sql)?;
        let database_label = self.database_label();
        Self::ensure_sql_execution_database(&database_label, context)?;

        let connection = self.connection().await?;
        let schema_context = context
            .schema
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());

        if let Some(schema) = schema_context {
            let set_schema = query::current_schema_plsql(schema);
            if let Err(error) = connection.execute_plsql(&set_schema, &[]).await {
                let error = connect::classify_oracle_query_error(error);
                tauri_plugin_log::log::error!(
                    target: "nexpilot::engine::oracle",
                    "operation=oracle_sql_set_schema profile_id={} schema={} code={:?} message={} details={}",
                    self.profile_id,
                    diagnostics::truncate_for_log(schema),
                    error.code,
                    diagnostics::truncate_for_log(&error.message),
                    error
                        .details
                        .as_deref()
                        .map(diagnostics::truncate_for_log)
                        .unwrap_or_else(|| "none".to_string())
                );
                let _ = connection.close().await;
                return Err(error);
            }
        }

        let expects_rows = crate::engine::drivers::common::sql_should_fetch_rows(sql);
        let result = if expects_rows {
            connection.query(sql, &[]).await
        } else {
            connection.execute(sql, &[]).await
        };

        let result = match result {
            Ok(result) => result,
            Err(error) => {
                let error = connect::classify_oracle_query_error(error);
                tauri_plugin_log::log::error!(
                    target: "nexpilot::engine::oracle",
                    "operation=oracle_sql_execute profile_id={} schema_context={} expects_rows={} code={:?} message={} details={}",
                    self.profile_id,
                    schema_context.unwrap_or("none"),
                    expects_rows,
                    error.code,
                    diagnostics::truncate_for_log(&error.message),
                    error
                        .details
                        .as_deref()
                        .map(diagnostics::truncate_for_log)
                        .unwrap_or_else(|| "none".to_string())
                );
                let _ = connection.close().await;
                return Err(error);
            }
        };

        let query_result = if expects_rows {
            Self::sql_editor_query_result_from_oracle_result(&connection, result, page, page_size)
                .await?
        } else {
            let columns = result
                .columns
                .iter()
                .map(value::column_meta_from_oracle)
                .collect::<Vec<_>>();
            let rows = result
                .rows
                .iter()
                .map(|row| value::row_to_json_values(row, &result.columns))
                .collect::<Vec<_>>();
            let affected_rows =
                crate::engine::drivers::common::sql_should_report_affected_rows(sql)
                    .then_some(result.rows_affected);

            QueryResult {
                columns,
                rows,
                affected_rows,
                has_next_page: result.has_more_rows,
                source_writable: false,
                source_insertable: false,
                primary_key_columns: Vec::new(),
                stable_order_columns: Vec::new(),
                row_locator_strategy: None,
            }
        };
        let _ = connection.close().await;
        Ok(query_result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oracle_phase_three_capabilities_enable_schema_mutator_and_writable_datatable() {
        let capabilities = OracleDriver::phase_three_capabilities();

        assert!(capabilities.schema_browser);
        assert!(capabilities.schema_mutator);
        let schema_mutation = capabilities
            .schema_mutation
            .as_ref()
            .expect("Oracle schema mutation features should be declared");
        assert!(schema_mutation.supports(
            ContainerKind::Table,
            crate::engine::types::SchemaMutationOperation::Create,
        ));
        assert!(!schema_mutation.supports(
            ContainerKind::Database,
            crate::engine::types::SchemaMutationOperation::Create,
        ));
        assert!(capabilities.data_table_browser);
        assert!(capabilities.sql_executor);
        assert!(capabilities.table_row_mutator);
        assert!(capabilities.table_row_inserter);
        assert!(capabilities.transaction_manager);
        assert!(!capabilities.key_value_browser);
        assert!(!capabilities.graph_queryer);
        assert!(!capabilities.vector_searcher);
    }

    #[test]
    fn oracle_transaction_state_without_session_is_idle() {
        let state = OracleDriver::transaction_state_from_session(None);

        assert!(!state.in_transaction);
        assert_eq!(state.database, None);
    }

    #[test]
    fn oracle_read_only_browse_result_disables_phase_two_write_capabilities() {
        let result = oracle_rs::QueryResult {
            columns: vec![oracle_rs::ColumnInfo::new(
                "ID",
                oracle_rs::OracleType::Number,
            )],
            rows: vec![oracle_rs::Row::new(vec![oracle_rs::Value::Integer(42)])],
            rows_affected: 0,
            has_more_rows: false,
            cursor_id: 0,
        };

        let result = OracleDriver::read_only_query_result_from_oracle_result(result, 50);

        assert_eq!(result.columns.len(), 1);
        assert_eq!(result.rows, vec![vec![serde_json::json!("42")]]);
        assert!(!result.source_writable);
        assert!(!result.source_insertable);
        assert!(result.primary_key_columns.is_empty());
        assert!(result.stable_order_columns.is_empty());
    }

    #[test]
    fn rejects_empty_or_multi_statement_sql_editor_input() {
        assert!(OracleDriver::ensure_single_sql_statement_for_editor("   ").is_err());
        assert!(OracleDriver::ensure_single_sql_statement_for_editor(
            "SELECT 1 FROM DUAL; SELECT 2 FROM DUAL"
        )
        .is_err());
        assert!(
            OracleDriver::ensure_single_sql_statement_for_editor("SELECT ';' FROM DUAL").is_ok()
        );
    }

    #[test]
    fn oracle_sql_execution_requires_an_exact_database_target_when_supplied() {
        let matching = SqlExecutionContext {
            database: Some("FREEPDB1".to_string()),
            schema: Some("APP".to_string()),
        };
        assert!(OracleDriver::ensure_sql_execution_database("FREEPDB1", &matching).is_ok());

        let implicit = SqlExecutionContext {
            database: None,
            schema: Some("APP".to_string()),
        };
        assert!(OracleDriver::ensure_sql_execution_database("FREEPDB1", &implicit).is_ok());

        let mismatching = SqlExecutionContext {
            database: Some("OTHER".to_string()),
            schema: None,
        };
        let error = OracleDriver::ensure_sql_execution_database("FREEPDB1", &mismatching)
            .expect_err("a different Oracle target must fail before dispatch");
        assert_eq!(error.code, crate::error::ErrorCode::ValidationFailed);
    }
}
