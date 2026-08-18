import { z } from "zod";

const optionalString = z.string().optional();
const optionalUnsignedInteger = z.number().int().nonnegative().optional();

export const aiSshTunnelSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  host: optionalString,
  port: optionalUnsignedInteger,
  username: optionalString,
  authMethod: optionalString,
  hostVerification: optionalString,
  hostKeyFingerprint: optionalString,
}).strict();

export const aiLocalFileSettingsSchema = z.object({
  dbFilePath: optionalString,
  isReadOnly: z.boolean().optional(),
}).strict();

export const aiNetworkSettingsSchema = z.object({
  host: optionalString,
  port: optionalUnsignedInteger,
  username: optionalString,
  connectTimeoutSeconds: optionalUnsignedInteger,
  sshTunnel: aiSshTunnelSettingsSchema.optional(),
}).strict();

export const aiConnectionLocationSchema = z.object({
  host: optionalString,
  port: optionalUnsignedInteger,
  username: optionalString,
  defaultDatabase: optionalString,
  schema: optionalString,
  serviceName: optionalString,
  sid: optionalString,
  dbIndex: optionalUnsignedInteger,
  dbFilePath: optionalString,
  endpoint: optionalString,
  database: optionalString,
  defaultCollection: optionalString,
}).strict();

export const aiConnectionSettingsSchema = z.object({
  host: optionalString,
  port: optionalUnsignedInteger,
  username: optionalString,
  defaultDatabase: optionalString,
  schema: optionalString,
  sslMode: optionalString,
  connectTimeoutSeconds: optionalUnsignedInteger,
  protocol: optionalString,
  serviceName: optionalString,
  sid: optionalString,
  connectDescriptor: optionalString,
  role: optionalString,
  dbIndex: optionalUnsignedInteger,
  useTls: z.boolean().optional(),
  dbFilePath: optionalString,
  isReadOnly: z.boolean().optional(),
  authSource: optionalString,
  replicaSet: optionalString,
  indexPrefix: optionalString,
  defaultCollection: optionalString,
  endpoint: optionalString,
  environmentStr: optionalString,
  mode: optionalString,
  database: optionalString,
  encryption: optionalString,
  sshTunnel: aiSshTunnelSettingsSchema.optional(),
  localConfig: aiLocalFileSettingsSchema.optional(),
  networkConfig: aiNetworkSettingsSchema.optional(),
}).strict();

export const connectionListRequestSchema = z.object({}).strict();

export const connectionListItemSchema = z.object({
  profileId: z.string().min(1),
  name: z.string(),
  driver: z.string().min(1),
  environment: z.string(),
  location: aiConnectionLocationSchema,
  connected: z.boolean(),
}).strict();

export const connectionListResponseSchema = z.object({
  connections: z.array(connectionListItemSchema),
}).strict();

export const connectionGetRequestSchema = z.object({
  profileId: z.string().min(1),
}).strict();

export const aiConnectionRuntimeSchema = z.object({
  driverName: z.string(),
  healthStatus: z.enum(["healthy", "degraded", "error"]),
  availableCapabilities: z.array(z.string()),
  consecutiveFailures: z.number().int().nonnegative(),
  lastSuccessAtMs: z.number().int().nonnegative().nullable(),
  lastFailureAtMs: z.number().int().nonnegative().nullable(),
  lastErrorCode: z.string().nullable(),
}).strict();

export const connectionDetailSchema = z.object({
  profileId: z.string().min(1),
  name: z.string(),
  driver: z.string().min(1),
  environment: z.string(),
  settings: aiConnectionSettingsSchema,
  connected: z.boolean(),
  runtime: aiConnectionRuntimeSchema.nullable(),
  color: z.string().nullable(),
  tagLabel: z.string(),
  tagColor: z.string().nullable(),
  folderId: z.string().nullable(),
  sortOrder: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  lastConnectedAt: z.number().int().nullable(),
  lastConnectionStatus: z.enum([
    "connected",
    "disconnected",
    "unknown",
  ]).nullable(),
}).strict();

export const connectionGetResponseSchema = z.object({
  connection: connectionDetailSchema,
}).strict();

export const connectionOpenRequestSchema = z.object({
  profileId: z.string().min(1),
}).strict();

