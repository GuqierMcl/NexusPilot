import { z } from "zod";

export const SQL_MAX_CHARS = 64 * 1024;
export const SQL_DEFAULT_PAGE_SIZE = 50;
export const SQL_MAX_PAGE_SIZE = 100;

export const sqlExecuteRequestSchema = z.object({
  profileId: z.string().min(1).describe(
    "connection.list 返回的精确连接 profileId；连接必须已经打开。",
  ),
  database: z.string().trim().min(1).max(256).optional().describe(
    "可选的目标 database。必须与生成 SQL 时使用的目标一致。",
  ),
  schema: z.string().trim().min(1).max(256).optional().describe(
    "可选的目标 schema。必须与生成 SQL 时使用的目标一致。",
  ),
  sql: z.string().min(1).max(SQL_MAX_CHARS).describe(
    "要原样执行的一条完整 SQL。不得包含脚本、客户端命令或多条语句。",
  ),
  pageSize: z.number().int().min(1).max(SQL_MAX_PAGE_SIZE)
    .default(SQL_DEFAULT_PAGE_SIZE)
    .describe("读取结果最多返回的行数；不会自动请求下一页。"),
}).strict();

export const sqlStatementClassSchema = z.enum([
  "read",
  "insert",
  "update",
  "mutation",
  "delete",
  "ddl",
  "command",
  "unknown",
]);

const sqlColumnSchema = z.object({
  name: z.string(),
  typeName: z.string(),
  nullable: z.boolean(),
  defaultValue: z.string().nullable(),
  dataCategory: z.string(),
  maxLength: z.number().int().nullable(),
  numericPrecision: z.number().int().nullable(),
  numericScale: z.number().int().nullable(),
  enumValues: z.array(z.string()).nullable(),
  isPrimaryKey: z.boolean(),
  primaryKeyOrdinal: z.number().int().nullable(),
  isUnique: z.boolean(),
  isWritable: z.boolean(),
}).strict();

export const sqlExecuteResponseSchema = z.object({
  executionId: z.string().min(1),
  statementClass: sqlStatementClassSchema,
  analysisStatus: z.enum(["analyzed", "uncertain"]),
  result: z.object({
    columns: z.array(sqlColumnSchema),
    rows: z.array(z.array(z.unknown())),
    affectedRows: z.union([
      z.number().int().nonnegative(),
      z.string().regex(/^\d+$/),
    ]).nullable(),
    hasNextPage: z.boolean(),
  }).strict(),
  durationMs: z.number().int().nonnegative(),
  completionMessage: z.string().nullable(),
  mutationState: z.enum([
    "not_applicable",
    "completed",
    "submitted",
  ]),
  warnings: z.array(z.string()),
}).strict();

export type SqlExecuteRequest = z.infer<typeof sqlExecuteRequestSchema>;
export type SqlExecuteResponse = z.infer<typeof sqlExecuteResponseSchema>;
