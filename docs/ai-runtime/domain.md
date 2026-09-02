# Bun AI Runtime 核心领域模型与持久化

本文描述 `ai-runtime/` 当前已经落地的 AI Runtime 核心领域契约与 SQLite 基础设施。这里的“该层”指领域模型、schema、store 和 projection 层；它负责 Runtime 自身的对话、运行、消息、part、工具调用记录、权限记录、事件和 trace 的结构化表达与持久化。模型调用、工具执行和 HTTP transport 位于相邻 Runtime runner / route 模块中，Rust IPC 仍不属于 `ai-runtime`。

Runtime Runner Core 的设计原则、stream 边界、事实来源和全局事件总线原则见 [runner-core.md](./runner-core.md)。本文只描述已经落地的领域、策略和持久化事实。

Tool Namespace、Backend Bridge 与 Runtime Permission 的权威目标分别见 [tool-namespace.md](./tool-namespace.md)、[backend-bridge.md](./backend-bridge.md) 和 [tool-permission.md](./tool-permission.md)。当前 Tool Namespace/Core、Backend Bridge、Rust Gateway、Backend executor、七个只读 Backend Tool、可逆的 `connection.open`、完整 Permission continuation、一次性 prepared plan、受控 `sql.execute` 与五个 Redis 单 Key mutation Tool 已实现。Snapshot 可见性仍不代表具体 ToolCall 已获授权；所有动态写入 ToolCall 都必须经过动态风险、Permission 和 exact prepared plan。

## 当前实现范围

已实现模块：

```text
ai-runtime/src/runtime/
├── core/
│   ├── ids.ts                 # prefixed runtime id helpers
│   ├── types.ts               # Conversation / Run / Message / Part / ToolCall / Permission / Event / TraceEvent
│   ├── schemas.ts             # persisted runtime record validation
│   ├── message-accumulator.ts # text part accumulation helper
│   ├── event-classifier.ts    # event classification helpers
│   └── usage.ts               # AI SDK usage normalization
├── store/
│   └── sqlite-store.ts        # SQLite-backed runtime store
├── projection/
│   └── ui-projection.ts       # assistant-ui / AI SDK friendly projection helpers
├── agents/
│   ├── agent-definition.ts    # built-in ask / query / agent definitions
│   ├── agent-resolver.ts      # public agent intent -> execution policy
│   ├── prompt-assembler.ts    # structured system prompt assembly
│   ├── tool-policy.ts         # executable tool policy resolution
│   └── prompts/
│       ├── ask.ts             # Chinese ask system prompt
│       ├── query.ts           # Chinese query system prompt
│       └── agent.ts           # Chinese agent system prompt
├── runners/
│   ├── runner-types.ts        # Run request / execution policy contracts
│   ├── runner.ts              # Run lifecycle state machine
│   ├── run-interrupt.ts       # Store-level interrupt finalizer and stale active run repair
│   ├── active-run-registry.ts # process-local active run interrupt registry
│   └── text-runner.ts         # AI SDK streamText runner with Runtime tool callbacks
├── tools/
│   ├── index.ts               # default Runtime tool registry factory
│   ├── tool-registry.ts       # executable Runtime tool registry
│   ├── tool-adapter.ts        # Runtime tools -> AI SDK ToolSet adapter
│   ├── web-fetch.ts           # Runtime-local web.fetch executor
│   └── web-ping.ts            # Runtime-local web.ping executor
└── index.ts           # runtime barrel export

ai-runtime/src/storage/
├── runtime-database.ts          # opens ai-runtime.sqlite3 and delegates migrations
├── runtime-migration-manager.ts # versioned migration orchestration
└── runtime-migrations.ts        # ordered runtime SQLite migrations
```

`resolveRuntimeConfig()` 分别解析用户数据目录与可重建缓存目录，并派生：

- `catalogPath = <cacheDir>/catalog.json`
- `providersPath = <dataDir>/providers.json`
- `runtimeSettingsPath = <dataDir>/runtime-settings.json`
- `runtimeDbPath = <dataDir>/ai-runtime.sqlite3`

