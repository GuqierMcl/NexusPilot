# Nexus Pilot: 异构数据库元数据树与虚拟节点架构设计文档

## 1. 架构背景与核心痛点

在构建支持多源异构数据库（如关系型、图、向量数据库）的桌面级 IDE 时，左侧的资源树组件面临着以下三个核心挑战：

1. **物理层级撕裂 (Hierarchy Mismatch)**：各数据库范式的物理存储结构存在根本差异。例如，MySQL 是 `库 -> 表`，PostgreSQL 是 `库 -> 模式 (Schema) -> 表`，Oracle 是 `服务/SID -> owner/schema -> 对象`，SQLite 则归一化为 `本地文件 -> 对象分组 -> 对象`。若前端根据数据库类型硬编码 UI 树层级，代码将迅速腐化，且难以支持后续新数据库的接入。
2. **海量节点渲染阻塞 (Render Freezing)**：在企业级应用中，单一数据库可能包含上万张表、数千个视图。若在展开数据库节点时全量并发请求并渲染这些底层实体，前端 DOM 树极易崩溃，同时会引发严重的 I/O 拥塞。
3. **本地状态与远程数据的纠缠**：用户自定义的连接分类（如“生产环境文件夹”）与数据库内的真实结构（如“业务数据表”）在 UI 视觉上是一棵树，但在数据流向上却分别归属本地存储与远端服务器，极易产生状态同步混乱。

---

## 2. 核心设计思想：双界域与泛型节点抽象

为解决上述痛点，本架构将树状组件设计为对具体数据库业务**“零感知”**的纯渲染引擎。其核心是通过定义**统一泛型节点**，并在逻辑上划定**两大数据界域**。

例如：
```typescript
// src/types/explorer.ts

export type ExplorerNodeType =
    // ==========================================
    // 域 A：本地配置空间 (来自本地 SQLite 存储)
    // ==========================================
    | 'profile_folder'      // 📁 用户自己建的连接分类文件夹 (如 "生产环境", "阿里云")
    | 'connection'          // 🔌 具体的数据库连接实例 (Profile)
    | 'saved_query_group'   // 📁 本地保存查询分组：按 context 注入 database/schema，或作为 connection 兜底组
    | 'saved_query'         // 📄 本地保存查询

    // ==========================================
    // 域 B：远程元数据空间 (来自底层驱动动态查询或虚拟构造)
    // ==========================================
    | 'database'            // 🛢️ 物理数据库
    | 'schema'              // 🗄️ 物理模式
    | 'asset_group'         // 📁 后端返回的资产分组（Tables / Views / Functions 等）
    | 'table'               // 📊 物理数据表
    | 'view'                // 👁️ 视图
    | 'materialized_view'   // 👁️ 物化视图
    | 'column';             // 📝 列字段
    // ... 其他类型略
```

### 2.1 泛型节点模型抽象

前端放弃所有具有业务含义的实体定义（不区分表节点或库节点），统一采用一种泛型节点结构。该结构包含以下核心维度 *(数据结构概念示例，非具体实现代码)*：

* **唯一标识 (`id`)**：节点的绝对寻址路径。
* **节点类型 (`type`)**：核心枢纽。枚举值，前端仅根据此字段决定渲染何种图标（如🛢️、📊、📁）及挂载何种右键菜单上下文，不关心其背后的数据库归属。
* **叶子状态 (`isLeaf`)**：布尔值，决定 UI 是否渲染供用户点击的展开箭头。
* **寻址载荷 (`metadata`)**：一个黑盒字典。用于在用户交互时，向后端原封不动地传递获取其下一级节点所需的最小上下文（如当前所在的库名、模式名）。

### 2.2 双界域隔离模型

根据节点类型的不同，整棵树被严格划分为上下两层隔离的界域：

* **域 A：本地配置空间 (Local Configuration Space)**
  * **包含类型**：用户自定义连接文件夹、数据库连接实例 (Profile)、保存查询分组与保存查询。
  * **数据源**：直接读取本地 SQLite 存储。
  * **特点**：无网络开销；连接文件夹和连接 Profile 支持拖拽整理。保存查询存储归属连接 Profile，Explorer 展示位置按执行 context 注入远程 database/schema 节点；没有 database context 的记录才显示在连接级 `查询（未指定上下文）` 兜底组。
