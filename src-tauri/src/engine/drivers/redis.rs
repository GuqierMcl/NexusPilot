use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt::Write;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use redis::AsyncCommands;
use sha2::{Digest, Sha256};

use super::redis_validate::*;
use crate::engine::driver::{DatabaseDriver, KeyValueBrowser, SchemaBrowser};
use crate::engine::drivers::common::classify_redis_error;
use crate::engine::profiles::RedisProfile;
use crate::engine::ssh_tunnel::{self, SshTunnelRuntime};
use crate::engine::types::{
    ContainerKind, ContainerRef, DataContainer, DriverCapabilities, PingResult,
    RedisCreateKeyValueRequest, RedisDeleteKeyPrefixRequest, RedisDeleteKeyRequest,
    RedisDeleteKeyResult, RedisEditableValue, RedisHashEntry, RedisKeyInfo, RedisKeyMutationResult,
    RedisKeyPrecondition, RedisKeyRef, RedisKeyTreeNode, RedisKeyTreeNodeKind, RedisKeyTreeRequest,
    RedisKeyTreeResult, RedisKeyValue, RedisRenameKeyRequest, RedisScanRequest, RedisScanResult,
    RedisSetKeyTtlMode, RedisSetKeyTtlRequest, RedisSetKeyValueRequest, RedisSortedSetEntry,
    RedisStreamEntry, RedisStringValue, RedisTtlPolicy, RedisValue,
};
use crate::error::{IpcError, IpcResult};

const DELETE_SCAN_COUNT: u32 = 1000;
const DELETE_BATCH_SIZE: usize = 500;
const TEMPORARY_KEY_TTL_MS: u64 = 5 * 60 * 1000;
const TEMPORARY_KEY_PREFIX: &str = "__nexuspilot:kvtmp:";

pub struct RedisDriver {
    profile_id: String,
    profile: RedisProfile,
    client: redis::Client,
    _tunnel: Option<SshTunnelRuntime>,
}

#[derive(Debug)]
struct MutableKeyTreeNode {
    id: String,
    label: String,
    node_type: RedisKeyTreeNodeKind,
    prefix: Option<String>,
    pattern: Option<String>,
    key: Option<String>,
    key_count: u64,
    value_type: Option<String>,
    children: Vec<MutableKeyTreeNode>,
    child_map: BTreeMap<String, usize>,
}

impl MutableKeyTreeNode {
    fn prefix(prefix: String, label: String) -> Self {
        Self {
            id: format!("prefix:{prefix}"),
            label,
            node_type: RedisKeyTreeNodeKind::Prefix,
            prefix: Some(prefix.clone()),
            pattern: Some(format!("{prefix}*")),
            key: None,
            key_count: 0,
            value_type: None,
            children: Vec::new(),
            child_map: BTreeMap::new(),
        }
    }

    fn key(key: String, label: String, value_type: Option<String>) -> Self {
        Self {
            id: format!("key:{key}"),
            label,
            node_type: RedisKeyTreeNodeKind::Key,
            prefix: None,
            pattern: None,
            key: Some(key),
            key_count: 1,
            value_type,
            children: Vec::new(),
            child_map: BTreeMap::new(),
        }
    }

    fn into_tree_node(mut self) -> RedisKeyTreeNode {
        let mut children = self
            .children
            .drain(..)
            .map(MutableKeyTreeNode::into_tree_node)
            .collect::<Vec<_>>();
        sort_key_tree_nodes(&mut children);

        RedisKeyTreeNode {
            id: self.id,
            label: self.label,
            node_type: self.node_type,
            prefix: self.prefix,
            pattern: self.pattern,
            key: self.key,
            key_count: self.key_count,
            value_type: self.value_type,
            children,
        }
    }
}

fn sort_key_tree_nodes(nodes: &mut [RedisKeyTreeNode]) {
    nodes.sort_by(|left, right| {
        let left_is_prefix = left.node_type == RedisKeyTreeNodeKind::Prefix;
        let right_is_prefix = right.node_type == RedisKeyTreeNodeKind::Prefix;

        right_is_prefix
            .cmp(&left_is_prefix)
            .then_with(|| left.label.cmp(&right.label))
            .then_with(|| left.id.cmp(&right.id))
    });
}

fn get_or_create_prefix<'a>(
    siblings: &'a mut Vec<MutableKeyTreeNode>,
    sibling_map: &mut BTreeMap<String, usize>,
    prefix: String,
    label: String,
) -> &'a mut MutableKeyTreeNode {
    let index = if let Some(index) = sibling_map.get(&prefix).copied() {
        index
    } else {
        let index = siblings.len();
        siblings.push(MutableKeyTreeNode::prefix(prefix.clone(), label));
        sibling_map.insert(prefix, index);
        index
    };

    &mut siblings[index]
}

fn key_segment_label(segment: &str) -> String {
    if segment.is_empty() {
        "(empty)".to_string()
    } else {
        segment.to_string()
    }
}

fn bytes_to_hex_preview(bytes: &[u8], max_bytes: usize) -> String {
    bytes
        .iter()
        .take(max_bytes)
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}

fn editable_value_type(value: &RedisEditableValue) -> &'static str {
    match value {
        RedisEditableValue::String(_) => "string",
        RedisEditableValue::Json(_) => "json",
        RedisEditableValue::Hash(_) => "hash",
        RedisEditableValue::List(_) => "list",
        RedisEditableValue::Set(_) => "set",
        RedisEditableValue::SortedSet(_) => "zset",
        RedisEditableValue::Stream(_) => "stream",
    }
}

fn normalize_redis_type(value_type: &str) -> &str {
    if value_type.eq_ignore_ascii_case("json") || value_type.eq_ignore_ascii_case("rejson-rl") {
        "json"
    } else if value_type.eq_ignore_ascii_case("sorted_set") {
        "zset"
    } else {
        value_type
    }
}

fn mutation_result(
    db_index: u8,
    info: RedisKeyInfo,
    fingerprint: String,
) -> RedisKeyMutationResult {
    RedisKeyMutationResult {
        db_index,
        key: info.key,
        value_type: info.value_type,
        ttl: info.ttl,
        size: info.size,
        fingerprint,
    }
}

fn fingerprint_dump(dump: &[u8]) -> String {
    let digest = Sha256::digest(dump);
    let mut encoded = String::with_capacity("sha256:".len() + digest.len() * 2);
    encoded.push_str("sha256:");
    for byte in digest {
        let _ = write!(&mut encoded, "{byte:02x}");
    }
    encoded
}

fn temporary_key() -> String {
    format!("{TEMPORARY_KEY_PREFIX}{}", uuid::Uuid::new_v4())
}

fn stale_key_error() -> IpcError {
    IpcError::resource_conflict(
        "Redis key changed after it was read; refresh the key before applying this mutation",
    )
}

fn ttl_after_policy(
    original_pttl: i64,
    ttl_policy: &RedisTtlPolicy,
    ttl_seconds: Option<u64>,
) -> i64 {
    match ttl_policy {
        RedisTtlPolicy::Keep if original_pttl > 0 => original_pttl.saturating_add(999) / 1000,
        RedisTtlPolicy::Keep | RedisTtlPolicy::Persist => -1,
        RedisTtlPolicy::Expire => {
            i64::try_from(ttl_seconds.unwrap_or_default()).unwrap_or(i64::MAX)
        }
    }
}

fn delete_result(
    db_index: u8,
    key: Option<String>,
    pattern: Option<String>,
    deleted_count: u64,
) -> RedisDeleteKeyResult {
    RedisDeleteKeyResult {
        db_index,
        key,
        pattern,
        deleted_count,
    }
}

fn parse_keyspace_counts(info: &str) -> HashMap<u8, u64> {
    let mut counts = HashMap::new();

    for line in info.lines().map(str::trim) {
        let Some(rest) = line.strip_prefix("db") else {
            continue;
        };
        let Some((index, stats)) = rest.split_once(':') else {
            continue;
        };
        let Ok(index) = index.parse::<u8>() else {
            continue;
        };

        let Some(key_count) = stats.split(',').find_map(|field| {
            field
                .strip_prefix("keys=")
                .and_then(|value| value.parse::<u64>().ok())
        }) else {
            continue;
        };

        counts.insert(index, key_count);
    }

    counts
}

