import { useCallback } from "react";

import {
    useTabRuntimeStateStore,
} from "@/store";
import type {
    TableColumnDraft,
    TableConstraintDraft,
    TableIndexDraft,
    TableSchemaDraft,
} from "@/types/table-design";
import type { TableDesignDriverProfile } from "./driver-profiles";
import { parseColumnType } from "./columns/column-type-parser";

import {
    createColumnDraft,
    createConstraintDraft,
    createIndexDraft,
    normalizeColumnDraftType,
    replaceColumnNameInColumnList,
    syncPrimaryKeyConstraintFromColumns,
} from "./table-design-utils";

type PatchTableDesignState = ReturnType<
    typeof useTabRuntimeStateStore.getState
>["patchTableDesignState"];
type ResetTableDesignDraft = ReturnType<
    typeof useTabRuntimeStateStore.getState
>["resetTableDesignDraft"];

interface UseTableDesignDraftActionsOptions {
    tabId: string;
    profile: TableDesignDriverProfile;
    patchTableDesignState: PatchTableDesignState;
    resetTableDesignDraft: ResetTableDesignDraft;
}

function moveDraftRows<T>(rows: T[], selectedRowIndexes: number[], direction: -1 | 1): T[] {
    const ordered = [...selectedRowIndexes].sort((a, b) => a - b);
    if (ordered.length === 0) return rows;

    const nextRows = [...rows];
    const indexes = direction === -1 ? ordered : [...ordered].reverse();

    for (const index of indexes) {
        const targetIndex = index + direction;
        if (targetIndex < 0 || targetIndex >= nextRows.length) continue;

        const [item] = nextRows.splice(index, 1);
        nextRows.splice(targetIndex, 0, item);
    }

    return nextRows;
}