* **域 B：远程元数据空间 (Remote Metadata Space)**
  * **包含类型**：数据库、模式、数据表、视图、字段等真实或衍生的内部结构。
  * **数据源**：通过 Tauri IPC 跨端向 Rust 后端实时请求。

---

## 3. 性能防御机制：资产分组节点 (Asset Group Nodes)

为了解决海量节点的渲染灾难并抹平异构数据库的层级差异，在域 B（远程元数据空间）中，引入后端统一返回的**资产分组节点**。

### 3.1 什么是虚拟节点？

资产分组并非数据库中真实存在的物理实体，而是由 Rust driver 在内存中动态构造的 `DataContainer { kind: "asset_group", container.groupType }`。典型分组包括 Tables、Views、Functions、Procedures、Indexes、Dictionaries、Projections、Partitions、Triggers、Sequences、Extensions、Events。前端展示层会把这些系统生成的虚拟分组显示为中文（如 `表`、`视图`、`函数`、`存储过程`、`索引`、`字典`、`投影`、`分区`、`触发器`），但 IPC `groupType` 和数据库真实对象名保持不变。

### 3.2 架构收益

1. **防御性防抖 (Lazy Loading Buffer)**：当用户展开一个庞大的数据库时，后端仅返回极少量的虚拟文件夹节点（瞬间完成）。只有当用户明确展开“表”文件夹时，系统才会发起真实的 I/O 去拉取上万张表，实现了完美的按需加载。
2. **抹平层级差异**：MySQL 可在 database 下返回资产分组，PostgreSQL 与 Oracle 可在 schema 下返回资产分组，SQLite 可在本地文件节点下返回资产分组，Redis 则继续返回 logical DB / key prefix / key。前端只渲染 `DataContainer`，不按驱动猜层级。

PostgreSQL driver 返回 schema 节点时必须屏蔽内部 schema，包括 `information_schema`、`pg_catalog`、`pg_toast*`、`pg_temp*`。这些节点不属于用户可管理对象，尤其是 `pg_temp*` 可能引用其他会话的临时 schema；如果暴露到资源树并作为建表目标，会触发 PostgreSQL 的 “cannot create relations in temporary schemas of other sessions” 错误。建表 IPC 后端也必须对这些 schema 做防御性校验，不能只依赖前端隐藏。

Oracle Phase 1.5 后，连接节点直接展开为 Oracle owner / user 对应的 `schema` 节点；schema 下继续返回 `asset_group`，包括 tables、views、materialized_views、sequences、functions、procedures、indexes 和 triggers。当前 service / SID / EZConnect alias 不再作为可见 `database` wrapper 出现在 Explorer 中，但仍写入 `ContainerRef.database` 作为内部上下文。Oracle 系统 schema 默认由后端 driver 隐藏，前端不按 schema 名写特殊分支。

SQLite Phase 2 normalized into the same lazy-loading shape as other relational drivers: `connection -> file database node -> asset_group -> object`. The file node is a database-like context named after the local SQLite file and has no schema selector. It returns asset groups for tables, views, indexes, and triggers at the file database node; tables expose columns, indexes, and triggers; views expose columns and triggers. The driver hides internal `sqlite_*` objects and uses `sqlite_schema` plus `PRAGMA table_xinfo` to populate metadata.

ClickHouse Phase 2 使用同一条通用流水线，层级为 `connection -> database -> asset_group -> object`，同时允许 connection 根级返回 `database` 与 `asset_group` 的混合 children。根级 `Functions` 分组承载 server-global functions，其 `ContainerRef.database=null`；函数不会复制到每个 database，也不会伪装成 `system` 的子对象。`system` 与其他 database 使用完全相同的节点、排序、缓存和错误处理。table 展开 Columns、Indexes、Projections、Partitions；View 与 MaterializedView 只展开 Columns；Dictionary 为叶子。Partitions 来自 active parts 的服务端聚合，individual parts 不进入 Explorer。

ClickHouse metadata 查询先通过 `system.columns` 探测目标 system table 的实际列集合，再由 driver 内的固定白名单生成 SQL。对象标识与过滤所需的核心列缺失时，当前分组返回 `businessOnly` 兼容错误；非必要展示列缺失时使用 typed NULL 或空文本占位，并在映射层省略对应 property。旧版本没有 `system.dictionaries`、`system.data_skipping_indices` 或 `system.projections` 时，相应可选分组为空。版本兼容逻辑只存在于 ClickHouse metadata module，不进入公共 Manager、Explorer 或 driver-name 分支；network、authentication 与 decoding failure 仍按真实错误传播，不能被兼容降级吞掉。

