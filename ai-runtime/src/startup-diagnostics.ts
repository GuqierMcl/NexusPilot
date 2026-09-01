import type { RuntimeConfig } from "./config";

interface StartupDirectoryLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(message: string): void;
}

export function logRuntimeDirectories(
  config: Pick<RuntimeConfig, "dataDir" | "cacheDir">,
  logger: StartupDirectoryLogger,
): void {
  if (config.dataDir) {
    logger.info({ dataDir: config.dataDir }, "Nexus AI Runtime data dir resolved");
  } else {
    logger.warn("NEXUS_PILOT_DATA_DIR not set; provider service will be unavailable");
  }

  if (config.cacheDir) {
    logger.info({ cacheDir: config.cacheDir }, "Nexus AI Runtime cache dir resolved");
  } else {
    logger.warn(
      "NEXUS_PILOT_CACHE_DIR not set; provider catalog disk cache will be unavailable",
    );
  }
}
