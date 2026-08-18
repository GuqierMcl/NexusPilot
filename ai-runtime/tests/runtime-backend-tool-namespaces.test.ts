import { describe, expect, test } from "bun:test";
import {
  createConnectionToolNamespace,
  createKeyValueToolNamespace,
  createMetadataToolNamespace,
  createSqlToolNamespace,
  createTableToolNamespace,
  resolveAgentExecutionPolicy,
  RuntimeToolRegistry,
} from "../src/runtime";

describe("Backend Tool namespaces", () => {
  test("registers capability-oriented Backend Tools with canonical names", () => {
    const registry = new RuntimeToolRegistry([
      createConnectionToolNamespace(),
      createMetadataToolNamespace(),
      createTableToolNamespace(),
      createKeyValueToolNamespace(),
      createSqlToolNamespace(),
    ]);

    expect(registry.listTools().map((tool) => tool.id)).toEqual([
      "connection.list",
      "connection.get",
      "connection.open",
      "metadata.list_children",
      "metadata.describe_table",
      "table.query",
      "key_value.scan",
      "key_value.get",
      "key_value.create",
      "key_value.set",
      "key_value.rename",
      "key_value.set_ttl",
      "key_value.delete",
      "sql.execute",
    ]);
    expect(registry.requireProviderName("metadata.list_children")).toBe(
      "np__metadata__list_children",
    );
    expect(
      registry.requireTool("metadata.describe_table").requiredCapabilities,
    ).toEqual(["schema_browser"]);
    expect(registry.requireProviderName("table.query")).toBe(
      "np__table__query",
    );
    expect(registry.requireTool("table.query").requiredCapabilities).toEqual([
      "data_table_browser",
    ]);
    expect(registry.requireProviderName("key_value.scan")).toBe(
      "np__key_value__scan",
    );
    expect(registry.requireTool("key_value.get").requiredCapabilities).toEqual([
      "key_value_browser",
    ]);
    expect(registry.listTools().every((tool) =>
      tool.executionTarget === "backend"
    )).toBe(true);
    expect(registry.requireTool("sql.execute")).toMatchObject({
      executionTarget: "backend",
      requiredCapabilities: ["sql_executor"],
      risk: {
        mode: "dynamic",
        level: "medium",
        sideEffect: "business_read",
      },
      prepare: { operation: "sql.analyze" },
    });
    expect(registry.requireProviderName("sql.execute")).toBe(
      "np__sql__execute",
    );
    expect(registry.requireTool("connection.open").risk).toEqual({
      mode: "static",
      level: "low",
      reversible: true,
      sideEffect: "workbench_state",
    });
  });

  test("default Backend execute delegates to the injected proceed exactly once", async () => {
    const tool = createConnectionToolNamespace().tools[0]!;
    let proceeded = 0;
    const output = Object.freeze({
      summary: "done",
      data: { connections: [] },
    });

    const result = await tool.execute({}, {
      conversationId: "conv_1",
      runId: "run_1",
      toolCallId: "tool_1",
      abortSignal: new AbortController().signal,
      proceed: async () => {
        proceeded++;
        return output;
      },
    });

    expect(result).toBe(output);
    expect(proceeded).toBe(1);
  });

  test("metadata pagination defaults are normalized before execution", () => {
    const tool = createMetadataToolNamespace().tools[0]!;
    expect(tool.inputSchema.parse({ profileId: "profile-1" })).toEqual({
      profileId: "profile-1",
      offset: 0,
      limit: 100,
    });
  });

  test("table query defaults are normalized before execution", () => {
    const tool = createTableToolNamespace().tools[0]!;
    expect(tool.inputSchema.parse({
      profileId: "profile-1",
      source: {
        kind: "table",
        database: "app",
        schema: "public",
        table: "users",
      },
    })).toEqual({
      profileId: "profile-1",
      source: {
        kind: "table",
        database: "app",
        schema: "public",
        table: "users",
      },
      columns: [],
      filters: [],
      sort: [],
      page: 1,
      pageSize: 50,
    });
  });

  test("key value scan defaults are normalized before execution", () => {
    const tool = createKeyValueToolNamespace().tools[0]!;
    expect(tool.inputSchema.parse({
      profileId: "redis-profile",
      dbIndex: 0,
    })).toEqual({
      profileId: "redis-profile",
      dbIndex: 0,
      pattern: "*",
      cursor: "0",
      count: 100,
    });
  });

  test("models bounded Key/Value mutations without plan or fingerprint fields", () => {
    const namespace = createKeyValueToolNamespace();
    const set = namespace.tools.find((tool) => tool.id === "key_value.set")!;
    const setTtl = namespace.tools.find(
      (tool) => tool.id === "key_value.set_ttl",
    )!;
    const deleteTool = namespace.tools.find(
      (tool) => tool.id === "key_value.delete",
    )!;

    expect(set.inputSchema.parse({
      profileId: "redis-profile",
      dbIndex: 0,
      key: "user:42",
      value: { kind: "string", value: "active" },
    })).toEqual({
      profileId: "redis-profile",
      dbIndex: 0,
      key: "user:42",
      value: { kind: "string", value: "active" },
      ttlPolicy: "keep",
    });
    expect(() => set.inputSchema.parse({
      profileId: "redis-profile",
      dbIndex: 0,
      key: "user:42",
      value: { kind: "string", value: "active" },
      expectedFingerprint: `sha256:${"0".repeat(64)}`,
    })).toThrow();
    expect(setTtl.inputSchema.parse({
      profileId: "redis-profile",
      dbIndex: 0,
      key: "user:42",
      mode: "persist",
    })).toEqual({
      profileId: "redis-profile",
      dbIndex: 0,
      key: "user:42",
      mode: "persist",
    });
    expect(setTtl.inputSchema.parse({
      profileId: "redis-profile",
      dbIndex: 0,
      key: "user:42",
      mode: "expire",
      ttlSeconds: 3_600,
    })).toEqual({
      profileId: "redis-profile",
      dbIndex: 0,
      key: "user:42",
      mode: "expire",
      ttlSeconds: 3_600,
    });
    expect(() => setTtl.inputSchema.parse({
      profileId: "redis-profile",
      dbIndex: 0,
      key: "user:42",
      mode: "expire",
    })).toThrow();
    expect(() => setTtl.inputSchema.parse({
      profileId: "redis-profile",
      dbIndex: 0,
      key: "user:42",
      mode: "persist",
      ttlSeconds: 3_600,
    })).toThrow();
    expect(() => setTtl.inputSchema.parse({
      profileId: "redis-profile",
      dbIndex: 0,
      key: "user:42",
      mode: "expire",
      ttlSeconds: 0,
    })).toThrow();
    expect(() => setTtl.inputSchema.parse({
      profileId: "redis-profile",
      dbIndex: 0,
      key: "user:42",
      mode: "persist",
      planId: "client-plan",
    })).toThrow();
    expect(() => deleteTool.inputSchema.parse({
      profileId: "redis-profile",
      dbIndex: 0,
      key: "user:*",
      planId: "client-plan",
    })).toThrow();
    expect(deleteTool.risk).toMatchObject({
      mode: "dynamic",
      level: "critical",
      sideEffect: "destructive",
    });
  });

  test("sql execute normalizes only bounded model input without plan fields", () => {
    const tool = createSqlToolNamespace().tools[0]!;
    expect(tool.inputSchema.parse({
      profileId: "sqlite-profile",
      sql: "SELECT 1",
    })).toEqual({
      profileId: "sqlite-profile",
      sql: "SELECT 1",
      pageSize: 50,
    });
    expect(() => tool.inputSchema.parse({
      profileId: "sqlite-profile",
      sql: "SELECT 1",
      planId: "client-plan",
    })).toThrow();
    expect(tool.limits?.timeoutMs).toBe(35_000);
    expect(tool.outputSchema.safeParse({
      executionId: "clickhouse-execution",
      statementClass: "mutation",
      analysisStatus: "analyzed",
      result: {
        columns: [],
        rows: [],
        affectedRows: null,
        hasNextPage: false,
      },
      durationMs: 12,
      completionMessage: "Mutation 请求已提交",
      mutationState: "submitted",
      warnings: [],
    }).success).toBe(true);
  });

  test("exposes database read and reversible connection Tools to Query while Bridge is ready", () => {
    const registry = new RuntimeToolRegistry([
      createConnectionToolNamespace(),
      createMetadataToolNamespace(),
      createTableToolNamespace(),
      createKeyValueToolNamespace(),
      createSqlToolNamespace(),
    ]);
    const ready = resolveAgentExecutionPolicy({
      runId: "run_ready",
      agentMode: "query",
      provider: {
        providerId: "openai",
        modelId: "gpt-4o",
        supportsTools: true,
      },
      toolRegistry: registry,
      backendBridgeState: "ready",
    });
    const disconnected = resolveAgentExecutionPolicy({
      runId: "run_disconnected",
      agentMode: "query",
      provider: {
        providerId: "openai",
        modelId: "gpt-4o",
        supportsTools: true,
      },
      toolRegistry: registry,
      backendBridgeState: "disconnected",
    });

    expect(
      ready.toolResolution.snapshot.activeTools.map(
        (tool) => tool.canonicalId,
      ),
    ).toEqual([
      "connection.list",
      "connection.get",
      "connection.open",
      "metadata.list_children",
      "metadata.describe_table",
      "table.query",
      "key_value.scan",
      "key_value.get",
    ]);
    expect(
      ready.toolResolution.snapshot.activeTools.map((tool) => tool.canonicalId),
    ).not.toContain("sql.execute");
    expect(disconnected.toolResolution.snapshot.activeTools).toEqual([]);
    expect(
      disconnected.toolResolution.snapshot.unavailableTools?.map(
        (tool) => tool.reason,
      ),
    ).toEqual([
      "backend_bridge_not_ready",
      "backend_bridge_not_ready",
      "backend_bridge_not_ready",
      "backend_bridge_not_ready",
      "backend_bridge_not_ready",
      "backend_bridge_not_ready",
      "backend_bridge_not_ready",
      "backend_bridge_not_ready",
      "backend_bridge_not_ready",
      "backend_bridge_not_ready",
      "backend_bridge_not_ready",
      "backend_bridge_not_ready",
      "backend_bridge_not_ready",
    ]);
  });

  test("does not expose database Tools to an ask Run", () => {
    const registry = new RuntimeToolRegistry([
      createConnectionToolNamespace(),
      createMetadataToolNamespace(),
      createTableToolNamespace(),
      createKeyValueToolNamespace(),
      createSqlToolNamespace(),
    ]);
    const policy = resolveAgentExecutionPolicy({
      runId: "run_ask",
      agentMode: "ask",
      provider: {
        providerId: "openai",
        modelId: "gpt-4o",
        supportsTools: true,
      },
      toolRegistry: registry,
      backendBridgeState: "ready",
    });

    expect(policy.toolResolution.snapshot.activeTools).toEqual([]);
  });

  test("exposes sql.execute only to Agent mode while Bridge is ready", () => {
    const registry = new RuntimeToolRegistry([
      createSqlToolNamespace(),
    ]);
    const policy = resolveAgentExecutionPolicy({
      runId: "run_agent_sql",
      agentMode: "agent",
      provider: {
        providerId: "openai",
        modelId: "gpt-4o",
        supportsTools: true,
      },
      toolRegistry: registry,
      backendBridgeState: "ready",
    });

    expect(policy.toolResolution.snapshot.activeTools).toEqual([
      {
        canonicalId: "sql.execute",
        providerName: "np__sql__execute",
      },
    ]);
  });

  test("exposes Key/Value mutations only to Agent mode", () => {
    const registry = new RuntimeToolRegistry([
      createKeyValueToolNamespace(),
    ]);
    const policy = resolveAgentExecutionPolicy({
      runId: "run_agent_key_value",
      agentMode: "agent",
      provider: {
        providerId: "openai",
        modelId: "gpt-4o",
        supportsTools: true,
      },
      toolRegistry: registry,
      backendBridgeState: "ready",
    });

    expect(
      policy.toolResolution.snapshot.activeTools.map(
        (tool) => tool.canonicalId,
      ),
    ).toEqual([
      "key_value.scan",
      "key_value.get",
      "key_value.create",
      "key_value.set",
      "key_value.rename",
      "key_value.set_ttl",
      "key_value.delete",
    ]);
  });
});
