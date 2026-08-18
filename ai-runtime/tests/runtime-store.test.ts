import { describe, expect, test } from "bun:test";
import { openRuntimeDatabase } from "../src/storage/runtime-database";
import { RuntimeEventBus, RuntimeSqliteStore } from "../src/runtime";
import type {
  Conversation,
  Event,
  Message,
  Part,
  Permission,
  RuntimeEventEnvelope,
  Run,
  ToolCall,
  TraceEvent,
} from "../src/runtime";

function createStore(options: { eventBus?: RuntimeEventBus } = {}) {
  const db = openRuntimeDatabase(":memory:");
  return { db, store: new RuntimeSqliteStore(db, { eventBus: options.eventBus }) };
}

function createStoreWithEventBus() {
  const eventBus = new RuntimeEventBus();
  const { db, store } = createStore({ eventBus });
  return { db, store, eventBus };
}

describe("RuntimeSqliteStore", () => {
  test("persists conversations, runs, messages, and structured diff parts", () => {
    const { db, store } = createStore();

    const conversation: Conversation = {
      id: "conv_store",
      title: "Store test",
      version: "1",
      status: { type: "idle" },
      time: { created: 1, updated: 1 },
    };

    const run: Run = {
      id: "run_store",
      conversationId: conversation.id,
      agentMode: "ask",
      providerId: "openai",
      modelId: "gpt-4o",
      status: "queued",
      input: {
        messageIds: ["msg_user"],
        prompt: {
          version: "runtime-prompt-v1",
          blockIds: ["runtime.base", "agent.behavior", "runtime.boundaries", "output.style"],
          warnings: [],
        },
        tools: {
          snapshotId: "tool_snapshot_store",
          runId: "run_store",
          createdAt: new Date(0).toISOString(),
          agentMode: "ask",
          executionCeiling: {
            maxRiskLevel: "low",
            allowedSideEffects: [],
            allowIrreversible: false,
          },
          activeTools: [],
        },
      },
      limits: { maxSteps: 1, maxToolCalls: 0 },
      time: { created: 2 },
    };

    const diffPart: Part = {
      id: "part_diff_store",
      conversationId: conversation.id,
      messageId: "msg_assistant",
      type: "diff",
      status: "proposed",
      diff: {
        id: "diff_store",
        title: "SQL projection",
        kind: "sql",
        target: { type: "memory", name: "active.sql", language: "sql" },
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [
              { type: "remove", oldLine: 1, text: "SELECT * FROM users" },
              { type: "add", newLine: 1, text: "SELECT id FROM users" },
            ],
          },
        ],
      },
    };

    const message: Message = {
      id: "msg_assistant",
      conversationId: conversation.id,
      role: "assistant",
      runId: run.id,
      parentId: "msg_user",
      providerId: "openai",
      modelId: "gpt-4o",
      agentMode: "ask",
      status: { type: "running" },
      parts: [diffPart],
      time: { created: 3 },
    };

    store.saveConversation(conversation);
    store.saveRun(run);
    store.saveMessage(message);

    expect(store.getConversation(conversation.id)).toEqual(conversation);
    expect(store.getRun(run.id)).toEqual(run);
    expect(store.getMessage(message.id)).toEqual(message);
    expect(store.listMessages(conversation.id)).toEqual([message]);
    expect(store.listParts(message.id)).toEqual([diffPart]);

    db.close();
  });

  test("persists tool calls, permissions, events, and traces", () => {
    const { db, store } = createStore();

    const conversation: Conversation = {
      id: "conv_tool",
      title: "Tool store test",
      version: "1",
      status: { type: "idle" },
      time: { created: 1, updated: 1 },
    };
    store.saveConversation(conversation);

    const run: Run = {
      id: "run_tool",
      conversationId: conversation.id,
      agentMode: "ask",
      providerId: "openai",
      modelId: "gpt-4o",
      status: "running",
      input: { messageIds: ["msg_tool"] },
      limits: { maxSteps: 4, maxToolCalls: 8 },
      time: { created: 2 },
    };
    store.saveRun(run);

    const message: Message = {
      id: "msg_tool",
      conversationId: conversation.id,
      role: "assistant",
      runId: run.id,
      parentId: "msg_user",
      providerId: "openai",
      modelId: "gpt-4o",
      agentMode: "ask",
      status: { type: "running" },
      parts: [],
      time: { created: 3 },
    };
    store.saveMessage(message);

    const toolCall: ToolCall = {
      id: "tool_1",
      conversationId: conversation.id,
      runId: run.id,
      messageId: message.id,
      toolName: "datetime_now",
      input: {},
      state: "completed",
      result: {
        ok: true,
        summary: "Current time",
        data: { iso: "2026-06-16T00:00:00.000Z" },
      },
      time: { created: 4, started: 4, completed: 5 },
    };
    store.saveToolCall(toolCall);

    const permission: Permission = {
      id: "perm_1",
      conversationId: conversation.id,
      runId: run.id,
      messageId: message.id,
      toolCallId: toolCall.id,
      status: "approved",
      toolId: "system.current_time",
      title: "Allow runtime read",
      risk: {
        level: "low",
        reversible: true,
        sideEffects: ["none"],
      },
      confirmation: { level: "standard" },
      decision: { source: "system", decidedAt: 4 },
      createdAt: 4,
    };
    store.savePermission(permission);

    const event: Event = {
      id: "evt_1",
      type: "tool.updated",
      properties: { info: toolCall },
      time: 5,
    };
    store.appendEvent(event);

    const trace: TraceEvent = {
      id: "trace_1",
      conversationId: conversation.id,
      runId: run.id,
      type: "tool.executed",
      level: "info",
      time: 5,
      payload: { toolName: "datetime_now" },
    };
    store.appendTrace(trace);

    expect(store.getToolCall(toolCall.id)).toEqual(toolCall);
    expect(store.getPermission(permission.id)).toEqual(permission);
    expect(store.listEvents(conversation.id)).toEqual([event]);
    expect(store.listTraces(run.id)).toEqual([trace]);

    db.close();
  });

  test("atomically persists a pending Tool Permission and enforces one decision", () => {
    const { db, store } = createStore();
    const conversation: Conversation = {
      id: "conv_permission",
      title: "Permission",
      version: "1",
      status: { type: "busy", runId: "run_permission" },
      time: { created: 1, updated: 2 },
    };
    const run: Run = {
      id: "run_permission",
      conversationId: conversation.id,
      assistantMessageId: "msg_permission",
      agentMode: "agent",
      providerId: "openai",
      modelId: "gpt-4o",
      status: "running",
      input: { messageIds: ["msg_user_permission"] },
      limits: { maxSteps: 4, maxToolCalls: 8 },
      time: { created: 2, started: 3 },
    };
    const message: Message = {
      id: "msg_permission",
      conversationId: conversation.id,
      role: "assistant",
      runId: run.id,
      parentId: "msg_user_permission",
      providerId: "openai",
      modelId: "gpt-4o",
      agentMode: "agent",
      status: { type: "running" },
      parts: [],
      time: { created: 3 },
    };
    store.saveConversation(conversation);
    store.saveRun(run);
    store.saveMessage(message);

    const toolCall: ToolCall = {
      id: "tool_permission",
      conversationId: conversation.id,
      runId: run.id,
      messageId: message.id,
      toolName: "test.write",
      input: { value: "safe-summary-source" },
      state: "waiting_for_permission",
      permissionId: "perm_permission",
      time: { created: 4 },
    };
    const permission: Permission = {
      id: "perm_permission",
      conversationId: conversation.id,
      runId: run.id,
      messageId: message.id,
      toolCallId: toolCall.id,
      status: "pending",
      toolId: "test.write",
      title: "Write test data",
      risk: {
        level: "high",
        reversible: false,
        sideEffects: ["business_write"],
      },
      confirmation: { level: "standard" },
      createdAt: 4,
    };

    store.commitToolPermissionRequest({
      toolCall,
      permission,
      requestedAt: 4,
      eventIds: {
        tool: "evt_permission_tool",
        permission: "evt_permission_requested",
        run: "evt_permission_run",
        conversation: "evt_permission_conversation",
      },
    });

    expect(store.getToolCall(toolCall.id)).toEqual(toolCall);
    expect(store.getPermission(permission.id)).toEqual(permission);
    expect(store.listPendingPermissionsByRun(run.id)).toEqual([permission]);
    expect(store.getRun(run.id)?.status).toBe("waiting_for_permission");
    expect(store.getConversation(conversation.id)?.status).toEqual({
      type: "waiting_for_permission",
      runId: run.id,
      permissionId: permission.id,
    });
    expect(
      new Set(store.listEventsByRun(run.id).map((event) => event.type)),
    ).toEqual(new Set([
      "tool.updated",
      "permission.requested",
      "run.updated",
    ]));
    expect(() =>
      store.resolvePermission({
        permissionId: permission.id,
        runId: "run_other",
        status: "approved",
        source: "user",
        decidedAt: 5,
        eventId: "evt_permission_cross_run",
      })
    ).toThrow("not found for this Run");
    expect(store.getPermission(permission.id)?.status).toBe("pending");

    const approved = store.resolvePermission({
      permissionId: permission.id,
      runId: run.id,
      status: "approved",
      source: "user",
      reason: "approved in test",
      decidedAt: 5,
      eventId: "evt_permission_resolved",
    });
    expect(approved).toMatchObject({
      status: "approved",
      decision: {
        source: "user",
        reason: "approved in test",
        decidedAt: 5,
      },
    });
    expect(store.listPendingPermissionsByRun(run.id)).toEqual([]);
    expect(() =>
      store.resolvePermission({
        permissionId: permission.id,
        runId: run.id,
        status: "denied",
        source: "user",
        decidedAt: 6,
        eventId: "evt_permission_duplicate",
      })
    ).toThrow("no longer pending");

    const eventCountBeforeConflict = store.listEvents(conversation.id).length;
    const conflictingToolCall: ToolCall = {
      ...toolCall,
      permissionId: "perm_permission_conflict",
    };
    const conflictingPermission: Permission = {
      ...permission,
      id: "perm_permission_conflict",
    };
    expect(() =>
      store.commitToolPermissionRequest({
        toolCall: conflictingToolCall,
        permission: conflictingPermission,
        requestedAt: 7,
        eventIds: {
          tool: "evt_permission_conflict_tool",
          permission: "evt_permission_conflict_permission",
          run: "evt_permission_conflict_run",
          conversation: "evt_permission_conflict_conversation",
        },
      })
    ).toThrow();
    expect(store.getToolCall(toolCall.id)?.permissionId).toBe(permission.id);
    expect(store.getPermission(conflictingPermission.id)).toBeNull();
    expect(store.listEvents(conversation.id)).toHaveLength(eventCountBeforeConflict);

    db.close();
  });

  test("binds AI SDK approvals and atomically continues a complete Permission batch", () => {
    const { db, store } = createStore();
    const conversation: Conversation = {
      id: "conv_continue",
      title: "Continue",
      version: "1",
      status: { type: "busy", runId: "run_continue" },
      time: { created: 1, updated: 2 },
    };
    const run: Run = {
      id: "run_continue",
      conversationId: conversation.id,
      parentMessageId: "msg_continue_user",
      assistantMessageId: "msg_continue_assistant",
      agentMode: "agent",
      providerId: "openai",
      modelId: "gpt-4o",
      status: "running",
      input: { messageIds: ["msg_continue_user"] },
      limits: { maxSteps: 4, maxToolCalls: 8 },
      time: { created: 2, started: 3 },
    };
    const message: Message = {
      id: "msg_continue_assistant",
      conversationId: conversation.id,
      role: "assistant",
      runId: run.id,
      parentId: "msg_continue_user",
      providerId: "openai",
      modelId: "gpt-4o",
      agentMode: "agent",
      status: { type: "running" },
      parts: [],
      time: { created: 3 },
    };
    store.saveConversation(conversation);
    store.saveRun(run);
    store.saveMessage(message);

    const createPending = (suffix: string): {
      toolCall: ToolCall;
      permission: Permission;
    } => {
      const toolCall: ToolCall = {
        id: `tool_continue_${suffix}`,
        conversationId: conversation.id,
        runId: run.id,
        messageId: message.id,
        toolName: "test.write",
        input: { value: suffix },
        state: "waiting_for_permission",
        permissionId: `perm_continue_${suffix}`,
        time: { created: 4 },
      };
      const permission: Permission = {
        id: `perm_continue_${suffix}`,
        conversationId: conversation.id,
        runId: run.id,
        messageId: message.id,
        toolCallId: toolCall.id,
        status: "pending",
        toolId: "test.write",
        title: "Write test data",
        risk: {
          level: "high",
          reversible: false,
          sideEffects: ["business_write"],
        },
        confirmation: { level: "standard" },
        createdAt: 4,
      };
      store.commitToolPermissionRequest({
        toolCall,
        permission,
        requestedAt: 4,
        eventIds: {
          tool: `evt_continue_${suffix}_tool`,
          permission: `evt_continue_${suffix}_permission`,
          run: `evt_continue_${suffix}_run`,
          conversation: `evt_continue_${suffix}_conversation`,
        },
      });
      return { toolCall, permission };
    };
    const approved = createPending("approved");
    const denied = createPending("denied");

    for (const [index, item] of [approved, denied].entries()) {
      const bound = store.bindPermissionAiSdkApproval({
        permissionId: item.permission.id,
        toolCallId: item.toolCall.id,
        aiSdkApprovalId: `approval_${index}`,
        aiSdkToolCallId: `call_${index}`,
        boundAt: 5,
        eventId: `evt_continue_bound_${index}`,
      });
      expect(bound.adapter).toEqual({
        aiSdkApprovalId: `approval_${index}`,
        aiSdkToolCallId: `call_${index}`,
      });
      expect(store.getPermissionByToolCallId(item.toolCall.id)).toEqual(bound);
    }

    const committed = store.commitPermissionContinuation({
      runId: run.id,
      responses: [
        { permissionId: approved.permission.id, approved: true },
        {
          permissionId: denied.permission.id,
          approved: false,
          reason: "not this one",
        },
      ],
      continuedAt: 6,
      eventIds: {
        permissions: [
          "evt_continue_approved",
          "evt_continue_denied",
        ],
        tools: [
          "evt_continue_approved_resolved_tool",
          "evt_continue_denied_resolved_tool",
        ],
        run: "evt_continue_run_running",
        conversation: "evt_continue_conversation_busy",
      },
    });

    expect(committed.run.status).toBe("running");
    expect(committed.conversation.status).toEqual({
      type: "busy",
      runId: run.id,
    });
    expect(store.getPermission(approved.permission.id)?.status).toBe("approved");
    expect(store.getPermission(denied.permission.id)?.status).toBe("denied");
    expect(store.getToolCall(approved.toolCall.id)?.state).toBe(
      "waiting_for_permission",
    );
    expect(store.getToolCall(denied.toolCall.id)).toMatchObject({
      state: "error",
      error: { code: "TOOL_PERMISSION_DENIED", outcome: "not_started" },
    });
    expect(() =>
      store.commitPermissionContinuation({
        runId: run.id,
        responses: [
          { permissionId: approved.permission.id, approved: true },
          { permissionId: denied.permission.id, approved: false },
        ],
        continuedAt: 7,
        eventIds: {
          permissions: ["evt_duplicate_1", "evt_duplicate_2"],
          tools: ["evt_duplicate_tool_1", "evt_duplicate_tool_2"],
          run: "evt_duplicate_run",
          conversation: "evt_duplicate_conversation",
        },
      })
    ).toThrow("not waiting for permission");

    db.close();
  });

  test("lists conversations, conversation runs, and run events for recovery", () => {
    const { db, store } = createStore();

    const firstConversation: Conversation = {
      id: "conv_first",
      title: "First",
      version: "1",
      status: { type: "idle" },
      time: { created: 1, updated: 10 },
    };
    const secondConversation: Conversation = {
      id: "conv_second",
      title: "Second",
      version: "1",
      status: { type: "busy", runId: "run_second" },
      time: { created: 2, updated: 20 },
      metadata: { pinned: true },
    };

    const firstRun: Run = {
      id: "run_first",
      conversationId: firstConversation.id,
      agentMode: "ask",
      providerId: "openai",
      modelId: "gpt-4o",
      status: "completed",
      input: { messageIds: ["msg_first_user"] },
      output: { messageId: "msg_first_assistant", partIds: [] },
      limits: { maxSteps: 50, maxToolCalls: 300 },
      time: { created: 11, started: 12, completed: 13 },
    };
    const secondRun: Run = {
      id: "run_second",
      conversationId: secondConversation.id,
      agentMode: "agent",
      providerId: "openai",
      modelId: "gpt-4o",
      status: "running",
      input: { messageIds: ["msg_second_user"] },
      limits: { maxSteps: 50, maxToolCalls: 300 },
      time: { created: 21, started: 22 },
    };

    store.saveConversation(firstConversation);
    store.saveConversation(secondConversation);
    store.saveRun(firstRun);
    store.saveRun(secondRun);

    const event: Event = {
      id: "evt_second",
      type: "run.updated",
      properties: { info: secondRun },
      time: 23,
    };
    store.appendEvent(event);

    expect(store.listConversations()).toEqual([secondConversation, firstConversation]);
    expect(store.listConversations({ limit: 1 })).toEqual([secondConversation]);
    expect(store.listRunsByConversation(secondConversation.id)).toEqual([secondRun]);
    expect(store.listEventsByRun(secondRun.id)).toEqual([event]);

    db.close();
  });

  test("lists active runs and tool calls by run for interrupt recovery", () => {
    const { db, store } = createStore();

    const conversation: Conversation = {
      id: "conv_active",
      title: "Active",
      version: "1",
      status: { type: "busy", runId: "run_running" },
      time: { created: 1, updated: 2 },
    };
    store.saveConversation(conversation);

    const runningRun: Run = {
      id: "run_running",
      conversationId: conversation.id,
      agentMode: "ask",
      providerId: "openai",
      modelId: "gpt-4o",
      status: "running",
      input: { messageIds: ["msg_user"] },
      limits: { maxSteps: 4, maxToolCalls: 8 },
      time: { created: 2, started: 3 },
    };
    const waitingRun: Run = {
      ...runningRun,
      id: "run_waiting",
      status: "waiting_for_tool",
      time: { created: 4, started: 5 },
    };
    const completedRun: Run = {
      ...runningRun,
      id: "run_completed",
      status: "completed",
      finish: "stop",
      time: { created: 6, started: 7, completed: 8 },
    };
    store.saveRun(runningRun);
    store.saveRun(waitingRun);
    store.saveRun(completedRun);
    store.saveMessage({
      id: "msg_assistant",
      conversationId: conversation.id,
      role: "assistant",
      runId: runningRun.id,
      parentId: "msg_user",
      providerId: "openai",
      modelId: "gpt-4o",
      agentMode: "ask",
      status: { type: "running" },
      parts: [],
      time: { created: 3 },
    });

    const toolCall: ToolCall = {
      id: "tool_active",
      conversationId: conversation.id,
      runId: runningRun.id,
      messageId: "msg_assistant",
      toolName: "web_fetch",
      input: { url: "https://example.com" },
      state: "running",
      time: { created: 3, started: 3 },
    };
    store.saveToolCall(toolCall);

    expect(store.listActiveRuns().map((run) => run.id)).toEqual([
      "run_running",
      "run_waiting",
    ]);
    expect(store.listToolCallsByRun(runningRun.id)).toEqual([toolCall]);

    db.close();
  });

  test("publishes a live EventBus envelope after appending a runtime event", () => {
    const { db, store, eventBus } = createStoreWithEventBus();

    const event: Event = {
      id: "evt_live",
      type: "run.updated",
      properties: {
        info: {
          id: "run_live",
          conversationId: "conv_live",
          agentMode: "ask",
          providerId: "openai",
          modelId: "gpt-4o",
          status: "running",
          input: { messageIds: ["msg_user"] },
          limits: { maxSteps: 4, maxToolCalls: 8 },
          time: { created: 1, started: 2 },
        },
      },
      time: 2,
    };

    const received: RuntimeEventEnvelope[] = [];
    eventBus.subscribe({ kind: "global" }, (envelope) => {
      received.push(envelope);
    });

    store.appendEvent(event);

    expect(store.listEventsByRun("run_live")).toEqual([event]);
    expect(received).toEqual([
      expect.objectContaining({
        id: "evt_live",
        type: "run.updated",
        scope: {
          kind: "run",
          conversation_id: "conv_live",
          run_id: "run_live",
        },
      }),
    ]);

    db.close();
  });

  test("does not fail appendEvent when live EventBus publish fails", () => {
    const errors: unknown[] = [];
    const eventBus = new RuntimeEventBus({
      onSubscriberError: (error) => errors.push(error),
    });
    const { db, store } = createStore({ eventBus });

    eventBus.subscribe({ kind: "global" }, () => {
      throw new Error("subscriber failed");
    });

    const event: Event = {
      id: "evt_failure",
      type: "runtime.error",
      properties: {
        conversationId: "conv_live",
        runId: "run_live",
        error: { name: "UnknownError", data: { message: "boom" } },
      },
      time: 3,
    };

    expect(() => store.appendEvent(event)).not.toThrow();
    expect(store.listEventsByRun("run_live")).toEqual([event]);
    expect(errors).toHaveLength(1);

    db.close();
  });
});
