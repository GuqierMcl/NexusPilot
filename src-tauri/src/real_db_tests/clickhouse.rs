mod datatable_crud;
mod phase_five_a;
mod phase_five_b;
mod phase_five_c;
mod phase_five_d;
mod phase_five_e;
mod phase_four;
mod phase_four_b;
mod phase_four_c;

use clickhouse::Client;
use serde_json::json;

use crate::commands::engine_commands::test_connection_config;
use crate::engine::drivers::clickhouse::build_endpoint;
use crate::engine::manager::ConnectionRuntimeManager;
use crate::engine::profiles::ClickHouseProtocol;
use crate::engine::types::{
    AssetGroupType, ColumnDataCategory, ColumnMeta, ConnectionRuntimeInfo, ContainerKind,
    ContainerProperty, ContainerRef, DataContainer, DriverCapabilities, QueryResult,
    RuntimeHealthStatus, SchemaMutationOperation, SqlExecutionContext, SqlExecutionFeatures,
    SqlStatementAccess, TableBrowseQuery,
};
use crate::error::{ErrorCode, RuntimeErrorImpact};
use crate::repository::connection_repository::{ConnectionDriver, StoredConnectionRecord};

use super::common::{run_async, TestEnv};

const PROFILE_ID: &str = "real-clickhouse-smoke";
const TAB_ID: &str = "real-clickhouse-tab";

