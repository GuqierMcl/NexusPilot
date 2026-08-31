import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import {
    ChevronRight,
} from "lucide-react";

import {
    Collapsible,
    CollapsibleContent,
} from "@/components/ui/collapsible";
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
    HoverCard,
    HoverCardContent,
    HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { buildExplorerNodeActionSet } from "@/features/workbench/explorer/actions";
import { getDriverConfig } from "@/features/workbench/explorer/driver-configs";
import type {
    ExplorerNodeAction,
    ExplorerNodeActionHandlers,
} from "@/features/workbench/explorer/actions";
import { buildSavedQueryGroupForRemoteNode } from "@/features/workbench/explorer/savedQueryNodes";
import { buildConnectionHoverCardModel } from "@/features/workbench/explorer/connection-hover-card";
import { ConnectionHoverCardContent } from "@/features/workbench/explorer/components/ConnectionHoverCardContent";
import { ExplorerNodeIcon } from "@/features/workbench/explorer/components/ExplorerNodeIcon";
import { ExplorerNodeProperties } from "@/features/workbench/explorer/components/ExplorerNodeProperties";
import { getConnectionNodeLabelClassName } from "@/features/workbench/explorer/components/explorerNodeLabel";
import type {
    ConnectionNodeRuntimeState,
    ConnectionNodeStatus,
    ConnectionNodeRuntimeMap,
    ConnectionStatusIndicatorMode,
    ExplorerTreeNode,
} from "@/features/workbench/explorer/types";
import type { DbDriver } from "@/types";
import type { DriverCapabilities } from "@/types/ipc";
import type { SavedQuery } from "@/types/saved-queries";

type ConnectionTreeNodeProps = {
    node: ExplorerTreeNode;
    depth: number;
    selectedNodeId: string | null;
    connectionRuntimeMap: ConnectionNodeRuntimeMap;
    loadedConnectionChildrenMap: Record<string, ExplorerTreeNode[]>;
    loadingKeys?: Set<string>;
    connectionStatusIndicatorMode: ConnectionStatusIndicatorMode;
    /** profileId → activeDatabase 的映射，用于高亮当前数据库节点 */
    activeDatabaseMap?: Record<string, string>;
    connectionDriverMap?: Record<string, DbDriver | undefined>;
    profileCapabilitiesMap?: Record<string, DriverCapabilities | undefined>;
    savedQueriesByProfileId?: Record<string, SavedQuery[]>;
    actionHandlers: ExplorerNodeActionHandlers;
    onSelectNode: (node: ExplorerTreeNode) => void;
    expandedNodeIds: string[];
    hasPersistedExpandedNodeIds: boolean;
    onNodeExpandedChange: (id: string, expanded: boolean) => void;
    renderRowShell?: (
        node: ExplorerTreeNode,
        depth: number,
        row: ReactNode,
    ) => ReactNode;
    renderRowTrailing?: (
        node: ExplorerTreeNode,
        depth: number,
    ) => ReactNode;
    autoOpenRequest?: {
        nodeId: string;
        requestId: number;
    } | null;
};

const INDENT_STEP = 14;

export function decideConnectionExpandAction(
    hasLoadedChildren: boolean,
    hasChildren: boolean,
): "hydrate" | "toggle" | "none" {
    if (!hasLoadedChildren) return "hydrate";
    return hasChildren ? "toggle" : "none";
}

/** 所有远程节点类型（域 B）——子节点从 loadedConnectionChildrenMap 中按 id 查取。 */
const REMOTE_NODE_TYPES = new Set<string>([
    "connection",
    "database",
    "schema",
    "asset_group",
    "table",
    "view",
    "materialized_view",
    "function",
    "procedure",
    "trigger",
    "index",
    "dictionary",
    "projection",
    "sequence",
    "extension",
    "event",
    "column",
    "collection",
    "document",
    "field",
    "node_label",
    "relationship_type",
    "vector_collection",
    "partition",
    "search_index",
    "data_stream",
    "mapping_field",
    "redis_database",
    "redis_key_prefix",
    "redis_key",
]);

