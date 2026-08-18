import type { AgentMode, RunId } from "../../core/types";
import type { ToolRiskLevel, ToolSideEffect } from "../contracts";
import type {
  RuntimeNetworkPolicy,
  RuntimeToolApprovalPolicy,
} from "../../../settings/contracts";

export interface RunToolExecutionCeiling {
  maxRiskLevel: ToolRiskLevel;
  allowedSideEffects: readonly ToolSideEffect[];
  allowIrreversible: boolean;
}

export interface ActiveRunTool {
  canonicalId: string;
  providerName: string;
}

export interface UnavailableRunTool {
  canonicalId: string;
  reason: string;
}

export interface RunToolSnapshot {
  snapshotId: string;
  runId: RunId;
  createdAt: string;
  agentMode: AgentMode;
  executionCeiling: RunToolExecutionCeiling;
  approvalPolicy?: RuntimeToolApprovalPolicy;
  networkPolicy?: RuntimeNetworkPolicy;
  activeTools: readonly ActiveRunTool[];
  unavailableTools?: readonly UnavailableRunTool[];
}
