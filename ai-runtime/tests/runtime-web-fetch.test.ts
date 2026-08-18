import { describe, expect, test } from "bun:test";
import {
  WEB_FETCH_DEFAULT_MAX_BYTES,
  NETWORK_ACCESS_SCOPE_DENIED,
  NETWORK_ACCESS_SCOPE_DENIED_GUIDANCE,
  createWebFetchLookup,
  executeWebFetch,
  isBlockedWebFetchHostname,
  isTunFakeIpAddress,
  webFetchInputSchema,
} from "../src/runtime/tools/web-fetch";

function response(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];

function networkAccessScopeDeniedExpectation(): object {
  return {
    ok: false,
    error: {
      code: NETWORK_ACCESS_SCOPE_DENIED,
      message: "当前网络访问范围设为“仅公网”，不能访问本地或私有网络目标。",
      retryable: false,
      details: {
        policy: "network_access_scope",
        accessScope: "public-only",
        remediation: {
          action: "change_runtime_setting",
          setting: "network_policy.access_scope",
          suggestedValue: "local-and-public",
          takesEffect: "new_run",
        },
        guidance: [...NETWORK_ACCESS_SCOPE_DENIED_GUIDANCE],
      },
    },
  };
}

describe("web_fetch executor", () => {
  test("validates input schema and only accepts http or https", () => {
    expect(webFetchInputSchema.parse({ url: "https://example.com/docs" })).toEqual({
      url: "https://example.com/docs",
    });

    expect(() => webFetchInputSchema.parse({ url: "file:///etc/passwd" })).toThrow();
    expect(() => webFetchInputSchema.parse({ url: "ftp://example.com/file" })).toThrow();
    expect(() =>
      webFetchInputSchema.parse({
        url: "https://example.com",
        maxBytes: WEB_FETCH_DEFAULT_MAX_BYTES + 1,
      }),
    ).toThrow();
    expect(() =>
      webFetchInputSchema.parse({ url: "https://example.com", extra: true }),
    ).toThrow();
  });

  test("blocks local private and intranet hostnames", () => {
    expect(isBlockedWebFetchHostname("localhost")).toBe(true);
    expect(isBlockedWebFetchHostname("127.0.0.1")).toBe(true);
    expect(isBlockedWebFetchHostname("0.0.0.0")).toBe(true);
    expect(isBlockedWebFetchHostname("10.0.0.1")).toBe(true);
    expect(isBlockedWebFetchHostname("172.16.0.1")).toBe(true);
    expect(isBlockedWebFetchHostname("192.168.1.10")).toBe(true);
    expect(isBlockedWebFetchHostname("198.18.0.1")).toBe(true);
    expect(isBlockedWebFetchHostname("203.0.113.1")).toBe(true);
    expect(isBlockedWebFetchHostname("224.0.0.1")).toBe(true);
    expect(isBlockedWebFetchHostname("240.0.0.1")).toBe(true);
    expect(isBlockedWebFetchHostname("169.254.1.1")).toBe(true);
    expect(isBlockedWebFetchHostname("::1")).toBe(true);
    expect(isBlockedWebFetchHostname("fc00::1")).toBe(true);
    expect(isBlockedWebFetchHostname("fe80::1")).toBe(true);
    expect(isBlockedWebFetchHostname("64:ff9b::7f00:1")).toBe(true);
    expect(isBlockedWebFetchHostname("64:ff9b::a00:1")).toBe(true);
    expect(isBlockedWebFetchHostname("64:ff9b:1::a00:1")).toBe(true);
    expect(isBlockedWebFetchHostname("64:ff9b::5db8:d822")).toBe(true);
    expect(isBlockedWebFetchHostname("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedWebFetchHostname("::ffff:7f00:1")).toBe(true);
    expect(isBlockedWebFetchHostname("::ffff:a00:1")).toBe(true);
    expect(isBlockedWebFetchHostname("internal")).toBe(true);
    expect(isBlockedWebFetchHostname("example.com")).toBe(false);
    expect(isBlockedWebFetchHostname("docs.example.com")).toBe(false);
  });

  test("allows local targets when the Runtime snapshot selects local-and-public", async () => {
    const result = await executeWebFetch(
      { url: "http://127.0.0.1:3000/health" },
      {
        networkAccessScope: "local-and-public",
        fetch: async () => response("ok"),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        data: { finalUrl: "http://127.0.0.1:3000/health" },
      },
    });
  });

  test("recognizes the standard Mihomo IPv4 and IPv6 TUN fake-IP ranges", () => {
    expect(isTunFakeIpAddress("198.18.0.1")).toBe(true);
    expect(isTunFakeIpAddress("198.19.255.254")).toBe(true);
    expect(isTunFakeIpAddress("198.17.255.255")).toBe(false);
    expect(isTunFakeIpAddress("198.20.0.0")).toBe(false);
    expect(isTunFakeIpAddress("fdfe:dcba:9876::1")).toBe(true);
    expect(isTunFakeIpAddress("fdfe:dcba:9876:0:ffff::1")).toBe(true);
    expect(isTunFakeIpAddress("fdfe:dcba:9877::1")).toBe(false);
    expect(isTunFakeIpAddress("fd00::1")).toBe(false);
    expect(isTunFakeIpAddress("::1")).toBe(false);
  });

  test("keeps direct TUN fake-IP URLs blocked", async () => {
    let fetchCalled = false;

    const result = await executeWebFetch(
      { url: "http://198.18.0.1/" },
      {
        now: () => 1,
        fetch: async () => {
          fetchCalled = true;
          return response("should not fetch");
        },
      },
    );

    expect(result).toMatchObject(networkAccessScopeDeniedExpectation());
    expect(fetchCalled).toBe(false);
  });

  test("keeps direct IPv6 TUN fake-IP URLs blocked", async () => {
    let fetchCalled = false;

    const result = await executeWebFetch(
      { url: "http://[fdfe:dcba:9876::30]/" },
      {
        now: () => 1,
        fetch: async () => {
          fetchCalled = true;
          return response("should not fetch");
        },
      },
    );

    expect(result).toMatchObject(networkAccessScopeDeniedExpectation());
    expect(fetchCalled).toBe(false);
  });

  test("blocks IPv4-mapped IPv6 literals before fetch", async () => {
    let fetchCalled = false;

    const result = await executeWebFetch(
      { url: "http://[::ffff:7f00:1]/" },
      {
        now: () => 1,
        fetch: async () => {
          fetchCalled = true;
          return response("should not fetch");
        },
      },
    );

    expect(result).toMatchObject(networkAccessScopeDeniedExpectation());
    expect(fetchCalled).toBe(false);
  });

  test("blocks hostnames that resolve to private addresses before fetch", async () => {
    let fetchCalled = false;

    const result = await executeWebFetch(
      { url: "https://public.example/page" },
      {
        now: () => 1,
        resolveAddress: async () => [{ address: "10.0.0.8", family: 4 }],
        fetch: async () => {
          fetchCalled = true;
          return response("should not fetch");
        },
      },
    );

    expect(result).toMatchObject(networkAccessScopeDeniedExpectation());
    expect(fetchCalled).toBe(false);
  });

  test("allows qualified domain names resolved through a TUN fake-IP", async () => {
    const accepted: Array<{ hostname: string; address: string }> = [];
    let fetchCalled = false;

    const result = await executeWebFetch(
      { url: "https://docs.example.com/page" },
      {
        now: () => 1,
        resolveAddress: async () => [{ address: "198.18.23.45", family: 4 }],
        onTunFakeIpAccepted: (event) => accepted.push(event),
        fetch: async () => {
          fetchCalled = true;
          return response("<title>Docs</title><p>TUN content</p>");
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        data: {
          finalUrl: "https://docs.example.com/page",
          title: "Docs",
        },
      },
    });
    expect(fetchCalled).toBe(true);
    expect(accepted).toEqual([
      {
        hostname: "docs.example.com",
        address: "198.18.23.45",
      },
    ]);
  });

  test("allows dual-stack Mihomo TUN fake-IP DNS answers", async () => {
    const accepted: Array<{ hostname: string; address: string }> = [];

    const result = await executeWebFetch(
      { url: "https://example.com/page" },
      {
        now: () => 1,
        resolveAddress: async () => [
          { address: "198.18.0.54", family: 4 },
          { address: "fdfe:dcba:9876::30", family: 6 },
        ],
        onTunFakeIpAccepted: (event) => accepted.push(event),
        fetch: async () => response("<title>Example</title><p>TUN content</p>"),
      },
    );

    expect(result.ok).toBe(true);
    expect(accepted).toEqual([
      {
        hostname: "example.com",
        address: "198.18.0.54",
      },
      {
        hostname: "example.com",
        address: "fdfe:dcba:9876::30",
      },
    ]);
  });

  test("still blocks mixed TUN fake-IP and ordinary private DNS answers", async () => {
    const accepted: Array<{ hostname: string; address: string }> = [];
    const blocked: Array<{ hostname: string; address: string }> = [];
    let fetchCalled = false;

    const result = await executeWebFetch(
      { url: "https://mixed.example/page" },
      {
        now: () => 1,
        resolveAddress: async () => [
          { address: "198.18.23.45", family: 4 },
          { address: "192.168.1.10", family: 4 },
        ],
        onTunFakeIpAccepted: (event) => accepted.push(event),
        onResolvedAddressBlocked: (event) => blocked.push(event),
        fetch: async () => {
          fetchCalled = true;
          return response("should not fetch");
        },
      },
    );

    expect(result).toMatchObject(networkAccessScopeDeniedExpectation());
    expect(fetchCalled).toBe(false);
    expect(accepted).toEqual([]);
    expect(blocked).toEqual([
      {
        hostname: "mixed.example",
        address: "192.168.1.10",
      },
    ]);
  });

  test("blocks connection-time DNS rebinding to private addresses", async () => {
    let fetchCalled = false;

    const result = await executeWebFetch(
      { url: "https://rebind.example/page" },
      {
        now: () => 1,
        resolveAddress: async () => [{ address: "93.184.216.34", family: 4 }],
        fetchConnection: async () => {
          return {
            error: {
              ok: false,
              error: {
                code: NETWORK_ACCESS_SCOPE_DENIED,
                message: "当前网络访问范围设为“仅公网”，不能访问本地或私有网络目标。",
                retryable: false,
                details: {
                  policy: "network_access_scope",
                  accessScope: "public-only",
                  remediation: {
                    action: "change_runtime_setting",
                    setting: "network_policy.access_scope",
                    suggestedValue: "local-and-public",
                    takesEffect: "new_run",
                  },
                  guidance: [...NETWORK_ACCESS_SCOPE_DENIED_GUIDANCE],
                },
              },
              metadata: {
                started: 1,
                completed: 1,
                durationMs: 0,
              },
            },
          };
        },
        fetch: async () => {
          fetchCalled = true;
          return response("should not use unguarded fetch");
        },
      },
    );

    expect(result).toMatchObject(networkAccessScopeDeniedExpectation());
    expect(fetchCalled).toBe(false);
  });

  test("keeps the preference-denial code during connection-time address validation", async () => {
    const validationErrors: unknown[] = [];
    const lookup = createWebFetchLookup({
      resolveAddress: async () => [{ address: "127.0.0.1", family: 4 }],
      started: 1,
      now: () => 2,
      onValidationError: (error) => validationErrors.push(error),
    });

    const callbackResult = await new Promise<unknown[]>((resolve) => {
      lookup("rebind.example", {}, (...args) => resolve(args));
    });

    expect(callbackResult[0]).toBeInstanceOf(Error);
    expect(validationErrors[0]).toMatchObject(networkAccessScopeDeniedExpectation());
  });

  test("returns all resolved addresses when Bun requests lookup with all=true", async () => {
    const lookup = createWebFetchLookup({
      resolveAddress: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ],
      started: 1,
      now: () => 2,
      onValidationError: () => {},
    });

    const callbackResult = await new Promise<unknown[]>((resolve) => {
      lookup("example.com", { all: true }, (...args) => {
        resolve(args);
      });
    });

    expect(callbackResult).toEqual([
      null,
      [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ],
    ]);
  });

  test("allows local connection-time addresses for local-and-public Runs", async () => {
    const lookup = createWebFetchLookup({
      resolveAddress: async () => [{ address: "127.0.0.1", family: 4 }],
      started: 1,
      now: () => 2,
      networkAccessScope: "local-and-public",
      onValidationError: () => {
        throw new Error("local-and-public must not reject the resolved address");
      },
    });

    const callbackResult = await new Promise<unknown[]>((resolve) => {
      lookup("localhost", {}, (...args) => {
        resolve(args);
      });
    });

    expect(callbackResult).toEqual([null, "127.0.0.1", 4]);
  });

  test("returns dual-stack TUN fake-IP answers from the connection-time lookup", async () => {
    const accepted: Array<{ hostname: string; address: string }> = [];
    const lookup = createWebFetchLookup({
      resolveAddress: async () => [
        { address: "198.18.42.10", family: 4 },
        { address: "fdfe:dcba:9876::42", family: 6 },
      ],
      started: 1,
      now: () => 2,
      onValidationError: () => {},
      onTunFakeIpAccepted: (event) => accepted.push(event),
    });

    const callbackResult = await new Promise<unknown[]>((resolve) => {
      lookup("docs.example.com", { all: true }, (...args) => {
        resolve(args);
      });
    });

    expect(callbackResult).toEqual([
      null,
      [
        { address: "198.18.42.10", family: 4 },
        { address: "fdfe:dcba:9876::42", family: 6 },
      ],
    ]);
    expect(accepted).toEqual([
      {
        hostname: "docs.example.com",
        address: "198.18.42.10",
      },
      {
        hostname: "docs.example.com",
        address: "fdfe:dcba:9876::42",
      },
    ]);
  });

  test("blocks resolved IPv4-mapped IPv6 private addresses before fetch", async () => {
    let fetchCalled = false;

    const result = await executeWebFetch(
      { url: "https://public.example/page" },
      {
        now: () => 1,
        resolveAddress: async () => [{ address: "::ffff:7f00:1", family: 6 }],
        fetch: async () => {
          fetchCalled = true;
          return response("should not fetch");
        },
      },
    );

    expect(result).toMatchObject(networkAccessScopeDeniedExpectation());
    expect(fetchCalled).toBe(false);
  });

  test("blocks redirects to private hosts before following them", async () => {
    const requested: string[] = [];

    const result = await executeWebFetch(
      { url: "https://example.com/redirect" },
      {
        now: () => 1,
        resolveAddress: async (hostname) =>
          hostname === "example.com"
            ? [{ address: "93.184.216.34", family: 4 }]
            : [{ address: "127.0.0.1", family: 4 }],
        fetch: async (url) => {
          requested.push(url.toString());
          return new Response("", {
            status: 302,
            headers: {
              location: "http://localhost/internal",
              "content-type": "text/plain",
            },
          });
        },
      },
    );

    expect(result).toMatchObject(networkAccessScopeDeniedExpectation());
    expect(requested).toEqual(["https://example.com/redirect"]);
  });

  test("fetches a public text page and returns a bounded preview", async () => {
    let time = 100;
    const result = await executeWebFetch(
      { url: "https://example.com/page" },
      {
        now: () => time++,
        resolveAddress: publicResolver,
        fetch: async () =>
          response(
            "<html><head><title>Example Title</title></head><body>Hello web</body></html>",
          ),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.output?.data).toMatchObject({
      url: "https://example.com/page",
      finalUrl: "https://example.com/page",
      status: 200,
      contentType: "text/html; charset=utf-8",
      title: "Example Title",
      preview: expect.stringContaining("Hello web"),
      truncated: false,
    });
    expect(result.output?.display).toMatchObject({
      title: "Example Title",
      sourceUrl: "https://example.com/page",
    });
    expect(result.metadata).toMatchObject({
      started: 100,
      completed: 101,
      durationMs: 1,
      contentType: "text/html; charset=utf-8",
      truncated: false,
    });
  });

  test("truncates large responses without storing full body", async () => {
    const result = await executeWebFetch(
      { url: "https://example.com/large", maxBytes: 8 },
      {
        now: () => 1,
        resolveAddress: publicResolver,
        fetch: async () => response("abcdefghijklmnopqrstuvwxyz"),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.output?.data.preview.length).toBeLessThanOrEqual(8);
    expect(result.output?.data.truncated).toBe(true);
    expect(result.metadata.truncated).toBe(true);
  });

  test("stops reading the response stream after the byte limit", async () => {
    const encoder = new TextEncoder();
    const chunks = ["abcd", "efgh", "ijkl"];
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[pulls++];
        if (chunk) {
          controller.enqueue(encoder.encode(chunk));
          return;
        }

        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });

    const result = await executeWebFetch(
      { url: "https://example.com/stream", maxBytes: 5 },
      {
        now: () => 1,
        resolveAddress: publicResolver,
        fetch: async () =>
          new Response(body, {
            headers: { "content-type": "text/plain" },
          }),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.output?.data.preview).toBe("abcde");
    expect(result.output?.data.truncated).toBe(true);
    expect(pulls).toBeLessThan(4);
    expect(cancelled).toBe(true);
  });

  test("honors an external abort signal as a non-retryable interruption", async () => {
    const controller = new AbortController();
    let connectionSignal: AbortSignal | undefined;

    const result = await executeWebFetch(
      { url: "https://example.com/slow" },
      {
        now: () => 1,
        resolveAddress: publicResolver,
        abortSignal: controller.signal,
        fetchConnection: async (_url, init) => {
          connectionSignal = init.signal;
          controller.abort("user_stop");
          await Promise.resolve();
          throw new DOMException("Aborted", "AbortError");
        },
      },
    );

    expect(connectionSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "TIMEOUT",
        retryable: false,
        details: {
          interrupted: true,
          reason: "user_stop",
        },
      },
    });
  });

  test("returns structured errors for unsupported content and HTTP failures", async () => {
    const unsupported = await executeWebFetch(
      { url: "https://example.com/image" },
      {
        now: () => 1,
        resolveAddress: publicResolver,
        fetch: async () =>
          response("binary", {
            headers: { "content-type": "image/png" },
          }),
      },
    );

    expect(unsupported).toMatchObject({
      ok: false,
      error: {
        code: "UNSUPPORTED_CONTENT_TYPE",
        retryable: false,
      },
    });

    const httpFailure = await executeWebFetch(
      { url: "https://example.com/missing" },
      {
        now: () => 1,
        resolveAddress: publicResolver,
        fetch: async () => response("not found", { status: 404 }),
      },
    );

    expect(httpFailure).toMatchObject({
      ok: false,
      error: {
        code: "HTTP_ERROR",
        retryable: false,
      },
    });
  });
});
