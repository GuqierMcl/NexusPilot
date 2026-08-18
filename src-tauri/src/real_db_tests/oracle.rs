use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value as JsonValue;

use crate::engine::driver::DatabaseDriver;
use crate::engine::drivers::oracle::{quote_oracle_identifier, OracleDriver};
use crate::engine::profiles::{OracleProfile, OracleRole};
use crate::engine::types::{
    ContainerKind, ContainerRef, DropTableInput, SqlExecutionContext, TableBrowseQuery,
    TableCellChange, TableChangeSetInsert, TableChangeSetRequest, TableChangeSetUpdate,
    TableColumnRename, TableColumnSchema, TableConstraintKind, TableConstraintSchema,
    TableForeignKeyReference, TableIdentityGeneration, TableIdentityOptions, TableIndexSchema,
    TableReferentialAction, TableRowKeyPart, TableRowLocator, TableSchema, TableSchemaBasics,
    UpdateTableInput,
};
use crate::error::{IpcError, IpcResult};

use super::common::{run_async, TestEnv};

fn primary_key_locator(parts: Vec<TableRowKeyPart>) -> TableRowLocator {
    TableRowLocator::primary_key(parts)
}

trait OracleTestEnvExt {
    fn oracle_role_or(&self, key: &str, default: OracleRole) -> OracleRole;
}

impl OracleTestEnvExt for TestEnv {
    fn oracle_role_or(&self, key: &str, default: OracleRole) -> OracleRole {
        match self
            .optional(key)
            .map(|value| value.to_ascii_lowercase())
            .as_deref()
        {
            Some("normal") | None => default,
            Some("sysdba") => OracleRole::Sysdba,
            Some("sysoper") => OracleRole::Sysoper,
            Some(_) => panic!("{key} must be normal, sysdba, or sysoper"),
        }
    }
}

#[test]
fn real_oracle_read_only_and_metadata_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !env.enabled("NEXPILOT_TEST_ORACLE_ENABLED") {
            return;
        }

        let schema = env.required("NEXPILOT_TEST_ORACLE_SCHEMA");
        let database = env
            .optional("NEXPILOT_TEST_ORACLE_SERVICE_NAME")
            .or_else(|| env.optional("NEXPILOT_TEST_ORACLE_SID"))
            .or_else(|| env.optional("NEXPILOT_TEST_ORACLE_CONNECT_DESCRIPTOR"))
            .unwrap_or_else(|| "oracle".to_string());
        let profile = OracleProfile {
            host: env.required("NEXPILOT_TEST_ORACLE_HOST"),
            port: env.u16_or("NEXPILOT_TEST_ORACLE_PORT", 1521),
            username: env.required("NEXPILOT_TEST_ORACLE_USERNAME"),
            password: env.required("NEXPILOT_TEST_ORACLE_PASSWORD"),
            service_name: env.optional("NEXPILOT_TEST_ORACLE_SERVICE_NAME"),
            sid: env.optional("NEXPILOT_TEST_ORACLE_SID"),
            connect_descriptor: env.optional("NEXPILOT_TEST_ORACLE_CONNECT_DESCRIPTOR"),
            role: env.oracle_role_or("NEXPILOT_TEST_ORACLE_ROLE", OracleRole::Normal),
            connect_timeout_seconds: Some(env.u64_or("NEXPILOT_TEST_CONNECT_TIMEOUT_SECONDS", 10)),
            ssh_tunnel: None,
        };

        let driver = OracleDriver::connect("real-oracle-smoke".to_string(), profile)
            .await
            .expect("Oracle real smoke should connect");
        driver.ping().await.expect("Oracle real smoke should ping");
        driver
            .as_schema_browser()
            .expect("Oracle schema browser")
            .list_containers(None)
            .await
            .expect("Oracle real smoke should list schemas");
        let result = driver
            .as_sql_executor()
            .expect("Oracle SQL executor")
            .execute_sql(
                &SqlExecutionContext {
                    database: Some(database.clone()),
                    schema: None,
                },
                "SELECT 'OK' AS STATUS FROM dual",
                0,
                10,
            )
            .await
            .expect("Oracle real smoke should execute SELECT from dual");
        assert_eq!(result.rows.len(), 1);

        let table = env
            .optional("NEXPILOT_TEST_ORACLE_PK_TABLE")
            .or_else(|| env.optional("NEXPILOT_TEST_ORACLE_READ_TABLE"));
        if let Some(table) = table {
            let container =
                ContainerRef::table(ContainerKind::Table, database, Some(schema), table);
            let browse = driver
                .as_data_table_browser()
                .expect("Oracle table browser")
                .browse_table_data(&container, 0, 5, &TableBrowseQuery::default())
                .await
                .expect("Oracle real smoke should browse configured table");
            assert!(!browse.columns.is_empty());

            let preview_probe = TableChangeSetRequest {
                inserts: Vec::new(),
                updates: vec![TableChangeSetUpdate {
                    locator: primary_key_locator(vec![TableRowKeyPart {
                        column: "__NEXPILOT_METADATA_PROBE__".to_string(),
                        value: JsonValue::Null,
                    }]),
                    changes: vec![TableCellChange {
                        column: "__NEXPILOT_METADATA_PROBE__".to_string(),
                        value: JsonValue::Null,
                    }],
                }],
                deletes: Vec::new(),
            };
            if let Err(error) = driver
                .as_data_table_browser()
                .expect("Oracle table browser")
                .preview_table_change_set(&container, &preview_probe)
                .await
            {
                let code = format!("{:?}", error.code);
                assert_ne!(
                    code, "NetworkTimeout",
                    "Oracle metadata preview probe must not interrupt the connection: {}",
                    error.message
                );
            }
        }

        driver.close().await.expect("close Oracle smoke driver");
    });
}

#[test]
fn real_oracle_sql_editor_context_and_paging_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !env.enabled("NEXPILOT_TEST_ORACLE_ENABLED") {
            return;
        }

        let schema = env.required("NEXPILOT_TEST_ORACLE_SCHEMA");
        let database = env
            .optional("NEXPILOT_TEST_ORACLE_SERVICE_NAME")
            .or_else(|| env.optional("NEXPILOT_TEST_ORACLE_SID"))
            .or_else(|| env.optional("NEXPILOT_TEST_ORACLE_CONNECT_DESCRIPTOR"))
            .unwrap_or_else(|| "oracle".to_string());
        let profile = OracleProfile {
            host: env.required("NEXPILOT_TEST_ORACLE_HOST"),
            port: env.u16_or("NEXPILOT_TEST_ORACLE_PORT", 1521),
            username: env.required("NEXPILOT_TEST_ORACLE_USERNAME"),
            password: env.required("NEXPILOT_TEST_ORACLE_PASSWORD"),
            service_name: env.optional("NEXPILOT_TEST_ORACLE_SERVICE_NAME"),
            sid: env.optional("NEXPILOT_TEST_ORACLE_SID"),
            connect_descriptor: env.optional("NEXPILOT_TEST_ORACLE_CONNECT_DESCRIPTOR"),
            role: env.oracle_role_or("NEXPILOT_TEST_ORACLE_ROLE", OracleRole::Normal),
            connect_timeout_seconds: Some(env.u64_or("NEXPILOT_TEST_CONNECT_TIMEOUT_SECONDS", 10)),
            ssh_tunnel: None,
        };

        let driver = OracleDriver::connect("real-oracle-sql-editor".to_string(), profile)
            .await
            .expect("Oracle SQL editor smoke should connect");
        let executor = driver
            .as_sql_executor()
            .expect("Oracle SQL editor smoke should expose SQL executor");
        let context = SqlExecutionContext {
            database: Some(database),
            schema: Some(schema.clone()),
        };

        let context_result = executor
            .execute_sql(&context, "SELECT 1 AS status FROM dual", 1, 10)
            .await
            .expect("Oracle SQL editor smoke should execute with schema context");
        assert_eq!(context_result.rows.len(), 1);
        assert_eq!(json_cell_text(&context_result.rows[0][0]), "1");

        let page_one = executor
            .execute_sql(
                &context,
                "SELECT LEVEL AS n FROM dual CONNECT BY LEVEL <= 3 ORDER BY LEVEL",
                1,
                2,
            )
            .await
            .expect("Oracle SQL editor smoke should fetch page one");
        assert_eq!(page_one.rows.len(), 2);
        assert!(page_one.has_next_page);
        assert_eq!(json_cell_text(&page_one.rows[0][0]), "1");
        assert_eq!(json_cell_text(&page_one.rows[1][0]), "2");

        let page_two = executor
            .execute_sql(
                &context,
                "SELECT LEVEL AS n FROM dual CONNECT BY LEVEL <= 3 ORDER BY LEVEL",
                2,
                2,
            )
            .await
            .expect("Oracle SQL editor smoke should fetch page two");
        assert_eq!(page_two.rows.len(), 1);
        assert!(!page_two.has_next_page);
        assert_eq!(json_cell_text(&page_two.rows[0][0]), "3");

        driver
            .close()
            .await
            .expect("close Oracle SQL editor smoke driver");
    });
}

