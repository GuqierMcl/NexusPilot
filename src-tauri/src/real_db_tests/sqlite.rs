use serde_json::json;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

use crate::commands::engine_commands::test_connection_config;
use crate::engine::driver::{DatabaseDriver, SchemaBrowser};
use crate::engine::drivers::sqlite::SqliteDriver;
use crate::engine::manager::ConnectionRuntimeManager;
use crate::engine::profiles::SqliteProfile;
use crate::engine::types::{
    AssetGroupType, ConnectionRuntimeInfo, ContainerKind, ContainerRef, DataContainer,
    DriverCapabilities, SqlExecutionContext, TableBrowseQuery, TableCellChange,
    TableChangeSetInsert, TableChangeSetRequest, TableChangeSetUpdate, TableRowKeyPart,
    TableRowLocator,
};
use crate::repository::connection_repository::{ConnectionDriver, StoredConnectionRecord};

use super::common::{run_async, TestEnv};

fn primary_key_locator(parts: Vec<TableRowKeyPart>) -> TableRowLocator {
    TableRowLocator::primary_key(parts)
}

#[test]
fn real_sqlite_local_file_connection_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !env.enabled("NEXPILOT_TEST_SQLITE_ENABLED") {
            return;
        }

        let db_file_path = env.required("NEXPILOT_TEST_SQLITE_DB_FILE_PATH");
        let is_read_only = env.bool_or("NEXPILOT_TEST_SQLITE_READ_ONLY", true);
        let payload = json!({
            "dbFilePath": db_file_path.clone(),
            "isReadOnly": is_read_only
        });

        let test_result = test_connection_config(ConnectionDriver::Sqlite, payload.clone())
            .await
            .expect("SQLite test_connection_config should connect to the configured local file");
        assert_eq!(test_result.driver_name, "sqlite");
        assert_eq!(test_result.endpoint, db_file_path);
        let version = test_result
            .server_version
            .as_deref()
            .expect("SQLite test connection should return sqlite_version()");
        assert!(!version.trim().is_empty());
        eprintln!("real SQLite test_connection_config connected; sqlite_version={version}");

        let manager = ConnectionRuntimeManager::new();
        let record = stored_sqlite_record(payload);
        let info = manager
            .connect_profile("real-sqlite-smoke", &record)
            .await
            .expect("SQLite connect_profile should create a shared runtime");
        assert_sqlite_phase_five_info(&info);

        manager
            .ping("real-sqlite-smoke")
            .await
            .expect("SQLite connected profile should ping");

        let tab_info = manager
            .open_tab_runtime("real-sqlite-smoke", "real-sqlite-tab", &record)
            .await
            .expect("SQLite open_tab_runtime should create a tab runtime");
        assert_sqlite_phase_five_info(&tab_info);

        manager
            .close_tab_runtime("real-sqlite-tab")
            .await
            .expect("SQLite tab runtime should close");
        manager
            .disconnect_profile("real-sqlite-smoke")
            .await
            .expect("SQLite shared runtime should disconnect");
    });
}

