import { describe, expect, test } from "bun:test";
import {
  buildPingCommand,
  executeWebPing,
  WEB_PING_COUNT,
} from "../src/runtime/tools/web-ping";
import {
  NETWORK_ACCESS_SCOPE_DENIED,
  NETWORK_ACCESS_SCOPE_DENIED_GUIDANCE,
} from "../src/runtime/tools/web-fetch";

function textStream(value: string): ReadableStream<Uint8Array> {
  return new Response(value).body!;
}

describe("web.ping executor", () => {
  test("uses fixed platform-specific argument arrays instead of a shell command", () => {
    expect(buildPingCommand("win32", "10.0.0.25")).toEqual([
      "ping",
      "-n",
      String(WEB_PING_COUNT),
      "-w",
      "1000",
      "10.0.0.25",
    ]);
    expect(buildPingCommand("linux", "2001:db8::1")).toEqual([
      "ping",
      "-c",
      String(WEB_PING_COUNT),
      "-W",
      "1",
      "2001:db8::1",
    ]);
  });

  test("allows a local target and returns a structured reachable result", async () => {
    const commands: string[][] = [];
    const result = await executeWebPing(
      { host: "10.0.0.25" },
      {
        platform: "win32",
        networkAccessScope: "local-and-public",
        spawn: (command) => {
          commands.push([...command]);
          return {
            stdout: textStream([
              "来自 10.0.0.25 的回复: 字节=32 时间=2ms TTL=64",
              "来自 10.0.0.25 的回复: 字节=32 时间=3ms TTL=64",
              "来自 10.0.0.25 的回复: 字节=32 时间=4ms TTL=64",
              "最短 = 2ms，最长 = 4ms，平均 = 3ms",
            ].join("\n")),
            stderr: textStream(""),
            exited: Promise.resolve(0),
            kill: () => {},
          };
        },
      },
    );

    expect(commands).toEqual([[
      "ping", "-n", "3", "-w", "1000", "10.0.0.25",
    ]]);
    expect(result).toMatchObject({
      ok: true,
      output: {
        data: {
          host: "10.0.0.25",
          status: "reachable",
          packets: { sent: 3, received: 3, lossPercent: 0 },
          roundTripMs: { min: 2, avg: 3, max: 4 },
        },
      },
    });
  });

  test("returns an unreachable diagnostic result rather than an execution error", async () => {
    const result = await executeWebPing(
      { host: "db.internal" },
      {
        networkAccessScope: "local-and-public",
        resolveAddress: async () => [{ address: "10.0.0.25", family: 4 }],
        spawn: () => ({
          stdout: textStream("Request timed out."),
          stderr: textStream(""),
          exited: Promise.resolve(1),
          kill: () => {},
        }),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        data: {
          status: "unreachable",
          packets: { sent: 3, received: 0, lossPercent: 100 },
        },
      },
    });
  });

  test("honors public-only scope before starting a ping process", async () => {
    let spawned = false;
    const result = await executeWebPing(
      { host: "127.0.0.1" },
      {
        networkAccessScope: "public-only",
        spawn: () => {
          spawned = true;
          throw new Error("must not spawn");
        },
      },
    );

    expect(result).toMatchObject(networkAccessScopeDeniedExpectation());
    expect(spawned).toBe(false);
  });

  test("reports preference denial when a hostname resolves to a private address", async () => {
    let spawned = false;
    const result = await executeWebPing(
      { host: "internal.example" },
      {
        networkAccessScope: "public-only",
        resolveAddress: async () => [{ address: "10.0.0.8", family: 4 }],
        spawn: () => {
          spawned = true;
          throw new Error("must not spawn");
        },
      },
    );

    expect(result).toMatchObject(networkAccessScopeDeniedExpectation());
    expect(spawned).toBe(false);
  });

  test("normalizes DNS and process startup failures as tool errors", async () => {
    const resolutionFailure = await executeWebPing(
      { host: "unresolvable.example" },
      {
        resolveAddress: async () => {
          throw new Error("DNS lookup failed");
        },
      },
    );
    expect(resolutionFailure).toMatchObject({
      ok: false,
      error: { code: "NETWORK_ERROR", message: "DNS lookup failed" },
    });

    const startFailure = await executeWebPing(
      { host: "203.0.113.25" },
      {
        spawn: () => {
          throw new Error("ping executable is unavailable");
        },
      },
    );
    expect(startFailure).toMatchObject({
      ok: false,
      error: { code: "NETWORK_ERROR", message: "ping executable is unavailable" },
    });
  });
});

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
