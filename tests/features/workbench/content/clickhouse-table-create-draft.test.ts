import { describe, expect, test } from "bun:test";

import {
    clickHouseDraftToCreateTarget,
    clickHouseSchemaToCreateDraft,
    cloneClickHouseTableCreateDraft,
    createClickHouseTableDraft,
} from "../../../../src/features/workbench/content/components/clickhouse-table-design/clickhouse-table-create-draft";
import {
    clickHouseCreateTargetKey,
    hasClickHouseCreateErrors,
    validateClickHouseTableCreateDraft,
} from "../../../../src/features/workbench/content/components/clickhouse-table-design/clickhouse-table-create-validation";
import { useTabRuntimeStateStore } from "../../../../src/store";
import type {
    ClickHouseTableCreateDraft,
} from "../../../../src/types/clickhouse-table-design";
import type { ClickHouseTableSchema } from "../../../../src/types/ipc";

function validDraft(engineFamily = "MergeTree"): ClickHouseTableCreateDraft {
    const draft = createClickHouseTableDraft("analytics");
    draft.name = "events";
    draft.columns[0] = {
        ...draft.columns[0],
        name: "id",
        typeName: "UInt64",
        comment: "event id",
        codecs: [
            {
                id: "codec-1",
                name: "ZSTD",
                arguments: ["1"],
            },
        ],
    };
    draft.engineFamily = engineFamily;
    draft.engineArguments =
        engineFamily === "ReplacingMergeTree"
            ? ["version"]
            : engineFamily === "CollapsingMergeTree"
              ? ["sign"]
              : [];
    return draft;
}

describe("ClickHouse table create draft", () => {
    test("creates one blank column with a clean snapshot baseline", () => {
        const draft = createClickHouseTableDraft("analytics");
        expect(draft).toMatchObject({
            database: "analytics",
            name: "",
            engineFamily: "MergeTree",
            engineArguments: [],
            orderBy: "tuple()",
            partitionBy: "",
            primaryKey: "",
            sampleBy: "",
            tableTtl: "",
            settings: [],
            comment: "",
        });
        expect(draft.columns).toHaveLength(1);
        expect(draft.columns[0]).toMatchObject({
            name: "",
            typeName: "",
            defaultKind: "none",
            defaultExpression: "",
            codecs: [],
            ttlExpression: "",
            comment: "",
        });

        const tabId = "clickhouse-create-state";
        const store = useTabRuntimeStateStore.getState();
        store.removeTabRuntimeState(tabId);
        const state = store.getOrCreateClickHouseTableDesignState(tabId, {
            mode: "create",
            draft,
        });
        expect(state.mode).toBe("create");
        if (state.mode !== "create") {
            throw new Error("expected ClickHouse create runtime state");
        }
        expect(state.snapshot).toEqual(draft);
        expect(state.snapshot).not.toBe(state.draft);
        expect(state.snapshot.columns).not.toBe(state.draft.columns);

        const nestedDraft = validDraft("ReplacingMergeTree");
        nestedDraft.settings = [
            { id: "setting-1", name: "index_granularity", value: "8192" },
        ];
        const nestedTabId = "clickhouse-create-nested-state";
        store.removeTabRuntimeState(nestedTabId);
        const nestedState = store.getOrCreateClickHouseTableDesignState(
            nestedTabId,
            { mode: "create", draft: nestedDraft },
        );
        if (nestedState.mode !== "create") {
            throw new Error("expected ClickHouse create runtime state");
        }
        nestedState.draft.columns[0].codecs[0].arguments[0] = "3";
        nestedState.draft.engineArguments[0] = "changed_version";
        nestedState.draft.settings[0].value = "4096";
        expect(nestedState.snapshot.columns[0].codecs[0].arguments[0]).toBe(
            "1",
        );
        expect(nestedState.snapshot.engineArguments[0]).toBe("version");
        expect(nestedState.snapshot.settings[0].value).toBe("8192");

        const changed = cloneClickHouseTableCreateDraft(state.draft);
        changed.name = "changed";
        changed.columns[0].name = "id";
        store.patchClickHouseTableDesignState(tabId, {
            mode: "create",
            draft: changed,
        });
        store.resetClickHouseTableDesignDraft(tabId);
        expect(
            useTabRuntimeStateStore.getState().clickHouseTableDesignByTabId[
                tabId
            ]?.draft,
        ).toEqual(draft);
        store.removeTabRuntimeState(tabId);
        store.removeTabRuntimeState(nestedTabId);
        expect(
            useTabRuntimeStateStore.getState().clickHouseTableDesignByTabId[
                tabId
            ],
        ).toBeUndefined();
    });

    test("maps ordered structured draft fields without UI ids or byte rewriting", () => {
        const draft = validDraft("ReplacingMergeTree");
        draft.database = " analytics ";
        draft.name = " events ";
        draft.columns.push({
            id: "column-2",
            name: "created_at",
            typeName: "DateTime64(3, 'UTC')",
            defaultKind: "default",
            defaultExpression: " now64(3) ",
            codecs: [],
            ttlExpression: "created_at + INTERVAL 7 DAY",
            comment: "",
        });
        draft.partitionBy = "toYYYYMM(created_at)";
        draft.primaryKey = "id";
        draft.sampleBy = "id";
        draft.tableTtl = "created_at + INTERVAL 30 DAY DELETE";
        draft.settings = [
            { id: "setting-1", name: "index_granularity", value: "8192" },
        ];
        const target = clickHouseDraftToCreateTarget(draft);

        expect(target.database).toBe(" analytics ");
        expect(target.name).toBe(" events ");
        expect(target.columns.map((column) => column.name)).toEqual([
            "id",
            "created_at",
        ]);
        expect(target.columns[1]?.defaultExpression).toBe(" now64(3) ");
        expect(target.columns[1]?.comment).toBeNull();
        expect(target.engine).toEqual({
            family: "ReplacingMergeTree",
            arguments: ["version"],
        });
        expect(JSON.stringify(target)).not.toContain("column-2");
        expect(JSON.stringify(target)).not.toContain("setting-1");
        expect(clickHouseCreateTargetKey(target)).toBe(JSON.stringify(target));
        expect(clickHouseCreateTargetKey(target)).toBe(
            clickHouseCreateTargetKey(clickHouseDraftToCreateTarget(draft)),
        );
    });

    test("hydrates only the supported backend codec renderer shape", () => {
        const schema: ClickHouseTableSchema = {
            identity: {
                database: "analytics",
                name: "events",
                objectKind: "table",
                uuid: "server-id",
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
            ],
            keys: {
                orderBy: "id",
                partitionBy: null,
                primaryKey: null,
                sampleBy: null,
            },
            tableTtl: null,
            comment: null,
            settings: [
                { name: "index_granularity", value: "8192", explicit: true },
                { name: "server_default", value: "1", explicit: false },
            ],
            projections: [],
            skippingIndexes: [],
            editability: { mode: "editable", blockers: [] },
            baseline: {
                canonicalCreateQuery: "server canonical",
                revisionHash: "a".repeat(64),
            },
        };
        const draft = clickHouseSchemaToCreateDraft(schema);
        expect(draft.columns[0]?.codecs.map(({ name, arguments: args }) => ({
            name,
            arguments: args,
        }))).toEqual([
            { name: "Delta", arguments: [] },
            { name: "ZSTD", arguments: ["1"] },
        ]);
        expect(draft.settings).toHaveLength(1);
        expect(() =>
            clickHouseSchemaToCreateDraft({
                ...schema,
                columns: [
                    {
                        ...schema.columns[0],
                        codecExpression: "CODEC(FUTURE(1))",
                    },
                ],
            }),
        ).toThrow();
    });
});

