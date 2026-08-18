import { formatIpcError, normalizeIpcError } from "@/lib/ipc-error";
import type {
    SchemaDesignOperationState,
    SchemaDesignRuntimeState,
} from "@/store";
import type { ClickHouseTableEditDraft } from "@/types/clickhouse-table-design";
import type {
    ClickHouseCreateTableResult,
    ContainerRef,
    NativeSchemaMutationPreview,
} from "@/types/ipc";

import {
    clickHouseSchemaToEditDraft,
    cloneClickHouseTableEditDraft,
} from "./clickhouse-table-edit-draft";
import type { ClickHouseCreateValidationIssue } from "./clickhouse-table-create-validation";

interface ResolveClickHouseCreateSaveStateInput {
    targetKey: string;
    previewTargetKey: string | null;
    preview: NativeSchemaMutationPreview | null;
    issues: readonly ClickHouseCreateValidationIssue[];
    isPreviewPending: boolean;
    previewErrorMessage: string | null;
    isApplying: boolean;
    operationState: SchemaDesignOperationState;
}

export interface ClickHouseCreateSaveState {
    canSave: boolean;
    expectedPlanHash: string | null;
}

export function resolveClickHouseCreateSaveState({
    targetKey,
    previewTargetKey,
    preview,
    issues,
    isPreviewPending,
    previewErrorMessage,
    isApplying,
    operationState,
}: ResolveClickHouseCreateSaveStateInput): ClickHouseCreateSaveState {
    const previewIsSafe =
        preview != null &&
        preview.statements.length === 1 &&
        !preview.destructive &&
        !preview.longRunning &&
        preview.riskFlags.length === 0 &&
        preview.requiredConfirmation === "none" &&
        /^[0-9a-f]{64}$/u.test(preview.planHash);
    const canSave =
        issues.length === 0 &&
        !isPreviewPending &&
        previewErrorMessage == null &&
        !isApplying &&
        operationState === "previewReady" &&
        previewTargetKey === targetKey &&
        previewIsSafe;

    return {
        canSave,
        expectedPlanHash: canSave && preview ? preview.planHash : null,
    };
}

export interface ClickHouseCreateAppliedTransition {
    retarget: {
        tabId: string;
        container: ContainerRef;
    };
    draft: ClickHouseTableEditDraft | null;
    snapshot: ClickHouseTableEditDraft | null;
    runtimeState: SchemaDesignRuntimeState;
}

function validateAppliedResult(result: ClickHouseCreateTableResult): void {
    const { container, schema } = result;
    if (
        container.kind !== "table" ||
        container.schema != null ||
        container.database !== schema.identity.database ||
        container.table !== schema.identity.name ||
        result.tableName !== schema.identity.name ||
        schema.identity.objectKind !== "table"
    ) {
        throw new Error(
            "ClickHouse create result does not match the verified table schema identity",
        );
    }
}

export function resolveClickHouseCreateAppliedTransition(input: {
    tabId: string;
    result: ClickHouseCreateTableResult;
}): ClickHouseCreateAppliedTransition {
    validateAppliedResult(input.result);
    let draft: ClickHouseTableEditDraft | null = null;
    try {
        draft = clickHouseSchemaToEditDraft(input.result.schema);
    } catch {
        // The verified remote schema remains authoritative for edit mode. A
        // writable create draft is optional and must never be synthesized.
    }
    const loadState =
        input.result.schema.editability.mode === "editable"
            ? "ready"
            : input.result.schema.editability.mode;

    return {
        retarget: {
            tabId: input.tabId,
            container: input.result.container,
        },
        draft,
        snapshot: draft ? cloneClickHouseTableEditDraft(draft) : null,
        runtimeState: {
            mode: "edit",
            loadState,
            operationState: "idle",
            blockerCount: input.result.schema.editability.blockers.length,
            errorMessage: null,
            isDirty: false,
        },
    };
}

export interface ClickHouseCreateFailureTransition {
    container: null;
    mode: "create";
    operationState: "previewReady" | "outcomeUnknown";
    isDirty: true;
    errorMessage: string;
}

export function resolveClickHouseCreateFailureTransition(
    error: unknown,
): ClickHouseCreateFailureTransition {
    const appError = normalizeIpcError(error);
    return {
        container: null,
        mode: "create",
        operationState:
            appError.code === "OPERATION_OUTCOME_UNKNOWN"
                ? "outcomeUnknown"
                : "previewReady",
        isDirty: true,
        errorMessage: formatIpcError(appError),
    };
}
