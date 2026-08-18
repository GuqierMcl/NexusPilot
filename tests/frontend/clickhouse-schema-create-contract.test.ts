import { expect, test } from "bun:test";

import type {
    ClickHouseCreateDatabaseResult,
    ClickHouseCreateTableResult,
    ClickHouseCreateTableTarget,
    ClickHouseExecuteCreateDatabaseRequest,
    ClickHouseExecuteCreateTableRequest,
    NativeSchemaCreateResult,
    NativeSchemaCreateTarget,
    NativeSchemaExecuteCreateRequest,
    NativeSchemaMutationPreview,
} from "../../src/types/ipc";

const tableTarget = {
    database: "analytics",
    name: "events",
    columns: [
        {
            name: "id",
            typeName: "UInt64",
            defaultKind: "none",
            defaultExpression: null,
            codecs: [{ name: "ZSTD", arguments: ["1"] }],
            ttlExpression: null,
            comment: "event id",
        },
    ],
    engine: { family: "MergeTree", arguments: [] },
    keys: {
        orderBy: "tuple()",
        partitionBy: null,
        primaryKey: null,
        sampleBy: null,
    },
    tableTtl: null,
    comment: null,
    settings: [],
} satisfies ClickHouseCreateTableTarget;

const preview = {
    statements: [
        "CREATE TABLE `analytics`.`events` (`id` UInt64) ENGINE = MergeTree ORDER BY tuple()",
    ],
    warnings: [],
    destructive: false,
    longRunning: false,
    riskFlags: [],
    requiredConfirmation: "none",
    planHash: "a".repeat(64),
} satisfies NativeSchemaMutationPreview;

test("native schema create contract preserves tagged targets and plan identity", () => {
    const databaseTarget: NativeSchemaCreateTarget = {
        kind: "clickhouse_database",
        target: { name: "analytics" },
    };
    const tableTaggedTarget: NativeSchemaCreateTarget = {
        kind: "clickhouse_table",
        target: tableTarget,
    };
    const execute: NativeSchemaExecuteCreateRequest = {
        target: tableTaggedTarget,
        expectedPlanHash: preview.planHash,
        confirmation: null,
    };
    const databaseExecute: ClickHouseExecuteCreateDatabaseRequest = {
        target: databaseTarget.target,
        expectedPlanHash: preview.planHash,
        confirmation: null,
    };
    const tableExecute: ClickHouseExecuteCreateTableRequest = {
        target: tableTarget,
        expectedPlanHash: preview.planHash,
        confirmation: null,
    };

    expect(databaseTarget.kind).toBe("clickhouse_database");
    expect(execute.target.kind).toBe("clickhouse_table");
    expect(databaseExecute.target.name).toBe("analytics");
    expect(tableExecute.target.columns[0]?.codecs[0]?.name).toBe("ZSTD");
    expect(preview.planHash.length).toBe(64);
    expect(preview.longRunning).toBe(false);
});

test("native schema create results remain discriminated and strongly typed", () => {
    const database: ClickHouseCreateDatabaseResult = {
        name: "analytics",
        container: { kind: "database", database: "analytics" },
    };
    const table: ClickHouseCreateTableResult = {
        container: {
            kind: "table",
            database: "analytics",
            table: "events",
        },
        tableName: "events",
        schema: {
            identity: {
                database: "analytics",
                name: "events",
                objectKind: "table",
                uuid: null,
            },
            engine: {
                family: "MergeTree",
                arguments: [],
                rawExpression: "MergeTree",
            },
            columns: [],
            keys: tableTarget.keys,
            tableTtl: null,
            comment: null,
            settings: [],
            projections: [],
            skippingIndexes: [],
            editability: { mode: "editable", blockers: [] },
            baseline: {
                canonicalCreateQuery: preview.statements[0] ?? "",
                revisionHash: "0".repeat(64),
            },
        },
    };
    const results: NativeSchemaCreateResult[] = [
        { kind: "clickhouse_database", result: database },
        { kind: "clickhouse_table", result: table },
    ];

    expect(JSON.stringify(results.map((result) => result.kind))).toBe(
        JSON.stringify(["clickhouse_database", "clickhouse_table"]),
    );
});
