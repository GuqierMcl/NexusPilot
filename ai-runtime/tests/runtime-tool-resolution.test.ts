import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  resolveRunTools,
  RuntimeToolRegistry,
  type AgentDefinition,
  type AnyRuntimeToolDefinition,
  type RuntimeToolNamespace,
} from "../src/runtime";

function createTool(
  id: string,
  overrides: Partial<AnyRuntimeToolDefinition> = {},
): AnyRuntimeToolDefinition {
  return {
    id,
    title: id,
    description: `Execute ${id}`,
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ ok: z.boolean() }).strict(),
    executionTarget: "runtime",
    risk: {
      mode: "static",
      level: "low",
      reversible: true,
      sideEffect: "none",
    },
    execute: async () => ({ summary: "Done.", data: { ok: true } }),
    ...overrides,
  } as AnyRuntimeToolDefinition;
}

function createAgent(
  overrides: Partial<AgentDefinition["toolPolicy"]> = {},
  agentMode: AgentDefinition["agentMode"] = "agent",
): AgentDefinition {
  return {
    id: agentMode,
    agentMode,
    title: agentMode,
    description: `${agentMode} test agent`,
    builtIn: true,
    systemPrompt: "test",
    capabilities: ["runtime-tool-use"],
    toolPolicy: {
      allowedNamespaces: ["connection", "metadata"],
      executionCeiling: {
        maxRiskLevel: "low",
        allowedSideEffects: ["none", "business_read"],
        allowIrreversible: false,
      },
      ...overrides,
    },
    limits: { maxSteps: 10, maxToolCalls: 10 },
    modelBehavior: { toolChoice: "auto" },
    metadata: { version: "1", source: "builtin", risk: "low" },
  };
}

function namespace(
  id: string,
  tools: readonly AnyRuntimeToolDefinition[],
  resolveForRun: RuntimeToolNamespace["resolveForRun"] = () => ({
    candidateToolIds: tools.map((tool) => tool.id),
  }),
): RuntimeToolNamespace {
  return {
    id,
    title: id,
    description: `${id} tools`,
    tools,
    resolveForRun,
  };
}

