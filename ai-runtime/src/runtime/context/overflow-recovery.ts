import type { Conversation, Run, RunId, RuntimeError } from "../core/types";
import { toRuntimeModelError } from "../runners/model-error";

export interface ContextOverflowRetryGate {
  runId: RunId;
  attempted: boolean;
  modelOutputObserved: boolean;
  toolLifecycleObserved: boolean;
  permissionObserved: boolean;
  sideEffectObserved: boolean;
}

export function classifyContextOverflow(error: unknown): {
  overflow: boolean;
  original: RuntimeError;
} {
  const original = toRuntimeModelError(error);
  const source = readOverflowSource(error);
  if (!source) return { overflow: false, original };

  const normalized = `${source.name}\n${source.code}\n${source.message}`.toLowerCase();
  if (
    isExplicitNonOverflowCategory(source.name, source.code)
    || isExplicitNonOverflow(normalized, source.statusCode)
  ) {
    return { overflow: false, original };
  }
  const overflow = source.code === "context_length_exceeded"
    || source.message.trim().toLowerCase() === "context_length_exceeded"
    || /\bmaximum context length\b/i.test(source.message)
    || /\bcontext length exceeded\b/i.test(source.message)
    || /\bcontext window exceeded\b/i.test(source.message)
    || /\bprompt too long\b/i.test(source.message)
    || /\btoo many tokens\b/i.test(source.message);
  return { overflow, original };
}

export async function recoverContextOverflow(input: {
  error: unknown;
  gate: ContextOverflowRetryGate;
  currentRun: Run;
  currentConversation: Conversation;
}): Promise<"retry" | "fail"> {
  if (
    !classifyContextOverflow(input.error).overflow
    || input.gate.attempted
    || input.gate.runId !== input.currentRun.id
    || input.currentConversation.activeHeadRunId !== input.currentRun.id
    || input.gate.modelOutputObserved
    || input.gate.toolLifecycleObserved
    || input.gate.permissionObserved
    || input.gate.sideEffectObserved
  ) {
    return "fail";
  }
  input.gate.attempted = true;
  return "retry";
}

interface OverflowSource {
  name: string;
  code: string;
  message: string;
  statusCode?: number;
}

function readOverflowSource(error: unknown): OverflowSource | null {
  if (typeof error !== "object" || error === null || Array.isArray(error)) return null;
  const source = error as Record<string, unknown>;
  return {
    name: typeof source.name === "string" ? source.name : "",
    code: typeof source.code === "string" ? source.code.toLowerCase() : "",
    message: typeof source.message === "string" ? source.message : "",
    ...(typeof source.statusCode === "number" && Number.isFinite(source.statusCode)
      ? { statusCode: source.statusCode }
      : {}),
  };
}

function isExplicitNonOverflowCategory(name: string, code: string): boolean {
  const compact = `${name}\n${code}`.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (compact.includes("tool")) return true;
  return [
    "unsupportedmodel",
    "modelunsupported",
    "modelnotfound",
    "modeldisabled",
    "modelunavailable",
    "modelresolution",
    "modelnotconfigured",
    "unknownmodel",
  ].some((marker) => compact.includes(marker));
}

function isExplicitNonOverflow(value: string, statusCode: number | undefined): boolean {
  return statusCode === 401
    || statusCode === 403
    || statusCode === 408
    || statusCode === 429
    || [
      "auth",
      "authentication",
      "authorization",
      "credential",
      "api key",
      "api_key",
      "rate limit",
      "rate_limit",
      "network",
      "socket",
      "timeout",
      "invalidtool",
      "invalid_tool",
      "toolinput",
      "tool_input",
      "attachment",
    ].some((marker) => value.includes(marker));
}
