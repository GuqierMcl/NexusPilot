import { useEffect } from "react";
import {
    DatabaseZap,
    FileCode2,
    PanelsTopLeft,
    RefreshCw,
    Save,
    Trash2,
    Undo2,
} from "lucide-react";

import { useContentToolbarStore } from "@/store";
import type { ClickHouseViewDesignRuntimeState } from "@/types/clickhouse-view-design";

interface UseClickHouseViewToolbarInput {
    tabId: string;
    state: ClickHouseViewDesignRuntimeState;
    canWrite: boolean;
    pending: boolean;
    isDirty: boolean;
    issueCount: number;
    onPreview: () => void;
    onApply: () => void;
    onRefresh: () => void;
    onReset: () => void;
    onRename?: () => void;
    onDrop?: () => void;
    onOpenData?: () => void;
}

export function useClickHouseViewToolbar(
    input: UseClickHouseViewToolbarInput,
): void {
    const setToolbar = useContentToolbarStore((state) => state.setToolbar);
    const clearToolbar = useContentToolbarStore((state) => state.clearToolbar);
    useEffect(() => {
        const createMode = input.state.mode !== "edit";
        const previewReady = input.state.preview != null;
        setToolbar(input.tabId, {
            actions: [
                {
                    id: "viewPreview",
                    icon: FileCode2,
                    label: "Preview",
                    title: "预览强类型 ClickHouse View DDL 计划",
                    disabled:
                        !input.canWrite || input.pending || input.issueCount > 0,
                    onClick: input.onPreview,
                },
                {
                    id: "viewApply",
                    icon: Save,
                    label: createMode ? "Create" : "Apply",
                    title: "执行与当前 draft/support/baseline 匹配的计划",
                    variant: "default",
                    disabled:
                        !input.canWrite ||
                        input.pending ||
                        input.issueCount > 0 ||
                        !previewReady,
                    onClick: input.onApply,
                },
                {
                    id: "viewRefresh",
                    icon: RefreshCw,
                    label: createMode ? "Refresh Support" : "Refresh Definition",
                    title: "刷新服务器支持与远端结构事实",
                    disabled: input.pending,
                    onClick: input.onRefresh,
                },
                {
                    id: "viewReset",
                    icon: Undo2,
                    label: "Reset",
                    title: "恢复最近一次已确认的远端或初始草稿",
                    disabled: input.pending || !input.isDirty,
                    onClick: input.onReset,
                },
                ...(!createMode
                    ? [
                          {
                              id: "viewRename",
                              icon: PanelsTopLeft,
                              label: "Rename",
                              title: "预览并执行单对象 Rename",
                              disabled:
                                  !input.canWrite ||
                                  input.pending ||
                                  input.onRename == null,
                              onClick: input.onRename,
                          },
                          {
                              id: "viewDrop",
                              icon: Trash2,
                              label: "Drop",
                              title: "预览并执行 DROP VIEW ... SYNC",
                              disabled:
                                  !input.canWrite ||
                                  input.pending ||
                                  input.onDrop == null,
                              onClick: input.onDrop,
                          },
                          {
                              id: "viewOpenData",
                              icon: DatabaseZap,
                              label: "Open Data",
                              title: "打开 View 数据浏览",
                              disabled: input.pending || input.onOpenData == null,
                              onClick: input.onOpenData,
                          },
                      ]
                    : []),
            ],
            context: {
                icon: PanelsTopLeft,
                label: `${input.state.family} | ${input.state.draft.address.name || "未命名 View"}`,
            },
        });
        return () => clearToolbar(input.tabId);
    }, [clearToolbar, input, setToolbar]);
}