#[test]
#[ignore = "requires explicit real ClickHouse credentials and write gates"]
fn real_clickhouse_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            eprintln!("real ClickHouse connection smoke skipped: .env.test is absent");
            eprintln!("ClickHouse Phase 5A Describe checkpoint not satisfied: .env.test is absent");
            eprintln!(
                "ClickHouse Phase 5B native create checkpoint not satisfied: .env.test is absent"
            );
            eprintln!(
                "ClickHouse Phase 5C direct change checkpoint not satisfied: .env.test is absent"
            );
            eprintln!(
                "ClickHouse Phase 5D direct object checkpoint not satisfied: .env.test is absent"
            );
            eprintln!(
                "ClickHouse Phase 5E direct view checkpoint not satisfied: .env.test is absent"
            );
            return;
        };
        if !env.enabled("NEXPILOT_TEST_CLICKHOUSE_ENABLED") {
            eprintln!(
                "real ClickHouse connection smoke skipped: NEXPILOT_TEST_CLICKHOUSE_ENABLED=false"
            );
            eprintln!(
                "ClickHouse Phase 5A Describe checkpoint not satisfied: NEXPILOT_TEST_CLICKHOUSE_ENABLED=false"
            );
            eprintln!(
                "ClickHouse Phase 5B native create checkpoint not satisfied: NEXPILOT_TEST_CLICKHOUSE_ENABLED=false"
            );
            eprintln!(
                "ClickHouse Phase 5C direct change checkpoint not satisfied: NEXPILOT_TEST_CLICKHOUSE_ENABLED=false"
            );
            eprintln!(
                "ClickHouse Phase 5D direct object checkpoint not satisfied: NEXPILOT_TEST_CLICKHOUSE_ENABLED=false"
            );
            eprintln!(
                "ClickHouse Phase 5E direct view checkpoint not satisfied: NEXPILOT_TEST_CLICKHOUSE_ENABLED=false"
            );
            return;
        }

        let protocol = strict_protocol(&env.required("NEXPILOT_TEST_CLICKHOUSE_PROTOCOL"));
        let host = env.required("NEXPILOT_TEST_CLICKHOUSE_HOST");
        let port = env.u16_or(
            "NEXPILOT_TEST_CLICKHOUSE_PORT",
            if protocol == "https" { 8443 } else { 8123 },
        );
        let username = env.required("NEXPILOT_TEST_CLICKHOUSE_USERNAME");
        let password = env
            .optional("NEXPILOT_TEST_CLICKHOUSE_PASSWORD")
            .unwrap_or_default();
        let database = env.required("NEXPILOT_TEST_CLICKHOUSE_DATABASE");
        let timeout = env.u64_or("NEXPILOT_TEST_CONNECT_TIMEOUT_SECONDS", 10);
        let payload = json!({
            "host": host,
            "port": port,
            "username": username,
            "password": password,
            "defaultDatabase": database,
            "protocol": protocol,
            "connectTimeoutSeconds": timeout
        });

        let test_result = test_connection_config(ConnectionDriver::Clickhouse, payload.clone())
            .await
            .expect("ClickHouse test_connection_config should pass real probes");
        assert_eq!(test_result.driver_name, "clickhouse");
        let endpoint_protocol = match protocol {
            "http" => ClickHouseProtocol::Http,
            "https" => ClickHouseProtocol::Https,
            _ => unreachable!("strict_protocol only returns supported protocols"),
        };
        assert_eq!(
            test_result.endpoint,
            format!(
                "{}/{database}",
                build_endpoint(endpoint_protocol, &host, port)
                    .expect("validated smoke host should build a safe endpoint")
            )
        );
        let server_version = test_result
            .server_version
            .as_deref()
            .expect("ClickHouse test connection should return version()");
        assert!(!server_version.trim().is_empty());

        let manager = ConnectionRuntimeManager::new();
        let record = stored_clickhouse_record(payload);
        let shared_info = manager
            .connect_profile(PROFILE_ID, &record)
            .await
            .expect("ClickHouse connect_profile should create a shared runtime");
        assert_phase_five_e_runtime_info(&shared_info);
        let tab_info = manager
            .open_tab_runtime(PROFILE_ID, TAB_ID, &record)
            .await
            .expect("ClickHouse open_tab_runtime should create a tab runtime");
        assert_phase_five_e_runtime_info(&tab_info);
        verify_phase_three_readonly_sql_baseline(&manager, &database).await;

        let root = manager
            .list_containers(PROFILE_ID, None)
            .await
            .expect("ClickHouse root metadata should load");
        assert!(root
            .iter()
            .any(|item| { item.kind == ContainerKind::Database && item.name == database }));
        let system = root
            .iter()
            .find(|item| item.kind == ContainerKind::Database && item.name == "system")
            .expect("ClickHouse system database should be an ordinary database node");
        assert_eq!(system.container, ContainerRef::database("system"));
        let functions_group = find_group(&root, AssetGroupType::Functions)
            .expect("root should expose server-global functions");
        assert!(functions_group.container.database.is_none());
        let functions = manager
            .list_containers(PROFILE_ID, Some(functions_group.container.clone()))
            .await
            .expect("ClickHouse built-in functions should load");
        assert!(functions.iter().any(|item| item.name == "arrayMap"));

        let database_node = root
            .iter()
            .find(|item| item.kind == ContainerKind::Database && item.name == database)
            .expect("configured ClickHouse database should be present");
        let database_groups = manager
            .list_containers(PROFILE_ID, Some(database_node.container.clone()))
            .await
            .expect("ClickHouse database asset groups should load");
        for group_type in [
            AssetGroupType::Tables,
            AssetGroupType::Views,
            AssetGroupType::MaterializedViews,
            AssetGroupType::Dictionaries,
        ] {
            assert!(find_group(&database_groups, group_type).is_some());
        }

        if let Some(read_table) = env.optional("NEXPILOT_TEST_CLICKHOUSE_READ_TABLE") {
            verify_existing_table_metadata(&manager, &database_groups, &read_table).await;
        } else {
            eprintln!(
                "ClickHouse existing table metadata evidence skipped: \
                 NEXPILOT_TEST_CLICKHOUSE_READ_TABLE is empty"
            );
        }

        let client = Client::default()
            .with_url(
                build_endpoint(endpoint_protocol, &host, port)
                    .expect("validated smoke host should build a safe endpoint"),
            )
            .with_user(username.clone())
            .with_password(password.clone())
            .with_database(database.clone());

        let writes_enabled = env.enabled("NEXPILOT_TEST_ALLOW_WRITES");
        let mut phase_four_b_passed = false;
        let mut phase_four_c_passed = false;
        if write_fixture_enabled(true, writes_enabled) {
            let prefix = env
                .optional("NEXPILOT_TEST_CLICKHOUSE_SCRATCH_PREFIX")
                .unwrap_or_else(|| "nexpilot_it_".to_string());
            validate_scratch_prefix(&prefix).expect("valid ClickHouse scratch prefix");
            run_write_fixture(&client, &manager, &database, &prefix)
                .await
                .expect("ClickHouse write-gated metadata fixture should pass");
            run_phase_three_fixture(&client, &manager, &database, &prefix)
                .await
                .expect("ClickHouse write-gated Phase 3 fixture should pass");
            eprintln!(
                "ClickHouse write-gated Phase 3 fixture passed: \
                 type matrix/DataTable paging/exact count/read-only SQL/side-effect proof"
            );
            let crud_evidence =
                datatable_crud::run(&manager, PROFILE_ID, TAB_ID, &client, &database, &prefix)
                    .await
                    .expect("ClickHouse basic DataTable CRUD checkpoint should pass");
            eprintln!("{}", crud_evidence.marker());
            let phase_five_a_evidence =
                phase_five_a::run(&manager, PROFILE_ID, &client, &database, &prefix)
                    .await
                    .expect("ClickHouse Phase 5A real Describe checkpoint should pass");
            eprintln!(
                "ClickHouse Phase 5A Describe checkpoint passed: \
                 server_version={}; engines={}; described_tables={}",
                phase_five_a_evidence.server_version,
                phase_five_a_evidence.engines.join(","),
                phase_five_a_evidence.described_tables,
            );
            let phase_five_b_evidence = phase_five_b::run_direct(
                &record,
                &client,
                &prefix,
                phase_five_b::PhaseFiveBCapabilityExpectation::Published,
            )
            .await
            .unwrap_or_else(|error| {
                panic!(
                    "ClickHouse Phase 5B direct native create checkpoint failed: code={:?}; message={}",
                    error.code, error.message,
                )
            });
            assert!(phase_five_b_evidence.database_created);
            assert_eq!(phase_five_b_evidence.described_tables, 3);
            assert_eq!(phase_five_b_evidence.duplicate_conflicts, 2);
            eprintln!(
                "ClickHouse Phase 5B native create checkpoint passed: \
                 server_version={}; engines={}; described_tables={}; duplicate_conflicts={}",
                phase_five_b_evidence.server_version,
                phase_five_b_evidence.engines.join(","),
                phase_five_b_evidence.described_tables,
                phase_five_b_evidence.duplicate_conflicts,
            );
            let phase_five_c_evidence = phase_five_c::run_direct(&record, &client, &prefix)
                .await
                .unwrap_or_else(|error| {
                    panic!(
                        "ClickHouse Phase 5C direct change checkpoint failed: code={:?}; message={}",
                        error.code, error.message,
                    )
                });
            assert!(phase_five_c_evidence.safe_alter_operations > 0);
            assert!(phase_five_c_evidence.destructive_rejections > 0);
            assert!(phase_five_c_evidence.destructive_applied > 0);
            assert_eq!(phase_five_c_evidence.drift_conflicts, 2);
            assert_eq!(phase_five_c_evidence.unsupported_rejections, 4);
            assert_eq!(phase_five_c_evidence.submitted_actions, 2);
            assert!(phase_five_c_evidence.dropped_columns > 0);
            assert_eq!(phase_five_c_evidence.dropped_tables, 1);
            assert_eq!(phase_five_c_evidence.dropped_databases, 1);
            eprintln!("{}", phase_five_c_evidence.marker());
            let phase_five_d_evidence = phase_five_d::run_direct(&record, &client, &prefix)
                .await
                .unwrap_or_else(|error| {
                    panic!(
                        "ClickHouse Phase 5D direct object checkpoint failed: code={:?}; message={}",
                        error.code, error.message,
                    )
                });
            assert_eq!(phase_five_d_evidence.projections_created, 2);
            assert_eq!(phase_five_d_evidence.index_types_created, 5);
            assert!(phase_five_d_evidence.destructive_rejections > 0);
            assert_eq!(phase_five_d_evidence.submitted_actions, 4);
            assert!(phase_five_d_evidence.drift_conflicts > 0);
            assert!(phase_five_d_evidence.unsupported_rejections > 0);
            assert_eq!(phase_five_d_evidence.projections_dropped, 2);
            assert_eq!(phase_five_d_evidence.indexes_dropped, 5);
            eprintln!("{}", phase_five_d_evidence.marker());
            let phase_five_e_evidence = phase_five_e::run_direct(&record, &client, &prefix)
                .await
                .unwrap_or_else(|error| {
                    panic!(
                        "ClickHouse Phase 5E direct view checkpoint failed: code={:?}; message={}",
                        error.code, error.message,
                    )
                });
            eprintln!("{}", phase_five_e_evidence.marker());
            let phase_five_e_manager_evidence =
                phase_five_e::run_manager(&manager, PROFILE_ID, &record, &client, &prefix)
                    .await
                    .unwrap_or_else(|error| {
                        panic!(
                            "ClickHouse Phase 5E Manager-gated view checkpoint failed: code={:?}; message={}",
                            error.code, error.message,
                        )
                    });
            assert_eq!(phase_five_e_manager_evidence, phase_five_e_evidence);
            eprintln!("{}", phase_five_e_manager_evidence.manager_marker());
            let phase_five_b_manager_evidence =
                phase_five_b::run_manager(&manager, PROFILE_ID, &client, &prefix)
                    .await
                    .unwrap_or_else(|error| {
                        panic!(
                            "ClickHouse Phase 5B Manager-gated create checkpoint failed: code={:?}; message={}",
                            error.code, error.message,
                        )
                    });
            assert!(phase_five_b_manager_evidence.database_created);
            assert_eq!(phase_five_b_manager_evidence.described_tables, 3);
            assert_eq!(phase_five_b_manager_evidence.duplicate_conflicts, 2);
            eprintln!(
                "ClickHouse Phase 5B Manager-gated create checkpoint passed: \
                 server_version={}; engines={}; described_tables={}; duplicate_conflicts={}",
                phase_five_b_manager_evidence.server_version,
                phase_five_b_manager_evidence.engines.join(","),
                phase_five_b_manager_evidence.described_tables,
                phase_five_b_manager_evidence.duplicate_conflicts,
            );
            let phase_five_c_manager_evidence =
                phase_five_c::run_manager(&manager, PROFILE_ID, &client, &prefix)
                    .await
                    .unwrap_or_else(|error| {
                        panic!(
                            "ClickHouse Phase 5C Manager-gated change checkpoint failed: code={:?}; message={}",
                            error.code, error.message,
                        )
                    });
            assert!(phase_five_c_manager_evidence.safe_alter_operations > 0);
            assert!(phase_five_c_manager_evidence.destructive_rejections > 0);
            assert!(phase_five_c_manager_evidence.destructive_applied > 0);
            assert_eq!(phase_five_c_manager_evidence.drift_conflicts, 2);
            assert_eq!(phase_five_c_manager_evidence.unsupported_rejections, 4);
            assert_eq!(phase_five_c_manager_evidence.submitted_actions, 2);
            assert!(phase_five_c_manager_evidence.dropped_columns > 0);
            assert_eq!(phase_five_c_manager_evidence.dropped_tables, 1);
            assert_eq!(phase_five_c_manager_evidence.dropped_databases, 1);
            eprintln!("{}", phase_five_c_manager_evidence.manager_marker());
            let phase_five_d_manager_evidence =
                phase_five_d::run_manager(&manager, PROFILE_ID, &client, &prefix)
                    .await
                    .unwrap_or_else(|error| {
                        panic!(
                            "ClickHouse Phase 5D Manager-gated object checkpoint failed: code={:?}; message={}",
                            error.code, error.message,
                        )
                    });
            assert_eq!(phase_five_d_manager_evidence.projections_created, 2);
            assert_eq!(phase_five_d_manager_evidence.index_types_created, 5);
            assert!(phase_five_d_manager_evidence.destructive_rejections > 0);
            assert_eq!(phase_five_d_manager_evidence.submitted_actions, 4);
            assert!(phase_five_d_manager_evidence.drift_conflicts > 0);
            assert!(phase_five_d_manager_evidence.unsupported_rejections > 0);
            assert_eq!(phase_five_d_manager_evidence.projections_dropped, 2);
            assert_eq!(phase_five_d_manager_evidence.indexes_dropped, 5);
            eprintln!("{}", phase_five_d_manager_evidence.manager_marker());
            if protocol == "http" {
                phase_four_b::run(&manager, PROFILE_ID, &record, &client, &database, &prefix)
                    .await
                    .expect("ClickHouse Phase 4B real HTTP write checkpoint should pass");
                phase_four_b_passed = true;
            } else {
                eprintln!(
                    "ClickHouse Phase 4B real HTTP write checkpoint not satisfied: configured protocol is not http"
                );
            }
        } else {
            eprintln!(
                "ClickHouse write metadata fixture skipped: \
                 NEXPILOT_TEST_ALLOW_WRITES=false"
            );
            eprintln!(
                "ClickHouse Phase 4B real HTTP write checkpoint not satisfied: NEXPILOT_TEST_ALLOW_WRITES=false"
            );
            eprintln!(
                "ClickHouse Phase 5A Describe checkpoint not satisfied: NEXPILOT_TEST_ALLOW_WRITES=false"
            );
            eprintln!(
                "ClickHouse Phase 5B native create checkpoint not satisfied: NEXPILOT_TEST_ALLOW_WRITES=false"
            );
            eprintln!(
                "ClickHouse Phase 5C direct change checkpoint not satisfied: NEXPILOT_TEST_ALLOW_WRITES=false"
            );
            eprintln!(
                "ClickHouse Phase 5D direct object checkpoint not satisfied: NEXPILOT_TEST_ALLOW_WRITES=false"
            );
            eprintln!(
                "ClickHouse Phase 5E direct view checkpoint not satisfied: NEXPILOT_TEST_ALLOW_WRITES=false"
            );
        }
        report_optional_evidence_skips(&env, protocol);
        let phase_four_cleanup = if protocol == "http" {
            Some(
                phase_four::run(&manager, PROFILE_ID, &record, &client, &database)
                    .await
                    .expect("ClickHouse Phase 4A real managed checkpoint should pass"),
            )
        } else {
            eprintln!(
                "ClickHouse Phase 4A real HTTP checkpoint not satisfied: configured protocol is not http"
            );
            None
        };
        if writes_enabled && protocol == "http" {
            phase_four_c::run(PROFILE_ID, &record, &client, &database)
                .await
                .expect("ClickHouse Phase 4C real HTTP Raw checkpoint should pass");
            phase_four_c_passed = true;
        } else if protocol != "http" {
            eprintln!(
                "ClickHouse Phase 4C real HTTP Raw checkpoint not satisfied: configured protocol is not http"
            );
        } else {
            eprintln!(
                "ClickHouse Phase 4C real HTTP Raw checkpoint not satisfied: NEXPILOT_TEST_ALLOW_WRITES=false"
            );
        }
        manager
            .ping(PROFILE_ID)
            .await
            .expect("ClickHouse shared runtime should ping");
        let health = manager
            .health(PROFILE_ID)
            .expect("ClickHouse shared runtime should expose health");
        assert_eq!(health.profile_id, PROFILE_ID);
        assert_eq!(health.status, RuntimeHealthStatus::Healthy);
        assert_eq!(health.consecutive_failures, 0);
        assert!(health.last_success_at_ms.is_some());
        assert_eq!(health.last_failure_at_ms, None);
        assert_eq!(health.last_error_code, None);

        manager
            .close_tab_runtime(TAB_ID)
            .await
            .expect("ClickHouse tab runtime should close");

        manager
            .disconnect_profile(PROFILE_ID)
            .await
            .expect("ClickHouse shared runtime should disconnect");
        if let Some(evidence) = phase_four_cleanup.as_ref() {
            phase_four::assert_profile_cleanup(&manager, PROFILE_ID, evidence);
        }
        let missing_health = manager
            .health(PROFILE_ID)
            .expect_err("disconnected ClickHouse runtime should not retain health");
        assert_eq!(missing_health.code, ErrorCode::ResourceNotFound);
        let missing_metadata = manager
            .list_containers(PROFILE_ID, None)
            .await
            .expect_err("disconnected ClickHouse runtime should not load metadata");
        assert_eq!(missing_metadata.code, ErrorCode::ResourceNotFound);

        if phase_four_cleanup.is_some() {
            eprintln!(
                "ClickHouse Phase 4A real HTTP checkpoint passed: \
                 managed/query-id/progress-or-unavailable/confirmed-cancel/timeout/ping/tab-profile-cleanup"
            );
        }
        if phase_four_b_passed {
            eprintln!(
                "ClickHouse Phase 4B real HTTP write checkpoint passed: \
                 direct-ddl/insert/alter/mutation/delete/managed-sequences/stop-queue/cancel-active/cleanup"
            );
        }
        if phase_four_c_passed {
            eprintln!("{}", phase_four_c::PHASE_FOUR_C_MARKER);
        }

        eprintln!(
            "real ClickHouse connection smoke passed; protocol={protocol}; server_version={server_version}"
        );
    });
}

