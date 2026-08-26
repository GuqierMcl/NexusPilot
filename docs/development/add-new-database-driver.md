# 如何在 NexusPilot 中新增数据库驱动类型

> **当前架构**：后端 live runtime 使用 capability-driven driver runtime。不要通过扩展旧连接池枚举或集中式 match 分支接入新驱动；新驱动应实现 `DatabaseDriver` 及对应 capability trait，并通过 `DriverRegistry` 注册。整体架构见 [connection-runtime.md](../architecture/connection-runtime.md)，跨 transport 生命周期语义见 [database-runtime-session.md](../architecture/database-runtime-session.md)。
>
> **Oracle 经验**：非 SQLx 关系型驱动也应保持同一套 capability trait 与 IPC。Oracle Phase 1 使用 `oracle-rs` + `deadpool-oracle`，连接池保留在具体 driver 内，Manager 仍只持有 `Arc<dyn DatabaseDriver>`。

本指南基于连接配置层（`IConnectionProfile` 联合类型 + `payload` 扩展模式），描述在 NexusPilot 桌面客户端中新增数据库驱动支持的完整步骤。

以新增 Neo4j 图数据库为例说明（图型驱动，采用 `INetworkConfig` 扩展模式）。

---

## 整体思路

NexusPilot 采用**"关系列 + payload 扩展列"**的混合设计：

- SQLite 中的通用元数据列（`id`、`name`、`driver`、`environment` 等）在架构级固定；
- 每种驱动的差异化字段打包为 JSON 存储在 `payload` 列，无需 `ALTER TABLE`；
- TypeScript 中通过判别联合类型（`driver` 字段为判别键）保证类型安全；
- 前端只需注册已实现的驱动，未注册的驱动不会导致编译失败。

连接产品语义统一使用**数据库运行时会话（Database Runtime Session）**，不以常驻 socket 作为 `connected` 的定义。新驱动无论使用 SQLx pool、HTTP/HTTPS、云 API、无状态 SDK 还是本地文件，都必须说明：真实连接探测、shared runtime 资源、tab runtime 隔离、health 错误分类、remote cache 失效和服务端长任务恢复。不要为 HTTP 或云 API 驱动绕过统一状态机，也不要仅因 client 对象构造成功就报告已连接。

Workbench 前端扩展必须遵守注册制约束：新增驱动时优先补 `ExplorerDriverConfig`、节点视觉 registry、远程 action contributor、content tab registration 和 content tab lifecycle registration；不要把具体驱动差异写回 `ConnectionTreeNode`、`ExplorerNodeIcon`、`ContentToolbar`、`ContentTabBar`、`ContentTabView` 或 `workbench-tabs-slice`。详细规则见 [workbench-registry-constraints.md](./workbench-registry-constraints.md)。

---

## 1. 前端：扩展类型定义

**文件：** `src/types/connections.ts`

### 1.1 在 `DbDriver` 联合类型中已注册

打开文件检查 `DbDriver` 类型。多数早期规划驱动已经预先列出，但规划中的数据库不保证都已注册；ClickHouse 已完成单节点 HTTP/IP:PORT 基础版并作为已支持分析型数据库发布，其他部署形态仍按独立兼容性矩阵开放。新驱动未出现时，应在对应分类追加，并同步 Rust `ConnectionDriver`、payload 联合和 runtime profile：

```ts
export type DbDriver =
    // ... 现有驱动 ...
    | "neo4j" | "neptune" | "arangodb";  // 图型（已内置）
```

### 1.2 定义驱动专属 Payload 类型

根据驱动的连接模式，选择继承 `INetworkConfig`（网络直连）、`ILocalFileConfig`（本地文件）或 `ICloudApiConfig`（云端 API）：

```ts
// 网络直连型示例（Neo4j）
export interface INeo4jPayload extends INetworkConfig {
    driver: "neo4j";
    database?: string;
    encryption?: "basic" | "tls";
}
```

`INetworkConfig` 已包含通用高级连接字段：`connectTimeoutSeconds` 与可选 `sshTunnel`。新增网络型驱动如果支持实际后端连接，前端默认配置和校验应显式处理这两个字段；后端 profile 也应保持 camelCase serde 对齐。驱动专属 SSL/TLS 字段仍放在各自 payload 中，不要把 TLS 选项塞进通用 SSH 配置。

### 1.3 将 Payload 加入 `IConnectionProfile` 联合类型

```ts
export type IConnectionProfile = IBaseConnectionProfile & (
    | IMysqlPayload
    | IPostgresPayload
    // ...其他已有驱动...
    | INeo4jPayload    // ← 新增
);
```

**文件：** `src/types/index.ts`

导出新增的 Payload 类型：

```ts
export type {
    // ...
    INeo4jPayload,
    // ...
} from "./connections"
```

---

## 2. 前端：添加驱动配置与表单

### 2.1 注册 payload 类型映射

**文件：** `src/features/workbench/explorer/driver-configs/types.ts`

