import { KeyRound } from "lucide-react";

import type { ContentTabRegistration } from "@/features/workbench/content/content-tab-registry";
import {
    getConnectionName,
    getKeyValuePatternLabel,
} from "@/features/workbench/content/content-tab-title-utils";
import type { WorkbenchTab } from "@/store";
import type { KeyValuePayload } from "@/types/tab-payloads";

import { KeyValueView } from "./KeyValueView";

type KeyValueTab = Extract<WorkbenchTab, { type: "key_value" }>;

function asKeyValueTab(tab: WorkbenchTab): KeyValueTab {
    return tab as KeyValueTab;
}

function getKeyValueTitleParts(
    tab: KeyValueTab,
    connectionName: string,
): string[] {
    const patternLabel = getKeyValuePatternLabel(tab.payload.pattern);
    const parts = [`DB ${tab.payload.dbIndex}`];

    if (patternLabel) {
        parts.push(`前缀: ${patternLabel}`);
    }
    parts.push(connectionName);

    return parts;
}

export const keyValueTabRegistration: ContentTabRegistration = {
    type: "key_value",
    getIcon: () => KeyRound,
    renderPanel: ({ tab, isActive }) => {
        const keyValueTab = asKeyValueTab(tab);
        const payload = keyValueTab.payload as KeyValuePayload;
        return (
            <KeyValueView
                tabId={keyValueTab.id}
                profileId={payload.profileId}
                dbIndex={payload.dbIndex}
                pattern={payload.pattern}
                selectedKey={payload.selectedKey}
                isActive={isActive}
            />
        );
    },
    getDisplayTitle: ({ tab, connections }) => {
        const keyValueTab = asKeyValueTab(tab);
        const connectionName = getConnectionName(
            connections,
            keyValueTab.payload.profileId,
        );
        return getKeyValueTitleParts(keyValueTab, connectionName).join(" · ");
    },
    getTooltipTitle: ({ tab, connections }) => {
        const keyValueTab = asKeyValueTab(tab);
        const connectionName = getConnectionName(
            connections,
            keyValueTab.payload.profileId,
        );
        return getKeyValueTitleParts(keyValueTab, connectionName).join(" · ");
    },
};
