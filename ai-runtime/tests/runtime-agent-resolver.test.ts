import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  RuntimeToolRegistry,
  resolveAgentExecutionPolicy,
  type RuntimeToolNamespace,
} from "../src/runtime";

function createWebRegistry(): RuntimeToolRegistry {
  const namespace: RuntimeToolNamespace = {
    id: "web",
    title: "Web",
    description: "Public web capabilities",
    tools: [
      {
        id: "web.fetch",
        title: "Fetch Web Page",
        description: "Fetch a public web page.",
        inputSchema: z.object({ url: z.string() }).strict(),
        outputSchema: z.object({ text: z.string() }).strict(),
        executionTarget: "runtime",
        risk: {
          mode: "static",
          level: "low",
          reversible: true,
          sideEffect: "external_network",
        },
        execute: async () => ({ summary: "Fetched.", data: { text: "" } }),
      },
    ],
    resolveForRun: () => ({ candidateToolIds: ["web.fetch"] }),
  };
  return new RuntimeToolRegistry([namespace]);
}

describe("resolveAgentExecutionPolicy", () => {
  test("defaults missing agent mode to ask and freezes a Run-specific Tool Snapshot", () => {
    const policy = resolveAgentExecutionPolicy({
      runId: "run_ask",
      provider: { providerId: "openai", modelId: "gpt-4o", supportsTools: true },
      toolRegistry: createWebRegistry(),
      createToolSnapshotId: () => "tool_snapshot_ask",
      now: () => 1_000,
    });

    expect(policy.agentMode).toBe("ask");
    expect(policy.toolResolution.snapshot).toMatchObject({
      snapshotId: "tool_snapshot_ask",
      runId: "run_ask",
      agentMode: "ask",
      approvalPolicy: { autoApproveMaxRisk: "low" },
      networkPolicy: { accessScope: "local-and-public" },
      activeTools: [
        { canonicalId: "web.fetch", providerName: "np__web__fetch" },
      ],
    });
    expect(policy.prompt.system).toContain("web.fetch");
    expect(policy.limits.maxToolCalls).toBe(300);
  });

  test("freezes an explicit Runtime approval policy into the Tool Snapshot", () => {
    const policy = resolveAgentExecutionPolicy({
      runId: "run_medium_policy",
      agentMode: "agent",
      provider: {
        providerId: "openai",
        modelId: "gpt-4o",
        supportsTools: true,
      },
      toolRegistry: createWebRegistry(),
      approvalPolicy: { autoApproveMaxRisk: "medium" },
    });

    expect(policy.toolResolution.snapshot.approvalPolicy).toEqual({
      autoApproveMaxRisk: "medium",
    });
    expect(Object.isFrozen(policy.toolResolution.snapshot.approvalPolicy)).toBe(
      true,
    );
  });

  test("freezes the Runtime network access scope into the Tool Snapshot", () => {
    const policy = resolveAgentExecutionPolicy({
      runId: "run_public_network",
      agentMode: "agent",
      provider: {
        providerId: "openai",
        modelId: "gpt-4o",
        supportsTools: true,
      },
      toolRegistry: createWebRegistry(),
      networkPolicy: { accessScope: "public-only" },
    });

    expect(policy.toolResolution.snapshot.networkPolicy).toEqual({
      accessScope: "public-only",
    });
    expect(Object.isFrozen(policy.toolResolution.snapshot.networkPolicy)).toBe(
      true,
    );
  });

  test("resolves agent mode using canonical Tool identities", () => {
    const policy = resolveAgentExecutionPolicy({
      runId: "run_agent",
      agentMode: "agent",
      provider: { providerId: "openai", modelId: "gpt-4o", supportsTools: true },
      toolRegistry: createWebRegistry(),
    });

    expect(policy.agentMode).toBe("agent");
    expect(policy.toolResolution.snapshot.activeTools).toEqual([
      { canonicalId: "web.fetch", providerName: "np__web__fetch" },
    ]);
    expect(policy.prompt.system).toContain("当前可用工具");
    expect(policy.trace.enabledToolNames).toEqual(["web.fetch"]);
    expect(policy.trace.activeToolNames).toEqual(["web.fetch"]);
    expect(policy.trace.promptAssemblyVersion).toBe(policy.prompt.version);
  });

  test("resolves query as an independent read-only execution policy", () => {
    const policy = resolveAgentExecutionPolicy({
      runId: "run_query",
      agentMode: "query",
      provider: { providerId: "openai", modelId: "gpt-4o", supportsTools: true },
      toolRegistry: createWebRegistry(),
    });

    expect(policy.agentMode).toBe("query");
    expect(policy.toolResolution.snapshot.agentMode).toBe("query");
    expect(policy.toolResolution.snapshot.activeTools).toEqual([
      { canonicalId: "web.fetch", providerName: "np__web__fetch" },
    ]);
    expect(policy.agent.toolPolicy.executionCeiling.maxRiskLevel).toBe("medium");
    expect(policy.agent.toolPolicy.executionCeiling.allowIrreversible).toBe(false);
    expect(policy.prompt.system).toContain("Query 模式");
  });

  test("throws on unknown agent mode", () => {
    expect(() =>
      resolveAgentExecutionPolicy({
        runId: "run_unknown",
        agentMode: "writer" as never,
        provider: { providerId: "openai", modelId: "gpt-4o" },
        toolRegistry: new RuntimeToolRegistry([]),
      }),
    ).toThrow("Unknown agent mode: writer");
  });

  test("records missing Namespaces and unsupported tool calling in trace warnings", () => {
    const policy = resolveAgentExecutionPolicy({
      runId: "run_warnings",
      agentMode: "agent",
      provider: { providerId: "openai", modelId: "gpt-4o", supportsTools: false },
      toolRegistry: createWebRegistry(),
    });

    expect(policy.toolResolution.snapshot.activeTools).toEqual([]);
    expect(policy.toolResolution.snapshot.unavailableTools).toEqual([
      { canonicalId: "web.fetch", reason: "provider_tools_unsupported" },
    ]);
    expect(policy.trace.warnings).toContain(
      "Namespace connection is allowed by agent but not registered",
    );
  });
});
