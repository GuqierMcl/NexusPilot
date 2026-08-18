import { expect, test } from "bun:test";

import {
    useAlterClickHouseTable,
    useDropClickHouseDatabase,
    useDropClickHouseTable,
    useExecuteClickHouseColumnAction,
    useExecuteClickHouseProjectionChange,
    useExecuteClickHouseSkippingIndexChange,
    usePreviewAlterClickHouseTable,
    usePreviewClickHouseColumnAction,
    usePreviewClickHouseProjectionChange,
    usePreviewClickHouseSkippingIndexChange,
    usePreviewDropClickHouseDatabase,
    usePreviewDropClickHouseTable,
} from "../../src/hooks/queries/use-db-metadata";

import type {
    ClickHouseAlterTableTarget,
    ClickHouseColumnActionResult,
    ClickHouseCreateTableTarget,
    ClickHouseDropDatabaseResult,
    ClickHouseDropTableResult,
    ClickHouseTableAlterResult,
    ClickHouseTableSchema,
    ErrorCode,
    NativeSchemaBackgroundWork,
    NativeSchemaChangePlan,
    NativeSchemaChangeResult,
    NativeSchemaChangeTarget,
    NativeSchemaExecuteChangeRequest,
    NativeSchemaExecutionStatus,
    NativeSchemaRequiredConfirmation,
    NativeSchemaRiskFlag,
    SchemaMutationOperation,
} from "../../src/types/ipc";

const schema: ClickHouseTableSchema = {
    identity: {
        database: "analytics",
        name: "events",
        objectKind: "table",
        uuid: "00000000-0000-0000-0000-000000000001",
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
        canonicalCreateQuery:
            "CREATE TABLE analytics.events ENGINE = MergeTree ORDER BY tuple()",
        revisionHash: "0".repeat(64),
    },
};

const desired = {
    database: "analytics",
    name: "events",
    columns: [],
    engine: { family: "MergeTree", arguments: [] },
    keys: schema.keys,
    tableTtl: null,
    comment: "changed",
    settings: [],
} satisfies ClickHouseCreateTableTarget;

const alter = {
    baseline: schema,
    desired,
    columnRenames: [{ from: "payload", to: "body" }],
} satisfies ClickHouseAlterTableTarget;

const alterTarget = {
    kind: "clickhouse_table_alter",
    target: alter,
} satisfies NativeSchemaChangeTarget;

const request = {
    target: alterTarget,
    baseline: { kind: "clickhouse_table", baseline: schema },
    expectedPlanHash: "a".repeat(64),
    confirmation: {
        accepted: true,
        objectName: null,
        clusterName: null,
    },
} satisfies NativeSchemaExecuteChangeRequest;

const plan = {
    statements: ["ALTER TABLE `analytics`.`events` MODIFY COMMENT 'changed'"],
    warnings: [],
    destructive: false,
    longRunning: false,
    riskFlags: [] satisfies NativeSchemaRiskFlag[],
    requiredConfirmation: "none" satisfies NativeSchemaRequiredConfirmation,
    planHash: request.expectedPlanHash,
    expectedTargetRevision: "b".repeat(64),
    operations: [
        {
            code: "modify_table_comment",
            objectName: "events",
            destructive: false,
            longRunning: false,
        },
    ],
    baseline: request.baseline,
} satisfies NativeSchemaChangePlan;

function resultKind(result: NativeSchemaChangeResult): string {
    switch (result.kind) {
        case "clickhouse_table_alter":
            return result.result.tableName;
        case "clickhouse_column_action":
            return result.result.columnName;
        case "clickhouse_table_drop":
            return result.result.tableName;
        case "clickhouse_database_drop":
            return result.result.name;
        case "clickhouse_projection_change":
            return result.result.projectionName;
        case "clickhouse_skipping_index_change":
            return result.result.indexName;
        default: {
            const unreachable: never = result;
            return unreachable;
        }
    }
}

