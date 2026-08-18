import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
    buildSqlEditorPagingState,
    buildSqlEditorResultPanelLayout,
    getSqlEditorResultPanelSize,
    getSqlEditorResultPanelToggleActionState,
} from "../../../../src/features/workbench/content/components/sql-editor/sql-editor-utils";
import {
    buildSqlScriptResultHeader,
    createSqlScriptBatch,
} from "../../../../src/features/workbench/content/components/sql-editor/sql-script-lifecycle";

describe("SQL editor result panel layout", () => {
    test("defaults to a collapsed result panel", () => {
        expect(
            buildSqlEditorResultPanelLayout({
                collapsed: true,
                resultPanelSize: 35,
            }),
        ).toEqual({ editorPanel: 100, resultPanel: 0 });
    });

    test("uses editor/result key order for react-resizable-panels", () => {
        const layout = buildSqlEditorResultPanelLayout({
            collapsed: false,
            resultPanelSize: 35,
        });

        expect(Object.keys(layout)).toEqual(["editorPanel", "resultPanel"]);
        expect(layout).toEqual({ editorPanel: 65, resultPanel: 35 });
    });

    test("clamps result panel size to a usable range", () => {
        expect(getSqlEditorResultPanelSize(5)).toBe(25);
        expect(getSqlEditorResultPanelSize(80)).toBe(60);
        expect(getSqlEditorResultPanelSize(40)).toBe(40);
    });

    test("describes the result panel toolbar toggle state", () => {
        expect(
            getSqlEditorResultPanelToggleActionState({
                collapsed: true,
            }),
        ).toEqual({
            icon: "resultPanelOpen",
            label: "展开结果",
            title: "展开结果栏",
            pressed: false,
        });

        expect(
            getSqlEditorResultPanelToggleActionState({
                collapsed: false,
            }),
        ).toEqual({
            icon: "resultPanelClose",
            label: "折叠结果",
            title: "折叠结果栏",
            pressed: true,
        });
    });
});

describe("SQL editor result paging state", () => {
    test("hides paging when there is no row result", () => {
        expect(
            buildSqlEditorPagingState({
                rowCount: 0,
                columnCount: 0,
                page: 1,
                pageSize: 100,
                hasNextPage: false,
            }),
        ).toEqual({
            visible: false,
            canPrevious: false,
            canNext: false,
            rangeLabel: "0 行",
        });
    });

    test("shows current row range for a row result", () => {
        expect(
            buildSqlEditorPagingState({
                rowCount: 25,
                columnCount: 3,
                page: 2,
                pageSize: 100,
                hasNextPage: false,
            }),
        ).toEqual({
            visible: true,
            canPrevious: true,
            canNext: false,
            rangeLabel: "第 101–125 行",
        });
    });

    test("enables next page only when the query result says more rows exist", () => {
        expect(
            buildSqlEditorPagingState({
                rowCount: 100,
                columnCount: 3,
                page: 1,
                pageSize: 100,
                hasNextPage: true,
            }),
        ).toEqual({
            visible: true,
            canPrevious: false,
            canNext: true,
            rangeLabel: "第 1–100 行 · 还有更多行",
        });
    });
});

describe("SQL editor script result summary", () => {
    test("builds script result summary labels", () => {
        const batch = createSqlScriptBatch({
            sqlText: "select 1;\nselect 2;",
            context: { database: "app", schema: null },
            pageSize: 100,
        });

        expect(buildSqlScriptResultHeader(batch)).toBe(
            "脚本准备执行 · 2 条 SQL",
        );
    });
});

describe("SQL editor neutral outcome rendering", () => {
    test("uses the shared presentation without driver or zero-row fallbacks", async () => {
        const source = await Bun.file(
            join(
                import.meta.dir,
                "../../../../src/features/workbench/content/components/sql-editor/SqlEditorResultPanel.tsx",
            ),
        ).text();

        expect(source).toContain("buildSqlExecutionOutcomePresentation");
        expect(source).not.toContain("affectedRows ?? 0");
        expect(source).not.toContain("statement.result");
        expect(source).not.toContain('driverName === "clickhouse"');
    });
});
