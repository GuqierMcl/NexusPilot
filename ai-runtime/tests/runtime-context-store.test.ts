import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openRuntimeDatabase } from "../src/storage/runtime-database";
import * as runtime from "../src/runtime";
import {
  RuntimeSqliteStore,
  type AssistantMessage,
  type ContextBudgetSnapshot,
  type ContextCheckpoint,
  type ContextPlan,
  type ContextPreparationClaim,
  type ContextUsage,
  type Conversation,
  type Run,
  type RunId,
  type UserMessage,
} from "../src/runtime";

function saveRunPair(
  store: RuntimeSqliteStore,
  input: {
    conversationId: Conversation["id"];
    runId: RunId;
    parentRunId?: RunId;
    created: number;
    status?: Run["status"];
  },
): void {
  const suffix = input.runId.slice("run_".length);
  const status = input.status ?? "completed";
  const userMessage: UserMessage = {
    id: `msg_user_${suffix}`,
    conversationId: input.conversationId,
    role: "user",
    agentMode: "ask",
    parts: [
      {
        id: `part_user_${suffix}`,
        conversationId: input.conversationId,
        messageId: `msg_user_${suffix}`,
        type: "text",
        text: `user ${suffix}`,
      },
    ],
    time: { created: input.created },
  };
  const assistantMessage: AssistantMessage = {
    id: `msg_assistant_${suffix}`,
    conversationId: input.conversationId,
    role: "assistant",
    runId: input.runId,
    parentId: userMessage.id,
    providerId: "openai",
    modelId: "gpt-4o",
    agentMode: "ask",
    status: status === "completed" ? { type: "complete" } : { type: "running" },
    parts: [
      {
        id: `part_assistant_${suffix}`,
        conversationId: input.conversationId,
        messageId: `msg_assistant_${suffix}`,
        type: "text",
        text: `assistant ${suffix}`,
      },
    ],
    time: { created: input.created + 1 },
  };
  const run: Run = {
    id: input.runId,
    conversationId: input.conversationId,
    parentRunId: input.parentRunId,
    parentMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    agentMode: "ask",
    providerId: "openai",
    modelId: "gpt-4o",
    status,
    input: { messageIds: [userMessage.id] },
    output: { messageId: assistantMessage.id, partIds: assistantMessage.parts.map((part) => part.id) },
    limits: { maxSteps: 1, maxToolCalls: 0, maxOutputTokens: 128 },
    time: {
      created: input.created,
      ...(status === "completed"
        ? { completed: input.created + 1 }
        : {}),
    },
  };

  store.saveMessage(userMessage);
  store.saveRun(run);
  store.saveMessage(assistantMessage);
}

function createHistory(
  store: RuntimeSqliteStore,
  id = "conv_context",
  runIds: readonly [RunId, RunId, RunId] = ["run_a", "run_b", "run_c"],
): Conversation {
  const conversation: Conversation = {
    id: id as Conversation["id"],
    title: "Context persistence",
    version: "1",
    status: { type: "idle" },
    activeHeadRunId: runIds[2],
    revision: 3,
    time: { created: 1, updated: 30 },
  };
  store.saveConversation(conversation);
  saveRunPair(store, { conversationId: conversation.id, runId: runIds[0], created: 10 });
  saveRunPair(store, {
    conversationId: conversation.id,
    runId: runIds[1],
    parentRunId: runIds[0],
    created: 20,
  });
  saveRunPair(store, {
    conversationId: conversation.id,
    runId: runIds[2],
    parentRunId: runIds[1],
    created: 30,
  });
  return conversation;
}

