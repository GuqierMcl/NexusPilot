import { describe, expect, test } from "bun:test";
import { testOpenAICompatibleToolCalling } from "../src/provider/tool-call-compatibility";

describe("testOpenAICompatibleToolCalling", () => {
  test("verifies a forced, no-op OpenAI-compatible tool call", async () => {
    const result = await testOpenAICompatibleToolCalling(
      {
        apiBase: "https://proxy.example.com/v1",
        apiKey: "probe-key",
        modelId: "model-a",
      },
      {
        fetch: async (input, init) => {
          expect(String(input)).toBe("https://proxy.example.com/v1/chat/completions");
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer probe-key");
          const body = JSON.parse(String(init?.body)) as {
            tools?: Array<{ function?: { name?: string } }>;
            tool_choice?: { function?: { name?: string } };
          };
          expect(body.tools?.[0]?.function?.name).toBe("nexus_tool_probe");
          expect(body.tool_choice?.function?.name).toBe("nexus_tool_probe");

          return Response.json({
            id: "chatcmpl_probe",
            object: "chat.completion",
            created: 1,
            model: "model-a",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_probe",
                      type: "function",
                      function: {
                        name: "nexus_tool_probe",
                        arguments: '{"nonce":"verified"}',
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          });
        },
      },
    );

    expect(result).toEqual({
      supported: true,
      message: "已验证：该模型支持 OpenAI-compatible 工具调用。",
    });
  });

  test("classifies an upstream tools rejection without exposing its response", async () => {
    const result = await testOpenAICompatibleToolCalling(
      {
        apiBase: "https://proxy.example.com/v1",
        apiKey: "probe-key",
        modelId: "model-a",
      },
      {
        fetch: async () => new Response("tools are unsupported", { status: 400 }),
      },
    );

    expect(result).toEqual({
      supported: false,
      reason: "unsupported",
      message: "该服务拒绝了工具调用请求，可能不兼容 OpenAI 的 tools 协议。",
    });
  });
});
