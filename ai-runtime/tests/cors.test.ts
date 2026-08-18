import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";

interface CorsRequestOptions {
  accessToken?: string;
  path?: string;
  requestHeaders?: string;
}

async function preflight(origin: string, options: CorsRequestOptions = {}) {
  const app = await createApp({
    host: "127.0.0.1",
    port: 8787,
    dataDir: "",
    catalogPath: "",
    providersPath: "",
    runtimeDbPath: "",
    accessToken: options.accessToken,
  });

  return app.handle(
    new Request(`http://localhost${options.path ?? "/health"}`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
        ...(options.requestHeaders
          ? { "Access-Control-Request-Headers": options.requestHeaders }
          : {}),
      },
    }),
  );
}

describe("cors", () => {
  test("allows Vite dev origin", async () => {
    const response = await preflight("http://localhost:1420");
    expect([200, 204]).toContain(response.status);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:1420");
  });

  test("allows Tauri production origins", async () => {
    for (const origin of ["tauri://localhost", "http://tauri.localhost"]) {
      const response = await preflight(origin);
      expect([200, 204]).toContain(response.status);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    }
  });

  test("rejects untrusted origin", async () => {
    const response = await preflight("https://example.com");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("allows authorized EventBus preflight without credential wildcards", async () => {
    const response = await preflight("http://localhost:1420", {
      accessToken: "runtime-secret",
      path: "/v1/events",
      requestHeaders: "authorization, cache-control",
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:1420",
    );
    expect(
      response.headers
        .get("access-control-allow-headers")
        ?.split(",")
        .map((header) => header.trim().toLowerCase()),
    ).toEqual(
      expect.arrayContaining(["authorization", "cache-control"]),
    );
    expect(response.headers.get("access-control-allow-headers")).not.toBe("*");
  });

  test("adds CORS headers to the EventBus streaming response", async () => {
    const app = await createApp({
      host: "127.0.0.1",
      port: 8787,
      dataDir: "",
      catalogPath: "",
      providersPath: "",
      runtimeDbPath: "",
      accessToken: "runtime-secret",
    });
    const response = await app.handle(
      new Request("http://localhost/v1/events", {
        headers: {
          Authorization: "Bearer runtime-secret",
          Origin: "http://localhost:1420",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:1420",
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await response.body?.cancel();
  });
});