在 `DriverConfigValueMap` 中新增一行：

```ts
export type DriverConfigValueMap = {
    mysql:    Omit<IMysqlPayload,    "driver">;
    postgres: Omit<IPostgresPayload, "driver">;
    redis:    Omit<IRedisPayload,    "driver">;
    neo4j:    Omit<INeo4jPayload,    "driver">;  // ← 新增
};
```

> **注意**：`Omit<..., "driver">` 去掉判别字段，由 `ExplorerDriverConfig<"neo4j">` 上下文提供。

### 2.2 创建表单组件

**文件：** `src/features/workbench/explorer/components/connection-forms/Neo4jConnectionForm.tsx`

组件接收 `value: DriverConfigValueMap["neo4j"]` 和 `onChange`，实现受控表单输入。参考 `MySqlConnectionForm.tsx` 的结构：

```tsx
import type { DriverConfigValueMap } from "@/features/workbench/explorer/driver-configs/types";

type Value = DriverConfigValueMap["neo4j"];

export function Neo4jConnectionForm({ value, onChange, disabled }: {
    value: Value;
    onChange: (v: Value) => void;
    disabled?: boolean;
}) {
    // ...
}
```

### 2.3 创建驱动配置文件

**文件：** `src/features/workbench/explorer/driver-configs/neo4j.tsx`

驱动品牌图标不要手动下载到 `src/assets/`。先按 [database-driver-icons.md](./database-driver-icons.md) 生成并注册图标组件，然后从 `@/components/icons/database` 导入稳定图标组件。

实现并导出一个 `ExplorerDriverConfig<"neo4j">` 对象：

```tsx
import type { ExplorerDriverConfig } from "@/features/workbench/explorer/driver-configs/types";
import { Neo4jIcon } from "@/components/icons/database";

export const neo4jDriverConfig: ExplorerDriverConfig<"neo4j"> = {
    driver: "neo4j",
    displayName: "Neo4j",
    pickerDescription: "连接到 Neo4j 图数据库",
    pickerIcon: Neo4jIcon,
    category: "graph",
    treeVisual: { /* ... */ },
    connectionModel: "network",
    driverMenuItems: [
        // 可选：仅用于 connection 节点的驱动专属菜单。
        // 远程节点菜单由 explorer action registry 基于 ContainerRef/capabilities 生成。
    ],
    createDefaultConfig: () => ({
        host: "localhost",
        port: 7687,
        username: "neo4j",
        password: "",
        savePassword: false,
        database: "neo4j",
        encryption: "basic",
    }),
    validate: (config) => {
        if (!config.host.trim()) return "请填写主机地址";
        if (config.port < 1 || config.port > 65535) return "端口必须在 1–65535 之间";
        return null;
    },
    renderForm: ({ value, onChange, disabled }) => (
        <Neo4jConnectionForm value={value} onChange={onChange} disabled={disabled} />
    ),
};
```

### 2.4 注册到驱动配置表

**文件：** `src/features/workbench/explorer/driver-configs/index.ts`

在文件顶部新增导入，然后把新驱动加入 `DRIVER_CONFIGS`：

```ts
// 1. 顶部 import（与其他驱动放在一起）
import { neo4jDriverConfig } from "@/features/workbench/explorer/driver-configs/neo4j";

// 2. DRIVER_CONFIGS 对象内新增一行
export const DRIVER_CONFIGS: DriverConfigRegistry = {
    mysql: mysqlDriverConfig,
    postgres: postgresDriverConfig,
    redis: redisDriverConfig,
    neo4j: neo4jDriverConfig,  // ← 新增
};
```

`DriverConfigRegistry` 的类型定义为 `{ [K in ImplementedDriver]: ExplorerDriverConfig<K> }`，
新增 `neo4j` 后 `ImplementedDriver` 自动扩展，TypeScript 会要求 `DRIVER_CONFIGS` 补全该键。

> `ConnectionEditDialog.tsx` 动态读取 `DRIVER_CONFIGS`，**无需修改**。

若新驱动的保存查询挂载位置、连接树视觉、远程节点动作与既有驱动不同，也应继续在 driver config 或对应 registry 中注册：

- `savedQueryContextLevels`：SQL 保存查询挂载到 database、schema 或不挂载。
- `treeVisual`：连接节点品牌图标和状态 badge。
- `remoteActionContributors`：驱动专属远程节点动作。

不要为了新驱动去修改 `savedQueryNodes`、`ExplorerNodeIcon` 或 `ConnectionTreeNode` 的具体分支。

### 2.5 在数据库选择对话框中启用该驱动

**文件：** `src/features/workbench/explorer/components/SelectDatabaseTypeDialog.tsx`

这是**容易遗忘的一步**。`ALL_DATABASE_TYPES` 是静态列表，未实现的驱动用 `driver: null, isImplemented: false` 占位。实现新驱动后，需把对应条目更新为真实值：

