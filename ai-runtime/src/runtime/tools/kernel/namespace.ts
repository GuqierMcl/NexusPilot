import type { AgentMode, RunId } from "../../core/types";
import type {
  AnyRuntimeToolDefinition,
  JsonObject,
} from "../contracts";

export type BackendBridgeRunState = "waiting" | "ready" | "disconnected";

export interface ToolRunContext {
  runId: RunId;
  agent: {
    id: string;
    mode: AgentMode;
  };
  backendBridge: {
    state: BackendBridgeRunState;
  };
}

export interface UnavailableNamespaceTool {
  toolId: string;
  reason: string;
}

export interface ResolvedNamespaceContribution {
  candidateToolIds: readonly string[];
  unavailableTools?: readonly UnavailableNamespaceTool[];
  metadata?: JsonObject;
}

export interface RuntimeToolNamespace {
  id: string;
  title: string;
  description: string;
  metadata?: JsonObject;
  tools: readonly AnyRuntimeToolDefinition[];
  resolveForRun(context: ToolRunContext): ResolvedNamespaceContribution;
}
