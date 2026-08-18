# ai-runtime

`ai-runtime/` 是 NexusPilot 当前目标 AI sidecar 实现，使用 Bun + Elysia + Vercel AI SDK 承载 provider/model 管理、Runtime Run、AI SDK-compatible stream、Runtime SQLite Store、Snapshot Read API、live-only EventBus/SSE 和 Runtime-local 工具。

本目录是 NexusPilot AI Runtime 的公开实现与事实来源。跨模块架构和开发约定见根目录 [AGENTS.md](../AGENTS.md)，具体行为以本 README、公开 API 契约和 `src/` 中的实现为准。

## 常用命令

```bash
# 当前 AI Runtime 开发服务，默认端口 8787
bun run ai-runtime:dev

# 当前 AI Runtime 单元与 route 测试
bun run ai-runtime:test

# 当前 AI Runtime 类型检查
bun run ai-runtime:typecheck

# 编译 AI Runtime sidecar 二进制
bun run ai-runtime:build

# Tauri app + 当前 AI Runtime dev sidecar
bun run dev:all
```

如需直接透传启动参数：

```bash
bun --cwd=ai-runtime run dev -- --host 0.0.0.0 --port 8787
bun --cwd=ai-runtime run start -- --host 127.0.0.1 --port 8787 --data-dir D:/tmp/nexpilot-ai-runtime
```

## API 文档

`ai-runtime` 使用 `@elysiajs/openapi` 提供交互式 API 文档：

- 文档页面：`http://127.0.0.1:8787/docs`
- OpenAPI JSON：`http://127.0.0.1:8787/docs/json`

Runtime sidecar 是专职本地服务，不使用综合业务后端常见的 `/api` 前缀。当前公开 API 统一位于 `/v1` 或健康检查根路径：

- `GET /health`
- `GET /v1/providers`
- `GET /v1/providers/:providerId`
- `GET /v1/catalog/status`
- `PUT /v1/providers/:providerId/config`
- `PUT /v1/providers/:providerId/models/:modelId/config`
- `POST /v1/custom-providers`
- `PUT /v1/custom-providers/:providerId`
- `DELETE /v1/custom-providers/:providerId`
- `POST /v1/catalog/refresh`
- `POST /v1/runs`
- `GET /v1/events`
- `GET /v1/conversations`
- `GET /v1/conversations/:conversationId`
- `GET /v1/conversations/:conversationId/messages?format=runtime|ui`
- `GET /v1/conversations/:conversationId/runs`
- `GET /v1/runs/:runId`
- `GET /v1/runs/:runId/events`
- `GET /v1/runs/:runId/traces`

## Run 契约

`POST /v1/runs` 创建并执行一次 Runtime Run。公开请求只表达运行意图、模型选择和用户输入；prompt、工具、limits、标题策略和权限策略由 Runtime 内部根据 Agent Definition 与 Prompt Assembly 决定。

```json
{
  "response_mode": "stream",
  "conversation_id": "conv_optional_existing",
  "model": {
    "provider_id": "openai",
    "model_id": "gpt-4o"
  },
  "agent_mode": "ask",
  "input": {
    "parts": [
      {
        "type": "text",
        "text": "你好"
      }
    ]
  },
  "metadata": {
    "source": "manual-test"
  }
}
```

约束：

- `response_mode` 必须显式传入，第一版仅支持 `stream`；不通过 `Accept` header 做内容协商。
- `conversation_id` 省略时创建新会话；传入时必须指向已有 Runtime conversation。
- `agent_mode` 默认 `ask`，第一版支持内置 `ask` 与 `agent`。
- `input.parts` 必填且非空；第一版只接受 `type: "text"`。
- `text`、`messages`、`system`、`limits`、`title`、`tools`、`profile_id` 和旧 `mode` 不是公开 Run 创建字段。

## 恢复与事件

消息记录 UI 的重启恢复走 Snapshot Read API：conversation 列表、conversation 详情、runtime/ui message history、Run 详情、Run events 和 traces 都从 Runtime Store 读取。

`GET /v1/events` 是 live-only Global EventBus/SSE。它只用于当前在线 UI 的轻量协调，例如会话状态变化、Run 状态变化、消息更新和 UI 控制事件；不提供 cursor/replay，不作为恢复来源。

## Runtime-local 工具

当前第一版工具范围限制在 AI Runtime 自身。`ask` 与 `agent` 都可以在内部策略允许时使用安全工具，例如 `web_fetch`。

`web_fetch` 只允许公开 `http(s)` URL，阻断 localhost、私网、链路本地、文档地址、benchmark、multicast、reserved 以及 IPv6 非公网地址；重定向目标和连接时 DNS 结果都会被校验。响应 preview 会被限制在 32 KiB，避免把完整网页内容持久化进 Runtime Store。

## 日志

`ai-runtime` 使用结构化 logger。独立开发运行时，默认控制台输出为彩色 pretty 格式，便于 sidecar 调试；如需机器可读 JSON lines，可通过环境变量切换。开发环境不写文件日志。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NEXUS_PILOT_LOG_LEVEL` | `info` | 日志等级，如 `debug`、`info`、`warn`、`error` |
| `NEXUS_PILOT_LOG_FORMAT` | `pretty` | `pretty` 输出彩色可读日志；`json` 输出 JSON lines |
| `NO_COLOR` | 未设置 | 设置后关闭 ANSI 颜色 |
| `FORCE_COLOR` | 未设置 | 设置后强制启用 ANSI 颜色 |

Logger 默认会脱敏 API key、authorization、cookie、连接密码等字段。不要在业务代码中记录完整 prompt、数据库结果集、连接 payload 或其他敏感数据。

生产环境由 Tauri 启动 sidecar，并强制注入 `NEXUS_PILOT_LOG_FORMAT=json` 与 `NO_COLOR=1`。sidecar 不自行打开日志文件；stdout/stderr 由 Tauri 接收，按 Pino level 转写到 `%LOCALAPPDATA%\\NexusPilot\\logs\\ai-runtime.log`。该文件与 Tauri 主进程的 `nexuspilot.log` 物理分离，均使用 2 MiB 单文件上限和当前文件加 7 个归档的轮转策略。

设置 `NEXUS_PILOT_LOG_LEVEL=debug` 后，自动会话标题流程会记录调用开始、模型响应、条件更新跳过和持久化完成，并只输出稳定标识、耗时、长度、usage 与跳过原因等诊断字段，不输出首条用户原文或标题正文。

## 架构入口

- `src/app.ts`：Elysia 应用组合、路由注册和服务启动入口。
- `src/provider/`：provider/model 目录、用户配置和 AI SDK 模型解析。
- `src/runtime/`：Run、Agent、Tool、Snapshot、EventBus 与持久化领域实现。
- `src/routes/`：健康检查、provider、Run、历史记录、事件和 OpenAPI 路由。
- `src/storage/`：Runtime SQLite 初始化、迁移和存储管理。

修改公开 API、provider/model 行为、运行策略或工具权限边界时，应同步更新本 README、相关类型和测试。
