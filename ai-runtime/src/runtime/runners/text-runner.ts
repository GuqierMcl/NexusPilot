import {
  consumeStream,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type GenerateTextOnEndCallback,
  type IdGenerator,
  isStepCount,
  type ModelMessage,
  ToolLoopAgent,
  type ToolApprovalConfiguration,
  type FinishReason as AiFinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  type StreamTextOnErrorCallback,
  type TextStreamPart,
  type ToolSet,
  type UserContent,
} from "ai";
import { createRuntimeId, type RuntimeId, type RuntimeIdPrefix } from "../core/ids";
import {
  resolveAgentExecutionPolicy,
  type ResolvedAgentExecutionPolicy,
} from "../agents/agent-resolver";
import {
  readConversationTitleMetadata,
  type GenerateConversationTitle,
} from "../conversations/conversation-title";
import type { ActiveRunRegistry } from "./active-run-registry";
import {
  RunContinuationRegistry,
} from "./run-continuation-registry";
import type { InterruptStoredRunResult } from "./run-interrupt";
import { RuntimeRunner } from "./runner";
import type {
  RunRequest,
  RuntimeRunnerStore,
  RuntimeRunStarted,
} from "./runner-types";
import {
  RuntimeToolCore,
  runtimeToolsToAiSdkToolSet,
  type BackendToolExecutor,
  type BackendBridgeRunState,
  type RuntimeToolRegistry,
  type RunToolSnapshot,
  type PreparedToolInvocationRegistry,
} from "../tools";
import type {
  FilePart,
  FinishReason,
  InterruptReason,
  PermissionId,
  Message,
  Run,
  Part,
  RunContextSnapshot,
  RuntimeError,
  ToolCall,
  ToolCallId,
  ToolError,
  ToolOutput,
  ToolResult,
  TokenUsage,
  TextPart,
  ReasoningPart,
  ToolPart,
  SourcePart,
} from "../core/types";
import {
  ATTACHMENT_LIMITS,
  RuntimeAttachmentError,
  type RuntimeAttachmentService,
} from "../attachments";
import { mapAiSdkUsage } from "../core/usage";
import type {
  RuntimeNetworkPolicy,
  RuntimeToolApprovalPolicy,
} from "../../settings/contracts";

export interface RuntimeResolvedLanguageModel {
  languageModel: LanguageModel;
  runtimeContext: Pick<RunContextSnapshot, "provider">;
}

export type RuntimeTextChunk =
  | {
      type: "text-start";
      id?: string;
    }
  | {
      type: "text-delta";
      id?: string;
      text: string;
    }
  | {
      type: "text-end";
      id?: string;
    }
  | {
      type: "reasoning-start";
      id?: string;
    }
  | {
      type: "reasoning-delta";
      id?: string;
      text: string;
    }
  | {
      type: "reasoning-end";
      id?: string;
    }
  | {
      type: "tool-input-start";
      toolCallId: string;
      toolName: string;
      title?: string;
    }
  | {
      type: "tool-input-delta";
      toolCallId: string;
      delta: string;
    }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: unknown;
      title?: string;
      invalid?: boolean;
    }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      input?: unknown;
      output: unknown;
      title?: string;
    }
  | {
      type: "tool-error";
      toolCallId: string;
      toolName: string;
      input?: unknown;
      error: unknown;
      title?: string;
    }
  | {
      type: "tool-approval-request";
      approvalId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
      title?: string;
      isAutomatic?: boolean;
    }
  | {
      type: "tool-approval-response";
      approvalId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
      approved: boolean;
      reason?: string;
      title?: string;
    }
  | {
      type: "tool-output-denied";
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "source-url";
      sourceId?: string;
      url: string;
      title?: string;
    }
  | {
      type: "start-step";
    }
  | {
      type: "finish-step";
    };

export interface RuntimeStreamFinishEvent {
  finishReason: AiFinishReason;
  totalUsage?: LanguageModelUsage;
  responseMessages?: ModelMessage[];
  stepCount?: number;
}

export interface RuntimeStreamAbortEvent {
  reason?: string;
}

interface RuntimeToolCallEventValue {
  toolCallId: string;
  toolName: string;
  input: unknown;
  title?: string;
}

interface RuntimeToolCallStartEvent {
  stepNumber?: number;
  toolCall: RuntimeToolCallEventValue;
}

type RuntimeToolCallFinishEvent = {
  stepNumber?: number;
  toolCall: RuntimeToolCallEventValue;
  durationMs: number;
} & (
  | { success: true; output: unknown }
  | { success: false; error: unknown }
);

export interface RuntimeStreamTextInput {
  model: LanguageModel;
  system?: string;
  prompt?: string;
  messages?: ModelMessage[];
  tools?: ToolSet;
  activeTools?: string[];
  toolApproval?: ToolApprovalConfiguration<ToolSet, unknown>;
  maxSteps?: number;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  toolChoice?: "auto" | "none";
  abortSignal?: AbortSignal;
  timeout?: number;
  onChunk?: (event: { chunk: RuntimeTextChunk }) => void | Promise<void>;
  onFinish?: (event: RuntimeStreamFinishEvent) => void | Promise<void>;
  onError?: (event: { error: unknown }) => void | Promise<void>;
  onAbort?: (event: RuntimeStreamAbortEvent) => void | Promise<void>;
  onToolCallStart?: (event: RuntimeToolCallStartEvent) => void | Promise<void>;
  onToolCallFinish?: (event: RuntimeToolCallFinishEvent) => void | Promise<void>;
}

export interface RuntimeUIMessageStreamResponseOptions extends ResponseInit {
  consumeSseStream?: (options: {
    stream: ReadableStream<string>;
  }) => PromiseLike<void> | void;
  generateMessageId?: IdGenerator;
  onError?: (error: unknown) => string;
}

export interface RuntimeStreamTextResult {
  toUIMessageStreamResponse(options?: RuntimeUIMessageStreamResponseOptions): Response;
}

export type RuntimeStreamText = (
  input: RuntimeStreamTextInput,
) => RuntimeStreamTextResult | Promise<RuntimeStreamTextResult>;

export interface RuntimeTextRunnerDependencies {
  store: RuntimeRunnerStore;
  attachmentService?: RuntimeAttachmentService | null;
  appVersion?: string;
  now?: () => number;
  createId?: <TPrefix extends RuntimeIdPrefix>(prefix: TPrefix) => RuntimeId<TPrefix>;
  resolveLanguageModel: (input: {
    providerId: string;
    modelId: string;
  }) => RuntimeResolvedLanguageModel;
  toolRegistry?: RuntimeToolRegistry;
  backendToolExecutor?: BackendToolExecutor;
  preparedInvocations?: PreparedToolInvocationRegistry;
  backendBridgeState?: () => BackendBridgeRunState;
  streamText?: RuntimeStreamText;
  generateConversationTitle?: GenerateConversationTitle;
  activeRuns?: ActiveRunRegistry;
  continuations?: RunContinuationRegistry;
  getToolApprovalPolicy?: () => RuntimeToolApprovalPolicy;
  getNetworkPolicy?: () => RuntimeNetworkPolicy;
}

export interface RuntimeTextRunResult {
  started: RuntimeRunStarted;
  response: Response;
}

export interface RuntimePermissionResponseInput {
  permissionId: PermissionId;
  approved: boolean;
  confirmationText?: string;
  reason?: string;
}

export class RuntimeRunNotFoundError extends Error {
  constructor(readonly runId: RuntimeId<"run">) {
    super(`Run ${runId} not found`);
    this.name = "RuntimeRunNotFoundError";
  }
}

export class RuntimeRunNotWaitingForPermissionError extends Error {
  constructor(readonly runId: RuntimeId<"run">) {
    super(`Run ${runId} is not waiting for permission`);
    this.name = "RuntimeRunNotWaitingForPermissionError";
  }
}

export class RuntimePermissionResponseMismatchError extends Error {
  constructor(readonly runId: RuntimeId<"run">) {
    super("Permission responses must cover every pending Permission exactly once");
    this.name = "RuntimePermissionResponseMismatchError";
  }
}

export class RuntimePermissionStrongConfirmationError extends Error {
  constructor(readonly permissionId: PermissionId) {
    super("Critical Permission requires an exact strong confirmation");
    this.name = "RuntimePermissionStrongConfirmationError";
  }
}

export class RuntimeContinuationLimitExceededError extends Error {
  constructor(
    readonly runId: RuntimeId<"run">,
    readonly limit: "maxSteps" | "maxOutputTokens" | "timeoutMs",
  ) {
    super(`Run ${runId} has exhausted its cumulative ${limit} limit`);
    this.name = "RuntimeContinuationLimitExceededError";
  }
}

