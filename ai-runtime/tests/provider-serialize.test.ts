import { describe, expect, test } from "bun:test";
import {
  serializeModel,
  serializeProviderDetail,
  serializeProviderSummary,
} from "../src/provider/serialize";
import type { ProviderInfo } from "../src/provider/types";

function sampleProvider(): ProviderInfo {
  return {
    id: "openai",
    name: "OpenAI",
    apiBase: "https://api.openai.com/v1",
    apiKey: "sk-test",
    enabled: true,
    source: "preset",
    apiProtocol: "openai",
    models: {
      "gpt-4o": {
        id: "gpt-4o",
        providerId: "openai",
        upstreamId: "gpt-4o",
        name: "GPT-4o",
        contextLength: 128000,
        outputLength: 4096,
        capabilities: {
          supportsTools: true,
          supportsVision: true,
          supportsReasoning: false,
          supportsAttachments: true,
          supportsInterleavedReasoning: true,
          supportsStructuredOutput: true,
          temperature: false,
          inputModalities: ["text", "image"],
          outputModalities: ["text"],
        },
        cost: { input: 2.5, output: 10 },
        source: "preset",
        enabled: true,
      },
    },
  };
}

describe("provider serialization", () => {
  test("serializes provider summary in snake_case", () => {
    expect(serializeProviderSummary(sampleProvider())).toEqual({
      id: "openai",
      name: "OpenAI",
      api_base: "https://api.openai.com/v1",
      enabled: true,
      source: "preset",
      has_api_key: true,
      model_count: 1,
      api_protocol: "openai",
    });
  });

  test("serializes model in snake_case", () => {
    const model = sampleProvider().models["gpt-4o"];
    expect(serializeModel(model)).toEqual({
      id: "gpt-4o",
      upstream_id: "gpt-4o",
      name: "GPT-4o",
      context_length: 128000,
      output_length: 4096,
      capabilities: {
        supports_tools: true,
        supports_vision: true,
        supports_reasoning: false,
        supports_attachments: true,
        supports_interleaved_reasoning: true,
        supports_structured_output: true,
        temperature: false,
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
      },
      cost: { input: 2.5, output: 10 },
      source: "preset",
      enabled: true,
    });
  });

  test("serializes provider detail including api_key and models", () => {
    const detail = serializeProviderDetail(sampleProvider());
    expect(detail.api_key).toBe("sk-test");
    expect(detail.models["gpt-4o"].upstream_id).toBe("gpt-4o");
  });
});
