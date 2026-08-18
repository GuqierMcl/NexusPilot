import { TableProperties } from "lucide-react";

import type {
    WorkbenchStatusContributor,
    WorkbenchStatusItemModel,
} from "../types";

export const tableDesignStatusContributor: WorkbenchStatusContributor = {
    id: "table-design-status",
    getItems: (context): WorkbenchStatusItemModel[] => {
        const tab = context.activeTab;
        if (!tab || tab.type !== "table_design") {
            return [];
        }

        if (!tab.isDirty) {
            return [];
        }

        return [
            {
                id: "table-design-dirty",
                area: "left",
                priority: 20,
                icon: TableProperties,
                label: "表结构有未保存更改",
                title: "表结构草稿存在未保存修改",
                tone: "warning",
                width: "compact",
            },
        ];
    },
};
