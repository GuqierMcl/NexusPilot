use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use clickhouse::Client;
use serde::Deserialize;
use tokio::sync::watch;
use tokio::sync::OwnedMutexGuard;

use crate::engine::driver::{
    DataTableBrowser, DatabaseDriver, ManagedSqlExecutor, SchemaBrowser, SqlExecutor,
};
use crate::engine::native_schema::NativeSchemaExtension;
use crate::engine::profiles::{ClickHouseProfile, ClickHouseProtocol, SshTunnelProfile};
use crate::engine::sql_execution::{
    ManagedSqlCancelRequest, ManagedSqlExecutionRequest, SqlCancelConfirmation, SqlExecutionControl,
};
use crate::engine::ssh_tunnel::{self, ResolvedEndpoint, SshTunnelRuntime};
use crate::engine::types::{
    ContainerKind, ContainerRef, DriverCapabilities, PingResult, QueryResult,
    SchemaMutationFeatures, SchemaMutationObjectFeatures, SchemaMutationOperation,
    SqlExecutionContext, SqlExecutionFeatures, SqlExecutionOutcome, SqlStatementAccess,
    SqlStatementClass, TableBrowseQuery, TableCellChange, TableChangeSetCommitResult,
    TableChangeSetPreview, TableChangeSetRequest, TableMutationResult, TablePageStats, TableRowKey,
};
use crate::error::{IpcError, IpcResult};

mod catalog;
mod dml;
mod error;
mod metadata;
mod query;
pub mod schema;

use self::error::{classify_clickhouse_error, is_permission_denied, probe_timeout};

const DEFAULT_DATABASE: &str = "default";
const DEFAULT_TIMEOUT_SECONDS: u64 = 5;
const MANAGED_STATEMENT_ACCESS: SqlStatementAccess = SqlStatementAccess::Direct;
const SELECT_ONE: &str = "SELECT toUInt8(1) AS one";
const SELECT_VERSION: &str = "SELECT version() AS version";
const SELECT_SYSTEM_DATABASE: &str = "SELECT name FROM system.databases LIMIT 1";

pub struct ClickHouseDriver {
    profile_id: String,
    client: Client,
    timeout: Duration,
    server_version: String,
    _system_catalog_access: bool,
    _endpoint: String,
    _tunnel: Option<SshTunnelRuntime>,
    shutdown: watch::Sender<bool>,
    owner_tab_runtime_id: Option<String>,
    temporary_session: OnceLock<Arc<schema::ClickHouseHttpSession>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeKind {
    One,
    Version,
    SystemCatalog,
}

#[derive(Debug)]
enum ProbeOutput {
    One(u8),
    Version(String),
    SystemCatalog(Option<String>),
}

#[derive(Debug)]
struct ProbeSummary {
    server_version: String,
    system_catalog_access: bool,
}

enum BoundedProbeError {
    ClickHouse(clickhouse::error::Error),
    Timeout,
}

#[async_trait]
trait ProbeExecutor: Send + Sync {
    async fn execute(&self, probe: ProbeKind) -> Result<ProbeOutput, clickhouse::error::Error>;
}

struct ClientProbeExecutor<'a> {
    client: &'a Client,
}

#[derive(clickhouse::Row, Deserialize)]
struct OneRow {
    one: u8,
}

#[derive(clickhouse::Row, Deserialize)]
struct VersionRow {
    version: String,
}

#[derive(clickhouse::Row, Deserialize)]
struct SystemDatabaseRow {
    name: String,
}

#[async_trait]
impl ProbeExecutor for ClientProbeExecutor<'_> {
    async fn execute(&self, probe: ProbeKind) -> Result<ProbeOutput, clickhouse::error::Error> {
        match probe {
            ProbeKind::One => {
                let row = self.client.query(SELECT_ONE).fetch_one::<OneRow>().await?;
                Ok(ProbeOutput::One(row.one))
            }
            ProbeKind::Version => {
                let row = self
                    .client
                    .query(SELECT_VERSION)
                    .fetch_one::<VersionRow>()
                    .await?;
                Ok(ProbeOutput::Version(row.version))
            }
            ProbeKind::SystemCatalog => {
                let row = self
                    .client
                    .query(SELECT_SYSTEM_DATABASE)
                    .fetch_optional::<SystemDatabaseRow>()
                    .await?;
                Ok(ProbeOutput::SystemCatalog(row.map(|row| row.name)))
            }
        }
    }
}

#[async_trait]
trait EndpointResolver: Send + Sync {
    async fn resolve(
        &self,
        host: &str,
        port: u16,
        ssh: Option<&SshTunnelProfile>,
    ) -> IpcResult<ResolvedEndpoint>;
}

struct RealEndpointResolver;

#[async_trait]
impl EndpointResolver for RealEndpointResolver {
    async fn resolve(
        &self,
        host: &str,
        port: u16,
        ssh: Option<&SshTunnelProfile>,
    ) -> IpcResult<ResolvedEndpoint> {
        ssh_tunnel::resolve_endpoint(host, port, ssh).await
    }
}

impl ClickHouseDriver {
    pub(crate) fn classify_ai_sql(sql: &str) -> SqlStatementClass {
        query::classify_framed_statement(sql)
    }

    pub async fn connect(
        profile_id: String,
        profile: ClickHouseProfile,
    ) -> IpcResult<Arc<dyn DatabaseDriver>> {
        Self::connect_with_owner(profile_id, profile, None).await
    }

