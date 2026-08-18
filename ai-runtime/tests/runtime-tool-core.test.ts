import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type {
  ConversationId,
  Event,
  MessageId,
  Permission,
  RunId,
  ToolCall,
  ToolCallId,
  TraceEvent,
} from "../src/runtime/core/types";
import {
  RuntimeToolCore,
  RuntimeToolExecutionError,
  RuntimeToolRegistry,
  PreparedToolInvocationRegistry,
  createKeyValueToolNamespace,
  createSqlToolNamespace,
  defineBackendTool,
  type AnyRuntimeToolDefinition,
  type RunToolSnapshot,
  type RuntimeToolNamespace,
} from "../src/runtime/tools";

const conversationId = "conv_core" as ConversationId;
const runId = "run_core" as RunId;
const messageId = "msg_core" as MessageId;

class MemoryToolStore {
  readonly calls = new Map<string, ToolCall>();
  readonly permissions = new Map<string, Permission>();
  readonly events: Event[] = [];
  readonly traces: TraceEvent[] = [];

  saveToolCall(toolCall: ToolCall): void {
    this.calls.set(toolCall.id, toolCall);
  }

  getToolCall(id: ToolCall["id"]): ToolCall | null {
    return this.calls.get(id) ?? null;
  }

  listToolCallsByRun(id: RunId): ToolCall[] {
    return [...this.calls.values()].filter((call) => call.runId === id);
  }

  getPermissionByToolCallId(toolCallId: ToolCall["id"]): Permission | null {
    return (
      [...this.permissions.values()].find(
        (permission) => permission.toolCallId === toolCallId,
      ) ?? null
    );
  }

  commitToolPermissionRequest(input: {
    toolCall: ToolCall;
    permission: Permission;
    requestedAt: number;
    eventIds: {
      tool: Event["id"];
      permission: Event["id"];
      run: Event["id"];
      conversation: Event["id"];
    };
  }): void {
    this.calls.set(input.toolCall.id, input.toolCall);
    this.permissions.set(input.permission.id, input.permission);
    this.events.push(
      {
        id: input.eventIds.tool,
        type: "tool.updated",
        properties: { info: input.toolCall },
        time: input.requestedAt,
      },
      {
        id: input.eventIds.permission,
        type: "permission.requested",
        properties: { info: input.permission },
        time: input.requestedAt,
      },
    );
  }

  appendEvent(event: Event): void {
    this.events.push(event);
  }

  appendTrace(trace: TraceEvent): void {
    this.traces.push(trace);
  }
}

function runtimeTool(
  overrides: Partial<AnyRuntimeToolDefinition> = {},
): AnyRuntimeToolDefinition {
  return {
    id: "test.read",
    title: "Read",
    description: "Read test data",
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ value: z.string(), password: z.string().optional() }),
    executionTarget: "runtime",
    risk: {
      mode: "static",
      level: "low",
      reversible: true,
      sideEffect: "none",
    },
    execute: async (input: { value: string }) => ({
      summary: "done",
      data: { value: input.value },
    }),
    ...overrides,
  } as AnyRuntimeToolDefinition;
}

function harness(tool = runtimeTool(), options: {
  maxToolCallsPerRun?: number;
  backendExecutor?: ConstructorParameters<typeof RuntimeToolCore>[0]["backendExecutor"];
  preparedInvocations?: PreparedToolInvocationRegistry;
  now?: () => number;
} = {}) {
  const namespaceId = tool.id.split(".", 1)[0] ?? "test";
  const namespace: RuntimeToolNamespace = {
    id: namespaceId,
    title: "Test",
    description: "Test namespace",
    tools: [tool],
    resolveForRun: () => ({ candidateToolIds: [tool.id] }),
  };
  const registry = new RuntimeToolRegistry([namespace]);
  const store = new MemoryToolStore();
  const snapshot: RunToolSnapshot = Object.freeze({
    snapshotId: "tool_snapshot_core",
    runId,
    createdAt: new Date(0).toISOString(),
    agentMode: "agent",
    executionCeiling: Object.freeze({
      maxRiskLevel: "critical",
      allowedSideEffects: Object.freeze([
        "none",
        "external_network",
        "runtime_state",
        "workbench_state",
        "business_read",
        "business_write",
        "destructive",
      ] as const),
      allowIrreversible: true,
    }),
    activeTools: Object.freeze([
      Object.freeze({
        canonicalId: tool.id,
        providerName: registry.requireProviderName(tool.id),
      }),
    ]),
  });
  const core = new RuntimeToolCore({
    registry,
    store,
    ...options,
  });
  return { core, registry, snapshot, store };
}

function dispatchInput(snapshot: RunToolSnapshot, providerName = "np__test__read") {
  return {
    conversationId,
    runId,
    messageId,
    providerName,
    input: { value: "hello" },
    snapshot,
  };
}

function withApprovalPolicy(
  snapshot: RunToolSnapshot,
  autoApproveMaxRisk: "none" | "low" | "medium",
): RunToolSnapshot {
  return Object.freeze({
    ...snapshot,
    approvalPolicy: Object.freeze({ autoApproveMaxRisk }),
  });
}

