import { PanelsTopLeft } from "lucide-react";

import type { ContentTabRegistration } from "@/features/workbench/content/content-tab-registry";
import type { WorkbenchTab } from "@/store";

import { ClickHouseViewDesignView } from "./ClickHouseViewDesignView";

type ClickHouseViewDesignTab = Extract<
    WorkbenchTab,
    { type: "clickhouse_view_design" }
>;

export const clickHouseViewDesignTabRegistration: ContentTabRegistration = {
    type: "clickhouse_view_design",
    getIcon: () => PanelsTopLeft,
    renderPanel: ({ tab, isActive }) => {
        const viewTab = tab as ClickHouseViewDesignTab;
        const payload = viewTab.payload;
        return (
            <ClickHouseViewDesignView
                tabId={viewTab.id}
                profileId={payload.profileId}
                mode={payload.mode}
                container={
                    payload.mode === "edit" ? payload.container : null
                }
                parentContainer={
                    payload.mode === "create" ? payload.parentContainer : null
                }
                ownerTabRuntimeId={payload.ownerTabRuntimeId}
                isActive={isActive}
            />
        );
    },
    getDisplayTitle: ({ tab }) => tab.title,
    getTooltipTitle: ({ tab }) => tab.title,
};
