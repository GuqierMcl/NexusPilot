import { useCallback, useMemo } from "react";

import type {
    QueryResult,
    TableRowKey,
    TableRowLocator,
} from "@/types/ipc";
import type { TableDataChangeSet } from "@/store";

import {
    fallbackRowUpdateId,
    rowKeyHasCompleteValues,
    rowLocatorToId,
} from "./table-data-utils";
import type { TableDataChangeSetSetter } from "./useTableDataRuntimeState";

interface UseTableDataRowsParams {
    data?: QueryResult;
    page: number;
    canMutate: boolean;
    canInsertRows: boolean;
    selectedRowIndexes: number[];
    changeSet: TableDataChangeSet;
    setChangeSet: TableDataChangeSetSetter;
}

export function useTableDataRows({
    data,
    page,
    canMutate,
    canInsertRows,
    selectedRowIndexes,
    changeSet,
    setChangeSet,
}: UseTableDataRowsParams) {
    const columnIndexByName = useMemo(() => {
        const index = new Map<string, number>();
        data?.columns.forEach((column, columnIndex) => {
            index.set(column.name, columnIndex);
        });
        return index;
    }, [data?.columns]);

    const buildRowLocator = useCallback(
        (rowData: unknown[]): TableRowLocator | null => {
            if (!data || !canMutate) return null;

            if (data.rowLocatorStrategy === "primaryKey") {
                const primaryKey: TableRowKey = [];
                for (const columnName of data.primaryKeyColumns) {
                    const columnIndex = columnIndexByName.get(columnName);
                    if (columnIndex === undefined) return null;
                    primaryKey.push({
                        column: columnName,
                        value: rowData[columnIndex],
                    });
                }
                return rowKeyHasCompleteValues(primaryKey)
                    ? { kind: "primaryKey", parts: primaryKey }
                    : null;
            }

            if (data.rowLocatorStrategy !== "rowSnapshot") return null;
            const snapshotParts: TableRowKey = [];
            for (const column of data.columns) {
                if (["binary", "structured", "unknown"].includes(column.dataCategory)) {
                    continue;
                }
                const columnIndex = columnIndexByName.get(column.name);
                if (columnIndex === undefined) return null;
                snapshotParts.push({
                    column: column.name,
                    value: rowData[columnIndex],
                });
            }
            return snapshotParts.length > 0
                ? {
                      kind: "rowSnapshot",
                      parts: snapshotParts,
                      expectedMatches: 1,
                  }
                : null;
        },
        [canMutate, columnIndexByName, data],
    );

    const rowKeyByIndex = useMemo(() => {
        const map = new Map<number, string>();
        if (!data) return map;

        const entries = data.rows.flatMap((row, rowIndex) => {
            const locator = buildRowLocator(row);
            return locator ? [[rowIndex, rowLocatorToId(locator)] as const] : [];
        });
        const rowIdCounts = entries.reduce((counts, [, rowId]) => {
            counts.set(rowId, (counts.get(rowId) ?? 0) + 1);
            return counts;
        }, new Map<string, number>());

        entries.forEach(([rowIndex, rowId]) => {
            if (rowIdCounts.get(rowId) === 1) {
                map.set(rowIndex, rowId);
            }
        });
        return map;
    }, [buildRowLocator, data]);

    const editableRowIdByIndex = useMemo(() => {
        const map = new Map<number, string>();
        if (!data) return map;

        data.rows.forEach((_, rowIndex) => {
            map.set(rowIndex, rowKeyByIndex.get(rowIndex) ?? fallbackRowUpdateId(page, rowIndex));
        });
        return map;
    }, [data, page, rowKeyByIndex]);

    const rowLocatorsForIndexes = useCallback(
        (rowIndexes: number[]): TableRowLocator[] => {
            if (!data) return [];
            return rowIndexes
                .filter((rowIndex) => rowKeyByIndex.has(rowIndex))
                .map((rowIndex) => data.rows[rowIndex])
                .filter((row): row is unknown[] => Array.isArray(row))
                .map((row) => buildRowLocator(row))
                .filter((locator): locator is TableRowLocator => locator != null);
        },
        [buildRowLocator, data, rowKeyByIndex],
    );

    const draftInserts = useMemo(
        () => Object.values(changeSet.inserts),
        [changeSet.inserts],
    );

    const draftRowIndexes = useMemo(
        () => draftInserts.map((_, index) => (data?.rows.length ?? 0) + index),
        [data?.rows.length, draftInserts],
    );

    const draftRowIndexSet = useMemo(
        () => new Set(draftRowIndexes),
        [draftRowIndexes],
    );

    const getDraftInsertByRowIndex = useCallback(
        (rowIndex: number) => {
            if (!data || rowIndex < data.rows.length) return null;
            return draftInserts[rowIndex - data.rows.length] ?? null;
        },
        [data, draftInserts],
    );

    const pruneEmptyDraftRows = useCallback(
        (exceptDraftId?: string) => {
            setChangeSet((current) => {
                const nextInserts = Object.fromEntries(
                    Object.entries(current.inserts).filter(([, insert]) => {
                        if (insert.draftId === exceptDraftId) return true;
                        return Object.keys(insert.values).length > 0;
                    }),
                );

                if (
                    Object.keys(nextInserts).length ===
                    Object.keys(current.inserts).length
                ) {
                    return current;
                }

                return {
                    inserts: nextInserts,
                    updates: current.updates,
                    deletes: current.deletes,
                };
            });
        },
        [setChangeSet],
    );

    const isCellEditable = useCallback(
        (rowIndex: number, columnId: string, _value?: unknown) => {
            if (!data || rowIndex < 0) return false;
            const column = data.columns.find((item) => item.name === columnId);
            if (!column) return false;
            const draftInsert = getDraftInsertByRowIndex(rowIndex);
            if (draftInsert) {
                return canInsertRows && column.isWritable;
            }

            if (rowIndex >= data.rows.length) return false;
            if (!canMutate || !column.isWritable || !rowKeyByIndex.has(rowIndex)) {
                return false;
            }
            const rowId = editableRowIdByIndex.get(rowIndex);
            if (rowId && rowId in changeSet.deletes) return false;
            return true;
        },
        [
            canInsertRows,
            canMutate,
            changeSet.deletes,
            data,
            editableRowIdByIndex,
            getDraftInsertByRowIndex,
            rowKeyByIndex,
        ],
    );

    const pendingDeleteRowIndexes = useMemo(
        () =>
            Array.from(rowKeyByIndex.entries())
                .filter(([, rowId]) => rowId in changeSet.deletes)
                .map(([rowIndex]) => rowIndex),
        [changeSet.deletes, rowKeyByIndex],
    );

    const dirtyCells = useMemo(
        () =>
            Array.from(editableRowIdByIndex.entries()).flatMap(([rowIndex, rowId]) => {
                if (rowId in changeSet.deletes) return [];
                const update = changeSet.updates[rowId];
                if (!update) return [];
                return Object.keys(update.changes).map((columnId) => ({
                    rowIndex,
                    columnId,
                }));
            }).concat(
                draftInserts.flatMap((insert, draftIndex) =>
                    Object.keys(insert.values).map((columnId) => ({
                        rowIndex: (data?.rows.length ?? 0) + draftIndex,
                        columnId,
                    })),
                ),
            ),
        [
            changeSet.deletes,
            changeSet.updates,
            data?.rows.length,
            draftInserts,
            editableRowIdByIndex,
        ],
    );

    const overlayRows = useMemo(() => {
        if (!data) return [];

        const rows = data.rows.map((row, rowIndex) => {
            const rowId = editableRowIdByIndex.get(rowIndex);
            const update = rowId ? changeSet.updates[rowId] : undefined;
            if (!update) return row;

            const nextRow = [...row];
            for (const [columnName, value] of Object.entries(update.changes)) {
                const columnIndex = columnIndexByName.get(columnName);
                if (columnIndex !== undefined) {
                    nextRow[columnIndex] = value;
                }
            }
            return nextRow;
        });

        const draftRows = draftInserts.map((insert) =>
            data.columns.map((column) =>
                Object.prototype.hasOwnProperty.call(insert.values, column.name)
                    ? insert.values[column.name]
                    : null,
            ),
        );

        return rows.concat(draftRows);
    }, [changeSet.updates, columnIndexByName, data, draftInserts, editableRowIdByIndex]);

    const selectedDeletableRowIndexes = useMemo(
        () => selectedRowIndexes.filter((rowIndex) => rowKeyByIndex.has(rowIndex)),
        [rowKeyByIndex, selectedRowIndexes],
    );

    return {
        columnIndexByName,
        buildRowLocator,
        rowKeyByIndex,
        editableRowIdByIndex,
        rowLocatorsForIndexes,
        draftInserts,
        draftRowIndexes,
        draftRowIndexSet,
        getDraftInsertByRowIndex,
        pruneEmptyDraftRows,
        isCellEditable,
        pendingDeleteRowIndexes,
        dirtyCells,
        overlayRows,
        selectedDeletableRowIndexes,
    };
}
