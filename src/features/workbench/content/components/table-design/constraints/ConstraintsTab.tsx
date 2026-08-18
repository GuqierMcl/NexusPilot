import { useMemo, useState } from "react";

import type { DataTableColumn } from "@/components/data-table";
import type { TableConstraintDraft, TableSchemaDraft } from "@/types/table-design";

import { EditableGridSection } from "../EditableGridSection";
import { TableDesignSplitPane } from "../TableDesignSplitPane";
import type { TableDesignDriverProfile } from "../driver-profiles";
import { toConstraintRows } from "../table-design-utils";
import { ConstraintPropertiesPanel } from "./ConstraintPropertiesPanel";

interface ConstraintsTabProps {
    draft: TableSchemaDraft;
    profile: TableDesignDriverProfile;
    constraintColumns: DataTableColumn[];
    onAddConstraint: () => void;
    onDeleteConstraints: (selectedRowIndexes: number[]) => void;
    onMoveConstraints: (selectedRowIndexes: number[], direction: -1 | 1) => void;
    onUpdateConstraint: (rowIndex: number, columnId: string, value: unknown) => void;
    onPatchConstraint: (rowIndex: number, patch: Partial<TableConstraintDraft>) => void;
}

export function ConstraintsTab({
    draft,
    profile,
    constraintColumns,
    onAddConstraint,
    onDeleteConstraints,
    onMoveConstraints,
    onUpdateConstraint,
    onPatchConstraint,
}: ConstraintsTabProps) {
    const [selectedConstraint, setSelectedConstraint] = useState(0);
    const [isPropertiesOpen, setIsPropertiesOpen] = useState(true);
    const rows = useMemo(() => toConstraintRows(draft.constraints), [draft.constraints]);
    const selectedConstraintDraft = draft.constraints[selectedConstraint] ?? null;

    return (
        <TableDesignSplitPane
            detailsTitle="约束属性"
            isDetailsOpen={isPropertiesOpen}
            onDetailsOpenChange={setIsPropertiesOpen}
            main={
                <EditableGridSection
                    description="维护主键、唯一约束、外键和 CHECK 约束。"
                    emptyMessage="还没有约束，点击右上角 + 新建。"
                    columns={constraintColumns}
                    rows={rows}
                    onAdd={onAddConstraint}
                    onDeleteSelected={onDeleteConstraints}
                    onMoveUp={(selectedRowIndexes) => onMoveConstraints(selectedRowIndexes, -1)}
                    onMoveDown={(selectedRowIndexes) => onMoveConstraints(selectedRowIndexes, 1)}
                    onCellEditCommit={(rowIndex, columnId, value) => {
                        setSelectedConstraint(rowIndex);
                        onUpdateConstraint(rowIndex, columnId, value);
                    }}
                    advancedActionLabel="属性"
                    onOpenAdvanced={(rowIndex) => {
                        setSelectedConstraint(rowIndex);
                        setIsPropertiesOpen(true);
                    }}
                />
            }
            details={
                <ConstraintPropertiesPanel
                    constraint={selectedConstraintDraft}
                    profile={profile}
                    onChange={(patch) => onPatchConstraint(selectedConstraint, patch)}
                />
            }
        />
    );
}
