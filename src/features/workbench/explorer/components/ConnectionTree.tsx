import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
    DndContext,
    DragOverlay,
    MouseSensor,
    pointerWithin,
    useDraggable,
    useDroppable,
    useSensor,
    useSensors,
    type DragEndEvent,
    type DragOverEvent,
    type DragStartEvent,
} from "@dnd-kit/core";
import { toast } from "@/components/ui/toast";

import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
    calculateConnectionTreeReorder,
    type ConnectionTreeDropData,
    type ConnectionTreeDropPosition,
} from "@/features/workbench/explorer/connection-tree-dnd";
import type { ExplorerNodeActionHandlers } from "@/features/workbench/explorer/actions";
import { ConnectionTreeNode } from "@/features/workbench/explorer/components/ConnectionTreeNode";
import { ExplorerNodeIcon } from "@/features/workbench/explorer/components/ExplorerNodeIcon";
import { getConnectionNodeLabelClassName } from "@/features/workbench/explorer/components/explorerNodeLabel";
import type {
    ConnectionNodeRuntimeMap,
    ConnectionStatusIndicatorMode,
    ExplorerTreeNode,
} from "@/features/workbench/explorer/types";
import type {
    DbDriver,
    ReorderConnectionTreeInput,
    StoredConnectionFolder,
    StoredDatabaseConnection,
} from "@/types";
import type { DriverCapabilities } from "@/types/ipc";
import type { SavedQuery } from "@/types/saved-queries";

type ConnectionTreeProps = {
    nodes: ExplorerTreeNode[];
    folders: StoredConnectionFolder[];
    connections: StoredDatabaseConnection[];
    expandedNodeIds: string[];
    hasPersistedExpandedNodeIds: boolean;
    dragDisabled?: boolean;
    className?: string;
    connectionStatusIndicatorMode?: ConnectionStatusIndicatorMode;
    connectionRuntimeMap?: ConnectionNodeRuntimeMap;
    loadedConnectionChildrenMap?: Record<string, ExplorerTreeNode[]>;
    loadingKeys?: Set<string>;
    activeDatabaseMap?: Record<string, string>;
    profileCapabilitiesMap?: Record<string, DriverCapabilities | undefined>;
    savedQueriesByProfileId?: Record<string, SavedQuery[]>;
    renderRowTrailing?: (node: ExplorerTreeNode, depth: number) => ReactNode;
    actionHandlers: ExplorerNodeActionHandlers;
    onReorder: (input: ReorderConnectionTreeInput) => Promise<void>;
    onNodeExpandedChange: (id: string, expanded: boolean) => void;
};

type LocalExplorerNode = Extract<ExplorerTreeNode, { type: "group" | "connection" }>;
type ExplorerNodeEntry = {
    node: ExplorerTreeNode;
    depth: number;
};
type AutoOpenRequest = {
    nodeId: string;
    requestId: number;
};

function isLocalDraggableNode(node: ExplorerTreeNode): node is LocalExplorerNode {
    return node.type === "group" || node.type === "connection";
}

function findNodeEntryById(
    nodes: ExplorerTreeNode[],
    id: string,
    depth = 0,
): ExplorerNodeEntry | undefined {
    for (const node of nodes) {
        if (node.id === id) return { node, depth };
        if (node.children) {
            const found = findNodeEntryById(node.children, id, depth + 1);
            if (found) return found;
        }
    }

    return undefined;
}

function getInitialSelectedNodeId(nodes: ExplorerTreeNode[]): string | null {
    for (const node of nodes) {
        if (node.type === "connection") {
            return node.id;
        }

        if (node.children?.length) {
            const nestedId = getInitialSelectedNodeId(node.children);
            if (nestedId) {
                return nestedId;
            }
        }
    }

    return nodes[0]?.id ?? null;
}

