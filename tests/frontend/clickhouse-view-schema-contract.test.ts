import { expect, test } from "bun:test";

import type {
    ClickHouseViewFamily,
    ClickHouseViewFamilyDefinition,
    ClickHouseViewSchema,
    ClickHouseViewScope,
    NativeSchemaChangeBaseline,
    NativeSchemaChangeResult,
    NativeSchemaChangeTarget,
    NativeSchemaExecuteCreateRequest,
    NativeSchemaMutationPreview,
    NativeSchemaCreateResult,
    NativeSchemaCreateTarget,
    NativeSchemaSupportRequest,
} from "../../src/types/ipc";

function familyLabel(family: ClickHouseViewFamily): string {
    switch (family) {
        case "normal":
        case "parameterized":
        case "temporary":
        case "materialized":
        case "refreshable_materialized":
        case "window":
        case "live":
            return family;
        default: {
            const unreachable: never = family;
            return unreachable;
        }
    }
}

function definitionLabel(definition: ClickHouseViewFamilyDefinition): ClickHouseViewFamily {
    switch (definition.kind) {
        case "normal":
        case "parameterized":
        case "temporary":
        case "materialized":
        case "refreshable_materialized":
        case "window":
        case "live":
            return definition.kind;
        default: {
            const unreachable: never = definition;
            return unreachable;
        }
    }
}

test("ClickHouse View contract enumerates all seven stable families", () => {
    const families: ClickHouseViewFamily[] = [
        "normal",
        "parameterized",
        "temporary",
        "materialized",
        "refreshable_materialized",
        "window",
        "live",
    ];
    const parameterized: ClickHouseViewFamilyDefinition = {
        kind: "parameterized",
        value: {
            parameters: [
                { name: "tenant", typeName: "UInt64", occurrences: 2 },
            ],
        },
    };
    const definitions: ClickHouseViewFamilyDefinition[] = [
        { kind: "normal" },
        parameterized,
        { kind: "temporary" },
        {
            kind: "materialized",
            value: {
                storage: {
                    kind: "to_table",
                    value: {
                        target: {
                            kind: "table",
                            database: "analytics",
                            table: "events_sink",
                        },
                        targetColumns: ["tenant"],
                    },
                },
                populate: false,
            },
        },
        {
            kind: "refreshable_materialized",
            value: {
                storage: {
                    kind: "inner_table",
                    value: {
                        engine: { family: "MergeTree", arguments: [] },
                        orderBy: "tuple()",
                        partitionBy: null,
                        settings: [],
                    },
                },
                refresh: {
                    mode: "every",
                    interval: { value: 1, unit: "hour" },
                    offset: null,
                    randomizeFor: null,
                    dependencies: [],
                    settings: {
                        refreshRetries: null,
                        refreshRetryInitialBackoffMs: null,
                        refreshRetryMaxBackoffMs: null,
                        allReplicas: null,
                    },
                },
                append: false,
                empty: false,
            },
        },
        {
            kind: "window",
            value: {
                destination: null,
                innerEngine: null,
                resultEngine: null,
                watermark: { kind: "strictly_ascending" },
                allowedLateness: null,
                populate: false,
                timeWindowFunction: "tumble",
            },
        },
        {
            kind: "live",
            value: {
                timeoutSeconds: null,
                refreshSeconds: null,
                canonicalLegacyOptions: [],
            },
        },
    ];

    expect(families.map(familyLabel)).toEqual(families);
    expect(definitions.map(definitionLabel)).toEqual(families);
    expect(parameterized.kind).toBe("parameterized");
});

test("temporary and support contracts expose logical ownership only", () => {
    const scope: ClickHouseViewScope = {
        kind: "temporary",
        value: {
            ownerTabRuntimeId: "tab-runtime-1",
            sessionState: "active",
        },
    };
    const request: NativeSchemaSupportRequest = {
        kind: "clickhouse_view",
        database: "analytics",
        clusterName: null,
    };

    expect(JSON.stringify(scope)).not.toContain("sessionId");
    expect(request.kind).toBe("clickhouse_view");
});

