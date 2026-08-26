# AI Runtime Run Lifecycle 与 Interrupt 设计

日期：2026-06-28

状态：第一版已实现。

相关文档：

- [Runner Core](./runner-core.md)
- [Runtime domain](./domain.md)
- [Live EventBus and SSE](./live-eventbus-sse.md)
- [AI Runtime overview](./README.md)
- [Runner Core](./runner-core.md)

## 决策摘要

Phase 7.1 的 Run Lifecycle 稳定化采用 `interrupted` 作为第一版停止语义的 Runtime 终态。

用户点击停止、前端连接断开、Runtime 进程重启修复遗留运行、工具执行被运行时中止等场景，都属于“Run 没有自然完成，而是被打断”。因此目标领域模型不继续把用户停止称为 `cancelled`。`cancelled` 更强调“用户明确取消”，语义较窄；`interrupted` 更适合 NexusPilot 当前 foreground run、AI SDK stream、Runtime Store 和后续后台 run 的统一生命周期。

核心决策：

- Run 终态使用 `interrupted`，并保留结构化 interrupt reason。
- 前端“停止”是用户动作，Runtime API 使用 `interrupt` 语义。
- `abort` 只描述底层传输、AI SDK 调用或工具执行的中止机制，不作为 Runtime 事实状态名称。
- Run 是执行事实单元；Conversation 级 interrupt 只是便捷入口，内部必须解析到明确 `runId`。
- 前端不维护第二套 Run 事实状态；最终状态以 Runtime Store / Snapshot API 为准。
- 被 interrupted 的 assistant message 保留已经生成的部分输出，并在 UI 上展示 `interrupted` 语义标记。
- Run、Assistant Message、ToolCall 和 Conversation 状态必须一起收敛。
- 工具执行期间发生 interrupt 时，Runtime 对可中止工具执行 best-effort abort。
- 重启恢复时发现 stale running Run，应修复为 `interrupted`，而不是继续保留 `running`。
- Conversation 级 interrupt 在没有 active run 时返回幂等 no-op 结果，不制造用户可见错误。

当前实现已将目标领域状态、schema、migration、Runner、active run registry、command API、AI SDK abort signal、`web_fetch` abort signal、Snapshot projection 和前端 stop 入口迁移到 `interrupted` 语义。`cancelled` 仅保留在历史 migration 和前端旧快照兼容判断中。

## 术语边界

### Stop

`stop` 是前端用户界面的动作名称。用户点击停止按钮，是在表达“不要继续当前生成”。

`stop` 不应成为 Runtime 领域状态。它应被转化为 Runtime command：

```text
user clicks Stop
  -> interrupt active Run
```

### Interrupt

`interrupt` 是 Runtime command 和领域终态语义。它表达一次 Run 被打断，没有自然完成。

第一版公开用户路径主要使用：

```text
reason = user_stop
```

但领域模型必须保留扩展空间，支持未来区分：

- `user_stop`
- `client_disconnect`
- `runtime_shutdown`
- `runtime_recovered_stale_run`
- `tool_abort`
- `timeout`
- `unknown`

这些 reason 是可演进字段，不要求第一版全部公开给前端控制。

### Abort

`abort` 是实现机制，不是领域事实。

它可以出现在：

- AI SDK `streamText` 的 `abortSignal`。
- tool `execute` 的 `abortSignal`。
- fetch / web_fetch 的 request abort。
- HTTP stream 或 readable stream cleanup。

这些机制最终应收敛为 Runtime 的 `interrupted` 事实，而不是让前端或工具各自维护一套取消状态。

## 状态模型

### Run

目标 Run 状态集合：

```ts
type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";
```

`interrupted` 是终态。进入该状态后，这次 Run 不再继续模型生成、工具调用、权限等待或后续 step。

目标 interrupt metadata：

```ts
interface RunInterrupt {
  reason:
    | "user_stop"
    | "client_disconnect"
    | "runtime_shutdown"
    | "runtime_recovered_stale_run"
    | "tool_abort"
    | "timeout"
    | "unknown";
  message?: string;
  interruptedAt: string;
}
```

