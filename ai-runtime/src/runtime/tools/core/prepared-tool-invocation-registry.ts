import type { RunId, ToolCallId } from "../../core/types";
import type {
  BackendToolExecutionIdentity,
  PreparedPlanLinkMetadata,
  PreparedToolInvocation,
} from "../contracts";

export class PreparedToolInvocationRegistryError extends Error {
  constructor(
    readonly code:
      | "PLAN_NOT_FOUND"
      | "PLAN_EXPIRED"
      | "PLAN_ALREADY_CONSUMED"
      | "PLAN_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "PreparedToolInvocationRegistryError";
  }
}

interface PreparedInvocationRecord {
  identity: BackendToolExecutionIdentity;
  input: Record<string, unknown>;
  invocation: Readonly<PreparedToolInvocation>;
  consumed: boolean;
}

export class PreparedToolInvocationRegistry {
  readonly #byToolCall = new Map<ToolCallId, PreparedInvocationRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  remember(
    identity: BackendToolExecutionIdentity,
    input: Record<string, unknown>,
    invocation: PreparedToolInvocation,
  ): Readonly<PreparedToolInvocation> {
    if (this.#byToolCall.has(identity.toolCallId)) {
      throw planError("PLAN_MISMATCH", "ToolCall already owns a prepared plan.");
    }
    const frozen = deepFreeze(structuredClone(invocation));
    this.#byToolCall.set(identity.toolCallId, {
      identity: structuredClone(identity),
      input: structuredClone(input),
      invocation: frozen,
      consumed: false,
    });
    return frozen;
  }

  require(
    identity: BackendToolExecutionIdentity,
    input: Record<string, unknown>,
  ): Readonly<PreparedToolInvocation> {
    const record = this.#byToolCall.get(identity.toolCallId);
    if (!record) {
      throw planError("PLAN_NOT_FOUND", "Prepared plan was not found.");
    }
    if (record.consumed) {
      throw planError(
        "PLAN_ALREADY_CONSUMED",
        "Prepared plan was already consumed.",
      );
    }
    if (record.invocation.expiresAt <= this.now()) {
      this.#byToolCall.delete(identity.toolCallId);
      throw planError("PLAN_EXPIRED", "Prepared plan has expired.");
    }
    if (
      !sameIdentity(record.identity, identity) ||
      !sameJson(record.input, input)
    ) {
      throw planError(
        "PLAN_MISMATCH",
        "Prepared plan does not match this ToolCall or input.",
      );
    }
    return record.invocation;
  }

  markConsumed(toolCallId: ToolCallId): void {
    const record = this.#byToolCall.get(toolCallId);
    if (record) {
      record.consumed = true;
    }
  }

  forget(toolCallId: ToolCallId): void {
    this.#byToolCall.delete(toolCallId);
  }

  metadata(toolCallId: ToolCallId): Pick<PreparedPlanLinkMetadata, "expiresAt"> | null {
    const record = this.#byToolCall.get(toolCallId);
    return record ? { expiresAt: record.invocation.expiresAt } : null;
  }

  clearRun(runId: RunId): void {
    for (const [toolCallId, record] of this.#byToolCall) {
      if (record.identity.runId === runId) {
        this.#byToolCall.delete(toolCallId);
      }
    }
  }

  clearAll(): void {
    this.#byToolCall.clear();
  }
}

function sameIdentity(
  left: BackendToolExecutionIdentity,
  right: BackendToolExecutionIdentity,
): boolean {
  return (
    left.conversationId === right.conversationId &&
    left.runId === right.runId &&
    left.messageId === right.messageId &&
    left.toolCallId === right.toolCallId &&
    left.toolId === right.toolId
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function planError(
  code: PreparedToolInvocationRegistryError["code"],
  message: string,
): PreparedToolInvocationRegistryError {
  return new PreparedToolInvocationRegistryError(code, message);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}