fn redis_database_container(
    profile_id: &str,
    db_index: u8,
    item_count: Option<u64>,
) -> DataContainer {
    DataContainer {
        id: format!("{profile_id}::redis-db::{db_index}"),
        name: format!("DB {db_index}"),
        kind: ContainerKind::RedisDatabase,
        is_leaf: false,
        container: ContainerRef::redis_database(db_index),
        type_name: None,
        nullable: None,
        item_count,
        properties: Vec::new(),
    }
}

async fn delete_matching_keys(
    connection: &mut redis::aio::MultiplexedConnection,
    keys: &[String],
) -> IpcResult<u64> {
    if keys.is_empty() {
        return Ok(0);
    }

    let mut deleted_count = 0;
    for chunk in keys.chunks(DELETE_BATCH_SIZE) {
        let count: u64 = redis::cmd("DEL")
            .arg(chunk)
            .query_async(connection)
            .await
            .map_err(|error| classify_redis_error(error, "delete keys"))?;
        deleted_count += count;
    }

    Ok(deleted_count)
}

fn build_key_tree_result(
    db_index: u8,
    pattern: String,
    keys: Vec<String>,
    key_types: &HashMap<String, String>,
) -> RedisKeyTreeResult {
    let mut roots = Vec::<MutableKeyTreeNode>::new();
    let mut root_map = BTreeMap::<String, usize>::new();

    for key in &keys {
        let segments = key.split(':').collect::<Vec<_>>();
        let value_type = key_types
            .get(key)
            .map(|value_type| normalize_redis_type(value_type).to_string());

        if segments.len() == 1 {
            roots.push(MutableKeyTreeNode::key(
                key.clone(),
                key_segment_label(segments[0]),
                value_type,
            ));
            continue;
        }

        let mut siblings = &mut roots;
        let mut sibling_map = &mut root_map;
        let mut prefix = String::new();

        for segment in &segments[..segments.len() - 1] {
            prefix.push_str(segment);
            prefix.push(':');

            let node = get_or_create_prefix(
                siblings,
                sibling_map,
                prefix.clone(),
                key_segment_label(segment),
            );
            node.key_count += 1;

            siblings = &mut node.children;
            sibling_map = &mut node.child_map;
        }

        siblings.push(MutableKeyTreeNode::key(
            key.clone(),
            key_segment_label(segments[segments.len() - 1]),
            value_type,
        ));
    }

    let mut nodes = roots
        .into_iter()
        .map(MutableKeyTreeNode::into_tree_node)
        .collect::<Vec<_>>();
    sort_key_tree_nodes(&mut nodes);

    RedisKeyTreeResult {
        db_index,
        pattern,
        total_key_count: keys.len() as u64,
        nodes,
    }
}

impl RedisDriver {
    pub async fn connect(profile_id: String, profile: RedisProfile) -> IpcResult<Self> {
        let endpoint =
            ssh_tunnel::resolve_endpoint(&profile.host, profile.port, profile.ssh_tunnel.as_ref())
                .await?;
        let url = build_redis_url_for_endpoint(&profile, &endpoint.host, endpoint.port);
        let client = redis::Client::open(url)
            .map_err(|error| classify_redis_error(error, "client creation"))?;
        let driver = Self {
            profile_id,
            profile,
            client,
            _tunnel: endpoint.tunnel,
        };
        driver.ping().await?;
        Ok(driver)
    }

    async fn default_connection(&self) -> IpcResult<redis::aio::MultiplexedConnection> {
        let timeout = Self::connect_timeout(&self.profile);
        tokio::time::timeout(timeout, self.client.get_multiplexed_async_connection())
            .await
            .map_err(|_| {
                IpcError::network_timeout(
                    "Redis connection timed out",
                    format!("Timed out after {} seconds", timeout.as_secs()),
                )
            })?
            .map_err(|error| classify_redis_error(error, "connection"))
    }

    fn connect_timeout(profile: &RedisProfile) -> Duration {
        Duration::from_secs(profile.connect_timeout_seconds.unwrap_or(5).clamp(1, 300))
    }

    async fn connection(&self, db_index: u8) -> IpcResult<redis::aio::MultiplexedConnection> {
        let mut connection = self.default_connection().await?;
        redis::cmd("SELECT")
            .arg(db_index)
            .query_async::<()>(&mut connection)
            .await
            .map_err(|error| classify_redis_error(error, "select database"))?;
        Ok(connection)
    }

    async fn list_database_indices(&self) -> IpcResult<Vec<u8>> {
        let mut connection = self.default_connection().await?;

        if let Ok(values) = redis::cmd("CONFIG")
            .arg("GET")
            .arg("databases")
            .query_async::<Vec<String>>(&mut connection)
            .await
        {
            if let Some(count) = values.chunks(2).find_map(|chunk| match chunk {
                [key, value] if key.eq_ignore_ascii_case("databases") => value.parse::<u16>().ok(),
                _ => None,
            }) {
                return Ok((0..count.min(u8::MAX as u16 + 1))
                    .map(|index| index as u8)
                    .collect());
            }
        }

        let mut indices = BTreeSet::new();
        if let Ok(info) = redis::cmd("INFO")
            .arg("keyspace")
            .query_async::<String>(&mut connection)
            .await
        {
            for line in info.lines() {
                let Some(rest) = line.strip_prefix("db") else {
                    continue;
                };
                let Some((index, _stats)) = rest.split_once(':') else {
                    continue;
                };
                if let Ok(index) = index.parse::<u8>() {
                    indices.insert(index);
                }
            }
        }

        if indices.is_empty() {
            indices.insert(0);
        }

        Ok(indices.into_iter().collect())
    }

    async fn try_keyspace_counts(&self) -> Option<HashMap<u8, u64>> {
        let mut connection = self.default_connection().await.ok()?;
        let info = redis::cmd("INFO")
            .arg("keyspace")
            .query_async::<String>(&mut connection)
            .await
            .ok()?;

        Some(parse_keyspace_counts(&info))
    }

    async fn database_size(&self, db_index: u8) -> IpcResult<u64> {
        let mut connection = self.connection(db_index).await?;
        redis::cmd("DBSIZE")
            .query_async::<u64>(&mut connection)
            .await
            .map_err(|error| classify_redis_error(error, "database size lookup"))
    }

    async fn database_item_count(
        &self,
        db_index: u8,
        keyspace_counts: Option<&HashMap<u8, u64>>,
    ) -> Option<u64> {
        if let Some(counts) = keyspace_counts {
            return Some(counts.get(&db_index).copied().unwrap_or(0));
        }

        self.database_size(db_index).await.ok()
    }

    async fn key_info(
        &self,
        connection: &mut redis::aio::MultiplexedConnection,
        key: &str,
    ) -> IpcResult<RedisKeyInfo> {
        let value_type: String = redis::cmd("TYPE")
            .arg(key)
            .query_async(connection)
            .await
            .map_err(|error| classify_redis_error(error, "type lookup"))?;
        let value_type = normalize_redis_type(&value_type).to_string();
        let ttl: i64 = redis::cmd("TTL")
            .arg(key)
            .query_async(connection)
            .await
            .map_err(|error| classify_redis_error(error, "ttl lookup"))?;
        let size: Option<u64> = redis::cmd("MEMORY")
            .arg("USAGE")
            .arg(key)
            .query_async(connection)
            .await
            .ok();
        Ok(RedisKeyInfo {
            key: key.to_string(),
            value_type,
            ttl,
            size,
        })
    }

    async fn key_dump(
        &self,
        connection: &mut redis::aio::MultiplexedConnection,
        key: &str,
    ) -> IpcResult<Option<Vec<u8>>> {
        redis::cmd("DUMP")
            .arg(key)
            .query_async(connection)
            .await
            .map_err(|error| classify_redis_error(error, "key fingerprint lookup"))
    }

    async fn require_expected_fingerprint(
        &self,
        connection: &mut redis::aio::MultiplexedConnection,
        key: &str,
        expected_fingerprint: &str,
    ) -> IpcResult<Vec<u8>> {
        let dump = self
            .key_dump(connection, key)
            .await?
            .ok_or_else(|| IpcError::resource_not_found("Redis key no longer exists"))?;
        if fingerprint_dump(&dump) != expected_fingerprint {
            return Err(stale_key_error());
        }
        Ok(dump)
    }

