export interface GatewayErrorFrame {
  code: string;
  message: string;
  retryable: boolean;
  outcome: "not_started" | "no_effect" | "unknown";
}

export type BackendBridgeFrame =
  | {
      type: "runtime.ready";
      runtimeState: "ready";
      startedAt: number;
      heartbeatIntervalMs: number;
      heartbeatTimeoutMs: number;
    }
  | { type: "backend.ready" }
  | { type: "ping"; id: number }
  | { type: "pong"; id: number }
  | { type: "request"; requestId: string; operation: string; input: unknown }
  | { type: "response"; requestId: string; ok: true; data: unknown }
  | { type: "response"; requestId: string; ok: false; error: GatewayErrorFrame };

export type BackendInboundFrame =
  | Extract<BackendBridgeFrame, { type: "backend.ready" }>
  | Extract<BackendBridgeFrame, { type: "pong" }>
  | Extract<BackendBridgeFrame, { type: "response" }>;

export function parseBackendInboundFrame(value: unknown): BackendInboundFrame | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }

  if (value.type === "backend.ready") {
    return Object.keys(value).length === 1 ? { type: "backend.ready" } : null;
  }
  if (value.type === "pong") {
    return hasOnlyKeys(value, ["type", "id"]) && isSafeNonNegativeInteger(value.id)
      ? { type: "pong", id: value.id }
      : null;
  }
  if (value.type !== "response" || typeof value.requestId !== "string" || !value.requestId) {
    return null;
  }
  if (value.ok === true) {
    if (!hasOnlyKeys(value, ["type", "requestId", "ok", "data"])) return null;
    return { type: "response", requestId: value.requestId, ok: true, data: value.data };
  }
  if (value.ok === false && isGatewayError(value.error)) {
    if (!hasOnlyKeys(value, ["type", "requestId", "ok", "error"])) return null;
    return {
      type: "response",
      requestId: value.requestId,
      ok: false,
      error: value.error,
    };
  }
  return null;
}

function isGatewayError(value: unknown): value is GatewayErrorFrame {
  return isRecord(value) &&
    hasOnlyKeys(value, ["code", "message", "retryable", "outcome"]) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    typeof value.retryable === "boolean" &&
    (value.outcome === "not_started" || value.outcome === "no_effect" || value.outcome === "unknown");
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key)) && Object.keys(value).length === keys.length;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
