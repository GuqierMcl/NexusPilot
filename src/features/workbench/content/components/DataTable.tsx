import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef, useCallback } from "react";

import { cn } from "@/lib/utils";

// ─── DataTable 列定义 ────────────────────────────────────────────────────────

export interface DataTableColumn {
    key: string;
    header: string;
    width?: number | string;
}

// ─── DataTable Props ─────────────────────────────────────────────────────────

interface DataTableProps {
    columns: DataTableColumn[];
    rows: unknown[][];
    rowHeight?: number;
    overscan?: number;
    onRowClick?: (rowIndex: number, rowData: unknown[]) => void;
    className?: string;
    emptyMessage?: string;
}

// ─── DataTable ────────────────────────────────────────────────────────────────

export function DataTable({
    columns,
    rows,
    rowHeight = 32,
    overscan = 20,
    onRowClick,
    className,
    emptyMessage = "暂无数据",
}: DataTableProps) {
    const tableContainerRef = useRef<HTMLDivElement>(null);

    const rowVirtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => tableContainerRef.current,
        estimateSize: () => rowHeight,
        overscan,
    });

    const handleRowClick = useCallback(
        (rowIndex: number) => {
            if (onRowClick) {
                onRowClick(rowIndex, rows[rowIndex]!);
            }
        },
        [onRowClick, rows],
    );

    if (rows.length === 0) {
        return (
            <div
                className={cn(
                    "flex flex-1 items-center justify-center text-sm text-muted-foreground",
                    className,
                )}
            >
                {emptyMessage}
            </div>
        );
    }

    return (
        <div className={cn("flex flex-1 flex-col overflow-hidden", className)}>
            {/* 固定表头 */}
            <div className="flex shrink-0 border-b bg-muted/50 text-xs font-medium text-muted-foreground">
                {columns.map((col, i) => (
                    <div
                        key={col.key}
                        className={cn(
                            "shrink-0 truncate px-3 py-2",
                            i === 0 && "sticky left-0 z-10 bg-muted/50",
                        )}
                        style={{ width: col.width ?? 160 }}
                    >
                        {col.header}
                    </div>
                ))}
            </div>

            {/* 虚拟滚动行区域 */}
            <div ref={tableContainerRef} className="flex-1 overflow-auto">
                <div
                    style={{
                        height: `${rowVirtualizer.getTotalSize()}px`,
                        width: "100%",
                        position: "relative",
                    }}
                >
                    {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                        const rowData = rows[virtualRow.index];
                        if (!rowData) return null;

                        return (
                            <div
                                key={virtualRow.key}
                                data-index={virtualRow.index}
                                ref={rowVirtualizer.measureElement}
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
                                    onRowClick && "cursor-pointer",
                                )}
                                onClick={() => handleRowClick(virtualRow.index)}
                            >
                                {columns.map((col, i) => {
                                    const cellValue = rowData[i];
                                    const isNull =
                                        cellValue === null ||
                                        cellValue === undefined;

                                    return (
                                        <div
                                            key={col.key}
                                            className={cn(
                                                "shrink-0 truncate px-3",
                                                i === 0 &&
                                                    "sticky left-0 bg-background",
                                                isNull &&
                                                    "italic text-muted-foreground/60",
                                            )}
                                            style={{ width: col.width ?? 160 }}
                                        >
                                            {isNull
                                                ? "NULL"
                                                : String(cellValue)}
                                        </div>
                                    );
                                })}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
