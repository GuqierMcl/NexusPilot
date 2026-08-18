import {
    CircleHelp,
    Database,
    FileText,
    FilePenLine,
    FolderPlus,
    GitBranchPlus,
    Plus,
    PowerOff,
    RefreshCw,
    SendHorizontal,
    TerminalSquare,
    Trash2,
} from "lucide-react";

import { buildRemoteNodeActionSet } from "@/features/workbench/explorer/actions/remoteActionContributors";
import {
    buildDriverContextMenu,
    FALLBACK_CONTEXT_MENU_GROUP,
    getDriverConfig,
} from "@/features/workbench/explorer/driver-configs";
import type { ExplorerTreeNode } from "@/features/workbench/explorer/types";
import {
    canStartRuntime,
    canStopRuntime,
} from "@/store/slices/connection-runtime-state";
import { supportsSchemaMutation } from "@/lib/schema-mutation-capabilities";

import type {
    ExplorerNodeAction,
    ExplorerNodeActionContext,
    ExplorerNodeActionGroup,
    ExplorerNodeActionSet,
} from "./types";

function resolveNewConnectionFolderId(node: ExplorerTreeNode): string | null {
    if (node.type === "group") {
        return node.id;
    }

    if (node.type === "connection") {
        return node.connection.folderId ?? null;
    }

    return null;
}

function pushGroup(
    groups: ExplorerNodeActionGroup[],
    id: ExplorerNodeActionGroup["id"],
    actions: ExplorerNodeAction[],
    label?: string,
) {
    const visibleActions = actions.filter((action) => action.visible !== false);
    if (visibleActions.length === 0) return;
    groups.push({ id, label, actions: visibleActions });
}

function buildGroupActions(ctx: ExplorerNodeActionContext): ExplorerNodeActionSet {
    const { node, handlers } = ctx;
    const localActions: ExplorerNodeAction[] = [
        {
            id: "local.newConnection",
            label: "新建连接",
            icon: Plus,
            group: "local",
            disabled: handlers.newConnection == null,
            run: () => handlers.newConnection?.(resolveNewConnectionFolderId(node)),
        },
        {
            id: "local.delete",
            label: "删除",
            icon: Trash2,
            group: "local",
            disabled: handlers.deleteNode == null,
            run: () => handlers.deleteNode?.(node),
        },
        {
            id: "local.refresh",
            label: "刷新",
            icon: RefreshCw,
            group: "local",
            disabled: handlers.refreshNode == null,
            run: () => handlers.refreshNode?.(node),
        },
    ];

    const folderActions: ExplorerNodeAction[] = [
        {
            id: "local.newFolder",
            label: "新建文件夹",
            icon: FolderPlus,
            group: "local",
            disabled: handlers.newFolder == null,
            run: () => handlers.newFolder?.(node.id),
        },
        {
            id: "local.rename",
            label: "重命名",
            icon: FilePenLine,
            group: "local",
            disabled: handlers.renameNode == null,
            run: () => handlers.renameNode?.(node),
        },
    ];

    const groups: ExplorerNodeActionGroup[] = [];
    pushGroup(groups, "local", localActions);
    pushGroup(groups, "local.folder", folderActions);
    return {
        label: "文件夹操作",
        groups,
    };
}

