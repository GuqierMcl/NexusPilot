import { describe, expect, test } from "bun:test";
import { openRuntimeDatabase } from "../src/storage/runtime-database";
import {
  RuntimeRunner,
  RuntimeSqliteStore,
  type AssistantMessage,
  type Conversation,
  type Run,
  type RunId,
  type UserMessage,
} from "../src/runtime";

function createStore() {
  const db = openRuntimeDatabase(":memory:");
  return { db, store: new RuntimeSqliteStore(db) };
}

function saveRunPair(
  store: RuntimeSqliteStore,
  input: {
    conversationId: Conversation["id"];
    runId: RunId;
    parentRunId?: RunId;
    supersedesRunId?: RunId;
    created: number;
  },
): void {
  const suffix = input.runId.slice("run_".length);
  const userMessage: UserMessage = {
    id: `msg_user_${suffix}`,
    conversationId: input.conversationId,
    role: "user",
    agentMode: "ask",
    parts: [],
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
    status: { type: "complete" },
    parts: [],
    time: { created: input.created + 1 },
  };
  const run: Run = {
    id: input.runId,
    conversationId: input.conversationId,
    parentRunId: input.parentRunId,
    supersedesRunId: input.supersedesRunId,
    parentMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    agentMode: "ask",
    providerId: "openai",
    modelId: "gpt-4o",
    status: "completed",
    input: { messageIds: [userMessage.id] },
    output: { messageId: assistantMessage.id, partIds: [] },
    limits: { maxSteps: 1, maxToolCalls: 0 },
    time: { created: input.created, completed: input.created + 1 },
  };

  store.saveMessage(userMessage);
  store.saveRun(run);
  store.saveMessage(assistantMessage);
}

function createBranchedHistory(store: RuntimeSqliteStore): Conversation {
  const conversation: Conversation = {
    id: "conv_dag",
    title: "Branched history",
    version: "1",
    status: { type: "idle" },
    activeHeadRunId: "run_d",
    revision: 5,
    time: { created: 1, updated: 10 },
  };
  store.saveConversation(conversation);
  saveRunPair(store, { conversationId: conversation.id, runId: "run_a", created: 10 });
  saveRunPair(store, {
    conversationId: conversation.id,
    runId: "run_b",
    parentRunId: "run_a",
    created: 20,
  });
  saveRunPair(store, {
    conversationId: conversation.id,
    runId: "run_c",
    parentRunId: "run_b",
    created: 30,
  });
  saveRunPair(store, {
    conversationId: conversation.id,
    runId: "run_d",
    parentRunId: "run_c",
    created: 40,
  });
  saveRunPair(store, {
    conversationId: conversation.id,
    runId: "run_e",
    parentRunId: "run_b",
    supersedesRunId: "run_c",
    created: 50,
  });
  return conversation;
}

