import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeLogger } from "../src/core/logger";
import {
  CONVERSATION_TITLE_SYSTEM_PROMPT,
  RuntimeEventBus,
  RuntimeSqliteStore,
  buildConversationTitlePrompt,
  createConversationTitleGenerator,
  normalizeGeneratedConversationTitle,
  readConversationTitleMetadata,
  withConversationTitleMetadata,
  type Conversation,
  type RuntimeEventEnvelope,
} from "../src/runtime";
import { openRuntimeDatabase } from "../src/storage/runtime-database";

function createTitleTestStore() {
  const db = openRuntimeDatabase(":memory:");
  const eventBus = new RuntimeEventBus();
  const store = new RuntimeSqliteStore(db, { eventBus });
  const conversation: Conversation = {
    id: "conv_title" as never,
    title: "请帮我修复 EventBus...",
    version: "1",
    status: { type: "busy", runId: "run_title" as never },
    time: { created: 1_000, updated: 1_000 },
    metadata: withConversationTitleMetadata(undefined, {
      source: "fallback",
      sourceMessageId: "msg_title" as never,
    }),
  };
  store.saveConversation(conversation);

  return { db, eventBus, store, conversation };
}

function generationInput() {
  return {
    conversationId: "conv_title" as never,
    sourceMessageId: "msg_title" as never,
    fallbackTitle: "请帮我修复 EventBus...",
    providerId: "openai",
    modelId: "gpt-test",
    userText: "请帮我修复 EventBus 的跨域问题",
    model: new MockLanguageModelV3(),
  };
}

describe("conversation title generation", () => {
  test("asks the model for a topic summary instead of a repeated request", () => {
    expect(CONVERSATION_TITLE_SYSTEM_PROMPT).toContain(
      "Do not copy the user's sentence",
    );
    expect(CONVERSATION_TITLE_SYSTEM_PROMPT).toContain(
      '"现在是什么时间" -> "当前时间查询"',
    );
    expect(buildConversationTitlePrompt("请帮我排查问题")).toContain(
      "Reframe rather than repeat",
    );
  });

  test("normalizes reasoning, prefixes, wrappers, and excessive length", () => {
    expect(
      normalizeGeneratedConversationTitle(
        "<think>分析用户意图</think>\n标题：“修复 EventBus 跨域通知”\n额外说明",
      ),
    ).toBe("修复 EventBus 跨域通知");
    expect(normalizeGeneratedConversationTitle("  \n  ")).toBeNull();
    expect(
      Array.from(
        normalizeGeneratedConversationTitle("A".repeat(80)) ?? "",
      ),
    ).toHaveLength(50);
  });

  test("bounds the source prompt while retaining its beginning and end", () => {
    const prompt = buildConversationTitlePrompt(
      `BEGIN-${"x".repeat(5_000)}-END`,
    );

    expect(prompt).toContain("BEGIN-");
    expect(prompt).toContain("-END");
    expect(prompt.length).toBeLessThan(4_200);
  });

  test("persists a generated title and publishes conversation.updated to EventBus", async () => {
    const { db, eventBus, store } = createTitleTestStore();
    const events: RuntimeEventEnvelope[] = [];
    const logs: Array<Record<string, unknown>> = [];
    eventBus.subscribe({ kind: "global" }, (event) => {
      events.push(event);
    });
    let generatorOptions: Record<string, unknown> | null = null;
    const generate = createConversationTitleGenerator({
      store,
      now: () => 2_000,
      createId: (prefix) => `${prefix}_generated` as never,
      logger: createRuntimeLogger({
        format: "json",
        level: "debug",
        write: (line) => {
          logs.push(JSON.parse(line) as Record<string, unknown>);
        },
      }),
      generateText: async (input) => {
        generatorOptions = input as unknown as Record<string, unknown>;
        return {
          text: "<think>ignore</think>\n标题：修复 EventBus 跨域通知",
        };
      },
    });

    await expect(generate(generationInput())).resolves.toEqual({
      status: "updated",
      title: "修复 EventBus 跨域通知",
    });

    expect(generatorOptions).toMatchObject({
      maxRetries: 1,
      timeout: 30_000,
    });
    expect(generatorOptions).not.toHaveProperty("maxOutputTokens");
    expect(store.getConversation("conv_title" as never)?.title).toBe(
      "修复 EventBus 跨域通知",
    );
    expect(
      readConversationTitleMetadata(
        store.getConversation("conv_title" as never)?.metadata,
      ),
    ).toMatchObject({
      source: "generated",
      sourceMessageId: "msg_title",
      providerId: "openai",
      modelId: "gpt-test",
      generatedAt: 2_000,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "conversation.updated",
      scope: {
        kind: "conversation",
        conversation_id: "conv_title",
      },
    });
    expect(logs.map((log) => log.msg)).toEqual([
      "conversation title generation started",
      "conversation title model response received",
      "conversation title generated and persisted",
    ]);
    expect(logs[0]).toMatchObject({
      conversationId: "conv_title",
      sourceMessageId: "msg_title",
      providerId: "openai",
      modelId: "gpt-test",
      sourceTextLength: 20,
      timeoutMs: 30_000,
      maxRetries: 1,
    });
    expect(logs[0]).not.toHaveProperty("userText");
    expect(logs[1]).toMatchObject({
      responseTextLength: 41,
      normalizedTitleLength: 16,
    });
    expect(logs[1]).not.toHaveProperty("title");
    expect(logs[2]).toMatchObject({
      eventType: "conversation.updated",
      titleLength: 16,
    });

    db.close();
  });

  test("does not overwrite a user title while generation is in flight", async () => {
    const { db, store } = createTitleTestStore();
    const logs: Array<Record<string, unknown>> = [];
    let resolveGeneration:
      | ((result: { text: string }) => void)
      | undefined;
    const generate = createConversationTitleGenerator({
      store,
      logger: createRuntimeLogger({
        format: "json",
        level: "debug",
        write: (line) => {
          logs.push(JSON.parse(line) as Record<string, unknown>);
        },
      }),
      generateText: () =>
        new Promise((resolve) => {
          resolveGeneration = resolve;
        }),
    });
    const pending = generate(generationInput());
    await Promise.resolve();

    const current = store.getConversation("conv_title" as never)!;
    store.saveConversation({
      ...current,
      title: "用户指定标题",
      metadata: withConversationTitleMetadata(current.metadata, {
        source: "user",
      }),
    });
    resolveGeneration?.({ text: "模型生成标题" });

    await expect(pending).resolves.toEqual({ status: "skipped" });
    expect(store.getConversation("conv_title" as never)?.title).toBe(
      "用户指定标题",
    );
    expect(store.listEvents("conv_title" as never)).toHaveLength(0);
    expect(logs.at(-1)).toMatchObject({
      msg: "conversation title update skipped",
      skipReason: "title_no_longer_replaceable",
      currentTitleSource: "user",
    });

    db.close();
  });

  test("keeps the fallback title when generation fails", async () => {
    const { db, store } = createTitleTestStore();
    const generate = createConversationTitleGenerator({
      store,
      generateText: async () => {
        throw new Error("provider unavailable");
      },
    });

    await expect(generate(generationInput())).resolves.toEqual({
      status: "failed",
    });
    expect(store.getConversation("conv_title" as never)?.title).toBe(
      "请帮我修复 EventBus...",
    );

    db.close();
  });
});
