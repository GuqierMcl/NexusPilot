use std::time::{SystemTime, UNIX_EPOCH};

use crate::engine::driver::DatabaseDriver;
use crate::engine::drivers::common::quote_mysql_identifier;
use crate::engine::drivers::mysql::MysqlDriver;
use crate::engine::profiles::MysqlProfile;
use crate::engine::types::{
    ContainerKind, ContainerRef, DropTableInput, SqlExecutionContext, TableBrowseQuery,
};

use super::common::{json_cell_text, run_async, TestEnv};

#[test]
fn real_mysql_read_only_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !env.enabled("NEXPILOT_TEST_MYSQL_ENABLED") {
            return;
        }

        let database = env.required("NEXPILOT_TEST_MYSQL_DATABASE");
        let profile = MysqlProfile {
            host: env.required("NEXPILOT_TEST_MYSQL_HOST"),
            port: env.u16_or("NEXPILOT_TEST_MYSQL_PORT", 3306),
            username: env.required("NEXPILOT_TEST_MYSQL_USERNAME"),
            password: env.required("NEXPILOT_TEST_MYSQL_PASSWORD"),
            default_database: Some(database.clone()),
            connect_timeout_seconds: Some(env.u64_or("NEXPILOT_TEST_CONNECT_TIMEOUT_SECONDS", 10)),
            ssh_tunnel: None,
            ssl_mode: env.optional("NEXPILOT_TEST_MYSQL_SSL_MODE"),
        };

        let driver = MysqlDriver::connect("real-mysql-smoke".to_string(), profile)
            .await
            .expect("MySQL real smoke should connect");
        driver.ping().await.expect("MySQL real smoke should ping");
        driver
            .as_schema_browser()
            .expect("MySQL schema browser")
            .list_containers(None)
            .await
            .expect("MySQL real smoke should list databases");
        let result = driver
            .as_sql_executor()
            .expect("MySQL SQL executor")
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
            .expect("MySQL real smoke should execute SELECT 1");
        assert_eq!(result.rows.len(), 1);

        if let Some(table) = env.optional("NEXPILOT_TEST_MYSQL_READ_TABLE") {
            let container = ContainerRef::table(ContainerKind::Table, database, None, table);
            let browse = driver
                .as_data_table_browser()
                .expect("MySQL table browser")
                .browse_table_data(&container, 0, 5, &TableBrowseQuery::default())
                .await
                .expect("MySQL real smoke should browse configured table");
            assert!(!browse.columns.is_empty());
        }

        driver.close().await.expect("close MySQL smoke driver");
    });
}

#[test]
fn real_mysql_sql_editor_context_and_paging_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !env.enabled("NEXPILOT_TEST_MYSQL_ENABLED") {
            return;
        }

        let database = env.required("NEXPILOT_TEST_MYSQL_DATABASE");
        let profile = MysqlProfile {
            host: env.required("NEXPILOT_TEST_MYSQL_HOST"),
            port: env.u16_or("NEXPILOT_TEST_MYSQL_PORT", 3306),
            username: env.required("NEXPILOT_TEST_MYSQL_USERNAME"),
            password: env.required("NEXPILOT_TEST_MYSQL_PASSWORD"),
            default_database: Some(database.clone()),
            connect_timeout_seconds: Some(env.u64_or("NEXPILOT_TEST_CONNECT_TIMEOUT_SECONDS", 10)),
            ssh_tunnel: None,
            ssl_mode: env.optional("NEXPILOT_TEST_MYSQL_SSL_MODE"),
        };

        let driver = MysqlDriver::connect("real-mysql-sql-editor".to_string(), profile)
            .await
            .expect("MySQL SQL editor smoke should connect");
        let executor = driver
            .as_sql_executor()
            .expect("MySQL SQL editor smoke should expose SQL executor");
        let context = SqlExecutionContext {
            database: Some(database.clone()),
            schema: None,
        };

        let context_result = executor
            .execute_sql(&context, "SELECT DATABASE() AS active_database", 1, 10)
            .await
            .expect("MySQL SQL editor smoke should apply database context");
        assert_eq!(context_result.rows.len(), 1);
        assert_eq!(json_cell_text(&context_result.rows[0][0]), database);

        let page_one = executor
            .execute_sql(
                &context,
                "SELECT 1 AS n UNION ALL SELECT 2 AS n UNION ALL SELECT 3 AS n ORDER BY n",
                1,
                2,
            )
            .await
            .expect("MySQL SQL editor smoke should fetch page one");
        assert_eq!(page_one.rows.len(), 2);
        assert!(page_one.has_next_page);
        assert_eq!(json_cell_text(&page_one.rows[0][0]), "1");
        assert_eq!(json_cell_text(&page_one.rows[1][0]), "2");

        let page_two = executor
            .execute_sql(
                &context,
                "SELECT 1 AS n UNION ALL SELECT 2 AS n UNION ALL SELECT 3 AS n ORDER BY n",
                2,
                2,
            )
            .await
            .expect("MySQL SQL editor smoke should fetch page two");
        assert_eq!(page_two.rows.len(), 1);
        assert!(!page_two.has_next_page);
        assert_eq!(json_cell_text(&page_two.rows[0][0]), "3");

        driver
            .close()
            .await
            .expect("close MySQL SQL editor smoke driver");
    });
}

