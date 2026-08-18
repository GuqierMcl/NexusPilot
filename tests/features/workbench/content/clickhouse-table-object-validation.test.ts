import { describe, expect, test } from "bun:test";

import {
    buildClickHouseTableObjectTarget,
    clickHouseTableObjectTargetKey,
    validateClickHouseProjectionDraft,
    validateClickHouseSkippingIndexDraft,
} from "../../../../src/features/workbench/content/components/clickhouse-table-design/clickhouse-table-object-validation";
import type {
    ClickHouseProjectionCreateDraft,
    ClickHouseSkippingIndexCreateDraft,
    ClickHouseTableObjectActionDraft,
} from "../../../../src/types/clickhouse-table-design";
import type { ClickHouseTableSchema } from "../../../../src/types/ipc";

function schemaFixture(): ClickHouseTableSchema {
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
        projections: [
            {
                name: "by_day",
                query: "SELECT day ORDER BY day",
                editability: { mode: "editable", blockers: [] },
            },
        ],
        skippingIndexes: [
            {
                name: "day_minmax",
                expression: "day",
                indexType: "minmax",
                typeArguments: [],
                granularity: 1,
                editability: { mode: "editable", blockers: [] },
            },
        ],
        editability: { mode: "editable", blockers: [] },
        baseline: {
            canonicalCreateQuery: "CREATE TABLE analytics.events ...",
            revisionHash: "a".repeat(64),
        },
    };
}

const projectionDraft: ClickHouseProjectionCreateDraft = {
    name: "by_tenant",
    query: "SELECT tenant_id, count() GROUP BY tenant_id",
};

const indexDraft = (
    indexType: ClickHouseSkippingIndexCreateDraft["indexType"],
    typeArguments: string[],
): ClickHouseSkippingIndexCreateDraft => ({
    name: "payload_idx",
    expression: "payload",
    indexType,
    typeArguments,
    granularity: "1",
});

describe("ClickHouse table-object validation", () => {
    test("accepts supported Projection grammar and all five index families", () => {
        const baseline = schemaFixture();
        expect(
            validateClickHouseProjectionDraft(projectionDraft, baseline),
        ).toEqual([]);
        for (const draft of [
            indexDraft("minmax", []),
            indexDraft("set", ["0"]),
            indexDraft("bloom_filter", ["0.01"]),
            indexDraft("ngrambf_v1", ["3", "256", "2", "0"]),
            indexDraft("tokenbf_v1", ["256", "2", "0"]),
        ]) {
            expect(validateClickHouseSkippingIndexDraft(draft, baseline)).toEqual(
                [],
            );
        }
    });

    test("rejects duplicate names invalid identifiers and unsupported Projection shapes", () => {
        const baseline = schemaFixture();
        expect(
            validateClickHouseProjectionDraft(
                { name: "by_day", query: "SELECT day" },
                baseline,
            ).map((issue) => issue.path),
        ).toContain("name");
        for (const draft of [
            { name: "bad-name", query: "SELECT day" },
            { name: "future", query: "SELECT day FROM events" },
            { name: "future", query: "SELECT day; SELECT id" },
            { name: "future", query: "SELECT (day" },
            { name: "future", query: "SELECT day -- comment" },
        ]) {
            expect(
                validateClickHouseProjectionDraft(draft, baseline).length,
            ).toBeGreaterThan(0);
        }
    });

    test("rejects unsafe index parameters blank expressions and lossy integers", () => {
        const baseline = schemaFixture();
        const invalid = [
            indexDraft("minmax", ["1"]),
            indexDraft("set", []),
            indexDraft("set", ["-1"]),
            indexDraft("set", ["9007199254740992"]),
            indexDraft("bloom_filter", ["0"]),
            indexDraft("bloom_filter", ["1"]),
            indexDraft("ngrambf_v1", ["0", "256", "2", "0"]),
            indexDraft("tokenbf_v1", ["256", "0", "0"]),
        ];
        invalid.push({ ...indexDraft("minmax", []), expression: "" });
        invalid.push({ ...indexDraft("minmax", []), granularity: "0" });
        invalid.push({
            ...indexDraft("minmax", []),
            granularity: "9007199254740992",
        });
        invalid.push({ ...indexDraft("minmax", []), name: "bad-name" });
        invalid.push({ ...indexDraft("minmax", []), name: "day_minmax" });

        for (const draft of invalid) {
            expect(
                validateClickHouseSkippingIndexDraft(draft, baseline).length,
            ).toBeGreaterThan(0);
        }
    });

    test("builds exact deterministic targets and refuses unknown readonly objects", () => {
        const baseline = schemaFixture();
        const actions: ClickHouseTableObjectActionDraft[] = [
            {
                objectKind: "projection",
                operation: "create",
                name: projectionDraft.name,
                definition: projectionDraft,
            },
            {
                objectKind: "projection",
                operation: "drop",
                name: "by_day",
                definition: null,
            },
            {
                objectKind: "index",
                operation: "create",
                name: "payload_idx",
                definition: indexDraft("tokenbf_v1", ["256", "2", "0"]),
            },
            {
                objectKind: "index",
                operation: "materialize",
                name: "day_minmax",
                definition: null,
            },
        ];
        const targets = actions.map((action) =>
            buildClickHouseTableObjectTarget(action, baseline),
        );

        expect(targets.map((target) => target.kind)).toEqual([
            "clickhouse_projection_create",
            "clickhouse_projection_drop",
            "clickhouse_skipping_index_create",
            "clickhouse_skipping_index_materialize",
        ]);
        expect(clickHouseTableObjectTargetKey(targets[0]!)).toBe(
            clickHouseTableObjectTargetKey(
                buildClickHouseTableObjectTarget(actions[0]!, {
                    ...baseline,
                    baseline: {
                        ...baseline.baseline,
                        revisionHash: "b".repeat(64),
                    },
                }),
            ),
        );

        baseline.projections[0]!.editability = {
            mode: "readonly",
            blockers: [{ code: "unknown", path: "query", message: "unknown" }],
        };
        expect(() =>
            buildClickHouseTableObjectTarget(actions[1]!, baseline),
        ).toThrow();
        expect(() =>
            buildClickHouseTableObjectTarget(
                {
                    objectKind: "index",
                    operation: "clear",
                    name: "missing",
                    definition: null,
                },
                baseline,
            ),
        ).toThrow();
    });
});
