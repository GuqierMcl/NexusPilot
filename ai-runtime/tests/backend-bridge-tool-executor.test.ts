import { afterEach, describe, expect, test } from "bun:test";
import {
  BackendBridgeManager,
  BackendBridgeRequestError,
  type BackendBridgeSocket,
} from "../src/backend-bridge";
import { createRuntimeLogger } from "../src/core/logger";
import {
  BackendBridgeToolExecutor,
  RuntimeToolExecutionError,
  type BackendToolExecutionIdentity,
} from "../src/runtime/tools";
import type {
  ConversationId,
  MessageId,
  RunId,
  ToolCallId,
} from "../src/runtime";

class FakeSocket implements BackendBridgeSocket {
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}

  lastFrame(): Record<string, unknown> {
    const data = this.sent.at(-1);
    if (!data) throw new Error("expected a sent frame");
    return JSON.parse(data) as Record<string, unknown>;
  }
}

const managers: BackendBridgeManager[] = [];

function createReadyExecutor(): {
  manager: BackendBridgeManager;
  socket: FakeSocket;
  executor: BackendBridgeToolExecutor;
} {
  const manager = new BackendBridgeManager({
    logger: createRuntimeLogger({ level: "silent" }),
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 120_000,
  });
  managers.push(manager);
  const socket = new FakeSocket();
  manager.open(socket);
  manager.message(socket, JSON.stringify({ type: "backend.ready" }));
  return {
    manager,
    socket,
    executor: new BackendBridgeToolExecutor(manager),
  };
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
});

describe("BackendBridgeToolExecutor", () => {
  test("sends trusted execution context for prepare without exposing it in input", async () => {
    const { manager, socket, executor } = createReadyExecutor();
    const identity: BackendToolExecutionIdentity = {
      conversationId: "conv_bridge" as ConversationId,
      runId: "run_bridge" as RunId,
      messageId: "msg_bridge" as MessageId,
      toolCallId: "tool_bridge" as ToolCallId,
      toolId: "sql.execute",
    };
    const pending = executor.prepare(
      "sql.analyze",
      { profileId: "profile_1", sql: "DELETE FROM users" },
      identity,
      new AbortController().signal,
    );
    const request = socket.lastFrame();

    expect(request).toMatchObject({
      operation: "sql.analyze",
      input: { profileId: "profile_1", sql: "DELETE FROM users" },
      context: identity,
    });
    expect(request.input).not.toHaveProperty("planId");
    manager.message(socket, JSON.stringify({
      type: "response",
      requestId: request.requestId,
      ok: true,
      data: {
        planId: "plan_internal",
        expiresAt: 1_000,
        risk: {
          level: "critical",
          reversible: false,
          sideEffects: ["destructive"],
        },
        permission: {
          inputSummary: "在连接“SQLite”执行一条 SQL",
          confirmationPrompt: "确认在 development sqlite 执行",
          presentation: {
            target: {
              profileId: "profile_1",
              connectionName: "SQLite",
              driver: "sqlite",
              environment: "development",
            },
            riskReasons: ["将修改业务数据。"],
            sql: {
              text: "DELETE FROM users",
              analysisStatus: "analyzed",
              statementClass: "delete",
            },
            timeoutMs: 30_000,
            maxResultBytes: 1024 * 1024,
            outcomeWarnings: ["系统不会自动重试。"],
          },
        },
      },
    }));

    expect(await pending).toMatchObject({
      planId: "plan_internal",
      risk: { level: "critical" },
      permission: {
        presentation: {
          target: {
            profileId: "profile_1",
          },
        },
      },
    });
  });

  test("forwards the canonical operation, input, and abort signal", async () => {
    const { manager, socket, executor } = createReadyExecutor();
    const controller = new AbortController();
    const pending = executor.execute(
      "connection.list",
      { includeArchived: false },
      controller.signal,
    );
    const request = socket.lastFrame();

    expect(request).toMatchObject({
      type: "request",
      operation: "connection.list",
      input: { includeArchived: false },
    });

    manager.message(socket, JSON.stringify({
      type: "response",
      requestId: request.requestId,
      ok: true,
      data: { connections: [] },
    }));

    expect(await pending).toEqual({
      summary: "Backend operation completed.",
      data: { connections: [] },
    });
  });

  test("preserves Gateway error facts as Runtime Tool errors", async () => {
    const { manager, socket, executor } = createReadyExecutor();
    const pending = executor.execute(
      "metadata.describe_object",
      { objectId: "missing" },
      new AbortController().signal,
    );
    const request = socket.lastFrame();

    manager.message(socket, JSON.stringify({
      type: "response",
      requestId: request.requestId,
      ok: false,
      error: {
        code: "RESOURCE_NOT_FOUND",
        message: "The requested object no longer exists.",
        retryable: true,
        outcome: "no_effect",
      },
    }));

    await expect(pending).rejects.toEqual(expect.objectContaining({
      name: "RuntimeToolExecutionError",
      code: "RESOURCE_NOT_FOUND",
      message: "The requested object no longer exists.",
      retryable: true,
      outcome: "no_effect",
    }));
  });

  test("preserves unavailable and aborted Bridge outcomes", async () => {
    const manager = new BackendBridgeManager({
      logger: createRuntimeLogger({ level: "silent" }),
    });
    managers.push(manager);
    const executor = new BackendBridgeToolExecutor(manager);

    await expect(executor.execute(
      "connection.list",
      {},
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: "BACKEND_BRIDGE_UNAVAILABLE",
      retryable: true,
      outcome: "not_started",
    });

    const ready = createReadyExecutor();
    const controller = new AbortController();
    const pending = ready.executor.execute("connection.list", {}, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: "BACKEND_BRIDGE_REQUEST_ABORTED",
      retryable: false,
      outcome: "unknown",
    });
  });

  test("redacts unknown adapter failures behind a stable Runtime error", async () => {
    const executor = new BackendBridgeToolExecutor({
      request: async () => {
        throw new Error("password=do-not-leak");
      },
    });

    await expect(executor.execute(
      "connection.list",
      {},
      new AbortController().signal,
    )).rejects.toEqual(new RuntimeToolExecutionError(
      "BACKEND_EXECUTION_FAILED",
      "Backend operation failed.",
      false,
      "unknown",
    ));
  });

  test("does not reinterpret structurally similar foreign errors", async () => {
    const executor = new BackendBridgeToolExecutor({
      request: async () => {
        throw new BackendBridgeRequestError(
          "GATEWAY_OPERATION_NOT_FOUND",
          "Unknown operation.",
          false,
          "not_started",
        );
      },
    });

    await expect(executor.execute(
      "connection.list",
      {},
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: "GATEWAY_OPERATION_NOT_FOUND",
      outcome: "not_started",
    });
  });
});
