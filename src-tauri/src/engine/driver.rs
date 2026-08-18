use async_trait::async_trait;

use crate::engine::native_schema::NativeSchemaExtension;
use crate::engine::sql_execution::{
    ManagedSqlCancelRequest, ManagedSqlExecutionRequest, SqlCancelConfirmation, SqlExecutionControl,
};
use crate::engine::types::{
    ConnectionRuntimeInfo, ContainerRef, CreateDatabaseInput, CreateDatabaseResult,
    CreateTableInput, CreateTableResult, DataContainer, DatabaseCharacterSet, DriverCapabilities,
    DropDatabaseInput, DropDatabaseResult, DropTableInput, DropTableResult, GraphQueryRequest,
    GraphQueryResult, PingResult, QueryResult, RedisCreateKeyValueRequest,
    RedisDeleteKeyPrefixRequest, RedisDeleteKeyRequest, RedisDeleteKeyResult,
    RedisKeyMutationResult, RedisKeyPrecondition, RedisKeyRef, RedisKeyTreeRequest,
    RedisKeyTreeResult, RedisKeyValue, RedisRenameKeyRequest, RedisScanRequest, RedisScanResult,
    RedisSetKeyTtlRequest, RedisSetKeyValueRequest, SchemaMutationPreview, SqlExecutionContext,
    SqlExecutionOutcome, SqlStatementClass, TableBrowseQuery, TableCellChange,
    TableChangeSetCommitResult, TableChangeSetPreview, TableChangeSetRequest, TableMutationResult,
    TablePageStats, TableRowKey, TableSchema, TableTransactionState, UpdateDatabaseInput,
    UpdateDatabaseResult, UpdateTableInput, UpdateTableResult, VectorSearchRequest,
    VectorSearchResponse,
};
use crate::error::{IpcError, IpcResult};

#[async_trait]
pub trait DatabaseDriver: Send + Sync {
    fn profile_id(&self) -> &str;
    fn driver_name(&self) -> &'static str;
    fn capabilities(&self) -> DriverCapabilities;

    async fn ping(&self) -> IpcResult<PingResult>;
    async fn close(&self) -> IpcResult<()>;

    async fn server_version(&self) -> IpcResult<Option<String>> {
        Ok(None)
    }

    fn ssh_host_key_fingerprint(&self) -> Option<&str> {
        None
    }

    fn as_schema_browser(&self) -> Option<&dyn SchemaBrowser> {
        None
    }

    fn as_schema_mutator(&self) -> Option<&dyn SchemaMutator> {
        None
    }

    fn as_native_schema_extension(&self) -> Option<&dyn NativeSchemaExtension> {
        None
    }

    fn as_data_table_browser(&self) -> Option<&dyn DataTableBrowser> {
        None
    }

    fn as_sql_executor(&self) -> Option<&dyn SqlExecutor> {
        None
    }

    #[allow(dead_code)]
    fn as_managed_sql_executor(&self) -> Option<&dyn ManagedSqlExecutor> {
        None
    }

    fn as_key_value_browser(&self) -> Option<&dyn KeyValueBrowser> {
        None
    }

    fn as_transaction_manager(&self) -> Option<&dyn TransactionManager> {
        None
    }

    #[allow(dead_code)]
    fn as_graph_queryer(&self) -> Option<&dyn GraphQueryer> {
        None
    }

    #[allow(dead_code)]
    fn as_vector_searcher(&self) -> Option<&dyn VectorSearcher> {
        None
    }
}

#[async_trait]
pub trait SchemaBrowser: Send + Sync {
    async fn list_containers(&self, parent: Option<&ContainerRef>)
        -> IpcResult<Vec<DataContainer>>;

    async fn describe_table(&self, _container: &ContainerRef) -> IpcResult<TableSchema> {
        Err(IpcError::feature_unavailable(
            "This connection does not support table schema description",
        ))
    }
}

#[async_trait]
pub trait SchemaMutator: Send + Sync {
    async fn preview_create_database(
        &self,
        input: &CreateDatabaseInput,
    ) -> IpcResult<SchemaMutationPreview>;

    async fn create_database(&self, input: &CreateDatabaseInput)
        -> IpcResult<CreateDatabaseResult>;

    async fn preview_update_database(
        &self,
        input: &UpdateDatabaseInput,
    ) -> IpcResult<SchemaMutationPreview>;

    async fn update_database(&self, input: &UpdateDatabaseInput)
        -> IpcResult<UpdateDatabaseResult>;

    async fn preview_drop_database(
        &self,
        input: &DropDatabaseInput,
    ) -> IpcResult<SchemaMutationPreview>;

