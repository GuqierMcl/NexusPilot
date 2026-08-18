import type {
    ExplorerTreeConnectionNode,
    ExplorerTreeGroupNode,
    ExplorerTreeNode,
} from "@/features/workbench/explorer/types";
import { buildUnscopedSavedQueryGroup } from "@/features/workbench/explorer/savedQueryNodes";
import type {
    StoredConnectionFolder,
    StoredDatabaseConnection,
} from "@/types";
import type { SavedQuery } from "@/types/saved-queries";

function compareBySortOrderThenCreatedAt<
    T extends { sortOrder?: number | null; createdAt: number },
>(a: T, b: T): number {
    const nullA = a.sortOrder == null ? 1 : 0;
    const nullB = b.sortOrder == null ? 1 : 0;
    if (nullA !== nullB) {
        return nullA - nullB;
    }
    const sa = a.sortOrder ?? 0;
    const sb = b.sortOrder ?? 0;
    if (sa !== sb) {
        return sa - sb;
    }
    return a.createdAt - b.createdAt;
}

function connectionToNode(
    connection: StoredDatabaseConnection,
    savedQueriesByProfileId: Record<string, SavedQuery[]>,
): ExplorerTreeConnectionNode {
    const savedQueries = savedQueriesByProfileId[connection.id] ?? [];
    const unscopedGroup = buildUnscopedSavedQueryGroup(connection.id, savedQueries);
    return {
        id: connection.id,
        type: "connection",
        label: connection.name,
        status: connection.lastConnectionStatus ?? "unknown",
        connection,
        children: unscopedGroup ? [unscopedGroup] : [],
    };
}

/**
 * 将扁平的文件夹与连接列表组装为资源管理器树（根级：无 parent 的文件夹 + 无 folderId 的连接）。
 */
export function buildExplorerTree(
    folders: StoredConnectionFolder[],
    connections: StoredDatabaseConnection[],
    savedQueriesByProfileId: Record<string, SavedQuery[]> = {},
): ExplorerTreeNode[] {
    const byParent = new Map<string | null, StoredConnectionFolder[]>();
    for (const folder of folders) {
        const parentKey = folder.parentId ?? null;
        const list = byParent.get(parentKey) ?? [];
        list.push(folder);
        byParent.set(parentKey, list);
    }
    for (const list of byParent.values()) {
        list.sort(compareBySortOrderThenCreatedAt);
    }

    const connectionsByFolder = new Map<
        string | null,
        StoredDatabaseConnection[]
    >();
    for (const connection of connections) {
        const folderKey = connection.folderId ?? null;
        const list = connectionsByFolder.get(folderKey) ?? [];
        list.push(connection);
        connectionsByFolder.set(folderKey, list);
    }
    for (const list of connectionsByFolder.values()) {
        list.sort(compareBySortOrderThenCreatedAt);
    }

    function folderToNode(folder: StoredConnectionFolder): ExplorerTreeGroupNode {
        const childFolders = byParent.get(folder.id) ?? [];
        const childConnections = connectionsByFolder.get(folder.id) ?? [];
        const children: ExplorerTreeNode[] = [
            ...childFolders.map(folderToNode),
            ...childConnections.map((connection) =>
                connectionToNode(connection, savedQueriesByProfileId),
            ),
        ];
        return {
            id: folder.id,
            type: "group",
            label: folder.name,
            defaultExpanded: true,
            children: children.length > 0 ? children : undefined,
        };
    }

    const rootFolders = (byParent.get(null) ?? []).slice();
    rootFolders.sort(compareBySortOrderThenCreatedAt);
    const rootConnections = (connectionsByFolder.get(null) ?? []).slice();
    rootConnections.sort(compareBySortOrderThenCreatedAt);

    return [
        ...rootFolders.map(folderToNode),
        ...rootConnections.map((connection) =>
            connectionToNode(connection, savedQueriesByProfileId),
        ),
    ];
}
