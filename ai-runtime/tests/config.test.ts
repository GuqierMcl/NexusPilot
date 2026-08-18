import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyRuntimeEnvironment, resolveRuntimeConfig } from "../src/config";

function createTestDataDir(name: string): string {
  return resolve(tmpdir(), "nexus-pilot-ai-runtime-tests", name);
}

describe("resolveRuntimeConfig", () => {
  test("uses defaults when no args are provided", () => {
    const config = resolveRuntimeConfig([], {});

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8787);
    expect(config.accessToken).toBeNull();
    expect(config.dataDir).toBe("");
    expect(config.catalogPath).toBe("");
    expect(config.providersPath).toBe("");
    expect(config.runtimeSettingsPath).toBe("");
    expect(config.runtimeDbPath).toBe("");
  });

  test("reads the optional Runtime access token from environment", () => {
    expect(resolveRuntimeConfig([], {
      NEXUS_PILOT_AI_RUNTIME_ACCESS_TOKEN: "  launch-secret  ",
    }).accessToken).toBe("launch-secret");
    expect(resolveRuntimeConfig([], {
      NEXUS_PILOT_AI_RUNTIME_ACCESS_TOKEN: "   ",
    }).accessToken).toBeNull();
  });

  test("parses --host --port --data-dir", () => {
    const dataDir = createTestDataDir("from-args");
    const config = resolveRuntimeConfig(
      ["--host", "0.0.0.0", "--port", "9191", "--data-dir", dataDir],
      {},
    );

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9191);
    expect(config.dataDir).toBe(dataDir);
    expect(config.catalogPath).toBe(join(dataDir, "catalog.json"));
    expect(config.providersPath).toBe(join(dataDir, "providers.json"));
    expect(config.runtimeSettingsPath).toBe(join(dataDir, "runtime-settings.json"));
    expect(config.runtimeDbPath).toBe(join(dataDir, "ai-runtime.sqlite3"));
  });

  test("uses NEXUS_PILOT_DATA_DIR when --data-dir is missing", () => {
    const dataDir = createTestDataDir("from-env");
    const config = resolveRuntimeConfig([], {
      NEXUS_PILOT_DATA_DIR: dataDir,
    });

    expect(config.dataDir).toBe(dataDir);
    expect(config.catalogPath).toBe(join(dataDir, "catalog.json"));
    expect(config.providersPath).toBe(join(dataDir, "providers.json"));
    expect(config.runtimeSettingsPath).toBe(join(dataDir, "runtime-settings.json"));
    expect(config.runtimeDbPath).toBe(join(dataDir, "ai-runtime.sqlite3"));
  });

  test("command line data dir wins over env data dir", () => {
    const argsDataDir = createTestDataDir("from-args");
    const envDataDir = createTestDataDir("from-env");
    const config = resolveRuntimeConfig(["--data-dir", argsDataDir], {
      NEXUS_PILOT_DATA_DIR: envDataDir,
    });

    expect(config.dataDir).toBe(argsDataDir);
  });

  test("mirrors resolved data dir into environment", () => {
    const dataDir = createTestDataDir("from-args");
    const env: Record<string, string | undefined> = {};
    const config = resolveRuntimeConfig(["--data-dir", dataDir], env);

    applyRuntimeEnvironment(config, env);

    expect(env.NEXUS_PILOT_DATA_DIR).toBe(dataDir);
  });
});
