import { describe, expect, test } from "bun:test";
import { logRuntimeDirectories } from "../src/startup-diagnostics";

interface LogEntry {
  level: "info" | "warn";
  fields?: Record<string, unknown>;
  message: string;
}

function createLogCapture(): {
  entries: LogEntry[];
  logger: {
    info(fields: Record<string, unknown>, message: string): void;
    warn(message: string): void;
  };
} {
  const entries: LogEntry[] = [];
  return {
    entries,
    logger: {
      info(fields: Record<string, unknown>, message: string): void {
        entries.push({ level: "info", fields, message });
      },
      warn(message: string): void {
        entries.push({ level: "warn", message });
      },
    },
  };
}

describe("AI Runtime startup directory diagnostics", () => {
  test("logs resolved data and cache directories symmetrically", () => {
    const capture = createLogCapture();

    logRuntimeDirectories(
      { dataDir: "D:/nexuspilot/data", cacheDir: "D:/nexuspilot/cache" },
      capture.logger,
    );

    expect(capture.entries).toEqual([
      {
        level: "info",
        fields: { dataDir: "D:/nexuspilot/data" },
        message: "Nexus AI Runtime data dir resolved",
      },
      {
        level: "info",
        fields: { cacheDir: "D:/nexuspilot/cache" },
        message: "Nexus AI Runtime cache dir resolved",
      },
    ]);
  });

  test("warns when persistent data or catalog disk cache is unavailable", () => {
    const capture = createLogCapture();

    logRuntimeDirectories({ dataDir: "", cacheDir: "" }, capture.logger);

    expect(capture.entries).toEqual([
      {
        level: "warn",
        message: "NEXUS_PILOT_DATA_DIR not set; provider service will be unavailable",
      },
      {
        level: "warn",
        message:
          "NEXUS_PILOT_CACHE_DIR not set; provider catalog disk cache will be unavailable",
      },
    ]);
  });
});
