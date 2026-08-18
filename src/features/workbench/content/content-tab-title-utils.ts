import type { WorkbenchTab } from "@/store";
import type { StoredDatabaseConnection } from "@/types";

export function getConnectionName(
    connections: StoredDatabaseConnection[],
    profileId: string,
): string {
    return (
        connections.find((connection) => connection.id === profileId)?.name ??
        profileId
    );
}

export function getKeyValuePatternLabel(
    pattern?: string | null,
): string | null {
    const trimmed = pattern?.trim();
    if (!trimmed || trimmed === "*") return null;
    return trimmed;
}

export function getTableDataObjectLabel(
    tab: Extract<WorkbenchTab, { type: "table_data" }>,
): string {
    const container = tab.payload.container;
    const objectName = container.table ?? container.objectName ?? tab.title;
    const qualifiers = [container.database, container.schema]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value));

    return [...qualifiers, objectName].join(".");
}
