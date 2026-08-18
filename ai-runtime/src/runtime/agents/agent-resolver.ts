import {
  BuiltInAgentDefinitionRegistry,
  type AgentDefinition,
} from "./agent-definition";
import {
  assemblePrompt,
  type PromptAssemblyResult,
} from "./prompt-assembler";
import type { AgentMode, RunId, RunLimits } from "../core/types";
import {
  resolveRunTools,
  RuntimeToolRegistry,
  type BackendBridgeRunState,
  type ResolvedRunTools,
} from "../tools";
import type {
  RuntimeNetworkPolicy,
  RuntimeToolApprovalPolicy,
} from "../../settings/contracts";

export interface AgentResolverProviderContext {
  providerId: string;
  modelId: string;
  modelName?: string;
  contextLength?: number;
  outputLength?: number;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
}

export interface ResolvedAgentExecutionPolicy {
  agentMode: AgentMode;
  agent: AgentDefinition;
  prompt: PromptAssemblyResult;
  toolResolution: ResolvedRunTools;
  limits: RunLimits;
  modelSettings: {
    temperature?: number;
    topP?: number;
    toolChoice?: "auto" | "none";
  };
  trace: {
    promptAssemblyVersion: string;
    promptBlockIds: string[];
    enabledToolNames: string[];
    activeToolNames: string[];
    warnings: string[];
  };
}

export interface ResolveAgentExecutionPolicyInput {
  runId: RunId;
  agentMode?: AgentMode;
  provider: AgentResolverProviderContext;
  toolRegistry?: RuntimeToolRegistry;
  backendBridgeState?: BackendBridgeRunState;
  approvalPolicy?: RuntimeToolApprovalPolicy;
  networkPolicy?: RuntimeNetworkPolicy;
  registry?: BuiltInAgentDefinitionRegistry;
  createToolSnapshotId?: () => string;
  now?: () => number;
}

export function resolveAgentExecutionPolicy(
  input: ResolveAgentExecutionPolicyInput,
): ResolvedAgentExecutionPolicy {
  const registry = input.registry ?? new BuiltInAgentDefinitionRegistry();
  const toolRegistry = input.toolRegistry ?? new RuntimeToolRegistry([]);
  const agentMode = input.agentMode ?? "ask";
  const agent = registry.require(agentMode);
  const limits = { ...agent.limits };
  const toolResolution = resolveRunTools({
    runId: input.runId,
    agent,
    registry: toolRegistry,
    backendBridgeState: input.backendBridgeState ?? "waiting",
    providerSupportsTools: input.provider.supportsTools,
    approvalPolicy: input.approvalPolicy,
    networkPolicy: input.networkPolicy,
    createSnapshotId: input.createToolSnapshotId,
    now: input.now,
  });
  const prompt = assemblePrompt({
    agent,
    availableAgents: registry.list(),
    activeToolNames: toolResolution.snapshot.activeTools.map(
      (tool) => tool.canonicalId,
    ),
    runtimeContext: {
      providerId: input.provider.providerId,
      modelId: input.provider.modelId,
      supportsTools: input.provider.supportsTools,
    },
    warnings: [...toolResolution.warnings],
  });
  const warnings = [
    ...new Set([...toolResolution.warnings, ...prompt.warnings]),
  ];

  return {
    agentMode,
    agent,
    prompt,
    toolResolution,
    limits,
    modelSettings: { ...agent.modelBehavior },
    trace: {
      promptAssemblyVersion: prompt.version,
      promptBlockIds: prompt.blocks.map((block) => block.id),
      enabledToolNames: toolResolution.snapshot.activeTools.map(
        (tool) => tool.canonicalId,
      ),
      activeToolNames: toolResolution.snapshot.activeTools.map(
        (tool) => tool.canonicalId,
      ),
      warnings,
    },
  };
}
