import { create } from "zustand";
import { arrayMove } from "@dnd-kit/sortable";

import {
    buildKeyValueTabOpenRequest,
    buildSavedQuerySqlEditorPreOpenRequest,
    buildSavedQuerySqlEditorTabOpenRequest,
    buildSqlEditorTabId,
    buildSqlEditorTabOpenRequest,
    buildTableDataPreOpenRequest,
    buildTableDataTabOpenRequest,
    buildTableDesignTabOpenRequest,
    createWorkbenchTabFromOpenRequest,
    buildClickHouseViewDesignTabOpenRequest,
    contentTabOwnsBackendRuntime,
    expandContentTabClosingSet,
    findExistingContentTabForOpenRequest,
    matchesContentTabContainer,
    retargetClickHouseTableDesignTabToEdit as retargetClickHouseTableDesignTabToEditModel,
    retargetClickHouseViewDesignTabToEdit as retargetClickHouseViewDesignTabToEditModel,
    retargetSqlEditorTab,
    retargetTableDesignTabToEdit as retargetTableDesignTabToEditModel,
} from "@/features/workbench/content/content-tab-lifecycle-registry";
import { resolveSchemaDesignerSurface } from "@/features/workbench/content/schema-designer-surface-registry";
import { apiInvoke } from "@/lib/api-client";
import { useContentToolbarStore } from "@/store/slices/content-toolbar-slice";
import { useTabRuntimeStateStore } from "@/store/slices/tab-runtime-state-slice";
import type {
    ConnectionRuntimeInfo,
    ContainerRef,
    DriverCapabilities,
} from "@/types/ipc";
import type { SavedQuery, SqlExecutionContext } from "@/types/saved-queries";
import type {
    TableDataPayload,
    KeyValuePayload,
    SqlEditorPayload,
    TableDesignPayload,
    ClickHouseTableDesignPayload,
    ClickHouseViewDesignPayload,
    JsonViewerPayload,
    GraphTopologyPayload,
    DashboardPayload,
} from "@/types/tab-payloads";

// ─── Tab 视图类型 ──────────────────────────────────────────────────────────────

export type TabType =
    | "sql_editor"
    | "table_data"
    | "key_value"
    | "table_design"
    | "clickhouse_table_design"
    | "clickhouse_view_design"
    | "json_viewer"
    | "graph_topology"
    | "dashboard";

// ─── Tab 载荷联合类型 ──────────────────────────────────────────────────────────

export type TabPayloadMap = {
    sql_editor: SqlEditorPayload;
    table_data: TableDataPayload;
    key_value: KeyValuePayload;
    table_design: TableDesignPayload;
    clickhouse_table_design: ClickHouseTableDesignPayload;
    clickhouse_view_design: ClickHouseViewDesignPayload;
    json_viewer: JsonViewerPayload;
    graph_topology: GraphTopologyPayload;
    dashboard: DashboardPayload;
};

export type WorkbenchTab = {
    [K in TabType]: {
        id: string;
        type: K;
        title: string;
        isDirty: boolean;
        isPinned: boolean;
        isExecuting?: boolean;
        payload: TabPayloadMap[K];
    };
}[TabType];

// ─── Store State ───────────────────────────────────────────────────────────────

export interface WorkbenchTabsState {
    tabs: WorkbenchTab[];
    activeTabId: string | null;

    openTab: (tab: WorkbenchTab) => void;
    closeTab: (tabId: string) => void;
    closeTabs: (tabIds: string[]) => void;
    closeOtherTabs: (tabId: string) => void;
    closeTabsToRight: (tabId: string) => void;
    activateTab: (tabId: string) => void;
    pinTab: (tabId: string) => void;
    unpinTab: (tabId: string) => void;
    setExecuting: (tabId: string, executing: boolean) => void;
    setDirty: (tabId: string, dirty: boolean) => void;
    retargetSqlEditorTabToSavedQuery: (
        tabId: string,
        savedQueryId: string,
        title: string,
        options?: { isDirty?: boolean },
    ) => void;
    retargetTableDesignTabToEdit: (tabId: string, container: ContainerRef) => void;
    retargetClickHouseTableDesignTabToEdit: (
        tabId: string,
        container: ContainerRef,
    ) => void;
    retargetClickHouseViewDesignTabToEdit: (
        tabId: string,
        container: ContainerRef,
    ) => void;
    reorderTab: (activeId: string, overId: string) => void;
    closeAllTabs: () => void;

