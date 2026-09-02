import type { RuntimeId } from "./ids";
import type { RunToolSnapshot } from "../tools/resolution";
import type {
  RuntimeToolError,
  RuntimeToolResult,
} from "../tools/contracts";

export type ConversationId = RuntimeId<"conv">;
export type MessageId = RuntimeId<"msg">;
export type PartId = RuntimeId<"part">;
export type RunId = RuntimeId<"run">;
export type ToolCallId = RuntimeId<"tool">;
export type PermissionId = RuntimeId<"perm">;
export type EventId = RuntimeId<"evt">;
export type TraceId = RuntimeId<"trace">;
export type DiffId = RuntimeId<"diff">;
export type UploadId = RuntimeId<"upl">;
export type AttachmentId = RuntimeId<"att">;
export type BlobId = RuntimeId<"blob">;

export interface TimeCreated {
  created: number;
}

export interface TimeSpan {
  start: number;
  end?: number;
}

export interface Conversation {
  id: ConversationId;
  title: string;
  version: string;
  status: ConversationStatus;
  parentId?: ConversationId;
  summary?: ConversationSummary;
  share?: ConversationShare;
  time: {
    created: number;
    updated: number;
    archived?: number;
    compacting?: number;
  };
  metadata?: Record<string, unknown>;
}

export type ConversationStatus =
  | { type: "idle" }
  | { type: "busy"; runId: RunId }
  | { type: "waiting_for_permission"; runId: RunId; permissionId: PermissionId }
  | { type: "retry"; attempt: number; message: string; next: number }
  | { type: "error"; error: RuntimeError }
  | { type: "archived" };

export interface ConversationSummary {
  title?: string;
  body?: string;
  messageCount?: number;
  tokenCount?: number;
  toolCallCount?: number;
  updatedAt: number;
}

export interface ConversationShare {
  url: string;
  createdAt: number;
}

export type AgentMode = "ask" | "query" | "agent";

export interface PromptAssemblySnapshot {
  version: string;
  blockIds: string[];
  warnings: string[];
}

export interface Run {
  id: RunId;
  conversationId: ConversationId;
  parentMessageId?: MessageId;
  assistantMessageId?: MessageId;
  agentMode: AgentMode;
  providerId: string;
  modelId: string;
  status: RunStatus;
  input: RunInput;
  output?: RunOutput;
  usage?: TokenUsage;
  cost?: CostUsage;
  finish?: FinishReason;
  error?: RuntimeError;
  time: {
    created: number;
    started?: number;
    completed?: number;
  };
  limits: RunLimits;
  metadata?: Record<string, unknown>;
}

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_for_tool"
  | "waiting_for_permission"
  | "completed"
  | "failed"
  | "interrupted";

export type InterruptReason =
  | "user_stop"
  | "client_disconnect"
  | "runtime_shutdown"
  | "runtime_recovered_stale_run"
  | "tool_abort"
  | "timeout"
  | "unknown";

export interface RunInterrupt {
  reason: InterruptReason;
  message?: string;
  interruptedAt: string;
}

export interface RunInput {
  messageIds: MessageId[];
  prompt?: PromptAssemblySnapshot;
  tools?: RunToolSnapshot;
  context?: RunContextSnapshot;
}

export interface RunOutput {
  messageId: MessageId;
  partIds: PartId[];
}

export interface RunLimits {
  maxSteps: number;
  maxToolCalls: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool-calls"
  | "content-filter"
  | "error"
  | "interrupted"
  | "unknown";

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache?: {
    read: number;
    write: number;
  };
  total: number;
}

export interface CostUsage {
  input?: number;
  output?: number;
  total?: number;
  currency?: "USD" | string;
}

