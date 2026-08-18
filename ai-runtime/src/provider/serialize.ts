import type { AvailableRuntimeModel } from "./service";
import type { ProviderInfo, ProviderModel } from "./types";

export function serializeModel(model: ProviderModel) {
  return {
    id: model.id,
    upstream_id: model.upstreamId,
    name: model.name,
    context_length: model.contextLength,
    output_length: model.outputLength,
    capabilities: {
      supports_tools: model.capabilities.supportsTools,
      supports_vision: model.capabilities.supportsVision,
      supports_reasoning: model.capabilities.supportsReasoning,
      supports_attachments: model.capabilities.supportsAttachments,
      supports_interleaved_reasoning:
        model.capabilities.supportsInterleavedReasoning,
      supports_structured_output: model.capabilities.supportsStructuredOutput,
      temperature: model.capabilities.temperature,
      input_modalities: model.capabilities.inputModalities,
      output_modalities: model.capabilities.outputModalities,
    },
    cost: model.cost,
    source: model.source,
    enabled: model.enabled,
  };
}

export function serializeProviderSummary(provider: ProviderInfo) {
  return {
    id: provider.id,
    name: provider.name,
    api_base: provider.apiBase,
    enabled: provider.enabled,
    source: provider.source,
    has_api_key: provider.apiKey !== null,
    model_count: Object.keys(provider.models).length,
    api_protocol: provider.apiProtocol,
  };
}

export function serializeProviderDetail(provider: ProviderInfo) {
  return {
    ...serializeProviderSummary(provider),
    api_key: provider.apiKey,
    models: Object.fromEntries(
      Object.entries(provider.models).map(([modelId, model]) => [
        modelId,
        serializeModel(model),
      ]),
    ),
  };
}

export function serializeAvailableRuntimeModel(item: AvailableRuntimeModel) {
  return {
    provider_id: item.provider.id,
    provider_name: item.provider.name,
    provider_source: item.provider.source,
    api_protocol: item.provider.apiProtocol,
    model_id: item.model.id,
    model_name: item.model.name,
    upstream_id: item.model.upstreamId,
    context_length: item.model.contextLength,
    output_length: item.model.outputLength,
    capabilities: {
      supports_tools: item.model.capabilities.supportsTools,
      supports_vision: item.model.capabilities.supportsVision,
      supports_reasoning: item.model.capabilities.supportsReasoning,
      supports_attachments: item.model.capabilities.supportsAttachments,
      supports_interleaved_reasoning:
        item.model.capabilities.supportsInterleavedReasoning,
      supports_structured_output: item.model.capabilities.supportsStructuredOutput,
      temperature: item.model.capabilities.temperature,
      input_modalities: item.model.capabilities.inputModalities,
      output_modalities: item.model.capabilities.outputModalities,
    },
    cost: item.model.cost,
    source: item.model.source,
  };
}
