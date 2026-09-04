import type {
  ContextCheckpointId,
  ContextPlanId,
  ContextUsageId,
  Conversation,
  ConversationId,
  Message,
  MessageId,
  Permission,
  Run,
  RunId,
  ToolCall,
} from "../core/types";

export type ContextCompactionTrigger =
  | "auto_pre_turn"
  | "auto_mid_turn"
  | "manual"
  | "provider_overflow"
  | "model_switch";

export interface ContextCompactionPolicy {
  version: string;
  softTriggerRatio: number;
  targetRatio: number;
  safetyMarginTokens: number;
  minRawRuns: number;
  summaryMaxOutputTokens: number;
  summaryMaxChars: number;
  estimatorVersion: string;
  checkpointFormatVersion: string;
  compatibilityVersion: number;
}

export interface ContextPreparationClaimRequest {
  runId: RunId;
  requestIndex: number;
  requestHash: string;
  ownerId: string;
  ttlMs: number;
}

export interface ContextPreparationClaim {
  runId: RunId;
  requestIndex: number;
  requestHash: string;
  ownerId: string;
  fencingToken: number;
  claimedAt: number;
  expiresAt: number;
}

export type ContextPreparationClaimResult =
  | { status: "acquired"; claim: ContextPreparationClaim }
  | { status: "in_progress"; claim: ContextPreparationClaim }
  | { status: "conflict"; claim: ContextPreparationClaim };

export interface ContextPreparationClaimRelease {
  runId: RunId;
  requestIndex: number;
  requestHash: string;
  ownerId: string;
  fencingToken: number;
}

export class ContextPreparationLeaseLostError extends Error {
  constructor(runId: RunId, requestIndex: number) {
    super(`Context preparation lease is expired or superseded: ${runId}/${requestIndex}`);
    this.name = "ContextPreparationLeaseLostError";
  }
}

export interface ContextCheckpointCompatibility {
  /** Unknown values are preserved by storage and rejected by the current planner. */
  kind: string;
  version: number;
}

export interface ContextBudgetSnapshot {
  providerId: string;
  modelId: string;
  contextWindow?: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  systemPromptTokens: number;
  toolSchemaTokens: number;
  hardInputBudget?: number;
  softTriggerTokens?: number;
  targetTokens?: number;
  rawHistoryTokens: number;
  checkpointTokens: number;
  safetyStateTokens: number;
  estimatedInputTokens: number;
}

