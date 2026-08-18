import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";

import {
    useAlterClickHouseTable,
    useExecuteClickHouseColumnAction,
    usePreviewClickHouseColumnAction,
} from "@/hooks/queries/use-db-metadata";
import { queryKeys } from "@/lib/query-keys";
import {
    useTabRuntimeStateStore,
    useWorkbenchTabsStore,
} from "@/store";
import type { ClickHouseColumnActionDraft } from "@/types/clickhouse-table-design";
import type {
    ClickHouseAlterTableTarget,
    ContainerRef,
    NativeSchemaChangePlan,
} from "@/types/ipc";

import {
    clickHouseEditDraftTargetKey,
    clickHouseEditDraftToAlterTarget,
    clickHouseSchemaToEditDraft,
    cloneClickHouseTableEditDraft,
} from "./clickhouse-table-edit-draft";
import {
    resolveClickHouseEditFailureTransition,
    resolveClickHouseEditResultTransition,
    resolveClickHouseEditSaveState,
} from "./clickhouse-table-edit-lifecycle";
import {
    validateClickHouseTableEditDraft,
    type ClickHouseEditValidationIssue,
} from "./clickhouse-table-edit-validation";

interface UseClickHouseTableEditSaveOptions {
    tabId: string;
    profileId: string;
    tabRuntimeId: string;
    container: ContainerRef;
    target: ClickHouseAlterTableTarget;
    targetKey: string;
    preview: NativeSchemaChangePlan | null;
    previewTargetKey: string | null;
    issues: readonly ClickHouseEditValidationIssue[];
    isPreviewPending: boolean;
    previewErrorMessage: string | null;
}

