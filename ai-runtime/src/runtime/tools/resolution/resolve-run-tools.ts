import type { AgentDefinition, AgentToolPolicy } from "../../agents/agent-definition";
import type { RunId } from "../../core/types";
import type {
  AnyRuntimeToolDefinition,
  ToolRiskLevel,
} from "../contracts";
import { TOOL_RISK_LEVELS, TOOL_SIDE_EFFECTS } from "../contracts";
import type { BackendBridgeRunState } from "../kernel";
import {
  assertNamespaceId,
  parseCanonicalToolId,
  type RuntimeToolRegistry,
} from "../kernel";
import type {
  RunToolSnapshot,
  UnavailableRunTool,
} from "./run-tool-snapshot";
import type {
  RuntimeNetworkPolicy,
  RuntimeToolApprovalPolicy,
} from "../../../settings/contracts";
import { DEFAULT_NETWORK_ACCESS_SCOPE } from "../../../settings/defaults";

const RISK_RANK: Record<ToolRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export interface ResolveRunToolsInput {
  runId: RunId;
  agent: AgentDefinition;
  registry: RuntimeToolRegistry;
  backendBridgeState: BackendBridgeRunState;
  providerSupportsTools?: boolean;
  approvalPolicy?: RuntimeToolApprovalPolicy;
  networkPolicy?: RuntimeNetworkPolicy;
  createSnapshotId?: () => string;
  now?: () => number;
}

export interface ResolvedRunTools {
  snapshot: RunToolSnapshot;
  activeDefinitions: readonly AnyRuntimeToolDefinition[];
  warnings: readonly string[];
}

export function resolveRunTools(input: ResolveRunToolsInput): ResolvedRunTools {
  validateAgentToolPolicy(input.agent.toolPolicy);

  const allowedNamespaces = new Set(input.agent.toolPolicy.allowedNamespaces);
  const allowedTools = input.agent.toolPolicy.allowedTools
    ? new Set(input.agent.toolPolicy.allowedTools)
    : null;
  const deniedTools = new Set(input.agent.toolPolicy.deniedTools ?? []);
  const unavailable = new Map<string, string>();
  const candidates: AnyRuntimeToolDefinition[] = [];
  const warnings: string[] = [];

  for (const namespaceId of allowedNamespaces) {
    if (!input.registry.getNamespace(namespaceId)) {
      warnings.push(`Namespace ${namespaceId} is allowed by agent but not registered`);
    }
  }

  for (const namespace of input.registry.listNamespaces()) {
    if (!allowedNamespaces.has(namespace.id)) continue;

    const contribution = namespace.resolveForRun({
      runId: input.runId,
      agent: { id: input.agent.id, mode: input.agent.agentMode },
      backendBridge: { state: input.backendBridgeState },
    });
    const candidateIds = validateContribution(
      namespace.id,
      contribution.candidateToolIds,
      contribution.unavailableTools,
      input.registry,
    );

    for (const item of contribution.unavailableTools ?? []) {
      unavailable.set(item.toolId, item.reason);
    }
    for (const canonicalId of candidateIds) {
      const tool = input.registry.requireTool(canonicalId);
      const reason = resolveUnavailabilityReason({
        tool,
        policy: input.agent.toolPolicy,
        allowedTools,
        deniedTools,
        backendBridgeState: input.backendBridgeState,
        providerSupportsTools: input.providerSupportsTools,
      });
      if (reason) {
        unavailable.set(canonicalId, reason);
      } else {
        candidates.push(tool);
      }
    }
  }

  const activeTools = candidates.map((tool) =>
    Object.freeze({
      canonicalId: tool.id,
      providerName: input.registry.requireProviderName(tool.id),
    }),
  );
  const unavailableTools = [...unavailable].map(([canonicalId, reason]) =>
    Object.freeze({ canonicalId, reason }),
  );
  const ceiling = Object.freeze({
    ...input.agent.toolPolicy.executionCeiling,
    allowedSideEffects: Object.freeze([
      ...input.agent.toolPolicy.executionCeiling.allowedSideEffects,
    ]),
  });
  const snapshot = Object.freeze({
    snapshotId: input.createSnapshotId?.() ?? createSnapshotId(),
    runId: input.runId,
    createdAt: new Date((input.now ?? Date.now)()).toISOString(),
    agentMode: input.agent.agentMode,
    executionCeiling: ceiling,
    approvalPolicy: Object.freeze({
      autoApproveMaxRisk:
        input.approvalPolicy?.autoApproveMaxRisk ?? "low",
    }),
    networkPolicy: Object.freeze({
      accessScope:
        input.networkPolicy?.accessScope ?? DEFAULT_NETWORK_ACCESS_SCOPE,
    }),
    activeTools: Object.freeze(activeTools),
    ...(unavailableTools.length > 0
      ? { unavailableTools: Object.freeze(unavailableTools) }
      : {}),
  });

  return Object.freeze({
    snapshot,
    activeDefinitions: Object.freeze(candidates),
    warnings: Object.freeze(warnings),
  });
}

