import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type AppFactoryDeps } from "../src/app";
import { sampleModelsDevCatalog } from "../src/testing/fixtures";

let tempDirs: string[] = [];

async function appWithConfig(
  userConfig: unknown = {},
  deps: AppFactoryDeps = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "nexpilot-routes-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "catalog.json"), JSON.stringify(sampleModelsDevCatalog));
  writeFileSync(join(dir, "providers.json"), JSON.stringify(userConfig));

  return createApp(
    {
      host: "127.0.0.1",
      port: 8787,
      dataDir: dir,
      catalogPath: join(dir, "catalog.json"),
      providersPath: join(dir, "providers.json"),
      runtimeDbPath: "",
    },
    {
      fetchCatalog: async () => sampleModelsDevCatalog,
      ...deps,
    },
  );
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("provider routes", () => {
  test("lists providers", async () => {
    const app = await appWithConfig();
    const response = await app.handle(new Request("http://localhost/v1/providers"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0].id).toBe("openai");
    expect(body.providers[0].api_protocol).toBe("openai");
  });

  test("filters enabled providers", async () => {
    const app = await appWithConfig({ openai: { api_key: "sk-test", enabled: true } });
    const response = await app.handle(
      new Request("http://localhost/v1/providers?enabled_only=true"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.providers.map((provider: { id: string }) => provider.id)).toEqual(["openai"]);
  });

  test("gets provider detail", async () => {
    const app = await appWithConfig({ openai: { api_key: "sk-test", enabled: true } });
    const response = await app.handle(new Request("http://localhost/v1/providers/openai"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.api_key).toBe("sk-test");
    expect(body.models["gpt-4o"].upstream_id).toBe("gpt-4o");
  });

  test("lists available runtime models from enabled providers with api keys", async () => {
    const app = await appWithConfig({ openai: { api_key: "sk-test", enabled: true } });
    const response = await app.handle(new Request("http://localhost/v1/models/available"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.models[0]).toMatchObject({
      provider_id: "openai",
      provider_name: "OpenAI",
      api_protocol: "openai",
      model_id: "gpt-4o",
    });
    expect(body.models[0]).not.toHaveProperty("api_key");
    expect(body.default_model).toEqual({
      provider_id: "openai",
      model_id: "gpt-4o",
    });
  });

  test("returns no available runtime models when provider is not connected", async () => {
    const app = await appWithConfig();
    const response = await app.handle(new Request("http://localhost/v1/models/available"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      models: [],
      default_model: null,
    });
  });

  test("excludes enabled providers without api keys from available runtime models", async () => {
    const app = await appWithConfig({ openai: { enabled: true } });
    const response = await app.handle(new Request("http://localhost/v1/models/available"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      models: [],
      default_model: null,
    });
  });

  test("excludes disabled providers with api keys from available runtime models", async () => {
    const app = await appWithConfig({ openai: { api_key: "sk-test", enabled: false } });
    const response = await app.handle(new Request("http://localhost/v1/models/available"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      models: [],
      default_model: null,
    });
  });

  test("excludes disabled models from available runtime models", async () => {
    const app = await appWithConfig({
      openai: {
        api_key: "sk-test",
        enabled: true,
        disabled_models: ["gpt-4o"],
      },
    });
    const response = await app.handle(new Request("http://localhost/v1/models/available"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(
      body.models.some(
        (model: { provider_id: string; model_id: string }) =>
          model.provider_id === "openai" && model.model_id === "gpt-4o",
      ),
    ).toBe(false);
  });

  test("lists enabled custom provider models as available runtime models", async () => {
    const app = await appWithConfig({
      custom: {
        type: "custom",
        name: "Custom",
        api_base: "https://proxy.example.com/v1",
        api_key: "custom-key",
        enabled: true,
        models: {
          "custom-model": {
            name: "Custom Model",
            upstream_id: "custom-upstream",
            enabled: true,
          },
        },
      },
    });
    const response = await app.handle(new Request("http://localhost/v1/models/available"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.models).toContainEqual(
      expect.objectContaining({
        provider_id: "custom",
        provider_name: "Custom",
        api_protocol: "openai_compatible",
        model_id: "custom-model",
        upstream_id: "custom-upstream",
      }),
    );
  });

  test("updates provider config", async () => {
    const app = await appWithConfig();
    const response = await app.handle(
      new Request("http://localhost/v1/providers/openai/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: "sk-test", enabled: true }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.has_api_key).toBe(true);
    expect(body.enabled).toBe(true);
  });

  test("rejects null provider config fields", async () => {
    const app = await appWithConfig();
    const response = await app.handle(
      new Request("http://localhost/v1/providers/openai/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: null }),
      }),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: "Invalid request body" });
  });

  test("rejects malformed provider config JSON as a stable client error", async () => {
    const app = await appWithConfig();
    const response = await app.handle(
      new Request("http://localhost/v1/providers/openai/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: "Invalid request body" });
  });

  test("updates model config", async () => {
    const app = await appWithConfig();
    const response = await app.handle(
      new Request("http://localhost/v1/providers/openai/models/gpt-4o/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.enabled).toBe(false);
  });

  test("rejects invalid model config body", async () => {
    const app = await appWithConfig();
    const response = await app.handle(
      new Request("http://localhost/v1/providers/openai/models/gpt-4o/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: "Invalid request body" });
  });

  test("creates updates and deletes custom provider", async () => {
    const app = await appWithConfig();

    const createResponse = await app.handle(
      new Request("http://localhost/v1/custom-providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "custom",
          name: "Custom",
          api_base: "https://proxy.example.com/v1",
          api_key: "custom-key",
          models: {},
        }),
      }),
    );
    expect(createResponse.status).toBe(200);

    const updateResponse = await app.handle(
      new Request("http://localhost/v1/custom-providers/custom", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Renamed",
          api_base: "https://renamed.example.com/v1",
          models: {},
        }),
      }),
    );
    const updateBody = await updateResponse.json();
    expect(updateResponse.status).toBe(200);
    expect(updateBody.name).toBe("Renamed");

    const deleteResponse = await app.handle(
      new Request("http://localhost/v1/custom-providers/custom", {
        method: "DELETE",
      }),
    );
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toEqual({ deleted: true });
  });

  test("rejects invalid custom provider body", async () => {
    const app = await appWithConfig();
    const response = await app.handle(
      new Request("http://localhost/v1/custom-providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "custom",
          name: "Custom",
          api_base: "https://proxy.example.com/v1",
        }),
      }),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: "Invalid request body" });
  });

  test("rejects malformed custom provider JSON as a stable client error", async () => {
    const app = await appWithConfig();
    const response = await app.handle(
      new Request("http://localhost/v1/custom-providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: "Invalid request body" });
  });

  test("discovers OpenAI-compatible models without creating a provider", async () => {
    const app = await appWithConfig({}, {
      discoverOpenAICompatibleModels: async ({ apiBase, apiKey }) => {
        expect(apiBase).toBe("https://proxy.example.com/v1");
        expect(apiKey).toBe("discovery-key");
        return [
          { id: "model-a", name: "Model A" },
          { id: "model-b", name: "model-b" },
        ];
      },
    });

    const response = await app.handle(
      new Request("http://localhost/v1/custom-providers/discover-models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_base: "https://proxy.example.com/v1",
          api_key: "discovery-key",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      models: [
        { id: "model-a", name: "Model A" },
        { id: "model-b", name: "model-b" },
      ],
    });

    const providerResponse = await app.handle(
      new Request("http://localhost/v1/providers/custom"),
    );
    expect(providerResponse.status).toBe(404);
  });

  test("tests OpenAI-compatible tool calling without persisting the temporary credentials", async () => {
    const app = await appWithConfig({}, {
      testOpenAICompatibleToolCalling: async ({ apiBase, apiKey, modelId }) => {
        expect(apiBase).toBe("https://proxy.example.com/v1");
        expect(apiKey).toBe("probe-key");
        expect(modelId).toBe("model-a");
        return {
          supported: true,
          message: "已验证：该模型支持 OpenAI-compatible 工具调用。",
        };
      },
    });

    const response = await app.handle(
      new Request("http://localhost/v1/custom-providers/test-tool-calling", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_base: "https://proxy.example.com/v1",
          api_key: "probe-key",
          model_id: "model-a",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      supported: true,
      message: "已验证：该模型支持 OpenAI-compatible 工具调用。",
    });
    expect(
      await app.handle(new Request("http://localhost/v1/providers/custom")),
    ).toHaveProperty("status", 404);
  });

  test("rejects incomplete tool calling test input", async () => {
    const app = await appWithConfig();
    const response = await app.handle(
      new Request("http://localhost/v1/custom-providers/test-tool-calling", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_base: "https://proxy.example.com/v1",
          api_key: "probe-key",
        }),
      }),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: "Invalid request body" });
  });

  test("refreshes catalog", async () => {
    const app = await appWithConfig();
    const response = await app.handle(
      new Request("http://localhost/v1/catalog/refresh", {
        method: "POST",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("updated");
    expect(body.provider_count).toBe(1);
    expect(body.last_updated_at).toBeGreaterThan(0);
  });

  test("returns the last catalog update time", async () => {
    const app = await appWithConfig();
    const response = await app.handle(
      new Request("http://localhost/v1/catalog/status"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.last_updated_at).toBeGreaterThan(0);
  });
});
