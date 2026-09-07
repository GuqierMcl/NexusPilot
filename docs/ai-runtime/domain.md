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
│   ├── ui-projection.ts       # assistant-ui / AI SDK friendly projection helpers
│   ├── ai-sdk-projection.ts   # AI SDK 7 UIMessage snapshot projection
│   ├── history-projection.ts  # conversation history snapshot projection
│   └── model-history-projection.ts # raw Message -> AI SDK ModelMessage[] projection
├── agents/
│   ├── agent-definition.ts    # built-in ask / query / agent definitions
│   ├── agent-resolver.ts      # public agent intent -> execution policy
│   ├── prompt-assembler.ts    # structured system prompt assembly
│   └── prompts/
│       ├── ask.ts             # Chinese ask system prompt
│       ├── query.ts           # Chinese query system prompt
│       └── agent.ts           # Chinese agent system prompt
├── runners/
│   ├── runner-types.ts        # Run request / execution policy contracts
│   ├── runner.ts              # Run lifecycle state machine
│   ├── run-interrupt.ts       # Store-level interrupt finalizer and stale active run repair
│   ├── active-run-registry.ts # process-local active run interrupt registry
│   ├── run-continuation-registry.ts # process-local Run continuation conflict registry
│   ├── model-error.ts         # model execution error normalization and redaction
│   └── text-runner.ts         # AI SDK streamText runner with Runtime tool callbacks
├── tools/
│   ├── index.ts               # tools barrel export
│   ├── ai-sdk-adapter.ts      # Runtime tools -> AI SDK ToolSet adapter
│   ├── backend-bridge-executor.ts # Backend Tool -> authenticated backend bridge executor
│   ├── backend-read-contracts.ts # backend read/tool Zod contracts
│   ├── sql-contracts.ts       # sql.* Zod contracts
│   ├── key-value-contracts.ts # key_value.* Zod contracts
│   ├── web-fetch.ts           # Runtime-local web.fetch executor
│   ├── web-ping.ts            # Runtime-local web.ping executor
│   ├── contracts/             # tool context/result/risk/permission/prepared contracts
│   ├── core/                  # Runtime Tool Core + prepared invocation registry
│   ├── kernel/                # namespace, provider-name codec, runtime-tool-registry
│   ├── namespaces/            # connection/metadata/sql/table/key_value/system/web
│   └── resolution/            # executable tool policy resolution + per-Run tool snapshot
└── index.ts           # runtime barrel export

ai-runtime/src/runtime/context/
├── planner.ts               # deterministic active-lineage context plans
├── model-context-manager.ts # request preparation, replan and projection
├── compaction-service.ts    # single checkpoint generation/CAS seam
├── manual-compaction-service.ts # durable conversation operation, idempotency and cancellation
├── overflow-recovery.ts     # context-overflow single-retry recovery
├── boundary-validation.ts   # checkpoint coverage boundary validation
├── policy.ts                # compaction thresholds and budget policy
├── summary-prompt.ts        # checkpoint summary prompt construction
├── token-estimator.ts       # provider/model token estimation
├── safety-state.ts          # structured cross-branch effect projection
├── index.ts                 # context barrel export
└── types.ts                 # checkpoint, plan, budget, usage and claim contracts

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

当前 `POST /v1/runs` 会写入 Conversation、Run、Message、Part 和不可变 Run Tool Snapshot；`agent_mode: "ask"`、`"query"` 与 `"agent"` 通过稀疏 Namespace policy 独立解析工具可见性与 execution ceiling。Ask 不暴露数据库工具，Query 允许数据库只读工具与必要的可逆连接状态操作，Agent 允许完整数据库工具进入受控候选范围。`web.fetch` 与 `web.ping` 已接入 AI SDK 7 ToolLoopAgent 与 Runtime Tool Core；Snapshot 同时冻结 Runtime-owned network policy，Core 独占 ToolCall 持久化，AI SDK callback 只投影 ToolPart/SourcePart。Run stop/interrupt 已通过 `POST /v1/runs/:runId/interrupt` 和 `POST /v1/conversations/:conversationId/interrupt-active-run` 落地；前者是事实层 command，后者是会话列表等 UI 的便捷入口，内部最终仍收敛到明确 `runId`。Context Window Manager 在模型调用前创建 request-scoped `ContextPlan`/`ContextUsage`，并在需要时通过唯一 `ContextCompactionService` 追加 checkpoint；这些派生记录不替代 Run、Message 或工具审计事实。

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