export function ConnectionTree({
    nodes,
    folders,
    connections,
    expandedNodeIds,
    hasPersistedExpandedNodeIds,
    dragDisabled = false,
    className,
    connectionStatusIndicatorMode = "connected-only",
    connectionRuntimeMap = {},
    loadedConnectionChildrenMap = {},
    loadingKeys,
    activeDatabaseMap,
    profileCapabilitiesMap,
    savedQueriesByProfileId,
    renderRowTrailing,
    actionHandlers,
    onReorder,
    onNodeExpandedChange,
}: ConnectionTreeProps) {
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() =>
        getInitialSelectedNodeId(nodes),
    );
    const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
    const [activeDrop, setActiveDrop] = useState<ConnectionTreeDropData | null>(null);
    const [autoOpenRequest, setAutoOpenRequest] =
        useState<AutoOpenRequest | null>(null);
    const [isPersistingReorder, setIsPersistingReorder] = useState(false);
    const autoOpenTimerRef = useRef<number | null>(null);
    const autoOpenTargetRef = useRef<string | null>(null);
    const autoOpenRequestIdRef = useRef(0);
    const connectionDriverMap = useMemo<Record<string, DbDriver>>(
        () =>
            Object.fromEntries(
                connections.map((connection) => [connection.id, connection.driver]),
            ) as Record<string, DbDriver>,
        [connections],
    );

    const sensors = useSensors(
        useSensor(MouseSensor, {
            activationConstraint: { distance: 5 },
        }),
    );

    const draggingEntry = draggingNodeId ? findNodeEntryById(nodes, draggingNodeId) : null;
    const draggingNode = draggingEntry?.node ?? null;
    const isDragDisabled = dragDisabled || isPersistingReorder;

    useEffect(() => {
        return () => {
            clearAutoOpenTimer();
        };
    }, []);

    useEffect(() => {
        if (selectedNodeId && findNodeEntryById(nodes, selectedNodeId)) {
            return;
        }
        setSelectedNodeId(getInitialSelectedNodeId(nodes));
    }, [nodes, selectedNodeId]);

    function clearAutoOpenTimer() {
        if (autoOpenTimerRef.current != null) {
            window.clearTimeout(autoOpenTimerRef.current);
            autoOpenTimerRef.current = null;
        }
        autoOpenTargetRef.current = null;
    }

    function scheduleAutoOpen(dropData: ConnectionTreeDropData | null) {
        if (dropData?.position !== "inside" || !dropData.nodeId) {
            clearAutoOpenTimer();
            return;
        }

        const targetEntry = findNodeEntryById(nodes, dropData.nodeId);
        const targetNode = targetEntry?.node;
        if (
            !targetNode ||
            targetNode.type !== "group" ||
            !targetNode.children?.length ||
            targetNode.id === draggingNodeId
        ) {
            clearAutoOpenTimer();
            return;
        }

        if (autoOpenTargetRef.current === targetNode.id) return;

        clearAutoOpenTimer();
        autoOpenTargetRef.current = targetNode.id;
        autoOpenTimerRef.current = window.setTimeout(() => {
            setAutoOpenRequest({
                nodeId: targetNode.id,
                requestId: autoOpenRequestIdRef.current + 1,
            });
            autoOpenRequestIdRef.current += 1;
            clearAutoOpenTimer();
        }, 650);
    }

    function handleDragStart({ active }: DragStartEvent) {
        if (isDragDisabled) return;
        setDraggingNodeId(String(active.id));
    }

    function handleDragOver({ active, over }: DragOverEvent) {
        if (!over || isDragDisabled) {
            setActiveDrop(null);
            scheduleAutoOpen(null);
            return;
        }

        const activeEntry = findNodeEntryById(nodes, String(active.id));
        const activeNode = activeEntry?.node;
        if (!activeNode || !isLocalDraggableNode(activeNode)) {
            setActiveDrop(null);
            scheduleAutoOpen(null);
            return;
        }

        const dropData = over.data.current as ConnectionTreeDropData | undefined;
        if (!dropData) {
            setActiveDrop(null);
            scheduleAutoOpen(null);
            return;
        }

        const result = calculateConnectionTreeReorder({
            activeId: activeNode.id,
            activeType: activeNode.type,
            over: dropData,
            folders,
            connections,
        });

        const nextActiveDrop = result && !("error" in result) ? dropData : null;
        setActiveDrop(nextActiveDrop);
        scheduleAutoOpen(nextActiveDrop);
    }

    function handleDragEnd({ active, over }: DragEndEvent) {
        setDraggingNodeId(null);
        setActiveDrop(null);
        clearAutoOpenTimer();
        if (!over || isDragDisabled) return;

        const activeNode = findNodeEntryById(nodes, String(active.id))?.node;
        if (!activeNode || !isLocalDraggableNode(activeNode)) return;

        const dropData = over.data.current as ConnectionTreeDropData | undefined;
        if (!dropData) return;

        const result = calculateConnectionTreeReorder({
            activeId: activeNode.id,
            activeType: activeNode.type,
            over: dropData,
            folders,
            connections,
        });

        if (!result) return;

        if ("error" in result) {
            toast.error(result.error);
            return;
        }

        setIsPersistingReorder(true);
        void onReorder(result.input)
            .then(() => {
                toast.success("连接列表顺序已更新");
            })
            .catch((error) => {
                console.error("[explorer] reorder connection tree failed", error);
                toast.error(
                    error instanceof Error ? error.message : "连接列表排序更新失败",
                );
            })
            .finally(() => {
                setIsPersistingReorder(false);
            });
    }

    function handleDragCancel() {
        setDraggingNodeId(null);
        setActiveDrop(null);
        clearAutoOpenTimer();
    }

    if (nodes.length === 0) {
        return (
            <div
                className={cn(
                    "flex min-h-0 flex-1 items-center justify-center px-4 py-6 text-center text-sm text-muted-foreground",
                    className,
                )}
            >
                暂无连接数据
            </div>
        );
    }

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={pointerWithin}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
        >
            <ScrollArea
                contentWidth="viewport"
                className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}
            >
                <nav
                    aria-label="连接列表树"
                    className="flex w-full min-w-0 max-w-full flex-col overflow-hidden py-2"
                >
                    <div className="flex w-full min-w-0 max-w-full flex-col gap-0.5 px-2">
                        {nodes.map((node) => (
                            <ConnectionTreeNode
                                key={node.id}
                                node={node}
                                depth={0}
                                selectedNodeId={selectedNodeId}
                                connectionRuntimeMap={connectionRuntimeMap}
                                loadedConnectionChildrenMap={
                                    loadedConnectionChildrenMap
                                }
                                loadingKeys={loadingKeys}
                                connectionStatusIndicatorMode={
                                    connectionStatusIndicatorMode
                                }
                                activeDatabaseMap={activeDatabaseMap}
                                connectionDriverMap={connectionDriverMap}
                                profileCapabilitiesMap={profileCapabilitiesMap}
                                savedQueriesByProfileId={savedQueriesByProfileId}
                                renderRowTrailing={renderRowTrailing}
                                actionHandlers={actionHandlers}
                                onSelectNode={(selectedNode) =>
                                    setSelectedNodeId(selectedNode.id)
                                }
                                expandedNodeIds={expandedNodeIds}
                                hasPersistedExpandedNodeIds={
                                    hasPersistedExpandedNodeIds
                                }
                                onNodeExpandedChange={onNodeExpandedChange}
                                autoOpenRequest={autoOpenRequest}
                                renderRowShell={(currentNode, depth, row) => (
                                    <ConnectionTreeDragShell
                                        key={`shell-${currentNode.id}`}
                                        node={currentNode}
                                        depth={depth}
                                        disabled={isDragDisabled}
                                        activeDrop={activeDrop}
                                    >
                                        {row}
                                    </ConnectionTreeDragShell>
                                )}
                            />
                        ))}
                        <RootDropZone
                            enabled={draggingNodeId != null && !isDragDisabled}
                            activeDrop={activeDrop}
                        />
                    </div>
                </nav>
            </ScrollArea>
            <DragOverlay>
                {draggingNode && isLocalDraggableNode(draggingNode) ? (
                    <ConnectionTreeDragPreview
                        node={draggingNode}
                        depth={draggingEntry?.depth ?? 0}
                        connectionRuntimeMap={connectionRuntimeMap}
                        connectionStatusIndicatorMode={connectionStatusIndicatorMode}
                    />
                ) : null}
            </DragOverlay>
        </DndContext>
    );
}

