import { FileSearch2 } from "lucide-react";

import type {
    WorkbenchStatusContributor,
    WorkbenchStatusItemModel,
} from "../types";

export const schemaDesignStatusContributor: WorkbenchStatusContributor = {
    id: "schema-design-status",
    getItems: (context): WorkbenchStatusItemModel[] => {
        const activeTab = context.activeTab;
        if (!activeTab) return [];

        const state =
            context.tabRuntimeState.schemaDesignByTabId[activeTab.id];
        if (!state) return [];
        const isViewDesign = activeTab.type === "clickhouse_view_design";
        const objectLabel = isViewDesign ? "View 结构" : "表结构";
        const remoteObjectLabel = isViewDesign
            ? "ClickHouse View 结构"
            : "ClickHouse 表结构";

        const common = {
            id: "schema-design-status",
            area: "left" as const,
            priority: 15,
            icon: FileSearch2,
            width: "content" as const,
        };

        if (state.mode === "create") {
            switch (state.operationState) {
                case "previewing":
                    return [
                        {
                            ...common,
                            label: "正在生成 DDL 预览",
                            title: "正在根据当前结构草稿生成 DDL 预览",
                            tone: "muted",
                        },
                    ];
                case "previewReady":
                    return [
                        {
                            ...common,
                            label: "DDL 预览已就绪",
                            title: "当前结构草稿的 DDL 预览已就绪",
                            tone: "info",
                        },
                    ];
                case "applying":
                    return [
                        {
                            ...common,
                            label: "正在创建远端对象",
                            title: "正在执行结构创建计划",
                            tone: "info",
                        },
                    ];
                case "backgroundRunning":
                    return [
                        {
                            ...common,
                            label: "后台结构工作运行中",
                            title: "远端结构已提交，关联后台工作仍在运行",
                            tone: "info",
                        },
                    ];
                case "submitted":
                    return [
                        {
                            ...common,
                            label: "结构变更已提交",
                            title: state.errorMessage ?? "远端已接受结构动作",
                            tone: "warning",
                        },
                    ];
                case "partiallyApplied":
                    return [
                        {
                            ...common,
                            label: "结构变更部分应用",
                            title: state.errorMessage ?? "部分结构动作已经应用",
                            tone: "warning",
                        },
                    ];
                case "clusterDrift":
                    return [
                        {
                            ...common,
                            label: "集群结构已漂移",
                            title: state.errorMessage ?? "集群拓扑或对象定义与预览基线不一致",
                            tone: "warning",
                        },
                    ];
                case "conflict":
                    return [
                        {
                            ...common,
                            label: "远端结构已变化",
                            title: state.errorMessage ?? "远端结构与预览基线不一致",
                            tone: "warning",
                        },
                    ];
                case "outcomeUnknown":
                    return [
                        {
                            ...common,
                            label: "创建结果待确认",
                            title:
                                state.errorMessage ??
                                "远端创建结果暂时无法确认，请先核对远端事实",
                            tone: "warning",
                        },
                    ];
                case "idle":
                    break;
            }

            if (state.errorMessage) {
                return [
                    {
                        ...common,
                        label: "DDL 预览生成失败",
                        title: state.errorMessage,
                        tone: "error",
                    },
                ];
            }
            if (state.blockerCount > 0) {
                return [
                    {
                        ...common,
                        label: `结构创建草稿 · ${state.blockerCount} 项待修正`,
                        title: `${state.blockerCount} 项输入需要修正后才能生成 DDL 预览`,
                        tone: "warning",
                    },
                ];
            }
            return [
                {
                    ...common,
                    label: "结构创建草稿 · 等待 DDL 预览",
                    title: "当前创建草稿尚无可执行的 DDL 预览",
                    tone: "muted",
                },
            ];
        }

        switch (state.operationState) {
            case "previewing":
                return [
                    {
                        ...common,
                        label: "正在生成结构 DDL 预览",
                        title: "正在根据当前结构草稿生成 DDL 预览",
                        tone: "muted",
                    },
                ];
            case "previewReady":
                return [
                    {
                        ...common,
                        label: "结构 DDL 预览已就绪",
                        title: "当前结构草稿的 DDL 预览已就绪",
                        tone: "info",
                    },
                ];
            case "applying":
                return [
                    {
                        ...common,
                        label: "正在应用结构变更",
                        title: "正在执行已确认的远端结构变更计划",
                        tone: "info",
                    },
                ];
            case "backgroundRunning":
                return [
                    {
                        ...common,
                        label: "后台结构工作运行中",
                        title: "远端结构已应用，关联后台工作仍在运行",
                        tone: "info",
                    },
                ];
            case "submitted":
                return [
                    {
                        ...common,
                        label: "结构变更已提交",
                        title:
                            state.errorMessage ??
                            "远端已接受结构动作，请刷新确认最终事实",
                        tone: "warning",
                    },
                ];
            case "partiallyApplied":
                return [
                    {
                        ...common,
                        label: "结构变更部分应用",
                        title:
                            state.errorMessage ??
                            "部分 DDL 已执行，请根据远端事实处理冲突",
                        tone: "warning",
                    },
                ];
            case "outcomeUnknown":
                return [
                    {
                        ...common,
                        label: "结构变更结果待确认",
                        title:
                            state.errorMessage ??
                            "当前无法证明远端最终结构，请刷新核对",
                        tone: "warning",
                    },
                ];
            case "conflict":
                return [
                    {
                        ...common,
                        label: "远端结构已变化",
                        title:
                            state.errorMessage ??
                            "远端结构与预览基线不一致，请刷新后重新确认",
                        tone: "warning",
                    },
                ];
            case "clusterDrift":
                return [
                    {
                        ...common,
                        label: "集群结构已漂移",
                        title:
                            state.errorMessage ??
                            "集群拓扑或对象定义与预览基线不一致",
                        tone: "warning",
                    },
                ];
            case "idle":
                break;
        }

        if (state.loadState === "ready" && state.errorMessage) {
            return [
                {
                    ...common,
                    label: "结构变更预览失败",
                    title: state.errorMessage,
                    tone: "error",
                },
            ];
        }
        if (state.loadState === "ready" && state.blockerCount > 0) {
            return [
                {
                    ...common,
                    label: `结构编辑草稿 · ${state.blockerCount} 项待修正`,
                    title: `${state.blockerCount} 项输入需要修正后才能生成 DDL 预览`,
                    tone: "warning",
                },
            ];
        }
        if (state.loadState === "ready" && state.isDirty) {
            return [
                {
                    ...common,
                    label: "结构编辑草稿 · 等待 DDL 预览",
                    title: "当前结构草稿尚无可执行的 DDL 预览",
                    tone: "muted",
                },
            ];
        }

        switch (state.loadState) {
            case "loading":
                return [
                    {
                        ...common,
                        label: `正在读取 ${remoteObjectLabel}`,
                        title: `正在读取远端 ${remoteObjectLabel}`,
                        tone: "muted",
                    },
                ];
            case "ready":
                return [
                    {
                        ...common,
                        label: isViewDesign
                            ? "ClickHouse View 结构 · 只读基线"
                            : "ClickHouse 表结构 · 只读基线",
                        title: `${objectLabel}只读基线已加载`,
                        tone: "muted",
                    },
                ];
            case "restricted":
                return [
                    {
                        ...common,
                        label: `${isViewDesign ? "结构" : "表结构"}部分受限 · ${state.blockerCount} 项`,
                        title: `${state.blockerCount} 项结构语义受限`,
                        tone: "warning",
                    },
                ];
            case "readonly":
                return [
                    {
                        ...common,
                        label: `${isViewDesign ? "结构" : "表结构"}只读 · ${state.blockerCount} 项阻断`,
                        title: `${state.blockerCount} 项结构语义阻止编辑`,
                        tone: "warning",
                    },
                ];
            case "sessionExpired":
                return [
                    {
                        ...common,
                        label: "会话已过期",
                        title: state.errorMessage ?? "Temporary View owner session 已过期；不会自动重建",
                        tone: "warning",
                    },
                ];
            case "error":
                return [
                    {
                        ...common,
                        label: `${objectLabel}读取失败`,
                        title: state.errorMessage ?? `${objectLabel}读取失败`,
                        tone: "error",
                    },
                ];
        }
    },
};
