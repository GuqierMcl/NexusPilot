import { useCallback } from "react";
import type React from "react";
import { toast } from "@/components/ui/toast";

import {
    formatJsonSafeInteger,
    parseRequestedU32Page,
} from "@/lib/json-safe-integer";
import type {
    QueryResult,
    TablePageStats,
    TableRowLocator,
} from "@/types/ipc";
import type { DataTableContextMenuTarget } from "@/components/data-table";
import {
    EMPTY_TABLE_DATA_CHANGE_SET,
    type TableDataChangeSet,
    type TableDataRuntimeState,
} from "@/store";

import {
    coerceEditedValue,
    createDraftId,
    rowLocatorToId,
    rowsToClipboardText,
    valueToClipboardText,
} from "./table-data-utils";
import {
    resolveLastPageTarget,
    validateRequestedPageAgainstTotal,
} from "./table-pagination-utils";
import type {
    PatchTableDataState,
    TableDataChangeSetSetter,
} from "./useTableDataRuntimeState";

type ScrollToRowRequest = {
    rowIndex: number;
    signal: number;
} | null;

interface UseTableDataEditingParams {
    tabId: string;
    data?: QueryResult;
    page: number;
    pageInputValue: string;
    changeSet: TableDataChangeSet;
    hasDirtyChanges: boolean;
    editingCell: TableDataRuntimeState["editingCell"];
    pendingDeleteKeys: TableRowLocator[] | null;
    selectedRowIndexes: number[];
    selectedDeletableRowIndexes: number[];
    canInsertRows: boolean;
    isTableBusy: boolean;
    isSavePending: boolean;
    skipNextPageInputBlurRef: React.MutableRefObject<boolean>;
    patchTableDataState: PatchTableDataState;
    resetTableDataTransientState: (tabId: string) => void;
    setChangeSet: TableDataChangeSetSetter;
    setSelectedRowIndexes: (next: number[] | ((current: number[]) => number[])) => void;
    setCurrentRowIndex: (currentRowIndex: number | null) => void;
    setSelectedCell: (selectedCell: TableDataRuntimeState["selectedCell"]) => void;
    setEditingCell: (editingCell: TableDataRuntimeState["editingCell"]) => void;
    setPendingDeleteKeys: (pendingDeleteKeys: TableRowLocator[] | null) => void;
    setPendingRefreshDiscard: (pendingRefreshDiscard: boolean) => void;
    setPageInputEditing: (nextIsEditing: boolean, nextValue?: string) => void;
    setScrollToRowRequest: React.Dispatch<React.SetStateAction<ScrollToRowRequest>>;
    ensurePageStats: (requestedPage?: number) => Promise<TablePageStats>;
    invalidatePageStats: () => void;
    refetch: () => unknown;
    buildRowLocator: (rowData: unknown[]) => TableRowLocator | null;
    rowLocatorsForIndexes: (rowIndexes: number[]) => TableRowLocator[];
    getDraftInsertByRowIndex: (rowIndex: number) => { draftId: string } | null;
    pruneEmptyDraftRows: (exceptDraftId?: string) => void;
    isCellEditable: (rowIndex: number, columnId: string, value?: unknown) => boolean;
    editableRowIdByIndex: Map<number, string>;
    columnIndexByName: Map<string, number>;
    overlayRows: unknown[][];
}