    openSqlEditorTab: (
        profileId: string,
        options?: {
            title?: string;
            context?: SqlExecutionContext | null;
        },
    ) => Promise<void>;
    openSavedQueryTab: (query: SavedQuery) => Promise<void>;
    openTableDataTab: (profileId: string, container: ContainerRef) => Promise<void>;
    openTableDesignTab: (
        profileId: string,
        options: {
            mode: "create" | "edit";
            container?: ContainerRef | null;
            parentContainer?: ContainerRef | null;
            title?: string;
        },
    ) => void;
    openSchemaDesignTab: (
        profileId: string,
        driverName: string,
        capabilities: DriverCapabilities,
        options: {
            mode: "create" | "edit";
            objectKind: ContainerRef["kind"];
            container?: ContainerRef | null;
            parentContainer?: ContainerRef | null;
            ownerTabRuntimeId?: string | null;
            title?: string;
        },
    ) => void;
    openClickHouseTemporaryViewTab: (
        profileId: string,
        ownerTabRuntimeId?: string | null,
    ) => Promise<void>;
    openKeyValueTab: (
        profileId: string,
        dbIndex: number,
        pattern?: string,
        selectedKey?: string,
    ) => void;
    closeTabsByProfileId: (profileId: string) => void;
    closeTabsByContainer: (profileId: string, container: ContainerRef) => void;
}

function closeTabRuntimes(tabs: WorkbenchTab[]) {
    for (const tab of tabs) {
        if (!contentTabOwnsBackendRuntime(tab)) continue;
        void apiInvoke("close_tab_runtime", { tabId: tab.id }, { silent: true }).catch(
            () => undefined,
        );
    }
}

function clearClosedTabUiState(tabs: WorkbenchTab[]) {
    const runtimeStore = useTabRuntimeStateStore.getState();
    const toolbarStore = useContentToolbarStore.getState();

    for (const tab of tabs) {
        runtimeStore.removeTabRuntimeState(tab.id);
        toolbarStore.clearToolbar(tab.id);
    }
}

function getNextActiveTabId(
    tabs: WorkbenchTab[],
    closingIds: Set<string>,
    activeTabId: string | null,
) {
    const remainingTabs = tabs.filter((tab) => !closingIds.has(tab.id));
    if (remainingTabs.length === 0) return null;
    if (activeTabId && !closingIds.has(activeTabId)) return activeTabId;

    const activeIndex = activeTabId
        ? tabs.findIndex((tab) => tab.id === activeTabId)
        : -1;
    const firstClosingIndex = tabs.findIndex((tab) => closingIds.has(tab.id));
    const anchorIndex = activeIndex >= 0 ? activeIndex : Math.max(firstClosingIndex, 0);

    const nextRightTab = tabs
        .slice(anchorIndex)
        .find((tab) => !closingIds.has(tab.id));
    if (nextRightTab) return nextRightTab.id;

    return [...tabs].reverse().find((tab) => !closingIds.has(tab.id))?.id ?? null;
}

function getVisibleOrderedTabs(tabs: WorkbenchTab[]) {
    return [
        ...tabs.filter((tab) => tab.isPinned),
        ...tabs.filter((tab) => !tab.isPinned),
    ];
}

// ─── Store ─────────────────────────────────────────────────────────────────────