#[test]
fn real_oracle_sql_editor_sequential_script_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !env.enabled("NEXPILOT_TEST_ORACLE_ENABLED") {
            return;
        }

        let schema = env.required("NEXPILOT_TEST_ORACLE_SCHEMA");
        let database = env
            .optional("NEXPILOT_TEST_ORACLE_SERVICE_NAME")
            .or_else(|| env.optional("NEXPILOT_TEST_ORACLE_SID"))
            .or_else(|| env.optional("NEXPILOT_TEST_ORACLE_CONNECT_DESCRIPTOR"))
            .unwrap_or_else(|| "oracle".to_string());
        let profile = OracleProfile {
            host: env.required("NEXPILOT_TEST_ORACLE_HOST"),
            port: env.u16_or("NEXPILOT_TEST_ORACLE_PORT", 1521),
            username: env.required("NEXPILOT_TEST_ORACLE_USERNAME"),
            password: env.required("NEXPILOT_TEST_ORACLE_PASSWORD"),
            service_name: env.optional("NEXPILOT_TEST_ORACLE_SERVICE_NAME"),
            sid: env.optional("NEXPILOT_TEST_ORACLE_SID"),
            connect_descriptor: env.optional("NEXPILOT_TEST_ORACLE_CONNECT_DESCRIPTOR"),
            role: env.oracle_role_or("NEXPILOT_TEST_ORACLE_ROLE", OracleRole::Normal),
            connect_timeout_seconds: Some(env.u64_or("NEXPILOT_TEST_CONNECT_TIMEOUT_SECONDS", 10)),
            ssh_tunnel: None,
        };

        let driver = OracleDriver::connect("real-oracle-sql-script".to_string(), profile)
            .await
            .expect("Oracle SQL script smoke should connect");
        let executor = driver
            .as_sql_executor()
            .expect("Oracle SQL script smoke should expose SQL executor");
        let context = SqlExecutionContext {
            database: Some(database),
            schema: Some(schema),
        };
        let statements = [
            ("SELECT 1 AS step_value FROM dual", "1"),
            ("SELECT 2 AS step_value FROM dual", "2"),
            ("SELECT 3 AS step_value FROM dual", "3"),
        ];

        for (sql, expected) in statements {
            let result = executor
                .execute_sql(&context, sql, 1, 10)
                .await
                .expect("Oracle SQL script smoke should execute statement sequentially");
            assert_eq!(result.rows.len(), 1);
            assert_eq!(json_cell_text(&result.rows[0][0]), expected);
        }

        driver
            .close()
            .await
            .expect("close Oracle SQL script smoke driver");
    });
}

#[test]
fn real_oracle_writable_datatable_scratch_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !env.enabled("NEXPILOT_TEST_ORACLE_ENABLED")
            || !env.bool_or("NEXPILOT_TEST_ALLOW_WRITES", false)
        {
            return;
        }

        let schema = env.required("NEXPILOT_TEST_ORACLE_SCHEMA");
        let database = env
            .optional("NEXPILOT_TEST_ORACLE_SERVICE_NAME")
            .or_else(|| env.optional("NEXPILOT_TEST_ORACLE_SID"))
            .or_else(|| env.optional("NEXPILOT_TEST_ORACLE_CONNECT_DESCRIPTOR"))
            .unwrap_or_else(|| "oracle".to_string());
        let profile = OracleProfile {
            host: env.required("NEXPILOT_TEST_ORACLE_HOST"),
            port: env.u16_or("NEXPILOT_TEST_ORACLE_PORT", 1521),
            username: env.required("NEXPILOT_TEST_ORACLE_USERNAME"),
            password: env.required("NEXPILOT_TEST_ORACLE_PASSWORD"),
            service_name: env.optional("NEXPILOT_TEST_ORACLE_SERVICE_NAME"),
            sid: env.optional("NEXPILOT_TEST_ORACLE_SID"),
            connect_descriptor: env.optional("NEXPILOT_TEST_ORACLE_CONNECT_DESCRIPTOR"),
            role: env.oracle_role_or("NEXPILOT_TEST_ORACLE_ROLE", OracleRole::Normal),
            connect_timeout_seconds: Some(env.u64_or("NEXPILOT_TEST_CONNECT_TIMEOUT_SECONDS", 10)),
            ssh_tunnel: None,
        };

        let driver = OracleDriver::connect("real-oracle-write-smoke".to_string(), profile)
            .await
            .expect("Oracle write smoke should connect");
        let table = oracle_scratch_identifier(
            &env.optional("NEXPILOT_TEST_SCRATCH_PREFIX")
                .unwrap_or_else(|| "NEXPILOT_IT_".to_string()),
            "OD",
        );
        let qualified_table = oracle_qualified_name(&schema, &table);

        if let Err(error) = setup_oracle_scratch_table(&driver, &qualified_table).await {
            let cleanup_result = drop_oracle_scratch_table(&driver, &qualified_table).await;
            let close_result = driver.close().await;
            panic!(
                "Oracle write smoke should create scratch table: {error:?}; cleanup_result={cleanup_result:?}; close_result={close_result:?}"
            );
        }

        let container = ContainerRef::table(ContainerKind::Table, database, Some(schema), table);
        let change_set = TableChangeSetRequest {
            inserts: vec![TableChangeSetInsert {
                values: vec![
                    TableCellChange {
                        column: "ID".to_string(),
                        value: serde_json::json!(2),
                    },
                    TableCellChange {
                        column: "NAME".to_string(),
                        value: serde_json::json!("inserted"),
                    },
                    TableCellChange {
                        column: "CREATED_AT".to_string(),
                        value: serde_json::json!("2026-07-06 18:21:54"),
                    },
                ],
            }],
            updates: vec![TableChangeSetUpdate {
                locator: primary_key_locator(vec![TableRowKeyPart {
                    column: "ID".to_string(),
                    value: serde_json::json!(1),
                }]),
                changes: vec![TableCellChange {
                    column: "NAME".to_string(),
                    value: serde_json::json!("after"),
                }],
            }],
            deletes: vec![primary_key_locator(vec![TableRowKeyPart {
                column: "ID".to_string(),
                value: serde_json::json!(2),
            }])],
        };

        let browser = driver
            .as_data_table_browser()
            .expect("Oracle table browser");
        let operation_result: Result<(), String> = async {
            let preview = browser
                .preview_table_change_set(&container, &change_set)
                .await
                .map_err(|error| {
                    format!("Oracle write smoke should preview scratch changes: {error:?}")
                })?;
            if preview.summary.inserts != 1
                || preview.summary.updates != 1
                || preview.summary.deletes != 1
            {
                return Err(format!(
                    "Oracle preview summary mismatch: inserts={} updates={} deletes={}",
                    preview.summary.inserts, preview.summary.updates, preview.summary.deletes
                ));
            }

            let commit = browser
                .commit_table_change_set(&container, &change_set)
                .await
                .map_err(|error| {
                    format!("Oracle write smoke should commit scratch changes: {error:?}")
                })?;
            if commit.affected_rows != 3 {
                return Err(format!(
                    "Oracle commit affected row mismatch: expected 3, got {}",
                    commit.affected_rows
                ));
            }

            let browse = browser
                .browse_table_data(&container, 0, 10, &TableBrowseQuery::default())
                .await
                .map_err(|error| {
                    format!(
                        "Oracle write smoke should browse scratch table after commit: {error:?}"
                    )
                })?;
            let name_index = browse
                .columns
                .iter()
                .position(|column| column.name == "NAME")
                .ok_or_else(|| "scratch table should expose NAME column".to_string())?;
            if browse.rows.len() != 1 {
                return Err(format!(
                    "Oracle scratch table row count mismatch: expected 1, got {}",
                    browse.rows.len()
                ));
            }
            if browse.rows[0][name_index] != serde_json::json!("after") {
                return Err(format!(
                    "Oracle scratch table NAME mismatch: expected \"after\", got {}",
                    browse.rows[0][name_index]
                ));
            }

            Ok(())
        }
        .await;

        let cleanup_result = drop_oracle_scratch_table(&driver, &qualified_table).await;
        let close_result = driver.close().await;
        if let Err(error) = operation_result {
            panic!("{error}; cleanup_result={cleanup_result:?}; close_result={close_result:?}");
        }
        cleanup_result.expect("Oracle write smoke should drop scratch table");
        close_result.expect("close Oracle write smoke driver");
    });
}

#[test]
fn real_oracle_drop_table_scratch_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !oracle_write_tests_enabled(&env) {
            return;
        }

        let schema = oracle_schema_from_env(&env);
        let database = oracle_database_from_env(&env);
        let driver =
            connect_oracle_driver_from_env(&env, "real-oracle-drop-table".to_string()).await;
        let table = oracle_scratch_identifier(&oracle_scratch_prefix_from_env(&env), "DT");
        let qualified_table = oracle_qualified_name(&schema, &table);
        let container = ContainerRef::table(
            ContainerKind::Table,
            database.clone(),
            Some(schema.clone()),
            table.clone(),
        );

        if let Err(error) = setup_oracle_scratch_table(&driver, &qualified_table).await {
            let cleanup_result = drop_oracle_table_best_effort(&driver, &qualified_table).await;
            let close_result = driver.close().await;
            panic!(
                "Oracle drop table smoke should create scratch table: {error:?}; cleanup_result={cleanup_result:?}; close_result={close_result:?}"
            );
        }

        let operation_result: Result<(), String> = async {
            let mut input = DropTableInput {
                container: container.clone(),
                confirm_destructive: false,
            };
            let mutator = driver
                .as_schema_mutator()
                .expect("Oracle schema mutator should exist");
            let preview = mutator
                .preview_drop_table(&input)
                .await
                .map_err(|error| format!("Oracle drop smoke should preview drop: {error:?}"))?;
            if !preview.destructive
                || !preview
                    .statements
                    .contains(&format!("DROP TABLE {qualified_table}"))
                || preview
                    .statements
                    .iter()
                    .any(|statement| statement.contains("PURGE"))
            {
                return Err(format!("Oracle drop preview mismatch: {preview:?}"));
            }

            let confirm_error = mutator
                .drop_table(&input)
                .await
                .expect_err("Oracle drop table should require destructive confirmation");
            if format!("{:?}", confirm_error.code) != "ValidationFailed" {
                return Err(format!(
                    "Oracle drop confirm error mismatch: {confirm_error:?}"
                ));
            }

            input.confirm_destructive = true;
            let result = mutator
                .drop_table(&input)
                .await
                .map_err(|error| format!("Oracle drop smoke should drop table: {error:?}"))?;
            if result.table_name != table {
                return Err(format!(
                    "Oracle drop result table mismatch: expected {table}, got {}",
                    result.table_name
                ));
            }

            if driver
                .as_schema_browser()
                .expect("Oracle schema browser should exist")
                .describe_table(&container)
                .await
                .is_ok()
            {
                return Err("Oracle dropped table should no longer describe".to_string());
            }

            Ok(())
        }
        .await;

        let cleanup_result = if operation_result.is_err() {
            drop_oracle_table_best_effort(&driver, &qualified_table).await
        } else {
            Ok(())
        };
        let close_result = driver.close().await;
        if let Err(error) = operation_result {
            panic!("{error}; cleanup_result={cleanup_result:?}; close_result={close_result:?}");
        }
        close_result.expect("close Oracle drop table smoke driver");
    });
}