`dataDir` 来自 `--data-dir` 或 `NEXUS_PILOT_DATA_DIR`；`cacheDir` 来自 `--cache-dir` 或 `NEXUS_PILOT_CACHE_DIR`，两者都以命令行参数优先。缺少 cacheDir 时 catalog 不会回退到 dataDir；旧数据目录中的 catalog 缓存不读取或迁移。

`createApp()` 在 `runtimeDbPath` 存在时会打开并迁移 runtime SQLite 数据库，然后创建 `RuntimeSqliteStore` 并通过 Elysia decorator 暴露为 `runtimeStore`。`createApp()` 自己打开的数据库句柄会绑定到 Elysia `onStop` 生命周期中关闭；外部通过依赖注入传入的 `runtimeDatabase` 仍由调用方负责关闭。启动时若 Store 中存在 stale active Run，Runtime 会将其修复为 `interrupted`，reason 为 `runtime_recovered_stale_run`。

当前 `POST /v1/runs` 会写入 Conversation、Run、Message、Part 和不可变 Run Tool Snapshot；`agent_mode: "ask"`、`"query"` 与 `"agent"` 通过稀疏 Namespace policy 独立解析工具可见性与 execution ceiling。Ask 不暴露数据库工具，Query 允许数据库只读工具与必要的可逆连接状态操作，Agent 允许完整数据库工具进入受控候选范围。`web.fetch` 与 `web.ping` 已接入 AI SDK 7 ToolLoopAgent 与 Runtime Tool Core；Snapshot 同时冻结 Runtime-owned network policy，Core 独占 ToolCall 持久化，AI SDK callback 只投影 ToolPart/SourcePart。Run stop/interrupt 已通过 `POST /v1/runs/:runId/interrupt` 和 `POST /v1/conversations/:conversationId/interrupt-active-run` 落地；前者是事实层 command，后者是会话列表等 UI 的便捷入口，内部最终仍收敛到明确 `runId`。

## 核心契约

领域模型使用短名：

- `Conversation`
- `Run`
- `Message`
- `Part`
- `ToolCall`
- `Permission`
- `Event`
- `TraceEvent`

不引入 OpenCode 的 `projectId` 等与 NexusPilot 当前定位不匹配的字段。当前 `Run` 以 `conversationId` 为边界，保存 `agentMode`、provider/model、input/output、usage/cost、finish/error、limits 和 runtime metadata。

当前 `Run` 使用 `agentMode` 记录本次执行的内置 agent 运行模式。第一版允许值为 `ask`、`query` 和 `agent`。历史实现中的 `profileId/profile_id` 与公开请求字段 `mode` 已迁移为 `agentMode/agent_mode`，不再作为目标代码字段或 OpenAPI 字段。

Run 终态包含 `completed`、`failed`、`interrupted`；历史 `cancelled` 占位语义已通过 migration 迁移为 `interrupted`。ToolCall 可收敛为 `interrupted`，用于用户停止、连接断开、工具 abort 或 Runtime 重启修复。Snapshot projection 会保留 interrupted assistant message 的部分输出，并提供 UI 可识别的 `metadata.nexus.status` 与 `metadata.nexus.interrupt` 标记。`format=ai_sdk` 同时会把同一份 NexusPilot metadata 镜像到 `metadata.custom.nexus`，因为 assistant-ui 规范化 message metadata 时只稳定保留 `custom` 命名空间。

`Message` 支持三类角色：

- `user`
- `assistant`
- `system`

`Part` 当前支持：

- `text`
- `reasoning`
- `file`
- `source`
- `tool`
- `step-start`
- `step-finish`
- `retry`
- `compaction`
- `diff`
- `error`