export interface RunContextSnapshot {
  runtime: {
    appVersion: string;
    dataDir?: string;
    networkAccess: "enabled" | "disabled";
    timezone?: string;
    locale?: string;
  };
  provider: {
    providerId: string;
    modelId: string;
    modelName?: string;
    contextLength?: number;
    outputLength?: number;
    supportsTools?: boolean;
    supportsReasoning?: boolean;
    supportsVision?: boolean;
  };
  request?: {
    userId?: string;
    clientName?: string;
    clientVersion?: string;
    metadata?: Record<string, unknown>;
  };
}

export type Message = UserMessage | AssistantMessage | SystemMessage;

export interface BaseMessage {
  id: MessageId;
  conversationId: ConversationId;
  role: "user" | "assistant" | "system";
  time: TimeCreated & { completed?: number };
  parts: Part[];
  metadata?: MessageMetadata;
}

export interface UserMessage extends BaseMessage {
  role: "user";
  agentMode: AgentMode;
  model?: ModelSelection;
  summary?: MessageSummary;
}

export interface AssistantMessage extends BaseMessage {
  role: "assistant";
  runId: RunId;
  parentId: MessageId;
  providerId: string;
  modelId: string;
  agentMode: AgentMode;
  status: AssistantMessageStatus;
  usage?: TokenUsage;
  cost?: CostUsage;
  finish?: FinishReason;
  error?: RuntimeError;
}

export interface SystemMessage extends BaseMessage {
  role: "system";
  scope: "runtime" | "profile" | "request" | "memory";
}

export interface ModelSelection {
  providerId: string;
  modelId: string;
}

export interface MessageSummary {
  title?: string;
  body?: string;
}

export type AssistantMessageStatus =
  | { type: "running" }
  | { type: "complete"; reason?: FinishReason }
  | { type: "incomplete"; reason: FinishReason }
  | { type: "requires-action"; reason: "permission" | "approval" | "tool" }
  | { type: "error"; error: RuntimeError };

export interface MessageMetadata {
  ui?: {
    synthetic?: boolean;
    ignored?: boolean;
  };
  runtime?: {
    runId?: RunId;
    stepIndex?: number;
  };
  [key: string]: unknown;
}

export type Part =
  | TextPart
  | ReasoningPart
  | FilePart
  | SourcePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | RetryPart
  | CompactionPart
  | DiffPart
  | ErrorPart;

export interface BasePart {
  id: PartId;
  conversationId: ConversationId;
  messageId: MessageId;
  type: string;
  time?: TimeSpan | TimeCreated;
  metadata?: Record<string, unknown>;
}

export interface TextPart extends BasePart {
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
}

export interface ReasoningPart extends BasePart {
  type: "reasoning";
  text: string;
  redacted?: boolean;
}

export interface FilePart extends BasePart {
  type: "file";
  attachmentId: AttachmentId;
  mediaType: string;
  filename: string;
  byteLength: number;
}

export interface SourcePart extends BasePart {
  type: "source";
  sourceType: "url";
  sourceId?: string;
  url: string;
  title?: string;
}

export interface ToolPart extends BasePart {
  type: "tool";
  toolCallId: ToolCallId;
  toolName: string;
  state: ToolState;
}

export interface StepStartPart extends BasePart {
  type: "step-start";
  stepIndex: number;
}

export interface StepFinishPart extends BasePart {
  type: "step-finish";
  stepIndex: number;
  reason: FinishReason;
  usage?: TokenUsage;
  cost?: CostUsage;
}

export interface RetryPart extends BasePart {
  type: "retry";
  attempt: number;
  error: RuntimeError;
  time: TimeCreated;
}

export interface CompactionPart extends BasePart {
  type: "compaction";
  auto: boolean;
  summary?: string;
}

export interface DiffPart extends BasePart {
  type: "diff";
  diff: DiffArtifact;
  status: DiffStatus;
}

export type DiffStatus = "proposed" | "applied" | "rejected" | "stale";

export interface DiffArtifact {
  id: DiffId | string;
  title: string;
  kind: "text" | "sql" | "json" | "markdown";
  target: DiffTarget;
  beforeHash?: string;
  afterHash?: string;
  hunks: DiffHunk[];
  summary?: string;
}

