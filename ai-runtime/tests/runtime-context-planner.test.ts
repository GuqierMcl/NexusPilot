import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import * as runtime from "../src/runtime";
import {
  DEFAULT_CONTEXT_COMPACTION_POLICY,
  type AssistantMessage,
  type ContextCheckpoint,
  type ContextCompactionPolicy,
  type ContextPlannerInput,
  type ContextPlannerSnapshot,
  type Conversation,
  type Message,
  type Run,
  type RunId,
  type ToolCall,
  type ToolPart,
  type UserMessage,
} from "../src/runtime";

interface HistoryFixture {
  conversation: Conversation;
  runs: Run[];
  messages: Message[];
}

function makeRunPair(input: {
  runId: RunId;
  parentRunId?: RunId;
  conversationId?: Conversation["id"];
  status?: Run["status"];
  userText?: string;
  assistantText?: string;
  created: number;
}): { run: Run; messages: [UserMessage, AssistantMessage] } {
  const conversationId = input.conversationId ?? "conv_plan";
  const suffix = input.runId.slice("run_".length);
  const userMessage: UserMessage = {
    id: `msg_user_${suffix}`,
    conversationId,
    role: "user",
    agentMode: "ask",
    parts: [
      {
        id: `part_user_${suffix}`,
        conversationId,
        messageId: `msg_user_${suffix}`,
        type: "text",
        text: input.userText ?? `u${suffix}`,
      },
    ],
    time: { created: input.created },
  };
  const status = input.status ?? "completed";
  const assistantMessage: AssistantMessage = {
    id: `msg_assistant_${suffix}`,
    conversationId,
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
        conversationId,
        messageId: `msg_assistant_${suffix}`,
        type: "text",
        text: input.assistantText ?? `a${suffix}`,
      },
    ],
    time: { created: input.created + 1 },
  };
  return {
    run: {
      id: input.runId,
      conversationId,
      parentRunId: input.parentRunId,
      parentMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      agentMode: "ask",
      providerId: "openai",
      modelId: "gpt-4o",
      status,
      input: { messageIds: [userMessage.id] },
      output: { messageId: assistantMessage.id, partIds: assistantMessage.parts.map((part) => part.id) },
      limits: { maxSteps: 4, maxToolCalls: 8, maxOutputTokens: 128 },
      time: {
        created: input.created,
        ...(status === "completed" || status === "failed" || status === "interrupted"
          ? { completed: input.created + 1 }
          : {}),
      },
    },
    messages: [userMessage, assistantMessage],
  };
}

function history(
  ids: readonly string[],
  options: {
    head?: string;
    longThrough?: number;
    statuses?: Partial<Record<string, Run["status"]>>;
    extraRuns?: Run[];
    extraMessages?: Message[];
  } = {},
): HistoryFixture {
  const runs: Run[] = [];
  const messages: Message[] = [];
  ids.forEach((id, index) => {
    const pair = makeRunPair({
      runId: `run_${id}`,
      parentRunId: index > 0 ? `run_${ids[index - 1]}` : undefined,
      status: options.statuses?.[id] ?? (index === ids.length - 1 ? "running" : "completed"),
      userText: index < (options.longThrough ?? 0) ? "x".repeat(1_200) : `u${id}`,
      assistantText: index < (options.longThrough ?? 0) ? "y".repeat(1_200) : `a${id}`,
      created: (index + 1) * 10,
    });
    runs.push(pair.run);
    messages.push(...pair.messages);
  });
  runs.push(...(options.extraRuns ?? []));
  messages.push(...(options.extraMessages ?? []));
  const head = options.head ?? ids.at(-1)!;
  return {
    conversation: {
      id: "conv_plan",
      title: "Planner",
      version: "1",
      status: { type: "busy", runId: `run_${head}` },
      activeHeadRunId: `run_${head}`,
      revision: ids.length,
      time: { created: 1, updated: 100 },
    },
    runs,
    messages,
  };
}

