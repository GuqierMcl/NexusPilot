# Real Database Integration Tests

本指南说明 NexusPilot 如何在本地使用真实 PostgreSQL、MySQL、Redis、Oracle、SQLite 和 ClickHouse 实例做集成测试。它补充常规 unit test，用来验证驱动连接、metadata、表浏览和受控写入路径是否真的能和目标数据库交互。

## 准入原则

从 Oracle Phase 2 起，真实数据库驱动实现必须把真实连接测试作为验收门槛，而不是可选 smoke：

- 新增真实数据库驱动时，已实现的业务场景必须有真实数据库集成测试覆盖。
- 真实库测试必须连接目标数据库服务执行实际操作，不能只依赖 mock、SQL 字符串 unit test 或内存替身。
- 只读能力至少覆盖 connect、ping、metadata/list containers、SQL editor read query 和表/对象浏览。
- 写入能力必须覆盖 preview、commit、失败回滚、事务 commit/rollback、只读资源能力和清理路径。
- 破坏性测试必须使用 `.env.test`、`NEXPILOT_TEST_ALLOW_WRITES=true` 和 scratch 前缀，并在测试结束后 best-effort 清理临时对象。
- 日志、测试输出、issue 和 commit 中都不能出现 `.env.test` 的真实凭据。
- 真实网络测试统一放在 `src-tauri/src/real_db_tests/` 并复用 Rust driver/Manager；当前没有 Docker 环境，不创建 ClickHouse Docker/Compose fixture、独立 Bun cluster runner 或第二套网络测试入口。

当前 Oracle 是这个原则的样板驱动：随着 Phase 推进，Oracle 的真实库测试矩阵必须同步覆盖每个已经落地的业务面。PostgreSQL、MySQL 和 Redis 目前保留 legacy read-only smoke，后续按同一原则补齐完整业务覆盖。ClickHouse 已完成 Phase 1–5 单节点 HTTP checkpoint，并在同一 `real_clickhouse_smoke` 中加入基础 DataTable CRUD；`real_db_tests/clickhouse/datatable_crud.rs` 只是该顶层 gate 的内部矩阵，不是第二个 runner。覆盖普通 MergeTree 的 Insert/Update/Delete、rowSnapshot、Nullable、LowCardinality、DEFAULT、Materialized 拒绝、过期快照冲突、执行后事实与 cleanup。模板仍默认 `NEXPILOT_TEST_CLICKHOUSE_ENABLED=false`，只有本地 `.env.test` 显式启用且全局写入 gate 开启时才访问和写入真实服务。

## 配置文件

真实连接配置放在仓库根目录的 `.env.test`。该文件包含凭据，必须保持本地私有；仓库已将 `.env.test` 加入 `.gitignore`。

从安全模板开始：

```powershell
Copy-Item .env.test.example .env.test
```

编辑 `.env.test` 后，只启用你当前希望测试的驱动：

```text
NEXPILOT_TEST_POSTGRES_ENABLED=true
NEXPILOT_TEST_MYSQL_ENABLED=true
NEXPILOT_TEST_REDIS_ENABLED=true
NEXPILOT_TEST_ORACLE_ENABLED=true

# ClickHouse 默认关闭；启用后会执行真实连接、metadata 与当前已实现 Phase smoke。
NEXPILOT_TEST_CLICKHOUSE_ENABLED=false
```

缺失 `.env.test` 或对应 `*_ENABLED=false` 时，相关测试会跳过。不要在日志、issue、commit 或聊天中粘贴 `.env.test` 内容。

## 代码组织

真实库测试位于 `src-tauri/src/real_db_tests/`，按数据库拆分，避免单个测试文件继续膨胀：

- `mod.rs` 只声明模块，不放测试逻辑。
- `common.rs` 只放数据库无关的 `.env.test` 读取、类型解析和 async runtime helper。
- `postgres.rs`、`mysql.rs`、`redis.rs`、`oracle.rs`、`sqlite.rs` 分别放对应驱动的真实连接测试和该驱动专属 helper；ClickHouse 顶层 gate 位于 `clickhouse.rs`，较大的 Phase 4A/4B/4C runner 拆分到 `clickhouse/phase_four.rs`、`phase_four_b.rs`、`phase_four_c.rs`，Phase 5A–5E runner 拆分到 `clickhouse/phase_five_a.rs` 至 `phase_five_e.rs`。

新增真实数据库测试时，优先新建或扩展对应驱动模块；只有多个驱动都会使用的能力，才提升到 `common.rs`。写入测试的 scratch 对象命名、清理、权限假设和验收矩阵必须同步写回本文档。

