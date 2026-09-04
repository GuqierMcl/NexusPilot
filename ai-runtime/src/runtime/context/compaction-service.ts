import type { LanguageModel, LanguageModelUsage, ModelMessage } from "ai";

import { createRuntimeId, type RuntimeId, type RuntimeIdPrefix } from "../core/ids";
import type { ConversationId, Run, RunId } from "../core/types";
import type { RuntimeRunnerStore } from "../runners/runner-types";
import {
  computeContextLineageHash,
  computeContextPlanRequestHash,
  planContextWindow,
} from "./planner";
import {
  CONTEXT_CHECKPOINT_COMPATIBILITY_VERSION,
  CONTEXT_CHECKPOINT_FORMAT_VERSION,
  PROVIDER_NEUTRAL_CONTEXT_KIND,
  RUNTIME_SAFETY_STATE_VERSION,
} from "./policy";
import {
  buildContextSummaryMemoryMessage,
  buildContextSummarySafetyMessage,
  CONTEXT_SUMMARY_SYSTEM_PROMPT,
  sanitizeContextSummaryText,
} from "./summary-prompt";
import { CONTEXT_ESTIMATOR_OVERHEAD, estimateTextTokens } from "./token-estimator";
import type {
  ContextCheckpoint,
  ContextCompactionPolicy,
  ContextCompactionTrigger,
  ContextPreparationClaim,
  ContextPlannerSnapshot,
} from "./types";
import { ContextPreparationLeaseLostError } from "./types";
import { computeContextCoverageSourceState } from "./boundary-validation";

export interface ContextSummaryGenerator {
  (input: {
    model: LanguageModel;
    system: string;
    messages: ModelMessage[];
    maxOutputTokens: 2048;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<{ text: string; usage?: LanguageModelUsage }>;
}

export interface ContextCompactionRequest {
  conversationId: ConversationId;
  expectedHeadRunId: RunId;
  expectedConversationRevision: number;
  runId: RunId;
  requestIndex: number;
  preparationClaim: ContextPreparationClaim;
  providerId: string;
  modelId: string;
  model: LanguageModel;
  contextWindow?: number;
  reservedOutputTokens: number;
  systemPrompt: string;
  toolSchemas: unknown;
  trigger: ContextCompactionTrigger;
  candidateCoverageThroughRunId?: RunId;
  policy: ContextCompactionPolicy;
  safetyStateMaxTokens?: number;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

export type ContextCompactionResult =
  | { status: "created"; checkpoint: ContextCheckpoint }
  | { status: "stale" }
  | { status: "not_needed" };

export interface ContextCompactionServiceDependencies {
  store: RuntimeRunnerStore;
  generator: ContextSummaryGenerator;
  now?: () => number;
  createId?: <TPrefix extends RuntimeIdPrefix>(prefix: TPrefix) => RuntimeId<TPrefix>;
}

export class ContextSummaryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextSummaryValidationError";
  }
}

export class ContextSummaryInputBudgetError extends Error {
  constructor(
    readonly requiredTokens: number,
    readonly availableTokens: number,
  ) {
    super(
      `Context summary fixed input exceeds the model budget: `
      + `${requiredTokens} required, ${availableTokens} available`,
    );
    this.name = "ContextSummaryInputBudgetError";
  }
}

export class ContextCompactionService {
  private readonly store: RuntimeRunnerStore;
  private readonly generator: ContextSummaryGenerator;
  private readonly now: () => number;
  private readonly createId: <TPrefix extends RuntimeIdPrefix>(prefix: TPrefix) => RuntimeId<TPrefix>;

  constructor(dependencies: ContextCompactionServiceDependencies) {
    this.store = dependencies.store;
    this.generator = dependencies.generator;
    this.now = dependencies.now ?? Date.now;
    this.createId = dependencies.createId ?? createRuntimeId;
  }

