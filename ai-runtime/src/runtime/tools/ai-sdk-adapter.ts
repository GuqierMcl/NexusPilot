import {
  tool,
  type ToolApprovalConfiguration,
  type ToolSet,
} from "ai";
import type { ConversationId, MessageId, PartId, ToolCallId } from "../core/types";
import type { RuntimeToolError } from "./contracts";
import type { RuntimeToolCore } from "./core";
import type { RuntimeToolRegistry } from "./kernel";
import type { RunToolSnapshot } from "./resolution";

export interface AiSdkRuntimeToolIdentity {
  toolCallId: ToolCallId;
  partId?: PartId;
}

export interface RuntimeToolsToAiSdkOptions {
  registry: RuntimeToolRegistry;
  core: RuntimeToolCore;
  snapshot: RunToolSnapshot;
  conversationId: ConversationId;
  messageId: MessageId;
  resolveIdentity(
    aiSdkToolCallId: string,
    providerName: string,
  ): AiSdkRuntimeToolIdentity;
}

export interface RuntimeAiSdkToolSet {
  tools: ToolSet;
  activeTools: string[];
  toolApproval: ToolApprovalConfiguration<ToolSet, unknown>;
}

export function runtimeToolsToAiSdkToolSet(
  options: RuntimeToolsToAiSdkOptions,
): RuntimeAiSdkToolSet {
  const entries = options.snapshot.activeTools.map((active) => {
    const definition = options.registry.requireTool(active.canonicalId);
    if (options.registry.requireProviderName(definition.id) !== active.providerName) {
      throw new Error(`Snapshot Tool identity mismatch for "${active.canonicalId}"`);
    }
    return [
      active.providerName,
      tool({
        description: definition.description,
        inputSchema: definition.inputSchema,
        execute: async (input, executeOptions) => {
          const identity = options.resolveIdentity(
            executeOptions.toolCallId,
            active.providerName,
          );
          return options.core.dispatch({
            conversationId: options.conversationId,
            runId: options.snapshot.runId,
            messageId: options.messageId,
            toolCallId: identity.toolCallId,
            ...(identity.partId ? { partId: identity.partId } : {}),
            providerName: active.providerName,
            input,
            snapshot: options.snapshot,
            abortSignal: executeOptions.abortSignal,
          });
        },
      }),
    ] as const;
  });
  return {
    tools: Object.fromEntries(entries) as ToolSet,
    activeTools: entries.map(([name]) => name),
    toolApproval: async ({ toolCall }) => {
      const identity = options.resolveIdentity(
        toolCall.toolCallId,
        toolCall.toolName,
      );
      const authorization = await options.core.authorize({
        conversationId: options.conversationId,
        runId: options.snapshot.runId,
        messageId: options.messageId,
        toolCallId: identity.toolCallId,
        ...(identity.partId ? { partId: identity.partId } : {}),
        providerName: toolCall.toolName,
        input: toolCall.input,
        snapshot: options.snapshot,
      });
      if (authorization.decision === "allow") {
        return "not-applicable";
      }
      if (authorization.decision === "deny") {
        return { type: "denied", reason: authorization.reason };
      }
      if (authorization.decision === "error") {
        return {
          type: "denied",
          reason: toolAuthorizationErrorReason(authorization.error),
        };
      }
      return "user-approval";
    },
  };
}

function toolAuthorizationErrorReason(error: RuntimeToolError): string {
  const retryGuidance = error.outcome === "unknown"
    ? "The operation outcome is unknown. Do not retry automatically."
    : error.retryable
      ? "A new tool call may be retried after addressing the error."
      : "Do not repeat the same tool call without changing the conditions.";
  return [
    `Tool authorization failed before execution: [${error.code}] ${error.message}`,
    `Outcome: ${error.outcome}.`,
    retryGuidance,
  ].join(" ");
}
