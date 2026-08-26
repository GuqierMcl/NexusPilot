# AI Runtime 实时事件总线与 Scoped SSE 设计

日期：2026-06-23

状态：已落地；2026-07-21 增补通信通道职责边界。

相关文档：

- [Runtime domain](./domain.md)
- [Runner Core](./runner-core.md)
- [Agent Definition](./agent-definition.md)
- [Communication boundaries](./communication-boundaries.md)

## 决策摘要

`ai-runtime` 实现 live-only Global EventBus 与 scoped SSE API。

EventBus 是失效通知与 UI 协调通道，不是恢复通道，不是第二套事件存储，也不是 Runtime 状态的事实来源。

EventBus/SSE 的消费者边界是 AI Runtime -> Frontend。它不是 Rust/Tauri Backend Bridge，不承载后端 command/response、ready、heartbeat 或重连状态，也不把 WebSocket Frame 自动转成前端事件。三条通信通道的正式边界见 [communication-boundaries.md](./communication-boundaries.md)。

事实来源仍然是：

- Runtime Store / EventLog：用于持久化事实、历史、审计、统计和重启恢复。
- History / Snapshot Read API：用于在启动、刷新、重连或错过事件后读取当前事实。
- AI SDK-compatible stream：用于当前前台 assistant message 的实时渲染。

该通道不实现 durable replay 或 cursor recovery，也不为 SSE replay 引入 SQLite migration。

## Accepted constraints

以下约束长期适用：

- 采用 live-only 方案，不围绕可靠事件恢复设计 Phase 5。
- 不为了 SSE cursor replay 新增 SQLite migration。
- 不在 Phase 5 公开 `cursor` 查询参数。
- 错过 EventBus 事件是可接受的，因为客户端可以通过 Snapshot Read API 获取最新事实。
- 会话标题变更、会话状态变更、前端 UI 控制等事件不需要保证恢复。
- 当前不强制区分事件类型。可以在设计讨论中使用“失效通知”“UI 协调”等词帮助理解，但 Phase 5 不把事件类型拆成强约束 taxonomy，避免后续实现被过早分类束缚。

## 核心哲学

Runtime 状态一致性来自 snapshot，而不是来自客户端完整消费每一条 SSE event。

前端应该把 EventBus 通知理解成“某些事实可能已经变化”的信号。若客户端错过事件，下次读取 snapshot 仍然可以得到最新事实。

推荐前端心智：

```text
App boot:
  先读取 snapshot
  再订阅 live events

Reconnect:
  可按需重新读取当前可见 snapshot
  再重新订阅 live events

收到重要 live event:
  将 event 视为失效通知
  UI 需要精确状态时再读取最新 snapshot
```

错误心智：

```text
frontend state = initial state + every SSE event applied perfectly
```

该模型被明确拒绝。Phase 5 不保证断线、刷新、进程重启或订阅尚未建立期间的事件可补偿。

## 现有基础

当前 `ai-runtime` 已具备：

- `POST /v1/runs`：创建并执行前台 Runtime Run，返回 AI SDK-compatible stream。
- Runtime Store：持久化 conversation、run、message、part、tool call、permission、event、trace。
- `runtime_events`：保存 durable semantic Runtime Event。
- History / Snapshot API 与显式 conversation 创建接口：
  - `POST /v1/conversations`
  - `GET /v1/conversations`
  - `GET /v1/conversations/:conversationId`
  - `GET /v1/conversations/:conversationId/messages?format=runtime|ui|ai_sdk`
  - `GET /v1/conversations/:conversationId/runs`
  - `GET /v1/runs/:runId`
  - `GET /v1/runs/:runId/events`
  - `GET /v1/runs/:runId/traces`

Phase 5 基于这些事实补充实时通知能力，不替代上述接口。

## 范围

Phase 5 包含：

- 进程内 `RuntimeEventBus`。
- 稳定的 live event envelope。
- 内存订阅与 scope 过滤。
- `GET /v1/events` SSE endpoint。
- `conversation_id` / `run_id` query scope。
- SSE keepalive。
- subscriber disconnect cleanup。
- best-effort publish，不阻塞、不回滚 Runtime Store 写入。
- OpenAPI 文档说明 query 参数与 live-only 语义。
- 测试覆盖 publish、scope filter、SSE 输出、断开清理和 route 参数校验。

Phase 5 不包含：

