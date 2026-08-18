import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  CatalogRefreshResult,
  CatalogService,
  CatalogStatus,
} from "./catalog";
import type {
  ModelModality,
  ProviderInfo,
  ProviderModel,
  ProviderProtocol,
} from "./types";

const NPM_TO_PROTOCOL: Record<string, ProviderProtocol> = {
  "@ai-sdk/openai": "openai",
  "@ai-sdk/anthropic": "anthropic",
  "@ai-sdk/openai-compatible": "openai_compatible",
};

interface ProviderServiceOptions {
  catalog: CatalogService;
  providersPath: string;
}

export interface AvailableRuntimeModel {
  provider: ProviderInfo;
  model: ProviderModel;
}

interface AddCustomProviderInput {
  providerId: string;
  name: string;
  apiBase: string;
  apiKey: string;
  models?: Record<string, Record<string, unknown>>;
}

interface UpdateCustomProviderInput {
  providerId: string;
  name: string;
  apiBase: string;
  apiKey?: string;
  models?: Record<string, Record<string, unknown>>;
}

type UserConfig = Record<string, Record<string, unknown>>;

export class ProviderService {
  private providers: Record<string, ProviderInfo> = {};
  private models: Map<string, ProviderModel> = new Map();
  private userConfig: UserConfig = {};

  constructor(private readonly options: ProviderServiceOptions) {}

  async initialize(): Promise<void> {
    const rawCatalog = await this.options.catalog.get();
    this.providers = {};
    this.models = new Map();

    for (const [providerId, rawProvider] of Object.entries(rawCatalog)) {
      const provider = fromModelsDevProvider(providerId, rawProvider);
      if (provider === null) {
        continue;
      }

      this.providers[providerId] = provider;
      for (const [modelId, model] of Object.entries(provider.models)) {
        this.models.set(modelKey(providerId, modelId), model);
      }
    }

    this.userConfig = await this.loadUserConfig();
    this.applyUserConfig();
  }

  async refreshCatalog(force: boolean): Promise<CatalogRefreshResult> {
    const result = await this.options.catalog.refresh(force);
    if (result.status !== "unavailable") {
      await this.initialize();
    }
    return result;
  }

  async getCatalogStatus(): Promise<CatalogStatus> {
    return this.options.catalog.getStatus();
  }

  hasStaleCatalogCache(): boolean {
    return this.options.catalog.isCacheStale();
  }

  listProviders(enabledOnly = false): ProviderInfo[] {
    const providers = Object.values(this.providers);
    if (!enabledOnly) {
      return providers;
    }
    return providers.filter((provider) => provider.enabled && Boolean(provider.apiKey));
  }

  getProvider(providerId: string): ProviderInfo | null {
    return this.providers[providerId] ?? null;
  }

  getModel(providerId: string, modelId: string): ProviderModel | null {
    return this.models.get(modelKey(providerId, modelId)) ?? null;
  }

  listAvailableModels(): AvailableRuntimeModel[] {
    const result: AvailableRuntimeModel[] = [];

    for (const provider of Object.values(this.providers)) {
      if (!provider.enabled || !provider.apiKey) {
        continue;
      }

      for (const model of Object.values(provider.models)) {
        if (!model.enabled) {
          continue;
        }

        result.push({ provider, model });
      }
    }

    return result.sort((left, right) => {
      const providerCompare = left.provider.name.localeCompare(
        right.provider.name,
        "zh-CN",
      );
      if (providerCompare !== 0) {
        return providerCompare;
      }

      return left.model.name.localeCompare(right.model.name, "zh-CN");
    });
  }

  updateProviderConfig(input: {
    providerId: string;
    apiKey?: string | null;
    enabled?: boolean | null;
    apiBase?: string | null;
  }): ProviderInfo | null {
    const provider = this.getProvider(input.providerId);
    if (!provider) {
      return null;
    }

    const config = (this.userConfig[input.providerId] ??= {});
    if (input.apiKey !== undefined && input.apiKey !== null && input.apiKey !== "") {
      config.api_key = input.apiKey;
      provider.apiKey = input.apiKey;
    }
    if (input.enabled !== undefined && input.enabled !== null) {
      config.enabled = input.enabled;
      provider.enabled = input.enabled;
    }
    if (input.apiBase !== undefined && input.apiBase !== null && input.apiBase !== "") {
      config.api_base = input.apiBase;
      provider.apiBase = input.apiBase;
    }

    this.saveUserConfig();
    return provider;
  }

