import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import type { ToolErrorCode, ToolResult } from "../core/types";
import type { NetworkAccessScope } from "../../settings/contracts";

export const WEB_FETCH_DEFAULT_TIMEOUT_MS = 10_000;
export const WEB_FETCH_DEFAULT_MAX_BYTES = 32_768;
export const WEB_FETCH_ABSOLUTE_MAX_BYTES = WEB_FETCH_DEFAULT_MAX_BYTES;
export const WEB_FETCH_MAX_REDIRECTS = 5;
export const NETWORK_ACCESS_SCOPE_DENIED = "NETWORK_ACCESS_SCOPE_DENIED";
export const NETWORK_ACCESS_SCOPE_DENIED_MESSAGE =
  "当前网络访问范围设为“仅公网”，不能访问本地或私有网络目标。";
export const NETWORK_ACCESS_SCOPE_DENIED_GUIDANCE = [
  "只有当完成用户请求确实需要该目标时，告知用户可在“设置 → AI 能力 → 偏好设置 → 网络访问范围”中改为“本地网络与公网”；不要自动修改该偏好。",
  "在用户未修改该设置前，不要重复调用同一被拒绝目标。",
] as const;

export function networkAccessScopeDeniedDetails(): Record<string, unknown> {
  return {
    policy: "network_access_scope",
    accessScope: "public-only",
    remediation: {
      action: "change_runtime_setting",
      setting: "network_policy.access_scope",
      suggestedValue: "local-and-public",
      takesEffect: "new_run",
    },
    guidance: [...NETWORK_ACCESS_SCOPE_DENIED_GUIDANCE],
  };
}

export const webFetchInputSchema = z
  .object({
    url: z.string().url(),
    maxBytes: z.number().int().positive().max(WEB_FETCH_ABSOLUTE_MAX_BYTES).optional(),
  })
  .strict()
  .refine((input) => {
    const url = new URL(input.url);
    return url.protocol === "http:" || url.protocol === "https:";
  }, "Only http and https URLs are supported");

export type WebFetchInput = z.infer<typeof webFetchInputSchema>;

export interface WebFetchOutput {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title?: string;
  preview: string;
  truncated: boolean;
  bytesRead: number;
}

export interface WebFetchDependencies {
  fetch?: WebFetchFunction;
  fetchConnection?: WebFetchConnectionFunction;
  resolveAddress?: WebFetchAddressResolver;
  onTunFakeIpAccepted?: (event: WebFetchTunFakeIpEvent) => void;
  onResolvedAddressBlocked?: (event: WebFetchResolvedAddressEvent) => void;
  abortSignal?: AbortSignal;
  now?: () => number;
  timeoutMs?: number;
  maxRedirects?: number;
  networkAccessScope?: NetworkAccessScope;
}

export type WebFetchFunction = (input: URL | string, init?: RequestInit) => Promise<Response>;
export type WebFetchConnectionFunction = (
  url: URL,
  init: WebFetchConnectionInit,
) => Promise<WebFetchConnectionResult>;
export type WebFetchAddressResolver = (hostname: string) => Promise<WebFetchResolvedAddress[]>;

export interface WebFetchConnectionInit {
  signal: AbortSignal;
  headers: Record<string, string>;
  resolveAddress: WebFetchAddressResolver;
  onTunFakeIpAccepted?: (event: WebFetchTunFakeIpEvent) => void;
  onResolvedAddressBlocked?: (event: WebFetchResolvedAddressEvent) => void;
  started: number;
  now: () => number;
  networkAccessScope: NetworkAccessScope;
}

export type WebFetchConnectionResult =
  | { response: Response }
  | { error: ToolResult<WebFetchOutput> };

export interface WebFetchResolvedAddress {
  address: string;
  family?: number | string;
}

export interface WebFetchTunFakeIpEvent {
  hostname: string;
  address: string;
}

export interface WebFetchResolvedAddressEvent {
  hostname: string;
  address: string;
}

