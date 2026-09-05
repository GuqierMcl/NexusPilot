import { describe, expect, test } from "bun:test";
import {
  buildRuntimeSafetyState,
  estimateJsonTokens,
  runtimeSafetyStateSchema,
  type Permission,
  type ToolCall,
} from "../src/runtime";

const completedDrop: ToolCall = {
  id: "tool_drop",
  conversationId: "conv_safety",
  runId: "run_d",
  messageId: "msg_assistant_d",
  toolName: "metadata.delete_object",
  input: { profileId: "profile_prod", object: "users" },
  state: "completed",
  permissionId: "perm_drop",
  result: { ok: true, summary: "Object deleted", data: { deleted: true } },
  time: { created: 40, started: 41, completed: 42 },
};

const uncertainWrite: ToolCall = {
  id: "tool_uncertain",
  conversationId: "conv_safety",
  runId: "run_x",
  messageId: "msg_assistant_x",
  toolName: "sql.execute",
  input: { profileId: "profile_prod", sql: "UPDATE accounts SET enabled = 0" },
  state: "error",
  permissionId: "perm_uncertain",
  error: {
    code: "MUTATION_OUTCOME_UNKNOWN",
    message: "Connection closed before acknowledgement",
    retryable: false,
    outcome: "unknown",
  },
  time: { created: 50, started: 51, completed: 52 },
};

const readOnlyQuery: ToolCall = {
  id: "tool_read",
  conversationId: "conv_safety",
  runId: "run_e",
  messageId: "msg_assistant_e",
  toolName: "metadata.list_children",
  input: { profileId: "profile_prod" },
  state: "completed",
  permissionId: "perm_read",
  result: { ok: true, summary: "Schemas listed", data: { names: ["public"] } },
  time: { created: 60, started: 61, completed: 62 },
};

const permissions: Permission[] = [
  {
    id: "perm_drop",
    conversationId: "conv_safety",
    runId: "run_d",
    messageId: "msg_assistant_d",
    toolCallId: "tool_drop",
    status: "approved",
    toolId: "metadata.delete_object",
    title: "Delete object",
    risk: { level: "critical", reversible: false, sideEffects: ["destructive"] },
    confirmation: { level: "strong" },
    presentation: {
      target: {
        profileId: "profile_prod",
        connectionName: "Production",
        driver: "postgres",
        environment: "production",
        database: "app",
        schema: "public",
      },
      sql: {
        text: "DROP TABLE public.users",
        analysisStatus: "analyzed",
        statementClass: "ddl",
        identifiedTargets: ["public.users"],
      },
    },
    decision: {
      source: "user",
      confirmationVerified: true,
      decidedAt: 41,
    },
    createdAt: 40,
  },
  {
    id: "perm_uncertain",
    conversationId: "conv_safety",
    runId: "run_x",
    messageId: "msg_assistant_x",
    toolCallId: "tool_uncertain",
    status: "approved",
    toolId: "sql.execute",
    title: "Execute update",
    risk: { level: "high", reversible: false, sideEffects: ["business_write"] },
    confirmation: { level: "standard" },
    presentation: {
      target: { profileId: "profile_prod", driver: "postgres", database: "app" },
      sql: {
        text: "UPDATE accounts SET enabled = 0",
        analysisStatus: "uncertain",
        statementClass: "dml",
        identifiedTargets: ["accounts"],
      },
    },
    decision: { source: "user", decidedAt: 51 },
    createdAt: 50,
  },
  {
    id: "perm_read",
    conversationId: "conv_safety",
    runId: "run_e",
    messageId: "msg_assistant_e",
    toolCallId: "tool_read",
    status: "approved",
    toolId: "metadata.list_children",
    title: "List metadata",
    risk: { level: "low", reversible: true, sideEffects: ["business_read"] },
    confirmation: { level: "standard" },
    decision: { source: "system", decidedAt: 61 },
    createdAt: 60,
  },
];