    pub async fn connect_for_tab(
        profile_id: String,
        profile: ClickHouseProfile,
        owner_tab_runtime_id: String,
    ) -> IpcResult<Arc<dyn DatabaseDriver>> {
        Self::connect_with_owner(profile_id, profile, Some(owner_tab_runtime_id)).await
    }

    async fn connect_with_owner(
        profile_id: String,
        profile: ClickHouseProfile,
        owner_tab_runtime_id: Option<String>,
    ) -> IpcResult<Arc<dyn DatabaseDriver>> {
        let resolved = resolve_profile_endpoint(&profile, &RealEndpointResolver).await?;
        let endpoint = build_endpoint(profile.protocol, &resolved.host, resolved.port)?;
        let database = profile
            .default_database
            .as_deref()
            .map(str::trim)
            .filter(|database| !database.is_empty())
            .unwrap_or(DEFAULT_DATABASE)
            .to_string();
        let timeout = Duration::from_secs(
            profile
                .connect_timeout_seconds
                .unwrap_or(DEFAULT_TIMEOUT_SECONDS),
        );
        let client = Client::default()
            .with_url(endpoint.clone())
            .with_user(profile.username)
            .with_password(profile.password)
            .with_database(database);
        let probes =
            run_connection_probes(&ClientProbeExecutor { client: &client }, timeout).await?;
        let (shutdown, _) = watch::channel(false);

        Ok(Arc::new(Self {
            profile_id,
            client,
            timeout,
            server_version: probes.server_version,
            _system_catalog_access: probes.system_catalog_access,
            _endpoint: endpoint,
            _tunnel: resolved.tunnel,
            shutdown,
            owner_tab_runtime_id,
            temporary_session: OnceLock::new(),
        }))
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(server_version: &str) -> Self {
        let (shutdown, _) = watch::channel(false);
        Self {
            profile_id: "clickhouse-test".to_string(),
            client: Client::default().with_url("http://localhost:8123"),
            timeout: Duration::from_secs(1),
            server_version: server_version.to_string(),
            _system_catalog_access: false,
            _endpoint: "http://localhost:8123".to_string(),
            _tunnel: None,
            shutdown,
            owner_tab_runtime_id: None,
            temporary_session: OnceLock::new(),
        }
    }

    #[cfg(test)]
    pub(crate) fn new_for_test_tab(server_version: &str, owner_tab_runtime_id: &str) -> Self {
        let mut driver = Self::new_for_test(server_version);
        driver.owner_tab_runtime_id = Some(owner_tab_runtime_id.to_string());
        driver
    }

    pub(crate) fn session_for_owner(
        &self,
        owner_tab_runtime_id: &str,
    ) -> IpcResult<Arc<schema::ClickHouseHttpSession>> {
        schema::session_slot(
            self.owner_tab_runtime_id.as_deref(),
            owner_tab_runtime_id,
            &self.temporary_session,
        )
    }

    pub(crate) fn owner_tab_runtime_id(&self) -> Option<&str> {
        self.owner_tab_runtime_id.as_deref()
    }

    pub(crate) async fn client_for_request(
        &self,
    ) -> IpcResult<(Client, Option<OwnedMutexGuard<()>>)> {
        let Some(owner_tab_runtime_id) = self.owner_tab_runtime_id() else {
            return Ok((self.client.clone(), None));
        };
        let session = self.session_for_owner(owner_tab_runtime_id)?;
        let guard = session.request_lock_owned(owner_tab_runtime_id).await?;
        Ok((session.configured_client(self.client.clone()), Some(guard)))
    }

    async fn cleanup_temporary_session(&self) {
        let Some(session) = self.temporary_session.get() else {
            return;
        };
        session.cleanup_best_effort(self.client.clone()).await;
    }
}

fn validate_profile(profile: &ClickHouseProfile) -> IpcResult<()> {
    validate_host(&profile.host)?;
    if profile.port == 0 {
        return Err(IpcError::validation_failed(
            "ClickHouse port must be between 1 and 65535",
        ));
    }
    if profile.username.trim().is_empty() {
        return Err(IpcError::validation_failed(
            "ClickHouse username is required",
        ));
    }
    if profile.protocol == ClickHouseProtocol::Unsupported {
        return Err(IpcError::validation_failed(
            "ClickHouse protocol must be http or https",
        ));
    }
    if profile
        .connect_timeout_seconds
        .is_some_and(|timeout| !(1..=300).contains(&timeout))
    {
        return Err(IpcError::validation_failed(
            "ClickHouse connection timeout must be between 1 and 300 seconds",
        ));
    }
    if profile.protocol == ClickHouseProtocol::Https
        && profile
            .ssh_tunnel
            .as_ref()
            .is_some_and(|tunnel| tunnel.enabled)
    {
        return Err(IpcError::validation_failed(
            "HTTPS over SSH is unavailable until the tunnel preserves the original ClickHouse hostname for TLS SNI verification",
        ));
    }
    Ok(())
}

async fn resolve_profile_endpoint(
    profile: &ClickHouseProfile,
    resolver: &impl EndpointResolver,
) -> IpcResult<ResolvedEndpoint> {
    validate_profile(profile)?;
    if profile.protocol == ClickHouseProtocol::Https
        && profile
            .ssh_tunnel
            .as_ref()
            .is_some_and(|tunnel| tunnel.enabled)
    {
        return Err(IpcError::validation_failed(
            "HTTPS over SSH is unavailable until the tunnel preserves the original ClickHouse hostname for TLS SNI verification",
        ));
    }

    resolver
        .resolve(&profile.host, profile.port, profile.ssh_tunnel.as_ref())
        .await
}

pub(crate) fn build_endpoint(
    protocol: ClickHouseProtocol,
    host: &str,
    port: u16,
) -> IpcResult<String> {
    let scheme = match protocol {
        ClickHouseProtocol::Http => "http",
        ClickHouseProtocol::Https => "https",
        ClickHouseProtocol::Unsupported => {
            return Err(IpcError::validation_failed(
                "ClickHouse protocol must be http or https",
            ));
        }
    };
    validate_host(host)?;
    let host = host.trim();
    let rendered_host = if host.contains(':') && !(host.starts_with('[') && host.ends_with(']')) {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    Ok(format!("{scheme}://{rendered_host}:{port}"))
}

fn validate_host(host: &str) -> IpcResult<()> {
    let host = host.trim();
    if host.is_empty() {
        return Err(IpcError::validation_failed("ClickHouse host is required"));
    }
    if host
        .chars()
        .any(|character| character.is_whitespace() || "/?#@".contains(character))
    {
        return Err(IpcError::validation_failed(
            "ClickHouse host must be a hostname or IP address without a URL scheme, credentials, port, query, or path",
        ));
    }
    if host.contains(':') {
        let ipv6 = host
            .strip_prefix('[')
            .and_then(|host| host.strip_suffix(']'))
            .unwrap_or(host);
        if ipv6.parse::<std::net::Ipv6Addr>().is_err() {
            return Err(IpcError::validation_failed(
                "ClickHouse host containing ':' must be a valid IPv6 address without a port",
            ));
        }
        return Ok(());
    }

    let hostname = host.strip_suffix('.').unwrap_or(host);
    let valid_hostname = host.is_ascii()
        && !hostname.is_empty()
        && hostname.len() <= 253
        && hostname.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                && !label.starts_with('-')
                && !label.ends_with('-')
        });
    if !valid_hostname {
        return Err(IpcError::validation_failed(
            "ClickHouse host must be a valid ASCII hostname, IPv4 address, or IPv6 address without URL authority characters",
        ));
    }
    Ok(())
}