fn strict_protocol(value: &str) -> &'static str {
    match value {
        "http" => "http",
        "https" => "https",
        _ => panic!("NEXPILOT_TEST_CLICKHOUSE_PROTOCOL must be exactly http or https"),
    }
}

fn write_fixture_enabled(clickhouse_enabled: bool, writes_enabled: bool) -> bool {
    clickhouse_enabled && writes_enabled
}

fn validate_scratch_prefix(prefix: &str) -> Result<(), &'static str> {
    let mut characters = prefix.chars();
    let Some(first) = characters.next() else {
        return Err("ClickHouse scratch prefix must not be empty");
    };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return Err("ClickHouse scratch prefix must start with an ASCII letter or underscore");
    }
    if prefix.len() > 48
        || !characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        return Err(
            "ClickHouse scratch prefix must contain only ASCII letters, numbers, and underscores",
        );
    }
    Ok(())
}

fn scratch_object_name(prefix: &str, suffix: &str) -> String {
    format!("{prefix}{suffix}")
}

fn quote_test_identifier(identifier: &str) -> String {
    format!("`{identifier}`")
}

fn optional_type_skip_label(type_name: &str) -> String {
    format!("ClickHouse {type_name} real evidence skipped")
}

fn find_group(containers: &[DataContainer], group_type: AssetGroupType) -> Option<&DataContainer> {
    containers
        .iter()
        .find(|item| item.container.group_type == Some(group_type.clone()))
}

fn property<'a>(container: &'a DataContainer, key: &str) -> Option<&'a ContainerProperty> {
    container
        .properties
        .iter()
        .find(|property| property.key == key)
}

async fn verify_existing_table_metadata(
    manager: &ConnectionRuntimeManager,
    database_groups: &[DataContainer],
    read_table: &str,
) {
    let tables_group = find_group(database_groups, AssetGroupType::Tables)
        .expect("ClickHouse database should expose tables group");
    let tables = manager
        .list_containers(PROFILE_ID, Some(tables_group.container.clone()))
        .await
        .expect("ClickHouse tables should load");
    let table = tables
        .iter()
        .find(|item| item.name == read_table)
        .unwrap_or_else(|| panic!("missing configured ClickHouse table {read_table}"));
    let table_groups = manager
        .list_containers(PROFILE_ID, Some(table.container.clone()))
        .await
        .expect("ClickHouse table groups should load");
    let columns_group = find_group(&table_groups, AssetGroupType::Columns)
        .expect("ClickHouse table should expose columns group");
    let columns = manager
        .list_containers(PROFILE_ID, Some(columns_group.container.clone()))
        .await
        .expect("ClickHouse columns should load");
    assert!(
        !columns.is_empty(),
        "configured ClickHouse table has no columns"
    );
}

fn clickhouse_sql_context(database: &str) -> SqlExecutionContext {
    SqlExecutionContext {
        database: Some(database.to_string()),
        schema: None,
    }
}

async fn verify_phase_three_readonly_sql_baseline(
    manager: &ConnectionRuntimeManager,
    database: &str,
) {
    let context = clickhouse_sql_context(database);
    for sql in [
        "SELECT toUInt64(1) AS one",
        "WITH 2 AS two SELECT two",
        "SHOW TABLES",
        "DESCRIBE TABLE system.one",
        "EXPLAIN SELECT 1",
    ] {
        let result = manager
            .execute_sql(PROFILE_ID, TAB_ID, &context, sql, 1, 100)
            .await
            .unwrap_or_else(|error| panic!("ClickHouse Phase 3 SQL failed ({:?})", error.code));
        assert!(!result.columns.is_empty(), "{sql}");
        assert_readonly_query_result(&result).expect("baseline SQL result should be read-only");
    }

    for sql in [
        "SELECT 1 FORMAT JSON",
        "SELECT 1 INTO OUTFILE 'nexpilot-must-not-exist'",
        "SELECT 1; SELECT 2",
    ] {
        let error = manager
            .execute_sql(PROFILE_ID, TAB_ID, &context, sql, 1, 100)
            .await
            .expect_err("protocol conflicts must be rejected locally");
        assert_eq!(error.code, ErrorCode::ValidationFailed, "{sql}");
        assert_eq!(error.runtime_impact, RuntimeErrorImpact::BusinessOnly);
    }

    let schema_error = manager
        .execute_sql(
            PROFILE_ID,
            TAB_ID,
            &SqlExecutionContext {
                database: Some(database.to_string()),
                schema: Some("public".to_string()),
            },
            "SELECT 1",
            1,
            100,
        )
        .await
        .expect_err("ClickHouse schema context must be rejected");
    assert_eq!(schema_error.code, ErrorCode::ValidationFailed);

    probe_optional_phase_three_types(manager, &context).await;
}

async fn probe_optional_phase_three_types(
    manager: &ConnectionRuntimeManager,
    context: &SqlExecutionContext,
) {
    let probes = [
        (
            "JSON",
            r#"SELECT CAST('{"name":"NexusPilot"}', 'JSON') AS value"#,
        ),
        (
            "Object",
            r#"SELECT CAST('{"name":"NexusPilot"}', 'Object(\'json\')') AS value"#,
        ),
        (
            "Variant",
            "SELECT CAST(toUInt64(42), 'Variant(UInt64, String)') AS value",
        ),
    ];
    for (type_name, sql) in probes {
        match manager
            .execute_sql(PROFILE_ID, TAB_ID, context, sql, 1, 10)
            .await
        {
            Ok(result) => {
                assert!(!result.columns.is_empty());
                assert_readonly_query_result(&result)
                    .expect("optional type result should remain read-only");
                eprintln!("ClickHouse {type_name} real evidence passed");
            }
            Err(error) => eprintln!(
                "{}: server returned {:?}",
                optional_type_skip_label(type_name),
                error.code,
            ),
        }
    }
}

async fn execute_fixture_sql(client: &Client, operation: &str, sql: &str) -> Result<(), String> {
    client
        .query(sql)
        .execute()
        .await
        .map_err(|error| format!("{operation} failed: {error}"))
}

async fn cleanup_fixture(client: &Client, table: &str, view: &str, mv: &str) -> Vec<String> {
    let statements = [
        (
            "drop materialized view",
            format!("DROP VIEW IF EXISTS {mv}"),
        ),
        ("drop view", format!("DROP VIEW IF EXISTS {view}")),
        ("drop table", format!("DROP TABLE IF EXISTS {table}")),
    ];
    let mut failures = Vec::new();
    for (operation, sql) in statements {
        if let Err(error) = execute_fixture_sql(client, operation, &sql).await {
            failures.push(error);
        }
    }
    failures
}

async fn run_write_fixture(
    client: &Client,
    manager: &ConnectionRuntimeManager,
    database_name: &str,
    prefix: &str,
) -> Result<(), String> {
    let table_name = scratch_object_name(prefix, "events");
    let view_name = scratch_object_name(prefix, "events_view");
    let mv_name = scratch_object_name(prefix, "events_mv");
    let table = quote_test_identifier(&table_name);
    let view = quote_test_identifier(&view_name);
    let mv = quote_test_identifier(&mv_name);

    let _ = cleanup_fixture(client, &table, &view, &mv).await;
    let fixture_result = async {
        let create_table = format!(
            r#"CREATE TABLE {table} (
                event_date Date DEFAULT today() CODEC(Delta, ZSTD),
                user_id UInt64,
                value UInt64,
                INDEX value_minmax value TYPE minmax GRANULARITY 1,
                PROJECTION daily (
                    SELECT event_date, sum(value) GROUP BY event_date
                )
            )
            ENGINE = MergeTree
            PARTITION BY toYYYYMM(event_date)
            ORDER BY (event_date, user_id)"#,
        );
        execute_fixture_sql(client, "create table", &create_table).await?;

        let create_view = format!(
            "CREATE VIEW {view} AS \
             SELECT event_date, user_id, value FROM {table}",
        );
        execute_fixture_sql(client, "create view", &create_view).await?;

        let create_mv = format!(
            "CREATE MATERIALIZED VIEW {mv} ENGINE = MergeTree \
             ORDER BY event_date AS \
             SELECT event_date, sum(value) AS value FROM {table} GROUP BY event_date",
        );
        execute_fixture_sql(client, "create materialized view", &create_mv).await?;

        let insert = format!(
            "INSERT INTO {table} (event_date, user_id, value) VALUES \
             ('2026-07-01', 1, 10), ('2026-08-01', 2, 20)",
        );
        execute_fixture_sql(client, "insert partition fixtures", &insert).await?;

        verify_write_fixture_metadata(manager, database_name, &table_name, &view_name, &mv_name)
            .await
    }
    .await;

    let cleanup_failures = cleanup_fixture(client, &table, &view, &mv).await;
    if let Err(error) = fixture_result {
        return Err(if cleanup_failures.is_empty() {
            error
        } else {
            format!(
                "{error}; cleanup failures: {}",
                cleanup_failures.join(" | ")
            )
        });
    }
    if !cleanup_failures.is_empty() {
        return Err(format!(
            "ClickHouse fixture cleanup failed: {}",
            cleanup_failures.join(" | "),
        ));
    }
    Ok(())
}

async fn cleanup_phase_three_fixture(
    client: &Client,
    table: &str,
    view: &str,
    mv: &str,
) -> Vec<String> {
    cleanup_fixture(client, table, view, mv).await
}

