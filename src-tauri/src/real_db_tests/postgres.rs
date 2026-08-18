use std::time::{SystemTime, UNIX_EPOCH};

use crate::engine::driver::DatabaseDriver;
use crate::engine::drivers::common::quote_pg_identifier;
use crate::engine::drivers::postgres::PostgresDriver;
use crate::engine::profiles::PostgresProfile;
use crate::engine::types::{
    ContainerKind, ContainerRef, DropTableInput, SqlExecutionContext, TableBrowseQuery,
};

use super::common::{json_cell_text, run_async, TestEnv};

#[test]
fn real_postgres_read_only_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !env.enabled("NEXPILOT_TEST_POSTGRES_ENABLED") {
            return;
        }

        let profile = PostgresProfile {
            host: env.required("NEXPILOT_TEST_POSTGRES_HOST"),
            port: env.u16_or("NEXPILOT_TEST_POSTGRES_PORT", 5432),
            username: env.required("NEXPILOT_TEST_POSTGRES_USERNAME"),
            password: env.required("NEXPILOT_TEST_POSTGRES_PASSWORD"),
            default_database: env.optional("NEXPILOT_TEST_POSTGRES_DATABASE"),
            schema: env.optional("NEXPILOT_TEST_POSTGRES_SCHEMA"),
            ssl_mode: env.optional("NEXPILOT_TEST_POSTGRES_SSL_MODE"),
            connect_timeout_seconds: Some(env.u64_or("NEXPILOT_TEST_CONNECT_TIMEOUT_SECONDS", 10)),
            ssh_tunnel: None,
        };
        let database = env.required("NEXPILOT_TEST_POSTGRES_DATABASE");
        let schema = env
            .optional("NEXPILOT_TEST_POSTGRES_SCHEMA")
            .unwrap_or_else(|| "public".to_string());

        let driver = PostgresDriver::connect("real-postgres-smoke".to_string(), profile)
            .await
            .expect("PostgreSQL real smoke should connect");
        driver
            .ping()
            .await
            .expect("PostgreSQL real smoke should ping");
        driver
            .as_schema_browser()
            .expect("PostgreSQL schema browser")
            .list_containers(None)
            .await
            .expect("PostgreSQL real smoke should list root containers");
        let result = driver
            .as_sql_executor()
            .expect("PostgreSQL SQL executor")
            .execute_sql(
                &SqlExecutionContext {
                    database: Some(database.clone()),
                    schema: None,
                },
                "SELECT 1 AS one",
                0,
                10,
            )
            .await
            .expect("PostgreSQL real smoke should execute SELECT 1");
        assert_eq!(result.rows.len(), 1);

        if let Some(table) = env.optional("NEXPILOT_TEST_POSTGRES_READ_TABLE") {
            let container =
                ContainerRef::table(ContainerKind::Table, database, Some(schema), table);
            let browse = driver
                .as_data_table_browser()
                .expect("PostgreSQL table browser")
                .browse_table_data(&container, 0, 5, &TableBrowseQuery::default())
                .await
                .expect("PostgreSQL real smoke should browse configured table");
            assert!(!browse.columns.is_empty());
        }

        driver.close().await.expect("close PostgreSQL smoke driver");
    });
}

#[test]
fn real_postgres_sql_editor_context_and_paging_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !env.enabled("NEXPILOT_TEST_POSTGRES_ENABLED") {
            return;
        }

        let profile = PostgresProfile {
            host: env.required("NEXPILOT_TEST_POSTGRES_HOST"),
            port: env.u16_or("NEXPILOT_TEST_POSTGRES_PORT", 5432),
            username: env.required("NEXPILOT_TEST_POSTGRES_USERNAME"),
            password: env.required("NEXPILOT_TEST_POSTGRES_PASSWORD"),
            default_database: env.optional("NEXPILOT_TEST_POSTGRES_DATABASE"),
            schema: env.optional("NEXPILOT_TEST_POSTGRES_SCHEMA"),
            ssl_mode: env.optional("NEXPILOT_TEST_POSTGRES_SSL_MODE"),
            connect_timeout_seconds: Some(env.u64_or("NEXPILOT_TEST_CONNECT_TIMEOUT_SECONDS", 10)),
            ssh_tunnel: None,
        };
        let database = env.required("NEXPILOT_TEST_POSTGRES_DATABASE");
        let schema = env
            .optional("NEXPILOT_TEST_POSTGRES_SCHEMA")
            .unwrap_or_else(|| "public".to_string());

        let driver = PostgresDriver::connect("real-postgres-sql-editor".to_string(), profile)
            .await
            .expect("PostgreSQL SQL editor smoke should connect");
        let executor = driver
            .as_sql_executor()
            .expect("PostgreSQL SQL editor smoke should expose SQL executor");
        let context = SqlExecutionContext {
            database: Some(database),
            schema: Some(schema.clone()),
        };

        let context_result = executor
            .execute_sql(&context, "SELECT current_schema() AS active_schema", 1, 10)
            .await
            .expect("PostgreSQL SQL editor smoke should apply schema context");
        assert_eq!(context_result.rows.len(), 1);
        assert_eq!(json_cell_text(&context_result.rows[0][0]), schema);

        let page_one = executor
            .execute_sql(
                &context,
                "SELECT n FROM generate_series(1, 3) AS n ORDER BY n",
                1,
                2,
            )
            .await
            .expect("PostgreSQL SQL editor smoke should fetch page one");
        assert_eq!(page_one.rows.len(), 2);
        assert!(page_one.has_next_page);
        assert_eq!(json_cell_text(&page_one.rows[0][0]), "1");
        assert_eq!(json_cell_text(&page_one.rows[1][0]), "2");

        let page_two = executor
            .execute_sql(
                &context,
                "SELECT n FROM generate_series(1, 3) AS n ORDER BY n",
                2,
                2,
            )
            .await
            .expect("PostgreSQL SQL editor smoke should fetch page two");
        assert_eq!(page_two.rows.len(), 1);
        assert!(!page_two.has_next_page);
        assert_eq!(json_cell_text(&page_two.rows[0][0]), "3");

        driver
            .close()
            .await
            .expect("close PostgreSQL SQL editor smoke driver");
    });
}

