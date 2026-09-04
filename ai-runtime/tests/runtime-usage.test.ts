import { describe, expect, test } from "bun:test";
import { simulateReadableStream, type ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import {
  mapAiSdkUsage,
  RuntimeSqliteStore,
  RuntimeTextRunner,
  RuntimeToolRegistry,
  type RuntimeStreamText,
  type RuntimeToolNamespace,
} from "../src/runtime";
import { openRuntimeDatabase } from "../src/storage/runtime-database";

function preparedUsageContext(input: {
  requestIndex: number;
  retainedMessages?: ModelMessage[];
}) {
  return {
    plan: {
      id: `ctxplan_usage_${input.requestIndex}`,
      conversationId: "unused",
      runId: "unused",
      requestIndex: input.requestIndex,
      providerId: "openai",
      modelId: "gpt-4o",
      view: "raw" as const,
      budget: {
        contextWindow: 4_000,
        estimatedInputTokens: 100 + input.requestIndex,
        reservedOutputTokens: 100,
        rawHistoryTokens: 70 + input.requestIndex,
        checkpointTokens: 0,
        safetyStateTokens: 10,
        systemPromptTokens: 10,
        toolSchemaTokens: 10,
      },
    },
    messages: [
      { role: "user" as const, content: "managed base" },
      ...(input.retainedMessages ?? []),
    ],
  };
}

function modelUsage(inputTokens: number, outputTokens = 2) {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTokens,
      text: outputTokens,
      reasoning: 0,
    },
  };
}

function lowRiskEchoRegistry(): RuntimeToolRegistry {
  const namespace: RuntimeToolNamespace = {
    id: "system",
    title: "System",
    description: "Context hook test tools",
    tools: [{
      id: "system.echo",
      title: "Echo",
      description: "Echo a test value.",
      inputSchema: z.object({ value: z.string() }).strict(),
      outputSchema: z.object({ value: z.string() }).strict(),
      executionTarget: "runtime",
      risk: {
        mode: "static",
        level: "low",
        reversible: true,
        sideEffect: "runtime_state",
      },
      execute: async (input) => ({ summary: "echoed", data: input }),
    }],
    resolveForRun: () => ({ candidateToolIds: ["system.echo"] }),
  };
  return new RuntimeToolRegistry([namespace]);
}

function parseSseData(text: string): Array<Record<string, unknown>> {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .filter((line) => line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
}

describe("mapAiSdkUsage", () => {
  test("maps AI SDK 7 language model usage to runtime token usage", () => {
    expect(
      mapAiSdkUsage({
        inputTokens: 10,
        inputTokenDetails: {
          noCacheTokens: 7,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
        },
        outputTokens: 5,
        outputTokenDetails: {
          textTokens: 3,
          reasoningTokens: 2,
        },
        totalTokens: 15,
      }),
    ).toEqual({
      input: 10,
      output: 5,
      reasoning: 2,
      cache: {
        read: 2,
        write: 1,
      },
      total: 15,
    });
  });

  test("uses zero defaults when a provider omits optional token counts", () => {
    expect(
      mapAiSdkUsage({
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
      }),
    ).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      total: 0,
    });
  });
});

