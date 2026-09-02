# AI Runtime 通信通道职责边界

> 状态：已确认目标边界。
>
> 当前实现：Frontend ↔ AI Runtime HTTP、`/health`、AI SDK-compatible stream、EventBus/SSE 与 `/v1/**` per-launch token 鉴权已落地；Rust/Tauri ↔ AI Runtime Backend WebSocket Bridge 的 transport、主动重连、Rust Gateway 静态 Dispatcher/Error Boundary、Core 到 Bridge 的 Backend Executor Adapter、七个只读 Backend Handler/Tool、可逆的 `connection.open`、内部 `sql.analyze` 与受控 `sql.execute` 也已落地。

本文固定 NexusPilot Frontend、AI Runtime 与 Rust/Tauri Host 之间三条 AI 通信通道的职责。它只定义通道所有权、可靠性和禁止混用的边界；Backend Bridge 的 Frame、Rust Gateway 与错误协议见 [backend-bridge.md](./backend-bridge.md)，工具协议见 [tool-namespace.md](./tool-namespace.md)。Rust/Tauri → React 的 Workbench Domain Event 是相邻的数据库工作台通道，不属于这三条 AI 通道。

相关文档：

- [Live EventBus and SSE](./live-eventbus-sse.md)
- [Sidecar lifecycle](./sidecar-lifecycle.md)
- [Runner Core](./runner-core.md)
- [Tool namespace](./tool-namespace.md)
- [Backend bridge](./backend-bridge.md)
- [Tool permission](./tool-permission.md)
- [Network request boundaries](../architecture/network-boundaries.md)

## 总览

~~~text
Frontend / WebView
  -> GET /health
       查询 AI Runtime 当前健康快照

  <- GET /v1/events (EventBus / SSE)
       接收 AI Runtime 的可丢弃 UI/失效通知

  <-> /v1/... and AI SDK-compatible stream
       上传/读取附件、创建 Run、读取 Snapshot、提交明确命令、渲染当前消息

Rust / Tauri Host
  <-> /v1/internal/backend-bridge (target WebSocket)
       Backend command/response、ready、heartbeat、重连

AI Runtime
  -> LLM Provider API
       持有 Provider credential 并执行模型调用

Rust / Tauri Host
  -> React Workbench Domain Event
       通知数据库 runtime 事实已变化；由 Runtime Snapshot IPC 恢复
~~~

## 三条通道

| 通道 | 通信双方 | 职责 | 可靠性与恢复 |
|---|---|---|---|
| EventBus / SSE | AI Runtime -> Frontend | 会话标题更新、列表失效、用户提示和其他实时 UI 协调 | live-only、best-effort、允许丢失；最终状态由 Runtime Store 与 Snapshot Read API 恢复 |
| Backend WebSocket Bridge | Rust/Tauri <-> AI Runtime | Rust 后端能力的指令与响应交换，主要服务于 Backend ToolCall；同时承载 ready、heartbeat 和断线检测 | 长连接；Rust 主动发现和重连；断线立即失败当前 pending request，不由系统自动重试 |
| `/health` | Frontend -> AI Runtime | 查询 AI Runtime 进程健康与只读诊断，展示给用户并决定是否开放智能体入口 | 请求时快照；前端轮询或按需读取；不参与 Backend Bridge 建连和恢复 |

这三条通道按通信双方和职责划分，不因它们共享同一个 loopback host 或 Elysia 进程而合并语义。当前 Bearer token 保护 `/v1/**`（包括 EventBus/SSE）；`/health` 保持公开。未来 Backend Bridge 在 WebSocket Upgrade 前复用相同 token。

聊天附件同样走受认证的 Frontend ↔ AI Runtime HTTP 通道，但上传与 Run 是两个明确阶段：`/v1/attachment-uploads` 获取原始 bytes 并在 Runtime `dataDir` 建立最终 `att_*`；`/v1/runs` 只接收该 ID。附件内容端点仅供 NexusPilot UI 预览或下载，loopback URL 与 Bearer token 都不能进入 Provider 请求；AI Runtime 从本地 Blob Store 读取 bytes 后构造 AI SDK 标准 `file` part。

## 相邻通道：Workbench Domain Event

AI Runtime 通过 Bridge 发起数据库操作后，Rust 仍在同一个 `ConnectionRuntimeManager` 中提交状态。若连接被打开、断开或 health/capability 变化，Rust 通过 Tauri Workbench Domain Event 主动通知 React；Frontend 再更新 `connectionSessionStore`、相关 Query cache 和 Explorer 投影。

该通道遵循“事件通知 + Snapshot 恢复”：

