import pino, { type Logger } from "pino";

export type RuntimeLogger = Logger;
export type RuntimeLogFormat = "pretty" | "json";

export interface RuntimeLoggerOptions {
  color?: boolean;
  format?: RuntimeLogFormat;
  level?: string;
  write?: (line: string) => void;
}

const REDACT_PATHS = [
  "apiKey",
  "api_key",
  "authorization",
  "headers.authorization",
  "headers.cookie",
  "provider.apiKey",
  "provider.api_key",
  "connection.password",
  "connectionPayload.password",
  "request.body.apiKey",
  "request.body.api_key",
];

const RESET = "\u001b[0m";
const DIM = "\u001b[2m";
const COLORS: Record<string, string> = {
  trace: "\u001b[90m",
  debug: "\u001b[36m",
  info: "\u001b[32m",
  warn: "\u001b[33m",
  error: "\u001b[31m",
  fatal: "\u001b[35m",
};

const LEVEL_LABELS: Record<number, string> = {
  10: "TRACE",
  20: "DEBUG",
  30: "INFO",
  40: "WARN",
  50: "ERROR",
  60: "FATAL",
};

export function createRuntimeLogger(options: RuntimeLoggerOptions = {}): RuntimeLogger {
  const format = options.format ?? "pretty";
  const level = options.level ?? "info";
  const stream =
    format === "pretty"
      ? createPrettyStream(options.write, options.color ?? shouldColorizeConsole())
      : createJsonStream(options.write);

  return pino(
    {
      base: { service: "ai-runtime" },
      level,
      redact: {
        paths: REDACT_PATHS,
        censor: "[REDACTED]",
      },
      serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
      },
    },
    stream,
  );
}

export function createRuntimeLoggerFromEnv(
  env: Record<string, string | undefined> = Bun.env,
): RuntimeLogger {
  return createRuntimeLogger({
    color: shouldColorizeConsole(env),
    format: resolveLogFormat(env.NEXUS_PILOT_LOG_FORMAT),
    level: env.NEXUS_PILOT_LOG_LEVEL ?? "info",
  });
}

export function shouldColorizeConsole(
  env: Record<string, string | undefined> = Bun.env,
): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR) return true;
  return env.NEXUS_PILOT_LOG_FORMAT !== "json";
}

function resolveLogFormat(value: string | undefined): RuntimeLogFormat {
  return value === "json" ? "json" : "pretty";
}

function createJsonStream(write: ((line: string) => void) | undefined) {
  return {
    write(line: string): void {
      if (write) {
        write(line);
        return;
      }

      process.stdout.write(line);
    },
  };
}

function createPrettyStream(
  write: ((line: string) => void) | undefined,
  color: boolean,
) {
  let buffer = "";

  return {
    write(chunk: string): void {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line) continue;
        emitLine(formatPrettyLine(line, color), write);
      }
    },
  };
}

function emitLine(line: string, write: ((line: string) => void) | undefined): void {
  if (write) {
    write(line);
    return;
  }

  process.stdout.write(line);
}

function formatPrettyLine(line: string, color: boolean): string {
  try {
    const payload = JSON.parse(line) as Record<string, unknown>;
    const levelValue = typeof payload.level === "number" ? payload.level : 30;
    const levelName = LEVEL_LABELS[levelValue] ?? String(levelValue);
    const levelKey = levelName.toLowerCase();
    const time = formatTime(payload.time);
    const message = typeof payload.msg === "string" ? payload.msg : "";
    const metadata = formatMetadata(payload);
    const level = paint(levelName, COLORS[levelKey], color).padEnd(color ? levelName.length + 9 : 5);
    const timestamp = paint(time, DIM, color);
    const suffix = metadata ? ` ${paint(metadata, DIM, color)}` : "";

    return `${timestamp} ${level} ${message}${suffix}\n`;
  } catch {
    return `${line}\n`;
  }
}

function formatTime(value: unknown): string {
  const date = typeof value === "number" ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return "--:--:--";
  }

  return date.toISOString().slice(11, 19);
}

function formatMetadata(payload: Record<string, unknown>): string {
  const ignored = new Set(["level", "time", "pid", "hostname", "msg"]);
  const fields: string[] = [];

  for (const [key, value] of Object.entries(payload)) {
    if (ignored.has(key)) continue;
    fields.push(`${key}=${formatMetadataValue(value)}`);
  }

  return fields.join(" ");
}

function formatMetadataValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return JSON.stringify(value);
}

function paint(text: string, colorCode: string, enabled: boolean): string {
  return enabled ? `${colorCode}${text}${RESET}` : text;
}