#[test]
fn real_oracle_transaction_rollback_scratch_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !oracle_write_tests_enabled(&env) {
            return;
        }

        let schema = oracle_schema_from_env(&env);
        let database = oracle_database_from_env(&env);
        let driver =
            connect_oracle_driver_from_env(&env, "real-oracle-rollback-smoke".to_string()).await;
        let table = oracle_scratch_identifier(&oracle_scratch_prefix_from_env(&env), "RB");
        let qualified_table = oracle_qualified_name(&schema, &table);

        if let Err(error) = setup_oracle_scratch_table(&driver, &qualified_table).await {
            let cleanup_result = drop_oracle_scratch_table(&driver, &qualified_table).await;
            let close_result = driver.close().await;
            panic!(
                "Oracle rollback smoke should create scratch table: {error:?}; cleanup_result={cleanup_result:?}; close_result={close_result:?}"
            );
        }

        let container = ContainerRef::table(ContainerKind::Table, database, Some(schema), table);
        let browser = driver
            .as_data_table_browser()
            .expect("Oracle table browser");
        let transaction = driver
            .as_transaction_manager()
            .expect("Oracle transaction manager");
        let operation_result: Result<(), String> = async {
            let state = transaction
                .begin_transaction(&container)
                .await
                .map_err(|error| format!("Oracle rollback smoke should begin: {error:?}"))?;
            if !state.in_transaction {
                return Err("Oracle rollback smoke should enter transaction".to_string());
            }

            let change_set = oracle_name_update_change_set(1, "rolled_back");
            let commit = browser
                .commit_table_change_set(&container, &change_set)
                .await
                .map_err(|error| {
                    format!("Oracle rollback smoke should save inside transaction: {error:?}")
                })?;
            if commit.affected_rows != 1 {
                return Err(format!(
                    "Oracle rollback smoke affected row mismatch: expected 1, got {}",
                    commit.affected_rows
                ));
            }

            let in_transaction = browser
                .browse_table_data(&container, 0, 10, &TableBrowseQuery::default())
                .await
                .map_err(|error| {
                    format!("Oracle rollback smoke should browse transaction state: {error:?}")
                })?;
            assert_oracle_row_name(&in_transaction, "1", "rolled_back")?;

            let state = transaction
                .rollback_transaction()
                .await
                .map_err(|error| format!("Oracle rollback smoke should rollback: {error:?}"))?;
            if state.in_transaction {
                return Err("Oracle rollback smoke should leave transaction".to_string());
            }

            let after = browser
                .browse_table_data(&container, 0, 10, &TableBrowseQuery::default())
                .await
                .map_err(|error| {
                    format!("Oracle rollback smoke should browse after rollback: {error:?}")
                })?;
            assert_oracle_row_name(&after, "1", "before")?;

            Ok(())
        }
        .await;

        let _ = transaction.rollback_transaction().await;
        let cleanup_result = drop_oracle_scratch_table(&driver, &qualified_table).await;
        let close_result = driver.close().await;
        if let Err(error) = operation_result {
            panic!("{error}; cleanup_result={cleanup_result:?}; close_result={close_result:?}");
        }
        cleanup_result.expect("Oracle rollback smoke should drop scratch table");
        close_result.expect("close Oracle rollback smoke driver");
    });
}

#[test]
fn real_oracle_transaction_commit_scratch_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !oracle_write_tests_enabled(&env) {
            return;
        }

        let schema = oracle_schema_from_env(&env);
        let database = oracle_database_from_env(&env);
        let driver =
            connect_oracle_driver_from_env(&env, "real-oracle-commit-smoke".to_string()).await;
        let table = oracle_scratch_identifier(&oracle_scratch_prefix_from_env(&env), "CM");
        let qualified_table = oracle_qualified_name(&schema, &table);

        if let Err(error) = setup_oracle_scratch_table(&driver, &qualified_table).await {
            let cleanup_result = drop_oracle_scratch_table(&driver, &qualified_table).await;
            let close_result = driver.close().await;
            panic!(
                "Oracle commit smoke should create scratch table: {error:?}; cleanup_result={cleanup_result:?}; close_result={close_result:?}"
            );
        }

        let container = ContainerRef::table(ContainerKind::Table, database, Some(schema), table);
        let browser = driver
            .as_data_table_browser()
            .expect("Oracle table browser");
        let transaction = driver
            .as_transaction_manager()
            .expect("Oracle transaction manager");
        let operation_result: Result<(), String> = async {
            transaction
                .begin_transaction(&container)
                .await
                .map_err(|error| format!("Oracle commit smoke should begin: {error:?}"))?;

            let change_set = oracle_name_update_change_set(1, "committed");
            let commit = browser
                .commit_table_change_set(&container, &change_set)
                .await
                .map_err(|error| {
                    format!("Oracle commit smoke should save inside transaction: {error:?}")
                })?;
            if commit.affected_rows != 1 {
                return Err(format!(
                    "Oracle commit smoke affected row mismatch: expected 1, got {}",
                    commit.affected_rows
                ));
            }

            let state = transaction
                .commit_transaction()
                .await
                .map_err(|error| format!("Oracle commit smoke should commit: {error:?}"))?;
            if state.in_transaction {
                return Err("Oracle commit smoke should leave transaction".to_string());
            }

            let after = browser
                .browse_table_data(&container, 0, 10, &TableBrowseQuery::default())
                .await
                .map_err(|error| {
                    format!("Oracle commit smoke should browse after commit: {error:?}")
                })?;
            assert_oracle_row_name(&after, "1", "committed")?;

            Ok(())
        }
        .await;

        let _ = transaction.rollback_transaction().await;
        let cleanup_result = drop_oracle_scratch_table(&driver, &qualified_table).await;
        let close_result = driver.close().await;
        if let Err(error) = operation_result {
            panic!("{error}; cleanup_result={cleanup_result:?}; close_result={close_result:?}");
        }
        cleanup_result.expect("Oracle commit smoke should drop scratch table");
        close_result.expect("close Oracle commit smoke driver");
    });
}

#[test]
fn real_oracle_readonly_resource_capabilities_scratch_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !oracle_write_tests_enabled(&env) {
            return;
        }

        let schema = oracle_schema_from_env(&env);
        let database = oracle_database_from_env(&env);
        let driver =
            connect_oracle_driver_from_env(&env, "real-oracle-readonly-smoke".to_string()).await;
        let no_pk_table = oracle_scratch_identifier(&oracle_scratch_prefix_from_env(&env), "NP");
        let base_table = oracle_scratch_identifier(&oracle_scratch_prefix_from_env(&env), "BT");
        let view_name = oracle_scratch_identifier(&oracle_scratch_prefix_from_env(&env), "VW");
        let qualified_no_pk_table = oracle_qualified_name(&schema, &no_pk_table);
        let qualified_base_table = oracle_qualified_name(&schema, &base_table);
        let qualified_view = oracle_qualified_name(&schema, &view_name);

        if let Err(error) = setup_oracle_readonly_scratch_objects(
            &driver,
            &qualified_no_pk_table,
            &qualified_base_table,
            &qualified_view,
        )
        .await
        {
            let cleanup_result = drop_oracle_readonly_scratch_objects(
                &driver,
                &qualified_view,
                &qualified_base_table,
                &qualified_no_pk_table,
            )
            .await;
            let close_result = driver.close().await;
            panic!(
                "Oracle readonly smoke should create scratch objects: {error:?}; cleanup_result={cleanup_result:?}; close_result={close_result:?}"
            );
        }

        let no_pk_container = ContainerRef::table(
            ContainerKind::Table,
            database.clone(),
            Some(schema.clone()),
            no_pk_table,
        );
        let view_container =
            ContainerRef::table(ContainerKind::View, database, Some(schema), view_name);
        let browser = driver
            .as_data_table_browser()
            .expect("Oracle table browser");
        let operation_result: Result<(), String> = async {
            let no_pk = browser
                .browse_table_data(&no_pk_container, 0, 10, &TableBrowseQuery::default())
                .await
                .map_err(|error| format!("Oracle no-PK table should browse: {error:?}"))?;
            assert_oracle_readonly_result(&no_pk, "Oracle no-PK table")?;

            let no_pk_preview = browser
                .preview_table_change_set(
                    &no_pk_container,
                    &TableChangeSetRequest {
                        inserts: vec![TableChangeSetInsert {
                            values: vec![TableCellChange {
                                column: "NAME".to_string(),
                                value: serde_json::json!("new value"),
                            }],
                        }],
                        updates: Vec::new(),
                        deletes: Vec::new(),
                    },
                )
                .await;
            let error = match no_pk_preview {
                Ok(_) => {
                    return Err("Oracle no-PK table preview should reject mutation".to_string());
                }
                Err(error) => error,
            };
            if !error.message.contains("没有主键") {
                return Err(format!(
                    "Oracle no-PK preview should mention missing primary key: {}",
                    error.message
                ));
            }

            let view = browser
                .browse_table_data(&view_container, 0, 10, &TableBrowseQuery::default())
                .await
                .map_err(|error| format!("Oracle view should browse read-only: {error:?}"))?;
            assert_oracle_readonly_result(&view, "Oracle view")?;

            let view_preview = browser
                .preview_table_change_set(
                    &view_container,
                    &TableChangeSetRequest {
                        inserts: Vec::new(),
                        updates: vec![TableChangeSetUpdate {
                            locator: primary_key_locator(vec![TableRowKeyPart {
                                column: "ID".to_string(),
                                value: serde_json::json!(1),
                            }]),
                            changes: vec![TableCellChange {
                                column: "NAME".to_string(),
                                value: serde_json::json!("blocked"),
                            }],
                        }],
                        deletes: Vec::new(),
                    },
                )
                .await;
            let error = match view_preview {
                Ok(_) => return Err("Oracle view preview should reject mutation".to_string()),
                Err(error) => error,
            };
            if !error.message.contains("真实表") {
                return Err(format!(
                    "Oracle view preview should mention real table requirement: {}",
                    error.message
                ));
            }

            Ok(())
        }
        .await;

        let cleanup_result = drop_oracle_readonly_scratch_objects(
            &driver,
            &qualified_view,
            &qualified_base_table,
            &qualified_no_pk_table,
        )
        .await;
        let close_result = driver.close().await;
        if let Err(error) = operation_result {
            panic!("{error}; cleanup_result={cleanup_result:?}; close_result={close_result:?}");
        }
        cleanup_result.expect("Oracle readonly smoke should drop scratch objects");
        close_result.expect("close Oracle readonly smoke driver");
    });
}