async fn run_phase_three_fixture(
    client: &Client,
    manager: &ConnectionRuntimeManager,
    database_name: &str,
    prefix: &str,
) -> Result<(), String> {
    let table_name = scratch_object_name(prefix, "phase3_types");
    let view_name = scratch_object_name(prefix, "phase3_types_view");
    let mv_name = scratch_object_name(prefix, "phase3_types_mv");
    let table = quote_test_identifier(&table_name);
    let view = quote_test_identifier(&view_name);
    let mv = quote_test_identifier(&mv_name);

    let _ = cleanup_phase_three_fixture(client, &table, &view, &mv).await;
    let fixture_result = async {
        let create_table = format!(
            r#"CREATE TABLE {table} (
                id UInt64,
                i8 Int8,
                i16 Int16,
                i32 Int32,
                i64 Int64,
                i128 Int128,
                i256 Int256,
                u8 UInt8,
                u16 UInt16,
                u32 UInt32,
                u128 UInt128,
                u256 UInt256,
                f32 Float32,
                f64 Float64,
                exact Decimal(38, 10),
                enabled Bool,
                text String,
                fixed FixedString(8),
                day Date,
                day32 Date32,
                moment DateTime('Asia/Hong_Kong'),
                moment64 DateTime64(6, 'Asia/Hong_Kong'),
                uuid UUID,
                ip4 IPv4,
                ip6 IPv6,
                state Enum8('ready' = 1, 'done' = 2),
                optional Nullable(String),
                low LowCardinality(String),
                tags Array(String),
                attrs Map(UInt64, Decimal(20, 4)),
                pair Tuple(id UInt64, label String),
                nested Nested(code UInt64, label String)
            ) ENGINE = MergeTree ORDER BY id"#,
        );
        execute_fixture_sql(client, "create Phase 3 type table", &create_table).await?;

        execute_fixture_sql(
            client,
            "create Phase 3 view",
            &format!(
                "CREATE VIEW {view} AS SELECT id, text, tags, attrs, pair FROM {table} ORDER BY id"
            ),
        )
        .await?;
        execute_fixture_sql(
            client,
            "create Phase 3 materialized view",
            &format!(
                "CREATE MATERIALIZED VIEW {mv} ENGINE = MergeTree ORDER BY id AS \
                 SELECT id, text FROM {table}"
            ),
        )
        .await?;

        let insert = format!(
            r#"INSERT INTO {table} (
                id, i8, i16, i32, i64, i128, i256,
                u8, u16, u32, u128, u256, f32, f64, exact,
                enabled, text, fixed, day, day32, moment, moment64,
                uuid, ip4, ip6, state, optional, low, tags, attrs, pair,
                `nested.code`, `nested.label`
            )
            SELECT
                toUInt64(number + 1),
                toInt8(toInt64(number) - 2),
                toInt16(toInt64(number) - 200),
                toInt32(toInt64(number) - 30000),
                toInt64(number) - 9007199254740993,
                toInt128('-9007199254740994') - toInt128(number),
                toInt256('-9007199254740995') - toInt256(number),
                toUInt8(number),
                toUInt16(number + 1000),
                toUInt32(number + 100000),
                toUInt128('18446744073709551616') + toUInt128(number),
                toUInt256('340282366920938463463374607431768211456') + toUInt256(number),
                toFloat32(number) + toFloat32(0.25),
                multiIf(number = 2, toFloat64('nan'), number = 3, toFloat64('inf'), toFloat64(number) + 0.5),
                toDecimal256('1234567890123456789012345678.1200000000', 10),
                number % 2 = 0,
                concat('row-', toString(number), ' Ω\n控制'),
                toFixedString(concat('r', toString(number)), 8),
                addDays(toDate('2026-07-01'), number),
                toDate32(addDays(toDate32('2026-07-01'), number)),
                toDateTime('2026-07-01 12:34:56', 'Asia/Hong_Kong') + number,
                toDateTime64('2026-07-01 12:34:56.123456', 6, 'Asia/Hong_Kong') + number,
                toUUID('550e8400-e29b-41d4-a716-446655440000'),
                toIPv4('192.0.2.1'),
                toIPv6('2001:db8::1'),
                if(number % 2 = 0, 'ready', 'done'),
                if(number = 2, CAST(NULL, 'Nullable(String)'), concat('optional-', toString(number))),
                concat('low-', toString(number)),
                [concat('tag-', toString(number)), '控制'],
                map(toUInt64(number + 1), toDecimal64('12.3400', 4)),
                tuple(toUInt64(number), concat('pair-', toString(number))),
                [toUInt64(number)],
                [concat('nested-', toString(number))]
            FROM numbers(5)"#,
        );
        execute_fixture_sql(client, "insert Phase 3 type rows", &insert).await?;

        verify_phase_three_data_table(
            manager,
            database_name,
            &table_name,
            &view_name,
            &mv_name,
        )
        .await?;
        verify_phase_three_fixture_sql(manager, database_name, &table, &table_name).await
    }
    .await;

    let cleanup_failures = cleanup_phase_three_fixture(client, &table, &view, &mv).await;
    if let Err(error) = fixture_result {
        return Err(if cleanup_failures.is_empty() {
            error
        } else {
            format!(
                "{error}; cleanup failures: {}",
                cleanup_failures.join(" | ")
            )
        });
    }
    if !cleanup_failures.is_empty() {
        return Err(format!(
            "ClickHouse Phase 3 cleanup failed: {}",
            cleanup_failures.join(" | "),
        ));
    }
    Ok(())
}

async fn verify_phase_three_data_table(
    manager: &ConnectionRuntimeManager,
    database_name: &str,
    table_name: &str,
    view_name: &str,
    mv_name: &str,
) -> Result<(), String> {
    let query = TableBrowseQuery::default();
    let table = ContainerRef::table(ContainerKind::Table, database_name, None, table_name);
    let mut pages = Vec::new();
    for page in 1..=3 {
        pages.push(
            manager
                .browse_table_data(PROFILE_ID, Some(TAB_ID), &table, page, 2, &query)
                .await
                .map_err(|error| format!("browse Phase 3 page {page}: {:?}", error.code))?,
        );
    }
    ensure(
        pages[0].has_next_page,
        "Phase 3 page 1 should have a next page",
    )?;
    ensure(
        pages[1].has_next_page,
        "Phase 3 page 2 should have a next page",
    )?;
    ensure(
        !pages[2].has_next_page,
        "Phase 3 page 3 should be the final page",
    )?;
    ensure(
        page_ids(&pages[0])? == vec![1, 2],
        "unexpected Phase 3 page 1",
    )?;
    ensure(
        page_ids(&pages[1])? == vec![3, 4],
        "unexpected Phase 3 page 2",
    )?;
    ensure(page_ids(&pages[2])? == vec![5], "unexpected Phase 3 page 3")?;
    assert_clickhouse_table_write_capabilities(&pages[0])?;
    verify_phase_three_type_columns(&pages[0])?;
    verify_phase_three_exact_values(&pages[0])?;
    verify_phase_three_nullable_and_special_values(&pages[1])?;

    let stats = manager
        .get_table_page_stats(PROFILE_ID, Some(TAB_ID), &table, 2, &query, Some(3))
        .await
        .map_err(|error| format!("count Phase 3 table: {:?}", error.code))?;
    ensure(stats.total_rows == 5, "Phase 3 exact count should be 5")?;
    ensure(stats.total_pages == 3, "Phase 3 exact pages should be 3")?;
    ensure(stats.page_size == 2, "Phase 3 stats page size should be 2")?;

    for (kind, object_name) in [
        (ContainerKind::View, view_name),
        (ContainerKind::MaterializedView, mv_name),
    ] {
        let container = ContainerRef::table(kind.clone(), database_name, None, object_name);
        let result = manager
            .browse_table_data(PROFILE_ID, Some(TAB_ID), &container, 1, 2, &query)
            .await
            .map_err(|error| format!("browse Phase 3 {kind:?}: {:?}", error.code))?;
        ensure(
            result.rows.len() == 2,
            "view-like browse should return two rows",
        )?;
        assert_readonly_query_result(&result)?;
        let stats = manager
            .get_table_page_stats(PROFILE_ID, Some(TAB_ID), &container, 2, &query, None)
            .await
            .map_err(|error| format!("count Phase 3 {kind:?}: {:?}", error.code))?;
        ensure(stats.total_rows == 5, "view-like exact count should be 5")?;
    }
    Ok(())
}

fn verify_phase_three_type_columns(result: &QueryResult) -> Result<(), String> {
    for (name, category) in [
        ("id", ColumnDataCategory::Number),
        ("i128", ColumnDataCategory::Number),
        ("i256", ColumnDataCategory::Number),
        ("u128", ColumnDataCategory::Number),
        ("u256", ColumnDataCategory::Number),
        ("exact", ColumnDataCategory::Number),
        ("enabled", ColumnDataCategory::Boolean),
        ("text", ColumnDataCategory::String),
        ("fixed", ColumnDataCategory::String),
        ("day", ColumnDataCategory::Date),
        ("day32", ColumnDataCategory::Date),
        ("moment", ColumnDataCategory::Datetime),
        ("moment64", ColumnDataCategory::Datetime),
        ("uuid", ColumnDataCategory::Uuid),
        ("state", ColumnDataCategory::Enum),
        ("tags", ColumnDataCategory::Structured),
        ("attrs", ColumnDataCategory::Structured),
        ("pair", ColumnDataCategory::Structured),
        ("nested.code", ColumnDataCategory::Structured),
        ("nested.label", ColumnDataCategory::Structured),
    ] {
        let column = result_column(result, name)?;
        ensure(
            column.data_category == category,
            format!("unexpected category for {name}: {:?}", column.data_category),
        )?;
        let expected_writable = category != ColumnDataCategory::Structured;
        ensure(
            column.is_writable == expected_writable,
            format!("unexpected DataTable write capability for {name}"),
        )?;
    }
    let optional = result_column(result, "optional")?;
    ensure(optional.nullable, "Nullable(String) must be nullable")?;
    let exact = result_column(result, "exact")?;
    ensure(
        exact.numeric_precision == Some(38) && exact.numeric_scale == Some(10),
        "Decimal precision and scale must be preserved",
    )?;
    let fixed = result_column(result, "fixed")?;
    ensure(
        fixed.max_length == Some(8),
        "FixedString length must be preserved",
    )?;
    Ok(())
}

