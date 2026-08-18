import { create } from "zustand";
import debounce from "lodash-es/debounce";

import { DEFAULT_WORKSPACE_EXPLORER_STATE } from "@/config/ui-layout";
import { listConnections, listConnectionFolders } from "@/lib/tauri/connections";
import {
    STORE_KEY_WORKSPACE_STATE,
    WORKSPACE_STORE_DEFAULTS,
    WORKSPACE_STORE_FILE_NAME,
} from "@/store/constants";
import {
    getStoreValue,
    isTauriEnvironment,
} from "@/store/tauri/store-instances";
import { persistWorkspaceStatePatch } from "@/store/tauri/workspace-state";
import type { StoredDatabaseConnection, StoredConnectionFolder } from "@/types";
import type { WorkspaceExplorerState, WorkspaceState } from "@/types/ui-layout";

const DEBOUNCE_MS = 500;

async function persistExplorerSnapshot(explorer: WorkspaceExplorerState) {
    if (!isTauriEnvironment()) {
        return;
    }

    await persistWorkspaceStatePatch({ explorer });
}

const debouncedPersistExplorer = debounce((explorer: WorkspaceExplorerState) => {
    void persistExplorerSnapshot(explorer);
}, DEBOUNCE_MS);

function schedulePersistExplorer(explorer: WorkspaceExplorerState) {
    if (!isTauriEnvironment()) {
        return;
    }
    debouncedPersistExplorer(explorer);
}

export interface ExplorerState {
    connections: StoredDatabaseConnection[];
    folders: StoredConnectionFolder[];
    isLoading: boolean;
    error: string | null;

    selectedNodeId: string | null;
    expandedNodeIds: string[];
    hasPersistedExpandedNodeIds: boolean;
    searchQuery: string;
    activeConnectionId: string | null;

    loadExplorerData: () => Promise<void>;
    setSelectedNodeId: (id: string | null) => void;
    setExpandedNodeIds: (ids: string[]) => void;
    setNodeExpanded: (id: string, expanded: boolean) => void;
    setSearchQuery: (query: string) => void;
    setActiveConnectionId: (id: string | null) => void;
}

export const useExplorerStore = create<ExplorerState>((set) => ({
    connections: [],
    folders: [],
    isLoading: true,
    error: null,

    selectedNodeId: null,
    expandedNodeIds: [],
    hasPersistedExpandedNodeIds: false,
    searchQuery: "",
    activeConnectionId: null,

    loadExplorerData: async () => {
        set({ isLoading: true, error: null });
        try {
            const [connections, folders] = await Promise.all([
                listConnections(),
                listConnectionFolders(),
            ]);
            set({ connections, folders, isLoading: false });
        } catch (error) {
            console.error("[explorer] failed to load explorer data", error);
            set({
                connections: [],
                folders: [],
                isLoading: false,
                error: error instanceof Error ? error.message : "加载连接列表失败",
            });
        }
    },

    setSelectedNodeId: (id) => set({ selectedNodeId: id }),
    setExpandedNodeIds: (ids) => {
        const expandedNodeIds = [...new Set(ids)];
        set({ expandedNodeIds, hasPersistedExpandedNodeIds: true });
        schedulePersistExplorer({
            expandedNodeIds,
            expansionStateInitialized: true,
        });
    },
    setNodeExpanded: (id, expanded) => {
        set((state) => {
            const next = new Set(
                state.hasPersistedExpandedNodeIds
                    ? state.expandedNodeIds
                    : state.folders.map((folder) => folder.id),
            );
            if (expanded) {
                next.add(id);
            } else {
                next.delete(id);
            }
            const expandedNodeIds = [...next];
            schedulePersistExplorer({
                expandedNodeIds,
                expansionStateInitialized: true,
            });
            return { expandedNodeIds, hasPersistedExpandedNodeIds: true };
        });
    },
    setSearchQuery: (query) => set({ searchQuery: query }),
    setActiveConnectionId: (id) => set({ activeConnectionId: id }),
}));

export async function loadInitialExplorerState(): Promise<void> {
    if (!isTauriEnvironment()) {
        return;
    }

    try {
        const ws = await getStoreValue<WorkspaceState>(
            WORKSPACE_STORE_FILE_NAME,
            STORE_KEY_WORKSPACE_STATE,
            WORKSPACE_STORE_DEFAULTS,
        );
        const hasPersistedExpandedNodeIds =
            ws?.explorer?.expansionStateInitialized === true;
        useExplorerStore.setState({
            expandedNodeIds: hasPersistedExpandedNodeIds
                ? (ws?.explorer?.expandedNodeIds ??
                  DEFAULT_WORKSPACE_EXPLORER_STATE.expandedNodeIds)
                : DEFAULT_WORKSPACE_EXPLORER_STATE.expandedNodeIds,
            hasPersistedExpandedNodeIds,
        });
    } catch (error) {
        console.warn("[explorer] loadInitialExplorerState", error);
    }
}

export async function forceSaveExplorerState(): Promise<void> {
    debouncedPersistExplorer.cancel();
    const { expandedNodeIds, hasPersistedExpandedNodeIds } =
        useExplorerStore.getState();
    await persistExplorerSnapshot({
        expandedNodeIds,
        expansionStateInitialized: hasPersistedExpandedNodeIds,
    });
}
