import type { RuntimeLogger } from "../core/logger";
import type { BackendToolExecutionIdentity } from "../runtime/tools/contracts";
import { parseBackendInboundFrame, type BackendInboundFrame, type GatewayErrorFrame } from "./frames";

export const BACKEND_BRIDGE_PATH = "/v1/internal/backend-bridge";
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;

export type BackendBridgeState = "waiting" | "ready" | "disconnected";

export interface BackendBridgeSnapshot {
  state: BackendBridgeState;
  lastHeartbeatAt?: number;
}

export interface BackendBridgeSocket {
  send(data: string): void | number;
  close(code?: number, reason?: string): void;
}

export interface BackendBridgeOptions {
  logger: RuntimeLogger;
  startedAt?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}

interface ConnectionRecord {
  id: number;
  socket: BackendBridgeSocket;
  ready: boolean;
  lastPongAt: number;
  pendingPingIds: Set<number>;
}

interface PendingRequest {
  connectionId: number;
  sent: boolean;
  resolve(value: unknown): void;
  reject(error: BackendBridgeRequestError): void;
  abortCleanup?: () => void;
}

export class BackendBridgeRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly outcome: GatewayErrorFrame["outcome"],
  ) {
    super(message);
    this.name = "BackendBridgeRequestError";
  }
}

