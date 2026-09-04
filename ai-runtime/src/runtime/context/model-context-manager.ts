import { randomUUID } from "node:crypto";
import type { LanguageModel, ModelMessage } from "ai";

import type { RuntimeAttachmentService } from "../attachments";
import { createRuntimeId, type RuntimeId, type RuntimeIdPrefix } from "../core/ids";
import type { ConversationId, Message, Run, RunId } from "../core/types";
import {
  projectContextBoundaries,
  projectModelHistory,
} from "../projection/model-history-projection";
import type { RuntimeRunnerStore } from "../runners/runner-types";
import {
  ContextCompactionService,
  readContextPlannerSnapshot,
} from "./compaction-service";
import { computeContextPlanRequestHash, planContextWindow } from "./planner";
import { ContextPreparationLeaseLostError } from "./types";
import type {
  ContextCheckpoint,
  ContextCompactionPolicy,
  ContextCompactionTrigger,
  ContextPlan,
  ContextPreparationClaim,
  ContextPlannerSnapshot,
} from "./types";

export interface ModelContextPreparationInput {
  conversationId: ConversationId;
  runId: RunId;
  requestIndex: number;
  providerId: string;
  modelId: string;
  model: LanguageModel;
  contextWindow?: number;
  reservedOutputTokens: number;
  systemPrompt: string;
  toolSchemas: unknown;
  trigger: ContextCompactionTrigger;
  policy: ContextCompactionPolicy;
  safetyStateMaxTokens?: number;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

export interface ContextCompactionMarker {
  checkpointId: ContextCheckpoint["id"];
  trigger: ContextCompactionTrigger;
  auto: boolean;
  coverageThroughRunId: RunId;
  beforeEstimatedInputTokens: number;
  afterEstimatedInputTokens: number;
  status: "created";
  time: { created: number };
}

export interface PreparedModelContext {
  plan: ContextPlan;
  messages: ModelMessage[];
  marker?: ContextCompactionMarker;
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

const CONTEXT_PREPARATION_CLAIM_TTL_MS = 5 * 60 * 1_000;
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

