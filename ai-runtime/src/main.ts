import { printStartupBanner } from "./banner";
import { createApp } from "./app";
import { applyRuntimeEnvironment, resolveRuntimeConfig } from "./config";
import { createRuntimeLoggerFromEnv, shouldColorizeConsole } from "./core/logger";
import { logRuntimeDirectories } from "./startup-diagnostics";

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
logRuntimeDirectories(config, logger);
