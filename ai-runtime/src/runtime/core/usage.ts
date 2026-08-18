import type { LanguageModelUsage } from "ai";
import type { TokenUsage } from "./types";

function numberOrZero(value: number | undefined): number {
  return typeof value === "number" ? value : 0;
}

export function mapAiSdkUsage(usage: LanguageModelUsage | undefined): TokenUsage {
  const input = numberOrZero(usage?.inputTokens);
  const output = numberOrZero(usage?.outputTokens);
  const reasoning = numberOrZero(usage?.outputTokenDetails.reasoningTokens);
  const cacheRead = numberOrZero(usage?.inputTokenDetails.cacheReadTokens);
  const cacheWrite = numberOrZero(usage?.inputTokenDetails.cacheWriteTokens);
  const total = numberOrZero(usage?.totalTokens) || input + output;

  return {
    input,
    output,
    reasoning,
    ...(cacheRead > 0 || cacheWrite > 0
      ? {
          cache: {
            read: cacheRead,
            write: cacheWrite,
          },
        }
      : {}),
    total,
  };
}
