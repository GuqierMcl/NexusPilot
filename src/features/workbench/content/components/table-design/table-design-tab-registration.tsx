import { PenLine } from "lucide-react";

import type { ContentTabRegistration } from "@/features/workbench/content/content-tab-registry";
import type { WorkbenchTab } from "@/store";
import type { TableDesignPayload } from "@/types/tab-payloads";

import { TableDesignView } from "./TableDesignView";

type TableDesignTab = Extract<WorkbenchTab, { type: "table_design" }>;

function asTableDesignTab(tab: WorkbenchTab): TableDesignTab {
    return tab as TableDesignTab;
}

export const tableDesignTabRegistration: ContentTabRegistration = {
    type: "table_design",
    getIcon: () => PenLine,
    renderPanel: ({ tab, isActive }) => {
        const tableDesignTab = asTableDesignTab(tab);
        const payload = tableDesignTab.payload as TableDesignPayload;
        return (
            <TableDesignView
                tabId={tableDesignTab.id}
                profileId={payload.profileId}
                tabRuntimeId={payload.tabRuntimeId}
                mode={payload.mode}
                container={payload.container}
                parentContainer={payload.parentContainer}
                isActive={isActive}
            />
        );
    },
    getDisplayTitle: ({ tab }) => tab.title,
    getTooltipTitle: ({ tab }) => tab.title,
};
