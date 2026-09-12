import { z } from "zod";

export const SQL_EDITOR_CONTENT_PART = "data-sql-editor-content" as const;
export const SQL_EDITOR_CONTENT_MAX_BYTES = 32 * 1024;

const selectionSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
}).strict();

export const sqlEditorContentContextSchema = z.object({
  version: z.literal(1),
  kind: z.literal("sql-editor"),
  source: z.enum(["selection", "document"]),
  sql: z.string().min(1).max(SQL_EDITOR_CONTENT_MAX_BYTES * 4),
  selection: selectionSchema.optional(),
  documentLength: z.number().int().positive().optional(),
  revision: z.string().min(1).max(80),
}).strict().superRefine((value, context) => {
  if (value.source === "selection" && !value.selection) {
    context.addIssue({ code: "custom", path: ["selection"], message: "选区来源必须包含选区范围" });
  }
  if (value.source === "selection" && value.documentLength === undefined) {
    context.addIssue({ code: "custom", path: ["documentLength"], message: "选区来源必须包含全文长度" });
  }
  if (value.source === "document" && value.documentLength !== undefined) {
    context.addIssue({ code: "custom", path: ["documentLength"], message: "全文来源不能包含全文长度" });
  }
  if (value.source === "document" && value.selection) {
    context.addIssue({ code: "custom", path: ["selection"], message: "全文来源不能包含选区范围" });
  }
  if (value.selection && (value.selection.start > value.selection.end || value.documentLength === undefined || value.selection.end > value.documentLength)) {
    context.addIssue({ code: "custom", path: ["selection"], message: "选区范围无效" });
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > SQL_EDITOR_CONTENT_MAX_BYTES) {
    context.addIssue({ code: "custom", message: "SQL 内容超过大小上限" });
  }
});

export type SqlEditorContentContext = z.infer<typeof sqlEditorContentContextSchema>;

export function parseSqlEditorContentContext(value: unknown): SqlEditorContentContext {
  return sqlEditorContentContextSchema.parse(value);
}

export function readSqlEditorContentPart(parts: readonly unknown[]): SqlEditorContentContext | undefined {
  let context: SqlEditorContentContext | undefined;
  for (const value of parts) {
    if (!value || typeof value !== "object") continue;
    const part = value as { type?: unknown; name?: unknown; data?: unknown };
    if (part.type !== SQL_EDITOR_CONTENT_PART && !(part.type === "data" && part.name === "sql-editor-content")) continue;
    if (context) throw new Error("每条消息只能携带一个 SQL 编辑器内容");
    context = parseSqlEditorContentContext(part.data);
  }
  return context;
}

export function sqlEditorContentOpenApiSchema() {
  return z.toJSONSchema(sqlEditorContentContextSchema, { target: "openapi-3.0", unrepresentable: "any" });
}
