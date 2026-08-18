import { Circle, LoaderCircle } from "lucide-react";

import type {
    WorkbenchStatusContext,
    WorkbenchStatusContributor,
    WorkbenchStatusItemModel,
} from "../types";

function getActiveProfileId(context: WorkbenchStatusContext): string | null {
    const payload = context.activeTab?.payload;
    if (!payload || !("profileId" in payload)) {
        return null;
    }
    return payload.profileId;
}

export const connectionStatusContributor: WorkbenchStatusContributor = {
    id: "connection-status",
    getItems: (context): WorkbenchStatusItemModel[] => {
        const profileId = getActiveProfileId(context);
        if (!profileId) {
            return [];
        }

        const session = context.connectionSessions[profileId];
        if (!session || session.status === "idle") {
            return [];
        }

        const common = {
            id: "connection-status",
            area: "left" as const,
            priority: 10,
            width: "compact" as const,
        };

        switch (session.status) {
            case "connecting":
                return [
                    {
                        ...common,
                        icon: LoaderCircle,
                        iconClassName: "animate-spin",
                        label: "正在连接",
                        title: "正在连接当前数据库配置",
                        tone: "muted",
                    },
                ];
            case "degraded":
                return [
                    {
                        ...common,
                        icon: Circle,
                        iconClassName: "size-2 fill-current",
                        label: "连接不稳定",
                        title: session.errorMsg ?? "当前数据库运行时连接不稳定",
                        tone: "warning",
                    },
                ];
            case "reconnecting": {
                const recovery = session.recovery;
                return [
                    {
                        ...common,
                        icon: LoaderCircle,
                        iconClassName: "animate-spin",
                        label: recovery
                            ? `正在重连 · ${recovery.attempt}/${recovery.maxAttempts}`
                            : "正在重连",
                        title: session.errorMsg ?? "正在恢复当前数据库运行时会话",
                        tone: "warning",
                    },
                ];
            }
            case "error":
                return [
                    {
                        ...common,
                        icon: Circle,
                        iconClassName: "size-2 fill-current",
                        label: "连接失败",
                        title: session.errorMsg ?? "当前数据库连接失败",
                        tone: "error",
                    },
                ];
            case "disconnecting":
                return [
                    {
                        ...common,
                        icon: LoaderCircle,
                        iconClassName: "animate-spin",
                        label: "正在断开",
                        title: "正在释放当前数据库运行时资源",
                        tone: "muted",
                    },
                ];
            case "connected":
                return [
                    {
                        ...common,
                        icon: Circle,
                        iconClassName: "size-2 fill-current",
                        label:
                            session.ping == null
                                ? "已连接"
                                : `已连接 · ${session.ping}ms`,
                        title: "当前数据库运行时会话已建立",
                        tone: "success",
                    },
                ];
        }
    },
};