#[test]
fn real_sqlite_metadata_browser_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !env.enabled("NEXPILOT_TEST_SQLITE_ENABLED") {
            return;
        }
        if !env.bool_or("NEXPILOT_TEST_ALLOW_WRITES", false)
            || env.bool_or("NEXPILOT_TEST_SQLITE_READ_ONLY", true)
        {
            return;
        }

        let db_file_path = env.required("NEXPILOT_TEST_SQLITE_DB_FILE_PATH");
        let prefix = env
            .optional("NEXPILOT_TEST_SQLITE_SCRATCH_PREFIX")
            .unwrap_or_else(|| "nexpilot_it_".to_string());
        let table = sqlite_scratch_identifier(&prefix, "meta");
        let view = format!("{table}_view");
        let index = format!("{table}_idx_name");
        let trigger = format!("{table}_ai");
        let table_ident = quote_sqlite_identifier(&table);
        let view_ident = quote_sqlite_identifier(&view);
        let index_ident = quote_sqlite_identifier(&index);
        let trigger_ident = quote_sqlite_identifier(&trigger);

        sqlite_execute_raw(
            &db_file_path,
            &format!("DROP TRIGGER IF EXISTS {trigger_ident}"),
        )
        .await
        .expect("SQLite metadata smoke cleanup trigger before test");
        sqlite_execute_raw(&db_file_path, &format!("DROP VIEW IF EXISTS {view_ident}"))
            .await
            .expect("SQLite metadata smoke cleanup view before test");
        sqlite_execute_raw(
            &db_file_path,
            &format!("DROP TABLE IF EXISTS {table_ident}"),
        )
        .await
        .expect("SQLite metadata smoke cleanup table before test");

        let operation_result: Result<(), String> = async {
            sqlite_execute_raw(
                &db_file_path,
                &format!(
                    "CREATE TABLE {table_ident} (
                         id INTEGER PRIMARY KEY,
                         name TEXT NOT NULL
                     )"
                ),
            )
            .await
            .map_err(|error| format!("SQLite metadata smoke create table failed: {error:?}"))?;
            sqlite_execute_raw(
                &db_file_path,
                &format!("CREATE INDEX {index_ident} ON {table_ident}(name)"),
            )
            .await
            .map_err(|error| format!("SQLite metadata smoke create index failed: {error:?}"))?;
            sqlite_execute_raw(
                &db_file_path,
                &format!("CREATE VIEW {view_ident} AS SELECT id, name FROM {table_ident}"),
            )
            .await
            .map_err(|error| format!("SQLite metadata smoke create view failed: {error:?}"))?;
            sqlite_execute_raw(
                &db_file_path,
                &format!(
                    "CREATE TRIGGER {trigger_ident} AFTER INSERT ON {table_ident}
                     BEGIN
                         UPDATE {table_ident} SET name = NEW.name WHERE id = NEW.id;
                     END"
                ),
            )
            .await
            .map_err(|error| format!("SQLite metadata smoke create trigger failed: {error:?}"))?;

            let driver = SqliteDriver::connect(
                "real-sqlite-metadata".to_string(),
                SqliteProfile {
                    db_file_path: db_file_path.clone(),
                    is_read_only: true,
                },
            )
            .await
            .map_err(|error| format!("connect SQLite metadata smoke failed: {error:?}"))?;
            let browser = driver
                .as_schema_browser()
                .ok_or_else(|| "SQLite metadata smoke should expose schema browser".to_string())?;

            let root = browser
                .list_containers(None)
                .await
                .map_err(|error| format!("list root failed: {error:?}"))?;
            if root.len() != 1 || root[0].kind != ContainerKind::Database {
                return Err(format!("SQLite root mismatch: {root:?}"));
            }

            let groups = browser
                .list_containers(Some(&root[0].container))
                .await
                .map_err(|error| format!("list database groups failed: {error:?}"))?;
            let tables_group = find_group(&groups, AssetGroupType::Tables);
            let views_group = find_group(&groups, AssetGroupType::Views);
            let indexes_group = find_group(&groups, AssetGroupType::Indexes);
            let triggers_group = find_group(&groups, AssetGroupType::Triggers);

            let tables = browser
                .list_containers(Some(&tables_group.container))
                .await
                .map_err(|error| format!("list tables failed: {error:?}"))?;
            let table_container = find_container(&tables, ContainerKind::Table, &table);

            let views = browser
                .list_containers(Some(&views_group.container))
                .await
                .map_err(|error| format!("list views failed: {error:?}"))?;
            find_container(&views, ContainerKind::View, &view);

            let table_groups = browser
                .list_containers(Some(&table_container.container))
                .await
                .map_err(|error| format!("list table groups failed: {error:?}"))?;
            let columns_group = find_group(&table_groups, AssetGroupType::Columns);
            find_group(&table_groups, AssetGroupType::Indexes);
            find_group(&table_groups, AssetGroupType::Triggers);

            let columns = browser
                .list_containers(Some(&columns_group.container))
                .await
                .map_err(|error| format!("list columns failed: {error:?}"))?;
            find_container(&columns, ContainerKind::Column, "id");
            let name_column = find_container(&columns, ContainerKind::Column, "name");
            if name_column.nullable != Some(false) {
                return Err(format!(
                    "SQLite name column nullable mismatch: {name_column:?}"
                ));
            }

            let indexes = browser
                .list_containers(Some(&indexes_group.container))
                .await
                .map_err(|error| format!("list indexes failed: {error:?}"))?;
            find_container(&indexes, ContainerKind::Index, &index);

            let triggers = browser
                .list_containers(Some(&triggers_group.container))
                .await
                .map_err(|error| format!("list triggers failed: {error:?}"))?;
            find_container(&triggers, ContainerKind::Trigger, &trigger);

            driver
                .close()
                .await
                .map_err(|error| format!("close metadata driver failed: {error:?}"))?;
            Ok(())
        }
        .await;

        let cleanup_trigger = sqlite_execute_raw(
            &db_file_path,
            &format!("DROP TRIGGER IF EXISTS {trigger_ident}"),
        )
        .await;
        let cleanup_view =
            sqlite_execute_raw(&db_file_path, &format!("DROP VIEW IF EXISTS {view_ident}")).await;
        let cleanup_table = sqlite_execute_raw(
            &db_file_path,
            &format!("DROP TABLE IF EXISTS {table_ident}"),
        )
        .await;
        if let Err(error) = operation_result {
            panic!(
                "{error}; cleanup_trigger={cleanup_trigger:?}; cleanup_view={cleanup_view:?}; cleanup_table={cleanup_table:?}"
            );
        }
        cleanup_trigger.expect("SQLite metadata smoke cleanup trigger after test");
        cleanup_view.expect("SQLite metadata smoke cleanup view after test");
        cleanup_table.expect("SQLite metadata smoke cleanup table after test");
    });
}