实现可以把该结构放在 Run 的 `error`、`finish`、`metadata` 或专门字段中，但读侧投影必须能稳定表达：这次 Run 是 `interrupted`，以及为什么被打断。

### Assistant Message

用户停止时，已经生成的 assistant 内容必须保留。

目标状态：

```text
AssistantMessage:
  status = incomplete
  reason = interrupted
```

或者使用等价的结构化状态表达。关键不是字段名，而是必须能区分：

- 正常完成的 assistant message。
- 模型或工具失败导致的 error message。
- 用户或 Runtime 打断导致的 incomplete / interrupted message。

UI 层应在消息末尾展示轻量 `interrupted` 语义标记，例如“已中断”或等价 badge。不要删除已经展示过的部分输出，也不要把半成品消息伪装为完整回答。

### ToolCall

ToolCall 也需要状态收敛，不能只依赖 Run 状态。

目标规则：

- 如果工具已经完成，保留 completed 结果。
- 如果工具正在执行且支持 abort，Runtime 传递 abort signal，工具 best-effort 中止。
- 如果工具因为 interrupt 被中止，ToolCall 标记为 `interrupted` 或等价 incomplete 状态。
- 如果工具本身失败，ToolCall 标记为 `failed`，Run 可根据上下文进入 `failed` 或 `interrupted`。
- 工具输出、大型网页正文、stdout/stderr chunk 仍不能逐条进入 SQLite EventLog。

第一版 `web_fetch` 应优先支持 abort signal，因为 AI SDK 会把 `streamText` 的 abort signal 传递给 tool execution。其他未来工具若无法及时中断，也必须保证 Run 终态不继续推进。

### Conversation

Conversation 不直接执行模型。它的状态反映当前会话是否有 active Run，以及最近一次 Run 的可见结果。

当 active Run 被 interrupted 后：

- Conversation 清除 active run 引用或进入 idle。
- Conversation 不允许继续显示 running。
- Conversation 列表可以展示该会话最近一次运行被中断，但该展示来自 snapshot，不来自前端本地猜测。
- 如果已有部分 assistant message，历史恢复应能看到该 interrupted message。

## API 契约

Phase 7.1 第一版已经提供两个 command endpoint。

### Run 级 Interrupt

核心入口：

```text
POST /v1/runs/:runId/interrupt
```

语义：

- 精确打断某一次 Run。
- 这是事实层 command。
- 所有 interrupt 最终都必须落到明确 `runId`。
- route 不使用 `/api` 前缀。
- 不通过 `Accept` header 区分行为。

请求体：

```json
{
  "reason": "user_stop",
  "client_request_id": "optional-idempotency-or-debug-id"
}
```

第一版 public client 的普通“停止生成”操作应发送或默认使用 `user_stop`。当用户确认关闭 NexusPilot 窗口时，前端应在销毁 sidecar 前优先发送 `client_disconnect`，以便 Runtime 正常收敛本次 Run；其他 reason 主要由 Runtime 内部修复或系统策略产生，不需要全部开放给前端选择。

响应体：

```json
{
  "run_id": "run_xxx",
  "conversation_id": "conv_xxx",
  "status": "interrupted",
  "interrupted": true,
  "interrupt": {
    "reason": "user_stop",
    "interrupted_at": "2026-06-28T12:00:00.000Z"
  }
}
```

幂等规则：

- `queued` / `running` Run：执行 interrupt，返回 interrupted snapshot。
- 已经 `interrupted`：返回当前 interrupted snapshot，不重复写入不可控副作用。
- 已经 `completed` / `failed`：不改变事实，返回当前 snapshot，并带上 `interrupted: false` 或等价 no-op 信息。
- `runId` 不存在：返回 404。

这样前端重复点击停止、EventBus 延迟、会话列表和当前聊天窗口同时发起停止，都不会产生用户可见的错误抖动。

### Conversation 级 Active Run Interrupt

便捷入口：

