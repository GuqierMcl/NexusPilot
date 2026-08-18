import { useCallback, useEffect, useMemo } from "react";

import type { TableRowLocator, TableTransactionState } from "@/types/ipc";
import {
    DEFAULT_TABLE_DATA_PAGE_SIZE,
    EMPTY_TABLE_DATA_CHANGE_SET,
    useTabRuntimeStateStore,
    type TableDataChangeSet,
    type TableDataRuntimeState,
} from "@/store";

export type TableDataChangeSetSetter = (
    nextChangeSet:
        | TableDataChangeSet
        | ((current: TableDataChangeSet) => TableDataChangeSet),
) => void;

export type PatchTableDataState = (
    tabId: string,
    patch:
        | Partial<TableDataRuntimeState>
        | ((current: TableDataRuntimeState) => Partial<TableDataRuntimeState>),
) => void;

function createTableDataRuntimeFallback(): TableDataRuntimeState {
    return {
        page: 1,
        pageSize: DEFAULT_TABLE_DATA_PAGE_SIZE,
        selectedRowIndexes: [],
        currentRowIndex: null,
        selectedCell: null,
        editingCell: null,
        pendingDeleteKeys: null,
        pendingRefreshDiscard: false,
        changeSet: EMPTY_TABLE_DATA_CHANGE_SET,
        transactionState: {
            inTransaction: false,
            database: null,
        },
        transactionWarning: null,
        pageStats: null,
        pageStatsQueryKey: null,
        isPageInputEditing: false,
        pageInputValue: "1",
    };
}

export function useTableDataRuntimeState(tabId: string) {
    const runtimeFallback = useMemo(createTableDataRuntimeFallback, []);
    const runtimeState =
        useTabRuntimeStateStore((state) => state.tableDataByTabId[tabId]) ??
        runtimeFallback;
    const getOrCreateTableDataState = useTabRuntimeStateStore(
        (state) => state.getOrCreateTableDataState,
    );
    const patchTableDataState = useTabRuntimeStateStore(
        (state) => state.patchTableDataState,
    );
    const setTableDataChangeSet = useTabRuntimeStateStore(
        (state) => state.setTableDataChangeSet,
    );
    const resetTableDataTransientState = useTabRuntimeStateStore(
        (state) => state.resetTableDataTransientState,
    );
    const {
        page,
        pageSize,
        selectedRowIndexes,
        currentRowIndex,
        selectedCell,
        pendingDeleteKeys,
        pendingRefreshDiscard,
        editingCell,
        changeSet,
        transactionState,
        transactionWarning,
        pageStats,
        pageStatsQueryKey,
        isPageInputEditing,
        pageInputValue,
    } = runtimeState;

    useEffect(() => {
        getOrCreateTableDataState(tabId);
    }, [getOrCreateTableDataState, tabId]);

    const setSelectedRowIndexes = useCallback(
        (next: number[] | ((current: number[]) => number[])) => {
            patchTableDataState(tabId, (current) => ({
                selectedRowIndexes:
                    typeof next === "function" ? next(current.selectedRowIndexes) : next,
            }));
        },
        [patchTableDataState, tabId],
    );

    const setCurrentRowIndex = useCallback(
        (currentRowIndex: number | null) => {
            patchTableDataState(tabId, { currentRowIndex });
        },
        [patchTableDataState, tabId],
    );

    const setSelectedCell = useCallback(
        (selectedCell: TableDataRuntimeState["selectedCell"]) => {
            patchTableDataState(tabId, { selectedCell });
        },
        [patchTableDataState, tabId],
    );

    const setEditingCell = useCallback(
        (editingCell: TableDataRuntimeState["editingCell"]) => {
            patchTableDataState(tabId, { editingCell });
        },
        [patchTableDataState, tabId],
    );

    const setPendingDeleteKeys = useCallback(
        (pendingDeleteKeys: TableRowLocator[] | null) => {
            patchTableDataState(tabId, { pendingDeleteKeys });
        },
        [patchTableDataState, tabId],
    );

    const setPendingRefreshDiscard = useCallback(
        (pendingRefreshDiscard: boolean) => {
            patchTableDataState(tabId, { pendingRefreshDiscard });
        },
        [patchTableDataState, tabId],
    );

    const setTransactionState = useCallback(
        (nextTransactionState: TableTransactionState) => {
            patchTableDataState(tabId, (current) => ({
                transactionState: nextTransactionState,
                transactionWarning: nextTransactionState.inTransaction
                    ? current.transactionWarning
                    : null,
            }));
        },
        [patchTableDataState, tabId],
    );

    const setTransactionWarning = useCallback(
        (nextTransactionWarning: TableDataRuntimeState["transactionWarning"]) => {
            patchTableDataState(tabId, {
                transactionWarning: nextTransactionWarning,
            });
        },
        [patchTableDataState, tabId],
    );

    const setPageInputEditing = useCallback(
        (nextIsEditing: boolean, nextValue = String(page)) => {
            patchTableDataState(tabId, {
                isPageInputEditing: nextIsEditing,
                pageInputValue: nextValue,
            });
        },
        [page, patchTableDataState, tabId],
    );

    const setPageInputValue = useCallback(
        (pageInputValue: string) => {
            patchTableDataState(tabId, { pageInputValue });
        },
        [patchTableDataState, tabId],
    );

    const invalidatePageStats = useCallback(() => {
        patchTableDataState(tabId, {
            pageStats: null,
            pageStatsQueryKey: null,
        });
    }, [patchTableDataState, tabId]);

    const setChangeSet = useCallback<TableDataChangeSetSetter>(
        (nextChangeSet) => {
            setTableDataChangeSet(tabId, nextChangeSet);
        },
        [setTableDataChangeSet, tabId],
    );

    return {
        runtimeState,
        page,
        pageSize,
        selectedRowIndexes,
        currentRowIndex,
        selectedCell,
        pendingDeleteKeys,
        pendingRefreshDiscard,
        editingCell,
        changeSet,
        transactionState,
        transactionWarning,
        pageStats,
        pageStatsQueryKey,
        isPageInputEditing,
        pageInputValue,
        patchTableDataState,
        resetTableDataTransientState,
        setSelectedRowIndexes,
        setCurrentRowIndex,
        setSelectedCell,
        setEditingCell,
        setPendingDeleteKeys,
        setPendingRefreshDiscard,
        setTransactionState,
        setTransactionWarning,
        setPageInputEditing,
        setPageInputValue,
        invalidatePageStats,
        setChangeSet,
    };
}
