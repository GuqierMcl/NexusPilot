# Workbench Status Bar 接入指南

> 本文档说明 Workbench 底部状态栏的定位、左右区域职责边界、注册制接入方式和展示文案约束。状态栏应作为当前工作上下文的低干扰摘要层，而不是新的集中枚举入口。

---

## 1. 定位

Workbench Status Bar 是工作台级状态摘要层，位于三栏工作区下方：

```text
MainLayout
├── AppTitleBar
├── Workbench Main Area
│   ├── NavigationRail
│   └── ResizablePanelGroup
│       ├── WorkbenchExplorerPanel
│       ├── WorkbenchContentPanel
│       └── WorkbenchAgentPanel
└── WorkbenchStatusBar
```

它不是全局 App 状态栏，也不是 Agent Panel 内部工具栏。状态栏只读取和展示状态，不拥有连接、查询、AI 调用、表格事务或 Redis 编辑等核心业务状态。

状态栏需要“有呼吸但不吵闹”：没有 active tab、没有运行中任务、没有异常时，也应显示一个轻量心跳状态 `已就绪`，避免整条状态栏空白造成“卡住”错觉。

核心职责：

```text
active tab + connection session → 当前连接状态
active tab payload + runtime state → 当前数据库 / schema / table / key 上下文
active tab execution state → 查询运行中、最近结果或错误摘要
active tab dirty / selection / transaction state → 未保存更改、选区、分页、事务提示
global summary / warning state → 连接数量、AI Runtime 异常等全局摘要
readiness fallback → 没有更强状态时显示“已就绪”
```

禁止职责：

```text
StatusBarItem 内部建立数据库连接
StatusBarItem 内部执行 SQL
StatusBarItem 内部请求 LLM
StatusBarItem 内部提交或回滚事务
新增 StatusBar 专用业务 store 管理连接、查询或编辑状态
公共状态栏组件按 TabType、driver 或 node type 写业务分支
健康状态常驻展示为噪音，例如 AI Ready
```

状态栏文案统一使用中文。示例：

```text
已就绪
已连接
正在连接
连接失败
正在查询
查询失败
2 个更改
事务中
建议回滚
正在编辑值
表结构有未保存更改
2 个连接在线
AI 暂不可用
```

---

## 2. 左右区域边界

状态栏只提供左侧和右侧两个区域，不提供中间区域。

一句话规则：

```text
动作和上下文在左，数字和全局在右。
当前工作在左，环境摘要在右。
需要处理当前 tab 的在左，只需要扫一眼的在右。
```

### 2.1 左侧：当前工作状态区

左侧回答：

```text
当前应用是不是正常？
我当前在哪个数据库 / schema / 表 / Redis Key 上？
当前这个工作面有没有正在运行或需要处理的事？
```

放左侧的状态满足下面任意一条：

| 判断问题 | 结论 |
| --- | --- |
| 这是当前 tab 正在做的事吗？ | 左侧 |
| 这是当前 tab 的错误、风险、dirty、事务、编辑态吗？ | 左侧 |
| 这是当前对象路径，例如 database / schema / table / key 吗？ | 左侧 |
| 这是没有其他状态时的心跳，例如 `已就绪` 吗？ | 左侧 |
| 这个状态是否需要用户马上处理当前 tab？ | 左侧 |

左侧典型状态：

```text
已就绪
正在连接
已连接
连接失败
正在查询
查询失败
建议回滚
事务中
2 个更改
正在编辑值
正在新建 Key
表结构有未保存更改
app / public / very_long_table_name
Redis DB 0 · very:long:redis:key
```

左侧推荐展示顺序：

```text
主状态 → 当前连接状态 → 当前上下文
```

主状态优先级：

```text
错误 / 危险 > 正在运行 > 未保存 / 事务 / 编辑态 > 已就绪
```

示例：

