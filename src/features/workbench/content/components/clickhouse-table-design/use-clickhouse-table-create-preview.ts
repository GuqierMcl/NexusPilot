import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePreviewCreateClickHouseTable } from "@/hooks/queries/use-db-metadata";
import { formatIpcError } from "@/lib/ipc-error";
import { useTabRuntimeStateStore } from "@/store";
import type { ClickHouseTableCreateDraft } from "@/types/clickhouse-table-design";
import type { NativeSchemaMutationPreview } from "@/types/ipc";

import {
    clickHouseDraftToCreateTarget,
} from "./clickhouse-table-create-draft";
import { resolveClickHouseCreateSaveState } from "./clickhouse-table-create-lifecycle";
import {
    clickHouseCreateTargetKey,
    type ClickHouseCreateValidationIssue,
} from "./clickhouse-table-create-validation";

interface UseClickHouseTableCreatePreviewOptions {
    profileId: string;
    tabId: string;
    draft: ClickHouseTableCreateDraft;
    issues: readonly ClickHouseCreateValidationIssue[];
    enabled: boolean;
}

function isSafePreview(preview: NativeSchemaMutationPreview): boolean {
    return (
        preview.statements.length === 1 &&
        !preview.destructive &&
        !preview.longRunning &&
        /^[0-9a-f]{64}$/u.test(preview.planHash)
    );
}

export function useClickHouseTableCreatePreview({
    profileId,
    tabId,
    draft,
    issues,
    enabled,
}: UseClickHouseTableCreatePreviewOptions) {
    const previewCreateTable = usePreviewCreateClickHouseTable(profileId);
    const previewCreateTableMutate = previewCreateTable.mutate;
    const patchSchemaDesignState = useTabRuntimeStateStore(
        (state) => state.patchSchemaDesignState,
    );
    const operationState = useTabRuntimeStateStore(
        (state) =>
            state.schemaDesignByTabId[tabId]?.operationState ?? "idle",
    );
    const target = useMemo(
        () => clickHouseDraftToCreateTarget(draft),
        [draft],
    );
    const targetKey = useMemo(
        () => clickHouseCreateTargetKey(target),
        [target],
    );
    const issueKey = useMemo(() => JSON.stringify(issues), [issues]);
    const latestTargetKeyRef = useRef(targetKey);
    const requestIdRef = useRef(0);
    const [preview, setPreview] = useState<NativeSchemaMutationPreview | null>(
        null,
    );
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
        if (!enabled) {
            setIsPending(false);
            return;
        }
        setPreview(null);
        setPreviewTargetKey(null);
        setErrorMessage(null);
        setIsPending(false);

        const current =
            useTabRuntimeStateStore.getState().schemaDesignByTabId[tabId];
        if (issues.length > 0) {
            if (current?.operationState !== "outcomeUnknown") {
                patchSchemaDesignState(tabId, {
                    operationState: "idle",
                    errorMessage: null,
                });
            }
            return;
        }
        if (current?.operationState !== "outcomeUnknown") {
            patchSchemaDesignState(tabId, {
                operationState: "idle",
                errorMessage: null,
            });
        }

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
            previewCreateTableMutate(target, {
                onSuccess: (nextPreview) => {
                    if (
                        requestIdRef.current !== requestId ||
                        latestTargetKeyRef.current !== targetKey
                    ) {
                        return;
                    }
                    setIsPending(false);
                    if (!isSafePreview(nextPreview)) {
                        setErrorMessage(
                            "后端返回了不符合单语句安全约束的 DDL 预览",
                        );
                        patchSchemaDesignState(tabId, {
                            operationState: "idle",
                            errorMessage:
                                "后端返回了不符合单语句安全约束的 DDL 预览",
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
        enabled,
        issueKey,
        issues.length,
        patchSchemaDesignState,
        previewCreateTableMutate,
        refreshRevision,
        tabId,
        target,
        targetKey,
    ]);

    const saveState = resolveClickHouseCreateSaveState({
        targetKey,
        previewTargetKey,
        preview,
        issues,
        isPreviewPending: isPending,
        previewErrorMessage: errorMessage,
        isApplying: false,
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
        refreshPreview,
    };
}
