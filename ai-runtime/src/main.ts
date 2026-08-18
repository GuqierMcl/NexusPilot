import { printStartupBanner } from "./banner";
import { createApp } from "./app";
import { applyRuntimeEnvironment, resolveRuntimeConfig } from "./config";
import { createRuntimeLoggerFromEnv, shouldColorizeConsole } from "./core/logger";

const config = resolveRuntimeConfig();
applyRuntimeEnvironment(config);
const logger = createRuntimeLoggerFromEnv();
printStartupBanner(console.log, { color: shouldColorizeConsole() });
const app = await createApp(config, { logger });

app.listen({
  hostname: config.host,
  port: config.port,
});

logger.info(
  {
    host: config.host,
    port: config.port,
    url: `http://${config.host}:${config.port}`,
  },
  "Nexus AI Runtime listening",
);
if (config.dataDir) {
  logger.info({ dataDir: config.dataDir }, "Nexus AI Runtime data dir resolved");
} else {
  logger.warn("NEXUS_PILOT_DATA_DIR not set; provider service will be unavailable");
}
