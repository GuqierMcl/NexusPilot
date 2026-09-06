import { createHash } from "node:crypto";
import type {
  AssistantMessage,
  Message,
  MessageId,
  Run,
  RunId,
  UserMessage,
} from "../core/types";
import {
  CONTEXT_CHECKPOINT_COMPATIBILITY_VERSION,
  CONTEXT_CHECKPOINT_FORMAT_VERSION,
  CONTEXT_COMPACTION_POLICY_VERSION,
  CONTEXT_ESTIMATOR_VERSION,
  CONTEXT_LINEAGE_HASH_VERSION,
  PROVIDER_NEUTRAL_CONTEXT_KIND,
  RUNTIME_SAFETY_STATE_VERSION,
} from "./policy";
import { buildRuntimeSafetyState } from "./safety-state";
import {
  CONTEXT_ESTIMATOR_OVERHEAD,
  estimateJsonTokens,
  estimateMessagesTokens,
  estimateTextTokens,
  stableStringifyJson,
} from "./token-estimator";
import type {
  ContextBudgetSnapshot,
  ContextCheckpoint,
  ContextCheckpointRejection,
  ContextCoverageCursor,
  ContextPlan,
  ContextPlannerInput,
  RuntimeSafetyState,
} from "./types";
import {
  findLatestSafeSealedStepCursor,
  isContextCoverageBoundarySafe,
  isContextCoverageCursorSafe,
} from "./boundary-validation";

