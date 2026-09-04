import type { RuntimeId, RuntimeIdPrefix } from "../core/ids";
import type {
  AgentMode,
  AttachmentId,
  AssistantMessage,
  Conversation,
  ConversationId,
  CostUsage,
  Event,
  FinishReason,
  InterruptReason,
  Message,
  MessageId,
  Part,
  Permission,
  PromptAssemblySnapshot,
  Run,
  RunLimits,
  RunStatus,
  RuntimeError,
  TextPart,
  ToolCall,
  ToolCallId,
  TokenUsage,
  TraceEvent,
  UserMessage,
} from "../core/types";
import type { RunToolSnapshot } from "../tools/resolution";
import type { RuntimeAttachmentService } from "../attachments";

export const DEFAULT_RUN_LIMITS: RunLimits = {
  maxSteps: 1,
  maxToolCalls: 0,
  maxOutputTokens: 4096,
  timeoutMs: 120_000,
};

const DEFAULT_PROMPT_BLOCK_IDS = [
  "runtime.base",
  "runtime.agent_modes",
  "agent.behavior",
  "runtime.boundaries",
  "output.style",
];
const DEFAULT_CONVERSATION_TITLE = "新对话";
const DEFAULT_CONVERSATION_TITLE_MAX_LENGTH = 34;

export interface RunExecutionPolicySnapshot {
  prompt: PromptAssemblySnapshot;
  tools?: RunToolSnapshot;
  limits: RunLimits;
  trace: {
    promptAssemblyVersion: string;
    promptBlockIds: string[];
    enabledToolNames: string[];
    activeToolNames: string[];
    warnings: string[];
  };
}

export interface RunRequest {
  runId?: Run["id"];
  conversationId?: ConversationId;
  userMessageId?: MessageId;
  replaceFromMessageId?: MessageId;
  providerId: string;
  modelId: string;
  /** @deprecated Prefer ordered parts at the HTTP boundary. Kept for internal callers/tests. */
  text?: string;
  parts?: RunRequestInputPart[];
  agentMode?: AgentMode;
  title?: string;
  executionPolicy?: RunExecutionPolicySnapshot;
  metadata?: Record<string, unknown>;
}

export type RunRequestInputPart =
  | { type: "text"; text: string }
  | { type: "file"; attachmentId: AttachmentId };

export interface NormalizedRunRequest {
  runId?: Run["id"];
  conversationId?: ConversationId;
  userMessageId?: MessageId;
  replaceFromMessageId?: MessageId;
  providerId: string;
  modelId: string;
  text: string;
  parts: RunRequestInputPart[];
  agentMode: AgentMode;
  title: string;
  titleSource: "fallback" | "user";
  limits: RunLimits;
  executionPolicy: RunExecutionPolicySnapshot;
  metadata?: Record<string, unknown>;
}

export interface RuntimeRunStartCommit {
  conversation: Conversation;
  userMessage: UserMessage;
  run: Run;
  assistantMessage: AssistantMessage;
  events: Event[];
  traces: TraceEvent[];
  removedMessageIds?: MessageId[];
}

export interface RuntimeRunnerStore {
  commitRunStart(input: RuntimeRunStartCommit): void;
  saveConversation(conversation: Conversation): void;
  getConversation(id: ConversationId): Conversation | null;
  saveRun(run: Run): void;
  getRun(id: Run["id"]): Run | null;
  saveMessage(message: Message): void;
  getMessage(id: MessageId): Message | null;
  listMessages(conversationId: ConversationId): Message[];
  saveToolCall(toolCall: ToolCall): void;
  getToolCall(id: ToolCallId): ToolCall | null;
  listToolCallsByRun(runId: Run["id"]): ToolCall[];
  getPermissionByToolCallId(toolCallId: ToolCallId): Permission | null;
  listPendingPermissionsByRun(runId: Run["id"]): Permission[];
  bindPermissionAiSdkApproval(input: {
    permissionId: Permission["id"];
    toolCallId: ToolCallId;
    aiSdkApprovalId: string;
    aiSdkToolCallId: string;
    boundAt: number;
    eventId: Event["id"];
  }): Permission;
  commitPermissionContinuation(input: {
    runId: Run["id"];
    responses: readonly {
      permissionId: Permission["id"];
      approved: boolean;
      confirmationText?: string;
      reason?: string;
    }[];
    continuedAt: number;
    eventIds: {
      permissions: readonly Event["id"][];
      tools: readonly Event["id"][];
      run: Event["id"];
      conversation: Event["id"];
    };
  }): {
    conversation: Conversation;
    run: Run;
    permissions: Permission[];
  };
  commitToolPermissionRequest(input: {
    toolCall: ToolCall;
    permission: Permission;
    requestedAt: number;
    eventIds: {
      tool: Event["id"];
      permission: Event["id"];
      run: Event["id"];
      conversation: Event["id"];
    };
  }): unknown;
  appendEvent(event: Event): void;
  appendTrace(trace: TraceEvent): void;
}

