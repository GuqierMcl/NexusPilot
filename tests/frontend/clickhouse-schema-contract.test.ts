import { expect, test } from "bun:test";

import type { ClickHouseTableSchema } from "../../src/types/ipc";

const schema = {
    identity: {
        database: "analytics",
        name: "events",
        objectKind: "table",
        uuid: "00000000-0000-0000-0000-000000000001",
    },
    engine: {
        family: "ReplacingMergeTree",
        arguments: ["version"],
        rawExpression: "ReplacingMergeTree(version)",
    },
    columns: [
        {
            name: "id",
            typeName: "UInt64",
            position: 1,
            defaultKind: "none",
            defaultExpression: null,
            codecExpression: "CODEC(Delta, ZSTD(1))",
            ttlExpression: null,
            comment: "event id",
            editability: { mode: "editable", blockers: [] },
        },
        {
            name: "day",
            typeName: "Date",
            position: 2,
            defaultKind: "materialized",
            defaultExpression: "toDate(created_at)",
            codecExpression: null,
            ttlExpression: null,
            comment: null,
            editability: { mode: "editable", blockers: [] },
        },
    ],
    keys: {
        orderBy: "(tenant_id, id)",
        partitionBy: "toYYYYMM(created_at)",
        primaryKey: "(tenant_id, id)",
        sampleBy: "id",
    },
    tableTtl: "created_at + INTERVAL 90 DAY DELETE",
    comment: "events",
    settings: [
        { name: "index_granularity", value: "8192", explicit: true },
    ],
    projections: [
        {
            name: "by_day",
            query: "SELECT day, count() GROUP BY day",
            editability: { mode: "editable", blockers: [] },
        },
    ],
    skippingIndexes: [
        {
            name: "day_idx",
            expression: "day",
            indexType: "minmax",
            typeArguments: [],
            granularity: 1,
            editability: { mode: "editable", blockers: [] },
        },
    ],
    editability: { mode: "editable", blockers: [] },
    baseline: {
        canonicalCreateQuery: "CREATE TABLE analytics.events ENGINE = ReplacingMergeTree(version) ORDER BY (tenant_id, id)",
        revisionHash: "0".repeat(64),
    },
} satisfies ClickHouseTableSchema;

test("ClickHouse schema contract preserves native table semantics", () => {
    expect(schema.columns[0]?.typeName).toBe("UInt64");
    expect(schema.columns[1]?.defaultKind).toBe("materialized");
    expect(schema.engine.arguments.join(",")).toBe("version");
    expect(schema.editability.mode).toBe("editable");
    expect(schema.baseline.revisionHash.length).toBe(64);
});
