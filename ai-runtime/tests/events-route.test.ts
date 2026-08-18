import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { RuntimeEventBus, type RuntimeEventEnvelope } from "../src/runtime";

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

function envelope(overrides: Partial<RuntimeEventEnvelope> = {}): RuntimeEventEnvelope {
  return {
    id: "evt_live",
    type: "run.updated",
    scope: {
      kind: "run",
      conversation_id: "conv_live",
      run_id: "run_live",
    },
    occurred_at: 1,
    version: 1,
    payload: { status: "completed" },
    ...overrides,
  };
}

describe("events route", () => {
  test("streams live EventBus envelopes as SSE", async () => {
    const eventBus = new RuntimeEventBus();
    const app = await createApp(config(), { runtimeEventBus: eventBus });

    const response = await app.handle(new Request("http://localhost/v1/events"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    eventBus.publish(envelope());

    const chunk = await readNextChunk(reader!);
    expect(chunk).toContain("event: run.updated");
    expect(chunk).toContain("id: evt_live");
    expect(chunk).toContain("\"run_id\":\"run_live\"");

    await reader!.cancel();
  });

  test("filters conversation scoped SSE subscriptions", async () => {
    const eventBus = new RuntimeEventBus();
    const app = await createApp(config(), { runtimeEventBus: eventBus });

    const response = await app.handle(
      new Request("http://localhost/v1/events?conversation_id=conv_live"),
    );
    const reader = response.body!.getReader();

    eventBus.publish(envelope({ id: "evt_match" }));
    const matchingChunk = await readNextChunk(reader);
    expect(matchingChunk).toContain("evt_match");

    eventBus.publish(
      envelope({
        id: "evt_other",
        scope: { kind: "run", conversation_id: "conv_other", run_id: "run_other" },
      }),
    );

    await expect(readNextChunk(reader, 20)).rejects.toThrow("Timed out waiting for SSE chunk");
    await reader.cancel();
  });

  test("returns 422 for invalid event scope query", async () => {
    const eventBus = new RuntimeEventBus();
    const app = await createApp(config(), { runtimeEventBus: eventBus });

    const bothResponse = await app.handle(
      new Request("http://localhost/v1/events?conversation_id=conv_live&run_id=run_live"),
    );
    expect(bothResponse.status).toBe(422);
    expect(await bothResponse.json()).toEqual({
      detail: "conversation_id and run_id are mutually exclusive",
    });

    const invalidConversationResponse = await app.handle(
      new Request("http://localhost/v1/events?conversation_id=bad"),
    );
    expect(invalidConversationResponse.status).toBe(422);

    const invalidRunResponse = await app.handle(
      new Request("http://localhost/v1/events?run_id=bad"),
    );
    expect(invalidRunResponse.status).toBe(422);

    const cursorResponse = await app.handle(
      new Request("http://localhost/v1/events?cursor=evt_live"),
    );
    expect(cursorResponse.status).toBe(422);
    expect(await cursorResponse.json()).toEqual({
      detail: "cursor is not supported for live-only events",
    });
  });

  test("returns 503 when runtime EventBus is unavailable", async () => {
    const app = await createApp(config(), { runtimeEventBus: null });

    const response = await app.handle(new Request("http://localhost/v1/events"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      detail: "Runtime EventBus not initialized",
    });
  });
});

async function readNextChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 200,
): Promise<string> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("Timed out waiting for SSE chunk")), timeoutMs);
  });
  const result = await Promise.race([reader.read(), timeout]);
  if (result.done || !result.value) {
    throw new Error("SSE stream ended before a chunk was available");
  }

  return new TextDecoder().decode(result.value);
}
