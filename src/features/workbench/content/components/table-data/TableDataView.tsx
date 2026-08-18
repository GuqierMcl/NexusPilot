import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { formatIpcError } from "@/lib/ipc-error";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/query-keys";
import type { ContainerRef } from "@/types/ipc";
import { useTableData } from "@/hooks/queries/use-db-metadata";
import {
    useConnectionSessionStore,
    useWorkbenchTabsStore,
} from "@/store";
import {
    RelationalDataTable,
} from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { TriangleAlert, RefreshCw } from "lucide-react";

import {
    type TableResourceCapabilities,
    EMPTY_TABLE_BROWSE_QUERY,
    changeSetIsEmpty,
} from "./table-data-utils";
import { TableDataPagination } from "./TableDataPagination";
import { resolveLastPageTarget } from "./table-pagination-utils";
import { TableDataChangeDrawer } from "./TableDataChangeDrawer";
import { useTableDataRuntimeState } from "./useTableDataRuntimeState";
import { useTableDataRows } from "./useTableDataRows";
import { useTableDataMutations } from "./useTableDataMutations";
import { useTableDataTransactions } from "./useTableDataTransactions";
import { useTableDataEditing } from "./useTableDataEditing";
import { useTableDataToolbar } from "./useTableDataToolbar";
import { TableDataContextMenuContent } from "./TableDataContextMenus";
import { TableDataConfirmDialogs } from "./TableDataConfirmDialogs";

// ─── TableDataView Props ─────────────────────────────────────────────────────

export interface TableDataViewProps {
    tabId: string;
    profileId: string;
    tabRuntimeId: string;
    container: ContainerRef;
    isActive: boolean;
}

// ─── TableDataView ───────────────────────────────────────────────────────────

