use std::sync::Arc;

use crate::engine::driver::DatabaseDriver;
use crate::engine::drivers::{
    clickhouse::ClickHouseDriver, mysql::MysqlDriver, oracle::OracleDriver,
    postgres::PostgresDriver, redis::RedisDriver, sqlite::SqliteDriver,
};
use crate::engine::profiles::{driver_profile_from_record, DriverProfile};
use crate::error::IpcResult;
use crate::repository::connection_repository::StoredConnectionRecord;

pub struct DriverRegistry;

impl DriverRegistry {
    pub async fn create_driver(
        profile_id: &str,
        record: &StoredConnectionRecord,
    ) -> IpcResult<Arc<dyn DatabaseDriver>> {
        Self::create_driver_from_profile(profile_id, driver_profile_from_record(record)?).await
    }

    pub async fn create_tab_driver(
        profile_id: &str,
        owner_tab_runtime_id: &str,
        record: &StoredConnectionRecord,
    ) -> IpcResult<Arc<dyn DatabaseDriver>> {
        match driver_profile_from_record(record)? {
            DriverProfile::Clickhouse(profile) => {
                ClickHouseDriver::connect_for_tab(
                    profile_id.to_string(),
                    profile,
                    owner_tab_runtime_id.to_string(),
                )
                .await
            }
            profile => Self::create_driver_from_profile(profile_id, profile).await,
        }
    }

    pub async fn create_driver_from_profile(
        profile_id: &str,
        profile: DriverProfile,
    ) -> IpcResult<Arc<dyn DatabaseDriver>> {
        match profile {
            DriverProfile::Clickhouse(profile) => {
                ClickHouseDriver::connect(profile_id.to_string(), profile).await
            }
            DriverProfile::Mysql(profile) => Ok(Arc::new(
                MysqlDriver::connect(profile_id.to_string(), profile).await?,
            )),
            DriverProfile::Postgres(profile) => Ok(Arc::new(
                PostgresDriver::connect(profile_id.to_string(), profile).await?,
            )),
            DriverProfile::Oracle(profile) => Ok(Arc::new(
                OracleDriver::connect(profile_id.to_string(), profile).await?,
            )),
            DriverProfile::Redis(profile) => Ok(Arc::new(
                RedisDriver::connect(profile_id.to_string(), profile).await?,
            )),
            DriverProfile::Sqlite(profile) => Ok(Arc::new(
                SqliteDriver::connect(profile_id.to_string(), profile).await?,
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::profiles::{ClickHouseProfile, ClickHouseProtocol};
    use crate::error::ErrorCode;

    #[test]
    fn clickhouse_profile_registry_dispatches_without_network_for_invalid_host() {
        tauri::async_runtime::block_on(async {
            let result = DriverRegistry::create_driver_from_profile(
                "clickhouse-invalid",
                DriverProfile::Clickhouse(ClickHouseProfile {
                    host: " ".to_string(),
                    port: 8123,
                    username: "default".to_string(),
                    password: String::new(),
                    default_database: None,
                    protocol: ClickHouseProtocol::Http,
                    connect_timeout_seconds: Some(5),
                    ssh_tunnel: None,
                }),
            )
            .await;
            let error = match result {
                Ok(_) => panic!("blank ClickHouse host should fail before network access"),
                Err(error) => error,
            };

            assert_eq!(error.code, ErrorCode::ValidationFailed);
        });
    }
}
