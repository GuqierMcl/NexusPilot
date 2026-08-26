# Workbench 注册制约束指南

> 本文档是 Workbench 前端扩展约束的事实来源。目标是防止后续功能把 driver、node type、tab type 的差异重新写回公共组件或共享 store，导致集中枚举膨胀。

---

## 1. 核心原则

Workbench 的公共壳层只做三件事：

1. 接收统一模型。
2. 渲染布局和通用交互。
3. 调用 registry / contributor 提供的行为。

具体差异必须由离业务更近的注册点承担。新增数据库、节点族、内容 tab 或 toolbar 行为时，优先补注册项；不要在公共组件中新增 `if (driver === "...")`、`switch (tab.type)`、长链 `node.type === ...`。

允许存在少量集中枚举，但它们只能是契约或路由边界：

| 位置 | 是否允许 | 原因 |
| --- | --- | --- |
| `TabType` / `TabPayloadMap` | 允许 | TS 判别联合契约，定义可持久化 payload 形状 |
| `ExplorerTreeNodeType` | 允许 | Explorer 节点协议契约 |
| `DriverRegistry::create_driver` | 允许 | 后端 factory 边界，把 profile 变体映射到具体 driver |
| `useExplorerMetadataStore.loadChildren` 的 node type 路由 | 允许 | 懒加载入口路由；不得混入具体 driver UI 行为 |
| `SelectDatabaseTypeDialog` 的产品列表 | 允许 | 数据库选择器是产品 catalog，不是运行时行为分发 |
| 公共 React 组件中的 driver/tab/node 业务分支 | 禁止 | 应改为 registry / contributor |
| `workbench-tabs-slice` 中的 tab id/title/payload 构造分支 | 禁止 | 应改为 `content-tab-lifecycle-registry` |

---

## 2. 当前注册边界

| 边界 | 注册点 | 公共消费者 | 约束 |
| --- | --- | --- | --- |
| 连接驱动 UI 配置 | `src/features/workbench/explorer/driver-configs/*` | 连接表单、选择器、连接节点菜单 | 新驱动通过 `ExplorerDriverConfig` 注册，不改公共表单壳层 |
| 保存查询挂载位置 | `ExplorerDriverConfig.savedQueryContextLevels` | `savedQueryNodes` | MySQL/PostgreSQL/Redis 等差异不写在 `savedQueryNodes` |
| Explorer 节点视觉 | `explorer-node-visual-registry.tsx` 与 `ExplorerDriverConfig.treeVisual` | `ExplorerNodeIcon` | 节点图标、资产分组图标走 registry；连接品牌图标走 driver config |
| Explorer 节点行 accessory | `ConnectionTreeNode` 内部 row model，后续可扩展为 accessory contributor | `ConnectionTreeNode` | main action 与 trailing slot 分离；用户标签和轻量右侧操作不写成 driver 分支 |
| Explorer 远程节点动作 | `remoteActionContributors.ts` 与 `ExplorerDriverConfig.remoteActionContributors` | `buildExplorerNodeActionSet` / `ConnectionTreeNode` | 远程菜单和 primary action 走 contributor |
| Content toolbar | 各内容视图发布 `ContentToolbarModel` | `ContentToolbar` | Toolbar 不按 `TabType` 猜动作、文案、右侧上下文 |
| Content tab 渲染与标题 | `content-tab-registry.tsx` | `ContentTabView` / `ContentTabBar` | 面板、图标、展示标题、tooltip 标题走 tab registration |
| Content tab 生命周期 | `content-tab-lifecycle-registry.ts` | `workbench-tabs-slice` | tab id、title、payload、de-dup、retarget helper 走 lifecycle registration |
| Schema designer surface | `schema-designer-surface-registry.ts` | Explorer schema actions / `openSchemaDesignTab` | driver/object/mode/capability 到具体设计 tab 的映射走 registration；只读 surface 与 mutation capability 分开 |
| Workbench status bar | `status-bar-contributor-registry.ts` 与 `status-bar/contributors/*` | `WorkbenchStatusBar` | 底部状态栏只渲染 contributor 产出的 item model，不按 `TabType`、driver 或 node type 维护固定状态项；区域只允许 left/right |
| SQL execution focused detail | `execution-detail-contributor-registry.tsx` | `ExecutionDetailDrawer` | 中性 shell 展示公共 identity/state/summary/failure；driver-specific focused detail 只能由 contributor 注入 |
| Status navigation overlays | `WorkbenchStatusOverlayHost.tsx` + overlay request store | `WorkbenchContentPanel` | 内容壳只挂载通用 host；多目标业务 overlay 不得直接进入公共 content/status shell |