#[test]
fn real_postgres_sql_editor_sequential_script_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !env.enabled("NEXPILOT_TEST_POSTGRES_ENABLED") {
            return;
        }

        let profile = PostgresProfile {
            host: env.required("NEXPILOT_TEST_POSTGRES_HOST"),
            port: env.u16_or("NEXPILOT_TEST_POSTGRES_PORT", 5432),
            username: env.required("NEXPILOT_TEST_POSTGRES_USERNAME"),
            password: env.required("NEXPILOT_TEST_POSTGRES_PASSWORD"),
            default_database: env.optional("NEXPILOT_TEST_POSTGRES_DATABASE"),
            schema: env.optional("NEXPILOT_TEST_POSTGRES_SCHEMA"),
            ssl_mode: env.optional("NEXPILOT_TEST_POSTGRES_SSL_MODE"),
            connect_timeout_seconds: Some(env.u64_or("NEXPILOT_TEST_CONNECT_TIMEOUT_SECONDS", 10)),
            ssh_tunnel: None,
        };
        let database = env.required("NEXPILOT_TEST_POSTGRES_DATABASE");
        let schema = env
            .optional("NEXPILOT_TEST_POSTGRES_SCHEMA")
            .unwrap_or_else(|| "public".to_string());

        let driver = PostgresDriver::connect("real-postgres-sql-script".to_string(), profile)
            .await
            .expect("PostgreSQL SQL script smoke should connect");
        let executor = driver
            .as_sql_executor()
            .expect("PostgreSQL SQL script smoke should expose SQL executor");
        let context = SqlExecutionContext {
            database: Some(database),
            schema: Some(schema.clone()),
        };

        let schema_result = executor
            .execute_sql(&context, "SELECT current_schema() AS active_schema", 1, 10)
            .await
            .expect("PostgreSQL SQL script smoke should apply schema context");
        assert_eq!(json_cell_text(&schema_result.rows[0][0]), schema);

        let statements = [
            ("SELECT 1 AS step_value", "1"),
            ("SELECT 2 AS step_value", "2"),
            ("SELECT 3 AS step_value", "3"),
        ];
        for (sql, expected) in statements {
            let result = executor
                .execute_sql(&context, sql, 1, 10)
                .await
                .expect("PostgreSQL SQL script smoke should execute statement sequentially");
            assert_eq!(result.rows.len(), 1);
            assert_eq!(json_cell_text(&result.rows[0][0]), expected);
        }

        driver
            .close()
            .await
            .expect("close PostgreSQL SQL script smoke driver");
    });
}

