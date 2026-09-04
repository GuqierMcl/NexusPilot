import { describe, expect, test } from "bun:test";
import {
  RuntimeConversationNotFoundError,
  RuntimeEventBus,
  RuntimeRunner,
  RuntimeSqliteStore,
  type RuntimeError,
  type TextPart,
} from "../src/runtime";
import { openRuntimeDatabase } from "../src/storage/runtime-database";

function createRunner(options: { eventBus?: RuntimeEventBus } = {}) {
  const db = openRuntimeDatabase(":memory:");
  const store = new RuntimeSqliteStore(db, options);
  let timeSequence = 0;
  let idSequence = 0;
  const runner = new RuntimeRunner({
    store,
    now: () => 1000 + timeSequence++,
    createId: (prefix) => `${prefix}_${++idSequence}` as never,
    appVersion: "test",
  });

  return { db, store, runner };
}

describe("RuntimeRunner", () => {
  test("starts a run with conversation, user message, run, and assistant message", () => {
    const { db, store, runner } = createRunner();

    const started = runner.start({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Explain SELECT * FROM users",
    });

    expect(started.conversation.status).toEqual({
      type: "busy",
      runId: started.run.id,
    });
    expect(started.conversation.title).toBe("Explain SELECT * FROM users");
    expect(started.conversation.metadata?.title).toMatchObject({
      source: "fallback",
      sourceMessageId: started.userMessage.id,
    });
    expect(started.userMessage.parts[0]).toMatchObject({
      type: "text",
      text: "Explain SELECT * FROM users",
    });
    expect(started.run.status).toBe("running");
    expect(started.userMessage.agentMode).toBe("ask");
    expect(started.run.agentMode).toBe("ask");
    expect(started.run.input.prompt?.version).toBe("runtime-prompt-v2");
    expect(started.run.input.tools).toMatchObject({
      runId: started.run.id,
      agentMode: "ask",
      activeTools: [],
    });
    expect(started.run.parentMessageId).toBe(started.userMessage.id);
    expect(started.run.assistantMessageId).toBe(started.assistantMessage.id);
    expect(started.assistantMessage.agentMode).toBe("ask");
    expect(started.assistantMessage.status).toEqual({ type: "running" });

    expect(store.getConversation(started.conversation.id)).toEqual(started.conversation);
    expect(store.getRun(started.run.id)).toEqual(started.run);
    expect(store.getMessage(started.userMessage.id)).toEqual(started.userMessage);
    expect(store.getMessage(started.assistantMessage.id)).toEqual(started.assistantMessage);

    db.close();
  });

  test("derives a compact default conversation title from the first user input", () => {
    const { db, runner } = createRunner();

    const started = runner.start({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "请帮我分析这个非常非常长的 SQL 查询为什么会很慢，并给出优化建议",
    });

    expect(started.conversation.title).toBe(
      "请帮我分析这个非常非常长的 SQL 查询为什么会很慢，并给出优...",
    );

    db.close();
  });

  test("starts a run with explicit agent mode and execution policy snapshot", () => {
    const { db, runner } = createRunner();

    const started = runner.start({
      runId: "run_runner",
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Fetch docs",
      agentMode: "agent",
      executionPolicy: {
        prompt: {
          version: "runtime-prompt-v1",
          blockIds: ["runtime.base", "agent.behavior", "tool.usage"],
          warnings: [],
        },
        tools: {
          snapshotId: "tool_snapshot_runner",
          runId: "run_runner",
          createdAt: new Date(0).toISOString(),
          agentMode: "agent",
          executionCeiling: {
            maxRiskLevel: "low",
            allowedSideEffects: ["external_network"],
            allowIrreversible: false,
          },
          activeTools: [
            { canonicalId: "web.fetch", providerName: "np__web__fetch" },
          ],
        },
        limits: { maxSteps: 4, maxToolCalls: 8, maxOutputTokens: 4096, timeoutMs: 120_000 },
        trace: {
          promptAssemblyVersion: "runtime-prompt-v1",
          promptBlockIds: ["runtime.base", "agent.behavior", "tool.usage"],
          enabledToolNames: ["web_fetch"],
          activeToolNames: ["web_fetch"],
          warnings: [],
        },
      },
    });

    expect(started.run.agentMode).toBe("agent");
    expect(started.userMessage.agentMode).toBe("agent");
    expect(started.assistantMessage.agentMode).toBe("agent");
    expect(started.run.input.tools?.activeTools).toEqual([
      { canonicalId: "web.fetch", providerName: "np__web__fetch" },
    ]);

    db.close();
  });

  test("rejects an explicit conversation id that does not exist", () => {
    const { db, runner } = createRunner();

    expect(() =>
      runner.start({
        conversationId: "conv_missing123" as never,
        providerId: "openai",
        modelId: "gpt-4o",
        text: "Hello",
      }),
    ).toThrow(RuntimeConversationNotFoundError);

    db.close();
  });

  test("rejects a Tool Snapshot bound to another Run or Agent mode", () => {
    const { db, runner } = createRunner();

    expect(() =>
      runner.start({
        runId: "run_target",
        providerId: "openai",
        modelId: "gpt-4o",
        text: "Use snapshot",
        agentMode: "ask",
        executionPolicy: {
          prompt: {
            version: "runtime-prompt-v1",
            blockIds: [],
            warnings: [],
          },
          tools: {
            snapshotId: "tool_snapshot_foreign",
            runId: "run_foreign",
            createdAt: new Date(0).toISOString(),
            agentMode: "agent",
            executionCeiling: {
              maxRiskLevel: "low",
              allowedSideEffects: [],
              allowIrreversible: false,
            },
            activeTools: [],
          },
          limits: { maxSteps: 1, maxToolCalls: 0 },
          trace: {
            promptAssemblyVersion: "runtime-prompt-v1",
            promptBlockIds: [],
            enabledToolNames: [],
            activeToolNames: [],
            warnings: [],
          },
        },
      }),
    ).toThrow("Run Tool Snapshot does not match the target Run identity");

    db.close();
  });

  test("replaces an arbitrary user turn by removing its message tail and Run artifacts", () => {
    const { db, store, runner } = createRunner();
    const first = runner.start({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "First question",
    });
    runner.completeText(first, "First answer");
    const second = runner.start({
      conversationId: first.conversation.id,
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Second question",
    });
    runner.completeText(second, "Second answer");
    const third = runner.start({
      conversationId: first.conversation.id,
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Third question",
    });
    runner.completeText(third, "Third answer");

    const replacement = runner.start({
      conversationId: first.conversation.id,
      replaceFromMessageId: second.userMessage.id,
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Rewritten second question",
    });

    expect(store.listMessages(first.conversation.id).map((message) => [
      message.role,
      message.parts.find((part) => part.type === "text")?.type === "text"
        ? message.parts.find((part) => part.type === "text")?.text
        : null,
    ])).toEqual([
      ["user", "First question"],
      ["assistant", "First answer"],
      ["user", "Rewritten second question"],
      ["assistant", null],
    ]);
    expect(store.getRun(first.run.id)).not.toBeNull();
    expect(store.getRun(second.run.id)).toBeNull();
    expect(store.getRun(third.run.id)).toBeNull();
    expect(store.getMessage(second.userMessage.id)).toBeNull();
    expect(store.getMessage(third.assistantMessage.id)).toBeNull();
    expect(store.listEventsByRun(second.run.id)).toEqual([]);
    expect(store.listTraces(third.run.id)).toEqual([]);
    expect(store.listEvents(first.conversation.id).filter((event) => event.type === "message.removed"))
      .toHaveLength(4);
    expect(replacement.conversation.status).toEqual({
      type: "busy",
      runId: replacement.run.id,
    });

    db.close();
  });

  test("rejects replacing a non-user message or a conversation with an active Run", () => {
    const { db, runner } = createRunner();
    const started = runner.start({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Question",
    });

    expect(() =>
      runner.start({
        conversationId: started.conversation.id,
        replaceFromMessageId: started.userMessage.id,
        providerId: "openai",
        modelId: "gpt-4o",
        text: "Edited question",
      }),
    ).toThrow("has an active run");

    runner.completeText(started, "Answer");
    expect(() =>
      runner.start({
        conversationId: started.conversation.id,
        replaceFromMessageId: started.assistantMessage.id,
        providerId: "openai",
        modelId: "gpt-4o",
        text: "Edited question",
      }),
    ).toThrow("cannot be edited");

    db.close();
  });

  test("publishes replacement invalidation only after the new message tail is committed", () => {
    const eventBus = new RuntimeEventBus();
    const { db, store, runner } = createRunner({ eventBus });
    const observed: Array<{ type: string; hasReplacement: boolean }> = [];
    let conversationId: string | null = null;
    eventBus.subscribe({ kind: "global" }, (event) => {
      observed.push({
        type: event.type,
        hasReplacement:
          conversationId !== null &&
          store
            .listMessages(conversationId as never)
            .some(
              (message) =>
                message.parts.some(
                  (part) => part.type === "text" && part.text === "Rewritten question",
                ),
            ),
      });
    });
    const first = runner.start({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Original question",
    });
    conversationId = first.conversation.id;
    runner.completeText(first, "Original answer");
    observed.length = 0;

    runner.start({
      conversationId: first.conversation.id,
      replaceFromMessageId: first.userMessage.id,
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Rewritten question",
    });

    expect(observed.map((event) => event.type)).toEqual([
      "message.removed",
      "message.removed",
      "conversation.updated",
      "run.updated",
    ]);
    expect(observed.every((event) => event.hasReplacement)).toBe(true);

    db.close();
  });

  test("completes a run by writing final text part and terminal state", () => {
    const { db, store, runner } = createRunner();
    const started = runner.start({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Hello",
    });

    const completed = runner.completeText(started, "Hi there", {
      finish: "stop",
      usage: {
        input: 4,
        output: 2,
        reasoning: 0,
        total: 6,
      },
    });

    expect(completed.conversation.status).toEqual({ type: "idle" });
    expect(completed.run.status).toBe("completed");
    expect(completed.run.finish).toBe("stop");
    expect(completed.run.output).toEqual({
      messageId: completed.assistantMessage.id,
      partIds: [completed.textPart.id],
    });
    expect(completed.run.usage).toEqual({
      input: 4,
      output: 2,
      reasoning: 0,
      total: 6,
    });
    expect(completed.assistantMessage.status).toEqual({
      type: "complete",
      reason: "stop",
    });
    expect(completed.assistantMessage.usage).toEqual(completed.run.usage);
    expect(completed.assistantMessage.parts).toEqual([completed.textPart]);
    expect(store.getRun(started.run.id)).toEqual(completed.run);
    expect(store.getMessage(started.assistantMessage.id)).toEqual(completed.assistantMessage);

    db.close();
  });

  test("preserves a title update that lands while the run is active", () => {
    const { db, store, runner } = createRunner();
    const started = runner.start({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Fix EventBus CORS",
    });
    const current = store.getConversation(started.conversation.id)!;
    store.saveConversation({
      ...current,
      title: "修复 EventBus 跨域通知",
      metadata: {
        ...(current.metadata ?? {}),
        title: {
          source: "generated",
          sourceMessageId: started.userMessage.id,
        },
      },
    });

    runner.completeText(started, "Done");

    expect(store.getConversation(started.conversation.id)).toMatchObject({
      title: "修复 EventBus 跨域通知",
      status: { type: "idle" },
      metadata: {
        title: {
          source: "generated",
          sourceMessageId: started.userMessage.id,
        },
      },
    });

    db.close();
  });

  test("completes a run with semantic assistant parts before final text", () => {
    const { db, store, runner } = createRunner();
    const started = runner.start({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Fetch https://example.com",
      agentMode: "agent",
    });
    const sourcePart = {
      id: "part_source" as never,
      conversationId: started.conversation.id,
      messageId: started.assistantMessage.id,
      type: "source" as const,
      sourceType: "url" as const,
      url: "https://example.com",
      title: "Example",
      time: { created: 1002 },
    };

    const completed = runner.completeText(started, "Fetched Example.", {
      finish: "stop",
      parts: [sourcePart],
    });

    expect(completed.assistantMessage.parts.map((part) => part.type)).toEqual([
      "source",
      "text",
    ]);
    expect(completed.run.output?.partIds).toEqual([
      sourcePart.id,
      completed.textPart.id,
    ]);
    expect(store.getMessage(started.assistantMessage.id)?.parts).toEqual([
      sourcePart,
      completed.textPart,
    ]);

    db.close();
  });

  test("fails a run with error state on run, message, and conversation", () => {
    const { db, store, runner } = createRunner();
    const started = runner.start({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Hello",
    });
    const error: RuntimeError = {
      name: "ProviderAuthError",
      data: { providerId: "openai", message: "missing API key" },
    };

    const failed = runner.fail(started, error);

    expect(failed.conversation.status).toEqual({ type: "error", error });
    expect(failed.run.status).toBe("failed");
    expect(failed.run.error).toEqual(error);
    expect(failed.assistantMessage.status).toEqual({ type: "error", error });
    expect(store.getRun(started.run.id)).toEqual(failed.run);

    db.close();
  });

  test("preserves accumulated semantic parts when a run fails", () => {
    const { db, store, runner } = createRunner();
    const started = runner.start({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Hello",
    });
    const partialPart: TextPart = {
      id: "part_partial" as TextPart["id"],
      conversationId: started.conversation.id,
      messageId: started.assistantMessage.id,
      type: "text" as const,
      text: "Partial answer",
      time: { start: 1, end: 2 },
    };
    const error: RuntimeError = {
      name: "ProviderStreamError",
      data: { message: "provider stream failed" },
    };

    const failed = runner.fail(started, error, { parts: [partialPart] });

    expect(failed.assistantMessage.parts).toEqual([partialPart]);
    expect(store.getMessage(started.assistantMessage.id)?.parts).toEqual([
      partialPart,
    ]);

    db.close();
  });

  test("interrupts a run without marking conversation as error and preserves partial text", () => {
    const { db, store, runner } = createRunner();
    const started = runner.start({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Hello",
    });

    const interrupted = runner.interrupt(started, {
      reason: "user_stop",
      message: "user requested stop",
      text: " Partial answer\n",
    });

    expect(interrupted.conversation.status).toEqual({ type: "idle" });
    expect(interrupted.run.status).toBe("interrupted");
    expect(interrupted.run.finish).toBe("interrupted");
    expect(interrupted.run.metadata?.interrupt).toMatchObject({
      reason: "user_stop",
      message: "user requested stop",
    });
    expect(interrupted.assistantMessage.status).toEqual({
      type: "incomplete",
      reason: "interrupted",
    });
    expect(interrupted.assistantMessage.parts).toEqual([
      expect.objectContaining({
        type: "text",
        text: " Partial answer\n",
      }),
    ]);
    expect(store.getRun(started.run.id)).toEqual(interrupted.run);
    expect(store.listEventsByRun(started.run.id).map((event) => event.type)).toContain(
      "message.updated",
    );

    db.close();
  });
});