```text
已就绪 · 已连接 · app / public / users
正在查询 · 已连接 · app / public
查询失败 · app / public
建议回滚 · app / public / users
正在编辑值 · Redis DB 0 · user:1
```

### 2.2 右侧：摘要与计数区

右侧回答：

```text
当前结果有多少？
当前选中了多少？
当前页码是多少？
全局有没有连接或 AI Runtime 这种后台异常？
```

放右侧的状态满足下面任意一条：

| 判断问题 | 结论 |
| --- | --- |
| 这是数量、页码、选区、结果行数吗？ | 右侧 |
| 这是全局连接数量、AI Runtime、更新提醒这类全局摘要吗？ | 右侧 |
| 这个状态只是辅助判断，而不是当前主状态吗？ | 右侧 |
| 这个状态是后台 / 全局需要注意，但不属于当前 tab 吗？ | 右侧 |

右侧典型状态：

```text
2 个连接在线
1 个连接中
1 个连接异常
42 行
2 行选中
第 2 / 3 页
AI 暂不可用
```

右侧推荐展示顺序：

```text
当前视图计数 → 全局连接摘要 → 全局异常
```

右侧空间紧张时，保留优先级：

```text
全局异常 > 当前视图关键计数 > 普通连接摘要
```

示例：

```text
42 行 · 2 个连接在线
2 行选中 · 第 2 / 3 页 · 2 个连接在线
第 2 / 3 页 · 1 个连接异常 · AI 暂不可用
```

### 2.3 禁止中间区域

状态栏不提供 center area。类型层面不应出现：

```ts
area: "center"
```

合法区域只有：

```ts
area: "left" | "right"
```

如果新增状态时无法判断放哪边，按下面规则处理：

```text
动作 / 上下文 / 当前 tab 风险 → left
计数 / 页码 / 选区 / 全局摘要 / 全局异常 → right
```

---

## 3. 目标目录职责

目标目录结构：

```text
src/features/workbench/status-bar/
├── WorkbenchStatusBar.tsx
├── components/
│   └── StatusBarItem.tsx
├── contributors/
│   ├── active-context-status-contributor.tsx
│   ├── ai-runtime-warning-status-contributor.tsx
│   ├── connection-status-contributor.tsx
│   ├── connection-summary-status-contributor.tsx
│   ├── key-value-status-contributor.tsx
│   ├── readiness-status-contributor.tsx
│   ├── sql-editor-status-contributor.tsx
│   ├── table-data-status-contributor.tsx
│   └── table-design-status-contributor.tsx
├── hooks/
│   └── useWorkbenchStatusItems.ts
├── overlays/
│   ├── workbench-status-overlay-store.ts
│   ├── WorkbenchStatusOverlayHost.tsx
│   └── ExecutionOverviewDrawer.tsx
├── status-bar-contributor-registry.ts
└── types.ts
```

职责边界：

| 文件 | 职责 |
| --- | --- |
| `WorkbenchStatusBar.tsx` | 状态栏整体布局、左右区域划分、调用 `useWorkbenchStatusItems` 渲染统一 item model |
| `components/StatusBarItem.tsx` | 统一状态项外观和 Tooltip，支持 `icon`、`label`、`title`、`tooltipContent`、`tone`、`onClick`、`onMouseEnter`、`onMouseLeave`、`width` |
| `contributors/*` | 各业务面向状态栏贡献 item；允许读取对应业务状态并处理业务差异 |
| `status-bar-contributor-registry.ts` | 注册内置 contributor；只做注册，不实现业务逻辑 |
| `hooks/useWorkbenchStatusItems.ts` | 从现有 store 派生 `WorkbenchStatusContext`，调用 contributor 并排序过滤 |
| `overlays/workbench-status-overlay-store.ts` | 只保存状态栏导航触发的通用 overlay request；不保存 execution 业务状态 |
| `overlays/WorkbenchStatusOverlayHost.tsx` | Workbench 内容壳唯一挂载的 overlay 分发入口 |
| `overlays/ExecutionOverviewDrawer.tsx` | 多个后台 execution 目标的轻量导航列表，只负责 focus tab + open detail |
| `types.ts` | 定义状态栏共享类型、context 和 item model |

