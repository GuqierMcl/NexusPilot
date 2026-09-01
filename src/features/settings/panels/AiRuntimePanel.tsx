import type { ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/toast";
import type { SettingsPanelProps } from "@/features/settings/settings-sections";
import {
    PRODUCT_DOWNLOAD_URL,
    openProductDownload,
} from "@/routes/open-product-download";
import type { AiRuntimeHealthStatus } from "@/store/slices/ai-runtime-endpoint-slice";
import { useAiRuntimeEndpointStore } from "@/store/slices/ai-runtime-endpoint-slice";
import {
    Item,
    ItemActions,
    ItemContent,
    ItemDescription,
    ItemGroup,
    ItemTitle,
} from "@/components/ui/item";

import {
    AiRuntimeVersionMismatchAlert,
    getAiRuntimeVersionMismatch,
} from "./ai-runtime-version-mismatch-alert";

function formatHealthStatus(status: AiRuntimeHealthStatus): string {
    const labels: Record<AiRuntimeHealthStatus, string> = {
        unknown: "未知",
        healthy: "健康",
        unhealthy: "异常",
    };

    return labels[status];
}

function getHealthStatusBadgeVariant(
    status: AiRuntimeHealthStatus,
): "default" | "secondary" | "destructive" {
    if (status === "healthy") {
        return "default";
    }

    if (status === "unhealthy") {
        return "destructive";
    }

    return "secondary";
}

function formatMode(mode: string | undefined): string {
    if (mode === "development") {
        return "开发模式";
    }

    if (mode === "production") {
        return "生产模式";
    }

    return "未配置";
}

function formatLastCheckedAt(value: number | null): string {
    if (value === null) {
        return "尚未检查";
    }

    return new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "medium",
    }).format(new Date(value));
}

type BackendBridgeState = "waiting" | "ready" | "disconnected";

function formatBackendBridgeState(state: BackendBridgeState | undefined): string {
    if (state === "ready") return "已连接";
    if (state === "waiting") return "等待连接";
    if (state === "disconnected") return "已断开";
    return "未知";
}

function getBackendBridgeBadgeVariant(
    state: BackendBridgeState | undefined,
): "default" | "secondary" | "destructive" {
    if (state === "ready") return "default";
    if (state === "disconnected") return "destructive";
    return "secondary";
}

interface ReadonlyInfoRowProps {
    label: string;
    description?: string;
    value: ReactNode;
}

function ReadonlyInfoRow({
    label,
    description,
    value,
}: ReadonlyInfoRowProps) {
    return (
        <Item variant="default">
            <ItemContent className="min-w-0">
                <ItemTitle>{label}</ItemTitle>
                {description ? (
                    <ItemDescription>{description}</ItemDescription>
                ) : null}
            </ItemContent>
            <ItemActions className="min-w-0 shrink-0">
                <span className="max-w-80 truncate text-right text-sm">
                    {value}
                </span>
            </ItemActions>
        </Item>
    );
}

export function AiRuntimePanel({ appVersion }: SettingsPanelProps) {
    const endpoint = useAiRuntimeEndpointStore((state) => state.endpoint);
    const healthStatus = useAiRuntimeEndpointStore(
        (state) => state.healthStatus,
    );
    const version = useAiRuntimeEndpointStore((state) => state.version);
    const lastCheckedAt = useAiRuntimeEndpointStore(
        (state) => state.lastCheckedAt,
    );
    const errorMessage = useAiRuntimeEndpointStore(
        (state) => state.errorMessage,
    );
    const backendBridge = useAiRuntimeEndpointStore(
        (state) => state.backendBridge,
    );
    const versionMismatch = getAiRuntimeVersionMismatch(appVersion, version);

    const handleOpenDownload = (): void => {
        void openProductDownload({
            openUrl,
            reportError: (message) => {
                console.error(
                    `Failed to open the NexusPilot download page at ${PRODUCT_DOWNLOAD_URL}`,
                );
                toast.error(message);
            },
        });
    };

    return (
        <div className="flex flex-col gap-6">
            {versionMismatch ? (
                <AiRuntimeVersionMismatchAlert
                    appVersion={versionMismatch.appVersion}
                    runtimeVersion={versionMismatch.runtimeVersion}
                    onOpenDownload={handleOpenDownload}
                />
            ) : null}

            <section className="flex flex-col gap-3">
                <h4 className="text-sm font-medium">运行状态</h4>
                <ItemGroup className="gap-0 rounded-lg bg-muted/60 p-2">
                    <Item variant="default">
                        <ItemContent>
                            <ItemTitle>健康状态</ItemTitle>
                            <ItemDescription>
                                AI Runtime 最近一次健康检查结果
                            </ItemDescription>
                        </ItemContent>
                        <ItemActions>
                            <Badge
                                variant={getHealthStatusBadgeVariant(
                                    healthStatus,
                                )}
                            >
                                {formatHealthStatus(healthStatus)}
                            </Badge>
                        </ItemActions>
                    </Item>
                    <ReadonlyInfoRow
                        label="版本"
                        description="AI Runtime 健康检查返回的版本"
                        value={version ?? "未知"}
                    />
                    <ReadonlyInfoRow
                        label="最近检查"
                        description="最后一次健康检查完成时间"
                        value={formatLastCheckedAt(lastCheckedAt)}
                    />
                    <Item variant="default">
                        <ItemContent>
                            <ItemTitle>后端能力连接</ItemTitle>
                            <ItemDescription>
                                智能体与本地数据库及工作台能力的连接状态
                            </ItemDescription>
                        </ItemContent>
                        <ItemActions>
                            <Badge
                                variant={getBackendBridgeBadgeVariant(
                                    backendBridge?.state,
                                )}
                            >
                                {formatBackendBridgeState(backendBridge?.state)}
                            </Badge>
                        </ItemActions>
                    </Item>
                    <ReadonlyInfoRow
                        label="最近通信"
                        description="最近一次确认后端能力连接正常的时间"
                        value={formatLastCheckedAt(
                            backendBridge?.lastHeartbeatAt ?? null,
                        )}
                    />
                </ItemGroup>
            </section>

            <section className="flex flex-col gap-3">
                <h4 className="text-sm font-medium">连接信息</h4>
                <ItemGroup className="gap-0 rounded-lg bg-muted/60 p-2">
                    <ReadonlyInfoRow
                        label="Endpoint"
                        description="本机 AI Runtime 端口"
                        value={endpoint?.port ?? "未配置"}
                    />
                    <ReadonlyInfoRow
                        label="运行模式"
                        description="由 Tauri 后端解析得到"
                        value={formatMode(endpoint?.mode)}
                    />
                </ItemGroup>
            </section>

            <section className="flex flex-col gap-3">
                <h4 className="text-sm font-medium">错误信息</h4>
                <ItemGroup className="gap-0 rounded-lg bg-muted/60 p-2">
                    <ReadonlyInfoRow
                        label="最近错误"
                        description="最近一次健康检查失败原因"
                        value={errorMessage ?? "无"}
                    />
                </ItemGroup>
            </section>
        </div>
    );
}
