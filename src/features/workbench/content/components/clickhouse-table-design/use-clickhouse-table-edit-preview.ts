import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePreviewAlterClickHouseTable } from "@/hooks/queries/use-db-metadata";
import { formatIpcError } from "@/lib/ipc-error";
import { useTabRuntimeStateStore } from "@/store";
import type { ClickHouseTableEditDraft } from "@/types/clickhouse-table-design";
import type { NativeSchemaChangePlan } from "@/types/ipc";

import {
    clickHouseEditDraftTargetKey,
    clickHouseEditDraftToAlterTarget,
} from "./clickhouse-table-edit-draft";
import { resolveClickHouseEditSaveState } from "./clickhouse-table-edit-lifecycle";
import type { ClickHouseEditValidationIssue } from "./clickhouse-table-edit-validation";

interface UseClickHouseTableEditPreviewOptions {
    profileId: string;
    tabId: string;
    draft: ClickHouseTableEditDraft;
    issues: readonly ClickHouseEditValidationIssue[];
    hasConflict: boolean;
    enabled: boolean;
}

export function useClickHouseTableEditPreview({
    profileId,
    tabId,
    draft,
    issues,
    hasConflict,
    enabled,
}: UseClickHouseTableEditPreviewOptions) {
    const previewAlter = usePreviewAlterClickHouseTable(profileId);
    const previewAlterMutate = previewAlter.mutate;
    const patchSchemaDesignState = useTabRuntimeStateStore(
        (state) => state.patchSchemaDesignState,
    );
    const operationState = useTabRuntimeStateStore(
        (state) =>
            state.schemaDesignByTabId[tabId]?.operationState ?? "idle",
    );
    const target = useMemo(
        () => clickHouseEditDraftToAlterTarget(draft),
        [draft],
    );
    const targetKey = useMemo(
        () => clickHouseEditDraftTargetKey(draft),
        [draft],
    );
    const issueKey = useMemo(() => JSON.stringify(issues), [issues]);
    const latestTargetKeyRef = useRef(targetKey);
    const requestIdRef = useRef(0);
    const [preview, setPreview] = useState<NativeSchemaChangePlan | null>(null);
    const [previewTargetKey, setPreviewTargetKey] = useState<string | null>(
        null,
    );
    const [isPending, setIsPending] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [refreshRevision, setRefreshRevision] = useState(0);
    const refreshPreview = useCallback(() => {
        setRefreshRevision((current) => current + 1);
    }, []);

    useEffect(() => {
        latestTargetKeyRef.current = targetKey;
        const requestId = requestIdRef.current + 1;
        requestIdRef.current = requestId;
        setPreview(null);
        setPreviewTargetKey(null);
        setErrorMessage(null);
        setIsPending(false);

        if (!enabled || hasConflict || issues.length > 0) {
            const current =
                useTabRuntimeStateStore.getState().schemaDesignByTabId[tabId];
            if (
                current?.operationState !== "outcomeUnknown" &&
                current?.operationState !== "partiallyApplied" &&
                current?.operationState !== "conflict" &&
                current?.operationState !== "submitted"
            ) {
                patchSchemaDesignState(tabId, {
                    operationState: "idle",
                    errorMessage: null,
                });
            }
            return;
        }

        patchSchemaDesignState(tabId, {
            operationState: "idle",
            errorMessage: null,
        });
        const timer = globalThis.setTimeout(() => {
            if (
                requestIdRef.current !== requestId ||
                latestTargetKeyRef.current !== targetKey
            ) {
                return;
            }
            setIsPending(true);
            patchSchemaDesignState(tabId, {
                operationState: "previewing",
                errorMessage: null,
            });
            previewAlterMutate(target, {
                onSuccess: (nextPreview) => {
                    if (
                        requestIdRef.current !== requestId ||
                        latestTargetKeyRef.current !== targetKey
                    ) {
                        return;
                    }
                    setIsPending(false);
                    const accepted = resolveClickHouseEditSaveState({
                        targetKey,
                        previewTargetKey: targetKey,
                        baselineRevisionHash:
                            draft.baseline.baseline.revisionHash,
                        preview: nextPreview,
                        issues: [],
                        isPreviewPending: false,
                        previewErrorMessage: null,
                        isApplying: false,
                        hasConflict: false,
                        operationState: "previewReady",
                    });
                    if (!accepted.canSave) {
                        const message =
                            "后端返回了与当前表基线不匹配的结构变更预览";
                        setErrorMessage(message);
                        patchSchemaDesignState(tabId, {
                            operationState: "idle",
                            errorMessage: message,
                        });
                        return;
                    }
                    setPreview(nextPreview);
                    setPreviewTargetKey(targetKey);
                    patchSchemaDesignState(tabId, {
                        operationState: "previewReady",
                        errorMessage: null,
                    });
                },
                onError: (error) => {
                    if (
                        requestIdRef.current !== requestId ||
                        latestTargetKeyRef.current !== targetKey
                    ) {
                        return;
                    }
                    const message = formatIpcError(error);
                    setIsPending(false);
                    setErrorMessage(message);
                    patchSchemaDesignState(tabId, {
                        operationState: "idle",
                        errorMessage: message,
                    });
                },
            });
        }, 500);

        return () => globalThis.clearTimeout(timer);
    }, [
        draft.baseline.baseline.revisionHash,
        enabled,
        hasConflict,
        issueKey,
        issues.length,
        patchSchemaDesignState,
        previewAlterMutate,
        refreshRevision,
        tabId,
        target,
        targetKey,
    ]);

    const saveState = resolveClickHouseEditSaveState({
        targetKey,
        previewTargetKey,
        baselineRevisionHash: draft.baseline.baseline.revisionHash,
        preview,
        issues,
        isPreviewPending: isPending,
        previewErrorMessage: errorMessage,
        isApplying: false,
        hasConflict,
        operationState,
    });

    return {
        target,
        targetKey,
        preview,
        previewTargetKey,
        isPending,
        errorMessage,
        canSave: saveState.canSave,
        requiresDestructiveConfirmation:
            saveState.requiresDestructiveConfirmation,
        refreshPreview,
    };
}
