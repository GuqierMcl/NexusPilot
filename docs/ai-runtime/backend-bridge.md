# AI Runtime Backend WebSocket Bridge 与 Rust Gateway 设计

> 状态：L5-B Bridge transport、L5-C Rust Gateway 静态 Dispatcher/Error Boundary、L6 Backend Executor Adapter、L7 DTO/secret redaction、七个只读 Backend Tool、可逆的 `connection.open`、`sql.execute` 三态链路、五个 Redis 单 Key mutation Tool 及内部 prepared plan transport/registry 已实现。
>
> 日期：2026-07-30。

本文定义 AI Runtime 与 Rust/Tauri Host 之间的 Backend WebSocket Bridge，以及 Bridge 后方的 Rust Gateway。三条通信通道的总边界见 [communication-boundaries.md](./communication-boundaries.md)；Tool policy、Snapshot 和 Core dispatcher 见 [tool-namespace.md](./tool-namespace.md)。

高风险 SQL 与 Key/Value mutation 的稳定执行边界见 [Database tool safety model](./database-tools.md)。

## 1. 定位与拓扑

Backend Bridge 是 Rust/Tauri Host 与 AI Runtime 的内部双向长连接，主要服务 Backend ToolCall：

~~~text
Frontend/WebView
  -> AI Runtime /health
  <- AI Runtime EventBus/SSE

AI Runtime Runtime-local Tool
  -> AI Runtime 内部 executor

AI Runtime Backend Tool
  -> Runtime Tool Core
  -> /v1/internal/backend-bridge
  -> Rust Gateway
  -> Repository / ConnectionRuntimeManager
  -> Driver capability trait
~~~

确定边界：

- AI Runtime 在现有 Elysia loopback host/port 提供 `/v1/internal/backend-bridge`；
- Rust/Tauri 是主动连接的唯一 Backend Client；
- Frontend 不连接、不代理、不转发 Bridge；
- Runtime-local Tool，例如 `web.fetch`，不经过 Bridge；
- Bridge 不注册 Namespace/Tool，也不决定 Risk、Permission 或 active tools；
- EventBus/SSE、`/health` 和 Bridge 即使共享 host，也保持独立语义；`/health` 是公开的进程诊断入口，不进入业务鉴权。

## 2. 可选统一鉴权

生产模式由 Tauri 每次启动生成随机 256-bit access token，通过环境变量注入 AI Runtime：

~~~text
NEXUS_PILOT_AI_RUNTIME_ACCESS_TOKEN
~~~

规则：

- token 存在时，AI Runtime 的 `/v1/**`（包括 SSE）和未来 WebSocket Upgrade 统一要求 `Authorization: Bearer <token>`；
- `/health`、`/docs`、`/docs/json`、其他非 `/v1/**` 路径和 CORS `OPTIONS` 不要求 token；
- token 不存在时关闭鉴权，作为开发环境默认行为；
- Tauri 拥有 token，并通过统一前端请求适配层和 Rust Bridge client 使用它；
- AI Runtime 只在进程内存中读取和校验 token；
- token 不进入 CLI 参数、URL、Cookie、SQLite、Tauri Store、localStorage、ToolCall、Permission、Snapshot、Trace、日志或 UI；
- V1 鉴权失败统一返回 `401`；未来 WebSocket Upgrade 必须在 Upgrade 前完成校验，不得建立部分可用连接；
- V1 不实现 challenge-response、TLS、持久 token、refresh、scope 或多客户端身份。

该鉴权用于防止普通本机进程无意或低成本调用本地 Runtime API，不把本地数据库文件加密或操作系统进程隔离纳入 V1 威胁模型。

## 3. Ready 握手与连接所有权

WebSocket Upgrade 成功后执行简化双向握手：

~~~text
AI Runtime -> runtime.ready
Rust       -> backend.ready
AI Runtime -> Bridge state = ready
~~~

~~~ts
interface RuntimeReadyFrame {
  type: "runtime.ready";
  runtimeState: "ready";
  startedAt: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
}