- durable SSE replay。
- cursor continuation。
- `Last-Event-ID` 恢复。
- 为 event sequence 新增 SQLite migration。
- background run response mode。
- 前端 assistant-ui 接入。
- Rust / Tauri 订阅桥接。
- 跨进程 EventBus。
- event retention policy。
- token delta replay。
- 大型 artifact 或 query result streaming。
- 数据库业务工具。

## API 契约

Phase 5 暴露一个 SSE endpoint：

```text
GET /v1/events
GET /v1/events?conversation_id=<conversationId>
GET /v1/events?run_id=<runId>
```

规则：

- route 不使用 `/api` 前缀。
- query 参数使用 snake_case。
- `conversation_id` 和 `run_id` 在 Phase 5 互斥。
- 同时传入 `conversation_id` 和 `run_id` 返回 `422`。
- id 格式非法返回 `422`。
- Phase 5 不公开 `cursor` 参数。
- 请求中传入 `cursor` 返回 `422`，避免调用方误以为该 endpoint 支持 replay。
- Phase 5 不把 `Last-Event-ID` 当作 replay cursor。
- Vite loopback 与 Tauri desktop origin 可以跨域订阅；其他网页 origin 不返回 CORS allow-origin。
- 携带 Runtime access token 的浏览器请求会触发预检，`OPTIONS` 不要求 token，并显式允许 `Authorization`、`Accept`、`Cache-Control` 和 `Content-Type` 请求头。
- 由于响应允许 credentials，`Access-Control-Allow-Headers` 不使用 `*`，避免 WebView 拒绝带 `Authorization` 的 EventBus 订阅。

响应类型为：

```text
text/event-stream
```

## SSE 交付语义

交付语义为 live-only best-effort：

- subscriber 只接收订阅建立之后发布的事件。
- 断线期间错过的事件不 replay。
- Runtime 进程重启会丢失内存 subscriber。
- EventBus 失败不应导致 Runtime Run 失败，也不应回滚 Store 写入。
- 慢 subscriber 或断开的 subscriber 不能阻塞 Runner 执行。
- 客户端需要精确当前状态时必须调用 Snapshot Read API。

SSE 连接可以发送 keepalive comment 或轻量 ping event，帮助客户端和代理判断连接仍然存活。

推荐 keepalive comment：

```text
: keepalive
```

如果实现更适合 named event，也可以使用：

```text
event: runtime.keepalive
data: {"time":1234567890}
```

具体 wire shape 可以在实现计划中决定，但 keepalive 不能成为持久化 Runtime fact。

## Event Envelope

Phase 5 使用稳定 envelope，方便 route、测试和未来前端代码共享心智。

推荐结构：

```ts
interface RuntimeEventEnvelope {
  id: string;
  type: string;
  scope: RuntimeEventScope;
  occurred_at: number;
  version: 1;
  payload: Record<string, unknown>;
}

type RuntimeEventScope =
  | { kind: "global" }
  | { kind: "conversation"; conversation_id: string }
  | { kind: "run"; conversation_id?: string; run_id: string };
```

字段语义：

- `id`：稳定事件 id，用于调试、短期去重和 trace 关联。它不是 recovery cursor。
- `type`：事件类型字符串。Phase 5 不强制事件类型分类。
- `scope`：用于订阅过滤的范围元数据。
- `occurred_at`：事件发生时间，毫秒时间戳。
- `version`：payload schema 版本。
- `payload`：轻量事件详情或稳定引用。

Envelope 应保持小体积。大型正文、网页内容、query result、artifact body 应放在 Store、artifact 或后续 blob storage 中，不进入 SSE payload。

## 事件类型策略

Phase 5 不引入强约束事件类型 taxonomy。

事件类型保持普通字符串。实现可以发布当前 Runtime 已有事件，例如：

```text
conversation.created
conversation.updated
conversation.status
message.updated
message.removed
message.part.updated
run.updated
tool.updated
permission.updated
permission.replied
runtime.error
```

后续也可以发布 UI 协调信号，例如：

```text
toast.requested
panel.scroll_to_bottom.requested
assistant.input.focus_requested
thread_list.refresh_requested
```

这些只是示例，不是 Phase 5 的封闭枚举。测试应验证 EventBus 能承载 typed string 与 payload，而不是预先穷举所有未来事件。

