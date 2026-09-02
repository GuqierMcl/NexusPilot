import { describe, expect, test } from "bun:test";
import {
  parseRunContinueRequestBody,
  parseRunCreateRequestBody,
} from "../src/routes/run-schema";

describe("parseRunCreateRequestBody", () => {
  test("parses part-based stream run creation request", () => {
    expect(
      parseRunCreateRequestBody({
        response_mode: "stream",
        conversation_id: "conv_1234567890",
        model: {
          provider_id: "openai",
          model_id: "gpt-4o",
        },
        agent_mode: "ask",
        input: {
          parts: [
            {
              type: "text",
              text: "Hello",
            },
          ],
        },
        metadata: {
          client_request_id: "req_1",
        },
      }),
    ).toEqual({
      responseMode: "stream",
      runRequest: {
        conversationId: "conv_1234567890",
        providerId: "openai",
        modelId: "gpt-4o",
        text: "Hello",
        parts: [{ type: "text", text: "Hello" }],
        agentMode: "ask",
        metadata: {
          client_request_id: "req_1",
        },
      },
    });
  });

  test("joins multiple text parts into the internal text runner prompt", () => {
    expect(
      parseRunCreateRequestBody({
        response_mode: "stream",
        model: {
          provider_id: "openai",
          model_id: "gpt-4o",
        },
        input: {
          parts: [
            {
              type: "text",
              text: "First",
            },
            {
              type: "text",
              text: "Second",
            },
          ],
        },
      })?.runRequest.text,
    ).toBe("First\n\nSecond");
  });

  test("accepts a pure final attachment id and preserves mixed part order", () => {
    expect(
      parseRunCreateRequestBody({
        response_mode: "stream",
        model: { provider_id: "openai", model_id: "gpt-4o" },
        input: {
          parts: [
            { type: "file", attachment_id: "att_first" },
            { type: "text", text: "Describe it" },
            { type: "file", attachment_id: "att_second" },
          ],
        },
      })?.runRequest,
    ).toMatchObject({
      text: "Describe it",
      parts: [
        { type: "file", attachmentId: "att_first" },
        { type: "text", text: "Describe it" },
        { type: "file", attachmentId: "att_second" },
      ],
    });

    expect(
      parseRunCreateRequestBody({
        response_mode: "stream",
        model: { provider_id: "openai", model_id: "gpt-4o" },
        input: { parts: [{ type: "file", attachment_id: "att_only" }] },
      })?.runRequest.text,
    ).toBe("");
  });

  test("rejects upload ids, URLs, paths and client-provided file metadata", () => {
    const create = (part: Record<string, unknown>) => parseRunCreateRequestBody({
      response_mode: "stream",
      model: { provider_id: "openai", model_id: "gpt-4o" },
      input: { parts: [part] },
    });
    expect(create({ type: "file", attachment_id: "upl_pending" })).toBeNull();
    expect(create({ type: "file", attachment_id: "https://example.com/a.png" })).toBeNull();
    expect(create({ type: "file", attachment_id: "C:\\a.png" })).toBeNull();
    expect(create({
      type: "file",
      attachment_id: "att_valid",
      filename: "spoof.png",
    })).toBeNull();
  });

  test("parses an edited-message replacement boundary only with a Runtime conversation", () => {
    expect(
      parseRunCreateRequestBody({
        response_mode: "stream",
        conversation_id: "conv_1234567890",
        replace_from_message_id: "msg_1234567890",
        model: {
          provider_id: "openai",
          model_id: "gpt-4o",
        },
        input: {
          parts: [{ type: "text", text: "Rewrite this question" }],
        },
      })?.runRequest,
    ).toMatchObject({
      conversationId: "conv_1234567890",
      replaceFromMessageId: "msg_1234567890",
    });

    expect(
      parseRunCreateRequestBody({
        response_mode: "stream",
        replace_from_message_id: "msg_1234567890",
        model: {
          provider_id: "openai",
          model_id: "gpt-4o",
        },
        input: {
          parts: [{ type: "text", text: "Rewrite this question" }],
        },
      }),
    ).toBeNull();
  });

  test("accepts query as an explicit agent mode", () => {
    expect(
      parseRunCreateRequestBody({
        response_mode: "stream",
        model: {
          provider_id: "openai",
          model_id: "gpt-4o",
        },
        agent_mode: "query",
        input: {
          parts: [
            {
              type: "text",
              text: "List tables",
            },
          ],
        },
      })?.runRequest.agentMode,
    ).toBe("query");
  });

  test("rejects missing explicit response mode", () => {
    expect(
      parseRunCreateRequestBody({
        model: {
          provider_id: "openai",
          model_id: "gpt-4o",
        },
        input: {
          parts: [
            {
              type: "text",
              text: "Hello",
            },
          ],
        },
      }),
    ).toBeNull();
  });

  test("rejects unsupported response mode", () => {
    expect(
      parseRunCreateRequestBody({
        response_mode: "json",
        model: {
          provider_id: "openai",
          model_id: "gpt-4o",
        },
        input: {
          parts: [
            {
              type: "text",
              text: "Hello",
            },
          ],
        },
      }),
    ).toBeNull();
  });

  test("rejects legacy top-level text body", () => {
    expect(
      parseRunCreateRequestBody({
        response_mode: "stream",
        provider_id: "openai",
        model_id: "gpt-4o",
        text: "Hello",
      }),
    ).toBeNull();
  });

  test("rejects message-array-only body", () => {
    expect(
      parseRunCreateRequestBody({
        response_mode: "stream",
        model: {
          provider_id: "openai",
          model_id: "gpt-4o",
        },
        messages: [],
      }),
    ).toBeNull();
  });

  test("rejects internal control fields in public request", () => {
    const baseBody = {
      response_mode: "stream",
      model: {
        provider_id: "openai",
        model_id: "gpt-4o",
      },
      input: {
        parts: [
          {
            type: "text",
            text: "Hello",
          },
        ],
      },
    };

    expect(parseRunCreateRequestBody({ ...baseBody, system: "You are helpful" })).toBeNull();
    expect(parseRunCreateRequestBody({ ...baseBody, limits: { maxOutputTokens: 128 } })).toBeNull();
    expect(parseRunCreateRequestBody({ ...baseBody, title: "Manual title" })).toBeNull();
    expect(parseRunCreateRequestBody({ ...baseBody, tools: { web_fetch: true } })).toBeNull();
    expect(parseRunCreateRequestBody({ ...baseBody, profile_id: "database-agent" })).toBeNull();
  });

  test("rejects old mode field after agent_mode migration", () => {
    expect(
      parseRunCreateRequestBody({
        response_mode: "stream",
        model: {
          provider_id: "openai",
          model_id: "gpt-4o",
        },
        mode: "ask",
        input: {
          parts: [
            {
              type: "text",
              text: "Hello",
            },
          ],
        },
      }),
    ).toBeNull();
  });

  test("rejects unsupported input part types in the first version", () => {
    expect(
      parseRunCreateRequestBody({
        response_mode: "stream",
        model: {
          provider_id: "openai",
          model_id: "gpt-4o",
        },
        input: {
          parts: [
            {
              type: "file",
              mime_type: "application/pdf",
              url: "https://example.com/a.pdf",
            },
          ],
        },
      }),
    ).toBeNull();
  });

  test("rejects malformed runtime conversation id", () => {
    expect(
      parseRunCreateRequestBody({
        response_mode: "stream",
        conversation_id: "not-a-runtime-id",
        model: {
          provider_id: "openai",
          model_id: "gpt-4o",
        },
        input: {
          parts: [
            {
              type: "text",
              text: "Hello",
            },
          ],
        },
      }),
    ).toBeNull();
  });
});

describe("parseRunContinueRequestBody", () => {
  test("accepts only Runtime Permission decisions", () => {
    expect(
      parseRunContinueRequestBody({
        permission_responses: [
          {
            permission_id: "perm_1234567890",
            approved: true,
            confirmation_text: "确认执行",
            reason: "approved once",
          },
          {
            permission_id: "perm_0987654321",
            approved: false,
          },
        ],
      }),
    ).toEqual({
      permissionResponses: [
        {
          permissionId: "perm_1234567890",
          approved: true,
          confirmationText: "确认执行",
          reason: "approved once",
        },
        {
          permissionId: "perm_0987654321",
          approved: false,
        },
      ],
    });
  });

  test("rejects empty, malformed, and message-history continuation bodies", () => {
    expect(parseRunContinueRequestBody({ permission_responses: [] })).toBeNull();
    expect(
      parseRunContinueRequestBody({
        permission_responses: [{
          permission_id: "not-a-permission",
          approved: true,
        }],
      }),
    ).toBeNull();
    expect(
      parseRunContinueRequestBody({
        permission_responses: [{
          permission_id: "perm_1234567890",
          approved: true,
        }],
        messages: [],
      }),
    ).toBeNull();
  });
});
