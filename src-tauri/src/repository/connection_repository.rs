use std::str::FromStr;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, SqlitePool};

use crate::error::{AppError, AppResult};

// ─── ConnectionDriver ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionDriver {
    // 关系型
    Mysql,
    Postgres,
    Sqlite,
    Oracle,
    SqlServer,
    Clickhouse,
    // 键值 / 文档 / 搜索
    Redis,
    Mongodb,
    Elasticsearch,
    // 向量型
    Chroma,
    Milvus,
    Qdrant,
    Pinecone,
    Weaviate,
    // 图型
    Neo4j,
    Neptune,
    Arangodb,
}

impl ConnectionDriver {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Mysql => "mysql",
            Self::Postgres => "postgres",
            Self::Sqlite => "sqlite",
            Self::Oracle => "oracle",
            Self::SqlServer => "sqlserver",
            Self::Clickhouse => "clickhouse",
            Self::Redis => "redis",
            Self::Mongodb => "mongodb",
            Self::Elasticsearch => "elasticsearch",
            Self::Chroma => "chroma",
            Self::Milvus => "milvus",
            Self::Qdrant => "qdrant",
            Self::Pinecone => "pinecone",
            Self::Weaviate => "weaviate",
            Self::Neo4j => "neo4j",
            Self::Neptune => "neptune",
            Self::Arangodb => "arangodb",
        }
    }
}

impl FromStr for ConnectionDriver {
    type Err = AppError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "mysql" => Ok(Self::Mysql),
            "postgres" => Ok(Self::Postgres),
            "sqlite" => Ok(Self::Sqlite),
            "oracle" => Ok(Self::Oracle),
            "sqlserver" => Ok(Self::SqlServer),
            "clickhouse" => Ok(Self::Clickhouse),
            "redis" => Ok(Self::Redis),
            "mongodb" => Ok(Self::Mongodb),
            "elasticsearch" => Ok(Self::Elasticsearch),
            "chroma" => Ok(Self::Chroma),
            "milvus" => Ok(Self::Milvus),
            "qdrant" => Ok(Self::Qdrant),
            "pinecone" => Ok(Self::Pinecone),
            "weaviate" => Ok(Self::Weaviate),
            "neo4j" => Ok(Self::Neo4j),
            "neptune" => Ok(Self::Neptune),
            "arangodb" => Ok(Self::Arangodb),
            _ => Err(AppError::validation(format!(
                "Unsupported connection driver: {value}"
            ))),
        }
    }
}

// ─── ConnectionRecordStatus ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionRecordStatus {
    Connected,
    Disconnected,
    Unknown,
}

impl FromStr for ConnectionRecordStatus {
    type Err = AppError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "connected" => Ok(Self::Connected),
            "disconnected" => Ok(Self::Disconnected),
            "unknown" => Ok(Self::Unknown),
            _ => Err(AppError::validation(format!(
                "Unsupported connection record status: {value}"
            ))),
        }
    }
}

