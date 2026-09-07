import { combineReferencedTexts } from "../../../../shared/composer-references";
import type {
  InterruptReason,
  Message,
  Part,
  RunInterrupt,
  TokenUsage,
  ToolState,
} from "../core/types";
import type { ContextCompactionActivity, ContextUsage } from "../context/types";

export interface AiSdkContextUsageView {
  contextWindow?: number;
  estimatedInputTokens: number;
  providerInputTokens?: number;
  reservedOutputTokens: number;
  activeTokens: number;
  source: "estimate" | "provider";
  view: "raw" | "checkpoint";
  checkpointId?: string;
  forecastReason?: string;
}

export interface AiSdkCompactionMarkerView {
  trigger: "auto_pre_turn" | "auto_mid_turn" | "manual" | "provider_overflow" | "model_switch";
  createdAt: number;
  coverageThroughRunId?: string;
  beforeTokens: number;
  afterTokens?: number;
  status: "preparing" | "created" | "failed" | "recovered";
}

export interface AiSdkDerivedMessageMetadata {
  contextUsage?: AiSdkContextUsageView;
  compaction?: AiSdkCompactionMarkerView;
  compactionActivities?: readonly ContextCompactionActivity[];
}

export function projectContextUsageToAiSdkView(
  usage: ContextUsage,
): AiSdkContextUsageView {
  const providerInputTokens = usage.providerObservation?.inputTokens;
  const forecast = usage.nextTurnForecast;
  const contextWindow = forecast ? forecast.contextWindow : usage.contextWindow;
  const estimatedInputTokens = forecast
    ? forecast.estimatedInputTokens
    : usage.estimatedInputTokens;
  const view = forecast ? forecast.view : usage.view;
  const checkpointId = forecast ? forecast.checkpointId : usage.checkpointId;

  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    estimatedInputTokens,
    ...(providerInputTokens === undefined ? {} : { providerInputTokens }),
    reservedOutputTokens: usage.reservedOutputTokens,
    activeTokens: estimatedInputTokens,
    source: "estimate",
    view,
    ...(checkpointId ? { checkpointId } : {}),
    ...(forecast ? { forecastReason: forecast.reason } : {}),
  };
}

export interface AiSdkUIMessageLike {
  id: string;
  role: "user" | "assistant" | "system";
  parts: AiSdkUIPartLike[];
  metadata?: Record<string, unknown>;
}

export type AiSdkUIPartLike =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "source-url"; sourceId: string; url: string; title?: string }
  | { type: "file"; mediaType: string; filename?: string; url: string }
  | {
      type: "data-context-compaction";
      id: string;
      data: ContextCompactionActivity;
    }
  | AiSdkToolPartLike;

export type AiSdkContextCompactionDataPart = Extract<
  AiSdkUIPartLike,
  { type: "data-context-compaction" }
>;

export type AiSdkToolPartLike = {
  type: `tool-${string}`;
  toolCallId: string;
  title?: string;
} & (
  | {
      state: "input-available";
      input: unknown;
    }
  | {
      state: "approval-requested";
      input: unknown;
      approval: { id: string };
    }
  | {
      state: "output-available";
      input: unknown;
      output: unknown;
    }
  | {
      state: "output-error";
      input: unknown | undefined;
      errorText: string;
    }
);

export function projectMessageToAiSdkUIMessage(
  message: Message,
  derived?: AiSdkDerivedMessageMetadata,
): AiSdkUIMessageLike {
  return {
    id: message.id,
    role: message.role,
    parts: message.role === "assistant" && derived?.compactionActivities?.length
      ? projectAssistantPartsWithCompactionActivities(
          message.parts,
          derived.compactionActivities,
        )
      : message.parts.flatMap(projectPartToAiSdkUIParts),
    metadata: buildMessageMetadata(message, derived),
  };
}

export function projectPartToAiSdkUIParts(part: Part): AiSdkUIPartLike[] {
  switch (part.type) {
    case "text":
      return [{ type: "text", text: part.text }];
    case "reasoning":
      return [{ type: "reasoning", text: part.redacted ? "[reasoning redacted]" : part.text }];
    case "source":
      return [
        {
          type: "source-url",
          sourceId: part.sourceId ?? part.id,
          url: part.url,
          title: part.title,
        },
      ];
    case "file": {
      return [
        {
          type: "file",
          mediaType: part.mediaType,
          filename: part.filename,
          url: `nexuspilot-attachment:${part.attachmentId}`,
        },
      ];
    }
    case "tool":
      return [projectToolPart(part)];
    case "diff":
    case "error":
    case "step-start":
    case "step-finish":
    case "retry":
    case "compaction":
      return [];
  }
}