    async fn unwatch(connection: &mut redis::aio::MultiplexedConnection) {
        let _ = redis::cmd("UNWATCH").query_async::<()>(connection).await;
    }

    async fn cleanup_temporary_key(connection: &mut redis::aio::MultiplexedConnection, key: &str) {
        let _ = redis::cmd("DEL")
            .arg(key)
            .query_async::<u64>(connection)
            .await;
    }

    async fn abort_temporary_mutation(
        connection: &mut redis::aio::MultiplexedConnection,
        temporary_key: &str,
        error: IpcError,
    ) -> IpcError {
        Self::unwatch(connection).await;
        Self::cleanup_temporary_key(connection, temporary_key).await;
        error
    }

    async fn write_temporary_value(
        &self,
        connection: &mut redis::aio::MultiplexedConnection,
        key: &str,
        value: &RedisEditableValue,
    ) -> IpcResult<()> {
        let mut pipeline = redis::pipe();
        pipeline.atomic();
        match value {
            RedisEditableValue::String(text) => {
                pipeline.cmd("SET").arg(key).arg(text).ignore();
            }
            RedisEditableValue::Json(text) => {
                pipeline
                    .cmd("JSON.SET")
                    .arg(key)
                    .arg("$")
                    .arg(text)
                    .ignore();
            }
            RedisEditableValue::Hash(entries) => {
                let command = pipeline.cmd("HSET");
                command.arg(key);
                for entry in entries {
                    command.arg(&entry.field).arg(&entry.value);
                }
                command.ignore();
            }
            RedisEditableValue::List(items) => {
                pipeline.cmd("RPUSH").arg(key).arg(items).ignore();
            }
            RedisEditableValue::Set(items) => {
                pipeline.cmd("SADD").arg(key).arg(items).ignore();
            }
            RedisEditableValue::SortedSet(entries) => {
                let command = pipeline.cmd("ZADD");
                command.arg(key);
                for entry in entries {
                    command.arg(entry.score).arg(&entry.member);
                }
                command.ignore();
            }
            RedisEditableValue::Stream(entries) => {
                for entry in entries {
                    let command = pipeline.cmd("XADD");
                    command.arg(key).arg(&entry.id);
                    for field in &entry.fields {
                        command.arg(&field.field).arg(&field.value);
                    }
                    command.ignore();
                }
            }
        }
        pipeline
            .cmd("PEXPIRE")
            .arg(key)
            .arg(TEMPORARY_KEY_TTL_MS)
            .ignore();

        if let Err(error) = pipeline.query_async::<()>(connection).await {
            Self::cleanup_temporary_key(connection, key).await;
            return Err(classify_redis_error(error, "build temporary key value"));
        }
        Ok(())
    }

    async fn temporary_value_fingerprint(
        &self,
        connection: &mut redis::aio::MultiplexedConnection,
        key: &str,
    ) -> IpcResult<String> {
        match self.key_dump(connection, key).await {
            Ok(Some(dump)) => Ok(fingerprint_dump(&dump)),
            Ok(None) => {
                Self::cleanup_temporary_key(connection, key).await;
                Err(IpcError::system_internal(
                    "Redis temporary value disappeared before replacement",
                    "Temporary key DUMP returned nil",
                ))
            }
            Err(error) => {
                Self::cleanup_temporary_key(connection, key).await;
                Err(error)
            }
        }
    }

    fn append_ttl_command(
        pipeline: &mut redis::Pipeline,
        key: &str,
        original_pttl: i64,
        ttl_policy: &RedisTtlPolicy,
        ttl_seconds: Option<u64>,
    ) -> IpcResult<()> {
        match ttl_policy {
            RedisTtlPolicy::Keep => {
                if original_pttl > 0 {
                    pipeline.cmd("PEXPIRE").arg(key).arg(original_pttl).ignore();
                } else if original_pttl == -1 {
                    pipeline.cmd("PERSIST").arg(key).ignore();
                } else {
                    return Err(stale_key_error());
                }
            }
            RedisTtlPolicy::Persist => {
                pipeline.cmd("PERSIST").arg(key).ignore();
            }
            RedisTtlPolicy::Expire => {
                let ttl_seconds = ttl_seconds.filter(|value| *value > 0).ok_or_else(|| {
                    IpcError::validation_failed(
                        "Redis expire ttlPolicy requires a positive ttlSeconds value",
                    )
                })?;
                pipeline.cmd("EXPIRE").arg(key).arg(ttl_seconds).ignore();
            }
        }

        Ok(())
    }

    async fn replace_temporary_key(
        &self,
        connection: &mut redis::aio::MultiplexedConnection,
        temporary_key: &str,
        target_key: &str,
        original_pttl: i64,
        ttl_policy: &RedisTtlPolicy,
        ttl_seconds: Option<u64>,
    ) -> IpcResult<Option<String>> {
        let mut pipeline = redis::pipe();
        pipeline
            .atomic()
            .cmd("RENAME")
            .arg(temporary_key)
            .arg(target_key)
            .ignore();
        Self::append_ttl_command(
            &mut pipeline,
            target_key,
            original_pttl,
            ttl_policy,
            ttl_seconds,
        )?;
        pipeline.cmd("TYPE").arg(target_key);
        let response: Option<(String,)> = pipeline
            .query_async(connection)
            .await
            .map_err(|error| classify_redis_error(error, "atomic key replacement"))?;
        Ok(response.map(|(value_type,)| normalize_redis_type(&value_type).to_string()))
    }

    fn containers_from_scan(
        &self,
        db_index: u8,
        pattern: &str,
        keys: Vec<RedisKeyInfo>,
    ) -> Vec<DataContainer> {
        let base = pattern.strip_suffix('*').unwrap_or(pattern);
        let mut prefixes = BTreeMap::<String, String>::new();
        let mut containers = Vec::new();

        for key in keys {
            let rest = key.key.strip_prefix(base).unwrap_or(&key.key);
            if let Some((segment, _)) = rest.split_once(':') {
                let prefix = format!("{base}{segment}:");
                let prefix_pattern = format!("{prefix}*");
                prefixes.entry(prefix).or_insert(prefix_pattern);
                continue;
            }

            containers.push(DataContainer {
                id: format!("{}::redis-key::{db_index}::{}", self.profile_id, key.key),
                name: key.key.clone(),
                kind: ContainerKind::RedisKey,
                is_leaf: true,
                container: ContainerRef::redis_key(db_index, key.key),
                type_name: Some(key.value_type),
                nullable: None,
                item_count: None,
                properties: Vec::new(),
            });
        }

        let mut prefix_containers = prefixes
            .into_iter()
            .map(|(prefix, prefix_pattern)| DataContainer {
                id: format!(
                    "{}::redis-prefix::{db_index}::{prefix_pattern}",
                    self.profile_id
                ),
                name: prefix,
                kind: ContainerKind::RedisKeyPrefix,
                is_leaf: false,
                container: ContainerRef::redis_key_prefix(db_index, prefix_pattern),
                type_name: None,
                nullable: None,
                item_count: None,
                properties: Vec::new(),
            })
            .collect::<Vec<_>>();

        prefix_containers.append(&mut containers);
        prefix_containers
    }
}

#[async_trait]
impl DatabaseDriver for RedisDriver {
    fn profile_id(&self) -> &str {
        &self.profile_id
    }

    fn driver_name(&self) -> &'static str {
        "redis"
    }

    fn capabilities(&self) -> DriverCapabilities {
        DriverCapabilities {
            schema_browser: true,
            schema_mutator: false,
            schema_mutation: None,
            data_table_browser: false,
            table_row_mutator: false,
            table_row_inserter: false,
            transaction_manager: false,
            sql_executor: false,
            sql_execution: None,
            key_value_browser: true,
            graph_queryer: false,
            vector_searcher: false,
        }
    }

    async fn ping(&self) -> IpcResult<PingResult> {
        let start = Instant::now();
        let mut connection = match self.profile.db_index {
            Some(db_index) => self.connection(db_index).await?,
            None => self.default_connection().await?,
        };
        redis::cmd("PING")
            .query_async::<String>(&mut connection)
            .await
            .map_err(|error| classify_redis_error(error, "ping"))?;
        Ok(PingResult {
            latency_ms: start.elapsed().as_millis() as u64,
        })
    }

    async fn server_version(&self) -> IpcResult<Option<String>> {
        let mut connection = self.default_connection().await?;
        let info = redis::cmd("INFO")
            .arg("server")
            .query_async::<String>(&mut connection)
            .await
            .map_err(|error| classify_redis_error(error, "server info lookup"))?;
        let version = info.lines().find_map(|line| {
            line.strip_prefix("redis_version:")
                .map(|value| value.trim().to_string())
        });
        Ok(version)
    }

    async fn close(&self) -> IpcResult<()> {
        Ok(())
    }

    fn ssh_host_key_fingerprint(&self) -> Option<&str> {
        self._tunnel
            .as_ref()
            .and_then(SshTunnelRuntime::captured_host_key_fingerprint)
    }

    fn as_schema_browser(&self) -> Option<&dyn SchemaBrowser> {
        Some(self)
    }

    fn as_key_value_browser(&self) -> Option<&dyn KeyValueBrowser> {
        Some(self)
    }
}