interface RuntimeTextExecutionInput {
  request: RunRequest;
  resolved: RuntimeResolvedLanguageModel;
  policy: ResolvedAgentExecutionPolicy;
  runner: RuntimeRunner;
  started: RuntimeRunStarted;
  abortSignal?: AbortSignal;
  messages?: ModelMessage[];
  continuationResponsePrefix?: ModelMessage[];
  previousUsage?: TokenUsage;
  previousStepCount?: number;
  releaseContinuation?: () => void;
}

export class RuntimeTextRunner {
  private readonly streamTextImpl: RuntimeStreamText;
  private readonly continuationRegistry: RunContinuationRegistry;

  constructor(private readonly deps: RuntimeTextRunnerDependencies) {
    this.streamTextImpl = deps.streamText ?? defaultStreamText;
    this.continuationRegistry = deps.continuations ?? new RunContinuationRegistry();
  }

  async streamText(
    request: RunRequest,
    abortSignal?: AbortSignal,
  ): Promise<RuntimeTextRunResult> {
    const createId = this.deps.createId ?? createRuntimeId;
    const runId = request.runId ?? createId("run");
    const resolved = this.deps.resolveLanguageModel({
      providerId: request.providerId,
      modelId: request.modelId,
    });
    const policy = resolveAgentExecutionPolicy({
      runId,
      agentMode: request.agentMode,
      provider: {
        ...resolved.runtimeContext.provider,
        providerId: request.providerId,
        modelId: request.modelId,
      },
      toolRegistry: this.deps.toolRegistry,
      backendBridgeState: this.deps.backendBridgeState?.() ?? "waiting",
      approvalPolicy: this.deps.getToolApprovalPolicy?.(),
      networkPolicy: this.deps.getNetworkPolicy?.(),
      now: this.deps.now,
    });
    const runner = new RuntimeRunner({
      store: this.deps.store,
      attachmentService: this.deps.attachmentService,
      appVersion: this.deps.appVersion,
      now: this.deps.now,
      createId: this.deps.createId,
    });
    const started = runner.start({
      ...request,
      runId,
      agentMode: policy.agentMode,
      executionPolicy: {
        prompt: policy.prompt.snapshot,
        tools: policy.toolResolution.snapshot,
        limits: policy.limits,
        trace: policy.trace,
      },
      metadata: {
        ...(request.metadata ?? {}),
        runtimeContext: resolved.runtimeContext,
      },
    });
    scheduleConversationTitleGeneration({
      generateConversationTitle: this.deps.generateConversationTitle,
      store: this.deps.store,
      started,
      userText: request.text ?? extractRequestText(request),
      providerId: request.providerId,
      modelId: request.modelId,
      model: resolved.languageModel,
    });

    return this.#executeText({
      request,
      resolved,
      policy,
      runner,
      started,
      abortSignal,
    });
  }

  async continueText(
    runId: RuntimeId<"run">,
    responses: readonly RuntimePermissionResponseInput[],
    abortSignal?: AbortSignal,
  ): Promise<RuntimeTextRunResult> {
    const releaseContinuation = this.continuationRegistry.acquire(runId);
    let committedStart: RuntimeRunStarted | undefined;
    let committedRunner: RuntimeRunner | undefined;
    try {
      const createId = this.deps.createId ?? createRuntimeId;
      const waitingRun = this.deps.store.getRun(runId);
      if (!waitingRun) {
        throw new RuntimeRunNotFoundError(runId);
      }
      if (waitingRun.status !== "waiting_for_permission") {
        throw new RuntimeRunNotWaitingForPermissionError(runId);
      }
      const conversation = this.deps.store.getConversation(waitingRun.conversationId);
      const userMessage = waitingRun.parentMessageId
        ? this.deps.store.getMessage(waitingRun.parentMessageId)
        : null;
      const assistantMessage = waitingRun.assistantMessageId
        ? this.deps.store.getMessage(waitingRun.assistantMessageId)
        : null;
      if (
        !conversation ||
        !userMessage ||
        userMessage.role !== "user" ||
        !assistantMessage ||
        assistantMessage.role !== "assistant"
      ) {
        throw new Error("Waiting Runtime Run history is incomplete");
      }

      const continuation = readContinuationMetadata(waitingRun.metadata);
      if (!continuation) {
        throw new Error("Waiting Runtime Run has no continuation state");
      }
      const continuedAt = (this.deps.now ?? Date.now)();
      assertContinuationBudget(waitingRun, continuation, continuedAt);
      const pendingPermissions = this.deps.store.listPendingPermissionsByRun(runId);
      const responseIds = new Set(responses.map((response) => response.permissionId));
      if (
        responses.length === 0 ||
        responseIds.size !== responses.length ||
        pendingPermissions.length !== responses.length ||
        pendingPermissions.some((permission) => !responseIds.has(permission.id))
      ) {
        throw new RuntimePermissionResponseMismatchError(runId);
      }
      for (const permission of pendingPermissions) {
        const response = responses.find(
          (item) => item.permissionId === permission.id,
        )!;
        if (
          response.approved &&
          permission.confirmation.level === "strong" &&
          response.confirmationText !== permission.confirmation.prompt
        ) {
          throw new RuntimePermissionStrongConfirmationError(permission.id);
        }
      }
      const approvalParts = responses.map((response) => {
        const permission = pendingPermissions
          .find((item) => item.id === response.permissionId);
        if (!permission?.adapter?.aiSdkApprovalId) {
          throw new RuntimePermissionResponseMismatchError(runId);
        }
        return {
          type: "tool-approval-response" as const,
          approvalId: permission.adapter.aiSdkApprovalId,
          approved: response.approved,
          ...(response.reason ? { reason: response.reason } : {}),
        };
      });

      const resolved = this.deps.resolveLanguageModel({
        providerId: waitingRun.providerId,
        modelId: waitingRun.modelId,
      });
      const resolvedPolicy = resolveAgentExecutionPolicy({
        runId,
        agentMode: waitingRun.agentMode,
        provider: {
          ...resolved.runtimeContext.provider,
          providerId: waitingRun.providerId,
          modelId: waitingRun.modelId,
        },
        toolRegistry: this.deps.toolRegistry,
        backendBridgeState: this.deps.backendBridgeState?.() ?? "waiting",
        now: this.deps.now,
      });
      const snapshot = freezeRunToolSnapshot(waitingRun.input.tools);
      const policy: ResolvedAgentExecutionPolicy = {
        ...resolvedPolicy,
        limits: waitingRun.limits,
        toolResolution: {
          ...resolvedPolicy.toolResolution,
          snapshot,
          activeDefinitions: snapshot.activeTools.map((active) =>
            this.deps.toolRegistry!.requireTool(active.canonicalId)
          ),
        },
      };
      const history = this.deps.store
        .listMessages(waitingRun.conversationId)
        .filter((message) => message.id !== assistantMessage.id);
      const continuationResponsePrefix: ModelMessage[] = [
        ...continuation.responseMessages,
        {
          role: "tool",
          content: approvalParts,
        },
      ];
      const request: RunRequest = {
        runId,
        conversationId: waitingRun.conversationId,
        userMessageId: userMessage.id,
        providerId: waitingRun.providerId,
        modelId: waitingRun.modelId,
        text: extractTextContent(userMessage) ?? "Continue",
        agentMode: waitingRun.agentMode,
      };
      const runner = new RuntimeRunner({
        store: this.deps.store,
        attachmentService: this.deps.attachmentService,
        appVersion: this.deps.appVersion,
        now: this.deps.now,
        createId: this.deps.createId,
      });
      committedRunner = runner;
      const committed = this.deps.store.commitPermissionContinuation({
        runId,
        responses,
        continuedAt,
        eventIds: {
          permissions: responses.map(() => createId("evt")),
          tools: responses.map(() => createId("evt")),
          run: createId("evt"),
          conversation: createId("evt"),
        },
      });
      const started: RuntimeRunStarted = {
        conversation: committed.conversation,
        run: committed.run,
        userMessage,
        assistantMessage,
      };
      committedStart = started;
      const messages: ModelMessage[] = [
        ...(await buildModelMessages(history, this.deps.attachmentService)),
        ...continuationResponsePrefix,
      ];

      return await this.#executeText({
        request,
        resolved,
        policy,
        runner,
        started,
        abortSignal,
        messages,
        continuationResponsePrefix,
        previousUsage: waitingRun.usage,
        previousStepCount: continuation.stepCount,
        releaseContinuation,
      });
    } catch (error) {
      if (
        committedStart &&
        committedRunner &&
        this.deps.store.getRun(runId)?.status === "running"
      ) {
        const failedStart = committedStart;
        committedRunner.fail(failedStart, toRuntimeError(error));
        finalizeUnfinishedToolCalls({
          store: this.deps.store,
          createId: this.deps.createId ?? createRuntimeId,
          runId,
          completedAt: (this.deps.now ?? Date.now)(),
          state: "error",
          message: "Runtime continuation failed after permission commit.",
        });
        this.deps.preparedInvocations?.clearRun(runId);
        void this.deps.backendToolExecutor?.cleanupRun?.(runId);
        releaseContinuation();
        return {
          started: failedStart,
          response: withRuntimeHeaders(createUIMessageStreamResponse({
            stream: createUIMessageStream({
              execute: ({ writer }) => {
                writer.write({ type: "error", errorText: safeUiErrorMessage(error) });
              },
              generateId: () => failedStart.assistantMessage.id,
              onError: safeUiErrorMessage,
            }),
          }), failedStart),
        };
      }
      releaseContinuation();
      throw error;
    }
  }

  async #executeText(input: RuntimeTextExecutionInput): Promise<RuntimeTextRunResult> {
    const {
      request,
      resolved,
      policy,
      runner,
      started,
      abortSignal,
      messages: continuationMessages,
      continuationResponsePrefix,
      previousUsage,
      previousStepCount = 0,
      releaseContinuation,
    } = input;
    const createId = this.deps.createId ?? createRuntimeId;
    let finalText = "";
    let terminalWritten = false;
    let unregisterActiveRun: (() => void) | undefined;
    let releasePendingContinuation = releaseContinuation;
    const abortController = new AbortController();
    const abortSignalLink = linkAbortSignals(abortController, abortSignal);
    const cleanupActiveRun = (): void => {
      unregisterActiveRun?.();
      unregisterActiveRun = undefined;
      abortSignalLink.cleanup();
      releasePendingContinuation?.();
      releasePendingContinuation = undefined;
    };
    const cleanupPreparedRun = (): void => {
      this.deps.preparedInvocations?.clearRun(started.run.id);
      void this.deps.backendToolExecutor?.cleanupRun?.(started.run.id);
    };
    const semanticParts: Part[] = continuationMessages
      ? structuredClone(started.assistantMessage.parts)
      : [];
    const textPartByStreamId = new Map<string, TextPart>();
    const reasoningPartByStreamId = new Map<string, ReasoningPart>();
    const toolSlotsByAiSdkId = new Map<
      string,
      {
        id: ToolCallId;
        partId: RuntimeId<"part">;
        toolName: string;
        input: Record<string, unknown>;
        startedAt: number;
      }
    >();
    const toolPartByAiSdkId = new Map<string, ToolPart>();
    const sourcePartByAiSdkId = new Map<string, SourcePart>();
    const streamedToolInputByAiSdkId = new Map<
      string,
      { toolName: string; raw: string; title?: string }
    >();
    const invalidToolCallIds = new Set<string>();
    const now = this.deps.now ?? Date.now;
    for (const part of semanticParts) {
      if (
        part.type !== "tool" ||
        typeof part.metadata?.aiSdkToolCallId !== "string"
      ) {
        continue;
      }
      const aiSdkToolCallId = part.metadata.aiSdkToolCallId;
      const toolInput = "input" in part.state && part.state.input
        ? part.state.input
        : {};
      toolSlotsByAiSdkId.set(aiSdkToolCallId, {
        id: part.toolCallId,
        partId: part.id,
        toolName: part.toolName,
        input: toolInput,
        startedAt: part.time && "start" in part.time
          ? part.time.start
          : started.assistantMessage.time.created,
      });
      const persistedToolCall = this.deps.store.getToolCall(part.toolCallId);
      if (
        persistedToolCall?.state === "error" &&
        persistedToolCall.error &&
        part.state.status !== "completed"
      ) {
        const startedAt = part.time && "start" in part.time
          ? part.time.start
          : persistedToolCall.time.created;
        projectRuntimeToolCallError(part, persistedToolCall, startedAt);
      }
      toolPartByAiSdkId.set(aiSdkToolCallId, part);
    }
    const canonicalToolName = (name: string): string =>
      this.deps.toolRegistry?.getCanonicalId(name) ?? name;
    const writeFailure = (error: unknown): void => {
      if (terminalWritten) {
        return;
      }

      terminalWritten = true;
      cleanupActiveRun();
      cleanupPreparedRun();
      const failed = runner.fail(started, toRuntimeError(error));
      finalizeUnfinishedToolCalls({
        store: this.deps.store,
        createId,
        runId: started.run.id,
        completedAt: now(),
        state: "error",
        message: `Runtime Run failed: ${failed.error.name}`,
      });
    };
    const startTextPart = (streamId: string, aiSdkTextId?: string): TextPart => {
      let part = textPartByStreamId.get(streamId);
      if (!part) {
        part = createTextPart({
          id: createId("part"),
          conversationId: started.conversation.id,
          messageId: started.assistantMessage.id,
          text: "",
          created: started.assistantMessage.time.created,
          completed: started.assistantMessage.time.created,
          aiSdkTextId,
        });
        textPartByStreamId.set(streamId, part);
        semanticParts.push(part);
      }

      return part;
    };
    const appendTextDelta = (
      chunk: Extract<RuntimeTextChunk, { type: "text-delta" }>,
    ): void => {
      finalText += chunk.text;
      const streamId = chunk.id?.trim() || "__default_text__";
      const part = startTextPart(streamId, chunk.id);
      part.text += chunk.text;
    };
    const startReasoningPart = (
      streamId: string,
      aiSdkReasoningId?: string,
    ): ReasoningPart => {
      let part = reasoningPartByStreamId.get(streamId);
      if (!part) {
        part = createReasoningPart({
          id: createId("part"),
          conversationId: started.conversation.id,
          messageId: started.assistantMessage.id,
          text: "",
          created: started.assistantMessage.time.created,
          completed: started.assistantMessage.time.created,
          aiSdkReasoningId,
        });
        reasoningPartByStreamId.set(streamId, part);
        semanticParts.push(part);
      }

      return part;
    };
    const appendReasoningDelta = (
      chunk: Extract<RuntimeTextChunk, { type: "reasoning-delta" }>,
    ): void => {
      const streamId = chunk.id?.trim() || "__default_reasoning__";
      const part = startReasoningPart(streamId, chunk.id);
      part.text += chunk.text;
    };
    const ensureToolSlot = (input: {
      aiSdkToolCallId: string;
      toolName: string;
      toolInput?: Record<string, unknown>;
      startedAt: number;
    }): {
      id: ToolCallId;
      partId: RuntimeId<"part">;
      toolName: string;
      input: Record<string, unknown>;
      startedAt: number;
    } => {
      const existing = toolSlotsByAiSdkId.get(input.aiSdkToolCallId);
      const toolName = canonicalToolName(input.toolName);
      if (existing) {
        existing.toolName = toolName;
        if (input.toolInput) {
          existing.input = input.toolInput;
        }
        return existing;
      }

      const slot = {
        id: createId("tool"),
        partId: createId("part"),
        toolName,
        input: input.toolInput ?? {},
        startedAt: input.startedAt,
      };
      toolSlotsByAiSdkId.set(input.aiSdkToolCallId, slot);
      return slot;
    };
    const ensureToolPart = (input: {
      aiSdkToolCallId: string;
      toolName: string;
      toolInput?: Record<string, unknown>;
      title?: string;
      startedAt: number;
    }): ToolPart => {
      const slot = ensureToolSlot({
        aiSdkToolCallId: input.aiSdkToolCallId,
        toolName: input.toolName,
        toolInput: input.toolInput,
        startedAt: input.startedAt,
      });
      const existing = toolPartByAiSdkId.get(input.aiSdkToolCallId);
      if (existing) {
        existing.toolName = slot.toolName;
        if (
          existing.state.status === "pending" ||
          existing.state.status === "running" ||
          existing.state.status === "validating"
        ) {
          existing.state = {
            status: "running",
            input: slot.input,
            ...(input.title ? { title: input.title } : {}),
            time: { start: slot.startedAt },
          };
        }
        return existing;
      }

      const part: ToolPart = {
        id: slot.partId,
        conversationId: started.conversation.id,
        messageId: started.assistantMessage.id,
        type: "tool",
        toolCallId: slot.id,
        toolName: slot.toolName,
        state: {
          status: "running",
          input: slot.input,
          ...(input.title ? { title: input.title } : {}),
          time: { start: slot.startedAt },
        },
        time: { start: slot.startedAt },
        metadata: { aiSdkToolCallId: input.aiSdkToolCallId },
      };
      toolPartByAiSdkId.set(input.aiSdkToolCallId, part);
      semanticParts.push(part);
      return part;
    };
    const insertSourcePartAfterTool = (
      aiSdkToolCallId: string,
      toolPart: ToolPart,
      sourcePart: SourcePart,
    ): void => {
      const existing = sourcePartByAiSdkId.get(aiSdkToolCallId);
      if (existing) {
        Object.assign(existing, sourcePart);
        return;
      }

      sourcePartByAiSdkId.set(aiSdkToolCallId, sourcePart);
      const toolIndex = semanticParts.indexOf(toolPart);
      const insertIndex = toolIndex >= 0 ? toolIndex + 1 : semanticParts.length;
      semanticParts.splice(insertIndex, 0, sourcePart);
    };
    const resetActiveStreamParts = (): void => {
      textPartByStreamId.clear();
      reasoningPartByStreamId.clear();
    };
    const createSemanticParts = (completedAt: number): Part[] => {
      const parts: Part[] = [];

      for (const part of semanticParts) {
        if (part.type === "text") {
          if (part.text.length > 0) {
            parts.push({
              ...part,
              time: {
                start: started.assistantMessage.time.created,
                end: completedAt,
              },
            });
          }
          continue;
        }

        if (part.type !== "reasoning") {
          parts.push(part);
          continue;
        }

        const text = part.text.trim();
        if (text.length > 0) {
          parts.push({
            ...part,
            text,
            time: {
              start: started.assistantMessage.time.created,
              end: completedAt,
            },
          });
        }
      }

      return parts;
    };
    const writeInterruption = (
      reason: InterruptReason,
      message: string | undefined,
    ): InterruptStoredRunResult | null => {
      if (terminalWritten) {
        return null;
      }

      terminalWritten = true;
      cleanupActiveRun();
      cleanupPreparedRun();
      const parts = createSemanticParts(now());
      const interrupted = runner.interrupt(started, {
        reason,
        message,
        text: parts.some((part) => part.type === "text") ? "" : finalText,
        parts,
      });
      finalizeUnfinishedToolCalls({
        store: this.deps.store,
        createId,
        runId: started.run.id,
        completedAt: now(),
        state: "interrupted",
        message: message ?? reason,
      });
      return {
        interrupted: true,
        run: interrupted.run,
        conversation: interrupted.conversation,
        assistantMessage: interrupted.assistantMessage,
      };
    };

    unregisterActiveRun = this.deps.activeRuns?.register({
      runId: started.run.id,
      conversationId: started.conversation.id,
      interrupt: (request) => {
        abortController.abort(request.message ?? request.reason);
        return writeInterruption(request.reason, request.message);
      },
    });

    let result: RuntimeStreamTextResult;
    try {
      const messages = continuationMessages ??
        await buildModelMessages(
          this.deps.store.listMessages(started.conversation.id),
          this.deps.attachmentService,
        );
      const aiSdkTools = this.deps.toolRegistry
        ? runtimeToolsToAiSdkToolSet({
            registry: this.deps.toolRegistry,
            core: new RuntimeToolCore({
              registry: this.deps.toolRegistry,
              store: this.deps.store,
              backendExecutor: this.deps.backendToolExecutor,
              maxToolCallsPerRun: policy.limits.maxToolCalls,
              now: this.deps.now,
              preparedInvocations: this.deps.preparedInvocations,
            }),
            snapshot: policy.toolResolution.snapshot,
            conversationId: started.conversation.id,
            messageId: started.assistantMessage.id,
            resolveIdentity: (aiSdkToolCallId, providerName) => {
              const existing = toolSlotsByAiSdkId.get(aiSdkToolCallId);
              if (existing) {
                return { toolCallId: existing.id, partId: existing.partId };
              }
              const slot = ensureToolSlot({
                aiSdkToolCallId,
                toolName: providerName,
                startedAt: now(),
              });
              return { toolCallId: slot.id, partId: slot.partId };
            },
          })
        : undefined;
      result = await this.streamTextImpl({
        model: resolved.languageModel,
        system: policy.prompt.system,
        ...(messages.length > 0 ? { messages } : { prompt: request.text ?? "" }),
        maxSteps: Math.max(1, policy.limits.maxSteps - previousStepCount),
        maxOutputTokens: remainingOutputTokens(
          policy.limits.maxOutputTokens,
          previousUsage,
        ),
        temperature: policy.modelSettings.temperature,
        topP: policy.modelSettings.topP,
        toolChoice: policy.modelSettings.toolChoice,
        ...(aiSdkTools
          ? {
              tools: aiSdkTools.tools,
              activeTools: aiSdkTools.activeTools,
              toolApproval: aiSdkTools.toolApproval,
            }
          : {}),
        timeout: remainingRunTimeout(
          policy.limits.timeoutMs,
          started.run.time.started,
          now(),
        ),
        abortSignal: abortSignalLink.signal,
        onChunk: ({ chunk }) => {
          switch (chunk.type) {
            case "text-start":
              startTextPart(chunk.id?.trim() || "__default_text__", chunk.id);
              break;
            case "text-delta":
              appendTextDelta(chunk);
              break;
            case "text-end":
              textPartByStreamId.delete(chunk.id?.trim() || "__default_text__");
              break;
            case "reasoning-start":
              startReasoningPart(
                chunk.id?.trim() || "__default_reasoning__",
                chunk.id,
              );
              break;
            case "reasoning-delta":
              appendReasoningDelta(chunk);
              break;
            case "reasoning-end":
              reasoningPartByStreamId.delete(
                chunk.id?.trim() || "__default_reasoning__",
              );
              break;
            case "tool-input-start":
              streamedToolInputByAiSdkId.set(chunk.toolCallId, {
                toolName: chunk.toolName,
                raw: "",
                ...(chunk.title ? { title: chunk.title } : {}),
              });
              ensureToolPart({
                aiSdkToolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                title: chunk.title,
                startedAt: now(),
              });
              break;
            case "tool-input-delta": {
              const streamedInput = streamedToolInputByAiSdkId.get(chunk.toolCallId);
              if (streamedInput) {
                streamedInput.raw += chunk.delta;
              }
              break;
            }
            case "tool-call": {
              const streamedInput = streamedToolInputByAiSdkId.get(chunk.toolCallId);
              if (chunk.invalid) {
                invalidToolCallIds.add(chunk.toolCallId);
              }
              ensureToolPart({
                aiSdkToolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                toolInput: chunk.invalid ? {} : toRecord(chunk.input),
                title: chunk.title ?? streamedInput?.title,
                startedAt: now(),
              });
              break;
            }
            case "tool-result": {
              const completedAt = now();
              const input = toRecord(chunk.input);
              const result = toToolResult(chunk.output);
              const error = resolveToolResultError(result);
              const slot = ensureToolSlot({
                aiSdkToolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                toolInput: input,
                startedAt: completedAt,
              });
              const toolPart = ensureToolPart({
                aiSdkToolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                toolInput: input,
                title: chunk.title,
                startedAt: slot.startedAt,
              });
              Object.assign(
                toolPart,
                createToolPart({
                  id: slot.partId,
                  conversationId: started.conversation.id,
                  messageId: started.assistantMessage.id,
                  toolCallId: slot.id,
                  toolName: slot.toolName,
                  input,
                  result,
                  error,
                  startedAt: slot.startedAt,
                  completedAt,
                }),
              );

              const sourcePart = createSourcePartFromToolResult({
                id: createId("part"),
                conversationId: started.conversation.id,
                messageId: started.assistantMessage.id,
                result,
                created: completedAt,
                metadata: { aiSdkToolCallId: chunk.toolCallId },
              });
              if (sourcePart) {
                insertSourcePartAfterTool(chunk.toolCallId, toolPart, sourcePart);
              }
              break;
            }
            case "tool-error": {
              const completedAt = now();
              const validationError = invalidToolCallIds.has(chunk.toolCallId);
              const input = validationError ? {} : toRecord(chunk.input);
              const slot = ensureToolSlot({
                aiSdkToolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                toolInput: input,
                startedAt: completedAt,
              });
              const toolPart = ensureToolPart({
                aiSdkToolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                toolInput: input,
                title: chunk.title,
                startedAt: slot.startedAt,
              });

              if (
                toolPart.state.status === "completed" ||
                toolPart.state.status === "error"
              ) {
                invalidToolCallIds.delete(chunk.toolCallId);
                break;
              }

              invalidToolCallIds.delete(chunk.toolCallId);
              Object.assign(
                toolPart,
                createToolPart({
                  id: slot.partId,
                  conversationId: started.conversation.id,
                  messageId: started.assistantMessage.id,
                  toolCallId: slot.id,
                  toolName: slot.toolName,
                  input,
                  error: validationError
                    ? invalidToolInputError()
                    : toToolError(chunk.error),
                  startedAt: slot.startedAt,
                  completedAt,
                }),
              );
              break;
            }
            case "tool-approval-request": {
              const requestedAt = now();
              const input = toRecord(chunk.input);
              const slot = ensureToolSlot({
                aiSdkToolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                toolInput: input,
                startedAt: requestedAt,
              });
              if (chunk.isAutomatic) {
                const toolPart = ensureToolPart({
                  aiSdkToolCallId: chunk.toolCallId,
                  toolName: chunk.toolName,
                  toolInput: input,
                  title: chunk.title,
                  startedAt: slot.startedAt,
                });
                const persistedToolCall = this.deps.store.getToolCall(slot.id);
                if (
                  persistedToolCall?.state === "error" &&
                  persistedToolCall.error
                ) {
                  projectRuntimeToolCallError(
                    toolPart,
                    persistedToolCall,
                    slot.startedAt,
                  );
                }
                break;
              }
              const permission = this.deps.store.getPermissionByToolCallId(slot.id);
              if (!permission) {
                throw new Error(
                  `AI SDK approval ${chunk.approvalId} has no Runtime Permission`,
                );
              }
              const bound = this.deps.store.bindPermissionAiSdkApproval({
                permissionId: permission.id,
                toolCallId: slot.id,
                aiSdkApprovalId: chunk.approvalId,
                aiSdkToolCallId: chunk.toolCallId,
                boundAt: requestedAt,
                eventId: createId("evt"),
              });
              const toolPart = ensureToolPart({
                aiSdkToolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                toolInput: input,
                title: chunk.title,
                startedAt: slot.startedAt,
              });
              if (toolPart.state.status === "error") {
                break;
              }
              toolPart.metadata = {
                ...(toolPart.metadata ?? {}),
                aiSdkToolCallId: chunk.toolCallId,
                aiSdkApprovalId: chunk.approvalId,
              };
              toolPart.state = {
                status: "waiting_for_permission",
                input,
                permissionId: bound.id,
                ...(chunk.title ? { title: chunk.title } : {}),
                time: { start: slot.startedAt },
              };
              break;
            }
            case "tool-approval-response": {
              if (chunk.approved) {
                break;
              }
              const deniedAt = now();
              const input = toRecord(chunk.input);
              const slot = ensureToolSlot({
                aiSdkToolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                toolInput: input,
                startedAt: deniedAt,
              });
              const toolPart = ensureToolPart({
                aiSdkToolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                toolInput: input,
                title: chunk.title,
                startedAt: slot.startedAt,
              });
              const persistedToolCall = this.deps.store.getToolCall(slot.id);
              if (
                persistedToolCall?.state === "error" &&
                persistedToolCall.error
              ) {
                projectRuntimeToolCallError(
                  toolPart,
                  persistedToolCall,
                  slot.startedAt,
                );
                break;
              }
              toolPart.state = {
                status: "error",
                input,
                error: {
                  code: "PERMISSION_DENIED",
                  message: chunk.reason ?? "User denied this tool call.",
                  retryable: false,
                },
                time: { start: slot.startedAt, end: deniedAt },
              };
              toolPart.time = { start: slot.startedAt, end: deniedAt };
              break;
            }
            case "tool-output-denied": {
              const toolPart = toolPartByAiSdkId.get(chunk.toolCallId);
              if (
                toolPart &&
                toolPart.state.status !== "error" &&
                toolPart.state.status !== "completed"
              ) {
                const deniedAt = now();
                const input = "input" in toolPart.state && toolPart.state.input
                  ? toolPart.state.input
                  : {};
                const startedAt = toolPart.time && "start" in toolPart.time
                  ? toolPart.time.start
                  : deniedAt;
                toolPart.state = {
                  status: "error",
                  input,
                  error: {
                    code: "PERMISSION_DENIED",
                    message: "User denied this tool call.",
                    retryable: false,
                  },
                  time: { start: startedAt, end: deniedAt },
                };
                toolPart.time = { start: startedAt, end: deniedAt };
              }
              break;
            }
            case "source-url":
              semanticParts.push({
                id: createId("part"),
                conversationId: started.conversation.id,
                messageId: started.assistantMessage.id,
                type: "source",
                sourceType: "url",
                sourceId: chunk.sourceId,
                url: chunk.url,
                title: chunk.title,
                time: { created: now() },
              });
              break;
            case "start-step":
            case "finish-step":
              resetActiveStreamParts();
              break;
          }
        },
        onFinish: ({
          finishReason,
          totalUsage,
          responseMessages,
          stepCount = 0,
        }) => {
          if (terminalWritten) {
            return;
          }

          terminalWritten = true;
          cleanupActiveRun();
          const completedAt = now();
          const semanticParts = createSemanticParts(completedAt);
          const usage = addTokenUsage(
            previousUsage,
            mapAiSdkUsage(totalUsage),
          );
          const pendingPermissions = this.deps.store
            .listPendingPermissionsByRun(started.run.id);
          if (pendingPermissions.length > 0) {
            persistWaitingForPermission({
              store: this.deps.store,
              createId,
              started,
              parts: semanticParts,
              usage,
              responseMessages: [
                ...(continuationResponsePrefix ?? []),
                ...(responseMessages ?? []),
              ],
              stepCount: previousStepCount + stepCount,
              completedAt,
            });
            return;
          }
          cleanupPreparedRun();
          runner.completeText(started, finalText, {
            finish: mapAiSdkFinishReason(finishReason),
            usage,
            parts: semanticParts,
            appendTextPart: !semanticParts.some((part) => part.type === "text"),
          });
        },
        onError: ({ error }) => {
          writeFailure(error);
        },
        onAbort: ({ reason }) => {
          writeInterruption(mapStreamAbortReason(reason), reason ?? "stream aborted");
        },
        onToolCallStart: (event) => {
          const startedAt = now();
          const input = toRecord(event.toolCall.input);
          const slot = ensureToolSlot({
            aiSdkToolCallId: event.toolCall.toolCallId,
            toolName: event.toolCall.toolName,
            toolInput: input,
            startedAt,
          });
          slot.startedAt = startedAt;
          slot.input = input;
          const title = "title" in event.toolCall ? event.toolCall.title : undefined;
          const toolPart = ensureToolPart({
            aiSdkToolCallId: event.toolCall.toolCallId,
            toolName: event.toolCall.toolName,
            toolInput: input,
            title,
            startedAt: slot.startedAt,
          });
          toolPart.state = {
            status: "running",
            input,
            ...(title ? { title } : {}),
            time: { start: startedAt },
          };
          toolPart.time = { start: startedAt };

        },
        onToolCallFinish: (event) => {
          const completedAt = now();
          const input = toRecord(event.toolCall.input);
          const slot = ensureToolSlot({
            aiSdkToolCallId: event.toolCall.toolCallId,
            toolName: event.toolCall.toolName,
            toolInput: input,
            startedAt: completedAt - event.durationMs,
          });
          const startedAt = slot.startedAt;
          const result = event.success ? toToolResult(event.output) : undefined;
          const error = event.success
            ? resolveToolResultError(result)
            : toToolError(event.error);
          const state = event.success && isCompletedToolResult(result) ? "completed" : "error";
          const title = "title" in event.toolCall ? event.toolCall.title : undefined;
          const toolPart = ensureToolPart({
            aiSdkToolCallId: event.toolCall.toolCallId,
            toolName: event.toolCall.toolName,
            toolInput: input,
            title,
            startedAt,
          });
          Object.assign(toolPart, createToolPart({
            id: slot.partId,
            conversationId: started.conversation.id,
            messageId: started.assistantMessage.id,
            toolCallId: slot.id,
            toolName: slot.toolName,
            input,
            result,
            error,
            startedAt,
            completedAt,
          }));

          const sourcePart = createSourcePartFromToolResult({
            id: createId("part"),
            conversationId: started.conversation.id,
            messageId: started.assistantMessage.id,
            result,
            created: completedAt,
            metadata: { aiSdkToolCallId: event.toolCall.toolCallId },
          });
          if (sourcePart) {
            insertSourcePartAfterTool(event.toolCall.toolCallId, toolPart, sourcePart);
          }
        },
      });
    } catch (error) {
      writeFailure(error);
      return {
        started,
        response: withRuntimeHeaders(createUIMessageStreamResponse({
          stream: createUIMessageStream({
            execute: ({ writer }) => {
              writer.write({
                type: "error",
                errorText: safeUiErrorMessage(error),
              });
            },
            generateId: () => started.assistantMessage.id,
            onError: safeUiErrorMessage,
          }),
        }), started),
      };
    }

    return {
      started,
      response: withRuntimeHeaders(
        result.toUIMessageStreamResponse({
          consumeSseStream: consumeStream,
          generateMessageId: () => started.assistantMessage.id,
          onError: safeUiErrorMessage,
        }),
        started,
      ),
    };
  }
}

