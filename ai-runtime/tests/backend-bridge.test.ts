import { afterEach, describe, expect, test } from "bun:test";
import {
  BackendBridgeManager,
  BackendBridgeRequestError,
  type BackendBridgeSocket,
} from "../src/backend-bridge";
import { createRuntimeLogger } from "../src/core/logger";

class FakeSocket implements BackendBridgeSocket {
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  frame(index = this.sent.length - 1): Record<string, unknown> {
    return JSON.parse(this.sent[index]) as Record<string, unknown>;
  }
}

const managers: BackendBridgeManager[] = [];

function createManager(options: { interval?: number; timeout?: number } = {}) {
  const manager = new BackendBridgeManager({
    logger: createRuntimeLogger({ level: "silent" }),
    heartbeatIntervalMs: options.interval ?? 10_000,
    heartbeatTimeoutMs: options.timeout ?? 30_000,
    startedAt: 123,
  });
  managers.push(manager);
  return manager;
}

function ready(manager: BackendBridgeManager, socket: FakeSocket): void {
  manager.open(socket);
  manager.message(socket, JSON.stringify({ type: "backend.ready" }));
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
});

describe("BackendBridgeManager", () => {
  test("sends runtime.ready and transitions from waiting to ready", () => {
    const manager = createManager();
    const socket = new FakeSocket();

    manager.open(socket);
    expect(socket.frame()).toEqual({
      type: "runtime.ready",
      runtimeState: "ready",
      startedAt: 123,
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
    });
    expect(manager.snapshot()).toEqual({ state: "waiting" });

    manager.message(socket, JSON.stringify({ type: "backend.ready" }));
    expect(manager.snapshot().state).toBe("ready");
  });

  test("rejects business frames before backend.ready", () => {
    const manager = createManager();
    const socket = new FakeSocket();
    manager.open(socket);

    manager.message(socket, JSON.stringify({ type: "pong", id: 1 }));
    expect(socket.closes.at(-1)).toEqual({ code: 1008, reason: "protocol_error" });
  });

  test("multiplexes out-of-order success and error responses", async () => {
    const manager = createManager();
    const socket = new FakeSocket();
    ready(manager, socket);

    const first = manager.request("connection.list", { page: 1 });
    const firstRequest = socket.frame();
    const second = manager.request("metadata.list_children", { id: "root" });
    const secondRequest = socket.frame();

    manager.message(socket, JSON.stringify({
      type: "response",
      requestId: secondRequest.requestId,
      ok: true,
      data: { children: [] },
    }));
    manager.message(socket, JSON.stringify({
      type: "response",
      requestId: firstRequest.requestId,
      ok: false,
      error: {
        code: "GATEWAY_UNAVAILABLE",
        message: "Gateway unavailable.",
        retryable: false,
        outcome: "not_started",
      },
    }));

    expect(await second).toEqual({ children: [] });
    await expect(first).rejects.toMatchObject({
      code: "GATEWAY_UNAVAILABLE",
      outcome: "not_started",
    });
  });

  test("fails sent pending requests immediately on disconnect", async () => {
    const manager = createManager();
    const socket = new FakeSocket();
    ready(manager, socket);
    const request = manager.request("connection.list", {});

    manager.close(socket);

    await expect(request).rejects.toEqual(expect.objectContaining({
      code: "BACKEND_BRIDGE_DISCONNECTED",
      outcome: "unknown",
    }));
    expect(manager.snapshot().state).toBe("disconnected");
  });

  test("rejects requests before ready without sending", async () => {
    const manager = createManager();
    await expect(manager.request("connection.list", {})).rejects.toBeInstanceOf(
      BackendBridgeRequestError,
    );
    await expect(manager.request("connection.list", {})).rejects.toMatchObject({
      code: "BACKEND_BRIDGE_UNAVAILABLE",
      outcome: "not_started",
    });
  });

  test("replaces the active connection only after the new connection is ready", () => {
    const manager = createManager();
    const first = new FakeSocket();
    const second = new FakeSocket();
    ready(manager, first);

    manager.open(second);
    expect(first.closes).toHaveLength(0);
    manager.message(second, JSON.stringify({ type: "backend.ready" }));

    expect(first.closes.at(-1)).toEqual({ code: 1000, reason: "replaced" });
    expect(manager.snapshot().state).toBe("ready");
  });

  test("sends application ping while the connection is healthy", async () => {
    const manager = createManager({ interval: 10, timeout: 100 });
    const socket = new FakeSocket();
    ready(manager, socket);

    await Bun.sleep(25);

    expect(socket.sent.some((value) => JSON.parse(value).type === "ping")).toBe(true);
  });

  test("records the last heartbeat only after a matching pong", async () => {
    const manager = createManager({ interval: 10, timeout: 100 });
    const socket = new FakeSocket();
    ready(manager, socket);
    expect(manager.snapshot().lastHeartbeatAt).toBeUndefined();

    await Bun.sleep(15);
    const ping = socket.sent.map((value) => JSON.parse(value)).find((frame) => frame.type === "ping");
    if (!ping) throw new Error("expected a heartbeat ping");
    manager.message(socket, JSON.stringify({ type: "pong", id: ping.id }));

    expect(manager.snapshot().lastHeartbeatAt).toBeNumber();
  });

  test("logs only redacted frame metadata at debug level", async () => {
    const lines: string[] = [];
    const manager = new BackendBridgeManager({
      logger: createRuntimeLogger({
        color: false,
        level: "debug",
        write: (line) => lines.push(line),
      }),
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
    });
    managers.push(manager);
    const socket = new FakeSocket();
    ready(manager, socket);
    const result = manager.request("connection.list", { password: "must-not-be-logged" });
    const request = socket.frame();
    manager.message(socket, JSON.stringify({
      type: "response",
      requestId: request.requestId,
      ok: false,
      error: {
        code: "GATEWAY_UNAVAILABLE",
        message: "secret remote detail",
        retryable: false,
        outcome: "not_started",
      },
    }));
    await expect(result).rejects.toMatchObject({ code: "GATEWAY_UNAVAILABLE" });

    const output = lines.join("");
    expect(output).toContain("Backend Bridge frame");
    expect(output).toContain("direction=send");
    expect(output).toContain("direction=receive");
    expect(output).toContain("operation=connection.list");
    expect(output).toContain("errorCode=GATEWAY_UNAVAILABLE");
    expect(output).not.toContain("must-not-be-logged");
    expect(output).not.toContain("secret remote detail");
  });

  test("rejects pong ids that were not issued by the active connection", () => {
    const manager = createManager();
    const socket = new FakeSocket();
    ready(manager, socket);

    manager.message(socket, JSON.stringify({ type: "pong", id: 999 }));

    expect(socket.closes.at(-1)).toEqual({ code: 1008, reason: "protocol_error" });
  });

  test("disconnects after heartbeat timeout", async () => {
    const manager = createManager({ interval: 10, timeout: 20 });
    const socket = new FakeSocket();
    ready(manager, socket);

    await Bun.sleep(45);

    expect(socket.closes.at(-1)).toEqual({ code: 1008, reason: "heartbeat_timeout" });
    expect(manager.snapshot().state).toBe("disconnected");
  });
});
