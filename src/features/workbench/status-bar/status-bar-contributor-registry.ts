import { activeContextStatusContributor } from "./contributors/active-context-status-contributor";
import { aiRuntimeWarningStatusContributor } from "./contributors/ai-runtime-warning-status-contributor";
import { connectionSummaryStatusContributor } from "./contributors/connection-summary-status-contributor";
import { connectionStatusContributor } from "./contributors/connection-status-contributor";
import { cloudStatusContributor } from "./contributors/cloud-status-contributor";
import { cloudSyncStatusContributor } from "./contributors/cloud-sync-status-contributor";
import { keyValueStatusContributor } from "./contributors/key-value-status-contributor";
import { readinessStatusContributor } from "./contributors/readiness-status-contributor";
import { schemaDesignStatusContributor } from "./contributors/schema-design-status-contributor";
import { sqlEditorStatusContributor } from "./contributors/sql-editor-status-contributor";
import { tableDataStatusContributor } from "./contributors/table-data-status-contributor";
import { tableDesignStatusContributor } from "./contributors/table-design-status-contributor";
import type {
    WorkbenchStatusContext,
    WorkbenchStatusContributor,
    WorkbenchStatusItemAreas,
    WorkbenchStatusItemModel,
} from "./types";

export const STATUS_BAR_CONTRIBUTORS: WorkbenchStatusContributor[] = [
    readinessStatusContributor,
    connectionStatusContributor,
    activeContextStatusContributor,
    schemaDesignStatusContributor,
    sqlEditorStatusContributor,
    tableDataStatusContributor,
    keyValueStatusContributor,
    tableDesignStatusContributor,
    connectionSummaryStatusContributor,
    cloudSyncStatusContributor,
    cloudStatusContributor,
    aiRuntimeWarningStatusContributor,
];

export function createEmptyWorkbenchStatusItemAreas(): WorkbenchStatusItemAreas {
    return {
        left: [],
        right: [],
    };
}

function compareStatusItems(
    left: WorkbenchStatusItemModel,
    right: WorkbenchStatusItemModel,
) {
    return left.priority - right.priority || left.id.localeCompare(right.id);
}

export function collectWorkbenchStatusItems(
    context: WorkbenchStatusContext,
    contributors: WorkbenchStatusContributor[] = STATUS_BAR_CONTRIBUTORS,
): WorkbenchStatusItemAreas {
    const grouped = createEmptyWorkbenchStatusItemAreas();

    for (const contributor of contributors) {
        const items = contributor.getItems(context);
        for (const item of items) {
            if (item.visible === false) {
                continue;
            }
            grouped[item.area].push(item);
        }
    }

    grouped.left.sort(compareStatusItems);
    grouped.right.sort(compareStatusItems);

    return grouped;
}
