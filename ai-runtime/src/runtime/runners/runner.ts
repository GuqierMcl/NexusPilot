import { createRuntimeId } from "../core/ids";
import { MessageAccumulator } from "../core/message-accumulator";
import {
  readConversationTitleMetadata,
  withConversationTitleMetadata,
} from "../conversations/conversation-title";
import {
  normalizeRunRequest,
  type RunRequest,
  type RuntimeRunCompleted,
  type RuntimeRunCompletionOptions,
  type RuntimeRunFailed,
  type RuntimeRunInterrupted,
  type RuntimeRunInterruptOptions,
  type RuntimeRunnerDependencies,
  type RuntimeRunStarted,
} from "./runner-types";
import type {
  AssistantMessage,
  Conversation,
  Event,
  FinishReason,
  Message,
  Run,
  RuntimeError,
  Part,
  TextPart,
  TraceEvent,
  UserMessage,
} from "../core/types";

export class RuntimeConversationNotFoundError extends Error {
  constructor(readonly conversationId: string) {
    super(`Conversation ${conversationId} not found`);
    this.name = "RuntimeConversationNotFoundError";
  }
}

export class RuntimeRunner {
  private readonly now: () => number;
  private readonly createId: NonNullable<RuntimeRunnerDependencies["createId"]>;
  private readonly appVersion: string;

  constructor(private readonly deps: RuntimeRunnerDependencies) {
    this.now = deps.now ?? Date.now;
    this.createId = deps.createId ?? createRuntimeId;
    this.appVersion = deps.appVersion ?? "unknown";
  }

