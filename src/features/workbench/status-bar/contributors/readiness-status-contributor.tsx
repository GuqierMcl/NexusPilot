import { CheckCircle2 } from "lucide-react";

import type { TableDataChangeSet } from "@/store";

import type {
    WorkbenchStatusContributor,
    WorkbenchStatusItemModel,
} from "../types";

function countTableChanges(changeSet: TableDataChangeSet) {
    return (
        Object.keys(changeSet.inserts).length +
        Object.keys(changeSet.updates).length +
        Object.keys(changeSet.deletes).length
    );
}

export const readinessStatusContributor: WorkbenchStatusContributor = {
    id: "readiness-status",
    getItems: (context): WorkbenchStatusItemModel[] => {
        const tab = context.activeTab;

        if (tab?.type === "sql_editor") {
            const runtimeState = context.tabRuntimeState.sqlEditorByTabId[tab.id];
            if (tab.isExecuting || tab.isDirty || runtimeState?.error) {
                return [];
            }
        }

        if (tab?.type === "table_data") {
            const runtimeState = context.tabRuntimeState.tableDataByTabId[tab.id];
            if (
                runtimeState &&
                (countTableChanges(runtimeState.changeSet) > 0 ||
                    runtimeState.transactionState.inTransaction ||
                    runtimeState.transactionWarning === "rollbackRecommended")
            ) {
                return [];
            }
        }

        if (tab?.type === "key_value") {
            const runtimeState = context.tabRuntimeState.keyValueByTabId[tab.id];
            if (
                runtimeState?.valueDraft ||
                runtimeState?.createDraft ||
                runtimeState?.pendingDeleteTarget
            ) {
                return [];
            }
        }

        if (tab?.type === "table_design" && tab.isDirty) {
            return [];
        }

        if (tab) {
            const schemaDesignState =
                context.tabRuntimeState.schemaDesignByTabId[tab.id];
            if (
                schemaDesignState &&
                (schemaDesignState.loadState !== "ready" ||
                    schemaDesignState.operationState !== "idle" ||
                    (schemaDesignState.mode === "create" &&
                        schemaDesignState.isDirty))
            ) {
                return [];
            }
        }

        return [
            {
                id: "readiness-status",
                area: "left",
                priority: 1,
                icon: CheckCircle2,
                label: "已就绪",
                title: "工作台已就绪",
                tone: "muted",
                width: "compact",
            },
        ];
    },
};
