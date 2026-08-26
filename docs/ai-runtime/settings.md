# AI Runtime 设置

本文描述由 AI Runtime 自己拥有、持久化和执行的用户偏好。它与 Tauri/Frontend 本地应用设置分属不同事实域：Frontend 负责呈现与发起修改，AI Runtime 才是本域设置的权威来源。

## 1. 当前设置

当前开放两类 Runtime-owned 偏好：工具自动审批阈值和 web 工具的网络访问范围。

```ts
type AutoApproveMaxRisk = "none" | "low" | "medium";
```

| 设置值 | low | medium | high | critical |
| --- | --- | --- | --- | --- |
| `none` | ask | ask | ask | ask + strong confirmation |
| `low`（默认） | allow | ask | ask | ask + strong confirmation |
| `medium` | allow | allow | ask | ask + strong confirmation |

`high` 与 `critical` 不属于合法设置值，也不能通过 HTTP 请求、持久化配置或 Frontend 控件开启自动执行。Core execution ceiling、inactive Tool、capability、输入校验和其它 hard deny 始终先于本设置；用户审批同样不能越过这些边界。

```ts
type NetworkAccessScope = "local-and-public" | "public-only";
```

| 设置值 | 适用对象 | 语义 |
| --- | --- | --- |
| `local-and-public`（默认） | `web.fetch`、`web.ping` | 允许本机可达的公网、内网、VPN、容器网络和 localhost。 |
| `public-only` | `web.fetch`、`web.ping` | 拒绝 loopback、private、link-local、reserved 地址以及解析到这些地址的 hostname。 |

该范围不是通用网络代理开关：`web.fetch` 仍只允许无凭据的 HTTP(S) 读取，并继续受重定向逐跳校验、超时和结果大小上限约束；`web.ping` 只接受一个 hostname 或 IP，以固定次数和超时运行系统 `ping`，不接受端口、CIDR、范围或任意命令行参数。

若 `public-only` 因此拒绝 `web.fetch` 或 `web.ping`，工具结果会返回稳定错误码 `NETWORK_ACCESS_SCOPE_DENIED`。该错误明确表示这是用户偏好造成的范围拒绝，而不是 URL 格式、DNS 或连通性故障；它带有安全的修复信息，建议将 `network_policy.access_scope` 改为 `local-and-public`，且只对新 Run 生效。仅在这个错误的 `details.guidance` 中，模型才会获得“仅在必要时提示设置路径、不得自动修改设置、设置未变时不得重复调用”的短引导；该低频引导不进入工具的常驻 description。`new_run` 是 Runtime 的冻结事实，不是要求模型解释或自行操作的用户交互概念。

## 2. 所有权与持久化

设置文件位于 AI Runtime data directory：

```text
<data-dir>/runtime-settings.json
```

当前格式：

```json
{
  "tool_policy": {
    "auto_approve_max_risk": "low"
  },
  "network_policy": {
    "access_scope": "local-and-public"
  }
}
```

持久化规则：

- 默认值集中定义在 `ai-runtime/src/settings/defaults.ts`，避免把默认值散落在 route、service、tool executor 或 Frontend；
- 文件不存在时使用完整默认快照：工具阈值 `low`、网络范围 `local-and-public`；
- 对已知顶层分组 `tool_policy`、`network_policy`，文件中缺失的分组按对应默认值补齐，以兼容旧设置文件；
- 文件存在但 JSON 损坏、包含未知字段、已存在分组缺少字段，或字段值非法时 fail safe 到工具阈值 `none`、网络范围 `public-only`，并记录不包含设置正文的 warning；
- 写入先生成同目录临时文件，再以 rename 原子替换正式文件；
- 该文件不包含 credential，不复用 `providers.json`；
- 该设置不写入 Runtime SQLite。Runtime SQLite 继续只承载 Conversation、Run、Message、ToolCall、Permission、Event 和 Trace 等运行事实。

配置损坏时不会自动覆盖原文件。用户通过合法 API 更新后，Runtime 才写入新的有效快照。

## 3. HTTP 契约

读取完整 Runtime 设置：