describe("Runtime per-step ContextUsage", () => {
  test("retains every prior ToolLoop response in managed multi-step requests", async () => {
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeSqliteStore(db);
    let id = 0;
    let modelCall = 0;
    const modelPrompts: string[] = [];
    const retainedByRequest: ModelMessage[][] = [];
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        modelCall += 1;
        modelPrompts.push(JSON.stringify(options.prompt));
        const content = modelCall < 3
          ? [{
              type: "tool-call" as const,
              toolCallId: `call_retained_${modelCall}`,
              toolName: "np__system__echo",
              input: JSON.stringify({ value: `step-${modelCall}` }),
            }]
          : [
              { type: "text-start" as const, id: "text-final" },
              { type: "text-delta" as const, id: "text-final", delta: "done" },
              { type: "text-end" as const, id: "text-final" },
            ];
        return {
          stream: simulateReadableStream({
            chunks: [
              ...content,
              {
                type: "finish" as const,
                finishReason: {
                  unified: modelCall < 3 ? "tool-calls" as const : "stop" as const,
                  raw: undefined,
                },
                logprobs: undefined,
                usage: modelUsage(20 + modelCall),
              },
            ],
          }),
        };
      },
    });
    const contextManager = {
      prepare: async (input: {
        requestIndex: number;
        retainedMessages?: ModelMessage[];
      }) => {
        retainedByRequest[input.requestIndex] = structuredClone(
          input.retainedMessages ?? [],
        );
        return preparedUsageContext(input);
      },
    };
    const runner = new RuntimeTextRunner({
      store,
      createId: (prefix) => `${prefix}_${++id}` as never,
      now: () => 1_000 + id,
      resolveLanguageModel: () => ({
        languageModel: model,
        runtimeContext: {
          provider: {
            providerId: "openai",
            modelId: "gpt-4o",
            contextLength: 4_000,
            outputLength: 100,
            supportsTools: true,
          },
        },
      }),
      toolRegistry: lowRiskEchoRegistry(),
      contextManager: contextManager as never,
    });

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "run two tools",
      agentMode: "agent",
    });
    await result.response.text();

    expect(modelCall).toBe(3);
    expect(JSON.stringify(retainedByRequest[1])).toContain("call_retained_1");
    expect(JSON.stringify(retainedByRequest[2])).toContain("call_retained_1");
    expect(JSON.stringify(retainedByRequest[2])).toContain("call_retained_2");
    expect(modelPrompts[2]).toContain("call_retained_1");
    expect(modelPrompts[2]).toContain("call_retained_2");
    expect(store.listContextUsagesByRun(result.started.run.id).map((usage) => ({
      requestIndex: usage.requestIndex,
      providerInputTokens: usage.providerObservation?.inputTokens,
    }))).toEqual([
      { requestIndex: 0, providerInputTokens: 21 },
      { requestIndex: 1, providerInputTokens: 22 },
      { requestIndex: 2, providerInputTokens: 23 },
    ]);
    db.close();
  });

  test("emits context metadata only on start and finish UI chunks", async () => {
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeSqliteStore(db);
    let id = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start" as const, id: "text-metadata" },
            { type: "text-delta" as const, id: "text-metadata", delta: "hello" },
            { type: "text-end" as const, id: "text-metadata" },
            {
              type: "finish" as const,
              finishReason: { unified: "stop" as const, raw: undefined },
              logprobs: undefined,
              usage: modelUsage(11),
            },
          ],
        }),
      }),
    });
    const runner = new RuntimeTextRunner({
      store,
      createId: (prefix) => `${prefix}_${++id}` as never,
      now: () => 2_000 + id,
      resolveLanguageModel: () => ({
        languageModel: model,
        runtimeContext: {
          provider: {
            providerId: "openai",
            modelId: "gpt-4o",
            contextLength: 4_000,
            outputLength: 100,
          },
        },
      }),
      contextManager: {
        prepare: async (input: {
          requestIndex: number;
          retainedMessages?: ModelMessage[];
        }) => preparedUsageContext(input),
      } as never,
    });

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "metadata lifecycle",
    });
    const chunks = parseSseData(await result.response.text());
    const metadataChunks = chunks.filter((chunk) => "messageMetadata" in chunk);

    expect(chunks.filter((chunk) => chunk.type === "message-metadata")).toEqual([]);
    expect(metadataChunks.map((chunk) => chunk.type)).toEqual(["start", "finish"]);
    expect(metadataChunks[0]?.messageMetadata).toMatchObject({
      custom: { nexus: { contextUsage: { source: "estimate" } } },
    });
    expect(metadataChunks[1]?.messageMetadata).toMatchObject({
      custom: {
        nexus: {
          contextUsage: { source: "provider", providerInputTokens: 11 },
        },
      },
    });
    db.close();
  });

  test("fails the Run when real ToolLoop provider-usage persistence fails", async () => {
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeSqliteStore(db);
    let id = 0;
    const observationError = new Error("provider observation persistence failed");
    store.updateContextUsageProviderObservation = (() => {
      throw observationError;
    }) as typeof store.updateContextUsageProviderObservation;
    let modelCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call" as const,
                toolCallId: "call_callback_failure",
                toolName: "np__system__echo",
                input: JSON.stringify({ value: "must not reach step two" }),
              },
              {
                type: "finish" as const,
                finishReason: { unified: "tool-calls" as const, raw: undefined },
                logprobs: undefined,
                usage: modelUsage(12),
              },
            ],
          }),
        };
      },
    });
    const runner = new RuntimeTextRunner({
      store,
      createId: (prefix) => `${prefix}_${++id}` as never,
      now: () => 3_000 + id,
      resolveLanguageModel: () => ({
        languageModel: model,
        runtimeContext: {
          provider: {
            providerId: "openai",
            modelId: "gpt-4o",
            contextLength: 4_000,
            outputLength: 100,
            supportsTools: true,
          },
        },
      }),
      toolRegistry: lowRiskEchoRegistry(),
      contextManager: {
        prepare: async (input: {
          requestIndex: number;
          retainedMessages?: ModelMessage[];
        }) => preparedUsageContext(input),
      } as never,
    });

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "callback failure",
      agentMode: "agent",
    });

    await expect(result.response.text()).rejects.toThrow(observationError.message);
    expect(modelCalls).toBe(1);
    expect(store.getRun(result.started.run.id)).toMatchObject({
      status: "failed",
      finish: "error",
      error: { data: { message: observationError.message } },
    });
    expect(store.getConversation(result.started.conversation.id)?.status.type).toBe("error");
    db.close();
  });

  test.each([
    [
      "fails closed on a ContextUsage non-constraint Store failure",
      "non_constraint",
      false,
    ],
    [
      "fails closed on a ContextUsage conflicting unique-constraint winner",
      "conflicting_unique",
      false,
    ],
    [
      "recovers an equivalent ContextUsage unique-constraint winner",
      "equivalent_unique",
      true,
    ],
  ] as const)("%s", async (_name, mode, shouldStartModel) => {
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeSqliteStore(db);
    let id = 0;
    let modelStarted = false;
    const saveUsage = store.saveContextUsage.bind(store);
    store.saveContextUsage = ((usage) => {
      saveUsage({
        ...usage,
        ...(mode === "conflicting_unique"
          ? {
              id: "ctxuse_conflicting_winner",
              estimatedInputTokens: usage.estimatedInputTokens + 1,
            }
          : {}),
      });
      if (mode !== "non_constraint") {
        saveUsage(usage);
      }
      throw new Error("context usage storage failed after write");
    }) as typeof store.saveContextUsage;
    const streamText: RuntimeStreamText = async (input) => {
      modelStarted = true;
      await input.onFinish?.({ finishReason: "stop" });
      return { toUIMessageStreamResponse: () => new Response("data: {}\n\n") };
    };
    const runner = new RuntimeTextRunner({
      store,
      createId: (prefix) => `${prefix}_${++id}` as never,
      now: () => 4_000 + id,
      resolveLanguageModel: () => ({
        languageModel: new MockLanguageModelV3(),
        runtimeContext: {
          provider: {
            providerId: "openai",
            modelId: "gpt-4o",
            contextLength: 4_000,
            outputLength: 100,
          },
        },
      }),
      streamText,
      contextManager: {
        prepare: async (input: {
          requestIndex: number;
          retainedMessages?: ModelMessage[];
        }) => preparedUsageContext(input),
      } as never,
    });

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "usage race",
    });
    await result.response.text();

    expect(modelStarted).toBe(shouldStartModel);
    expect(store.getRun(result.started.run.id)?.status).toBe(
      shouldStartModel ? "completed" : "failed",
    );
    db.close();
  });

  test("persists immutable estimates and matching provider observations without changing cumulative Run usage", async () => {
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeSqliteStore(db);
    let id = 0;
    const preparedIndices: number[] = [];
    const excludedAssistantIds: Array<string | undefined> = [];
    let liveMetadata: Record<string, unknown> | undefined;
    const preparedMessages: unknown[] = [];
    const contextManager = {
      prepare: async (input: {
        requestIndex: number;
        excludeAssistantMessageId?: string;
      }) => {
        preparedIndices.push(input.requestIndex);
        excludedAssistantIds.push(input.excludeAssistantMessageId);
        return {
          plan: {
            id: `ctxplan_${input.requestIndex}`,
            conversationId: "unused",
            runId: "unused",
            requestIndex: input.requestIndex,
            providerId: "openai",
            modelId: "gpt-4o",
            view: "raw",
            budget: {
              contextWindow: 1_000,
              estimatedInputTokens: 100 + input.requestIndex,
              reservedOutputTokens: 100,
              rawHistoryTokens: 70 + input.requestIndex,
              checkpointTokens: 0,
              safetyStateTokens: 10,
              systemPromptTokens: 10,
              toolSchemaTokens: 10,
            },
          },
          messages: [{ role: "user", content: `request ${input.requestIndex}` }],
          marker: input.requestIndex === 0
            ? {
                checkpointId: "ckpt_private",
                trigger: "auto_pre_turn",
                auto: true,
                coverageThroughRunId: "run_ancestor",
                beforeEstimatedInputTokens: 900,
                afterEstimatedInputTokens: 100,
                status: "created",
                time: { created: 1_000 },
                summary: "PRIVATE_SUMMARY_MUST_NOT_LEAK",
                safetyState: { secret: "PRIVATE_SAFETY_STATE" },
                providerMetadata: { credential: "PRIVATE_CREDENTIAL" },
              }
            : undefined,
        };
      },
    };
    const providerUsage = (inputTokens: number, cacheReadTokens?: number) => ({
      inputTokens,
      inputTokenDetails: {
        noCacheTokens: inputTokens - (cacheReadTokens ?? 0),
        cacheReadTokens,
        cacheWriteTokens: undefined,
      },
      outputTokens: 10,
      outputTokenDetails: { textTokens: 10, reasoningTokens: undefined },
      totalTokens: inputTokens + 10,
    });
    const streamText: RuntimeStreamText = async (input) => {
      expect(input.prepareStep).toBeFunction();
      expect(input.onStepEnd).toBeFunction();
      for (let stepNumber = 0; stepNumber < 3; stepNumber += 1) {
        preparedMessages.push(await input.prepareStep!({
          stepNumber,
          messages: [{ role: "user", content: `sdk step ${stepNumber}` }],
        }));
        await input.onStepEnd!({
          stepNumber,
          ...(stepNumber === 1
            ? {}
            : { usage: providerUsage(40 + stepNumber, stepNumber === 2 ? 7 : undefined) }),
        });
      }
      liveMetadata = input.messageMetadata?.();
      await input.onFinish?.({
        finishReason: "stop",
        stepCount: 3,
        totalUsage: providerUsage(120, 7),
      });
      return { toUIMessageStreamResponse: () => new Response("data: {}\\n\\n") };
    };
    const runner = new RuntimeTextRunner({
      store,
      createId: (prefix) => `${prefix}_${++id}` as never,
      now: () => 1_000 + id,
      resolveLanguageModel: () => ({
        languageModel: new MockLanguageModelV3(),
        runtimeContext: {
          provider: {
            providerId: "openai",
            modelId: "gpt-4o",
            contextLength: 1_000,
            outputLength: 100,
          },
        },
      }),
      streamText,
      contextManager: contextManager as never,
    });

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "three steps",
    });
    await result.response.text();

    expect(preparedIndices).toEqual([0, 1, 2]);
    expect(excludedAssistantIds).toEqual([
      result.started.assistantMessage.id,
      result.started.assistantMessage.id,
      result.started.assistantMessage.id,
    ]);
    expect(preparedMessages[1]).toEqual({
      messages: [{ role: "user", content: "request 1" }],
    });
    expect(store.listContextUsagesByRun(result.started.run.id)).toMatchObject([
      {
        requestIndex: 0,
        estimatedInputTokens: 100,
        estimateSource: "estimate",
        providerObservation: { source: "provider", inputTokens: 40 },
      },
      {
        requestIndex: 1,
        estimatedInputTokens: 101,
        estimateSource: "estimate",
      },
      {
        requestIndex: 2,
        estimatedInputTokens: 102,
        estimateSource: "estimate",
        providerObservation: {
          source: "provider",
          inputTokens: 42,
          cacheReadTokens: 7,
        },
      },
    ]);
    expect(
      store.listContextUsagesByRun(result.started.run.id)[1],
    ).not.toHaveProperty("providerObservation");
    expect(store.getRun(result.started.run.id)?.usage).toEqual({
      input: 120,
      output: 10,
      reasoning: 0,
      cache: { read: 7, write: 0 },
      total: 130,
    });
    expect(liveMetadata).toMatchObject({
      custom: {
        nexus: {
          contextUsage: {
            contextWindow: 1_000,
            estimatedInputTokens: 102,
            providerInputTokens: 42,
            reservedOutputTokens: 100,
            activeTokens: 142,
            source: "provider",
            view: "raw",
          },
          compaction: {
            trigger: "auto_pre_turn",
            createdAt: 1_000,
            coverageThroughRunId: "run_ancestor",
            beforeTokens: 900,
            afterTokens: 100,
            status: "created",
          },
        },
      },
    });
    expect(JSON.stringify(liveMetadata)).not.toMatch(
      /PRIVATE_SUMMARY|PRIVATE_SAFETY|PRIVATE_CREDENTIAL|providerMetadata/i,
    );
    db.close();
  });
});
