/**
 * 数据库连接层核心类型定义。
 * 与 Rust 存储模型、Engine Profile 和 IPC 类型保持同步。
 */

// ─── 基础枚举 ─────────────────────────────────────────────────────────────────

export type EnvironmentType = "development" | "testing" | "production";

/**
 * 所有支持（或规划支持）的数据库驱动标识。
 * 新驱动在此处添加后，TS 联合类型自动生效，无需修改其他基础设施代码。
 */
export type DbDriver =
    // 关系型
    | "mysql" | "postgres" | "sqlite" | "oracle" | "sqlserver" | "clickhouse"
    // 键值 / 文档 / 搜索
    | "redis" | "mongodb" | "elasticsearch"
    // 向量型 — AI 原生核心
    | "chroma" | "milvus" | "qdrant" | "pinecone" | "weaviate"
    // 图型
    | "neo4j" | "neptune" | "arangodb";

/** 向后兼容别名，旧代码中使用 ConnectionDriver 的地方无需修改。 */
export type ConnectionDriver = DbDriver;

/** 连接唯一标识（约定使用 UUID 字符串） */
export type ConnectionId = string;

/** 连接文件夹唯一标识（约定使用 UUID 字符串） */
export type ConnectionFolderId = string;

/** 连接最近一次连接状态 */
export type ConnectionRecordStatus = "connected" | "disconnected" | "unknown";

/** 用户自定义连接标签颜色，仅作为本地展示元数据使用。 */
export type ConnectionTagColor =
    | "slate"
    | "red"
    | "orange"
    | "amber"
    | "emerald"
    | "teal"
    | "sky"
    | "violet"
    | "pink";

// ─── 全局基础配置 ─────────────────────────────────────────────────────────────

/** 所有数据库连接共享的通用业务元数据。 */
export interface IBaseConnectionProfile {
    id: string;
    name: string;
    environment: EnvironmentType;
    color?: string;
    tagLabel?: string;
    tagColor?: ConnectionTagColor | null;
    createdAt: number;   // Unix ms
    updatedAt: number;   // Unix ms
}

// ─── 三大物理连接模型 ─────────────────────────────────────────────────────────

export type SshAuthMethod = "password" | "private-key";

export type SshHostVerificationMode = "trust-on-first-use" | "skip";

export interface ISshTunnelConfig {
    enabled: boolean;
    host: string;
    port: number;
    username: string;
    authMethod: SshAuthMethod;
    password?: string;
    privateKeyPath?: string;
    privateKeyPassphrase?: string;
    hostVerification?: SshHostVerificationMode;
    hostKeyFingerprint?: string | null;
}

/** 网络直连型：MySQL、Postgres、Redis、MongoDB、Neo4j、Milvus 等 */
export interface INetworkConfig {
    host: string;
    port: number;
    username?: string;
    password: string;       // v1: 存于 payload；v2: 迁移至 OS Keyring
    savePassword: boolean;  // 占位标记，v2 启用 Keyring 后置为 true
    connectTimeoutSeconds?: number;
    sshTunnel?: ISshTunnelConfig;
}

/** 本地文件型：SQLite、Chroma (本地模式) */
export interface ILocalFileConfig {
    dbFilePath: string;
    isReadOnly?: boolean;
}

/** 云端 API 型：Pinecone、Qdrant Cloud */
export interface ICloudApiConfig {
    endpoint: string;
    saveApiKey: boolean;
}

// ─── 各数据库专属 Payload ─────────────────────────────────────────────────────

// — 关系型 —

export interface IMysqlPayload extends INetworkConfig {
    driver: "mysql";
    defaultDatabase?: string;
    sslMode?: "disable" | "require" | "verify-ca" | "verify-identity";
}

export interface IPostgresPayload extends INetworkConfig {
    driver: "postgres";
    defaultDatabase?: string | null;
    schema?: string;
    sslMode?: "disable" | "require" | "verify-ca" | "verify-full";
}

export interface ISqlitePayload extends ILocalFileConfig {
    driver: "sqlite";
}

export interface IOraclePayload extends INetworkConfig {
    driver: "oracle";
    serviceName?: string;
    sid?: string;
    connectDescriptor?: string;
    role?: "normal" | "sysdba" | "sysoper";
}

export interface IClickHousePayload extends INetworkConfig {
    driver: "clickhouse";
    protocol: "http" | "https";
    defaultDatabase?: string;
}

// — 键值 / 文档 / 搜索 —

export interface IRedisPayload extends INetworkConfig {
    driver: "redis";
    dbIndex?: number | null;
    useTLS?: boolean;
}

export interface IMongoDbPayload extends INetworkConfig {
    driver: "mongodb";
    authSource?: string;
    replicaSet?: string;
}

