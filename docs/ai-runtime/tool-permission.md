# AI Runtime Tool Permission 与 Run Continuation 设计

> 状态：V1 Runtime-owned Permission、Run continuation、AI SDK adapter、Frontend standard/strong confirmation、内部一次性 prepared plan，以及 SQL/Redis 高风险工具纵向链路已实现。
>
> 日期：2026-07-30。

本文定义 Runtime-owned Tool Permission、AI SDK approval adapter 和同一 Runtime Run continuation。Tool Namespace、Risk 和 Snapshot 见 [tool-namespace.md](./tool-namespace.md)；Run/Store 事实原则见 [runner-core.md](./runner-core.md)。

SQL 与 Key/Value 工具的稳定风险边界见 [Database tool safety model](./database-tools.md)。

## 1. 核心所有权

权限事实归属必须固定为：

~~~text
AI Runtime
  拥有 Tool policy、Permission decision、持久化、审计、恢复和最终执行授权

AI Runtime 内的 AI SDK adapter
  负责模型 tool calling、approval execution blocking 和 AI SDK-compatible stream 适配

Frontend
  渲染审批 UI、收集用户决定并提交给 AI Runtime
~~~

Runtime Store 中的 ToolCall、Permission 和用户 Permission command 是唯一权限事实来源。AI SDK message history 中的 approval request/response 只是一种 adapter 表达，不能单独授权工具执行。

用户批准也不能越过 Run Tool Snapshot、Agent execution ceiling 或 Core hard deny。

## 2. Policy Decision 与 Permission Status

策略效果与用户决定分开建模：

~~~ts
type RuntimePolicyDecision = "allow" | "ask" | "deny";

type ToolPermissionStatus =
  | "pending"
  | "approved"
  | "denied"
  | "cancelled";
~~~

- `allow/ask/deny`：Runtime Core 根据 Tool、resolved risk、Snapshot ceiling 和 hard guardrail 得出的策略效果；
- `pending/approved/denied/cancelled`：一条 Permission 的生命周期；
- `allow`：不创建等待中的 Permission，进入 executor；
- `ask`：创建 Permission 并停止当前 AI SDK execution segment；
- `deny`：Core 直接拒绝，真实 executor 不得运行；
- `cancelled`：Run 已中断、Runtime 重启或已无法继续，不表示用户主动拒绝。

第一版不保留把 `allow_once/deny_once/ask` 混在同一 response enum 的旧模型，可以进行破坏性迁移。

第一版默认 policy threshold：

~~~text
low       -> allow
medium    -> ask + standard confirmation
high      -> ask + standard confirmation
critical  -> ask + strong confirmation
hard deny / ceiling exceeded -> deny
~~~

后续设置页可以收紧或有限放宽 threshold，但第一版不允许 `high` 或 `critical` 自动批准。

## 3. 最小 Permission Contract

~~~ts
interface ToolPermission {
  id: PermissionId;
  conversationId: ConversationId;
  runId: RunId;
  messageId: MessageId;
  toolCallId: ToolCallId;

  status: ToolPermissionStatus;
  toolId: string;
  title: string;
  inputSummary?: string;
  risk: ResolvedToolRisk;
  confirmation: {
    level: "standard" | "strong";
    prompt?: string;
  };
  presentation?: PermissionPresentation;

  adapter?: {
    aiSdkApprovalId?: string;
    aiSdkToolCallId?: string;
  };

  decision?: {
    source: "user" | "system";
    reason?: string;
    confirmationVerified?: boolean;
    decidedAt: number;
  };

  createdAt: number;
}
~~~

L1-B 契约实现在 `ai-runtime/src/runtime/tools/contracts/permission.ts`，持久化实体与 Snapshot 投影定义在 Runtime Core。Permission 状态机、读取 API、continuation 和 Frontend adapter 已经可用。

约束：

