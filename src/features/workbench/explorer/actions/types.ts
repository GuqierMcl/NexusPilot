import type { ComponentType, SVGProps } from "react";

import type {
    ConnectionNodeOpenHandler,
    ConnectionNodeRuntimeState,
    ExplorerTreeNode,
} from "@/features/workbench/explorer/types";
import type { DriverCapabilities } from "@/types/ipc";
import type { DbDriver, StoredDatabaseConnection } from "@/types";

export type ExplorerNodeActionGroupId =
    | "local"
    | "connection"
    | "driver"
    | "remote"
    | "browse"
    | "metadata"
    | "saved-query";

export type ExplorerNodeAction = {
    id: string;
    label: string;
    icon?: ComponentType<SVGProps<SVGSVGElement>>;
    group: ExplorerNodeActionGroupId;
    visible?: boolean;
    disabled?: boolean;
    run: () => void | boolean | Promise<void | boolean>;
};

export type ExplorerNodeActionGroup = {
    id: ExplorerNodeActionGroupId | string;
    label?: string;
    actions: ExplorerNodeAction[];
};

export type ExplorerNodeActionSet = {
    label: string;
    primaryActionId?: string;
    groups: ExplorerNodeActionGroup[];
};

export type ExplorerNodeActionHandlers = {
    openConnection?: ConnectionNodeOpenHandler;
    closeConnection?: (nodeId: string) => void | Promise<void>;
    expandNode?: (node: ExplorerTreeNode) => void;
    newConnection?: (folderId: string | null) => void;
    newFolder?: (parentFolderId: string | null) => void;
    driverMenuAction?: (params: {
        actionId: string;
        node: ExplorerTreeNode;
    }) => void | Promise<void>;
    cloneConnection?: (connection: StoredDatabaseConnection) => void;
    editConnection?: (connection: StoredDatabaseConnection) => void;
    renameNode?: (node: ExplorerTreeNode) => void;
    deleteNode?: (node: ExplorerTreeNode) => void;
    refreshNode?: (node: ExplorerTreeNode) => void;
    createDatabase?: (node: ExplorerTreeNode) => void;
    editDatabase?: (node: ExplorerTreeNode) => void;
    deleteDatabase?: (node: ExplorerTreeNode) => void;
    deleteTable?: (node: ExplorerTreeNode) => void;
    openSqlEditor?: (node: ExplorerTreeNode) => void;
    openSavedQuery?: (node: ExplorerTreeNode) => void;
    deleteSavedQuery?: (node: ExplorerTreeNode) => void;
    openTableData?: (node: ExplorerTreeNode) => void;
    openTableDesign?: (node: ExplorerTreeNode) => void;
    openKeyValues?: (node: ExplorerTreeNode) => void;
    copyText?: (value: string, label: string) => void | Promise<void>;
};

export type ExplorerNodeActionContext = {
    node: ExplorerTreeNode;
    connectionDriver?: DbDriver;
    connectionRuntimeState?: ConnectionNodeRuntimeState;
    capabilities?: DriverCapabilities;
    isNodeLoading: boolean;
    isLeafNode: boolean;
    hasChildren: boolean;
    hasLoadedChildren: boolean;
    handlers: ExplorerNodeActionHandlers;
};

export type ExplorerNodeActionContribution = {
    groupId: ExplorerNodeActionGroup["id"];
    label?: string;
    actions: ExplorerNodeAction[];
    primaryActionId?: string;
};

export type ExplorerNodeActionContributor = (
    ctx: ExplorerNodeActionContext,
) => ExplorerNodeActionContribution | null | undefined;
