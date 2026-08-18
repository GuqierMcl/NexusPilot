import { describe, expect, test } from "bun:test";
import {
  BUILT_IN_AGENT_DEFINITIONS,
  BuiltInAgentDefinitionRegistry,
  type AgentDefinition,
} from "../src/runtime";

describe("BuiltInAgentDefinitionRegistry", () => {
  test("lists only built-in ask, query, and agent definitions", () => {
    const registry = new BuiltInAgentDefinitionRegistry();

    expect(registry.list().map((agent) => agent.agentMode)).toEqual([
      "ask",
      "query",
      "agent",
    ]);
    expect(BUILT_IN_AGENT_DEFINITIONS.every((agent) => agent.builtIn)).toBe(true);
  });

  test("defines ask without database Namespace access", () => {
    const registry = new BuiltInAgentDefinitionRegistry();
    const ask = registry.require("ask");

    expect(ask.agentMode).toBe("ask");
    expect(ask.toolPolicy.allowedNamespaces).toEqual(["system", "web"]);
    expect(ask.toolPolicy.allowedTools).toBeUndefined();
    expect(ask.toolPolicy.executionCeiling).toEqual({
      maxRiskLevel: "low",
      allowedSideEffects: ["none", "external_network"],
      allowIrreversible: false,
    });
    expect(ask.modelBehavior.toolChoice).toBe("auto");
    expect(ask.capabilities).toContain("question-answering");
    expect(ask.capabilities).toContain("web-research");
    expect(ask.systemPrompt).toContain("Ask 模式");
    expect(ask.systemPrompt).toContain("资料检索");
    expect(ask.systemPrompt).toContain("不访问连接配置");
  });

  test("defines query with read-only database access and a reversible ceiling", () => {
    const registry = new BuiltInAgentDefinitionRegistry();
    const query = registry.require("query");

    expect(query.agentMode).toBe("query");
    expect(query.toolPolicy.allowedNamespaces).toEqual([
      "system",
      "web",
      "connection",
      "metadata",
      "table",
      "key_value",
    ]);
    expect(query.toolPolicy.executionCeiling).toEqual({
      maxRiskLevel: "medium",
      allowedSideEffects: [
        "none",
        "external_network",
        "runtime_state",
        "workbench_state",
        "business_read",
      ],
      allowIrreversible: false,
    });
    expect(query.toolPolicy.executionCeiling.allowedSideEffects).not.toContain(
      "business_write",
    );
    expect(query.toolPolicy.executionCeiling.allowedSideEffects).not.toContain(
      "destructive",
    );
    expect(query.capabilities).toContain("database-read");
    expect(query.systemPrompt).toContain("Query 模式");
    expect(query.systemPrompt).toContain("打开数据库连接");
    expect(query.systemPrompt).toContain("不得执行数据库写入");
  });

  test("defines agent with a broad ceiling still constrained by Core authorization", () => {
    const registry = new BuiltInAgentDefinitionRegistry();
    const agent = registry.require("agent");

    expect(agent.agentMode).toBe("agent");
    expect(agent.toolPolicy.allowedNamespaces).toEqual([
      "system",
      "web",
      "connection",
      "metadata",
      "table",
      "key_value",
      "sql",
    ]);
    expect(agent.toolPolicy.executionCeiling.maxRiskLevel).toBe("critical");
    expect(agent.toolPolicy.executionCeiling.allowIrreversible).toBe(true);
    expect(agent.capabilities).toContain("runtime-tool-use");
  });

  test("does not silently fallback for unknown agent modes", () => {
    const registry = new BuiltInAgentDefinitionRegistry();

    expect(registry.get("missing" as never)).toBeNull();
    expect(() => registry.require("missing" as never)).toThrow("Unknown agent mode: missing");
  });

  test("returns cloned definitions so callers cannot mutate registry state", () => {
    const registry = new BuiltInAgentDefinitionRegistry();
    const first = registry.require("agent");
    first.toolPolicy.allowedNamespaces.push("unsafe_shell");
    first.toolPolicy.executionCeiling.allowedSideEffects.push("destructive");

    expect(registry.require("agent").toolPolicy.allowedNamespaces).toEqual([
      "system",
      "web",
      "connection",
      "metadata",
      "table",
      "key_value",
      "sql",
    ]);
    expect(
      registry.require("agent").toolPolicy.executionCeiling.allowedSideEffects.filter(
        (effect) => effect === "destructive",
      ),
    ).toHaveLength(1);
  });

  test("rejects duplicate agent mode definitions", () => {
    const ask = BUILT_IN_AGENT_DEFINITIONS[0] as AgentDefinition;

    expect(() => new BuiltInAgentDefinitionRegistry([ask, ask])).toThrow(
      "Duplicate agent mode: ask",
    );
  });
});
