import { useMemo, useState } from "react";

import type { DataTableColumn } from "@/components/data-table";
import type { TableColumnDraft, TableSchemaDraft } from "@/types/table-design";

import { EditableGridSection } from "../EditableGridSection";
import { TableDesignSplitPane } from "../TableDesignSplitPane";
import type { TableDesignDriverProfile } from "../driver-profiles";
import { toColumnRows } from "../table-design-utils";
import { ColumnPropertiesPanel } from "./ColumnPropertiesPanel";

interface ColumnsTabProps {
    draft: TableSchemaDraft;
    profile: TableDesignDriverProfile;
    columnColumns: DataTableColumn[];
    onAddColumn: () => void;
    onDeleteColumns: (selectedRowIndexes: number[]) => void;
    onMoveColumns: (selectedRowIndexes: number[], direction: -1 | 1) => void;
    onUpdateColumn: (rowIndex: number, columnId: string, value: unknown) => void;
    onPatchColumn: (rowIndex: number, patch: Partial<TableColumnDraft>) => void;
}

export function ColumnsTab({
    draft,
    profile,
    columnColumns,
    onAddColumn,
    onDeleteColumns,
    onMoveColumns,
    onUpdateColumn,
    onPatchColumn,
}: ColumnsTabProps) {
    const [selectedColumnIndex, setSelectedColumnIndex] = useState(0);
    const [isPropertiesOpen, setIsPropertiesOpen] = useState(true);
    const selectedColumn = draft.columns[selectedColumnIndex] ?? null;
    const rows = useMemo(() => toColumnRows(draft.columns), [draft.columns]);

    return (
        <TableDesignSplitPane
            detailsTitle="列属性"
            isDetailsOpen={isPropertiesOpen}
            onDetailsOpenChange={setIsPropertiesOpen}
            main={
                <EditableGridSection
                    description="编辑字段名称、类型摘要、默认值和常用约束。详细类型参数在右侧属性面板调整。"
                    emptyMessage="还没有字段，点击右上角 + 开始添加列。"
                    columns={columnColumns}
                    rows={rows}
                    onAdd={onAddColumn}
                    onDeleteSelected={onDeleteColumns}
                    onMoveUp={(selectedRowIndexes) => onMoveColumns(selectedRowIndexes, -1)}
                    onMoveDown={(selectedRowIndexes) => onMoveColumns(selectedRowIndexes, 1)}
                    onCellEditCommit={(rowIndex, columnId, value) => {
                        setSelectedColumnIndex(rowIndex);
                        onUpdateColumn(rowIndex, columnId, value);
                    }}
                    advancedActionLabel="属性"
                    onOpenAdvanced={(rowIndex) => {
                        setSelectedColumnIndex(rowIndex);
                        setIsPropertiesOpen(true);
                    }}
                />
            }
            details={
                <ColumnPropertiesPanel
                    column={selectedColumn}
                    profile={profile}
                    onChange={(patch) => onPatchColumn(selectedColumnIndex, patch)}
                />
            }
        />
    );
}
