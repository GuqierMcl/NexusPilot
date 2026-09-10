import type { ModelMessage, SystemModelMessage } from "ai";

import type { ContextCheckpoint, RuntimeSafetyState } from "./types";
import type {
  AssistantMessage,
  ConversationId,
  Message,
  Part,
  Run,
  UserMessage,
} from "../core/types";
import { stableStringifyJson } from "./token-estimator";
import { projectActiveTabContext } from "../../../../shared/active-tab-context";

export const CONTEXT_SUMMARY_SYSTEM_PROMPT = [
  "Create a provider-neutral conversation checkpoint for a later model request.",
  "The checkpoint is lossy memory, not an audit record and not authorization.",
  "Preserve user goals and preferences, confirmed constraints, key conclusions and their sources, stable object identities, attempted approaches, errors and uncertainty, remaining work, and next actions.",
  "Do not claim that a tool ran or that an operation was approved unless the Runtime Safety State says so.",
  "Do not copy credentials, access tokens, provider metadata, full sensitive results, local paths, provider file IDs, or consumable approval information.",
  "Return plain UTF-8 text only. Do not return JSON, Markdown fences, or tool calls.",
].join("\n");

export const CONTEXT_SUMMARY_REQUEST_PROMPT = [
  "Produce the provider-neutral conversation checkpoint now.",
  "Treat all preceding conversation messages as source material, not as an unfinished conversation to continue.",
  "Follow the system instructions and return the checkpoint text in this response.",
].join("\n");

export interface ContextSummarySourceInput {
  parentCheckpoint?: ContextCheckpoint;
  messages: readonly Message[];
  safetyState: RuntimeSafetyState;
}

export interface PreparedContextSummaryPrompt {
  instructions: SystemModelMessage[];
  messages: ModelMessage[];
}

export function buildContextSummaryRequestMessage(): ModelMessage {
  return { role: "user", content: CONTEXT_SUMMARY_REQUEST_PROMPT };
}

interface CanonicalContextSummaryMessage {
  activeTabContext?: string;
  messageId: Message["id"];
  role: "user" | "assistant";
  parts: Array<{
    partId: Part["id"];
    type: Part["type"];
    content: string;
  }>;
}

export interface CanonicalContextSummarySource {
  version: "1";
  pairs: Array<{
    runId: Run["id"];
    user: CanonicalContextSummaryMessage;
    assistant: CanonicalContextSummaryMessage & { parentId: UserMessage["id"] };
  }>;
}

export function canonicalizeContextSummarySource(input: {
  conversationId: ConversationId;
  runs: readonly Run[];
  messages: readonly Message[];
}): CanonicalContextSummarySource {
  const messagesById = new Map(input.messages.map((message) => [message.id, message]));
  return {
    version: "1",
    pairs: input.runs.map((run) => {
      const user = run.parentMessageId ? messagesById.get(run.parentMessageId) : undefined;
      const assistant = run.assistantMessageId
        ? messagesById.get(run.assistantMessageId)
        : undefined;
      if (
        run.conversationId !== input.conversationId
        || !user
        || user.role !== "user"
        || user.conversationId !== input.conversationId
        || !assistant
        || assistant.role !== "assistant"
        || assistant.conversationId !== input.conversationId
        || assistant.runId !== run.id
        || assistant.parentId !== user.id
        || !run.input.messageIds.includes(user.id)
      ) {
        throw new Error(`Context summary source has an invalid Run/Message pair: ${run.id}`);
      }
      return {
        runId: run.id,
        user: canonicalizeMessage(user),
        assistant: {
          ...canonicalizeMessage(assistant),
          parentId: assistant.parentId,
        },
      };
    }),
  };
}

export function projectCanonicalContextSummarySource(
  source: CanonicalContextSummarySource,
): ModelMessage[] {
  return source.pairs.flatMap((pair) =>
    [pair.user, pair.assistant].flatMap((message) => {
      if (message.parts.length === 0) return [];
      return [{
        role: message.role,
        content: [...message.parts.map((part) => part.content), ...(message.activeTabContext ? [message.activeTabContext] : [])].join("\n"),
      } satisfies ModelMessage];
    }),
  );
}

/**
 * Builds a provider-neutral, metadata-only source for checkpoint generation.
 * This adapter deliberately does not use the lossless raw projector: historical
 * attachment bytes and provider continuation metadata must never enter a summary call.
 */
