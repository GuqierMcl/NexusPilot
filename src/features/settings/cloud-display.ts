import type { CloudSyncRuntimePhase, CloudSyncSetupContext } from "@/types/ipc";

export function formatPlan(planCode: string): string {
    return planCode ? planCode[0].toLocaleUpperCase() + planCode.slice(1) : "—";
}

export function formatAccountStatus(status: string): string {
    if (status === "active") return "账户正常";
    if (status === "suspended") return "账户已暂停";
    return "账户不可用";
}

export function formatSubscriptionEnd(value: string | null): string {
    if (!value) return "长期有效";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

export function quotaPercent(used: number, limit: number): number {
    if (limit <= 0) return 0;
    return Math.min(100, Math.round((used / limit) * 100));
}

export function formatQuota(used: number, limit: number, unit: string): string {
    return limit > 0 ? `${used} / ${limit} ${unit}` : "暂不可用";
}

export function formatByteQuota(used: number, limit: number): string {
    return limit > 0 ? `${formatBytes(used)} / ${formatBytes(limit)}` : "暂不可用";
}

export function formatBytes(value: number): string {
    if (!Number.isFinite(value) || value < 0) return "—";
    if (value < 1024) return `${value} B`;
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let amount = value;
    let unit = "B";
    for (const nextUnit of units) {
        amount /= 1024;
        unit = nextUnit;
        if (amount < 1024) break;
    }
    return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(amount)} ${unit}`;
}

export function formatCachedAt(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function formatSyncPhase(phase: CloudSyncRuntimePhase): string {
    switch (phase) {
        case "syncing": return "同步中";
        case "paused": return "已暂停";
        case "offline": return "暂时离线";
        case "read_only": return "只读状态";
        case "quota_exceeded": return "用量已达上限";
        case "conflicted": return "有待处理冲突";
        case "device_revoked": return "本设备已撤销";
        case "recovery_required": return "需要恢复";
        case "unavailable": return "暂时不可用";
        case "idle": return "已连接";
        default: return "未启用";
    }
}

export function isCloudEntitled(context: CloudSyncSetupContext): boolean {
    return context.connectionSync.phase !== "not_entitled";
}
