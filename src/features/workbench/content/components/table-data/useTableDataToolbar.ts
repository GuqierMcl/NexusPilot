import { useCallback, useEffect, useMemo } from "react";
import {
    CheckCircle2,
    Clock,
    Eye,
    Layers,
    Minus,
    Plus,
    RefreshCw,
    RotateCcw,
    Save,
    Table2,
    Undo2,
} from "lucide-react";
import { toast } from "@/components/ui/toast";

import {
    useContentToolbarStore,
    type ContentToolbarAction,
    type TableDataChangeSet,
} from "@/store";
import type { ContainerRef } from "@/types/ipc";

import {
    changeSetIsEmpty,
    withoutEmptyDraftInserts,
} from "./table-data-utils";
import type { TableDataChangeSetSetter } from "./useTableDataRuntimeState";

interface ChangeSetMutation {
    isPending: boolean;
    mutate: (snapshot: TableDataChangeSet) => void;
}

interface TransactionMutation {
    isPending: boolean;
    mutate: () => void;
}

interface UseTableDataToolbarParams {
    tabId: string;
    container: ContainerRef;
    changeSet: TableDataChangeSet;
    insertRowCount: number;
    updateRowCount: number;
    deleteRowCount: number;
    hasDirtyChanges: boolean;
    canBrowseData: boolean;
    canCreateDraftRow: boolean;
    canDeleteSelectedRows: boolean;
    canManageTransaction: boolean;
    canUseTransaction: boolean;
    deleteRowsTitle: string;
    isFetching: boolean;
    isInTransaction: boolean;
    isRollbackRecommended: boolean;
    isTableBusy: boolean;
    isTransactionBusy: boolean;
    saveChangesMutation: ChangeSetMutation;
    dmlPreviewMutation: ChangeSetMutation;
    beginTransactionMutation: TransactionMutation;
    commitTransactionMutation: TransactionMutation;
    rollbackTransactionMutation: TransactionMutation;
    setChangeSet: TableDataChangeSetSetter;
    clearTransientState: () => void;
    revertChanges: () => void;
    handleRefresh: () => void;
    handleAddDraftRow: () => void;
    openSelectedRowsDeleteConfirm: () => void;
}

