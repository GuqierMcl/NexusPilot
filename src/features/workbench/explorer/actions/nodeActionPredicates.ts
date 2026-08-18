import type {
    ExplorerTreeNode,
    ExplorerTreeRemoteEntityNode,
} from "@/features/workbench/explorer/types";

export function isTableLikeNode(
    node: ExplorerTreeNode,
): node is ExplorerTreeRemoteEntityNode & {
    type: "table" | "view" | "materialized_view";
} {
    return (
        node.type === "table" ||
        node.type === "view" ||
        node.type === "materialized_view"
    );
}

export function isTableDesignTargetNode(node: ExplorerTreeNode): boolean {
    return isTableLikeNode(node);
}

export function isDropTableTargetNode(
    node: ExplorerTreeNode,
): node is ExplorerTreeRemoteEntityNode & {
    type: "table" | "view" | "materialized_view";
} {
    return isTableLikeNode(node);
}

export function getSchemaCreationObjectKind(
    node: ExplorerTreeNode,
): "table" | "view" | "materialized_view" | null {
    if (node.type === "database" || node.type === "schema") return "table";
    if (node.type !== "asset_group") return null;
    switch (node.metadata.container?.groupType) {
        case "tables":
            return "table";
        case "views":
            return "view";
        case "materialized_views":
            return "materialized_view";
        default:
            return null;
    }
}

export function isSqlContextNode(node: ExplorerTreeNode): boolean {
    return node.type === "database" || node.type === "schema";
}

export function isTableCreationTargetNode(node: ExplorerTreeNode): boolean {
    return getSchemaCreationObjectKind(node) === "table";
}

export function isRedisNode(node: ExplorerTreeNode): boolean {
    return (
        node.type === "redis_database" ||
        node.type === "redis_key_prefix" ||
        node.type === "redis_key"
    );
}

export function hasRemoteMetadata(node: ExplorerTreeNode): boolean {
    return "metadata" in node && node.metadata.container != null;
}

export function getRemoteMenuLabel(node: ExplorerTreeNode): string {
    if (node.type === "view" || node.type === "materialized_view") {
        return "视图操作";
    }
    if (isTableLikeNode(node)) return "表操作";
    if (isRedisNode(node)) return "键值操作";
    if (node.type === "column") return "字段操作";
    return "远程节点";
}

export function getQualifiedName(node: ExplorerTreeNode): string {
    if (!("metadata" in node)) return node.label;
    const container = node.metadata.container;
    if (!container) return node.label;

    const parts = [
        container.database,
        container.schema,
        container.table ?? container.objectName,
        container.column,
    ].filter((part): part is string => Boolean(part));

    return parts.length > 0 ? parts.join(".") : node.label;
}
