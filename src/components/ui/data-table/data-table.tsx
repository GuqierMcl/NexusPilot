import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import {
  useReactTable,
  getCoreRowModel,
  type ColumnDef,
  type ColumnSizingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";

import { cn } from "@/lib/utils";
import { DataTableContext } from "./data-table-context";
import { VirtualScrollArea } from "./virtual-scroll-area";
import { DataTableHeader } from "./data-table-header";
import { DataTableBody } from "./data-table-body";
import { DataTableEmpty } from "./data-table-empty";
import type {
  DataTableColumn,
  DataTablePreset,
  DataTableProps,
  DataTableRowData,
} from "./types";

// ─── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_ROW_HEIGHT = 32;
const COMPACT_ROW_HEIGHT = 28;
const DEFAULT_OVERSCAN = 20;
const DEFAULT_COLUMN_OVERSCAN = 2;
const DEFAULT_COL_WIDTH = 160;
const DEFAULT_COL_MIN_WIDTH = 60;
const DEFAULT_ROW_NUMBER_WIDTH = 48;

// ─── Data Conversion ───────────────────────────────────────────────────────────

function convertRows(
  rows: unknown[][],
  columns: DataTableColumn[],
): DataTableRowData[] {
  return rows.map((row, rowIndex) => {
    const data: DataTableRowData = {
      __rowIndex: rowIndex,
      __originalRow: row,
    };
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i]!;
      data[col.id] = row[i] ?? null;
    }
    return data;
  });
}

function createVirtualEmptyRow(columns: DataTableColumn[]): DataTableRowData {
  const row: DataTableRowData = {
    __rowIndex: -1,
    __originalRow: [],
    __isVirtualEmptyRow: true,
  };

  for (const column of columns) {
    row[column.id] = "(N/A)";
  }

  return row;
}

function convertColumns(
  columns: DataTableColumn[],
): ColumnDef<DataTableRowData, unknown>[] {
  return columns.map((col) => ({
    id: col.id,
    accessorKey: col.id,
    header: col.header,
    size: col.width ?? DEFAULT_COL_WIDTH,
    minSize: col.minWidth ?? DEFAULT_COL_MIN_WIDTH,
    maxSize: col.maxWidth,
    enableResizing: !col.disableResizing,
  }));
}

function getDefaultRowHeight(preset: DataTablePreset): number {
  if (preset === "compact" || preset === "keyValue") return COMPACT_ROW_HEIGHT;
  return DEFAULT_ROW_HEIGHT;
}

// ─── DataTable ──────────────────────────────────────────────────────────────────

