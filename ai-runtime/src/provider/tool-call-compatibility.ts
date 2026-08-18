import {
  APICallError,
  generateText,
  isStepCount,
  tool,
} from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";

const TOOL_CALL_PROBE_NAME = "nexus_tool_probe";
const TOOL_CALL_PROBE_TIMEOUT_MS = 15_000;

export type ToolCallCompatibilityFailureReason =
  | "authentication"
  | "model_unavailable"
  | "unsupported"
  | "timeout"
  | "network"
  | "unknown";

export type ToolCallCompatibilityResult =
  | {
      supported: true;
      message: string;
    }
  | {
      supported: false;
      reason: ToolCallCompatibilityFailureReason;
      message: string;
    };

export interface TestOpenAICompatibleToolCallingInput {
  apiBase: string;
  apiKey: string;
  modelId: string;
}

export interface TestOpenAICompatibleToolCallingOptions {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

/**
 * Verifies the OpenAI-compatible tool-call wire protocol without loading any
 * Runtime Tool, connection, or persisted provider configuration.
 */
export async function testOpenAICompatibleToolCalling(
  input: TestOpenAICompatibleToolCallingInput,
  options: TestOpenAICompatibleToolCallingOptions = {},
): Promise<ToolCallCompatibilityResult> {
  const apiBase = input.apiBase.trim();
  const apiKey = input.apiKey.trim();
  const modelId = input.modelId.trim();
  if (!apiBase || !apiKey || !modelId) {
    return {
      supported: false,
      reason: "unknown",
      message: "请填写 API Base、API 密钥和模型 ID 后再测试。",
    };
  }

  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(),
    TOOL_CALL_PROBE_TIMEOUT_MS,
  );
  let executed = false;

  try {
    const result = await generateText({
      model: createOpenAICompatible({
        name: "nexpilot-tool-call-probe",
        apiKey,
        baseURL: apiBase,
        fetch: options.fetch as typeof fetch | undefined,
      }).languageModel(modelId),
      tools: {
        [TOOL_CALL_PROBE_NAME]: tool({
          description:
            "NexusPilot compatibility probe. Call this tool exactly once and do not perform any other action.",
          inputSchema: z.object({
            nonce: z.string().min(1).describe("A non-empty probe marker."),
          }),
          execute: async () => {
            executed = true;
            return { ok: true };
          },
        }),
      },
      toolChoice: { type: "tool", toolName: TOOL_CALL_PROBE_NAME },
      prompt: `Call ${TOOL_CALL_PROBE_NAME} exactly once with nonce "nexpilot-tool-call-probe".`,
      stopWhen: isStepCount(1),
      abortSignal: abortController.signal,
      maxRetries: 0,
    });

    const calledProbe = result.toolCalls.some(
      (toolCall) => toolCall.toolName === TOOL_CALL_PROBE_NAME,
    );
    if (calledProbe && executed) {
      return {
        supported: true,
        message: "已验证：该模型支持 OpenAI-compatible 工具调用。",
      };
    }

    return {
      supported: false,
      reason: "unsupported",
      message: "该模型未按 OpenAI-compatible 格式返回工具调用。",
    };
  } catch (error) {
    return compatibilityFailure(error, abortController.signal.aborted);
  } finally {
    clearTimeout(timeout);
  }
}

function compatibilityFailure(
  error: unknown,
  timedOut: boolean,
): ToolCallCompatibilityResult {
  if (timedOut) {
    return {
      supported: false,
      reason: "timeout",
      message: "工具调用测试超时，请检查模型服务状态后重试。",
    };
  }

  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return {
        supported: false,
        reason: "authentication",
        message: "API 密钥无效，或没有调用该模型的权限。",
      };
    }
    if (error.statusCode === 404) {
      return {
        supported: false,
        reason: "model_unavailable",
        message: "找不到该模型，或该 API Base 不支持该模型。",
      };
    }
    if (error.statusCode === 400 || error.statusCode === 422) {
      return {
        supported: false,
        reason: "unsupported",
        message: "该服务拒绝了工具调用请求，可能不兼容 OpenAI 的 tools 协议。",
      };
    }
  }

  if (error instanceof TypeError) {
    return {
      supported: false,
      reason: "network",
      message: "无法连接到 API Base，请检查地址和网络。",
    };
  }

  return {
    supported: false,
    reason: "unknown",
    message: "工具调用测试失败，请检查模型服务配置后重试。",
  };
}
