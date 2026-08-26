# ClickHouse Table Designer 当前指南

> 当前状态：Phase 5A–5E 单节点 HTTP/IP:PORT 基础版已完成实现、Direct/Manager 真实门禁与发布收口，产品状态为 `available`。本文只描述 Table/Object surface；View/MV 见 [clickhouse-view-designer.md](./clickhouse-view-designer.md)。
>
> 本文是 ClickHouse Table Designer 与 Schema Mutation 的公开权威实现指南。当前产品边界见 [ClickHouse support](../product/database-support/clickhouse.md)。

---

## 1. 产品边界

ClickHouse 使用专属 `clickhouse_table_design` 标签页，不把 engine、keys、TTL、codec、settings、projection 等原生语义塞进关系型 `TableSchema` 或 MySQL/PostgreSQL/Oracle Table Designer。

专属标签页继续复用公共工作台设施：

- content tab registry、renderer 与 lifecycle/de-dup；
- profile/tab runtime；
- dirty、关闭确认、create 后同 tab retarget；
- DDL Preview contained drawer；
- destructive confirmation；
- full baseline 与 remote drift protection；
- TanStack Query cache、metadata refresh；
- `apiInvoke()` 与结构化 `IpcError`；
- 公共 Content Toolbar 和底部状态栏。

公共 Explorer、ContentPanel、Toolbar、remote action contributor 和 Status shell 不按 `driver === "clickhouse"` 分支。入口由 `schemaMutation` capability、schema designer surface registry 与 schema drop operation registry 共同决定。

ClickHouse 通过 `NativeSchemaExtension` 提供原生结构能力，不实现关系型 `SchemaMutator`：

```text
schemaMutator = false
as_schema_mutator() = None

schemaMutation:
  database = [create, drop]
  table    = [create, alter, drop]
  column   = [clear, materialize]
  projection = [create, drop, clear, materialize]
  index      = [create, drop, clear, materialize]
  view              = [create, alter, rename, drop]
  materialized_view = [create, alter, rename, drop]
  ddlPreview = true
  destructiveConfirmation = true
  remoteDriftProtection = true
```

这不是“只读驱动”。它表示具体 native operation 已开放，但 legacy 关系型 trait 仍故意关闭。

## 2. 打开方式与 Tab 生命周期

Explorer 当前入口：

- connection 或 database：新建数据库；
- database 或 Tables asset group：新建表；
- table：设计表结构、删除表；
- database：删除数据库。

Create tab 按 `profileId + database context` 去重；edit tab 按 `profileId + database + table` 去重。Create applied 后继续使用同一个 tab id，retarget 为 edit，并用后端返回的真实 Describe schema 建立新 baseline。

Table edit 即使不可写也可以打开：`schemaBrowser=true` 允许查看原生 schema。只有 Describe 可无损证明、没有 blocker，且 runtime 对目标 `object + operation` 精确授权时才启用对应写控件：

1. 主表 Columns/Engine/TTL 变更要求 `table/alter`；
2. 整列动作要求 `column/clear|materialize`；
3. Projection/Index 动作要求对应 `projection|index + create|drop|clear|materialize`；
4. 当前对象落在 non-Replicated MergeTree Phase 5C/5D 支持范围；
5. 主表 draft 必须 clean，且不存在 submitted/partial/unknown/conflict 等待核对状态。

表含任一 Projection/Index 时，Columns/Engine/TTL 与 column action 继续 fail closed；用户必须先在专属对象 section 删除依赖并刷新。该依赖不会反向禁用 Projection/Index section。不满足对象编辑条件时保持 `restricted` 或 `readonly`，完整展示远端语义，不会把未知 clause/query/family 从 draft 中丢失。

## 3. 页面分区

### 3.1 Create mode

Create mode 提供三个可编辑 section：

1. Columns；
2. Engine & Keys；
3. TTL & Settings。

Create target 支持 ordered columns、完整 type expression、default kind/expression、codec chain、column TTL/comment、non-Replicated MergeTree family engine/arguments、ORDER/PARTITION/PRIMARY/SAMPLE keys、table TTL/comment 与 create allowlist settings。

Projection 和 Data-skipping Index 不进入 Phase 5B create target。

### 3.2 Edit mode

Edit mode 固定展示五个 section：

1. Columns；
2. Engine & Keys；
3. TTL & Settings；
4. Projections；
5. Data-skipping Indexes。

