use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    pub id: String,
    pub profile_id: String,
    pub title: String,
    pub driver: String,
    pub database_name: Option<String>,
    pub schema_name: Option<String>,
    pub sql_text: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSavedQueryInput {
    pub id: String,
    pub profile_id: String,
    pub title: String,
    pub driver: String,
    pub database_name: Option<String>,
    pub schema_name: Option<String>,
    pub sql_text: String,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSavedQueryInput {
    pub id: String,
    pub title: String,
    pub database_name: Option<String>,
    pub schema_name: Option<String>,
    pub sql_text: String,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone, FromRow)]
struct SavedQueryRow {
    id: String,
    profile_id: String,
    title: String,
    driver: String,
    database_name: Option<String>,
    schema_name: Option<String>,
    sql_text: String,
    created_at: i64,
    updated_at: i64,
    sort_order: Option<i64>,
}

impl From<SavedQueryRow> for SavedQuery {
    fn from(row: SavedQueryRow) -> Self {
        Self {
            id: row.id,
            profile_id: row.profile_id,
            title: row.title,
            driver: row.driver,
            database_name: row.database_name,
            schema_name: row.schema_name,
            sql_text: row.sql_text,
            created_at: row.created_at,
            updated_at: row.updated_at,
            sort_order: row.sort_order,
        }
    }
}

pub struct SavedQueryRepository;

impl SavedQueryRepository {
    pub async fn list_by_profile(
        pool: &SqlitePool,
        profile_id: &str,
    ) -> AppResult<Vec<SavedQuery>> {
        let rows = sqlx::query_as::<_, SavedQueryRow>(
            r#"
            SELECT
                id,
                profile_id,
                title,
                driver,
                database_name,
                schema_name,
                sql_text,
                created_at,
                updated_at,
                sort_order
            FROM saved_queries
            WHERE profile_id = ?1
            ORDER BY sort_order IS NULL, sort_order ASC, updated_at DESC
            "#,
        )
        .bind(profile_id)
        .fetch_all(pool)
        .await?;

        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn get(pool: &SqlitePool, id: &str) -> AppResult<Option<SavedQuery>> {
        let row = sqlx::query_as::<_, SavedQueryRow>(
            r#"
            SELECT
                id,
                profile_id,
                title,
                driver,
                database_name,
                schema_name,
                sql_text,
                created_at,
                updated_at,
                sort_order
            FROM saved_queries
            WHERE id = ?1
            "#,
        )
        .bind(id)
        .fetch_optional(pool)
        .await?;

        Ok(row.map(Into::into))
    }

    pub async fn create(pool: &SqlitePool, input: CreateSavedQueryInput) -> AppResult<SavedQuery> {
        let normalized = NormalizedCreateSavedQueryInput::try_from(input)?;
        ensure_profile_driver_matches(pool, &normalized.profile_id, &normalized.driver).await?;

        let now_ms = now_unix_ms();

        sqlx::query(
            r#"
            INSERT INTO saved_queries (
                id,
                profile_id,
                title,
                driver,
                database_name,
                schema_name,
                sql_text,
                created_at,
                updated_at,
                sort_order
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)
            "#,
        )
        .bind(&normalized.id)
        .bind(&normalized.profile_id)
        .bind(&normalized.title)
        .bind(&normalized.driver)
        .bind(normalized.database_name.as_deref())
        .bind(normalized.schema_name.as_deref())
        .bind(&normalized.sql_text)
        .bind(now_ms)
        .bind(normalized.sort_order)
        .execute(pool)
        .await?;

        Self::get(pool, &normalized.id)
            .await?
            .ok_or_else(|| AppError::not_found("Failed to load created saved query"))
    }

    pub async fn update(pool: &SqlitePool, input: UpdateSavedQueryInput) -> AppResult<SavedQuery> {
        let normalized = NormalizedUpdateSavedQueryInput::try_from(input)?;
        let now_ms = now_unix_ms();

        let result = sqlx::query(
            r#"
            UPDATE saved_queries
            SET
                title = ?2,
                database_name = ?3,
                schema_name = ?4,
                sql_text = ?5,
                sort_order = ?6,
                updated_at = MAX(?7, updated_at + 1)
            WHERE id = ?1
            "#,
        )
        .bind(&normalized.id)
        .bind(&normalized.title)
        .bind(normalized.database_name.as_deref())
        .bind(normalized.schema_name.as_deref())
        .bind(&normalized.sql_text)
        .bind(normalized.sort_order)
        .bind(now_ms)
        .execute(pool)
        .await?;

        if result.rows_affected() == 0 {
            return Err(AppError::not_found(format!(
                "Saved query {} not found",
                normalized.id
            )));
        }

        Self::get(pool, &normalized.id)
            .await?
            .ok_or_else(|| AppError::not_found("Failed to load updated saved query"))
    }

    pub async fn delete(pool: &SqlitePool, id: &str) -> AppResult<bool> {
        let result = sqlx::query(
            r#"
            DELETE FROM saved_queries
            WHERE id = ?1
            "#,
        )
        .bind(id)
        .execute(pool)
        .await?;

        Ok(result.rows_affected() > 0)
    }
}

struct NormalizedCreateSavedQueryInput {
    id: String,
    profile_id: String,
    title: String,
    driver: String,
    database_name: Option<String>,
    schema_name: Option<String>,
    sql_text: String,
    sort_order: Option<i64>,
}

impl TryFrom<CreateSavedQueryInput> for NormalizedCreateSavedQueryInput {
    type Error = AppError;

