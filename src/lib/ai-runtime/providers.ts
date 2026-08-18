import { aiRuntimeRequest } from "@/lib/ai-runtime/request";

const AI_RUNTIME_V1_PREFIX = "/v1";

export type ProviderSource = "preset" | "custom";

export type ProviderProtocol = "openai" | "anthropic" | "openai_compatible";
export type ModelModality = "text" | "image" | "audio" | "video" | "pdf";

export interface ProviderSummary {
    id: string;
    name: string;
    apiBase: string;
    enabled: boolean;
    source: ProviderSource;
    hasApiKey: boolean;
    modelCount: number;
    apiProtocol: ProviderProtocol;
}

export interface ModelCapabilities {
    supportsTools: boolean;
    supportsVision: boolean;
    supportsReasoning: boolean;
    supportsAttachments: boolean;
    supportsInterleavedReasoning: boolean;
    supportsStructuredOutput: boolean;
    temperature: boolean;
    inputModalities: ModelModality[];
    outputModalities: ModelModality[];
}

export interface ModelCost {
    input: number;
    output: number;
}

export interface ProviderModel {
    id: string;
    providerId: string;
    upstreamId: string;
    name: string;
    contextLength: number;
    outputLength: number;
    capabilities: ModelCapabilities;
    cost: ModelCost;
    source: ProviderSource;
    enabled: boolean;
}

export interface AvailableRuntimeModel {
    providerId: string;
    providerName: string;
    providerSource: ProviderSource;
    apiProtocol: ProviderProtocol;
    modelId: string;
    modelName: string;
    upstreamId: string;
    contextLength: number;
    outputLength: number;
    capabilities: ModelCapabilities;
    cost: ModelCost;
    source: ProviderSource;
}

export interface ProviderDetail extends ProviderSummary {
    apiKey: string | null;
    models: Record<string, ProviderModel>;
}

export interface ProviderConfigUpdate {
    apiKey?: string;
    enabled?: boolean;
    apiBase?: string;
}

export interface CustomProviderCreate {
    id: string;
    name: string;
    apiBase: string;
    apiKey: string;
    models?: Record<string, Record<string, unknown>>;
}

export interface CustomProviderUpdate {
    name: string;
    apiBase: string;
    apiKey?: string;
    models?: Record<string, Record<string, unknown>>;
}

export interface CustomProviderModelDiscoveryInput {
    apiBase: string;
    apiKey: string;
}

export interface DiscoveredCustomProviderModel {
    id: string;
    name: string;
}

export interface CustomProviderToolCallingTestInput {
    apiBase: string;
    apiKey: string;
    modelId: string;
}

export type CustomProviderToolCallingTestResult =
    | { supported: true; message: string }
    | {
        supported: false;
        reason:
            | "authentication"
            | "model_unavailable"
            | "unsupported"
            | "timeout"
            | "network"
            | "unknown";
        message: string;
    };

interface RawProviderSummary {
    id: string;
    name: string;
    api_base: string;
    enabled: boolean;
    source: ProviderSource;
    has_api_key: boolean;
    model_count: number;
    api_protocol: ProviderProtocol;
}

interface RawProviderConfigResponse {
    id: string;
    name: string;
    api_base: string;
    enabled: boolean;
    has_api_key: boolean;
    api_protocol: ProviderProtocol;
}

interface RawProviderModel {
    id: string;
    upstream_id: string;
    name: string;
    context_length: number;
    output_length: number;
    capabilities: {
        supports_tools: boolean;
        supports_vision: boolean;
        supports_reasoning: boolean;
        supports_attachments: boolean;
        supports_interleaved_reasoning: boolean;
        supports_structured_output: boolean;
        temperature: boolean;
        input_modalities: ModelModality[];
        output_modalities: ModelModality[];
    };
    cost: ModelCost;
    source: ProviderSource;
    enabled?: boolean;
}

interface RawAvailableRuntimeModel {
    provider_id: string;
    provider_name: string;
    provider_source: ProviderSource;
    api_protocol: ProviderProtocol;
    model_id: string;
    model_name: string;
    upstream_id: string;
    context_length: number;
    output_length: number;
    capabilities: {
        supports_tools: boolean;
        supports_vision: boolean;
        supports_reasoning: boolean;
        supports_attachments: boolean;
        supports_interleaved_reasoning: boolean;
        supports_structured_output: boolean;
        temperature: boolean;
        input_modalities: ModelModality[];
        output_modalities: ModelModality[];
    };
    cost: ModelCost;
    source: ProviderSource;
}

