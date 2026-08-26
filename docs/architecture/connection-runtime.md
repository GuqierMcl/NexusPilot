# 数据库连接架构设计

> 本文档是连接模块当前实现的权威参考。跨连接池、HTTP、云 API 和未来 transport 的产品层生命周期语义见 [database-runtime-session.md](./database-runtime-session.md)；新增驱动的条目级步骤见 [add-new-database-driver.md](../development/add-new-database-driver.md)。

---

## 1. 边界

NexusPilot 现在有两套清晰分离的数据库运行边界。

| 层级 | 代码 | 职责 |
|------|------|------|
| 应用元数据池 | `DatabaseState.pool` | 本地 SQLite：连接列表、文件夹、配置 CRUD |
| 用户数据源 runtime | `ConnectionRuntimeManager` | 远端 PG/MySQL/Redis/Oracle/ClickHouse 与本地 SQLite 文件的建连、浏览、查询与 Tab 隔离 |

产品和架构文档把用户数据源 runtime 称为**数据库运行时会话（Database Runtime Session）**。它表示 stored profile 已通过真实探测物化为可工作的 runtime，不承诺某条 TCP socket 常驻。SQLx pool、Oracle pool、Redis connection、SQLite file handle、HTTP client、SSH tunnel 和未来 cloud SDK 都属于具体 driver 内部 transport 资源。

当前代码已实现 `idle/connecting/connected/degraded/reconnecting/error/disconnecting` 七态通用状态机。错误影响、有限恢复、缓存保留和断开取消规则定义在 [database-runtime-session.md](./database-runtime-session.md)；公共实现没有 ClickHouse driver-name 分支。

存储层 IPC 继续走 `src/lib/tauri/connections.ts` 的直接 `invoke`。Engine IPC 统一走 `apiInvoke()`，并返回结构化 `IpcError`。

AI Runtime 经 Backend Bridge/Rust Gateway 进入数据库能力时，和 Frontend/Tauri IPC 使用不同入口，但不得形成第二套 Engine。两种入口共同调用 Workbench Application Service，并复用 Tauri managed 的同一个 `DatabaseState` 与 `ConnectionRuntimeManager`：

```text
Frontend intent ── Tauri Command ─┐
                                  ├─ Workbench Application Service
AI Runtime intent ─ Gateway Op ───┘      ├─ DatabaseState / Repository
                                         └─ ConnectionRuntimeManager
                                              └─ 同一 Driver / pool / tunnel
```

入口可以记录 `Frontend` / `AiRuntime` origin，但 origin 只用于日志、审计和通知，不得产生两份连接池、连接状态机、attempt generation、恢复协调器或 Driver runtime。Gateway 不能调用 Tauri Command；Tauri Command 也不能通过 Gateway 绕行。

L6.5-A 已新增 `src-tauri/src/workbench/application_service.rs`。连接 list/get/open、stored profile 读取与 connect、disconnect、metadata children、table describe/query 和 Key/Value scan/get 已收敛到共享方法；Command 的 IPC DTO 和错误行为保持不变。Gateway 已把 `connection.list/get/open`、`metadata.list_children/describe_table`、`table.query` 与 `key_value.scan/get` 注册为真实 Operation，它们持有 managed state 的共享 clone，底层 `SqlitePool` 与 `ConnectionRuntimeManager` 内部状态仍是同一组 `Arc` 事实。`connection.open` 已打开时直接复用当前 shared runtime，不重建 Driver 或连接池。

L6.5-B 也已实现：`ConnectionRuntimeManager` 提供 materialized shared runtime 的 `ConnectionRuntimeSnapshot`；`list_connection_runtime_snapshots` 是 React 恢复用的只读 IPC。共享 Service 在 connect/open、disconnect 与 health probe 后 best-effort 发布 `connection-runtime-changed` Tauri Event，事件为 `upsert(snapshot)` 或 `removed(profileId)`，并记录 `frontend / aiRuntime` origin。事件投递失败不回滚已提交的 runtime 状态。

Rust 后端通过 `tauri-plugin-log` 初始化日志系统，默认写入 stdout 和 Tauri app log 目录，并在开发终端中按 level 显示颜色。数据库 engine 的失败诊断集中在 `src-tauri/src/engine/diagnostics.rs`：`ConnectionRuntimeManager` 会在所有驱动 trait 调用返回 `IpcError` 时记录 `operation`、`driver`、`profileId`、可选 `tabId`、可选 `ContainerRef` 摘要、错误码、用户消息和底层 details。日志只用于诊断，不改变 IPC 返回结构，也不记录连接 payload、密码或 SSH 密钥。后端日志实现约束见 [backend-logging.md](../development/backend-logging.md)。

---

## 2. Rust Runtime

`src-tauri/src/engine/manager.rs`：

```rust
pub struct ConnectionRuntimeManager {
    shared: Arc<RwLock<HashMap<String, ProfileRuntime>>>,
    tabs: Arc<RwLock<HashMap<String, TabRuntime>>>,
    shared_connect_attempts: Arc<RwLock<HashMap<String, RuntimeConnectAttempt>>>,
    tab_connect_attempts: Arc<RwLock<HashMap<String, RuntimeConnectAttempt>>>,
    next_connect_attempt_id: Arc<AtomicU64>,
    sql_executions: SqlExecutionCoordinator,
}

struct ProfileRuntime {
    driver: Arc<dyn DatabaseDriver>,
    health: Arc<RwLock<RuntimeHealthSnapshot>>,
}
```

Shared runtime 用于 Explorer、capability 查询、ping、只读容器浏览和表数据浏览。Tab runtime 用于 SQL editor、事务、长查询取消和连接级上下文隔离。

Shared/tab runtime 的边界按用户操作和资源清理划分，不按 socket 是否独占划分。HTTP client clone 即使共享内部连接池，SQL query id、取消句柄、执行进度或 mutation watch 仍应放入 tab runtime 或 focused 观察 runtime。

具体资源只存在于驱动结构体内部：

- PostgreSQL：`src-tauri/src/engine/drivers/postgres/`
- MySQL：`src-tauri/src/engine/drivers/mysql/`
- Redis：`src-tauri/src/engine/drivers/redis.rs` + `src-tauri/src/engine/drivers/redis_validate.rs`
- Oracle：`src-tauri/src/engine/drivers/oracle/`
- SQLite：`src-tauri/src/engine/drivers/sqlite.rs`
- ClickHouse：`src-tauri/src/engine/drivers/clickhouse/`

Manager 的 runtime entry 持有 `Arc<dyn DatabaseDriver>` 和通用 `RuntimeHealthSnapshot`，不再持有 `DatabasePool` enum，也不在 manager 中按驱动 `match` 分发。只有 `ping()` 会更新后端 health snapshot：成功恢复为 `healthy`，`retryable` 失败变为 `degraded`，`terminal` 失败变为 `error`，`businessOnly` 不改变 health。

