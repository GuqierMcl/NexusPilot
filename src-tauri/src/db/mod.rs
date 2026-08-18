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