`WorkbenchStatusBar.tsx` 不应包含复杂条件判断。`useWorkbenchStatusItems.ts` 可以收集 store 状态和调用 registry，但不应承载具体 `sql_editor`、`table_data`、`key_value` 或 `table_design` 的展示规则。

---

## 4. Contributor 模型

状态栏使用 contributor registry，而不是固定挂载一组 `ConnectionStatusItem` / `QueryStatusItem` / `AgentStatusItem` 组件。

推荐类型：

```ts
export type WorkbenchStatusItemArea = "left" | "right";

export type WorkbenchStatusItemTone =
    | "default"
    | "muted"
    | "success"
    | "warning"
    | "error";

export type WorkbenchStatusItemWidth = "compact" | "content" | "elastic";

export interface WorkbenchStatusContext {
    activeTab: WorkbenchTab | null;
    tabs: WorkbenchTab[];
    connectionSessions: Record<string, ISessionState>;
    tabRuntimeState: TabRuntimeStateSnapshot;
    layout: {
        leftSidebarCollapsed: boolean;
        rightSidebarCollapsed: boolean;
    };
    aiRuntime: {
        healthStatus: AiRuntimeHealthStatus;
        isChecking: boolean;
        errorMessage?: string | null;
    };
    agent: {
        composerSendBlocker: AgentComposerSendBlocker | null;
    };
    nowMs: number;
    actions: {
        focusTab(tabId: string): void;
        openSqlExecutionDetails(tabId: string): void;
        openExecutionOverview(tabIds: string[]): void;
    };
}

export interface WorkbenchStatusItemModel {
    id: string;
    area: WorkbenchStatusItemArea;
    priority: number;
    visible?: boolean;
    icon?: React.ElementType;
    iconClassName?: string;
    label: string;
    title?: string;
    tooltipContent?: React.ReactNode;
    tone?: WorkbenchStatusItemTone;
    width?: WorkbenchStatusItemWidth;
    onClick?: () => void;
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
}

export interface WorkbenchStatusContributor {
    id: string;
    getItems: (context: WorkbenchStatusContext) => WorkbenchStatusItemModel[];
}
```

公共状态栏只消费 `WorkbenchStatusItemModel[]`：

```text
existing stores
  → useWorkbenchStatusItems
  → STATUS_BAR_CONTRIBUTORS
  → WorkbenchStatusItemModel[]
  → WorkbenchStatusBar
  → StatusBarItem

navigation-only item action
  → focus one tab + open detail
  → or open multi-target overview through WorkbenchStatusOverlayHost
```

---

## 5. 宽度策略

状态栏不能过早截断表名、schema、Redis Key 等身份信息。`StatusBarItem` 不应对所有 item 使用固定 `max-w-64`。

item 使用三种宽度策略：

| width | 用途 | 行为 |
| --- | --- | --- |
| `compact` | 短状态、计数、全局摘要 | 不抢空间，内容多宽就多宽 |
| `content` | 普通状态 | 按内容展示，可在极端空间下截断 |
| `elastic` | database / schema / table / Redis Key 等上下文身份 | 吃左侧剩余空间，尽量完整显示 |

应用规则：

```text
已就绪、正在查询、查询失败、2 个更改 → compact 或 content
app / public / very_long_table_name → elastic
Redis DB 0 · very:long:key → elastic
42 行、第 2 / 3 页、2 个连接在线 → compact
AI 暂不可用、正在恢复对话、1 个连接异常 → compact
```

布局约束：

```text
footer
├── left area: flex-1 min-w-0
│   ├── 主状态 compact/content
│   ├── 当前连接 compact/content
│   └── 当前上下文 elastic
└── right area: shrink-0 max-w-[50%]
    ├── 计数 compact
    ├── 连接摘要 compact
    └── 全局异常 compact
```

