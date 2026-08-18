import { useMemo } from "react";
import { toast } from "@/components/ui/toast";

import type { ExplorerNodeActionHandlers } from "@/features/workbench/explorer/actions";
import { clearProfileQueryCache } from "@/features/workbench/explorer/profile-query-cache";
import { useExplorerMetadataStore } from "@/features/workbench/explorer/useExplorerMetadataStore";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";
import { reorderConnectionTree } from "@/lib/tauri/connections";
import { deleteSavedQuery } from "@/lib/tauri/saved-queries";
import { useWorkbenchTabsStore } from "@/store";
import { useConnectionSessionStore } from "@/store/slices/connection-session-slice";
import { canStartRuntime } from "@/store/slices/connection-runtime-state";
import type {
    ConnectionDriver,
    ReorderConnectionTreeInput,
    StoredDatabaseConnection,
} from "@/types";
import type { ContainerRef } from "@/types/ipc";

import type { ExplorerTreeNode } from "./types";
import { findNodeById } from "./explorer-panel-utils";
import type { ExplorerDialogState } from "./useExplorerDialogState";

interface UseExplorerActionsParams {
    connections: StoredDatabaseConnection[];
    explorerTreeNodes: ExplorerTreeNode[];
    loadExplorerData: () => Promise<void>;
    dialogs: ExplorerDialogState;
}

function isConnectionLocked(profileId: string): boolean {
    const status = useConnectionSessionStore.getState().sessions[profileId]?.status;
    return status != null && !canStartRuntime(status);
}

function collectLockedConnectionNames(node: ExplorerTreeNode): string[] {
    if (node.type === "connection") {
        return isConnectionLocked(node.id) ? [node.label] : [];
    }

    return (node.children ?? []).flatMap(collectLockedConnectionNames);
}

