import { describe, expect, test } from "bun:test";

import { activeContextStatusContributor } from "../../../../src/features/workbench/status-bar/contributors/active-context-status-contributor";
import { aiRuntimeWarningStatusContributor } from "../../../../src/features/workbench/status-bar/contributors/ai-runtime-warning-status-contributor";
import { connectionSummaryStatusContributor } from "../../../../src/features/workbench/status-bar/contributors/connection-summary-status-contributor";
import { connectionStatusContributor } from "../../../../src/features/workbench/status-bar/contributors/connection-status-contributor";
import { keyValueStatusContributor } from "../../../../src/features/workbench/status-bar/contributors/key-value-status-contributor";
import { readinessStatusContributor } from "../../../../src/features/workbench/status-bar/contributors/readiness-status-contributor";
import { schemaDesignStatusContributor } from "../../../../src/features/workbench/status-bar/contributors/schema-design-status-contributor";
import {
    formatJsonSafeBytes,
    formatJsonSafeCount,
    sqlEditorStatusContributor,
} from "../../../../src/features/workbench/status-bar/contributors/sql-editor-status-contributor";
import { tableDataStatusContributor } from "../../../../src/features/workbench/status-bar/contributors/table-data-status-contributor";
import { tableDesignStatusContributor } from "../../../../src/features/workbench/status-bar/contributors/table-design-status-contributor";
import { collectWorkbenchStatusItems } from "../../../../src/features/workbench/status-bar/status-bar-contributor-registry";
import { useWorkbenchStatusOverlayStore } from "../../../../src/features/workbench/status-bar/overlays/workbench-status-overlay-store";
import type { WorkbenchStatusContext } from "../../../../src/features/workbench/status-bar/types";
import {
    useTabRuntimeStateStore,
    type SqlEditorRuntimeState,
    type WorkbenchTab,
} from "../../../../src/store";
import type {
    ConnectionRuntimeInfo,
    ContainerRef,
    JsonSafeInteger,
    SqlExecutionSnapshot,
    SqlExecutionState,
} from "../../../../src/types/ipc";

function runtime(profileId = "profile-1"): ConnectionRuntimeInfo {
    return {
        profileId,
        driverName: "mysql",
        capabilities: {
            schemaBrowser: true,
            schemaMutator: true,
            dataTableBrowser: true,
            tableRowMutator: true,
            tableRowInserter: true,
            transactionManager: true,
            sqlExecutor: true,
            keyValueBrowser: true,
            graphQueryer: false,
            vectorSearcher: false,
        },
    };
}

function baseContext(activeTab: WorkbenchTab | null): WorkbenchStatusContext {
    return {
        activeTab,
        tabs: activeTab ? [activeTab] : [],
        connectionSessions: {},
        tabRuntimeState: {
            sqlEditorByTabId: {},
            tableDataByTabId: {},
            tableDesignByTabId: {},
            clickHouseTableDesignByTabId: {},
            clickHouseViewDesignByTabId: {},
            schemaDesignByTabId: {},
            keyValueByTabId: {},
        },
        layout: {
            leftSidebarCollapsed: false,
            rightSidebarCollapsed: false,
        },
        aiRuntime: {
            healthStatus: "unknown",
            isChecking: false,
            errorMessage: null,
        },
        agent: {
            composerSendBlocker: null,
        },
        cloud: null,
        nowMs: 0,
        actions: {
            focusTab: () => undefined,
            openSqlExecutionDetails: () => undefined,
            openExecutionOverview: () => undefined,
        },
    };
}

function attachRecordingActions(context: WorkbenchStatusContext) {
    const actionCalls = {
        focusTab: [] as string[],
        openSqlExecutionDetails: [] as string[],
        openExecutionOverview: [] as string[][],
    };
    context.actions = {
        focusTab: (tabId) => actionCalls.focusTab.push(tabId),
        openSqlExecutionDetails: (tabId) =>
            actionCalls.openSqlExecutionDetails.push(tabId),
        openExecutionOverview: (tabIds) =>
            actionCalls.openExecutionOverview.push(tabIds),
    };
    context.nowMs = 3_400;
    return Object.assign(context, { actionCalls });
}

function sqlTab(id = "sql-tab"): Extract<WorkbenchTab, { type: "sql_editor" }> {
    return {
        id,
        type: "sql_editor",
        title: "Query",
        isDirty: false,
        isPinned: false,
        payload: {
            profileId: "profile-1",
            tabRuntimeId: id,
            runtime: runtime(),
            savedQueryId: null,
            initialContext: {
                database: "app",
                schema: "public",
            },
        },
    };
}

function tableDataTab(
    container: ContainerRef,
): Extract<WorkbenchTab, { type: "table_data" }> {
    return {
        id: "table-tab",
        type: "table_data",
        title: "users",
        isDirty: false,
        isPinned: false,
        payload: {
            profileId: "profile-1",
            tabRuntimeId: "table-tab",
            runtime: runtime(),
            container,
        },
    };
}

