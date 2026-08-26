# AI Runtime Tool Namespace 与 Tool Core 设计

> 状态：V1 目标设计与 L1-L8 纵向链路已实现，包含 `web.fetch`、`web.ping`、`system.current_time`、十四个 Backend Tool、Backend Bridge/Gateway、共享 Workbench Application Service 和 Runtime Projection。
>
> 日期：2026-07-30。
>
> 本文是 Tool Namespace、Tool Definition、Per-Run Tool Snapshot 和 Runtime Tool Core 的权威设计。Backend WebSocket Bridge 与 Runtime Permission 分别见 [backend-bridge.md](./backend-bridge.md) 和 [tool-permission.md](./tool-permission.md)。
>
> 高风险原始 SQL 与 Key/Value mutation 的长期安全规则见 [Database tool safety model](./database-tools.md)。

## 1. 目标与产品前提

V1 要解决两个核心问题：

1. 按数据库能力和稳定领域语义组织模型工具，避免工具随数据库 Driver 数量膨胀。
2. 让每个 Runtime Run 获得独立、不可变的工具可见性与执行上限，并由 AI Runtime Core 统一完成校验、授权、限制、持久化和执行分流。

设计基于以下产品前提：

- Rust/Tauri 与 AI Runtime 同仓开发、配套发布、同时升级；
- V1 不支持新旧 Rust/AI Runtime 混合版本；
- 不开放用户、Driver、Plugin 或远端服务动态注册 AI Tool/Namespace；
- 当前批次只实现专用、低风险工具；远端数据库业务数据保持只读，但允许 `connection.open` 这类必要的本地可逆状态操作；
- 当前阶段允许破坏性更新尚未稳定的 Tool、Permission 和 AI SDK adapter 模型；
- V1 优先得到简单、可靠的闭环，不提前建设开放式工具平台。

因此 V1 不引入 Namespace/Tool/Gateway/Protocol version、definition hash、manifest hash、跨版本协商、热加载或通用 Action Dispatcher。

## 2. 核心原则：按能力划分，不按 Driver 划分

AI Tool 不按数据库品牌组织：

~~~text
mysql.list
mysql.sql
postgresql.list
redis.list
clickhouse.query
~~~

Namespace 与 Tool 应围绕稳定能力和用户意图组织：

~~~text
connection.list
connection.get
metadata.list_children
metadata.describe_table
table.query
key_value.scan
key_value.get
key_value.create
key_value.set
key_value.rename
key_value.set_ttl
key_value.delete
sql.execute
schema.preview_change
graph.query
vector.search
~~~

新增数据库 Driver 时，应优先实现已有领域 capability，使其复用既有工具，而不是复制一套 `driver.*` 工具。

### 2.1 与 Rust Driver 能力制的关系

当前 Rust 后端已经采用以下结构：

~~~text
ConnectionRuntimeManager
  -> Arc<dyn DatabaseDriver>
  -> DriverCapabilities
  -> capability traits
  -> concrete driver implementation
~~~

AI 工具层沿用这一哲学，但 Namespace 不要求与 Rust trait 机械同名或一一对应：

| Rust 能力或领域 | AI Tool Namespace | 语义 |
|---|---|---|
| ConnectionRepository / ConnectionRuntimeManager | `connection.*` | 本地 profile 脱敏读取和连接 runtime 生命周期 |
| `SchemaBrowser` | `metadata.*` | 远端对象发现和只读描述 |
| `DataTableBrowser` / 行数据能力 | `table.*` | 表、视图和物化视图的结构化行数据读取与受控 mutation |
| `SqlExecutor` / `ManagedSqlExecutor` | `sql.*` | 原始 SQL 分析、执行、动态风险和审批 |
| `SchemaMutator` / `NativeSchemaExtension` | `schema.*` | 结构 proposal、preview 和 mutation |
| `KeyValueBrowser` | `key_value.*` | Key/Value 范式能力 |
| `GraphQueryer` | `graph.*` | 图查询能力 |
| `VectorSearcher` | `vector.*` | 向量检索能力 |

三层语义必须分开：

~~~text
Namespace
  决定能力属于哪个稳定模型领域，以及本 Run 贡献哪些工具

Tool capability descriptor
  声明工具需要什么领域能力

Rust Driver/Capability
  决定目标 profile/runtime 是否真实具备并能够执行该能力
~~~

`Capability` 回答“能不能做”，`Risk/Permission` 回答“允不允许做”。Domain capability 是强类型标签和选择依据，不直接充当权限。

### 2.2 Built-in Namespace 的边界与独立理由

Namespace 不是源码目录、Rust trait 或数据库 Driver 的镜像。它是模型可以理解、Agent 可以授权、Core 可以稳定治理的**产品语义边界**。只有当一组 Tool 在用户意图、资源模型、Risk/Permission 或执行依赖上存在稳定差异时，才值得拥有独立 Namespace。

当前已经注册七个 built-in Namespace。`schema` 只记录已确认的未来边界，在真实 Tool 落地前不注册空 Namespace：

| Namespace | 状态 | 负责 | 明确不负责 | 保持独立的理由 |
|---|---|---|---|---|
| `system` | 已实现 | AI Runtime 进程可直接取得的系统事实和无外部业务资源的本地工具，例如当前时间 | 公网访问、连接配置、数据库内容 | `executionTarget=runtime`，不依赖 Backend Bridge 或用户数据库；即使 Backend 不可用也可工作 |
| `web` | 已实现 | 在 Runtime-owned 网络范围内读取 HTTP(S) 资源、返回来源，以及执行受限网络诊断 | NexusPilot 内部 API、数据库连接、后端 Gateway 操作、端口/子网扫描、任意 shell 命令 | 具有独立的 `external_network` side effect、范围/SSRF/响应大小治理和 Source/诊断语义，不能与普通本地工具混为一类 |
| `connection` | 已实现 | stored profile 的脱敏发现、详情读取，以及共享数据库 runtime 的生命周期 | 远端 schema、表数据、Redis value、任意 SQL | 操作对象是 NexusPilot 本地 profile/runtime；`connection.open` 改变共享 Workbench 状态但不读取或修改远端业务数据，生命周期与权限语义独立 |
| `metadata` | 已实现 | 跨 Driver 的数据库对象树发现和可无损表达的结构描述 | 表行、文档正文、Redis value、原始查询语言、结构 mutation | 结构事实可在不读取业务记录的情况下授权；结果形态是 `ContainerRef/DataContainer/TableSchema`，与数据内容的敏感性、体积和能力依赖不同 |
| `table` | 已实现 `table.query` | 表、视图和物化视图等 table-like source 的结构化行读取；未来可容纳结构化行 mutation | 原始 SQL、DDL、Key/Value、图和向量查询 | 输入是可信 `ContainerRef` 加受控列/过滤/排序/分页，Backend Driver 生成查询；它复用 `DataTableBrowser`，与原始 SQL 的动态 Risk/Permission 路径有本质差异 |
| `key_value` | 已实现 `key_value.scan/get/create/set/rename/set_ttl/delete` | Key scan、typed value 读取和受控单 Key create/value/identity/TTL/delete mutation | 把 Key/Value 强行伪装成 table row，或接收 Redis 命令字符串、Lua、prefix/batch delete | Key、prefix、TTL、Redis 数据类型、CAS 指纹和分页游标构成独立资源模型；复用 `KeyValueBrowser`，输入输出无法被 `table.*` 无损表达 |
| `sql` | 已实现 `sql.execute` | 原始 SQL 文本的 framing、动态 Risk、Permission、prepared plan 和受控执行 | 代替结构化 `table.query`，或绕过 schema/data mutation 专用工具 | 只对 Agent mode 可见；模型生成 Driver 方言 SQL，Rust 通用分析器保守分类，无法精确分析但边界可靠时进入 critical 强确认 |
| `schema` | 延期，真实 Tool 落地时注册 | 数据库对象定义的 proposal、preview、drift protection 和 mutation | 行数据修改或任意 SQL 透传 | DDL 以对象 baseline、preview、确认和远端漂移保护为核心，风险和结果语义不同于行数据与原始 SQL |

