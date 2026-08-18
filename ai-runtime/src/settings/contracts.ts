export const AUTO_APPROVE_MAX_RISKS = [
  "none",
  "low",
  "medium",
] as const;

export type AutoApproveMaxRisk = (typeof AUTO_APPROVE_MAX_RISKS)[number];

export const NETWORK_ACCESS_SCOPES = [
  "local-and-public",
  "public-only",
] as const;

export type NetworkAccessScope = (typeof NETWORK_ACCESS_SCOPES)[number];

export interface RuntimeToolApprovalPolicy {
  autoApproveMaxRisk: AutoApproveMaxRisk;
}

export interface RuntimeNetworkPolicy {
  accessScope: NetworkAccessScope;
}

export interface RuntimeSettingsSnapshot {
  toolPolicy: RuntimeToolApprovalPolicy;
  networkPolicy: RuntimeNetworkPolicy;
}

export function isAutoApproveMaxRisk(
  value: unknown,
): value is AutoApproveMaxRisk {
  return (
    typeof value === "string" &&
    AUTO_APPROVE_MAX_RISKS.includes(value as AutoApproveMaxRisk)
  );
}

export function isNetworkAccessScope(
  value: unknown,
): value is NetworkAccessScope {
  return (
    typeof value === "string" &&
    NETWORK_ACCESS_SCOPES.includes(value as NetworkAccessScope)
  );
}