function keyValueTab(): Extract<WorkbenchTab, { type: "key_value" }> {
    return {
        id: "redis-tab",
        type: "key_value",
        title: "Redis DB 0",
        isDirty: false,
        isPinned: false,
        payload: {
            profileId: "profile-1",
            dbIndex: 0,
            pattern: "user:*",
            selectedKey: undefined,
        },
    };
}

function clickHouseTableDesignTab(): Extract<
    WorkbenchTab,
    { type: "clickhouse_table_design" }
> {
    return {
        id: "clickhouse-design-tab",
        type: "clickhouse_table_design",
        title: "events",
        isDirty: false,
        isPinned: false,
        payload: {
            profileId: "profile-1",
            tabRuntimeId: "clickhouse-design-runtime",
            mode: "edit",
            container: {
                kind: "table",
                database: "analytics",
                table: "events",
            },
            parentContainer: null,
        },
    };
}

function clickHouseTableCreateTab(): Extract<
    WorkbenchTab,
    { type: "clickhouse_table_design" }
> {
    return {
        id: "clickhouse-create-tab",
        type: "clickhouse_table_design",
        title: "新建 ClickHouse 表 · analytics",
        isDirty: true,
        isPinned: false,
        payload: {
            profileId: "profile-1",
            tabRuntimeId: "clickhouse-create-tab",
            mode: "create",
            container: null,
            parentContainer: {
                kind: "database",
                database: "analytics",
            },
        },
    };
}

describe("status bar connection and context contributors", () => {
    test("returns no left-side status when there is no active tab", () => {
        const context = baseContext(null);

        expect(connectionStatusContributor.getItems(context)).toEqual([]);
        expect(activeContextStatusContributor.getItems(context)).toEqual([]);
    });

    test("shows connected active-tab session with ping", () => {
        const context = baseContext(sqlTab());
        context.connectionSessions["profile-1"] = {
            status: "connected",
            ping: 12,
        };

        expect(connectionStatusContributor.getItems(context)[0]).toMatchObject({
            id: "connection-status",
            area: "left",
            label: "已连接 · 12ms",
            tone: "success",
        });
    });

    test("shows SQL editor database and schema context", () => {
        const context = baseContext(sqlTab());

        expect(activeContextStatusContributor.getItems(context)[0]).toMatchObject({
            id: "active-context",
            area: "left",
            label: "app / public",
        });
    });

    test("shows table data database schema and table context", () => {
        const context = baseContext(
            tableDataTab({
                kind: "table",
                database: "app",
                schema: "public",
                table: "users",
            }),
        );

        expect(activeContextStatusContributor.getItems(context)[0]).toMatchObject({
            id: "active-context",
            area: "left",
            label: "app / public / users",
            width: "elastic",
        });
    });

    test("shows the ClickHouse schema database and table context", () => {
        const context = baseContext(clickHouseTableDesignTab());

        expect(activeContextStatusContributor.getItems(context)[0]).toMatchObject({
            id: "active-context",
            area: "left",
            label: "analytics / events",
            width: "elastic",
        });
    });

    test("shows Redis database and active key context", () => {
        const context = baseContext(keyValueTab());
        context.tabRuntimeState.keyValueByTabId["redis-tab"] = {
            cursor: 0,
            activeKey: "user:1",
            collapsedFolderIds: new Set(),
            collapsedFolderTreeKey: null,
            isPreviewCollapsed: false,
            stringPreviewMode: null,
            valueDraft: null,
            isCreateDialogOpen: false,
            createDraft: null,
            pendingDeleteTarget: null,
            pendingKeySwitch: null,
            pendingRefreshDiscard: null,
        };

        expect(activeContextStatusContributor.getItems(context)[0]).toMatchObject({
            id: "active-context",
            area: "left",
            label: "Redis DB 0 · user:1",
            width: "elastic",
        });
    });
});