#[test]
fn real_oracle_composite_primary_key_scratch_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !oracle_write_tests_enabled(&env) {
            return;
        }

        let schema = oracle_schema_from_env(&env);
        let database = oracle_database_from_env(&env);
        let driver =
            connect_oracle_driver_from_env(&env, "real-oracle-composite-smoke".to_string()).await;
        let table = oracle_scratch_identifier(&oracle_scratch_prefix_from_env(&env), "CP");
        let qualified_table = oracle_qualified_name(&schema, &table);

        if let Err(error) = setup_oracle_composite_scratch_table(&driver, &qualified_table).await {
            let cleanup_result = drop_oracle_scratch_table(&driver, &qualified_table).await;
            let close_result = driver.close().await;
            panic!(
                "Oracle composite smoke should create scratch table: {error:?}; cleanup_result={cleanup_result:?}; close_result={close_result:?}"
            );
        }

        let container = ContainerRef::table(ContainerKind::Table, database, Some(schema), table);
        let browser = driver
            .as_data_table_browser()
            .expect("Oracle table browser");
        let operation_result: Result<(), String> = async {
            let change_set = TableChangeSetRequest {
                inserts: Vec::new(),
                updates: vec![TableChangeSetUpdate {
                    locator: primary_key_locator(vec![
                        TableRowKeyPart {
                            column: "PART_A".to_string(),
                            value: serde_json::json!(1),
                        },
                        TableRowKeyPart {
                            column: "PART_B".to_string(),
                            value: serde_json::json!(2),
                        },
                    ]),
                    changes: vec![TableCellChange {
                        column: "NAME".to_string(),
                        value: serde_json::json!("two-updated"),
                    }],
                }],
                deletes: vec![primary_key_locator(vec![
                    TableRowKeyPart {
                        column: "PART_A".to_string(),
                        value: serde_json::json!(1),
                    },
                    TableRowKeyPart {
                        column: "PART_B".to_string(),
                        value: serde_json::json!(1),
                    },
                ])],
            };

            let preview = browser
                .preview_table_change_set(&container, &change_set)
                .await
                .map_err(|error| {
                    format!("Oracle composite smoke should preview changes: {error:?}")
                })?;
            if preview.summary.updates != 1 || preview.summary.deletes != 1 {
                return Err(format!(
                    "Oracle composite preview summary mismatch: updates={} deletes={}",
                    preview.summary.updates, preview.summary.deletes
                ));
            }

            let commit = browser
                .commit_table_change_set(&container, &change_set)
                .await
                .map_err(|error| {
                    format!("Oracle composite smoke should commit changes: {error:?}")
                })?;
            if commit.affected_rows != 2 {
                return Err(format!(
                    "Oracle composite affected row mismatch: expected 2, got {}",
                    commit.affected_rows
                ));
            }

            let browse = browser
                .browse_table_data(&container, 0, 10, &TableBrowseQuery::default())
                .await
                .map_err(|error| {
                    format!("Oracle composite smoke should browse after commit: {error:?}")
                })?;
            if browse.rows.len() != 1 {
                return Err(format!(
                    "Oracle composite row count mismatch: expected 1, got {}",
                    browse.rows.len()
                ));
            }
            assert_oracle_row_name(&browse, "1|2", "two-updated")?;

            Ok(())
        }
        .await;

        let cleanup_result = drop_oracle_scratch_table(&driver, &qualified_table).await;
        let close_result = driver.close().await;
        if let Err(error) = operation_result {
            panic!("{error}; cleanup_result={cleanup_result:?}; close_result={close_result:?}");
        }
        cleanup_result.expect("Oracle composite smoke should drop scratch table");
        close_result.expect("close Oracle composite smoke driver");
    });
}

#[test]
fn real_oracle_describe_table_design_scratch_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !oracle_write_tests_enabled(&env) {
            return;
        }

        let schema = oracle_schema_from_env(&env);
        let database = oracle_database_from_env(&env);
        let driver =
            connect_oracle_driver_from_env(&env, "real-oracle-describe-phase3".to_string()).await;
        let parent = oracle_scratch_identifier(&oracle_scratch_prefix_from_env(&env), "P3P");
        let child = oracle_scratch_identifier(&oracle_scratch_prefix_from_env(&env), "P3C");
        let qualified_parent = oracle_qualified_name(&schema, &parent);
        let qualified_child = oracle_qualified_name(&schema, &child);

        if let Err(error) =
            setup_oracle_phase3_describe_fixture(&driver, &qualified_parent, &qualified_child).await
        {
            let cleanup_result =
                drop_oracle_phase3_describe_fixture(&driver, &qualified_child, &qualified_parent)
                    .await;
            let close_result = driver.close().await;
            panic!(
                "Oracle describe phase3 should create scratch fixture: {error:?}; cleanup_result={cleanup_result:?}; close_result={close_result:?}"
            );
        }

        let container =
            ContainerRef::table(ContainerKind::Table, database, Some(schema), child.clone());
        let operation_result: Result<(), String> = async {
            let table_schema = driver
                .as_schema_browser()
                .expect("Oracle schema browser")
                .describe_table(&container)
                .await
                .map_err(|error| format!("Oracle phase3 describe should succeed: {error:?}"))?;

            if table_schema.basics.table_name != child {
                return Err(format!(
                    "Oracle describe table name mismatch: expected {child}, got {}",
                    table_schema.basics.table_name
                ));
            }
            if table_schema.basics.comment.as_deref() != Some("Phase 3 child table") {
                return Err(format!(
                    "Oracle describe table comment mismatch: {:?}",
                    table_schema.basics.comment
                ));
            }

            let id = table_schema
                .columns
                .iter()
                .find(|column| column.name == "ID")
                .ok_or_else(|| "Oracle describe should expose ID column".to_string())?;
            if !id.is_primary_key || !id.is_identity {
                return Err(format!(
                    "Oracle ID column should be primary identity: primary={} identity={}",
                    id.is_primary_key, id.is_identity
                ));
            }

            let name = table_schema
                .columns
                .iter()
                .find(|column| column.name == "NAME")
                .ok_or_else(|| "Oracle describe should expose NAME column".to_string())?;
            if name.nullable || name.default_value.as_deref() != Some("'unknown'") {
                return Err(format!(
                    "Oracle NAME default/nullability mismatch: nullable={} default={:?}",
                    name.nullable, name.default_value
                ));
            }
            if name.comment.as_deref() != Some("Display name") {
                return Err(format!("Oracle NAME comment mismatch: {:?}", name.comment));
            }

            let generated = table_schema
                .columns
                .iter()
                .find(|column| column.name == "NAME_UPPER")
                .and_then(|column| column.generated.as_ref())
                .ok_or_else(|| {
                    "Oracle describe should expose NAME_UPPER as generated virtual".to_string()
                })?;
            if !generated.expression.to_ascii_uppercase().contains("UPPER") {
                return Err(format!(
                    "Oracle generated expression should contain UPPER: {}",
                    generated.expression
                ));
            }

            if !table_schema
                .indexes
                .iter()
                .any(|index| index.columns == vec!["PARENT_ID".to_string()])
            {
                return Err(format!(
                    "Oracle describe should expose normal PARENT_ID index: {:?}",
                    table_schema.indexes
                ));
            }
            if !table_schema
                .constraints
                .iter()
                .any(|constraint| constraint.kind == TableConstraintKind::Check)
            {
                return Err("Oracle describe should expose CHECK constraint".to_string());
            }
            if !table_schema
                .constraints
                .iter()
                .any(|constraint| constraint.kind == TableConstraintKind::ForeignKey)
            {
                return Err("Oracle describe should expose FK constraint".to_string());
            }

            Ok(())
        }
        .await;

        let cleanup_result =
            drop_oracle_phase3_describe_fixture(&driver, &qualified_child, &qualified_parent).await;
        let close_result = driver.close().await;
        if let Err(error) = operation_result {
            panic!("{error}; cleanup_result={cleanup_result:?}; close_result={close_result:?}");
        }
        cleanup_result.expect("Oracle describe phase3 should drop scratch fixture");
        close_result.expect("close Oracle describe phase3 driver");
    });
}

#[test]
fn real_oracle_create_table_design_scratch_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !oracle_write_tests_enabled(&env) {
            return;
        }

        let schema = oracle_schema_from_env(&env);
        let database = oracle_database_from_env(&env);
        let driver =
            connect_oracle_driver_from_env(&env, "real-oracle-create-phase3".to_string()).await;
        let parent = oracle_scratch_identifier(&oracle_scratch_prefix_from_env(&env), "C3P");
        let child = oracle_scratch_identifier(&oracle_scratch_prefix_from_env(&env), "C3C");
        let qualified_parent = oracle_qualified_name(&schema, &parent);
        let qualified_child = oracle_qualified_name(&schema, &child);

        if let Err(error) = setup_oracle_phase3_parent_table(&driver, &qualified_parent).await {
            let cleanup_result =
                drop_oracle_phase3_describe_fixture(&driver, &qualified_child, &qualified_parent)
                    .await;
            let close_result = driver.close().await;
            panic!(
                "Oracle create phase3 should create parent table: {error:?}; cleanup_result={cleanup_result:?}; close_result={close_result:?}"
            );
        }

        let create_input = oracle_phase3_create_input(&database, &schema, &child, &parent);
        let operation_result: Result<(), String> = async {
            let mutator = driver.as_schema_mutator().expect("Oracle schema mutator");
            let preview = mutator
                .preview_create_table(&create_input)
                .await
                .map_err(|error| format!("Oracle phase3 create should preview table: {error:?}"))?;
            if !preview
                .statements
                .iter()
                .any(|statement| statement.starts_with("CREATE TABLE "))
            {
                return Err(format!(
                    "Oracle create preview should include CREATE TABLE: {:?}",
                    preview.statements
                ));
            }

            let result = mutator
                .create_table(&create_input)
                .await
                .map_err(|error| format!("Oracle phase3 create should execute: {error:?}"))?;
            if result.table_name != child {
                return Err(format!(
                    "Oracle create result table mismatch: expected {child}, got {}",
                    result.table_name
                ));
            }

            let table_schema = driver
                .as_schema_browser()
                .expect("Oracle schema browser")
                .describe_table(&result.container)
                .await
                .map_err(|error| {
                    format!("Oracle phase3 create should describe created table: {error:?}")
                })?;
            if table_schema.basics.comment.as_deref() != Some("Phase 3 created table") {
                return Err(format!(
                    "Oracle created table comment mismatch: {:?}",
                    table_schema.basics.comment
                ));
            }
            if !table_schema
                .columns
                .iter()
                .any(|column| column.name == "ID" && column.is_primary_key && column.is_identity)
            {
                return Err(format!(
                    "Oracle created table should expose identity PK: {:?}",
                    table_schema.columns
                ));
            }
            if !table_schema
                .constraints
                .iter()
                .any(|constraint| constraint.kind == TableConstraintKind::Check)
            {
                return Err("Oracle created table should expose CHECK constraint".to_string());
            }
            if !table_schema
                .constraints
                .iter()
                .any(|constraint| constraint.kind == TableConstraintKind::ForeignKey)
            {
                return Err("Oracle created table should expose FK constraint".to_string());
            }
            if !table_schema
                .indexes
                .iter()
                .any(|index| index.name.starts_with("IX_"))
            {
                return Err(format!(
                    "Oracle created table should expose normal index: {:?}",
                    table_schema.indexes
                ));
            }

            Ok(())
        }
        .await;

        let cleanup_result =
            drop_oracle_phase3_describe_fixture(&driver, &qualified_child, &qualified_parent).await;
        let close_result = driver.close().await;
        if let Err(error) = operation_result {
            panic!("{error}; cleanup_result={cleanup_result:?}; close_result={close_result:?}");
        }
        cleanup_result.expect("Oracle create phase3 should drop scratch objects");
        close_result.expect("close Oracle create phase3 driver");
    });
}