function buildConnectionActions(ctx: ExplorerNodeActionContext): ExplorerNodeActionSet {
    const { node, connectionRuntimeState, handlers, capabilities } = ctx;
    if (node.type !== "connection") {
        return { label: "连接操作", groups: [] };
    }
    const canOpen =
        connectionRuntimeState == null ||
        (connectionRuntimeState !== "loading" &&
            canStartRuntime(connectionRuntimeState));
    const canClose =
        connectionRuntimeState != null &&
        connectionRuntimeState !== "loading" &&
        canStopRuntime(connectionRuntimeState);

    const localActions: ExplorerNodeAction[] = [
        {
            id: "local.newConnection",
            label: "新建连接",
            icon: Plus,
            group: "local",
            disabled: handlers.newConnection == null,
            run: () => handlers.newConnection?.(resolveNewConnectionFolderId(node)),
        },
        {
            id: "local.delete",
            label: "删除",
            icon: Trash2,
            group: "local",
            disabled: handlers.deleteNode == null,
            run: () => handlers.deleteNode?.(node),
        },
        {
            id: "local.refresh",
            label: "刷新",
            icon: RefreshCw,
            group: "local",
            disabled: handlers.refreshNode == null,
            run: () => handlers.refreshNode?.(node),
        },
    ];

    const connectionActions: ExplorerNodeAction[] = [
        {
            id: "connection.open",
            label: "打开连接",
            icon: SendHorizontal,
            group: "connection",
            disabled: handlers.openConnection == null || !canOpen,
            run: () => handlers.openConnection?.(node.id),
        },
    ];

    if (canClose) {
        connectionActions.push({
            id: "connection.close",
            label: "关闭连接",
            icon: PowerOff,
            group: "connection",
            disabled: handlers.closeConnection == null,
            run: () => handlers.closeConnection?.(node.id),
        });
    }

    connectionActions.push(
        {
            id: "connection.openSqlEditor",
            label: "新建查询",
            icon: TerminalSquare,
            group: "connection",
            disabled:
                handlers.openSqlEditor == null ||
                connectionRuntimeState !== "connected" ||
                capabilities?.sqlExecutor !== true,
            run: () => handlers.openSqlEditor?.(node),
        },
        {
            id: "connection.createDatabase",
            label: "新增数据库",
            icon: Database,
            group: "connection",
            visible: supportsSchemaMutation(
                capabilities,
                "database",
                "create",
            ),
            disabled:
                handlers.createDatabase == null ||
                connectionRuntimeState !== "connected" ||
                !supportsSchemaMutation(
                    capabilities,
                    "database",
                    "create",
                ),
            run: () => handlers.createDatabase?.(node),
        },
        {
            id: "connection.edit",
            label: "编辑连接",
            icon: FilePenLine,
            group: "connection",
            disabled: handlers.editConnection == null,
            run: () => handlers.editConnection?.(node.connection),
        },
        {
            id: "connection.clone",
            label: "克隆",
            icon: GitBranchPlus,
            group: "connection",
            disabled: handlers.cloneConnection == null,
            run: () => handlers.cloneConnection?.(node.connection),
        },
    );

    const driverConfig = getDriverConfig(node.connection.driver);
    const driverMenuGroup = driverConfig
        ? buildDriverContextMenu(driverConfig)
        : FALLBACK_CONTEXT_MENU_GROUP;
    const driverActions = driverMenuGroup.items.map((item): ExplorerNodeAction => ({
        id: item.actionId,
        label: item.label,
        icon: item.icon ?? CircleHelp,
        group: "driver",
        disabled: item.disabled || handlers.driverMenuAction == null,
        run: () =>
            handlers.driverMenuAction?.({
                actionId: item.actionId,
                node,
            }),
    }));

    const groups: ExplorerNodeActionGroup[] = [];
    pushGroup(groups, "local", localActions);
    pushGroup(groups, "connection", connectionActions);
    pushGroup(groups, "driver", driverActions, driverMenuGroup.label);

    return {
        label: "连接操作",
        primaryActionId: canOpen ? "connection.open" : undefined,
        groups,
    };
}

function buildRemoteActions(ctx: ExplorerNodeActionContext): ExplorerNodeActionSet {
    const driverConfig = ctx.connectionDriver
        ? getDriverConfig(ctx.connectionDriver)
        : undefined;

    return buildRemoteNodeActionSet(
        ctx,
        driverConfig?.remoteActionContributors ?? [],
    );
}

function buildSavedQueryActions(ctx: ExplorerNodeActionContext): ExplorerNodeActionSet {
    const { node, handlers, connectionRuntimeState, capabilities } = ctx;
    const sqlEditorDisabled =
        handlers.openSqlEditor == null ||
        connectionRuntimeState !== "connected" ||
        capabilities?.sqlExecutor !== true;

    if (node.type === "saved_query_group") {
        return {
            label: "查询",
            groups: [
                {
                    id: "saved-query",
                    actions: [
                        {
                            id: "savedQuery.new",
                            label: "新建查询",
                            icon: TerminalSquare,
                            group: "saved-query",
                            disabled: sqlEditorDisabled,
                            run: () => handlers.openSqlEditor?.(node),
                        },
                    ],
                },
            ],
        };
    }

    return {
        label: "保存的查询",
        primaryActionId: "savedQuery.open",
        groups: [
            {
                id: "saved-query",
                actions: [
                    {
                        id: "savedQuery.open",
                        label: "打开",
                        icon: FileText,
                        group: "saved-query",
                        disabled:
                            handlers.openSavedQuery == null ||
                            connectionRuntimeState !== "connected" ||
                            capabilities?.sqlExecutor !== true,
                        run: () => handlers.openSavedQuery?.(node),
                    },
                    {
                        id: "savedQuery.delete",
                        label: "删除",
                        icon: Trash2,
                        group: "saved-query",
                        disabled: handlers.deleteSavedQuery == null,
                        run: () => handlers.deleteSavedQuery?.(node),
                    },
                ],
            },
        ],
    };
}

export function buildExplorerNodeActionSet(
    ctx: ExplorerNodeActionContext,
): ExplorerNodeActionSet {
    if (ctx.node.type === "group") {
        return buildGroupActions(ctx);
    }

    if (ctx.node.type === "connection") {
        return buildConnectionActions(ctx);
    }

    if (ctx.node.type === "saved_query" || ctx.node.type === "saved_query_group") {
        return buildSavedQueryActions(ctx);
    }

    return buildRemoteActions(ctx);
}