describe("RuntimeToolCore", () => {
  test.each([
    ["none", "low", "ask"],
    ["none", "medium", "ask"],
    ["low", "low", "allow"],
    ["low", "medium", "ask"],
    ["medium", "low", "allow"],
    ["medium", "medium", "allow"],
    ["none", "high", "ask"],
    ["low", "high", "ask"],
    ["medium", "high", "ask"],
    ["none", "critical", "ask"],
    ["low", "critical", "ask"],
    ["medium", "critical", "ask"],
  ] as const)(
    "applies auto-approval threshold %s to %s risk as %s",
    async (threshold, riskLevel, expectedDecision) => {
      const { core, snapshot } = harness(runtimeTool({
        risk: {
          mode: "static",
          level: riskLevel,
          reversible: true,
          sideEffect: "none",
        },
      }));
      const authorization = await core.authorize(
        dispatchInput(withApprovalPolicy(snapshot, threshold)),
      );

      expect(authorization.decision).toBe(expectedDecision);
    },
  );

  test("sql.execute never reaches the executor before critical approval", async () => {
    const tool = createSqlToolNamespace().tools[0]!;
    let executeCount = 0;
    const { core, snapshot, store, registry } = harness(tool, {
      backendExecutor: {
        prepare: async () => ({
          planId: "plan_sql",
          expiresAt: 10_000,
          risk: {
            level: "critical",
            reversible: false,
            sideEffects: [
              "business_read",
              "business_write",
              "destructive",
            ],
          },
          permission: {
            confirmationPrompt: "确认在 production sqlite 执行",
            presentation: {
              sql: {
                text: "SELECT * FROM users",
                analysisStatus: "uncertain",
                statementClass: "read",
              },
            },
          },
        }),
        execute: async () => {
          executeCount += 1;
          return {
            summary: "executed",
            data: {
              executionId: "sql_exec_1",
              statementClass: "read",
              analysisStatus: "uncertain",
              result: {
                columns: [],
                rows: [[1]],
                affectedRows: null,
                hasNextPage: false,
              },
              durationMs: 1,
              completionMessage: null,
              mutationState: "not_applicable",
              warnings: [],
            },
          };
        },
      },
      now: () => 1_000,
    });
    const toolCallId = "tool_sql_core" as ToolCallId;
    const invocation = {
      ...dispatchInput(snapshot, registry.requireProviderName(tool.id)),
      toolCallId,
      input: {
        profileId: "sqlite-profile",
        sql: "SELECT * FROM users",
        pageSize: 50,
      },
    };

    expect(await core.dispatch(invocation)).toMatchObject({
      ok: false,
      error: { code: "TOOL_PERMISSION_REQUIRED" },
    });
    expect(executeCount).toBe(0);
    const permission = store.getPermissionByToolCallId(toolCallId)!;
    expect(permission.confirmation).toEqual({
      level: "strong",
      prompt: "确认在 production sqlite 执行",
    });
    store.permissions.set(permission.id, {
      ...permission,
      status: "approved",
      decision: {
        source: "user",
        confirmationVerified: true,
        decidedAt: 1_001,
      },
    });

    expect(await core.dispatch(invocation)).toMatchObject({
      ok: true,
      data: { executionId: "sql_exec_1" },
    });
    expect(executeCount).toBe(1);
  });

  test.each([
    [
      "CONNECTION_NOT_OPEN",
      new RuntimeToolExecutionError(
        "CONNECTION_NOT_OPEN",
        "The connection is not open.",
        false,
        "not_started",
      ),
      "CONNECTION_NOT_OPEN",
      "not_started",
    ],
    [
      "CAPABILITY_UNAVAILABLE",
      new RuntimeToolExecutionError(
        "CAPABILITY_UNAVAILABLE",
        "The connection does not support SQL execution.",
        false,
        "not_started",
      ),
      "CAPABILITY_UNAVAILABLE",
      "not_started",
    ],
    [
      "PLAN_MISMATCH",
      new RuntimeToolExecutionError(
        "PLAN_MISMATCH",
        "Backend returned an invalid prepared plan.",
        false,
        "not_started",
      ),
      "PLAN_MISMATCH",
      "not_started",
    ],
    [
      "unknown exception",
      new Error("unexpected prepare failure"),
      "TOOL_PREPARE_FAILED",
      "not_started",
    ],
  ] as const)(
    "persists authorization prepare failure %s as a ToolCall error",
    async (_caseName, prepareError, expectedCode, expectedOutcome) => {
      const tool = createSqlToolNamespace().tools[0]!;
      let prepareCount = 0;
      const { core, snapshot, store, registry } = harness(tool, {
        backendExecutor: {
          prepare: async () => {
            prepareCount += 1;
            throw prepareError;
          },
          execute: async () => {
            throw new Error("execute must not be reached");
          },
        },
      });
      const toolCallId = `tool_authorize_${expectedCode}` as ToolCallId;
      const invocation = {
        ...dispatchInput(snapshot, registry.requireProviderName(tool.id)),
        toolCallId,
        input: {
          profileId: "profile-closed",
          sql: "SELECT 1",
          pageSize: 50,
        },
      };

      const first = await core.authorize(invocation);
      const second = await core.authorize(invocation);

      expect(first).toMatchObject({
        decision: "error",
        error: { code: expectedCode, outcome: expectedOutcome },
      });
      expect(second).toEqual(first);
      expect(prepareCount).toBe(1);
      expect(store.getPermissionByToolCallId(toolCallId)).toBeNull();
      expect(store.getToolCall(toolCallId)).toMatchObject({
        state: "error",
        result: {
          ok: false,
          error: { code: expectedCode, outcome: expectedOutcome },
        },
        error: { code: expectedCode, outcome: expectedOutcome },
        time: { completed: expect.any(Number) },
      });
      expect(store.traces).toEqual([
        expect.objectContaining({
          type: "tool.executed",
          level: "warn",
          payload: expect.objectContaining({
            phase: "authorization",
            errorCode: expectedCode,
            outcome: expectedOutcome,
          }),
        }),
      ]);
    },
  );

  test("contains input, inactive-tool, and snapshot failures inside ToolCall authorization", async () => {
    const inputFailure = harness(runtimeTool({
      risk: {
        mode: "static",
        level: "high",
        reversible: true,
        sideEffect: "none",
      },
    }));
    const invalidInput = {
      ...dispatchInput(inputFailure.snapshot),
      toolCallId: "tool_invalid_authorization_input" as ToolCallId,
      input: { value: 42, password: "must-not-persist" },
    };

    await expect(inputFailure.core.authorize(invalidInput)).resolves.toMatchObject({
      decision: "error",
      error: { code: "TOOL_INPUT_INVALID" },
    });
    expect(inputFailure.store.getToolCall(invalidInput.toolCallId)).toMatchObject({
      state: "error",
      input: {},
      error: { code: "TOOL_INPUT_INVALID" },
    });
    expect(
      JSON.stringify(inputFailure.store.getToolCall(invalidInput.toolCallId)),
    ).not.toContain("must-not-persist");

    const inactiveSnapshot = Object.freeze({
      ...inputFailure.snapshot,
      activeTools: Object.freeze([]),
    });
    const inactiveInput = {
      ...dispatchInput(inactiveSnapshot),
      toolCallId: "tool_inactive_authorization" as ToolCallId,
    };
    await expect(inputFailure.core.authorize(inactiveInput)).resolves.toMatchObject({
      decision: "error",
      error: { code: "TOOL_NOT_ACTIVE" },
    });
    expect(inputFailure.store.getToolCall(inactiveInput.toolCallId)).toMatchObject({
      state: "error",
      error: { code: "TOOL_NOT_ACTIVE" },
    });

    const mutableSnapshot = structuredClone(inputFailure.snapshot);
    const snapshotInput = {
      ...dispatchInput(mutableSnapshot),
      toolCallId: "tool_invalid_snapshot_authorization" as ToolCallId,
    };
    await expect(inputFailure.core.authorize(snapshotInput)).resolves.toMatchObject({
      decision: "error",
      error: { code: "TOOL_SNAPSHOT_INVALID" },
    });
    expect(inputFailure.store.getToolCall(snapshotInput.toolCallId)).toMatchObject({
      state: "error",
      error: { code: "TOOL_SNAPSHOT_INVALID" },
    });
  });

  test("does not disguise Runtime Store persistence failures as ToolCall results", async () => {
    const { core, snapshot, store } = harness(runtimeTool({
      risk: {
        mode: "static",
        level: "high",
        reversible: true,
        sideEffect: "none",
      },
    }));
    store.saveToolCall = () => {
      throw new Error("runtime store unavailable");
    };

    await expect(core.authorize({
      ...dispatchInput(snapshot),
      toolCallId: "tool_store_failure" as ToolCallId,
      input: { value: 42 },
    })).rejects.toThrow("runtime store unavailable");
  });

  test("key_value.delete requires strong confirmation and executes one prepared plan", async () => {
    const tool = createKeyValueToolNamespace().tools.find(
      (candidate) => candidate.id === "key_value.delete",
    )!;
    let executeCount = 0;
    const executedInputs: unknown[] = [];
    const { core, snapshot, store, registry } = harness(tool, {
      backendExecutor: {
        prepare: async () => ({
          planId: "plan_redis_delete",
          expiresAt: 10_000,
          risk: {
            level: "critical",
            reversible: false,
            sideEffects: ["business_write", "destructive"],
          },
          permission: {
            inputSummary: "删除 Redis DB 2 中的 Key session:42",
            confirmationPrompt: "确认删除 Redis DB 2 中的 Key session:42",
            presentation: {
              target: {
                profileId: "redis-profile",
                connectionName: "Production Redis",
                driver: "redis",
                environment: "production",
                redisDbIndex: 2,
              },
              riskReasons: ["该操作会永久删除一个精确 Redis Key。"],
              keyValue: {
                operation: "delete",
                key: "session:42",
                valueType: "hash",
              },
            },
          },
        }),
        execute: async (_operation, input) => {
          executeCount += 1;
          executedInputs.push(input);
          return {
            summary: "deleted",
            data: {
              dbIndex: 2,
              key: "session:42",
              deletedCount: 1,
              mutationState: "completed",
            },
          };
        },
      },
      now: () => 1_000,
    });
    const toolCallId = "tool_redis_delete" as ToolCallId;
    const invocation = {
      ...dispatchInput(snapshot, registry.requireProviderName(tool.id)),
      toolCallId,
      input: {
        profileId: "redis-profile",
        dbIndex: 2,
        key: "session:42",
      },
    };

    expect(await core.dispatch(invocation)).toMatchObject({
      ok: false,
      error: { code: "TOOL_PERMISSION_REQUIRED" },
    });
    expect(executeCount).toBe(0);
    const permission = store.getPermissionByToolCallId(toolCallId)!;
    expect(permission.confirmation).toEqual({
      level: "strong",
      prompt: "确认删除 Redis DB 2 中的 Key session:42",
    });
    expect(permission.presentation?.keyValue).toEqual({
      operation: "delete",
      key: "session:42",
      valueType: "hash",
    });

    store.permissions.set(permission.id, {
      ...permission,
      status: "approved",
      decision: {
        source: "user",
        confirmationVerified: true,
        decidedAt: 1_001,
      },
    });
    expect(await core.dispatch(invocation)).toMatchObject({
      ok: true,
      data: {
        deletedCount: 1,
        mutationState: "completed",
      },
    });
    expect(executeCount).toBe(1);
    expect(executedInputs).toEqual([{ planId: "plan_redis_delete" }]);
  });

  test("prepares a dynamic Backend Tool once and executes only its internal plan", async () => {
    const preparedInputs: unknown[] = [];
    const executedInputs: unknown[] = [];
    const tool = defineBackendTool({
      id: "test.mutate",
      title: "Mutate",
      description: "Mutate test data",
      inputSchema: z.object({
        profileId: z.string(),
        sql: z.string(),
      }).strict(),
      outputSchema: z.object({ affectedRows: z.number() }).strict(),
      executionTarget: "backend",
      risk: {
        mode: "dynamic",
        level: "medium",
        reversible: "conditional",
        sideEffect: "business_write",
      },
      prepare: { operation: "test.prepare_mutation" },
    });
    const { core, snapshot, store, registry } = harness(tool, {
      backendExecutor: {
        prepare: async (operation, input, identity) => {
          preparedInputs.push({ operation, input, identity });
          return {
            planId: "plan_server_only",
            expiresAt: 10_000,
            risk: {
              level: "critical",
              reversible: false,
              sideEffects: ["business_write", "destructive"],
            },
            permission: {
              inputSummary: "删除用户数据",
              confirmationPrompt: "确认执行高风险 SQL",
              presentation: {
                sql: {
                  text: "DELETE FROM users",
                  analysisStatus: "uncertain",
                },
              },
            },
          };
        },
        execute: async (_operation, input, _signal, identity) => {
          executedInputs.push({ input, identity });
          return {
            summary: "mutated",
            data: { affectedRows: 1 },
          };
        },
      },
      now: () => 1_000,
    });
    const toolCallId = "tool_prepared_core" as ToolCallId;
    const invocation = {
      ...dispatchInput(snapshot, registry.requireProviderName(tool.id)),
      toolCallId,
      input: {
        profileId: "profile_1",
        sql: "DELETE FROM users",
      },
    };

    expect(await core.dispatch(invocation)).toMatchObject({
      ok: false,
      error: { code: "TOOL_PERMISSION_REQUIRED" },
    });
    expect(preparedInputs).toHaveLength(1);
    const waitingCall = store.calls.get(toolCallId)!;
    const permission = store.getPermissionByToolCallId(toolCallId)!;
    expect(waitingCall.input).not.toHaveProperty("planId");
    expect(waitingCall.metadata).toMatchObject({
      preparedPlan: {
        prepareOperation: "test.prepare_mutation",
        expiresAt: 10_000,
      },
    });
    expect(permission).not.toHaveProperty("planId");
    expect(permission.metadata).toEqual(waitingCall.metadata &&
      { preparedPlan: waitingCall.metadata.preparedPlan });
    store.permissions.set(permission.id, {
      ...permission,
      status: "approved",
      decision: {
        source: "user",
        confirmationVerified: true,
        decidedAt: 1_001,
      },
    });

    expect(await core.dispatch(invocation)).toEqual({
      ok: true,
      summary: "mutated",
      data: { affectedRows: 1 },
    });
    expect(preparedInputs).toHaveLength(1);
    expect(executedInputs).toEqual([
      expect.objectContaining({
        input: { planId: "plan_server_only" },
        identity: expect.objectContaining({ toolCallId, toolId: "test.mutate" }),
      }),
    ]);
  });

  test("rejects changed or expired input without preparing again", async () => {
    let now = 100;
    let prepareCount = 0;
    const tool = defineBackendTool({
      id: "test.mutate",
      title: "Mutate",
      description: "Mutate test data",
      inputSchema: z.object({ value: z.string() }).strict(),
      outputSchema: z.object({ value: z.string() }).strict(),
      executionTarget: "backend",
      risk: {
        mode: "dynamic",
        level: "medium",
        reversible: "conditional",
        sideEffect: "business_write",
      },
      prepare: { operation: "test.prepare_mutation" },
    });
    const { core, snapshot, store, registry } = harness(tool, {
      backendExecutor: {
        prepare: async () => {
          prepareCount += 1;
          return {
            planId: "plan_once",
            expiresAt: 150,
            risk: {
              level: "high",
              reversible: true,
              sideEffects: ["business_write"],
            },
            permission: {},
          };
        },
        execute: async () => ({
          summary: "unexpected",
          data: { value: "unexpected" },
        }),
      },
      now: () => now,
    });
    const toolCallId = "tool_prepared_changed" as ToolCallId;
    const base = {
      ...dispatchInput(snapshot, registry.requireProviderName(tool.id)),
      toolCallId,
      input: { value: "original" },
    };
    await core.dispatch(base);
    const permission = store.getPermissionByToolCallId(toolCallId)!;
    store.permissions.set(permission.id, { ...permission, status: "approved" });

    expect(await core.dispatch({
      ...base,
      input: { value: "changed" },
    })).toMatchObject({
      ok: false,
      error: { code: "PLAN_MISMATCH", outcome: "not_started" },
    });
    expect(prepareCount).toBe(1);

    const expiring = harness(tool, {
      backendExecutor: {
        prepare: async () => ({
          planId: "plan_expiring",
          expiresAt: 150,
          risk: {
            level: "high",
            reversible: true,
            sideEffects: ["business_write"],
          },
          permission: {},
        }),
        execute: async () => ({
          summary: "unexpected",
          data: { value: "unexpected" },
        }),
      },
      now: () => now,
    });
    const expiringId = "tool_prepared_expired" as ToolCallId;
    const expiringInput = {
      ...dispatchInput(
        expiring.snapshot,
        expiring.registry.requireProviderName(tool.id),
      ),
      toolCallId: expiringId,
      input: { value: "original" },
    };
    now = 100;
    await expiring.core.dispatch(expiringInput);
    const expiringPermission =
      expiring.store.getPermissionByToolCallId(expiringId)!;
    expiring.store.permissions.set(expiringPermission.id, {
      ...expiringPermission,
      status: "approved",
    });
    now = 150;
    expect(await expiring.core.dispatch(expiringInput)).toMatchObject({
      ok: false,
      error: { code: "PLAN_EXPIRED", outcome: "not_started" },
    });

    const clearedPlans = new PreparedToolInvocationRegistry(() => now);
    let clearedPrepareCount = 0;
    const cleared = harness(tool, {
      preparedInvocations: clearedPlans,
      backendExecutor: {
        prepare: async () => {
          clearedPrepareCount += 1;
          return {
            planId: "plan_cleared",
            expiresAt: 500,
            risk: {
              level: "high",
              reversible: true,
              sideEffects: ["business_write"],
            },
            permission: {},
          };
        },
        execute: async () => ({
          summary: "unexpected",
          data: { value: "unexpected" },
        }),
      },
      now: () => now,
    });
    const clearedId = "tool_prepared_cleared" as ToolCallId;
    const clearedInput = {
      ...dispatchInput(
        cleared.snapshot,
        cleared.registry.requireProviderName(tool.id),
      ),
      toolCallId: clearedId,
      input: { value: "original" },
    };
    now = 200;
    await cleared.core.dispatch(clearedInput);
    const clearedPermission =
      cleared.store.getPermissionByToolCallId(clearedId)!;
    cleared.store.permissions.set(clearedPermission.id, {
      ...clearedPermission,
      status: "approved",
    });
    clearedPlans.clearRun(runId);
    expect(await cleared.core.dispatch(clearedInput)).toMatchObject({
      ok: false,
      error: { code: "PLAN_NOT_FOUND", outcome: "not_started" },
    });
    expect(clearedPrepareCount).toBe(1);
  });

  test("executes an active Runtime Tool and persists canonical ToolCall facts", async () => {
    const { core, snapshot, store } = harness();

    const result = await core.dispatch(dispatchInput(snapshot));

    expect(result).toEqual({
      ok: true,
      summary: "done",
      data: { value: "hello" },
    });
    const call = [...store.calls.values()][0]!;
    expect(call.toolName).toBe("test.read");
    expect(call.state).toBe("completed");
    expect(call.metadata).toMatchObject({
      runtimeToolCore: true,
      snapshotId: "tool_snapshot_core",
    });
    expect(store.events.map((event) => event.type)).toEqual([
      "tool.updated",
      "tool.updated",
    ]);
    expect(store.traces).toHaveLength(1);
    expect(store.traces[0]?.payload).toMatchObject({
      toolId: "test.read",
      ok: true,
    });
  });

  test("passes the frozen network scope to Runtime-local executors", async () => {
    let observedScope: string | undefined;
    const { core, snapshot } = harness(runtimeTool({
      execute: async (input: { value: string }, context) => {
        observedScope = context.networkAccessScope;
        return { summary: "done", data: { value: input.value } };
      },
    }));
    const scopedSnapshot = Object.freeze({
      ...snapshot,
      networkPolicy: Object.freeze({ accessScope: "public-only" as const }),
    });

    await core.dispatch(dispatchInput(scopedSnapshot));

    expect(observedScope).toBe("public-only");
  });

  test("fails closed for inactive Provider names before execution", async () => {
    let executed = false;
    const { core, snapshot } = harness(runtimeTool({
      execute: async () => {
        executed = true;
        return { summary: "no", data: { value: "no" } };
      },
    }));

    const result = await core.dispatch(dispatchInput(snapshot, "np__test__missing"));

    expect(result).toMatchObject({ ok: false, error: { code: "TOOL_NOT_ACTIVE" } });
    expect(executed).toBe(false);
  });

  test("validates and normalizes input before execution", async () => {
    const { core, snapshot } = harness();

    const result = await core.dispatch({
      ...dispatchInput(snapshot),
      input: { value: 42 },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "TOOL_INPUT_INVALID" } });
  });

  test("rejects dynamic risk that lowers its registered baseline", async () => {
    const tool = runtimeTool({
      risk: {
        mode: "dynamic",
        level: "high",
        reversible: "conditional",
        sideEffect: "business_write",
      },
      resolveRisk: async () => ({
        level: "low",
        reversible: true,
        sideEffects: ["none"],
      }),
    });
    const { core, snapshot } = harness(tool);

    const result = await core.dispatch(dispatchInput(snapshot));

    expect(result).toMatchObject({ ok: false, error: { code: "TOOL_RISK_INVALID" } });
  });

  test("rechecks resolved risk against the frozen Snapshot ceiling", async () => {
    const tool = runtimeTool({
      risk: {
        mode: "dynamic",
        level: "low",
        reversible: "conditional",
        sideEffect: "none",
      },
      resolveRisk: async () => ({
        level: "high",
        reversible: false,
        sideEffects: ["none", "destructive"],
      }),
    });
    const { core, snapshot } = harness(tool);
    const restricted = Object.freeze({
      ...snapshot,
      executionCeiling: Object.freeze({
        maxRiskLevel: "medium" as const,
        allowedSideEffects: Object.freeze(["none"] as const),
        allowIrreversible: false,
      }),
    });

    const result = await core.dispatch(dispatchInput(restricted));

    expect(result).toMatchObject({
      ok: false,
      error: { code: "TOOL_EXECUTION_CEILING_EXCEEDED" },
    });
  });

  test("surfaces ask without executing while Permission continuation is absent", async () => {
    let executed = false;
    const { core, snapshot, store } = harness(runtimeTool({
      risk: {
        mode: "static",
        level: "medium",
        reversible: true,
        sideEffect: "none",
      },
      execute: async () => {
        executed = true;
        return { summary: "no", data: { value: "no" } };
      },
    }));

    const result = await core.dispatch(dispatchInput(snapshot));

    expect(result).toMatchObject({
      ok: false,
      error: { code: "TOOL_PERMISSION_REQUIRED", outcome: "not_started" },
    });
    expect(executed).toBe(false);
    const call = [...store.calls.values()][0]!;
    const permission = [...store.permissions.values()][0]!;
    expect(call).toMatchObject({
      state: "waiting_for_permission",
      permissionId: permission.id,
    });
    expect(permission).toMatchObject({
      status: "pending",
      toolCallId: call.id,
      toolId: "test.read",
      risk: { level: "medium" },
      confirmation: { level: "standard" },
    });
    expect(store.events.map((event) => event.type)).toEqual([
      "tool.updated",
      "permission.requested",
    ]);
    expect(store.traces).toEqual([]);
  });

  test("persists strong confirmation presentation without tracing raw SQL", async () => {
    const sql = "DROP TABLE users";
    const { core, snapshot, store } = harness(runtimeTool({
      title: "Execute SQL",
      risk: {
        mode: "static",
        level: "critical",
        reversible: false,
        sideEffect: "destructive",
      },
      describePermission: async () => ({
        confirmationPrompt: "确认在 Production MySQL 执行",
        presentation: {
          target: {
            connectionName: "Production",
            driver: "mysql",
            database: "app",
          },
          riskReasons: ["SQL analysis is uncertain"],
          sql: {
            text: sql,
            analysisStatus: "uncertain",
            statementClass: "DDL",
            identifiedTargets: ["app.users"],
          },
          outcomeWarnings: ["May cause data loss"],
        },
      }),
    }));

    await core.dispatch({
      ...dispatchInput(snapshot),
      input: { value: sql },
    });

    expect([...store.permissions.values()][0]).toMatchObject({
      confirmation: {
        level: "strong",
        prompt: "确认在 Production MySQL 执行",
      },
      presentation: {
        target: { connectionName: "Production", driver: "mysql" },
        sql: { text: sql, analysisStatus: "uncertain" },
      },
    });
    expect(JSON.stringify(store.traces)).not.toContain(sql);
  });

  test("authorizes before execution and executes an approved ToolCall exactly once", async () => {
    let executions = 0;
    const { core, snapshot, store } = harness(runtimeTool({
      risk: {
        mode: "static",
        level: "high",
        reversible: false,
        sideEffect: "business_write",
      },
      execute: async () => {
        executions++;
        return { summary: "written", data: { value: "written" } };
      },
    }));
    const invocation = {
      ...dispatchInput(snapshot),
      toolCallId: "tool_approval_once" as ToolCall["id"],
    };

    const authorization = await core.authorize(invocation);

    expect(authorization.decision).toBe("ask");
    expect(executions).toBe(0);
    const pending = store.getPermissionByToolCallId(invocation.toolCallId)!;
    store.permissions.set(pending.id, {
      ...pending,
      status: "approved",
      decision: { source: "user", decidedAt: 10 },
    });

    const first = await core.dispatch(invocation);
    const second = await core.dispatch(invocation);

    expect(first).toMatchObject({ ok: true, summary: "written" });
    expect(second).toEqual(first);
    expect(executions).toBe(1);
    expect(store.getToolCall(invocation.toolCallId)).toMatchObject({
      state: "completed",
      permissionId: pending.id,
      time: { created: expect.any(Number), completed: expect.any(Number) },
    });
  });

  test("enforces timeout and never retries automatically", async () => {
    let executions = 0;
    const { core, snapshot } = harness(runtimeTool({
      limits: { timeoutMs: 5 },
      execute: async (_input, context) => {
        executions++;
        await new Promise<void>((resolve) => {
          context.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { summary: "late", data: { value: "late" } };
      },
    }));

    const result = await core.dispatch(dispatchInput(snapshot));

    expect(result).toMatchObject({
      ok: false,
      error: { code: "TOOL_EXECUTION_TIMEOUT", outcome: "unknown" },
    });
    expect(executions).toBe(1);
  });

  test("routes Backend Tools by their canonical operation name", async () => {
    const operations: string[] = [];
    const tool = defineBackendTool<
      { value: string },
      { value: string; password?: string }
    >({
      id: "test.read",
      title: "Read",
      description: "Read test data",
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({
        value: z.string(),
        password: z.string().optional(),
      }),
      executionTarget: "backend",
      risk: {
        mode: "static",
        level: "low",
        reversible: true,
        sideEffect: "none",
      },
    });
    const { core, snapshot } = harness(tool, {
      backendExecutor: {
        execute: async (operation, input) => {
          operations.push(operation);
          return { summary: "backend", data: input };
        },
      },
    });

    const result = await core.dispatch(dispatchInput(snapshot));

    expect(result).toMatchObject({ ok: true, summary: "backend" });
    expect(operations).toEqual(["test.read"]);
  });

  test("runs Backend Tool pre/post checks around one controlled proceed call", async () => {
    const order: string[] = [];
    let outputSchemaParses = 0;
    const outputSchema = z.object({ value: z.string() }).superRefine(() => {
      outputSchemaParses++;
    });
    const tool = defineBackendTool<
      { value: string },
      { value: string }
    >({
      id: "test.read",
      title: "Read",
      description: "Read test data",
      inputSchema: z.object({ value: z.string() }),
      outputSchema,
      executionTarget: "backend",
      risk: {
        mode: "static",
        level: "low",
        reversible: true,
        sideEffect: "none",
      },
      execute: async (input, context) => {
        order.push(`pre:${input.value}`);
        const output = await context.proceed();
        order.push(`post:${output.data.value}`);
        expect(Object.isFrozen(output)).toBe(true);
        expect(Object.isFrozen(output.data)).toBe(true);
        return output;
      },
    });
    const { core, snapshot } = harness(tool, {
      backendExecutor: {
        execute: async () => {
          order.push("backend");
          return { summary: "done", data: { value: "hello" } };
        },
      },
    });

    expect(await core.dispatch(dispatchInput(snapshot))).toMatchObject({
      ok: true,
      data: { value: "hello" },
    });
    expect(order).toEqual(["pre:hello", "backend", "post:hello"]);
    expect(outputSchemaParses).toBe(1);
  });

  test("fails closed when Backend Tool bypasses or repeats proceed", async () => {
    const base = {
      id: "test.read",
      title: "Read",
      description: "Read test data",
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ value: z.string() }),
      executionTarget: "backend" as const,
      risk: {
        mode: "static" as const,
        level: "low" as const,
        reversible: true,
        sideEffect: "none" as const,
      },
    };
    let backendCalls = 0;
    const backendExecutor = {
      execute: async () => {
        backendCalls++;
        return { summary: "done", data: { value: "hello" } };
      },
    };

    const bypassed = harness(defineBackendTool({
      ...base,
      execute: async () => ({ summary: "bypassed", data: { value: "hello" } }),
    }), { backendExecutor });
    expect(
      await bypassed.core.dispatch(dispatchInput(bypassed.snapshot)),
    ).toMatchObject({
      ok: false,
      error: { code: "BACKEND_PROCEED_NOT_CALLED", outcome: "not_started" },
    });

    const repeated = harness(defineBackendTool({
      ...base,
      execute: async (_input, context) => {
        const output = await context.proceed();
        try {
          await context.proceed();
        } catch {
          // Core must still reject the attempted second call.
        }
        return output;
      },
    }), { backendExecutor });
    expect(
      await repeated.core.dispatch(dispatchInput(repeated.snapshot)),
    ).toMatchObject({
      ok: false,
      error: { code: "BACKEND_PROCEED_ALREADY_CALLED", outcome: "unknown" },
    });
    expect(backendCalls).toBe(1);
  });

  test("rejects replacement of a Backend proceed result", async () => {
    const tool = defineBackendTool({
      id: "test.read",
      title: "Read",
      description: "Read test data",
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ value: z.string() }),
      executionTarget: "backend",
      risk: {
        mode: "static",
        level: "low",
        reversible: true,
        sideEffect: "none",
      },
      execute: async (_input, context) => {
        await context.proceed();
        return { summary: "replacement", data: { value: "hello" } };
      },
    });
    const { core, snapshot } = harness(tool, {
      backendExecutor: {
        execute: async () => ({
          summary: "backend",
          data: { value: "hello" },
        }),
      },
    });

    expect(await core.dispatch(dispatchInput(snapshot))).toMatchObject({
      ok: false,
      error: { code: "BACKEND_EXECUTION_RESULT_REPLACED", outcome: "unknown" },
    });
  });

  test("validates output, redacts secret fields, and bounds result bytes", async () => {
    const invalid = harness(runtimeTool({
      execute: async () => ({ summary: "bad", data: { value: 3 } }),
    }));
    expect(await invalid.core.dispatch(dispatchInput(invalid.snapshot))).toMatchObject({
      ok: false,
      error: { code: "TOOL_OUTPUT_INVALID" },
    });

    const redacted = harness(runtimeTool({
      execute: async () => ({
        summary: "safe",
        data: { value: "ok", password: "do-not-store" },
      }),
    }));
    expect(await redacted.core.dispatch(dispatchInput(redacted.snapshot))).toMatchObject({
      ok: true,
      data: { password: "[REDACTED]" },
    });

    const bounded = harness(runtimeTool({
      limits: { maxResultBytes: 10 },
      execute: async () => ({ summary: "large", data: { value: "too large" } }),
    }));
    expect(await bounded.core.dispatch(dispatchInput(bounded.snapshot))).toMatchObject({
      ok: false,
      error: { code: "TOOL_RESULT_TOO_LARGE" },
    });
  });

  test("normalizes unknown exceptions and enforces the per-Run call limit", async () => {
    const failed = harness(runtimeTool({
      execute: async () => {
        throw new Error("password=should-not-leak");
      },
    }));
    expect(await failed.core.dispatch(dispatchInput(failed.snapshot))).toEqual({
      ok: false,
      error: {
        code: "TOOL_EXECUTION_FAILED",
        message: "Tool execution failed.",
        retryable: false,
        outcome: "unknown",
      },
    });

    const limited = harness(runtimeTool(), { maxToolCallsPerRun: 1 });
    await limited.core.dispatch(dispatchInput(limited.snapshot));
    expect(await limited.core.dispatch(dispatchInput(limited.snapshot))).toMatchObject({
      ok: false,
      error: { code: "TOOL_CALL_LIMIT_EXCEEDED" },
    });
  });

  test("reserves the per-Run call limit across concurrent execution", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { core, snapshot } = harness(runtimeTool({
      execute: async (input: { value: string }) => {
        await gate;
        return { summary: "done", data: input };
      },
    }), { maxToolCallsPerRun: 1 });

    const first = core.dispatch(dispatchInput(snapshot));
    await Promise.resolve();
    const second = await core.dispatch(dispatchInput(snapshot));
    release?.();

    expect(second).toMatchObject({
      ok: false,
      error: { code: "TOOL_CALL_LIMIT_EXCEEDED" },
    });
    expect(await first).toMatchObject({ ok: true });
  });

  test("preserves explicitly typed executor errors", async () => {
    const { core, snapshot } = harness(runtimeTool({
      execute: async () => {
        throw new RuntimeToolExecutionError(
          "NETWORK_ACCESS_SCOPE_DENIED",
          "当前网络访问范围设为“仅公网”，不能访问本地或私有网络目标。",
          false,
          "no_effect",
          {
            policy: "network_access_scope",
            accessScope: "public-only",
            remediation: {
              action: "change_runtime_setting",
              setting: "network_policy.access_scope",
              suggestedValue: "local-and-public",
              takesEffect: "new_run",
            },
            guidance: [
              "只有当完成用户请求确实需要该目标时，告知用户可在“设置 → AI 能力 → 偏好设置 → 网络访问范围”中改为“本地网络与公网”；不要自动修改该偏好。",
              "在用户未修改该设置前，不要重复调用同一被拒绝目标。",
            ],
          },
        );
      },
    }));

    expect(await core.dispatch(dispatchInput(snapshot))).toMatchObject({
      ok: false,
      error: {
        code: "NETWORK_ACCESS_SCOPE_DENIED",
        outcome: "no_effect",
        details: {
          policy: "network_access_scope",
          accessScope: "public-only",
          remediation: {
            action: "change_runtime_setting",
            setting: "network_policy.access_scope",
            suggestedValue: "local-and-public",
            takesEffect: "new_run",
          },
          guidance: [
            "只有当完成用户请求确实需要该目标时，告知用户可在“设置 → AI 能力 → 偏好设置 → 网络访问范围”中改为“本地网络与公网”；不要自动修改该偏好。",
            "在用户未修改该设置前，不要重复调用同一被拒绝目标。",
          ],
        },
      },
    });
  });
});