fn verify_phase_three_exact_values(result: &QueryResult) -> Result<(), String> {
    let first = result
        .rows
        .first()
        .ok_or_else(|| "Phase 3 first page is empty".to_string())?;
    ensure(
        row_value(result, first, "u128")? == &json!("18446744073709551616"),
        "UInt128 must remain exact text",
    )?;
    ensure(
        row_value(result, first, "i128")? == &json!("-9007199254740994"),
        "unsafe Int128 must remain exact text",
    )?;
    ensure(
        row_value(result, first, "i64")? == &json!("-9007199254740993"),
        "unsafe Int64 must remain exact text",
    )?;
    ensure(
        row_value(result, first, "i256")? == &json!("-9007199254740995"),
        "unsafe Int256 must remain exact text",
    )?;
    ensure(
        row_value(result, first, "u256")? == &json!("340282366920938463463374607431768211456"),
        "UInt256 must remain exact text",
    )?;
    let exact = row_value(result, first, "exact")?;
    ensure(
        exact == &json!("1234567890123456789012345678.1200000000"),
        format!("Decimal must preserve scale and trailing zeros; actual={exact}"),
    )?;
    ensure(
        row_value(result, first, "attrs")? == &json!([[1, "12.3400"]]),
        "Map must normalize keys and Decimal values exactly",
    )?;
    ensure(
        row_value(result, first, "pair")? == &json!({"id": 0, "label": "pair-0"}),
        "named Tuple must normalize to a named object",
    )?;
    ensure(
        row_value(result, first, "nested.code")? == &json!([0]),
        "Nested numeric field must remain structured",
    )?;
    ensure(
        row_value(result, first, "nested.label")? == &json!(["nested-0"]),
        "Nested text field must remain structured",
    )?;
    ensure(
        row_value(result, first, "text")? == &json!("row-0 Ω\n控制"),
        "Unicode and control characters must round-trip",
    )?;
    Ok(())
}

fn verify_phase_three_nullable_and_special_values(result: &QueryResult) -> Result<(), String> {
    let nan_row = result
        .rows
        .first()
        .ok_or_else(|| "Phase 3 second page is empty".to_string())?;
    let inf_row = result
        .rows
        .get(1)
        .ok_or_else(|| "Phase 3 second page has no fourth row".to_string())?;
    ensure(
        row_value(result, nan_row, "optional")?.is_null(),
        "Nullable(String) must preserve null",
    )?;
    ensure(
        row_value(result, nan_row, "f64")? == &json!("NaN"),
        "Float64 NaN must use the canonical marker",
    )?;
    ensure(
        row_value(result, inf_row, "f64")? == &json!("Inf"),
        "Float64 infinity must use the canonical marker",
    )
}

async fn verify_phase_three_fixture_sql(
    manager: &ConnectionRuntimeManager,
    database_name: &str,
    quoted_table: &str,
    table_name: &str,
) -> Result<(), String> {
    let context = clickhouse_sql_context(database_name);
    let paged = manager
        .execute_sql(
            PROFILE_ID,
            TAB_ID,
            &context,
            &format!("SELECT id FROM {quoted_table} ORDER BY id"),
            2,
            2,
        )
        .await
        .map_err(|error| format!("page Phase 3 free SQL: {:?}", error.code))?;
    ensure(
        page_ids(&paged)? == vec![3, 4],
        "free SQL page 2 is incorrect",
    )?;
    ensure(
        paged.has_next_page,
        "free SQL page 2 should have a next page",
    )?;
    assert_readonly_query_result(&paged)?;

    let empty = manager
        .execute_sql(
            PROFILE_ID,
            TAB_ID,
            &context,
            &format!("SELECT id, text FROM {quoted_table} WHERE 0"),
            1,
            100,
        )
        .await
        .map_err(|error| format!("query Phase 3 empty result: {:?}", error.code))?;
    ensure(empty.rows.is_empty(), "empty query should return no rows")?;
    ensure(
        empty.columns.len() == 2,
        "empty query must preserve headers",
    )?;

    let write_error = manager
        .execute_sql(
            PROFILE_ID,
            TAB_ID,
            &context,
            &format!("INSERT INTO {quoted_table} (id) VALUES (999999)"),
            1,
            100,
        )
        .await
        .expect_err("readonly=2 must reject INSERT");
    ensure(
        write_error.code == ErrorCode::ValidationFailed
            && write_error.runtime_impact == RuntimeErrorImpact::BusinessOnly,
        "readonly INSERT must be a local business validation error",
    )?;

    let proof = manager
        .execute_sql(
            PROFILE_ID,
            TAB_ID,
            &context,
            &format!("SELECT countIf(id = 999999) AS count FROM {quoted_table}"),
            1,
            1,
        )
        .await
        .map_err(|error| format!("prove readonly side effect: {:?}", error.code))?;
    ensure(
        proof.rows.first().and_then(|row| row.first()) == Some(&json!(0)),
        "rejected INSERT must leave no row behind",
    )?;
    manager
        .ping(PROFILE_ID)
        .await
        .map_err(|error| format!("runtime after readonly rejection: {:?}", error.code))?;

    let describe = manager
        .execute_sql(
            PROFILE_ID,
            TAB_ID,
            &context,
            &format!("DESCRIBE TABLE {quoted_table}"),
            1,
            100,
        )
        .await
        .map_err(|error| format!("describe Phase 3 table: {:?}", error.code))?;
    ensure(
        !describe.rows.is_empty(),
        "DESCRIBE should return type rows",
    )?;
    let show = manager
        .execute_sql(
            PROFILE_ID,
            TAB_ID,
            &context,
            &format!("SHOW TABLES LIKE '{table_name}'"),
            1,
            100,
        )
        .await
        .map_err(|error| format!("show Phase 3 table: {:?}", error.code))?;
    ensure(show.rows.len() == 1, "SHOW should find the Phase 3 table")?;
    Ok(())
}

fn assert_readonly_query_result(result: &QueryResult) -> Result<(), String> {
    ensure(!result.source_writable, "query result must not be writable")?;
    ensure(
        !result.source_insertable,
        "query result must not be insertable",
    )?;
    ensure(
        result.primary_key_columns.is_empty() && result.stable_order_columns.is_empty(),
        "read-only result must not expose row locators",
    )?;
    ensure(
        result.columns.iter().all(|column| !column.is_writable),
        "query columns must be read-only",
    )
}

fn assert_clickhouse_table_write_capabilities(result: &QueryResult) -> Result<(), String> {
    ensure(
        result.source_writable,
        "table result should support safe updates",
    )?;
    ensure(
        result.source_insertable,
        "table result should support bounded inserts",
    )?;
    ensure(
        result.row_locator_strategy
            == Some(crate::engine::types::TableRowLocatorStrategy::RowSnapshot),
        "table result must use a row snapshot locator",
    )?;
    ensure(
        result.primary_key_columns.is_empty() && result.stable_order_columns.is_empty(),
        "ClickHouse table result must not expose a unique primary-key locator",
    )
}

fn page_ids(result: &QueryResult) -> Result<Vec<u64>, String> {
    let index = result
        .columns
        .iter()
        .position(|column| column.name == "id")
        .ok_or_else(|| "result has no id column".to_string())?;
    result
        .rows
        .iter()
        .map(|row| {
            row.get(index)
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| "result id is not a safe UInt64".to_string())
        })
        .collect()
}

fn result_column<'a>(result: &'a QueryResult, name: &str) -> Result<&'a ColumnMeta, String> {
    result
        .columns
        .iter()
        .find(|column| column.name == name)
        .ok_or_else(|| format!("missing Phase 3 column {name}"))
}

fn row_value<'a>(
    result: &QueryResult,
    row: &'a [serde_json::Value],
    name: &str,
) -> Result<&'a serde_json::Value, String> {
    let index = result
        .columns
        .iter()
        .position(|column| column.name == name)
        .ok_or_else(|| format!("missing Phase 3 column {name}"))?;
    row.get(index)
        .ok_or_else(|| format!("missing Phase 3 value {name}"))
}

fn ensure(condition: bool, message: impl Into<String>) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}

async fn verify_write_fixture_metadata(
    manager: &ConnectionRuntimeManager,
    database_name: &str,
    table_name: &str,
    view_name: &str,
    mv_name: &str,
) -> Result<(), String> {
    let root = manager
        .list_containers(PROFILE_ID, None)
        .await
        .map_err(|error| error.message)?;
    let database = root
        .iter()
        .find(|item| item.kind == ContainerKind::Database && item.name == database_name)
        .ok_or_else(|| "missing fixture database".to_string())?;
    let groups = manager
        .list_containers(PROFILE_ID, Some(database.container.clone()))
        .await
        .map_err(|error| error.message)?;

    let load_group = |group_type: AssetGroupType| {
        find_group(&groups, group_type)
            .map(|group| group.container.clone())
            .ok_or_else(|| "missing fixture asset group".to_string())
    };
    let tables = manager
        .list_containers(PROFILE_ID, Some(load_group(AssetGroupType::Tables)?))
        .await
        .map_err(|error| error.message)?;
    let views = manager
        .list_containers(PROFILE_ID, Some(load_group(AssetGroupType::Views)?))
        .await
        .map_err(|error| error.message)?;
    let materialized_views = manager
        .list_containers(
            PROFILE_ID,
            Some(load_group(AssetGroupType::MaterializedViews)?),
        )
        .await
        .map_err(|error| error.message)?;
    let table = tables
        .iter()
        .find(|item| item.name == table_name)
        .ok_or_else(|| "missing fixture MergeTree table".to_string())?;
    if !views.iter().any(|item| item.name == view_name) {
        return Err("missing fixture View".to_string());
    }
    if !materialized_views.iter().any(|item| item.name == mv_name) {
        return Err("missing fixture MaterializedView".to_string());
    }

    let table_groups = manager
        .list_containers(PROFILE_ID, Some(table.container.clone()))
        .await
        .map_err(|error| error.message)?;
    let load_table_group = |group_type: AssetGroupType| {
        find_group(&table_groups, group_type)
            .map(|group| group.container.clone())
            .ok_or_else(|| "missing fixture table group".to_string())
    };
    let columns = manager
        .list_containers(PROFILE_ID, Some(load_table_group(AssetGroupType::Columns)?))
        .await
        .map_err(|error| error.message)?;
    let event_date = columns
        .iter()
        .find(|item| item.name == "event_date")
        .ok_or_else(|| "missing event_date column".to_string())?;
    for key in [
        "defaultKind",
        "defaultExpression",
        "codec",
        "isInSortingKey",
        "isInPrimaryKey",
        "isInPartitionKey",
    ] {
        if property(event_date, key).is_none() {
            return Err(format!("missing event_date property {key}"));
        }
    }

    let indexes = manager
        .list_containers(PROFILE_ID, Some(load_table_group(AssetGroupType::Indexes)?))
        .await
        .map_err(|error| error.message)?;
    if !indexes.iter().any(|item| item.name == "value_minmax") {
        return Err("missing data-skipping index".to_string());
    }
    let projections = manager
        .list_containers(
            PROFILE_ID,
            Some(load_table_group(AssetGroupType::Projections)?),
        )
        .await
        .map_err(|error| error.message)?;
    if !projections.iter().any(|item| item.name == "daily") {
        return Err("missing projection".to_string());
    }
    let partitions = manager
        .list_containers(
            PROFILE_ID,
            Some(load_table_group(AssetGroupType::Partitions)?),
        )
        .await
        .map_err(|error| error.message)?;
    if partitions.len() < 2
        || partitions
            .iter()
            .any(|item| item.kind != ContainerKind::Partition || !item.is_leaf)
    {
        return Err("partition metadata was not aggregated as expected".to_string());
    }
    Ok(())
}

