import { describe, expect, test } from "bun:test";

import { runtimeErrorSchema } from "../src/runtime/core/schemas";
import {
  modelErrorMessage,
  toRuntimeModelError,
} from "../src/runtime/runners/model-error";

describe("model execution error normalization", () => {
  test("preserves an Error name and multiline message exactly", () => {
    const error = new Error(
      "maximum context length exceeded\nrequest id: abc",
    );
    error.name = "APICallError";

    const runtimeError = toRuntimeModelError(error);
    expect(runtimeError).toEqual({
      name: "APICallError",
      data: {
        message: "maximum context length exceeded\nrequest id: abc",
      },
    });
    expect(runtimeErrorSchema.parse(runtimeError)).toEqual(runtimeError);
    expect(modelErrorMessage(error)).toBe(error.message);
  });

  test("keeps only explicitly supplied safe scalar fields", () => {
    const error = {
      name: "ProviderResponseError",
      message: "upstream rejected the request",
      statusCode: 429,
      isRetryable: true,
      stack: "secret stack",
      headers: { authorization: "Bearer secret" },
      requestBody: "secret request",
      responseBody: "secret response",
      response: { provider: "complete response" },
    };

    expect(toRuntimeModelError(error)).toEqual({
      name: "ProviderResponseError",
      data: {
        message: "upstream rejected the request",
        statusCode: 429,
        isRetryable: true,
      },
    });
  });

  test("does not fabricate retryability or a provider error name", () => {
    expect(toRuntimeModelError("plain failure")).toEqual({
      name: "Error",
      data: { message: "plain failure" },
    });
    expect(toRuntimeModelError({ message: "object failure" })).toEqual({
      name: "Error",
      data: { message: "object failure" },
    });
  });

  test("redacts only exact Runtime-known secrets", () => {
    expect(modelErrorMessage(
      new Error("key=sk-live-123; url=https://example.com/sk-live"),
      ["sk-live-123"],
    )).toBe("key=[REDACTED]; url=https://example.com/sk-live");
    expect(modelErrorMessage(
      new Error("long=sk-live-123; short=sk-live"),
      ["sk-live", "sk-live-123"],
    )).toBe("long=[REDACTED]; short=[REDACTED]");
  });

  test("uses a stable fallback only when no usable message exists", () => {
    expect(toRuntimeModelError({ name: "OddFailure" })).toEqual({
      name: "UnknownError",
      data: { message: "Unknown model execution error" },
    });
  });
});