async fn execute_bounded_probe(
    executor: &impl ProbeExecutor,
    probe: ProbeKind,
    timeout: Duration,
) -> Result<ProbeOutput, BoundedProbeError> {
    tokio::time::timeout(timeout, executor.execute(probe))
        .await
        .map_err(|_| BoundedProbeError::Timeout)?
        .map_err(BoundedProbeError::ClickHouse)
}

fn classify_bounded_probe_error(
    error: BoundedProbeError,
    operation: &str,
    timeout: Duration,
) -> IpcError {
    match error {
        BoundedProbeError::ClickHouse(error) => classify_clickhouse_error(error, operation),
        BoundedProbeError::Timeout => probe_timeout(operation, timeout),
    }
}

async fn require_one_probe(executor: &impl ProbeExecutor, timeout: Duration) -> IpcResult<()> {
    let output = execute_bounded_probe(executor, ProbeKind::One, timeout)
        .await
        .map_err(|error| classify_bounded_probe_error(error, "SELECT 1 probe", timeout))?;
    match output {
        ProbeOutput::One(1) => Ok(()),
        ProbeOutput::One(value) => Err(IpcError::system_internal(
            "ClickHouse SELECT 1 probe returned an unexpected value",
            format!("Expected 1, received {value}"),
        )),
        other => Err(IpcError::system_internal(
            "ClickHouse SELECT 1 probe returned an unexpected response shape",
            format!("Received {other:?}"),
        )),
    }
}

async fn require_one_probe_until_shutdown(
    executor: &impl ProbeExecutor,
    timeout: Duration,
    shutdown: &mut watch::Receiver<bool>,
) -> IpcResult<()> {
    if *shutdown.borrow() {
        return Err(IpcError::operation_canceled(
            "ClickHouse probe canceled",
            "The runtime is closing",
        ));
    }
    tokio::select! {
        biased;
        _ = shutdown.changed() => Err(IpcError::operation_canceled(
            "ClickHouse probe canceled",
            "The runtime closed while the probe was in flight",
        )),
        result = require_one_probe(executor, timeout) => result,
    }
}

async fn require_version_probe(
    executor: &impl ProbeExecutor,
    timeout: Duration,
) -> IpcResult<String> {
    let output = execute_bounded_probe(executor, ProbeKind::Version, timeout)
        .await
        .map_err(|error| classify_bounded_probe_error(error, "version probe", timeout))?;
    match output {
        ProbeOutput::Version(version) if !version.trim().is_empty() => Ok(version),
        ProbeOutput::Version(_) => Err(IpcError::system_internal(
            "ClickHouse version probe returned an empty version",
            "Expected a non-empty version string",
        )),
        other => Err(IpcError::system_internal(
            "ClickHouse version probe returned an unexpected response shape",
            format!("Received {other:?}"),
        )),
    }
}

async fn probe_system_catalog_access(
    executor: &impl ProbeExecutor,
    timeout: Duration,
) -> IpcResult<bool> {
    match execute_bounded_probe(executor, ProbeKind::SystemCatalog, timeout).await {
        Ok(ProbeOutput::SystemCatalog(value)) => {
            let _ = value;
            Ok(true)
        }
        Ok(other) => Err(IpcError::system_internal(
            "ClickHouse system catalog probe returned an unexpected response shape",
            format!("Received {other:?}"),
        )),
        Err(BoundedProbeError::ClickHouse(error)) if is_permission_denied(&error) => Ok(false),
        Err(error) => Err(classify_bounded_probe_error(
            error,
            "system catalog probe",
            timeout,
        )),
    }
}

