import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const contentToolbarPath = join(
    import.meta.dir,
    "../../../../src/features/workbench/content/components/ContentToolbar.tsx",
);
const sqlEditorViewPath = join(
    import.meta.dir,
    "../../../../src/features/workbench/content/components/sql-editor/SqlEditorView.tsx",
);
const sqlEditorToolbarHookPath = join(
    import.meta.dir,
    "../../../../src/features/workbench/content/components/sql-editor/useSqlEditorToolbar.ts",
);

async function readContentToolbarSource() {
    return (await Bun.file(contentToolbarPath).text()).replace(/\r\n/g, "\n");
}

async function readSqlEditorViewSource() {
    return (await Bun.file(sqlEditorViewPath).text()).replace(/\r\n/g, "\n");
}

async function readSqlEditorToolbarHookSource() {
    return (await Bun.file(sqlEditorToolbarHookPath).text()).replace(/\r\n/g, "\n");
}

describe("ContentToolbar SQL editor actions", () => {
    test("does not expose static SQL editor actions without live handlers", async () => {
        const source = await readContentToolbarSource();

        expect(source).toContain("useContentToolbarStore");
        expect(source).not.toContain('case "sql_editor"');
        expect(source).not.toContain("tab.type");
        expect(source).not.toContain('title: "执行查询 (Ctrl+Enter)"');
    });

    test("renders SQL editor result panel toggle as a live toolbar action", async () => {
        const toolbarSource = await readContentToolbarSource();
        const sqlEditorToolbarHookSource = await readSqlEditorToolbarHookSource();
        const sqlEditorSource = await readSqlEditorViewSource();

        expect(toolbarSource).toContain("toolbarModel?.actions");
        expect(sqlEditorToolbarHookSource).toContain("PanelBottomOpen");
        expect(sqlEditorToolbarHookSource).toContain("PanelBottomClose");
        expect(sqlEditorToolbarHookSource).toContain(
            'resultPanelToggleAction.icon === "resultPanelOpen"',
        );
        expect(sqlEditorSource).toContain("handleToggleResultPanel");
        expect(sqlEditorToolbarHookSource).toContain('id: "toggleResultPanel"');
        expect(sqlEditorToolbarHookSource).toContain(
            "getSqlEditorResultPanelToggleActionState",
        );
        expect(sqlEditorToolbarHookSource).toContain(
            "onClick: onToggleResultPanel",
        );
    });

    test("renders primary Run as a split action with explicit SQL run choices", async () => {
        const toolbarSource = await readContentToolbarSource();
        const sqlEditorToolbarHookSource = await readSqlEditorToolbarHookSource();
        const sqlEditorSource = await readSqlEditorViewSource();

        expect(toolbarSource).toContain("DropdownMenu");
        expect(toolbarSource).toContain("action.menuItems");
        expect(toolbarSource).toContain("ChevronDown");
        expect(sqlEditorToolbarHookSource).toContain("runTitle");
        expect(sqlEditorToolbarHookSource).toContain("menuItems");
        expect(sqlEditorToolbarHookSource).toContain('id: "runScript"');
        expect(sqlEditorToolbarHookSource).toContain('id: "runSelection"');
        expect(sqlEditorToolbarHookSource).toContain('id: "runCurrentStatement"');
        expect(sqlEditorSource).toContain("editorCursorOffsetRef");
        expect(sqlEditorSource).toContain("editorTargetState");
        expect(sqlEditorSource).toContain("buildSqlPrimaryRunHint");
        expect(sqlEditorSource).toContain("buildSqlCurrentStatementHint");
        expect(sqlEditorSource).toContain("SqlExecutionTargetHint");
        expect(sqlEditorSource).toContain("resolveSqlPrimaryRunTarget");
        expect(sqlEditorSource).toContain("resolveSqlCurrentStatementTarget");
        expect(sqlEditorSource).toContain("handleRunSelection");
        expect(sqlEditorSource).toContain("handleRunCurrentStatement");
        expect(sqlEditorSource).toContain("model.getOffsetAt(position)");
    });

    test("renders menuItems for neutral secondary actions without tab knowledge", async () => {
        const toolbarSource = await readContentToolbarSource();
        const sqlEditorSource = await readSqlEditorViewSource();
        const sqlEditorToolbarHookSource = await readSqlEditorToolbarHookSource();

        expect(toolbarSource).toContain("!isPrimary && menuItems.length > 0");
        expect(toolbarSource).toContain("<DropdownMenu key={action.id}>");
        expect(sqlEditorToolbarHookSource).toContain(
            "buildSqlExecutionTimeoutAction",
        );
        expect(sqlEditorSource).toContain("handleTimeoutChange");
        expect(sqlEditorSource).toContain("...current.executionOptions");
        expect(toolbarSource).not.toContain("sql_editor");
        expect(toolbarSource).not.toContain("tab.type");
        expect(toolbarSource).not.toContain("clickhouse");
    });

    test("keeps SQL editor keyboard shortcuts out of local feature code", async () => {
        const sqlEditorSource = await readSqlEditorViewSource();

        expect(sqlEditorSource).not.toContain("editor.addCommand(");
        expect(sqlEditorSource).not.toContain("monaco.KeyMod.CtrlCmd");
        expect(sqlEditorSource).not.toContain("monaco.KeyCode.Enter");
    });

    test("keeps Run All in the Run menu and Stop Queue as an active-batch action", async () => {
        const sqlEditorToolbarHookSource = await readSqlEditorToolbarHookSource();
        const sqlEditorSource = await readSqlEditorViewSource();

        expect(sqlEditorToolbarHookSource).toContain('id: "runScript"');
        expect(sqlEditorToolbarHookSource).toContain('label: "运行全部"');
        expect(sqlEditorToolbarHookSource).toContain('label: "运行已选取 SQL"');
        expect(sqlEditorToolbarHookSource).toContain('label: "运行当前语句"');
        expect(sqlEditorToolbarHookSource).toContain('id: "stopScript"');
        expect(sqlEditorToolbarHookSource).toContain('label: "停止队列"');
        expect(sqlEditorSource).toContain("handleRunScript");
        expect(sqlEditorSource).toContain("handleRunSelection");
        expect(sqlEditorSource).toContain("handleRunCurrentStatement");
        expect(sqlEditorSource).toContain("handleStopScript");
    });
});
