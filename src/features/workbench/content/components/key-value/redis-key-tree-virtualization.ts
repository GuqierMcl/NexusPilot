import type { RedisKeyTreeNode } from "@/types/ipc";

export interface FlattenedRedisKeyTreeRow {
    node: RedisKeyTreeNode;
    depth: number;
}

export function flattenRedisKeyTree(
    nodes: RedisKeyTreeNode[],
    collapsedFolderIds: ReadonlySet<string>,
): FlattenedRedisKeyTreeRow[] {
    const rows: FlattenedRedisKeyTreeRow[] = [];

    function visit(node: RedisKeyTreeNode, depth: number) {
        rows.push({ node, depth });

        if (node.nodeType !== "prefix" || collapsedFolderIds.has(node.id)) {
            return;
        }

        for (const child of node.children) {
            visit(child, depth + 1);
        }
    }

    for (const node of nodes) {
        visit(node, 0);
    }

    return rows;
}
