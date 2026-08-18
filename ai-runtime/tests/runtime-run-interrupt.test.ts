import { describe, expect, test } from "bun:test";
import {
  RuntimeRunner,
  RuntimeSqliteStore,
  interruptStoredRun,
  repairActiveStoredRuns,
  type Permission,
  type ToolCall,
} from "../src/runtime";
import { openRuntimeDatabase } from "../src/storage/runtime-database";

function createStoreAndRunner() {
  const db = openRuntimeDatabase(":memory:");
  const store = new RuntimeSqliteStore(db);
  let timeSequence = 0;
  let idSequence = 0;
  const runner = new RuntimeRunner({
    store,
    now: () => 1000 + timeSequence++,
    createId: (prefix) => `${prefix}_${++idSequence}` as never,
    appVersion: "test",
  });

  return { db, store, runner };
}

describe("runtime run interruption finalizer", () => {
  test("interrupts an active stored run and converges related records", () => {
    const { db, store, runner } = createStoreAndRunner();
    const started = runner.start({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Fetch docs",
      agentMode: "agent",
    });
    const toolCall: ToolCall = {
      id: "tool_running",
      conversationId: started.conversation.id,
      runId: started.run.id,
      messageId: started.assistantMessage.id,
      toolName: "web_fetch",
      input: { url: "https://example.com" },
      state: "waiting_for_permission",
      permissionId: "perm_interrupt",
      time: { created: 1002 },
    };
    const permission: Permission = {
      id: "perm_interrupt",
      conversationId: started.conversation.id,
      runId: started.run.id,
      messageId: started.assistantMessage.id,
      toolCallId: toolCall.id,
      status: "pending",
      toolId: "web.fetch",
      title: "Fetch docs",
      risk: {
        level: "medium",
        reversible: true,
        sideEffects: ["external_network"],
      },
      confirmation: { level: "standard" },
      createdAt: 1002,
    };
    store.commitToolPermissionRequest({
      toolCall,
      permission,
      requestedAt: 1002,
      eventIds: {
        tool: "evt_interrupt_tool",
        permission: "evt_interrupt_permission",
        run: "evt_interrupt_run_wait",
        conversation: "evt_interrupt_conversation",
      },
    });
    let interruptIdSequence = 0;

    const result = interruptStoredRun({
      store,
      runId: started.run.id,
      reason: "user_stop",
      message: "user requested stop",
      now: () => 2000,
      createId: (prefix) => `${prefix}_interrupt_${++interruptIdSequence}` as never,
    });

    expect(result?.interrupted).toBe(true);
    expect(result?.conversation?.status).toEqual({ type: "idle" });
    expect(result?.run.status).toBe("interrupted");
    expect(result?.run.finish).toBe("interrupted");
    expect(result?.run.metadata?.interrupt).toMatchObject({
      reason: "user_stop",
      message: "user requested stop",
    });
    expect(result?.assistantMessage?.status).toEqual({
      type: "incomplete",
      reason: "interrupted",
    });
    expect(store.getToolCall(toolCall.id)?.state).toBe("interrupted");
    expect(store.getPermission(permission.id)?.status).toBe("cancelled");
    expect(store.getPermission(permission.id)?.decision).toMatchObject({
      source: "system",
      reason: "user requested stop",
      decidedAt: 2000,
    });
    expect(store.listEventsByRun(started.run.id).map((event) => event.type)).toContain(
      "run.updated",
    );

    db.close();
  });

  test("repairs stale active runs after startup", () => {
    const { db, store, runner } = createStoreAndRunner();
    const started = runner.start({
      providerId: "openai",
      modelId: "gpt-4o",
      text: "Will be stale",
    });
    const staleToolCall: ToolCall = {
      id: "tool_stale_permission",
      conversationId: started.conversation.id,
      runId: started.run.id,
      messageId: started.assistantMessage.id,
      toolName: "test.write",
      input: {},
      state: "waiting_for_permission",
      permissionId: "perm_stale_permission",
      time: { created: 2000 },
    };
    const stalePermission: Permission = {
      id: "perm_stale_permission",
      conversationId: started.conversation.id,
      runId: started.run.id,
      messageId: started.assistantMessage.id,
      toolCallId: staleToolCall.id,
      status: "pending",
      toolId: "test.write",
      title: "Stale write",
      risk: {
        level: "high",
        reversible: false,
        sideEffects: ["business_write"],
      },
      confirmation: { level: "standard" },
      createdAt: 2000,
    };
    store.commitToolPermissionRequest({
      toolCall: staleToolCall,
      permission: stalePermission,
      requestedAt: 2000,
      eventIds: {
        tool: "evt_stale_tool",
        permission: "evt_stale_permission",
        run: "evt_stale_run",
        conversation: "evt_stale_conversation",
      },
    });
    let repairIdSequence = 0;

    const repaired = repairActiveStoredRuns({
      store,
      now: () => 3000,
      createId: (prefix) => `${prefix}_repair_${++repairIdSequence}` as never,
    });

    expect(repaired.map((item) => item.run.id)).toEqual([started.run.id]);
    expect(store.getRun(started.run.id)?.status).toBe("interrupted");
    expect(store.getRun(started.run.id)?.metadata?.interrupt).toMatchObject({
      reason: "runtime_recovered_stale_run",
    });
    expect(store.getPermission(stalePermission.id)?.status).toBe("cancelled");

    db.close();
  });
});