interface StoredContinuationMetadata {
  responseMessages: ModelMessage[];
  stepCount: number;
}

function readContinuationMetadata(
  metadata: Record<string, unknown> | undefined,
): StoredContinuationMetadata | null {
  const continuation = metadata?.continuation;
  if (
    typeof continuation !== "object" ||
    continuation === null ||
    Array.isArray(continuation)
  ) {
    return null;
  }
  const value = continuation as Record<string, unknown>;
  if (
    !Array.isArray(value.responseMessages) ||
    !Number.isSafeInteger(value.stepCount) ||
    (value.stepCount as number) < 0
  ) {
    return null;
  }
  return {
    responseMessages: value.responseMessages as ModelMessage[],
    stepCount: value.stepCount as number,
  };
}

function persistWaitingForPermission(input: {
  store: RuntimeRunnerStore;
  createId: <TPrefix extends RuntimeIdPrefix>(prefix: TPrefix) => RuntimeId<TPrefix>;
  started: RuntimeRunStarted;
  parts: Part[];
  usage: TokenUsage;
  responseMessages: ModelMessage[];
  stepCount: number;
  completedAt: number;
}): void {
  const currentRun = input.store.getRun(input.started.run.id);
  const currentConversation = input.store.getConversation(
    input.started.conversation.id,
  );
  if (
    !currentRun ||
    currentRun.status !== "waiting_for_permission" ||
    !currentConversation ||
    currentConversation.status.type !== "waiting_for_permission"
  ) {
    throw new Error("Runtime permission wait state was lost before stream finalization");
  }
  const currentMessage = input.store.getMessage(input.started.assistantMessage.id);
  const assistantMessage = {
    ...(currentMessage?.role === "assistant"
      ? currentMessage
      : input.started.assistantMessage),
    status: { type: "requires-action", reason: "permission" } as const,
    parts: input.parts,
    usage: input.usage,
  };
  const run = {
    ...currentRun,
    output: {
      messageId: assistantMessage.id,
      partIds: input.parts.map((part) => part.id),
    },
    usage: input.usage,
    metadata: {
      ...(currentRun.metadata ?? {}),
      continuation: {
        responseMessages: structuredClone(input.responseMessages),
        stepCount: input.stepCount,
      },
    },
  };
  input.store.saveMessage(assistantMessage);
  input.store.saveRun(run);
  input.store.appendEvent({
    id: input.createId("evt"),
    type: "message.updated",
    properties: { info: assistantMessage },
    time: input.completedAt,
  });
  input.store.appendEvent({
    id: input.createId("evt"),
    type: "run.updated",
    properties: { info: run },
    time: input.completedAt,
  });
  input.store.appendTrace({
    id: input.createId("trace"),
    conversationId: run.conversationId,
    runId: run.id,
    type: "stream.finished",
    level: "info",
    time: input.completedAt,
    payload: {
      finish: "tool-calls",
      waitingForPermission: true,
      pendingPermissionCount: input.store.listPendingPermissionsByRun(run.id).length,
      stepCount: input.stepCount,
      usage: input.usage,
    },
  });
}

