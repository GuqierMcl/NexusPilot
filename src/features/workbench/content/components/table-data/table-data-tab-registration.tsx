import { Eye, Layers, Table2 } from "lucide-react";

import type { ContentTabRegistration } from "@/features/workbench/content/content-tab-registry";
import {
    getConnectionName,
    getTableDataObjectLabel,
} from "@/features/workbench/content/content-tab-title-utils";
import type { WorkbenchTab } from "@/store";
import type { TableDataPayload } from "@/types/tab-payloads";

import { TableDataView } from "./TableDataView";

type TableDataTab = Extract<WorkbenchTab, { type: "table_data" }>;

function asTableDataTab(tab: WorkbenchTab): TableDataTab {
    return tab as TableDataTab;
}

export const tableDataTabRegistration: ContentTabRegistration = {
    type: "table_data",
    getIcon: (tab) => {
        const tableDataTab = asTableDataTab(tab);
        switch (tableDataTab.payload.container.kind) {
            case "view":
                return Eye;
            case "materialized_view":
                return Layers;
            case "table":
            default:
                return Table2;
        }
    },
    renderPanel: ({ tab, isActive }) => {
        const tableDataTab = asTableDataTab(tab);
        const payload = tableDataTab.payload as TableDataPayload;
        return (
            <TableDataView
                tabId={tableDataTab.id}
                profileId={payload.profileId}
                tabRuntimeId={payload.tabRuntimeId}
                container={payload.container}
                isActive={isActive}
            />
        );
    },
    getDisplayTitle: ({ tab, connections }) => {
        const tableDataTab = asTableDataTab(tab);
        const connectionName = getConnectionName(
            connections,
            tableDataTab.payload.profileId,
        );
        const container = tableDataTab.payload.container;
        const objectName =
            container.table ?? container.objectName ?? tableDataTab.title;

        return `${objectName} · ${connectionName}`;
    },
    getTooltipTitle: ({ tab, connections }) => {
        const tableDataTab = asTableDataTab(tab);
        const connectionName = getConnectionName(
            connections,
            tableDataTab.payload.profileId,
        );
        return `${getTableDataObjectLabel(tableDataTab)} · ${connectionName}`;
    },
};