interface BackendReadyFrame {
  type: "backend.ready";
}
~~~

V1 不包含 protocol version、manifest、supported versions、host/runtime/session ID。Rust 与 AI Runtime 配套发布，不做混合版本协商。

单个 AI Runtime 同时只接受一个 active Backend connection。新的已鉴权连接完成 `backend.ready` 后替换旧连接；旧连接及其 pending requests 立即按断线语义失败。未完成 ready 的连接不能接收 operation request。

`runtime.ready` 是 Bridge 内部 Frame，Frontend 不直接接收。Rust 使用自己掌握的 sidecar host、port 和 token 主动建连，不读取 `/health` 或 EventBus。

## 4. Frame Contract

V1 只使用 UTF-8 JSON Text Frame：

~~~ts
interface GatewayError {
  code: string;
  message: string;
  retryable: boolean;
  outcome: "not_started" | "no_effect" | "unknown";
}

type BackendBridgeFrame =
  | RuntimeReadyFrame
  | BackendReadyFrame
  | { type: "ping"; id: number }
  | { type: "pong"; id: number }
  | {
      type: "request";
      requestId: string;
      operation: string;
      input: unknown;
    }
  | {
      type: "response";
      requestId: string;
      ok: true;
      data: unknown;
    }
  | {
      type: "response";
      requestId: string;
      ok: false;
      error: GatewayError;
    };
~~~

规则：

- `requestId` 在一个 active connection 内唯一，用于并发多路复用；
- `operation` 使用 Runtime canonical Tool ID，例如 `connection.list`；
- outer frame 只做路由，Rust dispatcher 立即把 `input` 反序列化为 operation 的具体 Request DTO；
- AI Runtime 收到 response 后，必须用对应 Tool 的 `outputSchema` 校验 `data`；
- 未知 frame type、缺失字段、未知 requestId 或非法状态顺序视为协议错误；
- 已终止 ToolCall 的迟到 response 被忽略并记录脱敏诊断，不重新打开 ToolCall；
- V1 不使用 Binary Frame、压缩、chunk、progress、cancel frame 或 server push operation。

## 5. Heartbeat、断线与重连

应用层 heartbeat 使用：

- AI Runtime 每 15 秒发送一次 `ping`；
- Rust 收到后立即返回相同 `id` 的 `pong`；
- 45 秒未收到有效 `pong`，AI Runtime 主动关闭连接并标记 `disconnected`；
- Rust 监听连接关闭并使用有上限的递增 backoff 主动重连；
- Rust 重连不依赖 Frontend、EventBus 或 `/health`。

断线时不做系统级兜底重试：

| 时点 | Runtime Tool Error | `outcome` |
|---|---|---|
| 调用前 Bridge 尚未 ready | `BACKEND_BRIDGE_UNAVAILABLE` | `not_started` |
| request 尚未成功发送即断线 | `BACKEND_BRIDGE_DISCONNECTED` | `not_started` |
| request 已发送但 response 未到即断线 | `BACKEND_BRIDGE_DISCONNECTED` | `unknown` |

所有 pending requests 立即失败；不等待 Bridge 恢复、不重放 request、不复用原 Permission。错误应包含足够信息，让模型决定是否发起新的 ToolCall。

V1 不实现 sidecar 自动重启、operation replay、跨连接 request recovery、cancel/progress 或 exactly-once 保证。

## 6. `/health` 只读诊断

AI Runtime process health 与 Bridge availability 分离。Bridge 未连接时 `/health.status` 仍可为 `ok`，Runtime-local Tool 和普通对话仍可工作。

`/health` 可以返回只读诊断：

~~~ts
interface RuntimeHealthProjection {
  status: "ok";
  version: string;
  backendBridge: {
    state: "waiting" | "ready" | "disconnected";
    lastHeartbeatAt?: number;
  };
}
~~~

- `waiting`：本次 Runtime 启动后尚未完成过 `backend.ready`；
- `ready`：当前 active connection 已握手且 heartbeat 正常；
- `disconnected`：曾经 ready，但当前连接已经丢失。

