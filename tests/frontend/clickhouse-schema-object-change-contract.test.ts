import { expect, test } from "bun:test";

import type {
    ClickHouseProjectionChangeResult,
    ClickHouseSkippingIndexChangeResult,
    ClickHouseTableSchema,
    NativeSchemaChangeResult,
    NativeSchemaChangeTarget,
} from "../../src/types/ipc";

const baseline: ClickHouseTableSchema = {
    identity: {
        database: "analytics",
        name: "events",
        objectKind: "table",
        uuid: null,
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

const projectionCreate = {
    kind: "clickhouse_projection_create",
    target: {
        baseline,
        projection: {
            name: "by_tenant",
            query: "SELECT tenant_id, count() GROUP BY tenant_id",
        },
    },
} satisfies NativeSchemaChangeTarget;

const projectionAction = (kind: "drop" | "materialize" | "clear") =>
    ({
        kind: `clickhouse_projection_${kind}`,
        target: { baseline, projectionName: "by_tenant" },
    }) satisfies NativeSchemaChangeTarget;

const indexCreate = {
    kind: "clickhouse_skipping_index_create",
    target: {
        baseline,
        index: {
            name: "payload_bf",
            expression: "payload",
            indexType: "tokenbf_v1",
            typeArguments: ["256", "2", "0"],
            granularity: 1,
        },
    },
} satisfies NativeSchemaChangeTarget;

const indexAction = (kind: "drop" | "materialize" | "clear") =>
    ({
        kind: `clickhouse_skipping_index_${kind}`,
        target: { baseline, indexName: "payload_bf" },
    }) satisfies NativeSchemaChangeTarget;

function objectName(target: NativeSchemaChangeTarget): string {
    switch (target.kind) {
        case "clickhouse_projection_create":
            return target.target.projection.name;
        case "clickhouse_projection_drop":
        case "clickhouse_projection_materialize":
        case "clickhouse_projection_clear":
            return target.target.projectionName;
        case "clickhouse_skipping_index_create":
            return target.target.index.name;
        case "clickhouse_skipping_index_drop":
        case "clickhouse_skipping_index_materialize":
        case "clickhouse_skipping_index_clear":
            return target.target.indexName;
        case "clickhouse_table_alter":
            return target.target.desired.name;
        case "clickhouse_table_drop":
            return target.target.container.table ?? "";
        case "clickhouse_database_drop":
            return target.target.container.database ?? "";
        case "clickhouse_column_clear":
        case "clickhouse_column_materialize":
            return target.target.columnName;
        default: {
            const unreachable: never = target;
            return unreachable;
        }
    }
}

test("Phase 5D object targets preserve all eight tags and camelCase fields", () => {
    const targets: NativeSchemaChangeTarget[] = [
        projectionCreate,
        projectionAction("drop"),
        projectionAction("materialize"),
        projectionAction("clear"),
        indexCreate,
        indexAction("drop"),
        indexAction("materialize"),
        indexAction("clear"),
    ];

    expect(targets.map(objectName)).toEqual([
        "by_tenant",
        "by_tenant",
        "by_tenant",
        "by_tenant",
        "payload_bf",
        "payload_bf",
        "payload_bf",
        "payload_bf",
    ]);
    expect(projectionCreate.target.projection.name).toBe("by_tenant");
    expect(indexCreate.target.index.typeArguments).toEqual(["256", "2", "0"]);
});

test("Phase 5D results keep concrete tags and exact operation union", () => {
    const progress = {
        appliedCount: 1,
        failedStatementIndex: null,
        remainingCount: 0,
        queryIds: ["query-1"],
    };
    const projection: ClickHouseProjectionChangeResult = {
        status: "applied",
        progress,
        container: { kind: "table", database: "analytics", table: "events" },
        projectionName: "by_tenant",
        operation: "create",
        schema: baseline,
    };
    const index: ClickHouseSkippingIndexChangeResult = {
        status: "submitted",
        progress,
        container: projection.container,
        indexName: "payload_bf",
        operation: "materialize",
        schema: baseline,
    };
    const results: NativeSchemaChangeResult[] = [
        { kind: "clickhouse_projection_change", result: projection },
        { kind: "clickhouse_skipping_index_change", result: index },
    ];

    expect(results.map(({ result }) => result.operation)).toEqual([
        "create",
        "materialize",
    ]);
});
