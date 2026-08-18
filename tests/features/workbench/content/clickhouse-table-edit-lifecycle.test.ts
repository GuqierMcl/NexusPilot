import { describe, expect, test } from "bun:test";

import {
    canRequestClickHouseEditPreview,
    resolveClickHouseEditFailureTransition,
    resolveClickHouseEditResultTransition,
    resolveClickHouseEditSaveState,
} from "../../../../src/features/workbench/content/components/clickhouse-table-design/clickhouse-table-edit-lifecycle";
import type {
    ClickHouseTableAlterResult,
    ClickHouseTableSchema,
    IAppError,
    NativeSchemaChangePlan,
} from "../../../../src/types/ipc";

function schemaFixture(revision = "a".repeat(64)): ClickHouseTableSchema {
    return {
        identity: {
            database: "analytics",
            name: "events",
            objectKind: "table",
            uuid: "table-uuid",
        },
        engine: {
            family: "MergeTree",
            arguments: [],
            rawExpression: "MergeTree",
        },
        columns: [
            {
                name: "id",
                typeName: "UInt64",
                position: 1,
                defaultKind: "none",
                defaultExpression: null,
                codecExpression: null,
                ttlExpression: null,
                comment: null,
                editability: { mode: "editable", blockers: [] },
            },
        ],
        keys: {
            orderBy: "id",
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
    const baseline = schemaFixture();
    return {
        statements: [
            "ALTER TABLE `analytics`.`events` COMMENT COLUMN `id` 'event id'",
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
                code: "comment_column",
                objectName: "id",
                destructive: false,
                longRunning: false,
            },
        ],
        baseline: { kind: "clickhouse_table", baseline },
        ...override,
    };
}

function saveInput(
    override: Partial<Parameters<typeof resolveClickHouseEditSaveState>[0]> =
        {},
): Parameters<typeof resolveClickHouseEditSaveState>[0] {
    return {
        targetKey: "current",
        previewTargetKey: "current",
        baselineRevisionHash: "a".repeat(64),
        preview: planFixture(),
        issues: [],
        isPreviewPending: false,
        previewErrorMessage: null,
        isApplying: false,
        hasConflict: false,
        operationState: "previewReady",
        ...override,
    };
}

function resultFixture(
    status: ClickHouseTableAlterResult["status"],
    schema: ClickHouseTableSchema | null,
): ClickHouseTableAlterResult {
    return {
        status,
        progress: {
            appliedCount: status === "partiallyApplied" ? 1 : 0,
            failedStatementIndex:
                status === "partiallyApplied" ? 1 : null,
            remainingCount: 0,
            queryIds: ["query-1"],
        },
        container: {
            kind: "table",
            database: "analytics",
            table: "events",
        },
        tableName: "events",
        schema,
    };
}

describe("ClickHouse table edit lifecycle", () => {
    test("terminal remote-fact states block automatic preview until explicit refresh", () => {
        for (const operationState of [
            "submitted",
            "partiallyApplied",
            "outcomeUnknown",
            "conflict",
        ] as const) {
            expect(
                canRequestClickHouseEditPreview({
                    enabled: true,
                    isDirty: true,
                    hasConflict: false,
                    operationState,
                }),
            ).toBe(false);
        }
        expect(
            canRequestClickHouseEditPreview({
                enabled: true,
                isDirty: true,
                hasConflict: false,
                operationState: "idle",
            }),
        ).toBe(true);
    });

    test("save requires a fresh plan and backend confirmation for destructive plans", () => {
        const safe = resolveClickHouseEditSaveState(saveInput());
        expect(safe).toEqual({
            canSave: true,
            expectedPlanHash: "b".repeat(64),
            requiresDestructiveConfirmation: false,
        });

        const destructive = resolveClickHouseEditSaveState(
            saveInput({
                preview: planFixture({
                    destructive: true,
                    riskFlags: ["destructive"],
                    requiredConfirmation: "confirm",
                }),
            }),
        );
        expect(destructive.canSave).toBe(true);
        expect(destructive.requiresDestructiveConfirmation).toBe(true);

        for (const override of [
            { previewTargetKey: "old" },
            { isPreviewPending: true },
            { isApplying: true },
            { hasConflict: true },
            { previewErrorMessage: "preview failed" },
            { issues: [{ path: "columns.0.name", message: "invalid" }] },
            { preview: planFixture({ operations: [] }) },
            {
                preview: planFixture({
                    baseline: {
                        kind: "clickhouse_database",
                        baseline: {
                            name: "analytics",
                            engine: "Atomic",
                            uuid: null,
                            objects: [],
                        },
                    },
                }),
            },
            { operationState: "outcomeUnknown" as const },
        ]) {
            expect(
                resolveClickHouseEditSaveState(saveInput(override)).canSave,
            ).toBe(false);
        }
    });

    test("applied replaces baseline only with a real verified schema", () => {
        const remote = schemaFixture("d".repeat(64));
        expect(
            resolveClickHouseEditResultTransition(
                resultFixture("applied", remote),
            ),
        ).toEqual({
            operationState: "idle",
            replaceBaseline: true,
            keepDirtyDraft: false,
            conflictRemoteSchema: null,
            verifiedSchema: remote,
            clearPendingColumnAction: true,
            invalidateSchema: false,
        });

        expect(
            resolveClickHouseEditResultTransition(
                resultFixture("applied", null),
            ),
        ).toMatchObject({
            operationState: "outcomeUnknown",
            replaceBaseline: false,
            keepDirtyDraft: true,
        });
    });

    test("submitted partial and unknown preserve draft and snapshot", () => {
        const remote = schemaFixture("e".repeat(64));
        const submitted = resolveClickHouseEditResultTransition(
            resultFixture("submitted", null),
        );
        expect(submitted).toMatchObject({
            operationState: "submitted",
            replaceBaseline: false,
            keepDirtyDraft: true,
            conflictRemoteSchema: null,
            clearPendingColumnAction: true,
            invalidateSchema: true,
        });

        const partial = resolveClickHouseEditResultTransition(
            resultFixture("partiallyApplied", remote),
        );
        expect(partial).toMatchObject({
            operationState: "partiallyApplied",
            replaceBaseline: false,
            keepDirtyDraft: true,
            conflictRemoteSchema: remote,
            verifiedSchema: null,
            invalidateSchema: true,
        });

        const unknown = resolveClickHouseEditResultTransition(
            resultFixture("outcomeUnknown", null),
        );
        expect(unknown).toMatchObject({
            operationState: "outcomeUnknown",
            replaceBaseline: false,
            keepDirtyDraft: true,
            conflictRemoteSchema: null,
            verifiedSchema: null,
            invalidateSchema: true,
        });
    });

    test("resource conflict keeps the accepted local draft for explicit refresh", () => {
        const error: IAppError = {
            code: "RESOURCE_CONFLICT",
            runtimeImpact: "businessOnly",
            message: "remote baseline changed",
        };
        expect(resolveClickHouseEditFailureTransition(error)).toEqual({
            operationState: "conflict",
            replaceBaseline: false,
            keepDirtyDraft: true,
            conflictRemoteSchema: null,
            verifiedSchema: null,
            clearPendingColumnAction: false,
            invalidateSchema: true,
            errorMessage: "资源冲突：remote baseline changed",
        });
    });
});
