# AI Runtime Provider/Model 设计

本文记录 NexusPilot `ai-runtime` 的 LLM Provider / Model 管理设计。Provider、model、catalog、API key 与 AI SDK provider adapter 的行为以本文档和当前实现为准。

## 定位

`ai-runtime` 是桌面应用的本地 sidecar，统一持有 LLM provider/model 配置、API key 和模型执行入口，使用 Bun、Elysia 与 Vercel AI SDK 实现。

Provider/model 层只回答四个问题：

- 当前有哪些 provider 和 model 可以被 UI 展示。
- 用户如何配置 provider API key、启用状态、自定义 endpoint 和自定义 model。
- 一次 Run 选择的 `(provider_id, model_id)` 如何解析为 AI SDK `LanguageModel`。
- 模型能力如何提供给 Agent Definition、Tool Policy 和 Prompt Assembly。

Provider/model 层不负责：

- 拼接系统提示词。
- 选择 agent 行为模式。
- 决定工具权限。
- 写入 Runtime Message / EventLog。
- 直接驱动前端 UI 状态。

## 设计目标

1. **沿用 sidecar 边界**：前端不持有 LLM credentials，也不直接访问外部 LLM API。
2. **配置数据使用 JSON**：provider/model 配置是小型整体读写数据，不进入 Runtime SQLite。
3. **以 models.dev 为预设目录**：从 models.dev 缓存 provider/model 元数据，用户配置作为 overlay。
4. **支持自定义 provider**：第一版自定义 provider 统一走 OpenAI-compatible 协议。
5. **运行时解析清晰**：Run 只传 `model.provider_id` 和 `model.model_id`；真实 SDK adapter 由 Runtime 内部解析。
6. **模型能力进入 policy 与 UI**：`supportsTools`、`supportsVision`、`supportsReasoning`、context/output length 等执行所需能力进入 Runtime context 和 tool policy；models.dev 的其余能力与模态字段也保留给设置页展示。

## 数据来源

Provider/model 数据分为两层：

| 层 | 来源 | 文件 | 责任 |
| --- | --- | --- | --- |
| Preset catalog | models.dev | `<cacheDir>/catalog.json` | provider/model 元数据基线 |
| Catalog metadata | Runtime | `<cacheDir>/catalog-metadata.json` | 最后一次目录更新时间 |
| User config | 用户设置 | `<dataDir>/providers.json` | API key、enabled、自定义 provider/model、disabled models |

`catalog.json` 保存 models.dev 原始响应；`catalog-metadata.json` 保存最后一次目录更新时间；`providers.json` 保存用户 overlay。启动时 `ProviderService.initialize()` 读取 catalog，再应用 user config，生成内存中的 `ProviderInfo` 和 `ProviderModel`。

## 数据目录

`ai-runtime` 的数据目录与缓存目录由 sidecar 启动参数或环境注入，不由业务代码自行猜测路径。生产宿主分别使用 Tauri `app_data_dir()/ai-runtime` 和 `app_cache_dir()/ai-runtime`。目标结构：

```text
<app-data-dir>/ai-runtime/
├── providers.json
├── runtime-settings.json
└── ai-runtime.sqlite3

<app-cache-dir>/ai-runtime/
├── catalog.json
└── catalog-metadata.json
```

当前 provider/model 配置文件：

- `catalogPath`：cacheDir 中的 models.dev 缓存文件。
- `catalog-metadata.json`：与 catalog 同在 cacheDir，记录目录最后更新时间；同一缓存目录只有 `catalog.json` 时以其文件修改时间回填。
- `providersPath`：用户 provider 配置文件。

Runtime SQLite 存放 Conversation、Run、Message、Part、ToolCall、Event 和 Trace，不存放 provider API key。

cacheDir 缺失时不回退到 dataDir。旧数据目录中的 `catalog.json` 和 `catalog-metadata.json` 不读取、不迁移也不清理；新缓存目录为空时直接沿用首次无缓存的远端获取与失败行为。

## Catalog 加载策略

`CatalogService` 的职责是返回 models.dev 原始 catalog：

```text
memory cache
  -> catalog.json
  -> https://models.dev/api.json
  -> {}
```