```text
GET /v1/settings
```

响应：

```json
{
  "tool_policy": {
    "auto_approve_max_risk": "low"
  },
  "network_policy": {
    "access_scope": "local-and-public"
  }
}
```

更新完整 Runtime 设置：

```text
PUT /v1/settings
Content-Type: application/json

{
  "tool_policy": {
    "auto_approve_max_risk": "medium"
  },
  "network_policy": {
    "access_scope": "local-and-public"
  }
}
```

`PUT /v1/settings` 是唯一的设置写接口，要求提交完整快照。`tool_policy.auto_approve_max_risk` 只接受 `none`、`low`、`medium`；`network_policy.access_scope` 只接受 `local-and-public`、`public-only`。`high`、`critical`、未知值、任何缺失字段和额外字段均返回 `422`。生产模式下两个 endpoint 与其它 `/v1/**` 路径一样受 per-launch Runtime access token 保护。

这种完整替换语义让设置 API 随字段增长保持稳定：后续设置项只扩展 `GET /v1/settings` 与 `PUT /v1/settings` 的同一快照契约、默认值、持久化解析和前端表单，不为每个设置项新增 route。Frontend 更新某个控件前必须基于最近一次 Runtime 返回的完整快照合成新值，避免遗漏未知的已有字段。

## 4. Per-Run 冻结语义

Runtime 在创建新 Run 时读取当前设置，并把审批策略写入该 Run 的 immutable Tool Snapshot：

```ts
interface RunToolSnapshot {
  // ...
  approvalPolicy?: {
    autoApproveMaxRisk: "none" | "low" | "medium";
  };
  networkPolicy?: {
    accessScope: "local-and-public" | "public-only";
  };
}
```

新 Snapshot 总是写入 `approvalPolicy` 与 `networkPolicy`。字段在 schema 中保持 optional，仅用于读取引入字段之前已经持久化的历史 Run；`approvalPolicy` 缺失时按旧默认 `low` 解释，`networkPolicy` 缺失时按 `local-and-public` 解释。

执行顺序：

```text
Tool definition baseline
  -> dynamic resolved risk
  -> Snapshot execution ceiling / Core hard guardrail
  -> Snapshot approvalPolicy
  -> allow / ask
  -> standard 或 strong confirmation
```

设置更新只影响之后创建的新 Run：

- 已创建 Run 的 Snapshot 不修改；
- 已创建 Run 的 web 工具继续使用其冻结的网络范围；
- waiting Run continuation 从 Runtime Store 恢复并深冻结原 Snapshot；
- pending Permission 的 risk、confirmation 和 presentation 不修改；
- 不重算已经完成、拒绝或取消的 Permission；
- 不产生跨 Run remembered grant。

## 5. Frontend 边界

设置页在现有“AI 偏好设置”面板中使用 `SettingsSection` 呈现“工具审批”和“网络访问范围”，通过 TanStack Query 调用 Runtime API：

- query 读取 `GET /v1/settings`；
- 两个控件都基于最新 query cache 合成完整设置快照，并调用唯一的 `PUT /v1/settings`；
- 更新成功后替换对应 query cache；
- 不做 optimistic update，失败时继续显示 Runtime 最近一次确认的事实；
- AI Runtime 不健康时沿用统一 availability gate。

该设置不进入 `useSettingsStore()`、`types/settings.ts` 或 Tauri Store。那些位置只负责 Frontend/Tauri 本地应用偏好，不能成为 Runtime 工具权限的第二权威来源。

## 6. 明确延期

当前不实现：

- per-connection 或 environment override；
- production hard policy；
- remembered allow/deny grant；
- grant expiry、撤销和管理 UI；
- Permission 审计浏览器；
- enterprise RBAC；
- high/critical 自动审批；
- 端口、CIDR、子网扫描、任意系统网络命令或 Runtime 作为通用 HTTP 代理；
- 修改既有 Run Snapshot 或 pending Permission。

这些能力如果后续加入，必须保持 Core hard guardrail 优先、策略来源可审计，并明确多个策略层之间的“更严格者优先”合成规则。
