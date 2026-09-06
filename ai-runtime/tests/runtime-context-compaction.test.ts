import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import { generateRuntimeContextSummary } from "../src/app";

import {
  ContextCompactionService,
  ContextPlanningError,
  ContextPreparationLeaseLostError,
  ContextPreparationStaleError,
  ContextSummaryValidationError,
  CONTEXT_ESTIMATOR_OVERHEAD,
  DEFAULT_CONTEXT_COMPACTION_POLICY,
  buildContextSummaryPrompt,
  buildRuntimeSafetyState,
  computeContextPlanRequestHash,
  ModelContextManager,
  RuntimeAttachmentSqliteStore,
  RuntimeSqliteStore,
  type AssistantMessage,
  type ContextCompactionRequest,
  type ContextCompactionResult,
  type ContextPreparationClaim,
  type ModelContextPreparationInput,
  type ContextSummaryGenerator,
  type Conversation,
  type Part,
  type Run,
  type RunId,
  type RuntimeId,
  type RuntimeIdPrefix,
  type RuntimeAttachmentService,
  type RuntimeRunnerStore,
  type RuntimeSqliteStoreOptions,
  type ToolCall,
  type ToolPart,
  type UserMessage,
} from "../src/runtime";
import { openRuntimeDatabase } from "../src/storage/runtime-database";

function saveRunPair(
  store: RuntimeSqliteStore,
  input: {
    conversationId: Conversation["id"];
    runId: RunId;
    parentRunId?: RunId;
    created: number;
    status: Run["status"];
    userText: string;
    assistantText: string;
  },
): void {
  const suffix = input.runId.slice("run_".length);
  const userMessage: UserMessage = {
    id: `msg_user_${suffix}`,
    conversationId: input.conversationId,
    role: "user",
    agentMode: "ask",
    parts: [{
      id: `part_user_${suffix}`,
      conversationId: input.conversationId,
      messageId: `msg_user_${suffix}`,
      type: "text",
      text: input.userText,
    }],
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
    status: input.status === "completed" ? { type: "complete" } : { type: "running" },
    parts: [{
      id: `part_assistant_${suffix}`,
      conversationId: input.conversationId,
      messageId: `msg_assistant_${suffix}`,
      type: "text",
      text: input.assistantText,
    }],
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
    status: input.status,
    input: { messageIds: [userMessage.id] },
    output: { messageId: assistantMessage.id, partIds: assistantMessage.parts.map((part) => part.id) },
    limits: { maxSteps: 1, maxToolCalls: 0, maxOutputTokens: 128 },
    time: {
      created: input.created,
      ...(input.status === "completed" ? { completed: input.created + 1 } : {}),
    },
  };

  store.saveMessage(userMessage);
  store.saveRun(run);
  store.saveMessage(assistantMessage);
}

function createHistory(
  path = ":memory:",
  storeOptions: RuntimeSqliteStoreOptions = {},
): {
  db: ReturnType<typeof openRuntimeDatabase>;
  store: RuntimeSqliteStore;
  conversation: Conversation;
} {
  const db = openRuntimeDatabase(path);
  const store = new RuntimeSqliteStore(db, storeOptions);
  const conversation: Conversation = {
    id: "conv_compaction",
    title: "Compaction",
    version: "1",
    status: { type: "busy", runId: "run_c" },
    activeHeadRunId: "run_c",
    revision: 3,
    time: { created: 1, updated: 30 },
  };
  store.saveConversation(conversation);
  saveRunPair(store, {
    conversationId: conversation.id,
    runId: "run_a",
    created: 10,
    status: "completed",
    userText: `OLD_USER_${"x".repeat(1_200)}`,
    assistantText: `OLD_ASSISTANT_${"y".repeat(1_200)}`,
  });
  saveRunPair(store, {
    conversationId: conversation.id,
    runId: "run_b",
    parentRunId: "run_a",
    created: 20,
    status: "completed",
    userText: "recent user",
    assistantText: "recent assistant",
  });
  saveRunPair(store, {
    conversationId: conversation.id,
    runId: "run_c",
    parentRunId: "run_b",
    created: 30,
    status: "running",
    userText: "CURRENT_USER_MUST_STAY_RAW",
    assistantText: "",
  });
  return { db, store, conversation };
}

function expectCompactionAttempts(
  store: RuntimeSqliteStore,
  expected: readonly {
    attemptIndex: number;
    status: "created" | "failed" | "recovered" | "interrupted";
  }[],
): void {
  const activities = store
    .listContextCompactionActivities("conv_compaction")
    .toSorted((left, right) => left.attemptIndex - right.attemptIndex);
  expect(activities.map((activity) => ({
    attemptIndex: activity.attemptIndex,
    status: activity.status,
  }))).toEqual([...expected]);

  const activityEvents = store
    .listEvents("conv_compaction")
    .filter((event) => event.type === "context.compaction.updated");
  for (const activity of activities) {
    const statuses = activityEvents.flatMap((event) =>
      event.properties.info.id === activity.id
        ? [event.properties.info.status]
        : []
    ).sort();
    const expectedStatuses: Array<typeof activity.status> = ["preparing", activity.status];
    expect(statuses).toEqual(expectedStatuses.sort());
  }
}

function expectEventTypeCount(
  store: RuntimeSqliteStore,
  type: ReturnType<RuntimeSqliteStore["listEvents"]>[number]["type"],
  count: number,
): void {
  expect(store.listEvents("conv_compaction").filter((event) => event.type === type)).toHaveLength(
    count,
  );
}

function persistCompletedToolPair(store: RuntimeSqliteStore): ToolCall {
  const run = store.getRun("run_a");
  const assistant = store.getMessage("msg_assistant_a");
  if (!run || !assistant || assistant.role !== "assistant") {
    throw new Error("Missing completed Run fixture");
  }
  const part: ToolPart = {
    id: "part_tool_a",
    conversationId: run.conversationId,
    messageId: assistant.id,
    type: "tool",
    toolCallId: "tool_a",
    toolName: "sql.execute",
    state: {
      status: "completed",
      input: {},
      output: { data: { rowsAffected: 1 } },
      title: "Execute SQL",
      time: { start: 10, end: 11 },
    },
  };
  store.saveMessage({ ...assistant, parts: [...assistant.parts, part] });
  store.saveRun({
    ...run,
    output: {
      messageId: assistant.id,
      partIds: [...run.output!.partIds, part.id],
    },
  });
  const toolCall: ToolCall = {
    id: part.toolCallId,
    conversationId: run.conversationId,
    runId: run.id,
    messageId: assistant.id,
    partId: part.id,
    toolName: part.toolName,
    input: {},
    state: "completed",
    result: { ok: true, summary: "SQL completed", data: { rowsAffected: 1 } },
    time: { created: 10, started: 10, completed: 11 },
  };
  store.saveToolCall(toolCall);
  return toolCall;
}

function estimateSummaryGeneratorInputTokens(
  input: Parameters<ContextSummaryGenerator>[0],
): number {
  const framedText = (text: string): number =>
    CONTEXT_ESTIMATOR_OVERHEAD.message
    + CONTEXT_ESTIMATOR_OVERHEAD.part
    + Math.ceil(Buffer.byteLength(text, "utf8") / 3);
  const instructionMessages = typeof input.instructions === "string"
    ? [{ role: "system" as const, content: input.instructions }]
    : Array.isArray(input.instructions)
      ? input.instructions
      : [input.instructions];
  return instructionMessages.reduce((total, instruction) => {
    if (typeof instruction.content !== "string") {
      throw new Error("Summary instructions test expects string-only content");
    }
    return total + framedText(instruction.content);
  }, 0)
    + input.messages.reduce((total, message) => {
      if (typeof message.content !== "string") {
        throw new Error("Summary source test expects string-only ModelMessages");
      }
      return total + framedText(message.content);
    }, 0);
}

function deterministicIds(): <TPrefix extends RuntimeIdPrefix>(prefix: TPrefix) => RuntimeId<TPrefix> {
  let next = 0;
  return <TPrefix extends RuntimeIdPrefix>(prefix: TPrefix): RuntimeId<TPrefix> =>
    `${prefix}_generated_${next += 1}` as RuntimeId<TPrefix>;
}

type ContextCompactionRequestWithoutClaim = Omit<
  ContextCompactionRequest,
  "preparationClaim"
>;

function request(
  trigger: "manual" | "auto_pre_turn",
  overrides: Partial<ContextCompactionRequestWithoutClaim> = {},
): ContextCompactionRequestWithoutClaim {
  return {
    conversationId: "conv_compaction",
    expectedHeadRunId: "run_c",
    expectedConversationRevision: 3,
    runId: "run_c",
    requestIndex: 0,
    providerId: "openai",
    modelId: "gpt-4o",
    model: new MockLanguageModelV3(),
    contextWindow: 4_096,
    reservedOutputTokens: 0,
    systemPrompt: "runtime system prompt",
    toolSchemas: { sql: { input: "schema" } },
    trigger,
    candidateCoverageThroughRunId: "run_a",
    policy: {
      ...DEFAULT_CONTEXT_COMPACTION_POLICY,
      safetyMarginTokens: 0,
      softTriggerRatio: 0.2,
      targetRatio: 0.1,
    },
    ...overrides,
  };
}

async function compactClaimed(
  store: RuntimeRunnerStore,
  service: ContextCompactionService,
  input: ContextCompactionRequestWithoutClaim,
): Promise<ContextCompactionResult> {
  const result = store.claimContextPreparation({
    runId: input.runId,
    requestIndex: input.requestIndex,
    requestHash: computeContextPlanRequestHash(input),
    ownerId: "context-compaction-test-owner",
    ttlMs: 5 * 60 * 1_000,
  });
  if (result.status !== "acquired") {
    throw new Error(`Failed to acquire Context preparation test claim: ${result.status}`);
  }
  try {
    return await service.compact({ ...input, preparationClaim: result.claim });
  } finally {
    store.releaseContextPreparationClaim(result.claim);
  }
}

function preparation(
  trigger: "manual" | "auto_pre_turn" | "auto_mid_turn" = "auto_pre_turn",
  overrides: Partial<ModelContextPreparationInput> = {},
): ModelContextPreparationInput {
  return {
    conversationId: "conv_compaction",
    runId: "run_c",
    requestIndex: 0,
    providerId: "openai",
    modelId: "gpt-4o",
    model: new MockLanguageModelV3(),
    contextWindow: 4_096,
    reservedOutputTokens: 0,
    systemPrompt: "runtime system prompt",
    toolSchemas: { sql: { input: "schema" } },
    trigger,
    policy: {
      ...DEFAULT_CONTEXT_COMPACTION_POLICY,
      safetyMarginTokens: 0,
      softTriggerRatio: 0.2,
      targetRatio: 0.1,
    },
    ...overrides,
  };
}

