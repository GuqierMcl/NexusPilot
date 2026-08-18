import type React from "react";

import { clickHouseTableDesignTabRegistration } from "@/features/workbench/content/components/clickhouse-table-design";
import { clickHouseViewDesignTabRegistration } from "@/features/workbench/content/components/clickhouse-view-design";
import {
    dashboardTabRegistration,
    graphTopologyTabRegistration,
    jsonViewerTabRegistration,
} from "@/features/workbench/content/components/placeholder-tab-registrations";
import { keyValueTabRegistration } from "@/features/workbench/content/components/key-value/key-value-tab-registration";
import { sqlEditorTabRegistration } from "@/features/workbench/content/components/sql-editor/sql-editor-tab-registration";
import { tableDataTabRegistration } from "@/features/workbench/content/components/table-data/table-data-tab-registration";
import { tableDesignTabRegistration } from "@/features/workbench/content/components/table-design/table-design-tab-registration";
import type { TabType, WorkbenchTab } from "@/store";
import type { StoredDatabaseConnection } from "@/types";

export interface ContentTabRenderParams {
    tab: WorkbenchTab;
    isActive: boolean;
}

export interface ContentTabTitleParams {
    tab: WorkbenchTab;
    connections: StoredDatabaseConnection[];
}

export interface ContentTabRegistration {
    type: TabType;
    getIcon: (tab: WorkbenchTab) => React.ElementType;
    renderPanel: (params: ContentTabRenderParams) => React.ReactNode;
    getDisplayTitle: (params: ContentTabTitleParams) => string;
    getTooltipTitle: (params: ContentTabTitleParams) => string;
}

const registrations = [
    sqlEditorTabRegistration,
    tableDataTabRegistration,
    keyValueTabRegistration,
    tableDesignTabRegistration,
    clickHouseTableDesignTabRegistration,
    clickHouseViewDesignTabRegistration,
    jsonViewerTabRegistration,
    graphTopologyTabRegistration,
    dashboardTabRegistration,
] satisfies ContentTabRegistration[];

export const CONTENT_TAB_REGISTRY = Object.fromEntries(
    registrations.map((registration) => [registration.type, registration]),
) as Record<TabType, ContentTabRegistration>;

export function getContentTabRegistration(
    tab: WorkbenchTab,
): ContentTabRegistration {
    return CONTENT_TAB_REGISTRY[tab.type];
}

export function getContentTabIcon(tab: WorkbenchTab): React.ElementType {
    return getContentTabRegistration(tab).getIcon(tab);
}

export function renderContentTabPanel(
    tab: WorkbenchTab,
    isActive: boolean,
): React.ReactNode {
    return getContentTabRegistration(tab).renderPanel({ tab, isActive });
}

export function getContentTabDisplayTitle(
    tab: WorkbenchTab,
    connections: StoredDatabaseConnection[],
): string {
    return getContentTabRegistration(tab).getDisplayTitle({ tab, connections });
}

export function getContentTabTooltipTitle(
    tab: WorkbenchTab,
    connections: StoredDatabaseConnection[],
): string {
    return getContentTabRegistration(tab).getTooltipTitle({ tab, connections });
}
