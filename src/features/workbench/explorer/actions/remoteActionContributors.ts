import {
    Clipboard,
    Copy,
    Database,
    FilePenLine,
    KeyRound,
    PenLine,
    Plus,
    RefreshCw,
    Table2,
    TerminalSquare,
    Trash2,
} from "lucide-react";

import { collectExplorerNodeActionContributions } from "@/features/workbench/explorer/actions/actionContributors";
import { resolveSchemaDesignerSurface } from "@/features/workbench/content/schema-designer-surface-registry";
import {
    getQualifiedName,
    getSchemaCreationObjectKind,
    getRemoteMenuLabel,
    hasRemoteMetadata,
    isDropTableTargetNode,
    isRedisNode,
    isSqlContextNode,
    isTableDesignTargetNode,
    isTableLikeNode,
} from "@/features/workbench/explorer/actions/nodeActionPredicates";
import type {
    ExplorerNodeActionContributor,
    ExplorerNodeActionContext,
    ExplorerNodeActionSet,
} from "@/features/workbench/explorer/actions/types";
import { supportsSchemaMutation } from "@/lib/schema-mutation-capabilities";

function hasTableDesignSurface(
    ctx: ExplorerNodeActionContext,
    mode: "create" | "edit",
    objectKind: "table" | "view" | "materialized_view" = "table",
): boolean {
    if (!ctx.connectionDriver || !ctx.capabilities) return false;

    return (
        resolveSchemaDesignerSurface({
            driverName: ctx.connectionDriver,
            objectKind,
            mode,
            capabilities: ctx.capabilities,
        }) != null
    );
}

const remoteBaseActionContributor: ExplorerNodeActionContributor = (ctx) => {
    const { node, handlers, isLeafNode } = ctx;
    if (!hasRemoteMetadata(node) || !("metadata" in node)) return null;
    const container = node.metadata.container;
    if (!container) return null;

    return {
        groupId: "remote",
        actions: [
            {
                id: "remote.copyName",
                label: "复制名称",
                icon: Copy,
                group: "remote",
                disabled: handlers.copyText == null,
                run: () => handlers.copyText?.(node.label, "名称"),
            },
            {
                id: "remote.copyContainerRef",
                label: "复制容器引用",
                icon: Clipboard,
                group: "remote",
                disabled: handlers.copyText == null,
                run: () =>
                    handlers.copyText?.(
                        JSON.stringify(container, null, 2),
                        "容器引用",
                    ),
            },
            {
                id: "remote.refreshChildren",
                label: "刷新",
                icon: RefreshCw,
                group: "remote",
                visible: !isLeafNode,
                disabled: handlers.refreshNode == null,
                run: () => handlers.refreshNode?.(node),
            },
        ],
    };
};

const sqlContextActionContributor: ExplorerNodeActionContributor = (ctx) => {
    const { node, handlers, capabilities, connectionRuntimeState } = ctx;
    if (!isSqlContextNode(node)) return null;

    return {
        groupId: "browse",
        actions: [
            {
                id: "remote.sql.newQuery",
                label: "新建查询",
                icon: TerminalSquare,
                group: "browse",
                disabled:
                    handlers.openSqlEditor == null ||
                    connectionRuntimeState !== "connected" ||
                    capabilities?.sqlExecutor !== true,
                run: () => handlers.openSqlEditor?.(node),
            },
        ],
    };
};