function finalizeUnfinishedToolCalls(input: {
  store: RuntimeRunnerStore;
  createId: <TPrefix extends RuntimeIdPrefix>(prefix: TPrefix) => RuntimeId<TPrefix>;
  runId: RuntimeId<"run">;
  completedAt: number;
  state: "error" | "interrupted";
  message: string;
}): void {
  for (const toolCall of input.store.listToolCallsByRun(input.runId)) {
    if (
      toolCall.state === "completed" ||
      toolCall.state === "error" ||
      toolCall.state === "interrupted"
    ) {
      continue;
    }
    const outcome = toolCall.time.started === undefined ? "not_started" : "unknown";
    const error: NonNullable<ToolCall["error"]> = {
      code: input.state === "interrupted"
        ? "TOOL_EXECUTION_ABORTED"
        : "TOOL_EXECUTION_FAILED",
      message: input.message,
      retryable: false,
      outcome,
    };
    const finalized: ToolCall = {
      ...toolCall,
      state: input.state,
      error,
      ...(input.state === "error"
        ? { result: { ok: false as const, error } }
        : {}),
      time: {
        ...toolCall.time,
        completed: input.completedAt,
      },
    };
    input.store.saveToolCall(finalized);
    input.store.appendEvent({
      id: input.createId("evt"),
      type: "tool.updated",
      properties: { info: finalized },
      time: input.completedAt,
    });
  }
}

