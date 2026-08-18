import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import type { NetworkAccessScope } from "../../settings/contracts";
import type { ToolError, ToolErrorCode, ToolResult } from "../core/types";
import {
  isBlockedWebFetchHostname,
  NETWORK_ACCESS_SCOPE_DENIED,
  NETWORK_ACCESS_SCOPE_DENIED_MESSAGE,
  networkAccessScopeDeniedDetails,
  type WebFetchAddressResolver,
  type WebFetchResolvedAddress,
} from "./web-fetch";

export const WEB_PING_COUNT = 3;
export const WEB_PING_PACKET_TIMEOUT_MS = 1_000;
export const WEB_PING_TIMEOUT_MS = 6_000;
const WEB_PING_OUTPUT_LIMIT_BYTES = 16_384;

export const webPingInputSchema = z.object({
  host: z.string().trim().min(1).max(253).refine(isValidPingHost, {
    message: "Host must be a hostname or IP address without a port or path.",
  }),
}).strict();

export const webPingOutputSchema = z.object({
  host: z.string().min(1),
  address: z.string().min(1),
  addressFamily: z.union([z.literal(4), z.literal(6)]),
  protocol: z.literal("icmp"),
  status: z.enum(["reachable", "unreachable"]),
  packets: z.object({
    sent: z.number().int().positive(),
    received: z.number().int().nonnegative(),
    lossPercent: z.number().min(0).max(100),
  }).strict(),
  roundTripMs: z.object({
    min: z.number().nonnegative(),
    avg: z.number().nonnegative(),
    max: z.number().nonnegative(),
  }).strict().optional(),
}).strict();

export type WebPingInput = z.infer<typeof webPingInputSchema>;
export type WebPingOutput = z.infer<typeof webPingOutputSchema>;

export interface WebPingProcess {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(): void;
}

export type WebPingSpawn = (command: readonly string[]) => WebPingProcess;

export interface WebPingDependencies {
  abortSignal?: AbortSignal;
  resolveAddress?: WebFetchAddressResolver;
  spawn?: WebPingSpawn;
  networkAccessScope?: NetworkAccessScope;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

type ResolvedPingTarget =
  | {
      ok: true;
      data: Pick<WebPingOutput, "host" | "address" | "addressFamily">;
    }
  | {
      ok: false;
      error: ToolError;
    };

export async function executeWebPing(
  rawInput: unknown,
  deps: WebPingDependencies = {},
): Promise<ToolResult<WebPingOutput>> {
  const started = Date.now();
  const parsed = webPingInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return errorResult("VALIDATION_ERROR", "Invalid web.ping input", false, started);
  }

  const host = parsed.data.host.trim();
  const networkAccessScope = deps.networkAccessScope ?? "local-and-public";
  if (deps.abortSignal?.aborted) {
    return errorResult("TIMEOUT", "web.ping was interrupted", false, started);
  }

  let target: ResolvedPingTarget;
  try {
    target = await resolvePingTarget(host, deps.resolveAddress, networkAccessScope);
  } catch (error) {
    return errorResult(
      "NETWORK_ERROR",
      error instanceof Error ? error.message : "Hostname could not be resolved.",
      true,
      started,
    );
  }
  if (!target.ok) {
    return errorResult(
      target.error.code,
      target.error.message,
      target.error.retryable,
      started,
      target.error.details,
    );
  }

  const spawn = deps.spawn ?? defaultSpawn;
  let process: WebPingProcess;
  try {
    process = spawn(buildPingCommand(
      deps.platform ?? processPlatform(),
      target.data.address,
    ));
  } catch (error) {
    return errorResult(
      "NETWORK_ERROR",
      error instanceof Error ? error.message : "web.ping could not start.",
      true,
      started,
    );
  }
  const timeoutMs = deps.timeoutMs ?? WEB_PING_TIMEOUT_MS;
  let timedOut = false;
  const stop = (): void => {
    try {
      process.kill();
    } catch {
      // The process may already have exited.
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  const onAbort = (): void => stop();
  deps.abortSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    const [exitCode, stdout] = await Promise.all([
      process.exited,
      readBoundedText(process.stdout),
      readBoundedText(process.stderr),
    ]);
    if (deps.abortSignal?.aborted) {
      return errorResult("TIMEOUT", "web.ping was interrupted", false, started);
    }
    if (timedOut) {
      return errorResult("TIMEOUT", "web.ping timed out", false, started);
    }

    const received = Math.min(WEB_PING_COUNT, countReplies(stdout));
    const reachable = exitCode === 0 || received > 0;
    const roundTripMs = parseRoundTrip(stdout);
    const data: WebPingOutput = {
      ...target.data,
      protocol: "icmp",
      status: reachable ? "reachable" : "unreachable",
      packets: {
        sent: WEB_PING_COUNT,
        received,
        lossPercent: Math.round(((WEB_PING_COUNT - received) / WEB_PING_COUNT) * 100),
      },
      ...(roundTripMs ? { roundTripMs } : {}),
    };
    const completed = Date.now();
    return {
      ok: true,
      output: {
        data,
        display: {
          summary: reachable
            ? `Ping 到 ${data.host} 可达。`
            : `Ping 到 ${data.host} 未收到回复。`,
        },
      },
      metadata: {
        started,
        completed,
        durationMs: completed - started,
      },
    };
  } catch (error) {
    return errorResult(
      "NETWORK_ERROR",
      error instanceof Error ? error.message : "web.ping could not start.",
      true,
      started,
    );
  } finally {
    clearTimeout(timer);
    deps.abortSignal?.removeEventListener("abort", onAbort);
  }
}

export function buildPingCommand(
  platform: NodeJS.Platform,
  address: string,
): readonly string[] {
  if (platform === "win32") {
    return ["ping", "-n", String(WEB_PING_COUNT), "-w", String(WEB_PING_PACKET_TIMEOUT_MS), address];
  }
  if (platform === "darwin") {
    return ["ping", "-c", String(WEB_PING_COUNT), "-W", String(WEB_PING_PACKET_TIMEOUT_MS), address];
  }
  return ["ping", "-c", String(WEB_PING_COUNT), "-W", String(Math.ceil(WEB_PING_PACKET_TIMEOUT_MS / 1_000)), address];
}

function isValidPingHost(value: string): boolean {
  const host = value.trim();
  if (isIP(stripIpv6Brackets(host)) !== 0) return true;
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host);
}