export interface WebFetchLookupOptions {
  all?: boolean;
}

export type WebFetchLookupCallback = (
  error: Error | null,
  address: string | Array<{ address: string; family: 4 | 6 }>,
  family?: 4 | 6 | 0,
) => void;

export type WebFetchLookupFunction = (
  hostname: string,
  options: WebFetchLookupOptions,
  callback: WebFetchLookupCallback,
) => void;

export async function executeWebFetch(
  rawInput: unknown,
  deps: WebFetchDependencies = {},
): Promise<ToolResult<WebFetchOutput>> {
  const now = deps.now ?? Date.now;
  const started = now();
  const parsed = webFetchInputSchema.safeParse(rawInput);

  if (!parsed.success) {
    return errorResult("VALIDATION_ERROR", "Invalid web_fetch input", false, started, now(), {
      issues: parsed.error.issues,
    });
  }

  const input = parsed.data;
  const networkAccessScope = deps.networkAccessScope ?? "public-only";
  const url = new URL(input.url);
  const resolveAddress = deps.resolveAddress ?? defaultResolveAddress;
  const fetchConnection =
    deps.fetchConnection ??
    (deps.fetch
      ? createFetchConnectionFromFetch(deps.fetch)
      : fetchWithValidatedConnection);
  const reportedTunFakeIps = new Set<string>();
  const onTunFakeIpAccepted = deps.onTunFakeIpAccepted
    ? (event: WebFetchTunFakeIpEvent) => {
        const key = `${event.hostname}\0${event.address}`;
        if (reportedTunFakeIps.has(key)) return;
        reportedTunFakeIps.add(key);
        deps.onTunFakeIpAccepted?.(event);
      }
    : undefined;
  const reportedBlockedAddresses = new Set<string>();
  const onResolvedAddressBlocked = deps.onResolvedAddressBlocked
    ? (event: WebFetchResolvedAddressEvent) => {
        const key = `${event.hostname}\0${event.address}`;
        if (reportedBlockedAddresses.has(key)) return;
        reportedBlockedAddresses.add(key);
        deps.onResolvedAddressBlocked?.(event);
      }
    : undefined;

  const abortController = new AbortController();
  const abortSignalLink = linkAbortSignal(abortController, deps.abortSignal);
  const timeout = setTimeout(
    () => abortController.abort("timeout"),
    deps.timeoutMs ?? WEB_FETCH_DEFAULT_TIMEOUT_MS,
  );

  try {
    const fetched = await fetchPublicResponse({
      url,
      fetchConnection,
      resolveAddress,
      onTunFakeIpAccepted,
      onResolvedAddressBlocked,
      signal: abortController.signal,
      maxRedirects: deps.maxRedirects ?? WEB_FETCH_MAX_REDIRECTS,
      networkAccessScope,
      started,
      now,
    });
    if ("error" in fetched) {
      return fetched.error;
    }

    const { response, finalUrl } = fetched;
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";

    if (!response.ok) {
      return errorResult(
        "HTTP_ERROR",
        `web_fetch received HTTP ${response.status}`,
        response.status >= 500,
        started,
        now(),
        { status: response.status, url: finalUrl.toString() },
      );
    }

    if (!isSupportedContentType(contentType)) {
      return errorResult(
        "UNSUPPORTED_CONTENT_TYPE",
        `Unsupported content type: ${contentType}`,
        false,
        started,
        now(),
        { contentType },
      );
    }

    const maxBytes = input.maxBytes ?? WEB_FETCH_DEFAULT_MAX_BYTES;
    const { text, bytesRead, truncated } = await readBoundedText(response, maxBytes);
    const finalUrlText = finalUrl.toString();
    const parsedContent = isHtmlContentType(contentType)
      ? parseHtmlPreview(text)
      : { preview: normalizeTextPreview(text) };
    const title = parsedContent.title ?? finalUrl.hostname;
    const preview = parsedContent.preview.slice(0, maxBytes);
    const completed = now();

    return {
      ok: true,
      output: {
        data: {
          url: url.toString(),
          finalUrl: finalUrlText,
          status: response.status,
          contentType,
          title,
          preview,
          truncated,
          bytesRead,
        },
        display: {
          title,
          summary: truncated
            ? "Fetched a truncated web page preview."
            : "Fetched a web page preview.",
          sourceUrl: finalUrlText,
        },
      },
      metadata: {
        started,
        completed,
        durationMs: completed - started,
        truncated,
        contentType,
        bytesRead,
      },
    };
  } catch (error) {
    const completed = now();
    const aborted =
      abortController.signal.aborted ||
      (error instanceof DOMException && error.name === "AbortError");
    if (aborted) {
      const abortDetails = getAbortErrorDetails(abortController.signal);
      return errorResult(
        "TIMEOUT",
        abortDetails.message,
        false,
        started,
        completed,
        abortDetails.details,
      );
    }

    return errorResult(
      "NETWORK_ERROR",
      error instanceof Error ? error.message : String(error),
      true,
      started,
      completed,
    );
  } finally {
    clearTimeout(timeout);
    abortSignalLink.cleanup();
  }
}