export function DataTable({
  preset = "default",
  columns,
  rows,
  isActive = true,
  rowHeight,
  overscan = DEFAULT_OVERSCAN,
  columnOverscan = DEFAULT_COLUMN_OVERSCAN,
  enableColumnResizing = true,
  rowNumberOffset = 0,
  showRowNumbers = true,
  rowNumberWidth,
  rowNumberFormatter,
  renderColumnHeaderMeta,
  scrollToRowIndex,
  scrollToRowSignal,
  onRowClick,
  selectedRowIndexes,
  currentRowIndex,
  pendingDeleteRowIndexes,
  draftRowIndexes,
  dirtyCells,
  onRowSelect,
  onRowContextMenu,
  renderRowContextMenu,
  selectedCell,
  onCellSelect,
  onCellDoubleClick,
  isCellEditable,
  editingCell,
  onCellEditCommit,
  onCellEditCancel,
  className,
  emptyMessage = "暂无数据",
  frozenColumnIds,
}: DataTableProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const getScrollElement = useCallback(() => viewportRef.current, []);
  const resolvedRowHeight = rowHeight ?? getDefaultRowHeight(preset);
  const resolvedRowNumberWidth = showRowNumbers
    ? rowNumberWidth ?? DEFAULT_ROW_NUMBER_WIDTH
    : 0;

  // ── Build frozen column set ─────────────────────────────────────────────────
  // Merge the table-level `frozenColumnIds` prop with per-column `frozen: true`
  // declarations. Both sources contribute to the same Set.
  //
  // ── Future extensibility ──
  // When right-click "freeze column" is implemented, the parent component will
  // manage `frozenColumnIds` as controlled state. The flow will be:
  //   context menu → onFreezeColumn(id) → parent setState →
  //   new frozenColumnIds prop → re-derive frozenColumnIdSet
  const frozenColumnIdSet = useMemo(() => {
    const set = new Set<string>();
    // From table-level prop
    if (frozenColumnIds) {
      for (const id of frozenColumnIds) set.add(id);
    }
    // From per-column declarations
    for (const col of columns) {
      if (col.frozen) set.add(col.id);
    }
    return set;
  }, [frozenColumnIds, columns]);

  const tableData = useMemo(
    () => rows.length === 0
      ? [createVirtualEmptyRow(columns)]
      : convertRows(rows, columns),
    [rows, columns],
  );
  const tableColumns = useMemo(() => convertColumns(columns), [columns]);

  const table = useReactTable({
    data: tableData,
    columns: tableColumns,
    columnResizeMode: "onChange",
    state: { columnSizing },
    onColumnSizingChange: setColumnSizing,
    getCoreRowModel: getCoreRowModel(),
    defaultColumn: {
      size: DEFAULT_COL_WIDTH,
      minSize: DEFAULT_COL_MIN_WIDTH,
    },
  });

  const rowVirtualizer = useVirtualizer({
    count: tableData.length,
    getScrollElement,
    estimateSize: () => resolvedRowHeight,
    overscan,
  });

  useEffect(() => {
    if (scrollToRowIndex == null || scrollToRowSignal == null) return;
    if (tableData.length === 0) return;

    const targetIndex = Math.max(
      0,
      Math.min(scrollToRowIndex, tableData.length - 1),
    );
    const frameId = requestAnimationFrame(() => {
      rowVirtualizer.scrollToIndex(targetIndex, { align: "end" });
    });

    return () => cancelAnimationFrame(frameId);
  }, [rowVirtualizer, scrollToRowIndex, scrollToRowSignal, tableData.length]);

  const syncHeaderScroll = useCallback(() => {
    const viewport = viewportRef.current;
    const header = headerRef.current;
    if (viewport && header) {
      header.scrollLeft = viewport.scrollLeft;
    }
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    viewport.addEventListener("scroll", syncHeaderScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", syncHeaderScroll);
  }, [syncHeaderScroll]);

  // ── Header wheel sync ──────────────────────────────────────────────────────
  // Bound to the header element ONLY, not the outer container.
  // The ScrollArea viewport handles its own wheel events natively.
  // If bound to the outer container, the event bubbles from viewport → outer div,
  // triggering BOTH Radix's handler AND this callback → double scroll → flicker.
  const handleHeaderWheel = useCallback(
    (e: React.WheelEvent) => {
      const viewport = viewportRef.current;
      if (!viewport) return;

      if (e.deltaX !== 0) {
        viewport.scrollLeft += e.deltaX;
      }
      if (e.deltaY !== 0) {
        viewport.scrollTop += e.deltaY;
      }
    },
    [],
  );

  if (columns.length === 0) {
    return <DataTableEmpty message={emptyMessage} className={className} />;
  }

  return (
    <DataTableContext.Provider
      value={{
        table,
        rowHeight: resolvedRowHeight,
        columns,
        isActive,
        enableColumnResizing,
        rowNumberWidth: resolvedRowNumberWidth,
        showRowNumbers,
        rowNumberOffset,
        preset,
        rowNumberFormatter,
        renderColumnHeaderMeta,
        frozenColumnIdSet,
      }}
    >
      <div
        data-preset={preset}
        className={cn("flex flex-col flex-1 overflow-hidden", className)}
      >
        <DataTableHeader headerRef={headerRef} onWheel={handleHeaderWheel} />
        <VirtualScrollArea
          className="flex-1 min-h-0"
          viewportRef={viewportRef}
        >
          <DataTableBody
            virtualizer={rowVirtualizer}
            getScrollElement={getScrollElement}
            columnOverscan={columnOverscan}
            onRowClick={onRowClick}
            selectedRowIndexes={selectedRowIndexes}
            currentRowIndex={currentRowIndex}
            pendingDeleteRowIndexes={pendingDeleteRowIndexes}
            draftRowIndexes={draftRowIndexes}
            dirtyCells={dirtyCells}
            onRowSelect={onRowSelect}
            onRowContextMenu={onRowContextMenu}
            renderRowContextMenu={renderRowContextMenu}
            selectedCell={selectedCell}
            onCellSelect={onCellSelect}
            onCellDoubleClick={onCellDoubleClick}
            isCellEditable={isCellEditable}
            editingCell={editingCell}
            onCellEditCommit={onCellEditCommit}
            onCellEditCancel={onCellEditCancel}
          />
        </VirtualScrollArea>
      </div>
    </DataTableContext.Provider>
  );
}
