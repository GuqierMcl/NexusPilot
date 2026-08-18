import { describe, expect, test } from "bun:test";
import {
  parseMessageHistoryFormat,
  projectConversationSummary,
  projectMessageHistory,
  type Conversation,
  type Message,
} from "../src/runtime";

describe("runtime history projection", () => {
  test("projects conversation summary with active run id", () => {
    const conversation: Conversation = {
      id: "conv_history",
      title: "History",
      version: "1",
      status: { type: "busy", runId: "run_history" },
      time: { created: 1, updated: 2 },
      metadata: { source: "test" },
    };

    expect(projectConversationSummary(conversation)).toEqual({
      id: "conv_history",
      title: "History",
      status: { type: "busy", runId: "run_history" },
      active_run_id: "run_history",
      time: { created: 1, updated: 2 },
      metadata: { source: "test" },
    });
  });

  test("projects runtime and ui message history formats", () => {
    const message: Message = {
      id: "msg_history",
      conversationId: "conv_history",
      role: "assistant",
      runId: "run_history",
      parentId: "msg_user",
      providerId: "openai",
      modelId: "gpt-4o",
      agentMode: "ask",
      status: { type: "complete", reason: "stop" },
      parts: [
        {
          id: "part_history",
          conversationId: "conv_history",
          messageId: "msg_history",
          type: "text",
          text: "Recovered text",
        },
      ],
      time: { created: 1, completed: 2 },
    };

    expect(projectMessageHistory([message], "runtime")).toEqual([message]);
    expect(projectMessageHistory([message], "ui")).toEqual([
      {
        id: "msg_history",
        role: "assistant",
        parts: [{ type: "text", text: "Recovered text" }],
        metadata: expect.objectContaining({
          nexus: expect.objectContaining({
            conversationId: "conv_history",
            runId: "run_history",
            agentMode: "ask",
          }),
        }),
      },
    ]);
  });

  test("parses message history format", () => {
    expect(parseMessageHistoryFormat(undefined)).toBe("runtime");
    expect(parseMessageHistoryFormat("runtime")).toBe("runtime");
    expect(parseMessageHistoryFormat("ui")).toBe("ui");
    expect(parseMessageHistoryFormat("invalid")).toBeNull();
  });
});