```text
POST /v1/conversations/:conversationId/interrupt-active-run
```

语义：

- 服务会话列表、状态栏或非当前聊天窗口中的“停止正在运行的会话”。
- 它不是底层事实模型；内部必须先解析 active `runId`，再执行 Run 级 interrupt。
- 如果没有 active run，返回 200 no-op。

建议 no-op 响应：

```json
{
  "conversation_id": "conv_xxx",
  "run_id": null,
  "interrupted": false,
  "reason": "no_active_run"
}
```

该接口的好处是前端在历史会话列表中不需要先额外查询 run detail 才能表达用户意图；坏处是 Runtime 必须严格维护 active run 定义。这个坏处可以通过“内部最终解析到 runId”的原则控制住。

## 前端交互边界

前端停止按钮采用 Runtime-first 语义：

```text
用户点击停止
  -> 调用 Runtime interrupt command
  -> 等待 Runtime stream / snapshot / EventBus 收敛
  -> UI 展示 interrupted 状态
```

前端不得自行写入这些事实：

- `Run.status = interrupted`
- `AssistantMessage.status = incomplete`
- `ToolCall.status = interrupted`
- `Conversation.status = idle`

这些必须来自 AI Runtime。

如果实现上需要关闭当前 HTTP stream、释放 reader、停止 spinner 或清理 assistant-ui transport，那只是传输清理和临时 UI pending 状态，不是第二套事实来源。文档和代码命名应避免让本地 abort 看起来等价于 Runtime interrupt。

### 当前聊天窗口

当前聊天窗口通常能从 `/v1/runs` 响应头、stream metadata 或 Runtime adapter 状态拿到当前 `runId`。有 `runId` 时，应调用：

```text
POST /v1/runs/:runId/interrupt
```

如果极端情况下 `runId` 尚不可用，前端可以暂时展示“正在停止”的 pending UI，但最终仍应通过 Snapshot API 重新对齐事实。不要在没有 `runId` 的情况下伪造 interrupted message。

### 会话列表

会话列表可能只有 `conversationId` 和 conversation status。它应调用：

```text
POST /v1/conversations/:conversationId/interrupt-active-run
```

接口返回 no-op 时，前端刷新 conversation snapshot 即可，不应弹出错误。

## AI SDK 执行约束

Phase 7.1 实现时必须遵循当前 AI SDK 文档，而不是依赖记忆。

已确认的设计前提：

- AI SDK `streamText` 支持 `abortSignal` 作为调用设置。
- `streamText` 的 abort signal 会传递给 tool `execute`，工具可以把 signal 继续传给 fetch 或其他可中止操作。
- abort 与 resumable stream 是冲突方向；NexusPilot 当前阶段不做 resumable stream，因此可以优先采用 interrupt/abort 路径。
- 使用 `toUIMessageStreamResponse` 时，需要特别验证 abort handling 与 `onEnd` 行为；实现阶段应按 AI SDK 文档要求使用 `consumeSseStream` 等机制，确保 abort 事件能被捕获和收敛。

目标执行模型：

```text
POST /v1/runs
  -> 创建 Run / User Message / Assistant Message
  -> ActiveRunManager 注册 AbortController
  -> streamText({ abortSignal })
  -> AI SDK-compatible stream 输出 live UI
  -> tool execute 接收 abortSignal
  -> interrupt command 调用 controller.abort()
  -> Runner 收敛 Run / Message / ToolCall / Conversation
  -> Store 写入 durable facts
  -> EventBus 发布 live-only invalidation
```

第一版实现使用 `ActiveRunRegistry` 维护进程内 active run 控制句柄，并通过 Store-level interrupt finalizer 兜底处理没有活跃内存句柄但 Store 中仍处于 active 状态的 Run。Runtime 启动时会修复 stale active Run 为 `interrupted`。

## Store、EventLog 与 EventBus

Runtime Store / EventLog 仍是事实来源。SSE / EventBus 只是 live-only 通知。

Interrupt 收敛时应产生低频语义事实，例如：

