import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { APP_VERSION } from "../src/version";

function createTestConfig() {
  return {
    host: "127.0.0.1",
    port: 8787,
    dataDir: "",
    catalogPath: "",
    providersPath: "",
    runtimeDbPath: "",
  };
}

describe("OpenAPI docs", () => {
  test("serves interactive API docs at /docs", async () => {
    const app = await createApp(createTestConfig());

    const response = await app.handle(new Request("http://localhost/docs"));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("NexusPilot AI Runtime 接口文档");
  });

  test("serves raw OpenAPI JSON at /docs/json", async () => {
    const app = await createApp(createTestConfig());

    const response = await app.handle(new Request("http://localhost/docs/json"));
    const spec = await response.json() as {
      info: { title: string; version: string };
      paths: Record<string, {
        get?: OpenApiOperation;
        post?: OpenApiOperation;
        patch?: OpenApiOperation;
        put?: OpenApiOperation;
        delete?: OpenApiOperation;
      }>;
    };

    expect(response.status).toBe(200);
    expect(spec.info.title).toBe("NexusPilot AI Runtime 接口文档");
    expect(spec.info.version).toBe(APP_VERSION);
    expect(spec.paths).toHaveProperty("/health");
    expect(spec.paths).toHaveProperty("/v1/providers");
    expect(spec.paths).toHaveProperty("/v1/settings");
    expect(spec.paths).not.toHaveProperty("/v1/settings/tool-policy");
    expect(spec.paths).not.toHaveProperty("/v1/settings/network-policy");
    expect(spec.paths).toHaveProperty("/v1/agent-modes");
    expect(spec.paths).toHaveProperty("/v1/conversations");
    expect(spec.paths).toHaveProperty("/v1/events");
    expect(spec.paths).toHaveProperty("/v1/conversations/{conversationId}");
    expect(spec.paths).toHaveProperty("/v1/conversations/{conversationId}/archive");
    expect(spec.paths).toHaveProperty("/v1/conversations/{conversationId}/unarchive");
    expect(spec.paths).toHaveProperty("/v1/conversations/{conversationId}/pin");
    expect(spec.paths).toHaveProperty("/v1/conversations/{conversationId}/unpin");
    expect(spec.paths).toHaveProperty("/v1/conversations/{conversationId}/messages");
    expect(spec.paths).toHaveProperty("/v1/conversations/{conversationId}/runs");
    expect(spec.paths).toHaveProperty("/v1/runs");
    expect(spec.paths).toHaveProperty("/v1/runs/{runId}");
    expect(spec.paths).toHaveProperty("/v1/runs/{runId}/events");
    expect(spec.paths).toHaveProperty("/v1/runs/{runId}/traces");
    expect(spec.paths).not.toHaveProperty("/api/v1/providers");
    expect(spec.paths).not.toHaveProperty("/api/v1/runs");
    expect(spec.paths).not.toHaveProperty("/api/v1/events");
    expect(spec.paths).not.toHaveProperty("/v1/chat");
    expect(spec.paths["/health"]?.get?.summary).toBe("获取 AI Runtime 健康状态");
    expect(spec.paths["/v1/runs"]?.post?.tags).toEqual(["运行"]);
    expect(spec.paths["/v1/settings"]?.get?.tags).toEqual(["运行时设置"]);
  });

  test("documents request parameters and bodies for every runtime route", async () => {
    const app = await createApp(createTestConfig());

    const response = await app.handle(new Request("http://localhost/docs/json"));
    const spec = await response.json() as {
      paths: Record<string, {
        get?: OpenApiOperation;
        post?: OpenApiOperation;
        patch?: OpenApiOperation;
        put?: OpenApiOperation;
        delete?: OpenApiOperation;
      }>;
    };

    expect(spec.paths["/health"]?.get?.parameters).toBeUndefined();
    expect(spec.paths["/health"]?.get?.requestBody).toBeUndefined();

    expect(parameterNames(spec.paths["/v1/providers"]?.get, "query")).toEqual([
      "enabled_only",
    ]);
    expect(spec.paths["/v1/agent-modes"]?.get?.parameters).toBeUndefined();
    expect(spec.paths["/v1/agent-modes"]?.get?.requestBody).toBeUndefined();
    expect(spec.paths["/v1/settings"]?.get?.requestBody).toBeUndefined();
    const runtimeSettingsBody = jsonBodySchema(spec.paths["/v1/settings"]?.put);
    expect(runtimeSettingsBody?.required).toEqual(["tool_policy", "network_policy"]);
    expect(runtimeSettingsBody?.additionalProperties).toBe(false);
    expect(
      runtimeSettingsBody?.properties?.tool_policy?.properties
        ?.auto_approve_max_risk?.enum,
    ).toEqual(["none", "low", "medium"]);
    expect(
      runtimeSettingsBody?.properties?.network_policy?.properties
        ?.access_scope?.enum,
    ).toEqual(["local-and-public", "public-only"]);

    expect(parameterNames(spec.paths["/v1/providers/{providerId}"]?.get, "path")).toEqual([
      "providerId",
    ]);
    expect(parameterNames(spec.paths["/v1/providers/{providerId}/config"]?.put, "path")).toEqual([
      "providerId",
    ]);
    expect(jsonBodySchema(spec.paths["/v1/providers/{providerId}/config"]?.put)?.properties)
      .toHaveProperty("api_key");
    expect(jsonBodySchema(spec.paths["/v1/providers/{providerId}/config"]?.put)?.properties)
      .toHaveProperty("enabled");
    expect(jsonBodySchema(spec.paths["/v1/providers/{providerId}/config"]?.put)?.properties)
      .toHaveProperty("api_base");

    expect(parameterNames(
      spec.paths["/v1/providers/{providerId}/models/{modelId}/config"]?.put,
      "path",
    )).toEqual(["providerId", "modelId"]);
    expect(jsonBodySchema(
      spec.paths["/v1/providers/{providerId}/models/{modelId}/config"]?.put,
    )?.required).toContain("enabled");

    const customCreateSchema = jsonBodySchema(spec.paths["/v1/custom-providers"]?.post);
    expect(customCreateSchema?.required).toEqual(["id", "name", "api_base", "api_key"]);
    expect(customCreateSchema?.properties).toHaveProperty("models");

    expect(parameterNames(spec.paths["/v1/custom-providers/{providerId}"]?.put, "path")).toEqual([
      "providerId",
    ]);
    const customUpdateSchema = jsonBodySchema(spec.paths["/v1/custom-providers/{providerId}"]?.put);
    expect(customUpdateSchema?.required).toEqual(["name", "api_base"]);
    expect(customUpdateSchema?.properties).toHaveProperty("api_key");

    expect(parameterNames(spec.paths["/v1/custom-providers/{providerId}"]?.delete, "path")).toEqual([
      "providerId",
    ]);
    expect(spec.paths["/v1/catalog/refresh"]?.post?.requestBody).toBeUndefined();

    expect(parameterNames(spec.paths["/v1/events"]?.get, "query")).toEqual([
      "conversation_id",
      "run_id",
    ]);
    expect(parameterNames(spec.paths["/v1/events"]?.get, "query")).not.toContain("cursor");

    expect(parameterNames(spec.paths["/v1/conversations"]?.get, "query")).toEqual(["limit"]);
    expect(parameterNames(spec.paths["/v1/conversations/{conversationId}"]?.get, "path"))
      .toEqual(["conversationId"]);
    expect(parameterNames(spec.paths["/v1/conversations/{conversationId}"]?.patch, "path"))
      .toEqual(["conversationId"]);
    expect(parameterNames(spec.paths["/v1/conversations/{conversationId}"]?.delete, "path"))
      .toEqual(["conversationId"]);
    expect(parameterNames(
      spec.paths["/v1/conversations/{conversationId}/archive"]?.post,
      "path",
    )).toEqual(["conversationId"]);
    expect(parameterNames(
      spec.paths["/v1/conversations/{conversationId}/unarchive"]?.post,
      "path",
    )).toEqual(["conversationId"]);
    expect(parameterNames(
      spec.paths["/v1/conversations/{conversationId}/pin"]?.post,
      "path",
    )).toEqual(["conversationId"]);
    expect(parameterNames(
      spec.paths["/v1/conversations/{conversationId}/unpin"]?.post,
      "path",
    )).toEqual(["conversationId"]);
    const conversationRenameBody = jsonBodySchema(
      spec.paths["/v1/conversations/{conversationId}"]?.patch,
    );
    expect(conversationRenameBody?.required).toEqual(["title"]);
    expect(conversationRenameBody?.additionalProperties).toBe(false);
    expect(conversationRenameBody?.properties).toHaveProperty("title");
    expect(parameterNames(
      spec.paths["/v1/conversations/{conversationId}/messages"]?.get,
      "path",
    )).toEqual(["conversationId"]);
    expect(parameterNames(
      spec.paths["/v1/conversations/{conversationId}/messages"]?.get,
      "query",
    )).toEqual(["format"]);
    expect(parameterNames(
      spec.paths["/v1/conversations/{conversationId}/runs"]?.get,
      "path",
    )).toEqual(["conversationId"]);
    expect(parameterNames(spec.paths["/v1/runs/{runId}"]?.get, "path")).toEqual(["runId"]);
    expect(parameterNames(spec.paths["/v1/runs/{runId}/events"]?.get, "path")).toEqual([
      "runId",
    ]);
    expect(parameterNames(spec.paths["/v1/runs/{runId}/traces"]?.get, "path")).toEqual([
      "runId",
    ]);

    const runBody = jsonBodySchema(spec.paths["/v1/runs"]?.post);
    expect(runBody?.oneOf).toBeUndefined();
    expect(runBody?.additionalProperties).toBe(false);
    expect(runBody?.required).toEqual([
      "response_mode",
      "model",
      "input",
    ]);
    expect(runBody?.properties?.response_mode?.enum).toEqual(["stream"]);
    expect(runBody?.properties?.model?.required).toEqual([
      "provider_id",
      "model_id",
    ]);
    expect(runBody?.properties?.model?.additionalProperties).toBe(false);
    expect(runBody?.properties?.model?.properties).toHaveProperty("provider_id");
    expect(runBody?.properties?.model?.properties).toHaveProperty("model_id");
    expect(runBody?.properties?.agent_mode?.enum).toEqual([
      "ask",
      "query",
      "agent",
    ]);
    expect(runBody?.properties?.input?.required).toEqual(["parts"]);
    expect(runBody?.properties?.input?.additionalProperties).toBe(false);
    expect(runBody?.properties?.input?.properties?.parts?.type).toBe("array");
    expect(runBody?.properties?.input?.properties?.parts?.items?.required).toEqual([
      "type",
      "text",
    ]);
    expect(runBody?.properties?.input?.properties?.parts?.items?.additionalProperties)
      .toBe(false);
    expect(runBody?.properties?.input?.properties?.parts?.items?.properties?.type?.enum)
      .toEqual(["text"]);
    expect(runBody?.properties).not.toHaveProperty("text");
    expect(runBody?.properties).not.toHaveProperty("provider_id");
    expect(runBody?.properties).not.toHaveProperty("model_id");
    expect(runBody?.properties).not.toHaveProperty("messages");
    expect(runBody?.properties).not.toHaveProperty("system");
    expect(runBody?.properties).not.toHaveProperty("limits");
    expect(runBody?.properties).not.toHaveProperty("title");
    expect(runBody?.properties).not.toHaveProperty("tools");
    expect(runBody?.properties).not.toHaveProperty("profile_id");
    expect(runBody?.properties).not.toHaveProperty("mode");
  });
});

interface OpenApiOperation {
  summary?: string;
  tags?: string[];
  parameters?: Array<{
    name: string;
    in: "path" | "query" | "header" | "cookie";
    required?: boolean;
    schema?: unknown;
  }>;
  requestBody?: {
    content?: {
      "application/json"?: {
        schema?: OpenApiSchema;
      };
    };
  };
}

interface OpenApiSchema {
  type?: string;
  enum?: string[];
  required?: string[];
  properties?: Record<string, OpenApiSchema>;
  additionalProperties?: unknown;
  items?: OpenApiSchema;
  oneOf?: OpenApiSchema[];
}

function parameterNames(operation: OpenApiOperation | undefined, location: "path" | "query") {
  return operation?.parameters
    ?.filter((parameter) => parameter.in === location)
    .map((parameter) => parameter.name) ?? [];
}

function jsonBodySchema(operation: OpenApiOperation | undefined) {
  return operation?.requestBody?.content?.["application/json"]?.schema;
}
