import { Elysia } from "elysia";
import { detailError } from "../core/errors";
import type { CatalogService } from "../provider/catalog";
import {
  discoverOpenAICompatibleModels,
  ModelDiscoveryError,
} from "../provider/model-discovery";
import {
  customProviderCreateSchema,
  customProviderModelDiscoverySchema,
  customProviderToolCallingTestSchema,
  customProviderUpdateSchema,
  modelConfigUpdateSchema,
  parseRequestJsonBody,
  providerConfigUpdateSchema,
} from "../provider/schemas";
import type { ProviderService } from "../provider/service";
import { testOpenAICompatibleToolCalling } from "../provider/tool-call-compatibility";
import {
  serializeAvailableRuntimeModel,
  serializeModel,
  serializeProviderDetail,
  serializeProviderSummary,
} from "../provider/serialize";
import {
  booleanSchema,
  customModelsSchema as customModelsOpenApiSchema,
  jsonRequestBody,
  stringSchema,
} from "./openapi";

export interface ProviderRouteDeps {
  providerService: ProviderService | null;
  catalog: CatalogService | null;
  discoverOpenAICompatibleModels?: typeof discoverOpenAICompatibleModels;
  testOpenAICompatibleToolCalling?: typeof testOpenAICompatibleToolCalling;
}