## 只读 Smoke

只读 smoke 会连接真实数据库并执行低风险操作：

- PostgreSQL/MySQL：connect、ping、list containers、`SELECT 1`，可选浏览配置的只读表。
- Redis：connect、ping、scan keys、browse key tree。
- Oracle：connect、ping、list schemas、SQL editor read query、可选浏览配置的表，并验证 DataTable metadata preview 不会中断连接。
- SQLite：打开真实本地文件、ping、metadata、DataTable 和已实现的受控写入/事务路径。
- ClickHouse：HTTP/HTTPS connect、真实 `SELECT 1`、version、databases、server-global functions、database/table asset groups、SELECT/WITH/SHOW/DESCRIBE/EXPLAIN 与 disconnect cleanup；双重写入 gate 开启时还覆盖 Phase 2/3 fixture、Phase 4B DDL/DML/script，以及 HTTP 下 Phase 4A confirmed cancel/timeout 与 Phase 4C Raw format/save/limit/cancel/lifecycle cleanup。

## ClickHouse 配置与 Phase 3/4/5 覆盖

`.env.test.example` 已预留 ClickHouse 真实测试配置：

```text
NEXPILOT_TEST_CLICKHOUSE_ENABLED=false
NEXPILOT_TEST_CLICKHOUSE_PROTOCOL=http
NEXPILOT_TEST_CLICKHOUSE_HOST=127.0.0.1
NEXPILOT_TEST_CLICKHOUSE_PORT=8123
NEXPILOT_TEST_CLICKHOUSE_USERNAME=default
NEXPILOT_TEST_CLICKHOUSE_PASSWORD=
NEXPILOT_TEST_CLICKHOUSE_DATABASE=default
NEXPILOT_TEST_CLICKHOUSE_READ_TABLE=
NEXPILOT_TEST_CLICKHOUSE_MATERIALIZED_VIEW=
NEXPILOT_TEST_CLICKHOUSE_SCRATCH_PREFIX=nexpilot_it_
NEXPILOT_TEST_CLICKHOUSE_CLUSTER=
NEXPILOT_TEST_CLICKHOUSE_DICTIONARY=
NEXPILOT_TEST_CLICKHOUSE_LOW_PRIVILEGE_USERNAME=
NEXPILOT_TEST_CLICKHOUSE_LOW_PRIVILEGE_PASSWORD=
```

本地 HTTP 默认使用 `8123`。ClickHouse Cloud 或 secure HTTP 通常改为 `https` 和 `8443`。唯一顶层入口 `real_clickhouse_smoke` 消费这些字段；缺少现有表、cluster、dictionary、低权限账号或 HTTPS 环境时输出明确 deferred/skip reason，不能记为通过。写入 fixture 只有 `NEXPILOT_TEST_CLICKHOUSE_ENABLED=true` 与全局 `NEXPILOT_TEST_ALLOW_WRITES=true` 同时成立时才执行，并只操作经过 ASCII identifier 校验的 ClickHouse scratch prefix。Phase 3 fixture 与 Phase 2 fixture 使用不同固定 suffix，清理顺序均为 MaterializedView -> View -> Table。

Phase 3 mandatory table 包含 Int/UInt 8–256、Float32/64（含 NaN/Inf）、Decimal(38,10)、Bool、String/FixedString、Date/Date32/DateTime/DateTime64、UUID、IPv4/IPv6、Enum8、Nullable、LowCardinality、Array、Map、Tuple 与 Nested；插入 5 行形成 pageSize=2 的三页。真实断言覆盖 unsafe integer/Decimal exact text、Map key/value、Tuple/Nested structured value、Unicode/控制字符、null、page 1/2/3、Table/View/MV exact count、empty-result headers 和 free-SQL client window。JSON 与 Variant 在 self-hosted HTTP `26.5.1.882` 通过；Object 返回明确 unsupported skip，不能算 mandatory failure，也不能写成 passed。

readonly side-effect proof 通过 SQL Editor tab runtime 尝试 `INSERT`，要求 `VALIDATION_FAILED/businessOnly`，随后 `countIf` 必须为 0 且 runtime ping 仍成功。本地 guard 还验证 FORMAT、INTO OUTFILE 与 multi-statement 拒绝。测试不会打印 host authority、username、password 或含凭据 URL。当前 2026-07-12 self-hosted HTTP `26.5.1.882` 的 mandatory Phase 3 fixture 已通过；Distributed、环境依赖 Dictionary、Object、真实低权限用户和 Cloud HTTPS 是各自增强发布前的明确 deferred，不阻塞单节点 HTTP/IP:PORT 基础版。

