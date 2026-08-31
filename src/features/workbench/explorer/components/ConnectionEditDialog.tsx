import { useEffect, useReducer, useRef, useState } from "react";
import { Wifi } from "lucide-react";
import { toast } from "@/components/ui/toast";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Field,
    FieldContent,
    FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
    getDriverConfig,
} from "@/features/workbench/explorer/driver-configs";
import {
    ConnectionTestStatusBar,
    type ConnectionTestState,
} from "@/features/workbench/explorer/components/ConnectionTestStatusBar";
import { ConnectionMetadataDisclosure } from "@/features/workbench/explorer/components/ConnectionMetadataDisclosure";
import type { ConnectionTagValue } from "@/features/workbench/explorer/components/ConnectionTagFields";
import {
    createConnectionMetadataDisclosureState,
    reduceConnectionMetadataDisclosure,
} from "@/features/workbench/explorer/connection-metadata";
import { normalizeConnectionTagInput } from "@/features/workbench/explorer/connection-tags";
import {
    CONNECTION_NOTE_MAX_LENGTH,
    isConnectionNoteWithinLimit,
    normalizeConnectionNote,
} from "@/features/workbench/explorer/connection-notes";
import { apiInvoke } from "@/lib/api-client";
import { normalizeIpcError } from "@/lib/ipc-error";
import type { ImplementedDriver } from "@/features/workbench/explorer/driver-configs/types";
import { createConnection, updateConnection } from "@/lib/tauri/connections";
import type { DbDriver, IBaseConnectionProfile, StoredDatabaseConnection } from "@/types";
import type { ConnectionTestResult } from "@/types/ipc";

export type ConnectionEditDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    mode: "create" | "edit";
    driver: DbDriver;
    /** 新建连接时目标文件夹；编辑时忽略（沿用 initialConnection.folderId） */
    folderId: string | null;
    initialConnection?: StoredDatabaseConnection;
    prefillConnection?: StoredDatabaseConnection;
    onSaved?: (record: StoredDatabaseConnection) => void;
};

function buildClonedConnectionName(name: string): string {
    const trimmedName = name.trim();
    return trimmedName ? `${trimmedName} 副本` : "连接副本";
}

function filenameFromPath(path: unknown): string {
    const value = typeof path === "string" ? path.trim() : "";
    const fileName = value.split(/[\\/]/).filter(Boolean).at(-1);
    return fileName ?? "";
}

function buildDefaultConnectionName(
    connectionModel: "network" | "local-file" | "cloud-api",
    config: Record<string, unknown>,
): string {
    if (connectionModel === "network") {
        const host = typeof config.host === "string" ? config.host.trim() : "";
        const port = config.port == null ? "" : String(config.port).trim();
        return host && port ? `${host}_${port}` : "";
    }

    if (connectionModel === "local-file") {
        return filenameFromPath(config.dbFilePath);
    }

    const endpoint = typeof config.endpoint === "string" ? config.endpoint.trim() : "";
    return endpoint;
}

/** 从 IStoredConnectionProfile 中提取驱动特有的 payload 字段（去掉通用 base 字段和存储层字段）。 */
function extractPayload(connection: StoredDatabaseConnection): Record<string, unknown> {
    const BASE_KEYS: (keyof IBaseConnectionProfile)[] = [
        "id", "name", "environment", "color", "note", "tagLabel", "tagColor", "createdAt", "updatedAt",
    ];
    const STORED_KEYS = [
        "driver", "folderId", "sortOrder",
        "lastConnectedAt", "lastConnectionStatus", "lastConnectionError",
    ];
    const excludeKeys = new Set<string>([...BASE_KEYS, ...STORED_KEYS]);

    return Object.fromEntries(
        Object.entries(connection).filter(([k]) => !excludeKeys.has(k)),
    );
}