describe("ContextCompactionService", () => {
  test("ends summary prompts with a user request for models that stop after assistant history", async () => {
    const { db, store } = createHistory();
    try {
      const model = new MockLanguageModelV3({
        doGenerate: async ({ prompt }) => {
          const terminalRole = prompt.at(-1)?.role;
          const emitsCheckpoint = terminalRole === "user";
          return {
            content: emitsCheckpoint
              ? [{ type: "text" as const, text: "Provider-neutral checkpoint" }]
              : [],
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage: {
              inputTokens: {
                total: 100,
                noCache: 100,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: {
                total: emitsCheckpoint ? 4 : 0,
                text: emitsCheckpoint ? 4 : 0,
                reasoning: 0,
              },
            },
            warnings: [],
          };
        },
      });
      const service = new ContextCompactionService({
        store,
        generator: generateRuntimeContextSummary,
        createId: deterministicIds(),
      });

      const result = await compactClaimed(
        store,
        service,
        request("manual", { model }),
      );

      expect(result.status).toBe("created");
    } finally {
      db.close();
    }
  });

  test("preserves reasoning-only length diagnostics from the production summary adapter", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "reasoning" as const, text: "internal reasoning consumed the budget" }],
        finishReason: { unified: "length" as const, raw: "max_tokens" },
        usage: {
          inputTokens: {
            total: 100,
            noCache: 100,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 2_048, text: 0, reasoning: 2_048 },
        },
        warnings: [],
      }),
    });

    const result = await generateRuntimeContextSummary({
      model,
      instructions: "Summarize safely",
      messages: [{ role: "user", content: "long context" }],
      maxOutputTokens: 2_048,
    });

    expect(result).toMatchObject({
      text: "",
      finishReason: "length",
      usage: {
        outputTokens: 2_048,
        outputTokenDetails: { textTokens: 0, reasoningTokens: 2_048 },
      },
    });
    expect(JSON.stringify(result)).not.toContain("internal reasoning consumed the budget");
  });

  test("passes summary policy and Safety State through generateText instructions", async () => {
    const { db, store } = createHistory();
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: "Provider-neutral checkpoint" }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: {
            total: 32,
            noCache: 32,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 4, text: 4, reasoning: 0 },
        },
        warnings: [],
      }),
    });
    const service = new ContextCompactionService({
      store,
      generator: generateRuntimeContextSummary,
      createId: deterministicIds(),
    });

    const result = await compactClaimed(
      store,
      service,
      request("manual", { model }),
    );

    expect(result.status).toBe("created");
    expect(model.doGenerateCalls.length).toBeGreaterThan(0);
    const providerPrompt = model.doGenerateCalls[0]?.prompt ?? [];
    expect(JSON.stringify(providerPrompt.filter((message) => message.role === "system")))
      .toContain("Runtime Safety State");
    expect(JSON.stringify(providerPrompt.filter((message) => message.role !== "system")))
      .toContain("OLD_USER_");
    db.close();
  });

  test.each(["manual", "auto_pre_turn"] as const)(
    "%s uses the single service path, excludes the current Run, and offers no tools",
    async (trigger) => {
      const { db, store } = createHistory();
      const generatorInputs: Parameters<ContextSummaryGenerator>[0][] = [];
      const generator: ContextSummaryGenerator = async (input) => {
        generatorInputs.push(input);
        return trigger === "manual"
          ? { text: "The earlier goal and confirmed constraint remain active." }
          : {
              text: "The earlier goal and confirmed constraint remain active.",
              usage: {
                inputTokens: undefined,
                inputTokenDetails: {
                  noCacheTokens: undefined,
                  cacheReadTokens: undefined,
                  cacheWriteTokens: undefined,
                },
                outputTokens: undefined,
                outputTokenDetails: {
                  textTokens: undefined,
                  reasoningTokens: undefined,
                },
                totalTokens: undefined,
              },
            };
      };
      const service = new ContextCompactionService({
        store,
        generator,
        now: () => 100,
        createId: deterministicIds(),
      });
      const transcriptBefore = structuredClone(store.listTranscriptMessages("conv_compaction"));
      const runsBefore = structuredClone(store.listRunsByConversation("conv_compaction"));

      const result = await compactClaimed(store, service, request(trigger));

      expect(result.status).toBe("created");
      if (result.status !== "created") throw new Error("Expected checkpoint creation");
      expect(result.checkpoint.trigger).toBe(trigger);
      expect(result.checkpoint.coverageThroughRunId).toBe("run_a");
      expect(generatorInputs).toHaveLength(1);
      expect(generatorInputs[0]?.maxOutputTokens).toBe(2_048);
      expect(generatorInputs[0]).not.toHaveProperty("tools");
      expect(JSON.stringify(generatorInputs[0]?.messages)).toContain("OLD_USER_");
      expect(JSON.stringify(generatorInputs[0]?.messages)).not.toContain(
        "CURRENT_USER_MUST_STAY_RAW",
      );
      expect(store.listTranscriptMessages("conv_compaction")).toEqual(transcriptBefore);
      expect(store.listRunsByConversation("conv_compaction")).toEqual(runsBefore);
      expect(store.listContextCheckpoints("conv_compaction")).toEqual([result.checkpoint]);
      expect(result.checkpoint.usage).toMatchObject({
        purpose: "checkpoint_summary",
        summaryInvocationCount: 1,
        providerId: "openai",
        modelId: "gpt-4o",
        estimatedInputTokens: estimateSummaryGeneratorInputTokens(generatorInputs[0]!),
        estimateSource: "estimate",
        reservedOutputTokens: 2_048,
        view: "raw",
      });
      expect(result.checkpoint.usage).not.toHaveProperty("providerObservation");
      db.close();
    },
  );

  test("persists one summary invocation usage without mutating cumulative Run usage", async () => {
    const { db, store } = createHistory();
    const generatorInputs: Parameters<ContextSummaryGenerator>[0][] = [];
    const service = new ContextCompactionService({
      store,
      generator: async (input) => {
        generatorInputs.push(input);
        return {
          text: "The earlier goal remains active.",
          usage: {
            inputTokens: 120,
            inputTokenDetails: {
              noCacheTokens: 100,
              cacheReadTokens: 15,
              cacheWriteTokens: 5,
            },
            outputTokens: 30,
            outputTokenDetails: { textTokens: 24, reasoningTokens: 6 },
            totalTokens: 150,
          },
        };
      },
      now: () => 100,
      createId: deterministicIds(),
    });

    const result = await compactClaimed(store, service, request("manual"));

    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("Expected checkpoint creation");
    expect(generatorInputs).toHaveLength(1);
    expect(result.checkpoint.usage).toMatchObject({
      conversationId: "conv_compaction",
      runId: "run_c",
      requestIndex: 0,
      providerId: "openai",
      modelId: "gpt-4o",
      contextWindow: 4_096,
      purpose: "checkpoint_summary",
      summaryInvocationCount: 1,
      estimatedInputTokens: estimateSummaryGeneratorInputTokens(generatorInputs[0]!),
      estimateSource: "estimate",
      reservedOutputTokens: 2_048,
      view: "raw",
      providerObservation: {
        source: "provider",
        observedInvocationCount: 1,
        inputTokens: 120,
        outputTokens: 30,
        reasoningTokens: 6,
        cacheReadTokens: 15,
        cacheWriteTokens: 5,
        totalTokens: 150,
      },
    });
    const breakdown = result.checkpoint.usage?.breakdown;
    expect(
      (breakdown?.rawTokens ?? 0)
      + (breakdown?.checkpointTokens ?? 0)
      + (breakdown?.safetyStateTokens ?? 0)
      + (breakdown?.systemPromptTokens ?? 0)
      + (breakdown?.toolSchemaTokens ?? 0),
    ).toBe(result.checkpoint.usage?.estimatedInputTokens ?? 0);
    expect(store.getRun("run_c")?.usage).toBeUndefined();
    expect(store.listContextCheckpoints("conv_compaction")[0]?.usage).toEqual(
      result.checkpoint.usage,
    );
    db.close();
  });

  test("aggregates every rolling summary usage deterministically", async () => {
    const { db, store } = createHistory();
    const user = store.getMessage("msg_user_a");
    if (!user || user.role !== "user") throw new Error("Missing User fixture");
    store.saveMessage({
      ...user,
      parts: [{
        ...user.parts[0]!,
        type: "text",
        text: `BEGIN_${Array.from({ length: 4_000 }, (_, index) =>
          `${index.toString().padStart(4, "0")}🙂`).join("")}_END`,
      }],
    });
    const generatorInputs: Parameters<ContextSummaryGenerator>[0][] = [];
    const service = new ContextCompactionService({
      store,
      generator: async (input) => {
        generatorInputs.push(input);
        return {
          text: `ROLLING_USAGE_${generatorInputs.length}`,
          usage: {
            inputTokens: 10,
            inputTokenDetails: {
              noCacheTokens: 7,
              cacheReadTokens: 2,
              cacheWriteTokens: 1,
            },
            outputTokens: 3,
            outputTokenDetails: { textTokens: 2, reasoningTokens: 1 },
            totalTokens: 13,
          },
        };
      },
      now: () => 100,
      createId: deterministicIds(),
    });

    const result = await compactClaimed(store, service, request("manual"));

    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("Expected checkpoint creation");
    expect(generatorInputs.length).toBeGreaterThan(1);
    const invocationCount = generatorInputs.length;
    expect(result.checkpoint.usage).toMatchObject({
      purpose: "checkpoint_summary",
      summaryInvocationCount: invocationCount,
      estimatedInputTokens: generatorInputs.reduce(
        (total, input) => total + estimateSummaryGeneratorInputTokens(input),
        0,
      ),
      reservedOutputTokens: 2_048 * invocationCount,
      view: "raw",
      providerObservation: {
        source: "provider",
        observedInvocationCount: invocationCount,
        inputTokens: 10 * invocationCount,
        outputTokens: 3 * invocationCount,
        reasoningTokens: invocationCount,
        cacheReadTokens: 2 * invocationCount,
        cacheWriteTokens: invocationCount,
        totalTokens: 13 * invocationCount,
      },
    });
    db.close();
  });

  test("retries strict reasoning-only length exhaustion once with a larger output budget", async () => {
    const { db, store } = createHistory();
    const outputBudgets: number[] = [];
    const estimatedInputs: number[] = [];
    const service = new ContextCompactionService({
      store,
      generator: async (input) => {
        outputBudgets.push(input.maxOutputTokens);
        estimatedInputs.push(estimateSummaryGeneratorInputTokens(input));
        if (outputBudgets.length === 1) {
          return {
            text: "",
            finishReason: "length",
            usage: {
              inputTokens: 100,
              inputTokenDetails: {
                noCacheTokens: 100,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
              outputTokens: 2_048,
              outputTokenDetails: { textTokens: 0, reasoningTokens: 2_048 },
              totalTokens: 2_148,
            },
          };
        }
        return {
          text: "The final provider-neutral checkpoint.",
          finishReason: "stop",
          usage: {
            inputTokens: 90,
            inputTokenDetails: {
              noCacheTokens: 90,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            outputTokens: 60,
            outputTokenDetails: { textTokens: 60, reasoningTokens: 0 },
            totalTokens: 150,
          },
        };
      },
      now: () => 100,
      createId: deterministicIds(),
    });

    const result = await compactClaimed(store, service, request("manual", {
      contextWindow: 8_192,
      policy: {
        ...DEFAULT_CONTEXT_COMPACTION_POLICY,
        safetyMarginTokens: 0,
        softTriggerRatio: 0.1,
        targetRatio: 0.05,
      },
    }));

    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("Expected checkpoint creation");
    expect(outputBudgets).toEqual([2_048, 4_096]);
    expect(estimatedInputs[1]!).toBeLessThanOrEqual(estimatedInputs[0]!);
    expect(result.checkpoint.summary).toBe("The final provider-neutral checkpoint.");
    expect(result.checkpoint.usage).toMatchObject({
      summaryInvocationCount: 2,
      reservedOutputTokens: 6_144,
      providerObservation: {
        observedInvocationCount: 2,
        inputTokens: 190,
        outputTokens: 2_108,
        reasoningTokens: 2_048,
        totalTokens: 2_298,
      },
    });
    db.close();
  });

  test("fails after exactly one retry when reasoning consumes both summary budgets", async () => {
    const { db, store } = createHistory();
    const outputBudgets: number[] = [];
    const service = new ContextCompactionService({
      store,
      generator: async (input) => {
        outputBudgets.push(input.maxOutputTokens);
        return {
          text: "",
          finishReason: "length",
          usage: {
            inputTokens: 100,
            inputTokenDetails: {
              noCacheTokens: 100,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            outputTokens: input.maxOutputTokens,
            outputTokenDetails: {
              textTokens: 0,
              reasoningTokens: input.maxOutputTokens,
            },
            totalTokens: 100 + input.maxOutputTokens,
          },
        };
      },
      createId: deterministicIds(),
    });

    try {
      await compactClaimed(store, service, request("manual", {
        contextWindow: 8_192,
        policy: {
          ...DEFAULT_CONTEXT_COMPACTION_POLICY,
          safetyMarginTokens: 0,
          softTriggerRatio: 0.1,
          targetRatio: 0.05,
        },
      }));
      throw new Error("Expected summary validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ContextSummaryValidationError);
      expect((error as ContextSummaryValidationError).diagnostics).toMatchObject({
        finishReason: "length",
        outputTokens: 4_096,
        textTokens: 0,
        reasoningTokens: 4_096,
      });
    }
    expect(outputBudgets).toEqual([2_048, 4_096]);
    expect(store.listContextCheckpoints("conv_compaction")).toEqual([]);
    db.close();
  });

  test("does not exceed the model output limit when a larger summary retry is unavailable", async () => {
    const { db, store } = createHistory();
    const outputBudgets: number[] = [];
    const service = new ContextCompactionService({
      store,
      generator: async (input) => {
        outputBudgets.push(input.maxOutputTokens);
        return {
          text: "",
          finishReason: "length",
          usage: {
            inputTokens: 100,
            inputTokenDetails: {
              noCacheTokens: 100,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            outputTokens: input.maxOutputTokens,
            outputTokenDetails: { textTokens: 0, reasoningTokens: input.maxOutputTokens },
            totalTokens: 100 + input.maxOutputTokens,
          },
        };
      },
      createId: deterministicIds(),
    });

    await expect(compactClaimed(store, service, request("manual", {
      contextWindow: 8_192,
      modelOutputLimit: 2_048,
      policy: {
        ...DEFAULT_CONTEXT_COMPACTION_POLICY,
        safetyMarginTokens: 0,
        softTriggerRatio: 0.1,
        targetRatio: 0.05,
      },
    }))).rejects.toBeInstanceOf(ContextSummaryValidationError);
    expect(outputBudgets).toEqual([2_048]);
    db.close();
  });

  test.each([
    ["normal blank", "stop" as const, 0, 0],
    ["length without reasoning", "length" as const, 0, 0],
    ["length without an explicit zero text count", "length" as const, 100, undefined],
  ])("does not retry %s summary output", async (_name, finishReason, reasoningTokens, textTokens) => {
    const { db, store } = createHistory();
    let calls = 0;
    const service = new ContextCompactionService({
      store,
      generator: async () => {
        calls += 1;
        return {
          text: "",
          finishReason,
          usage: {
            inputTokens: 100,
            inputTokenDetails: {
              noCacheTokens: 100,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            outputTokens: reasoningTokens,
            outputTokenDetails: { textTokens, reasoningTokens },
            totalTokens: 100 + reasoningTokens,
          },
        };
      },
      createId: deterministicIds(),
    });

    await expect(compactClaimed(store, service, request("manual", {
      contextWindow: 8_192,
      policy: {
        ...DEFAULT_CONTEXT_COMPACTION_POLICY,
        safetyMarginTokens: 0,
        softTriggerRatio: 0.1,
        targetRatio: 0.05,
      },
    }))).rejects.toBeInstanceOf(ContextSummaryValidationError);
    expect(calls).toBe(1);
    expect(store.listContextCheckpoints("conv_compaction")).toEqual([]);
    db.close();
  });

  test("preserves unavailable Provider usage scalars across rolling summary calls", async () => {
    const { db, store } = createHistory();
    const user = store.getMessage("msg_user_a");
    if (!user || user.role !== "user") throw new Error("Missing User fixture");
    store.saveMessage({
      ...user,
      parts: [{
        ...user.parts[0]!,
        type: "text",
        text: `BEGIN_${"🙂".repeat(12_000)}_END`,
      }],
    });
    let invocation = 0;
    const service = new ContextCompactionService({
      store,
      generator: async () => {
        invocation += 1;
        return {
          text: `PARTIAL_PROVIDER_USAGE_${invocation}`,
          usage: invocation === 1
            ? {
                inputTokens: 10,
                inputTokenDetails: {
                  noCacheTokens: undefined,
                  cacheReadTokens: undefined,
                  cacheWriteTokens: 2,
                },
                outputTokens: undefined,
                outputTokenDetails: {
                  textTokens: undefined,
                  reasoningTokens: undefined,
                },
                totalTokens: undefined,
              }
            : {
                inputTokens: undefined,
                inputTokenDetails: {
                  noCacheTokens: undefined,
                  cacheReadTokens: 3,
                  cacheWriteTokens: undefined,
                },
                outputTokens: 4,
                outputTokenDetails: {
                  textTokens: undefined,
                  reasoningTokens: 1,
                },
                totalTokens: 14,
              },
        };
      },
      now: () => 100,
      createId: deterministicIds(),
    });

    const result = await compactClaimed(store, service, request("manual"));

    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("Expected checkpoint creation");
    expect(invocation).toBeGreaterThan(1);
    expect(result.checkpoint.usage?.providerObservation).toEqual({
      source: "provider",
      observedInvocationCount: invocation,
      inputTokens: 10,
      outputTokens: 4 * (invocation - 1),
      reasoningTokens: invocation - 1,
      cacheReadTokens: 3 * (invocation - 1),
      cacheWriteTokens: 2,
      totalTokens: 14 * (invocation - 1),
    });
    db.close();
  });

  test("returns not_needed below the soft threshold without generation or writes", async () => {
    const { db, store } = createHistory();
    let calls = 0;
    const service = new ContextCompactionService({
      store,
      generator: async () => {
        calls += 1;
        return { text: "must not be called" };
      },
      now: () => 100,
      createId: deterministicIds(),
    });

    const result = await compactClaimed(store, service, request("auto_pre_turn", {
      contextWindow: 100_000,
      candidateCoverageThroughRunId: undefined,
    }));

    expect(result).toEqual({ status: "not_needed" });
    expect(calls).toBe(0);
    expect(store.listContextCheckpoints("conv_compaction")).toEqual([]);
    expect(store.listEvents("conv_compaction")).toEqual([]);
    db.close();
  });

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid reservedOutputTokens at the service boundary: %s",
    async (reservedOutputTokens) => {
      const { db, store } = createHistory();
      let calls = 0;
      const service = new ContextCompactionService({
        store,
        generator: async () => {
          calls += 1;
          return { text: "must not be called" };
        },
      });

      await expect(compactClaimed(store, service, request("manual", { reservedOutputTokens }))).rejects.toThrow(
        "reservedOutputTokens",
      );
      expect(calls).toBe(0);
      expect(store.listContextCheckpoints("conv_compaction")).toEqual([]);
      db.close();
    },
  );

  test.each([
    ["blank", "   \n\t"],
    ["oversized UTF-8", "你".repeat(6_000)],
    ["invalid Unicode", "broken-\ud800"],
  ] as const)("rejects %s summary output without committing derived facts", async (_name, text) => {
    const { db, store } = createHistory();
    const service = new ContextCompactionService({
      store,
      generator: async () => ({ text }),
      now: () => 100,
      createId: deterministicIds(),
    });

    await expect(compactClaimed(store, service, request("manual"))).rejects.toBeInstanceOf(
      ContextSummaryValidationError,
    );
    expect(store.listContextCheckpoints("conv_compaction")).toEqual([]);
    expectCompactionAttempts(store, [{ attemptIndex: 0, status: "failed" }]);
    db.close();
  });

  test("returns stale when the active revision changes during generation", async () => {
    const { db, store, conversation } = createHistory();
    const service = new ContextCompactionService({
      store,
      generator: async () => {
        store.saveConversation({
          ...conversation,
          revision: 4,
          time: { ...conversation.time, updated: 40 },
        });
        return { text: "A valid but stale summary" };
      },
      now: () => 100,
      createId: deterministicIds(),
    });

    expect(await compactClaimed(store, service, request("auto_pre_turn"))).toEqual({ status: "stale" });
    expect(store.listContextCheckpoints("conv_compaction")).toEqual([]);
    expectCompactionAttempts(store, [{ attemptIndex: 0, status: "interrupted" }]);
    db.close();
  });

  test("freezes source and Safety State hashes in the committed checkpoint", async () => {
    const { db, store } = createHistory();
    const service = new ContextCompactionService({
      store,
      generator: async () => ({ text: "Stable summary" }),
      now: () => 100,
      createId: deterministicIds(),
    });

    const result = await compactClaimed(store, service, request("manual"));

    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("Expected checkpoint creation");
    expect(result.checkpoint.sourceStateHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.checkpoint.safetyStateHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    db.close();
  });

  test("keeps canonical-equivalent secret and provider metadata changes non-stale", async () => {
    const { db, store } = createHistory();
    const user = store.getMessage("msg_user_a");
    if (!user || user.role !== "user") throw new Error("Missing User fixture");
    store.saveMessage({
      ...user,
      metadata: { providerMetadata: { requestId: "provider-request-before" } },
      parts: user.parts.map((part) =>
        part.type === "text"
          ? {
              ...part,
              text: `${part.text}\ntoken=secret-before`,
              metadata: { providerMetadata: { trace: "provider-trace-before" } },
            }
          : part,
      ),
    });
    const service = new ContextCompactionService({
      store,
      generator: async () => {
        const current = store.getMessage(user.id);
        if (!current || current.role !== "user") throw new Error("Missing User fixture");
        store.saveMessage({
          ...current,
          metadata: { providerMetadata: { requestId: "provider-request-after" } },
          parts: current.parts.map((part) =>
            part.type === "text"
              ? {
                  ...part,
                  text: part.text.replace("secret-before", "secret-after"),
                  metadata: { providerMetadata: { trace: "provider-trace-after" } },
                }
              : part,
          ),
        });
        return { text: "Summary from the unchanged canonical source" };
      },
      now: () => 100,
      createId: deterministicIds(),
    });

    const result = await compactClaimed(store, service, request("auto_pre_turn"));

    expect(result.status).toBe("created");
    expect(store.listContextCheckpoints("conv_compaction")).toHaveLength(1);
    expectCompactionAttempts(store, [{ attemptIndex: 0, status: "created" }]);
    expectEventTypeCount(store, "context.checkpoint.created", 1);
    db.close();
  });

  test.each([
    [
      "covered User text",
      ({ store }: ReturnType<typeof createHistory>) => {
        const user = store.getMessage("msg_user_a");
        if (!user || user.role !== "user") throw new Error("Missing User fixture");
        return () => store.saveMessage({
          ...user,
          parts: user.parts.map((part) =>
            part.type === "text" ? { ...part, text: `${part.text}_CHANGED` } : part,
          ),
        });
      },
    ],
    [
      "covered Assistant text",
      ({ store }: ReturnType<typeof createHistory>) => {
        const assistant = store.getMessage("msg_assistant_a");
        if (!assistant || assistant.role !== "assistant") {
          throw new Error("Missing Assistant fixture");
        }
        return () => store.saveMessage({
          ...assistant,
          parts: assistant.parts.map((part) =>
            part.type === "text" ? { ...part, text: `${part.text}_CHANGED` } : part,
          ),
        });
      },
    ],
    [
      "covered non-redacted reasoning",
      ({ store }: ReturnType<typeof createHistory>) => {
        const assistant = store.getMessage("msg_assistant_a");
        const run = store.getRun("run_a");
        if (!assistant || assistant.role !== "assistant" || !run?.output) {
          throw new Error("Missing Assistant fixture");
        }
        const reasoning: Part = {
          id: "part_reasoning_source_a",
          conversationId: assistant.conversationId,
          messageId: assistant.id,
          type: "reasoning",
          text: "Initial safe reasoning",
        };
        store.saveMessage({ ...assistant, parts: [...assistant.parts, reasoning] });
        store.saveRun({
          ...run,
          output: { ...run.output, partIds: [...run.output.partIds, reasoning.id] },
        });
        return () => {
          const current = store.getMessage(assistant.id);
          if (!current || current.role !== "assistant") throw new Error("Missing Assistant fixture");
          store.saveMessage({
            ...current,
            parts: current.parts.map((part) =>
              part.id === reasoning.id && part.type === "reasoning"
                ? { ...part, text: "Changed safe reasoning" }
                : part,
            ),
          });
        };
      },
    ],
    [
      "covered FilePart metadata",
      ({ db, store }: ReturnType<typeof createHistory>) => {
        const attachmentStore = new RuntimeAttachmentSqliteStore(db);
        attachmentStore.createUpload({
          id: "upl_source_hash",
          filename: "initial.txt",
          declaredMediaType: "text/plain",
          declaredByteLength: 7,
          state: "pending",
          createdAt: 1,
          updatedAt: 1,
          expiresAt: 10_000,
        });
        attachmentStore.completeUpload({
          uploadId: "upl_source_hash",
          attachment: {
            id: "att_source_hash",
            blobId: "blob_source_hash",
            filename: "initial.txt",
            declaredMediaType: "text/plain",
            mediaType: "text/plain",
            byteLength: 7,
            state: "ready",
            createdAt: 1,
            updatedAt: 1,
          },
          blob: {
            id: "blob_source_hash",
            sha256: "a".repeat(64),
            byteLength: 7,
            storageKey: "source-hash-storage-key",
            state: "available",
            createdAt: 1,
            verifiedAt: 1,
          },
          now: 1,
        });
        const user = store.getMessage("msg_user_a");
        if (!user || user.role !== "user") throw new Error("Missing User fixture");
        const file: Part = {
          id: "part_file_source_a",
          conversationId: user.conversationId,
          messageId: user.id,
          type: "file",
          attachmentId: "att_source_hash",
          mediaType: "text/plain",
          filename: "initial.txt",
          byteLength: 7,
        };
        store.saveMessage({ ...user, parts: [...user.parts, file] });
        return () => {
          const current = store.getMessage(user.id);
          if (!current || current.role !== "user") throw new Error("Missing User fixture");
          db.query(
            `UPDATE runtime_attachments
             SET filename = ?, media_type = ?, byte_length = ?, updated_at = ?
             WHERE id = ?`,
          ).run("changed.txt", "text/markdown", 8, 2, file.attachmentId);
          store.saveMessage({
            ...current,
            parts: current.parts.map((part) =>
              part.id === file.id && part.type === "file"
                ? { ...part, filename: "changed.txt", mediaType: "text/markdown", byteLength: 8 }
                : part,
            ),
          });
        };
      },
    ],
    [
      "covered Source URL",
      ({ store }: ReturnType<typeof createHistory>) => {
        const assistant = store.getMessage("msg_assistant_a");
        const run = store.getRun("run_a");
        if (!assistant || assistant.role !== "assistant" || !run?.output) {
          throw new Error("Missing Assistant fixture");
        }
        const source: Part = {
          id: "part_source_a",
          conversationId: assistant.conversationId,
          messageId: assistant.id,
          type: "source",
          sourceType: "url",
          sourceId: "provider-source-id",
          url: "https://example.com/initial?q=secret#fragment",
          title: "Ignored provider title",
        };
        store.saveMessage({ ...assistant, parts: [...assistant.parts, source] });
        store.saveRun({
          ...run,
          output: { ...run.output, partIds: [...run.output.partIds, source.id] },
        });
        return () => {
          const current = store.getMessage(assistant.id);
          if (!current || current.role !== "assistant") throw new Error("Missing Assistant fixture");
          store.saveMessage({
            ...current,
            parts: current.parts.map((part) =>
              part.id === source.id && part.type === "source"
                ? { ...part, url: "https://example.com/changed?q=other#other" }
                : part,
            ),
          });
        };
      },
    ],
  ] as const)(
    "returns stale when %s changes during generation without revision or identity changes",
    async (_name, arrangeMutation) => {
      const fixture = createHistory();
      const mutate = arrangeMutation(fixture);
      const service = new ContextCompactionService({
        store: fixture.store,
        generator: async () => {
          mutate();
          return { text: "Summary from the original canonical source" };
        },
        now: () => 100,
        createId: deterministicIds(),
      });

      expect(await compactClaimed(fixture.store, service, request("auto_pre_turn"))).toEqual({
        status: "stale",
      });
      expect(fixture.store.getConversation("conv_compaction")?.revision).toBe(3);
      expect(fixture.store.listContextCheckpoints("conv_compaction")).toEqual([]);
      expectCompactionAttempts(fixture.store, [{ attemptIndex: 0, status: "interrupted" }]);
      fixture.db.close();
    },
  );

  test.each([
    [
      "covered Run/User input pairing",
      ({ store }: ReturnType<typeof createHistory>) => {
        const run = store.getRun("run_a");
        if (!run) throw new Error("Missing Run fixture");
        store.saveRun({ ...run, input: { ...run.input, messageIds: ["msg_user_b"] } });
      },
    ],
    [
      "covered User ownership",
      ({ store }: ReturnType<typeof createHistory>) => {
        store.saveConversation({
          id: "conv_foreign_source",
          title: "Foreign",
          version: "1",
          status: { type: "idle" },
          revision: 0,
          time: { created: 1, updated: 1 },
        });
        const user = store.getMessage("msg_user_a");
        if (!user || user.role !== "user") throw new Error("Missing User fixture");
        store.saveMessage({
          ...user,
          conversationId: "conv_foreign_source",
          parts: user.parts.map((part) => ({
            ...part,
            conversationId: "conv_foreign_source",
          })),
        });
      },
    ],
    [
      "covered Assistant parent pairing",
      ({ store }: ReturnType<typeof createHistory>) => {
        const assistant = store.getMessage("msg_assistant_a");
        if (!assistant || assistant.role !== "assistant") {
          throw new Error("Missing Assistant fixture");
        }
        store.saveMessage({ ...assistant, parentId: "msg_user_b" });
      },
    ],
  ] as const)("returns stale when %s becomes invalid during generation", async (_name, mutate) => {
    const fixture = createHistory();
    const service = new ContextCompactionService({
      store: fixture.store,
      generator: async () => {
        mutate(fixture);
        return { text: "Summary from the original complete pair" };
      },
      now: () => 100,
      createId: deterministicIds(),
    });

    expect(await compactClaimed(fixture.store, service, request("auto_pre_turn"))).toEqual({
      status: "stale",
    });
    expect(fixture.store.listContextCheckpoints("conv_compaction")).toEqual([]);
    expectCompactionAttempts(fixture.store, [{ attemptIndex: 0, status: "interrupted" }]);
    fixture.db.close();
  });

  test.each([
    [
      "Assistant lifecycle changes",
      (store: RuntimeSqliteStore) => {
        const assistant = store.getMessage("msg_assistant_a");
        if (!assistant || assistant.role !== "assistant") throw new Error("Missing Assistant fixture");
        store.saveMessage({ ...assistant, status: { type: "running" } });
      },
    ],
    [
      "a pending ToolCall is added",
      (store: RuntimeSqliteStore) => {
        store.saveToolCall({
          id: "tool_late_pending",
          conversationId: "conv_compaction",
          runId: "run_a",
          messageId: "msg_assistant_a",
          toolName: "sql.execute",
          input: {},
          state: "pending",
          time: { created: 40 },
        });
      },
    ],
    [
      "a ToolCall lifecycle changes",
      (store: RuntimeSqliteStore) => {
        const toolCall = store.getToolCall("tool_a");
        if (!toolCall) throw new Error("Missing ToolCall fixture");
        store.saveToolCall({
          ...toolCall,
          state: "error",
          error: {
            code: "TOOL_FAILED",
            message: "Failed after generation began",
            retryable: false,
            outcome: "unknown",
          },
          time: { ...toolCall.time, completed: 40 },
        });
      },
    ],
    [
      "a pending Permission is added",
      (store: RuntimeSqliteStore) => {
        const toolCall = store.getToolCall("tool_a");
        if (!toolCall) throw new Error("Missing ToolCall fixture");
        store.saveToolCall({ ...toolCall, permissionId: "perm_late_pending" });
        store.savePermission({
          id: "perm_late_pending",
          conversationId: toolCall.conversationId,
          runId: toolCall.runId,
          messageId: toolCall.messageId,
          toolCallId: toolCall.id,
          status: "pending",
          toolId: toolCall.toolName,
          title: "Execute SQL",
          risk: { level: "high", reversible: false, sideEffects: ["business_write"] },
          confirmation: { level: "standard" },
          createdAt: 40,
        });
      },
    ],
    [
      "Safety facts change outside the covered prefix",
      (store: RuntimeSqliteStore) => {
        store.saveToolCall({
          id: "tool_tail_effect",
          conversationId: "conv_compaction",
          runId: "run_b",
          messageId: "msg_assistant_b",
          toolName: "sql.execute",
          input: {},
          state: "completed",
          authorization: {
            version: "1",
            risk: { level: "high", reversible: false, sideEffects: ["business_write"] },
          },
          result: { ok: true, summary: "SQL completed", data: { rowsAffected: 1 } },
          time: { created: 40, started: 40, completed: 41 },
        });
      },
    ],
  ] as const)("returns stale when %s during generation without a revision change", async (_name, mutate) => {
    const { db, store } = createHistory();
    if (_name === "a ToolCall lifecycle changes" || _name === "a pending Permission is added") {
      persistCompletedToolPair(store);
    }
    const service = new ContextCompactionService({
      store,
      generator: async () => {
        mutate(store);
        return { text: "A summary of state that changed during generation" };
      },
      now: () => 100,
      createId: deterministicIds(),
    });

    expect(await compactClaimed(store, service, request("auto_pre_turn"))).toEqual({ status: "stale" });
    expect(store.getConversation("conv_compaction")?.revision).toBe(3);
    expect(store.listContextCheckpoints("conv_compaction")).toEqual([]);
    expectCompactionAttempts(store, [{ attemptIndex: 0, status: "interrupted" }]);
    db.close();
  });

  test.each(["text", "reasoning"] as const)(
    "folds an oversized UTF-8 %s Part without exceeding any summary input budget",
    async (partType) => {
      const { db, store } = createHistory();
      const hugeText = `BEGIN_${Array.from({ length: 4_000 }, (_, index) =>
        `${index.toString().padStart(4, "0")}🙂`).join("")}_END`;
      if (partType === "text") {
        const user = store.getMessage("msg_user_a");
        if (!user || user.role !== "user") throw new Error("Missing User fixture");
        store.saveMessage({
          ...user,
          parts: [{ ...user.parts[0]!, type: "text", text: hugeText }],
        });
      } else {
        const assistant = store.getMessage("msg_assistant_a");
        if (!assistant || assistant.role !== "assistant") throw new Error("Missing Assistant fixture");
        store.saveMessage({
          ...assistant,
          parts: [{
            id: "part_reasoning_a",
            conversationId: assistant.conversationId,
            messageId: assistant.id,
            type: "reasoning",
            text: hugeText,
          }],
        });
        const run = store.getRun("run_a");
        if (!run) throw new Error("Missing Run fixture");
        store.saveRun({
          ...run,
          output: { messageId: assistant.id, partIds: ["part_reasoning_a"] },
        });
      }
      const generatorInputs: Parameters<ContextSummaryGenerator>[0][] = [];
      const service = new ContextCompactionService({
        store,
        generator: async (input) => {
          generatorInputs.push(input);
          return { text: `ROLLING_SUMMARY_${generatorInputs.length}` };
        },
        now: () => 100,
        createId: deterministicIds(),
      });
      const contextWindow = 4_096;

      const result = await compactClaimed(store, service, request("manual", { contextWindow }));

      expect(result.status).toBe("created");
      expect(generatorInputs.length).toBeGreaterThan(1);
      const summaryInputBudget = contextWindow
        - DEFAULT_CONTEXT_COMPACTION_POLICY.summaryMaxOutputTokens
        - request("manual").policy.safetyMarginTokens;
      for (const input of generatorInputs) {
        const estimatedInputTokens = estimateSummaryGeneratorInputTokens(input);
        expect(estimatedInputTokens).toBeLessThanOrEqual(summaryInputBudget);
        expect(JSON.stringify(input.messages)).not.toContain(hugeText);
      }
      const projectedSource = generatorInputs
        .flatMap((input) => input.messages.slice(0, -1))
        .filter((message) => message.role === (partType === "text" ? "user" : "assistant"))
        .map((message) => message.content)
        .join("");
      expect(projectedSource).toContain(hugeText);
      db.close();
    },
  );

  test("fails before generation when fixed summary content cannot fit the model window", async () => {
    const { db, store } = createHistory();
    const user = store.getMessage("msg_user_a");
    if (!user || user.role !== "user") throw new Error("Missing User fixture");
    store.saveMessage({
      ...user,
      parts: [{ ...user.parts[0]!, type: "text", text: "x".repeat(30_000) }],
    });
    let generatorCalls = 0;
    const service = new ContextCompactionService({
      store,
      generator: async () => {
        generatorCalls += 1;
        return { text: "must not be called" };
      },
      createId: deterministicIds(),
    });

    try {
      await compactClaimed(store, service, request("manual", { contextWindow: 2_060 }));
      throw new Error("Expected fixed summary input to exceed the model window");
    } catch (error) {
      expect((error as Error).name).toBe("ContextSummaryInputBudgetError");
    }
    expect(generatorCalls).toBe(0);
    expect(store.listContextCheckpoints("conv_compaction")).toEqual([]);
    expectCompactionAttempts(store, [{ attemptIndex: 0, status: "failed" }]);
    db.close();
  });

  test("allowlists and sanitizes the summary source without deleting safe URL or SQL context", () => {
    const { db, store } = createHistory();
    const user = store.getMessage("msg_user_a");
    const assistant = store.getMessage("msg_assistant_a");
    if (!user || user.role !== "user" || !assistant || assistant.role !== "assistant") {
      throw new Error("Missing message fixtures");
    }
    const userWithSensitiveParts: UserMessage = {
      ...user,
      metadata: { providerMetadata: { requestId: "provider-request-secret" } },
      parts: [
        {
          ...user.parts[0]!,
          type: "text",
          text: [
            "Keep query concept SELECT count(*) FROM orders.",
            "Authorization: Bearer source-bearer-secret",
            "password=hunter2 token='source-token' api-key: source-api-key",
            "Connect postgres://alice:uri-password@db.example/app",
            "Read C:\\Users\\alice\\private\\credentials.txt",
            "-----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY-----",
          ].join("\n"),
          metadata: { providerMetadata: { trace: "text-provider-secret" } },
        },
        {
          id: "part_file_sensitive",
          conversationId: user.conversationId,
          messageId: user.id,
          type: "file",
          attachmentId: "att_provider_private",
          mediaType: "text/plain",
          filename: "C:\\Users\\alice\\private\\database-token.txt",
          byteLength: 42,
          metadata: { providerFileId: "file-provider-private" },
        },
      ],
    };
    const assistantWithStructuredParts: AssistantMessage = {
      ...assistant,
      metadata: { providerMetadata: { requestId: "assistant-provider-secret" } },
      parts: [
        {
          id: "part_reasoning_redacted",
          conversationId: assistant.conversationId,
          messageId: assistant.id,
          type: "reasoning",
          text: "REDACTED_REASONING_BODY_MUST_NOT_LEAK",
          redacted: true,
          metadata: { providerMetadata: { signature: "reasoning-provider-secret" } },
        },
        {
          id: "part_source_safe",
          conversationId: assistant.conversationId,
          messageId: assistant.id,
          type: "source",
          sourceType: "url",
          sourceId: "provider-source-private",
          url: "https://source-user:source-password@example.com/docs/page?q=token#section",
          title: "Provider source title",
          metadata: { providerMetadata: { trace: "source-provider-secret" } },
        },
        {
          id: "part_tool_sensitive",
          conversationId: assistant.conversationId,
          messageId: assistant.id,
          type: "tool",
          toolCallId: "tool_sensitive",
          toolName: "sql.execute",
          state: {
            status: "completed",
            input: { sql: "DELETE FROM accounts WHERE token = 'tool-input-secret'" },
            output: { data: { rows: [{ secret: "tool-output-secret" }] } },
            title: "Execute raw SQL",
            metadata: { providerResultId: "tool-provider-private" },
            time: { start: 10, end: 11 },
          },
          metadata: { providerMetadata: { trace: "tool-part-provider-secret" } },
        },
        {
          id: "part_error_sensitive",
          conversationId: assistant.conversationId,
          messageId: assistant.id,
          type: "error",
          error: {
            name: "UnknownError",
            data: { message: "structured-error-secret" },
          },
        },
      ],
    };
    const safetyState = buildRuntimeSafetyState({
      conversationId: "conv_compaction",
      activeRunIds: ["run_a", "run_b", "run_c"],
      toolCalls: [],
      permissions: [],
    });

    const source = JSON.stringify(buildContextSummaryPrompt({
      messages: [userWithSensitiveParts, assistantWithStructuredParts],
      safetyState,
    }));

    expect(source).toContain("SELECT count(*) FROM orders");
    expect(source).toContain("database-token.txt");
    expect(source).toContain("[Redacted reasoning]");
    expect(source).toContain("https://example.com/docs/page");
    for (const forbidden of [
      "source-bearer-secret",
      "hunter2",
      "source-token",
      "source-api-key",
      "uri-password",
      "C:\\\\Users",
      "private-key-body",
      "att_provider_private",
      "provider-source-private",
      "?q=token",
      "#section",
      "REDACTED_REASONING_BODY_MUST_NOT_LEAK",
      "DELETE FROM accounts",
      "tool-input-secret",
      "tool-output-secret",
      "structured-error-secret",
      "provider-secret",
      "provider-private",
    ]) {
      expect(source).not.toContain(forbidden);
    }
    db.close();
  });

  test("sanitizes the final generated summary before checkpoint persistence", async () => {
    const { db, store } = createHistory();
    const service = new ContextCompactionService({
      store,
      generator: async () => ({
        text: [
          "Keep the confirmed database migration decision.",
          "Authorization: Bearer final-bearer-secret",
          "secret=final-secret-value",
          "C:\\Users\\alice\\private\\final.txt",
        ].join("\n"),
      }),
      now: () => 100,
      createId: deterministicIds(),
    });

    const result = await compactClaimed(store, service, request("manual"));

    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("Expected checkpoint creation");
    expect(result.checkpoint.summary).toContain("confirmed database migration decision");
    expect(result.checkpoint.summary).toContain("[REDACTED]");
    expect(result.checkpoint.summary).not.toContain("final-bearer-secret");
    expect(result.checkpoint.summary).not.toContain("final-secret-value");
    expect(result.checkpoint.summary).not.toContain("C:\\Users");
    expect(store.listContextCheckpoints("conv_compaction")).toEqual([result.checkpoint]);
    db.close();
  });

  test("rejects generated output with no meaningful content after sanitization", async () => {
    const { db, store } = createHistory();
    const service = new ContextCompactionService({
      store,
      generator: async () => ({
        text: [
          "Authorization: Bearer only-secret",
          "password=only-password",
          "C:\\Users\\alice\\private\\only-secret.txt",
        ].join("\n"),
      }),
      now: () => 100,
      createId: deterministicIds(),
    });

    await expect(compactClaimed(store, service, request("manual"))).rejects.toBeInstanceOf(
      ContextSummaryValidationError,
    );
    expect(store.listContextCheckpoints("conv_compaction")).toEqual([]);
    expectCompactionAttempts(store, [{ attemptIndex: 0, status: "failed" }]);
    db.close();
  });

  test("recurs from an applicable parent checkpoint plus only newly covered raw Runs", async () => {
    const { db, store, conversation } = createHistory();
    const generatorInputs: Parameters<ContextSummaryGenerator>[0][] = [];
    const service = new ContextCompactionService({
      store,
      generator: async (input) => {
        generatorInputs.push(input);
        return {
          text: generatorInputs.length === 1 ? "FIRST_SUMMARY" : "SECOND_SUMMARY",
          usage: {
            inputTokens: generatorInputs.length === 1 ? 1_000 : 10,
            inputTokenDetails: {
              noCacheTokens: generatorInputs.length === 1 ? 1_000 : 10,
              cacheReadTokens: undefined,
              cacheWriteTokens: undefined,
            },
            outputTokens: generatorInputs.length === 1 ? 100 : 2,
            outputTokenDetails: {
              textTokens: generatorInputs.length === 1 ? 100 : 2,
              reasoningTokens: undefined,
            },
            totalTokens: generatorInputs.length === 1 ? 1_100 : 12,
          },
        };
      },
      now: () => 100 + generatorInputs.length,
      createId: deterministicIds(),
    });

    const first = await compactClaimed(store, service, request("manual"));
    expect(first.status).toBe("created");
    const runC = store.getRun("run_c")!;
    const assistantC = store.getMessage("msg_assistant_c") as AssistantMessage;
    store.saveRun({ ...runC, status: "completed", time: { ...runC.time, completed: 41 } });
    store.saveMessage({
      ...assistantC,
      status: { type: "complete" },
      parts: [{
        id: "part_assistant_c",
        conversationId: conversation.id,
        messageId: assistantC.id,
        type: "text",
        text: `C_COMPLETED_${"c".repeat(1_200)}`,
      }],
      time: { ...assistantC.time, completed: 41 },
    });
    saveRunPair(store, {
      conversationId: conversation.id,
      runId: "run_d",
      parentRunId: "run_c",
      created: 50,
      status: "completed",
      userText: `D_USER_${"d".repeat(1_200)}`,
      assistantText: `D_ASSISTANT_${"e".repeat(1_200)}`,
    });
    saveRunPair(store, {
      conversationId: conversation.id,
      runId: "run_e",
      parentRunId: "run_d",
      created: 60,
      status: "running",
      userText: "E_CURRENT_RAW",
      assistantText: "",
    });
    store.saveConversation({
      ...conversation,
      status: { type: "busy", runId: "run_e" },
      activeHeadRunId: "run_e",
      revision: 5,
      time: { ...conversation.time, updated: 60 },
    });

    const second = await compactClaimed(store, service, request("auto_pre_turn", {
      expectedHeadRunId: "run_e",
      expectedConversationRevision: 5,
      runId: "run_e",
      candidateCoverageThroughRunId: "run_c",
    }));

    expect(second.status).toBe("created");
    if (first.status !== "created" || second.status !== "created") {
      throw new Error("Expected checkpoint chain creation");
    }
    expect(second.checkpoint.parentCheckpointId).toBe(first.checkpoint.id);
    expect(first.checkpoint.usage?.providerObservation?.inputTokens).toBe(1_000);
    expect(second.checkpoint.usage).toMatchObject({
      purpose: "checkpoint_summary",
      summaryInvocationCount: 1,
      view: "checkpoint",
      checkpointId: first.checkpoint.id,
      providerObservation: {
        source: "provider",
        observedInvocationCount: 1,
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
    });
    const secondSource = JSON.stringify(generatorInputs[1]?.messages);
    const secondInstructions = JSON.stringify(generatorInputs[1]?.instructions);
    expect(secondInstructions).toContain("FIRST_SUMMARY");
    expect(secondInstructions).toContain("Runtime Safety State");
    expect(secondSource).not.toContain("FIRST_SUMMARY");
    expect(secondSource).toContain("recent user");
    expect(secondSource).toContain("C_COMPLETED_");
    expect(secondSource).not.toContain("OLD_USER_");
    expect(secondSource).not.toContain("D_USER_");
    expect(secondSource).not.toContain("E_CURRENT_RAW");
    expect(store.listContextCheckpoints(conversation.id)).toHaveLength(2);
    db.close();
  });
});

describe("ModelContextManager", () => {
  test("forecasts the completed Assistant in memory without writing plans or checkpoints", () => {
    const { db, store } = createHistory();
    const ids = deterministicIds();
    const manager = new ModelContextManager({
      store,
      compactionService: new ContextCompactionService({
        store,
        generator: async () => ({ text: "unused" }),
        createId: ids,
      }),
      createId: ids,
    });
    const forecastInput = {
      conversationId: "conv_compaction" as const,
      runId: "run_c" as const,
      requestIndex: 1,
      providerId: "openai",
      modelId: "gpt-test",
      contextWindow: 100_000,
      reservedOutputTokens: 1_024,
      systemPrompt: "runtime system prompt",
      toolSchemas: {},
      policy: DEFAULT_CONTEXT_COMPACTION_POLICY,
      reason: "append" as const,
    };
    const before = manager.forecastNextTurn(forecastInput);
    const assistant = store.getMessage("msg_assistant_c");
    if (!assistant || assistant.role !== "assistant") {
      throw new Error("Missing completed Assistant fixture");
    }
    store.saveMessage({
      ...assistant,
      parts: assistant.parts.map((part) =>
        part.type === "text"
          ? { ...part, text: `${part.text}${" forecast-growth".repeat(200)}` }
          : part,
      ),
    });

    const after = manager.forecastNextTurn(forecastInput);
    expect(after.estimatedInputTokens).toBeGreaterThan(before.estimatedInputTokens);
    expect(after.breakdown.rawTokens).toBeGreaterThan(before.breakdown.rawTokens);
    expect(store.listContextPlansByRun("run_c")).toEqual([]);
    expect(store.listContextCheckpoints("conv_compaction")).toEqual([]);
    db.close();
  });

  test("appends exact retained model input and binds it to the durable plan identity", async () => {
    const { db, store } = createHistory();
    const currentAssistant = store.getMessage("msg_assistant_c");
    if (!currentAssistant || currentAssistant.role !== "assistant") {
      throw new Error("Missing current Assistant fixture");
    }
    store.saveMessage({
      ...currentAssistant,
      parts: currentAssistant.parts.map((part) =>
        part.type === "text"
          ? { ...part, text: "CURRENT_ASSISTANT_MUST_NOT_REPLAY" }
          : part
      ),
    });
    const ids = deterministicIds();
    const service = new ContextCompactionService({
      store,
      generator: async () => { throw new Error("mid-turn must not summarize"); },
      createId: ids,
    });
    const manager = new ModelContextManager({
      store,
      compactionService: service,
      createId: ids,
    });
    const common = {
      contextWindow: 100_000,
      trigger: "auto_mid_turn" as const,
      excludeAssistantMessageId: currentAssistant.id,
    };
    const baseline = await manager.prepare(preparation("auto_pre_turn", {
      ...common,
      requestIndex: 0,
    }));
    const retainedMessages: ModelMessage[] = [{
      role: "assistant",
      content: "EXACT_RETAINED_MODEL_RESPONSE",
    }];
    const retained = await manager.prepare(preparation("auto_pre_turn", {
      ...common,
      requestIndex: 1,
      retainedMessages,
    }));

    expect(JSON.stringify(retained.messages)).not.toContain(
      "CURRENT_ASSISTANT_MUST_NOT_REPLAY",
    );
    expect(retained.messages.at(-1)).toBe(retainedMessages[0]);
    expect(retained.plan.budget.rawHistoryTokens).toBeGreaterThan(
      baseline.plan.budget.rawHistoryTokens,
    );
    await expect(manager.prepare(preparation("auto_pre_turn", {
      ...common,
      requestIndex: 1,
      retainedMessages: [{ role: "assistant", content: "CHANGED_RETAINED_RESPONSE" }],
    }))).rejects.toThrow("does not match the durable Context plan");
    db.close();
  });

  test("rethrows an already-aborted reason before any Store access or derived writes", async () => {
    const { db, store } = createHistory();
    const storeAccesses: string[] = [];
    const instrumentedStore = new Proxy(store as RuntimeRunnerStore, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          storeAccesses.push(String(property));
          return value.apply(target, args);
        };
      },
    });
    const ids = deterministicIds();
    const service = new ContextCompactionService({
      store: instrumentedStore,
      generator: async () => ({ text: "must not be called" }),
      createId: ids,
    });
    const manager = new ModelContextManager({
      store: instrumentedStore,
      compactionService: service,
      createId: ids,
    });
    const abortReason = new Error("cancel before prepare");
    const controller = new AbortController();
    controller.abort(abortReason);

    try {
      await manager.prepare(preparation("auto_pre_turn", { abortSignal: controller.signal }));
      throw new Error("Expected preparation to abort");
    } catch (error) {
      expect(error).toBe(abortReason);
    }
    expect(storeAccesses).toEqual([]);
    expect(store.listContextPlansByRun("run_c")).toEqual([]);
    expect(store.listContextCheckpoints("conv_compaction")).toEqual([]);
    expect(store.listEvents("conv_compaction")).toEqual([]);
    db.close();
  });

  test("rethrows an exact generator AbortError instead of auto raw fallback", async () => {
    const { db, store } = createHistory();
    const abortError = new DOMException("summary cancelled", "AbortError");
    const ids = deterministicIds();
    const service = new ContextCompactionService({
      store,
      generator: async () => { throw abortError; },
      createId: ids,
    });
    const manager = new ModelContextManager({ store, compactionService: service, createId: ids });

    try {
      await manager.prepare(preparation("auto_pre_turn"));
      throw new Error("Expected summary generation to abort");
    } catch (error) {
      expect(error).toBe(abortError);
    }
    expect(store.listContextPlansByRun("run_c")).toEqual([]);
    expect(store.listContextCheckpoints("conv_compaction")).toEqual([]);
    expectCompactionAttempts(store, [{ attemptIndex: 0, status: "interrupted" }]);
    db.close();
  });

  test.each([
    ["auto under hard", "auto_pre_turn" as const, false],
    ["manual", "manual" as const, false],
    ["auto over hard", "auto_pre_turn" as const, true],
  ] as const)("treats timeout as non-cancellation for %s", async (_name, trigger, overHard) => {
    const { db, store } = createHistory();
    if (overHard) {
      for (const messageId of ["msg_user_a", "msg_assistant_a"] as const) {
        const message = store.getMessage(messageId);
        if (!message) throw new Error(`Missing ${messageId}`);
        store.saveMessage({
          ...message,
          parts: message.parts.map((part) =>
            part.type === "text" ? { ...part, text: "z".repeat(5_000) } : part,
          ),
        });
      }
    }
    const timeoutError = new Error("summary timed out");
    timeoutError.name = "TimeoutError";
    const ids = deterministicIds();
    const service = new ContextCompactionService({
      store,
      generator: async () => { throw timeoutError; },
      createId: ids,
    });
    const manager = new ModelContextManager({ store, compactionService: service, createId: ids });
    const operation = manager.prepare(preparation(trigger, {
      contextWindow: overHard ? 3_000 : 4_096,
    }));

    try {
      await operation;
      throw new Error("Expected timeout to propagate");
    } catch (error) {
      expect(error).toBe(timeoutError);
    }
    expect(store.listContextCheckpoints("conv_compaction")).toEqual([]);
    db.close();
  });

  test("reuses one durable plan for sequential duplicate preparation", async () => {
    const { db, store } = createHistory();
    let generatorCalls = 0;
    const ids = deterministicIds();
    const service = new ContextCompactionService({
      store,
      generator: async () => {
        generatorCalls += 1;
        return { text: "CHECKPOINT_ONCE" };
      },
      now: () => 100,
      createId: ids,
    });
    const manager = new ModelContextManager({ store, compactionService: service, createId: ids });

    const first = await manager.prepare(preparation());
    const second = await manager.prepare(preparation());

    expect(second.plan).toEqual(first.plan);
    expect(second.messages).toEqual(first.messages);
    expect(generatorCalls).toBe(1);
    expect(store.listContextPlansByRun("run_c")).toEqual([first.plan]);
    expect(store.listContextCheckpoints("conv_compaction")).toHaveLength(1);
    expectCompactionAttempts(store, [{ attemptIndex: 0, status: "created" }]);
    expectEventTypeCount(store, "context.checkpoint.created", 1);
    expectEventTypeCount(store, "context.plan.created", 1);
    db.close();
  });

  test("coalesces concurrent duplicate preparation onto the same Promise", async () => {
    const { db, store } = createHistory();
    let generatorCalls = 0;
    const ids = deterministicIds();
    const service = new ContextCompactionService({
      store,
      generator: async () => {
        generatorCalls += 1;
        await Promise.resolve();
        return { text: "CONCURRENT_CHECKPOINT_ONCE" };
      },
      now: () => 100,
      createId: ids,
    });
    const manager = new ModelContextManager({ store, compactionService: service, createId: ids });

    const firstOperation = manager.prepare(preparation());
    const secondOperation = manager.prepare(preparation());
    const sameOperation = firstOperation === secondOperation;
    const [first, second] = await Promise.all([firstOperation, secondOperation]);

    expect(sameOperation).toBe(true);
    expect(second).toEqual(first);
    expect(generatorCalls).toBe(1);
    expect(store.listContextPlansByRun("run_c")).toHaveLength(1);
    expect(store.listContextCheckpoints("conv_compaction")).toHaveLength(1);
    expectCompactionAttempts(store, [{ attemptIndex: 0, status: "created" }]);
    expectEventTypeCount(store, "context.checkpoint.created", 1);
    expectEventTypeCount(store, "context.plan.created", 1);
    db.close();
  });

  test("coalesces independent Managers, Services, and Store wrappers with one marker", async () => {
    const { db, store } = createHistory();
    const secondStore = new RuntimeSqliteStore(db);
    let generatorCalls = 0;
    let announceStarted!: () => void;
    let releaseBarrier!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    const generator: ContextSummaryGenerator = async () => {
      generatorCalls += 1;
      announceStarted();
      await barrier;
      return { text: "CROSS_MANAGER_CHECKPOINT_ONCE" };
    };
    const ids = deterministicIds();
    const firstManager = new ModelContextManager({
      store,
      compactionService: new ContextCompactionService({ store, generator, now: () => 100, createId: ids }),
      createId: ids,
    });
    const secondManager = new ModelContextManager({
      store: secondStore,
      compactionService: new ContextCompactionService({
        store: secondStore,
        generator,
        now: () => 100,
        createId: ids,
      }),
      createId: ids,
    });

    const firstOperation = firstManager.prepare(preparation());
    await started;
    const secondOperation = secondManager.prepare(preparation());
    const sameOperation = firstOperation === secondOperation;
    await Promise.resolve();
    releaseBarrier();
    const settled = await Promise.allSettled([firstOperation, secondOperation]);

    expect(sameOperation).toBe(true);
    expect(settled[0]?.status).toBe("fulfilled");
    expect(settled[1]).toEqual(settled[0]);
    expect(generatorCalls).toBe(1);
    expect(store.listContextPlansByRun("run_c")).toHaveLength(1);
    expect(store.listContextCheckpoints("conv_compaction")).toHaveLength(1);
    expectCompactionAttempts(store, [{ attemptIndex: 0, status: "created" }]);
    expectEventTypeCount(store, "context.checkpoint.created", 1);
    expectEventTypeCount(store, "context.plan.created", 1);
    expect(store.getContextPreparationClaim("run_c", 0)).toBeNull();
    db.close();
  });

  test("rejects a different request identity while an exact preparation is in progress", async () => {
    const { db, store } = createHistory();
    let generatorCalls = 0;
    let announceStarted!: () => void;
    let releaseBarrier!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    const generator: ContextSummaryGenerator = async () => {
      generatorCalls += 1;
      announceStarted();
      await barrier;
      return { text: "IDENTITY_CLAIM_CHECKPOINT" };
    };
    const ids = deterministicIds();
    const firstManager = new ModelContextManager({
      store,
      compactionService: new ContextCompactionService({ store, generator, createId: ids }),
      createId: ids,
    });
    const secondManager = new ModelContextManager({
      store,
      compactionService: new ContextCompactionService({ store, generator, createId: ids }),
      createId: ids,
    });
    const firstOperation = firstManager.prepare(preparation());
    await started;
    const secondOperation = secondManager.prepare(preparation("auto_pre_turn", {
      systemPrompt: "different system prompt",
    }));
    await Promise.resolve();
    releaseBarrier();
    const [first, second] = await Promise.allSettled([firstOperation, secondOperation]);

    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    expect(second.status === "rejected" ? String(second.reason) : "").toContain(
      "does not match the durable Context plan",
    );
    expect(generatorCalls).toBe(1);
    expect(store.listContextCheckpoints("conv_compaction")).toHaveLength(1);
    expectCompactionAttempts(store, [{ attemptIndex: 0, status: "created" }]);
    expectEventTypeCount(store, "context.checkpoint.created", 1);
    expectEventTypeCount(store, "context.plan.created", 1);
    db.close();
  });

  test("shares a winner failure, releases its claim, and permits one retry", async () => {
    const { db, store } = createHistory();
    const firstError = new Error("first preparation failed");
    let generatorCalls = 0;
    const generator: ContextSummaryGenerator = async () => {
      generatorCalls += 1;
      if (generatorCalls === 1) throw firstError;
      return { text: "RETRY_AFTER_RELEASE" };
    };
    const ids = deterministicIds();
    const firstManager = new ModelContextManager({
      store,
      compactionService: new ContextCompactionService({ store, generator, createId: ids }),
      createId: ids,
    });
    const secondManager = new ModelContextManager({
      store,
      compactionService: new ContextCompactionService({ store, generator, createId: ids }),
      createId: ids,
    });

    const firstOperation = firstManager.prepare(preparation("manual"));
    const secondOperation = secondManager.prepare(preparation("manual"));
    const firstAttempt = await Promise.allSettled([firstOperation, secondOperation]);

    expect(firstOperation === secondOperation).toBe(true);
    expect(firstAttempt).toEqual([
      { status: "rejected", reason: firstError },
      { status: "rejected", reason: firstError },
    ]);
    expect(store.getContextPreparationClaim("run_c", 0)).toBeNull();

    const retried = await secondManager.prepare(preparation("manual"));
    expect(retried.marker?.status).toBe("created");
    expect(generatorCalls).toBe(2);
    expect(store.listContextPlansByRun("run_c")).toHaveLength(1);
    expect(store.listContextCheckpoints("conv_compaction")).toHaveLength(1);
    expectCompactionAttempts(store, [
      { attemptIndex: 0, status: "failed" },
      { attemptIndex: 1, status: "created" },
    ]);
    expectEventTypeCount(store, "context.checkpoint.created", 1);
    expectEventTypeCount(store, "context.plan.created", 1);
    expect(store.getContextPreparationClaim("run_c", 0)).toBeNull();
    db.close();
  });

  test.each([
    ["nonexpired exact", false],
    ["different request hash", true],
  ] as const)("does not generate for a foreign %s durable claim", async (_name, differentHash) => {
    let clock = 100;
    const { db, store } = createHistory(":memory:", { now: () => clock });
    const input = preparation();
    const requestHash = computeContextPlanRequestHash(input);
    expect(store.claimContextPreparation({
      runId: input.runId,
      requestIndex: input.requestIndex,
      requestHash: differentHash ? `sha256:${"f".repeat(64)}` : requestHash,
      ownerId: "foreign_owner",
      ttlMs: 200,
    }).status).toBe("acquired");
    clock = 150;
    let generatorCalls = 0;
    const ids = deterministicIds();
    const manager = new ModelContextManager({
      store,
      compactionService: new ContextCompactionService({
        store,
        generator: async () => {
          generatorCalls += 1;
          return { text: "must not generate" };
        },
        createId: ids,
      }),
      now: () => clock,
      createId: ids,
    });

    const result = await Promise.allSettled([manager.prepare(input)]);

    expect(result[0]?.status).toBe("rejected");
    expect(result[0]?.status === "rejected" ? String(result[0].reason) : "").toContain(
      differentHash ? "does not match" : "already in progress",
    );
    expect(generatorCalls).toBe(0);
    expect(store.listContextPlansByRun("run_c")).toEqual([]);
    expect(store.listContextCheckpoints("conv_compaction")).toEqual([]);
    expect(store.listEvents("conv_compaction")).toEqual([]);
    db.close();
  });

  test("reclaims an expired durable claim before generation", async () => {
    let clock = 50;
    const { db, store } = createHistory(":memory:", { now: () => clock });
    const input = preparation();
    expect(store.claimContextPreparation({
      runId: input.runId,
      requestIndex: input.requestIndex,
      requestHash: computeContextPlanRequestHash(input),
      ownerId: "expired_owner",
      ttlMs: 50,
    }).status).toBe("acquired");
    clock = 100;
    let generatorCalls = 0;
    const ids = deterministicIds();
    const manager = new ModelContextManager({
      store,
      compactionService: new ContextCompactionService({
        store,
        generator: async () => {
          generatorCalls += 1;
          return { text: "EXPIRED_CLAIM_RECLAIMED" };
        },
        createId: ids,
      }),
      now: () => clock,
      createId: ids,
    });

    const prepared = await manager.prepare(input);

    expect(prepared.marker?.status).toBe("created");
    expect(generatorCalls).toBe(1);
    expect(store.getContextPreparationClaim("run_c", 0)).toBeNull();
    db.close();
  });

  test("renews one owner across rolling summaries beyond the initial five-minute lease", async () => {
    let clock = 100;
    const { db, store } = createHistory(":memory:", { now: () => clock });
    const user = store.getMessage("msg_user_a");
    if (!user || user.role !== "user") throw new Error("Missing User fixture");
    const hugeText = `BEGIN_${Array.from({ length: 5_000 }, (_, index) =>
      `${index.toString().padStart(4, "0")}🙂`).join("")}_END`;
    store.saveMessage({
      ...user,
      parts: [{ ...user.parts[0]!, type: "text", text: hugeText }],
    });
    let generatorCalls = 0;
    const observedClaims: ContextPreparationClaim[] = [];
    const ids = deterministicIds();
    const manager = new ModelContextManager({
      store,
      compactionService: new ContextCompactionService({
        store,
        generator: async () => {
          generatorCalls += 1;
          const active = store.getContextPreparationClaim("run_c", 0);
          expect(active?.expiresAt).toBeGreaterThan(clock);
          if (active) observedClaims.push(active);
          clock += 4 * 60 * 1_000;
          return { text: `LEASED_ROLLING_SUMMARY_${generatorCalls}` };
        },
        now: () => clock,
        createId: ids,
      }),
      now: () => clock,
      createId: ids,
    });

    const prepared = await manager.prepare(preparation("manual", { contextWindow: 4_096 }));

    expect(generatorCalls).toBeGreaterThan(1);
    expect(clock).toBeGreaterThan(5 * 60 * 1_000);
    expect(new Set(observedClaims.map((claim) => claim.ownerId)).size).toBe(1);
    expect(new Set(observedClaims.map((claim) => claim.fencingToken))).toEqual(new Set([1]));
    expect(prepared.marker?.status).toBe("created");
    expect(store.listContextCheckpoints("conv_compaction")).toHaveLength(1);
    expect(store.listContextPlansByRun("run_c")).toEqual([prepared.plan]);
    expect(store.getContextPreparationClaim("run_c", 0)).toBeNull();
    db.close();
  });

  test("fails closed when one summary invocation consumes the entire renewed lease", async () => {
    let clock = 100;
    const { db, store } = createHistory(":memory:", { now: () => clock });
    const ids = deterministicIds();
    const manager = new ModelContextManager({
      store,
      compactionService: new ContextCompactionService({
        store,
        generator: async () => {
          clock += 5 * 60 * 1_000;
          return { text: "TOO_LATE_SUMMARY" };
        },
        now: () => clock,
        createId: ids,
      }),
      now: () => clock,
      createId: ids,
    });

    await expect(manager.prepare(preparation("manual"))).rejects.toBeInstanceOf(
      ContextPreparationLeaseLostError,
    );
    expect(store.listContextCheckpoints("conv_compaction")).toEqual([]);
    expect(store.listContextPlansByRun("run_c")).toEqual([]);
    expectCompactionAttempts(store, [{ attemptIndex: 0, status: "interrupted" }]);
    expect(store.getContextPreparationClaim("run_c", 0)).toBeNull();
    db.close();
  });

  test("preserves the exact generator failure when its invocation outlives the lease", async () => {
    let clock = 100;
    const providerError = new Error("summary provider failed after lease expiry");
    const { db, store } = createHistory(":memory:", { now: () => clock });
    const ids = deterministicIds();
    const manager = new ModelContextManager({
      store,
      compactionService: new ContextCompactionService({
        store,
        generator: async () => {
          clock += 5 * 60 * 1_000;
          throw providerError;
        },
        now: () => clock,
        createId: ids,
      }),
      now: () => clock,
      createId: ids,
    });

    await expect(manager.prepare(preparation("manual"))).rejects.toBe(providerError);
    expect(store.listContextCheckpoints("conv_compaction")).toEqual([]);
    expect(store.listContextPlansByRun("run_c")).toEqual([]);
    expectCompactionAttempts(store, [{ attemptIndex: 0, status: "failed" }]);
    db.close();
  });

  test("fences a live old owner after its expired claim is reclaimed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexuspilot-context-fence-"));
    const path = join(directory, "runtime.sqlite");
    let firstDb: ReturnType<typeof openRuntimeDatabase> | undefined;
    let secondDb: ReturnType<typeof openRuntimeDatabase> | undefined;
    let restartDb: ReturnType<typeof openRuntimeDatabase> | undefined;
    try {
      let clock = 100;
      const first = createHistory(path, { now: () => clock });
      firstDb = first.db;
      secondDb = openRuntimeDatabase(path);
      const secondStore = new RuntimeSqliteStore(secondDb, { now: () => clock });
      let firstStarted!: () => void;
      let releaseFirst!: () => void;
      let secondStarted!: () => void;
      let releaseSecond!: () => void;
      const firstGeneratorStarted = new Promise<void>((resolve) => { firstStarted = resolve; });
      const firstGeneratorBarrier = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const secondGeneratorStarted = new Promise<void>((resolve) => { secondStarted = resolve; });
      const secondGeneratorBarrier = new Promise<void>((resolve) => { releaseSecond = resolve; });
      const ids = deterministicIds();
      const firstManager = new ModelContextManager({
        store: first.store,
        compactionService: new ContextCompactionService({
          store: first.store,
          generator: async () => {
            firstStarted();
            await firstGeneratorBarrier;
            return { text: "STALE_OWNER_SUMMARY" };
          },
          now: () => clock,
          createId: ids,
        }),
        now: () => clock,
        createId: ids,
      });
      const secondManager = new ModelContextManager({
        store: secondStore,
        compactionService: new ContextCompactionService({
          store: secondStore,
          generator: async () => {
            secondStarted();
            await secondGeneratorBarrier;
            return { text: "WINNING_OWNER_SUMMARY" };
          },
          now: () => clock,
          createId: ids,
        }),
        now: () => clock,
        createId: ids,
      });

      const firstOperation = firstManager.prepare(preparation());
      await firstGeneratorStarted;
      clock += 5 * 60 * 1_000;
      const secondOperation = secondManager.prepare(preparation());
      await secondGeneratorStarted;

      releaseFirst();
      const firstResult = await Promise.allSettled([firstOperation]);
      const winningClaimAfterOldRelease = secondStore.getContextPreparationClaim("run_c", 0);
      releaseSecond();
      const secondResult = await Promise.allSettled([secondOperation]);

      expect(firstResult[0]?.status).toBe("rejected");
      expect(firstResult[0]?.status === "rejected" ? firstResult[0].reason : undefined).toBeInstanceOf(
        ContextPreparationLeaseLostError,
      );
      expect(winningClaimAfterOldRelease?.ownerId).not.toBeUndefined();
      expect(winningClaimAfterOldRelease?.fencingToken).toBe(2);
      expect(secondResult[0]?.status).toBe("fulfilled");
      const winner = secondResult[0]?.status === "fulfilled" ? secondResult[0].value : undefined;
      if (!winner) throw new Error("Expected the reclaimed owner to complete preparation");
      const checkpoints = secondStore.listContextCheckpoints("conv_compaction");
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]?.summary).toBe("WINNING_OWNER_SUMMARY");
      expectCompactionAttempts(secondStore, [
        { attemptIndex: 0, status: "interrupted" },
        { attemptIndex: 1, status: "created" },
      ]);
      expectEventTypeCount(secondStore, "context.checkpoint.created", 1);
      expectEventTypeCount(secondStore, "context.plan.created", 1);
      expect(secondStore.listContextPlansByRun("run_c")).toHaveLength(1);
      expect(winner.marker?.checkpointId).toBe(checkpoints[0]?.id);
      expect(secondStore.getContextPreparationClaim("run_c", 0)).toBeNull();

      first.store.close();
      firstDb = undefined;
      secondStore.close();
      secondDb = undefined;
      Bun.gc(true);
      await Bun.sleep(50);
      restartDb = openRuntimeDatabase(path);
      const restartStore = new RuntimeSqliteStore(restartDb, { now: () => clock });
      let restartGeneratorCalls = 0;
      const restarted = new ModelContextManager({
        store: restartStore,
        compactionService: new ContextCompactionService({
          store: restartStore,
          generator: async () => {
            restartGeneratorCalls += 1;
            return { text: "MUST_NOT_REGENERATE" };
          },
          now: () => clock,
          createId: ids,
        }),
        now: () => clock,
        createId: ids,
      });
      const reused = await restarted.prepare(preparation());
      expect(reused.plan).toEqual(winner.plan);
      expect(restartGeneratorCalls).toBe(0);
    } finally {
      try { firstDb?.close(); } catch { /* already closed */ }
      firstDb = undefined;
      try { secondDb?.close(); } catch { /* already closed */ }
      secondDb = undefined;
      try { restartDb?.close(); } catch { /* already closed */ }
      restartDb = undefined;
      Bun.gc(true);
      await Bun.sleep(50);
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  test("reuses a durable plan after the manager is recreated", async () => {
    const { db, store } = createHistory();
    let generatorCalls = 0;
    const ids = deterministicIds();
    const service = new ContextCompactionService({
      store,
      generator: async () => {
        generatorCalls += 1;
        return { text: "RESTART_SAFE_CHECKPOINT" };
      },
      now: () => 100,
      createId: ids,
    });
    const firstManager = new ModelContextManager({ store, compactionService: service, createId: ids });
    const first = await firstManager.prepare(preparation());
    const restartedManager = new ModelContextManager({
      store,
      compactionService: service,
      createId: ids,
    });

    const second = await restartedManager.prepare(preparation());

    expect(second.plan).toEqual(first.plan);
    expect(generatorCalls).toBe(1);
    expect(store.listContextPlansByRun("run_c")).toEqual([first.plan]);
    expect(store.listContextCheckpoints("conv_compaction")).toHaveLength(1);
    expectCompactionAttempts(store, [{ attemptIndex: 0, status: "created" }]);
    expectEventTypeCount(store, "context.checkpoint.created", 1);
    expectEventTypeCount(store, "context.plan.created", 1);
    db.close();
  });

  test("rejects duplicate preparation whose input identity differs", async () => {
    const { db, store } = createHistory();
    const ids = deterministicIds();
    const service = new ContextCompactionService({
      store,
      generator: async () => ({ text: "IDENTITY_CHECKPOINT" }),
      now: () => 100,
      createId: ids,
    });
    const manager = new ModelContextManager({ store, compactionService: service, createId: ids });
    await manager.prepare(preparation());

    await expect(
      manager.prepare(preparation("auto_pre_turn", { systemPrompt: "changed system prompt" })),
    ).rejects.toThrow("does not match the durable Context plan");
    expect(store.listContextPlansByRun("run_c")).toHaveLength(1);
    expect(store.listContextCheckpoints("conv_compaction")).toHaveLength(1);
    db.close();
  });

  test("recovers an exact durable plan after a cross-manager unique race", async () => {
    const { db, store } = createHistory();
    let generatorCalls = 0;
    const ids = deterministicIds();
    const firstService = new ContextCompactionService({
      store,
      generator: async () => {
        generatorCalls += 1;
        return { text: "RACE_WINNER_CHECKPOINT" };
      },
      now: () => 100,
      createId: ids,
    });
    const firstManager = new ModelContextManager({
      store,
      compactionService: firstService,
      createId: ids,
    });
    const first = await firstManager.prepare(preparation());
    let hideFirstExactLookup = true;
    const racingStore = new Proxy(store as RuntimeRunnerStore, {
      get(target, property) {
        if (property === "getContextPlanByRunRequest") {
          return (runId: RunId, requestIndex: number) => {
            if (hideFirstExactLookup) {
              hideFirstExactLookup = false;
              return null;
            }
            return target.getContextPlanByRunRequest(runId, requestIndex);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const secondService = new ContextCompactionService({
      store: racingStore,
      generator: async () => {
        throw new Error("existing checkpoint should avoid generation");
      },
      createId: ids,
    });
    const secondManager = new ModelContextManager({
      store: racingStore,
      compactionService: secondService,
      createId: ids,
    });

    const second = await secondManager.prepare(preparation());

    expect(second.plan).toEqual(first.plan);
    expect(generatorCalls).toBe(1);
    expect(store.listContextPlansByRun("run_c")).toEqual([first.plan]);
    expect(store.listContextCheckpoints("conv_compaction")).toHaveLength(1);
    expectCompactionAttempts(store, [{ attemptIndex: 0, status: "created" }]);
    expectEventTypeCount(store, "context.checkpoint.created", 1);
    expectEventTypeCount(store, "context.plan.created", 1);
    db.close();
  });

  test("rethrows non-unique Store failures without treating them as duplicate preparation", async () => {
    const { db, store } = createHistory();
    const storageError = new Error("disk write failed");
    const failingStore = new Proxy(store as RuntimeRunnerStore, {
      get(target, property) {
        if (property === "getContextPlanByRunRequest") return () => null;
        if (property === "saveContextPlan") return () => { throw storageError; };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const ids = deterministicIds();
    const service = new ContextCompactionService({
      store: failingStore,
      generator: async () => ({ text: "must not be needed" }),
      createId: ids,
    });
    const manager = new ModelContextManager({
      store: failingStore,
      compactionService: service,
      createId: ids,
    });

    await expect(manager.prepare(preparation("auto_pre_turn", {
      contextWindow: 100_000,
    }))).rejects.toBe(storageError);

    expect(store.listContextPlansByRun("run_c")).toEqual([]);
    expect(store.listContextCheckpoints("conv_compaction")).toEqual([]);
    db.close();
  });

  test("persists the plan before attachment projection and reuses it on retry", async () => {
    const { db, store } = createHistory();
    const attachmentStore = new RuntimeAttachmentSqliteStore(db);
    attachmentStore.createUpload({
      id: "upl_retry",
      filename: "retry.txt",
      declaredMediaType: "text/plain",
      declaredByteLength: 1,
      state: "pending",
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 10_000,
    });
    attachmentStore.completeUpload({
      uploadId: "upl_retry",
      attachment: {
        id: "att_retry",
        blobId: "blob_retry",
        filename: "retry.txt",
        declaredMediaType: "text/plain",
        mediaType: "text/plain",
        byteLength: 1,
        state: "ready",
        createdAt: 1,
        updatedAt: 1,
      },
      blob: {
        id: "blob_retry",
        sha256: "a".repeat(64),
        byteLength: 1,
        storageKey: "retry-storage-key",
        state: "available",
        createdAt: 1,
        verifiedAt: 1,
      },
      now: 1,
    });
    const user = store.getMessage("msg_user_b");
    if (!user || user.role !== "user") throw new Error("Missing user attachment fixture");
    store.saveMessage({
      ...user,
      parts: [
        ...user.parts,
        {
          id: "part_file_b",
          conversationId: user.conversationId,
          messageId: user.id,
          type: "file",
          attachmentId: "att_retry",
          mediaType: "text/plain",
          filename: "retry.txt",
          byteLength: 1,
        },
      ],
    });
    let generatorCalls = 0;
    let attachmentReads = 0;
    const attachmentError = new Error("attachment temporarily unavailable");
    const attachmentService = {
      async readBytes(): Promise<Uint8Array> {
        attachmentReads += 1;
        if (attachmentReads === 1) throw attachmentError;
        return new Uint8Array([65]);
      },
    } as unknown as RuntimeAttachmentService;
    const ids = deterministicIds();
    const service = new ContextCompactionService({
      store,
      generator: async () => {
        generatorCalls += 1;
        return { text: "ATTACHMENT_RETRY_CHECKPOINT" };
      },
      now: () => 100,
      createId: ids,
    });
    const manager = new ModelContextManager({
      store,
      compactionService: service,
      attachmentService,
      createId: ids,
    });

    await expect(manager.prepare(preparation())).rejects.toBe(attachmentError);
    expect(store.listContextPlansByRun("run_c")).toHaveLength(1);
    const retried = await manager.prepare(preparation());

    expect(retried.plan).toEqual(store.getContextPlanByRunRequest("run_c", 0)!);
    expect(generatorCalls).toBe(1);
    expect(attachmentReads).toBe(2);
    expect(store.listContextPlansByRun("run_c")).toHaveLength(1);
    expect(store.listContextCheckpoints("conv_compaction")).toHaveLength(1);
    expectCompactionAttempts(store, [{ attemptIndex: 0, status: "created" }]);
    expectEventTypeCount(store, "context.checkpoint.created", 1);
    expectEventTypeCount(store, "context.plan.created", 1);
    db.close();
  });

  test("throws stale instead of rebinding the request when generation changes the active head", async () => {
    const { db, store, conversation } = createHistory();
    let generatorCalls = 0;
    const ids = deterministicIds();
    const service = new ContextCompactionService({
      store,
      generator: async () => {
        generatorCalls += 1;
        saveRunPair(store, {
          conversationId: conversation.id,
          runId: "run_e",
          parentRunId: "run_b",
          created: 50,
          status: "running",
          userText: "NEW_HEAD_USER",
          assistantText: "",
        });
        store.saveConversation({
          ...conversation,
          activeHeadRunId: "run_e",
          status: { type: "busy", runId: "run_e" },
          revision: 4,
          time: { ...conversation.time, updated: 50 },
        });
        return { text: "STALE_HEAD_SUMMARY" };
      },
      now: () => 100,
      createId: ids,
    });
    const manager = new ModelContextManager({ store, compactionService: service, createId: ids });

    await expect(manager.prepare(preparation())).rejects.toBeInstanceOf(
      ContextPreparationStaleError,
    );

    expect(generatorCalls).toBe(1);
    expect(store.getContextPlanByRunRequest("run_c", 0)).toBeNull();
    expect(store.getContextPlanByRunRequest("run_e", 0)).toBeNull();
    expect(store.listContextCheckpoints("conv_compaction")).toEqual([]);
    expectCompactionAttempts(store, [{ attemptIndex: 0, status: "interrupted" }]);
    db.close();
  });

  test("fails instead of raw fallback when source state becomes stale during compaction", async () => {
    const { db, store } = createHistory();
    let generatorCalls = 0;
    const ids = deterministicIds();
    const service = new ContextCompactionService({
      store,
      generator: async () => {
        generatorCalls += 1;
        persistCompletedToolPair(store);
        return { text: "STALE_SOURCE_SUMMARY" };
      },
      now: () => 100,
      createId: ids,
    });
    const manager = new ModelContextManager({ store, compactionService: service, createId: ids });

    await expect(manager.prepare(preparation())).rejects.toThrow(
      "Context compaction did not produce a model view within the hard budget",
    );
    expect(generatorCalls).toBe(1);
    expect(store.listContextPlansByRun("run_c")).toEqual([]);
    expect(store.listContextCheckpoints("conv_compaction")).toEqual([]);
    expectCompactionAttempts(store, [{ attemptIndex: 0, status: "interrupted" }]);
    db.close();
  });

  test("creates through the service, reloads Store state, and assembles checkpoint then Safety State then raw tail", async () => {
    const { db, store } = createHistory();
    const ids = deterministicIds();
    const service = new ContextCompactionService({
      store,
      generator: async () => ({ text: "CHECKPOINT_MEMORY" }),
      now: () => 100,
      createId: ids,
    });
    const manager = new ModelContextManager({
      store,
      compactionService: service,
      now: () => 101,
      createId: ids,
    });

    const prepared = await manager.prepare(preparation());

    expect(prepared.plan.reason).toBe("checkpoint_selected");
    expect(prepared.plan.checkpointId).toBeDefined();
    expect(prepared.instructions[0]).toMatchObject({ role: "system" });
    expect(JSON.stringify(prepared.instructions[0])).toContain("CHECKPOINT_MEMORY");
    expect(prepared.instructions[1]).toMatchObject({ role: "system" });
    expect(JSON.stringify(prepared.instructions[1])).toContain("Runtime Safety State");
    expect(prepared.messages.every((message) => message.role !== "system")).toBe(true);
    expect(JSON.stringify(prepared.messages)).toContain("recent user");
    expect(JSON.stringify(prepared.messages)).toContain("CURRENT_USER_MUST_STAY_RAW");
    expect(JSON.stringify(prepared.messages)).not.toContain("OLD_USER_");
    expect(prepared.marker).toMatchObject({
      trigger: "auto_pre_turn",
      coverageThroughRunId: "run_a",
      status: "created",
    });
    expect(store.listContextPlansByRun("run_c")).toEqual([prepared.plan]);
    db.close();
  });

  test("rehydrates the complete raw active lineage when a larger target window fits", async () => {
    const { db, store } = createHistory();
    const ids = deterministicIds();
    const service = new ContextCompactionService({
      store,
      generator: async () => ({ text: "CHECKPOINT_THAT_SHOULD_NOT_WIN" }),
      now: () => 100,
      createId: ids,
    });
    expect(await compactClaimed(store, service, request("manual"))).toMatchObject({ status: "created" });
    const manager = new ModelContextManager({ store, compactionService: service, createId: ids });

    const prepared = await manager.prepare(preparation("auto_pre_turn", {
      contextWindow: 100_000,
    }));

    expect(prepared.plan.view).toBe("raw");
    expect(prepared.plan.rawRunIds).toEqual(["run_a", "run_b", "run_c"]);
    expect(JSON.stringify(prepared.messages)).toContain("OLD_USER_");
    expect(JSON.stringify(prepared.messages)).not.toContain("CHECKPOINT_THAT_SHOULD_NOT_WIN");
    db.close();
  });

  test("does not use a checkpoint after the active head branches before its coverage", async () => {
    const { db, store, conversation } = createHistory();
    const ids = deterministicIds();
    const service = new ContextCompactionService({
      store,
      generator: async () => ({ text: "OLD_BRANCH_CHECKPOINT" }),
      now: () => 100,
      createId: ids,
    });
    expect(await compactClaimed(store, service, request("manual"))).toMatchObject({ status: "created" });
    saveRunPair(store, {
      conversationId: conversation.id,
      runId: "run_e",
      parentRunId: undefined,
      created: 50,
      status: "running",
      userText: "EDITED_SHORT_BRANCH",
      assistantText: "",
    });
    store.saveConversation({
      ...conversation,
      activeHeadRunId: "run_e",
      status: { type: "busy", runId: "run_e" },
      revision: 4,
      time: { ...conversation.time, updated: 50 },
    });
    const manager = new ModelContextManager({ store, compactionService: service, createId: ids });

    const prepared = await manager.prepare(preparation("auto_pre_turn", {
      runId: "run_e",
      contextWindow: 100_000,
    }));

    expect(prepared.plan.view).toBe("raw");
    expect(prepared.plan.rawRunIds).toEqual(["run_e"]);
    expect(JSON.stringify(prepared.messages)).toContain("EDITED_SHORT_BRANCH");
    expect(JSON.stringify(prepared.messages)).not.toContain("OLD_BRANCH_CHECKPOINT");
    db.close();
  });

  test("auto pre-turn surfaces a summary failure even while raw remains within the hard budget", async () => {
    const { db, store } = createHistory();
    const summaryError = new Error("summary provider failed\nrequest id: exact");
    const ids = deterministicIds();
    const service = new ContextCompactionService({
      store,
      generator: async () => { throw summaryError; },
      createId: ids,
    });
    const manager = new ModelContextManager({ store, compactionService: service, createId: ids });

    try {
      await manager.prepare(preparation("auto_pre_turn"));
      throw new Error("Expected summary generation to fail");
    } catch (error) {
      expect(error).toBe(summaryError);
    }
    expect(store.listContextPlansByRun("run_c")).toEqual([]);
    expect(store.listContextCheckpoints("conv_compaction")).toEqual([]);
    db.close();
  });

  test.each([
    [
      "soft-triggered pre-turn",
      "auto_pre_turn" as const,
      0,
      undefined,
      4_096,
      "CONTEXT_SOFT_TRIGGER_REACHED_WITHOUT_SAFE_BOUNDARY" as const,
    ],
    [
      "soft-triggered mid-turn",
      "auto_mid_turn" as const,
      1,
      1,
      4_096,
      "CONTEXT_SOFT_TRIGGER_REACHED_WITHOUT_SAFE_BOUNDARY" as const,
    ],
    [
      "hard-budget pre-turn",
      "auto_pre_turn" as const,
      0,
      undefined,
      500,
      "CONTEXT_HARD_BUDGET_EXCEEDED_WITHOUT_SAFE_BOUNDARY" as const,
    ],
    [
      "hard-budget mid-turn",
      "auto_mid_turn" as const,
      1,
      1,
      500,
      "CONTEXT_HARD_BUDGET_EXCEEDED_WITHOUT_SAFE_BOUNDARY" as const,
    ],
  ])(
    "fails a %s gate with a durable Activity when no safe boundary exists",
    async (
      _name,
      trigger,
      requestIndex,
      activityBoundaryStepIndex,
      contextWindow,
      expectedCode,
    ) => {
      const { db, store } = createHistory();
      const ids = deterministicIds();
      let summaryCalls = 0;
      const service = new ContextCompactionService({
        store,
        generator: async () => {
          summaryCalls += 1;
          return { text: "must not run" };
        },
        now: () => 100,
        createId: ids,
      });
      const manager = new ModelContextManager({
        store,
        compactionService: service,
        now: () => 100,
        createId: ids,
      });
      const input = preparation(trigger, {
        requestIndex,
        activityBoundaryStepIndex,
        contextWindow,
      });

      try {
        await manager.prepare({
          ...input,
          policy: { ...input.policy, minRawRuns: 3 },
        });
        throw new Error("Expected the mandatory compaction gate to fail closed");
      } catch (error) {
        expect(error).toBeInstanceOf(ContextPlanningError);
        expect((error as ContextPlanningError).code).toBe(expectedCode);
      }

      expect(summaryCalls).toBe(0);
      expect(store.listContextPlansByRun("run_c")).toEqual([]);
      expect(store.listContextCheckpoints("conv_compaction")).toEqual([]);
      expectCompactionAttempts(store, [{ attemptIndex: 0, status: "failed" }]);
      const activity = store.listContextCompactionActivities("conv_compaction")[0];
      expect(activity).toMatchObject({
        runId: "run_c",
        requestIndex,
        trigger,
        status: "failed",
      });
      expect(activity?.boundaryStepIndex).toBe(activityBoundaryStepIndex);
      expect(activity?.coverageCursor).toBeUndefined();
      expect(store.listTraces("run_c").filter((trace) =>
        trace.type === "context.compaction.preparing"
        || trace.type === "context.compaction.failed"
      ).map((trace) => trace.type)).toEqual([
        "context.compaction.preparing",
        "context.compaction.failed",
      ]);
      db.close();
    },
  );

  test("persists safe preparing and failed lifecycle facts for invalid summary output", async () => {
    const { db, store } = createHistory();
    const ids = deterministicIds();
    const service = new ContextCompactionService({
      store,
      generator: async () => ({
        text: "",
        finishReason: "stop",
        usage: {
          inputTokens: 100,
          inputTokenDetails: {
            noCacheTokens: 100,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          outputTokens: 0,
          outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
          totalTokens: 100,
        },
      }),
      now: () => 100,
      createId: ids,
    });
    const manager = new ModelContextManager({
      store,
      compactionService: service,
      now: () => 100,
      createId: ids,
    });

    await expect(manager.prepare(preparation("auto_pre_turn"))).rejects.toBeInstanceOf(
      ContextSummaryValidationError,
    );

    const lifecycle = store.listTraces("run_c").filter((trace) =>
      trace.type === "context.compaction.preparing"
      || trace.type === "context.compaction.failed"
    );
    expect(lifecycle.map((trace) => trace.type)).toEqual([
      "context.compaction.preparing",
      "context.compaction.failed",
    ]);
    expect(lifecycle[1]?.payload).toMatchObject({
      trigger: "auto_pre_turn",
      requestIndex: 0,
      sourceHeadRunId: "run_c",
      sourceConversationRevision: 3,
      beforeEstimatedInputTokens: expect.any(Number),
      errorName: "ContextSummaryValidationError",
      finishReason: "stop",
      outputTokens: 0,
      textTokens: 0,
      reasoningTokens: 0,
    });
    expect(JSON.stringify(lifecycle)).not.toMatch(
      /internal reasoning|runtime system prompt|OLD_USER_|request id|api.?key/i,
    );
    expect(store.listContextCheckpoints("conv_compaction")).toEqual([]);
    db.close();
  });

  test.each([
    ["hard overflow", "auto_pre_turn" as const, 3_000],
    ["manual trigger", "manual" as const, 4_096],
  ])("rethrows the exact summary error for %s", async (_name, trigger, contextWindow) => {
    const { db, store } = createHistory();
    if (_name === "hard overflow") {
      for (const messageId of ["msg_user_a", "msg_assistant_a"] as const) {
        const message = store.getMessage(messageId);
        if (!message) throw new Error(`Missing ${messageId}`);
        store.saveMessage({
          ...message,
          parts: message.parts.map((part) =>
            part.type === "text" ? { ...part, text: "z".repeat(5_000) } : part,
          ),
        });
      }
    }
    const summaryError = new Error("summary provider failed\nrequest id: exact");
    const ids = deterministicIds();
    const service = new ContextCompactionService({
      store,
      generator: async () => { throw summaryError; },
      createId: ids,
    });
    const manager = new ModelContextManager({ store, compactionService: service, createId: ids });

    try {
      await manager.prepare(preparation(trigger, { contextWindow }));
      throw new Error("Expected summary generation to fail");
    } catch (error) {
      expect(error).toBe(summaryError);
    }
    expect(store.listContextCheckpoints("conv_compaction")).toEqual([]);
    db.close();
  });
});
