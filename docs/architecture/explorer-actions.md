# Explorer 动作注册层与右键菜单设计

> 本文档描述 NexusPilot 连接列表（Explorer）的统一动作系统。右键菜单、双击默认行为、未来快捷键入口都应从同一套 `ExplorerNodeAction` registry 派生，避免树组件内散落 `node.type` 分支。

---

## 1. 核心模型

Explorer 节点动作由 `src/features/workbench/explorer/actions/` 管理：

| 类型 | 职责 |
|---|---|
| `ExplorerNodeAction` | 单个可执行动作：`id`、`label`、`icon`、`group`、`visible`、`disabled`、`run` |
| `ExplorerNodeActionSet` | 某个节点当前可用的动作集合，包含菜单 `label`、`primaryActionId`、分组列表 |
| `ExplorerNodeActionContext` | 构建动作所需上下文：节点、连接运行状态、driver capabilities、加载/展开状态、handlers |
| `ExplorerNodeActionHandlers` | UI/业务回调集合，由 `WorkbenchExplorerPanel` 注入 |
| `buildExplorerNodeActionSet(ctx)` | 根据节点域分发到本地、连接、保存查询或远程 action 构建流程 |
| `ExplorerNodeActionContributor` | 远程节点动作贡献器：接收 `ExplorerNodeActionContext`，返回某个菜单组的一组动作和可选 primary action |
| `REMOTE_NODE_ACTION_CONTRIBUTORS` | 内置远程节点动作注册表，当前包含通用复制 / 刷新、SQL context、表浏览、建表、Redis、列字段、数据库管理贡献器 |

`ConnectionTreeNode` 只负责渲染 action set 和执行 primary action，不再直接拼接具体菜单项。

---

## 2. 菜单与双击关系

右键菜单渲染 `ExplorerNodeActionSet.groups` 中所有动作；双击执行 `primaryActionId` 对应动作。

若节点没有 primary action，双击回退为展开/收起。Chevron 始终只负责展开/收起，不触发表数据浏览、Redis key 浏览等业务动作。非叶子的远程节点在 children 尚未加载时也显示 Chevron，表示可以继续展开；已连接、已展开或已加载过 children 的节点使用更强的 label 字重表达状态。

当前默认行为：

| 节点 | 双击默认动作 |
|---|---|
| `group` | 展开/收起 |
| `connection` idle/error | 打开连接，成功后展开 |
| `connection` connected | 展开/收起 |
| `saved_query_group` | 展开/收起 |
| `saved_query` | 打开保存的查询 |
| `database` / `schema` / `asset_group` | 展开/收起 |
| `table` / `view` / `materialized_view` | 打开数据 |
| `redis_database` / `redis_key_prefix` / `redis_key` | 打开键浏览 |
| `column` | 无 primary action，回退为无操作 |

---

## 3. 本地与远程节点分域

本地节点（`group` / `connection` / `saved_query_group` / `saved_query`）和远程节点（带 `metadata.container` 的域 B 节点）使用不同动作集合。

### 本地节点

`group` 菜单包含：新建连接、删除、刷新、新建文件夹、重命名。

`connection` 菜单包含：新建连接、删除、刷新、打开连接、关闭连接、新建查询、新增数据库、编辑连接、克隆，以及驱动配置贡献的连接菜单项。“新建查询”要求连接已打开且 `capabilities.sqlExecutor === true`；“新增数据库”只在连接已打开且 `supportsSchemaMutation(capabilities, "database", "create")` 时可用。迁移期 `schemaMutator` 不能作为具体操作的 fallback。

`saved_query_group` 可以出现在 database/schema 节点下，也可以作为无上下文兜底出现在 connection 节点下。菜单包含 `savedQuery.new` / “新建查询”，用于在该连接下打开新的 SQL 编辑器；该动作继承 `group.context`，并要求连接已打开且 `capabilities.sqlExecutor === true`。