export function useTableDataEditing({
    tabId,
    data,
    page,
    pageInputValue,
    changeSet,
    hasDirtyChanges,
    editingCell,
    pendingDeleteKeys,
    selectedRowIndexes,
    selectedDeletableRowIndexes,
    canInsertRows,
    isTableBusy,
    isSavePending,
    skipNextPageInputBlurRef,
    patchTableDataState,
    resetTableDataTransientState,
    setChangeSet,
    setSelectedRowIndexes,
    setCurrentRowIndex,
    setSelectedCell,
    setEditingCell,
    setPendingDeleteKeys,
    setPendingRefreshDiscard,
    setPageInputEditing,
    setScrollToRowRequest,
    ensurePageStats,
    invalidatePageStats,
    refetch,
    buildRowLocator,
    rowLocatorsForIndexes,
    getDraftInsertByRowIndex,
    pruneEmptyDraftRows,
    isCellEditable,
    editableRowIdByIndex,
    columnIndexByName,
    overlayRows,
}: UseTableDataEditingParams) {
    const goToPage = useCallback(
        (nextPage: number) => {
            pruneEmptyDraftRows();
            patchTableDataState(tabId, {
                page: Math.max(1, nextPage),
                selectedRowIndexes: [],
                currentRowIndex: null,
                selectedCell: null,
                editingCell: null,
                pendingDeleteKeys: null,
                pendingRefreshDiscard: false,
                isPageInputEditing: false,
                pageInputValue: String(Math.max(1, nextPage)),
            });
        },
        [patchTableDataState, pruneEmptyDraftRows, tabId],
    );

    const handleFirstPage = useCallback(() => {
        if (page <= 1) return;
        goToPage(1);
    }, [goToPage, page]);

    const handlePrevPage = useCallback(() => {
        if (page <= 1) return;
        goToPage(page - 1);
    }, [goToPage, page]);

    const handleNextPage = useCallback(() => {
        if (data?.hasNextPage) {
            goToPage(page + 1);
        }
    }, [data?.hasNextPage, goToPage, page]);

    const handleLastPage = useCallback(() => {
        void ensurePageStats()
            .then((stats) => {
                const target = resolveLastPageTarget(stats.totalPages);
                if (target == null) {
                    toast.error("总页数超出可直接跳转范围");
                    return;
                }
                goToPage(target);
            })
            .catch((error) => {
                console.error("Failed to jump to last table page", error);
                toast.error("无法获取最后一页");
            });
    }, [ensurePageStats, goToPage]);

    const beginPageInput = useCallback(() => {
        skipNextPageInputBlurRef.current = false;
        setPageInputEditing(true, String(page));
    }, [page, setPageInputEditing, skipNextPageInputBlurRef]);

    const cancelPageInput = useCallback(() => {
        skipNextPageInputBlurRef.current = true;
        setPageInputEditing(false, String(page));
    }, [page, setPageInputEditing, skipNextPageInputBlurRef]);

    const commitPageInput = useCallback(() => {
        const normalizedInput = pageInputValue.trim();
        const requestedPage = parseRequestedU32Page(normalizedInput);
        if (requestedPage == null) {
            toast.error("请输入 1 到 4294967295 之间的整数页码");
            cancelPageInput();
            return;
        }

        void ensurePageStats(requestedPage)
            .then((stats) => {
                const validatedPage = validateRequestedPageAgainstTotal(
                    normalizedInput,
                    stats.totalPages,
                );
                if (validatedPage == null) {
                    toast.error(
                        `请输入 1 到 ${formatJsonSafeInteger(stats.totalPages)} 之间的页码`,
                    );
                    cancelPageInput();
                    return;
                }
                goToPage(validatedPage);
            })
            .catch((error) => {
                console.error("Failed to jump to table page", error);
                toast.error("页码无效或无法获取分页统计");
                cancelPageInput();
            });
    }, [cancelPageInput, ensurePageStats, goToPage, pageInputValue]);

    const handlePageInputKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLInputElement>) => {
            if (event.key === "Enter") {
                event.preventDefault();
                skipNextPageInputBlurRef.current = true;
                commitPageInput();
            }
            if (event.key === "Escape") {
                event.preventDefault();
                cancelPageInput();
            }
        },
        [cancelPageInput, commitPageInput, skipNextPageInputBlurRef],
    );

    const clearTransientState = useCallback(() => {
        resetTableDataTransientState(tabId);
    }, [resetTableDataTransientState, tabId]);

    const revertChanges = useCallback(() => {
        setChangeSet(EMPTY_TABLE_DATA_CHANGE_SET);
        invalidatePageStats();
        clearTransientState();
    }, [clearTransientState, invalidatePageStats, setChangeSet]);

    const performRefresh = useCallback(() => {
        setChangeSet(EMPTY_TABLE_DATA_CHANGE_SET);
        invalidatePageStats();
        clearTransientState();
        void refetch();
    }, [clearTransientState, invalidatePageStats, refetch, setChangeSet]);

    const handleRefresh = useCallback(() => {
        if (hasDirtyChanges) {
            setPendingRefreshDiscard(true);
            return;
        }
        performRefresh();
    }, [hasDirtyChanges, performRefresh, setPendingRefreshDiscard]);

    const handleRootPointerDownCapture = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            const target = event.target as HTMLElement | null;
            const isDataTableCellTarget = target?.closest(
                '[data-slot="data-table-cell"], [data-slot="data-table-row-number-cell"]',
            );
            if (!isDataTableCellTarget) {
                pruneEmptyDraftRows();
            }
        },
        [pruneEmptyDraftRows],
    );

    const handleRowSelect = useCallback(
        (rowIndex: number, _rowData: unknown[], event: React.MouseEvent) => {
            pruneEmptyDraftRows();
            setEditingCell(null);
            setCurrentRowIndex(rowIndex);
            setSelectedCell(null);
            setSelectedRowIndexes((current) => {
                if (event.ctrlKey || event.metaKey) {
                    return current.includes(rowIndex)
                        ? current.filter((index) => index !== rowIndex)
                        : [...current, rowIndex].sort((a, b) => a - b);
                }
                return [rowIndex];
            });
        },
        [pruneEmptyDraftRows, setCurrentRowIndex, setEditingCell, setSelectedCell, setSelectedRowIndexes],
    );

    const handleRowContextMenu = useCallback((target: DataTableContextMenuTarget) => {
        const targetDraft =
            target.kind === "cell" ? getDraftInsertByRowIndex(target.rowIndex) : null;
        pruneEmptyDraftRows(targetDraft?.draftId);
        setEditingCell(null);
        setCurrentRowIndex(target.rowIndex);

        if (target.kind === "cell") {
            setSelectedCell({
                rowIndex: target.rowIndex,
                columnId: target.columnId,
            });
            setSelectedRowIndexes((current) =>
                current.includes(target.rowIndex) ? current : [],
            );
            return;
        }

        setSelectedCell(null);
        setSelectedRowIndexes((current) =>
            current.includes(target.rowIndex) ? current : [target.rowIndex],
        );
    }, [
        getDraftInsertByRowIndex,
        pruneEmptyDraftRows,
        setCurrentRowIndex,
        setEditingCell,
        setSelectedCell,
        setSelectedRowIndexes,
    ]);

    const handleCellSelect = useCallback(
        (rowIndex: number, columnId: string, value: unknown) => {
            const targetDraft = getDraftInsertByRowIndex(rowIndex);
            pruneEmptyDraftRows(targetDraft?.draftId);
            setCurrentRowIndex(rowIndex);
            setSelectedCell({ rowIndex, columnId });
            setSelectedRowIndexes((current) =>
                current.includes(rowIndex) ? current : [],
            );

            if (
                !isSavePending &&
                isCellEditable(rowIndex, columnId, value)
            ) {
                setEditingCell({ rowIndex, columnId, value });
            } else {
                setEditingCell(null);
            }
        },
        [
            getDraftInsertByRowIndex,
            isCellEditable,
            isSavePending,
            pruneEmptyDraftRows,
            setCurrentRowIndex,
            setEditingCell,
            setSelectedCell,
            setSelectedRowIndexes,
        ],
    );

    const openDeleteConfirmForIndexes = useCallback(
        (targetIndexes: number[]) => {
            const locators = rowLocatorsForIndexes(targetIndexes);
            if (locators.length === 0) return;
            setPendingDeleteKeys(locators);
        },
        [rowLocatorsForIndexes, setPendingDeleteKeys],
    );

    const openDeleteConfirm = useCallback(
        (rowIndex: number) => {
            openDeleteConfirmForIndexes(
                selectedRowIndexes.includes(rowIndex)
                    ? selectedRowIndexes
                    : [rowIndex],
            );
        },
        [openDeleteConfirmForIndexes, selectedRowIndexes],
    );

    const openSelectedRowsDeleteConfirm = useCallback(() => {
        if (selectedDeletableRowIndexes.length === 0) return;
        openDeleteConfirmForIndexes(selectedDeletableRowIndexes);
    }, [openDeleteConfirmForIndexes, selectedDeletableRowIndexes]);

    const addCellChange = useCallback(
        (rowIndex: number, columnId: string, nextValue: unknown) => {
            if (!data) return;
            const draftInsert = getDraftInsertByRowIndex(rowIndex);
            if (draftInsert) {
                if (!canInsertRows) return;
                const column = data.columns.find((item) => item.name === columnId);
                if (!column) return;

                setChangeSet((current) => {
                    const existing = current.inserts[draftInsert.draftId];
                    if (!existing) return current;

                    return {
                        inserts: {
                            ...current.inserts,
                            [draftInsert.draftId]: {
                                ...existing,
                                values: {
                                    ...existing.values,
                                    [columnId]: nextValue,
                                },
                            },
                        },
                        updates: current.updates,
                        deletes: current.deletes,
                    };
                });
                setEditingCell(null);
                return;
            }

            const rowData = data.rows[rowIndex];
            if (!rowData) return;
            const locator = buildRowLocator(rowData);
            if (!locator) return;
            const rowId = editableRowIdByIndex.get(rowIndex);
            if (!rowId) return;
            if (rowId in changeSet.deletes) return;

            const column = data.columns.find((item) => item.name === columnId);
            if (!column) return;

            const originalColumnIndex = columnIndexByName.get(columnId);
            const originalValue =
                originalColumnIndex === undefined ? undefined : rowData[originalColumnIndex];

            setChangeSet((current) => {
                const existing = current.updates[rowId];
                const nextChanges = { ...(existing?.changes ?? {}) };

                if (Object.is(originalValue, nextValue)) {
                    delete nextChanges[columnId];
                } else {
                    nextChanges[columnId] = nextValue;
                }

                const nextUpdates = { ...current.updates };
                if (Object.keys(nextChanges).length === 0) {
                    delete nextUpdates[rowId];
                } else {
                    nextUpdates[rowId] = {
                        locator,
                        changes: nextChanges,
                    };
                }

                return {
                    inserts: current.inserts,
                    updates: nextUpdates,
                    deletes: current.deletes,
                };
            });
            setEditingCell(null);
        },
        [
            buildRowLocator,
            canInsertRows,
            changeSet.deletes,
            columnIndexByName,
            data,
            editableRowIdByIndex,
            getDraftInsertByRowIndex,
            setChangeSet,
            setEditingCell,
        ],
    );

    const markRowsForDelete = useCallback((locators: TableRowLocator[]) => {
        if (locators.length === 0) return;

        setChangeSet((current) => {
            const nextDeletes = { ...current.deletes };
            const nextUpdates = { ...current.updates };

            for (const locator of locators) {
                const rowId = rowLocatorToId(locator);
                nextDeletes[rowId] = locator;
                delete nextUpdates[rowId];
            }

            return {
                inserts: current.inserts,
                updates: nextUpdates,
                deletes: nextDeletes,
            };
        });
        setPendingDeleteKeys(null);
        setSelectedRowIndexes([]);
        setSelectedCell(null);
        setEditingCell(null);
        toast.info(`已标记 ${locators.length} 行为待删除`);
    }, [
        setChangeSet,
        setEditingCell,
        setPendingDeleteKeys,
        setSelectedCell,
        setSelectedRowIndexes,
    ]);

    const copyToClipboard = useCallback(async (text: string, successMessage: string) => {
        if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
            toast.error("当前环境不支持剪贴板");
            return;
        }

        try {
            await navigator.clipboard.writeText(text);
            toast.success(successMessage);
        } catch (error) {
            console.error("Failed to copy DataTable content", error);
            toast.error("复制失败");
        }
    }, []);

    const copyRowsForIndexes = useCallback(
        async (rowIndexes: number[]) => {
            const rows = rowIndexes
                .map((rowIndex) => overlayRows[rowIndex])
                .filter((row): row is unknown[] => Array.isArray(row));
            if (rows.length === 0) return;

            await copyToClipboard(rowsToClipboardText(rows), "已复制记录");
        },
        [copyToClipboard, overlayRows],
    );

    const copyCellValue = useCallback(
        async (value: unknown) => {
            await copyToClipboard(valueToClipboardText(value), "已复制单元格");
        },
        [copyToClipboard],
    );

    const handleCellDoubleClick = useCallback(
        (rowIndex: number, columnId: string, value: unknown) => {
            if (isSavePending || !isCellEditable(rowIndex, columnId, value)) return;
            setCurrentRowIndex(rowIndex);
            setSelectedCell({ rowIndex, columnId });
            setEditingCell({ rowIndex, columnId, value });
        },
        [
            isCellEditable,
            isSavePending,
            setCurrentRowIndex,
            setEditingCell,
            setSelectedCell,
        ],
    );

    const handleCellEditCommit = useCallback(
        (rowIndex: number, columnId: string, rawValue: unknown) => {
            if (!data || !editingCell) return;
            const column = data.columns.find((item) => item.name === columnId);
            const draftInsert = getDraftInsertByRowIndex(rowIndex);
            if (draftInsert) {
                try {
                    const nextValue = coerceEditedValue(rawValue, editingCell.value, column);
                    addCellChange(rowIndex, columnId, nextValue);
                } catch (error) {
                    toast.error(error instanceof Error ? error.message : "单元格值无效");
                }
                return;
            }

            const rowData = data.rows[rowIndex];
            if (!rowData) return;

            try {
                const nextValue = coerceEditedValue(rawValue, editingCell.value, column);
                addCellChange(rowIndex, columnId, nextValue);
            } catch (error) {
                toast.error(error instanceof Error ? error.message : "单元格值无效");
            }
        },
        [addCellChange, data, editingCell, getDraftInsertByRowIndex],
    );

    const updateCellValue = useCallback(
        (rowIndex: number, columnId: string, nextValue: unknown) => {
            if (!data) return;
            const draftInsert = getDraftInsertByRowIndex(rowIndex);
            if (draftInsert) {
                if (!isCellEditable(rowIndex, columnId, nextValue)) return;
                addCellChange(rowIndex, columnId, nextValue);
                return;
            }

            const rowData = data.rows[rowIndex];
            if (!rowData) return;
            if (!isCellEditable(rowIndex, columnId, rowData[columnIndexByName.get(columnId) ?? -1])) {
                return;
            }

            addCellChange(rowIndex, columnId, nextValue);
        },
        [
            addCellChange,
            columnIndexByName,
            data,
            getDraftInsertByRowIndex,
            isCellEditable,
        ],
    );

    const confirmDeleteRows = useCallback(() => {
        if (!pendingDeleteKeys || pendingDeleteKeys.length === 0) return;
        markRowsForDelete(pendingDeleteKeys);
    }, [markRowsForDelete, pendingDeleteKeys]);

    const handleAddDraftRow = useCallback(() => {
        if (!data || !canInsertRows || isTableBusy) return;

        const draftId = createDraftId();
        const nonEmptyDraftCount = Object.values(changeSet.inserts).filter(
            (insert) => Object.keys(insert.values).length > 0,
        ).length;
        const draftRowIndex = data.rows.length + nonEmptyDraftCount;
        const firstWritableColumn = data.columns.find((column) => column.isWritable);

        setChangeSet((current) => {
            const keptInserts = Object.fromEntries(
                Object.entries(current.inserts).filter(
                    ([, insert]) => Object.keys(insert.values).length > 0,
                ),
            );

            return {
                inserts: {
                    ...keptInserts,
                    [draftId]: {
                        draftId,
                        values: {},
                    },
                },
                updates: current.updates,
                deletes: current.deletes,
            };
        });
        setSelectedRowIndexes([]);
        setCurrentRowIndex(draftRowIndex);
        setSelectedCell(
            firstWritableColumn
                ? { rowIndex: draftRowIndex, columnId: firstWritableColumn.name }
                : null,
        );
        setEditingCell(
            firstWritableColumn
                ? { rowIndex: draftRowIndex, columnId: firstWritableColumn.name, value: null }
                : null,
        );
        setScrollToRowRequest((current) => ({
            rowIndex: draftRowIndex,
            signal: (current?.signal ?? 0) + 1,
        }));
    }, [
        canInsertRows,
        changeSet.inserts,
        data,
        isTableBusy,
        setChangeSet,
        setCurrentRowIndex,
        setEditingCell,
        setScrollToRowRequest,
        setSelectedCell,
        setSelectedRowIndexes,
    ]);

    return {
        handleFirstPage,
        handlePrevPage,
        handleNextPage,
        handleLastPage,
        beginPageInput,
        commitPageInput,
        handlePageInputKeyDown,
        clearTransientState,
        revertChanges,
        performRefresh,
        handleRefresh,
        handleRootPointerDownCapture,
        handleRowSelect,
        handleRowContextMenu,
        handleCellSelect,
        openDeleteConfirmForIndexes,
        openDeleteConfirm,
        openSelectedRowsDeleteConfirm,
        copyToClipboard,
        copyRowsForIndexes,
        copyCellValue,
        handleCellDoubleClick,
        handleCellEditCommit,
        updateCellValue,
        confirmDeleteRows,
        handleAddDraftRow,
    };
}