#[test]
fn real_oracle_update_table_design_safe_scratch_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !oracle_write_tests_enabled(&env) {
            return;
        }

        let schema = oracle_schema_from_env(&env);
        let database = oracle_database_from_env(&env);
        let driver =
            connect_oracle_driver_from_env(&env, "real-oracle-safe-alter-phase3".to_string()).await;
        let parent = oracle_scratch_identifier(&oracle_scratch_prefix_from_env(&env), "S3P");
        let child = oracle_scratch_identifier(&oracle_scratch_prefix_from_env(&env), "S3C");
        let qualified_parent = oracle_qualified_name(&schema, &parent);
        let qualified_child = oracle_qualified_name(&schema, &child);

        if let Err(error) = setup_oracle_phase3_parent_table(&driver, &qualified_parent).await {
            let cleanup_result =
                drop_oracle_phase3_describe_fixture(&driver, &qualified_child, &qualified_parent)
                    .await;
            let close_result = driver.close().await;
            panic!(
                "Oracle safe alter phase3 should create parent table: {error:?}; cleanup_result={cleanup_result:?}; close_result={close_result:?}"
            );
        }

        let create_input = oracle_phase3_create_input(&database, &schema, &child, &parent);
        let operation_result: Result<(), String> = async {
            let mutator = driver.as_schema_mutator().expect("Oracle schema mutator");
            let create_result = mutator
                .create_table(&create_input)
                .await
                .map_err(|error| format!("Oracle safe alter should create table: {error:?}"))?;
            let baseline = driver
                .as_schema_browser()
                .expect("Oracle schema browser")
                .describe_table(&create_result.container)
                .await
                .map_err(|error| {
                    format!("Oracle safe alter should describe baseline: {error:?}")
                })?;
            let mut target = baseline.clone();
            target.basics.comment = Some("Phase 3 safe updated table".to_string());
            target.columns.push(TableColumnSchema {
                name: "EMAIL".to_string(),
                type_name: "VARCHAR2(120)".to_string(),
                nullable: true,
                default_value: None,
                is_primary_key: false,
                is_unique: false,
                is_identity: false,
                comment: Some("Email address".to_string()),
                identity: None,
                generated: None,
                charset: None,
                collation: None,
            });
            for column in &mut target.columns {
                if column.name == "NAME" {
                    column.name = "DISPLAY_NAME".to_string();
                }
                if column.name == "AMOUNT" {
                    column.default_value = Some("0".to_string());
                    column.nullable = false;
                }
            }
            target.indexes.clear();
            target.indexes.push(TableIndexSchema {
                name: format!(
                    "IE_{}",
                    oracle_constraint_suffix(&qualified_child)
                        .chars()
                        .take(27)
                        .collect::<String>()
                ),
                columns: vec!["EMAIL".to_string()],
                is_unique: false,
                method: None,
                comment: None,
            });

            let update_input = UpdateTableInput {
                container: create_result.container.clone(),
                baseline,
                target,
                column_renames: vec![TableColumnRename {
                    old_name: "NAME".to_string(),
                    new_name: "DISPLAY_NAME".to_string(),
                }],
                confirm_destructive: false,
            };
            let preview = mutator
                .preview_update_table(&update_input)
                .await
                .map_err(|error| format!("Oracle safe alter should preview: {error:?}"))?;
            if preview.destructive {
                return Err(format!(
                    "Oracle safe alter preview should not be destructive: {:?}",
                    preview
                ));
            }
            let update_result = mutator
                .update_table(&update_input)
                .await
                .map_err(|error| format!("Oracle safe alter should execute: {error:?}"))?;
            let after = driver
                .as_schema_browser()
                .expect("Oracle schema browser")
                .describe_table(&update_result.container)
                .await
                .map_err(|error| format!("Oracle safe alter should describe after: {error:?}"))?;

            if after.basics.comment.as_deref() != Some("Phase 3 safe updated table") {
                return Err(format!(
                    "Oracle safe alter table comment mismatch: {:?}",
                    after.basics.comment
                ));
            }
            if !after.columns.iter().any(|column| column.name == "EMAIL") {
                return Err(format!(
                    "Oracle safe alter should add EMAIL: {:?}",
                    after.columns
                ));
            }
            if !after
                .columns
                .iter()
                .any(|column| column.name == "DISPLAY_NAME")
            {
                return Err(format!(
                    "Oracle safe alter should rename NAME to DISPLAY_NAME: {:?}",
                    after.columns
                ));
            }
            let amount = after
                .columns
                .iter()
                .find(|column| column.name == "AMOUNT")
                .ok_or_else(|| "Oracle safe alter should keep AMOUNT".to_string())?;
            if amount.nullable || amount.default_value.as_deref() != Some("0") {
                return Err(format!(
                    "Oracle safe alter AMOUNT mismatch: nullable={} default={:?}",
                    amount.nullable, amount.default_value
                ));
            }
            if !after
                .indexes
                .iter()
                .any(|index| index.columns == vec!["EMAIL".to_string()])
            {
                return Err(format!(
                    "Oracle safe alter should create EMAIL index: {:?}",
                    after.indexes
                ));
            }

            Ok(())
        }
        .await;

        let cleanup_result =
            drop_oracle_phase3_describe_fixture(&driver, &qualified_child, &qualified_parent).await;
        let close_result = driver.close().await;
        if let Err(error) = operation_result {
            panic!("{error}; cleanup_result={cleanup_result:?}; close_result={close_result:?}");
        }
        cleanup_result.expect("Oracle safe alter phase3 should drop scratch objects");
        close_result.expect("close Oracle safe alter phase3 driver");
    });
}

#[test]
fn real_oracle_update_table_design_frontend_roundtrip_add_column_scratch_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !oracle_write_tests_enabled(&env) {
            return;
        }

        let schema = oracle_schema_from_env(&env);
        let database = oracle_database_from_env(&env);
        let driver = connect_oracle_driver_from_env(
            &env,
            "real-oracle-frontend-roundtrip-phase3".to_string(),
        )
        .await;
        let parent = oracle_scratch_identifier(&oracle_scratch_prefix_from_env(&env), "R3P");
        let child = oracle_scratch_identifier(&oracle_scratch_prefix_from_env(&env), "R3C");
        let qualified_parent = oracle_qualified_name(&schema, &parent);
        let qualified_child = oracle_qualified_name(&schema, &child);

        if let Err(error) = setup_oracle_phase3_parent_table(&driver, &qualified_parent).await {
            let cleanup_result =
                drop_oracle_phase3_describe_fixture(&driver, &qualified_child, &qualified_parent)
                    .await;
            let close_result = driver.close().await;
            panic!(
                "Oracle frontend roundtrip phase3 should create parent table: {error:?}; cleanup_result={cleanup_result:?}; close_result={close_result:?}"
            );
        }

        let create_input = oracle_phase3_create_input(&database, &schema, &child, &parent);
        let operation_result: Result<(), String> = async {
            let mutator = driver.as_schema_mutator().expect("Oracle schema mutator");
            let create_result = mutator.create_table(&create_input).await.map_err(|error| {
                format!("Oracle frontend roundtrip should create table: {error:?}")
            })?;
            let described = driver
                .as_schema_browser()
                .expect("Oracle schema browser")
                .describe_table(&create_result.container)
                .await
                .map_err(|error| {
                    format!("Oracle frontend roundtrip should describe baseline: {error:?}")
                })?;
            let baseline = oracle_frontend_roundtrip_table_schema(&described);
            let mut target = baseline.clone();
            target.columns.push(TableColumnSchema {
                name: "NOTES".to_string(),
                type_name: "VARCHAR2(120)".to_string(),
                nullable: true,
                default_value: None,
                is_primary_key: false,
                is_unique: false,
                is_identity: false,
                comment: None,
                identity: None,
                generated: None,
                charset: None,
                collation: None,
            });

            let update_input = UpdateTableInput {
                container: create_result.container.clone(),
                baseline,
                target,
                column_renames: Vec::new(),
                confirm_destructive: false,
            };

            mutator.update_table(&update_input).await.map_err(|error| {
                format!("Oracle frontend roundtrip add column should execute: {error:?}")
            })?;

            let after = driver
                .as_schema_browser()
                .expect("Oracle schema browser")
                .describe_table(&create_result.container)
                .await
                .map_err(|error| {
                    format!("Oracle frontend roundtrip should describe after update: {error:?}")
                })?;
            if !after.columns.iter().any(|column| column.name == "NOTES") {
                return Err(format!(
                    "Oracle frontend roundtrip should add NOTES: {:?}",
                    after.columns
                ));
            }

            Ok(())
        }
        .await;

        let cleanup_result =
            drop_oracle_phase3_describe_fixture(&driver, &qualified_child, &qualified_parent).await;
        let close_result = driver.close().await;
        if let Err(error) = operation_result {
            panic!("{error}; cleanup_result={cleanup_result:?}; close_result={close_result:?}");
        }
        cleanup_result.expect("Oracle frontend roundtrip phase3 should drop scratch objects");
        close_result.expect("close Oracle frontend roundtrip phase3 driver");
    });
}