---

## 3. Explorer 约束

### 3.1 保存查询挂载

保存查询属于本地 Storage 域，但展示位置由连接驱动决定：

- MySQL：database 级 `查询` 分组。
- PostgreSQL：schema 级 `查询` 分组。
- Redis：不挂载 SQL 查询分组。

约束：

- 新驱动如果支持 SQL 查询上下文，更新对应 `ExplorerDriverConfig.savedQueryContextLevels`。
- `savedQueryNodes` 只能消费 driver config，不能按 `driver === "mysql"` / `driver === "postgres"` 写分支。
- PostgreSQL database 节点下不应再出现 `查询` 分组；查询入口应位于 schema 节点下。

### 3.2 节点视觉

普通节点、远程节点、资产分组节点的视觉由 `explorer-node-visual-registry.tsx` 负责。连接节点的品牌图标由 `ExplorerDriverConfig.treeVisual` 负责；driver abbreviation badge 已移除，不应恢复为新语义载体。

约束：

- `ExplorerNodeIcon` 只读取 registry 结果并渲染。
- 新增 `ExplorerTreeNodeType` 后，必须在节点视觉 registry 注册图标和样式。
- 新增 `AssetGroupType` 后，必须在资产分组视觉 registry 注册图标和展示语义。
- 连接状态视觉当前附着在连接驱动图标和行级状态 rail 上，不允许新增独立状态圆点列。
- 用户自定义连接标签属于行 trailing slot，不属于驱动图标、连接状态或 driver config。
- `ExplorerDriverConfig.treeVisual` 不应继续承载用户标签、环境标识或连接状态等 profile 级展示元数据。
- 不要在 `ExplorerNodeIcon` 中恢复长链 `switch (node.type)`。

### 3.2.1 节点行容器与右侧插槽

Explorer 节点行已按 [Explorer node actions roadmap](../roadmap/explorer-node-actions.md) 完成 row container、main action、trailing slot、连接状态视觉和用户连接标签。该结构用于支持用户连接标签和轻量行内操作，但不改变 Explorer 节点模型和 action registry 的职责边界。

约束：

- main action 区负责节点选择、双击 primary action、展开/收起、懒加载和右键菜单入口。
- trailing slot 只承载辅助展示或轻量操作，例如连接标签、计数、只读提示或未来三点按钮。
- trailing slot 里的交互控件必须阻止不应冒泡的 pointer/click/double-click 事件，避免误触发选择、拖拽或展开。
- 不要把驱动专属右侧按钮硬编码进 `ConnectionTreeNode`；如需 driver-specific 行动作，应通过现有 action/contributor 边界扩展。
- 用户连接标签是本地域 A 展示元数据，当前通过连接记录的 `tagLabel` / `tagColor` 字段进入 row trailing slot；不参与排序、过滤、权限、风险确认、runtime state、远程 metadata 或 AI 上下文。

### 3.3 远程节点动作

远程节点右键菜单和双击 primary action 由 action contributor 生成。公共树节点组件只渲染 `ExplorerNodeActionSet`，并执行 `primaryActionId`。

约束：

- 内置通用动作放在 `REMOTE_NODE_ACTION_CONTRIBUTORS`。
- 某个驱动专属的远程动作放在 `ExplorerDriverConfig.remoteActionContributors`。
- contributor 接收 `ExplorerNodeActionContext`，返回动作模型；不得直接渲染菜单，也不得持有弹窗状态。
- 动作是否可用优先由 `ContainerRef.kind/groupType` 和后端 `DriverCapabilities` 决定。
- `ConnectionTreeNode` 不拼接具体菜单项，不判断 MySQL/PostgreSQL/Redis 的远程节点差异。

---

## 4. Content 约束

### 4.1 Toolbar

Content toolbar 是订阅模型，不是按 tab 类型推断模型。

约束：

- 内容视图按当前 `tabId` 发布完整 `ContentToolbarModel`。
- `ContentToolbar` 只读取 active tab 的 toolbar model 并渲染。
- toolbar 右侧上下文文本、空状态文案和 actions 都必须来自 model。
- capability-driven SQL actions（例如 `运行原始结果`）由 SQL Editor 自己发布；公共 toolbar 不读取 `rawResult`、不识别 ClickHouse，也不调用 execution/save IPC。
- 不要在 `ContentToolbar` 中新增 `switch (tab.type)` 或 `if (tab.type === "table_data")`。