不引入 OpenCode 的 `projectId` 等与 NexusPilot 当前定位不匹配的字段。当前 `Run` 以 `conversationId` 为边界，保存 `parentRunId`、可选 `supersedesRunId`、`agentMode`、provider/model、input/output、usage/cost、finish/error、limits 和 runtime metadata。Conversation 另保存 `activeHeadRunId` 与单调 `revision`：二者共同定义默认 active lineage 和 checkpoint 的并发控制边界。

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

其中 `text` 与 `file` 已由当前 Run 使用；`tool` 和 `source` 已由 Runtime-local `web_fetch` 在工具完成边界生成。`FilePart` 只保存最终 `attachmentId`、不可变 `mediaType`、`filename` 与 `byteLength` 展示快照，不保存 bytes、URL、data URL、用户路径、Provider file ID 或 access token。AI SDK stream 中的 `text` / `reasoning` delta 会在 Runtime 内存中按 `start -> delta -> end` 生命周期聚合，并在完成、失败或中断边界保存为多个独立 `TextPart` / `ReasoningPart`；Runtime 不逐条持久化 delta，但会保留 message parts 的相对顺序。即使 provider 在 `end` 后复用同一个 stream id，新的 `start` 也必须生成新的 Runtime part，避免历史恢复时丢失后续 reasoning UI。`step-start` 记录模型多步边界，使跨 Run model-history projector 能重建合法的 Assistant/tool message 序列。`diff` 等其余 Part 仍是领域模型能力，具体业务执行能力需要后续阶段接入。

TextPart、ReasoningPart 与 ToolPart 的 `metadata.providerMetadata` 保存 AI SDK 提供的 Provider 不透明 JSON；同一 Part 的后续 stream chunk 只有在实际携带 metadata 时才覆盖当前值。metadata 通过既有 JSON-backed Part 存储完成 SQLite round-trip，不需要新增表或迁移。该字段不进入普通 UI 或日志，只在历史 AssistantMessage 与目标 Run 的 `providerId/modelId` 完全相同时作为 AI SDK `providerOptions` 重放；不同模型会剥离旧 metadata，并把非空 reasoning 投影为普通 Assistant text。

ToolPart 同时保存两种工具身份：顶层 `toolName` 是 Runtime canonical ID，`metadata.providerToolName` 是该次 AI SDK 调用实际使用的 Provider tool name。前者用于 Tool Core、审计和 UI，后者用于后续模型历史中严格配对的 tool-call/tool-result。旧 ToolPart 缺少 `providerToolName` 时只回退既有 `toolName`，不迁移、不通过当前 registry 反推旧名称；新写入必须保留两者。

Runtime model-history projection 与 UI projection 是两个不同的读侧 adapter。前者向模型表达 User/System 文本、历史附件、Assistant text/reasoning、工具调用及其终态结果；后者服务 assistant-ui 展示。model-history projection 只读取 Store，不执行工具、不触发 Permission，也不把 Source、Diff、Retry、Compaction 或 UI/事件状态发送给模型。历史非终态工具只在该模型视图中 fail closed 为 interrupted error result，Store 事实不被改写。

模型执行失败的 `RuntimeError` 可以保留任意非空上游 error name，`data` 只包含原始 message 和上游实际提供的可选 `statusCode/isRetryable`。新写入不包含 stack、headers、request/response body 或完整 Provider 对象；Runtime 当前明确持有的完整 secret 若出现在 message 中，只做精确 `[REDACTED]` 替换。AI SDK full stream 的标准 error part 立即写入 failed Run 和 Assistant error，保留此前已经聚合的 text/reasoning/tool parts，并把未终态 ToolPart 与 ToolCall 收敛为 error；后续 finish 通知不能覆盖该终态。Run、Conversation 与 AssistantMessage 保存同一错误值，因此 Snapshot/重启恢复与 live SSE 使用相同正文。

AI SDK UIMessage Snapshot 把该状态投影到 `metadata.custom.nexus.status.error.data.message`，Workbench 从这一持久化字段恢复错误卡正文。每次模型失败只追加一条 `runtime.error` durable EventLog 记录；对应 EventBus envelope 是 best-effort live notification，不提供事件补偿，断线或刷新仍以 Snapshot 为准。

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