---

## 4. 动态控制流与跨端渲染流水线

用户在前端界面上的所有点击展开行为，均被抽象为一条极简的控制流：**前端抛出当前节点载荷 -> 后端路由计算 -> 返回子节点列表**。

前端不再包含 `if (isMySQL) { ... } else if (isPostgres) { ... }` 的逻辑分支。

### 后端适配器路由 (Adapter Router) 引擎机制

当 Rust 后端接收到前端传来某个节点的 `type` 和 `metadata` 载荷时，其内部的路由引擎将执行以下判定分发：

* **场景 1：触发动态网络请求 (Dynamic Query)**
  * **判定**：当展开的是连接实例，或是诸如“表文件夹”这类直接对应底层实体的节点。
  * **动作**：提取载荷中的上下文，匹配到对应的数据库驱动，发起真实的 SQL / 原生命令查询远端服务器。
  * **输出**：将真实结果包装为泛型节点列表返回前端。
* **场景 2：触发静态资产分组返回 (Static Asset Group Construction)**
  * **判定**：当展开的是诸如数据库、模式这类具有多种下级资产属性的物理容器节点。
  * **动作**：根据当前数据库的特性，直接在内存中生成对应的 `asset_group` 容器（如 Tables、Views、Functions）。是否执行网络 I/O 由具体 driver 决定；首层分组通常不需要拉取大量对象。
  * **输出**：将静态构造的节点列表瞬间返回前端。

---

## 5. 架构演进与扩展性评估

本套设计实现了前端渲染视图与后端数据库业务逻辑的**彻底解耦**。具有 O(1) 级别的平行扩展能力。

当项目未来需要接入全新的异构数据源（例如图数据库 Neo4j）时：

1. **前端 (React/TS) 修改量为 0**：无需变更核心逻辑，仅需在 UI 层注册新的节点类型（如 `folder_nodes`、`node_label`）对应的图标即可。
2. **后端 (Rust) 无缝接入**：在后端的适配器路由中新增对应的驱动分支，告知系统当遇到该数据库的请求时，应当构造哪些虚拟文件夹，以及应当执行哪些 Cypher 查询去获取真实节点。

本设计确保了左侧资源树能够以统一的视觉体验和极致的性能，平滑支撑系统向全品类 AI 原生数据库管理平台的演进。

---

## 6. 实现参考（Implementation Reference）

本节记录当前代码实现的具体细节，供后续新增节点类型时参考。

### 6.1 涉及文件索引

| 文件 | 职责 |
|---|---|
| `src/features/workbench/explorer/types.ts` | 所有节点类型定义、`RemoteNodeMetadata`、节点联合类型 |
| `src/features/workbench/explorer/buildExplorerTree.ts` | 域 A：SQLite folders + connections → 树节点 |
| `src/features/workbench/explorer/buildRemoteNodes.ts` | 域 B：IPC 返回数据 → 树节点工厂函数 |
| `src/features/workbench/explorer/useExplorerMetadataStore.ts` | 域 B：懒加载控制器（loadedChildren Map + loadChildren 路由） |
| `src/features/workbench/explorer/components/ConnectionTreeNode.tsx` | 统一渲染所有节点类型；展开触发 onNodeExpand |
| `src/features/workbench/explorer/components/ExplorerNodeIcon.tsx` | 读取节点视觉 registry 并渲染图标 |
| `src/features/workbench/explorer/components/explorer-node-visual-registry.tsx` | 普通节点与资产分组节点的图标 / 样式注册中心 |
| `src/features/workbench/explorer/WorkbenchExplorerPanel.tsx` | 组装域 A + 域 B；管理 loadedConnectionChildrenMap |

Explorer 节点视觉由 `explorer-node-visual-registry` 收口：普通节点图标按 `ExplorerTreeNodeType` 查表，`asset_group` 图标按 `AssetGroupType` 查表，`connection` 节点使用 `ExplorerDriverConfig.treeVisual` 提供驱动图标。公共 `ExplorerNodeIcon` 只负责读取 registry 结果并渲染，不再维护长链 `node.type` 图标分支。