const tableBrowseActionContributor: ExplorerNodeActionContributor = (ctx) => {
    const { node, handlers, capabilities } = ctx;
    if (!isTableLikeNode(node)) return null;
    const objectKind = node.type;
    const schemaLabel =
        objectKind === "table" ? "设计表结构" : "设计 View";
    const designActionId =
        objectKind === "table"
            ? "remote.table.openDesign"
            : `remote.${objectKind}.openDesign`;

    return {
        groupId: "browse",
        primaryActionId: "remote.table.openData",
        actions: [
            {
                id: "remote.table.openData",
                label: "打开数据",
                icon: Table2,
                group: "browse",
                disabled:
                    handlers.openTableData == null ||
                    capabilities?.dataTableBrowser !== true,
                run: () => handlers.openTableData?.(node),
            },
            {
                id: designActionId,
                label: schemaLabel,
                icon: PenLine,
                group: "browse",
                visible:
                    isTableDesignTargetNode(node) &&
                    hasTableDesignSurface(ctx, "edit", objectKind),
                disabled: handlers.openTableDesign == null,
                run: () => handlers.openTableDesign?.(node),
            },
            {
                id: "remote.table.copyQualifiedName",
                label: "复制限定名",
                icon: Copy,
                group: "browse",
                disabled: handlers.copyText == null,
                run: () => handlers.copyText?.(getQualifiedName(node), "限定名"),
            },
        ],
    };
};

const tableCreationActionContributor: ExplorerNodeActionContributor = (ctx) => {
    const { node, handlers, capabilities } = ctx;
    const objectKind = getSchemaCreationObjectKind(node);
    if (
        objectKind == null ||
        !supportsSchemaMutation(capabilities, objectKind, "create") ||
        !hasTableDesignSurface(ctx, "create", objectKind)
    ) {
        return null;
    }

    return {
        groupId: "browse",
        actions: [
            {
                id:
                    objectKind === "table"
                        ? "remote.table.createTable"
                        : `remote.${objectKind}.create`,
                label:
                    objectKind === "table"
                        ? "新建表"
                        : objectKind === "view"
                          ? "新建 View"
                          : "新建 Materialized View",
                icon: Plus,
                group: "browse",
                disabled: handlers.openTableDesign == null,
                run: () => handlers.openTableDesign?.(node),
            },
        ],
    };
};

const tableManagementActionContributor: ExplorerNodeActionContributor = (ctx) => {
    const { node, handlers, capabilities, connectionRuntimeState } = ctx;
    if (!isDropTableTargetNode(node)) {
        return null;
    }
    const canDrop = supportsSchemaMutation(capabilities, node.type, "drop");
    const canRename =
        node.type !== "table" &&
        supportsSchemaMutation(capabilities, node.type, "rename");
    if (!canDrop && !canRename) return null;

    return {
        groupId: "metadata",
        label: node.type === "table" ? "表管理" : "View 管理",
        actions: [
            {
                id: `remote.${node.type}.rename`,
                label: "重命名",
                icon: PenLine,
                group: "metadata",
                visible:
                    canRename,
                disabled:
                    handlers.renameNode == null ||
                    connectionRuntimeState !== "connected",
                run: () => handlers.renameNode?.(node),
            },
            {
                id:
                    node.type === "table"
                        ? "remote.table.deleteTable"
                        : `remote.${node.type}.drop`,
                label: node.type === "table" ? "删除表" : "删除 View",
                icon: Trash2,
                group: "metadata",
                disabled:
                    handlers.deleteTable == null ||
                    connectionRuntimeState !== "connected",
                run: () => handlers.deleteTable?.(node),
                visible: canDrop,
            },
        ],
    };
};

const redisBrowseActionContributor: ExplorerNodeActionContributor = (ctx) => {
    const { node, handlers, capabilities } = ctx;
    if (!isRedisNode(node) || !("metadata" in node)) return null;
    const container = node.metadata.container;
    if (!container) return null;

    const pattern = container.pattern ?? container.key ?? "*";

    return {
        groupId: "browse",
        primaryActionId: "remote.redis.openKeyValues",
        actions: [
            {
                id: "remote.redis.openKeyValues",
                label: "打开键浏览",
                icon: KeyRound,
                group: "browse",
                disabled:
                    handlers.openKeyValues == null ||
                    capabilities?.keyValueBrowser !== true,
                run: () => handlers.openKeyValues?.(node),
            },
            {
                id: "remote.redis.copyPattern",
                label: "复制 Pattern",
                icon: Copy,
                group: "browse",
                disabled: handlers.copyText == null,
                run: () => handlers.copyText?.(pattern, "Pattern"),
            },
            {
                id: "remote.redis.copyKey",
                label: "复制 Key",
                icon: Copy,
                group: "browse",
                visible: node.type === "redis_key" && Boolean(container.key),
                disabled: handlers.copyText == null,
                run: () => handlers.copyText?.(container.key ?? "", "Key"),
            },
        ],
    };
};

