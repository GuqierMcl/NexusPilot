import type { DataTableColumn } from "../types";

export type AdvancedCellEditorKind =
  | "boolean"
  | "date"
  | "time"
  | "datetime"
  | "enum"
  | "json"
  | "text";

export type AdvancedCellEditorPresentation = "popover" | "dialog";

export interface AdvancedCellEditorConfig {
  kind: AdvancedCellEditorKind;
  title: string;
  presentation: AdvancedCellEditorPresentation;
}

function isLongTextColumn(column: DataTableColumn | undefined): boolean {
  if (!column) return false;
  const typeName = column.typeName?.toLowerCase() ?? "";
  return (
    column.dataCategory === "string" &&
    (typeName.includes("text") ||
      typeName.includes("clob") ||
      (column.maxLength != null && column.maxLength > 255))
  );
}

export function resolveAdvancedCellEditor(
  column: DataTableColumn | undefined,
): AdvancedCellEditorConfig | null {
  if (!column) return null;

  if (column.dataCategory === "boolean") {
    return { kind: "boolean", title: "布尔值", presentation: "popover" };
  }
  if (column.dataCategory === "date") {
    return { kind: "date", title: "日期", presentation: "popover" };
  }
  if (column.dataCategory === "time") {
    return { kind: "time", title: "时间", presentation: "popover" };
  }
  if (column.dataCategory === "datetime") {
    return { kind: "datetime", title: "日期时间", presentation: "popover" };
  }
  if (column.dataCategory === "enum" && column.enumValues?.length) {
    return { kind: "enum", title: "枚举值", presentation: "popover" };
  }
  if (column.dataCategory === "json") {
    return { kind: "json", title: "JSON", presentation: "dialog" };
  }
  if (isLongTextColumn(column)) {
    return { kind: "text", title: "长文本", presentation: "dialog" };
  }

  return null;
}