连接节点行视觉已完成 [Explorer node actions roadmap](../roadmap/explorer-node-actions.md) 的 Phase 1、Phase 2 和 Phase 3：行从单个 button 改为可承载 main action 与 trailing slot 的容器；`My` / `Pg` 等驱动缩写 badge 已移除；连接状态从独立状态点迁移到驱动图标状态框与轻量行 rail；用户连接标签作为本地展示元数据渲染在 trailing slot 中。

后续新增节点类型、资产分组或驱动层级时，应遵守 [workbench-registry-constraints.md](../development/workbench-registry-constraints.md)：共享 Explorer 组件只渲染统一节点模型，不恢复 driver / node type 业务分支。

### 6.2 节点类型完整枚举及实现状态

| 类型 | 域 | 图标（lucide-react） | 当前实现 | 备注 |
|---|---|---|---|---|
| `group` | A | `Folder` / `FolderOpen` | 是 | 用户自建文件夹 |
| `connection` | A | 驱动专属图标，可带状态框 | 是 | 连接 Profile；连接状态通过图标框和行 rail 表达 |
| `saved_query_group` | A | 当前 fallback 图标 | 是 | 本地保存查询分组；按 database/schema context 注入远程节点，或作为 `查询（未指定上下文）` 兜底组 |
| `saved_query` | A | 当前 fallback 图标 | 是 | 本地保存查询，携带 `profileId` 与 `SavedQuery` payload |
| `database` | B | `Database` | 是 | 关系型物理数据库；Redis 逻辑库使用 `redis_database` |
| `schema` | B | `Layers` | 是（结构已定义） | PostgreSQL schema / Oracle owner |
| `asset_group` | B | 按 `groupType` 选择 | 是 | 通用资产分组 |
| `table` | B | `Table` | 是 | |
| `view` | B | `ScanEye` | 是 | 关系型与 ClickHouse persistent View；ClickHouse Window/Live 仍属于此 kind |
| `materialized_view` | B | `Eye` | 是 | PostgreSQL / Oracle / ClickHouse Materialized 与 Refreshable Materialized View |
| `function` | B | `Braces` | 是 | MySQL/PostgreSQL/Oracle 只浏览名称 |
| `procedure` | B | `Workflow` | 是 | MySQL/PostgreSQL/Oracle 只浏览名称 |
| `trigger` | B | `Zap` | 是 | |
| `index` | B | `Hash` | 是 | |
| `dictionary` | B | `BookOpen` | 是 | ClickHouse dictionary；只读叶子 |
| `projection` | B | `PanelTop` | 是 | ClickHouse projection；只读叶子 |
| `sequence` | B | `ListTree` | 是 | PostgreSQL / Oracle |
| `extension` | B | `Puzzle` | 是 | PostgreSQL |
| `event` | B | `Timer` | 是 | MySQL |
| `column` | B | `Columns2` | 是 | `isLeaf=true` |
| `redis_database` | B | `Database` | 是 | Redis 逻辑库；可在 trailing slot 展示 DB 内 key 总数 |
| `redis_key_prefix` | B | `Folder` / `FolderOpen` | 是 | Redis key 前缀；Explorer 不统计前缀总数，前缀数量由 Redis 内容标签页展示 |
| `redis_key` | B | `KeyRound` | 是 | Redis key；`isLeaf=true` |
| `collection` / `document` / `field` | B | `Box` / `FileJson` / `Columns2` | 预留 | 文档数据库 |
| `vector_collection` | B | `Sigma` | 预留 | 向量数据库 |
| `partition` | B | `Server` | 是 | ClickHouse 聚合 partition；不代表 individual part |
| `node_label` | B | `CircleDot` | 预留 | 图数据库 Neo4j Label |
| `relationship_type` | B | `ArrowLeftRight` | 预留 | 图数据库关系类型 |
| `search_index` / `data_stream` / `mapping_field` | B | `Search` / `FileText` / `Columns2` | 预留 | 搜索引擎 |

### 6.3 `RemoteNodeMetadata` 与 `ContainerRef`