Frontend 可展示该诊断，但是否开放智能体入口只取决于 AI Runtime 自身健康。EventBus 不发布 heartbeat，也不转发 Bridge Frame。

当前设置页在“AI 能力 > 运行时”中以用户可理解的“后端能力连接”展示 `等待连接 / 已连接 / 已断开 / 未知`，并在收到有效 heartbeat 时展示最近通信时间；UI 不暴露 WebSocket endpoint、requestId 或协议 Frame。

AI Runtime 与 Rust Backend Client 都在 DEBUG 级别记录 Frame 收发方向和脱敏路由元数据。允许字段限于 `frameType`、`requestId`、`operation`、ping/pong ID、`ok`、稳定 error code 和消息字节数；不得记录完整 `input`、`data`、error message、Authorization Header、Token 或其他业务 payload。

AI Runtime 通过现有 `NEXUS_PILOT_LOG_LEVEL=debug` 开启 DEBUG 输出；Rust/Tauri Debug 构建启用 DEBUG，Release 构建保持 INFO，因此生产默认不会输出高频 Frame 日志。

## 7. Rust Gateway

### 7.1 位置与复用

Rust Gateway 是与 Tauri IPC 并列的内部 adapter：

~~~text
Tauri IPC adapter ─────┐
                      ├─> Workbench Application Service
Backend Gateway ──────┘       ├─> Repository
                              └─> ConnectionRuntimeManager / Driver capability
~~~

Gateway 不调用 Tauri command handler，也不重新创建数据库 runtime。Tauri Command 与 Gateway Operation 只负责各自入口的 DTO/错误适配，共同调用同一个 Workbench Application Service；该 Service 从 Tauri managed state 复用同一个 Repository、`ConnectionRuntimeManager`、`DatabaseDriver` 和 capability trait。

L6.5-A scoped extraction 已实现：`src-tauri/src/workbench/application_service.rs` 集中承载 `connection.*`、`metadata.*` 所需的现有 Rust 编排，不重构整个 Engine。连接 list/get/open、读取 stored profile 后 connect、disconnect、metadata children 和 table describe 均通过该 Service 复用；Gateway Operation 不能重新维护编排。

同一动作可以携带 `Frontend` 或 `AiRuntime` origin，供日志、审计和 Workbench Domain Event 使用；origin 不得选择不同的连接池、状态机、恢复策略或 Driver 实例。数据库 runtime 的唯一事实仍由同一个 `ConnectionRuntimeManager` 持有。

### 7.2 静态强类型 Dispatcher

V1 使用静态 operation dispatcher：

~~~text
operation string
  -> exact match canonical ID
  -> parse concrete Request DTO
  -> call typed Handler
  -> serialize concrete Response DTO
~~~

约束：

- 一个 Backend Tool 对应一个同名 Gateway operation；
- `connection.list` Tool 对应 `connection.list` operation，依此类推；
- Runtime-local Tool 可以没有 Gateway operation；
- dispatcher 不按 Driver 名称分支；
- Handler 通过 capability trait 处理不同 Driver；
- Gateway 不暴露任意 Tauri command、任意 Rust method、任意 SQL 或任意 Action string；
- 后续复杂 Tool 可以编排多个稳定 operation，但不能退化为通用命令执行器。

“一个 Tool 对应一个 operation”是 V1 的默认简单映射，不是永久强制的一对一架构定律。原始 SQL 工具 `sql.execute` 已实现先调用只读 `sql.analyze`、再消费 plan 调用 `sql.execute` 的受控例外；结构化 `table.query` 不接收 SQL 文本，也不需要这条动态 Risk 分析路径。

### 7.3 Handler 校验

即使 AI Runtime 已完成 Tool policy 和输入 Schema 校验，Rust Handler 仍必须在可信边界内重新校验：

- profile、connection runtime 与 resource 是否存在；
- `ContainerRef` 是否有效且属于目标连接；
- 当前 Driver 是否提供所需 capability trait；
- Request DTO 的 Rust 侧结构约束；
- 输出中是否包含 credential 或其他 secret。

