import { useState } from "react";
import {
    CloudIcon,
    LockKeyholeIcon,
    RefreshCwIcon,
    ShieldCheckIcon,
    TriangleAlertIcon,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardAction,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useCloudSetupContext } from "@/features/settings/cloud-context";
import { SettingsSection } from "@/features/settings/components/settings-section";
import type {
    CloudSyncSetupContext,
    CloudSyncStateProjection,
} from "@/types/ipc";

import { EnableCloudSyncDialog } from "./enable-cloud-sync-dialog";

export function CloudSyncPanel() {
    const { authenticated, context, loading, refreshTimedOut, error, refresh } = useCloudSetupContext();
    const [setupOpen, setSetupOpen] = useState(false);

    const handleEnabled = async (_projection: CloudSyncStateProjection): Promise<void> => {
        await refresh();
    };

    if (!authenticated) {
        return (
            <SettingsSection
                title="NexusPilot Cloud"
                description="查看你的订阅和 Cloud 使用情况。"
            >
                <Alert>
                    <CloudIcon />
                    <AlertTitle>请先登录 NIEEX Account</AlertTitle>
                    <AlertDescription>
                        登录后可查看订阅和 Cloud 使用情况，并按需启用安全同步。
                    </AlertDescription>
                </Alert>
            </SettingsSection>
        );
    }

    const entitled = context ? context.connectionSync.phase !== "not_entitled" : false;
    const canEnroll =
        context?.source === "cloud" &&
        context.connectionSync.permissions.enrollSyncDevice &&
        context.localSync.status === "disabled";
    const cloudInitialized = context?.sync.initialized ?? false;
    const localReady = context?.localSync.status === "ready";
    const syncEnabled = cloudInitialized && localReady;

    return (
        <div className="flex flex-col gap-6">
            {!context && (error || refreshTimedOut) ? (
                <Alert variant={error ? "destructive" : "default"}>
                    <AlertTitle>暂时无法读取 Cloud 状态</AlertTitle>
                    <AlertDescription>
                        {error?.message ?? "Cloud 状态加载时间较长，请点击重试。"}
                    </AlertDescription>
                    {!error ? (
                        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void refresh()}>
                            <RefreshCwIcon data-icon="inline-start" />
                            重试
                        </Button>
                    ) : null}
                </Alert>
            ) : null}

            <SettingsSection
                title="Cloud 账户"
                description="查看你的订阅和 Cloud 使用情况。"
            >
                {context ? <CloudAccountDetails context={context} /> : refreshTimedOut || error ? <CloudUnavailablePlaceholder /> : <CloudAccountSkeleton />}
            </SettingsSection>

            <SettingsSection
                title="端到端加密同步"
                description="在设备之间安全同步你的连接信息。"
            >
                {context ? (
                    <div className="flex flex-col gap-3">
                        <div className="flex items-center gap-2 text-sm">
                            {syncEnabled ? (
                                <ShieldCheckIcon className="size-4 text-primary" aria-hidden="true" />
                            ) : (
                                <LockKeyholeIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                            )}
                            <span className="font-medium">
                                {syncEnabled ? "端到端加密同步已启用" : "端到端加密同步"}
                            </span>
                            <Badge variant={syncEnabled ? "secondary" : "outline"}>
                                {syncEnabled
                                    ? "已启用"
                                    : cloudInitialized && !localReady
                                      ? "需要恢复"
                                      : entitled
                                        ? "尚未启用"
                                        : "当前不可用"}
                            </Badge>
                            {syncEnabled ? (
                                <span className="text-xs text-muted-foreground">
                                    {context.sync.activeDeviceCount} 台设备
                                </span>
                            ) : null}
                        </div>
                        {syncEnabled ? null : cloudInitialized && !localReady ? (
                            <div className="flex items-start gap-2 rounded-md bg-muted/50 p-3 text-sm">
                                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                <div className="flex flex-col gap-1">
                                    <span className="font-medium">本地同步密钥不可用</span>
                                    <span className="text-xs text-muted-foreground">
                                        当前设备暂时无法进行端到端加密同步。
                                    </span>
                                </div>
                            </div>
                        ) : (
                            <>
                                <p className="text-sm text-muted-foreground">
                                    同步默认关闭。只有你主动打开向导、保存恢复密钥并最终确认后，NexusPilot 才会生成并启用同步密钥。
                                </p>
                                <div>
                                    <Button
                                        disabled={!canEnroll || loading}
                                        onClick={() => setSetupOpen(true)}
                                    >
                                        <LockKeyholeIcon data-icon="inline-start" />
                                        启用加密同步
                                    </Button>
                                </div>
                            </>
                        )}
                        {!syncEnabled && !cloudInitialized && !canEnroll ? (
                            <p className="text-xs text-muted-foreground">
                                {context.localSync.status !== "disabled"
                                    ? "本机同步密钥状态需要检查，暂时无法启用同步。"
                                    : entitled
                                    ? "当前订阅生命周期或设备额度暂不允许注册新设备。"
                                    : "当前订阅暂不包含连接同步。"}
                            </p>
                        ) : null}
                    </div>
                ) : refreshTimedOut || error ? (
                    <p className="rounded-md border px-3 py-3 text-sm text-muted-foreground">
                        Cloud 状态准备好后，这里会显示同步状态。
                    </p>
                ) : (
                    <div className="flex flex-col gap-3">
                        <Skeleton className="h-5 w-48" />
                        <Skeleton className="h-16 w-full" />
                        <Skeleton className="h-9 w-32" />
                    </div>
                )}
            </SettingsSection>

            {error && context ? (
                <Alert variant="destructive">
                    <AlertTitle>Cloud 状态刷新失败</AlertTitle>
                    <AlertDescription>{error.message}</AlertDescription>
                </Alert>
            ) : null}

            {context ? (
                <EnableCloudSyncDialog
                    open={setupOpen}
                    suggestedDeviceName={context.suggestedDeviceName}
                    onOpenChange={setSetupOpen}
                    onEnabled={handleEnabled}
                />
            ) : null}
        </div>
    );
}