export function computeContextLineageHash(
  runs: readonly Run[],
  coverageThroughRunId?: RunId,
): string {
  const end = coverageThroughRunId === undefined
    ? runs.length
    : runs.findIndex((run) => run.id === coverageThroughRunId) + 1;
  if (end <= 0) {
    throw new Error(`Context lineage coverage Run was not found: ${coverageThroughRunId}`);
  }

  const lineage = runs.slice(0, end).map((run) => {
    if (!run.parentMessageId || !run.assistantMessageId) {
      throw new Error(`Context lineage Run is missing stable Message identities: ${run.id}`);
    }
    return {
      runId: run.id,
      userMessageId: run.parentMessageId,
      assistantMessageId: run.assistantMessageId,
    };
  });
  const payload = JSON.stringify({ version: CONTEXT_LINEAGE_HASH_VERSION, lineage });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

export function resolveContextCoverageCursor(
  checkpoint: Pick<ContextCheckpoint, "coverageCursor" | "coverageThroughRunId">,
): ContextCoverageCursor {
  return checkpoint.coverageCursor ?? {
    kind: "run",
    throughRunId: checkpoint.coverageThroughRunId,
  };
}

export function contextCoverageRunId(cursor: ContextCoverageCursor): RunId {
  return cursor.kind === "run" ? cursor.throughRunId : cursor.runId;
}

export function computeContextCoverageHash(
  runs: readonly Run[],
  messages: readonly Message[],
  cursor: ContextCoverageCursor,
): string {
  if (cursor.kind === "run") {
    return computeContextLineageHash(runs, cursor.throughRunId);
  }
  const coverageIndex = runs.findIndex((run) => run.id === cursor.runId);
  if (coverageIndex < 0) {
    throw new Error(`Context lineage coverage Run was not found: ${cursor.runId}`);
  }
  const run = runs[coverageIndex]!;
  if (!run.parentMessageId || !run.assistantMessageId) {
    throw new Error(`Context lineage Run is missing stable Message identities: ${run.id}`);
  }
  const assistant = messages.find(
    (message): message is AssistantMessage =>
      message.role === "assistant" && message.id === run.assistantMessageId,
  );
  const partIndex = assistant?.parts.findIndex(
    (part) => part.id === cursor.throughPartId,
  ) ?? -1;
  const boundary = assistant?.parts[partIndex];
  if (
    !assistant
    || partIndex < 0
    || boundary?.type !== "step-finish"
    || boundary.stepIndex !== cursor.throughRequestIndex
  ) {
    throw new Error(`Context sealed-step cursor is invalid: ${cursor.runId}/${cursor.throughPartId}`);
  }
  const lineage = runs.slice(0, coverageIndex).map((candidate) => {
    if (!candidate.parentMessageId || !candidate.assistantMessageId) {
      throw new Error(`Context lineage Run is missing stable Message identities: ${candidate.id}`);
    }
    return {
      runId: candidate.id,
      userMessageId: candidate.parentMessageId,
      assistantMessageId: candidate.assistantMessageId,
    };
  });
  const payload = stableStringifyJson({
    version: "2",
    lineage,
    sealedStep: {
      runId: run.id,
      userMessageId: run.parentMessageId,
      assistantMessageId: run.assistantMessageId,
      throughRequestIndex: cursor.throughRequestIndex,
      throughPartId: cursor.throughPartId,
      parts: assistant.parts.slice(0, partIndex + 1),
    },
  });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

export function isContextCheckpointParentChainUsable(
  checkpoint: ContextCheckpoint,
  checkpointsById: ReadonlyMap<string, ContextCheckpoint>,
  lineageRuns: readonly Run[],
): boolean {
  const coverageIndices = new Map(
    lineageRuns.map((run, index) => [run.id, index] as const),
  );
  let child = checkpoint;
  let childPosition = contextCoveragePosition(
    resolveContextCoverageCursor(child),
    coverageIndices,
  );
  const visited = new Set<string>([checkpoint.id]);

  while (child.parentCheckpointId) {
    const parent = checkpointsById.get(child.parentCheckpointId);
    if (!parent || visited.has(parent.id)) return false;
    visited.add(parent.id);

    if (
      parent.conversationId !== checkpoint.conversationId
      || parent.formatVersion !== CONTEXT_CHECKPOINT_FORMAT_VERSION
      || parent.compatibility.kind !== PROVIDER_NEUTRAL_CONTEXT_KIND
      || parent.compatibility.version !== CONTEXT_CHECKPOINT_COMPATIBILITY_VERSION
      || parent.safetyStateVersion !== RUNTIME_SAFETY_STATE_VERSION
    ) {
      return false;
    }

    const parentCursor = resolveContextCoverageCursor(parent);
    const parentPosition = contextCoveragePosition(parentCursor, coverageIndices);
    if (
      !childPosition
      || !parentPosition
      || compareContextCoveragePositions(parentPosition, childPosition) >= 0
      || (parentCursor.kind === "run"
        && computeContextLineageHash(lineageRuns, parentCursor.throughRunId)
          !== parent.lineageHash)
    ) {
      return false;
    }

    child = parent;
    childPosition = parentPosition;
  }

  return true;
}

function contextCoveragePosition(
  cursor: ContextCoverageCursor,
  coverageIndices: ReadonlyMap<RunId, number>,
): readonly [number, number] | undefined {
  const runIndex = coverageIndices.get(contextCoverageRunId(cursor));
  if (runIndex === undefined) return undefined;
  return [runIndex, cursor.kind === "run" ? Number.MAX_SAFE_INTEGER : cursor.throughRequestIndex];
}

function compareContextCoveragePositions(
  left: readonly [number, number],
  right: readonly [number, number],
): number {
  return left[0] - right[0] || left[1] - right[1];
}

interface ResolvedContextLineage {
  runs: Run[];
  messagesByRun: Map<RunId, [UserMessage, AssistantMessage]>;
}

interface CheckpointCandidate {
  checkpoint: ContextCheckpoint;
  coverageIndex: number;
  coverageStepIndex: number;
  rawRuns: Run[];
  rawMessages: Message[];
  rawTokens: number;
  checkpointTokens: number;
  contentTokens: number;
}

type CheckpointCandidateEvaluation =
  | { candidate: CheckpointCandidate }
  | { rejection: ContextCheckpointRejection };

export type ContextPlanningErrorCode =
  | "CONTEXT_SOFT_TRIGGER_REACHED_WITHOUT_SAFE_BOUNDARY"
  | "CONTEXT_HARD_BUDGET_EXCEEDED_WITHOUT_SAFE_BOUNDARY";

export class ContextPlanningError extends Error {
  constructor(readonly code: ContextPlanningErrorCode) {
    super(
      code === "CONTEXT_SOFT_TRIGGER_REACHED_WITHOUT_SAFE_BOUNDARY"
        ? "Context reached the compaction threshold but has no safe compaction boundary"
        : "Context exceeds the hard input budget and has no safe compaction boundary",
    );
    this.name = "ContextPlanningError";
  }
}

export function computeContextPlanRequestHash(
  input: Pick<
    ContextPlannerInput,
    | "runId"
    | "requestIndex"
    | "providerId"
    | "modelId"
    | "contextWindow"
    | "modelOutputLimit"
    | "reservedOutputTokens"
    | "systemPrompt"
    | "toolSchemas"
    | "trigger"
    | "policy"
    | "safetyStateMaxTokens"
    | "excludeAssistantMessageId"
    | "retainedModelInput"
  >,
): string {
  const identity = {
    version: "1",
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
    safetyStateMaxTokens: input.safetyStateMaxTokens,
    excludeAssistantMessageId: input.excludeAssistantMessageId,
    retainedModelInput: input.retainedModelInput,
  };
  return `sha256:${createHash("sha256")
    .update(stableStringifyJson(identity))
    .digest("hex")}`;
}

export function planContextWindow(input: ContextPlannerInput): ContextPlan {
  assertPlannerInput(input);
  const lineage = resolveActiveLineage(input);
  const lineageRunIds = lineage.runs.map((run) => run.id);
  const fullMessages = messagesForRuns(
    lineage,
    lineage.runs,
    input.excludeAssistantMessageId,
  );
  const safetyState = buildRuntimeSafetyState({
    conversationId: input.snapshot.conversation.id,
    activeRunIds: lineageRunIds,
    toolCalls: input.snapshot.toolCalls,
    permissions: input.snapshot.permissions,
    maxTokens: input.safetyStateMaxTokens,
  });
  const systemPromptTokens = estimateTextTokens(input.systemPrompt);
  const toolSchemaTokens = estimateJsonTokens(input.toolSchemas);
  const retainedModelInputTokens = input.retainedModelInput?.estimatedTokens ?? 0;
  const fullRawTokens = estimateMessagesTokens(fullMessages) + retainedModelInputTokens;
  const safetyStateTokens = estimateJsonTokens(safetyState);
  const validContextWindow = isValidContextWindow(input.contextWindow)
    ? input.contextWindow
    : undefined;

  if (validContextWindow === undefined) {
    return createPlan(input, {
      lineageRunIds,
      rawRuns: lineage.runs,
      view: "raw",
      reason: "context_window_unavailable",
      safetyState,
      budget: createBudget(input, {
        contextWindow: undefined,
        systemPromptTokens,
        toolSchemaTokens,
        rawHistoryTokens: fullRawTokens,
        checkpointTokens: 0,
        safetyStateTokens,
      }),
    });
  }

  const rawBudget = createBudget(input, {
    contextWindow: validContextWindow,
    systemPromptTokens,
    toolSchemaTokens,
    rawHistoryTokens: fullRawTokens,
    checkpointTokens: 0,
    safetyStateTokens,
  });
  const rawContentTokens = fullRawTokens + safetyStateTokens;
  const hasCurrentRunSealedCheckpoint = input.trigger === "auto_mid_turn"
    && input.snapshot.checkpoints.some((checkpoint) => {
      const cursor = resolveContextCoverageCursor(checkpoint);
      return cursor.kind === "sealed_step"
        && cursor.runId === input.runId
        && cursor.throughRequestIndex < input.requestIndex;
    });
  if (
    input.trigger !== "provider_overflow"
    && !hasCurrentRunSealedCheckpoint
    &&
    rawContentTokens <= (rawBudget.hardInputBudget ?? Number.NEGATIVE_INFINITY)
    && rawContentTokens < (rawBudget.softTriggerTokens ?? Number.NEGATIVE_INFINITY)
  ) {
    return createPlan(input, {
      lineageRunIds,
      rawRuns: lineage.runs,
      view: "raw",
      reason: "raw_within_budget",
      safetyState,
      budget: rawBudget,
    });
  }

  const safeCoverageIndices = findSafeCoverageIndices(input, lineage.runs);
  const safeSealedStepCursor = input.trigger === "auto_mid_turn"
    || input.trigger === "provider_overflow"
    ? findLatestSafeSealedStepCursor({
        snapshot: input.snapshot,
        lineageRuns: lineage.runs,
        beforeRequestIndex: input.requestIndex,
      })
    : undefined;
  const targetTokens = rawBudget.targetTokens ?? Number.NEGATIVE_INFINITY;
  const checkpointsById = new Map(
    input.snapshot.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint] as const),
  );
  const evaluatedCheckpoints = input.trigger === "provider_overflow"
    && input.providerOverflowCheckpointId === undefined
    ? []
    : input.snapshot.checkpoints
      .filter((checkpoint) =>
        input.providerOverflowCheckpointId === undefined
        || checkpoint.id === input.providerOverflowCheckpointId
      )
      .map((checkpoint) => evaluateCheckpointCandidate(
      checkpoint,
      checkpointsById,
      input,
      lineage,
      safeCoverageIndices,
      safeSealedStepCursor,
      safetyStateTokens,
      retainedModelInputTokens,
      targetTokens,
    ));
  const evaluatedRejections = evaluatedCheckpoints
    .flatMap((evaluation) => "rejection" in evaluation ? [evaluation.rejection] : [])
    .sort((left, right) => left.checkpointId.localeCompare(right.checkpointId));
  const candidates = evaluatedCheckpoints
    .flatMap((evaluation) => "candidate" in evaluation ? [evaluation.candidate] : [])
    .sort((left, right) =>
      right.coverageIndex - left.coverageIndex
      || right.coverageStepIndex - left.coverageStepIndex
      || left.contentTokens - right.contentTokens
      || right.checkpoint.time.created - left.checkpoint.time.created
      || left.checkpoint.id.localeCompare(right.checkpoint.id),
    );
  const selected = candidates[0];
  const checkpointRejections = evaluatedRejections;
  if (selected) {
    return createPlan(input, {
      lineageRunIds,
      rawRuns: selected.rawRuns,
      view: "checkpoint",
      reason: "checkpoint_selected",
      checkpoint: selected.checkpoint,
      safetyState,
      budget: createBudget(input, {
        contextWindow: validContextWindow,
        systemPromptTokens,
        toolSchemaTokens,
        rawHistoryTokens: selected.rawTokens,
        checkpointTokens: selected.checkpointTokens,
        safetyStateTokens,
      }),
      checkpointRejections,
    });
  }

  const eligibleCoverageIndex = safeCoverageIndices.at(-1);
  const eligibleCoverageCursor: ContextCoverageCursor | undefined =
    safeSealedStepCursor
    ?? (eligibleCoverageIndex === undefined
      ? undefined
      : {
          kind: "run",
          throughRunId: lineage.runs[eligibleCoverageIndex]!.id,
        });
  if (eligibleCoverageCursor === undefined) {
    return createPlan(input, {
      lineageRunIds,
      rawRuns: lineage.runs,
      view: "raw",
      reason: "raw_compaction_blocked",
      safetyState,
      budget: rawBudget,
      checkpointRejections,
    });
  }
  return createPlan(input, {
    lineageRunIds,
    rawRuns: lineage.runs,
    view: "raw",
    reason: "compaction_required",
    eligibleCoverageCursor,
    eligibleCoverageThroughRunId: contextCoverageRunId(eligibleCoverageCursor),
    safetyState,
    budget: rawBudget,
    checkpointRejections,
  });
}