`table.query` 与全部 `key_value.*` Tool 使用 `ConnectionRuntimeManager` 的 shared profile runtime，不创建 AI Runtime 专用连接池，也不进入某个前端 Tab runtime。Key/Value mutation 与 Workbench UI 共用同一 `KeyValueBrowser` 原子实现。`sql.execute` 对 legacy SQL Driver 复用 shared `SqlExecutor`；ClickHouse 则在同一 shared runtime 上直接复用既有 `ManagedSqlExecutor`、query id、timeout/cancel/query-wins 语义，但不为 Agent 创建前端 Tab runtime 或第三套连接/执行状态机。

2026-07-30 已确认继续保留 `table` 与 `sql` 两个独立 Namespace。`table.query` 的结构化 `ContainerRef + columns/filters/sort/page` 输入、静态低风险和 shared runtime 语义不会因后续增加 `sql.execute` 而迁移到 `sql`；原始 SQL 的动态分析、审批和隔离执行也不会反向塞入 `table`。

以下相似名称不代表职责可以合并：

- `metadata.describe_table` 回答“表的结构是什么”，`table.query` 回答“表中有哪些行”；结构可见不自动授权业务数据可见；
- `table.query` 只接受语义化参数并由 Driver 生成查询，`sql.execute` 接受原始语言文本并需要动态 Risk/Permission；
- `connection.open` 改变本地共享 runtime，`table.query` 读取远端业务数据；二者的 side effect、失败语义和资源对象不同；
- `table.*` 与 `key_value.*` 都读取数据，但 table row 与 key/type/TTL/cursor 不是同一种资源模型，强行统一会产生不断膨胀的联合 DTO。

### 2.3 Namespace 拆分与合并判据

新增 Namespace 至少应满足以下条件之一：

1. 存在稳定且不同的用户意图或资源模型，无法由现有 Namespace 的 Tool 名准确表达；
2. 需要不同的 Agent 可见性、Risk/Permission 路径或 side effect 上限；
3. 具有不同的执行目标、生命周期或安全治理，例如 Runtime-local、External Network、Shared Runtime、隔离 SQL execution；
4. 输入输出契约无法在不引入大规模 tagged union、无关空字段或 Driver 分支的情况下归入现有 Namespace。

以下理由**不足以**单独创建 Namespace：

- Rust 新增了一个 trait、module 或 handler；
- 新增了一个数据库 Driver 或品牌；
- Tool 数量变多；
- DTO 文件需要单独维护；
- 仅为了代码目录整齐或名称更短。

当两个 Namespace 的 Agent 可见性、Risk/Permission、资源模型、执行生命周期和输入输出长期一致，拆分只剩源码组织差异时，应合并 Namespace。合并允许在当前未稳定阶段破坏性调整 canonical Tool ID，但必须同步 Registry、Snapshot migration、Prompt、测试和权威文档，不保留无业务价值的兼容双轨。

当前保留 `connection / metadata / table / key_value / sql / schema` 的理由分别落在生命周期、结构事实、表行数据、Key/Value 范式、原始语言风险和对象 mutation；如果后续真实 Tool 证明其中某个边界没有独立策略或资源语义，应重新评估合并，而不是为了维护既有名称继续扩张抽象。

### 2.4 防止理念漂移的约束

- AI Runtime Core、Runner 和公共 Tool Resolver 不得出现按数据库品牌分发工具的 `if mysql / if redis / if clickhouse`；
- Driver 差异由 Rust `DatabaseDriver`、`DriverCapabilities` 和 capability trait 承担；
- Namespace 可以消费能力事实，但不能按 Driver 品牌复制通用工具；
- 只有现有 `metadata/table/key_value/sql/schema` 无法准确表达的新范式，且满足上述拆分判据时，才新增 `graph/vector` 等能力 Namespace；
- Driver 特有长尾 Action 不进入 V1；未来若引入，也必须基于可信 Action Registry，而不是任意命令字符串。

## 3. 总体结构与职责

~~~text
Run
  -> Agent Definition / Core ceiling
  -> Namespace.resolveForRun
  -> Core 编译并冻结 Run Tool Snapshot
  -> AI SDK model/tool call
  -> Runtime Tool Core dispatcher
       -> Runtime-local executor
       or
       -> Backend Bridge
          -> same-name Rust Gateway operation
          -> Repository / ConnectionRuntimeManager
          -> Driver capability trait
~~~

| 组件 | V1 职责 |
|---|---|
| Namespace | 维护领域工具目录，按 Run/Agent/静态依赖贡献候选工具 |
| Tool Definition | 定义输入输出契约、Risk、执行目标、领域 Capability、Metadata 和执行函数 |
| Agent Definition | 声明 Namespace 候选范围、少量 Tool 例外和执行上限，不复制完整工具定义 |
| Per-Run Tool Snapshot | 冻结本 Run 的工具可见性、Provider 名称映射和执行上限 |
| AI Runtime Tool Core | 输入输出校验、Risk/Permission、limits、ToolCall 持久化、异常归一化和执行分流 |
| Backend Bridge / Rust Gateway | 提供受控后端执行通道，不拥有 Tool policy |
| Rust Driver | 提供目标 profile/resource 的真实 capability、状态校验和具体执行 |

## 4. Namespace 模型

### 4.1 最小契约

~~~ts
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface RuntimeToolNamespace {
  id: string;
  title: string;
  description: string;
  metadata?: Record<string, JsonValue>;
  tools: RuntimeToolDefinition[];

  resolveForRun(
    context: ToolRunContext,
  ): ResolvedNamespaceContribution;
}
~~~

字段用途：

- `id`：稳定领域标识，例如 `connection`、`metadata`；
- `title` / `description`：开发诊断和未来 UI 展示，不作为身份；
- `metadata`：标签、分类和说明等不影响执行语义的元数据；
- `tools`：该 Namespace 静态拥有的不可变 Tool Definition；
- `resolveForRun`：根据本 Run 和 Agent 上下文贡献候选工具，不修改全局 Registry。

### 4.2 `resolveForRun`

`resolveForRun` 必须保留。它把领域相关的工具选择逻辑放在 Namespace 内，避免所有策略聚集到 Core 的单个全局文件。

V1 使用同步、纯内存的最小上下文：

~~~ts
interface ToolRunContext {
  runId: RunId;
  agent: {
    id: string;
    mode: AgentMode;
  };
  backendBridge: {
    state: "waiting" | "ready" | "disconnected";
  };
}

interface ResolvedNamespaceContribution {
  candidateToolIds: string[];
  unavailableTools?: Array<{
    toolId: string;
    reason: string;
  }>;
  metadata?: Record<string, JsonValue>;
}
~~~

规则：

- Namespace 只能选择自己已静态注册的 Tool；
- Namespace 可以减少候选集合，不能放宽 Agent/Core hard deny；
- Provider tool calling 能力、Agent execution ceiling 和 Core guardrail 仍由 Core 判断；
- `resolveForRun` 不访问 SQLite、Backend Gateway 或数据库，不查询某个具体连接和 Driver capability；
- 只有模型输入后才能确定的 profile/resource/capability，在 `execute` 与 Rust Handler 中按当前事实校验；
- Workbench 选中节点等上下文只在真实 Tool 需要时增加，不预留空字段。

### 4.3 注册生命周期

V1 只允许 built-in Namespace：

1. AI Runtime 启动时注册 built-in Namespace 和 Tool Definition；
2. Registry 校验 Namespace ID、canonical Tool ID、Schema 和 Provider 物理名称冲突；
3. 任一重复或无效定义直接导致启动失败；
4. 校验完成后 Registry 冻结，运行期间不可增删改；
5. 每个 Run 只通过 `resolveForRun` 从冻结 Registry 解析自己的 contribution。

“按 Run 动态选择工具”不等于“动态注册工具”。V1 明确不支持 Driver、Plugin、MCP、用户或 WebSocket 在运行时注册、替换、卸载 Tool/Namespace，也不支持热加载。

L2 已在 `ai-runtime/src/runtime/tools/kernel/` 实现 `RuntimeToolNamespace`、`RuntimeToolRegistry` 和中心化 Provider Name Codec。Registry 构造接收完整 built-in Namespace 集合，在构造期间完成全部校验和防冲突检查，成功后冻结 Namespace 列表、Tool 列表、Definition 及其 Registry-owned metadata/risk/limits/capability 数组；对外不提供 register、replace 或 remove API。

