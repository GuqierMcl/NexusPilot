use crate::engine::driver::DatabaseDriver;
use crate::engine::drivers::redis::RedisDriver;
use crate::engine::profiles::RedisProfile;
use crate::engine::types::{
    RedisCreateKeyValueRequest, RedisDeleteKeyRequest, RedisEditableValue, RedisHashEntry,
    RedisKeyRef, RedisKeyTreeRequest, RedisRenameKeyRequest, RedisScanRequest, RedisSetKeyTtlMode,
    RedisSetKeyTtlRequest, RedisSetKeyValueRequest, RedisStreamEntry, RedisTtlPolicy, RedisValue,
};
use crate::error::ErrorCode;

use super::common::{run_async, TestEnv};

#[test]
fn real_redis_read_only_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !env.enabled("NEXPILOT_TEST_REDIS_ENABLED") {
            return;
        }

        let db_index = env.u8_or("NEXPILOT_TEST_REDIS_DB_INDEX", 0);
        let profile = RedisProfile {
            host: env.required("NEXPILOT_TEST_REDIS_HOST"),
            port: env.u16_or("NEXPILOT_TEST_REDIS_PORT", 6379),
            username: env.optional("NEXPILOT_TEST_REDIS_USERNAME"),
            password: env
                .optional("NEXPILOT_TEST_REDIS_PASSWORD")
                .unwrap_or_default(),
            db_index: Some(db_index),
            use_tls: env.bool_or("NEXPILOT_TEST_REDIS_USE_TLS", false),
            connect_timeout_seconds: Some(env.u64_or("NEXPILOT_TEST_CONNECT_TIMEOUT_SECONDS", 10)),
            ssh_tunnel: None,
        };

        let driver = RedisDriver::connect("real-redis-smoke".to_string(), profile)
            .await
            .expect("Redis real smoke should connect");
        driver.ping().await.expect("Redis real smoke should ping");
        driver
            .as_schema_browser()
            .expect("Redis schema browser")
            .list_containers(None)
            .await
            .expect("Redis real smoke should list database containers");
        let key_value = driver.as_key_value_browser().expect("Redis key browser");
        key_value
            .scan_key_values(&RedisScanRequest {
                db_index,
                pattern: "*".to_string(),
                cursor: 0,
                count: 10,
            })
            .await
            .expect("Redis real smoke should scan keys");
        key_value
            .browse_key_tree(&RedisKeyTreeRequest {
                db_index,
                pattern: "*".to_string(),
                count: 10,
            })
            .await
            .expect("Redis real smoke should browse key tree");

        driver.close().await.expect("close Redis smoke driver");
    });
}