function assertPlannerInput(input: ContextPlannerInput): void {
  const { conversation } = input.snapshot;
  if (!conversation.activeHeadRunId) {
    throw new Error("Context planner requires an active Conversation head");
  }
  if (input.runId !== conversation.activeHeadRunId) {
    throw new Error("Context planner Run must be the active Conversation head");
  }
  if (!Number.isSafeInteger(input.requestIndex) || input.requestIndex < 0) {
    throw new Error("Context planner requestIndex must be a non-negative integer");
  }
  if (!isNonnegativeInteger(input.reservedOutputTokens)) {
    throw new Error("Context planner reservedOutputTokens must be a non-negative safe integer");
  }
  if (
    input.modelOutputLimit !== undefined
    && (!Number.isSafeInteger(input.modelOutputLimit) || input.modelOutputLimit <= 0)
  ) {
    throw new Error("Context planner modelOutputLimit must be a positive safe integer");
  }
  if (
    input.retainedModelInput !== undefined
    && (
      !isNonnegativeInteger(input.retainedModelInput.estimatedTokens)
      || input.retainedModelInput.contentHash.length === 0
      || (input.retainedModelInput.fromRequestIndex !== undefined
        && !isNonnegativeInteger(input.retainedModelInput.fromRequestIndex))
    )
  ) {
    throw new Error("Context planner retained model input is invalid");
  }
  if (
    input.providerOverflowCheckpointId !== undefined
    && input.trigger !== "provider_overflow"
  ) {
    throw new Error(
      "Context planner overflow checkpoint selection requires a Provider overflow trigger",
    );
  }
  const policy = input.policy;
  if (
    policy.version !== CONTEXT_COMPACTION_POLICY_VERSION
    || policy.estimatorVersion !== CONTEXT_ESTIMATOR_VERSION
    || policy.checkpointFormatVersion !== CONTEXT_CHECKPOINT_FORMAT_VERSION
    || policy.compatibilityVersion !== CONTEXT_CHECKPOINT_COMPATIBILITY_VERSION
  ) {
    throw new Error("Context compaction policy uses an unsupported implementation version");
  }
  if (
    !Number.isFinite(policy.softTriggerRatio)
    || !Number.isFinite(policy.targetRatio)
    || policy.softTriggerRatio <= 0
    || policy.softTriggerRatio > 1
    || policy.targetRatio <= 0
    || policy.targetRatio >= policy.softTriggerRatio
    || !Number.isSafeInteger(policy.minRawRuns)
    || policy.minRawRuns < 1
    || !isNonnegativeInteger(policy.safetyMarginTokens)
    || !isNonnegativeInteger(policy.summaryMaxOutputTokens)
    || !isNonnegativeInteger(policy.summaryRetryMaxOutputTokens)
    || policy.summaryRetryMaxOutputTokens < policy.summaryMaxOutputTokens
    || !isNonnegativeInteger(policy.summaryMaxChars)
  ) {
    throw new Error("Context compaction policy is invalid");
  }
}

function isNonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function resolveActiveLineage(input: ContextPlannerInput): ResolvedContextLineage {
  const conversationId = input.snapshot.conversation.id;
  const headRunId = input.snapshot.conversation.activeHeadRunId!;
  const runsById = new Map(input.snapshot.runs.map((run) => [run.id, run]));
  const messagesById = new Map(input.snapshot.messages.map((message) => [message.id, message]));
  const reverseRuns: Run[] = [];
  const visited = new Set<RunId>();
  let current: RunId | undefined = headRunId;
  while (current) {
    if (visited.has(current)) {
      throw new Error(`Context planner active lineage contains a cycle at ${current}`);
    }
    visited.add(current);
    const run = runsById.get(current);
    if (!run || run.conversationId !== conversationId) {
      throw new Error(`Context planner active lineage Run is missing or foreign: ${current}`);
    }
    reverseRuns.push(run);
    current = run.parentRunId;
  }
  const runs = reverseRuns.reverse();
  const messagesByRun = new Map<RunId, [UserMessage, AssistantMessage]>();
  for (const run of runs) {
    const user = run.parentMessageId ? messagesById.get(run.parentMessageId) : undefined;
    const assistant = run.assistantMessageId
      ? messagesById.get(run.assistantMessageId)
      : undefined;
    if (
      !user
      || user.role !== "user"
      || user.conversationId !== conversationId
      || !assistant
      || assistant.role !== "assistant"
      || assistant.conversationId !== conversationId
      || assistant.runId !== run.id
      || assistant.parentId !== user.id
    ) {
      throw new Error(`Context planner Run has incomplete Message identities: ${run.id}`);
    }
    messagesByRun.set(run.id, [user, assistant]);
  }
  return { runs, messagesByRun };
}