export class BackendBridgeManager {
  private readonly logger: RuntimeLogger;
  private readonly startedAt: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly connections = new Map<BackendBridgeSocket, ConnectionRecord>();
  private readonly pending = new Map<string, PendingRequest>();
  private active: ConnectionRecord | null = null;
  private everReady = false;
  private lastHeartbeatAt: number | undefined;
  private nextConnectionId = 1;
  private nextPingId = 1;
  private nextRequestId = 1;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: BackendBridgeOptions) {
    this.logger = options.logger;
    this.startedAt = options.startedAt ?? Date.now();
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  }

  open(socket: BackendBridgeSocket): void {
    const connection: ConnectionRecord = {
      id: this.nextConnectionId++,
      socket,
      ready: false,
      lastPongAt: Date.now(),
      pendingPingIds: new Set(),
    };
    this.connections.set(socket, connection);
    const sent = this.send(socket, JSON.stringify({
      type: "runtime.ready",
      runtimeState: "ready",
      startedAt: this.startedAt,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      heartbeatTimeoutMs: this.heartbeatTimeoutMs,
    }));
    if (!sent) {
      socket.close(1011, "ready_send_failed");
      this.connections.delete(socket);
    }
  }

  message(socket: BackendBridgeSocket, raw: unknown): void {
    const connection = this.connections.get(socket);
    if (!connection) {
      this.protocolError(socket, "invalid_frame");
      return;
    }

    let parsed: unknown;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        this.logFrame("receive", null, Buffer.byteLength(raw));
        this.protocolError(socket, "invalid_json");
        return;
      }
    } else {
      parsed = raw;
    }
    const frame = parseBackendInboundFrame(parsed);
    this.logFrame("receive", parsed, typeof raw === "string" ? Buffer.byteLength(raw) : undefined);
    if (!frame) {
      this.protocolError(socket, "invalid_frame");
      return;
    }
    this.handleFrame(connection, frame);
  }

  close(socket: BackendBridgeSocket): void {
    const connection = this.connections.get(socket);
    if (!connection) return;
    this.connections.delete(socket);
    if (this.active?.id === connection.id) {
      this.active = null;
      this.stopHeartbeat();
      this.failConnectionRequests(connection.id, "BACKEND_BRIDGE_DISCONNECTED");
    }
  }

  snapshot(): BackendBridgeSnapshot {
    const state: BackendBridgeState = this.active
      ? "ready"
      : this.everReady
        ? "disconnected"
        : "waiting";
    return this.lastHeartbeatAt === undefined
      ? { state }
      : { state, lastHeartbeatAt: this.lastHeartbeatAt };
  }

  request(
    operation: string,
    input: unknown,
    signal?: AbortSignal,
    identity?: BackendToolExecutionIdentity,
  ): Promise<unknown> {
    if (!operation.trim()) {
      return Promise.reject(new BackendBridgeRequestError(
        "BACKEND_BRIDGE_INVALID_REQUEST",
        "Backend Bridge operation must not be empty.",
        false,
        "not_started",
      ));
    }
    if (signal?.aborted) {
      return Promise.reject(new BackendBridgeRequestError(
        "BACKEND_BRIDGE_REQUEST_ABORTED",
        "Backend Bridge request was aborted.",
        false,
        "not_started",
      ));
    }
    const connection = this.active;
    if (!connection) {
      return Promise.reject(new BackendBridgeRequestError(
        "BACKEND_BRIDGE_UNAVAILABLE",
        "Backend Bridge is not ready.",
        true,
        "not_started",
      ));
    }

    const requestId = `bridge_${connection.id}_${this.nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        connectionId: connection.id,
        sent: false,
        resolve,
        reject,
      };
      if (signal) {
        const onAbort = () => {
          if (!this.pending.delete(requestId)) return;
          reject(new BackendBridgeRequestError(
            "BACKEND_BRIDGE_REQUEST_ABORTED",
            "Backend Bridge request was aborted.",
            false,
            pending.sent ? "unknown" : "not_started",
          ));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.abortCleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.pending.set(requestId, pending);
      try {
        if (!this.send(
          connection.socket,
          JSON.stringify({
            type: "request",
            requestId,
            operation,
            input,
            ...(identity ? { context: identity } : {}),
          }),
        )) {
          throw new Error("send_failed");
        }
        pending.sent = true;
      } catch {
        this.pending.delete(requestId);
        pending.abortCleanup?.();
        reject(new BackendBridgeRequestError(
          "BACKEND_BRIDGE_DISCONNECTED",
          "Backend Bridge disconnected before the request was sent.",
          true,
          "not_started",
        ));
      }
    });
  }

  shutdown(): void {
    this.stopHeartbeat();
    for (const connection of this.connections.values()) {
      connection.socket.close(1001, "runtime_shutdown");
    }
    this.connections.clear();
    this.active = null;
    this.failAllRequests("BACKEND_BRIDGE_DISCONNECTED");
  }

  private handleFrame(connection: ConnectionRecord, frame: BackendInboundFrame): void {
    if (!connection.ready) {
      if (frame.type !== "backend.ready") {
        this.protocolError(connection.socket, "ready_required");
        return;
      }
      this.activate(connection);
      return;
    }
    if (frame.type === "backend.ready") {
      this.protocolError(connection.socket, "duplicate_ready");
      return;
    }
    if (this.active?.id !== connection.id) {
      this.protocolError(connection.socket, "inactive_connection");
      return;
    }
    if (frame.type === "pong") {
      if (!connection.pendingPingIds.delete(frame.id)) {
        this.protocolError(connection.socket, "unknown_pong");
        return;
      }
      connection.lastPongAt = Date.now();
      this.lastHeartbeatAt = connection.lastPongAt;
      return;
    }
    this.resolveResponse(frame);
  }

  private activate(connection: ConnectionRecord): void {
    const previous = this.active;
    connection.ready = true;
    connection.lastPongAt = Date.now();
    this.active = connection;
    this.everReady = true;
    if (previous && previous.id !== connection.id) {
      this.failConnectionRequests(previous.id, "BACKEND_BRIDGE_DISCONNECTED");
      previous.socket.close(1000, "replaced");
      this.connections.delete(previous.socket);
    }
    this.startHeartbeat();
  }

  private resolveResponse(frame: Extract<BackendInboundFrame, { type: "response" }>): void {
    const pending = this.pending.get(frame.requestId);
    if (!pending || pending.connectionId !== this.active?.id) {
      this.logger.warn({ requestId: frame.requestId }, "ignored unknown Backend Bridge response");
      return;
    }
    this.pending.delete(frame.requestId);
    pending.abortCleanup?.();
    if (frame.ok) {
      pending.resolve(frame.data);
    } else {
      pending.reject(new BackendBridgeRequestError(
        frame.error.code,
        frame.error.message,
        frame.error.retryable,
        frame.error.outcome,
      ));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const connection = this.active;
      if (!connection) return;
      const now = Date.now();
      if (now - connection.lastPongAt >= this.heartbeatTimeoutMs) {
        connection.socket.close(1008, "heartbeat_timeout");
        this.close(connection.socket);
        return;
      }
      const pingId = this.nextPingId++;
      connection.pendingPingIds.add(pingId);
      if (!this.send(connection.socket, JSON.stringify({ type: "ping", id: pingId }))) {
        connection.socket.close(1011, "heartbeat_send_failed");
        this.close(connection.socket);
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private protocolError(socket: BackendBridgeSocket, reason: string): void {
    this.logger.warn({ reason }, "Backend Bridge protocol error");
    socket.close(1008, "protocol_error");
    this.close(socket);
  }

  private send(socket: BackendBridgeSocket, data: string): boolean {
    try {
      const result = socket.send(data);
      const sent = typeof result !== "number" || result > 0;
      if (sent) this.logFrame("send", JSON.parse(data) as unknown, Buffer.byteLength(data));
      return sent;
    } catch {
      return false;
    }
  }

  private logFrame(
    direction: "send" | "receive",
    frame: unknown,
    byteLength?: number,
  ): void {
    if (!this.logger.isLevelEnabled("debug")) return;
    const record = isRecord(frame) ? frame : {};
    const error = isRecord(record.error) ? record.error : {};
    this.logger.debug({
      direction,
      frameType: typeof record.type === "string" ? record.type : "invalid",
      ...(typeof record.requestId === "string" ? { requestId: boundedLogValue(record.requestId) } : {}),
      ...(typeof record.operation === "string" ? { operation: boundedLogValue(record.operation) } : {}),
      ...(typeof record.id === "number" ? { frameId: record.id } : {}),
      ...(typeof record.ok === "boolean" ? { ok: record.ok } : {}),
      ...(typeof error.code === "string" ? { errorCode: boundedLogValue(error.code) } : {}),
      ...(byteLength === undefined ? {} : { byteLength }),
    }, "Backend Bridge frame");
  }

  private failConnectionRequests(connectionId: number, code: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.connectionId !== connectionId) continue;
      this.pending.delete(requestId);
      pending.abortCleanup?.();
      pending.reject(new BackendBridgeRequestError(
        code,
        "Backend Bridge disconnected before the request completed.",
        true,
        pending.sent ? "unknown" : "not_started",
      ));
    }
  }

  private failAllRequests(code: string): void {
    for (const pending of this.pending.values()) {
      pending.abortCleanup?.();
      pending.reject(new BackendBridgeRequestError(
        code,
        "Backend Bridge is shutting down.",
        false,
        pending.sent ? "unknown" : "not_started",
      ));
    }
    this.pending.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedLogValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 128);
}