  prepare(input: ModelContextPreparationInput): Promise<PreparedModelContext> {
    input.abortSignal?.throwIfAborted();
    const requestHash = computeContextPlanRequestHash(input);
    const key = `${input.runId}:${input.requestIndex}`;
    const broker = getPreparationBroker(this.store.getContextPreparationBrokerKey());
    const inFlight = broker.get(key);
    if (inFlight) {
      if (inFlight.requestHash !== requestHash) {
        return Promise.reject(contextPlanIdentityError());
      }
      return inFlight.operation;
    }

    const operation = Promise.resolve().then(() => this.prepareClaimed(input, requestHash));
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
    input: ModelContextPreparationInput,
    requestHash: string,
  ): Promise<PreparedModelContext> {
    const durablePlan = this.store.getContextPlanByRunRequest(input.runId, input.requestIndex);
    if (durablePlan) {
      this.assertPlanMatchesRequest(durablePlan, input, requestHash);
      const snapshot = readContextPlannerSnapshot(this.store, input.conversationId);
      this.assertPlanSourceIsCurrent(durablePlan, snapshot, input.runId);
      const messages = await this.assembleMessages(snapshot, durablePlan, input);
      return { plan: durablePlan, messages };
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
    input: ModelContextPreparationInput,
    requestHash: string,
    preparationClaim: ContextPreparationClaim,
  ): Promise<PreparedModelContext> {
    const durablePlan = this.store.getContextPlanByRunRequest(input.runId, input.requestIndex);
    if (durablePlan) {
      this.assertPlanMatchesRequest(durablePlan, input, requestHash);
      const snapshot = readContextPlannerSnapshot(this.store, input.conversationId);
      this.assertPlanSourceIsCurrent(durablePlan, snapshot, input.runId);
      const messages = await this.assembleMessages(snapshot, durablePlan, input);
      return { plan: durablePlan, messages };
    }

    let { snapshot, plan } = this.planFromStore(input, input.runId);
    let createdCheckpoint: ContextCheckpoint | undefined;

    if (plan.reason === "compaction_required") {
      let result: Awaited<ReturnType<ContextCompactionService["compact"]>> | undefined;
      try {
        result = await this.compactionService.compact({
          conversationId: input.conversationId,
          expectedHeadRunId: plan.sourceHeadRunId,
          expectedConversationRevision: plan.sourceConversationRevision,
          runId: plan.runId,
          requestIndex: input.requestIndex,
          preparationClaim,
          providerId: input.providerId,
          modelId: input.modelId,
          model: input.model,
          contextWindow: input.contextWindow,
          reservedOutputTokens: input.reservedOutputTokens,
          systemPrompt: input.systemPrompt,
          toolSchemas: input.toolSchemas,
          trigger: input.trigger,
          candidateCoverageThroughRunId: plan.eligibleCoverageThroughRunId,
          policy: input.policy,
          safetyStateMaxTokens: input.safetyStateMaxTokens,
          abortSignal: input.abortSignal,
          timeoutMs: input.timeoutMs,
        });
      } catch (error) {
        if (
          input.trigger !== "auto_pre_turn"
          || isContextCancellation(error, input.abortSignal)
          || error instanceof ContextPreparationLeaseLostError
          || !isRawWithinHardBudget(plan)
        ) {
          throw error;
        }
        // The original plan already represents the complete raw lineage. Reuse it
        // only for this explicit under-hard fallback; no checkpoint was committed.
      }
      if (result?.status === "created") {
        createdCheckpoint = result.checkpoint;
      }
      if (result?.status === "created" || result?.status === "stale") {
        const conversation = this.store.getConversation(input.conversationId);
        if (conversation?.activeHeadRunId !== input.runId) {
          throw new ContextPreparationStaleError(input.runId);
        }
        ({ snapshot, plan } = this.planFromStore(input, input.runId));
      }
    }

    if (plan.reason === "compaction_required" && !isRawWithinHardBudget(plan)) {
      throw new Error("Context compaction did not produce a model view within the hard budget");
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
    const messages = await this.assembleMessages(snapshot, plan, input);
    const marker = createdCheckpoint
      ? createMarker(createdCheckpoint, plan)
      : undefined;
    return { plan, messages, ...(marker ? { marker } : {}) };
  }

  private saveOrReadDurablePlan(
    plan: ContextPlan,
    snapshot: ContextPlannerSnapshot,
    input: ModelContextPreparationInput,
    requestHash: string,
    preparationClaim: ContextPreparationClaim,
  ): ContextPlan {
    try {
      this.store.saveContextPlan({ plan, preparationClaim });
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

  private assertPlanMatchesRequest(
    plan: ContextPlan,
    input: ModelContextPreparationInput,
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
    input: ModelContextPreparationInput,
    runId: RunId,
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
        reservedOutputTokens: input.reservedOutputTokens,
        systemPrompt: input.systemPrompt,
        toolSchemas: input.toolSchemas,
        trigger: input.trigger,
        policy: input.policy,
        planId: this.createId("ctxplan"),
        createdAt: this.now(),
        safetyStateMaxTokens: input.safetyStateMaxTokens,
      }),
    };
  }

  private async assembleMessages(
    snapshot: ContextPlannerSnapshot,
    plan: ContextPlan,
    input: ModelContextPreparationInput,
  ): Promise<ModelMessage[]> {
    const checkpoint = plan.checkpointId
      ? snapshot.checkpoints.find((candidate) => candidate.id === plan.checkpointId)
      : undefined;
    if (plan.checkpointId && !checkpoint) {
      throw new Error(`Selected Context checkpoint is unavailable: ${plan.checkpointId}`);
    }
    const rawMessages = messagesForPlan(snapshot, plan.rawRunIds);
    const projectedRaw = await projectModelHistory(rawMessages, {
      target: { providerId: input.providerId, modelId: input.modelId },
      attachmentService: this.attachmentService,
    });
    return [
      ...projectContextBoundaries({ checkpoint, safetyState: plan.safetyState }),
      ...projectedRaw,
    ];
  }
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

function messagesForPlan(snapshot: ContextPlannerSnapshot, runIds: readonly RunId[]): Message[] {
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
    return [user, assistant];
  });
}

function createMarker(
  checkpoint: ContextCheckpoint,
  plan: ContextPlan,
): ContextCompactionMarker {
  return {
    checkpointId: checkpoint.id,
    trigger: checkpoint.trigger,
    auto: checkpoint.trigger !== "manual",
    coverageThroughRunId: checkpoint.coverageThroughRunId,
    beforeEstimatedInputTokens: checkpoint.budget.estimatedInputTokens,
    afterEstimatedInputTokens: plan.budget.estimatedInputTokens,
    status: "created",
    time: { created: checkpoint.time.created },
  };
}