```ts
// 改造前（占位状态）
{ driver: null,    displayName: "Neo4j", ..., isImplemented: false },

// 改造后（已实现）
{ driver: "neo4j", displayName: "Neo4j", ..., isImplemented: true  },
```

图标会通过 `getIconForDriver()` 自动从 `DRIVER_CONFIGS` 中读取，**无需手动传入**。

---

## 3. 后端 (Rust)：扩展驱动枚举（本地存储层）

**文件：** `src-tauri/src/repository/connection_repository.rs`

`ConnectionDriver` 枚举中所有 16 种驱动均已预先声明。如果新驱动尚未在枚举中，仿照格式追加：

```rust
pub enum ConnectionDriver {
    // ...
    Neo4j,     // 已内置
    Neptune,
    Arangodb,
}
```

同时更新 `as_str` 和 `FromStr`：

```rust
// as_str
Self::Neo4j => "neo4j",

// from_str
"neo4j" => Ok(Self::Neo4j),
```

> **重要**：`payload` 列为 JSON 文本，Rust 端使用 `serde_json::Value` 透明传递，无需为每个驱动编写专属的 Rust 结构体。
> 只有在后端需要访问驱动特定字段时（如建立实际连接），才需要将 `payload` 反序列化为具体结构。

### 关于本地存储 IPC 层

**文件：** `src/lib/tauri/connections.ts` — **无需修改**。

该文件内置了双向转换逻辑：

- **`nestPayload()`**：出方向 — 把前端扁平的 `ICreateConnectionInput` 自动拆分为 Rust 要求的 `{ ..., payload: {...} }` 结构；
- **`flattenRecord()`**：入方向 — 把 Rust 返回的嵌套 `{ payload: {...} }` 展开为前端扁平的 `IStoredConnectionProfile`。

新驱动的任意字段均会被正确透传，**不需要改动此文件**。

---

## 4. 后端 (Rust)：接入数据库运行时会话

> 本节适用于需要让驱动支持实际数据库连接（建连、查询、元数据浏览）的情况。
> 如果当前只是新增驱动的 UI 占位，可先跳过此节。

NexusPilot 的数据库运行时会话由 **连接引擎模块** (`src-tauri/src/engine/`) 统一管理，所有驱动在该模块中汇聚，与本地存储层（SQLite CRUD）完全解耦。具体 transport 资源保留在 driver 内：它可以是 pool、HTTP client、单连接、文件 handle、SSH tunnel 或云 SDK。

`connect_profile` 必须执行真实远端探测，再向 Manager 注册 runtime。惰性 HTTP client、格式正确的 URL 或 payload 反序列化成功都不足以证明已连接。错误还必须通过 `IpcError.runtimeImpact` 显式区分 `businessOnly/retryable/terminal`；SQL 语法、对象不存在、校验或单个业务操作超时不能让整个 profile 进入 disconnected/error。通用前端已实现 `idle/connecting/connected/degraded/reconnecting/error/disconnecting` 七态和最多三次的有限恢复，新驱动应复用它，不增加 driver-name 分支。

Manager 已统一为 shared/tab runtime construction 分配可取消 attempt，并在 attempt 锁内完成“仍是 current”的校验与 runtime map 原子注册。新驱动的 async constructor 必须具备 cancellation safety：future 被 drop 时，尚未注册的 client/pool/tunnel 能靠 RAII 释放；如果 driver 已构造但 attempt 失效，`close()`/drop 必须安全回收资源。不要绕过 Manager 自行把 driver 塞入其他全局 map。

### 4.1 添加 Cargo 依赖

**文件：** `src-tauri/Cargo.toml`

引入新驱动的 sqlx 特性（或专属 crate）：

```toml
[dependencies]
# 已有 mysql 与 postgres 特性，追加 sqlite 举例
sqlx = { ..., features = ["runtime-tokio-native-tls", "mysql", "postgres", "sqlite"] }

# 对于非 sqlx 支持的驱动，引入对应 crate，例如 Neo4j：
# neo4rs = "0.7"

# 对于非 SQLx 关系型驱动，可使用对应连接与 pool crate，例如 Oracle：
oracle-rs = "0.1.7"
deadpool-oracle = "0.1.1"

# HTTP 数据库也使用官方 client；例如 ClickHouse Phase 1 使用 rustls/native roots：
clickhouse = { version = "0.15.1", default-features = false, features = [
    "lz4", "rustls-tls-ring", "rustls-tls-native-roots"
] }
```

### 4.2 定义强类型 DriverProfile

**文件：** `src-tauri/src/engine/profiles.rs`

新增驱动 profile，并加入 `DriverProfile` 判别联合：

```rust
#[derive(Clone, Deserialize, Serialize)]
pub struct Neo4jProfile {
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: String,
    pub connect_timeout_seconds: Option<u64>,
    pub ssh_tunnel: Option<SshTunnelProfile>,
    pub database: Option<String>,
    pub encryption: Option<String>,
}

impl fmt::Debug for Neo4jProfile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Neo4jProfile")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("password", &"[REDACTED]")
            .field("ssh_tunnel", &self.ssh_tunnel.as_ref().map(|_| "[REDACTED]"))
            .field("database", &self.database)
            .finish()
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "driver", rename_all = "lowercase")]
pub enum DriverProfile {
    Mysql(MysqlProfile),
    Postgres(PostgresProfile),
    Redis(RedisProfile),
    Neo4j(Neo4jProfile),
}
```