L5-A 已删除验证期 `ToolRegistry`、旧 AI SDK adapter 和对应测试，不提供兼容转换层。正式 `web.fetch` 与 `web.ping` 只通过 immutable `RuntimeToolRegistry`、Run Snapshot、AI SDK adapter 与 Runtime Tool Core 执行。

## 5. Tool Definition

### 5.1 最小契约

~~~ts
type ToolExecutionTarget = "runtime" | "backend";

type DomainCapabilityId = "schema_browser";

interface ToolRiskDefinition {
  mode: "static" | "dynamic";
  level: "low" | "medium" | "high" | "critical";
  reversible: true | false | "conditional";
  sideEffect:
    | "none"
    | "external_network"
    | "runtime_state"
    | "workbench_state"
    | "business_read"
    | "business_write"
    | "destructive";
}

interface ResolvedToolRisk {
  level: ToolRiskDefinition["level"];
  reversible: boolean;
  sideEffects: ToolRiskDefinition["sideEffect"][];
}

interface ToolExecutionOutput<TData> {
  summary: string;
  data: TData;
  warnings?: string[];
}

interface ToolExecutionLimits {
  timeoutMs?: number;
  maxResultBytes?: number;
}

interface RuntimeToolDefinitionBase<TInput = unknown, TOutput = unknown> {
  id: string;
  title: string;
  description: string;
  metadata?: Record<string, JsonValue>;
  inputSchema: unknown;
  outputSchema: unknown;
  requiredCapabilities?: DomainCapabilityId[];
  risk: ToolRiskDefinition;
  limits?: ToolExecutionLimits;

  resolveRisk?(
    input: TInput,
    context: ToolRiskResolutionContext,
  ): Promise<ResolvedToolRisk>;

}

interface BackendToolExecutionContext<TOutput>
  extends ToolExecutionContext {
  proceed(): Promise<Readonly<ToolExecutionOutput<TOutput>>>;
}

type RuntimeToolDefinition<TInput, TOutput> =
  RuntimeToolDefinitionBase<TInput, TOutput> &
    (
      | {
          executionTarget: "runtime";
          execute(
            input: TInput,
            context: ToolExecutionContext,
          ): Promise<ToolExecutionOutput<TOutput>>;
        }
      | {
          executionTarget: "backend";
          execute(
            input: TInput,
            context: BackendToolExecutionContext<TOutput>,
          ): Promise<ToolExecutionOutput<TOutput>>;
        }
    );
~~~

L1-B 已在 `ai-runtime/src/runtime/tools/contracts/` 落地这些 Runtime-owned 基础契约。当前 Runtime 统一使用 Zod schema 作为 `inputSchema` / `outputSchema` 的运行时表示；这是 Runtime 自己的校验契约，不以 AI SDK Tool 类型作为事实来源。AI SDK adapter 后续只消费该 Schema 和 Tool Definition。

静态与动态 Tool Definition 在 TypeScript 中使用判别联合表达：静态 Risk 禁止声明 `resolveRisk`，动态 Risk 必须声明 `resolveRisk`。该类型约束只建立定义边界；动态 Risk 的运行时最低基线校验属于 L2/L4。

`metadata` 只能保存标题、标签、分类、文档/诊断标识和 UI 提示。Capability、Risk、Schema、execution target 和 limits 必须是强类型字段，不能隐藏在任意 Metadata 中。

### 5.2 Execution Target 与 Domain Capability

两者属于不同层级：

~~~text
executionTarget
  工具在哪里执行：AI Runtime 本地或 Rust Backend

requiredCapabilities
  目标数据库领域是否具备工具所需能力
~~~

- `executionTarget: "runtime"` 由 AI Runtime 内部 executor 执行；
- `executionTarget: "backend"` 通过 Backend Bridge 执行，不需要把 Bridge 伪装成 Domain Capability；
- `requiredCapabilities` 是强类型领域标签，不决定 Agent 权限、用户 Permission 或 Risk；
- `connection.list/get` 使用 Backend Repository，不需要 Driver capability；`metadata.*`、`table.query` 与 `key_value.*` 分别声明 `schema_browser`、`data_table_browser` 与 `key_value_browser`；
- 第一批 `metadata.list_children/describe_table` 声明 `schema_browser`；
- `schema_browser` 对应 Rust `DriverCapabilities.schema_browser`、`DatabaseDriver.as_schema_browser()` 和 `SchemaBrowser` trait；
- 实际执行时能否取得 trait 并完成操作，才是最终 capability 事实。

### 5.3 Risk 与执行前置条件

必须区分：

~~~text
Core authorization
  Agent 是否可用该工具
  是否满足 Core guardrail 与 Run execution ceiling
  是否需要并取得用户 Permission

execute precondition
  Bridge 是否可用
  profile/resource 是否仍存在
  当前 Driver 是否仍具备 required capability
~~~

Core 授权表示“允许尝试执行”，不保证外部资源仍然有效。前置条件失败应返回 `RESOURCE_NOT_FOUND`、`BACKEND_BRIDGE_UNAVAILABLE` 或 `CAPABILITY_UNAVAILABLE` 等 Tool Error，不创建 Runtime Permission。

第一批专用、只读工具全部使用静态低风险，不要求提供空壳 `evaluateInvocation`。工具可以在 `execute` 开头检查当前状态，Rust Handler 仍须再次校验可信资源和 capability。

### 5.4 Backend Tool `execute/proceed` 切面

Backend Tool 仍然定义 `execute`，但不直接持有 Bridge。Core 向当前 ToolCall 注入一个受控 `proceed()`；它已经绑定当前 canonical Tool ID、规范化 input、abort signal 和唯一 Backend executor：

~~~ts
execute: async (_input, context) => context.proceed()
~~~

`defineBackendTool()` 在作者未声明 `execute` 时提供上述默认实现。确有 Runtime-local 语义检查的 Tool 可以在 `proceed()` 前后检查，但不得重复 Core 或 Rust 的职责：

~~~ts
execute: async (input, context) => {
  // 可选：只依赖本次 input 的轻量业务前置检查
  const output = await context.proceed();
  // 可选：针对已校验、已冻结 output 的业务后置断言
  return output;
}
~~~

Core 强制以下约束：

- `proceed()` 只能调用一次，并且系统不自动重试；
- Backend `execute` 必须调用 `proceed()`，并原样返回同一个冻结结果，不能绕过、替换或修改 Backend 结果；
- Backend 输出在 `proceed()` 内只执行一次 envelope/`outputSchema` 校验，后置检查读取的是已校验、已冻结值；
- input Schema、Snapshot/Risk/Permission/limits 仍只由 Core 负责；
- profile、连接状态、resource、Driver capability 和数据库执行事实仍只由 Rust Gateway/共享 Service/Driver 负责；
- AI Runtime 不复制 Rust 数据库状态来完成所谓“提前检查”。只有无需额外后端往返、且不重复上述职责的轻量语义检查才适合放在 Tool `execute`。

L8 的 `connection.list/get`、`metadata.list_children/describe_table`、`table.query` 与 `key_value.scan/get` 均使用默认 `proceed()`；当前没有为形式完整而添加重复检查。

Registry 强制以下定义约束：

- `risk.mode: "static"` 不提供 `resolveRisk`，`reversible` 必须是布尔值；
- `risk.mode: "dynamic"` 必须提供 `resolveRisk`，静态 Risk 是不可降低的最低基线；
- `resolveRisk` 只返回可信风险事实，不返回最终 `allow | ask | deny`；
- `resolveRisk` 不执行真实查询、写入、mutation 或其他业务副作用；
- 无法可靠解析 Risk 时 fail closed，不进入 `execute`；
- resolved risk 不能降低静态 level 或移除静态 side effect。

`sql.execute`、Redis 单 Key mutation，以及未来 schema/table mutation 等输入决定读写风险的 Tool 必须使用动态 Risk。例如：

~~~text
sql.execute.resolveRisk
  -> Backend Gateway sql.analyze（只读专用 operation）
  -> Driver 按方言分类 statement
  -> ResolvedToolRisk

Runtime Core
  -> 合成 Run execution ceiling、resolved risk 和 Permission

