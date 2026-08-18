import {
    AlertCircleIcon,
    CloudOffIcon,
    LockKeyholeIcon,
    PauseIcon,
    RefreshCwIcon,
    RotateCcwKeyIcon,
    ShieldAlertIcon,
    TriangleAlertIcon,
    WifiOffIcon,
} from "lucide-react";

import { Spinner } from "@/components/ui/spinner";

import type {
    WorkbenchStatusContributor,
    WorkbenchStatusItemModel,
} from "../types";

function formatCount(value: number): string {
    return new Intl.NumberFormat("zh-CN").format(value);
}

function item(
    icon: WorkbenchStatusItemModel["icon"],
    label: string,
    title: string,
    tone: WorkbenchStatusItemModel["tone"],
): WorkbenchStatusItemModel {
    return {
        id: "cloud-sync-status",
        area: "right",
        priority: 85,
        icon,
        label,
        title,
        tone,
        width: "compact",
    };
}

export const cloudSyncStatusContributor: WorkbenchStatusContributor = {
    id: "cloud-sync-status",
    getItems: (context): WorkbenchStatusItemModel[] => {
        const runtime = context.cloud?.runtime;
        if (!runtime) {
            return [];
        }

        const pendingOperations = Math.max(0, runtime.pendingOperations);
        const conflicts = Math.max(0, runtime.conflicts);

        switch (runtime.phase) {
            case "disabled":
                return [];
            case "device_revoked":
                return [
                    item(
                        ShieldAlertIcon,
                        "本设备已撤销",
                        "本设备已不能继续访问同步数据",
                        "error",
                    ),
                ];
            case "recovery_required":
                return [
                    item(
                        RotateCcwKeyIcon,
                        "同步需要恢复",
                        "请使用恢复密钥恢复本设备的同步访问",
                        "warning",
                    ),
                ];
            case "quota_exceeded":
                return [
                    item(
                        TriangleAlertIcon,
                        "同步用量已达上限",
                        "当前同步用量已达到 Cloud 配额上限",
                        "warning",
                    ),
                ];
            case "read_only":
                return [
                    item(
                        LockKeyholeIcon,
                        "同步只读",
                        "当前只能读取已有同步数据",
                        "warning",
                    ),
                ];
            case "conflicted":
                return [
                    item(
                        AlertCircleIcon,
                        `${formatCount(Math.max(1, conflicts))} 个冲突待解决`,
                        "请在同步与安全页面选择要保留的版本",
                        "warning",
                    ),
                ];
            case "offline":
                return [
                    item(
                        WifiOffIcon,
                        "同步暂时离线",
                        pendingOperations > 0
                            ? `当前有 ${formatCount(pendingOperations)} 项待同步，网络恢复后会继续处理`
                            : "网络恢复后会继续同步",
                        "warning",
                    ),
                ];
            case "paused":
                return [
                    item(
                        PauseIcon,
                        "同步已暂停",
                        "本设备同步已暂停，可在同步与安全页面恢复",
                        "warning",
                    ),
                ];
            case "syncing":
                return [
                    item(
                        Spinner,
                        "同步中",
                        "正在处理同步任务",
                        "info",
                    ),
                ];
            case "idle":
                return pendingOperations > 0
                    ? [
                          item(
                              RefreshCwIcon,
                              `${formatCount(pendingOperations)} 项待同步`,
                              "当前有同步任务等待处理",
                              "warning",
                          ),
                      ]
                    : [];
            case "unavailable":
            default:
                return [
                    item(
                        CloudOffIcon,
                        "同步暂不可用",
                        "当前无法继续处理同步任务",
                        "error",
                    ),
                ];
        }
    },
};
