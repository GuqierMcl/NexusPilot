import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import type { RuntimeConfig } from "../src/config";

const config: RuntimeConfig = {
  host: "127.0.0.1",
  port: 8787,
  accessToken: "test-access-token",
  dataDir: "",
  catalogPath: "",
  providersPath: "",
  runtimeSettingsPath: "",
  runtimeDbPath: "",
};

async function request(path: string, authorization?: string, method = "GET") {
  const app = await createApp(config);
  return app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: authorization ? { Authorization: authorization } : undefined,
  }));
}

describe("Runtime access authentication", () => {
  test("keeps non-v1 infrastructure endpoints public", async () => {
    for (const path of ["/health", "/docs", "/docs/json", "/unknown"]) {
      expect((await request(path)).status).not.toBe(401);
    }
  });

  test("rejects missing, malformed, and incorrect credentials under /v1", async () => {
    for (const authorization of [
      undefined,
      "Basic test-access-token",
      "Bearer",
      "Bearer wrong-token",
      "Bearer test-access-token extra",
    ]) {
      const response = await request("/v1/agent-modes", authorization);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        code: "unauthorized",
        message: "Unauthorized",
        data: null,
      });
    }
  });

  test("allows a valid Bearer credential under /v1", async () => {
    expect((await request("/v1/agent-modes", "Bearer test-access-token")).status).toBe(200);
  });

  test("authenticates unknown /v1 paths before returning not found", async () => {
    expect((await request("/v1/unknown")).status).toBe(401);
    expect((await request("/v1/unknown", "Bearer test-access-token")).status).toBe(404);
  });

  test("allows CORS preflight without a credential", async () => {
    const response = await request("/v1/agent-modes", undefined, "OPTIONS");
    expect(response.status).not.toBe(401);
  });

  test("disables authentication when no token is configured", async () => {
    const app = await createApp({ ...config, accessToken: null });
    const response = await app.handle(new Request("http://localhost/v1/agent-modes"));
    expect(response.status).toBe(200);
  });
});
