import { describe, expect, test } from "bun:test";
import { RuntimeEventBus, type RuntimeEventEnvelope } from "../src/runtime";

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
    payload: { value: true },
    ...overrides,
  };
}

describe("RuntimeEventBus", () => {
  test("publishes live events to global subscribers", () => {
    const bus = new RuntimeEventBus();
    const received: RuntimeEventEnvelope[] = [];

    bus.subscribe({ kind: "global" }, (event) => {
      received.push(event);
    });
    bus.publish(envelope());

    expect(received.map((event) => event.id)).toEqual(["evt_live"]);
    expect(bus.subscriberCount()).toBe(1);
  });

  test("filters conversation and run subscribers", () => {
    const bus = new RuntimeEventBus();
    const conversationEvents: RuntimeEventEnvelope[] = [];
    const runEvents: RuntimeEventEnvelope[] = [];

    bus.subscribe(
      { kind: "conversation", conversation_id: "conv_live" },
      (event) => {
        conversationEvents.push(event);
      },
    );
    bus.subscribe({ kind: "run", run_id: "run_live" }, (event) => {
      runEvents.push(event);
    });

    bus.publish(envelope());
    bus.publish(
      envelope({
        id: "evt_other",
        scope: { kind: "run", conversation_id: "conv_other", run_id: "run_other" },
      }),
    );

    expect(conversationEvents.map((event) => event.id)).toEqual(["evt_live"]);
    expect(runEvents.map((event) => event.id)).toEqual(["evt_live"]);
  });

  test("unsubscribes and keeps publish best effort", async () => {
    const errors: unknown[] = [];
    const bus = new RuntimeEventBus({ onSubscriberError: (error) => errors.push(error) });
    const received: RuntimeEventEnvelope[] = [];

    const subscription = bus.subscribe({ kind: "global" }, (event) => {
      received.push(event);
    });
    bus.subscribe({ kind: "global" }, () => {
      throw new Error("subscriber failed");
    });

    subscription.unsubscribe();
    bus.publish(envelope());
    await Promise.resolve();

    expect(received).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(bus.subscriberCount()).toBe(0);
  });
});
