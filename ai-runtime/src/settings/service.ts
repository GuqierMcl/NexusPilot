import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { RuntimeLogger } from "../core/logger";
import {
  isAutoApproveMaxRisk,
  isNetworkAccessScope,
  type AutoApproveMaxRisk,
  type NetworkAccessScope,
  type RuntimeSettingsSnapshot,
} from "./contracts";
import {
  DEFAULT_RUNTIME_SETTINGS,
  FAIL_SAFE_RUNTIME_SETTINGS,
} from "./defaults";

interface RuntimeSettingsServiceOptions {
  settingsPath: string;
  logger?: Pick<RuntimeLogger, "warn">;
}

interface PersistedRuntimeSettings {
  tool_policy?: {
    auto_approve_max_risk: AutoApproveMaxRisk;
  };
  network_policy?: {
    access_scope: NetworkAccessScope;
  };
}

export class RuntimeSettingsService {
  private settings: RuntimeSettingsSnapshot = DEFAULT_RUNTIME_SETTINGS;

  constructor(private readonly options: RuntimeSettingsServiceOptions) {}

  initialize(): void {
    if (!this.options.settingsPath || !existsSync(this.options.settingsPath)) {
      this.settings = DEFAULT_RUNTIME_SETTINGS;
      return;
    }

    try {
      const parsed = JSON.parse(
        readFileSync(this.options.settingsPath, "utf8"),
      ) as unknown;
      this.settings = freezeSettings(parsePersistedSettings(parsed));
    } catch (error) {
      this.settings = FAIL_SAFE_RUNTIME_SETTINGS;
      this.options.logger?.warn(
        { err: error, settingsPath: this.options.settingsPath },
        "runtime settings are invalid; using fail-safe tool policy",
      );
    }
  }

  snapshot(): RuntimeSettingsSnapshot {
    return freezeSettings(this.settings);
  }

  update(settings: RuntimeSettingsSnapshot): RuntimeSettingsSnapshot {
    validateRuntimeSettings(settings);
    const next = freezeSettings(settings);
    this.persist(next);
    this.settings = next;
    return this.snapshot();
  }

  private persist(settings: RuntimeSettingsSnapshot): void {
    if (!this.options.settingsPath) {
      return;
    }

    mkdirSync(dirname(this.options.settingsPath), { recursive: true });
    const temporaryPath = `${this.options.settingsPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const persisted: PersistedRuntimeSettings = {
      tool_policy: {
        auto_approve_max_risk: settings.toolPolicy.autoApproveMaxRisk,
      },
      network_policy: {
        access_scope: settings.networkPolicy.accessScope,
      },
    };

    try {
      writeFileSync(
        temporaryPath,
        `${JSON.stringify(persisted, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      renameSync(temporaryPath, this.options.settingsPath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
}

function parsePersistedSettings(value: unknown): RuntimeSettingsSnapshot {
  const topLevel = optionalRecord(
    value,
    ["tool_policy", "network_policy"],
    "runtime settings",
  );
  return {
    toolPolicy: topLevel.tool_policy === undefined
      ? DEFAULT_RUNTIME_SETTINGS.toolPolicy
      : parseToolPolicy(topLevel.tool_policy),
    networkPolicy: topLevel.network_policy === undefined
      ? DEFAULT_RUNTIME_SETTINGS.networkPolicy
      : parseNetworkPolicy(topLevel.network_policy),
  };
}

function validateRuntimeSettings(settings: RuntimeSettingsSnapshot): void {
  if (!isAutoApproveMaxRisk(settings.toolPolicy.autoApproveMaxRisk)) {
    throw new Error("runtime tool policy has an invalid auto-approval threshold");
  }
  if (!isNetworkAccessScope(settings.networkPolicy.accessScope)) {
    throw new Error("runtime network policy has an invalid access scope");
  }
}

function parseToolPolicy(value: unknown) {
  const policy = strictRecord(
    value,
    ["auto_approve_max_risk"],
    "runtime tool policy",
  );
  if (!isAutoApproveMaxRisk(policy.auto_approve_max_risk)) {
    throw new Error("runtime tool policy has an invalid auto-approval threshold");
  }
  return { autoApproveMaxRisk: policy.auto_approve_max_risk };
}

function parseNetworkPolicy(value: unknown) {
  const policy = strictRecord(
    value,
    ["access_scope"],
    "runtime network policy",
  );
  if (!isNetworkAccessScope(policy.access_scope)) {
    throw new Error("runtime network policy has an invalid access scope");
  }
  return { accessScope: policy.access_scope };
}

function optionalRecord(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedKeys.includes(key))) {
    throw new Error(`${label} has unexpected fields`);
  }
  return record;
}

function strictRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
  return record;
}

function freezeSettings(
  settings: RuntimeSettingsSnapshot,
): RuntimeSettingsSnapshot {
  return Object.freeze({
    toolPolicy: Object.freeze({
      autoApproveMaxRisk: settings.toolPolicy.autoApproveMaxRisk,
    }),
    networkPolicy: Object.freeze({
      accessScope: settings.networkPolicy.accessScope,
    }),
  });
}
