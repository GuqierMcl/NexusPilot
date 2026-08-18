import { expect, test } from "bun:test";
import { join } from "node:path";

import { buildExecutionOverviewModel } from "../../../../src/features/workbench/status-bar/overlays/ExecutionOverviewDrawer";
import type {
    SqlEditorRuntimeState,
    WorkbenchTab,
} from "../../../../src/store";
import type { SqlExecutionSnapshot } from "../../../../src/types/ipc";

test("overview navigation only focuses a tab, opens details, and closes itself", async () => {
    const source = await Bun.file(
        join(
            import.meta.dir,
            "../../../../src/features/workbench/status-bar/overlays/ExecutionOverviewDrawer.tsx",
        ),
    ).text();

    expect(source).toContain("activateTab(tabId)");
    expect(source).toContain("executionDetailOpen: true");
    expect(source).toContain("closeExecutionOverview()");
    for (const forbidden of [
        "cancelSqlExecution",
        "startSqlExecution",
        "execute_sql",
        "Retry",
        "Save",
    ]) {
        expect(source).not.toContain(forbidden);
    }
});

test("overview keeps only existing execution targets and exposes neutral details", () => {
    const model = buildExecutionOverviewModel({
        requestedTabIds: ["tab-2", "missing", "tab-3"],
        tabs: [overviewSqlTab("tab-2"), overviewSqlTab("tab-3")],
        sqlEditorByTabId: {
            "tab-2": overviewSqlState(overviewSnapshot("running")),
            "tab-3": overviewSqlState(overviewSnapshot("failed")),
        },
        nowMs: 3_400,
    });

    expect(
        model.items.map((item) => [item.tabId, item.stateLabel]),
    ).toEqual([
        ["tab-2", "正在执行"],
        ["tab-3", "查询失败"],
    ]);
    expect(JSON.stringify(model)).not.toContain("SELECT");
});

function overviewSqlTab(tabId: string): WorkbenchTab {
    return {
        id: tabId,
        type: "sql_editor",
        title: tabId,
        isDirty: false,
        isPinned: false,
        payload: {
            profileId: "profile-1",
            tabRuntimeId: tabId,
            runtime: {
                profileId: "profile-1",
                driverName: "fake-db",
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
            },
        },
    };
}

function overviewSnapshot(
    state: "running" | "failed",
): SqlExecutionSnapshot {
    return {
        executionId: `execution-${state}`,
        queryId: `query-${state}`,
        tabId: `runtime-${state}`,
        state,
        revision: 2,
        statementClass: "read",
        startedAt: 1_000,
        finishedAt: state === "failed" ? 2_000 : null,
        progressAvailable: false,
        summary: null,
        outcome: null,
        failure:
            state === "failed"
                ? {
                      code: "VALIDATION_FAILED",
                      runtimeImpact: "businessOnly",
                      message: "failed",
                  }
                : null,
        cancelMessage: null,
    };
}

function overviewSqlState(
    activeExecution: SqlExecutionSnapshot,
): SqlEditorRuntimeState {
    return {
        sqlText: "",
        context: { database: null, schema: null },
        savedSnapshot: null,
        result: null,
        error: null,
        lastExecution: null,
        scriptBatch: null,
        activeExecution,
        lastOutcome: null,
        executionTimeline: [],
        executionOptions: { timeoutMs: 30_000, resultMode: "grid" },
        executionDetailOpen: false,
        page: 1,
        pageSize: 100,
        isSaveDialogOpen: false,
        resultPanelCollapsed: true,
        resultPanelSize: 35,
    };
}