async fn run_connection_probes(
    executor: &impl ProbeExecutor,
    timeout: Duration,
) -> IpcResult<ProbeSummary> {
    require_one_probe(executor, timeout).await?;
    let server_version = require_version_probe(executor, timeout).await?;
    let system_catalog_access = probe_system_catalog_access(executor, timeout).await?;
    Ok(ProbeSummary {
        server_version,
        system_catalog_access,
    })
}

fn clickhouse_capabilities() -> DriverCapabilities {
    DriverCapabilities {
        schema_browser: true,
        schema_mutator: false,
        schema_mutation: Some(SchemaMutationFeatures::new(
            [
                SchemaMutationObjectFeatures::new(
                    ContainerKind::Database,
                    [
                        SchemaMutationOperation::Create,
                        SchemaMutationOperation::Drop,
                    ],
                ),
                SchemaMutationObjectFeatures::new(
                    ContainerKind::Table,
                    [
                        SchemaMutationOperation::Create,
                        SchemaMutationOperation::Alter,
                        SchemaMutationOperation::Drop,
                    ],
                ),
                SchemaMutationObjectFeatures::new(
                    ContainerKind::Column,
                    [
                        SchemaMutationOperation::Clear,
                        SchemaMutationOperation::Materialize,
                    ],
                ),
                SchemaMutationObjectFeatures::new(
                    ContainerKind::Projection,
                    [
                        SchemaMutationOperation::Create,
                        SchemaMutationOperation::Drop,
                        SchemaMutationOperation::Clear,
                        SchemaMutationOperation::Materialize,
                    ],
                ),
                SchemaMutationObjectFeatures::new(
                    ContainerKind::Index,
                    [
                        SchemaMutationOperation::Create,
                        SchemaMutationOperation::Drop,
                        SchemaMutationOperation::Clear,
                        SchemaMutationOperation::Materialize,
                    ],
                ),
                SchemaMutationObjectFeatures::new(
                    ContainerKind::View,
                    [
                        SchemaMutationOperation::Create,
                        SchemaMutationOperation::Alter,
                        SchemaMutationOperation::Rename,
                        SchemaMutationOperation::Drop,
                    ],
                ),
                SchemaMutationObjectFeatures::new(
                    ContainerKind::MaterializedView,
                    [
                        SchemaMutationOperation::Create,
                        SchemaMutationOperation::Alter,
                        SchemaMutationOperation::Rename,
                        SchemaMutationOperation::Drop,
                    ],
                ),
            ],
            true,
            true,
            true,
        )),
        data_table_browser: true,
        table_row_mutator: true,
        table_row_inserter: true,
        sql_executor: true,
        sql_execution: Some(SqlExecutionFeatures {
            managed_lifecycle: true,
            statement_access: MANAGED_STATEMENT_ACCESS,
            active_cancel: true,
            live_progress: true,
            query_summary: true,
            raw_result: true,
            configurable_timeout: true,
        }),
        ..DriverCapabilities::default()
    }
}

#[async_trait]
impl DatabaseDriver for ClickHouseDriver {
    fn profile_id(&self) -> &str {
        &self.profile_id
    }

    fn driver_name(&self) -> &'static str {
        "clickhouse"
    }

    fn capabilities(&self) -> DriverCapabilities {
        clickhouse_capabilities()
    }

    async fn ping(&self) -> IpcResult<PingResult> {
        let started_at = Instant::now();
        let mut shutdown = self.shutdown.subscribe();
        require_one_probe_until_shutdown(
            &ClientProbeExecutor {
                client: &self.client,
            },
            self.timeout,
            &mut shutdown,
        )
        .await?;
        Ok(PingResult {
            latency_ms: started_at.elapsed().as_millis() as u64,
        })
    }

    async fn close(&self) -> IpcResult<()> {
        self.cleanup_temporary_session().await;
        self.shutdown.send_replace(true);
        Ok(())
    }

    async fn server_version(&self) -> IpcResult<Option<String>> {
        Ok(Some(self.server_version.clone()))
    }

    fn ssh_host_key_fingerprint(&self) -> Option<&str> {
        self._tunnel
            .as_ref()
            .and_then(SshTunnelRuntime::captured_host_key_fingerprint)
    }

    fn as_schema_browser(&self) -> Option<&dyn SchemaBrowser> {
        Some(self)
    }

    fn as_native_schema_extension(&self) -> Option<&dyn NativeSchemaExtension> {
        Some(self)
    }

    fn as_data_table_browser(&self) -> Option<&dyn DataTableBrowser> {
        Some(self)
    }

    fn as_sql_executor(&self) -> Option<&dyn SqlExecutor> {
        Some(self)
    }

    fn as_managed_sql_executor(&self) -> Option<&dyn ManagedSqlExecutor> {
        Some(self)
    }
}

#[async_trait]
impl DataTableBrowser for ClickHouseDriver {
    async fn browse_table_data(
        &self,
        container: &ContainerRef,
        page: u32,
        page_size: u32,
        query: &TableBrowseQuery,
    ) -> IpcResult<QueryResult> {
        let mut result = query::browse_table_data(self, container, page, page_size, query).await?;
        dml::apply_table_write_capabilities(self, container, &mut result).await;
        Ok(result)
    }

