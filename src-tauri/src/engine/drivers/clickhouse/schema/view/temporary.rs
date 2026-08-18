#![allow(dead_code)]

use std::collections::BTreeSet;
use std::sync::{Arc, RwLock};

use clickhouse::Client;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, MutexGuard, OwnedMutexGuard};
use uuid::Uuid;

use crate::error::{IpcError, IpcResult};

use super::super::types::{ClickHouseSchemaBlocker, ClickHouseSchemaEditability};
use super::{
    parse_clickhouse_view_create, probe_view_runtime_support, ClickHouseSupportState,
    ClickHouseTemporarySessionState, ClickHouseViewAddress, ClickHouseViewBaseline,
    ClickHouseViewFamily, ClickHouseViewIdentity, ClickHouseViewRuntimeSupport,
    ClickHouseViewSchema, ClickHouseViewScope, ClientViewSupportExecutor,
};
use crate::engine::drivers::clickhouse::ClickHouseDriver;
use crate::engine::types::{ContainerKind, ContainerRef};

const DEFAULT_SESSION_TIMEOUT_SECONDS: u64 = 60;

pub(crate) trait SessionClientConfigurator: Sized {
    fn with_setting(self, name: &str, value: &str) -> Self;
}

impl SessionClientConfigurator for Client {
    fn with_setting(self, name: &str, value: &str) -> Self {
        Client::with_setting(self, name, value)
    }
}

pub(crate) fn configure_session_client<C: SessionClientConfigurator>(
    client: C,
    session: &ClickHouseHttpSession,
) -> C {
    client
        .with_setting("session_id", &session.session_id)
        .with_setting(
            "session_timeout",
            &session.session_timeout_seconds.to_string(),
        )
}

#[derive(Debug)]
pub(crate) struct ClickHouseHttpSession {
    owner_tab_runtime_id: String,
    session_id: String,
    session_timeout_seconds: u64,
    request_mutex: Arc<Mutex<()>>,
    created_temporary_views: RwLock<BTreeSet<String>>,
    state: RwLock<ClickHouseTemporarySessionState>,
}

impl ClickHouseHttpSession {
    pub(crate) fn new(owner_tab_runtime_id: String) -> Self {
        Self {
            owner_tab_runtime_id,
            session_id: Uuid::new_v4().to_string(),
            session_timeout_seconds: DEFAULT_SESSION_TIMEOUT_SECONDS,
            request_mutex: Arc::new(Mutex::new(())),
            created_temporary_views: RwLock::new(BTreeSet::new()),
            state: RwLock::new(ClickHouseTemporarySessionState::Active),
        }
    }

    pub(crate) fn ensure_active(&self, owner_tab_runtime_id: &str) -> IpcResult<()> {
        if self.owner_tab_runtime_id != owner_tab_runtime_id {
            return Err(session_not_found());
        }
        let state = self.state.read().map_err(|_| session_lock_error("state"))?;
        if *state != ClickHouseTemporarySessionState::Active {
            return Err(session_not_found());
        }
        Ok(())
    }