test("native View create change baseline and result tags remain exact", () => {
    const schema = null as unknown as ClickHouseViewSchema;
    const desired = {
        address: {
            database: "analytics",
            name: "events_view",
            objectKind: "view" as const,
        },
        family: "normal" as const,
        scope: { kind: "local" as const },
        columns: { kind: "none" as const },
        query: "SELECT 1",
        security: { definer: null, sqlSecurity: null },
        comment: null,
        familyDefinition: { kind: "normal" as const },
    };
    const create: NativeSchemaCreateTarget = {
        kind: "clickhouse_view",
        target: { desired, expectedSupportRevision: "a".repeat(64) },
    };
    const changes: NativeSchemaChangeTarget[] = [
        {
            kind: "clickhouse_view_alter",
            target: {
                baseline: schema,
                desired,
                expectedSupportRevision: "a".repeat(64),
            },
        },
        {
            kind: "clickhouse_view_rename",
            target: {
                baseline: schema,
                destination: { ...desired.address, name: "renamed_view" },
                expectedDestinationAbsenceRevision: "b".repeat(64),
                expectedSupportRevision: "a".repeat(64),
            },
        },
        {
            kind: "clickhouse_view_drop",
            target: {
                baseline: schema,
                expectedSupportRevision: "a".repeat(64),
            },
        },
    ];
    const baselines: NativeSchemaChangeBaseline[] = [
        { kind: "clickhouse_view", baseline: schema },
        {
            kind: "clickhouse_cluster_view",
            baseline: {
                clusterName: "analytics_cluster",
                topologyRevision: "c".repeat(64),
                nodes: [],
            },
        },
    ];
    const progress = {
        appliedCount: 1,
        failedStatementIndex: null,
        remainingCount: 0,
        queryIds: ["query-1"],
    };
    const createResult: NativeSchemaCreateResult = {
        kind: "clickhouse_view",
        result: {
            status: "applied",
            progress,
            container: {
                kind: "view",
                database: "analytics",
                table: "events_view",
            },
            schema: null,
            backgroundWork: null,
            clusterOutcome: null,
        },
    };
    const changeResult: NativeSchemaChangeResult = {
        kind: "clickhouse_view_change",
        result: {
            status: "applied",
            progress,
            operation: "rename",
            source: {
                kind: "view",
                database: "analytics",
                table: "events_view",
            },
            destination: {
                kind: "view",
                database: "analytics",
                table: "renamed_view",
            },
            schema: null,
            backgroundWork: null,
            clusterOutcome: null,
        },
    };

    expect(create.kind).toBe("clickhouse_view");
    expect(changes.map((target) => target.kind)).toEqual([
        "clickhouse_view_alter",
        "clickhouse_view_rename",
        "clickhouse_view_drop",
    ]);
    expect(baselines.map((baseline) => baseline.kind)).toEqual([
        "clickhouse_view",
        "clickhouse_cluster_view",
    ]);
    expect(createResult.kind).toBe("clickhouse_view");
    expect(changeResult.kind).toBe("clickhouse_view_change");
});

test("cluster create preview and execute carry the same full baseline", () => {
    const baseline: NativeSchemaChangeBaseline = {
        kind: "clickhouse_cluster_view",
        baseline: {
            clusterName: "analytics_cluster",
            topologyRevision: "e".repeat(64),
            nodes: [],
        },
    };
    const preview: NativeSchemaMutationPreview = {
        statements: [],
        warnings: [],
        destructive: false,
        longRunning: false,
        riskFlags: ["clusterNonAtomic"],
        requiredConfirmation: "typeObjectAndCluster",
        planHash: "f".repeat(64),
        baseline,
    };
    const request: NativeSchemaExecuteCreateRequest = {
        target: {
            kind: "clickhouse_view",
            target: null as never,
        },
        expectedPlanHash: preview.planHash,
        confirmation: null,
        baseline: preview.baseline,
    };

    expect(request.baseline?.kind).toBe("clickhouse_cluster_view");
});
