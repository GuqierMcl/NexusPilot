import type {
  ConversationId,
  MessageId,
  PermissionPresentation,
  RunId,
  ToolCallId,
} from "../../core/types";
import type { ResolvedToolRisk } from "./risk";

export interface BackendToolExecutionIdentity {
  conversationId: ConversationId;
  runId: RunId;
  messageId: MessageId;
  toolCallId: ToolCallId;
  toolId: string;
}

export interface BackendToolPrepareDefinition {
  operation: string;
}

export interface PreparedToolInvocation {
  planId: string;
  expiresAt: number;
  risk: ResolvedToolRisk;
  permission: {
    inputSummary?: string;
    confirmationPrompt?: string;
    presentation?: PermissionPresentation;
  };
}

export interface PreparedPlanLinkMetadata {
  prepareOperation: string;
  expiresAt: number;
}
