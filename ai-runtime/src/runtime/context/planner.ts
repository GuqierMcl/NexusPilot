import { createHash } from "node:crypto";
import type { AssistantMessage, Message, Run, RunId, UserMessage } from "../core/types";
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
  ContextPlan,
  ContextPlannerInput,
  RuntimeSafetyState,
} from "./types";
import { isContextCoverageBoundarySafe } from "./boundary-validation";

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

interface ResolvedContextLineage {
  runs: Run[];
  messagesByRun: Map<RunId, [UserMessage, AssistantMessage]>;
}

interface CheckpointCandidate {
  checkpoint: ContextCheckpoint;
  coverageIndex: number;
  rawRuns: Run[];
  rawMessages: Message[];
  rawTokens: number;
  checkpointTokens: number;
  contentTokens: number;
}

export type ContextPlanningErrorCode =
  "CONTEXT_HARD_BUDGET_EXCEEDED_WITHOUT_SAFE_BOUNDARY";

export class ContextPlanningError extends Error {
  constructor(readonly code: ContextPlanningErrorCode) {
    super("Context exceeds the hard input budget and has no safe compaction boundary");
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
    | "reservedOutputTokens"
    | "systemPrompt"
    | "toolSchemas"
    | "trigger"
    | "policy"
    | "safetyStateMaxTokens"
  >,
): string {
  const identity = {
    version: "1",
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
    safetyStateMaxTokens: input.safetyStateMaxTokens,
  };
  return `sha256:${createHash("sha256")
    .update(stableStringifyJson(identity))
    .digest("hex")}`;
}

export function planContextWindow(input: ContextPlannerInput): ContextPlan {
  assertPlannerInput(input);
  const lineage = resolveActiveLineage(input);
  const lineageRunIds = lineage.runs.map((run) => run.id);
  const fullMessages = messagesForRuns(lineage, lineage.runs);
  const safetyState = buildRuntimeSafetyState({
    conversationId: input.snapshot.conversation.id,
    activeRunIds: lineageRunIds,
    toolCalls: input.snapshot.toolCalls,
    permissions: input.snapshot.permissions,
    maxTokens: input.safetyStateMaxTokens,
  });
  const systemPromptTokens = estimateTextTokens(input.systemPrompt);
  const toolSchemaTokens = estimateJsonTokens(input.toolSchemas);
  const fullRawTokens = estimateMessagesTokens(fullMessages);
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
  if (
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
  const targetTokens = rawBudget.targetTokens ?? Number.NEGATIVE_INFINITY;
  const candidates = input.snapshot.checkpoints
    .map((checkpoint) => createCheckpointCandidate(
      checkpoint,
      input,
      lineage,
      safeCoverageIndices,
      safetyStateTokens,
    ))
    .filter((candidate): candidate is CheckpointCandidate =>
      candidate !== null && candidate.contentTokens <= targetTokens,
    )
    .sort((left, right) =>
      right.coverageIndex - left.coverageIndex
      || left.contentTokens - right.contentTokens
      || right.checkpoint.time.created - left.checkpoint.time.created
      || left.checkpoint.id.localeCompare(right.checkpoint.id),
    );
  const selected = candidates[0];
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
    });
  }

  const eligibleCoverageIndex = safeCoverageIndices.at(-1);
  if (eligibleCoverageIndex === undefined) {
    if (rawContentTokens <= rawBudget.hardInputBudget!) {
      return createPlan(input, {
        lineageRunIds,
        rawRuns: lineage.runs,
        view: "raw",
        reason: "raw_compaction_blocked",
        safetyState,
        budget: rawBudget,
      });
    }
    throw new ContextPlanningError(
      "CONTEXT_HARD_BUDGET_EXCEEDED_WITHOUT_SAFE_BOUNDARY",
    );
  }
  return createPlan(input, {
    lineageRunIds,
    rawRuns: lineage.runs,
    view: "raw",
    reason: "compaction_required",
    eligibleCoverageThroughRunId: lineage.runs[eligibleCoverageIndex]!.id,
    safetyState,
    budget: rawBudget,
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

function messagesForRuns(lineage: ResolvedContextLineage, runs: readonly Run[]): Message[] {
  return runs.flatMap((run) => {
    const messages = lineage.messagesByRun.get(run.id);
    if (!messages) {
      throw new Error(`Context planner Run messages are unavailable: ${run.id}`);
    }
    return messages;
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

function createCheckpointCandidate(
  checkpoint: ContextCheckpoint,
  input: ContextPlannerInput,
  lineage: ResolvedContextLineage,
  safeCoverageIndices: readonly number[],
  safetyStateTokens: number,
): CheckpointCandidate | null {
  if (
    checkpoint.conversationId !== input.snapshot.conversation.id
    || checkpoint.formatVersion !== CONTEXT_CHECKPOINT_FORMAT_VERSION
    || checkpoint.compatibility.kind !== PROVIDER_NEUTRAL_CONTEXT_KIND
    || checkpoint.compatibility.version !== CONTEXT_CHECKPOINT_COMPATIBILITY_VERSION
    || checkpoint.safetyStateVersion !== RUNTIME_SAFETY_STATE_VERSION
  ) {
    return null;
  }
  const coverageIndex = lineage.runs.findIndex(
    (run) => run.id === checkpoint.coverageThroughRunId,
  );
  if (!safeCoverageIndices.includes(coverageIndex)) {
    return null;
  }
  if (
    computeContextLineageHash(lineage.runs, checkpoint.coverageThroughRunId)
    !== checkpoint.lineageHash
  ) {
    return null;
  }
  const rawRuns = lineage.runs.slice(coverageIndex + 1);
  if (rawRuns.length < input.policy.minRawRuns) {
    return null;
  }
  const rawMessages = messagesForRuns(lineage, rawRuns);
  const rawTokens = estimateMessagesTokens(rawMessages);
  const checkpointTokens = CONTEXT_ESTIMATOR_OVERHEAD.message
    + CONTEXT_ESTIMATOR_OVERHEAD.part
    + estimateTextTokens(checkpoint.summary);
  return {
    checkpoint,
    coverageIndex,
    rawRuns,
    rawMessages,
    rawTokens,
    checkpointTokens,
    contentTokens: rawTokens + checkpointTokens + safetyStateTokens,
  };
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
    safetyState: RuntimeSafetyState;
    budget: ContextBudgetSnapshot;
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
    safetyStateHash: selection.safetyState.hash,
    requestHash,
    budget: selection.budget,
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
    safetyState: selection.safetyState,
    budget: selection.budget,
    requestHash,
    viewHash: `sha256:${createHash("sha256")
      .update(stableStringifyJson(stableView))
      .digest("hex")}`,
    time: { created: input.createdAt },
  };
}
