import type {
    ProviderModel,
    ProviderProtocol,
    ProviderSummary,
} from "@/lib/ai-runtime/providers";

export interface CustomModelDraft {
    key: string;
    id: string;
    name: string;
    supportsTools: boolean;
}

export function providerCredentialLabel(provider: ProviderSummary): string {
    return provider.source === "custom" ? "自定义" : "API 密钥";
}

export const PROTOCOL_LABELS: Record<ProviderProtocol, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    openai_compatible: "OpenAI 兼容",
};

export function matchesProvider(provider: ProviderSummary, search: string): boolean {
    const keyword = search.trim().toLowerCase();
    if (!keyword) {
        return true;
    }

    return (
        provider.name.toLowerCase().includes(keyword) ||
        provider.id.toLowerCase().includes(keyword)
    );
}

export function matchesCustomProvider(search: string): boolean {
    const keyword = search.trim().toLowerCase();
    if (!keyword) {
        return true;
    }

    return (
        "自定义供应商".includes(keyword) ||
        "custom provider".includes(keyword) ||
        "openai compatible".includes(keyword)
    );
}

export function createCustomModelDraft(
    model?: Partial<Pick<CustomModelDraft, "id" | "name" | "supportsTools">>,
): CustomModelDraft {
    return {
        key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        id: model?.id ?? "",
        name: model?.name ?? "",
        supportsTools: model?.supportsTools ?? true,
    };
}

export function buildCustomModels(
    rows: CustomModelDraft[],
): Record<string, Record<string, unknown>> {
    return Object.fromEntries(
        rows
            .map((row) => ({
                id: row.id.trim(),
                name: row.name.trim(),
                supportsTools: row.supportsTools,
            }))
            .filter((row) => row.id.length > 0)
            .map((row) => [
                row.id,
                {
                    name: row.name || row.id,
                    upstream_id: row.id,
                    capabilities: {
                        supports_tools: row.supportsTools,
                    },
                },
            ]),
    );
}

export function customModelDraftsFromModels(
    models: Record<string, ProviderModel>,
): CustomModelDraft[] {
    const rows = Object.values(models).map((model) =>
        createCustomModelDraft({
            id: model.id,
            name: model.name === model.id ? "" : model.name,
            supportsTools: model.capabilities.supportsTools,
        }),
    );

    return rows.length > 0 ? rows : [createCustomModelDraft()];
}
