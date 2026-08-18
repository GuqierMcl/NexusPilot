import { describe, expect, test } from "bun:test";
import { projectMessageToUiMessage, renderDiffMarkdown, type Message } from "../src/runtime";

describe("runtime UI projection", () => {
  test("projects text and source parts to assistant-ui friendly parts", () => {
    const message: Message = {
      id: "msg_1",
      conversationId: "conv_1",
      role: "assistant",
      runId: "run_1",
      parentId: "msg_user",
      providerId: "openai",
      modelId: "gpt-4o",
      agentMode: "ask",
      status: { type: "complete", reason: "stop" },
      parts: [
        {
          id: "part_text",
          conversationId: "conv_1",
          messageId: "msg_1",
          type: "text",
          text: "Fetched the document.",
        },
        {
          id: "part_source",
          conversationId: "conv_1",
          messageId: "msg_1",
          type: "source",
          sourceType: "url",
          sourceId: "src_example",
          url: "https://example.com",
          title: "Example",
        },
      ],
      time: { created: 1 },
    };

    const projected = projectMessageToUiMessage(message);

    expect(projected.id).toBe("msg_1");
    expect(projected.role).toBe("assistant");
    expect(projected.parts.map((part) => part.type)).toEqual(["text", "source"]);
  });

  test("renders structured diff parts as markdown diff fallback", () => {
    const markdown = renderDiffMarkdown({
      id: "diff_1",
      title: "Rewrite active SQL",
      kind: "sql",
      target: { type: "memory", name: "active.sql", language: "sql" },
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [
            { type: "remove", oldLine: 1, text: "SELECT * FROM users" },
            { type: "add", newLine: 1, text: "SELECT id, name FROM users" },
          ],
        },
      ],
      summary: "Reduce selected columns.",
    });

    expect(markdown).toContain("### Rewrite active SQL");
    expect(markdown).toContain("```diff");
    expect(markdown).toContain("-SELECT * FROM users");
    expect(markdown).toContain("+SELECT id, name FROM users");
  });
});
