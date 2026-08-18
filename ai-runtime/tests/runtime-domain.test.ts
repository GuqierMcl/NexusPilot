import { describe, expect, test } from "bun:test";
import {
  createRuntimeId,
  isRuntimeId,
  type Conversation,
  type DiffArtifact,
  type Message,
  type Part,
  type Run,
} from "../src/runtime";

describe("runtime domain contracts", () => {
  test("creates prefixed runtime identifiers", () => {
    const conversationId = createRuntimeId("conv");
    const runId = createRuntimeId("run");

    expect(conversationId.startsWith("conv_")).toBe(true);
    expect(runId.startsWith("run_")).toBe(true);
    expect(isRuntimeId(conversationId, "conv")).toBe(true);
    expect(isRuntimeId(runId, "conv")).toBe(false);
  });

  test("allows rich conversation, run, message, and structured diff objects", () => {
    const conversation: Conversation = {
      id: "conv_test",
      title: "SQL rewrite analysis",
      version: "1",
      status: { type: "idle" },
      time: { created: 1, updated: 1 },
    };

    const run: Run = {
      id: "run_test",
      conversationId: conversation.id,
      agentMode: "ask",
      providerId: "openai",
      modelId: "gpt-4o",
      status: "running",
      input: {
        messageIds: ["msg_user"],
        prompt: {
          version: "runtime-prompt-v1",
          blockIds: ["runtime.base", "agent.behavior"],
          warnings: [],
        },
        tools: {
          snapshotId: "tool_snapshot_domain",
          runId: "run_active",
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
      limits: {
        maxSteps: 1,
        maxToolCalls: 0,
      },
      time: { created: 1, started: 2 },
    };

    const diff: DiffArtifact = {
      id: "diff_query_rewrite",
      title: "Rewrite current SQL in memory",
      kind: "sql",
      target: {
        type: "memory",
        name: "current-editor-selection.sql",
        language: "sql",
      },
      hunks: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [
            { type: "context", oldLine: 1, newLine: 1, text: "SELECT id, name" },
            { type: "remove", oldLine: 2, text: "FROM users" },
            { type: "add", newLine: 2, text: "FROM app_users" },
          ],
        },
      ],
      summary: "Rename table reference for the active SQL draft.",
    };

    const diffPart: Part = {
      id: "part_diff",
      conversationId: conversation.id,
      messageId: "msg_assistant",
      type: "diff",
      diff,
      status: "proposed",
    };

    const message: Message = {
      id: "msg_assistant",
      conversationId: conversation.id,
      role: "assistant",
      runId: run.id,
      parentId: "msg_user",
      providerId: "openai",
      modelId: "gpt-4o",
      agentMode: "ask",
      status: { type: "running" },
      parts: [diffPart],
      time: { created: 3 },
    };

    expect(message.parts[0]?.type).toBe("diff");
    expect(diff.target.type).toBe("memory");
  });
});