#[test]
fn real_oracle_update_table_design_destructive_scratch_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !oracle_write_tests_enabled(&env) {
            return;
        }

        let schema = oracle_schema_from_env(&env);
        let database = oracle_database_from_env(&env);
        let driver =
            connect_oracle_driver_from_env(&env, "real-oracle-destructive-phase3".to_string())
                .await;
        let parent = oracle_scratch_identifier(&oracle_scratch_prefix_from_env(&env), "D3P");
        let child = oracle_scratch_identifier(&oracle_scratch_prefix_from_env(&env), "D3C");
        let qualified_parent = oracle_qualified_name(&schema, &parent);
        let qualified_child = oracle_qualified_name(&schema, &child);

        if let Err(error) = setup_oracle_phase3_parent_table(&driver, &qualified_parent).await {
            let cleanup_result =
                drop_oracle_phase3_describe_fixture(&driver, &qualified_child, &qualified_parent)
                    .await;
            let close_result = driver.close().await;
            panic!(
                "Oracle destructive phase3 should create parent table: {error:?}; cleanup_result={cleanup_result:?}; close_result={close_result:?}"
            );
        }

        let create_input = oracle_phase3_create_input(&database, &schema, &child, &parent);
        let operation_result: Result<(), String> = async {
            let mutator = driver
                .as_schema_mutator()
                .expect("Oracle schema mutator");
            let create_result = mutator.create_table(&create_input).await.map_err(|error| {
                format!("Oracle destructive alter should create table: {error:?}")
            })?;
            let baseline = driver
                .as_schema_browser()
                .expect("Oracle schema browser")
                .describe_table(&create_result.container)
                .await
                .map_err(|error| {
                    format!("Oracle destructive alter should describe baseline: {error:?}")
                })?;
            let mut target = baseline.clone();
            target.columns.retain(|column| column.name != "NAME");
            for column in &mut target.columns {
                if column.name == "AMOUNT" {
                    column.type_name = "NUMBER(14,2)".to_string();
                }
                if column.name == "PARENT_ID" {
                    column.is_primary_key = true;
                }
            }
            for constraint in &mut target.constraints {
                match constraint.kind {
                    TableConstraintKind::PrimaryKey => {
                        constraint.columns = vec!["ID".to_string(), "PARENT_ID".to_string()];
                    }
                    TableConstraintKind::Check => {
                        constraint.expression = Some(
                            "\"AMOUNT\" IS NULL OR \"AMOUNT\" BETWEEN 0 AND 999999".to_string(),
                        );
                    }
                    TableConstraintKind::ForeignKey => {
                        if let Some(foreign_key) = constraint.foreign_key.as_mut() {
                            foreign_key.on_delete = None;
                        }
                    }
                    TableConstraintKind::Unique => {}
                }
            }

            let update_input = UpdateTableInput {
                container: create_result.container.clone(),
                baseline: baseline.clone(),
                target: target.clone(),
                column_renames: Vec::new(),
                confirm_destructive: false,
            };
            let preview = mutator
                .preview_update_table(&update_input)
                .await
                .map_err(|error| {
                    format!("Oracle destructive alter should preview: {error:?}")
                })?;
            if !preview.destructive {
                return Err(format!(
                    "Oracle destructive alter preview should be destructive: {:?}",
                    preview
                ));
            }
            let rejection = mutator.update_table(&update_input).await;
            match rejection {
                Ok(_) => {
                    return Err(
                        "Oracle destructive alter should reject execution without confirmation"
                            .to_string(),
                    );
                }
                Err(error) if error.message.contains("破坏性") => {}
                Err(error) => {
                    return Err(format!(
                        "Oracle destructive rejection should mention destructive confirmation: {error:?}"
                    ));
                }
            }

            let mut confirmed = update_input;
            confirmed.confirm_destructive = true;
            let update_result = mutator
                .update_table(&confirmed)
                .await
                .map_err(|error| {
                    format!("Oracle destructive alter should execute after confirm: {error:?}")
                })?;
            let after = driver
                .as_schema_browser()
                .expect("Oracle schema browser")
                .describe_table(&update_result.container)
                .await
                .map_err(|error| {
                    format!("Oracle destructive alter should describe after: {error:?}")
                })?;

            if after.columns.iter().any(|column| column.name == "NAME") {
                return Err(format!(
                    "Oracle destructive alter should drop NAME: {:?}",
                    after.columns
                ));
            }
            if !after
                .columns
                .iter()
                .any(|column| column.name == "AMOUNT" && column.type_name == "NUMBER(14,2)")
            {
                return Err(format!(
                    "Oracle destructive alter should change AMOUNT type: {:?}",
                    after.columns
                ));
            }
            if !after.constraints.iter().any(|constraint| {
                constraint.kind == TableConstraintKind::PrimaryKey
                    && constraint.columns == vec!["ID".to_string(), "PARENT_ID".to_string()]
            }) {
                return Err(format!(
                    "Oracle destructive alter should create composite PK: {:?}",
                    after.constraints
                ));
            }
            if !after.constraints.iter().any(|constraint| {
                constraint.kind == TableConstraintKind::ForeignKey
                    && constraint
                        .foreign_key
                        .as_ref()
                        .and_then(|foreign_key| foreign_key.on_delete.as_ref())
                        .is_none()
            }) {
                return Err(format!(
                    "Oracle destructive alter should update FK delete action: {:?}",
                    after.constraints
                ));
            }

            Ok(())
        }
        .await;

        let cleanup_result =
            drop_oracle_phase3_describe_fixture(&driver, &qualified_child, &qualified_parent).await;
        let close_result = driver.close().await;
        if let Err(error) = operation_result {
            panic!("{error}; cleanup_result={cleanup_result:?}; close_result={close_result:?}");
        }
        cleanup_result.expect("Oracle destructive phase3 should drop scratch objects");
        close_result.expect("close Oracle destructive phase3 driver");
    });
}

#[test]
fn real_oracle_update_table_design_drift_conflict_scratch_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !oracle_write_tests_enabled(&env) {
            return;
        }

        let schema = oracle_schema_from_env(&env);
        let database = oracle_database_from_env(&env);
        let driver =
            connect_oracle_driver_from_env(&env, "real-oracle-drift-phase3".to_string()).await;
        let parent = oracle_scratch_identifier(&oracle_scratch_prefix_from_env(&env), "F3P");
        let child = oracle_scratch_identifier(&oracle_scratch_prefix_from_env(&env), "F3C");
        let qualified_parent = oracle_qualified_name(&schema, &parent);
        let qualified_child = oracle_qualified_name(&schema, &child);

        if let Err(error) = setup_oracle_phase3_parent_table(&driver, &qualified_parent).await {
            let cleanup_result =
                drop_oracle_phase3_describe_fixture(&driver, &qualified_child, &qualified_parent)
                    .await;
            let close_result = driver.close().await;
            panic!(
                "Oracle drift phase3 should create parent table: {error:?}; cleanup_result={cleanup_result:?}; close_result={close_result:?}"
            );
        }

        let create_input = oracle_phase3_create_input(&database, &schema, &child, &parent);
        let operation_result: Result<(), String> = async {
            let mutator = driver.as_schema_mutator().expect("Oracle schema mutator");
            let create_result = mutator
                .create_table(&create_input)
                .await
                .map_err(|error| format!("Oracle drift should create table: {error:?}"))?;
            let baseline = driver
                .as_schema_browser()
                .expect("Oracle schema browser")
                .describe_table(&create_result.container)
                .await
                .map_err(|error| format!("Oracle drift should describe baseline: {error:?}"))?;

            let connection = driver.connection().await.map_err(|error| {
                format!("Oracle drift should acquire direct connection: {error:?}")
            })?;
            connection
                .execute(
                    &format!("ALTER TABLE {qualified_child} ADD (\"REMOTE_ONLY\" NUMBER(10,0))"),
                    &[],
                )
                .await
                .map_err(|error| {
                    format!("Oracle drift should mutate remote table directly: {error}")
                })?;
            connection.commit().await.map_err(|error| {
                format!("Oracle drift should commit direct remote mutation: {error}")
            })?;

            let mut target = baseline.clone();
            target.basics.comment = Some("stale update".to_string());
            let input = UpdateTableInput {
                container: create_result.container,
                baseline,
                target,
                column_renames: Vec::new(),
                confirm_destructive: false,
            };

            let result = mutator.update_table(&input).await;
            match result {
                Ok(_) => Err("Oracle stale update should be rejected".to_string()),
                Err(error) if format!("{:?}", error.code) == "ResourceConflict" => Ok(()),
                Err(error) => Err(format!(
                    "Oracle stale update should return ResourceConflict, got {error:?}"
                )),
            }
        }
        .await;

        let cleanup_result =
            drop_oracle_phase3_describe_fixture(&driver, &qualified_child, &qualified_parent).await;
        let close_result = driver.close().await;
        if let Err(error) = operation_result {
            panic!("{error}; cleanup_result={cleanup_result:?}; close_result={close_result:?}");
        }
        cleanup_result.expect("Oracle drift phase3 should drop scratch objects");
        close_result.expect("close Oracle drift phase3 driver");
    });
}