- 第一版 Permission 只授权一个不可变 ToolCall，`toolCallId` 必填；
- ToolCall 进入等待后，规范化 input 不可修改；
- 不引入 input/plan hash；ToolCall identity 与不可变 input 已构成第一版绑定；
- 相同输入的下一次模型调用仍产生新的 ToolCall 和 Permission；
- `risk` 保存本次调用的 resolved risk，而不是只保存静态 Tool baseline；
- `inputSummary`、title 和 risk 可供 UI/审计使用，但不得包含 secret；
- `PermissionId` / `ToolCallId` 是 Runtime 对外 canonical ID；AI SDK `approvalId` / `toolCallId` 只保存在 adapter mapping 与 ToolPart projection metadata 中。

高风险 Tool 使用以下已实现的确认级别：

~~~ts
type ConfirmationLevel = "standard" | "strong";

interface ToolPermissionConfirmation {
  level: ConfirmationLevel;
  prompt?: string;
}
~~~

- `medium/high` 使用 standard confirmation；
- `critical` 使用 strong confirmation；
- strong confirmation 必须由 Runtime 校验 exact confirmation text，Frontend 的 `approved=true` 不能单独授权；
- confirmation prompt 只包含安全 target 摘要，不包含 credential、SQL literal secret 或 Redis value；
- strong confirmation 仍不能越过 Snapshot ceiling、Core hard deny 或 Rust capability/precondition。

### 3.1 Mutation Plan Binding

第一版 mutation 不新增公共或持久化的 `inputHash` / `planHash`。Permission 继续只授权不可变 ToolCall；ToolCall identity 与等待后不可修改的规范化 input 是 Runtime 侧绑定。

需要动态分析的 Backend Tool 使用内部一次性 prepared plan：

~~~text
ToolCall
  -> trusted prepare/analyze operation
  -> planId bound to toolCallId/profile/context/exact payload
  -> Permission
  -> same ToolCall consumes plan once
~~~

约束：

- `planId` 不属于模型 inputSchema，也不由 Frontend 提交；
- plan 短时有效，只能消费一次；
- plan 过期、重复消费、ToolCall/target 不匹配时 fail closed；
- Runtime/Rust 重启或 Run interrupt 后 plan 失效；
- Redis value/type fingerprint 属于内部 resource precondition，不上升为通用 input hash；
- 系统不自动重新 prepare、重放或复用旧 Permission。

## 4. 授权与持久化顺序

Core dispatch 流程：

~~~text
ToolCall
  -> 校验 Run Snapshot、active tool、inputSchema 和 limits
  -> 解析 resolved risk
  -> Core policy: allow | ask | deny

allow
  -> 持久化 ToolCall start
  -> 执行 Tool

ask
  -> 原子保存 ToolCall / Permission / Run / Conversation / durable Event
  -> 再输出 approval-requested

deny
  -> adapter 返回自动拒绝结果，不创建 pending Permission
  -> 不进入 executor

authorization error
  -> 持久化 ToolCall.error / RuntimeToolResult.error / durable Event / warn Trace
  -> adapter 以 AI SDK automatic denied 作为非致命传输
  -> 模型收到稳定错误事实并继续同一个 ToolLoop
~~~

进入等待时必须先完成一个 Runtime Store transaction：

~~~text
ToolCall    -> waiting_for_permission
Permission  -> pending
Run         -> waiting_for_permission
Conversation-> waiting_for_permission
Event       -> permission.requested
~~~

transaction 成功后，AI SDK adapter 才能向 UI stream 输出 `approval-requested`。这样即使 stream 或 Frontend 随后断开，Snapshot 仍可恢复 pending Permission。

## 5. AI SDK Adapter

当前依赖未冻结。实现批次允许并倾向于把 AI SDK、Provider packages、Web `@ai-sdk/react` 和 assistant-ui adapter 升级到当时最新、互相兼容的稳定版本，不维护 v6/v7 双轨。

在业务边界不被削弱的前提下，优先使用 AI SDK 已有能力：

- `ToolLoopAgent` 和多步 tool loop；
- 调用或 Agent 级 `toolApproval`；
- `tool-approval-request/response`；
- UI `approval-requested/approval-responded` state；
- `addToolApprovalResponse`；
- `lastAssistantMessageIsCompleteWithApprovalResponses`；
- `isStepCount`、`onStepEnd`、`onEnd` 和 `stream()`。

