import type { ConversationId, Event, RunId } from "../core/types";

export type RuntimeEventScope =
  | { kind: "global" }
  | { kind: "conversation"; conversation_id: ConversationId }
  | { kind: "run"; conversation_id?: ConversationId; run_id: RunId };

export type RuntimeEventScopeFilter =
  | { kind: "global" }
  | { kind: "conversation"; conversation_id: ConversationId }
  | { kind: "run"; run_id: RunId };

export interface RuntimeEventEnvelope {
  id: string;
  type: string;
  scope: RuntimeEventScope;
  occurred_at: number;
  version: 1;
  payload: Record<string, unknown>;
}

export function runtimeEventToEnvelope(event: Event): RuntimeEventEnvelope {
  return {
    id: event.id,
    type: event.type,
    scope: inferRuntimeEventScope(event),
    occurred_at: event.time,
    version: 1,
    payload: { event },
  };
}

export function runtimeEventScopeMatches(
  filter: RuntimeEventScopeFilter,
  scope: RuntimeEventScope,
): boolean {
  if (filter.kind === "global") {
    return true;
  }

  if (filter.kind === "conversation") {
    if (scope.kind === "conversation") {
      return scope.conversation_id === filter.conversation_id;
    }

    if (scope.kind === "run") {
      return scope.conversation_id === filter.conversation_id;
    }

    return false;
  }

  return scope.kind === "run" && scope.run_id === filter.run_id;
}

function inferRuntimeEventScope(event: Event): RuntimeEventScope {
  const properties = event.properties as Record<string, unknown>;
  const info = readRecord(properties.info);
  const part = readRecord(properties.part);

  const runId =
    readRuntimeId(info?.runId, "run") ??
    readRuntimeId(info?.id, "run") ??
    readRuntimeId(properties.runId, "run");
  const conversationId =
    readRuntimeId(info?.conversationId, "conv") ??
    readRuntimeId(info?.id, "conv") ??
    readRuntimeId(part?.conversationId, "conv") ??
    readRuntimeId(properties.conversationId, "conv");

  if (runId) {
    return {
      kind: "run",
      ...(conversationId ? { conversation_id: conversationId } : {}),
      run_id: runId,
    };
  }

  if (conversationId) {
    return {
      kind: "conversation",
      conversation_id: conversationId,
    };
  }

  return { kind: "global" };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readRuntimeId<TPrefix extends "conv" | "run">(
  value: unknown,
  prefix: TPrefix,
): `${TPrefix}_${string}` | null {
  if (typeof value !== "string") {
    return null;
  }

  if (!value.startsWith(`${prefix}_`) || value.length <= prefix.length + 1) {
    return null;
  }

  return value as `${TPrefix}_${string}`;
}