function messagesForRuns(
  lineage: ResolvedContextLineage,
  runs: readonly Run[],
  excludeAssistantMessageId?: MessageId,
): Message[] {
  return runs.flatMap((run) => {
    const messages = lineage.messagesByRun.get(run.id);
    if (!messages) {
      throw new Error(`Context planner Run messages are unavailable: ${run.id}`);
    }
    return messages[1].id === excludeAssistantMessageId
      ? [messages[0]]
      : messages;
  });
}

function isValidContextWindow(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function createBudget(
  input: ContextPlannerInput,
  estimates: {
    contextWindow: number | undefined;
    systemPromptTokens: number;
    toolSchemaTokens: number;
    rawHistoryTokens: number;
    checkpointTokens: number;
    safetyStateTokens: number;
  },
): ContextBudgetSnapshot {
  const fixed = input.reservedOutputTokens
    + input.policy.safetyMarginTokens
    + estimates.systemPromptTokens
    + estimates.toolSchemaTokens;
  const thresholds = estimates.contextWindow === undefined
    ? {}
    : {
        hardInputBudget: Math.floor(estimates.contextWindow - fixed),
        softTriggerTokens: Math.floor(estimates.contextWindow * input.policy.softTriggerRatio - fixed),
        targetTokens: Math.floor(estimates.contextWindow * input.policy.targetRatio - fixed),
      };
  const summaryMaxOutputTokens = Math.min(
    input.policy.summaryMaxOutputTokens,
    input.modelOutputLimit ?? input.policy.summaryMaxOutputTokens,
  );
  const summaryRetryMaxOutputTokens = Math.min(
    input.policy.summaryRetryMaxOutputTokens,
    input.modelOutputLimit ?? input.policy.summaryRetryMaxOutputTokens,
  );
  const summaryInputBudgets = estimates.contextWindow === undefined
    ? {}
    : {
        summaryMaxInputTokens: Math.max(
          0,
          Math.floor(
            estimates.contextWindow
            - input.policy.safetyMarginTokens
            - summaryMaxOutputTokens,
          ),
        ),
        summaryRetryMaxInputTokens: Math.max(
          0,
          Math.floor(
            estimates.contextWindow
            - input.policy.safetyMarginTokens
            - summaryRetryMaxOutputTokens,
          ),
        ),
      };
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    ...(estimates.contextWindow === undefined ? {} : { contextWindow: estimates.contextWindow }),
    reservedOutputTokens: input.reservedOutputTokens,
    safetyMarginTokens: input.policy.safetyMarginTokens,
    systemPromptTokens: estimates.systemPromptTokens,
    toolSchemaTokens: estimates.toolSchemaTokens,
    ...thresholds,
    rawHistoryTokens: estimates.rawHistoryTokens,
    checkpointTokens: estimates.checkpointTokens,
    safetyStateTokens: estimates.safetyStateTokens,
    estimatedInputTokens:
      estimates.systemPromptTokens
      + estimates.toolSchemaTokens
      + estimates.rawHistoryTokens
      + estimates.checkpointTokens
      + estimates.safetyStateTokens,
    summaryMaxOutputTokens,
    summaryRetryMaxOutputTokens,
    ...summaryInputBudgets,
  };
}

