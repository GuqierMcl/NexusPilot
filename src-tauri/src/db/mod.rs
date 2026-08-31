use std::fs;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;
use tauri::{AppHandle, Manager, Runtime};

use crate::error::AppResult;

pub const APP_DATABASE_FILE_NAME: &str = "nexus_pilot.sqlite3";

#[derive(Clone)]
pub struct DatabaseState {
    pub pool: SqlitePool,
}

pub async fn init_database<R: Runtime>(app: &AppHandle<R>) -> AppResult<DatabaseState> {
    let app_data_dir = app.path().app_data_dir()?;
    fs::create_dir_all(&app_data_dir)?;

    let database_path = app_data_dir.join(APP_DATABASE_FILE_NAME);

    let connect_options = SqliteConnectOptions::new()
        .filename(&database_path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(connect_options)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;

    Ok(DatabaseState { pool })
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    #[test]
    fn connection_notes_migration_defaults_existing_rows_to_empty_string() {
        tauri::async_runtime::block_on(async {
            let options = SqliteConnectOptions::from_str("sqlite::memory:")
                .expect("sqlite memory options should parse");
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(options)
                .await
                .expect("test sqlite pool should open");

            sqlx::query("CREATE TABLE connections (id TEXT PRIMARY KEY NOT NULL)")
                .execute(&pool)
                .await
                .expect("legacy connections table should be created");
            sqlx::query("INSERT INTO connections (id) VALUES ('profile-1')")
                .execute(&pool)
                .await
                .expect("legacy connection should be inserted");

            sqlx::query(include_str!("../../migrations/0005_connection_notes.sql"))
                .execute(&pool)
                .await
                .expect("connection notes migration should apply");

            let note = sqlx::query_scalar::<_, String>(
                "SELECT note FROM connections WHERE id = 'profile-1'",
            )
            .fetch_one(&pool)
            .await
            .expect("migrated connection should expose a non-null note");
            assert_eq!(note, "");

            pool.close().await;
        });
    }
}