sql.execute.execute
  -> Backend Gateway sql.execute
~~~

`sql.analyze` 与 `sql.execute` 是两个已实现的稳定 operation，不在一个 operation 中加入 `phase=analyze/execute`。模型只看到 `sql.execute`；Core 独占 prepare 调用并绑定 Permission/plan/outcome。结构化只读查询仍优先通过不接收 SQL 文本的 `table.query` 落地。

### 5.5 高风险 Tool 目标约束

本节记录已经实现的 SQL 与 Redis 单 Key mutation 边界。通用 prepared plan、可信 Bridge execution context、Rust single-consume 注册表、`sql.execute` 三态 Handler 和五个 Key/Value mutation Tool 均已进入生产 Registry。

Runtime policy 默认值为：

| Resolved risk | Policy | Confirmation |
|---|---|---|
| `low` | `allow` | 无 |
| `medium` | `ask` | standard |
| `high` | `ask` | standard |
| `critical` | `ask` | strong |
| 超出 Snapshot ceiling 或 Core hard deny | `deny` | 用户批准也不能越过 |

Phase 8 已把自动审批最高风险开放为 Runtime-owned `none / low / medium` 设置，并在创建新 Run 时冻结到 Tool Snapshot。`none` 对 low 也使用 `ask`；`low` 保持上表默认；`medium` 允许 low/medium 自动执行。high/critical 不是合法阈值，始终 `ask`，且 critical 始终 strong confirmation。历史 Snapshot 缺少该字段时按 `low` 解释。设置更新不修改已冻结 Snapshot 或 pending Permission，详见 [settings.md](./settings.md)。

原始 SQL 动态分析使用三态：

- `analyzed`：Driver/分析器能够可靠返回 statement class、risk 和 reasons；
- `uncertain`：可以确认 profile/context、完整 SQL 和单语句边界，但不能精确判断业务影响；必须解析为 `critical`、`reversible=false`，并同时声明 `business_read/business_write/destructive`；
- `rejected`：无法建立可靠单语句边界、输入超限、目标或 capability 无效，或命中 hard guardrail；不创建 Permission，不允许强确认放行。

`sql.execute` 的模型 input 不包含分析结果、risk、Permission、`planId` 或 hash。Core 先通过只读内部 `sql.analyze` operation 取得风险与一次性 prepared plan，再决定 `allow/ask/deny`；批准后执行同一个 ToolCall 对应的 plan。Rust 执行批准 SQL 时保持 SQL body 原样，只消费结构化 profile/database/schema context，不隐藏改写或注入方言命令。

ClickHouse 执行额外要求 `managedLifecycle=true + statementAccess=direct`。它固定使用 bounded Grid、30 秒 backend timeout 和 35 秒 Tool Core envelope；命令响应包含可空 `completionMessage`，异步 mutation 提交成功返回 `mutationState=submitted`，不把 server-side mutation 描述为已经完成。Oracle 与 ClickHouse 外部真实库 smoke 仍分别受 `early eof` 与 `SendRequest` timeout 阻断。

第一版不增加通用 `inputHash` / `planHash`。Runtime Permission 继续绑定不可变 ToolCall identity 与规范化 input；可信后端内部 plan 通过 `planId + toolCallId + profile/context + exact payload + expiresAt + single-consume state` 建立 mutation binding。Redis prepare 从 `DUMP` bytes 计算 `sha256:` value fingerprint，并把它写入 set/rename/TTL/delete 的内部 exact payload；fingerprint 不含 TTL，也不进入模型、Frontend 或公共 Permission 输入。

`key_value.create/set/rename/set_ttl/delete` 只对 Agent mode 可见。create/set/rename 与 persist TTL 的 resolved risk 为 `high`，使用 standard confirmation；expire TTL 与 exact delete 为 `critical + destructive`，使用 strong confirmation。审批展示完整 Key、rename destination、value type 与 TTL，不展示 value。Driver 使用带保护 TTL 的临时键构建完整值，并以 `WATCH + MULTI/EXEC` 完成 CAS 原子切换；create/rename 同时保护 destination absent。`key_value.delete_prefix`、raw Redis command、Lua/EVAL、管理命令和跨 Key transaction orchestration 不进入首批。

## 6. Agent Policy 与 Per-Run 解析

Agent Definition 使用稀疏策略，不复制 Tool Definition：

~~~ts
interface AgentToolPolicy {
  allowedNamespaces: string[];
  allowedTools?: string[];
  deniedTools?: string[];
  executionCeiling: {
    maxRiskLevel: ToolRiskDefinition["level"];
    allowedSideEffects: ToolRiskDefinition["sideEffect"][];
    allowIrreversible: boolean;
  };
}
~~~

- `allowedNamespaces` 是通常使用的领域级候选范围；
- `allowedTools` 只供需要严格白名单的 Agent 使用，缺省时不要求同步维护 Namespace 内完整工具清单；
- `deniedTools` 表达少量例外拒绝，且永远优先；
- `executionCeiling` 是本 Agent 能够尝试执行的最高 Risk/side effect 上限。

当前内置模式采用三层职责：

| Agent Mode | Namespace 候选范围 | execution ceiling | 数据库语义 |
|---|---|---|---|
| `ask` | `system`、`web` | `low`；仅 `none`、`external_network`；不可逆=false | 不读取连接、元数据或数据库内容，也不打开连接 |
| `query` | `system`、`web`、`connection`、`metadata`、`table`、`key_value` | `medium`；允许 `none`、`external_network`、`runtime_state`、`workbench_state`、`business_read`；不可逆=false | 允许结构化只读数据库工具及只读任务所需的可逆连接状态操作；禁止原始 SQL、业务写入、破坏性和不可逆操作 |
| `agent` | 当前全部 built-in Namespace | `critical`；允许完整 side effect；不可逆=true | 完整数据库工具可以进入候选范围，但高风险调用仍须经过 Core 与 Permission |

这里的 Query “只读”约束针对远端数据库业务效果，不等于所有操作都必须是纯函数。打开连接会改变共享连接运行时状态，但它是完成只读数据库任务所需的可逆操作，因此可落在 `runtime_state` / `workbench_state` 内。相反，INSERT、UPDATE、DELETE、DDL 和其他远端 mutation 不得因位于 `connection` 或 `query` Namespace 就进入 Query。

Agent 的完整 ceiling 也不是授权结果。工具进入 Snapshot 只说明它在该 Run 中对模型可见且没有超过静态上限；具体调用仍须由 Core 合成动态 Risk、limits 和 Runtime-owned Permission。

解析顺序：

~~~text
registered Tool
  -> Agent allowedNamespaces
  -> Namespace.resolveForRun
  -> optional allowedTools intersection
  -> deniedTools
  -> static capability/dependency availability
  -> static Risk execution ceiling
  -> Provider/Model tool support
  -> Runtime approval policy snapshot
  -> active Tool
~~~

已允许 Namespace 中的新 Tool 可以自动成为 candidate，但不会自动取得执行授权；它仍必须通过 capability、Risk ceiling、Core guardrail 和 ToolCall Permission。Namespace contribution 只能收窄，不能放宽 Agent/Core 上限。

L3 实现在 `ai-runtime/src/runtime/tools/resolution/`。内置 Agent Definition 已破坏性迁移为上述稀疏策略，不再保存验证期 `defaultEnabledTools`、permission level 或完整 Tool 清单。解析器按 Registry 顺序调用允许的 Namespace，拒绝其贡献未注册、跨 Namespace、重复或同时标记 candidate/unavailable 的 Tool。

当前静态 dependency availability 只包含已经存在的 Backend Bridge 状态；需要模型输入才能确定的 profile/resource/Driver capability 不在 Run 创建时臆测。模型不支持 Tool calling、Backend Bridge 未 ready、Agent 白名单/拒绝项或静态 Risk ceiling 不满足时，Tool 进入 Snapshot `unavailableTools`，不会进入 `activeTools`。

## 7. Per-Run Tool Snapshot

每个 Runtime Run 只生成一个不可变 Snapshot：

