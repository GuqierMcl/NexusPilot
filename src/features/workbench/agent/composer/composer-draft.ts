import {
  referenceKey,
  type ReferencedText,
  type ReferenceTarget,
  type TextReferences,
} from "../../../../../shared/composer-references";

export interface ComposerDraft extends ReferencedText {
  caret: number;
}
export interface ComposerTrigger {
  kind: "reference" | "command";
  start: number;
  end: number;
  query: string;
}

function pruneReferences(refs: TextReferences): TextReferences | undefined {
  const used = new Set(refs.occurrences.map((item) => item.targetKey));
  return used.size
    ? {
        ...refs,
        targets: refs.targets.filter((target) =>
          used.has(referenceKey(target)),
        ),
      }
    : undefined;
}

export function editDraft(
  draft: ComposerDraft,
  start: number,
  end: number,
  inserted: string,
): ComposerDraft {
  const delta = inserted.length - (end - start);
  const references =
    draft.references &&
    pruneReferences({
      ...draft.references,
      occurrences: draft.references.occurrences.flatMap((item) => {
        if (item.end <= start) return [item];
        if (item.start >= end)
          return [
            {
              ...item,
              start: item.start + delta,
              end: item.end + delta,
            },
          ];
        return [];
      }),
    });
  const command =
    draft.command &&
    (draft.command.end <= start
      ? draft.command
      : draft.command.start >= end
        ? {
            ...draft.command,
            start: draft.command.start + delta,
            end: draft.command.end + delta,
          }
        : undefined);
  return {
    command,
    text: draft.text.slice(0, start) + inserted + draft.text.slice(end),
    references,
    caret: start + inserted.length,
  };
}

/** Used for browser edits (IME, dictation, autocorrect); menu operations use exact ranges. */
export function reconcileDraft(
  draft: ComposerDraft,
  text: string,
  caret: number,
): ComposerDraft {
  if (draft.text === text) return { ...draft, caret };
  let start = 0;
  while (
    start < draft.text.length &&
    start < text.length &&
    draft.text[start] === text[start]
  )
    start++;
  let oldEnd = draft.text.length;
  let newEnd = text.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    draft.text[oldEnd - 1] === text[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  return {
    ...editDraft(draft, start, oldEnd, text.slice(start, newEnd)),
    caret,
  };
}

export function insertReference(
  draft: ComposerDraft,
  trigger: ComposerTrigger,
  target: ReferenceTarget,
  id: string,
): ComposerDraft {
  const label = `@${target.label}`;
  const next = editDraft(draft, trigger.start, trigger.end, `${label} `);
  const key = referenceKey(target);
  const targets = new Map(
    (next.references?.targets ?? []).map((item) => [referenceKey(item), item]),
  );
  targets.set(key, target);
  const previousOccurrences = (next.references?.occurrences ?? []).map(
    (item) => ({
      ...item,
      label:
        item.label ??
        next.references!.targets.find(
          (entry) => referenceKey(entry) === item.targetKey,
        )!.label,
    }),
  );
  const occurrences = [
    ...previousOccurrences,
    {
      id,
      label: target.label,
      start: trigger.start,
      end: trigger.start + label.length,
      targetKey: key,
    },
  ].sort((a, b) => a.start - b.start);
  return {
    ...next,
    references: { version: 1, targets: [...targets.values()], occurrences },
  };
}

export function removeReference(
  draft: ComposerDraft,
  key: string,
): ComposerDraft {
  return {
    ...draft,
    references:
      draft.references &&
      pruneReferences({
        ...draft.references,
        occurrences: draft.references.occurrences.filter(
          (item) => item.targetKey !== key,
        ),
      }),
  };
}

/** Undo owns text and annotations together. The browser's text-only history is not sufficient. */
export class ComposerDraftHistory {
  private past: ComposerDraft[] = [];
  private future: ComposerDraft[] = [];
  constructor(public current: ComposerDraft) {}
  reset(next: ComposerDraft): void {
    this.current = next;
    this.past = [];
    this.future = [];
  }
  commit(next: ComposerDraft): ComposerDraft {
    if (
      JSON.stringify(next.command) !== JSON.stringify(this.current.command) ||
      next.text !== this.current.text ||
      JSON.stringify(next.references) !==
        JSON.stringify(this.current.references)
    ) {
      this.past.push(this.current);
      if (this.past.length > 200) this.past.shift();
      this.future = [];
    }
    this.current = next;
    return next;
  }
  undo(): ComposerDraft {
    const next = this.past.pop();
    if (next) {
      this.future.push(this.current);
      this.current = next;
    }
    return this.current;
  }
  redo(): ComposerDraft {
    const next = this.future.pop();
    if (next) {
      this.past.push(this.current);
      this.current = next;
    }
    return this.current;
  }
}

function insideCode(text: string): boolean {
  let fence: string | null = null;
  let inline = 0;
  for (const line of text.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (match && !inline) {
      if (!fence) fence = match[1]!;
      else if (match[1]![0] === fence[0] && match[1]!.length >= fence.length)
        fence = null;
      continue;
    }
    if (fence) continue;
    for (const run of line.matchAll(/(?<!\\)`+/g)) {
      if (!inline) inline = run[0].length;
      else if (inline === run[0].length) inline = 0;
    }
  }
  return fence !== null || inline > 0;
}

export function detectComposerTrigger(
  draft: ComposerDraft,
  caret: number,
): ComposerTrigger | null {
  const prefix = draft.text.slice(0, caret);
  if (
    insideCode(prefix) ||
    (draft.command !== undefined &&
      draft.command.start < caret &&
      caret <= draft.command.end) ||
    draft.references?.occurrences.some(
      (item) => item.start < caret && caret <= item.end,
    )
  )
    return null;
  const lineStart = prefix.lastIndexOf("\n") + 1;
  const line = prefix.slice(lineStart);
  const command = /^(\s*)\/([^\s/\\]*)$/.exec(line);
  if (command)
    return {
      kind: "command",
      start: lineStart + command[1]!.length,
      end: caret,
      query: command[2]!,
    };
  const mention = /(?:^|\s)@([^@\r\n]*)$/.exec(line);
  if (!mention) return null;
  const start = caret - mention[1]!.length - 1;
  if (
    draft.references?.occurrences.some(
      (item) => item.start <= start && start < item.end,
    )
  )
    return null;
  return { kind: "reference", start, end: caret, query: mention[1]! };
}