前三个 section 在 Phase 5C 的 allowlist 内受控可写；Projection 与 Data-skipping Indexes 在 Phase 5D 使用各自的强类型对象动作。已有对象不提供 inline rename/modify；修改定义必须显式 Drop、刷新，再以 fresh preview Create。未知 query/family/缺字段对象无损展示 blocker，且不渲染 mutation button。

## 4. Phase 5C/5D 可写矩阵

### 4.1 Columns

支持：

- 添加列；
- 显式重命名已有列；
- 修改 type/default kind/default expression/codec/column TTL；
- 调整列顺序；
- 修改或清空 column comment；
- 删除列；
- 对 editable stored column 执行整列 CLEAR；
- 对 editable stored column 执行整列 MATERIALIZE。

Rename 使用 baseline source identity 生成 `ClickHouseColumnRenameIntent { from, to }`。后端不会按 ordinal、名称相似度或“删除一列并新增一列”猜测 rename；没有 intent 的变化按真实 add/drop 处理。Chained/cyclic rename、目标名冲突和 key dependency 风险会 fail closed。

CLEAR/MATERIALIZE 只接受整列 target，不接受任意 partition expression。ALIAS/EPHEMERAL 等非 stored column 不可执行 column action。两项操作都被分类为 destructive + long-running，后端确认后返回 `submitted`；它不表示 `system.mutations` 已完成。

### 4.2 Engine & Keys

支持：

- `SAMPLE BY` add/modify/remove。

只读并拒绝变更：

- engine family；
- engine arguments；
- `ORDER BY`；
- `PARTITION BY`；
- `PRIMARY KEY`。

这些字段仍完整展示。Phase 5C 不会为了让 UI 保存而静默忽略其变化；target 与 baseline 不一致会在 planner 阶段返回 `VALIDATION_FAILED`。

### 4.3 TTL & Settings

支持：

- table TTL add/modify/remove；
- table comment 修改或清空；
- `ttl_only_drop_parts` MODIFY/RESET。

真实 ClickHouse `26.5.1.882` 证明 `index_granularity`、`index_granularity_bytes` 与 `allow_nullable_key` 不能作为 Phase 5C ALTER setting。它们仍可在支持的 Create/Describe 语义中出现，但 edit planner 对其变化 fail closed。

ClickHouse 会把 `event_time + INTERVAL 30 DAY DELETE` 规范化为 `event_time + toIntervalDay(30)`。post-Describe verifier 进行 quote-aware 语义规范化：

- `INTERVAL n UNIT` 与对应 `toIntervalUnit(n)` 等价；
- table TTL 尾部无条件 `DELETE` 可视为默认 action；
- `DELETE WHERE ...` 不等价；
- column TTL 只规范化 interval，不移除 action 文本；
- quoted content 不参与改写。

该规则只用于验证服务端回写语义，不接受额外自由 SQL，也不扩大 planner allowlist。

### 4.4 Projection 与 Data-skipping Index

Projection 支持 `create/drop/materialize/clear`。Create target 仅包含 `name + query`；query 必须是单条受控 `SELECT` body，允许 select list、`WHERE`、`GROUP BY`、`ORDER BY`，拒绝顶层 `FROM/JOIN/UNION/PREWHERE/LIMIT/OFFSET/INTO/FORMAT/SETTINGS`、注释、分号、第二 statement 与不平衡 quote/delimiter。`WITH SETTINGS` 与 partition expression 不进入 Phase 5D。

Data-skipping Index Create 只允许：

- `minmax()`；
- `set(max_rows)`；
- `bloom_filter([false_positive])`，可选值满足 `0 < value < 1`；
- `ngrambf_v1(ngram_size, filter_bytes, hash_functions, random_seed)`；
- `tokenbf_v1(filter_bytes, hash_functions, random_seed)`。

`granularity` 必填且大于 0。整数参数在前端还必须处于 JavaScript safe integer 范围，防止 IPC 前舍入；后端以 `u64` 与精确 domain 重新校验。Create/Drop 不生成 `IF EXISTS`/`IF NOT EXISTS`，所有动作都携带完整 `ClickHouseTableSchema` baseline 并在发送前做 full canonical equality。

Create 为 safe、非 long-running，只有 post-Describe 精确定义匹配才返回 `applied`。Drop、Materialize、Clear 都是 destructive + long-running：Drop 只有 post-Describe 证明 absence 才返回 `applied`；Materialize/Clear 只表达 whole-table action，服务端接受后返回 `submitted`，不宣称 `system.mutations` 已完成。两类对象都不支持 `IN PARTITION`。