~~~ts
interface RunToolSnapshot {
  snapshotId: string;
  runId: string;
  createdAt: string;
  agentMode: AgentMode;
  executionCeiling: {
    maxRiskLevel: ToolRiskDefinition["level"];
    allowedSideEffects: ToolRiskDefinition["sideEffect"][];
    allowIrreversible: boolean;
  };
  approvalPolicy?: {
    autoApproveMaxRisk: "none" | "low" | "medium";
  };
  activeTools: Array<{
    canonicalId: string;
    providerName: string;
  }>;
  unavailableTools?: Array<{
    canonicalId: string;
    reason: string;
  }>;
}
~~~

Snapshot 冻结本 Run 的：

- Agent Mode；
- 模型可见的 active canonical Tool IDs；
- canonical/provider 物理名称映射；
- Run 级静态 execution ceiling；
- Run 创建时的 `none/low/medium` 自动审批阈值；
- 解析时相关 Bridge/静态 capability/dependency availability。

Core 只接受当前 Snapshot 中的 ToolCall；Run 执行途中不重新调用 `resolveForRun` 替换工具集合，也不读取另一个 Run 的 Agent policy。Ask、Query 与 Agent Run 并发时各自持有独立 Snapshot，用户切换 Agent Mode 只影响之后创建的新 Run。

Snapshot 同时冻结“可见性”和“执行权限上限”，但不预先批准具体 ToolCall。它不冻结 ToolCall 级用户 Permission，也不冻结 Bridge、连接、资源和 Driver capability 等外部可变状态。Bridge 恢复不会给旧 Run 自动增加工具；连接删除或 capability 变化仍会在执行前返回类型化错误。

审批 continuation 必须复用同一 Runtime Run 和同一 Snapshot，不新增 revision，也不重置累计 limits。

L3 已在生成 Run ID 后、写入 Run 前创建并冻结 Snapshot，随后把完整 Snapshot 持久化到 `Run.input.tools`。Snapshot、execution ceiling、active/unavailable 数组和条目均不可变；两个并发 Run 各自调用 `resolveForRun` 并持有独立对象。`0004_runtime_run_tool_snapshot` migration 会把验证期旧 Tool policy snapshot 收敛为空 active Tool 的正式 Snapshot，不把旧工具授权带入新模型。

L5-A 已把 Snapshot active Definition 转换成 AI SDK `tools/activeTools`。Provider 只看到物理名称，例如 `np__web__fetch`、`np__web__ping`；AI SDK Tool 的 `execute` 只调用 Runtime Tool Core，callback 只负责消息 part 投影，不能持久化或授权 ToolCall。

## 8. Canonical ID 与 Provider Name

Runtime 事实 identity 使用两段式 canonical ID：

~~~text
connection.list
metadata.list_children
table.query
sql.execute
~~~

Provider 物理名称由中心化 codec 确定性转换：

~~~text
connection.list         -> np__connection__list
metadata.list_children  -> np__metadata__list_children
~~~

V1 canonical ID 严格使用 `<namespace>.<tool>` 两段式 `lower_snake_case`。每一段必须以小写字母开头，只允许小写字母、数字和单下划线分词，不允许空段、额外 `.`、连续下划线、大小写或连字符。该约束使 `np__<namespace>__<tool>` 可以无歧义双向转换。

V1 不实现 codec version、自动截断或 hash suffix。Provider name 最长 64 个字符；超长 canonical ID 在 Registry 启动校验时直接失败。Registry 同时检查 canonical ID 和 Provider 物理名称冲突，冲突直接失败。

Store、ToolCall、Agent Policy、Permission、Event、Trace 和文档只使用 canonical ID。Codec 能解码某个物理名称不代表该 Tool 已注册或对 Run active；Provider 返回的物理名称必须通过当前 Run Snapshot 反解，未知或 inactive name fail closed。

## 9. Runtime Tool Core

ToolCall 统一经过 Core dispatcher：

~~~text
AI SDK tool call
  -> 反解并校验 Snapshot active tool identity
  -> inputSchema 校验和规范化
  -> 计算 static/dynamic resolved risk
       -> 可选 Backend prepare / prepared plan 校验
  -> 合成 Snapshot ceiling、Core guardrail 与 Runtime Permission
  -> 持久化 ToolCall/Permission/Event
  -> executionTarget 分流
  -> Tool execute
       -> Runtime-local executor
       or
       -> Core 注入的单次 proceed -> 同名 Backend operation
  -> outputSchema 单次校验
  -> 结果大小与错误归一化
  -> 持久化完成事实并返回 AI SDK adapter
~~~

Core 统一负责：

- 最大 ToolCall 数；
- 单次执行 timeout；
- 最大结果字节数；
- Run abort/interrupt signal；
- 输入和输出 Schema 校验；
- ToolCall、Permission、Event 与 Trace 持久化；
- authorization/prepare 与 execute 共用同一个 ToolCall 错误边界；
- 未知异常脱敏并映射为 `TOOL_EXECUTION_FAILED`；
- 禁止 inactive、未知或未授权 Tool 进入真实 executor。

系统不自动重试 Tool。凡是能够绑定到具体 ToolCall 的失败，都必须持久化为该 ToolCall 的结构化错误并作为非致命工具结果交回模型，不能升级为 Run failure。失败结果应包含足够信息，由模型判断是否发起一个新的 ToolCall；`outcome=unknown` 必须明确禁止自动重试。只有 Provider/模型 stream、Runtime Store 持久化、Runner 自身或其他无法归属 ToolCall 的系统故障保留 Run-fatal 语义。

### 9.1 L4 当前实现边界

L4 已落地：

- 通过当前冻结 Snapshot 反解 Provider name，并与 immutable Registry 的 canonical ID 交叉校验；
- `inputSchema` 规范化、静态/动态 resolved risk、动态风险最低基线和 Snapshot execution ceiling 的执行时复核；
- Core policy：根据 Run Snapshot 中冻结的 `none/low/medium` 阈值决定 low/medium 的 `allow/ask`；high/critical 始终 ask，critical 始终 strong confirmation；
- 每 Run 最大 ToolCall 数、单次 timeout、abort signal、最大结果字节数；
- Runtime-local executor 与注入式 Backend executor 分流，Backend operation 固定使用 canonical Tool ID；
- Backend Tool 通过 Core 注入的单次 `proceed()` 执行，必须返回同一个已校验、已冻结结果；
- `outputSchema`、成功 envelope、敏感字段脱敏、类型化异常和未知异常归一化；
- 审批前置错误返回 `RuntimeToolAuthorization.decision="error"`，并持久化 ToolCall error；AI SDK adapter 使用 automatic denied 作为非致命传输，但 Runner 继续投影 Runtime ToolCall 的权威错误，而不是“用户拒绝”；
- ToolCall、durable `tool.updated` Event 与不含输入/输出正文的 `tool.executed` Trace 持久化。

L4 Core 已在 `ask` 分支调用 Runtime-owned Permission 原子等待提交，但不负责同一 Run continuation 或前端审批交互。L5-A 已删除验证期 ToolCall `ToolResult` 过渡形状；Core API、Store ToolCall、executor 与 adapter 统一使用 L1-B 正式 `RuntimeToolResult`。L6 已补齐 Backend Bridge executor adapter：它只转发 canonical operation、input 与 abort signal，并把 Bridge/Gateway 错误事实无损交回 Core，不拥有权限、重试或 ToolCall 持久化。L8 在不新增权限层的前提下补齐 Backend Tool `execute/proceed()` 切面、七个只读 Tool 和可逆的 `connection.open`。

## 10. Result 与 Error Contract

Tool `execute` 返回成功输出或抛出类型化异常。Core 对外统一为：

~~~ts
interface RuntimeToolError {
  code: string;
  message: string;
  retryable: boolean;
  outcome: "not_started" | "no_effect" | "unknown";
  details?: Record<string, unknown>;
}

type RuntimeToolResult<TData> =
  | {
      ok: true;
      summary: string;
      data: TData;
      warnings?: string[];
    }
  | {
      ok: false;
      error: RuntimeToolError;
    };
~~~

V1 只统一外层 envelope；每个 Tool 保持自己的强类型 `data` 和 `outputSchema`。Core 必须在结果进入 Runtime Store、模型上下文或 UI projection 前校验输出并执行 secret redaction。