    async fn drop_database(&self, input: &DropDatabaseInput) -> IpcResult<DropDatabaseResult>;

    async fn list_mysql_character_sets(&self) -> IpcResult<Vec<DatabaseCharacterSet>> {
        Err(IpcError::resource_not_found(
            "This connection does not support MySQL character sets",
        ))
    }

    async fn get_mysql_database_character_set(
        &self,
        _container: &ContainerRef,
    ) -> IpcResult<Option<String>> {
        Err(IpcError::resource_not_found(
            "This connection does not support MySQL database character set lookup",
        ))
    }

    async fn preview_create_table(
        &self,
        _input: &CreateTableInput,
    ) -> IpcResult<SchemaMutationPreview> {
        Err(IpcError::resource_not_found(
            "This connection does not support table creation preview",
        ))
    }

    async fn create_table(&self, _input: &CreateTableInput) -> IpcResult<CreateTableResult> {
        Err(IpcError::resource_not_found(
            "This connection does not support table creation",
        ))
    }

    async fn preview_update_table(
        &self,
        _input: &UpdateTableInput,
    ) -> IpcResult<SchemaMutationPreview> {
        Err(IpcError::resource_not_found(
            "This connection does not support table update preview",
        ))
    }

    async fn update_table(&self, _input: &UpdateTableInput) -> IpcResult<UpdateTableResult> {
        Err(IpcError::resource_not_found(
            "This connection does not support table update",
        ))
    }

    async fn preview_drop_table(
        &self,
        _input: &DropTableInput,
    ) -> IpcResult<SchemaMutationPreview> {
        Err(IpcError::resource_not_found(
            "This connection does not support table deletion preview",
        ))
    }

    async fn drop_table(&self, _input: &DropTableInput) -> IpcResult<DropTableResult> {
        Err(IpcError::resource_not_found(
            "This connection does not support table deletion",
        ))
    }
}

#[async_trait]
pub trait DataTableBrowser: Send + Sync {
    async fn browse_table_data(
        &self,
        container: &ContainerRef,
        page: u32,
        page_size: u32,
        query: &TableBrowseQuery,
    ) -> IpcResult<QueryResult>;

    async fn get_table_page_stats(
        &self,
        container: &ContainerRef,
        page_size: u32,
        query: &TableBrowseQuery,
        requested_page: Option<u32>,
    ) -> IpcResult<TablePageStats>;

    async fn update_table_row(
        &self,
        container: &ContainerRef,
        primary_key: &TableRowKey,
        changes: &[TableCellChange],
    ) -> IpcResult<TableMutationResult>;

    async fn delete_table_rows(
        &self,
        container: &ContainerRef,
        primary_keys: &[TableRowKey],
    ) -> IpcResult<TableMutationResult>;

    async fn preview_table_change_set(
        &self,
        container: &ContainerRef,
        change_set: &TableChangeSetRequest,
    ) -> IpcResult<TableChangeSetPreview>;

    async fn commit_table_change_set(
        &self,
        container: &ContainerRef,
        change_set: &TableChangeSetRequest,
    ) -> IpcResult<TableChangeSetCommitResult>;
}

#[async_trait]
pub trait SqlExecutor: Send + Sync {
    async fn execute_sql(
        &self,
        context: &SqlExecutionContext,
        sql: &str,
        page: u32,
        page_size: u32,
    ) -> IpcResult<QueryResult>;
}

#[allow(dead_code)]
#[async_trait]
pub trait ManagedSqlExecutor: Send + Sync {
    fn classify_statement(&self, _sql: &str) -> IpcResult<SqlStatementClass> {
        Ok(SqlStatementClass::Unknown)
    }

    async fn execute_managed_sql(
        &self,
        request: ManagedSqlExecutionRequest,
        control: SqlExecutionControl,
    ) -> IpcResult<SqlExecutionOutcome>;

    async fn cancel_managed_sql(
        &self,
        request: ManagedSqlCancelRequest,
    ) -> IpcResult<SqlCancelConfirmation>;
}

#[async_trait]
pub trait TransactionManager: Send + Sync {
    async fn begin_transaction(&self, container: &ContainerRef)
        -> IpcResult<TableTransactionState>;

    async fn commit_transaction(&self) -> IpcResult<TableTransactionState>;

    async fn rollback_transaction(&self) -> IpcResult<TableTransactionState>;

    async fn transaction_state(&self) -> IpcResult<TableTransactionState>;
}