interface RawProviderDetail extends RawProviderSummary {
    api_key?: string | null;
    models: Record<string, RawProviderModel>;
}

interface ProviderListResponse {
    providers: RawProviderSummary[];
}

interface AvailableRuntimeModelsResponse {
    models: RawAvailableRuntimeModel[];
    default_model: {
        provider_id: string;
        model_id: string;
    } | null;
}

export type CatalogRefreshStatus = "updated" | "using_cache";

export interface CatalogRefreshResponse {
    status: CatalogRefreshStatus;
    provider_count: number;
    last_updated_at: number | null;
}

interface CatalogStatusResponse {
    last_updated_at: number | null;
}

interface CustomProviderModelDiscoveryResponse {
    models: DiscoveredCustomProviderModel[];
}

function toProviderSummary(raw: RawProviderSummary): ProviderSummary {
    return {
        id: raw.id,
        name: raw.name,
        apiBase: raw.api_base,
        enabled: raw.enabled,
        source: raw.source,
        hasApiKey: raw.has_api_key,
        modelCount: raw.model_count,
        apiProtocol: raw.api_protocol,
    };
}

function toProviderModel(
    providerId: string,
    raw: RawProviderModel,
): ProviderModel {
    return {
        id: raw.id,
        providerId,
        upstreamId: raw.upstream_id,
        name: raw.name,
        contextLength: raw.context_length,
        outputLength: raw.output_length,
        capabilities: {
            supportsTools: raw.capabilities.supports_tools,
            supportsVision: raw.capabilities.supports_vision,
            supportsReasoning: raw.capabilities.supports_reasoning,
            supportsAttachments: raw.capabilities.supports_attachments,
            supportsInterleavedReasoning:
                raw.capabilities.supports_interleaved_reasoning,
            supportsStructuredOutput:
                raw.capabilities.supports_structured_output,
            temperature: raw.capabilities.temperature,
            inputModalities: raw.capabilities.input_modalities,
            outputModalities: raw.capabilities.output_modalities,
        },
        cost: raw.cost,
        source: raw.source,
        enabled: raw.enabled ?? true,
    };
}

function toAvailableRuntimeModel(
    raw: RawAvailableRuntimeModel,
): AvailableRuntimeModel {
    return {
        providerId: raw.provider_id,
        providerName: raw.provider_name,
        providerSource: raw.provider_source,
        apiProtocol: raw.api_protocol,
        modelId: raw.model_id,
        modelName: raw.model_name,
        upstreamId: raw.upstream_id,
        contextLength: raw.context_length,
        outputLength: raw.output_length,
        capabilities: {
            supportsTools: raw.capabilities.supports_tools,
            supportsVision: raw.capabilities.supports_vision,
            supportsReasoning: raw.capabilities.supports_reasoning,
            supportsAttachments: raw.capabilities.supports_attachments,
            supportsInterleavedReasoning:
                raw.capabilities.supports_interleaved_reasoning,
            supportsStructuredOutput:
                raw.capabilities.supports_structured_output,
            temperature: raw.capabilities.temperature,
            inputModalities: raw.capabilities.input_modalities,
            outputModalities: raw.capabilities.output_modalities,
        },
        cost: raw.cost,
        source: raw.source,
    };
}

function toProviderDetail(raw: RawProviderDetail): ProviderDetail {
    return {
        ...toProviderSummary(raw),
        apiKey: raw.api_key ?? null,
        models: Object.fromEntries(
            Object.entries(raw.models).map(([modelId, model]) => [
                modelId,
                toProviderModel(raw.id, model),
            ]),
        ),
    };
}

function toProviderConfigBody(update: ProviderConfigUpdate) {
    return {
        api_key: update.apiKey,
        enabled: update.enabled,
        api_base: update.apiBase,
    };
}

export async function listProviders(
    enabledOnly = false,
    signal?: AbortSignal,
): Promise<ProviderSummary[]> {
    const query = enabledOnly ? "?enabled_only=true" : "";
    const response = await aiRuntimeRequest<ProviderListResponse>(
        `${AI_RUNTIME_V1_PREFIX}/providers${query}`,
        { signal },
    );

    return response.providers.map(toProviderSummary);
}

