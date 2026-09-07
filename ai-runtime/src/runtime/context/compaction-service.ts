import type {
  FinishReason,
  Instructions,
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  SystemModelMessage,
} from "ai";

import { createRuntimeId, type RuntimeId, type RuntimeIdPrefix } from "../core/ids";
import type { ConversationId, MessageId, Run, RunId } from "../core/types";
import type { RuntimeRunnerStore } from "../runners/runner-types";
import {
  computeContextCoverageHash,
  computeContextLineageHash,
  computeContextPlanRequestHash,
  ContextPlanningError,
  contextCoverageRunId,
  planContextWindow,
  resolveContextCoverageCursor,
} from "./planner";
import {
  CONTEXT_CHECKPOINT_COMPATIBILITY_VERSION,
  CONTEXT_CHECKPOINT_FORMAT_VERSION,
  PROVIDER_NEUTRAL_CONTEXT_KIND,
  RUNTIME_SAFETY_STATE_VERSION,
} from "./policy";
import {
  buildContextSummaryMemoryMessage,
  buildContextSummaryRequestMessage,
  buildContextSummarySafetyMessage,
  CONTEXT_SUMMARY_REQUEST_PROMPT,
  CONTEXT_SUMMARY_SYSTEM_PROMPT,
  sanitizeContextSummaryText,
} from "./summary-prompt";
import { CONTEXT_ESTIMATOR_OVERHEAD, estimateTextTokens } from "./token-estimator";
import type {
  ContextCheckpoint,
  ContextCompactionActivity,
  ContextCompactionPolicy,
  ContextCompactionTrigger,
  ContextCoverageCursor,
  ContextPlan,
  ContextPreparationClaim,
  ContextPlannerSnapshot,
  ContextUsage,
  ContextUsageBreakdown,
} from "./types";
import {
  CONTEXT_PREPARATION_CLAIM_TTL_MS,
  ContextPreparationLeaseLostError,
} from "./types";
import { computeContextCoverageSourceState } from "./boundary-validation";