  start(request: RunRequest): RuntimeRunStarted {
    const normalized = normalizeRunRequest(request);
    const created = this.now();
    const conversationId = normalized.conversationId ?? this.createId("conv");
    const userMessageId = normalized.userMessageId ?? this.createId("msg");
    const userTextPartId = this.createId("part");
    const runId = normalized.runId ?? this.createId("run");
    const assistantMessageId = this.createId("msg");

    if (
      normalized.executionPolicy.tools &&
      (normalized.executionPolicy.tools.runId !== runId ||
        normalized.executionPolicy.tools.agentMode !== normalized.agentMode)
    ) {
      throw new Error("Run Tool Snapshot does not match the target Run identity");
    }

    const existingConversation = normalized.conversationId
      ? this.deps.store.getConversation(normalized.conversationId)
      : null;
    if (normalized.conversationId && !existingConversation) {
      throw new RuntimeConversationNotFoundError(normalized.conversationId);
    }

    const existingMessages = existingConversation
      ? this.deps.store.listMessages(existingConversation.id)
      : [];
    const removedMessages = resolveMessagesToReplace({
      conversation: existingConversation,
      messages: existingMessages,
      replaceFromMessageId: normalized.replaceFromMessageId,
    });
    const shouldRefreshConversationTitle = shouldRefreshTitleAfterReplacement({
      conversation: existingConversation,
      messages: existingMessages,
      replaceFromMessageId: normalized.replaceFromMessageId,
    });

    const conversation: Conversation = existingConversation
      ? {
          ...existingConversation,
          ...(shouldRefreshConversationTitle
            ? {
                title: normalized.title,
                metadata: withConversationTitleMetadata(existingConversation.metadata, {
                  source: "fallback",
                  sourceMessageId: userMessageId,
                }),
              }
            : {}),
          status: { type: "busy", runId },
          time: { ...existingConversation.time, updated: created },
        }
      : {
          id: conversationId,
          title: normalized.title,
          version: "1",
          status: { type: "busy", runId },
          time: { created, updated: created },
          metadata: withConversationTitleMetadata(normalized.metadata, {
            source: normalized.titleSource,
            sourceMessageId: userMessageId,
          }),
        };

    const userMessage: UserMessage = {
      id: userMessageId,
      conversationId,
      role: "user",
      agentMode: normalized.agentMode,
      model: {
        providerId: normalized.providerId,
        modelId: normalized.modelId,
      },
      parts: [
        {
          id: userTextPartId,
          conversationId,
          messageId: userMessageId,
          type: "text",
          text: normalized.text,
          time: { created },
        },
      ],
      time: { created, completed: created },
      metadata: normalized.metadata ? { request: normalized.metadata } : undefined,
    };

    const run: Run = {
      id: runId,
      conversationId,
      parentMessageId: userMessageId,
      assistantMessageId,
      agentMode: normalized.agentMode,
      providerId: normalized.providerId,
      modelId: normalized.modelId,
      status: "running",
      input: {
        messageIds: [userMessageId],
        prompt: normalized.executionPolicy.prompt,
        tools:
          normalized.executionPolicy.tools ??
          createEmptyRunToolSnapshot(runId, normalized.agentMode, created),
        context: {
          runtime: {
            appVersion: this.appVersion,
            networkAccess: "enabled",
          },
          provider: {
            providerId: normalized.providerId,
            modelId: normalized.modelId,
          },
        },
      },
      time: { created, started: created },
      limits: normalized.limits,
      metadata: normalized.metadata,
    };

    const assistantMessage: AssistantMessage = {
      id: assistantMessageId,
      conversationId,
      role: "assistant",
      runId,
      parentId: userMessageId,
      providerId: normalized.providerId,
      modelId: normalized.modelId,
      agentMode: normalized.agentMode,
      status: { type: "running" },
      parts: [],
      time: { created },
      metadata: { runtime: { runId } },
    };

    const events: Event[] = [
      ...removedMessages.map(
        (message) =>
          ({
            id: this.createId("evt"),
            type: "message.removed",
            properties: { conversationId, messageId: message.id },
            time: created,
          }) as Event,
      ),
      ...(shouldRefreshConversationTitle
        ? [
            {
              id: this.createId("evt"),
              type: "conversation.updated",
              properties: { info: conversation },
              time: created,
            } as Event,
          ]
        : []),
      {
        id: this.createId("evt"),
        type: "run.updated",
        properties: { info: run },
        time: created,
      } as Event,
    ];
    const traces: TraceEvent[] = [
      {
        id: this.createId("trace"),
        conversationId,
        runId,
        type: "request.received",
        level: "info",
        time: created,
        payload: {
          providerId: normalized.providerId,
          modelId: normalized.modelId,
          agentMode: normalized.agentMode,
          ...(normalized.replaceFromMessageId
            ? {
                replacement: {
                  fromMessageId: normalized.replaceFromMessageId,
                  removedMessageCount: removedMessages.length,
                },
              }
            : {}),
        },
      },
      {
        id: this.createId("trace"),
        conversationId,
        runId,
        type: "prompt.assembled",
        level: "info",
        time: created,
        payload: {
          agentMode: normalized.agentMode,
          ...normalized.executionPolicy.trace,
        },
      },
    ];

    this.deps.store.commitRunStart({
      conversation,
      userMessage,
      run,
      assistantMessage,
      events,
      traces,
      ...(removedMessages.length > 0
        ? { removedMessageIds: removedMessages.map((message) => message.id) }
        : {}),
    });

    return { conversation, run, userMessage, assistantMessage };
  }

