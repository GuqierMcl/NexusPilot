import type { ExplorerTreeNode } from "@/features/workbench/explorer/types";

/** 递归在树中按 id 查找节点（支持任意深度嵌套）。 */
export function findNodeById(
    nodes: ExplorerTreeNode[],
    id: string,
): ExplorerTreeNode | undefined {
    for (const node of nodes) {
        if (node.id === id) return node;
        if (node.children) {
            const found = findNodeById(node.children, id);
            if (found) return found;
        }
    }
    return undefined;
}

export function filterConnectionTreeByQuery(
    nodes: ExplorerTreeNode[],
    query: string,
): ExplorerTreeNode[] {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
        return nodes;
    }

    return nodes.flatMap<ExplorerTreeNode>((node) => {
        if (node.type === "connection") {
            return node.label.toLowerCase().includes(normalizedQuery)
                ? [node]
                : [];
        }

        if (node.type !== "group") {
            return [];
        }

        const filteredChildren = filterConnectionTreeByQuery(
            node.children ?? [],
            normalizedQuery,
        );
        if (filteredChildren.length === 0) {
            return [];
        }

        return [
            {
                ...node,
                children: filteredChildren,
            },
        ];
    });
}

export function collectGroupNodeIds(nodes: ExplorerTreeNode[]): string[] {
    return nodes.flatMap((node) => {
        if (node.type !== "group") {
            return [];
        }
        return [node.id, ...collectGroupNodeIds(node.children ?? [])];
    });
}

export type ActiveConnectionWarning = {
    title: string;
    description: string;
};
