import type {
    ConnectionNodeStatus,
    ExplorerTreeNode,
} from "@/features/workbench/explorer/types";

export function getConnectionNodeLabelClassName(
    node: ExplorerTreeNode,
    statusOverride?: ConnectionNodeStatus,
) {
    if (node.type !== "connection") {
        return "";
    }

    const status = statusOverride ?? node.status;

    return status === "connected" ? "font-semibold text-foreground" : "";
}