#[async_trait]
impl SchemaBrowser for RedisDriver {
    async fn list_containers(
        &self,
        parent: Option<&ContainerRef>,
    ) -> IpcResult<Vec<DataContainer>> {
        match parent.map(|container| &container.kind) {
            None => {
                let db_indices = match self.profile.db_index {
                    Some(db_index) => vec![db_index],
                    None => self.list_database_indices().await?,
                };
                let keyspace_counts = self.try_keyspace_counts().await;
                let mut containers = Vec::with_capacity(db_indices.len());
                for db_index in db_indices {
                    let item_count = self
                        .database_item_count(db_index, keyspace_counts.as_ref())
                        .await;
                    containers.push(redis_database_container(
                        &self.profile_id,
                        db_index,
                        item_count,
                    ));
                }
                Ok(containers)
            }
            Some(ContainerKind::RedisDatabase) | Some(ContainerKind::RedisKeyPrefix) => {
                let container = parent.expect("checked parent");
                let db_index = container
                    .db_index
                    .or(self.profile.db_index)
                    .ok_or_else(|| {
                        IpcError::resource_not_found("Redis database index is missing")
                    })?;
                let pattern = container.pattern.as_deref().unwrap_or("*");
                let result = self
                    .scan_key_values(&RedisScanRequest {
                        db_index,
                        pattern: pattern.to_string(),
                        cursor: 0,
                        count: 100,
                    })
                    .await?;
                Ok(self.containers_from_scan(db_index, pattern, result.keys))
            }
            _ => Ok(Vec::new()),
        }
    }
}

#[async_trait]
impl KeyValueBrowser for RedisDriver {
    async fn scan_key_values(&self, request: &RedisScanRequest) -> IpcResult<RedisScanResult> {
        let mut connection = self.connection(request.db_index).await?;
        let (cursor, keys): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(request.cursor)
            .arg("MATCH")
            .arg(&request.pattern)
            .arg("COUNT")
            .arg(request.count)
            .query_async(&mut connection)
            .await
            .map_err(|error| classify_redis_error(error, "key scan"))?;

        Ok(RedisScanResult {
            cursor,
            keys: keys
                .into_iter()
                .map(|key| RedisKeyInfo {
                    key,
                    value_type: "key".to_string(),
                    ttl: -1,
                    size: None,
                })
                .collect(),
        })
    }

    async fn browse_key_tree(
        &self,
        request: &RedisKeyTreeRequest,
    ) -> IpcResult<RedisKeyTreeResult> {
        let mut connection = self.connection(request.db_index).await?;
        let count = request.count.max(1);
        let mut cursor = 0;
        let mut keys = BTreeSet::<String>::new();

        loop {
            let (next_cursor, batch): (u64, Vec<String>) = redis::cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg(&request.pattern)
                .arg("COUNT")
                .arg(count)
                .query_async(&mut connection)
                .await
                .map_err(|error| classify_redis_error(error, "key tree scan"))?;

            keys.extend(batch);
            cursor = next_cursor;

            if cursor == 0 {
                break;
            }
        }

        let key_list: Vec<String> = keys.into_iter().collect();
        let key_types = if key_list.is_empty() {
            HashMap::new()
        } else {
            let mut pipe = redis::pipe();
            for key in &key_list {
                pipe.cmd("TYPE").arg(key);
            }
            let types: Vec<String> = pipe
                .query_async(&mut connection)
                .await
                .map_err(|error| classify_redis_error(error, "batch type lookup"))?;

            key_list
                .iter()
                .zip(types)
                .map(|(k, t)| (k.clone(), t))
                .collect::<HashMap<_, _>>()
        };

        Ok(build_key_tree_result(
            request.db_index,
            request.pattern.clone(),
            key_list,
            &key_types,
        ))
    }

    async fn get_key_value(&self, key_ref: &RedisKeyRef) -> IpcResult<RedisKeyValue> {
        let mut connection = self.connection(key_ref.db_index).await?;
        let before = self
            .key_dump(&mut connection, &key_ref.key)
            .await?
            .ok_or_else(|| {
                IpcError::resource_not_found(format!("Redis key '{}' does not exist", key_ref.key))
            })?;
        let info = self.key_info(&mut connection, &key_ref.key).await?;
        let value = match info.value_type.as_str() {
            "none" => {
                return Err(IpcError::resource_not_found(format!(
                    "Redis key '{}' does not exist",
                    key_ref.key
                )));
            }
            "string" => {
                let value: Option<Vec<u8>> = connection
                    .get(&key_ref.key)
                    .await
                    .map_err(|error| classify_redis_error(error, "get string bytes"))?;

                match value {
                    Some(bytes) => match String::from_utf8(bytes) {
                        Ok(text) => {
                            RedisValue::String(RedisStringValue::Utf8 { value: Some(text) })
                        }
                        Err(error) => {
                            let bytes = error.into_bytes();
                            RedisValue::String(RedisStringValue::Binary {
                                byte_length: bytes.len(),
                                preview_hex: bytes_to_hex_preview(&bytes, 64),
                            })
                        }
                    },
                    None => RedisValue::String(RedisStringValue::Utf8 { value: None }),
                }
            }
            "json" => {
                let value: String = redis::cmd("JSON.GET")
                    .arg(&key_ref.key)
                    .query_async(&mut connection)
                    .await
                    .map_err(|error| classify_redis_error(error, "get json value"))?;
                RedisValue::Json(value)
            }
            "hash" => {
                let value: Vec<(String, String)> = connection
                    .hgetall(&key_ref.key)
                    .await
                    .map_err(|error| classify_redis_error(error, "get hash value"))?;
                RedisValue::Hash(
                    value
                        .into_iter()
                        .map(|(field, value)| RedisHashEntry { field, value })
                        .collect(),
                )
            }
            "list" => {
                let value: Vec<String> = connection
                    .lrange(&key_ref.key, 0, -1)
                    .await
                    .map_err(|error| classify_redis_error(error, "get list value"))?;
                RedisValue::List(value)
            }
            "set" => {
                let value: Vec<String> = connection
                    .smembers(&key_ref.key)
                    .await
                    .map_err(|error| classify_redis_error(error, "get set value"))?;
                RedisValue::Set(value)
            }
            "zset" => {
                let value: Vec<(String, f64)> = redis::cmd("ZRANGE")
                    .arg(&key_ref.key)
                    .arg(0)
                    .arg(-1)
                    .arg("WITHSCORES")
                    .query_async(&mut connection)
                    .await
                    .map_err(|error| classify_redis_error(error, "get sorted set value"))?;
                RedisValue::SortedSet(
                    value
                        .into_iter()
                        .map(|(member, score)| RedisSortedSetEntry { member, score })
                        .collect(),
                )
            }
            "stream" => {
                let value: Vec<(String, Vec<(String, String)>)> = redis::cmd("XRANGE")
                    .arg(&key_ref.key)
                    .arg("-")
                    .arg("+")
                    .query_async(&mut connection)
                    .await
                    .map_err(|error| classify_redis_error(error, "get stream value"))?;
                RedisValue::Stream(
                    value
                        .into_iter()
                        .map(|(id, fields)| RedisStreamEntry {
                            id,
                            fields: fields
                                .into_iter()
                                .map(|(field, value)| RedisHashEntry { field, value })
                                .collect(),
                        })
                        .collect(),
                )
            }
            other => RedisValue::Unsupported(other.to_string()),
        };
        let after = self
            .key_dump(&mut connection, &key_ref.key)
            .await?
            .ok_or_else(stale_key_error)?;
        if before != after {
            return Err(stale_key_error());
        }

        Ok(RedisKeyValue {
            key: info.key,
            value_type: info.value_type,
            ttl: info.ttl,
            size: info.size,
            fingerprint: fingerprint_dump(&after),
            value,
        })
    }