极端超长内容仍可能因为物理空间不足而截断，但必须保留 tooltip 显示完整值。正常宽度下，长表名和 Redis Key 应尽量完整显示。

---

## 6. 内置 Contributor

### 6.1 Readiness 状态

数据源：其他 contributor 产出的状态或 active context。

推荐展示：

```text
没有更强主状态 → 已就绪
存在错误 / 运行中 / dirty / 事务 / 编辑态 → 不显示已就绪
```

`已就绪` 是左侧兜底心跳，避免状态栏空白。它不是全局成功提示，不应放右侧。

### 6.2 连接状态

数据源：`useConnectionSessionStore`

作用域：active tab 的 `profileId`。如果没有 active tab，不显示 active-tab 连接状态；全局连接数量由连接摘要 contributor 负责。

推荐派生：

```text
connecting → 正在连接
connected + ping → 已连接 · 12ms
connected → 已连接
error → 连接失败
idle / no session → 不显示
```

连接状态只展示当前上下文，不主动发起连接、断开、ping 或重试。

### 6.3 连接摘要

数据源：`useConnectionSessionStore.sessions`

位置：右侧。

推荐展示：

```text
connected > 0 → N 个连接在线
connecting > 0 → N 个连接中
error > 0 → N 个连接异常
all zero → 不显示 0 个连接在线
```

如果同时存在异常和在线连接，优先显示异常；可在 tooltip 中展示完整摘要。

### 6.4 当前上下文

数据源：active tab payload、tab runtime state、连接 session 的 `activeDatabase`。

位置：左侧，`width: "elastic"`。

推荐展示：

```text
SQL editor → database / schema
Table data → database / schema / table
Redis key-value → Redis DB 0 · pattern *
Redis key selected → Redis DB 0 · key-name
Table design create → 新建表 · database / schema
Table design edit → 编辑表 · database / schema / table
```

没有 active tab 时不显示上下文，但 readiness contributor 会显示 `已就绪`。

### 6.5 SQL Editor 状态

数据源：`tab-runtime-state-slice` 的 `activeExecution/lastOutcome` 与 legacy-compatible `result/error`；脚本执行期间继续读取 `workbench-tabs-slice.isExecuting` 作为兼容状态。

Focused execution 状态文案：

```text
starting / queued → 准备执行
running → 正在执行 · READ/DDL/... · 2.4s
canceling → 正在取消
succeeded → 查询已完成
canceled → 查询已取消
timedOut → 查询超时
failed → 查询失败
cancelFailed → 取消未确认
```

active tab 的 execution 状态位于左侧；右侧指标按 `resultRows ?? writtenRows`、`readRows`、`resultBytes ?? writtenBytes ?? readBytes ?? rawOutcome.byteLength` 顺序贡献。Raw byte length 只在 summary 三个 byte 字段都缺失时作为中性 fallback，不显示 preview、format 或 artifact ID。所有 `JsonSafeInteger` 必须经 `BigInt(String(value))` 解析与格式化，禁止 `Number(stringMetric)`，避免超过 `Number.MAX_SAFE_INTEGER` 后丢精度。summary 缺失的 legacy rows outcome 仍可显示当前结果行数。

ClickHouse Phase 4A/4B/4C 的 live progress、response summary、merged summary 与 Raw byte fallback 继续复用上述中性状态项，不新增 ClickHouse 状态栏分支。`observationWarnings` 和 ClickHouse-specific summary source/completeness 只在 focused execution detail contributor 中展示；Raw format/media/preview/opaque artifact ID 只属于结果视图和中性详情 model。公共状态栏仍只提供 active/background 摘要和导航。

