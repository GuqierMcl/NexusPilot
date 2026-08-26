# ClickHouse View Designer 当前指南

> 当前状态：Phase 5E 单节点 HTTP/IP:PORT 基础版已完成实现和发布收口，Local 与 Temporary View/MV capability 已发布；Cluster execution 明确未发布。2026-07-17 ClickHouse `26.5.1.882` 上的 Direct 与 Manager 单节点真实矩阵已通过，基础版产品状态为 `available`。
>
> 本文是 ClickHouse View 与 Materialized View 体系的公开权威实现指南。Table/Object surface 见 [clickhouse-table-designer.md](./clickhouse-table-designer.md)，当前产品边界见 [ClickHouse support](../product/database-support/clickhouse.md)。

---

## 1. 产品边界

ClickHouse View/MV 使用专属 `clickhouse_view_design` 标签页，不复用关系型 Table Designer，也不让前端提交完整 DDL。前端维护强类型 draft，后端负责 support probe、校验、renderer、preview、typed confirmation、远端漂移检查与 post-proof。

基础版静态 capability 为：

```text
schemaMutator = false
as_schema_mutator() = None

schemaMutation:
  view              = [create, alter, rename, drop]
  materialized_view = [create, alter, rename, drop]
  ddlPreview = true
  destructiveConfirmation = true
  remoteDriftProtection = true
```

这只是第一层授权。每个 View family 的具体操作还必须命中 `ClickHouseViewRuntimeSupport` 的 `supported` 状态；`unsupported` 和 `unknown` 都不会发送 DDL。

基础版正式 scope：

- Local persistent View/Materialized View；
- 绑定 SQL Editor owner runtime 的 Temporary View；
- 单节点、HTTP、IP:PORT、username/password 的已实证环境。

基础版不声明：

- `ON CLUSTER` execution；
- 多节点、Keeper、Replicated/Distributed 的真实兼容性；
- HTTPS/TLS、域名/SNI、Cloud、SSH 或真实低权限矩阵；
- SYSTEM refresh/watch/cancel 等 runtime controls；
- DataTable 引导式写入、Mutation Center、传统事务或专业诊断。

上述项目属于独立增强 backlog，不阻塞当前基础版闭环。

## 2. 七类 View family

IPC family tag 固定为：

```text
normal
parameterized
temporary
materialized
refreshable_materialized
window
live
```

| Family | 对象 kind | 当前模型 | 关键边界 |
| --- | --- | --- | --- |
| Normal | `view` | query、aliases、definer、SQL security、comment | query/aliases/definer/comment 变化可走 Replace；query replacement 属于 destructive |
| Parameterized | `view` | Normal + 从 placeholder 派生的参数集合 | 后端忽略 string/comment/quoted identifier 内的花括号，并要求同名参数类型一致 |
| Temporary | `view` | query + owner tab runtime | 无 database、无 shared Explorer、无 Cluster；编辑为 Drop + Create 两 statement |
| Materialized | `materialized_view` | typed columns、TO table 或 inner storage、POPULATE、security、comment | TO 与 inner storage 二选一；TO 不允许 POPULATE；storage/typed schema 变化可能 Replace/data loss |
| Refreshable Materialized | `materialized_view` | storage、refresh mode/interval/offset/randomize/dependencies/settings、APPEND、EMPTY | schedule 走 MODIFY REFRESH；schema applied 与 initial refresh/background work 分离 |
| Window | `view` | destination/engine、watermark、allowed lateness、time-window function | experimental；仅当服务器 probe 为 supported 时开放，request-level setting 不改全局配置 |
| Live | `view` | query、timeout/refresh 与 legacy canonical options | deprecated；服务器移除 create 时已有对象仍可 Describe，未知 legacy clause 保持 readonly，不自动迁移 |

Window/Live 不是“无条件支持”。当前真实服务器明确返回 unavailable，测试将其计为非 skip 的 `window_unavailable=1`、`live_unavailable=1`，UI 不显示虚假可用操作。

## 3. Support 三态

`get_clickhouse_view_runtime_support` 返回 server version、database engine、七类 family 的 Describe/Create/Alter/Rename/Drop 三态、Cluster DDL 状态与 `supportRevision`：

```text
supported
unsupported
unknown
```

映射规则：