### 4.2 Tab 渲染、标题与图标

`ContentTabBar` 和 `ContentTabView` 只消费 `content-tab-registry` helper：

- `getContentTabIcon`
- `getContentTabDisplayTitle`
- `getContentTabTooltipTitle`
- `renderContentTabPanel`

约束：

- 新 tab family 必须新增一个 `ContentTabRegistration`。
- 面板渲染、tab 图标、展示标题和 tooltip 标题都由 registration 提供。
- 公共 tab bar / tab view 不维护具体 `TabType` 的图标、标题或面板分支。

### 4.3 Tab 打开生命周期

`workbench-tabs-slice` 可以保留用户可调用的公开方法，例如 `openSqlEditorTab`、`openTableDataTab`、`openKeyValueTab`。但它不拥有每种 tab 的身份规则。

约束：

- 稳定 tab id 构造走 `content-tab-lifecycle-registry`。
- tab title、payload、de-dup 规则走 lifecycle registration。
- saved SQL query 查找、SQL retarget、table design retarget 等模型 helper 放在 lifecycle registry。
- store 仍负责异步 runtime orchestration：打开 tab runtime、检查 capabilities、初始化 runtime state、关闭失败 runtime。
- 不要在 `workbench-tabs-slice` 中恢复 `tableDataTabId`、`keyValueTabId`、`sqlEditorTabId`、`buildTableDesignEditTitle` 等 helper。

新增 tab family 时，至少完成：

1. 在 `TabType` / `TabPayloadMap` 中定义类型和 payload。
2. 新增或更新 `ContentTabRegistration`。
3. 新增或更新 `ContentTabLifecycleRegistration`。
4. 如果需要 toolbar，内容视图发布 `ContentToolbarModel`。
5. 如果需要底部状态栏摘要，新增对应 status contributor。
6. 增加 registry 回归测试，至少覆盖一个真实 tab 和一个 reserved / placeholder 路径。

### 4.4 Schema Designer Surface

结构设计入口分为两项独立判断：`schemaMutation` 回答具体 object/operation 是否可写，`schema-designer-surface-registry` 回答该 driver/object/mode 应打开哪个产品表面。迁移期 `schemaMutator` 不能作为 create/alter/drop 的具体授权，也不能决定使用关系型还是 native designer。

约束：

- Explorer action contributor 使用 `supportsSchemaMutation()` 判断 database/table 的 create/alter/drop；不得回退到粗粒度 bool。
- “设计表结构”只有在 surface registry 能解析 edit registration 时显示；未匹配时不得静默回退关系型 Table Designer。
- 原生只读 surface 可以依赖 `schemaBrowser` 注册，不需要声明 mutation operation；因此“可打开设计页”不等于“可保存”。
- `openSchemaDesignTab` 只负责调用 registration、复用 lifecycle de-dup 和打开 typed payload；公共 store/Explorer 不实现 ClickHouse 等具体 surface 分支。
- 新 surface 必须同时补 `TabType/TabPayloadMap`、content registration、lifecycle registration、surface registration 和 focused tests。
- ClickHouse 当前 native schema surfaces 是参考实现：surface registry 决定 table/view 的 create/edit 产品表面，具体 create/alter/drop/clear/materialize 动作再由精确 `schemaMutation` capability 授权；只读 Describe 与可写操作保持分离，公共 Explorer 不按 driver name 分支，也不回退关系型设计器。

### 4.5 Status Bar

Workbench 底部状态栏是 active work surface 的低干扰摘要层，不是另一个 toolbar，也不是 AI 健康灯展示区。

约束：