#[test]
fn real_sqlite_read_data_and_sql_editor_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !env.enabled("NEXPILOT_TEST_SQLITE_ENABLED") {
            return;
        }
        if !env.bool_or("NEXPILOT_TEST_ALLOW_WRITES", false)
            || env.bool_or("NEXPILOT_TEST_SQLITE_READ_ONLY", true)
        {
            return;
        }

        let db_file_path = env.required("NEXPILOT_TEST_SQLITE_DB_FILE_PATH");
        let prefix = env
            .optional("NEXPILOT_TEST_SQLITE_SCRATCH_PREFIX")
            .unwrap_or_else(|| "nexpilot_it_".to_string());
        let table = sqlite_scratch_identifier(&prefix, "phase3");
        let view = format!("{table}_view");
        let table_ident = quote_sqlite_identifier(&table);
        let view_ident = quote_sqlite_identifier(&view);

        sqlite_execute_raw(&db_file_path, &format!("DROP VIEW IF EXISTS {view_ident}"))
            .await
            .expect("SQLite Phase 3 smoke cleanup view before test");
        sqlite_execute_raw(
            &db_file_path,
            &format!("DROP TABLE IF EXISTS {table_ident}"),
        )
        .await
        .expect("SQLite Phase 3 smoke cleanup table before test");

        let operation_result: Result<(), String> = async {
            sqlite_execute_raw(
                &db_file_path,
                &format!(
                    "CREATE TABLE {table_ident} (
                         id INTEGER PRIMARY KEY,
                         name TEXT NOT NULL,
                         score REAL,
                         payload JSON,
                         body BLOB
                     )"
                ),
            )
            .await
            .map_err(|error| format!("SQLite Phase 3 smoke create table failed: {error:?}"))?;
            sqlite_execute_raw(
                &db_file_path,
                &format!(
                    "INSERT INTO {table_ident} (id, name, score, payload, body)
                     VALUES (1, 'Ada', 98.5, '{{\"role\":\"admin\"}}', X'0102')"
                ),
            )
            .await
            .map_err(|error| format!("SQLite Phase 3 smoke insert row 1 failed: {error:?}"))?;
            sqlite_execute_raw(
                &db_file_path,
                &format!(
                    "INSERT INTO {table_ident} (id, name, score, payload, body)
                     VALUES (2, 'Linus', 88.25, '{{\"role\":\"user\"}}', X'0304')"
                ),
            )
            .await
            .map_err(|error| format!("SQLite Phase 3 smoke insert row 2 failed: {error:?}"))?;
            sqlite_execute_raw(
                &db_file_path,
                &format!(
                    "INSERT INTO {table_ident} (id, name, score, payload, body)
                     VALUES (3, 'Grace', NULL, NULL, NULL)"
                ),
            )
            .await
            .map_err(|error| format!("SQLite Phase 3 smoke insert row 3 failed: {error:?}"))?;
            sqlite_execute_raw(
                &db_file_path,
                &format!("CREATE VIEW {view_ident} AS SELECT id, name FROM {table_ident}"),
            )
            .await
            .map_err(|error| format!("SQLite Phase 3 smoke create view failed: {error:?}"))?;

            let driver = SqliteDriver::connect(
                "real-sqlite-phase3".to_string(),
                SqliteProfile {
                    db_file_path: db_file_path.clone(),
                    is_read_only: false,
                },
            )
            .await
            .map_err(|error| format!("connect SQLite Phase 3 smoke failed: {error:?}"))?;
            let root = driver
                .list_containers(None)
                .await
                .map_err(|error| format!("Phase 3 smoke list root failed: {error:?}"))?;
            let database = root
                .first()
                .and_then(|container| container.container.database.clone())
                .ok_or_else(|| "Phase 3 smoke missing SQLite file database node".to_string())?;
            let table_container =
                ContainerRef::table(ContainerKind::Table, database.clone(), None, table.clone());
            let view_container =
                ContainerRef::table(ContainerKind::View, database.clone(), None, view.clone());

            let browser = driver
                .as_data_table_browser()
                .ok_or_else(|| "SQLite Phase 3 smoke missing DataTableBrowser".to_string())?;
            let table_page = browser
                .browse_table_data(&table_container, 1, 2, &TableBrowseQuery::default())
                .await
                .map_err(|error| format!("Phase 3 smoke browse table failed: {error:?}"))?;
            if table_page.rows.len() != 2 || !table_page.has_next_page {
                return Err(format!("Phase 3 smoke table page mismatch: {table_page:?}"));
            }
            let stats = browser
                .get_table_page_stats(&table_container, 2, &TableBrowseQuery::default(), Some(2))
                .await
                .map_err(|error| format!("Phase 3 smoke page stats failed: {error:?}"))?;
            if stats.total_rows != 3 || stats.total_pages != 2 {
                return Err(format!("Phase 3 smoke stats mismatch: {stats:?}"));
            }
            let view_page = browser
                .browse_table_data(&view_container, 1, 10, &TableBrowseQuery::default())
                .await
                .map_err(|error| format!("Phase 3 smoke browse view failed: {error:?}"))?;
            if view_page.rows.len() != 3 {
                return Err(format!("Phase 3 smoke view rows mismatch: {view_page:?}"));
            }

            let executor = driver
                .as_sql_executor()
                .ok_or_else(|| "SQLite Phase 3 smoke missing SqlExecutor".to_string())?;
            let context = SqlExecutionContext {
                database: Some(database),
                schema: None,
            };
            let select_result = executor
                .execute_sql(
                    &context,
                    &format!("SELECT id, name FROM {table_ident} ORDER BY id"),
                    1,
                    2,
                )
                .await
                .map_err(|error| format!("Phase 3 smoke SQL SELECT failed: {error:?}"))?;
            if select_result.rows.len() != 2 || !select_result.has_next_page {
                return Err(format!("Phase 3 smoke SELECT mismatch: {select_result:?}"));
            }
            let insert_result = executor
                .execute_sql(
                    &context,
                    &format!(
                        "INSERT INTO {table_ident} (id, name, score) VALUES (4, 'Marie', 77.0)"
                    ),
                    1,
                    10,
                )
                .await
                .map_err(|error| format!("Phase 3 smoke SQL INSERT failed: {error:?}"))?;
            if insert_result.affected_rows != Some(1) {
                return Err(format!("Phase 3 smoke INSERT mismatch: {insert_result:?}"));
            }

            driver
                .close()
                .await
                .map_err(|error| format!("close Phase 3 smoke driver failed: {error:?}"))?;
            Ok(())
        }
        .await;

        let cleanup_view =
            sqlite_execute_raw(&db_file_path, &format!("DROP VIEW IF EXISTS {view_ident}")).await;
        let cleanup_table = sqlite_execute_raw(
            &db_file_path,
            &format!("DROP TABLE IF EXISTS {table_ident}"),
        )
        .await;
        if let Err(error) = operation_result {
            panic!("{error}; cleanup_view={cleanup_view:?}; cleanup_table={cleanup_table:?}");
        }
        cleanup_view.expect("SQLite Phase 3 smoke cleanup view after test");
        cleanup_table.expect("SQLite Phase 3 smoke cleanup table after test");
    });
}