export const connectionOpenResponseSchema = z.object({
  connection: z.object({
    profileId: z.string().min(1),
    name: z.string(),
    driver: z.string().min(1),
    connected: z.literal(true),
    runtime: aiConnectionRuntimeSchema,
  }).strict(),
  wasAlreadyOpen: z.boolean(),
}).strict();

export const containerKindSchema = z.enum([
  "asset_group",
  "database",
  "schema",
  "table",
  "view",
  "materialized_view",
  "function",
  "procedure",
  "trigger",
  "index",
  "dictionary",
  "projection",
  "sequence",
  "extension",
  "event",
  "column",
  "collection",
  "document",
  "field",
  "node_label",
  "relationship_type",
  "vector_collection",
  "partition",
  "search_index",
  "data_stream",
  "mapping_field",
  "redis_database",
  "redis_key_prefix",
  "redis_key",
]);

export const assetGroupTypeSchema = z.enum([
  "tables",
  "views",
  "materialized_views",
  "functions",
  "procedures",
  "indexes",
  "dictionaries",
  "projections",
  "triggers",
  "sequences",
  "extensions",
  "events",
  "collections",
  "documents",
  "fields",
  "node_labels",
  "relationship_types",
  "vector_collections",
  "partitions",
  "search_indexes",
  "data_streams",
  "templates",
  "mappings",
  "constraints",
  "columns",
]);

export const containerRefSchema = z.object({
  kind: containerKindSchema,
  groupType: assetGroupTypeSchema.nullish(),
  database: z.string().nullish(),
  schema: z.string().nullish(),
  table: z.string().nullish(),
  column: z.string().nullish(),
  objectName: z.string().nullish(),
  dbIndex: z.number().int().min(0).max(255).nullish(),
  key: z.string().nullish(),
  pattern: z.string().nullish(),
}).strict().describe(
  "数据库对象的结构化引用。导航元数据时应原样使用上一次 metadata.list_children 返回的 children[].container，不要自行猜测字段或把对象编码成 JSON 字符串。",
);

export const tableContainerRefSchema = containerRefSchema.extend({
  kind: z.literal("table"),
}).strict();

export const tableDataContainerRefSchema = containerRefSchema.extend({
  kind: z.enum(["table", "view", "materialized_view"]),
}).strict().refine(
  (container) =>
    Boolean(container.table?.trim()) &&
    container.groupType == null &&
    container.column == null &&
    container.objectName == null &&
    container.dbIndex == null &&
    container.key == null &&
    container.pattern == null,
  "table.query source must be an exact table-like container address",
).describe(
  "表格型数据源的结构化引用。必须原样使用 metadata.list_children 返回的 table、view 或 materialized_view 节点 container。",
);

export const containerPropertySchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.string(),
}).strict();

export const dataContainerSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: containerKindSchema,
  isLeaf: z.boolean(),
  container: containerRefSchema.describe(
    "可供后续元数据工具原样使用的结构化对象引用。",
  ),
  typeName: z.string().nullable(),
  nullable: z.boolean().nullable(),
  itemCount: z.number().int().nonnegative().optional(),
  properties: z.array(containerPropertySchema).optional(),
}).strict();

export const metadataListChildrenRequestSchema = z.object({
  profileId: z.string().min(1),
  parent: containerRefSchema.nullish().describe(
    "省略或传 null 时读取根节点；展开某个节点时，必须原样传入上一次响应中该节点的 children[].container 对象，不能传 JSON 字符串。",
  ),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(200).default(100),
}).strict();

export const metadataListChildrenResponseSchema = z.object({
  children: z.array(dataContainerSchema),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().optional(),
}).strict();

const tablePartitionOptionsSchema = z.object({
  expression: z.string().nullable(),
  rawClause: z.string().nullable(),
  readonlyDescription: z.string().nullable(),
}).strict();

const tableSchemaBasicsSchema = z.object({
  tableName: z.string(),
  databaseName: z.string(),
  schemaName: z.string(),
  engine: z.string().nullable(),
  charset: z.string().nullable(),
  collation: z.string().nullable(),
  comment: z.string().nullable(),
  partition: tablePartitionOptionsSchema.optional(),
}).strict();

const tableIdentityOptionsSchema = z.object({
  generation: z.enum(["always", "by_default"]),
  start: z.string().nullable(),
  increment: z.string().nullable(),
  minValue: z.string().nullable(),
  maxValue: z.string().nullable(),
  cache: z.string().nullable(),
  cycle: z.boolean().optional(),
}).strict();