  updateModelConfig(providerId: string, modelId: string, enabled: boolean): ProviderModel | null {
    const provider = this.getProvider(providerId);
    const model = this.getModel(providerId, modelId);
    if (!provider || !model) {
      return null;
    }

    const config = (this.userConfig[providerId] ??= {});
    const disabledModels = new Set<string>(stringArray(config.disabled_models));
    if (enabled) {
      disabledModels.delete(modelId);
    } else {
      disabledModels.add(modelId);
    }

    if (disabledModels.size > 0) {
      config.disabled_models = [...disabledModels].sort();
    } else {
      delete config.disabled_models;
    }

    model.enabled = enabled;
    this.saveUserConfig();
    return model;
  }

  addCustomProvider(input: AddCustomProviderInput): ProviderInfo {
    this.userConfig[input.providerId] = {
      name: input.name,
      api_base: input.apiBase,
      api_key: input.apiKey,
      enabled: true,
      models: input.models ?? {},
    };
    this.saveUserConfig();

    const existing = this.providers[input.providerId];
    if (existing) {
      existing.apiKey = input.apiKey;
      existing.enabled = true;
      existing.apiBase = input.apiBase;
      existing.source = "custom";
    } else {
      this.providers[input.providerId] = {
        id: input.providerId,
        name: input.name,
        apiBase: input.apiBase,
        apiKey: input.apiKey,
        enabled: true,
        source: "custom",
        apiProtocol: "openai_compatible",
        models: {},
      };
    }

    this.applyUserConfig();
    return this.providers[input.providerId];
  }

  updateCustomProvider(input: UpdateCustomProviderInput): ProviderInfo | null {
    const provider = this.getProvider(input.providerId);
    if (!provider || provider.source !== "custom") {
      return null;
    }

    const config = this.userConfig[input.providerId] ?? {};
    const nextModels = input.models ?? {};
    config.name = input.name;
    config.api_base = input.apiBase;
    config.enabled = true;
    config.models = nextModels;
    if (input.apiKey !== undefined && input.apiKey !== "") {
      config.api_key = input.apiKey;
    } else if (!config.api_key && provider.apiKey) {
      config.api_key = provider.apiKey;
    }
    const disabledModels = stringArray(config.disabled_models).filter((modelId) =>
      Object.prototype.hasOwnProperty.call(nextModels, modelId),
    );
    if (disabledModels.length > 0) {
      config.disabled_models = disabledModels;
    } else {
      delete config.disabled_models;
    }

    this.userConfig[input.providerId] = config;
    this.saveUserConfig();

    for (const key of [...this.models.keys()]) {
      if (key.startsWith(`${input.providerId}:`)) {
        this.models.delete(key);
      }
    }
    provider.models = {};
    this.applyUserConfig();
    return this.getProvider(input.providerId);
  }

  removeCustomProvider(providerId: string): boolean {
    delete this.userConfig[providerId];
    this.saveUserConfig();

    const provider = this.getProvider(providerId);
    if (provider?.source === "custom") {
      delete this.providers[providerId];
      for (const key of [...this.models.keys()]) {
        if (key.startsWith(`${providerId}:`)) {
          this.models.delete(key);
        }
      }
      return true;
    }

    if (provider) {
      provider.apiKey = null;
      provider.enabled = false;
    }
    return false;
  }

  private applyUserConfig(): void {
    for (const [providerId, config] of Object.entries(this.userConfig)) {
      if (!this.providers[providerId]) {
        this.providers[providerId] = {
          id: providerId,
          name: stringOrDefault(config.name, providerId),
          apiBase: stringOrDefault(config.api_base, ""),
          apiKey: null,
          enabled: false,
          source: "custom",
          apiProtocol: "openai_compatible",
          models: {},
        };
      }

      const provider = this.providers[providerId];
      provider.apiKey = typeof config.api_key === "string" ? config.api_key : null;
      provider.enabled = typeof config.enabled === "boolean" ? config.enabled : true;
      if (typeof config.api_base === "string") {
        provider.apiBase = config.api_base;
      }
      if (typeof config.name === "string" && provider.source === "custom") {
        provider.name = config.name;
      }

      const customModels = isRecord(config.models) ? config.models : {};
      for (const [modelId, modelConfig] of Object.entries(customModels)) {
        const model = fromCustomModel(providerId, modelId, asRecord(modelConfig));
        provider.models[modelId] = model;
        this.models.set(modelKey(providerId, modelId), model);
      }

      const disabledModels = new Set<string>(stringArray(config.disabled_models));
      for (const [modelId, model] of Object.entries(provider.models)) {
        model.enabled = !disabledModels.has(modelId);
      }
    }
  }

