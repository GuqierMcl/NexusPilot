import { createHash } from "node:crypto";

import type {
  AssistantMessage,
  Permission,
  Run,
  ToolCall,
  ToolPart,
} from "../core/types";
import { stableStringifyJson } from "./token-estimator";
import type { ContextCheckpoint, ContextPlannerSnapshot } from "./types";
import {
  canonicalizeContextSummarySource,
  projectCanonicalContextSummarySource,
  type CanonicalContextSummarySource,
} from "./summary-prompt";

const TERMINAL_RUN_STATUSES = new Set<Run["status"]>([
  "completed",
  "failed",
  "interrupted",
]);
const TERMINAL_ASSISTANT_STATUSES = new Set<AssistantMessage["status"]["type"]>([
  "complete",
  "incomplete",
  "error",
]);
const TERMINAL_TOOL_STATUSES = new Set<ToolPart["state"]["status"]>([
  "completed",
  "error",
  "interrupted",
]);

export interface ContextCoverageBoundaryInput {
  snapshot: ContextPlannerSnapshot;
  lineageRuns: readonly Run[];
  coverageIndex: number;
}

export interface ContextCoverageSourceStateInput extends ContextCoverageBoundaryInput {
  safetyStateHash: string;
  parentCheckpoint?: ContextCheckpoint;
}

export interface ContextCoverageSourceState {
  safe: boolean;
  sourceStateHash: string;
  safetyStateHash: string;
  sourceMessages: ReturnType<typeof projectCanonicalContextSummarySource>;
}

interface ContextCoverageBoundaryAnalysis {
  safe: boolean;
  coveredRuns: Array<{
    runId: Run["id"];
    status: Run["status"];
    userMessageId?: string;
    assistantMessageId?: AssistantMessage["id"];
    assistantStatus?: AssistantMessage["status"]["type"];
    toolParts: Array<{
      partId: ToolPart["id"];
      conversationId: ToolPart["conversationId"];
      messageId: ToolPart["messageId"];
      toolCallId: ToolPart["toolCallId"];
      toolName: ToolPart["toolName"];
      status: ToolPart["state"]["status"];
    }>;
  }>;
}

export function isContextCoverageBoundarySafe(
  input: ContextCoverageBoundaryInput,
): boolean {
  return analyzeContextCoverageBoundary(input).safe;
}

export function computeContextCoverageSourceState(
  input: ContextCoverageSourceStateInput,
): ContextCoverageSourceState {
  const analysis = analyzeContextCoverageBoundary(input);
  const activeRunIds = new Set(input.lineageRuns.map((run) => run.id));
  const toolCalls = input.snapshot.toolCalls
    .filter((toolCall) =>
      toolCall.conversationId === input.snapshot.conversation.id
      && activeRunIds.has(toolCall.runId),
    )
    .map((toolCall) => ({
      id: toolCall.id,
      conversationId: toolCall.conversationId,
      runId: toolCall.runId,
      messageId: toolCall.messageId,
      partId: toolCall.partId,
      toolName: toolCall.toolName,
      state: toolCall.state,
      permissionId: toolCall.permissionId,
    }))
    .sort((left, right) =>
      left.runId.localeCompare(right.runId)
      || left.messageId.localeCompare(right.messageId)
      || left.id.localeCompare(right.id),
    );
  const parentCheckpoint = input.parentCheckpoint
    ? {
        id: input.parentCheckpoint.id,
        conversationId: input.parentCheckpoint.conversationId,
        coverageThroughRunId: input.parentCheckpoint.coverageThroughRunId,
        lineageHash: input.parentCheckpoint.lineageHash,
        sourceStateHash: input.parentCheckpoint.sourceStateHash,
        safetyStateHash: input.parentCheckpoint.safetyStateHash,
        formatVersion: input.parentCheckpoint.formatVersion,
        compatibility: input.parentCheckpoint.compatibility,
        safetyStateVersion: input.parentCheckpoint.safetyStateVersion,
        summaryHash: sha256(input.parentCheckpoint.summary),
      }
    : null;
  const parentCoverageIndex = input.parentCheckpoint
    ? input.lineageRuns.findIndex(
        (run) => run.id === input.parentCheckpoint!.coverageThroughRunId,
      )
    : -1;
  let canonicalSource: CanonicalContextSummarySource = { version: "1", pairs: [] };
  let sourceSafe = analysis.safe && parentCoverageIndex < input.coverageIndex;
  if (sourceSafe) {
    try {
      canonicalSource = canonicalizeContextSummarySource({
        conversationId: input.snapshot.conversation.id,
        runs: input.lineageRuns.slice(parentCoverageIndex + 1, input.coverageIndex + 1),
        messages: input.snapshot.messages,
      });
    } catch {
      sourceSafe = false;
    }
  }
  const payload = {
    version: "1",
    conversationId: input.snapshot.conversation.id,
    sourceHeadRunId: input.snapshot.conversation.activeHeadRunId,
    coverageThroughRunId: input.lineageRuns[input.coverageIndex]?.id,
    coveredRuns: analysis.coveredRuns,
    toolCalls,
    safetyStateHash: input.safetyStateHash,
    parentCheckpoint,
    canonicalSource,
  };
  return {
    safe: sourceSafe,
    sourceStateHash: sha256(stableStringifyJson(payload)),
    safetyStateHash: input.safetyStateHash,
    sourceMessages: projectCanonicalContextSummarySource(canonicalSource),
  };
}

