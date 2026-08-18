import { describe, expect, test } from "bun:test";

import {
    clickHouseEditDraftTargetKey,
    clickHouseEditDraftToAlterTarget,
    clickHouseSchemaToEditDraft,
    cloneClickHouseTableEditDraft,
} from "../../../../src/features/workbench/content/components/clickhouse-table-design/clickhouse-table-edit-draft";
import { validateClickHouseTableEditDraft } from "../../../../src/features/workbench/content/components/clickhouse-table-design/clickhouse-table-edit-validation";
import { useTabRuntimeStateStore } from "../../../../src/store";
import type { ClickHouseTableSchema } from "../../../../src/types/ipc";

function schemaFixture(): ClickHouseTableSchema {
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
                codecExpression: "CODEC(Delta, ZSTD(1))",
                ttlExpression: null,
                comment: "event id",
                editability: { mode: "editable", blockers: [] },
            },
            {
                name: "payload",
                typeName: "String",
                position: 2,
                defaultKind: "default",
                defaultExpression: "'{}'",
                codecExpression: null,
                ttlExpression: null,
                comment: null,
                editability: { mode: "editable", blockers: [] },
            },
        ],
        keys: {
            orderBy: "id",
            partitionBy: "tuple()",
            primaryKey: "id",
            sampleBy: null,
        },
        tableTtl: null,
        comment: "events table",
        settings: [
            { name: "index_granularity", value: "8192", explicit: true },
            { name: "server_default", value: "1", explicit: false },
        ],
        projections: [],
        skippingIndexes: [],
        editability: { mode: "editable", blockers: [] },
        baseline: {
            canonicalCreateQuery: "CREATE TABLE analytics.events ...",
            revisionHash: "a".repeat(64),
        },
    };
}

describe("ClickHouse table edit draft", () => {
    test("schema hydration keeps explicit source identity through rename and reorder", () => {
        const draft = clickHouseSchemaToEditDraft(schemaFixture());
        const payload = draft.table.columns.find(
            (column) => column.name === "payload",
        )!;
        expect(draft.sourceColumnNameById[payload.id]).toBe("payload");

        payload.name = "body";
        draft.table.columns.reverse();
        draft.table.columns.push({
            id: "new-column",
            name: "created_at",
            typeName: "DateTime64(3, 'UTC')",
            defaultKind: "default",
            defaultExpression: "now64(3)",
            codecs: [],
            ttlExpression: "",
            comment: "",
        });

        const target = clickHouseEditDraftToAlterTarget(draft);
        expect(target.columnRenames).toEqual([
            { from: "payload", to: "body" },
        ]);
        expect(target.desired.columns.map((column) => column.name)).toEqual(
            draft.table.columns.map((column) => column.name),
        );
        expect(target.columnRenames).not.toContainEqual({
            from: "id",
            to: "created_at",
        });
        expect(
            cloneClickHouseTableEditDraft(draft).sourceColumnNameById[
                "new-column"
            ],
        ).toBeNull();
    });

    test("drop and add never infer a rename from position or similarity", () => {
        const draft = clickHouseSchemaToEditDraft(schemaFixture());
        const payloadIndex = draft.table.columns.findIndex(
            (column) => column.name === "payload",
        );
        draft.table.columns.splice(payloadIndex, 1, {
            id: "replacement-column",
            name: "body",
            typeName: "String",
            defaultKind: "default",
            defaultExpression: "'{}'",
            codecs: [],
            ttlExpression: "",
            comment: "",
        });

        expect(clickHouseEditDraftToAlterTarget(draft).columnRenames).toEqual(
            [],
        );
    });

    test("clone and dirty identity include desired semantics and sorted explicit renames", () => {
        const draft = clickHouseSchemaToEditDraft(schemaFixture());
        const clone = cloneClickHouseTableEditDraft(draft);
        expect(clone).toEqual(draft);
        expect(clone).not.toBe(draft);
        expect(clone.table.columns).not.toBe(draft.table.columns);
        expect(clone.table.columns[0]?.codecs).not.toBe(
            draft.table.columns[0]?.codecs,
        );
        expect(clone.baseline).not.toBe(draft.baseline);
        expect(clone.sourceColumnNameById).not.toBe(
            draft.sourceColumnNameById,
        );

        const cleanKey = clickHouseEditDraftTargetKey(draft);
        clone.table.comment = "changed";
        expect(clickHouseEditDraftTargetKey(clone)).not.toBe(cleanKey);

        const payload = clone.table.columns.find(
            (column) => column.name === "payload",
        )!;
        const id = clone.table.columns.find((column) => column.name === "id")!;
        payload.name = "z_body";
        id.name = "a_id";
        expect(
            clickHouseEditDraftToAlterTarget(clone).columnRenames,
        ).toEqual([
            { from: "id", to: "a_id" },
            { from: "payload", to: "z_body" },
        ]);
    });

    test("runtime state owns edit snapshot, action and remote conflict without replacing the user draft", () => {
        const tabId = "clickhouse-edit-runtime";
        const store = useTabRuntimeStateStore.getState();
        store.removeTabRuntimeState(tabId);
        const draft = clickHouseSchemaToEditDraft(schemaFixture());
        const state = store.getOrCreateClickHouseTableDesignState(tabId, {
            mode: "edit",
            draft,
        });
        expect(state.mode).toBe("edit");
        if (state.mode !== "edit") {
            throw new Error("expected ClickHouse edit runtime state");
        }
        expect(state.snapshot).toEqual(draft);
        expect(state.snapshot).not.toBe(state.draft);
        expect(state.conflictRemoteSchema).toBeNull();
        expect(state.pendingColumnAction).toBeNull();

        const userDraft = cloneClickHouseTableEditDraft(state.draft);
        userDraft.table.comment = "local change";
        const actualRemote = schemaFixture();
        actualRemote.comment = "remote change";
        actualRemote.baseline.revisionHash = "b".repeat(64);
        store.patchClickHouseTableDesignState(tabId, {
            mode: "edit",
            draft: userDraft,
            conflictRemoteSchema: actualRemote,
            pendingColumnAction: {
                action: "clear",
                columnName: "payload",
            },
        });

        const partial = useTabRuntimeStateStore.getState()
            .clickHouseTableDesignByTabId[tabId];
        expect(partial?.mode).toBe("edit");
        if (!partial || partial.mode !== "edit") {
            throw new Error("expected ClickHouse edit runtime state");
        }
        expect(partial.draft).toEqual(userDraft);
        expect(partial.snapshot).toEqual(state.snapshot);
        expect(partial.conflictRemoteSchema).toEqual(actualRemote);

        store.resetClickHouseTableDesignDraft(tabId);
        const reset = useTabRuntimeStateStore.getState()
            .clickHouseTableDesignByTabId[tabId];
        expect(reset?.mode).toBe("edit");
        if (!reset || reset.mode !== "edit") {
            throw new Error("expected reset ClickHouse edit runtime state");
        }
        expect(reset.draft).toEqual(reset.snapshot);
        expect(reset.conflictRemoteSchema).toBeNull();
        expect(reset.pendingColumnAction).toBeNull();
        store.removeTabRuntimeState(tabId);
    });
});