当用户改写某条历史用户消息并从该处继续时，Runtime 在 SQLite 裁剪事务成功后，为每一条被移除的消息发布 `message.removed`，并发布新 Run 的 `run.updated`；如果首条消息改写导致自动标题回退，也会发布 `conversation.updated`。这些 envelope 只用于让前端失效和协调，不能按 SSE payload 直接重建消息树；当前会话在非运行态通过 Snapshot API 对账。

当前阶段不把事件拆成 `domain`、`ui`、`control`、`invalidation` 等公开或内部强分类。只有当前端消费者出现明确需求时，再讨论是否引入分类；Rust/Tauri 后端能力通信已经明确使用独立 Backend WebSocket Bridge，不作为 EventBus 的消费者扩展方向。

## Scope 过滤

EventBus subscription 支持三种 scope：

```text
global
conversation
run
```

预期行为：

- global subscriber 接收所有发布事件。
- conversation subscriber 接收该 conversation 范围内的事件。
- run subscriber 接收该 run 范围内的事件。
- run-scoped event 在已知时可以携带 `conversation_id`，但 run 过滤以 `run_id` 为准。
- run-scoped event 也会被 global subscriber 接收。

Phase 5 保持过滤模型简单，不支持 compound filter、多个 id、通配符或运行时变更 subscription。

## Store 与 EventBus 的关系

推荐写入顺序：

```text
persist Runtime fact
append durable Runtime event when appropriate
publish live EventBus envelope
```

约束：

- Runtime Store 是权威事实来源。
- `runtime_events` 仍是 durable semantic EventLog。
- EventBus 不写 SQLite。
- EventBus publish 是 best-effort。
- EventBus publish 失败不回滚 Store 写入。
- SSE client 断开不影响 Runner 执行。
- Runner 不等待慢 subscriber。

这个边界保证 UI 订阅机制不会拖慢或破坏 Runtime 核心执行链路。

## 与 Snapshot Read API 的关系

Snapshot API 是恢复机制。

客户端收到 conversation 相关事件后，可以按需调用：

```text
GET /v1/conversations
GET /v1/conversations/:conversationId
```

客户端收到 message 相关事件后，可以按需调用：

```text
GET /v1/conversations/:conversationId/messages?format=ui
GET /v1/conversations/:conversationId/messages?format=ai_sdk
```

客户端收到 run 相关事件后，可以按需调用：

```text
GET /v1/runs/:runId
GET /v1/runs/:runId/events
GET /v1/runs/:runId/traces
```

如果客户端错过事件，下次相关 snapshot read 会纠正状态。

### 前端会话标题失效刷新

Workbench 新建 thread 在首条 Run 创建 Runtime conversation 后，当前 assistant-ui thread 仍可能使用 local id。前端保存 `/v1/runs` 响应头建立的 local thread -> Runtime conversation 映射；收到命中当前 conversation 的 `conversation.updated` 后，先重新读取 Conversation Snapshot，再把其中的标题通过 assistant-ui title stream 更新到当前 thread。SSE payload 只用于定位失效范围，不直接作为标题事实，也不调用 rename command。

### 前端后台系统通知

Workbench Agent 面板可以把当前前端会话已经创建的 Run 的 live event 投影为原生系统通知，但这不改变 EventBus 的交付语义：

- 完成通知由 `run.updated` 的 `completed` 状态触发，并先读取 Conversation / AI SDK Message Snapshot，以取得对话标题和当前 Run 的 assistant 回复预览；不直接使用 SSE payload 作为通知正文。
- 只有 NexusPilot 主窗口失焦且系统授权有效时发送。通知按 `runId` 与 Permission id 去重，不对 EventBus 重连、历史加载或应用离线期间错过的事件补发。
- `failed` 通知由用户偏好控制，`interrupted` 不提醒。未来 Permission lifecycle 发布 `permission.updated` 或 `permission.requested` 时，可复用该分发路径发送“需要你的审核”通知；通知本身不执行审批命令。
- 原生系统通知的总开关和授权入口属于“设置 → 通知”；Agent 面板的完成、预览和失败提醒仅属于“AI 偏好设置”。

这是一项 best-effort 前端桌面 UI 效果。Run、Message 和 Permission 的恢复与正确性仍只依赖 Runtime Store 和 Snapshot Read API。

## 与 AI SDK-compatible Stream 的关系

AI SDK-compatible stream 仍然是前台 assistant message 渲染通道。

EventBus / SSE 不承载：

- token delta
- reasoning delta
- 高频 tool input delta
- stdout / stderr chunk
- streaming assistant text

