import { expect, test } from "bun:test";
import { join } from "node:path";

const sqlEditorViewPath = join(
    import.meta.dir,
    "../../../../src/features/workbench/content/components/sql-editor/SqlEditorView.tsx",
);

test("SqlEditorView routes focused and script statements through one lifecycle", async () => {
    const source = await Bun.file(sqlEditorViewPath).text();

    expect(source).toContain("useSqlExecutionLifecycle");
    expect(source).toContain("lifecycle.execute");
    expect(source).toContain("applySqlScriptStatementSnapshot");
    expect(source).not.toContain("executeLegacyScriptStatement");
    expect(source).not.toContain(
        "const executeMutation = useMutation<QueryResult",
    );
    expect(source).not.toContain('normalizedDriverName === "clickhouse"');
});
