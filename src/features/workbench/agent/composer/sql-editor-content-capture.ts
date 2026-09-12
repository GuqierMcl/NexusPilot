import {
  SQL_EDITOR_CONTENT_MAX_BYTES,
  sqlEditorContentContextSchema,
  type SqlEditorContentContext,
} from "@contracts/sql-editor-content-context";

export type SqlEditorContentCapture =
  | { status: "empty" }
  | { status: "ready"; context: SqlEditorContentContext }
  | { status: "oversized"; byteLength: number };

export interface SqlEditorContentCaptureInput {
  sqlText: string;
  selectedText?: string;
  selectionStart?: number;
  selectionEnd?: number;
}

function hash(value: string): string {
  let result = 2166136261;
  for (const character of value) {
    result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  }
  return (result >>> 0).toString(16);
}

export function buildSqlEditorContentCapture(
  input: SqlEditorContentCaptureInput,
): SqlEditorContentCapture {
  const selectedText = input.selectedText ?? "";
  const source = selectedText.trim().length > 0 ? "selection" : "document";
  const sql = source === "selection" ? selectedText : input.sqlText;
  if (sql.trim().length === 0) return { status: "empty" };

  const selection = source === "selection"
    ? { start: input.selectionStart, end: input.selectionEnd }
    : undefined;
  if (source === "selection" && (selection?.start === undefined || selection.end === undefined)) {
    throw new Error("选区范围缺失");
  }
  const selectionRange = selection as { start: number; end: number } | undefined;
  if (source === "selection" && (
    selectionRange!.start < 0 ||
    selectionRange!.end < selectionRange!.start ||
    selectionRange!.end > input.sqlText.length ||
    input.sqlText.slice(selectionRange!.start, selectionRange!.end) !== selectedText
  )) {
    throw new Error("选区范围或内容无效");
  }

  const base = {
    version: 1 as const,
    kind: "sql-editor" as const,
    source,
    sql,
    ...(selection
      ? {
          selection: { start: selectionRange!.start, end: selectionRange!.end },
          documentLength: input.sqlText.length,
        }
      : {}),
  };
  const revision = `content-v1-${hash(JSON.stringify(base))}`;
  const candidate = { ...base, revision };
  const byteLength = new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
  if (byteLength > SQL_EDITOR_CONTENT_MAX_BYTES) return { status: "oversized", byteLength };
  return { status: "ready", context: sqlEditorContentContextSchema.parse(candidate) };
}