- Run 状态变为 `interrupted`。
- Assistant Message 标记为 incomplete / interrupted。
- 仍在执行的 ToolCall 标记为 interrupted 或 failed。
- Conversation 清理 active run，回到 idle 或等价状态。
- TraceEvent 记录 interrupt reason、来源和时间。

EventLog 可以记录 durable semantic event，例如：

- `run.interrupted`
- `message.updated`
- `tool.updated`
- `conversation.updated`
- `trace.recorded`

这些名称是设计建议，不是 Phase 5 那种限制性 taxonomy。实现时可以沿用当前事件 envelope 字符串策略，但必须保证事件语义不是 token delta，也不是 UI pulse。

EventBus 发布顺序仍遵循：

```text
persist Runtime facts
append durable event when appropriate
publish live EventBus envelope
```

EventBus 失败不能回滚 interrupt 已经写入的 Store 事实。

## 重启恢复

Runtime 启动或 Store repair 阶段如果发现历史遗留的 `running` Run，说明上一次进程没有自然完成该 Run。当前阶段不做后台 run 恢复，也不做 resumable stream，因此不能继续保留 `running`。

目标修复策略：

```text
running stale Run
  -> status = interrupted
  -> reason = runtime_recovered_stale_run
```

如果 Runtime 能明确判断是 shutdown 过程主动中断，也可以使用：

```text
reason = runtime_shutdown
```

修复后：

- Conversation 不再显示 running。
- 关联 assistant message 若未完成，标记为 incomplete / interrupted。
- 运行中的 tool call 标记为 interrupted 或 failed。
- 写入 trace，方便调试。

这个修复过程是恢复事实，不是 SSE replay。前端重启后仍通过 Snapshot Read API 读取最新状态。

## UI 展示原则

Interrupted UI 的目标是轻量、诚实、可恢复。

规则：

- 保留已经生成的 assistant 部分输出。
- 在消息末尾展示 `interrupted` 语义标记。
- 不删除半成品消息。
- 不把 interrupted 消息渲染成 completed。
- 历史恢复后也能看到同样的 interrupted 标记。
- ToolCall 被中断时，工具卡片展示中断状态，而不是一直 pending。
- 会话列表的 running 状态以 Runtime snapshot 为准，interrupt 后刷新 snapshot。

文案可以后续在前端实现阶段决定，但语义上应使用“中断”而不是“取消”。英文内部字段优先使用 `interrupted` / `interrupt`。

## 非目标

Phase 7.1 Run Lifecycle Interrupt 不实现：

- resumable stream。
- durable SSE replay。
- 后台 run 继续执行并稍后恢复 streaming。
- 多 active run 并发调度。
- 权限审批 interrupt 的完整业务流程。
- SQL diff apply。
- Workbench 数据库业务工具 interrupt。
- 前端伪造 Runtime 状态。

这些能力可以在后续阶段基于同一 Run lifecycle 扩展，但不能混进第一版 interrupt 基础设施。

## 验收标准

设计落地实现后应满足：

- 当前聊天窗口停止按钮能通过 Runtime command 打断当前 Run。
- 会话列表能通过 conversation 级便捷接口打断 active Run。
- 所有 interrupt 最终都能追溯到明确 `runId`。
- Run 终态为 `interrupted`，并保存 reason。
- Assistant Message 保留部分输出，并在 UI 上显示 interrupted 标记。
- ToolCall 在工具执行期间被打断后有明确终态，不无限 pending。
- Conversation 不再悬挂在 running。
- 重复 interrupt 请求幂等，不制造错误 toast。
- 没有 active run 的 conversation 级 interrupt 返回 200 no-op。
- Runtime 重启后 stale running Run 会修复为 interrupted。
- EventBus 只发布 live-only invalidation，不承担恢复。
- Snapshot Read API 可以恢复 interrupted message UI。
- AI SDK abort signal 被传递到模型调用和支持 abort 的 Runtime-local tools。
- 不把 token delta、reasoning delta 或工具高频 chunk 写入 SQLite EventLog。