describe("ClickHouse create validation", () => {
    test("reports required, duplicate, pairing, engine and expression boundaries", () => {
        const draft = validDraft();
        draft.database = "";
        draft.name = "";
        draft.columns.push({ ...draft.columns[0], id: "duplicate" });
        draft.columns[0].typeName = "";
        draft.columns[0].defaultKind = "default";
        draft.columns[0].defaultExpression = "";
        draft.engineFamily = "ReplicatedMergeTree";
        draft.engineArguments = [""];
        draft.orderBy = "id; DROP TABLE events";
        draft.partitionBy = "tuple(id]";

        const issues = validateClickHouseTableCreateDraft(draft);
        expect(issues.map(({ path }) => path)).toEqual(
            expect.arrayContaining([
                "database",
                "name",
                "columns.0.typeName",
                "columns.0.defaultExpression",
                "columns.1.name",
                "engineFamily",
                "engineArguments.0",
                "orderBy",
                "partitionBy",
            ]),
        );
        expect(hasClickHouseCreateErrors(issues)).toBe(true);

        const noColumns = validDraft();
        noColumns.columns = [];
        expect(
            validateClickHouseTableCreateDraft(noColumns).some(
                ({ path, code }) => path === "columns" && code === "required",
            ),
        ).toBe(true);
    });

    test("validates codec and setting allowlists and value domains", () => {
        const draft = validDraft();
        draft.columns[0].codecs = [
            { id: "bad", name: "UNKNOWN", arguments: [""] },
        ];
        draft.settings = [
            { id: "one", name: "index_granularity", value: "0" },
            { id: "two", name: "index_granularity", value: "8192" },
            { id: "three", name: "allow_nullable_key", value: "2" },
            { id: "four", name: "unknown", value: "1" },
        ];
        const paths = validateClickHouseTableCreateDraft(draft).map(
            ({ path }) => path,
        );
        expect(paths).toEqual(
            expect.arrayContaining([
                "columns.0.codecs.0.name",
                "columns.0.codecs.0.arguments.0",
                "settings.0.value",
                "settings.1.name",
                "settings.2.value",
                "settings.3.name",
            ]),
        );
    });

    test("accepts the real Phase 5B engine fixtures and quoted boundary tokens", () => {
        for (const family of [
            "MergeTree",
            "ReplacingMergeTree",
            "CollapsingMergeTree",
        ]) {
            const draft = validDraft(family);
            draft.columns[0].defaultKind = "default";
            draft.columns[0].defaultExpression =
                "map('semi;colon', 'comment--text', 'hash#text')";
            draft.settings = [
                { id: "s1", name: "index_granularity", value: "8192" },
                { id: "s2", name: "ttl_only_drop_parts", value: "1" },
            ];
            expect(validateClickHouseTableCreateDraft(draft)).toEqual([]);
        }
    });
});
