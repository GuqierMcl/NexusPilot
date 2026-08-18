import { describe, expect, test } from "bun:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import {
  RuntimeSqliteStore,
  RuntimeTextRunner,
  ActiveRunRegistry,
  RuntimeToolRegistry,
  type GenerateConversationTitle,
  type RuntimeStreamText,
  type RuntimeTextRunnerDependencies,
  type RuntimeToolNamespace,
} from "../src/runtime";
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
      toUIMessageStreamResponse: () =>
        new Response(
          `data: ${JSON.stringify({ type: "error", message: error.message })}\n\n`,
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

function createRunner(
  streamText: RuntimeStreamText,
  toolRegistry?: RuntimeToolRegistry,
  generateConversationTitle?: GenerateConversationTitle,
  supportsTools = false,
  getToolApprovalPolicy?: () => {
    autoApproveMaxRisk: "none" | "low" | "medium";
  },
  resolveLanguageModel?: RuntimeTextRunnerDependencies["resolveLanguageModel"],
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
          supportsTools: true,
        },
      },
    }),
    toolRegistry,
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
  test("waits for permission and continues the same Run with one approved execution", async () => {
    let executions = 0;
    let segment = 0;
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
    expect(store.getRun(waitingRun.id)).toMatchObject({
      status: "completed",
      usage: { input: 5, output: 3, total: 8 },
      input: {
        tools: {
          approvalPolicy: { autoApproveMaxRisk: "low" },
        },
      },
    });
    expect(store.getToolCall(permission.toolCallId)).toMatchObject({
      state: "completed",
      permissionId: permission.id,
    });
    expect(executions).toBe(1);
    expect(store.getPermission(permission.id)?.decision).toMatchObject({
      confirmationVerified: true,
    });

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

    await expect(runner.continueText(waitingRun.id, [{
      permissionId: permission.id,
      approved: true,
    }])).rejects.toThrow("Continuation bootstrap failed");

    expect(store.getRun(waitingRun.id)?.status).toBe("failed");
    expect(store.getConversation(waitingRun.conversationId)?.status.type).toBe("error");
    expect(store.getPermission(permission.id)?.status).toBe("approved");
    expect(getToolCall(permission.toolCallId)?.state).toBe("error");
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

  test("records failed run state when streamText reports an error", async () => {
    const { db, store, runner } = createRunner(failingStream(new Error("provider down")));

    const result = await runner.streamText({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Say hello",
    });

    await result.response.text();

    const run = store.getRun(result.started.run.id);
    const message = store.getMessage(result.started.assistantMessage.id);

    expect(run?.status).toBe("failed");
    expect(run?.error?.name).toBe("APIError");
    expect(message?.role).toBe("assistant");
    expect(message && "status" in message ? message.status.type : undefined).toBe(
      "error",
    );

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
      capturedSystem = input.system;
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
      { role: "user", content: "我的名字叫 Alice。" },
      { role: "assistant", content: "Answer" },
      { role: "user", content: "我叫什么名字？" },
    ]);

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
      capturedSystem = input.system;
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
      capturedSystem = input.system;
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
      capturedSystem = input.system;
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
              { type: "reasoning-start", id: "reasoning-1" },
              {
                type: "reasoning-delta",
                id: "reasoning-1",
                delta: "Think",
              },
              {
                type: "reasoning-delta",
                id: "reasoning-1",
                delta: " first",
              },
              { type: "reasoning-end", id: "reasoning-1" },
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "Hello" },
              { type: "text-delta", id: "text-1", delta: " AI SDK" },
              { type: "text-end", id: "text-1" },
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
    expect(message?.parts.map((part) => part.type)).toEqual(["reasoning", "text"]);
    expect(message?.parts[0]).toMatchObject({
      type: "reasoning",
      text: "Think first",
    });
    expect(message?.parts[1]).toMatchObject({
      type: "text",
      text: "Hello AI SDK",
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
      "reasoning",
      "text",
      "reasoning",
      "text",
    ]);
    expect(message?.parts[0]).toMatchObject({
      type: "reasoning",
      text: "First",
    });
    expect(message?.parts[2]).toMatchObject({
      type: "reasoning",
      text: "Second",
    });

    db.close();
  });
});