Phase 2 的版本兼容不依赖手写版本号阈值。driver 先从 `system.columns` 读取目标 system table 的可见列名，再只从硬编码白名单生成查询；缺少非必要列时对应 property 被省略，缺少可选 dictionaries/indexes/projections system table 时相应分组为空。该发现请求和实际 metadata 请求都受 runtime shutdown 与 timeout 控制；权限、网络、认证或解码错误不能伪装成“旧版本缺列”。unit tests 覆盖缺列 query builder，真实 smoke 负责验证当前服务端的查询和 Row 解码。

Phase 4 真实 checkpoint 继续使用同一个 `real_clickhouse_smoke`，但按能力分层：

- Phase 4A 在 `protocol=http` 时运行，真实验证后端 execution/query UUID、live progress 或明确 unavailable、exact target confirmed cancel、30 秒 operation timeout、query absence、ping、tab/profile cleanup。
- Phase 4B 同时要求 `NEXPILOT_TEST_ALLOW_WRITES=true` 和 `protocol=http`，只在验证过的 scratch prefix 下执行 CREATE、INSERT、ALTER、mutation、DELETE、事实 SELECT、managed sequence、stop-on-first-error、Stop Queue、Cancel Active 与 cleanup。
- Phase 4C 同时要求 `NEXPILOT_TEST_CLICKHOUSE_ENABLED=true`、`NEXPILOT_TEST_ALLOW_WRITES=true` 和 `protocol=http`。runner 使用 test-only Manager + 独立 `TempDir` artifact root，真实验证 CSVWithNames、JSONEachRow、Parquet hex preview、同一 source 两次另存、release 后 `RESOURCE_NOT_FOUND`、受控小上限失败、server-confirmed Raw cancel，以及 tab/profile/app cleanup；测试输出不打印 SQL、artifact temp path 或 destination path。

完整通过时输出三个固定 marker：

```text
ClickHouse Phase 4A real HTTP checkpoint passed: managed/query-id/progress-or-unavailable/confirmed-cancel/timeout/ping/tab-profile-cleanup
ClickHouse Phase 4B real HTTP write checkpoint passed: direct-ddl/insert/alter/mutation/delete/managed-sequences/stop-queue/cancel-active/cleanup
ClickHouse Phase 4C real HTTP checkpoint passed: raw-format/text-binary-preview/artifact-save/limit/cancel/release/tab-profile-app-cleanup
```

2026-07-14 的 self-hosted HTTP 实证为 `protocol=http`、`server_version=26.5.1.882`，三个 marker 同时通过。Cloud HTTPS、真实低权限、Distributed 和环境依赖 Dictionary 是各自增强发布前的 deferred；HTTP checkpoint 不改变这些矩阵的延期状态，也不让它们阻塞单节点基础版。`INTO OUTFILE` 的 zero-byte 语义由 unit contract 覆盖，当前真实环境没有配置安全 server-side outfile scratch path，因此不属于 Phase 4C marker。

Phase 5A–5E 继续复用同一个 `real_clickhouse_smoke`，没有第二个 Cluster runner：

- Phase 5A：无损 Table Describe 与稳定 revision；
- Phase 5B：Database/Table Create 的 capability-closed Direct 与发布后 Manager 同矩阵；
- Phase 5C：Table ALTER/Drop/Column Clear/Materialize、确认、漂移、partial/unknown；
- Phase 5D：Projection/Index Create/Drop/Materialize/Clear；
- Phase 5E：七类 View support/Describe、Local/Temporary Create/Alter/Rename/Drop、owner-session expiry、背景工作与 Cluster-unpublished gate。
- 基础 DataTable CRUD：`clickhouse/datatable_crud.rs` 作为同一 smoke 的内部矩阵，覆盖 rowSnapshot、Insert/Update/Delete、DEFAULT、Nullable、LowCardinality、生成列拒绝、过期快照冲突、事实核验与 scratch cleanup。

2026-07-18 单节点 HTTP ClickHouse `26.5.1.882` 复测通过以下 marker，且同次 Phase 4/5 marker 继续通过：

```text
ClickHouse basic DataTable CRUD checkpoint passed: inserts=1; updates=1; deletes=1; conflicts=1; generated_rejections=1
```

2026-07-17 单节点 HTTP ClickHouse `26.5.1.882` 的 Phase 5E Direct 与 Manager marker 均通过，且 evidence struct 完全相等：

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