原则：

- 有本地缓存时优先使用缓存。
- 缓存有效期为 1 小时；启动时即使缓存过期也先使用本地目录，不阻塞 sidecar 就绪，再在后台尝试联网更新。
- 后台更新成功后重新初始化 ProviderService；失败时保留旧缓存并记录 warn 日志，不把目录清为空。
- 手动刷新通过 `POST /v1/catalog/refresh` 强制请求远端。成功时返回 `updated`；远端失败但存在本地缓存时返回 `using_cache`；远端和本地缓存都不可用时返回 `503`。
- 首次联网失败时允许返回空目录，用户仍可通过自定义 provider 使用 LLM。
- 不维护内置 provider 快照，避免仓库内模型目录陈旧。

## Provider 标准化

从 models.dev 标准化 provider 时，仅接收当前 Runtime 能执行的 provider protocol：

| models.dev `npm` | Runtime `apiProtocol` | AI SDK adapter |
| --- | --- | --- |
| `@ai-sdk/openai` | `openai` | `@ai-sdk/openai` |
| `@ai-sdk/anthropic` | `anthropic` | `@ai-sdk/anthropic` |
| `@ai-sdk/openai-compatible` | `openai_compatible` | `@ai-sdk/openai-compatible` |

不支持的 `npm` 值在初始化时过滤，不暴露给前端。

Provider 字段语义：

| 字段 | 说明 |
| --- | --- |
| `id` | Runtime provider id，公开 API 使用 `provider_id` |
| `name` | 展示名称 |
| `apiBase` | 默认或用户覆盖的 API base |
| `apiKey` | 用户配置的密钥，只保存在 sidecar 本地 |
| `enabled` | 是否允许执行 |
| `source` | `preset` 或 `custom` |
| `apiProtocol` | `openai`、`anthropic`、`openai_compatible` |
| `models` | provider 下的 model 字典 |

## Model 标准化

Model 字段语义：

| 字段 | 说明 |
| --- | --- |
| `id` | Runtime model id，公开 API 使用 `model_id` |
| `providerId` | 所属 provider |
| `upstreamId` | 真正传给上游 SDK 的 model id |
| `name` | 展示名称 |
| `contextLength` | 上下文长度 |
| `outputLength` | 输出长度 |
| `capabilities.supportsTools` | 是否支持 tool calling |
| `capabilities.supportsVision` | 是否支持 image/video/pdf 等视觉输入 |
| `capabilities.supportsReasoning` | 是否支持 reasoning |
| `capabilities.supportsAttachments` | 是否支持 models.dev `attachment`；它与视觉模态独立 |
| `capabilities.supportsInterleavedReasoning` | 是否声明 models.dev `interleaved` 交错式推理配置 |
| `capabilities.supportsStructuredOutput` | 是否支持 models.dev `structured_output` |
| `capabilities.temperature` | 是否支持 temperature |
| `capabilities.inputModalities` | models.dev `modalities.input` 中受支持的 `text`、`image`、`audio`、`video`、`pdf` 输入模态 |
| `capabilities.outputModalities` | models.dev `modalities.output` 中受支持的 `text`、`image`、`audio`、`video`、`pdf` 输出模态 |
| `source` | `preset` 或 `custom` |
| `enabled` | 是否允许执行 |

`supportsTools` 会直接影响 L3 per-Run Tool resolver：模型不支持 tool calling 时，候选 Tool 会以 `provider_tools_unsupported` 进入 Snapshot unavailable facts，Run 仍退化为普通问答。支持工具的模型会由 L5-A adapter 只接收当前 Snapshot active Tools。

`attachment`、`modalities`、`structured_output`、`interleaved` 和 `temperature` 是模型目录与设置页的能力事实。聊天附件入口已经开放，但 `supportsVision`、`supportsAttachments`、`inputModalities` 等目录字段不参与附件上传或发送门禁：Runtime 只验证附件协议、安全、完整性和资源限制，然后把本地 bytes 投影为 AI SDK 标准 `file` part。adapter 或上游 Provider/Model 不接受某种附件时，当前 Run 明确失败并显示脱敏错误；系统不静默删除附件、不自动换模型，也不降级为纯文本重试。