Shared/tab runtime 的构造也由 Manager 管理 attempt generation。新一轮同 key 建连会替换并取消旧 attempt；`disconnect_profile` 同时取消该 profile 的 shared attempt 和全部 tab attempts，`close_tab_runtime` 取消对应 tab attempt。driver 构造 future 与取消信号通过 `tokio::select!` 竞争；构造完成后仍须在 attempt 锁内确认代次，并与 runtime map 写入原子提交。失效 driver 会先 close/drop 再返回 `OPERATION_CANCELED`，因此断开与初始 probe 并发时不会在断开后注册迟到 runtime。

Manager 还持有中性的 `SqlExecutionCoordinator`，按 `profileId + tabRuntimeId + executionId` 管理可选 managed SQL execution。启动 managed execution 时，Manager 必须先通过 `ManagedSqlExecutor::classify_statement` 完成 driver-owned 同步分类，再向 coordinator 注册快照；分类失败不能留下 orphan execution。公共 Manager 只保存中性的 `SqlStatementClass`，不解析 ClickHouse 或其他方言。`resultMode=raw` 还必须在生成 execution/query ID、分类和注册前通过中性 `sqlExecution.rawResult` gate；未声明该能力的驱动返回 `VALIDATION_FAILED`，不会调用 driver 或创建 artifact。

AI Runtime 的 ClickHouse `sql.execute` 在 shared profile runtime 上调用同一个 `ManagedSqlExecutor`，但不创建前端 tab/coordinator snapshot。Manager 仍负责 capability gate、唯一 execution/query id、固定 30 秒 backend timeout、driver timeout/cancel/query-wins 及观察告警收敛；只开放 bounded Grid 与 direct statement access。该路径复用现有 driver 和连接，不建立 AI 专用连接池或另一套 managed lifecycle。异步 mutation 的 command acknowledgement 只表示 `submitted`，不表示后台 mutation 已完成。

Raw execution 的临时结果由 Manager-owned `RawArtifactStore` 管理，而不是由 driver、前端或连接 profile 持有。Manager 在成功注册 Raw execution 后创建唯一、不可复制的 writer，并随 `ManagedSqlExecutionRequest` 移交给 driver；snapshot 只暴露 opaque artifact ID。store 以 `profileId + tabRuntimeId + executionId + artifactId` 校验另存所有权，生产文件位于 OS temp 下的 NexusPilot 专属目录，文件名只使用 UUID。单 artifact 上限为 512 MiB，文本 preview buffer 为 1 MiB，已知二进制格式使用最多 4 KiB 的 `[hex]` preview；超过上限、取消、transport 失败或 owner teardown 都删除 partial file。

`close_tab_runtime` 必须先 signal-and-discard 该 tab 的 execution entry并释放对应 Raw artifacts，再移除 tab runtime 和关闭 driver；`disconnect_profile` 同样先 signal-and-discard 该 profile 的全部 execution entries、释放 profile artifacts，再移除 shared/tab runtimes。新 execution 会清理被替换的 terminal Raw artifact，显式 `release_sql_execution` 清理单次 execution，app teardown 清理全部 execution/artifact。discard 会触发本地 cancellation watch token 并删除 ownership，迟到的 driver completion 只能得到 `RESOURCE_NOT_FOUND`，不得重新创建或复活快照。本地 token 只表达“客户端不再等待/ownership 正在回收”，永远不等价于服务端已确认停止。

ClickHouse Phase 4A 的用户取消会先把 snapshot 推进到 `canceling`，再在后台使用独立 control request 执行 bound `KILL QUERY WHERE query_id = ? SYNC`。只有 exact target 的单条 `kill_status=finished` 才能产生 `canceled`；query 若先成功完成，则由 query-wins 竞态进入 `succeeded`；权限、transport、`waiting`、ID mismatch 或其他未确认结果进入 `cancelFailed`，且迟到 control completion 不能覆盖任何 terminal snapshot。managed operation timeout 保持 `OPERATION_TIMEOUT + businessOnly`，随后 best-effort 复用服务端停止路径；无论停止是否确认，主终态仍是 `timedOut`，未确认只追加观察告警。

`SqlExecutionSnapshot.observationWarnings` 属于连接运行时 B 域，用于 progress/control 的非致命降级。Coordinator 对其去重、最多保留 4 条并把每条截断到 256 个 Unicode scalar values；有效新增会递增 revision 并发布 Channel，重复、容量已满或迟到 terminal 写入不会改变查询主终态。

### 2.1 网络高级选项

PostgreSQL、MySQL、Redis、Oracle、ClickHouse 的网络型 profile 可包含 `connectTimeoutSeconds` 与内嵌 `sshTunnel` 配置。当前阶段不提供共享 SSH profile；SSH 隧道配置随连接 payload 保存。

启用 SSH 时，Rust engine 先通过 `russh` 连接跳板机，再在本地 `127.0.0.1:0` 绑定临时监听端口，并通过 SSH `direct-tcpip` channel 转发到原始数据库 `host:port`。具体驱动只接收解析后的本地 endpoint，并把 `SshTunnelRuntime` 持有在 driver 结构体中，从而让隧道生命周期与数据库 driver 生命周期一致。PostgreSQL 的 database-specific pools 也必须复用同一个本地 tunnel endpoint。

`connectTimeoutSeconds` 当前作用在 SQLx pool acquisition / initial connect、Redis async connection open、Oracle `oracle-rs` / `deadpool-oracle` pool acquisition，以及 ClickHouse 的每一段 HTTP probe 上，默认 5 秒，允许范围为 1-300 秒。SSH 握手本身使用 engine 内部固定超时，避免跳板机无响应时无限等待。

SSL/TLS 仍由各驱动映射：

- PostgreSQL：`disable`、`require`、`verify-ca`、`verify-full`。
- MySQL：`disable`、`require`、`verify-ca`、`verify-identity`。
- Redis：沿用 `useTLS`，但 UI 位于 `SSL` 标签页。
- Oracle：Phase 1 不暴露 SSL/TLS、wallet、TNS_ADMIN 或 LDAP naming 配置；`connectDescriptor` 只接受 EZConnect 风格，且不能与 SSH Tunnel 同时使用。
- ClickHouse：`protocol=http|https`；HTTPS 使用官方 client 的 rustls 与系统原生根证书，不提供跳过证书或 hostname 校验的选项。

当 SSH 隧道启用时，数据库客户端实际连接的是本地 loopback endpoint；因此 PostgreSQL `verify-full`、MySQL `verify-identity` 与 ClickHouse HTTPS 会被后端拒绝，避免对 `127.0.0.1` 做错误的 hostname identity/SNI 校验。ClickHouse HTTP + SSH 受支持，并由 driver 持有 tunnel；direct HTTPS 保留原始 hostname。已保存的 `hostKeyFingerprint` 会在 SSH 握手时校验；无 fingerprint 时按 trust-on-first-use 接受本次 server key，并在 `test_connection_config` 返回 `sshHostKeyFingerprint` 供前端回填到当前表单。

---

## 3. Capability Traits

`src-tauri/src/engine/driver.rs` 定义统一能力接口：