映射规则：

~~~text
Runtime policy allow -> AI SDK toolApproval = undefined / not-applicable
Runtime policy ask  -> AI SDK toolApproval = user-approval
Runtime policy deny -> Core 内部拒绝，不进入真实 executor
Runtime ToolCall error -> AI SDK automatic denied，仅作为非致命错误传输
~~~

AI SDK approval 只承担执行阻断与 stream/message part 适配。Runtime Core 仍需在 continuation 时读取并校验持久化 Permission，不能因为 AI SDK message history 含有 `approval-response` 就直接执行。AI SDK 7 的 `toolApproval` 没有独立的 preflight-error 状态，因此 Core 在 input/identity/risk/prepare/permission description 等审批前置阶段产生的 ToolCall error，adapter 使用带稳定、脱敏 reason 的 automatic `denied` 传输给 ToolLoop。该 automatic request/response 不创建、不绑定 Runtime Permission，也不得在 UI 中投影成“用户拒绝”；Runtime Store 中 `ToolCall.state=error` 与 `RuntimeToolError` 始终是权威事实。

AI SDK 7 已将 Tool Definition 上的 `needsApproval` 标记为兼容性废弃接口，新实现统一使用调用或 Agent 级 `toolApproval`。

实验性 AI SDK hook 不作为 Runtime Permission 的必要依赖。实现时必须重新核对 [AI SDK 官方文档](https://ai-sdk.dev/llms.txt) 和安装版本的 bundled docs/source。

## 6. 同一 Run Continuation

AI SDK 在工具需要审批时会结束当前 generation/agent segment，并返回 approval request。用户决定后，需要第二个模型调用继续，但 Runtime 语义上仍是同一个 Run。

审批前后必须保持：

- 同一个 Runtime Run；
- 同一个 assistant Message；
- 同一个 Run Tool Snapshot；
- 同一个 Agent Mode、Provider 和 Model；
- 同一组累计 max steps、max ToolCalls、timeout/usage limits。

一个 Runtime Run 可以包含多个 AI SDK execution segment，但 continuation 不重新解析 Namespace、不修改 active tools、不创建新 Run，也不重置累计 limits。

公开业务命令：

~~~text
POST /v1/runs/:runId/continue
~~~

~~~json
{
  "permission_responses": [
    {
      "permission_id": "perm_...",
      "approved": true,
      "confirmation_text": "确认在 Production MySQL 执行",
      "reason": "用户确认执行"
    }
  ]
}
~~~

响应是同一 Run 的 AI SDK-compatible continuation stream。请求只接受 Runtime Permission IDs、用户决定和 strong confirmation 所需的可选 `confirmation_text`，不接受完整 AI SDK message history 作为权限事实。standard confirmation 忽略或拒绝多余 confirmation text 的具体 HTTP 语义由 route contract 实现时固定；critical Permission 缺失或不匹配 confirmation text 必须 fail closed。

Runtime 在原子提交 Permission 决策前，必须完成 provider/model 解析、Agent policy 重建、冻结 Tool Snapshot 校验、active Tool definition 校验和 continuation message 构造。上述无副作用 preflight 失败时，Run 与 Permission 保持 `waiting_for_permission/pending`，用户可以在修复 Provider 配置后重新提交；不得先消耗 Permission 再返回 Provider 错误。原子提交成功后若 continuation bootstrap 仍发生 Runner/Store 异常，Run、Conversation、Assistant Message 与未完成 ToolCall 必须收敛到可审计终态，不能残留 `running/busy`。

## 7. 多 Permission 与并发控制

同一个 AI SDK segment 可以产生多个 approval requests。V1 不增加 `PermissionBatch` 实体：

- 每个 ToolCall 对应一条独立 Permission；
- continuation 请求必须覆盖当前 Run 的全部 pending Permissions；
- 少传、重复、混入其他 Run 或非 pending Permission 时 fail closed；
- 所有用户决定在一个 transaction 中写入后，只启动一次 continuation；
- Run 级 mutex 防止两个 continuation 并发执行；
- 同一 Permission 的第一次有效决定生效，重复或冲突提交返回 `409`。

支持多个审批请求不代表并行执行 Tool。后续真实执行顺序继续遵循 AI SDK tool loop 与 Runtime Core 的 ToolCall 顺序/并发策略。

## 8. Frontend 边界

Frontend 负责：

- 从 AI SDK-compatible stream 或 Snapshot 渲染 pending Permission；
- Snapshot 恢复时保留 AI SDK `toolCallId` / `approvalId` adapter identity，确保同一 assistant Message 的 continuation output 能更新原工具卡；待审批工具应自动展开执行消息组、工具组与具体工具卡，用户批准后仅自动折叠对应工具卡，且保留手动重新展开能力；
- 展示 Tool、target/context、input summary、resolved risk 和 risk reasons；
- 对原始 SQL strong confirmation 展示完整、不可编辑的 SQL；
- 对 Redis mutation 展示连接、DB、操作、完整 Key、rename destination、value type 与 TTL；value 与内部 fingerprint 不进入审批快照；
- `key_value.delete` 与 expire TTL 必须 strong confirmation，create/set/rename/persist TTL 使用 standard confirmation；
- 收集 approve/deny、可选 reason 与 strong confirmation text；
- 通过自定义 transport 调用 `/v1/runs/:runId/continue`；
- 渲染 continuation stream。

Frontend 不负责：

- 重新计算 Tool policy 或 risk；
- 把本地 AI SDK message state 当作权限事实；
- 修改等待中的 Tool input 或 prepared plan；
- 直接调用 Backend Bridge/Rust Gateway；
- 在 EventBus 上发送审批命令。

在不削弱 Runtime 边界的前提下，Frontend 可复用 AI SDK `addToolApprovalResponse` 和自动继续 helper。如果 assistant-ui adapter 无法自然接入，可使用专用 Permission handler，不强制套用 SDK hook。

## 9. 拒绝、失败与重试

- 用户拒绝不是 Run failure；它作为正常 Tool/approval 结果交回模型，模型可选择解释、换方案或结束；
- 能归属到具体 ToolCall 的失败不是 Run failure。该边界覆盖 Core 输入与 identity 校验、Snapshot/active tool 校验、risk resolution、Backend prepare、prepared plan 校验、Permission description、执行、timeout、Bridge/Gateway、输出校验和结果大小限制；
- 上述失败统一持久化为 `ToolCall.state=error` 和 `{ ok: false, error: RuntimeToolError }`，再作为模型可见的非致命工具结果继续 ToolLoop；不得让 `toolApproval` Promise rejection 或 Tool executor exception 直接升级为 Run failed；
- Tool 执行失败不自动重试；`RuntimeToolError` 应提供 `code`、`message`、`retryable` 和 `outcome`；
- 已批准后 Tool/Bridge 失败，不复用 Permission 自动重试；模型若决定重试，必须创建新 ToolCall；
- 用户批准不能跳过执行时的 Bridge、resource 和 capability 检查；
- 数据库返回权限不足是后端业务错误，不转换为 Runtime Permission pending/denied；
- `outcome=unknown` 仍是 ToolCall error，不终止 Run，但 adapter 必须明确告知模型结果未知且禁止自动重试；
- Provider API/模型 stream 失败、Runtime Store 无法可靠持久化、Runner 自身故障，以及其他无法归属具体 ToolCall 的系统异常仍可终止 Run。不能为了维持表面上的 completed 状态而吞掉这些基础设施故障。
- 等待审批期间 Provider/Model 被禁用或删除时，continuation preflight 在 Permission transaction 前失败并保留 pending 状态；Permission transaction 后发生的 bootstrap 故障则终止 Run 并清理 active 状态，二者都不得留下虚假的 `running/busy`。

## 10. Interrupt、刷新与重启

- Frontend 刷新或错过 EventBus 通知时，从 Runtime Snapshot 恢复 pending Permission；
- 等待中的 Run 被 interrupt 时，所有 pending Permission 转为 `cancelled`；
- AI Runtime 重启时，等待中的 Run 转为 `interrupted`，pending Permission 转为 `cancelled`；
- V1 不支持跨进程 continuation；
- Permission 已 cancelled/denied/approved 后不能再次改变决定；
- continuation stream 断开不把 EventBus 变成恢复通道，最终事实仍从 Runtime Store/Snapshot 读取。

## 11. Event 与审计

Permission durable event 统一为：

~~~text
permission.requested
permission.resolved
~~~

`permission.resolved` 覆盖 approved、denied 和 cancelled。EventBus 只发布对应的低频失效通知，不承载审批命令、AI SDK continuation stream 或权限事实。

审计至少保留：

- Permission ID、ToolCall ID、Run ID、Message ID；
- canonical Tool ID；
- resolved risk；
- 脱敏 input summary；
- decision source、status、reason 和时间；
- confirmation level 与 strong confirmation 是否校验通过；默认不持久化用户输入的完整 confirmation text；
- AI SDK approval ID adapter mapping（如果存在）。

## 12. 实施顺序与延期项

Permission 基础契约、Store migration、原子等待提交、单次状态转换、interrupt/startup repair 收敛、Run continuation mutex、`POST /v1/runs/:runId/continue`、AI SDK 7 `toolApproval` adapter、Permission Snapshot API、Frontend standard/strong confirmation、内部一次性 prepared plan，以及 SQL/Redis 高风险纵向链路已经实现。Runtime 会保存服务端产生的 AI SDK continuation messages，并在全量 Permission 决策原子提交后，以同一个 Run、Assistant Message、Tool Snapshot 和累计 limits 继续；客户端 message history 不参与授权。critical approval 必须同时提供与 Runtime prompt 逐字一致的 confirmation text，Store 只记录校验通过事实，不保存用户输入文本。动态 Backend Tool 的 `planId` 只存在于 Runtime/Rust 进程内注册表和受控 execute 请求中；模型 schema、Frontend continuation、ToolCall 与 Permission 都不持有它。等待 input 改动、plan 缺失/过期/重复消费/identity 不匹配不会触发自动重新 prepare。

`sql.execute` 的默认 medium/high 调用走 standard confirmation，critical/uncertain 调用走 strong confirmation；SQLite、MySQL、PostgreSQL、Oracle 与 ClickHouse 均已通过代码和本地 Driver 启用门。`key_value.create/set/rename` 与 persist TTL 解析为 high standard，expire TTL 与 exact delete 解析为 critical strong。Redis prepare 把审批时的 `DUMP` value fingerprint 写入内部 plan，execute 使用 WATCH/CAS 拒绝审批后的值漂移；fingerprint 不包含 TTL，也不进入公共 Permission。

Phase 8 已加入 Runtime-owned `none / low / medium` 自动审批阈值。默认 `low` 保持原行为；`none` 让 low 也进入 standard approval；`medium` 允许 low/medium 自动执行。high/critical 在所有档位始终 ask，critical 始终 strong confirmation。阈值在新 Run 的 Tool Snapshot 中冻结，设置更新不修改既有 Run 或 pending Permission；Core execution ceiling 与 hard deny 仍先于该策略。完整设置契约见 [settings.md](./settings.md)。

Oracle 与 ClickHouse 外部真实库 smoke 仍待测试服务分别从 `early eof` 与 `SendRequest` timeout 恢复后复验。

以下内容延期：

- “始终允许/始终拒绝”与 remembered grant；
- 按 Tool、Namespace、连接或 workspace 保存授权；
- grant expiry、撤销和管理 UI；
- 企业 RBAC；
- PermissionBatch；
- 跨 Runtime 重启恢复审批；
- 公共 input/plan hash；
- 跨 Runtime 重启恢复 prepared mutation plan；
- 系统级 mutation retry/replay 与 destructive operation 自动恢复；
- subagent/multi-agent 权限委派。

首个 mutation/destructive Tool 已确认使用一次性 `planId`、single-consume、明确 outcome 和 no automatic retry 建立最小闭环；它不引入通用 hash、跨进程 plan 恢复或系统级重放。
