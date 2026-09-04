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