    async fn get_key_precondition(&self, key_ref: &RedisKeyRef) -> IpcResult<RedisKeyPrecondition> {
        ensure_non_empty_key(&key_ref.key, "key")?;
        let mut connection = self.connection(key_ref.db_index).await?;
        let before = self
            .key_dump(&mut connection, &key_ref.key)
            .await?
            .ok_or_else(|| {
                IpcError::resource_not_found(format!("Redis key '{}' does not exist", key_ref.key))
            })?;
        let info = self.key_info(&mut connection, &key_ref.key).await?;
        let after = self
            .key_dump(&mut connection, &key_ref.key)
            .await?
            .ok_or_else(stale_key_error)?;
        if before != after {
            return Err(stale_key_error());
        }
        Ok(RedisKeyPrecondition {
            db_index: key_ref.db_index,
            key: info.key,
            value_type: info.value_type,
            ttl: info.ttl,
            size: info.size,
            fingerprint: fingerprint_dump(&after),
        })
    }

    async fn set_key_value(
        &self,
        request: &RedisSetKeyValueRequest,
    ) -> IpcResult<RedisKeyMutationResult> {
        ensure_non_empty_key(&request.key, "key")?;
        validate_expected_fingerprint(&request.expected_fingerprint)?;
        validate_editable_value(&request.value)?;
        validate_value_ttl_policy(request.ttl_policy.as_ref(), request.ttl_seconds)?;

        let mut connection = self.connection(request.db_index).await?;
        let temporary_key = temporary_key();
        self.write_temporary_value(&mut connection, &temporary_key, &request.value)
            .await?;
        let replacement_fingerprint = self
            .temporary_value_fingerprint(&mut connection, &temporary_key)
            .await?;
        if let Err(error) = redis::cmd("WATCH")
            .arg(&request.key)
            .query_async::<()>(&mut connection)
            .await
            .map_err(|error| classify_redis_error(error, "watch key for replacement"))
        {
            return Err(
                Self::abort_temporary_mutation(&mut connection, &temporary_key, error).await,
            );
        }
        if let Err(error) = self
            .require_expected_fingerprint(
                &mut connection,
                &request.key,
                &request.expected_fingerprint,
            )
            .await
        {
            return Err(
                Self::abort_temporary_mutation(&mut connection, &temporary_key, error).await,
            );
        }
        let current_info = match self.key_info(&mut connection, &request.key).await {
            Ok(info) => info,
            Err(error) => {
                return Err(
                    Self::abort_temporary_mutation(&mut connection, &temporary_key, error).await,
                );
            }
        };

        if let Some(expected_type) = request.expected_type.as_deref() {
            let expected_type = normalize_redis_type(expected_type);
            if normalize_redis_type(&current_info.value_type) != expected_type {
                let error = IpcError::resource_conflict(format!(
                    "Redis key type changed from '{expected_type}' to '{}'",
                    current_info.value_type
                ));
                return Err(
                    Self::abort_temporary_mutation(&mut connection, &temporary_key, error).await,
                );
            }
        }

        let target_type = editable_value_type(&request.value);
        let original_pttl: i64 = match redis::cmd("PTTL")
            .arg(&request.key)
            .query_async(&mut connection)
            .await
            .map_err(|error| classify_redis_error(error, "ttl lookup"))
        {
            Ok(pttl) => pttl,
            Err(error) => {
                return Err(
                    Self::abort_temporary_mutation(&mut connection, &temporary_key, error).await,
                );
            }
        };
        let replacement_type = match self
            .replace_temporary_key(
                &mut connection,
                &temporary_key,
                &request.key,
                original_pttl,
                request.ttl_policy.as_ref().unwrap_or(&RedisTtlPolicy::Keep),
                request.ttl_seconds,
            )
            .await
        {
            Ok(replacement_type) => replacement_type,
            Err(error) => {
                Self::cleanup_temporary_key(&mut connection, &temporary_key).await;
                return Err(error);
            }
        };
        let Some(replacement_type) = replacement_type else {
            Self::cleanup_temporary_key(&mut connection, &temporary_key).await;
            return Err(stale_key_error());
        };
        if replacement_type != target_type {
            return Err(IpcError::system_internal(
                "Redis key was saved with an unexpected type",
                format!(
                    "expected type '{target_type}', actual type '{}'",
                    replacement_type
                ),
            ));
        }

        let ttl_policy = request.ttl_policy.as_ref().unwrap_or(&RedisTtlPolicy::Keep);
        Ok(mutation_result(
            request.db_index,
            RedisKeyInfo {
                key: request.key.clone(),
                value_type: replacement_type,
                ttl: ttl_after_policy(original_pttl, ttl_policy, request.ttl_seconds),
                size: None,
            },
            replacement_fingerprint,
        ))
    }

    async fn create_key_value(
        &self,
        request: &RedisCreateKeyValueRequest,
    ) -> IpcResult<RedisKeyMutationResult> {
        validate_create_key_value_request(request)?;

        let mut connection = self.connection(request.db_index).await?;
        let temporary_key = temporary_key();
        let target_type = editable_value_type(&request.value);
        self.write_temporary_value(&mut connection, &temporary_key, &request.value)
            .await?;
        let replacement_fingerprint = self
            .temporary_value_fingerprint(&mut connection, &temporary_key)
            .await?;
        if let Err(error) = redis::cmd("WATCH")
            .arg(&request.key)
            .query_async::<()>(&mut connection)
            .await
            .map_err(|error| classify_redis_error(error, "watch key for creation"))
        {
            return Err(
                Self::abort_temporary_mutation(&mut connection, &temporary_key, error).await,
            );
        }
        let target_exists: bool = match redis::cmd("EXISTS")
            .arg(&request.key)
            .query_async(&mut connection)
            .await
            .map_err(|error| classify_redis_error(error, "target key existence lookup"))
        {
            Ok(exists) => exists,
            Err(error) => {
                return Err(
                    Self::abort_temporary_mutation(&mut connection, &temporary_key, error).await,
                );
            }
        };
        if target_exists {
            let error =
                IpcError::resource_conflict("Redis key already exists and was not overwritten");
            return Err(
                Self::abort_temporary_mutation(&mut connection, &temporary_key, error).await,
            );
        }
        let replacement_type = match self
            .replace_temporary_key(
                &mut connection,
                &temporary_key,
                &request.key,
                -1,
                request.ttl_policy.as_ref().unwrap_or(&RedisTtlPolicy::Keep),
                request.ttl_seconds,
            )
            .await
        {
            Ok(replacement_type) => replacement_type,
            Err(error) => {
                Self::cleanup_temporary_key(&mut connection, &temporary_key).await;
                return Err(error);
            }
        };
        let Some(replacement_type) = replacement_type else {
            Self::cleanup_temporary_key(&mut connection, &temporary_key).await;
            return Err(IpcError::resource_conflict(
                "Redis key appeared concurrently and was not overwritten",
            ));
        };
        if replacement_type != target_type {
            return Err(IpcError::system_internal(
                "Redis key was created with an unexpected type",
                format!(
                    "expected type '{target_type}', actual type '{}'",
                    replacement_type
                ),
            ));
        }

        let ttl_policy = request.ttl_policy.as_ref().unwrap_or(&RedisTtlPolicy::Keep);
        Ok(mutation_result(
            request.db_index,
            RedisKeyInfo {
                key: request.key.clone(),
                value_type: replacement_type,
                ttl: ttl_after_policy(-1, ttl_policy, request.ttl_seconds),
                size: None,
            },
            replacement_fingerprint,
        ))
    }

