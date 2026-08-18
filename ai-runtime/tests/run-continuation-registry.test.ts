import { describe, expect, test } from "bun:test";
import {
  RunContinuationConflictError,
  RunContinuationRegistry,
} from "../src/runtime";

describe("RunContinuationRegistry", () => {
  test("holds an acquired continuation until the streaming terminal callback releases it", () => {
    const registry = new RunContinuationRegistry();
    const runId = "run_streaming" as const;

    const release = registry.acquire(runId);

    expect(registry.isActive(runId)).toBe(true);
    expect(() => registry.acquire(runId)).toThrow(
      RunContinuationConflictError,
    );
    release();
    release();
    expect(registry.isActive(runId)).toBe(false);
  });

  test("allows only one continuation per Runtime Run and always releases", async () => {
    const registry = new RunContinuationRegistry();
    let release!: () => void;
    const first = registry.runExclusive(
      "run_continuation",
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    expect(registry.isActive("run_continuation")).toBe(true);
    await expect(
      registry.runExclusive("run_continuation", async () => "duplicate"),
    ).rejects.toBeInstanceOf(RunContinuationConflictError);

    release();
    await first;
    expect(registry.isActive("run_continuation")).toBe(false);
    await expect(
      registry.runExclusive("run_continuation", async () => "continued"),
    ).resolves.toBe("continued");
  });

  test("does not serialize continuations belonging to different Runs", async () => {
    const registry = new RunContinuationRegistry();
    const values = await Promise.all([
      registry.runExclusive("run_first", async () => "first"),
      registry.runExclusive("run_second", async () => "second"),
    ]);

    expect(values).toEqual(["first", "second"]);
  });
});
