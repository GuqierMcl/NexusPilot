import { describe, expect, test } from "bun:test";

import {
    CONTENT_TAB_LIFECYCLE_REGISTRY,
    buildClickHouseTableDesignTabOpenRequest,
    buildClickHouseViewDesignTabOpenRequest,
    buildKeyValueTabOpenRequest,
    buildPlaceholderTabOpenRequest,
    buildSavedQuerySqlEditorTabOpenRequest,
    buildTableDataTabOpenRequest,
    buildTableDesignTabOpenRequest,
    createWorkbenchTabFromOpenRequest,
    findExistingContentTabForOpenRequest,
    matchesContentTabContainer,
    retargetClickHouseTableDesignTabToEdit,
    retargetClickHouseViewDesignTabToEdit,
} from "../../src/features/workbench/content/content-tab-lifecycle-registry";
import type { WorkbenchTab } from "../../src/store";
import type { ConnectionRuntimeInfo, ContainerRef } from "../../src/types/ipc";
import type { SavedQuery } from "../../src/types/saved-queries";

const runtime = {
    profileId: "profile-1",
    driverName: "postgres",
    capabilities: {
        schemaBrowser: true,
        schemaMutator: true,
        dataTableBrowser: true,
        tableRowMutator: true,
        tableRowInserter: true,
        transactionManager: true,
        sqlExecutor: true,
        keyValueBrowser: false,
        graphQueryer: false,
        vectorSearcher: false,
    },
} satisfies ConnectionRuntimeInfo;

const tableContainer = {
    kind: "table",
    database: "app",
    schema: "public",
    table: "users",
} satisfies ContainerRef;

const savedQuery = {
    id: "query-1",
    profileId: "profile-1",
    title: "Active users",
    driver: "postgres",
    databaseName: " app ",
    schemaName: " public ",
    sqlText: "select * from users where active = true",
    createdAt: 1,
    updatedAt: 2,
} satisfies SavedQuery;

