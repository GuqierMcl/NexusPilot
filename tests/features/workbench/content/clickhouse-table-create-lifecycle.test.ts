import { describe, expect, test } from "bun:test";

import {
    resolveClickHouseCreateAppliedTransition,
    resolveClickHouseCreateFailureTransition,
    resolveClickHouseCreateSaveState,
} from "../../../../src/features/workbench/content/components/clickhouse-table-design/clickhouse-table-create-lifecycle";
import type {
    ClickHouseCreateTableResult,
    ClickHouseTableSchema,
    IAppError,
    NativeSchemaMutationPreview,
} from "../../../../src/types/ipc";

const previewFixture: NativeSchemaMutationPreview = {
    statements: [
        "CREATE TABLE `analytics`.`events` (`id` UInt64) ENGINE = MergeTree ORDER BY tuple()",
    ],
    warnings: [],
    destructive: false,
    longRunning: false,
    riskFlags: [],
    requiredConfirmation: "none",
    planHash: "a".repeat(64),
};

const schemaFixture: ClickHouseTableSchema = {
    identity: {
        database: "analytics",
        name: "events",
        objectKind: "table",
        uuid: "server-id",
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
            codecExpression: "CODEC(ZSTD(1))",
            ttlExpression: null,
            comment: null,
            editability: { mode: "editable", blockers: [] },
        },
    ],
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
        canonicalCreateQuery: previewFixture.statements[0],
        revisionHash: "b".repeat(64),
    },
};

describe("ClickHouse table create lifecycle", () => {
    test("enables save only for the current safe one-statement preview", () => {
        const ready = resolveClickHouseCreateSaveState({
            targetKey: "current",
            previewTargetKey: "current",
            preview: previewFixture,
            issues: [],
            isPreviewPending: false,
            previewErrorMessage: null,
            isApplying: false,
            operationState: "previewReady",
        });
        expect(ready.canSave).toBe(true);
        expect(ready.expectedPlanHash).toBe(previewFixture.planHash);

        const invalidCases = [
            { issues: [{ code: "required", path: "name", message: "required" }] },
            { isPreviewPending: true },
            { previewErrorMessage: "preview failed" },
            { previewTargetKey: "stale" },
            {
                preview: {
                    ...previewFixture,
                    statements: [...previewFixture.statements, "SELECT 1"],
                },
            },
            { preview: { ...previewFixture, destructive: true } },
            { preview: { ...previewFixture, longRunning: true } },
            { preview: { ...previewFixture, riskFlags: ["experimental" as const] } },
            { preview: { ...previewFixture, requiredConfirmation: "confirm" as const } },
            { preview: { ...previewFixture, planHash: "not-a-plan-hash" } },
            { isApplying: true },
            { operationState: "outcomeUnknown" as const },
        ];

        for (const override of invalidCases) {
            expect(
                resolveClickHouseCreateSaveState({
                    targetKey: "current",
                    previewTargetKey: "current",
                    preview: previewFixture,
                    issues: [],
                    isPreviewPending: false,
                    previewErrorMessage: null,
                    isApplying: false,
                    operationState: "previewReady",
                    ...override,
                }).canSave,
            ).toBe(false);
        }
    });

    test("uses the verified result container and real schema for the edit transition", () => {
        const result: ClickHouseCreateTableResult = {
            container: {
                kind: "table",
                database: "analytics",
                table: "events",
            },
            tableName: "events",
            schema: schemaFixture,
        };
        const transition = resolveClickHouseCreateAppliedTransition({
            tabId: "create-tab",
            result,
        });

        expect(transition.retarget).toEqual({
            tabId: "create-tab",
            container: result.container,
        });
        expect(transition.draft).toMatchObject({
            table: {
                database: "analytics",
                name: "events",
                engineFamily: "MergeTree",
            },
            baseline: schemaFixture,
        });
        expect(transition.snapshot).toEqual(transition.draft);
        expect(transition.snapshot).not.toBe(transition.draft);
        expect(transition.runtimeState).toEqual({
            mode: "edit",
            loadState: "ready",
            operationState: "idle",
            blockerCount: 0,
            errorMessage: null,
            isDirty: false,
        });
    });

    test("does not invent an editable draft when the verified schema cannot hydrate losslessly", () => {
        const result: ClickHouseCreateTableResult = {
            container: {
                kind: "table",
                database: "analytics",
                table: "events",
            },
            tableName: "events",
            schema: {
                ...schemaFixture,
                columns: [
                    {
                        ...schemaFixture.columns[0],
                        codecExpression: "CODEC(FUTURE(1))",
                    },
                ],
            },
        };

        const transition = resolveClickHouseCreateAppliedTransition({
            tabId: "create-tab",
            result,
        });
        expect(transition.draft).toBeNull();
        expect(transition.snapshot).toBeNull();
        expect(transition.retarget.container).toEqual(result.container);
    });

    test("keeps create identity and dirty state when the outcome is unknown", () => {
        const error: IAppError = {
            code: "OPERATION_OUTCOME_UNKNOWN",
            runtimeImpact: "retryable",
            message: "remote verification unavailable",
        };
        expect(resolveClickHouseCreateFailureTransition(error)).toEqual({
            container: null,
            mode: "create",
            operationState: "outcomeUnknown",
            isDirty: true,
            errorMessage:
                "操作结果待确认：remote verification unavailable",
        });
    });

    test("keeps the accepted preview retryable after a business failure", () => {
        const error: IAppError = {
            code: "RESOURCE_CONFLICT",
            runtimeImpact: "businessOnly",
            message: "table already exists",
        };
        expect(resolveClickHouseCreateFailureTransition(error)).toEqual({
            container: null,
            mode: "create",
            operationState: "previewReady",
            isDirty: true,
            errorMessage: "资源冲突：table already exists",
        });
    });
});
