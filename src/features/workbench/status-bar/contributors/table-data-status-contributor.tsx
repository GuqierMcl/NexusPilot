import { DatabaseZap, FileWarning, Rows3, SquarePen, Table2 } from "lucide-react";

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

export const tableDataStatusContributor: WorkbenchStatusContributor = {
    id: "table-data-status",
    getItems: (context): WorkbenchStatusItemModel[] => {
        const tab = context.activeTab;
        if (!tab || tab.type !== "table_data") {
            return [];
        }

        const runtimeState = context.tabRuntimeState.tableDataByTabId[tab.id];
        if (!runtimeState) {
            return [];
        }

        const items: WorkbenchStatusItemModel[] = [];
        const changeCount = countTableChanges(runtimeState.changeSet);

        if (runtimeState.transactionWarning === "rollbackRecommended") {
            items.push({
                id: "table-data-rollback-warning",
                area: "left",
                priority: 10,
                icon: FileWarning,
                label: "建议回滚",
                title: "事务操作失败，建议回滚",
                tone: "warning",
                width: "compact",
            });
        }

        if (changeCount > 0) {
            items.push({
                id: "table-data-changes",
                area: "left",
                priority: 20,
                icon: SquarePen,
                label: `${changeCount} 个更改`,
                title: "表数据存在待保存更改",
                tone: "warning",
                width: "compact",
            });
        }

        if (runtimeState.transactionState.inTransaction) {
            items.push({
                id: "table-data-transaction",
                area: "left",
                priority: 30,
                icon: DatabaseZap,
                label: "事务中",
                title: runtimeState.transactionState.database
                    ? `${runtimeState.transactionState.database} 上的事务正在进行`
                    : "事务正在进行",
                tone: "info",
                width: "compact",
            });
        }

        if (runtimeState.selectedRowIndexes.length > 0) {
            const count = runtimeState.selectedRowIndexes.length;
            items.push({
                id: "table-data-selection",
                area: "right",
                priority: 40,
                icon: Rows3,
                label: `${count} 行选中`,
                title: "当前表数据标签页的选中行数",
                tone: "muted",
                width: "compact",
            });
        }

        if (runtimeState.pageStats) {
            items.push({
                id: "table-data-page",
                area: "right",
                priority: 20,
                icon: Table2,
                label: `第 ${runtimeState.page} / ${runtimeState.pageStats.totalPages} 页`,
                title: `${runtimeState.pageStats.totalRows} 行总计`,
                tone: "muted",
                width: "compact",
            });
        }

        return items;
    },
};
