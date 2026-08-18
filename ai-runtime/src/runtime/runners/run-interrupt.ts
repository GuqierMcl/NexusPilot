import { createRuntimeId, type RuntimeIdPrefix } from "../core/ids";
import type {
  AssistantMessage,
  Conversation,
  Event,
  InterruptReason,
  Message,
  MessageId,
  Permission,
  Run,
  RunId,
  PermissionId,
  RuntimeError,
  ToolCall,
  TraceEvent,
} from "../core/types";
import { isTerminalRunState } from "./runner-types";

export interface RuntimeRunInterruptStore {
  getConversation(id: Conversation["id"]): Conversation | null;
  saveConversation(conversation: Conversation): void;
  getRun(id: RunId): Run | null;
  saveRun(run: Run): void;
  getMessage(id: MessageId): Message | null;
  saveMessage(message: Message): void;
  listActiveRuns(): Run[];
  listToolCallsByRun(runId: RunId): ToolCall[];
  saveToolCall(toolCall: ToolCall): void;
  listPendingPermissionsByRun(runId: RunId): Permission[];
  resolvePermission(input: {
    permissionId: PermissionId;
    runId: RunId;
    status: "approved" | "denied" | "cancelled";
    source: "user" | "system";
    reason?: string;
    decidedAt: number;
    eventId: Event["id"];
  }): Permission;
  appendEvent(event: Event): void;
  appendTrace(trace: TraceEvent): void;
}

export interface InterruptStoredRunOptions {
  store: RuntimeRunInterruptStore;
  runId: RunId;
  reason: InterruptReason;
  message?: string;
  now?: () => number;
  createId?: <TPrefix extends RuntimeIdPrefix>(prefix: TPrefix) => string;
}

export interface InterruptStoredRunResult {
  interrupted: boolean;
  run: Run;
  conversation: Conversation | null;
  assistantMessage: AssistantMessage | null;
}

export interface RepairActiveStoredRunsOptions {
  store: RuntimeRunInterruptStore;
  now?: () => number;
  createId?: <TPrefix extends RuntimeIdPrefix>(prefix: TPrefix) => string;
}

export function interruptStoredRun(
  options: InterruptStoredRunOptions,
): InterruptStoredRunResult | null {
  const run = options.store.getRun(options.runId);
  if (!run) {
    return null;
  }

  const conversation = options.store.getConversation(run.conversationId);
  const assistantMessage = getAssistantMessage(options.store, run);
  if (isTerminalRunState(run.status)) {
    return {
      interrupted: run.status === "interrupted",
      run,
      conversation,
      assistantMessage,
    };
  }

  const now = options.now ?? Date.now;
  const createId = options.createId ?? createRuntimeId;
  const completedAt = now();
  const interrupt = {
    reason: options.reason,
    ...(options.message ? { message: options.message } : {}),
    interruptedAt: new Date(completedAt).toISOString(),
  };
  const error: RuntimeError = {
    name: "MessageAbortedError",
    data: { message: options.message ?? options.reason },
  };
  const updatedConversation = conversation
    ? interruptConversation(conversation, run, completedAt)
    : null;
  const updatedAssistantMessage = assistantMessage
    ? interruptAssistantMessage(assistantMessage, interrupt, error, completedAt)
    : null;
  const updatedRun: Run = {
    ...run,
    status: "interrupted",
    ...(updatedAssistantMessage
      ? {
          output: {
            messageId: updatedAssistantMessage.id,
            partIds: updatedAssistantMessage.parts.map((part) => part.id),
          },
        }
      : {}),
    finish: "interrupted",
    error,
    metadata: {
      ...(run.metadata ?? {}),
      interrupt,
    },
    time: { ...run.time, completed: completedAt },
  };

  if (updatedConversation) {
    options.store.saveConversation(updatedConversation);
  }
  options.store.saveRun(updatedRun);
  if (updatedAssistantMessage) {
    options.store.saveMessage(updatedAssistantMessage);
    appendEvent(options.store, createId, "message.updated", { info: updatedAssistantMessage }, completedAt);
  }

  for (const toolCall of options.store.listToolCallsByRun(run.id)) {
    if (isTerminalToolCallState(toolCall.state)) {
      continue;
    }

    const interruptedToolCall: ToolCall = {
      ...toolCall,
      state: "interrupted",
      error: {
        code: "INTERNAL_ERROR",
        message: options.message ?? options.reason,
        retryable: false,
        outcome: "unknown",
      },
      time: {
        ...toolCall.time,
        completed: completedAt,
      },
      metadata: {
        ...(toolCall.metadata ?? {}),
        interrupt,
      },
    };
    options.store.saveToolCall(interruptedToolCall);
    appendEvent(options.store, createId, "tool.updated", { info: interruptedToolCall }, completedAt);
  }

  for (const permission of options.store.listPendingPermissionsByRun(run.id)) {
    options.store.resolvePermission({
      permissionId: permission.id,
      runId: run.id,
      status: "cancelled",
      source: "system",
      reason: options.message ?? options.reason,
      decidedAt: completedAt,
      eventId: createId("evt") as Event["id"],
    });
  }

  appendEvent(options.store, createId, "run.updated", { info: updatedRun }, completedAt);
  appendTrace(options.store, createId, "stream.failed", "warn", run.conversationId, run.id, completedAt, {
    reason: options.reason,
    message: options.message,
    interrupted: true,
  });

  return {
    interrupted: true,
    run: updatedRun,
    conversation: updatedConversation,
    assistantMessage: updatedAssistantMessage,
  };
}