前端只维护一个 pending object action：对象 section 发起动作后自动生成 preview，公共 Toolbar 执行当前 fresh plan，DDL drawer、确认框与底部状态栏继续复用。主表 dirty、对象动作 applying、远端冲突或待核对状态都会阻止新的对象 preview/execute；submitted/partial/unknown/conflict 不自动重试，也不会用 desired definition 合成对象列表。

### 4.5 Drop

Table/database Drop 从 Explorer 进入通用删除 dialog。Dialog 通过 driver registration 选择 ClickHouse native adapter，要求：

- 当前 capability 声明对应 drop；
- 最终确认使用最新 preview；
- execute 携带 preview target、baseline、plan hash；
- `confirmDestructive=true`；
- table/database absence 经过后端证明。

生产 DROP SQL 不带 `IF EXISTS`。Database preview 会快照 database identity 和按 name 排序的 child object engine/UUID/canonical create query；确认期间任一对象增删改都会返回 `RESOURCE_CONFLICT`。

测试 cleanup 可以在经过 scratch scope guard 后使用 `DROP DATABASE IF EXISTS`，但该语义不会进入生产 planner。

## 5. Preview、确认与 Drift

Edit target 不是增量 JSON patch，而是：

```text
ClickHouseAlterTableTarget
  baseline: 完整 ClickHouseTableSchema
  desired: 完整 ClickHouseCreateTableTarget
  columnRenames: 显式 rename intents
```

Projection/Index 使用八个独立 tagged target，同样携带完整 table baseline。一个对象 plan 固定一条 statement，target identity、baseline revision、plan hash 和当前 pending action 必须同时匹配；对象 preview 与主表 ALTER preview 互斥展示，不能同时执行。

后端 diff 固定排序：

```text
rename
→ add
→ modify/reorder
→ column comment
→ SAMPLE BY
→ table TTL
→ setting RESET/MODIFY
→ table comment
→ drop column
```

Preview 返回 exact statements、operation summaries、destructive/long-running、expected target revision、完整 baseline 和 domain-separated lowercase SHA-256 plan hash。

前端采用 500ms debounce，并同时使用 request id 与 target key 阻止旧响应覆盖新草稿。保存只接受当前 target 的 fresh preview。执行阶段后端会：

1. 重新校验 target；
2. 重新规划并核对 plan hash；
3. 重新 Describe/读取 database baseline；
4. 对 full canonical baseline 做相等比较；
5. 检查 destructive confirmation；
6. 逐条发送 DDL；
7. 重新读取远端事实并分类结果。

前端携带的 revision hash 不是权威 drift proof。第二路径修改 table 或 database child object 时，即使前端 target/hash 未变，后端仍在发送前返回 `RESOURCE_CONFLICT`。

## 6. Destructive 与 Long-running

当前主要分类：

| 操作 | destructive | long-running |
|---|---:|---:|
| rename/add/reorder/comment | 否 | 否 |
| SAMPLE BY | 否 | 否 |
| `ttl_only_drop_parts` MODIFY/RESET | 否 | 否 |
| 任意 column definition change | 是 | type/codec/TTL 变化时是 |
| table TTL add/modify/remove | 是 | 是 |
| drop column | 是 | 否 |
| CLEAR/MATERIALIZE COLUMN | 是 | 是 |
| ADD PROJECTION / ADD INDEX | 否 | 否 |
| DROP PROJECTION / DROP INDEX | 是 | 是 |
| MATERIALIZE/CLEAR PROJECTION/INDEX | 是 | 是 |
| drop table/database | 是 | 否 |

Destructive preview 只有在用户确认后才会发送 `confirmDestructive=true`。后端把缺少确认视为 `VALIDATION_FAILED + businessOnly`，并保证首条 DDL 尚未发送。

## 7. 执行结果与 UI 状态

`NativeSchemaExecutionStatus`：

- `applied`：DDL 已执行，且 post-Describe 与 desired target 相符，或 Drop absence 已证明；
- `submitted`：CLEAR/MATERIALIZE 已被服务端接受，异步 mutation 可能仍在运行；
- `partiallyApplied`：至少一条 statement 已确认执行/接受，但最终事实不等于 target；
- `outcomeUnknown`：transport/timeout/响应丢失等使远端最终事实无法证明。

`NativeSchemaStatementProgress` 同时返回 applied count、failed statement index、remaining count 和已分配 query ids。DDL 不自动重试；每条 statement 使用独立 query id，第一条失败后停止发送后续 statements。

