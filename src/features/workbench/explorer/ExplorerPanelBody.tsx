import type { ReactNode } from "react";
import { Cable, FolderPlus, Plus, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuGroup,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
    Empty,
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { ConnectionTree } from "@/features/workbench/explorer/components/ConnectionTree";
import type { ExplorerNodeActionHandlers } from "@/features/workbench/explorer/actions";
import type {
    ConnectionNodeRuntimeMap,
    ExplorerTreeNode,
} from "@/features/workbench/explorer/types";
import type {
    ReorderConnectionTreeInput,
    StoredConnectionFolder,
    StoredDatabaseConnection,
} from "@/types";
import type { DriverCapabilities } from "@/types/ipc";
import type { SavedQuery } from "@/types/saved-queries";

interface ExplorerPanelBodyProps {
    isLoading: boolean;
    explorerTreeNodes: ExplorerTreeNode[];
    visibleExplorerTreeNodes: ExplorerTreeNode[];
    folders: StoredConnectionFolder[];
    connections: StoredDatabaseConnection[];
    expandedNodeIds: string[];
    hasPersistedExpandedNodeIds: boolean;
    isSearchFiltering: boolean;
    connectionRuntimeMap: ConnectionNodeRuntimeMap;
    loadedConnectionChildrenMap: Record<string, ExplorerTreeNode[]>;
    loadingKeys: Set<string>;
    activeDatabaseMap: Record<string, string>;
    profileCapabilitiesMap: Record<string, DriverCapabilities | undefined>;
    savedQueriesByProfileId: Record<string, SavedQuery[]>;
    renderRowTrailing?: (node: ExplorerTreeNode, depth: number) => ReactNode;
    actionHandlers: ExplorerNodeActionHandlers;
    onReorder: (input: ReorderConnectionTreeInput) => Promise<void>;
    onNodeExpandedChange: (id: string, expanded: boolean) => void;
    onOpenCreateConnection: () => void;
    onOpenCreateFolder: () => void;
    onRefresh: () => void;
}

export function ExplorerPanelBody({
    isLoading,
    explorerTreeNodes,
    visibleExplorerTreeNodes,
    folders,
    connections,
    expandedNodeIds,
    hasPersistedExpandedNodeIds,
    isSearchFiltering,
    connectionRuntimeMap,
    loadedConnectionChildrenMap,
    loadingKeys,
    activeDatabaseMap,
    profileCapabilitiesMap,
    savedQueriesByProfileId,
    renderRowTrailing,
    actionHandlers,
    onReorder,
    onNodeExpandedChange,
    onOpenCreateConnection,
    onOpenCreateFolder,
    onRefresh,
}: ExplorerPanelBodyProps) {
    function renderBodyContent() {
        if (isLoading) {
            return (
                <div className="flex min-h-0 flex-1 items-center justify-center">
                    <Spinner className="size-5" />
                </div>
            );
        }

        if (explorerTreeNodes.length === 0) {
            return (
                <Empty className="m-4">
                    <EmptyHeader>
                        <EmptyMedia variant="icon">
                            <Cable />
                        </EmptyMedia>
                        <EmptyTitle>还没有连接</EmptyTitle>
                        <EmptyDescription>
                            立即创建您的第一个项目，开始体验吧。
                        </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent className="flex-row justify-center gap-2">
                        <Button onClick={onOpenCreateConnection}>
                            新建连接
                        </Button>
                    </EmptyContent>
                </Empty>
            );
        }

        if (isSearchFiltering && visibleExplorerTreeNodes.length === 0) {
            return (
                <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-6 text-center text-sm text-muted-foreground">
                    没有匹配的连接
                </div>
            );
        }

        return (
            <ConnectionTree
                nodes={visibleExplorerTreeNodes}
                folders={folders}
                connections={connections}
                expandedNodeIds={expandedNodeIds}
                hasPersistedExpandedNodeIds={hasPersistedExpandedNodeIds}
                dragDisabled={isSearchFiltering}
                connectionRuntimeMap={connectionRuntimeMap}
                loadedConnectionChildrenMap={loadedConnectionChildrenMap}
                loadingKeys={loadingKeys}
                activeDatabaseMap={activeDatabaseMap}
                profileCapabilitiesMap={profileCapabilitiesMap}
                savedQueriesByProfileId={savedQueriesByProfileId}
                renderRowTrailing={renderRowTrailing}
                actionHandlers={actionHandlers}
                onReorder={onReorder}
                onNodeExpandedChange={onNodeExpandedChange}
            />
        );
    }

    return (
        <ContextMenu>
            <ContextMenuTrigger
                render={<div className="flex min-h-0 min-w-0 flex-1 bg-muted/10">
                    {renderBodyContent()}
                </div>}
            />

            <ContextMenuContent>
                <ContextMenuGroup>
                    <ContextMenuLabel>连接列表</ContextMenuLabel>
                    <ContextMenuItem onClick={onOpenCreateConnection}>
                        <Plus />
                        新建连接
                    </ContextMenuItem>
                    <ContextMenuItem onClick={onOpenCreateFolder}>
                        <FolderPlus />
                        新建文件夹
                    </ContextMenuItem>
                </ContextMenuGroup>
                <ContextMenuSeparator />
                <ContextMenuGroup>
                    <ContextMenuItem onClick={onRefresh}>
                        <RefreshCw />
                        刷新
                    </ContextMenuItem>
                </ContextMenuGroup>
            </ContextMenuContent>
        </ContextMenu>
    );
}