export type DiffTarget =
  | {
      type: "memory";
      name: string;
      language?: string;
    }
  | {
      type: "workspace_file";
      path: string;
      language?: string;
    }
  | {
      type: "business_object";
      objectType: string;
      objectId: string;
      label?: string;
    };

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type DiffLine =
  | { type: "context"; oldLine: number; newLine: number; text: string }
  | { type: "add"; newLine: number; text: string }
  | { type: "remove"; oldLine: number; text: string };

export interface ErrorPart extends BasePart {
  type: "error";
  error: RuntimeError;
}

export type FileSource = UrlSource | RuntimeSource;

export interface UrlSource {
  type: "url";
  url: string;
  title?: string;
  range?: TextRange;
}

export interface RuntimeSource {
  type: "runtime";
  name: string;
  description?: string;
}

export interface TextRange {
  start: number;
  end: number;
}

export type ToolState =
  | ToolStatePending
  | ToolStateValidating
  | ToolStateWaitingForPermission
  | ToolStateRunning
  | ToolStateCompleted
  | ToolStateError
  | ToolStateInterrupted;

export interface ToolStatePending {
  status: "pending";
  input?: Record<string, unknown>;
  raw?: string;
}

export interface ToolStateValidating {
  status: "validating";
  input: Record<string, unknown>;
  time: TimeSpan;
}

export interface ToolStateWaitingForPermission {
  status: "waiting_for_permission";
  input: Record<string, unknown>;
  permissionId: PermissionId;
  title?: string;
  metadata?: Record<string, unknown>;
  time: TimeSpan;
}

export interface ToolStateRunning {
  status: "running";
  input: Record<string, unknown>;
  title?: string;
  metadata?: Record<string, unknown>;
  time: TimeSpan;
}

export interface ToolStateCompleted {
  status: "completed";
  input: Record<string, unknown>;
  output: ToolOutput;
  title: string;
  metadata?: Record<string, unknown>;
  time: Required<TimeSpan>;
  attachments?: ToolAttachment[];
}

export interface ToolStateError {
  status: "error";
  input: Record<string, unknown>;
  error: ToolError;
  metadata?: Record<string, unknown>;
  time: Required<TimeSpan>;
}

export interface ToolStateInterrupted {
  status: "interrupted";
  input?: Record<string, unknown>;
  reason?: InterruptReason | string;
  time: Required<TimeSpan>;
}