function CloudAccountDetails({ context }: { context: CloudSyncSetupContext }) {
    const { subscription, connectionSync } = context;
    return (
        <Card size="sm">
            <CardHeader>
                <CardTitle>NexusPilot Cloud</CardTitle>
                <CardDescription>
                    当前订阅：{formatPlan(subscription.planCode)}
                </CardDescription>
                <CardAction>
                    <Badge variant={context.account.status === "active" ? "secondary" : "outline"}>
                        {formatAccountStatus(context.account.status)}
                    </Badge>
                </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-3 text-sm">
                    <InfoItem label="订阅状态" value={formatSubscriptionStatus(subscription.status)} />
                    <InfoItem label="有效期至" value={formatSubscriptionEnd(subscription.currentPeriodEnd)} />
                </div>
                <UsageSummary connectionSync={connectionSync} />
            </CardContent>
        </Card>
    );
}

function InfoItem({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{label}</span>
            <span className="font-medium">{value}</span>
        </div>
    );
}

function UsageSummary({ connectionSync }: { connectionSync: CloudSyncSetupContext["connectionSync"] }) {
    const deviceLimit = connectionSync.limits.maxSyncDevices;
    const byteLimit = connectionSync.limits.maxEncryptedBytes;
    return (
        <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">连接同步用量</p>
            <div className="grid grid-cols-2 gap-4">
                <QuotaText
                    label="设备"
                    value={formatQuota(connectionSync.usage.activeSyncDevices, deviceLimit, "台")}
                />
                <QuotaText
                    label="存储用量"
                    value={formatByteQuota(connectionSync.usage.encryptedBytes, byteLimit)}
                    progress={quotaPercent(connectionSync.usage.encryptedBytes, byteLimit)}
                />
            </div>
        </div>
    );
}

function QuotaText({
    label,
    value,
    progress,
}: {
    label: string;
    value: string;
    progress?: number;
}) {
    return (
        <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">{label}</span>
            <span className="truncate text-sm font-medium tabular-nums">{value}</span>
            {progress !== undefined ? (
                <Progress value={progress} aria-label={`${label} ${value}`} />
            ) : null}
        </div>
    );
}

function CloudAccountSkeleton() {
    return (
        <Card size="sm">
            <CardHeader>
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-28" />
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-3">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                </div>
                <Skeleton className="h-28 w-full" />
            </CardContent>
        </Card>
    );
}

function CloudUnavailablePlaceholder() {
    return (
        <div className="rounded-md border px-3 py-3 text-sm text-muted-foreground">
            Cloud 状态暂时无法读取，请稍后重试。
        </div>
    );
}

function formatPlan(planCode: string): string {
    return planCode ? planCode[0].toLocaleUpperCase() + planCode.slice(1) : "—";
}

function formatAccountStatus(status: string): string {
    if (status === "active") return "账户正常";
    if (status === "suspended") return "账户已暂停";
    return "账户不可用";
}

function formatSubscriptionStatus(status: string): string {
    if (status === "active") return "有效";
    if (status === "trialing") return "试用中";
    if (status === "past_due") return "待处理";
    if (status === "expired" || status === "canceled") return "已结束";
    return status || "—";
}

function formatSubscriptionEnd(value: string | null): string {
    if (!value) return "长期有效";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function quotaPercent(used: number, limit: number): number {
    if (limit <= 0) return 0;
    return Math.min(100, Math.round((used / limit) * 100));
}

function formatQuota(used: number, limit: number, unit: string): string {
    return limit > 0 ? `${used} / ${limit} ${unit}` : "暂不可用";
}

function formatByteQuota(used: number, limit: number): string {
    return limit > 0 ? `${formatBytes(used)} / ${formatBytes(limit)}` : "暂不可用";
}

function formatBytes(value: number): string {
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
