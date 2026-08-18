import { CircleAlert, LoaderCircle, WifiOff } from "lucide-react";

import type {
    WorkbenchStatusContributor,
    WorkbenchStatusItemModel,
} from "../types";

export const aiRuntimeWarningStatusContributor: WorkbenchStatusContributor = {
    id: "ai-runtime-warning",
    getItems: (context): WorkbenchStatusItemModel[] => {
        const blocker = context.agent.composerSendBlocker;

        if (blocker?.code === "runtime_unavailable") {
            if (context.aiRuntime.healthStatus !== "unhealthy") {
                return [];
            }

            return [
                {
                    id: "ai-runtime-warning",
                    area: "right",
                    priority: 100,
                    icon: WifiOff,
                    label: "AI 暂不可用",
                    title:
                        context.aiRuntime.errorMessage ??
                        "AI Runtime 暂不可用",
                    tone: "error",
                    width: "compact",
                },
            ];
        }

        if (blocker?.code === "recovering") {
            return [
                {
                    id: "ai-conversation-recovering",
                    area: "right",
                    priority: 100,
                    icon: LoaderCircle,
                    iconClassName: "animate-spin",
                    label: "正在恢复对话",
                    title: "正在恢复当前对话",
                    tone: "info",
                    width: "compact",
                },
            ];
        }

        if (blocker?.code === "missing_model") {
            return [
                {
                    id: "ai-model-missing",
                    area: "right",
                    priority: 100,
                    icon: CircleAlert,
                    label: "请选择模型",
                    title: "未选择用于当前对话的模型",
                    tone: "warning",
                    width: "compact",
                },
            ];
        }

        if (blocker?.code === "model_unavailable") {
            return [
                {
                    id: "ai-model-unavailable",
                    area: "right",
                    priority: 100,
                    icon: CircleAlert,
                    label: "当前模型不可用",
                    title: "当前选择的模型不在可用列表中",
                    tone: "warning",
                    width: "compact",
                },
            ];
        }

        if (blocker?.code === "adapter_error") {
            return [
                {
                    id: "ai-adapter-error",
                    area: "right",
                    priority: 100,
                    icon: CircleAlert,
                    label: "AI 操作不可用",
                    title: blocker.message,
                    tone: "error",
                    width: "compact",
                },
            ];
        }

        if (context.aiRuntime.healthStatus !== "unhealthy") {
            return [];
        }

        return [
            {
                id: "ai-runtime-warning",
                area: "right",
                priority: 100,
                icon: WifiOff,
                label: "AI 暂不可用",
                title:
                    context.aiRuntime.errorMessage ??
                    "AI Runtime 暂不可用",
                tone: "error",
                width: "compact",
            },
        ];
    },
};
