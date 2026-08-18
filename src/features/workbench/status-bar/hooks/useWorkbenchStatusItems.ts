import { useCallback, useEffect, useMemo, useState } from "react";

import { useAgentStatusSnapshotStore } from "@/features/workbench/agent/state";
import { useCloudDesktopState } from "@/features/settings/cloud-context";
import {
    useAiRuntimeEndpointStore,
    useConnectionSessionStore,
    useTabRuntimeStateStore,
    useWorkbenchStatusOverlayStore,
    useWorkbenchTabsStore,
    useWorkspaceLayoutStore,
} from "@/store";

import { collectWorkbenchStatusItems } from "../status-bar-contributor-registry";
import type { WorkbenchStatusContext, WorkbenchStatusItemAreas } from "../types";

function useStatusNow(): number {
    const [nowMs, setNowMs] = useState(() => Date.now());

    useEffect(() => {
        const interval = globalThis.setInterval(() => {
            setNowMs(Date.now());
        }, 1_000);
        return () => globalThis.clearInterval(interval);
    }, []);

    return nowMs;
}

export function useWorkbenchStatusItems(): WorkbenchStatusItemAreas {
    const { state: cloud } = useCloudDesktopState();
    const tabs = useWorkbenchTabsStore((state) => state.tabs);
    const activeTabId = useWorkbenchTabsStore((state) => state.activeTabId);
    const activateTab = useWorkbenchTabsStore((state) => state.activateTab);
    const connectionSessions = useConnectionSessionStore((state) => state.sessions);
    const sqlEditorByTabId = useTabRuntimeStateStore(
        (state) => state.sqlEditorByTabId,
    );
    const patchSqlEditorState = useTabRuntimeStateStore(
        (state) => state.patchSqlEditorState,
    );
    const openExecutionOverview = useWorkbenchStatusOverlayStore(
        (state) => state.openExecutionOverview,
    );
    const tableDataByTabId = useTabRuntimeStateStore(
        (state) => state.tableDataByTabId,
    );
    const tableDesignByTabId = useTabRuntimeStateStore(
        (state) => state.tableDesignByTabId,
    );
    const clickHouseTableDesignByTabId = useTabRuntimeStateStore(
        (state) => state.clickHouseTableDesignByTabId,
    );
    const clickHouseViewDesignByTabId = useTabRuntimeStateStore(
        (state) => state.clickHouseViewDesignByTabId,
    );
    const schemaDesignByTabId = useTabRuntimeStateStore(
        (state) => state.schemaDesignByTabId,
    );
    const keyValueByTabId = useTabRuntimeStateStore(
        (state) => state.keyValueByTabId,
    );
    const leftSidebarCollapsed = useWorkspaceLayoutStore(
        (state) => state.isLeftSidebarCollapsed,
    );
    const rightSidebarCollapsed = useWorkspaceLayoutStore(
        (state) => state.isRightSidebarCollapsed,
    );
    const healthStatus = useAiRuntimeEndpointStore((state) => state.healthStatus);
    const isChecking = useAiRuntimeEndpointStore((state) => state.isChecking);
    const errorMessage = useAiRuntimeEndpointStore((state) => state.errorMessage);
    const composerSendBlocker = useAgentStatusSnapshotStore(
        (state) => state.composerSendBlocker,
    );
    const nowMs = useStatusNow();
    const focusTab = useCallback(
        (tabId: string) => activateTab(tabId),
        [activateTab],
    );
    const openSqlExecutionDetails = useCallback(
        (tabId: string) => {
            activateTab(tabId);
            patchSqlEditorState(tabId, { executionDetailOpen: true });
        },
        [activateTab, patchSqlEditorState],
    );
    const statusActions = useMemo(
        () => ({
            focusTab,
            openSqlExecutionDetails,
            openExecutionOverview,
        }),
        [focusTab, openExecutionOverview, openSqlExecutionDetails],
    );

    return useMemo(() => {
        const activeTab =
            activeTabId == null
                ? null
                : tabs.find((tab) => tab.id === activeTabId) ?? null;
        const context: WorkbenchStatusContext = {
            activeTab,
            tabs,
            connectionSessions,
            tabRuntimeState: {
                sqlEditorByTabId,
                tableDataByTabId,
                tableDesignByTabId,
                clickHouseTableDesignByTabId,
                clickHouseViewDesignByTabId,
                schemaDesignByTabId,
                keyValueByTabId,
            },
            layout: {
                leftSidebarCollapsed,
                rightSidebarCollapsed,
            },
            aiRuntime: {
                healthStatus,
                isChecking,
                errorMessage,
            },
            agent: {
                composerSendBlocker,
            },
            cloud,
            nowMs,
            actions: statusActions,
        };

        return collectWorkbenchStatusItems(context);
    }, [
        activeTabId,
        clickHouseTableDesignByTabId,
        clickHouseViewDesignByTabId,
        connectionSessions,
        composerSendBlocker,
        cloud,
        errorMessage,
        healthStatus,
        isChecking,
        keyValueByTabId,
        leftSidebarCollapsed,
        nowMs,
        rightSidebarCollapsed,
        schemaDesignByTabId,
        sqlEditorByTabId,
        tableDataByTabId,
        tableDesignByTabId,
        tabs,
        statusActions,
    ]);
}
