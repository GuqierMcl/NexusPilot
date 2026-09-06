import { createHash, randomUUID } from "node:crypto";
import type { LanguageModel, ModelMessage, SystemModelMessage } from "ai";

import type { RuntimeAttachmentService } from "../attachments";
import { createRuntimeId, type RuntimeId, type RuntimeIdPrefix } from "../core/ids";
import type {
  ConversationId,
  Message,
  MessageId,
  Run,
  RunId,
  TraceEvent,
} from "../core/types";
import {
  projectContextBoundaries,
  projectModelHistory,
} from "../projection/model-history-projection";
import type { RuntimeRunnerStore } from "../runners/runner-types";
import {
  ContextCompactionService,
  ContextSummaryValidationError,
  readContextPlannerSnapshot,
} from "./compaction-service";
import {
  computeContextPlanRequestHash,
  planContextWindow,
  resolveContextCoverageCursor,
} from "./planner";
import {
  CONTEXT_PREPARATION_CLAIM_TTL_MS,
  ContextPreparationLeaseLostError,
} from "./types";
import type {
  ContextCheckpoint,
  ContextCompactionActivity,
  ContextCompactionPolicy,
  ContextCompactionTrigger,
  ContextCoverageCursor,
  ContextPlan,
  ContextPlannerInput,
  ContextPreparationClaim,
  ContextPlannerSnapshot,
  ContextForecastReason,
  NextTurnContextForecast,
} from "./types";
import {
  CONTEXT_ESTIMATOR_OVERHEAD,
  estimateJsonTokens,
  stableStringifyJson,
} from "./token-estimator";

export interface ModelContextPreparationInput {
  conversationId: ConversationId;
  runId: RunId;
  requestIndex: number;
  /** Visible Assistant step boundary used only to place compaction Activity. */
  activityBoundaryStepIndex?: number;
  providerId: string;
  modelId: string;
  model: LanguageModel;
  contextWindow?: number;
  modelOutputLimit?: number;
  reservedOutputTokens: number;
  systemPrompt: string;
  toolSchemas: unknown;
  trigger: ContextCompactionTrigger;
  policy: ContextCompactionPolicy;
  safetyStateMaxTokens?: number;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  /** Keep the durable current User while the runner replays the exact in-flight AI SDK suffix. */
  excludeAssistantMessageId?: MessageId;
  /** Exact AI SDK messages retained after the durable base projection. */
  retainedMessages?: ModelMessage[];
  /** First model request represented by retainedMessages, when known. */
  retainedMessagesStartRequestIndex?: number;
}

interface ResolvedModelContextPreparationInput extends ModelContextPreparationInput {
  retainedModelInput?: ContextPlannerInput["retainedModelInput"];
}

export interface ContextCompactionMarker {
  activityId?: ContextCompactionActivity["id"];
  checkpointId?: ContextCheckpoint["id"];
  trigger: ContextCompactionTrigger;
  auto: boolean;
  coverageThroughRunId?: RunId;
  coverageCursor?: ContextCoverageCursor;
  beforeEstimatedInputTokens: number;
  afterEstimatedInputTokens?: number;
  status: "preparing" | "created" | "failed" | "recovered" | "interrupted";
  time: { created: number };
}

export interface PreparedModelContext {
  plan: ContextPlan;
  instructions: SystemModelMessage[];
  messages: ModelMessage[];
  marker?: ContextCompactionMarker;
  /** The selected sealed-step checkpoint replaced the previously retained AI SDK suffix. */
  retainedMessagesCovered?: boolean;
}

export interface ModelContextForecastInput {
  conversationId: ConversationId;
  runId: RunId;
  requestIndex: number;
  providerId: string;
  modelId: string;
  contextWindow?: number;
  modelOutputLimit?: number;
  reservedOutputTokens: number;
  systemPrompt: string;
  toolSchemas: unknown;
  policy: ContextCompactionPolicy;
  safetyStateMaxTokens?: number;
  reason: ContextForecastReason;
}

