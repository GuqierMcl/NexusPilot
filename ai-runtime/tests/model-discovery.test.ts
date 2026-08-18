import { describe, expect, test } from "bun:test";
import {
  discoverOpenAICompatibleModels,
  ModelDiscoveryError,
} from "../src/provider/model-discovery";

describe("OpenAI-compatible model discovery", () => {
  test("requests the configured API base models endpoint and normalizes model ids", async () => {
    let requestUrl = "";
    let requestHeaders: Headers | undefined;
    let redirect: RequestRedirect | undefined;

    const models = await discoverOpenAICompatibleModels(
      {
        apiBase: "https://proxy.example.com/v1/",
        apiKey: "test-key",
      },
      {
        fetchImpl: async (input, init) => {
          requestUrl = String(input);
          requestHeaders = new Headers(init?.headers);
          redirect = init?.redirect;
          return Response.json({
            data: [
              { id: "z-model" },
              { id: "a-model", name: "A Model" },
              { id: "z-model", name: "Duplicate" },
              { id: "" },
              {},
            ],
          });
        },
      },
    );

    expect(requestUrl).toBe("https://proxy.example.com/v1/models");
    expect(requestHeaders?.get("authorization")).toBe("Bearer test-key");
    expect(requestHeaders?.get("accept")).toBe("application/json");
    expect(redirect).toBe("error");
    expect(models).toEqual([
      { id: "a-model", name: "A Model" },
      { id: "z-model", name: "Duplicate" },
    ]);
  });

  test("rejects a non OpenAI-compatible response without exposing the API key", async () => {
    const apiKey = "secret-key";

    await expect(
      discoverOpenAICompatibleModels(
        {
          apiBase: "https://proxy.example.com/v1",
          apiKey,
        },
        {
          fetchImpl: async () => Response.json({ models: [] }),
        },
      ),
    ).rejects.toMatchObject({
      name: "ModelDiscoveryError",
      status: 502,
      message: "该接口未返回 OpenAI-compatible 的模型列表",
    });
  });

  test("maps upstream authentication failures to a user-actionable error", async () => {
    await expect(
      discoverOpenAICompatibleModels(
        {
          apiBase: "https://proxy.example.com/v1",
          apiKey: "test-key",
        },
        {
          fetchImpl: async () => new Response(null, { status: 401 }),
        },
      ),
    ).rejects.toMatchObject({
      name: "ModelDiscoveryError",
      status: 401,
      message: "API 密钥无效，或没有读取模型列表的权限",
    } satisfies Partial<ModelDiscoveryError>);
  });
});