function projectToolPart(
  part: Extract<Part, { type: "tool" }>,
): AiSdkToolPartLike {
  const { state } = part;
  const base = {
    type: `tool-${part.toolName}` as const,
    toolCallId:
      readAdapterId(part.metadata, "aiSdkToolCallId") ?? part.toolCallId,
    title: extractToolTitle(state),
  };

  switch (state.status) {
    case "waiting_for_permission":
      return {
        ...base,
        state: "approval-requested",
        input: state.input,
        approval: {
          id:
            readAdapterId(part.metadata, "aiSdkApprovalId") ??
            state.permissionId,
        },
      };
    case "completed":
      return {
        ...base,
        state: "output-available",
        input: state.input,
        output: state.output,
      };
    case "error":
      return {
        ...base,
        state: "output-error",
        input: state.input,
        errorText: state.error.message,
      };
    case "interrupted":
      return {
        ...base,
        state: "output-error",
        input: state.input,
        errorText: state.reason ?? "Tool call interrupted",
      };
    case "pending":
    case "validating":
    case "running":
      return {
        ...base,
        state: "input-available",
        input: extractToolInput(state),
      };
  }
}

function readAdapterId(
  metadata: Record<string, unknown> | undefined,
  key: "aiSdkToolCallId" | "aiSdkApprovalId",
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function extractToolInput(state: ToolState): unknown {
  return "input" in state ? state.input : undefined;
}

function extractToolTitle(state: ToolState): string | undefined {
  return "title" in state ? state.title : undefined;
}

function buildMessageMetadata(
  message: Message,
  derived?: AiSdkDerivedMessageMetadata,
): Record<string, unknown> {
  const nexus: Record<string, unknown> = {
    conversationId: message.conversationId,
  };
  const aiSdkUsage =
    message.role === "assistant" && message.usage
      ? projectRuntimeUsageForAiSdk(message.usage)
      : undefined;

  if (message.role === "assistant") {
    nexus.runId = message.runId;
    nexus.providerId = message.providerId;
    nexus.modelId = message.modelId;
    nexus.agentMode = message.agentMode;

    if (message.usage) {
      nexus.usage = message.usage;
    }
    if (message.cost) {
      nexus.cost = message.cost;
    }
    if (message.finish) {
      nexus.finish = message.finish;
    }
    if (message.status.type !== "complete") {
      nexus.status = message.status;
    }
    const interrupt = sanitizeInterrupt(message.metadata?.interrupt);
    if (interrupt) {
      nexus.interrupt = interrupt;
    }
    if (derived?.contextUsage) {
      nexus.contextUsage = sanitizeContextUsage(derived.contextUsage);
    }
    if (derived?.compaction) {
      nexus.compaction = sanitizeCompactionMarker(derived.compaction);
    }
  }

  return {
    nexus,
    custom: {
      nexus,
      ...(message.role === "user" && message.parts.some((part) => part.type === "text" && (part.references || part.command))
        ? { composerReferences: combineReferencedTexts(message.parts.filter((part) => part.type === "text")) } : {}),
      ...(aiSdkUsage ? { usage: aiSdkUsage } : {}),
    },
    ...(aiSdkUsage ? { usage: aiSdkUsage } : {}),
  };
}

function projectAssistantPartsWithCompactionActivities(
  parts: readonly Part[],
  activities: readonly ContextCompactionActivity[],
): AiSdkUIPartLike[] {
  const ordered = [...activities].sort((left, right) =>
    compactionBoundaryStepIndex(left) - compactionBoundaryStepIndex(right)
    || left.requestIndex - right.requestIndex
    || left.attemptIndex - right.attemptIndex
    || left.startedAt - right.startedAt
    || left.id.localeCompare(right.id),
  );
  const projected: AiSdkUIPartLike[] = [];
  const inserted = new Set<string>();
  const appendBoundaryActivities = (requestIndex: number): void => {
    for (const activity of ordered) {
      if (
        compactionBoundaryStepIndex(activity) !== requestIndex
        || inserted.has(activity.id)
      ) continue;
      projected.push(projectContextCompactionActivityToAiSdkDataPart(activity));
      inserted.add(activity.id);
    }
  };
  for (const part of parts) {
    if (part.type === "step-start") appendBoundaryActivities(part.stepIndex);
    projected.push(...projectPartToAiSdkUIParts(part));
  }
  for (const activity of ordered) {
    if (inserted.has(activity.id)) continue;
    projected.push(projectContextCompactionActivityToAiSdkDataPart(activity));
  }
  return projected;
}

export function projectContextCompactionActivityToAiSdkDataPart(
  activity: ContextCompactionActivity,
): AiSdkContextCompactionDataPart {
  return {
    type: "data-context-compaction",
    id: activity.id,
    data: sanitizeCompactionActivity(activity),
  };
}

function sanitizeCompactionActivity(
  activity: ContextCompactionActivity,
): ContextCompactionActivity {
  return {
    id: activity.id,
    conversationId: activity.conversationId,
    runId: activity.runId,
    requestIndex: activity.requestIndex,
    ...(activity.boundaryStepIndex === undefined
      ? {}
      : { boundaryStepIndex: activity.boundaryStepIndex }),
    attemptIndex: activity.attemptIndex,
    trigger: activity.trigger,
    status: activity.status,
    sourceHeadRunId: activity.sourceHeadRunId,
    sourceConversationRevision: activity.sourceConversationRevision,
    ...(activity.coverageCursor
      ? { coverageCursor: structuredClone(activity.coverageCursor) }
      : {}),
    ...(activity.checkpointId ? { checkpointId: activity.checkpointId } : {}),
    beforeEstimatedInputTokens: activity.beforeEstimatedInputTokens,
    ...(activity.afterEstimatedInputTokens === undefined
      ? {}
      : { afterEstimatedInputTokens: activity.afterEstimatedInputTokens }),
    startedAt: activity.startedAt,
    ...(activity.completedAt === undefined ? {} : { completedAt: activity.completedAt }),
  };
}

function compactionBoundaryStepIndex(activity: ContextCompactionActivity): number {
  return activity.boundaryStepIndex ?? activity.requestIndex;
}

function sanitizeInterrupt(value: unknown): RunInterrupt | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (!isInterruptReason(record.reason) || typeof record.interruptedAt !== "string") {
    return undefined;
  }
  return {
    reason: record.reason,
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    interruptedAt: record.interruptedAt,
  };
}

