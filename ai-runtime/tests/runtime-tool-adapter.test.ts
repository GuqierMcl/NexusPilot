import { describe, expect, test } from "bun:test";
import { asSchema } from "ai";
import type {
  Event,
  Permission,
  ToolCall,
  TraceEvent,
} from "../src/runtime/core/types";
import {
  createConnectionToolNamespace,
  createKeyValueToolNamespace,
  createMetadataToolNamespace,
  createSqlToolNamespace,
  createSystemToolNamespace,
  createTableToolNamespace,
  createWebToolNamespace,
  RuntimeToolCore,
  RuntimeToolExecutionError,
  RuntimeToolRegistry,
  runtimeToolsToAiSdkToolSet,
  type RunToolSnapshot,
} from "../src/runtime";

describe("Runtime AI SDK Tool adapter", () => {
  test("serializes every production Tool input as a top-level object schema", async () => {
    const registry = new RuntimeToolRegistry([
      createConnectionToolNamespace(),
      createMetadataToolNamespace(),
      createSqlToolNamespace(),
      createTableToolNamespace(),
      createKeyValueToolNamespace(),
      createSystemToolNamespace(),
      createWebToolNamespace(),
    ]);
    const incompatibleSchemas: Array<{
      toolId: string;
      type: unknown;
    }> = [];

    for (const definition of registry.listTools()) {
      const jsonSchema = await asSchema(definition.inputSchema).jsonSchema;
      if (jsonSchema.type !== "object") {
        incompatibleSchemas.push({
          toolId: definition.id,
          type: jsonSchema.type ?? null,
        });
      }
    }

    expect(incompatibleSchemas).toEqual([]);
  });

  test("exposes only Snapshot active Provider names and delegates to Core", async () => {
    const registry = new RuntimeToolRegistry([createWebToolNamespace()]);
    const calls: ToolCall[] = [];
    const permissions: Permission[] = [];
    const core = new RuntimeToolCore({
      registry,
      store: {
        saveToolCall: (call) => {
          const index = calls.findIndex((item) => item.id === call.id);
          if (index >= 0) calls[index] = call;
          else calls.push(call);
        },
        getToolCall: (id) => calls.find((call) => call.id === id) ?? null,
        listToolCallsByRun: () => calls,
        getPermissionByToolCallId: (toolCallId) =>
          permissions.find((permission) => permission.toolCallId === toolCallId) ??
          null,
        commitToolPermissionRequest: ({ toolCall, permission }) => {
          calls.push(toolCall);
          permissions.push(permission);
        },
        appendEvent: (_event: Event) => {},
        appendTrace: (_trace: TraceEvent) => {},
      },
    });
    const snapshot: RunToolSnapshot = Object.freeze({
      snapshotId: "tool_snapshot_adapter",
      runId: "run_adapter",
      createdAt: new Date(0).toISOString(),
      agentMode: "ask",
      executionCeiling: Object.freeze({
        maxRiskLevel: "low",
        allowedSideEffects: Object.freeze(["external_network"] as const),
        allowIrreversible: false,
      }),
      activeTools: Object.freeze([
        Object.freeze({
          canonicalId: "web.fetch",
          providerName: "np__web__fetch",
        }),
      ]),
    });
    const adapted = runtimeToolsToAiSdkToolSet({
      registry,
      core,
      snapshot,
      conversationId: "conv_adapter",
      messageId: "msg_adapter",
      resolveIdentity: () => ({
        toolCallId: "tool_adapter",
        partId: "part_adapter",
      }),
    });

    expect(Object.keys(adapted.tools)).toEqual(["np__web__fetch"]);
    expect(adapted.activeTools).toEqual(["np__web__fetch"]);
    expect(adapted.tools.np__web__fetch.description).toContain("HTTP(S)");
    expect(adapted.tools.np__web__fetch.description).not.toContain(
      "NETWORK_ACCESS_SCOPE_DENIED",
    );
    expect(adapted.tools.np__web__fetch.description).not.toContain(
      "网络访问范围",
    );
  });

  test("maps authorization errors to an automatic denial without rejecting toolApproval", async () => {
    const registry = new RuntimeToolRegistry([createSqlToolNamespace()]);
    const calls: ToolCall[] = [];
    const permissions: Permission[] = [];
    const core = new RuntimeToolCore({
      registry,
      backendExecutor: {
        prepare: async () => {
          throw new RuntimeToolExecutionError(
            "MUTATION_OUTCOME_UNKNOWN",
            "The database stopped responding while preparing the operation.",
            false,
            "unknown",
          );
        },
        execute: async () => {
          throw new Error("execute must not be reached");
        },
      },
      store: {
        saveToolCall: (call) => {
          const index = calls.findIndex((item) => item.id === call.id);
          if (index >= 0) calls[index] = call;
          else calls.push(call);
        },
        getToolCall: (id) => calls.find((call) => call.id === id) ?? null,
        listToolCallsByRun: () => calls,
        getPermissionByToolCallId: (toolCallId) =>
          permissions.find((permission) => permission.toolCallId === toolCallId) ??
          null,
        commitToolPermissionRequest: ({ toolCall, permission }) => {
          calls.push(toolCall);
          permissions.push(permission);
        },
        appendEvent: (_event: Event) => {},
        appendTrace: (_trace: TraceEvent) => {},
      },
    });
    const snapshot: RunToolSnapshot = Object.freeze({
      snapshotId: "tool_snapshot_adapter_error",
      runId: "run_adapter_error",
      createdAt: new Date(0).toISOString(),
      agentMode: "agent",
      executionCeiling: Object.freeze({
        maxRiskLevel: "critical",
        allowedSideEffects: Object.freeze([
          "business_read",
          "business_write",
          "destructive",
        ] as const),
        allowIrreversible: true,
      }),
      activeTools: Object.freeze([
        Object.freeze({
          canonicalId: "sql.execute",
          providerName: "np__sql__execute",
        }),
      ]),
    });
    const adapted = runtimeToolsToAiSdkToolSet({
      registry,
      core,
      snapshot,
      conversationId: "conv_adapter_error",
      messageId: "msg_adapter_error",
      resolveIdentity: () => ({
        toolCallId: "tool_adapter_error",
        partId: "part_adapter_error",
      }),
    });
    const toolCall = {
      type: "tool-call" as const,
      toolCallId: "call_adapter_error",
      toolName: "np__sql__execute",
      input: {
        profileId: "profile-1",
        sql: "UPDATE users SET active = 0",
        pageSize: 50,
      },
    };
    const approve = adapted.toolApproval as unknown as (input: {
      toolCall: typeof toolCall;
      tools: unknown;
      toolsContext: Record<string, never>;
      runtimeContext: undefined;
      messages: [];
    }) => Promise<unknown>;

    await expect(approve({
      toolCall,
      tools: adapted.tools,
      toolsContext: {},
      runtimeContext: undefined,
      messages: [],
    })).resolves.toEqual({
      type: "denied",
      reason: expect.stringContaining(
        "[MUTATION_OUTCOME_UNKNOWN] The database stopped responding",
      ),
    });
    const approval = await approve({
      toolCall,
      tools: adapted.tools,
      toolsContext: {},
      runtimeContext: undefined,
      messages: [],
    }) as { reason: string };
    expect(approval.reason).toContain("Outcome: unknown.");
    expect(approval.reason).toContain("Do not retry automatically.");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      state: "error",
      error: {
        code: "MUTATION_OUTCOME_UNKNOWN",
        outcome: "unknown",
      },
    });
    expect(permissions).toHaveLength(0);
  });

  test("registers web.fetch as an immutable Runtime-local low-risk Tool", () => {
    const registry = new RuntimeToolRegistry([createWebToolNamespace()]);
    const definition = registry.requireTool("web.fetch");

    expect(registry.requireProviderName("web.fetch")).toBe("np__web__fetch");
    expect(definition.executionTarget).toBe("runtime");
    expect(definition.risk).toEqual({
      mode: "static",
      level: "low",
      reversible: true,
      sideEffect: "external_network",
    });
    expect(Object.isFrozen(definition)).toBe(true);
  });

  test("registers web.ping as an immutable Runtime-local low-risk Tool", () => {
    const registry = new RuntimeToolRegistry([createWebToolNamespace()]);
    const definition = registry.requireTool("web.ping");

    expect(registry.requireProviderName("web.ping")).toBe("np__web__ping");
    expect(definition.executionTarget).toBe("runtime");
    expect(definition.risk).toEqual({
      mode: "static",
      level: "low",
      reversible: true,
      sideEffect: "external_network",
    });
    expect(Object.isFrozen(definition)).toBe(true);
    expect(definition.description).not.toContain("NETWORK_ACCESS_SCOPE_DENIED");
    expect(definition.description).not.toContain("网络访问范围");
  });
});
