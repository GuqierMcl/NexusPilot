import type {
    ConnectionTreeConnectionPatch,
    ConnectionTreeFolderPatch,
    ReorderConnectionTreeInput,
    StoredConnectionFolder,
    StoredDatabaseConnection,
} from "@/types";

export type LocalExplorerNodeType = "group" | "connection";
export type ConnectionTreeDropPosition = "before" | "inside" | "after";

export type ConnectionTreeDropData = {
    nodeId: string | null;
    position: ConnectionTreeDropPosition;
};

export type ConnectionTreeReorderResult =
    | { input: ReorderConnectionTreeInput }
    | { error: string }
    | null;

type StorageOrderItem = {
    sortOrder?: number | null;
    createdAt: number | string;
};

const SORT_ORDER_STEP = 1000;

function normalizeCreatedAt(value: number | string): number {
    if (typeof value === "number") return value;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function compareBySortOrderThenCreatedAt<T extends StorageOrderItem>(
    a: T,
    b: T,
): number {
    const nullA = a.sortOrder == null ? 1 : 0;
    const nullB = b.sortOrder == null ? 1 : 0;
    if (nullA !== nullB) return nullA - nullB;

    const sa = a.sortOrder ?? 0;
    const sb = b.sortOrder ?? 0;
    if (sa !== sb) return sa - sb;

    return normalizeCreatedAt(a.createdAt) - normalizeCreatedAt(b.createdAt);
}

function insertRelative(
    ids: string[],
    activeId: string,
    overId: string,
    position: "before" | "after",
): string[] {
    const withoutActive = ids.filter((id) => id !== activeId);
    const overIndex = withoutActive.indexOf(overId);
    if (overIndex === -1) return ids;

    const insertIndex = position === "before" ? overIndex : overIndex + 1;
    return [
        ...withoutActive.slice(0, insertIndex),
        activeId,
        ...withoutActive.slice(insertIndex),
    ];
}

function appendToEnd(ids: string[], activeId: string): string[] {
    return [...ids.filter((id) => id !== activeId), activeId];
}

function getFolderChildren(
    folders: StoredConnectionFolder[],
    parentId: string | null,
): StoredConnectionFolder[] {
    return folders
        .filter((folder) => (folder.parentId ?? null) === parentId)
        .sort(compareBySortOrderThenCreatedAt);
}

function getConnectionChildren(
    connections: StoredDatabaseConnection[],
    folderId: string | null,
): StoredDatabaseConnection[] {
    return connections
        .filter((connection) => (connection.folderId ?? null) === folderId)
        .sort(compareBySortOrderThenCreatedAt);
}

function hasFolderDescendant(
    folders: StoredConnectionFolder[],
    folderId: string,
    descendantId: string,
): boolean {
    const childrenByParent = new Map<string, string[]>();
    for (const folder of folders) {
        const parentId = folder.parentId;
        if (!parentId) continue;
        const children = childrenByParent.get(parentId) ?? [];
        children.push(folder.id);
        childrenByParent.set(parentId, children);
    }

    const stack = [...(childrenByParent.get(folderId) ?? [])];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) continue;
        if (current === descendantId) return true;
        stack.push(...(childrenByParent.get(current) ?? []));
    }

    return false;
}

function buildFolderPatches(
    folders: StoredConnectionFolder[],
    orderedIds: string[],
    parentId: string | null,
): ConnectionTreeFolderPatch[] {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));

    return orderedIds.flatMap((id, index) => {
        const folder = byId.get(id);
        if (!folder) return [];

        const sortOrder = (index + 1) * SORT_ORDER_STEP;
        const currentParentId = folder.parentId ?? null;
        const currentSortOrder = folder.sortOrder ?? null;

        if (currentParentId === parentId && currentSortOrder === sortOrder) {
            return [];
        }

        return [{ id, parentId, sortOrder }];
    });
}

function buildConnectionPatches(
    connections: StoredDatabaseConnection[],
    orderedIds: string[],
    folderId: string | null,
): ConnectionTreeConnectionPatch[] {
    const byId = new Map(connections.map((connection) => [connection.id, connection]));

    return orderedIds.flatMap((id, index) => {
        const connection = byId.get(id);
        if (!connection) return [];

        const sortOrder = (index + 1) * SORT_ORDER_STEP;
        const currentFolderId = connection.folderId ?? null;
        const currentSortOrder = connection.sortOrder ?? null;

        if (currentFolderId === folderId && currentSortOrder === sortOrder) {
            return [];
        }

        return [{ id, folderId, sortOrder }];
    });
}

