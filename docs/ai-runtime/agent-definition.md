# AI Runtime Agent Definition & Prompt Assembly

本文记录 NexusPilot AI Runtime 的 Agent Definition 与 Prompt Assembly 设计及当前实现事实。它是 Runtime-local tools 的策略基础设施，用于把公开 Run 请求中的运行意图转换为 Runtime 内部可执行、可审计、可演进的 agent 策略。

当前 `ai-runtime` 已完成内置 Agent Definition Registry、Prompt Assembler、L3 稀疏 Namespace policy/per-Run Tool Snapshot resolver、L4 Runtime Tool Core、L5-A AI SDK adapter、七个只读 Backend Tool、可逆的 `connection.open`、受控的 `sql.execute` 与五个 Redis 单 Key mutation Tool。这些工具均通过 Snapshot 与 Core 向生产 Runner 开放。

能力制 Namespace、稀疏 Agent policy 和不可变 per-Run Tool Snapshot 的权威设计与当前实现见 [tool-namespace.md](./tool-namespace.md)。本文后续仍有部分验证期 `web_fetch` 流程说明；这些只描述历史实现和迁移来源，若与当前 L3 状态冲突，以 Tool Namespace 文档为准。

高风险关系型数据库与键值数据库工具的稳定执行边界见 [Database tool safety model](./database-tools.md)。

## 核心决策

第一版只支持系统内置 agent，不支持用户自定义智能体。

原因：

- 当前阶段目标是把 AI Runtime 自身架构打稳，而不是建设通用 agent 平台。
- 用户自定义 agent 会立即引入 CRUD API、存储、迁移、UI、权限审核、prompt 安全、版本兼容和导入导出问题。
- Runtime-local tools 需要稳定的内置策略边界；过早开放 agent 自定义会让工具策略、权限策略和 prompt 语义失去稳定边界。
- NexusPilot 当前需要的是少量高质量内置运行模式，而不是开放式 agent marketplace。

因此，第一版提供内置 `ask`、`query` 和 `agent` 三种 agent mode。它们在内部仍由同一套 AI Runtime Runner、Snapshot 和 Core 编排，但面向模型的系统提示词使用产品语义，而不是把 “AI Runtime”、“sidecar” 等内部架构名作为角色身份。

- `ask`：问答与公开资料检索模式；只允许 `system`、`web` 等通用 Namespace，不读取数据库连接、元数据或内容。
- `query`：数据库只读协作模式；在 Ask 能力基础上允许数据库只读工具，以及完成只读任务所需的可逆连接运行时操作，但禁止远端业务写入、破坏性和不可逆操作。
- `agent`：完整受控智能体模式；在 Query 能力基础上允许完整数据库工具进入候选范围。更高 execution ceiling 只表示可以进入 Core 授权与审批，不代表自动批准写入或破坏性 ToolCall。

## 命名决策

`profileId` 不作为目标设计字段。

`profile` 容易暗示用户可配置画像、账号配置或任意 profile record，而当前 NexusPilot 的真实语义是：

```text
这次 Run 使用哪一种内置 agent 运行模式？
```

因此目标命名为：

- TypeScript/domain 内部字段：`agentMode`
- HTTP/OpenAPI 或 snake_case payload 字段：`agent_mode`
- 允许值第一版为：`ask`、`query`、`agent`

历史代码中曾存在 `profileId` 和公开请求字段 `mode`。这些属于 Phase 2/2.1 的过渡实现，Phase 2.2 已迁移为：

```text
profileId -> agentMode
profile_id -> agent_mode
mode -> agent_mode
```

`/v1/runs` 公开请求中的 `mode` 已迁移为 `agent_mode`，避免和 `response_mode` 并列时语义不清。当前实现不保留 `mode` 与 `agent_mode` 两个长期主字段；旧 `mode` 字段会被请求 parser 拒绝。

默认值边界：

