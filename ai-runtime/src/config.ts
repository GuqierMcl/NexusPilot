import { join, resolve } from "node:path";

export interface RuntimeConfig {
  host: string;
  port: number;
  accessToken: string | null;
  dataDir: string;
  cacheDir: string;
  catalogPath: string;
  providersPath: string;
  runtimeSettingsPath: string;
  runtimeDbPath: string;
}

export function resolveRuntimeConfig(
  argv = Bun.argv.slice(2),
  env: Record<string, string | undefined> = Bun.env,
): RuntimeConfig {
  const args = parseArgs(argv);
  const host = args.host ?? "127.0.0.1";
  const port = parsePort(args.port ?? "8787");
  const dataDir = normalizeOptionalPath(args["data-dir"] ?? env.NEXUS_PILOT_DATA_DIR ?? "");
  const cacheDir = normalizeOptionalPath(
    args["cache-dir"] ?? env.NEXUS_PILOT_CACHE_DIR ?? "",
  );

  return {
    host,
    port,
    accessToken: normalizeOptionalSecret(env.NEXUS_PILOT_AI_RUNTIME_ACCESS_TOKEN),
    dataDir,
    cacheDir,
    catalogPath: cacheDir ? join(cacheDir, "catalog.json") : "",
    providersPath: dataDir ? join(dataDir, "providers.json") : "",
    runtimeSettingsPath: dataDir ? join(dataDir, "runtime-settings.json") : "",
    runtimeDbPath: dataDir ? join(dataDir, "ai-runtime.sqlite3") : "",
  };
}

function normalizeOptionalSecret(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function applyRuntimeEnvironment(
  config: RuntimeConfig,
  env: Record<string, string | undefined> = Bun.env,
): void {
  if (config.dataDir) {
    env.NEXUS_PILOT_DATA_DIR = config.dataDir;
  }
  if (config.cacheDir) {
    env.NEXUS_PILOT_CACHE_DIR = config.cacheDir;
  }
}

function parseArgs(argv: string[]): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = "true";
    }
  }

  return result;
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid --port value: ${value}`);
  }
  return port;
}

function normalizeOptionalPath(value: string): string {
  if (!value) {
    return "";
  }
  return resolve(value);
}
