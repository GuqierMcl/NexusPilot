import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  getContextDisplayUsage,
  getRuntimeContextUsageState,
} from "../../features/workbench/agent/state/runtime-context-view";
import { AgentComposerContextDisplayView } from "../../features/workbench/agent/conversation/AgentComposerContextDisplay";
import {
  ContextDisplayContentView,
  ContextDisplayRingBody,
  ContextDisplayRootView,
} from "./context-display";

describe("ContextDisplay usage", () => {
  test("uses request-scoped ContextUsage instead of legacy cumulative tokens", () => {
    expect(getContextDisplayUsage({
      runtimeUsage: {
        contextWindow: 1000,
        estimatedInputTokens: 400,
        providerInputTokens: 380,
        reservedOutputTokens: 120,
        activeTokens: 500,
        source: "provider",
        view: "checkpoint",
        checkpointId: "ckpt_1",
      },
      legacyTotalTokens: 9000,
      legacyContextWindow: 128000,
    })).toEqual({
      totalTokens: 500,
      modelContextWindow: 1000,
      percent: 50,
      source: "provider",
      view: "checkpoint",
      reservedOutputTokens: 120,
      isLegacy: false,
    });
  });

  test("suppresses a fake percentage when ContextUsage has no usable window", () => {
    expect(getContextDisplayUsage({
      runtimeUsage: {
        contextWindow: 0,
        estimatedInputTokens: 400,
        reservedOutputTokens: 120,
        activeTokens: 520,
        source: "estimate",
        view: "raw",
      },
      legacyTotalTokens: 9000,
      legacyContextWindow: 128000,
    })).toEqual({
      totalTokens: 520,
      modelContextWindow: 0,
      percent: null,
      source: "estimate",
      view: "raw",
      reservedOutputTokens: 120,
      isLegacy: false,
    });
  });

  test("uses legacy usage only when the active message has no ContextUsage", () => {
    expect(getContextDisplayUsage({
      runtimeUsage: null,
      legacyTotalTokens: 640,
      legacyContextWindow: 1280,
    })).toEqual({
      totalTokens: 640,
      modelContextWindow: 1280,
      percent: 50,
      source: "legacy",
      view: "legacy",
      isLegacy: true,
    });
  });

  test("never falls back to cumulative legacy usage for a present invalid ContextUsage", () => {
    expect(getContextDisplayUsage({
      runtimeUsage: null,
      runtimeUsageInvalid: true,
      legacyTotalTokens: 640,
      legacyContextWindow: 1280,
    })).toEqual({
      totalTokens: 0,
      modelContextWindow: 0,
      percent: null,
      source: "invalid",
      view: "unknown",
      isLegacy: false,
    });
  });

  test("first render for a new thread never paints the previous thread's legacy total", () => {
    const markup = renderToStaticMarkup(createElement(
      ContextDisplayRootView,
      {
        currentThreadId: "thread-b",
        modelContextWindow: 1280,
        usage: undefined,
        children: createElement(ContextDisplayRingBody),
        persistedTokenState: {
          threadId: "thread-a",
          totalTokens: 640,
          usage: { totalTokens: 640 },
        },
      },
    ));

    expect(markup.includes(">0%<")).toBe(true);
    expect(markup.includes("50%")).toBe(false);
    expect(markup.includes(">640<")).toBe(false);
  });

  test("Runtime tooltip shows uncapped request usage without legacy segments", () => {
    const markup = renderToStaticMarkup(createElement(ContextDisplayContentView, {
      usage: {
        totalTokens: 9000,
        inputTokens: 4000,
        cachedInputTokens: 2000,
        outputTokens: 2000,
        reasoningTokens: 1000,
      },
      totalTokens: 1300,
      percent: 100,
      modelContextWindow: 1000,
      source: "provider",
      view: "checkpoint",
      reservedOutputTokens: 300,
      isLegacy: false,
    }));

    expect(markup.includes("1.3k / 1k")).toBe(true);
    expect(markup.includes("活动输入")).toBe(true);
    expect(markup.includes("Provider 观测")).toBe(true);
    expect(markup.includes("检查点")).toBe(true);
    expect(markup.includes("预留输出")).toBe(true);
    expect(markup.includes(">300<")).toBe(true);
    expect(markup.includes("缓存输入")).toBe(false);
    expect(markup.includes(">9k<")).toBe(false);
  });

  test("present invalid Runtime usage renders unknown labels instead of legacy semantics", () => {
    const markup = renderToStaticMarkup(createElement(ContextDisplayContentView, {
      usage: { totalTokens: 9000, inputTokens: 9000 },
      totalTokens: 0,
      percent: null,
      modelContextWindow: 0,
      source: "invalid",
      view: "unknown",
      isLegacy: false,
    }));

    expect(markup.includes("窗口未知")).toBe(true);
    expect((markup.match(/>未知</g) ?? []).length).toBe(2);
    expect(markup.includes("估算")).toBe(false);
    expect(markup.includes("原始上下文")).toBe(false);
    expect(markup.includes(">输入</span>")).toBe(false);
  });

  test("Composer renders persisted Runtime percentage without a selected model", () => {
    const runtimeUsageState = getRuntimeContextUsageState({
      custom: { nexus: { contextUsage: {
        contextWindow: 1000,
        estimatedInputTokens: 400,
        providerInputTokens: 380,
        reservedOutputTokens: 120,
        view: "checkpoint",
        checkpointId: "ckpt_restored",
      } } },
    });
    const markup = renderToStaticMarkup(createElement(AgentComposerContextDisplayView, {
      currentThreadId: "thread-restored",
      runtimeUsageState,
    }));

    expect(markup.includes(">50%<")).toBe(true);
  });

  test("Composer keeps unknown Runtime window metadata without a selected model", () => {
    const runtimeUsageState = getRuntimeContextUsageState({
      custom: { nexus: { contextUsage: {
        contextWindow: "unknown",
        estimatedInputTokens: 300,
        reservedOutputTokens: 200,
        view: "raw",
      } } },
    });
    const markup = renderToStaticMarkup(createElement(AgentComposerContextDisplayView, {
      currentThreadId: "thread-restored",
      runtimeUsageState,
    }));

    expect(markup.includes(">—<")).toBe(true);
    expect(markup.includes("窗口未知")).toBe(true);
    expect(markup.includes("估算")).toBe(true);
    expect(markup.includes("原始上下文")).toBe(true);
    expect(markup.includes("200")).toBe(true);
  });
});