- AI Runtime 公共 API 省略 `agent_mode` 时，仍按安全默认解析为 `ask`。
- Workbench 前端的新用户默认偏好是 `ask`，并且发起 `/v1/runs` 时必须显式发送当前选择的 `agent_mode`；已有持久化偏好不被强制改写。
- 每次 Run 实际采用的模式会写入 Runtime Store 中的 Run / Message 事实；前端当前选择本身不写入 Runtime Store。

## OpenCode 借鉴

OpenCode 把 agent 视为运行策略集合，而不是单纯 prompt 字符串。其 SDK 类型中的 agent/config 维度包括：

- agent 名称和描述。
- built-in 标记。
- primary / subagent / all 模式。
- prompt。
- tools enable map。
- permission policy。
- model、temperature、topP。
- maxSteps。

OpenCode 的 session prompt API 允许请求体传入 `agent`、`system`、`tools` 和 `parts`。这适合 OpenCode 的定位：它是 coding-agent server，客户端/TUI 本身就是 agent 控制面。

NexusPilot 不照搬这个公开 API 取舍。NexusPilot 的 `/v1/runs` 不是 chat completion passthrough，也不是 agent authoring API。公开请求只表达用户输入、模型选择和运行意图；`system`、`tools`、`limits`、权限和 prompt 组装由 Runtime 内部根据 `agent_mode` 决定。

可借鉴的是模型密度：

```text
Agent Definition = prompt + tools + permission + limits + model behavior
```

不借鉴的是把 `system/tools` 直接暴露给当前公开 Run 创建请求。

## AgentHub 借鉴

AgentHub 中值得借鉴的是内部边界，而不是外部 adapter 层。

可借鉴：

- AgentDefinition 把 `systemPrompt`、`allowedTools`、`permissionPolicy`、`modelRef`、`capabilities` 和 `executorType` 放在一个定义里。
- AgentRegistry 负责加载内置 agent、规范化工具白名单、应用模型绑定和校验权限策略。
- Prompt assembly 不是简单字符串拼接，而是把 agent prompt、agent metadata、任务信息、环境快照、工具偏好、skills、MCP context 等分块装配。
- ToolRegistry 根据 agent 的 `allowedTools` 和权限策略决定工具是否可用。

不借鉴：

- Claude Code / Codex / OpenCode external adapter 层。
- 群聊、多 agent 委派、subagent orchestration。
- workspace 文件编辑、shell、部署等能力。
- 用户自定义 agent CRUD。

NexusPilot 当前前后端都围绕 AI SDK，因此执行层应保持 AI SDK-native stream 和 assistant-ui 兼容心智，不引入 AgentHub 风格的前端适配协议。

## AI SDK 约束

涉及 AI SDK 的实现必须遵循仓库文档约束，先参考官方 LLM 入口：

- <https://ai-sdk.dev/llms.txt>

Agent Definition 是 NexusPilot 的领域策略，不等同于 AI SDK 的 `ToolLoopAgent`。当前实现为每个 Run 把 Agent Definition 与冻结 Snapshot 编译成轻量 `ToolLoopAgent` 执行配置：

- `system`：来自 Prompt Assembly 的最终系统指令。
- `tools`：来自 Tool Policy Resolver 的可用工具集合。
- `activeTools`：当前 agent mode 实际允许暴露给模型的工具名。
- `stopWhen`：来自 Run limits，例如 `maxSteps`。
- `maxOutputTokens`、`timeout` 等 call settings：来自 Runtime policy。

L5-A 使用 AI SDK 7 `ToolLoopAgent` 与 custom tool 形态，AI SDK Tool 的 `execute` 只能进入 Runtime Core dispatcher。每个 Run 只把 Snapshot active Tool 的 Provider name 传入 `tools` / `activeTools`。Runtime 继续拥有自己的 Run、Message、Part、ToolCall、Permission、Event 和 TraceEvent 事实模型。

