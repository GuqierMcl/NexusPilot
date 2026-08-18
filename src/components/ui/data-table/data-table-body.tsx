import { useMemo, useState } from "react";
import type React from "react";
import type { Virtualizer } from "@tanstack/react-virtual";

import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useDataTable } from "./data-table-context";
import type { DataTableContextMenuTarget } from "./types";
import { CellEditor } from "./cell-editor/cell-editor";
import type { FixedColumnVirtualItem } from "./fixed-column-virtualization";
import { useFixedColumnVirtualizer } from "./fixed-column-virtualization";

// ─── DataTableBody Props ───────────────────────────────────────────────────────

interface DataTableBodyProps {
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  getScrollElement: () => HTMLDivElement | null;
  columnOverscan: number;
  onRowClick?: (rowIndex: number, rowData: unknown[]) => void;
  selectedRowIndexes?: number[];
  currentRowIndex?: number | null;
  pendingDeleteRowIndexes?: number[];
  draftRowIndexes?: number[];
  dirtyCells?: Array<{
    rowIndex: number;
    columnId: string;
  }>;
  onRowSelect?: (
    rowIndex: number,
    rowData: unknown[],
    event: React.MouseEvent,
  ) => void;
  onRowContextMenu?: (
    target: DataTableContextMenuTarget,
    event: React.MouseEvent,
  ) => void;
  renderRowContextMenu?: (
    target: DataTableContextMenuTarget,
  ) => React.ReactNode;
  selectedCell?: {
    rowIndex: number;
    columnId: string;
  } | null;
  onCellSelect?: (
    rowIndex: number,
    columnId: string,
    value: unknown,
    event: React.MouseEvent,
  ) => void;
  onCellDoubleClick?: (
    rowIndex: number,
    columnId: string,
    value: unknown,
    event: React.MouseEvent,
  ) => void;
  isCellEditable?: (
    rowIndex: number,
    columnId: string,
    value: unknown,
  ) => boolean;
  editingCell?: {
    rowIndex: number;
    columnId: string;
    value: unknown;
  } | null;
  onCellEditCommit?: (
    rowIndex: number,
    columnId: string,
    value: unknown,
  ) => void;
  onCellEditCancel?: () => void;
}

// ─── DataTableBody ─────────────────────────────────────────────────────────────
// Renders virtualized rows inside the scroll container.
// Each row renders cells with proper widths from column sizing state.