describe("status bar active tab runtime contributors", () => {
    test("maps View background, cluster, session and restricted states into common status vocabulary", () => {
        const tab = {
            id: "view-design-tab",
            type: "clickhouse_view_design",
            title: "daily",
            isDirty: false,
            isPinned: false,
            payload: {
                profileId: "profile-1",
                tabRuntimeId: "view-design-tab",
                mode: "edit",
                container: {
                    kind: "view",
                    database: "analytics",
                    table: "daily",
                },
                ownerTabRuntimeId: null,
            },
        } satisfies Extract<WorkbenchTab, { type: "clickhouse_view_design" }>;
        for (const [operationState, label] of [
            ["backgroundRunning", "后台结构工作运行中"],
            ["submitted", "结构变更已提交"],
            ["partiallyApplied", "结构变更部分应用"],
            ["outcomeUnknown", "结构变更结果待确认"],
            ["conflict", "远端结构已变化"],
            ["clusterDrift", "集群结构已漂移"],
        ] as const) {
            const context = baseContext(tab);
            context.tabRuntimeState.schemaDesignByTabId[tab.id] = {
                mode: "edit",
                loadState: "ready",
                operationState,
                blockerCount: 0,
                errorMessage: null,
                isDirty: false,
            };
            expect(schemaDesignStatusContributor.getItems(context)[0]).toMatchObject({
                label,
            });
        }

        for (const [loadState, label] of [
            ["sessionExpired", "会话已过期"],
            ["restricted", "结构部分受限 · 1 项"],
            ["readonly", "结构只读 · 1 项阻断"],
        ] as const) {
            const context = baseContext(tab);
            context.tabRuntimeState.schemaDesignByTabId[tab.id] = {
                mode: "edit",
                loadState,
                operationState: "idle",
                blockerCount: 1,
                errorMessage: null,
                isDirty: false,
            };
            expect(schemaDesignStatusContributor.getItems(context)[0]).toMatchObject({
                label,
            });
        }
    });
    test("Phase 5D object operations reuse generic schema status wording", () => {
        for (const [operationState, label] of [
            ["submitted", "结构变更已提交"],
            ["outcomeUnknown", "结构变更结果待确认"],
            ["conflict", "远端结构已变化"],
        ] as const) {
            const context = baseContext(clickHouseTableDesignTab());
            context.tabRuntimeState.schemaDesignByTabId[
                "clickhouse-design-tab"
            ] = {
                mode: "edit",
                loadState: "ready",
                operationState,
                blockerCount: 0,
                errorMessage: null,
                isDirty: false,
            };
            expect(
                schemaDesignStatusContributor.getItems(context)[0],
            ).toMatchObject({ label, tone: "warning" });
        }
    });

    test("maps generic schema design states to the public status vocabulary", () => {
        const cases = [
            {
                loadState: "loading" as const,
                blockerCount: 0,
                errorMessage: null,
                label: "正在读取 ClickHouse 表结构",
                tone: "muted",
            },
            {
                loadState: "ready" as const,
                blockerCount: 0,
                errorMessage: null,
                label: "ClickHouse 表结构 · 只读基线",
                tone: "muted",
            },
            {
                loadState: "restricted" as const,
                blockerCount: 2,
                errorMessage: null,
                label: "表结构部分受限 · 2 项",
                tone: "warning",
            },
            {
                loadState: "readonly" as const,
                blockerCount: 3,
                errorMessage: null,
                label: "表结构只读 · 3 项阻断",
                tone: "warning",
            },
            {
                loadState: "error" as const,
                blockerCount: 0,
                errorMessage: "catalog unavailable",
                label: "表结构读取失败",
                tone: "error",
            },
        ];

        for (const expected of cases) {
            const context = baseContext(clickHouseTableDesignTab());
            context.tabRuntimeState.schemaDesignByTabId[
                "clickhouse-design-tab"
            ] = {
                mode: "edit",
                loadState: expected.loadState,
                operationState: "idle",
                blockerCount: expected.blockerCount,
                errorMessage: expected.errorMessage,
                isDirty: false,
            };

            expect(schemaDesignStatusContributor.getItems(context)[0]).toMatchObject({
                id: "schema-design-status",
                area: "left",
                label: expected.label,
                tone: expected.tone,
            });
        }
    });

    test("create operation state takes priority over load state", () => {
        const cases = [
            {
                operationState: "previewing" as const,
                label: "正在生成 DDL 预览",
                tone: "muted",
            },
            {
                operationState: "previewReady" as const,
                label: "DDL 预览已就绪",
                tone: "info",
            },
            {
                operationState: "applying" as const,
                label: "正在创建远端对象",
                tone: "info",
            },
            {
                operationState: "outcomeUnknown" as const,
                label: "创建结果待确认",
                tone: "warning",
            },
        ];
        for (const expected of cases) {
            const context = baseContext(clickHouseTableCreateTab());
            context.tabRuntimeState.schemaDesignByTabId[
                "clickhouse-create-tab"
            ] = {
                mode: "create",
                loadState: "error",
                operationState: expected.operationState,
                blockerCount: 0,
                errorMessage: "load state must not win",
                isDirty: true,
            };
            expect(schemaDesignStatusContributor.getItems(context)[0]).toMatchObject({
                id: "schema-design-status",
                label: expected.label,
                tone: expected.tone,
            });
        }
    });

    test("edit operation outcomes use generic schema wording in the public status bar", () => {
        const cases = [
            {
                operationState: "previewing" as const,
                label: "正在生成结构 DDL 预览",
                tone: "muted",
            },
            {
                operationState: "previewReady" as const,
                label: "结构 DDL 预览已就绪",
                tone: "info",
            },
            {
                operationState: "applying" as const,
                label: "正在应用结构变更",
                tone: "info",
            },
            {
                operationState: "submitted" as const,
                label: "结构变更已提交",
                tone: "warning",
            },
            {
                operationState: "partiallyApplied" as const,
                label: "结构变更部分应用",
                tone: "warning",
            },
            {
                operationState: "outcomeUnknown" as const,
                label: "结构变更结果待确认",
                tone: "warning",
            },
            {
                operationState: "conflict" as const,
                label: "远端结构已变化",
                tone: "warning",
            },
        ];

        for (const expected of cases) {
            const context = baseContext(clickHouseTableDesignTab());
            context.tabRuntimeState.schemaDesignByTabId[
                "clickhouse-design-tab"
            ] = {
                mode: "edit",
                loadState: "ready",
                operationState: expected.operationState,
                blockerCount: 0,
                errorMessage: "远端状态详情",
                isDirty: true,
            };
            expect(
                schemaDesignStatusContributor.getItems(context)[0],
            ).toMatchObject({
                id: "schema-design-status",
                label: expected.label,
                tone: expected.tone,
            });
        }
    });

    test("edit idle state exposes preview failures and validation blockers", () => {
        const context = baseContext(clickHouseTableDesignTab());
        context.tabRuntimeState.schemaDesignByTabId[
            "clickhouse-design-tab"
        ] = {
            mode: "edit",
            loadState: "ready",
            operationState: "idle",
            blockerCount: 0,
            errorMessage: "planner rejected the draft",
            isDirty: true,
        };
        expect(
            schemaDesignStatusContributor.getItems(context)[0],
        ).toMatchObject({
            label: "结构变更预览失败",
            title: "planner rejected the draft",
            tone: "error",
        });

        context.tabRuntimeState.schemaDesignByTabId[
            "clickhouse-design-tab"
        ] = {
            mode: "edit",
            loadState: "ready",
            operationState: "idle",
            blockerCount: 2,
            errorMessage: null,
            isDirty: true,
        };
        expect(
            schemaDesignStatusContributor.getItems(context)[0],
        ).toMatchObject({
            label: "结构编辑草稿 · 2 项待修正",
            tone: "warning",
        });
    });

    test("shows create draft validation and preview errors while idle", () => {
        const context = baseContext(clickHouseTableCreateTab());
        context.tabRuntimeState.schemaDesignByTabId[
            "clickhouse-create-tab"
        ] = {
            mode: "create",
            loadState: "ready",
            operationState: "idle",
            blockerCount: 2,
            errorMessage: null,
            isDirty: true,
        };
        expect(schemaDesignStatusContributor.getItems(context)[0]).toMatchObject({
            label: "结构创建草稿 · 2 项待修正",
            tone: "warning",
        });

        context.tabRuntimeState.schemaDesignByTabId[
            "clickhouse-create-tab"
        ] = {
            mode: "create",
            loadState: "ready",
            operationState: "idle",
            blockerCount: 0,
            errorMessage: "preview failed",
            isDirty: true,
        };
        expect(schemaDesignStatusContributor.getItems(context)[0]).toMatchObject({
            label: "DDL 预览生成失败",
            title: "preview failed",
            tone: "error",
        });
    });

    test("suppresses generic readiness while schema loading or blockers need attention", () => {
        for (const loadState of [
            "loading",
            "restricted",
            "readonly",
            "error",
        ] as const) {
            const context = baseContext(clickHouseTableDesignTab());
            context.tabRuntimeState.schemaDesignByTabId[
                "clickhouse-design-tab"
            ] = {
                mode: "edit",
                loadState,
                operationState: "idle",
                blockerCount: loadState === "loading" ? 0 : 1,
                errorMessage: loadState === "error" ? "failed" : null,
                isDirty: false,
            };

            expect(readinessStatusContributor.getItems(context)).toEqual([]);
        }
    });

    test("suppresses generic readiness for dirty or active schema create operations", () => {
        const context = baseContext(clickHouseTableCreateTab());
        context.tabRuntimeState.schemaDesignByTabId[
            "clickhouse-create-tab"
        ] = {
            mode: "create",
            loadState: "ready",
            operationState: "idle",
            blockerCount: 0,
            errorMessage: null,
            isDirty: true,
        };
        expect(readinessStatusContributor.getItems(context)).toEqual([]);

        context.tabRuntimeState.schemaDesignByTabId[
            "clickhouse-create-tab"
        ] = {
            mode: "create",
            loadState: "ready",
            operationState: "previewing",
            blockerCount: 0,
            errorMessage: null,
            isDirty: false,
        };
        expect(readinessStatusContributor.getItems(context)).toEqual([]);
    });

    test("creates, patches, and removes schema design runtime state", () => {
        const tabId = "schema-runtime-state-test";
        const store = useTabRuntimeStateStore.getState();
        store.removeTabRuntimeState(tabId);

        store.getOrCreateSchemaDesignState(tabId, {
            mode: "edit",
            loadState: "loading",
            operationState: "idle",
            blockerCount: 0,
            errorMessage: null,
            isDirty: false,
        });
        store.patchSchemaDesignState(tabId, {
            loadState: "restricted",
            blockerCount: 2,
        });

        expect(
            useTabRuntimeStateStore.getState().schemaDesignByTabId[tabId],
        ).toEqual({
            mode: "edit",
            loadState: "restricted",
            operationState: "idle",
            blockerCount: 2,
            errorMessage: null,
            isDirty: false,
        });

        store.removeSchemaDesignState(tabId);
        expect(
            useTabRuntimeStateStore.getState().schemaDesignByTabId[tabId],
        ).toBeUndefined();

        store.getOrCreateSchemaDesignState(tabId, {
            mode: "edit",
            loadState: "ready",
            operationState: "idle",
            blockerCount: 0,
            errorMessage: null,
            isDirty: false,
        });
        store.removeTabRuntimeState(tabId);
        expect(
            useTabRuntimeStateStore.getState().schemaDesignByTabId[tabId],
        ).toBeUndefined();
    });

    test("deduplicates execution overview targets in the navigation overlay store", () => {
        const overlay = useWorkbenchStatusOverlayStore.getState();
        overlay.closeExecutionOverview();
        overlay.openExecutionOverview(["tab-2", "tab-2", "tab-3"]);

        expect(
            useWorkbenchStatusOverlayStore.getState()
                .executionOverviewTabIds,
        ).toEqual(["tab-2", "tab-3"]);

        useWorkbenchStatusOverlayStore
            .getState()
            .closeExecutionOverview();
    });

    test("formats JSON-safe metrics without precision loss", () => {
        expect(formatJsonSafeCount("9007199254740992")).toBe(
            "9,007,199,254,740,992",
        );
        expect(formatJsonSafeBytes("88080384")).toBe("84 MiB");
    });

    test("shows active execution on the left and JSON-safe metrics on the right", () => {
        const context = sqlExecutionContext(
            runningSnapshot(4, {
                readRows: "1200000",
                readBytes: "88080384",
            }),
        );

        const items = sqlEditorStatusContributor.getItems(context);

        expect(items.map((item) => [item.area, item.label])).toEqual([
            ["left", "正在执行 · READ · 2.4s"],
            ["right", "读取 1,200,000 行"],
            ["right", "84 MiB"],
        ]);
        items[0]?.onClick?.();
        expect(context.actionCalls.openSqlExecutionDetails).toEqual([
            "sql-tab",
        ]);
    });

    test("uses Raw artifact bytes only when summary bytes are unavailable", () => {
        const rawOutcome = {
            kind: "raw" as const,
            format: "CSV",
            mediaType: "text/csv",
            byteLength: "2048",
            preview: "id\n1\n",
            previewTruncated: false,
            artifactId: "artifact-1",
        };
        const fallback = {
            ...runningSnapshot(5),
            state: "succeeded" as const,
            finishedAt: 2_000,
            summary: null,
            outcome: rawOutcome,
        };
        const fallbackItems = sqlEditorStatusContributor.getItems(
            sqlExecutionContext(fallback),
        );
        expect(
            fallbackItems.find(
                (item) => item.id === "sql-editor-execution-bytes",
            )?.label,
        ).toBe("2 KiB");

        const summaryFirst = {
            ...fallback,
            summary: {
                resultBytes: "1024",
                source: "responseHeader" as const,
                completeness: "final" as const,
            },
        };
        const summaryItems = sqlEditorStatusContributor.getItems(
            sqlExecutionContext(summaryFirst),
        );
        expect(
            summaryItems.find(
                (item) => item.id === "sql-editor-execution-bytes",
            )?.label,
        ).toBe("1 KiB");
    });

    test("focuses one background target and opens overview for multiple targets", () => {
        const single = contextWithBackgroundExecutions(["tab-2"]);
        backgroundRunningItem(single).onClick?.();
        expect(single.actionCalls.focusTab).toEqual(["tab-2"]);
        expect(single.actionCalls.openSqlExecutionDetails).toEqual(["tab-2"]);

        const multiple = contextWithBackgroundExecutions([
            "tab-2",
            "tab-3",
        ]);
        backgroundRunningItem(multiple).onClick?.();
        expect(multiple.actionCalls.openExecutionOverview).toEqual([
            ["tab-2", "tab-3"],
        ]);
    });

    test("summarizes background failure-like states without driver knowledge", () => {
        const context = contextWithBackgroundFailures([
            "failed",
            "timedOut",
            "cancelFailed",
        ]);

        expect(
            sqlEditorStatusContributor
                .getItems(context)
                .map((item) => item.label),
        ).toContain("3 个后台查询失败");
    });

    test("shows SQL editor running state before result state", () => {
        const tab = sqlTab();
        const context = baseContext({ ...tab, isExecuting: true });
        context.tabRuntimeState.sqlEditorByTabId[tab.id] = {
            sqlText: "select 1",
            context: { database: "app", schema: "public" },
            savedSnapshot: null,
            result: null,
            error: null,
            lastExecution: null,
            scriptBatch: null,
            activeExecution: null,
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

        expect(sqlEditorStatusContributor.getItems(context)[0]).toMatchObject({
            id: "sql-editor-running",
            area: "left",
            label: "正在查询",
        });
    });

    test("shows SQL editor result row count", () => {
        const tab = sqlTab();
        const context = baseContext(tab);
        context.tabRuntimeState.sqlEditorByTabId[tab.id] = {
            sqlText: "select 1",
            context: { database: "app", schema: "public" },
            savedSnapshot: null,
            result: {
                columns: [],
                rows: [[1], [2]],
                hasNextPage: false,
                sourceWritable: false,
                sourceInsertable: false,
                primaryKeyColumns: [],
                stableOrderColumns: [],
            },
            error: null,
            lastExecution: null,
            scriptBatch: null,
            activeExecution: null,
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

        expect(sqlEditorStatusContributor.getItems(context)[0]).toMatchObject({
            id: "sql-editor-result",
            area: "right",
            label: "2 行",
        });
    });

    test("shows table data change count and rollback warning", () => {
        const context = baseContext(
            tableDataTab({
                kind: "table",
                database: "app",
                schema: "public",
                table: "users",
            }),
        );
        context.tabRuntimeState.tableDataByTabId["table-tab"] = {
            page: 2,
            pageSize: 100,
            selectedRowIndexes: [1, 3],
            currentRowIndex: null,
            selectedCell: null,
            editingCell: null,
            pendingDeleteKeys: null,
            pendingRefreshDiscard: false,
            changeSet: {
                inserts: {
                    draft1: { draftId: "draft1", values: {} },
                },
                updates: {
                    row1: { primaryKey: [], changes: { name: "Ada" } },
                },
                deletes: {},
            },
            transactionState: {
                inTransaction: true,
                database: "app",
            },
            transactionWarning: "rollbackRecommended",
            pageStats: {
                totalRows: 250,
                totalPages: 3,
                pageSize: 100,
            },
            pageStatsQueryKey: "table-tab",
            isPageInputEditing: false,
            pageInputValue: "2",
        };

        expect(
            tableDataStatusContributor.getItems(context).map((item) => item.label),
        ).toEqual([
            "建议回滚",
            "2 个更改",
            "事务中",
            "2 行选中",
            "第 2 / 3 页",
        ]);

        expect(
            tableDataStatusContributor
                .getItems(context)
                .find((item) => item.id === "table-data-transaction"),
        ).toMatchObject({
            label: "事务中",
            tone: "info",
        });
    });

    test("shows a degraded active-tab session as unstable", () => {
        const context = baseContext(sqlTab());
        context.connectionSessions["profile-1"] = {
            status: "degraded",
            errorMsg: "transport unavailable",
            recovery: { attempt: 0, maxAttempts: 3 },
        };

        expect(connectionStatusContributor.getItems(context)[0]).toMatchObject({
            id: "connection-status",
            label: "连接不稳定",
            title: "transport unavailable",
            tone: "warning",
        });
    });

    test("shows the active reconnect attempt", () => {
        const context = baseContext(sqlTab());
        context.connectionSessions["profile-1"] = {
            status: "reconnecting",
            recovery: { attempt: 1, maxAttempts: 3 },
        };

        expect(connectionStatusContributor.getItems(context)[0]).toMatchObject({
            id: "connection-status",
            label: "正在重连 · 1/3",
            tone: "warning",
        });
    });

    test("shows an active session while it is disconnecting", () => {
        const context = baseContext(sqlTab());
        context.connectionSessions["profile-1"] = {
            status: "disconnecting",
        };

        expect(connectionStatusContributor.getItems(context)[0]).toMatchObject({
            id: "connection-status",
            label: "正在断开",
            tone: "muted",
        });
    });

    test("shows Redis editing status", () => {
        const context = baseContext(keyValueTab());
        context.tabRuntimeState.keyValueByTabId["redis-tab"] = {
            cursor: 0,
            activeKey: "user:1",
            collapsedFolderIds: new Set(),
            collapsedFolderTreeKey: null,
            isPreviewCollapsed: false,
            stringPreviewMode: null,
            valueDraft: {
                sourceKey: "user:1",
                baseKey: "user:1",
                keyDraft: "user:1",
                valueKind: "string",
                baseValue: { kind: "string", value: "old" },
                valueDraft: { kind: "string", value: "new" },
            },
            isCreateDialogOpen: false,
            createDraft: null,
            pendingDeleteTarget: null,
            pendingKeySwitch: null,
            pendingRefreshDiscard: null,
        };

        expect(keyValueStatusContributor.getItems(context)[0]).toMatchObject({
            id: "key-value-editing",
            area: "left",
            label: "正在编辑值",
        });
    });

    test("shows table design dirty status", () => {
        const context = baseContext({
            id: "design-tab",
            type: "table_design",
            title: "users",
            isDirty: true,
            isPinned: false,
            payload: {
                profileId: "profile-1",
                tabRuntimeId: "design-tab",
                mode: "edit",
                container: {
                    kind: "table",
                    database: "app",
                    schema: "public",
                    table: "users",
                },
                parentContainer: null,
            },
        });

        expect(tableDesignStatusContributor.getItems(context)[0]).toMatchObject({
            id: "table-design-dirty",
            area: "left",
            label: "表结构有未保存更改",
            tone: "warning",
        });
    });
});

function runningSnapshot(
    revision: number,
    metrics: {
        readRows?: JsonSafeInteger;
        readBytes?: JsonSafeInteger;
    } = {},
): SqlExecutionSnapshot {
    return {
        executionId: `execution-${revision}`,
        queryId: `query-${revision}`,
        tabId: "runtime-tab",
        state: "running",
        revision,
        statementClass: "read",
        startedAt: 1_000,
        finishedAt: null,
        progressAvailable: true,
        summary: {
            ...metrics,
            source: "livePoll",
            completeness: "partial",
        },
        outcome: null,
        failure: null,
        cancelMessage: null,
    };
}

function sqlRuntimeState(
    activeExecution: SqlExecutionSnapshot,
): SqlEditorRuntimeState {
    return {
        sqlText: "SELECT 1",
        context: { database: "default", schema: null },
        savedSnapshot: null,
        result: null,
        error: null,
        lastExecution: null,
        scriptBatch: null,
        activeExecution,
        lastOutcome: activeExecution.outcome,
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

function sqlExecutionContext(activeExecution: SqlExecutionSnapshot) {
    const context = attachRecordingActions(baseContext(sqlTab()));
    context.tabRuntimeState.sqlEditorByTabId["sql-tab"] =
        sqlRuntimeState(activeExecution);
    return context;
}

function sqlTabWithId(tabId: string): WorkbenchTab {
    const base = sqlTab();
    return {
        ...base,
        id: tabId,
        title: tabId,
        payload: { ...base.payload, tabRuntimeId: tabId },
    };
}

function contextWithBackgroundExecutions(tabIds: string[]) {
    const context = attachRecordingActions(baseContext(sqlTab()));
    for (const [index, tabId] of tabIds.entries()) {
        context.tabs.push(sqlTabWithId(tabId));
        context.tabRuntimeState.sqlEditorByTabId[tabId] = sqlRuntimeState(
            runningSnapshot(index + 2),
        );
    }
    return context;
}

function backgroundRunningItem(context: WorkbenchStatusContext) {
    const item = sqlEditorStatusContributor
        .getItems(context)
        .find(
            (candidate) =>
                candidate.id === "sql-editor-background-running",
        );
    if (!item) throw new Error("background running item expected");
    return item;
}

function contextWithBackgroundFailures(states: SqlExecutionState[]) {
    const context = attachRecordingActions(baseContext(sqlTab()));
    for (const [index, state] of states.entries()) {
        const tabId = `failed-${index}`;
        const value: SqlExecutionSnapshot = {
            ...runningSnapshot(index + 2),
            executionId: `execution-failed-${index}`,
            state,
            finishedAt: 4_000,
            failure:
                state === "failed" || state === "cancelFailed"
                    ? {
                          code: "VALIDATION_FAILED",
                          runtimeImpact: "businessOnly",
                          message: "failed",
                      }
                    : null,
        };
        context.tabs.push(sqlTabWithId(tabId));
        context.tabRuntimeState.sqlEditorByTabId[tabId] =
            sqlRuntimeState(value);
    }
    return context;
}

describe("status bar AI Runtime warning contributor", () => {
    test("does not show healthy AI Runtime as a status bar item", () => {
        const context = baseContext(null);
        context.aiRuntime.healthStatus = "healthy";

        expect(aiRuntimeWarningStatusContributor.getItems(context)).toEqual([]);
    });

    test("does not show unknown checking AI Runtime by default", () => {
        const context = baseContext(null);
        context.aiRuntime.healthStatus = "unknown";
        context.aiRuntime.isChecking = true;

        expect(aiRuntimeWarningStatusContributor.getItems(context)).toEqual([]);
    });

    test("shows unhealthy AI Runtime as a right-side warning", () => {
        const context = baseContext(null);
        context.aiRuntime.healthStatus = "unhealthy";
        context.aiRuntime.errorMessage = "Runtime unreachable";

        expect(aiRuntimeWarningStatusContributor.getItems(context)[0]).toMatchObject({
            id: "ai-runtime-warning",
            area: "right",
            priority: 100,
            label: "AI 暂不可用",
            title: "Runtime unreachable",
            tone: "error",
        });
    });

    test("shows conversation recovery and model blockers in the right-side AI slot", () => {
        const context = attachRecordingActions(baseContext(null));
        context.aiRuntime.healthStatus = "healthy";
        context.agent.composerSendBlocker = {
            code: "recovering",
            message: "正在恢复对话",
        };

        expect(aiRuntimeWarningStatusContributor.getItems(context)[0]).toMatchObject({
            id: "ai-conversation-recovering",
            area: "right",
            priority: 100,
            label: "正在恢复对话",
            tone: "info",
            width: "compact",
        });

        context.agent.composerSendBlocker = {
            code: "missing_model",
            message: "请选择模型",
        };
        const item = aiRuntimeWarningStatusContributor.getItems(context)[0];

        expect(item).toMatchObject({
            id: "ai-model-missing",
            label: "请选择模型",
            tone: "warning",
        });
        expect(item?.onClick).toBeUndefined();
    });

    test("keeps message generation activity out of the bottom status bar", () => {
        const context = baseContext(null);
        context.aiRuntime.healthStatus = "healthy";
        context.agent.composerSendBlocker = {
            code: "running",
            message: "正在生成",
        };

        expect(aiRuntimeWarningStatusContributor.getItems(context)).toEqual([]);
    });
});

describe("status bar readiness and connection summary contributors", () => {
    test("shows readiness when there is no active tab", () => {
        const context = baseContext(null);

        expect(readinessStatusContributor.getItems(context)[0]).toMatchObject({
            id: "readiness-status",
            area: "left",
            label: "已就绪",
            width: "compact",
        });
    });

    test("shows readiness for an idle SQL editor with context", () => {
        const context = baseContext(sqlTab());

        expect(readinessStatusContributor.getItems(context)[0]).toMatchObject({
            id: "readiness-status",
            area: "left",
            label: "已就绪",
        });
    });

    test("hides readiness while SQL is executing", () => {
        const context = baseContext({ ...sqlTab(), isExecuting: true });

        expect(readinessStatusContributor.getItems(context)).toEqual([]);
    });

    test("hides readiness when table data has pending changes", () => {
        const context = baseContext(
            tableDataTab({
                kind: "table",
                database: "app",
                schema: "public",
                table: "users",
            }),
        );
        context.tabRuntimeState.tableDataByTabId["table-tab"] = {
            page: 1,
            pageSize: 100,
            selectedRowIndexes: [],
            currentRowIndex: null,
            selectedCell: null,
            editingCell: null,
            pendingDeleteKeys: null,
            pendingRefreshDiscard: false,
            changeSet: {
                inserts: {
                    draft1: { draftId: "draft1", values: {} },
                },
                updates: {},
                deletes: {},
            },
            transactionState: { inTransaction: false, database: null },
            transactionWarning: null,
            pageStats: null,
            pageStatsQueryKey: null,
            isPageInputEditing: false,
            pageInputValue: "1",
        };

        expect(readinessStatusContributor.getItems(context)).toEqual([]);
    });

    test("shows connection summary for connected sessions", () => {
        const context = baseContext(null);
        context.connectionSessions["profile-1"] = { status: "connected" };
        context.connectionSessions["profile-2"] = { status: "connected" };

        expect(connectionSummaryStatusContributor.getItems(context)[0]).toMatchObject({
            id: "connection-summary",
            area: "right",
            label: "2 个连接在线",
            width: "compact",
        });
    });

    test("shows connection errors before connected count", () => {
        const context = baseContext(null);
        context.connectionSessions["profile-1"] = { status: "connected" };
        context.connectionSessions["profile-2"] = {
            status: "error",
            errorMsg: "Auth failed",
        };

        expect(connectionSummaryStatusContributor.getItems(context)[0]).toMatchObject({
            id: "connection-summary",
            area: "right",
            label: "1 个连接异常",
            tone: "error",
        });
    });

    test("summarizes degraded reconnecting and failed sessions separately", () => {
        const context = baseContext(null);
        context.connectionSessions["profile-connected"] = {
            status: "connected",
        };
        context.connectionSessions["profile-degraded"] = {
            status: "degraded",
        };
        context.connectionSessions["profile-reconnecting"] = {
            status: "reconnecting",
            recovery: { attempt: 2, maxAttempts: 3 },
        };
        context.connectionSessions["profile-error"] = {
            status: "error",
        };

        expect(connectionSummaryStatusContributor.getItems(context)[0]).toMatchObject({
            id: "connection-summary",
            label: "3 个连接异常",
            title: "1 个失败，1 个不稳定，1 个重连中",
            tone: "error",
        });
    });

    test("uses warning tone when sessions are degraded without failures", () => {
        const context = baseContext(null);
        context.connectionSessions["profile-degraded"] = {
            status: "degraded",
        };

        expect(connectionSummaryStatusContributor.getItems(context)[0]).toMatchObject({
            label: "1 个连接异常",
            title: "1 个不稳定",
            tone: "warning",
        });
    });

    test("does not count disconnecting sessions as online", () => {
        const context = baseContext(null);
        context.connectionSessions["profile-1"] = {
            status: "disconnecting",
        };

        expect(connectionSummaryStatusContributor.getItems(context)).toEqual([]);
    });

    test("does not show zero connected sessions", () => {
        const context = baseContext(null);

        expect(connectionSummaryStatusContributor.getItems(context)).toEqual([]);
    });

    test("places active table row selection before global connection summary", () => {
        const context = baseContext(
            tableDataTab({
                kind: "table",
                database: "app",
                schema: "public",
                table: "users",
            }),
        );
        context.tabRuntimeState.tableDataByTabId["table-tab"] = {
            page: 1,
            pageSize: 100,
            selectedRowIndexes: [1],
            currentRowIndex: null,
            selectedCell: null,
            editingCell: null,
            pendingDeleteKeys: null,
            pendingRefreshDiscard: false,
            changeSet: {
                inserts: {},
                updates: {},
                deletes: {},
            },
            transactionState: { inTransaction: false, database: null },
            transactionWarning: null,
            pageStats: null,
            pageStatsQueryKey: null,
            isPageInputEditing: false,
            pageInputValue: "1",
        };

        for (let index = 1; index <= 6; index += 1) {
            context.connectionSessions[`profile-${index}`] = {
                status: "connected",
            };
        }

        expect(collectWorkbenchStatusItems(context).right.map((item) => item.label))
            .toEqual(["1 行选中", "6 个连接在线"]);
    });
});

export { baseContext, keyValueTab, runtime, sqlTab, tableDataTab };
