import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const sqlEditorViewPath = join(
    import.meta.dir,
    "../../../../src/features/workbench/content/components/sql-editor/SqlEditorView.tsx",
);

async function readSqlEditorViewSource() {
    return await Bun.file(sqlEditorViewPath).text();
}

describe("SQL editor autocomplete integration", () => {
    test("wires completion metadata and Monaco provider into SqlEditorView", async () => {
        const source = await readSqlEditorViewSource();

        expect(source).toContain("registerSqlCompletionProvider");
        expect(source).toContain("triggerSqlColumnSuggestIfNeeded");
        expect(source).toContain(
            'import { useSqlCompletionMetadata } from "./useSqlCompletionMetadata";',
        );
        expect(source).toContain("const sqlEditorRef = useRef");
        expect(source).toContain("const completionContextRef = useRef");
        expect(source).toContain("const completionMetadata = useSqlCompletionMetadata");
        expect(source).toContain("sqlText: state.sqlText");
        expect(source).toContain("cursorOffset: editorTargetState.cursorOffset");
        expect(source).toContain("columns: completionMetadata.columns");
        expect(source).toContain("columnsAvailable: completionMetadata.columns.length > 0");
        expect(source).toContain(
            "const completionDisposable = registerSqlCompletionProvider",
        );
        expect(source).toContain("getCompletionContext: () => completionContextRef.current");
    });
});