export interface ModelContextManagerDependencies {
  store: RuntimeRunnerStore;
  compactionService: ContextCompactionService;
  attachmentService?: RuntimeAttachmentService | null;
  now?: () => number;
  createId?: <TPrefix extends RuntimeIdPrefix>(prefix: TPrefix) => RuntimeId<TPrefix>;
}

export class ContextPreparationStaleError extends Error {
  constructor(runId: RunId) {
    super(`Context preparation Run is no longer the active Conversation head: ${runId}`);
    this.name = "ContextPreparationStaleError";
  }
}

export class ContextPreparationInProgressError extends Error {
  constructor(runId: RunId, requestIndex: number) {
    super(`Context preparation is already in progress: ${runId}/${requestIndex}`);
    this.name = "ContextPreparationInProgressError";
  }
}

const preparationBrokers = new WeakMap<
  object,
  Map<string, { requestHash: string; operation: Promise<PreparedModelContext> }>
>();

export class ModelContextManager {
  private readonly store: RuntimeRunnerStore;
  private readonly compactionService: ContextCompactionService;
  private readonly attachmentService: RuntimeAttachmentService | null;
  private readonly now: () => number;
  private readonly createId: <TPrefix extends RuntimeIdPrefix>(prefix: TPrefix) => RuntimeId<TPrefix>;

  constructor(dependencies: ModelContextManagerDependencies) {
    this.store = dependencies.store;
    this.compactionService = dependencies.compactionService;
    this.attachmentService = dependencies.attachmentService ?? null;
    this.now = dependencies.now ?? Date.now;
    this.createId = dependencies.createId ?? createRuntimeId;
  }