export function isBlockedWebFetchHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const ipVersion = isIP(host);
  if (!host.includes(".") && ipVersion === 0) return true;
  if (ipVersion === 6) return isBlockedIpv6(host);
  if (ipVersion !== 4) return false;

  const address = ipv4ToNumber(host);
  return (
    isIpv4InCidr(address, "0.0.0.0", 8) ||
    isIpv4InCidr(address, "10.0.0.0", 8) ||
    isIpv4InCidr(address, "100.64.0.0", 10) ||
    isIpv4InCidr(address, "127.0.0.0", 8) ||
    isIpv4InCidr(address, "169.254.0.0", 16) ||
    isIpv4InCidr(address, "172.16.0.0", 12) ||
    isIpv4InCidr(address, "192.0.0.0", 24) ||
    isIpv4InCidr(address, "192.0.2.0", 24) ||
    isIpv4InCidr(address, "192.88.99.0", 24) ||
    isIpv4InCidr(address, "192.168.0.0", 16) ||
    isIpv4InCidr(address, "198.18.0.0", 15) ||
    isIpv4InCidr(address, "198.51.100.0", 24) ||
    isIpv4InCidr(address, "203.0.113.0", 24) ||
    isIpv4InCidr(address, "224.0.0.0", 4) ||
    isIpv4InCidr(address, "240.0.0.0", 4)
  );
}

export function isTunFakeIpAddress(address: string): boolean {
  const host = normalizeHostname(address);
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    return isIpv4InCidr(ipv4ToNumber(host), "198.18.0.0", 15);
  }
  if (ipVersion !== 6) return false;

  const expanded = expandIpv6(host);
  return expanded
    ? isIpv6InCidr(
        expanded,
        "fdfe:dcba:9876:0000:0000:0000:0000:0000",
        64,
      )
    : false;
}

