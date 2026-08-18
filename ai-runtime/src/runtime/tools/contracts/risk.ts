export const TOOL_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;

export type ToolRiskLevel = (typeof TOOL_RISK_LEVELS)[number];

export const TOOL_SIDE_EFFECTS = [
  "none",
  "external_network",
  "runtime_state",
  "workbench_state",
  "business_read",
  "business_write",
  "destructive",
] as const;

export type ToolSideEffect = (typeof TOOL_SIDE_EFFECTS)[number];

export interface StaticToolRiskDefinition {
  mode: "static";
  level: ToolRiskLevel;
  reversible: boolean;
  sideEffect: ToolSideEffect;
}

export interface DynamicToolRiskDefinition {
  mode: "dynamic";
  level: ToolRiskLevel;
  reversible: boolean | "conditional";
  sideEffect: ToolSideEffect;
}

export type ToolRiskDefinition = StaticToolRiskDefinition | DynamicToolRiskDefinition;

export interface ResolvedToolRisk {
  level: ToolRiskLevel;
  reversible: boolean;
  sideEffects: readonly ToolSideEffect[];
}