非 active SQL tabs 中，`starting/running/canceling` 汇总为后台执行数，`failed/timedOut/cancelFailed` 汇总为后台失败数。一个目标点击后聚焦 tab 并打开详情；多个目标通过 `ExecutionOverviewDrawer` 展示轻量列表。overview 不显示 SQL 文本，也不提供 cancel/run/retry；点击列表项只聚焦对应 tab、打开详情并关闭 overview。

公共底部状态栏是唯一常驻 execution 摘要入口。SQL Editor 内容区不增加第二条常驻状态栏。legacy `isExecuting/error/result/dirty` 展示仍保留为 capability absent 和脚本路径的兼容 fallback。

即使某个 driver 声明 `activeCancel=true` 或 `rawResult=true`，状态栏也不显示 Cancel、Run Raw 或 Save。ClickHouse 的 Cancel Active 与 Raw Run 位于 SQL Editor toolbar，Raw Save 位于 Raw result view；状态栏、Execution Detail Drawer 和 Execution Overview 的点击行为仍只能聚焦 tab、打开详情或打开 overview。

### 6.6 Table Data 状态

数据源：`tab-runtime-state-slice` 的 table data runtime state。

推荐展示：

```text
changeSet 非空 → 左侧：3 个更改
transactionState.inTransaction → 左侧：事务中
transactionWarning = rollbackRecommended → 左侧：建议回滚
selectedRowIndexes 非空 → 右侧：12 行选中
pageStats 已知 → 右侧：第 2 / 10 页
```

事务和 dirty 状态可以显示为 warning，但状态栏不承载保存、提交或回滚按钮。主要操作仍属于内容区 toolbar。

### 6.7 Redis Key-Value 状态

数据源：active tab payload 与 key-value runtime state。

推荐展示：

```text
valueDraft 非空 → 左侧：正在编辑值
createDraft 非空 → 左侧：正在新建 Key
pendingDeleteTarget 非空 → 左侧：等待删除确认
activeKey 非空 → 左侧上下文：Redis DB 0 · 当前 key
```

Redis 状态只摘要编辑态和当前 key，不替代 Redis 预览区、编辑器或确认弹窗。

### 6.8 Table Design 状态

数据源：active tab payload、table design runtime state 与 tab `isDirty`。

推荐展示：

```text
isDirty → 左侧：表结构有未保存更改
mode=create → 左侧上下文：新建表 · database / schema
mode=edit → 左侧上下文：编辑表 · database / schema / table
```

DDL 预览、刷新结构、保存结构等操作仍属于 table design 视图和 content toolbar。

### 6.9 AI Runtime 与对话可用性

AI 状态不作为健康信息常驻展示，但当它阻止用户发送消息时，必须在底部状态栏右侧提供稳定、可见的摘要。Agent Panel 保留 Runtime 可用性遮罩、消息流中的生成活动指示器和模型选择器；底部栏不再在输入框狭窄区域重复渲染发送阻塞文案。

`AgentAssistantRuntimeProvider` 只在 Agent Panel 内部提供 assistant-ui 上下文。Panel 内的 Reporter 将可发送性派生为轻量只读快照，`WorkbenchStatusBar` 只消费该快照，不直接依赖 assistant-ui Provider，也不拥有对话生命周期或操作入口。

状态栏规则：

```text
healthy 且可发送 → 不显示 AI Ready
unknown/checking → 默认不显示，避免启动噪音
unhealthy → 右侧：AI 暂不可用
正在恢复当前对话 → 右侧：正在恢复对话
未选择模型 → 右侧：请选择模型
已选模型不可用 → 右侧：当前模型不可用
正在生成 / 工具调用 → 保留在消息流活动指示器，不在底部栏重复展示
```

上述 AI 注意项使用 `compact` 宽度并排在右侧摘要末端，使空间收窄时优先保留；完整说明通过 Tooltip 提供。

### 6.10 NexusPilot Cloud 状态

数据源：Rust 唯一 `CloudDesktopStateProjection`，由 `useCloudDesktopState()` 共享订阅。Cloud contributor 只展示 Cloud 连接摘要，不读取 Token、订阅名称、权益、配额或本地同步密钥状态，也不发起 Cloud 请求。

