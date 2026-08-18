import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    BrainIcon,
    BracesIcon,
    FileInputIcon,
    FileOutputIcon,
    PaperclipIcon,
    SearchIcon,
    ThermometerIcon,
    type LucideIcon,
    WaypointsIcon,
    WrenchIcon,
} from "lucide-react";
import { toast } from "@/components/ui/toast";

import { ProviderLogoAvatar } from "@/components/provider/provider-logo-avatar";
import { AiRuntimeSettingsGate } from "@/features/settings/panels/AiRuntimeSettingsGate";
import {
    getProvider,
    listProviders,
    updateModelConfig,
    type ProviderDetail,
    type ModelModality,
    type ProviderModel,
    type ProviderProtocol,
} from "@/lib/ai-runtime/providers";
import { queryKeys } from "@/lib/query-keys";
import { useAiRuntimeEndpointStore } from "@/store/slices/ai-runtime-endpoint-slice";
import { Badge } from "@/components/ui/badge";
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyTitle,
} from "@/components/ui/empty";
import {
    InputGroup,
    InputGroupAddon,
    InputGroupInput,
} from "@/components/ui/input-group";
import {
    Item,
    ItemActions,
    ItemContent,
    ItemDescription,
    ItemGroup,
    ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";

interface ModelMutationVariables {
    providerId: string;
    modelId: string;
    enabled: boolean;
}

const PROTOCOL_LABELS: Record<ProviderProtocol, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    openai_compatible: "OpenAI 兼容",
};

const MODALITY_LABELS: Record<ModelModality, string> = {
    text: "文本",
    image: "图像",
    audio: "音频",
    video: "视频",
    pdf: "PDF",
};

function formatTokenCount(value: number): string {
    return new Intl.NumberFormat("zh-CN").format(value);
}

function matchesModel(
    provider: ProviderDetail,
    model: ProviderModel,
    search: string,
): boolean {
    const keyword = search.trim().toLowerCase();
    if (!keyword) {
        return true;
    }

    return (
        provider.name.toLowerCase().includes(keyword) ||
        provider.id.toLowerCase().includes(keyword) ||
        model.name.toLowerCase().includes(keyword) ||
        model.id.toLowerCase().includes(keyword)
    );
}

interface ModelCapability {
    label: string;
    icon: LucideIcon;
}

function primaryModelCapabilities(model: ProviderModel): ModelCapability[] {
    const capabilities: ModelCapability[] = [];
    if (model.capabilities.supportsReasoning) {
        capabilities.push({ label: "推理", icon: BrainIcon });
    }
    if (model.capabilities.supportsTools) {
        capabilities.push({ label: "工具", icon: WrenchIcon });
    }
    if (model.capabilities.supportsStructuredOutput) {
        capabilities.push({ label: "结构化输出", icon: BracesIcon });
    }

    return capabilities;
}

function additionalModelCapabilities(model: ProviderModel): ModelCapability[] {
    const capabilities: ModelCapability[] = [];
    if (model.capabilities.supportsAttachments) {
        capabilities.push({ label: "附件", icon: PaperclipIcon });
    }
    if (model.capabilities.supportsInterleavedReasoning) {
        capabilities.push({ label: "交错式推理", icon: WaypointsIcon });
    }
    if (model.capabilities.temperature) {
        capabilities.push({ label: "温度参数", icon: ThermometerIcon });
    }

    return capabilities;
}

function formatModalities(modalities: ModelModality[]): string {
    return modalities.map((modality) => MODALITY_LABELS[modality]).join("、");
}

function PreviewPanel() {
    return (
        <div className="flex flex-col gap-5">
            <Skeleton className="h-9 w-full" />
            <section className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                    <Skeleton className="size-8 rounded-full" />
                    <Skeleton className="h-4 w-32" />
                </div>
                <ItemGroup className="gap-1.5 p-2">
                    {[0, 1, 2].map((index) => (
                        <Item
                            key={index}
                            variant="default"
                            className="border-border/60 bg-background"
                        >
                            <ItemContent>
                                <Skeleton
                                    className={
                                        index === 0 ? "h-4 w-36" : "h-4 w-44"
                                    }
                                />
                            </ItemContent>
                            <ItemActions>
                                <Skeleton className="h-5 w-9 rounded-full" />
                            </ItemActions>
                        </Item>
                    ))}
                </ItemGroup>
            </section>
        </div>
    );
}