  completeText(
    started: RuntimeRunStarted,
    text: string,
    options: RuntimeRunCompletionOptions | FinishReason = {},
  ): RuntimeRunCompleted {
    const completedAt = this.now();
    const completion = typeof options === "string" ? { finish: options } : options;
    const finish = completion.finish ?? "stop";
    const parts: Part[] = [...(completion.parts ?? [])];
    const shouldAppendTextPart = completion.appendTextPart ?? true;
    const existingTextPart = findLastTextPart(parts);
    let textPart = existingTextPart;

    if (shouldAppendTextPart || !textPart) {
      const accumulator = new MessageAccumulator();
      accumulator.appendText(text);
      textPart = accumulator.toTextPart({
        id: this.createId("part"),
        conversationId: started.conversation.id,
        messageId: started.assistantMessage.id,
        created: started.assistantMessage.time.created,
        completed: completedAt,
      });
      parts.push(textPart);
    }
    const currentConversation =
      this.deps.store.getConversation(started.conversation.id) ??
      started.conversation;
    const conversation: Conversation = {
      ...currentConversation,
      status: { type: "idle" },
      time: { ...currentConversation.time, updated: completedAt },
    };
    const run: Run = {
      ...started.run,
      status: "completed",
      output: {
        messageId: started.assistantMessage.id,
        partIds: parts.map((part) => part.id),
      },
      usage: completion.usage,
      cost: completion.cost,
      finish,
      time: { ...started.run.time, completed: completedAt },
    };
    const assistantMessage: AssistantMessage = {
      ...started.assistantMessage,
      status: { type: "complete", reason: finish },
      parts,
      usage: completion.usage,
      cost: completion.cost,
      finish,
      time: { ...started.assistantMessage.time, completed: completedAt },
    };

    this.deps.store.saveConversation(conversation);
    this.deps.store.saveRun(run);
    this.deps.store.saveMessage(assistantMessage);
    this.appendEvent("message.updated", { info: assistantMessage }, completedAt);
    this.appendEvent("run.updated", { info: run }, completedAt);
    this.appendTrace("stream.finished", "info", conversation.id, run.id, completedAt, {
      finish,
      textLength: text.length,
      usage: completion.usage,
    });

    return { conversation, run, assistantMessage, textPart };
  }

  fail(started: RuntimeRunStarted, error: RuntimeError): RuntimeRunFailed {
    const completedAt = this.now();
    const currentConversation =
      this.deps.store.getConversation(started.conversation.id) ??
      started.conversation;
    const conversation: Conversation = {
      ...currentConversation,
      status: { type: "error", error },
      time: { ...currentConversation.time, updated: completedAt },
    };
    const run: Run = {
      ...started.run,
      status: "failed",
      finish: "error",
      error,
      time: { ...started.run.time, completed: completedAt },
    };
    const assistantMessage: AssistantMessage = {
      ...started.assistantMessage,
      status: { type: "error", error },
      finish: "error",
      error,
      time: { ...started.assistantMessage.time, completed: completedAt },
    };

    this.deps.store.saveConversation(conversation);
    this.deps.store.saveRun(run);
    this.deps.store.saveMessage(assistantMessage);
    this.appendEvent(
      "runtime.error",
      { conversationId: conversation.id, runId: run.id, error },
      completedAt,
    );
    this.appendEvent("run.updated", { info: run }, completedAt);
    this.appendTrace("stream.failed", "error", conversation.id, run.id, completedAt, error.data);

    return { conversation, run, assistantMessage, error };
  }

  interrupt(
    started: RuntimeRunStarted,
    options: RuntimeRunInterruptOptions,
  ): RuntimeRunInterrupted {
    const completedAt = this.now();
    const error: RuntimeError = {
      name: "MessageAbortedError",
      data: { message: options.message ?? options.reason },
    };
    const interrupt = {
      reason: options.reason,
      ...(options.message ? { message: options.message } : {}),
      interruptedAt: new Date(completedAt).toISOString(),
    };
    const parts: Part[] = [...(options.parts ?? [])];
    const text = options.text ?? "";

    if (text.trim().length > 0) {
      const accumulator = new MessageAccumulator();
      accumulator.appendText(text);
      parts.push(
        accumulator.toTextPart({
          id: this.createId("part"),
          conversationId: started.conversation.id,
          messageId: started.assistantMessage.id,
          created: started.assistantMessage.time.created,
          completed: completedAt,
        }),
      );
    }

    const currentConversation =
      this.deps.store.getConversation(started.conversation.id) ??
      started.conversation;
    const conversation: Conversation = {
      ...currentConversation,
      status: { type: "idle" },
      time: { ...currentConversation.time, updated: completedAt },
    };
    const run: Run = {
      ...started.run,
      status: "interrupted",
      output: {
        messageId: started.assistantMessage.id,
        partIds: parts.map((part) => part.id),
      },
      finish: "interrupted",
      error,
      metadata: {
        ...(started.run.metadata ?? {}),
        interrupt,
      },
      time: { ...started.run.time, completed: completedAt },
    };
    const assistantMessage: AssistantMessage = {
      ...started.assistantMessage,
      status: { type: "incomplete", reason: "interrupted" },
      parts,
      finish: "interrupted",
      error,
      metadata: {
        ...(started.assistantMessage.metadata ?? {}),
        interrupt,
      },
      time: { ...started.assistantMessage.time, completed: completedAt },
    };

    this.deps.store.saveConversation(conversation);
    this.deps.store.saveRun(run);
    this.deps.store.saveMessage(assistantMessage);
    this.appendEvent("message.updated", { info: assistantMessage }, completedAt);
    this.appendEvent("run.updated", { info: run }, completedAt);
    this.appendTrace("stream.failed", "warn", conversation.id, run.id, completedAt, {
      reason: options.reason,
      message: options.message,
      interrupted: true,
    });

    return { conversation, run, assistantMessage };
  }

