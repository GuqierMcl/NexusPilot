import { describe, expect, test } from "bun:test";
import { modelMessageSchema } from "ai";

import type {
  AssistantMessage,
  Message,
  Part,
  ToolPart,
} from "../src/runtime/core/types";
import type { RuntimeAttachmentService } from "../src/runtime/attachments";
import { projectModelHistory } from "../src/runtime/projection/model-history-projection";

const baseAssistant = {
  id: "msg_assistant",
  conversationId: "conv_history",
  role: "assistant",
  runId: "run_history",
  parentId: "msg_user",
  providerId: "anthropic",
  modelId: "claude-sonnet",
  agentMode: "agent",
  status: { type: "complete", reason: "stop" },
  time: { created: 2, completed: 5 },
} satisfies Omit<AssistantMessage, "parts">;

function part<TPart extends Part>(value: TPart): TPart {
  return value;
}

describe("model history projection", () => {
  test("preserves user text and attachment order while keeping system role", async () => {
    const attachmentBytes = new Uint8Array([1, 2, 3, 4]);
    const attachmentService = {
      readBytes: async (attachmentId: string) => {
        expect(attachmentId).toBe("att_history");
        return attachmentBytes;
      },
    } as unknown as RuntimeAttachmentService;
    const messages: Message[] = [
      {
        id: "msg_system",
        conversationId: "conv_history",
        role: "system",
        scope: "runtime",
        parts: [part({
          id: "part_system",
          conversationId: "conv_history",
          messageId: "msg_system",
          type: "text",
          text: "Use the database facts.",
        })],
        time: { created: 0 },
      },
      {
        id: "msg_user",
        conversationId: "conv_history",
        role: "user",
        agentMode: "agent",
        parts: [
          part({
            id: "part_before",
            conversationId: "conv_history",
            messageId: "msg_user",
            type: "text",
            text: "before",
          }),
          part({
            id: "part_ignored",
            conversationId: "conv_history",
            messageId: "msg_user",
            type: "text",
            text: "ignored",
            ignored: true,
          }),
          part({
            id: "part_file",
            conversationId: "conv_history",
            messageId: "msg_user",
            type: "file",
            attachmentId: "att_history",
            mediaType: "application/octet-stream",
            filename: "facts.bin",
            byteLength: attachmentBytes.byteLength,
          }),
          part({
            id: "part_after",
            conversationId: "conv_history",
            messageId: "msg_user",
            type: "text",
            text: "after",
          }),
        ],
        time: { created: 1 },
      },
    ];

    expect(await projectModelHistory(messages, {
      target: { providerId: "anthropic", modelId: "claude-sonnet" },
      attachmentService,
    })).toEqual([
      { role: "system", content: "Use the database facts." },
      {
        role: "user",
        content: [
          { type: "text", text: "before" },
          {
            type: "file",
            mediaType: "application/octet-stream",
            filename: "facts.bin",
            data: { type: "data", data: attachmentBytes },
          },
          { type: "text", text: "after" },
        ],
      },
    ]);
  });

  test("replays same-model reasoning metadata and paired tool lifecycle by step", async () => {
    const messages: Message[] = [
      {
        id: "msg_user",
        conversationId: "conv_history",
        role: "user",
        agentMode: "agent",
        parts: [part({
          id: "part_user",
          conversationId: "conv_history",
          messageId: "msg_user",
          type: "text",
          text: "Inspect the database",
        })],
        time: { created: 1 },
      },
      {
        ...baseAssistant,
        parts: [
          part({
            id: "part_step_1",
            conversationId: "conv_history",
            messageId: "msg_assistant",
            type: "step-start",
            stepIndex: 0,
          }),
          part({
            id: "part_reasoning",
            conversationId: "conv_history",
            messageId: "msg_assistant",
            type: "reasoning",
            text: "I should inspect the schema.",
            metadata: {
              providerMetadata: { anthropic: { signature: "signed_1" } },
            },
          }),
          part({
            id: "part_empty_separator",
            conversationId: "conv_history",
            messageId: "msg_assistant",
            type: "text",
            text: "",
          }),
          part({
            id: "part_tool",
            conversationId: "conv_history",
            messageId: "msg_assistant",
            type: "tool",
            toolCallId: "tool_runtime",
            toolName: "schema.inspect",
            metadata: {
              aiSdkToolCallId: "call_provider",
              providerToolName: "np__schema__inspect",
              providerMetadata: { anthropic: { cacheControl: { type: "ephemeral" } } },
            },
            state: {
              status: "completed",
              input: { schema: "public" },
              output: { data: { tables: ["users"] } },
              title: "Inspect schema",
              time: { start: 3, end: 4 },
            },
          }),
          part({
            id: "part_step_2",
            conversationId: "conv_history",
            messageId: "msg_assistant",
            type: "step-start",
            stepIndex: 1,
          }),
          part({
            id: "part_answer",
            conversationId: "conv_history",
            messageId: "msg_assistant",
            type: "text",
            text: "The users table exists.",
            metadata: { providerMetadata: { anthropic: { itemId: "text_1" } } },
          }),
        ],
      },
    ];

    const original = structuredClone(messages);
    const projected = await projectModelHistory(messages, {
      target: { providerId: "anthropic", modelId: "claude-sonnet" },
    });

    expect(projected).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Inspect the database" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "I should inspect the schema.",
            providerOptions: { anthropic: { signature: "signed_1" } },
          },
          { type: "text", text: " " },
          {
            type: "tool-call",
            toolCallId: "call_provider",
            toolName: "np__schema__inspect",
            input: { schema: "public" },
            providerOptions: {
              anthropic: { cacheControl: { type: "ephemeral" } },
            },
          },
        ],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_provider",
          toolName: "np__schema__inspect",
          output: { type: "json", value: { data: { tables: ["users"] } } },
        }],
      },
      {
        role: "assistant",
        content: [{
          type: "text",
          text: "The users table exists.",
          providerOptions: { anthropic: { itemId: "text_1" } },
        }],
      },
    ]);
    expect(projected.map((message) => modelMessageSchema.parse(message))).toEqual(projected);
    expect(messages).toEqual(original);
  });

  test("converts reasoning to text and strips old provider metadata after model switch", async () => {
    const message: AssistantMessage = {
      ...baseAssistant,
      parts: [
        part({
          id: "part_reasoning",
          conversationId: "conv_history",
          messageId: "msg_assistant",
          type: "reasoning",
          text: "Prior reasoning",
          metadata: { providerMetadata: { anthropic: { signature: "old" } } },
        }),
        part({
          id: "part_empty_reasoning",
          conversationId: "conv_history",
          messageId: "msg_assistant",
          type: "reasoning",
          text: "   ",
          metadata: { providerMetadata: { anthropic: { signature: "empty" } } },
        }),
        part({
          id: "part_text",
          conversationId: "conv_history",
          messageId: "msg_assistant",
          type: "text",
          text: "Prior answer",
          metadata: { providerMetadata: { anthropic: { itemId: "old_text" } } },
        }),
        part({
          id: "part_empty_separator",
          conversationId: "conv_history",
          messageId: "msg_assistant",
          type: "text",
          text: "",
        }),
        part({
          id: "part_tool",
          conversationId: "conv_history",
          messageId: "msg_assistant",
          type: "tool",
          toolCallId: "tool_runtime",
          toolName: "schema.inspect",
          metadata: {
            aiSdkToolCallId: "call_provider",
            providerToolName: "np__schema__inspect",
            providerMetadata: { anthropic: { itemId: "old_call" } },
          },
          state: {
            status: "error",
            input: { schema: "private" },
            error: {
              code: "PERMISSION_DENIED",
              message: "Access denied",
              retryable: false,
            },
            time: { start: 3, end: 4 },
          },
        }),
      ],
    };

    expect(await projectModelHistory([message], {
      target: { providerId: "openai", modelId: "gpt-5" },
    })).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Prior reasoning" },
          { type: "text", text: "Prior answer" },
          {
            type: "tool-call",
            toolCallId: "call_provider",
            toolName: "np__schema__inspect",
            input: { schema: "private" },
          },
        ],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_provider",
          toolName: "np__schema__inspect",
          output: { type: "error-text", value: "Access denied" },
        }],
      },
    ]);
  });

  test("closes every historical non-terminal tool call without mutating Runtime facts", async () => {
    const states = [
      "pending",
      "validating",
      "waiting_for_permission",
      "running",
      "interrupted",
    ] as const;
    const parts = states.map((status, index) => part({
      id: `part_tool_${index}`,
      conversationId: "conv_history",
      messageId: "msg_assistant",
      type: "tool" as const,
      toolCallId: `tool_${index}`,
      toolName: "sql.execute",
      state: status === "pending"
        ? { status, input: { index } }
        : status === "validating"
          ? { status, input: { index }, time: { start: 2 } }
          : status === "waiting_for_permission"
            ? {
                status,
                input: { index },
                permissionId: `perm_${index}`,
                time: { start: 2 },
              }
            : status === "running"
              ? { status, input: { index }, time: { start: 2 } }
              : {
                  status,
                  input: { index },
                  reason: "Stopped by user",
                  time: { start: 2, end: 3 },
                },
    })) as ToolPart[];
    const message: AssistantMessage = { ...baseAssistant, parts };
    const original = structuredClone(message);

    const projected = await projectModelHistory([message], {
      target: { providerId: "anthropic", modelId: "claude-sonnet" },
    });

    expect(projected[0]).toMatchObject({
      role: "assistant",
      content: states.map((_, index) => ({
        type: "tool-call",
        toolCallId: `tool_${index}`,
        toolName: "sql.execute",
        input: { index },
      })),
    });
    expect(projected[1]).toEqual({
      role: "tool",
      content: states.map((status, index) => ({
        type: "tool-result",
        toolCallId: `tool_${index}`,
        toolName: "sql.execute",
        output: {
          type: "error-text",
          value: status === "interrupted"
            ? "Stopped by user"
            : "[Tool execution was interrupted]",
        },
      })),
    });
    expect(message).toEqual(original);
  });
});