- 服务端版本、edition 或 database engine 明确没有能力：`unsupported`，操作返回 `FEATURE_UNAVAILABLE`；
- 当前账号没有权限判断或执行：`unknown`，操作返回 `PERMISSION_DENIED`；
- 只有 `supported` 才能进入 preview/execute；
- support snapshot 属于运行时 B 域，不写入 profile 或持久化；
- server version、database engine、scope、reconnect 或 topology 变化会改变 support revision，使旧 preview 失效。

`FEATURE_UNAVAILABLE` 与 `PERMISSION_DENIED` 都是 `businessOnly`，不会把健康连接标记为断开。

## 4. 打开方式与 Tab 生命周期

Persistent View/MV：

- Views 或 Materialized Views asset group 在对应 create capability 下提供“新建”；
- View/MV 叶子提供“打开数据”“设计 View”“重命名”“删除”；
- edit tab 按 `profileId + kind + database + objectName` 去重；
- create tab 是独立草稿，创建成功后使用后端真实 Describe schema 建立 edit baseline；
- Explorer 动作只做静态 capability/surface 路由，进入页面后继续执行 family support gate。

Temporary View：

- 不进入 shared Explorer；
- ClickHouse SQL Editor toolbar 的 `Session Views` 读取并管理当前 owner session 的 Temporary View；
- 其他 Temporary 创建入口会先建立一个 ClickHouse SQL Editor owner runtime；
- designer payload 只持有逻辑 `ownerTabRuntimeId`；dependent designer 不调用 `open_tab_runtime`，也不拥有第二个 backend runtime；
- 关闭 dependent designer 不关闭 owner；关闭 owner 会由 lifecycle registry 级联关闭 dependents；
- profile disconnect 与 app teardown 同样使 session 过期；过期后不自动重建旧 Temporary View。

物理 ClickHouse HTTP `session_id` 只存在于 Rust driver 私有状态。它不会出现在 IPC、TypeScript、profile、日志、query key、marker 或持久化文件中。

## 5. Query 与列模型

前端只提交 query body。后端允许 ClickHouse 的 SELECT 表达力，包括 WITH、JOIN、UNION、ARRAY JOIN、子查询、table function、GROUP BY/HAVING/ORDER BY、Parameterized placeholder 与 Window time-window group，但强制以下 statement boundary：

- 只能有一条 query；
- 最终顶层必须进入 SELECT；
- 禁止第二 statement；
- 禁止顶层 DDL/DML；
- 禁止顶层 `FORMAT`；
- 禁止顶层 `INTO OUTFILE`；
- quote、comment 和 delimiter 必须闭合；
- CREATE/ALTER/Replace 包装只能由后端 renderer 生成。

列定义为三类：

```text
none
aliases(names[])
typed(columns[])
```

Normal/Parameterized 使用 none 或 aliases；Temporary 固定 none；Materialized/Refreshable Materialized 可以使用 typed columns；typed schema 复用 ClickHouse type parser 与 identifier validator，但不接受 table-only default/codec/TTL。

## 6. Preview、确认与漂移保护

Create/Alter/Rename/Drop 都必须先取得 fresh preview。plan 包含：

```text
statements
operations
warnings
destructive
longRunning
riskFlags
requiredConfirmation
expectedTargetRevision
baseline
planHash
```

风险 flag：

```text
destructive
dataLoss
longRunning
backgroundWork
clusterNonAtomic
experimental
deprecated
```

确认等级：

```text
none
confirm
typeObjectName
typeObjectAndCluster
```

执行请求必须携带原 target、完整 preview baseline、`expectedPlanHash` 与 typed confirmation。后端在任何 DDL 前重新计算 plan、核对 support revision、读取完整远端 baseline，并验证 rename destination absence。前端 revision hash 只能帮助识别 stale，不替代后端远端事实。

Alter target 始终包含完整 baseline 与完整 desired，不提交 patch。后端按下列优先级生成最小确定性变化：

```text
1. MODIFY QUERY
2. MODIFY REFRESH
3. MODIFY SQL SECURITY / DEFINER
4. MODIFY COMMENT
5. CREATE OR REPLACE
```

任何变化一旦需要 Replace，就折叠为一个完整 Replace，不先发一串 ALTER。Temporary edit 是唯一显式 Drop + Create 的 family；第一条成功、第二条失败时必须返回 `partiallyApplied`。Rename 始终是独立 action，不与 Alter 合并。

