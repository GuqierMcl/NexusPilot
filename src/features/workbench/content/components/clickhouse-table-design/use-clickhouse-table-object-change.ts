import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
    useExecuteClickHouseProjectionChange,
    useExecuteClickHouseSkippingIndexChange,
    usePreviewClickHouseProjectionChange,
    usePreviewClickHouseSkippingIndexChange,
} from "@/hooks/queries/use-db-metadata";
import { formatIpcError } from "@/lib/ipc-error";
import {
    useTabRuntimeStateStore,
    useWorkbenchTabsStore,
    type SchemaDesignOperationState,
} from "@/store";
import type { ClickHouseTableObjectActionDraft } from "@/types/clickhouse-table-design";
import type {
    ClickHouseTableSchema,
    ContainerRef,
    NativeSchemaChangePlan,
    NativeSchemaChangeTarget,
} from "@/types/ipc";

import {
    acceptClickHouseTableObjectPreview,
    beginClickHouseTableObjectPreview,
    buildClickHouseTableObjectExecuteRequest,
    canStartClickHouseTableObjectOperation,
    emptyClickHouseTableObjectPreviewState,
    resolveClickHouseTableObjectFailureTransition,
    resolveClickHouseTableObjectResultTransition,
    resolveClickHouseTableObjectSaveState,
    type ClickHouseTableObjectPreviewState,
} from "./clickhouse-table-object-lifecycle";
import {
    clickHouseSchemaToEditDraft,
    cloneClickHouseTableEditDraft,
} from "./clickhouse-table-edit-draft";
import {
    buildClickHouseTableObjectTarget,
    clickHouseTableObjectTargetKey,
    validateClickHouseProjectionDraft,
    validateClickHouseSkippingIndexDraft,
    type ClickHouseTableObjectValidationIssue,
} from "./clickhouse-table-object-validation";

export interface UseClickHouseTableObjectChangeInput {
    tabId: string;
    profileId: string;
    tabRuntimeId: string;
    container: ContainerRef;
    baseline: ClickHouseTableSchema;
    action: ClickHouseTableObjectActionDraft | null;
    mainDraftDirty: boolean;
    operationState: SchemaDesignOperationState;
}

function actionIssues(
    action: ClickHouseTableObjectActionDraft | null,
    baseline: ClickHouseTableSchema,
): ClickHouseTableObjectValidationIssue[] {
    if (!action) return [];
    if (action.operation === "create" && action.definition) {
        return action.objectKind === "projection"
            ? validateClickHouseProjectionDraft(action.definition, baseline)
            : validateClickHouseSkippingIndexDraft(action.definition, baseline);
    }
    try {
        buildClickHouseTableObjectTarget(action, baseline);
        return [];
    } catch (error) {
        return [
            {
                path: "action",
                message: error instanceof Error ? error.message : "对象动作无效",
            },
        ];
    }
}

function actionTarget(
    action: ClickHouseTableObjectActionDraft | null,
    baseline: ClickHouseTableSchema,
): NativeSchemaChangeTarget | null {
    if (!action) return null;
    try {
        return buildClickHouseTableObjectTarget(action, baseline);
    } catch {
        return null;
    }
}