该错误 envelope 同时适用于执行阶段和审批前置阶段。AI SDK 在 Tool `execute` 内部抛错时原生生成 `tool-error`；Runtime Tool Core 正常情况下不依赖异常越过 adapter，而是返回/持久化结构化错误，因此模型会收到和 ToolCall 相同的 `code`、`message`、`retryable`、`outcome` 及安全 `details`。对于 AI SDK 没有原生 error status 的 `toolApproval` 阶段，adapter 使用 automatic denied 携带脱敏错误 reason，使 ToolLoop 继续；该传输形态不改变 Runtime `ToolCall.error` 的语义。

V1 不提前加入 result schema version、artifact refs、任意 metadata 或 mutation partial outcome。`retryable` 只表示模型未来可以考虑发起新 ToolCall，不授权系统自动重试。

### 10.1 Tool Description 与条件性失败引导

Tool description 是模型在每次可用 Tool 集合中都会看到的常驻上下文，应优先说明稳定的能力、输入使用方式、结果边界，以及模型在首次调用前必须知道的硬约束。不要把低频、仅在特定错误码出现时才有意义的修复步骤、设置导航或长篇对话策略长期堆入 description，以免稀释模型对当前任务和其它 Tool 的注意力。

这类条件性引导应随对应的结构化 Tool error 返回，放入安全、短小且稳定的 `error.details.guidance`。模型只有在实际收到该错误时才获得这些文字；`ToolCall.error` 和 AI SDK 工具结果必须保留同一 `details`，使恢复、审计和当前模型上下文一致。`guidance` 只能解释下一步用户交互与避免无效重试，不能授权模型自动修改 Runtime 设置、执行额外操作或绕过 Snapshot/Core policy。

## 11. 第一批真实工具

当前 Backend 业务工具注册四个 Namespace、七个专用只读 Tool 和一个可逆连接状态 Tool：

~~~text
connection.list
connection.get
connection.open
metadata.list_children
metadata.describe_table
table.query
key_value.scan
key_value.get
key_value.create
key_value.set
key_value.rename
key_value.set_ttl
key_value.delete
~~~

约束：

- `connection.list` 返回适合模型筛选的紧凑连接信息，除名称、Driver、环境和连接状态外，必须包含 host、port、username、默认数据库/schema、Redis DB index 或 SQLite 文件路径等可用于按地址识别连接的非敏感字段；
- `connection.get` 返回单个连接的完整非敏感技术配置、当前 runtime/health/capability，以及颜色、标签、文件夹、排序、创建时间、更新时间和最近连接状态等展示/存储元数据；
- `connection.open` 按 `profileId` 打开 Tauri managed 的共享数据库 runtime；若连接已打开则幂等复用并返回 `wasAlreadyOpen=true`，不得替换既有 Driver 或创建第二套连接池；
- `connection.open` 是 `risk.level=low`、`reversible=true`、`sideEffect=workbench_state` 的本地可逆状态操作。Ask 因 Namespace policy 不可见，Query 与 Agent 可以使用；它不修改远端数据库业务数据，也不因改变工作台连接状态而升级为业务写入；
- `connection.open` 成功后以 `origin=aiRuntime` 发布既有 `connection-runtime-changed` Workbench Domain Event；Frontend 仍以共享 `ConnectionRuntimeManager` Snapshot 为事实来源，事件丢失时通过现有只读 Snapshot IPC 对账；
- `connection.list/get` 都不得返回 password、token、API key、secret、private key、private key path、private key passphrase、完整 credential payload 或原始连接错误；
- Rust 必须使用正向字段投影构造 AI DTO，不得先序列化完整 `StoredConnectionRecord.payload` 再递归删除敏感字段；新增 Driver 配置字段必须先明确是否安全，才能进入 AI DTO；
- `metadata.*` 复用当前 `ContainerRef`、`DataContainer` 和 `SchemaBrowser` 能力；
- `metadata.*` 在执行时重新检查 profile、connection runtime 和 `schema_browser` capability；
- `metadata.list_children` 是逐层导航接口：省略 `parent` 时读取根节点，展开节点时必须把上一次响应中目标 `children[].container` 作为结构化对象原样传回；模型不得把对象编码为 JSON 字符串，也不得自行猜测或转换 `kind`。数据库、schema、asset group、table 等实际层级由 Driver 返回；
- `metadata.list_children` 使用 `offset + limit` 分页，默认 `offset=0`、`limit=100`、最大 `limit=200`，响应返回 `total` 和可选 `nextOffset`；V1 允许 Gateway 对完整 `Vec<DataContainer>` 进行切片，不承诺数据库查询级分页；
- `metadata.describe_table` 只表达可稳定映射为 `TableSchema` 的表结构读取能力；非关系型能力继续使用 `metadata.list_children`，并在需要时新增 `metadata.describe_collection`、`key_value.*`、`graph.*` 等专用能力工具，不恢复为包含不断膨胀联合 DTO 的通用 `describe_object`；
- ClickHouse 的对象树仍支持 `metadata.list_children`，但其 native Table Describe 不能无损压缩成关系型 `TableSchema`；V1 的 `metadata.describe_table` 对 ClickHouse 返回 `CAPABILITY_UNAVAILABLE`，后续另行适配专用能力，而不是返回丢字段的结果；
- `metadata.*` 不隐式打开连接；连接未打开返回 `CONNECTION_NOT_OPEN`，目标 Driver/对象不支持能力时返回 `CAPABILITY_UNAVAILABLE`；
- `table.query` 只接收 table/view/materialized view `ContainerRef`、列投影、固定枚举过滤、排序与分页；多个过滤条件使用 `AND`，不接收 SQL、表达式、函数、JOIN、聚合或任意查询语言片段；
- `table.query` 默认 `page=1`、`pageSize=50`，最大 `pageSize=100`；最多选择 50 列、10 个过滤条件与 5 个排序字段。过滤值通过 Driver 参数绑定，标识符必须匹配真实列并按方言安全引用；
- `table.query` 在 Query 与 Agent 可见，Ask 不可见；它声明 `risk.level=low`、`reversible=true`、`sideEffect=business_read` 和 `data_table_browser` capability；
- `table.query` 不隐式打开连接，通过 Workbench Application Service 以 `tabId=None` 复用 `ConnectionRuntimeManager` 的 shared profile runtime，不创建 AI 专用连接池或状态机；
- `key_value.scan` 只接收扁平的 `profileId/dbIndex/pattern/cursor/count`，不接收 Redis command；首次游标为字符串 `"0"`，后续必须原样使用响应的 `nextCursor`。`count` 默认 100、最大 500，仅是 Redis SCAN 提示，不代表精确页大小；响应不提供不稳定的 `total`；
- `key_value.scan` 只返回 Key 字符串，不暴露底层 SCAN 当前为兼容前端而填充的 `valueType="key" / ttl=-1 / size=null` 占位元数据；
- `key_value.get` 只接收扁平的 `profileId/dbIndex/key`，返回实际 `valueType`、TTL、JSON-safe 内存大小和 string/json/hash/list/set/sorted-set/stream 等类型化 value；不接收或生成 Redis command；
- `key_value.scan/get` 在 Query 与 Agent 可见、Ask 不可见，声明 `risk.level=low`、`reversible=true`、`sideEffect=business_read` 和 `key_value_browser` capability；
- `key_value.scan/get` 不隐式打开连接，通过 Workbench Application Service 复用 shared profile runtime；连接未打开返回 `CONNECTION_NOT_OPEN`，非 Key/Value Driver 返回 `CAPABILITY_UNAVAILABLE`；
- 当前 `key_value.get` 复用 Workbench 既有完整值读取语义，并由 Tool Core 设置 1 MiB 结果上限；V1 不为 hash/list/set/zset/stream 复制一套 AI 专用分页协议。后续若真实大 Key 使用需要限量预览，应先统一扩展底层 `KeyValueBrowser`，让前端与 AI 共用；
- `key_value.create/set/rename/set_ttl/delete` 只进入 Agent；模型输入是 bounded typed DTO，不包含 Redis command、fingerprint、`planId`、risk 或 Permission。create/set/rename/persist TTL 为 high 标准审批，expire TTL 与 exact delete 为 critical 强确认；
- Redis prepare/execute 分别使用五个静态 operation；prepare 读取必要 precondition 并生成 5 分钟 single-consume plan，execute 只消费 exact Rust mutation request，不自动重试；
- `key_value.delete_prefix` 仍仅属于既有 Workbench UI，不是 Agent Tool，也未获得一次性计划语义；
- 当前仍不包含专用 schema/table mutation Tool 或 Action Dispatcher。

