import { useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";

import { apiInvoke } from "@/lib/api-client";
import type { ContainerRef, TableTransactionState } from "@/types/ipc";
import { EMPTY_TABLE_DATA_CHANGE_SET } from "@/store";

import type { TableDataChangeSetSetter } from "./useTableDataRuntimeState";

interface UseTableDataTransactionsParams {
    tabId: string;
    profileId: string;
    tabRuntimeId: string;
    container: ContainerRef;
    canManageTransaction: boolean;
    setTransactionState: (state: TableTransactionState) => void;
    setTransactionWarning: (warning: "rollbackRecommended" | null) => void;
    invalidatePageStats: () => void;
    invalidateCurrentTableData: () => Promise<void>;
    setChangeSet: TableDataChangeSetSetter;
    resetTableDataTransientState: (tabId: string) => void;
}

export function useTableDataTransactions({
    tabId,
    profileId,
    tabRuntimeId,
    container,
    canManageTransaction,
    setTransactionState,
    setTransactionWarning,
    invalidatePageStats,
    invalidateCurrentTableData,
    setChangeSet,
    resetTableDataTransientState,
}: UseTableDataTransactionsParams) {
    useEffect(() => {
        let active = true;
        if (!canManageTransaction) {
            setTransactionState({ inTransaction: false, database: null });
            return () => {
                active = false;
            };
        }

        apiInvoke<TableTransactionState>(
            "get_tab_transaction_state",
            {
                profileId,
                tabId: tabRuntimeId,
            },
            { silent: true },
        )
            .then((state) => {
                if (active) {
                    setTransactionState(state);
                }
            })
            .catch((error) => {
                console.error("Failed to load table transaction state", error);
            });

        return () => {
            active = false;
        };
    }, [
        canManageTransaction,
        profileId,
        setTransactionState,
        tabRuntimeId,
    ]);

    const beginTransactionMutation = useMutation({
        mutationFn: () =>
            apiInvoke<TableTransactionState>("begin_tab_transaction", {
                profileId,
                tabId: tabRuntimeId,
                container,
            }),
        onSuccess: (state) => {
            setTransactionState(state);
            setTransactionWarning(null);
            toast.success("已开始事务");
        },
        onError: (error) => {
            console.error("Failed to begin table transaction", error);
        },
    });

    const commitTransactionMutation = useMutation({
        mutationFn: () =>
            apiInvoke<TableTransactionState>("commit_tab_transaction", {
                profileId,
                tabId: tabRuntimeId,
            }),
        onSuccess: async (state) => {
            setTransactionState(state);
            setTransactionWarning(null);
            invalidatePageStats();
            await invalidateCurrentTableData();
            toast.success("事务已提交");
        },
        onError: (error) => {
            console.error("Failed to commit table transaction", error);
        },
    });

    const rollbackTransactionMutation = useMutation({
        mutationFn: () =>
            apiInvoke<TableTransactionState>("rollback_tab_transaction", {
                profileId,
                tabId: tabRuntimeId,
            }),
        onSuccess: async (state) => {
            setTransactionState(state);
            setTransactionWarning(null);
            invalidatePageStats();
            setChangeSet(EMPTY_TABLE_DATA_CHANGE_SET);
            resetTableDataTransientState(tabId);
            await invalidateCurrentTableData();
            toast.success("事务已回滚");
        },
        onError: (error) => {
            console.error("Failed to rollback table transaction", error);
        },
    });

    return {
        beginTransactionMutation,
        commitTransactionMutation,
        rollbackTransactionMutation,
    };
}