## 7. 执行与结果语义

所有 View DDL 遵守：

- 不自动重试；
- 每条 statement 使用独立 query ID；
- 使用 wait-end-of-query、driver timeout 与 shutdown gate；
- 首错停止；
- Create 不生成 `IF NOT EXISTS`，Drop 不生成 `IF EXISTS`；
- Create/Alter 只有 post-Describe 语义匹配后为 `applied`；
- Rename 必须证明 source absent、destination present 且定义与 source baseline 一致；
- Drop 只有 absence proof 后为 `applied`；
- ambiguous response 返回 `outcomeUnknown`，不能推断为“未执行”。

结果状态：

```text
applied
submitted
partiallyApplied
outcomeUnknown
```

schema result 与 background work 分开：

```text
initialRefresh
populate
windowInitialization
distributedDdl

submitted | running | succeeded | failed | unknown
```

例如 Refreshable MV 的 schema 已匹配、initial refresh 仍在运行时，结果可以是 `status=applied` 与 `backgroundWork=initialRefresh/running`；不能为了等待数据刷新而改写 schema applied，也不能在后台任务尚未观察完成时声称数据已就绪。

`partiallyApplied/outcomeUnknown/conflict` 不会用 desired target 覆盖本地 snapshot，也不会乐观合成 Explorer 对象列表。用户必须刷新远端定义并重新 preview。

## 8. Cluster 明确关闭

Cluster 领域契约仍保留 topology revision、full-node baseline、redacted `nodeIdentityHash`、shard/replica、distributed DDL submitted/partial/unknown 聚合以及 no-retry 规则，用于后续增强时复用。但基础版固定：

```text
clusterDdl.executable = false
```

因此：

- 发现 `system.clusters` 不等于产品允许执行；
- `ON CLUSTER` preview/execute 在网络发送前返回 `FEATURE_UNAVAILABLE`；
- 当前 unit/contract 覆盖不算真实多节点证据；
- 当前没有 Docker/Compose fixture，也不会为满足门禁新增本地集群 runner；
- 未来取得真实多节点环境后，网络测试仍扩展 `src-tauri/src/real_db_tests/`，并在独立 Deployment Compatibility 增量中重新进行 Direct/Manager 发布验收。

## 9. 真实门禁

真实写入同时要求：

```text
NEXPILOT_TEST_CLICKHOUSE_ENABLED=true
NEXPILOT_TEST_ALLOW_WRITES=true
```

唯一真实连接入口继续是：

```powershell
cd src-tauri
cargo test real_db_tests::clickhouse::real_clickhouse_smoke -- --ignored --exact --nocapture
```

2026-07-17 单节点 HTTP ClickHouse `26.5.1.882` 的 Direct 与 Manager marker 均为：

```text
normal=5
parameterized=5
temporary=6
materialized=11
refreshable=5
window_supported=0
window_unavailable=1
live_supported=0
live_unavailable=1
alters=9
renames=5
drops=6
confirmation_rejections=14
drift_conflicts=3
background_observations=1
```

Direct 与 Manager evidence struct 被断言完全相等；同一 smoke 还通过 Phase 4A/4B/4C 与 Phase 5A–5D markers，并完成 scratch database/object、Temporary owner session、tab/profile/app cleanup。

当前环境为单节点、HTTP、IP:PORT、无域名和 SSL 证书。Cluster、HTTPS/TLS、Cloud 与真实低权限输出是明确 deferred，而不是 pass，也不属于基础版失败。`.env.test` 只由 Rust real database test 内部加载，禁止在 shell、日志、聊天或提交中读取/输出真实凭据。

## 10. 后续增强

View/MV 基础版完成后按需求选择独立纵向切片：

- Background Operations：SYSTEM START/STOP/REFRESH/WAIT/CANCEL VIEW、WATCH 与服务端任务观察；
- Deployment Compatibility：Cluster/Keeper、Replicated/Distributed、HTTPS/TLS、域名/SNI、Cloud、SSH、低权限；
- Runtime Semantics/Diagnostics：事务/原子性、parts/merges/queues、query/profile log；
- Data Write：DataTable append-only insert 与后续 mutation workflow。

每个增强单独设计、实现、真实验证和发布。未选中的增强保持 capability 关闭，不改变基础版已闭环的事实。