其中 `text` 与 `file` 已由当前 Run 使用；`tool` 和 `source` 已由 Runtime-local `web_fetch` 在工具完成边界生成。`FilePart` 只保存最终 `attachmentId`、不可变 `mediaType`、`filename` 与 `byteLength` 展示快照，不保存 bytes、URL、data URL、用户路径、Provider file ID 或 access token。AI SDK stream 中的 `text` / `reasoning` delta 会在 Runtime 内存中按 `start -> delta -> end` 生命周期聚合，并在完成或中断边界保存为多个独立 `TextPart` / `ReasoningPart`；Runtime 不逐条持久化 delta，但会保留 message parts 的相对顺序。即使 provider 在 `end` 后复用同一个 stream id，新的 `start` 也必须生成新的 Runtime part，避免历史恢复时丢失后续 reasoning UI。`diff` 等其余 Part 仍是领域模型能力，具体业务执行能力需要后续阶段接入。

## Diff 设计

`DiffPart` 内嵌 `DiffArtifact`，用于表达未来 SQL 编辑、文本编辑、JSON/Markdown 编辑等变更建议。`DiffTarget` 当前支持：

- `memory`：例如当前 SQL editor selection、尚未落盘的 SQL draft。
- `workspace_file`：未来可指向工作区文件。
- `business_object`：未来可指向系统业务对象。

`DiffArtifact` 包含 hunks 和 diff lines，因此既可以承载文件 diff，也可以承载内存中的 SQL diff。当前不会自动应用 diff，也不会调用前端或 Rust 修改 SQL 编辑器内容。

## SQLite 持久化

`openRuntimeDatabase(path)` 会：

1. 创建父目录。
2. 打开 `bun:sqlite` 数据库。
3. 启用 `PRAGMA foreign_keys = ON`。
4. 通过版本化 migration manager 执行未应用的 runtime migrations。

当前表：

- `runtime_conversations`
- `runtime_runs`
- `runtime_messages`
- `runtime_message_parts`
- `runtime_tool_calls`
- `runtime_permissions`
- `runtime_events`
- `runtime_traces`

### Runtime Migration Manager

Runtime SQLite schema 由 `runtime_schema_migrations` 表记录版本化迁移状态。每条 migration 使用稳定 id，例如 `0001_init_runtime_schema`，并记录：

- `id`
- `description`
- `checksum`
- `applied_at`

启动时 `runRuntimeMigrations()` 会按 id 顺序执行未应用 migration。已应用 migration 会校验 checksum；如果本地 migration SQL 被修改，Runtime 会报错而不是静默继续。每条 migration 在独立事务中执行，失败时不会写入 `runtime_schema_migrations`，并会回滚该 migration 内已经执行的 DDL/DML。每条 migration 成功应用后，Runtime 会写入一条 `runtime migration applied` info 日志，记录 migration id、description、checksum 和 appliedAt。

当前迁移策略允许破坏性更新。版本化 migration manager 不兼容已经由旧 inline schema 创建、但缺少 `runtime_schema_migrations` metadata 的本地 SQLite 文件；遇到这种开发期旧库时，应手动删除旧 `ai-runtime.sqlite3` 后重新启动。

当前已存在 migration：

- `0001_init_runtime_schema`：创建 Runtime 领域模型需要的 conversations、runs、messages、parts、tool calls、permissions、events 和 traces 表及索引。
- `0002_runtime_agent_mode_policy`：将运行模式字段迁移为 `agent_mode`，并为 Run 输入增加 prompt/tool policy snapshot。
- `0003_runtime_interrupted_status`：将历史 `cancelled` 占位状态迁移为 `interrupted`，同步修复 Run、Message、ToolPart 和 ToolCall 状态。

Phase 3 `web_fetch` 和 Phase 7.1 interrupt API 复用既有 `runtime_runs`、`runtime_messages`、`runtime_tool_calls` 与 `runtime_message_parts` 表；除 `cancelled -> interrupted` 数据迁移外，未新增表结构。后续若引入 artifact/blob store、tool output 大对象表或 Snapshot API 专用索引，必须追加新的 `RUNTIME_MIGRATIONS` 版本。