#[test]
fn real_redis_atomic_mutation_and_stale_precondition_smoke() {
    run_async(async {
        let Some(env) = TestEnv::load() else {
            return;
        };
        if !env.enabled("NEXPILOT_TEST_REDIS_ENABLED")
            || !env.bool_or("NEXPILOT_TEST_ALLOW_WRITES", false)
        {
            return;
        }

        let db_index = env.u8_or("NEXPILOT_TEST_REDIS_DB_INDEX", 0);
        let profile = RedisProfile {
            host: env.required("NEXPILOT_TEST_REDIS_HOST"),
            port: env.u16_or("NEXPILOT_TEST_REDIS_PORT", 6379),
            username: env.optional("NEXPILOT_TEST_REDIS_USERNAME"),
            password: env
                .optional("NEXPILOT_TEST_REDIS_PASSWORD")
                .unwrap_or_default(),
            db_index: Some(db_index),
            use_tls: env.bool_or("NEXPILOT_TEST_REDIS_USE_TLS", false),
            connect_timeout_seconds: Some(env.u64_or("NEXPILOT_TEST_CONNECT_TIMEOUT_SECONDS", 10)),
            ssh_tunnel: None,
        };
        let driver = RedisDriver::connect("real-redis-mutation-smoke".to_string(), profile)
            .await
            .expect("Redis mutation smoke should connect");
        let key_value = driver.as_key_value_browser().expect("Redis key browser");
        let suffix = uuid::Uuid::new_v4();
        let source_key = format!("nexuspilot:mutation-smoke:{suffix}:source");
        let renamed_key = format!("nexuspilot:mutation-smoke:{suffix}:renamed");
        let destination_key = format!("nexuspilot:mutation-smoke:{suffix}:destination");

        let created = key_value
            .create_key_value(&RedisCreateKeyValueRequest {
                db_index,
                key: source_key.clone(),
                value: RedisEditableValue::String("original".to_string()),
                ttl_policy: Some(RedisTtlPolicy::Persist),
                ttl_seconds: None,
            })
            .await
            .expect("create should atomically publish a new key");
        let duplicate = key_value
            .create_key_value(&RedisCreateKeyValueRequest {
                db_index,
                key: source_key.clone(),
                value: RedisEditableValue::String("must-not-overwrite".to_string()),
                ttl_policy: Some(RedisTtlPolicy::Persist),
                ttl_seconds: None,
            })
            .await
            .expect_err("concurrent-style duplicate create must not overwrite");
        assert_eq!(duplicate.code, ErrorCode::ResourceConflict);

        let replaced = key_value
            .set_key_value(&RedisSetKeyValueRequest {
                db_index,
                key: source_key.clone(),
                value: RedisEditableValue::String("current".to_string()),
                expected_fingerprint: created.fingerprint.clone(),
                expected_type: Some("string".to_string()),
                ttl_policy: Some(RedisTtlPolicy::Keep),
                ttl_seconds: None,
            })
            .await
            .expect("replacement should atomically switch the temporary key");
        let stale_set = key_value
            .set_key_value(&RedisSetKeyValueRequest {
                db_index,
                key: source_key.clone(),
                value: RedisEditableValue::String("stale-overwrite".to_string()),
                expected_fingerprint: created.fingerprint,
                expected_type: Some("string".to_string()),
                ttl_policy: Some(RedisTtlPolicy::Keep),
                ttl_seconds: None,
            })
            .await
            .expect_err("stale replacement must fail closed");
        assert_eq!(stale_set.code, ErrorCode::ResourceConflict);

        let partial_build = key_value
            .set_key_value(&RedisSetKeyValueRequest {
                db_index,
                key: source_key.clone(),
                value: RedisEditableValue::Stream(vec![
                    RedisStreamEntry {
                        id: "1-0".to_string(),
                        fields: vec![RedisHashEntry {
                            field: "field".to_string(),
                            value: "one".to_string(),
                        }],
                    },
                    RedisStreamEntry {
                        id: "1-0".to_string(),
                        fields: vec![RedisHashEntry {
                            field: "field".to_string(),
                            value: "duplicate".to_string(),
                        }],
                    },
                ]),
                expected_fingerprint: replaced.fingerprint.clone(),
                expected_type: Some("string".to_string()),
                ttl_policy: Some(RedisTtlPolicy::Keep),
                ttl_seconds: None,
            })
            .await
            .expect_err("failed temporary construction must not touch the target key");
        assert_eq!(
            partial_build.runtime_impact,
            crate::error::RuntimeErrorImpact::BusinessOnly
        );
        let after_failure = key_value
            .get_key_value(&RedisKeyRef {
                db_index,
                key: source_key.clone(),
            })
            .await
            .expect("target must survive temporary construction failure");
        assert_eq!(after_failure.fingerprint, replaced.fingerprint);
        assert!(matches!(
            after_failure.value,
            RedisValue::String(crate::engine::types::RedisStringValue::Utf8 {
                value: Some(ref value)
            }) if value == "current"
        ));

        let renamed = key_value
            .rename_key(&RedisRenameKeyRequest {
                db_index,
                key: source_key.clone(),
                new_key: renamed_key.clone(),
                expected_fingerprint: replaced.fingerprint,
            })
            .await
            .expect("rename should bind source and absent destination");
        key_value
            .create_key_value(&RedisCreateKeyValueRequest {
                db_index,
                key: destination_key.clone(),
                value: RedisEditableValue::String("occupied".to_string()),
                ttl_policy: Some(RedisTtlPolicy::Persist),
                ttl_seconds: None,
            })
            .await
            .expect("destination fixture should be created");
        let occupied_rename = key_value
            .rename_key(&RedisRenameKeyRequest {
                db_index,
                key: renamed_key.clone(),
                new_key: destination_key.clone(),
                expected_fingerprint: renamed.fingerprint.clone(),
            })
            .await
            .expect_err("rename must not overwrite an occupied destination");
        assert_eq!(occupied_rename.code, ErrorCode::ResourceConflict);

        let ttl = key_value
            .set_key_ttl(&RedisSetKeyTtlRequest {
                db_index,
                key: renamed_key.clone(),
                expected_fingerprint: renamed.fingerprint.clone(),
                mode: RedisSetKeyTtlMode::Expire,
                ttl_seconds: Some(300),
            })
            .await
            .expect("ttl change should use the same value fingerprint");
        assert_eq!(ttl.fingerprint, renamed.fingerprint);
        let stale_delete = key_value
            .delete_key(&RedisDeleteKeyRequest {
                db_index,
                key: renamed_key.clone(),
                expected_fingerprint:
                    "sha256:0000000000000000000000000000000000000000000000000000000000000000"
                        .to_string(),
            })
            .await
            .expect_err("stale delete must not remove the key");
        assert_eq!(stale_delete.code, ErrorCode::ResourceConflict);

        key_value
            .delete_key(&RedisDeleteKeyRequest {
                db_index,
                key: renamed_key,
                expected_fingerprint: ttl.fingerprint,
            })
            .await
            .expect("exact source key should be deleted");
        let destination = key_value
            .get_key_value(&RedisKeyRef {
                db_index,
                key: destination_key.clone(),
            })
            .await
            .expect("occupied destination must remain intact");
        key_value
            .delete_key(&RedisDeleteKeyRequest {
                db_index,
                key: destination_key,
                expected_fingerprint: destination.fingerprint,
            })
            .await
            .expect("destination fixture should be cleaned up");

        driver.close().await.expect("close Redis mutation driver");
    });
}