describe("deterministic Runtime Safety State", () => {
  test("retains old-branch destructive and uncertain writes without promoting read-only output", () => {
    const state = buildRuntimeSafetyState({
      conversationId: "conv_safety",
      activeRunIds: ["run_a", "run_b", "run_e"],
      toolCalls: [uncertainWrite, readOnlyQuery, completedDrop],
      permissions: [permissions[1]!, permissions[2]!, permissions[0]!],
    });

    expect(state.effects).toEqual([
      {
        toolCallId: "tool_drop",
        runId: "run_d",
        operation: "metadata.delete_object",
        activeLineage: false,
        risk: { level: "critical", reversible: false, sideEffects: ["destructive"] },
        target: {
          kind: "structured",
          profileId: "profile_prod",
          connectionName: "Production",
          driver: "postgres",
          environment: "production",
          database: "app",
          schema: "public",
          identifiedTargets: ["public.users"],
        },
        outcome: "completed",
        certainty: "confirmed",
      },
      {
        toolCallId: "tool_uncertain",
        runId: "run_x",
        operation: "sql.execute",
        activeLineage: false,
        risk: { level: "high", reversible: false, sideEffects: ["business_write"] },
        target: {
          kind: "structured",
          profileId: "profile_prod",
          driver: "postgres",
          database: "app",
          identifiedTargets: ["accounts"],
        },
        outcome: "possibly_executed",
        certainty: "uncertain",
      },
    ]);
    expect(state.effects.map((effect) => effect.toolCallId)).not.toContain("tool_read");
    expect(state.permissions).toEqual([
      {
        permissionId: "perm_drop",
        toolCallId: "tool_drop",
        runId: "run_d",
        status: "approved",
        decisionSource: "user",
        confirmationVerified: true,
        nonTransferable: true,
      },
      {
        permissionId: "perm_read",
        toolCallId: "tool_read",
        runId: "run_e",
        status: "approved",
        decisionSource: "system",
        nonTransferable: true,
      },
      {
        permissionId: "perm_uncertain",
        toolCallId: "tool_uncertain",
        runId: "run_x",
        status: "approved",
        decisionSource: "user",
        nonTransferable: true,
      },
    ]);
    expect(runtimeSafetyStateSchema.parse(state)).toEqual(state);
  });

  test("orders and serializes the same structured facts deterministically", () => {
    const first = buildRuntimeSafetyState({
      conversationId: "conv_safety",
      activeRunIds: ["run_a", "run_b", "run_e"],
      toolCalls: [completedDrop, uncertainWrite, readOnlyQuery],
      permissions,
    });
    const second = buildRuntimeSafetyState({
      conversationId: "conv_safety",
      activeRunIds: ["run_e", "run_b", "run_a"],
      toolCalls: [readOnlyQuery, uncertainWrite, completedDrop],
      permissions: [...permissions].reverse(),
    });

    expect(second).toEqual(first);
    expect(first.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("projects only persisted Tool Core prepared-plan facts for active continuation", () => {
    const preparedCall: ToolCall = {
      ...uncertainWrite,
      id: "tool_prepared",
      runId: "run_e",
      messageId: "msg_assistant_e",
      permissionId: "perm_prepared",
      state: "waiting_for_permission",
      time: { created: 70 },
      metadata: {
        runtimeToolCore: true,
        snapshotId: "tool_snapshot_e",
        preparedPlan: {
          prepareOperation: "sql.prepare_execute",
          expiresAt: 9_000,
        },
        arbitrarySecret: "MUST_NOT_LEAK_FROM_TOOL_CALL_METADATA",
      },
    };
    const preparedPermission: Permission = {
      ...permissions[1]!,
      id: "perm_prepared",
      runId: "run_e",
      messageId: "msg_assistant_e",
      toolCallId: "tool_prepared",
      status: "pending",
      metadata: {
        preparedPlan: {
          prepareOperation: "sql.prepare_execute",
          expiresAt: 9_000,
        },
        arbitrarySecret: "MUST_NOT_LEAK_FROM_PERMISSION_METADATA",
      },
      decision: undefined,
      createdAt: 70,
    };

    const first = buildRuntimeSafetyState({
      conversationId: "conv_safety",
      activeRunIds: ["run_a", "run_e"],
      toolCalls: [preparedCall, completedDrop],
      permissions: [preparedPermission, permissions[0]!],
    });
    const second = buildRuntimeSafetyState({
      conversationId: "conv_safety",
      activeRunIds: ["run_e", "run_a"],
      toolCalls: [completedDrop, preparedCall],
      permissions: [permissions[0]!, preparedPermission],
    });

    expect(first.continuations).toEqual([{
      toolCallId: "tool_prepared",
      runId: "run_e",
      prepareOperation: "sql.prepare_execute",
      expiresAt: 9_000,
      requiresRevalidation: true,
    }]);
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("MUST_NOT_LEAK");
    expect(runtimeSafetyStateSchema.parse(first)).toEqual(first);
    expect(() =>
      buildRuntimeSafetyState({
        conversationId: "conv_safety",
        activeRunIds: ["run_e"],
        toolCalls: [preparedCall],
        permissions: [preparedPermission],
        maxTokens: 1,
      }),
    ).toThrow("Runtime Safety State exceeds its assigned token budget");
  });

  test.each([
    ["unknown keys", {
      prepareOperation: "sql.prepare_execute",
      expiresAt: 9_000,
      unexpected: "MUST_NOT_BE_ACCEPTED",
    }],
    ["an empty prepareOperation", { prepareOperation: "", expiresAt: 9_000 }],
    ["a fractional expiresAt", { prepareOperation: "sql.prepare_execute", expiresAt: 9_000.5 }],
    ["a negative expiresAt", { prepareOperation: "sql.prepare_execute", expiresAt: -1 }],
  ])("fails closed when ToolCall preparedPlan contains %s", (_case, preparedPlan) => {
    const toolCall: ToolCall = {
      ...uncertainWrite,
      id: "tool_invalid_prepared",
      runId: "run_e",
      messageId: "msg_assistant_e",
      permissionId: undefined,
      state: "validating",
      time: { created: 70 },
      metadata: { runtimeToolCore: true, preparedPlan },
    };

    expect(() =>
      buildRuntimeSafetyState({
        conversationId: "conv_safety",
        activeRunIds: ["run_e"],
        toolCalls: [toolCall],
        permissions: [],
      }),
    ).toThrow("Invalid ToolCall prepared-plan facts for ToolCall tool_invalid_prepared");
  });

  test("fails closed when a bound Permission preparedPlan is malformed", () => {
    const toolCall: ToolCall = {
      ...uncertainWrite,
      id: "tool_invalid_permission_plan",
      runId: "run_e",
      messageId: "msg_assistant_e",
      permissionId: "perm_invalid_permission_plan",
      state: "waiting_for_permission",
      time: { created: 70 },
      metadata: {
        runtimeToolCore: true,
        preparedPlan: { prepareOperation: "sql.prepare_execute", expiresAt: 9_000 },
      },
    };
    const permission: Permission = {
      ...permissions[1]!,
      id: "perm_invalid_permission_plan",
      runId: "run_e",
      messageId: "msg_assistant_e",
      toolCallId: toolCall.id,
      status: "pending",
      decision: undefined,
      metadata: { preparedPlan: { prepareOperation: 42, expiresAt: 9_000 } },
      createdAt: 70,
    };

    expect(() =>
      buildRuntimeSafetyState({
        conversationId: "conv_safety",
        activeRunIds: ["run_e"],
        toolCalls: [toolCall],
        permissions: [permission],
      }),
    ).toThrow("Invalid Permission prepared-plan facts for ToolCall tool_invalid_permission_plan");
  });

  test("fails closed when ToolCall and bound Permission preparedPlan facts disagree", () => {
    const toolCall: ToolCall = {
      ...uncertainWrite,
      id: "tool_conflicting_plan",
      runId: "run_e",
      messageId: "msg_assistant_e",
      permissionId: "perm_conflicting_plan",
      state: "waiting_for_permission",
      time: { created: 70 },
      metadata: {
        runtimeToolCore: true,
        preparedPlan: { prepareOperation: "sql.prepare_execute", expiresAt: 9_000 },
      },
    };
    const permission: Permission = {
      ...permissions[1]!,
      id: "perm_conflicting_plan",
      runId: "run_e",
      messageId: "msg_assistant_e",
      toolCallId: toolCall.id,
      status: "pending",
      decision: undefined,
      metadata: {
        preparedPlan: { prepareOperation: "sql.prepare_execute", expiresAt: 9_001 },
      },
      createdAt: 70,
    };

    expect(() =>
      buildRuntimeSafetyState({
        conversationId: "conv_safety",
        activeRunIds: ["run_e"],
        toolCalls: [toolCall],
        permissions: [permission],
      }),
    ).toThrow("Conflicting prepared-plan facts for ToolCall tool_conflicting_plan");
  });

  test("does not promote an unbound Permission preparedPlan into continuation state", () => {
    const toolCall: ToolCall = {
      ...uncertainWrite,
      id: "tool_unbound_plan",
      runId: "run_e",
      messageId: "msg_assistant_e",
      permissionId: "perm_unbound_plan",
      state: "waiting_for_permission",
      time: { created: 70 },
      metadata: { runtimeToolCore: true },
    };
    const unboundPermission: Permission = {
      ...permissions[1]!,
      id: "perm_unbound_plan",
      runId: "run_e",
      messageId: "msg_assistant_other",
      toolCallId: toolCall.id,
      status: "pending",
      decision: undefined,
      metadata: {
        preparedPlan: { prepareOperation: "sql.prepare_execute", expiresAt: 9_000 },
      },
      createdAt: 70,
    };

    const state = buildRuntimeSafetyState({
      conversationId: "conv_safety",
      activeRunIds: ["run_e"],
      toolCalls: [toolCall],
      permissions: [unboundPermission],
    });

    expect(state.continuations).toEqual([]);
  });

  test("fails closed with explicit unknown risk and target when no Permission facts exist", () => {
    const unclassified: ToolCall = {
      id: "tool_unclassified",
      conversationId: "conv_safety",
      runId: "run_e",
      messageId: "msg_assistant_e",
      toolName: "custom.operation",
      input: {},
      state: "completed",
      result: { ok: true, summary: "Done", data: {} },
      time: { created: 70, started: 71, completed: 72 },
      metadata: {
        risk: { level: "low", sideEffects: ["none"] },
        target: { database: "must-not-be-trusted" },
      },
    };
    const state = buildRuntimeSafetyState({
      conversationId: "conv_safety",
      activeRunIds: ["run_e"],
      toolCalls: [unclassified],
      permissions: [],
    });

    expect(state.effects).toEqual([
      {
        toolCallId: "tool_unclassified",
        runId: "run_e",
        operation: "custom.operation",
        activeLineage: true,
        risk: { level: "unknown", reversible: "unknown", sideEffects: ["unknown"] },
        target: { kind: "unknown" },
        outcome: "completed",
        certainty: "uncertain",
      },
    ]);
  });

  test("omits structurally proven read/no-effect calls but preserves Permission audit facts", () => {
    const noEffectWrite: ToolCall = {
      ...uncertainWrite,
      id: "tool_no_effect",
      permissionId: "perm_no_effect",
      state: "error",
      error: {
        code: "VALIDATION_ERROR",
        message: "Rejected before execution",
        retryable: false,
        outcome: "not_started",
      },
    };
    const noEffectPermission: Permission = {
      ...permissions[1]!,
      id: "perm_no_effect",
      toolCallId: "tool_no_effect",
      status: "denied",
      decision: { source: "user", decidedAt: 51 },
    };
    const state = buildRuntimeSafetyState({
      conversationId: "conv_safety",
      activeRunIds: ["run_e"],
      toolCalls: [readOnlyQuery, noEffectWrite],
      permissions: [permissions[2]!, noEffectPermission],
    });

    expect(state.effects).toEqual([]);
    expect(state.permissions.map((permission) => permission.permissionId)).toEqual([
      "perm_read",
      "perm_no_effect",
    ]);
  });

  test("fails closed instead of truncating required entries past the assigned budget", () => {
    expect(() =>
      buildRuntimeSafetyState({
        conversationId: "conv_safety",
        activeRunIds: ["run_e"],
        toolCalls: [completedDrop, uncertainWrite],
        permissions: [permissions[0]!, permissions[1]!],
        maxTokens: 1,
      }),
    ).toThrow("Runtime Safety State exceeds its assigned token budget");

    const unbounded = buildRuntimeSafetyState({
      conversationId: "conv_safety",
      activeRunIds: ["run_e"],
      toolCalls: [completedDrop],
      permissions: [permissions[0]!],
    });
    expect(estimateJsonTokens(unbounded)).toBeGreaterThan(1);
  });
});
