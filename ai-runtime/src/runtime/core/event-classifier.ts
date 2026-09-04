export type RuntimeEventPersistence =
  | "live-only"
  | "durable-event"
  | "projection-update"
  | "ui-transient";

export interface RuntimeEventClassification {
  persistence: RuntimeEventPersistence;
  reason: string;
}

const LIVE_ONLY_EVENTS = new Set([
  "text.delta",
  "reasoning.delta",
  "tool.input.delta",
  "tool.stdout.delta",
  "tool.stderr.delta",
  "status.pulse",
  "typing.indicator",
]);

const DURABLE_EVENTS = new Set([
  "run.created",
  "run.completed",
  "run.failed",
  "run.interrupted",
  "message.created",
  "message.completed",
  "part.completed",
  "tool.called",
  "tool.completed",
  "tool.failed",
  "permission.requested",
  "permission.resolved",
  "diff.proposed",
  "diff.applied",
  "artifact.created",
  "runtime.error",
]);

const PROJECTION_EVENTS = new Set([
  "conversation.snapshot",
  "run.snapshot",
  "message.snapshot",
  "tool.snapshot",
  "permission.snapshot",
]);

const UI_TRANSIENT_EVENTS = new Set([
  "toast.requested",
  "assistant.input.focusRequested",
  "panel.scrollToBottomRequested",
  "statusBar.flashRequested",
  "threadList.renameMode.entered",
]);

export function classifyRuntimeEvent(type: string): RuntimeEventClassification {
  if (LIVE_ONLY_EVENTS.has(type)) {
    return {
      persistence: "live-only",
      reason: "high-frequency stream delta",
    };
  }

  if (DURABLE_EVENTS.has(type)) {
    return {
      persistence: "durable-event",
      reason: "runtime semantic boundary",
    };
  }

  if (PROJECTION_EVENTS.has(type)) {
    return {
      persistence: "projection-update",
      reason: "current state projection",
    };
  }

  if (UI_TRANSIENT_EVENTS.has(type)) {
    return {
      persistence: "ui-transient",
      reason: "best-effort UI coordination",
    };
  }

  return {
    persistence: "durable-event",
    reason: "unknown event types default to durable semantic handling",
  };
}
