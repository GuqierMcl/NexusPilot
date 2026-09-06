import {
  consumeStream,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type GenerateTextOnEndCallback,
  type IdGenerator,
  type Instructions,
  isStepCount,
  type ModelMessage,
  ToolLoopAgent,
  type ToolApprovalConfiguration,
  type FinishReason as AiFinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  InvalidToolInputError,
  NoSuchToolError,
  type TextStreamPart,
  ToolCallRepairError,
  type ToolSet,
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
  FinishReason,
  InterruptReason,
  Permission,
  PermissionId,
  AssistantMessage,
  Message,
  Run,
  Part,
  RunContextSnapshot,
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
  TraceEvent,
} from "../core/types";
import type { RuntimeAttachmentService } from "../attachments";
import { mapAiSdkUsage } from "../core/usage";
import { projectModelHistory } from "../projection/model-history-projection";
import {
  projectContextCompactionActivityToAiSdkDataPart,
} from "../projection/ai-sdk-projection";
import {
  modelErrorMessage,
  toRuntimeModelError,
} from "./model-error";
import type {
  RuntimeNetworkPolicy,
  RuntimeToolApprovalPolicy,
} from "../../settings/contracts";
import type {
  ContextCompactionMarker,
  ModelContextManager,
  PreparedModelContext,
} from "../context/model-context-manager";
import {
  recoverContextOverflow,
  type ContextOverflowRetryGate,
} from "../context/overflow-recovery";
import { DEFAULT_CONTEXT_COMPACTION_POLICY } from "../context/policy";
import type {
  ContextForecastReason,
  ContextPlan,
  ContextUsage,
} from "../context/types";
import { stableStringifyJson } from "../context/token-estimator";

export interface RuntimeResolvedLanguageModel {
  languageModel: LanguageModel;
  runtimeContext: Pick<RunContextSnapshot, "provider">;
}