export function providerRoutes(deps: ProviderRouteDeps) {
  function serviceOrNull() {
    return deps.providerService;
  }

  return new Elysia({ prefix: "/v1", name: "provider-routes" })
    .get("/providers", ({ query }) => {
      const service = serviceOrNull();
      if (!service) return detailError(503, "ProviderService not initialized");

      const enabledOnly = query.enabled_only === "true";
      return {
        providers: service.listProviders(enabledOnly).map(serializeProviderSummary),
      };
    }, {
      detail: {
        tags: ["供应商与模型"],
        summary: "列出供应商",
        description: "列出 provider 摘要，可按启用状态过滤。",
        parameters: [
          {
            name: "enabled_only",
            in: "query",
            required: false,
            description: "传入 true 时仅返回已启用的 provider。",
            schema: {
              type: "string",
              enum: ["true", "false"],
            },
          },
        ],
      },
    })
    .get("/providers/:providerId", ({ params }) => {
      const service = serviceOrNull();
      if (!service) return detailError(503, "ProviderService not initialized");

      const provider = service.getProvider(params.providerId);
      if (!provider) return detailError(404, `Provider ${params.providerId} not found`);

      return serializeProviderDetail(provider);
    }, {
      detail: {
        tags: ["供应商与模型"],
        summary: "获取供应商详情",
        description: "返回 provider 元数据、runtime 配置状态和模型详情。",
      },
    })
    .get("/models/available", () => {
      const service = serviceOrNull();
      if (!service) return detailError(503, "ProviderService not initialized");

      const models = service.listAvailableModels().map(serializeAvailableRuntimeModel);

      return {
        models,
        default_model: models[0]
          ? {
              provider_id: models[0].provider_id,
              model_id: models[0].model_id,
            }
          : null,
      };
    }, {
      detail: {
        tags: ["供应商与模型"],
        summary: "列出可用于 Runtime Run 的模型",
        description:
          "返回已启用 provider、已配置 API key 且模型 enabled 的扁平模型列表。该接口不保存用户当前选择，也不会返回 API key。",
      },
    })
    .put("/providers/:providerId/config", async ({ params, request }) => {
      const service = serviceOrNull();
      if (!service) return detailError(503, "ProviderService not initialized");

      const body = await parseRequestJsonBody(providerConfigUpdateSchema, request);
      if (!body) return detailError(422, "Invalid request body");
      const provider = service.updateProviderConfig({
        providerId: params.providerId,
        apiKey: body.api_key,
        enabled: body.enabled,
        apiBase: body.api_base,
      });
      if (!provider) return detailError(404, `Provider ${params.providerId} not found`);

      return {
        id: provider.id,
        name: provider.name,
        api_base: provider.apiBase,
        enabled: provider.enabled,
        has_api_key: provider.apiKey !== null,
        api_protocol: provider.apiProtocol,
      };
    }, {
      detail: {
        tags: ["供应商与模型"],
        summary: "更新供应商配置",
        description: "更新 provider 的 API key、启用状态和 API base。",
        requestBody: jsonRequestBody({
          type: "object",
          properties: {
            api_key: {
              ...stringSchema,
              description: "Provider API key；省略表示不修改。",
            },
            enabled: {
              ...booleanSchema,
              description: "是否启用该 provider；省略表示不修改。",
            },
            api_base: {
              ...stringSchema,
              description: "自定义 API base；省略表示不修改。",
            },
          },
        }),
      },
    })
    .put("/providers/:providerId/models/:modelId/config", async ({ params, request }) => {
      const service = serviceOrNull();
      if (!service) return detailError(503, "ProviderService not initialized");

      const body = await parseRequestJsonBody(modelConfigUpdateSchema, request);
      if (!body) return detailError(422, "Invalid request body");
      const model = service.updateModelConfig(
        params.providerId,
        params.modelId,
        body.enabled,
      );
      if (!model) {
        return detailError(
          404,
          `Provider ${params.providerId} or model ${params.modelId} not found`,
        );
      }

      return serializeModel(model);
    }, {
      detail: {
        tags: ["供应商与模型"],
        summary: "更新模型配置",
        description: "更新 provider model 是否允许在 runtime 中使用。",
        requestBody: jsonRequestBody({
          type: "object",
          required: ["enabled"],
          properties: {
            enabled: {
              ...booleanSchema,
              description: "是否允许该模型在 runtime 中使用。",
            },
          },
        }),
      },
    })
    .post("/custom-providers/discover-models", async ({ request }) => {
      const body = await parseRequestJsonBody(customProviderModelDiscoverySchema, request);
      if (!body) return detailError(422, "Invalid request body");

      try {
        const discoverModels =
          deps.discoverOpenAICompatibleModels ?? discoverOpenAICompatibleModels;
        const models = await discoverModels({
          apiBase: body.api_base,
          apiKey: body.api_key,
        });
        return { models };
      } catch (error) {
        if (error instanceof ModelDiscoveryError) {
          return detailError(error.status, error.message);
        }

        return detailError(502, "获取模型列表失败");
      }
    }, {
      detail: {
        tags: ["供应商与模型"],
        summary: "发现 OpenAI-compatible 模型",
        description:
          "临时使用提交的 API base 和 API key 请求 {api_base}/models。结果不会保存 provider 配置或 API key，仅支持 OpenAI-compatible 响应。",
        requestBody: jsonRequestBody({
          type: "object",
          required: ["api_base", "api_key"],
          properties: {
            api_base: {
              ...stringSchema,
              description: "OpenAI-compatible API base URL。",
            },
            api_key: {
              ...stringSchema,
              description: "仅用于本次模型发现的 API key，不会被该接口保存。",
            },
          },
        }),
      },
    })
    .post("/custom-providers/test-tool-calling", async ({ request }) => {
      const body = await parseRequestJsonBody(customProviderToolCallingTestSchema, request);
      if (!body) return detailError(422, "Invalid request body");

      const testToolCalling =
        deps.testOpenAICompatibleToolCalling ?? testOpenAICompatibleToolCalling;
      return testToolCalling({
        apiBase: body.api_base,
        apiKey: body.api_key,
        modelId: body.model_id,
      });
    }, {
      detail: {
        tags: ["供应商与模型"],
        summary: "测试 OpenAI-compatible 工具调用",
        description:
          "临时向指定模型发送一个无副作用的强制工具调用探测请求。请求不会保存 provider 配置、API key 或探测结果，也不会使用 Runtime Tool、连接或 Backend Bridge。",
        requestBody: jsonRequestBody({
          type: "object",
          required: ["api_base", "api_key", "model_id"],
          properties: {
            api_base: stringSchema,
            api_key: stringSchema,
            model_id: stringSchema,
          },
        }),
      },
    })
    .post("/custom-providers", async ({ request }) => {
      const service = serviceOrNull();
      if (!service) return detailError(503, "ProviderService not initialized");

      const body = await parseRequestJsonBody(customProviderCreateSchema, request);
      if (!body) return detailError(422, "Invalid request body");
      const provider = service.addCustomProvider({
        providerId: body.id,
        name: body.name,
        apiBase: body.api_base,
        apiKey: body.api_key,
        models: body.models,
      });

      return serializeProviderDetail(provider);
    }, {
      detail: {
        tags: ["供应商与模型"],
        summary: "创建自定义供应商",
        description: "创建 OpenAI-compatible 自定义 provider 及其模型定义。",
        requestBody: jsonRequestBody({
          type: "object",
          required: ["id", "name", "api_base", "api_key"],
          properties: {
            id: {
              ...stringSchema,
              description: "自定义 provider id。",
            },
            name: {
              ...stringSchema,
              description: "自定义 provider 展示名称。",
            },
            api_base: {
              ...stringSchema,
              description: "OpenAI-compatible API base URL。",
            },
            api_key: {
              ...stringSchema,
              description: "自定义 provider API key。",
            },
            models: customModelsOpenApiSchema,
          },
        }),
      },
    })
    .put("/custom-providers/:providerId", async ({ params, request }) => {
      const service = serviceOrNull();
      if (!service) return detailError(503, "ProviderService not initialized");

      const body = await parseRequestJsonBody(customProviderUpdateSchema, request);
      if (!body) return detailError(422, "Invalid request body");
      const provider = service.updateCustomProvider({
        providerId: params.providerId,
        name: body.name,
        apiBase: body.api_base,
        apiKey: body.api_key,
        models: body.models,
      });
      if (!provider) return detailError(404, `Custom provider ${params.providerId} not found`);

      return serializeProviderDetail(provider);
    }, {
      detail: {
        tags: ["供应商与模型"],
        summary: "更新自定义供应商",
        description: "更新自定义 provider，并替换其自定义模型定义。",
        requestBody: jsonRequestBody({
          type: "object",
          required: ["name", "api_base"],
          properties: {
            name: {
              ...stringSchema,
              description: "自定义 provider 展示名称。",
            },
            api_base: {
              ...stringSchema,
              description: "OpenAI-compatible API base URL。",
            },
            api_key: {
              ...stringSchema,
              description: "新的 API key；省略时保留原值。",
            },
            models: customModelsOpenApiSchema,
          },
        }),
      },
    })
    .delete("/custom-providers/:providerId", ({ params }) => {
      const service = serviceOrNull();
      if (!service) return detailError(503, "ProviderService not initialized");

      const deleted = service.removeCustomProvider(params.providerId);
      if (!deleted) {
        return detailError(
          404,
          `Custom provider ${params.providerId} not found or is a preset provider`,
        );
      }

      return { deleted: true };
    }, {
      detail: {
        tags: ["供应商与模型"],
        summary: "删除自定义供应商",
        description: "删除自定义 provider。预设 provider 不能删除。",
      },
    })
    .get("/catalog/status", async () => {
      const service = serviceOrNull();
      if (!service || !deps.catalog) {
        return detailError(503, "ProviderService not initialized");
      }

      const status = await service.getCatalogStatus();
      return {
        last_updated_at: status.lastUpdatedAt,
      };
    }, {
      detail: {
        tags: ["供应商与模型"],
        summary: "获取供应商目录状态",
        description: "返回本地 provider/model catalog 的最后更新时间。",
      },
    })
    .post("/catalog/refresh", async () => {
      const service = serviceOrNull();
      if (!service || !deps.catalog) {
        return detailError(503, "ProviderService not initialized");
      }

      const result = await service.refreshCatalog(true);
      if (result.status === "unavailable") {
        return detailError(503, "无法刷新供应商目录，且没有可用的本地缓存");
      }

      return {
        status: result.status,
        provider_count: service.listProviders().length,
        last_updated_at: result.lastUpdatedAt,
      };
    }, {
      detail: {
        tags: ["供应商与模型"],
        summary: "刷新供应商目录",
        description:
          "强制从 models.dev 刷新 provider/model catalog。远端失败时仅在已有本地缓存的情况下返回 using_cache；没有缓存时返回 503。",
      },
    });
}
