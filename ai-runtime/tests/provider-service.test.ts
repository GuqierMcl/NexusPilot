import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogService } from "../src/provider/catalog";
import { ProviderService } from "../src/provider/service";
import { sampleModelsDevCatalog } from "../src/testing/fixtures";

let tempDirs: string[] = [];

function setupFiles(userConfig: unknown = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nexpilot-provider-"));
  tempDirs.push(dir);
  const catalogPath = join(dir, "catalog.json");
  const providersPath = join(dir, "providers.json");
  writeFileSync(catalogPath, JSON.stringify(sampleModelsDevCatalog));
  writeFileSync(providersPath, JSON.stringify(userConfig));
  return { catalogPath, providersPath };
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("ProviderService", () => {
  test("loads supported providers from models.dev and filters unsupported npm", async () => {
    const files = setupFiles();
    const catalog = new CatalogService({ catalogPath: files.catalogPath });
    const service = new ProviderService({ catalog, providersPath: files.providersPath });

    await service.initialize();

    expect(service.listProviders().map((provider) => provider.id)).toEqual(["openai"]);
    expect(service.getProvider("unsupported")).toBeNull();
    expect(service.getProvider("openai")?.apiProtocol).toBe("openai");
    expect(service.getProvider("openai")?.models["gpt-4o"].capabilities).toMatchObject({
      supportsTools: true,
      supportsVision: true,
      supportsAttachments: true,
      supportsStructuredOutput: true,
      temperature: true,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
    });
    expect(
      service.getProvider("openai")?.models["gpt-4o-mini"].capabilities
        .supportsInterleavedReasoning,
    ).toBe(true);
  });

  test("merges user api key, enabled flag, and disabled models", async () => {
    const files = setupFiles({
      openai: {
        api_key: "sk-test",
        enabled: true,
        disabled_models: ["gpt-4o-mini"],
      },
    });
    const service = new ProviderService({
      catalog: new CatalogService({ catalogPath: files.catalogPath }),
      providersPath: files.providersPath,
    });

    await service.initialize();

    const provider = service.getProvider("openai");
    expect(provider?.apiKey).toBe("sk-test");
    expect(provider?.enabled).toBe(true);
    expect(provider?.models["gpt-4o"].enabled).toBe(true);
    expect(provider?.models["gpt-4o-mini"].enabled).toBe(false);
    expect(service.listProviders(true).map((item) => item.id)).toEqual(["openai"]);
  });

  test("updates provider and model config and persists user config", async () => {
    const files = setupFiles();
    const service = new ProviderService({
      catalog: new CatalogService({ catalogPath: files.catalogPath }),
      providersPath: files.providersPath,
    });
    await service.initialize();

    const provider = service.updateProviderConfig({
      providerId: "openai",
      apiKey: "sk-test",
      enabled: true,
      apiBase: "https://proxy.example.com/v1",
    });
    const model = service.updateModelConfig("openai", "gpt-4o", false);
    const persisted = JSON.parse(readFileSync(files.providersPath, "utf-8"));

    expect(provider?.apiKey).toBe("sk-test");
    expect(provider?.apiBase).toBe("https://proxy.example.com/v1");
    expect(model?.enabled).toBe(false);
    expect(persisted.openai).toMatchObject({
      api_key: "sk-test",
      enabled: true,
      api_base: "https://proxy.example.com/v1",
      disabled_models: ["gpt-4o"],
    });
  });

  test("creates and updates custom provider", async () => {
    const files = setupFiles();
    const service = new ProviderService({
      catalog: new CatalogService({ catalogPath: files.catalogPath }),
      providersPath: files.providersPath,
    });
    await service.initialize();

    const created = service.addCustomProvider({
      providerId: "custom",
      name: "Custom",
      apiBase: "https://proxy.example.com/v1",
      apiKey: "custom-key",
      models: {
        "custom-model": {
          name: "Custom Model",
          upstream_id: "real-model",
          context_length: 32000,
          capabilities: { supports_tools: true },
        },
      },
    });

    expect(created.source).toBe("custom");
    expect(created.models["custom-model"].upstreamId).toBe("real-model");

    const updated = service.updateCustomProvider({
      providerId: "custom",
      name: "Renamed",
      apiBase: "https://renamed.example.com/v1",
      models: {},
    });

    expect(updated?.name).toBe("Renamed");
    expect(Object.keys(updated?.models ?? {})).toEqual([]);
  });

  test("enables custom model tool calling by default but honors an explicit opt-out", async () => {
    const files = setupFiles();
    const service = new ProviderService({
      catalog: new CatalogService({ catalogPath: files.catalogPath }),
      providersPath: files.providersPath,
    });
    await service.initialize();

    const provider = service.addCustomProvider({
      providerId: "custom",
      name: "Custom",
      apiBase: "https://proxy.example.com/v1",
      apiKey: "custom-key",
      models: {
        default: { name: "Default tool model" },
        "tools-disabled": {
          name: "Text only model",
          capabilities: { supports_tools: false },
        },
      },
    });

    expect(provider.models.default?.capabilities.supportsTools).toBe(true);
    expect(provider.models["tools-disabled"]?.capabilities.supportsTools).toBe(false);
  });

  test("preserves disabled custom models that still exist after provider update", async () => {
    const files = setupFiles();
    const service = new ProviderService({
      catalog: new CatalogService({ catalogPath: files.catalogPath }),
      providersPath: files.providersPath,
    });
    await service.initialize();

    service.addCustomProvider({
      providerId: "custom",
      name: "Custom",
      apiBase: "https://proxy.example.com/v1",
      apiKey: "custom-key",
      models: {
        "custom-model": {
          name: "Custom Model",
          upstream_id: "real-model",
        },
        "removed-model": {
          name: "Removed Model",
        },
      },
    });
    service.updateModelConfig("custom", "custom-model", false);
    service.updateModelConfig("custom", "removed-model", false);

    const updated = service.updateCustomProvider({
      providerId: "custom",
      name: "Renamed",
      apiBase: "https://renamed.example.com/v1",
      models: {
        "custom-model": {
          name: "Custom Model",
          upstream_id: "real-model",
        },
      },
    });
    const persisted = JSON.parse(readFileSync(files.providersPath, "utf-8"));

    expect(updated?.models["custom-model"].enabled).toBe(false);
    expect(persisted.custom.disabled_models).toEqual(["custom-model"]);
  });

  test("removes custom provider but only disables preset provider", async () => {
    const files = setupFiles({
      openai: { api_key: "sk-test", enabled: true },
    });
    const service = new ProviderService({
      catalog: new CatalogService({ catalogPath: files.catalogPath }),
      providersPath: files.providersPath,
    });
    await service.initialize();

    service.addCustomProvider({
      providerId: "custom",
      name: "Custom",
      apiBase: "https://proxy.example.com/v1",
      apiKey: "custom-key",
      models: {},
    });

    expect(service.removeCustomProvider("custom")).toBe(true);
    expect(service.getProvider("custom")).toBeNull();

    expect(service.removeCustomProvider("openai")).toBe(false);
    expect(service.getProvider("openai")?.enabled).toBe(false);
    expect(service.getProvider("openai")?.apiKey).toBeNull();
  });
});
