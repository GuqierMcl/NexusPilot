import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { createApp } from "../src/app";
import {
  RuntimeEventBus,
  RuntimeSqliteStore,
  type RuntimeEventEnvelope,
  type RuntimeStreamText,
} from "../src/runtime";
import { openRuntimeDatabase } from "../src/storage/runtime-database";

function streamFromText(text: string): RuntimeStreamText {
  return (input) => {
    void input.onChunk?.({ chunk: { type: "text-delta", text } });
    void input.onFinish?.({
      finishReason: "stop",
      totalUsage: {
        inputTokens: 1,
        inputTokenDetails: {
          noCacheTokens: 1,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens: 1,
        outputTokenDetails: {
          textTokens: 1,
          reasoningTokens: undefined,
        },
        totalTokens: 2,
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

function config() {
  return {
    host: "127.0.0.1",
    port: 8787,
    dataDir: "",
    catalogPath: "",
    providersPath: "",
    runtimeDbPath: "",
  };
}

describe("runs route", () => {
  test("validates continuation commands and returns 404 for a missing Run", async () => {
    const invalidApp = await createApp(config());
    const invalid = await invalidApp.handle(
      new Request("http://localhost/v1/runs/run_missing/continue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [] }),
      }),
    );
    expect(invalid.status).toBe(422);

    const db = openRuntimeDatabase(":memory:");
    const app = await createApp(config(), {
      runtimeDatabase: db,
      resolveLanguageModel: () => ({
        languageModel: new MockLanguageModelV3(),
        runtimeContext: {
          provider: { providerId: "openai", modelId: "gpt-4o" },
        },
      }),
    });
    const missing = await app.handle(
      new Request("http://localhost/v1/runs/run_missing/continue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          permission_responses: [{
            permission_id: "perm_missing",
            approved: true,
          }],
        }),
      }),
    );

    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      detail: "Run run_missing not found",
    });
    db.close();
  });

  test("rejects invalid Phase 2 request body", async () => {
    const app = await createApp(config());

    const response = await app.handle(
      new Request("http://localhost/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          response_mode: "stream",
          provider_id: "openai",
          model_id: "gpt-4o",
          text: "Hello",
        }),
      }),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      detail: "Invalid run creation request body",
    });
  });

  test("rejects requests without explicit response mode", async () => {
    const app = await createApp(config());

    const response = await app.handle(
      new Request("http://localhost/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: {
            provider_id: "openai",
            model_id: "gpt-4o",
          },
          input: {
            parts: [
              {
                type: "text",
                text: "Hello",
              },
            ],
          },
        }),
      }),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      detail: "Invalid run creation request body",
    });
  });

  test("does not use Accept header to infer response mode", async () => {
    const app = await createApp(config());

    const response = await app.handle(
      new Request("http://localhost/v1/runs", {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: {
            provider_id: "openai",
            model_id: "gpt-4o",
          },
          input: {
            parts: [
              {
                type: "text",
                text: "Hello",
              },
            ],
          },
        }),
      }),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      detail: "Invalid run creation request body",
    });
  });

  test("streams text and persists final assistant message", async () => {
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeSqliteStore(db);
    const app = await createApp(config(), {
      runtimeDatabase: db,
      resolveLanguageModel: () => ({
        languageModel: new MockLanguageModelV3(),
        runtimeContext: {
          provider: {
            providerId: "openai",
            modelId: "gpt-4o",
          },
        },
      }),
      streamText: streamFromText("Hello from route"),
    });

    const response = await app.handle(
      new Request("http://localhost/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          response_mode: "stream",
          model: {
            provider_id: "openai",
            model_id: "gpt-4o",
          },
          input: {
            parts: [
              {
                type: "text",
                text: "Hello",
              },
            ],
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const conversationId = response.headers.get("x-nexus-conversation-id");
    const runId = response.headers.get("x-nexus-run-id");
    const messageId = response.headers.get("x-nexus-message-id");
    expect(conversationId?.startsWith("conv_")).toBe(true);
    expect(runId?.startsWith("run_")).toBe(true);
    expect(messageId?.startsWith("msg_")).toBe(true);

    await response.text();

    const messages = store.listMessages(conversationId as never);
    expect(messages).toHaveLength(2);
    expect(messages[1].parts[0]).toMatchObject({
      type: "text",
      text: "Hello from route",
    });

    db.close();
  });

  test("replaces an earlier user turn through the public Run endpoint", async () => {
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeSqliteStore(db);
    const app = await createApp(config(), {
      runtimeDatabase: db,
      resolveLanguageModel: () => ({
        languageModel: new MockLanguageModelV3(),
        runtimeContext: {
          provider: {
            providerId: "openai",
            modelId: "gpt-4o",
          },
        },
      }),
      streamText: streamFromText("Response"),
    });
    const send = async (body: Record<string, unknown>) => {
      const response = await app.handle(
        new Request("http://localhost/v1/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      await response.text();
      return response;
    };
    const baseRequest = {
      response_mode: "stream",
      model: {
        provider_id: "openai",
        model_id: "gpt-4o",
      },
    };

    const first = await send({
      ...baseRequest,
      input: { parts: [{ type: "text", text: "First question" }] },
    });
    const conversationId = first.headers.get("x-nexus-conversation-id")!;
    const firstUserMessageId = store.listMessages(conversationId as never)[0]!.id;
    await send({
      ...baseRequest,
      conversation_id: conversationId,
      input: { parts: [{ type: "text", text: "Second question" }] },
    });

    const replacement = await send({
      ...baseRequest,
      conversation_id: conversationId,
      replace_from_message_id: firstUserMessageId,
      input: { parts: [{ type: "text", text: "Rewritten first question" }] },
    });

    expect(replacement.status).toBe(200);
    expect(store.listMessages(conversationId as never).map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(store.listMessages(conversationId as never)[0]?.parts[0]).toMatchObject({
      type: "text",
      text: "Rewritten first question",
    });

    db.close();
  });

  test("generates the first conversation title asynchronously through EventBus", async () => {
    const db = openRuntimeDatabase(":memory:");
    const eventBus = new RuntimeEventBus();
    const store = new RuntimeSqliteStore(db, { eventBus });
    const events: RuntimeEventEnvelope[] = [];
    eventBus.subscribe({ kind: "global" }, (event) => {
      events.push(event);
    });
    const app = await createApp(config(), {
      runtimeDatabase: db,
      runtimeEventBus: eventBus,
      resolveLanguageModel: () => ({
        languageModel: new MockLanguageModelV3(),
        runtimeContext: {
          provider: {
            providerId: "openai",
            modelId: "gpt-4o",
          },
        },
      }),
      streamText: streamFromText("可以从执行计划开始分析。"),
      generateConversationTitleText: async () => ({
        text: "分析订单查询性能",
      }),
    });

    const response = await app.handle(
      new Request("http://localhost/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          response_mode: "stream",
          model: {
            provider_id: "openai",
            model_id: "gpt-4o",
          },
          input: {
            parts: [
              {
                type: "text",
                text: "为什么订单查询越来越慢？请帮我分析",
              },
            ],
          },
        }),
      }),
    );
    const conversationId = response.headers.get("x-nexus-conversation-id");
    await response.text();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (store.getConversation(conversationId as never)?.title === "分析订单查询性能") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(store.getConversation(conversationId as never)?.title).toBe(
      "分析订单查询性能",
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "conversation.updated",
        scope: {
          kind: "conversation",
          conversation_id: conversationId,
        },
      }),
    );

    db.close();
  });

  test("interrupts an active run by run id", async () => {
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeSqliteStore(db);
    let capturedSignal: AbortSignal | undefined;
    const app = await createApp(config(), {
      runtimeDatabase: db,
      resolveLanguageModel: () => ({
        languageModel: new MockLanguageModelV3(),
        runtimeContext: {
          provider: {
            providerId: "openai",
            modelId: "gpt-4o",
          },
        },
      }),
      streamText: (input) => {
        capturedSignal = input.abortSignal;
        void input.onChunk?.({ chunk: { type: "text-delta", text: "Partial route" } });
        return {
          toUIMessageStreamResponse: () =>
            new Response("data: {}\n\n", {
              headers: { "content-type": "text/event-stream" },
            }),
        };
      },
    });

    const runResponse = await app.handle(
      new Request("http://localhost/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          response_mode: "stream",
          model: {
            provider_id: "openai",
            model_id: "gpt-4o",
          },
          input: {
            parts: [{ type: "text", text: "Hello" }],
          },
        }),
      }),
    );
    const runId = runResponse.headers.get("x-nexus-run-id");
    const messageId = runResponse.headers.get("x-nexus-message-id");

    const interruptResponse = await app.handle(
      new Request(`http://localhost/v1/runs/${runId}/interrupt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "user_stop", message: "user requested stop" }),
      }),
    );
    const body = (await interruptResponse.json()) as {
      run_id: string;
      status: string;
      interrupted: boolean;
      interrupt: { reason: string; message: string };
    };

    expect(interruptResponse.status).toBe(200);
    expect(body).toMatchObject({
      run_id: runId,
      status: "interrupted",
      interrupted: true,
      interrupt: {
        reason: "user_stop",
        message: "user requested stop",
      },
    });
    expect(capturedSignal?.aborted).toBe(true);
    expect(store.getRun(runId as never)?.status).toBe("interrupted");
    expect(store.getMessage(messageId as never)?.parts).toEqual([
      expect.objectContaining({
        type: "text",
        text: "Partial route",
      }),
    ]);

    db.close();
  });

  test("accepts agent_mode and persists it as runtime agentMode", async () => {
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeSqliteStore(db);
    const app = await createApp(config(), {
      runtimeDatabase: db,
      resolveLanguageModel: () => ({
        languageModel: new MockLanguageModelV3(),
        runtimeContext: {
          provider: {
            providerId: "openai",
            modelId: "gpt-4o",
            supportsTools: false,
          },
        },
      }),
      streamText: streamFromText("Hello from agent"),
    });

    const response = await app.handle(
      new Request("http://localhost/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          response_mode: "stream",
          agent_mode: "agent",
          model: {
            provider_id: "openai",
            model_id: "gpt-4o",
          },
          input: {
            parts: [
              {
                type: "text",
                text: "Hello",
              },
            ],
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    await response.text();

    const runId = response.headers.get("x-nexus-run-id");
    expect(store.getRun(runId as never)?.agentMode).toBe("agent");

    db.close();
  });

  test("exposes only Snapshot active Tools through the Core AI SDK adapter", async () => {
    const db = openRuntimeDatabase(":memory:");
    let capturedToolNames: string[] | undefined;
    const app = await createApp(config(), {
      runtimeDatabase: db,
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
      streamText: (input) => {
        capturedToolNames = input.tools ? Object.keys(input.tools) : undefined;
        void input.onFinish?.({ finishReason: "stop" });
        return {
          toUIMessageStreamResponse: () =>
            new Response("data: {}\n\n", {
              headers: { "content-type": "text/event-stream" },
            }),
        };
      },
    });

    const response = await app.handle(
      new Request("http://localhost/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          response_mode: "stream",
          agent_mode: "agent",
          model: {
            provider_id: "openai",
            model_id: "gpt-4o",
          },
          input: {
            parts: [
              {
                type: "text",
                text: "Fetch https://example.com",
              },
            ],
          },
        }),
      }),
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(capturedToolNames).toEqual([
      "np__system__current_time",
      "np__web__fetch",
      "np__web__ping",
    ]);

    db.close();
  });

  test("rejects a syntactically valid but missing conversation_id", async () => {
    const db = openRuntimeDatabase(":memory:");
    const app = await createApp(config(), {
      runtimeDatabase: db,
      resolveLanguageModel: () => ({
        languageModel: new MockLanguageModelV3(),
        runtimeContext: {
          provider: {
            providerId: "openai",
            modelId: "gpt-4o",
          },
        },
      }),
      streamText: streamFromText("should not run"),
    });

    const response = await app.handle(
      new Request("http://localhost/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          response_mode: "stream",
          conversation_id: "conv_missing123",
          model: {
            provider_id: "openai",
            model_id: "gpt-4o",
          },
          input: {
            parts: [
              {
                type: "text",
                text: "Hello",
              },
            ],
          },
        }),
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      detail: "Conversation conv_missing123 not found",
    });

    db.close();
  });

  test("rejects old mode field", async () => {
    const app = await createApp(config());

    const response = await app.handle(
      new Request("http://localhost/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          response_mode: "stream",
          mode: "ask",
          model: {
            provider_id: "openai",
            model_id: "gpt-4o",
          },
          input: {
            parts: [
              {
                type: "text",
                text: "Hello",
              },
            ],
          },
        }),
      }),
    );

    expect(response.status).toBe(422);
  });

  test("rejects internal Runtime controls in public run creation body", async () => {
    const app = await createApp(config());

    const response = await app.handle(
      new Request("http://localhost/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          response_mode: "stream",
          model: {
            provider_id: "openai",
            model_id: "gpt-4o",
          },
          input: {
            parts: [
              {
                type: "text",
                text: "Hello",
              },
            ],
          },
          system: "Override system prompt",
        }),
      }),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      detail: "Invalid run creation request body",
    });
  });

  test("returns 503 when runtime store is unavailable", async () => {
    const app = await createApp(config(), {
      resolveLanguageModel: () => ({
        languageModel: new MockLanguageModelV3(),
        runtimeContext: { provider: { providerId: "openai", modelId: "gpt-4o" } },
      }),
      streamText: streamFromText("Hello"),
    });

    const response = await app.handle(
      new Request("http://localhost/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          response_mode: "stream",
          model: {
            provider_id: "openai",
            model_id: "gpt-4o",
          },
          input: {
            parts: [
              {
                type: "text",
                text: "Hello",
              },
            ],
          },
        }),
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      detail: "Runtime Store not initialized",
    });
  });

  test("publishes live EventBus envelopes while executing a run", async () => {
    const db = openRuntimeDatabase(":memory:");
    const eventBus = new RuntimeEventBus();
    const received: RuntimeEventEnvelope[] = [];
    eventBus.subscribe({ kind: "global" }, (event) => {
      received.push(event);
    });

    const app = await createApp(config(), {
      runtimeDatabase: db,
      runtimeEventBus: eventBus,
      resolveLanguageModel: () => ({
        languageModel: new MockLanguageModelV3(),
        runtimeContext: {
          provider: {
            providerId: "openai",
            modelId: "gpt-4o",
          },
        },
      }),
      streamText: streamFromText("Hello from live events"),
    });

    const response = await app.handle(
      new Request("http://localhost/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          response_mode: "stream",
          model: {
            provider_id: "openai",
            model_id: "gpt-4o",
          },
          input: {
            parts: [
              {
                type: "text",
                text: "Hello",
              },
            ],
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    await response.text();

    expect(received.map((event) => event.type)).toContain("run.updated");
    expect(received.map((event) => event.type)).toContain("message.updated");
    expect(received.every((event) => event.id.startsWith("evt_"))).toBe(true);

    db.close();
  });
});