export function DataTableBody({
  virtualizer,
  getScrollElement,
  columnOverscan,
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
}: DataTableBodyProps) {
  const {
    table,
    rowHeight,
    columns,
    isActive,
    frozenColumnIdSet,
    rowNumberWidth,
    showRowNumbers,
    rowNumberOffset,
    rowNumberFormatter,
  } = useDataTable();
  const [contextMenuTarget, setContextMenuTarget] =
    useState<DataTableContextMenuTarget | null>(null);
  const selectedRows = useMemo(
    () => new Set(selectedRowIndexes ?? []),
    [selectedRowIndexes],
  );
  const pendingDeleteRows = useMemo(
    () => new Set(pendingDeleteRowIndexes ?? []),
    [pendingDeleteRowIndexes],
  );
  const draftRows = useMemo(
    () => new Set(draftRowIndexes ?? []),
    [draftRowIndexes],
  );
  const dirtyCellSet = useMemo(
    () =>
      new Set(
        (dirtyCells ?? []).map((cell) => `${cell.rowIndex}::${cell.columnId}`),
      ),
    [dirtyCells],
  );
  const columnById = useMemo(
    () => new Map(columns.map((column) => [column.id, column])),
    [columns],
  );
  const columnSizingState = table.getState().columnSizing;
  const columnMeasurements = useMemo(
    () =>
      table.getAllLeafColumns().map((column) => ({
        id: column.id,
        size: column.getSize(),
        isFrozen: frozenColumnIdSet.has(column.id),
      })),
    [columnSizingState, frozenColumnIdSet, table],
  );
  const columnVirtualizer = useFixedColumnVirtualizer({
    columns: columnMeasurements,
    getScrollElement,
    rowNumberWidth,
    overscan: columnOverscan,
  });
  const contextMenuContent =
    contextMenuTarget && renderRowContextMenu
      ? renderRowContextMenu(contextMenuTarget)
      : null;

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<div
          data-slot="data-table-body"
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: columnVirtualizer.getTotalSize(),
            position: "relative",
          }}
          onContextMenu={(event) => {
            const target = event.target as HTMLElement | null;
            const isTableTarget = target?.closest(
              '[data-slot="data-table-cell"], [data-slot="data-table-row-number-cell"]',
            );
            if (!isTableTarget) {
              setContextMenuTarget(null);
            }
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = table.getRowModel().rows[virtualRow.index];
            if (!row) return null;
            const isVirtualEmptyRow = row.original.__isVirtualEmptyRow === true;

            const original = row.original;
            const rowIndex = original.__rowIndex;
            const rowData = original.__originalRow;
            const isSelected = selectedRows.has(rowIndex);
            const isCurrentRow = currentRowIndex === rowIndex;
            const isPendingDeleteRow = pendingDeleteRows.has(rowIndex);
            const isDraftRow = draftRows.has(rowIndex);
            const displayRowNumber = rowNumberOffset + rowIndex + 1;
            const rowNumberTarget: DataTableContextMenuTarget = {
              kind: "rowNumber",
              rowIndex,
              rowData,
            };
            const frozenColumnItems = columnVirtualizer.getFrozenVirtualItems();
            const renderDataCell = (
              virtualColumn: FixedColumnVirtualItem,
              isFrozen: boolean,
            ) => {
              const columnId = virtualColumn.columnId;
              const value = row.getValue(columnId);
              const isNull = value === null || value === undefined;
              const colDef = columnById.get(columnId);
              const editable =
                !isVirtualEmptyRow &&
                (isCellEditable?.(rowIndex, columnId, value) ?? false);
              const isEditing =
                editingCell?.rowIndex === rowIndex &&
                editingCell.columnId === columnId;
              const isSelectedCell =
                selectedCell?.rowIndex === rowIndex &&
                selectedCell.columnId === columnId;
              const isDirtyCell = dirtyCellSet.has(`${rowIndex}::${columnId}`);
              const cellTarget: DataTableContextMenuTarget = {
                kind: "cell",
                rowIndex,
                rowData,
                columnId,
                value,
              };

              return (
                <div
                  key={`${virtualRow.key}:${columnId}`}
                  data-slot="data-table-cell"
                  className={cn(
                    "flex h-full shrink-0 items-center truncate border-r border-border/50 px-3",
                    !isFrozen && "absolute top-0",
                    isFrozen && "bg-background",
                    isFrozen && isCurrentRow && !isSelected && "bg-accent/25",
                    isFrozen && isSelected && "bg-accent",
                    isDraftRow && "bg-emerald-500/5",
                    isFrozen && isDraftRow && "bg-emerald-500/10",
                    isSelectedCell && "bg-accent/40 ring-1 ring-inset ring-primary",
                    isFrozen && isSelectedCell && "bg-accent",
                    isDirtyCell && "bg-amber-500/10 ring-1 ring-inset ring-amber-500/70",
                    isFrozen && isDirtyCell && "bg-amber-500/15",
                    isPendingDeleteRow && "text-muted-foreground",
                    isVirtualEmptyRow && "text-muted-foreground/50",
                    isNull && "italic text-muted-foreground/60",
                    editable && "cursor-text",
                  )}
                  style={{
                    left: isFrozen ? undefined : virtualColumn.start,
                    width: virtualColumn.size,
                  }}
                  onClick={(event) => {
                    if (isVirtualEmptyRow) return;
                    onCellSelect?.(rowIndex, columnId, value, event);
                  }}
                  onContextMenu={(event) => {
                    if (!isVirtualEmptyRow) {
                      setContextMenuTarget(cellTarget);
                      onRowContextMenu?.(cellTarget, event);
                    }
                  }}
                  onDoubleClick={(event) => {
                    if (!editable) return;
                    onCellDoubleClick?.(rowIndex, columnId, value, event);
                  }}
                >
                  {isEditing ? (
                    <CellEditor
                      initialValue={editingCell.value}
                      column={colDef}
                      rowIndex={rowIndex}
                      columnId={columnId}
                      isActive={isActive}
                      onCommit={onCellEditCommit}
                      onCancel={onCellEditCancel}
                    />
                  ) : isVirtualEmptyRow ? (
                    String(value)
                  ) : isNull ? (
                    "NULL"
                  ) : colDef?.cell ? (
                    colDef.cell(value, rowIndex)
                  ) : (
                    String(value)
                  )}
                </div>
              );
            };

            return (
              <div
                key={virtualRow.key}
                data-slot="data-table-row"
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  transform: `translateY(${virtualRow.start}px)`,
                  width: "100%",
                  height: `${rowHeight}px`,
                }}
                className={cn(
                  "flex items-center border-b border-border/50 text-xs hover:bg-accent/50",
                  isCurrentRow && !isSelected && "bg-accent/25",
                  isSelected && "bg-accent/60 hover:bg-accent/70",
                  isDraftRow && "bg-emerald-500/5 hover:bg-emerald-500/10",
                  isPendingDeleteRow && "bg-destructive/5 text-muted-foreground line-through hover:bg-destructive/10",
                  isVirtualEmptyRow && "pointer-events-none bg-muted/20",
                )}
              >
                {showRowNumbers && (
                  <button
                    type="button"
                    data-slot="data-table-row-number-cell"
                    className={cn(
                      "sticky left-0 z-20 flex h-full shrink-0 items-center justify-center border-r border-border/50 bg-background px-1 text-center text-muted-foreground tabular-nums",
                      !isVirtualEmptyRow && "cursor-pointer hover:bg-accent",
                      isCurrentRow && !isSelected && "bg-accent/30 text-foreground",
                      isSelected && "bg-accent text-accent-foreground hover:bg-accent",
                      isDraftRow && !isSelected && "bg-emerald-500/10 text-emerald-700",
                      isVirtualEmptyRow && "text-muted-foreground/40",
                    )}
                    style={{ width: rowNumberWidth }}
                    onClick={(event) => {
                      if (isVirtualEmptyRow) return;
                      event.stopPropagation();
                      onRowSelect?.(rowIndex, rowData, event);
                      onRowClick?.(rowIndex, rowData);
                    }}
                    onContextMenu={(event) => {
                      if (!isVirtualEmptyRow) {
                        setContextMenuTarget(rowNumberTarget);
                        onRowContextMenu?.(rowNumberTarget, event);
                      }
                    }}
                    disabled={isVirtualEmptyRow}
                    aria-label={
                      isVirtualEmptyRow
                        ? undefined
                        : `选择第 ${displayRowNumber} 行`
                    }
                  >
                    {isVirtualEmptyRow
                      ? ""
                      : rowNumberFormatter?.(
                          rowIndex,
                          displayRowNumber,
                          rowData,
                          { isDraftRow },
                        ) ?? (isDraftRow ? "*" : displayRowNumber)}
                  </button>
                )}
                {frozenColumnItems.length > 0 && (
                  <div
                    data-slot="data-table-frozen-cells"
                    className="sticky z-20 flex h-full shrink-0 bg-background"
                    style={{
                      left: rowNumberWidth,
                      width: columnVirtualizer.getFrozenSize(),
                    }}
                  >
                    {frozenColumnItems.map((virtualColumn) =>
                      renderDataCell(virtualColumn, true),
                    )}
                  </div>
                )}
                {columnVirtualizer.getScrollableVirtualItems().map((virtualColumn) =>
                  renderDataCell(virtualColumn, false),
                )}
              </div>
            );
          })}
        </div>}
      />
      {contextMenuContent && (
        <ContextMenuContent>{contextMenuContent}</ContextMenuContent>
      )}
    </ContextMenu>
  );
}
