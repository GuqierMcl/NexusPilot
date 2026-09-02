import { describe, expect, test } from "bun:test";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { createElement, type FC } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Thread } from "@/components/assistant-ui/thread";

const RuntimeImageMessageHarness: FC = () => {
  const messages = [
    {
      id: "msg_with_image",
      role: "user" as const,
      content: [{ type: "text" as const, text: "这张图里有什么？" }],
      attachments: [
        {
          id: "aui_attachment_image",
          type: "image" as const,
          name: "diagram.png",
          contentType: "image/png",
          status: { type: "complete" as const },
          content: [
            {
              type: "file" as const,
              data: "nexuspilot-attachment:att_image",
              filename: "diagram.png",
              mimeType: "image/png",
            },
          ],
        },
      ],
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

describe("historical image attachment preview", () => {
  test("keeps the dialog trigger mounted while the authenticated image is loading", () => {
    const markup = renderToStaticMarkup(
      createElement(RuntimeImageMessageHarness),
    );

    expect(markup.includes('aria-label="Image attachment"')).toBe(true);
    expect(markup.includes('data-slot="dialog-trigger"')).toBe(true);
  });
});
