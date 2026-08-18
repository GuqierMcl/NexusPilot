import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";

import type {
    WorkbenchStatusContributor,
    WorkbenchStatusItemModel,
} from "../types";

export const connectionSummaryStatusContributor: WorkbenchStatusContributor = {
    id: "connection-summary",
    getItems: (context): WorkbenchStatusItemModel[] => {
        const sessions = Object.values(context.connectionSessions);
        const errorCount = sessions.filter(
            (session) => session.status === "error",
        ).length;
        const degradedCount = sessions.filter(
            (session) => session.status === "degraded",
        ).length;
        const reconnectingCount = sessions.filter(
            (session) => session.status === "reconnecting",
        ).length;
        const connectingCount = sessions.filter(
            (session) => session.status === "connecting",
        ).length;
        const connectedCount = sessions.filter(
            (session) => session.status === "connected",
        ).length;

        const abnormalCount =
            errorCount + degradedCount + reconnectingCount;
        if (abnormalCount > 0) {
            const details = [
                errorCount > 0 ? `${errorCount} 个失败` : null,
                degradedCount > 0 ? `${degradedCount} 个不稳定` : null,
                reconnectingCount > 0
                    ? `${reconnectingCount} 个重连中`
                    : null,
            ].filter((detail): detail is string => detail !== null);
            return [
                {
                    id: "connection-summary",
                    area: "right",
                    priority: 80,
                    icon: CircleAlert,
                    label: `${abnormalCount} 个连接异常`,
                    title: details.join("，"),
                    tone: errorCount > 0 ? "error" : "warning",
                    width: "compact",
                },
            ];
        }

        if (connectingCount > 0) {
            return [
                {
                    id: "connection-summary",
                    area: "right",
                    priority: 80,
                    icon: LoaderCircle,
                    iconClassName: "animate-spin",
                    label: `${connectingCount} 个连接中`,
                    title: `${connectingCount} 个连接正在建立`,
                    tone: "muted",
                    width: "compact",
                },
            ];
        }

        if (connectedCount > 0) {
            return [
                {
                    id: "connection-summary",
                    area: "right",
                    priority: 80,
                    icon: CircleCheck,
                    label: `${connectedCount} 个连接在线`,
                    title: `${connectedCount} 个连接在线`,
                    tone: "muted",
                    width: "compact",
                },
            ];
        }

        return [];
    },
};