export function useExplorerActions({
    connections,
    explorerTreeNodes,
    loadExplorerData,
    dialogs,
}: UseExplorerActionsParams) {
    const metadataStore = useExplorerMetadataStore();

    function handleOpenCreateConnection(folderId: string | null = null) {
        dialogs.openSelectDatabaseType(folderId);
    }

    function handleCreateConnectionNext(
        driver: ConnectionDriver,
        folderId: string | null,
    ) {
        dialogs.openConnectionCreate(driver, folderId);
    }

    function handleEditConnection(connection: StoredDatabaseConnection) {
        if (isConnectionLocked(connection.id)) {
            dialogs.showActiveConnectionWarning("编辑", [connection.name]);
            return;
        }

        dialogs.openConnectionEdit(connection);
    }

    function handleCloneConnection(connection: StoredDatabaseConnection) {
        dialogs.openConnectionClone(connection);
    }

    async function copyToClipboard(value: string, label: string) {
        if (!value) {
            toast.error(`该连接类型不支持复制${label}`);
            return;
        }
        try {
            await navigator.clipboard.writeText(value);
            toast.success(`${label} 已复制`);
        } catch (error) {
            console.error(`[explorer] copy ${label} failed`, error);
            toast.error(`复制${label}失败`);
        }
    }

    async function handleDriverMenuAction(params: {
        actionId: string;
        node: ExplorerTreeNode;
    }) {
        if (params.node.type !== "connection") return;

        const conn = params.node.connection;

        switch (params.actionId) {
            // ── 网络直连型 (INetworkConfig) ──
            case "model.network.copyHost":
                await copyToClipboard(
                    "host" in conn ? String(conn.host) : "",
                    "Host",
                );
                return;
            case "model.network.copyPort":
                await copyToClipboard(
                    "port" in conn ? String(conn.port) : "",
                    "端口",
                );
                return;
            case "model.network.copyUsername":
                await copyToClipboard(
                    "username" in conn ? String(conn.username ?? "") : "",
                    "用户名",
                );
                return;

            // ── 本地文件型 (ILocalFileConfig) ──
            case "model.local-file.copyPath":
                await copyToClipboard(
                    "dbFilePath" in conn ? String(conn.dbFilePath) : "",
                    "文件路径",
                );
                return;

            // ── 云端 API 型 (ICloudApiConfig) ──
            case "model.cloud-api.copyEndpoint":
                await copyToClipboard(
                    "endpoint" in conn ? String(conn.endpoint) : "",
                    "Endpoint",
                );
                return;

            default:
                toast.info(`菜单动作 ${params.actionId} 暂未实现`);
        }
    }

    function handleOpenCreateFolderDialog() {
        dialogs.openCreateFolderDialog(null);
    }

    function handleOpenCreateFolderDialogAt(parentFolderId: string | null) {
        dialogs.openCreateFolderDialog(parentFolderId);
    }

    function handleRenameNode(node: ExplorerTreeNode) {
        dialogs.openRenameNode(node);
    }

    function handleDeleteNode(node: ExplorerTreeNode) {
        const lockedConnectionNames = collectLockedConnectionNames(node);
        if (lockedConnectionNames.length > 0) {
            dialogs.showActiveConnectionWarning("删除", lockedConnectionNames);
            return;
        }

        dialogs.openDeleteNode(node);
    }

    function handleRefreshNode(node: ExplorerTreeNode) {
        if (node.type === "group") {
            void loadExplorerData();
            return;
        }

        if (node.type === "connection") {
            metadataStore.clearForProfile(node.id);
            void metadataStore.reloadChildren(node);
            return;
        }

        void metadataStore.reloadChildren(node);
    }

    function handleOpenTableData(node: ExplorerTreeNode) {
        if (
            node.type !== "table" &&
            node.type !== "view" &&
            node.type !== "materialized_view"
        ) {
            return;
        }
        if (!node.metadata.container) return;
        void useWorkbenchTabsStore
            .getState()
            .openTableDataTab(node.metadata.profileId, node.metadata.container)
            .catch((error) => {
                console.error("Failed to open table data tab", error);
            });
    }

    function handleOpenTableDesign(node: ExplorerTreeNode) {
        if (!("metadata" in node)) return;
        const container = node.metadata.container;
        if (!container) return;

        const profileId = node.metadata.profileId;
        const connection = connections.find((item) => item.id === profileId);
        const session =
            useConnectionSessionStore.getState().sessions[profileId];
        const capabilities = session?.capabilities;
        if (
            !connection ||
            session?.status !== "connected" ||
            !capabilities
        ) {
            toast.error("连接运行时尚未就绪");
            return;
        }

        const tabsStore = useWorkbenchTabsStore.getState();

        try {
            if (
                node.type === "table" ||
                node.type === "view" ||
                node.type === "materialized_view"
            ) {
                tabsStore.openSchemaDesignTab(
                    profileId,
                    connection.driver,
                    capabilities,
                    {
                        mode: "edit",
                        objectKind: container.kind,
                        container,
                        title: `设计 · ${node.label}`,
                    },
                );
                return;
            }

            if (
                node.type === "database" ||
                node.type === "schema" ||
                (node.type === "asset_group" &&
                    (container.groupType === "tables" ||
                        container.groupType === "views" ||
                        container.groupType === "materialized_views"))
            ) {
                const objectKind =
                    container.groupType === "views"
                        ? "view"
                        : container.groupType === "materialized_views"
                          ? "materialized_view"
                          : "table";
                tabsStore.openSchemaDesignTab(
                    profileId,
                    connection.driver,
                    capabilities,
                    {
                        mode: "create",
                        objectKind,
                        parentContainer: container,
                    },
                );
            }
        } catch (error) {
            console.error("[explorer] open schema design tab failed", error);
            toast.error("该连接没有可用的结构设计器");
        }
    }

    function handleOpenKeyValues(node: ExplorerTreeNode) {
        if (
            node.type !== "redis_database" &&
            node.type !== "redis_key_prefix" &&
            node.type !== "redis_key"
        ) {
            return;
        }
        const container = node.metadata.container;
        const dbIndex = container?.dbIndex;
        if (dbIndex == null) return;
        const pattern =
            container?.pattern ??
            (container?.key ? container.key : "*");
        useWorkbenchTabsStore
            .getState()
            .openKeyValueTab(node.metadata.profileId, dbIndex, pattern, container?.key ?? undefined);
    }

    function handleOpenSqlEditor(node: ExplorerTreeNode) {
        if (node.type === "connection") {
            void useWorkbenchTabsStore
                .getState()
                .openSqlEditorTab(node.id, { title: "未命名查询" })
                .catch((error) => {
                    console.error("[explorer] open SQL editor failed", error);
                });
            return;
        }

        if (node.type === "database" || node.type === "schema") {
            const container = node.metadata.container;
            void useWorkbenchTabsStore
                .getState()
                .openSqlEditorTab(node.metadata.profileId, {
                    title: "未命名查询",
                    context: {
                        database: container?.database ?? null,
                        schema: container?.schema ?? null,
                    },
                })
                .catch((error) => {
                    console.error("[explorer] open SQL editor failed", error);
                });
            return;
        }

        if (node.type === "saved_query_group") {
            void useWorkbenchTabsStore
                .getState()
                .openSqlEditorTab(node.profileId, {
                    title: "未命名查询",
                    context: node.context ?? null,
                })
                .catch((error) => {
                    console.error("[explorer] open SQL editor failed", error);
                });
        }
    }

    function handleOpenSavedQuery(node: ExplorerTreeNode) {
        if (node.type !== "saved_query") return;
        void useWorkbenchTabsStore
            .getState()
            .openSavedQueryTab(node.query)
            .catch((error) => {
                console.error("[explorer] open saved query failed", error);
            });
    }

    async function handleDeleteSavedQuery(node: ExplorerTreeNode) {
        if (node.type !== "saved_query") return;
        try {
            await deleteSavedQuery(node.query.id);
            toast.success("查询已删除");
            await queryClient.invalidateQueries({
                queryKey: queryKeys.savedQueries(node.profileId),
            });
        } catch (error) {
            console.error("[explorer] delete saved query failed", error);
            toast.error("删除查询失败");
        }
    }

    function handleOpenCreateDatabaseDialog(node: ExplorerTreeNode) {
        if (node.type === "connection") {
            dialogs.openCreateDatabaseDialog(node.connection);
            return;
        }

        if (node.type !== "database") return;

        const connection = connections.find(
            (item) => item.id === node.metadata.profileId,
        );
        if (!connection) {
            toast.error("未找到所属连接");
            return;
        }

        dialogs.openCreateDatabaseDialog(connection);
    }

    function handleOpenEditDatabaseDialog(node: ExplorerTreeNode) {
        if (node.type !== "database") return;

        const connection = connections.find(
            (item) => item.id === node.metadata.profileId,
        );
        if (!connection) {
            toast.error("未找到所属连接");
            return;
        }

        dialogs.openEditDatabaseDialog(connection, node);
    }

    function handleOpenDeleteDatabaseDialog(node: ExplorerTreeNode) {
        if (node.type !== "database") return;

        const connection = connections.find(
            (item) => item.id === node.metadata.profileId,
        );
        if (!connection) {
            toast.error("未找到所属连接");
            return;
        }

        dialogs.openDeleteDatabaseDialog(connection, node);
    }

    function handleOpenDeleteTableDialog(node: ExplorerTreeNode) {
        if (node.type !== "table") return;

        const connection = connections.find(
            (item) => item.id === node.metadata.profileId,
        );
        if (!connection) {
            toast.error("未找到所属连接");
            return;
        }

        dialogs.openDeleteTableDialog(connection, node);
    }

    function refreshProfileMetadata(profileId: string) {
        metadataStore.clearForProfile(profileId);
        void queryClient.invalidateQueries({ queryKey: queryKeys.profile(profileId) });
        const node = findNodeById(explorerTreeNodes, profileId);
        if (node?.type === "connection") {
            void metadataStore.loadChildren(node);
        }
    }

    function handleDatabaseMutationCompleted(profileId: string) {
        refreshProfileMetadata(profileId);
    }

    function handleTableMutationCompleted(
        profileId: string,
        container: ContainerRef,
    ) {
        useWorkbenchTabsStore
            .getState()
            .closeTabsByContainer(profileId, container);
        refreshProfileMetadata(profileId);
    }

    async function handleOpenConnection(nodeId: string): Promise<boolean> {
        const status =
            useConnectionSessionStore.getState().sessions[nodeId]?.status ??
            "idle";
        const node = findNodeById(explorerTreeNodes, nodeId);
        if (!node || node.type !== "connection") {
            return false;
        }

        if (status !== "connected" && !canStartRuntime(status)) {
            return false;
        }

        // Runtime materialization 与 metadata hydration 是两个独立事实。
        // Snapshot 恢复的 connected session 仍可能尚未加载 Explorer children。
        await metadataStore.loadChildren(node);

        // 读取最新状态（避免 stale closure）
        const errorMsg = useExplorerMetadataStore.getState().errorKeys[nodeId];
        if (errorMsg) {
            toast.error(`连接失败：${errorMsg}`);
            return false;
        }

        return useConnectionSessionStore.getState().sessions[nodeId]?.status === "connected";
    }

    function handleNodeExpand(node: ExplorerTreeNode) {
        void metadataStore.loadChildren(node);
    }

    async function handleCloseConnection(nodeId: string) {
        // disconnect() 会同步进入 disconnecting，先阻止 active observer 继续发起远端请求。
        const disconnect = useConnectionSessionStore
            .getState()
            .disconnect(nodeId);
        useWorkbenchTabsStore.getState().closeTabsByProfileId(nodeId);
        await clearProfileQueryCache(queryClient, nodeId);
        metadataStore.clearForProfile(nodeId);
        // 后端关闭失败也由 session store 收口本地生命周期；这里只等待资源清理完成。
        await disconnect;
    }

    async function handleReorderConnectionTree(input: ReorderConnectionTreeInput) {
        await reorderConnectionTree(input);
        await loadExplorerData();
    }

    const actionHandlers = useMemo<ExplorerNodeActionHandlers>(
        () => ({
            openConnection: handleOpenConnection,
            closeConnection: handleCloseConnection,
            expandNode: handleNodeExpand,
            newConnection: handleOpenCreateConnection,
            newFolder: handleOpenCreateFolderDialogAt,
            driverMenuAction: (params) => void handleDriverMenuAction(params),
            cloneConnection: handleCloneConnection,
            editConnection: handleEditConnection,
            renameNode: handleRenameNode,
            deleteNode: handleDeleteNode,
            refreshNode: handleRefreshNode,
            createDatabase: handleOpenCreateDatabaseDialog,
            editDatabase: handleOpenEditDatabaseDialog,
            deleteDatabase: handleOpenDeleteDatabaseDialog,
            deleteTable: handleOpenDeleteTableDialog,
            openSqlEditor: handleOpenSqlEditor,
            openSavedQuery: handleOpenSavedQuery,
            deleteSavedQuery: (node) => void handleDeleteSavedQuery(node),
            openTableData: handleOpenTableData,
            openTableDesign: handleOpenTableDesign,
            openKeyValues: handleOpenKeyValues,
            copyText: copyToClipboard,
        }),
        [
            metadataStore,
            loadExplorerData,
            explorerTreeNodes,
            connections,
            handleOpenCreateDatabaseDialog,
            handleOpenEditDatabaseDialog,
            handleOpenDeleteDatabaseDialog,
            handleOpenDeleteTableDialog,
            handleOpenTableDesign,
            handleOpenTableData,
            handleOpenKeyValues,
            handleOpenSqlEditor,
            handleOpenSavedQuery,
            handleDeleteSavedQuery,
        ],
    );

    return {
        actionHandlers,
        handleOpenCreateConnection,
        handleCreateConnectionNext,
        handleOpenCreateFolderDialog,
        handleDatabaseMutationCompleted,
        handleTableMutationCompleted,
        handleReorderConnectionTree,
    };
}
