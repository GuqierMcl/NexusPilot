import {
    CloudIcon,
    LockKeyholeIcon,
    RefreshCwIcon,
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
import { SettingsSection } from "@/features/settings/components/settings-section";
import { useCloudSetupContext } from "@/features/settings/cloud-context";
import {
    formatAccountStatus,
    formatByteQuota,
    formatPlan,
    formatQuota,
    formatSubscriptionEnd,
    quotaPercent,
} from "@/features/settings/cloud-display";
import type { SettingsPanelProps } from "@/features/settings/settings-sections";
import type { CloudSyncSetupContext } from "@/types/ipc";

export function CloudOverviewPanel({ onNavigate }: SettingsPanelProps) {
    const { authenticated, context, refreshTimedOut, error, refresh } = useCloudSetupContext();

    if (!authenticated) {
        return (
            <SettingsSection title="Cloud 账户" description="查看你的 Cloud 账户、订阅和可用能力。">
                <Alert>
                    <CloudIcon />
                    <AlertTitle>请先登录 NIEEX Account</AlertTitle>
                    <AlertDescription>
                        登录后可以查看 Cloud 账户信息和订阅状态。
                    </AlertDescription>
                </Alert>
            </SettingsSection>
        );
    }

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

            <SettingsSection title="Cloud 账户" description="查看你的账户、订阅和 Cloud 使用情况。">
                {context ? <CloudAccountOverview context={context} /> : refreshTimedOut || error ? <CloudUnavailablePlaceholder /> : <CloudAccountSkeleton />}
            </SettingsSection>

            <SettingsSection title="Cloud 能力" description="查看当前可用的 Cloud 能力。">
                {context ? (
                    <Card size="sm">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <LockKeyholeIcon />
                                端到端加密同步
                            </CardTitle>
                            <CardDescription>
                                在你的设备之间安全同步已选择的内容。
                            </CardDescription>
                            <CardAction>
                                <Badge variant={context.connectionSync.permissions.readEncryptedAssets ? "secondary" : "outline"}>
                                    {context.connectionSync.permissions.readEncryptedAssets ? "可用" : "暂不可用"}
                                </Badge>
                            </CardAction>
                        </CardHeader>
                        <CardContent className="flex items-center justify-between gap-3">
                            <p className="text-sm text-muted-foreground">
                                {context.sync.initialized ? "同步已在本账户中启用。" : "同步尚未启用。"}
                            </p>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => onNavigate?.("sync-security")}
                            >
                                管理同步与安全
                            </Button>
                        </CardContent>
                    </Card>
                ) : refreshTimedOut || error ? (
                    <p className="rounded-md border px-3 py-3 text-sm text-muted-foreground">
                        Cloud 状态准备好后，这里会显示可用能力。
                    </p>
                ) : <Skeleton className="h-24 w-full" />}
            </SettingsSection>
        </div>
    );
}

function CloudAccountOverview({ context }: { context: CloudSyncSetupContext }) {
    const { subscription, connectionSync } = context;
    const canReadUsage = context.source === "cloud" || context.source === "cache";
    return (
        <Card size="sm">
            <CardHeader>
                <CardTitle>NexusPilot Cloud</CardTitle>
                <CardDescription>
                    当前订阅 · <span className="font-semibold text-foreground">{formatPlan(subscription.planCode)}</span>
                </CardDescription>
                {context.account.status !== "active" ? (
                    <CardAction>
                        <Badge variant="outline">{formatAccountStatus(context.account.status)}</Badge>
                    </CardAction>
                ) : null}
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-xs">
                <div className="grid grid-cols-2 gap-2">
                    <InfoItem label="订阅状态" value={formatSubscriptionStatus(subscription.status)} />
                    <InfoItem label="有效期至" value={formatSubscriptionEnd(subscription.currentPeriodEnd)} />
                </div>
                {canReadUsage ? <UsageSummary connectionSync={connectionSync} /> : <Skeleton className="h-16 w-full" />}
            </CardContent>
        </Card>
    );
}

function UsageSummary({ connectionSync }: { connectionSync: CloudSyncSetupContext["connectionSync"] }) {
    return (
        <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-3">
                <InfoItem
                    label="设备"
                    value={formatQuota(
                        connectionSync.usage.activeSyncDevices,
                        connectionSync.limits.maxSyncDevices,
                        "台",
                    )}
                />
                <div className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-xs text-muted-foreground">存储用量</span>
                    <span className="truncate text-sm font-medium tabular-nums">
                        {formatByteQuota(
                            connectionSync.usage.encryptedBytes,
                            connectionSync.limits.maxEncryptedBytes,
                        )}
                    </span>
                    <Progress
                        value={quotaPercent(
                            connectionSync.usage.encryptedBytes,
                            connectionSync.limits.maxEncryptedBytes,
                        )}
                        aria-label="存储用量"
                    />
                </div>
            </div>
        </div>
    );
}

function InfoItem({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">{label}</span>
            <span className="font-medium">{value}</span>
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
                <Skeleton className="h-16 w-full" />
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

function formatSubscriptionStatus(status: string): string {
    if (status === "active") return "有效";
    if (status === "trialing") return "试用中";
    if (status === "past_due") return "待处理";
    if (status === "expired" || status === "canceled") return "已结束";
    return status || "—";
}