### Runtime Schema Evolution Rules

新增或修改任何 Runtime 数据模型时，必须同步更新 `ai-runtime/src/storage/runtime-migrations.ts` 中的 `RUNTIME_MIGRATIONS`。不能只修改 `runtime/core/types.ts`、`runtime/core/schemas.ts` 或 `runtime/store/sqlite-store.ts`。

迁移维护规则：

- 新增表、列、索引或约束时，追加新的 migration，例如 `0002_add_runtime_xxx`。
- 已发布的 migration SQL 不应被修改；否则已有数据库会因为 checksum mismatch 拒绝启动。
- migration id 必须保持递增排序，格式为 `0001_description`。
- 新 migration 应包含对应的 storage/database 测试，并验证 metadata、幂等重跑和失败回滚行为。

store 使用 JSON-backed 记录保存完整领域对象，同时保留 relational id、role/type/status、time 等索引字段，便于后续查询和 UI 投影。`RuntimeSqliteStore.close()` 是幂等的，用于释放 SQLite 句柄；应用自己打开的 runtime store 应通过应用生命周期统一清理。

### 改写用户消息并继续

`POST /v1/runs` 可携带已有会话的 `replace_from_message_id`，表达“改写此条用户消息并从此继续”。该字段只能指向会话中的用户消息，且会话不能有 active Run；助手消息重新生成不属于当前公开能力。

Store 会在一个 SQLite 事务中完成以下操作：

1. 移除目标用户消息及其后的 `runtime_messages` 和 message parts。
2. 移除由这些消息关联的 `runtime_runs`、tool calls、permissions，以及对应的 Run Event/Trace 记录。
3. 写入改写后的用户消息、正在运行的助手消息、新 Run、语义事件和 trace。
4. 事务成功后才向 live EventBus 发布 `message.removed`、必要的 `conversation.updated` 和 `run.updated`。

因此 Snapshot API 不会观察到“消息已删但新 Run 尚未写入”的中间状态。该操作只改写 Runtime 的当前会话事实，不撤销已经发生的外部工具副作用；例如数据库写入或网络请求仍需由相应业务能力单独处理。该能力不新增表、列或 migration。

## UI Projection 边界

`projectMessageToUiMessage()` 把内部 `Message` 映射为 assistant-ui / AI SDK 友好的 message-like shape：

- `text` part 直接投影为 text。
- `source` / `file` / `reasoning` / `tool-call` 保留结构化 part。
- `diff` part 当前投影为 markdown diff 文本 fallback，保证没有自定义 diff renderer 时默认 UI 仍能显示内容。

Projection 不应把多个 `reasoning` part 合并为一个全局文本字段。`format=ai_sdk` 必须按 Runtime Message 的 part 顺序输出多个 AI SDK `reasoning` part，让 assistant-ui 在完成态和重启恢复后仍能渲染每一个 reasoning block。Workbench 对连续的 `reasoning` 与 `tool` part 可以渲染为单一、可折叠的“执行过程”容器；最终 `text` 保持在该容器外，因此这项展示优化不能改变 part 的相对顺序或投影形状。长会话的前端可以按用户回合虚拟化消息 DOM，但必须仍以稳定 message id 和原始 part 顺序进行渲染，且不能改变 Snapshot 的投影内容。Runtime part metadata 可以保留 `aiSdkTextId`、`aiSdkReasoningId` 等来源标识，用于调试、投影对齐或后续更精细的 block 级能力。

该模块不依赖 React、不创建 assistant-ui runtime、不使用 `AssistantChatTransport`，也不直接实现 HTTP streaming。`POST /v1/runs` 的公开输入使用 `input.parts` 表达有序 `text | file` 用户消息，`file` 只接受最终 `attachment_id`；route 映射成内部 Part 后，Runner 与 Store 在提交边界建立消息引用。领域模型模块只负责内部事实与 UI-friendly projection 的边界，不承担 HTTP 请求兼容层。

