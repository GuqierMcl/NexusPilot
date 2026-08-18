import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";

import { useCreateClickHouseTable } from "@/hooks/queries/use-db-metadata";
import { queryKeys } from "@/lib/query-keys";
import {
    useTabRuntimeStateStore,
    useWorkbenchTabsStore,
} from "@/store";
import type {
    ClickHouseCreateTableTarget,
    NativeSchemaMutationPreview,
} from "@/types/ipc";

import {
    resolveClickHouseCreateAppliedTransition,
    resolveClickHouseCreateFailureTransition,
    resolveClickHouseCreateSaveState,
} from "./clickhouse-table-create-lifecycle";
import {
    clickHouseCreateTargetKey,
    type ClickHouseCreateValidationIssue,
} from "./clickhouse-table-create-validation";

interface UseClickHouseTableCreateSaveOptions {
    tabId: string;
    profileId: string;
    tabRuntimeId: string;
    target: ClickHouseCreateTableTarget;
    targetKey: string;
    preview: NativeSchemaMutationPreview | null;
    previewTargetKey: string | null;
    issues: readonly ClickHouseCreateValidationIssue[];
    isPreviewPending: boolean;
    previewErrorMessage: string | null;
}

export function useClickHouseTableCreateSave({
    tabId,
    profileId,
    tabRuntimeId,
    target,
    targetKey,
    preview,
    previewTargetKey,
    issues,
    isPreviewPending,
    previewErrorMessage,
}: UseClickHouseTableCreateSaveOptions) {
    const queryClient = useQueryClient();
    const createTable = useCreateClickHouseTable(profileId);
    const [isApplying, setIsApplying] = useState(false);
    const operationState = useTabRuntimeStateStore(
        (state) =>
            state.schemaDesignByTabId[tabId]?.operationState ?? "idle",
    );
    const getOrCreateClickHouseTableDesignState = useTabRuntimeStateStore(
        (state) => state.getOrCreateClickHouseTableDesignState,
    );
    const removeClickHouseTableDesignState = useTabRuntimeStateStore(
        (state) => state.removeClickHouseTableDesignState,
    );
    const patchSchemaDesignState = useTabRuntimeStateStore(
        (state) => state.patchSchemaDesignState,
    );
    const setDirty = useWorkbenchTabsStore((state) => state.setDirty);
    const setExecuting = useWorkbenchTabsStore((state) => state.setExecuting);
    const retargetClickHouseTableDesignTabToEdit = useWorkbenchTabsStore(
        (state) => state.retargetClickHouseTableDesignTabToEdit,
    );
    const saveState = resolveClickHouseCreateSaveState({
        targetKey,
        previewTargetKey,
        preview,
        issues,
        isPreviewPending,
        previewErrorMessage,
        isApplying,
        operationState,
    });

    const handleSave = useCallback(async () => {
        const freshOperationState =
            useTabRuntimeStateStore.getState().schemaDesignByTabId[tabId]
                ?.operationState ?? "idle";
        const freshTargetKey = clickHouseCreateTargetKey(target);
        const freshSaveState = resolveClickHouseCreateSaveState({
            targetKey: freshTargetKey,
            previewTargetKey,
            preview,
            issues,
            isPreviewPending,
            previewErrorMessage,
            isApplying: false,
            operationState: freshOperationState,
        });
        if (
            freshTargetKey !== targetKey ||
            !freshSaveState.canSave ||
            !freshSaveState.expectedPlanHash
        ) {
            return;
        }

        setIsApplying(true);
        setExecuting(tabId, true);
        patchSchemaDesignState(tabId, {
            mode: "create",
            operationState: "applying",
            isDirty: true,
            errorMessage: null,
        });

        try {
            const result = await createTable.mutateAsync({
                target,
                expectedPlanHash: freshSaveState.expectedPlanHash,
                confirmation: null,
            });
            let transition: ReturnType<
                typeof resolveClickHouseCreateAppliedTransition
            >;
            try {
                transition = resolveClickHouseCreateAppliedTransition({
                    tabId,
                    result,
                });
            } catch (transitionError) {
                console.error(
                    "Failed to validate verified ClickHouse create result",
                    transitionError,
                );
                patchSchemaDesignState(tabId, {
                    mode: "create",
                    operationState: "outcomeUnknown",
                    isDirty: true,
                    errorMessage:
                        "远端返回的创建结果无法安全接入，请刷新 Explorer 后核对对象状态",
                });
                toast.error("创建结果无法安全接入，请先核对远端对象状态");
                return;
            }

            queryClient.setQueryData(
                queryKeys.clickHouseTableDesign(
                    profileId,
                    tabRuntimeId,
                    transition.retarget.container,
                ),
                result.schema,
            );
            if (transition.draft && transition.snapshot) {
                removeClickHouseTableDesignState(tabId);
                getOrCreateClickHouseTableDesignState(tabId, {
                    mode: "edit",
                    draft: transition.draft,
                    snapshot: transition.snapshot,
                });
            } else {
                removeClickHouseTableDesignState(tabId);
            }
            retargetClickHouseTableDesignTabToEdit(
                transition.retarget.tabId,
                transition.retarget.container,
            );
            patchSchemaDesignState(tabId, transition.runtimeState);
            setDirty(tabId, false);
            await queryClient.invalidateQueries({
                queryKey: queryKeys.profile(profileId),
            });
            toast.success(`已创建表 ${result.tableName}`);
        } catch (error) {
            console.error("Failed to create ClickHouse table", error);
            const transition = resolveClickHouseCreateFailureTransition(error);
            patchSchemaDesignState(tabId, {
                mode: transition.mode,
                operationState: transition.operationState,
                isDirty: transition.isDirty,
                errorMessage: transition.errorMessage,
            });
        } finally {
            setIsApplying(false);
            setExecuting(tabId, false);
        }
    }, [
        createTable,
        getOrCreateClickHouseTableDesignState,
        isPreviewPending,
        issues,
        patchSchemaDesignState,
        preview,
        previewErrorMessage,
        previewTargetKey,
        profileId,
        queryClient,
        removeClickHouseTableDesignState,
        retargetClickHouseTableDesignTabToEdit,
        setDirty,
        setExecuting,
        tabId,
        tabRuntimeId,
        target,
        targetKey,
    ]);

    return {
        canSave: saveState.canSave,
        expectedPlanHash: saveState.expectedPlanHash,
        isApplying,
        handleSave,
    };
}