    async fn delete_key(&self, request: &RedisDeleteKeyRequest) -> IpcResult<RedisDeleteKeyResult> {
        validate_delete_key_request(request)?;

        let mut connection = self.connection(request.db_index).await?;
        redis::cmd("WATCH")
            .arg(&request.key)
            .query_async::<()>(&mut connection)
            .await
            .map_err(|error| classify_redis_error(error, "watch key for deletion"))?;
        if let Err(error) = self
            .require_expected_fingerprint(
                &mut connection,
                &request.key,
                &request.expected_fingerprint,
            )
            .await
        {
            Self::unwatch(&mut connection).await;
            return Err(error);
        }
        let response: Option<(u64,)> = redis::pipe()
            .atomic()
            .cmd("DEL")
            .arg(&request.key)
            .query_async(&mut connection)
            .await
            .map_err(|error| classify_redis_error(error, "atomic key deletion"))?;
        let deleted_count = response.map(|(count,)| count).ok_or_else(stale_key_error)?;
        if deleted_count != 1 {
            return Err(stale_key_error());
        }

        Ok(delete_result(
            request.db_index,
            Some(request.key.clone()),
            None,
            deleted_count,
        ))
    }

    async fn delete_key_prefix(
        &self,
        request: &RedisDeleteKeyPrefixRequest,
    ) -> IpcResult<RedisDeleteKeyResult> {
        validate_delete_key_prefix_request(request)?;

        let pattern = request.pattern.trim().to_string();
        let mut connection = self.connection(request.db_index).await?;
        let mut cursor = 0;
        let mut keys = BTreeSet::<String>::new();

        loop {
            let (next_cursor, batch): (u64, Vec<String>) = redis::cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg(&pattern)
                .arg("COUNT")
                .arg(DELETE_SCAN_COUNT)
                .query_async(&mut connection)
                .await
                .map_err(|error| classify_redis_error(error, "delete prefix scan"))?;

            keys.extend(batch);
            cursor = next_cursor;

            if cursor == 0 {
                break;
            }
        }

        let keys = keys.into_iter().collect::<Vec<_>>();
        let deleted_count = delete_matching_keys(&mut connection, &keys).await?;

        Ok(delete_result(
            request.db_index,
            None,
            Some(pattern),
            deleted_count,
        ))
    }

    async fn rename_key(
        &self,
        request: &RedisRenameKeyRequest,
    ) -> IpcResult<RedisKeyMutationResult> {
        validate_rename_request(request)?;

        if request.key == request.new_key {
            let mut connection = self.connection(request.db_index).await?;
            self.require_expected_fingerprint(
                &mut connection,
                &request.key,
                &request.expected_fingerprint,
            )
            .await?;
            let info = self.key_info(&mut connection, &request.key).await?;
            return Ok(mutation_result(
                request.db_index,
                info,
                request.expected_fingerprint.clone(),
            ));
        }

        let mut connection = self.connection(request.db_index).await?;
        redis::cmd("WATCH")
            .arg(&[request.key.as_str(), request.new_key.as_str()])
            .query_async::<()>(&mut connection)
            .await
            .map_err(|error| classify_redis_error(error, "watch keys for rename"))?;
        if let Err(error) = self
            .require_expected_fingerprint(
                &mut connection,
                &request.key,
                &request.expected_fingerprint,
            )
            .await
        {
            Self::unwatch(&mut connection).await;
            return Err(error);
        }
        let source_info = match self.key_info(&mut connection, &request.key).await {
            Ok(info) => info,
            Err(error) => {
                Self::unwatch(&mut connection).await;
                return Err(error);
            }
        };
        let target_exists: bool = redis::cmd("EXISTS")
            .arg(&request.new_key)
            .query_async(&mut connection)
            .await
            .map_err(|error| classify_redis_error(error, "target key existence lookup"))?;

        if target_exists {
            Self::unwatch(&mut connection).await;
            return Err(IpcError::resource_conflict(format!(
                "Redis key '{}' already exists",
                request.new_key
            )));
        }

        let response: Option<(u64,)> = redis::pipe()
            .atomic()
            .cmd("RENAMENX")
            .arg(&request.key)
            .arg(&request.new_key)
            .query_async(&mut connection)
            .await
            .map_err(|error| classify_redis_error(error, "atomic key rename"))?;
        match response {
            Some((1,)) => {}
            Some((0,)) => {
                return Err(IpcError::resource_conflict(
                    "Redis rename target appeared concurrently",
                ));
            }
            None => return Err(stale_key_error()),
            Some(_) => {
                return Err(IpcError::system_internal(
                    "Redis returned an invalid rename result",
                    "RENAMENX returned an unexpected integer",
                ));
            }
        }

        Ok(mutation_result(
            request.db_index,
            RedisKeyInfo {
                key: request.new_key.clone(),
                ..source_info
            },
            request.expected_fingerprint.clone(),
        ))
    }

    async fn set_key_ttl(
        &self,
        request: &RedisSetKeyTtlRequest,
    ) -> IpcResult<RedisKeyMutationResult> {
        validate_ttl_request(request)?;

        let mut connection = self.connection(request.db_index).await?;
        redis::cmd("WATCH")
            .arg(&request.key)
            .query_async::<()>(&mut connection)
            .await
            .map_err(|error| classify_redis_error(error, "watch key for ttl change"))?;
        if let Err(error) = self
            .require_expected_fingerprint(
                &mut connection,
                &request.key,
                &request.expected_fingerprint,
            )
            .await
        {
            Self::unwatch(&mut connection).await;
            return Err(error);
        }
        let current_info = match self.key_info(&mut connection, &request.key).await {
            Ok(info) => info,
            Err(error) => {
                Self::unwatch(&mut connection).await;
                return Err(error);
            }
        };
        let mut pipeline = redis::pipe();
        pipeline.atomic();
        match request.mode {
            RedisSetKeyTtlMode::Expire => {
                let ttl_seconds = request.ttl_seconds.expect("validated positive ttlSeconds");
                pipeline.cmd("EXPIRE").arg(&request.key).arg(ttl_seconds);
            }
            RedisSetKeyTtlMode::Persist => {
                pipeline.cmd("PERSIST").arg(&request.key);
            }
        };
        let response: Option<(u64,)> = pipeline
            .query_async(&mut connection)
            .await
            .map_err(|error| classify_redis_error(error, "atomic key ttl change"))?;
        if response.is_none() {
            return Err(stale_key_error());
        }

        let ttl = match request.mode {
            RedisSetKeyTtlMode::Expire => {
                i64::try_from(request.ttl_seconds.expect("validated positive ttlSeconds"))
                    .unwrap_or(i64::MAX)
            }
            RedisSetKeyTtlMode::Persist => -1,
        };
        Ok(mutation_result(
            request.db_index,
            RedisKeyInfo {
                ttl,
                ..current_info
            },
            request.expected_fingerprint.clone(),
        ))
    }
}

fn build_redis_url_for_endpoint(profile: &RedisProfile, host: &str, port: u16) -> String {
    let scheme = if profile.use_tls { "rediss" } else { "redis" };
    let auth = match (profile.username.as_deref(), profile.password.as_str()) {
        (Some(username), password) if !username.is_empty() || !password.is_empty() => {
            format!("{username}:{password}@")
        }
        (None, password) if !password.is_empty() => format!(":{password}@"),
        _ => String::new(),
    };
    match profile.db_index {
        Some(db_index) => format!("{scheme}://{auth}{host}:{port}/{db_index}"),
        None => format!("{scheme}://{auth}{host}:{port}"),
    }
}

