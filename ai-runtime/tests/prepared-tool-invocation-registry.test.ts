import { describe, expect, test } from "bun:test";
import type {
  ConversationId,
  MessageId,
  RunId,
  ToolCallId,
} from "../src/runtime";
import {
  PreparedToolInvocationRegistry,
  PreparedToolInvocationRegistryError,
  type BackendToolExecutionIdentity,
} from "../src/runtime/tools";

function identity(toolCallId = "tool_prepared_1" as ToolCallId): BackendToolExecutionIdentity {
  return {
    conversationId: "conv_prepared" as ConversationId,
    runId: "run_prepared" as RunId,
    messageId: "msg_prepared" as MessageId,
    toolCallId,
    toolId: "test.mutate",
  };
}

function prepared(expiresAt: number) {
  return {
    planId: "plan_internal",
    expiresAt,
    risk: {
      level: "critical" as const,
      reversible: false,
      sideEffects: ["destructive" as const],
    },
    permission: {
      presentation: {
        sql: {
          text: "DELETE FROM users",
          analysisStatus: "uncertain" as const,
        },
      },
    },
  };
}

describe("PreparedToolInvocationRegistry", () => {
  test("binds an immutable plan to exact ToolCall identity and normalized input", () => {
    const registry = new PreparedToolInvocationRegistry(() => 100);
    const invocation = registry.remember(
      identity(),
      { profileId: "profile_1", sql: "DELETE FROM users" },
      prepared(200),
    );

    expect(Object.isFrozen(invocation)).toBe(true);
    expect(registry.require(
      identity(),
      { profileId: "profile_1", sql: "DELETE FROM users" },
    ).planId).toBe("plan_internal");
    expect(() => registry.require(
      identity(),
      { profileId: "profile_1", sql: "DELETE FROM admins" },
    )).toThrow(expect.objectContaining({ code: "PLAN_MISMATCH" }));
    expect(() => registry.require(
      identity("tool_prepared_2" as ToolCallId),
      { profileId: "profile_1", sql: "DELETE FROM users" },
    )).toThrow(expect.objectContaining({ code: "PLAN_NOT_FOUND" }));
  });

  test("fails closed after expiry, consumption, and run cleanup", () => {
    let now = 100;
    const registry = new PreparedToolInvocationRegistry(() => now);
    registry.remember(identity(), { value: "exact" }, prepared(200));
    registry.markConsumed(identity().toolCallId);
    expect(() => registry.require(identity(), { value: "exact" })).toThrow(
      new PreparedToolInvocationRegistryError(
        "PLAN_ALREADY_CONSUMED",
        "Prepared plan was already consumed.",
      ),
    );

    const expiringId = "tool_prepared_expiring" as ToolCallId;
    registry.remember(identity(expiringId), { value: "exact" }, prepared(150));
    now = 150;
    expect(() =>
      registry.require(identity(expiringId), { value: "exact" })
    ).toThrow(expect.objectContaining({ code: "PLAN_EXPIRED" }));

    const cleanupId = "tool_prepared_cleanup" as ToolCallId;
    registry.remember(identity(cleanupId), { value: "exact" }, prepared(300));
    registry.clearRun(identity().runId);
    expect(() =>
      registry.require(identity(cleanupId), { value: "exact" })
    ).toThrow(expect.objectContaining({ code: "PLAN_NOT_FOUND" }));

    const forgottenId = "tool_prepared_forgotten" as ToolCallId;
    registry.remember(identity(forgottenId), { value: "exact" }, prepared(300));
    registry.forget(forgottenId);
    expect(() =>
      registry.require(identity(forgottenId), { value: "exact" })
    ).toThrow(expect.objectContaining({ code: "PLAN_NOT_FOUND" }));
  });
});