这些是执行前置条件和后端安全边界，不是 Runtime Permission 决策。

### 7.4 高风险 Tool 的 Prepare/Execute 扩展

以下边界已经实现；SQLite、MySQL、PostgreSQL 与 Oracle 已加入显式 Driver 启用门，其他 Driver 在各自 framing 与真实数据库验收前保持关闭。Oracle 本地 framing/analysis/target 测试已通过，配置的外部测试服务在建连阶段返回 `early eof`，真实库 smoke 尚待服务恢复后复验：

~~~text
Runtime Core
  -> sql.analyze（内部只读 operation）
  -> Runtime resolved risk / Permission
  -> sql.execute（模型可见 Tool 的同名 execute operation）
~~~

`sql.analyze` 不是模型可见 Tool，也不加入 Run Snapshot。它只允许由 Tool Definition 预先声明的 Core prepare 路径调用，接收 Core 注入的 ToolCall identity、profile/context 和精确 SQL。Gateway 返回：

- `analyzed`：可靠 statement class、risk、reasons 与 prepared plan；
- `uncertain`：能够确认完整单语句和 target，但无法精确分类；Runtime 必须按 `critical` strong confirmation 处理；
- `rejected`：无法可靠 framing、输入超限、target/capability 无效或命中 hard guardrail；不创建 Permission。

prepared plan 使用 Rust 内部 `planId` 与 `toolCallId/profile/context/exact payload/expiry/single-consume state` 绑定。模型 input、Frontend continuation 和公共 Tool/Permission contract 都不包含 `planId`、`inputHash` 或 `planHash`。批准后的 `sql.execute` 只能消费同一个 ToolCall 的一次性 plan；过期、重复消费或不匹配 fail closed。

该扩展不能退化为任意 operation dispatcher。每个 prepare/execute operation 仍需静态注册、强类型 DTO、独立 Handler 与稳定错误边界。Redis mutation 已按同一原则为 create/set/rename/set_ttl/delete 分别注册 prepare 与 execute operation；共享 Driver 已使用临时键原子切换和 WATCH/CAS value fingerprint 完成 stale target 保护。

## 8. Error Boundary

Rust Gateway 只返回稳定、脱敏的 `GatewayError`：

- `code`：可供 Runtime 和模型判断的稳定错误码；
- `message`：可读但不包含 stack、SQL credential、connection string 或底层敏感 details；
- `retryable`：模型是否可以考虑创建新的 ToolCall；
- `outcome`：操作是否未开始、确定无副作用，或结果未知。

AI Runtime 把 `GatewayError` 映射为 `RuntimeToolError`，并在 Core 中统一持久化。该边界同时覆盖普通 execute request 与审批前的 prepare/analyze request：`CONNECTION_NOT_OPEN`、`CAPABILITY_UNAVAILABLE`、`PLAN_MISMATCH`、Bridge 断线和其他可归属当前 ToolCall 的错误，都结束于 `ToolCall.state=error`，作为非致命工具结果交回模型，不得通过 AI SDK `toolApproval` rejected promise 终止整个 Run。数据库自身返回的 `PERMISSION_DENIED` 表示远端数据库权限不足，不等于 Runtime Permission deny，不能创建或修改 Runtime Permission。

Core/adapter 不自动重放 Bridge request。`outcome=not_started/no_effect` 允许模型根据 `retryable` 和上下文决定是否创建新的 ToolCall；`outcome=unknown` 必须禁止自动重试并向用户说明结果不确定。Provider/模型 stream、Runtime Store 持久化和其他无法归属 ToolCall 的系统错误不属于 Bridge Tool error，可保留 Run-fatal 语义。

未知 panic/异常必须在 Rust 边界收敛为 `SYSTEM_INTERNAL`，详细上下文只进入脱敏本地日志。

## 9. 第一批 Operation 与已确认 DTO

第一批 Gateway operation：