#[async_trait]
pub trait KeyValueBrowser: Send + Sync {
    async fn scan_key_values(&self, request: &RedisScanRequest) -> IpcResult<RedisScanResult>;

    async fn browse_key_tree(&self, request: &RedisKeyTreeRequest)
        -> IpcResult<RedisKeyTreeResult>;

    async fn get_key_value(&self, key_ref: &RedisKeyRef) -> IpcResult<RedisKeyValue>;

    async fn get_key_precondition(&self, key_ref: &RedisKeyRef) -> IpcResult<RedisKeyPrecondition>;

    async fn set_key_value(
        &self,
        request: &RedisSetKeyValueRequest,
    ) -> IpcResult<RedisKeyMutationResult>;

    async fn create_key_value(
        &self,
        request: &RedisCreateKeyValueRequest,
    ) -> IpcResult<RedisKeyMutationResult>;

    async fn delete_key(&self, request: &RedisDeleteKeyRequest) -> IpcResult<RedisDeleteKeyResult>;

    async fn delete_key_prefix(
        &self,
        request: &RedisDeleteKeyPrefixRequest,
    ) -> IpcResult<RedisDeleteKeyResult>;

    async fn rename_key(
        &self,
        request: &RedisRenameKeyRequest,
    ) -> IpcResult<RedisKeyMutationResult>;

    async fn set_key_ttl(
        &self,
        request: &RedisSetKeyTtlRequest,
    ) -> IpcResult<RedisKeyMutationResult>;
}

#[allow(dead_code)]
#[async_trait]
pub trait GraphQueryer: Send + Sync {
    async fn execute_query(&self, request: &GraphQueryRequest) -> IpcResult<GraphQueryResult>;
}

#[allow(dead_code)]
#[async_trait]
pub trait VectorSearcher: Send + Sync {
    async fn search(&self, request: &VectorSearchRequest) -> IpcResult<VectorSearchResponse>;
}

pub fn runtime_info(driver: &dyn DatabaseDriver) -> ConnectionRuntimeInfo {
    let capabilities = driver.capabilities();
    debug_assert!(
        !capabilities.schema_mutator || capabilities.schema_mutation.is_some(),
        "legacy schemaMutator capability requires structured schemaMutation features",
    );
    ConnectionRuntimeInfo {
        profile_id: driver.profile_id().to_string(),
        driver_name: driver.driver_name().to_string(),
        capabilities,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::types::{
        ContainerKind, SchemaMutationFeatures, SchemaMutationObjectFeatures,
        SchemaMutationOperation,
    };

    struct ListOnlySchemaBrowser;

    #[async_trait]
    impl SchemaBrowser for ListOnlySchemaBrowser {
        async fn list_containers(
            &self,
            _parent: Option<&ContainerRef>,
        ) -> IpcResult<Vec<DataContainer>> {
            Ok(Vec::new())
        }
    }

    struct NativeSchemaMutationDriver {
        capabilities: DriverCapabilities,
    }

    #[async_trait]
    impl DatabaseDriver for NativeSchemaMutationDriver {
        fn profile_id(&self) -> &str {
            "profile-native-schema"
        }

        fn driver_name(&self) -> &'static str {
            "native-schema-test"
        }

        fn capabilities(&self) -> DriverCapabilities {
            self.capabilities.clone()
        }

        async fn ping(&self) -> IpcResult<PingResult> {
            unreachable!("runtime_info must not ping the driver")
        }

        async fn close(&self) -> IpcResult<()> {
            Ok(())
        }
    }

    #[test]
    fn runtime_info_allows_native_schema_mutation_without_legacy_schema_mutator() {
        let driver = NativeSchemaMutationDriver {
            capabilities: DriverCapabilities {
                schema_mutator: false,
                schema_mutation: Some(SchemaMutationFeatures::new(
                    [SchemaMutationObjectFeatures::new(
                        ContainerKind::Table,
                        [SchemaMutationOperation::Create],
                    )],
                    true,
                    false,
                    false,
                )),
                ..DriverCapabilities::default()
            },
        };

        let info = runtime_info(&driver);

        assert!(!info.capabilities.schema_mutator);
        assert!(info.capabilities.schema_mutation.is_some());
    }

    #[tokio::test]
    async fn default_table_description_reports_unavailable_capability() {
        let error = ListOnlySchemaBrowser
            .describe_table(&ContainerRef::table(
                ContainerKind::Table,
                "app",
                None,
                "users",
            ))
            .await
            .expect_err("list-only schema browser must not describe tables");

        assert_eq!(error.code, crate::error::ErrorCode::FeatureUnavailable);
    }
}