- Domain Event 是低延迟通知，可以丢失，不是第二份状态；
- Rust 提供只读 Runtime Snapshot IPC，供 Frontend 启动、监听重建和恢复时对账；
- Frontend 不因操作来源是 AI 就维护另一套 session；
- Domain Event 不承载 Gateway request/response，也不转发 WebSocket Frame；
- AI Runtime EventBus/SSE 继续只属于 AI Runtime → Frontend 的会话与 UI 通知；
- 后端连接状态与“让界面选中/展开某节点”的 UI 协调意图分开建模。

因此，当前文档的“三条通道”仍指 AI Runtime 相关通道；Workbench Domain Event 是数据库工作台 Tauri IPC 边界的反向通知能力。当前已经实现 `connection-runtime-changed` Event 与 `list_connection_runtime_snapshots` 恢复 IPC。

## EventBus / SSE

EventBus 是 AI Runtime 面向 Frontend 的单向 live notification 通道。

允许承载：

- conversation title 或 status 已变化的失效通知；
- thread list、message、run snapshot 需要重新读取的提示；
- toast、focus、scroll 等 best-effort UI 协调；
- 其他即使丢失也不影响最终正确性的轻量通知。

明确不承载：

- Rust Gateway command 或 response；
- Backend Bridge ready、ping、pong、重连和 pending request 状态；
- Permission approve/deny、Run interrupt 或其他业务命令；
- token/reasoning delta、大型 Tool result 或数据库查询结果；
- 任何只能依赖事件完整送达才能保持正确的事实。

EventBus 不提供 durable replay、cursor recovery 或跨进程消息总线语义。通知丢失后，Frontend 通过 Snapshot Read API 或下一次正常列表查询获得最新事实。

### 智能体后台系统通知

Frontend 在 NexusPilot 主窗口失焦时，可将当前前端会话已发起 Run 的状态变化投影为系统原生通知。它是单纯的桌面 UI 效果，不是新的 AI Runtime command、Tauri IPC 契约或 EventBus 可靠性要求：

- `run.updated` 变为 `completed` 时，Frontend 先通过 Conversation / Message Snapshot 读取对话标题和该 Run 的 assistant 回复，再通知用户；通知标题只使用对话标题，正文可由用户设置为回复前 80 个字符或通用完成提示。
- `run.updated` 变为 `failed` 时，只有用户明确开启失败提醒才通知；用户主动 `interrupted` 不发送通知。
- `permission.updated` / `permission.requested` 可沿用同一套去重与通知分发路径；Permission Runtime 生命周期已经落地，但审批仍通过 `/continue` command 提交，EventBus 只承担失效通知。
- 每个 `runId` 的完成、失败和每个 Permission 请求都在前端会话内去重；只处理该窗口已经登记的 Run，避免历史恢复、其他会话或 EventBus 重连产生重复提醒。
- 系统通知仅在已获得操作系统授权且窗口失焦时发送。EventBus 断线或应用退出期间错过的通知不补发；后续 Snapshot 仍用于恢复 UI 事实。
- “设置 → 通知”提供跨模块共享的系统通知总开关与操作系统授权入口；“AI 偏好设置”只管理智能体的完成、回复预览和失败提醒规则。后续模块复用前者，不应把全局授权或总开关复制到各自偏好页。

因此 EventBus 仍只负责最佳努力的实时信号，通知正文和最终 Run / Message 状态始终以 Snapshot 为准。

## Backend WebSocket Bridge

Backend Bridge 是 Rust/Tauri Host 与 AI Runtime 的内部双向长连接。它不是前端 API，也不是 EventBus 的传输层。

目标职责：

- AI Runtime 向 Rust Gateway 发起受控 Backend operation；
- Rust 返回结构化 result 或 error；
- 完成 `runtime.ready/backend.ready`；
- 执行应用层 ping/pong、断线检测和 Rust 主动重连；
- 在绝大多数 Backend ToolCall 中提供执行通道。

边界：

- Frontend 不连接、不代理、不转发 Backend Bridge；
- Rust/Tauri 不通过 EventBus/SSE 发现 AI Runtime 或恢复 Bridge；
- Backend Bridge 不动态注册 Namespace 或 Tool；
- Runtime-local Tool，例如 `web.fetch`，不经过 Bridge；
- Bridge 只提供后端执行能力，AI Runtime Core 继续拥有 Tool Snapshot、Risk、Permission、limit、ToolCall 持久化和最终 dispatch；
- WebSocket Frame 不自动投影成前端 EventBus Event。

Bridge 断线时，AI Runtime 立即把正在等待的 Backend ToolCall 收敛为结构化“后端连接已断开”错误。第一版不在系统层自动重放或重试该 operation，由智能体根据工具结果决定是否再次调用。