export function repairActiveStoredRuns(
  options: RepairActiveStoredRunsOptions,
): InterruptStoredRunResult[] {
  return options.store
    .listActiveRuns()
    .map((run) =>
      interruptStoredRun({
        store: options.store,
        runId: run.id,
        reason: "runtime_recovered_stale_run",
        message: "Runtime recovered a stale active run on startup",
        now: options.now,
        createId: options.createId,
      }),
    )
    .filter((result): result is InterruptStoredRunResult => result !== null);
}

function getAssistantMessage(
  store: RuntimeRunInterruptStore,
  run: Run,
): AssistantMessage | null {
  if (!run.assistantMessageId) {
    return null;
  }

  const message = store.getMessage(run.assistantMessageId);
  return message?.role === "assistant" ? message : null;
}

function interruptConversation(
  conversation: Conversation,
  run: Run,
  completedAt: number,
): Conversation {
  const status = conversation.status;
  const shouldIdle =
    (status.type === "busy" && status.runId === run.id) ||
    (status.type === "waiting_for_permission" && status.runId === run.id);

  return {
    ...conversation,
    status: shouldIdle ? { type: "idle" } : conversation.status,
    time: { ...conversation.time, updated: completedAt },
  };
}

function interruptAssistantMessage(
  message: AssistantMessage,
  interrupt: Record<string, unknown>,
  error: RuntimeError,
  completedAt: number,
): AssistantMessage {
  return {
    ...message,
    status: { type: "incomplete", reason: "interrupted" },
    finish: "interrupted",
    error,
    metadata: {
      ...(message.metadata ?? {}),
      interrupt,
    },
    time: { ...message.time, completed: completedAt },
  };
}

function isTerminalToolCallState(state: ToolCall["state"]): boolean {
  return state === "completed" || state === "error" || state === "interrupted";
}

function appendEvent(
  store: RuntimeRunInterruptStore,
  createId: <TPrefix extends RuntimeIdPrefix>(prefix: TPrefix) => string,
  type: Event["type"],
  properties: Record<string, unknown>,
  time: number,
): void {
  store.appendEvent({
    id: createId("evt") as Event["id"],
    type,
    properties,
    time,
  } as Event);
}

function appendTrace(
  store: RuntimeRunInterruptStore,
  createId: <TPrefix extends RuntimeIdPrefix>(prefix: TPrefix) => string,
  type: TraceEvent["type"],
  level: TraceEvent["level"],
  conversationId: Conversation["id"],
  runId: Run["id"],
  time: number,
  payload: Record<string, unknown>,
): void {
  store.appendTrace({
    id: createId("trace") as TraceEvent["id"],
    conversationId,
    runId,
    type,
    level,
    time,
    payload,
  });
}