function getVisualConnectionStatus(
    node: ExplorerTreeNode,
    connectionRuntimeState?: ConnectionNodeRuntimeState,
): ConnectionNodeStatus | undefined {
    if (node.type !== "connection") {
        return undefined;
    }

    if (
        connectionRuntimeState === "connected" ||
        connectionRuntimeState === "degraded" ||
        connectionRuntimeState === "reconnecting"
    ) {
        return "connected";
    }

    if (
        connectionRuntimeState === "error" ||
        connectionRuntimeState === "disconnecting"
    ) {
        return "disconnected";
    }

    return node.status;
}

function getConnectionStatusRailClassName(
    node: ExplorerTreeNode,
    status: ConnectionNodeStatus | undefined,
    runtimeState: ConnectionNodeRuntimeState | undefined,
    mode: ConnectionStatusIndicatorMode,
): string | null {
    if (node.type !== "connection" || mode === "none") {
        return null;
    }

    if (runtimeState === "loading") {
        return null;
    }

    if (runtimeState === "connecting" || runtimeState === "reconnecting") {
        return "animate-pulse bg-amber-500/60";
    }

    if (runtimeState === "degraded") {
        return "bg-amber-500/60";
    }

    if (runtimeState === "error") {
        return "bg-rose-500/60";
    }

    if (runtimeState === "disconnecting") {
        return "bg-muted-foreground/40";
    }

    if (status === "connected") {
        return "bg-emerald-500/60";
    }

    if (mode === "all" && status === "disconnected") {
        return "bg-rose-500/60";
    }

    return null;
}