function droppableId(nodeId: string, position: ConnectionTreeDropPosition) {
    return `${nodeId}:${position}`;
}

function ConnectionTreeDragShell({
    node,
    depth,
    disabled,
    activeDrop,
    children,
}: {
    node: ExplorerTreeNode;
    depth: number;
    disabled: boolean;
    activeDrop: ConnectionTreeDropData | null;
    children: ReactNode;
}) {
    if (!isLocalDraggableNode(node)) {
        return <>{children}</>;
    }

    return (
        <LocalConnectionTreeDragShell
            node={node}
            depth={depth}
            disabled={disabled}
            activeDrop={activeDrop}
        >
            {children}
        </LocalConnectionTreeDragShell>
    );
}

function LocalConnectionTreeDragShell({
    node,
    depth,
    disabled,
    activeDrop,
    children,
}: {
    node: LocalExplorerNode;
    depth: number;
    disabled: boolean;
    activeDrop: ConnectionTreeDropData | null;
    children: ReactNode;
}) {
    const draggable = useDraggable({
        id: node.id,
        disabled,
        data: { nodeType: node.type },
    });
    const before = useDroppable({
        id: droppableId(node.id, "before"),
        disabled,
        data: { nodeId: node.id, position: "before" } satisfies ConnectionTreeDropData,
    });
    const inside = useDroppable({
        id: droppableId(node.id, "inside"),
        disabled: disabled || node.type !== "group",
        data: { nodeId: node.id, position: "inside" } satisfies ConnectionTreeDropData,
    });
    const after = useDroppable({
        id: droppableId(node.id, "after"),
        disabled,
        data: { nodeId: node.id, position: "after" } satisfies ConnectionTreeDropData,
    });

    const style: React.CSSProperties = {
        opacity: draggable.isDragging ? 0.45 : 1,
        cursor: draggable.isDragging ? "grabbing" : "default",
    };
    const dropPosition =
        activeDrop?.nodeId === node.id ? activeDrop.position : null;

    return (
        <div
            ref={draggable.setNodeRef}
            style={style}
            className="relative rounded-md"
            {...draggable.attributes}
            {...draggable.listeners}
        >
            {children}
            <DropHitArea position="before" setNodeRef={before.setNodeRef} />
            {node.type === "group" ? (
                <DropHitArea position="inside" setNodeRef={inside.setNodeRef} />
            ) : null}
            <DropHitArea position="after" setNodeRef={after.setNodeRef} />
            <DropIndicator position={dropPosition} depth={depth} />
        </div>
    );
}