function addTokenUsage(
  previous: TokenUsage | undefined,
  current: TokenUsage,
): TokenUsage {
  const previousCache = previous?.cache;
  const currentCache = current.cache;
  const cacheRead = (previousCache?.read ?? 0) + (currentCache?.read ?? 0);
  const cacheWrite = (previousCache?.write ?? 0) + (currentCache?.write ?? 0);
  return {
    input: (previous?.input ?? 0) + current.input,
    output: (previous?.output ?? 0) + current.output,
    reasoning: (previous?.reasoning ?? 0) + current.reasoning,
    ...(cacheRead > 0 || cacheWrite > 0
      ? { cache: { read: cacheRead, write: cacheWrite } }
      : {}),
    total: (previous?.total ?? 0) + current.total,
  };
}

function remainingRunTimeout(
  timeoutMs: number | undefined,
  startedAt: number | undefined,
  currentTime: number,
): number | undefined {
  if (timeoutMs === undefined || startedAt === undefined) {
    return timeoutMs;
  }
  return Math.max(1, timeoutMs - Math.max(0, currentTime - startedAt));
}

function remainingOutputTokens(
  maxOutputTokens: number | undefined,
  usage: TokenUsage | undefined,
): number | undefined {
  if (maxOutputTokens === undefined) {
    return undefined;
  }
  return Math.max(1, maxOutputTokens - (usage?.output ?? 0));
}