export function useClickHouseTableEditSave({
    tabId,
    profileId,
    tabRuntimeId,
    container,
    target,
    targetKey,
    preview,
    previewTargetKey,
    issues,
    isPreviewPending,
    previewErrorMessage,
}: UseClickHouseTableEditSaveOptions) {
    const queryClient = useQueryClient();
    const alterTable = useAlterClickHouseTable(
        profileId,
        tabRuntimeId,
        container,
    );
    const previewColumnAction = usePreviewClickHouseColumnAction(profileId);
    const executeColumnActionMutation = useExecuteClickHouseColumnAction(
        profileId,
        tabRuntimeId,
        container,
    );
    const [isApplying, setIsApplying] = useState(false);
    const operationState = useTabRuntimeStateStore(
        (state) =>
            state.schemaDesignByTabId[tabId]?.operationState ?? "idle",
    );
    const conflictRemoteSchema = useTabRuntimeStateStore((state) => {
        const design = state.clickHouseTableDesignByTabId[tabId];
        return design?.mode === "edit" ? design.conflictRemoteSchema : null;
    });
    const patchClickHouseTableDesignState = useTabRuntimeStateStore(
        (state) => state.patchClickHouseTableDesignState,
    );
    const patchSchemaDesignState = useTabRuntimeStateStore(
        (state) => state.patchSchemaDesignState,
    );
    const setDirty = useWorkbenchTabsStore((state) => state.setDirty);
    const setExecuting = useWorkbenchTabsStore((state) => state.setExecuting);
    const queryKey = queryKeys.clickHouseTableDesign(
        profileId,
        tabRuntimeId,
        container,
    );
    const saveState = resolveClickHouseEditSaveState({
        targetKey,
        previewTargetKey,
        baselineRevisionHash: target.baseline.baseline.revisionHash,
        preview,
        issues,
        isPreviewPending,
        previewErrorMessage,
        isApplying,
        hasConflict: conflictRemoteSchema != null,
        operationState,
    });

    const applyResult = useCallback(
        (result: Parameters<typeof resolveClickHouseEditResultTransition>[0]) => {
            const transition = resolveClickHouseEditResultTransition(result);
            if (transition.replaceBaseline && transition.verifiedSchema) {
                try {
                    const nextDraft = clickHouseSchemaToEditDraft(
                        transition.verifiedSchema,
                    );
                    patchClickHouseTableDesignState(tabId, {
                        mode: "edit",
                        draft: nextDraft,
                        snapshot: cloneClickHouseTableEditDraft(nextDraft),
                        conflictRemoteSchema: null,
                        pendingColumnAction: null,
                    });
                    patchSchemaDesignState(tabId, {
                        mode: "edit",
                        loadState: "ready",
                        operationState: "idle",
                        blockerCount: 0,
                        errorMessage: null,
                        isDirty: false,
                    });
                    setDirty(tabId, false);
                    toast.success("ClickHouse 表结构已更新");
                    return;
                } catch (error) {
                    console.error(
                        "Failed to hydrate verified ClickHouse alter result",
                        error,
                    );
                    patchSchemaDesignState(tabId, {
                        operationState: "outcomeUnknown",
                        errorMessage:
                            "远端结构已变化，但无法安全建立新的本地编辑基线",
                        isDirty: true,
                    });
                    void queryClient.invalidateQueries({ queryKey });
                    return;
                }
            }

            const current =
                useTabRuntimeStateStore.getState()
                    .clickHouseTableDesignByTabId[tabId];
            const preservedDirty =
                current?.mode === "edit" &&
                clickHouseEditDraftTargetKey(current.draft) !==
                    clickHouseEditDraftTargetKey(current.snapshot);

            patchClickHouseTableDesignState(tabId, {
                mode: "edit",
                conflictRemoteSchema: transition.conflictRemoteSchema,
                pendingColumnAction: transition.clearPendingColumnAction
                    ? null
                    : undefined,
            });
            patchSchemaDesignState(tabId, {
                operationState: transition.operationState,
                errorMessage:
                    transition.operationState === "submitted"
                        ? "远端已接受列动作，请刷新确认最终结构"
                        : transition.operationState === "partiallyApplied"
                          ? "部分结构变更已执行，请刷新并选择是否采用远端事实"
                          : transition.operationState === "outcomeUnknown"
                            ? "无法证明远端最终结构，请刷新核对"
                            : null,
                isDirty: transition.keepDirtyDraft && preservedDirty,
            });
            setDirty(tabId, transition.keepDirtyDraft && preservedDirty);
            if (transition.invalidateSchema) {
                void queryClient.invalidateQueries({ queryKey });
            }
            if (transition.operationState === "submitted") {
                toast.warning("列动作已提交，最终状态需刷新确认");
            } else if (transition.operationState === "partiallyApplied") {
                toast.warning("结构变更仅部分应用，请先核对远端结构");
            } else if (transition.operationState === "outcomeUnknown") {
                toast.warning("结构变更结果待确认，请先核对远端结构");
            }
        },
        [
            patchClickHouseTableDesignState,
            patchSchemaDesignState,
            queryClient,
            queryKey,
            setDirty,
            tabId,
        ],
    );

    const applyFailure = useCallback(
        (error: unknown) => {
            const transition = resolveClickHouseEditFailureTransition(error);
            const current =
                useTabRuntimeStateStore.getState()
                    .clickHouseTableDesignByTabId[tabId];
            const preservedDirty =
                current?.mode === "edit" &&
                clickHouseEditDraftTargetKey(current.draft) !==
                    clickHouseEditDraftTargetKey(current.snapshot);
            patchSchemaDesignState(tabId, {
                operationState: transition.operationState,
                errorMessage: transition.errorMessage,
                isDirty: preservedDirty,
            });
            setDirty(tabId, preservedDirty);
            if (transition.invalidateSchema) {
                void queryClient.invalidateQueries({ queryKey });
            }
        },
        [patchSchemaDesignState, queryClient, queryKey, setDirty, tabId],
    );

    const executeAlter = useCallback(
        async (confirmed: boolean): Promise<void> => {
            const current =
                useTabRuntimeStateStore.getState()
                    .clickHouseTableDesignByTabId[tabId];
            if (!current || current.mode !== "edit") return;
            const freshTarget = clickHouseEditDraftToAlterTarget(current.draft);
            const freshTargetKey = clickHouseEditDraftTargetKey(current.draft);
            const freshOperationState =
                useTabRuntimeStateStore.getState().schemaDesignByTabId[tabId]
                    ?.operationState ?? "idle";
            const freshSaveState = resolveClickHouseEditSaveState({
                targetKey: freshTargetKey,
                previewTargetKey,
                baselineRevisionHash:
                    current.draft.baseline.baseline.revisionHash,
                preview,
                issues,
                isPreviewPending,
                previewErrorMessage,
                isApplying: false,
                hasConflict: current.conflictRemoteSchema != null,
                operationState: freshOperationState,
            });
            if (
                freshTargetKey !== targetKey ||
                !freshSaveState.canSave ||
                !freshSaveState.expectedPlanHash ||
                (freshSaveState.requiresDestructiveConfirmation &&
                    !confirmed)
            ) {
                return;
            }

            setIsApplying(true);
            setExecuting(tabId, true);
            patchSchemaDesignState(tabId, {
                operationState: "applying",
                errorMessage: null,
                isDirty: true,
            });
            try {
                const result = await alterTable.mutateAsync({
                    target: {
                        kind: "clickhouse_table_alter",
                        target: freshTarget,
                    },
                    baseline: preview!.baseline,
                    expectedPlanHash: freshSaveState.expectedPlanHash,
                    confirmation: confirmed
                        ? {
                              accepted: true,
                              objectName: null,
                              clusterName: null,
                          }
                        : null,
                });
                applyResult(result);
            } catch (error) {
                console.error("Failed to alter ClickHouse table", error);
                applyFailure(error);
            } finally {
                setIsApplying(false);
                setExecuting(tabId, false);
            }
        },
        [
            alterTable,
            applyFailure,
            applyResult,
            isPreviewPending,
            issues,
            patchSchemaDesignState,
            preview,
            previewErrorMessage,
            previewTargetKey,
            setExecuting,
            tabId,
            targetKey,
        ],
    );

    const executeColumnAction = useCallback(
        async (action: ClickHouseColumnActionDraft): Promise<void> => {
            const current =
                useTabRuntimeStateStore.getState()
                    .clickHouseTableDesignByTabId[tabId];
            if (!current || current.mode !== "edit") return;
            const actionIssues = validateClickHouseTableEditDraft(
                current.draft,
                action,
            ).filter((issue) => issue.path !== "table");
            if (actionIssues.length > 0 || current.conflictRemoteSchema) return;

            const actionTarget = {
                kind:
                    action.action === "clear"
                        ? ("clickhouse_column_clear" as const)
                        : ("clickhouse_column_materialize" as const),
                target: {
                    baseline: current.draft.baseline,
                    columnName: action.columnName,
                },
            };
            const actionTargetKey = JSON.stringify(actionTarget);
            setIsApplying(true);
            setExecuting(tabId, true);
            patchSchemaDesignState(tabId, {
                operationState: "applying",
                errorMessage: null,
            });
            try {
                const actionPreview =
                    await previewColumnAction.mutateAsync(actionTarget);
                const actionSaveState = resolveClickHouseEditSaveState({
                    targetKey: actionTargetKey,
                    previewTargetKey: actionTargetKey,
                    baselineRevisionHash:
                        current.draft.baseline.baseline.revisionHash,
                    preview: actionPreview,
                    issues: [],
                    isPreviewPending: false,
                    previewErrorMessage: null,
                    isApplying: false,
                    hasConflict: false,
                    operationState: "previewReady",
                });
                if (
                    !actionSaveState.canSave ||
                    !actionSaveState.expectedPlanHash ||
                    !actionPreview.destructive
                ) {
                    throw new Error(
                        "ClickHouse column action preview did not satisfy the destructive plan contract",
                    );
                }
                const result = await executeColumnActionMutation.mutateAsync({
                    target: actionTarget,
                    baseline: actionPreview.baseline,
                    expectedPlanHash: actionSaveState.expectedPlanHash,
                    confirmation: {
                        accepted: true,
                        objectName: null,
                        clusterName: null,
                    },
                });
                applyResult(result);
            } catch (error) {
                console.error("Failed to execute ClickHouse column action", error);
                applyFailure(error);
            } finally {
                setIsApplying(false);
                setExecuting(tabId, false);
            }
        },
        [
            applyFailure,
            applyResult,
            executeColumnActionMutation,
            patchSchemaDesignState,
            previewColumnAction,
            setExecuting,
            tabId,
        ],
    );

    return {
        canSave: saveState.canSave,
        expectedPlanHash: saveState.expectedPlanHash,
        requiresDestructiveConfirmation:
            saveState.requiresDestructiveConfirmation,
        isApplying,
        executeAlter,
        executeColumnAction,
    };
}