| Trait | 职责 | 首批驱动 |
|-------|------|----------|
| `DatabaseDriver` | profile id、driver name、capabilities、ping、close | PG / MySQL / Redis / Oracle / SQLite / ClickHouse |
| `SchemaBrowser` | `list_containers(parent?)` | PG / MySQL / Redis / Oracle / SQLite / ClickHouse |
| `SchemaMutator` | 数据库结构变更、SQL 预览与 MySQL 字符集查询 | PG / MySQL / Oracle |
| `NativeSchemaExtension` | 使用 tagged support/session request、document、target/result 描述并变更不能被关系型 `TableSchema` 无损表达的原生结构 | ClickHouse Phase 5A–5D Table/Object 与 Phase 5E View/MV、Temporary session |
| `DataTableBrowser` | `browse_table_data(container, page, pageSize, query)`、`get_table_page_stats(..., query)`、DataTable change set 预览与提交；结构化过滤值使用参数绑定 | PG / MySQL / Oracle / SQLite / ClickHouse |
| `TransactionManager` | DataTable tab runtime 事务开始、提交、回滚与状态读取 | PG / MySQL / Oracle / SQLite |
| `SqlExecutor` | `execute_sql(context, sql, page, pageSize)` | PG / MySQL / Oracle / SQLite / ClickHouse（legacy 路径继续保持只读 policy） |
| `ManagedSqlExecutor` | 可选的 start/control execution lifecycle，接收 query ID、取消 token、summary observer 与可选唯一 Raw writer | ClickHouse Phase 4A/4B/4C；通用 fake 覆盖 Manager 竞态 |
| `KeyValueBrowser` | Redis key tree/scan/value browse、stable value precondition，以及原子单 Key create/set/rename/TTL/delete | Redis |

`DriverRegistry` 负责把 `StoredConnectionRecord { driver, payload }` 注入 `driver` 字段后反序列化为 `DriverProfile`，再创建具体 driver。

ClickHouse 在动态结果基础上开启 `schemaBrowser=true`、`dataTableBrowser=true`、`sqlExecutor=true`、`tableRowMutator=true` 与 `tableRowInserter=true`。Table/View/MaterializedView 均可浏览；只有普通 Local `MergeTree/ReplacingMergeTree` Table 的已支持标量列可写，View/MV、复杂列和其他 engine 保持只读。自由 SQL 与底层动态读取仍强制只读；DataTable 写入只走后端生成的 typed DML、行快照 locator 和受控 change set。

ClickHouse Phase 5A 已通过 `NativeSchemaExtension` 增加 strong typed table Describe：Manager 接收 tagged `NativeSchemaDescribeRequest`，驱动组合 `system.*` catalog 与 canonical CREATE，返回 identity、engine、columns、keys、TTL/settings、projection、data-skipping index、editability blocker 和稳定 SHA-256 revision。前端通过独立 `clickhouse_table_design` surface 展示这些事实，并保留 Columns、Engine & Keys、TTL & Settings、Projections、Data-skipping Indexes 五个 section；可无损证明的主表和对象还必须命中各自精确 capability 才能写入，其余 restricted/readonly 对象继续无损只读。

Phase 5B 在同一通用 extension 上增加 tagged `NativeSchemaCreateTarget`、preview、execute 与 applied result。Phase 5C 再增加 `NativeSchemaChangeTarget/Plan/Baseline/ExecuteRequest/Result`；Phase 5D 沿用该通道增加 Projection/Index 的八个精确 target；Phase 5E 又增加 View support/document、View/MV create/alter/rename/drop 与 Temporary session document。Manager 先按 object/operation、destructive confirmation 与 remote drift protection capability gate，再分发给 extension。基础版 `schemaMutation` 精确包含七个对象项：Database Create/Drop、Table Create/Alter/Drop、Column Clear/Materialize、Projection Create/Drop/Clear/Materialize、Index Create/Drop/Clear/Materialize，以及 View/MV Create/Alter/Rename/Drop；三项保护设施均开启。ClickHouse 仍保持 `schemaMutator=false`、`as_schema_mutator()=None`，因为它没有实现关系型 `SchemaMutator`；`runtime_info()` 只要求 legacy `schemaMutator=true` 时必须有结构化 `schemaMutation`，不要求原生 mutation capability 反向伪装为 legacy trait。

Native change preview 携带完整 canonical baseline、operation summaries、expected target revision 和 domain-separated plan hash。execute 必须携带同一 strong typed target、preview baseline、hash 与 `confirmDestructive`；Manager 和 driver 都会重新执行 capability/planner/protection gate，driver 还会在发送前重新读取远端 full baseline。Table ALTER 使用完整 baseline + desired target + explicit rename intent；Database Drop baseline 包含 database identity 与排序后的 child object/create-query snapshot。DDL 不自动重试，每条 statement 使用独立 query id，第一条失败后停止；结果以 `applied/submitted/partiallyApplied/outcomeUnknown` 和精确 statement progress 返回。`RESOURCE_CONFLICT`、validation 与 destructive-no-confirm 都是 `businessOnly`，只有 transport/timeout 类失败沿用 retryable runtime impact。

Phase 5D 的对象 target 同样携带完整 table baseline。Projection query 只接受受控单条 `SELECT` body；Index 只接受 `minmax/set/bloom_filter/ngrambf_v1/tokenbf_v1` 与精确参数域。Create 只有 post-Describe definition match 后才是 applied，Drop 只有 absence proof 后才是 applied，Materialize/Clear 只覆盖 whole-table object 并在 server accepted 后返回 submitted；不支持 `IN PARTITION`、rename 或 inline modify。ClickHouse 26.5 Describe 优先读取 `system.data_skipping_indices.type_full`，旧 catalog 缺少该列时回退 `type`，信息仍不完整则保持 lossless readonly。

Phase 5E 的 View runtime 使用七个稳定 family tag：`normal`、`parameterized`、`temporary`、`materialized`、`refreshable_materialized`、`window`、`live`。每个 family 的 Describe/Create/Alter/Rename/Drop 都由运行时 support snapshot 返回 `supported/unsupported/unknown`；权限不足映射为 `unknown/PERMISSION_DENIED`，服务端版本或 edition 明确缺失才映射为 `unsupported/FEATURE_UNAVAILABLE`。Local 与 Temporary scope 已发布；Cluster 类型、topology/full-node baseline、outcome aggregation 与 redaction 仍保留，但基础版始终返回 `clusterDdl.executable=false`，所以 `ON CLUSTER` preview/execute 在任何 DDL 前 fail closed。

Temporary View 只属于 owner SQL tab runtime。tab driver 惰性创建后端 `ClickHouseHttpSession`，串行执行同 session 请求并跟踪已创建的 Temporary View；物理 `session_id` 只存在于 Rust 私有状态，不进入 IPC、前端、profile、持久化或日志。`clickhouse_view_design` dependent tab 自己不拥有后端 runtime；关闭 owner、断开 profile 或 app teardown 会级联清理 dependents 并使 session 过期，过期后不会自动重建旧对象。

