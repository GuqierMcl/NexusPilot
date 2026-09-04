import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import {
  RuntimeEventBus,
  RuntimeSqliteStore,
  type Conversation,
  type Message,
  type Permission,
  type Run,
  type RuntimeEventEnvelope,
} from "../src/runtime";
import { openRuntimeDatabase } from "../src/storage/runtime-database";

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

async function createAppWithHistoryFixtures() {
  const db = openRuntimeDatabase(":memory:");
  const store = new RuntimeSqliteStore(db);

  const conversation: Conversation = {
    id: "conv_history",
    title: "Recovered conversation",
    version: "1",
    status: { type: "idle" },
    time: { created: 1, updated: 10 },
  };
  const run: Run = {
    id: "run_history",
    conversationId: conversation.id,
    agentMode: "ask",
    providerId: "openai",
    modelId: "gpt-4o",
    status: "completed",
    input: { messageIds: ["msg_user"] },
    output: { messageId: "msg_assistant", partIds: ["part_answer"] },
    limits: { maxSteps: 50, maxToolCalls: 300 },
    time: { created: 2, started: 3, completed: 4 },
  };
  const userMessage: Message = {
    id: "msg_user",
    conversationId: conversation.id,
    role: "user",
    agentMode: "ask",
    model: { providerId: "openai", modelId: "gpt-4o" },
    parts: [
      {
        id: "part_user",
        conversationId: conversation.id,
        messageId: "msg_user",
        type: "text",
        text: "Hello",
        time: { created: 2 },
      },
    ],
    time: { created: 2, completed: 2 },
  };
  const assistantMessage: Message = {
    id: "msg_assistant",
    conversationId: conversation.id,
    role: "assistant",
    runId: run.id,
    parentId: userMessage.id,
    providerId: "openai",
    modelId: "gpt-4o",
    agentMode: "ask",
    status: { type: "complete", reason: "stop" },
    parts: [
      {
        id: "part_answer",
        conversationId: conversation.id,
        messageId: "msg_assistant",
        type: "text",
        text: "Recovered answer",
        time: { start: 3, end: 4 },
      },
    ],
    time: { created: 3, completed: 4 },
  };

  store.saveConversation(conversation);
  store.saveRun(run);
  store.saveMessage(userMessage);
  store.saveMessage(assistantMessage);
  const permission: Permission = {
    id: "perm_history",
    conversationId: conversation.id,
    runId: run.id,
    messageId: assistantMessage.id,
    toolCallId: "tool_history",
    status: "pending",
    toolId: "sql.execute",
    title: "执行 SQL",
    risk: {
      level: "critical",
      reversible: false,
      sideEffects: ["destructive"],
    },
    confirmation: {
      level: "strong",
      prompt: "确认在 Production MySQL 执行",
    },
    presentation: {
      target: {
        connectionName: "Production",
        driver: "mysql",
        database: "app",
      },
      riskReasons: ["无法精确分析原始 SQL"],
      sql: {
        text: "DROP TABLE users",
        analysisStatus: "uncertain",
        statementClass: "DDL",
        identifiedTargets: ["app.users"],
      },
      timeoutMs: 30_000,
      outcomeWarnings: ["可能造成数据丢失"],
    },
    adapter: {
      aiSdkApprovalId: "approval_history",
      aiSdkToolCallId: "call_history",
    },
    createdAt: 4,
  };
  store.savePermission(permission);

  const app = await createApp(config(), { runtimeDatabase: db });
  return { app, db, store, run, permission };
}

