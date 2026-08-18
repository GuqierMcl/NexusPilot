import { describe, expect, test } from "bun:test";
import {
  createProviderLanguageModel,
  ProviderLanguageModelError,
  resolveProviderLanguageModel,
  type ProviderLanguageModelService,
} from "../src/provider/language-model";
import type { ProviderInfo, ProviderModel } from "../src/provider/types";

function createModel(overrides: Partial<ProviderModel> = {}): ProviderModel {
  return {
    id: "gpt-4o",
    providerId: "openai",
    upstreamId: "gpt-4o",
    name: "GPT-4o",
    contextLength: 128_000,
    outputLength: 4096,
    capabilities: {
      supportsTools: false,
      supportsVision: false,
      supportsReasoning: false,
      supportsAttachments: false,
      supportsInterleavedReasoning: false,
      supportsStructuredOutput: false,
      temperature: true,
      inputModalities: ["text"],
      outputModalities: ["text"],
    },
    cost: { input: 0, output: 0 },
    source: "preset",
    enabled: true,
    ...overrides,
  };
}

function createProvider(overrides: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: "openai",
    name: "OpenAI",
    apiBase: "https://api.openai.com/v1",
    apiKey: "test-key",
    enabled: true,
    source: "preset",
    apiProtocol: "openai",
    models: {
      "gpt-4o": createModel(),
    },
    ...overrides,
  };
}

function service(
  provider: ProviderInfo | null,
  model: ProviderModel | null,
): ProviderLanguageModelService {
  return {
    getProvider: () => provider,
    getModel: () => model,
  };
}

function languageModelId(model: unknown): string | undefined {
  return typeof model === "object" && model !== null && "modelId" in model
    ? String(model.modelId)
    : undefined;
}

function languageModelIncludeUsage(model: unknown): boolean | undefined {
  if (typeof model !== "object" || model === null || !("config" in model)) {
    return undefined;
  }

  const config = model.config;
  return typeof config === "object" && config !== null && "includeUsage" in config
    ? Boolean(config.includeUsage)
    : undefined;
}

describe("resolveProviderLanguageModel", () => {
  test("resolves enabled provider and model metadata", () => {
    const provider = createProvider();
    const model = createModel();

    const resolved = resolveProviderLanguageModel(service(provider, model), {
      providerId: "openai",
      modelId: "gpt-4o",
    });

    expect(resolved.provider).toBe(provider);
    expect(resolved.modelInfo).toBe(model);
    expect(resolved.runtimeContext.provider).toEqual({
      providerId: "openai",
      modelId: "gpt-4o",
      modelName: "GPT-4o",
      contextLength: 128_000,
      outputLength: 4096,
      supportsTools: false,
      supportsReasoning: false,
      supportsVision: false,
    });
  });

  test("throws runtime error when provider is missing", () => {
    expect(() =>
      resolveProviderLanguageModel(service(null, null), {
        providerId: "missing",
        modelId: "gpt-4o",
      }),
    ).toThrow("Provider missing not found");
  });

  test("throws runtime error when provider has no api key", () => {
    expect(() =>
      resolveProviderLanguageModel(service(createProvider({ apiKey: null }), createModel()), {
        providerId: "openai",
        modelId: "gpt-4o",
      }),
    ).toThrow("Provider openai is not ready for model execution");
  });

  test("throws runtime error when model is disabled", () => {
    expect(() =>
      resolveProviderLanguageModel(
        service(createProvider(), createModel({ enabled: false })),
        {
          providerId: "openai",
          modelId: "gpt-4o",
        },
      ),
    ).toThrow("Model openai/gpt-4o is disabled");
  });
});

describe("createProviderLanguageModel", () => {
  test("creates language models for supported protocols", () => {
    expect(
      languageModelId(createProviderLanguageModel(createProvider(), "gpt-4o")),
    ).toBe("gpt-4o");
    expect(
      languageModelId(
        createProviderLanguageModel(
          createProvider({
            id: "anthropic",
            apiProtocol: "anthropic",
            apiBase: "https://api.anthropic.com/v1",
            models: {},
          }),
          "claude-sonnet-4-5",
        ),
      ),
    ).toBe("claude-sonnet-4-5");
    expect(
      languageModelId(
        createProviderLanguageModel(
          createProvider({
            id: "custom",
            apiProtocol: "openai_compatible",
            apiBase: "https://example.test/v1",
            source: "custom",
            models: {},
          }),
          "custom-model",
        ),
      ),
    ).toBe("custom-model");
  });

  test("rejects openai-compatible providers without api base", () => {
    expect(() =>
      createProviderLanguageModel(
        createProvider({
          id: "custom",
          apiProtocol: "openai_compatible",
          apiBase: "",
          source: "custom",
          models: {},
        }),
        "custom-model",
      ),
    ).toThrow(
      "OpenAI-compatible provider custom requires a non-empty API base URL",
    );
  });

  test("reports invalid openai-compatible api base as route-friendly provider error", () => {
    try {
      createProviderLanguageModel(
        createProvider({
          id: "custom",
          apiProtocol: "openai_compatible",
          apiBase: "",
          source: "custom",
          models: {},
        }),
        "custom-model",
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderLanguageModelError);
      expect((error as ProviderLanguageModelError).status).toBe(400);
      return;
    }

    throw new Error("Expected provider language model error");
  });

  test("enables usage extraction for openai-compatible providers", () => {
    const model = createProviderLanguageModel(
      createProvider({
        id: "custom",
        apiProtocol: "openai_compatible",
        apiBase: "https://example.test/v1",
        source: "custom",
        models: {},
      }),
      "custom-model",
    );

    expect(languageModelIncludeUsage(model)).toBe(true);
  });
});