十四个 Backend Tool 及其 Gateway operation 使用独立强类型 DTO：

~~~ts
interface ConnectionListRequest {}

interface ConnectionListResponse {
  connections: ConnectionListItem[];
}

interface ConnectionGetRequest {
  profileId: string;
}

interface ConnectionGetResponse {
  connection: ConnectionDetail;
}

interface ConnectionOpenRequest {
  profileId: string;
}

interface ConnectionOpenResponse {
  connection: {
    profileId: string;
    name: string;
    driver: string;
    connected: true;
    runtime: AiConnectionRuntime;
  };
  wasAlreadyOpen: boolean;
}

interface MetadataListChildrenRequest {
  profileId: string;
  parent?: ContainerRef;
  offset?: number;
  limit?: number;
}

interface MetadataListChildrenResponse {
  children: DataContainer[];
  total: number;
  nextOffset?: number;
}

interface MetadataDescribeTableRequest {
  profileId: string;
  container: ContainerRef;
}

interface MetadataDescribeTableResponse {
  container: ContainerRef;
  schema: TableSchema;
}

type TableLikeContainerRef = ContainerRef & {
  kind: "table" | "view" | "materialized_view";
};

interface TableQueryRequest {
  profileId: string;
  source: TableLikeContainerRef;
  columns?: string[];
  filters?: Array<
    | { column: string; operator: "eq" | "not_eq" | "gt" | "gte" | "lt" | "lte"; value: string | number | boolean }
    | { column: string; operator: "is_null" | "is_not_null" }
  >;
  sort?: Array<{ column: string; direction: "asc" | "desc" }>;
  page?: number;
  pageSize?: number;
}

interface TableQueryResponse {
  source: TableLikeContainerRef;
  columns: Array<{
    name: string;
    typeName: string;
    nullable: boolean;
    dataCategory: string;
  }>;
  rows: unknown[][];
  page: number;
  pageSize: number;
  totalRows: number | string;
  totalPages: number | string;
  hasNextPage: boolean;
}

interface KeyValueScanRequest {
  profileId: string;
  dbIndex: number;
  pattern?: string;
  cursor?: string;
  count?: number;
}

interface KeyValueScanResponse {
  dbIndex: number;
  pattern: string;
  nextCursor: string;
  done: boolean;
  keys: string[];
}

interface KeyValueGetRequest {
  profileId: string;
  dbIndex: number;
  key: string;
}

interface KeyValueGetResponse {
  key: string;
  valueType: string;
  ttl: number;
  size: number | string | null;
  value: RedisValue;
}

type KeyValueMutationRequest =
  | { tool: "create"; profileId: string; dbIndex: number; key: string; value: RedisEditableValue; ttlSeconds?: number }
  | { tool: "set"; profileId: string; dbIndex: number; key: string; value: RedisEditableValue; ttlPolicy?: "keep" | "persist" | "expire"; ttlSeconds?: number }
  | { tool: "rename"; profileId: string; dbIndex: number; key: string; newKey: string }
  | { tool: "set_ttl"; profileId: string; dbIndex: number; key: string; mode: "persist" | "expire"; ttlSeconds?: number }
  | { tool: "delete"; profileId: string; dbIndex: number; key: string };

interface KeyValueMutationResponse {
  dbIndex: number;
  key: string;
  valueType: string;
  ttl: number;
  size: number | string | null;
  mutationState: "completed";
}

interface KeyValueDeleteResponse {
  dbIndex: number;
  key: string;
  deletedCount: 1;
  mutationState: "completed";
}
~~~

上面的联合只用于并列展示五个独立模型 DTO；生产 Registry 仍为每个 Tool 使用独立 strict Zod/Serde schema，不接收 `tool` discriminator，也不提供任意 mutation dispatcher。`expectedFingerprint` 和 `planId` 只存在于可信内部 prepare/execute payload。

`ConnectionListItem` 与 `ConnectionDetail` 的连接配置只允许出现已确认的非敏感字段。`ConnectionDetail` 在紧凑信息基础上增加完整非敏感设置、runtime/health/capability 和展示元数据。Rust 与 AI Runtime 必须分别使用 Serde/Zod 严格校验 DTO，并使用嵌套 secret sentinel 测试证明密码、Token、API key、私钥及口令的 key/value 都不会进入序列化结果。

除 Backend 业务工具外，V1 同批增加一个 Runtime-local 低风险工具：

~~~text
system.current_time -> np__system__current_time
~~~

它无输入，直接读取 AI Runtime 进程所在系统的当前时间，返回 `utc`、带 UTC offset 的 `localDateTime`、IANA `timeZone`、`utcOffsetMinutes` 与 `epochMs`。它属于 `system` Namespace，`executionTarget="runtime"`、`sideEffect="none"`，不经过 Backend Bridge。

`web.fetch` 与 `web.ping` 是 Runtime-local web 纵向切片，无需经过 Backend Bridge。二者均为 `risk.level=low`、`sideEffect="external_network"`、`reversible=true`，因此在 Ask、Query、Agent 的 web Namespace policy 中可见，仍须经过 Snapshot、Core、limits、ToolCall 持久化与结果归一化。

每个新 Run 将 Runtime Settings 的 `networkPolicy.accessScope` 冻结进 Tool Snapshot。默认 `local-and-public` 允许本机可达的公网、内网、VPN、容器网络与 localhost；选择 `public-only` 时，Core 把该范围传入 web executor，后者拒绝 loopback、private、link-local、reserved IP 与解析到这些地址的 hostname。范围不改变 HTTP(S) URL 限制、重定向逐跳校验、超时或结果大小上限。

当上述拒绝由 `public-only` 范围引起时，`web.fetch` 与 `web.ping` 一律返回 `NETWORK_ACCESS_SCOPE_DENIED`，而非通用 `VALIDATION_ERROR`。错误的安全 `details` 固定说明 `network_policy.access_scope`、建议值 `local-and-public` 和 `takesEffect=new_run`，并只在该错误下追加两条短小的 `guidance`：仅当该目标确实完成用户请求所必需时，引导用户到“设置 → AI 能力 → 偏好设置 → 网络访问范围”修改；不得自动修改偏好，且在用户未修改设置前不得重复调用同一被拒绝目标。该引导不进入两个工具的常驻 description，也不附带额外的 DNS/网络探测信息。`new_run` 是 Runtime 的内部冻结语义，不要求模型向用户解释或自行创建 Run。非 HTTP(S) 输入仍是 `VALIDATION_ERROR`，DNS/连接故障仍是 `NETWORK_ERROR`，无 ICMP 回复仍是 `unreachable` 成功诊断。

`web.ping` 的输入只有单个 hostname 或 IP。executor 先解析并按冻结范围校验地址，然后通过参数数组启动系统 `ping`，固定 3 次探测、单包 1 秒与总计 6 秒超时；不支持端口、CIDR、范围或任意附加 ping 参数，不使用 shell。它返回规范化的可达性、收发包/丢包及可用的 RTT；无 ICMP 回复是 `unreachable` 的成功诊断结果，进程启动、解析、范围校验或超时才是执行错误。

## 12. AI SDK Adapter 边界

L1-A 已将 Runtime、Provider packages、Web `@ai-sdk/react` 与 assistant-ui adapter 同批升级到 AI SDK 7 兼容依赖族。依赖版本未来仍不永久冻结；后续实施应继续通过 Bun 升级为当时最新、互相兼容的稳定版本，不维护旧主版本双轨。

在 Runtime-owned Run、Snapshot、Permission、Store 和 Core guardrail 不被削弱的前提下，优先复用 AI SDK 7 已稳定提供的 `ToolLoopAgent`、tool calling、`activeTools`、`stopWhen/isStepCount`、`onStepEnd`、`onEnd`、`stream()`、调用级 `toolApproval` 和 UI stream 能力。实验 API 和已废弃的 Tool `needsApproval` 不作为 Core 依赖。

