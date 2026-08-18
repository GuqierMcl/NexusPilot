import { describe, expect, test } from "bun:test";
import {
  conversationSchema,
  eventSchema,
  messageSchema,
  partSchema,
  permissionSchema,
  runSchema,
  traceEventSchema,
} from "../src/runtime";

describe("runtime domain schemas", () => {
  test("validates a conversation record", () => {
    const parsed = conversationSchema.parse({
      id: "conv_1",
      title: "Runtime foundation",
      version: "1",
      status: { type: "idle" },
      time: { created: 1, updated: 1 },
    });

    expect(parsed.id).toBe("conv_1");
  });

  test("validates a run record", () => {
    const parsed = runSchema.parse({
      id: "run_1",
      conversationId: "conv_1",
      agentMode: "ask",
      providerId: "openai",
      modelId: "gpt-4o",
      status: "queued",
      input: {
        messageIds: ["msg_1"],
        prompt: {
          version: "runtime-prompt-v1",
          blockIds: ["runtime.base", "agent.behavior", "runtime.boundaries", "output.style"],
          warnings: [],
        },
        tools: {
          snapshotId: "tool_snapshot_1",
          runId: "run_1",
          createdAt: new Date(0).toISOString(),
          agentMode: "ask",
          executionCeiling: {
            maxRiskLevel: "low",
            allowedSideEffects: [],
            allowIrreversible: false,
          },
          activeTools: [],
        },
      },
      limits: { maxSteps: 1, maxToolCalls: 0 },
      time: { created: 1 },
    });

    expect(parsed.status).toBe("queued");
    expect(parsed.agentMode).toBe("ask");
  });

  test("validates interrupted run and assistant message records", () => {
    const parsedRun = runSchema.parse({
      id: "run_interrupted",
      conversationId: "conv_1",
      agentMode: "ask",
      providerId: "openai",
      modelId: "gpt-4o",
      status: "interrupted",
      input: {
        messageIds: ["msg_user"],
        prompt: {
          version: "runtime-prompt-v1",
          blockIds: ["runtime.base", "agent.behavior", "runtime.boundaries", "output.style"],
          warnings: [],
        },
        tools: {
          snapshotId: "tool_snapshot_interrupted",
          runId: "run_interrupted",
          createdAt: new Date(0).toISOString(),
          agentMode: "ask",
          executionCeiling: {
            maxRiskLevel: "low",
            allowedSideEffects: [],
            allowIrreversible: false,
          },
          activeTools: [],
        },
      },
      finish: "interrupted",
      error: {
        name: "MessageAbortedError",
        data: { message: "user requested stop" },
      },
      metadata: {
        interrupt: {
          reason: "user_stop",
          interruptedAt: "2026-06-28T12:00:00.000Z",
        },
      },
      limits: { maxSteps: 1, maxToolCalls: 0 },
      time: { created: 1, started: 2, completed: 3 },
    });

    expect(parsedRun.status).toBe("interrupted");
    expect(parsedRun.finish).toBe("interrupted");

    const parsedMessage = messageSchema.parse({
      id: "msg_assistant",
      conversationId: "conv_1",
      role: "assistant",
      runId: "run_interrupted",
      parentId: "msg_user",
      providerId: "openai",
      modelId: "gpt-4o",
      agentMode: "ask",
      status: { type: "incomplete", reason: "interrupted" },
      finish: "interrupted",
      parts: [],
      time: { created: 2, completed: 3 },
    });

    expect(parsedMessage.role).toBe("assistant");
    if (parsedMessage.role !== "assistant") {
      throw new Error("Expected assistant message");
    }
    expect(parsedMessage.status).toEqual({ type: "incomplete", reason: "interrupted" });
  });

  test("rejects legacy run mode and profile fields", () => {
    expect(() =>
      runSchema.parse({
        id: "run_legacy",
        conversationId: "conv_1",
        mode: "ask",
        profileId: "ask",
        providerId: "openai",
        modelId: "gpt-4o",
        status: "queued",
        input: { messageIds: ["msg_1"] },
        limits: { maxSteps: 1, maxToolCalls: 0 },
        time: { created: 1 },
      }),
    ).toThrow();
  });

  test("validates a message with a structured diff part", () => {
    const part = partSchema.parse({
      id: "part_1",
      conversationId: "conv_1",
      messageId: "msg_1",
      type: "diff",
      status: "proposed",
      diff: {
        id: "diff_1",
        title: "SQL draft edit",
        kind: "sql",
        target: { type: "memory", name: "query.sql", language: "sql" },
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [
              { type: "remove", oldLine: 1, text: "SELECT * FROM users" },
              { type: "add", newLine: 1, text: "SELECT id, name FROM users" },
            ],
          },
        ],
      },
    });

    const message = messageSchema.parse({
      id: "msg_1",
      conversationId: "conv_1",
      role: "assistant",
      runId: "run_1",
      parentId: "msg_user",
      providerId: "openai",
      modelId: "gpt-4o",
      agentMode: "ask",
      status: { type: "running" },
      parts: [part],
      time: { created: 1 },
    });

    expect(message.parts[0]?.type).toBe("diff");
  });

  test("validates permission, event, and trace records", () => {
    const permission = permissionSchema.parse({
      id: "perm_1",
      conversationId: "conv_1",
      runId: "run_1",
      messageId: "msg_1",
      toolCallId: "tool_1",
      status: "approved",
      toolId: "web.fetch",
      title: "Allow web fetch",
      risk: {
        level: "medium",
        reversible: true,
        sideEffects: ["external_network"],
      },
      confirmation: { level: "standard" },
      decision: { source: "system", decidedAt: 2 },
      createdAt: 1,
    });

    const event = eventSchema.parse({
      id: "evt_1",
      type: "permission.resolved",
      properties: { info: permission },
      time: 2,
    });

    const trace = traceEventSchema.parse({
      id: "trace_1",
      conversationId: "conv_1",
      runId: "run_1",
      type: "permission.decided",
      level: "info",
      time: 2,
      payload: { response: "allow" },
    });

    expect(event.type).toBe("permission.resolved");
    expect(trace.type).toBe("permission.decided");
  });
});