`saved_query_group` 是否挂到某类远程上下文节点由驱动配置决定：`ExplorerDriverConfig.savedQueryContextLevels` 声明该驱动支持的查询上下文层级。当前 MySQL 使用 database 层级，PostgreSQL 使用 schema 层级，Redis 不挂载 SQL 查询组。

`saved_query` 菜单包含 `savedQuery.open` / “打开”和 `savedQuery.delete` / “删除”。“打开”是该节点的 primary action，要求连接已打开且 `capabilities.sqlExecutor === true`；“删除”只操作本地保存查询存储，离线时仍可用。

### 远程节点

远程节点不显示“新建连接 / 删除连接”等本地配置操作。

首批远程菜单：

| 节点 | 菜单 |
|---|---|
| 所有远程节点 | 复制名称、复制容器引用 |
| 非叶子远程节点 | 刷新 |
| `database` / `schema` 且 `capabilities.sqlExecutor === true` | 新建查询（携带 database / schema context） |
| `database` 且对应 `schemaMutation` operation 已声明 | 按 create/alter/drop 分别显示新建数据库、编辑数据库、删除数据库；声明 table/create 时也可新建表 |
| `asset_group(groupType=tables)` 且声明 table/create | 新建表 |
| `asset_group(groupType=views/materialized_views)` 且声明对应 object/create | 新建 View / Materialized View；进入 surface 后继续检查 family runtime support |
| `table` | 打开数据；surface registry 可解析时显示设计表结构；声明 table/drop 时显示删除表；复制限定名 |
| `view` / `materialized_view` | 打开数据；surface registry 可解析时显示设计 View；声明精确 capability 时显示新建、重命名、删除；复制限定名 |
| `redis_database` / `redis_key_prefix` / `redis_key` | 打开键浏览、复制 Pattern |
| `redis_key` | 复制 Key |
| `column` | 复制列名、复制类型 |

`database` 节点上的“新建数据库”复用连接级 create-database dialog，语义是在该 database 所属连接下创建同级数据库，不是创建当前 database 的子节点。dialog 通过 driver registration 的通用 operation adapter 选择关系型或 native preview/execute，提交前必须持有当前 target 的 fresh preview；ClickHouse 使用 name-only target。“编辑数据库”和“删除数据库”分别要求 database/alter 与 database/drop：MySQL 编辑仅支持默认字符集，PostgreSQL 编辑支持名称、注释和表空间；删除数据库会进入强确认流程。普通 `table` 节点只有在连接已打开且声明 table/drop 时展示“删除表”，同样进入强确认和 SQL 预览流程。ClickHouse `view` / `materialized_view` 的新建、重命名和删除分别要求对应 kind 的 create/rename/drop 静态 capability，并在专属 View surface 中继续检查 family runtime support；column 和 Redis 节点不展示这些入口。

删除 dialog 不再假定所有驱动都实现关系型 `SchemaMutator`。`schema-drop-operations.ts` 注册 `dropDatabase` / `dropTable` operation adapter：MySQL/PostgreSQL/Oracle 继续调用关系型 preview/execute，ClickHouse 调用 native change preview/execute。最终确认必须使用当前 fresh preview 的 target、baseline 与 plan hash，并显式传 `confirmDestructive=true`；stale preview 不得执行。ClickHouse table/database Drop 只有后端证明对象 absent 才显示 applied，database preview 还会快照 child objects 以阻止确认期间的对象漂移。公共 action contributor 和 dialog 不含 driver-name 分支。

“设计表结构”与 mutation capability 分开建模。`schema-designer-surface-registry` 根据 stored connection driver、`ContainerKind`、create/edit mode 和 runtime capabilities 选择具体 tab surface：MySQL/PostgreSQL/Oracle 的 create/edit 仍要求 table/create 或 table/alter；ClickHouse table/edit registration 可依据 `schemaBrowser=true` 打开五 section native surface，table/create registration 要求 table/create 并打开三 section native create surface。Columns/Engine/TTL、column action、Projection 与 Index section 分别按自己的精确 `object + operation` capability 启用；对象依赖继续阻止主表/column action，但不会禁用对象自身 section。Projection/Index mutation 只存在于专属 table-design tab，Explorer 对应叶子继续只读，不提供第二套 create/drop/materialize/clear workflow。

