import { describe, expect, test } from "bun:test";
import { classifyRuntimeEvent } from "../src/runtime";

describe("Runtime event classifier", () => {
  test("marks token-like deltas as live-only", () => {
    expect(classifyRuntimeEvent("text.delta")).toEqual({
      persistence: "live-only",
      reason: "high-frequency stream delta",
    });
    expect(classifyRuntimeEvent("reasoning.delta").persistence).toBe("live-only");
    expect(classifyRuntimeEvent("tool.stdout.delta").persistence).toBe("live-only");
  });

  test("marks semantic boundaries as durable events", () => {
    expect(classifyRuntimeEvent("run.completed")).toEqual({
      persistence: "durable-event",
      reason: "runtime semantic boundary",
    });
    expect(classifyRuntimeEvent("permission.resolved").persistence).toBe("durable-event");
    expect(classifyRuntimeEvent("diff.proposed").persistence).toBe("durable-event");
  });

  test("marks current-state snapshots as projection updates", () => {
    expect(classifyRuntimeEvent("message.snapshot")).toEqual({
      persistence: "projection-update",
      reason: "current state projection",
    });
    expect(classifyRuntimeEvent("run.snapshot").persistence).toBe("projection-update");
  });

  test("marks UI coordination events as transient", () => {
    expect(classifyRuntimeEvent("toast.requested")).toEqual({
      persistence: "ui-transient",
      reason: "best-effort UI coordination",
    });
    expect(classifyRuntimeEvent("panel.scrollToBottomRequested").persistence).toBe(
      "ui-transient",
    );
  });

  test("defaults unknown events to durable semantic events", () => {
    expect(classifyRuntimeEvent("custom.domain.fact")).toEqual({
      persistence: "durable-event",
      reason: "unknown event types default to durable semantic handling",
    });
  });
});
