import { describe, expect, test } from "bun:test";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { createElement, type FC } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Thread } from "@/components/assistant-ui/thread";

const UserMessageHarness: FC = () => {
  const messages = [
    {
      id: "msg_user",
      role: "user" as const,
      content: [{ type: "text" as const, text: "请解释这个查询" }],
    },
  ];
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: (message) => message,
    onNew: async () => undefined,
  });

  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(Thread),
  );
};

describe("user message actions", () => {
  test("offers copy alongside edit on hover", () => {
    const markup = renderToStaticMarkup(createElement(UserMessageHarness));

    expect(markup.includes("aui-user-action-copy")).toBe(true);
    expect(markup.includes(">复制<")).toBe(true);
    expect(markup.includes("aui-user-action-edit")).toBe(true);
    expect(markup.includes(">编辑<")).toBe(true);
  });
});
