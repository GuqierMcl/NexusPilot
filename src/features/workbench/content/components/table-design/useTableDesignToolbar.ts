import { useEffect } from "react";
import {
    FileCode2,
    PenLine,
    RefreshCw,
    Save,
    Undo2,
} from "lucide-react";

import {
    useContentToolbarStore,
    useTabRuntimeStateStore,
    type ContentToolbarAction,
} from "@/store";
import type { TableSchemaDraft } from "@/types/table-design";

import { isSameDraft } from "./table-design-utils";

type ResetTableDesignDraft = ReturnType<
    typeof useTabRuntimeStateStore.getState
>["resetTableDesignDraft"];

interface UseTableDesignToolbarOptions {
    tabId: string;
    mode: "create" | "edit";
    draft: TableSchemaDraft;
    snapshot: TableSchemaDraft;
    canSaveDesign: boolean;
    isDesignDirty: boolean;
    isRefreshingTableSchema: boolean;
    isUpdatePending: boolean;
    onSaveDesign: () => void;
    onOpenDdlPreview: () => void;
    onRefreshTableSchema: () => void;
    resetTableDesignDraft: ResetTableDesignDraft;
}

export function useTableDesignToolbar({
    tabId,
    mode,
    draft,
    snapshot,
    canSaveDesign,
    isDesignDirty,
    isRefreshingTableSchema,
    isUpdatePending,
    onSaveDesign,
    onOpenDdlPreview,
    onRefreshTableSchema,
    resetTableDesignDraft,
}: UseTableDesignToolbarOptions) {
    const setToolbar = useContentToolbarStore((state) => state.setToolbar);
    const clearToolbar = useContentToolbarStore((state) => state.clearToolbar);

    useEffect(() => {
        const actions: ContentToolbarAction[] = [
            {
                id: "save",
                icon: Save,
                label: "保存",
                title:
                    mode === "create"
                        ? "创建表"
                        : "保存表结构修改",
                variant: "default",
                disabled: !canSaveDesign,
                onClick: onSaveDesign,
            },
            ...(mode === "edit"
                ? [
                          {
                              id: "refresh" as const,
                              icon: RefreshCw,
                          label: "刷新结构",
                          title: isDesignDirty
                              ? "刷新远端表结构并丢弃当前草稿"
                              : "刷新远端表结构",
                          disabled: isRefreshingTableSchema || isUpdatePending,
                          onClick: onRefreshTableSchema,
                      },
                  ]
                : []),
            {
                id: "previewDdl",
                icon: FileCode2,
                label: "DDL",
                title: "预览 DDL",
                onClick: onOpenDdlPreview,
            },
            {
                id: "resetDesign",
                icon: Undo2,
                label: "重置",
                title: "撤回所有草稿修改",
                disabled: isSameDraft(draft, snapshot),
                onClick: () => resetTableDesignDraft(tabId),
            },
        ];

        const tableName = draft.basics.tableName.trim();
        const contextLabel =
            mode === "create"
                ? tableName
                    ? `新建表 | ${tableName}`
                    : "新建表"
                : tableName || "表结构设计";

        setToolbar(tabId, {
            actions,
            context: {
                icon: PenLine,
                label: contextLabel,
            },
        });
        return () => clearToolbar(tabId);
    }, [
        clearToolbar,
        canSaveDesign,
        draft,
        isDesignDirty,
        isRefreshingTableSchema,
        isUpdatePending,
        mode,
        onSaveDesign,
        onOpenDdlPreview,
        onRefreshTableSchema,
        resetTableDesignDraft,
        setToolbar,
        snapshot,
        tabId,
    ]);
}
