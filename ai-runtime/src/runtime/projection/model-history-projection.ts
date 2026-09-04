import type {
  AssistantContent,
  ModelMessage,
  ProviderMetadata,
  ToolContent,
  ToolResultPart,
  UserContent,
} from "ai";

import {
  ATTACHMENT_LIMITS,
  RuntimeAttachmentError,
  type RuntimeAttachmentService,
} from "../attachments";
import type {
  AssistantMessage,
  FilePart,
  Message,
  Part,
  TextPart,
  ToolPart,
  ToolState,
} from "../core/types";

export interface ModelHistoryTarget {
  providerId: string;
  modelId: string;
}

export interface ModelHistoryProjectionOptions {
  target: ModelHistoryTarget;
  attachmentService?: RuntimeAttachmentService | null;
}

export async function projectModelHistory(
  messages: Message[],
  options: ModelHistoryProjectionOptions,
): Promise<ModelMessage[]> {
  const bytesByPartId = await loadHistoryAttachments(
    messages,
    options.attachmentService,
  );
  const projected: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      const content: UserContent = [];
      for (const part of message.parts) {
        if (isPromptTextPart(part) && part.text.trim().length > 0) {
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
      if (content.length > 0) {
        projected.push({ role: "user", content });
      }
      continue;
    }

    if (message.role === "system") {
      const content = message.parts
        .filter(isPromptTextPart)
        .map((part) => part.text)
        .filter((text) => text.trim().length > 0)
        .join("\n\n");
      if (content.length > 0) {
        projected.push({ role: "system", content });
      }
      continue;
    }

    projectAssistantMessage(message, options.target, projected);
  }

  return projected;
}

function projectAssistantMessage(
  message: AssistantMessage,
  target: ModelHistoryTarget,
  output: ModelMessage[],
): void {
  const sameModel =
    message.providerId === target.providerId && message.modelId === target.modelId;
  const hasSignedReasoning = message.parts.some(hasAnthropicReasoningSignature);
  let block: Part[] = [];

  const flush = (): void => {
    if (block.length === 0) {
      return;
    }
    projectAssistantBlock(block, sameModel, hasSignedReasoning, output);
    block = [];
  };

  for (const part of message.parts) {
    if (part.type === "step-start") {
      flush();
      continue;
    }
    if (part.type === "text" || part.type === "reasoning" || part.type === "tool") {
      block.push(part);
    }
  }
  flush();
}

function projectAssistantBlock(
  parts: Part[],
  sameModel: boolean,
  hasSignedReasoning: boolean,
  output: ModelMessage[],
): void {
  const assistantContent: AssistantContent = [];
  const toolContent: ToolContent = [];

  for (const part of parts) {
    if (part.type === "text") {
      const text = sameModel && part.text === "" && hasSignedReasoning
        ? " "
        : part.text;
      if (text.length === 0) {
        continue;
      }
      assistantContent.push({
        type: "text",
        text,
        ...(sameModel
          ? withProviderOptions(readPartProviderMetadata(part))
          : {}),
      });
      continue;
    }

    if (part.type === "reasoning") {
      if (!sameModel) {
        if (part.text.trim().length > 0) {
          assistantContent.push({ type: "text", text: part.text });
        }
        continue;
      }
      assistantContent.push({
        type: "reasoning",
        text: part.text,
        ...withProviderOptions(readPartProviderMetadata(part)),
      });
      continue;
    }

    if (part.type === "tool") {
      const toolCallId = readStableToolCallId(part);
      const toolName = readStableProviderToolName(part);
      const input = readToolInput(part.state);
      const providerOptions = sameModel
        ? withProviderOptions(readPartProviderMetadata(part))
        : {};
      assistantContent.push({
        type: "tool-call",
        toolCallId,
        toolName,
        input,
        ...providerOptions,
      });
      toolContent.push({
        type: "tool-result",
        toolCallId,
        toolName,
        output: projectToolOutput(part.state),
      });
    }
  }

  if (assistantContent.length > 0) {
    output.push({ role: "assistant", content: assistantContent });
  }
  if (toolContent.length > 0) {
    output.push({ role: "tool", content: toolContent });
  }
}

function projectToolOutput(state: ToolState): ToolResultPart["output"] {
  if (state.status === "completed") {
    return typeof state.output === "string"
      ? { type: "text", value: state.output }
      : { type: "json", value: state.output as never };
  }
  if (state.status === "error") {
    return { type: "error-text", value: state.error.message };
  }
  if (state.status === "interrupted") {
    return {
      type: "error-text",
      value: state.reason ?? "[Tool execution was interrupted]",
    };
  }
  return { type: "error-text", value: "[Tool execution was interrupted]" };
}

function readToolInput(state: ToolState): unknown {
  return "input" in state ? (state.input ?? {}) : {};
}

function readStableToolCallId(part: ToolPart): string {
  const adapterId = part.metadata?.aiSdkToolCallId;
  return typeof adapterId === "string" && adapterId.trim().length > 0
    ? adapterId
    : part.toolCallId;
}

function readStableProviderToolName(part: ToolPart): string {
  const providerToolName = part.metadata?.providerToolName;
  return typeof providerToolName === "string" && providerToolName.trim().length > 0
    ? providerToolName
    : part.toolName;
}

function readPartProviderMetadata(
  part: Part,
): ProviderMetadata | undefined {
  const value = part.metadata?.providerMetadata;
  return isRecord(value) ? (value as ProviderMetadata) : undefined;
}

function withProviderOptions(
  providerOptions: ProviderMetadata | undefined,
): { providerOptions?: ProviderMetadata } {
  return providerOptions ? { providerOptions } : {};
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

async function loadHistoryAttachments(
  messages: Message[],
  attachmentService?: RuntimeAttachmentService | null,
): Promise<Map<string, Uint8Array>> {
  const fileParts = messages.flatMap((message) =>
    message.role === "user" ? message.parts.filter(isPromptFilePart) : [],
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
    async (part) => [
      part.id,
      await attachmentService!.readBytes(part.attachmentId),
    ] as const,
  );
  return new Map(loaded);
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

function isPromptTextPart(part: Part): part is TextPart {
  return part.type === "text" && !part.ignored;
}

function isPromptFilePart(part: Part): part is FilePart {
  return part.type === "file";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