当前表（包含 append-only history 与 context-compaction 派生事实）：

- `runtime_conversations`
- `runtime_runs`
- `runtime_messages`
- `runtime_message_parts`
- `runtime_tool_calls`
- `runtime_permissions`
- `runtime_events`
- `runtime_traces`
- `runtime_context_checkpoints`
- `runtime_context_plans`
- `runtime_context_usage`
- `runtime_context_preparation_claims`
- `runtime_context_diagnostics`
- `runtime_context_compaction_activities`
- `runtime_manual_compactions`：独立手动压缩操作、幂等键、来源 head、分配的上下文请求槽位与可恢复生命周期；不创建合成 Run 或聊天消息。具体契约见 [composer-references.md](./composer-references.md)。

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
- `0004_runtime_run_tool_snapshot`：用不可变的 per-Run snapshot 替换旧 Tool policy snapshot。
- `0005_runtime_tool_permission_state`：用 Runtime-owned Tool Permission 状态、风险事实与 tool-call 绑定替换旧 permission 结构。
- `0006_runtime_tool_permission_confirmation`：为 Permission 持久化确认要求和面向用户的展示信息。
- `0007_runtime_chat_attachments`：增加 Runtime-owned attachment/blob、上传和 message-reference 表。
- `0008_runtime_run_dag`：回填线性 Run 的 parent/head/revision，并为从此版本起的 edit 建立 append-only DAG。
- `0009_runtime_context_compaction`：增加 checkpoint、plan、request-scoped ContextUsage 和可审计的 context 记录。
- `0010_runtime_tool_call_authorization_snapshot`、`0011_runtime_context_preparation_claims` 与 `0012_runtime_context_preparation_fencing`：补足 Safety State 所需事实、checkpoint CAS claim 与 fencing。
- `0013_runtime_context_diagnostics`：增加 append-only、脱敏且可去重的 checkpoint/CAS/启动完整性诊断。
- `0014_runtime_context_compaction_activities`：增加独立、可恢复并可按 request boundary 排序的压缩生命周期 Activity。
- `0015_runtime_manual_compactions`：增加独立手动压缩操作表，持久化 operation ID、幂等 request key、terminal head（run_id + request_index）身份、分配的上下文请求槽位与可恢复生命周期；不创建合成 Run 或聊天消息。

已发布 migration 不会重写旧 SQL。升级会把可证明的既有线性 history 回填为初始 DAG，但不会也不能恢复升级前旧版本已经物理删除的 edited tail；append-only 保证从 `0008_runtime_run_dag` 起生效。后续 schema 演进仍必须追加新的 `RUNTIME_MIGRATIONS` 版本。

### Runtime Schema Evolution Rules

新增或修改任何 Runtime 数据模型时，必须同步更新 `ai-runtime/src/storage/runtime-migrations.ts` 中的 `RUNTIME_MIGRATIONS`。不能只修改 `runtime/core/types.ts`、`runtime/core/schemas.ts` 或 `runtime/store/sqlite-store.ts`。

迁移维护规则：

- 新增表、列、索引或约束时，追加新的 migration，例如 `0002_add_runtime_xxx`。
- 已发布的 migration SQL 不应被修改；否则已有数据库会因为 checksum mismatch 拒绝启动。
- migration id 必须保持递增排序，格式为 `0001_description`。
- 新 migration 应包含对应的 storage/database 测试，并验证 metadata、幂等重跑和失败回滚行为。

store 使用 JSON-backed 记录保存完整领域对象，同时保留 relational id、role/type/status、time 等索引字段，便于后续查询和 UI 投影。`RuntimeSqliteStore.close()` 是幂等的，用于释放 SQLite 句柄；应用自己打开的 runtime store 应通过应用生命周期统一清理。

### Audit Transcript、Active Lineage 与改写用户消息

`POST /v1/runs` 可携带已有会话的 `replace_from_message_id`，表达“改写此条用户消息并从此继续”。该字段只能指向会话中的用户消息，且会话不能有 active Run；助手消息重新生成不属于当前公开能力。

