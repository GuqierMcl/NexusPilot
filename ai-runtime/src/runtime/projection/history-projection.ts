import { messageHistoryViewSchema } from "../core/schemas";
import type {
  Conversation,
  Message,
  MessageHistoryView,
  Permission,
  Run,
  RunId,
  TraceEvent,
} from "../core/types";
import type {
  ContextCheckpoint,
  ContextCompactionActivity,
  ContextPlan,
  ContextUsage,
} from "../context/types";
import {
  projectContextUsageToAiSdkView,
  projectMessageToAiSdkUIMessage,
  type AiSdkCompactionMarkerView,
  type AiSdkDerivedMessageMetadata,
  type AiSdkUIMessageLike,
} from "./ai-sdk-projection";
import { projectMessageToUiMessage, type UiMessageLike } from "./ui-projection";

export type MessageHistoryFormat = "runtime" | "ui" | "ai_sdk";

export interface ConversationSummarySnapshot {
  id: string;
  title: string;
  status: Conversation["status"];
  active_run_id?: string;
  time: Conversation["time"];
  metadata?: Record<string, unknown>;
}

export interface RunSnapshot {
  id: string;
  conversation_id: string;
  parent_run_id?: string;
  supersedes_run_id?: string;
  agent_mode: Run["agentMode"];
  provider_id: string;
  model_id: string;
  status: Run["status"];
  finish?: Run["finish"];
  time: Run["time"];
}

export interface RunDetailSnapshot extends RunSnapshot {
  input: Run["input"];
  output?: Run["output"];
  usage?: Run["usage"];
  cost?: Run["cost"];
  error?: Run["error"];
  limits: Run["limits"];
  metadata?: Record<string, unknown>;
}

export function projectPermissionSnapshot(permission: Permission) {
  const target = permission.presentation?.target;
  const sql = permission.presentation?.sql;
  return {
    id: permission.id,
    run_id: permission.runId,
    message_id: permission.messageId,
    tool_call_id: permission.toolCallId,
    status: permission.status,
    tool_id: permission.toolId,
    title: permission.title,
    ...(permission.inputSummary
      ? { input_summary: permission.inputSummary }
      : {}),
    risk: permission.risk,
    confirmation: permission.confirmation,
    ...(permission.presentation
      ? {
          presentation: {
            ...(target
              ? {
                  target: {
                    ...(target.profileId
                      ? { profile_id: target.profileId }
                      : {}),
                    ...(target.connectionName
                      ? { connection_name: target.connectionName }
                      : {}),
                    ...(target.driver ? { driver: target.driver } : {}),
                    ...(target.environment
                      ? { environment: target.environment }
                      : {}),
                    ...(target.database ? { database: target.database } : {}),
                    ...(target.schema ? { schema: target.schema } : {}),
                    ...(target.redisDbIndex !== undefined
                      ? { redis_db_index: target.redisDbIndex }
                      : {}),
                  },
                }
              : {}),
            ...(permission.presentation.riskReasons
              ? { risk_reasons: permission.presentation.riskReasons }
              : {}),
            ...(sql
              ? {
                  sql: {
                    text: sql.text,
                    analysis_status: sql.analysisStatus,
                    ...(sql.statementClass
                      ? { statement_class: sql.statementClass }
                      : {}),
                    ...(sql.identifiedTargets
                      ? { identified_targets: sql.identifiedTargets }
                      : {}),
                  },
                }
              : {}),
            ...(permission.presentation.keyValue
              ? {
                  key_value: {
                    operation: permission.presentation.keyValue.operation,
                    key: permission.presentation.keyValue.key,
                    ...(permission.presentation.keyValue.newKey
                      ? { new_key: permission.presentation.keyValue.newKey }
                      : {}),
                    ...(permission.presentation.keyValue.valueType
                      ? { value_type: permission.presentation.keyValue.valueType }
                      : {}),
                    ...(permission.presentation.keyValue.ttlMode
                      ? { ttl_mode: permission.presentation.keyValue.ttlMode }
                      : {}),
                    ...(permission.presentation.keyValue.ttlSeconds !== undefined
                      ? { ttl_seconds: permission.presentation.keyValue.ttlSeconds }
                      : {}),
                  },
                }
              : {}),
            ...(permission.presentation.timeoutMs !== undefined
              ? { timeout_ms: permission.presentation.timeoutMs }
              : {}),
            ...(permission.presentation.maxResultBytes !== undefined
              ? { max_result_bytes: permission.presentation.maxResultBytes }
              : {}),
            ...(permission.presentation.outcomeWarnings
              ? { outcome_warnings: permission.presentation.outcomeWarnings }
              : {}),
          },
        }
      : {}),
    created_at: permission.createdAt,
  };
}

export type MessageHistoryProjection = Message[] | UiMessageLike[] | AiSdkUIMessageLike[];

