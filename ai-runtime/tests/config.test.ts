import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyRuntimeEnvironment, resolveRuntimeConfig } from "../src/config";

function createTestDirectory(name: string): string {
  return resolve(tmpdir(), "nexus-pilot-ai-runtime-tests", name);
}

describe("resolveRuntimeConfig", () => {
  test("uses defaults when no args are provided", () => {
    const config = resolveRuntimeConfig([], {});

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8787);
    expect(config.accessToken).toBeNull();
    expect(config.dataDir).toBe("");
    expect(config.cacheDir).toBe("");
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

  test("parses --host --port --data-dir --cache-dir", () => {
    const dataDir = createTestDirectory("data-from-args");
    const cacheDir = createTestDirectory("cache-from-args");
    const config = resolveRuntimeConfig(
      [
        "--host",
        "0.0.0.0",
        "--port",
        "9191",
        "--data-dir",
        dataDir,
        "--cache-dir",
        cacheDir,
      ],
      {},
    );

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9191);
    expect(config.dataDir).toBe(dataDir);
    expect(config.cacheDir).toBe(cacheDir);
    expect(config.catalogPath).toBe(join(cacheDir, "catalog.json"));
    expect(config.providersPath).toBe(join(dataDir, "providers.json"));
    expect(config.runtimeSettingsPath).toBe(join(dataDir, "runtime-settings.json"));
    expect(config.runtimeDbPath).toBe(join(dataDir, "ai-runtime.sqlite3"));
  });

  test("uses data and cache directory environment variables when args are missing", () => {
    const dataDir = createTestDirectory("data-from-env");
    const cacheDir = createTestDirectory("cache-from-env");
    const config = resolveRuntimeConfig([], {
      NEXUS_PILOT_DATA_DIR: dataDir,
      NEXUS_PILOT_CACHE_DIR: cacheDir,
    });

    expect(config.dataDir).toBe(dataDir);
    expect(config.cacheDir).toBe(cacheDir);
    expect(config.catalogPath).toBe(join(cacheDir, "catalog.json"));
    expect(config.providersPath).toBe(join(dataDir, "providers.json"));
    expect(config.runtimeSettingsPath).toBe(join(dataDir, "runtime-settings.json"));
    expect(config.runtimeDbPath).toBe(join(dataDir, "ai-runtime.sqlite3"));
  });

  test("command line data dir wins over env data dir", () => {
    const argsDataDir = createTestDirectory("data-from-args");
    const envDataDir = createTestDirectory("data-from-env");
    const config = resolveRuntimeConfig(["--data-dir", argsDataDir], {
      NEXUS_PILOT_DATA_DIR: envDataDir,
    });

    expect(config.dataDir).toBe(argsDataDir);
  });

  test("command line cache dir wins over env cache dir", () => {
    const argsCacheDir = createTestDirectory("cache-from-args");
    const envCacheDir = createTestDirectory("cache-from-env");
    const config = resolveRuntimeConfig(["--cache-dir", argsCacheDir], {
      NEXUS_PILOT_CACHE_DIR: envCacheDir,
    });

    expect(config.cacheDir).toBe(argsCacheDir);
  });

  test("does not derive the catalog path from the data dir", () => {
    const dataDir = createTestDirectory("data-only");
    const config = resolveRuntimeConfig(["--data-dir", dataDir], {});

    expect(config.dataDir).toBe(dataDir);
    expect(config.cacheDir).toBe("");
    expect(config.catalogPath).toBe("");
    expect(config.providersPath).toBe(join(dataDir, "providers.json"));
    expect(config.runtimeSettingsPath).toBe(join(dataDir, "runtime-settings.json"));
    expect(config.runtimeDbPath).toBe(join(dataDir, "ai-runtime.sqlite3"));
  });

  test("mirrors resolved data and cache dirs into environment", () => {
    const dataDir = createTestDirectory("data-from-args");
    const cacheDir = createTestDirectory("cache-from-args");
    const env: Record<string, string | undefined> = {};
    const config = resolveRuntimeConfig(
      ["--data-dir", dataDir, "--cache-dir", cacheDir],
      env,
    );

    applyRuntimeEnvironment(config, env);

    expect(env.NEXUS_PILOT_DATA_DIR).toBe(dataDir);
    expect(env.NEXUS_PILOT_CACHE_DIR).toBe(cacheDir);
  });
});