#[test]
fn real_mysql_sql_editor_sequential_script_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !env.enabled("NEXPILOT_TEST_MYSQL_ENABLED") {
            return;
        }

        let database = env.required("NEXPILOT_TEST_MYSQL_DATABASE");
        let profile = MysqlProfile {
            host: env.required("NEXPILOT_TEST_MYSQL_HOST"),
            port: env.u16_or("NEXPILOT_TEST_MYSQL_PORT", 3306),
            username: env.required("NEXPILOT_TEST_MYSQL_USERNAME"),
            password: env.required("NEXPILOT_TEST_MYSQL_PASSWORD"),
            default_database: Some(database.clone()),
            connect_timeout_seconds: Some(env.u64_or("NEXPILOT_TEST_CONNECT_TIMEOUT_SECONDS", 10)),
            ssh_tunnel: None,
            ssl_mode: env.optional("NEXPILOT_TEST_MYSQL_SSL_MODE"),
        };

        let driver = MysqlDriver::connect("real-mysql-sql-script".to_string(), profile)
            .await
            .expect("MySQL SQL script smoke should connect");
        let executor = driver
            .as_sql_executor()
            .expect("MySQL SQL script smoke should expose SQL executor");
        let context = SqlExecutionContext {
            database: Some(database),
            schema: None,
        };
        let statements = [
            ("SELECT 1 AS step_value", "1"),
            ("SELECT 2 AS step_value", "2"),
            ("SELECT 3 AS step_value", "3"),
        ];

        for (sql, expected) in statements {
            let result = executor
                .execute_sql(&context, sql, 1, 10)
                .await
                .expect("MySQL SQL script smoke should execute statement sequentially");
            assert_eq!(result.rows.len(), 1);
            assert_eq!(json_cell_text(&result.rows[0][0]), expected);
        }

        driver
            .close()
            .await
            .expect("close MySQL SQL script smoke driver");
    });
}