export async function listAvailableRuntimeModels(
    signal?: AbortSignal,
): Promise<AvailableRuntimeModel[]> {
    const response = await aiRuntimeRequest<AvailableRuntimeModelsResponse>(
        `${AI_RUNTIME_V1_PREFIX}/models/available`,
        { signal },
    );

    return response.models.map(toAvailableRuntimeModel);
}

export async function getProvider(
    providerId: string,
    signal?: AbortSignal,
): Promise<ProviderDetail> {
    const response = await aiRuntimeRequest<RawProviderDetail>(
        `${AI_RUNTIME_V1_PREFIX}/providers/${encodeURIComponent(providerId)}`,
        { signal },
    );

    return toProviderDetail(response);
}

export async function updateProviderConfig(
    providerId: string,
    update: ProviderConfigUpdate,
): Promise<ProviderSummary> {
    const response = await aiRuntimeRequest<RawProviderConfigResponse>(
        `${AI_RUNTIME_V1_PREFIX}/providers/${encodeURIComponent(providerId)}/config`,
        {
            method: "PUT",
            json: toProviderConfigBody(update),
        },
    );

    return toProviderSummary({
        ...response,
        source: "preset",
        model_count: 0,
    });
}

export async function createCustomProvider(
    input: CustomProviderCreate,
): Promise<ProviderDetail> {
    const response = await aiRuntimeRequest<RawProviderDetail>(
        `${AI_RUNTIME_V1_PREFIX}/custom-providers`,
        {
            method: "POST",
            json: {
                id: input.id,
                name: input.name,
                api_base: input.apiBase,
                api_key: input.apiKey,
                models: input.models,
            },
        },
    );

    return toProviderDetail(response);
}

export async function discoverCustomProviderModels(
    input: CustomProviderModelDiscoveryInput,
): Promise<DiscoveredCustomProviderModel[]> {
    const response = await aiRuntimeRequest<CustomProviderModelDiscoveryResponse>(
        `${AI_RUNTIME_V1_PREFIX}/custom-providers/discover-models`,
        {
            method: "POST",
            json: {
                api_base: input.apiBase,
                api_key: input.apiKey,
            },
        },
    );

    return response.models;
}

export async function testCustomProviderToolCalling(
    input: CustomProviderToolCallingTestInput,
): Promise<CustomProviderToolCallingTestResult> {
    return aiRuntimeRequest<CustomProviderToolCallingTestResult>(
        `${AI_RUNTIME_V1_PREFIX}/custom-providers/test-tool-calling`,
        {
            method: "POST",
            json: {
                api_base: input.apiBase,
                api_key: input.apiKey,
                model_id: input.modelId,
            },
        },
    );
}

export async function updateCustomProvider(
    providerId: string,
    input: CustomProviderUpdate,
): Promise<ProviderDetail> {
    const response = await aiRuntimeRequest<RawProviderDetail>(
        `${AI_RUNTIME_V1_PREFIX}/custom-providers/${encodeURIComponent(providerId)}`,
        {
            method: "PUT",
            json: {
                name: input.name,
                api_base: input.apiBase,
                api_key: input.apiKey,
                models: input.models,
            },
        },
    );

    return toProviderDetail(response);
}

export async function deleteCustomProvider(providerId: string): Promise<void> {
    await aiRuntimeRequest<{ deleted: boolean }>(
        `${AI_RUNTIME_V1_PREFIX}/custom-providers/${encodeURIComponent(providerId)}`,
        { method: "DELETE" },
    );
}

export async function getCatalogStatus(): Promise<{ lastUpdatedAt: number | null }> {
    const response = await aiRuntimeRequest<CatalogStatusResponse>(
        `${AI_RUNTIME_V1_PREFIX}/catalog/status`,
    );

    return { lastUpdatedAt: response.last_updated_at };
}

export async function refreshCatalog(): Promise<CatalogRefreshResponse> {
    const response = await aiRuntimeRequest<CatalogRefreshResponse>(
        `${AI_RUNTIME_V1_PREFIX}/catalog/refresh`,
        { method: "POST" },
    );

    return {
        status: response.status,
        provider_count: response.provider_count,
        last_updated_at: response.last_updated_at,
    };
}

export async function updateModelConfig(
    providerId: string,
    modelId: string,
    enabled: boolean,
): Promise<ProviderModel> {
    const response = await aiRuntimeRequest<RawProviderModel>(
        `${AI_RUNTIME_V1_PREFIX}/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}/config`,
        {
            method: "PUT",
            json: { enabled },
        },
    );

    return toProviderModel(providerId, response);
}
