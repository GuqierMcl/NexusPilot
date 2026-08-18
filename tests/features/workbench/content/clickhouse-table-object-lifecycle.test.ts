import { describe, expect, test } from "bun:test";

import {
    acceptClickHouseTableObjectPreview,
    beginClickHouseTableObjectPreview,
    buildClickHouseTableObjectExecuteRequest,
    canStartClickHouseTableObjectOperation,
    emptyClickHouseTableObjectPreviewState,
    resolveClickHouseTableObjectFailureTransition,
    resolveClickHouseTableObjectResultTransition,
    resolveClickHouseTableObjectSaveState,
} from "../../../../src/features/workbench/content/components/clickhouse-table-design/clickhouse-table-object-lifecycle";
import { clickHouseSchemaToEditDraft } from "../../../../src/features/workbench/content/components/clickhouse-table-design/clickhouse-table-edit-draft";
import { clickHouseTableObjectTargetKey } from "../../../../src/features/workbench/content/components/clickhouse-table-design/clickhouse-table-object-validation";
import { useTabRuntimeStateStore } from "../../../../src/store/slices/tab-runtime-state-slice";
import type { ClickHouseTableObjectActionDraft } from "../../../../src/types/clickhouse-table-design";
import type {
    ClickHouseProjectionChangeResult,
    ClickHouseTableSchema,
    IAppError,
    NativeSchemaChangePlan,
    NativeSchemaChangeTarget,
} from "../../../../src/types/ipc";

function schemaFixture(revision = "a".repeat(64)): ClickHouseTableSchema {
    return {
        identity: {
            database: "analytics",
            name: "events",
            objectKind: "table",
            uuid: "table-uuid",
        },
        engine: { family: "MergeTree", arguments: [], rawExpression: "MergeTree" },
        columns: [],
        keys: {
            orderBy: "tuple()",
            partitionBy: null,
            primaryKey: null,
            sampleBy: null,
        },
        tableTtl: null,
        comment: null,
        settings: [],
        projections: [],
        skippingIndexes: [],
        editability: { mode: "editable", blockers: [] },
        baseline: {
            canonicalCreateQuery: "CREATE TABLE analytics.events ...",
            revisionHash: revision,
        },
    };
}

function planFixture(
    override: Partial<NativeSchemaChangePlan> = {},
): NativeSchemaChangePlan {
    return {
        statements: [
            "ALTER TABLE `analytics`.`events` ADD PROJECTION `by_tenant` (SELECT tenant_id)",
        ],
        warnings: [],
        destructive: false,
        longRunning: false,
        riskFlags: [],
        requiredConfirmation: "none",
        planHash: "b".repeat(64),
        expectedTargetRevision: "c".repeat(64),
        operations: [
            {
                code: "projection.create",
                objectName: "by_tenant",
                destructive: false,
                longRunning: false,
            },
        ],
        baseline: { kind: "clickhouse_table", baseline: schemaFixture() },
        ...override,
    };
}

function saveInput(
    override: Partial<
        Parameters<typeof resolveClickHouseTableObjectSaveState>[0]
    > = {},
): Parameters<typeof resolveClickHouseTableObjectSaveState>[0] {
    return {
        targetKey: "current",
        previewTargetKey: "current",
        baselineRevisionHash: "a".repeat(64),
        preview: planFixture(),
        issues: [],
        mainDraftDirty: false,
        isPreviewPending: false,
        previewErrorMessage: null,
        isApplying: false,
        operationState: "previewReady",
        ...override,
    };
}

function resultFixture(
    status: ClickHouseProjectionChangeResult["status"],
    schema: ClickHouseTableSchema | null,
    operation: ClickHouseProjectionChangeResult["operation"] = "create",
): ClickHouseProjectionChangeResult {
    return {
        status,
        progress: {
            appliedCount: status === "applied" ? 1 : 0,
            failedStatementIndex: null,
            remainingCount: 0,
            queryIds: ["query-1"],
        },
        container: { kind: "table", database: "analytics", table: "events" },
        projectionName: "by_tenant",
        operation,
        schema,
    };
}