export interface ContextSummaryGenerator {
  (input: {
    model: LanguageModel;
    instructions: Instructions;
    messages: ModelMessage[];
    maxOutputTokens: number;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<{
    text: string;
    finishReason?: FinishReason;
    usage?: LanguageModelUsage;
  }>;
}

export interface ContextCompactionRequest {
  conversationId: ConversationId;
  expectedHeadRunId: RunId;
  expectedConversationRevision: number;
  runId: RunId;
  requestIndex: number;
  /** Visible Assistant step boundary; durable plan identity remains requestIndex. */
  activityBoundaryStepIndex?: number;
  attemptIndex?: number;
  preparationClaim: ContextPreparationClaim;
  providerId: string;
  modelId: string;
  model: LanguageModel;
  contextWindow?: number;
  modelOutputLimit?: number;
  reservedOutputTokens: number;
  systemPrompt: string;
  toolSchemas: unknown;
  trigger: ContextCompactionTrigger;
  candidateCoverageThroughRunId?: RunId;
  candidateCoverageCursor?: ContextCoverageCursor;
  policy: ContextCompactionPolicy;
  safetyStateMaxTokens?: number;
  excludeAssistantMessageId?: MessageId;
  retainedModelInput?: import("./types").ContextPlannerInput["retainedModelInput"];
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

export type ContextCompactionResult =
  | {
      status: "created";
      checkpoint: ContextCheckpoint;
      activityId: ContextCompactionActivity["id"];
    }
  | { status: "stale" }
  | { status: "not_needed" };

export interface ContextCompactionServiceDependencies {
  store: RuntimeRunnerStore;
  generator: ContextSummaryGenerator;
  now?: () => number;
  createId?: <TPrefix extends RuntimeIdPrefix>(prefix: TPrefix) => RuntimeId<TPrefix>;
}

export interface ContextSummaryValidationDiagnostics {
  finishReason?: FinishReason;
  inputTokens?: number;
  outputTokens?: number;
  textTokens?: number;
  reasoningTokens?: number;
  summaryInvocationCount?: number;
  summaryReservedOutputTokens?: number;
}

export class ContextSummaryValidationError extends Error {
  constructor(
    message: string,
    readonly diagnostics: Readonly<ContextSummaryValidationDiagnostics> = {},
  ) {
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
      modelOutputLimit: input.modelOutputLimit,
      reservedOutputTokens: input.reservedOutputTokens,
      systemPrompt: input.systemPrompt,
      toolSchemas: input.toolSchemas,
      trigger: input.trigger,
      policy: input.policy,
      planId: this.createId("ctxplan"),
      createdAt: this.now(),
      safetyStateMaxTokens: input.safetyStateMaxTokens,
      excludeAssistantMessageId: input.excludeAssistantMessageId,
      retainedModelInput: input.retainedModelInput,
    });
    if (plan.reason === "raw_compaction_blocked") {
      const activity = this.startContextCompactionActivity(input, plan);
      const error = new ContextPlanningError(
        isContextPlanAboveHardInputBudget(plan)
          ? "CONTEXT_HARD_BUDGET_EXCEEDED_WITHOUT_SAFE_BOUNDARY"
          : "CONTEXT_SOFT_TRIGGER_REACHED_WITHOUT_SAFE_BOUNDARY",
      );
      this.finishContextCompactionActivity(activity, input, "failed");
      throw error;
    }
    if (
      input.trigger === "provider_overflow"
      && plan.reason !== "compaction_required"
    ) {
      throw new Error("Provider context overflow has no safe compaction boundary");
    }
    if (
      plan.reason !== "compaction_required"
      || (!plan.eligibleCoverageCursor && !plan.eligibleCoverageThroughRunId)
    ) {
      return { status: "not_needed" };
    }
    const coverageCursor = plan.eligibleCoverageCursor ?? {
      kind: "run" as const,
      throughRunId: plan.eligibleCoverageThroughRunId!,
    };
    if (
      input.candidateCoverageThroughRunId !== undefined
      && input.candidateCoverageThroughRunId !== contextCoverageRunId(coverageCursor)
    ) {
      throw new Error("Context compaction candidate boundary is stale or unsafe");
    }
    if (
      input.candidateCoverageCursor !== undefined
      && stableCursor(input.candidateCoverageCursor) !== stableCursor(coverageCursor)
    ) {
      throw new Error("Context compaction candidate boundary is stale or unsafe");
    }
    const lineage = resolveSnapshotLineage(snapshot, input.expectedHeadRunId);
    const coverageThroughRunId = contextCoverageRunId(coverageCursor);
    const coverageIndex = lineage.findIndex((run) => run.id === coverageThroughRunId);
    if (
      coverageIndex < 0
      || (coverageCursor.kind === "run" && coverageIndex >= lineage.length - 1)
      || (coverageCursor.kind === "sealed_step" && coverageIndex !== lineage.length - 1)
    ) {
      throw new Error("Context compaction boundary is not a safe Run or sealed-step prefix");
    }
    const parentCheckpoint = selectParentCheckpoint(
      snapshot,
      lineage,
      coverageCursor,
    );
    const sourceState = computeContextCoverageSourceState({
      snapshot,
      lineageRuns: lineage,
      coverageIndex,
      coverageCursor,
      safetyStateHash: plan.safetyState.hash,
      parentCheckpoint,
    });
    if (!sourceState.safe) {
      throw new Error("Context compaction boundary became unsafe before generation");
    }
    const summaryMaxOutputTokens = capSummaryOutputTokens(
      input.policy.summaryMaxOutputTokens,
      input.modelOutputLimit,
    );
    const summaryRetryMaxOutputTokens = capSummaryOutputTokens(
      input.policy.summaryRetryMaxOutputTokens,
      input.modelOutputLimit,
    );
    const activity = this.startContextCompactionActivity(input, plan, coverageCursor);
    try {
      const generatedSummary = await generateRollingSummary({
      generator: this.generator,
      model: input.model,
      contextWindow: input.contextWindow!,
      safetyMarginTokens: input.policy.safetyMarginTokens,
      summaryMaxOutputTokens,
      summaryRetryMaxOutputTokens,
      summaryMaxChars: input.policy.summaryMaxChars,
      sourceMessages: sourceState.sourceMessages,
      safetyInstruction: buildContextSummarySafetyMessage(plan.safetyState),
      parentSummary: parentCheckpoint?.summary,
      abortSignal: input.abortSignal,
      timeoutMs: input.timeoutMs,
      renewPreparationClaim: () => this.renewPreparationClaim(input.preparationClaim),
    });
      const checkpointCreatedAt = this.now();
      const checkpointUsage = {
      id: this.createId("ctxuse"),
      conversationId: input.conversationId,
      runId: input.runId,
      requestIndex: input.requestIndex,
      purpose: "checkpoint_summary",
      summaryInvocationCount: generatedSummary.usage.invocationCount,
      providerId: input.providerId,
      modelId: input.modelId,
      contextWindow: input.contextWindow,
      estimatedInputTokens: sumUsageBreakdown(generatedSummary.usage.breakdown),
      estimateSource: "estimate",
      reservedOutputTokens: generatedSummary.usage.reservedOutputTokens,
      view: parentCheckpoint ? "checkpoint" : "raw",
      ...(parentCheckpoint ? { checkpointId: parentCheckpoint.id } : {}),
      breakdown: generatedSummary.usage.breakdown,
      ...(generatedSummary.usage.providerObservation
        ? { providerObservation: generatedSummary.usage.providerObservation }
        : {}),
      estimatorVersion: input.policy.estimatorVersion,
      policyVersion: input.policy.version,
      checkpointFormatVersion: input.policy.checkpointFormatVersion,
      time: { created: checkpointCreatedAt },
    } satisfies ContextUsage;
      const checkpoint: ContextCheckpoint = {
      id: this.createId("ckpt"),
      conversationId: input.conversationId,
      coverageThroughRunId,
      coverageCursor,
      sourceHeadRunId: input.expectedHeadRunId,
      sourceConversationRevision: input.expectedConversationRevision,
      lineageHash: computeContextCoverageHash(
        lineage,
        snapshot.messages,
        coverageCursor,
      ),
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
      summary: generatedSummary.summary,
      safetyStateVersion: plan.safetyState.version,
      budget: plan.budget,
      usage: checkpointUsage,
      time: { created: checkpointCreatedAt },
    };
      input.abortSignal?.throwIfAborted();
      this.renewPreparationClaim(input.preparationClaim);
      const committed = this.store.commitContextCheckpoint({
        checkpoint,
        eventId: this.createId("evt"),
        preparationClaim: input.preparationClaim,
        activityCompletion: {
          activityId: activity.id,
          status: "created",
          checkpointId: checkpoint.id,
          coverageCursor,
          completedAt: checkpointCreatedAt,
          eventId: this.createId("evt"),
        },
      });
      if (committed === "committed") {
        return { status: "created", checkpoint, activityId: activity.id };
      }
      this.finishContextCompactionActivity(activity, input, "interrupted");
      return { status: "stale" };
    } catch (error) {
      this.finishContextCompactionActivity(
        activity,
        input,
        isContextCompactionInterruption(error, input.abortSignal)
          ? "interrupted"
          : "failed",
      );
      throw error;
    }
  }

  private startContextCompactionActivity(
    input: ContextCompactionRequest,
    plan: ContextPlan,
    coverageCursor?: ContextCoverageCursor,
  ): ContextCompactionActivity {
    return this.store.startContextCompactionActivity({
      activity: {
        id: this.createId("cmp"),
        conversationId: input.conversationId,
        runId: input.runId,
        requestIndex: input.requestIndex,
        ...(input.activityBoundaryStepIndex === undefined
          ? {}
          : { boundaryStepIndex: input.activityBoundaryStepIndex }),
        attemptIndex: input.attemptIndex ?? 0,
        trigger: input.trigger,
        status: "preparing",
        sourceHeadRunId: plan.sourceHeadRunId,
        sourceConversationRevision: plan.sourceConversationRevision,
        ...(coverageCursor ? { coverageCursor } : {}),
        beforeEstimatedInputTokens: plan.budget.estimatedInputTokens,
        startedAt: this.now(),
      } satisfies ContextCompactionActivity & { status: "preparing" },
      eventId: this.createId("evt"),
    });
  }

  private finishContextCompactionActivity(
    activity: ContextCompactionActivity,
    input: ContextCompactionRequest,
    status: "failed" | "interrupted",
  ): void {
    try {
      const current = this.store.listContextCompactionActivitiesByRun(input.runId).find((item) => item.id === activity.id);
      if (current && current.status !== "preparing") return;
      this.store.finishContextCompactionActivity({
        activityId: activity.id,
        status,
        completedAt: this.now(),
        eventId: this.createId("evt"),
      });
    } catch (activityError) {
      console.error(
        `Failed to persist Context compaction ${status} Activity for ` +
        `${input.runId}/${input.requestIndex}`,
        activityError,
      );
    }
  }

  private renewPreparationClaim(preparationClaim: ContextPreparationClaim): void {
    if (
      !this.store.renewContextPreparationClaim(
        preparationClaim,
        CONTEXT_PREPARATION_CLAIM_TTL_MS,
      )
    ) {
      throw new ContextPreparationLeaseLostError(
        preparationClaim.runId,
        preparationClaim.requestIndex,
      );
    }
  }
}

function isContextPlanAboveHardInputBudget(plan: ContextPlan): boolean {
  const hardInputBudget = plan.budget.hardInputBudget;
  if (hardInputBudget === undefined) return false;
  const contentTokens = plan.budget.rawHistoryTokens
    + plan.budget.checkpointTokens
    + plan.budget.safetyStateTokens;
  return contentTokens > hardInputBudget;
}

function isContextCompactionInterruption(
  error: unknown,
  abortSignal: AbortSignal | undefined,
): boolean {
  if (abortSignal?.aborted || error instanceof ContextPreparationLeaseLostError) return true;
  return error instanceof Error && error.name === "AbortError";
}

interface RollingSummaryInput {
  generator: ContextSummaryGenerator;
  model: LanguageModel;
  contextWindow: number;
  safetyMarginTokens: number;
  summaryMaxOutputTokens: number;
  summaryRetryMaxOutputTokens: number;
  summaryMaxChars: number;
  sourceMessages: ModelMessage[];
  safetyInstruction: SystemModelMessage;
  parentSummary?: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  renewPreparationClaim: () => void;
}

interface RollingSummaryUsage {
  invocationCount: number;
  reservedOutputTokens: number;
  breakdown: ContextUsageBreakdown;
  providerObservation?: NonNullable<ContextUsage["providerObservation"]>;
}

async function generateRollingSummary(input: RollingSummaryInput): Promise<{
  summary: string;
  usage: RollingSummaryUsage;
}> {
  let rollingSummary = input.parentSummary;
  const remaining = input.sourceMessages.map((message) => ({
    role: message.role,
    content: requireStringContent(message),
  }));
  let generatedAtLeastOnce = false;
  let invocationCount = 0;
  let reservedOutputTokens = 0;
  const breakdown: ContextUsageBreakdown = {
    rawTokens: 0,
    checkpointTokens: 0,
    safetyStateTokens: 0,
    systemPromptTokens: 0,
    toolSchemaTokens: 0,
  };
  let observedInvocationCount = 0;
  const providerTotals: Omit<
    NonNullable<ContextUsage["providerObservation"]>,
    "source" | "observedInvocationCount"
  > = {};

  while (remaining.length > 0 || !generatedAtLeastOnce) {
    const fixedInstructions: SystemModelMessage[] = [
      ...(rollingSummary === undefined
        ? []
        : [buildContextSummaryMemoryMessage(rollingSummary)]),
      input.safetyInstruction,
    ];
    let chunk = selectSummaryChunk({
      remaining,
      fixedInstructions,
      contextWindow: input.contextWindow,
      safetyMarginTokens: input.safetyMarginTokens,
      maxOutputTokens: input.summaryMaxOutputTokens,
    });
    let generated = await invokeSummaryGenerator({
      ...input,
      fixedInstructions,
      messages: chunk.messages,
      maxOutputTokens: input.summaryMaxOutputTokens,
    });
    recordSummaryInvocation({
      generated,
      fixedInstructions,
      messages: chunk.messages,
      maxOutputTokens: input.summaryMaxOutputTokens,
      breakdown,
      providerTotals,
      onObserved: () => { observedInvocationCount += 1; },
    });
    invocationCount += 1;
    reservedOutputTokens += input.summaryMaxOutputTokens;

    if (
      isReasoningOnlyLengthExhaustion(generated)
      && input.summaryRetryMaxOutputTokens > input.summaryMaxOutputTokens
    ) {
      chunk = selectSummaryChunk({
        remaining,
        fixedInstructions,
        contextWindow: input.contextWindow,
        safetyMarginTokens: input.safetyMarginTokens,
        maxOutputTokens: input.summaryRetryMaxOutputTokens,
      });
      generated = await invokeSummaryGenerator({
        ...input,
        fixedInstructions,
        messages: chunk.messages,
        maxOutputTokens: input.summaryRetryMaxOutputTokens,
      });
      recordSummaryInvocation({
        generated,
        fixedInstructions,
        messages: chunk.messages,
        maxOutputTokens: input.summaryRetryMaxOutputTokens,
        breakdown,
        providerTotals,
        onObserved: () => { observedInvocationCount += 1; },
      });
      invocationCount += 1;
      reservedOutputTokens += input.summaryRetryMaxOutputTokens;
    }

    try {
      rollingSummary = validateSummary(generated, input.summaryMaxChars);
    } catch (error) {
      if (!(error instanceof ContextSummaryValidationError)) throw error;
      throw new ContextSummaryValidationError(error.message, {
        ...error.diagnostics,
        summaryInvocationCount: invocationCount,
        summaryReservedOutputTokens: reservedOutputTokens,
      });
    }
    remaining.splice(0, remaining.length, ...chunk.remaining);
    generatedAtLeastOnce = true;
  }
  return {
    summary: rollingSummary!,
    usage: {
      invocationCount,
      reservedOutputTokens,
      breakdown,
      ...(observedInvocationCount > 0
        ? {
            providerObservation: {
              source: "provider" as const,
              observedInvocationCount,
              ...providerTotals,
            },
          }
        : {}),
    },
  };
}

function capSummaryOutputTokens(configured: number, modelLimit: number | undefined): number {
  if (modelLimit === undefined) return configured;
  if (!Number.isSafeInteger(modelLimit) || modelLimit <= 0) {
    throw new Error("Context summary model output limit must be a positive safe integer");
  }
  return Math.min(configured, modelLimit);
}

function selectSummaryChunk(input: {
  remaining: readonly { role: ModelMessage["role"]; content: string }[];
  fixedInstructions: readonly SystemModelMessage[];
  contextWindow: number;
  safetyMarginTokens: number;
  maxOutputTokens: number;
}): {
  messages: ModelMessage[];
  remaining: { role: ModelMessage["role"]; content: string }[];
} {
  const availableInputTokens = Math.floor(
    input.contextWindow - input.maxOutputTokens - input.safetyMarginTokens,
  );
  const fixedTokens = estimateSummaryInvocationTokens(input.fixedInstructions);
  if (fixedTokens > availableInputTokens) {
    throw new ContextSummaryInputBudgetError(fixedTokens, availableInputTokens);
  }
  const remaining = input.remaining.map((message) => ({ ...message }));
  const messages: ModelMessage[] = [];
  let usedTokens = fixedTokens;
  while (remaining.length > 0) {
    const next = remaining[0]!;
    const wholeTokens = estimateSummaryMessageTokens(next.content);
    if (usedTokens + wholeTokens <= availableInputTokens) {
      messages.push(next as ModelMessage);
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
    messages.push({ role: next.role, content: prefix } as ModelMessage);
    usedTokens += estimateSummaryMessageTokens(prefix);
    if (suffix.length === 0) remaining.shift();
    else next.content = suffix;
    break;
  }
  if (remaining.length > 0 && messages.length === 0) {
    throw new ContextSummaryInputBudgetError(
      fixedTokens + CONTEXT_ESTIMATOR_OVERHEAD.message + CONTEXT_ESTIMATOR_OVERHEAD.part + 1,
      availableInputTokens,
    );
  }
  return { messages, remaining };
}

async function invokeSummaryGenerator(input: RollingSummaryInput & {
  fixedInstructions: readonly SystemModelMessage[];
  messages: ModelMessage[];
  maxOutputTokens: number;
}): Promise<Awaited<ReturnType<ContextSummaryGenerator>>> {
  input.renewPreparationClaim();
  assertNoSystemSummaryMessages(input.messages);
  try {
    const generated = await input.generator({
      model: input.model,
      instructions: [
        { role: "system", content: CONTEXT_SUMMARY_SYSTEM_PROMPT },
        ...input.fixedInstructions,
      ],
      messages: [
        ...input.messages,
        buildContextSummaryRequestMessage(),
      ],
      maxOutputTokens: input.maxOutputTokens,
      abortSignal: input.abortSignal,
      timeoutMs: input.timeoutMs,
    });
    input.renewPreparationClaim();
    return generated;
  } catch (error) {
    try {
      input.renewPreparationClaim();
    } catch {
      // The generator's exact abort/timeout/Provider failure remains authoritative.
    }
    throw error;
  }
}

function recordSummaryInvocation(input: {
  generated: Awaited<ReturnType<ContextSummaryGenerator>>;
  fixedInstructions: readonly SystemModelMessage[];
  messages: readonly ModelMessage[];
  maxOutputTokens: number;
  breakdown: ContextUsageBreakdown;
  providerTotals: Omit<
    NonNullable<ContextUsage["providerObservation"]>,
    "source" | "observedInvocationCount"
  >;
  onObserved: () => void;
}): void {
  input.breakdown.systemPromptTokens += estimateSummaryMessageTokens(CONTEXT_SUMMARY_SYSTEM_PROMPT);
  input.breakdown.systemPromptTokens += estimateSummaryMessageTokens(
    CONTEXT_SUMMARY_REQUEST_PROMPT,
  );
  input.breakdown.checkpointTokens += input.fixedInstructions.length > 1
    ? estimateSummaryMessageTokens(requireStringContent(input.fixedInstructions[0]!))
    : 0;
  input.breakdown.safetyStateTokens += estimateSummaryMessageTokens(
    requireStringContent(input.fixedInstructions[input.fixedInstructions.length - 1]!),
  );
  input.breakdown.rawTokens += input.messages.reduce(
    (total, message) => total + estimateSummaryMessageTokens(requireStringContent(message)),
    0,
  );
  const usage = input.generated.usage;
  if (!usage) return;
  const observedScalars = [
    accumulateProviderUsageScalar(input.providerTotals, "inputTokens", usage.inputTokens),
    accumulateProviderUsageScalar(input.providerTotals, "outputTokens", usage.outputTokens),
    accumulateProviderUsageScalar(
      input.providerTotals,
      "reasoningTokens",
      usage.outputTokenDetails?.reasoningTokens,
    ),
    accumulateProviderUsageScalar(
      input.providerTotals,
      "cacheReadTokens",
      usage.inputTokenDetails?.cacheReadTokens,
    ),
    accumulateProviderUsageScalar(
      input.providerTotals,
      "cacheWriteTokens",
      usage.inputTokenDetails?.cacheWriteTokens,
    ),
    accumulateProviderUsageScalar(input.providerTotals, "totalTokens", usage.totalTokens),
  ];
  if (observedScalars.some(Boolean)) input.onObserved();
}

function isReasoningOnlyLengthExhaustion(
  generated: Awaited<ReturnType<ContextSummaryGenerator>>,
): boolean {
  return typeof generated?.text === "string"
    && generated.text.trim().length === 0
    && generated.finishReason === "length"
    && (generated.usage?.outputTokenDetails?.reasoningTokens ?? 0) > 0
    && generated.usage?.outputTokenDetails?.textTokens === 0;
}

function assertNoSystemSummaryMessages(messages: readonly ModelMessage[]): void {
  if (messages.some((message) => message.role === "system")) {
    throw new Error(
      "Context summary messages must not contain system instructions",
    );
  }
}

function accumulateProviderUsageScalar<
  Key extends keyof Omit<
    NonNullable<ContextUsage["providerObservation"]>,
    "source" | "observedInvocationCount"
  >,
>(
  totals: Omit<
    NonNullable<ContextUsage["providerObservation"]>,
    "source" | "observedInvocationCount"
  >,
  key: Key,
  value: number | undefined,
): boolean {
  if (typeof value !== "number") return false;
  totals[key] = (totals[key] ?? 0) + value;
  return true;
}

function sumUsageBreakdown(breakdown: ContextUsageBreakdown): number {
  return breakdown.rawTokens
    + breakdown.checkpointTokens
    + breakdown.safetyStateTokens
    + breakdown.systemPromptTokens
    + breakdown.toolSchemaTokens;
}

function estimateSummaryInvocationTokens(messages: readonly SystemModelMessage[]): number {
  return estimateSummaryMessageTokens(CONTEXT_SUMMARY_SYSTEM_PROMPT)
    + estimateSummaryMessageTokens(CONTEXT_SUMMARY_REQUEST_PROMPT)
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
  coverageCursor: ContextCoverageCursor,
): ContextCheckpoint | undefined {
  const targetPosition = cursorPosition(coverageCursor, lineage);
  return snapshot.checkpoints
    .map((checkpoint) => {
      const cursor = resolveContextCoverageCursor(checkpoint);
      return {
        checkpoint,
        cursor,
        position: cursorPosition(cursor, lineage),
      };
    })
    .filter(({ checkpoint, cursor, position }) =>
      checkpoint.conversationId === snapshot.conversation.id
      && checkpoint.formatVersion === CONTEXT_CHECKPOINT_FORMAT_VERSION
      && checkpoint.compatibility.kind === PROVIDER_NEUTRAL_CONTEXT_KIND
      && checkpoint.compatibility.version === CONTEXT_CHECKPOINT_COMPATIBILITY_VERSION
      && checkpoint.safetyStateVersion === RUNTIME_SAFETY_STATE_VERSION
      && position !== undefined
      && targetPosition !== undefined
      && compareCursorPositions(position, targetPosition) < 0
      && checkpoint.lineageHash
        === (cursor.kind === "run"
          ? computeContextLineageHash(lineage, cursor.throughRunId)
          : computeContextCoverageHash(lineage, snapshot.messages, cursor)),
    )
    .sort((left, right) =>
      compareCursorPositions(right.position!, left.position!)
      || right.checkpoint.time.created - left.checkpoint.time.created
      || left.checkpoint.id.localeCompare(right.checkpoint.id),
    )[0]?.checkpoint;
}

function cursorPosition(
  cursor: ContextCoverageCursor,
  lineage: readonly Run[],
): readonly [number, number] | undefined {
  const runIndex = lineage.findIndex((run) => run.id === contextCoverageRunId(cursor));
  if (runIndex < 0) return undefined;
  return [runIndex, cursor.kind === "run" ? Number.MAX_SAFE_INTEGER : cursor.throughRequestIndex];
}

function compareCursorPositions(
  left: readonly [number, number],
  right: readonly [number, number],
): number {
  return left[0] - right[0] || left[1] - right[1];
}

function stableCursor(cursor: ContextCoverageCursor): string {
  return JSON.stringify(cursor);
}

function validateSummary(
  generated: Awaited<ReturnType<ContextSummaryGenerator>>,
  maxBytes: number,
): string {
  const diagnostics = readSummaryValidationDiagnostics(generated);
  if (!generated || typeof generated.text !== "string") {
    throw new ContextSummaryValidationError(
      "Context summary generator returned an invalid result",
      diagnostics,
    );
  }
  const rawSummary = generated.text.trim();
  if (rawSummary.length === 0) {
    throw new ContextSummaryValidationError(
      "Context summary generator returned blank output",
      diagnostics,
    );
  }
  if (!hasValidUtf16(rawSummary)) {
    throw new ContextSummaryValidationError(
      "Context summary generator returned invalid Unicode",
      diagnostics,
    );
  }
  const summary = sanitizeContextSummaryText(rawSummary).trim();
  if (summary.length === 0 || !hasMeaningfulSummaryContent(summary)) {
    throw new ContextSummaryValidationError(
      "Context summary generator returned blank output",
      diagnostics,
    );
  }
  if (Buffer.byteLength(summary, "utf8") > maxBytes) {
    throw new ContextSummaryValidationError(
      "Context summary generator output exceeds the configured limit",
      diagnostics,
    );
  }
  return summary;
}

function readSummaryValidationDiagnostics(
  generated: Awaited<ReturnType<ContextSummaryGenerator>>,
): ContextSummaryValidationDiagnostics {
  if (!generated || typeof generated !== "object") return {};
  const usage = generated.usage;
  return {
    ...(generated.finishReason === undefined
      ? {}
      : { finishReason: generated.finishReason }),
    ...(isSafeTokenCount(usage?.inputTokens)
      ? { inputTokens: usage.inputTokens }
      : {}),
    ...(isSafeTokenCount(usage?.outputTokens)
      ? { outputTokens: usage.outputTokens }
      : {}),
    ...(isSafeTokenCount(usage?.outputTokenDetails?.textTokens)
      ? { textTokens: usage.outputTokenDetails.textTokens }
      : {}),
    ...(isSafeTokenCount(usage?.outputTokenDetails?.reasoningTokens)
      ? { reasoningTokens: usage.outputTokenDetails.reasoningTokens }
      : {}),
  };
}

function isSafeTokenCount(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
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