interface ModelRowProps {
    model: ProviderModel;
    isPending: boolean;
    onToggle: (enabled: boolean) => void;
}

function ModelRow({ model, isPending, onToggle }: ModelRowProps) {
    const primaryCapabilities = primaryModelCapabilities(model);
    const additionalCapabilities = additionalModelCapabilities(model);

    return (
        <Item
            variant="default"
            className="border-border/60 bg-background hover:bg-muted/30"
        >
            <ItemContent>
                <ItemTitle className="w-full flex-wrap gap-1.5 line-clamp-none">
                    <span className="truncate">{model.name}</span>
                    {primaryCapabilities.map(({ label, icon: Icon }) => (
                        <Badge key={label} variant="secondary">
                            <Icon aria-hidden="true" />
                            {label}
                        </Badge>
                    ))}
                </ItemTitle>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {model.capabilities.inputModalities.length > 0 ? (
                        <span className="flex items-center gap-1">
                            <FileInputIcon className="size-3.5" aria-hidden="true" />
                            输入：{formatModalities(model.capabilities.inputModalities)}
                        </span>
                    ) : null}
                    {model.capabilities.outputModalities.length > 0 ? (
                        <span className="flex items-center gap-1">
                            <FileOutputIcon className="size-3.5" aria-hidden="true" />
                            输出：{formatModalities(model.capabilities.outputModalities)}
                        </span>
                    ) : null}
                    {additionalCapabilities.length > 0 ? (
                        <Tooltip>
                            <TooltipTrigger
                                render={
                                    <Badge variant="outline" className="h-5 px-1.5">
                                        更多能力 +{additionalCapabilities.length}
                                    </Badge>
                                }
                            />
                            <TooltipContent>
                                <div className="flex flex-col gap-1">
                                    {additionalCapabilities.map(({ label, icon: Icon }) => (
                                        <span key={label} className="flex items-center gap-1.5">
                                            <Icon className="size-3.5" aria-hidden="true" />
                                            {label}
                                        </span>
                                    ))}
                                </div>
                            </TooltipContent>
                        </Tooltip>
                    ) : null}
                </div>
                <ItemDescription>
                    {model.id} · 上下文 {formatTokenCount(model.contextLength)}
                </ItemDescription>
            </ItemContent>
            <ItemActions>
                <Switch
                    checked={model.enabled}
                    disabled={isPending}
                    aria-label={`${model.name} 启用状态`}
                    onCheckedChange={onToggle}
                />
            </ItemActions>
        </Item>
    );
}