#[test]
fn real_sqlite_writable_datatable_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !env.enabled("NEXPILOT_TEST_SQLITE_ENABLED") {
            return;
        }
        if !env.bool_or("NEXPILOT_TEST_ALLOW_WRITES", false)
            || env.bool_or("NEXPILOT_TEST_SQLITE_READ_ONLY", true)
        {
            return;
        }

        let db_file_path = env.required("NEXPILOT_TEST_SQLITE_DB_FILE_PATH");
        let prefix = env
            .optional("NEXPILOT_TEST_SQLITE_SCRATCH_PREFIX")
            .unwrap_or_else(|| "nexpilot_it_".to_string());
        let table = sqlite_scratch_identifier(&prefix, "phase4");
        let table_ident = quote_sqlite_identifier(&table);

        sqlite_execute_raw(
            &db_file_path,
            &format!("DROP TABLE IF EXISTS {table_ident}"),
        )
        .await
        .expect("SQLite Phase 4 smoke cleanup table before test");

        let operation_result: Result<(), String> = async {
            sqlite_execute_raw(
                &db_file_path,
                &format!(
                    "CREATE TABLE {table_ident} (
                         id INTEGER PRIMARY KEY,
                         name TEXT NOT NULL,
                         note TEXT DEFAULT 'default note',
                         name_upper TEXT GENERATED ALWAYS AS (upper(name)) STORED
                     )"
                ),
            )
            .await
            .map_err(|error| format!("SQLite Phase 4 smoke create table failed: {error:?}"))?;
            sqlite_execute_raw(
                &db_file_path,
                &format!(
                    "INSERT INTO {table_ident} (id, name, note)
                     VALUES
                         (1, 'Ada', 'first'),
                         (2, 'Linus', 'second'),
                         (3, 'Grace', 'third')"
                ),
            )
            .await
            .map_err(|error| format!("SQLite Phase 4 smoke seed rows failed: {error:?}"))?;

            let writable_driver = SqliteDriver::connect(
                "real-sqlite-phase4-writable".to_string(),
                SqliteProfile {
                    db_file_path: db_file_path.clone(),
                    is_read_only: false,
                },
            )
            .await
            .map_err(|error| format!("connect writable SQLite Phase 4 smoke failed: {error:?}"))?;
            assert_sqlite_phase_five_capabilities(&writable_driver.capabilities());
            let root = writable_driver
                .list_containers(None)
                .await
                .map_err(|error| format!("Phase 4 smoke list root failed: {error:?}"))?;
            let database = root
                .first()
                .and_then(|container| container.container.database.clone())
                .ok_or_else(|| "Phase 4 smoke missing SQLite file database node".to_string())?;
            let table_container =
                ContainerRef::table(ContainerKind::Table, database.clone(), None, table.clone());
            let browser = writable_driver
                .as_data_table_browser()
                .ok_or_else(|| "SQLite Phase 4 smoke missing DataTableBrowser".to_string())?;
            let before = browser
                .browse_table_data(&table_container, 1, 10, &TableBrowseQuery::default())
                .await
                .map_err(|error| format!("Phase 4 smoke initial browse failed: {error:?}"))?;
            if !before.source_writable || !before.source_insertable {
                return Err(format!(
                    "Phase 4 smoke writable resource flags mismatch: {before:?}"
                ));
            }
            let name_column = before
                .columns
                .iter()
                .find(|column| column.name == "name")
                .ok_or_else(|| "Phase 4 smoke missing name column".to_string())?;
            if !name_column.is_writable {
                return Err("Phase 4 smoke name column should be writable".to_string());
            }
            let generated_column = before
                .columns
                .iter()
                .find(|column| column.name == "name_upper")
                .ok_or_else(|| "Phase 4 smoke missing generated column".to_string())?;
            if generated_column.is_writable {
                return Err("Phase 4 smoke generated column must be read-only".to_string());
            }

            let change_set = TableChangeSetRequest {
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
                .preview_table_change_set(&table_container, &change_set)
                .await
                .map_err(|error| format!("Phase 4 smoke preview failed: {error:?}"))?;
            if preview.summary.inserts != 1
                || preview.summary.updates != 1
                || preview.summary.deletes != 1
            {
                return Err(format!("Phase 4 smoke preview mismatch: {preview:?}"));
            }
            let commit = browser
                .commit_table_change_set(&table_container, &change_set)
                .await
                .map_err(|error| format!("Phase 4 smoke commit failed: {error:?}"))?;
            if commit.affected_rows != 3 {
                return Err(format!("Phase 4 smoke commit mismatch: {commit:?}"));
            }

            let after = browser
                .browse_table_data(&table_container, 1, 10, &TableBrowseQuery::default())
                .await
                .map_err(|error| format!("Phase 4 smoke final browse failed: {error:?}"))?;
            let id_index = after
                .columns
                .iter()
                .position(|column| column.name == "id")
                .ok_or_else(|| "Phase 4 smoke missing id column".to_string())?;
            let name_index = after
                .columns
                .iter()
                .position(|column| column.name == "name")
                .ok_or_else(|| "Phase 4 smoke missing name column index".to_string())?;
            let note_index = after
                .columns
                .iter()
                .position(|column| column.name == "note")
                .ok_or_else(|| "Phase 4 smoke missing note column".to_string())?;
            let generated_index = after
                .columns
                .iter()
                .position(|column| column.name == "name_upper")
                .ok_or_else(|| "Phase 4 smoke missing generated column index".to_string())?;
            let ids = after
                .rows
                .iter()
                .map(|row| row[id_index].clone())
                .collect::<Vec<_>>();
            if ids != vec![json!(1), json!(3), json!(4)] {
                return Err(format!("Phase 4 smoke row ids mismatch: {ids:?}"));
            }
            let updated = after
                .rows
                .iter()
                .find(|row| row[id_index] == json!(1))
                .ok_or_else(|| "Phase 4 smoke missing updated row".to_string())?;
            if updated[name_index] != json!("Ada Lovelace")
                || updated[generated_index] != json!("ADA LOVELACE")
            {
                return Err(format!("Phase 4 smoke updated row mismatch: {updated:?}"));
            }
            let inserted = after
                .rows
                .iter()
                .find(|row| row[id_index] == json!(4))
                .ok_or_else(|| "Phase 4 smoke missing inserted row".to_string())?;
            if inserted[name_index] != json!("Marie")
                || inserted[note_index] != json!("default note")
                || inserted[generated_index] != json!("MARIE")
            {
                return Err(format!("Phase 4 smoke inserted row mismatch: {inserted:?}"));
            }

            writable_driver
                .close()
                .await
                .map_err(|error| format!("close writable Phase 4 driver failed: {error:?}"))?;

            let read_only_driver = SqliteDriver::connect(
                "real-sqlite-phase4-read-only".to_string(),
                SqliteProfile {
                    db_file_path: db_file_path.clone(),
                    is_read_only: true,
                },
            )
            .await
            .map_err(|error| format!("connect read-only Phase 4 driver failed: {error:?}"))?;
            let read_only_browser = read_only_driver
                .as_data_table_browser()
                .ok_or_else(|| "read-only Phase 4 driver missing DataTableBrowser".to_string())?;
            let read_only_result = read_only_browser
                .browse_table_data(&table_container, 1, 10, &TableBrowseQuery::default())
                .await
                .map_err(|error| format!("Phase 4 smoke read-only browse failed: {error:?}"))?;
            if read_only_result.source_writable
                || read_only_result.source_insertable
                || read_only_result
                    .columns
                    .iter()
                    .any(|column| column.is_writable)
            {
                return Err(format!(
                    "Phase 4 smoke read-only metadata mismatch: {read_only_result:?}"
                ));
            }
            let read_only_error = read_only_browser
                .preview_table_change_set(&table_container, &change_set)
                .await
                .expect_err("read-only Phase 4 preview must fail");
            if !read_only_error.message.contains("read-only") {
                return Err(format!(
                    "Phase 4 smoke read-only error mismatch: {read_only_error:?}"
                ));
            }
            read_only_driver
                .close()
                .await
                .map_err(|error| format!("close read-only Phase 4 driver failed: {error:?}"))?;

            Ok(())
        }
        .await;

        let cleanup_table = sqlite_execute_raw(
            &db_file_path,
            &format!("DROP TABLE IF EXISTS {table_ident}"),
        )
        .await;
        if let Err(error) = operation_result {
            panic!("{error}; cleanup_table={cleanup_table:?}");
        }
        cleanup_table.expect("SQLite Phase 4 smoke cleanup table after test");
    });
}