async function resolvePingTarget(
  host: string,
  resolver: WebFetchAddressResolver | undefined,
  networkAccessScope: NetworkAccessScope,
): Promise<ResolvedPingTarget> {
  const normalizedHost = stripIpv6Brackets(host);
  if (networkAccessScope === "public-only" && isBlockedWebFetchHostname(normalizedHost)) {
    return {
      ok: false,
      error: networkAccessScopeDeniedError(),
    };
  }

  const addresses = isIP(normalizedHost) === 0
    ? await (resolver ?? defaultResolveAddress)(normalizedHost)
    : [{ address: normalizedHost, family: isIP(normalizedHost) }];
  if (addresses.length === 0) {
    return {
      ok: false,
      error: { code: "NETWORK_ERROR", message: "Hostname did not resolve to an address", retryable: false },
    };
  }
  if (
    networkAccessScope === "public-only" &&
    addresses.some((address) => isBlockedWebFetchHostname(address.address))
  ) {
    return {
      ok: false,
      error: networkAccessScopeDeniedError(),
    };
  }
  const selected = addresses.find((address) => addressFamily(address) === 4) ?? addresses[0]!;
  return {
    ok: true,
    data: {
      host,
      address: selected.address,
      addressFamily: addressFamily(selected),
    },
  };
}

async function defaultResolveAddress(hostname: string): Promise<WebFetchResolvedAddress[]> {
  return (await lookup(hostname, { all: true })).map((address) => ({
    address: address.address,
    family: address.family,
  }));
}

function defaultSpawn(command: readonly string[]): WebPingProcess {
  return Bun.spawn([...command], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  }) as unknown as WebPingProcess;
}

function processPlatform(): NodeJS.Platform {
  return process.platform;
}

async function readBoundedText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < WEB_PING_OUTPUT_LIMIT_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = WEB_PING_OUTPUT_LIMIT_BYTES - bytes;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      bytes += chunk.byteLength;
    }
  } finally {
    if (bytes >= WEB_PING_OUTPUT_LIMIT_BYTES) {
      await reader.cancel();
    }
    reader.releaseLock();
  }
  return new TextDecoder().decode(concatChunks(chunks, bytes));
}

function concatChunks(chunks: readonly Uint8Array[], bytes: number): Uint8Array {
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function countReplies(output: string): number {
  return output.match(/(?:reply from|bytes from|来自)/gi)?.length ?? 0;
}

function parseRoundTrip(output: string): WebPingOutput["roundTripMs"] | null {
  const unix = /(?:min\/avg\/max(?:\/mdev)?\s*=\s*)([\d.]+)\/([\d.]+)\/([\d.]+)/i.exec(output);
  if (unix) return toRoundTrip(unix.slice(1));
  const windows = /(?:minimum|最短)\s*=\s*(\d+)ms[\s,，]+(?:maximum|最长)\s*=\s*(\d+)ms[\s,，]+(?:average|平均)\s*=\s*(\d+)ms/i.exec(output);
  if (!windows) return null;
  return toRoundTrip([windows[1], windows[3], windows[2]]);
}

function toRoundTrip(values: readonly string[]): WebPingOutput["roundTripMs"] | null {
  const [min, avg, max] = values.map((value) => Number.parseFloat(value));
  if ([min, avg, max].some((value) => !Number.isFinite(value))) return null;
  return { min, avg, max };
}

function addressFamily(address: WebFetchResolvedAddress): 4 | 6 {
  if (address.family === 6 || address.family === "6" || address.family === "IPv6") return 6;
  return isIP(address.address) === 6 ? 6 : 4;
}

function stripIpv6Brackets(value: string): string {
  return value.replace(/^\[|\]$/g, "");
}

function errorResult<T>(
  code: ToolErrorCode,
  message: string,
  retryable: boolean,
  started: number,
  details?: Record<string, unknown>,
): ToolResult<T> {
  const completed = Date.now();
  return {
    ok: false,
    error: { code, message, retryable, ...(details ? { details } : {}) },
    metadata: { started, completed, durationMs: completed - started },
  };
}

function networkAccessScopeDeniedError(): ToolError {
  return {
    code: NETWORK_ACCESS_SCOPE_DENIED,
    message: NETWORK_ACCESS_SCOPE_DENIED_MESSAGE,
    retryable: false,
    details: networkAccessScopeDeniedDetails(),
  };
}
