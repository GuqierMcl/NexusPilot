import { describe, expect, test } from "bun:test";
import {
  createSystemToolNamespace,
  currentSystemTime,
  RuntimeToolRegistry,
} from "../src/runtime";

describe("system.current_time", () => {
  test("registers as an immutable Runtime-local low-risk Tool", () => {
    const namespace = createSystemToolNamespace();
    const registry = new RuntimeToolRegistry([namespace]);
    const definition = registry.requireTool("system.current_time");

    expect(registry.requireProviderName("system.current_time")).toBe(
      "np__system__current_time",
    );
    expect(definition.executionTarget).toBe("runtime");
    expect(definition.risk).toEqual({
      mode: "static",
      level: "low",
      reversible: true,
      sideEffect: "none",
    });
    expect(namespace.resolveForRun({
      runId: "run_1",
      agent: { id: "ask", mode: "ask" },
      backendBridge: { state: "disconnected" },
    }).candidateToolIds).toEqual(["system.current_time"]);
  });

  test("returns one internally consistent clock snapshot", async () => {
    const fixed = new Date("2026-07-27T12:30:00.123Z");
    const namespace = createSystemToolNamespace({
      now: () => fixed,
      resolveTimeZone: () => "Asia/Hong_Kong",
    });
    const tool = namespace.tools[0]!;

    const result = await tool.execute({}, {
      toolCallId: "tool_1",
      runId: "run_1",
      conversationId: "conv_1",
      abortSignal: new AbortController().signal,
    });

    expect(result.data).toEqual(currentSystemTime(fixed, "Asia/Hong_Kong"));
    expect(result.data).toMatchObject({
      utc: "2026-07-27T12:30:00.123Z",
      timeZone: "Asia/Hong_Kong",
      epochMs: fixed.getTime(),
    });
    expect(tool.outputSchema.safeParse(result.data).success).toBe(true);
  });

  test("formats the local offset supplied by the host clock", () => {
    const date = new Date("2026-01-02T03:04:05.006Z");
    Object.defineProperty(date, "getTimezoneOffset", {
      value: () => -480,
    });
    Object.defineProperties(date, {
      getFullYear: { value: () => 2026 },
      getMonth: { value: () => 0 },
      getDate: { value: () => 2 },
      getHours: { value: () => 11 },
      getMinutes: { value: () => 4 },
      getSeconds: { value: () => 5 },
      getMilliseconds: { value: () => 6 },
    });

    expect(currentSystemTime(date, "Asia/Hong_Kong")).toMatchObject({
      localDateTime: "2026-01-02T11:04:05.006+08:00",
      utcOffsetMinutes: 480,
    });
  });
});
