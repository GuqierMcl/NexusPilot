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
import { computeContextLineageHash } from "../src/runtime/context/planner";
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

async function createAppWithHistoryFixtures(databasePath = ":memory:") {
  const db = openRuntimeDatabase(databasePath);
  const store = new RuntimeSqliteStore(db);

  const conversation: Conversation = {
    id: "conv_history",
    title: "Recovered conversation",
    version: "1",
    status: { type: "idle" },
    activeHeadRunId: "run_history",
    revision: 1,
    time: { created: 1, updated: 10 },
  };
  const run: Run = {
    id: "run_history",
    conversationId: conversation.id,
    parentMessageId: "msg_user",
    assistantMessageId: "msg_assistant",
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

async function createAppWithBranchedHistoryFixtures() {
  const db = openRuntimeDatabase(":memory:");
  const store = new RuntimeSqliteStore(db);
  const conversation: Conversation = {
    id: "conv_branched_history",
    title: "Branched history",
    version: "1",
    status: { type: "idle" },
    activeHeadRunId: "run_e",
    revision: 5,
    time: { created: 1, updated: 50 },
  };
  store.saveConversation(conversation);

  const saveRunPair = (input: {
    runId: Run["id"];
    label: string;
    created: number;
    parentRunId?: Run["id"];
    supersedesRunId?: Run["id"];
  }): void => {
    const userMessageId = `msg_user_${input.label.toLowerCase()}` as Message["id"];
    const assistantMessageId = `msg_assistant_${input.label.toLowerCase()}` as Message["id"];
    const run: Run = {
      id: input.runId,
      conversationId: conversation.id,
      parentRunId: input.parentRunId,
      supersedesRunId: input.supersedesRunId,
      parentMessageId: userMessageId,
      assistantMessageId,
      agentMode: "ask",
      providerId: "openai",
      modelId: "gpt-4o",
      status: "completed",
      input: {
        messageIds: [userMessageId],
        prompt: {
          version: "internal-prompt",
          blockIds: ["must-not-leak"],
          warnings: [],
        },
      },
      output: { messageId: assistantMessageId, partIds: [] },
      limits: { maxSteps: 1, maxToolCalls: 0 },
      finish: "stop",
      time: { created: input.created, completed: input.created + 1 },
      metadata: { internalOnly: `secret-${input.label}` },
    };
    const userMessage: Message = {
      id: userMessageId,
      conversationId: conversation.id,
      role: "user",
      agentMode: "ask",
      parts: [{
        id: `part_user_${input.label.toLowerCase()}` as never,
        conversationId: conversation.id,
        messageId: userMessageId,
        type: "text",
        text: `Question ${input.label}`,
        time: { created: input.created },
      }],
      time: { created: input.created, completed: input.created },
    };
    const assistantMessage: Message = {
      id: assistantMessageId,
      conversationId: conversation.id,
      role: "assistant",
      runId: input.runId,
      parentId: userMessageId,
      providerId: "openai",
      modelId: "gpt-4o",
      agentMode: "ask",
      status: { type: "complete", reason: "stop" },
      parts: [],
      finish: "stop",
      time: { created: input.created + 1, completed: input.created + 1 },
    };
    store.saveMessage(userMessage);
    store.saveRun(run);
    store.saveMessage(assistantMessage);
  };

  saveRunPair({ runId: "run_a", label: "A", created: 10 });
  saveRunPair({ runId: "run_b", label: "B", created: 20, parentRunId: "run_a" });
  saveRunPair({ runId: "run_c", label: "C", created: 30, parentRunId: "run_b" });
  saveRunPair({ runId: "run_d", label: "D", created: 40, parentRunId: "run_c" });
  saveRunPair({
    runId: "run_e",
    label: "E",
    created: 50,
    parentRunId: "run_b",
    supersedesRunId: "run_c",
  });

  const app = await createApp(config(), { runtimeDatabase: db });
  return { app, db };
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
      revision: 0,
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
      revision: 1,
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
      conversation_id: string;
      active_head_run_id?: string;
      revision: number;
      view: string;
      format: string;
      messages: Array<{ id: string; parts: Array<{ type: string; text?: string }> }>;
    };

    expect(runtimeResponse.status).toBe(200);
    expect(runtimeBody).toMatchObject({
      conversation_id: "conv_history",
      active_head_run_id: "run_history",
      revision: 1,
      view: "active",
    });
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

  test("restores the durable next-turn forecast without substituting Provider input or output reserve", async () => {
    const { app, db, store } = await createAppWithHistoryFixtures();
    store.saveContextUsage({
      id: "ctxuse_history",
      conversationId: "conv_history",
      runId: "run_history",
      requestIndex: 0,
      providerId: "openai",
      modelId: "gpt-4o",
      contextWindow: 1000,
      estimatedInputTokens: 440,
      estimateSource: "estimate",
      reservedOutputTokens: 120,
      view: "raw",
      breakdown: {
        rawTokens: 400,
        checkpointTokens: 0,
        safetyStateTokens: 0,
        systemPromptTokens: 20,
        toolSchemaTokens: 20,
      },
      providerObservation: { source: "provider", inputTokens: 430 },
      nextTurnForecast: {
        conversationId: "conv_history",
        sourceHeadRunId: "run_history",
        sourceConversationRevision: 1,
        providerId: "openai",
        modelId: "gpt-4o",
        contextWindow: 1000,
        estimatedInputTokens: 480,
        view: "raw",
        breakdown: {
          rawTokens: 440,
          checkpointTokens: 0,
          safetyStateTokens: 0,
          systemPromptTokens: 20,
          toolSchemaTokens: 20,
        },
        estimatorVersion: "test",
        policyVersion: "test",
        checkpointFormatVersion: "test",
        reason: "append",
      },
      estimatorVersion: "test",
      policyVersion: "test",
      checkpointFormatVersion: "test",
      time: { created: 10 },
    });

    const response = await app.handle(new Request(
      "http://localhost/v1/conversations/conv_history/messages?format=ai_sdk",
    ));
    const body = await response.json() as {
      active_head_run_id?: string;
      revision: number;
      messages: Array<{ id: string; metadata?: Record<string, unknown> }>;
    };
    const assistant = body.messages.find((message) => message.id === "msg_assistant");

    expect(response.status).toBe(200);
    expect(body.active_head_run_id).toBe("run_history");
    expect(body.revision).toBe(1);
    expect(assistant?.metadata).toMatchObject({
      custom: {
        nexus: {
          contextUsage: {
            contextWindow: 1000,
            estimatedInputTokens: 480,
            providerInputTokens: 430,
            reservedOutputTokens: 120,
            activeTokens: 480,
            source: "estimate",
            view: "raw",
            forecastReason: "append",
          },
        },
      },
    });
    expect(body.messages.find((message) => message.id === "msg_user")?.metadata)
      .not.toMatchObject({ custom: { nexus: { contextUsage: expect.anything() } } });

    db.close();
  });

  test("restores a failed compaction marker without a checkpoint or diagnostic payload", async () => {
    const { app, db, store } = await createAppWithHistoryFixtures();
    store.appendTrace({
      id: "trace_compaction_preparing",
      conversationId: "conv_history",
      runId: "run_history",
      type: "context.compaction.preparing",
      level: "info",
      time: 20,
      payload: {
        trigger: "auto_pre_turn",
        requestIndex: 0,
        sourceHeadRunId: "run_history",
        sourceConversationRevision: 1,
        beforeEstimatedInputTokens: 900,
      },
    });
    store.appendTrace({
      id: "trace_compaction_failed",
      conversationId: "conv_history",
      runId: "run_history",
      type: "context.compaction.failed",
      level: "error",
      time: 21,
      payload: {
        trigger: "auto_pre_turn",
        requestIndex: 0,
        sourceHeadRunId: "run_history",
        sourceConversationRevision: 1,
        beforeEstimatedInputTokens: 900,
        errorName: "ContextSummaryValidationError",
        finishReason: "length",
        outputTokens: 2048,
        textTokens: 0,
        reasoningTokens: 2048,
      },
    });

    const response = await app.handle(new Request(
      "http://localhost/v1/conversations/conv_history/messages?format=ai_sdk",
    ));
    const body = await response.json() as {
      messages: Array<{
        id: string;
        metadata?: { custom?: { nexus?: { compaction?: unknown } } };
      }>;
    };
    const marker = body.messages.find((message) => message.id === "msg_assistant")
      ?.metadata?.custom?.nexus?.compaction;

    expect(response.status).toBe(200);
    expect(marker).toEqual({
      trigger: "auto_pre_turn",
      createdAt: 21,
      beforeTokens: 900,
      status: "failed",
    });
    expect(JSON.stringify(marker)).not.toMatch(
      /ContextSummaryValidationError|length|2048|reasoning|errorName/i,
    );
    expect(store.listContextCheckpoints("conv_history")).toEqual([]);
    db.close();
  });

  test("converges an abandoned preparing marker after the owning Assistant is terminal", async () => {
    const { app, db, store } = await createAppWithHistoryFixtures();
    store.appendTrace({
      id: "trace_compaction_abandoned_preparing",
      conversationId: "conv_history",
      runId: "run_history",
      type: "context.compaction.preparing",
      level: "info",
      time: 20,
      payload: {
        trigger: "auto_pre_turn",
        requestIndex: 0,
        sourceHeadRunId: "run_history",
        sourceConversationRevision: 1,
        beforeEstimatedInputTokens: 900,
      },
    });

    const response = await app.handle(new Request(
      "http://localhost/v1/conversations/conv_history/messages?format=ai_sdk",
    ));
    const body = await response.json() as {
      messages: Array<{
        id: string;
        metadata?: { custom?: { nexus?: { compaction?: unknown } } };
      }>;
    };
    const marker = body.messages.find((message) => message.id === "msg_assistant")
      ?.metadata?.custom?.nexus?.compaction;

    expect(response.status).toBe(200);
    expect(marker).toEqual({
      trigger: "auto_pre_turn",
      createdAt: 20,
      beforeTokens: 900,
      status: "failed",
    });
    expect(store.listContextCheckpoints("conv_history")).toEqual([]);
    db.close();
  });

  test("reopens the checkpoint-producing marker unchanged after later usage selects it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexuspilot-history-context-"));
    const databasePath = join(directory, "runtime.sqlite");
    let db: ReturnType<typeof openRuntimeDatabase> | undefined;
    try {
      const first = await createAppWithHistoryFixtures(databasePath);
      db = first.db;
      const budget = {
        providerId: "openai",
        modelId: "gpt-4o",
        contextWindow: 1000,
        reservedOutputTokens: 120,
        safetyMarginTokens: 20,
        systemPromptTokens: 20,
        toolSchemaTokens: 20,
        hardInputBudget: 840,
        softTriggerTokens: 700,
        targetTokens: 500,
        rawHistoryTokens: 820,
        checkpointTokens: 340,
        safetyStateTokens: 20,
        estimatedInputTokens: 400,
      };
      const checkpoint = {
        id: "ckpt_history",
        conversationId: "conv_history",
        coverageThroughRunId: "run_history",
        sourceHeadRunId: "run_history",
        sourceConversationRevision: 1,
        lineageHash: computeContextLineageHash([first.run], first.run.id),
        sourceStateHash: `sha256:${"2".repeat(64)}`,
        safetyStateHash: `sha256:${"3".repeat(64)}`,
        trigger: "auto_pre_turn",
        formatVersion: "1",
        compatibility: { kind: "provider-neutral-text", version: 1 },
        generatedBy: { providerId: "openai", modelId: "gpt-4o" },
        summary: "MUST_NOT_APPEAR",
        safetyStateVersion: "1",
        budget,
        time: { created: 100 },
      };
      const plan = (requestIndex: number) => ({
        id: `ctxplan_history_${requestIndex}`,
        conversationId: "conv_history",
        runId: "run_history",
        requestIndex,
        sourceHeadRunId: "run_history",
        sourceConversationRevision: 1,
        trigger: "auto_pre_turn",
        providerId: "openai",
        modelId: "gpt-4o",
        view: "checkpoint",
        reason: "checkpoint_selected",
        checkpointId: "ckpt_history",
        lineageRunIds: ["run_history"],
        rawRunIds: [],
        safetyState: {
          version: "1",
          conversationId: "conv_history",
          effects: [],
          permissions: [],
          hash: `sha256:${"4".repeat(64)}`,
        },
        budget: { ...budget, estimatedInputTokens: requestIndex === 1 ? 400 : 480 },
        requestHash: `sha256:${String(requestIndex).repeat(64)}`,
        viewHash: `sha256:${String(requestIndex + 2).repeat(64)}`,
        time: { created: 100 + requestIndex },
      });
      const usage = (requestIndex: number) => ({
        id: `ctxuse_history_${requestIndex}`,
        conversationId: "conv_history",
        runId: "run_history",
        requestIndex,
        providerId: "openai",
        modelId: "gpt-4o",
        contextWindow: 1000,
        estimatedInputTokens: requestIndex === 1 ? 400 : 480,
        estimateSource: "estimate",
        reservedOutputTokens: 120,
        view: "checkpoint",
        checkpointId: "ckpt_history",
        breakdown: {
          rawTokens: 0,
          checkpointTokens: requestIndex === 1 ? 340 : 420,
          safetyStateTokens: 20,
          systemPromptTokens: 20,
          toolSchemaTokens: 20,
        },
        estimatorVersion: "test",
        policyVersion: "test",
        checkpointFormatVersion: "1",
        time: { created: 110 + requestIndex },
      });
      db.query(`INSERT INTO runtime_context_checkpoints (
        id, conversation_id, coverage_through_run_id, source_head_run_id,
        source_conversation_revision, format_version, compatibility_kind,
        compatibility_version, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          checkpoint.id,
          checkpoint.conversationId,
          checkpoint.coverageThroughRunId,
          checkpoint.sourceHeadRunId,
          checkpoint.sourceConversationRevision,
          checkpoint.formatVersion,
          checkpoint.compatibility.kind,
          checkpoint.compatibility.version,
          JSON.stringify(checkpoint),
          checkpoint.time.created,
        );
      for (const requestIndex of [1, 2]) {
        const durablePlan = plan(requestIndex);
        const durableUsage = usage(requestIndex);
        db.query(`INSERT INTO runtime_context_plans (
          id, conversation_id, run_id, request_index, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(
            durablePlan.id,
            durablePlan.conversationId,
            durablePlan.runId,
            durablePlan.requestIndex,
            JSON.stringify(durablePlan),
            durablePlan.time.created,
          );
        db.query(`INSERT INTO runtime_context_usage (
          id, conversation_id, run_id, request_index, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(
            durableUsage.id,
            durableUsage.conversationId,
            durableUsage.runId,
            durableUsage.requestIndex,
            JSON.stringify(durableUsage),
            durableUsage.time.created,
          );
      }
      first.store.appendTrace({
        id: "trace_history_recovered",
        conversationId: "conv_history",
        runId: "run_history",
        type: "context.overflow.recovered",
        level: "warn",
        time: 150,
        payload: {
          error: {
            name: "ContextWindowExceededError",
            data: { message: "context window exceeded" },
          },
          requestIndex: 1,
          sourceHeadRunId: "run_history",
          sourceConversationRevision: 1,
          checkpointId: "ckpt_history",
          beforeEstimatedInputTokens: 900,
          afterEstimatedInputTokens: 400,
        },
      });
      const readMarker = async (app: Awaited<ReturnType<typeof createApp>>) => {
        const response = await app.handle(new Request(
          "http://localhost/v1/conversations/conv_history/messages?format=ai_sdk",
        ));
        const body = await response.json() as {
          messages: Array<{ id: string; metadata?: { custom?: { nexus?: { compaction?: unknown } } } }>;
        };
        return body.messages.find((message) => message.id === "msg_assistant")
          ?.metadata?.custom?.nexus?.compaction;
      };
      const producingRequestMarker = {
        trigger: "provider_overflow",
        createdAt: 150,
        coverageThroughRunId: "run_history",
        beforeTokens: 900,
        afterTokens: 400,
        status: "recovered",
      };
      expect(await readMarker(first.app)).toEqual(producingRequestMarker);

      Bun.gc(true);
      db.close(true);
      db = openRuntimeDatabase(databasePath);
      const reopened = await createApp(config(), { runtimeDatabase: db });
      expect(await readMarker(reopened)).toEqual(producingRequestMarker);
    } finally {
      try {
        db?.close();
      } catch {
        // The successful path already closed the first database handle.
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not expose poisoned stored Assistant metadata from the active AI SDK route", async () => {
    const { app, db, store } = await createAppWithHistoryFixtures();
    const assistant = store.listActiveLineageMessages("conv_history").find(
      (message) => message.id === "msg_assistant",
    );
    if (!assistant || assistant.role !== "assistant") throw new Error("missing assistant fixture");
    store.saveMessage({
      ...assistant,
      status: { type: "incomplete", reason: "interrupted" },
      finish: "interrupted",
      metadata: {
        interrupt: {
          reason: "user_stop",
          message: "safe interruption",
          interruptedAt: "safe-time",
          rawPayload: "NESTED_INTERRUPT_SECRET",
        },
        provider: { apiKey: "must-not-leak" },
        continuation: { rawPayload: "must-not-leak" },
        attachmentIds: ["att_must-not-leak"],
        preparationClaim: { fencingToken: 99 },
        secret: "must-not-leak",
      },
    });

    const response = await app.handle(new Request(
      "http://localhost/v1/conversations/conv_history/messages?format=ai_sdk",
    ));
    const body = await response.json() as {
      messages: Array<{ id: string; metadata?: { custom?: { nexus?: Record<string, unknown> } } }>;
    };
    const serialized = JSON.stringify(body);
    const nexus = body.messages.find((message) => message.id === assistant.id)
      ?.metadata?.custom?.nexus;

    expect(response.status).toBe(200);
    expect(nexus?.status).toEqual({ type: "incomplete", reason: "interrupted" });
    expect(nexus?.interrupt).toEqual({
      reason: "user_stop",
      message: "safe interruption",
      interruptedAt: "safe-time",
    });
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("fencingToken");
    expect(serialized).not.toContain("NESTED_INTERRUPT_SECRET");
    db.close();
  });

  test("returns active history by default and an explicit append-only transcript with DAG runs", async () => {
    const { app, db } = await createAppWithBranchedHistoryFixtures();

    const defaultResponse = await app.handle(new Request(
      "http://localhost/v1/conversations/conv_branched_history/messages",
    ));
    const activeResponse = await app.handle(new Request(
      "http://localhost/v1/conversations/conv_branched_history/messages?view=active",
    ));
    const transcriptResponse = await app.handle(new Request(
      "http://localhost/v1/conversations/conv_branched_history/messages?view=transcript",
    ));
    const defaultBody = await defaultResponse.json() as {
      conversation_id: string;
      active_head_run_id?: string;
      revision: number;
      view: string;
      format: string;
      messages: Message[];
      runs?: unknown[];
    };
    const activeBody = await activeResponse.json() as typeof defaultBody;
    const transcriptBody = await transcriptResponse.json() as typeof defaultBody & {
      runs: Array<Record<string, unknown>>;
    };
    const messageTexts = (messages: Message[]) => messages.flatMap((message) =>
      message.parts.flatMap((part) => part.type === "text" ? [part.text] : [])
    );

    expect(defaultResponse.status).toBe(200);
    expect(activeResponse.status).toBe(200);
    expect(defaultBody).toEqual(activeBody);
    expect(defaultBody).toMatchObject({
      conversation_id: "conv_branched_history",
      active_head_run_id: "run_e",
      revision: 5,
      view: "active",
      format: "runtime",
    });
    expect(messageTexts(defaultBody.messages)).toEqual([
      "Question A",
      "Question B",
      "Question E",
    ]);
    expect(defaultBody.runs).toBeUndefined();

    expect(transcriptResponse.status).toBe(200);
    expect(transcriptBody).toMatchObject({
      conversation_id: "conv_branched_history",
      active_head_run_id: "run_e",
      revision: 5,
      view: "transcript",
      format: "runtime",
    });
    expect(messageTexts(transcriptBody.messages)).toEqual([
      "Question A",
      "Question B",
      "Question C",
      "Question D",
      "Question E",
    ]);
    expect(transcriptBody.runs).toEqual([
      expect.objectContaining({ id: "run_a", conversation_id: "conv_branched_history" }),
      expect.objectContaining({ id: "run_b", parent_run_id: "run_a" }),
      expect.objectContaining({ id: "run_c", parent_run_id: "run_b" }),
      expect.objectContaining({ id: "run_d", parent_run_id: "run_c" }),
      expect.objectContaining({
        id: "run_e",
        parent_run_id: "run_b",
        supersedes_run_id: "run_c",
      }),
    ]);
    for (const run of transcriptBody.runs) {
      for (const sensitiveField of [
        "input",
        "output",
        "error",
        "usage",
        "cost",
        "limits",
        "metadata",
      ]) {
        expect(run).not.toHaveProperty(sensitiveField);
      }
    }

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
        activeHeadRunId: "run_error_recovery",
        revision: 1,
        time: { created: 1, updated: 4 },
      });
      initialStore.saveRun({
        id: "run_error_recovery",
        conversationId: "conv_error_recovery",
        parentMessageId: "msg_error_user",
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

    const viewResponse = await app.handle(
      new Request("http://localhost/v1/conversations/conv_history/messages?view=bad"),
    );
    expect(viewResponse.status).toBe(422);

    db.close();
  });
});
