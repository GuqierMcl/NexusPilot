export type DatabaseSupportStatus = "available" | "planned" | "hidden";

export const DATABASE_ICON_FILES = {
  mysql: "mysql-dark",
  postgresql: "postgresql",
  redis: "redis",
  oracle: "oracle",
  sqlite: "sqlite",
  clickhouse: "clickhouse",
  "microsoft-sql-server": "microsoft-sql-server",
  mongodb: "mongodb",
  chroma: "chroma",
  milvus: "milvus",
  qdrant: "qdrant",
  pinecone: "pinecone",
  weaviate: "weaviate",
  neo4j: "neo4j",
  "aws-amazon-neptune": "aws-amazon-neptune",
  arangodb: "arangodb",
  elasticsearch: "elasticsearch",
} as const;

export type DatabaseIconKey = keyof typeof DATABASE_ICON_FILES;

export interface ProductFeature {
  title: string;
  description: string;
}

export interface DatabaseSupportItem {
  name: string;
  type: string;
  status: DatabaseSupportStatus;
  iconKey: DatabaseIconKey;
}

export const product = {
    name: "NexusPilot",
    tagline: "用自然语言和你的数据库对话",
    summary:
        "一个理解真实连接、引擎原生对象和数据结果的 AI Native 多数据库工作台。用自然语言探索不同形态的数据源，并通过受控工具完成实际操作。",
    heroPrimaryCta: "下载 NexusPilot",
    heroSecondaryCta: "查看文档",
    features: [
        {
            title: "自然语言数据智能体",
            description:
                "在 Ask、Query 和 Agent 模式中，用自然语言提出数据问题或多步骤任务。智能体基于真实的连接状态、引擎对象和数据结果理解上下文，按数据源能力协助查询、探索、解释和操作数据。",
        },
        {
            title: "受控的智能体工具执行",
            description:
                "智能体通过工作台提供的受限工具使用数据源，而不是绕过应用建立隐藏连接。每次操作都会根据驱动能力、资源类型和风险级别独立校验；需要确认的变更会展示目标、计划和风险。",
        },
        {
            title: "多数据源连接与对象探索",
            description:
                "在统一连接树中管理关系型、键值型和分析型数据源，并持续扩展到更多数据形态。不同引擎展示自己的原生对象层级和可用操作，而不是被强行压缩为同一种表格模型。",
        },
        {
            title: "面向引擎的查询与操作工作区",
            description:
                "根据数据源的原生交互方式提供适配工作面，例如带上下文的查询编辑、Key 与 TTL 操作，以及分析引擎的原生查询和结果处理；新数据源按各自能力接入，而不必复用 SQL 或表格交互。",
        },
        {
            title: "数据内容查看与安全变更",
            description:
                "使用适合当前资源的数据视图查看和处理内容。读取、筛选、分页和变更入口由数据源与资源能力决定；支持写入时，通过预览、稳定定位、前置条件或事务等机制降低误操作和并发覆盖风险。",
        },
        {
            title: "引擎原生对象管理",
            description:
                "查看并管理每种数据源实际拥有的对象与结构。支持变更的资源会提供结构化编辑、执行计划或原生语句预览；无法可靠映射或验证的语义保持只读，避免用通用界面掩盖引擎差异。",
        },
        {
            title: "自选模型与本地 AI Runtime",
            description:
                "在本地 AI Runtime 中管理 Provider、Model 和凭据，同步 models.dev 目录，并支持自定义 OpenAI-compatible Provider。智能体通过受控桥接复用工作台连接；前端不保存 LLM 凭据。",
        },
        {
            title: "端到端加密的跨设备同步",
            description:
                "通过 NexusPilot Cloud 在已授权设备间同步连接和文件夹，支持设备授权、冲突处理与 Recovery Key 恢复。Cloud 只保存密文，无法读取连接凭据；本地工作台及 AI Runtime 均可独立运行。",
        },
    ] satisfies ProductFeature[],
    databases: [
        { name: "MySQL", type: "关系型", status: "available", iconKey: "mysql" },
        { name: "PostgreSQL", type: "关系型", status: "available", iconKey: "postgresql" },
        { name: "Redis", type: "键值型", status: "available", iconKey: "redis" },
        { name: "Oracle", type: "关系型", status: "available", iconKey: "oracle" },
        { name: "SQLite", type: "关系型", status: "available", iconKey: "sqlite" },
        { name: "ClickHouse", type: "列式分析型", status: "available", iconKey: "clickhouse" },
        { name: "SQL Server", type: "关系型", status: "planned", iconKey: "microsoft-sql-server" },
        { name: "MongoDB", type: "文档型", status: "planned", iconKey: "mongodb" },
        { name: "Chroma", type: "向量型", status: "planned", iconKey: "chroma" },
        { name: "Milvus", type: "向量型", status: "planned", iconKey: "milvus" },
        { name: "Qdrant", type: "向量型", status: "planned", iconKey: "qdrant" },
        { name: "Pinecone", type: "向量型", status: "planned", iconKey: "pinecone" },
        { name: "Weaviate", type: "向量型", status: "planned", iconKey: "weaviate" },
        { name: "Neo4j", type: "图数据库", status: "planned", iconKey: "neo4j" },
        { name: "Neptune", type: "图数据库", status: "planned", iconKey: "aws-amazon-neptune" },
        { name: "ArangoDB", type: "图数据库", status: "planned", iconKey: "arangodb" },
        { name: "Elasticsearch", type: "搜索引擎", status: "planned", iconKey: "elasticsearch" },
    ] satisfies DatabaseSupportItem[],
} as const;

export const supportedDatabases = product.databases.filter(
  (database) => database.status === "available",
);

export const plannedDatabases = product.databases.filter(
  (database) => database.status === "planned",
);