`DriverRegistry` 会把 SQLite 中的 `record.driver` 注入到 `payload.driver` 字段后再反序列化，因此 profile struct 只描述 payload 内的驱动专属字段。

包含数据库密码、token、private-key passphrase 或内嵌 `SshTunnelProfile` 的 profile 不得直接派生会输出全部字段的 `Debug`。应实现脱敏 `fmt::Debug`，只输出安全 endpoint/username 与 `[REDACTED]` 标记；同时测试 `DriverProfile::{新驱动}` 的嵌套 Debug 结果不包含数据库和 SSH 测试 secret。诊断日志也不得记录原始 payload。

### 4.3 实现 driver module

**文件：** `src-tauri/src/engine/drivers/neo4j.rs`

driver 结构体应持有具体连接资源，并实现 `DatabaseDriver` 与需要的 capability trait。Manager 不应知道 `neo4rs::Graph`、`PgPool`、`MySqlPool`、`deadpool_oracle::Pool`、Redis client 等具体类型。

Oracle 这类非 SQLx 关系型驱动仍应实现现有 capability trait，而不是新增 Oracle 专属 IPC。连接池保留在具体 driver 内，Manager 只持有 `Arc<dyn DatabaseDriver>`。如果驱动依赖不支持 SQLx 风格连接池，可使用对应 crate 的 pool，例如 Oracle Phase 1 使用 `deadpool-oracle`。

网络型驱动物化 runtime transport 前，必须先把 `host` 校验为该驱动明确支持的纯 hostname/IP，不接受 scheme、userinfo、内嵌 port、path/query/fragment 或其他 URL authority 元字符；该校验必须发生在 DNS、SSH 或任何网络动作之前。之后通常调用 `crate::engine::ssh_tunnel::resolve_endpoint(&profile.host, profile.port, profile.ssh_tunnel.as_ref()).await?`，并只使用返回的 `ResolvedEndpoint { host, port, tunnel }` 建连，把 `tunnel` 存在 driver 结构体中，确保 SSH 隧道与 driver 同生命周期。需要原始 hostname 做 TLS SNI/identity verification 的模式必须先设计安全路由；当前 PostgreSQL `verify-full`、MySQL `verify-identity` 和 ClickHouse HTTPS 都在 SSH 下 fail closed，不能为了“连通”而关闭证书或 hostname 校验。

HTTP/云 API 驱动同样必须执行真实 authenticated probe，并对每段 probe 设置超时。例如 ClickHouse Phase 1 在返回 driver 前按顺序验证 `SELECT 1`、`version()` 和 system catalog 权限；只有明确的 catalog permission denial 可以降级为资源能力观察，network/auth/timeout/decoding 不能被吞掉。

```rust
pub struct Neo4jDriver {
    profile_id: String,
    graph: Arc<neo4rs::Graph>,
    _tunnel: Option<SshTunnelRuntime>,
}

#[async_trait::async_trait]
impl DatabaseDriver for Neo4jDriver {
    fn profile_id(&self) -> &str { &self.profile_id }
    fn driver_name(&self) -> &'static str { "neo4j" }
    fn capabilities(&self) -> DriverCapabilities {
        DriverCapabilities {
            schema_browser: true,
            graph_queryer: true,
            ..DriverCapabilities::default()
        }
    }

    async fn ping(&self) -> IpcResult<PingResult> { /* ... */ }
    async fn close(&self) -> IpcResult<()> {
        // 通知并终止 driver 自己持有的 probe/query/watch，再释放 transport。
        Ok(())
    }

    fn as_schema_browser(&self) -> Option<&dyn SchemaBrowser> { Some(self) }
}
```

### 4.4 实现 capability

按驱动范式选择能力：

| 能力 | 适用范式 | 前端入口 |
|------|----------|----------|
| `SchemaBrowser` | 需要资源树浏览的驱动 | `list_containers` |
| `SchemaMutator` | 复用关系型 `TableSchema` mutation contract 的驱动 | 现有 table/database preview/execute commands |
| `NativeSchemaExtension` | 需要原生强类型 schema document/change、且不适合塞入关系型 `TableSchema` 的驱动 | driver-specific strong typed Describe/Create/Change commands + schema surface/drop operation registry |
| `DataTableBrowser` | 能以二维表分页浏览的驱动 | `browse_table_data` |
| `SqlExecutor` | SQL 方言驱动 | `execute_sql` |
| `ManagedSqlExecutor` | 需要可恢复单语句 lifecycle、服务端取消或进度的 SQL 驱动 | `start/get/cancel/release_sql_execution` |
| `KeyValueBrowser` | Redis 等 key-value 驱动 | `browse_key_tree` / `scan_key_values` / `get_key_value` |
| `GraphQueryer` | Neo4j 等图驱动 | 预留 |
| `VectorSearcher` | 向量数据库 | 预留 |

