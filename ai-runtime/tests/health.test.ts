import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { createRuntimeLogger } from "../src/core/logger";
import { APP_VERSION } from "../src/version";

describe("health route", () => {
  test("returns BaseResponse health payload", async () => {
    const app = await createApp({
      host: "127.0.0.1",
      port: 8787,
      dataDir: "",
      catalogPath: "",
      providersPath: "",
      runtimeDbPath: "",
    });

    const response = await app.handle(new Request("http://localhost/health"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      code: "success",
      message: "Success",
      data: {
        status: "ok",
        version: APP_VERSION,
        backendBridge: { state: "waiting" },
      },
    });
  });

  test("logs completed requests when a logger is provided", async () => {
    const lines: string[] = [];
    const logger = createRuntimeLogger({
      format: "pretty",
      level: "info",
      write: (line) => lines.push(line),
    });
    const app = await createApp(
      {
        host: "127.0.0.1",
        port: 8787,
        dataDir: "",
        catalogPath: "",
        providersPath: "",
        runtimeDbPath: "",
      },
      { logger },
    );

    await app.handle(new Request("http://localhost/health"));

    const output = lines.join("");
    expect(output).toContain("request completed");
    expect(output).toContain("method=GET");
    expect(output).toContain("path=/health");
    expect(output).toContain("status=200");
  });
});