describe("runtime history routes", () => {
  test("creates an explicit empty Runtime conversation when requested", async () => {
    const db = openRuntimeDatabase(":memory:");
    const eventBus = new RuntimeEventBus();
    const receivedEvents: RuntimeEventEnvelope[] = [];
    eventBus.subscribe({ kind: "global" }, (event) => {
      receivedEvents.push(event);
    });
    const app = await createApp(config(), {
      runtimeDatabase: db,
      runtimeEventBus: eventBus,
    });

    const response = await app.handle(
      new Request("http://localhost/v1/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          metadata: {
            client_thread_id: "__LOCALID_thread",
          },
        }),
      }),
    );
    const body = await response.json() as {
      conversation: {
        id: string;
        title: string;
        status: { type: string };
        metadata: Record<string, unknown>;
      };
    };

    expect(response.status).toBe(201);
    expect(body.conversation.id.startsWith("conv_")).toBe(true);
    expect(body.conversation).toMatchObject({
      title: "新对话",
      status: { type: "idle" },
      metadata: {
        client_thread_id: "__LOCALID_thread",
      },
    });

    const messagesResponse = await app.handle(
      new Request(`http://localhost/v1/conversations/${body.conversation.id}/messages?format=ai_sdk`),
    );
    const messagesBody = await messagesResponse.json() as { messages: unknown[] };
    expect(messagesResponse.status).toBe(200);
    expect(messagesBody.messages).toEqual([]);

    expect(receivedEvents).toEqual([
      expect.objectContaining({
        type: "conversation.created",
        scope: {
          kind: "conversation",
          conversation_id: body.conversation.id,
        },
      }),
    ]);

    db.close();
  });

  test("rejects invalid empty conversation creation bodies", async () => {
    const db = openRuntimeDatabase(":memory:");
    const app = await createApp(config(), { runtimeDatabase: db });

    const extraPropertyResponse = await app.handle(
      new Request("http://localhost/v1/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "New conversation",
          limits: {},
        }),
      }),
    );
    expect(extraPropertyResponse.status).toBe(422);

    const invalidMetadataResponse = await app.handle(
      new Request("http://localhost/v1/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          metadata: [],
        }),
      }),
    );
    expect(invalidMetadataResponse.status).toBe(422);

    db.close();
  });

  test("lists conversations for recovery", async () => {
    const { app, db, store } = await createAppWithHistoryFixtures();
    store.saveConversation({
      id: "conv_empty",
      title: "New conversation",
      version: "1",
      status: { type: "idle" },
      time: { created: 20, updated: 20 },
      metadata: {
        client_thread_id: "__LOCALID_empty",
      },
    });

    const response = await app.handle(new Request("http://localhost/v1/conversations"));
    const body = await response.json() as { conversations: Array<{ id: string; title: string }> };

    expect(response.status).toBe(200);
    expect(body.conversations).toEqual([
      expect.objectContaining({
        id: "conv_history",
        title: "Recovered conversation",
      }),
    ]);

    db.close();
  });

  test("gets a projected conversation summary by id", async () => {
    const { app, db, store } = await createAppWithHistoryFixtures();

    store.saveConversation({
      id: "conv_busy",
      title: "Busy conversation",
      version: "1",
      status: { type: "busy", runId: "run_history" },
      time: { created: 1, updated: 10 },
    });

    const response = await app.handle(
      new Request("http://localhost/v1/conversations/conv_busy"),
    );
    const body = await response.json() as {
      conversation: { id: string; title: string; active_run_id?: string; version?: string };
    };

    expect(response.status).toBe(200);
    expect(body.conversation).toMatchObject({
      id: "conv_busy",
      title: "Busy conversation",
      active_run_id: "run_history",
    });
    expect(body.conversation.version).toBeUndefined();

    db.close();
  });

  test("returns no-op when interrupting a conversation without an active run", async () => {
    const { app, db } = await createAppWithHistoryFixtures();

    const response = await app.handle(
      new Request("http://localhost/v1/conversations/conv_history/interrupt-active-run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "user_stop" }),
      }),
    );
    const body = (await response.json()) as {
      conversation_id: string;
      run_id: string | null;
      interrupted: boolean;
      reason?: string;
    };

    expect(response.status).toBe(200);
    expect(body).toEqual({
      conversation_id: "conv_history",
      run_id: null,
      interrupted: false,
      reason: "no_active_run",
    });

    db.close();
  });

  test("returns runtime messages by default and projected messages on request", async () => {
    const { app, db } = await createAppWithHistoryFixtures();

    const runtimeResponse = await app.handle(
      new Request("http://localhost/v1/conversations/conv_history/messages"),
    );
    const runtimeBody = await runtimeResponse.json() as {
      format: string;
      messages: Array<{ id: string; parts: Array<{ type: string; text?: string }> }>;
    };

    expect(runtimeResponse.status).toBe(200);
    expect(runtimeBody.format).toBe("runtime");
    expect(runtimeBody.messages[1].parts[0]).toMatchObject({
      type: "text",
      text: "Recovered answer",
    });

    const uiResponse = await app.handle(
      new Request("http://localhost/v1/conversations/conv_history/messages?format=ui"),
    );
    const uiBody = await uiResponse.json() as {
      format: string;
      messages: Array<{ id: string; role: string; parts: Array<{ type: string; text?: string }> }>;
    };

    expect(uiResponse.status).toBe(200);
    expect(uiBody.format).toBe("ui");
    expect(uiBody.messages[1]).toMatchObject({
      id: "msg_assistant",
      role: "assistant",
      parts: [{ type: "text", text: "Recovered answer" }],
    });

    const aiSdkResponse = await app.handle(
      new Request("http://localhost/v1/conversations/conv_history/messages?format=ai_sdk"),
    );
    const aiSdkBody = await aiSdkResponse.json() as {
      format: string;
      messages: Array<{ id: string; role: string; parts: Array<{ type: string; text?: string }> }>;
    };

    expect(aiSdkResponse.status).toBe(200);
    expect(aiSdkBody.format).toBe("ai_sdk");
    expect(aiSdkBody.messages[1]).toMatchObject({
      id: "msg_assistant",
      role: "assistant",
      parts: [{ type: "text", text: "Recovered answer" }],
    });

    db.close();
  });

  test("restores the exact Provider error from a reopened SQLite Snapshot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexuspilot-runtime-error-recovery-"));
    const databasePath = join(directory, "runtime.sqlite3");
    let initialDb: ReturnType<typeof openRuntimeDatabase> | null = null;
    let reopenedDb: ReturnType<typeof openRuntimeDatabase> | null = null;
    const errorMessage =
      "  maximum context length exceeded\nrequest  id: snapshot_1  ";
    const error = {
      name: "ContextLengthError",
      data: {
        message: errorMessage,
        statusCode: 400,
        isRetryable: false,
      },
    };

    try {
      initialDb = openRuntimeDatabase(databasePath);
      const initialStore = new RuntimeSqliteStore(initialDb);
      initialStore.saveConversation({
        id: "conv_error_recovery",
        title: "Recovered Provider error",
        version: "1",
        status: { type: "error", error },
        time: { created: 1, updated: 4 },
      });
      initialStore.saveRun({
        id: "run_error_recovery",
        conversationId: "conv_error_recovery",
        assistantMessageId: "msg_error_recovery",
        agentMode: "ask",
        providerId: "openai",
        modelId: "gpt-4o",
        status: "failed",
        input: { messageIds: ["msg_error_user"] },
        output: {
          messageId: "msg_error_recovery",
          partIds: ["part_error_partial"],
        },
        limits: { maxSteps: 50, maxToolCalls: 300 },
        finish: "error",
        error,
        time: { created: 2, started: 2, completed: 4 },
      });
      initialStore.saveMessage({
        id: "msg_error_user",
        conversationId: "conv_error_recovery",
        role: "user",
        agentMode: "ask",
        model: { providerId: "openai", modelId: "gpt-4o" },
        parts: [{
          id: "part_error_user",
          conversationId: "conv_error_recovery",
          messageId: "msg_error_user",
          type: "text",
          text: "Trigger a Provider error",
          time: { created: 2 },
        }],
        time: { created: 2, completed: 2 },
      });
      initialStore.saveMessage({
        id: "msg_error_recovery",
        conversationId: "conv_error_recovery",
        role: "assistant",
        runId: "run_error_recovery",
        parentId: "msg_error_user",
        providerId: "openai",
        modelId: "gpt-4o",
        agentMode: "ask",
        status: { type: "error", error },
        parts: [{
          id: "part_error_partial",
          conversationId: "conv_error_recovery",
          messageId: "msg_error_recovery",
          type: "text",
          text: "Partial before failure",
          time: { start: 3, end: 4 },
        }],
        finish: "error",
        error,
        time: { created: 3, completed: 4 },
      });
      initialDb.close();
      initialDb = null;

      reopenedDb = openRuntimeDatabase(databasePath);
      const app = await createApp(config(), { runtimeDatabase: reopenedDb });
      const response = await app.handle(new Request(
        "http://localhost/v1/conversations/conv_error_recovery/messages?format=ai_sdk",
      ));
      const body = await response.json() as {
        format: string;
        messages: Array<{
          id: string;
          role: string;
          parts: Array<{ type: string; text?: string }>;
          metadata?: {
            custom?: {
              nexus?: {
                status?: {
                  type?: string;
                  error?: {
                    name?: string;
                    data?: { message?: string; statusCode?: number; isRetryable?: boolean };
                  };
                };
              };
            };
          };
        }>;
      };
      const recovered = body.messages.find(
        (message) => message.id === "msg_error_recovery",
      );

      expect(response.status).toBe(200);
      expect(body.format).toBe("ai_sdk");
      expect(recovered).toMatchObject({
        id: "msg_error_recovery",
        role: "assistant",
        parts: [{ type: "text", text: "Partial before failure" }],
        metadata: {
          custom: {
            nexus: {
              status: {
                type: "error",
                error: {
                  name: "ContextLengthError",
                  data: {
                    message: errorMessage,
                    statusCode: 400,
                    isRetryable: false,
                  },
                },
              },
            },
          },
        },
      });
      expect(
        recovered?.metadata?.custom?.nexus?.status?.error?.data?.message,
      ).toBe(errorMessage);
    } finally {
      initialDb?.close();
      reopenedDb?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("gets run detail, run events, and run traces", async () => {
    const { app, db, store, run } = await createAppWithHistoryFixtures();

    store.appendEvent({
      id: "evt_history",
      type: "run.updated",
      properties: {
        info: run,
      },
      time: 5,
    });
    store.appendTrace({
      id: "trace_history",
      conversationId: "conv_history",
      runId: "run_history",
      type: "stream.finished",
      level: "info",
      time: 6,
      payload: { finish: "stop" },
    });

    const runResponse = await app.handle(new Request("http://localhost/v1/runs/run_history"));
    const runBody = await runResponse.json() as { run: { id: string; conversation_id: string } };
    expect(runResponse.status).toBe(200);
    expect(runBody.run).toMatchObject({
      id: "run_history",
      conversation_id: "conv_history",
    });

    const eventResponse = await app.handle(
      new Request("http://localhost/v1/runs/run_history/events"),
    );
    const eventBody = await eventResponse.json() as { events: Array<{ id: string }> };
    expect(eventResponse.status).toBe(200);
    expect(eventBody.events.map((event) => event.id)).toEqual(["evt_history"]);

    const traceResponse = await app.handle(
      new Request("http://localhost/v1/runs/run_history/traces"),
    );
    const traceBody = await traceResponse.json() as { traces: Array<{ id: string }> };
    expect(traceResponse.status).toBe(200);
    expect(traceBody.traces.map((trace) => trace.id)).toEqual(["trace_history"]);

    db.close();
  });

  test("recovers a pending Permission snapshot by canonical and live approval ids", async () => {
    const { app, db } = await createAppWithHistoryFixtures();

    for (const path of [
      "/v1/permissions/perm_history",
      "/v1/tool-approvals/approval_history/permission",
    ]) {
      const response = await app.handle(new Request(`http://localhost${path}`));
      expect(response.status).toBe(200);
      const body = await response.json() as {
        permission: {
          id: string;
          confirmation: { level: string; prompt?: string };
          presentation?: { sql?: { text: string }; target?: { driver?: string } };
        };
      };
      expect(body.permission).toMatchObject({
        id: "perm_history",
        confirmation: {
          level: "strong",
          prompt: "确认在 Production MySQL 执行",
        },
        presentation: {
          target: { driver: "mysql" },
          sql: { text: "DROP TABLE users" },
        },
      });
    }

    db.close();
  });

  test("returns 404 for missing conversation and run history resources", async () => {
    const { app, db } = await createAppWithHistoryFixtures();

    const conversationResponse = await app.handle(
      new Request("http://localhost/v1/conversations/conv_missing"),
    );
    expect(conversationResponse.status).toBe(404);

    const runResponse = await app.handle(new Request("http://localhost/v1/runs/run_missing"));
    expect(runResponse.status).toBe(404);

    db.close();
  });

  test("returns 422 for invalid history query parameters", async () => {
    const { app, db } = await createAppWithHistoryFixtures();

    const limitResponse = await app.handle(
      new Request("http://localhost/v1/conversations?limit=zero"),
    );
    expect(limitResponse.status).toBe(422);

    const formatResponse = await app.handle(
      new Request("http://localhost/v1/conversations/conv_history/messages?format=bad"),
    );
    expect(formatResponse.status).toBe(422);

    db.close();
  });
});
