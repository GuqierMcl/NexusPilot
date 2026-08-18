import type { QueryResult } from "@/types/ipc";
import type { DataTableContextMenuTarget } from "@/components/data-table";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { Copy, RefreshCw, Trash2 } from "lucide-react";

import { isTextLikeColumn } from "./table-data-utils";

interface TableDataContextMenuContentProps {
    target: DataTableContextMenuTarget;
    columns?: QueryResult["columns"];
    hasData: boolean;
    selectedRowIndexes: number[];
    draftRowIndexSet: Set<number>;
    canMutate: boolean;
    isSavePending: boolean;
    isTableBusy: boolean;
    isCellEditable: (rowIndex: number, columnId: string, value?: unknown) => boolean;
    onOpenDeleteConfirm: (rowIndex: number) => void;
    onOpenDeleteConfirmForIndexes: (rowIndexes: number[]) => void;
    onCopyRowsForIndexes: (rowIndexes: number[]) => void;
    onCopyCellValue: (value: unknown) => void;
    onUpdateCellValue: (rowIndex: number, columnId: string, nextValue: unknown) => void;
    onRefresh: () => void;
}

export function TableDataContextMenuContent({
    target,
    columns,
    hasData,
    selectedRowIndexes,
    draftRowIndexSet,
    canMutate,
    isSavePending,
    isTableBusy,
    isCellEditable,
    onOpenDeleteConfirm,
    onOpenDeleteConfirmForIndexes,
    onCopyRowsForIndexes,
    onCopyCellValue,
    onUpdateCellValue,
    onRefresh,
}: TableDataContextMenuContentProps) {
    if (target.kind === "rowNumber") {
        const rowIsSelected = selectedRowIndexes.includes(target.rowIndex);
        const isDraftRow = draftRowIndexSet.has(target.rowIndex);
        const deleteCount = rowIsSelected ? selectedRowIndexes.length : 1;
        const rowIndexesToCopy = rowIsSelected ? selectedRowIndexes : [target.rowIndex];

        return (
            <>
                <ContextMenuItem
                    variant="destructive"
                    disabled={!canMutate || isDraftRow || isSavePending}
                    onClick={() => onOpenDeleteConfirm(target.rowIndex)}
                >
                    <Trash2 data-icon="inline-start" />
                    {deleteCount > 1 ? `标记选中 ${deleteCount} 条记录待删除` : "标记一条记录待删除"}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                    disabled={!hasData || rowIndexesToCopy.length === 0}
                    onClick={() => onCopyRowsForIndexes(rowIndexesToCopy)}
                >
                    <Copy data-icon="inline-start" />
                    复制
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem disabled={isTableBusy} onClick={onRefresh}>
                    <RefreshCw data-icon="inline-start" />
                    刷新
                </ContextMenuItem>
            </>
        );
    }

    const column = columns?.find((item) => item.name === target.columnId);
    const editable = isCellEditable(target.rowIndex, target.columnId, target.value);
    const canSetNull = editable && Boolean(column?.nullable) && target.value !== null;
    const canSetEmptyString =
        editable &&
        isTextLikeColumn(column) &&
        target.value !== "";
    const isDraftRow = draftRowIndexSet.has(target.rowIndex);

    return (
        <>
            <ContextMenuItem
                disabled={!canSetNull || isSavePending}
                onClick={() => onUpdateCellValue(target.rowIndex, target.columnId, null)}
            >
                设置为 NULL
            </ContextMenuItem>
            <ContextMenuItem
                disabled={!canSetEmptyString || isSavePending}
                onClick={() => onUpdateCellValue(target.rowIndex, target.columnId, "")}
            >
                设置为空白字符串
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
                variant="destructive"
                disabled={!canMutate || isDraftRow || isSavePending}
                onClick={() => onOpenDeleteConfirmForIndexes([target.rowIndex])}
            >
                <Trash2 data-icon="inline-start" />
                标记记录待删除
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onCopyCellValue(target.value)}>
                <Copy data-icon="inline-start" />
                复制
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={isTableBusy} onClick={onRefresh}>
                <RefreshCw data-icon="inline-start" />
                刷新
            </ContextMenuItem>
        </>
    );
}