function findSafeCoverageIndices(input: ContextPlannerInput, runs: readonly Run[]): number[] {
  const latestAllowed = Math.min(
    runs.length - input.policy.minRawRuns - 1,
    runs.length - 2,
  );
  if (latestAllowed < 0) return [];
  const safe: number[] = [];
  let prefixSafe = true;
  for (let index = 0; index <= latestAllowed; index += 1) {
    prefixSafe = prefixSafe
      && isContextCoverageBoundarySafe({
        snapshot: input.snapshot,
        lineageRuns: runs,
        coverageIndex: index,
      });
    if (prefixSafe) safe.push(index);
  }
  return safe;
}

function evaluateCheckpointCandidate(
  checkpoint: ContextCheckpoint,
  checkpointsById: ReadonlyMap<string, ContextCheckpoint>,
  input: ContextPlannerInput,
  lineage: ResolvedContextLineage,
  safeCoverageIndices: readonly number[],
  safeSealedStepCursor: ContextCoverageCursor | undefined,
  safetyStateTokens: number,
  retainedModelInputTokens: number,
  targetTokens: number,
): CheckpointCandidateEvaluation {
  const reject = (
    reason: ContextCheckpointRejection["reason"],
  ): CheckpointCandidateEvaluation => ({
    rejection: { checkpointId: checkpoint.id, reason },
  });
  if (checkpoint.conversationId !== input.snapshot.conversation.id) {
    return reject("coverage_not_active_ancestor");
  }
  if (checkpoint.formatVersion !== CONTEXT_CHECKPOINT_FORMAT_VERSION) {
    return reject("unsupported_format");
  }
  if (
    checkpoint.compatibility.kind !== PROVIDER_NEUTRAL_CONTEXT_KIND
    || checkpoint.compatibility.version !== CONTEXT_CHECKPOINT_COMPATIBILITY_VERSION
    || checkpoint.safetyStateVersion !== RUNTIME_SAFETY_STATE_VERSION
  ) {
    return reject("unsupported_compatibility");
  }
  const coverageCursor = resolveContextCoverageCursor(checkpoint);
  const coverageRunId = contextCoverageRunId(coverageCursor);
  const coverageIndex = lineage.runs.findIndex((run) => run.id === coverageRunId);
  if (coverageIndex < 0) {
    return reject("coverage_not_active_ancestor");
  }
  const sealedCurrentRun = coverageCursor.kind === "sealed_step";
  const rawRuns = sealedCurrentRun
    ? [lineage.runs[coverageIndex]!]
    : lineage.runs.slice(coverageIndex + 1);
  if (!sealedCurrentRun && rawRuns.length < input.policy.minRawRuns) {
    return reject("raw_tail_too_short");
  }
  if (
    sealedCurrentRun
      ? coverageCursor.throughRequestIndex >= input.requestIndex
        || !isContextCoverageCursorSafe({
          snapshot: input.snapshot,
          lineageRuns: lineage.runs,
          cursor: coverageCursor,
        })
      : !safeCoverageIndices.includes(coverageIndex)
  ) {
    return reject("unsafe_coverage_boundary");
  }
  if (
    computeContextCoverageHash(lineage.runs, input.snapshot.messages, coverageCursor)
    !== checkpoint.lineageHash
  ) {
    return reject("lineage_hash_mismatch");
  }
  if (!isContextCheckpointParentChainUsable(checkpoint, checkpointsById, lineage.runs)) {
    return reject("dangling_parent");
  }
  const rawMessages = messagesForRuns(
    lineage,
    rawRuns,
    input.excludeAssistantMessageId,
  );
  const retainedTokensAreAfterCursor = coverageCursor.kind !== "sealed_step"
    || (input.retainedModelInput?.fromRequestIndex ?? 0)
      > coverageCursor.throughRequestIndex;
  const rawTokens = estimateMessagesTokens(rawMessages)
    + (retainedTokensAreAfterCursor ? retainedModelInputTokens : 0);
  const checkpointTokens = CONTEXT_ESTIMATOR_OVERHEAD.message
    + CONTEXT_ESTIMATOR_OVERHEAD.part
    + estimateTextTokens(checkpoint.summary);
  const candidate: CheckpointCandidate = {
    checkpoint,
    coverageIndex,
    coverageStepIndex: coverageCursor.kind === "sealed_step"
      ? coverageCursor.throughRequestIndex
      : Number.MAX_SAFE_INTEGER,
    rawRuns,
    rawMessages,
    rawTokens,
    checkpointTokens,
    contentTokens: rawTokens + checkpointTokens + safetyStateTokens,
  };
  return candidate.contentTokens <= targetTokens
    ? { candidate }
    : reject("target_budget_exceeded");
}

