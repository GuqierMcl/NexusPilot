import { describe, expect, test } from "bun:test";
import { simulateReadableStream, type ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import {
  RuntimeSqliteStore,
  RuntimeRunner,
  RuntimeTextRunner,
  ActiveRunRegistry,
  RuntimeToolRegistry,
  ContextCompactionService,
  ModelContextManager,
  projectMessageToAiSdkUIMessage,
  type GenerateConversationTitle,
  type RuntimeStreamText,
  type RuntimeTextRunnerDependencies,
  type RuntimeToolNamespace,
} from "../src/runtime";
import { traceEventSchema } from "../src/runtime/core/schemas";
import { openRuntimeDatabase } from "../src/storage/runtime-database";

function createWebRegistry(): RuntimeToolRegistry {
  const namespace: RuntimeToolNamespace = {
    id: "web",
    title: "Web",
    description: "Public web capabilities",
    tools: [{
      id: "web.fetch",
      title: "Fetch Web Page",
      description: "Fetch a public web page.",
      inputSchema: z.object({ url: z.string() }).strict(),
      outputSchema: z.object({
        finalUrl: z.string(),
        title: z.string(),
        preview: z.string(),
      }).strict(),
      executionTarget: "runtime",
      risk: {
        mode: "static",
        level: "low",
        reversible: true,
        sideEffect: "external_network",
      },
      execute: async () => ({
        summary: "Fetched.",
        data: {
          finalUrl: "https://example.com",
          title: "Example",
          preview: "Example page",
        },
      }),
    }],
    resolveForRun: () => ({ candidateToolIds: ["web.fetch"] }),
  };
  return new RuntimeToolRegistry([namespace]);
}

function streamFromText(text: string): RuntimeStreamText {
  return (input) => {
    void input.onChunk?.({ chunk: { type: "text-delta", text } });
    void input.onFinish?.({
      finishReason: "stop",
      totalUsage: {
        inputTokens: 3,
        inputTokenDetails: {
          noCacheTokens: 3,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens: 2,
        outputTokenDetails: {
          textTokens: 2,
          reasoningTokens: undefined,
        },
        totalTokens: 5,
      },
    });

    return {
      toUIMessageStreamResponse: () =>
        new Response(`data: ${JSON.stringify({ type: "text-delta", text })}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
    };
  };
}

function failingStream(error: Error): RuntimeStreamText {
  return (input) => {
    void input.onError?.({ error });
    return {
      toUIMessageStreamResponse: (options) =>
        new Response(
          `data: ${JSON.stringify({
            type: "error",
            errorText: options?.onError?.(error) ?? error.message,
          })}\n\n`,
          {
            headers: { "content-type": "text/event-stream" },
          },
        ),
    };
  };
}

function abortedStream(reason: string): RuntimeStreamText {
  return (input) => {
    void input.onChunk?.({ chunk: { type: "text-delta", text: "Partial" } });
    void input.onAbort?.({ reason });
    return {
      toUIMessageStreamResponse: () =>
        new Response(`data: ${JSON.stringify({ type: "abort", reason })}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
    };
  };
}

function preparedTestContext(
  requestIndex: number,
  messages: ModelMessage[] = [{ role: "user", content: "managed context" }],
) {
  return {
    plan: {
      id: `ctxplan_test_${requestIndex}`,
      conversationId: "conv_test",
      runId: "run_test",
      requestIndex,
      sourceHeadRunId: "run_test",
      sourceConversationRevision: 1,
      trigger: "auto_pre_turn" as const,
      providerId: "openai",
      modelId: "gpt-4o",
      budget: {
        estimatedInputTokens: 10,
        reservedOutputTokens: 4,
        rawHistoryTokens: 4,
        checkpointTokens: 0,
        safetyStateTokens: 0,
        systemPromptTokens: 1,
        toolSchemaTokens: 1,
      },
      view: "raw" as const,
    },
    messages,
  };
}

function managedPreparedTestContext(input: {
  conversationId: string;
  runId: string;
  requestIndex: number;
  trigger: "auto_pre_turn" | "auto_mid_turn" | "provider_overflow";
}, marker?: Record<string, unknown>) {
  const prepared = preparedTestContext(input.requestIndex);
  const resolvedMarker = marker ?? (input.trigger === "provider_overflow"
    ? {
        checkpointId: `ckpt_test_${input.requestIndex}`,
        trigger: "provider_overflow" as const,
        auto: true,
        coverageThroughRunId: input.runId,
        beforeEstimatedInputTokens: 100,
        afterEstimatedInputTokens: 10,
        status: "created" as const,
        time: { created: 2_000 + input.requestIndex },
      }
    : undefined);
  return {
    ...prepared,
    plan: {
      ...prepared.plan,
      conversationId: input.conversationId,
      runId: input.runId,
      sourceHeadRunId: input.runId,
      sourceConversationRevision: 1,
      requestIndex: input.requestIndex,
      trigger: input.trigger,
    },
    ...(resolvedMarker ? { marker: resolvedMarker } : {}),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sdkModelUsage(inputTokens: number, outputTokens = 2) {
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

function createRunner(
  streamText: RuntimeStreamText,
  toolRegistry?: RuntimeToolRegistry,
  generateConversationTitle?: GenerateConversationTitle,
  supportsTools = false,
  getToolApprovalPolicy?: () => {
    autoApproveMaxRisk: "none" | "low" | "medium";
  },
  resolveLanguageModel?: RuntimeTextRunnerDependencies["resolveLanguageModel"],
  getErrorMessageSecrets?: () => readonly string[],
  contextManager?: unknown,
) {
  const db = openRuntimeDatabase(":memory:");
  const store = new RuntimeSqliteStore(db);
  let idSequence = 0;
  let timeSequence = 0;

  const runner = new RuntimeTextRunner({
    store,
    appVersion: "test",
    now: () => 1000 + timeSequence++,
    createId: (prefix) => `${prefix}_${++idSequence}` as never,
    resolveLanguageModel: resolveLanguageModel ?? (() => ({
      languageModel: new MockLanguageModelV3(),
      runtimeContext: {
        provider: {
          providerId: "openai",
          modelId: "gpt-4o",
          modelName: "GPT-4o",
          contextLength: 128_000,
          outputLength: 4096,
          supportsTools,
          supportsReasoning: false,
          supportsVision: false,
        },
      },
    })),
    toolRegistry,
    streamText,
    generateConversationTitle,
    getToolApprovalPolicy,
    getErrorMessageSecrets,
    contextManager: contextManager as never,
  });

  return { db, store, runner };
}

function createRunnerWithActiveRegistry(streamText: RuntimeStreamText) {
  const db = openRuntimeDatabase(":memory:");
  const store = new RuntimeSqliteStore(db);
  const activeRuns = new ActiveRunRegistry();
  let idSequence = 0;
  let timeSequence = 0;

  const runner = new RuntimeTextRunner({
    store,
    activeRuns,
    appVersion: "test",
    now: () => 1000 + timeSequence++,
    createId: (prefix) => `${prefix}_${++idSequence}` as never,
    resolveLanguageModel: () => ({
      languageModel: new MockLanguageModelV3(),
      runtimeContext: {
        provider: {
          providerId: "openai",
          modelId: "gpt-4o",
        },
      },
    }),
    streamText,
  });

  return { db, store, runner, activeRuns };
}

function createRunnerWithModel(
  model: MockLanguageModelV3,
  toolRegistry?: RuntimeToolRegistry,
  contextManager?: unknown,
  getErrorMessageSecrets?: () => readonly string[],
) {
  const db = openRuntimeDatabase(":memory:");
  const store = new RuntimeSqliteStore(db);
  let idSequence = 0;
  let timeSequence = 0;

  const runner = new RuntimeTextRunner({
    store,
    appVersion: "test",
    now: () => 1000 + timeSequence++,
    createId: (prefix) => `${prefix}_${++idSequence}` as never,
    resolveLanguageModel: () => ({
      languageModel: model,
      runtimeContext: {
        provider: {
          providerId: "openai",
          modelId: "gpt-4o",
          contextLength: 128_000,
          outputLength: 4_096,
          supportsTools: true,
        },
      },
    }),
    toolRegistry,
    contextManager: contextManager as never,
    getErrorMessageSecrets,
  });

  return { db, store, runner };
}

function createRunnerWithToolMetadata(streamText: RuntimeStreamText) {
  const db = openRuntimeDatabase(":memory:");
  const store = new RuntimeSqliteStore(db);
  const toolRegistry = createWebRegistry();
  let idSequence = 0;
  let timeSequence = 0;

  const runner = new RuntimeTextRunner({
    store,
    appVersion: "test",
    now: () => 1000 + timeSequence++,
    createId: (prefix) => `${prefix}_${++idSequence}` as never,
    resolveLanguageModel: () => ({
      languageModel: new MockLanguageModelV3(),
      runtimeContext: {
        provider: {
          providerId: "openai",
          modelId: "gpt-4o",
          supportsTools: true,
        },
      },
    }),
    toolRegistry,
    streamText,
  });

  return { db, store, runner };
}

function createRunnerWithDefaultTools(
  streamText: RuntimeStreamText,
  getToolApprovalPolicy?: () => {
    autoApproveMaxRisk: "none" | "low" | "medium";
  },
) {
  const db = openRuntimeDatabase(":memory:");
  const store = new RuntimeSqliteStore(db);
  let idSequence = 0;
  let timeSequence = 0;

  const runner = new RuntimeTextRunner({
    store,
    appVersion: "test",
    now: () => 1000 + timeSequence++,
    createId: (prefix) => `${prefix}_${++idSequence}` as never,
    resolveLanguageModel: () => ({
      languageModel: new MockLanguageModelV3(),
      runtimeContext: {
        provider: {
          providerId: "openai",
          modelId: "gpt-4o",
          supportsTools: true,
        },
      },
    }),
    toolRegistry: createWebRegistry(),
    streamText,
    getToolApprovalPolicy,
  });

  return { db, store, runner };
}

describe("RuntimeTextRunner", () => {
  test("passes managed Runtime boundaries through AI SDK instructions", async () => {
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeSqliteStore(db);
    let idSequence = 0;
    let timeSequence = 0;
    const createId = (prefix: string) => `${prefix}_${++idSequence}` as never;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start" as const, id: "managed-context-text" },
            {
              type: "text-delta" as const,
              id: "managed-context-text",
              delta: "managed context accepted",
            },
            { type: "text-end" as const, id: "managed-context-text" },
            {
              type: "finish" as const,
              finishReason: { unified: "stop" as const, raw: undefined },
              logprobs: undefined,
              usage: sdkModelUsage(12),
            },
          ],
        }),
      }),
    });
    const compactionService = new ContextCompactionService({
      store,
      createId,
      generator: async () => {
        throw new Error("short raw history must not invoke the summarizer");
      },
    });
    const contextManager = new ModelContextManager({
      store,
      compactionService,
      createId,
      now: () => 1_000 + timeSequence++,
    });
    const runner = new RuntimeTextRunner({
      store,
      createId,
      now: () => 1_000 + timeSequence++,
      contextManager,
      resolveLanguageModel: () => ({
        languageModel: model,
        runtimeContext: {
          provider: {
            providerId: "openai",
            modelId: "gpt-4o",
            contextLength: 128_000,
            outputLength: 4_096,
          },
        },
      }),
    });

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Send a normal managed message",
    });
    const body = await result.response.text();

    expect(model.doStreamCalls).toHaveLength(1);
    expect(body).toContain("managed context accepted");
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain(
      "Runtime Safety State",
    );
    expect(store.getRun(result.started.run.id)?.status).toBe("completed");
    db.close();
  });

  test("retries one pre-output context overflow with the same selected model", async () => {
    let requests = 0;
    const preparations: Array<{ requestIndex: number; trigger: string }> = [];
    const contextManager = {
      prepare: async (input: Parameters<typeof managedPreparedTestContext>[0]) => {
        preparations.push(input);
        return managedPreparedTestContext(input);
      },
    };
    const streamText: RuntimeStreamText = async (input) => {
      requests += 1;
      if (requests === 1) {
        await input.onError?.({
          error: { name: "ProviderError", message: "context_length_exceeded" },
        });
        return { toUIMessageStreamResponse: () => new Response("data: first\n\n") };
      }
      await input.onChunk?.({ chunk: { type: "text-delta", text: "Recovered" } });
      await input.onFinish?.({ finishReason: "stop", stepCount: 1 });
      return { toUIMessageStreamResponse: () => new Response("data: recovered\n\n") };
    };
    const { db, store, runner } = createRunner(
      streamText,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      contextManager,
    );

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Recover this request",
    });
    await result.response.text();

    expect(requests).toBe(2);
    expect(preparations.map((item) => item.trigger)).toEqual([
      "auto_pre_turn",
      "provider_overflow",
    ]);
    expect(store.getRun(result.started.run.id)?.status).toBe("completed");
    expect(store.getMessage(result.started.assistantMessage.id)?.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: "Recovered" })]),
    );
    expect(store.listEvents(result.started.conversation.id).filter((event) => event.type === "runtime.error"))
      .toHaveLength(0);
    db.close();
  });

  test("does not retry a context overflow after visible model output", async () => {
    let requests = 0;
    const contextManager = {
      prepare: async (input: { requestIndex: number; trigger: string }) =>
        preparedTestContext(input.requestIndex),
    };
    const streamText: RuntimeStreamText = async (input) => {
      requests += 1;
      await input.onChunk?.({ chunk: { type: "text-delta", text: "Partial" } });
      await input.onError?.({
        error: { name: "ProviderError", message: "maximum context length exceeded" },
      });
      return { toUIMessageStreamResponse: () => new Response("data: failure\n\n") };
    };
    const { db, store, runner } = createRunner(
      streamText, undefined, undefined, false, undefined, undefined, undefined, contextManager,
    );

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Do not retry after output",
    });
    await result.response.text();

    expect(requests).toBe(1);
    expect(store.getRun(result.started.run.id)).toMatchObject({
      status: "failed",
      error: { data: { message: "maximum context length exceeded" } },
    });
    db.close();
  });

  test("surfaces the second overflow byte-for-byte and never issues a third request", async () => {
    const firstError = Object.assign(new Error("maximum context length exceeded"), {
      name: "FirstContextError",
      statusCode: 400,
    });
    const secondMessage = "  context window exceeded\n\nrequest   id:\tsecond-42  ";
    const secondError = Object.assign(new Error(secondMessage), {
      name: "SecondContextError",
      statusCode: 400,
      isRetryable: false,
    });
    let requests = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [{
            type: "error" as const,
            error: ++requests === 1 ? firstError : secondError,
          }],
        }),
      }),
    });
    const contextManager = {
      prepare: async (input: Parameters<typeof managedPreparedTestContext>[0]) =>
        managedPreparedTestContext(input),
    };
    const { db, store, runner } = createRunnerWithModel(
      model,
      undefined,
      contextManager,
    );

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Retry at most once",
    });
    const body = await result.response.text();
    const wireErrors = body
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("data: {") && chunk.includes("\"type\":\"error\""))
      .map((chunk) => JSON.parse(chunk.slice("data: ".length)));

    expect(requests).toBe(2);
    expect(body).not.toContain(firstError.message);
    expect(wireErrors).toEqual([{ type: "error", errorText: secondMessage }]);
    expect(store.getRun(result.started.run.id)).toMatchObject({
      status: "failed",
      error: {
        name: "SecondContextError",
        data: { message: secondMessage, statusCode: 400, isRetryable: false },
      },
    });
    expect(store.listEventsByRun(result.started.run.id).filter(
      (event) => event.type === "runtime.error",
    )).toHaveLength(1);
    expect(store.listMessages(result.started.conversation.id).filter(
      (message) => message.role === "assistant" && message.status.type === "error",
    )).toHaveLength(1);
    const retryAudit = store.listTraces(result.started.run.id).filter(
      (trace) => trace.type === "context.overflow.retrying",
    );
    const recovery = store.listTraces(result.started.run.id).filter(
      (trace) => trace.type === "context.overflow.recovered",
    );
    expect(retryAudit).toHaveLength(1);
    expect(JSON.stringify(retryAudit[0])).toContain(firstError.message);
    expect(JSON.stringify(retryAudit[0])).not.toContain(secondMessage);
    expect(recovery).toHaveLength(0);
    db.close();
  });

  test("replaces a lazy default AI SDK overflow stream without leaking the first attempt", async () => {
    const firstError = Object.assign(
      new Error("maximum context length exceeded\nFIRST_ATTEMPT_ONLY"),
      { name: "LazyContextError", statusCode: 400 },
    );
    let requests = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        requests += 1;
        return {
          stream: simulateReadableStream({
            chunks: (requests === 1
              ? [
                  { type: "text-start" as const, id: "first-transient" },
                  { type: "error" as const, error: firstError },
                ]
              : [
                  { type: "text-start" as const, id: "replacement-text" },
                  {
                    type: "text-delta" as const,
                    id: "replacement-text",
                    delta: "replacement success",
                  },
                  { type: "text-end" as const, id: "replacement-text" },
                  {
                    type: "finish" as const,
                    finishReason: { unified: "stop" as const, raw: undefined },
                    logprobs: undefined,
                    usage: {
                      inputTokens: {
                        total: 4,
                        noCache: 4,
                        cacheRead: undefined,
                        cacheWrite: undefined,
                      },
                      outputTokens: { total: 2, text: 2, reasoning: 0 },
                    },
                  },
                ]) as never,
          }),
        };
      },
    });
    const contextManager = {
      prepare: async (input: Parameters<typeof managedPreparedTestContext>[0]) =>
        managedPreparedTestContext(input),
    };
    const { db, store, runner } = createRunnerWithModel(model, undefined, contextManager);

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Exercise the real lazy SDK stream",
    });
    const body = await result.response.text();

    expect(requests).toBe(2);
    expect(body).toContain("replacement success");
    expect(body).not.toContain("FIRST_ATTEMPT_ONLY");
    expect(body).not.toContain("first-transient");
    expect((body.match(/\"type\":\"error\"/g) ?? [])).toHaveLength(0);
    expect((body.match(/\"type\":\"start\"/g) ?? [])).toHaveLength(1);
    expect((body.match(/\"type\":\"finish\"/g) ?? [])).toHaveLength(1);
    expect((body.match(/\"messageMetadata\":/g) ?? [])).toHaveLength(2);
    expect(body).toContain("provider_overflow");
    expect(store.getRun(result.started.run.id)?.status).toBe("completed");
    const assistant = store.getMessage(result.started.assistantMessage.id);
    expect(assistant?.role === "assistant" ? assistant.status.type : undefined).toBe("complete");
    expect(store.listEventsByRun(result.started.run.id).filter(
      (event) => event.type === "runtime.error",
    )).toHaveLength(0);
    expect(store.listTraces(result.started.run.id).filter(
      (trace) => trace.type === "context.overflow.recovered",
    )).toHaveLength(1);
    db.close();
  });

  test.each([
    [
      "URL source",
      {
        type: "source" as const,
        sourceType: "url" as const,
        id: "source-url-1",
        url: "https://example.com/source",
        title: "Generated source",
      },
    ],
    [
      "document source",
      {
        type: "source" as const,
        sourceType: "document" as const,
        id: "source-document-1",
        mediaType: "application/pdf",
        title: "Generated report",
        filename: "report.pdf",
      },
    ],
    [
      "file",
      {
        type: "file" as const,
        mediaType: "application/pdf",
        data: { type: "data" as const, data: new Uint8Array([1, 2, 3]) },
      },
    ],
    [
      "reasoning file",
      {
        type: "reasoning-file" as const,
        mediaType: "image/png",
        data: { type: "data" as const, data: new Uint8Array([4, 5, 6]) },
      },
    ],
    [
      "custom provider content",
      {
        type: "custom" as const,
        kind: "test.generated-artifact" as const,
        providerMetadata: { test: { artifactId: "artifact-1" } },
      },
    ],
  ] as const)(
    "keeps original overflow terminal after default SDK %s output",
    async (_name, semanticPart) => {
      const providerError = Object.assign(
        new Error(`maximum context length exceeded\n${_name.toUpperCase().replaceAll(" ", "_")}`),
        { name: "SemanticPartContextError", statusCode: 400, isRetryable: false },
      );
      let requests = 0;
      const model = new MockLanguageModelV3({
        doStream: async () => {
          requests += 1;
          return {
            stream: simulateReadableStream({
              chunks: [
                semanticPart,
                { type: "error" as const, error: providerError },
              ] as never,
            }),
          };
        },
      });
      const preparationTriggers: string[] = [];
      const contextManager = {
        prepare: async (input: Parameters<typeof managedPreparedTestContext>[0]) => {
          preparationTriggers.push(input.trigger);
          return managedPreparedTestContext(input);
        },
      };
      const { db, store, runner } = createRunnerWithModel(model, undefined, contextManager);

      const result = await runner.streamText({
        providerId: "openai",
        modelId: "gpt-4o",
        text: `Preserve the ${_name}`,
      });
      const body = await result.response.text();
      const wireErrors = body
        .split("\n\n")
        .filter((chunk) => chunk.startsWith("data: {") && chunk.includes("\"type\":\"error\""))
        .map((chunk) => JSON.parse(chunk.slice("data: ".length)));

      expect(requests).toBe(1);
      expect(preparationTriggers).toEqual(["auto_pre_turn"]);
      expect(wireErrors).toEqual([{ type: "error", errorText: providerError.message }]);
      expect(body).not.toContain("provider_overflow");
      expect(store.getRun(result.started.run.id)).toMatchObject({
        status: "failed",
        error: {
          name: "SemanticPartContextError",
          data: {
            message: providerError.message,
            statusCode: 400,
            isRetryable: false,
          },
        },
      });
      expect(store.listTraces(result.started.run.id).filter(
        (trace) => trace.type === "context.overflow.recovered",
      )).toHaveLength(0);
      expect(store.listMessages(result.started.conversation.id).flatMap(
        (message) => message.parts.filter((part) => part.type === "compaction"),
      )).toHaveLength(0);
      db.close();
    },
  );

  test("releases default SDK response readiness on an unsupported semantic part", async () => {
    const providerError = Object.assign(
      new Error("maximum context length exceeded\nAFTER_DOCUMENT_SOURCE"),
      { name: "DelayedSemanticPartContextError", statusCode: 400 },
    );
    const releaseOverflow = createDeferred<void>();
    let requests = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        requests += 1;
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "source",
                sourceType: "document",
                id: "source-before-delayed-overflow",
                mediaType: "application/pdf",
                title: "Generated report",
              } as never);
              void releaseOverflow.promise.then(() => {
                controller.enqueue({ type: "error", error: providerError } as never);
                controller.close();
              });
            },
          }),
        };
      },
    });
    const contextManager = {
      prepare: async (input: Parameters<typeof managedPreparedTestContext>[0]) =>
        managedPreparedTestContext(input),
    };
    const { db, store, runner } = createRunnerWithModel(model, undefined, contextManager);

    const operation = runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Release on unsupported semantic output",
    });
    const returnedBeforeOverflow = await Promise.race([
      operation.then(() => true),
      Bun.sleep(500).then(() => false),
    ]);
    releaseOverflow.resolve();
    const result = await operation;
    await result.response.text();

    expect(returnedBeforeOverflow).toBe(true);
    expect(requests).toBe(1);
    expect(store.getRun(result.started.run.id)).toMatchObject({
      status: "failed",
      error: { data: { message: providerError.message } },
    });
    expect(store.listTraces(result.started.run.id).filter(
      (trace) => trace.type === "context.overflow.recovered",
    )).toHaveLength(0);
    db.close();
  });

  test("owns a request-2 construction rejection and never falls back to attempt 0", async () => {
    const firstError = Object.assign(new Error("maximum context length exceeded\nFIRST_ONLY"), {
      name: "FirstConstructionContextError",
    });
    const secondMessage = "  replacement construction failed\nrequest 2  ";
    const secondError = Object.assign(new Error(secondMessage), {
      name: "ReplacementConstructionError",
      statusCode: 503,
    });
    let requests = 0;
    const streamText: RuntimeStreamText = (input) => {
      requests += 1;
      if (requests === 2) throw secondError;
      const responseReady = Promise.resolve()
        .then(() => input.onError?.({ error: firstError }))
        .then(() => undefined, () => undefined);
      return {
        responseReady,
        toUIMessageStreamResponse: (options) => new Response(
          `data: ${JSON.stringify({
            type: "error",
            errorText: options?.onError?.(firstError) ?? firstError.message,
          })}\n\n`,
        ),
      };
    };
    const { db, store, runner } = createRunner(
      streamText,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      { prepare: async (input: Parameters<typeof managedPreparedTestContext>[0]) =>
        managedPreparedTestContext(input) },
    );

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Own replacement construction failure",
    });
    const body = await result.response.text();
    const wireError = JSON.parse(body.split("\n\n")[0]!.slice("data: ".length));

    expect(requests).toBe(2);
    expect(wireError).toEqual({ type: "error", errorText: secondMessage });
    expect(body).not.toContain(firstError.message);
    expect(store.getRun(result.started.run.id)).toMatchObject({
      status: "failed",
      error: {
        name: "ReplacementConstructionError",
        data: { message: secondMessage, statusCode: 503 },
      },
    });
    expect(store.listEventsByRun(result.started.run.id).filter(
      (event) => event.type === "runtime.error",
    )).toHaveLength(1);
    expect(store.listMessages(result.started.conversation.id).filter(
      (message) => message.role === "assistant" && message.status.type === "error",
    )).toHaveLength(1);
    expect(store.listTraces(result.started.run.id).filter(
      (trace) => trace.type === "context.overflow.retrying",
    )[0]?.payload).toMatchObject({
      error: { data: { message: firstError.message } },
    });
    expect(store.listTraces(result.started.run.id).filter(
      (trace) => trace.type === "context.overflow.recovered",
    )).toHaveLength(0);
    db.close();
  });

  test("treats a UI-only overflow without responseReady as terminal after commit", async () => {
    const providerError = Object.assign(
      new Error("  context window exceeded\nUI_ONLY_FINAL  "),
      { name: "UiOnlyContextError" },
    );
    let requests = 0;
    const streamText: RuntimeStreamText = () => {
      requests += 1;
      return {
        toUIMessageStreamResponse: (options) => new Response(
          `data: ${JSON.stringify({
            type: "error",
            errorText: options?.onError?.(providerError) ?? providerError.message,
          })}\n\n`,
        ),
      };
    };
    const { db, store, runner } = createRunner(
      streamText,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      { prepare: async (input: Parameters<typeof managedPreparedTestContext>[0]) =>
        managedPreparedTestContext(input) },
    );

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Commit before UI-only error",
    });
    const body = await result.response.text();
    await Promise.resolve();
    await Promise.resolve();
    const wireError = JSON.parse(body.split("\n\n")[0]!.slice("data: ".length));

    expect(requests).toBe(1);
    expect(wireError).toEqual({ type: "error", errorText: providerError.message });
    expect(store.getRun(result.started.run.id)).toMatchObject({
      status: "failed",
      error: { name: "UiOnlyContextError", data: { message: providerError.message } },
    });
    expect(store.listEventsByRun(result.started.run.id).filter(
      (event) => event.type === "runtime.error",
    )).toHaveLength(1);
    db.close();
  });

  test("does not double-retry when fullStream and UI observe an overflow at commit", async () => {
    const providerError = Object.assign(
      new Error("maximum context length exceeded\nDUAL_OBSERVER"),
      { name: "DualObserverContextError" },
    );
    let requests = 0;
    let fullStreamErrors = 0;
    let uiErrors = 0;
    const streamText: RuntimeStreamText = (input) => {
      requests += 1;
      if (requests === 1) {
        queueMicrotask(() => {
          fullStreamErrors += 1;
          void input.onError?.({ error: providerError });
        });
      }
      return {
        toUIMessageStreamResponse: (options) => {
          uiErrors += 1;
          return new Response(
            `data: ${JSON.stringify({
              type: "error",
              errorText: options?.onError?.(providerError) ?? providerError.message,
            })}\n\n`,
          );
        },
      };
    };
    const { db, store, runner } = createRunner(
      streamText,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      { prepare: async (input: Parameters<typeof managedPreparedTestContext>[0]) =>
        managedPreparedTestContext(input) },
    );

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Observe at both stream boundaries",
    });
    await result.response.text();
    await Promise.resolve();
    await Promise.resolve();

    expect(requests).toBe(1);
    expect(fullStreamErrors).toBe(1);
    expect(uiErrors).toBe(1);
    expect(store.listEventsByRun(result.started.run.id).filter(
      (event) => event.type === "runtime.error",
    )).toHaveLength(1);
    expect(store.listTraces(result.started.run.id).filter(
      (trace) => trace.type === "context.overflow.recovered",
    )).toHaveLength(0);
    db.close();
  });

  test.each([
    ["auth", { name: "ProviderAuthError", message: "unauthorized", statusCode: 401 }],
    ["network", { name: "NetworkError", message: "socket disconnected" }],
    ["rate", { name: "RateLimitError", message: "rate limit exceeded", statusCode: 429 }],
    ["tool", { name: "InvalidToolInputError", message: "invalid tool input" }],
    ["attachment", { name: "UnsupportedAttachmentError", message: "unsupported attachment" }],
    ["unsupported model", {
      name: "UnsupportedModelError",
      message: "  prompt too long\nunsupported model  ",
    }],
    ["missing model", {
      name: "ModelNotFoundError",
      message: "maximum context length\nmodel not found",
    }],
    ["disabled model", {
      name: "ModelDisabledError",
      message: "context window exceeded\nmodel disabled",
    }],
    ["tool execution", {
      name: "ToolExecutionError",
      message: "too many tokens\ntool execution failed",
    }],
    ["model code", {
      name: "ProviderError",
      code: "model_not_found",
      message: "context length exceeded",
    }],
    ["tool code", {
      name: "ProviderError",
      code: "tool_execution_error",
      message: "prompt too long",
    }],
  ] as const)("does not retry a representative %s runner error", async (_kind, providerError) => {
    let requests = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        requests += 1;
        return {
          stream: simulateReadableStream({
            chunks: [{ type: "error" as const, error: providerError }],
          }),
        };
      },
    });
    const contextManager = {
      prepare: async (input: Parameters<typeof managedPreparedTestContext>[0]) =>
        managedPreparedTestContext(input),
    };
    const { db, store, runner } = createRunnerWithModel(model, undefined, contextManager);

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Do not retry this failure",
    });
    const body = await result.response.text();
    const wireErrors = body
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("data: {") && chunk.includes("\"type\":\"error\""))
      .map((chunk) => JSON.parse(chunk.slice("data: ".length)));

    expect(requests).toBe(1);
    expect(wireErrors).toEqual([{ type: "error", errorText: providerError.message }]);
    expect(store.getRun(result.started.run.id)).toMatchObject({
      status: "failed",
      error: {
        name: providerError.name,
        data: {
          message: providerError.message,
          ...("statusCode" in providerError ? { statusCode: providerError.statusCode } : {}),
        },
      },
    });
    expect(store.listEventsByRun(result.started.run.id).filter(
      (event) => event.type === "runtime.error",
    )).toHaveLength(1);
    expect(store.listMessages(result.started.conversation.id).filter(
      (message) => message.role === "assistant" && message.status.type === "error",
    )).toHaveLength(1);
    db.close();
  });

  test.each([
    ["nonempty text", async (input: Parameters<RuntimeStreamText>[0]) => {
      await input.onChunk?.({ chunk: { type: "text-delta", text: "visible" } });
    }],
    ["nonempty reasoning", async (input: Parameters<RuntimeStreamText>[0]) => {
      await input.onChunk?.({ chunk: { type: "reasoning-delta", text: "reason" } });
    }],
    ["source", async (input: Parameters<RuntimeStreamText>[0]) => {
      await input.onChunk?.({
        chunk: { type: "source-url", sourceId: "source-1", url: "https://example.com" },
      });
    }],
    ["tool-input-start", async (input: Parameters<RuntimeStreamText>[0]) => {
      await input.onChunk?.({
        chunk: {
          type: "tool-input-start",
          toolCallId: "call_fact",
          toolName: "np__web__fetch",
        },
      });
    }],
    ["tool-input-delta", async (input: Parameters<RuntimeStreamText>[0]) => {
      await input.onChunk?.({
        chunk: { type: "tool-input-delta", toolCallId: "call_fact", delta: "{" },
      });
    }],
    ["tool-input-end", async (input: Parameters<RuntimeStreamText>[0]) => {
      await input.onChunk?.({ chunk: { type: "tool-input-end", toolCallId: "call_fact" } });
    }],
    ["tool-call", async (input: Parameters<RuntimeStreamText>[0]) => {
      await input.onChunk?.({
        chunk: {
          type: "tool-call",
          toolCallId: "call_fact",
          toolName: "np__web__fetch",
          input: { url: "https://example.com" },
        },
      });
    }],
    ["tool-result", async (input: Parameters<RuntimeStreamText>[0]) => {
      await input.onChunk?.({
        chunk: {
          type: "tool-result",
          toolCallId: "call_fact",
          toolName: "np__web__fetch",
          input: { url: "https://example.com" },
          output: {
            ok: true,
            output: { data: {}, display: { summary: "done" } },
            metadata: { started: 1, completed: 2, durationMs: 1 },
          },
        },
      });
    }],
    ["tool-error", async (input: Parameters<RuntimeStreamText>[0]) => {
      await input.onChunk?.({
        chunk: {
          type: "tool-error",
          toolCallId: "call_fact",
          toolName: "np__web__fetch",
          input: { url: "https://example.com" },
          error: new Error("tool failed"),
        },
      });
    }],
    ["tool execution start", async (input: Parameters<RuntimeStreamText>[0]) => {
      await input.onToolCallStart?.({
        toolCall: {
          toolCallId: "call_execution",
          toolName: "np__web__fetch",
          input: { url: "https://example.com" },
        },
      });
    }],
    ["tool execution finish", async (input: Parameters<RuntimeStreamText>[0]) => {
      await input.onToolCallFinish?.({
        toolCall: {
          toolCallId: "call_execution",
          toolName: "np__web__fetch",
          input: { url: "https://example.com" },
        },
        durationMs: 1,
        success: true,
        output: {
          ok: true,
          output: { data: {}, display: { summary: "done" } },
          metadata: { started: 1, completed: 2, durationMs: 1 },
        },
      });
    }],
    ["Permission response", async (input: Parameters<RuntimeStreamText>[0]) => {
      await input.onChunk?.({
        chunk: {
          type: "tool-approval-response",
          approvalId: "approval_fact",
          toolCallId: "call_fact",
          toolName: "np__web__fetch",
          input: { url: "https://example.com" },
          approved: true,
        },
      });
    }],
  ] as const)("does not retry after the production %s mapping observes a fact", async (_name, emitFact) => {
    const providerError = Object.assign(new Error("context length exceeded\nFACT_ERROR"), {
      name: "ContextFactError",
    });
    let requests = 0;
    const streamText: RuntimeStreamText = async (input) => {
      requests += 1;
      await emitFact(input);
      await input.onError?.({ error: providerError });
      return {
        toUIMessageStreamResponse: (options) => new Response(
          `data: ${JSON.stringify({
            type: "error",
            errorText: options?.onError?.(providerError) ?? providerError.message,
          })}\n\n`,
        ),
      };
    };
    const { db, store, runner } = createRunner(
      streamText,
      createWebRegistry(),
      undefined,
      true,
      () => ({ autoApproveMaxRisk: "none" }),
      undefined,
      undefined,
      { prepare: async (input: Parameters<typeof managedPreparedTestContext>[0]) =>
        managedPreparedTestContext(input) },
    );

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Do not retry after facts",
      agentMode: "agent",
    });
    await result.response.text();

    expect(requests).toBe(1);
    expect(store.getRun(result.started.run.id)?.error).toEqual({
      name: "ContextFactError",
      data: { message: providerError.message },
    });
    expect(store.listEventsByRun(result.started.run.id).filter(
      (event) => event.type === "runtime.error",
    )).toHaveLength(1);
    db.close();
  });

  test("does not retry after the production Permission request mapping", async () => {
    const providerError = Object.assign(new Error("prompt too long\nPERMISSION_REQUEST"), {
      name: "PermissionContextError",
    });
    let requests = 0;
    const streamText: RuntimeStreamText = async (input) => {
      requests += 1;
      const toolCall = {
        type: "tool-call" as const,
        toolCallId: "call_permission_fact",
        toolName: "np__web__fetch",
        input: { url: "https://example.com" },
      };
      await input.onChunk?.({ chunk: toolCall });
      const approve = input.toolApproval as unknown as (value: {
        toolCall: typeof toolCall;
        tools: unknown;
        toolsContext: Record<string, never>;
        runtimeContext: undefined;
        messages: [];
      }) => Promise<unknown>;
      expect(await approve({
        toolCall,
        tools: input.tools,
        toolsContext: {},
        runtimeContext: undefined,
        messages: [],
      })).toBe("user-approval");
      await input.onChunk?.({
        chunk: {
          type: "tool-approval-request",
          approvalId: "approval_permission_fact",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.input,
        },
      });
      await input.onError?.({ error: providerError });
      return { toUIMessageStreamResponse: () => new Response("data: permission-error\n\n") };
    };
    const { db, store, runner } = createRunner(
      streamText,
      createWebRegistry(),
      undefined,
      true,
      () => ({ autoApproveMaxRisk: "none" }),
      undefined,
      undefined,
      { prepare: async (input: Parameters<typeof managedPreparedTestContext>[0]) =>
        managedPreparedTestContext(input) },
    );

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Request approval",
      agentMode: "agent",
    });
    await result.response.text();

    expect(requests).toBe(1);
    expect(store.getRun(result.started.run.id)?.error?.data).toEqual({
      message: providerError.message,
    });
    db.close();
  });

  test("does not retry when a durable side-effect ledger fact exists", async () => {
    const runId = "run_side_effect_overflow" as never;
    const providerError = Object.assign(new Error("too many tokens\nSIDE_EFFECT"), {
      name: "SideEffectContextError",
    });
    let requests = 0;
    let storeRef: RuntimeSqliteStore;
    const streamText: RuntimeStreamText = async (input) => {
      requests += 1;
      const run = storeRef.getRun(runId)!;
      storeRef.saveToolCall({
        id: "tool_side_effect_overflow" as never,
        conversationId: run.conversationId,
        runId,
        messageId: run.assistantMessageId!,
        toolName: "web.fetch",
        input: { url: "https://example.com" },
        state: "running",
        time: { created: 10, started: 11 },
      });
      await input.onError?.({ error: providerError });
      return { toUIMessageStreamResponse: () => new Response("data: side-effect-error\n\n") };
    };
    const created = createRunner(
      streamText,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      { prepare: async (input: Parameters<typeof managedPreparedTestContext>[0]) =>
        managedPreparedTestContext(input) },
    );
    storeRef = created.store;

    const result = await created.runner.streamText({
      runId,
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Never retry a side effect",
    });
    await result.response.text();

    expect(requests).toBe(1);
    expect(created.store.getRun(runId)?.error?.data).toEqual({
      message: providerError.message,
    });
    created.db.close();
  });

  test.each(["active head", "revision"] as const)(
    "fails the first error when the %s changes during recovery preparation",
    async (changedField) => {
    const providerError = Object.assign(
      new Error("context_length_exceeded\nREVISION_RACE"),
      { name: "RevisionRaceContextError" },
    );
    let requests = 0;
    let storeRef: RuntimeSqliteStore;
    const streamText: RuntimeStreamText = async (input) => {
      requests += 1;
      if (requests === 1) {
        await input.onError?.({ error: providerError });
      } else {
        await input.onChunk?.({ chunk: { type: "text-delta", text: "stale retry" } });
        await input.onFinish?.({ finishReason: "stop", stepCount: 1 });
      }
      return { toUIMessageStreamResponse: () => new Response("data: revision-race\n\n") };
    };
    const contextManager = {
      prepare: async (input: Parameters<typeof managedPreparedTestContext>[0]) => {
        const before = storeRef.getConversation(input.conversationId as never)!;
        if (input.trigger === "provider_overflow") {
          storeRef.saveConversation({
            ...before,
            ...(changedField === "active head" ? { activeHeadRunId: undefined } : {}),
            revision: before.revision + (changedField === "revision" ? 1 : 0),
          });
        }
        return {
          ...managedPreparedTestContext(input),
          plan: {
            ...managedPreparedTestContext(input).plan,
            sourceConversationRevision: before.revision,
          },
        };
      },
    };
    const created = createRunner(
      streamText,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      contextManager,
    );
    storeRef = created.store;

    const result = await created.runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Race the recovery",
    });
    await result.response.text();

    expect(requests).toBe(1);
    expect(created.store.listContextUsagesByRun(result.started.run.id)).toHaveLength(1);
    expect(created.store.listTraces(result.started.run.id).filter(
      (trace) => trace.type === "context.overflow.recovered",
    )).toHaveLength(0);
    expect(created.store.getRun(result.started.run.id)?.error).toEqual({
      name: "RevisionRaceContextError",
      data: { message: providerError.message },
    });
    expect(created.store.listEventsByRun(result.started.run.id).filter(
      (event) => event.type === "runtime.error",
    )).toHaveLength(1);
    created.db.close();
    },
  );

  test.each(["finish", "abort"] as const)(
    "quarantines an attempt-0 %s callback while overflow compaction is deferred",
    async (callbackKind) => {
      const providerError = Object.assign(
        new Error(`context length exceeded\nSTALE_${callbackKind.toUpperCase()}`),
        { name: "DeferredCallbackContextError" },
      );
      const preparationEntered = createDeferred<void>();
      const releasePreparation = createDeferred<void>();
      let firstInput: Parameters<RuntimeStreamText>[0] | undefined;
      let requests = 0;
      const streamText: RuntimeStreamText = (input) => {
        requests += 1;
        if (requests === 1) {
          firstInput = input;
          const responseReady = Promise.resolve()
            .then(() => input.onError?.({ error: providerError }))
            .then(() => undefined);
          return {
            responseReady,
            toUIMessageStreamResponse: (options) => new Response(
              `data: ${JSON.stringify({
                type: "error",
                errorText: options?.onError?.(providerError) ?? providerError.message,
              })}\n\n`,
            ),
          };
        }
        return streamFromText("stale replacement")(input);
      };
      const contextManager = {
        prepare: async (input: Parameters<typeof managedPreparedTestContext>[0]) => {
          if (input.trigger === "provider_overflow") {
            preparationEntered.resolve(undefined);
            await releasePreparation.promise;
          }
          return managedPreparedTestContext(input);
        },
      };
      const { db, store, runner } = createRunner(
        streamText,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        contextManager,
      );

      const runPromise = runner.streamText({
        providerId: "openai",
        modelId: "gpt-4o",
        text: "Defer overflow compaction",
      });
      await preparationEntered.promise;
      if (!firstInput) throw new Error("Attempt 0 input was not captured");
      if (callbackKind === "finish") {
        await firstInput.onFinish?.({ finishReason: "stop", stepCount: 1 });
      } else {
        await firstInput.onAbort?.({ reason: "stale attempt abort" });
      }
      releasePreparation.resolve(undefined);
      const result = await runPromise;
      const body = await result.response.text();
      const wireError = JSON.parse(body.split("\n\n")[0]!.slice("data: ".length));

      expect(requests).toBe(1);
      expect(wireError).toEqual({ type: "error", errorText: providerError.message });
      expect(store.getRun(result.started.run.id)).toMatchObject({
        status: "failed",
        error: {
          name: "DeferredCallbackContextError",
          data: { message: providerError.message },
        },
      });
      expect(store.listEventsByRun(result.started.run.id).filter(
        (event) => event.type === "runtime.error",
      )).toHaveLength(1);
      expect(store.listTraces(result.started.run.id).filter(
        (trace) => trace.type === "context.overflow.recovered",
      )).toHaveLength(0);
      expect(store.listContextUsagesByRun(result.started.run.id)).toHaveLength(1);
      db.close();
    },
  );

  test("honors an abort signal while overflow compaction is deferred", async () => {
    const controller = new AbortController();
    const providerError = Object.assign(new Error("prompt too long\nDEFERRED_ABORT"), {
      name: "DeferredAbortContextError",
    });
    const preparationEntered = createDeferred<void>();
    const releasePreparation = createDeferred<void>();
    let requests = 0;
    const streamText: RuntimeStreamText = (input) => {
      requests += 1;
      if (requests === 1) {
        return {
          responseReady: Promise.resolve()
            .then(() => input.onError?.({ error: providerError }))
            .then(() => undefined),
          toUIMessageStreamResponse: () => new Response("data: aborted\n\n"),
        };
      }
      return streamFromText("must not run")(input);
    };
    const contextManager = {
      prepare: async (input: Parameters<typeof managedPreparedTestContext>[0]) => {
        if (input.trigger === "provider_overflow") {
          preparationEntered.resolve(undefined);
          await releasePreparation.promise;
        }
        return managedPreparedTestContext(input);
      },
    };
    const { db, store, runner } = createRunner(
      streamText,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      contextManager,
    );

    const runPromise = runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Abort deferred recovery",
    }, controller.signal);
    await preparationEntered.promise;
    controller.abort("user stopped deferred recovery");
    releasePreparation.resolve(undefined);
    const result = await runPromise;
    await result.response.text();

    expect(requests).toBe(1);
    expect(store.getRun(result.started.run.id)).toMatchObject({
      status: "interrupted",
      finish: "interrupted",
      metadata: {
        interrupt: {
          reason: "user_stop",
          message: "user stopped deferred recovery",
        },
      },
    });
    expect(store.listEventsByRun(result.started.run.id).filter(
      (event) => event.type === "runtime.error",
    )).toHaveLength(0);
    expect(store.listTraces(result.started.run.id).filter(
      (trace) => trace.type === "context.overflow.recovered",
    )).toHaveLength(0);
    expect(store.listContextUsagesByRun(result.started.run.id)).toHaveLength(1);
    db.close();
  });

  test.each([
    ["interrupted", "resolves"],
    ["failed", "resolves"],
    ["completed", "resolves"],
    ["completed", "rejects"],
  ] as const)(
    "does not replace an externally %s Run when deferred overflow compaction %s",
    async (terminalStatus, compactionOutcome) => {
      const providerError = Object.assign(new Error("too many tokens\nTERMINAL_RACE"), {
        name: "TerminalRaceContextError",
      });
      const externalError = {
        name: "ExternalTerminalError",
        data: { message: "external terminal owner" },
      };
      const preparationEntered = createDeferred<void>();
      const releasePreparation = createDeferred<void>();
      let requests = 0;
      const streamText: RuntimeStreamText = (input) => {
        requests += 1;
        if (requests === 1) {
          return {
            responseReady: Promise.resolve()
              .then(() => input.onError?.({ error: providerError }))
              .then(() => undefined),
            toUIMessageStreamResponse: (options) => new Response(
              `data: ${JSON.stringify({
                type: "error",
                errorText: options?.onError?.(providerError) ?? providerError.message,
              })}\n\n`,
            ),
          };
        }
        return streamFromText("must not replace terminal Run")(input);
      };
      const contextManager = {
        prepare: async (input: Parameters<typeof managedPreparedTestContext>[0]) => {
          if (input.trigger === "provider_overflow") {
            preparationEntered.resolve(undefined);
            await releasePreparation.promise;
          }
          return managedPreparedTestContext(input);
        },
      };
      const { db, store, runner } = createRunner(
        streamText,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        contextManager,
      );
      const runId = `run_external_${terminalStatus}` as never;
      const runPromise = runner.streamText({
        runId,
        providerId: "openai",
        modelId: "gpt-4o",
        text: "Race an external terminal owner",
      });
      await preparationEntered.promise;
      const run = store.getRun(runId)!;
      const conversation = store.getConversation(run.conversationId)!;
      const userMessage = store.getMessage(run.parentMessageId!)!;
      const assistantMessage = store.getMessage(run.assistantMessageId!)!;
      if (userMessage.role !== "user" || assistantMessage.role !== "assistant") {
        throw new Error("Invalid deferred terminal fixture");
      }
      let externalId = 0;
      const terminalRunner = new RuntimeRunner({
        store,
        now: () => 4_000,
        createId: (prefix) =>
          `${prefix}_external_${terminalStatus}_${++externalId}` as never,
      });
      const started = { conversation, run, userMessage, assistantMessage };
      if (terminalStatus === "interrupted") {
        terminalRunner.interrupt(started, {
          reason: "user_stop",
          message: "external interruption",
        });
      } else if (terminalStatus === "failed") {
        terminalRunner.fail(started, externalError);
      } else {
        terminalRunner.completeText(started, "external completion");
      }
      if (compactionOutcome === "rejects") {
        releasePreparation.reject(new Error("deferred compaction rejected"));
      } else {
        releasePreparation.resolve(undefined);
      }
      const result = await runPromise;
      await result.response.text();

      expect(requests).toBe(1);
      expect(store.getRun(runId)?.status).toBe(terminalStatus);
      if (terminalStatus === "failed") {
        expect(store.getRun(runId)?.error).toEqual(externalError);
      }
      expect(store.listEventsByRun(runId).filter(
        (event) => event.type === "runtime.error",
      )).toHaveLength(terminalStatus === "failed" ? 1 : 0);
      expect(store.listTraces(runId).filter(
        (trace) => trace.type === "context.overflow.recovered",
      )).toHaveLength(0);
      expect(store.listContextUsagesByRun(runId)).toHaveLength(1);
      db.close();
    },
  );

  test("fails closed when a pending Permission appears during overflow compaction", async () => {
    const providerError = Object.assign(new Error("context window exceeded\nPERMISSION_RACE"), {
      name: "PermissionRaceContextError",
    });
    const preparationEntered = createDeferred<void>();
    const releasePreparation = createDeferred<void>();
    let requests = 0;
    const streamText: RuntimeStreamText = (input) => {
      requests += 1;
      if (requests === 1) {
        return {
          responseReady: Promise.resolve()
            .then(() => input.onError?.({ error: providerError }))
            .then(() => undefined),
          toUIMessageStreamResponse: () => new Response("data: permission-race\n\n"),
        };
      }
      return streamFromText("must not run")(input);
    };
    const contextManager = {
      prepare: async (input: Parameters<typeof managedPreparedTestContext>[0]) => {
        if (input.trigger === "provider_overflow") {
          preparationEntered.resolve(undefined);
          await releasePreparation.promise;
        }
        return managedPreparedTestContext(input);
      },
    };
    const { db, store, runner } = createRunner(
      streamText,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      contextManager,
    );
    const runId = "run_permission_race" as never;
    const runPromise = runner.streamText({
      runId,
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Add Permission during compaction",
    });
    await preparationEntered.promise;
    const run = store.getRun(runId)!;
    store.saveToolCall({
      id: "tool_permission_race" as never,
      conversationId: run.conversationId,
      runId,
      messageId: run.assistantMessageId!,
      toolName: "web.fetch",
      input: { url: "https://example.com" },
      state: "waiting_for_permission",
      permissionId: "perm_permission_race" as never,
      time: { created: 3_000 },
    });
    store.savePermission({
      id: "perm_permission_race" as never,
      conversationId: run.conversationId,
      runId,
      messageId: run.assistantMessageId!,
      toolCallId: "tool_permission_race" as never,
      status: "pending",
      toolId: "web.fetch",
      title: "Fetch protected resource",
      risk: { level: "low", reversible: true, sideEffects: ["external_network"] },
      confirmation: { level: "standard" },
      createdAt: 3_000,
    });
    releasePreparation.resolve(undefined);
    const result = await runPromise;
    await result.response.text();

    expect(requests).toBe(1);
    expect(store.getRun(runId)).toMatchObject({
      status: "failed",
      error: { name: "PermissionRaceContextError", data: { message: providerError.message } },
    });
    expect(store.listEventsByRun(runId).filter(
      (event) => event.type === "runtime.error",
    )).toHaveLength(1);
    expect(store.listTraces(runId).filter(
      (trace) => trace.type === "context.overflow.recovered",
    )).toHaveLength(0);
    expect(store.listContextUsagesByRun(runId)).toHaveLength(1);
    db.close();
  });

  test.each(["running", "completed", "unknown-outcome"] as const)(
    "fails closed when a %s ToolCall appears during overflow compaction",
    async (toolState) => {
      const providerError = Object.assign(new Error("maximum context length\nTOOL_RACE"), {
        name: "DurableFactContextError",
      });
      const preparationEntered = createDeferred<void>();
      const releasePreparation = createDeferred<void>();
      let requests = 0;
      const streamText: RuntimeStreamText = (input) => {
        requests += 1;
        if (requests === 1) {
          return {
            responseReady: Promise.resolve()
              .then(() => input.onError?.({ error: providerError }))
              .then(() => undefined),
            toUIMessageStreamResponse: () => new Response("data: tool-race\n\n"),
          };
        }
        return streamFromText("must not run")(input);
      };
      const contextManager = {
        prepare: async (input: Parameters<typeof managedPreparedTestContext>[0]) => {
          if (input.trigger === "provider_overflow") {
            preparationEntered.resolve(undefined);
            await releasePreparation.promise;
          }
          return managedPreparedTestContext(input);
        },
      };
      const { db, store, runner } = createRunner(
        streamText,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        contextManager,
      );
      const runId = `run_tool_race_${toolState}` as never;
      const runPromise = runner.streamText({
        runId,
        providerId: "openai",
        modelId: "gpt-4o",
        text: "Add ToolCall during compaction",
      });
      await preparationEntered.promise;
      const run = store.getRun(runId)!;
      const common = {
        id: `tool_race_${toolState}` as never,
        conversationId: run.conversationId,
        runId,
        messageId: run.assistantMessageId!,
        toolName: "web.fetch",
        input: { url: "https://example.com" },
      };
      store.saveToolCall(toolState === "running"
        ? { ...common, state: "running", time: { created: 3_000, started: 3_001 } }
        : toolState === "completed"
          ? {
              ...common,
              state: "completed",
              result: { ok: true, summary: "completed", data: {} },
              time: { created: 3_000, started: 3_001, completed: 3_002 },
            }
          : {
              ...common,
              state: "error",
              error: {
                code: "TOOL_FAILED",
                message: "outcome unknown",
                retryable: false,
                outcome: "unknown",
              },
              time: { created: 3_000, started: 3_001, completed: 3_002 },
            });
      releasePreparation.resolve(undefined);
      const result = await runPromise;
      await result.response.text();

      expect(requests).toBe(1);
      expect(store.getRun(runId)).toMatchObject({
        status: "failed",
        error: { name: "DurableFactContextError", data: { message: providerError.message } },
      });
      expect(store.listEventsByRun(runId).filter(
        (event) => event.type === "runtime.error",
      )).toHaveLength(1);
      expect(store.listTraces(runId).filter(
        (trace) => trace.type === "context.overflow.recovered",
      )).toHaveLength(0);
      expect(store.listContextUsagesByRun(runId)).toHaveLength(1);
      db.close();
    },
  );

  test("keeps an abort during overflow preparation as an interruption", async () => {
    const controller = new AbortController();
    const providerError = Object.assign(new Error("context length exceeded\nABORT_RACE"), {
      name: "AbortRaceContextError",
    });
    let requests = 0;
    const streamText: RuntimeStreamText = async (input) => {
      requests += 1;
      await input.onError?.({ error: providerError });
      return { toUIMessageStreamResponse: () => new Response("data: abort-race\n\n") };
    };
    const contextManager = {
      prepare: async (input: Parameters<typeof managedPreparedTestContext>[0]) => {
        if (input.trigger === "provider_overflow") {
          controller.abort("user stopped during overflow compaction");
          throw new Error("compaction aborted");
        }
        return managedPreparedTestContext(input);
      },
    };
    const { db, store, runner } = createRunner(
      streamText,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      contextManager,
    );

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Abort recovery",
    }, controller.signal);
    await result.response.text();

    expect(requests).toBe(1);
    expect(store.getRun(result.started.run.id)).toMatchObject({
      status: "interrupted",
      finish: "interrupted",
      metadata: {
        interrupt: {
          reason: "user_stop",
          message: "user stopped during overflow compaction",
        },
      },
    });
    expect(store.listEventsByRun(result.started.run.id).filter(
      (event) => event.type === "runtime.error",
    )).toHaveLength(0);
    db.close();
  });

  test("enforces and persists the recovery audit allowlist with exact secret redaction", async () => {
    const secret = "sk-overflow-secret";
    const providerError = {
      name: "ProviderContextError",
      message: `maximum context length; key=${secret}`,
      statusCode: 400,
      isRetryable: false,
      stack: `stack ${secret}`,
      headers: { authorization: `Bearer ${secret}` },
      requestBody: `request ${secret}`,
      responseBody: `response ${secret}`,
      providerMetadata: { raw: secret },
      summary: secret,
      safetyState: { details: secret },
      credentials: secret,
    };
    for (const forbidden of [
      "stack",
      "headers",
      "requestBody",
      "responseBody",
      "providerMetadata",
      "summary",
      "safetyState",
      "credentials",
    ]) {
      expect(() => traceEventSchema.parse({
        id: "trace_forbidden",
        conversationId: "conv_forbidden",
        runId: "run_forbidden",
        type: "context.overflow.recovered",
        level: "warn",
        time: 1,
        payload: {
          error: { name: providerError.name, data: { message: providerError.message } },
          requestIndex: 1,
          sourceHeadRunId: "run_forbidden",
          sourceConversationRevision: 1,
          checkpointId: "ckpt_forbidden",
          beforeEstimatedInputTokens: 100,
          afterEstimatedInputTokens: 10,
          [forbidden]: providerError[forbidden as keyof typeof providerError],
        },
      })).toThrow();
    }

    let requests = 0;
    const streamText: RuntimeStreamText = async (input) => {
      requests += 1;
      if (requests === 1) {
        await input.onError?.({ error: providerError });
      } else {
        await input.onChunk?.({ chunk: { type: "text-delta", text: "recovered" } });
        await input.onFinish?.({ finishReason: "stop", stepCount: 1 });
      }
      return { toUIMessageStreamResponse: () => new Response("data: audit\n\n") };
    };
    let storeRef: RuntimeSqliteStore;
    const contextManager = {
      prepare: async (input: Parameters<typeof managedPreparedTestContext>[0]) => {
        const marker = input.trigger === "provider_overflow"
          ? {
              checkpointId: "ckpt_overflow_audit",
              trigger: "provider_overflow" as const,
              auto: true,
              coverageThroughRunId: input.runId,
              beforeEstimatedInputTokens: 12_345,
              afterEstimatedInputTokens: 2_345,
              status: "created" as const,
              time: { created: 2_000 },
            }
          : undefined;
        const revision = storeRef.getConversation(input.conversationId as never)?.revision ?? 1;
        const prepared = managedPreparedTestContext(input, marker);
        return {
          ...prepared,
          plan: { ...prepared.plan, sourceConversationRevision: revision },
        };
      },
    };
    const created = createRunner(
      streamText,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      () => [secret],
      contextManager,
    );
    storeRef = created.store;

    const result = await created.runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Audit recovery",
    });
    await result.response.text();

    const traces = created.store.listTraces(result.started.run.id).filter(
      (trace) => trace.type === "context.overflow.recovered",
    );
    expect(traces).toHaveLength(1);
    expect(traces[0]?.payload).toEqual({
      error: {
        name: "ProviderContextError",
        data: {
          message: "maximum context length; key=[REDACTED]",
          statusCode: 400,
          isRetryable: false,
        },
      },
      requestIndex: 1,
      sourceHeadRunId: result.started.run.id,
      sourceConversationRevision: 1,
      checkpointId: "ckpt_overflow_audit",
      beforeEstimatedInputTokens: 12_345,
      afterEstimatedInputTokens: 2_345,
    });
    expect(JSON.stringify(traces[0])).not.toContain(secret);
    for (const forbidden of [
      "stack",
      "headers",
      "requestBody",
      "responseBody",
      "providerMetadata",
      "summary",
      "safetyState",
      "credentials",
    ]) {
      expect(JSON.stringify(traces[0])).not.toContain(forbidden);
    }
    created.db.close();
  });

  test("preserves Task 5 planning and usage across a recovered real ToolLoop", async () => {
    const firstError = Object.assign(new Error("maximum context length exceeded"), {
      name: "ReplacementContextError",
    });
    let modelCalls = 0;
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        modelCalls += 1;
        prompts.push(structuredClone(options.prompt));
        if (modelCalls === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [{ type: "error" as const, error: firstError }],
            }),
          };
        }
        const content = modelCalls === 2
          ? [{
              type: "tool-call" as const,
              toolCallId: "call_recovered_tool_loop",
              toolName: "np__web__fetch",
              input: JSON.stringify({ url: "https://example.com" }),
            }]
          : [
              { type: "text-start" as const, id: "replacement-final" },
              {
                type: "text-delta" as const,
                id: "replacement-final",
                delta: "replacement tool loop complete",
              },
              { type: "text-end" as const, id: "replacement-final" },
            ];
        return {
          stream: simulateReadableStream({
            chunks: [
              ...content,
              {
                type: "finish" as const,
                finishReason: {
                  unified: modelCalls === 2 ? "tool-calls" as const : "stop" as const,
                  raw: undefined,
                },
                logprobs: undefined,
                usage: sdkModelUsage(modelCalls === 2 ? 21 : 22),
              },
            ],
          }),
        };
      },
    });
    const preparations: Array<{
      requestIndex: number;
      trigger: string;
      providerId: string;
      modelId: string;
      retainedMessages: ModelMessage[];
    }> = [];
    const contextManager = {
      prepare: async (input: Parameters<typeof managedPreparedTestContext>[0] & {
        providerId: string;
        modelId: string;
        retainedMessages?: ModelMessage[];
      }) => {
        preparations.push({
          requestIndex: input.requestIndex,
          trigger: input.trigger,
          providerId: input.providerId,
          modelId: input.modelId,
          retainedMessages: structuredClone(input.retainedMessages ?? []),
        });
        const prepared = managedPreparedTestContext(input);
        return {
          ...prepared,
          instructions: [{
            role: "system" as const,
            content: `boundary ${input.trigger}`,
          }],
          messages: [
            { role: "user" as const, content: `managed ${input.trigger}` },
            ...(input.retainedMessages ?? []),
          ],
        };
      },
    };
    const { db, store, runner } = createRunnerWithModel(
      model,
      createWebRegistry(),
      contextManager,
    );

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Recover and run a tool",
      agentMode: "agent",
    });
    const startingLimits = structuredClone(result.started.run.limits);
    const body = await result.response.text();

    expect(modelCalls).toBe(3);
    expect(body).toContain("replacement tool loop complete");
    expect(preparations.map(({ requestIndex, trigger, providerId, modelId }) => ({
      requestIndex,
      trigger,
      providerId,
      modelId,
    }))).toEqual([
      { requestIndex: 0, trigger: "auto_pre_turn", providerId: "openai", modelId: "gpt-4o" },
      { requestIndex: 1, trigger: "provider_overflow", providerId: "openai", modelId: "gpt-4o" },
      { requestIndex: 2, trigger: "auto_mid_turn", providerId: "openai", modelId: "gpt-4o" },
    ]);
    const laterRetained = preparations[2]?.retainedMessages;
    expect(JSON.stringify(laterRetained)).toContain("call_recovered_tool_loop");
    expect(JSON.stringify(laterRetained)).toContain("Example page");
    expect(JSON.stringify(prompts[2])).toContain("call_recovered_tool_loop");
    expect(JSON.stringify(prompts[1])).toContain("boundary provider_overflow");
    expect(JSON.stringify(prompts[2])).toContain("boundary auto_mid_turn");
    expect(store.listContextUsagesByRun(result.started.run.id).map((usage) => ({
      requestIndex: usage.requestIndex,
      providerInputTokens: usage.providerObservation?.inputTokens,
    }))).toEqual([
      { requestIndex: 0, providerInputTokens: undefined },
      { requestIndex: 1, providerInputTokens: 21 },
      { requestIndex: 2, providerInputTokens: 22 },
    ]);
    expect(store.getRun(result.started.run.id)).toMatchObject({
      status: "completed",
      limits: startingLimits,
    });
    expect(store.listTraces(result.started.run.id).filter(
      (trace) => trace.type === "context.overflow.recovered",
    )).toHaveLength(1);
    db.close();
  });

  test("compacts completed ancestors while preserving the current raw turn and transcript", async () => {
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeSqliteStore(db);
    let idSequence = 0;
    let timeSequence = 0;
    const createId = (prefix: string) => `${prefix}_${++idSequence}` as never;
    const mainModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start" as const, id: "checkpoint-response" },
            {
              type: "text-delta" as const,
              id: "checkpoint-response",
              delta: "checkpoint context accepted",
            },
            { type: "text-end" as const, id: "checkpoint-response" },
            {
              type: "finish" as const,
              finishReason: { unified: "stop" as const, raw: undefined },
              logprobs: undefined,
              usage: sdkModelUsage(64),
            },
          ],
        }),
      }),
    });
    const resolveLanguageModel: RuntimeTextRunnerDependencies["resolveLanguageModel"] = () => ({
      languageModel: mainModel,
      runtimeContext: {
        provider: {
          providerId: "openai",
          modelId: "gpt-4o",
          contextLength: 25_000,
          outputLength: 4_096,
        },
      },
    });
    const seedRunner = new RuntimeTextRunner({
      store,
      createId,
      now: () => 1_000 + timeSequence++,
      resolveLanguageModel,
      streamText: streamFromText("seed answer"),
    });
    let conversationId: string | undefined;
    for (let index = 0; index < 6; index += 1) {
      const seeded = await seedRunner.streamText({
        conversationId: conversationId as never,
        providerId: "openai",
        modelId: "gpt-4o",
        text: `OLD_USER_${index}_${"x".repeat(6_000)}`,
      });
      await seeded.response.text();
      conversationId = seeded.started.conversation.id;
    }
    const transcriptBefore = structuredClone(
      store.listTranscriptMessages(conversationId as never),
    );
    let summaryCalls = 0;
    const compactionService = new ContextCompactionService({
      store,
      createId,
      now: () => 1_000 + timeSequence++,
      generator: async () => {
        summaryCalls += 1;
        return { text: "CHECKPOINT_SUMMARY" };
      },
    });
    const contextManager = new ModelContextManager({
      store,
      compactionService,
      createId,
      now: () => 1_000 + timeSequence++,
    });
    const runner = new RuntimeTextRunner({
      store,
      createId,
      now: () => 1_000 + timeSequence++,
      resolveLanguageModel,
      contextManager,
    });
    const current = await runner.streamText({
      conversationId: conversationId as never,
      providerId: "openai",
      modelId: "gpt-4o",
      text: "CURRENT_RAW_USER",
    });
    const body = await current.response.text();

    const providerPrompt = mainModel.doStreamCalls.at(-1)?.prompt ?? [];
    const providerInstructions = providerPrompt.filter(
      (message) => message.role === "system",
    );
    const providerMessages = providerPrompt.filter(
      (message) => message.role !== "system",
    );
    expect(summaryCalls).toBe(1);
    expect(mainModel.doStreamCalls).toHaveLength(1);
    expect(body).toContain("checkpoint context accepted");
    expect(JSON.stringify(providerInstructions)).toContain("CHECKPOINT_SUMMARY");
    expect(JSON.stringify(providerInstructions)).toContain("Runtime Safety State");
    expect(JSON.stringify(providerMessages)).toContain("CURRENT_RAW_USER");
    expect(JSON.stringify(providerMessages)).not.toContain("OLD_USER_0");
    const checkpoint = store.listContextCheckpoints(conversationId as never)[0]!;
    expect(checkpoint.coverageThroughRunId).not.toBe(current.started.run.id);
    expect(
      store.listTranscriptMessages(conversationId as never).slice(0, transcriptBefore.length),
    ).toEqual(transcriptBefore);
    db.close();
  });

  test("runs the context manager after durable Run start before the main model request", async () => {
    let prepareCalls = 0;
    let observedRunStatus: string | undefined;
    let mainInstructions: unknown;
    let mainMessages: unknown;
    let storeRef: RuntimeSqliteStore | undefined;
    const contextManager = {
      prepare: async (input: { runId: string; requestIndex: number }) => {
        prepareCalls += 1;
        observedRunStatus = storeRef?.getRun(input.runId as never)?.status;
        return {
          plan: {
            id: "ctxplan_test",
            requestIndex: input.requestIndex,
            budget: {
              estimatedInputTokens: 12,
              reservedOutputTokens: 4,
              rawHistoryTokens: 4,
              checkpointTokens: 4,
              safetyStateTokens: 0,
              systemPromptTokens: 0,
              toolSchemaTokens: 0,
            },
            view: "raw",
          },
          instructions: [{ role: "system", content: "checkpoint summary" }],
          messages: [{ role: "user", content: "new turn" }],
        };
      },
    };
    const streamText: RuntimeStreamText = async (input) => {
      mainInstructions = input.instructions;
      mainMessages = input.messages;
      await input.onFinish?.({ finishReason: "stop", stepCount: 1 });
      return {
        toUIMessageStreamResponse: () => new Response("data: {}\\n\\n"),
      };
    };
    const created = createRunner(
      streamText,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      contextManager,
    );
    storeRef = created.store;
    await (await created.runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "new turn",
    })).response.text();

    expect(prepareCalls).toBe(1);
    expect(observedRunStatus).toBe("running");
    expect(JSON.stringify(mainInstructions)).toContain("checkpoint summary");
    expect(mainMessages).toEqual([{ role: "user", content: "new turn" }]);
  });

  test("records an already-aborted normal preparation as a client interruption", async () => {
    let modelStarted = false;
    const controller = new AbortController();
    controller.abort("client disconnected before context preparation");
    const contextManager = {
      prepare: async (input: { abortSignal?: AbortSignal }) => {
        input.abortSignal?.throwIfAborted();
        return preparedTestContext(0);
      },
    };
    const { db, store, runner } = createRunner(
      async () => {
        modelStarted = true;
        throw new Error("model must not start");
      },
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      contextManager,
    );

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "abort before model",
    }, controller.signal);
    await result.response.text();

    expect(modelStarted).toBe(false);
    expect(store.getRun(result.started.run.id)).toMatchObject({
      status: "interrupted",
      finish: "interrupted",
      metadata: {
        interrupt: {
          reason: "client_disconnect",
          message: "client disconnected before context preparation",
        },
      },
    });
    const storedAssistant = store.getMessage(result.started.assistantMessage.id);
    expect(storedAssistant?.role).toBe("assistant");
    if (storedAssistant?.role !== "assistant") {
      throw new Error("expected stored Assistant Message");
    }
    expect(storedAssistant.status).toMatchObject({
      type: "incomplete",
      reason: "interrupted",
    });
    db.close();
  });

  test("waits for permission and continues the same Run with one approved execution", async () => {
    let executions = 0;
    let segment = 0;
    const preparationTriggers: string[] = [];
    const retainedModelInputs: ModelMessage[][] = [];
    const contextManager = {
      prepare: async (input: {
        trigger: string;
        requestIndex: number;
        retainedMessages?: ModelMessage[];
      }) => {
        preparationTriggers.push(input.trigger);
        if (input.trigger === "auto_mid_turn") {
          retainedModelInputs.push(structuredClone(input.retainedMessages ?? []));
        }
        return {
          plan: {
            id: `ctxplan_${preparationTriggers.length}`,
            requestIndex: input.requestIndex,
            budget: {
              estimatedInputTokens: 10,
              reservedOutputTokens: 4,
              rawHistoryTokens: 4,
              checkpointTokens: 0,
              safetyStateTokens: 0,
              systemPromptTokens: 1,
              toolSchemaTokens: 1,
            },
            view: "raw",
          },
          instructions: [{ role: "system", content: "managed context" }],
          messages: [...(input.retainedMessages ?? [])],
        };
      },
    };
    let continuationRequest: {
      instructions: unknown;
      messages: ModelMessage[];
      maxSteps: number | undefined;
      maxOutputTokens: number | undefined;
      timeout: number | undefined;
    } | undefined;
    let autoApproveMaxRisk: "low" | "medium" = "low";
    const namespace: RuntimeToolNamespace = {
      id: "web",
      title: "Web",
      description: "Approval test tools",
      tools: [{
        id: "web.fetch",
        title: "Approval Fetch",
        description: "Approval-gated test operation.",
        inputSchema: z.object({ url: z.string() }).strict(),
        outputSchema: z.object({ value: z.string() }).strict(),
        executionTarget: "runtime",
        risk: {
          mode: "static",
          level: "critical",
          reversible: true,
          sideEffect: "external_network",
        },
        execute: async () => {
          executions++;
          return { summary: "executed", data: { value: "ok" } };
        },
      }],
      resolveForRun: () => ({ candidateToolIds: ["web.fetch"] }),
    };
    const registry = new RuntimeToolRegistry([namespace]);
    const streamText: RuntimeStreamText = async (input) => {
      segment++;
      const toolCall = {
        type: "tool-call" as const,
        toolCallId: "call_approval",
        toolName: "np__web__fetch",
        input: { url: "https://example.com" },
      };
      if (segment === 1) {
        await input.onChunk?.({ chunk: toolCall });
        const approve = input.toolApproval as unknown as (input: {
          toolCall: typeof toolCall;
          tools: unknown;
          toolsContext: Record<string, never>;
          runtimeContext: undefined;
          messages: [];
        }) => Promise<unknown>;
        expect(await approve({
          toolCall,
          tools: input.tools,
          toolsContext: {},
          runtimeContext: undefined,
          messages: [],
        })).toBe("user-approval");
        await input.onChunk?.({
          chunk: {
            type: "tool-approval-request",
            approvalId: "approval_1",
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            input: toolCall.input,
          },
        });
        await input.onFinish?.({
          finishReason: "tool-calls",
          stepCount: 1,
          responseMessages: [{
            role: "assistant",
            content: [
              toolCall,
              {
                type: "tool-approval-request",
                approvalId: "approval_1",
                toolCallId: toolCall.toolCallId,
              },
            ],
          }],
          totalUsage: {
            inputTokens: 2,
            inputTokenDetails: {
              noCacheTokens: 2,
              cacheReadTokens: undefined,
              cacheWriteTokens: undefined,
            },
            outputTokens: 1,
            outputTokenDetails: {
              textTokens: 1,
              reasoningTokens: undefined,
            },
            totalTokens: 3,
          },
        });
      } else {
        continuationRequest = {
          instructions: structuredClone(input.instructions),
          messages: structuredClone(input.messages ?? []),
          maxSteps: input.maxSteps,
          maxOutputTokens: input.maxOutputTokens,
          timeout: input.timeout,
        };
        expect(JSON.stringify(input.instructions)).toContain("managed context");
        expect(JSON.stringify(input.messages)).toContain("call_approval");
        expect(JSON.stringify(input.messages)).toContain("approval_1");
        const execute = input.tools?.np__web__fetch?.execute as unknown as (
          toolInput: { url: string },
          options: {
            toolCallId: string;
            messages: [];
            abortSignal: AbortSignal;
          },
        ) => Promise<unknown>;
        const output = await execute(toolCall.input, {
          toolCallId: toolCall.toolCallId,
          messages: [],
          abortSignal: new AbortController().signal,
        });
        await input.onChunk?.({
          chunk: {
            type: "tool-result",
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            input: toolCall.input,
            output,
          },
        });
        await input.onChunk?.({ chunk: { type: "text-delta", text: "完成" } });
        await input.onFinish?.({
          finishReason: "stop",
          stepCount: 1,
          responseMessages: [{ role: "assistant", content: "完成" }],
          totalUsage: {
            inputTokens: 3,
            inputTokenDetails: {
              noCacheTokens: 3,
              cacheReadTokens: undefined,
              cacheWriteTokens: undefined,
            },
            outputTokens: 2,
            outputTokenDetails: {
              textTokens: 2,
              reasoningTokens: undefined,
            },
            totalTokens: 5,
          },
        });
      }
      return {
        toUIMessageStreamResponse: () =>
          new Response("data: {}\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
      };
    };
    const { db, store, runner } = createRunner(
      streamText,
      registry,
      undefined,
      true,
      () => ({ autoApproveMaxRisk }),
      undefined,
      undefined,
      contextManager,
    );

    const initial = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Run approval tool",
      agentMode: "agent",
    });
    await initial.response.text();
    const waitingRun = store.getRun(initial.started.run.id)!;
    const permission = store.listPendingPermissionsByRun(waitingRun.id)[0]!;
    const continuationBefore = structuredClone(
      waitingRun.metadata?.continuation as {
        responseMessages: ModelMessage[];
        stepCount: number;
      },
    );
    const limitsBefore = structuredClone(waitingRun.limits);
    const usageBefore = structuredClone(waitingRun.usage!);

    expect(waitingRun.status).toBe("waiting_for_permission");
    expect(waitingRun.input.tools?.approvalPolicy).toEqual({
      autoApproveMaxRisk: "low",
    });
    expect(permission.adapter).toEqual({
      aiSdkApprovalId: "approval_1",
      aiSdkToolCallId: "call_approval",
    });
    expect(executions).toBe(0);

    expect(permission.confirmation).toEqual({
      level: "strong",
      prompt: "确认执行 Approval Fetch（web.fetch）",
    });
    autoApproveMaxRisk = "medium";
    await expect(
      runner.continueText(waitingRun.id, [{
        permissionId: permission.id,
        approved: true,
      }]),
    ).rejects.toThrow("exact strong confirmation");
    expect(store.getRun(waitingRun.id)?.status).toBe("waiting_for_permission");

    const continued = await runner.continueText(waitingRun.id, [{
      permissionId: permission.id,
      approved: true,
      confirmationText: permission.confirmation.prompt,
    }]);
    await continued.response.text();

    expect(continued.started.run.id).toBe(initial.started.run.id);
    expect(continued.started.assistantMessage.id).toBe(
      initial.started.assistantMessage.id,
    );
    const expectedContinuationPrefix: ModelMessage[] = [
      ...continuationBefore.responseMessages,
      {
        role: "tool",
        content: [{
          type: "tool-approval-response",
          approvalId: "approval_1",
          approved: true,
        }],
      },
    ];
    expect(retainedModelInputs).toEqual([expectedContinuationPrefix]);
    expect(JSON.stringify(continuationRequest?.instructions)).toContain(
      "managed context",
    );
    expect(continuationRequest?.messages).toEqual(expectedContinuationPrefix);
    expect(continuationRequest?.maxSteps).toBe(
      limitsBefore.maxSteps - continuationBefore.stepCount,
    );
    expect(continuationRequest?.maxOutputTokens).toBe(
      limitsBefore.maxOutputTokens === undefined
        ? undefined
        : limitsBefore.maxOutputTokens - usageBefore.output,
    );
    if (limitsBefore.timeoutMs === undefined) {
      expect(continuationRequest?.timeout).toBeUndefined();
    } else {
      expect(continuationRequest?.timeout).toBeGreaterThan(0);
      expect(continuationRequest?.timeout).toBeLessThanOrEqual(limitsBefore.timeoutMs);
    }
    expect(store.getRun(waitingRun.id)).toMatchObject({
      status: "completed",
      usage: { input: 5, output: 3, total: 8 },
      input: {
        tools: {
          approvalPolicy: { autoApproveMaxRisk: "low" },
        },
      },
    });
    expect(store.getRun(waitingRun.id)?.limits).toEqual(limitsBefore);
    expect(store.getToolCall(permission.toolCallId)).toMatchObject({
      state: "completed",
      permissionId: permission.id,
    });
    expect(executions).toBe(1);
    expect(store.getPermission(permission.id)?.decision).toMatchObject({
      confirmationVerified: true,
    });
    expect(preparationTriggers).toEqual(["auto_pre_turn", "auto_mid_turn"]);

    db.close();
  });

  test("records an aborted Permission continuation preparation on the same Run", async () => {
    let modelSegments = 0;
    const toolCall = {
      type: "tool-call" as const,
      toolCallId: "call_abort_continuation",
      toolName: "np__web__fetch",
      input: { url: "https://example.com" },
    };
    const registry = new RuntimeToolRegistry([{
      id: "web",
      title: "Web",
      description: "Continuation abort test tools",
      tools: [{
        id: "web.fetch",
        title: "Approval Fetch",
        description: "Approval-gated operation.",
        inputSchema: z.object({ url: z.string() }).strict(),
        outputSchema: z.object({ value: z.string() }).strict(),
        executionTarget: "runtime",
        risk: {
          mode: "static",
          level: "medium",
          reversible: true,
          sideEffect: "external_network",
        },
        execute: async () => ({ summary: "executed", data: { value: "ok" } }),
      }],
      resolveForRun: () => ({ candidateToolIds: ["web.fetch"] }),
    }]);
    const contextManager = {
      prepare: async (input: {
        requestIndex: number;
        abortSignal?: AbortSignal;
      }) => {
        input.abortSignal?.throwIfAborted();
        return preparedTestContext(input.requestIndex);
      },
    };
    const streamText: RuntimeStreamText = async (input) => {
      modelSegments += 1;
      if (modelSegments !== 1) {
        throw new Error("continuation model must not start");
      }
      await input.onChunk?.({ chunk: toolCall });
      const approve = input.toolApproval as unknown as (approvalInput: {
        toolCall: typeof toolCall;
        tools: unknown;
        toolsContext: Record<string, never>;
        runtimeContext: undefined;
        messages: [];
      }) => Promise<unknown>;
      expect(await approve({
        toolCall,
        tools: input.tools,
        toolsContext: {},
        runtimeContext: undefined,
        messages: [],
      })).toBe("user-approval");
      await input.onChunk?.({
        chunk: {
          type: "tool-approval-request",
          approvalId: "approval_abort_continuation",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.input,
        },
      });
      await input.onFinish?.({
        finishReason: "tool-calls",
        stepCount: 1,
        responseMessages: [{
          role: "assistant",
          content: [
            toolCall,
            {
              type: "tool-approval-request",
              approvalId: "approval_abort_continuation",
              toolCallId: toolCall.toolCallId,
            },
          ],
        }],
      });
      return {
        toUIMessageStreamResponse: () => new Response("data: {}\n\n"),
      };
    };
    const { db, store, runner } = createRunner(
      streamText,
      registry,
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      contextManager,
    );
    const initial = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "wait for approval",
      agentMode: "agent",
    });
    await initial.response.text();
    const permission = store.listPendingPermissionsByRun(initial.started.run.id)[0]!;
    const controller = new AbortController();
    controller.abort("client disconnected during permission continuation preparation");

    const continued = await runner.continueText(initial.started.run.id, [{
      permissionId: permission.id,
      approved: true,
    }], controller.signal);
    await continued.response.text();

    expect(modelSegments).toBe(1);
    expect(continued.started.run.id).toBe(initial.started.run.id);
    expect(continued.started.assistantMessage.id).toBe(initial.started.assistantMessage.id);
    expect(store.getRun(initial.started.run.id)).toMatchObject({
      status: "interrupted",
      finish: "interrupted",
      metadata: {
        interrupt: {
          reason: "client_disconnect",
          message: "client disconnected during permission continuation preparation",
        },
      },
    });
    expect(store.getPermission(permission.id)?.status).toBe("approved");
    expect(store.getToolCall(permission.toolCallId)?.state).toBe("interrupted");
    db.close();
  });

  test("keeps preflight failures pending and terminalizes post-commit bootstrap failures", async () => {
    const namespace: RuntimeToolNamespace = {
      id: "web",
      title: "Web",
      description: "Continuation preflight test tools",
      tools: [{
        id: "web.fetch",
        title: "Approval Fetch",
        description: "Approval-gated test operation.",
        inputSchema: z.object({ url: z.string() }).strict(),
        outputSchema: z.object({ value: z.string() }).strict(),
        executionTarget: "runtime",
        risk: {
          mode: "static",
          level: "medium",
          reversible: true,
          sideEffect: "external_network",
        },
        execute: async () => ({ summary: "executed", data: { value: "ok" } }),
      }],
      resolveForRun: () => ({ candidateToolIds: ["web.fetch"] }),
    };
    const registry = new RuntimeToolRegistry([namespace]);
    const toolCall = {
      type: "tool-call" as const,
      toolCallId: "call_preflight",
      toolName: "np__web__fetch",
      input: { url: "https://example.com" },
    };
    const streamText: RuntimeStreamText = async (input) => {
      await input.onChunk?.({ chunk: toolCall });
      const approve = input.toolApproval as unknown as (input: {
        toolCall: typeof toolCall;
        tools: unknown;
        toolsContext: Record<string, never>;
        runtimeContext: undefined;
        messages: [];
      }) => Promise<unknown>;
      expect(await approve({
        toolCall,
        tools: input.tools,
        toolsContext: {},
        runtimeContext: undefined,
        messages: [],
      })).toBe("user-approval");
      await input.onChunk?.({
        chunk: {
          type: "tool-approval-request",
          approvalId: "approval_preflight",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.input,
        },
      });
      await input.onFinish?.({
        finishReason: "tool-calls",
        stepCount: 1,
        responseMessages: [{
          role: "assistant",
          content: [
            toolCall,
            {
              type: "tool-approval-request",
              approvalId: "approval_preflight",
              toolCallId: toolCall.toolCallId,
            },
          ],
        }],
        totalUsage: {
          inputTokens: 2,
          inputTokenDetails: {
            noCacheTokens: 2,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
          outputTokens: 1,
          outputTokenDetails: {
            textTokens: 1,
            reasoningTokens: undefined,
          },
          totalTokens: 3,
        },
      });
      return {
        toUIMessageStreamResponse: () =>
          new Response("data: {}\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
      };
    };
    let modelResolutionCount = 0;
    let modelAvailable = true;
    const resolveLanguageModel: RuntimeTextRunnerDependencies["resolveLanguageModel"] = () => {
      modelResolutionCount++;
      if (!modelAvailable) {
        throw new Error("Provider is disabled");
      }
      return {
        languageModel: new MockLanguageModelV3(),
        runtimeContext: {
          provider: {
            providerId: "openai",
            modelId: "gpt-4o",
            supportsTools: true,
          },
        },
      };
    };
    const { db, store, runner } = createRunner(
      streamText,
      registry,
      undefined,
      true,
      undefined,
      resolveLanguageModel,
    );

    const initial = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Run approval tool",
      agentMode: "agent",
    });
    await initial.response.text();
    const waitingRun = store.getRun(initial.started.run.id)!;
    const permission = store.listPendingPermissionsByRun(waitingRun.id)[0]!;

    modelAvailable = false;
    await expect(runner.continueText(waitingRun.id, [{
      permissionId: permission.id,
      approved: true,
    }])).rejects.toThrow("Provider is disabled");

    expect(store.getRun(waitingRun.id)?.status).toBe("waiting_for_permission");
    expect(store.getConversation(waitingRun.conversationId)?.status).toMatchObject({
      type: "waiting_for_permission",
      runId: waitingRun.id,
    });
    expect(store.getPermission(permission.id)?.status).toBe("pending");
    expect(store.getToolCall(permission.toolCallId)?.state).toBe(
      "waiting_for_permission",
    );

    await expect(runner.continueText(waitingRun.id, [{
      permissionId: permission.id,
      approved: true,
    }])).rejects.toThrow("Provider is disabled");
    expect(modelResolutionCount).toBe(3);

    modelAvailable = true;
    const getToolCall = store.getToolCall.bind(store);
    store.getToolCall = ((toolCallId) => {
      if (store.getRun(waitingRun.id)?.status === "running") {
        throw new Error("Continuation bootstrap failed");
      }
      return getToolCall(toolCallId);
    }) as typeof store.getToolCall;

    const failedContinuation = await runner.continueText(waitingRun.id, [{
      permissionId: permission.id,
      approved: true,
    }]);
    expect(await failedContinuation.response.text()).toContain(
      "Continuation bootstrap failed",
    );

    expect(store.getRun(waitingRun.id)?.status).toBe("failed");
    expect(store.getConversation(waitingRun.conversationId)?.status.type).toBe("error");
    expect(store.getPermission(permission.id)?.status).toBe("approved");
    expect(getToolCall(permission.toolCallId)?.state).toBe("error");
    const failedMessage = store.getMessage(
      failedContinuation.started.assistantMessage.id,
    );
    const failedToolPart = failedMessage?.parts.find(
      (part) => part.type === "tool",
    );
    expect(failedToolPart).toMatchObject({
      type: "tool",
      state: {
        status: "error",
        error: {
          code: "INTERNAL_ERROR",
          message: "Continuation bootstrap failed",
        },
      },
    });
    expect(
      projectMessageToAiSdkUIMessage(failedMessage!).parts.find(
        (part) => part.type.startsWith("tool-"),
      ),
    ).toMatchObject({
      state: "output-error",
      errorText: "Continuation bootstrap failed",
    });
    expect(modelResolutionCount).toBe(4);

    db.close();
  });

  test("freezes the current approval threshold into each newly created Run", async () => {
    let autoApproveMaxRisk: "low" | "medium" = "low";
    const { db, store, runner } = createRunnerWithDefaultTools(
      streamFromText("Done"),
      () => ({ autoApproveMaxRisk }),
    );

    const first = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "First run",
      agentMode: "agent",
    });
    await first.response.text();

    autoApproveMaxRisk = "medium";
    const second = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Second run",
      agentMode: "agent",
    });
    await second.response.text();

    expect(store.getRun(first.started.run.id)?.input.tools?.approvalPolicy).toEqual({
      autoApproveMaxRisk: "low",
    });
    expect(store.getRun(second.started.run.id)?.input.tools?.approvalPolicy).toEqual({
      autoApproveMaxRisk: "medium",
    });

    db.close();
  });

  test("round-trips AI SDK tool approval through a second agent segment", async () => {
    let modelCalls = 0;
    let executions = 0;
    const registry = new RuntimeToolRegistry([{
      id: "web",
      title: "Web",
      description: "Approval test tools",
      tools: [{
        id: "web.fetch",
        title: "Approval Fetch",
        description: "Approval-gated test operation.",
        inputSchema: z.object({ url: z.string() }).strict(),
        outputSchema: z.object({ value: z.string() }).strict(),
        executionTarget: "runtime",
        risk: {
          mode: "static",
          level: "medium",
          reversible: true,
          sideEffect: "external_network",
        },
        execute: async () => {
          executions++;
          return { summary: "executed", data: { value: "ok" } };
        },
      }],
      resolveForRun: () => ({ candidateToolIds: ["web.fetch"] }),
    }]);
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls++;
        const content = modelCalls === 1
          ? [{
              type: "tool-call" as const,
              toolCallId: "call_real_approval",
              toolName: "np__web__fetch",
              input: "{\"url\":\"https://example.com\"}",
              providerMetadata: {
                test: { itemId: "provider_tool_call_1" },
              },
            }]
          : [
              { type: "text-start" as const, id: "text-real-approval" },
              {
                type: "text-delta" as const,
                id: "text-real-approval",
                delta: "Approved and complete",
              },
              { type: "text-end" as const, id: "text-real-approval" },
            ];
        return {
          stream: simulateReadableStream({
            chunks: [
              ...content,
              {
                type: "finish" as const,
                finishReason: {
                  unified: modelCalls === 1
                    ? "tool-calls" as const
                    : "stop" as const,
                  raw: undefined,
                },
                logprobs: undefined,
                usage: {
                  inputTokens: {
                    total: 4,
                    noCache: 4,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: {
                    total: 2,
                    text: modelCalls === 1 ? 0 : 2,
                    reasoning: 0,
                  },
                },
              },
            ],
          }),
        };
      },
    });
    const { db, store, runner } = createRunnerWithModel(model, registry);

    const initial = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Run the approval tool",
      agentMode: "agent",
    });
    await initial.response.text();
    const permission = store.listPendingPermissionsByRun(initial.started.run.id)[0]!;

    expect(store.getRun(initial.started.run.id)?.status).toBe(
      "waiting_for_permission",
    );
    expect(
      store
        .getMessage(initial.started.assistantMessage.id)
        ?.parts.find((part) => part.type === "tool"),
    ).toMatchObject({
      metadata: {
        aiSdkToolCallId: "call_real_approval",
        aiSdkApprovalId: expect.any(String),
        providerMetadata: {
          test: { itemId: "provider_tool_call_1" },
        },
      },
    });
    expect(executions).toBe(0);

    const continued = await runner.continueText(initial.started.run.id, [{
      permissionId: permission.id,
      approved: true,
    }]);
    await continued.response.text();

    expect(modelCalls).toBe(2);
    expect(executions).toBe(1);
    expect(store.getRun(initial.started.run.id)?.status).toBe("completed");
    expect(store.getMessage(initial.started.assistantMessage.id)?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool",
          state: expect.objectContaining({ status: "completed" }),
          metadata: expect.objectContaining({
            providerMetadata: {
              test: { itemId: "provider_tool_call_1" },
            },
          }),
        }),
        expect.objectContaining({
          type: "text",
          text: "Approved and complete",
        }),
      ]),
    );

    modelCalls = 0;
    const deniedInitial = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Deny the approval tool",
      agentMode: "agent",
    });
    await deniedInitial.response.text();
    const deniedPermission = store
      .listPendingPermissionsByRun(deniedInitial.started.run.id)[0]!;
    const denied = await runner.continueText(deniedInitial.started.run.id, [{
      permissionId: deniedPermission.id,
      approved: false,
      reason: "Denied in test",
    }]);
    await denied.response.text();

    expect(modelCalls).toBe(2);
    expect(executions).toBe(1);
    expect(store.getRun(deniedInitial.started.run.id)?.status).toBe("completed");
    expect(store.getToolCall(deniedPermission.toolCallId)).toMatchObject({
      state: "error",
      error: { code: "TOOL_PERMISSION_DENIED" },
    });
    expect(
      store
        .getMessage(deniedInitial.started.assistantMessage.id)
        ?.parts.find((part) => part.type === "tool"),
    ).toMatchObject({
      type: "tool",
      state: {
        status: "error",
        error: {
          code: "PERMISSION_DENIED",
          message: "Denied in test",
        },
      },
    });

    db.close();
  });

  test("persists tool-input-end provider metadata as the final tool value", async () => {
    let modelCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        const content = modelCalls === 1
          ? [
              {
                type: "tool-input-start" as const,
                id: "call_streamed_metadata",
                toolName: "np__web__fetch",
                providerMetadata: { test: { stage: "tool-input-start" } },
              },
              {
                type: "tool-input-delta" as const,
                id: "call_streamed_metadata",
                delta: "{\"url\":\"https://example.com\"}",
                providerMetadata: { test: { stage: "tool-input-delta" } },
              },
              {
                type: "tool-input-end" as const,
                id: "call_streamed_metadata",
                providerMetadata: { test: { stage: "tool-input-end" } },
              },
              {
                type: "tool-call" as const,
                toolCallId: "call_streamed_metadata",
                toolName: "np__web__fetch",
                input: "{\"url\":\"https://example.com\"}",
              },
            ]
          : [
              { type: "text-start" as const, id: "text-after-tool" },
              {
                type: "text-delta" as const,
                id: "text-after-tool",
                delta: "Tool metadata preserved",
              },
              { type: "text-end" as const, id: "text-after-tool" },
            ];
        return {
          stream: simulateReadableStream({
            chunks: [
              ...content,
              {
                type: "finish" as const,
                finishReason: {
                  unified: modelCalls === 1
                    ? "tool-calls" as const
                    : "stop" as const,
                  raw: undefined,
                },
                logprobs: undefined,
                usage: {
                  inputTokens: {
                    total: 4,
                    noCache: 4,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: {
                    total: 2,
                    text: modelCalls === 1 ? 0 : 2,
                    reasoning: 0,
                  },
                },
              },
            ],
          }),
        };
      },
    });
    const { db, store, runner } = createRunnerWithModel(
      model,
      createWebRegistry(),
    );

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Fetch the page",
      agentMode: "agent",
    });
    await result.response.text();

    expect(modelCalls).toBe(2);
    expect(
      store
        .getMessage(result.started.assistantMessage.id)
        ?.parts.find((part) => part.type === "tool"),
    ).toMatchObject({
      type: "tool",
      metadata: {
        aiSdkToolCallId: "call_streamed_metadata",
        providerMetadata: { test: { stage: "tool-input-end" } },
      },
      state: { status: "completed" },
    });

    db.close();
  });

  test("requests a title only for the first user message", async () => {
    const titleRequests: Array<{ userText: string }> = [];
    const generateConversationTitle: GenerateConversationTitle = async (input) => {
      titleRequests.push({ userText: input.userText });
      return { status: "skipped" };
    };
    const { db, runner } = createRunner(
      streamFromText("First response"),
      undefined,
      generateConversationTitle,
    );

    const first = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Design automatic titles",
    });
    await first.response.text();
    const second = await runner.streamText({
      conversationId: first.started.conversation.id,
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Continue",
    });
    await second.response.text();

    expect(titleRequests).toEqual([
      { userText: "Design automatic titles" },
    ]);

    db.close();
  });

  test("requests a fresh title when the first user message is replaced", async () => {
    const titleRequests: Array<{ userText: string }> = [];
    const generateConversationTitle: GenerateConversationTitle = async (input) => {
      titleRequests.push({ userText: input.userText });
      return { status: "skipped" };
    };
    const { db, runner } = createRunner(
      streamFromText("Response"),
      undefined,
      generateConversationTitle,
    );

    const first = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Original first question",
    });
    await first.response.text();
    const replacement = await runner.streamText({
      conversationId: first.started.conversation.id,
      replaceFromMessageId: first.started.userMessage.id,
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Rewritten first question",
    });
    await replacement.response.text();

    expect(titleRequests).toEqual([
      { userText: "Original first question" },
      { userText: "Rewritten first question" },
    ]);

    db.close();
  });

  test("streams a response and persists final assistant text", async () => {
    const { db, store, runner } = createRunner(streamFromText("Hello runtime"));

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Say hello",
    });

    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("x-nexus-conversation-id")).toBe(
      result.started.conversation.id,
    );
    expect(result.response.headers.get("x-nexus-run-id")).toBe(result.started.run.id);

    await result.response.text();

    const run = store.getRun(result.started.run.id);
    const message = store.getMessage(result.started.assistantMessage.id);

    expect(run?.status).toBe("completed");
    expect(run?.usage).toEqual({
      input: 3,
      output: 2,
      reasoning: 0,
      total: 5,
    });
    expect(message?.parts).toHaveLength(1);
    expect(message?.parts[0]).toMatchObject({
      type: "text",
      text: "Hello runtime",
    });

    db.close();
  });

  test("persists final reasoning content with the assistant message", async () => {
    const streamText: RuntimeStreamText = (input) => {
      void input.onChunk?.({
        chunk: { type: "reasoning-delta", text: "先分析问题。" } as never,
      });
      void input.onChunk?.({
        chunk: { type: "reasoning-delta", text: "再给出结论。" } as never,
      });
      void input.onChunk?.({ chunk: { type: "text-delta", text: "最终回答" } });
      void input.onFinish?.({ finishReason: "stop" });

      return {
        toUIMessageStreamResponse: () =>
          new Response("data: {}\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
      };
    };
    const { db, store, runner } = createRunner(streamText);

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "请推理后回答",
    });
    await result.response.text();

    const message = store.getMessage(result.started.assistantMessage.id);
    expect(message?.parts.map((part) => part.type)).toEqual(["reasoning", "text"]);
    expect(message?.parts[0]).toMatchObject({
      type: "reasoning",
      text: "先分析问题。再给出结论。",
    });
    expect(message?.parts[1]).toMatchObject({
      type: "text",
      text: "最终回答",
    });

    db.close();
  });

  test("preserves multiple reasoning blocks with their text order on finish", async () => {
    const streamText: RuntimeStreamText = (input) => {
      void input.onChunk?.({
        chunk: {
          type: "reasoning-delta",
          id: "reasoning-1",
          text: "第一段推理。",
        },
      });
      void input.onChunk?.({ chunk: { type: "text-delta", id: "text-1", text: "阶段性回答。" } });
      void input.onChunk?.({
        chunk: {
          type: "reasoning-delta",
          id: "reasoning-2",
          text: "第二段推理。",
        },
      });
      void input.onChunk?.({ chunk: { type: "text-delta", id: "text-2", text: "最终回答。" } });
      void input.onFinish?.({ finishReason: "stop" });

      return {
        toUIMessageStreamResponse: () =>
          new Response("data: {}\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
      };
    };
    const { db, store, runner } = createRunner(streamText);

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "请分两次推理后回答",
    });
    await result.response.text();

    const message = store.getMessage(result.started.assistantMessage.id);
    expect(message?.parts.map((part) => part.type)).toEqual([
      "reasoning",
      "text",
      "reasoning",
      "text",
    ]);
    expect(message?.parts[0]).toMatchObject({
      type: "reasoning",
      text: "第一段推理。",
      metadata: { aiSdkReasoningId: "reasoning-1" },
    });
    expect(message?.parts[1]).toMatchObject({
      type: "text",
      text: "阶段性回答。",
      metadata: { aiSdkTextId: "text-1" },
    });
    expect(message?.parts[2]).toMatchObject({
      type: "reasoning",
      text: "第二段推理。",
      metadata: { aiSdkReasoningId: "reasoning-2" },
    });
    expect(message?.parts[3]).toMatchObject({
      type: "text",
      text: "最终回答。",
      metadata: { aiSdkTextId: "text-2" },
    });

    db.close();
  });

  test("preserves separate reasoning blocks when a provider reuses the stream id after reasoning-end", async () => {
    const streamText: RuntimeStreamText = (input) => {
      void input.onChunk?.({
        chunk: { type: "reasoning-start", id: "reasoning-reused" } as never,
      });
      void input.onChunk?.({
        chunk: {
          type: "reasoning-delta",
          id: "reasoning-reused",
          text: "第一段推理。",
        },
      });
      void input.onChunk?.({
        chunk: { type: "reasoning-end", id: "reasoning-reused" } as never,
      });
      void input.onChunk?.({ chunk: { type: "text-delta", id: "text-1", text: "阶段性回答。" } });
      void input.onChunk?.({
        chunk: { type: "reasoning-start", id: "reasoning-reused" } as never,
      });
      void input.onChunk?.({
        chunk: {
          type: "reasoning-delta",
          id: "reasoning-reused",
          text: "第二段推理。",
        },
      });
      void input.onChunk?.({
        chunk: { type: "reasoning-end", id: "reasoning-reused" } as never,
      });
      void input.onChunk?.({ chunk: { type: "text-delta", id: "text-2", text: "最终回答。" } });
      void input.onFinish?.({ finishReason: "stop" });

      return {
        toUIMessageStreamResponse: () =>
          new Response("data: {}\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
      };
    };
    const { db, store, runner } = createRunner(streamText);

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "请分两次推理后回答",
    });
    await result.response.text();

    const message = store.getMessage(result.started.assistantMessage.id);
    expect(message?.parts.map((part) => part.type)).toEqual([
      "reasoning",
      "text",
      "reasoning",
      "text",
    ]);
    expect(message?.parts[0]).toMatchObject({
      type: "reasoning",
      text: "第一段推理。",
      metadata: { aiSdkReasoningId: "reasoning-reused" },
    });
    expect(message?.parts[2]).toMatchObject({
      type: "reasoning",
      text: "第二段推理。",
      metadata: { aiSdkReasoningId: "reasoning-reused" },
    });

    db.close();
  });

  test("preserves separate reasoning blocks when a provider reuses the stream id after a step boundary", async () => {
    const streamText: RuntimeStreamText = (input) => {
      void input.onChunk?.({
        chunk: { type: "reasoning-start", id: "reasoning-reused" } as never,
      });
      void input.onChunk?.({
        chunk: {
          type: "reasoning-delta",
          id: "reasoning-reused",
          text: "第一步推理。",
        },
      });
      void input.onChunk?.({
        chunk: { type: "finish-step" } as never,
      });
      void input.onChunk?.({ chunk: { type: "text-delta", id: "text-1", text: "阶段性回答。" } });
      void input.onChunk?.({
        chunk: { type: "reasoning-start", id: "reasoning-reused" } as never,
      });
      void input.onChunk?.({
        chunk: {
          type: "reasoning-delta",
          id: "reasoning-reused",
          text: "第二步推理。",
        },
      });
      void input.onChunk?.({ chunk: { type: "text-delta", id: "text-2", text: "最终回答。" } });
      void input.onFinish?.({ finishReason: "stop" });

      return {
        toUIMessageStreamResponse: () =>
          new Response("data: {}\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
      };
    };
    const { db, store, runner } = createRunner(streamText);

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "请分两步推理后回答",
    });
    await result.response.text();

    const message = store.getMessage(result.started.assistantMessage.id);
    expect(message?.parts.map((part) => part.type)).toEqual([
      "reasoning",
      "text",
      "reasoning",
      "text",
    ]);
    expect(message?.parts[0]).toMatchObject({
      type: "reasoning",
      text: "第一步推理。",
      metadata: { aiSdkReasoningId: "reasoning-reused" },
    });
    expect(message?.parts[2]).toMatchObject({
      type: "reasoning",
      text: "第二步推理。",
      metadata: { aiSdkReasoningId: "reasoning-reused" },
    });

    db.close();
  });

  test("records the exact safe provider error once when streamText reports an error", async () => {
    const providerError = Object.assign(
      new Error("provider down\nrequest id: req_123; key=sk-runtime-secret"),
      {
        name: "APICallError",
        statusCode: 429,
        isRetryable: true,
        headers: { authorization: "Bearer sk-runtime-secret" },
        responseBody: "must not be persisted",
      },
    );
    const { db, store, runner } = createRunner(
      failingStream(providerError),
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      () => ["sk-runtime-secret"],
    );

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Say hello",
    });

    const responseText = await result.response.text();

    const run = store.getRun(result.started.run.id);
    const message = store.getMessage(result.started.assistantMessage.id);
    const expectedError = {
      name: "APICallError",
      data: {
        message: "provider down\nrequest id: req_123; key=[REDACTED]",
        statusCode: 429,
        isRetryable: true,
      },
    };

    expect(run?.status).toBe("failed");
    expect(run?.error).toEqual(expectedError);
    expect(responseText).toContain(
      JSON.stringify({
        type: "error",
        errorText: "provider down\nrequest id: req_123; key=[REDACTED]",
      }),
    );
    expect(message?.role).toBe("assistant");
    expect(message && "status" in message ? message.status : undefined).toEqual({
      type: "error",
      error: expectedError,
    });
    expect(store.listMessages(result.started.conversation.id).filter(
      (candidate) => candidate.role === "assistant" && candidate.status.type === "error",
    )).toHaveLength(1);
    expect(projectMessageToAiSdkUIMessage(message!).metadata?.custom).toMatchObject({
      nexus: {
        status: {
          type: "error",
          error: expectedError,
        },
      },
    });

    db.close();
  });

  test("persists a UI message stream error through the unified failure path", async () => {
    const uiStreamError = new Error(
      "UI message conversion failed\nrequest id: ui_stream_1",
    );
    uiStreamError.name = "UIMessageStreamError";
    const streamText: RuntimeStreamText = () => ({
      toUIMessageStreamResponse: (options) => {
        const errorText = options?.onError?.(uiStreamError) ?? uiStreamError.message;
        return new Response(
          `data: ${JSON.stringify({ type: "error", errorText })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const { db, store, runner } = createRunner(streamText);

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Trigger a UI stream failure",
    });
    const responseText = await result.response.text();

    expect(responseText).toContain(
      "UI message conversion failed\\nrequest id: ui_stream_1",
    );
    expect(store.getRun(result.started.run.id)).toMatchObject({
      status: "failed",
      finish: "error",
      error: {
        name: "UIMessageStreamError",
        data: { message: uiStreamError.message },
      },
    });
    expect(store.getMessage(result.started.assistantMessage.id)).toMatchObject({
      role: "assistant",
      status: {
        type: "error",
        error: {
          name: "UIMessageStreamError",
          data: { message: uiStreamError.message },
        },
      },
    });
    expect(store.listEventsByRun(result.started.run.id).filter(
      (event) => event.type === "runtime.error",
    )).toHaveLength(1);

    db.close();
  });

  test("preserves and terminalizes a Provider tool part emitted before failure", async () => {
    const error = new Error("provider failed after emitting a tool call");
    const streamText: RuntimeStreamText = async (input) => {
      await input.onChunk?.({
        chunk: {
          type: "tool-call",
          toolCallId: "call_before_failure",
          toolName: "np__web__fetch",
          input: { url: "https://example.com" },
        },
      });
      await input.onError?.({ error });
      return {
        toUIMessageStreamResponse: (options) => new Response(
          `data: ${JSON.stringify({
            type: "error",
            errorText: options?.onError?.(error) ?? error.message,
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      };
    };
    const { db, store, runner } = createRunner(
      streamText,
      createWebRegistry(),
      undefined,
      true,
    );

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Fetch a URL",
      agentMode: "agent",
    });
    await result.response.text();

    const message = store.getMessage(result.started.assistantMessage.id);
    expect(message && "status" in message ? message.status.type : undefined).toBe(
      "error",
    );
    expect(message?.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool",
        toolName: "web.fetch",
        metadata: expect.objectContaining({
          aiSdkToolCallId: "call_before_failure",
          providerToolName: "np__web__fetch",
        }),
        state: expect.objectContaining({
          status: "error",
          input: { url: "https://example.com" },
        }),
      }),
    ]));

    db.close();
  });

  test("uses the exact provider message when streamText throws synchronously", async () => {
    const error = new Error("maximum context length exceeded\nrequest id: sync_1");
    error.name = "ContextLengthError";
    const streamText: RuntimeStreamText = () => {
      throw error;
    };
    const { db, store, runner } = createRunner(streamText);

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Say hello",
    });
    const responseText = await result.response.text();

    expect(responseText).toContain(
      JSON.stringify({
        type: "error",
        errorText: "maximum context length exceeded\nrequest id: sync_1",
      }),
    );
    expect(store.getRun(result.started.run.id)?.error).toEqual({
      name: "ContextLengthError",
      data: {
        message: "maximum context length exceeded\nrequest id: sync_1",
      },
    });

    db.close();
  });

  test("records interrupted run state with partial text when streamText reports an abort", async () => {
    const { db, store, runner } = createRunner(abortedStream("client disconnected"));

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Say hello",
    });

    await result.response.text();

    const run = store.getRun(result.started.run.id);
    const message = store.getMessage(result.started.assistantMessage.id);

    expect(run?.status).toBe("interrupted");
    expect(run?.finish).toBe("interrupted");
    expect(run?.metadata?.interrupt).toMatchObject({
      reason: "client_disconnect",
      message: "client disconnected",
    });
    expect(message && "status" in message ? message.status.type : undefined).toBe(
      "incomplete",
    );
    expect(message?.parts).toEqual([
      expect.objectContaining({
        type: "text",
        text: "Partial",
      }),
    ]);

    db.close();
  });

  test("registers active runs and interrupts them through the registry", async () => {
    let capturedSignal: AbortSignal | undefined;
    const streamText: RuntimeStreamText = (input) => {
      capturedSignal = input.abortSignal;
      void input.onChunk?.({ chunk: { type: "text-delta", text: "Partial" } });
      return {
        toUIMessageStreamResponse: () =>
          new Response("data: {}\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
      };
    };
    const { db, store, runner, activeRuns } = createRunnerWithActiveRegistry(streamText);

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Say hello",
    });

    expect(activeRuns.getActiveRunId(result.started.conversation.id)).toBe(
      result.started.run.id,
    );

    const interrupted = activeRuns.interruptRun(result.started.run.id, {
      reason: "user_stop",
      message: "user requested stop",
    });

    expect(interrupted?.interrupted).toBe(true);
    expect(capturedSignal?.aborted).toBe(true);
    expect(store.getRun(result.started.run.id)?.status).toBe("interrupted");
    expect(store.getMessage(result.started.assistantMessage.id)?.parts).toEqual([
      expect.objectContaining({
        type: "text",
        text: "Partial",
      }),
    ]);
    expect(activeRuns.getActiveRunId(result.started.conversation.id)).toBeNull();

    db.close();
  });

  test("passes AI SDK SSE consumer when creating UI message stream response", async () => {
    let responseOptions: unknown;
    const streamText: RuntimeStreamText = () => ({
      toUIMessageStreamResponse: (options) => {
        responseOptions = options;
        return new Response("", {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const { db, runner } = createRunner(streamText);

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Say hello",
    });

    await result.response.text();

    expect(
      typeof (responseOptions as { consumeSseStream?: unknown }).consumeSseStream,
    ).toBe("function");
    expect(
      (
        responseOptions as { generateMessageId?: () => string }
      ).generateMessageId?.(),
    ).toBe(result.started.assistantMessage.id);

    db.close();
  });

  test("passes assembled ask system prompt into AI SDK streamText", async () => {
    let capturedSystem: string | undefined;
    const streamText: RuntimeStreamText = (input) => {
      capturedSystem = typeof input.instructions === "string"
        ? input.instructions
        : JSON.stringify(input.instructions);
      void input.onChunk?.({ chunk: { type: "text-delta", text: "Answer" } });
      void input.onFinish?.({ finishReason: "stop" });

      return {
        toUIMessageStreamResponse: () =>
          new Response("data: {}\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
      };
    };
    const { db, store, runner } = createRunner(streamText);

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Say hello",
    });
    await result.response.text();

    expect(capturedSystem).toContain("NexusPilot");
    expect(capturedSystem).not.toContain("当前可用工具");
    expect(store.getRun(result.started.run.id)?.input.prompt?.version).toBe(
      "runtime-prompt-v2",
    );

    db.close();
  });

  test("passes persisted conversation history into AI SDK streamText for follow-up runs", async () => {
    const capturedInputs: Array<{ prompt?: string; messages?: unknown[] }> = [];
    const streamText: RuntimeStreamText = (input) => {
      capturedInputs.push(input as unknown as { prompt?: string; messages?: unknown[] });
      void input.onChunk?.({ chunk: { type: "text-delta", text: "Answer" } });
      void input.onFinish?.({ finishReason: "stop" });

      return {
        toUIMessageStreamResponse: () =>
          new Response("data: {}\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
      };
    };
    const { db, runner } = createRunner(streamText);

    const first = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "我的名字叫 Alice。",
    });
    await first.response.text();

    const second = await runner.streamText({
      conversationId: first.started.conversation.id,
      providerId: "openai",
      modelId: "gpt-4o",
      text: "我叫什么名字？",
    });
    await second.response.text();

    expect(capturedInputs[1]?.prompt).toBeUndefined();
    expect(capturedInputs[1]?.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "我的名字叫 Alice。" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Answer" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "我叫什么名字？" }],
      },
    ]);

    db.close();
  });

  test("replays persisted provider metadata only to the exact same model", async () => {
    const capturedMessages: unknown[][] = [];
    let callCount = 0;
    const streamText: RuntimeStreamText = (input) => {
      callCount += 1;
      capturedMessages.push(structuredClone(input.messages ?? []));
      if (callCount === 1) {
        void input.onChunk?.({
          chunk: { type: "reasoning-start", id: "reasoning-history" },
        });
        void input.onChunk?.({
          chunk: {
            type: "reasoning-delta",
            id: "reasoning-history",
            text: "Stored reasoning",
          },
        });
        void input.onChunk?.({
          chunk: {
            type: "reasoning-end",
            id: "reasoning-history",
            providerMetadata: { test: { signature: "stored-signature" } },
          },
        });
        void input.onChunk?.({
          chunk: {
            type: "text-delta",
            id: "text-history",
            text: "Stored answer",
            providerMetadata: { test: { itemId: "stored-text" } },
          },
        });
      } else {
        void input.onChunk?.({ chunk: { type: "text-delta", text: "Next" } });
      }
      void input.onFinish?.({ finishReason: "stop" });
      return {
        toUIMessageStreamResponse: () => new Response("data: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
      };
    };
    const { db, runner } = createRunner(streamText);

    const first = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "First",
    });
    await first.response.text();
    const sameModel = await runner.streamText({
      conversationId: first.started.conversation.id,
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Second",
    });
    await sameModel.response.text();
    const switchedModel = await runner.streamText({
      conversationId: first.started.conversation.id,
      providerId: "openai",
      modelId: "gpt-5",
      text: "Third",
    });
    await switchedModel.response.text();

    expect(capturedMessages[1]?.[1]).toEqual({
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "Stored reasoning",
          providerOptions: { test: { signature: "stored-signature" } },
        },
        {
          type: "text",
          text: "Stored answer",
          providerOptions: { test: { itemId: "stored-text" } },
        },
      ],
    });
    expect(capturedMessages[2]?.[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Stored reasoning" },
        { type: "text", text: "Stored answer" },
      ],
    });
    expect(callCount).toBe(3);

    db.close();
  });

  test("passes resolved model behavior into AI SDK streamText input", async () => {
    let capturedTemperature: number | undefined;
    let capturedTopP: number | undefined;
    let capturedToolChoice: string | undefined;
    const streamText: RuntimeStreamText = (input) => {
      const modelSettings = input as {
        temperature?: number;
        topP?: number;
        toolChoice?: string;
      };
      capturedTemperature = modelSettings.temperature;
      capturedTopP = modelSettings.topP;
      capturedToolChoice = modelSettings.toolChoice;
      void input.onChunk?.({ chunk: { type: "text-delta", text: "Answer" } });
      void input.onFinish?.({ finishReason: "stop" });

      return {
        toUIMessageStreamResponse: () =>
          new Response("data: {}\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
      };
    };
    const { db, runner } = createRunner(streamText);

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Say hello",
    });
    await result.response.text();

    expect(capturedTemperature).toBe(0.2);
    expect(capturedTopP).toBeUndefined();
    expect(capturedToolChoice).toBe("auto");

    db.close();
  });

  test("resolves agent prompt and stores tool policy warnings when tools are unavailable", async () => {
    let capturedSystem: string | undefined;
    const streamText: RuntimeStreamText = (input) => {
      capturedSystem = typeof input.instructions === "string"
        ? input.instructions
        : JSON.stringify(input.instructions);
      void input.onChunk?.({ chunk: { type: "text-delta", text: "Agent answer" } });
      void input.onFinish?.({ finishReason: "stop" });

      return {
        toUIMessageStreamResponse: () =>
          new Response("data: {}\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
      };
    };
    const { db, store, runner } = createRunner(streamText);

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Use agent mode",
      agentMode: "agent",
    });
    await result.response.text();

    const run = store.getRun(result.started.run.id);
    const traces = store.listTraces(result.started.run.id);

    expect(capturedSystem).toContain("当前处于 Agent 模式");
    expect(run?.agentMode).toBe("agent");
    expect(run?.input.tools?.activeTools).toEqual([]);
    expect(run?.input.tools?.unavailableTools).toBeUndefined();
    expect(
      traces.some((trace) =>
        JSON.stringify(trace.payload).includes(
          "Namespace web is allowed by agent but not registered",
        ),
      ),
    ).toBe(true);
    expect(traces.some((trace) => trace.type === "prompt.assembled")).toBe(true);

    db.close();
  });

  test("freezes active Tool identities and exposes them through the Core adapter", async () => {
    let capturedSystem: string | undefined;
    let capturedActiveTools: string[] | undefined;
    let capturedToolNames: string[] | undefined;
    const streamText: RuntimeStreamText = (input) => {
      capturedSystem = typeof input.instructions === "string"
        ? input.instructions
        : JSON.stringify(input.instructions);
      capturedActiveTools = input.activeTools;
      capturedToolNames = input.tools ? Object.keys(input.tools) : undefined;
      void input.onChunk?.({ chunk: { type: "text-delta", text: "Agent answer" } });
      void input.onFinish?.({ finishReason: "stop" });

      return {
        toUIMessageStreamResponse: () =>
          new Response("data: {}\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
      };
    };
    const { db, store, runner } = createRunnerWithToolMetadata(streamText);

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Can you fetch this URL?",
      agentMode: "agent",
    });
    await result.response.text();

    const run = store.getRun(result.started.run.id);

    expect(capturedSystem).toContain("当前可用工具");
    expect(capturedActiveTools).toEqual(["np__web__fetch"]);
    expect(capturedToolNames).toEqual(["np__web__fetch"]);
    expect(run?.input.tools).toMatchObject({
      activeTools: [
        { canonicalId: "web.fetch", providerName: "np__web__fetch" },
      ],
    });

    db.close();
  });

  test("resolves ask mode tools into the AI SDK Core adapter", async () => {
    let capturedSystem: string | undefined;
    let capturedActiveTools: string[] | undefined;
    let capturedToolNames: string[] | undefined;
    const streamText: RuntimeStreamText = (input) => {
      capturedSystem = typeof input.instructions === "string"
        ? input.instructions
        : JSON.stringify(input.instructions);
      capturedActiveTools = input.activeTools;
      capturedToolNames = input.tools ? Object.keys(input.tools) : undefined;
      void input.onChunk?.({ chunk: { type: "text-delta", text: "Ask answer" } });
      void input.onFinish?.({ finishReason: "stop" });

      return {
        toUIMessageStreamResponse: () =>
          new Response("data: {}\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
      };
    };
    const { db, store, runner } = createRunnerWithDefaultTools(streamText);

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "请帮我查一下公开资料",
    });
    await result.response.text();

    const run = store.getRun(result.started.run.id);

    expect(capturedSystem).toContain("当前可用工具");
    expect(capturedActiveTools).toEqual(["np__web__fetch"]);
    expect(capturedToolNames).toEqual(["np__web__fetch"]);
    expect(run?.agentMode).toBe("ask");
    expect(run?.input.tools).toMatchObject({
      activeTools: [
        { canonicalId: "web.fetch", providerName: "np__web__fetch" },
      ],
    });

    db.close();
  });

  test("persists ToolCall only through Core and projects callbacks into message parts", async () => {
    const streamText: RuntimeStreamText = async (input) => {
      void input.onToolCallStart?.({
        stepNumber: 0,
        toolCall: {
          type: "tool-call",
          toolCallId: "call_web",
          toolName: "np__web__fetch",
          input: { url: "https://example.com" },
        } as never,
      });
      const output = await input.tools?.np__web__fetch.execute?.(
        { url: "https://example.com" },
        {
          toolCallId: "call_web",
          messages: [],
          abortSignal: undefined,
          context: undefined,
        },
      );
      void input.onToolCallFinish?.({
        stepNumber: 0,
        toolCall: {
          type: "tool-call",
          toolCallId: "call_web",
          toolName: "np__web__fetch",
          input: { url: "https://example.com" },
        } as never,
        success: true,
        output,
        durationMs: 1,
      });
      void input.onChunk?.({ chunk: { type: "text-delta", text: "Done" } });
      void input.onFinish?.({ finishReason: "stop" });

      return {
        toUIMessageStreamResponse: () =>
          new Response("data: {}\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
      };
    };
    const { db, store, runner } = createRunnerWithToolMetadata(streamText);

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Fetch https://example.com",
      agentMode: "agent",
    });
    await result.response.text();

    const message = store.getMessage(result.started.assistantMessage.id);
    expect(message?.parts.map((part) => part.type)).toEqual(["tool", "source", "text"]);

    const toolPart = message?.parts.find((part) => part.type === "tool");
    const sourcePart = message?.parts.find((part) => part.type === "source");

    expect(toolPart).toMatchObject({
      type: "tool",
      toolName: "web.fetch",
      state: {
        status: "completed",
        input: { url: "https://example.com" },
      },
    });
    expect(sourcePart).toMatchObject({
      type: "source",
      sourceType: "url",
      url: "https://example.com",
    });

    const toolCallId = toolPart && "toolCallId" in toolPart ? toolPart.toolCallId : null;
    expect(toolCallId).toBeTruthy();
    const toolCall = store.getToolCall(toolCallId as never);
    expect(toolCall).toMatchObject({
      toolName: "web.fetch",
      state: "completed",
      input: { url: "https://example.com" },
    });

    const toolEvents = store
      .listEvents(result.started.conversation.id)
      .filter((event) => event.type === "tool.updated");
    expect(toolEvents.map((event) => event.properties.info)).toEqual([
      expect.objectContaining({
        toolName: "web.fetch",
        state: "running",
      }),
      expect.objectContaining({
        toolName: "web.fetch",
        state: "completed",
      }),
    ]);

    db.close();
  });

  test("replays the persisted Provider tool name through a real Runtime registry", async () => {
    let streamCallCount = 0;
    let followUpMessages: unknown[] | undefined;
    const streamText: RuntimeStreamText = async (input) => {
      streamCallCount += 1;
      if (streamCallCount === 1) {
        const toolCall = {
          type: "tool-call" as const,
          toolCallId: "call_web_history",
          toolName: "np__web__fetch",
          input: { url: "https://example.com" },
        };
        await input.onToolCallStart?.({ stepNumber: 0, toolCall });
        const output = await input.tools?.np__web__fetch.execute?.(
          toolCall.input,
          {
            toolCallId: toolCall.toolCallId,
            messages: [],
            abortSignal: undefined,
            context: undefined,
          },
        );
        await input.onToolCallFinish?.({
          stepNumber: 0,
          toolCall,
          success: true,
          output,
          durationMs: 1,
        });
        await input.onFinish?.({ finishReason: "stop" });
      } else {
        followUpMessages = structuredClone(input.messages ?? []);
        await input.onChunk?.({ chunk: { type: "text-delta", text: "Follow-up" } });
        await input.onFinish?.({ finishReason: "stop" });
      }

      return {
        toUIMessageStreamResponse: () => new Response("data: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
      };
    };
    const { db, store, runner } = createRunnerWithToolMetadata(streamText);

    const first = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Fetch https://example.com",
      agentMode: "agent",
    });
    await first.response.text();
    const firstMessage = store.getMessage(first.started.assistantMessage.id);
    const persistedTool = firstMessage?.parts.find((part) => part.type === "tool");

    expect(persistedTool).toMatchObject({
      type: "tool",
      toolName: "web.fetch",
      metadata: {
        aiSdkToolCallId: "call_web_history",
        providerToolName: "np__web__fetch",
      },
    });

    const second = await runner.streamText({
      conversationId: first.started.conversation.id,
      providerId: "openai",
      modelId: "gpt-4o",
      text: "What did the tool return?",
      agentMode: "agent",
    });
    await second.response.text();

    expect(followUpMessages?.map(
      (message) => (message as { role: string }).role,
    )).toEqual(["user", "assistant", "tool", "user"]);
    expect(followUpMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "tool-call",
            toolCallId: "call_web_history",
            toolName: "np__web__fetch",
            input: { url: "https://example.com" },
          }),
        ]),
      }),
      expect.objectContaining({
        role: "tool",
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "tool-result",
            toolCallId: "call_web_history",
            toolName: "np__web__fetch",
            output: {
              type: "json",
              value: expect.objectContaining({
                data: {
                  finalUrl: "https://example.com",
                  title: "Example",
                  preview: "Example page",
                },
                display: expect.objectContaining({
                  summary: "Fetched.",
                }),
              }),
            },
          }),
        ]),
      }),
    ]));
    expect(store.listToolCallsByRun(first.started.run.id)).toHaveLength(1);
    expect(store.listToolCallsByRun(second.started.run.id)).toHaveLength(0);

    db.close();
  });

  test("persists a real AI SDK error part once and keeps earlier semantic parts", async () => {
    const providerError = new Error(
      "maximum context length exceeded\nrequest id: stream_real_1",
    );
    providerError.name = "ContextLengthError";
    let modelCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "reasoning-start" as const, id: "partial-reasoning" },
              {
                type: "reasoning-delta" as const,
                id: "partial-reasoning",
                delta: "Reasoning before failure",
              },
              { type: "reasoning-end" as const, id: "partial-reasoning" },
              { type: "text-start" as const, id: "partial-text" },
              {
                type: "text-delta" as const,
                id: "partial-text",
                delta: "Partial before failure",
              },
              { type: "text-end" as const, id: "partial-text" },
              { type: "error" as const, error: providerError },
            ],
          }),
        };
      },
    });
    const { db, store, runner } = createRunnerWithModel(model);

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Trigger a Provider stream failure",
    });
    const responseText = await result.response.text();

    const storedRun = store.getRun(result.started.run.id);
    const storedMessage = store.getMessage(result.started.assistantMessage.id);
    const storedConversation = store.getConversation(result.started.conversation.id);
    expect(modelCalls).toBe(1);
    expect(storedRun).toMatchObject({
      status: "failed",
      finish: "error",
      error: {
        name: "ContextLengthError",
        data: {
          message: "maximum context length exceeded\nrequest id: stream_real_1",
        },
      },
    });
    expect(storedMessage).toMatchObject({
      role: "assistant",
      status: {
        type: "error",
        error: {
          name: "ContextLengthError",
          data: {
            message: "maximum context length exceeded\nrequest id: stream_real_1",
          },
        },
      },
    });
    expect(storedMessage?.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "reasoning",
        text: "Reasoning before failure",
      }),
      expect.objectContaining({
        type: "text",
        text: "Partial before failure",
      }),
    ]));
    expect(storedConversation?.status).toMatchObject({
      type: "error",
      error: {
        name: "ContextLengthError",
        data: {
          message: "maximum context length exceeded\nrequest id: stream_real_1",
        },
      },
    });
    expect(store.listMessages(result.started.conversation.id).filter(
      (message) => message.role === "assistant" && message.status.type === "error",
    )).toHaveLength(1);
    const runtimeErrorEvents = store.listEventsByRun(result.started.run.id).filter(
      (event) => event.type === "runtime.error",
    );
    expect(runtimeErrorEvents).toEqual([
      expect.objectContaining({
        type: "runtime.error",
        properties: {
          conversationId: result.started.conversation.id,
          runId: result.started.run.id,
          error: {
            name: "ContextLengthError",
            data: {
              message: "maximum context length exceeded\nrequest id: stream_real_1",
            },
          },
        },
      }),
    ]);
    expect(projectMessageToAiSdkUIMessage(storedMessage!).metadata?.custom).toMatchObject({
      nexus: {
        status: {
          type: "error",
          error: {
            name: "ContextLengthError",
            data: {
              message: "maximum context length exceeded\nrequest id: stream_real_1",
            },
          },
        },
      },
    });
    expect(responseText).toContain(
      "maximum context length exceeded\\nrequest id: stream_real_1",
    );

    db.close();
  });

  test("preserves tool part stream position when tool execution finishes after text", async () => {
    const streamText: RuntimeStreamText = (input) => {
      void input.onChunk?.({
        chunk: {
          type: "tool-call",
          toolCallId: "call_web",
          toolName: "web_fetch",
          input: { url: "https://example.com" },
        } as never,
      });
      void input.onToolCallStart?.({
        stepNumber: 0,
        toolCall: {
          type: "tool-call",
          toolCallId: "call_web",
          toolName: "web_fetch",
          input: { url: "https://example.com" },
        } as never,
      });
      void input.onChunk?.({ chunk: { type: "text-delta", id: "text-1", text: "Done" } });
      void input.onToolCallFinish?.({
        stepNumber: 0,
        toolCall: {
          type: "tool-call",
          toolCallId: "call_web",
          toolName: "web_fetch",
          input: { url: "https://example.com" },
        } as never,
        success: true,
        output: {
          ok: true,
          output: {
            data: {
              finalUrl: "https://example.com",
              title: "Example",
              preview: "Example page",
            },
            display: {
              title: "Example",
              sourceUrl: "https://example.com",
            },
          },
          metadata: { started: 1, completed: 2, durationMs: 1 },
        },
        durationMs: 1,
      });
      void input.onFinish?.({ finishReason: "stop" });

      return {
        toUIMessageStreamResponse: () =>
          new Response("data: {}\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
      };
    };
    const { db, store, runner } = createRunner(streamText, createWebRegistry());

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Fetch https://example.com",
      agentMode: "agent",
    });
    await result.response.text();

    const message = store.getMessage(result.started.assistantMessage.id);
    expect(message?.parts.map((part) => part.type)).toEqual(["tool", "source", "text"]);
    expect(message?.parts[0]).toMatchObject({
      type: "tool",
      toolName: "web_fetch",
      state: {
        status: "completed",
        input: { url: "https://example.com" },
      },
    });
    expect(message?.parts[1]).toMatchObject({
      type: "source",
      url: "https://example.com",
    });
    expect(message?.parts[2]).toMatchObject({
      type: "text",
      text: "Done",
    });

    db.close();
  });

  test("does not let callback-only output create a ToolCall fact", async () => {
    const streamText: RuntimeStreamText = (input) => {
      void input.onToolCallStart?.({
        stepNumber: 0,
        toolCall: {
          type: "tool-call",
          toolCallId: "call_invalid",
          toolName: "web_fetch",
          input: { url: "https://example.com" },
        } as never,
      });
      void input.onToolCallFinish?.({
        stepNumber: 0,
        toolCall: {
          type: "tool-call",
          toolCallId: "call_invalid",
          toolName: "web_fetch",
          input: { url: "https://example.com" },
        } as never,
        success: true,
        output: { unexpected: true },
        durationMs: 1,
      });
      void input.onFinish?.({ finishReason: "stop" });

      return {
        toUIMessageStreamResponse: () =>
          new Response("data: {}\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
      };
    };
    const { db, store, runner } = createRunner(streamText, createWebRegistry());

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Fetch https://example.com",
      agentMode: "agent",
    });
    await result.response.text();

    const toolPart = store
      .getMessage(result.started.assistantMessage.id)
      ?.parts.find((part) => part.type === "tool");
    const toolCallId = toolPart && "toolCallId" in toolPart ? toolPart.toolCallId : null;
    const toolCall = store.getToolCall(toolCallId as never);

    expect(toolPart).toMatchObject({
      type: "tool",
      state: {
        status: "error",
        error: {
          code: "INTERNAL_ERROR",
        },
      },
    });
    expect(toolCall).toBeNull();

    db.close();
  });

  test("projects invalid AI SDK tool input as a validation error without creating a ToolCall fact", async () => {
    const streamText: RuntimeStreamText = (input) => {
      const invalidInput = {
        parent: "{\"kind\":\"database\",\"database\":\"app\"}",
        password: "should-not-persist",
      };
      void input.onChunk?.({
        chunk: {
          type: "tool-call",
          toolCallId: "call_invalid_input",
          toolName: "np__web__fetch",
          input: invalidInput,
          invalid: true,
        },
      });
      void input.onChunk?.({
        chunk: {
          type: "tool-error",
          toolCallId: "call_invalid_input",
          toolName: "np__web__fetch",
          input: invalidInput,
          error: "simulated schema details with secret=should-not-persist",
        },
      });
      void input.onFinish?.({ finishReason: "stop" });

      return {
        toUIMessageStreamResponse: () =>
          new Response("data: {}\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
      };
    };
    const { db, store, runner } = createRunner(streamText, createWebRegistry());

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Use an invalid tool input",
      agentMode: "agent",
    });
    await result.response.text();

    const toolPart = store
      .getMessage(result.started.assistantMessage.id)
      ?.parts.find((part) => part.type === "tool");
    const toolCallId = toolPart && "toolCallId" in toolPart ? toolPart.toolCallId : null;

    expect(toolPart).toMatchObject({
      type: "tool",
      state: {
        status: "error",
        error: {
          code: "VALIDATION_ERROR",
          message: "Tool input did not match the declared schema.",
          retryable: true,
        },
      },
    });
    expect(JSON.stringify(toolPart)).not.toContain("should-not-persist");
    expect(store.getToolCall(toolCallId as never)).toBeNull();

    db.close();
  });

  test("keeps a real AI SDK authorization failure inside ToolCall and continues the Run", async () => {
    let modelCallCount = 0;
    let executionCount = 0;
    const namespace: RuntimeToolNamespace = {
      id: "web",
      title: "Web",
      description: "Authorization failure test tools",
      tools: [{
        id: "web.fetch",
        title: "Fetch Web Page",
        description: "Fetch a public web page.",
        inputSchema: z.object({ url: z.string() }).strict(),
        outputSchema: z.object({ value: z.string() }).strict(),
        executionTarget: "runtime",
        risk: {
          mode: "dynamic",
          level: "low",
          reversible: true,
          sideEffect: "external_network",
        },
        resolveRisk: async () => {
          throw new Error("simulated authorization preflight failure");
        },
        execute: async () => {
          executionCount += 1;
          return { summary: "unexpected", data: { value: "unexpected" } };
        },
      }],
      resolveForRun: () => ({ candidateToolIds: ["web.fetch"] }),
    };
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCallCount += 1;
        const content = modelCallCount === 1
          ? [{
              type: "tool-call" as const,
              toolCallId: "call_authorization_failure",
              toolName: "np__web__fetch",
              input: "{\"url\":\"https://example.com\"}",
            }]
          : [
              { type: "text-start" as const, id: "text-recovery" },
              {
                type: "text-delta" as const,
                id: "text-recovery",
                delta: "The tool failed before execution, so I did not use its result.",
              },
              { type: "text-end" as const, id: "text-recovery" },
            ];

        return {
          stream: simulateReadableStream({
            chunks: [
              ...content,
              {
                type: "finish" as const,
                finishReason: {
                  unified: modelCallCount === 1 ? "tool-calls" as const : "stop" as const,
                  raw: undefined,
                },
                logprobs: undefined,
                usage: {
                  inputTokens: {
                    total: 4,
                    noCache: 4,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: {
                    total: 2,
                    text: modelCallCount === 1 ? 0 : 2,
                    reasoning: 0,
                  },
                },
              },
            ],
          }),
        };
      },
    });
    const registry = new RuntimeToolRegistry([namespace]);
    const { db, store, runner } = createRunnerWithModel(model, registry);

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Fetch a URL and explain the result",
      agentMode: "agent",
    });
    await result.response.text();

    const message = store.getMessage(result.started.assistantMessage.id);
    const toolPart = message?.parts.find((part) => part.type === "tool");
    const toolCallId = toolPart && "toolCallId" in toolPart
      ? toolPart.toolCallId
      : null;

    expect(modelCallCount).toBe(2);
    expect(executionCount).toBe(0);
    expect(store.getRun(result.started.run.id)?.status).toBe("completed");
    expect(store.listPendingPermissionsByRun(result.started.run.id)).toEqual([]);
    expect(store.getToolCall(toolCallId as never)).toMatchObject({
      state: "error",
      error: {
        code: "TOOL_RISK_RESOLUTION_FAILED",
        outcome: "not_started",
      },
    });
    expect(toolPart).toMatchObject({
      type: "tool",
      state: {
        status: "error",
        error: {
          code: "INTERNAL_ERROR",
          details: {
            runtimeCode: "TOOL_RISK_RESOLUTION_FAILED",
            outcome: "not_started",
          },
        },
      },
    });
    expect(message?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: "The tool failed before execution, so I did not use its result.",
        }),
      ]),
    );

    db.close();
  });

  test("maps a real AI SDK invalid tool call stream to a validation error", async () => {
    let modelCallCount = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCallCount += 1;
        const content = modelCallCount === 1
          ? [{
              type: "tool-call" as const,
              toolCallId: "call_invalid_url",
              toolName: "np__web__fetch",
              input: "{\"url\":123}",
            }]
          : [
              { type: "text-start" as const, id: "text-1" },
              { type: "text-delta" as const, id: "text-1", delta: "Recovered" },
              { type: "text-end" as const, id: "text-1" },
            ];

        return {
          stream: simulateReadableStream({
            chunks: [
              ...content,
              {
                type: "finish" as const,
                finishReason: {
                  unified: modelCallCount === 1 ? "tool-calls" as const : "stop" as const,
                  raw: undefined,
                },
                logprobs: undefined,
                usage: {
                  inputTokens: {
                    total: 4,
                    noCache: 4,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: {
                    total: 2,
                    text: modelCallCount === 1 ? 0 : 2,
                    reasoning: 0,
                  },
                },
              },
            ],
          }),
        };
      },
    });
    const { db, store, runner } = createRunnerWithModel(model, createWebRegistry());

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Fetch a URL",
      agentMode: "agent",
    });
    await result.response.text();

    const message = store.getMessage(result.started.assistantMessage.id);
    const toolPart = message?.parts.find((part) => part.type === "tool");
    const toolCallId = toolPart && "toolCallId" in toolPart ? toolPart.toolCallId : null;

    expect(modelCallCount).toBe(2);
    expect(toolPart).toMatchObject({
      type: "tool",
      state: {
        status: "error",
        error: {
          code: "VALIDATION_ERROR",
          retryable: true,
        },
      },
    });
    expect(store.getToolCall(toolCallId as never)).toBeNull();

    db.close();
  });

  test("uses AI SDK streamText to persist normalized reasoning and text deltas", async () => {
    const { db, store, runner } = createRunnerWithModel(
      new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              {
                type: "reasoning-start",
                id: "reasoning-1",
                providerMetadata: { test: { stage: "reasoning-start" } },
              },
              {
                type: "reasoning-delta",
                id: "reasoning-1",
                delta: " Think",
              },
              {
                type: "reasoning-delta",
                id: "reasoning-1",
                delta: " first ",
                providerMetadata: { test: { stage: "reasoning-delta" } },
              },
              { type: "reasoning-end", id: "reasoning-1" },
              {
                type: "text-start",
                id: "text-1",
                providerMetadata: { test: { stage: "text-start" } },
              },
              { type: "text-delta", id: "text-1", delta: "Hello" },
              {
                type: "text-delta",
                id: "text-1",
                delta: " AI SDK",
                providerMetadata: { test: { stage: "text-delta" } },
              },
              {
                type: "text-end",
                id: "text-1",
                providerMetadata: { test: { stage: "text-end" } },
              },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                logprobs: undefined,
                usage: {
                  inputTokens: {
                    total: 4,
                    noCache: 4,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: {
                    total: 5,
                    text: 3,
                    reasoning: 2,
                  },
                },
              },
            ],
          }),
        }),
      }),
    );

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Say hello",
    });

    expect(result.response.headers.get("content-type")).toContain("text/event-stream");
    await result.response.text();

    const message = store.getMessage(result.started.assistantMessage.id);
    expect(message?.parts.map((part) => part.type)).toEqual([
      "step-start",
      "reasoning",
      "text",
    ]);
    expect(message?.parts[1]).toMatchObject({
      type: "reasoning",
      text: " Think first ",
      metadata: {
        aiSdkReasoningId: "reasoning-1",
        providerMetadata: { test: { stage: "reasoning-delta" } },
      },
    });
    expect(message?.parts[2]).toMatchObject({
      type: "text",
      text: "Hello AI SDK",
      metadata: {
        aiSdkTextId: "text-1",
        providerMetadata: { test: { stage: "text-end" } },
      },
    });
    expect(store.getRun(result.started.run.id)?.usage).toEqual({
      input: 4,
      output: 5,
      reasoning: 2,
      total: 9,
    });

    db.close();
  });

  test("uses AI SDK full stream boundaries to preserve reused reasoning ids", async () => {
    const { db, store, runner } = createRunnerWithModel(
      new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "reasoning-start", id: "reasoning-reused" },
              {
                type: "reasoning-delta",
                id: "reasoning-reused",
                delta: "First",
              },
              { type: "reasoning-end", id: "reasoning-reused" },
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: " middle" },
              { type: "text-end", id: "text-1" },
              { type: "reasoning-start", id: "reasoning-reused" },
              {
                type: "reasoning-delta",
                id: "reasoning-reused",
                delta: "Second",
              },
              { type: "reasoning-end", id: "reasoning-reused" },
              { type: "text-start", id: "text-2" },
              { type: "text-delta", id: "text-2", delta: " done" },
              { type: "text-end", id: "text-2" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                logprobs: undefined,
                usage: {
                  inputTokens: {
                    total: 4,
                    noCache: 4,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: {
                    total: 5,
                    text: 3,
                    reasoning: 2,
                  },
                },
              },
            ],
          }),
        }),
      }),
    );

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Say hello",
    });

    await result.response.text();

    const message = store.getMessage(result.started.assistantMessage.id);
    expect(message?.parts.map((part) => part.type)).toEqual([
      "step-start",
      "reasoning",
      "text",
      "reasoning",
      "text",
    ]);
    expect(message?.parts[1]).toMatchObject({
      type: "reasoning",
      text: "First",
    });
    expect(message?.parts[3]).toMatchObject({
      type: "reasoning",
      text: "Second",
    });

    db.close();
  });
});
