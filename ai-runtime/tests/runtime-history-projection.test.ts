import { describe, expect, test } from "bun:test";
import {
  parseMessageHistoryFormat,
  projectMessageToAiSdkUIMessage,
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
      revision: 1,
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

  test("projects multiple compaction activities as independent data parts at step boundaries", () => {
    const message: Message = {
      id: "msg_activity",
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
          id: "part_start_0",
          conversationId: "conv_history",
          messageId: "msg_activity",
          type: "step-start",
          stepIndex: 0,
        },
        {
          id: "part_text_0",
          conversationId: "conv_history",
          messageId: "msg_activity",
          type: "text",
          text: "first",
        },
        {
          id: "part_finish_0",
          conversationId: "conv_history",
          messageId: "msg_activity",
          type: "step-finish",
          stepIndex: 0,
          reason: "tool-calls",
        },
        {
          id: "part_start_1",
          conversationId: "conv_history",
          messageId: "msg_activity",
          type: "step-start",
          stepIndex: 1,
        },
        {
          id: "part_text_1",
          conversationId: "conv_history",
          messageId: "msg_activity",
          type: "text",
          text: "second",
        },
      ],
      time: { created: 1, completed: 2 },
    };

    const projected = projectMessageToAiSdkUIMessage(message, {
      compactionActivities: [
        {
          id: "cmp_pre",
          conversationId: "conv_history",
          runId: "run_history",
          requestIndex: 0,
          attemptIndex: 0,
          trigger: "auto_pre_turn",
          status: "created",
          sourceHeadRunId: "run_history",
          sourceConversationRevision: 1,
          beforeEstimatedInputTokens: 900,
          afterEstimatedInputTokens: 300,
          startedAt: 1,
          completedAt: 1,
        },
        {
          id: "cmp_mid",
          conversationId: "conv_history",
          runId: "run_history",
          requestIndex: 1,
          attemptIndex: 0,
          trigger: "auto_mid_turn",
          status: "created",
          sourceHeadRunId: "run_history",
          sourceConversationRevision: 1,
          beforeEstimatedInputTokens: 950,
          afterEstimatedInputTokens: 320,
          startedAt: 2,
          completedAt: 2,
        },
      ],
    });

    expect(projected.parts).toEqual([
      expect.objectContaining({ type: "data-context-compaction", id: "cmp_pre" }),
      { type: "text", text: "first" },
      expect.objectContaining({ type: "data-context-compaction", id: "cmp_mid" }),
      { type: "text", text: "second" },
    ]);
    expect(JSON.stringify(projected.parts)).not.toContain("summary");
  });
});