```ts
export interface RemoteNodeMetadata {
    profileId: string;
    container?: ContainerRef;
    dbName?: string;      // 派生显示字段：数据库名或 Redis 逻辑库索引
    schemaName?: string;  // 派生显示字段：PostgreSQL schema 或 Oracle owner 名称
    tableName?: string;   // 派生显示字段：表名
    typeName?: string;    // 派生显示字段：列类型或 Redis value 类型
    nullable?: boolean;   // 派生显示字段：列是否可为空
    itemCount?: number;   // 可选展示统计；例如 Redis DB 内 key 总数
    properties?: ContainerProperty[]; // 通用只读展示属性
}
```

`container` 是远端节点的权威寻址信息，直接来自后端 `DataContainer.container`，后续传回 `list_containers`、`browse_table_data`、Redis key-value IPC。`container.groupType` 表示资产分组语义。`dbName` / `schemaName` / `tableName` 仅用于兼容现有 UI 标题与展示，不再作为 IPC 契约。`itemCount` 是可选展示型统计元数据，不参与寻址，也不表示当前 Explorer 已加载的直接子节点数量。`properties` 只承载安全、截断后的只读展示文本；不参与 node ID、`ContainerRef`、capability、菜单资格、mutation 或 runtime health。公共 UI 只读取 `label/value`，不解释 driver property key。

| 字段 | 填充层级 | 说明 |
|---|---|---|
| `profileId` | 所有域 B 节点 | 由 `buildDatabaseNodes` 等工厂函数注入 |
| `container` | 所有域 B 节点 | 后端返回的统一 `ContainerRef` |
| `dbName` | `database` 及以下 | 库名，Redis 为数字字符串索引 |
| `schemaName` | `schema` 及以下 | PostgreSQL schema 或 Oracle owner 展示名；Oracle Phase 1.5 后 schema 可直接作为连接根子节点 |
| `tableName` | `table` 及以下 | 表名展示/Tab 标题 |
| `typeName` / `nullable` | `column`、`redis_key` 等 | 仅用于显示和复制元数据，不作为 IPC 寻址字段 |
| `itemCount` | 可选 | 容器内业务条目总数；当前仅 Redis `redis_database` 填充为该逻辑库 key 总数，未来可复用于 asset group、collection、search index 等 |
| `properties` | 可选 | 通用只读属性；当前 ClickHouse 用于 engine、default/codec/key flags、index/projection/partition 摘要，其他驱动可复用 |

### 6.4 `loadedConnectionChildrenMap` Key 命名规范

`loadedConnectionChildrenMap` 的 key 使用 Explorer node id，即 `buildRemoteNodes()` 生成的 `${profileId}::${DataContainer.id}`。后端负责保证 `DataContainer.id` 在 profile 内稳定唯一；前端不再按 `dbName/tables/views` 规则拼接远端 key。

保存查询属于本地 Storage 域，但展示位置按执行 context 注入远程 database/schema 节点。连接节点只在存在无 database context 的保存查询时显示 `查询（未指定上下文）` 兜底组；连接加载数据库后，渲染层仍会合并兜底组与 `loadedConnectionChildrenMap[connection.id]`。MySQL 查询展示在 `database -> 查询`。PostgreSQL 查询展示在 `database -> schema -> 查询`，其中 `查询` 是 schema 的子节点，与 `表`、`视图` 等虚拟 asset group 同级；不会在 PostgreSQL database 节点下注入 `查询` 分组。对应 context 下的 `查询` 分组即使当前没有保存查询也会显示，因为它同时承担“在该 context 下新建查询”的入口。

保存查询的上下文挂载位置由 `ExplorerDriverConfig.savedQueryContextLevels` 决定。MySQL 当前注册为 database 级查询组，PostgreSQL 与 Oracle 注册为 schema 级查询组，Redis 不注册 SQL 查询组。Oracle Phase 1 初始视觉路径为 `connection -> service/SID -> schema -> 查询`；Phase 1.5 后当前视觉路径为 `connection -> schema -> 查询`，但保存查询 context 仍保留 `database` 字段作为当前 service/SID 内部上下文。`savedQueryNodes` 只消费 driver config，不按具体 driver 名称写特例。

### 6.5 `loadChildren` 路由表

