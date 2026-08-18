import { useEffect, useState, type FC } from "react";
import {
    CircleAlertIcon,
    CloudCheckIcon,
    CloudIcon,
    CloudOffIcon,
    ExternalLinkIcon,
    LogInIcon,
    LogOutIcon,
    RefreshCwIcon,
    ShieldCheckIcon,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import {
    Alert,
    AlertDescription,
    AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { PixelCard } from "@/components/ui/pixel-card";
import { toCloudError, useCloudDesktopState } from "@/features/settings/cloud-context";
import type {
    AuthSessionSnapshot,
    AuthUser,
    CloudPublicError,
    CloudConnectionPhase,
    CloudSyncSetupContext,
} from "@/types/ipc";

import { AccountAvatar } from "./account-avatar";

const ACCOUNT_PROFILE_URL = "https://auth.nieex.com/account/profile";

interface AccountCardProps {
    active: boolean;
    snapshot: AuthSessionSnapshot;
    onStartSignIn: () => void;
    onCancelSignIn: () => void;
    onRetrySession: () => void;
    onSignOut: () => void;
    onCloudSettingsRequested?: () => void;
}

function displayName(user: AuthUser): string {
    return user.displayName ?? user.handle ?? user.email ?? "NIEEX 用户";
}

function displayHandle(handle: string | null): string | null {
    if (!handle) {
        return null;
    }
    return handle.startsWith("@") ? handle : `@${handle}`;
}

export function userInitials(user: AuthUser | null): string {
    if (!user) {
        return "NP";
    }

    const source = displayName(user).trim();
    return Array.from(source)[0]?.toLocaleUpperCase() ?? "NP";
}

const LocalWorkbenchNotice: FC = () => (
    <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <p>本地工作台始终无需登录，账号状态不会影响本地数据库功能。</p>
    </div>
);

const CloudLoginNotice: FC = () => (
    <div className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2.5 text-sm">
        <CloudIcon
            className="mt-0.5 size-4 shrink-0 text-primary"
            aria-hidden="true"
        />
        <div className="flex flex-col gap-0.5">
            <p className="font-medium text-foreground">NexusPilot Cloud</p>
            <p className="text-xs leading-5 text-muted-foreground">
                登录后可查看订阅和 Cloud 使用情况。
            </p>
        </div>
    </div>
);

const AccountCard: FC<AccountCardProps> = ({
    active,
    snapshot,
    onStartSignIn,
    onCancelSignIn,
    onRetrySession,
    onSignOut,
    onCloudSettingsRequested,
}) => {
    const isSigningIn = snapshot.operation === "signingIn";
    const isRefreshing = snapshot.operation === "refreshing";
    const isSigningOut = snapshot.operation === "signingOut";
    const authenticated = snapshot.phase === "authenticated" && Boolean(snapshot.user);
    const cloudAccountIdentity =
        authenticated && snapshot.user
            ? [snapshot.user.providerId, snapshot.user.issuer, snapshot.user.subject].join("\u0000")
            : null;
    const { state: desktopState, refresh: refreshCloud } = useCloudDesktopState();
    const cloudContext = desktopState?.context ?? null;
    const [cloudLoading, setCloudLoading] = useState(false);
    const [cloudRefreshTimedOut, setCloudRefreshTimedOut] = useState(false);
    const [cloudError, setCloudError] = useState<CloudPublicError | null>(null);

    useEffect(() => {
        if (
            desktopState?.context?.source === "cloud" &&
            desktopState.refresh.lastSucceededAt &&
            !desktopState.refresh.inFlight
        ) {
            // Another Cloud surface may have completed the shared refresh.
            // Do not leave this card showing an error from its previous request.
            setCloudError(null);
            setCloudRefreshTimedOut(false);
        }
    }, [desktopState?.context?.source, desktopState?.refresh.lastSucceededAt, desktopState?.refresh.inFlight]);

    useEffect(() => {
        if (!cloudAccountIdentity) {
            setCloudError(null);
            return;
        }
        if (!active) return;
        let cancelled = false;
        setCloudError(null);
        setCloudRefreshTimedOut(false);
        setCloudLoading(true);
        const timeout = window.setTimeout(() => {
            if (!cancelled) {
                setCloudLoading(false);
                setCloudRefreshTimedOut(true);
            }
        }, 5_000);
        void refreshCloud(true)
            .then(() => {
                if (!cancelled) {
                    setCloudError(null);
                }
            })
            .catch((error: unknown) => {
                console.error("[account] failed to load Cloud summary", error);
                if (!cancelled) setCloudError(toCloudError(error));
            })
            .finally(() => {
                window.clearTimeout(timeout);
                if (!cancelled) setCloudLoading(false);
            });
        return () => {
            cancelled = true;
            window.clearTimeout(timeout);
        };
    }, [active, cloudAccountIdentity, refreshCloud]);
    const openAccountCenter = (): void => {
        void openUrl(ACCOUNT_PROFILE_URL).catch((error: unknown) => {
            console.error("[account] failed to open account center", error);
        });
    };

    if (snapshot.phase === "restoring") {
        return (
            <div className="flex min-h-28 flex-col items-center justify-center gap-3 text-center">
                <Spinner className="size-5 text-muted-foreground" />
                <div className="flex flex-col gap-1">
                    <p className="font-medium">正在恢复 NIEEX Account 登录状态</p>
                    <p className="text-xs text-muted-foreground">
                        本地工作台可以继续正常使用。
                    </p>
                </div>
            </div>
        );
    }

    const errorNotice = snapshot.error ? (
        <Alert>
            <CircleAlertIcon />
            <AlertTitle>NIEEX Account 状态提示</AlertTitle>
            <AlertDescription>{snapshot.error.message}</AlertDescription>
        </Alert>
    ) : null;

    if (snapshot.phase === "authenticated" && snapshot.user) {
        const user = snapshot.user;
        const handle = displayHandle(user.handle);
        const sessionUnavailable =
            snapshot.providerAvailability === "temporarilyUnavailable" ||
            !snapshot.hasUsableAccessToken;

        return (
            <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3 px-1 py-0.5">
                    <AccountAvatar
                        user={user}
                        fallback={userInitials(user)}
                        size="lg"
                    />
                    <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{displayName(user)}</p>
                        {handle ? (
                            <p className="truncate text-xs text-muted-foreground">
                                {handle}
                            </p>
                        ) : null}
                        {user.email ? (
                            <p className="truncate text-xs text-muted-foreground">
                                {user.email}
                            </p>
                        ) : null}
                    </div>
                    <Button
                        className="h-7 shrink-0 px-2 text-xs text-muted-foreground"
                        variant="ghost"
                        size="sm"
                        disabled={isSigningOut}
                        onClick={openAccountCenter}
                    >
                        账户中心
                        <ExternalLinkIcon
                            className="size-3"
                            data-icon="inline-end"
                        />
                    </Button>
                </div>

                {isRefreshing || sessionUnavailable ? (
                    <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
                        {sessionUnavailable ? (
                            <CloudOffIcon className="size-3.5" aria-hidden="true" />
                        ) : (
                            <ShieldCheckIcon className="size-3.5" aria-hidden="true" />
                        )}
                        <span>
                            {isRefreshing
                                ? "正在恢复 NIEEX Account 长期登录会话…"
                                : "NIEEX Account 登录身份已保留，账号服务暂时不可用"}
                        </span>
                    </div>
                ) : null}

                {errorNotice}
                <Separator />
                <CloudAccountSummary
                    context={cloudContext}
                    connection={desktopState?.connection ?? null}
                    loading={cloudLoading}
                    timedOut={cloudRefreshTimedOut}
                    error={cloudError}
                />
                <LocalWorkbenchNotice />

                {sessionUnavailable ? (
                    <Button
                        className="w-full"
                        variant="outline"
                        size="sm"
                        disabled={isRefreshing || isSigningOut}
                        onClick={onRetrySession}
                    >
                        {isRefreshing ? (
                            <Spinner data-icon="inline-start" />
                        ) : (
                            <RefreshCwIcon data-icon="inline-start" />
                        )}
                        重试恢复
                    </Button>
                ) : null}

                <div className="flex gap-2">
                    {onCloudSettingsRequested ? (
                        <Button
                            className="flex-1"
                            variant="ghost"
                            size="sm"
                            disabled={isRefreshing || isSigningOut}
                            onClick={onCloudSettingsRequested}
                        >
                            <CloudIcon data-icon="inline-start" />
                            Cloud 设置
                        </Button>
                    ) : null}
                    <Button
                        className="flex-1"
                        variant="outline"
                        size="sm"
                        disabled={isRefreshing || isSigningOut}
                        onClick={onSignOut}
                    >
                        {isSigningOut ? (
                            <Spinner data-icon="inline-start" />
                        ) : (
                            <LogOutIcon data-icon="inline-start" />
                        )}
                        {isSigningOut ? "正在退出" : "退出登录"}
                    </Button>
                </div>
            </div>
        );
    }

    const loginUnavailable =
        snapshot.error?.code === "AUTH_CONFIG_INVALID" ||
        snapshot.error?.code === "AUTH_PROVIDER_UNSUPPORTED";
    const needsReauthentication =
        snapshot.phase === "reauthenticationRequired";

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1 px-1">
                <p className="font-medium">
                    {needsReauthentication
                        ? "需要重新登录 NIEEX Account"
                        : "登录 NIEEX Account"}
                </p>
                <p className="text-xs text-muted-foreground">
                    {needsReauthentication
                        ? "请重新登录 NIEEX Account 以继续使用账号能力。"
                        : "使用统一的 NIEEX Account 登录 NexusPilot。"}
                </p>
            </div>

            {errorNotice}
            <CloudLoginNotice />
            <LocalWorkbenchNotice />

            {isSigningIn ? (
                <div className="flex flex-col gap-2">
                    <Button onClick={onStartSignIn}>
                        <LogInIcon data-icon="inline-start" />
                        重新打开登录页
                    </Button>
                    <Button variant="outline" size="sm" onClick={onCancelSignIn}>
                        取消本次登录
                    </Button>
                    <p className="text-center text-xs text-muted-foreground">
                        请在系统浏览器中完成 NIEEX Account 登录，随后会自动返回 NexusPilot。
                    </p>
                </div>
            ) : (
                <Button disabled={loginUnavailable} onClick={onStartSignIn}>
                    <LogInIcon data-icon="inline-start" />
                    {needsReauthentication ? "重新登录" : "立即登录"}
                </Button>
            )}
        </div>
    );
};

export { AccountCard };

function CloudAccountSummary({
    context,
    connection,
    loading,
    timedOut,
    error,
}: {
    context: CloudSyncSetupContext | null;
    connection: CloudConnectionPhase | null;
    loading: boolean;
    timedOut: boolean;
    error: CloudPublicError | null;
}) {
    if (loading && !context) {
        return (
            <div className="flex flex-col gap-2 rounded-md border p-3">
                <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium">NexusPilot Cloud</span>
                    <CloudStatusSlot connection={connection} context={context} loading={loading} timedOut={timedOut} error={error} />
                </div>
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-full" />
            </div>
        );
    }

    if (!context) {
        return (
            <div className="rounded-md border px-3 py-2.5 text-xs text-muted-foreground">
                <div className="flex items-center justify-between gap-3">
                    <span>Cloud 使用情况暂时无法读取。</span>
                    <CloudStatusSlot connection={connection} context={context} loading={loading} timedOut={timedOut} error={error} />
                </div>
            </div>
        );
    }

    const { subscription, connectionSync } = context;
    const normalizedPlanCode = subscription.planCode.trim().toLocaleLowerCase();
    const isPaidSubscription = normalizedPlanCode !== "free";
    const pixelVariant = subscriptionPixelVariant(normalizedPlanCode);
    const content = (
        <>
            <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                    <span>NexusPilot Cloud</span>
                </span>
                <CloudStatusSlot connection={connection} context={context} loading={loading} timedOut={timedOut} error={error} />
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
                <SummaryItem label="当前订阅" value={formatPlan(subscription.planCode)} />
                <SummaryItem label="有效期至" value={formatSubscriptionEnd(subscription.currentPeriodEnd)} />
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
                <SummaryItem
                    label="设备"
                    value={formatQuota(connectionSync.usage.activeSyncDevices, connectionSync.limits.maxSyncDevices, "台")}
                />
                <div className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-muted-foreground">存储用量</span>
                    <div className="flex min-w-0 items-baseline justify-between gap-2 font-medium tabular-nums">
                        <span className="truncate">
                            {formatByteQuota(connectionSync.usage.encryptedBytes, connectionSync.limits.maxEncryptedBytes)}
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                            {formatQuotaPercent(
                                connectionSync.usage.encryptedBytes,
                                connectionSync.limits.maxEncryptedBytes,
                            )}
                        </span>
                    </div>
                    <Progress
                        value={quotaPercent(
                            connectionSync.usage.encryptedBytes,
                            connectionSync.limits.maxEncryptedBytes,
                        )}
                        aria-label="连接同步存储用量"
                    />
                </div>
            </div>
        </>
    );

    const cardClassName = "flex flex-col gap-3 rounded-md border bg-card/90 p-3";
    return (
        isPaidSubscription ? (
            <PixelCard
                className={cardClassName}
                variant={pixelVariant}
                gap={pixelVariant === "blue" ? 4 : undefined}
            >
                {content}
            </PixelCard>
        ) : (
            <div className={cardClassName}>{content}</div>
        )
    );
}

function subscriptionPixelVariant(planCode: string): "blue" | "yellow" | "default" {
    if (planCode === "plus") return "blue";
    if (planCode === "pro") return "yellow";
    return "default";
}

function CloudStatusSlot({
    connection,
    context,
    loading,
    timedOut,
    error,
}: {
    connection: CloudConnectionPhase | null;
    context: CloudSyncSetupContext | null;
    loading: boolean;
    timedOut: boolean;
    error: CloudPublicError | null;
}) {
    if (loading || (!timedOut && (connection === "refreshing" || connection === "needs_refresh"))) {
        return (
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <Spinner className="size-3.5" aria-hidden="true" />
                连接中
            </span>
        );
    }
    if (connection === "permission_denied" || error?.code === "CLOUD_INSUFFICIENT_SCOPE") {
        return (
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <CircleAlertIcon className="size-3.5" aria-hidden="true" />
                无访问权限
            </span>
        );
    }
    if (connection === "reauthentication_required") {
        return (
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <CircleAlertIcon className="size-3.5" aria-hidden="true" />
                需要重新登录
            </span>
        );
    }
    if (error || connection === "unavailable") {
        return (
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                {context ? (
                    <CloudOffIcon className="size-3.5" aria-hidden="true" />
                ) : (
                    <CircleAlertIcon className="size-3.5" aria-hidden="true" />
                )}
                {context ? "暂时离线" : "暂不可用"}
            </span>
        );
    }
    if (context?.source === "cache") {
        return (
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <CloudOffIcon className="size-3.5" aria-hidden="true" />
                暂时离线
            </span>
        );
    }
    if (context) {
        return (
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <CloudCheckIcon className="size-3.5" aria-hidden="true" />
                已连接
            </span>
        );
    }
    return null;
}

function SummaryItem({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{label}</span>
            <span className="font-medium">{value}</span>
        </div>
    );
}

function formatPlan(planCode: string): string {
    return planCode ? planCode[0].toLocaleUpperCase() + planCode.slice(1) : "—";
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

function formatQuotaPercent(used: number, limit: number): string {
    if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return "—";
    return `${new Intl.NumberFormat("zh-CN", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
    }).format(Math.max(0, (used / limit) * 100))}%`;
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