  async compact(input: ContextCompactionRequest): Promise<ContextCompactionResult> {
    if (
      input.preparationClaim.runId !== input.runId
      || input.preparationClaim.requestIndex !== input.requestIndex
      || input.preparationClaim.requestHash !== computeContextPlanRequestHash(input)
    ) {
      throw new ContextPreparationLeaseLostError(input.runId, input.requestIndex);
    }
    const snapshot = readContextPlannerSnapshot(this.store, input.conversationId);
    if (
      snapshot.conversation.activeHeadRunId !== input.expectedHeadRunId
      || snapshot.conversation.revision !== input.expectedConversationRevision
    ) {
      return { status: "stale" };
    }

    const plan = planContextWindow({
      snapshot,
      runId: input.runId,
      requestIndex: input.requestIndex,
      providerId: input.providerId,
      modelId: input.modelId,
      contextWindow: input.contextWindow,
      reservedOutputTokens: input.reservedOutputTokens,
      systemPrompt: input.systemPrompt,
      toolSchemas: input.toolSchemas,
      trigger: input.trigger,
      policy: input.policy,
      planId: this.createId("ctxplan"),
      createdAt: this.now(),
      safetyStateMaxTokens: input.safetyStateMaxTokens,
    });
    if (plan.reason !== "compaction_required" || !plan.eligibleCoverageThroughRunId) {
      return { status: "not_needed" };
    }
    if (
      input.candidateCoverageThroughRunId !== undefined
      && input.candidateCoverageThroughRunId !== plan.eligibleCoverageThroughRunId
    ) {
      throw new Error("Context compaction candidate boundary is stale or unsafe");
    }
    if (input.policy.summaryMaxOutputTokens !== 2_048) {
      throw new Error("Context summary max output tokens must be 2048 for format version 1");
    }

    const lineage = resolveSnapshotLineage(snapshot, input.expectedHeadRunId);
    const coverageThroughRunId = plan.eligibleCoverageThroughRunId;
    const coverageIndex = lineage.findIndex((run) => run.id === coverageThroughRunId);
    if (coverageIndex < 0 || coverageIndex >= lineage.length - 1) {
      throw new Error("Context compaction boundary is not a non-current ancestor");
    }
    const parentCheckpoint = selectParentCheckpoint(snapshot, lineage, coverageIndex);
    const sourceState = computeContextCoverageSourceState({
      snapshot,
      lineageRuns: lineage,
      coverageIndex,
      safetyStateHash: plan.safetyState.hash,
      parentCheckpoint,
    });
    if (!sourceState.safe) {
      throw new Error("Context compaction boundary became unsafe before generation");
    }
    const summary = await generateRollingSummary({
      generator: this.generator,
      model: input.model,
      contextWindow: input.contextWindow!,
      safetyMarginTokens: input.policy.safetyMarginTokens,
      summaryMaxChars: input.policy.summaryMaxChars,
      sourceMessages: sourceState.sourceMessages,
      safetyMessage: buildContextSummarySafetyMessage(plan.safetyState),
      parentSummary: parentCheckpoint?.summary,
      abortSignal: input.abortSignal,
      timeoutMs: input.timeoutMs,
    });
    const checkpoint: ContextCheckpoint = {
      id: this.createId("ckpt"),
      conversationId: input.conversationId,
      coverageThroughRunId,
      sourceHeadRunId: input.expectedHeadRunId,
      sourceConversationRevision: input.expectedConversationRevision,
      lineageHash: computeContextLineageHash(lineage, coverageThroughRunId),
      sourceStateHash: sourceState.sourceStateHash,
      safetyStateHash: sourceState.safetyStateHash,
      ...(parentCheckpoint ? { parentCheckpointId: parentCheckpoint.id } : {}),
      trigger: input.trigger,
      formatVersion: input.policy.checkpointFormatVersion,
      compatibility: {
        kind: PROVIDER_NEUTRAL_CONTEXT_KIND,
        version: input.policy.compatibilityVersion,
      },
      generatedBy: { providerId: input.providerId, modelId: input.modelId },
      summary,
      safetyStateVersion: plan.safetyState.version,
      budget: plan.budget,
      time: { created: this.now() },
    };
    const committed = this.store.commitContextCheckpoint({
      checkpoint,
      eventId: this.createId("evt"),
      preparationClaim: input.preparationClaim,
    });
    return committed === "committed"
      ? { status: "created", checkpoint }
      : { status: "stale" };
  }
}

interface RollingSummaryInput {
  generator: ContextSummaryGenerator;
  model: LanguageModel;
  contextWindow: number;
  safetyMarginTokens: number;
  summaryMaxChars: number;
  sourceMessages: ModelMessage[];
  safetyMessage: ModelMessage;
  parentSummary?: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

async function generateRollingSummary(input: RollingSummaryInput): Promise<string> {
  const availableInputTokens = Math.floor(
    input.contextWindow - 2_048 - input.safetyMarginTokens,
  );
  let rollingSummary = input.parentSummary;
  const remaining = input.sourceMessages.map((message) => ({
    role: message.role,
    content: requireStringContent(message),
  }));
  let generatedAtLeastOnce = false;

  while (remaining.length > 0 || !generatedAtLeastOnce) {
    const fixedMessages: ModelMessage[] = [
      ...(rollingSummary === undefined
        ? []
        : [buildContextSummaryMemoryMessage(rollingSummary)]),
      input.safetyMessage,
    ];
    const fixedTokens = estimateSummaryInvocationTokens(fixedMessages);
    if (fixedTokens > availableInputTokens) {
      throw new ContextSummaryInputBudgetError(fixedTokens, availableInputTokens);
    }

    const messages: ModelMessage[] = [...fixedMessages];
    let usedTokens = fixedTokens;
    while (remaining.length > 0) {
      const next = remaining[0]!;
      const wholeTokens = estimateSummaryMessageTokens(next.content);
      if (usedTokens + wholeTokens <= availableInputTokens) {
        messages.splice(messages.length - 1, 0, next as ModelMessage);
        usedTokens += wholeTokens;
        remaining.shift();
        continue;
      }
      const contentTokenCapacity = availableInputTokens
        - usedTokens
        - CONTEXT_ESTIMATOR_OVERHEAD.message
        - CONTEXT_ESTIMATOR_OVERHEAD.part;
      if (contentTokenCapacity <= 0) break;
      const [prefix, suffix] = splitTextByTokenCapacity(next.content, contentTokenCapacity);
      if (prefix.length === 0) break;
      messages.splice(messages.length - 1, 0, { role: next.role, content: prefix } as ModelMessage);
      usedTokens += estimateSummaryMessageTokens(prefix);
      if (suffix.length === 0) {
        remaining.shift();
      } else {
        next.content = suffix;
      }
      break;
    }
    if (remaining.length > 0 && messages.length === fixedMessages.length) {
      throw new ContextSummaryInputBudgetError(
        fixedTokens + CONTEXT_ESTIMATOR_OVERHEAD.message + CONTEXT_ESTIMATOR_OVERHEAD.part + 1,
        availableInputTokens,
      );
    }

    const generated = await input.generator({
      model: input.model,
      system: CONTEXT_SUMMARY_SYSTEM_PROMPT,
      messages,
      maxOutputTokens: 2_048,
      abortSignal: input.abortSignal,
      timeoutMs: input.timeoutMs,
    });
    rollingSummary = validateSummary(generated, input.summaryMaxChars);
    generatedAtLeastOnce = true;
  }
  return rollingSummary!;
}

function estimateSummaryInvocationTokens(messages: readonly ModelMessage[]): number {
  return estimateSummaryMessageTokens(CONTEXT_SUMMARY_SYSTEM_PROMPT)
    + messages.reduce(
      (total, message) => total + estimateSummaryMessageTokens(requireStringContent(message)),
      0,
    );
}

function estimateSummaryMessageTokens(content: string): number {
  return CONTEXT_ESTIMATOR_OVERHEAD.message
    + CONTEXT_ESTIMATOR_OVERHEAD.part
    + estimateTextTokens(content);
}

function requireStringContent(message: ModelMessage): string {
  if (typeof message.content !== "string") {
    throw new Error("Context summary source must contain string-only ModelMessages");
  }
  return message.content;
}

function splitTextByTokenCapacity(value: string, maxTokens: number): [string, string] {
  const maxBytes = maxTokens * 3;
  let bytes = 0;
  let codeUnits = 0;
  for (const character of value) {
    const nextBytes = Buffer.byteLength(character, "utf8");
    if (bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    codeUnits += character.length;
  }
  return [value.slice(0, codeUnits), value.slice(codeUnits)];
}

export function readContextPlannerSnapshot(
  store: RuntimeRunnerStore,
  conversationId: ConversationId,
): ContextPlannerSnapshot {
  const conversation = store.getConversation(conversationId);
  if (!conversation) {
    throw new Error(`Context Conversation was not found: ${conversationId}`);
  }
  const runs = store.listRunsByConversation(conversationId);
  return {
    conversation,
    runs,
    messages: store.listTranscriptMessages(conversationId),
    toolCalls: runs.flatMap((run) => store.listToolCallsByRun(run.id)),
    permissions: runs.flatMap((run) => store.listPermissionsByRun(run.id)),
    checkpoints: store.listContextCheckpoints(conversationId),
  };
}

function resolveSnapshotLineage(
  snapshot: ContextPlannerSnapshot,
  headRunId: RunId,
): Run[] {
  const byId = new Map(snapshot.runs.map((run) => [run.id, run]));
  const reversed: Run[] = [];
  const visited = new Set<RunId>();
  let current: RunId | undefined = headRunId;
  while (current) {
    if (visited.has(current)) throw new Error(`Context lineage contains a cycle at ${current}`);
    visited.add(current);
    const run = byId.get(current);
    if (!run || run.conversationId !== snapshot.conversation.id) {
      throw new Error(`Context lineage Run is missing or foreign: ${current}`);
    }
    reversed.push(run);
    current = run.parentRunId;
  }
  return reversed.reverse();
}

function selectParentCheckpoint(
  snapshot: ContextPlannerSnapshot,
  lineage: readonly Run[],
  coverageIndex: number,
): ContextCheckpoint | undefined {
  return snapshot.checkpoints
    .map((checkpoint) => ({
      checkpoint,
      coverageIndex: lineage.findIndex((run) => run.id === checkpoint.coverageThroughRunId),
    }))
    .filter(({ checkpoint, coverageIndex: parentIndex }) =>
      checkpoint.conversationId === snapshot.conversation.id
      && checkpoint.formatVersion === CONTEXT_CHECKPOINT_FORMAT_VERSION
      && checkpoint.compatibility.kind === PROVIDER_NEUTRAL_CONTEXT_KIND
      && checkpoint.compatibility.version === CONTEXT_CHECKPOINT_COMPATIBILITY_VERSION
      && checkpoint.safetyStateVersion === RUNTIME_SAFETY_STATE_VERSION
      && parentIndex >= 0
      && parentIndex < coverageIndex
      && checkpoint.lineageHash
        === computeContextLineageHash(lineage, checkpoint.coverageThroughRunId),
    )
    .sort((left, right) =>
      right.coverageIndex - left.coverageIndex
      || right.checkpoint.time.created - left.checkpoint.time.created
      || left.checkpoint.id.localeCompare(right.checkpoint.id),
    )[0]?.checkpoint;
}

function validateSummary(
  generated: { text: string; usage?: LanguageModelUsage },
  maxBytes: number,
): string {
  if (!generated || typeof generated.text !== "string") {
    throw new ContextSummaryValidationError("Context summary generator returned an invalid result");
  }
  const rawSummary = generated.text.trim();
  if (rawSummary.length === 0) {
    throw new ContextSummaryValidationError("Context summary generator returned blank output");
  }
  if (!hasValidUtf16(rawSummary)) {
    throw new ContextSummaryValidationError("Context summary generator returned invalid Unicode");
  }
  const summary = sanitizeContextSummaryText(rawSummary).trim();
  if (summary.length === 0 || !hasMeaningfulSummaryContent(summary)) {
    throw new ContextSummaryValidationError("Context summary generator returned blank output");
  }
  if (Buffer.byteLength(summary, "utf8") > maxBytes) {
    throw new ContextSummaryValidationError("Context summary generator output exceeds the configured limit");
  }
  return summary;
}

function hasMeaningfulSummaryContent(value: string): boolean {
  const withoutRedactionScaffolding = value
    .replace(/\[REDACTED\]/gi, "")
    .replace(/\b(?:authorization|bearer|password|secret|token|api[-_]?key)\b/gi, "");
  return /[\p{L}\p{N}]/u.test(withoutRedactionScaffolding);
}

function hasValidUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
