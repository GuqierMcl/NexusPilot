import { expect, test } from "bun:test";
import { openRuntimeDatabase } from "../src/storage/runtime-database";
import { RuntimeRunner, RuntimeSqliteStore } from "../src/runtime";
import {
  ContextCompactionService,
  type ContextSummaryGenerator,
} from "../src/runtime/context/compaction-service";
import { ModelContextManager } from "../src/runtime/context/model-context-manager";
import { ManualCompactionService } from "../src/runtime/context/manual-compaction-service";
import { manualCompactionRoutes } from "../src/routes/manual-compactions";
import type { LanguageModel } from "ai";

function fixture(
  generator: ContextSummaryGenerator = async () => ({
    text: "User explored customers and orders. Preserve database identity and require approvals for writes.",
  }),
  count = 4,
) {
  const db = openRuntimeDatabase(":memory:");
  const store = new RuntimeSqliteStore(db);
  const runner = new RuntimeRunner({ store });
  let conversationId: `conv_${string}` | undefined;
  for (let i = 0; i < count; i++) {
    const run = runner.start({
      conversationId,
      providerId: "test",
      modelId: "test",
      text: `Question ${i}: ${"query customers ".repeat(250)}`,
    });
    runner.completeText(run, "read-only result ".repeat(100));
    conversationId = run.conversation.id;
  }
  const compactor = new ContextCompactionService({ store, generator });
  const manager = new ModelContextManager({
    store,
    compactionService: compactor,
  });
  const resolveModel = () => ({
    languageModel: {} as LanguageModel,
    runtimeContext: {
      provider: {
        providerId: "test",
        modelId: "test",
        contextLength: 100000,
        outputLength: 4096,
      },
    },
  });
  const service = new ManualCompactionService({
    db,
    store,
    compactor,
    manager,
    resolveModel,
  });
  return {
    db,
    store,
    runner,
    service,
    conversationId: conversationId!,
    manager,
    compactor,
    resolveModel,
  };
}
const input = { requestKey: "first", providerId: "test", modelId: "test" };
async function settle(
  service: ManualCompactionService,
  conversationId: string,
  id: string,
) {
  for (let i = 0; i < 100; i++) {
    const result = service.get(conversationId, id)!;
    if (result.status !== "preparing") return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Operation did not settle");
}
test("manual compression below auto threshold creates a checkpoint with no chat messages and is idempotent", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return {
      text: "User queried customer records. All work was read-only. Keep approval boundaries.",
    };
  });
  try {
    const before = f.store.listTranscriptMessages(f.conversationId);
    const op = f.service.start(f.conversationId, input);
    expect(f.service.start(f.conversationId, input).id).toBe(op.id);
    expect(() =>
      f.runner.start({
        conversationId: f.conversationId,
        providerId: "test",
        modelId: "test",
        text: "racing message",
      }),
    ).toThrow();
    const result = await settle(f.service, f.conversationId, op.id);
    expect(result.status).toBe("created");
    expect(calls).toBe(1);
    expect(f.store.listTranscriptMessages(f.conversationId)).toEqual(before);
    expect(f.store.listContextCheckpoints(f.conversationId)[0]?.trigger).toBe(
      "manual",
    );
    expect(
      f.store.getConversation(f.conversationId)?.time.compacting,
    ).toBeUndefined();
    expect(
      f.store.getContextUsageByRunRequest(op.runId, op.requestIndex)
        ?.nextTurnForecast?.view,
    ).toBe("checkpoint");
    expect(
      (
        await settle(
          f.service,
          f.conversationId,
          f.service.start(f.conversationId, { ...input, requestKey: "second" })
            .id,
        )
      ).status,
    ).toBe("not_needed");
    expect(calls).toBe(1);
  } finally {
    f.db.close();
  }
});
test("cancel fences a late generator result and allows a later normal message", async () => {
  let complete!: (value: { text: string }) => void;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  try {
    const op = f.service.start(f.conversationId, input);
    expect(() =>
      f.service.start(f.conversationId, { ...input, requestKey: "duplicate" }),
    ).toThrow();
    expect(f.service.cancel(f.conversationId, op.id).status).toBe(
      "interrupted",
    );
    complete({ text: "A late summary that must never become active." });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.store.listContextCheckpoints(f.conversationId)).toHaveLength(0);
    expect(
      f.store.listContextCompactionActivities(f.conversationId)[0]?.status,
    ).toBe("interrupted");
    expect(() =>
      f.runner.start({
        conversationId: f.conversationId,
        providerId: "test",
        modelId: "test",
        text: "next message",
      }),
    ).not.toThrow();
  } finally {
    f.db.close();
  }
});
test("no safe prefix is reported as not needed; HTTP invalid requests never start work", async () => {
  const f = fixture(undefined, 1);
  try {
    const op = f.service.start(f.conversationId, input);
    expect((await settle(f.service, f.conversationId, op.id)).status).toBe(
      "not_needed",
    );
    expect(
      f.store.listContextCompactionActivities(f.conversationId),
    ).toHaveLength(0);
    const app = manualCompactionRoutes(f.service);
    const response = await app.handle(
      new Request(
        `http://localhost/v1/conversations/${f.conversationId}/compactions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...input, prompt: "arbitrary" }),
        },
      ),
    );
    expect(response.status).toBe(422);
  } finally {
    f.db.close();
  }
});

test("restart repairs an operation and fences any old late completion", async () => {
  let complete!: (value: { text: string }) => void;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  try {
    const op = f.service.start(f.conversationId, input);
    const restarted = new ManualCompactionService({
      db: f.db,
      store: f.store,
      compactor: f.compactor,
      manager: f.manager,
      resolveModel: f.resolveModel,
    });
    restarted.repair();
    expect(restarted.get(f.conversationId, op.id)?.status).toBe("interrupted");
    expect(
      f.store.getConversation(f.conversationId)?.time.compacting,
    ).toBeUndefined();
    complete({ text: "late old process summary" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.store.listContextCheckpoints(f.conversationId)).toHaveLength(0);
  } finally {
    f.db.close();
  }
});

test("source revision changes reject stale summaries; generation failures release the operation lock", async () => {
  let complete!: (value: { text: string }) => void;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  try {
    const op = f.service.start(f.conversationId, input);
    const current = f.store.getConversation(f.conversationId)!;
    f.store.saveConversation({ ...current, revision: current.revision + 1 });
    complete({ text: "Summary from stale revision" });
    expect((await settle(f.service, f.conversationId, op.id)).status).toBe(
      "interrupted",
    );
    expect(f.store.listContextCheckpoints(f.conversationId)).toHaveLength(0);
    expect(
      f.store.getConversation(f.conversationId)?.time.compacting,
    ).toBeUndefined();
  } finally {
    f.db.close();
  }
  const failing = fixture(async () => {
    throw new Error("provider failed");
  });
  try {
    const op = failing.service.start(failing.conversationId, input);
    expect(
      (await settle(failing.service, failing.conversationId, op.id)).status,
    ).toBe("failed");
    expect(
      failing.store.getConversation(failing.conversationId)?.time.compacting,
    ).toBeUndefined();
    expect(
      failing.store.listContextCompactionActivities(failing.conversationId)[0]
        ?.status,
    ).toBe("failed");
  } finally {
    failing.db.close();
  }
});