export type RuntimeTextChunk =
  | {
      type: "text-start";
      id?: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "text-delta";
      id?: string;
      text: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "text-end";
      id?: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "reasoning-start";
      id?: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "reasoning-delta";
      id?: string;
      text: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "reasoning-end";
      id?: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "tool-input-start";
      toolCallId: string;
      toolName: string;
      title?: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "tool-input-delta";
      toolCallId: string;
      delta: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "tool-input-end";
      toolCallId: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: unknown;
      title?: string;
      invalid?: boolean;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      input?: unknown;
      output: unknown;
      title?: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "tool-error";
      toolCallId: string;
      toolName: string;
      input?: unknown;
      error: unknown;
      title?: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "tool-approval-request";
      approvalId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
      title?: string;
      isAutomatic?: boolean;
      providerMetadata?: Record<string, unknown>;
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
      providerMetadata?: Record<string, unknown>;
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

export interface RuntimePrepareStepEvent {
  stepNumber: number;
  messages: ModelMessage[];
}

export interface RuntimeStepEndEvent {
  stepNumber: number;
  usage?: LanguageModelUsage;
  finishReason?: AiFinishReason;
}

export interface RuntimeStreamAbortEvent {
  reason?: string;
}

interface RuntimeToolCallEventValue {
  toolCallId: string;
  toolName: string;
  input: unknown;
  title?: string;
  providerMetadata?: Record<string, unknown>;
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
  instructions?: Instructions;
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
  /** Called for semantic raw AI SDK output before Runtime presentation conversion. */
  onModelOutput?: () => void | Promise<void>;
  onChunk?: (event: { chunk: RuntimeTextChunk }) => void | Promise<void>;
  onFinish?: (event: RuntimeStreamFinishEvent) => void | Promise<void>;
  onError?: (event: { error: unknown }) => void | Promise<void>;
  onAbort?: (event: RuntimeStreamAbortEvent) => void | Promise<void>;
  onToolCallStart?: (event: RuntimeToolCallStartEvent) => void | Promise<void>;
  onToolCallFinish?: (event: RuntimeToolCallFinishEvent) => void | Promise<void>;
  prepareStep?: (
    event: RuntimePrepareStepEvent,
  ) => Promise<{ instructions?: Instructions; messages?: ModelMessage[] } | void>;
  onStepEnd?: (event: RuntimeStepEndEvent) => void | Promise<void>;
  messageMetadata?: () => Record<string, unknown> | undefined;
}

export interface RuntimeUIMessageStreamResponseOptions extends ResponseInit {
  consumeSseStream?: (options: {
    stream: ReadableStream<string>;
  }) => PromiseLike<void> | void;
  generateMessageId?: IdGenerator;
  onError?: (error: unknown) => string;
  messageMetadata?: () => Record<string, unknown> | undefined;
}

export interface RuntimeStreamTextResult {
  /** Resolves once this attempt can be exposed without losing a safe replacement. */
  responseReady?: PromiseLike<void>;
  toUIMessageStreamResponse(options?: RuntimeUIMessageStreamResponseOptions): Response;
}

interface ContextOverflowRequestBaseline {
  requestIndex: number;
  semanticStepIndex: number;
  finalText: string;
  semanticPartCount: number;
  streamedStepCount: number;
  openToolLifecycle: boolean;
  pendingPermission: boolean;
  toolFactsHash: string;
  permissionFactsHash: string;
  sideEffectFactsHash: string;
}

export type RuntimeStreamText = (
  input: RuntimeStreamTextInput,
) => RuntimeStreamTextResult | Promise<RuntimeStreamTextResult>;

type StreamCoordinatorState =
  | "attempt0"
  | "recovering"
  | "attempt1"
  | "committed"
  | "terminal";

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
  getErrorMessageSecrets?: () => readonly string[];
  contextManager?: Pick<ModelContextManager, "prepare" | "forecastNextTurn">;
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
        .listActiveLineageMessages(waitingRun.conversationId)
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
        ...(await projectModelHistory(history, {
          attachmentService: this.deps.attachmentService,
          target: {
            providerId: waitingRun.providerId,
            modelId: waitingRun.modelId,
          },
        })),
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
        const runtimeError = toRuntimeModelError(
          error,
          this.deps.getErrorMessageSecrets?.() ?? [],
        );
        const failedAt = (this.deps.now ?? Date.now)();
        const currentMessage = this.deps.store.getMessage(
          failedStart.assistantMessage.id,
        );
        const failedParts = structuredClone(
          currentMessage?.parts ?? failedStart.assistantMessage.parts,
        );
        finalizeSemanticToolPartsForFailure(
          failedParts,
          failedAt,
          runtimeError.data.message,
        );
        committedRunner.fail(failedStart, runtimeError, { parts: failedParts });
        finalizeUnfinishedToolCalls({
          store: this.deps.store,
          createId: this.deps.createId ?? createRuntimeId,
          runId,
          completedAt: failedAt,
          state: "error",
          message: runtimeError.data.message,
        });
        this.deps.preparedInvocations?.clearRun(runId);
        void this.deps.backendToolExecutor?.cleanupRun?.(runId);
        releaseContinuation();
        return {
          started: failedStart,
          response: withRuntimeHeaders(createUIMessageStreamResponse({
            stream: createUIMessageStream({
              execute: ({ writer }) => {
                writer.write({
                  type: "error",
                  errorText: runtimeError.data.message,
                });
              },
              generateId: () => failedStart.assistantMessage.id,
              onError: (streamError) => modelErrorMessage(
                streamError,
                this.deps.getErrorMessageSecrets?.() ?? [],
              ),
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
    const contextRequestIndexBase = nextContextRequestIndex(
      this.deps.store,
      started.run.id,
      previousStepCount,
    );
    let finalText = "";
    let terminalWritten = false;
    let coordinatorState: StreamCoordinatorState = "attempt0";
    let committedAttempt: 0 | 1 = 0;
    let terminalAttempt: 0 | 1 | undefined;
    let recoveryInvalidated = false;
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
        providerToolName: string;
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
    const toolScopedErrorObjects = new WeakSet<object>();
    const toolScopedErrorPrimitives = new Set<unknown>();
    const markToolScopedStreamError = (error: unknown): void => {
      if (typeof error === "object" && error !== null) {
        toolScopedErrorObjects.add(error);
        return;
      }
      toolScopedErrorPrimitives.add(error);
    };
    const isToolScopedStreamError = (error: unknown): boolean => {
      if (
        InvalidToolInputError.isInstance(error) ||
        NoSuchToolError.isInstance(error) ||
        ToolCallRepairError.isInstance(error)
      ) {
        return true;
      }
      return typeof error === "object" && error !== null
        ? toolScopedErrorObjects.has(error)
        : toolScopedErrorPrimitives.has(error);
    };
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
        providerToolName: readProviderToolName(part),
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
    const resolveToolIdentity = (name: string): {
      canonicalName: string;
      providerName: string;
    } => {
      const canonicalName = this.deps.toolRegistry?.getCanonicalId(name) ?? name;
      const providerName = this.deps.toolRegistry?.getProviderName(canonicalName) ?? name;
      return { canonicalName, providerName };
    };
    let latestContextUsage: ContextUsage | undefined;
    let latestContextMarker: ContextCompactionMarker | undefined;
    let pendingOverflowRecoveryPayload: Record<string, unknown> | undefined;
    const markOverflowRecoverySucceeded = (): void => {
      if (!pendingOverflowRecoveryPayload) return;
      const recoveredAt = now();
      if (latestContextMarker?.activityId) {
        this.deps.store.finishContextCompactionActivity({
          activityId: latestContextMarker.activityId,
          status: "recovered",
          ...(latestContextMarker.checkpointId
            ? { checkpointId: latestContextMarker.checkpointId }
            : {}),
          ...(latestContextMarker.coverageCursor
            ? { coverageCursor: latestContextMarker.coverageCursor }
            : {}),
          ...(latestContextMarker.afterEstimatedInputTokens === undefined
            ? {}
            : {
                afterEstimatedInputTokens:
                  latestContextMarker.afterEstimatedInputTokens,
              }),
          completedAt: recoveredAt,
          eventId: createId("evt"),
        });
      }
      this.deps.store.appendTrace({
        id: createId("trace"),
        conversationId: started.conversation.id,
        runId: started.run.id,
        type: "context.overflow.recovered",
        level: "warn",
        time: recoveredAt,
        payload: pendingOverflowRecoveryPayload,
      });
      pendingOverflowRecoveryPayload = undefined;
      if (latestContextMarker) {
        latestContextMarker = {
          ...latestContextMarker,
          trigger: "provider_overflow",
          status: "recovered",
          time: { created: recoveredAt },
        };
      }
    };
    const resolveNextTurnForecastReason = (): ContextForecastReason => {
      if (latestContextMarker?.status === "created"
        || latestContextMarker?.status === "recovered") {
        return "checkpoint_created";
      }
      if (started.run.supersedesRunId) return "branch_changed";
      const parentRun = started.run.parentRunId
        ? this.deps.store.getRun(started.run.parentRunId)
        : undefined;
      if (
        parentRun
        && (parentRun.providerId !== request.providerId || parentRun.modelId !== request.modelId)
      ) {
        return "model_changed";
      }
      if (
        parentRun
        && (
          parentRun.agentMode !== started.run.agentMode
          || stableStringifyJson(parentRun.input.tools)
            !== stableStringifyJson(started.run.input.tools)
        )
      ) {
        return "prompt_policy_changed";
      }
      const parentUsage = parentRun
        ? this.deps.store.listContextUsagesByRun(parentRun.id).at(-1)
        : undefined;
      if (
        parentUsage
        && (
          parentUsage.estimatorVersion !== DEFAULT_CONTEXT_COMPACTION_POLICY.estimatorVersion
          || parentUsage.policyVersion !== DEFAULT_CONTEXT_COMPACTION_POLICY.version
          || parentUsage.checkpointFormatVersion
            !== DEFAULT_CONTEXT_COMPACTION_POLICY.checkpointFormatVersion
        )
      ) {
        return "estimator_policy_changed";
      }
      return "append";
    };
    const persistTerminalContextForecast = (): void => {
      if (!this.deps.contextManager?.forecastNextTurn) return;
      const lifecycleTrace = this.deps.store.listTraces(started.run.id).findLast((trace) =>
        (trace.type === "context.compaction.preparing"
          || trace.type === "context.compaction.failed")
        && Number.isSafeInteger(trace.payload.requestIndex)
      );
      const lifecycleRequestIndex = lifecycleTrace
        && typeof lifecycleTrace.payload.requestIndex === "number"
        && Number.isSafeInteger(lifecycleTrace.payload.requestIndex)
        && lifecycleTrace.payload.requestIndex >= 0
        ? lifecycleTrace.payload.requestIndex
        : undefined;
      const requestIndex = latestContextUsage?.requestIndex
        ?? lifecycleRequestIndex
        ?? contextRequestIndexBase;
      latestContextUsage ??= this.deps.store.getContextUsageByRunRequest(
        started.run.id,
        requestIndex,
      ) ?? undefined;
      const forecast = this.deps.contextManager.forecastNextTurn({
        conversationId: started.conversation.id,
        runId: started.run.id,
        requestIndex: requestIndex + 1,
        providerId: request.providerId,
        modelId: request.modelId,
        contextWindow: resolved.runtimeContext.provider.contextLength,
        modelOutputLimit: resolved.runtimeContext.provider.outputLength,
        reservedOutputTokens:
          policy.limits.maxOutputTokens
          ?? resolved.runtimeContext.provider.outputLength
          ?? 0,
        systemPrompt: policy.prompt.system,
        toolSchemas: policy.toolResolution.snapshot,
        policy: DEFAULT_CONTEXT_COMPACTION_POLICY,
        reason: resolveNextTurnForecastReason(),
      });
      if (latestContextUsage) {
        latestContextUsage = this.deps.store.updateContextUsageNextTurnForecast({
          runId: started.run.id,
          requestIndex: latestContextUsage.requestIndex,
          nextTurnForecast: forecast,
        });
        return;
      }
      latestContextUsage = {
        id: createId("ctxuse"),
        conversationId: started.conversation.id,
        runId: started.run.id,
        requestIndex,
        providerId: request.providerId,
        modelId: request.modelId,
        ...(forecast.contextWindow === undefined
          ? {}
          : { contextWindow: forecast.contextWindow }),
        estimatedInputTokens: forecast.estimatedInputTokens,
        estimateSource: "estimate",
        reservedOutputTokens:
          policy.limits.maxOutputTokens
          ?? resolved.runtimeContext.provider.outputLength
          ?? 0,
        view: forecast.view,
        ...(forecast.checkpointId ? { checkpointId: forecast.checkpointId } : {}),
        breakdown: forecast.breakdown,
        nextTurnForecast: forecast,
        estimatorVersion: forecast.estimatorVersion,
        policyVersion: forecast.policyVersion,
        checkpointFormatVersion: forecast.checkpointFormatVersion,
        time: { created: now() },
      };
      this.deps.store.saveContextUsage(latestContextUsage);
    };
    const writeFailure = (error: unknown): void => {
      if (terminalWritten) {
        return;
      }

      terminalWritten = true;
      coordinatorState = "terminal";
      cleanupActiveRun();
      cleanupPreparedRun();
      const completedAt = now();
      const runtimeError = toRuntimeModelError(
        error,
        this.deps.getErrorMessageSecrets?.() ?? [],
      );
      const parts = createSemanticParts(completedAt);
      finalizeSemanticToolPartsForFailure(
        parts,
        completedAt,
        `Runtime Run failed: ${runtimeError.name}`,
      );
      const failed = runner.fail(
        started,
        runtimeError,
        { parts },
      );
      finalizeUnfinishedToolCalls({
        store: this.deps.store,
        createId,
        runId: started.run.id,
        completedAt,
        state: "error",
        message: `Runtime Run failed: ${failed.error.name}`,
      });
      try {
        persistTerminalContextForecast();
      } catch (forecastError) {
        console.error("Failed to persist terminal next-turn context forecast", forecastError);
      }
      latestContextMarker = readLatestCompactionLifecycleMarker(
        this.deps.store.listTraces(started.run.id),
      ) ?? latestContextMarker;
    };
    const updatePartProviderMetadata = (
      part: Part,
      providerMetadata: Record<string, unknown> | undefined,
    ): void => {
      if (!providerMetadata) {
        return;
      }
      part.metadata = {
        ...(part.metadata ?? {}),
        providerMetadata: structuredClone(providerMetadata),
      };
    };
    const startTextPart = (
      streamId: string,
      aiSdkTextId?: string,
      providerMetadata?: Record<string, unknown>,
    ): TextPart => {
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
          providerMetadata,
        });
        textPartByStreamId.set(streamId, part);
        semanticParts.push(part);
      } else {
        updatePartProviderMetadata(part, providerMetadata);
      }

      return part;
    };
    const appendTextDelta = (
      chunk: Extract<RuntimeTextChunk, { type: "text-delta" }>,
    ): void => {
      finalText += chunk.text;
      const streamId = chunk.id?.trim() || "__default_text__";
      const part = startTextPart(streamId, chunk.id, chunk.providerMetadata);
      part.text += chunk.text;
    };
    const startReasoningPart = (
      streamId: string,
      aiSdkReasoningId?: string,
      providerMetadata?: Record<string, unknown>,
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
          providerMetadata,
        });
        reasoningPartByStreamId.set(streamId, part);
        semanticParts.push(part);
      } else {
        updatePartProviderMetadata(part, providerMetadata);
      }

      return part;
    };
    const appendReasoningDelta = (
      chunk: Extract<RuntimeTextChunk, { type: "reasoning-delta" }>,
    ): void => {
      const streamId = chunk.id?.trim() || "__default_reasoning__";
      const part = startReasoningPart(
        streamId,
        chunk.id,
        chunk.providerMetadata,
      );
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
      providerToolName: string;
      input: Record<string, unknown>;
      startedAt: number;
    } => {
      const existing = toolSlotsByAiSdkId.get(input.aiSdkToolCallId);
      const identity = resolveToolIdentity(input.toolName);
      if (existing) {
        existing.toolName = identity.canonicalName;
        existing.providerToolName = identity.providerName;
        if (input.toolInput) {
          existing.input = input.toolInput;
        }
        return existing;
      }

      const slot = {
        id: createId("tool"),
        partId: createId("part"),
        toolName: identity.canonicalName,
        providerToolName: identity.providerName,
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
      providerMetadata?: Record<string, unknown>;
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
        existing.metadata = {
          ...(existing.metadata ?? {}),
          providerToolName: slot.providerToolName,
        };
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
        updatePartProviderMetadata(existing, input.providerMetadata);
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
        metadata: {
          aiSdkToolCallId: input.aiSdkToolCallId,
          providerToolName: slot.providerToolName,
          ...(input.providerMetadata
            ? { providerMetadata: structuredClone(input.providerMetadata) }
            : {}),
        },
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
      const hasSignedReasoning = semanticParts.some(hasAnthropicReasoningSignature);

      for (const part of semanticParts) {
        if (part.type === "text") {
          if (part.text.length > 0 || hasSignedReasoning) {
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

        if (
          part.text.length > 0 ||
          readPartProviderMetadata(part) !== undefined
        ) {
          parts.push({
            ...part,
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
      coordinatorState = "terminal";
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
    let streamedStepCount = 0;
    const initialToolCalls = this.deps.store.listToolCallsByRun(started.run.id);
    const initialPermissions = this.deps.store.listPermissionsByRun(started.run.id);
    const overflowGate: ContextOverflowRetryGate = {
      runId: started.run.id,
      attempted: false,
      modelOutputObserved: false,
      toolLifecycleObserved: hasOpenToolLifecycle(initialToolCalls),
      permissionObserved: initialPermissions.some((permission) =>
        permission.status === "pending"
      ),
      sideEffectObserved: false,
    };
    let overflowRequestBaseline = createContextOverflowRequestBaseline({
      requestIndex: contextRequestIndexBase,
      semanticStepIndex: previousStepCount,
      finalText,
      semanticPartCount: semanticParts.length,
      streamedStepCount,
      toolCalls: initialToolCalls,
      permissions: initialPermissions,
    });
    let observedOverflowRequestIndex = overflowRequestBaseline.requestIndex;
    const activateContextOverflowRequest = (): void => {
      const toolCalls = this.deps.store.listToolCallsByRun(started.run.id);
      const permissions = this.deps.store.listPermissionsByRun(started.run.id);
      overflowRequestBaseline = createContextOverflowRequestBaseline({
        requestIndex: overflowRequestBaseline.requestIndex,
        semanticStepIndex: overflowRequestBaseline.semanticStepIndex,
        finalText,
        semanticPartCount: semanticParts.length,
        streamedStepCount,
        toolCalls,
        permissions,
      });
      observedOverflowRequestIndex = overflowRequestBaseline.requestIndex;
      overflowGate.modelOutputObserved = false;
      overflowGate.toolLifecycleObserved = overflowRequestBaseline.openToolLifecycle;
      overflowGate.permissionObserved = overflowRequestBaseline.pendingPermission;
      overflowGate.sideEffectObserved = false;
    };
    const beginContextOverflowRequest = (
      requestIndex: number,
      semanticStepIndex: number,
    ): void => {
      const toolCalls = this.deps.store.listToolCallsByRun(started.run.id);
      const permissions = this.deps.store.listPermissionsByRun(started.run.id);
      overflowRequestBaseline = createContextOverflowRequestBaseline({
        requestIndex,
        semanticStepIndex,
        finalText,
        semanticPartCount: semanticParts.length,
        streamedStepCount,
        toolCalls,
        permissions,
      });
      // ToolLoop can begin preparing request N+1 before the Runtime full-stream
      // consumer has observed every chunk from request N. Do not reset the
      // active observation gate until the corresponding start-step is consumed.
      if (observedOverflowRequestIndex === requestIndex) {
        activateContextOverflowRequest();
      }
    };
    let retryResult: RuntimeStreamTextResult | undefined;
    let pendingOverflowRecovery: Promise<void> | undefined;
    let pendingPrimaryUiStreamError: unknown;
    try {
      const prepareManagedContext = async (
        requestIndex: number,
        trigger: "auto_pre_turn" | "auto_mid_turn" | "provider_overflow",
        retainedMessages: ModelMessage[],
        retainedMessagesStartRequestIndex?: number,
        activityBoundaryStepIndex?: number,
      ): Promise<PreparedModelContext | undefined> => {
        if (!this.deps.contextManager) return undefined;
        return this.deps.contextManager.prepare({
          conversationId: started.conversation.id,
          runId: started.run.id,
          requestIndex,
          activityBoundaryStepIndex,
          providerId: request.providerId,
          modelId: request.modelId,
          model: resolved.languageModel,
          contextWindow: resolved.runtimeContext.provider.contextLength,
          modelOutputLimit: resolved.runtimeContext.provider.outputLength,
          reservedOutputTokens: remainingOutputTokens(
            policy.limits.maxOutputTokens,
            previousUsage,
          ) ?? resolved.runtimeContext.provider.outputLength ?? 0,
          systemPrompt: policy.prompt.system,
          toolSchemas: policy.toolResolution.snapshot,
          trigger,
          policy: DEFAULT_CONTEXT_COMPACTION_POLICY,
          abortSignal: abortSignalLink.signal,
          timeoutMs: remainingRunTimeout(
            policy.limits.timeoutMs,
            started.run.time.started,
            now(),
          ),
          excludeAssistantMessageId: started.assistantMessage.id,
          retainedMessages,
          retainedMessagesStartRequestIndex,
        });
      };
      let retainedModelMessages = [...(continuationResponsePrefix ?? [])];
      let retainedMessagesStartRequestIndex = retainedModelMessages.length > 0
        ? 0
        : undefined;
      const initialPrepared = await prepareManagedContext(
        contextRequestIndexBase,
        continuationMessages ? "auto_mid_turn" : "auto_pre_turn",
        retainedModelMessages,
        retainedMessagesStartRequestIndex,
      );
      if (initialPrepared) {
        if (initialPrepared.retainedMessagesCovered) {
          retainedModelMessages = [];
          retainedMessagesStartRequestIndex = undefined;
        }
        latestContextUsage = persistContextUsageEstimate({
          store: this.deps.store,
          createId,
          started,
          plan: initialPrepared.plan,
          providerId: request.providerId,
          modelId: request.modelId,
          createdAt: now(),
        });
        latestContextMarker = initialPrepared.marker;
      }
      const managedMessages = initialPrepared?.messages;
      const projectedMessages = managedMessages
        ? managedMessages
        : continuationMessages ?? await projectModelHistory(
          this.deps.store.listActiveLineageMessages(started.conversation.id),
          {
            attachmentService: this.deps.attachmentService,
            target: {
              providerId: request.providerId,
              modelId: request.modelId,
            },
          },
        );
      const unmanagedInstructions = projectedMessages.filter(
        (message): message is Extract<ModelMessage, { role: "system" }> =>
          message.role === "system",
      );
      const messages = projectedMessages.filter(
        (message) => message.role !== "system",
      );
      const runtimeInstructions = initialPrepared?.instructions
        ?? unmanagedInstructions;
      let lastPreparedModelMessages: ModelMessage[] = messages;
      let streamInput: RuntimeStreamTextInput | undefined;
      const ownsStreamAttempt = (attempt: 0 | 1): boolean =>
        (coordinatorState === "attempt0" && attempt === 0)
        || (coordinatorState === "attempt1" && attempt === 1)
        || (coordinatorState === "committed" && committedAttempt === attempt);
      const quarantineStaleAttempt = (attempt: 0 | 1): void => {
        if (attempt === 0 && coordinatorState === "recovering") {
          recoveryInvalidated = true;
        }
      };
      const bindStreamAttempt = (
        attemptInput: RuntimeStreamTextInput,
        attempt: 0 | 1,
      ): RuntimeStreamTextInput => {
        const toolApproval = attemptInput.toolApproval;
        return {
          ...attemptInput,
          ...(typeof toolApproval === "function"
            ? {
                toolApproval: ((options: Parameters<typeof toolApproval>[0]) => {
                  if (ownsStreamAttempt(attempt)) return toolApproval(options);
                  quarantineStaleAttempt(attempt);
                  return "denied" as const;
                }) as typeof toolApproval,
              }
            : {}),
          onChunk: attemptInput.onChunk
            ? (event) => {
                if (ownsStreamAttempt(attempt)) return attemptInput.onChunk?.(event);
                quarantineStaleAttempt(attempt);
              }
            : undefined,
          onModelOutput: attemptInput.onModelOutput
            ? () => {
                if (ownsStreamAttempt(attempt)) return attemptInput.onModelOutput?.();
                quarantineStaleAttempt(attempt);
              }
            : undefined,
          onFinish: attemptInput.onFinish
            ? (event) => {
                if (ownsStreamAttempt(attempt)) {
                  terminalAttempt = attempt;
                  return attemptInput.onFinish?.(event);
                }
                // AI SDK's outer completion can report the same failed model
                // request while the full-stream error is preparing a safe
                // replacement. It carries no additional output or side effect.
                if (
                  attempt === 0
                  && coordinatorState === "recovering"
                  && event.finishReason === "error"
                ) return;
                quarantineStaleAttempt(attempt);
              }
            : undefined,
          onError: attemptInput.onError
            ? (event) => {
                if (ownsStreamAttempt(attempt)) return attemptInput.onError?.(event);
                quarantineStaleAttempt(attempt);
              }
            : undefined,
          onAbort: attemptInput.onAbort
            ? (event) => {
                if (ownsStreamAttempt(attempt)) return attemptInput.onAbort?.(event);
                quarantineStaleAttempt(attempt);
              }
            : undefined,
          onToolCallStart: attemptInput.onToolCallStart
            ? (event) => {
                if (ownsStreamAttempt(attempt)) return attemptInput.onToolCallStart?.(event);
                quarantineStaleAttempt(attempt);
              }
            : undefined,
          onToolCallFinish: attemptInput.onToolCallFinish
            ? (event) => {
                if (ownsStreamAttempt(attempt)) return attemptInput.onToolCallFinish?.(event);
                quarantineStaleAttempt(attempt);
              }
            : undefined,
          prepareStep: attemptInput.prepareStep
            ? async (event) => {
                if (ownsStreamAttempt(attempt)) return await attemptInput.prepareStep?.(event);
                quarantineStaleAttempt(attempt);
                return undefined;
              }
            : undefined,
          onStepEnd: attemptInput.onStepEnd
            ? (event) => {
                if (ownsStreamAttempt(attempt)) return attemptInput.onStepEnd?.(event);
                // AI SDK closes the failed model step after emitting an error.
                // This callback contains no user-visible output or tool effect;
                // discard it while overflow preparation owns the coordinator.
                if (attempt === 0 && coordinatorState === "recovering") return;
                quarantineStaleAttempt(attempt);
              }
            : undefined,
          messageMetadata: attemptInput.messageMetadata
            ? () => {
                if (ownsStreamAttempt(attempt) || terminalAttempt === attempt) {
                  return attemptInput.messageMetadata?.();
                }
                quarantineStaleAttempt(attempt);
                return undefined;
              }
            : undefined,
          };
      };
      const createManagedPrepareStep = (
        baseSemanticStepIndex: number,
        baseContextRequestIndex: number,
        firstMessages: ModelMessage[],
        firstInstructions: PreparedModelContext["instructions"] | undefined,
        firstPrepared: boolean,
      ): NonNullable<RuntimeStreamTextInput["prepareStep"]> => async (event) => {
        const requestIndex = baseContextRequestIndex + event.stepNumber;
        const semanticStepIndex = baseSemanticStepIndex + event.stepNumber;
        beginContextOverflowRequest(requestIndex, semanticStepIndex);
        if (event.stepNumber === 0 && firstPrepared) {
          lastPreparedModelMessages = firstMessages;
          return {
            instructions: combineRuntimeInstructions(
              policy.prompt.system,
              firstInstructions,
            ),
            messages: firstMessages,
          };
        }
        const inFlightSuffix = event.messages.slice(lastPreparedModelMessages.length);
        if (inFlightSuffix.length > 0 && retainedMessagesStartRequestIndex === undefined) {
          retainedMessagesStartRequestIndex = Math.max(0, semanticStepIndex - 1);
        }
        retainedModelMessages = [
          ...retainedModelMessages,
          ...inFlightSuffix,
        ];
        const prepared = await prepareManagedContext(
          requestIndex,
          "auto_mid_turn",
          retainedModelMessages,
          retainedMessagesStartRequestIndex,
          semanticStepIndex,
        );
        if (!prepared) return undefined;
        if (prepared.retainedMessagesCovered) {
          retainedModelMessages = [];
          retainedMessagesStartRequestIndex = undefined;
        }
        const nextMessages = prepared.messages;
        latestContextUsage = persistContextUsageEstimate({
          store: this.deps.store,
          createId,
          started,
          plan: prepared.plan,
          providerId: request.providerId,
          modelId: request.modelId,
          createdAt: now(),
        });
        latestContextMarker = prepared.marker ?? latestContextMarker;
        // Preserve the AI SDK's exact accumulated response/tool/Permission suffix.
        lastPreparedModelMessages = nextMessages;
        return {
          instructions: combineRuntimeInstructions(
            policy.prompt.system,
            prepared.instructions,
          ),
          messages: nextMessages,
        };
      };
      const createManagedOnStepEnd = (
        baseSemanticStepIndex: number,
        baseContextRequestIndex: number,
      ): NonNullable<RuntimeStreamTextInput["onStepEnd"]> => async (event) => {
        const stepIndex = baseSemanticStepIndex + event.stepNumber;
        if (!semanticParts.some(
          (part) => part.type === "step-finish" && part.stepIndex === stepIndex,
        )) {
          const completedAt = now();
          semanticParts.push({
            id: createId("part"),
            conversationId: started.conversation.id,
            messageId: started.assistantMessage.id,
            type: "step-finish",
            stepIndex,
            reason: event.finishReason
              ? mapAiSdkFinishReason(event.finishReason)
              : "unknown",
            ...(event.usage ? { usage: mapAiSdkUsage(event.usage) } : {}),
            time: { created: completedAt },
          });
          persistSealedAssistantPrefix({
            store: this.deps.store,
            createId,
            started,
            parts: semanticParts,
            completedAt,
          });
        }
        const observation = toContextProviderObservation(event.usage);
        if (!observation) return;
        latestContextUsage = this.deps.store.updateContextUsageProviderObservation({
          runId: started.run.id,
          requestIndex: baseContextRequestIndex + event.stepNumber,
          providerObservation: observation,
        });
      };
      const createFinalErrorResult = (finalError: unknown): RuntimeStreamTextResult => ({
        toUIMessageStreamResponse: () => new Response(
          `data: ${JSON.stringify({
            type: "error",
            errorText: modelErrorMessage(
              finalError,
              this.deps.getErrorMessageSecrets?.() ?? [],
            ),
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      });
      const adoptDurableTerminalState = (): void => {
        terminalWritten = true;
        coordinatorState = "terminal";
        cleanupActiveRun();
        cleanupPreparedRun();
      };
      const retryContextOverflow = async (error: unknown): Promise<boolean> => {
        if (
          coordinatorState !== "attempt0"
          && !(coordinatorState === "committed" && committedAttempt === 0)
        ) return false;
        const currentRun = this.deps.store.getRun(started.run.id);
        const currentConversation = this.deps.store.getConversation(started.conversation.id);
        if (!currentRun || !currentConversation || !this.deps.contextManager) return false;
        // Some Providers fail before AI SDK emits start-step. The full-stream
        // error is still an exact model-request boundary, so activate the most
        // recently prepared request before evaluating its observations.
        if (observedOverflowRequestIndex !== overflowRequestBaseline.requestIndex) {
          activateContextOverflowRequest();
        }
        if (isTerminalRunStatus(currentRun.status)) {
          adoptDurableTerminalState();
          return true;
        }
        if (currentRun.status !== "running") return false;
        const currentToolCalls = this.deps.store.listToolCallsByRun(started.run.id);
        const currentPermissions = this.deps.store.listPermissionsByRun(started.run.id);
        overflowGate.toolLifecycleObserved ||=
          contextOverflowToolFactsHash(currentToolCalls)
            !== overflowRequestBaseline.toolFactsHash;
        overflowGate.permissionObserved ||=
          contextOverflowPermissionFactsHash(currentPermissions)
            !== overflowRequestBaseline.permissionFactsHash;
        overflowGate.sideEffectObserved ||=
          contextOverflowSideEffectFactsHash(currentToolCalls)
            !== overflowRequestBaseline.sideEffectFactsHash;
        if (currentConversation.revision !== started.conversation.revision) return false;
        const decision = recoverContextOverflow({
          error,
          gate: overflowGate,
          currentRun,
          currentConversation,
        });
        if (overflowGate.attempted) coordinatorState = "recovering";
        if (await decision !== "retry") {
          coordinatorState = "attempt0";
          return false;
        }

        finalText = overflowRequestBaseline.finalText;
        semanticParts.splice(overflowRequestBaseline.semanticPartCount);
        streamedStepCount = overflowRequestBaseline.streamedStepCount;
        resetActiveStreamParts();

        const failedRequestIndex = overflowRequestBaseline.requestIndex;
        const failedSemanticStepIndex = overflowRequestBaseline.semanticStepIndex;
        const requestIndex = failedRequestIndex + 1;
        let prepared: PreparedModelContext;
        try {
          prepared = await prepareManagedContext(
            requestIndex,
            "provider_overflow",
            [],
            undefined,
            failedSemanticStepIndex,
          ) as PreparedModelContext;
        } catch {
          const failedRecoveryRun = this.deps.store.getRun(started.run.id);
          if (failedRecoveryRun && isTerminalRunStatus(failedRecoveryRun.status)) {
            adoptDurableTerminalState();
            return true;
          }
          if (abortSignal?.aborted || abortSignalLink.signal.aborted) {
            const message = abortReasonMessage(
              abortSignal?.reason ?? abortSignalLink.signal.reason,
            );
            writeInterruption(mapStreamAbortReason(message), message);
            return true;
          }
          coordinatorState = "attempt0";
          writeFailure(error);
          return true;
        }
        const applicableRun = this.deps.store.getRun(started.run.id);
        const applicableConversation = this.deps.store.getConversation(
          started.conversation.id,
        );
        const applicablePermissions = this.deps.store.listPermissionsByRun(started.run.id);
        const applicableToolCalls = this.deps.store.listToolCallsByRun(started.run.id);
        overflowGate.permissionObserved ||=
          contextOverflowPermissionFactsHash(applicablePermissions)
            !== overflowRequestBaseline.permissionFactsHash;
        overflowGate.toolLifecycleObserved ||=
          contextOverflowToolFactsHash(applicableToolCalls)
            !== overflowRequestBaseline.toolFactsHash;
        overflowGate.sideEffectObserved ||=
          contextOverflowSideEffectFactsHash(applicableToolCalls)
            !== overflowRequestBaseline.sideEffectFactsHash;
        if (abortSignal?.aborted || abortSignalLink.signal.aborted) {
          const message = abortReasonMessage(
            abortSignal?.reason ?? abortSignalLink.signal.reason,
          );
          writeInterruption(mapStreamAbortReason(message), message);
          return true;
        }
        if (applicableRun && isTerminalRunStatus(applicableRun.status)) {
          adoptDurableTerminalState();
          return true;
        }
        if (
          recoveryInvalidated
          || !prepared.marker
          || !prepared.marker.checkpointId
          || prepared.marker.afterEstimatedInputTokens === undefined
          || !applicableRun
          || !applicableConversation
          || applicableConversation.activeHeadRunId !== started.run.id
          || applicableConversation.revision !== started.conversation.revision
          || prepared.plan.sourceHeadRunId !== started.run.id
          || prepared.plan.sourceConversationRevision !== applicableConversation.revision
          || overflowGate.permissionObserved
          || overflowGate.toolLifecycleObserved
          || overflowGate.sideEffectObserved
        ) {
          coordinatorState = "attempt0";
          writeFailure(error);
          return true;
        }
        if (!streamInput) {
          coordinatorState = "attempt0";
          writeFailure(error);
          return true;
        }
        latestContextUsage = persistContextUsageEstimate({
          store: this.deps.store,
          createId,
          started,
          plan: prepared.plan,
          providerId: request.providerId,
          modelId: request.modelId,
          createdAt: now(),
        });
        latestContextMarker = prepared.marker ?? latestContextMarker;
        pendingOverflowRecoveryPayload = {
          error: toRuntimeModelError(
            error,
            this.deps.getErrorMessageSecrets?.() ?? [],
          ),
          requestIndex,
          sourceHeadRunId: prepared.plan.sourceHeadRunId,
          sourceConversationRevision: prepared.plan.sourceConversationRevision,
          checkpointId: prepared.marker.checkpointId,
          beforeEstimatedInputTokens: prepared.marker.beforeEstimatedInputTokens,
          afterEstimatedInputTokens: prepared.marker.afterEstimatedInputTokens,
        };
        this.deps.store.appendTrace({
          id: createId("trace"),
          conversationId: started.conversation.id,
          runId: started.run.id,
          type: "context.overflow.retrying",
          level: "warn",
          time: now(),
          payload: pendingOverflowRecoveryPayload,
        });
        lastPreparedModelMessages = prepared.messages;
        const replacementInput: RuntimeStreamTextInput = {
          ...streamInput,
          instructions: combineRuntimeInstructions(
            policy.prompt.system,
            prepared.instructions,
          ),
          messages: prepared.messages,
          prompt: undefined,
          prepareStep: createManagedPrepareStep(
            failedSemanticStepIndex,
            requestIndex,
            prepared.messages,
            prepared.instructions,
            true,
          ),
          onStepEnd: createManagedOnStepEnd(
            failedSemanticStepIndex,
            requestIndex,
          ),
        };
        coordinatorState = "attempt1";
        try {
          retryResult = await this.streamTextImpl(bindStreamAttempt(replacementInput, 1));
        } catch (replacementError) {
          writeFailure(replacementError);
          retryResult = createFinalErrorResult(replacementError);
        }
        return true;
      };
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
      streamInput = {
        model: resolved.languageModel,
        instructions: combineRuntimeInstructions(
          policy.prompt.system,
          runtimeInstructions,
        ),
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
        prepareStep: this.deps.contextManager
          ? createManagedPrepareStep(
              previousStepCount,
              contextRequestIndexBase,
              messages,
              runtimeInstructions,
              initialPrepared !== undefined,
            )
          : undefined,
        onStepEnd: this.deps.contextManager
          ? createManagedOnStepEnd(previousStepCount, contextRequestIndexBase)
          : undefined,
        messageMetadata: this.deps.contextManager
          ? () => projectSafeContextMetadata(
              latestContextUsage,
              latestContextMarker,
            )
          : undefined,
        onModelOutput: () => {
          overflowGate.modelOutputObserved = true;
        },
        onChunk: ({ chunk }) => {
          if (
            (chunk.type === "text-delta" || chunk.type === "reasoning-delta")
            && chunk.text.length > 0
          ) {
            overflowGate.modelOutputObserved = true;
          }
          if (chunk.type === "source-url") overflowGate.modelOutputObserved = true;
          if (
            chunk.type === "tool-input-start"
            || chunk.type === "tool-input-delta"
            || chunk.type === "tool-input-end"
            || chunk.type === "tool-call"
            || chunk.type === "tool-result"
            || chunk.type === "tool-error"
          ) {
            overflowGate.toolLifecycleObserved = true;
          }
          if (
            chunk.type === "tool-approval-request"
            || chunk.type === "tool-approval-response"
            || chunk.type === "tool-output-denied"
          ) overflowGate.permissionObserved = true;
          switch (chunk.type) {
            case "text-start":
              startTextPart(
                chunk.id?.trim() || "__default_text__",
                chunk.id,
                chunk.providerMetadata,
              );
              break;
            case "text-delta":
              appendTextDelta(chunk);
              break;
            case "text-end": {
              const streamId = chunk.id?.trim() || "__default_text__";
              const part = textPartByStreamId.get(streamId);
              if (part) {
                updatePartProviderMetadata(part, chunk.providerMetadata);
              }
              textPartByStreamId.delete(streamId);
              break;
            }
            case "reasoning-start":
              startReasoningPart(
                chunk.id?.trim() || "__default_reasoning__",
                chunk.id,
                chunk.providerMetadata,
              );
              break;
            case "reasoning-delta":
              appendReasoningDelta(chunk);
              break;
            case "reasoning-end": {
              const streamId = chunk.id?.trim() || "__default_reasoning__";
              const part = reasoningPartByStreamId.get(streamId);
              if (part) {
                updatePartProviderMetadata(part, chunk.providerMetadata);
              }
              reasoningPartByStreamId.delete(streamId);
              break;
            }
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
                providerMetadata: chunk.providerMetadata,
              });
              break;
            case "tool-input-delta": {
              const streamedInput = streamedToolInputByAiSdkId.get(chunk.toolCallId);
              if (streamedInput) {
                streamedInput.raw += chunk.delta;
              }
              const toolPart = toolPartByAiSdkId.get(chunk.toolCallId);
              if (toolPart) {
                updatePartProviderMetadata(toolPart, chunk.providerMetadata);
              }
              break;
            }
            case "tool-input-end": {
              const toolPart = toolPartByAiSdkId.get(chunk.toolCallId);
              if (toolPart) {
                updatePartProviderMetadata(toolPart, chunk.providerMetadata);
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
                providerMetadata: chunk.providerMetadata,
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
              updatePartProviderMetadata(toolPart, chunk.providerMetadata);

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
              markToolScopedStreamError(chunk.error);
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
              updatePartProviderMetadata(toolPart, chunk.providerMetadata);
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
                  providerMetadata: chunk.providerMetadata,
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
                providerMetadata: chunk.providerMetadata,
              });
              if (toolPart.state.status === "error") {
                break;
              }
              toolPart.metadata = {
                ...(toolPart.metadata ?? {}),
                aiSdkToolCallId: chunk.toolCallId,
                aiSdkApprovalId: chunk.approvalId,
                ...(chunk.providerMetadata
                  ? { providerMetadata: structuredClone(chunk.providerMetadata) }
                  : {}),
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
                providerMetadata: chunk.providerMetadata,
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
              if (
                previousStepCount + streamedStepCount
                  === overflowRequestBaseline.semanticStepIndex
              ) {
                activateContextOverflowRequest();
              }
              semanticParts.push({
                id: createId("part"),
                conversationId: started.conversation.id,
                messageId: started.assistantMessage.id,
                type: "step-start",
                stepIndex: previousStepCount + streamedStepCount,
                time: { created: now() },
              });
              streamedStepCount += 1;
              resetActiveStreamParts();
              break;
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
          // AI SDK also emits the original error through fullStream. Keep that
          // path authoritative so a safe overflow can replace this attempt and
          // a final failure retains the exact Provider/SDK error object.
          if (finishReason === "error") {
            return;
          }

          terminalWritten = true;
          coordinatorState = "terminal";
          cleanupActiveRun();
          const completedAt = now();
          const semanticParts = createSemanticParts(completedAt);
          const usage = addTokenUsage(
            previousUsage,
            mapAiSdkUsage(totalUsage),
          );
          markOverflowRecoverySucceeded();
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
          const completed = runner.completeText(started, finalText, {
            finish: mapAiSdkFinishReason(finishReason),
            usage,
            parts: semanticParts,
            appendTextPart: !semanticParts.some((part) => part.type === "text"),
          });
          if (
            latestContextUsage
            && this.deps.contextManager?.forecastNextTurn
          ) {
            const forecast = this.deps.contextManager.forecastNextTurn({
              conversationId: completed.conversation.id,
              runId: completed.run.id,
              requestIndex: latestContextUsage.requestIndex + 1,
              providerId: request.providerId,
              modelId: request.modelId,
              contextWindow: resolved.runtimeContext.provider.contextLength,
              modelOutputLimit: resolved.runtimeContext.provider.outputLength,
              reservedOutputTokens:
                policy.limits.maxOutputTokens
                ?? resolved.runtimeContext.provider.outputLength
                ?? 0,
              systemPrompt: policy.prompt.system,
              toolSchemas: policy.toolResolution.snapshot,
              policy: DEFAULT_CONTEXT_COMPACTION_POLICY,
              reason: resolveNextTurnForecastReason(),
            });
            latestContextUsage = this.deps.store.updateContextUsageNextTurnForecast({
              runId: completed.run.id,
              requestIndex: latestContextUsage.requestIndex,
              nextTurnForecast: forecast,
            });
          }
        },
        onError: ({ error }) => {
          const recovery = retryContextOverflow(error).then((recovered) => {
            if (!recovered) writeFailure(error);
          });
          pendingOverflowRecovery = recovery;
          return recovery;
        },
        onAbort: ({ reason }) => {
          writeInterruption(mapStreamAbortReason(reason), reason ?? "stream aborted");
        },
        onToolCallStart: (event) => {
          overflowGate.toolLifecycleObserved = true;
          overflowGate.sideEffectObserved = true;
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
            providerMetadata: event.toolCall.providerMetadata,
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
          overflowGate.toolLifecycleObserved = true;
          overflowGate.sideEffectObserved = true;
          const completedAt = now();
          const input = toRecord(event.toolCall.input);
          if (!event.success) {
            markToolScopedStreamError(event.error);
          }
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
          updatePartProviderMetadata(toolPart, event.toolCall.providerMetadata);

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
          if (isPartCoveredBySealedStep(semanticParts, toolPart.id)) {
            persistSealedAssistantPrefix({
              store: this.deps.store,
              createId,
              started,
              parts: semanticParts,
              completedAt,
            });
          }
        },
      };
      result = await this.streamTextImpl(bindStreamAttempt(streamInput, 0));
      await result.responseReady;
    } catch (error) {
      if (abortSignalLink.signal.aborted) {
        const message = abortReasonMessage(abortSignalLink.signal.reason);
        writeInterruption(mapStreamAbortReason(message), message);
      } else {
        writeFailure(error);
      }
      return {
        started,
        response: withRuntimeHeaders(withContextCompactionActivityUpdates(
          createUIMessageStreamResponse({
            stream: createUIMessageStream({
              execute: ({ writer }) => {
                writer.write({
                  type: "start",
                  messageId: started.assistantMessage.id,
                  messageMetadata: projectSafeContextMetadata(
                    latestContextUsage,
                    latestContextMarker,
                  ),
                });
                writer.write({
                  type: "error",
                  errorText: modelErrorMessage(
                    error,
                    this.deps.getErrorMessageSecrets?.() ?? [],
                  ),
                });
              },
              generateId: () => started.assistantMessage.id,
              onError: (streamError) => modelErrorMessage(
                streamError,
                this.deps.getErrorMessageSecrets?.() ?? [],
              ),
            }),
          }),
          {
            store: this.deps.store,
            runId: started.run.id,
            baseSemanticStepIndex: previousStepCount,
          },
        ), started),
      };
    }

    const responseResult = retryResult ?? result;
    committedAttempt = retryResult ? 1 : 0;
    if (!terminalWritten) coordinatorState = "committed";
    const createUiResponseOptions = (
      streamResult: RuntimeStreamTextResult,
    ): RuntimeUIMessageStreamResponseOptions => ({
      consumeSseStream: consumeStream,
      generateMessageId: () => started.assistantMessage.id,
      onError: (streamError) => {
        // The production adapter exposes responseReady only when it also owns
        // a full-stream consumer. That consumer is authoritative for Provider
        // failures and overflow recovery; eagerly failing here would race it.
        // Custom/UI-only adapters have no such consumer and retain this path as
        // their durable failure fallback.
        if (!isToolScopedStreamError(streamError)) {
          if (streamResult === result && streamResult.responseReady) {
            pendingPrimaryUiStreamError = streamError;
          } else {
            writeFailure(streamError);
          }
        }
        return modelErrorMessage(
          streamError,
          this.deps.getErrorMessageSecrets?.() ?? [],
        );
      },
      messageMetadata: () => projectSafeContextMetadata(
        latestContextUsage,
        latestContextMarker,
      ),
    });
    const response = responseResult.toUIMessageStreamResponse(
      createUiResponseOptions(responseResult),
    );
    const responseWithLateRecovery = responseResult === result
      ? withLateContextOverflowReplacement(
          response,
          async () => {
            await pendingOverflowRecovery;
            const replacement = retryResult;
            if (!replacement && pendingPrimaryUiStreamError && !terminalWritten) {
              writeFailure(pendingPrimaryUiStreamError);
            }
            return replacement?.toUIMessageStreamResponse(
              createUiResponseOptions(replacement),
            ) ?? null;
          },
        )
      : response;
    const responseWithLiveCompactionActivities = withContextCompactionActivityUpdates(
      responseWithLateRecovery,
      {
        store: this.deps.store,
        runId: started.run.id,
        baseSemanticStepIndex: previousStepCount,
      },
    );
    return {
      started,
      response: withRuntimeHeaders(
        responseWithLiveCompactionActivities,
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

function finalizeSemanticToolPartsForFailure(
  parts: Part[],
  completedAt: number,
  message: string,
): void {
  for (const part of parts) {
    if (
      part.type !== "tool" ||
      part.state.status === "completed" ||
      part.state.status === "error" ||
      part.state.status === "interrupted"
    ) {
      continue;
    }
    const input = "input" in part.state ? (part.state.input ?? {}) : {};
    const startedAt = part.time && "start" in part.time
      ? part.time.start
      : completedAt;
    part.state = {
      status: "error",
      input,
      error: {
        code: "INTERNAL_ERROR",
        message,
        retryable: false,
      },
      time: { start: startedAt, end: completedAt },
    };
    part.time = { start: startedAt, end: completedAt };
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

function persistContextUsageEstimate(input: {
  store: RuntimeRunnerStore;
  createId: <TPrefix extends RuntimeIdPrefix>(prefix: TPrefix) => RuntimeId<TPrefix>;
  started: RuntimeRunStarted;
  plan: ContextPlan;
  providerId: string;
  modelId: string;
  createdAt: number;
}): ContextUsage {
  const budget = input.plan.budget;
  const expected: ContextUsageEstimateIdentity = {
    conversationId: input.started.conversation.id,
    runId: input.started.run.id,
    requestIndex: input.plan.requestIndex,
    providerId: input.providerId,
    modelId: input.modelId,
    ...(budget.contextWindow ? { contextWindow: budget.contextWindow } : {}),
    estimatedInputTokens: budget.estimatedInputTokens,
    estimateSource: "estimate",
    reservedOutputTokens: budget.reservedOutputTokens,
    view: input.plan.view,
    ...(input.plan.checkpointId ? { checkpointId: input.plan.checkpointId } : {}),
    breakdown: {
      rawTokens: budget.rawHistoryTokens,
      checkpointTokens: budget.checkpointTokens,
      safetyStateTokens: budget.safetyStateTokens,
      systemPromptTokens: budget.systemPromptTokens,
      toolSchemaTokens: budget.toolSchemaTokens,
    },
    estimatorVersion: DEFAULT_CONTEXT_COMPACTION_POLICY.estimatorVersion,
    policyVersion: DEFAULT_CONTEXT_COMPACTION_POLICY.version,
    checkpointFormatVersion:
      DEFAULT_CONTEXT_COMPACTION_POLICY.checkpointFormatVersion,
  };
  const existing = input.store.getContextUsageByRunRequest(
    input.started.run.id,
    input.plan.requestIndex,
  );
  if (existing) {
    assertContextUsageEstimateMatches(existing, expected);
    return existing;
  }
  const usage: ContextUsage = {
    id: input.createId("ctxuse"),
    ...expected,
    time: { created: input.createdAt },
  };
  try {
    input.store.saveContextUsage(usage);
    return usage;
  } catch (error) {
    if (!isContextUsageRequestUniqueConstraint(error)) throw error;
    const raced = input.store.getContextUsageByRunRequest(
      input.started.run.id,
      input.plan.requestIndex,
    );
    if (!raced) throw error;
    assertContextUsageEstimateMatches(raced, expected);
    return raced;
  }
}

function persistSealedAssistantPrefix(input: {
  store: RuntimeRunnerStore;
  createId: <TPrefix extends RuntimeIdPrefix>(prefix: TPrefix) => RuntimeId<TPrefix>;
  started: RuntimeRunStarted;
  parts: readonly Part[];
  completedAt: number;
}): void {
  const currentRun = input.store.getRun(input.started.run.id);
  const currentMessage = input.store.getMessage(input.started.assistantMessage.id);
  if (
    !currentRun
    || currentRun.status !== "running"
    || !currentMessage
    || currentMessage.role !== "assistant"
  ) {
    return;
  }
  const assistantMessage: AssistantMessage = {
    ...currentMessage,
    parts: structuredClone([...input.parts]),
  };
  const run: Run = {
    ...currentRun,
    output: {
      messageId: assistantMessage.id,
      partIds: assistantMessage.parts.map((part) => part.id),
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
}

function isPartCoveredBySealedStep(parts: readonly Part[], partId: Part["id"]): boolean {
  const partIndex = parts.findIndex((part) => part.id === partId);
  return partIndex >= 0
    && parts.slice(partIndex + 1).some((part) => part.type === "step-finish");
}

// A racing writer may allocate a different record ID/time, and a Provider
// observation may land before the re-read. Every request-scoped estimate field
// remains immutable and must agree exactly.
type ContextUsageEstimateIdentity = Omit<
  ContextUsage,
  "id" | "providerObservation" | "time"
>;

function assertContextUsageEstimateMatches(
  actual: ContextUsage,
  expected: ContextUsageEstimateIdentity,
): void {
  const actualEstimate: ContextUsageEstimateIdentity = {
    conversationId: actual.conversationId,
    runId: actual.runId,
    requestIndex: actual.requestIndex,
    providerId: actual.providerId,
    modelId: actual.modelId,
    ...(actual.contextWindow === undefined
      ? {}
      : { contextWindow: actual.contextWindow }),
    estimatedInputTokens: actual.estimatedInputTokens,
    estimateSource: actual.estimateSource,
    reservedOutputTokens: actual.reservedOutputTokens,
    view: actual.view,
    ...(actual.checkpointId === undefined
      ? {}
      : { checkpointId: actual.checkpointId }),
    breakdown: actual.breakdown,
    estimatorVersion: actual.estimatorVersion,
    policyVersion: actual.policyVersion,
    checkpointFormatVersion: actual.checkpointFormatVersion,
  };
  if (stableStringifyJson(actualEstimate) !== stableStringifyJson(expected)) {
    throw new Error("Context usage estimate conflicts with the durable request row");
  }
}

function isContextUsageRequestUniqueConstraint(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "SQLITE_CONSTRAINT_UNIQUE"
    && "message" in error
    && typeof error.message === "string"
    && error.message.includes(
      "UNIQUE constraint failed: runtime_context_usage.run_id, runtime_context_usage.request_index",
    );
}

function toContextProviderObservation(
  usage: LanguageModelUsage | undefined,
): NonNullable<ContextUsage["providerObservation"]> | undefined {
  if (
    typeof usage?.inputTokens !== "number"
    || !Number.isSafeInteger(usage.inputTokens)
    || usage.inputTokens < 0
  ) {
    return undefined;
  }
  const cacheReadTokens = usage.inputTokenDetails.cacheReadTokens;
  const cacheWriteTokens = usage.inputTokenDetails.cacheWriteTokens;
  return {
    source: "provider",
    inputTokens: usage.inputTokens,
    ...(typeof cacheReadTokens === "number"
      && Number.isSafeInteger(cacheReadTokens)
      && cacheReadTokens >= 0
      ? { cacheReadTokens }
      : {}),
    ...(typeof cacheWriteTokens === "number"
      && Number.isSafeInteger(cacheWriteTokens)
      && cacheWriteTokens >= 0
      ? { cacheWriteTokens }
      : {}),
  };
}

function projectSafeContextMetadata(
  usage: ContextUsage | undefined,
  marker: ContextCompactionMarker | undefined,
): Record<string, unknown> | undefined {
  if (!usage && !marker) return undefined;
  const nexus: Record<string, unknown> = {};
  if (usage) {
    const providerInputTokens = usage.providerObservation?.inputTokens;
    const forecast = usage.nextTurnForecast;
    const contextWindow = forecast?.contextWindow ?? usage.contextWindow;
    const checkpointId = forecast?.checkpointId ?? usage.checkpointId;
    nexus.contextUsage = {
      ...(contextWindow ? { contextWindow } : {}),
      estimatedInputTokens: forecast?.estimatedInputTokens ?? usage.estimatedInputTokens,
      ...(providerInputTokens === undefined ? {} : { providerInputTokens }),
      reservedOutputTokens: usage.reservedOutputTokens,
      activeTokens: forecast?.estimatedInputTokens ?? usage.estimatedInputTokens,
      source: "estimate",
      view: forecast?.view ?? usage.view,
      ...(checkpointId ? { checkpointId } : {}),
      ...(forecast ? { forecastReason: forecast.reason } : {}),
    };
  }
  if (marker) {
    nexus.compaction = {
      trigger: marker.trigger,
      createdAt: marker.time.created,
      ...(marker.coverageThroughRunId === undefined
        ? {}
        : { coverageThroughRunId: marker.coverageThroughRunId }),
      beforeTokens: marker.beforeEstimatedInputTokens,
      ...(marker.afterEstimatedInputTokens === undefined
        ? {}
        : { afterTokens: marker.afterEstimatedInputTokens }),
      status: marker.status,
    };
  }
  return { nexus, custom: { nexus } };
}

function readLatestCompactionLifecycleMarker(
  traces: readonly TraceEvent[],
): ContextCompactionMarker | undefined {
  const trace = traces.findLast((candidate) =>
    (candidate.type === "context.compaction.preparing"
      || candidate.type === "context.compaction.failed")
    && isContextCompactionTrigger(candidate.payload.trigger)
    && typeof candidate.payload.beforeEstimatedInputTokens === "number"
    && Number.isSafeInteger(candidate.payload.beforeEstimatedInputTokens)
    && candidate.payload.beforeEstimatedInputTokens >= 0
  );
  if (!trace) return undefined;
  return {
    trigger: trace.payload.trigger as ContextCompactionMarker["trigger"],
    auto: trace.payload.trigger !== "manual",
    beforeEstimatedInputTokens: trace.payload.beforeEstimatedInputTokens as number,
    status: trace.type === "context.compaction.failed" ? "failed" : "preparing",
    time: { created: trace.time },
  };
}

function isContextCompactionTrigger(
  value: unknown,
): value is ContextCompactionMarker["trigger"] {
  return value === "auto_pre_turn"
    || value === "auto_mid_turn"
    || value === "manual"
    || value === "provider_overflow"
    || value === "model_switch";
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
    .listActiveLineageMessages(input.started.conversation.id)
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
  assertNoSystemModelMessages(input.messages);
  const activeTools = input.activeTools?.length ? (input.activeTools as never) : undefined;
  let callbackFailure: { error: unknown } | undefined;
  const recordCallbackFailure = (error: unknown): void => {
    callbackFailure ??= { error };
  };
  const throwIfCallbackFailed = (): void => {
    if (callbackFailure) throw callbackFailure.error;
  };
  const onEnd: GenerateTextOnEndCallback<ToolSet> | undefined =
    input.onFinish || input.onError
    ? async (event) => {
        if (callbackFailure) {
          await input.onError?.({ error: callbackFailure.error });
          return;
        }
        await input.onFinish?.({
          finishReason: event.finishReason,
          totalUsage: event.totalUsage,
          responseMessages: event.responseMessages,
          stepCount: event.steps.length,
        });
      }
    : undefined;
  const prompt = input.messages && input.messages.length > 0
    ? { messages: input.messages }
    : { prompt: input.prompt ?? "" };

  const agent = new ToolLoopAgent({
    model: input.model,
    instructions: input.instructions,
    tools: input.tools,
    activeTools,
    stopWhen: isStepCount(input.maxSteps ?? 1),
    maxOutputTokens: input.maxOutputTokens,
    temperature: input.temperature,
    topP: input.topP,
    toolChoice: input.toolChoice,
    toolApproval: input.toolApproval,
    prepareStep: input.prepareStep || input.onStepEnd
      ? async (event) => {
          throwIfCallbackFailed();
          const prepared = await input.prepareStep?.({
            stepNumber: event.stepNumber,
            messages: event.messages,
          });
          assertNoSystemModelMessages(prepared?.messages);
          return prepared ?? {};
        }
      : undefined,
  });
  const result = await agent.stream({
    ...prompt,
    abortSignal: input.abortSignal,
    timeout: input.timeout,
    onEnd,
    onStepEnd: input.onStepEnd
      ? async (event) => {
          try {
            await input.onStepEnd?.({
              stepNumber: event.stepNumber,
              usage: event.usage,
              finishReason: event.finishReason,
            });
          } catch (error) {
            recordCallbackFailure(error);
          }
        }
      : undefined,
    onToolExecutionStart: input.onToolCallStart
      ? (event) => input.onToolCallStart?.({
          toolCall: {
            toolCallId: event.toolCall.toolCallId,
            toolName: event.toolCall.toolName,
            input: event.toolCall.input,
            title: event.toolCall.title,
            providerMetadata: event.toolCall.providerMetadata,
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
              providerMetadata: event.toolCall.providerMetadata,
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
  let markResponseReady!: () => void;
  const responseReady = new Promise<void>((resolve) => {
    markResponseReady = resolve;
  });
  const runtimeFactsSettled = input.onChunk
    ? consumeRuntimeFullStream(
      result.fullStream,
      input.onChunk,
      input.onModelOutput,
      input.onError,
      input.onAbort,
      markResponseReady,
    )
    : Promise.resolve().then(markResponseReady);

  return {
    responseReady,
    toUIMessageStreamResponse: (options) => withRuntimeFactsBarrier(
      result.toUIMessageStreamResponse({
        ...options,
        messageMetadata: input.messageMetadata
          ? ({ part }) =>
              part.type === "start" || part.type === "finish"
                ? input.messageMetadata?.()
                : undefined
          : undefined,
      }),
      runtimeFactsSettled,
      () => callbackFailure,
      input.messageMetadata,
    ),
  };
};

function combineRuntimeInstructions(
  primary: string,
  boundaries: PreparedModelContext["instructions"] | undefined,
): Instructions {
  if (!boundaries?.length) return primary;
  return [
    { role: "system", content: primary },
    ...boundaries,
  ];
}

function assertNoSystemModelMessages(
  messages: readonly ModelMessage[] | undefined,
): void {
  if (messages?.some((message) => message.role === "system")) {
    throw new Error(
      "Runtime stream messages must not contain system instructions",
    );
  }
}

function withRuntimeFactsBarrier(
  response: Response,
  runtimeFactsSettled: PromiseLike<void>,
  getCallbackFailure?: () => { error: unknown } | undefined,
  getFinalMessageMetadata?: () => Record<string, unknown> | undefined,
): Response {
  if (!response.body) {
    return response;
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const pendingFinalBlocks: Array<{ block: string; separator: string }> = [];
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      while (true) {
        const separatorMatch = /\r?\n\r?\n/.exec(buffer);
        if (!separatorMatch || separatorMatch.index === undefined) break;
        const block = buffer.slice(0, separatorMatch.index);
        const separator = separatorMatch[0];
        buffer = buffer.slice(separatorMatch.index + separator.length);
        if (pendingFinalBlocks.length > 0 || isUiFinishSseBlock(block)) {
          pendingFinalBlocks.push({ block, separator });
        } else {
          controller.enqueue(encoder.encode(block + separator));
        }
      }
    },
    async flush(controller) {
      buffer += decoder.decode();
      if (buffer.length > 0) {
        if (pendingFinalBlocks.length > 0 || isUiFinishSseBlock(buffer)) {
          pendingFinalBlocks.push({ block: buffer, separator: "" });
        } else {
          controller.enqueue(encoder.encode(buffer));
        }
      }
      await runtimeFactsSettled;
      const failure = getCallbackFailure?.();
      if (failure) throw failure.error;
      const finalMetadata = getFinalMessageMetadata?.();
      for (const pending of pendingFinalBlocks) {
        controller.enqueue(encoder.encode(
          replaceUiFinishSseMetadata(pending.block, finalMetadata) + pending.separator,
        ));
      }
    },
  }));
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

interface BufferedSseBlock {
  block: string;
  separator: string;
}

/**
 * Keeps an already-published ToolLoop prefix while allowing a context-overflow
 * replacement, which is created after the primary response has been returned,
 * to continue the same UI message stream.
 *
 * The primary stream is forwarded without buffering until its top-level error
 * block. The inner runtime-facts barrier keeps that terminal tail open until
 * the full-stream callbacks (including overflow recovery) have settled. At
 * that point we either release the original Provider error verbatim or replace
 * only the failed request's terminal tail with the replacement stream.
 */
function withLateContextOverflowReplacement(
  response: Response,
  getReplacementResponse: () => Response | null | Promise<Response | null>,
): Response {
  if (!response.body) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let openStep = false;
  let holdingTerminalTail = false;
  const heldBlocks: BufferedSseBlock[] = [];

  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      drainSseBlocks(buffer, (pending, remaining) => {
        buffer = remaining;
        const payload = readSseJsonPayload(pending.block);
        if (holdingTerminalTail || payload?.type === "error") {
          holdingTerminalTail = true;
          heldBlocks.push(pending);
          return;
        }
        updateOpenUiStep(payload, (next) => {
          openStep = next;
        }, openStep);
        controller.enqueue(encoder.encode(pending.block + pending.separator));
      });
    },
    async flush(controller) {
      buffer += decoder.decode();
      if (buffer.length > 0) {
        const pending = { block: buffer, separator: "" };
        const payload = readSseJsonPayload(pending.block);
        if (holdingTerminalTail || payload?.type === "error") {
          holdingTerminalTail = true;
          heldBlocks.push(pending);
        } else {
          updateOpenUiStep(payload, (next) => {
            openStep = next;
          }, openStep);
          controller.enqueue(encoder.encode(pending.block));
        }
      }

      if (!holdingTerminalTail) return;
      const replacement = await getReplacementResponse();
      if (!replacement) {
        for (const pending of heldBlocks) {
          controller.enqueue(encoder.encode(pending.block + pending.separator));
        }
        return;
      }

      await pipeReplacementUiStream({
        response: replacement,
        controller,
        encoder,
        skipFirstStepStart: openStep,
      });
    },
  }));

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function withContextCompactionActivityUpdates(
  response: Response,
  input: {
    store: Pick<RuntimeRunnerStore, "listContextCompactionActivitiesByRun">;
    runId: Run["id"];
    baseSemanticStepIndex: number;
  },
): Response {
  if (!response.body) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const sentActivityFingerprints = new Map<string, string>();
  let buffer = "";
  let currentBoundaryStepIndex = input.baseSemanticStepIndex;
  let hasStartedStep = false;

  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      drainSseBlocks(buffer, (pending, remaining) => {
        buffer = remaining;
        const payload = readSseJsonPayload(pending.block);
        rememberIncomingCompactionActivity(payload, sentActivityFingerprints);

        if (payload?.type === "start") {
          controller.enqueue(encoder.encode(pending.block + pending.separator));
          enqueueContextCompactionActivities({
            ...input,
            controller,
            encoder,
            sentActivityFingerprints,
            throughBoundaryStepIndex: currentBoundaryStepIndex,
          });
          return;
        }

        if (payload?.type === "start-step") {
          if (hasStartedStep) currentBoundaryStepIndex += 1;
          hasStartedStep = true;
        }

        if (shouldRefreshContextCompactionActivities(payload, pending.block)) {
          enqueueContextCompactionActivities({
            ...input,
            controller,
            encoder,
            sentActivityFingerprints,
            throughBoundaryStepIndex:
              payload?.type === "finish" || payload?.type === "error"
                || isUiDoneSseBlock(pending.block)
                ? Number.POSITIVE_INFINITY
                : currentBoundaryStepIndex,
          });
        }
        controller.enqueue(encoder.encode(pending.block + pending.separator));
      });
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.length > 0) {
        const payload = readSseJsonPayload(buffer);
        rememberIncomingCompactionActivity(payload, sentActivityFingerprints);
        enqueueContextCompactionActivities({
          ...input,
          controller,
          encoder,
          sentActivityFingerprints,
          throughBoundaryStepIndex: Number.POSITIVE_INFINITY,
        });
        controller.enqueue(encoder.encode(buffer));
      } else {
        enqueueContextCompactionActivities({
          ...input,
          controller,
          encoder,
          sentActivityFingerprints,
          throughBoundaryStepIndex: Number.POSITIVE_INFINITY,
        });
      }
    },
  }));

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function enqueueContextCompactionActivities(input: {
  store: Pick<RuntimeRunnerStore, "listContextCompactionActivitiesByRun">;
  runId: Run["id"];
  baseSemanticStepIndex: number;
  throughBoundaryStepIndex: number;
  controller: TransformStreamDefaultController<Uint8Array>;
  encoder: TextEncoder;
  sentActivityFingerprints: Map<string, string>;
}): void {
  const activities = input.store.listContextCompactionActivitiesByRun(input.runId)
    .filter((activity) => {
      const boundaryStepIndex = activity.boundaryStepIndex ?? activity.requestIndex;
      return boundaryStepIndex >= input.baseSemanticStepIndex
        && boundaryStepIndex <= input.throughBoundaryStepIndex;
    })
    .sort((left, right) =>
      (left.boundaryStepIndex ?? left.requestIndex)
        - (right.boundaryStepIndex ?? right.requestIndex)
      || left.requestIndex - right.requestIndex
      || left.attemptIndex - right.attemptIndex
      || left.startedAt - right.startedAt
      || left.id.localeCompare(right.id)
    );

  for (const activity of activities) {
    const part = projectContextCompactionActivityToAiSdkDataPart(activity);
    const fingerprint = stableStringifyJson(part.data);
    if (input.sentActivityFingerprints.get(part.id) === fingerprint) continue;
    input.sentActivityFingerprints.set(part.id, fingerprint);
    input.controller.enqueue(input.encoder.encode(
      `data: ${JSON.stringify(part)}\n\n`,
    ));
  }
}

function rememberIncomingCompactionActivity(
  payload: Record<string, unknown> | null,
  sentActivityFingerprints: Map<string, string>,
): void {
  if (
    payload?.type !== "data-context-compaction"
    || typeof payload.id !== "string"
    || !isRecord(payload.data)
  ) return;
  sentActivityFingerprints.set(payload.id, stableStringifyJson(payload.data));
}

function shouldRefreshContextCompactionActivities(
  payload: Record<string, unknown> | null,
  block: string,
): boolean {
  if (isUiDoneSseBlock(block)) return true;
  return payload?.type !== "text-delta"
    && payload?.type !== "reasoning-delta"
    && payload?.type !== "tool-input-delta";
}

function isUiDoneSseBlock(block: string): boolean {
  return block.split(/\r?\n/).some((line) => line.trim() === "data: [DONE]");
}

function drainSseBlocks(
  value: string,
  consume: (block: BufferedSseBlock, remaining: string) => void,
): void {
  let remaining = value;
  while (true) {
    const separatorMatch = /\r?\n\r?\n/.exec(remaining);
    if (!separatorMatch || separatorMatch.index === undefined) return;
    const block = remaining.slice(0, separatorMatch.index);
    const separator = separatorMatch[0];
    remaining = remaining.slice(separatorMatch.index + separator.length);
    consume({ block, separator }, remaining);
  }
}

function updateOpenUiStep(
  payload: Record<string, unknown> | null,
  setOpenStep: (open: boolean) => void,
  current: boolean,
): void {
  if (payload?.type === "start-step") {
    setOpenStep(true);
  } else if (payload?.type === "finish-step") {
    setOpenStep(false);
  } else {
    setOpenStep(current);
  }
}

async function pipeReplacementUiStream(input: {
  response: Response;
  controller: TransformStreamDefaultController<Uint8Array>;
  encoder: TextEncoder;
  skipFirstStepStart: boolean;
}): Promise<void> {
  if (!input.response.body) return;

  const decoder = new TextDecoder();
  const reader = input.response.body.getReader();
  let buffer = "";
  let skippedMessageStart = false;
  let shouldSkipStepStart = input.skipFirstStepStart;

  const forward = (pending: BufferedSseBlock): void => {
    const payload = readSseJsonPayload(pending.block);
    if (!skippedMessageStart && payload?.type === "start") {
      skippedMessageStart = true;
      return;
    }
    if (shouldSkipStepStart && payload?.type === "start-step") {
      shouldSkipStepStart = false;
      return;
    }
    input.controller.enqueue(input.encoder.encode(pending.block + pending.separator));
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      drainSseBlocks(buffer, (pending, remaining) => {
        buffer = remaining;
        forward(pending);
      });
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      forward({ block: buffer, separator: "" });
    }
  } finally {
    reader.releaseLock();
  }
}

function isUiFinishSseBlock(block: string): boolean {
  return readSseJsonPayload(block)?.type === "finish";
}

function replaceUiFinishSseMetadata(
  block: string,
  metadata: Record<string, unknown> | undefined,
): string {
  if (!metadata) return block;
  const lines = block.split(/\r?\n/);
  const dataIndex = lines.findIndex((line) => line.startsWith("data:"));
  if (dataIndex < 0) return block;
  const payload = readSseJsonPayload(block);
  if (!payload || payload.type !== "finish") return block;
  lines[dataIndex] = `data: ${JSON.stringify({ ...payload, messageMetadata: metadata })}`;
  return lines.join(block.includes("\r\n") ? "\r\n" : "\n");
}

function readSseJsonPayload(block: string): Record<string, unknown> | null {
  const dataLine = block.split(/\r?\n/).find((line) => line.startsWith("data:"));
  if (!dataLine) return null;
  const raw = dataLine.slice("data:".length).trim();
  if (!raw || raw === "[DONE]") return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

async function consumeRuntimeFullStream(
  stream: AsyncIterable<TextStreamPart<ToolSet>>,
  onChunk: NonNullable<RuntimeStreamTextInput["onChunk"]>,
  onModelOutput?: RuntimeStreamTextInput["onModelOutput"],
  onError?: RuntimeStreamTextInput["onError"],
  onAbort?: RuntimeStreamTextInput["onAbort"],
  onResponseReady?: () => void,
): Promise<void> {
  try {
    for await (const part of stream) {
      const semanticModelOutput = isSemanticModelOutputPart(part);
      if (semanticModelOutput) {
        await onModelOutput?.();
      }
      if (part.type === "error") {
        await onError?.({ error: part.error });
        onResponseReady?.();
        continue;
      }
      if (part.type === "abort") {
        await onAbort?.({ reason: part.reason ?? "stream aborted" });
        onResponseReady?.();
        continue;
      }
      const chunk = toRuntimeTextChunk(part);
      if (chunk) {
        await onChunk({ chunk });
        if (semanticModelOutput || isPublishableRuntimeChunk(chunk)) onResponseReady?.();
      } else if (semanticModelOutput) {
        onResponseReady?.();
      }
      if (part.type === "finish") onResponseReady?.();
    }
  } catch (error) {
    await onError?.({ error });
  } finally {
    onResponseReady?.();
  }
}

function isSemanticModelOutputPart(part: TextStreamPart<ToolSet>): boolean {
  switch (part.type) {
    case "text-delta":
    case "reasoning-delta":
      return part.text.length > 0;
    case "source":
    case "file":
    case "reasoning-file":
    case "custom":
      return true;
    case "start":
    case "start-step":
    case "text-start":
    case "text-end":
    case "reasoning-start":
    case "reasoning-end":
    case "tool-input-start":
    case "tool-input-delta":
    case "tool-input-end":
    case "tool-call":
    case "tool-result":
    case "tool-error":
    case "tool-output-denied":
    case "tool-approval-request":
    case "tool-approval-response":
    case "finish-step":
    case "finish":
    case "abort":
    case "error":
    case "raw":
      return false;
  }
}

function isPublishableRuntimeChunk(chunk: RuntimeTextChunk): boolean {
  if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
    return chunk.text.length > 0;
  }
  return chunk.type !== "text-start"
    && chunk.type !== "text-end"
    && chunk.type !== "reasoning-start"
    && chunk.type !== "reasoning-end"
    && chunk.type !== "start-step"
    && chunk.type !== "finish-step";
}

function createContextOverflowRequestBaseline(input: {
  requestIndex: number;
  semanticStepIndex: number;
  finalText: string;
  semanticPartCount: number;
  streamedStepCount: number;
  toolCalls: readonly ToolCall[];
  permissions: readonly Permission[];
}): ContextOverflowRequestBaseline {
  return {
    requestIndex: input.requestIndex,
    semanticStepIndex: input.semanticStepIndex,
    finalText: input.finalText,
    semanticPartCount: input.semanticPartCount,
    streamedStepCount: input.streamedStepCount,
    openToolLifecycle: hasOpenToolLifecycle(input.toolCalls),
    pendingPermission: input.permissions.some((permission) =>
      permission.status === "pending"
    ),
    toolFactsHash: contextOverflowToolFactsHash(input.toolCalls),
    permissionFactsHash: contextOverflowPermissionFactsHash(input.permissions),
    sideEffectFactsHash: contextOverflowSideEffectFactsHash(input.toolCalls),
  };
}

function nextContextRequestIndex(
  store: Pick<RuntimeRunnerStore, "listContextPlansByRun" | "listContextUsagesByRun">,
  runId: Run["id"],
  semanticStepCount: number,
): number {
  let nextRequestIndex = semanticStepCount;
  for (const plan of store.listContextPlansByRun(runId)) {
    nextRequestIndex = Math.max(nextRequestIndex, plan.requestIndex + 1);
  }
  for (const usage of store.listContextUsagesByRun(runId)) {
    nextRequestIndex = Math.max(nextRequestIndex, usage.requestIndex + 1);
  }
  return nextRequestIndex;
}

function contextOverflowToolFactsHash(toolCalls: readonly ToolCall[]): string {
  return stableStringifyJson([...toolCalls].sort(compareRuntimeFactIds));
}

function contextOverflowPermissionFactsHash(permissions: readonly Permission[]): string {
  return stableStringifyJson([...permissions].sort(compareRuntimeFactIds));
}

function contextOverflowSideEffectFactsHash(toolCalls: readonly ToolCall[]): string {
  return stableStringifyJson(
    [...toolCalls].filter(isDurableSideEffectFact).sort(compareRuntimeFactIds),
  );
}

function compareRuntimeFactIds(
  left: { id: string },
  right: { id: string },
): number {
  return left.id.localeCompare(right.id);
}

function hasOpenToolLifecycle(toolCalls: readonly ToolCall[]): boolean {
  return toolCalls.some((toolCall) =>
    toolCall.state !== "completed"
    && toolCall.state !== "error"
    && toolCall.state !== "interrupted"
  );
}

function isDurableSideEffectFact(toolCall: ToolCall): boolean {
  return (
    toolCall.time.started !== undefined
    || toolCall.state === "running"
    || toolCall.state === "completed"
    || toolCall.result !== undefined
    || toolCall.error?.outcome === "unknown"
  );
}

function isTerminalRunStatus(status: Run["status"]): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
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

function extractRequestText(request: RunRequest): string {
  return request.parts
    ?.filter((part) => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n") ?? "";
}

function toRuntimeTextChunk(chunk: TextStreamPart<ToolSet>): RuntimeTextChunk | null {
  if (chunk.type === "text-start") {
    return {
      type: "text-start",
      id: chunk.id,
      providerMetadata: chunk.providerMetadata,
    };
  }

  if (chunk.type === "text-delta") {
    return {
      type: "text-delta",
      id: chunk.id,
      text: chunk.text,
      providerMetadata: chunk.providerMetadata,
    };
  }

  if (chunk.type === "text-end") {
    return {
      type: "text-end",
      id: chunk.id,
      providerMetadata: chunk.providerMetadata,
    };
  }

  if (chunk.type === "reasoning-start") {
    return {
      type: "reasoning-start",
      id: chunk.id,
      providerMetadata: chunk.providerMetadata,
    };
  }

  if (chunk.type === "reasoning-delta") {
    return {
      type: "reasoning-delta",
      id: chunk.id,
      text: chunk.text,
      providerMetadata: chunk.providerMetadata,
    };
  }

  if (chunk.type === "reasoning-end") {
    return {
      type: "reasoning-end",
      id: chunk.id,
      providerMetadata: chunk.providerMetadata,
    };
  }

  if (chunk.type === "tool-input-start") {
    return {
      type: "tool-input-start",
      toolCallId: chunk.id,
      toolName: chunk.toolName,
      title: chunk.title,
      providerMetadata: chunk.providerMetadata,
    };
  }

  if (chunk.type === "tool-input-delta") {
    return {
      type: "tool-input-delta",
      toolCallId: chunk.id,
      delta: chunk.delta,
      providerMetadata: chunk.providerMetadata,
    };
  }

  if (chunk.type === "tool-input-end") {
    return {
      type: "tool-input-end",
      toolCallId: chunk.id,
      providerMetadata: chunk.providerMetadata,
    };
  }

  if (chunk.type === "tool-call") {
    return {
      type: "tool-call",
      toolCallId: chunk.toolCallId,
      toolName: chunk.toolName,
      input: chunk.input,
      title: chunk.title,
      providerMetadata: chunk.providerMetadata,
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
      providerMetadata: chunk.providerMetadata,
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
      providerMetadata: chunk.providerMetadata,
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
      providerMetadata: chunk.toolCall.providerMetadata,
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
      providerMetadata: chunk.toolCall.providerMetadata,
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
  providerMetadata?: Record<string, unknown>;
}): TextPart {
  const metadata = {
    ...(input.aiSdkTextId ? { aiSdkTextId: input.aiSdkTextId } : {}),
    ...(input.providerMetadata
      ? { providerMetadata: structuredClone(input.providerMetadata) }
      : {}),
  };
  return {
    id: input.id,
    conversationId: input.conversationId,
    messageId: input.messageId,
    type: "text",
    text: input.text,
    time: { start: input.created, end: input.completed },
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
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
  providerMetadata?: Record<string, unknown>;
}): ReasoningPart {
  const metadata = {
    ...(input.aiSdkReasoningId
      ? { aiSdkReasoningId: input.aiSdkReasoningId }
      : {}),
    ...(input.providerMetadata
      ? { providerMetadata: structuredClone(input.providerMetadata) }
      : {}),
  };
  return {
    id: input.id,
    conversationId: input.conversationId,
    messageId: input.messageId,
    type: "reasoning",
    text: input.text,
    time: { start: input.created, end: input.completed },
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function readPartProviderMetadata(
  part: Part,
): Record<string, unknown> | undefined {
  const value = part.metadata?.providerMetadata;
  return isRecord(value) ? value : undefined;
}

function readProviderToolName(part: ToolPart): string {
  const providerToolName = part.metadata?.providerToolName;
  return typeof providerToolName === "string" && providerToolName.trim().length > 0
    ? providerToolName
    : part.toolName;
}

function hasAnthropicReasoningSignature(part: Part): boolean {
  if (part.type !== "reasoning") {
    return false;
  }
  const providerMetadata = readPartProviderMetadata(part);
  const anthropic = isRecord(providerMetadata?.anthropic)
    ? providerMetadata.anthropic
    : null;
  return anthropic?.signature != null;
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

function abortReasonMessage(reason: unknown): string {
  if (typeof reason === "string" && reason.length > 0) {
    return reason;
  }
  if (reason instanceof Error && reason.message.length > 0) {
    return reason.message;
  }
  return "stream aborted";
}
