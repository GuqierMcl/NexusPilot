import { describe, expect, test } from "bun:test";

import {
  classifyContextOverflow,
  recoverContextOverflow,
  type ContextOverflowRetryGate,
} from "../src/runtime/context/overflow-recovery";

const activeRun = {
  id: "run_overflow",
  conversationId: "conv_overflow",
} as never;
const activeConversation = {
  id: "conv_overflow",
  activeHeadRunId: "run_overflow",
} as never;

function freshGate(): ContextOverflowRetryGate {
  return {
    runId: "run_overflow" as never,
    attempted: false,
    modelOutputObserved: false,
    toolLifecycleObserved: false,
    permissionObserved: false,
    sideEffectObserved: false,
  };
}

describe("provider context overflow recovery", () => {
  test.each([
    [{ name: "ProviderError", code: "context_length_exceeded", message: "request rejected" }],
    [{ name: "ProviderError", message: "context_length_exceeded", statusCode: 400 }],
    [{ name: "ProviderError", message: "Maximum context length\nexceeded for this model" }],
    [{ name: "ProviderError", message: "context window exceeded" }],
    [{ name: "ProviderError", message: "prompt too long" }],
    [{ name: "ProviderError", message: "too many tokens" }],
  ] as Array<[{ name: string; code?: string; message: string; statusCode?: number }]>)
  ("classifies only explicit bounded provider overflows: %p", (error) => {
    const before = structuredClone(error);
    const classified = classifyContextOverflow(error);

    expect(classified.overflow).toBe(true);
    expect(classified.original).toEqual({
      name: "ProviderError",
      data: {
        message: error.message,
        ...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
      },
    });
    expect(error).toEqual(before);
  });

  test.each([
    { name: "ProviderAuthError", message: "context length exceeded", statusCode: 401 },
    { name: "AuthorizationError", message: "prompt too long", statusCode: 403 },
    { name: "RateLimitError", message: "maximum context length", statusCode: 429 },
    { name: "RequestTimeoutError", message: "too many tokens", statusCode: 408 },
    { name: "NetworkError", message: "context window exceeded while reconnecting" },
    { name: "InvalidToolInputError", message: "prompt too long" },
    { name: "UnsupportedAttachmentError", message: "too many tokens in attachment" },
    { name: "UnsupportedModelError", message: "prompt too long" },
    { name: "ModelNotFoundError", message: "maximum context length" },
    { name: "ModelDisabledError", message: "context window exceeded" },
    { name: "ToolExecutionError", message: "too many tokens" },
    {
      name: "ProviderError",
      code: "model_not_found",
      message: "context length exceeded",
    },
    {
      name: "ProviderError",
      code: "tool_execution_error",
      message: "prompt too long",
    },
  ])("fails closed for non-overflow provider classes: %p", (error) => {
    expect(classifyContextOverflow(error).overflow).toBe(false);
  });

  test.each([
    "attempted",
    "modelOutputObserved",
    "toolLifecycleObserved",
    "permissionObserved",
    "sideEffectObserved",
  ] as const)("rejects retry when %s is set", async (field) => {
    const gate = freshGate();
    gate[field] = true;

    await expect(recoverContextOverflow({
      error: { name: "ProviderError", message: "context length exceeded" },
      gate,
      currentRun: activeRun,
      currentConversation: activeConversation,
    })).resolves.toBe("fail");
  });

  test("allows exactly the first explicit overflow while the run remains the active head", async () => {
    await expect(recoverContextOverflow({
      error: { name: "ProviderError", message: "context_length_exceeded" },
      gate: freshGate(),
      currentRun: activeRun,
      currentConversation: activeConversation,
    })).resolves.toBe("retry");
  });
});
