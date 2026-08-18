export type {
    AppLanguage,
    AppSettings,
    AppSettingsCommon,
    AppSettingsEditor,
    EditorLineNumbers,
    EditorRenderWhitespace,
    EditorWordWrap,
    ThemeMode,
} from "./settings"

export type {
    TableColumnDraft,
    TableConstraintDraft,
    TableConstraintDraftKind,
    TableDesignBasicsDraft,
    TableDesignMode,
    TableIndexDraft,
    TableSchemaDraft,
} from "./table-design"

export type {
    TableDataPayload,
    KeyValuePayload,
    SqlEditorPayload,
    TableDesignPayload,
    JsonViewerPayload,
    GraphTopologyPayload,
    DashboardPayload,
} from "./tab-payloads"

export * from "./saved-queries";
export * from "./connection-runtime";

export type {
    // 枚举与基础类型
    EnvironmentType,
    DbDriver,
    ConnectionDriver,
    ConnectionId,
    ConnectionFolderId,
    ConnectionRecordStatus,
    ConnectionTagColor,

    // 物理连接模型
    SshAuthMethod,
    SshHostVerificationMode,
    ISshTunnelConfig,
    INetworkConfig,
    ILocalFileConfig,
    ICloudApiConfig,

    // 各数据库专属 Payload
    IMysqlPayload,
    IPostgresPayload,
    ISqlitePayload,
    IOraclePayload,
    IClickHousePayload,
    IRedisPayload,
    IMongoDbPayload,
    IElasticsearchPayload,
    IMilvusPayload,
    IQdrantPayload,
    IQdrantCloudPayload,
    IPineconePayload,
    IWeaviatePayload,
    IChromaPayload,
    INeo4jPayload,
    INeptunePayload,
    IArangoDbPayload,

    // 核心联合类型
    IBaseConnectionProfile,
    IConnectionProfile,
    IStoredConnectionProfile,

    // 持久化 & 输入类型
    ICreateConnectionInput,
    IUpdateConnectionInput,

    // 向后兼容别名
    StoredDatabaseConnection,
    CreateDatabaseConnectionInput,
    UpdateDatabaseConnectionInput,

    // 文件夹类型
    ConnectionFolderBase,
    ConnectionFolderRecordMetadata,
    StoredConnectionFolder,
    CreateConnectionFolderInput,
    UpdateConnectionFolderInput,
    ConnectionTreeFolderPatch,
    ConnectionTreeConnectionPatch,
    ReorderConnectionTreeInput,
    ReorderConnectionTreeResult,
    ConnectionHierarchyItem,
} from "./connections"