`list_containers` 应返回统一的 `DataContainer[]`，每个节点携带后续寻址所需的 `ContainerRef`。前端只根据 `kind` 和 `container.groupType` 渲染，不应猜测驱动层级。

连接级命名对象使用 `ContainerRef::connection_named_object`，其 `database=None`；表内 index/projection/partition 等命名对象使用 `ContainerRef::table_named_object`，必须同时携带 database、table 与 objectName。`DataContainer.properties` 只用于通用只读展示，不能替代地址字段，也不能决定 capability、菜单资格或 destructive action。properties 必须去除 credential/URL authority/raw response，并对表达式和摘要设置长度上限。

允许按阶段只实现 `DatabaseDriver` 并让 `DriverCapabilities::default()` 全 false。此时 runtime 可以真实连接和 ping，但 Explorer 必须把 `connected + schemaBrowser=false` 解释为“不支持元数据”，不得发起 `list_containers` 或误报连接失败。

`DriverCapabilities.sqlExecutor` 只表示“SQL Editor 可用”；可选 `DriverCapabilities.sqlExecution` 才声明 managed lifecycle、statement access、active cancel、live progress、query summary、Raw result 与 configurable timeout。managed driver 必须在 coordinator register 前通过自身 classifier 返回中性 statement class；未知语句不能被公共层误当成写入白名单。服务端取消必须区分本地 cancellation token 与服务端确认，progress/control 降级应以有界、非终止的 `observationWarnings` 持久化，而不是改变主 query 终态。

结构变更必须声明可选 `DriverCapabilities.schemaMutation`。它按 `ContainerKind` 列出 `create/alter/rename/drop/clear/materialize`，并声明 driver 级 `ddlPreview/destructiveConfirmation/remoteDriftProtection` 设施。前端只通过 `supportsSchemaMutation()` 判断具体操作；`schemaMutator` 是关系型 `SchemaMutator` trait 的迁移期兼容字段，不能再被用于推导某个 create/alter/drop。内置关系型 driver 目前让该 bool 与 `schemaMutation.is_some()` 保持一致；native extension 可以保持 `schemaMutator=false` 并声明自己真正实现的结构化操作。只读 native schema surface 不需要、也不得伪造 mutation capability。

如果目标数据库的结构语义不能被关系型 `TableSchema` 无损表达，实现 `DatabaseDriver::as_native_schema_extension()`，使用 tagged `NativeSchemaDescribeRequest` / `NativeSchemaDocument` 在 Manager 内分发，再由专属 Tauri command 返回具体 Rust/TypeScript strong type。需要结构写入时，在同一通用 extension 上增加 tagged create/change target、baseline、request、plan 与 result；需要版本/edition/权限能力探测或 tab-scoped 对象时，再增加 typed support/session document。不能把 driver-specific payload 降级为任意 `serde_json::Value`，也不要为每个数据库向 `DatabaseDriver` 添加 `as_clickhouse_*` / `as_mongo_*` accessor。Describe 必须返回 editability/blocker 与稳定 baseline；未知或来源冲突语义 fail closed。ClickHouse Phase 5E 是当前参考实现：Table 与 View create/edit surface 独立，Drop 使用通用 operation registry，Projection/Index 使用专属 section，Temporary View 复用 owner tab runtime，`schemaMutator=false`，`schemaMutation` 精确公布 native database/table/column/projection/index/view/materialized_view 七个对象项。

原生对象 action 不必塞入关系型 `SchemaMutator` 或公共 Table Designer。可以按 driver/object 注册专属 section/tab，但必须继续遵守同一安全模型：每个 action 使用 strong tagged target、完整权威 baseline、确定性 preview/plan hash、精确 `object + operation` capability 与 post-verify；未知定义无损只读。若对象依赖会让主对象变更不安全，应让主对象 planner fail closed，同时保留对象专属 section 的删除/收敛能力，避免形成无法解除的只读死锁。

Native create 至少遵守以下顺序：

1. 先以关闭 capability 的真实 driver 运行 direct extension gate，证明强类型 target、冲突、post-verify 与 cleanup；不能靠前端隐藏入口代替后端 gate。
2. preview 与 execute 共用同一 fail-closed validator/renderer。preview 返回确定性 statements 与 domain-separated lowercase SHA-256 plan hash；execute 携带同一 target/hash，并在发送前重新规划核对。
3. 不自动重试 DDL。每条提交使用独立 query id、协议层等待完成选项、driver timeout/shutdown gate；重复对象必须返回 conflict，而不是用 `IF NOT EXISTS` 抹平。
4. success 以远端事实为准：database 回查 catalog，table 重新 Describe。transport/timeout/shutdown 后执行 best-effort verify；无法确认时返回 `OPERATION_OUTCOME_UNKNOWN`，前端保留 dirty draft，不 retarget、不伪造 baseline。
5. 前端 create/edit 生命周期通过 surface/lifecycle registry 注册；create draft 可以按数据库范式独立建模。公共 Toolbar、DDL drawer、底部状态栏读取中性 action/runtime model，不在共享 shell 增加 driver-name 分支。
6. Database create dialog 通过 driver config 的通用 operation adapter 选择 preview/execute；table create 通过 schema designer surface registry 选择产品 surface。只有 direct gate 和 Manager capability-gated 真实矩阵都通过后，才原子公布精确 `schemaMutation`。