#[test]
fn real_mysql_table_and_sql_value_codec_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !env.enabled("NEXPILOT_TEST_MYSQL_ENABLED")
            || !env.bool_or("NEXPILOT_TEST_ALLOW_WRITES", false)
        {
            return;
        }

        let database = env.required("NEXPILOT_TEST_MYSQL_DATABASE");
        let profile = MysqlProfile {
            host: env.required("NEXPILOT_TEST_MYSQL_HOST"),
            port: env.u16_or("NEXPILOT_TEST_MYSQL_PORT", 3306),
            username: env.required("NEXPILOT_TEST_MYSQL_USERNAME"),
            password: env.required("NEXPILOT_TEST_MYSQL_PASSWORD"),
            default_database: Some(database.clone()),
            connect_timeout_seconds: Some(env.u64_or("NEXPILOT_TEST_CONNECT_TIMEOUT_SECONDS", 10)),
            ssh_tunnel: None,
            ssl_mode: env.optional("NEXPILOT_TEST_MYSQL_SSL_MODE"),
        };

        let driver = MysqlDriver::connect("real-mysql-value-codec".to_string(), profile)
            .await
            .expect("MySQL value codec smoke should connect");
        let table = mysql_scratch_identifier(
            &env.optional("NEXPILOT_TEST_SCRATCH_PREFIX")
                .unwrap_or_else(|| "nexpilot_it_".to_string()),
            "codec",
        );
        let qualified_table = mysql_qualified_name(&database, &table);
        let container =
            ContainerRef::table(ContainerKind::Table, database.clone(), None, table.clone());
        let context = SqlExecutionContext {
            database: Some(database.clone()),
            schema: None,
        };

        let operation_result: Result<(), String> = async {
            mysql_execute(
                &driver,
                &database,
                &format!("DROP TABLE IF EXISTS {qualified_table}"),
            )
            .await
            .map_err(|error| format!("MySQL value codec cleanup failed: {error:?}"))?;
            mysql_execute(
                &driver,
                &database,
                &format!(
                    "CREATE TABLE {qualified_table} (\
                        `sample_id` INT PRIMARY KEY,\
                        `medium_col` MEDIUMINT NOT NULL,\
                        `big_col` BIGINT NOT NULL,\
                        `decimal_col` DECIMAL(20, 6) NOT NULL,\
                        `float_col` FLOAT NOT NULL,\
                        `double_col` DOUBLE NOT NULL,\
                        `bit_col` BIT(8) NOT NULL,\
                        `date_col` DATE NOT NULL,\
                        `time_col` TIME(6) NOT NULL,\
                        `datetime_col` DATETIME(6) NOT NULL,\
                        `timestamp_col` TIMESTAMP(6) NULL,\
                        `year_col` YEAR NOT NULL,\
                        `json_col` JSON NOT NULL,\
                        `binary_col` BINARY(4) NOT NULL,\
                        `point_col` POINT NOT NULL,\
                        `nullable_col` VARCHAR(16) NULL\
                    )"
                ),
            )
            .await
            .map_err(|error| format!("MySQL value codec table creation failed: {error:?}"))?;
            mysql_execute(
                &driver,
                &database,
                &format!(
                    "INSERT INTO {qualified_table} VALUES (\
                        1,\
                        3,\
                        9007199254740993,\
                        12345.678900,\
                        1.23,\
                        4.56,\
                        b'10101010',\
                        '2026-05-10',\
                        '19:38:21.123456',\
                        '2025-01-01 12:34:56.123456',\
                        '2026-05-09 05:12:02.123456',\
                        2026,\
                        JSON_OBJECT('hello', 'world', 'number', 123),\
                        X'0A0B0C0D',\
                        ST_GeomFromText('POINT(1 2)'),\
                        NULL\
                    )"
                ),
            )
            .await
            .map_err(|error| format!("MySQL value codec insert failed: {error:?}"))?;

            let table_result = driver
                .as_data_table_browser()
                .expect("MySQL table browser")
                .browse_table_data(&container, 1, 10, &TableBrowseQuery::default())
                .await
                .map_err(|error| format!("MySQL value codec table query failed: {error:?}"))?;
            let sql_result = driver
                .as_sql_executor()
                .expect("MySQL SQL executor")
                .execute_sql(
                    &context,
                    &format!("SELECT * FROM {qualified_table} WHERE `sample_id` = 1"),
                    1,
                    10,
                )
                .await
                .map_err(|error| format!("MySQL value codec SQL query failed: {error:?}"))?;

            if table_result.rows.len() != 1 || sql_result.rows.len() != 1 {
                return Err(format!(
                    "MySQL value codec row count mismatch: table={}, sql={}",
                    table_result.rows.len(),
                    sql_result.rows.len()
                ));
            }

            let table_values = mysql_named_row(&table_result);
            let sql_values = mysql_named_row(&sql_result);
            for name in [
                "sample_id",
                "medium_col",
                "big_col",
                "decimal_col",
                "float_col",
                "double_col",
                "date_col",
                "time_col",
                "datetime_col",
                "timestamp_col",
                "year_col",
            ] {
                if table_values.get(name) != sql_values.get(name) {
                    return Err(format!(
                        "MySQL value codec mismatch for {name}: table={:?}, sql={:?}",
                        table_values.get(name),
                        sql_values.get(name)
                    ));
                }
            }

            if sql_values
                .iter()
                .any(|(name, value)| name != "nullable_col" && value.is_null())
            {
                return Err(format!(
                    "MySQL SQL value codec returned an unexpected null: {sql_values:?}"
                ));
            }
            if table_values.get("nullable_col") != Some(&serde_json::Value::Null)
                || sql_values.get("nullable_col") != Some(&serde_json::Value::Null)
            {
                return Err(format!(
                    "MySQL real NULL should remain null: table={:?}, sql={:?}",
                    table_values.get("nullable_col"),
                    sql_values.get("nullable_col")
                ));
            }
            if sql_values.get("decimal_col")
                != Some(&serde_json::Value::String("12345.678900".to_string()))
            {
                return Err(format!(
                    "MySQL decimal should retain scale: {:?}",
                    sql_values.get("decimal_col")
                ));
            }

            let table_json = table_values
                .get("json_col")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "MySQL table JSON should be text".to_string())?;
            let sql_json = sql_values
                .get("json_col")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "MySQL SQL JSON should be text".to_string())?;
            let table_json: serde_json::Value = serde_json::from_str(table_json)
                .map_err(|error| format!("MySQL table JSON should parse: {error}"))?;
            let sql_json: serde_json::Value = serde_json::from_str(sql_json)
                .map_err(|error| format!("MySQL SQL JSON should parse: {error}"))?;
            if table_json != sql_json {
                return Err(format!(
                    "MySQL JSON semantic mismatch: table={table_json}, sql={sql_json}"
                ));
            }

            Ok(())
        }
        .await;

        let cleanup_result = mysql_execute(
            &driver,
            &database,
            &format!("DROP TABLE IF EXISTS {qualified_table}"),
        )
        .await;
        let close_result = driver.close().await;
        if let Err(error) = operation_result {
            panic!("{error}; cleanup_result={cleanup_result:?}; close_result={close_result:?}");
        }
        cleanup_result.expect("MySQL value codec smoke cleanup should succeed");
        close_result.expect("close MySQL value codec smoke driver");
    });
}