function createPlan(
  input: ContextPlannerInput,
  selection: {
    lineageRunIds: RunId[];
    rawRuns: Run[];
    view: "raw" | "checkpoint";
    reason: ContextPlan["reason"];
    checkpoint?: ContextCheckpoint;
    eligibleCoverageThroughRunId?: RunId;
    eligibleCoverageCursor?: ContextCoverageCursor;
    safetyState: RuntimeSafetyState;
    budget: ContextBudgetSnapshot;
    checkpointRejections?: ContextCheckpointRejection[];
  },
): ContextPlan {
  const rawRunIds = selection.rawRuns.map((run) => run.id);
  const requestHash = computeContextPlanRequestHash(input);
  const rawRange = rawRunIds.length === 0
    ? undefined
    : { fromRunId: rawRunIds[0]!, throughRunId: rawRunIds.at(-1)! };
  const stableView = {
    conversationId: input.snapshot.conversation.id,
    runId: input.runId,
    requestIndex: input.requestIndex,
    sourceHeadRunId: input.snapshot.conversation.activeHeadRunId!,
    sourceConversationRevision: input.snapshot.conversation.revision,
    trigger: input.trigger,
    providerId: input.providerId,
    modelId: input.modelId,
    policyVersion: input.policy.version,
    view: selection.view,
    reason: selection.reason,
    checkpointId: selection.checkpoint?.id,
    lineageRunIds: selection.lineageRunIds,
    rawRunIds,
    rawRange,
    eligibleCoverageThroughRunId: selection.eligibleCoverageThroughRunId,
    eligibleCoverageCursor: selection.eligibleCoverageCursor,
    safetyStateHash: selection.safetyState.hash,
    requestHash,
    budget: selection.budget,
    checkpointRejections: selection.checkpointRejections,
  };
  return {
    id: input.planId,
    conversationId: input.snapshot.conversation.id,
    runId: input.runId,
    requestIndex: input.requestIndex,
    sourceHeadRunId: input.snapshot.conversation.activeHeadRunId!,
    sourceConversationRevision: input.snapshot.conversation.revision,
    trigger: input.trigger,
    providerId: input.providerId,
    modelId: input.modelId,
    view: selection.view,
    reason: selection.reason,
    ...(selection.checkpoint ? { checkpointId: selection.checkpoint.id } : {}),
    lineageRunIds: selection.lineageRunIds,
    rawRunIds,
    ...(rawRange ? { rawRange } : {}),
    ...(selection.eligibleCoverageThroughRunId
      ? { eligibleCoverageThroughRunId: selection.eligibleCoverageThroughRunId }
      : {}),
    ...(selection.eligibleCoverageCursor
      ? { eligibleCoverageCursor: selection.eligibleCoverageCursor }
      : {}),
    ...(selection.checkpointRejections?.length
      ? { checkpointRejections: selection.checkpointRejections }
      : {}),
    safetyState: selection.safetyState,
    budget: selection.budget,
    requestHash,
    viewHash: `sha256:${createHash("sha256")
      .update(stableStringifyJson(stableView))
      .digest("hex")}`,
    time: { created: input.createdAt },
  };
}