test("native schema change contract preserves exact tags baselines and statuses", () => {
    const errors: ErrorCode[] = ["FEATURE_UNAVAILABLE", "PERMISSION_DENIED"];
    const operations: SchemaMutationOperation[] = ["rename"];
    const backgroundWork: NativeSchemaBackgroundWork = {
        kind: "distributedDdl",
        state: "submitted",
    };
    const targets: NativeSchemaChangeTarget[] = [
        alterTarget,
        {
            kind: "clickhouse_table_drop",
            target: {
                container: {
                    kind: "table",
                    database: "analytics",
                    table: "events",
                },
            },
        },
        {
            kind: "clickhouse_database_drop",
            target: {
                container: { kind: "database", database: "analytics" },
            },
        },
        {
            kind: "clickhouse_column_clear",
            target: { baseline: schema, columnName: "payload" },
        },
        {
            kind: "clickhouse_column_materialize",
            target: { baseline: schema, columnName: "payload" },
        },
    ];
    const statuses: NativeSchemaExecutionStatus[] = [
        "applied",
        "submitted",
        "partiallyApplied",
        "outcomeUnknown",
    ];

    expect(targets.length).toBe(5);
    expect(statuses.length).toBe(4);
    expect(plan.operations[0]?.objectName).toBe("events");
    expect(request.baseline.kind).toBe("clickhouse_table");
    expect(errors).toEqual(["FEATURE_UNAVAILABLE", "PERMISSION_DENIED"]);
    expect(operations).toEqual(["rename"]);
    expect(backgroundWork).toEqual({
        kind: "distributedDdl",
        state: "submitted",
    });
    expect(plan.requiredConfirmation).toBe("none");
    expect(request).not.toHaveProperty("confirmDestructive");
});

test("native schema change result variants remain concrete and exhaustive", () => {
    const progress = {
        appliedCount: 1,
        failedStatementIndex: null,
        remainingCount: 0,
        queryIds: ["query-1"],
    };
    const tableAlter: ClickHouseTableAlterResult = {
        status: "applied",
        progress,
        container: { kind: "table", database: "analytics", table: "events" },
        tableName: "events",
        schema,
    };
    const columnAction: ClickHouseColumnActionResult = {
        status: "submitted",
        progress,
        container: tableAlter.container,
        columnName: "payload",
        operation: "clear",
        schema,
    };
    const tableDrop: ClickHouseDropTableResult = {
        status: "applied",
        progress,
        container: tableAlter.container,
        tableName: "events",
        absent: true,
    };
    const databaseDrop: ClickHouseDropDatabaseResult = {
        status: "applied",
        progress,
        container: { kind: "database", database: "analytics" },
        name: "analytics",
        absent: true,
    };
    const results: NativeSchemaChangeResult[] = [
        { kind: "clickhouse_table_alter", result: tableAlter },
        { kind: "clickhouse_column_action", result: columnAction },
        { kind: "clickhouse_table_drop", result: tableDrop },
        { kind: "clickhouse_database_drop", result: databaseDrop },
    ];

    expect(results.map(resultKind).join(",")).toBe(
        "events,payload,events,analytics",
    );
});

test("native schema change hooks expose all four typed preview execute pairs", () => {
    expect(
        [
            usePreviewAlterClickHouseTable,
            useAlterClickHouseTable,
            usePreviewClickHouseColumnAction,
            useExecuteClickHouseColumnAction,
            usePreviewDropClickHouseTable,
            useDropClickHouseTable,
            usePreviewDropClickHouseDatabase,
            useDropClickHouseDatabase,
            usePreviewClickHouseProjectionChange,
            useExecuteClickHouseProjectionChange,
            usePreviewClickHouseSkippingIndexChange,
            useExecuteClickHouseSkippingIndexChange,
        ].every((hook) => typeof hook === "function"),
    ).toBe(true);
});
