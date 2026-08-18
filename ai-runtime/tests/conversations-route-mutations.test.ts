import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import {
  RuntimeEventBus,
  RuntimeSqliteStore,
  type Conversation,
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

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  const now = 1_700_000_000_000;
  return {
    id: "conv_mutation",
    title: "Original title",
    version: "1",
    status: { type: "idle" },
    time: { created: now, updated: now },
    ...overrides,
  } as Conversation;
}

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe("conversation mutation routes", () => {
  test("renames a conversation and publishes an update event", async () => {
    const db = openRuntimeDatabase(":memory:");
    const eventBus = new RuntimeEventBus();
    const events: RuntimeEventEnvelope[] = [];
    eventBus.subscribe({ kind: "global" }, (event) => {
      events.push(event);
    });
    const store = new RuntimeSqliteStore(db, { eventBus });
    store.saveConversation(conversation());
    const app = await createApp(config(), {
      runtimeDatabase: db,
      runtimeEventBus: eventBus,
    });

    const response = await app.handle(
      new Request("http://localhost/v1/conversations/conv_mutation", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "  Renamed 对话  " }),
      }),
    );

    expect(response.status).toBe(200);
    expect((await json(response)).conversation).toMatchObject({
      id: "conv_mutation",
      title: "Renamed 对话",
    });
    expect(store.getConversation("conv_mutation" as never)?.title).toBe(
      "Renamed 对话",
    );
    expect(
      store.getConversation("conv_mutation" as never)?.metadata?.title,
    ).toEqual({
      source: "user",
    });
    expect(events.map((event) => event.type)).toContain("conversation.updated");
    db.close();
  });

  test("rejects empty and overlong rename titles", async () => {
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeSqliteStore(db);
    store.saveConversation(conversation());
    const app = await createApp(config(), { runtimeDatabase: db });

    const empty = await app.handle(
      new Request("http://localhost/v1/conversations/conv_mutation", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "   " }),
      }),
    );
    const overlong = await app.handle(
      new Request("http://localhost/v1/conversations/conv_mutation", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x".repeat(121) }),
      }),
    );

    expect(empty.status).toBe(422);
    expect(await empty.json()).toEqual({
      detail: "Conversation title must be 1-120 characters",
    });
    expect(overlong.status).toBe(422);
    expect(await overlong.json()).toEqual({
      detail: "Conversation title must be 1-120 characters",
    });
    db.close();
  });

  test("archives and unarchives a conversation using existing status and time fields", async () => {
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeSqliteStore(db);
    store.saveConversation(conversation());
    const app = await createApp(config(), { runtimeDatabase: db });

    const archive = await app.handle(
      new Request("http://localhost/v1/conversations/conv_mutation/archive", {
        method: "POST",
      }),
    );
    const archivedAt = store.getConversation("conv_mutation" as never)?.time
      .archived;
    expect(archive.status).toBe(200);
    expect(store.getConversation("conv_mutation" as never)?.status).toEqual({
      type: "archived",
    });
    expect(typeof archivedAt).toBe("number");

    const unarchive = await app.handle(
      new Request("http://localhost/v1/conversations/conv_mutation/unarchive", {
        method: "POST",
      }),
    );
    expect(unarchive.status).toBe(200);
    expect(store.getConversation("conv_mutation" as never)?.status).toEqual({
      type: "idle",
    });
    expect(
      store.getConversation("conv_mutation" as never)?.time.archived,
    ).toBeUndefined();
    db.close();
  });

  test("pins and unpins a conversation in metadata.ui.pinnedAt", async () => {
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeSqliteStore(db);
    store.saveConversation(conversation({ metadata: { existing: true } }));
    const app = await createApp(config(), { runtimeDatabase: db });

    const pin = await app.handle(
      new Request("http://localhost/v1/conversations/conv_mutation/pin", {
        method: "POST",
      }),
    );
    expect(pin.status).toBe(200);
    expect(store.getConversation("conv_mutation" as never)?.metadata).toMatchObject({
      existing: true,
      ui: { pinnedAt: expect.any(Number) },
    });

    const unpin = await app.handle(
      new Request("http://localhost/v1/conversations/conv_mutation/unpin", {
        method: "POST",
      }),
    );
    expect(unpin.status).toBe(200);
    expect(store.getConversation("conv_mutation" as never)?.metadata).toEqual({
      existing: true,
    });
    db.close();
  });

  test("deletes a conversation and cascades child runtime records", async () => {
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeSqliteStore(db);
    store.saveConversation(conversation());
    store.saveRun({
      id: "run_child" as never,
      conversationId: "conv_mutation" as never,
      agentMode: "ask",
      providerId: "openai",
      modelId: "gpt-4o",
      status: "completed",
      input: { messageIds: [] },
      time: { created: 1 },
      limits: { maxSteps: 1, maxToolCalls: 0 },
    });
    const app = await createApp(config(), { runtimeDatabase: db });

    const response = await app.handle(
      new Request("http://localhost/v1/conversations/conv_mutation", {
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      deleted: true,
      conversation_id: "conv_mutation",
    });
    expect(store.getConversation("conv_mutation" as never)).toBeNull();
    expect(store.getRun("run_child" as never)).toBeNull();
    db.close();
  });

  test("rejects archive and delete while a conversation has an active run", async () => {
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeSqliteStore(db);
    store.saveConversation(
      conversation({ status: { type: "busy", runId: "run_active" as never } }),
    );
    const app = await createApp(config(), { runtimeDatabase: db });

    const archive = await app.handle(
      new Request("http://localhost/v1/conversations/conv_mutation/archive", {
        method: "POST",
      }),
    );
    const deletion = await app.handle(
      new Request("http://localhost/v1/conversations/conv_mutation", {
        method: "DELETE",
      }),
    );

    expect(archive.status).toBe(409);
    expect(await archive.json()).toEqual({
      detail: "Conversation has an active run",
    });
    expect(deletion.status).toBe(409);
    expect(await deletion.json()).toEqual({
      detail: "Conversation has an active run",
    });
    db.close();
  });

  test("returns 404 for missing conversation mutations", async () => {
    const db = openRuntimeDatabase(":memory:");
    const app = await createApp(config(), { runtimeDatabase: db });

    const response = await app.handle(
      new Request("http://localhost/v1/conversations/conv_missing/archive", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      detail: "Conversation conv_missing not found",
    });
    db.close();
  });
});