| `node.type` | 动作 | IPC | 当前实现 |
|---|---|---|---|
| `"saved_query_group"` | 展开本地保存查询列表；菜单可按 group context 新建查询 | `list_saved_queries` 由 Explorer 面板按 profile 加载 | 是 |
| `"saved_query"` | 打开或删除本地保存查询 | `delete_saved_query` 仅删除时调用 | 是 |
| `"connection"` | 建连 + 拉根容器 | `connect_profile` + `list_containers(parent=null)` | 是 |
| `"database"` | 拉 database 子容器 | `list_containers(parent=container)` | 是 |
| `"schema"` | 拉 schema 子容器 | `list_containers(parent=container)` | 是 |
| `"asset_group"` | 拉分组内真实对象 | `list_containers(parent=container)` | 是 |
| `"table"` / `"view"` / `"materialized_view"` | 拉 Columns / Indexes / Triggers 等资产分组；primary action 打开 table data | `list_containers(parent=container)` / `browse_table_data` | 是 |
| `"redis_database"` | 拉 key prefix / key；primary action 打开 key-value tab；可展示 DB key 总数 | `list_containers(parent=container)` | 是 |
| `"redis_key_prefix"` | 拉下级 prefix / key；primary action 打开 filtered key-value tab；Explorer 不计算前缀总数 | `list_containers(parent=container)` | 是 |
| `"redis_key"` | primary action 打开 Redis key 详情 tab | `get_key_value` 由内容面板触发 | 是 |
| `"collection"` | 拉字段/索引 | 待补充 IPC | 预留 |
| `"node_label"` / `"relationship_type"` | 拉图结构 | 待补充 IPC | 预留 |
| 叶子节点（如 `column`）| 无操作 | 无 | — |

### 6.6 新增节点类型操作步骤（Checklist）

1. 在 `types.ts` 的 `ExplorerTreeNodeType` 联合中追加新类型字符串
2. 若需要新字段，扩展 `RemoteNodeMetadata`；否则复用现有结构体
3. 选择对应节点结构体（`ExplorerTreeDatabaseNode` / `ExplorerTreeVirtualFolderNode` / `ExplorerTreeRemoteEntityNode`）或新建
4. 在 `explorer-node-visual-registry.tsx` 中注册节点视觉；若是新驱动连接图标，则在对应 `ExplorerDriverConfig.treeVisual` 中注册
5. 在 `useExplorerMetadataStore.ts` 的 `loadChildren` switch 中追加 case
6. 在 `buildRemoteNodes.ts` 中实现对应的工厂函数
7. 更新本文件的枚举表格（6.2 节）
8. 在 `remoteActionContributors.ts` 注册该节点族需要的右键菜单和 primary action；若动作只属于某个驱动，则在对应 `ExplorerDriverConfig.remoteActionContributors` 注册贡献器
9. 按 [workbench-registry-constraints.md](../development/workbench-registry-constraints.md) 跑结构检查，确认公共组件没有新增集中枚举分支

### 6.7 节点动作与默认行为

右键菜单和双击默认行为由 `src/features/workbench/explorer/actions/` 的 action registry 统一派生。树组件只渲染 `ExplorerNodeActionSet`，并在双击时执行 `primaryActionId`。没有 primary action 的节点回退为展开/收起；Chevron 始终只负责展开/收起。非叶子的远程节点即使尚未加载 children，也显示 Chevron 以表达“可进入下一层”；已连接、已展开或已加载过 children 的节点通过更强的 label 字重标识状态。

远程节点菜单必须基于 `ContainerRef` 和 driver capabilities，而不是在 `ConnectionTreeNode` 中按具体驱动硬编码。

保存查询节点属于域 A，但 SQL 打开能力仍依赖连接 runtime。连接离线时仍可展开连接级 `查询（未指定上下文）` 兜底组并删除本地保存查询；database/schema 下的 `查询` 分组由已加载远程节点注入。`savedQuery.new` 会继承 group.context，`savedQuery.new` / `savedQuery.open` 只有在连接已打开且 `capabilities.sqlExecutor === true` 时启用。

### 6.8 域 A 拖拽整理规则

连接列表只允许可整理的域 A 节点参与拖拽：`group` 文件夹和 `connection` 连接。保存查询节点按 context 注入树中展示，但不参与连接树拖拽整理。域 B 远程元数据节点（database、schema、asset_group、table、Redis key 等）不允许拖拽，也不能作为本地整理目标。

