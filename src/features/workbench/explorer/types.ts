import type { StoredDatabaseConnection } from "@/types";
import type { ConnectionStatus } from "@/types/connection-runtime";
import type { ContainerProperty, ContainerRef } from "@/types/ipc";
import type { SavedQuery, SqlExecutionContext } from "@/types/saved-queries";

/** 连接状态，用于树节点状态点展示。 */
export type ConnectionNodeStatus = "connected" | "disconnected" | "unknown";

/** 状态点显示策略。 */
export type ConnectionStatusIndicatorMode =
    | "none"
    | "connected-only"
    | "all";

/** 连接节点运行时状态。 */
export type ConnectionNodeRuntimeState = ConnectionStatus | "loading";

/**
 * Explorer 树节点类型完整枚举。
 *
 * 域 A（本地配置空间）：连接文件夹、连接 Profile，以及连接下的保存查询节点
 * 域 B（远程元数据空间）：database / schema / asset_group / 数据实体节点 / Redis key 节点
 */
export type ExplorerTreeNodeType =
    // ── 域 A：本地配置空间 ──────────────────────────────────────
    | "group"               // 用户自建连接文件夹
    | "connection"          // 数据库连接 Profile
    | "saved_query_group"   // 连接下的本地保存查询分组
    | "saved_query"         // 本地保存查询

    // ── 域 B：物理容器节点 ──────────────────────────────────────
    | "database"            // 物理数据库
    | "schema"              // 物理模式（Postgres schema 专用）
    | "asset_group"         // 后端返回的通用资产分组

    // ── 域 B：关系型数据实体 ────────────────────────────────────
    | "table"               // 数据表
    | "view"                // 视图
    | "materialized_view"    // 物化视图
    | "function"            // 存储函数
    | "procedure"           // 存储过程
    | "trigger"             // 触发器
    | "index"               // 索引
    | "dictionary"          // 字典
    | "projection"          // 投影
    | "sequence"            // 序列
    | "extension"           // 扩展
    | "event"               // 调度事件
    | "column"              // 列字段（isLeaf=true）

    // ── 域 B：Redis 实体 ──────────────────────────────────────
    | "redis_database"      // Redis 逻辑库
    | "redis_key_prefix"    // Redis key 前缀
    | "redis_key"           // Redis key

    // ── 域 B：向量数据库实体 ────────────────────────────────────
    | "collection"          // 文档集合
    | "document"            // 文档
    | "field"               // 字段
    | "vector_collection"   // 向量集合（Milvus / Chroma / Qdrant / Weaviate）
    | "partition"           // 向量分区

    // ── 域 B：图数据库实体（枚举已定义，当前阶段暂不实现加载逻辑）────
    | "node_label"          // 图节点标签（Neo4j Label）
    | "relationship_type"   // 图关系类型

    // ── 域 B：搜索引擎实体 ─────────────────────────────────────
    | "search_index"        // 搜索索引
    | "data_stream"         // 数据流
    | "mapping_field";      // mapping 字段

/** 远程节点寻址元数据，用于 loadChildren 路由和 IPC 参数构造。 */
export interface RemoteNodeMetadata {
    profileId: string;
    /** 后端统一容器引用，用于新 runtime IPC。 */
    container?: ContainerRef;
    /** 数据库名或 Redis 逻辑库索引（如 "0"、"1" ... "15"）。 */
    dbName?: string;
    /** Postgres schema 名称。 */
    schemaName?: string;
    /** 表名，用于列查询。 */
    tableName?: string;
    /** 远程对象类型展示字段，例如列类型或 Redis value 类型。 */
    typeName?: string;
    nullable?: boolean;
    /** 可选展示统计，例如 Redis 逻辑库内 key 总数。 */
    itemCount?: number;
    /** 通用只读属性，只用于展示，不参与节点寻址或动作资格。 */
    properties?: ContainerProperty[];
}

type ExplorerTreeNodeBase = {
    /** 树节点唯一标识。 */
    id: string;
    /** 节点显示名称。 */
    label: string;
    /** 首次渲染时是否默认展开。 */
    defaultExpanded?: boolean;
    /** 子节点集合，后续可扩展为表、视图等。 */
    children?: ExplorerTreeNode[];
};

/** 目录 / 分组节点（域 A）。 */
export type ExplorerTreeGroupNode = ExplorerTreeNodeBase & {
    type: "group";
};

/** 连接节点，复用领域层连接模型（域 A）。 */
export type ExplorerTreeConnectionNode = ExplorerTreeNodeBase & {
    type: "connection";
    status: ConnectionNodeStatus;
    connection: StoredDatabaseConnection;
    /** 延迟加载的子节点，仅在连接成功后才展示。 */
    lazyChildren?: ExplorerTreeNode[];
};

/** 连接下的保存查询分组节点（域 A）。 */
export type ExplorerTreeSavedQueryGroupNode = ExplorerTreeNodeBase & {
    type: "saved_query_group";
    profileId: string;
    context?: SqlExecutionContext | null;
    isLeaf?: boolean;
};

/** 保存查询节点（域 A）。 */
export type ExplorerTreeSavedQueryNode = ExplorerTreeNodeBase & {
    type: "saved_query";
    profileId: string;
    query: SavedQuery;
    isLeaf: true;
};

/**
 * 数据库节点（域 B 物理容器）。
 */
export type ExplorerTreeDatabaseNode = ExplorerTreeNodeBase & {
    type: "database" | "asset_group";
    metadata: RemoteNodeMetadata;
    isLeaf?: boolean;
};

/**
 * 远程数据实体节点（域 B）。
 * 包含：schema / table / view / function / column / collection / node_label / relationship_type / Redis entities
 */
export type ExplorerTreeRemoteEntityNode = ExplorerTreeNodeBase & {
    type:
        | "schema"
        | "table"
        | "view"
        | "materialized_view"
        | "function"
        | "procedure"
        | "trigger"
        | "index"
        | "dictionary"
        | "projection"
        | "sequence"
        | "extension"
        | "event"
        | "column"
        | "collection"
        | "document"
        | "field"
        | "vector_collection"
        | "partition"
        | "node_label"
        | "relationship_type"
        | "search_index"
        | "data_stream"
        | "mapping_field"
        | "redis_database"
        | "redis_key_prefix"
        | "redis_key";
    isLeaf: boolean;
    metadata: RemoteNodeMetadata;
};

/** 连接列表树节点联合类型。 */
export type ExplorerTreeNode =
    | ExplorerTreeGroupNode
    | ExplorerTreeConnectionNode
    | ExplorerTreeSavedQueryGroupNode
    | ExplorerTreeSavedQueryNode
    | ExplorerTreeDatabaseNode
    | ExplorerTreeRemoteEntityNode;

/** 连接节点运行时信息。 */
export type ConnectionNodeRuntime = {
    state: ConnectionNodeRuntimeState;
    errorMessage?: string;
};

/** 连接节点运行时状态表。 */
export type ConnectionNodeRuntimeMap = Record<string, ConnectionNodeRuntime | undefined>;

/** 对外暴露给未来双击/右键入口的连接控制器。 */
export type ConnectionTreeController = {
    openConnection: (nodeId: string) => Promise<boolean>;
    resetConnection: (nodeId: string) => void;
};

/** 连接节点打开行为回调。 */
export type ConnectionNodeOpenHandler = (nodeId: string) => Promise<boolean>;