~~~text
connection.list
connection.get
connection.open
metadata.list_children
metadata.describe_table
table.query
key_value.scan
key_value.get
key_value.prepare_create
key_value.create
key_value.prepare_set
key_value.set
key_value.prepare_rename
key_value.rename
key_value.prepare_set_ttl
key_value.set_ttl
key_value.prepare_delete
key_value.delete
~~~

首批只读 operation 与后续高风险 operation 的精确 Request/Response DTO 已闭环并实现：

- 复用当前 Repository、`ContainerRef`、`DataContainer` 与 `SchemaBrowser` 语义；
- 对 connection profile 做明确 allowlist 投影，而不是对原对象做“删除 password 字段”式脱敏；
- 同步定义 Rust 与 TypeScript Schema；
- 为 credential/secret redaction、unsupported capability 和 resource not found 提供测试。
- `table.query` 以结构化列、过滤、排序和分页 DTO 复用 shared `DataTableBrowser`，不接受 SQL 文本，过滤值由 Driver 参数绑定。
- `key_value.scan/get` 复用 shared `KeyValueBrowser`：scan 使用 JSON-safe 字符串游标并只返回真实 Key，get 返回 TTL、大小与类型化 value；两者都不接受 Redis command。
- 五个 Redis prepare operation 只接受 bounded 模型 DTO 与可信 execution context；模型不能提供 fingerprint、risk、Permission 或 `planId`。五个 execute operation 只接受 Core 注入的内部 `planId`，消费 plan 中的精确 Rust mutation request。
- Redis create/set/rename/set_ttl/delete 通过 Workbench Application Service 复用 shared `ConnectionRuntimeManager/KeyValueBrowser`。stale value、duplicate create 和 occupied rename destination 返回 `no_effect`；计划消费并 dispatch 后的 timeout/断线/未知内部错误保守返回 `unknown`，所有 mutation 均禁止自动重试。