位置：右侧，全局摘要区，使用 `compact` 宽度。

推荐展示：

```text
connected → [绿色云勾选图标] Cloud
refreshing（前 5 秒）→ [Spinner] Cloud 连接中
refreshing（超过界面等待阈值）→ Cloud 状态更新较慢
cached / offline → Cloud 暂时离线
needs_refresh → Cloud 待更新
permission_denied → Cloud 无访问权限
reauthentication_required → Cloud 需要重新登录
unavailable → Cloud 暂不可用
unauthenticated → 不显示
```

正常连接状态故意只显示“Cloud”，不显示“已连接”，以保持状态栏简洁。Cloud 状态项当前是只读展示，不提供点击事件；进入 Cloud 概览仍通过账户卡片或设置页导航。状态栏不能因为 Cloud 刷新而永久显示 Spinner：超过界面等待阈值后只改变展示文案，不改变 Rust 的 `refresh.inFlight` 权威状态。

### 6.11 Cloud 同步运行状态

数据源：同一份 `CloudDesktopStateProjection.runtime`，由 Rust `CloudSyncScheduler` 更新并通过 `cloud-desktop-state-changed` 投影到 Frontend。该 contributor 不发起同步、不读取同步密钥，也不根据订阅名称推导权限。

位置：右侧，全局摘要区，使用 `compact` 宽度。同步处于正常空闲且没有待处理操作或冲突时不显示，避免把正常状态变成常驻噪音。

推荐展示：

```text
phase=syncing → 同步中
phase=idle 且 pendingOperations>0 → N 项待同步
conflicts>0 或 phase=conflicted → N 个冲突待解决
phase=paused → 同步已暂停
phase=offline → 同步暂时离线
phase=read_only → 同步只读
phase=quota_exceeded → 同步用量已达上限
phase=device_revoked → 本设备已撤销
phase=recovery_required → 同步需要恢复
phase=unavailable → 同步暂不可用
phase=disabled 且无其他风险 → 不显示
```

`pendingOperations` 当前表示待处理同步操作数量，不等同于资产数量，因此第一版使用“项”而不是“资产”。如果未来协议新增语义明确的资产计数，再单独调整文案。冲突、设备撤销、恢复和配额等需要用户关注的状态优先于普通“同步中”摘要；状态栏当前只读，不提供点击或操作入口。

`phase=syncing` 的动态指示必须复用全局 `Spinner` 组件，不把任意 Lucide 图标附加 `animate-spin` 伪装为加载组件；其他阶段继续使用对应的静态语义图标。

---

## 7. 交互约束

### 7.1 Tooltip 注册

每个状态项自动拥有 hover tooltip，由 `StatusBarItem` 统一渲染。支持两种内容形态：

```text
title: string            → 简单文本 tooltip；未设置时回退为 label
tooltipContent: ReactNode → 富内容 tooltip；存在时优先于 title 渲染
```

富内容 tooltip 支持多行摘要、结构化数据或可交互元素（按钮、链接等），用于展示完整错误信息、同步明细、执行指标等不适合压缩成一行文本的内容。

富内容内部的事件（点击、hover 等）由内容组件自行注册，状态栏不做事件拦截：

```text
Tooltip 内容通过 Portal 渲染，内部交互不会触发状态项自身的 onClick
点击 Tooltip 内容不会自动关闭（仅点击外部或 ESC 关闭）
鼠标可以从状态项移入富内容 Tooltip 内交互，无需额外 hover 配置
```

状态项本身支持注册以下事件：

```text
onClick        → 整个状态项可交互（必须传入才会渲染 button 语义与可点击样式）
onMouseEnter   → 鼠标进入状态项
onMouseLeave   → 鼠标离开状态项
```

`onMouseEnter` / `onMouseLeave` 用于高亮、预览等轻量 hover 反馈，不应执行核心业务操作。

