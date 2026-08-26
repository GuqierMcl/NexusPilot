> Status: **Aspirational**. 本文档描述未来目标架构，不代表当前实现。当前架构参见 [overview.md](../architecture/overview.md)。

# Nexus Pilot 架构愿景（Vision）

## 1. 架构愿景

Nexus Pilot 致力于打造下一代 AI 原生的全模态数据库管理平台。

为实现对各类异构数据库（关系型、图、向量、时序等）的无缝支持，彻底摒弃传统客户端“一类数据库一套 UI”的冗余设计。前端界面（基于 Tauri + React 构建）将严格遵循**“按数据范式分类视图，按数据库分类适配器”**的解耦原则。

## 2. 核心分层架构设计

为了保证代码的高复用性和极强的可扩展性，主工作区（中间多标签页内容区）严格划分为以下三层：

### 2.1 底层 UI 组件层 (UI Component Layer)

**定位**：纯粹的“哑组件”（Dumb Components），完全与业务逻辑、数据库类型解耦。

**核心原则**：只负责接收标准格式的数据并进行高性能渲染（如虚拟滚动），只对外暴露标准的交互事件（如 `onRowEdit`, `onQuerySubmit`）。

**核心组件库预想**：

- `VirtualDataGrid`：负责渲染百万级二维表格。
- `MonacoSqlEditor`：封装 Monaco Editor，提供多语言高亮。
- `JsonTreeEditor`：提供 JSON 节点的折叠与行内编辑。
- `GraphTopologyCanvas`：基于 WebGL/Canvas 的力导向图渲染器。

### 2.2 视图范式路由层 (Paradigm View Layer)

**定位**：基于“数据范式（Data Paradigm）”划分的页面级容器。

**核心原则**：不关心当前连接的是 MySQL 还是 Oracle，只关心当前需要展示的是“关系型范式”还是“图范式”。

**数据流向**：利用 Zustand 等全局状态管理工具，从适配器接收统一规范的 `IStandardData`，并将其分发给底层 UI 组件。

### 2.3 数据适配器层 (Data Adapter Layer)

**定位**：连接不同数据库底层驱动与前端视图层的“翻译官”。

**核心原则**：每新增支持一种数据库，**只需且仅需**编写一个新的 Adapter，UI 视图层实现零代码修改。

**工作机制**：将特定数据库（如 PostgreSQL 的 `pg_class`）的原始响应结构，转换为对应范式视图所要求的标准 TypeScript 接口（如 `IStandardTableData`）。

------

## 3. 数据范式与视图映射字典 (Data Paradigm & View Mapping)

Nexus Pilot 目前规划支持/预留的 8 种核心数据范式及其对应的标准 UI 视图方案：

| **数据范式 (Paradigm)**  | **核心结构特征**                 | **适配数据库示例**        | **Nexus Pilot 标准视图组件 (Standard View)**                 |
| ------------------------ | -------------------------------- | ------------------------- | ------------------------------------------------------------ |
| **关系型 (Relational)**  | 二维表格，强 Schema，主外键      | MySQL, PostgreSQL, SQLite | **DataGrid View** (带表头排序、过滤的二维虚拟滚动表格)       |
| **键值型 (Key-Value)**   | 字典映射，Value 为黑盒           | Redis, Memcached          | **KV Split View** (左侧 Key 目录树，右侧 Value 独立编辑器)   |
| **文档型 (Document)**    | 灵活 Schema，深度嵌套 JSON       | MongoDB, CouchDB          | **JSON Tree View** (支持深层折叠、节点独立操作的树状编辑器)  |
| **图型 (Graph)**         | 节点 (Node)、边 (Edge)、属性     | Neo4j, NebulaGraph        | **Graph Topology View** (交互式力导向图，侧边栏展示节点属性) |
| **向量型 (Vector)**      | 高维浮点数组，元数据，ANN 检索   | Milvus, Pinecone          | **Hybrid Search View** (列表展示 Metadata，支持语义检索/以图搜图面板) |
| **列族型 (Wide-Column)** | 稀疏表，行键 -> 列族，多版本     | Cassandra, HBase          | **Sparse Grid View** (支持大量 Null 渲染及时间戳版本切换的表格) |
| **时序型 (Time-Series)** | 追加写入，时间戳 + 标签 + 测量值 | InfluxDB, Prometheus      | **Metrics Dashboard View** (时间序列折线图/可视化仪表盘)     |
| **搜索引擎型 (Search)**  | 倒排索引，分词搜索，相关度打分   | Elasticsearch, Solr       | **Discovery Board View** (强大的多条件组合查询栏 + 高亮结果列表) |

------

## 4. AI 智能体工作台融合策略 (Agent Integration)

作为 AI 原生工具，最右侧的 `WorkbenchAgentPanel`（智能体工作台）并非孤立运行，而是与上述分层架构深度融合：

- **上下文感知 (Context Awareness)**：当用户在主内容区切换不同的“视图范式容器”时，容器会将当前的 `TableSchema` 或 `JSON Structure` 作为隐式上下文，实时同步至智能体状态中。
- **动作联动 (Action Dispatch)**：智能体生成的 SQL、图查询语言（Cypher）或数据分析结果，可以通过状态库直接分发至 `MonacoSqlEditor` 或 `VirtualDataGrid` 中进行预览和执行验证，形成闭环。