function analyzeContextCoverageBoundary(
  input: ContextCoverageBoundaryInput,
): ContextCoverageBoundaryAnalysis {
  if (input.coverageIndex < 0 || input.coverageIndex >= input.lineageRuns.length) {
    return { safe: false, coveredRuns: [] };
  }
  const conversationId = input.snapshot.conversation.id;
  const messagesById = new Map(input.snapshot.messages.map((message) => [message.id, message]));
  const toolCallsById = new Map<ToolCall["id"], ToolCall>();
  const toolCallsByRun = new Map<Run["id"], ToolCall[]>();
  for (const toolCall of input.snapshot.toolCalls) {
    if (toolCall.conversationId !== conversationId || toolCallsById.has(toolCall.id)) {
      continue;
    }
    toolCallsById.set(toolCall.id, toolCall);
    const calls = toolCallsByRun.get(toolCall.runId) ?? [];
    calls.push(toolCall);
    toolCallsByRun.set(toolCall.runId, calls);
  }
  const permissionsByRun = new Map<Run["id"], Permission[]>();
  for (const permission of input.snapshot.permissions) {
    if (permission.conversationId !== conversationId) continue;
    const permissions = permissionsByRun.get(permission.runId) ?? [];
    permissions.push(permission);
    permissionsByRun.set(permission.runId, permissions);
  }

  let safe = true;
  const coveredRuns: ContextCoverageBoundaryAnalysis["coveredRuns"] = [];
  for (const run of input.lineageRuns.slice(0, input.coverageIndex + 1)) {
    const userMessage = run.parentMessageId
      ? messagesById.get(run.parentMessageId)
      : undefined;
    const user = userMessage?.role === "user" ? userMessage : undefined;
    const message = run.assistantMessageId
      ? messagesById.get(run.assistantMessageId)
      : undefined;
    const assistant = message?.role === "assistant" ? message : undefined;
    const toolParts = (assistant?.parts ?? [])
      .filter((part): part is ToolPart => part.type === "tool")
      .map((part) => ({
        partId: part.id,
        conversationId: part.conversationId,
        messageId: part.messageId,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        status: part.state.status,
      }));
    coveredRuns.push({
      runId: run.id,
      status: run.status,
      userMessageId: user?.id,
      assistantMessageId: assistant?.id,
      assistantStatus: assistant?.status.type,
      toolParts,
    });

    if (
      !TERMINAL_RUN_STATUSES.has(run.status)
      || !run.parentMessageId
      || !run.assistantMessageId
    ) {
      safe = false;
      continue;
    }
    if (
      !user
      || user.conversationId !== conversationId
      || !run.input.messageIds.includes(user.id)
      || !assistant
      || assistant.conversationId !== conversationId
      || assistant.runId !== run.id
      || assistant.parentId !== user.id
      || !TERMINAL_ASSISTANT_STATUSES.has(assistant.status.type)
      || !terminalRunOutputMatchesAssistant(run, assistant)
      || !user.parts.every((part) =>
        part.conversationId === conversationId && part.messageId === user.id,
      )
      || !assistant.parts.every((part) =>
        part.conversationId === conversationId && part.messageId === assistant.id,
      )
    ) {
      safe = false;
      continue;
    }

    const matchedToolCallIds = new Set<ToolCall["id"]>();
    for (const part of assistant.parts.filter(
      (candidate): candidate is ToolPart => candidate.type === "tool",
    )) {
      if (
        part.conversationId !== conversationId
        || part.messageId !== assistant.id
        || (run.output !== undefined && !run.output.partIds.includes(part.id))
        || !TERMINAL_TOOL_STATUSES.has(part.state.status)
      ) {
        safe = false;
        continue;
      }
      const toolCall = toolCallsById.get(part.toolCallId);
      if (!toolCall) {
        if (!isProviderValidationErrorWithoutToolCall(part)) safe = false;
        continue;
      }
      if (
        toolCall.conversationId !== conversationId
        || toolCall.runId !== run.id
        || toolCall.messageId !== assistant.id
        || toolCall.partId !== part.id
        || toolCall.toolName !== part.toolName
        || toolCall.state !== part.state.status
      ) {
        safe = false;
        continue;
      }
      matchedToolCallIds.add(toolCall.id);
    }

    for (const toolCall of toolCallsByRun.get(run.id) ?? []) {
      if (
        !matchedToolCallIds.has(toolCall.id)
        || !TERMINAL_TOOL_STATUSES.has(toolCall.state)
      ) {
        safe = false;
      }
    }
    for (const permission of permissionsByRun.get(run.id) ?? []) {
      const toolCall = toolCallsById.get(permission.toolCallId);
      if (
        permission.status === "pending"
        || !toolCall
        || toolCall.runId !== run.id
        || permission.messageId !== toolCall.messageId
        || permission.toolId !== toolCall.toolName
        || toolCall.permissionId !== permission.id
      ) {
        safe = false;
      }
    }
  }
  return { safe, coveredRuns };
}

function isProviderValidationErrorWithoutToolCall(part: ToolPart): boolean {
  return part.state.status === "error" && part.state.error.code === "VALIDATION_ERROR";
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function terminalRunOutputMatchesAssistant(
  run: Run,
  assistant: AssistantMessage,
): boolean {
  if (run.status === "failed" && run.output === undefined) return true;
  return run.output?.messageId === assistant.id
    && sameIds(run.output.partIds, assistant.parts.map((part) => part.id));
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