export function useTableDesignDraftActions({
    tabId,
    profile,
    patchTableDesignState,
    resetTableDesignDraft,
}: UseTableDesignDraftActionsOptions) {
    const updateBasicsField = useCallback(
        (field: keyof TableSchemaDraft["basics"], value: string) => {
            patchTableDesignState(tabId, (current) => ({
                draft: {
                    ...current.draft,
                    basics: {
                        ...current.draft.basics,
                        [field]: value,
                    },
                },
            }));
        },
        [patchTableDesignState, tabId],
    );

    const updateColumnDraft = useCallback(
        (rowIndex: number, columnId: string, value: unknown) => {
            patchTableDesignState(tabId, (current) => {
                const previousColumn = current.draft.columns[rowIndex];
                const previousName = previousColumn?.name ?? "";
                const nextName = columnId === "name" ? String(value) : previousName;
                const columns = current.draft.columns.map((column, index) => {
                    if (index !== rowIndex) return column;

                    if (columnId === "name") return { ...column, name: String(value) };
                    if (columnId === "typeName") {
                        const typeName = String(value);
                        return normalizeColumnDraftType(
                            {
                                ...column,
                                typeName,
                                typeDraft: parseColumnType(typeName, profile),
                            },
                            profile,
                        );
                    }
                    if (columnId === "nullable") return { ...column, nullable: Boolean(value) };
                    if (columnId === "defaultValue") return { ...column, defaultValue: String(value) };
                    if (columnId === "isPrimaryKey") {
                        const isPrimaryKey = Boolean(value);
                        return {
                            ...column,
                            isPrimaryKey,
                            nullable: isPrimaryKey ? false : column.nullable,
                        };
                    }
                    if (columnId === "isUnique") return { ...column, isUnique: Boolean(value) };
                    if (columnId === "isIdentity") return { ...column, isIdentity: Boolean(value) };
                    if (columnId === "comment") return { ...column, comment: String(value) };
                    return column;
                });
                const renamedIndexes =
                    columnId === "name"
                        ? current.draft.indexes.map((index) => ({
                              ...index,
                              columns: replaceColumnNameInColumnList(
                                  index.columns,
                                  previousName,
                                  nextName,
                              ),
                          }))
                        : current.draft.indexes;
                const renamedConstraints =
                    columnId === "name"
                        ? current.draft.constraints.map((constraint) => ({
                              ...constraint,
                              columns: replaceColumnNameInColumnList(
                                  constraint.columns,
                                  previousName,
                                  nextName,
                              ),
                          }))
                        : current.draft.constraints;
                const constraints =
                    columnId === "isPrimaryKey"
                        ? syncPrimaryKeyConstraintFromColumns(renamedConstraints, columns)
                        : renamedConstraints;

                return {
                    draft: {
                        ...current.draft,
                        columns,
                        indexes: renamedIndexes,
                        constraints,
                    },
                };
            });
        },
        [patchTableDesignState, tabId],
    );

    const updateIndexDraft = useCallback(
        (rowIndex: number, columnId: string, value: unknown) => {
            patchTableDesignState(tabId, (current) => {
                const indexes = current.draft.indexes.map((index, draftIndex) => {
                    if (draftIndex !== rowIndex) return index;

                    if (columnId === "name") return { ...index, name: String(value) };
                    if (columnId === "columns") return { ...index, columns: String(value) };
                    if (columnId === "isUnique") return { ...index, isUnique: Boolean(value) };
                    if (columnId === "method") return { ...index, method: String(value) };
                    if (columnId === "comment") return { ...index, comment: String(value) };
                    return index;
                });

                return {
                    draft: {
                        ...current.draft,
                        indexes,
                    },
                };
            });
        },
        [patchTableDesignState, tabId],
    );

    const updateConstraintDraft = useCallback(
        (rowIndex: number, columnId: string, value: unknown) => {
            patchTableDesignState(tabId, (current) => {
                const constraints = current.draft.constraints.map((constraint, draftIndex) => {
                    if (draftIndex !== rowIndex) return constraint;

                    if (columnId === "name") return { ...constraint, name: String(value) };
                    if (columnId === "kind") return { ...constraint, kind: String(value) as TableConstraintDraft["kind"] };
                    if (columnId === "columns") return { ...constraint, columns: String(value) };
                    if (columnId === "reference") return { ...constraint, reference: String(value) };
                    if (columnId === "expression") return { ...constraint, expression: String(value) };
                    if (columnId === "comment") return { ...constraint, comment: String(value) };
                    return constraint;
                });

                return {
                    draft: {
                        ...current.draft,
                        constraints,
                    },
                };
            });
        },
        [patchTableDesignState, tabId],
    );

    const patchColumnDraft = useCallback(
        (rowIndex: number, patch: Partial<TableColumnDraft>) => {
            patchTableDesignState(tabId, (current) => {
                const previousColumn = current.draft.columns[rowIndex];
                const previousName = previousColumn?.name ?? "";
                const patchedColumns = current.draft.columns.map((column, index) => {
                    if (index !== rowIndex) return column;
                    const patchedColumn = { ...column, ...patch };
                    return normalizeColumnDraftType(patchedColumn, profile);
                });
                const nextName = patchedColumns[rowIndex]?.name ?? previousName;
                const renamedIndexes =
                    patch.name != null
                        ? current.draft.indexes.map((index) => ({
                              ...index,
                              columns: replaceColumnNameInColumnList(
                                  index.columns,
                                  previousName,
                                  nextName,
                              ),
                          }))
                        : current.draft.indexes;
                const renamedConstraints =
                    patch.name != null
                        ? current.draft.constraints.map((constraint) => ({
                              ...constraint,
                              columns: replaceColumnNameInColumnList(
                                  constraint.columns,
                                  previousName,
                                  nextName,
                              ),
                          }))
                        : current.draft.constraints;
                const constraints =
                    patch.isPrimaryKey != null
                        ? syncPrimaryKeyConstraintFromColumns(renamedConstraints, patchedColumns)
                        : renamedConstraints;

                return {
                    draft: {
                        ...current.draft,
                        columns: patchedColumns,
                        indexes: renamedIndexes,
                        constraints,
                    },
                };
            });
        },
        [patchTableDesignState, profile, tabId],
    );

    const patchIndexDraft = useCallback(
        (rowIndex: number, patch: Partial<TableIndexDraft>) => {
            patchTableDesignState(tabId, (current) => ({
                draft: {
                    ...current.draft,
                    indexes: current.draft.indexes.map((index, draftIndex) =>
                        draftIndex === rowIndex ? { ...index, ...patch } : index,
                    ),
                },
            }));
        },
        [patchTableDesignState, tabId],
    );

    const patchConstraintDraft = useCallback(
        (rowIndex: number, patch: Partial<TableConstraintDraft>) => {
            patchTableDesignState(tabId, (current) => ({
                draft: {
                    ...current.draft,
                    constraints: current.draft.constraints.map((constraint, index) =>
                        index === rowIndex ? { ...constraint, ...patch } : constraint,
                    ),
                },
            }));
        },
        [patchTableDesignState, tabId],
    );

    const handleDeleteColumns = useCallback(
        (selectedRowIndexes: number[]) => {
            if (selectedRowIndexes.length === 0) return;
            patchTableDesignState(tabId, (current) => ({
                draft: {
                    ...current.draft,
                    columns: current.draft.columns.filter((_, index) => !selectedRowIndexes.includes(index)),
                },
            }));
        },
        [patchTableDesignState, tabId],
    );

    const handleDeleteIndexes = useCallback(
        (selectedRowIndexes: number[]) => {
            if (selectedRowIndexes.length === 0) return;
            patchTableDesignState(tabId, (current) => ({
                draft: {
                    ...current.draft,
                    indexes: current.draft.indexes.filter((_, index) => !selectedRowIndexes.includes(index)),
                },
            }));
        },
        [patchTableDesignState, tabId],
    );

    const handleDeleteConstraints = useCallback(
        (selectedRowIndexes: number[]) => {
            if (selectedRowIndexes.length === 0) return;
            patchTableDesignState(tabId, (current) => ({
                draft: {
                    ...current.draft,
                    constraints: current.draft.constraints.filter((_, index) => !selectedRowIndexes.includes(index)),
                },
            }));
        },
        [patchTableDesignState, tabId],
    );

    const handleMoveColumns = useCallback(
        (selectedRowIndexes: number[], direction: -1 | 1) => {
            patchTableDesignState(tabId, (current) => ({
                draft: {
                    ...current.draft,
                    columns: moveDraftRows(current.draft.columns, selectedRowIndexes, direction),
                },
            }));
        },
        [patchTableDesignState, tabId],
    );

    const handleMoveIndexes = useCallback(
        (selectedRowIndexes: number[], direction: -1 | 1) => {
            patchTableDesignState(tabId, (current) => ({
                draft: {
                    ...current.draft,
                    indexes: moveDraftRows(current.draft.indexes, selectedRowIndexes, direction),
                },
            }));
        },
        [patchTableDesignState, tabId],
    );

    const handleMoveConstraints = useCallback(
        (selectedRowIndexes: number[], direction: -1 | 1) => {
            patchTableDesignState(tabId, (current) => ({
                draft: {
                    ...current.draft,
                    constraints: moveDraftRows(
                        current.draft.constraints,
                        selectedRowIndexes,
                        direction,
                    ),
                },
            }));
        },
        [patchTableDesignState, tabId],
    );

    const handleResetDesign = useCallback(() => {
        resetTableDesignDraft(tabId);
    }, [resetTableDesignDraft, tabId]);

    const handleAddColumn = useCallback(() => {
        patchTableDesignState(tabId, (current) => ({
            draft: {
                ...current.draft,
                columns: [...current.draft.columns, createColumnDraft(profile)],
            },
        }));
    }, [patchTableDesignState, profile, tabId]);

    const handleAddIndex = useCallback(() => {
        patchTableDesignState(tabId, (current) => ({
            draft: {
                ...current.draft,
                indexes: [...current.draft.indexes, createIndexDraft()],
            },
        }));
    }, [patchTableDesignState, tabId]);

    const handleAddConstraint = useCallback(() => {
        patchTableDesignState(tabId, (current) => ({
            draft: {
                ...current.draft,
                constraints: [...current.draft.constraints, createConstraintDraft()],
            },
        }));
    }, [patchTableDesignState, tabId]);

    return {
        updateBasicsField,
        updateColumnDraft,
        updateIndexDraft,
        updateConstraintDraft,
        patchColumnDraft,
        patchIndexDraft,
        patchConstraintDraft,
        handleDeleteColumns,
        handleDeleteIndexes,
        handleDeleteConstraints,
        handleMoveColumns,
        handleMoveIndexes,
        handleMoveConstraints,
        handleResetDesign,
        handleAddColumn,
        handleAddIndex,
        handleAddConstraint,
    };
}