export function ModelListPanel() {
    const queryClient = useQueryClient();
    const isAiRuntimeHealthy = useAiRuntimeEndpointStore(
        (state) => state.healthStatus === "healthy",
    );
    const [search, setSearch] = useState("");

    const enabledProvidersQuery = useQuery({
        queryKey: queryKeys.aiRuntimeEnabledProviders(),
        queryFn: ({ signal }) => listProviders(true, signal),
        enabled: isAiRuntimeHealthy,
    });

    const enabledProviderIds = useMemo(
        () => (enabledProvidersQuery.data ?? []).map((provider) => provider.id),
        [enabledProvidersQuery.data],
    );

    const providerDetailsQuery = useQuery({
        queryKey: [
            ...queryKeys.aiRuntimeEnabledProviders(),
            "details",
            enabledProviderIds.join("|"),
        ] as const,
        queryFn: ({ signal }) =>
            Promise.all(
                enabledProviderIds.map((providerId) =>
                    getProvider(providerId, signal),
                ),
            ),
        enabled: isAiRuntimeHealthy && enabledProviderIds.length > 0,
    });

    const visibleProviderGroups = useMemo(
        () =>
            (providerDetailsQuery.data ?? [])
                .map((provider) => ({
                    provider,
                    models: Object.values(provider.models).filter((model) =>
                        matchesModel(provider, model, search),
                    ),
                }))
                .filter((group) => group.models.length > 0),
        [providerDetailsQuery.data, search],
    );

    const modelMutation = useMutation({
        mutationFn: ({ providerId, modelId, enabled }: ModelMutationVariables) =>
            updateModelConfig(providerId, modelId, enabled),
        onSuccess: async () => {
            toast.success("模型配置已更新");
            await Promise.all([
                queryClient.invalidateQueries({
                    queryKey: queryKeys.aiRuntimeProviders(),
                }),
                queryClient.invalidateQueries({
                    queryKey: queryKeys.aiRuntimeAvailableModels(),
                }),
            ]);
        },
    });

    const pendingVariables = modelMutation.isPending
        ? modelMutation.variables
        : undefined;
    const pendingModelKey = pendingVariables
        ? `${pendingVariables.providerId}:${pendingVariables.modelId}`
        : null;

    const isLoading =
        enabledProvidersQuery.isLoading ||
        (enabledProviderIds.length > 0 && providerDetailsQuery.isLoading);

    return (
        <AiRuntimeSettingsGate preview={<PreviewPanel />}>
            <div className="flex flex-col gap-5">
                <InputGroup>
                    <InputGroupAddon>
                        <SearchIcon />
                    </InputGroupAddon>
                    <InputGroupInput
                        value={search}
                        placeholder="搜索模型"
                        onChange={(event) => setSearch(event.target.value)}
                    />
                </InputGroup>

                {isLoading && (
                    <Empty>
                        <EmptyHeader>
                            <EmptyTitle>正在加载模型</EmptyTitle>
                            <EmptyDescription>
                                正在从已连接的提供商读取模型列表。
                            </EmptyDescription>
                        </EmptyHeader>
                    </Empty>
                )}

                {!isLoading && enabledProviderIds.length === 0 && (
                    <Empty>
                        <EmptyHeader>
                            <EmptyTitle>尚未连接提供商</EmptyTitle>
                            <EmptyDescription>
                                请先在供应商页面连接至少一个提供商。
                            </EmptyDescription>
                        </EmptyHeader>
                    </Empty>
                )}

                {!isLoading &&
                    enabledProviderIds.length > 0 &&
                    visibleProviderGroups.length === 0 && (
                        <Empty>
                            <EmptyHeader>
                                <EmptyTitle>没有匹配的模型</EmptyTitle>
                                <EmptyDescription>
                                    调整搜索关键词后再试。
                                </EmptyDescription>
                            </EmptyHeader>
                        </Empty>
                    )}

                {visibleProviderGroups.map(({ provider, models }) => (
                    <section key={provider.id} className="flex flex-col gap-3">
                        <div className="flex items-center gap-2">
                            <ProviderLogoAvatar
                                providerId={provider.id}
                                providerName={provider.name}
                            />
                            <h4 className="text-sm font-medium">
                                {provider.name}
                            </h4>
                            <Badge variant="secondary">
                                {PROTOCOL_LABELS[provider.apiProtocol]}
                            </Badge>
                        </div>
                        <ItemGroup className="gap-1.5 p-2">
                            {models.map((model) => (
                                <ModelRow
                                    key={model.id}
                                    model={model}
                                    isPending={
                                        pendingModelKey ===
                                        `${provider.id}:${model.id}`
                                    }
                                    onToggle={(enabled) =>
                                        modelMutation.mutate({
                                            providerId: provider.id,
                                            modelId: model.id,
                                            enabled,
                                        })
                                    }
                                />
                            ))}
                        </ItemGroup>
                    </section>
                ))}
            </div>
        </AiRuntimeSettingsGate>
    );
}
