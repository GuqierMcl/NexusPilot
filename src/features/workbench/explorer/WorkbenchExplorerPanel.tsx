import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { useQueries } from "@tanstack/react-query";

import { buildExplorerTree } from "@/features/workbench/explorer/buildExplorerTree";
import { ConnectionTagBadge } from "@/features/workbench/explorer/components/ConnectionTagBadge";
import { useExplorerMetadataStore } from "@/features/workbench/explorer/useExplorerMetadataStore";
import type {
    ConnectionNodeRuntimeMap,
    ExplorerTreeNode,
} from "@/features/workbench/explorer/types";
import { queryKeys } from "@/lib/query-keys";
import { listSavedQueries } from "@/lib/tauri/saved-queries";
import type { DriverCapabilities } from "@/types/ipc";
import type { SavedQuery } from "@/types/saved-queries";
import { useExplorerStore } from "@/store";
import { useConnectionSessionStore } from "@/store/slices/connection-session-slice";

import { ExplorerPanelBody } from "./ExplorerPanelBody";
import { ExplorerPanelDialogs } from "./ExplorerPanelDialogs";
import { ExplorerPanelHeader } from "./ExplorerPanelHeader";
import {
    filterConnectionTreeByQuery,
    collectGroupNodeIds,
} from "./explorer-panel-utils";
import { useExplorerActions } from "./useExplorerActions";
import { useExplorerDialogState } from "./useExplorerDialogState";

const compactCountFormatter = new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
});
const preciseCountFormatter = new Intl.NumberFormat();

function formatItemCount(value: number): string {
    if (value < 1000) {
        return preciseCountFormatter.format(value);
    }

    return compactCountFormatter.format(value);
}