前台 `POST /v1/runs` response 可以同时触发 Runtime Store 更新和低频事件发布，但 assistant 文本实时渲染仍属于 AI SDK-compatible stream。

## 与 App Command 的关系

EventBus 不是命令通道。

它不能用于：

- 应用 SQL editor diff。
- 执行数据库操作。
- 审批 permission。
- 中断 run。
- 直接修改 Workbench 状态。
- 发送 Rust Gateway operation 或接收 Backend response。
- 承载 Backend Bridge ready、ping/pong、断线或重连控制。

命令必须通过明确 API 或 IPC 操作表达。EventBus 只通知“某件事发生了”，或请求 best-effort UI 协调。

## 错误处理

Route validation：

- 非法 `conversation_id` 返回 `422`。
- 非法 `run_id` 返回 `422`。
- 同时传入 `conversation_id` 和 `run_id` 返回 `422`。

Runtime behavior：

- 如果 Runtime EventBus 不可用，`GET /v1/events` 返回 `503`。
- subscriber 断开后的 cleanup 必须幂等。
- publish 时发现 subscriber 已关闭，应丢弃该 subscriber。
- publish 错误应按严重性记录 debug 或 warn 日志，但不应导致 Runtime 执行失败。

## OpenAPI 要求

OpenAPI 需要记录：

- `GET /v1/events`
- 可选 `conversation_id` query 参数。
- 可选 `run_id` query 参数。
- `conversation_id` 与 `run_id` 的互斥规则。
- response 为 `text/event-stream`。
- endpoint 是 live-only，不支持 replay 或 cursor recovery。

OpenAPI 不应记录 Phase 5 `cursor` 参数。

## 测试策略

Unit tests：

- EventBus 能发布给 global subscriber。
- EventBus 能按 `conversation_id` 过滤。
- EventBus 能按 `run_id` 过滤。
- EventBus unsubscribe 后不再投递。
- subscriber 关闭或变慢时 publish 不抛出。
- Envelope 的 `id`、`type`、`scope`、`payload` shape 稳定。

Route tests：

- `GET /v1/events` 能打开 SSE stream。
- 带受信任 Origin 的真实 SSE 响应包含 CORS header。
- 带 `Authorization` 请求头的 `/v1/events` 预检使用显式 allow-headers，不依赖 credential wildcard。
- publish 后 SSE stream 能输出 event。
- `conversation_id` scope 只接收匹配 conversation event。
- `run_id` scope 只接收匹配 run event。
- 同时传入 `conversation_id` 和 `run_id` 返回 `422`。
- 非法 id 返回 `422`。
- OpenAPI 记录 route 和 query 参数。
- 不引入 `/api` path。

Integration tests：

- Runtime 操作 append 低频 event 后能 publish EventBus envelope。
- EventBus publish failure 不影响 Store write。

Phase 5 测试不应断言 durable replay、cursor continuation 或 `Last-Event-ID` 恢复。

## 实现边界建议

具体实现细节应在执行计划中决定。推荐模块边界：

```text
ai-runtime/src/runtime/events/
  event-bus.ts
  event-envelope.ts

ai-runtime/src/routes/events.ts
```

`createApp()` 拥有一个进程内 `RuntimeEventBus` 实例，并将其传给 route 与 Runtime execution 相关依赖。

Route 测试需要确定性行为时，可以通过 `createApp()` 依赖注入 test EventBus。

## 非目标

Phase 5 不实现：

- durable event sequence。
- cursor replay。
- event retention。
- cross-process delivery。
- 前端 assistant panel wiring。
- Tauri IPC listener wiring。
- background run mode。
- 数据库业务工具。
- permission command API。
- diff application API。
- artifact / blob storage。
- Rust/Tauri Backend WebSocket Bridge 或其状态同步。

## 验收标准

Phase 5 完成条件：

- `GET /v1/events` 可以 streaming live EventBus envelope。
- scoped subscriptions 支持 global、conversation 和 run。
- endpoint 不暴露 cursor contract。
- 文档明确 missed events 是可接受的。
- Snapshot Read API 仍是恢复路径。
- 事件类型不被强制划入限制性 taxonomy。
- 不为 event replay 新增 SQLite migration。
- 不要求业务数据库工具把 Backend Frame 转发为前端 SSE 事件。
- 测试覆盖 EventBus 行为、route validation、SSE 格式、OpenAPI 参数和无 `/api` 前缀。
- EventBus 不承担 Backend Bridge command/response、ready、heartbeat 或重连。