describe("ClickHouse table edit validation", () => {
    test("reports no-op and immutable engine or key changes before preview", () => {
        const noOp = clickHouseSchemaToEditDraft(schemaFixture());
        expect(validateClickHouseTableEditDraft(noOp)).toContainEqual({
            path: "table",
            message: "表结构没有可提交的变更",
        });

        const immutable = clickHouseSchemaToEditDraft(schemaFixture());
        immutable.table.engineFamily = "ReplacingMergeTree";
        immutable.table.engineArguments = ["id"];
        immutable.table.orderBy = "tuple(id)";
        immutable.table.partitionBy = "toYYYYMM(id)";
        immutable.table.primaryKey = "tuple(id)";
        const paths = validateClickHouseTableEditDraft(immutable).map(
            (issue) => issue.path,
        );
        expect(paths).toEqual(
            expect.arrayContaining([
                "engineFamily",
                "engineArguments",
                "orderBy",
                "partitionBy",
                "primaryKey",
            ]),
        );
    });

    test("reports invalid columns, rename collisions, dependencies and actions", () => {
        const draft = clickHouseSchemaToEditDraft(schemaFixture());
        const payload = draft.table.columns.find(
            (column) => column.name === "payload",
        )!;
        payload.name = "id";
        payload.typeName = "FutureType(UInt64)";
        payload.codecs = [
            { id: "future-codec", name: "FutureCodec", arguments: [] },
        ];
        draft.table.settings.push({
            id: "future-setting",
            name: "future_setting",
            value: "1",
        });
        draft.baseline.projections.push({
            name: "by_id",
            query: "SELECT id ORDER BY id",
            editability: { mode: "readonly", blockers: [] },
        });
        draft.baseline.skippingIndexes.push({
            name: "payload_idx",
            expression: "payload",
            indexType: "bloom_filter",
            typeArguments: [],
            granularity: 1,
            editability: { mode: "readonly", blockers: [] },
        });

        const issues = validateClickHouseTableEditDraft(draft, {
            action: "materialize",
            columnName: "missing",
        });
        const paths = issues.map((issue) => issue.path);
        expect(paths).toEqual(
            expect.arrayContaining([
                "columns.1.name",
                "columns.1.typeName",
                "columns.1.codecs.0.name",
                "settings.1.name",
                "columnRenames",
                "baseline.projections",
                "baseline.skippingIndexes",
                "pendingColumnAction.columnName",
            ]),
        );
    });

    test("rejects renaming onto a baseline name even when that column is dropped", () => {
        const draft = clickHouseSchemaToEditDraft(schemaFixture());
        draft.table.columns = draft.table.columns.filter(
            (column) => column.name !== "id",
        );
        draft.table.columns[0]!.name = "id";

        expect(
            validateClickHouseTableEditDraft(draft).some(
                (issue) => issue.path === "columnRenames",
            ),
        ).toBe(true);
    });
});