fn report_optional_evidence_skips(env: &TestEnv, protocol: &str) {
    if env.optional("NEXPILOT_TEST_CLICKHOUSE_CLUSTER").is_none() {
        eprintln!(
            "ClickHouse Distributed metadata evidence skipped: \
             NEXPILOT_TEST_CLICKHOUSE_CLUSTER is empty"
        );
    }
    if env
        .optional("NEXPILOT_TEST_CLICKHOUSE_DICTIONARY")
        .is_none()
    {
        eprintln!(
            "ClickHouse Dictionary metadata evidence skipped: \
             NEXPILOT_TEST_CLICKHOUSE_DICTIONARY is empty"
        );
    }
    if env
        .optional("NEXPILOT_TEST_CLICKHOUSE_LOW_PRIVILEGE_USERNAME")
        .is_none()
        || env
            .optional("NEXPILOT_TEST_CLICKHOUSE_LOW_PRIVILEGE_PASSWORD")
            .is_none()
    {
        eprintln!(
            "ClickHouse low-privilege metadata evidence skipped: \
             low-privilege credentials are incomplete"
        );
    }
    if protocol != "https" {
        eprintln!(
            "ClickHouse Cloud HTTPS metadata evidence skipped: \
             current fixture protocol is not https"
        );
    }
}

fn stored_clickhouse_record(payload: serde_json::Value) -> StoredConnectionRecord {
    StoredConnectionRecord {
        id: PROFILE_ID.to_string(),
        name: "Real ClickHouse Smoke".to_string(),
        driver: ConnectionDriver::Clickhouse,
        environment: "development".to_string(),
        color: None,
        tag_label: String::new(),
        tag_color: None,
        payload,
        folder_id: None,
        created_at: 0,
        updated_at: 0,
        last_connected_at: None,
        last_connection_status: None,
        last_connection_error: None,
        sort_order: None,
    }
}

fn assert_phase_five_e_runtime_info(info: &ConnectionRuntimeInfo) {
    assert_eq!(info.driver_name, "clickhouse");
    assert_phase_five_e_capabilities(&info.capabilities);
}

fn assert_phase_five_e_capabilities(capabilities: &DriverCapabilities) {
    assert!(capabilities.schema_browser);
    assert!(!capabilities.schema_mutator);
    let mutation = capabilities
        .schema_mutation
        .as_ref()
        .expect("Phase 5E native schema capability");
    assert_eq!(mutation.objects.len(), 7);
    assert!(mutation.supports(ContainerKind::Database, SchemaMutationOperation::Create));
    assert!(mutation.supports(ContainerKind::Database, SchemaMutationOperation::Drop));
    assert!(mutation.supports(ContainerKind::Table, SchemaMutationOperation::Create));
    assert!(mutation.supports(ContainerKind::Table, SchemaMutationOperation::Alter));
    assert!(mutation.supports(ContainerKind::Table, SchemaMutationOperation::Drop));
    assert!(mutation.supports(ContainerKind::Column, SchemaMutationOperation::Clear));
    assert!(mutation.supports(ContainerKind::Column, SchemaMutationOperation::Materialize,));
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
    assert!(!mutation.supports(ContainerKind::Database, SchemaMutationOperation::Alter));
    assert!(mutation.ddl_preview);
    assert!(mutation.destructive_confirmation);
    assert!(mutation.remote_drift_protection);
    assert!(capabilities.data_table_browser);
    assert!(capabilities.table_row_mutator);
    assert!(capabilities.table_row_inserter);
    assert!(!capabilities.transaction_manager);
    assert!(capabilities.sql_executor);
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
    assert!(!capabilities.key_value_browser);
    assert!(!capabilities.graph_queryer);
    assert!(!capabilities.vector_searcher);
}

#[cfg(test)]
mod tests {
    use super::phase_five_a::{
        is_lowercase_sha256, merge_checkpoint_and_cleanup, merge_tree_fixture_sql,
        qualified_name as phase_five_a_qualified_name,
        quote_identifier as phase_five_a_quote_identifier, sanitize_bad_response_details,
        summarize_blocker_codes, summarize_blocker_paths,
    };
    use super::phase_five_c::{
        merge_checkpoint_and_cleanup as merge_phase_five_c_checkpoint_and_cleanup,
        unique_database_name as phase_five_c_database_name,
        validate_capability_expectation as validate_phase_five_c_capability_expectation,
        validate_database_scope as validate_phase_five_c_database_scope,
        PhaseFiveCCapabilityExpectation, PhaseFiveCEvidence,
    };
    use super::phase_five_d::{
        cleanup_statements as phase_five_d_cleanup_statements,
        merge_checkpoint_and_cleanup as merge_phase_five_d_checkpoint_and_cleanup,
        unique_database_name as phase_five_d_database_name,
        validate_capability_closed as validate_phase_five_d_capability_closed,
        validate_capability_published as validate_phase_five_d_capability_published,
        validate_database_scope as validate_phase_five_d_database_scope, PhaseFiveDEvidence,
    };
    use super::phase_five_e::{
        cleanup_statements as phase_five_e_cleanup_statements,
        unique_database_name as phase_five_e_database_name,
        validate_capability_closed as validate_phase_five_e_capability_closed,
        validate_capability_published as validate_phase_five_e_capability_published,
        validate_database_scope as validate_phase_five_e_database_scope, PhaseFiveEEvidence,
    };
    use super::{
        assert_phase_five_e_capabilities, optional_type_skip_label, quote_test_identifier,
        scratch_object_name, strict_protocol, validate_scratch_prefix, write_fixture_enabled,
        ContainerKind, DriverCapabilities, SchemaMutationOperation, SqlExecutionFeatures,
        SqlStatementAccess,
    };
    use crate::engine::types::{SchemaMutationFeatures, SchemaMutationObjectFeatures};