前端处理原则：

- applied：用返回的真实 schema 替换 draft/snapshot/cache；
- submitted：保留明确“已提交”状态与对象 action identity，提示刷新确认，不显示为 mutation 已完成；
- partiallyApplied/outcomeUnknown：不以 desired target 覆盖 baseline；
- post-Describe 可读：保存真实 remote schema，进入冲突处理；
- post-Describe 不可读：保留原 snapshot 与 dirty draft；
- conflict：要求刷新远端事实并重新生成 preview。

公共底部状态栏展示 `previewing/previewReady/applying/submitted/partiallyApplied/outcomeUnknown/conflict`。状态 ownership 在 active tab 的 B 域 runtime state，不写入本地连接 profile A 域。

## 8. 错误与 Runtime Health

- validation、syntax、destructive-no-confirm、remote drift 使用 `businessOnly`，不损伤数据库运行时会话；
- transport/timeout/auth 按现有 `retryable/terminal` 语义影响 runtime health；
- `RESOURCE_CONFLICT` 不代表连接断开；
- outcome unknown 也不允许 UI 推断“肯定未执行”；
- 前端 Engine IPC 必须使用 `apiInvoke()`，不直接 `invoke`。

## 9. 真实门禁

真实写入同时要求：

```text
NEXPILOT_TEST_CLICKHOUSE_ENABLED=true
NEXPILOT_TEST_ALLOW_WRITES=true
```

`.env.test` 只由 Rust 测试内部加载。Agent 与 shell 不读取、输出、修改、暂存或提交真实凭据。

2026-07-15 self-hosted HTTP ClickHouse `26.5.1.882` 已通过 direct 与 Manager-gated 同一 Phase 5C 矩阵，两条 marker 的计数一致：

```text
safe_alter=8
destructive_rejections=6
destructive_applied=4
drift_conflicts=2
unsupported_rejections=4
submitted_actions=2
dropped_columns=1
dropped_tables=1
dropped_databases=1
```

同一 smoke 中 Phase 5A Describe、Phase 5B direct/Manager Create 与 Phase 4A/4B/4C markers 继续通过，scratch database 在成功和失败路径均由 scope guard 清理。

2026-07-16 同一服务又通过 Direct capability-closed gate 与 capability 发布后的 Manager-gated Phase 5D 同一矩阵：

```text
projections_created=2
index_types_created=5
destructive_rejections=11
submitted_actions=4
drift_conflicts=1
unsupported_rejections=5
projections_dropped=2
indexes_dropped=5
```

真实矩阵覆盖 aggregate/order 两种 Projection、五类 Index、stale plan、unsupported、无确认拒绝、四个 submitted action、mutation 收敛等待和全部对象删除。ClickHouse 26.5 的 `system.data_skipping_indices.type` 只返回 family；Describe 现在优先读取 `type_full` 保留参数，旧版 catalog 缺少该列时回退到 `type` 并继续 fail closed。两套 scratch scope 都在成功/失败路径显式 Drop table/database。

2026-07-17 同一单节点 HTTP 服务又通过 Phase 5E Direct 与 Manager-gated 相同 View/MV 矩阵；两条 evidence struct 完全相等。Window 与 Live 在当前服务上不可用，测试把它们记录为非 skip 的明确 unavailable 证据。Cluster、TLS/Cloud 与低权限没有当前环境，保持未发布并延期到 Deployment Compatibility；它们不属于 Table Designer 基础版失败。

## 10. 尚未开放

- Replicated/Shared/Distributed/Keeper/cluster DDL 与 `ON CLUSTER`；
- engine、ORDER BY、PARTITION BY、PRIMARY KEY ALTER；
- partition-scoped CLEAR/MATERIALIZE；
- mutation queue 持续 watch、kill、retry；
- DataTable insert/update/delete；
- traditional transaction UI；
- HTTPS/TLS、域名/SNI、Cloud 与真实低权限发布证据。

上述边界属于独立的 Data Write、Background Operations、Deployment Compatibility 或 Runtime Semantics/Diagnostics backlog。它们没有因为 Phase 5 基础版 capability 发布而被隐式开启；Explorer 的 Projection/Index 叶子仍是只读入口，不建立第二套 mutation workflow。ClickHouse 单节点 HTTP/IP:PORT 基础版已经发布，Cluster/TLS/Cloud 等增强只有在各自真实门禁完成后才进入公开支持矩阵。