Store 将所有已提交 Message、Run、ToolCall、Permission、Event、Trace 和 attachment reference 保存为 Audit Transcript。`listActiveLineageMessages(conversationId)` 只返回 `activeHeadRunId` 的祖先链，`listTranscriptMessages(conversationId)` 用于显式审计，`listLineageMessages(conversationId, headRunId)` 与 `listRunAlternatives(runId)` 支持指定 DAG 读取。默认 UI/history 和后续模型上下文使用 active lineage，绝不将 transcript 的时间排序当作当前对话。

Store 在一个 SQLite 事务中完成 edit：验证目标是 active lineage 中的 User Message 且 Conversation 不 busy；创建 replacement User/Assistant Message、Run、附件引用、语义事件和 trace；以 `parentRunId = targetRun.parentRunId`、`supersedesRunId = targetRun.id` 写入新 Run；再切换 `activeHeadRunId` 并递增 `revision`。目标 Run、其后代和所有关联事实不会删除，也不会安排 attachment GC；新 edit 不发 `message.removed`。这不会撤销既有外部副作用，且旧 Permission 永远只绑定其原始 ToolCall/Run。

历史 migration 前已经实际删除的旧尾部仍不可恢复。`message.removed` 保留为旧 Event 的读取兼容性，而非新 edit 的写入语义。

### Context checkpoint、Safety State 与 usage

`ContextCheckpoint` 是覆盖某个完整终态 Run 前缀，或当前 Run 某个完整 sealed model-step 前缀的版本化、append-only provider-neutral cache。`ContextCoverageCursor` 使用 `kind: "run"` 表达兼容的 Run 级 coverage，使用 `kind: "sealed_step"` 保存稳定的 `runId/throughRequestIndex/throughPartId`。checkpoint 还保存 `sourceHeadRunId`、`sourceConversationRevision`、稳定 `lineageHash`、可选 `parentCheckpointId`、format/compatibility、生成 Provider/model、budget、usage 与 trigger。它只能在 coverage 位于当前 head lineage、prefix hash 未变化、step/tool/Permission 全部安全封闭且格式兼容时使用；后续追加 parts 不改变已封闭 prefix 的 hash。较短分支或更大窗口会重新选择完整 raw active lineage，而不会把 checkpoint 当作历史替代品。`failed` Run 的正常终态可以保留已聚合的 Assistant/工具事实而没有 `Run.output`；只要 Assistant 已进入 error 终态、全部 ToolPart/ToolCall 已终态且没有 pending Permission，这类 Run 仍是完整可覆盖边界。边界校验不能把可选 `Run.output` 的缺失误判成永久不可压缩，但 `completed` Run 仍必须具有与 Assistant parts 一致的 output identity。

`RuntimeSafetyState` 独立从结构化 ToolCall、Permission、risk/policy snapshot 和终态结果生成。它持续覆盖 active 与非 active branch 已发生、可能发生或不确定的副作用，并明确 Permission 不能跨 Run/branch 转移；仍处于 active lineage 的 Tool Core prepared plan 只投影经校验的 `prepareOperation`、`expiresAt` 与强制 revalidation 标记，不复制任意 metadata。ToolCall 与绑定 Permission 的 plan link 冲突、格式非法或安全投影超出预算时都 fail closed。自然语言 summary 不是授权、执行或副作用事实来源。

`PreparedModelContext` 将 system-level `instructions` 与普通 `messages` 分开返回。assembled agent prompt、可选 provider-neutral checkpoint 和确定性 Runtime/Safety State 只进入 AI SDK 7 `instructions`；raw active-lineage user/assistant/tool history 与保留的 ToolLoop suffix 只进入 `messages`，且初始调用与每次 `prepareStep` 都执行无 system role 的 fail-fast 校验。Runner 为 retained suffix 记录其起始 request index：sealed-step cursor 只替换自己已经覆盖的 suffix，cursor 后的新 text/tool/result 必须逐字保留；该范围和内容 hash 都属于 durable plan identity。checkpoint summarizer 采用相同契约：summary 主指令、rolling checkpoint memory 和 Safety State 属于 `instructions`，待摘要 raw source 属于 `messages`。每次 rolling summary 调用都在 source 之后追加一条 Runtime-owned user generation request，明确要求立即输出 checkpoint，避免以历史 Assistant 结尾的 OpenAI-compatible prompt 被当作已完成对话而返回 `stop` 加零输出；该 request 计入输入预算和 checkpoint usage，但不属于 raw transcript，也不写回 Message Store。

