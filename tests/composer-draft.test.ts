import { expect, test } from "bun:test";
import {
    ComposerDraftHistory,
    detectComposerTrigger,
    editDraft,
    insertReference,
    reconcileDraft,
    removeReference,
} from "../src/features/workbench/agent/composer/composer-draft";
import {
    referenceKey,
    validateTextReferences,
} from "@contracts/composer-references";
import {
    createCommandRegistry,
    createSourceRegistry,
    searchSources,
} from "../src/features/workbench/agent/composer/composer-registry";
import {
    createConnectionSource,
    createWorkbenchComposerRegistry,
} from "../src/features/workbench/agent/composer/workbench-composer-registry";

const target = {
    sourceId: "connections",
    type: "connection",
    version: 1,
    id: "a",
    label: "开发😀",
    data: { driver: "postgres" },
};
const start = { text: "比较 @", caret: 4 };
const bound = insertReference(
    start,
    detectComposerTrigger(start, 4)!,
    target,
    "r1",
);
test("trigger boundaries exclude email, paths and code; support Chinese query", () => {
    for (const text of [
        "a@b",
        "看 /help",
        "/usr/bin",
        "`@a",
        "```sql\n@a",
        "~~~\n@a",
    ]) {
        expect(
            detectComposerTrigger({ text, caret: text.length }, text.length),
        ).toBeNull();
    }
    expect(
        detectComposerTrigger({ text: "请看 @开发", caret: 6 }, 6)?.query,
    ).toBe("开发");
    expect(detectComposerTrigger({ text: "  /help", caret: 7 }, 7)?.kind).toBe(
        "command",
    );
});
test("range edits preserve identity outside and unbind internal edits", () => {
    expect(editDraft(bound, 0, 0, "😀").references?.occurrences[0]?.start).toBe(
        5,
    );
    expect(editDraft(bound, 3, 3, "前").references?.occurrences[0]?.start).toBe(
        4,
    );
    expect(editDraft(bound, 5, 5, "改").references).toBeUndefined();
    expect(
        reconcileDraft(bound, "前" + bound.text, bound.text.length + 1)
            .references?.occurrences[0]?.start,
    ).toBe(4);
});
test("undo and redo restore references, target removal keeps readable text", () => {
    const history = new ComposerDraftHistory(start);
    history.commit(bound);
    history.commit(removeReference(bound, referenceKey(target)));
    expect(history.current.text).toBe(bound.text);
    expect(history.undo().references).toEqual(bound.references);
    expect(history.undo().text).toBe(start.text);
    expect(history.redo().references).toEqual(bound.references);
});
test("second source and commands plug in; collisions fail explicitly", async () => {
    const directory = {
        connections: [{ id: "a", name: "开发", driver: "postgres" }],
        isLoading: false,
        error: null,
    };
    const source = createConnectionSource(() => directory);
    const registry = createSourceRegistry([
        source,
        { ...source, id: "second", title: "另一来源", search: async () => [] },
    ]);
    expect(
        (await searchSources(registry, "", new AbortController().signal))
            .length,
    ).toBe(2);
    expect(() => createSourceRegistry([source, source])).toThrow();
    const commands = createWorkbenchComposerRegistry(() => directory).commands;
    expect(() =>
        createCommandRegistry([...commands.list, commands.list[0]!]),
    ).toThrow();
    expect(
        createCommandRegistry([
            ...commands.list,
            { ...commands.list[0]!, id: "test", name: "test", aliases: [] },
        ]).search("test"),
    ).toHaveLength(1);
});
test("source failure is isolated and cancelled searches return no candidates", async () => {
    const source = createConnectionSource(() => ({
        connections: [{ id: "a", name: "A", driver: "redis" }],
        isLoading: false,
        error: null,
    }));
    const registry = createSourceRegistry([
        source,
        {
            ...source,
            id: "broken",
            availability: () => ({ available: false, reason: "不可用" }),
        },
    ]);
    const controller = new AbortController();
    expect(
        (await searchSources(registry, "", controller.signal)).find(
            (group) => group.sourceId === "connections",
        )?.candidates,
    ).toHaveLength(1);
    controller.abort();
    expect(await searchSources(registry, "", controller.signal)).toEqual([]);
});

test("same identity keeps each occurrence's label after a directory rename", () => {
    const appended = editDraft(
        bound,
        bound.text.length,
        bound.text.length,
        "@",
    );
    const twice = insertReference(
        appended,
        detectComposerTrigger(appended, appended.caret)!,
        { ...target, label: "新名字" },
        "r2",
    );
    expect(twice.references?.targets).toHaveLength(1);
    expect(twice.text).toContain("@开发😀");
    expect(twice.text).toContain("@新名字");
    expect(() =>
        validateTextReferences(twice.text, twice.references),
    ).not.toThrow();
    expect(detectComposerTrigger(twice, twice.caret)).toBeNull();
});

test("different source namespaces stay separate; templates shift existing references atomically", () => {
    const appended = editDraft(
        bound,
        bound.text.length,
        bound.text.length,
        "@",
    );
    const twice = insertReference(
        appended,
        detectComposerTrigger(appended, appended.caret)!,
        { ...target, sourceId: "second" },
        "r2",
    );
    expect(twice.references?.targets).toHaveLength(2);
    const withCommand = editDraft(twice, 0, 0, "/explain\n");
    const result = editDraft(withCommand, 0, 8, "说明：\n");
    expect(result.references?.occurrences[0]?.start).toBe(
        bound.references!.occurrences[0]!.start + 5,
    );
    expect(() =>
        validateTextReferences(result.text, result.references),
    ).not.toThrow();
});

test("async sources isolate thrown errors and discard work after cancellation", async () => {
    let resolve!: (value: readonly never[]) => void;
    const base = createConnectionSource(() => ({
        connections: [],
        isLoading: false,
        error: null,
    }));
    const controller = new AbortController();
    const pending = searchSources(
        createSourceRegistry([
            {
                ...base,
                search: () =>
                    new Promise((done) => {
                        resolve = done;
                    }),
            },
        ]),
        "old",
        controller.signal,
    );
    controller.abort();
    resolve([]);
    expect(await pending).toEqual([]);
    const result = await searchSources(
        createSourceRegistry([
            {
                ...base,
                id: "bad",
                search: async () => {
                    throw new Error("test source");
                },
            },
            base,
        ]),
        "",
        new AbortController().signal,
    );
    expect(
        result.find((group) => group.sourceId === "bad")?.error,
    ).toBeDefined();
    expect(
        result.find((group) => group.sourceId === base.id)?.error,
    ).toBeUndefined();
});