async function fetchPublicResponse(input: {
  url: URL;
  fetchConnection: WebFetchConnectionFunction;
  resolveAddress: WebFetchAddressResolver;
  onTunFakeIpAccepted?: (event: WebFetchTunFakeIpEvent) => void;
  onResolvedAddressBlocked?: (event: WebFetchResolvedAddressEvent) => void;
  signal: AbortSignal;
  maxRedirects: number;
  networkAccessScope: NetworkAccessScope;
  started: number;
  now: () => number;
}): Promise<{ response: Response; finalUrl: URL } | { error: ToolResult<WebFetchOutput> }> {
  let currentUrl = input.url;

  for (let redirectCount = 0; redirectCount <= input.maxRedirects; redirectCount += 1) {
    const validationError = await validatePublicHttpUrl(
      currentUrl,
      input.resolveAddress,
      input.started,
      input.now,
      input.onTunFakeIpAccepted,
      input.onResolvedAddressBlocked,
      input.networkAccessScope,
    );
    if (validationError) {
      return { error: validationError };
    }

    const fetched = await input.fetchConnection(currentUrl, {
      signal: input.signal,
      headers: {
        "user-agent": "NexusPilot-AI-Runtime/1.0",
        accept:
          "text/html,text/plain,text/markdown,application/json,application/xml,text/xml,*/*;q=0.1",
      },
      resolveAddress: input.resolveAddress,
      onTunFakeIpAccepted: input.onTunFakeIpAccepted,
      onResolvedAddressBlocked: input.onResolvedAddressBlocked,
      started: input.started,
      now: input.now,
      networkAccessScope: input.networkAccessScope,
    });
    if ("error" in fetched) {
      return { error: fetched.error };
    }

    const response = fetched.response;
    const responseUrl = response.url ? new URL(response.url) : currentUrl;

    if (response.url && responseUrl.toString() !== currentUrl.toString()) {
      const responseUrlValidationError = await validatePublicHttpUrl(
        responseUrl,
        input.resolveAddress,
        input.started,
        input.now,
        input.onTunFakeIpAccepted,
        input.onResolvedAddressBlocked,
        input.networkAccessScope,
      );
      if (responseUrlValidationError) {
        return { error: responseUrlValidationError };
      }
    }

    if (!isRedirectStatus(response.status)) {
      return { response, finalUrl: responseUrl };
    }

    const location = response.headers.get("location");
    if (!location) {
      await response.body?.cancel();
      return {
        error: errorResult(
          "HTTP_ERROR",
          "Redirect response is missing a Location header",
          false,
          input.started,
          input.now(),
          { status: response.status, url: responseUrl.toString() },
        ),
      };
    }

    if (redirectCount === input.maxRedirects) {
      await response.body?.cancel();
      return {
        error: errorResult(
          "HTTP_ERROR",
          "web_fetch exceeded the redirect limit",
          false,
          input.started,
          input.now(),
          { redirects: redirectCount, url: responseUrl.toString() },
        ),
      };
    }

    await response.body?.cancel();
    currentUrl = new URL(location, responseUrl);
  }

  return {
    error: errorResult(
      "HTTP_ERROR",
      "web_fetch exceeded the redirect limit",
      false,
      input.started,
      input.now(),
      { redirects: input.maxRedirects },
    ),
  };
}

function linkAbortSignal(
  controller: AbortController,
  source: AbortSignal | undefined,
): { cleanup: () => void } {
  if (!source) {
    return { cleanup: () => undefined };
  }

  const abort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(source.reason ?? "aborted");
    }
  };

  if (source.aborted) {
    abort();
    return { cleanup: () => undefined };
  }

  source.addEventListener("abort", abort, { once: true });
  return {
    cleanup: () => {
      source.removeEventListener("abort", abort);
    },
  };
}

function getAbortErrorDetails(signal: AbortSignal): {
  message: string;
  details: Record<string, unknown>;
} {
  const reason = signal.reason;
  const reasonText = typeof reason === "string" ? reason : reason ? String(reason) : undefined;
  const timedOut = reasonText === "timeout" || reasonText?.toLowerCase().includes("timeout");

  return {
    message: timedOut ? "web_fetch timed out" : "web_fetch was interrupted",
    details: {
      interrupted: !timedOut,
      ...(reasonText ? { reason: reasonText } : {}),
    },
  };
}

function createFetchConnectionFromFetch(fetchImpl: WebFetchFunction): WebFetchConnectionFunction {
  return async (url, init) => ({
    response: await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: init.signal,
      headers: init.headers,
    }),
  });
}