    pub(crate) async fn request_lock(
        &self,
        owner_tab_runtime_id: &str,
    ) -> IpcResult<MutexGuard<'_, ()>> {
        self.ensure_active(owner_tab_runtime_id)?;
        let guard = self.request_mutex.lock().await;
        self.ensure_active(owner_tab_runtime_id)?;
        Ok(guard)
    }

    pub(crate) async fn request_lock_owned(
        self: &Arc<Self>,
        owner_tab_runtime_id: &str,
    ) -> IpcResult<OwnedMutexGuard<()>> {
        self.ensure_active(owner_tab_runtime_id)?;
        let guard = self.request_mutex.clone().lock_owned().await;
        self.ensure_active(owner_tab_runtime_id)?;
        Ok(guard)
    }

    pub(crate) async fn register_view(&self, name: &str) -> IpcResult<()> {
        self.ensure_active(&self.owner_tab_runtime_id)?;
        self.created_temporary_views
            .write()
            .map_err(|_| session_lock_error("created views"))?
            .insert(name.to_string());
        Ok(())
    }

    pub(crate) async fn remove_view(&self, name: &str) -> IpcResult<()> {
        self.created_temporary_views
            .write()
            .map_err(|_| session_lock_error("created views"))?
            .remove(name);
        Ok(())
    }

    pub(crate) async fn created_view_names(&self) -> Vec<String> {
        self.created_temporary_views
            .read()
            .map(|names| names.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub(crate) async fn expire_and_clear(&self) {
        if let Ok(mut state) = self.state.write() {
            *state = ClickHouseTemporarySessionState::Expired;
        }
        if let Ok(mut names) = self.created_temporary_views.write() {
            names.clear();
        }
    }

    pub(crate) fn configured_client(&self, client: Client) -> Client {
        configure_session_client(client, self)
    }

    pub(crate) async fn cleanup_best_effort(&self, client: Client) {
        if let Ok(_guard) = self.request_lock(&self.owner_tab_runtime_id).await {
            let client = self.configured_client(client);
            for name in self.created_view_names().await {
                let statement =
                    format!("DROP VIEW {} SYNC", super::render::quote_identifier(&name));
                let _ = client.query(&statement).execute().await;
                let _ = self.remove_view(&name).await;
            }
        }
        self.expire_and_clear().await;
    }
}

pub(crate) fn session_slot(
    owner_tab_runtime_id: Option<&str>,
    requested_owner_tab_runtime_id: &str,
    slot: &std::sync::OnceLock<Arc<ClickHouseHttpSession>>,
) -> IpcResult<Arc<ClickHouseHttpSession>> {
    let owner = owner_tab_runtime_id
        .filter(|owner| *owner == requested_owner_tab_runtime_id)
        .ok_or_else(session_not_found)?;
    let session = slot
        .get_or_init(|| Arc::new(ClickHouseHttpSession::new(owner.to_string())))
        .clone();
    session.ensure_active(requested_owner_tab_runtime_id)?;
    Ok(session)
}

fn session_not_found() -> IpcError {
    IpcError::resource_not_found(
        "ClickHouse Temporary View owner runtime is unavailable or expired",
    )
}

fn session_lock_error(part: &str) -> IpcError {
    IpcError::system_internal(
        "ClickHouse Temporary View session state is unavailable",
        format!("operation=temporary_session; lock={part}"),
    )
}

#[derive(Debug, clickhouse::Row, Deserialize)]
struct TemporaryViewNameRow {
    name: String,
}

#[derive(Debug, clickhouse::Row, Deserialize)]
struct TemporaryShowCreateRow {
    statement: String,
}

pub(crate) async fn list_temporary_view_schemas(
    driver: &ClickHouseDriver,
    owner_tab_runtime_id: &str,
) -> IpcResult<Vec<ClickHouseViewSchema>> {
    let session = driver.session_for_owner(owner_tab_runtime_id)?;
    let support = probe_view_runtime_support(&ClientViewSupportExecutor::new(driver), None).await?;
    let _guard = session.request_lock(owner_tab_runtime_id).await?;
    let client = session.configured_client(driver.client.clone());
    let names = bounded_session_request(
        driver,
        client
            .query("SELECT name FROM system.tables WHERE is_temporary ORDER BY name")
            .fetch_all::<TemporaryViewNameRow>(),
    )
    .await?;
    let mut schemas = Vec::with_capacity(names.len());
    for row in names {
        schemas.push(
            describe_temporary_view_with_client(
                driver,
                &client,
                owner_tab_runtime_id,
                &row.name,
                &support,
            )
            .await?,
        );
    }
    Ok(schemas)
}

pub(crate) async fn describe_temporary_view(
    driver: &ClickHouseDriver,
    owner_tab_runtime_id: &str,
    container: &ContainerRef,
) -> IpcResult<ClickHouseViewSchema> {
    let name = validate_temporary_container(container)?;
    let session = driver.session_for_owner(owner_tab_runtime_id)?;
    let support = probe_view_runtime_support(&ClientViewSupportExecutor::new(driver), None).await?;
    let _guard = session.request_lock(owner_tab_runtime_id).await?;
    let client = session.configured_client(driver.client.clone());
    describe_temporary_view_with_client(driver, &client, owner_tab_runtime_id, name, &support).await
}

async fn describe_temporary_view_with_client(
    driver: &ClickHouseDriver,
    client: &Client,
    owner_tab_runtime_id: &str,
    name: &str,
    support: &ClickHouseViewRuntimeSupport,
) -> IpcResult<ClickHouseViewSchema> {
    let statement = format!(
        "SHOW CREATE TEMPORARY VIEW {}",
        super::render::quote_identifier(name)
    );
    let row = bounded_session_request(
        driver,
        client
            .query(&statement)
            .fetch_one::<TemporaryShowCreateRow>(),
    )
    .await?;
    temporary_schema_from_create(owner_tab_runtime_id, name, row.statement, support)
}

fn temporary_schema_from_create(
    owner_tab_runtime_id: &str,
    name: &str,
    canonical_create_query: String,
    support: &ClickHouseViewRuntimeSupport,
) -> IpcResult<ClickHouseViewSchema> {
    let parsed = parse_clickhouse_view_create(&canonical_create_query, support)?;
    if parsed.family != ClickHouseViewFamily::Temporary {
        return Err(IpcError::resource_conflict(
            "ClickHouse session object is not a Temporary View",
        ));
    }
    let mut blockers = Vec::new();
    if !parsed.unknown_clauses.is_empty()
        || support.temporary.describe.state != ClickHouseSupportState::Supported
    {
        blockers.push(ClickHouseSchemaBlocker {
            code: "temporary_definition_readonly".to_string(),
            path: "familyDefinition".to_string(),
            message: "ClickHouse Temporary View definition is not fully editable".to_string(),
        });
    }
    let editability = if blockers.is_empty() {
        ClickHouseSchemaEditability::editable()
    } else {
        ClickHouseSchemaEditability {
            mode: super::super::types::ClickHouseSchemaEditabilityMode::Readonly,
            blockers,
        }
    };
    let revision_hash = temporary_revision_hash(
        &canonical_create_query,
        &support.support_revision,
        owner_tab_runtime_id,
    );
    Ok(ClickHouseViewSchema {
        identity: ClickHouseViewIdentity {
            address: ClickHouseViewAddress {
                database: None,
                name: name.to_string(),
                object_kind: ContainerKind::View,
            },
            uuid: None,
        },
        family: ClickHouseViewFamily::Temporary,
        scope: ClickHouseViewScope::Temporary {
            owner_tab_runtime_id: owner_tab_runtime_id.to_string(),
            session_state: ClickHouseTemporarySessionState::Active,
        },
        columns: parsed.columns,
        query: parsed.query,
        security: parsed.security,
        comment: parsed.comment,
        family_definition: parsed.family_definition,
        server_support: support.clone(),
        editability,
        baseline: ClickHouseViewBaseline {
            canonical_create_query,
            revision_hash,
            server_version: support.server_version.clone(),
            family: ClickHouseViewFamily::Temporary,
            support_revision: support.support_revision.clone(),
        },
    })
}

fn validate_temporary_container(container: &ContainerRef) -> IpcResult<&str> {
    if container.kind != ContainerKind::View
        || container.database.is_some()
        || container.schema.is_some()
        || container.group_type.is_some()
        || container.column.is_some()
        || container.object_name.is_some()
    {
        return Err(IpcError::validation_failed(
            "ClickHouse Temporary View container is invalid",
        ));
    }
    container
        .table
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| IpcError::validation_failed("ClickHouse Temporary View name is required"))
}

