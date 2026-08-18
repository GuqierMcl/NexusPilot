import { describe, expect, test } from "bun:test";

import {
    getTabDisplayTitle,
    getTabTooltipTitle,
} from "../../../../src/features/workbench/content/components/content-tab-title";
import type { WorkbenchTab } from "../../../../src/store";
import type { StoredDatabaseConnection } from "../../../../src/types";

const connections = [
    { id: "profile-1", name: "mysql-local" },
] as StoredDatabaseConnection[];

function runtime() {
    return {
        profileId: "profile-1",
        driverName: "mysql",
        capabilities: {
            schemaBrowser: true,
            schemaMutator: true,
            dataTableBrowser: true,
            tableRowMutator: false,
            tableRowInserter: false,
            transactionManager: false,
            sqlExecutor: true,
            keyValueBrowser: false,
            graphQueryer: false,
            vectorSearcher: false,
        },
    };
}

describe("content tab titles", () => {
    test("adds connection suffix to SQL editor display title only", () => {
        const tab: WorkbenchTab = {
            id: "sql_editor::profile-1::tab",
            type: "sql_editor",
            title: "未命名查询",
            isDirty: false,
            isPinned: false,
            payload: {
                profileId: "profile-1",
                tabRuntimeId: "sql_editor::profile-1::tab",
                runtime: runtime(),
                savedQueryId: null,
                initialContext: { database: "traffic_monitor", schema: null },
            },
        };

        expect(getTabDisplayTitle(tab, connections)).toBe(
            "未命名查询 · mysql-local",
        );
        expect(tab.title).toBe("未命名查询");
    });

    test("uses full SQL title and connection in tooltip", () => {
        const tab: WorkbenchTab = {
            id: "sql_editor::saved::profile-1::query-1",
            type: "sql_editor",
            title: "Smoke Query",
            isDirty: false,
            isPinned: false,
            payload: {
                profileId: "profile-1",
                tabRuntimeId: "sql_editor::saved::profile-1::query-1",
                runtime: runtime(),
                savedQueryId: "query-1",
                initialContext: { database: "traffic_monitor", schema: null },
            },
        };

        expect(getTabTooltipTitle(tab, connections)).toBe(
            "Smoke Query · mysql-local",
        );
    });
});