当前采用分组排序模型：每个父级下始终先显示文件夹，再显示连接；文件夹排序只影响文件夹组，连接排序只影响连接组。同类型节点拖到目标节点上/下边缘时，按目标节点的父级做 before/after 排序；连接或文件夹拖到文件夹中部时，移动到该文件夹内并排到对应类型列表末尾。文件夹不能拖入自身或自己的后代，前端会阻止该交互，后端 `reorder_connection_tree` 仍会在事务内做循环校验兜底。

拖拽结果通过存储层 IPC `reorder_connection_tree` 持久化到本地 SQLite，仅更新 `connection_folders.parent_id/sort_order` 与 `connections.folder_id/sort_order`，不影响已建立的数据库 runtime。

### 6.9 域 A 文件夹展开状态

域 A 文件夹的展开/折叠状态由 `explorer-slice` 管理，并随工作区 UI 偏好写入 Tauri workspace store。首次启动或旧配置尚未初始化该字段时，文件夹继续沿用当前默认展开行为；一旦用户手动展开/折叠，或拖拽悬停触发文件夹自动展开，`expandedNodeIds` 便成为后续渲染的权威状态。

该持久化只覆盖本地 `group` 文件夹。域 B 远程元数据节点仍保留会话内的按需加载和展开状态，不会被写入 workspace store。布局状态与 Explorer 状态共享同一个 workspace payload，写入时通过统一 patch 合并，避免两个 UI 偏好互相覆盖。

### 6.10 域 A 连接搜索

连接列表搜索是纯前端行为，复用 `explorer-slice` 中的 `searchQuery` 会话状态，不调用后端 IPC，也不写入 workspace store。搜索只匹配 `connection` 节点名称，文件夹名称不参与匹配；命中的连接会保留其祖先文件夹路径，没有命中连接的空文件夹在搜索态隐藏。

搜索态只改变可见树节点，不改变 SQLite 中的文件夹/连接归属与排序。命中连接的祖先文件夹会在搜索视图中临时展开，但不改写持久化的文件夹展开状态。为避免在过滤视图中产生排序歧义，`searchQuery.trim()` 非空时禁用域 A 拖拽整理；清空搜索后恢复完整树和拖拽能力。

### 6.11 域 B 结构管理入口

Explorer 的结构管理入口由 action registry、schema designer surface registry 和后端 capabilities 共同控制。`schemaMutation` 按 object kind 与 operation 提供具体授权：已连接的 `connection` 节点只有在声明 database/create 时展示“新增数据库”；远程 `database` 节点分别按 database/create、database/alter、database/drop 展示“新建数据库 / 编辑数据库 / 删除数据库”。迁移期 `schemaMutator` 只保留兼容语义，不能作为这些具体动作的 fallback。database 节点上的新建入口仍是连接级动作：它通过 `metadata.profileId` 找到所属连接，并在该连接下创建同级数据库，不是创建当前 database 的子节点。

这些结构管理动作属于域 B 远程 metadata 操作，不改变域 A 的本地连接配置、文件夹归属或排序。创建、编辑、删除成功后，前端清理该 profile 的 metadata cache，invalidate profile query，并刷新连接根节点。PostgreSQL 如果连接配置固定了默认库，创建出的同级数据库是否出现在根节点仍取决于当前根节点浏览策略。

前端通过 `preview_create_database` / `create_database`、`preview_update_database` / `update_database`、`preview_drop_database` / `drop_database` 等 Engine IPC 提交结构化输入，不拼接结构管理 SQL，也不复用 `execute_sql`。SQL 预览必须以后端 driver 生成结果为准。MySQL 创建/编辑可使用后端 `list_mysql_character_sets` 从当前连接执行 `SHOW CHARACTER SET` 获取字符集选项；编辑数据库时还会通过 `get_mysql_database_character_set` 读取当前 database 默认字符集并回填表单。MySQL 编辑只支持默认字符集，不支持数据库重命名。PostgreSQL 编辑支持名称、注释和表空间。删除数据库 V1 不主动断开其他连接，忙碌或权限不足等错误由后端结构化错误透出。