async function fetchWithValidatedConnection(
  url: URL,
  init: WebFetchConnectionInit,
): Promise<WebFetchConnectionResult> {
  const requester = url.protocol === "https:" ? https.request : http.request;

  return await new Promise<WebFetchConnectionResult>((resolve) => {
    let settled = false;
    let connectionValidationError: ToolResult<WebFetchOutput> | null = null;

    const settle = (result: WebFetchConnectionResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const request = requester(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: init.headers,
        signal: init.signal,
        lookup: createWebFetchLookup({
          resolveAddress: init.resolveAddress,
          started: init.started,
          now: init.now,
          onTunFakeIpAccepted: init.onTunFakeIpAccepted,
          onResolvedAddressBlocked: init.onResolvedAddressBlocked,
          networkAccessScope: init.networkAccessScope,
          onValidationError: (error) => {
            connectionValidationError = error;
          },
        }),
      },
      (incoming) => {
        const headers = headersFromIncomingMessage(incoming.headers);
        const body = Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>;
        settle({
          response: new Response(body, {
            status: incoming.statusCode ?? 0,
            statusText: incoming.statusMessage,
            headers,
          }),
        });
      },
    );

    request.on("error", (error) => {
      if (connectionValidationError) {
        settle({ error: connectionValidationError });
        return;
      }

      const aborted = init.signal.aborted;
      if (aborted) {
        const abortDetails = getAbortErrorDetails(init.signal);
        settle({
          error: errorResult(
            "TIMEOUT",
            abortDetails.message,
            false,
            init.started,
            init.now(),
            abortDetails.details,
          ),
        });
        return;
      }

      settle({
        error: errorResult(
          "NETWORK_ERROR",
          error.message,
          true,
          init.started,
          init.now(),
        ),
      });
    });

    request.end();
  });
}

export function createWebFetchLookup(input: {
  resolveAddress: WebFetchAddressResolver;
  started: number;
  now: () => number;
  onValidationError: (error: ToolResult<WebFetchOutput>) => void;
  onTunFakeIpAccepted?: (event: WebFetchTunFakeIpEvent) => void;
  onResolvedAddressBlocked?: (event: WebFetchResolvedAddressEvent) => void;
  networkAccessScope?: NetworkAccessScope;
}): WebFetchLookupFunction {
  return (hostname, options, callback) => {
    const normalized = normalizeHostname(String(hostname));
    input
      .resolveAddress(normalized)
      .then((addresses) => {
        const validationError = validateResolvedAddresses(
          normalized,
          addresses,
          input.started,
          input.now,
          input.onTunFakeIpAccepted,
          input.onResolvedAddressBlocked,
          input.networkAccessScope ?? "public-only",
        );
        if (validationError) {
          input.onValidationError(validationError);
          callback(
            new Error(validationError.error?.message ?? "Blocked resolved address"),
            lookupWantsAllResults(options) ? [] : "",
            0,
          );
          return;
        }

        if (lookupWantsAllResults(options)) {
          callback(null, addresses.map(toLookupAddress));
          return;
        }

        const address = addresses[0]!;
        callback(null, address.address, addressFamily(address));
      })
      .catch((error) => {
        callback(
          error instanceof Error ? error : new Error(String(error)),
          lookupWantsAllResults(options) ? [] : "",
          0,
        );
      });
  };
}

async function validatePublicHttpUrl(
  url: URL,
  resolveAddress: WebFetchAddressResolver,
  started: number,
  now: () => number,
  onTunFakeIpAccepted?: (event: WebFetchTunFakeIpEvent) => void,
  onResolvedAddressBlocked?: (event: WebFetchResolvedAddressEvent) => void,
  networkAccessScope: NetworkAccessScope = "public-only",
): Promise<ToolResult<WebFetchOutput> | null> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return errorResult("VALIDATION_ERROR", "Only http and https URLs are supported", false, started, now(), {
      url: url.toString(),
    });
  }

  const hostname = normalizeHostname(url.hostname);
  if (
    networkAccessScope === "public-only" &&
    isBlockedWebFetchHostname(hostname)
  ) {
    return networkAccessScopeDeniedResult(started, now());
  }

  if (isIP(hostname) !== 0) {
    return null;
  }

  try {
    const addresses = await resolveAddress(hostname);
    if (addresses.length === 0) {
      return errorResult(
        "NETWORK_ERROR",
        "Hostname did not resolve to an address",
        false,
        started,
        now(),
        {
          hostname,
        },
      );
    }

    return validateResolvedAddresses(
      hostname,
      addresses,
      started,
      now,
      onTunFakeIpAccepted,
      onResolvedAddressBlocked,
      networkAccessScope,
    );
  } catch (error) {
    return errorResult(
      "NETWORK_ERROR",
      error instanceof Error ? error.message : String(error),
      true,
      started,
      now(),
      { hostname },
    );
  }

  return null;
}

