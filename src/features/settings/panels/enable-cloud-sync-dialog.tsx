import { useEffect, useState } from "react";
import {
    CheckIcon,
    ClipboardIcon,
    DownloadIcon,
    KeyRoundIcon,
    ShieldCheckIcon,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
    beginSyncSetup,
    cancelSyncSetup,
    copyRecoveryKey,
    finalizeSyncSetup,
    saveRecoveryKey,
} from "@/lib/tauri/cloud";
import type {
    BeginSyncSetupResult,
    CloudPublicError,
    CloudSyncStateProjection,
} from "@/types/ipc";

interface EnableCloudSyncDialogProps {
    open: boolean;
    suggestedDeviceName: string;
    onOpenChange: (open: boolean) => void;
    onEnabled: (projection: CloudSyncStateProjection) => void;
}

type SetupStep = "intro" | "recovery" | "success";
type SetupOperation = "idle" | "beginning" | "copying" | "saving" | "finalizing";

export function EnableCloudSyncDialog({
    open,
    suggestedDeviceName,
    onOpenChange,
    onEnabled,
}: EnableCloudSyncDialogProps) {
    const [step, setStep] = useState<SetupStep>("intro");
    const [deviceName, setDeviceName] = useState(suggestedDeviceName);
    const [setup, setSetup] = useState<BeginSyncSetupResult | null>(null);
    const [operation, setOperation] = useState<SetupOperation>("idle");
    const [confirmedSaved, setConfirmedSaved] = useState(false);
    const [copied, setCopied] = useState(false);
    const [fileSaved, setFileSaved] = useState(false);
    const [error, setError] = useState<CloudPublicError | null>(null);

    useEffect(() => {
        if (!open) return;
        setStep("intro");
        setDeviceName(suggestedDeviceName);
        setSetup(null);
        setOperation("idle");
        setConfirmedSaved(false);
        setCopied(false);
        setFileSaved(false);
        setError(null);
    }, [open, suggestedDeviceName]);

    const closeDialog = (): void => {
        if (operation !== "idle") return;
        if (setup) {
            void cancelSyncSetup(setup.setupId).catch((cancelError: unknown) => {
                console.error("[cloud-sync] failed to cancel setup", cancelError);
            });
        }
        setSetup(null);
        setConfirmedSaved(false);
        onOpenChange(false);
    };

    const startSetup = async (): Promise<void> => {
        setOperation("beginning");
        setError(null);
        try {
            const result = await beginSyncSetup(deviceName);
            setSetup(result);
            setStep("recovery");
        } catch (setupError: unknown) {
            console.error("[cloud-sync] failed to begin setup", setupError);
            setError(toCloudError(setupError));
        } finally {
            setOperation("idle");
        }
    };

    const copyKey = async (): Promise<void> => {
        if (!setup) return;
        setOperation("copying");
        setError(null);
        try {
            await copyRecoveryKey(setup.setupId);
            setCopied(true);
        } catch (copyError: unknown) {
            console.error("[cloud-sync] failed to copy recovery key", copyError);
            setError(toCloudError(copyError));
        } finally {
            setOperation("idle");
        }
    };

    const saveKey = async (): Promise<void> => {
        if (!setup) return;
        setOperation("saving");
        setError(null);
        try {
            const result = await saveRecoveryKey(setup.setupId);
            if (result.completed) setFileSaved(true);
        } catch (saveError: unknown) {
            console.error("[cloud-sync] failed to save recovery key", saveError);
            setError(toCloudError(saveError));
        } finally {
            setOperation("idle");
        }
    };

    const enableSync = async (): Promise<void> => {
        if (!setup || !confirmedSaved) return;
        setOperation("finalizing");
        setError(null);
        try {
            const projection = await finalizeSyncSetup(setup.setupId);
            setSetup(null);
            setStep("success");
            onEnabled(projection);
        } catch (finalizeError: unknown) {
            console.error("[cloud-sync] failed to finalize setup", finalizeError);
            setError(toCloudError(finalizeError));
        } finally {
            setOperation("idle");
        }
    };

    return (
        <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && closeDialog()}>
            <DialogContent className="sm:max-w-lg" showCloseButton={operation === "idle"}>
                {step === "intro" ? (
                    <>
                        <DialogHeader>
                            <DialogTitle>启用端到端加密同步</DialogTitle>
                            <DialogDescription>
                                NexusPilot 将在本机生成同步密钥。Cloud 只保存密文，无法读取连接内容。
                            </DialogDescription>
                        </DialogHeader>
                        <Alert>
                            <ShieldCheckIcon />
                            <AlertTitle>只有确认后才会启用</AlertTitle>
                            <AlertDescription>
                                打开此向导不会生成密钥。继续后会显示一次恢复密钥；完成确认前不会初始化 Cloud 同步。
                            </AlertDescription>
                        </Alert>
                        <Field>
                            <FieldLabel htmlFor="cloud-sync-device-name">设备名称</FieldLabel>
                            <Input
                                id="cloud-sync-device-name"
                                value={deviceName}
                                maxLength={64}
                                autoComplete="off"
                                onChange={(event) => setDeviceName(event.target.value)}
                            />
                            <FieldDescription>
                                默认使用当前主机名，你可以修改它以便在设备列表中区分。
                            </FieldDescription>
                        </Field>
                        {error ? <SetupErrorAlert error={error} /> : null}
                        <DialogFooter>
                            <Button variant="outline" onClick={closeDialog}>取消</Button>
                            <Button
                                disabled={!deviceName.trim() || operation !== "idle"}
                                onClick={() => void startSetup()}
                            >
                                {operation === "beginning" ? <Spinner data-icon="inline-start" /> : null}
                                生成恢复密钥
                            </Button>
                        </DialogFooter>
                    </>
                ) : null}

                {step === "recovery" && setup ? (
                    <>
                        <DialogHeader>
                            <DialogTitle>保存恢复密钥</DialogTitle>
                            <DialogDescription>
                                这是在没有已授权设备时恢复加密数据的唯一凭据。关闭后不会再次显示。
                            </DialogDescription>
                        </DialogHeader>
                        <div className="rounded-lg border bg-muted/40 p-3">
                            <code className="block break-all font-mono text-sm leading-6 select-all">
                                {setup.recoveryKey}
                            </code>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Button
                                variant="outline"
                                disabled={operation !== "idle"}
                                onClick={() => void copyKey()}
                            >
                                {operation === "copying" ? <Spinner data-icon="inline-start" /> : <ClipboardIcon data-icon="inline-start" />}
                                {copied ? "已复制" : "复制"}
                            </Button>
                            <Button
                                variant="outline"
                                disabled={operation !== "idle"}
                                onClick={() => void saveKey()}
                            >
                                {operation === "saving" ? <Spinner data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />}
                                {fileSaved ? "已保存" : "保存文件"}
                            </Button>
                        </div>
                        <Alert>
                            <KeyRoundIcon />
                            <AlertTitle>请离线妥善保管</AlertTitle>
                            <AlertDescription>
                                不要将恢复密钥保存在与同步数据相同且可能同时丢失的位置，也不要发送给任何人。
                            </AlertDescription>
                        </Alert>
                        <Button
                            variant={confirmedSaved ? "secondary" : "outline"}
                            disabled={operation !== "idle"}
                            onClick={() => setConfirmedSaved((value) => !value)}
                        >
                            {confirmedSaved ? <CheckIcon data-icon="inline-start" /> : null}
                            {confirmedSaved ? "已确认安全保存" : "我已安全保存恢复密钥"}
                        </Button>
                        {error ? <SetupErrorAlert error={error} /> : null}
                        <DialogFooter>
                            <Button variant="outline" disabled={operation !== "idle"} onClick={closeDialog}>
                                取消
                            </Button>
                            <Button
                                disabled={!confirmedSaved || operation !== "idle"}
                                onClick={() => void enableSync()}
                            >
                                {operation === "finalizing" ? <Spinner data-icon="inline-start" /> : null}
                                启用加密同步
                            </Button>
                        </DialogFooter>
                    </>
                ) : null}

                {step === "success" ? (
                    <>
                        <DialogHeader>
                            <DialogTitle>加密同步已启用</DialogTitle>
                            <DialogDescription>
                                当前设备已安全注册。后续连接数据将按照同步策略进行端到端加密同步。
                            </DialogDescription>
                        </DialogHeader>
                        <Alert>
                            <ShieldCheckIcon />
                            <AlertTitle>恢复密钥已从界面清除</AlertTitle>
                            <AlertDescription>
                                NexusPilot 不会在界面中再次显示本次恢复密钥，请保管好你刚才保存的副本。
                            </AlertDescription>
                        </Alert>
                        <DialogFooter>
                            <Button onClick={closeDialog}>完成</Button>
                        </DialogFooter>
                    </>
                ) : null}
            </DialogContent>
        </Dialog>
    );
}

function SetupErrorAlert({ error }: { error: CloudPublicError }) {
    return (
        <Alert variant="destructive">
            <AlertTitle>无法继续</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
        </Alert>
    );
}

function toCloudError(error: unknown): CloudPublicError {
    if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        "message" in error &&
        typeof error.code === "string" &&
        typeof error.message === "string"
    ) {
        return error as CloudPublicError;
    }
    return {
        code: "CLOUD_TEMPORARILY_UNAVAILABLE",
        message: "NexusPilot Cloud 暂时不可用，请稍后重试。",
        retryable: true,
        occurredAt: new Date().toISOString(),
    };
}