export function TableDataView({
    tabId,
    profileId,
    tabRuntimeId,
    container,
    isActive,
}: TableDataViewProps) {
    const [isDmlDrawerOpen, setIsDmlDrawerOpen] = useState(false);
    const [scrollToRowRequest, setScrollToRowRequest] = useState<{
        rowIndex: number;
        signal: number;
    } | null>(null);
    const skipNextPageInputBlurRef = useRef(false);
    const drawerContainerRef = useRef<HTMLDivElement | null>(null);
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
    } = useTableDataRuntimeState(tabId);
    const queryClient = useQueryClient();
    const setExecuting = useWorkbenchTabsStore((state) => state.setExecuting);
    const setDirty = useWorkbenchTabsStore((state) => state.setDirty);
    const driverCapabilities = useConnectionSessionStore(
        (state) => state.sessions[profileId]?.capabilities,
    );
    const tableName = container.table ?? "数据";
    const browseQuery = useMemo(() => EMPTY_TABLE_BROWSE_QUERY, []);
    const currentPageStatsQueryKey = useMemo(
        () =>
            JSON.stringify({
                container,
                pageSize,
                query: browseQuery,
            }),
        [browseQuery, container, pageSize],
    );
    const currentPageStats =
        pageStatsQueryKey === currentPageStatsQueryKey ? pageStats : null;

    const {
        data,
        isLoading,
        isFetching,
        isError,
        error,
        refetch,
        fetchStatus,
    } = useTableData(profileId, tabRuntimeId, container, {
        page,
        pageSize,
        query: browseQuery,
    });

    const isPaused = fetchStatus === "paused" && !data;
    const isExecuting = isFetching && fetchStatus !== "paused";

    const tableResourceCapabilities = useMemo<TableResourceCapabilities>(() => {
        const hasRowLocator = Boolean(data?.rowLocatorStrategy);
        const sourceWritable = Boolean(data?.sourceWritable);
        const hasWritableNonPrimaryColumn = Boolean(
            data?.columns.some((column) => column.isWritable && !column.isPrimaryKey),
        );

        return {
            canUpdateCells: sourceWritable && hasRowLocator && hasWritableNonPrimaryColumn,
            canDeleteRows: sourceWritable && hasRowLocator,
            canInsertRows: Boolean(data?.sourceInsertable && container.kind === "table"),
            canUseTransaction: Boolean(
                data &&
                    container.database &&
                    (sourceWritable || data.sourceInsertable),
            ),
        };
    }, [container.database, container.kind, data]);
    const canMutate = Boolean(
        driverCapabilities?.tableRowMutator && tableResourceCapabilities.canDeleteRows,
    );
    const canInsertRows = Boolean(
        driverCapabilities?.tableRowInserter && tableResourceCapabilities.canInsertRows,
    );
    const currentQueryKey = queryKeys.tableData(profileId, tabRuntimeId, container, {
        page,
        pageSize,
        query: browseQuery,
    });
    const invalidateCurrentTableData = useCallback(async () => {
        await queryClient.invalidateQueries({ queryKey: currentQueryKey });
    }, [currentQueryKey, queryClient]);

    const {
        columnIndexByName,
        buildRowLocator,
        editableRowIdByIndex,
        rowLocatorsForIndexes,
        draftRowIndexes,
        draftRowIndexSet,
        getDraftInsertByRowIndex,
        pruneEmptyDraftRows,
        isCellEditable,
        pendingDeleteRowIndexes,
        dirtyCells,
        overlayRows,
        selectedDeletableRowIndexes,
    } = useTableDataRows({
        data,
        page,
        canMutate,
        canInsertRows,
        selectedRowIndexes,
        changeSet,
        setChangeSet,
    });

    const insertRowCount = Object.keys(changeSet.inserts).length;
    const updateRowCount = Object.keys(changeSet.updates).filter(
        (rowId) => !(rowId in changeSet.deletes),
    ).length;
    const deleteRowCount = Object.keys(changeSet.deletes).length;
    const hasDirtyChanges = !changeSetIsEmpty(changeSet);
    const isInTransaction = transactionState.inTransaction;
    const isRollbackRecommended =
        isInTransaction && transactionWarning === "rollbackRecommended";
    const lastPageTarget = currentPageStats
        ? resolveLastPageTarget(currentPageStats.totalPages)
        : null;
    const canJumpToLastPage = currentPageStats
        ? lastPageTarget != null && page < lastPageTarget
        : true;

    const {
        pageStatsMutation,
        ensurePageStats,
        saveChangesMutation,
        dmlPreviewMutation,
    } = useTableDataMutations({
        tabId,
        profileId,
        tabRuntimeId,
        container,
        pageSize,
        browseQuery,
        currentPageStatsQueryKey,
        pageStats,
        pageStatsQueryKey,
        isInTransaction,
        patchTableDataState,
        resetTableDataTransientState,
        setChangeSet,
        setTransactionWarning,
        invalidatePageStats,
        invalidateCurrentTableData,
        setIsDmlDrawerOpen,
    });

    const {
        beginTransactionMutation,
        commitTransactionMutation,
        rollbackTransactionMutation,
    } = useTableDataTransactions({
        tabId,
        profileId,
        tabRuntimeId,
        container,
        canManageTransaction: Boolean(driverCapabilities?.transactionManager),
        setTransactionState,
        setTransactionWarning,
        invalidatePageStats,
        invalidateCurrentTableData,
        setChangeSet,
        resetTableDataTransientState,
    });

    useEffect(() => {
        setExecuting(tabId, isExecuting);
    }, [isExecuting, setExecuting, tabId]);

    useEffect(() => {
        setDirty(tabId, hasDirtyChanges || isInTransaction);
    }, [hasDirtyChanges, isInTransaction, setDirty, tabId]);

    const deleteRowsTitle = useMemo(() => {
        if (!driverCapabilities?.tableRowMutator) {
            return "当前驱动不支持表行删除";
        }
        if (!tableResourceCapabilities.canDeleteRows) {
            return "当前对象不可删除：需要可写数据表和安全的行定位信息";
        }
        if (selectedDeletableRowIndexes.length === 0) {
            return "请先选择需要删除的行";
        }
        return `标记选中的 ${selectedDeletableRowIndexes.length} 行为待删除`;
    }, [
        driverCapabilities?.tableRowMutator,
        selectedDeletableRowIndexes.length,
        tableResourceCapabilities.canDeleteRows,
    ]);

    const isTransactionBusy =
        beginTransactionMutation.isPending ||
        commitTransactionMutation.isPending ||
        rollbackTransactionMutation.isPending;
    const isTableBusy =
        isFetching ||
        saveChangesMutation.isPending ||
        isTransactionBusy;
    const dmlPreview = dmlPreviewMutation.data;

    const {
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
    } = useTableDataEditing({
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
        isSavePending: saveChangesMutation.isPending,
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
    });

    const { dirtySummary, handlePreviewDml } = useTableDataToolbar({
        tabId,
        container,
        changeSet,
        insertRowCount,
        updateRowCount,
        deleteRowCount,
        hasDirtyChanges,
        canBrowseData: Boolean(driverCapabilities?.dataTableBrowser),
        canCreateDraftRow: Boolean(
            driverCapabilities?.tableRowInserter &&
            tableResourceCapabilities.canInsertRows,
        ),
        canDeleteSelectedRows: Boolean(
            driverCapabilities?.tableRowMutator &&
            tableResourceCapabilities.canDeleteRows &&
            selectedDeletableRowIndexes.length > 0,
        ),
        canManageTransaction: Boolean(driverCapabilities?.transactionManager),
        canUseTransaction: tableResourceCapabilities.canUseTransaction,
        deleteRowsTitle,
        isFetching,
        isInTransaction,
        isRollbackRecommended,
        isTableBusy,
        isTransactionBusy,
        saveChangesMutation,
        dmlPreviewMutation,
        beginTransactionMutation,
        commitTransactionMutation,
        rollbackTransactionMutation,
        setChangeSet,
        clearTransientState,
        revertChanges,
        handleRefresh,
        handleAddDraftRow,
        openSelectedRowsDeleteConfirm,
    });

    if (isLoading && !data) {
        return (
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Spinner className="size-4" />
                加载数据中...
            </div>
        );
    }

    if (isPaused) {
        return (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
                <p className="text-sm text-muted-foreground">
                    连接已断开，请重新连接后查看数据
                </p>
            </div>
        );
    }

    if (isError) {
        return (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
                <p className="text-sm text-destructive">
                    加载失败：{formatIpcError(error)}
                </p>
                <Button variant="outline" size="sm" onClick={handleRefresh}>
                    <RefreshCw className="mr-1 size-3.5" />
                    重试
                </Button>
            </div>
        );
    }

    return (
        <>
            <div
                className={cn(
                    "flex h-full flex-col border border-transparent",
                    isInTransaction &&
                        "border-sky-400/80 shadow-[inset_0_0_0_1px_rgba(56,189,248,0.35)]",
                    isRollbackRecommended &&
                        "border-amber-500/90 shadow-[inset_0_0_0_1px_rgba(245,158,11,0.45)]",
                )}
                onPointerDownCapture={handleRootPointerDownCapture}
            >
                {/* 数据表格 */}
                <div
                    ref={drawerContainerRef}
                    className="relative flex min-h-0 flex-1 overflow-hidden"
                >
                    <RelationalDataTable
                        isActive={isActive}
                        columns={data?.columns}
                        rows={overlayRows}
                        rowHeight={32}
                        rowNumberOffset={(page - 1) * pageSize}
                        scrollToRowIndex={scrollToRowRequest?.rowIndex ?? null}
                        scrollToRowSignal={scrollToRowRequest?.signal}
                        emptyMessage={`「${tableName}」暂无数据`}
                        selectedRowIndexes={selectedRowIndexes}
                        currentRowIndex={currentRowIndex}
                        pendingDeleteRowIndexes={pendingDeleteRowIndexes}
                        draftRowIndexes={draftRowIndexes}
                        dirtyCells={dirtyCells}
                        selectedCell={selectedCell}
                        onRowSelect={handleRowSelect}
                        onRowContextMenu={handleRowContextMenu}
                        renderRowContextMenu={(target) =>
                            <TableDataContextMenuContent
                                target={target}
                                columns={data?.columns}
                                hasData={Boolean(data)}
                                selectedRowIndexes={selectedRowIndexes}
                                draftRowIndexSet={draftRowIndexSet}
                                canMutate={canMutate}
                                isSavePending={saveChangesMutation.isPending}
                                isTableBusy={isTableBusy}
                                isCellEditable={isCellEditable}
                                onOpenDeleteConfirm={openDeleteConfirm}
                                onOpenDeleteConfirmForIndexes={openDeleteConfirmForIndexes}
                                onCopyRowsForIndexes={(rowIndexes) =>
                                    void copyRowsForIndexes(rowIndexes)
                                }
                                onCopyCellValue={(value) => void copyCellValue(value)}
                                onUpdateCellValue={updateCellValue}
                                onRefresh={handleRefresh}
                            />
                        }
                        isCellEditable={isCellEditable}
                        onCellSelect={handleCellSelect}
                        onCellDoubleClick={handleCellDoubleClick}
                        editingCell={editingCell}
                        onCellEditCommit={handleCellEditCommit}
                        onCellEditCancel={() => setEditingCell(null)}
                    />
                </div>

                {isInTransaction && (
                    <div
                        className={cn(
                            "flex shrink-0 items-center gap-2 border-t px-3 py-1.5 text-xs",
                            isRollbackRecommended
                                ? "border-amber-500/30 bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
                                : "border-sky-500/25 bg-sky-50 text-sky-800 dark:bg-sky-950/30 dark:text-sky-300",
                        )}
                    >
                        <TriangleAlert className="size-3.5 shrink-0" />
                        <span className="truncate">
                            {isRollbackRecommended
                                ? "保存失败后当前事务状态不可靠，建议回滚后重试。"
                                : "事务进行中：未提交修改可能持有行锁或表锁，请及时提交或回滚。"}
                        </span>
                    </div>
                )}

                {/* 底部分页栏 */}
                <TableDataPagination
                    page={page}
                    pageSize={pageSize}
                    hasNextPage={Boolean(data?.hasNextPage)}
                    canJumpToLastPage={canJumpToLastPage}
                    isPageInputEditing={isPageInputEditing}
                    pageInputValue={pageInputValue}
                    currentPageStats={currentPageStats}
                    isInTransaction={isInTransaction}
                    isRollbackRecommended={isRollbackRecommended}
                    transactionState={transactionState}
                    hasDirtyChanges={hasDirtyChanges}
                    dirtySummary={dirtySummary}
                    rowCount={data?.rows.length ?? 0}
                    isPageStatsPending={pageStatsMutation.isPending}
                    isDmlPreviewPending={dmlPreviewMutation.isPending}
                    isSavePending={saveChangesMutation.isPending}
                    skipNextPageInputBlurRef={skipNextPageInputBlurRef}
                    onFirstPage={handleFirstPage}
                    onPrevPage={handlePrevPage}
                    onNextPage={handleNextPage}
                    onLastPage={handleLastPage}
                    onPageInputKeyDown={handlePageInputKeyDown}
                    onBeginPageInput={beginPageInput}
                    onCommitPageInput={commitPageInput}
                    onPageInputValueChange={setPageInputValue}
                    onPreviewDml={handlePreviewDml}
                />
            </div>
            <TableDataChangeDrawer
                isOpen={isDmlDrawerOpen}
                onOpenChange={setIsDmlDrawerOpen}
                containerRef={drawerContainerRef.current}
                dmlPreview={dmlPreview}
                isInTransaction={isInTransaction}
                onCopySql={(text) =>
                    void copyToClipboard(text, "已复制 DML SQL")
                }
            />
            <TableDataConfirmDialogs
                tableName={tableName}
                pendingDeleteKeys={pendingDeleteKeys}
                pendingRefreshDiscard={pendingRefreshDiscard}
                isSavePending={saveChangesMutation.isPending}
                onPendingDeleteKeysChange={setPendingDeleteKeys}
                onPendingRefreshDiscardChange={setPendingRefreshDiscard}
                onConfirmDeleteRows={confirmDeleteRows}
                onConfirmRefreshDiscard={performRefresh}
            />
        </>
    );
}