#[cfg(test)]
fn build_redis_url(profile: &RedisProfile) -> String {
    build_redis_url_for_endpoint(profile, &profile.host, profile.port)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_driver() -> RedisDriver {
        RedisDriver {
            profile_id: "profile-1".to_string(),
            profile: RedisProfile {
                host: "localhost".to_string(),
                port: 6379,
                username: None,
                password: String::new(),
                db_index: Some(0),
                use_tls: false,
                connect_timeout_seconds: None,
                ssh_tunnel: None,
            },
            client: redis::Client::open("redis://127.0.0.1:6379/0").expect("valid redis url"),
            _tunnel: None,
        }
    }

    fn profile(db_index: Option<u8>) -> RedisProfile {
        RedisProfile {
            host: "localhost".to_string(),
            port: 6379,
            username: None,
            password: String::new(),
            db_index,
            use_tls: false,
            connect_timeout_seconds: None,
            ssh_tunnel: None,
        }
    }

    fn key(key: &str) -> RedisKeyInfo {
        RedisKeyInfo {
            key: key.to_string(),
            value_type: "string".to_string(),
            ttl: -1,
            size: None,
        }
    }

    fn hash_entry(field: &str, value: &str) -> RedisHashEntry {
        RedisHashEntry {
            field: field.to_string(),
            value: value.to_string(),
        }
    }

    fn fingerprint() -> String {
        "sha256:0000000000000000000000000000000000000000000000000000000000000000".to_string()
    }

    #[test]
    fn dump_fingerprint_is_stable_and_value_sensitive() {
        let first = fingerprint_dump(b"redis-dump-a");
        assert_eq!(first, fingerprint_dump(b"redis-dump-a"));
        assert_ne!(first, fingerprint_dump(b"redis-dump-b"));
        assert_eq!(first.len(), "sha256:".len() + 64);
        assert!(validate_expected_fingerprint(&first).is_ok());
        assert!(validate_expected_fingerprint("sha256:ABC").is_err());
        assert!(validate_expected_fingerprint(&format!("md5:{}", "0".repeat(64))).is_err());
    }

    #[test]
    fn temporary_keys_are_opaque_unique_and_guarded_by_namespace() {
        let first = temporary_key();
        let second = temporary_key();

        assert!(first.starts_with(TEMPORARY_KEY_PREFIX));
        assert!(second.starts_with(TEMPORARY_KEY_PREFIX));
        assert_ne!(first, second);
        assert!(!first.contains("customer:key"));
    }

    #[test]
    fn reports_ttl_after_atomic_replacement_policy() {
        assert_eq!(ttl_after_policy(1_001, &RedisTtlPolicy::Keep, None), 2);
        assert_eq!(ttl_after_policy(-1, &RedisTtlPolicy::Keep, None), -1);
        assert_eq!(ttl_after_policy(50_000, &RedisTtlPolicy::Persist, None), -1);
        assert_eq!(
            ttl_after_policy(50_000, &RedisTtlPolicy::Expire, Some(60)),
            60
        );
    }

    #[test]
    fn maps_editable_values_to_redis_type_names() {
        assert_eq!(
            editable_value_type(&RedisEditableValue::String("value".to_string())),
            "string"
        );
        assert_eq!(
            editable_value_type(&RedisEditableValue::Json("{\"ok\":true}".to_string())),
            "json"
        );
        assert_eq!(
            editable_value_type(&RedisEditableValue::Hash(vec![hash_entry(
                "field", "value"
            )])),
            "hash"
        );
        assert_eq!(
            editable_value_type(&RedisEditableValue::List(vec!["value".to_string()])),
            "list"
        );
        assert_eq!(
            editable_value_type(&RedisEditableValue::Set(vec!["value".to_string()])),
            "set"
        );
        assert_eq!(
            editable_value_type(&RedisEditableValue::SortedSet(vec![RedisSortedSetEntry {
                member: "member".to_string(),
                score: 1.0,
            }])),
            "zset"
        );
        assert_eq!(
            editable_value_type(&RedisEditableValue::Stream(vec![RedisStreamEntry {
                id: "1-0".to_string(),
                fields: vec![hash_entry("field", "value")],
            }])),
            "stream"
        );
    }

    #[test]
    fn normalizes_redis_json_type_names() {
        assert_eq!(normalize_redis_type("ReJSON-RL"), "json");
        assert_eq!(normalize_redis_type("json"), "json");
        assert_eq!(normalize_redis_type("sorted_set"), "zset");
    }

    #[test]
    fn rejects_invalid_json_for_replacement() {
        assert!(
            validate_editable_value(&RedisEditableValue::Json("{\"ok\":true}".to_string())).is_ok()
        );
        assert!(validate_editable_value(&RedisEditableValue::Json("{broken".to_string())).is_err());
    }

    #[test]
    fn rejects_empty_collection_values_for_replacement() {
        assert!(validate_editable_value(&RedisEditableValue::Hash(Vec::new())).is_err());
        assert!(validate_editable_value(&RedisEditableValue::List(Vec::new())).is_err());
        assert!(validate_editable_value(&RedisEditableValue::Set(Vec::new())).is_err());
        assert!(validate_editable_value(&RedisEditableValue::SortedSet(Vec::new())).is_err());
        assert!(validate_editable_value(&RedisEditableValue::Stream(Vec::new())).is_err());
    }

    #[test]
    fn rejects_invalid_stream_entries_for_replacement() {
        assert!(
            validate_editable_value(&RedisEditableValue::Stream(vec![RedisStreamEntry {
                id: String::new(),
                fields: vec![hash_entry("field", "value")],
            }]))
            .is_err()
        );
        assert!(
            validate_editable_value(&RedisEditableValue::Stream(vec![RedisStreamEntry {
                id: "1-0".to_string(),
                fields: Vec::new(),
            }]))
            .is_err()
        );
        assert!(
            validate_editable_value(&RedisEditableValue::Stream(vec![RedisStreamEntry {
                id: "1-0".to_string(),
                fields: vec![hash_entry("", "value")],
            }]))
            .is_err()
        );
    }

    #[test]
    fn rejects_empty_rename_keys() {
        assert!(validate_rename_request(&RedisRenameKeyRequest {
            db_index: 0,
            key: String::new(),
            new_key: "target".to_string(),
            expected_fingerprint: fingerprint(),
        })
        .is_err());
        assert!(validate_rename_request(&RedisRenameKeyRequest {
            db_index: 0,
            key: "source".to_string(),
            new_key: " ".to_string(),
            expected_fingerprint: fingerprint(),
        })
        .is_err());
    }

    #[test]
    fn rejects_invalid_ttl_requests() {
        assert!(validate_ttl_request(&RedisSetKeyTtlRequest {
            db_index: 0,
            key: String::new(),
            expected_fingerprint: fingerprint(),
            mode: RedisSetKeyTtlMode::Persist,
            ttl_seconds: None,
        })
        .is_err());
        assert!(validate_ttl_request(&RedisSetKeyTtlRequest {
            db_index: 0,
            key: "source".to_string(),
            expected_fingerprint: fingerprint(),
            mode: RedisSetKeyTtlMode::Expire,
            ttl_seconds: None,
        })
        .is_err());
        assert!(validate_ttl_request(&RedisSetKeyTtlRequest {
            db_index: 0,
            key: "source".to_string(),
            expected_fingerprint: fingerprint(),
            mode: RedisSetKeyTtlMode::Expire,
            ttl_seconds: Some(0),
        })
        .is_err());
    }

    #[test]
    fn rejects_invalid_delete_key_requests() {
        assert!(validate_delete_key_request(&RedisDeleteKeyRequest {
            db_index: 0,
            key: String::new(),
            expected_fingerprint: fingerprint(),
        })
        .is_err());

        assert!(validate_delete_key_request(&RedisDeleteKeyRequest {
            db_index: 0,
            key: "session".to_string(),
            expected_fingerprint: fingerprint(),
        })
        .is_ok());
    }

    #[test]
    fn rejects_dangerous_delete_prefix_requests() {
        assert!(
            validate_delete_key_prefix_request(&RedisDeleteKeyPrefixRequest {
                db_index: 0,
                pattern: String::new(),
            })
            .is_err()
        );

        assert!(
            validate_delete_key_prefix_request(&RedisDeleteKeyPrefixRequest {
                db_index: 0,
                pattern: "*".to_string(),
            })
            .is_err()
        );

        assert!(
            validate_delete_key_prefix_request(&RedisDeleteKeyPrefixRequest {
                db_index: 0,
                pattern: "user:*".to_string(),
            })
            .is_ok()
        );
    }

    #[test]
    fn builds_empty_delete_prefix_result() {
        let result = delete_result(0, None, Some("user:*".to_string()), 0);

        assert_eq!(result.db_index, 0);
        assert_eq!(result.key, None);
        assert_eq!(result.pattern.as_deref(), Some("user:*"));
        assert_eq!(result.deleted_count, 0);
    }

    #[test]
    fn rejects_invalid_create_key_value_requests() {
        assert!(
            validate_create_key_value_request(&RedisCreateKeyValueRequest {
                db_index: 0,
                key: String::new(),
                value: RedisEditableValue::String("value".to_string()),
                ttl_policy: None,
                ttl_seconds: None,
            })
            .is_err()
        );

        assert!(
            validate_create_key_value_request(&RedisCreateKeyValueRequest {
                db_index: 0,
                key: "json-key".to_string(),
                value: RedisEditableValue::Json("{broken".to_string()),
                ttl_policy: None,
                ttl_seconds: None,
            })
            .is_err()
        );

        assert!(
            validate_create_key_value_request(&RedisCreateKeyValueRequest {
                db_index: 0,
                key: "ttl-key".to_string(),
                value: RedisEditableValue::String("value".to_string()),
                ttl_policy: Some(RedisTtlPolicy::Expire),
                ttl_seconds: Some(0),
            })
            .is_err()
        );
    }

    #[test]
    fn accepts_valid_create_key_value_requests() {
        assert!(
            validate_create_key_value_request(&RedisCreateKeyValueRequest {
                db_index: 0,
                key: "new-key".to_string(),
                value: RedisEditableValue::String(String::new()),
                ttl_policy: Some(RedisTtlPolicy::Expire),
                ttl_seconds: Some(60),
            })
            .is_ok()
        );
    }

    #[test]
    fn rejects_binary_string_payload_for_editable_value_contract() {
        let value = serde_json::json!({
            "kind": "string",
            "value": {
                "encoding": "binary",
                "byteLength": 2,
                "previewHex": "00 ff"
            }
        });

        assert!(serde_json::from_value::<RedisEditableValue>(value).is_err());
    }

    #[test]
    fn bytes_to_hex_preview_limits_output_length() {
        let preview = bytes_to_hex_preview(&[0, 1, 2, 255], 3);

        assert_eq!(preview, "00 01 02");
    }

    #[test]
    fn builds_exact_key_tree_counts_for_prefixes() {
        let tree = build_key_tree_result(
            0,
            "*".to_string(),
            vec![
                "session".to_string(),
                "user:1".to_string(),
                "user:profile:1".to_string(),
            ],
            &HashMap::new(),
        );

        assert_eq!(tree.total_key_count, 3);
        assert_eq!(tree.nodes.len(), 2);
        assert_eq!(tree.nodes[0].node_type, RedisKeyTreeNodeKind::Prefix);
        assert_eq!(tree.nodes[0].label, "user");
        assert_eq!(tree.nodes[0].prefix.as_deref(), Some("user:"));
        assert_eq!(tree.nodes[0].pattern.as_deref(), Some("user:*"));
        assert_eq!(tree.nodes[0].key_count, 2);
        assert_eq!(tree.nodes[1].node_type, RedisKeyTreeNodeKind::Key);
        assert_eq!(tree.nodes[1].key.as_deref(), Some("session"));
    }

    #[test]
    fn builds_nested_prefix_counts_and_sorts_folders_first() {
        let tree = build_key_tree_result(
            0,
            "*".to_string(),
            vec![
                "user:1".to_string(),
                "user:profile:1".to_string(),
                "user:profile:2".to_string(),
            ],
            &HashMap::new(),
        );

        let user = &tree.nodes[0];
        assert_eq!(user.key_count, 3);
        assert_eq!(user.children.len(), 2);
        assert_eq!(user.children[0].node_type, RedisKeyTreeNodeKind::Prefix);
        assert_eq!(user.children[0].label, "profile");
        assert_eq!(user.children[0].key_count, 2);
        assert_eq!(user.children[1].node_type, RedisKeyTreeNodeKind::Key);
        assert_eq!(user.children[1].key.as_deref(), Some("user:1"));
    }

    #[test]
    fn builds_key_tree_with_key_value_types() {
        let key_types = HashMap::from([
            ("session".to_string(), "ReJSON-RL".to_string()),
            ("user:profile:1".to_string(), "hash".to_string()),
        ]);
        let tree = build_key_tree_result(
            0,
            "*".to_string(),
            vec!["session".to_string(), "user:profile:1".to_string()],
            &key_types,
        );

        assert_eq!(tree.nodes[0].node_type, RedisKeyTreeNodeKind::Prefix);
        assert_eq!(tree.nodes[0].value_type, None);
        assert_eq!(
            tree.nodes[0].children[0].node_type,
            RedisKeyTreeNodeKind::Prefix
        );
        assert_eq!(tree.nodes[0].children[0].value_type, None);
        assert_eq!(
            tree.nodes[0].children[0].children[0].value_type.as_deref(),
            Some("hash")
        );
        assert_eq!(tree.nodes[1].key.as_deref(), Some("session"));
        assert_eq!(tree.nodes[1].value_type.as_deref(), Some("json"));
    }

    #[test]
    fn builds_empty_key_tree() {
        let tree = build_key_tree_result(0, "*".to_string(), Vec::new(), &HashMap::new());

        assert_eq!(tree.total_key_count, 0);
        assert!(tree.nodes.is_empty());
    }

    #[test]
    fn redis_keyspace_counts_parse_info_keyspace_lines() {
        let counts = parse_keyspace_counts(
            "# Keyspace\r\n\
            db0:keys=12,expires=0,avg_ttl=0\r\n\
            db2:keys=345,expires=10,avg_ttl=42\r\n",
        );

        assert_eq!(counts.get(&0), Some(&12));
        assert_eq!(counts.get(&2), Some(&345));
        assert_eq!(counts.get(&1), None);
    }

    #[test]
    fn redis_keyspace_counts_ignore_malformed_lines() {
        let counts = parse_keyspace_counts(
            "dbx:keys=12,expires=0\n\
            db1:expires=0,avg_ttl=0\n\
            db300:keys=9,expires=0\n\
            db3:keys=7,expires=0\n",
        );

        assert_eq!(counts.len(), 1);
        assert_eq!(counts.get(&3), Some(&7));
    }

    #[test]
    fn redis_database_container_carries_optional_item_count() {
        let container = redis_database_container("profile-1", 0, Some(42));

        assert_eq!(container.kind, ContainerKind::RedisDatabase);
        assert_eq!(container.container.db_index, Some(0));
        assert_eq!(container.item_count, Some(42));
    }

    #[test]
    fn groups_scanned_keys_into_prefix_containers() {
        let containers = test_driver().containers_from_scan(
            0,
            "*",
            vec![key("user:1"), key("user:profile:1"), key("session")],
        );

        assert_eq!(containers.len(), 2);
        assert_eq!(containers[0].kind, ContainerKind::RedisKeyPrefix);
        assert_eq!(containers[0].name, "user:");
        assert_eq!(containers[0].container.pattern.as_deref(), Some("user:*"));
        assert_eq!(containers[1].kind, ContainerKind::RedisKey);
        assert_eq!(containers[1].name, "session");
    }

    #[test]
    fn groups_nested_prefixes_relative_to_parent_pattern() {
        let containers = test_driver().containers_from_scan(
            0,
            "user:*",
            vec![key("user:1"), key("user:profile:1")],
        );

        assert_eq!(containers.len(), 2);
        assert_eq!(containers[0].kind, ContainerKind::RedisKeyPrefix);
        assert_eq!(containers[0].name, "user:profile:");
        assert_eq!(
            containers[0].container.pattern.as_deref(),
            Some("user:profile:*"),
        );
        assert_eq!(containers[1].kind, ContainerKind::RedisKey);
        assert_eq!(containers[1].name, "user:1");
    }

    #[test]
    fn redis_url_omits_database_path_when_db_index_is_empty() {
        assert_eq!(build_redis_url(&profile(None)), "redis://localhost:6379");
    }

    #[test]
    fn redis_url_keeps_database_path_when_db_index_is_present() {
        assert_eq!(
            build_redis_url(&profile(Some(2))),
            "redis://localhost:6379/2"
        );
    }

    #[test]
    fn redis_url_uses_resolved_endpoint() {
        let mut profile = profile(Some(2));
        profile.use_tls = true;

        assert_eq!(
            build_redis_url_for_endpoint(&profile, "127.0.0.1", 49152),
            "rediss://127.0.0.1:49152/2"
        );
    }

    #[test]
    fn redis_connect_timeout_defaults_and_clamps() {
        let mut profile = profile(None);
        assert_eq!(
            RedisDriver::connect_timeout(&profile),
            Duration::from_secs(5)
        );

        profile.connect_timeout_seconds = Some(0);
        assert_eq!(
            RedisDriver::connect_timeout(&profile),
            Duration::from_secs(1)
        );

        profile.connect_timeout_seconds = Some(301);
        assert_eq!(
            RedisDriver::connect_timeout(&profile),
            Duration::from_secs(300)
        );
    }
}