附件持久化由 `runtime_attachment_uploads`、`runtime_blobs`、`runtime_attachments` 和 `runtime_message_attachments` 四张表承担。上传完成事务创建或复用内容寻址 Blob、创建逻辑 Attachment 并完成 UploadSession；`commitRunStart` 事务把 FilePart 与 Attachment 关系一并写入。History projection 使用 `nexuspilot-attachment:att_*` 恢复稳定身份，模型投影则直接读取本地 Blob bytes，二者不能混用。

## Snapshot Read API

`ai-runtime` 当前已经提供显式 conversation 创建与只读 History / Snapshot Read API，用于从 Runtime Store 恢复会话、消息历史、Run、Event 和 Trace：

```text
POST /v1/conversations
GET /v1/conversations
GET /v1/conversations/:conversationId
GET /v1/conversations/:conversationId/messages?format=runtime|ui|ai_sdk
GET /v1/conversations/:conversationId/runs
GET /v1/runs/:runId
GET /v1/runs/:runId/events
GET /v1/runs/:runId/traces
POST /v1/runs/:runId/interrupt
POST /v1/conversations/:conversationId/interrupt-active-run
```

当前前端 assistant-ui `RemoteThreadListAdapter.initialize()` 不再调用 `POST /v1/conversations`。新建未发送 thread 只保留在 assistant-ui 本地状态里，不写 Runtime Store；首条真实用户消息通过 `POST /v1/runs` 创建 conversation，并由响应头把 `conv_*` 反馈给前端连续对话映射。这避免了历史列表中出现没有消息、无法恢复实际 UI 的空 conversation。

`POST /v1/conversations` 仍保留为显式创建 idle conversation 的低层接口。它只写入 conversation 与 `conversation.created` event，不创建消息、Run 或模型调用，也不让前端控制 agent prompt、tools、limits 或系统行为；当前前端不把它作为新建聊天按钮或 thread 初始化的主路径。

`GET /v1/conversations` 面向历史恢复，只返回已有消息记录的 Runtime conversations。没有消息的显式空 conversation 仍可通过 detail endpoint 读取，但不会进入默认历史列表。

其余 Snapshot Read API 只读取 Runtime Store，不执行模型、不调用工具、不修改 Workbench 状态。`format=runtime` 返回 NexusPilot Runtime-native `Message[]`；`format=ui` 返回 NexusPilot 通用 UI-friendly projected message shape；`format=ai_sdk` 返回 AI SDK 7 `UIMessage` shape，用于 assistant-ui `useChatRuntime` 的历史恢复。Runtime-native Message、Part、Run、ToolCall、Event 和 Trace 仍然是事实模型，UI shape 只是读侧投影。`format=ai_sdk` 的 NexusPilot 扩展 metadata 以 `metadata.nexus` 暴露给原始 API 调试，同时以 `metadata.custom.nexus` 暴露给 assistant-ui message state。

interrupt command API 会修改 Runtime Store 中的 Run、Assistant Message、ToolCall 和 Conversation 事实，并发布 live-only EventBus invalidation。它们不是 Snapshot Read API，但恢复 UI 仍通过后续读取 Snapshot API 完成。

`format=ui` 不等同于 `format=ai_sdk`。前者可以服务 NexusPilot 自有 UI 展示，后者必须跟随 AI SDK 7 `UIMessage.parts` 契约，例如 `source-url`、`file` 和 `tool-*` part。

## 明确未实现

当前领域模型与持久化批次不包含：

- Rust / Tauri IPC 集成。
- 数据库 workbench 业务工具，如 `connect_profile`、`browse_table_data`。
- diff 应用、SQL editor 写入或业务对象修改。
- resumable stream、durable SSE replay 或后台 Run 恢复继续执行。
- conversation rename/archive/delete 等 mutation command。

这些能力必须在后续设计中通过 Runtime runner、tool registry、permission/audit、Snapshot Read API 和前端确认协议逐层接入，不能直接堆进 route、store 或 projection helper。