自定义 OpenAI-compatible 模型的工具能力默认是**开启**：模型定义省略 `capabilities.supports_tools` 时，Runtime 按 `true` 处理。只有显式写入 `false` 才会禁用工具调用。这个默认值适用于历史 `providers.json`，无需迁移；设置页编辑时也必须保留已保存的显式能力值。

## User Config

`providers.json` 是用户配置 overlay。示例：

```json
{
  "openai": {
    "api_key": "sk-...",
    "enabled": true,
    "api_base": "https://api.openai.com/v1",
    "disabled_models": ["gpt-4o-mini"]
  },
  "my-local": {
    "name": "My Local Provider",
    "api_base": "http://127.0.0.1:11434/v1",
    "api_key": "local-key",
    "enabled": true,
    "models": {
      "qwen-local": {
        "name": "Qwen Local",
        "upstream_id": "qwen2.5",
        "context_length": 32000,
        "output_length": 4096,
        "capabilities": {
          "supports_tools": true,
          "supports_attachments": true,
          "supports_structured_output": true,
          "input_modalities": ["text", "image"],
          "output_modalities": ["text"]
        }
      }
    }
  }
}
```

规则：

- `api_key` 不进入 OpenAPI 响应的 summary；详情接口可以返回当前 sidecar 内部需要的配置状态。
- `disabled_models` 只影响该 provider 下对应 model 的 `enabled`。
- 自定义 provider 默认 `apiProtocol = "openai_compatible"`。
- 更新自定义 provider 的 `models` 时，以请求体为准替换模型定义；仍存在的 disabled model 会保留 disabled 状态。
- 在创建或编辑自定义 provider 前，模型列表可以通过临时发现接口读取；该请求不会写入 `providers.json`，用户仍需在表单中确认后才会保存模型和 API key。
- 设置页对每个自定义模型提供工具调用探测入口。它不保存当前表单、API key 或探测结果，且只调用 Runtime 内置的无副作用 probe tool，不会访问数据库连接、Runtime Tool Core、权限系统或 Backend Bridge。

## HTTP API

`ai-runtime` 是专职 sidecar，HTTP contract 不使用 `/api` 前缀。

Provider/model API：

```text
GET    /v1/providers
GET    /v1/providers?enabled_only=true
GET    /v1/providers/:providerId
GET    /v1/catalog/status
PUT    /v1/providers/:providerId/config
PUT    /v1/providers/:providerId/models/:modelId/config
POST   /v1/custom-providers
POST   /v1/custom-providers/discover-models
POST   /v1/custom-providers/test-tool-calling
PUT    /v1/custom-providers/:providerId
DELETE /v1/custom-providers/:providerId
POST   /v1/catalog/refresh
```

`GET /v1/catalog/status` 返回：

```json
{
  "last_updated_at": 1760000000000
}
```

该时间只在成功写入远端目录时更新；cacheDir 中只有 `catalog.json` 时，在首次读取时使用其文件修改时间回填，保证设置页能够展示已有缓存的上次更新时间。

`PUT /v1/providers/:providerId/config` 的字段语义：

```json
{
  "api_key": "sk-...",
  "enabled": true,
  "api_base": "https://proxy.example.com/v1"
}
```

字段均可省略，省略表示不修改。当前 contract 不使用 `null` 表示清空或恢复默认值；如果后续需要“清空 API key”或“恢复默认 API base”，必须新增明确语义和测试，而不是让 `null` 成为隐式 no-op。

### OpenAI-compatible 模型发现

`POST /v1/custom-providers/discover-models` 用于在自定义供应商表单仍未保存时获取模型列表：

```json
{
  "api_base": "https://proxy.example.com/v1",
  "api_key": "sk-..."
}
```

Runtime 仅对 `{api_base}/models` 发起 `GET` 请求，并携带 `Authorization: Bearer <api_key>`。它只接受 OpenAI-compatible 的响应结构：

```json
{
  "data": [
    { "id": "model-a" },
    { "id": "model-b", "name": "Model B" }
  ]
}
```