普通 `table` 节点只有在声明 table/drop 时展示“删除表”入口。该入口使用注册后的关系型或 native 结构化 Engine IPC，由后端根据 `ContainerRef` 生成 DROP TABLE SQL；前端不拼接 DDL，也不复用 SQL editor。删除表必须经过不可恢复确认和 SQL 预览，执行阶段必须传 `confirmDestructive=true`。ClickHouse persistent `view` / `materialized_view` 使用独立 View contributor 与 `preview_change_clickhouse_view` / `execute_clickhouse_view_change`，按 view 或 materialized_view 的精确 `drop` capability、server support 和 typed confirmation 开放；asset group、column、Redis 节点及 Temporary View 不复用普通表删除入口。成功后前端关闭匹配 `profileId + ContainerRef` 的 data/design tab，并精确刷新 definition、asset group 和依赖缓存。

“设计表结构”不等同于 alter 授权。Explorer 只有在 `schema-designer-surface-registry` 能解析 driver/object/edit registration 时才显示入口，并通过 registration 打开具体 typed tab；没有 registration 时不回退到关系型 Table Designer。MySQL/PostgreSQL/Oracle 的关系型 edit surface 仍要求 table/alter。ClickHouse table/edit 可依据 `schemaBrowser=true` 打开 `clickhouse_table_design`，每个 section 再按精确 capability 控制写入；persistent View/MV edit 进入 `clickhouse_view_design`，按静态 view/MV operation 与七类 runtime support 双重 gate。Views/Materialized Views asset group 只在相应 create capability 和 family support 可用时提供新建入口。Temporary View 不进入 shared Explorer，只从 SQL Editor 的 Session Views 打开 dependent designer。加载、ready、restricted、readonly、sessionExpired 和 error 统一进入公共底部状态栏。

后端关系型写入仍通过 `SchemaMutator` trait 分发，`as_schema_mutator()` 是误调用时的最终兜底；MySQL / PostgreSQL / Oracle 支持各自已落地并在 `schemaMutation` 中声明的子集。ClickHouse 保持 `schemaMutator=false`、`as_schema_mutator()=None`，但通过 `NativeSchemaExtension` 声明 Database/Table/Column/Projection/Index/View/Materialized View 七个精确对象项；Redis 保持 `schemaMutation=None`。Redis 的 `redis_database` 是非关系型逻辑库节点，不展示这些数据库结构管理菜单；native surface 也不会因为可 Describe 而自动获得 mutation capability。

### 6.12 连接节点行视觉演进

当前 `ConnectionTreeNode` 已完成 Phase 1、Phase 2 和 Phase 3：节点行由非 button row root、可聚焦 main action 区和可选 trailing slot 组成；连接状态通过驱动图标的低透明圆形背景、状态色 ring 和可选细 rail 表达；驱动缩写 badge 已移除；用户连接标签作为域 A 本地展示元数据渲染在 trailing slot 中。

按 [Explorer Node Row Roadmap](../roadmap/explorer-node-actions.md) 的当前约束：

- 节点行已改为容器模型，拆分为 main action 区和 trailing slot；main action 保留选择、双击、展开、懒加载和右键菜单行为，trailing slot 用于用户标签和未来轻量操作。
- Explorer 树内容宽度受当前 ScrollArea viewport 约束，不提供横向滚动；深层对象、列类型、Redis 键名和展示属性都必须在各自行内截断，不能把祖先连接行撑出面板。
- 窄宽度下，连接名称是可退让内容：main action 区至少保留箭头、驱动图标和一个省略号的宽度，名称先截断；仅当该最小宽度也无法满足时，trailing slot 才允许收缩并被节点行裁剪。
- 连接状态不再占用独立圆点列，而是通过驱动图标的低透明圆形背景、状态色 ring 和可选细 rail 表达。
- 驱动缩写 badge（如 `My`、`Pg`、`Re`、`Or`）移除；数据库类型继续由驱动图标与可访问标签表达。
- 用户连接标签与备注属于域 A 本地配置空间。标签通过连接记录的 `tagLabel` / `tagColor` 字段进入 row trailing slot；备注通过公共 `note` 字段保存，但不在连接树中渲染。两者都不参与连接 runtime、远程 metadata、SQL 执行、结构变更或排序过滤。
- Redis `redis_database` 节点可使用通用 `itemCount` 展示该逻辑库 key 总数；Redis 前缀级数量仍由内容区 `browse_key_tree` 展示，避免 Explorer 展开前缀时触发完整 `SCAN MATCH prefix*`。

Phase 1、Phase 2 和 Phase 3 已落地；轻量行内操作仍属于后续阶段。