export function ConnectionTreeNode({
    node,
    depth,
    selectedNodeId,
    connectionRuntimeMap,
    loadedConnectionChildrenMap,
    loadingKeys,
    connectionStatusIndicatorMode,
    activeDatabaseMap,
    connectionDriverMap,
    profileCapabilitiesMap,
    savedQueriesByProfileId,
    actionHandlers,
    onSelectNode,
    expandedNodeIds,
    hasPersistedExpandedNodeIds,
    onNodeExpandedChange,
    renderRowShell,
    renderRowTrailing,
    autoOpenRequest,
}: ConnectionTreeNodeProps) {
    const profileId =
        node.type === "connection"
            ? node.id
            : "profileId" in node
              ? node.profileId
            : "metadata" in node
              ? node.metadata.profileId
              : undefined;
    const connectionRuntimeState =
        profileId != null
            ? connectionRuntimeMap[profileId]?.state ?? "idle"
            : undefined;

    const isRemoteNode = REMOTE_NODE_TYPES.has(node.type);
    const localChildren = node.children ?? [];
    const remoteChildren = loadedConnectionChildrenMap[node.id] ?? [];
    const profileDriver =
        profileId != null ? connectionDriverMap?.[profileId] : undefined;
    const connectionDriver =
        node.type === "connection" ? node.connection.driver : profileDriver;
    const driverConfig = connectionDriver
        ? getDriverConfig(connectionDriver)
        : undefined;
    const contextSavedQueryGroup =
        profileId != null
            ? buildSavedQueryGroupForRemoteNode(
                  node,
                  savedQueriesByProfileId?.[profileId] ?? [],
                  driverConfig,
              )
            : null;
    const contextSavedQueryChildren = contextSavedQueryGroup
        ? [contextSavedQueryGroup]
        : [];
    const renderedChildren =
        node.type === "connection"
            ? [...localChildren, ...remoteChildren]
            : isRemoteNode
              ? [...remoteChildren, ...contextSavedQueryChildren]
              : localChildren;

    // connection 节点的 loading 状态来自 connectionRuntimeMap，
    // 其他远程节点的 loading 状态来自 loadingKeys
    const isNodeLoading =
        connectionRuntimeState === "loading" ||
        (isRemoteNode && node.type !== "connection" && (loadingKeys?.has(node.id) ?? false));
    const visualConnectionStatus = getVisualConnectionStatus(
        node,
        connectionRuntimeState,
    );
    const isLeafNode = ("isLeaf" in node && node.isLeaf) === true;
    const isConnectionNode = node.type === "connection";
    // 节点是否已在 loadedConnectionChildrenMap 中有子数据
    const hasLoadedChildren = node.id in loadedConnectionChildrenMap;
    // 数据库节点是否为当前活跃数据库
    const isActiveDatabase =
        node.type === "database" && node.metadata
            ? (activeDatabaseMap?.[node.metadata.profileId] === node.metadata.dbName)
            : false;
    const canLazyLoadRemote =
        isRemoteNode && !isConnectionNode && !isLeafNode && !hasLoadedChildren;
    const canExpand = !isLeafNode && (renderedChildren.length > 0);
    const hasChildren = renderedChildren.length > 0;
    const isLocalFolderNode = node.type === "group";
    const getInitialOpen = () =>
        isLocalFolderNode && hasPersistedExpandedNodeIds
            ? expandedNodeIds.includes(node.id)
            : (node.defaultExpanded ?? false);
    const [open, setOpen] = useState(getInitialOpen);
    const isSelected = selectedNodeId === node.id;
    const capabilities =
        node.type === "connection"
            ? profileCapabilitiesMap?.[node.id]
            : profileId != null
              ? profileCapabilitiesMap?.[profileId]
              : undefined;
    const trailingContent = renderRowTrailing?.(node, depth) ?? null;
    const rowClassName = cn(
        "relative w-full overflow-hidden rounded-md py-1.5 pr-2 text-left text-sm transition-colors",
        trailingContent ? "grid items-center" : "flex items-center",
        isSelected
            ? "bg-accent text-accent-foreground"
            : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
    );

    const rowStyle = {
        paddingLeft: 8 + depth * INDENT_STEP,
        ...(trailingContent
            ? {
                  gridTemplateColumns:
                      "minmax(4rem, 1fr) minmax(0, max-content)",
              }
            : {}),
    };

    useEffect(() => {
        if (autoOpenRequest?.nodeId === node.id && hasChildren) {
            updateOpen(true);
        }
    }, [autoOpenRequest?.nodeId, autoOpenRequest?.requestId, hasChildren, node.id]);

    useEffect(() => {
        if (!isLocalFolderNode || !hasPersistedExpandedNodeIds) {
            return;
        }
        setOpen(expandedNodeIds.includes(node.id));
    }, [expandedNodeIds, hasPersistedExpandedNodeIds, isLocalFolderNode, node.id]);

    function updateOpen(nextOpen: boolean) {
        setOpen(nextOpen);
        if (isLocalFolderNode) {
            onNodeExpandedChange(node.id, nextOpen);
        }
    }

    function toggleOpen() {
        const nextOpen = !open;
        updateOpen(nextOpen);
    }

    function toggleExpand() {
        if (isNodeLoading || isLeafNode) return;

        if (isConnectionNode) {
            const action = decideConnectionExpandAction(
                hasLoadedChildren,
                hasChildren,
            );
            if (action === "hydrate") {
                actionHandlers.expandNode?.(node);
                updateOpen(true);
                return;
            }
            if (action === "toggle") {
                toggleOpen();
            }
            return;
        }

        if (isRemoteNode) {
            if (!hasLoadedChildren && !isLeafNode) {
                actionHandlers.expandNode?.(node);
                updateOpen(true);
                return;
            }
            if (hasChildren) {
                toggleOpen();
            }
            return;
        }

        if (hasChildren) {
            toggleOpen();
        }
    }

    async function handleDoubleClick() {
        if (primaryAction && !primaryAction.disabled) {
            const success = await primaryAction.run();
            if (success) {
                updateOpen(true);
            }
            return;
        }

        toggleExpand();
    }

    function handleClick() {
        onSelectNode(node);
    }

    function handleChevronClick(e: React.MouseEvent) {
        e.stopPropagation();
        toggleExpand();
    }

    function handleMainActionKeyDown(e: KeyboardEvent<HTMLDivElement>) {
        if (e.key !== "Enter" && e.key !== " ") {
            return;
        }

        e.preventDefault();
        handleClick();
    }

    const canShowChevron =
        !isLeafNode &&
        (canExpand || canLazyLoadRemote || isConnectionNode || isNodeLoading);
    const canChevronClick = canShowChevron;
    const isExpandedNode = open && hasChildren;
    const isLoadedRemoteNode =
        isRemoteNode && !isConnectionNode && hasLoadedChildren;
    const shouldEmphasizeNode =
        isExpandedNode ||
        isLoadedRemoteNode ||
        connectionRuntimeState === "connected" ||
        connectionRuntimeState === "degraded" ||
        connectionRuntimeState === "reconnecting";
    const statusRailClassName = getConnectionStatusRailClassName(
        node,
        visualConnectionStatus,
        connectionRuntimeState,
        connectionStatusIndicatorMode,
    );

    const rowContent = (
        <>
            <span
                className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
                onClick={canChevronClick ? handleChevronClick : undefined}
                style={{ cursor: canChevronClick ? "pointer" : "default" }}
            >
                {isNodeLoading ? (
                    <Spinner className="size-3.5" />
                ) : canShowChevron ? (
                    <ChevronRight
                        className={cn("size-4 transition-transform", open && hasChildren && "rotate-90")}
                    />
                ) : null}
            </span>

            <span className="shrink-0 flex items-center">
                <ExplorerNodeIcon
                    node={node}
                    open={open}
                    connectionStatus={visualConnectionStatus}
                    connectionRuntimeState={connectionRuntimeState}
                    connectionStatusIndicatorMode={connectionStatusIndicatorMode}
                />
            </span>
            <span
                className={cn(
                    "min-w-4 flex-1 truncate",
                    getConnectionNodeLabelClassName(node, visualConnectionStatus),
                    shouldEmphasizeNode && "font-medium text-foreground",
                    (isExpandedNode || isActiveDatabase) &&
                        "font-semibold text-foreground",
                )}
            >
                {node.label}
            </span>
            {"metadata" in node ? (
                <ExplorerNodeProperties
                    properties={node.metadata.properties}
                />
            ) : null}
        </>
    );

    const rowRoot = (
        <div
            className={rowClassName}
            style={rowStyle}
            onContextMenu={() => onSelectNode(node)}
        >
            {statusRailClassName ? (
                <span
                    aria-hidden="true"
                    className={cn(
                        "pointer-events-none absolute inset-y-1 w-0.5 rounded-full",
                        statusRailClassName,
                    )}
                    style={{ left: 2 + depth * INDENT_STEP }}
                />
            ) : null}

            <div
                role="button"
                tabIndex={0}
                className={cn(
                    "min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                    isConnectionNode && trailingContent
                        ? "grid grid-cols-[1rem_1.25rem_minmax(1rem,1fr)] items-center gap-1.5"
                        : "flex flex-1 items-center gap-1.5",
                )}
                onClick={handleClick}
                onDoubleClick={() => void handleDoubleClick()}
                onKeyDown={handleMainActionKeyDown}
                aria-expanded={canExpand ? open : undefined}
            >
                {rowContent}
            </div>

            {trailingContent ? (
                <div className="-my-px ml-2 flex min-w-0 items-center justify-end gap-1 overflow-hidden px-px py-px">
                    {trailingContent}
                </div>
            ) : null}
        </div>
    );

    const actionSet = buildExplorerNodeActionSet({
        node,
        connectionDriver,
        connectionRuntimeState,
        capabilities,
        isNodeLoading,
        isLeafNode,
        hasChildren,
        hasLoadedChildren,
        handlers: actionHandlers,
    });
    const primaryAction = actionSet.primaryActionId
        ? actionSet.groups
              .flatMap((group) => group.actions)
              .find((action) => action.id === actionSet.primaryActionId)
        : undefined;

    async function runAction(action: ExplorerNodeAction) {
        const success = await action.run();
        if (success) {
            updateOpen(true);
        }
    }

    function renderAction(action: ExplorerNodeAction) {
        const Icon = action.icon;
        return (
            <ContextMenuItem
                key={action.id}
                disabled={action.disabled}
                onClick={() => void runAction(action)}
            >
                {Icon ? <Icon /> : null}
                {action.label}
            </ContextMenuItem>
        );
    }

    const contextMenuContent = (
        <ContextMenuContent>
            <div className="px-1.5 py-1 text-xs font-medium text-muted-foreground">
                {actionSet.label}
            </div>
            {actionSet.groups.map((group, index) => (
                <ContextMenuGroup key={group.id}>
                    {index > 0 && <ContextMenuSeparator />}
                    {group.label ? (
                        <ContextMenuLabel>{group.label}</ContextMenuLabel>
                    ) : null}
                    {group.actions.map(renderAction)}
                </ContextMenuGroup>
            ))}
        </ContextMenuContent>
    );
    const hoverRenderedRow = node.type === "connection" ? (
        <ContextMenu>
            <HoverCard>
                <HoverCardTrigger
                    delay={280}
                    closeDelay={120}
                    render={<ContextMenuTrigger render={rowRoot} />}
                />
                <HoverCardContent
                    side="right"
                    align="start"
                    sideOffset={8}
                    className="w-80 p-0"
                >
                    <ConnectionHoverCardContent
                        model={buildConnectionHoverCardModel(
                            node.connection,
                            driverConfig?.displayName ?? node.connection.driver,
                        )}
                    />
                </HoverCardContent>
            </HoverCard>
            {contextMenuContent}
        </ContextMenu>
    ) : (
        <ContextMenu>
            <ContextMenuTrigger render={rowRoot} />
            {contextMenuContent}
        </ContextMenu>
    );
    const renderedRow = renderRowShell
        ? renderRowShell(node, depth, hoverRenderedRow)
        : hoverRenderedRow;

    if (!canExpand) {
        return renderedRow;
    }

    return (
        <Collapsible
            className="w-full min-w-0 max-w-full"
            open={open && hasChildren}
            onOpenChange={updateOpen}
        >
            {renderedRow}

            <CollapsibleContent className="w-full min-w-0 max-w-full">
                <div className="flex w-full min-w-0 max-w-full flex-col gap-0.5 py-0.5">
                    {renderedChildren.map((child) => (
                        <ConnectionTreeNode
                            key={child.id}
                            node={child}
                            depth={depth + 1}
                            selectedNodeId={selectedNodeId}
                            connectionRuntimeMap={connectionRuntimeMap}
                            loadedConnectionChildrenMap={loadedConnectionChildrenMap}
                            loadingKeys={loadingKeys}
                            connectionStatusIndicatorMode={
                                connectionStatusIndicatorMode
                            }
                            activeDatabaseMap={activeDatabaseMap}
                            connectionDriverMap={connectionDriverMap}
                            profileCapabilitiesMap={profileCapabilitiesMap}
                            savedQueriesByProfileId={savedQueriesByProfileId}
                            actionHandlers={actionHandlers}
                            onSelectNode={onSelectNode}
                            expandedNodeIds={expandedNodeIds}
                            hasPersistedExpandedNodeIds={
                                hasPersistedExpandedNodeIds
                            }
                            onNodeExpandedChange={onNodeExpandedChange}
                            renderRowShell={renderRowShell}
                            renderRowTrailing={renderRowTrailing}
                            autoOpenRequest={autoOpenRequest}
                        />
                    ))}
                </div>
            </CollapsibleContent>
        </Collapsible>
    );
}