#[test]
fn real_mysql_drop_table_scratch_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !env.enabled("NEXPILOT_TEST_MYSQL_ENABLED")
            || !env.bool_or("NEXPILOT_TEST_ALLOW_WRITES", false)
        {
            return;
        }

        let database = env.required("NEXPILOT_TEST_MYSQL_DATABASE");
        let profile = MysqlProfile {
            host: env.required("NEXPILOT_TEST_MYSQL_HOST"),
            port: env.u16_or("NEXPILOT_TEST_MYSQL_PORT", 3306),
            username: env.required("NEXPILOT_TEST_MYSQL_USERNAME"),
            password: env.required("NEXPILOT_TEST_MYSQL_PASSWORD"),
            default_database: Some(database.clone()),
            connect_timeout_seconds: Some(env.u64_or("NEXPILOT_TEST_CONNECT_TIMEOUT_SECONDS", 10)),
            ssh_tunnel: None,
            ssl_mode: env.optional("NEXPILOT_TEST_MYSQL_SSL_MODE"),
        };

        let driver = MysqlDriver::connect("real-mysql-drop-table".to_string(), profile)
            .await
            .expect("MySQL drop table smoke should connect");
        let table = mysql_scratch_identifier(
            &env.optional("NEXPILOT_TEST_SCRATCH_PREFIX")
                .unwrap_or_else(|| "nexpilot_it_".to_string()),
            "dt",
        );
        let qualified_table = mysql_qualified_name(&database, &table);
        let container = ContainerRef::table(ContainerKind::Table, database.clone(), None, &table);

        let operation_result: Result<(), String> = async {
            mysql_execute(
                &driver,
                &database,
                &format!("DROP TABLE IF EXISTS {qualified_table}"),
            )
            .await
            .map_err(|error| format!("MySQL cleanup before drop smoke failed: {error:?}"))?;
            mysql_execute(
                &driver,
                &database,
                &format!("CREATE TABLE {qualified_table} (`id` INT PRIMARY KEY)"),
            )
            .await
            .map_err(|error| format!("MySQL drop smoke should create scratch table: {error:?}"))?;

            let mut input = DropTableInput {
                container: container.clone(),
                confirm_destructive: false,
            };
            let mutator = driver
                .as_schema_mutator()
                .expect("MySQL schema mutator should exist");
            let preview = mutator
                .preview_drop_table(&input)
                .await
                .map_err(|error| format!("MySQL drop smoke should preview drop: {error:?}"))?;
            if !preview.destructive
                || !preview
                    .statements
                    .contains(&format!("DROP TABLE {qualified_table}"))
            {
                return Err(format!("MySQL drop preview mismatch: {preview:?}"));
            }

            let confirm_error = mutator
                .drop_table(&input)
                .await
                .expect_err("MySQL drop table should require destructive confirmation");
            if format!("{:?}", confirm_error.code) != "ValidationFailed" {
                return Err(format!(
                    "MySQL drop confirm error mismatch: {confirm_error:?}"
                ));
            }

            input.confirm_destructive = true;
            let result = mutator
                .drop_table(&input)
                .await
                .map_err(|error| format!("MySQL drop smoke should drop table: {error:?}"))?;
            if result.table_name != table {
                return Err(format!(
                    "MySQL drop result table mismatch: expected {table}, got {}",
                    result.table_name
                ));
            }

            if driver
                .as_schema_browser()
                .expect("MySQL schema browser should exist")
                .describe_table(&container)
                .await
                .is_ok()
            {
                return Err("MySQL dropped table should no longer describe".to_string());
            }

            Ok(())
        }
        .await;

        let cleanup_result = mysql_execute(
            &driver,
            &database,
            &format!("DROP TABLE IF EXISTS {qualified_table}"),
        )
        .await;
        let close_result = driver.close().await;
        if let Err(error) = operation_result {
            panic!("{error}; cleanup_result={cleanup_result:?}; close_result={close_result:?}");
        }
        cleanup_result.expect("MySQL drop table smoke cleanup should succeed");
        close_result.expect("close MySQL drop table smoke driver");
    });
}

async fn mysql_execute(
    driver: &MysqlDriver,
    database: &str,
    sql: &str,
) -> crate::error::IpcResult<()> {
    driver
        .as_sql_executor()
        .expect("MySQL SQL executor")
        .execute_sql(
            &SqlExecutionContext {
                database: Some(database.to_string()),
                schema: None,
            },
            sql,
            1,
            10,
        )
        .await
        .map(|_| ())
}

fn mysql_qualified_name(database: &str, table: &str) -> String {
    format!(
        "{}.{}",
        quote_mysql_identifier(database),
        quote_mysql_identifier(table)
    )
}

fn mysql_scratch_identifier(prefix: &str, marker: &str) -> String {
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

fn mysql_named_row(
    result: &crate::engine::types::QueryResult,
) -> std::collections::HashMap<String, serde_json::Value> {
    let row = result
        .rows
        .first()
        .expect("MySQL named row requires one result row");
    result
        .columns
        .iter()
        .zip(row.iter())
        .map(|(column, value)| (column.name.clone(), value.clone()))
        .collect()
}
