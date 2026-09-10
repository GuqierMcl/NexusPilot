import type { Message, Part, ToolPart } from "../core/types";
import { projectReferencedText } from "../../../../shared/composer-references";
import { projectActiveTabContext } from "../../../../shared/active-tab-context";

export const CONTEXT_ESTIMATOR_OVERHEAD = Object.freeze({
  /** Model-message role/framing allowance. */
  message: 4,
  /** Per projected content part allowance. */
  part: 2,
  /** File container/media framing allowance; file bytes are estimated separately. */
  file: 8,
});

export function estimateTextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

export function stableStringifyJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalized = normalizeJson(value, seen, false);
  if (normalized === undefined) {
    return "null";
  }
  return JSON.stringify(normalized);
}

export function estimateJsonTokens(value: unknown): number {
  return estimateTextTokens(stableStringifyJson(value));
}

export function estimateMessageTokens(message: Message): number {
  const partTokens = message.parts
    .map((part) => estimateProjectedPartTokens(message.role, part))
    .filter((tokens) => tokens > 0);
  if (message.role === "user" && message.activeTabContext) {
    partTokens.push(CONTEXT_ESTIMATOR_OVERHEAD.part + estimateTextTokens(projectActiveTabContext(message.activeTabContext)));
  }
  if (partTokens.length === 0) {
    return 0;
  }
  return CONTEXT_ESTIMATOR_OVERHEAD.message
    + partTokens.reduce((total, tokens) => total + tokens, 0);
}

export function estimateMessagesTokens(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function estimateProjectedPartTokens(role: Message["role"], part: Part): number {
  if (part.type === "text") {
    if ((role === "user" || role === "system") && part.ignored) {
      return 0;
    }
    if (part.text.length === 0) {
      return 0;
    }
    return CONTEXT_ESTIMATOR_OVERHEAD.part
      + estimateTextTokens(role === "user" ? projectReferencedText(part) : part.text)
      + estimateOptionalMetadata(part.metadata);
  }
  if (part.type === "reasoning" && role === "assistant") {
    if (part.text.length === 0) return 0;
    return CONTEXT_ESTIMATOR_OVERHEAD.part
      + estimateTextTokens(part.text)
      + estimateOptionalMetadata(part.metadata);
  }
  if (part.type === "file" && role === "user") {
    return CONTEXT_ESTIMATOR_OVERHEAD.part
      + CONTEXT_ESTIMATOR_OVERHEAD.file
      + Math.ceil(part.byteLength / 3);
  }
  if (part.type === "tool" && role === "assistant") {
    return estimateToolPartTokens(part);
  }
  return 0;
}

function estimateToolPartTokens(part: ToolPart): number {
  const input = "input" in part.state ? (part.state.input ?? {}) : {};
  const result = part.state.status === "completed"
    ? part.state.output
    : part.state.status === "error"
      ? part.state.error
      : part.state.status === "interrupted"
        ? { reason: part.state.reason ?? "[Tool execution was interrupted]" }
        : { status: "interrupted" };
  return CONTEXT_ESTIMATOR_OVERHEAD.part
    + estimateTextTokens(part.toolName)
    + estimateJsonTokens(input)
    + estimateJsonTokens(result)
    + estimateOptionalMetadata(part.metadata);
}

function estimateOptionalMetadata(metadata: Record<string, unknown> | undefined): number {
  return metadata === undefined ? 0 : estimateJsonTokens(metadata);
}

function normalizeJson(
  value: unknown,
  seen: WeakSet<object>,
  inArray: boolean,
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    throw new TypeError("BigInt cannot be serialized as canonical JSON");
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return inArray ? null : undefined;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    throw new TypeError("Cyclic values cannot be serialized as canonical JSON");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeJson(item, seen, true));
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const normalized = normalizeJson(
        (value as Record<string, unknown>)[key],
        seen,
        false,
      );
      if (normalized !== undefined) {
        output[key] = normalized;
      }
    }
    return output;
  } finally {
    seen.delete(value);
  }
}