    async fn get_table_page_stats(
        &self,
        container: &ContainerRef,
        page_size: u32,
        query: &TableBrowseQuery,
        requested_page: Option<u32>,
    ) -> IpcResult<TablePageStats> {
        query::get_table_page_stats(self, container, page_size, query, requested_page).await
    }

    async fn update_table_row(
        &self,
        _container: &ContainerRef,
        _primary_key: &TableRowKey,
        _changes: &[TableCellChange],
    ) -> IpcResult<TableMutationResult> {
        Err(clickhouse_primary_key_mutation_unavailable())
    }

    async fn delete_table_rows(
        &self,
        _container: &ContainerRef,
        _primary_keys: &[TableRowKey],
    ) -> IpcResult<TableMutationResult> {
        Err(clickhouse_primary_key_mutation_unavailable())
    }

    async fn preview_table_change_set(
        &self,
        container: &ContainerRef,
        change_set: &TableChangeSetRequest,
    ) -> IpcResult<TableChangeSetPreview> {
        dml::preview_table_change_set(self, container, change_set).await
    }

    async fn commit_table_change_set(
        &self,
        container: &ContainerRef,
        change_set: &TableChangeSetRequest,
    ) -> IpcResult<TableChangeSetCommitResult> {
        dml::commit_table_change_set(self, container, change_set).await
    }
}

#[async_trait]
impl SqlExecutor for ClickHouseDriver {
    async fn execute_sql(
        &self,
        context: &SqlExecutionContext,
        sql: &str,
        page: u32,
        page_size: u32,
    ) -> IpcResult<QueryResult> {
        query::execute_sql(self, context, sql, page, page_size).await
    }
}

#[async_trait]
impl ManagedSqlExecutor for ClickHouseDriver {
    fn classify_statement(&self, sql: &str) -> IpcResult<SqlStatementClass> {
        query::classify_statement(sql)
    }

    async fn execute_managed_sql(
        &self,
        request: ManagedSqlExecutionRequest,
        control: SqlExecutionControl,
    ) -> IpcResult<SqlExecutionOutcome> {
        query::execute_managed(self, request, control, MANAGED_STATEMENT_ACCESS).await
    }

    async fn cancel_managed_sql(
        &self,
        request: ManagedSqlCancelRequest,
    ) -> IpcResult<SqlCancelConfirmation> {
        query::cancel_managed(&self.client, request).await
    }
}