`Run.usage` 是整个 Run（包括多个 step 和 continuation）的累计计费 usage。`ContextUsage` 则以 `runId + requestIndex` 记录单次模型请求的 active window、estimate、output reservation、raw/checkpoint/Safety State breakdown、checkpoint identity 和可选 Provider observation。Assistant 完成并持久化后，Runtime 立即从包含该 Assistant 的 active lineage 计算 `nextTurnForecast`，以不可变更新写回最后一条 request usage；刷新后的 Snapshot 复用相同 forecast。主上下文百分比只取 forecast 的 `estimatedInputTokens / contextWindow`，不会切换到 Provider observation，也不会加入或随着 output reservation 递减；Provider actual input、cache usage 和 reserve 仅作为辅助字段展示。

checkpoint summary 的每次 Provider 调用只聚合进该 checkpoint 自带、`purpose = checkpoint_summary` 的 usage，包含 invocation count 与逐类估算；成功生成后即使 Provider 未返回任何 usage 标量，也始终保留这份估算 usage。Provider 实际提供的 input/output/reasoning/cache/total 标量另存于可选 `providerObservation`，未提供的单个标量保持缺失而不会被记成精确的零；若所有调用都未提供任何标量，则省略整个 `providerObservation`。checkpoint usage 不累加父 checkpoint usage，也不写入 `Run.usage` 或 request-scoped `runtime_context_usage`。

`ContextCompactionActivity` 是独立于 Assistant footer metadata 的 durable timeline fact，以 `runId + requestIndex + attemptIndex` 唯一定位，并持有稳定 `cmp_*` identity。`requestIndex` 始终是实际 Provider/model request identity；可选 `boundaryStepIndex` 是独立的 UI timeline insertion identity，表示 Activity 应插在第几个可见 Assistant semantic step 之前。普通 `auto_mid_turn` 也会记录它：例如压缩覆盖 sealed step 0、下一模型请求将产生 step 1 时，`boundaryStepIndex` 为 `1`。overflow replacement、Permission continuation 等路径可能让 request index 与可见 semantic step index 分离，因此投影不得用其中一个推断另一个；旧记录缺少 `boundaryStepIndex` 时才按 `requestIndex` 兼容定位。soft gate 开始时为 `preparing`；checkpoint 与 Activity `created` 在同一事务中提交；summary/校验失败，以及达到 soft/hard budget 但不存在安全 coverage cursor 时为 `failed`；用户取消、lease/head 失效或重启恢复未完成 preparation 时为 `interrupted`；只有 overflow replacement 主模型请求真正成功，原 `created` Activity 才原位提升为 `recovered`。Activity payload 只含 trigger、cursor/checkpoint identity、before/after token 标量和时间，不包含 summary、reasoning、Safety State、Provider body 或 secret。

Runtime 在新 Run 首次模型请求前，以及同一 Run 每次 ToolLoop/Permission continuation 的下一模型请求前重新规划。达到 soft threshold 后，自动压缩是下一次主模型请求必须完成的 gate：首次请求使用 `auto_pre_turn`，已经 sealed 一个或多个 step 后使用 `auto_mid_turn`；成功后在同一逻辑 Run 中立即以 checkpoint + cursor 后 raw suffix 继续，不要求用户再发送消息，也不重放已执行工具。Runtime 先写入安全的 `context.compaction.preparing` trace 与 `preparing` Activity；checkpoint 成功后 Activity 进入 `created`，summary Provider 或校验失败进入 `failed`。明确 overflow 在发起替代请求前写入内部 `context.overflow.retrying` 审计，只有替代模型请求真正完成后才写 `context.overflow.recovered` 并把同一个 Activity 提升为 `recovered`，第二次请求也失败时不会伪报恢复成功。失败 trace 只允许 trigger、request index、head/revision、token 计数、error name 和 finish reason 等标量，不保存 prompt、summary、reasoning、Provider body 或 secret；主模型不会收到 raw fallback。严格的 reasoning-only length exhaustion（空 text、`finishReason=length`、reasoning tokens 大于零且 text tokens 明确为零）可以在目标模型 output limit 内扩大预算、缩小 input chunk 后重试一次，其他空白或无效输出不重试。

