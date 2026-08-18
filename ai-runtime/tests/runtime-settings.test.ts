import {
  afterEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/app";
import { RuntimeSettingsService } from "../src/settings/service";

const temporaryDirectories: string[] = [];
const DEFAULT_SETTINGS = {
  toolPolicy: { autoApproveMaxRisk: "low" },
  networkPolicy: { accessScope: "local-and-public" },
} as const;
const FAIL_SAFE_SETTINGS = {
  toolPolicy: { autoApproveMaxRisk: "none" },
  networkPolicy: { accessScope: "public-only" },
} as const;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporarySettingsPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "nexuspilot-runtime-settings-"));
  temporaryDirectories.push(directory);
  return join(directory, "runtime-settings.json");
}

function config(runtimeSettingsPath = "") {
  return {
    host: "127.0.0.1",
    port: 8787,
    dataDir: "",
    catalogPath: "",
    providersPath: "",
    runtimeSettingsPath,
    runtimeDbPath: "",
  };
}

describe("RuntimeSettingsService", () => {
  test("uses low when the settings file does not exist", () => {
    const service = new RuntimeSettingsService({
      settingsPath: temporarySettingsPath(),
    });

    service.initialize();

    expect(service.snapshot()).toEqual(DEFAULT_SETTINGS);
    expect(Object.isFrozen(service.snapshot())).toBe(true);
    expect(Object.isFrozen(service.snapshot().toolPolicy)).toBe(true);
    expect(Object.isFrozen(service.snapshot().networkPolicy)).toBe(true);
  });

  test("persists and reloads a complete settings snapshot atomically", () => {
    const settingsPath = temporarySettingsPath();
    const service = new RuntimeSettingsService({ settingsPath });
    service.initialize();

    expect(service.update({
      toolPolicy: { autoApproveMaxRisk: "medium" },
      networkPolicy: { accessScope: "local-and-public" },
    })).toEqual({
      toolPolicy: { autoApproveMaxRisk: "medium" },
      networkPolicy: { accessScope: "local-and-public" },
    });
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      tool_policy: { auto_approve_max_risk: "medium" },
      network_policy: { access_scope: "local-and-public" },
    });
    expect(service.update({
      toolPolicy: { autoApproveMaxRisk: "none" },
      networkPolicy: { accessScope: "local-and-public" },
    })).toEqual({
      toolPolicy: { autoApproveMaxRisk: "none" },
      networkPolicy: { accessScope: "local-and-public" },
    });

    const reloaded = new RuntimeSettingsService({ settingsPath });
    reloaded.initialize();
    expect(reloaded.snapshot()).toEqual({
      toolPolicy: { autoApproveMaxRisk: "none" },
      networkPolicy: { accessScope: "local-and-public" },
    });
  });

  test("merges missing known settings groups with independent defaults", () => {
    const toolPolicyPath = temporarySettingsPath();
    writeFileSync(
      toolPolicyPath,
      JSON.stringify({
        tool_policy: { auto_approve_max_risk: "medium" },
      }),
    );
    const toolPolicyOnly = new RuntimeSettingsService({ settingsPath: toolPolicyPath });
    toolPolicyOnly.initialize();
    expect(toolPolicyOnly.snapshot()).toEqual({
      toolPolicy: { autoApproveMaxRisk: "medium" },
      networkPolicy: { accessScope: "local-and-public" },
    });

    const networkPolicyPath = temporarySettingsPath();
    writeFileSync(
      networkPolicyPath,
      JSON.stringify({
        network_policy: { access_scope: "public-only" },
      }),
    );
    const networkPolicyOnly = new RuntimeSettingsService({ settingsPath: networkPolicyPath });
    networkPolicyOnly.initialize();
    expect(networkPolicyOnly.snapshot()).toEqual({
      toolPolicy: { autoApproveMaxRisk: "low" },
      networkPolicy: { accessScope: "public-only" },
    });
  });

  test("replaces the complete settings snapshot", () => {
    const service = new RuntimeSettingsService({ settingsPath: temporarySettingsPath() });
    service.initialize();
    service.update({
      toolPolicy: { autoApproveMaxRisk: "medium" },
      networkPolicy: { accessScope: "local-and-public" },
    });

    expect(service.update({
      toolPolicy: { autoApproveMaxRisk: "medium" },
      networkPolicy: { accessScope: "public-only" },
    })).toEqual({
      toolPolicy: { autoApproveMaxRisk: "medium" },
      networkPolicy: { accessScope: "public-only" },
    });
  });

  test("fails safe to none when the persisted file is corrupt or invalid", () => {
    const corruptPath = temporarySettingsPath();
    const warnings: unknown[] = [];
    writeFileSync(corruptPath, "{not-json");
    const corrupt = new RuntimeSettingsService({
      settingsPath: corruptPath,
      logger: {
        warn: (...args: unknown[]) => {
          warnings.push(args);
        },
      } as never,
    });

    corrupt.initialize();

    expect(corrupt.snapshot()).toEqual(FAIL_SAFE_SETTINGS);
    expect(warnings).toHaveLength(1);

    const invalidPath = temporarySettingsPath();
    writeFileSync(
      invalidPath,
      JSON.stringify({
        tool_policy: { auto_approve_max_risk: "critical" },
      }),
    );
    const invalid = new RuntimeSettingsService({ settingsPath: invalidPath });
    invalid.initialize();
    expect(invalid.snapshot()).toEqual(FAIL_SAFE_SETTINGS);
  });

  test("rejects invalid programmatic updates without changing state", () => {
    const service = new RuntimeSettingsService({
      settingsPath: temporarySettingsPath(),
    });
    service.initialize();

    expect(() => service.update({
      toolPolicy: { autoApproveMaxRisk: "critical" as never },
      networkPolicy: { accessScope: "local-and-public" },
    })).toThrow(
      "invalid auto-approval threshold",
    );
    expect(service.snapshot()).toEqual(DEFAULT_SETTINGS);
  });
});