const tableGeneratedColumnSchema = z.object({
  expression: z.string(),
  storage: z.enum(["virtual", "stored"]),
}).strict();

const tableColumnSchema = z.object({
  name: z.string(),
  typeName: z.string(),
  nullable: z.boolean(),
  defaultValue: z.string().nullable(),
  isPrimaryKey: z.boolean(),
  isUnique: z.boolean(),
  isIdentity: z.boolean(),
  comment: z.string().nullable(),
  identity: tableIdentityOptionsSchema.optional(),
  generated: tableGeneratedColumnSchema.optional(),
  charset: z.string().optional(),
  collation: z.string().optional(),
}).strict();

const tableIndexSchema = z.object({
  name: z.string(),
  columns: z.array(z.string()),
  isUnique: z.boolean(),
  method: z.string().nullable(),
  comment: z.string().nullable(),
}).strict();

const tableForeignKeyReferenceSchema = z.object({
  databaseName: z.string().nullable(),
  schemaName: z.string().nullable(),
  tableName: z.string(),
  columns: z.array(z.string()),
  onUpdate: z.enum([
    "no_action",
    "restrict",
    "cascade",
    "set_null",
    "set_default",
  ]).nullable(),
  onDelete: z.enum([
    "no_action",
    "restrict",
    "cascade",
    "set_null",
    "set_default",
  ]).nullable(),
}).strict();

const tableConstraintSchema = z.object({
  name: z.string(),
  kind: z.enum(["primary_key", "unique", "foreign_key", "check"]),
  columns: z.array(z.string()),
  reference: z.string().nullable(),
  expression: z.string().nullable(),
  comment: z.string().nullable(),
  foreignKey: tableForeignKeyReferenceSchema.optional(),
  enforced: z.boolean().optional(),
}).strict();

export const tableSchemaSchema = z.object({
  basics: tableSchemaBasicsSchema,
  columns: z.array(tableColumnSchema),
  indexes: z.array(tableIndexSchema),
  constraints: z.array(tableConstraintSchema),
}).strict();

export const metadataDescribeTableRequestSchema = z.object({
  profileId: z.string().min(1),
  container: tableContainerRefSchema.describe(
    "必须原样使用 metadata.list_children 返回的 kind=table 节点的 container 对象。",
  ),
}).strict();

export const metadataDescribeTableResponseSchema = z.object({
  container: tableContainerRefSchema,
  schema: tableSchemaSchema,
}).strict();

const tableQueryScalarSchema = z.union([
  z.string().max(4096),
  z.number().finite(),
  z.boolean(),
]);

const tableQueryValueFilterSchema = z.object({
  column: z.string().min(1),
  operator: z.enum(["eq", "not_eq", "gt", "gte", "lt", "lte"]),
  value: tableQueryScalarSchema,
}).strict();

const tableQueryNullFilterSchema = z.object({
  column: z.string().min(1),
  operator: z.enum(["is_null", "is_not_null"]),
}).strict();

export const tableQueryRequestSchema = z.object({
  profileId: z.string().min(1),
  source: tableDataContainerRefSchema,
  columns: z.array(z.string().min(1)).max(50).refine(
    (columns) => new Set(columns).size === columns.length,
    "table.query columns must not contain duplicates",
  ).default([]),
  filters: z.array(
    z.union([tableQueryValueFilterSchema, tableQueryNullFilterSchema]),
  ).max(10).default([]),
  sort: z.array(z.object({
    column: z.string().min(1),
    direction: z.enum(["asc", "desc"]),
  }).strict()).max(5).refine(
    (sort) => new Set(sort.map((item) => item.column)).size === sort.length,
    "table.query sort columns must not contain duplicates",
  ).default([]),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(50),
}).strict();

const tableQueryColumnSchema = z.object({
  name: z.string(),
  typeName: z.string(),
  nullable: z.boolean(),
  dataCategory: z.enum([
    "string",
    "number",
    "boolean",
    "date",
    "time",
    "datetime",
    "json",
    "structured",
    "enum",
    "binary",
    "uuid",
    "unknown",
  ]),
}).strict();

const jsonSafeUnsignedIntegerSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/),
]);