fn clickhouse_primary_key_mutation_unavailable() -> IpcError {
    IpcError::feature_unavailable(
        "该操作使用的主键定位方式不适用于 ClickHouse；请刷新 DataTable 后通过“保存更改”提交，或在 SQL 编辑器中执行写入操作",
    )
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::io;
    use std::sync::Mutex;
    use std::time::Duration;

    use async_trait::async_trait;

    use super::*;
    use crate::engine::profiles::{SshAuthMethod, SshHostVerificationMode, SshTunnelProfile};
    use crate::error::{ErrorCode, RuntimeErrorImpact};

    enum FakeResponse {
        Output(ProbeOutput),
        Error(clickhouse::error::Error),
        Sleep(Duration),
    }

    struct FakeProbeExecutor {
        responses: Mutex<VecDeque<FakeResponse>>,
        calls: Mutex<Vec<ProbeKind>>,
    }

    impl FakeProbeExecutor {
        fn new(responses: Vec<FakeResponse>) -> Self {
            Self {
                responses: Mutex::new(responses.into()),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<ProbeKind> {
            self.calls.lock().expect("calls lock").clone()
        }
    }

    #[async_trait]
    impl ProbeExecutor for FakeProbeExecutor {
        async fn execute(&self, probe: ProbeKind) -> Result<ProbeOutput, clickhouse::error::Error> {
            self.calls.lock().expect("calls lock").push(probe);
            let response = self
                .responses
                .lock()
                .expect("responses lock")
                .pop_front()
                .expect("fake response");
            match response {
                FakeResponse::Output(output) => Ok(output),
                FakeResponse::Error(error) => Err(error),
                FakeResponse::Sleep(duration) => {
                    tokio::time::sleep(duration).await;
                    unreachable!("the probe should time out")
                }
            }
        }
    }

    fn profile() -> ClickHouseProfile {
        ClickHouseProfile {
            host: "localhost".to_string(),
            port: 8123,
            username: "default".to_string(),
            password: String::new(),
            default_database: Some("default".to_string()),
            protocol: ClickHouseProtocol::Http,
            connect_timeout_seconds: Some(5),
            ssh_tunnel: None,
        }
    }

    fn ssh_tunnel() -> SshTunnelProfile {
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

    fn successful_responses() -> Vec<FakeResponse> {
        vec![
            FakeResponse::Output(ProbeOutput::One(1)),
            FakeResponse::Output(ProbeOutput::Version("25.8.1.1".to_string())),
            FakeResponse::Output(ProbeOutput::SystemCatalog(Some("default".to_string()))),
        ]
    }

    #[tokio::test]
    async fn connection_probes_run_in_required_order_before_runtime_is_ready() {
        let executor = FakeProbeExecutor::new(successful_responses());

        let summary = run_connection_probes(&executor, Duration::from_secs(1))
            .await
            .expect("all probes should pass");

        assert_eq!(summary.server_version, "25.8.1.1");
        assert!(summary.system_catalog_access);
        assert_eq!(
            executor.calls(),
            vec![ProbeKind::One, ProbeKind::Version, ProbeKind::SystemCatalog]
        );
    }

    #[tokio::test]
    async fn failed_required_probe_stops_before_runtime_can_be_created() {
        let executor = FakeProbeExecutor::new(vec![FakeResponse::Error(
            clickhouse::error::Error::Network(Box::new(io::Error::new(
                io::ErrorKind::ConnectionRefused,
                "refused",
            ))),
        )]);

        let error = run_connection_probes(&executor, Duration::from_secs(1))
            .await
            .expect_err("SELECT 1 must be successful");

        assert_eq!(error.code, ErrorCode::NetworkTimeout);
        assert_eq!(error.runtime_impact, RuntimeErrorImpact::Retryable);
        assert_eq!(executor.calls(), vec![ProbeKind::One]);
    }

    #[tokio::test]
    async fn every_probe_is_bounded_by_the_configured_timeout() {
        for timeout_at in 0..3 {
            let mut responses = successful_responses();
            responses[timeout_at] = FakeResponse::Sleep(Duration::from_millis(50));
            let executor = FakeProbeExecutor::new(responses);

            let error = run_connection_probes(&executor, Duration::from_millis(1))
                .await
                .expect_err("slow probe should time out");

            assert_eq!(error.code, ErrorCode::NetworkTimeout);
            assert_eq!(error.runtime_impact, RuntimeErrorImpact::Retryable);
            assert_eq!(executor.calls().len(), timeout_at + 1);
        }
    }

    #[tokio::test]
    async fn disconnect_signal_actually_cancels_an_inflight_probe() {
        let executor = FakeProbeExecutor::new(vec![FakeResponse::Sleep(Duration::from_secs(5))]);
        let (shutdown, mut shutdown_receiver) = tokio::sync::watch::channel(false);
        let probe = require_one_probe_until_shutdown(
            &executor,
            Duration::from_secs(30),
            &mut shutdown_receiver,
        );
        tokio::pin!(probe);
        tokio::task::yield_now().await;
        shutdown.send_replace(true);

        let error = tokio::time::timeout(Duration::from_millis(100), probe)
            .await
            .expect("disconnect should release the probe promptly")
            .expect_err("disconnect should cancel the probe");

        assert_eq!(error.code, ErrorCode::OperationCanceled);
        assert_eq!(error.runtime_impact, RuntimeErrorImpact::BusinessOnly);
    }

    #[tokio::test]
    async fn clickhouse_network_and_native_timeout_errors_are_retryable() {
        let errors = vec![
            clickhouse::error::Error::Network(Box::new(io::Error::new(
                io::ErrorKind::ConnectionReset,
                "reset",
            ))),
            clickhouse::error::Error::TimedOut,
        ];

        for source in errors {
            let executor = FakeProbeExecutor::new(vec![FakeResponse::Error(source)]);
            let error = run_connection_probes(&executor, Duration::from_secs(1))
                .await
                .expect_err("connection error should abort probes");
            assert_eq!(error.code, ErrorCode::NetworkTimeout);
            assert_eq!(error.runtime_impact, RuntimeErrorImpact::Retryable);
        }
    }

    #[tokio::test]
    async fn clickhouse_authentication_responses_are_terminal() {
        for details in [
            "Code: 516. DB::Exception: Authentication failed",
            "AUTHENTICATION_FAILED",
            "REQUIRED_PASSWORD",
            "password is incorrect",
        ] {
            let executor = FakeProbeExecutor::new(vec![FakeResponse::Error(
                clickhouse::error::Error::BadResponse(details.to_string()),
            )]);
            let error = run_connection_probes(&executor, Duration::from_secs(1))
                .await
                .expect_err("authentication failure should abort probes");
            assert_eq!(error.code, ErrorCode::AuthFailed, "{details}");
            assert_eq!(error.runtime_impact, RuntimeErrorImpact::Terminal);
        }
    }

    #[test]
    fn rejects_invalid_local_clickhouse_configuration() {
        let mut cases = Vec::new();

        let mut blank_host = profile();
        blank_host.host = " ".to_string();
        cases.push(blank_host);

        let mut zero_port = profile();
        zero_port.port = 0;
        cases.push(zero_port);

        let mut blank_username = profile();
        blank_username.username = " ".to_string();
        cases.push(blank_username);

        let mut invalid_timeout = profile();
        invalid_timeout.connect_timeout_seconds = Some(0);
        cases.push(invalid_timeout);

        let mut invalid_protocol = profile();
        invalid_protocol.protocol = ClickHouseProtocol::Unsupported;
        cases.push(invalid_protocol);

        for invalid in cases {
            let error = validate_profile(&invalid).expect_err("profile should be rejected");
            assert_eq!(error.code, ErrorCode::ValidationFailed);
        }
    }

    #[tokio::test]
    async fn unexpected_fixed_probe_values_are_internal_errors() {
        let cases = vec![
            vec![FakeResponse::Output(ProbeOutput::One(0))],
            vec![
                FakeResponse::Output(ProbeOutput::One(1)),
                FakeResponse::Output(ProbeOutput::Version("  ".to_string())),
            ],
        ];

        for responses in cases {
            let executor = FakeProbeExecutor::new(responses);
            let error = run_connection_probes(&executor, Duration::from_secs(1))
                .await
                .expect_err("unexpected fixed response should fail");
            assert_eq!(error.code, ErrorCode::SystemInternal);
            assert_eq!(error.runtime_impact, RuntimeErrorImpact::BusinessOnly);
        }
    }

    #[tokio::test]
    async fn system_catalog_permission_denial_is_non_fatal() {
        let executor = FakeProbeExecutor::new(vec![
            FakeResponse::Output(ProbeOutput::One(1)),
            FakeResponse::Output(ProbeOutput::Version("25.8.1.1".to_string())),
            FakeResponse::Error(clickhouse::error::Error::BadResponse(
                "Code: 497. DB::Exception: ACCESS_DENIED: not enough privileges".to_string(),
            )),
        ]);

        let summary = run_connection_probes(&executor, Duration::from_secs(1))
            .await
            .expect("permission denial should preserve the runtime");

        assert_eq!(summary.server_version, "25.8.1.1");
        assert!(!summary.system_catalog_access);
    }

    #[tokio::test]
    async fn system_catalog_network_or_auth_failure_aborts_connect() {
        for source in [
            clickhouse::error::Error::TimedOut,
            clickhouse::error::Error::BadResponse("Code: 516. AUTHENTICATION_FAILED".to_string()),
        ] {
            let executor = FakeProbeExecutor::new(vec![
                FakeResponse::Output(ProbeOutput::One(1)),
                FakeResponse::Output(ProbeOutput::Version("25.8.1.1".to_string())),
                FakeResponse::Error(source),
            ]);

            assert!(run_connection_probes(&executor, Duration::from_secs(1))
                .await
                .is_err());
        }
    }

    #[test]
    fn clickhouse_urls_bracket_ipv6_hosts() {
        assert_eq!(
            build_endpoint(ClickHouseProtocol::Http, "::1", 8123).expect("IPv6 URL"),
            "http://[::1]:8123"
        );
        assert_eq!(
            build_endpoint(ClickHouseProtocol::Https, "[2001:db8::1]", 8443)
                .expect("bracketed IPv6 URL"),
            "https://[2001:db8::1]:8443"
        );
    }

    #[tokio::test]
    async fn https_over_ssh_fails_before_endpoint_resolution() {
        let calls = Mutex::new(0usize);
        let resolver = FakeEndpointResolver::new(&calls);
        let mut profile = profile();
        profile.protocol = ClickHouseProtocol::Https;
        profile.ssh_tunnel = Some(ssh_tunnel());

        let error = match resolve_profile_endpoint(&profile, &resolver).await {
            Ok(_) => panic!("HTTPS over SSH must fail closed"),
            Err(error) => error,
        };

        assert_eq!(error.code, ErrorCode::ValidationFailed);
        assert_eq!(*calls.lock().expect("resolver calls"), 0);
    }

    #[tokio::test]
    async fn invalid_hosts_fail_before_endpoint_resolution() {
        let calls = Mutex::new(0usize);
        let resolver = FakeEndpointResolver::new(&calls);
        for host in [
            "http://localhost",
            "trusted.example@attacker.example",
            "example.com?query",
            "example.com#fragment",
            "example.com/path",
            "trusted.example\\attacker.example",
            "[]",
            "bad host",
            "bad\nhost",
            "example.com:8123",
            "[::1",
        ] {
            let mut profile = profile();
            profile.host = host.to_string();
            profile.ssh_tunnel = Some(ssh_tunnel());

            let error = match resolve_profile_endpoint(&profile, &resolver).await {
                Ok(_) => panic!("invalid host must fail before endpoint resolution: {host}"),
                Err(error) => error,
            };

            assert_eq!(error.code, ErrorCode::ValidationFailed, "{host}");
        }
        assert_eq!(*calls.lock().expect("resolver calls"), 0);
    }

    #[tokio::test]
    async fn http_over_ssh_uses_the_endpoint_resolver() {
        let calls = Mutex::new(0usize);
        let resolver = FakeEndpointResolver::new(&calls);
        let mut profile = profile();
        profile.ssh_tunnel = Some(ssh_tunnel());

        let endpoint = resolve_profile_endpoint(&profile, &resolver)
            .await
            .expect("HTTP over SSH should resolve");

        assert_eq!(endpoint.host, "127.0.0.1");
        assert_eq!(endpoint.port, 18123);
        assert_eq!(*calls.lock().expect("resolver calls"), 1);
    }

    struct FakeEndpointResolver<'a> {
        calls: &'a Mutex<usize>,
    }

    impl<'a> FakeEndpointResolver<'a> {
        fn new(calls: &'a Mutex<usize>) -> Self {
            Self { calls }
        }
    }

    #[async_trait]
    impl EndpointResolver for FakeEndpointResolver<'_> {
        async fn resolve(
            &self,
            _host: &str,
            _port: u16,
            _ssh: Option<&SshTunnelProfile>,
        ) -> IpcResult<crate::engine::ssh_tunnel::ResolvedEndpoint> {
            *self.calls.lock().expect("resolver calls") += 1;
            Ok(crate::engine::ssh_tunnel::ResolvedEndpoint {
                host: "127.0.0.1".to_string(),
                port: 18123,
                tunnel: None,
            })
        }
    }

    #[test]
    fn managed_statement_access_is_a_single_direct_source_after_real_gate() {
        assert_eq!(MANAGED_STATEMENT_ACCESS, SqlStatementAccess::Direct);
        let capabilities = clickhouse_capabilities();
        assert_eq!(
            capabilities
                .sql_execution
                .expect("ClickHouse managed features")
                .statement_access,
            MANAGED_STATEMENT_ACCESS,
        );
    }

    #[test]
    fn unavailable_primary_key_mutation_message_is_actionable_for_users() {
        let error = clickhouse_primary_key_mutation_unavailable();

        assert_eq!(error.code, ErrorCode::FeatureUnavailable);
        assert!(error.message.contains("主键定位方式不适用于 ClickHouse"));
        assert!(error.message.contains("保存更改"));
        assert!(error.message.contains("SQL 编辑器"));
        assert!(!error.message.to_ascii_lowercase().contains("phase"));
    }

    #[test]
    fn phase_four_c_raw_capability_is_enabled_after_real_gate() {
        let capabilities = clickhouse_capabilities();
        let features = capabilities
            .sql_execution
            .expect("ClickHouse managed feature");
        assert_eq!(features.statement_access, SqlStatementAccess::Direct);
        assert!(features.managed_lifecycle);
        assert!(features.active_cancel);
        assert!(features.live_progress);
        assert!(features.query_summary);
        assert!(features.configurable_timeout);
        assert!(features.raw_result);
        assert!(!capabilities.schema_mutator);
        assert!(capabilities.table_row_mutator);
        assert!(capabilities.table_row_inserter);
        assert!(!capabilities.transaction_manager);
    }

    #[test]
    fn phase_five_e_baseline_capability_matrix_is_published_after_real_gate() {
        let driver = ClickHouseDriver::new_for_test("25.8.1.1");
        let capabilities = driver.capabilities();

        assert_eq!(
            capabilities.sql_execution,
            Some(SqlExecutionFeatures {
                managed_lifecycle: true,
                statement_access: SqlStatementAccess::Direct,
                active_cancel: true,
                live_progress: true,
                query_summary: true,
                raw_result: true,
                configurable_timeout: true,
            }),
        );
        assert!(capabilities.schema_browser);
        assert!(!capabilities.schema_mutator);
        assert!(capabilities.data_table_browser);
        assert!(capabilities.table_row_mutator);
        assert!(capabilities.table_row_inserter);
        assert!(!capabilities.transaction_manager);
        assert!(capabilities.sql_executor);
        assert!(!capabilities.key_value_browser);
        assert!(!capabilities.graph_queryer);
        assert!(!capabilities.vector_searcher);
        assert!(driver.as_schema_browser().is_some());
        assert!(driver.as_schema_mutator().is_none());
        let mutation = capabilities
            .schema_mutation
            .as_ref()
            .expect("Phase 5E native schema capability");
        assert_eq!(mutation.objects.len(), 7);
        assert_eq!(
            mutation
                .objects
                .iter()
                .find(|object| object.kind == ContainerKind::Database)
                .expect("database capability")
                .operations,
            [
                SchemaMutationOperation::Create,
                SchemaMutationOperation::Drop,
            ],
        );
        assert_eq!(
            mutation
                .objects
                .iter()
                .find(|object| object.kind == ContainerKind::Table)
                .expect("table capability")
                .operations,
            [
                SchemaMutationOperation::Create,
                SchemaMutationOperation::Alter,
                SchemaMutationOperation::Drop,
            ],
        );
        assert_eq!(
            mutation
                .objects
                .iter()
                .find(|object| object.kind == ContainerKind::Column)
                .expect("column capability")
                .operations,
            [
                SchemaMutationOperation::Clear,
                SchemaMutationOperation::Materialize,
            ],
        );
        assert!(mutation.supports(ContainerKind::Database, SchemaMutationOperation::Create,));
        assert!(mutation.supports(ContainerKind::Database, SchemaMutationOperation::Drop,));
        assert!(mutation.supports(ContainerKind::Table, SchemaMutationOperation::Create));
        assert!(mutation.supports(ContainerKind::Table, SchemaMutationOperation::Alter));
        assert!(mutation.supports(ContainerKind::Table, SchemaMutationOperation::Drop));
        assert!(mutation.supports(ContainerKind::Column, SchemaMutationOperation::Clear));
        assert!(mutation.supports(ContainerKind::Column, SchemaMutationOperation::Materialize,));
        assert!(!mutation.supports(ContainerKind::Database, SchemaMutationOperation::Alter,));
        assert!(!mutation.supports(ContainerKind::Column, SchemaMutationOperation::Create));
        assert!(!mutation.supports(ContainerKind::Column, SchemaMutationOperation::Alter));
        assert!(!mutation.supports(ContainerKind::Column, SchemaMutationOperation::Drop));
        for kind in [ContainerKind::Projection, ContainerKind::Index] {
            for operation in [
                SchemaMutationOperation::Create,
                SchemaMutationOperation::Drop,
                SchemaMutationOperation::Clear,
                SchemaMutationOperation::Materialize,
            ] {
                assert!(mutation.supports(kind.clone(), operation));
            }
        }
        for kind in [ContainerKind::View, ContainerKind::MaterializedView] {
            for operation in [
                SchemaMutationOperation::Create,
                SchemaMutationOperation::Alter,
                SchemaMutationOperation::Rename,
                SchemaMutationOperation::Drop,
            ] {
                assert!(mutation.supports(kind.clone(), operation));
            }
        }
        assert!(mutation.ddl_preview);
        assert!(mutation.destructive_confirmation);
        assert!(mutation.remote_drift_protection);
        assert!(driver.as_native_schema_extension().is_some());
        assert!(serde_json::to_value(&capabilities)
            .expect("serialize ClickHouse capabilities")
            .get("schemaMutation")
            .is_some());
        assert!(driver.as_data_table_browser().is_some());
        assert!(driver.as_sql_executor().is_some());
        assert!(driver.as_managed_sql_executor().is_some());
        assert!(driver.as_key_value_browser().is_none());
        assert!(driver.as_transaction_manager().is_none());
    }
}
