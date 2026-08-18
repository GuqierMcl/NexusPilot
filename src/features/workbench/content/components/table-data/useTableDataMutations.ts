import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";

import { apiInvoke } from "@/lib/api-client";
import type {
    ContainerRef,
    TableBrowseQuery,
    TableChangeSetCommitResult,
    TableChangeSetPreview,
    TablePageStats,
} from "@/types/ipc";
import {
    EMPTY_TABLE_DATA_CHANGE_SET,
    type TableDataChangeSet,
} from "@/store";

import { changeSetToRequest } from "./table-data-utils";
import type {
    PatchTableDataState,
    TableDataChangeSetSetter,
} from "./useTableDataRuntimeState";

interface UseTableDataMutationsParams {
    tabId: string;
    profileId: string;
    tabRuntimeId: string;
    container: ContainerRef;
    pageSize: number;
    browseQuery: TableBrowseQuery;
    currentPageStatsQueryKey: string;
    pageStats: TablePageStats | null;
    pageStatsQueryKey: string | null;
    isInTransaction: boolean;
    patchTableDataState: PatchTableDataState;
    resetTableDataTransientState: (tabId: string) => void;
    setChangeSet: TableDataChangeSetSetter;
    setTransactionWarning: (warning: "rollbackRecommended" | null) => void;
    invalidatePageStats: () => void;
    invalidateCurrentTableData: () => Promise<void>;
    setIsDmlDrawerOpen: (isOpen: boolean) => void;
}

export function useTableDataMutations({
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
}: UseTableDataMutationsParams) {
    const pageStatsMutation = useMutation({
        mutationFn: (requestedPage?: number) =>
            apiInvoke<TablePageStats>(
                "get_table_page_stats",
                {
                    profileId,
                    tabId: tabRuntimeId,
                    container,
                    pageSize,
                    query: browseQuery,
                    requestedPage,
                },
                { silent: true },
            ),
        onSuccess: (stats) => {
            patchTableDataState(tabId, {
                pageStats: stats,
                pageStatsQueryKey: currentPageStatsQueryKey,
            });
        },
        onError: (error) => {
            console.error("Failed to load table page stats", error);
        },
    });

    const ensurePageStats = useCallback(
        async (requestedPage?: number) => {
            if (
                requestedPage == null &&
                pageStatsQueryKey === currentPageStatsQueryKey &&
                pageStats
            ) {
                return pageStats;
            }

            return pageStatsMutation.mutateAsync(requestedPage);
        },
        [
            currentPageStatsQueryKey,
            pageStats,
            pageStatsMutation,
            pageStatsQueryKey,
        ],
    );

    const saveChangesMutation = useMutation({
        mutationFn: async (snapshot: TableDataChangeSet) => {
            const result = await apiInvoke<TableChangeSetCommitResult>(
                "commit_table_change_set",
                {
                    profileId,
                    tabId: tabRuntimeId,
                    container,
                    changeSet: changeSetToRequest(snapshot),
                },
            );
            return result;
        },
        onSuccess: async (result) => {
            if (result.outcome === "outcomeUnknown") {
                toast.warning(
                    "写入请求已发送，但当前无法确认最终结果。未保存的变更已保留，请先刷新并核对数据，不要直接重复提交。",
                );
                return;
            }
            if (result.outcome === "conflict") {
                toast.error("远端数据已变化，未保存的变更已保留；请刷新后重新编辑。");
                return;
            }
            setChangeSet(EMPTY_TABLE_DATA_CHANGE_SET);
            resetTableDataTransientState(tabId);
            setTransactionWarning(null);
            invalidatePageStats();
            setIsDmlDrawerOpen(false);
            await invalidateCurrentTableData();
            toast.success(
                isInTransaction
                    ? `已写入当前事务，影响 ${result.affectedRows} 行`
                    : result.outcome === "submitted"
                      ? "更改已提交到服务器，请刷新确认最终结果"
                      : `已保存更改，影响 ${result.affectedRows} 行`,
            );
        },
        onError: (error) => {
            console.error("Failed to save table change set", error);
            if (isInTransaction) {
                setTransactionWarning("rollbackRecommended");
                toast.error("保存更改失败，当前事务建议回滚后重试");
                return;
            }
            toast.error("保存更改失败，未保存的变更已保留");
        },
    });

    const dmlPreviewMutation = useMutation({
        mutationFn: (snapshot: TableDataChangeSet) =>
            apiInvoke<TableChangeSetPreview>("preview_table_change_set", {
                profileId,
                tabId: tabRuntimeId,
                container,
                changeSet: changeSetToRequest(snapshot),
            }),
        onSuccess: () => {
            setIsDmlDrawerOpen(true);
        },
        onError: (error) => {
            console.error("Failed to preview table change set", error);
        },
    });

    return {
        pageStatsMutation,
        ensurePageStats,
        saveChangesMutation,
        dmlPreviewMutation,
    };
}