export interface ActiveHistoryContextStore {
  listContextCheckpoints(conversationId: Conversation["id"]): ContextCheckpoint[];
  listContextCompactionActivitiesByRun(runId: RunId): ContextCompactionActivity[];
  listContextPlansByRun(runId: RunId): ContextPlan[];
  listContextUsagesByRun(runId: RunId): ContextUsage[];
  listTraces(runId: RunId): TraceEvent[];
}

export interface ConversationMessagesSnapshot {
  conversation_id: string;
  active_head_run_id?: string;
  revision: number;
  view: MessageHistoryView;
  format: MessageHistoryFormat;
  messages: MessageHistoryProjection;
  context_compaction_activities: ContextCompactionActivity[];
  runs?: RunSnapshot[];
}

export function projectConversationSummary(
  conversation: Conversation,
): ConversationSummarySnapshot {
  const activeRunId = getActiveRunId(conversation.status);

  return {
    id: conversation.id,
    title: conversation.title,
    status: conversation.status,
    ...(activeRunId ? { active_run_id: activeRunId } : {}),
    time: conversation.time,
    ...(conversation.metadata ? { metadata: conversation.metadata } : {}),
  };
}

export function projectRunSnapshot(run: Run): RunDetailSnapshot {
  return {
    id: run.id,
    conversation_id: run.conversationId,
    ...(run.parentRunId ? { parent_run_id: run.parentRunId } : {}),
    ...(run.supersedesRunId ? { supersedes_run_id: run.supersedesRunId } : {}),
    agent_mode: run.agentMode,
    provider_id: run.providerId,
    model_id: run.modelId,
    status: run.status,
    input: run.input,
    ...(run.output ? { output: run.output } : {}),
    ...(run.usage ? { usage: run.usage } : {}),
    ...(run.cost ? { cost: run.cost } : {}),
    ...(run.finish ? { finish: run.finish } : {}),
    ...(run.error ? { error: run.error } : {}),
    time: run.time,
    limits: run.limits,
    ...(run.metadata ? { metadata: run.metadata } : {}),
  };
}

export function projectTranscriptRunSnapshot(run: Run): RunSnapshot {
  return {
    id: run.id,
    conversation_id: run.conversationId,
    ...(run.parentRunId ? { parent_run_id: run.parentRunId } : {}),
    ...(run.supersedesRunId ? { supersedes_run_id: run.supersedesRunId } : {}),
    agent_mode: run.agentMode,
    provider_id: run.providerId,
    model_id: run.modelId,
    status: run.status,
    ...(run.finish ? { finish: run.finish } : {}),
    time: run.time,
  };
}

export function projectMessageHistory(
  messages: Message[],
  format: MessageHistoryFormat,
  derivedByRunId?: ReadonlyMap<RunId, AiSdkDerivedMessageMetadata>,
): MessageHistoryProjection {
  if (format === "ui") {
    return messages.map(projectMessageToUiMessage);
  }

  if (format === "ai_sdk") {
    return messages.map((message) => projectMessageToAiSdkUIMessage(
      message,
      message.role === "assistant" && message.runId
        ? derivedByRunId?.get(message.runId)
        : undefined,
    ));
  }

  return messages;
}

export function parseMessageHistoryFormat(value: unknown): MessageHistoryFormat | null {
  if (value === undefined) {
    return "runtime";
  }

  if (value === "runtime" || value === "ui" || value === "ai_sdk") {
    return value;
  }

  return null;
}

/**
 * Builds a presentation-only context view for the already selected active lineage.
 * It deliberately reads only allowlisted scalar facts and never writes Message JSON.
 */
export function buildActiveHistoryContextMetadata(
  messages: readonly Message[],
  store: ActiveHistoryContextStore,
): ReadonlyMap<RunId, AiSdkDerivedMessageMetadata> {
  const checkpoints = new Map(
    messages.length > 0
      ? store.listContextCheckpoints(messages[0]!.conversationId).map((checkpoint) => [checkpoint.id, checkpoint])
      : [],
  );
  const derived = new Map<RunId, AiSdkDerivedMessageMetadata>();

  for (const message of messages) {
    if (message.role !== "assistant" || !message.runId) continue;
    const usages = store.listContextUsagesByRun(message.runId);
    const usage = usages.at(-1);
    const compactionActivities = store.listContextCompactionActivitiesByRun(message.runId);
    const traces = store.listTraces(message.runId);
    const plans = store.listContextPlansByRun(message.runId);
    const markerAssociation = usage ? findLatestMarkerAssociation({
      conversationId: message.conversationId,
      runId: message.runId,
      plans,
      usages,
      checkpoints,
    }) : null;
    const lifecycleMarker = projectLatestCompactionLifecycleTrace(
      message.conversationId,
      message.runId,
      traces,
      message.status.type === "complete"
        || message.status.type === "incomplete"
        || message.status.type === "error",
    );
    const compaction = markerAssociation
      ? projectCompactionMarker(
          markerAssociation.usage,
          markerAssociation.plan,
          markerAssociation.checkpoint,
          traces,
        )
      : lifecycleMarker;
    if (!usage && !compaction && compactionActivities.length === 0) continue;
    derived.set(message.runId, {
      ...(usage ? { contextUsage: projectContextUsageToAiSdkView(usage) } : {}),
      ...(markerAssociation
        ? { compaction }
        : compaction ? { compaction } : {}),
      ...(compactionActivities.length > 0 ? { compactionActivities } : {}),
    });
  }
  return derived;
}

