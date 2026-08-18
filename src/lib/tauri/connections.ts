import { invoke } from "@tauri-apps/api/core"

import type {
    ConnectionFolderId,
    ConnectionId,
    CreateConnectionFolderInput,
    CreateDatabaseConnectionInput,
    ReorderConnectionTreeInput,
    ReorderConnectionTreeResult,
    StoredConnectionFolder,
    StoredDatabaseConnection,
    UpdateConnectionFolderInput,
    UpdateDatabaseConnectionInput,
} from "@/types"

// ─── Rust ↔ TypeScript 结构转换 ───────────────────────────────────────────────
//
// Rust 端 StoredConnectionRecord 序列化为：
//   { id, name, driver, environment, color, payload: {...}, folderId, ... }
//
// TypeScript 的 IStoredConnectionProfile 是扁平判别联合：
//   { id, name, driver, environment, color, host, port, ..., folderId, ... }
//
// 这两层互转在此处统一处理，其他代码无需关心结构差异。

type RustConnectionRecord = Omit<StoredDatabaseConnection, keyof object> & {
    payload: Record<string, unknown>
}

/** Rust 嵌套结构 → 扁平的 IStoredConnectionProfile */
function flattenRecord(raw: RustConnectionRecord): StoredDatabaseConnection {
    const { payload, ...rest } = raw
    return { ...rest, ...payload } as StoredDatabaseConnection
}

/** 扁平的 ICreateConnectionInput → Rust 期望的嵌套结构 */
function nestPayload(input: CreateDatabaseConnectionInput | UpdateDatabaseConnectionInput) {
    const {
        id, name, driver, environment, color, tagLabel, tagColor,
        folderId, sortOrder,
        // IBaseConnectionProfile 字段
        createdAt: _createdAt, updatedAt: _updatedAt,
        // IStoredConnectionProfile 字段
        lastConnectedAt: _lca, lastConnectionStatus: _lcs, lastConnectionError: _lce,
        ...driverFields
    } = input as unknown as Record<string, unknown>

    return {
        id,
        name,
        driver,
        environment: environment ?? "development",
        color: color ?? null,
        tagLabel: typeof tagLabel === "string" ? tagLabel : "",
        tagColor: tagColor ?? null,
        payload: driverFields,
        folderId: folderId ?? null,
        sortOrder: sortOrder ?? null,
    }
}

// ─── 文件夹命令（无需转换） ────────────────────────────────────────────────────

export async function listConnectionFolders(): Promise<StoredConnectionFolder[]> {
    return await invoke<StoredConnectionFolder[]>("list_connection_folders")
}

export async function getConnectionFolder(
    id: ConnectionFolderId,
): Promise<StoredConnectionFolder | null> {
    return await invoke<StoredConnectionFolder | null>("get_connection_folder", { id })
}

export async function createConnectionFolder(
    input: CreateConnectionFolderInput,
): Promise<StoredConnectionFolder> {
    return await invoke<StoredConnectionFolder>("create_connection_folder", { input })
}

export async function updateConnectionFolder(
    input: UpdateConnectionFolderInput,
): Promise<StoredConnectionFolder> {
    return await invoke<StoredConnectionFolder>("update_connection_folder", { input })
}

export async function deleteConnectionFolder(id: ConnectionFolderId): Promise<boolean> {
    return await invoke<boolean>("delete_connection_folder", { id })
}

// ─── 连接命令（含结构转换） ───────────────────────────────────────────────────

export async function listConnections(): Promise<StoredDatabaseConnection[]> {
    const raws = await invoke<RustConnectionRecord[]>("list_connections")
    return raws.map(flattenRecord)
}

export async function getConnection(
    id: ConnectionId,
): Promise<StoredDatabaseConnection | null> {
    const raw = await invoke<RustConnectionRecord | null>("get_connection", { id })
    return raw ? flattenRecord(raw) : null
}

export async function createConnection(
    input: CreateDatabaseConnectionInput,
): Promise<StoredDatabaseConnection> {
    const raw = await invoke<RustConnectionRecord>("create_connection", {
        input: nestPayload(input),
    })
    return flattenRecord(raw)
}

export async function updateConnection(
    input: UpdateDatabaseConnectionInput,
): Promise<StoredDatabaseConnection> {
    const raw = await invoke<RustConnectionRecord>("update_connection", {
        input: nestPayload(input),
    })
    return flattenRecord(raw)
}

export async function deleteConnection(id: ConnectionId): Promise<boolean> {
    return await invoke<boolean>("delete_connection", { id })
}

export async function reorderConnectionTree(
    input: ReorderConnectionTreeInput,
): Promise<ReorderConnectionTreeResult> {
    return await invoke<ReorderConnectionTreeResult>("reorder_connection_tree", {
        input,
    })
}
