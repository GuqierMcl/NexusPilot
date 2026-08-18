import { ChevronRight, Folder, KeyRound } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { KeyValuePendingDeleteTarget } from "@/store";
import type { RedisKeyTreeNode } from "@/types/ipc";

import { getRedisTypeBadgeClass } from "./redis-key-value-utils";

interface RedisKeyTreeRowProps {
    node: RedisKeyTreeNode;
    depth: number;
    activeKey: string | null;
    collapsedFolderIds: Set<string>;
    onRequestActiveKey: (key: string) => void;
    onToggleFolder: (nodeId: string) => void;
    onContextMenuTargetChange: (
        target: KeyValuePendingDeleteTarget | null,
    ) => void;
}

function deleteTargetFromTreeNode(
    node: RedisKeyTreeNode,
): KeyValuePendingDeleteTarget | null {
    if (node.nodeType === "key" && node.key) {
        return {
            kind: "key",
            key: node.key,
            label: node.key,
        };
    }

    if (node.nodeType === "prefix" && node.prefix && node.pattern) {
        return {
            kind: "prefix",
            prefix: node.prefix,
            pattern: node.pattern,
            label: node.prefix,
            keyCount: node.keyCount,
        };
    }

    return null;
}

export function RedisKeyTreeRow({
    node,
    depth,
    activeKey,
    collapsedFolderIds,
    onRequestActiveKey,
    onToggleFolder,
    onContextMenuTargetChange,
}: RedisKeyTreeRowProps) {
    const isFolder = node.nodeType === "prefix";
    const isExpanded = !collapsedFolderIds.has(node.id);
    const isSelected =
        node.nodeType === "key" && node.key != null && node.key === activeKey;

    return (
        <button
            type="button"
            onContextMenuCapture={() => {
                onContextMenuTargetChange(deleteTargetFromTreeNode(node));
            }}
            onClick={() => {
                if (isFolder) {
                    onToggleFolder(node.id);
                    return;
                }
                if (node.key) {
                    onRequestActiveKey(node.key);
                }
            }}
            className={cn(
                "flex min-h-8 w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent",
                isSelected && "bg-accent text-accent-foreground",
            )}
            style={{ paddingLeft: 8 + depth * 14 }}
        >
            <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                {isFolder ? (
                    <ChevronRight
                        className={cn(
                            "size-3.5 transition-transform",
                            isExpanded && "rotate-90",
                        )}
                    />
                ) : null}
            </span>
            <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                {isFolder ? (
                    <Folder className="size-3.5" />
                ) : (
                    <KeyRound className="size-3.5" />
                )}
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">
                {node.label}
            </span>
            {isFolder ? (
                <span className="shrink-0 text-muted-foreground">
                    {node.keyCount}
                </span>
            ) : node.key ? (
                <Badge
                    variant="outline"
                    className={cn(
                        "shrink-0 px-1 py-0 text-[10px] leading-4 uppercase",
                        getRedisTypeBadgeClass(node.valueType ?? undefined),
                    )}
                >
                    {node.valueType ?? "key"}
                </Badge>
            ) : null}
        </button>
    );
}
