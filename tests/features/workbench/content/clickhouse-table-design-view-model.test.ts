import { describe, expect, test } from "bun:test";

import {
    buildClickHouseTableDesignViewModel,
    buildSchemaDesignRuntimeState,
} from "../../../../src/features/workbench/content/components/clickhouse-table-design/clickhouse-table-design-view-model";
import type { ClickHouseTableSchema } from "../../../../src/types/ipc";

const schemaFixture: ClickHouseTableSchema = {
    identity: {
        database: "analytics",
        name: "events",
        objectKind: "table",
        uuid: "4da97a0d-3791-4f6a-8b6b-225c337b84c1",
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
            codecExpression: null,
            ttlExpression: null,
            comment: "event identity",
            editability: { mode: "editable", blockers: [] },
        },
        {
            name: "version",
            typeName: "UInt64",
            position: 2,
            defaultKind: "default",
            defaultExpression: "1",
            codecExpression: "CODEC(Delta, ZSTD(1))",
            ttlExpression: null,
            comment: null,
            editability: { mode: "editable", blockers: [] },
        },
        {
            name: "created_at",
            typeName: "DateTime64(3, 'UTC')",
            position: 3,
            defaultKind: "default",
            defaultExpression: "now64(3)",
            codecExpression: null,
            ttlExpression: "created_at + INTERVAL 30 DAY",
            comment: null,
            editability: { mode: "editable", blockers: [] },
        },
    ],
    keys: {
        orderBy: "(id, created_at)",
        partitionBy: "toYYYYMM(created_at)",
        primaryKey: "id",
        sampleBy: null,
    },
    tableTtl: "created_at + INTERVAL 365 DAY DELETE",
    comment: "event stream",
    settings: [
        { name: "index_granularity", value: "8192", explicit: true },
    ],
    projections: [
        {
            name: "by_day",
            query: "SELECT toDate(created_at), count() GROUP BY toDate(created_at)",
            editability: { mode: "editable", blockers: [] },
        },
    ],
    skippingIndexes: [
        {
            name: "created_at_minmax",
            expression: "created_at",
            indexType: "minmax",
            typeArguments: [],
            granularity: 1,
            editability: {
                mode: "restricted",
                blockers: [
                    {
                        code: "unsupported_skip_index_write",
                        path: "skippingIndexes.created_at_minmax",
                        message: "Phase 5A 仅展示该索引。",
                    },
                ],
            },
        },
    ],
    editability: {
        mode: "restricted",
        blockers: [
            {
                code: "unsupported_skip_index_write",
                path: "skippingIndexes.created_at_minmax",
                message: "Phase 5A 仅展示该索引。",
            },
        ],
    },
    baseline: {
        canonicalCreateQuery: "CREATE TABLE analytics.events (...) ENGINE = ReplacingMergeTree(version)",
        revisionHash: "a".repeat(64),
    },
};

describe("ClickHouse table design view model", () => {
    test("preserves native schema facts in the five Phase 5A read-only sections", () => {
        const model = buildClickHouseTableDesignViewModel(schemaFixture);

        expect(model.title).toBe("analytics.events");
        expect(model.engineLabel).toBe("ReplacingMergeTree(version)");
        expect(model.columns.map((column) => column.name)).toEqual([
            "id",
            "version",
            "created_at",
        ]);
        expect(model.columns[1]?.codecExpression).toBe("CODEC(Delta, ZSTD(1))");
        expect(model.engine.arguments).toEqual(["version"]);
        expect(model.keys.orderBy).toBe("(id, created_at)");
        expect(model.keys.partitionBy).toBe("toYYYYMM(created_at)");
        expect(model.keys.primaryKey).toBe("id");
        expect(model.keys.sampleBy).toBeNull();
        expect(model.tableTtl).toBe("created_at + INTERVAL 365 DAY DELETE");
        expect(model.settings).toEqual(schemaFixture.settings);
        expect(model.projections).toEqual(schemaFixture.projections);
        expect(model.skippingIndexes).toEqual(schemaFixture.skippingIndexes);
        expect(model.blockers).toEqual(schemaFixture.editability.blockers);
        expect(model.sections.map((section) => section.id)).toEqual([
            "columns",
            "engine_keys",
            "ttl_settings",
            "projections",
            "skipping_indexes",
        ]);
        expect(model.readOnly).toBe(true);
        expect(model.revisionHash).toBe("a".repeat(64));
    });

    test("keeps the Phase 5A surface read-only even for an editable backend baseline", () => {
        const model = buildClickHouseTableDesignViewModel({
            ...schemaFixture,
            editability: { mode: "editable", blockers: [] },
        });

        expect(model.backendEditability).toBe("editable");
        expect(model.readOnly).toBe(true);
    });

    test("maps query and backend editability into the generic schema runtime state", () => {
        expect(buildSchemaDesignRuntimeState(null, null)).toEqual({
            mode: "edit",
            loadState: "loading",
            operationState: "idle",
            blockerCount: 0,
            errorMessage: null,
            isDirty: false,
        });
        expect(buildSchemaDesignRuntimeState(schemaFixture, null, true)).toEqual({
            mode: "edit",
            loadState: "loading",
            operationState: "idle",
            blockerCount: 0,
            errorMessage: null,
            isDirty: false,
        });
        expect(buildSchemaDesignRuntimeState(schemaFixture, null)).toEqual({
            mode: "edit",
            loadState: "restricted",
            operationState: "idle",
            blockerCount: 1,
            errorMessage: null,
            isDirty: false,
        });
        expect(
            buildSchemaDesignRuntimeState(
                { ...schemaFixture, editability: { mode: "readonly", blockers: [] } },
                null,
            ),
        ).toEqual({
            mode: "edit",
            loadState: "readonly",
            operationState: "idle",
            blockerCount: 0,
            errorMessage: null,
            isDirty: false,
        });
        expect(buildSchemaDesignRuntimeState(null, "catalog unavailable")).toEqual({
            mode: "edit",
            loadState: "error",
            operationState: "idle",
            blockerCount: 0,
            errorMessage: "catalog unavailable",
            isDirty: false,
        });
    });
});