Phase 4A/4B/4C 已为 ClickHouse 原子开启 `sqlExecution={ managedLifecycle: true, statementAccess: direct, activeCancel: true, liveProgress: true, querySummary: true, rawResult: true, configurableTimeout: true }`。Read 语句仍使用 `ReadOnlyGrid`；已分类的 DDL、INSERT、DELETE、Mutation、SYSTEM 与普通 command 使用 `DirectGrid` 和 official `Query::execute()`，设置 `wait_end_of_query=1`，不追加结果 FORMAT；Unknown 使用 server-authoritative `DirectGrid`。command completion 不伪造 affected rows，只有服务端完成级 summary 才进入终态 outcome；partial live progress 只用于运行中观察。Mutation 的 command success 只表示请求已提交，不表示 `system.mutations` 中的任务已经完成。

显式 Raw 单语句使用 `DirectRaw` 和 official `fetch_bytes("TabSeparatedRaw")`。该参数只提供 server default format，不改写用户 SQL；用户顶层 `FORMAT` 优先决定响应格式。CSV/TSV/JSON/XML 使用文本 preview，Parquet/Arrow/Native/ORC/Avro 使用二进制 hex preview，byte length 通过 JSON-safe serializer 进入 snapshot。`INTO OUTFILE` 是服务端副作用；zero-byte response 映射为中性 Command outcome，不创建本地空 artifact，也不声称文件已保存到用户机器。

`DriverCapabilities.sqlExecutor` 继续表示“可以打开并使用 SQL Editor”；可选 `DriverCapabilities.sqlExecution` 描述 managed lifecycle、statement access、active cancel、live progress、query summary、raw result 和 configurable timeout。Direct SQL/Raw 与 DataTable write 是独立授权：ClickHouse row mutation/insertion 由 DataTable capability 和每次 `QueryResult` 的资源能力共同决定，仍不启用关系型 `schemaMutator` 或 `transactionManager`。

SQL 查询编辑器在 `SqlExecutor` 与 managed execution 调用路径中都传入结构化执行上下文：`database` 与可选 `schema`。该上下文由前端的连接/数据库/schema 选择器传入，不能通过前端向用户 SQL 文本前拼接隐藏 `USE`、`SET search_path`、`ALTER SESSION` 等语句实现。MySQL 只接受 database 级上下文；PostgreSQL 接受 database + schema 级上下文；Oracle 接受 schema 级上下文，后端在单次 pooled connection 上执行 `ALTER SESSION SET CURRENT_SCHEMA` 并在返回连接前重置；SQLite 使用文件 database 节点作为上下文且拒绝 schema；ClickHouse 接受 database-only context，并通过 clone 后的 request client `with_database` 选择数据库，不改写原始 SQL。详见 [sql-editor.md](../development/sql-editor.md)。

---

## 4. Engine IPC

| 命令 | 说明 |
|------|------|
| `connect_profile` | 以可取消 attempt 创建 profile shared runtime；真实 probe 与原子注册完成后返回 capabilities |
| `disconnect_profile` | 取消未完成的 shared/tab attempts，并关闭已注册的 profile shared runtime 和关联 tab runtime |
| `test_connection` | ping |
| `get_connection_runtime_health` | 读取 shared runtime 的 `RuntimeHealthSnapshot` |
| `test_connection_config` | 使用表单配置临时建连、测试并释放资源，不创建 shared runtime |
| `get_connection_capabilities` | 读取后端真实 capabilities |
| `open_tab_runtime` | 创建 tab runtime |
| `close_tab_runtime` | 释放 tab runtime |
| `list_containers` | 返回统一 `DataContainer[]`；Redis `redis_database` 可携带 `itemCount` 作为 DB key 总数 |
| `describe_clickhouse_table_schema` | 通过 generic native schema extension 返回 strong typed ClickHouse table schema、editability blocker 与稳定 baseline |
| `preview_create_clickhouse_database` / `create_clickhouse_database` | Phase 5B native database create preview/execute |
| `preview_create_clickhouse_table` / `create_clickhouse_table` | Phase 5B native table create preview/execute |
| `preview_alter_clickhouse_table` / `alter_clickhouse_table` | Phase 5C strong typed table ALTER preview/execute |
| `preview_clickhouse_column_action` / `execute_clickhouse_column_action` | Phase 5C 整列 CLEAR/MATERIALIZE preview/execute；成功接收返回 submitted |
| `preview_drop_clickhouse_table` / `drop_clickhouse_table` | Phase 5C native table drop；后端确认与 absence proof 必需 |
| `preview_drop_clickhouse_database` / `drop_clickhouse_database` | Phase 5C native database drop；child object snapshot drift 与 absence proof 必需 |
| `preview_clickhouse_projection_change` / `execute_clickhouse_projection_change` | Phase 5D Projection Create/Drop/Materialize/Clear；完整 table baseline 与精确 operation gate |
| `preview_clickhouse_skipping_index_change` / `execute_clickhouse_skipping_index_change` | Phase 5D data-skipping Index Create/Drop/Materialize/Clear；五类 allowlist 与精确 operation gate |
| `get_clickhouse_view_runtime_support` | 读取七类 View family、Local/Temporary/Cluster 范围与 `supported/unsupported/unknown` support snapshot |
| `describe_clickhouse_view_schema` | 读取 persistent 或 owner-scoped Temporary View/MV 强类型 schema；Temporary 必须带 owner tab runtime |
| `preview_create_clickhouse_view` / `create_clickhouse_view` | View/MV create preview/execute；target 绑定 support revision，Cluster 基础版在发送前拒绝 |
| `preview_change_clickhouse_view` / `execute_clickhouse_view_change` | View/MV Alter/Rename/Drop；完整 View 或 Cluster baseline、typed confirmation、drift 与 post-proof |
| `list_clickhouse_temporary_views` | 只列出指定 owner tab runtime 的 Temporary View schema，不使用 shared Explorer |
| `preview_create_database` | 由驱动生成创建数据库 SQL 预览 |
| `create_database` | 通过 `SchemaMutator` 在关系型连接上创建数据库 |
| `preview_update_database` | 由驱动生成编辑数据库 SQL 预览 |
| `update_database` | 通过 `SchemaMutator` 编辑数据库属性 |
| `preview_drop_database` | 由驱动生成删除数据库 SQL 预览 |
| `drop_database` | 通过 `SchemaMutator` 删除数据库 |
| `preview_drop_table` | 由驱动根据普通表 `ContainerRef` 生成 DROP TABLE SQL 预览，并标记 destructive |
| `drop_table` | 通过 `SchemaMutator` 删除普通表；执行时必须传 `confirmDestructive=true` |
| `list_mysql_character_sets` | MySQL 专用：执行 `SHOW CHARACTER SET` 获取字符集选项 |
| `get_mysql_database_character_set` | MySQL 专用：读取 database 当前默认字符集 |
| `browse_table_data` | 根据 `ContainerRef` 安全浏览表/视图 |
| `get_table_page_stats` | 按同一 `TableBrowseQuery` 读取 DataTable 总行数与总页数快照 |
| `preview_table_change_set` | 预览 DataTable insert/update/delete change set 的 DML SQL |
| `commit_table_change_set` | 提交 DataTable insert/update/delete change set；事务中写入当前 tab pinned connection |
| `update_table_row` | 旧单行更新入口；由驱动复用 change set 提交路径 |
| `delete_table_rows` | 旧删除入口；由驱动复用 change set 提交路径 |
| `begin_tab_transaction` | 在 DataTable tab runtime 上开启事务 |
| `commit_tab_transaction` | 提交 DataTable tab runtime 活动事务 |
| `rollback_tab_transaction` | 回滚 DataTable tab runtime 活动事务 |
| `get_tab_transaction_state` | 读取 DataTable tab runtime 事务状态 |
| `execute_sql` | 执行用户显式 SQL；SQL 编辑器传入必需的 `tabId` 与结构化 context，并限制单次执行一个语句 |
| `start_sql_execution` | 为声明 `sqlExecution.managedLifecycle=true` 的 tab runtime 启动 managed execution，通过 Tauri Channel 推送低延迟快照事件并立即返回 handle |
| `get_sql_execution_snapshot` | 按 profile/tab/execution ownership 读取权威快照；用于 Channel 丢事件后的恢复与轮询对账 |
| `cancel_sql_execution` | 请求 managed execution 取消并立即返回 `canceling`；后台 control 只有获得服务端确认才发布 `canceled`，query-wins 或失败终态经 Channel/snapshot reconciliation 到达 |
| `release_sql_execution` | 仅释放 terminal execution entry；active execution 返回 `RESOURCE_CONFLICT` |
| `browse_key_tree` | Redis key 前缀树摘要 |
| `scan_key_values` | Redis key scan |
| `get_key_value` | Redis value 结构化读取，包含 TTL 与 `MEMORY USAGE` 大小 |
| `set_key_value` | Redis value 整体替换；要求 expected fingerprint，以临时键 + WATCH/MULTI/EXEC 原子切换 |
| `create_key_value` | Redis 单 Key 创建；临时构建后原子发布，并发出现同名目标时拒绝覆盖 |
| `delete_key` | Redis 精确单 Key 删除；要求 expected fingerprint 并以 WATCH/MULTI/EXEC 提交 |
| `delete_key_prefix` | Workbench 前缀批量删除；仍使用 SCAN + batch DEL，不属于 Agent Tool 或一次性计划 |
| `rename_key` | Redis key 重命名；绑定 source fingerprint 与 destination absent，不覆盖并发目标 |
| `set_key_ttl` | Redis TTL 独立修改；要求 expected fingerprint，expire/persist 通过 WATCH/MULTI/EXEC 提交 |