describe("per-Run Tool resolution", () => {
  test("applies sparse Agent policy, Namespace contribution, dependency, Risk, and Provider filters", () => {
    const tools = [
      createTool("connection.list"),
      createTool("connection.get"),
      createTool("metadata.list_children", {
        executionTarget: "backend",
        risk: {
          mode: "static",
          level: "low",
          reversible: true,
          sideEffect: "business_read",
        },
      }),
      createTool("metadata.delete_object", {
        executionTarget: "backend",
        risk: {
          mode: "static",
          level: "critical",
          reversible: false,
          sideEffect: "destructive",
        },
      }),
    ];
    const registry = new RuntimeToolRegistry([
      namespace("connection", tools.slice(0, 2)),
      namespace("metadata", tools.slice(2)),
    ]);
    const result = resolveRunTools({
      runId: "run_filters",
      agent: createAgent({
        allowedTools: [
          "connection.list",
          "metadata.list_children",
          "metadata.delete_object",
        ],
        deniedTools: ["connection.get"],
      }),
      registry,
      backendBridgeState: "disconnected",
      providerSupportsTools: true,
      createSnapshotId: () => "tool_snapshot_filters",
      now: () => 1_000,
    });

    expect(result.snapshot.activeTools).toEqual([
      { canonicalId: "connection.list", providerName: "np__connection__list" },
    ]);
    expect(result.snapshot.unavailableTools).toEqual([
      { canonicalId: "connection.get", reason: "agent_tool_denied" },
      {
        canonicalId: "metadata.list_children",
        reason: "backend_bridge_not_ready",
      },
      {
        canonicalId: "metadata.delete_object",
        reason: "backend_bridge_not_ready",
      },
    ]);
  });

  test("lets an allowed Namespace expose new candidates without granting past the ceiling", () => {
    const registry = new RuntimeToolRegistry([
      namespace("connection", [
        createTool("connection.list"),
        createTool("connection.reset", {
          risk: {
            mode: "static",
            level: "high",
            reversible: false,
            sideEffect: "runtime_state",
          },
        }),
      ]),
    ]);
    const result = resolveRunTools({
      runId: "run_new_tool",
      agent: createAgent({ allowedNamespaces: ["connection"] }, "ask"),
      registry,
      backendBridgeState: "ready",
    });

    expect(result.snapshot.activeTools.map((tool) => tool.canonicalId)).toEqual([
      "connection.list",
    ]);
    expect(result.snapshot.unavailableTools).toEqual([
      { canonicalId: "connection.reset", reason: "risk_level_exceeds_ceiling" },
    ]);
  });

  test("creates independent immutable Snapshots for concurrent Runs", () => {
    const seenRuns: string[] = [];
    const registry = new RuntimeToolRegistry([
      namespace("connection", [createTool("connection.list")], (context) => {
        seenRuns.push(context.runId);
        return context.agent.mode === "ask"
          ? { candidateToolIds: ["connection.list"] }
          : {
              candidateToolIds: [],
              unavailableTools: [
                { toolId: "connection.list", reason: "agent_specific_unavailable" },
              ],
            };
      }),
    ]);

    const ask = resolveRunTools({
      runId: "run_ask",
      agent: createAgent({ allowedNamespaces: ["connection"] }, "ask"),
      registry,
      backendBridgeState: "ready",
      createSnapshotId: () => "tool_snapshot_ask",
    });
    const agent = resolveRunTools({
      runId: "run_agent",
      agent: createAgent({ allowedNamespaces: ["connection"] }, "agent"),
      registry,
      backendBridgeState: "ready",
      createSnapshotId: () => "tool_snapshot_agent",
    });

    expect(seenRuns).toEqual(["run_ask", "run_agent"]);
    expect(ask.snapshot.activeTools).toHaveLength(1);
    expect(agent.snapshot.activeTools).toHaveLength(0);
    expect(agent.snapshot.unavailableTools?.[0]?.reason).toBe(
      "agent_specific_unavailable",
    );
    expect(Object.isFrozen(ask.snapshot)).toBe(true);
    expect(Object.isFrozen(ask.snapshot.executionCeiling)).toBe(true);
    expect(Object.isFrozen(ask.snapshot.executionCeiling.allowedSideEffects)).toBe(true);
    expect(Object.isFrozen(ask.snapshot.activeTools)).toBe(true);
    expect(ask.snapshot).not.toBe(agent.snapshot);
  });

  test("fails closed when a Namespace contributes foreign, duplicate, or ambiguous Tools", () => {
    const connectionTool = createTool("connection.list");
    const metadataTool = createTool("metadata.list_children");
    const agent = createAgent();

    const foreign = new RuntimeToolRegistry([
      namespace("connection", [connectionTool], () => ({
        candidateToolIds: ["metadata.list_children"],
      })),
      namespace("metadata", [metadataTool]),
    ]);
    expect(() =>
      resolveRunTools({
        runId: "run_foreign",
        agent,
        registry: foreign,
        backendBridgeState: "ready",
      }),
    ).toThrow("unowned or unregistered Tool");

    const duplicate = new RuntimeToolRegistry([
      namespace("connection", [connectionTool], () => ({
        candidateToolIds: ["connection.list", "connection.list"],
      })),
    ]);
    expect(() =>
      resolveRunTools({
        runId: "run_duplicate",
        agent,
        registry: duplicate,
        backendBridgeState: "ready",
      }),
    ).toThrow("is duplicated");

    const ambiguous = new RuntimeToolRegistry([
      namespace("connection", [connectionTool], () => ({
        candidateToolIds: ["connection.list"],
        unavailableTools: [
          { toolId: "connection.list", reason: "temporarily_unavailable" },
        ],
      })),
    ]);
    expect(() =>
      resolveRunTools({
        runId: "run_ambiguous",
        agent,
        registry: ambiguous,
        backendBridgeState: "ready",
      }),
    ).toThrow("both candidate and unavailable");
  });

  test("records Provider inability in the Snapshot without changing Registry facts", () => {
    const registry = new RuntimeToolRegistry([
      namespace("connection", [createTool("connection.list")]),
    ]);
    const result = resolveRunTools({
      runId: "run_provider",
      agent: createAgent({ allowedNamespaces: ["connection"] }),
      registry,
      backendBridgeState: "ready",
      providerSupportsTools: false,
    });

    expect(result.snapshot.activeTools).toEqual([]);
    expect(result.snapshot.unavailableTools).toEqual([
      { canonicalId: "connection.list", reason: "provider_tools_unsupported" },
    ]);
    expect(registry.requireTool("connection.list").id).toBe("connection.list");
  });
});
