import { z } from "zod";
import type { RuntimeToolNamespace } from "../kernel";

export const currentSystemTimeInputSchema = z.object({}).strict();

export const currentSystemTimeOutputSchema = z.object({
  utc: z.string().datetime(),
  localDateTime: z.string(),
  timeZone: z.string().min(1),
  utcOffsetMinutes: z.number().int(),
  epochMs: z.number().int().nonnegative(),
}).strict();

export type CurrentSystemTimeOutput = z.infer<
  typeof currentSystemTimeOutputSchema
>;

export interface CreateSystemToolNamespaceOptions {
  now?: () => Date;
  resolveTimeZone?: () => string;
}

export function createSystemToolNamespace(
  options: CreateSystemToolNamespaceOptions = {},
): RuntimeToolNamespace {
  const now = options.now ?? (() => new Date());
  const resolveTimeZone =
    options.resolveTimeZone ??
    (() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");

  return {
    id: "system",
    title: "System",
    description: "读取 AI Runtime 所在系统的安全本地信息。",
    metadata: { capabilityModel: "runtime_local" },
    tools: [{
      id: "system.current_time",
      title: "获取当前系统时间",
      description:
        "获取 AI Runtime 所在系统的当前时间、时区和 UTC 偏移。",
      metadata: { category: "system", sourceType: "runtime_clock" },
      inputSchema: currentSystemTimeInputSchema,
      outputSchema: currentSystemTimeOutputSchema,
      executionTarget: "runtime",
      risk: {
        mode: "static",
        level: "low",
        reversible: true,
        sideEffect: "none",
      },
      limits: {
        timeoutMs: 1_000,
        maxResultBytes: 4_096,
      },
      execute: async () => {
        const date = now();
        const data = currentSystemTime(date, resolveTimeZone());
        return {
          summary: `当前系统时间为 ${data.localDateTime}（${data.timeZone}）。`,
          data,
        };
      },
    }],
    resolveForRun: () => ({ candidateToolIds: ["system.current_time"] }),
  };
}

export function currentSystemTime(
  date: Date,
  timeZone: string,
): CurrentSystemTimeOutput {
  const epochMs = date.getTime();
  if (!Number.isFinite(epochMs)) {
    throw new Error("System clock returned an invalid date.");
  }
  const normalizedTimeZone = timeZone.trim() || "UTC";
  const utcOffsetMinutes = -date.getTimezoneOffset();

  return {
    utc: date.toISOString(),
    localDateTime: formatLocalDateTime(date, utcOffsetMinutes),
    timeZone: normalizedTimeZone,
    utcOffsetMinutes,
    epochMs,
  };
}

function formatLocalDateTime(date: Date, utcOffsetMinutes: number): string {
  const sign = utcOffsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(utcOffsetMinutes);
  const offsetHours = Math.floor(absoluteOffset / 60);
  const offsetMinutes = absoluteOffset % 60;

  return [
    `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`,
    `T${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`,
    `.${threeDigits(date.getMilliseconds())}`,
    `${sign}${twoDigits(offsetHours)}:${twoDigits(offsetMinutes)}`,
  ].join("");
}

function twoDigits(value: number): string {
  return value.toString().padStart(2, "0");
}

function threeDigits(value: number): string {
  return value.toString().padStart(3, "0");
}
