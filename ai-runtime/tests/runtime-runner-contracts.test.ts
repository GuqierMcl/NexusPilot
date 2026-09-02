import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RUN_LIMITS,
  isTerminalRunState,
  normalizeRunRequest,
  type RunRequest,
} from "../src/runtime";

describe("Runtime Runner contracts", () => {
  test("normalizes minimal run request defaults", () => {
    const request: RunRequest = {
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Explain this query",
      parts: [{ type: "text", text: "Explain this query" }],
    };

    expect(normalizeRunRequest(request)).toEqual({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Explain this query",
      parts: [{ type: "text", text: "Explain this query" }],
      agentMode: "ask",
      title: "Explain this query",
      titleSource: "fallback",
      metadata: undefined,
      conversationId: undefined,
      runId: undefined,
      userMessageId: undefined,
      limits: DEFAULT_RUN_LIMITS,
      executionPolicy: {
        prompt: {
          version: "runtime-prompt-v2",
          blockIds: [
            "runtime.base",
            "runtime.agent_modes",
            "agent.behavior",
            "runtime.boundaries",
            "output.style",
          ],
          warnings: [],
        },
        limits: DEFAULT_RUN_LIMITS,
        trace: {
          promptAssemblyVersion: "runtime-prompt-v2",
          promptBlockIds: [
            "runtime.base",
            "runtime.agent_modes",
            "agent.behavior",
            "runtime.boundaries",
            "output.style",
          ],
          enabledToolNames: [],
          activeToolNames: [],
          warnings: [],
        },
      },
    });
  });

  test("trims user text and uses explicit execution policy", () => {
    const normalized = normalizeRunRequest({
      providerId: "anthropic",
      modelId: "claude-sonnet-4-5",
      text: "  Diagnose index usage  ",
      agentMode: "agent",
      executionPolicy: {
        prompt: {
          version: "runtime-prompt-v1",
          blockIds: ["runtime.base", "agent.behavior", "tool.usage"],
          warnings: [],
        },
        tools: {
          snapshotId: "tool_snapshot_1",
          runId: "run_1",
          createdAt: new Date(0).toISOString(),
          agentMode: "agent",
          executionCeiling: {
            maxRiskLevel: "low",
            allowedSideEffects: ["external_network"],
            allowIrreversible: false,
          },
          activeTools: [
            { canonicalId: "web.fetch", providerName: "np__web__fetch" },
          ],
        },
        limits: { maxSteps: 4, maxToolCalls: 8, timeoutMs: 30_000 },
        trace: {
          promptAssemblyVersion: "runtime-prompt-v1",
          promptBlockIds: ["runtime.base", "agent.behavior", "tool.usage"],
          enabledToolNames: ["web_fetch"],
          activeToolNames: ["web_fetch"],
          warnings: [],
        },
      },
    });

    expect(normalized.text).toBe("Diagnose index usage");
    expect(normalized.agentMode).toBe("agent");
    expect(normalized.limits).toEqual({ maxSteps: 4, maxToolCalls: 8, timeoutMs: 30_000 });
    expect(normalized.executionPolicy.tools?.activeTools).toEqual([
      { canonicalId: "web.fetch", providerName: "np__web__fetch" },
    ]);
  });

  test("rejects empty text input", () => {
    expect(() =>
      normalizeRunRequest({
        providerId: "openai",
        modelId: "gpt-4o",
        text: "   ",
      }),
    ).toThrow("RunRequest text parts must not be empty");
  });

  test("identifies terminal run states", () => {
    expect(isTerminalRunState("queued")).toBe(false);
    expect(isTerminalRunState("running")).toBe(false);
    expect(isTerminalRunState("completed")).toBe(true);
    expect(isTerminalRunState("failed")).toBe(true);
    expect(isTerminalRunState("interrupted")).toBe(true);
  });
});