export function WorkbenchExplorerPanel() {
    const {
        connections,
        folders,
        isLoading,
        expandedNodeIds,
        hasPersistedExpandedNodeIds,
        searchQuery,
        loadExplorerData,
        setSearchQuery,
        setNodeExpanded,
    } = useExplorerStore();

    const metadataStore = useExplorerMetadataStore();
    const dialogs = useExplorerDialogState();

    const sessions = useConnectionSessionStore((s) => s.sessions);
    const loadingKeys = useExplorerMetadataStore((s) => s.loadingKeys);

    // 从 session store + loadingKeys 派生连接节点运行时状态，消除本地 useState
    const connectionRuntimeMap = useMemo<ConnectionNodeRuntimeMap>(() => {
        const map: ConnectionNodeRuntimeMap = {};
        for (const [id, session] of Object.entries(sessions)) {
            map[id] = {
                state: session.status,
                errorMessage: session.errorMsg,
            };
        }
        // metadata loading 只覆盖健康/空闲视觉，不能隐藏生命周期异常。
        for (const key of loadingKeys) {
            if (!key.includes("::")) {
                const runtimeState = map[key]?.state;
                if (
                    runtimeState == null ||
                    runtimeState === "idle" ||
                    runtimeState === "connected"
                ) {
                    map[key] = { state: "loading" };
                }
            }
        }
        return map;
    }, [sessions, loadingKeys]);

    // 从会话状态派生 profileId → activeDatabase 映射，用于高亮当前数据库节点
    const activeDatabaseMap = useMemo<Record<string, string>>(() => {
        const map: Record<string, string> = {};
        for (const [id, session] of Object.entries(sessions)) {
            if (session.activeDatabase) {
                map[id] = session.activeDatabase;
            }
        }
        return map;
    }, [sessions]);

    const profileCapabilitiesMap = useMemo<
        Record<string, DriverCapabilities | undefined>
    >(() => {
        const map: Record<string, DriverCapabilities | undefined> = {};
        for (const [id, session] of Object.entries(sessions)) {
            if (session.status === "connected") {
                map[id] = session.capabilities;
            }
        }
        return map;
    }, [sessions]);

    const [isSearchOpen, setIsSearchOpen] = useState(
        () => searchQuery.trim().length > 0,
    );
    const searchInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        void loadExplorerData();
    }, [loadExplorerData]);

    useEffect(() => {
        if (isSearchOpen) {
            searchInputRef.current?.focus();
        }
    }, [isSearchOpen]);

    const savedQueryResults = useQueries({
        queries: connections.map((connection) => ({
            queryKey: queryKeys.savedQueries(connection.id),
            queryFn: () => listSavedQueries(connection.id),
            staleTime: 30_000,
        })),
    });

    const savedQueriesByProfileId = useMemo<Record<string, SavedQuery[]>>(() => {
        return Object.fromEntries(
            connections.map((connection, index) => [
                connection.id,
                savedQueryResults[index]?.data ?? [],
            ]),
        );
    }, [connections, savedQueryResults]);

    const explorerTreeNodes = useMemo<ExplorerTreeNode[]>(
        () => buildExplorerTree(folders, connections, savedQueriesByProfileId),
        [folders, connections, savedQueriesByProfileId],
    );
    const normalizedSearchQuery = searchQuery.trim();
    const isSearchFiltering = normalizedSearchQuery.length > 0;
    const visibleExplorerTreeNodes = useMemo<ExplorerTreeNode[]>(
        () => filterConnectionTreeByQuery(explorerTreeNodes, normalizedSearchQuery),
        [explorerTreeNodes, normalizedSearchQuery],
    );
    const visibleExpandedNodeIds = useMemo(
        () =>
            isSearchFiltering
                ? [
                      ...new Set([
                          ...expandedNodeIds,
                          ...collectGroupNodeIds(visibleExplorerTreeNodes),
                      ]),
                  ]
                : expandedNodeIds,
        [expandedNodeIds, isSearchFiltering, visibleExplorerTreeNodes],
    );

    const actions = useExplorerActions({
        connections,
        explorerTreeNodes,
        loadExplorerData,
        dialogs,
    });

    function handleOpenSearch() {
        setIsSearchOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
    }

    function handleClearSearch() {
        setSearchQuery("");
        searchInputRef.current?.focus();
    }

    function handleSearchBlur(event: React.FocusEvent<HTMLDivElement>) {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
            return;
        }
        if (searchQuery.trim().length === 0) {
            setIsSearchOpen(false);
        }
    }

    function renderRowTrailing(node: ExplorerTreeNode) {
        if (
            node.type === "redis_database" &&
            node.metadata.itemCount != null
        ) {
            return (
                <span
                    className="inline-flex h-5 min-w-6 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-medium leading-none text-muted-foreground ring-1 ring-border/70"
                    title={`${preciseCountFormatter.format(node.metadata.itemCount)} keys`}
                >
                    {formatItemCount(node.metadata.itemCount)}
                </span>
            );
        }

        if (node.type === "connection") {
            return (
                <ConnectionTagBadge
                    tagLabel={node.connection.tagLabel}
                    tagColor={node.connection.tagColor}
                />
            );
        }

        return null;
    }

    return (
        <section className="flex h-full min-h-0 flex-col bg-card text-card-foreground">
            <ExplorerPanelHeader
                isSearchOpen={isSearchOpen}
                searchQuery={searchQuery}
                searchInputRef={searchInputRef}
                onOpenSearch={handleOpenSearch}
                onSearchBlur={handleSearchBlur}
                onSearchQueryChange={setSearchQuery}
                onClearSearch={handleClearSearch}
                onOpenCreateFolder={actions.handleOpenCreateFolderDialog}
                onOpenCreateConnection={() => actions.handleOpenCreateConnection(null)}
            />

            <ExplorerPanelBody
                isLoading={isLoading}
                explorerTreeNodes={explorerTreeNodes}
                visibleExplorerTreeNodes={visibleExplorerTreeNodes}
                folders={folders}
                connections={connections}
                expandedNodeIds={visibleExpandedNodeIds}
                hasPersistedExpandedNodeIds={
                    isSearchFiltering || hasPersistedExpandedNodeIds
                }
                isSearchFiltering={isSearchFiltering}
                connectionRuntimeMap={connectionRuntimeMap}
                loadedConnectionChildrenMap={metadataStore.loadedChildren}
                loadingKeys={loadingKeys}
                activeDatabaseMap={activeDatabaseMap}
                profileCapabilitiesMap={profileCapabilitiesMap}
                savedQueriesByProfileId={savedQueriesByProfileId}
                renderRowTrailing={renderRowTrailing}
                actionHandlers={actions.actionHandlers}
                onReorder={actions.handleReorderConnectionTree}
                onNodeExpandedChange={(id, expanded) => {
                    if (!isSearchFiltering) {
                        setNodeExpanded(id, expanded);
                    }
                }}
                onOpenCreateConnection={() => actions.handleOpenCreateConnection(null)}
                onOpenCreateFolder={actions.handleOpenCreateFolderDialog}
                onRefresh={() => void loadExplorerData()}
            />

            <ExplorerPanelDialogs
                dialogs={dialogs}
                onCreateConnectionNext={actions.handleCreateConnectionNext}
                onExplorerDataChanged={() => void loadExplorerData()}
                onDatabaseMutationCompleted={actions.handleDatabaseMutationCompleted}
                onTableMutationCompleted={actions.handleTableMutationCompleted}
            />
        </section>
    );
}