function validateResolvedAddresses(
  hostname: string,
  addresses: WebFetchResolvedAddress[],
  started: number,
  now: () => number,
  onTunFakeIpAccepted?: (event: WebFetchTunFakeIpEvent) => void,
  onResolvedAddressBlocked?: (event: WebFetchResolvedAddressEvent) => void,
  networkAccessScope: NetworkAccessScope = "public-only",
): ToolResult<WebFetchOutput> | null {
  if (addresses.length === 0) {
    return errorResult(
      "NETWORK_ERROR",
      "Hostname did not resolve to an address",
      false,
      started,
      now(),
      { hostname },
    );
  }

  const normalizedHostname = normalizeHostname(hostname);
  if (networkAccessScope === "local-and-public") {
    return null;
  }
  const canUseTunFakeIp =
    isIP(normalizedHostname) === 0 &&
    normalizedHostname.includes(".") &&
    normalizedHostname !== "localhost" &&
    !normalizedHostname.endsWith(".localhost");
  const acceptedTunFakeIps: WebFetchTunFakeIpEvent[] = [];
  const blockedAddress = addresses.find((address) => {
    if (!isBlockedWebFetchHostname(address.address)) {
      return false;
    }

    if (canUseTunFakeIp && isTunFakeIpAddress(address.address)) {
      acceptedTunFakeIps.push({
        hostname: normalizedHostname,
        address: normalizeHostname(address.address),
      });
      return false;
    }

    return true;
  });
  if (blockedAddress) {
    onResolvedAddressBlocked?.({
      hostname: normalizedHostname,
      address: normalizeHostname(blockedAddress.address),
    });
    return networkAccessScopeDeniedResult(started, now());
  }

  for (const event of acceptedTunFakeIps) {
    onTunFakeIpAccepted?.(event);
  }

  return null;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function defaultResolveAddress(hostname: string): Promise<WebFetchResolvedAddress[]> {
  return (await lookup(hostname, { all: true })).map((address) => ({
    address: address.address,
    family: address.family,
  }));
}

function addressFamily(address: WebFetchResolvedAddress): 4 | 6 {
  if (address.family === 4 || address.family === "4" || address.family === "IPv4") return 4;
  if (address.family === 6 || address.family === "6" || address.family === "IPv6") return 6;
  return isIP(address.address) === 6 ? 6 : 4;
}

function toLookupAddress(address: WebFetchResolvedAddress): { address: string; family: 4 | 6 } {
  return {
    address: address.address,
    family: addressFamily(address),
  };
}

function lookupWantsAllResults(options: WebFetchLookupOptions): boolean {
  return options.all === true;
}

function headersFromIncomingMessage(headers: IncomingHttpHeaders): Headers {
  const output = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        output.append(name, item);
      }
      continue;
    }

    output.set(name, value);
  }

  return output;
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function ipv4ToNumber(address: string): number {
  return address
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .reduce((result, part) => ((result << 8) | part) >>> 0, 0);
}

function isIpv4InCidr(address: number, base: string, prefixLength: number): boolean {
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (address & mask) === (ipv4ToNumber(base) & mask);
}

