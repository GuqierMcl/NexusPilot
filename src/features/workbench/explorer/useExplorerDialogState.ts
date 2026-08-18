import { useState } from "react";

import type { ExplorerTreeNode } from "@/features/workbench/explorer/types";
import type { ConnectionDriver, StoredDatabaseConnection } from "@/types";
import type { ActiveConnectionWarning } from "./explorer-panel-utils";

export function useExplorerDialogState() {
    const [isCreateFolderDialogOpen, setIsCreateFolderDialogOpen] =
        useState(false);
    const [isCreateDatabaseDialogOpen, setIsCreateDatabaseDialogOpen] =
        useState(false);
    const [createDatabaseConnection, setCreateDatabaseConnection] =
        useState<StoredDatabaseConnection | null>(null);
    const [isEditDatabaseDialogOpen, setIsEditDatabaseDialogOpen] =
        useState(false);
    const [editDatabaseConnection, setEditDatabaseConnection] =
        useState<StoredDatabaseConnection | null>(null);
    const [editingDatabaseNode, setEditingDatabaseNode] =
        useState<ExplorerTreeNode | null>(null);
    const [isDeleteDatabaseDialogOpen, setIsDeleteDatabaseDialogOpen] =
        useState(false);
    const [deleteDatabaseConnection, setDeleteDatabaseConnection] =
        useState<StoredDatabaseConnection | null>(null);
    const [deletingDatabaseNode, setDeletingDatabaseNode] =
        useState<ExplorerTreeNode | null>(null);
    const [isDeleteTableDialogOpen, setIsDeleteTableDialogOpen] =
        useState(false);
    const [deleteTableConnection, setDeleteTableConnection] =
        useState<StoredDatabaseConnection | null>(null);
    const [deletingTableNode, setDeletingTableNode] =
        useState<ExplorerTreeNode | null>(null);
    const [isSelectDbDialogOpen, setIsSelectDbDialogOpen] = useState(false);
    const [targetFolderId, setTargetFolderId] = useState<string | null>(null);

    const [isConnectionEditOpen, setIsConnectionEditOpen] = useState(false);
    const [connectionEditMode, setConnectionEditMode] = useState<
        "create" | "edit"
    >("create");
    const [connectionEditDriver, setConnectionEditDriver] =
        useState<ConnectionDriver>("mysql");
    const [connectionEditFolderId, setConnectionEditFolderId] = useState<
        string | null
    >(null);
    const [editingConnection, setEditingConnection] =
        useState<StoredDatabaseConnection | null>(null);
    const [prefillConnection, setPrefillConnection] =
        useState<StoredDatabaseConnection | null>(null);

    const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);
    const [renamingNode, setRenamingNode] = useState<ExplorerTreeNode | null>(
        null,
    );

    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
    const [nodeToDelete, setNodeToDelete] = useState<ExplorerTreeNode | null>(
        null,
    );
    const [activeConnectionWarning, setActiveConnectionWarning] =
        useState<ActiveConnectionWarning | null>(null);

    function openSelectDatabaseType(folderId: string | null = null) {
        setTargetFolderId(folderId);
        setIsSelectDbDialogOpen(true);
    }

    function openConnectionCreate(driver: ConnectionDriver, folderId: string | null) {
        setConnectionEditMode("create");
        setConnectionEditDriver(driver);
        setConnectionEditFolderId(folderId);
        setEditingConnection(null);
        setPrefillConnection(null);
        setIsConnectionEditOpen(true);
    }

    function openConnectionEdit(connection: StoredDatabaseConnection) {
        setConnectionEditMode("edit");
        setConnectionEditDriver(connection.driver);
        setEditingConnection(connection);
        setPrefillConnection(null);
        setConnectionEditFolderId(connection.folderId ?? null);
        setIsConnectionEditOpen(true);
    }

    function openConnectionClone(connection: StoredDatabaseConnection) {
        setConnectionEditMode("create");
        setConnectionEditDriver(connection.driver);
        setConnectionEditFolderId(connection.folderId ?? null);
        setEditingConnection(null);
        setPrefillConnection(connection);
        setIsConnectionEditOpen(true);
    }

    function handleConnectionEditOpenChange(open: boolean) {
        setIsConnectionEditOpen(open);
        if (!open) {
            setEditingConnection(null);
            setPrefillConnection(null);
        }
    }

    function openCreateFolderDialog(parentFolderId: string | null = null) {
        setTargetFolderId(parentFolderId);
        setIsCreateFolderDialogOpen(true);
    }

    function openRenameNode(node: ExplorerTreeNode) {
        setRenamingNode(node);
        setIsRenameDialogOpen(true);
    }

    function handleRenameDialogOpenChange(open: boolean) {
        setIsRenameDialogOpen(open);
        if (!open) {
            setRenamingNode(null);
        }
    }

    function openDeleteNode(node: ExplorerTreeNode) {
        setNodeToDelete(node);
        setIsDeleteDialogOpen(true);
    }

    function handleDeleteDialogOpenChange(open: boolean) {
        setIsDeleteDialogOpen(open);
        if (!open) {
            setNodeToDelete(null);
        }
    }

    function openCreateDatabaseDialog(connection: StoredDatabaseConnection) {
        setCreateDatabaseConnection(connection);
        setIsCreateDatabaseDialogOpen(true);
    }

    function openEditDatabaseDialog(
        connection: StoredDatabaseConnection,
        node: ExplorerTreeNode,
    ) {
        setEditDatabaseConnection(connection);
        setEditingDatabaseNode(node);
        setIsEditDatabaseDialogOpen(true);
    }

    function openDeleteDatabaseDialog(
        connection: StoredDatabaseConnection,
        node: ExplorerTreeNode,
    ) {
        setDeleteDatabaseConnection(connection);
        setDeletingDatabaseNode(node);
        setIsDeleteDatabaseDialogOpen(true);
    }

    function openDeleteTableDialog(
        connection: StoredDatabaseConnection,
        node: ExplorerTreeNode,
    ) {
        setDeleteTableConnection(connection);
        setDeletingTableNode(node);
        setIsDeleteTableDialogOpen(true);
    }

    function handleCreateDatabaseDialogOpenChange(open: boolean) {
        setIsCreateDatabaseDialogOpen(open);
        if (!open) {
            setCreateDatabaseConnection(null);
        }
    }

    function handleEditDatabaseDialogOpenChange(open: boolean) {
        setIsEditDatabaseDialogOpen(open);
        if (!open) {
            setEditDatabaseConnection(null);
            setEditingDatabaseNode(null);
        }
    }

    function handleDeleteDatabaseDialogOpenChange(open: boolean) {
        setIsDeleteDatabaseDialogOpen(open);
        if (!open) {
            setDeleteDatabaseConnection(null);
            setDeletingDatabaseNode(null);
        }
    }

    function handleDeleteTableDialogOpenChange(open: boolean) {
        setIsDeleteTableDialogOpen(open);
        if (!open) {
            setDeleteTableConnection(null);
            setDeletingTableNode(null);
        }
    }

    function showActiveConnectionWarning(actionLabel: "编辑" | "删除", names: string[]) {
        const connectionLabel =
            names.length === 1
                ? `“${names[0]}”`
                : `以下连接：${names.map((name) => `“${name}”`).join("、")}`;

        setActiveConnectionWarning({
            title: `无法${actionLabel}已打开的连接`,
            description: `${connectionLabel} 当前处于打开状态。请先关闭连接，再${actionLabel}。`,
        });
    }

    function handleActiveConnectionWarningOpenChange(open: boolean) {
        if (!open) {
            setActiveConnectionWarning(null);
        }
    }

    return {
        isCreateFolderDialogOpen,
        setIsCreateFolderDialogOpen,
        isCreateDatabaseDialogOpen,
        createDatabaseConnection,
        isEditDatabaseDialogOpen,
        editDatabaseConnection,
        editingDatabaseNode,
        isDeleteDatabaseDialogOpen,
        deleteDatabaseConnection,
        deletingDatabaseNode,
        isDeleteTableDialogOpen,
        deleteTableConnection,
        deletingTableNode,
        isSelectDbDialogOpen,
        setIsSelectDbDialogOpen,
        targetFolderId,
        isConnectionEditOpen,
        connectionEditMode,
        connectionEditDriver,
        connectionEditFolderId,
        editingConnection,
        prefillConnection,
        isRenameDialogOpen,
        renamingNode,
        isDeleteDialogOpen,
        nodeToDelete,
        activeConnectionWarning,
        setActiveConnectionWarning,
        openSelectDatabaseType,
        openConnectionCreate,
        openConnectionEdit,
        openConnectionClone,
        handleConnectionEditOpenChange,
        openCreateFolderDialog,
        openRenameNode,
        handleRenameDialogOpenChange,
        openDeleteNode,
        handleDeleteDialogOpenChange,
        openCreateDatabaseDialog,
        openEditDatabaseDialog,
        openDeleteDatabaseDialog,
        openDeleteTableDialog,
        handleCreateDatabaseDialogOpenChange,
        handleEditDatabaseDialogOpenChange,
        handleDeleteDatabaseDialogOpenChange,
        handleDeleteTableDialogOpenChange,
        showActiveConnectionWarning,
        handleActiveConnectionWarningOpenChange,
    };
}

export type ExplorerDialogState = ReturnType<typeof useExplorerDialogState>;