export interface ToolCall {
  id: ToolCallId;
  conversationId: ConversationId;
  runId: RunId;
  messageId: MessageId;
  partId?: PartId;
  toolName: string;
  input: Record<string, unknown>;
  state: ToolState["status"];
  permissionId?: PermissionId;
  result?: RuntimeToolResult<unknown>;
  error?: RuntimeToolError;
  time: {
    created: number;
    started?: number;
    completed?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  permission: PermissionLevel;
  sideEffect: LegacyToolSideEffect;
  modeAllowlist: AgentMode[];
  enabledByDefault: boolean;
  timeoutMs: number;
  outputLimit?: ToolOutputLimit;
  metadata?: {
    category?: "runtime" | "network" | "workspace" | "business";
    uiComponent?: string;
    tags?: string[];
  };
}

export type PermissionLevel =
  | "runtime_read"
  | "external_network"
  | "workspace_read"
  | "business_read"
  | "business_write"
  | "destructive";

export type LegacyToolSideEffect =
  | "none"
  | "external_network"
  | "local_read"
  | "local_write"
  | "business_read"
  | "business_write"
  | "destructive";

export interface ToolOutputLimit {
  maxChars?: number;
  maxBytes?: number;
  truncateStrategy?: "head" | "tail" | "middle";
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  output?: ToolOutput<T>;
  error?: ToolError;
  metadata: ToolResultMetadata;
}

export interface ToolOutput<T = unknown> {
  data: T;
  display?: {
    title?: string;
    summary?: string;
    markdown?: string;
    sourceUrl?: string;
  };
}

export interface ToolResultMetadata {
  started: number;
  completed: number;
  durationMs: number;
  truncated?: boolean;
  sensitive?: boolean;
  contentType?: string;
  bytesRead?: number;
}

export interface ToolAttachment {
  type: "file" | "source" | "artifact";
  title?: string;
  url?: string;
  mimeType?: string;
  dataRef?: string;
}

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export type ToolErrorCode =
  | "VALIDATION_ERROR"
  | "NETWORK_ACCESS_SCOPE_DENIED"
  | "PERMISSION_DENIED"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "HTTP_ERROR"
  | "CONTENT_TOO_LARGE"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "INTERNAL_ERROR";

export interface Permission {
  id: PermissionId;
  conversationId: ConversationId;
  runId: RunId;
  messageId: MessageId;
  toolCallId: ToolCallId;
  status: PermissionStatus;
  toolId: string;
  title: string;
  inputSummary?: string;
  risk: PermissionResolvedRisk;
  confirmation: PermissionConfirmation;
  presentation?: PermissionPresentation;
  metadata?: Record<string, unknown>;
  adapter?: {
    aiSdkApprovalId?: string;
    aiSdkToolCallId?: string;
  };
  decision?: PermissionDecision;
  createdAt: number;
}

export type PermissionStatus = "pending" | "approved" | "denied" | "cancelled";

export interface PermissionResolvedRisk {
  level: "low" | "medium" | "high" | "critical";
  reversible: boolean;
  sideEffects: readonly (
    | "none"
    | "external_network"
    | "runtime_state"
    | "workbench_state"
    | "business_read"
    | "business_write"
    | "destructive"
  )[];
}

export type PermissionConfirmationLevel = "standard" | "strong";

export interface PermissionConfirmation {
  level: PermissionConfirmationLevel;
  prompt?: string;
}

export interface PermissionTargetPresentation {
  profileId?: string;
  connectionName?: string;
  driver?: string;
  environment?: string;
  database?: string;
  schema?: string;
  redisDbIndex?: number;
}

export interface PermissionSqlPresentation {
  text: string;
  analysisStatus: "analyzed" | "uncertain" | "failed";
  statementClass?: string;
  identifiedTargets?: readonly string[];
}

export interface PermissionKeyValuePresentation {
  operation: "create" | "set" | "rename" | "set_ttl" | "delete";
  key: string;
  newKey?: string;
  valueType?: string;
  ttlMode?: "keep" | "persist" | "expire";
  ttlSeconds?: number;
}

export interface PermissionPresentation {
  target?: PermissionTargetPresentation;
  riskReasons?: readonly string[];
  sql?: PermissionSqlPresentation;
  keyValue?: PermissionKeyValuePresentation;
  timeoutMs?: number;
  maxResultBytes?: number;
  outcomeWarnings?: readonly string[];
}

export interface PermissionDecision {
  source: "user" | "system";
  reason?: string;
  confirmationVerified?: boolean;
  decidedAt: number;
}

export type PermissionResponse = "allow" | "deny" | "ask" | "allow_once" | "deny_once";

export type Event =
  | EventConversationCreated
  | EventConversationUpdated
  | EventConversationDeleted
  | EventConversationStatus
  | EventMessageUpdated
  | EventMessageRemoved
  | EventMessagePartUpdated
  | EventMessagePartRemoved
  | EventRunUpdated
  | EventToolCallUpdated
  | EventPermissionRequested
  | EventPermissionResolved
  | EventPermissionUpdated
  | EventPermissionReplied
  | EventRuntimeError;

export interface BaseEvent<TType extends string, TProperties> {
  id: EventId;
  type: TType;
  properties: TProperties;
  time: number;
}

export type EventConversationCreated = BaseEvent<"conversation.created", { info: Conversation }>;
export type EventConversationUpdated = BaseEvent<"conversation.updated", { info: Conversation }>;
export type EventConversationDeleted = BaseEvent<"conversation.deleted", { info: Conversation }>;
export type EventConversationStatus = BaseEvent<
  "conversation.status",
  { conversationId: ConversationId; status: ConversationStatus }
>;
export type EventMessageUpdated = BaseEvent<"message.updated", { info: Message }>;
export type EventMessageRemoved = BaseEvent<
  "message.removed",
  { conversationId: ConversationId; messageId: MessageId }
>;
export type EventMessagePartUpdated = BaseEvent<
  "message.part.updated",
  { part: Part; delta?: string }
>;
export type EventMessagePartRemoved = BaseEvent<
  "message.part.removed",
  { conversationId: ConversationId; messageId: MessageId; partId: PartId }
>;
export type EventRunUpdated = BaseEvent<"run.updated", { info: Run }>;
export type EventToolCallUpdated = BaseEvent<"tool.updated", { info: ToolCall }>;
export type EventPermissionRequested = BaseEvent<
  "permission.requested",
  { info: Permission }
>;
export type EventPermissionResolved = BaseEvent<
  "permission.resolved",
  { info: Permission }
>;
/** @deprecated Retained for historical event projection compatibility. */
export type EventPermissionUpdated = BaseEvent<"permission.updated", { info: Permission }>;
/** @deprecated Retained for historical event projection compatibility. */
export type EventPermissionReplied = BaseEvent<
  "permission.replied",
  { conversationId: ConversationId; permissionId: PermissionId; response: PermissionResponse }
>;
export type EventRuntimeError = BaseEvent<
  "runtime.error",
  { conversationId?: ConversationId; runId?: RunId; error: RuntimeError }
>;

export interface TraceEvent {
  id: TraceId;
  conversationId?: ConversationId;
  runId?: RunId;
  type: TraceEventType;
  level: "debug" | "info" | "warn" | "error";
  time: number;
  payload: Record<string, unknown>;
}

export type TraceEventType =
  | "request.received"
  | "model.resolved"
  | "prompt.assembled"
  | "tool.registry.resolved"
  | "permission.decided"
  | "tool.executed"
  | "stream.started"
  | "stream.finished"
  | "stream.failed";

export type RuntimeError =
  | ProviderAuthError
  | ProviderNotFoundError
  | ModelNotFoundError
  | ModelDisabledError
  | ApiError
  | MessageOutputLengthError
  | MessageAbortedError
  | ToolExecutionError
  | PermissionDeniedError
  | UnknownError;

export interface ProviderAuthError {
  name: "ProviderAuthError";
  data: { providerId: string; message: string };
}

export interface ProviderNotFoundError {
  name: "ProviderNotFoundError";
  data: { providerId: string };
}

export interface ModelNotFoundError {
  name: "ModelNotFoundError";
  data: { providerId: string; modelId: string };
}

export interface ModelDisabledError {
  name: "ModelDisabledError";
  data: { providerId: string; modelId: string };
}

export interface ApiError {
  name: "APIError";
  data: {
    message: string;
    statusCode?: number;
    isRetryable: boolean;
    responseHeaders?: Record<string, string>;
    responseBody?: string;
  };
}

export interface MessageOutputLengthError {
  name: "MessageOutputLengthError";
  data: { limit?: number; message?: string };
}

export interface MessageAbortedError {
  name: "MessageAbortedError";
  data: { message: string };
}

export interface ToolExecutionError {
  name: "ToolExecutionError";
  data: { toolName: string; message: string; code?: string };
}

export interface PermissionDeniedError {
  name: "PermissionDeniedError";
  data: { permissionId?: PermissionId; message: string };
}

export interface UnknownError {
  name: "UnknownError";
  data: { message: string };
}
