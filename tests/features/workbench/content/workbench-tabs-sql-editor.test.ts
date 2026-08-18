import { describe, expect, test } from "bun:test";

import {
    findExistingSavedSqlEditorTab,
    retargetSqlEditorTab,
} from "../../../../src/features/workbench/content/content-tab-lifecycle-registry";
import type { WorkbenchTab } from "../../../../src/store/slices/workbench-tabs-slice";

function runtime() {
    return {
        profileId: "profile-1",
        driverName: "mysql",
        capabilities: {
            schemaBrowser: true,
            schemaMutator: false,
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

function sqlEditorTab(
    overrides: Partial<WorkbenchTab & { payload: WorkbenchTab["payload"] }>,
): WorkbenchTab {
    return {
        id: "sql_editor::profile-1::temp",
        type: "sql_editor",
        title: "未命名查询",
        isDirty: true,
        isPinned: false,
        payload: {
            profileId: "profile-1",
            tabRuntimeId: "sql_editor::profile-1::temp",
            runtime: runtime(),
            savedQueryId: null,
            initialContext: { database: null, schema: null },
        },
        ...overrides,
    } as WorkbenchTab;
}

describe("SQL editor tab save retargeting", () => {
    test("retargets an unnamed SQL editor tab to a saved query payload", () => {
        const tab = sqlEditorTab({});
        const [retargeted] = retargetSqlEditorTab(
            [tab],
            tab.id,
            "query-1",
            "Smoke query",
        );

        expect(retargeted?.title).toBe("Smoke query");
        expect(retargeted?.isDirty).toBe(false);
        expect(
            retargeted?.type === "sql_editor"
                ? retargeted.payload.savedQueryId
                : null,
        ).toBe("query-1");
    });

    test("can keep the tab dirty when save retargeting follows concurrent edits", () => {
        const tab = sqlEditorTab({});
        const [retargeted] = retargetSqlEditorTab(
            [tab],
            tab.id,
            "query-1",
            "Smoke query",
            { isDirty: true },
        );

        expect(retargeted?.isDirty).toBe(true);
    });

    test("finds a saved query tab by payload after first save retargeting", () => {
        const tab = sqlEditorTab({
            id: "sql_editor::profile-1::temp-after-save",
            payload: {
                profileId: "profile-1",
                tabRuntimeId: "sql_editor::profile-1::temp-after-save",
                runtime: runtime(),
                savedQueryId: "query-1",
                initialContext: { database: null, schema: null },
            },
        });

        expect(findExistingSavedSqlEditorTab([tab], "profile-1", "query-1")?.id)
            .toBe(tab.id);
        expect(findExistingSavedSqlEditorTab([tab], "profile-2", "query-1"))
            .toBeUndefined();
    });
});
