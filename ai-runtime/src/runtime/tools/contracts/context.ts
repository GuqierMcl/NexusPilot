import type {
  ConversationId,
  MessageId,
  RunId,
  ToolCallId,
} from "../../core/types";
import type { ToolExecutionOutput } from "./result";
import type { NetworkAccessScope } from "../../../settings/contracts";

interface RuntimeToolInvocationContext {
  conversationId: ConversationId;
  runId: RunId;
  messageId: MessageId;
  toolCallId: ToolCallId;
  toolId: string;
  abortSignal: AbortSignal;
}

export interface ToolExecutionContext extends RuntimeToolInvocationContext {
  networkAccessScope?: NetworkAccessScope;
}

export interface BackendToolExecutionContext<TOutput = unknown>
  extends RuntimeToolInvocationContext {
  networkAccessScope?: NetworkAccessScope;
  proceed(): Promise<Readonly<ToolExecutionOutput<TOutput>>>;
}

export interface ToolRiskResolutionContext extends RuntimeToolInvocationContext {}
