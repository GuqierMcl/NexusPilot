import { TableProperties } from "lucide-react";

import type { ContentTabRegistration } from "@/features/workbench/content/content-tab-registry";
import type { WorkbenchTab } from "@/store";
import type { ClickHouseTableDesignPayload } from "@/types/tab-payloads";

import { ClickHouseTableCreateView } from "./clickhouse-table-create-view";
import { ClickHouseTableDesignView } from "./ClickHouseTableDesignView";

type ClickHouseTableDesignTab = Extract<
    WorkbenchTab,
    { type: "clickhouse_table_design" }
>;

function asClickHouseTableDesignTab(
    tab: WorkbenchTab,
): ClickHouseTableDesignTab {
    return tab as ClickHouseTableDesignTab;
}

export const clickHouseTableDesignTabRegistration: ContentTabRegistration = {
    type: "clickhouse_table_design",
    getIcon: () => TableProperties,
    renderPanel: ({ tab, isActive }) => {
        const designTab = asClickHouseTableDesignTab(tab);
        const payload = designTab.payload as ClickHouseTableDesignPayload;
        if (payload.mode === "create") {
            return (
                <ClickHouseTableCreateView
                    tabId={designTab.id}
                    profileId={payload.profileId}
                    tabRuntimeId={payload.tabRuntimeId}
                    parentContainer={payload.parentContainer}
                    isActive={isActive}
                />
            );
        }
        return (
            <ClickHouseTableDesignView
                tabId={designTab.id}
                profileId={payload.profileId}
                tabRuntimeId={payload.tabRuntimeId}
                container={payload.container}
                isActive={isActive}
            />
        );
    },
    getDisplayTitle: ({ tab }) => tab.title,
    getTooltipTitle: ({ tab }) => tab.title,
};