export const tableQueryResponseSchema = z.object({
  source: tableDataContainerRefSchema,
  columns: z.array(tableQueryColumnSchema),
  rows: z.array(z.array(z.unknown())),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(100),
  totalRows: jsonSafeUnsignedIntegerSchema,
  totalPages: jsonSafeUnsignedIntegerSchema,
  hasNextPage: z.boolean(),
}).strict();

const redisCursorSchema = z.string().regex(/^\d+$/).describe(
  "Redis SCAN 游标的十进制字符串。首次调用传字符串 \"0\"，后续原样使用上一次返回的 nextCursor。",
);

export const keyValueScanRequestSchema = z.object({
  profileId: z.string().min(1),
  dbIndex: z.number().int().min(0).max(255),
  pattern: z.string().min(1).max(1024).default("*"),
  cursor: redisCursorSchema.default("0"),
  count: z.number().int().min(1).max(500).default(100),
}).strict();

export const keyValueScanResponseSchema = z.object({
  dbIndex: z.number().int().min(0).max(255),
  pattern: z.string(),
  nextCursor: redisCursorSchema,
  done: z.boolean(),
  keys: z.array(z.string()),
}).strict();

export const keyValueGetRequestSchema = z.object({
  profileId: z.string().min(1),
  dbIndex: z.number().int().min(0).max(255),
  key: z.string().min(1).max(4096),
}).strict();

const redisHashEntrySchema = z.object({
  field: z.string(),
  value: z.string(),
}).strict();

const redisStringValueSchema = z.discriminatedUnion("encoding", [
  z.object({
    encoding: z.literal("utf8"),
    value: z.string().nullable(),
  }).strict(),
  z.object({
    encoding: z.literal("binary"),
    byteLength: z.number().int().nonnegative(),
    previewHex: z.string(),
  }).strict(),
]);

const redisValueSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("string"),
    value: redisStringValueSchema,
  }).strict(),
  z.object({
    kind: z.literal("json"),
    value: z.string(),
  }).strict(),
  z.object({
    kind: z.literal("hash"),
    value: z.array(redisHashEntrySchema),
  }).strict(),
  z.object({
    kind: z.literal("list"),
    value: z.array(z.string()),
  }).strict(),
  z.object({
    kind: z.literal("set"),
    value: z.array(z.string()),
  }).strict(),
  z.object({
    kind: z.literal("sorted_set"),
    value: z.array(z.object({
      member: z.string(),
      score: z.number().finite(),
    }).strict()),
  }).strict(),
  z.object({
    kind: z.literal("stream"),
    value: z.array(z.object({
      id: z.string(),
      fields: z.array(redisHashEntrySchema),
    }).strict()),
  }).strict(),
  z.object({
    kind: z.literal("unsupported"),
    value: z.string(),
  }).strict(),
]);

export const keyValueGetResponseSchema = z.object({
  key: z.string(),
  valueType: z.string(),
  ttl: z.number().int(),
  size: jsonSafeUnsignedIntegerSchema.nullable(),
  value: redisValueSchema,
}).strict();

export type ConnectionListRequest = z.infer<typeof connectionListRequestSchema>;
export type ConnectionListResponse = z.infer<typeof connectionListResponseSchema>;
export type ConnectionGetRequest = z.infer<typeof connectionGetRequestSchema>;
export type ConnectionGetResponse = z.infer<typeof connectionGetResponseSchema>;
export type ConnectionOpenRequest = z.infer<typeof connectionOpenRequestSchema>;
export type ConnectionOpenResponse = z.infer<typeof connectionOpenResponseSchema>;
export type MetadataListChildrenRequest = z.infer<
  typeof metadataListChildrenRequestSchema
>;
export type MetadataListChildrenResponse = z.infer<
  typeof metadataListChildrenResponseSchema
>;
export type MetadataDescribeTableRequest = z.infer<
  typeof metadataDescribeTableRequestSchema
>;
export type MetadataDescribeTableResponse = z.infer<
  typeof metadataDescribeTableResponseSchema
>;
export type TableQueryRequest = z.infer<typeof tableQueryRequestSchema>;
export type TableQueryResponse = z.infer<typeof tableQueryResponseSchema>;
export type KeyValueScanRequest = z.infer<typeof keyValueScanRequestSchema>;
export type KeyValueScanResponse = z.infer<typeof keyValueScanResponseSchema>;
export type KeyValueGetRequest = z.infer<typeof keyValueGetRequestSchema>;
export type KeyValueGetResponse = z.infer<typeof keyValueGetResponseSchema>;