function lineageHashThrough(runId: "run_a" | "run_b" | "run_c"): string {
  const suffixes = ["a", "b", "c"];
  const end = suffixes.indexOf(runId.slice("run_".length)) + 1;
  const payload = {
    version: "1",
    lineage: suffixes.slice(0, end).map((suffix) => ({
      runId: `run_${suffix}`,
      userMessageId: `msg_user_${suffix}`,
      assistantMessageId: `msg_assistant_${suffix}`,
    })),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

const budget: ContextBudgetSnapshot = {
  providerId: "openai",
  modelId: "gpt-4o",
  contextWindow: 1_000,
  reservedOutputTokens: 128,
  safetyMarginTokens: 64,
  systemPromptTokens: 20,
  toolSchemaTokens: 10,
  hardInputBudget: 778,
  softTriggerTokens: 578,
  targetTokens: 348,
  rawHistoryTokens: 400,
  checkpointTokens: 0,
  safetyStateTokens: 12,
  estimatedInputTokens: 442,
};

function checkpoint(
  input: Partial<ContextCheckpoint> & Pick<ContextCheckpoint, "id" | "coverageThroughRunId">,
): ContextCheckpoint {
  const { id, coverageThroughRunId, ...overrides } = input;
  return {
    id,
    conversationId: "conv_context",
    coverageThroughRunId,
    sourceHeadRunId: "run_c",
    sourceConversationRevision: 3,
    lineageHash: lineageHashThrough(coverageThroughRunId as "run_a" | "run_b" | "run_c"),
    sourceStateHash: `sha256:${"2".repeat(64)}`,
    safetyStateHash: `sha256:${"3".repeat(64)}`,
    trigger: "auto_pre_turn",
    formatVersion: "1",
    compatibility: { kind: "provider-neutral-text", version: 1 },
    generatedBy: { providerId: "openai", modelId: "gpt-4o" },
    summary: `summary through ${coverageThroughRunId}`,
    safetyStateVersion: "1",
    budget,
    time: { created: id === "ckpt_1" ? 100 : 200 },
    ...overrides,
  };
}

function checkpointForStore(
  store: RuntimeSqliteStore,
  input: Partial<ContextCheckpoint> & Pick<ContextCheckpoint, "id" | "coverageThroughRunId">,
): ContextCheckpoint {
  const record = checkpoint(input);
  const conversation = store.getConversation(record.conversationId);
  if (!conversation || !record.sourceHeadRunId) throw new Error("Missing checkpoint fixture state");
  const runs = store.listRunsByConversation(record.conversationId);
  const lineage = store.listLineageRuns(record.conversationId, record.sourceHeadRunId);
  const toolCalls = runs.flatMap((run) => store.listToolCallsByRun(run.id));
  const permissions = runs.flatMap((run) => store.listPermissionsByRun(run.id));
  const safetyState = runtime.buildRuntimeSafetyState({
    conversationId: record.conversationId,
    activeRunIds: lineage.map((run) => run.id),
    toolCalls,
    permissions,
  });
  const parentCheckpoint = record.parentCheckpointId
    ? store.listContextCheckpoints(record.conversationId)
        .find((candidate) => candidate.id === record.parentCheckpointId)
    : undefined;
  const sourceState = runtime.computeContextCoverageSourceState({
    snapshot: {
      conversation,
      runs,
      messages: store.listTranscriptMessages(record.conversationId),
      toolCalls,
      permissions,
      checkpoints: store.listContextCheckpoints(record.conversationId),
    },
    lineageRuns: lineage,
    coverageIndex: lineage.findIndex((run) => run.id === record.coverageThroughRunId),
    safetyStateHash: safetyState.hash,
    parentCheckpoint,
  });
  if (!sourceState.safe) throw new Error("Checkpoint fixture boundary must be safe");
  return {
    ...record,
    sourceStateHash: sourceState.sourceStateHash,
    safetyStateHash: sourceState.safetyStateHash,
  };
}

function usage(id = "ctxuse_1"): ContextUsage {
  return {
    id: id as ContextUsage["id"],
    conversationId: "conv_context",
    runId: "run_c",
    requestIndex: 0,
    providerId: "openai",
    modelId: "gpt-4o",
    contextWindow: 1_000,
    estimatedInputTokens: 442,
    estimateSource: "estimate",
    reservedOutputTokens: 128,
    view: "raw",
    breakdown: {
      rawTokens: 400,
      checkpointTokens: 0,
      safetyStateTokens: 12,
      systemPromptTokens: 20,
      toolSchemaTokens: 10,
    },
    providerObservation: {
      source: "provider",
      inputTokens: 430,
      cacheReadTokens: 20,
      cacheWriteTokens: 2,
    },
    estimatorVersion: "utf8-bytes-v1",
    policyVersion: "1",
    checkpointFormatVersion: "1",
    time: { created: 300 },
  };
}

function nextTurnForecast(
  overrides: Partial<NonNullable<ContextUsage["nextTurnForecast"]>> = {},
): NonNullable<ContextUsage["nextTurnForecast"]> {
  return {
    conversationId: "conv_context",
    sourceHeadRunId: "run_c",
    sourceConversationRevision: 3,
    providerId: "openai",
    modelId: "gpt-4o",
    contextWindow: 1_000,
    estimatedInputTokens: 510,
    view: "raw",
    breakdown: {
      rawTokens: 468,
      checkpointTokens: 0,
      safetyStateTokens: 12,
      systemPromptTokens: 20,
      toolSchemaTokens: 10,
    },
    estimatorVersion: "utf8-bytes-v1",
    policyVersion: "1",
    checkpointFormatVersion: "1",
    reason: "append",
    ...overrides,
  };
}

function plan(id = "ctxplan_1"): ContextPlan {
  return {
    id: id as ContextPlan["id"],
    conversationId: "conv_context",
    runId: "run_c",
    requestIndex: 0,
    sourceHeadRunId: "run_c",
    sourceConversationRevision: 3,
    trigger: "auto_pre_turn",
    providerId: "openai",
    modelId: "gpt-4o",
    view: "raw",
    reason: "raw_within_budget",
    lineageRunIds: ["run_a", "run_b", "run_c"],
    rawRunIds: ["run_a", "run_b", "run_c"],
    rawRange: { fromRunId: "run_a", throughRunId: "run_c" },
    safetyState: {
      version: "1",
      conversationId: "conv_context",
      effects: [],
      permissions: [],
      hash: `sha256:${"0".repeat(64)}`,
    },
    budget,
    requestHash: `sha256:${"0".repeat(64)}`,
    viewHash: `sha256:${"1".repeat(64)}`,
    time: { created: 250 },
  };
}

function withPreparationClaim<T>(
  store: RuntimeSqliteStore,
  input: Pick<ContextPreparationClaim, "runId" | "requestIndex" | "requestHash">,
  operation: (claim: ContextPreparationClaim) => T,
): T {
  const result = store.claimContextPreparation({
    ...input,
    ownerId: `context-store-test-owner:${input.runId}:${input.requestIndex}`,
    ttlMs: 5 * 60 * 1_000,
  });
  if (result.status !== "acquired") {
    throw new Error(`Failed to acquire Context preparation test claim: ${result.status}`);
  }
  try {
    return operation(result.claim);
  } finally {
    store.releaseContextPreparationClaim(result.claim);
  }
}

function commitContextCheckpoint(
  store: RuntimeSqliteStore,
  checkpoint: ContextCheckpoint,
  eventId: `evt_${string}`,
): "committed" | "stale" {
  return withPreparationClaim(
    store,
    {
      runId: checkpoint.sourceHeadRunId,
      requestIndex: 0,
      requestHash: plan().requestHash,
    },
    (preparationClaim) => store.commitContextCheckpoint({
      checkpoint,
      eventId,
      preparationClaim,
    }),
  );
}

function saveContextPlan(store: RuntimeSqliteStore, record: ContextPlan): void {
  withPreparationClaim(
    store,
    {
      runId: record.runId,
      requestIndex: record.requestIndex,
      requestHash: record.requestHash,
    },
    (preparationClaim) => store.saveContextPlan({
      plan: record,
      eventId: `evt_plan_${record.id}`,
      preparationClaim,
    }),
  );
}

function readContextDiagnostics(db: ReturnType<typeof openRuntimeDatabase>): Array<{
  code: string;
  checkpoint_id: string | null;
  reason: string;
  details_json: string;
}> {
  const exists = db
    .query<{ found: number }, []>(
      `SELECT 1 AS found FROM sqlite_master
       WHERE type = 'table' AND name = 'runtime_context_diagnostics'`,
    )
    .get();
  if (!exists) return [];
  return db
    .query<{
      code: string;
      checkpoint_id: string | null;
      reason: string;
      details_json: string;
    }, []>(
      `SELECT code, checkpoint_id, reason, details_json
       FROM runtime_context_diagnostics
       ORDER BY created_at ASC, id ASC`,
    )
    .all();
}

describe("Runtime context schemas and persistence", () => {
  test("round-trips the versioned public context schemas", () => {
    const record = checkpoint({ id: "ckpt_1", coverageThroughRunId: "run_a" });

    expect(runtime.contextCheckpointSchema.parse(record)).toEqual(record);
    expect(runtime.contextPlanSchema.parse(plan())).toEqual(plan());
    expect(runtime.contextUsageSchema.parse(usage())).toEqual(usage());
    expect(runtime.runtimeSafetyStateSchema.parse(plan().safetyState)).toEqual(plan().safetyState);
  });

  test("validates raw and checkpoint next-turn forecast identities", () => {
    expect(() => runtime.contextUsageSchema.parse({
      ...usage(),
      nextTurnForecast: nextTurnForecast({ checkpointId: "ckpt_invalid" }),
    })).toThrow();
    expect(() => runtime.contextUsageSchema.parse({
      ...usage(),
      nextTurnForecast: nextTurnForecast({
        view: "checkpoint",
        checkpointId: undefined,
      }),
    })).toThrow();
    const checkpointForecast = nextTurnForecast({
      view: "checkpoint",
      checkpointId: "ckpt_valid",
      reason: "checkpoint_created",
    });
    expect(runtime.contextUsageSchema.parse({
      ...usage(),
      nextTurnForecast: checkpointForecast,
    }).nextTurnForecast).toEqual(checkpointForecast);
  });

  test("adds one immutable next-turn forecast without replacing Provider observation", () => {
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeSqliteStore(db);
    createHistory(store);
    store.saveContextUsage(usage());
    const forecast = nextTurnForecast();

    const updated = store.updateContextUsageNextTurnForecast({
      runId: "run_c",
      requestIndex: 0,
      nextTurnForecast: forecast,
    });
    expect(updated.providerObservation).toEqual(usage().providerObservation);
    expect(updated.nextTurnForecast).toEqual(forecast);
    expect(store.getLatestContextUsage("conv_context")).toEqual(updated);
    expect(store.updateContextUsageNextTurnForecast({
      runId: "run_c",
      requestIndex: 0,
      nextTurnForecast: forecast,
    })).toEqual(updated);
    expect(() => store.updateContextUsageNextTurnForecast({
      runId: "run_c",
      requestIndex: 0,
      nextTurnForecast: nextTurnForecast({ estimatedInputTokens: 511 }),
    })).toThrow("Next-turn context forecast is immutable");
    db.close();
  });

  test("persists append-only checkpoint chains, plans, usage, and unknown formats", () => {
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeSqliteStore(db);
    createHistory(store);
    const first = checkpointForStore(store, { id: "ckpt_1", coverageThroughRunId: "run_a" });
    expect(commitContextCheckpoint(store, first, "evt_ckpt_1")).toBe(
      "committed",
    );
    const second = checkpointForStore(store, {
      id: "ckpt_2",
      coverageThroughRunId: "run_b",
      parentCheckpointId: first.id,
    });
    expect(commitContextCheckpoint(store, second, "evt_ckpt_2")).toBe(
      "committed",
    );
    const future = checkpointForStore(store, {
      id: "ckpt_future",
      coverageThroughRunId: "run_b",
      parentCheckpointId: first.id,
      formatVersion: "future-9",
      compatibility: { kind: "future-binary", version: 9 },
      time: { created: 300 },
    });

    expect(commitContextCheckpoint(store, future, "evt_ckpt_future")).toBe(
      "committed",
    );
    saveContextPlan(store, plan());
    store.saveContextUsage(usage());

    expect(store.listContextCheckpoints("conv_context")).toEqual([first, second, future]);
    expect(store.getContextPlan("ctxplan_1")).toEqual(plan());
    expect(store.getContextPlanByRunRequest("run_c", 0)).toEqual(plan());
    expect(store.getContextPlanByRunRequest("run_c", 1)).toBeNull();
    expect(store.listContextPlansByRun("run_c")).toEqual([plan()]);
    expect(store.getLatestContextUsage("conv_context")).toEqual(usage());
    expect(() => saveContextPlan(store, { ...plan(), id: "ctxplan_duplicate" })).toThrow();
    expect(() => store.saveContextUsage({ ...usage(), id: "ctxuse_duplicate" })).toThrow();
    expect(store.listContextCheckpoints("conv_context")[2]?.compatibility).toEqual({
      kind: "future-binary",
      version: 9,
    });

    const checkpointEvent = store.listEvents("conv_context")[0];
    expect(checkpointEvent).toMatchObject({
      id: "evt_ckpt_1",
      type: "context.checkpoint.created",
      properties: {
        checkpointId: "ckpt_1",
        conversationId: "conv_context",
        sourceHeadRunId: "run_c",
        sourceConversationRevision: 3,
        coverageThroughRunId: "run_a",
        trigger: "auto_pre_turn",
        formatVersion: "1",
        compatibility: { kind: "provider-neutral-text", version: 1 },
      },
    });
    expect(JSON.stringify(checkpointEvent)).not.toContain(first.summary);
    expect(checkpointEvent?.properties).not.toHaveProperty("safetyState");
    expect(checkpointEvent?.properties).not.toHaveProperty("generatedBy");
    const planEvent = store.listEvents("conv_context").find(
      (event) => event.type === "context.plan.created",
    );
    expect(planEvent).toMatchObject({
      id: "evt_plan_ctxplan_1",
      type: "context.plan.created",
      properties: {
        planId: "ctxplan_1",
        conversationId: "conv_context",
        runId: "run_c",
        requestIndex: 0,
        sourceHeadRunId: "run_c",
        sourceConversationRevision: 3,
        view: "raw",
        reason: "raw_within_budget",
        trigger: "auto_pre_turn",
      },
    });
    expect(planEvent?.properties).not.toHaveProperty("safetyState");
    expect(JSON.stringify(planEvent)).not.toContain("effects");
    expect(store.listEvents("conv_context").filter(
      (event) => event.type === "context.plan.created",
    )).toHaveLength(1);
    db.close();
  });

  test("restores context facts after restart and cascades them on physical deletion", () => {
    const directory = mkdtempSync(join(tmpdir(), "nexuspilot-context-store-"));
    const path = join(directory, "runtime.sqlite");
    let db: ReturnType<typeof openRuntimeDatabase> | undefined;
    try {
      db = openRuntimeDatabase(path);
      let store = new RuntimeSqliteStore(db);
      createHistory(store);
      const saved = checkpointForStore(store, { id: "ckpt_1", coverageThroughRunId: "run_a" });
      commitContextCheckpoint(store, saved, "evt_ckpt_1");
      saveContextPlan(store, plan());
      store.saveContextUsage({ ...usage(), nextTurnForecast: nextTurnForecast() });
      Bun.gc(true);
      db.close(true);

      db = openRuntimeDatabase(path);
      store = new RuntimeSqliteStore(db);
      expect(store.listContextCheckpoints("conv_context")).toEqual([saved]);
      expect(store.listContextPlansByRun("run_c")).toEqual([plan()]);
      expect(store.getLatestContextUsage("conv_context")).toEqual({
        ...usage(),
        nextTurnForecast: nextTurnForecast(),
      });

      store.deleteConversation("conv_context");
      expect(store.listContextCheckpoints("conv_context")).toEqual([]);
      expect(store.getContextPlan("ctxplan_1")).toBeNull();
      expect(store.listContextPlansByRun("run_c")).toEqual([]);
      expect(store.getLatestContextUsage("conv_context")).toBeNull();
      Bun.gc(true);
      db.close(true);
      db = undefined;
    } finally {
      try {
        db?.close();
      } catch {
        // The successful path already closed the handle.
      }
      Bun.gc(true);
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  });

  test("audits checkpoint integrity and interrupted preparation safely at startup", () => {
    const directory = mkdtempSync(join(tmpdir(), "nexuspilot-context-integrity-"));
    const path = join(directory, "runtime.sqlite");
    let db: ReturnType<typeof openRuntimeDatabase> | undefined;
    try {
      db = openRuntimeDatabase(path);
      const store = new RuntimeSqliteStore(db);
      createHistory(store);
      const incompleteLineageConversation: Conversation = {
        id: "conv_startup_incomplete_lineage",
        title: "Incomplete startup lineage",
        version: "1",
        status: { type: "idle" },
        activeHeadRunId: "run_startup_incomplete_lineage",
        revision: 1,
        time: { created: 40, updated: 41 },
      };
      store.saveConversation(incompleteLineageConversation);
      store.saveRun({
        id: "run_startup_incomplete_lineage",
        conversationId: incompleteLineageConversation.id,
        agentMode: "ask",
        providerId: "openai",
        modelId: "gpt-4o",
        status: "completed",
        input: { messageIds: [] },
        limits: { maxSteps: 1, maxToolCalls: 0, maxOutputTokens: 128 },
        time: { created: 40, completed: 41 },
      });
      const valid = checkpointForStore(store, {
        id: "ckpt_startup_valid",
        coverageThroughRunId: "run_a",
        time: { created: 100 },
      });
      expect(commitContextCheckpoint(store, valid, "evt_startup_valid")).toBe("committed");
      const future = checkpointForStore(store, {
        id: "ckpt_startup_future",
        coverageThroughRunId: "run_b",
        parentCheckpointId: valid.id,
        formatVersion: "future-9",
        time: { created: 200 },
      });
      expect(commitContextCheckpoint(store, future, "evt_startup_future")).toBe("committed");
      expect(store.claimContextPreparation({
        runId: "run_c",
        requestIndex: 9,
        requestHash: `sha256:${"9".repeat(64)}`,
        ownerId: "interrupted-owner-secret",
        ttlMs: 5 * 60 * 1_000,
      }).status).toBe("acquired");
      Bun.gc(true);
      db.close(true);
      db = undefined;

      const rawDb = new Database(path);
      try {
        rawDb.exec("PRAGMA foreign_keys = OFF");
        const insertCheckpoint = rawDb.query(`
          INSERT INTO runtime_context_checkpoints (
            id, conversation_id, coverage_through_run_id, source_head_run_id,
            source_conversation_revision, parent_checkpoint_id, format_version,
            compatibility_kind, compatibility_version, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const validPayload = JSON.parse(JSON.stringify(valid)) as ContextCheckpoint;
        const danglingPayload = {
          ...future,
          id: "ckpt_startup_dangling",
          parentCheckpointId: "ckpt_missing_parent",
          formatVersion: "1",
          time: { created: 300 },
        } satisfies ContextCheckpoint;
        insertCheckpoint.run(
          danglingPayload.id,
          danglingPayload.conversationId,
          danglingPayload.coverageThroughRunId,
          danglingPayload.sourceHeadRunId,
          danglingPayload.sourceConversationRevision,
          danglingPayload.parentCheckpointId ?? null,
          danglingPayload.formatVersion,
          danglingPayload.compatibility.kind,
          danglingPayload.compatibility.version,
          JSON.stringify(danglingPayload),
          danglingPayload.time.created,
        );

        const incompleteLineagePayload = {
          ...validPayload,
          id: "ckpt_startup_incomplete_lineage",
          conversationId: incompleteLineageConversation.id,
          coverageThroughRunId: "run_startup_incomplete_lineage",
          sourceHeadRunId: "run_startup_incomplete_lineage",
          sourceConversationRevision: 1,
          time: { created: 250 },
        } satisfies ContextCheckpoint;
        insertCheckpoint.run(
          incompleteLineagePayload.id,
          incompleteLineagePayload.conversationId,
          incompleteLineagePayload.coverageThroughRunId,
          incompleteLineagePayload.sourceHeadRunId,
          incompleteLineagePayload.sourceConversationRevision,
          null,
          incompleteLineagePayload.formatVersion,
          incompleteLineagePayload.compatibility.kind,
          incompleteLineagePayload.compatibility.version,
          JSON.stringify(incompleteLineagePayload),
          incompleteLineagePayload.time.created,
        );

        const childOfFuturePayload = {
          ...validPayload,
          id: "ckpt_startup_child_of_future",
          coverageThroughRunId: "run_b",
          lineageHash: future.lineageHash,
          parentCheckpointId: future.id,
          time: { created: 275 },
        } satisfies ContextCheckpoint;
        insertCheckpoint.run(
          childOfFuturePayload.id,
          childOfFuturePayload.conversationId,
          childOfFuturePayload.coverageThroughRunId,
          childOfFuturePayload.sourceHeadRunId,
          childOfFuturePayload.sourceConversationRevision,
          childOfFuturePayload.parentCheckpointId,
          childOfFuturePayload.formatVersion,
          childOfFuturePayload.compatibility.kind,
          childOfFuturePayload.compatibility.version,
          JSON.stringify(childOfFuturePayload),
          childOfFuturePayload.time.created,
        );

        const missingCoveragePayload = {
          ...validPayload,
          id: "ckpt_startup_missing_coverage",
          coverageThroughRunId: "run_missing_coverage",
          time: { created: 400 },
        } as ContextCheckpoint;
        insertCheckpoint.run(
          missingCoveragePayload.id,
          missingCoveragePayload.conversationId,
          missingCoveragePayload.coverageThroughRunId,
          missingCoveragePayload.sourceHeadRunId,
          missingCoveragePayload.sourceConversationRevision,
          null,
          missingCoveragePayload.formatVersion,
          missingCoveragePayload.compatibility.kind,
          missingCoveragePayload.compatibility.version,
          JSON.stringify(missingCoveragePayload),
          missingCoveragePayload.time.created,
        );

        const badLineagePayload = {
          ...validPayload,
          id: "ckpt_startup_bad_lineage",
          lineageHash: `sha256:${"f".repeat(64)}`,
          time: { created: 500 },
        } satisfies ContextCheckpoint;
        insertCheckpoint.run(
          badLineagePayload.id,
          badLineagePayload.conversationId,
          badLineagePayload.coverageThroughRunId,
          badLineagePayload.sourceHeadRunId,
          badLineagePayload.sourceConversationRevision,
          null,
          badLineagePayload.formatVersion,
          badLineagePayload.compatibility.kind,
          badLineagePayload.compatibility.version,
          JSON.stringify(badLineagePayload),
          badLineagePayload.time.created,
        );

        insertCheckpoint.run(
          "ckpt_startup_malformed",
          "conv_context",
          "run_a",
          "run_c",
          3,
          null,
          "1",
          "provider-neutral-text",
          1,
          JSON.stringify({
            id: "ckpt_startup_malformed",
            summary: "STARTUP_SUMMARY_MUST_NOT_LEAK",
          }),
          600,
        );
      } finally {
        rawDb.close();
      }

      db = openRuntimeDatabase(path);
      let reopenedStore = new RuntimeSqliteStore(db);
      expect(reopenedStore.listContextCheckpoints("conv_context").map(({ id }) => id)).toEqual([
        "ckpt_startup_valid",
        "ckpt_startup_future",
      ]);
      expect(reopenedStore.listContextCheckpoints(incompleteLineageConversation.id)).toEqual([]);
      const firstDiagnostics = readContextDiagnostics(db);
      expect(firstDiagnostics.map(({ code, checkpoint_id, reason }) => ({
        code,
        checkpointId: checkpoint_id,
        reason,
      }))).toEqual(expect.arrayContaining([
        {
          code: "CHECKPOINT_STARTUP_WARNING",
          checkpointId: "ckpt_startup_future",
          reason: "unsupported_format",
        },
        {
          code: "CHECKPOINT_STARTUP_REJECTED",
          checkpointId: "ckpt_startup_incomplete_lineage",
          reason: "invalid_source_lineage",
        },
        {
          code: "CHECKPOINT_STARTUP_REJECTED",
          checkpointId: "ckpt_startup_child_of_future",
          reason: "dangling_parent",
        },
        {
          code: "CHECKPOINT_STARTUP_REJECTED",
          checkpointId: "ckpt_startup_dangling",
          reason: "dangling_parent",
        },
        {
          code: "CHECKPOINT_STARTUP_REJECTED",
          checkpointId: "ckpt_startup_missing_coverage",
          reason: "missing_coverage_run",
        },
        {
          code: "CHECKPOINT_STARTUP_REJECTED",
          checkpointId: "ckpt_startup_bad_lineage",
          reason: "lineage_hash_mismatch",
        },
        {
          code: "CHECKPOINT_STARTUP_REJECTED",
          checkpointId: "ckpt_startup_malformed",
          reason: "invalid_payload",
        },
        {
          code: "CONTEXT_PREPARATION_INTERRUPTED",
          checkpointId: null,
          reason: "interrupted_generation",
        },
      ]));
      expect(JSON.stringify(firstDiagnostics)).not.toContain("STARTUP_SUMMARY_MUST_NOT_LEAK");
      expect(JSON.stringify(firstDiagnostics)).not.toContain("interrupted-owner-secret");
      const firstDiagnosticCount = firstDiagnostics.length;
      Bun.gc(true);
      db.close(true);
      db = undefined;

      db = openRuntimeDatabase(path);
      reopenedStore = new RuntimeSqliteStore(db);
      expect(reopenedStore.listContextCheckpoints("conv_context")).toHaveLength(2);
      expect(readContextDiagnostics(db)).toHaveLength(firstDiagnosticCount);
      Bun.gc(true);
      db.close(true);
      db = undefined;
    } finally {
      try {
        db?.close();
      } catch {
        // The successful path already closed the handle.
      }
      Bun.gc(true);
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  });

  test("rejects stale checkpoint CAS without inserting a checkpoint or event", () => {
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeSqliteStore(db);
    const conversation = createHistory(store);
    const candidate = checkpointForStore(store, {
      id: "ckpt_stale",
      coverageThroughRunId: "run_a",
    });

    store.saveConversation({ ...conversation, revision: 4, time: { ...conversation.time, updated: 40 } });

    expect(commitContextCheckpoint(store, candidate, "evt_stale")).toBe(
      "stale",
    );
    expect(store.listContextCheckpoints(conversation.id)).toEqual([]);
    expect(store.listEvents(conversation.id)).toEqual([]);

    store.saveConversation({
      ...conversation,
      activeHeadRunId: "run_b",
      time: { ...conversation.time, updated: 50 },
    });
    expect(commitContextCheckpoint(store, candidate, "evt_stale_head")).toBe(
      "stale",
    );
    expect(store.listContextCheckpoints(conversation.id)).toEqual([]);
    expect(store.listEvents(conversation.id)).toEqual([]);
    expect(readContextDiagnostics(db).map((diagnostic) => ({
      code: diagnostic.code,
      checkpointId: diagnostic.checkpoint_id,
      reason: diagnostic.reason,
      details: JSON.parse(diagnostic.details_json),
    }))).toEqual([
      {
        code: "CHECKPOINT_CAS_CONFLICT",
        checkpointId: "ckpt_stale",
        reason: "source_revision_changed",
        details: {
          expectedHeadRunId: "run_c",
          expectedRevision: 3,
          actualHeadRunId: "run_c",
          actualRevision: 4,
          coverageThroughRunId: "run_a",
          trigger: "auto_pre_turn",
        },
      },
      {
        code: "CHECKPOINT_CAS_CONFLICT",
        checkpointId: "ckpt_stale",
        reason: "source_head_changed",
        details: {
          expectedHeadRunId: "run_c",
          expectedRevision: 3,
          actualHeadRunId: "run_b",
          actualRevision: 3,
          coverageThroughRunId: "run_a",
          trigger: "auto_pre_turn",
        },
      },
    ]);
    db.close();
  });

  test("validates checkpoint ancestry and lineage hash inside the commit transaction", () => {
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeSqliteStore(db);
    createHistory(store);
    const badHash = checkpointForStore(store, {
      id: "ckpt_bad_hash",
      coverageThroughRunId: "run_a",
      lineageHash: `sha256:${"f".repeat(64)}`,
    });

    expect(() => commitContextCheckpoint(store, badHash, "evt_bad_hash")).toThrow(
      "lineage hash",
    );
    expect(store.listContextCheckpoints("conv_context")).toEqual([]);
    expect(store.listEvents("conv_context")).toEqual([]);
    expect(readContextDiagnostics(db).map((diagnostic) => ({
      code: diagnostic.code,
      checkpointId: diagnostic.checkpoint_id,
      reason: diagnostic.reason,
      details: JSON.parse(diagnostic.details_json),
    }))).toEqual([{
      code: "CHECKPOINT_REJECTED",
      checkpointId: "ckpt_bad_hash",
      reason: "lineage_hash_mismatch",
      details: {
        sourceHeadRunId: "run_c",
        sourceConversationRevision: 3,
        coverageThroughRunId: "run_a",
        trigger: "auto_pre_turn",
      },
    }]);
    db.close();
  });

  test("rejects ContextUsage bound to a Run owned by another Conversation", () => {
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeSqliteStore(db);
    createHistory(store);
    store.saveConversation({
      id: "conv_foreign",
      title: "Foreign",
      version: "1",
      status: { type: "idle" },
      revision: 0,
      time: { created: 40, updated: 40 },
    });
    const foreignUsage: ContextUsage = {
      ...usage("ctxuse_foreign_run"),
      conversationId: "conv_foreign",
    };

    expect(() => store.saveContextUsage(foreignUsage)).toThrow("does not belong");
    expect(store.getLatestContextUsage("conv_foreign")).toBeNull();
    db.close();
  });

  test("rejects a ContextPlan bound to a Run owned by another Conversation", () => {
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeSqliteStore(db);
    createHistory(store);
    store.saveConversation({
      id: "conv_foreign",
      title: "Foreign",
      version: "1",
      status: { type: "idle" },
      revision: 0,
      time: { created: 40, updated: 40 },
    });
    const foreignPlan: ContextPlan = {
      ...plan("ctxplan_foreign_run"),
      conversationId: "conv_foreign",
      safetyState: {
        ...plan().safetyState,
        conversationId: "conv_foreign",
      },
    };

    expect(() => saveContextPlan(store, foreignPlan)).toThrow("does not belong");
    expect(store.getContextPlan(foreignPlan.id)).toBeNull();
    db.close();
  });

  test("validates a ContextPlan active head, source head, and selected checkpoint lineage", () => {
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeSqliteStore(db);
    createHistory(store);
    createHistory(store, "conv_foreign", [
      "run_foreign_a",
      "run_foreign_b",
      "run_foreign_c",
    ]);
    const localCheckpoint = checkpointForStore(store, {
      id: "ckpt_local",
      coverageThroughRunId: "run_a",
    });
    expect(commitContextCheckpoint(store, localCheckpoint, "evt_ckpt_local")).toBe("committed");
    const foreignCoverage = "run_foreign_a";
    const foreignCheckpoint = checkpointForStore(store, {
      id: "ckpt_foreign",
      conversationId: "conv_foreign",
      coverageThroughRunId: foreignCoverage,
      sourceHeadRunId: "run_foreign_c",
      lineageHash: runtime.computeContextLineageHash(
        store.listLineageRuns("conv_foreign", "run_foreign_c"),
        foreignCoverage,
      ),
      time: { created: 400 },
    });
    expect(commitContextCheckpoint(store, foreignCheckpoint, "evt_ckpt_foreign")).toBe(
      "committed",
    );

    const staleSource = {
      ...plan("ctxplan_stale_source"),
      requestIndex: 1,
      sourceHeadRunId: "run_b",
    } satisfies ContextPlan;
    expect(() => saveContextPlan(store, staleSource)).toThrow("source head");
    expect(store.getContextPlan(staleSource.id)).toBeNull();

    const inactiveRun = {
      ...plan("ctxplan_inactive_run"),
      runId: "run_b",
      requestIndex: 2,
      sourceHeadRunId: "run_b",
      lineageRunIds: ["run_a", "run_b"],
      rawRunIds: ["run_a", "run_b"],
      rawRange: { fromRunId: "run_a", throughRunId: "run_b" },
    } satisfies ContextPlan;
    expect(() => saveContextPlan(store, inactiveRun)).toThrow("active head");
    expect(store.getContextPlan(inactiveRun.id)).toBeNull();

    const crossConversationCheckpoint = {
      ...plan("ctxplan_foreign_checkpoint"),
      requestIndex: 3,
      view: "checkpoint",
      reason: "checkpoint_selected",
      checkpointId: foreignCheckpoint.id,
      rawRunIds: ["run_b", "run_c"],
      rawRange: { fromRunId: "run_b", throughRunId: "run_c" },
    } satisfies ContextPlan;
    expect(() => saveContextPlan(store, crossConversationCheckpoint)).toThrow(
      "does not belong",
    );
    expect(store.getContextPlan(crossConversationCheckpoint.id)).toBeNull();

    const inconsistentTail = {
      ...plan("ctxplan_inconsistent_tail"),
      requestIndex: 4,
      view: "checkpoint",
      reason: "checkpoint_selected",
      checkpointId: localCheckpoint.id,
      rawRunIds: ["run_c"],
      rawRange: { fromRunId: "run_c", throughRunId: "run_c" },
    } satisfies ContextPlan;
    expect(() => saveContextPlan(store, inconsistentTail)).toThrow("raw Run tail");
    expect(store.getContextPlan(inconsistentTail.id)).toBeNull();
    db.close();
  });

  test("arbitrates exact preparation claims and permits only expired same-request reclamation", () => {
    const db = openRuntimeDatabase(":memory:");
    let clock = 100;
    const store = new RuntimeSqliteStore(db, { now: () => clock });
    createHistory(store);
    const initialRequest = {
      runId: "run_c" as const,
      requestIndex: 0,
      requestHash: `sha256:${"a".repeat(64)}`,
      ownerId: "owner_first",
      ttlMs: 100,
    };
    const initialClaim: ContextPreparationClaim = {
      runId: initialRequest.runId,
      requestIndex: initialRequest.requestIndex,
      requestHash: initialRequest.requestHash,
      ownerId: initialRequest.ownerId,
      fencingToken: 1,
      claimedAt: 100,
      expiresAt: 200,
    };

    expect(store.claimContextPreparation(initialRequest)).toEqual({
      status: "acquired",
      claim: initialClaim,
    });
    clock = 150;
    expect(store.claimContextPreparation({
      ...initialRequest,
      ownerId: "owner_second",
    })).toEqual({ status: "in_progress", claim: initialClaim });
    expect(store.claimContextPreparation({
      ...initialRequest,
      requestHash: `sha256:${"b".repeat(64)}`,
      ownerId: "owner_conflict",
    })).toEqual({ status: "conflict", claim: initialClaim });

    clock = 200;
    const reclaimed = store.claimContextPreparation({
      ...initialRequest,
      ownerId: "owner_second",
    });
    expect(reclaimed).toEqual({
      status: "acquired",
      claim: {
        ...initialClaim,
        ownerId: "owner_second",
        fencingToken: 2,
        claimedAt: 200,
        expiresAt: 300,
      },
    });
    expect(store.releaseContextPreparationClaim({
      runId: initialRequest.runId,
      requestIndex: initialRequest.requestIndex,
      requestHash: initialRequest.requestHash,
      ownerId: "owner_first",
      fencingToken: initialClaim.fencingToken,
    })).toBe(false);
    if (reclaimed.status !== "acquired") throw new Error("Expected claim reclamation");
    expect(store.releaseContextPreparationClaim({
      runId: initialRequest.runId,
      requestIndex: initialRequest.requestIndex,
      requestHash: initialRequest.requestHash,
      ownerId: reclaimed.claim.ownerId,
      fencingToken: reclaimed.claim.fencingToken,
    })).toBe(true);
    expect(store.getContextPreparationClaim(
      initialRequest.runId,
      initialRequest.requestIndex,
    )).toBeNull();
    db.close();
  });

  test("renews only the unexpired exact preparation owner with the Store clock", () => {
    const db = openRuntimeDatabase(":memory:");
    let clock = 10;
    const store = new RuntimeSqliteStore(db, { now: () => clock });
    createHistory(store);
    const acquired = store.claimContextPreparation({
      runId: "run_c",
      requestIndex: 0,
      requestHash: `sha256:${"a".repeat(64)}`,
      ownerId: "owner-a",
      ttlMs: 100,
    });
    if (acquired.status !== "acquired") throw new Error("Expected initial claim");

    clock = 50;
    expect(store.renewContextPreparationClaim(acquired.claim, 100)).toBe(true);
    expect(store.getContextPreparationClaim("run_c", 0)).toEqual({
      ...acquired.claim,
      expiresAt: 150,
    });

    clock = 150;
    expect(store.renewContextPreparationClaim(acquired.claim, 100)).toBe(false);
    expect(store.getContextPreparationClaim("run_c", 0)?.expiresAt).toBe(150);
    db.close();
  });

  test("fences checkpoint, event, and plan writes from an expired superseded owner", () => {
    const db = openRuntimeDatabase(":memory:");
    let clock = 100;
    const store = new RuntimeSqliteStore(db, { now: () => clock });
    createHistory(store);
    const request = {
      runId: "run_c" as const,
      requestIndex: 0,
      requestHash: plan().requestHash,
      ttlMs: 100,
    };
    const oldOwner = store.claimContextPreparation({
      ...request,
      ownerId: "owner_old",
    });
    if (oldOwner.status !== "acquired") throw new Error("Expected old owner claim");
    clock = 200;
    const winner = store.claimContextPreparation({
      ...request,
      ownerId: "owner_winner",
    });
    if (winner.status !== "acquired") throw new Error("Expected winning owner claim");
    const candidate = checkpointForStore(store, {
      id: "ckpt_fenced",
      coverageThroughRunId: "run_a",
    });

    expect(store.renewContextPreparationClaim(oldOwner.claim, 100)).toBe(false);
    expect(store.renewContextPreparationClaim(winner.claim, 100)).toBe(true);
    expect(store.getContextPreparationClaim("run_c", 0)).toMatchObject({
      ownerId: winner.claim.ownerId,
      fencingToken: winner.claim.fencingToken,
    });

    expect(() => store.commitContextCheckpoint({
      checkpoint: candidate,
      eventId: "evt_fenced",
      preparationClaim: oldOwner.claim,
    })).toThrow(runtime.ContextPreparationLeaseLostError);
    expect(() => store.saveContextPlan({
      plan: plan("ctxplan_fenced"),
      eventId: "evt_plan_fenced_old",
      preparationClaim: oldOwner.claim,
    })).toThrow(runtime.ContextPreparationLeaseLostError);
    expect(store.listContextCheckpoints("conv_context")).toEqual([]);
    expect(store.listEvents("conv_context")).toEqual([]);
    expect(store.listContextPlansByRun("run_c")).toEqual([]);

    expect(store.commitContextCheckpoint({
      checkpoint: candidate,
      eventId: "evt_fenced",
      preparationClaim: winner.claim,
    })).toBe("committed");
    store.saveContextPlan({
      plan: plan("ctxplan_fenced"),
      eventId: "evt_plan_fenced_winner",
      preparationClaim: winner.claim,
    });
    expect(store.listContextCheckpoints("conv_context")).toEqual([candidate]);
    expect(store.listEvents("conv_context").map((event) => event.type)).toEqual([
      "context.checkpoint.created",
      "context.plan.created",
    ]);
    expect(store.listContextPlansByRun("run_c")).toHaveLength(1);
    expect(store.releaseContextPreparationClaim(oldOwner.claim)).toBe(false);
    expect(store.releaseContextPreparationClaim(winner.claim)).toBe(true);
    db.close();
  });

  test("persists preparation claims across Store restart until release or expiry", () => {
    const directory = mkdtempSync(join(tmpdir(), "nexuspilot-context-claim-"));
    const path = join(directory, "runtime.sqlite");
    let db: ReturnType<typeof openRuntimeDatabase> | undefined;
    let clock = 100;
    try {
      db = openRuntimeDatabase(path);
      let store = new RuntimeSqliteStore(db, { now: () => clock });
      createHistory(store);
      const request = {
        runId: "run_c" as const,
        requestIndex: 1,
        requestHash: `sha256:${"c".repeat(64)}`,
        ownerId: "owner_before_restart",
        ttlMs: 100,
      };
      const acquired = store.claimContextPreparation(request);
      expect(acquired.status).toBe("acquired");
      if (acquired.status !== "acquired") throw new Error("Expected initial claim acquisition");
      db.close(true);

      db = openRuntimeDatabase(path);
      store = new RuntimeSqliteStore(db, { now: () => clock });
      expect(store.getContextPreparationClaim(request.runId, request.requestIndex)).toEqual(
        acquired.claim,
      );
      clock = 150;
      expect(store.claimContextPreparation({
        ...request,
        ownerId: "owner_after_restart",
      }).status).toBe("in_progress");
      clock = 200;
      const reclaimed = store.claimContextPreparation({
        ...request,
        ownerId: "owner_after_expiry",
      });
      expect(reclaimed.status).toBe("acquired");
      expect(reclaimed.status === "acquired" ? reclaimed.claim.fencingToken : 0).toBe(2);
      db.close(true);
      db = undefined;
    } finally {
      try {
        db?.close(true);
      } catch {
        // The successful path already closed the handle.
      }
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  });
});
