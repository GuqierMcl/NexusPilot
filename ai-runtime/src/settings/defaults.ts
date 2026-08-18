import type { RuntimeSettingsSnapshot } from "./contracts";

export const DEFAULT_NETWORK_ACCESS_SCOPE = "local-and-public" as const;

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettingsSnapshot = Object.freeze({
  toolPolicy: Object.freeze({
    autoApproveMaxRisk: "low",
  }),
  networkPolicy: Object.freeze({
    accessScope: DEFAULT_NETWORK_ACCESS_SCOPE,
  }),
});

export const FAIL_SAFE_RUNTIME_SETTINGS: RuntimeSettingsSnapshot = Object.freeze({
  toolPolicy: Object.freeze({
    autoApproveMaxRisk: "none",
  }),
  networkPolicy: Object.freeze({
    accessScope: "public-only",
  }),
});