export function useClickHouseTableObjectChange({
    tabId,
    profileId,
    tabRuntimeId,
    container,
    baseline,
    action,
    mainDraftDirty,
    operationState,
}: UseClickHouseTableObjectChangeInput) {
    const previewProjection = usePreviewClickHouseProjectionChange(profileId);
    const previewIndex = usePreviewClickHouseSkippingIndexChange(profileId);
    const executeProjection = useExecuteClickHouseProjectionChange(
        profileId,
        tabRuntimeId,
        container,
    );
    const executeIndex = useExecuteClickHouseSkippingIndexChange(
        profileId,
        tabRuntimeId,
        container,
    );
    const previewProjectionMutateAsync = previewProjection.mutateAsync;
    const previewIndexMutateAsync = previewIndex.mutateAsync;
    const executeProjectionMutateAsync = executeProjection.mutateAsync;
    const executeIndexMutateAsync = executeIndex.mutateAsync;
    const patchDesignState = useTabRuntimeStateStore(
        (state) => state.patchClickHouseTableDesignState,
    );
    const patchOperationState = useTabRuntimeStateStore(
        (state) => state.patchSchemaDesignState,
    );
    const setDirty = useWorkbenchTabsStore((state) => state.setDirty);
    const issues = useMemo(() => actionIssues(action, baseline), [action, baseline]);
    const target = useMemo(() => actionTarget(action, baseline), [action, baseline]);
    const targetKey = useMemo(
        () => (target ? clickHouseTableObjectTargetKey(target) : null),
        [target],
    );
    const [previewState, setPreviewState] = useState(
        emptyClickHouseTableObjectPreviewState,
    );
    const previewStateRef = useRef(previewState);
    const [isPreviewing, setIsPreviewing] = useState(false);
    const [isApplying, setIsApplying] = useState(false);
    const [previewError, setPreviewError] = useState<string | null>(null);
    const operationBlocked = [
        "submitted",
        "partiallyApplied",
        "outcomeUnknown",
        "conflict",
        "applying",
    ].includes(operationState);

    useEffect(() => {
        previewStateRef.current = previewState;
    }, [previewState]);

    useEffect(() => {
        if (
            !target ||
            !targetKey ||
            issues.length > 0 ||
            !canStartClickHouseTableObjectOperation({
                hasAction: action != null,
                mainDraftDirty,
                operationState,
            })
        ) {
            const canceled = {
                requestId: previewStateRef.current.requestId + 1,
                targetKey: null,
                target: null,
                preview: null,
            } satisfies ClickHouseTableObjectPreviewState;
            previewStateRef.current = canceled;
            setPreviewState(canceled);
            setIsPreviewing(false);
            setPreviewError(null);
            return;
        }

        const begun = beginClickHouseTableObjectPreview(
            previewStateRef.current,
            targetKey,
        );
        previewStateRef.current = begun.state;
        setPreviewState(begun.state);
        setPreviewError(null);
        const requestId = begun.requestId;
        const delay = target.kind.endsWith("_create") ? 300 : 0;
        const timer = globalThis.setTimeout(() => {
            setIsPreviewing(true);
            patchOperationState(tabId, {
                operationState: "previewing",
                errorMessage: null,
            });
            const previewPromise = target.kind.startsWith(
                "clickhouse_projection_",
            )
                ? previewProjectionMutateAsync(target)
                : previewIndexMutateAsync(target);
            void previewPromise
                .then((preview) => {
                    const current = previewStateRef.current;
                    const accepted = acceptClickHouseTableObjectPreview(current, {
                        requestId,
                        targetKey,
                        target,
                        preview,
                    });
                    if (accepted === current) return;
                    const saveState = resolveClickHouseTableObjectSaveState({
                        targetKey,
                        previewTargetKey: targetKey,
                        baselineRevisionHash: baseline.baseline.revisionHash,
                        preview,
                        issues: [],
                        mainDraftDirty: false,
                        isPreviewPending: false,
                        previewErrorMessage: null,
                        isApplying: false,
                        operationState: "previewReady",
                    });
                    if (!saveState.canSave) {
                        const message = "后端返回了与当前对象或表基线不匹配的预览";
                        setPreviewError(message);
                        setIsPreviewing(false);
                        patchOperationState(tabId, {
                            operationState: "idle",
                            errorMessage: message,
                        });
                        return;
                    }
                    previewStateRef.current = accepted;
                    setPreviewState(accepted);
                    setPreviewError(null);
                    setIsPreviewing(false);
                    patchOperationState(tabId, {
                        operationState: "previewReady",
                        errorMessage: null,
                    });
                })
                .catch((error: unknown) => {
                    if (
                        previewStateRef.current.requestId !== requestId ||
                        previewStateRef.current.targetKey !== targetKey
                    ) {
                        return;
                    }
                    const message = formatIpcError(error);
                    setPreviewError(message);
                    setIsPreviewing(false);
                    patchOperationState(tabId, {
                        operationState: "idle",
                        errorMessage: message,
                    });
                });
        }, delay);
        return () => globalThis.clearTimeout(timer);
    }, [
        action,
        baseline.baseline.revisionHash,
        issues.length,
        mainDraftDirty,
        operationBlocked,
        patchOperationState,
        previewIndexMutateAsync,
        previewProjectionMutateAsync,
        tabId,
        target,
        targetKey,
    ]);

    const saveState = resolveClickHouseTableObjectSaveState({
        targetKey: targetKey ?? "",
        previewTargetKey: previewState.targetKey,
        baselineRevisionHash: baseline.baseline.revisionHash,
        preview: previewState.preview,
        issues,
        mainDraftDirty,
        isPreviewPending: isPreviewing,
        previewErrorMessage: previewError,
        isApplying,
        operationState,
    });

    const execute = useCallback(
        async (confirmed = false): Promise<void> => {
            const stores = useTabRuntimeStateStore.getState();
            const design = stores.clickHouseTableDesignByTabId[tabId];
            const runtime = stores.schemaDesignByTabId[tabId];
            if (!design || design.mode !== "edit" || !design.pendingObjectAction) {
                return;
            }
            const freshBaseline = design.draft.baseline;
            const freshIssues = actionIssues(
                design.pendingObjectAction,
                freshBaseline,
            );
            const freshTarget = actionTarget(
                design.pendingObjectAction,
                freshBaseline,
            );
            if (!freshTarget) return;
            const freshTargetKey = clickHouseTableObjectTargetKey(freshTarget);
            const request = buildClickHouseTableObjectExecuteRequest(
                previewStateRef.current,
                {
                    currentTarget: freshTarget,
                    currentTargetKey: freshTargetKey,
                    baselineRevisionHash:
                        freshBaseline.baseline.revisionHash,
                    issues: freshIssues,
                    mainDraftDirty: runtime?.isDirty ?? mainDraftDirty,
                    operationState: runtime?.operationState ?? operationState,
                    confirmation: confirmed
                        ? {
                              accepted: true,
                              objectName: null,
                              clusterName: null,
                          }
                        : null,
                },
            );
            if (!request) return;

            setIsApplying(true);
            patchOperationState(tabId, {
                operationState: "applying",
                errorMessage: null,
            });
            try {
                const result = freshTarget.kind.startsWith(
                    "clickhouse_projection_",
                )
                    ? await executeProjectionMutateAsync(request)
                    : await executeIndexMutateAsync(request);
                const transition = resolveClickHouseTableObjectResultTransition(result);
                if (transition.replaceBaseline && transition.verifiedSchema) {
                    const next = clickHouseSchemaToEditDraft(
                        transition.verifiedSchema,
                    );
                    patchDesignState(tabId, {
                        mode: "edit",
                        draft: next,
                        snapshot: cloneClickHouseTableEditDraft(next),
                        conflictRemoteSchema: null,
                        pendingColumnAction: null,
                        pendingObjectAction: null,
                    });
                    patchOperationState(tabId, {
                        operationState: "idle",
                        errorMessage: null,
                        blockerCount: 0,
                        isDirty: false,
                    });
                    setDirty(tabId, false);
                } else {
                    patchDesignState(tabId, {
                        mode: "edit",
                        conflictRemoteSchema: transition.conflictRemoteSchema,
                        pendingObjectAction: transition.keepPendingObjectAction
                            ? undefined
                            : null,
                    });
                    patchOperationState(tabId, {
                        operationState: transition.operationState,
                        errorMessage:
                            transition.operationState === "submitted"
                                ? "对象动作已提交，请刷新确认远端最终状态"
                                : transition.operationState === "partiallyApplied"
                                  ? "对象变更仅部分应用，请刷新核对远端事实"
                                  : "对象变更结果无法确认，请刷新核对远端事实",
                    });
                }
            } catch (error) {
                console.error("Failed to execute ClickHouse table-object change", error);
                const transition =
                    resolveClickHouseTableObjectFailureTransition(error);
                patchOperationState(tabId, {
                    operationState: transition.operationState,
                    errorMessage: transition.errorMessage,
                });
            } finally {
                setIsApplying(false);
            }
        },
        [
            executeIndexMutateAsync,
            executeProjectionMutateAsync,
            mainDraftDirty,
            operationState,
            patchDesignState,
            patchOperationState,
            setDirty,
            tabId,
        ],
    );

    const clear = useCallback(() => {
        const canceled = {
            requestId: previewStateRef.current.requestId + 1,
            targetKey: null,
            target: null,
            preview: null,
        } satisfies ClickHouseTableObjectPreviewState;
        previewStateRef.current = canceled;
        setPreviewState(canceled);
        setPreviewError(null);
        setIsPreviewing(false);
        patchDesignState(tabId, { mode: "edit", pendingObjectAction: null });
        if (!["submitted", "partiallyApplied", "outcomeUnknown", "conflict"].includes(operationState)) {
            patchOperationState(tabId, {
                operationState: "idle",
                errorMessage: null,
            });
        }
    }, [operationState, patchDesignState, patchOperationState, tabId]);

    return {
        preview: previewState.preview as NativeSchemaChangePlan | null,
        previewError,
        issues,
        isPreviewing,
        isApplying,
        canExecute: saveState.canSave,
        requiresConfirmation: saveState.requiresDestructiveConfirmation,
        execute,
        clear,
    };
}