function DropHitArea({
    position,
    setNodeRef,
}: {
    position: ConnectionTreeDropPosition;
    setNodeRef: (element: HTMLElement | null) => void;
}) {
    return (
        <span
            ref={setNodeRef}
            className={cn(
                "pointer-events-none absolute inset-x-0 z-10",
                position === "before" && "top-0 h-[30%]",
                position === "inside" && "top-[30%] bottom-[30%]",
                position === "after" && "bottom-0 h-[30%]",
            )}
        />
    );
}

function DropIndicator({
    position,
    depth,
}: {
    position: ConnectionTreeDropPosition | null;
    depth: number;
}) {
    if (!position) return null;

    if (position === "inside") {
        return (
            <span
                className={cn(
                    "pointer-events-none absolute inset-y-0 right-0 z-20 rounded-md",
                    "border border-primary/60 bg-primary/10",
                )}
                style={{ left: 4 + depth * 14 }}
            />
        );
    }

    return (
        <span
            className="pointer-events-none absolute right-1 z-20 h-0.5 rounded-full bg-primary shadow-sm"
            style={{
                left: 10 + depth * 14,
                [position === "before" ? "top" : "bottom"]: -2,
            }}
        >
            <span className="absolute -left-1.5 -top-1 size-2.5 rounded-full border border-primary bg-background" />
        </span>
    );
}

function RootDropZone({
    enabled,
    activeDrop,
}: {
    enabled: boolean;
    activeDrop: ConnectionTreeDropData | null;
}) {
    const root = useDroppable({
        id: "root:inside",
        disabled: !enabled,
        data: { nodeId: null, position: "inside" } satisfies ConnectionTreeDropData,
    });
    const isActiveRoot = activeDrop?.nodeId === null;

    return (
        <div
            ref={root.setNodeRef}
            className={cn(
                "relative mt-1 h-7 rounded-md border border-transparent transition-colors",
                enabled && "border-dashed border-muted-foreground/25",
                (root.isOver || isActiveRoot) && "border-primary/70 bg-primary/10",
            )}
        >
            {isActiveRoot ? (
                <span className="pointer-events-none absolute left-2 right-2 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-primary">
                    <span className="absolute -left-1.5 -top-1 size-2.5 rounded-full border border-primary bg-background" />
                </span>
            ) : null}
        </div>
    );
}

function ConnectionTreeDragPreview({
    node,
    depth,
    connectionRuntimeMap,
    connectionStatusIndicatorMode,
}: {
    node: LocalExplorerNode;
    depth: number;
    connectionRuntimeMap: ConnectionNodeRuntimeMap;
    connectionStatusIndicatorMode: ConnectionStatusIndicatorMode;
}) {
    const runtimeState =
        node.type === "connection"
            ? connectionRuntimeMap[node.id]?.state ?? "idle"
            : undefined;
    const visualStatus =
        node.type === "connection"
            ? runtimeState === "connected" ||
              runtimeState === "degraded" ||
              runtimeState === "reconnecting"
                ? "connected"
                : runtimeState === "error" || runtimeState === "disconnecting"
                  ? "disconnected"
                  : node.status
            : undefined;

    return (
        <div
            className={cn(
                "flex min-w-48 max-w-72 items-center gap-1.5 rounded-md border bg-background py-1.5 pr-3 text-left text-sm",
                "text-foreground opacity-30 shadow-lg backdrop-blur-[1px]",
            )}
            style={{ paddingLeft: 8 + depth * 14 }}
        >
            <span className="flex size-4 shrink-0 items-center justify-center" />
            <span className="flex shrink-0 items-center">
                <ExplorerNodeIcon
                    node={node}
                    open={node.type === "group"}
                    connectionStatus={visualStatus}
                    connectionRuntimeState={runtimeState}
                    connectionStatusIndicatorMode={connectionStatusIndicatorMode}
                />
            </span>
            <span
                className={cn(
                    "min-w-0 truncate",
                    getConnectionNodeLabelClassName(node, visualStatus),
                    "font-medium text-foreground",
                )}
            >
                {node.label}
            </span>
        </div>
    );
}
