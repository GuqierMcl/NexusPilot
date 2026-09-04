import type { ModelExecutionError } from "../core/types";

const UNKNOWN_MODEL_ERROR_MESSAGE = "Unknown model execution error";

export function modelErrorMessage(
  error: unknown,
  secrets: readonly string[] = [],
): string {
  return toRuntimeModelError(error, secrets).data.message;
}

export function toRuntimeModelError(
  error: unknown,
  secrets: readonly string[] = [],
): ModelExecutionError {
  const source = readErrorSource(error);
  if (!source) {
    return {
      name: "UnknownError",
      data: { message: UNKNOWN_MODEL_ERROR_MESSAGE },
    };
  }

  return {
    name: source.name,
    data: {
      message: redactKnownSecrets(source.message, secrets),
      ...(source.statusCode !== undefined
        ? { statusCode: source.statusCode }
        : {}),
      ...(source.isRetryable !== undefined
        ? { isRetryable: source.isRetryable }
        : {}),
    },
  };
}

interface ErrorSource {
  name: string;
  message: string;
  statusCode?: number;
  isRetryable?: boolean;
}

function readErrorSource(error: unknown): ErrorSource | null {
  if (typeof error === "string") {
    return error.length > 0 ? { name: "Error", message: error } : null;
  }

  if (!isRecord(error)) {
    return null;
  }

  const message = typeof error.message === "string" && error.message.length > 0
    ? error.message
    : null;
  if (message === null) {
    return null;
  }

  const name = typeof error.name === "string" && error.name.length > 0
    ? error.name
    : "Error";
  const statusCode = typeof error.statusCode === "number" &&
      Number.isFinite(error.statusCode)
    ? error.statusCode
    : undefined;
  const isRetryable = typeof error.isRetryable === "boolean"
    ? error.isRetryable
    : undefined;

  return {
    name,
    message,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(isRetryable !== undefined ? { isRetryable } : {}),
  };
}

function redactKnownSecrets(
  message: string,
  secrets: readonly string[],
): string {
  let redacted = message;
  const exactSecrets = [...new Set(
    secrets.filter((value) => value.length > 0),
  )].sort((left, right) => right.length - left.length);
  for (const secret of exactSecrets) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