function assertContinuationBudget(
  run: Run,
  continuation: StoredContinuationMetadata,
  currentTime: number,
): void {
  if (continuation.stepCount >= run.limits.maxSteps) {
    throw new RuntimeContinuationLimitExceededError(run.id, "maxSteps");
  }
  if (
    run.limits.maxOutputTokens !== undefined &&
    (run.usage?.output ?? 0) >= run.limits.maxOutputTokens
  ) {
    throw new RuntimeContinuationLimitExceededError(run.id, "maxOutputTokens");
  }
  if (
    run.limits.timeoutMs !== undefined &&
    run.time.started !== undefined &&
    currentTime - run.time.started >= run.limits.timeoutMs
  ) {
    throw new RuntimeContinuationLimitExceededError(run.id, "timeoutMs");
  }
}

function freezeRunToolSnapshot(snapshot: RunToolSnapshot | undefined): RunToolSnapshot {
  if (!snapshot) {
    throw new Error("Waiting Runtime Run has no Tool snapshot");
  }
  return deepFreezeValue(structuredClone(snapshot));
}

function deepFreezeValue<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreezeValue(child);
  }
  return Object.freeze(value);
}

function scheduleConversationTitleGeneration(input: {
  generateConversationTitle: GenerateConversationTitle | undefined;
  store: RuntimeRunnerStore;
  started: RuntimeRunStarted;
  userText: string;
  providerId: string;
  modelId: string;
  model: LanguageModel;
}): void {
  if (!input.generateConversationTitle) {
    return;
  }
  if (!input.userText.trim()) {
    return;
  }

  const titleMetadata = readConversationTitleMetadata(
    input.started.conversation.metadata,
  );
  if (titleMetadata?.source !== "fallback") {
    return;
  }

  const userMessages = input.store
    .listMessages(input.started.conversation.id)
    .filter((message) => message.role === "user");
  if (
    userMessages.length !== 1 ||
    userMessages[0]?.id !== input.started.userMessage.id
  ) {
    return;
  }

  try {
    void input
      .generateConversationTitle({
        conversationId: input.started.conversation.id,
        sourceMessageId: input.started.userMessage.id,
        fallbackTitle: input.started.conversation.title,
        providerId: input.providerId,
        modelId: input.modelId,
        userText: input.userText,
        model: input.model,
      })
      .catch(() => undefined);
  } catch {
    // Title generation is best-effort and must never interrupt the main Run.
  }
}

