import { describe, expect, test } from "bun:test";
import { mapAiSdkUsage } from "../src/runtime";

describe("mapAiSdkUsage", () => {
  test("maps AI SDK 7 language model usage to runtime token usage", () => {
    expect(
      mapAiSdkUsage({
        inputTokens: 10,
        inputTokenDetails: {
          noCacheTokens: 7,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
        },
        outputTokens: 5,
        outputTokenDetails: {
          textTokens: 3,
          reasoningTokens: 2,
        },
        totalTokens: 15,
      }),
    ).toEqual({
      input: 10,
      output: 5,
      reasoning: 2,
      cache: {
        read: 2,
        write: 1,
      },
      total: 15,
    });
  });

  test("uses zero defaults when a provider omits optional token counts", () => {
    expect(
      mapAiSdkUsage({
        inputTokens: undefined,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens: undefined,
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
        totalTokens: undefined,
      }),
    ).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      total: 0,
    });
  });
});