    fn try_from(input: CreateSavedQueryInput) -> Result<Self, Self::Error> {
        let id = input.id.trim().to_string();
        let profile_id = input.profile_id.trim().to_string();
        let title = input.title.trim().to_string();
        let driver = input.driver.trim().to_string();
        let sql_text = input.sql_text.trim().to_string();

        if id.is_empty() {
            return Err(AppError::validation("Saved query id cannot be empty"));
        }
        if profile_id.is_empty() {
            return Err(AppError::validation(
                "Saved query profile id cannot be empty",
            ));
        }
        if driver.is_empty() {
            return Err(AppError::validation("Saved query driver cannot be empty"));
        }

        validate_saved_query_body(&title, &sql_text)?;

        Ok(Self {
            id,
            profile_id,
            title,
            driver,
            database_name: normalize_optional_text(input.database_name),
            schema_name: normalize_optional_text(input.schema_name),
            sql_text,
            sort_order: input.sort_order,
        })
    }
}

struct NormalizedUpdateSavedQueryInput {
    id: String,
    title: String,
    database_name: Option<String>,
    schema_name: Option<String>,
    sql_text: String,
    sort_order: Option<i64>,
}

impl TryFrom<UpdateSavedQueryInput> for NormalizedUpdateSavedQueryInput {
    type Error = AppError;