Native change 还必须满足：

1. target 使用 driver-specific strong tagged type，并携带执行前所需的完整 baseline；table edit 如需 rename，使用显式 source identity intent，禁止按位置或相似度猜测。
2. preview 返回 exact statements、operation summaries、destructive/long-running、完整 baseline、expected target revision 和 domain-separated plan hash；execute 携带同一 target/baseline/hash/confirmation。
3. Manager 先按 object kind + operation gate，并验证 driver 已声明 destructive confirmation/remote drift protection；driver 在发送前重新规划、核对 hash，并重新读取远端 full baseline。revision hash 只能用于快速比较，不能代替权威远端事实。
4. destructive confirmation 必须由后端强制；前端 dialog 只负责采集确认。DDL 不重试，每条 statement 使用独立 query id，首错停止并返回 applied/failed/remaining progress。
5. 结果至少区分 applied、submitted、partially applied、outcome unknown。partial/unknown/refresh failure 不得用 desired target 覆盖 snapshot；能读取远端时返回真实 schema，不能读取时保留原 baseline。
6. Object Drop 通过通用 `schema-drop-operations` registry 注册关系型或 native adapter，公共 Explorer/dialog 不按 driver name 分支。preview 必须 fresh，Drop 只在 absence 已证明后返回 applied。
7. capability 发布仍采用“两段真实 gate”：先在 capability 关闭态直连 extension 验证完整矩阵，再原子发布并通过 Manager 重跑同一矩阵。测试 fixture 必须限制在可证明的 scratch scope，并在成功/失败路径都清理。

若原生对象依赖 tab-scoped server session，还必须补充以下边界：

1. 物理 session token/ID 只能存在于后端 driver 私有状态，IPC 与前端仅传逻辑 owner runtime ID；禁止写入 profile、日志和持久化。
2. dependent 内容 tab 在 lifecycle registry 声明 owner，不单独 open/close backend runtime；关闭 owner 时级联关闭 dependents，关闭 dependent 不影响 owner。
3. 同 session 请求按服务端要求串行，owner close/disconnect/app teardown 必须使 session 过期并 best-effort cleanup；过期后不得静默重建并假装旧临时对象仍存在。
4. shared Explorer 只展示 persistent 对象；session object 使用 owner surface/contributor 和 owner-scoped query key。

未来驱动接入 managed Raw 时，必须按同一通用顺序落地，不能直接在 driver 或前端自行写文件：

1. 先保持 `rawResult=false`，为 Manager 增加“ID/classification/register 前拒绝”的通用 fail-closed 测试；默认 Run、分页和脚本继续使用 Grid。
2. 由 `ConnectionRuntimeManager` 在成功注册显式单 statement Raw execution 后创建唯一 `RawArtifactWriter`，随 `ManagedSqlExecutionRequest` 移交；driver 不持有可复制 writer，前端只接收 opaque artifact ID。
3. driver 使用自身官方协议的 streaming bytes API，把每个 chunk 写入 writer，并准确选择 text/binary preview、format/media type、JSON-safe byte length；不得为 Raw 复制一套平行 transport，也不得改写用户 SQL 来伪造 format。
4. 复用 `save_sql_execution_artifact` 的 profile/tab/execution/artifact 四元 ownership、absolute destination、sibling temp + atomic persist 和 retryable source 语义；UI 只通过受控 save dialog 取得 destination，日志不得记录 path、preview、payload 或完整 SQL。
5. 把超限、取消、timeout、transport error、new execution、release、tab close、profile disconnect、app teardown 和 late completion 全部接入 artifact cleanup。生产边界当前为 512 MiB artifact、1 MiB text preview buffer 与 4 KiB binary hex preview buffer。
6. 使用真实目标数据库验证文本格式、二进制格式、另存重试、受控小上限、服务端确认取消、runtime health 与全生命周期清理；只有完整真实 gate 通过后，才在同一原子提交中把该驱动 `rawResult` 提升为 true。

Raw 是可复用 managed SQL 结果能力，不等于某个驱动的结构化写入、事务或 schema mutation 能力。开启 `rawResult` 不得连带开启 `schemaMutator`、`tableRowMutator`、`tableRowInserter` 或 `transactionManager`；如果某数据库需要专属结果/诊断交互，可以通过既有 tab/registry/contributor 模型扩展。