function isBlockedIpv6(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  const mappedIpv4 = parseIpv4MappedIpv6(host);
  if (mappedIpv4) {
    return isBlockedWebFetchHostname(mappedIpv4);
  }

  if (host === "::" || host === "::1") {
    return true;
  }

  const normalized = expandIpv6(host);
  if (!normalized) return true;

  return (
    isIpv6InCidr(normalized, "0064:ff9b:0000:0000:0000:0000:0000:0000", 96) ||
    isIpv6InCidr(normalized, "0064:ff9b:0001:0000:0000:0000:0000:0000", 48) ||
    isIpv6InCidr(normalized, "0000:0000:0000:0000:0000:0000:0000:0000", 8) ||
    isIpv6InCidr(normalized, "0100:0000:0000:0000:0000:0000:0000:0000", 64) ||
    isIpv6InCidr(normalized, "2001:0000:0000:0000:0000:0000:0000:0000", 23) ||
    isIpv6InCidr(normalized, "2001:0002:0000:0000:0000:0000:0000:0000", 48) ||
    isIpv6InCidr(normalized, "2001:0db8:0000:0000:0000:0000:0000:0000", 32) ||
    isIpv6InCidr(normalized, "2002:0000:0000:0000:0000:0000:0000:0000", 16) ||
    isIpv6InCidr(normalized, "fc00:0000:0000:0000:0000:0000:0000:0000", 7) ||
    isIpv6InCidr(normalized, "fe80:0000:0000:0000:0000:0000:0000:0000", 10) ||
    isIpv6InCidr(normalized, "ff00:0000:0000:0000:0000:0000:0000:0000", 8)
  );
}

