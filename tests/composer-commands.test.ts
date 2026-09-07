import { describe, expect, test } from "bun:test";
import { validateCommandBinding } from "../shared/composer-commands";
import {
  combineReferencedTexts,
  splitReferencedText,
  projectReferencedText,
  validateReferenceMessage,
} from "../shared/composer-references";
import {
  editDraft,
  ComposerDraftHistory,
} from "../src/features/workbench/agent/composer/composer-draft";
import { createMessageCommandRegistry } from "../ai-runtime/src/runtime/commands/message-commands";

const command = {
  id: "one",
  commandId: "explain",
  name: "explain",
  version: 1,
  start: 0,
  end: 8,
};
describe("persisted short commands", () => {
  test("validates exact identity spans, message count and intersections", () => {
    expect(validateCommandBinding("/explain SQL", command)).toEqual(command);
    expect(() =>
      validateCommandBinding("/explain SQL", { ...command, end: 9 }),
    ).toThrow();
    expect(() =>
      validateReferenceMessage([
        { text: "/explain", command },
        { text: "/explain", command },
      ]),
    ).toThrow();
  });
  test("edits shift or invalidate a command atomically with undo", () => {
    const history = new ComposerDraftHistory({
      text: "/explain SQL",
      command,
      caret: 12,
    });
    history.commit(editDraft(history.current, 0, 0, "😀 "));
    expect(history.current.command?.start).toBe(3);
    history.commit(editDraft(history.current, 4, 5, "X"));
    expect(history.current.command).toBeUndefined();
    expect(history.undo().command?.start).toBe(3);
  });
  test("display projection strips long snapshot, model projection retains it", () => {
    const prompt = "explain carefully ".repeat(500);
    const part = { text: "/explain SQL", command, commandPrompt: prompt };
    const display = combineReferencedTexts([part]);
    expect(display.text).toBe("/explain SQL");
    expect(display.commandPrompt).toBeUndefined();
    expect(projectReferencedText(part)).toBe(`${prompt}\n SQL`);
    expect(
      splitReferencedText(combineReferencedTexts([{ text: "hello" }, part]), [
        "hello",
        part.text,
      ])[1]?.command,
    ).toEqual(command);
  });
  test("versioned registries do not mutate already captured semantics", () => {
    const first = createMessageCommandRegistry([
      { id: "explain", name: "explain", version: 1, prompt: "old" },
    ]);
    const part = {
      text: "/explain SQL",
      command,
      commandPrompt: first.resolve(command),
    };
    const next = createMessageCommandRegistry([
      { id: "explain", name: "explain", version: 2, prompt: "new" },
    ]);
    expect(projectReferencedText(part)).toBe("old\n SQL");
    expect(() => next.resolve(command)).toThrow();
    expect(() =>
      createMessageCommandRegistry([
        { id: "x", name: "x", version: 1, prompt: "a" },
        { id: "x", name: "x", version: 1, prompt: "b" },
      ]),
    ).toThrow();
  });
});
