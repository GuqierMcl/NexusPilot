import { KeyRound, Plus, Trash2 } from "lucide-react";

import type {
    WorkbenchStatusContributor,
    WorkbenchStatusItemModel,
} from "../types";

export const keyValueStatusContributor: WorkbenchStatusContributor = {
    id: "key-value-status",
    getItems: (context): WorkbenchStatusItemModel[] => {
        const tab = context.activeTab;
        if (!tab || tab.type !== "key_value") {
            return [];
        }

        const runtimeState = context.tabRuntimeState.keyValueByTabId[tab.id];
        if (!runtimeState) {
            return [];
        }

        if (runtimeState.valueDraft) {
            return [
                {
                    id: "key-value-editing",
                    area: "left",
                    priority: 20,
                    icon: KeyRound,
                    label: "正在编辑值",
                    title: runtimeState.valueDraft.sourceKey,
                    tone: "warning",
                    width: "compact",
                },
            ];
        }

        if (runtimeState.createDraft) {
            return [
                {
                    id: "key-value-creating",
                    area: "left",
                    priority: 20,
                    icon: Plus,
                    label: "正在新建 Key",
                    title: runtimeState.createDraft.keyDraft || "正在新建 Redis Key",
                    tone: "warning",
                    width: "compact",
                },
            ];
        }

        if (runtimeState.pendingDeleteTarget) {
            return [
                {
                    id: "key-value-delete-pending",
                    area: "left",
                    priority: 20,
                    icon: Trash2,
                    label: "等待删除确认",
                    title: runtimeState.pendingDeleteTarget.label,
                    tone: "warning",
                    width: "compact",
                },
            ];
        }

        return [];
    },
};
