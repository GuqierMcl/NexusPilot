import { useEffect, useRef, useState } from "react";
import {
    CheckCircle2Icon,
    CopyIcon,
    LaptopIcon,
    FileKeyIcon,
    LockKeyholeIcon,
    PauseIcon,
    PlayIcon,
    RefreshCwIcon,
    RotateCcwKeyIcon,
    ShieldOffIcon,
    SmartphoneIcon,
    Trash2Icon,
    UserPlusIcon,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { SettingsSection } from "@/features/settings/components/settings-section";
import { useCloudSetupContext, toCloudError } from "@/features/settings/cloud-context";
import { formatSyncPhase } from "@/features/settings/cloud-display";
import {
    approveDeviceAuthorization,
    beginDeviceAuthorization,
    cancelDeviceAuthorization,
    claimDeviceAuthorization,
    completeCloudSyncLocalDependency,
    copyRotatedRecoveryKey,
    listCloudSyncLocalDependencies,
    listCloudSyncConflicts,
    rotateCloudRecoveryKey,
    saveRotatedRecoveryKey,
    deleteCloudSyncData,
    getPendingDeviceAuthorization,
    resolveCloudSyncConflict,
    listPendingDeviceAuthorizations,
    recoverCloudDeviceWithRecoveryKey,
    rejectDeviceAuthorization,
    revokeLocalSyncDevice,
    setLocalSyncPaused,
    syncCloudNow,
} from "@/lib/tauri/cloud";
import type {
    BeginDeviceAuthorizationResult,
    CloudDeviceAuthorization,
    CloudPendingDeviceAuthorizationList,
    CloudPublicError,
    CloudLocalDependency,
    CloudLocalDependencyList,
    CloudSyncConflictView,
    PendingDeviceAuthorizationStatus,
} from "@/types/ipc";
import type { SettingsPanelProps } from "@/features/settings/settings-sections";

import { EnableCloudSyncDialog } from "./enable-cloud-sync-dialog";

type Operation = "idle" | "syncing" | "pausing" | "authorizing" | "claiming" | "recovering" | "revoking";
type DeviceAuthorizationProgress = BeginDeviceAuthorizationResult | PendingDeviceAuthorizationStatus;
const AUXILIARY_REFRESH_TIMEOUT_MS = 5_000;
const DEVICE_AUTHORIZATION_POLL_INTERVAL_MS = 3_000;

export function SyncSecurityPanel(_props: SettingsPanelProps) {
    const { authenticated, context, loading, refreshTimedOut, refreshing, error, runtime, refresh } = useCloudSetupContext();
    const [operation, setOperation] = useState<Operation>("idle");
    const [setupOpen, setSetupOpen] = useState(false);
    const [newDeviceOpen, setNewDeviceOpen] = useState(false);
    const [recoveryOpen, setRecoveryOpen] = useState(false);
    const [revokeOpen, setRevokeOpen] = useState(false);
    const [rotateOpen, setRotateOpen] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [rotatedKey, setRotatedKey] = useState<string | null>(null);
    const [rotationId, setRotationId] = useState<string | null>(null);
    const [pending, setPending] = useState<CloudPendingDeviceAuthorizationList | null>(null);
    const [pendingLoading, setPendingLoading] = useState(false);
    const [pendingTimedOut, setPendingTimedOut] = useState(false);
    const [pendingError, setPendingError] = useState<CloudPublicError | null>(null);
    const [authorization, setAuthorization] = useState<DeviceAuthorizationProgress | null>(null);
    const [dependencies, setDependencies] = useState<CloudLocalDependencyList | null>(null);
    const [dependenciesLoading, setDependenciesLoading] = useState(false);
    const [dependenciesError, setDependenciesError] = useState<CloudPublicError | null>(null);
    const [conflicts, setConflicts] = useState<CloudSyncConflictView[]>([]);
    const [conflictsLoading, setConflictsLoading] = useState(false);
    const [conflictsError, setConflictsError] = useState<CloudPublicError | null>(null);
    const pendingRequestGeneration = useRef(0);
    const dependenciesRequestGeneration = useRef(0);
    const conflictsRequestGeneration = useRef(0);
    const authorizationRequestGeneration = useRef(0);

    const cloudReady = context?.source === "cloud" && !loading && !refreshing && !error;
    const hasLocalDeviceAccess =
        context?.localSync.status === "ready" || context?.localSync.status === "paused";


    const loadPending = async (): Promise<void> => {
        if (!cloudReady || !context?.sync.initialized || !hasLocalDeviceAccess) return;
        const generation = ++pendingRequestGeneration.current;
        setPendingLoading(true);
        setPendingTimedOut(false);
        setPendingError(null);
        const timeout = window.setTimeout(() => {
            if (generation === pendingRequestGeneration.current) {
                setPendingLoading(false);
                setPendingTimedOut(true);
            }
        }, AUXILIARY_REFRESH_TIMEOUT_MS);
        try {
            const nextPending = await listPendingDeviceAuthorizations();
            if (generation === pendingRequestGeneration.current) {
                setPending(nextPending);
                setPendingTimedOut(false);
                setPendingError(null);
            }
        } catch (pendingLoadError: unknown) {
            console.error("[cloud-sync] pending device authorization failed", pendingLoadError);
            if (generation === pendingRequestGeneration.current) {
                setPendingTimedOut(false);
                setPendingError(toCloudError(pendingLoadError));
            }
        } finally {
            window.clearTimeout(timeout);
            if (generation === pendingRequestGeneration.current) {
                setPendingLoading(false);
            }
        }
    };

    useEffect(() => {
        if (cloudReady && context?.sync.initialized && hasLocalDeviceAccess) {
            void loadPending();
        } else {
            pendingRequestGeneration.current += 1;
            setPendingLoading(false);
            setPending(null);
            setPendingTimedOut(false);
            setPendingError(null);
        }
        // Loading the pending list is intentionally tied to entering this page,
        // not to a background push or permanent polling loop.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cloudReady, context?.sync.initialized, hasLocalDeviceAccess, context?.account.id]);

    const handleEnabled = async (): Promise<void> => {
        await refresh();
    };

    const loadCurrentDeviceAuthorization = async ({ open = false }: { open?: boolean } = {}): Promise<void> => {
        if (!cloudReady || !context?.sync.initialized || hasLocalDeviceAccess) return;
        const generation = ++authorizationRequestGeneration.current;
        try {
            const nextAuthorization = await getPendingDeviceAuthorization();
            if (generation === authorizationRequestGeneration.current) {
                setAuthorization(nextAuthorization);
                if (nextAuthorization && open) setNewDeviceOpen(true);
            }
        } catch (authorizationLoadError: unknown) {
            console.error("[cloud-sync] pending local device authorization failed", authorizationLoadError);
            if (generation === authorizationRequestGeneration.current) {
                toast.error(toCloudError(authorizationLoadError).message);
            }
        }
    };

    const handleClaimDeviceAuthorization = async (): Promise<void> => {
        if (!authorization || operation !== "idle") return;
        setOperation("claiming");
        try {
            await claimDeviceAuthorization();
            setAuthorization(null);
            setNewDeviceOpen(false);
            await refresh();
            toast.success("设备授权已完成，正在同步 Cloud 数据");
        } catch (claimError: unknown) {
            console.error("[cloud-sync] device authorization claim failed", claimError);
            toast.error(toCloudError(claimError).message);
            await loadCurrentDeviceAuthorization();
        } finally {
            setOperation("idle");
        }
    };

    useEffect(() => {
        if (!cloudReady || !context?.sync.initialized || hasLocalDeviceAccess) {
            authorizationRequestGeneration.current += 1;
            return;
        }
        void loadCurrentDeviceAuthorization({ open: true });
        // A pending request is local key material. Read it once when entering the
        // device-management surface so a restarted app can resume the request.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cloudReady, context?.account.id, context?.sync.initialized, hasLocalDeviceAccess]);

    useEffect(() => {
        if (!newDeviceOpen || authorization?.status !== "pending" || !cloudReady) return;
        const poll = window.setInterval(() => {
            void loadCurrentDeviceAuthorization();
        }, DEVICE_AUTHORIZATION_POLL_INTERVAL_MS);
        return () => window.clearInterval(poll);
        // Polling only exists while the requester keeps its authorization dialog open.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [authorization?.requestId, authorization?.status, cloudReady, newDeviceOpen]);

    useEffect(() => {
        if (newDeviceOpen && authorization?.status === "approved" && operation === "idle") {
            void handleClaimDeviceAuthorization();
        }
        // Claiming is deliberately driven from the requester-side status transition.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [authorization?.requestId, authorization?.status, newDeviceOpen, operation]);

    const loadDependencies = async (): Promise<void> => {
        if (!cloudReady || !context?.sync.initialized) return;
        const generation = ++dependenciesRequestGeneration.current;
        setDependenciesLoading(true);
        setDependenciesError(null);
        const timeout = window.setTimeout(() => {
            if (generation === dependenciesRequestGeneration.current) {
                setDependenciesLoading(false);
            }
        }, AUXILIARY_REFRESH_TIMEOUT_MS);
        try {
            const nextDependencies = await listCloudSyncLocalDependencies();
            if (generation === dependenciesRequestGeneration.current) {
                setDependencies(nextDependencies);
                setDependenciesError(null);
            }
        } catch (dependencyError: unknown) {
            console.error("[cloud-sync] local dependencies failed", dependencyError);
            if (generation === dependenciesRequestGeneration.current) {
                setDependenciesError(toCloudError(dependencyError));
            }
        } finally {
            window.clearTimeout(timeout);
            if (generation === dependenciesRequestGeneration.current) {
                setDependenciesLoading(false);
            }
        }
    };

    const loadConflicts = async (): Promise<void> => {
        if (!cloudReady || !context?.sync.initialized) return;
        const generation = ++conflictsRequestGeneration.current;
        setConflictsLoading(true);
        setConflictsError(null);
        const timeout = window.setTimeout(() => {
            if (generation === conflictsRequestGeneration.current) {
                setConflictsLoading(false);
            }
        }, AUXILIARY_REFRESH_TIMEOUT_MS);
        try {
            const nextConflicts = await listCloudSyncConflicts();
            if (generation === conflictsRequestGeneration.current) {
                setConflicts(nextConflicts);
                setConflictsError(null);
            }
        } catch (conflictError: unknown) {
            console.error("[cloud-sync] conflicts failed", conflictError);
            if (generation === conflictsRequestGeneration.current) {
                setConflictsError(toCloudError(conflictError));
            }
        } finally {
            window.clearTimeout(timeout);
            if (generation === conflictsRequestGeneration.current) {
                setConflictsLoading(false);
            }
        }
    };

    useEffect(() => {
        if (cloudReady && context?.sync.initialized) void loadDependencies();
        else {
            dependenciesRequestGeneration.current += 1;
            setDependenciesLoading(false);
            setDependencies(null);
            setDependenciesError(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cloudReady, context?.account.id, context?.sync.initialized]);

    useEffect(() => {
        if (cloudReady && context?.sync.initialized) void loadConflicts();
        else {
            conflictsRequestGeneration.current += 1;
            setConflictsLoading(false);
            setConflicts([]);
            setConflictsError(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cloudReady, context?.account.id, context?.sync.initialized, runtime?.conflicts]);

    const handleSyncNow = async (): Promise<void> => {
        setOperation("syncing");
        try {
            const result = await syncCloudNow();
            toast.success("同步已完成", {
                description: `上传 ${result.uploaded} 项，更新 ${result.pulled} 项。`,
            });
            await refresh();
        } catch (syncError: unknown) {
            console.error("[cloud-sync] manual sync failed", syncError);
            toast.error(toCloudError(syncError).message);
        } finally {
            setOperation("idle");
        }
    };

    const handlePauseChange = async (paused: boolean): Promise<void> => {
        if (!context) return;
        setOperation("pausing");
        try {
            await setLocalSyncPaused(context.account.id, paused);
            await refresh();
            toast.success(paused ? "同步已暂停" : "同步已恢复");
        } catch (pauseError: unknown) {
            console.error("[cloud-sync] pause state change failed", pauseError);
            toast.error(toCloudError(pauseError).message);
        } finally {
            setOperation("idle");
        }
    };

    const handleRevoke = async (): Promise<void> => {
        setOperation("revoking");
        try {
            await revokeLocalSyncDevice();
            await refresh();
            toast.success("本设备已永久撤销");
        } catch (revokeError: unknown) {
            console.error("[cloud-sync] revoke device failed", revokeError);
            toast.error(toCloudError(revokeError).message);
        } finally {
            setOperation("idle");
            setRevokeOpen(false);
        }
    };

    if (!authenticated) {
        return (
            <SettingsSection title="同步与安全" description="管理同步、设备和恢复方式。">
                <Alert>
                    <ShieldOffIcon />
                    <AlertTitle>请先登录 NIEEX Account</AlertTitle>
                    <AlertDescription>登录后可以管理同步和设备安全。</AlertDescription>
                </Alert>
            </SettingsSection>
        );
    }

    if (!context) {
        return (
            <div className="flex flex-col gap-6">
                {error || refreshTimedOut ? (
                    <Alert variant={error ? "destructive" : "default"}>
                        <AlertTitle>暂时无法读取同步状态</AlertTitle>
                        <AlertDescription>
                            {error?.message ?? "Cloud 状态加载时间较长，请点击重试。"}
                        </AlertDescription>
                        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void refresh()}>
                            <RefreshCwIcon data-icon="inline-start" />
                            重试
                        </Button>
                    </Alert>
                ) : null}
                {!refreshTimedOut && !error ? (
                    <>
                        <SettingsSection title="同步状态" description="查看同步是否正在运行。">
                            <Skeleton className="h-28 w-full" />
                        </SettingsSection>
                        <SettingsSection title="设备与恢复" description="管理已授权设备和恢复方式。">
                            <Skeleton className="h-36 w-full" />
                        </SettingsSection>
                    </>
                ) : null}
            </div>
        );
    }

    const syncReady = context.sync.initialized && context.localSync.status === "ready";
    const syncPaused = context.localSync.status === "paused";
    const canEnable =
        context.source === "cloud" &&
        context.connectionSync.permissions.enrollSyncDevice &&
        context.localSync.status === "disabled";
    const canBeginDeviceAuthorization =
        context.source === "cloud" &&
        context.sync.initialized &&
        context.connectionSync.permissions.enrollSyncDevice &&
        context.localSync.status === "disabled" &&
        context.sync.activeDeviceCount < context.connectionSync.limits.maxSyncDevices;
    const runtimePhase = runtime?.phase ?? (syncPaused ? "paused" : syncReady ? "idle" : "disabled");
    const currentDevice = context.devices?.find((device) => device.status === "active");
    const authorizedDeviceCount = context.devices?.length ?? context.sync.activeDeviceCount;

    return (
        <div className="flex flex-col gap-6">
            <SettingsSection title="同步状态" description="控制本机同步，并查看最近一次同步情况。">
                <Card size="sm">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            {runtimePhase === "syncing" ? <Spinner /> : syncReady ? <CheckCircle2Icon /> : <LockKeyholeIcon />}
                            {formatSyncPhase(runtimePhase)}
                        </CardTitle>
                        <CardDescription>
                            {syncReady ? "你的连接数据会在已授权设备之间进行端到端加密同步。" : "同步尚未在本设备运行。"}
                        </CardDescription>
                        <CardAction>
                            <Badge variant={syncReady ? "secondary" : "outline"}>{syncReady ? "已启用" : "未启用"}</Badge>
                        </CardAction>
                    </CardHeader>
                    <CardContent className="flex flex-wrap items-center gap-2">
                        {syncReady || syncPaused ? (
                            <Button type="button" variant="outline" size="sm" disabled={operation !== "idle"} onClick={() => void handleSyncNow()}>
                                {operation === "syncing" ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
                                立即同步
                            </Button>
                        ) : null}
                        {syncReady ? (
                            <Button type="button" variant="outline" size="sm" disabled={operation !== "idle"} onClick={() => void handlePauseChange(true)}>
                                {operation === "pausing" ? <Spinner data-icon="inline-start" /> : <PauseIcon data-icon="inline-start" />}
                                暂停同步
                            </Button>
                        ) : null}
                        {syncPaused ? (
                            <Button type="button" variant="outline" size="sm" disabled={operation !== "idle"} onClick={() => void handlePauseChange(false)}>
                                {operation === "pausing" ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
                                恢复同步
                            </Button>
                        ) : null}
                        {!context.sync.initialized && canEnable ? (
                            <Button type="button" size="sm" onClick={() => setSetupOpen(true)}>
                                <LockKeyholeIcon data-icon="inline-start" />
                                启用加密同步
                            </Button>
                        ) : null}
                    </CardContent>
                </Card>
            </SettingsSection>

            <SettingsSection title="设备" description="管理可以访问同步数据的设备。">
                <Card size="sm">
                    <CardHeader>
                        <CardTitle>已授权设备</CardTitle>
                        <CardDescription>
                            {authorizedDeviceCount} 台设备{currentDevice ? ` · 当前设备：${currentDevice.displayName}` : ""}
                        </CardDescription>
                        <CardAction>
                            <Button type="button" variant="outline" size="sm" disabled={!canBeginDeviceAuthorization || operation !== "idle"} onClick={() => setNewDeviceOpen(true)}>
                                <UserPlusIcon data-icon="inline-start" />
                                添加新设备
                            </Button>
                        </CardAction>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-2">
                        {authorization ? (
                            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2 text-sm">
                                <div>
                                    <p className="m-0 font-medium">本设备的授权请求{authorization.status === "approved" ? "已获批准" : "等待批准"}</p>
                                    <p className="mt-1 mb-0 text-muted-foreground">{authorization.deviceName} · 请求有效期至 {formatDeviceDate(authorization.expiresAt)}</p>
                                </div>
                                <Button type="button" variant="outline" size="sm" onClick={() => setNewDeviceOpen(true)}>
                                    {authorization.status === "approved" ? "完成授权" : "查看请求"}
                                </Button>
                            </div>
                        ) : null}
                        {context.devices === null ? (
                            <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                                <p className="m-0 font-medium">
                                    {hasLocalDeviceAccess ? "设备详情暂时不可用" : "本设备尚未获得同步访问权限"}
                                </p>
                                <p className="mt-1 mb-0 text-muted-foreground">
                                    {hasLocalDeviceAccess
                                        ? "请稍后刷新；设备详情只会展示给已授权设备。"
                                        : canBeginDeviceAuthorization
                                          ? `Cloud 账户已有 ${authorizedDeviceCount} 台已授权设备。请生成验证码并在其中一台设备上批准。`
                                          : "设备详情只会展示给已授权设备。请使用恢复密钥恢复访问，或检查订阅权益与设备数量。"}
                                </p>
                            </div>
                        ) : context.devices.length ? context.devices.map((device) => (
                            <div key={device.id} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
                                <div className="flex min-w-0 items-center gap-2">
                                    {device.displayName.toLocaleLowerCase().includes("phone") ? <SmartphoneIcon /> : <LaptopIcon />}
                                    <div className="flex min-w-0 flex-col gap-0.5">
                                        <span className="truncate font-medium">{device.displayName}</span>
                                        <span className="text-xs text-muted-foreground">{device.status === "active" ? "已授权" : device.status === "revoked" ? "已撤销" : "等待启用"}</span>
                                    </div>
                                </div>
                                <span className="shrink-0 text-xs text-muted-foreground">{formatDeviceDate(device.lastSeenAt ?? device.registeredAt)}</span>
                            </div>
                        )) : <p className="text-sm text-muted-foreground">暂时没有已授权设备。</p>}
                    </CardContent>
                </Card>
            </SettingsSection>

            {dependenciesLoading || dependenciesError || dependencies?.items.length ? (
                <SettingsSection title="本地文件" description="为需要本机文件的连接补充路径。">
                    <Card size="sm">
                        <CardHeader>
                            <CardTitle>待补充路径</CardTitle>
                            <CardDescription>路径只保存在本设备。NexusPilot 不会检查文件或更改你填写的内容。</CardDescription>
                            <CardAction>
                                <Button type="button" variant="ghost" size="sm" disabled={dependenciesLoading || !cloudReady} onClick={() => void loadDependencies()}>
                                    {dependenciesLoading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
                                    刷新
                                </Button>
                            </CardAction>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-3">
                            {dependenciesError ? <Alert variant="destructive"><AlertTitle>无法读取待补充路径</AlertTitle><AlertDescription>{dependenciesError.message}</AlertDescription></Alert> : null}
                            {dependenciesLoading && !dependencies ? <Skeleton className="h-20 w-full" /> : null}
                            {dependencies?.items.map((dependency) => (
                                <LocalDependencyRow key={`${dependency.assetId}:${dependency.dependency}`} dependency={dependency} onDone={setDependencies} />
                            ))}
                        </CardContent>
                    </Card>
                </SettingsSection>
            ) : null}

            {conflictsLoading || conflictsError || conflicts.length ? (
                <SettingsSection title="待处理冲突" description="选择要保留的版本，NexusPilot 不会替你猜测。">
                    <Card size="sm">
                        <CardHeader>
                            <CardTitle>冲突列表</CardTitle>
                            <CardDescription>连接可以保留本机、保留 Cloud 或保留两者；文件夹暂不支持保留两者。</CardDescription>
                            <CardAction><Button type="button" variant="ghost" size="sm" disabled={conflictsLoading || !cloudReady} onClick={() => void loadConflicts()}>{conflictsLoading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}刷新</Button></CardAction>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-3">
                            {conflictsError ? <Alert variant="destructive"><AlertTitle>无法读取待处理冲突</AlertTitle><AlertDescription>{conflictsError.message}</AlertDescription></Alert> : null}
                            {conflictsLoading && !conflicts.length ? <Skeleton className="h-20 w-full" /> : null}
                            {conflicts.map((conflict) => <ConflictRow key={conflict.id} conflict={conflict} onDone={setConflicts} />)}
                        </CardContent>
                    </Card>
                </SettingsSection>
            ) : null}

            <SettingsSection title="待授权设备" description="首次打开本页面时查看并处理新的设备请求。">
                <Card size="sm">
                    <CardHeader>
                        <CardTitle>待处理请求</CardTitle>
                        <CardDescription>只有你主动批准后，新设备才能访问同步数据。</CardDescription>
                        <CardAction>
                            <Button type="button" variant="ghost" size="sm" onClick={() => void loadPending()} disabled={pendingLoading || !hasLocalDeviceAccess || !cloudReady}>
                                {pendingLoading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
                                刷新
                            </Button>
                        </CardAction>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3">
                        {pendingError ? <Alert variant="destructive"><AlertTitle>无法读取待处理请求</AlertTitle><AlertDescription>{pendingError.message}</AlertDescription></Alert> : null}
                        {pendingLoading && !pending ? <Skeleton className="h-20 w-full" /> : null}
                        {pending?.items.length ? pending.items.map((request) => (
                            <PendingAuthorizationRow key={request.id} request={request} onDone={() => void loadPending()} />
                        )) : null}
                        {!pendingError && pending && !pending.items.length ? (
                            <p className="text-sm text-muted-foreground">当前没有待处理请求。</p>
                        ) : null}
                        {!pendingLoading && !pendingError && !pending && !hasLocalDeviceAccess ? (
                            <p className="text-sm text-muted-foreground">本设备完成授权后可以查看待授权设备。</p>
                        ) : null}
                        {!pendingLoading && !pendingError && !pending && hasLocalDeviceAccess && !cloudReady ? (
                            <p className="text-sm text-muted-foreground">连接 Cloud 后可以查看待授权设备。</p>
                        ) : null}
                        {!pendingLoading && !pendingError && !pending && pendingTimedOut ? (
                            <p className="text-sm text-muted-foreground">请求响应较慢，请稍后点击刷新。</p>
                        ) : null}
                    </CardContent>
                </Card>
            </SettingsSection>

            <SettingsSection title="恢复与设备安全" description="在需要时恢复设备访问，或撤销本设备。">
                <Card size="sm">
                    <CardContent className="flex flex-wrap items-center gap-2 pt-5">
                        <Button type="button" variant="outline" size="sm" onClick={() => setRecoveryOpen(true)}>
                            <RotateCcwKeyIcon data-icon="inline-start" />
                            使用恢复密钥
                        </Button>
                        {hasLocalDeviceAccess ? <Button type="button" variant="ghost" size="sm" onClick={() => setRotateOpen(true)}><RotateCcwKeyIcon data-icon="inline-start" />更换恢复密钥</Button> : null}
                        {hasLocalDeviceAccess ? <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => setRevokeOpen(true)}>
                            <Trash2Icon data-icon="inline-start" />
                            永久撤销本设备
                        </Button> : null}
                        {hasLocalDeviceAccess ? <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => setDeleteOpen(true)}><Trash2Icon data-icon="inline-start" />删除 Cloud 同步数据</Button> : null}
                    </CardContent>
                </Card>
            </SettingsSection>

            {context.sync.initialized && context.localSync.status === "secure_storage_unavailable" ? (
                <Alert variant="destructive"><AlertTitle>本机安全存储不可用</AlertTitle><AlertDescription>暂时无法在本设备上使用同步密钥。</AlertDescription></Alert>
            ) : null}
            {context.sync.initialized && context.localSync.status === "corrupted" ? (
                <Alert variant="destructive"><AlertTitle>本机同步需要恢复</AlertTitle><AlertDescription>请使用恢复密钥在本设备重新建立访问。</AlertDescription></Alert>
            ) : null}

            <EnableCloudSyncDialog open={setupOpen} suggestedDeviceName={context.suggestedDeviceName} onOpenChange={setSetupOpen} onEnabled={() => void handleEnabled()} />
            <AddDeviceDialog open={newDeviceOpen} suggestedDeviceName={context.suggestedDeviceName} authorization={authorization} operation={operation} onOpenChange={setNewDeviceOpen} onBegin={async (name) => { setOperation("authorizing"); try { setAuthorization(await beginDeviceAuthorization(name)); } catch (authError: unknown) { toast.error(toCloudError(authError).message); } finally { setOperation("idle"); } }} onCheck={() => void loadCurrentDeviceAuthorization()} onCancel={async () => { if (!authorization) return; try { await cancelDeviceAuthorization(authorization.requestId); setAuthorization(null); setNewDeviceOpen(false); } catch (cancelError: unknown) { toast.error(toCloudError(cancelError).message); } }} onRestart={() => setAuthorization(null)} />
            <RecoveryDialog open={recoveryOpen} suggestedDeviceName={context.suggestedDeviceName} operation={operation} onOpenChange={setRecoveryOpen} onRecover={async (key, name) => { setOperation("recovering"); try { await recoverCloudDeviceWithRecoveryKey(key, name); await handleEnabled(); setRecoveryOpen(false); toast.success("本设备已恢复"); } catch (recoverError: unknown) { toast.error(toCloudError(recoverError).message); } finally { setOperation("idle"); } }} />
            <AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>永久撤销本设备？</AlertDialogTitle>
                        <AlertDialogDescription>撤销后本设备将不能继续访问同步数据。之后需要使用其他设备授权或恢复密钥才能重新加入。</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>取消</AlertDialogCancel>
                        <AlertDialogAction disabled={operation !== "idle"} onClick={(event) => { event.preventDefault(); void handleRevoke(); }} variant="destructive">{operation === "revoking" ? <Spinner data-icon="inline-start" /> : null}永久撤销</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
            <Dialog open={rotateOpen} onOpenChange={(open) => { setRotateOpen(open); if (!open) { setRotatedKey(null); setRotationId(null); } }}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader><DialogTitle>更换恢复密钥</DialogTitle><DialogDescription>更换后旧恢复密钥立即失效。新密钥只显示这一次，请妥善保存。</DialogDescription></DialogHeader>
                    {rotatedKey ? <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-4"><span className="text-xs text-muted-foreground">新的恢复密钥</span><code className="break-all font-mono text-sm select-all">{rotatedKey}</code></div> : <p className="text-sm text-muted-foreground">确认后将生成新的恢复密钥。</p>}
                    <DialogFooter>{rotatedKey && rotationId ? <><Button type="button" variant="outline" onClick={() => { void copyRotatedRecoveryKey(rotationId).then(() => toast.success("恢复密钥已复制")).catch((copyError: unknown) => toast.error(toCloudError(copyError).message)); }}><CopyIcon data-icon="inline-start" />复制恢复密钥</Button><Button type="button" onClick={() => { void saveRotatedRecoveryKey(rotationId).then((result) => { if (result.completed) toast.success("恢复密钥已保存"); }).catch((saveError: unknown) => toast.error(toCloudError(saveError).message)); }}>保存文件</Button></> : <Button type="button" onClick={() => { void rotateCloudRecoveryKey().then((result) => { setRotationId(result.rotationId); setRotatedKey(result.recoveryKey); }).catch((rotateError: unknown) => toast.error(toCloudError(rotateError).message)); }}>生成新的恢复密钥</Button>}</DialogFooter>
                </DialogContent>
            </Dialog>
            <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
                <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>删除 Cloud 同步数据？</AlertDialogTitle><AlertDialogDescription>这会删除 Cloud 中的同步设备、恢复信息和已同步资产，但不会删除本地连接、NIEEX Account 或订阅。删除后需要重新启用同步。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={(event) => { event.preventDefault(); void deleteCloudSyncData().then(() => { setDeleteOpen(false); void refresh(); toast.success("Cloud 同步数据已删除"); }).catch((deleteError: unknown) => toast.error(toCloudError(deleteError).message)); }}>确认删除</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

function LocalDependencyRow({ dependency, onDone }: { dependency: CloudLocalDependency; onDone: (result: CloudLocalDependencyList) => void }) {
    const [path, setPath] = useState(dependency.currentPath ?? "");
    const [busy, setBusy] = useState(false);
    const label = dependency.dependency === "database_file" ? "数据库文件" : "SSH 私钥";
    const save = async (): Promise<void> => {
        setBusy(true);
        try {
            onDone(await completeCloudSyncLocalDependency(dependency.assetId, dependency.dependency, path));
            toast.success("本地路径已保存");
        } catch (saveError: unknown) {
            console.error("[cloud-sync] complete local dependency failed", saveError);
            toast.error(toCloudError(saveError).message);
        } finally {
            setBusy(false);
        }
    };
    return (
        <div className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex items-center gap-2 text-sm font-medium"><FileKeyIcon />{dependency.assetName} · {label}</div>
            <div className="flex flex-wrap items-center gap-2">
                <Input className="min-w-64 flex-1" value={path} onChange={(event) => setPath(event.target.value)} placeholder={`输入${label}路径`} />
                <Button type="button" size="sm" disabled={busy || !path.trim()} onClick={() => void save()}>{busy ? <Spinner data-icon="inline-start" /> : null}保存</Button>
            </div>
        </div>
    );
}

function ConflictRow({ conflict, onDone }: { conflict: CloudSyncConflictView; onDone: (items: CloudSyncConflictView[]) => void }) {
    const [busy, setBusy] = useState(false);
    const resolve = async (decision: "keep_local" | "keep_cloud" | "keep_both"): Promise<void> => {
        setBusy(true);
        try {
            onDone(await resolveCloudSyncConflict(conflict.id, decision));
            toast.success("冲突已处理");
        } catch (resolveError: unknown) {
            console.error("[cloud-sync] conflict resolution failed", resolveError);
            toast.error(toCloudError(resolveError).message);
        } finally {
            setBusy(false);
        }
    };
    return (
        <div className="flex flex-col gap-3 rounded-md border p-3">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><div className="truncate text-sm font-medium">{conflict.remoteName ?? conflict.localName ?? "未命名资产"}</div><div className="text-xs text-muted-foreground">{conflict.assetType === "connection_folder" ? "文件夹" : "连接"} · Cloud 版本 {conflict.remoteRevision}</div></div>
                <Badge variant="outline">待处理</Badge>
            </div>
            <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void resolve("keep_local")}>保留本机</Button>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void resolve("keep_cloud")}>保留 Cloud</Button>
                {conflict.assetType !== "connection_folder" ? <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void resolve("keep_both")}>保留两者</Button> : null}
            </div>
        </div>
    );
}

function PendingAuthorizationRow({ request, onDone }: { request: CloudDeviceAuthorization; onDone: () => void }) {
    const [code, setCode] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const operate = async (action: "approve" | "reject"): Promise<void> => {
        setBusy(true);
        setError(null);
        try {
            if (action === "approve") await approveDeviceAuthorization(request.id, code);
            else await rejectDeviceAuthorization(request.id);
            toast.success(action === "approve" ? "设备已批准" : "请求已拒绝");
            onDone();
        } catch (operationError: unknown) {
            console.error("[cloud-sync] pending authorization action failed", operationError);
            setError(toCloudError(operationError).message);
        } finally {
            setBusy(false);
        }
    };
    return (
        <div className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5"><span className="truncate font-medium">{request.device.displayName}</span><span className="text-xs text-muted-foreground">有效期至 {formatDeviceDate(request.expiresAt)}</span></div>
                <Badge variant="outline">待批准</Badge>
            </div>
            <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">短验证码<Input value={code} onChange={(event) => setCode(event.target.value)} placeholder="输入新设备显示的验证码" /></label>
                <Button type="button" size="sm" disabled={busy || !code.trim()} onClick={() => void operate("approve")}>{busy ? <Spinner data-icon="inline-start" /> : <CheckCircle2Icon data-icon="inline-start" />}批准</Button>
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void operate("reject")}>拒绝</Button>
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
    );
}

function AddDeviceDialog({
    open,
    suggestedDeviceName,
    authorization,
    operation,
    onOpenChange,
    onBegin,
    onCheck,
    onCancel,
    onRestart,
}: {
    open: boolean;
    suggestedDeviceName: string;
    authorization: DeviceAuthorizationProgress | null;
    operation: Operation;
    onOpenChange: (open: boolean) => void;
    onBegin: (name: string) => Promise<void>;
    onCheck: () => void;
    onCancel: () => Promise<void>;
    onRestart: () => void;
}) {
    const [name, setName] = useState(suggestedDeviceName);
    useEffect(() => { if (open) setName(suggestedDeviceName); }, [open, suggestedDeviceName]);
    const copyCode = async (): Promise<void> => {
        if (!authorization) return;
        try { await navigator.clipboard.writeText(authorization.verificationCode); toast.success("验证码已复制"); } catch (error: unknown) { console.error("[cloud-sync] copy code failed", error); }
    };
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg" showCloseButton={operation === "idle"}>
                {!authorization ? <>
                    <DialogHeader><DialogTitle>添加新设备</DialogTitle><DialogDescription>在新设备上登录后打开此页面，生成一个短验证码，再由已授权设备批准。</DialogDescription></DialogHeader>
                    <FieldGroup><Field><FieldLabel htmlFor="new-device-name">设备名称</FieldLabel><Input id="new-device-name" value={name} maxLength={64} onChange={(event) => setName(event.target.value)} /><FieldDescription>默认使用当前主机名，方便你区分设备。</FieldDescription></Field></FieldGroup>
                    <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="button" disabled={operation !== "idle" || !name.trim()} onClick={() => void onBegin(name)}>{operation === "authorizing" ? <Spinner data-icon="inline-start" /> : <UserPlusIcon data-icon="inline-start" />}生成验证码</Button></DialogFooter>
                </> : authorization.status === "pending" ? <>
                    <DialogHeader><DialogTitle>等待设备批准</DialogTitle><DialogDescription>请在任一已授权设备的“待授权设备”中输入下面的验证码并批准。此窗口打开时会自动检查授权状态。</DialogDescription></DialogHeader>
                    <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-4"><span className="text-xs text-muted-foreground">设备名称</span><span className="font-medium">{authorization.deviceName}</span><span className="text-xs text-muted-foreground">短验证码</span><code className="font-mono text-2xl tracking-widest select-all">{authorization.verificationCode}</code><span className="text-xs text-muted-foreground">有效期至 {formatDeviceDate(authorization.codeExpiresAt)}</span></div>
                    <DialogFooter><Button type="button" variant="outline" onClick={() => void copyCode()}><CopyIcon data-icon="inline-start" />复制验证码</Button><Button type="button" variant="outline" onClick={onCheck}><RefreshCwIcon data-icon="inline-start" />检查状态</Button><Button type="button" variant="ghost" onClick={() => void onCancel()}>取消请求</Button></DialogFooter>
                </> : authorization.status === "approved" ? <>
                    <DialogHeader><DialogTitle>正在完成设备授权</DialogTitle><DialogDescription>该设备已获批准，NexusPilot 正在安全领取密钥并建立同步访问。</DialogDescription></DialogHeader>
                    <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-4 text-sm"><Spinner />完成后会自动开始同步。</div>
                </> : <>
                    <DialogHeader><DialogTitle>设备授权未完成</DialogTitle><DialogDescription>{authorization.status === "rejected" ? "该请求已被拒绝。" : authorization.status === "expired" ? "该请求已过期。" : "该请求已取消。"}你可以重新发起新的设备授权请求。</DialogDescription></DialogHeader>
                    <DialogFooter><Button type="button" onClick={onRestart}>重新发起请求</Button></DialogFooter>
                </>}
            </DialogContent>
        </Dialog>
    );
}

function RecoveryDialog({
    open,
    suggestedDeviceName,
    operation,
    onOpenChange,
    onRecover,
}: {
    open: boolean;
    suggestedDeviceName: string;
    operation: Operation;
    onOpenChange: (open: boolean) => void;
    onRecover: (key: string, name: string) => Promise<void>;
}) {
    const [key, setKey] = useState("");
    const [name, setName] = useState(suggestedDeviceName);
    useEffect(() => { if (open) { setKey(""); setName(suggestedDeviceName); } }, [open, suggestedDeviceName]);
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg" showCloseButton={operation === "idle"}>
                <DialogHeader><DialogTitle>使用恢复密钥</DialogTitle><DialogDescription>使用你保存的恢复密钥在本设备建立同步访问。恢复密钥不会被 NexusPilot 保存。</DialogDescription></DialogHeader>
                <FieldGroup><Field><FieldLabel htmlFor="recovery-key">恢复密钥</FieldLabel><Input id="recovery-key" value={key} autoComplete="off" onChange={(event) => setKey(event.target.value)} placeholder="粘贴恢复密钥" /></Field><Field><FieldLabel htmlFor="recovery-device-name">设备名称</FieldLabel><Input id="recovery-device-name" value={name} maxLength={64} onChange={(event) => setName(event.target.value)} /></Field></FieldGroup>
                <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="button" disabled={operation !== "idle" || !key.trim() || !name.trim()} onClick={() => void onRecover(key, name)}>{operation === "recovering" ? <Spinner data-icon="inline-start" /> : <RotateCcwKeyIcon data-icon="inline-start" />}恢复访问</Button></DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function formatDeviceDate(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
