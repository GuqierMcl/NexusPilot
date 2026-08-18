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
        "面向开发者和数据团队的专业数据工作台，把多源连接、结构浏览、查询编辑和 AI 辅助分析整合到一个高效的桌面环境。",
    heroPrimaryCta: "下载 NexusPilot",
    heroSecondaryCta: "查看文档",
    features: [
        {
            title: "原生驾驭每一种数据形态",
            description:
                "在同一工作区连接关系型、键值型、分析型及更多数据源；以能力模型呈现表、Key、TTL、分区与视图等原生操作，而非用同一种表格界面勉强套用。",
        },
        {
            title: "让 AI 成为懂数据的副驾",
            description:
                "AI 助手可以基于已打开的连接、真实的对象结构与查询结果协助探索、生成 SQL 和分析数据；它通过受限工具访问工作台，而不是凭空猜测你的数据库。",
        },
        {
            title: "NexusPilot Cloud，跨设备仍由你掌控",
            description:
                "通过端到端加密同步连接与文件夹，在已授权设备间保持工作区连续；Cloud 只协调账户、设备与密文，无法读取你的数据库连接、凭据或密钥。",
        },
        {
            title: "每一次变更，都经得起验证",
            description:
                "AI 发起的 SQL 与 Redis 写操作都要经过风险分析和审批。支持预览的表格与原生结构变更会在执行前展示计划，并在关键变更时核对远端状态，减少误操作和并发覆盖。",
        },
        {
            title: "从连接到洞察，一气呵成",
            description:
                "从连接树逐层进入数据库对象，在带上下文的 SQL 标签页中执行和保存查询，再回到数据网格或 AI 对话继续分析。连接状态、标签页和运行结果围绕同一个工作区协同，而非在多个工具间来回切换。",
        },
        {
            title: "安全，从边界开始",
            description:
                "NexusPilot 以原生桌面应用承载数据库连接；独立的本地 AI Runtime 管理模型与提供商配置，前端不直接保存或调用 LLM 凭据，为严肃的数据工作保留清晰的安全边界。",
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