function isInterruptReason(value: unknown): value is InterruptReason {
  return value === "user_stop"
    || value === "client_disconnect"
    || value === "runtime_shutdown"
    || value === "runtime_recovered_stale_run"
    || value === "tool_abort"
    || value === "timeout"
    || value === "unknown";
}

function sanitizeContextUsage(usage: AiSdkContextUsageView): AiSdkContextUsageView {
  return {
    ...(typeof usage.contextWindow === "number" ? { contextWindow: usage.contextWindow } : {}),
    estimatedInputTokens: usage.estimatedInputTokens,
    ...(typeof usage.providerInputTokens === "number"
      ? { providerInputTokens: usage.providerInputTokens }
      : {}),
    reservedOutputTokens: usage.reservedOutputTokens,
    activeTokens: usage.activeTokens,
    source: usage.source,
    view: usage.view,
    ...(typeof usage.checkpointId === "string" ? { checkpointId: usage.checkpointId } : {}),
    ...(typeof usage.forecastReason === "string"
      ? { forecastReason: usage.forecastReason }
      : {}),
  };
}

function sanitizeCompactionMarker(marker: AiSdkCompactionMarkerView): AiSdkCompactionMarkerView {
  return {
    trigger: marker.trigger,
    createdAt: marker.createdAt,
    ...(marker.coverageThroughRunId === undefined
      ? {}
      : { coverageThroughRunId: marker.coverageThroughRunId }),
    beforeTokens: marker.beforeTokens,
    ...(marker.afterTokens === undefined ? {} : { afterTokens: marker.afterTokens }),
    status: marker.status,
  };
}

function projectRuntimeUsageForAiSdk(usage: TokenUsage): Record<string, number> {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    reasoningTokens: usage.reasoning,
    totalTokens: usage.total,
    ...(usage.cache?.read !== undefined
      ? { cachedInputTokens: usage.cache.read }
      : {}),
  };
}
