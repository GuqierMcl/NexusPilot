import { describe, expect, test } from "bun:test";
import { Activity, Database, TriangleAlert } from "lucide-react";

import {
    collectWorkbenchStatusItems,
    createEmptyWorkbenchStatusItemAreas,
} from "../../../../src/features/workbench/status-bar/status-bar-contributor-registry";
import type {
    WorkbenchStatusContext,
    WorkbenchStatusContributor,
} from "../../../../src/features/workbench/status-bar/types";

function context(): WorkbenchStatusContext {
    return {
        activeTab: null,
        tabs: [],
        connectionSessions: {},
        tabRuntimeState: {
            sqlEditorByTabId: {},
            tableDataByTabId: {},
            tableDesignByTabId: {},
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

describe("status bar contributor registry", () => {
    test("creates empty left and right item areas", () => {
        expect(createEmptyWorkbenchStatusItemAreas()).toEqual({
            left: [],
            right: [],
        });
    });

    test("filters hidden items and sorts visible items by area and priority", () => {
        const contributors: WorkbenchStatusContributor[] = [
            {
                id: "demo",
                getItems: () => [
                    {
                        id: "right-low",
                        area: "right",
                        priority: 30,
                        icon: TriangleAlert,
                        label: "右侧低优先级",
                    },
                    {
                        id: "left-high",
                        area: "left",
                        priority: 10,
                        icon: Database,
                        label: "左侧高优先级",
                    },
                    {
                        id: "left-hidden",
                        area: "left",
                        priority: 1,
                        icon: Activity,
                        label: "隐藏状态",
                        visible: false,
                    },
                    {
                        id: "left-low",
                        area: "left",
                        priority: 20,
                        icon: Activity,
                        label: "左侧低优先级",
                    },
                ],
            },
        ];

        const grouped = collectWorkbenchStatusItems(context(), contributors);

        expect(grouped.left.map((item) => item.id)).toEqual([
            "left-high",
            "left-low",
        ]);
        expect(grouped.right.map((item) => item.id)).toEqual(["right-low"]);
        expect("center" in grouped).toBe(false);
    });
});