- `WorkbenchStatusBar` 只渲染 `WorkbenchStatusItemModel[]`，不直接挂载 `ConnectionStatusItem`、`QueryStatusItem`、`AgentStatusItem` 这类固定业务组件。
- `useWorkbenchStatusItems` 只负责收集现有 store 状态、组装 `WorkbenchStatusContext`、调用 contributor registry、排序过滤 item。
- 具体 `sql_editor`、`table_data`、`key_value`、`table_design` 等状态展示规则必须放在 focused contributor 中，不要写进公共状态栏 shell 或公共 hook。
- 状态栏区域只允许 `left` / `right`，不允许 `center`。动作、上下文、当前 tab 风险放左侧；数字、页码、选区、全局摘要和全局异常放右侧。
- 没有 active tab 且没有更强状态时，左侧显示中文心跳状态 `已就绪`，不要让整条状态栏空白。
- 状态栏文案统一使用中文，例如 `已就绪`、`正在查询`、`查询失败`、`2 个连接在线`、`AI 离线`。
- 当前对象路径，例如 database / schema / table / Redis Key，属于左侧上下文状态，并应使用 elastic 宽度，避免过早被固定 `max-width` 截断。
- AI 状态默认不常驻展示 `AI Ready` 或 `No model selected`。只有 AI Runtime 离线、不可用，或未来 Agent Panel 折叠后需要补位时，才通过 warning contributor 进入右侧区域。
- 状态栏 item 可以提供跳转或聚焦入口，但不能直接执行连接、SQL、保存、提交、回滚或 LLM 发送等核心业务动作。
- 非点击 item 不应使用 pointer cursor 或 button 语义；只有存在 `onClick` 的 item 才表现为可交互。
- `WorkbenchStatusActions` 只能表达 focus tab、open focused detail 和 open multi-target overview；不得加入 Run、Cancel、Stop Queue、Retry 或 Save。
- `WorkbenchStatusOverlayHost` 是 status navigation overlay 的公共分发边界。`WorkbenchContentPanel` 只能挂载 host，不得直接导入 `ExecutionOverviewDrawer` 或按 tab/driver 决定 overlay。
- SQL execution 的公共 detail shell 不读取 `driverName`，不显示 SQL 全文、Raw preview/bytes、temp/destination path 或 DEV error details，也不承载核心动作。它可以从中性 outcome model 展示 Raw format、media type、JSON-safe byte length、preview-truncated state 与 opaque artifact ID；真正的 Save 只属于 Raw result view。driver name 只允许在 `SqlExecutionDetailContributor.supports(context)` 中用于选择 focused contributor。
- built-in execution detail contributor list 当前只注册 ClickHouse execution observation contributor；driver 判断只允许存在于该 contributor 的 `supports(context)`。它展示 progress availability、summary source/completeness、JSON-safe memory 与 bounded observation warnings，不显示 SQL、developer details、Raw preview 或 path，也不提供 Cancel/Run/Retry/Save。公共 Drawer/status/content shell 继续不修改。

---

## 5. 新增数据库驱动时的约束

新增驱动不应绕过现有注册边界。

前端必须优先检查：

- `ExplorerDriverConfig`：表单、默认值、校验、连接视觉、保存查询挂载层级、远程动作贡献器。
- `explorer-node-visual-registry`：新增节点族或资产分组视觉。
- `remoteActionContributors` / `remoteActionContributors` hook：新增远程菜单。
- `content-tab-registry`：新增内容 tab 的渲染、图标和标题。
- `content-tab-lifecycle-registry`：新增内容 tab 的打开请求、id、payload、de-dup。
- `schema-designer-surface-registry`：新增结构设计表面的 driver/object/mode/capability 路由。
- `execution-detail-contributor-registry`：如果驱动需要中性字段之外的 focused execution 详情，只在该 registry 注册 contributor；中性 Raw outcome/artifact metadata 不需要按 driver 注册。

后端必须优先检查：

- `DatabaseDriver` 和 capability trait。
- `DriverProfile` 和 `DriverRegistry` factory。
- `DataContainer` / `ContainerRef` 是否足以表达新节点寻址。

不要新增只服务某一个驱动的前端 IPC 分支，除非它代表全新范式能力，并且已经同步更新 `docs/contracts/` 与前后端类型。

---

## 6. Review 检查清单

PR 或本地 review 时，至少跑这些结构检查。命令返回结果不一定都是错误，但任何命中都要解释为什么它属于允许的契约边界。

### Explorer 共享组件不应恢复远程动作分支

```powershell
Select-String -Path 'src/features/workbench/explorer/components/ConnectionTreeNode.tsx' -Pattern 'remote\.table|remote\.redis|remote\.database|remote\.column|node\.type === "table"|node\.type === "redis_|driver ==='
```

预期：无命中，或只命中非业务分支的上下文传递。

### Explorer 动作公共 builder 不应拥有对象族菜单细节