export function useTableDataToolbar({
    tabId,
    container,
    changeSet,
    insertRowCount,
    updateRowCount,
    deleteRowCount,
    hasDirtyChanges,
    canBrowseData,
    canCreateDraftRow,
    canDeleteSelectedRows,
    canManageTransaction,
    canUseTransaction,
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
}: UseTableDataToolbarParams) {
    const setToolbar = useContentToolbarStore((state) => state.setToolbar);
    const clearToolbar = useContentToolbarStore((state) => state.clearToolbar);

    const dirtySummary = useMemo(() => {
        if (!hasDirtyChanges) return "没有未保存更改";
        const parts = [];
        if (insertRowCount > 0) parts.push(`${insertRowCount} 行新增`);
        if (updateRowCount > 0) parts.push(`${updateRowCount} 行更新`);
        if (deleteRowCount > 0) parts.push(`${deleteRowCount} 行待删除`);
        return parts.join("，");
    }, [deleteRowCount, hasDirtyChanges, insertRowCount, updateRowCount]);

    const handleSaveChanges = useCallback(() => {
        if (!hasDirtyChanges || saveChangesMutation.isPending) return;
        const snapshot = withoutEmptyDraftInserts(changeSet);
        if (changeSetIsEmpty(snapshot)) {
            setChangeSet(snapshot);
            clearTransientState();
            return;
        }

        saveChangesMutation.mutate({
            inserts: { ...snapshot.inserts },
            updates: { ...snapshot.updates },
            deletes: { ...snapshot.deletes },
        });
    }, [
        changeSet,
        changeSet.deletes,
        changeSet.inserts,
        changeSet.updates,
        clearTransientState,
        hasDirtyChanges,
        saveChangesMutation,
        setChangeSet,
    ]);

    const handlePreviewDml = useCallback(() => {
        if (!hasDirtyChanges || dmlPreviewMutation.isPending) return;
        const snapshot = withoutEmptyDraftInserts(changeSet);
        if (changeSetIsEmpty(snapshot)) {
            setChangeSet(snapshot);
            clearTransientState();
            return;
        }

        dmlPreviewMutation.mutate(snapshot);
    }, [
        changeSet,
        changeSet.deletes,
        changeSet.inserts,
        changeSet.updates,
        clearTransientState,
        dmlPreviewMutation,
        hasDirtyChanges,
        setChangeSet,
    ]);

    const handleRevertChanges = useCallback(() => {
        if (!hasDirtyChanges || saveChangesMutation.isPending) return;
        revertChanges();
        toast.info("已撤回未保存更改");
    }, [hasDirtyChanges, revertChanges, saveChangesMutation.isPending]);

    const handleBeginTransaction = useCallback(() => {
        if (
            !canManageTransaction ||
            !canUseTransaction ||
            hasDirtyChanges ||
            isTableBusy ||
            isInTransaction
        ) {
            return;
        }

        beginTransactionMutation.mutate();
    }, [
        beginTransactionMutation,
        canManageTransaction,
        canUseTransaction,
        hasDirtyChanges,
        isInTransaction,
        isTableBusy,
    ]);

    const handleCommitTransaction = useCallback(() => {
        if (
            !isInTransaction ||
            hasDirtyChanges ||
            isTableBusy ||
            isRollbackRecommended
        ) {
            return;
        }
        commitTransactionMutation.mutate();
    }, [
        commitTransactionMutation,
        hasDirtyChanges,
        isInTransaction,
        isRollbackRecommended,
        isTableBusy,
    ]);

    const handleRollbackTransaction = useCallback(() => {
        if (!isInTransaction || isTransactionBusy || isFetching) return;
        rollbackTransactionMutation.mutate();
    }, [isFetching, isInTransaction, isTransactionBusy, rollbackTransactionMutation]);

    useEffect(() => {
        const transactionActions: ContentToolbarAction[] = isInTransaction
            ? [
                  {
                      id: "commitTransaction",
                      icon: CheckCircle2,
                      label: "提交",
                      title: isRollbackRecommended
                          ? "保存失败后当前事务状态不可靠，建议回滚后重试"
                          : hasDirtyChanges
                            ? "请先保存当前 change set，再提交事务"
                            : "提交当前标签页事务",
                      variant: "default",
                      disabled: hasDirtyChanges || isTableBusy || isRollbackRecommended,
                      onClick: handleCommitTransaction,
                  },
                  {
                      id: "rollbackTransaction",
                      icon: RotateCcw,
                      label: "回滚",
                      title: "回滚当前标签页事务",
                      variant: "default",
                      disabled: isTransactionBusy || isFetching,
                      onClick: handleRollbackTransaction,
                  },
              ]
            : [
                  {
                      id: "beginTransaction",
                      icon: Clock,
                      label: "开始事务",
                      title: !canManageTransaction
                          ? "当前驱动未声明事务管理能力"
                          : hasDirtyChanges
                            ? "请先保存或撤回未保存更改，再开始事务"
                            : canUseTransaction
                              ? "在当前标签页开启事务"
                              : "当前对象缺少可绑定事务的数据库上下文",
                      variant: "default",
                      disabled:
                          !canManageTransaction ||
                          !canUseTransaction ||
                          hasDirtyChanges ||
                          isTableBusy,
                      onClick: handleBeginTransaction,
                  },
              ];
        const actions: ContentToolbarAction[] = [
            ...transactionActions,
            {
                id: "refresh" as const,
                icon: RefreshCw,
                label: "刷新",
                title: "刷新数据",
                disabled: !canBrowseData || isTableBusy,
                onClick: handleRefresh,
            },
            {
                id: "insertRow",
                icon: Plus,
                label: "新增行",
                title: canCreateDraftRow
                    ? "在当前页底部新增草稿行"
                    : "当前对象不支持新增行",
                disabled: !canCreateDraftRow || isTableBusy,
                onClick: handleAddDraftRow,
            },
            {
                id: "deleteRows" as const,
                icon: Minus,
                label: "标记待删除",
                title: deleteRowsTitle,
                disabled: !canDeleteSelectedRows || isTableBusy,
                onClick: openSelectedRowsDeleteConfirm,
            },
            {
                id: "saveChanges",
                icon: Save,
                label: "保存更改",
                title: hasDirtyChanges
                    ? `保存未提交变更：${dirtySummary}`
                    : "没有未保存更改",
                disabled: !hasDirtyChanges || isTableBusy,
                onClick: handleSaveChanges,
            },
            {
                id: "revertChanges",
                icon: Undo2,
                label: "撤回更改",
                title: hasDirtyChanges
                    ? `撤回未提交变更：${dirtySummary}`
                    : "没有未保存更改",
                disabled: !hasDirtyChanges || isTableBusy,
                onClick: handleRevertChanges,
            },
        ];

        const ContextIcon =
            container.kind === "view"
                ? Eye
                : container.kind === "materialized_view"
                  ? Layers
                  : Table2;
        const objectName = container.table ?? container.objectName ?? "数据";
        const databaseName = container.database?.trim()
            ? container.database
            : null;
        const contextLabel = databaseName
            ? `${objectName} | ${databaseName}`
            : objectName;

        setToolbar(tabId, {
            actions,
            context: {
                icon: ContextIcon,
                label: contextLabel,
            },
        });
        return () => clearToolbar(tabId);
    }, [
        canBrowseData,
        canCreateDraftRow,
        canDeleteSelectedRows,
        canManageTransaction,
        canUseTransaction,
        clearToolbar,
        container,
        deleteRowsTitle,
        dirtySummary,
        handleAddDraftRow,
        handleBeginTransaction,
        handleCommitTransaction,
        handleRefresh,
        handleRevertChanges,
        handleRollbackTransaction,
        handleSaveChanges,
        hasDirtyChanges,
        isFetching,
        isInTransaction,
        isRollbackRecommended,
        isTableBusy,
        isTransactionBusy,
        openSelectedRowsDeleteConfirm,
        setToolbar,
        tabId,
    ]);

    return {
        dirtySummary,
        handlePreviewDml,
    };
}
