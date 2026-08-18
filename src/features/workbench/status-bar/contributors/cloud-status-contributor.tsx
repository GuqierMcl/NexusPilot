import {
    AlertCircleIcon,
    CloudCheckIcon,
    CloudOffIcon,
    LoaderCircleIcon,
    RefreshCwIcon,
} from "lucide-react";

import type {
    WorkbenchStatusContributor,
    WorkbenchStatusItemModel,
} from "../types";

const CLOUD_REFRESH_SLOW_AFTER_MS = 5_000;

export const cloudStatusContributor: WorkbenchStatusContributor = {
    id: "cloud-status",
    getItems: (context): WorkbenchStatusItemModel[] => {
        const cloud = context.cloud;
        if (!cloud || cloud.connection === "unauthenticated") {
            return [];
        }

        const refreshStartedAt = cloud.refresh.lastStartedAt
            ? Date.parse(cloud.refresh.lastStartedAt)
            : Number.NaN;
        const refreshIsSlow =
            cloud.refresh.inFlight &&
            Number.isFinite(refreshStartedAt) &&
            context.nowMs - refreshStartedAt >= CLOUD_REFRESH_SLOW_AFTER_MS;

        if (cloud.refresh.inFlight && !refreshIsSlow) {
            return [
                {
                    id: "cloud-status",
                    area: "right",
                    priority: 90,
                    icon: LoaderCircleIcon,
                    iconClassName: "animate-spin",
                    label: "Cloud 连接中",
                    title: "正在连接 NexusPilot Cloud",
                    tone: "info",
                    width: "compact",
                },
            ];
        }

        switch (cloud.connection) {
            case "connected":
                return [
                    {
                        id: "cloud-status",
                        area: "right",
                        priority: 90,
                        icon: CloudCheckIcon,
                        label: "Cloud",
                        title: "NexusPilot Cloud 已连接",
                        tone: "success",
                        width: "compact",
                    },
                ];
            case "cached":
            case "offline":
                return [
                    {
                        id: "cloud-status",
                        area: "right",
                        priority: 90,
                        icon: CloudOffIcon,
                        label: "Cloud 暂时离线",
                        title: "当前显示最近一次 Cloud 状态",
                        tone: "warning",
                        width: "compact",
                    },
                ];
            case "permission_denied":
                return [
                    {
                        id: "cloud-status",
                        area: "right",
                        priority: 90,
                        icon: AlertCircleIcon,
                        label: "Cloud 无访问权限",
                        title: "当前账号没有 NexusPilot Cloud 访问权限",
                        tone: "error",
                        width: "compact",
                    },
                ];
            case "reauthentication_required":
                return [
                    {
                        id: "cloud-status",
                        area: "right",
                        priority: 90,
                        icon: AlertCircleIcon,
                        label: "Cloud 需要重新登录",
                        title: "请重新登录 NIEEX Account",
                        tone: "error",
                        width: "compact",
                    },
                ];
            case "needs_refresh":
                return [
                    {
                        id: "cloud-status",
                        area: "right",
                        priority: 90,
                        icon: RefreshCwIcon,
                        label: "Cloud 待更新",
                        title: "Cloud 状态等待更新",
                        tone: "warning",
                        width: "compact",
                    },
                ];
            case "refreshing":
                return [
                    {
                        id: "cloud-status",
                        area: "right",
                        priority: 90,
                        icon: RefreshCwIcon,
                        label: "Cloud 状态更新较慢",
                        title: "Cloud 状态仍在更新，请稍候",
                        tone: "warning",
                        width: "compact",
                    },
                ];
            case "unavailable":
            default:
                return [
                    {
                        id: "cloud-status",
                        area: "right",
                        priority: 90,
                        icon: AlertCircleIcon,
                        label: "Cloud 暂不可用",
                        title: "NexusPilot Cloud 暂时不可用",
                        tone: "error",
                        width: "compact",
                    },
                ];
        }
    },
};