export interface IElasticsearchPayload extends INetworkConfig {
    driver: "elasticsearch";
    indexPrefix?: string;
}

// — 向量型 —

export interface IMilvusPayload extends INetworkConfig {
    driver: "milvus";
    defaultCollection?: string;
}

export interface IQdrantPayload extends INetworkConfig {
    driver: "qdrant";
}

export interface IQdrantCloudPayload extends ICloudApiConfig {
    driver: "qdrant";
}

export interface IPineconePayload extends ICloudApiConfig {
    driver: "pinecone";
    environmentStr: string;
}

export interface IWeaviatePayload extends INetworkConfig {
    driver: "weaviate";
}

export interface IChromaPayload {
    driver: "chroma";
    mode: "local" | "network";
    localConfig?: ILocalFileConfig;
    networkConfig?: INetworkConfig;
}

// — 图型 —

export interface INeo4jPayload extends INetworkConfig {
    driver: "neo4j";
    database?: string;
    encryption?: "basic" | "tls";
}

export interface INeptunePayload extends ICloudApiConfig {
    driver: "neptune";
}

export interface IArangoDbPayload extends INetworkConfig {
    driver: "arangodb";
    defaultDatabase?: string;
}

// ─── 最终聚合联合类型 ─────────────────────────────────────────────────────────

/**
 * 核心连接配置联合类型（UI 渲染、Store 存储、IPC 传输均使用此类型）。
 * TypeScript 会根据 `driver` 字段自动推断出对应的参数范围。
 */
export type IConnectionProfile = IBaseConnectionProfile & (
    | IMysqlPayload
    | IPostgresPayload
    | ISqlitePayload
    | IOraclePayload
    | IClickHousePayload
    | IRedisPayload
    | IMongoDbPayload
    | IElasticsearchPayload
    | IMilvusPayload
    | IQdrantPayload
    | IPineconePayload
    | IWeaviatePayload
    | IChromaPayload
    | INeo4jPayload
    | INeptunePayload
    | IArangoDbPayload
);

// ─── 持久化扩展类型 ───────────────────────────────────────────────────────────

/**
 * 持久化连接记录：在 IConnectionProfile 基础上附加存储层字段。
 * 这是从 Rust 后端读取并在前端 Store 中保存的完整记录类型。
 */
export type IStoredConnectionProfile = IConnectionProfile & {
    folderId?: ConnectionFolderId | null;
    sortOrder?: number | null;
    lastConnectedAt?: number | null;
    lastConnectionStatus?: ConnectionRecordStatus | null;
    lastConnectionError?: string | null;
};

/** 向后兼容别名 */
export type StoredDatabaseConnection = IStoredConnectionProfile;

// ─── Create / Update 输入类型 ─────────────────────────────────────────────────

/** 创建连接的输入类型 */
export type ICreateConnectionInput = IConnectionProfile & {
    folderId?: ConnectionFolderId | null;
    sortOrder?: number | null;
};

/** 更新连接的输入类型 */
export type IUpdateConnectionInput = ICreateConnectionInput;

/** 向后兼容别名 */
export type CreateDatabaseConnectionInput = ICreateConnectionInput;
export type UpdateDatabaseConnectionInput = IUpdateConnectionInput;

// ─── 连接文件夹类型 ───────────────────────────────────────────────────────────

export interface ConnectionFolderBase {
    id: ConnectionFolderId;
    name: string;
    parentId?: ConnectionFolderId | null;
}

export interface ConnectionFolderRecordMetadata {
    createdAt: number;   // Unix ms
    updatedAt: number;   // Unix ms
    sortOrder?: number | null;
}

export type StoredConnectionFolder = ConnectionFolderBase & ConnectionFolderRecordMetadata;

export type CreateConnectionFolderInput = {
    id: ConnectionFolderId;
    name: string;
    parentId?: ConnectionFolderId | null;
    sortOrder?: number | null;
};

export type UpdateConnectionFolderInput = CreateConnectionFolderInput;

export type ConnectionHierarchyItem = IStoredConnectionProfile | StoredConnectionFolder;

export type ConnectionTreeFolderPatch = {
    id: ConnectionFolderId;
    parentId?: ConnectionFolderId | null;
    sortOrder?: number | null;
};

export type ConnectionTreeConnectionPatch = {
    id: ConnectionId;
    folderId?: ConnectionFolderId | null;
    sortOrder?: number | null;
};

export type ReorderConnectionTreeInput = {
    folderPatches: ConnectionTreeFolderPatch[];
    connectionPatches: ConnectionTreeConnectionPatch[];
};

export type ReorderConnectionTreeResult = {
    updatedFolders: number;
    updatedConnections: number;
};
