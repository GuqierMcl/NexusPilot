import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { RunContextSnapshot, RuntimeError } from "../runtime";
import type { ProviderInfo, ProviderModel } from "./types";

export interface ProviderLanguageModelService {
  getProvider(providerId: string): ProviderInfo | null;
  getModel(providerId: string, modelId: string): ProviderModel | null;
}

export interface ProviderLanguageModelInput {
  providerId: string;
  modelId: string;
}

export interface ResolvedProviderLanguageModel {
  provider: ProviderInfo;
  modelInfo: ProviderModel;
  languageModel: LanguageModel;
  runtimeContext: Pick<RunContextSnapshot, "provider">;
}

export class ProviderLanguageModelError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly runtimeError: RuntimeError,
  ) {
    super(message);
    this.name = "ProviderLanguageModelError";
  }
}

export function resolveProviderLanguageModel(
  service: ProviderLanguageModelService,
  input: ProviderLanguageModelInput,
): ResolvedProviderLanguageModel {
  const provider = service.getProvider(input.providerId);
  if (!provider) {
    throw new ProviderLanguageModelError(
      `Provider ${input.providerId} not found`,
      404,
      { name: "ProviderNotFoundError", data: { providerId: input.providerId } },
    );
  }

  if (!provider.enabled || !provider.apiKey) {
    throw new ProviderLanguageModelError(
      `Provider ${input.providerId} is not ready for model execution`,
      401,
      {
        name: "ProviderAuthError",
        data: {
          providerId: input.providerId,
          message: "Provider is disabled or missing an API key",
        },
      },
    );
  }

  const modelInfo = service.getModel(input.providerId, input.modelId);
  if (!modelInfo) {
    throw new ProviderLanguageModelError(
      `Model ${input.providerId}/${input.modelId} not found`,
      404,
      {
        name: "ModelNotFoundError",
        data: {
          providerId: input.providerId,
          modelId: input.modelId,
        },
      },
    );
  }

  if (!modelInfo.enabled) {
    throw new ProviderLanguageModelError(
      `Model ${input.providerId}/${input.modelId} is disabled`,
      400,
      {
        name: "ModelDisabledError",
        data: {
          providerId: input.providerId,
          modelId: input.modelId,
        },
      },
    );
  }

  return {
    provider,
    modelInfo,
    languageModel: createProviderLanguageModel(provider, modelInfo.upstreamId),
    runtimeContext: {
      provider: {
        providerId: provider.id,
        modelId: modelInfo.id,
        modelName: modelInfo.name,
        contextLength: modelInfo.contextLength,
        outputLength: modelInfo.outputLength,
        supportsTools: modelInfo.capabilities.supportsTools,
        supportsReasoning: modelInfo.capabilities.supportsReasoning,
        supportsVision: modelInfo.capabilities.supportsVision,
      },
    },
  };
}

export function createProviderLanguageModel(
  provider: ProviderInfo,
  modelId = Object.values(provider.models)[0]?.upstreamId ?? "",
): LanguageModel {
  const apiBase = provider.apiBase.trim();

  if (provider.apiProtocol === "openai") {
    return createOpenAI({
      apiKey: provider.apiKey ?? "",
      baseURL: apiBase || undefined,
    }).languageModel(modelId);
  }

  if (provider.apiProtocol === "anthropic") {
    return createAnthropic({
      apiKey: provider.apiKey ?? "",
      baseURL: apiBase || undefined,
    }).languageModel(modelId);
  }

  if (!apiBase) {
    throw new ProviderLanguageModelError(
      `OpenAI-compatible provider ${provider.id} requires a non-empty API base URL`,
      400,
      {
        name: "UnknownError",
        data: {
          message: `Provider ${provider.id}: OpenAI-compatible providers require a non-empty API base URL`,
        },
      },
    );
  }

  return createOpenAICompatible({
    name: provider.id,
    apiKey: provider.apiKey ?? "",
    baseURL: apiBase,
    includeUsage: true,
  }).languageModel(modelId);
}
