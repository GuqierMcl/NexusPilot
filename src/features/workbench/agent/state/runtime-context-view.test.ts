import { describe, expect, test } from "bun:test";

import {
  getContextDisplayUsage,
  getLatestAssistantMessageMetadata,
  getRuntimeContextUsageState,
  getRuntimeCompactionMarkerLabel,
  getRuntimeCompactionActivityLabel,
  getRuntimeCompactionActivityView,
  getRuntimeContextUsageView,
} from "./runtime-context-view";

describe("runtime context view", () => {
  test("selects the latest assistant metadata by its stable store reference", () => {
    const olderMetadata = {
      custom: { nexus: { contextUsage: { view: "raw" } } },
    };
    const latestMetadata = {
      custom: { nexus: { contextUsage: { view: "checkpoint" } } },
    };
    const messages = [
      { role: "assistant", metadata: olderMetadata },
      { role: "user", metadata: { ignored: true } },
      { role: "assistant", metadata: latestMetadata },
    ];

    expect(getLatestAssistantMessageMetadata(messages)).toBe(latestMetadata);
    expect(getLatestAssistantMessageMetadata(messages)).toBe(latestMetadata);
    expect(getLatestAssistantMessageMetadata([{ role: "user" }])).toBe(
      undefined,
    );
  });

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

  test("keeps the main context value on the Runtime forecast when Provider usage and reserve differ", () => {
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
      activeTokens: 440,
      source: "estimate",
      view: "checkpoint",
      checkpointId: "ckpt_1",
    });

    expect(getContextDisplayUsage({
      runtimeUsage: view,
      legacyTotalTokens: 999,
      legacyContextWindow: 999,
    })).toEqual({
      totalTokens: 440,
      modelContextWindow: 1000,
      percent: 44,
      source: "estimate",
      view: "checkpoint",
      providerInputTokens: 430,
      reservedOutputTokens: 120,
      isLegacy: false,
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
      activeTokens: 300,
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
      activeTokens: 300,
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

  test("renders a failed compaction lifecycle without exposing diagnostic payloads", () => {
    const label = getRuntimeCompactionMarkerLabel({
      custom: {
        nexus: {
          compaction: {
            trigger: "auto_pre_turn",
            createdAt: 10,
            beforeTokens: 900,
            status: "failed",
            errorName: "ContextSummaryValidationError",
            reasoning: "must-not-render",
          },
        },
      },
    });

    expect(label).toBe("上下文压缩失败");
    expect(label?.includes("ContextSummaryValidationError")).toBe(false);
    expect(label?.includes("must-not-render")).toBe(false);
  });

  test("reads only durable compaction Activity scalars", () => {
    const activity = getRuntimeCompactionActivityView({
      id: "cmp_1",
      conversationId: "conv_1",
      runId: "run_1",
      requestIndex: 2,
      boundaryStepIndex: 1,
      attemptIndex: 0,
      trigger: "auto_mid_turn",
      status: "created",
      sourceHeadRunId: "run_1",
      sourceConversationRevision: 2,
      checkpointId: "ckpt_1",
      beforeEstimatedInputTokens: 900,
      afterEstimatedInputTokens: 400,
      startedAt: 10,
      completedAt: 11,
      summary: "must-not-render",
      reasoning: "must-not-render",
      safetyState: "must-not-render",
    });

    expect(activity).toEqual({
      id: "cmp_1",
      runId: "run_1",
      requestIndex: 2,
      boundaryStepIndex: 1,
      attemptIndex: 0,
      trigger: "auto_mid_turn",
      status: "created",
      checkpointId: "ckpt_1",
      beforeEstimatedInputTokens: 900,
      afterEstimatedInputTokens: 400,
      startedAt: 10,
      completedAt: 11,
    });
    expect(getRuntimeCompactionActivityLabel(activity!)).toBe("上下文已压缩");
    expect(JSON.stringify(activity).includes("must-not-render")).toBe(false);
  });

  test("rejects a malformed compaction Activity", () => {
    expect(getRuntimeCompactionActivityView({
      id: "cmp_1",
      runId: "run_1",
      requestIndex: 0,
      attemptIndex: 0,
      trigger: "auto_mid_turn",
      status: "failed",
      beforeEstimatedInputTokens: 900,
      startedAt: 10,
    })).toBe(null);
  });
});