### 7.2 点击行为约束

状态栏 item 可以带 `onClick`，但点击行为只能是快捷入口：

```text
连接状态 → 聚焦连接或打开连接详情
上下文状态 → 在 Explorer 中 reveal 当前对象
查询错误 → 聚焦结果 / 错误区域
单个后台查询 → 聚焦 SQL tab 并打开 execution detail
多个后台查询 → 打开轻量 execution overview，再由用户选择目标
事务提示 → 聚焦 table data toolbar 或事务提示区域
```

状态栏 item 不应直接执行核心业务操作：

```text
不直接 connect / disconnect
不直接 execute SQL
不直接 cancel / stop queue / retry SQL
不直接 save Raw artifact
不直接 save table changes
不直接 commit / rollback transaction
不直接 send LLM message
```

`StatusBarItem` 需要区分可点击与不可点击状态。所有状态项统一提供 hover 背景高亮（与 Tooltip 打开状态保持一致），可交互性只通过鼠标指针区分：只有传入 `onClick` 时才使用 button 元素和 pointer cursor；纯展示 item 保持默认指针，不应暗示可点击。

状态栏的 `openSqlExecutionDetails` 与 `openExecutionOverview` 都是导航动作。前者只 activate UI tab 并设置 `executionDetailOpen=true`；后者只写通用 overlay request。它们不得调用 `start/cancel/release_sql_execution`、legacy `execute_sql`、保存或重试逻辑。

---

## 8. 新增状态项流程

新增状态项时按以下步骤接入：

1. 判断它是否属于底部状态栏：必须是当前工作上下文摘要、计数摘要或需要用户注意的跨区异常。
2. 按第 2 节判断放左侧还是右侧。
3. 在 `contributors/` 新增一个 focused contributor，或扩展已有同领域 contributor。
4. 在 `status-bar-contributor-registry.ts` 注册 contributor。
5. 如果需要新共享字段，在 `types.ts` 扩展 `WorkbenchStatusContext` 或 `WorkbenchStatusItemModel`。
6. 为 contributor 增加 focused 测试，覆盖 visible / hidden、active tab 缺失、异常态、中文文案和长文本。
7. 更新本文档或对应领域指南，说明新状态的职责边界。

不要为了新增一个状态项而在 `WorkbenchStatusBar.tsx` 中增加硬编码组件，也不要在公共 hook 中新增 `switch (activeTab.type)` 来承载具体业务展示。

---

## 9. 验收清单

新增或修改状态栏能力后，至少检查：

```text
Workbench 底部状态栏仍固定高度
没有 active tab 时左侧显示“已就绪”
状态栏没有 center area
长表名 / Redis Key 在可用空间内尽量完整显示
极端长文本可以 truncate，Tooltip 显示完整值
富内容 Tooltip 内按钮点击正常，不误触发状态项 onClick，也不会因点击内容提前关闭
非点击 item 不显示 pointer / clickable hover 语义
非交互状态项 hover 时同样显示背景高亮，但保持默认鼠标指针
WorkbenchStatusBar 只渲染统一 item model
useWorkbenchStatusItems 只收集状态、调用 registry、排序过滤
具体 tab / driver 差异位于 contributor 或更靠近业务的 registry
AI Ready 不常驻显示；仅在未选择模型阻止发送时显示“请选择模型”
bun run tsc --noEmit 通过
```

结构检查示例：

```powershell
Select-String -Path 'src/features/workbench/status-bar/WorkbenchStatusBar.tsx','src/features/workbench/status-bar/hooks/useWorkbenchStatusItems.ts' -Pattern 'sql_editor|table_data|key_value|table_design|json_viewer|graph_topology|dashboard|switch \(.*tab|tab\.type ===|center'
```

预期：无命中。公共状态栏 shell 应只消费 contributor 产出的 item model；具体 tab 展示规则属于 `contributors/*`。