function hashThrough(runs: readonly Run[], through: RunId): string {
  const end = runs.findIndex((run) => run.id === through) + 1;
  const payload = {
    version: "1",
    lineage: runs.slice(0, end).map((run) => ({
      runId: run.id,
      userMessageId: run.parentMessageId,
      assistantMessageId: run.assistantMessageId,
    })),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

function checkpoint(
  fixture: HistoryFixture,
  input: {
    id: ContextCheckpoint["id"];
    coverageThroughRunId: RunId;
    summary?: string;
    formatVersion?: string;
    compatibilityKind?: string;
    compatibilityVersion?: number;
    lineageHash?: string;
    created?: number;
  },
): ContextCheckpoint {
  const lineage = resolveFixtureLineage(fixture);
  return {
    id: input.id,
    conversationId: fixture.conversation.id,
    coverageThroughRunId: input.coverageThroughRunId,
    sourceHeadRunId: fixture.conversation.activeHeadRunId!,
    sourceConversationRevision: fixture.conversation.revision,
    lineageHash: input.lineageHash ?? hashThrough(lineage, input.coverageThroughRunId),
    sourceStateHash: `sha256:${"2".repeat(64)}`,
    safetyStateHash: `sha256:${"3".repeat(64)}`,
    trigger: "auto_pre_turn",
    formatVersion: input.formatVersion ?? "1",
    compatibility: {
      kind: input.compatibilityKind ?? "provider-neutral-text",
      version: input.compatibilityVersion ?? 1,
    },
    generatedBy: { providerId: "openai", modelId: "gpt-4o" },
    summary: input.summary ?? "compact history",
    safetyStateVersion: "1",
    budget: {
      providerId: "openai",
      modelId: "gpt-4o",
      contextWindow: 1_000,
      reservedOutputTokens: 50,
      safetyMarginTokens: 0,
      systemPromptTokens: 1,
      toolSchemaTokens: 1,
      hardInputBudget: 948,
      softTriggerTokens: 748,
      targetTokens: 498,
      rawHistoryTokens: 1_000,
      checkpointTokens: 10,
      safetyStateTokens: 10,
      estimatedInputTokens: 32,
    },
    time: { created: input.created ?? 100 },
  };
}

function resolveFixtureLineage(fixture: HistoryFixture): Run[] {
  const byId = new Map(fixture.runs.map((run) => [run.id, run]));
  const reversed: Run[] = [];
  let id = fixture.conversation.activeHeadRunId;
  while (id) {
    const run = byId.get(id);
    if (!run) throw new Error(`Missing fixture Run ${id}`);
    reversed.push(run);
    id = run.parentRunId;
  }
  return reversed.reverse();
}

function plannerInput(
  fixture: HistoryFixture,
  options: Partial<ContextPlannerInput> & {
    checkpoints?: ContextCheckpoint[];
    policy?: ContextCompactionPolicy;
  } = {},
): ContextPlannerInput {
  const snapshot: ContextPlannerSnapshot = {
    conversation: fixture.conversation,
    runs: fixture.runs,
    messages: fixture.messages,
    toolCalls: [],
    permissions: [],
    checkpoints: options.checkpoints ?? [],
  };
  return {
    runId: fixture.conversation.activeHeadRunId!,
    requestIndex: 0,
    providerId: "openai",
    modelId: "gpt-4o",
    contextWindow: 1_000,
    reservedOutputTokens: 50,
    systemPrompt: "sys",
    toolSchemas: {},
    trigger: "auto_pre_turn",
    policy: options.policy ?? {
      ...DEFAULT_CONTEXT_COMPACTION_POLICY,
      safetyMarginTokens: 0,
    },
    planId: "ctxplan_test",
    createdAt: 500,
    ...options,
    snapshot,
  };
}

function appendToolPart(
  fixture: HistoryFixture,
  runId: RunId,
  state: ToolPart["state"],
  toolCallId: ToolPart["toolCallId"] = "tool_boundary",
): ToolPart {
  const run = fixture.runs.find((candidate) => candidate.id === runId);
  const assistant = fixture.messages.find(
    (message): message is AssistantMessage =>
      message.role === "assistant" && message.runId === runId,
  );
  if (!run || !assistant) throw new Error(`Missing fixture pair for ${runId}`);
  const part: ToolPart = {
    id: "part_tool_boundary",
    conversationId: fixture.conversation.id,
    messageId: assistant.id,
    type: "tool",
    toolCallId,
    toolName: "sql.execute",
    state,
  };
  assistant.parts.push(part);
  run.output = {
    messageId: assistant.id,
    partIds: assistant.parts.map((candidate) => candidate.id),
  };
  return part;
}

function completedToolState(): Extract<ToolPart["state"], { status: "completed" }> {
  return {
    status: "completed",
    input: {},
    output: { data: { rowsAffected: 1 } },
    title: "Execute SQL",
    time: { start: 10, end: 11 },
  };
}

function completedToolCall(part: ToolPart): ToolCall {
  return {
    id: part.toolCallId,
    conversationId: part.conversationId,
    runId: "run_a",
    messageId: part.messageId,
    partId: part.id,
    toolName: part.toolName,
    input: {},
    state: "completed",
    result: { ok: true, summary: "SQL completed", data: { rowsAffected: 1 } },
    time: { created: 10, started: 10, completed: 11 },
  };
}

describe("deterministic context estimator", () => {
  test("estimates UTF-8 text and canonical JSON with ceil(bytes / 3)", () => {
    expect(runtime.estimateTextTokens("abc")).toBe(1);
    expect(runtime.estimateTextTokens("你好")).toBe(2);
    expect(runtime.estimateTextTokens("a你")).toBe(2);
    expect(runtime.stableStringifyJson({ b: 1, a: "你" })).toBe('{"a":"你","b":1}');
    expect(runtime.estimateJsonTokens({ b: 1, a: "你" })).toBe(6);
  });

  test("adds documented message/part/FilePart overhead and uses only byteLength metadata", () => {
    const user: UserMessage = {
      id: "msg_estimate",
      conversationId: "conv_plan",
      role: "user",
      agentMode: "ask",
      parts: [
        {
          id: "part_text",
          conversationId: "conv_plan",
          messageId: "msg_estimate",
          type: "text",
          text: "abc",
        },
        {
          id: "part_file",
          conversationId: "conv_plan",
          messageId: "msg_estimate",
          type: "file",
          attachmentId: "att_metadata_only",
          filename: "data.bin",
          mediaType: "application/octet-stream",
          byteLength: 12,
        },
      ],
      time: { created: 1 },
    };

    expect(runtime.CONTEXT_ESTIMATOR_OVERHEAD).toEqual({
      message: 4,
      part: 2,
      file: 8,
    });
    expect(runtime.estimateMessageTokens(user)).toBe(4 + (2 + 1) + (2 + 8 + 4));
  });
});

describe("context lineage hash", () => {
  test("ignores mutable title, time, and usage while retaining stable identities", () => {
    const fixture = history(["a", "b", "c"]);
    const lineage = resolveFixtureLineage(fixture);
    const original = runtime.computeContextLineageHash(lineage, "run_b");
    const mutableFieldsChanged = lineage.map((run) => ({
      ...run,
      time: { created: run.time.created + 10_000, completed: 20_000 },
      usage: { input: 99, output: 88, reasoning: 77, total: 264 },
      metadata: { ...run.metadata, title: "mutable title" },
    }));

    expect(runtime.computeContextLineageHash(mutableFieldsChanged, "run_b")).toBe(original);
  });

  test.each(["run", "user", "assistant"] as const)(
    "changes when a stable %s identity changes",
    (identity) => {
      const fixture = history(["a", "b", "c"]);
      const lineage = resolveFixtureLineage(fixture);
      const original = runtime.computeContextLineageHash(lineage, "run_b");
      const changed: Run[] = lineage.map((run, index) => index !== 0
        ? run
        : {
            ...run,
            ...(identity === "run" ? { id: "run_changed" as RunId } : {}),
            ...(identity === "user"
              ? { parentMessageId: "msg_user_changed" as UserMessage["id"] }
              : {}),
            ...(identity === "assistant"
              ? { assistantMessageId: "msg_assistant_changed" as AssistantMessage["id"] }
              : {}),
          });

      expect(runtime.computeContextLineageHash(changed, "run_b")).not.toBe(original);
    },
  );
});

describe("pure context window planner", () => {
  test("budgets retained model input while excluding the current Assistant from the durable base", () => {
    const fixture = history(["a", "b", "c"]);
    const currentAssistant = fixture.messages.find(
      (message): message is AssistantMessage =>
        message.role === "assistant" && message.runId === "run_c",
    )!;
    const retainedModelInput = {
      estimatedTokens: 2_000,
      contentHash: `sha256:${"a".repeat(64)}`,
    };
    const input = {
      ...plannerInput(fixture, {
        contextWindow: 1_500,
        reservedOutputTokens: 0,
        trigger: "auto_mid_turn",
      }),
      excludeAssistantMessageId: currentAssistant.id,
      retainedModelInput,
    } as ContextPlannerInput;

    const planned = runtime.planContextWindow(input);
    const contentChanged = runtime.planContextWindow({
      ...input,
      planId: "ctxplan_content_changed",
      retainedModelInput: {
        ...retainedModelInput,
        contentHash: `sha256:${"b".repeat(64)}`,
      },
    } as ContextPlannerInput);

    // Six two-byte text messages cost 7 tokens each. The current Assistant
    // is excluded (42 - 7), and the exact retained suffix costs 2,000.
    expect(planned.budget.rawHistoryTokens).toBe(2_035);
    expect(planned.reason).toBe("compaction_required");
    expect(planned.view).toBe("raw");
    expect(contentChanged.requestHash).not.toBe(planned.requestHash);
    expect(contentChanged.viewHash).not.toBe(planned.viewHash);
  });

  test.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ] as const)("rejects %s reservedOutputTokens", (_name, reservedOutputTokens) => {
    const fixture = history(["a", "b", "c"], { longThrough: 2 });

    expect(() => runtime.planContextWindow(plannerInput(fixture, {
      reservedOutputTokens,
    }))).toThrow("reservedOutputTokens");
  });

  test.each([
    ["policy", { version: "future-2" }],
    ["estimator", { estimatorVersion: "future-estimator" }],
    ["checkpoint format", { checkpointFormatVersion: "future-format" }],
    ["checkpoint compatibility", { compatibilityVersion: 2 }],
  ] as const)("rejects caller-provided unsupported %s versions", (_name, patch) => {
    const fixture = history(["a", "b", "c"], { longThrough: 2 });

    expect(() => runtime.planContextWindow(plannerInput(fixture, {
      policy: { ...DEFAULT_CONTEXT_COMPACTION_POLICY, ...patch },
    }))).toThrow("unsupported");
  });

  test.each([
    ["negative safety margin", { safetyMarginTokens: -1 }],
    ["fractional safety margin", { safetyMarginTokens: 1.5 }],
    ["negative minimum raw Runs", { minRawRuns: -1 }],
    ["fractional minimum raw Runs", { minRawRuns: 1.5 }],
    ["negative summary output", { summaryMaxOutputTokens: -1 }],
    ["non-finite summary output", { summaryMaxOutputTokens: Number.POSITIVE_INFINITY }],
    ["negative summary characters", { summaryMaxChars: -1 }],
    ["fractional summary characters", { summaryMaxChars: 1.5 }],
    ["non-finite soft ratio", { softTriggerRatio: Number.NaN }],
    ["target ratio at soft ratio", { targetRatio: 0.8 }],
  ] as const)("rejects an invalid policy with %s", (_name, patch) => {
    const fixture = history(["a", "b", "c"]);

    expect(() => runtime.planContextWindow(plannerInput(fixture, {
      policy: { ...DEFAULT_CONTEXT_COMPACTION_POLICY, ...patch },
    }))).toThrow("invalid");
  });

  test("ignores a future checkpoint under the current implementation policy", () => {
    const fixture = history(["a", "b", "c", "d", "e"], { longThrough: 3 });
    const future = checkpoint(fixture, {
      id: "ckpt_future_compatibility",
      coverageThroughRunId: "run_c",
      compatibilityVersion: 2,
    });
    const planned = runtime.planContextWindow(
      plannerInput(fixture, { checkpoints: [future] }),
    );

    expect(planned.view).toBe("raw");
    expect(planned.reason).toBe("compaction_required");
    expect(planned.checkpointId).toBeUndefined();
    expect(planned.checkpointRejections).toEqual([{
      checkpointId: "ckpt_future_compatibility",
      reason: "unsupported_compatibility",
    }]);
  });

  test.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "returns the full raw view when context length is invalid: %s",
    (contextWindow) => {
      const fixture = history(["a", "b", "c"], { longThrough: 2 });
      const existing = checkpoint(fixture, { id: "ckpt_existing", coverageThroughRunId: "run_a" });
      const planned = runtime.planContextWindow(
        plannerInput(fixture, { contextWindow, checkpoints: [existing] }),
      );

      expect(planned.view).toBe("raw");
      expect(planned.reason).toBe("context_window_unavailable");
      expect(planned.rawRunIds).toEqual(["run_a", "run_b", "run_c"]);
      expect(planned.checkpointId).toBeUndefined();
      expect(planned.budget.hardInputBudget).toBeUndefined();
    },
  );

  test("computes exact hard, soft, and target budgets without Runner magic numbers", () => {
    const fixture = history(["a", "b", "c"]);
    const planned = runtime.planContextWindow(
      plannerInput(fixture, {
        contextWindow: 1_000,
        reservedOutputTokens: 100,
        systemPrompt: "abc",
        toolSchemas: {},
        policy: {
          ...DEFAULT_CONTEXT_COMPACTION_POLICY,
          safetyMarginTokens: 50,
        },
      }),
    );

    // system "abc" = 1 token, canonical {} = 1 token.
    expect(planned.budget).toMatchObject({
      hardInputBudget: 848,
      softTriggerTokens: 648,
      targetTokens: 398,
      systemPromptTokens: 1,
      toolSchemaTokens: 1,
    });
  });

  test("prefers raw below the exact soft boundary even when a checkpoint exists", () => {
    const fixture = history(["a", "b", "c"]);
    const existing = checkpoint(fixture, { id: "ckpt_existing", coverageThroughRunId: "run_a" });
    const probe = runtime.planContextWindow(plannerInput(fixture, { contextWindow: undefined }));
    const fixedTokens = probe.budget.systemPromptTokens + probe.budget.toolSchemaTokens;
    const activeTokens = probe.budget.rawHistoryTokens + probe.budget.safetyStateTokens;
    const belowWindow = Math.ceil((activeTokens + fixedTokens + 1) / 0.8);
    const below = runtime.planContextWindow(
      plannerInput(fixture, { contextWindow: belowWindow, reservedOutputTokens: 0, checkpoints: [existing] }),
    );
    const exactWindow = Math.ceil((activeTokens + fixedTokens) / 0.8);
    const exact = runtime.planContextWindow(
      plannerInput(fixture, { contextWindow: exactWindow, reservedOutputTokens: 0, checkpoints: [existing] }),
    );

    expect(
      below.budget.rawHistoryTokens + below.budget.safetyStateTokens,
    ).toBeLessThan(below.budget.softTriggerTokens!);
    expect(below.view).toBe("raw");
    expect(
      exact.budget.rawHistoryTokens + exact.budget.safetyStateTokens,
    ).toBeGreaterThanOrEqual(exact.budget.softTriggerTokens!);
    expect(exact.reason).not.toBe("raw_within_budget");
  });

  test("selects the furthest compatible checkpoint with a matching ancestor hash", () => {
    const fixture = history(["a", "b", "c", "d", "e"], { longThrough: 3 });
    const earlierValid = checkpoint(fixture, {
      id: "ckpt_earlier_valid",
      coverageThroughRunId: "run_b",
      summary: "x",
      created: 400,
    });
    const valid = checkpoint(fixture, {
      id: "ckpt_valid",
      coverageThroughRunId: "run_c",
      created: 100,
    });
    const badHash = checkpoint(fixture, {
      id: "ckpt_bad_hash",
      coverageThroughRunId: "run_c",
      lineageHash: `sha256:${"f".repeat(64)}`,
      created: 200,
    });
    const unknownFormat = checkpoint(fixture, {
      id: "ckpt_unknown",
      coverageThroughRunId: "run_c",
      formatVersion: "99",
      created: 300,
    });
    const danglingParent = {
      ...checkpoint(fixture, {
        id: "ckpt_dangling_parent",
        coverageThroughRunId: "run_c",
        created: 350,
      }),
      parentCheckpointId: "ckpt_missing_parent" as const,
    };
    const overBudget = checkpoint(fixture, {
      id: "ckpt_over_budget",
      coverageThroughRunId: "run_c",
      summary: "z".repeat(20_000),
      created: 360,
    });
    const planned = runtime.planContextWindow(
      plannerInput(fixture, {
        checkpoints: [badHash, unknownFormat, danglingParent, overBudget, earlierValid, valid],
      }),
    );

    expect(planned.view).toBe("checkpoint");
    expect(planned.reason).toBe("checkpoint_selected");
    expect(planned.checkpointId).toBe(valid.id);
    expect(planned.rawRunIds).toEqual(["run_d", "run_e"]);
    expect(planned.budget.checkpointTokens).toBeGreaterThan(0);
    expect(planned.budget.estimatedInputTokens).toBeLessThanOrEqual(planned.budget.targetTokens!);
    expect(planned.checkpointRejections).toEqual([
      { checkpointId: "ckpt_bad_hash", reason: "lineage_hash_mismatch" },
      { checkpointId: "ckpt_dangling_parent", reason: "dangling_parent" },
      { checkpointId: "ckpt_earlier_valid", reason: "target_budget_exceeded" },
      { checkpointId: "ckpt_over_budget", reason: "target_budget_exceeded" },
      { checkpointId: "ckpt_unknown", reason: "unsupported_format" },
    ]);
  });

  test("rejects a supported checkpoint whose parent chain is not usable", () => {
    const fixture = history(["a", "b", "c", "d", "e"], { longThrough: 3 });
    const unsupportedParent = checkpoint(fixture, {
      id: "ckpt_unsupported_parent",
      coverageThroughRunId: "run_b",
      formatVersion: "future-9",
      created: 100,
    });
    const child = {
      ...checkpoint(fixture, {
        id: "ckpt_child_of_unsupported",
        coverageThroughRunId: "run_c",
        created: 200,
      }),
      parentCheckpointId: unsupportedParent.id,
    } satisfies ContextCheckpoint;

    const planned = runtime.planContextWindow(
      plannerInput(fixture, { checkpoints: [child, unsupportedParent] }),
    );

    expect(planned.view).toBe("raw");
    expect(planned.reason).toBe("compaction_required");
    expect(planned.checkpointRejections).toEqual([
      { checkpointId: "ckpt_child_of_unsupported", reason: "dangling_parent" },
      { checkpointId: "ckpt_unsupported_parent", reason: "unsupported_format" },
    ]);
  });

  test("rejects later, wrong-branch, and cyclic checkpoint parent chains", () => {
    const fixture = history(["a", "b", "c", "d", "e"], { longThrough: 3 });
    const laterParent = checkpoint(fixture, {
      id: "ckpt_later_parent",
      coverageThroughRunId: "run_c",
      created: 100,
    });
    const childBeforeParent = {
      ...checkpoint(fixture, {
        id: "ckpt_child_before_parent",
        coverageThroughRunId: "run_b",
        created: 200,
      }),
      parentCheckpointId: laterParent.id,
    } satisfies ContextCheckpoint;
    const laterPlan = runtime.planContextWindow(
      plannerInput(fixture, { checkpoints: [childBeforeParent, laterParent] }),
    );
    expect(laterPlan.checkpointId).toBe(laterParent.id);
    expect(laterPlan.checkpointRejections).toContainEqual({
      checkpointId: childBeforeParent.id,
      reason: "dangling_parent",
    });

    const wrongBranchParent = checkpoint(fixture, {
      id: "ckpt_wrong_branch_parent",
      coverageThroughRunId: "run_x",
      created: 100,
    });
    const childOfWrongBranch = {
      ...checkpoint(fixture, {
        id: "ckpt_child_of_wrong_branch",
        coverageThroughRunId: "run_c",
        created: 200,
      }),
      parentCheckpointId: wrongBranchParent.id,
    } satisfies ContextCheckpoint;
    const wrongBranchPlan = runtime.planContextWindow(
      plannerInput(fixture, { checkpoints: [childOfWrongBranch, wrongBranchParent] }),
    );
    expect(wrongBranchPlan.view).toBe("raw");
    expect(wrongBranchPlan.checkpointRejections).toEqual([
      { checkpointId: childOfWrongBranch.id, reason: "dangling_parent" },
      { checkpointId: wrongBranchParent.id, reason: "coverage_not_active_ancestor" },
    ]);

    const cycleA = {
      ...checkpoint(fixture, {
        id: "ckpt_cycle_a",
        coverageThroughRunId: "run_b",
        created: 100,
      }),
      parentCheckpointId: "ckpt_cycle_b",
    } satisfies ContextCheckpoint;
    const cycleB = {
      ...checkpoint(fixture, {
        id: "ckpt_cycle_b",
        coverageThroughRunId: "run_a",
        created: 200,
      }),
      parentCheckpointId: "ckpt_cycle_a",
    } satisfies ContextCheckpoint;
    const cyclePlan = runtime.planContextWindow(
      plannerInput(fixture, { checkpoints: [cycleB, cycleA] }),
    );
    expect(cyclePlan.view).toBe("raw");
    expect(cyclePlan.checkpointRejections).toEqual([
      { checkpointId: cycleA.id, reason: "dangling_parent" },
      { checkpointId: cycleB.id, reason: "dangling_parent" },
    ]);
  });

  test("rejects an old-branch checkpoint and rehydrates a short active branch as raw", () => {
    const original = history(["a", "b", "c", "d"], { longThrough: 3 });
    const oldCheckpoint = checkpoint(original, {
      id: "ckpt_old_branch",
      coverageThroughRunId: "run_c",
    });
    const replacement = makeRunPair({
      runId: "run_e",
      parentRunId: "run_b",
      created: 50,
      status: "running",
      userText: "short edited branch",
      assistantText: "",
    });
    const fixture = history(["a", "b"], {
      head: "e",
      extraRuns: [original.runs[2]!, original.runs[3]!, replacement.run],
      extraMessages: [
        original.messages[4]!,
        original.messages[5]!,
        original.messages[6]!,
        original.messages[7]!,
        ...replacement.messages,
      ],
    });
    fixture.conversation.revision = 5;
    const planned = runtime.planContextWindow(
      plannerInput(fixture, { contextWindow: 10_000, checkpoints: [oldCheckpoint] }),
    );

    expect(planned.view).toBe("raw");
    expect(planned.rawRunIds).toEqual(["run_a", "run_b", "run_e"]);
    expect(planned.checkpointId).toBeUndefined();
  });

  test("returns compaction_required with the furthest terminal boundary and minimum raw tail", () => {
    const fixture = history(["a", "b", "c", "d", "e"], { longThrough: 4 });
    const planned = runtime.planContextWindow(plannerInput(fixture));

    expect(planned.reason).toBe("compaction_required");
    expect(planned.eligibleCoverageThroughRunId).toBe("run_c");
    expect(planned.rawRunIds).toEqual(["run_a", "run_b", "run_c", "run_d", "run_e"]);
  });

  test("advances safe coverage across a failed Run with terminal Assistant facts and no Run output", () => {
    const fixture = history(["a", "b", "c", "d", "e"], { longThrough: 4 });
    const failedRun = fixture.runs.find((run) => run.id === "run_b")!;
    const failedAssistant = fixture.messages.find(
      (message): message is AssistantMessage =>
        message.role === "assistant" && message.runId === failedRun.id,
    )!;
    const error = {
      name: "AI_RetryError",
      data: { message: "Failed after 3 attempts. Last error: Too Many Requests" },
    } as const;
    const toolPart: ToolPart = {
      id: "part_failed_terminal_tool",
      conversationId: fixture.conversation.id,
      messageId: failedAssistant.id,
      type: "tool",
      toolCallId: "tool_failed_terminal",
      toolName: "connection.open",
      state: completedToolState(),
    };
    failedRun.status = "failed";
    failedRun.finish = "error";
    failedRun.error = error;
    delete failedRun.output;
    failedAssistant.status = { type: "error", error };
    failedAssistant.finish = "error";
    failedAssistant.error = error;
    failedAssistant.parts.push(toolPart);

    const input = plannerInput(fixture);
    input.snapshot.toolCalls = [
      {
        id: toolPart.toolCallId,
        conversationId: fixture.conversation.id,
        runId: failedRun.id,
        messageId: failedAssistant.id,
        partId: toolPart.id,
        toolName: toolPart.toolName,
        input: {},
        state: "completed",
        result: { ok: true, summary: "Connection opened", data: {} },
        time: { created: 10, started: 10, completed: 11 },
      },
    ];

    const planned = runtime.planContextWindow(input);

    expect(planned.reason).toBe("compaction_required");
    expect(planned.eligibleCoverageThroughRunId).toBe("run_c");
  });

  test("sends soft-triggered raw context when the minimum raw tail leaves no boundary", () => {
    const fixture = history(["a", "b"], { longThrough: 2 });
    const planned = runtime.planContextWindow(
      plannerInput(fixture, { contextWindow: 1_900 }),
    );

    expect(
      planned.budget.rawHistoryTokens + planned.budget.safetyStateTokens,
    ).toBeGreaterThanOrEqual(planned.budget.softTriggerTokens!);
    expect(
      planned.budget.rawHistoryTokens + planned.budget.safetyStateTokens,
    ).toBeLessThanOrEqual(planned.budget.hardInputBudget!);
    expect(planned.view).toBe("raw");
    expect(planned.reason).toBe("raw_compaction_blocked");
    expect(planned.eligibleCoverageThroughRunId).toBeUndefined();
  });

  test("fails closed above the hard budget when the minimum raw tail leaves no boundary", () => {
    const fixture = history(["a", "b"], { longThrough: 2 });

    try {
      runtime.planContextWindow(plannerInput(fixture, { contextWindow: 1_000 }));
      throw new Error("Expected context planning to fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(runtime.ContextPlanningError);
      expect((error as runtime.ContextPlanningError).code).toBe(
        "CONTEXT_HARD_BUDGET_EXCEEDED_WITHOUT_SAFE_BOUNDARY",
      );
    }
  });

  test.each(["run", "tool", "permission"] as const)(
    "keeps raw context when every coverage boundary is blocked by a non-terminal %s",
    (blocker) => {
      const fixture = history(["a", "b", "c", "d"], {
        longThrough: 2,
        ...(blocker === "run" ? { statuses: { a: "running" as const } } : {}),
      });
      const input = plannerInput(fixture, { contextWindow: 2_100 });
      if (blocker === "tool" || blocker === "permission") {
        input.snapshot.toolCalls = [
          {
            id: "tool_first_boundary",
            conversationId: fixture.conversation.id,
            runId: "run_a",
            messageId: "msg_assistant_a",
            toolName: "sql.execute",
            input: {},
            state: blocker === "permission" ? "waiting_for_permission" : "running",
            ...(blocker === "permission" ? { permissionId: "perm_first_boundary" } : {}),
            time: { created: 10, started: 11 },
          },
        ];
      }
      if (blocker === "permission") {
        input.snapshot.permissions = [
          {
            id: "perm_first_boundary",
            conversationId: fixture.conversation.id,
            runId: "run_a",
            messageId: "msg_assistant_a",
            toolCallId: "tool_first_boundary",
            status: "pending",
            toolId: "sql.execute",
            title: "Execute write",
            risk: { level: "high", reversible: false, sideEffects: ["business_write"] },
            confirmation: { level: "standard" },
            createdAt: 10,
          },
        ];
      }

      const planned = runtime.planContextWindow(input);

      expect(
        planned.budget.rawHistoryTokens + planned.budget.safetyStateTokens,
      ).toBeGreaterThanOrEqual(planned.budget.softTriggerTokens!);
      expect(
        planned.budget.rawHistoryTokens + planned.budget.safetyStateTokens,
      ).toBeLessThanOrEqual(planned.budget.hardInputBudget!);
      expect(planned.reason).toBe("raw_compaction_blocked");
      expect(planned.eligibleCoverageThroughRunId).toBeUndefined();
    },
  );

  test("does not cross a non-terminal ToolCall or pending Permission boundary", () => {
    const fixture = history(["a", "b", "c", "d"], { longThrough: 3 });
    const input = plannerInput(fixture);
    input.snapshot.toolCalls = [
      {
        id: "tool_blocked",
        conversationId: fixture.conversation.id,
        runId: "run_b",
        messageId: "msg_assistant_b",
        toolName: "sql.execute",
        input: {},
        state: "running",
        permissionId: "perm_blocked",
        time: { created: 20, started: 21 },
      },
    ];
    input.snapshot.permissions = [
      {
        id: "perm_blocked",
        conversationId: fixture.conversation.id,
        runId: "run_b",
        messageId: "msg_assistant_b",
        toolCallId: "tool_blocked",
        status: "pending",
        toolId: "sql.execute",
        title: "Execute write",
        risk: { level: "high", reversible: false, sideEffects: ["business_write"] },
        confirmation: { level: "standard" },
        createdAt: 20,
      },
    ];
    const planned = runtime.planContextWindow(input);

    expect(planned.reason).toBe("compaction_required");
    expect(planned.eligibleCoverageThroughRunId).toBe("run_a");
  });

  test.each([
    ["running", { type: "running" } as const],
    ["requires action", { type: "requires-action", reason: "tool" } as const],
  ])("does not cover a terminal Run whose Assistant is %s", (_name, assistantStatus) => {
    const fixture = history(["a", "b", "c", "d"], { longThrough: 2 });
    const assistant = fixture.messages.find(
      (message): message is AssistantMessage =>
        message.role === "assistant" && message.runId === "run_a",
    );
    if (!assistant) throw new Error("Missing Assistant fixture");
    assistant.status = assistantStatus;

    const planned = runtime.planContextWindow(plannerInput(fixture, { contextWindow: 2_100 }));

    expect(planned.reason).toBe("raw_compaction_blocked");
    expect(planned.eligibleCoverageThroughRunId).toBeUndefined();
  });

  test.each([
    ["pending", { status: "pending", input: {} } as const],
    ["validating", { status: "validating", input: {}, time: { start: 10 } } as const],
    [
      "waiting_for_permission",
      {
        status: "waiting_for_permission",
        input: {},
        permissionId: "perm_boundary",
        time: { start: 10 },
      } as const,
    ],
    ["running", { status: "running", input: {}, time: { start: 10 } } as const],
  ])("does not cover an Assistant with a %s ToolPart", (_name, toolState) => {
    const fixture = history(["a", "b", "c", "d"], { longThrough: 2 });
    appendToolPart(fixture, "run_a", toolState);

    const planned = runtime.planContextWindow(plannerInput(fixture, { contextWindow: 2_100 }));

    expect(planned.reason).toBe("raw_compaction_blocked");
    expect(planned.eligibleCoverageThroughRunId).toBeUndefined();
  });

  test.each([
    ["toolCall ID", { id: "tool_other" }],
    ["Run", { runId: "run_b" }],
    ["Message", { messageId: "msg_assistant_b" }],
    ["Part", { partId: "part_tool_other" }],
  ] as const)("does not cover mismatched ToolPart/ToolCall %s identity", (_name, patch) => {
    const fixture = history(["a", "b", "c", "d"], { longThrough: 2 });
    const part = appendToolPart(fixture, "run_a", completedToolState());
    const toolCall = { ...completedToolCall(part), ...patch } as ToolCall;
    const input = plannerInput(fixture, { contextWindow: 2_100 });
    input.snapshot.toolCalls = [toolCall];

    const planned = runtime.planContextWindow(input);

    expect(planned.reason).toBe("raw_compaction_blocked");
    expect(planned.eligibleCoverageThroughRunId).toBeUndefined();
  });

  test("allows a terminal provider validation-error ToolPart without a Store ToolCall", () => {
    const fixture = history(["a", "b", "c", "d"], { longThrough: 3 });
    appendToolPart(fixture, "run_b", {
      status: "error",
      input: {},
      error: {
        code: "VALIDATION_ERROR",
        message: "Tool input did not match the declared schema.",
        retryable: true,
      },
      time: { start: 20, end: 21 },
    });

    const planned = runtime.planContextWindow(plannerInput(fixture));

    expect(planned.reason).toBe("compaction_required");
    expect(planned.eligibleCoverageThroughRunId).toBe("run_b");
  });
});