export function ConnectionEditDialog({
    open,
    onOpenChange,
    mode,
    driver,
    folderId,
    initialConnection,
    prefillConnection,
    onSaved,
}: ConnectionEditDialogProps) {
    const effectiveDriver: DbDriver =
        mode === "edit" && initialConnection
            ? initialConnection.driver
            : driver;

    // 仅已实现的驱动才有 DriverConfig；未实现的驱动会返回 undefined
    const effectiveDriverConfig = getDriverConfig(effectiveDriver as ImplementedDriver);

    const [name, setName] = useState("");
    const [note, setNote] = useState("");
    const [tag, setTag] = useState<ConnectionTagValue>({
        tagLabel: "",
        tagColor: null,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [config, setConfig] = useState<any>(() =>
        effectiveDriverConfig?.createDefaultConfig() ?? {},
    );
    const [isSaving, setIsSaving] = useState(false);
    const [isTesting, setIsTesting] = useState(false);
    const [testState, setTestState] = useState<ConnectionTestState>({ status: "idle" });
    const [metadataDisclosure, dispatchMetadataDisclosure] = useReducer(
        reduceConnectionMetadataDisclosure,
        createConnectionMetadataDisclosureState(),
    );
    const noteInputRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        if (!open) {
            return;
        }

        dispatchMetadataDisclosure({ type: "reset" });

        if (mode === "edit" && initialConnection) {
            setName(initialConnection.name);
            setNote(initialConnection.note ?? "");
            setTag(normalizeConnectionTagInput(initialConnection));
            setConfig(extractPayload(initialConnection));
        } else if (mode === "create" && prefillConnection) {
            setName(buildClonedConnectionName(prefillConnection.name));
            setNote(prefillConnection.note ?? "");
            setTag(normalizeConnectionTagInput(prefillConnection));
            setConfig(extractPayload(prefillConnection));
        } else {
            setName("");
            setNote("");
            setTag({ tagLabel: "", tagColor: null });
            setConfig(effectiveDriverConfig?.createDefaultConfig() ?? {});
        }
        setIsSaving(false);
        setIsTesting(false);
        setTestState({ status: "idle" });
    }, [open, mode, initialConnection, prefillConnection, effectiveDriverConfig]);

    useEffect(() => {
        if (!metadataDisclosure.focusNote) {
            return;
        }

        noteInputRef.current?.focus();
        dispatchMetadataDisclosure({ type: "note-focused" });
    }, [metadataDisclosure.focusNote]);

    function handleOpenChange(next: boolean) {
        if (!next) {
            setName("");
            setNote("");
            setTag({ tagLabel: "", tagColor: null });
            setConfig(effectiveDriverConfig?.createDefaultConfig() ?? {});
            setIsTesting(false);
            setTestState({ status: "idle" });
            dispatchMetadataDisclosure({ type: "reset" });
        }
        onOpenChange(next);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function handleConfigChange(nextConfig: any) {
        setConfig(nextConfig);
        setTestState({ status: "idle" });
    }

    function validate(): string | null {
        if (!effectiveDriverConfig) {
            return `驱动 ${effectiveDriver} 暂不支持，敬请期待`;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return effectiveDriverConfig.validate(config as any);
    }

    function getResolvedName(): string {
        const trimmedName = name.trim();
        if (trimmedName) {
            return trimmedName;
        }

        return buildDefaultConnectionName(
            effectiveDriverConfig?.connectionModel ?? "network",
            config,
        );
    }

    async function handleTestConnection() {
        const err = validate();
        if (err) {
            toast.error(err);
            return;
        }

        setIsTesting(true);
        setTestState({ status: "testing" });
        try {
            const result = await apiInvoke<ConnectionTestResult>(
                "test_connection_config",
                {
                    driver: effectiveDriver,
                    payload: config,
                },
                { silent: true },
            );
            if (
                result.sshHostKeyFingerprint
                && config.sshTunnel?.enabled
                && config.sshTunnel.hostVerification !== "skip"
            ) {
                setConfig({
                    ...config,
                    sshTunnel: {
                        ...config.sshTunnel,
                        hostKeyFingerprint: result.sshHostKeyFingerprint,
                    },
                });
            }
            setTestState({ status: "success", result });
        } catch (raw) {
            console.error("[ConnectionEditDialog] test connection failed", raw);
            setTestState({ status: "error", error: normalizeIpcError(raw) });
        } finally {
            setIsTesting(false);
        }
    }

    async function handleSave() {
        const err = validate();
        if (err) {
            toast.error(err);
            return;
        }

        const resolvedName = getResolvedName();
        if (!resolvedName) {
            toast.error("请填写连接名称");
            return;
        }

        const normalizedNote = normalizeConnectionNote(note);
        if (!isConnectionNoteWithinLimit(normalizedNote)) {
            dispatchMetadataDisclosure({ type: "reveal-invalid-note" });
            toast.error(`连接备注不能超过 ${CONNECTION_NOTE_MAX_LENGTH} 个字符`);
            return;
        }

        setIsSaving(true);
        const normalizedTag = normalizeConnectionTagInput(tag);
        try {
            if (mode === "create") {
                const id = crypto.randomUUID();
                const record = await createConnection({
                    id,
                    name: resolvedName,
                    driver: effectiveDriver,
                    environment: "development",
                    color: null,
                    createdAt: 0,
                    updatedAt: 0,
                    ...config,
                    note: normalizedNote,
                    tagLabel: normalizedTag.tagLabel,
                    tagColor: normalizedTag.tagColor,
                    folderId: folderId ?? null,
                    sortOrder: null,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any);
                toast.success("连接已保存");
                onSaved?.(record);
            } else if (initialConnection) {
                const record = await updateConnection({
                    ...initialConnection,
                    name: resolvedName,
                    driver: effectiveDriver,
                    ...config,
                    note: normalizedNote,
                    tagLabel: normalizedTag.tagLabel,
                    tagColor: normalizedTag.tagColor,
                    folderId: initialConnection.folderId ?? null,
                    sortOrder: initialConnection.sortOrder ?? null,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any);
                toast.success("连接已保存");
                onSaved?.(record);
            }
            handleOpenChange(false);
        } catch (e) {
            console.error("[ConnectionEditDialog] save failed", e);
            const error = normalizeIpcError(e);
            toast.error(`保存失败：${error.message}`);
        } finally {
            setIsSaving(false);
        }
    }

    const title = mode === "create" ? "新建连接" : "编辑连接";
    const subtitle = effectiveDriverConfig?.displayName ?? effectiveDriver;
    const showTestStatusBar = testState.status !== "idle";

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="flex h-[min(90vh,720px)] flex-col overflow-hidden sm:max-w-lg">
                <DialogHeader className="shrink-0 pr-8">
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>
                        {subtitle} — 填写连接信息，保存后即可在列表中使用。
                    </DialogDescription>
                </DialogHeader>

                <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden py-1">
                    <Field className="shrink-0">
                        <FieldLabel htmlFor="conn-name">连接名称</FieldLabel>
                        <FieldContent>
                            <Input
                                id="conn-name"
                                autoComplete="off"
                                disabled={isSaving}
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="例如：本地开发库"
                            />
                        </FieldContent>
                    </Field>

                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                        {effectiveDriverConfig?.renderForm({
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            value: config as any,
                            onChange: handleConfigChange,
                            disabled: isSaving || isTesting,
                        })}
                    </div>

                    <ConnectionMetadataDisclosure
                        open={metadataDisclosure.open}
                        onOpenChange={(nextOpen) => dispatchMetadataDisclosure({
                            type: "set-open",
                            open: nextOpen,
                        })}
                        tag={tag}
                        onTagChange={setTag}
                        note={note}
                        onNoteChange={setNote}
                        disabled={isSaving || isTesting}
                        noteInputRef={noteInputRef}
                    />
                </div>

                <div className="-mx-4 -mb-4 flex shrink-0 flex-col overflow-hidden rounded-b-xl">
                    {showTestStatusBar && (
                        <ConnectionTestStatusBar state={testState} />
                    )}
                    <div
                        data-slot="dialog-footer"
                        className="flex flex-col gap-2 border-t bg-muted/50 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                    >
                        <Button
                            type="button"
                            variant="outline"
                            disabled={isSaving || isTesting || !effectiveDriverConfig}
                            onClick={() => void handleTestConnection()}
                            className="w-full sm:w-auto"
                        >
                            {isTesting ? (
                                <>
                                    <Spinner data-icon="inline-start" />
                                    测试中...
                                </>
                            ) : (
                                <>
                                    <Wifi data-icon="inline-start" />
                                    测试连接
                                </>
                            )}
                        </Button>
                        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:justify-end">
                            <Button
                                type="button"
                                variant="outline"
                                disabled={isSaving || isTesting}
                                onClick={() => handleOpenChange(false)}
                            >
                                取消
                            </Button>
                            <Button
                                type="button"
                                disabled={isSaving || isTesting}
                                onClick={() => void handleSave()}
                            >
                                确定
                            </Button>
                        </div>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