Redis value precondition 取自 `DUMP key` bytes 的 SHA-256，格式为 `sha256:<64 lowercase hex>`。`get_key_value` 与 Agent prepare 使用前后两次 DUMP 检查稳定读取；DUMP 不包含 TTL，因此自然倒计时不会使值指纹漂移。set/create 先在 `__nexuspilot:kvtmp:<uuid>` 临时键构建完整 string/json/hash/list/set/zset/stream 值，临时键带 5 分钟保护 TTL；最终事务原子 rename 到目标并应用 TTL。构建失败或 CAS conflict 时 best-effort 清理临时键，mutation 不自动重试。

---

## 5. 前端数据流

### 5.1 连接状态

`src/store/slices/connection-session-slice.ts`：

```text
idle/error -> connecting -> connect_profile -> connected/error
connected -> degraded -> reconnecting -> connected/error
connecting/connected/degraded/reconnecting/error -> disconnecting -> idle
```

Session 保存 `status`、`ping`、`errorMsg`、`activeDatabase`、后端返回的 `capabilities` 和可选 recovery 摘要。初次 `connect_profile` 已由 driver 完成真实探测，因此前端不会再额外 ping；每轮 connect 同时持有前端 attempt identity，disconnect 或更新一轮 connect 会使旧 success/error 失效。后续只有显式 `retryable` 失败触发最多三次 `test_connection` 恢复探测，延迟为 `0/500/1500ms`。同一 profile 的重复失败去重，disconnect 先取消恢复和 connect attempt。Explorer 在 `connecting/connected/degraded/reconnecting/error` 均提供关闭入口（`error` 同时允许重新连接）。

Frontend 已通过全局 `WorkbenchRuntimeProjection` 观察 Rust → React 的 Workbench Domain Event，并使用只读 Runtime Snapshot 对账：

```text
ConnectionRuntimeManager / Application Service
  -> 状态提交成功
  -> Tauri Workbench Domain Event
  -> React listener
  -> connectionSessionStore / Query cache / Explorer projection

Frontend 启动、监听重建或显式恢复
  -> Runtime Snapshot IPC
  -> 与 Rust 当前事实重新对账
```

设计约束：

- Rust 的 `ConnectionRuntimeManager` 是连接 runtime、health 和 capability 的事实来源；
- Frontend session 是面向 UI 的完整生命周期投影，不自行推断一套独立的后端连接事实；
- Tauri Event 是低延迟通知，不是事实存储；漏掉通知后必须能由 Snapshot IPC 恢复；
- Frontend 与 AI Runtime 发起的状态变更都在共享 Service 成功提交后发布同一种 Domain Event；
- Event payload 只投影前端所需的 profile ID、生命周期状态、capability/health 摘要和可选 origin，不暴露连接 payload、credential、pool 或 Driver 内部对象；
- 连接状态事件负责同步 `connected / disconnected / health / capabilities`；“选中连接、展开 Explorer、打开页面”等 UI 协调意图使用单独事件语义，不能伪装成连接状态；
- 这条链路属于 Rust/Tauri → React Workbench 域，不复用 AI Runtime EventBus/SSE，也不转发 Backend Bridge Frame。

React 初始化时先建立 Event listener 再读取 Snapshot；Snapshot 请求期间到达的事件会先缓存，并在 Snapshot 投影后按到达顺序重放，避免旧 Snapshot 覆盖更新事件。窗口重新获得焦点时再次读取 Snapshot，用于修复漏事件或 listener 重建期间的偏差。`removed` 同时清理对应 tabs、Explorer metadata 与 profile Query cache。

Snapshot 只恢复连接 runtime 事实，不携带某个 WebView 已加载的 Explorer children。刷新 WebView 后，即使 session 已投影为 `connected`，连接节点仍须按 `loadedChildren` 独立判断是否执行首次 `list_containers`；不得用 connected 状态推断 metadata 已 hydration。

第一版只实现状态变更事件和当前 Runtime Snapshot，不引入 durable event log、跨启动 replay、revision 协议或第二套前端恢复状态机。

### 5.2 Explorer

`src/features/workbench/explorer/useExplorerMetadataStore.ts` 展开远端节点时：

1. 展开 connection：先调用 `sessionStore.connect(profileId)`。
2. 只有 session 为 `connected` 且 `capabilities.schemaBrowser=true` 时调用 `list_containers(profileId, parent?)`。
3. `buildRemoteNodes.ts` 将 `DataContainer.kind` 映射成 Explorer 节点类型。

前端不再调用分散的库/表/列 IPC，也不再用 `isRedis` 分支伪装层级。关系型对象分组由后端返回为 `asset_group + groupType`，Redis DB、key prefix、key 也均由后端返回为 `DataContainer`。Redis `redis_database` 节点可通过通用 `DataContainer.itemCount` 返回该逻辑库 key 总数；Explorer 不对 `redis_key_prefix` 做前缀总数统计，前缀级数量继续由内容区 `browse_key_tree` 负责。

