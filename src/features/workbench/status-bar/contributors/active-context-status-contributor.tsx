import { Database } from "lucide-react";

import type { ContainerRef } from "@/types/ipc";

import type {
    WorkbenchStatusContributor,
    WorkbenchStatusItemModel,
} from "../types";

function compactJoin(parts: Array<string | null | undefined>) {
    return parts
        .map((part) => part?.trim())
        .filter((part): part is string => Boolean(part))
        .join(" / ");
}

function getContainerObjectName(container?: ContainerRef | null): string | null {
    return container?.table ?? container?.objectName ?? container?.key ?? null;
}

function buildContainerLabel(container?: ContainerRef | null): string {
    return compactJoin([
        container?.database,
        container?.schema,
        getContainerObjectName(container),
    ]);
}

export const activeContextStatusContributor: WorkbenchStatusContributor = {
    id: "active-context",
    getItems: (context): WorkbenchStatusItemModel[] => {
        const tab = context.activeTab;
        if (!tab) {
            return [];
        }

        let label = "";
        if (tab.type === "sql_editor") {
            const runtimeState = context.tabRuntimeState.sqlEditorByTabId[tab.id];
            const sqlContext = runtimeState?.context ?? tab.payload.initialContext;
            label = compactJoin([sqlContext.database, sqlContext.schema]);
        }

        if (tab.type === "table_data") {
            label = buildContainerLabel(tab.payload.container);
        }

        if (tab.type === "key_value") {
            const runtimeState = context.tabRuntimeState.keyValueByTabId[tab.id];
            const key = runtimeState?.activeKey ?? tab.payload.selectedKey;
            label = key
                ? `Redis DB ${tab.payload.dbIndex} · ${key}`
                : `Redis DB ${tab.payload.dbIndex} · ${tab.payload.pattern ?? "*"}`;
        }

        if (tab.type === "table_design") {
            const container =
                tab.payload.mode === "edit"
                    ? tab.payload.container
                    : tab.payload.parentContainer;
            const prefix = tab.payload.mode === "edit" ? "编辑表" : "新建表";
            const containerLabel = buildContainerLabel(container);
            label = containerLabel ? `${prefix} · ${containerLabel}` : prefix;
        }

        if (tab.type === "clickhouse_table_design") {
            label = buildContainerLabel(tab.payload.container);
        }

        if (tab.type === "clickhouse_view_design") {
            const state = context.tabRuntimeState.clickHouseViewDesignByTabId[tab.id];
            const container =
                tab.payload.mode === "edit"
                    ? tab.payload.container
                    : state
                      ? {
                            kind: state.draft.address.objectKind,
                            database: state.draft.address.database ?? undefined,
                            table: state.draft.address.name,
                        }
                      : tab.payload.mode === "create"
                        ? tab.payload.parentContainer
                        : null;
            const prefix =
                tab.payload.mode === "temporary" ? "Session View" : "View";
            const contextLabel = buildContainerLabel(container);
            label = contextLabel ? `${prefix} · ${contextLabel}` : prefix;
        }

        if (!label) {
            return [];
        }

        return [
            {
                id: "active-context",
                area: "left",
                priority: 20,
                icon: Database,
                label,
                title: label,
                tone: "muted",
                width: "elastic",
            },
        ];
    },
};
