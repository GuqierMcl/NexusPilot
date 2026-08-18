import { useCallback, useEffect, useMemo, useState } from "react";

import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { cn } from "@/lib/utils";
import type { RedisEditableValue } from "@/types/ipc";

type RedisEditableCollectionValue = Extract<
  RedisEditableValue,
  { kind: "hash" | "list" | "set" | "sorted_set" | "stream" }
>;

type EditingCell = {
  rowIndex: number;
  columnId: string;
  value: unknown;
};

type StreamRowMapping = {
  entryIndex: number;
  fieldIndex: number;
};

interface RedisEditableDataTableProps {
  value: RedisEditableCollectionValue;
  onChange?: (value: RedisEditableCollectionValue) => void;
  selectedRowIndex?: number | null;
  onSelectedRowIndexChange?: (rowIndex: number | null) => void;
  className?: string;
}

function updateHashCell(
  value: Extract<RedisEditableValue, { kind: "hash" }>,
  rowIndex: number,
  columnId: string,
  nextValue: unknown,
): RedisEditableCollectionValue {
  if (columnId !== "field" && columnId !== "value") return value;

  return {
    kind: "hash",
    value: value.value.map((entry, currentIndex) =>
      currentIndex === rowIndex
        ? { ...entry, [columnId]: String(nextValue) }
        : entry,
    ),
  };
}

function updateListCell(
  value: Extract<RedisEditableValue, { kind: "list" }>,
  rowIndex: number,
  columnId: string,
  nextValue: unknown,
): RedisEditableCollectionValue {
  if (columnId !== "value") return value;

  return {
    kind: "list",
    value: value.value.map((entry, currentIndex) =>
      currentIndex === rowIndex ? String(nextValue) : entry,
    ),
  };
}

function updateSetCell(
  value: Extract<RedisEditableValue, { kind: "set" }>,
  rowIndex: number,
  columnId: string,
  nextValue: unknown,
): RedisEditableCollectionValue {
  if (columnId !== "member") return value;

  return {
    kind: "set",
    value: value.value.map((entry, currentIndex) =>
      currentIndex === rowIndex ? String(nextValue) : entry,
    ),
  };
}

function updateSortedSetCell(
  value: Extract<RedisEditableValue, { kind: "sorted_set" }>,
  rowIndex: number,
  columnId: string,
  nextValue: unknown,
): RedisEditableCollectionValue {
  if (columnId !== "score" && columnId !== "member") return value;

  return {
    kind: "sorted_set",
    value: value.value.map((entry, currentIndex) => {
      if (currentIndex !== rowIndex) return entry;
      if (columnId === "member") return { ...entry, member: String(nextValue) };

      const scoreText = String(nextValue);
      return {
        ...entry,
        score: scoreText.length === 0 ? Number.NaN : Number(scoreText),
      };
    }),
  };
}

function updateStreamCell(
  value: Extract<RedisEditableValue, { kind: "stream" }>,
  rowMapping: StreamRowMapping | undefined,
  columnId: string,
  nextValue: unknown,
): RedisEditableCollectionValue {
  if (!rowMapping || (columnId !== "id" && columnId !== "field" && columnId !== "value")) {
    return value;
  }

  return {
    kind: "stream",
    value: value.value.map((entry, entryIndex) => {
      if (entryIndex !== rowMapping.entryIndex) return entry;
      if (columnId === "id") {
        return { ...entry, id: String(nextValue) };
      }

      return {
        ...entry,
        fields: entry.fields.map((field, fieldIndex) =>
          fieldIndex === rowMapping.fieldIndex
            ? { ...field, [columnId]: String(nextValue) }
            : field,
        ),
      };
    }),
  };
}

function getColumns(value: RedisEditableCollectionValue): DataTableColumn[] {
  const columnsByKind: Record<RedisEditableCollectionValue["kind"], DataTableColumn[]> = {
    hash: [
      { id: "field", header: "Field", width: 180, dataCategory: "string" },
      { id: "value", header: "Value", width: 260, dataCategory: "string" },
    ],
    list: [
      {
        id: "index",
        header: "Index",
        width: 72,
        minWidth: 56,
        disableResizing: true,
        isWritable: false,
      },
      { id: "value", header: "Value", width: 320, dataCategory: "string" },
    ],
    set: [
      {
        id: "ordinal",
        header: "#",
        width: 56,
        minWidth: 48,
        disableResizing: true,
        isWritable: false,
      },
      { id: "member", header: "Member", width: 320, dataCategory: "string" },
    ],
    sorted_set: [
      { id: "score", header: "Score", width: 112, dataCategory: "number" },
      { id: "member", header: "Member", width: 320, dataCategory: "string" },
    ],
    stream: [
      { id: "id", header: "ID", width: 160, dataCategory: "string" },
      { id: "field", header: "Field", width: 180, dataCategory: "string" },
      { id: "value", header: "Value", width: 260, dataCategory: "string" },
    ],
  };

  return columnsByKind[value.kind];
}