  forecastNextTurn(input: ModelContextForecastInput): NextTurnContextForecast {
    const snapshot = readContextPlannerSnapshot(this.store, input.conversationId);
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
      trigger: "auto_pre_turn",
      policy: input.policy,
      planId: this.createId("ctxplan"),
      createdAt: this.now(),
      safetyStateMaxTokens: input.safetyStateMaxTokens,
    });
    return {
      conversationId: input.conversationId,
      sourceHeadRunId: plan.sourceHeadRunId,
      sourceConversationRevision: plan.sourceConversationRevision,
      providerId: input.providerId,
      modelId: input.modelId,
      ...(plan.budget.contextWindow === undefined
        ? {}
        : { contextWindow: plan.budget.contextWindow }),
      estimatedInputTokens: plan.budget.estimatedInputTokens,
      view: plan.view,
      ...(plan.checkpointId ? { checkpointId: plan.checkpointId } : {}),
      breakdown: {
        rawTokens: plan.budget.rawHistoryTokens,
        checkpointTokens: plan.budget.checkpointTokens,
        safetyStateTokens: plan.budget.safetyStateTokens,
        systemPromptTokens: plan.budget.systemPromptTokens,
        toolSchemaTokens: plan.budget.toolSchemaTokens,
      },
      estimatorVersion: input.policy.estimatorVersion,
      policyVersion: input.policy.version,
      checkpointFormatVersion: input.policy.checkpointFormatVersion,
      reason: input.reason,
    };
  }

  prepare(input: ModelContextPreparationInput): Promise<PreparedModelContext> {
    input.abortSignal?.throwIfAborted();
    const resolvedInput: ResolvedModelContextPreparationInput = {
      ...input,
      retainedModelInput: describeRetainedModelInput(
        input.retainedMessages,
        input.retainedMessagesStartRequestIndex,
      ),
    };
    const requestHash = computeContextPlanRequestHash(resolvedInput);
    const key = `${input.runId}:${input.requestIndex}`;
    const broker = getPreparationBroker(this.store.getContextPreparationBrokerKey());
    const inFlight = broker.get(key);
    if (inFlight) {
      if (inFlight.requestHash !== requestHash) {
        return Promise.reject(contextPlanIdentityError());
      }
      return inFlight.operation;
    }

    const operation = Promise.resolve().then(() =>
      this.prepareClaimed(resolvedInput, requestHash)
    );
    broker.set(key, { requestHash, operation });
    const clear = (): void => {
      if (broker.get(key)?.operation === operation) {
        broker.delete(key);
      }
    };
    void operation.then(clear, clear);
    return operation;
  }

  private async prepareClaimed(
    input: ResolvedModelContextPreparationInput,
    requestHash: string,
  ): Promise<PreparedModelContext> {
    const durablePlan = this.store.getContextPlanByRunRequest(input.runId, input.requestIndex);
    if (durablePlan) {
      this.assertPlanMatchesRequest(durablePlan, input, requestHash);
      const snapshot = readContextPlannerSnapshot(this.store, input.conversationId);
      this.assertPlanSourceIsCurrent(durablePlan, snapshot, input.runId);
      const context = await this.assembleContext(snapshot, durablePlan, input);
      return { plan: durablePlan, ...context };
    }

    const ownerId = `context-preparation:${randomUUID()}`;
    const claimRequest = {
      runId: input.runId,
      requestIndex: input.requestIndex,
      requestHash,
      ownerId,
      ttlMs: CONTEXT_PREPARATION_CLAIM_TTL_MS,
    };
    const result = this.store.claimContextPreparation(claimRequest);
    if (result.status === "conflict") throw contextPlanIdentityError();
    if (result.status === "in_progress") {
      throw new ContextPreparationInProgressError(input.runId, input.requestIndex);
    }
    const claim = result.claim;
    try {
      return await this.prepareOnce(input, requestHash, claim);
    } finally {
      this.store.releaseContextPreparationClaim(claim);
    }
  }

  private async prepareOnce(
    input: ResolvedModelContextPreparationInput,
    requestHash: string,
    preparationClaim: ContextPreparationClaim,
  ): Promise<PreparedModelContext> {
    const durablePlan = this.store.getContextPlanByRunRequest(input.runId, input.requestIndex);
    if (durablePlan) {
      this.assertPlanMatchesRequest(durablePlan, input, requestHash);
      const snapshot = readContextPlannerSnapshot(this.store, input.conversationId);
      this.assertPlanSourceIsCurrent(durablePlan, snapshot, input.runId);
      const context = await this.assembleContext(snapshot, durablePlan, input);
      return { plan: durablePlan, ...context };
    }

    let { snapshot, plan } = this.planFromStore(input, input.runId);
    let createdCheckpoint: ContextCheckpoint | undefined;
    let createdActivityId: ContextCompactionActivity["id"] | undefined;

    if (
      plan.reason === "compaction_required"
      || plan.reason === "raw_compaction_blocked"
    ) {
      const lifecyclePayload = {
        trigger: input.trigger,
        requestIndex: input.requestIndex,
        sourceHeadRunId: plan.sourceHeadRunId,
        sourceConversationRevision: plan.sourceConversationRevision,
        beforeEstimatedInputTokens: plan.budget.estimatedInputTokens,
        ...(plan.budget.summaryMaxOutputTokens === undefined
          ? {}
          : { summaryMaxOutputTokens: plan.budget.summaryMaxOutputTokens }),
        ...(plan.budget.summaryRetryMaxOutputTokens === undefined
          ? {}
          : { summaryRetryMaxOutputTokens: plan.budget.summaryRetryMaxOutputTokens }),
      };
      this.appendCompactionLifecycleTraceOnce({
        type: "context.compaction.preparing",
        level: "info",
        input,
        payload: lifecyclePayload,
      });
      let result: Awaited<ReturnType<ContextCompactionService["compact"]>>;
      try {
        const attemptIndex = this.store
          .listContextCompactionActivitiesByRun(input.runId)
          .filter((activity) => activity.requestIndex === input.requestIndex)
          .reduce(
            (nextAttemptIndex, activity) =>
              Math.max(nextAttemptIndex, activity.attemptIndex + 1),
            0,
          );
        result = await this.compactionService.compact({
          conversationId: input.conversationId,
          expectedHeadRunId: plan.sourceHeadRunId,
          expectedConversationRevision: plan.sourceConversationRevision,
          runId: plan.runId,
          requestIndex: input.requestIndex,
          activityBoundaryStepIndex: input.activityBoundaryStepIndex,
          attemptIndex,
          preparationClaim,
          providerId: input.providerId,
          modelId: input.modelId,
          model: input.model,
          contextWindow: input.contextWindow,
          modelOutputLimit: input.modelOutputLimit,
          reservedOutputTokens: input.reservedOutputTokens,
          systemPrompt: input.systemPrompt,
          toolSchemas: input.toolSchemas,
          trigger: input.trigger,
          candidateCoverageThroughRunId: plan.eligibleCoverageThroughRunId,
          candidateCoverageCursor: plan.eligibleCoverageCursor,
          policy: input.policy,
          safetyStateMaxTokens: input.safetyStateMaxTokens,
          excludeAssistantMessageId: input.excludeAssistantMessageId,
          retainedModelInput: input.retainedModelInput,
          abortSignal: input.abortSignal,
          timeoutMs: input.timeoutMs,
        });
      } catch (error) {
        if (
          !isContextCancellation(error, input.abortSignal)
          && !(error instanceof ContextPreparationLeaseLostError)
        ) {
          const diagnostics = error instanceof ContextSummaryValidationError
            ? error.diagnostics
            : {};
          try {
            this.appendCompactionLifecycleTraceOnce({
              type: "context.compaction.failed",
              level: "error",
              input,
              payload: {
                ...lifecyclePayload,
                errorName: readErrorName(error),
                ...diagnostics,
              },
            });
          } catch (traceError) {
            console.error("Failed to persist Context compaction failure lifecycle", traceError);
          }
        }
        throw error;
      }
      if (result.status === "created") {
        createdCheckpoint = result.checkpoint;
        createdActivityId = result.activityId;
      }
      if (result.status === "created" || result.status === "stale") {
        const conversation = this.store.getConversation(input.conversationId);
        if (conversation?.activeHeadRunId !== input.runId) {
          throw new ContextPreparationStaleError(input.runId);
        }
        ({ snapshot, plan } = this.planFromStore(
          input,
          input.runId,
          input.trigger === "provider_overflow"
            ? createdCheckpoint?.id
            : undefined,
        ));
      }
    }

    if (
      plan.reason === "compaction_required"
    ) {
      const error = new Error(
        "Context compaction did not produce a model view within the hard budget",
      );
      this.appendCompactionLifecycleTraceOnce({
        type: "context.compaction.failed",
        level: "error",
        input,
        payload: {
          trigger: input.trigger,
          requestIndex: input.requestIndex,
          sourceHeadRunId: plan.sourceHeadRunId,
          sourceConversationRevision: plan.sourceConversationRevision,
          beforeEstimatedInputTokens: plan.budget.estimatedInputTokens,
          errorName: error.name,
        },
      });
      throw error;
    }
    const proposedPlanId = plan.id;
    plan = this.saveOrReadDurablePlan(
      plan,
      snapshot,
      input,
      requestHash,
      preparationClaim,
    );
    if (plan.id !== proposedPlanId) {
      snapshot = readContextPlannerSnapshot(this.store, input.conversationId);
    }
    const context = await this.assembleContext(snapshot, plan, input);
    const marker = createdCheckpoint
      ? createMarker(createdCheckpoint, plan, createdActivityId)
      : undefined;
    return { plan, ...context, ...(marker ? { marker } : {}) };
  }

  private appendCompactionLifecycleTraceOnce(input: {
    type: "context.compaction.preparing" | "context.compaction.failed";
    level: TraceEvent["level"];
    input: ResolvedModelContextPreparationInput;
    payload: Record<string, unknown>;
  }): void {
    const alreadyRecorded = this.store.listTraces(input.input.runId).some((trace) =>
      trace.type === input.type
      && trace.payload.requestIndex === input.input.requestIndex
      && trace.payload.sourceHeadRunId === input.payload.sourceHeadRunId
      && trace.payload.sourceConversationRevision
        === input.payload.sourceConversationRevision
    );
    if (alreadyRecorded) return;
    this.store.appendTrace({
      id: this.createId("trace"),
      conversationId: input.input.conversationId,
      runId: input.input.runId,
      type: input.type,
      level: input.level,
      time: this.now(),
      payload: input.payload,
    });
  }

  private saveOrReadDurablePlan(
    plan: ContextPlan,
    snapshot: ContextPlannerSnapshot,
    input: ResolvedModelContextPreparationInput,
    requestHash: string,
    preparationClaim: ContextPreparationClaim,
  ): ContextPlan {
    this.renewPreparationClaim(preparationClaim);
    try {
      this.store.saveContextPlan({
        plan,
        eventId: this.createId("evt"),
        preparationClaim,
      });
      return plan;
    } catch (error) {
      if (!isContextPlanRequestUniqueConstraint(error)) throw error;
      const durablePlan = this.store.getContextPlanByRunRequest(input.runId, input.requestIndex);
      if (!durablePlan) throw error;
      this.assertPlanMatchesRequest(durablePlan, input, requestHash);
      this.assertPlanSourceIsCurrent(durablePlan, snapshot, input.runId);
      return durablePlan;
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

  private assertPlanMatchesRequest(
    plan: ContextPlan,
    input: ResolvedModelContextPreparationInput,
    requestHash: string,
  ): void {
    if (
      plan.conversationId !== input.conversationId
      || plan.runId !== input.runId
      || plan.requestIndex !== input.requestIndex
      || plan.requestHash !== requestHash
    ) {
      throw contextPlanIdentityError();
    }
  }

  private assertPlanSourceIsCurrent(
    plan: ContextPlan,
    snapshot: ContextPlannerSnapshot,
    runId: RunId,
  ): void {
    if (
      snapshot.conversation.activeHeadRunId !== runId
      || plan.sourceHeadRunId !== runId
      || snapshot.conversation.revision !== plan.sourceConversationRevision
    ) {
      throw new ContextPreparationStaleError(runId);
    }
  }

  private planFromStore(
    input: ResolvedModelContextPreparationInput,
    runId: RunId,
    providerOverflowCheckpointId?: ContextCheckpoint["id"],
  ): { snapshot: ContextPlannerSnapshot; plan: ContextPlan } {
    const snapshot = readContextPlannerSnapshot(this.store, input.conversationId);
    return {
      snapshot,
      plan: planContextWindow({
        snapshot,
        runId,
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
        ...(providerOverflowCheckpointId
          ? { providerOverflowCheckpointId }
          : {}),
      }),
    };
  }

  private async assembleContext(
    snapshot: ContextPlannerSnapshot,
    plan: ContextPlan,
    input: ResolvedModelContextPreparationInput,
  ): Promise<Pick<
    PreparedModelContext,
    "instructions" | "messages" | "retainedMessagesCovered"
  >> {
    const checkpoint = plan.checkpointId
      ? snapshot.checkpoints.find((candidate) => candidate.id === plan.checkpointId)
      : undefined;
    if (plan.checkpointId && !checkpoint) {
      throw new Error(`Selected Context checkpoint is unavailable: ${plan.checkpointId}`);
    }
    const rawMessages = messagesForPlan(
      snapshot,
      plan.rawRunIds,
      input.excludeAssistantMessageId,
    );
    const projectedRaw = await projectModelHistory(rawMessages, {
      target: { providerId: input.providerId, modelId: input.modelId },
      attachmentService: this.attachmentService,
    });
    const rawInstructions = projectedRaw.filter(
      (message): message is SystemModelMessage => message.role === "system",
    );
    const checkpointCursor = checkpoint
      ? resolveContextCoverageCursor(checkpoint)
      : undefined;
    const retainedMessagesCovered = Boolean(input.retainedMessages?.length)
      && checkpointCursor?.kind === "sealed_step"
      && checkpointCursor.runId === input.runId
      && input.retainedModelInput?.fromRequestIndex !== undefined
      && input.retainedModelInput.fromRequestIndex <= checkpointCursor.throughRequestIndex;
    const messages = [
      ...projectedRaw.filter((message) => message.role !== "system"),
      ...(retainedMessagesCovered ? [] : input.retainedMessages ?? []),
    ];
    assertNoSystemModelMessages(messages);
    return {
      instructions: [
        ...rawInstructions,
        ...projectContextBoundaries({
          checkpoint,
          safetyState: plan.safetyState,
        }),
      ],
      messages,
      ...(retainedMessagesCovered ? { retainedMessagesCovered: true } : {}),
    };
  }
}

function assertNoSystemModelMessages(messages: readonly ModelMessage[]): void {
  if (messages.some((message) => message.role === "system")) {
    throw new Error(
      "Prepared Runtime model messages must not contain system instructions",
    );
  }
}

function describeRetainedModelInput(
  messages: readonly ModelMessage[] | undefined,
  fromRequestIndex: number | undefined,
): ContextPlannerInput["retainedModelInput"] {
  if (!messages?.length) return undefined;
  return {
    estimatedTokens: messages.reduce(
      (total, message) => total
        + CONTEXT_ESTIMATOR_OVERHEAD.message
        + CONTEXT_ESTIMATOR_OVERHEAD.part
        + estimateJsonTokens(message),
      0,
    ),
    contentHash: `sha256:${createHash("sha256")
      .update(stableStringifyJson(messages))
      .digest("hex")}`,
    ...(fromRequestIndex === undefined ? {} : { fromRequestIndex }),
  };
}

function getPreparationBroker(
  storeKey: object,
): Map<string, { requestHash: string; operation: Promise<PreparedModelContext> }> {
  const existing = preparationBrokers.get(storeKey);
  if (existing) return existing;
  const created = new Map<
    string,
    { requestHash: string; operation: Promise<PreparedModelContext> }
  >();
  preparationBrokers.set(storeKey, created);
  return created;
}

function isContextCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted && error === signal.reason) return true;
  return typeof error === "object"
    && error !== null
    && "name" in error
    && error.name === "AbortError";
}