async fn setup_oracle_scratch_table(driver: &OracleDriver, qualified_table: &str) -> IpcResult<()> {
    let connection = driver.connection().await?;
    connection
        .execute(
            &format!(
                "CREATE TABLE {qualified_table} (\"ID\" NUMBER(10,0) PRIMARY KEY, \"NAME\" VARCHAR2(50), \"CREATED_AT\" TIMESTAMP(6))"
            ),
            &[],
        )
        .await
        .map_err(|error| oracle_setup_error("Oracle write smoke failed to create scratch table", error))?;
    connection
        .execute(
            &format!(
                "INSERT INTO {qualified_table} (\"ID\", \"NAME\", \"CREATED_AT\") VALUES (1, 'before', TIMESTAMP '2026-01-01 00:00:00')"
            ),
            &[],
        )
        .await
        .map_err(|error| {
            oracle_setup_error("Oracle write smoke failed to seed scratch table", error)
        })?;
    connection.commit().await.map_err(|error| {
        oracle_setup_error("Oracle write smoke failed to commit scratch seed", error)
    })?;
    Ok(())
}

async fn drop_oracle_scratch_table(driver: &OracleDriver, qualified_table: &str) -> IpcResult<()> {
    let connection = driver.connection().await?;
    connection
        .execute(&format!("DROP TABLE {qualified_table} PURGE"), &[])
        .await
        .map_err(|error| {
            oracle_setup_error("Oracle write smoke failed to drop scratch table", error)
        })?;
    Ok(())
}

async fn setup_oracle_readonly_scratch_objects(
    driver: &OracleDriver,
    qualified_no_pk_table: &str,
    qualified_base_table: &str,
    qualified_view: &str,
) -> IpcResult<()> {
    let connection = driver.connection().await?;
    connection
        .execute(
            &format!("CREATE TABLE {qualified_no_pk_table} (\"NAME\" VARCHAR2(50))"),
            &[],
        )
        .await
        .map_err(|error| {
            oracle_setup_error("Oracle readonly smoke failed to create no-PK table", error)
        })?;
    connection
        .execute(
            &format!("INSERT INTO {qualified_no_pk_table} (\"NAME\") VALUES ('readonly')"),
            &[],
        )
        .await
        .map_err(|error| {
            oracle_setup_error("Oracle readonly smoke failed to seed no-PK table", error)
        })?;
    connection
        .execute(
            &format!(
                "CREATE TABLE {qualified_base_table} (\"ID\" NUMBER(10,0) PRIMARY KEY, \"NAME\" VARCHAR2(50))"
            ),
            &[],
        )
        .await
        .map_err(|error| {
            oracle_setup_error("Oracle readonly smoke failed to create base table", error)
        })?;
    connection
        .execute(
            &format!("INSERT INTO {qualified_base_table} (\"ID\", \"NAME\") VALUES (1, 'base')"),
            &[],
        )
        .await
        .map_err(|error| {
            oracle_setup_error("Oracle readonly smoke failed to seed base table", error)
        })?;
    connection
        .execute(
            &format!(
                "CREATE VIEW {qualified_view} AS SELECT \"ID\", \"NAME\" FROM {qualified_base_table}"
            ),
            &[],
        )
        .await
        .map_err(|error| {
            oracle_setup_error("Oracle readonly smoke failed to create view", error)
        })?;
    connection.commit().await.map_err(|error| {
        oracle_setup_error("Oracle readonly smoke failed to commit scratch seed", error)
    })?;
    Ok(())
}

async fn drop_oracle_readonly_scratch_objects(
    driver: &OracleDriver,
    qualified_view: &str,
    qualified_base_table: &str,
    qualified_no_pk_table: &str,
) -> IpcResult<()> {
    let view_result = drop_oracle_view(driver, qualified_view).await;
    let base_result = drop_oracle_scratch_table(driver, qualified_base_table).await;
    let no_pk_result = drop_oracle_scratch_table(driver, qualified_no_pk_table).await;

    view_result?;
    base_result?;
    no_pk_result?;
    Ok(())
}

async fn drop_oracle_view(driver: &OracleDriver, qualified_view: &str) -> IpcResult<()> {
    let connection = driver.connection().await?;
    connection
        .execute(&format!("DROP VIEW {qualified_view}"), &[])
        .await
        .map_err(|error| oracle_setup_error("Oracle readonly smoke failed to drop view", error))?;
    Ok(())
}

async fn setup_oracle_composite_scratch_table(
    driver: &OracleDriver,
    qualified_table: &str,
) -> IpcResult<()> {
    let connection = driver.connection().await?;
    connection
        .execute(
            &format!(
                "CREATE TABLE {qualified_table} (\"PART_A\" NUMBER(10,0), \"PART_B\" NUMBER(10,0), \"NAME\" VARCHAR2(50), CONSTRAINT \"PK_{constraint_suffix}\" PRIMARY KEY (\"PART_A\", \"PART_B\"))",
                constraint_suffix = oracle_constraint_suffix(qualified_table)
            ),
            &[],
        )
        .await
        .map_err(|error| {
            oracle_setup_error("Oracle composite smoke failed to create scratch table", error)
        })?;
    connection
        .execute(
            &format!(
                "INSERT INTO {qualified_table} (\"PART_A\", \"PART_B\", \"NAME\") VALUES (1, 1, 'one')"
            ),
            &[],
        )
        .await
        .map_err(|error| {
            oracle_setup_error("Oracle composite smoke failed to seed first row", error)
        })?;
    connection
        .execute(
            &format!(
                "INSERT INTO {qualified_table} (\"PART_A\", \"PART_B\", \"NAME\") VALUES (1, 2, 'two')"
            ),
            &[],
        )
        .await
        .map_err(|error| {
            oracle_setup_error("Oracle composite smoke failed to seed second row", error)
        })?;
    connection.commit().await.map_err(|error| {
        oracle_setup_error(
            "Oracle composite smoke failed to commit scratch seed",
            error,
        )
    })?;
    Ok(())
}

async fn setup_oracle_phase3_describe_fixture(
    driver: &OracleDriver,
    qualified_parent: &str,
    qualified_child: &str,
) -> IpcResult<()> {
    let connection = driver.connection().await?;
    let suffix = oracle_constraint_suffix(qualified_child);
    let parent_suffix = oracle_constraint_suffix(qualified_parent);
    let index_name = quote_oracle_identifier(&format!("IX_{suffix}"));

    connection
        .execute(
            &format!(
                "CREATE TABLE {qualified_parent} (\"ID\" NUMBER(10,0), CONSTRAINT \"PK_{parent_suffix}\" PRIMARY KEY (\"ID\"))"
            ),
            &[],
        )
        .await
        .map_err(|error| {
            oracle_setup_error("Oracle phase3 describe failed to create parent table", error)
        })?;
    connection
        .execute(
            &format!(
                "CREATE TABLE {qualified_child} (\
                    \"ID\" NUMBER(10,0) GENERATED BY DEFAULT AS IDENTITY NOT NULL, \
                    \"PARENT_ID\" NUMBER(10,0) NOT NULL, \
                    \"NAME\" VARCHAR2(80) DEFAULT 'unknown' NOT NULL, \
                    \"NAME_UPPER\" VARCHAR2(80) GENERATED ALWAYS AS (UPPER(\"NAME\")) VIRTUAL, \
                    \"AMOUNT\" NUMBER(12,2), \
                    CONSTRAINT \"PK_{suffix}\" PRIMARY KEY (\"ID\"), \
                    CONSTRAINT \"UQ_{suffix}\" UNIQUE (\"NAME\"), \
                    CONSTRAINT \"CK_{suffix}\" CHECK (\"AMOUNT\" IS NULL OR \"AMOUNT\" >= 0), \
                    CONSTRAINT \"FK_{suffix}\" FOREIGN KEY (\"PARENT_ID\") REFERENCES {qualified_parent} (\"ID\") ON DELETE CASCADE\
                )"
            ),
            &[],
        )
        .await
        .map_err(|error| {
            oracle_setup_error("Oracle phase3 describe failed to create child table", error)
        })?;
    connection
        .execute(
            &format!("CREATE INDEX {index_name} ON {qualified_child} (\"PARENT_ID\")"),
            &[],
        )
        .await
        .map_err(|error| {
            oracle_setup_error("Oracle phase3 describe failed to create child index", error)
        })?;
    connection
        .execute(
            &format!("COMMENT ON TABLE {qualified_child} IS 'Phase 3 child table'"),
            &[],
        )
        .await
        .map_err(|error| {
            oracle_setup_error(
                "Oracle phase3 describe failed to comment child table",
                error,
            )
        })?;
    connection
        .execute(
            &format!("COMMENT ON COLUMN {qualified_child}.\"NAME\" IS 'Display name'"),
            &[],
        )
        .await
        .map_err(|error| {
            oracle_setup_error(
                "Oracle phase3 describe failed to comment NAME column",
                error,
            )
        })?;
    connection.commit().await.map_err(|error| {
        oracle_setup_error("Oracle phase3 describe failed to commit fixture", error)
    })?;
    Ok(())
}

async fn setup_oracle_phase3_parent_table(
    driver: &OracleDriver,
    qualified_parent: &str,
) -> IpcResult<()> {
    let connection = driver.connection().await?;
    let parent_suffix = oracle_constraint_suffix(qualified_parent);
    connection
        .execute(
            &format!(
                "CREATE TABLE {qualified_parent} (\"ID\" NUMBER(10,0), CONSTRAINT \"PK_{parent_suffix}\" PRIMARY KEY (\"ID\"))"
            ),
            &[],
        )
        .await
        .map_err(|error| {
            oracle_setup_error("Oracle phase3 create failed to create parent table", error)
        })?;
    connection.commit().await.map_err(|error| {
        oracle_setup_error("Oracle phase3 create failed to commit parent table", error)
    })?;
    Ok(())
}