export interface RuntimeRunnerDependencies {
  store: RuntimeRunnerStore;
  attachmentService?: RuntimeAttachmentService | null;
  now?: () => number;
  createId?: <TPrefix extends RuntimeIdPrefix>(prefix: TPrefix) => RuntimeId<TPrefix>;
  appVersion?: string;
}

export type RunState = RunStatus;

export interface RunContext {
  request: NormalizedRunRequest;
  conversationId: ConversationId;
  runId: Run["id"];
  userMessageId: MessageId;
  assistantMessageId: MessageId;
}

export interface RuntimeRunStarted {
  conversation: Conversation;
  run: Run;
  userMessage: UserMessage;
  assistantMessage: AssistantMessage;
}

export interface RuntimeRunCompletionOptions {
  finish?: FinishReason;
  usage?: TokenUsage;
  cost?: CostUsage;
  parts?: Part[];
  appendTextPart?: boolean;
}

export interface RuntimeRunCompleted {
  conversation: Conversation;
  run: Run;
  assistantMessage: AssistantMessage;
  textPart: TextPart;
}

export interface RuntimeRunFailed {
  conversation: Conversation;
  run: Run;
  assistantMessage: AssistantMessage;
  error: RuntimeError;
}

export interface RuntimeRunFailureOptions {
  parts?: Part[];
}

export interface RuntimeRunInterruptOptions {
  reason: InterruptReason;
  message?: string;
  text?: string;
  parts?: Part[];
}

export interface RuntimeRunInterrupted {
  conversation: Conversation;
  run: Run;
  assistantMessage: AssistantMessage;
}

export type RunExecutionResult =
  | RuntimeRunStarted
  | RuntimeRunCompleted
  | RuntimeRunFailed
  | RuntimeRunInterrupted;

export function normalizeRunRequest(request: RunRequest): NormalizedRunRequest {
  const parts = normalizeRunInputParts(request);
  const text = parts
    .filter((part): part is Extract<RunRequestInputPart, { type: "text" }> =>
      part.type === "text",
    )
    .map((part) => part.text)
    .join("\n\n");

  const agentMode = request.agentMode ?? "ask";
  const executionPolicy = request.executionPolicy ?? createDefaultExecutionPolicy();
  const requestedTitle = request.title?.trim();

  return {
    conversationId: request.conversationId,
    runId: request.runId,
    userMessageId: request.userMessageId,
    replaceFromMessageId: request.replaceFromMessageId,
    providerId: request.providerId,
    modelId: request.modelId,
    text,
    parts,
    agentMode,
    title: requestedTitle || createDefaultConversationTitle(text),
    titleSource: requestedTitle ? "user" : "fallback",
    limits: executionPolicy.limits,
    executionPolicy,
    metadata: request.metadata,
  };
}

function normalizeRunInputParts(request: RunRequest): RunRequestInputPart[] {
  const source = request.parts ?? (request.text === undefined
    ? []
    : [{ type: "text" as const, text: request.text }]);
  if (source.length === 0) {
    throw new Error("RunRequest.parts must contain at least one part");
  }

  return source.map((part) => {
    if (part.type === "file") {
      return part;
    }
    const text = part.text.trim();
    if (!text) {
      throw new Error("RunRequest text parts must not be empty");
    }
    return { type: "text", text };
  });
}

export function createDefaultConversationTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return DEFAULT_CONVERSATION_TITLE;
  }

  const chars = Array.from(normalized);
  if (chars.length < DEFAULT_CONVERSATION_TITLE_MAX_LENGTH) {
    return normalized;
  }

  return `${chars.slice(0, DEFAULT_CONVERSATION_TITLE_MAX_LENGTH - 3).join("")}...`;
}

function createDefaultExecutionPolicy(): RunExecutionPolicySnapshot {
  return {
    prompt: {
      version: "runtime-prompt-v2",
      blockIds: [...DEFAULT_PROMPT_BLOCK_IDS],
      warnings: [],
    },
    limits: { ...DEFAULT_RUN_LIMITS },
    trace: {
      promptAssemblyVersion: "runtime-prompt-v2",
      promptBlockIds: [...DEFAULT_PROMPT_BLOCK_IDS],
      enabledToolNames: [],
      activeToolNames: [],
      warnings: [],
    },
  };
}

export function isTerminalRunState(status: RunState): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}