响应会被标准化为可编辑的 `{ id, name }` 列表；API key 和发现结果不会因为该请求写入 `providers.json`。请求不跟随重定向、受超时和响应体大小限制，且错误响应不会回显 API key。

该接口**仅**用于当前的 OpenAI-compatible 自定义 provider。它不会尝试 Anthropic、Gemini 或其他原生协议的模型路径、鉴权头或响应结构；后续支持这些协议时，必须同时扩展 `apiProtocol`、对应 AI SDK adapter 和独立的发现策略。

### OpenAI-compatible 工具调用探测

`POST /v1/custom-providers/test-tool-calling` 可在供应商尚未保存时验证单个模型的工具调用协议：

```json
{
  "api_base": "https://proxy.example.com/v1",
  "api_key": "sk-...",
  "model_id": "model-a"
}
```

Runtime 用同一 OpenAI-compatible AI SDK adapter 创建临时模型，并发送单步、强制调用 `nexus_tool_probe` 的请求。probe tool 仅在进程内返回 `{ "ok": true }`，不读取或修改任何 NexusPilot 数据。收到并执行该 tool call 时返回 `{ "supported": true, "message": "..." }`；认证、模型不存在、协议拒绝、网络和超时会返回 `{ "supported": false, "reason", "message" }` 的可诊断结果。该测试验证上游接收 `tools` 和返回 OpenAI-compatible `tool_calls` 的能力，不能替代实际模型的质量评估。

## Model Execution 解析

Run 创建请求只携带：

```json
{
  "model": {
    "provider_id": "openai",
    "model_id": "gpt-4o"
  }
}
```

执行前 `resolveProviderLanguageModel()` 负责：

1. 检查 provider 是否存在。
2. 检查 provider 是否启用且存在 API key。
3. 检查 model 是否存在。
4. 检查 model 是否启用。
5. 根据 `apiProtocol` 创建 AI SDK `LanguageModel`。
6. 生成 Runtime context 中的 provider/model capability snapshot。

该 capability snapshot 可用于展示、Prompt 与既有 Tool Policy，但不得用于决定聊天附件是否可以进入 Run。附件内容只能由 Runtime Attachment Store 读取并作为 bytes 交给 AI SDK；本地内容 URL、Runtime access token 和文件系统路径不得传给 Provider。

错误映射：

| 场景 | HTTP status | Runtime error |
| --- | --- | --- |
| Provider 不存在 | 404 | `ProviderNotFoundError` |
| Provider 未启用或无 API key | 401 | `ProviderAuthError` |
| Model 不存在 | 404 | `ModelNotFoundError` |
| Model 被禁用 | 400 | `ModelDisabledError` |
| OpenAI-compatible 缺少 API base | 400 | `UnknownError` |

这些错误会在 `/v1/runs` 创建阶段返回，也会在 Runner failure path 中沉淀为可诊断 Runtime error。

## AI SDK Adapter

当前 adapter 规则：

| `apiProtocol` | 创建方式 |
| --- | --- |
| `openai` | `createOpenAI({ apiKey, baseURL }).languageModel(upstreamId)` |
| `anthropic` | `createAnthropic({ apiKey, baseURL }).languageModel(upstreamId)` |
| `openai_compatible` | `createOpenAICompatible({ name, apiKey, baseURL, includeUsage: true }).languageModel(upstreamId)` |

涉及 `ai` 或 `@ai-sdk/*` 的修改必须先查阅 [AI SDK llms.txt](https://ai-sdk.dev/llms.txt)，优先通过官方搜索端点定位当前文档，再修改 adapter、stream 或 tool calling 代码。

## 与 Agent Definition 的关系

Provider/model 不决定 agent 行为。一次 Run 的行为由以下层次组合：

```text
/v1/runs request
  -> provider/model resolve
  -> AgentDefinition(agent_mode)
  -> ToolPolicy(model capabilities + limits + registry)
  -> PromptAssembly
  -> AI SDK streamText
```

Provider/model 只把能力事实提供给后续层：

- 是否支持 tool calling。
- 是否支持 vision。
- context/output length。
- provider/model 展示名。

`system`、`tools`、`limits` 不允许通过 provider config 或 `/v1/runs` 请求体直接覆盖。
