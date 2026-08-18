import type React from "react";

import type { AgentComposerSendBlocker } from "@/features/workbench/agent/state";
import type {
    AiRuntimeHealthStatus,
    ClickHouseTableDesignRuntimeState,
    ISessionState,
    KeyValueRuntimeState,
    SchemaDesignRuntimeState,
    SqlEditorRuntimeState,
    TableDataRuntimeState,
    TableDesignRuntimeState,
    WorkbenchTab,
} from "@/store";
import type { ClickHouseViewDesignRuntimeState } from "@/types/clickhouse-view-design";
import type { CloudDesktopStateProjection } from "@/types/ipc";

export type WorkbenchStatusItemArea = "left" | "right";

export type WorkbenchStatusItemWidth = "compact" | "content" | "elastic";

export type WorkbenchStatusItemTone =
    | "default"
    | "muted"
    | "success"
    | "info"
    | "warning"
    | "error";

export type WorkbenchStatusIcon = React.ElementType<{
    className?: string;
    "data-icon"?: string;
}>;

export interface WorkbenchStatusRuntimeStateSnapshot {
    sqlEditorByTabId: Record<string, SqlEditorRuntimeState>;
    tableDataByTabId: Record<string, TableDataRuntimeState>;
    tableDesignByTabId: Record<string, TableDesignRuntimeState>;
    clickHouseTableDesignByTabId: Record<
        string,
        ClickHouseTableDesignRuntimeState
    >;
    clickHouseViewDesignByTabId: Record<
        string,
        ClickHouseViewDesignRuntimeState
    >;
    schemaDesignByTabId: Record<string, SchemaDesignRuntimeState>;
    keyValueByTabId: Record<string, KeyValueRuntimeState>;
}

export interface WorkbenchStatusActions {
    focusTab(tabId: string): void;
    openSqlExecutionDetails(tabId: string): void;
    openExecutionOverview(tabIds: string[]): void;
}

export interface WorkbenchStatusContext {
    activeTab: WorkbenchTab | null;
    tabs: WorkbenchTab[];
    connectionSessions: Record<string, ISessionState>;
    tabRuntimeState: WorkbenchStatusRuntimeStateSnapshot;
    layout: {
        leftSidebarCollapsed: boolean;
        rightSidebarCollapsed: boolean;
    };
    aiRuntime: {
        healthStatus: AiRuntimeHealthStatus;
        isChecking: boolean;
        errorMessage?: string | null;
    };
    agent: {
        composerSendBlocker: AgentComposerSendBlocker | null;
    };
    cloud: CloudDesktopStateProjection | null;
    nowMs: number;
    actions: WorkbenchStatusActions;
}

export interface WorkbenchStatusItemModel {
    id: string;
    area: WorkbenchStatusItemArea;
    priority: number;
    visible?: boolean;
    icon?: WorkbenchStatusIcon;
    iconClassName?: string;
    label: string;
    title?: string;
    tooltipContent?: React.ReactNode;
    tone?: WorkbenchStatusItemTone;
    width?: WorkbenchStatusItemWidth;
    onClick?: () => void;
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
}

export interface WorkbenchStatusItemAreas {
    left: WorkbenchStatusItemModel[];
    right: WorkbenchStatusItemModel[];
}

export interface WorkbenchStatusContributor {
    id: string;
    getItems: (context: WorkbenchStatusContext) => WorkbenchStatusItemModel[];
}