  private async loadUserConfig(): Promise<UserConfig> {
    if (!this.options.providersPath) {
      return {};
    }

    try {
      const file = Bun.file(this.options.providersPath);
      if (!(await file.exists())) {
        return {};
      }
      const data = await file.json();
      return isRecord(data) ? (data as UserConfig) : {};
    } catch {
      return {};
    }
  }

  private saveUserConfig(): void {
    if (!this.options.providersPath) {
      return;
    }

    mkdirSync(dirname(this.options.providersPath), { recursive: true });
    writeFileSync(this.options.providersPath, `${JSON.stringify(this.userConfig, null, 2)}\n`);
  }
}

function modelKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

function fromModelsDevProvider(providerId: string, raw: unknown): ProviderInfo | null {
  if (!isRecord(raw)) {
    return null;
  }

  const npm = typeof raw.npm === "string" ? raw.npm : "";
  const protocol = NPM_TO_PROTOCOL[npm];
  if (!protocol) {
    return null;
  }

  const models: Record<string, ProviderModel> = {};
  const rawModels = isRecord(raw.models) ? raw.models : {};
  for (const [modelId, rawModel] of Object.entries(rawModels)) {
    models[modelId] = fromModelsDevModel(providerId, modelId, rawModel);
  }

  return {
    id: providerId,
    name: stringOrDefault(raw.name, providerId),
    apiBase: stringOrDefault(raw.api, ""),
    apiKey: null,
    enabled: false,
    source: "preset",
    apiProtocol: protocol,
    models,
  };
}

function fromModelsDevModel(providerId: string, modelId: string, raw: unknown): ProviderModel {
  const item = asRecord(raw);
  const limit = asRecord(item.limit);
  const cost = asRecord(item.cost);
  const modalities = asRecord(item.modalities);
  const inputModalities = modelModalities(modalities.input);
  const outputModalities = modelModalities(modalities.output);

  return {
    id: modelId,
    providerId,
    upstreamId: modelId,
    name: stringOrDefault(item.name, modelId),
    contextLength: numberOrDefault(limit.context, 128_000),
    outputLength: numberOrDefault(limit.output, 4_096),
    capabilities: {
      supportsTools: item.tool_call === true,
      supportsVision: inputModalities.some((modality) =>
        ["image", "video", "pdf"].includes(modality),
      ),
      supportsReasoning: item.reasoning === true,
      supportsAttachments: item.attachment === true,
      supportsInterleavedReasoning: isRecord(item.interleaved),
      supportsStructuredOutput: item.structured_output === true,
      temperature: item.temperature === true,
      inputModalities,
      outputModalities,
    },
    cost: {
      input: numberOrDefault(cost.input, 0),
      output: numberOrDefault(cost.output, 0),
    },
    source: "preset",
    enabled: true,
  };
}

function fromCustomModel(
  providerId: string,
  modelId: string,
  modelConfig: Record<string, unknown>,
): ProviderModel {
  const caps = asRecord(modelConfig.capabilities);
  const inputModalities = modelModalities(caps.input_modalities);
  return {
    id: modelId,
    providerId,
    upstreamId: stringOrDefault(modelConfig.upstream_id, modelId),
    name: stringOrDefault(modelConfig.name, modelId),
    contextLength: numberOrDefault(modelConfig.context_length, 128_000),
    outputLength: numberOrDefault(modelConfig.output_length, 4_096),
    capabilities: {
      supportsTools: caps.supports_tools !== false,
      supportsVision:
        caps.supports_vision === true ||
        inputModalities.some((modality) =>
          ["image", "video", "pdf"].includes(modality),
        ),
      supportsReasoning: caps.supports_reasoning === true,
      supportsAttachments: caps.supports_attachments === true,
      supportsInterleavedReasoning: caps.supports_interleaved_reasoning === true,
      supportsStructuredOutput: caps.supports_structured_output === true,
      temperature: caps.temperature === true,
      inputModalities,
      outputModalities: modelModalities(caps.output_modalities),
    },
    cost: { input: 0, output: 0 },
    source: "custom",
    enabled: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function modelModalities(value: unknown): ModelModality[] {
  const supportedModalities: ModelModality[] = [
    "text",
    "image",
    "audio",
    "video",
    "pdf",
  ];

  return stringArray(value).filter((modality): modality is ModelModality =>
    supportedModalities.includes(modality as ModelModality),
  );
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}
