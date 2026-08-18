import { Play } from "lucide-react";

import type { ContentTabRegistration } from "@/features/workbench/content/content-tab-registry";
import { getConnectionName } from "@/features/workbench/content/content-tab-title-utils";
import type { WorkbenchTab } from "@/store";
import type { SqlEditorPayload } from "@/types/tab-payloads";

import { SqlEditorView } from "./SqlEditorView";

type SqlEditorTab = Extract<WorkbenchTab, { type: "sql_editor" }>;

function asSqlEditorTab(tab: WorkbenchTab): SqlEditorTab {
    return tab as SqlEditorTab;
}

function getSqlEditorTitle(tab: SqlEditorTab, connectionName: string): string {
    return `${tab.title} · ${connectionName}`;
}

export const sqlEditorTabRegistration: ContentTabRegistration = {
    type: "sql_editor",
    getIcon: () => Play,
    renderPanel: ({ tab, isActive }) => {
        const sqlEditorTab = asSqlEditorTab(tab);
        const payload = sqlEditorTab.payload as SqlEditorPayload;
        return (
            <SqlEditorView
                tabId={sqlEditorTab.id}
                profileId={payload.profileId}
                tabRuntimeId={payload.tabRuntimeId}
                savedQueryId={payload.savedQueryId}
                initialContext={payload.initialContext}
                isActive={isActive}
            />
        );
    },
    getDisplayTitle: ({ tab, connections }) => {
        const sqlEditorTab = asSqlEditorTab(tab);
        return getSqlEditorTitle(
            sqlEditorTab,
            getConnectionName(connections, sqlEditorTab.payload.profileId),
        );
    },
    getTooltipTitle: ({ tab, connections }) => {
        const sqlEditorTab = asSqlEditorTab(tab);
        return getSqlEditorTitle(
            sqlEditorTab,
            getConnectionName(connections, sqlEditorTab.payload.profileId),
        );
    },
};
