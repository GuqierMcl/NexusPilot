import { describe, expect, test } from "bun:test";
import { ActiveRunRegistry } from "../src/runtime";

describe("ActiveRunRegistry", () => {
  test("interrupts active runs by run id and unregisters them", () => {
    const registry = new ActiveRunRegistry();
    const calls: unknown[] = [];

    registry.register({
      runId: "run_active" as never,
      conversationId: "conv_active" as never,
      interrupt: (request) => {
        calls.push(request);
        return {
          interrupted: true,
          run: { id: "run_active", conversationId: "conv_active", status: "interrupted" },
          conversation: { id: "conv_active" },
          assistantMessage: null,
        } as never;
      },
    });

    const result = registry.interruptRun("run_active" as never, {
      reason: "user_stop",
      message: "user requested stop",
    });

    expect(result?.interrupted).toBe(true);
    expect(calls).toEqual([{ reason: "user_stop", message: "user requested stop" }]);
    expect(registry.getActiveRunId("conv_active" as never)).toBeNull();
    expect(registry.interruptRun("run_active" as never, { reason: "user_stop" })).toBeNull();
  });

  test("interrupts active runs by conversation id", () => {
    const registry = new ActiveRunRegistry();
    registry.register({
      runId: "run_active" as never,
      conversationId: "conv_active" as never,
      interrupt: () =>
        ({
          interrupted: true,
          run: { id: "run_active", conversationId: "conv_active", status: "interrupted" },
          conversation: { id: "conv_active" },
          assistantMessage: null,
        }) as never,
    });

    expect(
      registry.interruptConversation("conv_active" as never, { reason: "user_stop" })?.run.id,
    ).toBe("run_active");
    expect(registry.interruptConversation("conv_active" as never, { reason: "user_stop" }))
      .toBeNull();
  });
});