describe("ClickHouse table-object lifecycle", () => {
    test("capability-closed sections remain inert without an initiated action", () => {
        for (const operationState of [
            "idle",
            "previewing",
            "previewReady",
        ] as const) {
            expect(
                canStartClickHouseTableObjectOperation({
                    hasAction: false,
                    mainDraftDirty: false,
                    operationState,
                }),
            ).toBe(false);
        }
        expect(emptyClickHouseTableObjectPreviewState()).toEqual({
            requestId: 0,
            targetKey: null,
            target: null,
            preview: null,
        });
    });

    test("new actions invalidate older previews and stale responses cannot replace current", () => {
        const targetA = {
            kind: "clickhouse_projection_create",
            target: {
                baseline: schemaFixture(),
                projection: { name: "a", query: "SELECT 1" },
            },
        } satisfies NativeSchemaChangeTarget;
        const targetB = {
            kind: "clickhouse_projection_create",
            target: {
                baseline: schemaFixture(),
                projection: { name: "b", query: "SELECT 2" },
            },
        } satisfies NativeSchemaChangeTarget;
        const first = beginClickHouseTableObjectPreview(
            emptyClickHouseTableObjectPreviewState(),
            "a",
        );
        const second = beginClickHouseTableObjectPreview(first.state, "b");
        expect(second.state.preview).toBeNull();

        const stale = acceptClickHouseTableObjectPreview(second.state, {
            requestId: first.requestId,
            targetKey: "a",
            target: targetA,
            preview: planFixture(),
        });
        expect(stale).toBe(second.state);
        const accepted = acceptClickHouseTableObjectPreview(second.state, {
            requestId: second.requestId,
            targetKey: "b",
            target: targetB,
            preview: planFixture(),
        });
        expect(accepted.target).toEqual(targetB);
        expect(accepted.preview).toEqual(planFixture());
    });

    test("execute uses only the accepted current preview baseline and hash", () => {
        const target = {
            kind: "clickhouse_projection_create",
            target: {
                baseline: schemaFixture(),
                projection: { name: "by_tenant", query: "SELECT tenant_id" },
            },
        } satisfies NativeSchemaChangeTarget;
        const key = clickHouseTableObjectTargetKey(target);
        const begun = beginClickHouseTableObjectPreview(
            emptyClickHouseTableObjectPreviewState(),
            key,
        );
        const accepted = acceptClickHouseTableObjectPreview(begun.state, {
            requestId: begun.requestId,
            targetKey: key,
            target,
            preview: planFixture(),
        });
        const request = buildClickHouseTableObjectExecuteRequest(accepted, {
            currentTarget: target,
            currentTargetKey: key,
            baselineRevisionHash: "a".repeat(64),
            issues: [],
            mainDraftDirty: false,
            operationState: "previewReady",
            confirmation: null,
        });
        expect(request).toEqual({
            target,
            baseline: planFixture().baseline,
            expectedPlanHash: "b".repeat(64),
            confirmation: null,
        });
        expect(
            buildClickHouseTableObjectExecuteRequest(accepted, {
                currentTarget: target,
                currentTargetKey: "changed",
                baselineRevisionHash: "a".repeat(64),
                issues: [],
                mainDraftDirty: false,
                operationState: "previewReady",
                confirmation: null,
            }),
        ).toBeNull();
    });

    test("section switching is inert while dirty and terminal states block object operations", () => {
        const state = beginClickHouseTableObjectPreview(
            emptyClickHouseTableObjectPreviewState(),
            "current",
        ).state;
        expect(state).not.toHaveProperty("executeRequest");
        expect(
            canStartClickHouseTableObjectOperation({
                hasAction: true,
                mainDraftDirty: true,
                operationState: "idle",
            }),
        ).toBe(false);
        for (const operationState of [
            "submitted",
            "partiallyApplied",
            "outcomeUnknown",
            "conflict",
        ] as const) {
            expect(
                canStartClickHouseTableObjectOperation({
                    hasAction: true,
                    mainDraftDirty: false,
                    operationState,
                }),
            ).toBe(false);
        }
    });

    test("save requires current target fresh baseline one statement and clean main draft", () => {
        expect(resolveClickHouseTableObjectSaveState(saveInput())).toEqual({
            canSave: true,
            expectedPlanHash: "b".repeat(64),
            requiresDestructiveConfirmation: false,
        });
        for (const override of [
            { previewTargetKey: "stale" },
            { baselineRevisionHash: "d".repeat(64) },
            { preview: planFixture({ planHash: "bad" }) },
            { preview: planFixture({ statements: [] }) },
            { preview: planFixture({ statements: ["one", "two"] }) },
            { mainDraftDirty: true },
            { isPreviewPending: true },
            { isApplying: true },
            { previewErrorMessage: "failed" },
            { operationState: "submitted" as const },
            { issues: [{ path: "name", message: "invalid" }] },
        ]) {
            expect(
                resolveClickHouseTableObjectSaveState(saveInput(override)).canSave,
            ).toBe(false);
        }
    });

    test("destructive plans require explicit confirmation collection", () => {
        expect(
            resolveClickHouseTableObjectSaveState(
                saveInput({
                    preview: planFixture({
                        destructive: true,
                        riskFlags: ["destructive"],
                        requiredConfirmation: "confirm",
                    }),
                }),
            ),
        ).toEqual({
            canSave: true,
            expectedPlanHash: "b".repeat(64),
            requiresDestructiveConfirmation: true,
        });
    });

    test("applied replaces baseline only with a returned real schema", () => {
        const remote = schemaFixture("d".repeat(64));
        expect(
            resolveClickHouseTableObjectResultTransition(
                resultFixture("applied", remote),
            ),
        ).toEqual({
            operationState: "idle",
            replaceBaseline: true,
            verifiedSchema: remote,
            conflictRemoteSchema: null,
            keepPendingObjectAction: false,
            invalidateSchema: true,
            blocksAutomaticRetry: false,
        });
        expect(
            resolveClickHouseTableObjectResultTransition(
                resultFixture("applied", null),
            ),
        ).toMatchObject({
            operationState: "outcomeUnknown",
            replaceBaseline: false,
            keepPendingObjectAction: true,
            blocksAutomaticRetry: true,
        });
    });

    test("submitted partial and unknown preserve action identity and block retry", () => {
        const remote = schemaFixture("e".repeat(64));
        expect(
            resolveClickHouseTableObjectResultTransition(
                resultFixture("submitted", null, "materialize"),
            ),
        ).toMatchObject({
            operationState: "submitted",
            replaceBaseline: false,
            keepPendingObjectAction: true,
            conflictRemoteSchema: null,
            blocksAutomaticRetry: true,
        });
        expect(
            resolveClickHouseTableObjectResultTransition(
                resultFixture("partiallyApplied", remote),
            ),
        ).toMatchObject({
            operationState: "partiallyApplied",
            conflictRemoteSchema: remote,
            keepPendingObjectAction: true,
            blocksAutomaticRetry: true,
        });
        expect(
            resolveClickHouseTableObjectResultTransition(
                resultFixture("outcomeUnknown", remote),
            ),
        ).toMatchObject({
            operationState: "outcomeUnknown",
            conflictRemoteSchema: remote,
            keepPendingObjectAction: true,
            blocksAutomaticRetry: true,
        });
    });

    test("conflict blocks retry while validation failure returns action for correction", () => {
        const conflict: IAppError = {
            code: "RESOURCE_CONFLICT",
            runtimeImpact: "businessOnly",
            message: "remote changed",
        };
        expect(
            resolveClickHouseTableObjectFailureTransition(conflict),
        ).toMatchObject({
            operationState: "conflict",
            keepPendingObjectAction: true,
            invalidateSchema: true,
            blocksAutomaticRetry: true,
        });
        const validation: IAppError = {
            code: "VALIDATION_FAILED",
            runtimeImpact: "businessOnly",
            message: "invalid name",
        };
        expect(
            resolveClickHouseTableObjectFailureTransition(validation),
        ).toMatchObject({
            operationState: "idle",
            keepPendingObjectAction: true,
            invalidateSchema: false,
            blocksAutomaticRetry: false,
        });
    });

    test("runtime state clones patches and resets pending object actions", () => {
        const tabId = "clickhouse-object-runtime";
        const store = useTabRuntimeStateStore.getState();
        store.removeTabRuntimeState(tabId);
        const action: ClickHouseTableObjectActionDraft = {
            objectKind: "index",
            operation: "create",
            name: "payload_bf",
            definition: {
                name: "payload_bf",
                expression: "payload",
                indexType: "tokenbf_v1",
                typeArguments: ["256", "2", "0"],
                granularity: "1",
            },
        };
        const state = store.getOrCreateClickHouseTableDesignState(tabId, {
            mode: "edit",
            draft: clickHouseSchemaToEditDraft(schemaFixture()),
            pendingObjectAction: action,
        });
        expect(state.mode).toBe("edit");
        if (state.mode !== "edit") throw new Error("expected edit state");
        expect(state.pendingObjectAction).toEqual(action);
        expect(state.pendingObjectAction).not.toBe(action);
        if (state.pendingObjectAction?.objectKind === "index") {
            expect(state.pendingObjectAction.definition?.typeArguments).not.toBe(
                action.definition?.typeArguments,
            );
        }

        store.patchClickHouseTableDesignState(tabId, {
            mode: "edit",
            pendingObjectAction: {
                objectKind: "projection",
                operation: "drop",
                name: "by_day",
                definition: null,
            },
        });
        store.resetClickHouseTableDesignDraft(tabId);
        const reset = useTabRuntimeStateStore.getState()
            .clickHouseTableDesignByTabId[tabId];
        expect(reset?.mode).toBe("edit");
        if (!reset || reset.mode !== "edit") throw new Error("expected edit state");
        expect(reset.pendingObjectAction).toBeNull();
        store.removeTabRuntimeState(tabId);
    });
});