Window/Live unavailable 是非 skip 的明确服务端能力证据。当前服务器只有一个通过 HTTP IP:PORT 访问的节点，没有域名、SSL 证书、Keeper 或可控的多节点环境；因此 Cluster、HTTPS/TLS、Cloud 与真实低权限矩阵统一延期到 Deployment Compatibility 独立增强。延期期间 `clusterDdl.executable=false`，`ON CLUSTER` 在网络发送前 fail closed；topology/full-node baseline、partial/unknown、redaction 与 no-retry 仅保留 unit/contract 覆盖，不冒充真实多节点通过。未来取得真实环境后，网络测试仍扩展本目录与同一顶层 gate，不建立 Docker/Compose 测试设施。

运行全部真实库 smoke：

```powershell
cd src-tauri
cargo test real_ -- --nocapture
```

运行单个驱动：

```powershell
cd src-tauri
cargo test real_oracle_read_only_and_metadata_smoke -- --nocapture
cargo test real_postgres_read_only_smoke -- --nocapture
cargo test real_mysql_read_only_smoke -- --nocapture
cargo test real_redis_read_only_smoke -- --nocapture
cargo test real_db_tests::clickhouse::real_clickhouse_smoke -- --ignored --exact --nocapture
```

## 写入门控

写入/破坏性测试默认关闭：

```text
NEXPILOT_TEST_ALLOW_WRITES=false
```

只有当你确认测试账号连接的是可丢弃数据库、schema 或专用测试实例时，才能改为：

```text
NEXPILOT_TEST_ALLOW_WRITES=true
```

写入测试必须使用对应驱动的 scratch prefix 生成临时对象，并在测试结束时清理。ClickHouse 使用 `NEXPILOT_TEST_CLICKHOUSE_SCRATCH_PREFIX`；其他关系型驱动继续使用各自文档约定的 prefix。当前 MySQL / PostgreSQL / Oracle 都包含真实 scratch 表删除测试，会先创建临时普通表，再通过 `preview_drop_table` / `drop_table` 验证 SQL 预览、破坏性确认门控和执行后的对象缺失。当前 Oracle scratch 写入测试还会创建临时普通表，走 DataTable insert/update/delete preview + commit、事务 commit/rollback、无主键表只读、view 只读、复合主键 DML、Table Designer describe/create/update/destructive/drift 路径，再查询或 describe 确认结果并 drop 临时对象。

运行 Oracle 写入 smoke：

```powershell
cd src-tauri
cargo test real_oracle_writable_datatable_scratch_smoke -- --nocapture
cargo test real_oracle_transaction_rollback_scratch_smoke -- --nocapture
cargo test real_oracle_transaction_commit_scratch_smoke -- --nocapture
cargo test real_oracle_readonly_resource_capabilities_scratch_smoke -- --nocapture
cargo test real_oracle_composite_primary_key_scratch_smoke -- --nocapture
cargo test real_oracle_describe_table_design_scratch_smoke -- --nocapture
cargo test real_oracle_create_table_design_scratch_smoke -- --nocapture
cargo test real_oracle_update_table_design_safe_scratch_smoke -- --nocapture
cargo test real_oracle_update_table_design_frontend_roundtrip_add_column_scratch_smoke -- --nocapture
cargo test real_oracle_update_table_design_destructive_scratch_smoke -- --nocapture
cargo test real_oracle_update_table_design_drift_conflict_scratch_smoke -- --nocapture
```

运行关系型删除表写入 smoke：

```powershell
cd src-tauri
cargo test real_mysql_drop_table_scratch_smoke -- --nocapture
cargo test real_postgres_drop_table_scratch_smoke -- --nocapture
cargo test real_oracle_drop_table_scratch_smoke -- --nocapture
```

如果 `NEXPILOT_TEST_ALLOW_WRITES=false`，该测试会返回通过但不执行真实写入。

## 关系型删除表覆盖矩阵

| 驱动 | 自动化覆盖 |
| --- | --- |
| MySQL | `real_mysql_drop_table_scratch_smoke`：创建 scratch 表、预览 DROP TABLE、校验未确认执行被拒绝、确认删除并验证表不可再读取 |
| PostgreSQL | `real_postgres_drop_table_scratch_smoke`：在 scratch schema 创建表、预览 DROP TABLE、校验未确认执行被拒绝、确认删除并验证表不可再读取 |
| Oracle | `real_oracle_drop_table_scratch_smoke`：在 scratch owner 创建普通表、预览 DROP TABLE 且不带 `PURGE`、校验未确认执行被拒绝、确认删除并验证表不可再读取 |

## Oracle 覆盖矩阵