### 5.3 内容区

| Tab | Payload | 数据入口 |
|-----|---------|----------|
| `table_data` | `{ profileId, container }` | `useTableData` -> `browse_table_data`，仅 table/view/materialized_view |
| `key_value` | `{ profileId, dbIndex, pattern?, selectedKey? }` | `useKeyTree` / `useKeyValue` |
| `sql_editor` | `{ profileId, tabRuntimeId, savedQueryId?, initialContext? }` | focused 与脚本 statement 都按可选 `sqlExecution.managedLifecycle` 选择 managed lifecycle 或同一 adapter 内的 legacy `execute_sql`；保存查询走本地 Storage IPC |
| `clickhouse_table_design` | `{ profileId, tabRuntimeId, mode, container?, parentContainer? }` | ClickHouse Table/Object native schema Describe/Create/Change；tab 自己拥有后端 runtime |
| `clickhouse_view_design` | `{ profileId, mode, family, container?, parentContainer?, ownerTabRuntimeId? }` | persistent View/MV 使用 shared runtime；Temporary 复用 owner SQL tab runtime，designer 本身不单独 open/close runtime |

Redis key-value tab 仍以 `browse_key_tree` 作为完整 key 树数据源，但前端会将已加载树节点展开为扁平可见行模型，并通过虚拟列表渲染这些行。该优化只减少大前缀展开后的 DOM、layout 与 paint 压力，不改变 Redis scan 语义、前缀计数口径或 IPC 契约。

Tab 关闭时调用 `close_tab_runtime`。profile 断开时先同步进入 `disconnecting`，再调用 `closeTabsByProfileId(profileId)`，对 `queryKeys.profile(profileId)` 执行 `cancelQueries + removeQueries`，并清理 Explorer metadata；这不是 invalidate，因而不会在 teardown 中意外 refetch。

SQL Editor 使用和 DataTable 一致的 tab runtime 生命周期：打开时创建 `open_tab_runtime(profileId, tabRuntimeId)`，legacy/managed 执行都传同一个 runtime ID，关闭时 signal-and-discard execution ownership 和 Raw artifacts 后释放 runtime。前端 UI tab ID 只用于 Zustand、导航和详情开关，不能代替后端 `tabRuntimeId`。ClickHouse Phase 4A/4B/4C 已启用 managed direct、Channel/snapshot 对账、服务端确认取消、best-effort progress、逐 statement managed scripts 与显式单语句 Raw；其他 SQL 驱动仍由同一 lifecycle 内的 legacy adapter 承载。脚本队列属于前端 tab B 域，后端 Manager 仍只协调当前单条 execution，不建立服务端脚本队列；Raw 不进入 script runner。SQL 编辑器事务按钮、临时表和 session 变量等稳定物理会话语义仍未提供。

---

## 6. PG / MySQL / Redis / Oracle / SQLite / ClickHouse 行为

SQLite Phase 5 supports local-file connection, Explorer metadata browsing, DataTable browsing and primary-key-only editing, page stats, SQL Editor execution, and DataTable tab-runtime transactions. The profile payload remains `dbFilePath` and `isReadOnly`; no host, port, username, password, SSH, TLS, cloud, or remote file options are accepted. The SQLite driver opens the configured existing local file through `sqlx::sqlite`, supports `ping`, `server_version`, `close`, `test_connection_config`, `connect_profile`, `open_tab_runtime`, `SchemaBrowser::list_containers`, `SchemaBrowser::describe_table`, `DataTableBrowser` browse/change-set methods, `TransactionManager`, and `SqlExecutor::execute_sql`. It exposes `schemaBrowser=true`, `dataTableBrowser=true`, `sqlExecutor=true`, `tableRowMutator=true`, `tableRowInserter=true`, and `transactionManager=true`, while `schemaMutator=false` until the scoped create-table phase.

SQLite Explorer hierarchy is `connection -> file database node -> asset_group -> object`. The file database node returns `tables`, `views`, `indexes`, and `triggers` groups. Table nodes return `columns`, `indexes`, and `triggers`; view nodes return `columns` and `triggers`. SQLite internal objects whose names start with `sqlite_` are hidden by default.

SQLite Phase 4 derives writable resource state from `profile writable AND real table AND explicit non-binary primary key`. Read-only profiles, views, tables without an explicit primary key, and tables whose primary key contains a binary column return `sourceWritable=false` and `sourceInsertable=false`; SQLite never uses `rowid` as a mutation fallback. Ordinary non-binary table columns are writable, primary-key columns can be supplied for inserts but cannot be updated, and generated or BLOB/binary columns remain read-only. Change sets reuse the generic insert -> update -> delete preview and commit path. Without an active transaction, saves retain the immediate non-transaction behavior.

SQLite Phase 5 creates each SQLite driver with a two-connection pool. `begin_tab_transaction` validates the writable table resource, acquires one `PoolConnection<Sqlite>`, executes `BEGIN IMMEDIATE`, and pins that connection in the tab runtime until commit, rollback, or close; the existing five-second SQLite busy timeout bounds lock acquisition. Transactional `browse_table_data`, `get_table_page_stats`, and change-set DML use the pinned connection, so the current tab sees its uncommitted changes while independent readers continue to see the last committed snapshot. Metadata-only `PRAGMA table_xinfo/index_list/index_info` reads may use the second pool connection. A failed change set keeps the session active for explicit rollback; `COMMIT` / `ROLLBACK` 只有执行成功后才清除 pinned session，命令失败时保留状态以支持重试或后续回滚。`SqliteDriver::close` performs best-effort rollback before closing the pool. SQL Editor execution remains on its own tab runtime and is not coupled to the DataTable transaction.

ClickHouse supports direct HTTP, direct HTTPS/Cloud credentials and HTTP + SSH. HTTPS + SSH fails before endpoint resolution until the tunnel can preserve original-host SNI. Shared runtime and tab runtime each own an official ClickHouse client handle and cleanup boundary。DataTable 使用 server `LIMIT/OFFSET + pageSize+1`；普通 Local `MergeTree/ReplacingMergeTree` Table 通过 native Describe 派生列级写入能力。Insert 使用后端生成的 typed `INSERT`；Update/Delete 使用原始标量快照、preview 匹配计数、执行前复核、请求级 `mutations_sync=1` 和执行后旧/新事实核验。一次最多 100 行、2,000 个单元格；不自动重试，不提供事务承诺，transport/timeout 或核验失败返回 `outcomeUnknown`。2026-07-18 self-hosted 单节点 HTTP `26.5.1.882` 已通过同一 `real_clickhouse_smoke` 的 CRUD marker，覆盖 Insert/Update/Delete、Nullable、LowCardinality、DEFAULT、Materialized、冲突和 cleanup；Phase 4/5 markers 同次继续通过。单节点 HTTP/IP:PORT 基础版产品状态为 `available`；Cluster execution、TLS/Cloud 兼容性矩阵、Mutation Center 与 transaction capability 保持关闭，只有后续通过真实门禁的部署形态和增强能力才加入公开支持矩阵。