每个 Run 根据已经冻结的 Snapshot 构造轻量 AI SDK agent/tool set；AI SDK Tool 的 `execute` 只能调用 Runtime Tool Core dispatcher，不能直接调用 Runtime-local executor 或 Rust Gateway。AI SDK 类型推断与 `outputSchema` helper 不能替代 Runtime 对真实 executor/Gateway 输出的运行时校验。

所有暴露给模型的 Tool `inputSchema` 经 AI SDK 转换后，必须是顶层 `type: "object"` 的 JSON Schema。不得直接把顶层 `z.union` / `z.discriminatedUnion` 暴露给 OpenAI-compatible Provider；此类 Schema 会转换为只有 `oneOf` / `anyOf` 而没有顶层 object type 的参数定义，部分 Provider 会将其拒绝为 `type: null`。需要跨字段判别时，Provider-facing Schema 使用单个 strict object 描述字段，Runtime 继续通过 `refine` / `superRefine` 执行更严格的组合校验；Provider 兼容性不得替代或削弱 Runtime 输入校验。

AI SDK 在进入 Tool `execute` 前发现的 ToolCall 解析或输入 Schema 错误，属于 Adapter/消息投影事实，不代表调用已经进入 Runtime Tool Core。Runtime 应将对应消息 Tool Part 收敛为可重试的 `VALIDATION_ERROR`，但不得为其持久化 ToolCall、Permission 或 Core execution Event；未通过 Schema 的原始输入和校验异常都可能包含敏感内容，不得直接进入持久化消息或 UI。只有实际进入 Core dispatcher 的调用才形成 Runtime-owned ToolCall 事实。

实施时必须重新检查官方文档和最新稳定版本。当前设计核对入口：

- <https://ai-sdk.dev/llms.txt>
- <https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling>
- <https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent>

## 13. 自下而上的实现依赖图

~~~mermaid
flowchart BT
    BASE["L0 已有基础<br/>Runtime Run / Store / EventBus / HTTP<br/>Rust Repository / ConnectionRuntimeManager / Driver Capability"]

    SDK["L1-A AI SDK 依赖族升级<br/>现有 Stream / History / Provider 回归"]
    DOMAIN["L1-B Runtime 基础契约（已实现）<br/>Tool / Risk / Result / Error / Permission"]
    AUTH["L1-C Runtime Access Token（已实现）<br/>/v1 HTTP / SSE 统一鉴权<br/>WS 接入随 Bridge 实现"]

    REGISTRY["L2 Tool Kernel（已实现）<br/>Namespace / Tool 不可变注册<br/>Canonical ID / Provider Name Codec"]
    SNAPSHOT["L3 Per-Run Resolution（已实现）<br/>Agent Policy + resolveForRun<br/>不可变 Run Tool Snapshot"]
    CORE["L4 Runtime Core Dispatcher<br/>输入输出校验 / Policy / Limits<br/>ToolCall 持久化 / Execution Target 分流"]

    WEBFETCH["L5-A Runtime-local 验证切片<br/>把现有 web_fetch 接入新 Core"]

    BRIDGE["L5-B Backend WS Bridge（已实现）<br/>ready / ping-pong / request-response / reconnect"]
    GATEWAY["L5-C Rust Gateway<br/>静态 Dispatcher / Error Boundary"]
    BACKEND["L6 Backend Executor Adapter<br/>Core ↔ Bridge ↔ Gateway"]

    SERVICE["L6.5-A Workbench Application Service（已实现）<br/>Tauri Command / Gateway 双入口<br/>共享 Repository / ConnectionRuntimeManager"]
    SYNC["L6.5-B Workbench Runtime Projection（已实现）<br/>Rust → React Domain Event<br/>Runtime Snapshot IPC 恢复"]

    DTO["L7（已实现并扩展）Gateway DTO + system.current_time<br/>输入输出 / Secret Redaction"]
    READTOOLS["L8（已实现并扩展）真实业务工具<br/>connection.list / get / open<br/>metadata.list_children / describe_table<br/>table.query<br/>key_value.scan / get"]

    PERMISSION["并行分支 P1<br/>Runtime Permission 状态机<br/>/runs/:runId/continue<br/>AI SDK / Frontend Approval Adapter"]
    RISKY["未来业务功能<br/>动态 Risk sql.execute<br/>Mutation / Destructive Tool"]

    BASE --> SDK
    BASE --> DOMAIN
    BASE --> AUTH

    SDK --> REGISTRY
    DOMAIN --> REGISTRY
    REGISTRY --> SNAPSHOT
    SNAPSHOT --> CORE

    CORE --> WEBFETCH

    AUTH --> BRIDGE
    BASE --> BRIDGE
    BRIDGE --> GATEWAY
    BASE --> GATEWAY
    BASE --> SERVICE

    CORE --> BACKEND
    BRIDGE --> BACKEND
    GATEWAY --> BACKEND

    GATEWAY --> SERVICE
    SERVICE --> SYNC
    BACKEND --> DTO
    SERVICE --> DTO
    DTO --> READTOOLS

    SDK --> PERMISSION
    DOMAIN --> PERMISSION
    CORE --> PERMISSION

    PERMISSION --> RISKY
    BACKEND --> RISKY
~~~

推荐实施顺序：

1. 同批升级并回归 AI SDK/Provider/Web adapter 依赖族；
2. 建立 Tool/Risk/Result/Error/Permission 基础契约；
3. 实现 Tool Kernel、Namespace Registry 和 Provider Name Codec；
4. 实现 per-Run resolution 与不可变 Tool Snapshot；
5. 实现 Runtime Tool Core dispatcher；
6. 把现有 `web_fetch` 接入新 Core，完成 Runtime-local 纵向验证；
7. 实现统一 access token、Backend Bridge 和 Rust Gateway；
8. 接通 Backend executor adapter；（已完成）
9. 抽取首批 Gateway/Tauri 共用的 Workbench Application Service；（L6.5-A 已完成）
10. 补齐 Rust → React Domain Event + Runtime Snapshot 投影；（L6.5-B 已完成）
11. 闭环 Gateway DTO、secret redaction 和 Runtime-local `system.current_time`；
12. 实现四个首批只读业务 Tool，并扩展可逆的 `connection.open`；随后增加结构化 `table.query` 与 `key_value.scan/get`；（L8 已完成并扩展）
13. 按 [Database tool safety model](./database-tools.md) 维护 Permission 状态机、同一 Run continuation 与 approval UI；
14. 增加 standard/strong confirmation 和一次性 prepared plan；
15. 实现动态 Risk `sql.execute`，再完成 Redis mutation hardening 与 Key/Value mutation Tool；（已完成）
16. 增加 Runtime-owned `none/low/medium` 自动审批阈值、设置 API、Frontend 设置项与 per-Run 冻结。（已完成）

L1-L8 与 L6.5-A/B 已经实现。七个只读 Backend Tool、可逆的 `connection.open`、Runtime Permission/continuation、Frontend standard/strong confirmation、一次性 prepared plan、`sql.execute` 通用三态闭环、五个 Redis 单 Key mutation Tool，以及 Runtime-owned 自动审批阈值均已完成。SQLite、MySQL、PostgreSQL、Oracle 与 ClickHouse 已加入显式 SQL Driver 启用门；ClickHouse 复用 shared managed lifecycle，并区分异步 mutation submitted/completed。Redis 已通过原子替换、WATCH/CAS 与真实库故障注入验收。Oracle 与 ClickHouse 外部真实库 smoke 尚待测试服务恢复后复验。remembered grant、per-connection policy 与企业治理保持延期。

## 14. 当前实现明确延期

- 用户、Plugin、MCP 或 Driver 动态注册 Namespace/Tool；
- Namespace/Tool version、hash、manifest 和热加载；
- 通用 Action Dispatcher 与任意命令字符串；
- `sql.execute` 之外的专用 schema/data mutation 和 destructive Tool；这些能力仍须按独立路线图建立精确预览、漂移保护与执行边界后才注册；
- Namespace revision 和 Run 中途增删工具；
- 系统级自动 Tool retry；
- 跨版本 Rust/AI Runtime 协商；
- remembered grant、企业 RBAC、subagent 和多智能体委派。