ClickHouse persistent View/MV 使用独立 `clickhouse_view_design` registration：Views/Materialized Views asset group 按 object/create 提供新建，叶子按 surface registration 提供设计，并按 object/rename|drop 提供管理动作；进入 surface 后仍以 `ClickHouseViewRuntimeSupport` 的七 family operation 三态做最终 gate。Temporary View 不进入 Explorer，只由 owner SQL Editor 的 Session Views contributor 管理。公共 action contributor、Explorer component 和 handler 不包含 ClickHouse driver-name 分支；没有匹配 registration 时也不会回退到关系型 Table Designer。

---

## 4. Driver 配置与能力

连接节点仍复用 `ExplorerDriverConfig.connectionModel` 和 `driverMenuItems`：

- `connectionModel` 自动注入模型通用复制项，如 `model.network.copyHost`
- `driverMenuItems` 追加驱动专属连接菜单项
- `createDatabase` 为支持 database/create 的驱动贡献表单与通用 operation adapter；MySQL 支持可选字符集，PostgreSQL 与 ClickHouse 当前只收集数据库名，ClickHouse adapter 使用 native preview/execute，Redis 不提供该配置
- `editDatabase` 为关系型驱动贡献编辑数据库表单；MySQL 只编辑默认字符集，PostgreSQL 编辑名称、注释和表空间
- `dropDatabase` / `dropTable` 为可选通用 operation registration；关系型与 native driver 各自注册 preview/execute adapter，dialog 只处理 fresh preview、确认与通用结果投影
- 这些条目通过 action registry 适配为 `ExplorerNodeAction`

远程节点动作采用 contributor 收口：`buildExplorerNodeActionSet` 只判断节点大类并把远程节点交给 `buildRemoteNodeActionSet`。内置 contributor 覆盖表、Redis、字段、SQL context 和数据库管理动作；驱动如需追加远程节点动作，可在 `ExplorerDriverConfig.remoteActionContributors` 注册贡献器。贡献器只返回动作模型，不直接渲染菜单，也不持有弹窗状态。

远程节点动作优先由 `ContainerRef.kind/groupType` 和后端返回的 `DriverCapabilities` 决定。`schemaMutation` 是具体 object/operation 的权威来源；`schemaMutator` 只保留关系型 trait 的迁移兼容语义，native extension 可以在其为 false 时声明精确操作。数据库结构管理表单由 driver config 注册，schema design surface 由 `schema-designer-surface-registry` 注册，action registry 只负责根据节点类型、capability 和 registration 暴露入口，避免把 MySQL / PostgreSQL / Redis / ClickHouse 的表单或标签页分支写回 `ConnectionTreeNode`。

后续新增菜单或默认双击行为时，先检查 [workbench-registry-constraints.md](../development/workbench-registry-constraints.md)。除本地域 A 节点的通用动作外，新对象族或驱动专属远程动作应通过 contributor 注册，不能把对象族菜单细节写回共享 builder 或树节点组件。

---

## 5. 刷新行为

`useExplorerMetadataStore` 提供两个入口：

| 方法 | 行为 |
|---|---|
| `loadChildren(node)` | 懒加载；若当前节点 children 已加载则直接返回 |
| `reloadChildren(node)` | 显式刷新；绕过已加载缓存并覆盖当前节点 children |

`handleRefreshNode` 按节点域分流：

- `group`：刷新本地连接列表
- `connection`：清理该 profile 的远程 metadata cache 后重新加载根容器
- 远程节点：调用 `reloadChildren(node)` 重新请求当前节点 children

第一版只刷新当前节点 children，不递归清理所有后代缓存。