fn oracle_phase3_create_input(
    database: &str,
    schema: &str,
    table: &str,
    parent_table: &str,
) -> crate::engine::types::CreateTableInput {
    let qualified_table = oracle_qualified_name(schema, table);
    let suffix = oracle_constraint_suffix(&qualified_table);
    crate::engine::types::CreateTableInput {
        basics: TableSchemaBasics {
            table_name: table.to_string(),
            database_name: database.to_string(),
            schema_name: schema.to_string(),
            engine: None,
            charset: None,
            collation: None,
            comment: Some("Phase 3 created table".to_string()),
            partition: None,
        },
        columns: vec![
            TableColumnSchema {
                name: "ID".to_string(),
                type_name: "NUMBER(10,0)".to_string(),
                nullable: false,
                default_value: None,
                is_primary_key: true,
                is_unique: false,
                is_identity: true,
                comment: Some("Primary key".to_string()),
                identity: Some(TableIdentityOptions {
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
            },
            TableColumnSchema {
                name: "PARENT_ID".to_string(),
                type_name: "NUMBER(10,0)".to_string(),
                nullable: false,
                default_value: None,
                is_primary_key: false,
                is_unique: false,
                is_identity: false,
                comment: None,
                identity: None,
                generated: None,
                charset: None,
                collation: None,
            },
            TableColumnSchema {
                name: "NAME".to_string(),
                type_name: "VARCHAR2(80)".to_string(),
                nullable: false,
                default_value: Some("'unknown'".to_string()),
                is_primary_key: false,
                is_unique: false,
                is_identity: false,
                comment: Some("Display name".to_string()),
                identity: None,
                generated: None,
                charset: None,
                collation: None,
            },
            TableColumnSchema {
                name: "AMOUNT".to_string(),
                type_name: "NUMBER(12,2)".to_string(),
                nullable: true,
                default_value: None,
                is_primary_key: false,
                is_unique: false,
                is_identity: false,
                comment: None,
                identity: None,
                generated: None,
                charset: None,
                collation: None,
            },
        ],
        indexes: vec![TableIndexSchema {
            name: format!("IX_{suffix}"),
            columns: vec!["PARENT_ID".to_string()],
            is_unique: false,
            method: None,
            comment: None,
        }],
        constraints: vec![
            TableConstraintSchema {
                name: format!("PK_{suffix}"),
                kind: TableConstraintKind::PrimaryKey,
                columns: vec!["ID".to_string()],
                reference: None,
                expression: None,
                comment: None,
                foreign_key: None,
                enforced: Some(true),
            },
            TableConstraintSchema {
                name: format!("CK_{suffix}"),
                kind: TableConstraintKind::Check,
                columns: vec!["AMOUNT".to_string()],
                reference: None,
                expression: Some("\"AMOUNT\" IS NULL OR \"AMOUNT\" >= 0".to_string()),
                comment: None,
                foreign_key: None,
                enforced: Some(true),
            },
            TableConstraintSchema {
                name: format!("FK_{suffix}"),
                kind: TableConstraintKind::ForeignKey,
                columns: vec!["PARENT_ID".to_string()],
                reference: None,
                expression: None,
                comment: None,
                foreign_key: Some(TableForeignKeyReference {
                    database_name: None,
                    schema_name: Some(schema.to_string()),
                    table_name: parent_table.to_string(),
                    columns: vec!["ID".to_string()],
                    on_update: None,
                    on_delete: Some(TableReferentialAction::Cascade),
                }),
                enforced: Some(true),
            },
        ],
    }
}

fn oracle_frontend_roundtrip_table_schema(schema: &TableSchema) -> TableSchema {
    let mut schema = schema.clone();
    for constraint in &mut schema.constraints {
        if !matches!(
            constraint.kind,
            TableConstraintKind::Check | TableConstraintKind::ForeignKey
        ) {
            constraint.enforced = None;
        }
    }
    schema
}

async fn drop_oracle_phase3_describe_fixture(
    driver: &OracleDriver,
    qualified_child: &str,
    qualified_parent: &str,
) -> IpcResult<()> {
    let child_result = drop_oracle_table_best_effort(driver, qualified_child).await;
    let parent_result = drop_oracle_table_best_effort(driver, qualified_parent).await;

    child_result?;
    parent_result?;
    Ok(())
}

async fn drop_oracle_table_best_effort(
    driver: &OracleDriver,
    qualified_table: &str,
) -> IpcResult<()> {
    let connection = driver.connection().await?;
    match connection
        .execute(&format!("DROP TABLE {qualified_table} PURGE"), &[])
        .await
    {
        Ok(_) => Ok(()),
        Err(error) if error.to_string().contains("ORA-00942") => Ok(()),
        Err(error) => Err(oracle_setup_error(
            "Oracle phase3 cleanup failed to drop scratch table",
            error,
        )),
    }
}

fn oracle_setup_error(context: &str, error: oracle_rs::Error) -> IpcError {
    IpcError::system_internal(context, error.to_string())
}

fn oracle_write_tests_enabled(env: &TestEnv) -> bool {
    env.enabled("NEXPILOT_TEST_ORACLE_ENABLED") && env.bool_or("NEXPILOT_TEST_ALLOW_WRITES", false)
}

fn oracle_schema_from_env(env: &TestEnv) -> String {
    env.required("NEXPILOT_TEST_ORACLE_SCHEMA")
}

fn oracle_database_from_env(env: &TestEnv) -> String {
    env.optional("NEXPILOT_TEST_ORACLE_SERVICE_NAME")
        .or_else(|| env.optional("NEXPILOT_TEST_ORACLE_SID"))
        .or_else(|| env.optional("NEXPILOT_TEST_ORACLE_CONNECT_DESCRIPTOR"))
        .unwrap_or_else(|| "oracle".to_string())
}

fn oracle_scratch_prefix_from_env(env: &TestEnv) -> String {
    env.optional("NEXPILOT_TEST_SCRATCH_PREFIX")
        .unwrap_or_else(|| "NEXPILOT_IT_".to_string())
}

fn oracle_profile_from_env(env: &TestEnv) -> OracleProfile {
    OracleProfile {
        host: env.required("NEXPILOT_TEST_ORACLE_HOST"),
        port: env.u16_or("NEXPILOT_TEST_ORACLE_PORT", 1521),
        username: env.required("NEXPILOT_TEST_ORACLE_USERNAME"),
        password: env.required("NEXPILOT_TEST_ORACLE_PASSWORD"),
        service_name: env.optional("NEXPILOT_TEST_ORACLE_SERVICE_NAME"),
        sid: env.optional("NEXPILOT_TEST_ORACLE_SID"),
        connect_descriptor: env.optional("NEXPILOT_TEST_ORACLE_CONNECT_DESCRIPTOR"),
        role: env.oracle_role_or("NEXPILOT_TEST_ORACLE_ROLE", OracleRole::Normal),
        connect_timeout_seconds: Some(env.u64_or("NEXPILOT_TEST_CONNECT_TIMEOUT_SECONDS", 10)),
        ssh_tunnel: None,
    }
}

async fn connect_oracle_driver_from_env(env: &TestEnv, profile_id: String) -> OracleDriver {
    OracleDriver::connect(profile_id, oracle_profile_from_env(env))
        .await
        .expect("Oracle real smoke should connect")
}

fn oracle_qualified_name(schema: &str, table: &str) -> String {
    format!(
        "{}.{}",
        quote_oracle_identifier(schema),
        quote_oracle_identifier(table)
    )
}

fn oracle_scratch_identifier(prefix: &str, marker: &str) -> String {
    let sanitized_prefix = prefix
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '_')
        .map(|character| character.to_ascii_uppercase())
        .collect::<String>();
    let prefix = if sanitized_prefix.is_empty() {
        "NEXPILOT_IT_".to_string()
    } else {
        sanitized_prefix
    };
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() % 10_000_000_000)
        .unwrap_or(0);
    let suffix = format!("{marker}{unique:010}");
    let max_prefix_len = 30usize.saturating_sub(suffix.len());
    let prefix = prefix.chars().take(max_prefix_len).collect::<String>();
    format!("{prefix}{suffix}")
}

fn oracle_constraint_suffix(qualified_table: &str) -> String {
    qualified_table
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .chars()
        .rev()
        .take(24)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>()
}

fn oracle_name_update_change_set(id: i64, name: &str) -> TableChangeSetRequest {
    TableChangeSetRequest {
        inserts: Vec::new(),
        updates: vec![TableChangeSetUpdate {
            locator: primary_key_locator(vec![TableRowKeyPart {
                column: "ID".to_string(),
                value: serde_json::json!(id),
            }]),
            changes: vec![TableCellChange {
                column: "NAME".to_string(),
                value: serde_json::json!(name),
            }],
        }],
        deletes: Vec::new(),
    }
}

fn assert_oracle_readonly_result(
    result: &crate::engine::types::QueryResult,
    label: &str,
) -> Result<(), String> {
    if result.source_writable {
        return Err(format!("{label} should not be source_writable"));
    }
    if result.source_insertable {
        return Err(format!("{label} should not be source_insertable"));
    }
    if !result.primary_key_columns.is_empty() {
        return Err(format!(
            "{label} should not expose primary key columns for editing: {:?}",
            result.primary_key_columns
        ));
    }
    Ok(())
}

fn assert_oracle_row_name(
    result: &crate::engine::types::QueryResult,
    key: &str,
    expected_name: &str,
) -> Result<(), String> {
    let name_index = result
        .columns
        .iter()
        .position(|column| column.name == "NAME")
        .ok_or_else(|| "Oracle result should expose NAME column".to_string())?;
    let row = find_oracle_row_by_key(result, key)?;
    if json_cell_text(&row[name_index]) != expected_name {
        return Err(format!(
            "Oracle row {key} NAME mismatch: expected {expected_name}, got {}",
            json_cell_text(&row[name_index])
        ));
    }
    Ok(())
}

fn find_oracle_row_by_key<'a>(
    result: &'a crate::engine::types::QueryResult,
    key: &str,
) -> Result<&'a Vec<JsonValue>, String> {
    let key_columns = if key.contains('|') {
        vec!["PART_A", "PART_B"]
    } else {
        vec!["ID"]
    };
    let key_indexes = key_columns
        .iter()
        .map(|name| {
            result
                .columns
                .iter()
                .position(|column| column.name == *name)
                .ok_or_else(|| format!("Oracle result should expose {name} column"))
        })
        .collect::<Result<Vec<_>, _>>()?;

    result
        .rows
        .iter()
        .find(|row| {
            key_indexes
                .iter()
                .map(|index| json_cell_text(&row[*index]))
                .collect::<Vec<_>>()
                .join("|")
                == key
        })
        .ok_or_else(|| format!("Oracle result should contain row key {key}"))
}

fn json_cell_text(value: &JsonValue) -> String {
    match value {
        JsonValue::String(value) => value.clone(),
        JsonValue::Number(value) => value.to_string(),
        JsonValue::Bool(value) => value.to_string(),
        JsonValue::Null => "null".to_string(),
        other => other.to_string(),
    }
}