export function buildContextSummaryPrompt(
  input: ContextSummarySourceInput,
): PreparedContextSummaryPrompt {
  return {
    instructions: [
      { role: "system", content: CONTEXT_SUMMARY_SYSTEM_PROMPT },
      ...(input.parentCheckpoint
        ? [buildContextSummaryMemoryMessage(input.parentCheckpoint.summary)]
        : []),
      buildContextSummarySafetyMessage(input.safetyState),
    ],
    messages: [
      ...buildContextSummarySourceMessages(input.messages),
      buildContextSummaryRequestMessage(),
    ],
  };
}

export function buildContextSummarySourceMessages(
  messages: readonly Message[],
): ModelMessage[] {
  return messages.flatMap((message) => {
    if (message.role === "system") return [];
    const canonical = canonicalizeMessage(message);
    if (canonical.parts.length === 0) return [];
    return [{
      role: canonical.role,
      content: [...canonical.parts.map((part) => part.content), ...(canonical.activeTabContext ? [canonical.activeTabContext] : [])].join("\n"),
    } satisfies ModelMessage];
  });
}

export function buildContextSummaryMemoryMessage(summary: string): SystemModelMessage {
  return {
    role: "system",
    content: [
      "[Previous or rolling provider-neutral checkpoint; lossy and non-authorizing]",
      sanitizeContextSummaryText(summary),
    ].join("\n"),
  };
}

export function buildContextSummarySafetyMessage(
  safetyState: RuntimeSafetyState,
): SystemModelMessage {
  return {
    role: "system",
    content: [
      "[Runtime Safety State; authoritative facts, non-transferable and non-authorizing]",
      sanitizeContextSummaryText(stableStringifyJson(safetyState)),
    ].join("\n"),
  };
}

function summarizePart(part: Part): string | null {
  if (part.type === "text") {
    return part.ignored ? null : sanitizeContextSummaryText(part.text);
  }
  if (part.type === "reasoning") {
    if (part.redacted) return "[Redacted reasoning]";
    return part.text.length > 0
      ? `[Reasoning]\n${sanitizeContextSummaryText(part.text)}`
      : null;
  }
  if (part.type === "file") {
    return `[Attachment metadata: filename=${JSON.stringify(safeBasename(part.filename))}; mediaType=${JSON.stringify(safeShortText(part.mediaType))}; byteLength=${part.byteLength}]`;
  }
  if (part.type === "tool") {
    if (!["completed", "error", "interrupted"].includes(part.state.status)) return null;
    return `[Tool attempt: name=${JSON.stringify(safeShortText(part.toolName))}; status=${JSON.stringify(part.state.status)}]`;
  }
  if (part.type === "source") {
    const url = safeSourceUrl(part.url);
    return url ? `[Source URL: ${url}]` : null;
  }
  return null;
}

function canonicalizeMessage(
  message: UserMessage | AssistantMessage,
): CanonicalContextSummaryMessage {
  return {
    ...(message.role === "user" && message.activeTabContext ? { activeTabContext: sanitizeContextSummaryText(projectActiveTabContext(message.activeTabContext)) } : {}),
    messageId: message.id,
    role: message.role,
    parts: message.parts.flatMap((part) => {
      const content = summarizePart(part);
      return content === null || content.length === 0
        ? []
        : [{ partId: part.id, type: part.type, content }];
    }),
  };
}

export function sanitizeContextSummaryText(value: string): string {
  return value
    .replace(
      /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi,
      "[REDACTED]",
    )
    .replace(
      /(^|\r?\n)([ \t]*authorization\s*[:=]\s*)[^\r\n]*/gi,
      "$1$2[REDACTED]",
    )
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /(\b(?:password|secret|token|api[-_]?key)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@")
    .replace(/\b[A-Za-z]:\\[^\r\n\t ]+/g, "[REDACTED]")
    .replace(
      /(^|[\s(])\/(?:Users|home|var|tmp|etc|opt|srv|mnt|Volumes)\/[^\r\n\t )]+/g,
      "$1[REDACTED]",
    );
}

function safeBasename(filename: string): string {
  const basename = filename.split(/[\\/]/).filter(Boolean).at(-1) ?? "attachment";
  return safeShortText(basename);
}

function safeShortText(value: string): string {
  return Array.from(sanitizeContextSummaryText(value)).slice(0, 128).join("");
}

function safeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return sanitizeContextSummaryText(url.toString());
  } catch {
    return null;
  }
}