describe("Runtime settings routes", () => {
  test("returns the default and updates the complete Runtime-owned snapshot", async () => {
    const settingsPath = temporarySettingsPath();
    const app = await createApp(config(settingsPath));

    const initial = await app.handle(
      new Request("http://localhost/v1/settings"),
    );
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      tool_policy: { auto_approve_max_risk: "low" },
      network_policy: { access_scope: "local-and-public" },
    });

    const updated = await app.handle(
      new Request("http://localhost/v1/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tool_policy: { auto_approve_max_risk: "medium" },
          network_policy: { access_scope: "local-and-public" },
        }),
      }),
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({
      tool_policy: { auto_approve_max_risk: "medium" },
      network_policy: { access_scope: "local-and-public" },
    });
  });

  test.each(["high", "critical", "unknown"])(
    "rejects unsupported threshold %s",
    async (threshold) => {
      const app = await createApp(config(temporarySettingsPath()));
      const response = await app.handle(
        new Request("http://localhost/v1/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tool_policy: { auto_approve_max_risk: threshold },
            network_policy: { access_scope: "local-and-public" },
          }),
        }),
      );

      expect(response.status).toBe(422);
    },
  );

  test("updates the Runtime-owned network access scope in the complete snapshot", async () => {
    const app = await createApp(config(temporarySettingsPath()));
    const response = await app.handle(
      new Request("http://localhost/v1/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tool_policy: { auto_approve_max_risk: "low" },
          network_policy: { access_scope: "public-only" },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tool_policy: { auto_approve_max_risk: "low" },
      network_policy: { access_scope: "public-only" },
    });
  });

  test("rejects an invalid network access scope without changing settings", async () => {
    const app = await createApp(config(temporarySettingsPath()));
    const response = await app.handle(
      new Request("http://localhost/v1/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tool_policy: { auto_approve_max_risk: "low" },
          network_policy: { access_scope: "private-only" },
        }),
      }),
    );

    expect(response.status).toBe(422);
    const current = await app.handle(
      new Request("http://localhost/v1/settings"),
    );
    expect(await current.json()).toEqual({
      tool_policy: { auto_approve_max_risk: "low" },
      network_policy: { access_scope: "local-and-public" },
    });
  });

  test("rejects partial and extra fields without changing the current settings", async () => {
    const app = await createApp(config(temporarySettingsPath()));
    const response = await app.handle(
      new Request("http://localhost/v1/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tool_policy: {
            auto_approve_max_risk: "medium",
            allow_critical: true,
          },
          network_policy: { access_scope: "local-and-public" },
        }),
      }),
    );

    expect(response.status).toBe(422);
    const current = await app.handle(
      new Request("http://localhost/v1/settings"),
    );
    expect(await current.json()).toEqual({
      tool_policy: { auto_approve_max_risk: "low" },
      network_policy: { access_scope: "local-and-public" },
    });

    const partial = await app.handle(
      new Request("http://localhost/v1/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tool_policy: { auto_approve_max_risk: "medium" },
        }),
      }),
    );
    expect(partial.status).toBe(422);
  });
});
