import type { CodeEditorOnMount } from "@/components/editor";

import {
    buildSqlCompletionItems,
    type SqlCompletionBuildInput,
    type SqlCompletionItem,
    type SqlCompletionKind,
} from "./sql-completion";
import { resolveSqlColumnCompletionTrigger } from "./sql-column-completion";

type MonacoEditor = Parameters<CodeEditorOnMount>[0];
type MonacoNamespace = Parameters<CodeEditorOnMount>[1];
type MonacoModel = NonNullable<ReturnType<MonacoEditor["getModel"]>>;
type MonacoPosition = Parameters<MonacoModel["getWordUntilPosition"]>[0];
type MonacoRange = {
    startLineNumber: number;
    endLineNumber: number;
    startColumn: number;
    endColumn: number;
};
type MonacoCompletionProvider = Parameters<
    MonacoNamespace["languages"]["registerCompletionItemProvider"]
>[1];
type SqlSuggestEditor = {
    getModel: MonacoEditor["getModel"];
    getPosition: MonacoEditor["getPosition"];
    hasTextFocus?: MonacoEditor["hasTextFocus"];
    trigger: MonacoEditor["trigger"];
};

export interface RegisterSqlCompletionProviderInput {
    editor: MonacoEditor;
    monaco: MonacoNamespace;
    getCompletionContext: () => SqlCompletionBuildInput;
}

export function registerSqlCompletionProvider({
    editor,
    monaco,
    getCompletionContext,
}: RegisterSqlCompletionProviderInput) {
    const provider: MonacoCompletionProvider = {
        triggerCharacters: [".", " ", "`", '"'],
        provideCompletionItems(model: MonacoModel, position: MonacoPosition) {
            if (model !== editor.getModel()) {
                return { suggestions: [] };
            }

            const word = model.getWordUntilPosition(position);
            const range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn,
            };
            const sqlText = model.getValue();
            const cursorOffset = model.getOffsetAt(position);
            const completionMode = resolveSqlColumnCompletionTrigger({
                sqlText,
                cursorOffset,
            })
                ? "columns"
                : "global";

            return {
                suggestions: buildSqlCompletionItems(getCompletionContext(), {
                    mode: completionMode,
                }).map((item) => toMonacoCompletionItem(monaco, item, range)),
            };
        },
    };
    const providerDisposable = monaco.languages.registerCompletionItemProvider(
        "sql",
        provider,
    );
    let disposed = false;
    const editorDisposeListener = editor.onDidDispose(() => {
        if (!disposed) {
            disposed = true;
            providerDisposable.dispose();
        }
    });

    return {
        dispose() {
            if (disposed) return;
            disposed = true;
            editorDisposeListener.dispose();
            providerDisposable.dispose();
        },
    };
}

export function triggerSqlColumnSuggestIfNeeded({
    editor,
    columnsAvailable,
}: {
    editor: SqlSuggestEditor | null;
    columnsAvailable: boolean;
}): boolean {
    if (!editor || !columnsAvailable) return false;
    if (editor.hasTextFocus && !editor.hasTextFocus()) return false;

    const model = editor.getModel();
    const position = editor.getPosition();
    if (!model || !position) return false;

    const columnTrigger = resolveSqlColumnCompletionTrigger({
        sqlText: model.getValue(),
        cursorOffset: model.getOffsetAt(position),
    });
    if (!columnTrigger) return false;

    editor.trigger("sql-editor", "editor.action.triggerSuggest", {});
    return true;
}

function toMonacoCompletionItem(
    monaco: MonacoNamespace,
    item: SqlCompletionItem,
    range: MonacoRange,
) {
    return {
        label: item.label,
        kind: getMonacoCompletionKind(monaco, item.kind),
        insertText: item.insertText,
        detail: item.detail,
        sortText: item.sortText,
        filterText: item.filterText ?? item.label,
        range,
        ...(item.insertAsSnippet
            ? {
                  insertTextRules:
                      monaco.languages.CompletionItemInsertTextRule
                          .InsertAsSnippet,
              }
            : {}),
    };
}

function getMonacoCompletionKind(
    monaco: MonacoNamespace,
    kind: SqlCompletionKind,
) {
    switch (kind) {
        case "keyword":
            return monaco.languages.CompletionItemKind.Keyword;
        case "snippet":
            return monaco.languages.CompletionItemKind.Snippet;
        case "database":
            return monaco.languages.CompletionItemKind.Module;
        case "schema":
            return monaco.languages.CompletionItemKind.Namespace;
        case "table":
            return monaco.languages.CompletionItemKind.Class;
        case "view":
        case "materialized_view":
            return monaco.languages.CompletionItemKind.Struct;
        case "column":
            return monaco.languages.CompletionItemKind.Field;
    }
}
