import { useCallback, useState } from "react";
import { ArrowDown, ArrowUp, Plus, SlidersHorizontal, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
    DataTable,
    type DataTableColumn,
    type DataTableContextMenuTarget,
} from "@/components/data-table";

export function ContextInfoItem({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-muted-foreground">{label}</span>
            <span className="min-w-0 truncate font-medium text-foreground">{value || "未指定"}</span>
        </div>
    );
}

interface EditableGridSectionProps {
    description: string;
    emptyMessage: string;
    columns: DataTableColumn[];
    rows: unknown[][];
    onAdd: () => void;
    onDeleteSelected: (selectedRowIndexes: number[]) => void;
    onMoveUp: (selectedRowIndexes: number[]) => void;
    onMoveDown: (selectedRowIndexes: number[]) => void;
    onCellEditCommit: (rowIndex: number, columnId: string, value: unknown) => void;
    advancedActionLabel?: string;
    onOpenAdvanced?: (rowIndex: number) => void;
    renderRowContextMenu?: (
        target: DataTableContextMenuTarget,
        selectedRowIndexes: number[],
    ) => React.ReactNode;
}

export function EditableGridSection({
    description,
    emptyMessage,
    columns,
    rows,
    onAdd,
    onDeleteSelected,
    onMoveUp,
    onMoveDown,
    onCellEditCommit,
    advancedActionLabel,
    onOpenAdvanced,
    renderRowContextMenu,
}: EditableGridSectionProps) {
    const [selectedRowIndexes, setSelectedRowIndexes] = useState<number[]>([]);
    const [currentRowIndex, setCurrentRowIndex] = useState<number | null>(null);
    const [selectedCell, setSelectedCell] = useState<{
        rowIndex: number;
        columnId: string;
    } | null>(null);
    const [editingCell, setEditingCell] = useState<{
        rowIndex: number;
        columnId: string;
        value: unknown;
    } | null>(null);

    const handleDeleteSelected = useCallback(() => {
        onDeleteSelected(selectedRowIndexes);
        setSelectedRowIndexes([]);
        setCurrentRowIndex(null);
        setSelectedCell(null);
        setEditingCell(null);
    }, [onDeleteSelected, selectedRowIndexes]);

    const handleMoveUp = useCallback(() => {
        onMoveUp(selectedRowIndexes);
    }, [onMoveUp, selectedRowIndexes]);

    const handleMoveDown = useCallback(() => {
        onMoveDown(selectedRowIndexes);
    }, [onMoveDown, selectedRowIndexes]);

    const actions = (
        <div className="flex shrink-0 flex-nowrap items-center gap-1">
            <Button size="icon" variant="ghost" className="size-7" onClick={onAdd} title="新增">
                <Plus className="size-4" />
            </Button>
            {onOpenAdvanced ? (
                <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 whitespace-nowrap px-2"
                    disabled={selectedRowIndexes.length !== 1}
                    onClick={() => {
                        const rowIndex = selectedRowIndexes[0];
                        if (rowIndex != null) onOpenAdvanced(rowIndex);
                    }}
                    title={advancedActionLabel ?? "高级"}
                >
                    <SlidersHorizontal className="size-4" />
                    {advancedActionLabel ?? "高级"}
                </Button>
            ) : null}
            <Button
                size="icon"
                variant="ghost"
                className="size-7"
                disabled={selectedRowIndexes.length === 0}
                onClick={handleDeleteSelected}
                title="删除选中"
            >
                <Trash2 className="size-4" />
            </Button>
            <Button
                size="icon"
                variant="ghost"
                className="size-7"
                disabled={selectedRowIndexes.length === 0}
                onClick={handleMoveUp}
                title="上移"
            >
                <ArrowUp className="size-4" />
            </Button>
            <Button
                size="icon"
                variant="ghost"
                className="size-7"
                disabled={selectedRowIndexes.length === 0}
                onClick={handleMoveDown}
                title="下移"
            >
                <ArrowDown className="size-4" />
            </Button>
        </div>
    );

    return (
        <section className="flex h-full min-h-0 min-w-0 flex-col bg-background">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-1.5">
                <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-muted-foreground">{description}</p>
                </div>
                {actions}
            </div>
            <div className="min-h-0 flex-1 p-3">
                <DataTable
                    preset="database"
                    columns={columns}
                    rows={rows}
                    className="h-full min-h-0 min-w-0 rounded-md border"
                    rowHeight={34}
                    emptyMessage={emptyMessage}
                    selectedRowIndexes={selectedRowIndexes}
                    currentRowIndex={currentRowIndex}
                    selectedCell={selectedCell}
                    editingCell={editingCell}
                    onRowSelect={(rowIndex) => {
                        setSelectedRowIndexes((current) =>
                            current.includes(rowIndex)
                                ? current.filter((item) => item !== rowIndex)
                                : [...current, rowIndex],
                        );
                        setCurrentRowIndex(rowIndex);
                    }}
                    onCellSelect={(rowIndex, columnId, value) => {
                        setSelectedCell({ rowIndex, columnId });
                        setCurrentRowIndex(rowIndex);
                        setSelectedRowIndexes((current) =>
                            current.includes(rowIndex) ? current : [rowIndex],
                        );
                        setEditingCell({ rowIndex, columnId, value });
                    }}
                    onCellDoubleClick={(rowIndex, columnId, value) => {
                        setSelectedCell({ rowIndex, columnId });
                        setCurrentRowIndex(rowIndex);
                        setEditingCell({ rowIndex, columnId, value });
                    }}
                    isCellEditable={() => true}
                    onCellEditCommit={(rowIndex, columnId, value) => {
                        onCellEditCommit(rowIndex, columnId, value);
                        setEditingCell(null);
                    }}
                    onCellEditCancel={() => setEditingCell(null)}
                    onRowContextMenu={
                        renderRowContextMenu
                            ? (target) => renderRowContextMenu(target, selectedRowIndexes)
                            : undefined
                    }
                />
            </div>
        </section>
    );
}
