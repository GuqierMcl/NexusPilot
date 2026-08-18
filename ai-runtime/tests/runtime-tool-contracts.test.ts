import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type {
  DynamicRuntimeToolDefinition,
  JsonObject,
  RuntimeToolResult,
  StaticRuntimeToolDefinition,
  ToolPermission,
} from "../src/runtime/tools/contracts";

describe("Runtime Tool base contracts", () => {
  test("models the stable success and error envelopes", () => {
    const success: RuntimeToolResult<{ count: number }> = {
      ok: true,
      summary: "Found one connection.",
      data: { count: 1 },
    };
    const failure: RuntimeToolResult<never> = {
      ok: false,
      error: {
        code: "BACKEND_BRIDGE_UNAVAILABLE",
        message: "Backend capability connection is unavailable.",
        retryable: true,
        outcome: "not_started",
      },
    };

    expect(success.ok && success.data.count).toBe(1);
    expect(!failure.ok && failure.error.outcome).toBe("not_started");
    expect(JSON.parse(JSON.stringify([success, failure]))).toEqual([success, failure]);
  });

  test("keeps metadata JSON-only", () => {
    const metadata: JsonObject = {
      category: "network",
      tags: ["web", "read"],
      diagnostics: { enabled: true, sampleRate: 0.25 },
    };

    expect(JSON.parse(JSON.stringify(metadata))).toEqual(metadata);
  });

  test("separates static and dynamic risk definitions", () => {
    const inputSchema = z.object({ statement: z.string() }).strict();
    const outputSchema = z.object({ accepted: z.boolean() }).strict();
    const execute = async () => ({ summary: "Done.", data: { accepted: true } });

    const staticTool: StaticRuntimeToolDefinition<
      z.infer<typeof inputSchema>,
      z.infer<typeof outputSchema>
    > = {
      id: "query.inspect",
      title: "Inspect query",
      description: "Inspect a query without executing it.",
      inputSchema,
      outputSchema,
      executionTarget: "backend",
      risk: { mode: "static", level: "low", reversible: true, sideEffect: "business_read" },
      execute,
    };
    const dynamicTool: DynamicRuntimeToolDefinition<
      z.infer<typeof inputSchema>,
      z.infer<typeof outputSchema>
    > = {
      ...staticTool,
      id: "query.execute",
      risk: {
        mode: "dynamic",
        level: "low",
        reversible: "conditional",
        sideEffect: "business_read",
      },
      resolveRisk: async () => ({
        level: "high",
        reversible: false,
        sideEffects: ["business_write"],
      }),
    };

    expect(staticTool.risk.mode).toBe("static");
    expect(dynamicTool.risk.mode).toBe("dynamic");
  });

  test("binds permission to one immutable Runtime tool call identity", () => {
    const permission = {
      id: "perm_01",
      conversationId: "conv_01",
      runId: "run_01",
      messageId: "msg_01",
      toolCallId: "tool_01",
      status: "pending",
      toolId: "query.execute",
      title: "Execute query",
      risk: {
        level: "high",
        reversible: false,
        sideEffects: ["business_write"],
      },
      confirmation: { level: "standard" },
      createdAt: 1,
    } as ToolPermission;

    expect(permission.status).toBe("pending");
    expect(permission.toolCallId).toBe("tool_01");
    expect(JSON.parse(JSON.stringify(permission))).toEqual(permission);
  });
});