export function calculateConnectionTreeReorder(params: {
    activeId: string;
    activeType: LocalExplorerNodeType;
    over: ConnectionTreeDropData;
    folders: StoredConnectionFolder[];
    connections: StoredDatabaseConnection[];
}): ConnectionTreeReorderResult {
    const { activeId, activeType, over, folders, connections } = params;
    const folderById = new Map(folders.map((folder) => [folder.id, folder]));
    const connectionById = new Map(
        connections.map((connection) => [connection.id, connection]),
    );

    const activeFolder = activeType === "group" ? folderById.get(activeId) : undefined;
    const activeConnection =
        activeType === "connection" ? connectionById.get(activeId) : undefined;

    if (activeType === "group" && !activeFolder) {
        return { error: "找不到要移动的文件夹" };
    }
    if (activeType === "connection" && !activeConnection) {
        return { error: "找不到要移动的连接" };
    }

    if (over.nodeId === null) {
        if (over.position !== "inside") return null;

        if (activeType === "group") {
            const orderedIds = appendToEnd(
                getFolderChildren(folders, null).map((folder) => folder.id),
                activeId,
            );
            const folderPatches = buildFolderPatches(folders, orderedIds, null);
            return folderPatches.length > 0
                ? { input: { folderPatches, connectionPatches: [] } }
                : null;
        }

        const orderedIds = appendToEnd(
            getConnectionChildren(connections, null).map((connection) => connection.id),
            activeId,
        );
        const connectionPatches = buildConnectionPatches(
            connections,
            orderedIds,
            null,
        );
        return connectionPatches.length > 0
            ? { input: { folderPatches: [], connectionPatches } }
            : null;
    }

    const overFolder = folderById.get(over.nodeId);
    const overConnection = connectionById.get(over.nodeId);

    if (
        over.nodeId === activeId &&
        (over.position === "before" || over.position === "after")
    ) {
        return null;
    }

    if (over.position === "inside") {
        if (!overFolder) return null;

        if (activeType === "group") {
            if (activeId === overFolder.id) {
                return { error: "不能把文件夹拖入自身" };
            }
            if (hasFolderDescendant(folders, activeId, overFolder.id)) {
                return { error: "不能把文件夹拖入自己的子文件夹" };
            }

            const orderedIds = appendToEnd(
                getFolderChildren(folders, overFolder.id).map((folder) => folder.id),
                activeId,
            );
            const folderPatches = buildFolderPatches(
                folders,
                orderedIds,
                overFolder.id,
            );
            return folderPatches.length > 0
                ? { input: { folderPatches, connectionPatches: [] } }
                : null;
        }

        const orderedIds = appendToEnd(
            getConnectionChildren(connections, overFolder.id).map(
                (connection) => connection.id,
            ),
            activeId,
        );
        const connectionPatches = buildConnectionPatches(
            connections,
            orderedIds,
            overFolder.id,
        );
        return connectionPatches.length > 0
            ? { input: { folderPatches: [], connectionPatches } }
            : null;
    }

    if (over.position !== "before" && over.position !== "after") {
        return null;
    }

    if (activeType === "group") {
        if (!overFolder) return null;

        const parentId = overFolder.parentId ?? null;
        const orderedIds = insertRelative(
            getFolderChildren(folders, parentId).map((folder) => folder.id),
            activeId,
            overFolder.id,
            over.position,
        );
        const folderPatches = buildFolderPatches(folders, orderedIds, parentId);
        return folderPatches.length > 0
            ? { input: { folderPatches, connectionPatches: [] } }
            : null;
    }

    if (!overConnection) return null;

    const folderId = overConnection.folderId ?? null;
    const orderedIds = insertRelative(
        getConnectionChildren(connections, folderId).map(
            (connection) => connection.id,
        ),
        activeId,
        overConnection.id,
        over.position,
    );
    const connectionPatches = buildConnectionPatches(
        connections,
        orderedIds,
        folderId,
    );
    return connectionPatches.length > 0
        ? { input: { folderPatches: [], connectionPatches } }
        : null;
}