const columnBrowseActionContributor: ExplorerNodeActionContributor = (ctx) => {
    const { node, handlers } = ctx;
    if (node.type !== "column") return null;
    const container = node.metadata.container;
    if (!container) return null;

    return {
        groupId: "browse",
        actions: [
            {
                id: "remote.column.copyName",
                label: "复制列名",
                icon: Copy,
                group: "browse",
                disabled: handlers.copyText == null,
                run: () =>
                    handlers.copyText?.(container.column ?? node.label, "列名"),
            },
            {
                id: "remote.column.copyType",
                label: "复制类型",
                icon: Copy,
                group: "browse",
                disabled: handlers.copyText == null || !node.metadata.typeName,
                run: () => handlers.copyText?.(node.metadata.typeName ?? "", "类型"),
            },
        ],
    };
};

const databaseManagementActionContributor: ExplorerNodeActionContributor = (ctx) => {
    const { node, handlers, capabilities, connectionRuntimeState } = ctx;
    if (node.type !== "database") {
        return null;
    }

    const canCreate = supportsSchemaMutation(
        capabilities,
        "database",
        "create",
    );
    const canAlter = supportsSchemaMutation(
        capabilities,
        "database",
        "alter",
    );
    const canDrop = supportsSchemaMutation(
        capabilities,
        "database",
        "drop",
    );
    if (!canCreate && !canAlter && !canDrop) return null;

    return {
        groupId: "metadata",
        label: "数据库管理",
        actions: [
            {
                id: "remote.database.createDatabase",
                label: "新建数据库",
                icon: Database,
                group: "metadata",
                visible: canCreate,
                disabled:
                    handlers.createDatabase == null ||
                    connectionRuntimeState !== "connected",
                run: () => handlers.createDatabase?.(node),
            },
            {
                id: "remote.database.editDatabase",
                label: "编辑数据库",
                icon: FilePenLine,
                group: "metadata",
                visible: canAlter,
                disabled:
                    handlers.editDatabase == null ||
                    connectionRuntimeState !== "connected",
                run: () => handlers.editDatabase?.(node),
            },
            {
                id: "remote.database.deleteDatabase",
                label: "删除数据库",
                icon: Trash2,
                group: "metadata",
                visible: canDrop,
                disabled:
                    handlers.deleteDatabase == null ||
                    connectionRuntimeState !== "connected",
                run: () => handlers.deleteDatabase?.(node),
            },
        ],
    };
};

export const REMOTE_NODE_ACTION_CONTRIBUTORS: ExplorerNodeActionContributor[] = [
    remoteBaseActionContributor,
    sqlContextActionContributor,
    tableBrowseActionContributor,
    tableCreationActionContributor,
    tableManagementActionContributor,
    redisBrowseActionContributor,
    columnBrowseActionContributor,
    databaseManagementActionContributor,
];

export function buildRemoteNodeActionSet(
    ctx: ExplorerNodeActionContext,
    extraContributors: ExplorerNodeActionContributor[] = [],
): ExplorerNodeActionSet {
    const collected = collectExplorerNodeActionContributions(ctx, [
        ...REMOTE_NODE_ACTION_CONTRIBUTORS,
        ...extraContributors,
    ]);

    return {
        label: getRemoteMenuLabel(ctx.node),
        primaryActionId: collected.primaryActionId,
        groups: collected.groups,
    };
}
