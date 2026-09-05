import { describe, expect, test } from "bun:test";

import {
  getContextDisplayUsage,
  getRuntimeContextUsageState,
  getRuntimeCompactionMarkerLabel,
  getRuntimeContextUsageView,
} from "./runtime-context-view";

describe("runtime context view", () => {
  for (const [name, contextUsage] of [
    ["invalid estimate", { contextWindow: 1000, estimatedInputTokens: -1, reservedOutputTokens: 1, view: "raw" }],
    ["invalid reserve", { contextWindow: 1000, estimatedInputTokens: 1, reservedOutputTokens: -1, view: "raw" }],
    ["invalid view", { contextWindow: 1000, estimatedInputTokens: 1, reservedOutputTokens: 1, view: "other" }],
    ["raw checkpoint", { contextWindow: 1000, estimatedInputTokens: 1, reservedOutputTokens: 1, view: "raw", checkpointId: "ckpt_1" }],
    ["checkpoint without id", { contextWindow: 1000, estimatedInputTokens: 1, reservedOutputTokens: 1, view: "checkpoint" }],
  ] as const) {
    test(`discriminates present ${name} ContextUsage as invalid`, () => {
      expect(getRuntimeContextUsageState({ custom: { nexus: { contextUsage } } })).toEqual({ kind: "invalid" });
    });
  }

  test("distinguishes absent ContextUsage from a present invalid fact", () => {
    expect(getRuntimeContextUsageState({ custom: { nexus: {} } })).toEqual({ kind: "absent" });
  });

  for (const [name, contextUsage] of [
    ["null", null],
    ["string", "malformed"],
    ["number", 42],
    ["array", []],
  ] as const) {
    test(`rejects present ${name} ContextUsage without using legacy totals`, () => {
      const state = getRuntimeContextUsageState({
        custom: { nexus: { contextUsage } },
      });
      const display = getContextDisplayUsage({
        runtimeUsage: state.kind === "valid" ? state.value : null,
        runtimeUsageInvalid: state.kind === "invalid",
        legacyTotalTokens: 640,
        legacyContextWindow: 1280,
      });

      expect({ state, display }).toEqual({
        state: { kind: "invalid" },
        display: {
          totalTokens: 0,
          modelContextWindow: 0,
          percent: null,
          source: "invalid",
          view: "unknown",
          isLegacy: false,
        },
      });
    });
  }

  test("uses a provider observation before the estimate and reserves output tokens", () => {
    const view = getRuntimeContextUsageView({
      custom: {
        nexus: {
          contextUsage: {
            contextWindow: 1000,
            estimatedInputTokens: 440,
            providerInputTokens: 430,
            reservedOutputTokens: 120,
            activeTokens: 999,
            source: "estimate",
            view: "checkpoint",
            checkpointId: "ckpt_1",
          },
        },
      },
    });

    expect(view).toEqual({
      contextWindow: 1000,
      estimatedInputTokens: 440,
      providerInputTokens: 430,
      reservedOutputTokens: 120,
      activeTokens: 550,
      source: "provider",
      view: "checkpoint",
      checkpointId: "ckpt_1",
    });
  });

  test("keeps an estimate source and resets on a message set with no ContextUsage", () => {
    const estimate = getRuntimeContextUsageView({
      custom: {
        nexus: {
          contextUsage: {
            contextWindow: 2000,
            estimatedInputTokens: 300,
            reservedOutputTokens: 200,
            view: "raw",
          },
        },
      },
    });

    expect(estimate).toEqual({
      contextWindow: 2000,
      estimatedInputTokens: 300,
      reservedOutputTokens: 200,
      activeTokens: 500,
      source: "estimate",
      view: "raw",
    });
    expect(getRuntimeContextUsageView(undefined)).toBe(null);
  });

  test("retains ContextUsage with a missing window so the UI suppresses rather than falls back", () => {
    expect(getRuntimeContextUsageView({
      custom: {
        nexus: {
          contextUsage: {
            estimatedInputTokens: 300,
            reservedOutputTokens: 200,
            view: "raw",
          },
        },
      },
    })).toEqual({
      contextWindow: 0,
      estimatedInputTokens: 300,
      reservedOutputTokens: 200,
      activeTokens: 500,
      source: "estimate",
      view: "raw",
    });
  });

  test("reads only marker scalars and never a checkpoint summary or Safety State", () => {
    const label = getRuntimeCompactionMarkerLabel({
      custom: {
        nexus: {
          compaction: {
            trigger: "provider_overflow",
            createdAt: 10,
            coverageThroughRunId: "run_covered",
            beforeTokens: 900,
            afterTokens: 400,
            status: "recovered",
            summary: "must-not-render",
            safetyState: { secret: "must-not-render" },
          },
        },
      },
    });

    expect(label).toBe("上下文超限后已压缩并重试");
    expect(JSON.stringify(label).includes("must-not-render")).toBe(false);
  });
});