describe("RuntimeSqliteStore Run DAG history views", () => {
  test("persists active-head revisions and parent lineage when starting Runs", () => {
    const { db, store } = createStore();
    let clock = 100;
    const counters = new Map<string, number>();
    const runner = new RuntimeRunner({
      store,
      now: () => clock++,
      createId: ((prefix: string) => {
        const next = (counters.get(prefix) ?? 0) + 1;
        counters.set(prefix, next);
        return `${prefix}_${next}`;
      }) as never,
    });

    const first = runner.start({ providerId: "openai", modelId: "gpt-4o", text: "first" });
    runner.completeText(first, "first response");
    const second = runner.start({
      conversationId: first.conversation.id,
      providerId: "openai",
      modelId: "gpt-4o",
      text: "second",
    });

    expect(first.conversation).toMatchObject({ activeHeadRunId: first.run.id, revision: 1 });
    expect(second.run.parentRunId).toBe(first.run.id);
    expect(second.conversation).toMatchObject({ activeHeadRunId: second.run.id, revision: 2 });

    db.close();
  });

  test("returns the complete transcript and deterministic lineage views", () => {
    const { db, store } = createStore();
    const conversation = createBranchedHistory(store);

    const transcriptIds: Array<`msg_${string}`> = [
      "msg_user_a",
      "msg_assistant_a",
      "msg_user_b",
      "msg_assistant_b",
      "msg_user_c",
      "msg_assistant_c",
      "msg_user_d",
      "msg_assistant_d",
      "msg_user_e",
      "msg_assistant_e",
    ];
    expect(store.listTranscriptMessages(conversation.id).map((message) => message.id)).toEqual(
      transcriptIds,
    );
    expect(store.listMessages(conversation.id).map((message) => message.id)).toEqual(transcriptIds);
    expect(store.listLineageRuns(conversation.id, "run_d").map((run) => run.id)).toEqual([
      "run_a",
      "run_b",
      "run_c",
      "run_d",
    ]);
    expect(store.listLineageMessages(conversation.id, "run_d").map((message) => message.id)).toEqual(
      transcriptIds.slice(0, 8),
    );
    expect(store.listLineageMessages(conversation.id, "run_e").map((message) => message.id)).toEqual([
      "msg_user_a",
      "msg_assistant_a",
      "msg_user_b",
      "msg_assistant_b",
      "msg_user_e",
      "msg_assistant_e",
    ]);
    expect(store.listActiveLineageMessages(conversation.id).map((message) => message.id)).toEqual(
      transcriptIds.slice(0, 8),
    );
    expect(store.listRunAlternatives("run_c").map((run) => run.id)).toEqual(["run_c", "run_e"]);
    expect(store.listRunAlternatives("run_e").map((run) => run.id)).toEqual(["run_c", "run_e"]);

    db.close();
  });

  test("does not rewrite persisted Run DAG edges during lifecycle updates", () => {
    const { db, store } = createStore();
    createBranchedHistory(store);
    const original = store.getRun("run_c");
    if (!original) {
      throw new Error("Expected run_c fixture");
    }

    store.saveRun({
      ...original,
      parentRunId: "run_a",
      supersedesRunId: "run_b",
      status: "failed",
    });

    expect(store.getRun("run_c")).toMatchObject({
      parentRunId: "run_b",
      supersedesRunId: undefined,
      status: "failed",
    });

    db.close();
  });

  test("fails closed and records a diagnostic when lineage contains a cycle", () => {
    const { db, store } = createStore();
    const conversation = createBranchedHistory(store);
    db.query("UPDATE runtime_runs SET parent_run_id = 'run_d' WHERE id = 'run_a'").run();

    let error: unknown;
    try {
      store.listLineageRuns(conversation.id, "run_d");
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      name: "RuntimeHistoryIntegrityError",
      code: "DAG_CYCLE",
      conversationId: conversation.id,
      runId: "run_a",
    });
    expect(store.listHistoryDiagnostics(conversation.id)).toEqual([
      expect.objectContaining({
        conversationId: conversation.id,
        code: "DAG_CYCLE",
        details: { headRunId: "run_d", runId: "run_a" },
      }),
    ]);

    db.close();
  });

  test("fails closed and records a diagnostic for an incomplete Run association", () => {
    const { db, store } = createStore();
    const conversation: Conversation = {
      id: "conv_incomplete",
      title: "Incomplete history",
      version: "1",
      status: { type: "idle" },
      activeHeadRunId: "run_incomplete",
      revision: 1,
      time: { created: 1, updated: 2 },
    };
    store.saveConversation(conversation);
    db.query(
      `INSERT INTO runtime_runs (
        id, conversation_id, parent_message_id, assistant_message_id, agent_mode,
        provider_id, model_id, status, input_json, time_json, limits_json
      ) VALUES (
        'run_incomplete', 'conv_incomplete', 'msg_user_missing', 'msg_assistant_missing',
        'ask', 'openai', 'gpt-4o', 'completed', '{"messageIds":["msg_user_missing"]}',
        '{"created":2}', '{"maxSteps":1,"maxToolCalls":0}'
      )`,
    ).run();

    let error: unknown;
    try {
      store.listActiveLineageMessages(conversation.id);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      name: "RuntimeHistoryIntegrityError",
      code: "DAG_INCOMPLETE_RUN",
      conversationId: conversation.id,
      runId: "run_incomplete",
    });
    expect(store.listHistoryDiagnostics(conversation.id)).toEqual([
      expect.objectContaining({
        conversationId: conversation.id,
        code: "DAG_INCOMPLETE_RUN",
        details: {
          headRunId: "run_incomplete",
          runId: "run_incomplete",
          reason: "missing_user_message",
        },
      }),
    ]);

    db.close();
  });

  test("fails closed when a lineage parent belongs to another conversation", () => {
    const { db, store } = createStore();
    const owner: Conversation = {
      id: "conv_owner",
      title: "Owner",
      version: "1",
      status: { type: "idle" },
      activeHeadRunId: "run_owner_child",
      revision: 1,
      time: { created: 1, updated: 3 },
    };
    const foreign: Conversation = {
      id: "conv_foreign",
      title: "Foreign",
      version: "1",
      status: { type: "idle" },
      activeHeadRunId: "run_foreign_parent",
      revision: 1,
      time: { created: 1, updated: 2 },
    };
    store.saveConversation(owner);
    store.saveConversation(foreign);
    saveRunPair(store, {
      conversationId: foreign.id,
      runId: "run_foreign_parent",
      created: 10,
    });
    saveRunPair(store, {
      conversationId: owner.id,
      runId: "run_owner_child",
      parentRunId: "run_foreign_parent",
      created: 20,
    });

    let error: unknown;
    try {
      store.listLineageRuns(owner.id, "run_owner_child");
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      name: "RuntimeHistoryIntegrityError",
      code: "DAG_INCOMPLETE_RUN",
      conversationId: owner.id,
      runId: "run_foreign_parent",
      details: {
        headRunId: "run_owner_child",
        runId: "run_foreign_parent",
        reason: "conversation_ownership_mismatch",
      },
    });

    db.close();
  });

  test("converts a malformed persisted Run payload into an integrity diagnostic", () => {
    const { db, store } = createStore();
    const conversation = createBranchedHistory(store);
    db.query("UPDATE runtime_runs SET input_json = '{' WHERE id = 'run_d'").run();

    let error: unknown;
    try {
      store.listLineageRuns(conversation.id, "run_d");
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      name: "RuntimeHistoryIntegrityError",
      code: "DAG_INCOMPLETE_RUN",
      conversationId: conversation.id,
      runId: "run_d",
      details: {
        headRunId: "run_d",
        runId: "run_d",
        reason: "invalid_run_payload",
      },
    });
    expect(store.listHistoryDiagnostics(conversation.id)).toEqual([
      expect.objectContaining({
        code: "DAG_INCOMPLETE_RUN",
        details: {
          headRunId: "run_d",
          runId: "run_d",
          reason: "invalid_run_payload",
        },
      }),
    ]);

    db.close();
  });

  test("converts an invalid persisted Message payload into an integrity diagnostic", () => {
    const { db, store } = createStore();
    const conversation = createBranchedHistory(store);
    db.query("UPDATE runtime_messages SET message_json = '{}' WHERE id = 'msg_user_d'").run();

    let error: unknown;
    try {
      store.listLineageMessages(conversation.id, "run_d");
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      name: "RuntimeHistoryIntegrityError",
      code: "DAG_INCOMPLETE_RUN",
      conversationId: conversation.id,
      runId: "run_d",
      details: {
        headRunId: "run_d",
        runId: "run_d",
        reason: "invalid_user_message_payload",
      },
    });
    expect(store.listHistoryDiagnostics(conversation.id)).toEqual([
      expect.objectContaining({
        code: "DAG_INCOMPLETE_RUN",
        details: {
          headRunId: "run_d",
          runId: "run_d",
          reason: "invalid_user_message_payload",
        },
      }),
    ]);

    db.close();
  });
});
