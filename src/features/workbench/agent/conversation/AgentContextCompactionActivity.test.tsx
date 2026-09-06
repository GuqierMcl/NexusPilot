import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentContextCompactionActivity } from "./AgentContextCompactionActivity";

const baseActivity = {
  id: "cmp_timeline",
  conversationId: "conv_timeline",
  runId: "run_timeline",
  requestIndex: 1,
  attemptIndex: 0,
  trigger: "auto_mid_turn",
  sourceHeadRunId: "run_timeline",
  sourceConversationRevision: 2,
  beforeEstimatedInputTokens: 28_000,
  startedAt: 100,
} as const;

describe("AgentContextCompactionActivity", () => {
  for (const [status, label] of [
    ["preparing", "正在压缩上下文…"],
    ["created", "上下文已压缩"],
    ["recovered", "上下文已压缩"],
    ["failed", "上下文压缩失败"],
    ["interrupted", "上下文压缩已中止"],
  ] as const) {
    test(`renders ${status} as an independent timeline divider`, () => {
      const successful = status === "created" || status === "recovered";
      const markup = renderToStaticMarkup(createElement(AgentContextCompactionActivity, {
        name: "context-compaction",
        data: {
          ...baseActivity,
          status,
          ...(successful
            ? {
                checkpointId: "ckpt_timeline",
                afterEstimatedInputTokens: 12_000,
              }
            : {}),
          ...(status === "preparing" ? {} : { completedAt: 110 }),
          summary: "MUST_NOT_RENDER",
          safetyState: "MUST_NOT_RENDER",
        },
        dataRendererUI: null,
      }));

      expect(markup.includes("agent-context-compaction-activity")).toBe(true);
      expect(markup.includes('data-compaction-id="cmp_timeline"')).toBe(true);
      expect(markup.includes(`data-status="${status}"`)).toBe(true);
      expect(markup.includes(label)).toBe(true);
      expect(markup.includes("MUST_NOT_RENDER")).toBe(false);
      expect(markup.includes("summary")).toBe(false);
      expect(markup.includes("safetyState")).toBe(false);
    });
  }

  test("preserves another registered data renderer", () => {
    const markup = renderToStaticMarkup(createElement(AgentContextCompactionActivity, {
      name: "other-data",
      data: {},
      dataRendererUI: createElement("span", null, "other renderer"),
    }));

    expect(markup).toBe("<span>other renderer</span>");
  });
});
