import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    LoaderCircleIcon,
    RefreshCwIcon,
    SearchIcon,
} from "lucide-react";
import { toast } from "@/components/ui/toast";

import { AiRuntimeSettingsGate } from "@/features/settings/panels/AiRuntimeSettingsGate";
import {
    createCustomProvider,
    discoverCustomProviderModels,
    getCatalogStatus,
    getProvider,
    listProviders,
    refreshCatalog,
    testCustomProviderToolCalling,
    updateCustomProvider,
    updateProviderConfig,
    type ProviderSummary,
} from "@/lib/ai-runtime/providers";
import { queryKeys } from "@/lib/query-keys";
import { useAiRuntimeEndpointStore } from "@/store/slices/ai-runtime-endpoint-slice";
import { Button } from "@/components/ui/button";
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
    ItemGroup,
} from "@/components/ui/item";

import { CustomProviderDialog } from "./CustomProviderDialog";
import { CustomProviderRow } from "./CustomProviderRow";
import { ProviderCredentialDialog } from "./ProviderCredentialDialog";
import { ProviderRow } from "./ProviderRow";
import { PreviewPanel } from "./PreviewPanel";
import {
    matchesCustomProvider,
    matchesProvider,
} from "./model-provider-utils";
import { useModelProviderPanelState } from "./useModelProviderPanelState";

function formatCatalogRefreshTime(lastUpdatedAt: number | null): string {
    if (lastUpdatedAt === null) {
        return "上次刷新：暂无记录";
    }

    return `上次刷新：${new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(new Date(lastUpdatedAt))}`;
}