const defaultStreamText: RuntimeStreamText = async (input) => {
  const activeTools = input.activeTools?.length ? (input.activeTools as never) : undefined;
  const onEnd: GenerateTextOnEndCallback<ToolSet> | undefined = input.onFinish
    ? (event) =>
        input.onFinish?.({
          finishReason: event.finishReason,
          totalUsage: event.totalUsage,
          responseMessages: event.responseMessages,
          stepCount: event.steps.length,
        })
    : undefined;
  const onError: StreamTextOnErrorCallback | undefined = input.onError
    ? (event) => input.onError?.({ error: event.error })
    : undefined;
  const prompt = input.messages && input.messages.length > 0
    ? { messages: input.messages }
    : { prompt: input.prompt ?? "" };

  const agent = new ToolLoopAgent({
    model: input.model,
    instructions: input.system,
    tools: input.tools,
    activeTools,
    stopWhen: isStepCount(input.maxSteps ?? 1),
    maxOutputTokens: input.maxOutputTokens,
    temperature: input.temperature,
    topP: input.topP,
    toolChoice: input.toolChoice,
    toolApproval: input.toolApproval,
  });
  const result = await agent.stream({
    ...prompt,
    abortSignal: input.abortSignal,
    timeout: input.timeout,
    onEnd,
    onToolExecutionStart: input.onToolCallStart
      ? (event) => input.onToolCallStart?.({
          toolCall: {
            toolCallId: event.toolCall.toolCallId,
            toolName: event.toolCall.toolName,
            input: event.toolCall.input,
            title: event.toolCall.title,
          },
        })
      : undefined,
    onToolExecutionEnd: input.onToolCallFinish
      ? (event) => {
          const common = {
            toolCall: {
              toolCallId: event.toolCall.toolCallId,
              toolName: event.toolCall.toolName,
              input: event.toolCall.input,
              title: event.toolCall.title,
            },
            durationMs: event.toolExecutionMs,
          };
          return event.toolOutput.type === "tool-result"
            ? input.onToolCallFinish?.({
                ...common,
                success: true,
                output: event.toolOutput.output,
              })
            : input.onToolCallFinish?.({
                ...common,
                success: false,
                error: event.toolOutput.error,
              });
        }
      : undefined,
  });
  if (input.onChunk) {
    void consumeRuntimeFullStream(
      result.fullStream,
      input.onChunk,
      input.onError,
      input.onAbort,
    );
  }

  return {
    toUIMessageStreamResponse: (options) => result.toUIMessageStreamResponse(options),
  };
};

async function consumeRuntimeFullStream(
  stream: AsyncIterable<TextStreamPart<ToolSet>>,
  onChunk: NonNullable<RuntimeStreamTextInput["onChunk"]>,
  onError?: RuntimeStreamTextInput["onError"],
  onAbort?: RuntimeStreamTextInput["onAbort"],
): Promise<void> {
  try {
    for await (const part of stream) {
      if (part.type === "abort") {
        await onAbort?.({ reason: "stream aborted" });
        continue;
      }
      const chunk = toRuntimeTextChunk(part);
      if (chunk) {
        await onChunk({ chunk });
      }
    }
  } catch (error) {
    await onError?.({ error });
  }
}

async function buildModelMessages(
  messages: Message[],
  attachmentService?: RuntimeAttachmentService | null,
): Promise<ModelMessage[]> {
  const fileParts = messages.flatMap((message) =>
    message.role === "user"
      ? message.parts.filter(isPromptFilePart)
      : [],
  );
  const totalBytes = fileParts.reduce((sum, part) => sum + part.byteLength, 0);
  if (totalBytes > ATTACHMENT_LIMITS.maxRunHistoryAttachmentBytes) {
    throw new RuntimeAttachmentError(
      "ATTACHMENT_HISTORY_SIZE_EXCEEDED",
      "本次运行的历史附件总量超过 100 MiB 限制。",
      413,
      { limit_bytes: ATTACHMENT_LIMITS.maxRunHistoryAttachmentBytes },
    );
  }
  if (fileParts.length > 0 && !attachmentService) {
    throw new RuntimeAttachmentError(
      "ATTACHMENT_CONTENT_MISSING",
      "附件存储服务不可用。",
      503,
    );
  }

  const loaded = await mapWithConcurrency(
    fileParts,
    ATTACHMENT_LIMITS.readConcurrency,
    async (part) => [part.id, await attachmentService!.readBytes(part.attachmentId)] as const,
  );
  const bytesByPartId = new Map(loaded);

  return messages.flatMap((message): ModelMessage[] => {
    if (message.role === "user") {
      if (!message.parts.some(isPromptFilePart)) {
        const text = extractTextContent(message);
        return text ? [{ role: "user", content: text }] : [];
      }
      const content: UserContent = [];
      for (const part of message.parts) {
        if (isPromptTextPart(part)) {
          content.push({ type: "text", text: part.text });
          continue;
        }
        if (isPromptFilePart(part)) {
          const data = bytesByPartId.get(part.id);
          if (!data) {
            throw new RuntimeAttachmentError(
              "ATTACHMENT_CONTENT_MISSING",
              "附件内容未能加载。",
              500,
            );
          }
          content.push({
            type: "file",
            mediaType: part.mediaType,
            filename: part.filename,
            data: { type: "data", data },
          });
        }
      }
      return content.length > 0
        ? [{ role: "user", content } satisfies ModelMessage]
        : [];
    }

    const text = extractTextContent(message);
    return text
      ? [{ role: message.role, content: text } satisfies ModelMessage]
      : [];
  });
}

async function mapWithConcurrency<T, TResult>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index]!);
      }
    }),
  );
  return results;
}