精确字段、分页边界和 `metadata.describe_table` 的专用表结构语义见 [tool-namespace.md](./tool-namespace.md#11-第一批真实工具)。Rust DTO/安全投影位于 `src-tauri/src/ai_runtime/backend_bridge/contracts.rs`，AI Runtime Zod Schema 位于 `ai-runtime/src/runtime/tools/backend-read-contracts.ts`。L7 先固定契约，L8 再把对应 Handler 和 Backend Tool 注册到生产静态 Registry。

## 10. 实现状态与非目标

L1-C 与 L5-B 已实现：包括 per-launch access token、`/v1/**` HTTP/SSE/Backend WebSocket Upgrade 鉴权、`/v1/internal/backend-bridge`、`runtime.ready/backend.ready`、应用层 ping/pong、单 active connection、AI Runtime pending request 多路复用、断线立即失败、Rust 主动递增 backoff 重连，以及 `/health.backendBridge` 只读诊断。

Rust 端已用 L5-C `GatewayDispatcher` 替换占位 Handler。它在启动时构建不可变静态 operation registry，严格匹配两段式 canonical operation ID，拒绝非法或重复注册，并把未知 operation 稳定映射为 `GATEWAY_OPERATION_NOT_FOUND + outcome=not_started`。每个 operation 负责把 `input` 解析为自己的强类型 DTO；类型化错误原样进入 Gateway envelope，未知 panic 在 dispatcher 边界收敛为脱敏 `SYSTEM_INTERNAL + outcome=unknown`。

AI Runtime 已实现 L6 `BackendBridgeToolExecutor`，并由 Run 创建的 `RuntimeToolCore` 统一持有。普通 Backend Tool 的 canonical ID 不经改名直接作为 Gateway operation，输入与当前 ToolCall 的 abort signal 通过 `BackendBridgeManager.request()` 发送；prepared Backend Tool 则先由 Core 调用定义中静态声明的 prepare operation，并在独立 Bridge `context` 中注入可信的 Conversation/Run/Message/ToolCall/Tool identity。批准后 Core 只向同名 execute operation 发送内部 `planId`，不转发可修改的原始模型 input。成功响应的 `data` 回到 Core 后仍须通过该 Tool 的 `outputSchema`、结果大小和脱敏检查。Bridge DTO 中声明为可选的字段在无值时必须省略，不得以 `null` 代替缺省；特别是 prepared Permission target 的 `database/schema` 必须与 Runtime `field?: string` 契约保持一致。`GatewayError` 与 Bridge 错误的 `code / message / retryable / outcome` 被无损映射为 `RuntimeToolExecutionError`，未知适配器异常则收敛为不包含底层 details 的 `BACKEND_EXECUTION_FAILED + outcome=unknown`。适配器不注册 Tool、不做权限判断、不重试、不持久化 ToolCall。

当前生产 Gateway operation Registry 已静态注册 `connection.list/get/open`、`metadata.list_children/describe_table`、`table.query`、`key_value.scan/get`、`sql.analyze/execute`、五组 `key_value.prepare_*/execute`，以及仅供 Runtime 终止清理调用的 `prepared_plan.cleanup_run`。十四个模型业务 Tool 的 Handler 解析各自强类型 DTO，并复用 Tauri managed 的同一个 `DatabaseState`、`ConnectionRuntimeManager` 与 Workbench Application Service；prepared plan 注册表只保存执行凭据与精确 payload，不建立 AI 专用连接池或额外连接状态机。它在 Bridge 断线、Run 终止、profile disconnect 与 app shutdown时清理。

`sql.analyze` 只做 target/capability/framing/风险分析，不执行 SQL；`sql.execute` 只消费同 ToolCall 的 plan。legacy SQL Driver 通过 shared profile runtime 的既有 `SqlExecutor` 原样执行批准 SQL；ClickHouse 要求 direct managed capability，并在同一个 shared runtime 上复用 `ManagedSqlExecutor`、唯一 query id、30 秒 backend timeout、timeout/cancel/query-wins 与观察告警语义，不创建 Agent tab runtime。Redis prepare 只读取现存 Key 的 stable `DUMP + metadata + DUMP` precondition；execute 复用 hardened `KeyValueBrowser`，以带保护 TTL 的临时键和 `WATCH + MULTI/EXEC` 原子提交。连接、profile revision、Driver 或 capability 在审批后失效会返回 `no_effect`；提交后遇到 timeout、断线或内部失败则保守返回 `unknown`。ClickHouse 异步 mutation 命令只返回 `submitted`，不会描述为 server-side 已完成；Redis 原子 mutation 成功返回 `completed`。`connection.open` 已打开时幂等复用当前 runtime，首次打开后以 `origin=aiRuntime` 发布既有 Workbench Domain Event。`table.query`、`key_value.scan/get` 与 Redis mutation 都使用 shared profile runtime，不创建 Agent tab runtime。

L6.5-A/B 与 L8 已完成。共享 Service 确保真实 Gateway Operation 不复制 Tauri Command 的业务编排；Rust 操作引起的连接运行时状态变化通过 `connection-runtime-changed` Workbench Domain Event 通知 React，并由 `list_connection_runtime_snapshots` 只读 IPC 恢复。该通知链路不是 Backend Bridge 或 AI Runtime EventBus 的扩展。

Backend Tool 仍经过 Runtime Tool Core 的 `execute`。Core 注入一次性 `proceed()` 承担同名 Bridge operation 调用，Backend Tool 必须原样返回该次调用经过 `outputSchema` 校验并冻结的结果。该切面允许未来加入不复制 Core/Rust 职责的轻量前后检查；当前七个只读 Tool 和 `connection.open` 均使用默认透传实现。

V1 非目标：

- 多 Backend client；
- 跨版本协议协商；
- WebSocket 动态注册 Tool/Namespace；
- challenge-response、TLS 或持久 credential；
- chunk/progress/cancel frame；
- 自动重试、重放和跨连接恢复；
- 通用 Tauri command proxy；
- 任意 SQL/Action dispatcher。已注册的 `sql.execute` 是具备 Permission、strong confirmation、prepared plan、三态分析和专用 DTO/Handler 的固定 Tool/operation，不开放通用 Gateway proxy。