在开发分支开启每项 capability 前，至少要同时完成对应 trait、IPC/TypeScript mirror、UI gate、竞态/失败测试与文档，不能暴露半成品 feature。Phase 完成和公开产品状态还必须等待该能力要求的真实数据库 checkpoint；如果代码 capability 已原子开启而真实环境 gate 尚未执行，路线图必须明确标为 `code ready / real gate pending`，网站状态不得提前改变。

对于 ClickHouse 这类通过 HTTP 返回动态、自描述结果的驱动，不要求复用 SQLx row decoder，也不应再引入一套平行 HTTP transport。优先复用官方 client 的 raw/bytes API，选择同时携带 names/types 的固定格式，在 driver 内拆出 type AST、value normalization、incremental decoder、query policy 与 browse/free-SQL orchestration。公共 IPC 只提升可被其他数据库复用的语义，例如 `ColumnDataCategory::Structured` 和 JSON-safe integer；driver-specific type grammar、request settings 与错误分类保留在具体 driver。

动态结果 adapter 必须同时约束 response/row/cell bytes、结构深度/节点数、timeout、shutdown 与分页窗口；未知但合法的 JSON value 应安全回退，不能让整页失败。`DataTableBrowser` / `SqlExecutor` 的 Phase 验收必须用真实服务验证空结果 headers、超宽整数、Decimal scale、复杂类型、分页/count 与只读/写入边界；managed lifecycle 还必须真实验证 query ID、服务端确认取消、timeout、progress unavailable 降级和 teardown cleanup。共享 DataTable/SQL Editor 只读取 capability、context model 与中性 column category；若领域交互确实需要专属 tab，应通过既有 registry/payload 模型扩展，而不是在公共组件按 driver name 分支。

关系型或类关系型驱动应优先使用通用资产分组：

```text
database/schema -> asset_group(groupType=tables/views/functions/...)
asset_group     -> table/view/function/...
table/view      -> asset_group(groupType=columns/indexes/triggers)
```

不要新增 `list_tables`、`list_views` 这类 IPC，也不要让前端按驱动手写层级。驱动只返回自身支持的 `asset_group`；不支持的分组不要返回。

公共 Explorer 可以通过 enum、union、label/icon registry 扩展新对象类型；这种扩展具有跨驱动价值且保持领域语义。不得为了实现便利在 `buildRemoteNodes`、`ConnectionTreeNode`、visual registry 或 metadata store 中读取 driver name 决定层级、系统对象、属性或动作。系统对象是否隐藏只有在多个驱动形成统一策略后才提升为公共 policy。

### 4.5 注册驱动

**文件：** `src-tauri/src/engine/registry.rs`

在 `DriverRegistry::create_driver` 中追加新 profile 变体，构造具体 driver：

```rust
match DriverProfile::from_record(profile)? {
    DriverProfile::Neo4j(profile) => Neo4jDriver::connect(profile_id, profile).await,
    // ...
}
```

### 4.6 `engine_commands.rs` 通常无需修改

如果新驱动只接入已有 capability，命令层无需改动。只有新增全新范式命令（例如未来 `execute_cypher`、`vector_search`），或需要把 generic native schema document 收窄为一个前端 strong type 时，才扩展 `src-tauri/src/commands/engine_commands.rs` 与前端 IPC 类型。命令仍应委托 Manager/extension，不在 command 层按 driver name 实现业务逻辑。

---

## 5. 前端：接入连接引擎 IPC（可选）

当驱动已接入连接引擎后，关系型和 key-value 范式通常只需使用现有公共基础设施，**无需新增 IPC 封装**。

### 5.1 触发连接

```ts
import { useConnectionSessionStore } from '@/store';

const { connect } = useConnectionSessionStore();
await connect(profileId);  // 调用 connect_profile，保存后端 capabilities
```

公共 store 会为初始 connect 维护 attempt identity，断开或新一轮 connect 后的迟到结果不会写回 session；Rust Manager 负责取消对应 backend construction 和原子注册。`connecting/connected/degraded/reconnecting/error` 都允许用户显式关闭。断开入口必须先进入 `disconnecting`，关闭 profile tabs，并对 `queryKeys.profile(profileId)` 执行 `cancelQueries + removeQueries`；不要用 invalidate 代替 teardown 清理。

### 5.2 读取元数据

```ts
import { useContainers } from '@/hooks/queries/use-db-metadata';

// enabled 自动绑定到 session.status === 'connected'
const { data: containers } = useContainers(profileId, parentContainer);
```

### 5.3 表数据浏览

```ts
import { useTableData } from '@/hooks/queries/use-db-metadata';

const { data } = useTableData(profileId, tableContainer, { page: 1, pageSize: 50 });
// data.columns: ColumnMeta[]
// data.rows:    unknown[][]
// data.hasNextPage: boolean
```

表数据浏览必须通过 table/view/materialized_view 的 `ContainerRef` 交给后端生成安全限定查询，前端不要拼接默认 `SELECT *`，也不要把 `asset_group` 传给 `browse_table_data`。