    fn phase_five_c_capability_fixture() -> DriverCapabilities {
        let mut capabilities = DriverCapabilities::default();
        capabilities.schema_browser = true;
        capabilities.schema_mutation = Some(SchemaMutationFeatures::new(
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
            ],
            true,
            true,
            true,
        ));
        capabilities
    }

    #[test]
    fn phase_five_d_helpers_enforce_scope_cleanup_and_closed_capability() {
        let prefix = "nexpilot_it_";
        let database =
            phase_five_d_database_name(prefix).expect("Phase 5D scratch identity should be valid");
        assert!(database.starts_with("nexpilot_it_phase5d_"));
        assert!(database
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_'));
        assert!(validate_phase_five_d_database_scope(&database, prefix).is_ok());
        assert!(validate_phase_five_d_database_scope("prod", prefix).is_err());

        let cleanup = phase_five_d_cleanup_statements(&database, "object_matrix", prefix)
            .expect("safe Phase 5D cleanup statements");
        assert_eq!(cleanup.len(), 2);
        assert!(cleanup[0].contains("DROP TABLE IF EXISTS"));
        assert!(cleanup[0].contains("object_matrix"));
        assert!(cleanup[1].contains("DROP DATABASE IF EXISTS"));

        validate_phase_five_d_capability_closed(&phase_five_c_capability_fixture())
            .expect("Phase 5C must satisfy the closed Phase 5D gate");
        let mut prematurely_open = phase_five_c_capability_fixture();
        prematurely_open
            .schema_mutation
            .as_mut()
            .expect("schema mutation fixture")
            .objects
            .push(SchemaMutationObjectFeatures::new(
                ContainerKind::Projection,
                [SchemaMutationOperation::Create],
            ));
        assert!(validate_phase_five_d_capability_closed(&prematurely_open).is_err());

        let mut published = phase_five_c_capability_fixture();
        published
            .schema_mutation
            .as_mut()
            .expect("schema mutation fixture")
            .objects
            .extend([
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
            ]);
        validate_phase_five_d_capability_published(&published)
            .expect("Phase 5D published capability must be exact");
    }

    #[test]
    fn phase_five_d_helper_keeps_direct_dispatch_and_secret_loading_bounded() {
        let phase_source = include_str!("clickhouse/phase_five_d.rs");
        let direct_start = phase_source
            .find("impl PhaseFiveDDispatcher for DirectPhaseFiveDDispatcher")
            .expect("Direct dispatcher implementation");
        let direct_end = phase_source[direct_start..]
            .find("fn table_container")
            .map(|offset| direct_start + offset)
            .expect("Direct dispatcher boundary");
        let direct = &phase_source[direct_start..direct_end];
        assert!(direct.contains("extension.preview_change"));
        assert!(direct.contains("extension.execute_change"));
        assert!(direct.contains(".describe(&NativeSchemaDescribeRequest"));
        assert!(!direct.contains("ConnectionRuntimeManager"));
        assert!(!phase_source.contains("TestEnv::load"));
        assert!(!phase_source.contains(".env.test"));

        let smoke_source = include_str!("clickhouse.rs");
        let ignored_smoke = smoke_source
            .find("fn real_clickhouse_smoke()")
            .expect("ignored ClickHouse smoke");
        assert!(smoke_source[..ignored_smoke].contains("#[ignore"));
        assert!(smoke_source[ignored_smoke..].contains("TestEnv::load()"));
    }

    #[test]
    fn phase_five_d_evidence_rejects_zero_counts_and_redacts_marker() {
        let evidence = PhaseFiveDEvidence {
            server_version: "25.8.1.1".to_string(),
            projections_created: 2,
            index_types_created: 5,
            destructive_rejections: 11,
            submitted_actions: 4,
            drift_conflicts: 1,
            unsupported_rejections: 5,
            projections_dropped: 2,
            indexes_dropped: 5,
        };
        evidence
            .validate_counts()
            .expect("complete Phase 5D evidence");
        let marker = evidence.marker();
        assert_eq!(
            marker,
            "ClickHouse Phase 5D direct object checkpoint passed: server=25.8.1.1; projections_created=2; index_types_created=5; destructive_rejections=11; submitted_actions=4; drift_conflicts=1; unsupported_rejections=5; projections_dropped=2; indexes_dropped=5"
        );
        assert!(!marker.contains("endpoint"));
        assert!(!marker.contains("password"));
        assert_eq!(
            evidence.manager_marker(),
            "ClickHouse Phase 5D Manager-gated object checkpoint passed: server=25.8.1.1; projections_created=2; index_types_created=5; destructive_rejections=11; submitted_actions=4; drift_conflicts=1; unsupported_rejections=5; projections_dropped=2; indexes_dropped=5"
        );

        let mut incomplete = evidence;
        incomplete.submitted_actions = 0;
        assert!(incomplete.validate_counts().is_err());

        let primary = crate::error::IpcError::validation_failed("primary failed");
        let cleanup =
            crate::error::IpcError::system_internal("cleanup failed", "sensitive cleanup detail");
        let error = merge_phase_five_d_checkpoint_and_cleanup::<u8>(Err(primary), Err(cleanup))
            .expect_err("dual failure must stay redacted");
        assert!(!error.details.unwrap_or_default().contains("sensitive"));
    }

    #[test]
    fn phase_five_e_helpers_bound_scope_cleanup_and_capability() {
        let prefix = "nexpilot_it_";
        let database =
            phase_five_e_database_name(prefix).expect("Phase 5E scratch identity should be valid");
        assert!(database.starts_with("nexpilot_it_phase5e_"));
        assert!(validate_phase_five_e_database_scope(&database, prefix).is_ok());
        assert!(validate_phase_five_e_database_scope("prod", prefix).is_err());
        assert!(validate_phase_five_e_database_scope(
            "nexpilot_it_phase5e_safe; DROP DATABASE prod",
            prefix,
        )
        .is_err());

        let cleanup = phase_five_e_cleanup_statements(&database, prefix)
            .expect("safe Phase 5E cleanup statements");
        assert!(cleanup
            .iter()
            .any(|statement| statement.contains("DROP VIEW IF EXISTS")));
        assert!(cleanup
            .iter()
            .any(|statement| statement.contains("DROP TABLE IF EXISTS")));
        assert!(cleanup
            .iter()
            .any(|statement| statement.contains("DROP DATABASE IF EXISTS")));

        let published_phase_five_d = {
            let mut capabilities = phase_five_c_capability_fixture();
            capabilities
                .schema_mutation
                .as_mut()
                .expect("schema mutation fixture")
                .objects
                .extend([
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
                ]);
            capabilities
        };
        validate_phase_five_e_capability_closed(&published_phase_five_d)
            .expect("Phase 5D must satisfy the closed Phase 5E gate");

        let mut prematurely_open = published_phase_five_d;
        prematurely_open
            .schema_mutation
            .as_mut()
            .expect("schema mutation fixture")
            .objects
            .push(SchemaMutationObjectFeatures::new(
                ContainerKind::View,
                [SchemaMutationOperation::Create],
            ));
        assert!(validate_phase_five_e_capability_closed(&prematurely_open).is_err());

        let mut published = prematurely_open;
        published
            .schema_mutation
            .as_mut()
            .expect("schema mutation fixture")
            .objects
            .pop();
        published
            .schema_mutation
            .as_mut()
            .expect("schema mutation fixture")
            .objects
            .extend([
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
            ]);
        validate_phase_five_e_capability_published(&published)
            .expect("Phase 5E published capability must be exact");
    }

    #[test]
    fn phase_five_e_evidence_requires_complete_exclusive_support_and_redacts_marker() {
        let evidence = PhaseFiveEEvidence {
            server_version: "25.8.1.1".to_string(),
            normal: 5,
            parameterized: 5,
            temporary: 6,
            materialized: 8,
            refreshable: 8,
            window_supported: 0,
            window_unavailable: 1,
            live_supported: 0,
            live_unavailable: 1,
            alters: 7,
            renames: 5,
            drops: 7,
            confirmation_rejections: 6,
            drift_conflicts: 3,
            background_observations: 1,
        };
        evidence
            .validate_counts()
            .expect("complete Phase 5E evidence");
        let marker = evidence.marker();
        assert_eq!(
            marker,
            "ClickHouse Phase 5E direct view checkpoint passed: server=25.8.1.1; normal=5; parameterized=5; temporary=6; materialized=8; refreshable=8; window_supported=0; window_unavailable=1; live_supported=0; live_unavailable=1; alters=7; renames=5; drops=7; confirmation_rejections=6; drift_conflicts=3; background_observations=1"
        );
        for forbidden in [
            "endpoint",
            "username",
            "password",
            "SELECT",
            "CREATE",
            "canonical",
            "session_id",
            "query_id",
        ] {
            assert!(!marker.contains(forbidden));
        }

        let mut incomplete = evidence.clone();
        incomplete.normal = 0;
        assert!(incomplete.validate_counts().is_err());
        let mut ambiguous_window = evidence.clone();
        ambiguous_window.window_supported = 1;
        assert!(ambiguous_window.validate_counts().is_err());
        let mut missing_live = evidence;
        missing_live.live_unavailable = 0;
        assert!(missing_live.validate_counts().is_err());
    }

    #[test]
    fn phase_five_e_direct_dispatch_and_secret_loading_are_bounded() {
        let phase_source = include_str!("clickhouse/phase_five_e.rs");
        let direct_start = phase_source
            .find("impl PhaseFiveEDispatcher for DirectPhaseFiveEDispatcher")
            .expect("Direct dispatcher implementation");
        let direct_end = phase_source[direct_start..]
            .find("struct ManagerPhaseFiveEDispatcher")
            .map(|offset| direct_start + offset)
            .expect("Direct dispatcher boundary");
        let direct = &phase_source[direct_start..direct_end];
        assert!(direct.contains("extension.preview_create"));
        assert!(direct.contains("extension.execute_create"));
        assert!(direct.contains("extension.preview_change"));
        assert!(direct.contains("extension.execute_change"));
        assert!(direct.contains("extension.describe"));
        assert!(direct.contains("tab_extension"));
        assert!(!direct.contains("ConnectionRuntimeManager"));

        let manager_start = direct_end;
        let manager_end = phase_source[manager_start..]
            .find("async fn runtime_support")
            .map(|offset| manager_start + offset)
            .expect("Manager dispatcher boundary");
        let manager_dispatch = &phase_source[manager_start..manager_end];
        for method in [
            "get_native_schema_support_in_runtime",
            "describe_native_schema_in_runtime",
            "preview_native_schema_create_in_runtime",
            "execute_native_schema_create_in_runtime",
            "preview_native_schema_change_in_runtime",
            "execute_native_schema_change_in_runtime",
            "execute_sql",
            "close_tab_runtime",
        ] {
            assert!(manager_dispatch.contains(method));
        }
        assert!(!manager_dispatch.contains("as_native_schema_extension"));
        assert!(!phase_source.contains("TestEnv::load"));
        assert!(!phase_source.contains(".env.test"));

        let schema_source = include_str!("../engine/drivers/clickhouse/schema/mod.rs");
        assert!(schema_source.contains("plan_view_create"));
        assert!(schema_source.contains("execute_view_create"));
        assert!(schema_source.contains("plan_view_change"));
        assert!(schema_source.contains("execute_view_change"));

        let smoke_source = include_str!("clickhouse.rs");
        let ignored_smoke = smoke_source
            .find("fn real_clickhouse_smoke()")
            .expect("ignored ClickHouse smoke");
        assert!(smoke_source[..ignored_smoke].contains("#[ignore"));
        assert!(!smoke_source[..ignored_smoke].contains("TestEnv::load()"));
        assert!(smoke_source[ignored_smoke..].contains("TestEnv::load()"));
    }

    #[test]
    fn phase_five_e_baseline_published_capability_is_exact() {
        let mut capabilities = DriverCapabilities::default();
        capabilities.schema_browser = true;
        capabilities.schema_mutation = Some(SchemaMutationFeatures::new(
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
        ));
        capabilities.data_table_browser = true;
        capabilities.table_row_mutator = true;
        capabilities.table_row_inserter = true;
        capabilities.sql_executor = true;
        capabilities.sql_execution = Some(SqlExecutionFeatures {
            managed_lifecycle: true,
            statement_access: SqlStatementAccess::Direct,
            active_cancel: true,
            live_progress: true,
            query_summary: true,
            raw_result: true,
            configurable_timeout: true,
        });

        assert_phase_five_e_capabilities(&capabilities);
    }

    fn phase_five_b_capability_fixture() -> DriverCapabilities {
        let mut capabilities = DriverCapabilities::default();
        capabilities.schema_mutation = Some(SchemaMutationFeatures::new(
            [
                SchemaMutationObjectFeatures::new(
                    ContainerKind::Database,
                    [SchemaMutationOperation::Create],
                ),
                SchemaMutationObjectFeatures::new(
                    ContainerKind::Table,
                    [SchemaMutationOperation::Create],
                ),
            ],
            true,
            false,
            false,
        ));
        capabilities
    }

    #[test]
    fn phase_five_c_helpers_enforce_scratch_scope_and_identity() {
        let name = phase_five_c_database_name("nexpilot_it_")
            .expect("Phase 5C scratch identity should be valid");
        assert!(name.starts_with("nexpilot_it_phase5c_"));
        assert!(validate_phase_five_c_database_scope(&name, "nexpilot_it_").is_ok());
        assert!(validate_phase_five_c_database_scope("prod", "nexpilot_it_").is_err());
        assert!(validate_phase_five_c_database_scope(
            "nexpilot_it_phase5c_safe; DROP DATABASE prod",
            "nexpilot_it_"
        )
        .is_err());
    }

    #[test]
    fn phase_five_c_helper_requires_the_exact_closed_and_published_capability_matrices() {
        let closed = phase_five_b_capability_fixture();
        validate_phase_five_c_capability_expectation(
            &closed,
            PhaseFiveCCapabilityExpectation::Closed,
        )
        .expect("Phase 5B capability should satisfy the closed Phase 5C gate");

        let mut published = closed;
        published.schema_mutation = Some(SchemaMutationFeatures::new(
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
            ],
            true,
            true,
            true,
        ));
        validate_phase_five_c_capability_expectation(
            &published,
            PhaseFiveCCapabilityExpectation::Published,
        )
        .expect("Phase 5C capability should satisfy the published gate");

        published
            .schema_mutation
            .as_mut()
            .expect("published mutation fixture")
            .objects[2]
            .operations
            .push(SchemaMutationOperation::Drop);
        assert!(validate_phase_five_c_capability_expectation(
            &published,
            PhaseFiveCCapabilityExpectation::Published,
        )
        .is_err());
    }

    #[test]
    fn phase_five_c_cleanup_merge_keeps_primary_and_cleanup_failures_distinct() {
        assert_eq!(
            merge_phase_five_c_checkpoint_and_cleanup(Ok(7_u8), Ok(()))
                .expect("checkpoint and cleanup should pass"),
            7
        );

        let primary = crate::error::IpcError::validation_failed("primary failed");
        let error = merge_phase_five_c_checkpoint_and_cleanup::<u8>(Err(primary), Ok(()))
            .expect_err("primary failure should survive successful cleanup");
        assert_eq!(error.code, crate::error::ErrorCode::ValidationFailed);

        let cleanup =
            crate::error::IpcError::system_internal("cleanup failed", "secret scratch database");
        let error = merge_phase_five_c_checkpoint_and_cleanup(Ok(7_u8), Err(cleanup))
            .expect_err("cleanup failure should override a successful checkpoint");
        assert_eq!(error.message, "cleanup failed");

        let primary = crate::error::IpcError::validation_failed("primary failed");
        let cleanup =
            crate::error::IpcError::system_internal("cleanup failed", "secret scratch database");
        let error = merge_phase_five_c_checkpoint_and_cleanup::<u8>(Err(primary), Err(cleanup))
            .expect_err("dual failure should be combined without secret details");
        assert_eq!(
            error.message,
            "ClickHouse Phase 5C checkpoint failed and cleanup was incomplete"
        );
        assert!(!error.details.unwrap_or_default().contains("secret"));
    }

    #[test]
    fn phase_five_c_marker_contains_only_fixed_nonzero_evidence() {
        let marker = PhaseFiveCEvidence {
            server_version: "25.8.1.1".to_string(),
            safe_alter_operations: 8,
            destructive_rejections: 4,
            destructive_applied: 3,
            drift_conflicts: 2,
            unsupported_rejections: 4,
            submitted_actions: 2,
            dropped_columns: 1,
            dropped_tables: 1,
            dropped_databases: 1,
        }
        .marker();

        assert_eq!(
            marker,
            "ClickHouse Phase 5C direct change checkpoint passed: server=25.8.1.1; safe_alter=8; destructive_rejections=4; destructive_applied=3; drift_conflicts=2; unsupported_rejections=4; submitted_actions=2; dropped_columns=1; dropped_tables=1; dropped_databases=1"
        );
        assert!(!marker.contains("password"));
        assert!(!marker.contains("endpoint"));

        let manager_marker = PhaseFiveCEvidence {
            server_version: "25.8.1.1".to_string(),
            safe_alter_operations: 8,
            destructive_rejections: 4,
            destructive_applied: 3,
            drift_conflicts: 2,
            unsupported_rejections: 4,
            submitted_actions: 2,
            dropped_columns: 1,
            dropped_tables: 1,
            dropped_databases: 1,
        }
        .manager_marker();
        assert_eq!(
            manager_marker,
            "ClickHouse Phase 5C Manager-gated change checkpoint passed: server=25.8.1.1; safe_alter=8; destructive_rejections=4; destructive_applied=3; drift_conflicts=2; unsupported_rejections=4; submitted_actions=2; dropped_columns=1; dropped_tables=1; dropped_databases=1"
        );
    }

    #[test]
    fn clickhouse_smoke_protocol_parser_is_strict() {
        assert_eq!(strict_protocol("http"), "http");
        assert_eq!(strict_protocol("https"), "https");
    }

    #[test]
    #[should_panic(expected = "must be exactly http or https")]
    fn clickhouse_smoke_protocol_parser_rejects_other_values() {
        strict_protocol("HTTPS");
    }

    #[test]
    fn write_fixture_requires_clickhouse_and_global_write_gates() {
        assert!(!write_fixture_enabled(false, false));
        assert!(!write_fixture_enabled(true, false));
        assert!(!write_fixture_enabled(false, true));
        assert!(write_fixture_enabled(true, true));
    }

    #[test]
    fn scratch_prefix_only_builds_safe_clickhouse_identifiers() {
        assert_eq!(
            scratch_object_name("nexpilot_it_", "events"),
            "nexpilot_it_events",
        );
        assert!(validate_scratch_prefix("nexpilot_it_").is_ok());
        assert!(validate_scratch_prefix("prod.events; DROP TABLE x").is_err());
        assert!(validate_scratch_prefix("9invalid").is_err());
    }

    #[test]
    fn phase_three_fixture_names_stay_under_validated_scratch_prefix() {
        assert_eq!(
            scratch_object_name("nexpilot_it_", "phase3_types"),
            "nexpilot_it_phase3_types",
        );
        assert!(quote_test_identifier("nexpilot_it_phase3_types").starts_with('`'));
    }

    #[test]
    fn phase_five_a_fixture_helpers_quote_identifiers_and_validate_revisions() {
        assert_eq!(
            phase_five_a_quote_identifier("events`archive\\local"),
            "`events\\`archive\\\\local`",
        );
        assert_eq!(
            phase_five_a_qualified_name("analytics", "events"),
            "`analytics`.`events`",
        );
        assert!(is_lowercase_sha256(&"a1".repeat(32)));
        assert!(!is_lowercase_sha256(&"A1".repeat(32)));
        assert!(!is_lowercase_sha256("abc"));
    }

    #[test]
    fn phase_five_a_bad_response_diagnostics_expose_only_code_and_position() {
        let response =
            "Code: 62. DB::Exception: Syntax error at position 731 ('COMMENT'): secret payload";
        let details = sanitize_bad_response_details(response);

        assert_eq!(details, "server_code=62; syntax_position=731");
        assert!(!details.contains("COMMENT"));
        assert!(!details.contains("secret"));
    }

    #[test]
    fn phase_five_a_merge_tree_fixture_orders_comment_before_codec() {
        let sql = merge_tree_fixture_sql("analytics", "events");

        assert!(sql.contains("payload String COMMENT 'payload' CODEC(ZSTD(1))"));
        assert!(!sql.contains("payload String CODEC(ZSTD(1)) COMMENT 'payload'"));
    }

    #[test]
    fn phase_five_a_blocker_diagnostics_expose_only_codes() {
        let blockers = vec![
            crate::engine::drivers::clickhouse::schema::ClickHouseSchemaBlocker {
                code: "unsupported_clause".to_string(),
                path: "table.createQuery".to_string(),
                message: "secret canonical fragment".to_string(),
            },
            crate::engine::drivers::clickhouse::schema::ClickHouseSchemaBlocker {
                code: "catalog_create_conflict".to_string(),
                path: "columns".to_string(),
                message: "secret catalog payload".to_string(),
            },
            crate::engine::drivers::clickhouse::schema::ClickHouseSchemaBlocker {
                code: "unsupported_clause".to_string(),
                path: "table.createQuery".to_string(),
                message: "duplicate".to_string(),
            },
        ];

        assert_eq!(
            summarize_blocker_codes(&blockers),
            "catalog_create_conflict,unsupported_clause"
        );
        assert_eq!(
            summarize_blocker_paths(&blockers),
            "columns,table.createQuery"
        );
    }

    #[test]
    fn phase_five_a_checkpoint_cleanup_result_precedence_is_deterministic() {
        assert_eq!(
            merge_checkpoint_and_cleanup(Ok(7_u8), Ok(())).expect("both paths succeed"),
            7
        );

        let primary = crate::error::IpcError::system_internal(
            "primary checkpoint failed",
            "secret canonical payload",
        );
        let primary_only = merge_checkpoint_and_cleanup::<u8>(Err(primary), Ok(()))
            .expect_err("primary failure survives successful cleanup");
        assert_eq!(primary_only.message, "primary checkpoint failed");

        let cleanup = crate::error::IpcError::system_internal(
            "fixture cleanup failed",
            "secret cleanup target",
        );
        let cleanup_only = merge_checkpoint_and_cleanup(Ok(7_u8), Err(cleanup))
            .expect_err("cleanup failure overrides successful checkpoint");
        assert_eq!(cleanup_only.message, "fixture cleanup failed");

        let primary = crate::error::IpcError::system_internal(
            "primary checkpoint failed",
            "secret canonical payload",
        );
        let cleanup = crate::error::IpcError::system_internal(
            "fixture cleanup failed",
            "secret cleanup target",
        );
        let combined = merge_checkpoint_and_cleanup::<u8>(Err(primary), Err(cleanup))
            .expect_err("dual failure is combined safely");
        let combined_details = combined.details.unwrap_or_default();
        assert_eq!(
            combined.message,
            "ClickHouse Phase 5A checkpoint failed and cleanup was incomplete"
        );
        assert!(!combined_details.contains("secret"));
        assert!(!combined_details.contains("canonical"));
        assert!(!combined_details.contains("target"));
    }

    #[test]
    fn optional_experimental_type_failures_have_fixed_skip_labels() {
        assert_eq!(
            optional_type_skip_label("JSON"),
            "ClickHouse JSON real evidence skipped",
        );
        assert_eq!(
            optional_type_skip_label("Object"),
            "ClickHouse Object real evidence skipped",
        );
        assert_eq!(
            optional_type_skip_label("Variant"),
            "ClickHouse Variant real evidence skipped",
        );
    }
}
