import type { DataTableColumn } from "@/components/data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
    TableColumnDraft,
    TableConstraintDraft,
    TableIndexDraft,
    TableSchemaDraft,
} from "@/types/table-design";

import { ColumnsTab } from "./columns/ColumnsTab";
import { ConstraintsTab } from "./constraints/ConstraintsTab";
import type { TableDesignDriverProfile } from "./driver-profiles";
import { IndexesTab } from "./indexes/IndexesTab";
import { TableOptionsTab } from "./options/TableOptionsTab";
import { TablePartitionsTab } from "./options/TablePartitionsTab";

interface TableDesignTabsProps {
    mode: "create" | "edit";
    driver: string | null;
    draft: TableSchemaDraft;
    profile: TableDesignDriverProfile;
    columnColumns: DataTableColumn[];
    indexColumns: DataTableColumn[];
    constraintColumns: DataTableColumn[];
    onBasicsFieldChange: (field: keyof TableSchemaDraft["basics"], value: string) => void;
    onAddColumn: () => void;
    onAddIndex: () => void;
    onAddConstraint: () => void;
    onDeleteColumns: (selectedRowIndexes: number[]) => void;
    onDeleteIndexes: (selectedRowIndexes: number[]) => void;
    onDeleteConstraints: (selectedRowIndexes: number[]) => void;
    onMoveColumns: (selectedRowIndexes: number[], direction: -1 | 1) => void;
    onMoveIndexes: (selectedRowIndexes: number[], direction: -1 | 1) => void;
    onMoveConstraints: (selectedRowIndexes: number[], direction: -1 | 1) => void;
    onUpdateColumn: (rowIndex: number, columnId: string, value: unknown) => void;
    onUpdateIndex: (rowIndex: number, columnId: string, value: unknown) => void;
    onUpdateConstraint: (rowIndex: number, columnId: string, value: unknown) => void;
    onPatchColumn: (rowIndex: number, patch: Partial<TableColumnDraft>) => void;
    onPatchIndex: (rowIndex: number, patch: Partial<TableIndexDraft>) => void;
    onPatchConstraint: (rowIndex: number, patch: Partial<TableConstraintDraft>) => void;
}

export function TableDesignTabs({
    mode,
    driver,
    draft,
    profile,
    columnColumns,
    indexColumns,
    constraintColumns,
    onBasicsFieldChange,
    onAddColumn,
    onAddIndex,
    onAddConstraint,
    onDeleteColumns,
    onDeleteIndexes,
    onDeleteConstraints,
    onMoveColumns,
    onMoveIndexes,
    onMoveConstraints,
    onUpdateColumn,
    onUpdateIndex,
    onUpdateConstraint,
    onPatchColumn,
    onPatchIndex,
    onPatchConstraint,
}: TableDesignTabsProps) {
    return (
        <Tabs
            defaultValue="columns"
            className="flex h-full min-h-0 flex-1 flex-col gap-0 overflow-hidden"
        >
            <div className="shrink-0 border-b px-3 py-1">
                <TabsList className="h-7" variant="line">
                    <TabsTrigger className="text-xs" value="columns">列</TabsTrigger>
                    <TabsTrigger className="text-xs" value="indexes">索引</TabsTrigger>
                    <TabsTrigger className="text-xs" value="constraints">约束</TabsTrigger>
                    <TabsTrigger className="text-xs" value="options">选项</TabsTrigger>
                    <TabsTrigger className="text-xs" value="partitions">分区</TabsTrigger>
                </TabsList>
            </div>
            <TabsContent value="columns" className="min-h-0 flex-1 overflow-hidden p-0">
                <ColumnsTab
                    draft={draft}
                    profile={profile}
                    columnColumns={columnColumns}
                    onAddColumn={onAddColumn}
                    onDeleteColumns={onDeleteColumns}
                    onMoveColumns={onMoveColumns}
                    onUpdateColumn={onUpdateColumn}
                    onPatchColumn={onPatchColumn}
                />
            </TabsContent>
            <TabsContent value="indexes" className="min-h-0 flex-1 overflow-hidden p-0">
                <IndexesTab
                    draft={draft}
                    profile={profile}
                    indexColumns={indexColumns}
                    onAddIndex={onAddIndex}
                    onDeleteIndexes={onDeleteIndexes}
                    onMoveIndexes={onMoveIndexes}
                    onUpdateIndex={onUpdateIndex}
                    onPatchIndex={onPatchIndex}
                />
            </TabsContent>
            <TabsContent value="constraints" className="min-h-0 flex-1 overflow-hidden p-0">
                <ConstraintsTab
                    draft={draft}
                    profile={profile}
                    constraintColumns={constraintColumns}
                    onAddConstraint={onAddConstraint}
                    onDeleteConstraints={onDeleteConstraints}
                    onMoveConstraints={onMoveConstraints}
                    onUpdateConstraint={onUpdateConstraint}
                    onPatchConstraint={onPatchConstraint}
                />
            </TabsContent>
            <TabsContent value="options" className="min-h-0 flex-1 overflow-auto p-0">
                <TableOptionsTab
                    draft={draft}
                    profile={profile}
                    onBasicsFieldChange={onBasicsFieldChange}
                />
            </TabsContent>
            <TabsContent value="partitions" className="min-h-0 flex-1 overflow-auto p-0">
                <TablePartitionsTab
                    mode={mode}
                    driver={driver}
                    draft={draft}
                    onBasicsFieldChange={onBasicsFieldChange}
                />
            </TabsContent>
        </Tabs>
    );
}