#[test]
fn real_sqlite_datatable_transaction_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !env.enabled("NEXPILOT_TEST_SQLITE_ENABLED") {
            return;
        }
        if !env.bool_or("NEXPILOT_TEST_ALLOW_WRITES", false)
            || env.bool_or("NEXPILOT_TEST_SQLITE_READ_ONLY", true)
        {
            return;
        }

        let db_file_path = env.required("NEXPILOT_TEST_SQLITE_DB_FILE_PATH");
        let prefix = env
            .optional("NEXPILOT_TEST_SQLITE_SCRATCH_PREFIX")
            .unwrap_or_else(|| "nexpilot_it_".to_string());
        let table = sqlite_scratch_identifier(&prefix, "phase5_tx");
        let table_ident = quote_sqlite_identifier(&table);
        const PROFILE_ID: &str = "real-sqlite-phase5-transaction";
        const TAB_ID: &str = "real-sqlite-phase5-transaction-tab";

        sqlite_execute_raw(
            &db_file_path,
            &format!("DROP TABLE IF EXISTS {table_ident}"),
        )
        .await
        .expect("SQLite Phase 5 smoke cleanup table before test");
        sqlite_execute_raw(
            &db_file_path,
            &format!(
                "CREATE TABLE {table_ident} (
                     id INTEGER PRIMARY KEY,
                     name TEXT NOT NULL,
                     note TEXT
                 )"
            ),
        )
        .await
        .expect("SQLite Phase 5 smoke create scratch table");
        sqlite_execute_raw(
            &db_file_path,
            &format!("INSERT INTO {table_ident} (id, name, note) VALUES (1, 'Ada', 'seed')"),
        )
        .await
        .expect("SQLite Phase 5 smoke seed scratch table");

        let manager = ConnectionRuntimeManager::new();
        let payload = json!({
            "dbFilePath": db_file_path.clone(),
            "isReadOnly": false
        });
        let record = stored_sqlite_record(payload);
        let operation_result: Result<(), String> = async {
            let shared_info = manager
                .connect_profile(PROFILE_ID, &record)
                .await
                .map_err(|error| format!("Phase 5 smoke connect profile failed: {error:?}"))?;
            if !shared_info.capabilities.transaction_manager
                || shared_info.capabilities.schema_mutator
            {
                return Err(format!(
                    "Phase 5 shared runtime capabilities mismatch: {:?}",
                    shared_info.capabilities
                ));
            }

            let tab_info = manager
                .open_tab_runtime(PROFILE_ID, TAB_ID, &record)
                .await
                .map_err(|error| format!("Phase 5 smoke open tab runtime failed: {error:?}"))?;
            if !tab_info.capabilities.transaction_manager || tab_info.capabilities.schema_mutator {
                return Err(format!(
                    "Phase 5 tab runtime capabilities mismatch: {:?}",
                    tab_info.capabilities
                ));
            }

            let root = manager
                .list_containers(PROFILE_ID, None)
                .await
                .map_err(|error| format!("Phase 5 smoke list root failed: {error:?}"))?;
            let database = root
                .first()
                .and_then(|container| container.container.database.clone())
                .ok_or_else(|| "Phase 5 smoke missing SQLite file database node".to_string())?;
            let table_container =
                ContainerRef::table(ContainerKind::Table, database, None, table.clone());
            let change_set = TableChangeSetRequest {
                inserts: vec![TableChangeSetInsert {
                    values: vec![
                        TableCellChange {
                            column: "id".to_string(),
                            value: json!(2),
                        },
                        TableCellChange {
                            column: "name".to_string(),
                            value: json!("Grace"),
                        },
                        TableCellChange {
                            column: "note".to_string(),
                            value: json!("transactional insert"),
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
                deletes: Vec::new(),
            };

            let active = manager
                .begin_tab_transaction(PROFILE_ID, TAB_ID, &table_container)
                .await
                .map_err(|error| format!("Phase 5 smoke begin transaction failed: {error:?}"))?;
            if !active.in_transaction
                || active.database.as_deref() != table_container.database.as_deref()
            {
                return Err(format!("Phase 5 active transaction state mismatch: {active:?}"));
            }
            manager
                .commit_table_change_set(
                    PROFILE_ID,
                    Some(TAB_ID),
                    &table_container,
                    &change_set,
                )
                .await
                .map_err(|error| {
                    format!("Phase 5 smoke save rollback change set failed: {error:?}")
                })?;

            let owner_rows = manager
                .browse_table_data(
                    PROFILE_ID,
                    Some(TAB_ID),
                    &table_container,
                    1,
                    10,
                    &TableBrowseQuery::default(),
                )
                .await
                .map_err(|error| format!("Phase 5 smoke transactional browse failed: {error:?}"))?;
            let id_index = owner_rows
                .columns
                .iter()
                .position(|column| column.name == "id")
                .ok_or_else(|| "Phase 5 smoke missing id column".to_string())?;
            let name_index = owner_rows
                .columns
                .iter()
                .position(|column| column.name == "name")
                .ok_or_else(|| "Phase 5 smoke missing name column".to_string())?;
            if owner_rows.rows.len() != 2
                || !owner_rows.rows.iter().any(|row| row[id_index] == json!(2))
                || !owner_rows.rows.iter().any(|row| {
                    row[id_index] == json!(1) && row[name_index] == json!("Ada Lovelace")
                })
            {
                return Err(format!(
                    "Phase 5 transactional rows mismatch: {owner_rows:?}"
                ));
            }
            let owner_stats = manager
                .get_table_page_stats(
                    PROFILE_ID,
                    Some(TAB_ID),
                    &table_container,
                    10,
                    &TableBrowseQuery::default(),
                    Some(1),
                )
                .await
                .map_err(|error| format!("Phase 5 smoke page stats failed: {error:?}"))?;
            if owner_stats.total_rows != 2 {
                return Err(format!(
                    "Phase 5 transactional page stats mismatch: {owner_stats:?}"
                ));
            }

            let external_before_rollback = sqlite_read_scalar(
                &db_file_path,
                &format!("SELECT COUNT(*) FROM {table_ident}"),
            )
            .await
            .map_err(|error| {
                format!("Phase 5 external read before rollback failed: {error:?}")
            })?;
            if external_before_rollback != 1 {
                return Err(format!(
                    "Phase 5 external reader saw uncommitted rows: {external_before_rollback}"
                ));
            }

            manager
                .rollback_tab_transaction(PROFILE_ID, TAB_ID)
                .await
                .map_err(|error| format!("Phase 5 smoke rollback failed: {error:?}"))?;
            let external_after_rollback = sqlite_read_scalar(
                &db_file_path,
                &format!("SELECT COUNT(*) FROM {table_ident}"),
            )
            .await
            .map_err(|error| format!("Phase 5 external read after rollback failed: {error:?}"))?;
            if external_after_rollback != 1 {
                return Err(format!(
                    "Phase 5 rollback row count mismatch: {external_after_rollback}"
                ));
            }

            manager
                .begin_tab_transaction(PROFILE_ID, TAB_ID, &table_container)
                .await
                .map_err(|error| {
                    format!("Phase 5 smoke second transaction begin failed: {error:?}")
                })?;
            manager
                .commit_table_change_set(
                    PROFILE_ID,
                    Some(TAB_ID),
                    &table_container,
                    &change_set,
                )
                .await
                .map_err(|error| {
                    format!("Phase 5 smoke save commit change set failed: {error:?}")
                })?;
            manager
                .commit_tab_transaction(PROFILE_ID, TAB_ID)
                .await
                .map_err(|error| format!("Phase 5 smoke commit failed: {error:?}"))?;
            let external_after_commit = sqlite_read_scalar(
                &db_file_path,
                &format!("SELECT COUNT(*) FROM {table_ident}"),
            )
            .await
            .map_err(|error| format!("Phase 5 external read after commit failed: {error:?}"))?;
            let external_updated_name = sqlite_read_scalar(
                &db_file_path,
                &format!(
                    "SELECT COUNT(*) FROM {table_ident} WHERE id = 1 AND name = 'Ada Lovelace'"
                ),
            )
            .await
            .map_err(|error| {
                format!("Phase 5 external updated-name read failed: {error:?}")
            })?;
            if external_after_commit != 2 || external_updated_name != 1 {
                return Err(format!(
                    "Phase 5 committed visibility mismatch: rows={external_after_commit}, updated={external_updated_name}"
                ));
            }

            manager
                .begin_tab_transaction(PROFILE_ID, TAB_ID, &table_container)
                .await
                .map_err(|error| {
                    format!("Phase 5 smoke close rollback begin failed: {error:?}")
                })?;
            manager
                .commit_table_change_set(
                    PROFILE_ID,
                    Some(TAB_ID),
                    &table_container,
                    &TableChangeSetRequest {
                        inserts: vec![TableChangeSetInsert {
                            values: vec![
                                TableCellChange {
                                    column: "id".to_string(),
                                    value: json!(3),
                                },
                                TableCellChange {
                                    column: "name".to_string(),
                                    value: json!("Close Rollback"),
                                },
                            ],
                        }],
                        updates: Vec::new(),
                        deletes: Vec::new(),
                    },
                )
                .await
                .map_err(|error| {
                    format!("Phase 5 smoke save close rollback row failed: {error:?}")
                })?;
            manager
                .close_tab_runtime(TAB_ID)
                .await
                .map_err(|error| format!("Phase 5 smoke close tab failed: {error:?}"))?;
            let external_after_close = sqlite_read_scalar(
                &db_file_path,
                &format!("SELECT COUNT(*) FROM {table_ident} WHERE id = 3"),
            )
            .await
            .map_err(|error| format!("Phase 5 external read after close failed: {error:?}"))?;
            if external_after_close != 0 {
                return Err(format!(
                    "Phase 5 close-tab rollback persisted id 3: {external_after_close}"
                ));
            }

            Ok(())
        }
        .await;

        let close_tab_result = manager.close_tab_runtime(TAB_ID).await;
        let disconnect_result = manager.disconnect_profile(PROFILE_ID).await;
        let cleanup_table = sqlite_execute_raw(
            &db_file_path,
            &format!("DROP TABLE IF EXISTS {table_ident}"),
        )
        .await;
        if let Err(error) = operation_result {
            panic!(
                "{error}; close_tab={close_tab_result:?}; disconnect={disconnect_result:?}; cleanup_table={cleanup_table:?}"
            );
        }
        close_tab_result.expect("SQLite Phase 5 smoke tab cleanup after test");
        disconnect_result.expect("SQLite Phase 5 smoke profile disconnect after test");
        cleanup_table.expect("SQLite Phase 5 smoke cleanup table after test");
    });
}

fn stored_sqlite_record(payload: serde_json::Value) -> StoredConnectionRecord {
    StoredConnectionRecord {
        id: "real-sqlite-smoke".to_string(),
        name: "Real SQLite Smoke".to_string(),
        driver: ConnectionDriver::Sqlite,
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

fn assert_sqlite_phase_five_info(info: &ConnectionRuntimeInfo) {
    assert_eq!(info.driver_name, "sqlite");
    assert_sqlite_phase_five_capabilities(&info.capabilities);
}

fn assert_sqlite_phase_five_capabilities(capabilities: &DriverCapabilities) {
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

fn sqlite_scratch_identifier(prefix: &str, marker: &str) -> String {
    let sanitized_prefix = prefix
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '_')
        .map(|character| character.to_ascii_lowercase())
        .collect::<String>();
    let prefix = if sanitized_prefix.is_empty() {
        "nexpilot_it_".to_string()
    } else {
        sanitized_prefix
    };
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system time")
        .as_millis();
    format!("{prefix}{marker}_{millis}")
        .chars()
        .take(48)
        .collect()
}

fn quote_sqlite_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

async fn sqlite_execute_raw(db_file_path: &str, sql: &str) -> crate::error::IpcResult<()> {
    let options = SqliteConnectOptions::new()
        .filename(db_file_path)
        .create_if_missing(false)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| {
            crate::error::IpcError::system_internal(
                "SQLite real metadata smoke setup failed",
                error.to_string(),
            )
        })?;
    let result = sqlx::query(sql)
        .execute(&pool)
        .await
        .map(|_| ())
        .map_err(|error| {
            crate::error::IpcError::system_internal(
                "SQLite real metadata smoke SQL failed",
                error.to_string(),
            )
        });
    pool.close().await;
    result
}

async fn sqlite_read_scalar(db_file_path: &str, sql: &str) -> crate::error::IpcResult<i64> {
    let options = SqliteConnectOptions::new()
        .filename(db_file_path)
        .read_only(true)
        .create_if_missing(false)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| {
            crate::error::IpcError::system_internal(
                "SQLite real transaction smoke read failed",
                error.to_string(),
            )
        })?;
    let result = sqlx::query_scalar::<_, i64>(sql)
        .fetch_one(&pool)
        .await
        .map_err(|error| {
            crate::error::IpcError::system_internal(
                "SQLite real transaction smoke scalar query failed",
                error.to_string(),
            )
        });
    pool.close().await;
    result
}

fn find_group(containers: &[DataContainer], group_type: AssetGroupType) -> &DataContainer {
    containers
        .iter()
        .find(|container| container.container.group_type == Some(group_type.clone()))
        .unwrap_or_else(|| panic!("missing SQLite real metadata group {group_type:?}"))
}

fn find_container<'a>(
    containers: &'a [DataContainer],
    kind: ContainerKind,
    name: &str,
) -> &'a DataContainer {
    containers
        .iter()
        .find(|container| container.kind == kind && container.name == name)
        .unwrap_or_else(|| panic!("missing SQLite real metadata {kind:?} named {name}"))
}