### 5.4 Redis key-value 浏览

```ts
import { useKeyTree, useKeyValue } from '@/hooks/queries/use-db-metadata';

const tree = useKeyTree(profileId, {
    dbIndex: 0,
    pattern: 'user:*',
    count: 100,
});

const detail = useKeyValue(profileId, { dbIndex: 0, key: 'user:1' });
```

Redis 不复用 SQL editor 或表格浏览假象；应打开 `key_value` tab，并由专门内容面板渲染 string/json/hash/list/set/zset/stream。

所有错误通过 `apiInvoke` 拦截，按 `IAppError.code` 自动弹出 `toast.error`，无需在组件内单独处理通用错误。runtime health 事件只依据后端显式 `runtimeImpact` 发布；不要在组件、hook 或 driver registry 中用错误码猜测连接健康。恢复 probe 和 disconnect 应使用 `trackRuntimeHealth: false` 避免事件反馈回路。

### 5.5 Schema Designer Surface

新驱动需要结构设计入口时，不要在 Explorer 或公共 Content shell 中按 driver name 打开固定 tab。应在 `schema-designer-surface-registry.ts` 注册 `driver/object kind/create|edit/capability -> tab type + open request`：

- 复用关系型 Table Designer 时，registration 使用 `supportsSchemaMutation()` 检查 create/alter；
- 需要原生 UI 时，可以注册独立 tab type、payload、content renderer 与 lifecycle/de-dup；
- 只读 Describe surface 可以依据 `schemaBrowser` 开放，但不得因此显示 create/save/drop；
- view 自己发布 refresh/preview/save 等 toolbar model；公共 `ContentToolbar` 不识别 driver；
- 加载、受限、只读、错误以及 previewing/previewReady/applying/outcomeUnknown 等低干扰状态放进通用 `schemaDesignByTabId`，由 status contributor 发布，不把状态散落到 Explorer 或公共 shell；driver-specific draft 可以使用独立 tab-id keyed state。

ClickHouse Phase 5E 使用两个 native surface 作为参考：`clickhouse_table_design` 的 table/edit 依据 `schemaBrowser` 解析为五 section，Columns/Engine/TTL、column action、Projection 与 Index section 分别按精确 capability 启用；`clickhouse_view_design` 以 view/materialized_view 静态 capability 和七 family runtime support 双重 gate Create/Alter/Rename/Drop。Temporary View dependent tab 绑定 owner SQL runtime，不拥有第二个后端 runtime。公共 Explorer/Content/Toolbar/Status shell 不回退关系型设计器，也不增加 ClickHouse driver-name 分支；Explorer Projection/Index 叶子仍只读，persistent View/MV 通过自己的 contributor 暴露管理动作。具体当前边界见 [clickhouse-table-designer.md](./clickhouse-table-designer.md) 与 [clickhouse-view-designer.md](./clickhouse-view-designer.md)。

---

## 6. 后续开发与扩展（按需）

完成上述基础集成后，根据驱动的实现深度还需要：

1. **前端功能面板**：在 `src/features/workbench/` 下扩展驱动特定的内容面板，例如图拓扑视图（对应 `TabType = "graph_topology"`）。
2. **QueryKey 扩展**：如有驱动专属的数据类型（如图的节点/边），在 `src/lib/query-keys.ts` 中追加新的 key 类别。
3. **SQLite 迁移脚本**：如需修改 SQLite 表结构，在 `src-tauri/migrations/` 中新增迁移文件（注意：`payload` 列设计天然支持扩展，通常无需 `ALTER TABLE`）。

如果新增或启用内容 tab，还必须同步：

1. 在 `content-tab-registry.tsx` 注册面板渲染、图标和标题。
2. 在 `content-tab-lifecycle-registry.ts` 注册打开请求、稳定 id、payload 和 de-dup 规则。
3. 如果属于 schema design，注册 `schema-designer-surface-registry.ts` 的匹配与 open request。
4. 由内容视图发布 `ContentToolbarModel`，不要在 `ContentToolbar` 中按 `TabType` 写动作分支。
5. 增加 registry 回归测试，并按 [workbench-registry-constraints.md](./workbench-registry-constraints.md) 跑结构检查。

---

## 命名规范速查

| 层级 | 旧命名（已废弃）| 新命名 |
|------|----------------|--------|
| TS 驱动标识类型 | `ConnectionDriver` | `DbDriver`（`ConnectionDriver` 保留为别名） |
| TS 连接配置核心类型 | `StoredDatabaseConnection` | `IStoredConnectionProfile`（`StoredDatabaseConnection` 保留为别名） |
| TS Payload 接口命名 | `RedisConnectionConfig` | `IRedisPayload`（继承 `INetworkConfig` 等物理模型） |
| SQLite 连接差异字段 | `config_json` | `payload`（JSON 文本列） |
| Rust 驱动枚举 | — | `ConnectionDriver`（与 TS 一致，均为小写序列化） |