| 能力 | PostgreSQL | MySQL | Oracle | Redis | SQLite |
|------|------------|-------|--------|-------|--------|
| 容器树 | database -> schema -> asset_group -> entity；table/view -> asset_group -> column/index/trigger | database -> asset_group -> entity；table/view -> asset_group -> column/index/trigger | schema(owner) -> asset_group -> entity；table/view/materialized_view -> asset_group -> column/index/trigger；service/SID/connect alias 仅保留在 `ContainerRef.database` | logical DB -> key prefix/key；logical DB 可展示 key 总数 | file database -> asset_group -> table/view/index/trigger；table -> asset_group -> column/index/trigger；view -> asset_group -> column/trigger |
| 新增数据库 | `SchemaMutator.create_database`，执行 `CREATE DATABASE` | `SchemaMutator.create_database`，支持 `DEFAULT CHARACTER SET` | 不支持 database / PDB / user 创建；table 级 SchemaMutator 可用 | 不支持，`schemaMutator=false` | 不支持，`schemaMutator=false` |
| 编辑数据库 | 支持名称、注释、表空间；生成 rename/comment/set tablespace SQL | 仅支持默认字符集；不支持重命名 | 不支持 | 不支持 | 不支持 |
| 删除数据库 | `SchemaMutator.drop_database`，执行 `DROP DATABASE`；V1 不主动断开其他连接 | `SchemaMutator.drop_database`，执行 `DROP DATABASE` | 不支持 | 不支持 | 不支持 |
| 删除普通表 | `SchemaMutator.drop_table`，执行 `DROP TABLE "schema"."table"`；内部 schema 防御性拒绝 | `SchemaMutator.drop_table`，执行全限定 ``DROP TABLE `db`.`table` `` | `SchemaMutator.drop_table`，执行 `DROP TABLE "OWNER"."TABLE"`，默认不带 `PURGE` | 不支持 | 不支持 |
| SQL 预览 | create/update/drop 均由驱动生成预览语句 | create/update/drop 均由驱动生成预览语句；字符集列表来自 `SHOW CHARACTER SET` | table create/update/drop 由 Oracle driver 生成预览语句；database/PDB 级 DDL 不支持 | 不支持 | 不支持 |
| 表浏览 | 后端安全 quote schema/table；支持 table/view/materialized_view | 后端使用全限定 `` `db`.`table` ``；支持 table/view | 后端安全 quote owner/object；支持 table/view/materialized_view；普通表支持 primary-key-only DataTable insert/update/delete，view/materialized_view 只读 | 不支持 | 支持 table/view 分页与页数统计；writable profile 的显式主键普通表支持 DataTable insert/update/delete，read-only profile、view、无主键表只读 |
| DataTable 事务 | tab runtime pinned connection；显式 begin/commit/rollback | tab runtime pinned connection；显式 begin/commit/rollback | tab runtime pinned connection；Oracle begin 不执行 SQL `BEGIN` | 不支持 | tab runtime 执行 `BEGIN IMMEDIATE` 并 pin connection；browse/page stats/DML 共享未提交视图，close 自动回滚 |
| 显式 SQL | 支持；SQL 编辑器按 database/schema context 执行单语句 | 支持；SQL 编辑器按 database context 执行单语句 | 支持；SQL 编辑器按 schema context 执行单语句，结果只读 | 返回 capability 不支持错误 | 支持；SQL 编辑器按文件 database context 执行单语句，schema context 会被拒绝，结果只读 |
| 非 SQL 浏览 | 不适用 | 不适用 | 不适用 | `SCAN`、`TYPE`、`TTL`、string/json/hash/list/set/zset/stream 读取 | 不适用 |

MySQL shared runtime 禁止依赖裸 `USE db`。需要数据库上下文时用 `ContainerRef` 生成限定查询，或放入 Tab runtime 隔离连接级状态。

Oracle 使用 `oracle-rs` + `deadpool-oracle`，连接池保留在 `OracleDriver` 内部；`ConnectionRuntimeManager` 仍只持有 `Arc<dyn DatabaseDriver>`，不新增 Oracle 专属 pool enum 或 IPC 分支。Oracle Phase 1 将 `NUMBER` 与整数类值保守以字符串传输，避免跨 Tauri/JavaScript 边界丢失精度。Phase 1.5 后，Oracle Explorer 根层级为 `connection -> schema(owner) -> asset_group -> entity`；当前 service / SID / EZConnect alias 不显示为单独节点，但仍保留在 `ContainerRef.database` 中，用于内部寻址、SQL context 和保存查询兼容。

Oracle Phase 2 开启 `tableRowMutator=true`、`tableRowInserter=true`、`transactionManager=true`，但可写范围只覆盖普通表、完整主键定位的 DataTable change set。`browse_table_data` 会从 Oracle 数据字典加载列级 `ColumnMeta`，普通表有主键时返回 `sourceWritable=true` 与 `sourceInsertable=true`；无主键表、view、materialized view 返回只读资源能力。Oracle 不使用 `ROWID` 作为编辑兜底，不支持 view/materialized view 编辑。

Oracle Phase 3 开启 `schemaMutator=true`，Table Designer 支持普通表结构读取、新建表、DDL 预览、执行建表、常用 `ALTER TABLE` 和保存前 drift detection。Oracle `describe_table` 使用 `ALL_TAB_COLUMNS` / `ALL_TAB_COLS` / `ALL_TAB_COMMENTS` / `ALL_CONSTRAINTS` / `ALL_CONS_COLUMNS` / `ALL_INDEXES` / `ALL_IND_COLUMNS` / `ALL_TAB_IDENTITY_COLS` / `ALL_PART_TABLES` 读取普通表元数据，并映射到共享 `TableSchema`。Oracle table create/update SQL 由后端 `oracle/ddl.rs` 生成，前端只提交结构化 schema draft；`engine`、`charset`、`collation`、列 charset/collation、索引 method/comment 等 Oracle 不适用字段会被前端清空且由后端再次校验。保存前 drift detection 会重新 `describe_table` 并与 baseline 做受限语义比较：PK/Unique 约束的 `enforced=true` 默认值可与前端 roundtrip 后的空值等价，但 `enforced=false`、CHECK/FK、列、索引和约束结构变化仍必须触发冲突。当前 Oracle Table Designer 不支持 database/PDB/user/tablespace 管理、materialized view designer、既有表分区迁移、LOB storage、tablespace/storage/compression/parallel/logging 选项、advanced index families 或完整 identity sequence 参数迁移。

Oracle DataTable 事务复用现有 tab runtime 事务 IPC：`begin_tab_transaction` 从 pool pin 一条 Oracle connection 并记录 `ContainerRef.database`，不会执行 SQL `BEGIN`，因为 Oracle 的 `BEGIN` 是 PL/SQL block。事务中的 browse、page stats 与 DML commit 都使用该 pinned connection；`commit_tab_transaction` / `rollback_tab_transaction` 分别调用 Oracle connection 的 commit / rollback 后释放连接。SQL editor 仍是显式 SQL 只读结果路径，不提供事务工具栏。

