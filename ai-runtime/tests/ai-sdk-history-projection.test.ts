import { describe, expect, test } from "bun:test";
import {
  readUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import {
  parseMessageHistoryFormat,
  projectMessageHistory,
} from "../src/runtime/projection/history-projection";
import type { AssistantMessage } from "../src/runtime/core/types";

const baseMessage = {
  id: "msg_assistant",
  conversationId: "conv_history",
  role: "assistant",
  runId: "run_history",
  parentId: "msg_user",
  providerId: "openai",
  modelId: "gpt-4o",
  agentMode: "ask",
  status: { type: "complete", reason: "stop" },
  time: { created: 1, completed: 2 },
} satisfies Omit<AssistantMessage, "parts">;

describe("AI SDK history projection", () => {
  test("parses ai_sdk as a message history format", () => {
    expect(parseMessageHistoryFormat("ai_sdk")).toBe("ai_sdk");
  });

  test("projects Runtime messages to AI SDK 7 UIMessage parts", () => {
    const message: AssistantMessage = {
      ...baseMessage,
      parts: [
        {
          id: "part_text",
          conversationId: "conv_history",
          messageId: "msg_assistant",
          type: "text",
          text: "Recovered answer",
        },
        {
          id: "part_reasoning",
          conversationId: "conv_history",
          messageId: "msg_assistant",
          type: "reasoning",
          text: "Reasoning detail",
        },
        {
          id: "part_source",
          conversationId: "conv_history",
          messageId: "msg_assistant",
          type: "source",
          sourceType: "url",
          sourceId: "src_docs",
          url: "https://example.com/docs",
          title: "Example Docs",
        },
        {
          id: "part_file",
          conversationId: "conv_history",
          messageId: "msg_assistant",
          type: "file",
          mimeType: "application/pdf",
          filename: "schema.pdf",
          url: "https://example.com/schema.pdf",
        },
        {
          id: "part_tool",
          conversationId: "conv_history",
          messageId: "msg_assistant",
          type: "tool",
          toolCallId: "tool_fetch",
          toolName: "web_fetch",
          state: {
            status: "completed",
            input: { url: "https://example.com/docs" },
            output: {
              data: { title: "Example" },
              display: {
                title: "Example",
                sourceUrl: "https://example.com/docs",
              },
            },
            title: "Fetch web page",
            time: { start: 1, end: 2 },
          },
        },
        {
          id: "part_diff",
          conversationId: "conv_history",
          messageId: "msg_assistant",
          type: "diff",
          status: "proposed",
          diff: {
            id: "diff_sql",
            title: "SQL draft change",
            kind: "sql",
            target: {
              type: "memory",
              name: "current-sql-editor",
              language: "sql",
            },
            hunks: [],
          },
        },
        {
          id: "part_error",
          conversationId: "conv_history",
          messageId: "msg_assistant",
          type: "error",
          error: {
            name: "APIError",
            data: {
              message: "Provider failed",
              isRetryable: false,
            },
          },
        },
      ],
    };

    expect(projectMessageHistory([message], "ai_sdk")).toEqual([
      {
        id: "msg_assistant",
        role: "assistant",
        parts: [
          { type: "text", text: "Recovered answer" },
          { type: "reasoning", text: "Reasoning detail" },
          {
            type: "source-url",
            sourceId: "src_docs",
            url: "https://example.com/docs",
            title: "Example Docs",
          },
          {
            type: "file",
            mediaType: "application/pdf",
            filename: "schema.pdf",
            url: "https://example.com/schema.pdf",
          },
          {
            type: "tool-web_fetch",
            toolCallId: "tool_fetch",
            title: "Fetch web page",
            state: "output-available",
            input: { url: "https://example.com/docs" },
            output: {
              data: { title: "Example" },
              display: {
                title: "Example",
                sourceUrl: "https://example.com/docs",
              },
            },
          },
        ],
        metadata: {
          nexus: {
            conversationId: "conv_history",
            runId: "run_history",
            providerId: "openai",
            modelId: "gpt-4o",
            agentMode: "ask",
          },
          custom: {
            nexus: {
              conversationId: "conv_history",
              runId: "run_history",
              providerId: "openai",
              modelId: "gpt-4o",
              agentMode: "ask",
            },
          },
        },
      },
    ]);
  });

  test("preserves AI SDK tool and approval identities across Snapshot recovery", () => {
    const message: AssistantMessage = {
      ...baseMessage,
      status: { type: "requires-action", reason: "permission" },
      parts: [{
        id: "part_approval",
        conversationId: "conv_history",
        messageId: "msg_assistant",
        type: "tool",
        toolCallId: "tool_runtime_1",
        toolName: "sql.execute",
        metadata: {
          aiSdkToolCallId: "call_provider_1",
          aiSdkApprovalId: "approval_provider_1",
        },
        state: {
          status: "waiting_for_permission",
          input: {
            profileId: "profile_1",
            sql: "UPDATE users SET active = 0",
          },
          permissionId: "perm_runtime_1",
          title: "Execute SQL",
          time: { start: 1 },
        },
      }],
    };

    expect(projectMessageHistory([message], "ai_sdk")[0]?.parts).toEqual([{
      type: "tool-sql.execute",
      toolCallId: "call_provider_1",
      title: "Execute SQL",
      state: "approval-requested",
      input: {
        profileId: "profile_1",
        sql: "UPDATE users SET active = 0",
      },
      approval: { id: "approval_provider_1" },
    }]);
  });

  test("lets a continuation output update the Snapshot-restored tool invocation", async () => {
    const message: AssistantMessage = {
      ...baseMessage,
      status: { type: "requires-action", reason: "permission" },
      parts: [{
        id: "part_approval",
        conversationId: "conv_history",
        messageId: "msg_assistant",
        type: "tool",
        toolCallId: "tool_runtime_1",
        toolName: "sql.execute",
        metadata: {
          aiSdkToolCallId: "call_provider_1",
          aiSdkApprovalId: "approval_provider_1",
        },
        state: {
          status: "waiting_for_permission",
          input: { sql: "UPDATE users SET active = 0" },
          permissionId: "perm_runtime_1",
          time: { start: 1 },
        },
      }],
    };
    const restored = projectMessageHistory(
      [message],
      "ai_sdk",
    )[0] as UIMessage;
    const continuation = new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.enqueue({
          type: "tool-output-error",
          toolCallId: "call_provider_1",
          errorText: "Unknown column 'id' in 'where clause'",
        });
        controller.close();
      },
    });

    const updates: UIMessage[] = [];
    for await (
      const update of readUIMessageStream({
        message: restored,
        stream: continuation,
        terminateOnError: true,
      })
    ) {
      updates.push(update);
    }

    expect(updates.at(-1)?.parts[0]).toMatchObject({
      toolCallId: "call_provider_1",
      state: "output-error",
      errorText: "Unknown column 'id' in 'where clause'",
    });
  });

  test("projects interrupted assistant messages with partial text and interrupt metadata", () => {
    const message: AssistantMessage = {
      ...baseMessage,
      status: { type: "incomplete", reason: "interrupted" },
      finish: "interrupted",
      metadata: {
        interrupt: {
          reason: "user_stop",
          interruptedAt: "2026-06-28T12:00:00.000Z",
        },
      },
      parts: [
        {
          id: "part_partial",
          conversationId: "conv_history",
          messageId: "msg_assistant",
          type: "text",
          text: "Partial answer",
        },
      ],
    };

    expect(projectMessageHistory([message], "ai_sdk")).toEqual([
      {
        id: "msg_assistant",
        role: "assistant",
        parts: [{ type: "text", text: "Partial answer" }],
        metadata: {
          nexus: {
            conversationId: "conv_history",
            messageMetadata: {
              interrupt: {
                reason: "user_stop",
                interruptedAt: "2026-06-28T12:00:00.000Z",
              },
            },
            runId: "run_history",
            providerId: "openai",
            modelId: "gpt-4o",
            agentMode: "ask",
            finish: "interrupted",
            status: { type: "incomplete", reason: "interrupted" },
            interrupt: {
              reason: "user_stop",
              interruptedAt: "2026-06-28T12:00:00.000Z",
            },
          },
          custom: {
            nexus: {
              conversationId: "conv_history",
              messageMetadata: {
                interrupt: {
                  reason: "user_stop",
                  interruptedAt: "2026-06-28T12:00:00.000Z",
                },
              },
              runId: "run_history",
              providerId: "openai",
              modelId: "gpt-4o",
              agentMode: "ask",
              finish: "interrupted",
              status: { type: "incomplete", reason: "interrupted" },
              interrupt: {
                reason: "user_stop",
                interruptedAt: "2026-06-28T12:00:00.000Z",
              },
            },
          },
        },
      },
    ]);
  });

  test("projects Runtime token usage in the AI SDK metadata shape", () => {
    const message: AssistantMessage = {
      ...baseMessage,
      usage: {
        input: 320,
        output: 80,
        reasoning: 24,
        cache: { read: 160, write: 12 },
        total: 400,
      },
      parts: [],
    };

    expect(projectMessageHistory([message], "ai_sdk")[0]?.metadata).toMatchObject({
      usage: {
        inputTokens: 320,
        outputTokens: 80,
        reasoningTokens: 24,
        cachedInputTokens: 160,
        totalTokens: 400,
      },
      custom: {
        usage: {
          inputTokens: 320,
          outputTokens: 80,
          reasoningTokens: 24,
          cachedInputTokens: 160,
          totalTokens: 400,
        },
      },
      nexus: {
        usage: {
          input: 320,
          output: 80,
          reasoning: 24,
          cache: { read: 160, write: 12 },
          total: 400,
        },
      },
    });
  });

  test("projects multiple reasoning parts with text order so restored UI can render every reasoning block", () => {
    const message: AssistantMessage = {
      ...baseMessage,
      parts: [
        {
          id: "part_reasoning_1",
          conversationId: "conv_history",
          messageId: "msg_assistant",
          type: "reasoning",
          text: "第一段推理。",
        },
        {
          id: "part_text_1",
          conversationId: "conv_history",
          messageId: "msg_assistant",
          type: "text",
          text: "阶段性回答。",
        },
        {
          id: "part_reasoning_2",
          conversationId: "conv_history",
          messageId: "msg_assistant",
          type: "reasoning",
          text: "第二段推理。",
        },
        {
          id: "part_text_2",
          conversationId: "conv_history",
          messageId: "msg_assistant",
          type: "text",
          text: "最终回答",
        },
      ],
    };

    expect(projectMessageHistory([message], "ai_sdk")[0]?.parts).toEqual([
      { type: "reasoning", text: "第一段推理。" },
      { type: "text", text: "阶段性回答。" },
      { type: "reasoning", text: "第二段推理。" },
      { type: "text", text: "最终回答" },
    ]);
  });
});