    fn try_from(input: UpdateSavedQueryInput) -> Result<Self, Self::Error> {
        let id = input.id.trim().to_string();
        let title = input.title.trim().to_string();
        let sql_text = input.sql_text.trim().to_string();

        if id.is_empty() {
            return Err(AppError::validation("Saved query id cannot be empty"));
        }

        validate_saved_query_body(&title, &sql_text)?;

        Ok(Self {
            id,
            title,
            database_name: normalize_optional_text(input.database_name),
            schema_name: normalize_optional_text(input.schema_name),
            sql_text,
            sort_order: input.sort_order,
        })
    }
}

fn validate_saved_query_body(title: &str, sql_text: &str) -> AppResult<()> {
    if title.is_empty() {
        return Err(AppError::validation("Saved query title cannot be empty"));
    }

    if sql_text.is_empty() {
        return Err(AppError::validation("Saved query SQL cannot be empty"));
    }

    Ok(())
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

async fn ensure_profile_driver_matches(
    pool: &SqlitePool,
    profile_id: &str,
    driver: &str,
) -> AppResult<()> {
    let connection_driver = sqlx::query_scalar::<_, String>(
        r#"
        SELECT driver
        FROM connections
        WHERE id = ?1
        "#,
    )
    .bind(profile_id)
    .fetch_optional(pool)
    .await?;

    let Some(connection_driver) = connection_driver else {
        return Err(AppError::validation(format!(
            "Saved query profile {} does not exist",
            profile_id
        )));
    };

    if driver != connection_driver {
        return Err(AppError::validation(format!(
            "Saved query driver {} does not match connection driver {}",
            driver, connection_driver
        )));
    }

    Ok(())
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::SqlitePool;

    use super::{CreateSavedQueryInput, SavedQueryRepository, UpdateSavedQueryInput};
    use crate::error::AppError;

    fn run_repository_test<F, Fut>(test: F)
    where
        F: FnOnce(SqlitePool) -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        tauri::async_runtime::block_on(async {
            let pool = create_test_pool().await;
            test(pool.clone()).await;
            pool.close().await;
        });
    }

    async fn create_test_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite memory options should parse")
            .foreign_keys(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("test sqlite pool should open");

        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .expect("foreign keys should be enabled");

        sqlx::query(
            r#"
            CREATE TABLE connections (
                id     TEXT PRIMARY KEY NOT NULL,
                driver TEXT NOT NULL
            )
            "#,
        )
        .execute(&pool)
        .await
        .expect("connections table should be created");

        sqlx::query(
            r#"
            CREATE TABLE saved_queries (
                id            TEXT PRIMARY KEY NOT NULL,
                profile_id    TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE ON UPDATE CASCADE,
                title         TEXT NOT NULL,
                driver        TEXT NOT NULL,
                database_name TEXT,
                schema_name   TEXT,
                sql_text      TEXT NOT NULL,
                created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
                updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
                sort_order    INTEGER
            )
            "#,
        )
        .execute(&pool)
        .await
        .expect("saved_queries table should be created");

        sqlx::query(
            r#"
            CREATE INDEX idx_saved_queries_profile_id
            ON saved_queries(profile_id, sort_order, updated_at)
            "#,
        )
        .execute(&pool)
        .await
        .expect("saved queries profile index should be created");

        sqlx::query("INSERT INTO connections (id, driver) VALUES ('profile-1', 'mysql')")
            .execute(&pool)
            .await
            .expect("fixture connection should be inserted");

        sqlx::query("INSERT INTO connections (id, driver) VALUES ('profile-2', 'postgres')")
            .execute(&pool)
            .await
            .expect("second fixture connection should be inserted");

        pool
    }

    fn create_input(id: &str) -> CreateSavedQueryInput {
        CreateSavedQueryInput {
            id: id.to_string(),
            profile_id: "profile-1".to_string(),
            title: "  First query  ".to_string(),
            driver: " mysql ".to_string(),
            database_name: Some(" app_db ".to_string()),
            schema_name: Some("   ".to_string()),
            sql_text: "  SELECT 1;  ".to_string(),
            sort_order: Some(2),
        }
    }

    fn update_input(id: &str) -> UpdateSavedQueryInput {
        UpdateSavedQueryInput {
            id: id.to_string(),
            title: "  Updated query  ".to_string(),
            database_name: Some("   ".to_string()),
            schema_name: Some(" public ".to_string()),
            sql_text: "  SELECT 2;  ".to_string(),
            sort_order: Some(1),
        }
    }

    #[test]
    fn creates_lists_updates_gets_and_deletes_saved_queries() {
        run_repository_test(|pool| async move {
            let first = SavedQueryRepository::create(&pool, create_input("query-1"))
                .await
                .expect("saved query should be created");

            assert_eq!(first.id, "query-1");
            assert_eq!(first.profile_id, "profile-1");
            assert_eq!(first.title, "First query");
            assert_eq!(first.driver, "mysql");
            assert_eq!(first.database_name.as_deref(), Some("app_db"));
            assert_eq!(first.schema_name, None);
            assert_eq!(first.sql_text, "SELECT 1;");
            assert_eq!(first.sort_order, Some(2));
            assert!(first.created_at > 0);
            assert!(first.updated_at > 0);

            let mut second_input = create_input("query-2");
            second_input.title = "Second query".to_string();
            second_input.sort_order = Some(1);
            SavedQueryRepository::create(&pool, second_input)
                .await
                .expect("second saved query should be created");

            let other_profile_input = CreateSavedQueryInput {
                id: "query-other".to_string(),
                profile_id: "profile-2".to_string(),
                title: "Other profile query".to_string(),
                driver: "postgres".to_string(),
                database_name: None,
                schema_name: None,
                sql_text: "SELECT 3;".to_string(),
                sort_order: Some(0),
            };
            SavedQueryRepository::create(&pool, other_profile_input)
                .await
                .expect("other profile query should be created");

            let list = SavedQueryRepository::list_by_profile(&pool, "profile-1")
                .await
                .expect("profile saved queries should list");
            assert_eq!(list.len(), 2);
            assert_eq!(list[0].id, "query-2");
            assert_eq!(list[1].id, "query-1");

            let loaded = SavedQueryRepository::get(&pool, "query-1")
                .await
                .expect("saved query should load")
                .expect("saved query should exist");
            assert_eq!(loaded.id, first.id);

            let updated = SavedQueryRepository::update(&pool, update_input("query-1"))
                .await
                .expect("saved query should update");

            assert_eq!(updated.title, "Updated query");
            assert_eq!(updated.database_name, None);
            assert_eq!(updated.schema_name.as_deref(), Some("public"));
            assert_eq!(updated.sql_text, "SELECT 2;");
            assert_eq!(updated.sort_order, Some(1));
            assert!(updated.updated_at > first.updated_at);

            let deleted = SavedQueryRepository::delete(&pool, "query-1")
                .await
                .expect("saved query should delete");
            assert!(deleted);

            let loaded_after_delete = SavedQueryRepository::get(&pool, "query-1")
                .await
                .expect("deleted query lookup should succeed");
            assert!(loaded_after_delete.is_none());

            let deleted_again = SavedQueryRepository::delete(&pool, "query-1")
                .await
                .expect("second delete should not fail");
            assert!(!deleted_again);
        });
    }

    #[test]
    fn rejects_blank_title_on_create_and_update() {
        run_repository_test(|pool| async move {
            let mut input = create_input("query-blank-title");
            input.title = "   ".to_string();

            let error = SavedQueryRepository::create(&pool, input)
                .await
                .expect_err("blank create title should fail");
            assert_validation_contains(error, "title cannot be empty");

            SavedQueryRepository::create(&pool, create_input("query-1"))
                .await
                .expect("saved query should be created");

            let mut update = update_input("query-1");
            update.title = "\t".to_string();

            let error = SavedQueryRepository::update(&pool, update)
                .await
                .expect_err("blank update title should fail");
            assert_validation_contains(error, "title cannot be empty");
        });
    }

    #[test]
    fn rejects_blank_sql_on_create_and_update() {
        run_repository_test(|pool| async move {
            let mut input = create_input("query-blank-sql");
            input.sql_text = "   ".to_string();

            let error = SavedQueryRepository::create(&pool, input)
                .await
                .expect_err("blank create SQL should fail");
            assert_validation_contains(error, "SQL cannot be empty");

            SavedQueryRepository::create(&pool, create_input("query-1"))
                .await
                .expect("saved query should be created");

            let mut update = update_input("query-1");
            update.sql_text = "\n".to_string();

            let error = SavedQueryRepository::update(&pool, update)
                .await
                .expect_err("blank update SQL should fail");
            assert_validation_contains(error, "SQL cannot be empty");
        });
    }

    #[test]
    fn rejects_missing_required_create_fields_and_missing_profile() {
        run_repository_test(|pool| async move {
            let mut blank_id = create_input("query-1");
            blank_id.id = " ".to_string();
            let error = SavedQueryRepository::create(&pool, blank_id)
                .await
                .expect_err("blank id should fail");
            assert_validation_contains(error, "id cannot be empty");

            let mut blank_profile = create_input("query-2");
            blank_profile.profile_id = " ".to_string();
            let error = SavedQueryRepository::create(&pool, blank_profile)
                .await
                .expect_err("blank profile id should fail");
            assert_validation_contains(error, "profile id cannot be empty");

            let mut blank_driver = create_input("query-3");
            blank_driver.driver = " ".to_string();
            let error = SavedQueryRepository::create(&pool, blank_driver)
                .await
                .expect_err("blank driver should fail");
            assert_validation_contains(error, "driver cannot be empty");

            let mut missing_profile = create_input("query-4");
            missing_profile.profile_id = "missing-profile".to_string();
            let error = SavedQueryRepository::create(&pool, missing_profile)
                .await
                .expect_err("missing profile should fail");
            assert_validation_contains(error, "profile missing-profile does not exist");
        });
    }

    #[test]
    fn rejects_driver_mismatch_for_owning_connection() {
        run_repository_test(|pool| async move {
            let mut input = create_input("query-driver-mismatch");
            input.driver = "postgres".to_string();

            let error = SavedQueryRepository::create(&pool, input)
                .await
                .expect_err("driver mismatch should fail");

            assert_validation_contains(error, "does not match connection driver");
        });
    }

    #[test]
    fn returns_not_found_when_updating_missing_query() {
        run_repository_test(|pool| async move {
            let error = SavedQueryRepository::update(&pool, update_input("missing-query"))
                .await
                .expect_err("missing update target should fail");

            assert!(
                matches!(error, AppError::NotFound(message) if message.contains("missing-query"))
            );
        });
    }

    #[test]
    fn deleting_connection_cascades_saved_queries() {
        run_repository_test(|pool| async move {
            SavedQueryRepository::create(&pool, create_input("query-1"))
                .await
                .expect("saved query should be created");

            sqlx::query("DELETE FROM connections WHERE id = 'profile-1'")
                .execute(&pool)
                .await
                .expect("connection should delete");

            let list = SavedQueryRepository::list_by_profile(&pool, "profile-1")
                .await
                .expect("list after cascade should succeed");
            assert!(list.is_empty());

            let loaded = SavedQueryRepository::get(&pool, "query-1")
                .await
                .expect("get after cascade should succeed");
            assert!(loaded.is_none());
        });
    }

    fn assert_validation_contains(error: AppError, expected: &str) {
        assert!(
            matches!(error, AppError::Validation(message) if message.contains(expected)),
            "expected validation error containing {expected:?}"
        );
    }
}