export const useWorkbenchTabsStore = create<WorkbenchTabsState>((set, get) => ({
    tabs: [],
    activeTabId: null,

    openTab: (tab) => {
        const existing = get().tabs.find((t) => t.id === tab.id);
        if (existing) {
            if (get().activeTabId === tab.id) return;
            set({ activeTabId: tab.id });
            return;
        }
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    },

    closeTab: (tabId) => {
        get().closeTabs([tabId]);
    },

    closeTabs: (tabIds) => {
        const requestedIds = new Set(tabIds);
        if (requestedIds.size === 0) return;

        const { tabs, activeTabId } = get();
        const requestedTabs = tabs.filter(
            (tab) => requestedIds.has(tab.id) && !tab.isPinned,
        );
        const closingTabs = expandContentTabClosingSet(
            tabs,
            requestedTabs.map((tab) => tab.id),
        );
        if (closingTabs.length === 0) return;

        const closingIds = new Set(closingTabs.map((tab) => tab.id));
        closeTabRuntimes(closingTabs);
        clearClosedTabUiState(closingTabs);

        set({
            tabs: tabs.filter((tab) => !closingIds.has(tab.id)),
            activeTabId: getNextActiveTabId(tabs, closingIds, activeTabId),
        });
    },

    closeOtherTabs: (tabId) => {
        const tabIds = get().tabs
            .filter((tab) => tab.id !== tabId && !tab.isPinned)
            .map((tab) => tab.id);
        get().closeTabs(tabIds);
    },

    closeTabsToRight: (tabId) => {
        const tabs = getVisibleOrderedTabs(get().tabs);
        const tabIndex = tabs.findIndex((tab) => tab.id === tabId);
        if (tabIndex === -1) return;

        const tabIds = tabs
            .slice(tabIndex + 1)
            .filter((tab) => !tab.isPinned)
            .map((tab) => tab.id);
        get().closeTabs(tabIds);
    },

    activateTab: (tabId) => {
        if (get().activeTabId === tabId) return;
        set({ activeTabId: tabId });
    },

    pinTab: (tabId) => {
        set((s) => ({
            tabs: s.tabs.map((t) =>
                t.id === tabId ? { ...t, isPinned: true } : t,
            ),
        }));
    },

    unpinTab: (tabId) => {
        set((s) => ({
            tabs: s.tabs.map((t) =>
                t.id === tabId ? { ...t, isPinned: false } : t,
            ),
        }));
    },

    setExecuting: (tabId, executing) => {
        set((s) => {
            const target = s.tabs.find((t) => t.id === tabId);
            if (!target || Boolean(target.isExecuting) === executing) return s;

            return {
                tabs: s.tabs.map((t) =>
                    t.id === tabId ? { ...t, isExecuting: executing } : t,
                ),
            };
        });
    },

    setDirty: (tabId, dirty) => {
        set((s) => {
            const target = s.tabs.find((t) => t.id === tabId);
            if (!target || target.isDirty === dirty) return s;

            return {
                tabs: s.tabs.map((t) =>
                    t.id === tabId ? { ...t, isDirty: dirty } : t,
                ),
            };
        });
    },

    retargetSqlEditorTabToSavedQuery: (tabId, savedQueryId, title, options) => {
        set((s) => {
            const tabs = retargetSqlEditorTab(
                s.tabs,
                tabId,
                savedQueryId,
                title,
                options,
            );
            if (tabs === s.tabs) return s;
            return { tabs };
        });
    },

    retargetTableDesignTabToEdit: (tabId, container) => {
        set((s) => {
            const tabs = retargetTableDesignTabToEditModel(
                s.tabs,
                tabId,
                container,
            );
            if (tabs === s.tabs) return s;
            return { tabs };
        });
    },

    retargetClickHouseTableDesignTabToEdit: (tabId, container) => {
        set((s) => {
            const tabs = retargetClickHouseTableDesignTabToEditModel(
                s.tabs,
                tabId,
                container,
            );
            if (tabs === s.tabs) return s;
            return { tabs };
        });
    },

    retargetClickHouseViewDesignTabToEdit: (tabId, container) => {
        set((s) => {
            const tabs = retargetClickHouseViewDesignTabToEditModel(
                s.tabs,
                tabId,
                container,
            );
            if (tabs === s.tabs) return s;
            return { tabs };
        });
    },

    reorderTab: (activeId, overId) => {
        set((s) => {
            const from = s.tabs.findIndex((t) => t.id === activeId);
            const to = s.tabs.findIndex((t) => t.id === overId);
            if (from === -1 || to === -1) return s;
            return { tabs: arrayMove(s.tabs, from, to) };
        });
    },

    closeAllTabs: () => {
        const tabIds = get().tabs
            .filter((tab) => !tab.isPinned)
            .map((tab) => tab.id);
        get().closeTabs(tabIds);
    },

    openSqlEditorTab: async (profileId, options) => {
        const tabId = buildSqlEditorTabId(profileId);
        const runtime = await apiInvoke<ConnectionRuntimeInfo>(
            "open_tab_runtime",
            { profileId, tabId },
            { silent: false },
        );

        if (!runtime.capabilities.sqlExecutor) {
            void apiInvoke("close_tab_runtime", { tabId }, { silent: true }).catch(
                () => undefined,
            );
            throw new Error("该连接不支持 SQL 查询编辑器");
        }

        const request = buildSqlEditorTabOpenRequest(profileId, {
            ...options,
            runtime,
            tabId,
        });
        get().openTab(createWorkbenchTabFromOpenRequest(request));
    },

    openSavedQueryTab: async (query) => {
        const preOpenRequest = buildSavedQuerySqlEditorPreOpenRequest(query);
        const tabId = preOpenRequest.id;
        const existing = findExistingContentTabForOpenRequest(
            get().tabs,
            preOpenRequest,
        );
        if (existing) {
            get().activateTab(existing.id);
            return;
        }

        const runtime = await apiInvoke<ConnectionRuntimeInfo>(
            "open_tab_runtime",
            { profileId: query.profileId, tabId },
            { silent: false },
        );

        if (!runtime.capabilities.sqlExecutor) {
            void apiInvoke("close_tab_runtime", { tabId }, { silent: true }).catch(
                () => undefined,
            );
            throw new Error("该连接不支持 SQL 查询编辑器");
        }

        const request = buildSavedQuerySqlEditorTabOpenRequest(query, runtime);

        try {
            const context = request.payload.initialContext ?? {
                database: null,
                schema: null,
            };
            const runtimeStore = useTabRuntimeStateStore.getState();
            runtimeStore.getOrCreateSqlEditorState(tabId, {
                sqlText: query.sqlText,
                context,
                savedSnapshot: {
                    title: query.title,
                    sqlText: query.sqlText,
                    context,
                },
            });

            get().openTab(createWorkbenchTabFromOpenRequest(request));
        } catch (error) {
            useTabRuntimeStateStore.getState().removeTabRuntimeState(tabId);
            void apiInvoke("close_tab_runtime", { tabId }, { silent: true }).catch(
                () => undefined,
            );
            throw error;
        }
    },

    openTableDataTab: async (profileId, container) => {
        const preOpenRequest = buildTableDataPreOpenRequest(profileId, container);
        const tabId = preOpenRequest.id;
        const existing = findExistingContentTabForOpenRequest(
            get().tabs,
            preOpenRequest,
        );
        if (existing) {
            get().activateTab(existing.id);
            return;
        }

        const runtime = await apiInvoke<ConnectionRuntimeInfo>(
            "open_tab_runtime",
            { profileId, tabId },
            { silent: false },
        );

        if (!runtime.capabilities.dataTableBrowser) {
            void apiInvoke("close_tab_runtime", { tabId }, { silent: true }).catch(
                () => undefined,
            );
            throw new Error("该连接不支持表数据浏览");
        }

        const request = buildTableDataTabOpenRequest(profileId, container, runtime);
        get().openTab(createWorkbenchTabFromOpenRequest(request));
    },

    openTableDesignTab: (profileId, options) => {
        const request = buildTableDesignTabOpenRequest(profileId, options);
        const existing = findExistingContentTabForOpenRequest(
            get().tabs,
            request,
        );
        if (existing) {
            get().activateTab(existing.id);
            return;
        }

        get().openTab(createWorkbenchTabFromOpenRequest(request));
    },

    openSchemaDesignTab: (profileId, driverName, capabilities, options) => {
        const registration = resolveSchemaDesignerSurface({
            driverName,
            objectKind: options.objectKind,
            mode: options.mode,
            capabilities,
        });
        if (!registration) {
            throw new Error("该连接没有可用的结构设计器");
        }

        const request = registration.buildOpenRequest(profileId, options);
        const existing = findExistingContentTabForOpenRequest(
            get().tabs,
            request,
        );
        if (existing) {
            get().activateTab(existing.id);
            return;
        }

        get().openTab(createWorkbenchTabFromOpenRequest(request));
    },

    openClickHouseTemporaryViewTab: async (profileId, ownerTabRuntimeId) => {
        let ownerId = ownerTabRuntimeId?.trim() || null;
        if (ownerId == null) {
            await get().openSqlEditorTab(profileId, {
                title: "Temporary View Session",
            });
            const owner = get().tabs.find(
                (tab) =>
                    tab.id === get().activeTabId &&
                    tab.type === "sql_editor" &&
                    tab.payload.profileId === profileId &&
                    tab.payload.runtime.driverName === "clickhouse",
            );
            if (!owner || owner.type !== "sql_editor") {
                throw new Error("无法创建 Temporary View owner SQL runtime");
            }
            ownerId = owner.payload.tabRuntimeId;
        }

        const owner = get().tabs.find(
            (tab) =>
                tab.type === "sql_editor" &&
                tab.payload.profileId === profileId &&
                tab.payload.tabRuntimeId === ownerId &&
                tab.payload.runtime.driverName === "clickhouse",
        );
        if (!owner) {
            throw new Error("Temporary View owner SQL runtime 不存在");
        }
        const request = buildClickHouseViewDesignTabOpenRequest(profileId, {
            mode: "temporary",
            ownerTabRuntimeId: ownerId,
        });
        get().openTab(createWorkbenchTabFromOpenRequest(request));
    },

    openKeyValueTab: (profileId, dbIndex, pattern = "*", selectedKey) => {
        const request = buildKeyValueTabOpenRequest(
            profileId,
            dbIndex,
            pattern,
            selectedKey,
        );
        get().openTab(createWorkbenchTabFromOpenRequest(request));
    },

    closeTabsByProfileId: (profileId) => {
        set((s) => {
            const closingTabs = s.tabs.filter(
                (tab) =>
                    "profileId" in tab.payload &&
                    tab.payload.profileId === profileId,
            );
            const closingIds = new Set(closingTabs.map((tab) => tab.id));
            const remaining = s.tabs.filter((tab) => !closingIds.has(tab.id));
            closeTabRuntimes(closingTabs);
            clearClosedTabUiState(closingTabs);

            let nextActiveId = s.activeTabId;
            if (nextActiveId && !remaining.some((t) => t.id === nextActiveId)) {
                nextActiveId = remaining.length > 0 ? remaining[0].id : null;
            }
            return { tabs: remaining, activeTabId: nextActiveId };
        });
    },

    closeTabsByContainer: (profileId, container) => {
        set((s) => {
            const closingTabs = s.tabs.filter((tab) =>
                matchesContentTabContainer(tab, profileId, container),
            );
            if (closingTabs.length === 0) return s;

            const closingIds = new Set(closingTabs.map((tab) => tab.id));
            closeTabRuntimes(closingTabs);
            clearClosedTabUiState(closingTabs);

            return {
                tabs: s.tabs.filter((tab) => !closingIds.has(tab.id)),
                activeTabId: getNextActiveTabId(
                    s.tabs,
                    closingIds,
                    s.activeTabId,
                ),
            };
        });
    },
}));
