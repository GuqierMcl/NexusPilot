import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";

describe("AI Runtime server lifecycle", () => {
  test("disables the transport idle timeout for long-lived Runtime requests", async () => {
    const app = await createApp({
      host: "127.0.0.1",
      port: 8787,
      dataDir: "",
      catalogPath: "",
      providersPath: "",
      runtimeDbPath: "",
    });

    expect(app.config.serve?.idleTimeout).toBe(0);
    expect(app.config.websocket?.idleTimeout).toBe(0);
  });
});