  private appendEvent(type: Event["type"], properties: Record<string, unknown>, time: number): void {
    this.deps.store.appendEvent({
      id: this.createId("evt"),
      type,
      properties,
      time,
    } as Event);
  }

  private appendTrace(
    type: TraceEvent["type"],
    level: TraceEvent["level"],
    conversationId: Conversation["id"],
    runId: Run["id"],
    time: number,
    payload: Record<string, unknown>,
  ): void {
    this.deps.store.appendTrace({
      id: this.createId("trace"),
      conversationId,
      runId,
      type,
      level,
      time,
      payload,
    });
  }
}

export class RuntimeConversationBusyError extends Error {
  constructor(readonly conversationId: string) {
    super(`Conversation ${conversationId} has an active run`);
    this.name = "RuntimeConversationBusyError";
  }
}

export class RuntimeMessageNotEditableError extends Error {
  constructor(readonly messageId: string) {
    super(`Message ${messageId} cannot be edited in this conversation`);
    this.name = "RuntimeMessageNotEditableError";
  }
}

function resolveMessagesToReplace(input: {
  conversation: Conversation | null;
  messages: Message[];
  replaceFromMessageId: string | undefined;
}): Message[] {
  if (!input.replaceFromMessageId) {
    return [];
  }

  if (!input.conversation) {
    throw new RuntimeMessageNotEditableError(input.replaceFromMessageId);
  }

  if (input.conversation.status.type === "busy") {
    throw new RuntimeConversationBusyError(input.conversation.id);
  }

  const messageIndex = input.messages.findIndex(
    (message) => message.id === input.replaceFromMessageId,
  );
  const targetMessage = input.messages[messageIndex];
  if (
    messageIndex < 0 ||
    !targetMessage ||
    targetMessage.conversationId !== input.conversation.id ||
    targetMessage.role !== "user"
  ) {
    throw new RuntimeMessageNotEditableError(input.replaceFromMessageId);
  }

  return input.messages.slice(messageIndex);
}

function shouldRefreshTitleAfterReplacement(input: {
  conversation: Conversation | null;
  messages: Message[];
  replaceFromMessageId: string | undefined;
}): boolean {
  if (!input.conversation || !input.replaceFromMessageId) {
    return false;
  }

  const firstUserMessage = input.messages.find((message) => message.role === "user");
  if (firstUserMessage?.id !== input.replaceFromMessageId) {
    return false;
  }

  return readConversationTitleMetadata(input.conversation.metadata)?.source !== "user";
}

function createEmptyRunToolSnapshot(
  runId: Run["id"],
  agentMode: Run["agentMode"],
  createdAt: number,
): import("../tools/resolution").RunToolSnapshot {
  return Object.freeze({
    snapshotId: `tool_snapshot_${crypto.randomUUID().replaceAll("-", "")}`,
    runId,
    createdAt: new Date(createdAt).toISOString(),
    agentMode,
    executionCeiling: Object.freeze({
      maxRiskLevel: "low",
      allowedSideEffects: Object.freeze([]),
      allowIrreversible: false,
    }),
    activeTools: Object.freeze([]),
  });
}

function findLastTextPart(parts: Part[]): TextPart | undefined {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part?.type === "text") {
      return part;
    }
  }

  return undefined;
}
