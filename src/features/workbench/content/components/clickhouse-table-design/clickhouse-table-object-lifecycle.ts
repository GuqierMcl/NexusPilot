import { formatIpcError, normalizeIpcError } from "@/lib/ipc-error";
import type { SchemaDesignOperationState } from "@/store";
import type {
    ClickHouseProjectionChangeResult,
    ClickHouseSkippingIndexChangeResult,
    ClickHouseTableSchema,
    NativeSchemaChangePlan,
    NativeSchemaChangeTarget,
    NativeSchemaConfirmationInput,
    NativeSchemaExecuteChangeRequest,
} from "@/types/ipc";

import {
    clickHouseTableObjectTargetKey,
    type ClickHouseTableObjectValidationIssue,
} from "./clickhouse-table-object-validation";

export interface ResolveClickHouseTableObjectSaveStateInput {
    targetKey: string;
    previewTargetKey: string | null;
    baselineRevisionHash: string;
    preview: NativeSchemaChangePlan | null;
    issues: readonly ClickHouseTableObjectValidationIssue[];
    mainDraftDirty: boolean;
    isPreviewPending: boolean;
    previewErrorMessage: string | null;
    isApplying: boolean;
    operationState: SchemaDesignOperationState;
}

export interface ClickHouseTableObjectSaveState {
    canSave: boolean;
    expectedPlanHash: string | null;
    requiresDestructiveConfirmation: boolean;
}

export interface ClickHouseTableObjectPreviewState {
    requestId: number;
    targetKey: string | null;
    target: NativeSchemaChangeTarget | null;
    preview: NativeSchemaChangePlan | null;
}

export function emptyClickHouseTableObjectPreviewState(): ClickHouseTableObjectPreviewState {
    return { requestId: 0, targetKey: null, target: null, preview: null };
}

export function beginClickHouseTableObjectPreview(
    state: ClickHouseTableObjectPreviewState,
    targetKey: string,
): { state: ClickHouseTableObjectPreviewState; requestId: number } {
    const requestId = state.requestId + 1;
    return {
        requestId,
        state: { requestId, targetKey, target: null, preview: null },
    };
}

export function acceptClickHouseTableObjectPreview(
    state: ClickHouseTableObjectPreviewState,
    response: {
        requestId: number;
        targetKey: string;
        target: NativeSchemaChangeTarget;
        preview: NativeSchemaChangePlan;
    },
): ClickHouseTableObjectPreviewState {
    return state.requestId === response.requestId &&
        state.targetKey === response.targetKey
        ? {
              ...state,
              target: response.target,
              preview: response.preview,
          }
        : state;
}

export function canStartClickHouseTableObjectOperation(input: {
    hasAction: boolean;
    mainDraftDirty: boolean;
    operationState: SchemaDesignOperationState;
}): boolean {
    return (
        input.hasAction &&
        !input.mainDraftDirty &&
        ![
            "submitted",
            "partiallyApplied",
            "outcomeUnknown",
            "conflict",
            "applying",
        ].includes(input.operationState)
    );
}

export function buildClickHouseTableObjectExecuteRequest(
    state: ClickHouseTableObjectPreviewState,
    input: {
        currentTarget: NativeSchemaChangeTarget;
        currentTargetKey: string;
        baselineRevisionHash: string;
        issues: readonly ClickHouseTableObjectValidationIssue[];
        mainDraftDirty: boolean;
        operationState: SchemaDesignOperationState;
        confirmation: NativeSchemaConfirmationInput | null;
    },
): NativeSchemaExecuteChangeRequest | null {
    if (
        state.target == null ||
        state.preview == null ||
        state.targetKey !== input.currentTargetKey ||
        clickHouseTableObjectTargetKey(input.currentTarget) !==
            input.currentTargetKey
    ) {
        return null;
    }
    const saveState = resolveClickHouseTableObjectSaveState({
        targetKey: input.currentTargetKey,
        previewTargetKey: state.targetKey,
        baselineRevisionHash: input.baselineRevisionHash,
        preview: state.preview,
        issues: input.issues,
        mainDraftDirty: input.mainDraftDirty,
        isPreviewPending: false,
        previewErrorMessage: null,
        isApplying: false,
        operationState: input.operationState,
    });
    if (
        !saveState.canSave ||
        !saveState.expectedPlanHash ||
        !confirmationMatchesPlan(state.preview, input.confirmation)
    ) {
        return null;
    }
    return {
        target: state.target,
        baseline: state.preview.baseline,
        expectedPlanHash: saveState.expectedPlanHash,
        confirmation: input.confirmation,
    };
}

function confirmationMatchesPlan(
    plan: NativeSchemaChangePlan,
    confirmation: NativeSchemaConfirmationInput | null,
): boolean {
    switch (plan.requiredConfirmation) {
        case "none":
            return confirmation == null;
        case "confirm":
            return confirmation?.accepted === true;
        case "typeObjectName":
            return (
                confirmation?.accepted === true &&
                confirmation.objectName === plan.operations[0]?.objectName
            );
        case "typeObjectAndCluster":
            return false;
    }
}