#[test]
fn real_postgres_drop_table_scratch_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !env.enabled("NEXPILOT_TEST_POSTGRES_ENABLED")
            || !env.bool_or("NEXPILOT_TEST_ALLOW_WRITES", false)
        {
            return;
        }

        let profile = PostgresProfile {
            host: env.required("NEXPILOT_TEST_POSTGRES_HOST"),
            port: env.u16_or("NEXPILOT_TEST_POSTGRES_PORT", 5432),
            username: env.required("NEXPILOT_TEST_POSTGRES_USERNAME"),
            password: env.required("NEXPILOT_TEST_POSTGRES_PASSWORD"),
            default_database: env.optional("NEXPILOT_TEST_POSTGRES_DATABASE"),
            schema: env.optional("NEXPILOT_TEST_POSTGRES_SCHEMA"),
            ssl_mode: env.optional("NEXPILOT_TEST_POSTGRES_SSL_MODE"),
            connect_timeout_seconds: Some(env.u64_or("NEXPILOT_TEST_CONNECT_TIMEOUT_SECONDS", 10)),
            ssh_tunnel: None,
        };
        let database = env.required("NEXPILOT_TEST_POSTGRES_DATABASE");
        let schema = env
            .optional("NEXPILOT_TEST_POSTGRES_SCHEMA")
            .unwrap_or_else(|| "public".to_string());

        let driver = PostgresDriver::connect("real-postgres-drop-table".to_string(), profile)
            .await
            .expect("PostgreSQL drop table smoke should connect");
        let table = postgres_scratch_identifier(
            &env.optional("NEXPILOT_TEST_SCRATCH_PREFIX")
                .unwrap_or_else(|| "nexpilot_it_".to_string()),
            "dt",
        );
        let qualified_table = postgres_qualified_name(&schema, &table);
        let container = ContainerRef::table(
            ContainerKind::Table,
            database.clone(),
            Some(schema.clone()),
            table.clone(),
        );

        let operation_result: Result<(), String> = async {
            postgres_execute(
                &driver,
                &database,
                &schema,
                &format!("DROP TABLE IF EXISTS {qualified_table}"),
            )
            .await
            .map_err(|error| format!("PostgreSQL cleanup before drop smoke failed: {error:?}"))?;
            postgres_execute(
                &driver,
                &database,
                &schema,
                &format!("CREATE TABLE {qualified_table} (\"id\" INTEGER PRIMARY KEY)"),
            )
            .await
            .map_err(|error| {
                format!("PostgreSQL drop smoke should create scratch table: {error:?}")
            })?;

            let mut input = DropTableInput {
                container: container.clone(),
                confirm_destructive: false,
            };
            let mutator = driver
                .as_schema_mutator()
                .expect("PostgreSQL schema mutator should exist");
            let preview = mutator
                .preview_drop_table(&input)
                .await
                .map_err(|error| format!("PostgreSQL drop smoke should preview drop: {error:?}"))?;
            if !preview.destructive
                || !preview
                    .statements
                    .contains(&format!("DROP TABLE {qualified_table}"))
            {
                return Err(format!("PostgreSQL drop preview mismatch: {preview:?}"));
            }

            let confirm_error = mutator
                .drop_table(&input)
                .await
                .expect_err("PostgreSQL drop table should require destructive confirmation");
            if format!("{:?}", confirm_error.code) != "ValidationFailed" {
                return Err(format!(
                    "PostgreSQL drop confirm error mismatch: {confirm_error:?}"
                ));
            }

            input.confirm_destructive = true;
            let result = mutator
                .drop_table(&input)
                .await
                .map_err(|error| format!("PostgreSQL drop smoke should drop table: {error:?}"))?;
            if result.table_name != table {
                return Err(format!(
                    "PostgreSQL drop result table mismatch: expected {table}, got {}",
                    result.table_name
                ));
            }

            if driver
                .as_schema_browser()
                .expect("PostgreSQL schema browser should exist")
                .describe_table(&container)
                .await
                .is_ok()
            {
                return Err("PostgreSQL dropped table should no longer describe".to_string());
            }

            Ok(())
        }
        .await;

        let cleanup_result = postgres_execute(
            &driver,
            &database,
            &schema,
            &format!("DROP TABLE IF EXISTS {qualified_table}"),
        )
        .await;
        let close_result = driver.close().await;
        if let Err(error) = operation_result {
            panic!("{error}; cleanup_result={cleanup_result:?}; close_result={close_result:?}");
        }
        cleanup_result.expect("PostgreSQL drop table smoke cleanup should succeed");
        close_result.expect("close PostgreSQL drop table smoke driver");
    });
}

async fn postgres_execute(
    driver: &PostgresDriver,
    database: &str,
    schema: &str,
    sql: &str,
) -> crate::error::IpcResult<()> {
    driver
        .as_sql_executor()
        .expect("PostgreSQL SQL executor")
        .execute_sql(
            &SqlExecutionContext {
                database: Some(database.to_string()),
                schema: Some(schema.to_string()),
            },
            sql,
            1,
            10,
        )
        .await
        .map(|_| ())
}

fn postgres_qualified_name(schema: &str, table: &str) -> String {
    format!(
        "{}.{}",
        quote_pg_identifier(schema),
        quote_pg_identifier(table)
    )
}

fn postgres_scratch_identifier(prefix: &str, marker: &str) -> String {
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
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_millis();
    format!("{prefix}{marker}_{millis}")
        .chars()
        .take(60)
        .collect()
}