export interface ContextProviderUsageObservation {
  source: "provider";
  inputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ContextUsageBreakdown {
  rawTokens: number;
  checkpointTokens: number;
  safetyStateTokens: number;
  systemPromptTokens: number;
  toolSchemaTokens: number;
}

export interface ContextUsage {
  id: ContextUsageId;
  conversationId: ConversationId;
  runId: RunId;
  requestIndex: number;
  providerId: string;
  modelId: string;
  contextWindow?: number;
  estimatedInputTokens: number;
  estimateSource: "estimate";
  reservedOutputTokens: number;
  view: "raw" | "checkpoint";
  checkpointId?: ContextCheckpointId;
  breakdown: ContextUsageBreakdown;
  providerObservation?: ContextProviderUsageObservation;
  estimatorVersion: string;
  policyVersion: string;
  checkpointFormatVersion: string;
  time: { created: number };
}

export interface RuntimeSafetyRisk {
  level: "unknown" | "low" | "medium" | "high" | "critical";
  reversible: boolean | "unknown";
  sideEffects: (
    | "unknown"
    | "none"
    | "external_network"
    | "runtime_state"
    | "workbench_state"
    | "business_read"
    | "business_write"
    | "destructive"
  )[];
}

export interface RuntimeSafetyTarget {
  kind: "structured" | "unknown";
  profileId?: string;
  connectionName?: string;
  driver?: string;
  environment?: string;
  database?: string;
  schema?: string;
  redisDbIndex?: number;
  identifiedTargets?: string[];
  key?: string;
  newKey?: string;
}

export interface RuntimeSafetyEffect {
  toolCallId: ToolCall["id"];
  runId: RunId;
  operation: string;
  activeLineage: boolean;
  risk: RuntimeSafetyRisk;
  target: RuntimeSafetyTarget;
  outcome:
    | "completed"
    | "possibly_executed"
    | "running"
    | "waiting"
    | "unknown";
  certainty: "confirmed" | "uncertain";
}

export interface RuntimeSafetyPermissionAudit {
  permissionId: Permission["id"];
  toolCallId: ToolCall["id"];
  runId: RunId;
  status: Permission["status"];
  decisionSource?: "user" | "system";
  confirmationVerified?: boolean;
  nonTransferable: true;
}

export interface RuntimeSafetyState {
  version: string;
  conversationId: ConversationId;
  effects: RuntimeSafetyEffect[];
  permissions: RuntimeSafetyPermissionAudit[];
  hash: string;
}

export interface ContextCheckpoint {
  id: ContextCheckpointId;
  conversationId: ConversationId;
  coverageThroughRunId: RunId;
  sourceHeadRunId: RunId;
  sourceConversationRevision: number;
  lineageHash: string;
  sourceStateHash: string;
  safetyStateHash: string;
  parentCheckpointId?: ContextCheckpointId;
  trigger: ContextCompactionTrigger;
  formatVersion: string;
  compatibility: ContextCheckpointCompatibility;
  generatedBy: {
    providerId: string;
    modelId: string;
  };
  summary: string;
  safetyStateVersion: string;
  budget: ContextBudgetSnapshot;
  usage?: ContextUsage;
  time: { created: number };
}

export interface ContextRawRange {
  fromRunId: RunId;
  throughRunId: RunId;
}

export type ContextPlanReason =
  | "context_window_unavailable"
  | "raw_within_budget"
  | "raw_compaction_blocked"
  | "checkpoint_selected"
  | "compaction_required";

export interface ContextPlan {
  id: ContextPlanId;
  conversationId: ConversationId;
  runId: RunId;
  requestIndex: number;
  sourceHeadRunId: RunId;
  sourceConversationRevision: number;
  trigger: ContextCompactionTrigger;
  providerId: string;
  modelId: string;
  view: "raw" | "checkpoint";
  reason: ContextPlanReason;
  checkpointId?: ContextCheckpointId;
  lineageRunIds: RunId[];
  rawRunIds: RunId[];
  rawRange?: ContextRawRange;
  eligibleCoverageThroughRunId?: RunId;
  safetyState: RuntimeSafetyState;
  budget: ContextBudgetSnapshot;
  requestHash: string;
  viewHash: string;
  time: { created: number };
}

export interface ContextCheckpointCommit {
  checkpoint: ContextCheckpoint;
  eventId: `evt_${string}`;
  preparationClaim: ContextPreparationClaim;
}

export interface ContextPlanCommit {
  plan: ContextPlan;
  preparationClaim: ContextPreparationClaim;
}

export interface ContextPlannerSnapshot {
  conversation: Conversation;
  runs: readonly Run[];
  messages: readonly Message[];
  toolCalls: readonly ToolCall[];
  permissions: readonly Permission[];
  checkpoints: readonly ContextCheckpoint[];
}

export interface ContextPlannerInput {
  snapshot: ContextPlannerSnapshot;
  runId: RunId;
  requestIndex: number;
  providerId: string;
  modelId: string;
  contextWindow?: number;
  reservedOutputTokens: number;
  systemPrompt: string;
  toolSchemas: unknown;
  trigger: ContextCompactionTrigger;
  policy: ContextCompactionPolicy;
  planId: ContextPlanId;
  createdAt: number;
  safetyStateMaxTokens?: number;
  /** Durable Assistant replaced by the exact in-flight AI SDK suffix. */
  excludeAssistantMessageId?: MessageId;
  /** Exact projected suffix already retained by the AI SDK for this request. */
  retainedModelInput?: {
    estimatedTokens: number;
    contentHash: string;
  };
}
