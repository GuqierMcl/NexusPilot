import { describe, expect, test } from "bun:test";

import {
  THREAD_WELCOME_MESSAGES,
  pickThreadWelcomeMessage,
} from "../src/components/assistant-ui/thread-welcome-messages";

const EMOJI_PATTERN = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

describe("thread welcome messages", () => {
  test("provides a varied no-emoji welcome message pool", () => {
    expect(THREAD_WELCOME_MESSAGES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(THREAD_WELCOME_MESSAGES).size).toBe(THREAD_WELCOME_MESSAGES.length);

    for (const message of THREAD_WELCOME_MESSAGES) {
      expect(message.trim()).toBe(message);
      expect(message.length).toBeGreaterThan(0);
      expect(message.length).toBeLessThanOrEqual(28);
      expect(message).not.toMatch(EMOJI_PATTERN);
    }
  });

  test("picks a welcome message from the configured pool", () => {
    expect(pickThreadWelcomeMessage(() => 0)).toBe(THREAD_WELCOME_MESSAGES[0]);
    expect(pickThreadWelcomeMessage(() => 0.999999)).toBe(
      THREAD_WELCOME_MESSAGES[THREAD_WELCOME_MESSAGES.length - 1],
    );
    expect(THREAD_WELCOME_MESSAGES).toContain(pickThreadWelcomeMessage());
  });
});
