import { useMemo, useState } from "react";

import type { DataTableColumn } from "@/components/data-table";
import type { TableIndexDraft, TableSchemaDraft } from "@/types/table-design";

import { EditableGridSection } from "../EditableGridSection";
import { TableDesignSplitPane } from "../TableDesignSplitPane";
import type { TableDesignDriverProfile } from "../driver-profiles";
import { toIndexRows } from "../table-design-utils";
import { IndexPropertiesPanel } from "./IndexPropertiesPanel";

interface IndexesTabProps {
    draft: TableSchemaDraft;
    profile: TableDesignDriverProfile;
    indexColumns: DataTableColumn[];
    onAddIndex: () => void;
    onDeleteIndexes: (selectedRowIndexes: number[]) => void;
    onMoveIndexes: (selectedRowIndexes: number[], direction: -1 | 1) => void;
    onUpdateIndex: (rowIndex: number, columnId: string, value: unknown) => void;
    onPatchIndex: (rowIndex: number, patch: Partial<TableIndexDraft>) => void;
}

export function IndexesTab({
    draft,
    profile,
    indexColumns,
    onAddIndex,
    onDeleteIndexes,
    onMoveIndexes,
    onUpdateIndex,
    onPatchIndex,
}: IndexesTabProps) {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [isPropertiesOpen, setIsPropertiesOpen] = useState(true);
    const rows = useMemo(() => toIndexRows(draft.indexes), [draft.indexes]);
    const selectedIndexDraft = draft.indexes[selectedIndex] ?? null;

    return (
        <TableDesignSplitPane
            detailsTitle="索引属性"
            isDetailsOpen={isPropertiesOpen}
            onDetailsOpenChange={setIsPropertiesOpen}
            main={
                <EditableGridSection
                    description="维护索引名、列顺序、唯一性和当前数据库支持的索引方法。"
                    emptyMessage="还没有索引，点击右上角 + 新建。"
                    columns={indexColumns}
                    rows={rows}
                    onAdd={onAddIndex}
                    onDeleteSelected={onDeleteIndexes}
                    onMoveUp={(selectedRowIndexes) => onMoveIndexes(selectedRowIndexes, -1)}
                    onMoveDown={(selectedRowIndexes) => onMoveIndexes(selectedRowIndexes, 1)}
                    onCellEditCommit={(rowIndex, columnId, value) => {
                        setSelectedIndex(rowIndex);
                        onUpdateIndex(rowIndex, columnId, value);
                    }}
                    advancedActionLabel="属性"
                    onOpenAdvanced={(rowIndex) => {
                        setSelectedIndex(rowIndex);
                        setIsPropertiesOpen(true);
                    }}
                />
            }
            details={
                <IndexPropertiesPanel
                    index={selectedIndexDraft}
                    profile={profile}
                    onChange={(patch) => onPatchIndex(selectedIndex, patch)}
                />
            }
        />
    );
}
