import { formatIpcError, normalizeIpcError } from "@/lib/ipc-error";
import type { SchemaDesignOperationState } from "@/store";
import type {
    ClickHouseColumnActionResult,
    ClickHouseTableAlterResult,
    ClickHouseTableSchema,
    NativeSchemaChangePlan,
} from "@/types/ipc";

import type { ClickHouseEditValidationIssue } from "./clickhouse-table-edit-validation";

export interface ResolveClickHouseEditSaveStateInput {
    targetKey: string;
    previewTargetKey: string | null;
    baselineRevisionHash: string;
    preview: NativeSchemaChangePlan | null;
    issues: readonly ClickHouseEditValidationIssue[];
    isPreviewPending: boolean;
    previewErrorMessage: string | null;
    isApplying: boolean;
    hasConflict: boolean;
    operationState: SchemaDesignOperationState;
}

export interface ClickHouseEditSaveState {
    canSave: boolean;
    expectedPlanHash: string | null;
    requiresDestructiveConfirmation: boolean;
}

export function canRequestClickHouseEditPreview(input: {
    enabled: boolean;
    isDirty: boolean;
    hasConflict: boolean;
    operationState: SchemaDesignOperationState;
}): boolean {
    return (
        input.enabled &&
        input.isDirty &&
        !input.hasConflict &&
        ![
            "submitted",
            "partiallyApplied",
            "outcomeUnknown",
            "conflict",
        ].includes(input.operationState)
    );
}

function isFreshTablePlan(
    preview: NativeSchemaChangePlan | null,
    baselineRevisionHash: string,
): preview is NativeSchemaChangePlan {
    return (
        preview != null &&
        preview.statements.length > 0 &&
        preview.operations.length > 0 &&
        /^[0-9a-f]{64}$/u.test(preview.planHash) &&
        preview.expectedTargetRevision != null &&
        /^[0-9a-f]{64}$/u.test(preview.expectedTargetRevision) &&
        preview.baseline.kind === "clickhouse_table" &&
        preview.baseline.baseline.baseline.revisionHash === baselineRevisionHash
    );
}

export function resolveClickHouseEditSaveState({
    targetKey,
    previewTargetKey,
    baselineRevisionHash,
    preview,
    issues,
    isPreviewPending,
    previewErrorMessage,
    isApplying,
    hasConflict,
    operationState,
}: ResolveClickHouseEditSaveStateInput): ClickHouseEditSaveState {
    const planIsFresh = isFreshTablePlan(preview, baselineRevisionHash);
    const canSave =
        issues.length === 0 &&
        !isPreviewPending &&
        previewErrorMessage == null &&
        !isApplying &&
        !hasConflict &&
        operationState === "previewReady" &&
        previewTargetKey === targetKey &&
        planIsFresh;

    return {
        canSave,
        expectedPlanHash: canSave && preview ? preview.planHash : null,
        requiresDestructiveConfirmation:
            canSave && preview
                ? preview.requiredConfirmation !== "none"
                : false,
    };
}

export interface ClickHouseEditResultTransition {
    operationState: SchemaDesignOperationState;
    replaceBaseline: boolean;
    keepDirtyDraft: boolean;
    conflictRemoteSchema: ClickHouseTableSchema | null;
    verifiedSchema: ClickHouseTableSchema | null;
    clearPendingColumnAction: boolean;
    invalidateSchema: boolean;
}

type ClickHouseEditableResult =
    | ClickHouseTableAlterResult
    | ClickHouseColumnActionResult;

export function resolveClickHouseEditResultTransition(
    result: ClickHouseEditableResult,
): ClickHouseEditResultTransition {
    switch (result.status) {
        case "applied":
            if (result.schema) {
                return {
                    operationState: "idle",
                    replaceBaseline: true,
                    keepDirtyDraft: false,
                    conflictRemoteSchema: null,
                    verifiedSchema: result.schema,
                    clearPendingColumnAction: true,
                    invalidateSchema: false,
                };
            }
            return {
                operationState: "outcomeUnknown",
                replaceBaseline: false,
                keepDirtyDraft: true,
                conflictRemoteSchema: null,
                verifiedSchema: null,
                clearPendingColumnAction: true,
                invalidateSchema: true,
            };
        case "submitted":
            return {
                operationState: "submitted",
                replaceBaseline: false,
                keepDirtyDraft: true,
                conflictRemoteSchema: null,
                verifiedSchema: null,
                clearPendingColumnAction: true,
                invalidateSchema: true,
            };
        case "partiallyApplied":
            return {
                operationState: "partiallyApplied",
                replaceBaseline: false,
                keepDirtyDraft: true,
                conflictRemoteSchema: result.schema,
                verifiedSchema: null,
                clearPendingColumnAction: true,
                invalidateSchema: true,
            };
        case "outcomeUnknown":
            return {
                operationState: "outcomeUnknown",
                replaceBaseline: false,
                keepDirtyDraft: true,
                conflictRemoteSchema: result.schema,
                verifiedSchema: null,
                clearPendingColumnAction: true,
                invalidateSchema: true,
            };
    }
}

export interface ClickHouseEditFailureTransition
    extends ClickHouseEditResultTransition {
    errorMessage: string;
}

export function resolveClickHouseEditFailureTransition(
    error: unknown,
): ClickHouseEditFailureTransition {
    const appError = normalizeIpcError(error);
    return {
        operationState:
            appError.code === "RESOURCE_CONFLICT"
                ? "conflict"
                : appError.code === "OPERATION_OUTCOME_UNKNOWN"
                  ? "outcomeUnknown"
                  : "previewReady",
        replaceBaseline: false,
        keepDirtyDraft: true,
        conflictRemoteSchema: null,
        verifiedSchema: null,
        clearPendingColumnAction: false,
        invalidateSchema:
            appError.code === "RESOURCE_CONFLICT" ||
            appError.code === "OPERATION_OUTCOME_UNKNOWN",
        errorMessage: formatIpcError(appError),
    };
}
