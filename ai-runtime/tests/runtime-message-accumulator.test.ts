import { describe, expect, test } from "bun:test";
import { MessageAccumulator } from "../src/runtime";

describe("MessageAccumulator", () => {
  test("keeps text deltas in memory until final part creation", () => {
    const accumulator = new MessageAccumulator();

    accumulator.appendText("SELECT ");
    accumulator.appendText("* ");
    accumulator.appendText("FROM users");

    expect(accumulator.text).toBe("SELECT * FROM users");
    expect(accumulator.textLength).toBe(19);
  });

  test("creates a final text part with stable runtime ids", () => {
    const accumulator = new MessageAccumulator();
    accumulator.appendText("Hello");
    accumulator.appendText(" world");

    const part = accumulator.toTextPart({
      id: "part_final",
      conversationId: "conv_1",
      messageId: "msg_1",
      created: 10,
      completed: 12,
    });

    expect(part).toEqual({
      id: "part_final",
      conversationId: "conv_1",
      messageId: "msg_1",
      type: "text",
      text: "Hello world",
      time: { start: 10, end: 12 },
    });
  });

  test("clear resets buffered text", () => {
    const accumulator = new MessageAccumulator();
    accumulator.appendText("temporary");
    accumulator.clear();

    expect(accumulator.text).toBe("");
    expect(accumulator.textLength).toBe(0);
  });
});