function getStreamRowMappings(
  value: RedisEditableCollectionValue,
): StreamRowMapping[] {
  if (value.kind !== "stream") return [];

  return value.value.flatMap((entry, entryIndex) =>
    entry.fields.map((_field, fieldIndex) => ({ entryIndex, fieldIndex })),
  );
}

function getRows(value: RedisEditableCollectionValue): unknown[][] {
  switch (value.kind) {
    case "hash":
      return value.value.map((entry) => [entry.field, entry.value]);
    case "list":
      return value.value.map((entry, index) => [index, entry]);
    case "set":
      return value.value.map((entry, index) => [index, entry]);
    case "sorted_set":
      return value.value.map((entry) => {
        const score = Number.isNaN(entry.score) ? "" : String(entry.score);
        return [score, entry.member];
      });
    case "stream":
      return value.value.flatMap((entry) =>
        entry.fields.map((field) => [entry.id, field.field, field.value]),
      );
  }
}

function getColumnWidth(column: DataTableColumn): number {
  return column.width ?? 160;
}

function isEditableColumn(kind: RedisEditableCollectionValue["kind"], columnId: string): boolean {
  switch (kind) {
    case "hash":
      return columnId === "field" || columnId === "value";
    case "list":
      return columnId === "value";
    case "set":
      return columnId === "member";
    case "sorted_set":
      return columnId === "score" || columnId === "member";
    case "stream":
      return columnId === "id" || columnId === "field" || columnId === "value";
  }
}

function commitCell(
  value: RedisEditableCollectionValue,
  rowIndex: number,
  columnId: string,
  nextValue: unknown,
  streamRowMappings: StreamRowMapping[],
): RedisEditableCollectionValue {
  switch (value.kind) {
    case "hash":
      return updateHashCell(value, rowIndex, columnId, nextValue);
    case "list":
      return updateListCell(value, rowIndex, columnId, nextValue);
    case "set":
      return updateSetCell(value, rowIndex, columnId, nextValue);
    case "sorted_set":
      return updateSortedSetCell(value, rowIndex, columnId, nextValue);
    case "stream":
      return updateStreamCell(
        value,
        streamRowMappings[rowIndex],
        columnId,
        nextValue,
      );
  }
}

export function RedisEditableDataTable({
  value,
  onChange,
  selectedRowIndex,
  onSelectedRowIndexChange,
  className,
}: RedisEditableDataTableProps) {
  const [selectedCell, setSelectedCell] = useState<{
    rowIndex: number;
    columnId: string;
  } | null>(null);
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const editable = onChange != null;

  useEffect(() => {
    if (selectedRowIndex == null) {
      setEditingCell(null);
      setSelectedCell(null);
    }
  }, [selectedRowIndex]);

  const columns = useMemo(() => getColumns(value), [value]);
  const rows = useMemo(() => getRows(value), [value]);
  const streamRowMappings = useMemo(() => getStreamRowMappings(value), [value]);
  const tableMinWidth = useMemo(
    () => columns.reduce((total, column) => total + getColumnWidth(column), 0),
    [columns],
  );

  const handleCellSelect = useCallback(
    (rowIndex: number, columnId: string, cellValue: unknown) => {
      setSelectedCell({ rowIndex, columnId });
      onSelectedRowIndexChange?.(rowIndex);
      if (editable && isEditableColumn(value.kind, columnId)) {
        setEditingCell({ rowIndex, columnId, value: cellValue });
      } else {
        setEditingCell(null);
      }
    },
    [editable, onSelectedRowIndexChange, value.kind],
  );

  const handleCellEditCommit = useCallback(
    (rowIndex: number, columnId: string, nextValue: unknown) => {
      if (!onChange) return;
      onChange(commitCell(value, rowIndex, columnId, nextValue, streamRowMappings));
      setEditingCell(null);
    },
    [onChange, streamRowMappings, value],
  );

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      <div className="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden rounded-md border">
        <div
          className="h-full w-full min-w-full"
          style={{ minWidth: tableMinWidth }}
        >
          <DataTable
            preset="keyValue"
            columns={columns}
            rows={rows}
            showRowNumbers={false}
            rowHeight={30}
            overscan={10}
            selectedRowIndexes={
              selectedRowIndex != null ? [selectedRowIndex] : undefined
            }
            selectedCell={selectedCell}
            editingCell={editingCell}
            isCellEditable={(_rowIndex, columnId) =>
              editable && isEditableColumn(value.kind, columnId)
            }
            onCellSelect={handleCellSelect}
            onCellDoubleClick={handleCellSelect}
            onCellEditCommit={handleCellEditCommit}
            onCellEditCancel={() => setEditingCell(null)}
            emptyMessage="暂无数据"
            className="h-full w-full min-w-0"
          />
        </div>
      </div>
    </div>
  );
}

export type { RedisEditableCollectionValue };
