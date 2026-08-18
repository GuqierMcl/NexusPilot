import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Database, Plus, RefreshCw, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuGroup,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { KeyValuePendingDeleteTarget } from "@/store";
import type { RedisKeyTreeNode as RedisKeyTreeNodeModel } from "@/types/ipc";

import { RedisKeyTreeRow } from "./RedisKeyTreeRow";
import { flattenRedisKeyTree } from "./redis-key-tree-virtualization";

const REDIS_KEY_TREE_ROW_HEIGHT = 32;
const REDIS_KEY_TREE_ROOT_GAP = 4;
const REDIS_KEY_TREE_OVERSCAN = 12;
const REDIS_KEY_TREE_VERTICAL_PADDING = 8;
const REDIS_KEY_TREE_HORIZONTAL_PADDING = 8;

function getRedisKeyTreeRowSlotHeight(
    rows: readonly { depth: number }[],
    index: number,
): number {
    return (
        REDIS_KEY_TREE_ROW_HEIGHT +
        (rows[index + 1]?.depth === 0 ? REDIS_KEY_TREE_ROOT_GAP : 0)
    );
}

interface RedisKeyTreePanelProps {
    dbIndex: number;
    visiblePatternLabel: string | null;
    keyTree: RedisKeyTreeNodeModel[];
    totalKeyCount: number;
    folderCount: number;
    activeKey: string | null;
    collapsedFolderIds: Set<string>;
    contextMenuTarget: KeyValuePendingDeleteTarget | null;
    isFetching: boolean;
    isCreatePending: boolean;
    isDeletePending: boolean;
    onContextMenuTargetChange: (
        target: KeyValuePendingDeleteTarget | null,
    ) => void;
    onRequestActiveKey: (key: string) => void;
    onToggleFolder: (nodeId: string) => void;
    onOpenCreateDialog: () => void;
    onRefresh: () => void;
    onRequestDeleteTarget: (target: KeyValuePendingDeleteTarget) => void;
}

export function RedisKeyTreePanel({
    dbIndex,
    visiblePatternLabel,
    keyTree,
    totalKeyCount,
    folderCount,
    activeKey,
    collapsedFolderIds,
    contextMenuTarget,
    isFetching,
    isCreatePending,
    isDeletePending,
    onContextMenuTargetChange,
    onRequestActiveKey,
    onToggleFolder,
    onOpenCreateDialog,
    onRefresh,
    onRequestDeleteTarget,
}: RedisKeyTreePanelProps) {
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const visibleRows = useMemo(
        () => flattenRedisKeyTree(keyTree, collapsedFolderIds),
        [collapsedFolderIds, keyTree],
    );
    const rowVirtualizer = useVirtualizer({
        count: visibleRows.length,
        getScrollElement: () => viewportRef.current,
        estimateSize: (index) =>
            getRedisKeyTreeRowSlotHeight(visibleRows, index),
        overscan: REDIS_KEY_TREE_OVERSCAN,
    });
    const virtualRows = rowVirtualizer.getVirtualItems();

    return (
        <aside className="flex h-full min-w-0 flex-col border-r">
            <div className="flex h-10 items-center justify-between gap-2 border-b px-3 text-xs">
                <div className="flex min-w-0 items-center gap-2">
                    <Database className="size-3.5 text-muted-foreground" />
                    <span className="truncate">DB {dbIndex}</span>
                    {visiblePatternLabel ? (
                        <Badge variant="secondary">
                            前缀: {visiblePatternLabel}
                        </Badge>
                    ) : null}
                </div>
            </div>
            <ContextMenu>
                <ContextMenuTrigger
                    render={<div
                        className="min-h-0 flex-1"
                        onContextMenuCapture={() =>
                            onContextMenuTargetChange(null)
                        }
                    >
                        <ScrollArea className="h-full" viewportRef={viewportRef}>
                            {visibleRows.length > 0 ? (
                                <div
                                    className="relative min-h-full"
                                    style={{
                                        height:
                                            rowVirtualizer.getTotalSize() +
                                            REDIS_KEY_TREE_VERTICAL_PADDING * 2,
                                    }}
                                >
                                    {virtualRows.map((virtualRow) => {
                                        const row = visibleRows[virtualRow.index];
                                        if (!row) return null;

                                        return (
                                            <div
                                                key={virtualRow.key}
                                                data-index={virtualRow.index}
                                                ref={rowVirtualizer.measureElement}
                                                className="absolute"
                                                style={{
                                                    height:
                                                        getRedisKeyTreeRowSlotHeight(
                                                            visibleRows,
                                                            virtualRow.index,
                                                        ),
                                                    left: REDIS_KEY_TREE_HORIZONTAL_PADDING,
                                                    right: REDIS_KEY_TREE_HORIZONTAL_PADDING,
                                                    top: 0,
                                                    transform: `translateY(${
                                                        virtualRow.start +
                                                        REDIS_KEY_TREE_VERTICAL_PADDING
                                                    }px)`,
                                                }}
                                            >
                                                <RedisKeyTreeRow
                                                    node={row.node}
                                                    depth={row.depth}
                                                    activeKey={activeKey}
                                                    collapsedFolderIds={
                                                        collapsedFolderIds
                                                    }
                                                    onRequestActiveKey={
                                                        onRequestActiveKey
                                                    }
                                                    onToggleFolder={onToggleFolder}
                                                    onContextMenuTargetChange={
                                                        onContextMenuTargetChange
                                                    }
                                                />
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : (
                                <div className="flex min-h-full flex-col gap-1 p-2">
                                    <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                                        当前扫描范围内没有 key
                                    </p>
                                </div>
                            )}
                        </ScrollArea>
                    </div>}
                />
                <ContextMenuContent>
                    <ContextMenuGroup>
                        <ContextMenuItem
                            disabled={isCreatePending}
                            onClick={onOpenCreateDialog}
                        >
                            <Plus />
                            新建键
                        </ContextMenuItem>
                        <ContextMenuItem disabled={isFetching} onClick={onRefresh}>
                            <RefreshCw />
                            刷新
                        </ContextMenuItem>
                    </ContextMenuGroup>
                    {contextMenuTarget ? (
                        <>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                                variant="destructive"
                                disabled={isDeletePending}
                                onClick={() =>
                                    onRequestDeleteTarget(contextMenuTarget)
                                }
                            >
                                <Trash2 />
                                {contextMenuTarget.kind === "prefix"
                                    ? "删除目录"
                                    : "删除 key"}
                            </ContextMenuItem>
                        </>
                    ) : null}
                </ContextMenuContent>
            </ContextMenu>
            <div className="flex h-10 items-center justify-between border-t px-3 text-xs text-muted-foreground">
                <span>{totalKeyCount} keys</span>
                <span>{folderCount} folders</span>
            </div>
        </aside>
    );
}