export function validateAgentToolPolicy(policy: AgentToolPolicy): void {
  assertUnique(policy.allowedNamespaces, "allowed Namespace");
  for (const namespaceId of policy.allowedNamespaces) {
    assertNamespaceId(namespaceId);
  }

  if (policy.allowedTools) {
    assertUnique(policy.allowedTools, "allowed Tool");
    for (const toolId of policy.allowedTools) parseCanonicalToolId(toolId);
  }
  if (policy.deniedTools) {
    assertUnique(policy.deniedTools, "denied Tool");
    for (const toolId of policy.deniedTools) parseCanonicalToolId(toolId);
  }
  if (new Set(policy.executionCeiling.allowedSideEffects).size !== policy.executionCeiling.allowedSideEffects.length) {
    throw new Error("Agent execution ceiling repeats a side effect");
  }
  if (!TOOL_RISK_LEVELS.includes(policy.executionCeiling.maxRiskLevel)) {
    throw new Error("Agent execution ceiling has an invalid risk level");
  }
  for (const sideEffect of policy.executionCeiling.allowedSideEffects) {
    if (!TOOL_SIDE_EFFECTS.includes(sideEffect)) {
      throw new Error(`Agent execution ceiling has invalid side effect "${sideEffect}"`);
    }
  }
}

function validateContribution(
  namespaceId: string,
  candidateToolIds: readonly string[],
  unavailableTools: readonly { toolId: string; reason: string }[] | undefined,
  registry: RuntimeToolRegistry,
): readonly string[] {
  assertUnique(candidateToolIds, `Namespace ${namespaceId} candidate Tool`);
  const unavailableIds = new Set<string>();
  for (const item of unavailableTools ?? []) {
    if (!item.reason.trim()) {
      throw new Error(`Namespace ${namespaceId} returned an empty unavailable reason`);
    }
    assertOwnedRegisteredTool(namespaceId, item.toolId, registry);
    if (unavailableIds.has(item.toolId)) {
      throw new Error(`Namespace ${namespaceId} repeated unavailable Tool "${item.toolId}"`);
    }
    unavailableIds.add(item.toolId);
  }

  for (const toolId of candidateToolIds) {
    assertOwnedRegisteredTool(namespaceId, toolId, registry);
    if (unavailableIds.has(toolId)) {
      throw new Error(
        `Namespace ${namespaceId} returned Tool "${toolId}" as both candidate and unavailable`,
      );
    }
  }
  return candidateToolIds;
}

function assertOwnedRegisteredTool(
  namespaceId: string,
  toolId: string,
  registry: RuntimeToolRegistry,
): void {
  const identity = parseCanonicalToolId(toolId);
  if (identity.namespaceId !== namespaceId || !registry.getTool(toolId)) {
    throw new Error(
      `Namespace ${namespaceId} contributed unowned or unregistered Tool "${toolId}"`,
    );
  }
}

function resolveUnavailabilityReason(input: {
  tool: AnyRuntimeToolDefinition;
  policy: AgentToolPolicy;
  allowedTools: ReadonlySet<string> | null;
  deniedTools: ReadonlySet<string>;
  backendBridgeState: BackendBridgeRunState;
  providerSupportsTools?: boolean;
}): string | null {
  if (input.deniedTools.has(input.tool.id)) {
    return "agent_tool_denied";
  }
  if (input.allowedTools && !input.allowedTools.has(input.tool.id)) {
    return "agent_tool_not_allowed";
  }
  if (input.tool.executionTarget === "backend" && input.backendBridgeState !== "ready") {
    return "backend_bridge_not_ready";
  }
  if (
    RISK_RANK[input.tool.risk.level] >
    RISK_RANK[input.policy.executionCeiling.maxRiskLevel]
  ) {
    return "risk_level_exceeds_ceiling";
  }
  if (!input.policy.executionCeiling.allowedSideEffects.includes(input.tool.risk.sideEffect)) {
    return "side_effect_not_allowed";
  }
  if (
    !input.policy.executionCeiling.allowIrreversible &&
    input.tool.risk.reversible !== true
  ) {
    return "irreversible_not_allowed";
  }
  if (input.providerSupportsTools === false) {
    return "provider_tools_unsupported";
  }
  return null;
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label} "${value}" is duplicated`);
    seen.add(value);
  }
}

function createSnapshotId(): string {
  return `tool_snapshot_${crypto.randomUUID().replaceAll("-", "")}`;
}