function projectLatestCompactionLifecycleTrace(
  conversationId: string,
  runId: RunId,
  traces: readonly TraceEvent[],
  assistantIsTerminal: boolean,
): AiSdkCompactionMarkerView | undefined {
  const trace = traces.findLast((candidate) =>
    (candidate.type === "context.compaction.preparing"
      || candidate.type === "context.compaction.failed")
    && candidate.conversationId === conversationId
    && candidate.runId === runId
    && isCompactionTrigger(candidate.payload.trigger)
    && isNonNegativeNumber(candidate.payload.beforeEstimatedInputTokens)
  );
  if (!trace) return undefined;
  const status = trace.type === "context.compaction.failed" || assistantIsTerminal
    ? "failed"
    : "preparing";
  return {
    trigger: trace.payload.trigger as AiSdkCompactionMarkerView["trigger"],
    createdAt: trace.time,
    beforeTokens: trace.payload.beforeEstimatedInputTokens as number,
    status,
  };
}

function isCompactionTrigger(value: unknown): boolean {
  return value === "auto_pre_turn"
    || value === "auto_mid_turn"
    || value === "manual"
    || value === "provider_overflow"
    || value === "model_switch";
}

function projectCompactionMarker(
  usage: ContextUsage,
  plan: ContextPlan,
  checkpoint: ContextCheckpoint,
  traces: readonly TraceEvent[],
): AiSdkCompactionMarkerView {
  const recovered = traces.find((trace) =>
    trace.type === "context.overflow.recovered"
    && trace.conversationId === usage.conversationId
    && trace.runId === usage.runId
    && trace.payload.checkpointId === checkpoint.id
    && trace.payload.requestIndex === usage.requestIndex
    && trace.payload.sourceHeadRunId === plan.sourceHeadRunId
    && trace.payload.sourceConversationRevision === plan.sourceConversationRevision
  );
  const beforeTokens = recovered && isNonNegativeNumber(recovered.payload.beforeEstimatedInputTokens)
    ? recovered.payload.beforeEstimatedInputTokens
    : checkpoint.budget.estimatedInputTokens;
  const afterTokens = recovered && isNonNegativeNumber(recovered.payload.afterEstimatedInputTokens)
    ? recovered.payload.afterEstimatedInputTokens
    : usage.estimatedInputTokens;
  return {
    trigger: recovered ? "provider_overflow" : checkpoint.trigger,
    createdAt: recovered?.time ?? checkpoint.time.created,
    coverageThroughRunId: checkpoint.coverageThroughRunId,
    beforeTokens,
    afterTokens,
    status: recovered ? "recovered" : "created",
  };
}

function findLatestMarkerAssociation(input: {
  conversationId: string;
  runId: RunId;
  plans: readonly ContextPlan[];
  usages: readonly ContextUsage[];
  checkpoints: ReadonlyMap<string, ContextCheckpoint>;
}): { usage: ContextUsage; plan: ContextPlan; checkpoint: ContextCheckpoint } | null {
  const candidates = input.plans.flatMap((plan) => {
    if (
      plan.conversationId !== input.conversationId
      || plan.runId !== input.runId
      || plan.sourceHeadRunId !== input.runId
      || plan.view !== "checkpoint"
      || !plan.checkpointId
    ) {
      return [];
    }
    const checkpoint = input.checkpoints.get(plan.checkpointId);
    const usage = input.usages.find((candidate) =>
      candidate.conversationId === input.conversationId
      && candidate.runId === input.runId
      && candidate.requestIndex === plan.requestIndex
      && candidate.view === "checkpoint"
      && candidate.checkpointId === plan.checkpointId,
    );
    if (
      !checkpoint
      || !usage
      || checkpoint.conversationId !== input.conversationId
      || checkpoint.sourceHeadRunId !== plan.sourceHeadRunId
      || checkpoint.sourceConversationRevision !== plan.sourceConversationRevision
    ) {
      return [];
    }
    return [{ usage, plan, checkpoint }];
  });
  return candidates.sort((left, right) =>
    right.checkpoint.time.created - left.checkpoint.time.created
    || left.usage.requestIndex - right.usage.requestIndex,
  )[0] ?? null;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function parseMessageHistoryView(value: unknown): MessageHistoryView | null {
  if (value === undefined) {
    return "active";
  }

  const parsed = messageHistoryViewSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function getActiveRunId(status: Conversation["status"]): string | undefined {
  if (status.type === "busy" || status.type === "waiting_for_permission") {
    return status.runId;
  }

  return undefined;
}