async fn bounded_session_request<T>(
    driver: &ClickHouseDriver,
    request: impl std::future::Future<Output = Result<T, clickhouse::error::Error>>,
) -> IpcResult<T> {
    if *driver.shutdown.borrow() {
        return Err(IpcError::operation_canceled(
            "ClickHouse Temporary View request canceled",
            "The owner runtime is closing",
        ));
    }
    match tokio::time::timeout(driver.timeout, request).await {
        Err(_) => Err(IpcError::network_timeout(
            "ClickHouse Temporary View request timed out",
            "operation=temporary_view; category=timeout",
        )),
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(super::super::super::error::classify_metadata_error(
            error,
            "inspect Temporary View",
        )),
    }
}

fn temporary_revision_hash(
    canonical_create_query: &str,
    support_revision: &str,
    owner_tab_runtime_id: &str,
) -> String {
    let mut digest = Sha256::new();
    digest.update(b"nexuspilot.clickhouse.view.temporary-baseline.v1\0");
    digest.update(canonical_create_query.as_bytes());
    digest.update([0]);
    digest.update(support_revision.as_bytes());
    digest.update([0]);
    digest.update(owner_tab_runtime_id.as_bytes());
    format!("{:x}", digest.finalize())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use super::*;
    use crate::engine::drivers::clickhouse::schema::{
        ClickHouseClusterDdlSupport, ClickHouseSupportState, ClickHouseViewFamilySupport,
        ClickHouseViewOperationSupport, ClickHouseViewRuntimeSupport,
    };
    use crate::engine::drivers::clickhouse::ClickHouseDriver;
    use crate::error::ErrorCode;

    #[derive(Default)]
    struct FakeSettingsClient {
        settings: Vec<(String, String)>,
    }

    impl SessionClientConfigurator for FakeSettingsClient {
        fn with_setting(mut self, name: &str, value: &str) -> Self {
            self.settings.push((name.to_string(), value.to_string()));
            self
        }
    }

    #[tokio::test]
    async fn temporary_session_is_lazy_opaque_serialized_and_never_recreated_after_expiry() {
        let driver = ClickHouseDriver::new_for_test_tab("25.3.1", "tab-runtime-1");
        let first = driver.session_for_owner("tab-runtime-1").unwrap();
        let second = driver.session_for_owner("tab-runtime-1").unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        assert!(!first.session_id.is_empty());
        assert_ne!(first.session_id, "tab-runtime-1");
        assert!((1..=300).contains(&first.session_timeout_seconds));

        let configured = configure_session_client(FakeSettingsClient::default(), &first);
        assert_eq!(
            configured.settings,
            vec![
                ("session_id".to_string(), first.session_id.clone()),
                (
                    "session_timeout".to_string(),
                    first.session_timeout_seconds.to_string()
                ),
            ]
        );

        let guard = first.request_lock("tab-runtime-1").await.unwrap();
        assert!(tokio::time::timeout(
            Duration::from_millis(20),
            first.request_lock("tab-runtime-1")
        )
        .await
        .is_err());
        drop(guard);

        let (_client, driver_guard) = driver.client_for_request().await.unwrap();
        assert!(driver_guard.is_some());
        assert!(
            tokio::time::timeout(Duration::from_millis(20), driver.client_for_request())
                .await
                .is_err()
        );
        drop(driver_guard);

        first.register_view("temp_events").await.unwrap();
        assert_eq!(first.created_view_names().await, vec!["temp_events"]);
        first.expire_and_clear().await;
        assert!(first.created_view_names().await.is_empty());
        assert_eq!(
            driver.session_for_owner("tab-runtime-1").unwrap_err().code,
            ErrorCode::ResourceNotFound
        );
        assert_eq!(
            driver.session_for_owner("wrong-tab").unwrap_err().code,
            ErrorCode::ResourceNotFound
        );
    }

    #[test]
    fn shared_clickhouse_driver_rejects_temporary_session_ownership() {
        let driver = ClickHouseDriver::new_for_test("25.3.1");
        assert_eq!(
            driver.session_for_owner("tab-runtime-1").unwrap_err().code,
            ErrorCode::ResourceNotFound
        );
    }

    #[test]
    fn temporary_schema_document_exposes_logical_owner_but_never_physical_session_id() {
        let schema = temporary_schema_from_create(
            "tab-runtime-1",
            "temp_events",
            "CREATE TEMPORARY VIEW `temp_events` AS SELECT 1".to_string(),
            &runtime_support(),
        )
        .unwrap();
        let serialized = serde_json::to_string(&schema).unwrap();
        assert!(serialized.contains("ownerTabRuntimeId"));
        assert!(serialized.contains("tab-runtime-1"));
        assert!(!serialized.contains("sessionId"));
        assert!(!serialized.contains("session_id"));
    }

    fn runtime_support() -> ClickHouseViewRuntimeSupport {
        let operation = ClickHouseViewOperationSupport {
            state: ClickHouseSupportState::Supported,
            reason: None,
        };
        let family = ClickHouseViewFamilySupport {
            describe: operation.clone(),
            create: operation.clone(),
            alter: operation.clone(),
            rename: operation.clone(),
            drop: operation,
        };
        ClickHouseViewRuntimeSupport {
            server_version: "25.3.1".to_string(),
            database_engine: Some("Atomic".to_string()),
            normal: family.clone(),
            parameterized: family.clone(),
            temporary: family.clone(),
            materialized: family.clone(),
            refreshable_materialized: family.clone(),
            window: family.clone(),
            live: family,
            cluster_ddl: ClickHouseClusterDdlSupport {
                discoverable: false,
                executable: false,
                observable: false,
                drift_verifiable: false,
            },
            support_revision: "support-revision".to_string(),
        }
    }
}