AI SDK 依赖当前尚未冻结。后续 Tool Core/Permission 实现允许并倾向于同批升级 AI SDK、Provider package、Web `@ai-sdk/react` 与 assistant-ui adapter，并优先复用新版稳定的 `ToolLoopAgent`、tool calling 和 approval API；Runtime-owned Snapshot、Permission 和 Store 仍是业务事实。具体约束见 [tool-namespace.md](./tool-namespace.md#12-ai-sdk-adapter-边界) 与 [tool-permission.md](./tool-permission.md#5-ai-sdk-adapter)。

## 目标模块

第一版应形成以下内部模块边界。

### AgentDefinition

AgentDefinition 描述一个内置 agent 的稳定运行策略。

概念字段：

```text
id:
  稳定内置 id，第一版为 ask / query / agent。

agentMode:
  语义化运行模式，第一版与 id 一致。

title / description:
  给日志、调试、未来 UI 或 OpenAPI 描述使用。

builtIn:
  第一版恒为 true。

systemPrompt:
  agent 自身的核心行为指令。

capabilities:
  描述 agent 能力，例如 question-answering、runtime-tool-use、web-research。

toolPolicy:
  允许工具、默认启用工具、禁止工具和未来权限策略的入口。

limits:
  maxSteps、maxToolCalls、maxOutputTokens、timeoutMs 等默认值。

modelBehavior:
  temperature、topP、toolChoice 等模型行为建议。第一版只保留必要字段。

metadata:
  risk、version、source 等调试信息。
```

第一版 AgentDefinition 不落库，不提供 CRUD，不从用户配置文件加载。它是代码内置、版本受控的 Runtime policy。

### AgentDefinitionRegistry

Registry 只负责内置定义的注册、查询和校验。

职责：

- 注册 `ask`、`query` 和 `agent`。
- 保证 `agentMode` 唯一。
- 禁止未知 agent mode 静默 fallback。
- 对外提供只读查询。
- 后续可扩展 list API，但第一版不需要公开 CRUD。

Registry 不负责：

- 拼接 prompt。
- 执行模型。
- 执行工具。
- 读取或写入 SQLite。
- 决定前端 UI。

公开 HTTP 投影：

```text
GET /v1/agent-modes
```

该接口是内置 AgentDefinitionRegistry 的只读 UI catalog 投影，只返回：

- `agent_mode`
- `title`
- `description`
- `built_in`
- `capabilities`

它不返回 `systemPrompt`、`limits`、`toolPolicy`、permission policy、model behavior 或 prompt assembly 细节。原因是这些字段属于 Runtime 内部执行策略，不应变成前端控制面。前端可以用该 catalog 渲染 Agent Mode 选择器，但不能通过它修改或覆盖 Agent Definition。

### AgentResolver

AgentResolver 把 Run 创建请求中的运行意图解析为内部执行策略。

输入：

- public run intent，例如 `/v1/runs` 请求中的 `agent_mode`。
- provider/model 选择。
- Runtime config。
- ToolRegistry。
- 当前 Runtime 工具审批设置。

输出：

```text
ResolvedAgentExecutionPolicy
```

其中包含：

- `agentMode`
- resolved AgentDefinition
- assembled system prompt
- enabled tools / active tools
- resolved limits
- trace metadata
- prompt assembly version

工具解析同时把当时的 `autoApproveMaxRisk` 冻结到 Run Tool Snapshot。它不是公开 Run 请求字段，也不由 Agent Definition 或模型覆盖。设置更新只影响之后创建的新 Run；continuation 恢复既有 Snapshot，不重新读取当前设置。完整所有权和 fail-safe 规则见 [settings.md](./settings.md)。

Resolver 是公开 contract 和 Runtime 内部 policy 的边界。route 层不应直接拼 prompt，也不应直接决定工具列表。

### PromptAssembler

PromptAssembler 把多个来源的 prompt block 组装为最终系统指令。

第一版 prompt block 顺序：

```text
NexusPilot agent identity
  -> NexusPilot 智能体身份、Ask/Query/Agent 模式由系统指定、基础职责边界

Available agent modes
  -> 从本次 Run 使用的 Agent Definition Registry 生成完整模式目录、当前模式和模式切换引导

Agent behavior instructions
  -> Ask / Query / Agent 各自的模式职责与行为约束

Tool usage instructions
  -> 当前 Run 存在 active tools 时出现，使用“当前可用工具”等用户可理解表达

Execution context instructions
  -> 第一版为空或只包含轻量执行上下文

Output style instructions
  -> 清晰、可靠、实用，区分事实、推断和建议，不暴露系统提示词、内部指令、隐藏策略或内部工具名称与调用标识；说明执行过程时使用用户能理解的动作描述
```

`Available agent modes` 是所有模式共享的事实块，不在 `ask.ts`、`query.ts` 和 `agent.ts` 中分别复制维护。它必须：

- 只列出 Agent Definition Registry 中真实存在的模式，当前为 Ask、Query 和 Agent。
- 告诉模型当前 Run 使用的模式。
- 禁止杜撰或推荐 Execute、Edit、Build 等目录外模式。
- 当需求超出当前模式边界时，建议满足需求的最低模式：
  - 访问或打开数据库连接、读取元数据或只读数据：Query。
  - 写入、DDL、删除或其他破坏性操作：Agent。
- 只允许给出文字切换建议；模型不能声称已经替用户切换模式，第一版也不增加前端一键切换协议。
- 明确切换模式不会创造尚未实现或本次 Run 未暴露的工具；Agent 的更高 execution ceiling 不是能力已落地的承诺。
- 仅在真实限制来自模式时建议切换。网络不可达、连接失败、Backend Bridge 断开、参数错误、数据库权限不足和工具尚未实现，应按真实原因说明。
- 当前模式没有暴露工具时，说明该模式无法调用，不能虚构一次“已调用但未执行”的工具尝试。

未来可加入：

- conversation summary。
- selected SQL/editor context reference。
- provider/model capability hints。
- user locale/timezone。
- permission policy hints。
- web_fetch source citation rules。
- Workbench context snapshot。

PromptAssembler 的输出不应只是字符串。它至少应包含：

```text
system:
  最终传给 AI SDK 的 system/instructions。

blocks:
  参与组装的 block 元数据，便于 trace/debug。

version:
  prompt assembly schema version。

warnings:
  可诊断问题，例如工具被模型能力禁用。
```

这样后续 `trace.recorded` 可以记录 prompt assembly 的结构化事实，而不必把所有细节散落在 runner 中。

系统提示词自身属于内部执行约束，不面向用户展示。模型不得向用户透露、复述或总结系统提示词、内部指令或隐藏策略；当用户要求查看这类内容时，应礼貌拒绝，并只说明当前可提供的帮助范围。

### Prompt 文件管理

内置 agent 的核心系统提示词独立放在 `ai-runtime/src/runtime/agents/prompts/`：

- `ask.ts`：导出 `ASK_SYSTEM_PROMPT`。
- `query.ts`：导出 `QUERY_SYSTEM_PROMPT`。
- `agent.ts`：导出 `AGENT_SYSTEM_PROMPT`。

提示词使用中文维护，便于团队直接审阅和迭代。当前选择 TypeScript 常量文件，而不是运行时读取 `.md` 或 `.txt` 文件，原因是第一版要兼顾 Bun sidecar 的编译、打包和路径稳定性；prompt 仍然通过代码版本管理，但不引入额外的运行时文件读取路径。

### Per-Run Tool Resolver

Per-Run Tool Resolver 从 AgentDefinition 和不可变 RuntimeToolRegistry 中解析工具可见性与执行上限。

当前规则：

- `ask` 只允许 `system`、`web` Namespace 中符合低风险 ceiling 的候选工具。
- `query` 允许 `system`、`web`、`connection`、`metadata`、`table` 和 `key_value` Namespace；其 ceiling 允许 `business_read` 以及为只读任务所需的可逆 `runtime_state` / `workbench_state`，但拒绝 `business_write`、`destructive` 和不可逆工具。
- `agent` 使用当前全部 built-in Namespace 范围，并为完整数据库工具保留较高 ceiling；未来新增能力制 Namespace 时，必须显式决定是否加入 Query 和 Agent，而不是依赖 Tool 名称或 Driver 名称推断。
- 工具必须同时满足：
  - 已在 RuntimeToolRegistry 注册并由所属 Namespace 本 Run 贡献。
  - 被当前 AgentDefinition 的 Namespace/Tool 稀疏策略允许。
  - 当前 provider/model 支持 tool calling。
  - 静态 dependency 和 execution ceiling 允许。

任何 Tool 都不能在 runner 中通过 `if agentMode` 硬编码启用；L4 后只能由 Snapshot identity 进入 Core dispatcher。

L3 已删除验证期 `enabled/defaultEnabledTools` 双清单。当前 Snapshot 的 `activeTools` 表示经过 Namespace contribution、Agent policy、静态 dependency、Risk ceiling 和 Provider capability 后冻结的模型可见候选；它仍不表示具体 ToolCall 已获授权。L5-A adapter 只把这些 active identity 暴露给 AI SDK，具体调用仍由 Core 授权。

当前高风险数据库工具规则：

- `table` 保留结构化、可约束的表级操作；`sql` 承载原始 SQL 分析与执行，二者不合并。
- `sql` 只进入 `agent` 候选范围，不进入 `query`；`query` 继续只使用结构化 `table.query`。
- `key_value.scan/get` 可继续进入 `query`；`key_value.create/set/rename/set_ttl/delete` 只进入 `agent`。
- `low` 可自动执行；`medium`、`high` 需要标准审批；`critical` 需要展示完整目标，并在属于 SQL 调用时展示完整不可变 SQL，再进行强确认。
- 原始 SQL 分析结果为 `uncertain` 时必须归类为 `critical`，不得降级、自动改写或以模型自行判断替代 Runtime 分析。
- `agent` 的 Namespace 可见性不放宽上述规则；所有写入工具仍必须经过 Snapshot、动态 Risk、Permission 和 prepared plan 校验。Redis fingerprint 与 planId 都是内部事实，模型不可生成或传入。

### ExecutionPolicy

ExecutionPolicy 是 Runner 真正消费的结果。

概念形态：

```text
ExecutionPolicy {
  agentMode
  system
  tools
  activeTools
  limits
  modelSettings
  trace
}
```

Runner 不再关心“某个模式是什么 prompt、有哪些工具”。Runner 只根据 ExecutionPolicy 调用 AI SDK，并把执行事实写回 Runtime Store。

## 数据流

目标执行流：

```text
POST /v1/runs
  -> parse public request
  -> normalize run intent
  -> AgentResolver.resolve()
  -> AgentDefinitionRegistry.get(agent_mode)
  -> PromptAssembler.assemble()
  -> Namespace.resolveForRun + per-Run resolver
  -> freeze Run Tool Snapshot
  -> create/load Conversation
  -> create User Message
  -> create Run with agentMode and execution policy metadata
  -> create Assistant Message
  -> AI SDK ToolLoopAgent.stream（只传 Snapshot active tools）
  -> AI SDK-compatible stream
  -> Runtime Store semantic boundaries
```

关键点：

- public request 不能覆盖 `system`、`tools`、`limits`。
- `agentMode` 必须写入 Run 事实，用于历史、统计和恢复。
- assembled prompt 的完整内容是否持久化需要谨慎。第一版可以记录 prompt version、block ids 和摘要，避免把未来可能包含敏感上下文的完整 prompt 无限制写入 SQLite。
- 当前 Prompt Assembly 为 `runtime-prompt-v2`；相较 v1 新增 `runtime.agent_modes` 事实块。
- 工具策略必须在 Run 开始前解析，后续工具执行只消费已解析策略。
- `maxToolCalls` 将由 L4 Core 执行为真实调用上限；L3 不通过旧 execute wrapper 提前实现该限制。
- 历史 `web_fetch` ToolCall/ToolPart/SourcePart 仍可恢复；新的 canonical `web.fetch` 与 `web.ping` 已通过 Core 开放执行。

## 内置 Agent 语义

### ask

定位：

```text
NexusPilot 的 Ask 模式，面向数据库工作台中的解释、分析、建议和资料补充。
```

第一版能力：

- 回答用户输入中的问题。
- 解释 SQL、数据库概念、错误信息和执行思路。
- 可以基于用户显式提供的上下文做分析。
- 可使用 Snapshot 与 Core 提供的 `system`、`web` 通用工具补充事实依据。
- 不主动声称读取了工作台状态。

边界：

- 不读取连接配置、连接运行时、数据库元数据或数据库内容。
- 不打开数据库连接。
- 不访问本地文件。
- 不修改 SQL editor。
- 不通过 Backend Bridge 执行数据库工作台命令。

### query

定位：

```text
NexusPilot 的 Query 模式，面向数据库发现、元数据理解和只读查询协作。
```

第一版能力：

- 具备 Ask 的全部问答和公开资料检索能力。
- 可发现连接、读取非敏感连接信息和数据库元数据。
- 可执行系统实际提供的数据库只读工具。
- 可通过 `table.query` 的结构化列、过滤、排序和分页参数读取 table-like source；该工具不接受 SQL、表达式、JOIN 或聚合。
- 可通过 `key_value.scan` 的字符串游标逐批发现 Key，并通过 `key_value.get` 读取精确 Key 的类型、TTL、大小与类型化值；两者都不接受 Redis command。
- 可执行完成只读任务所需的可逆连接运行时或工作台状态操作；当前 `connection.open` 已通过共享 Rust runtime 落地。
- Snapshot active 表达当前 Run 冻结的候选工具集合，具体 ToolCall 仍必须进入 Core。

边界：

- 不执行远端数据库业务写入。
- 不执行 DDL、删除、破坏性或不可逆操作。
- 不因为操作名看似“查询”就自行推断安全性；输入相关风险仍由 Tool 的动态 Risk 分析和 Core 判断。
- Query 模式不注册原始 SQL 执行工具；模型不能把 SQL 文本伪装成 `table.query` 参数或假装 SQL 已执行，能力不足时应明确说明限制。
- Redis SCAN 的 `count` 不是精确页大小，结果也不是稳定快照；模型必须原样续传 `nextCursor`，不得猜测 Key 或 `dbIndex`。

### agent

定位：

```text
NexusPilot 的 Agent 模式，面向目标拆解、步骤规划和受控工具协作。
```

第一版能力：

- 具备 Query 的全部问答、检索和数据库只读能力。
- 可使用系统当前实际注册并授权给 Agent 的完整数据库候选工具；其中 `sql.execute` 承载单条原始 SQL，写入、DDL 与无法精确分类的 SQL 必须经过相应审批。
- 可通过 `key_value.create/set/rename/set_ttl/delete` 执行结构化单 Key mutation；必须使用完整精确 Key，不得使用 prefix/pattern 代替单 Key，也不得生成 raw Redis command 或 Lua。delete 与 expire TTL 为 critical 强确认；冲突或结果未知后不得自动重试。
- Snapshot active 表达冻结的可见性和上限，具体 ToolCall 仍必须进入 Core。
- 使用工具结果时必须说明来源，不能把未执行的工具结果当事实。

边界：

- 工具可见不代表执行授权；Core 必须先检查 Snapshot、Risk、limits 和 Permission。
- `medium`、`high` 调用必须通过标准审批；`critical` 调用必须展示完整目标，并在属于 SQL 调用时展示完整不可变 SQL，再通过强确认。
- 无法精确分析的原始 SQL 一律视为 `critical`；模型不能自行降低风险，也不能在审批后改写 SQL。
- Permission continuation 已实现；任何需要审批的工具仍必须完整经过该链路，不能绕过。
- 不执行本地 shell。
- 不读取任意本地文件。
- 不绕过 Runtime permission/tool policy。

## 和 Runtime Store 的关系

AgentDefinition 第一版不落库，但 agent resolution 的结果要进入 Run 事实。

建议 Run 事实保存：

- `agentMode`
- provider/model
- limits snapshot
- enabled tool names snapshot
- active tool names snapshot
- `web_fetch` ToolCall 当前状态、错误、耗时和 bounded preview 元数据
- `web_fetch` 产生的 source reference
- prompt assembly version
- prompt block metadata 或摘要

不建议第一版直接保存：

- 可变 user custom agent definition，因为没有该能力。
- 完整用户可配置 prompt，因为没有该能力。
- 大型上下文块完整内容。

如果后续需要完整 prompt replay，应通过 artifact/blob 或受限 trace 策略处理，而不是把所有 prompt 文本塞进高频 event。

## 和 assistant-ui / AI SDK Stream 的关系

AgentDefinition 不应增加前端适配层。

assistant-ui 仍然消费 AI SDK-compatible stream。AgentDefinition 只影响 Runtime 内部传给 AI SDK 的 system、tools、activeTools 和 limits。前端不需要知道完整 prompt assembly，也不需要维护兼容层。

历史恢复仍从 Runtime Store 投影为 AI SDK / assistant-ui friendly message shape。`web_fetch` 产生的 ToolPart 和 SourcePart 也应通过 projection 进入 UI message shape；前端不通过 `/v1/runs.tools` 传工具，也不维护工具启用策略。`agentMode` 可以作为 message/run metadata 暴露给 UI，用于徽标、筛选或调试，但不是渲染协议的核心。

## 非目标

第一版不做：

- 用户自定义 agent。
- Agent CRUD API。
- Agent marketplace。
- 多 agent 群聊或委派。
- subagent。
- skills / MCP 注入。
- 任意 Tool/Namespace 动态注册。
- 任意 Tauri command、Rust 方法或通用 SQL 字符串代理；专用 `sql.execute` 已实现，但必须经过 SQL 分析、Permission 与 prepared plan，不属于通用透传。
- SQL editor diff 自动应用。
- 长期记忆。
- 前端 agent 管理页面。

## L3 当前状态

当前已经完成：

- 新增 Ask / Query / Agent 三个内置 AgentDefinition 及 Registry。
- 新增 AgentResolver。
- 新增 PromptAssembler。
- 新增 Namespace per-Run resolver 和不可变 Snapshot。
- 按模式固定稀疏 Namespace policy 与 execution ceiling；Ask 不暴露数据库工具，Query 只允许数据库只读与必要的可逆状态操作，Agent 保留完整受控上限。
- 已将 `profileId/profile_id` 迁移为 `agentMode/agent_mode`。
- 更新 Run domain、schemas、store、route parser、OpenAPI 和 tests。
- 确保 `/v1/runs` 仍不公开 `system/tools/limits`。
- 已删除旧 `web_fetch` Registry/adapter；正式工具统一走 Snapshot/Core。

后续 web 工具与 Workbench 业务工具都必须复用同一套 Agent Definition、Snapshot、Core、Permission 和 Store 事实模型；`web.fetch` 与 `web.ping` 的网络范围必须只读取 Run Snapshot 中冻结的 Runtime-owned policy。

## 参考

- [OpenCode Server 文档](https://opencode.ai/docs/zh-cn/server/)
- [OpenCode Agents 文档](https://opencode.ai/docs/zh-cn/agents/)
- [OpenCode SDK 类型定义](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)
- [AI SDK llms.txt](https://ai-sdk.dev/llms.txt)
- [AI SDK Prompts](https://ai-sdk.dev/docs/foundations/prompts)
- [AI SDK Building Agents](https://ai-sdk.dev/docs/agents/building-agents)
- [AI SDK Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
- [AI Runtime Runner Core](./runner-core.md)
- [AI Runtime Domain](./domain.md)