function extractTextContent(message: Message): string | null {
  const text = message.parts
    .filter(isPromptTextPart)
    .map((part) => part.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");

  return text.length > 0 ? text : null;
}

function isPromptTextPart(part: Part): part is TextPart {
  return part.type === "text" && !part.ignored;
}

function isPromptFilePart(part: Part): part is FilePart {
  return part.type === "file";
}

function extractRequestText(request: RunRequest): string {
  return request.parts
    ?.filter((part) => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n") ?? "";
}

function safeUiErrorMessage(error: unknown): string {
  if (error instanceof RuntimeAttachmentError) {
    return error.message;
  }
  return "模型执行失败。当前模型可能不支持所发送的附件，请检查模型或附件后重试。";
}

function toRuntimeTextChunk(chunk: TextStreamPart<ToolSet>): RuntimeTextChunk | null {
  if (chunk.type === "text-start") {
    return {
      type: "text-start",
      id: chunk.id,
    };
  }

  if (chunk.type === "text-delta") {
    return {
      type: "text-delta",
      id: chunk.id,
      text: chunk.text,
    };
  }

  if (chunk.type === "text-end") {
    return {
      type: "text-end",
      id: chunk.id,
    };
  }

  if (chunk.type === "reasoning-start") {
    return {
      type: "reasoning-start",
      id: chunk.id,
    };
  }

  if (chunk.type === "reasoning-delta") {
    return {
      type: "reasoning-delta",
      id: chunk.id,
      text: chunk.text,
    };
  }

  if (chunk.type === "reasoning-end") {
    return {
      type: "reasoning-end",
      id: chunk.id,
    };
  }

  if (chunk.type === "tool-input-start") {
    return {
      type: "tool-input-start",
      toolCallId: chunk.id,
      toolName: chunk.toolName,
      title: chunk.title,
    };
  }

  if (chunk.type === "tool-input-delta") {
    return {
      type: "tool-input-delta",
      toolCallId: chunk.id,
      delta: chunk.delta,
    };
  }

  if (chunk.type === "tool-call") {
    return {
      type: "tool-call",
      toolCallId: chunk.toolCallId,
      toolName: chunk.toolName,
      input: chunk.input,
      title: chunk.title,
      ...("invalid" in chunk && chunk.invalid === true
        ? { invalid: true }
        : {}),
    };
  }

  if (chunk.type === "tool-result") {
    return {
      type: "tool-result",
      toolCallId: chunk.toolCallId,
      toolName: chunk.toolName,
      input: chunk.input,
      output: chunk.output,
      title: chunk.title,
    };
  }

  if (chunk.type === "tool-error") {
    return {
      type: "tool-error",
      toolCallId: chunk.toolCallId,
      toolName: chunk.toolName,
      input: chunk.input,
      error: chunk.error,
      title: chunk.title,
    };
  }

  if (chunk.type === "tool-approval-request") {
    return {
      type: "tool-approval-request",
      approvalId: chunk.approvalId,
      toolCallId: chunk.toolCall.toolCallId,
      toolName: chunk.toolCall.toolName,
      input: chunk.toolCall.input,
      title: chunk.toolCall.title,
      isAutomatic: chunk.isAutomatic,
    };
  }

  if (chunk.type === "tool-approval-response") {
    return {
      type: "tool-approval-response",
      approvalId: chunk.approvalId,
      toolCallId: chunk.toolCall.toolCallId,
      toolName: chunk.toolCall.toolName,
      input: chunk.toolCall.input,
      approved: chunk.approved,
      reason: chunk.reason,
      title: chunk.toolCall.title,
    };
  }

  if (chunk.type === "tool-output-denied") {
    return {
      type: "tool-output-denied",
      toolCallId: chunk.toolCallId,
      toolName: chunk.toolName,
    };
  }

  if (chunk.type === "source" && chunk.sourceType === "url") {
    return {
      type: "source-url",
      sourceId: chunk.id,
      url: chunk.url,
      title: chunk.title,
    };
  }

  if (chunk.type === "start-step") {
    return {
      type: "start-step",
    };
  }

  if (chunk.type === "finish-step") {
    return {
      type: "finish-step",
    };
  }

  return null;
}

function createTextPart(input: {
  id: RuntimeId<"part">;
  conversationId: RuntimeId<"conv">;
  messageId: RuntimeId<"msg">;
  text: string;
  created: number;
  completed: number;
  aiSdkTextId?: string;
}): TextPart {
  return {
    id: input.id,
    conversationId: input.conversationId,
    messageId: input.messageId,
    type: "text",
    text: input.text,
    time: { start: input.created, end: input.completed },
    ...(input.aiSdkTextId ? { metadata: { aiSdkTextId: input.aiSdkTextId } } : {}),
  };
}

function createReasoningPart(input: {
  id: RuntimeId<"part">;
  conversationId: RuntimeId<"conv">;
  messageId: RuntimeId<"msg">;
  text: string;
  created: number;
  completed: number;
  aiSdkReasoningId?: string;
}): ReasoningPart {
  return {
    id: input.id,
    conversationId: input.conversationId,
    messageId: input.messageId,
    type: "reasoning",
    text: input.text.trim(),
    time: { start: input.created, end: input.completed },
    ...(input.aiSdkReasoningId
      ? { metadata: { aiSdkReasoningId: input.aiSdkReasoningId } }
      : {}),
  };
}

function createToolPart(input: {
  id: RuntimeId<"part">;
  conversationId: RuntimeId<"conv">;
  messageId: RuntimeId<"msg">;
  toolCallId: ToolCallId;
  toolName: string;
  input: Record<string, unknown>;
  result?: ToolResult;
  error?: ToolError;
  startedAt: number;
  completedAt: number;
}): ToolPart {
  const state =
    input.result?.ok !== false && input.result?.output
      ? {
          status: "completed" as const,
          input: input.input,
          output: input.result.output,
          title: input.result.output.display?.title ?? input.toolName,
          metadata: { ...input.result.metadata },
          time: { start: input.startedAt, end: input.completedAt },
        }
      : {
          status: "error" as const,
          input: input.input,
          error:
            input.error ??
            ({
              code: "INTERNAL_ERROR",
              message: "Tool finished without a Runtime ToolResult",
              retryable: false,
            } satisfies ToolError),
          time: { start: input.startedAt, end: input.completedAt },
        };

  return {
    id: input.id,
    conversationId: input.conversationId,
    messageId: input.messageId,
    type: "tool",
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    state,
    time: { start: input.startedAt, end: input.completedAt },
  };
}

function createSourcePartFromToolResult(input: {
  id: RuntimeId<"part">;
  conversationId: RuntimeId<"conv">;
  messageId: RuntimeId<"msg">;
  result?: ToolResult;
  created: number;
  metadata?: Record<string, unknown>;
}): SourcePart | null {
  if (!input.result?.ok || !input.result.output) {
    return null;
  }

  const output = input.result.output as ToolOutput;
  const data = isRecord(output.data) ? output.data : {};
  const url = output.display?.sourceUrl ?? stringValue(data.finalUrl) ?? stringValue(data.url);
  if (!url) {
    return null;
  }

  return {
    id: input.id,
    conversationId: input.conversationId,
    messageId: input.messageId,
    type: "source",
    sourceType: "url",
    url,
    title: output.display?.title ?? stringValue(data.title),
    time: { created: input.created },
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function toToolResult(value: unknown): ToolResult | undefined {
  if (
    isRecord(value) &&
    typeof value.ok === "boolean" &&
    isRecord(value.metadata)
  ) {
    return value as unknown as ToolResult;
  }
  if (isRecord(value) && value.ok === true && typeof value.summary === "string") {
    return {
      ok: true,
      output: {
        data: value.data,
        display: {
          summary: value.summary,
          ...(isRecord(value.data) && typeof value.data.finalUrl === "string"
            ? { sourceUrl: value.data.finalUrl }
            : {}),
        },
      },
      metadata: { started: 0, completed: 0, durationMs: 0 },
    };
  }

  if (isRecord(value) && value.ok === false && isRecord(value.error)) {
    return {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message:
          typeof value.error.message === "string"
            ? value.error.message
            : "Tool execution failed.",
        retryable: value.error.retryable === true,
        details: {
          runtimeCode: value.error.code,
          outcome: value.error.outcome,
        },
      },
      metadata: { started: 0, completed: 0, durationMs: 0 },
    };
  }

  return undefined;
}

function toToolError(error: unknown): ToolError {
  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

function projectRuntimeToolCallError(
  part: ToolPart,
  toolCall: ToolCall,
  fallbackStartedAt: number,
): void {
  if (!toolCall.error) return;
  const completedAt = toolCall.time.completed ?? fallbackStartedAt;
  const startedAt = part.time && "start" in part.time
    ? part.time.start
    : toolCall.time.started ?? toolCall.time.created;
  part.state = {
    status: "error",
    input: toolCall.input,
    error: {
      code: toolCall.error.code === "TOOL_PERMISSION_DENIED"
        ? "PERMISSION_DENIED"
        : "INTERNAL_ERROR",
      message: toolCall.error.message,
      retryable: toolCall.error.retryable,
      details: {
        runtimeCode: toolCall.error.code,
        outcome: toolCall.error.outcome,
      },
    },
    time: { start: startedAt, end: completedAt },
  };
  part.time = { start: startedAt, end: completedAt };
}

function invalidToolInputError(): ToolError {
  return {
    code: "VALIDATION_ERROR",
    message: "Tool input did not match the declared schema.",
    retryable: true,
  };
}

function resolveToolResultError(result: ToolResult | undefined): ToolError | undefined {
  if (!result) {
    return internalToolError("Tool finished without a Runtime ToolResult");
  }

  if (result.ok === false) {
    return result.error ?? internalToolError("Tool failed without error details");
  }

  if (!result.output) {
    return internalToolError("Tool finished without output");
  }

  return undefined;
}

function isCompletedToolResult(
  result: ToolResult | undefined,
): result is ToolResult & { output: ToolOutput } {
  return result?.ok === true && Boolean(result.output);
}

function internalToolError(message: string): ToolError {
  return {
    code: "INTERNAL_ERROR",
    message,
    retryable: false,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withRuntimeHeaders(response: Response, started: RuntimeRunStarted): Response {
  const headers = new Headers(response.headers);
  headers.set("x-nexus-conversation-id", started.conversation.id);
  headers.set("x-nexus-run-id", started.run.id);
  headers.set("x-nexus-message-id", started.assistantMessage.id);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function mapAiSdkFinishReason(reason: AiFinishReason): FinishReason {
  switch (reason) {
    case "stop":
    case "length":
    case "tool-calls":
    case "content-filter":
      return reason;
    case "error":
      return "error";
    default:
      return "unknown";
  }
}

function linkAbortSignals(
  controller: AbortController,
  source: AbortSignal | undefined,
): { signal: AbortSignal; cleanup: () => void } {
  if (!source) {
    return { signal: controller.signal, cleanup: () => undefined };
  }

  const abort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(source.reason ?? "client disconnected");
    }
  };

  if (source.aborted) {
    abort();
    return { signal: controller.signal, cleanup: () => undefined };
  }

  source.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      source.removeEventListener("abort", abort);
    },
  };
}

function mapStreamAbortReason(reason: string | undefined): InterruptReason {
  const normalized = reason?.toLowerCase() ?? "";

  if (normalized.includes("timeout")) {
    return "timeout";
  }

  if (normalized.includes("tool")) {
    return "tool_abort";
  }

  if (normalized.includes("shutdown")) {
    return "runtime_shutdown";
  }

  if (normalized.includes("user") || normalized.includes("stop")) {
    return "user_stop";
  }

  if (normalized.includes("client") || normalized.includes("disconnect")) {
    return "client_disconnect";
  }

  return "client_disconnect";
}

function toRuntimeError(error: unknown): RuntimeError {
  if (error instanceof Error) {
    return {
      name: "APIError",
      data: {
        message: safeUiErrorMessage(error),
        isRetryable: false,
      },
    };
  }

  return {
    name: "UnknownError",
    data: {
      message: "模型执行失败，请检查模型与附件后重试。",
    },
  };
}
