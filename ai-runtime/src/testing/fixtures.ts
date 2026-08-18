export const sampleModelsDevCatalog = {
  openai: {
    id: "openai",
    name: "OpenAI",
    npm: "@ai-sdk/openai",
    api: "https://api.openai.com/v1",
    models: {
      "gpt-4o": {
        id: "gpt-4o",
        name: "GPT-4o",
        attachment: true,
        tool_call: true,
        reasoning: false,
        structured_output: true,
        temperature: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 128000, output: 4096 },
        cost: { input: 2.5, output: 10 },
      },
      "gpt-4o-mini": {
        id: "gpt-4o-mini",
        name: "GPT-4o mini",
        attachment: false,
        tool_call: true,
        reasoning: false,
        interleaved: { field: "reasoning_content" },
        structured_output: false,
        temperature: false,
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 128000, output: 4096 },
        cost: { input: 0.15, output: 0.6 },
      },
    },
  },
  unsupported: {
    id: "unsupported",
    name: "Unsupported",
    npm: "@ai-sdk/not-supported",
    api: "https://example.com",
    models: {},
  },
};

export const sampleUserConfig = {
  openai: {
    api_key: "sk-test",
    enabled: true,
    disabled_models: ["gpt-4o-mini"],
  },
};