function readErrorName(error: unknown): string {
  return typeof error === "object"
    && error !== null
    && "name" in error
    && typeof error.name === "string"
    && error.name.length > 0
    ? error.name
    : "Error";
}

function contextPlanIdentityError(): Error {
  return new Error("Context preparation input does not match the durable Context plan");
}

function isContextPlanRequestUniqueConstraint(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "SQLITE_CONSTRAINT_UNIQUE"
    && "message" in error
    && typeof error.message === "string"
    && error.message.includes(
      "UNIQUE constraint failed: runtime_context_plans.run_id, runtime_context_plans.request_index",
    );
}

function isRawWithinHardBudget(plan: ContextPlan): boolean {
  return plan.budget.hardInputBudget !== undefined
    && plan.budget.rawHistoryTokens + plan.budget.safetyStateTokens
      <= plan.budget.hardInputBudget;
}

function messagesForPlan(
  snapshot: ContextPlannerSnapshot,
  runIds: readonly RunId[],
  excludeAssistantMessageId?: MessageId,
): Message[] {
  const runsById = new Map(snapshot.runs.map((run) => [run.id, run]));
  const messagesById = new Map(snapshot.messages.map((message) => [message.id, message]));
  return runIds.flatMap((runId) => {
    const run: Run | undefined = runsById.get(runId);
    const user = run?.parentMessageId ? messagesById.get(run.parentMessageId) : undefined;
    const assistant = run?.assistantMessageId
      ? messagesById.get(run.assistantMessageId)
      : undefined;
    if (!run || !user || user.role !== "user" || !assistant || assistant.role !== "assistant") {
      throw new Error(`Context plan raw Run has incomplete Messages: ${runId}`);
    }
    return assistant.id === excludeAssistantMessageId ? [user] : [user, assistant];
  });
}

function createMarker(
  checkpoint: ContextCheckpoint,
  plan: ContextPlan,
  activityId?: ContextCompactionActivity["id"],
): ContextCompactionMarker {
  return {
    ...(activityId ? { activityId } : {}),
    checkpointId: checkpoint.id,
    trigger: checkpoint.trigger,
    auto: checkpoint.trigger !== "manual",
    coverageThroughRunId: checkpoint.coverageThroughRunId,
    ...(checkpoint.coverageCursor
      ? { coverageCursor: checkpoint.coverageCursor }
      : {}),
    beforeEstimatedInputTokens: checkpoint.budget.estimatedInputTokens,
    afterEstimatedInputTokens: plan.budget.estimatedInputTokens,
    status: "created",
    time: { created: checkpoint.time.created },
  };
}