```powershell
Select-String -Path 'src/features/workbench/explorer/actions/buildExplorerNodeActionSet.ts' -Pattern 'remote\.table|remote\.redis|remote\.database|remote\.column|remote\.copyContainerRef|isTableLikeNode|isRedisNode|isSqlContextNode|getQualifiedName'
```

预期：无命中。远程对象族细节应在 `remoteActionContributors.ts`。

### 保存查询挂载不应按具体驱动分支

```powershell
Select-String -Path 'src/features/workbench/explorer/savedQueryNodes.ts' -Pattern 'mysql|postgres|redis|driver ===|switch'
```

预期：无命中。挂载位置应来自 `ExplorerDriverConfig.savedQueryContextLevels`。

### Content 公共 shell 不应枚举具体 tab

```powershell
Select-String -Path 'src/features/workbench/content/components/ContentTabBar.tsx','src/features/workbench/content/components/ContentTabView.tsx','src/features/workbench/content/components/ContentToolbar.tsx' -Pattern 'sql_editor|table_data|key_value|table_design|json_viewer|graph_topology|dashboard|switch \(.*tab|tab\.type ==='
```

预期：无命中。公共 shell 应只调用 registry helper 或 toolbar store。

### Status Bar 公共 shell 不应枚举具体 tab

```powershell
Select-String -Path 'src/features/workbench/status-bar/WorkbenchStatusBar.tsx','src/features/workbench/status-bar/hooks/useWorkbenchStatusItems.ts' -Pattern 'sql_editor|table_data|key_value|table_design|json_viewer|graph_topology|dashboard|switch \(.*tab|tab\.type ===|center'
```

预期：无命中。公共状态栏 shell 应只消费 contributor 产出的 item model；具体 tab 展示规则属于 `status-bar/contributors/*`，中间区域不应回到公共 shell。

### Status Bar 类型不应恢复 center 区域

```powershell
Select-String -Path 'src/features/workbench/status-bar/types.ts','src/features/workbench/status-bar/status-bar-contributor-registry.ts','src/features/workbench/status-bar/contributors/*.tsx' -Pattern '"center"|center:|area: "center"'
```

预期：无命中。状态栏 contributor 只能选择 `left` 或 `right`。

### Execution detail 与 overlay 公共壳不应承载驱动或核心动作

```powershell
Select-String -Path 'src/features/workbench/content/components/sql-editor/ExecutionDetailDrawer.tsx','src/features/workbench/content/WorkbenchContentPanel.tsx','src/features/workbench/status-bar/WorkbenchStatusBar.tsx' -Pattern 'clickhouse|driverName ===|tab\.type ===|cancelSqlExecution|startSqlExecution|saveSqlExecutionArtifact|runRaw|execute_sql|ExecutionOverviewDrawer'
```

预期：无命中。`ExecutionDetailDrawer` 只渲染中性 model 和 registry 结果；`WorkbenchContentPanel` 只挂载 `WorkbenchStatusOverlayHost`；`WorkbenchStatusBar` 只消费 item model。`ExecutionOverviewDrawer` 名称只允许出现在 overlay host 内部。

### Store 不应恢复 tab 生命周期 helper

```powershell
Select-String -Path 'src/store/slices/workbench-tabs-slice.ts' -Pattern 'function tableDataTabId|function keyValueTabId|function sqlEditorTabId|function tableDesignEditTabId|function tableDesignCreateTabId|function buildTableDesignCreateTitle|function buildTableDesignEditTitle|function normalizeSqlContext|export function findExistingSavedSqlEditorTab|export function retargetSqlEditorTab'
```

预期：无命中。这些规则属于 `content-tab-lifecycle-registry.ts`。

---

## 7. 常见例外与处理方式

`TabType`、`ExplorerTreeNodeType`、`TabPayloadMap`、`DataContainer.kind` 这类联合类型是契约，新增枚举值是正常变更。问题不在“有枚举”，而在公共组件或共享 store 用这些枚举承载具体业务差异。

如果确实需要新增公共分支，必须满足以下条件：

1. 这是协议边界或顶层路由，而不是具体驱动 / tab 行为。
2. 分支内只分发到 registry / contributor，不直接实现业务细节。
3. 同步更新本指南和对应 architecture / contract 文档。
4. 添加结构回归测试，防止后续继续扩张。

做不到这四点时，应先设计新的 registry / contributor 边界，而不是把逻辑塞回共享壳层。