Backend Bridge 使用自己的 endpoint 信息、ready、heartbeat 和重连状态机。`/health` 是否被 Frontend 调用、EventBus subscriber 是否在线，都不能影响 Rust 的建连或重连。

## `/health`

`GET /health` 是 Frontend 面向 AI Runtime 的进程级状态查询，不进入 `/v1`。

它用于：

- 判断 AI Runtime 是否已经启动并可以接受前端请求；
- 展示 Runtime version 和健康状态；
- 展示附件子系统的只读 `attachments.status` 与脱敏 diagnostics warnings；单个 corrupt/orphan、过期上传或待重试 GC 只产生 warning，不把 Runtime 全局状态改为不可用；
- 决定是否开放 Frontend 的智能体入口；
- 按需展示 AI Runtime 当前观察到的只读诊断。

它不用于：

- Rust/Tauri 发现或连接 Backend Bridge；
- 驱动 WebSocket heartbeat、断线检测或重连；
- 代替 Run、Conversation、ToolCall 或 Permission Snapshot；
- 代替 EventBus 的实时 UI 通知。

`backendBridge.state` 与 `attachments` 都只是 AI Runtime 对内部依赖的只读诊断。Frontend 是否开放智能体入口仍只取决于 AI Runtime 自身是否健康；Rust/Tauri 不读取这些字段，也不根据它们调整 Bridge 状态。附件 diagnostics warning 只帮助定位局部损坏或维护重试，不等同于全局 unhealthy。

正常状态和局部附件 warning 返回 HTTP 200 与全局 `status: "ok"`。Runtime DB 或附件根目录整体不可用时返回 HTTP 503、全局 `status: "unhealthy"`，并把 `attachments.status` 置为 `unavailable`；这一区分避免单个损坏附件关闭整个智能体入口，同时让致命本地存储故障不会被误报为健康。

## 事实来源与失败语义

| 问题 | 事实来源 / 恢复方式 |
|---|---|
| Conversation、Run、Message、ToolCall、Permission 当前事实 | Runtime Store 与 Snapshot Read API |
| 当前前台 assistant message 流式渲染 | AI SDK-compatible stream；历史仍从 Runtime Store 恢复 |
| Frontend 是否错过 EventBus 通知 | 不追踪；需要精确状态时重新读取 Snapshot |
| Backend Bridge 当前连接与 pending request | AI Runtime/Rust 各自的 Bridge 内存状态和 request map |
| AI Runtime 是否可供 Frontend 使用 | `GET /health` |
| 数据库连接和 Driver capability | Rust ConnectionRuntimeManager 与 DatabaseDriver |
| Frontend 展示的数据库 runtime 状态 | Rust Runtime Snapshot IPC；Workbench Domain Event 触发实时对账 |

任何一条通道失败，都只能按本通道的语义收敛：

- EventBus 断线不会中断 Run 或 Backend Bridge；
- Backend Bridge 断线不会把 AI Runtime 进程标记为 unhealthy，也不会阻止 Runtime-local Tool；
- Frontend `/health` 请求失败不会成为 Rust 重连信号；
- AI SDK stream 断线不会把 EventBus 或 WebSocket Bridge 变成消息历史恢复通道。

## 实现状态

当前仓库已经实现：

- Frontend 通过 Tauri endpoint discovery 获得 AI Runtime base URL；
- `GET /health`；
- `/v1/runs`、Snapshot Read API 与 AI SDK-compatible stream；
- 专用 Attachment Upload、元数据、受认证内容与删除 API，以及 `/v1/runs` 的最终 `attachment_id` 引用；
- live-only Global EventBus 与 `GET /v1/events`；
- Frontend EventBus 订阅和 Snapshot invalidation。

当前仓库已经实现 `/v1/internal/backend-bridge`、Rust Backend Bridge client、ready、heartbeat、request/response transport、断线收敛、主动重连、静态 Gateway dispatcher，以及 Runtime Tool Core 到 Bridge 的 Backend Executor Adapter。生产 Registry 已接入七个只读 Backend Tool、可逆的 `connection.open`、内部 `sql.analyze`、受控 `sql.execute`、五组 Redis prepare/execute operation 与 prepared-plan cleanup；它们只通过该通道交换 AI Runtime 意图与响应，不改变 EventBus/SSE 或 `/health` 的职责。`connection.open` 引起的共享数据库 runtime 变化仍通过相邻的 Workbench Domain Event 通知 React。

Workbench 域已经实现 L6.5-A/B：Tauri Command 通过共享 Application Service 使用同一个 `ConnectionRuntimeManager`，Rust 通过 Tauri Domain Event 向 React 投影 runtime 变化，React 通过只读 Snapshot IPC 在初始化和窗口重新聚焦时恢复。该链路不进入 AI Runtime EventBus 或 Backend Bridge。