export function ModelProviderPanel() {
    const queryClient = useQueryClient();
    const isAiRuntimeHealthy = useAiRuntimeEndpointStore(
        (state) => state.healthStatus === "healthy",
    );
    const [search, setSearch] = useState("");
    const panelState = useModelProviderPanelState();

    const providersQuery = useQuery({
        queryKey: queryKeys.aiRuntimeProviders(),
        queryFn: ({ signal }) => listProviders(false, signal),
        enabled: isAiRuntimeHealthy,
    });
    const catalogStatusQuery = useQuery({
        queryKey: queryKeys.aiRuntimeCatalogStatus(),
        queryFn: getCatalogStatus,
        enabled: isAiRuntimeHealthy,
    });

    const connectedProviders = useMemo(
        () =>
            (providersQuery.data ?? []).filter(
                (provider) => provider.enabled && provider.hasApiKey,
            ),
        [providersQuery.data],
    );

    const connectedProviderIds = useMemo(
        () => new Set(connectedProviders.map((provider) => provider.id)),
        [connectedProviders],
    );

    const availableProviders = useMemo(
        () =>
            (providersQuery.data ?? [])
                .filter((provider) => !connectedProviderIds.has(provider.id))
                .filter((provider) => matchesProvider(provider, search)),
        [connectedProviderIds, providersQuery.data, search],
    );

    const showCustomProviderRow = matchesCustomProvider(search);

    const invalidateProviders = async () => {
        await Promise.all([
            queryClient.invalidateQueries({
                queryKey: queryKeys.aiRuntimeProviders(),
            }),
            queryClient.invalidateQueries({
                queryKey: queryKeys.aiRuntimeEnabledProviders(),
            }),
            queryClient.invalidateQueries({
                queryKey: queryKeys.aiRuntimeAvailableModels(),
            }),
            queryClient.invalidateQueries({
                queryKey: queryKeys.aiRuntimeCatalogStatus(),
            }),
        ]);
    };

    const connectMutation = useMutation({
        mutationFn: async (provider: ProviderSummary) =>
            updateProviderConfig(provider.id, {
                apiKey: panelState.apiKey.trim() || undefined,
                apiBase: panelState.apiBase.trim() || undefined,
                enabled: true,
            }),
        onSuccess: async () => {
            toast.success(
                panelState.providerConfigDialogMode === "edit"
                    ? "提供商配置已更新"
                    : "提供商已连接",
            );
            panelState.resetProviderConfigForm();
            await invalidateProviders();
        },
    });

    const disconnectMutation = useMutation({
        mutationFn: (provider: ProviderSummary) =>
            updateProviderConfig(provider.id, { enabled: false }),
        onSuccess: async () => {
            toast.success("提供商已断开");
            await invalidateProviders();
        },
    });

    const refreshMutation = useMutation({
        mutationFn: refreshCatalog,
        onSuccess: async (result) => {
            if (result.status === "updated") {
                toast.success("供应商目录已刷新");
            } else {
                toast.warning("目录刷新失败，正在使用已有本地目录");
            }
            await invalidateProviders();
        },
    });

    const createCustomProviderMutation = useMutation({
        mutationFn: () =>
            createCustomProvider({
                id: panelState.customProviderId.trim(),
                name: panelState.customProviderName.trim(),
                apiBase: panelState.customApiBase.trim(),
                apiKey: panelState.customApiKey.trim(),
                models: panelState.customModels,
            }),
        onSuccess: async () => {
            toast.success("自定义供应商已连接");
            panelState.resetCustomProviderForm();
            await invalidateProviders();
        },
    });

    const updateCustomProviderMutation = useMutation({
        mutationFn: () => {
            if (!panelState.editingCustomProvider) {
                throw new Error("未选择要编辑的自定义供应商");
            }

            return updateCustomProvider(panelState.editingCustomProvider.id, {
                name: panelState.customProviderName.trim(),
                apiBase: panelState.customApiBase.trim(),
                apiKey: panelState.customApiKey.trim() || undefined,
                models: panelState.customModels,
            });
        },
        onSuccess: async () => {
            toast.success("自定义供应商已更新");
            panelState.resetCustomProviderForm();
            await invalidateProviders();
        },
    });

    const discoverCustomProviderModelsMutation = useMutation({
        mutationFn: () =>
            discoverCustomProviderModels({
                apiBase: panelState.customApiBase.trim(),
                apiKey: panelState.customApiKey.trim(),
            }),
        onSuccess: (models) => {
            if (models.length === 0) {
                toast.info("没有获取到可用模型，可手动添加模型");
                return;
            }

            panelState.replaceCustomModelRows(models);
            toast.success(`已获取 ${models.length} 个模型，可继续编辑`);
        },
    });

    const testCustomProviderToolCallingMutation = useMutation({
        mutationFn: (modelId: string) =>
            testCustomProviderToolCalling({
                apiBase: panelState.customApiBase.trim(),
                apiKey: panelState.customApiKey.trim(),
                modelId: modelId.trim(),
            }),
        onSuccess: (result) => {
            if (result.supported) {
                toast.success(result.message);
                return;
            }

            toast.error(result.message);
        },
    });

    const editProviderMutation = useMutation({
        mutationFn: (provider: ProviderSummary) => getProvider(provider.id),
        onSuccess: panelState.openProviderDetailForEdit,
    });

    const openEditProviderDialog = (provider: ProviderSummary) => {
        editProviderMutation.mutate(provider);
    };

    const isCustomProviderMutationPending =
        createCustomProviderMutation.isPending ||
        updateCustomProviderMutation.isPending ||
        discoverCustomProviderModelsMutation.isPending ||
        testCustomProviderToolCallingMutation.isPending;

    const submitCustomProvider = () => {
        if (panelState.customDialogMode === "edit") {
            updateCustomProviderMutation.mutate();
            return;
        }

        createCustomProviderMutation.mutate();
    };

    return (
        <AiRuntimeSettingsGate preview={<PreviewPanel />}>
            <div className="flex flex-col gap-8">
                <section className="flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-3">
                        <h4 className="text-sm font-medium">已连接的提供商</h4>
                        <div className="flex items-center gap-3">
                            <span className="text-xs text-muted-foreground">
                                {catalogStatusQuery.isLoading
                                    ? "上次刷新：加载中…"
                                    : formatCatalogRefreshTime(
                                        catalogStatusQuery.data?.lastUpdatedAt ?? null,
                                    )}
                            </span>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={refreshMutation.isPending}
                                onClick={() => refreshMutation.mutate()}
                            >
                                {refreshMutation.isPending ? (
                                    <LoaderCircleIcon
                                        className="animate-spin"
                                        data-icon="inline-start"
                                    />
                                ) : (
                                    <RefreshCwIcon data-icon="inline-start" />
                                )}
                                刷新目录
                            </Button>
                        </div>
                    </div>

                    {providersQuery.isLoading ? (
                        <Empty>
                            <EmptyHeader>
                                <EmptyTitle>正在加载提供商</EmptyTitle>
                                <EmptyDescription>
                                    正在从 AI Runtime 读取供应商配置。
                                </EmptyDescription>
                            </EmptyHeader>
                        </Empty>
                    ) : connectedProviders.length > 0 ? (
                        <ItemGroup className="gap-1.5 p-2">
                            {connectedProviders.map((provider) => (
                                <ProviderRow
                                    key={provider.id}
                                    provider={provider}
                                    action="disconnect"
                                    isPending={
                                        connectMutation.isPending ||
                                        disconnectMutation.isPending ||
                                        editProviderMutation.isPending
                                    }
                                    onConnect={panelState.openConnectDialog}
                                    onEdit={openEditProviderDialog}
                                    onDisconnect={(nextProvider) =>
                                        disconnectMutation.mutate(nextProvider)
                                    }
                                />
                            ))}
                        </ItemGroup>
                    ) : (
                        <Empty>
                            <EmptyHeader>
                                <EmptyTitle>尚未连接提供商</EmptyTitle>
                                <EmptyDescription>
                                    从全部提供商中选择一个并填写 API 密钥。
                                </EmptyDescription>
                            </EmptyHeader>
                        </Empty>
                    )}
                </section>

                <section className="flex flex-col gap-3">
                    <h4 className="text-sm font-medium">全部提供商</h4>
                    <InputGroup>
                        <InputGroupAddon>
                            <SearchIcon />
                        </InputGroupAddon>
                        <InputGroupInput
                            value={search}
                            placeholder="搜索提供商"
                            onChange={(event) => setSearch(event.target.value)}
                        />
                    </InputGroup>

                    {showCustomProviderRow || availableProviders.length > 0 ? (
                        <ItemGroup className="gap-1.5 p-2">
                            {showCustomProviderRow && (
                                <CustomProviderRow
                                    isPending={
                                        createCustomProviderMutation.isPending
                                    }
                                    onConnect={panelState.openCreateCustomProviderDialog}
                                />
                            )}
                            {availableProviders.map((provider) => (
                                <ProviderRow
                                    key={provider.id}
                                    provider={provider}
                                    action="connect"
                                    isPending={connectMutation.isPending}
                                    onConnect={panelState.openConnectDialog}
                                    onEdit={openEditProviderDialog}
                                    onDisconnect={(nextProvider) =>
                                        disconnectMutation.mutate(nextProvider)
                                    }
                                />
                            ))}
                        </ItemGroup>
                    ) : (
                        <Empty>
                            <EmptyHeader>
                                <EmptyTitle>没有匹配的提供商</EmptyTitle>
                                <EmptyDescription>
                                    调整搜索关键词或刷新供应商目录。
                                </EmptyDescription>
                            </EmptyHeader>
                        </Empty>
                    )}
                </section>

                <ProviderCredentialDialog
                    selectedProvider={panelState.selectedProvider}
                    mode={panelState.providerConfigDialogMode}
                    apiKey={panelState.apiKey}
                    apiBase={panelState.apiBase}
                    canSubmit={panelState.canSubmitConnection}
                    isPending={connectMutation.isPending}
                    onOpenChange={panelState.handleProviderConfigDialogOpenChange}
                    onApiKeyChange={panelState.setApiKey}
                    onApiBaseChange={panelState.setApiBase}
                    onCancel={panelState.resetProviderConfigForm}
                    onSubmit={() => {
                        if (panelState.selectedProvider) {
                            connectMutation.mutate(panelState.selectedProvider);
                        }
                    }}
                />

                <CustomProviderDialog
                    mode={panelState.customDialogMode}
                    providerId={panelState.customProviderId}
                    providerName={panelState.customProviderName}
                    apiBase={panelState.customApiBase}
                    apiKey={panelState.customApiKey}
                    modelRows={panelState.customModelRows}
                    canSubmit={panelState.canSubmitCustomProvider}
                    canDiscoverModels={panelState.canDiscoverCustomModels}
                    isPending={isCustomProviderMutationPending}
                    isDiscoveringModels={
                        discoverCustomProviderModelsMutation.isPending
                    }
                    testingModelId={
                        testCustomProviderToolCallingMutation.isPending
                            ? testCustomProviderToolCallingMutation.variables ?? null
                            : null
                    }
                    onOpenChange={panelState.handleCustomDialogOpenChange}
                    onProviderIdChange={panelState.setCustomProviderId}
                    onProviderNameChange={panelState.setCustomProviderName}
                    onApiBaseChange={panelState.setCustomApiBase}
                    onApiKeyChange={panelState.setCustomApiKey}
                    onUpdateModelRow={panelState.updateCustomModelRow}
                    onRemoveModelRow={panelState.removeCustomModelRow}
                    onAddModelRow={panelState.addCustomModelRow}
                    onDiscoverModels={() =>
                        discoverCustomProviderModelsMutation.mutate()
                    }
                    onTestModel={(modelId) =>
                        testCustomProviderToolCallingMutation.mutate(modelId)
                    }
                    onCancel={panelState.resetCustomProviderForm}
                    onSubmit={submitCustomProvider}
                />
            </div>
        </AiRuntimeSettingsGate>
    );
}
