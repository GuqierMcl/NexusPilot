import { expect, test } from "bun:test";

import { resolveSqlContextMode } from "../../../../src/features/workbench/content/components/sql-editor/SqlEditorView";

test("uses the generic database-only SQL context for ClickHouse", () => {
    expect(resolveSqlContextMode("clickhouse")).toEqual({
        showDatabase: true,
        showSchema: false,
        schemaParent: "none",
    });
});