function isFreshObjectPlan(
    preview: NativeSchemaChangePlan | null,
    baselineRevisionHash: string,
): preview is NativeSchemaChangePlan {
    return (
        preview != null &&
        preview.statements.length === 1 &&
        preview.operations.length === 1 &&
        /^[0-9a-f]{64}$/u.test(preview.planHash) &&
        preview.baseline.kind === "clickhouse_table" &&
        preview.baseline.baseline.baseline.revisionHash === baselineRevisionHash
    );
}

export function resolveClickHouseTableObjectSaveState({
    targetKey,
    previewTargetKey,
    baselineRevisionHash,
    preview,
    issues,
    mainDraftDirty,
    isPreviewPending,
    previewErrorMessage,
    isApplying,
    operationState,
}: ResolveClickHouseTableObjectSaveStateInput): ClickHouseTableObjectSaveState {
    const canSave =
        targetKey.length > 0 &&
        targetKey === previewTargetKey &&
        issues.length === 0 &&
        !mainDraftDirty &&
        !isPreviewPending &&
        previewErrorMessage == null &&
        !isApplying &&
        operationState === "previewReady" &&
        isFreshObjectPlan(preview, baselineRevisionHash);
    return {
        canSave,
        expectedPlanHash: canSave && preview ? preview.planHash : null,
        requiresDestructiveConfirmation:
            canSave && preview
                ? preview.requiredConfirmation !== "none"
                : false,
    };
}

export interface ClickHouseTableObjectResultTransition {
    operationState: SchemaDesignOperationState;
    replaceBaseline: boolean;
    verifiedSchema: ClickHouseTableSchema | null;
    conflictRemoteSchema: ClickHouseTableSchema | null;
    keepPendingObjectAction: boolean;
    invalidateSchema: boolean;
    blocksAutomaticRetry: boolean;
}

type ClickHouseTableObjectResult =
    | ClickHouseProjectionChangeResult
    | ClickHouseSkippingIndexChangeResult;

export function resolveClickHouseTableObjectResultTransition(
    result: ClickHouseTableObjectResult,
): ClickHouseTableObjectResultTransition {
    switch (result.status) {
        case "applied":
            if (
                result.schema != null &&
                (result.operation === "create" || result.operation === "drop")
            ) {
                return {
                    operationState: "idle",
                    replaceBaseline: true,
                    verifiedSchema: result.schema,
                    conflictRemoteSchema: null,
                    keepPendingObjectAction: false,
                    invalidateSchema: true,
                    blocksAutomaticRetry: false,
                };
            }
            return {
                operationState: "outcomeUnknown",
                replaceBaseline: false,
                verifiedSchema: null,
                conflictRemoteSchema: result.schema,
                keepPendingObjectAction: true,
                invalidateSchema: true,
                blocksAutomaticRetry: true,
            };
        case "submitted":
            return {
                operationState: "submitted",
                replaceBaseline: false,
                verifiedSchema: null,
                conflictRemoteSchema: null,
                keepPendingObjectAction: true,
                invalidateSchema: true,
                blocksAutomaticRetry: true,
            };
        case "partiallyApplied":
            return {
                operationState: "partiallyApplied",
                replaceBaseline: false,
                verifiedSchema: null,
                conflictRemoteSchema: result.schema,
                keepPendingObjectAction: true,
                invalidateSchema: true,
                blocksAutomaticRetry: true,
            };
        case "outcomeUnknown":
            return {
                operationState: "outcomeUnknown",
                replaceBaseline: false,
                verifiedSchema: null,
                conflictRemoteSchema: result.schema,
                keepPendingObjectAction: true,
                invalidateSchema: true,
                blocksAutomaticRetry: true,
            };
    }
}

export interface ClickHouseTableObjectFailureTransition
    extends ClickHouseTableObjectResultTransition {
    errorMessage: string;
}

export function resolveClickHouseTableObjectFailureTransition(
    error: unknown,
): ClickHouseTableObjectFailureTransition {
    const appError = normalizeIpcError(error);
    const blocksAutomaticRetry =
        appError.code === "RESOURCE_CONFLICT" ||
        appError.code === "OPERATION_OUTCOME_UNKNOWN";
    return {
        operationState:
            appError.code === "RESOURCE_CONFLICT"
                ? "conflict"
                : appError.code === "OPERATION_OUTCOME_UNKNOWN"
                  ? "outcomeUnknown"
                  : "idle",
        replaceBaseline: false,
        verifiedSchema: null,
        conflictRemoteSchema: null,
        keepPendingObjectAction: true,
        invalidateSchema: blocksAutomaticRetry,
        blocksAutomaticRetry,
        errorMessage: formatIpcError(appError),
    };
}