function expandIpv6(hostname: string): number[] | null {
  let host = normalizeHostname(hostname);
  const embeddedIpv4 = /(.+):(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (embeddedIpv4) {
    const ipv4 = ipv4ToNumber(embeddedIpv4[2]);
    host = `${embeddedIpv4[1]}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }

  const compressed = host.split("::");
  if (compressed.length > 2) return null;

  const left = compressed[0] ? compressed[0].split(":") : [];
  const right = compressed.length === 2 && compressed[1] ? compressed[1].split(":") : [];
  const missing = compressed.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0) return null;

  const parts = compressed.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (parts.length !== 8) return null;

  const parsed = parts.map((part) => Number.parseInt(part, 16));
  if (parsed.some((part) => Number.isNaN(part) || part < 0 || part > 0xffff)) {
    return null;
  }

  return parsed;
}

function isIpv6InCidr(address: number[], base: string, prefixLength: number): boolean {
  const baseAddress = expandIpv6(base);
  if (!baseAddress) return false;

  let remaining = prefixLength;
  for (let index = 0; index < 8; index += 1) {
    const bits = Math.min(remaining, 16);
    if (bits <= 0) return true;

    const mask = (0xffff << (16 - bits)) & 0xffff;
    if ((address[index] & mask) !== (baseAddress[index] & mask)) {
      return false;
    }

    remaining -= bits;
  }

  return true;
}

function parseIpv4MappedIpv6(hostname: string): string | null {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(hostname)?.[1];
  if (dotted) {
    return dotted;
  }

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(hostname);
  if (!hex) {
    return null;
  }

  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  if (Number.isNaN(high) || Number.isNaN(low) || high > 0xffff || low > 0xffff) {
    return null;
  }

  return [
    (high >> 8) & 0xff,
    high & 0xff,
    (low >> 8) & 0xff,
    low & 0xff,
  ].join(".");
}

function isSupportedContentType(contentType: string): boolean {
  const type = baseContentType(contentType);
  return Boolean(
    type &&
      (type.startsWith("text/") ||
        type === "application/json" ||
        type === "application/xml" ||
        type === "application/xhtml+xml"),
  );
}

function baseContentType(contentType: string): string | undefined {
  return contentType.split(";")[0]?.trim().toLowerCase() || undefined;
}

function isHtmlContentType(contentType: string): boolean {
  const type = baseContentType(contentType);
  return type === "text/html" || type === "application/xhtml+xml";
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<{
  text: string;
  bytesRead: number;
  truncated: boolean;
}> {
  const reader = response.body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;
    let truncated = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      const remaining = maxBytes - bytesRead;
      if (value.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(value.slice(0, remaining));
          bytesRead += remaining;
        }
        truncated = true;
        await reader.cancel();
        break;
      }

      chunks.push(value);
      bytesRead += value.byteLength;
    }

    return {
      text: new TextDecoder().decode(concatBytes(chunks, bytesRead)),
      bytesRead,
      truncated,
    };
  }

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const truncated = bytes.byteLength > maxBytes;
  const bounded = truncated ? bytes.slice(0, maxBytes) : bytes;

  return {
    text: new TextDecoder().decode(bounded),
    bytesRead: bounded.byteLength,
    truncated,
  };
}

function concatBytes(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];
type HtmlTextNode = DefaultTreeAdapterMap["textNode"];

interface ParsedHtmlPreview {
  title?: string;
  preview: string;
}

const HIDDEN_HTML_ELEMENTS = new Set(["script", "style", "noscript", "template"]);
const TEXT_BOUNDARY_HTML_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "br",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

function parseHtmlPreview(text: string): ParsedHtmlPreview {
  const document = parse(text);
  const titleElement = findHtmlElement(document, "title");
  const bodyElement = findHtmlElement(document, "body");

  return {
    title: titleElement ? normalizeTextPreview(extractHtmlText(titleElement)) || undefined : undefined,
    preview: bodyElement ? normalizeTextPreview(extractHtmlText(bodyElement)) : "",
  };
}

function findHtmlElement(node: HtmlNode, tagName: string): HtmlElement | undefined {
  if (isHtmlElement(node) && node.tagName.toLowerCase() === tagName) {
    return node;
  }

  if (!("childNodes" in node)) {
    return undefined;
  }

  for (const child of node.childNodes) {
    const match = findHtmlElement(child, tagName);
    if (match) {
      return match;
    }
  }

  return undefined;
}

function extractHtmlText(node: HtmlNode): string {
  const chunks: string[] = [];
  appendHtmlText(node, chunks);
  return chunks.join("");
}

function appendHtmlText(node: HtmlNode, chunks: string[]): void {
  if (isHtmlTextNode(node)) {
    chunks.push(node.value);
    return;
  }

  if (isHtmlElement(node)) {
    const tagName = node.tagName.toLowerCase();
    if (HIDDEN_HTML_ELEMENTS.has(tagName)) {
      return;
    }

    const addsBoundary = TEXT_BOUNDARY_HTML_ELEMENTS.has(tagName);
    if (addsBoundary) {
      chunks.push(" ");
    }
    for (const child of node.childNodes) {
      appendHtmlText(child, chunks);
    }
    if (addsBoundary) {
      chunks.push(" ");
    }
    return;
  }

  if ("childNodes" in node) {
    for (const child of node.childNodes) {
      appendHtmlText(child, chunks);
    }
  }
}

function isHtmlElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}

function isHtmlTextNode(node: HtmlNode): node is HtmlTextNode {
  return "value" in node;
}

function normalizeTextPreview(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function errorResult<T>(
  code: ToolErrorCode,
  message: string,
  retryable: boolean,
  started: number,
  completed: number,
  details?: Record<string, unknown>,
): ToolResult<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable,
      details,
    },
    metadata: {
      started,
      completed,
      durationMs: completed - started,
    },
  };
}

function networkAccessScopeDeniedResult<T>(
  started: number,
  completed: number,
): ToolResult<T> {
  return errorResult(
    NETWORK_ACCESS_SCOPE_DENIED,
    NETWORK_ACCESS_SCOPE_DENIED_MESSAGE,
    false,
    started,
    completed,
    networkAccessScopeDeniedDetails(),
  );
}