describe("content tab lifecycle registry", () => {
    test("registry covers every tab contract", () => {
        expect(Object.keys(CONTENT_TAB_LIFECYCLE_REGISTRY).sort()).toEqual([
            "clickhouse_table_design",
            "clickhouse_view_design",
            "dashboard",
            "graph_topology",
            "json_viewer",
            "key_value",
            "sql_editor",
            "table_data",
            "table_design",
        ]);
    });

    test("table data lifecycle derives stable id, title, payload, and de-duplication", () => {
        const request = buildTableDataTabOpenRequest(
            "profile-1",
            tableContainer,
            runtime,
        );

        expect(request.id).toBe(
            "table_data::profile-1::table::app::public::users",
        );
        expect(request.title).toBe("users");
        expect(request.payload).toEqual({
            profileId: "profile-1",
            tabRuntimeId: request.id,
            runtime,
            container: tableContainer,
        });

        const tab = createWorkbenchTabFromOpenRequest(request);

        expect(tab.type).toBe("table_data");
        expect(tab.isDirty).toBe(false);
        expect(tab.isPinned).toBe(false);
        expect(findExistingContentTabForOpenRequest([tab], request)?.id).toBe(
            request.id,
        );
    });

    test("key-value lifecycle derives selected-key-specific id and payload", () => {
        const request = buildKeyValueTabOpenRequest(
            "profile-1",
            2,
            "user:*",
            "user:1",
        );
        const tab = createWorkbenchTabFromOpenRequest(request);

        expect(request.id).toBe("key_value::profile-1::2::user:1");
        expect(tab).toEqual({
            id: "key_value::profile-1::2::user:1",
            type: "key_value",
            title: "Redis DB 2",
            isDirty: false,
            isPinned: false,
            payload: {
                profileId: "profile-1",
                dbIndex: 2,
                pattern: "user:*",
                selectedKey: "user:1",
            },
        });
    });

    test("saved SQL query lifecycle reuses saved-query identity and normalizes context", () => {
        const request = buildSavedQuerySqlEditorTabOpenRequest(
            savedQuery,
            runtime,
        );
        const tab = createWorkbenchTabFromOpenRequest(request);

        expect(request.id).toBe("sql_editor::saved::profile-1::query-1");
        expect(tab).toEqual({
            id: "sql_editor::saved::profile-1::query-1",
            type: "sql_editor",
            title: "Active users",
            isDirty: false,
            isPinned: false,
            payload: {
                profileId: "profile-1",
                tabRuntimeId: "sql_editor::saved::profile-1::query-1",
                runtime,
                savedQueryId: "query-1",
                initialContext: {
                    database: "app",
                    schema: "public",
                },
            },
        });

        const renamedExisting = {
            ...tab,
            id: "sql_editor::profile-1::temporary-before-save",
            payload: {
                ...tab.payload,
                tabRuntimeId: "sql_editor::profile-1::temporary-before-save",
            },
        } satisfies Extract<WorkbenchTab, { type: "sql_editor" }>;

        expect(
            findExistingContentTabForOpenRequest([renamedExisting], request)?.id,
        ).toBe("sql_editor::profile-1::temporary-before-save");
    });

    test("table design edit lifecycle de-duplicates equivalent containers", () => {
        const request = buildTableDesignTabOpenRequest("profile-1", {
            mode: "edit",
            container: tableContainer,
        });
        const tab = createWorkbenchTabFromOpenRequest(request);

        expect(request.id).toBe(
            "table_design::edit::profile-1::table::app::public::users",
        );
        expect(tab.title).toBe("users");
        expect(tab.payload).toEqual({
            profileId: "profile-1",
            tabRuntimeId:
                "table_design::edit::profile-1::table::app::public::users",
            mode: "edit",
            container: tableContainer,
            parentContainer: null,
        });

        const equivalentContainer = {
            kind: "table",
            database: "app",
            schema: "public",
            objectName: "users",
        } satisfies ContainerRef;
        const equivalentRequest = buildTableDesignTabOpenRequest("profile-1", {
            mode: "edit",
            container: equivalentContainer,
        });

        expect(
            findExistingContentTabForOpenRequest([tab], equivalentRequest)?.id,
        ).toBe(request.id);
    });

    test("ClickHouse table design lifecycle owns stable identity and equivalent containers", () => {
        const clickHouseContainer = {
            kind: "table",
            database: "analytics",
            table: "events",
        } satisfies ContainerRef;
        const request = buildClickHouseTableDesignTabOpenRequest("profile-1", {
            mode: "edit",
            container: clickHouseContainer,
        });
        const tab = createWorkbenchTabFromOpenRequest(request);

        expect(request.id).toBe(
            "clickhouse_table_design::edit::profile-1::analytics::events",
        );
        expect(request.title).toBe("events");
        expect(request.payload).toEqual({
            profileId: "profile-1",
            tabRuntimeId:
                "clickhouse_table_design::edit::profile-1::analytics::events",
            mode: "edit",
            container: clickHouseContainer,
            parentContainer: null,
        });

        const equivalentContainer = {
            kind: "table",
            database: "analytics",
            objectName: "events",
        } satisfies ContainerRef;
        const equivalentRequest = buildClickHouseTableDesignTabOpenRequest(
            "profile-1",
            { mode: "edit", container: equivalentContainer },
        );
        const legacyIdTab = {
            ...tab,
            id: "clickhouse_table_design::legacy::events",
        } satisfies Extract<
            WorkbenchTab,
            { type: "clickhouse_table_design" }
        >;

        expect(
            findExistingContentTabForOpenRequest(
                [legacyIdTab],
                equivalentRequest,
            )?.id,
        ).toBe(legacyIdTab.id);
        expect(
            matchesContentTabContainer(
                legacyIdTab,
                "profile-1",
                equivalentContainer,
            ),
        ).toBe(true);
    });

    test("ClickHouse create tabs are unique and retarget in place after verified create", () => {
        const parentContainer = {
            kind: "database",
            database: "analytics",
        } satisfies ContainerRef;
        const first = buildClickHouseTableDesignTabOpenRequest("profile-1", {
            mode: "create",
            parentContainer,
        });
        const second = buildClickHouseTableDesignTabOpenRequest("profile-1", {
            mode: "create",
            parentContainer,
        });
        expect(first.id).not.toBe(second.id);
        expect(
            first.id.startsWith(
                "clickhouse_table_design::create::profile-1::",
            ),
        ).toBe(true);
        expect(first.title).toBe("新建 ClickHouse 表 · analytics");
        expect(first.payload).toEqual({
            profileId: "profile-1",
            tabRuntimeId: first.id,
            mode: "create",
            container: null,
            parentContainer,
        });

        const tab = createWorkbenchTabFromOpenRequest(first);
        expect(findExistingContentTabForOpenRequest([tab], second)).toBeUndefined();

        const createdContainer = {
            kind: "table",
            database: "analytics",
            table: "events",
        } satisfies ContainerRef;
        const retargeted = retargetClickHouseTableDesignTabToEdit(
            [{ ...tab, isDirty: true }],
            tab.id,
            createdContainer,
        );
        expect(retargeted[0]).toEqual({
            ...tab,
            title: "events",
            isDirty: false,
            payload: {
                profileId: "profile-1",
                tabRuntimeId: first.id,
                mode: "edit",
                container: createdContainer,
                parentContainer: null,
            },
        });
    });

    test("ClickHouse edit dedupe includes profile database and table identity", () => {
        const container = {
            kind: "table",
            database: "analytics",
            table: "events",
        } satisfies ContainerRef;
        const first = buildClickHouseTableDesignTabOpenRequest("profile-1", {
            mode: "edit",
            container,
        });
        const tab = createWorkbenchTabFromOpenRequest(first);
        const same = buildClickHouseTableDesignTabOpenRequest("profile-1", {
            mode: "edit",
            container: { ...container },
        });
        expect(findExistingContentTabForOpenRequest([tab], same)?.id).toBe(
            first.id,
        );

        for (const [profileId, nextContainer] of [
            ["profile-2", container],
            ["profile-1", { ...container, database: "other" }],
            ["profile-1", { ...container, table: "other" }],
        ] as const) {
            const request = buildClickHouseTableDesignTabOpenRequest(profileId, {
                mode: "edit",
                container: nextContainer,
            });
            expect(
                findExistingContentTabForOpenRequest([tab], request),
            ).toBeUndefined();
        }
    });

    test("ClickHouse View create is unique and persistent edit de-duplicates by neutral identity", () => {
        const parentContainer = {
            kind: "database",
            database: "analytics",
        } satisfies ContainerRef;
        const first = buildClickHouseViewDesignTabOpenRequest("profile-1", {
            mode: "create",
            objectKind: "view",
            parentContainer,
        });
        const second = buildClickHouseViewDesignTabOpenRequest("profile-1", {
            mode: "create",
            objectKind: "view",
            parentContainer,
        });
        expect(first.id).not.toBe(second.id);
        expect(first.payload.ownerTabRuntimeId).toBeNull();
        expect(first.payload.tabRuntimeId).toBe(first.id);

        const createdContainer = {
            kind: "view",
            database: "analytics",
            table: "daily_events",
        } satisfies ContainerRef;
        const retargeted = retargetClickHouseViewDesignTabToEdit(
            [createWorkbenchTabFromOpenRequest(first)],
            first.id,
            createdContainer,
        );
        expect(retargeted[0]?.type).toBe("clickhouse_view_design");
        if (retargeted[0]?.type !== "clickhouse_view_design") {
            throw new Error("expected ClickHouse View design tab");
        }
        expect(retargeted[0].payload).toMatchObject({
            mode: "edit",
            container: createdContainer,
            ownerTabRuntimeId: null,
        });

        const edit = buildClickHouseViewDesignTabOpenRequest("profile-1", {
            mode: "edit",
            objectKind: "view",
            container: createdContainer,
        });
        const equivalent = buildClickHouseViewDesignTabOpenRequest("profile-1", {
            mode: "edit",
            objectKind: "view",
            container: { ...createdContainer, table: undefined, objectName: "daily_events" },
        });
        expect(
            findExistingContentTabForOpenRequest(
                [createWorkbenchTabFromOpenRequest(edit)],
                equivalent,
            )?.id,
        ).toBe(edit.id);
    });

    test("ClickHouse open requests validate mode-specific ownership", () => {
        for (const parentContainer of [
            { kind: "database" },
            { kind: "database", database: "analytics", schema: "public" },
            { kind: "table", database: "analytics", table: "events" },
        ] satisfies ContainerRef[]) {
            expect(() =>
                buildClickHouseTableDesignTabOpenRequest("profile-1", {
                    mode: "create",
                    parentContainer,
                }),
            ).toThrow();
        }
        for (const container of [
            { kind: "database", database: "analytics" },
            { kind: "table", database: "analytics" },
            { kind: "table", table: "events" },
            {
                kind: "table",
                database: "analytics",
                schema: "public",
                table: "events",
            },
        ] satisfies ContainerRef[]) {
            expect(() =>
                buildClickHouseTableDesignTabOpenRequest("profile-1", {
                    mode: "edit",
                    container,
                }),
            ).toThrow();
        }
    });

    test("reserved placeholder lifecycle creates registered placeholder tabs", () => {
        const request = buildPlaceholderTabOpenRequest("json_viewer", {
            id: "json_viewer::profile-1::doc-1",
            title: "Document Preview",
        });
        const tab = createWorkbenchTabFromOpenRequest(request);

        expect(tab).toEqual({
            id: "json_viewer::profile-1::doc-1",
            type: "json_viewer",
            title: "Document Preview",
            isDirty: false,
            isPinned: false,
            payload: {},
        });
        expect(findExistingContentTabForOpenRequest([tab], request)?.id).toBe(
            "json_viewer::profile-1::doc-1",
        );
    });
});
