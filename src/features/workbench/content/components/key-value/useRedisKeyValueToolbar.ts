import { useEffect } from "react";
import { KeyRound, Plus, RefreshCw, SquarePen } from "lucide-react";

import {
    useExplorerStore,
    useContentToolbarStore,
    type ContentToolbarAction,
} from "@/store";

interface UseRedisKeyValueToolbarOptions {
    tabId: string;
    profileId: string;
    dbIndex: number;
    isCreateDialogOpen: boolean;
    isCreatePending: boolean;
    isFetching: boolean;
    isPreviewCollapsed: boolean;
    onOpenCreateDialog: () => void;
    onRefresh: () => void;
    onTogglePreview: () => void;
}

export function useRedisKeyValueToolbar({
    tabId,
    profileId,
    dbIndex,
    isCreateDialogOpen,
    isCreatePending,
    isFetching,
    isPreviewCollapsed,
    onOpenCreateDialog,
    onRefresh,
    onTogglePreview,
}: UseRedisKeyValueToolbarOptions) {
    const setToolbar = useContentToolbarStore((state) => state.setToolbar);
    const clearToolbar = useContentToolbarStore((state) => state.clearToolbar);
    const connectionName = useExplorerStore(
        (state) =>
            state.connections.find((connection) => connection.id === profileId)
                ?.name ?? profileId,
    );

    useEffect(() => {
        const actions: ContentToolbarAction[] = [
            {
                id: "addKey",
                icon: Plus,
                label: "新增键",
                title: "新建 Redis key",
                variant: "default",
                pressed: isCreateDialogOpen,
                disabled: isCreatePending,
                onClick: onOpenCreateDialog,
            },
            {
                id: "refresh",
                icon: RefreshCw,
                label: "刷新",
                title: "刷新 Redis key 目录",
                disabled: isFetching,
                onClick: onRefresh,
            },
            {
                id: "togglePreview",
                icon: SquarePen,
                label: "预览栏",
                title: isPreviewCollapsed ? "打开预览栏" : "折叠预览栏",
                pressed: !isPreviewCollapsed,
                onClick: onTogglePreview,
            },
        ];

        setToolbar(tabId, {
            actions,
            context: {
                icon: KeyRound,
                label: `${connectionName} | DB ${dbIndex}`,
            },
        });
        return () => clearToolbar(tabId);
    }, [
        clearToolbar,
        connectionName,
        dbIndex,
        isCreateDialogOpen,
        isCreatePending,
        isFetching,
        isPreviewCollapsed,
        onOpenCreateDialog,
        onRefresh,
        onTogglePreview,
        profileId,
        setToolbar,
        tabId,
    ]);
}