Oracle driver 在统一 manager 诊断之外，还会在部分由后端生成的低层 SQL 执行失败时记录截断后的 SQL 片段，例如 DataTable 可写元数据查询、DataTable DML statement 和 schema reset；AI/SQL editor 提交的原始用户 SQL 以及用于切换 schema 的 statement 不写入失败日志，只保留 profile、schema context、结果类型和结构化错误。cleanup 失败（例如 DML 失败后的 rollback 或 SQL 失败后的 schema reset）使用 warn 级别记录，主失败仍按原始 `IpcError` 返回给前端。Oracle DataTable DML 由后端根据列元数据生成 safe typed literal：普通字符串列使用 SQL string literal，`DATE` / `TIMESTAMP` 列使用 `TO_DATE(...)` / `TIMESTAMP '...'` typed literal，避免真实 Oracle Free 23ai + `oracle-rs 0.1.7` 环境把 timestamp 字符串 insert 误报为 temporary LOB 类连接关闭错误。Oracle 可写元数据查询必须避免普通 SQL 中重复使用同一组 bind placeholder；实现将列、主键、唯一列拆成三条保守字典查询，每条只绑定一次 owner/table，并在 Rust 层合并，以适配 `oracle-rs 0.1.7` 的 bind 与复杂查询兼容性。列集合以 `all_tab_columns` 为准，避免暴露隐藏列；`virtual_column` 标记通过 `all_tab_cols` 左连接补充，因为部分真实 Oracle 环境的 `ALL_TAB_COLUMNS` 不暴露该字段。

关系型结构变更通过专门的 `SchemaMutator` trait 暴露，不通过 `execute_sql` 复用用户 SQL 执行入口。`DriverCapabilities.schemaMutation` 是前端判断具体 object/operation（`create/alter/drop/clear/materialize`）的权威来源；Explorer 使用 `supportsSchemaMutation()` 逐项展示动作，不能再从 `schemaMutator` 推导某个操作。`schemaMutator` 只保留关系型 trait 的迁移兼容语义：当前内置关系型驱动让它与 `schemaMutation.is_some()` 保持一致，原生 extension 则可以保持 `schemaMutator=false` 并声明精确 `schemaMutation`。后端关系型命令仍通过 `as_schema_mutator()` 兜底，native 命令通过 `as_native_schema_extension()` 兜底；两者不会互相 fallback。

SchemaMutator V2 覆盖数据库级 create / update / drop 与对应 preview IPC。前端只提交结构化输入，例如 `{ name, characterSet? }` 或 `{ container, name?, comment?, tablespace?, characterSet? }`，SQL 预览和最终执行语句都由具体驱动生成。MySQL 编辑数据库时，前端通过 `get_mysql_database_character_set` 读取当前 database 的默认字符集作为表单初始值，候选项仍来自 `list_mysql_character_sets`。后端继续校验 `ContainerRef.kind === "database"`、名称非空、能力支持、identifier quote 和字符串 literal escape；Redis 等非关系型驱动保持 `schemaMutator=false`、`schemaMutation=None`，也不实现结构变更 trait。

原生结构 surface 与 mutation capability 是两条独立边界。不能被关系型 `TableSchema` 无损表达的驱动通过 `as_native_schema_extension()` 接入 tagged native describe/create request、document、preview 与 result，再由具体 strong typed IPC 暴露给前端；公共接口不使用任意 `serde_json::Value`，也不增加 per-driver accessor。schema designer surface registry 决定某个 driver/object/mode 应打开哪个 tab；edit registration 可以只依据 `schemaBrowser` 开放，create registration 还必须要求对应 object/create capability。

ClickHouse Phase 5B 的 preview 只接受强类型 Database/Table target，执行请求必须带同一 target 与 `expectedPlanHash`。后端重新校验并规划，比较 domain-separated lowercase SHA-256 后才发送 DDL；每个 plan 只有一条 statement，不生成 `IF NOT EXISTS`，不自动重试。发送使用独立 query id、`wait_end_of_query=1`、driver timeout 与 shutdown gate；随后从 `system.databases` 或真实 native Describe 复核远端事实。重复对象映射为 `RESOURCE_CONFLICT`；响应、transport、timeout 或 shutdown 后无法验证是否已经生效时返回 `OPERATION_OUTCOME_UNKNOWN`，不能伪造成功或未执行。MergeTree Describe 可能规范化出额外 `index_granularity=8192`；verifier 只允许这一 canonical 默认，其他目标外 explicit setting 仍 fail closed。

ClickHouse Phase 5C 的 change planner 固定按 rename → add → modify/reorder → column comment → sample key → table TTL → setting reset/modify → table comment → drop column 排序。当前唯一可变 key 是 `SAMPLE BY`，唯一经真实服务验证可 ALTER 的 MergeTree setting 是 `ttl_only_drop_parts`；engine、`ORDER BY`、`PARTITION BY`、`PRIMARY KEY` 与 projection/index-bearing table 全部 fail closed。type/default/codec/TTL、drop column、CLEAR/MATERIALIZE 和 object Drop 按后端分类进入 destructive/long-running gate。Drop SQL 不带 `IF EXISTS`，CLEAR/MATERIALIZE 只表达整列动作并在接受后返回 submitted；持续观察 `system.mutations` 属于 Phase 7。

关系型资产分组统一使用 `ContainerKind::AssetGroup` / `kind: "asset_group"` 和 `groupType` 表示分组语义，例如 `tables`、`views`、`materialized_views`、`functions`、`procedures`、`indexes`、`triggers`、`sequences`、`extensions`、`events`。驱动只返回自身支持的分组；前端只渲染分组，不按具体数据库硬编码层级。

---

## 7. 新增驱动检查清单

1. TypeScript：补齐 `DbDriver`、payload、driver-configs 表单与 picker。
2. Rust 存储层：确认 `ConnectionDriver` 小写序列化与 TS 对齐。
3. Engine profile：在 `profiles.rs` 增加强类型 profile。
4. Driver：实现 `DatabaseDriver` 和需要的 capability trait。
5. Registry：在 `DriverRegistry::create_driver` 注册构造逻辑。
6. Frontend：如有新范式，补充 tab payload、query key、content view；关系表范式复用 `asset_group + DataContainer`，表格数据入口仍为 `browse_table_data`。

---

## 8. 源码索引

| 主题 | 路径 |
|------|------|
| TS 连接配置 | `src/types/connections.ts` |
| TS IPC 类型 | `src/types/ipc.ts` |
| Engine IPC | `src-tauri/src/commands/engine_commands.rs` |
| Runtime manager | `src-tauri/src/engine/manager.rs` |
| Engine diagnostics | `src-tauri/src/engine/diagnostics.rs` |
| Driver traits | `src-tauri/src/engine/driver.rs` |
| Driver profiles | `src-tauri/src/engine/profiles.rs` |
| Driver registry | `src-tauri/src/engine/registry.rs` |
| Driver modules | `src-tauri/src/engine/drivers/` |
| Explorer remote nodes | `src/features/workbench/explorer/buildRemoteNodes.ts` |
| Query hooks | `src/hooks/queries/use-db-metadata.ts` |