// ─── Public domain structs ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredConnectionRecord {
    pub id: String,
    pub name: String,
    pub driver: ConnectionDriver,
    pub environment: String,
    pub color: Option<String>,
    pub tag_label: String,
    pub tag_color: Option<String>,
    pub payload: Value,
    pub folder_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_connected_at: Option<i64>,
    pub last_connection_status: Option<ConnectionRecordStatus>,
    pub last_connection_error: Option<String>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateConnectionInput {
    pub id: String,
    pub name: String,
    pub driver: ConnectionDriver,
    pub environment: String,
    pub color: Option<String>,
    pub tag_label: String,
    pub tag_color: Option<String>,
    pub payload: Value,
    pub folder_id: Option<String>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConnectionInput {
    pub id: String,
    pub name: String,
    pub driver: ConnectionDriver,
    pub environment: String,
    pub color: Option<String>,
    pub tag_label: String,
    pub tag_color: Option<String>,
    pub payload: Value,
    pub folder_id: Option<String>,
    pub sort_order: Option<i64>,
}

// ─── Internal row struct ──────────────────────────────────────────────────────

#[derive(Debug, Clone, FromRow)]
struct ConnectionRecordRow {
    id: String,
    name: String,
    driver: String,
    environment: String,
    color: Option<String>,
    tag_label: String,
    tag_color: Option<String>,
    payload: String,
    folder_id: Option<String>,
    created_at: i64,
    updated_at: i64,
    last_connected_at: Option<i64>,
    last_connection_status: Option<String>,
    last_connection_error: Option<String>,
    sort_order: Option<i64>,
}

impl TryFrom<ConnectionRecordRow> for StoredConnectionRecord {
    type Error = AppError;

    fn try_from(row: ConnectionRecordRow) -> Result<Self, Self::Error> {
        Ok(Self {
            id: row.id,
            name: row.name,
            driver: ConnectionDriver::from_str(&row.driver)?,
            environment: row.environment,
            color: row.color,
            tag_label: row.tag_label,
            tag_color: row.tag_color,
            payload: serde_json::from_str(&row.payload)?,
            folder_id: row.folder_id,
            created_at: row.created_at,
            updated_at: row.updated_at,
            last_connected_at: row.last_connected_at,
            last_connection_status: row
                .last_connection_status
                .map(|v| ConnectionRecordStatus::from_str(&v))
                .transpose()?,
            last_connection_error: row.last_connection_error,
            sort_order: row.sort_order,
        })
    }
}

// ─── Repository ───────────────────────────────────────────────────────────────

pub struct ConnectionRepository;

impl ConnectionRepository {
    pub async fn list(pool: &SqlitePool) -> AppResult<Vec<StoredConnectionRecord>> {
        let rows = sqlx::query_as::<_, ConnectionRecordRow>(
            r#"
            SELECT
                id, name, driver, environment, color, tag_label, tag_color, payload,
                folder_id, created_at, updated_at,
                last_connected_at, last_connection_status, last_connection_error,
                sort_order
            FROM connections
            ORDER BY sort_order IS NULL, sort_order ASC, created_at ASC
            "#,
        )
        .fetch_all(pool)
        .await?;

        rows.into_iter().map(TryInto::try_into).collect()
    }

    pub async fn get(pool: &SqlitePool, id: &str) -> AppResult<Option<StoredConnectionRecord>> {
        let row = sqlx::query_as::<_, ConnectionRecordRow>(
            r#"
            SELECT
                id, name, driver, environment, color, tag_label, tag_color, payload,
                folder_id, created_at, updated_at,
                last_connected_at, last_connection_status, last_connection_error,
                sort_order
            FROM connections
            WHERE id = ?1
            "#,
        )
        .bind(id)
        .fetch_optional(pool)
        .await?;

        row.map(TryInto::try_into).transpose()
    }

    pub async fn create(
        pool: &SqlitePool,
        input: CreateConnectionInput,
    ) -> AppResult<StoredConnectionRecord> {
        validate_connection_payload(&input.id, &input.name, &input.payload)?;
        ensure_folder_exists(pool, input.folder_id.as_deref()).await?;
        let (tag_label, tag_color) =
            normalize_connection_tag(&input.tag_label, input.tag_color.as_deref())?;

        let payload_json = serde_json::to_string(&input.payload)?;
        let now_ms = now_unix_ms();

        sqlx::query(
            r#"
            INSERT INTO connections (
                id, name, driver, environment, color, tag_label, tag_color, payload,
                folder_id, created_at, updated_at, sort_order
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11)
            "#,
        )
        .bind(&input.id)
        .bind(&input.name)
        .bind(input.driver.as_str())
        .bind(&input.environment)
        .bind(input.color.as_deref())
        .bind(&tag_label)
        .bind(tag_color.as_deref())
        .bind(&payload_json)
        .bind(input.folder_id.as_deref())
        .bind(now_ms)
        .bind(input.sort_order)
        .execute(pool)
        .await?;

        Self::get(pool, &input.id)
            .await?
            .ok_or_else(|| AppError::not_found("Failed to load created connection"))
    }

    pub async fn update(
        pool: &SqlitePool,
        input: UpdateConnectionInput,
    ) -> AppResult<StoredConnectionRecord> {
        validate_connection_payload(&input.id, &input.name, &input.payload)?;
        ensure_folder_exists(pool, input.folder_id.as_deref()).await?;
        let (tag_label, tag_color) =
            normalize_connection_tag(&input.tag_label, input.tag_color.as_deref())?;

        let payload_json = serde_json::to_string(&input.payload)?;
        let now_ms = now_unix_ms();

        let result = sqlx::query(
            r#"
            UPDATE connections
            SET
                name        = ?2,
                driver      = ?3,
                environment = ?4,
                color       = ?5,
                tag_label   = ?6,
                tag_color   = ?7,
                payload     = ?8,
                folder_id   = ?9,
                sort_order  = ?10,
                updated_at  = ?11
            WHERE id = ?1
            "#,
        )
        .bind(&input.id)
        .bind(&input.name)
        .bind(input.driver.as_str())
        .bind(&input.environment)
        .bind(input.color.as_deref())
        .bind(&tag_label)
        .bind(tag_color.as_deref())
        .bind(&payload_json)
        .bind(input.folder_id.as_deref())
        .bind(input.sort_order)
        .bind(now_ms)
        .execute(pool)
        .await?;

        if result.rows_affected() == 0 {
            return Err(AppError::not_found(format!(
                "Connection {} not found",
                input.id
            )));
        }

        Self::get(pool, &input.id)
            .await?
            .ok_or_else(|| AppError::not_found("Failed to load updated connection"))
    }

    pub async fn delete(pool: &SqlitePool, id: &str) -> AppResult<bool> {
        let result = sqlx::query(
            r#"
            DELETE FROM connections
            WHERE id = ?1
            "#,
        )
        .bind(id)
        .execute(pool)
        .await?;

        Ok(result.rows_affected() > 0)
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn validate_connection_payload(id: &str, name: &str, payload: &Value) -> AppResult<()> {
    if id.trim().is_empty() {
        return Err(AppError::validation("Connection id cannot be empty"));
    }
    if name.trim().is_empty() {
        return Err(AppError::validation("Connection name cannot be empty"));
    }
    if !payload.is_object() {
        return Err(AppError::validation(
            "Connection payload must be a JSON object",
        ));
    }
    Ok(())
}

const CONNECTION_TAG_LABEL_MAX_CHARS: usize = 8;
const CONNECTION_TAG_COLORS: &[&str] = &[
    "slate", "red", "orange", "amber", "emerald", "teal", "sky", "violet", "pink",
];

fn normalize_connection_tag_label(value: &str) -> AppResult<String> {
    let trimmed = value.trim();
    if trimmed.chars().count() > CONNECTION_TAG_LABEL_MAX_CHARS {
        return Err(AppError::validation(format!(
            "Connection tag label must be at most {CONNECTION_TAG_LABEL_MAX_CHARS} characters"
        )));
    }
    Ok(trimmed.to_string())
}

fn normalize_connection_tag_color(value: Option<&str>) -> AppResult<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };

    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    if CONNECTION_TAG_COLORS.contains(&trimmed) {
        return Ok(Some(trimmed.to_string()));
    }

    Err(AppError::validation(format!(
        "Connection tag color must be one of: {}",
        CONNECTION_TAG_COLORS.join(", ")
    )))
}

fn normalize_connection_tag(
    label: &str,
    color: Option<&str>,
) -> AppResult<(String, Option<String>)> {
    let normalized_label = normalize_connection_tag_label(label)?;
    let normalized_color = normalize_connection_tag_color(color)?;

    if !normalized_label.is_empty() && normalized_color.is_none() {
        return Err(AppError::validation(
            "Connection tag color is required when tag label is set",
        ));
    }

    Ok((normalized_label, normalized_color))
}

async fn ensure_folder_exists(pool: &SqlitePool, folder_id: Option<&str>) -> AppResult<()> {
    let Some(folder_id) = folder_id else {
        return Ok(());
    };

    if folder_id.trim().is_empty() {
        return Err(AppError::validation("Connection folder id cannot be empty"));
    }

    let folder_exists = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(1)
        FROM connection_folders
        WHERE id = ?1
        "#,
    )
    .bind(folder_id)
    .fetch_one(pool)
    .await?;

    if folder_exists == 0 {
        return Err(AppError::validation(format!(
            "Connection folder {} does not exist",
            folder_id
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::SqlitePool;

    use super::{
        ConnectionDriver, ConnectionRepository, CreateConnectionInput, UpdateConnectionInput,
    };

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
            CREATE TABLE connection_folders (
                id         TEXT PRIMARY KEY NOT NULL,
                name       TEXT NOT NULL,
                parent_id  TEXT,
                created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
                sort_order INTEGER,
                FOREIGN KEY (parent_id) REFERENCES connection_folders(id) ON DELETE RESTRICT ON UPDATE CASCADE
            )
            "#,
        )
        .execute(&pool)
        .await
        .expect("connection folders table should be created");

        sqlx::query(
            r#"
            CREATE TABLE connections (
                id          TEXT PRIMARY KEY NOT NULL,
                name        TEXT NOT NULL,
                driver      TEXT NOT NULL,
                environment TEXT NOT NULL DEFAULT 'development',
                color       TEXT,
                tag_label   TEXT NOT NULL DEFAULT '',
                tag_color   TEXT,
                payload     TEXT NOT NULL,
                created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
                updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
                last_connected_at      INTEGER,
                last_connection_status TEXT CHECK (last_connection_status IN ('connected', 'disconnected', 'unknown')),
                last_connection_error  TEXT,
                sort_order  INTEGER,
                folder_id   TEXT REFERENCES connection_folders(id) ON DELETE RESTRICT ON UPDATE CASCADE
            )
            "#,
        )
        .execute(&pool)
        .await
        .expect("connections table should be created");

        pool
    }

    fn create_input(id: &str) -> CreateConnectionInput {
        CreateConnectionInput {
            id: id.to_string(),
            name: "  Local MySQL  ".to_string(),
            driver: ConnectionDriver::Mysql,
            environment: "development".to_string(),
            color: None,
            tag_label: "  Dev  ".to_string(),
            tag_color: Some("sky".to_string()),
            payload: json!({ "host": "127.0.0.1", "port": 3306 }),
            folder_id: None,
            sort_order: Some(1),
        }
    }

    #[test]
    fn connection_driver_clickhouse_round_trips() {
        let driver = ConnectionDriver::from_str("clickhouse")
            .expect("clickhouse driver string should parse");

        assert_eq!(driver.as_str(), "clickhouse");
        assert_eq!(
            serde_json::to_value(driver).expect("serialize clickhouse driver"),
            "clickhouse"
        );
    }

    #[test]
    fn create_connection_persists_normalized_tag_metadata() {
        run_repository_test(|pool| async move {
            let record = ConnectionRepository::create(&pool, create_input("profile-1"))
                .await
                .expect("connection should be created");

            assert_eq!(record.tag_label, "Dev");
            assert_eq!(record.tag_color.as_deref(), Some("sky"));

            let listed = ConnectionRepository::list(&pool)
                .await
                .expect("connections should list");

            assert_eq!(listed[0].tag_label, "Dev");
            assert_eq!(listed[0].tag_color.as_deref(), Some("sky"));
        });
    }

    #[test]
    fn create_connection_accepts_color_only_tag() {
        run_repository_test(|pool| async move {
            let mut input = create_input("profile-1");
            input.tag_label = "   ".to_string();
            input.tag_color = Some("emerald".to_string());

            let record = ConnectionRepository::create(&pool, input)
                .await
                .expect("color-only tag should be valid");

            assert_eq!(record.tag_label, "");
            assert_eq!(record.tag_color.as_deref(), Some("emerald"));
        });
    }

    #[test]
    fn update_connection_can_clear_tag_metadata() {
        run_repository_test(|pool| async move {
            let created = ConnectionRepository::create(&pool, create_input("profile-1"))
                .await
                .expect("connection should be created");

            let updated = ConnectionRepository::update(
                &pool,
                UpdateConnectionInput {
                    id: created.id,
                    name: created.name,
                    driver: created.driver,
                    environment: created.environment,
                    color: created.color,
                    tag_label: " ".to_string(),
                    tag_color: None,
                    payload: created.payload,
                    folder_id: created.folder_id,
                    sort_order: created.sort_order,
                },
            )
            .await
            .expect("connection should update");

            assert_eq!(updated.tag_label, "");
            assert_eq!(updated.tag_color, None);
        });
    }

    #[test]
    fn rejects_invalid_connection_tag_metadata() {
        run_repository_test(|pool| async move {
            let mut too_long = create_input("profile-1");
            too_long.tag_label = "九个字符标签文本超".to_string();

            let error = ConnectionRepository::create(&pool, too_long)
                .await
                .expect_err("too-long tag label should be rejected");

            assert!(
                error.to_string().contains("Connection tag label"),
                "unexpected error: {error}"
            );

            let mut invalid_color = create_input("profile-2");
            invalid_color.tag_color = Some("#ff0000".to_string());

            let error = ConnectionRepository::create(&pool, invalid_color)
                .await
                .expect_err("invalid tag color should be rejected");

            assert!(
                error.to_string().contains("Connection tag color"),
                "unexpected error: {error}"
            );

            let mut missing_color = create_input("profile-3");
            missing_color.tag_color = None;

            let error = ConnectionRepository::create(&pool, missing_color)
                .await
                .expect_err("label without color should be rejected");

            assert!(
                error.to_string().contains("Connection tag color"),
                "unexpected error: {error}"
            );
        });
    }
}
