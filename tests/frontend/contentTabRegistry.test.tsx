import { expect, test } from "bun:test";
import { Eye, KeyRound, PanelsTopLeft, TableProperties } from "lucide-react";

import {
    CONTENT_TAB_REGISTRY,
    getContentTabDisplayTitle,
    getContentTabIcon,
    getContentTabTooltipTitle,
} from "../../src/features/workbench/content/content-tab-registry";
import type { WorkbenchTab } from "../../src/store";
import type { StoredDatabaseConnection } from "../../src/types";
import type { ConnectionRuntimeInfo } from "../../src/types/ipc";

const connections = [
    {
        id: "profile-1",
        name: "Analytics",
        driver: "postgres",
    },
] as StoredDatabaseConnection[];

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

test("content registry covers every tab contract", () => {
    expect(Object.keys(CONTENT_TAB_REGISTRY).sort()).toEqual([
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

test("registry preserves table-data icon and title behavior", () => {
    const tab = {
        id: "table-data-tab",
        type: "table_data",
        title: "users_view",
        isDirty: false,
        isPinned: false,
        payload: {
            profileId: "profile-1",
            tabRuntimeId: "table-data-tab",
            runtime,
            container: {
                kind: "view",
                database: "app",
                schema: "public",
                objectName: "users_view",
            },
        },
    } satisfies Extract<WorkbenchTab, { type: "table_data" }>;

    expect(getContentTabIcon(tab)).toBe(Eye);
    expect(getContentTabDisplayTitle(tab, connections)).toBe(
        "users_view · Analytics",
    );
    expect(getContentTabTooltipTitle(tab, connections)).toBe(
        "app.public.users_view · Analytics",
    );
});

test("registry preserves key-value icon and title behavior", () => {
    const tab = {
        id: "key-value-tab",
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
    } satisfies Extract<WorkbenchTab, { type: "key_value" }>;

    expect(getContentTabIcon(tab)).toBe(KeyRound);
    expect(getContentTabDisplayTitle(tab, connections)).toBe(
        "DB 2 · 前缀: user:* · Analytics",
    );
    expect(getContentTabTooltipTitle(tab, connections)).toBe(
        "DB 2 · 前缀: user:* · Analytics",
    );
});

test("registry exposes the ClickHouse table design surface", () => {
    const tab = {
        id: "clickhouse_table_design::edit::profile-1::analytics::events",
        type: "clickhouse_table_design",
        title: "events",
        isDirty: false,
        isPinned: false,
        payload: {
            profileId: "profile-1",
            tabRuntimeId:
                "clickhouse_table_design::edit::profile-1::analytics::events",
            mode: "edit",
            container: {
                kind: "table",
                database: "analytics",
                table: "events",
            },
        },
    } satisfies Extract<WorkbenchTab, { type: "clickhouse_table_design" }>;

    expect(getContentTabIcon(tab)).toBe(TableProperties);
    expect(getContentTabDisplayTitle(tab, connections)).toBe("events");
    expect(getContentTabTooltipTitle(tab, connections)).toBe("events");
});

test("registry exposes the dedicated ClickHouse View design surface", () => {
    const tab = {
        id: "clickhouse_view_design::edit::profile-1::view::analytics::daily_events",
        type: "clickhouse_view_design",
        title: "daily_events",
        isDirty: false,
        isPinned: false,
        payload: {
            profileId: "profile-1",
            tabRuntimeId:
                "clickhouse_view_design::edit::profile-1::view::analytics::daily_events",
            mode: "edit",
            container: {
                kind: "view",
                database: "analytics",
                table: "daily_events",
            },
            ownerTabRuntimeId: null,
        },
    } satisfies Extract<WorkbenchTab, { type: "clickhouse_view_design" }>;

    expect(getContentTabIcon(tab)).toBe(PanelsTopLeft);
    expect(getContentTabDisplayTitle(tab, connections)).toBe("daily_events");
    expect(getContentTabTooltipTitle(tab, connections)).toBe("daily_events");
});