checkpoint 与 `context.checkpoint.created`、plan 与 `context.plan.created` 分别在同一个 SQLite 事务中提交，Event 只携带 ID、选择、预算和被拒 checkpoint 的安全原因，不携带 summary、Safety State body 或任意 Provider/Message metadata。checkpoint CAS 冲突与提交校验拒绝进入 `runtime_context_diagnostics`，不会伪装成成功事件。

Store 在 migration 完成后的启动路径扫描 checkpoint payload/索引列、format/compatibility、parent、coverage/source Run 与 lineage hash，并标记遗留 preparation claim。未知新格式保留为可读但不可选的 warning；损坏 checkpoint 被 planner/listing 忽略，不阻塞其余 Runtime 启动。诊断使用确定性 identity 去重，只保存安全 ID、原因与 allowlisted details，绝不复制 summary 或 claim owner/secret。

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
GET /v1/conversations/:conversationId/messages?format=runtime|ui|ai_sdk&view=active|transcript
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

其余 Snapshot Read API 只读取 Runtime Store，不执行模型、不调用工具、不修改 Workbench 状态。消息 endpoint 默认 `view=active`，返回 active head/revision；只有显式 `view=transcript` 才返回完整审计消息及脱敏 Run DAG 关系。响应顶层 `context_compaction_activities` 在 active view 只包含 active lineage Activity，在 transcript view 包含所有分支 Activity。`format=runtime` 返回 NexusPilot Runtime-native `Message[]`；`format=ui` 返回 NexusPilot 通用 UI-friendly projected message shape；`format=ai_sdk` 返回 AI SDK 7 `UIMessage` shape，用于 assistant-ui `useChatRuntime` 的历史恢复。active `ai_sdk` 投影把 Activity 作为带相同 `cmp_*` ID 的 `data-context-compaction` part 插入所属 Assistant 的真实 request boundary；旧 `metadata.nexus.compaction` 仅保留兼容读取，新的 Workbench UI 不再把它渲染为 Assistant footer。request observation 与 next-turn forecast 仍通过筛选后的 metadata 暴露；summary、reasoning、Safety State、failure diagnostics 和任意 stored Message metadata 不会因此进入普通 UI。

interrupt command API 会修改 Runtime Store 中的 Run、Assistant Message、ToolCall 和 Conversation 事实，并发布 live-only EventBus invalidation。它们不是 Snapshot Read API，但恢复 UI 仍通过后续读取 Snapshot API 完成。

`format=ui` 不等同于 `format=ai_sdk`。前者可以服务 NexusPilot 自有 UI 展示，后者必须跟随 AI SDK 7 `UIMessage.parts` 契约，例如 `source-url`、`file` 和 `tool-*` part。

## 当前不公开的扩展缝

`ContextCompactionService(trigger: "manual")` 复用与自动流程相同的 ancestry、Safety State、planner、CAS/fencing 和 event 契约；手动入口已实现为面向用户的 `/compact` 会话操作，由 `GET/POST /v1/conversations/:conversationId/compactions` 与 `POST /v1/conversations/:conversationId/compactions/:operationId/cancel` 承载，持久化独立 operation 并支持幂等与取消。当前默认界面也不提供分支浏览、比较、恢复或切换 UI，尽管 transcript/DAG 事实可被显式审计读取。

前端通过 Runtime HTTP/AI SDK-compatible stream 与 Snapshot API 使用这一领域层，而非直接调用模型。需要数据库或工作台能力的 ToolCall 通过受认证的 Rust/Tauri Backend WebSocket Bridge 执行，复用 Rust connection runtime；AI Runtime 不建立第二套数据库 pool。已实现的受控能力包括 `connection.open`、读取类工具和经 Permission/prepared plan 保护的 `sql.execute`，它们仍不能绕过 Rust 领域边界。

尚未实现：

- resumable stream、durable SSE replay 或后台 Run 恢复继续执行。
- 面向用户的 branch 浏览、比较、恢复或切换 UI。

后续能力必须继续通过 Runtime runner、tool registry、permission/audit、Snapshot Read API 和前端确认协议逐层接入，不能直接堆进 route、store 或 projection helper。
