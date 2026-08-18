import { cn } from "@/lib/utils";
import { useDataTable } from "./data-table-context";
import type { DataTablePreset } from "./types";

// ─── DataTableHeader ───────────────────────────────────────────────────────────
// Renders the table header row with column resize handles.
// Designed to be placed OUTSIDE the scroll area, with horizontal scroll synced
// via the `headerRef` prop.

interface DataTableHeaderProps {
  headerRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Wheel event handler forwarded from parent.
   * Bound here (not on the outer container) to avoid double-scroll:
   * the ScrollArea viewport handles its own wheel events natively,
   * so this handler must only intercept wheel events on the header.
   */
  onWheel?: (e: React.WheelEvent) => void;
}

function getHeaderMinHeightClass(preset: DataTablePreset): string {
  if (preset === "database") return "min-h-14";
  if (preset === "compact" || preset === "keyValue") return "min-h-9";
  return "min-h-10";
}

export function DataTableHeader({ headerRef, onWheel }: DataTableHeaderProps) {
  const {
    table,
    columns,
    enableColumnResizing,
    frozenColumnIdSet,
    rowNumberWidth,
    showRowNumbers,
    preset,
    renderColumnHeaderMeta,
  } = useDataTable();
  const headerMinHeightClass = getHeaderMinHeightClass(preset);

  return (
    <div
      ref={headerRef}
      data-slot="data-table-header"
      className="shrink-0 overflow-hidden border-b bg-muted/50"
      onWheel={onWheel}
    >
      <div
        className="flex text-xs font-medium text-muted-foreground"
        style={{ minWidth: table.getTotalSize() + rowNumberWidth }}
      >
        {showRowNumbers && (
          <div
            data-slot="data-table-row-number-header"
            className={cn(
              "sticky left-0 z-20 flex shrink-0 items-center justify-center border-r border-border/60 bg-muted/50",
              headerMinHeightClass,
            )}
            style={{ width: rowNumberWidth }}
          />
        )}
        {table.getHeaderGroups().map((headerGroup) => {
          // ── Compute cumulative left offset for frozen columns ──
          // Frozen columns are positioned left-to-right in DOM order.
          // Each frozen column's `left` equals the sum of all preceding
          // frozen columns' widths (including preceding non-frozen columns
          // that appear before it in the column list are skipped — only
          // frozen columns contribute to the offset).
          let frozenLeft = rowNumberWidth;

          return headerGroup.headers.map((header) => {
            const isFrozen = frozenColumnIdSet.has(header.column.id);
            const currentLeft = isFrozen ? frozenLeft : undefined;
            if (isFrozen) {
              frozenLeft += header.getSize();
            }
            const columnMeta = columns.find((column) => column.id === header.column.id);
            const headerMeta = columnMeta
              ? renderColumnHeaderMeta?.(columnMeta)
              : null;

            return (
              <div
                key={header.id}
                data-slot="data-table-header-cell"
                className={cn(
                  "relative flex shrink-0 flex-col justify-center gap-1 border-r border-border/60 px-3 py-2",
                  headerMinHeightClass,
                  isFrozen && "sticky z-10 bg-muted/50",
                )}
                style={{
                  width: header.getSize(),
                  ...(isFrozen && { left: currentLeft }),
                }}
              >
                {header.isPlaceholder ? null : (
                  <>
                    <span className="truncate text-xs font-semibold text-foreground">
                      {header.column.columnDef.header as string}
                    </span>
                    {headerMeta}
                  </>
                )}
                {enableColumnResizing && header.column.getCanResize() && (
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    onDoubleClick={() => header.column.resetSize()}
                    onMouseDown={header.getResizeHandler()}
                    onTouchStart={header.getResizeHandler()}
                    className={cn(
                      "absolute right-0 top-0 h-full w-1 cursor-col-resize select-none",
                      "hover:bg-primary/50 active:bg-primary/70",
                      "transition-colors",
                      header.column.getIsResizing() && "bg-primary",
                    )}
                  />
                )}
              </div>
            );
          });
        })}
      </div>
    </div>
  );
}