| 业务面 | 当前自动化覆盖 |
| --- | --- |
| 连接与 ping | `real_oracle_read_only_and_metadata_smoke` |
| Explorer schema metadata | `real_oracle_read_only_and_metadata_smoke` |
| SQL editor 只读查询 | `real_oracle_read_only_and_metadata_smoke` |
| DataTable browse 与列 metadata | `real_oracle_read_only_and_metadata_smoke`，可选配置现有表 |
| DML preview | `real_oracle_writable_datatable_scratch_smoke` |
| 即时 insert / update / delete commit | `real_oracle_writable_datatable_scratch_smoke` |
| `DATE` / `TIMESTAMP` typed literal | `real_oracle_writable_datatable_scratch_smoke` 覆盖 `TIMESTAMP(6)` |
| 事务 rollback | `real_oracle_transaction_rollback_scratch_smoke` |
| 事务 commit | `real_oracle_transaction_commit_scratch_smoke` |
| 无主键普通表只读 | `real_oracle_readonly_resource_capabilities_scratch_smoke` |
| View 只读 | `real_oracle_readonly_resource_capabilities_scratch_smoke` |
| 复合主键 update/delete | `real_oracle_composite_primary_key_scratch_smoke` |
| Table Designer `describe_table` | `real_oracle_describe_table_design_scratch_smoke` |
| Table Designer create preview / execute / describe refresh | `real_oracle_create_table_design_scratch_smoke` |
| Table Designer safe alter preview / execute | `real_oracle_update_table_design_safe_scratch_smoke` |
| Table Designer frontend draft roundtrip 后新增列 | `real_oracle_update_table_design_frontend_roundtrip_add_column_scratch_smoke` |
| Table Designer destructive alter / constraint update / confirm gate | `real_oracle_update_table_design_destructive_scratch_smoke` |
| Table Designer drift conflict | `real_oracle_update_table_design_drift_conflict_scratch_smoke` |
| Explorer 删除普通表 preview / execute / confirm gate | `real_oracle_drop_table_scratch_smoke` |
| Materialized view 只读 | 后续 Phase 或具备权限的测试实例补充 |

## Oracle 注意事项

Oracle metadata 与 DDL 路径经过真实 Oracle 验证后采用以下约束：

- 可见列集合来自 `ALL_TAB_COLUMNS`，避免暴露 system-generated hidden columns。
- `virtual_column` 标记来自 `ALL_TAB_COLS` 左连接；部分 Oracle 环境的 `ALL_TAB_COLUMNS` 不暴露 `VIRTUAL_COLUMN`，直接查询会被 `oracle-rs 0.1.7` 表现为连接中断。
- metadata 查询拆为列、主键、唯一列三条 SQL；每条 SQL 只绑定一次 owner/table，避免重复 placeholder 或复杂字典查询触发驱动兼容问题。
- DataTable DML commit 使用后端生成的 safe typed literal SQL 和 `execute(sql, &[])`，不走当前不稳定的 bound DML 路径；`DATE` / `TIMESTAMP` 列必须渲染为 `TO_DATE(...)` 或 `TIMESTAMP '...'`，不能作为普通字符串 literal 写入。
- Table Designer `describe_table` 使用低频字典查询读取 `DATA_DEFAULT_VC` / `SEARCH_CONDITION_VC`、comments、identity、virtual generated、constraints、indexes 和分区只读摘要；系统生成的 NOT NULL check constraint 不应暴露为用户可编辑 CHECK。
- Oracle schema mutation 测试必须同时覆盖 preview 与 execute。`update_table` 必须先重新 describe 并与 baseline 做语义比较；远端 drift 返回 `RESOURCE_CONFLICT`。Table Designer 前端不会回传 PK/Unique 的 `enforced=true` 默认形态，Oracle drift 检测需要把该等价差异规范化，不能误拦普通新增列。破坏性 update 必须先在 preview 中设置 `destructive=true`，执行时没有 `confirmDestructive=true` 必须拒绝。

## 失败处理

真实库测试失败时，先判断是哪一层失败：

- 连接或 ping 失败：检查 `.env.test` host、port、service/database、账号和网络。
- metadata 或 browse 失败：保留错误日志中的 operation、driver、schema/table 和 SQL 摘要，不要粘贴凭据。
- 写入测试失败：确认 `NEXPILOT_TEST_ALLOW_WRITES=true` 是否有意开启，测试账号是否有 create/drop table 和 DML 权限，scratch prefix 是否指向可丢弃对象。

修复驱动行为后，至少运行：

```powershell
cd src-tauri
cargo test real_ -- --nocapture
cargo test oracle
cargo fmt --check
```

涉及前端契约时还要运行：

```powershell
bun run tsc --noEmit
```
