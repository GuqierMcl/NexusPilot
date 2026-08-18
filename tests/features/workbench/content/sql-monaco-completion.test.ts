import { describe, expect, test } from "bun:test";

import {
    registerSqlCompletionProvider,
    triggerSqlColumnSuggestIfNeeded,
} from "../../../../src/features/workbench/content/components/sql-editor/sql-monaco-completion";

function createModel(value = "") {
    return {
        getValue: () => value,
        getOffsetAt: (position: { column: number }) => position.column - 1,
        getWordUntilPosition() {
            return {
                startColumn: 1,
                endColumn: 1,
            };
        },
    };
}

describe("SQL Monaco completion provider", () => {
    test("scopes suggestions to the mounted editor model and disposes provider", () => {
        const editorModel = createModel();
        const foreignModel = createModel();
        let provider: {
            provideCompletionItems: (
                model: unknown,
                position: { lineNumber: number; column: number },
            ) => { suggestions: Array<{ label: string }> };
        } | null = null;
        let providerDisposed = 0;
        let editorDisposeHandler: (() => void) | null = null;
        let editorDisposeListenerDisposed = 0;
        const editor = {
            getModel: () => editorModel,
            onDidDispose: (handler: () => void) => {
                editorDisposeHandler = handler;
                return {
                    dispose: () => {
                        editorDisposeListenerDisposed += 1;
                    },
                };
            },
        };
        const monaco = {
            languages: {
                CompletionItemInsertTextRule: {
                    InsertAsSnippet: 4,
                },
                CompletionItemKind: {
                    Class: 1,
                    Field: 7,
                    Keyword: 2,
                    Module: 3,
                    Namespace: 4,
                    Snippet: 5,
                    Struct: 6,
                },
                registerCompletionItemProvider: (
                    language: string,
                    nextProvider: typeof provider,
                ) => {
                    expect(language).toBe("sql");
                    provider = nextProvider;
                    return {
                        dispose: () => {
                            providerDisposed += 1;
                        },
                    };
                },
            },
        };

        const disposable = registerSqlCompletionProvider({
            editor: editor as never,
            monaco: monaco as never,
            getCompletionContext: () => ({
                driverName: "mysql",
                showSchema: false,
                databases: ["app"],
                schemas: [],
                objects: [
                    { kind: "table", name: "users", database: "app", schema: null },
                ],
            }),
        });

        const currentSuggestions = provider?.provideCompletionItems(editorModel, {
            lineNumber: 1,
            column: 1,
        }).suggestions;
        const foreignSuggestions = provider?.provideCompletionItems(foreignModel, {
            lineNumber: 1,
            column: 1,
        }).suggestions;

        expect(currentSuggestions?.some((item) => item.label === "SELECT")).toBe(
            true,
        );
        expect(currentSuggestions?.some((item) => item.label === "users")).toBe(
            true,
        );
        expect(foreignSuggestions).toEqual([]);

        editorDisposeHandler?.();
        disposable.dispose();

        expect(providerDisposed).toBe(1);
        expect(editorDisposeListenerDisposed).toBe(0);
    });

    test("returns column suggestions when the cursor is after an object qualifier", () => {
        const editorModel = createModel("users.");
        let provider: {
            provideCompletionItems: (
                model: unknown,
                position: { lineNumber: number; column: number },
            ) => { suggestions: Array<{ label: string; kind: number }> };
        } | null = null;
        const editor = {
            getModel: () => editorModel,
            onDidDispose: () => ({ dispose: () => undefined }),
        };
        const monaco = {
            languages: {
                CompletionItemInsertTextRule: {
                    InsertAsSnippet: 4,
                },
                CompletionItemKind: {
                    Class: 1,
                    Field: 7,
                    Keyword: 2,
                    Module: 3,
                    Namespace: 4,
                    Snippet: 5,
                    Struct: 6,
                },
                registerCompletionItemProvider: (
                    _language: string,
                    nextProvider: typeof provider,
                ) => {
                    provider = nextProvider;
                    return { dispose: () => undefined };
                },
            },
        };

        registerSqlCompletionProvider({
            editor: editor as never,
            monaco: monaco as never,
            getCompletionContext: () => ({
                driverName: "mysql",
                showSchema: false,
                databases: ["app"],
                schemas: [],
                objects: [
                    {
                        kind: "table",
                        name: "users",
                        database: "app",
                        schema: null,
                    },
                ],
                columns: [
                    {
                        name: "id",
                        typeName: "int",
                        nullable: false,
                        objectName: "users",
                    },
                ],
            }),
        });

        const suggestions = provider?.provideCompletionItems(editorModel, {
            lineNumber: 1,
            column: "users.".length + 1,
        }).suggestions;

        expect(suggestions).toEqual([
            expect.objectContaining({
                label: "id",
                kind: 7,
            }),
        ]);
    });

    test("reopens suggestions after async column metadata becomes available", () => {
        const editorModel = createModel("users.");
        const triggerCalls: Array<{
            source: string;
            handlerId: string;
            payload: unknown;
        }> = [];
        const editor = {
            getModel: () => editorModel,
            getPosition: () => ({
                lineNumber: 1,
                column: "users.".length + 1,
            }),
            hasTextFocus: () => true,
            trigger: (source: string, handlerId: string, payload: unknown) => {
                triggerCalls.push({ source, handlerId, payload });
            },
        };

        expect(
            triggerSqlColumnSuggestIfNeeded({
                editor: editor as never,
                columnsAvailable: false,
            }),
        ).toBe(false);
        expect(triggerCalls).toEqual([]);

        expect(
            triggerSqlColumnSuggestIfNeeded({
                editor: editor as never,
                columnsAvailable: true,
            }),
        ).toBe(true);

        expect(triggerCalls).toEqual([
            {
                source: "sql-editor",
                handlerId: "editor.action.triggerSuggest",
                payload: {},
            },
        ]);
    });

    test("does not reopen suggestions when the cursor is not in a column target", () => {
        const editorModel = createModel("select ");
        const triggerCalls: string[] = [];
        const editor = {
            getModel: () => editorModel,
            getPosition: () => ({
                lineNumber: 1,
                column: "select ".length + 1,
            }),
            hasTextFocus: () => true,
            trigger: (_source: string, handlerId: string) => {
                triggerCalls.push(handlerId);
            },
        };

        expect(
            triggerSqlColumnSuggestIfNeeded({
                editor: editor as never,
                columnsAvailable: true,
            }),
        ).toBe(false);
        expect(triggerCalls).toEqual([]);
    });
});
