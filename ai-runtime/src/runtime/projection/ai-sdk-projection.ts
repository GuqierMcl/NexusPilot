import type { Message, Part, TokenUsage, ToolState } from "../core/types";

export interface AiSdkUIMessageLike {
  id: string;
  role: "user" | "assistant" | "system";
  parts: AiSdkUIPartLike[];
  metadata?: Record<string, unknown>;
}

export type AiSdkUIPartLike =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "source-url"; sourceId: string; url: string; title?: string }
  | { type: "file"; mediaType: string; filename?: string; url: string }
  | AiSdkToolPartLike;

export type AiSdkToolPartLike = {
  type: `tool-${string}`;
  toolCallId: string;
  title?: string;
} & (
  | {
      state: "input-available";
      input: unknown;
    }
  | {
      state: "approval-requested";
      input: unknown;
      approval: { id: string };
    }
  | {
      state: "output-available";
      input: unknown;
      output: unknown;
    }
  | {
      state: "output-error";
      input: unknown | undefined;
      errorText: string;
    }
);

export function projectMessageToAiSdkUIMessage(
  message: Message,
): AiSdkUIMessageLike {
  return {
    id: message.id,
    role: message.role,
    parts: message.parts.flatMap(projectPartToAiSdkUIParts),
    metadata: buildMessageMetadata(message),
  };
}

export function projectPartToAiSdkUIParts(part: Part): AiSdkUIPartLike[] {
  switch (part.type) {
    case "text":
      return [{ type: "text", text: part.text }];
    case "reasoning":
      return [{ type: "reasoning", text: part.redacted ? "[reasoning redacted]" : part.text }];
    case "source":
      return [
        {
          type: "source-url",
          sourceId: part.sourceId ?? part.id,
          url: part.url,
          title: part.title,
        },
      ];
    case "file": {
      const url = part.url ?? part.dataRef;
      return url
        ? [
            {
              type: "file",
              mediaType: part.mimeType,
              filename: part.filename,
              url,
            },
          ]
        : [];
    }
    case "tool":
      return [projectToolPart(part)];
    case "diff":
    case "error":
    case "step-start":
    case "step-finish":
    case "retry":
    case "compaction":
      return [];
  }
}

function projectToolPart(
  part: Extract<Part, { type: "tool" }>,
): AiSdkToolPartLike {
  const { state } = part;
  const base = {
    type: `tool-${part.toolName}` as const,
    toolCallId:
      readAdapterId(part.metadata, "aiSdkToolCallId") ?? part.toolCallId,
    title: extractToolTitle(state),
  };

  switch (state.status) {
    case "waiting_for_permission":
      return {
        ...base,
        state: "approval-requested",
        input: state.input,
        approval: {
          id:
            readAdapterId(part.metadata, "aiSdkApprovalId") ??
            state.permissionId,
        },
      };
    case "completed":
      return {
        ...base,
        state: "output-available",
        input: state.input,
        output: state.output,
      };
    case "error":
      return {
        ...base,
        state: "output-error",
        input: state.input,
        errorText: state.error.message,
      };
    case "interrupted":
      return {
        ...base,
        state: "output-error",
        input: state.input,
        errorText: state.reason ?? "Tool call interrupted",
      };
    case "pending":
    case "validating":
    case "running":
      return {
        ...base,
        state: "input-available",
        input: extractToolInput(state),
      };
  }
}

function readAdapterId(
  metadata: Record<string, unknown> | undefined,
  key: "aiSdkToolCallId" | "aiSdkApprovalId",
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function extractToolInput(state: ToolState): unknown {
  return "input" in state ? state.input : undefined;
}

function extractToolTitle(state: ToolState): string | undefined {
  return "title" in state ? state.title : undefined;
}

function buildMessageMetadata(message: Message): Record<string, unknown> {
  const nexus: Record<string, unknown> = {
    conversationId: message.conversationId,
  };
  const aiSdkUsage =
    message.role === "assistant" && message.usage
      ? projectRuntimeUsageForAiSdk(message.usage)
      : undefined;

  if (message.metadata) {
    nexus.messageMetadata = message.metadata;
  }

  if (message.role === "assistant") {
    nexus.runId = message.runId;
    nexus.providerId = message.providerId;
    nexus.modelId = message.modelId;
    nexus.agentMode = message.agentMode;

    if (message.usage) {
      nexus.usage = message.usage;
    }
    if (message.cost) {
      nexus.cost = message.cost;
    }
    if (message.finish) {
      nexus.finish = message.finish;
    }
    if (message.status.type !== "complete") {
      nexus.status = message.status;
    }
    if (message.metadata?.interrupt) {
      nexus.interrupt = message.metadata.interrupt;
    }
  }

  return {
    nexus,
    custom: {
      nexus,
      ...(aiSdkUsage ? { usage: aiSdkUsage } : {}),
    },
    ...(aiSdkUsage ? { usage: aiSdkUsage } : {}),
  };
}

function projectRuntimeUsageForAiSdk(usage: TokenUsage): Record<string, number> {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    reasoningTokens: usage.reasoning,
    totalTokens: usage.total,
    ...(usage.cache?.read !== undefined
      ? { cachedInputTokens: usage.cache.read }
      : {}),
  };
}
