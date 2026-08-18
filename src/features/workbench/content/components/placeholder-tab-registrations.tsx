import type React from "react";
import { LayoutDashboard, LayoutList, Network } from "lucide-react";

import type { ContentTabRegistration } from "@/features/workbench/content/content-tab-registry";
import type { TabType, WorkbenchTab } from "@/store";

interface PlaceholderConfig {
    type: Extract<TabType, "json_viewer" | "graph_topology" | "dashboard">;
    icon: React.ElementType;
    label: string;
    description: string;
}

function PlaceholderPanel({
    tab,
    icon: Icon,
    label,
    description,
}: {
    tab: WorkbenchTab;
    icon: React.ElementType;
    label: string;
    description: string;
}) {
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center">
            <div className="flex size-14 items-center justify-center rounded-xl bg-muted">
                <Icon className="size-7 text-muted-foreground" />
            </div>
            <div className="space-y-1">
                <p className="text-sm font-medium">{tab.title}</p>
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-2 max-w-xs text-xs leading-relaxed text-muted-foreground/70">
                    {description}
                </p>
            </div>
        </div>
    );
}

function createPlaceholderRegistration(
    config: PlaceholderConfig,
): ContentTabRegistration {
    return {
        type: config.type,
        getIcon: () => config.icon,
        renderPanel: ({ tab }) => (
            <PlaceholderPanel
                tab={tab}
                icon={config.icon}
                label={config.label}
                description={config.description}
            />
        ),
        getDisplayTitle: ({ tab }) => tab.title,
        getTooltipTitle: ({ tab }) => tab.title,
    };
}

export const jsonViewerTabRegistration = createPlaceholderRegistration({
    type: "json_viewer",
    icon: LayoutList,
    label: "JSON 文档视图",
    description: "文档型数据将以可折叠树状结构渲染（JsonTreeEditor）",
});

export const graphTopologyTabRegistration = createPlaceholderRegistration({
    type: "graph_topology",
    icon: Network,
    label: "图拓扑视图",
    description: "图节点与边将以力导向图方式渲染（GraphTopologyCanvas）",
});

export const dashboardTabRegistration = createPlaceholderRegistration({
    type: "dashboard",
    icon: LayoutDashboard,
    label: "仪表盘",
    description: "时序指标与可视化图表将在此展示（Metrics Dashboard）",
});
