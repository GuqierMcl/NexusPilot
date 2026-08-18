import { cn } from "@/lib/utils";
import {
    getDriverConfig,
    getFallbackTreeVisual,
} from "@/features/workbench/explorer/driver-configs";
import {
    getAssetGroupVisual,
    getExplorerNodeVisual,
} from "@/features/workbench/explorer/components/explorer-node-visual-registry";
import type {
    ConnectionNodeRuntimeState,
    ConnectionNodeStatus,
    ConnectionStatusIndicatorMode,
    ExplorerTreeNode,
} from "@/features/workbench/explorer/types";

type ExplorerNodeIconProps = {
    node: ExplorerTreeNode;
    open: boolean;
    connectionStatus?: ConnectionNodeStatus;
    connectionRuntimeState?: ConnectionNodeRuntimeState;
    connectionStatusIndicatorMode?: ConnectionStatusIndicatorMode;
};

function getConnectionIconFrameClassName(
    status: ConnectionNodeStatus | undefined,
    runtimeState: ConnectionNodeRuntimeState | undefined,
    mode: ConnectionStatusIndicatorMode | undefined,
): string | null {
    if (mode === "none") {
        return null;
    }

    if (
        runtimeState === "loading" ||
        runtimeState === "connecting" ||
        runtimeState === "reconnecting"
    ) {
        return "animate-pulse bg-amber-500/10 ring-1 ring-amber-500/35";
    }

    if (runtimeState === "degraded") {
        return "bg-amber-500/10 ring-1 ring-amber-500/35";
    }

    if (runtimeState === "error") {
        return "bg-rose-500/10 ring-1 ring-rose-500/35";
    }

    if (runtimeState === "disconnecting") {
        return "bg-muted-foreground/10 ring-1 ring-muted-foreground/25";
    }

    if (runtimeState === "connected") {
        return "bg-emerald-500/10 ring-1 ring-emerald-500/35";
    }

    if (!status) {
        return null;
    }

    if (status === "connected") {
        return "bg-emerald-500/10 ring-1 ring-emerald-500/35";
    }

    if (mode !== "all") {
        return null;
    }

    if (status === "disconnected") {
        return "bg-rose-500/10 ring-1 ring-rose-500/35";
    }

    return "bg-muted-foreground/10 ring-1 ring-muted-foreground/25";
}

export function ExplorerNodeIcon({
    node,
    open,
    connectionStatus,
    connectionRuntimeState,
    connectionStatusIndicatorMode = "connected-only",
}: ExplorerNodeIconProps) {
    if (node.type === "connection") {
        const visual =
            getDriverConfig(node.connection.driver)?.treeVisual ??
            getFallbackTreeVisual();
        const DriverIcon = visual.icon;
        const frameClassName = getConnectionIconFrameClassName(
            connectionStatus,
            connectionRuntimeState,
            connectionStatusIndicatorMode,
        );

        return (
            <span
                className={cn(
                    "inline-flex size-5 shrink-0 items-center justify-center rounded-full",
                    frameClassName,
                )}
                title={node.connection.driver}
            >
                <DriverIcon
                    className={cn("size-4 shrink-0", visual.iconClassName)}
                />
            </span>
        );
    }

    const visual =
        node.type === "asset_group"
            ? getAssetGroupVisual(node.metadata.container?.groupType, open)
            : getExplorerNodeVisual(node.type, open);
    const Icon = visual.icon;

    return <Icon className={visual.className} />;
}
