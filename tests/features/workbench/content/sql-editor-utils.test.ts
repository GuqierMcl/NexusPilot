import { describe, expect, test } from "bun:test";

import {
    buildSqlCurrentStatementHint,
    buildSqlEditorSaveSuccessPatch,
    buildSqlPrimaryRunHint,
    buildSqlScriptExecutionHint,
    resolveSqlCurrentStatementTarget,
    resolveSqlPrimaryRunTarget,
} from "../../../../src/features/workbench/content/components/sql-editor/sql-editor-utils";
import {
    applySqlScriptStatementSnapshot,
    buildSqlScriptExecutionSummary,
    createSqlScriptBatch,
    markSqlScriptRemainingSkipped,
    markSqlScriptStatementStartFailed,
    requestSqlScriptQueueStop,
} from "../../../../src/features/workbench/content/components/sql-editor/sql-script-lifecycle";
import type { SqlExecutionSnapshot } from "../../../../src/types/ipc";

describe("sql editor save success reconciliation", () => {
    test("canonicalizes persisted SQL when the editor still matches the submitted save", () => {
        const result = buildSqlEditorSaveSuccessPatch({
            currentSqlText: "  SELECT 1  ",
            currentContext: { database: " app ", schema: null },
            submittedSqlText: "  SELECT 1  ",
            submittedContext: { database: "app", schema: null },
            persistedTitle: "Smoke query",
            persistedSqlText: "SELECT 1",
            persistedContext: { database: "app", schema: null },
        });

        expect(result.patch.sqlText).toBe("SELECT 1");
        expect(result.patch.context).toEqual({ database: "app", schema: null });
        expect(result.patch.savedSnapshot).toEqual({
            title: "Smoke query",
            sqlText: "SELECT 1",
            context: { database: "app", schema: null },
        });
        expect(result.shouldClearDirty).toBe(true);
    });

    test("preserves editor changes made while the save request is pending", () => {
        const result = buildSqlEditorSaveSuccessPatch({
            currentSqlText: "SELECT 2",
            currentContext: { database: "scratch", schema: "public" },
            submittedSqlText: "SELECT 1",
            submittedContext: { database: "app", schema: "public" },
            persistedTitle: "Smoke query",
            persistedSqlText: "SELECT 1",
            persistedContext: { database: "app", schema: "public" },
        });

        expect(result.patch.sqlText).toBeUndefined();
        expect(result.patch.context).toBeUndefined();
        expect(result.patch.savedSnapshot).toEqual({
            title: "Smoke query",
            sqlText: "SELECT 1",
            context: { database: "app", schema: "public" },
        });
        expect(result.shouldClearDirty).toBe(false);
    });
});

describe("SQL editor primary run target resolution", () => {
    test("uses one selected SQL statement as a single focused target", () => {
        const result = resolveSqlPrimaryRunTarget({
            fullText: "select 1;\nselect 2;",
            selectedText: " select 2; ",
        });

        expect(result).toEqual({
            ok: true,
            kind: "single",
            source: "selection",
            sql: "select 2",
            statementCount: 1,
        });
    });

    test("uses multiple selected SQL statements as a selection script target", () => {
        const result = resolveSqlPrimaryRunTarget({
            fullText: "select 1;\nselect 2;\nselect 3;",
            selectedText: " select 1;\nselect 2; ",
        });

        expect(result).toEqual({
            ok: true,
            kind: "script",
            source: "selection",
            sqlText: "select 1;\nselect 2;",
            statementCount: 2,
        });
    });

    test("uses all SQL as the default target when selection is empty", () => {
        const sql = "select 1;\nselect 2;";
        const result = resolveSqlPrimaryRunTarget({
            fullText: sql,
            selectedText: "",
        });

        expect(result).toEqual({
            ok: true,
            kind: "script",
            source: "all",
            sqlText: sql,
            statementCount: 2,
        });
    });

    test("keeps a one-statement full editor run in the focused result flow", () => {
        const result = resolveSqlPrimaryRunTarget({
            fullText: " select 1; ",
            selectedText: "",
        });

        expect(result).toEqual({
            ok: true,
            kind: "single",
            source: "all",
            sql: "select 1",
            statementCount: 1,
        });
    });

    test("rejects empty editor content", () => {
        const result = resolveSqlPrimaryRunTarget({
            fullText: "  -- comment only\n  ",
            selectedText: "",
        });

        expect(result).toEqual({ ok: false, reason: "empty" });
    });
});

describe("SQL editor current statement target resolution", () => {
    test("uses the cursor statement without depending on selection", () => {
        const sql = "select 1;\nselect 2;";
        const result = resolveSqlCurrentStatementTarget({
            fullText: sql,
            cursorOffset: sql.indexOf("select 2"),
        });

        expect(result).toEqual({
            ok: true,
            source: "current",
            sql: "select 2",
            statementIndex: 2,
        });
    });

    test("rejects empty editor content", () => {
        const result = resolveSqlCurrentStatementTarget({
            fullText: "  -- comment only\n  ",
            cursorOffset: 0,
        });

        expect(result).toEqual({ ok: false, reason: "empty" });
    });

    test("rejects cursor gaps between statements", () => {
        const sql = "select 1;\n\nselect 2;";
        const result = resolveSqlCurrentStatementTarget({
            fullText: sql,
            cursorOffset: sql.indexOf("\n\n") + 1,
        });

        expect(result).toEqual({ ok: false, reason: "no_statement" });
    });
});

describe("SQL editor execution target hint", () => {
    test("describes one selected SQL statement as the primary run target", () => {
        const result = buildSqlPrimaryRunHint({
            fullText: "select 1;\nselect 2;",
            selectedText: " select 2; ",
            isExecuting: false,
        });

        expect(result).toEqual({
            tone: "ready",
            label: "将执行已选取 SQL · 1 条",
            title: "点击运行会执行当前选中的单条 SQL",
            runTitle: "执行已选取 SQL",
        });
    });

    test("describes multiple selected SQL statements as the primary run target", () => {
        const result = buildSqlPrimaryRunHint({
            fullText: "select 1;\nselect 2;\nselect 3;",
            selectedText: "select 1;\nselect 2;",
            isExecuting: false,
        });

        expect(result).toEqual({
            tone: "ready",
            label: "将按顺序执行已选取 SQL · 2 条",
            title: "点击运行会按顺序执行当前选中的 2 条 SQL",
            runTitle: "按顺序执行已选取 SQL",
        });
    });

    test("describes all SQL as the primary run target when selection is empty", () => {
        const result = buildSqlPrimaryRunHint({
            fullText: "select 1;\nselect 2;",
            selectedText: "",
            isExecuting: false,
        });

        expect(result).toEqual({
            tone: "ready",
            label: "将按顺序执行全部 SQL · 2 条",
            title: "点击运行会按顺序执行编辑器内的 2 条 SQL",
            runTitle: "运行全部 SQL",
        });
    });

    test("describes running selected SQL explicitly", () => {
        const result = buildSqlPrimaryRunHint({
            fullText: "select 1;\nselect 2;",
            selectedText: "select 2;",
            isExecuting: true,
        });

        expect(result.label).toBe("正在执行已选取 SQL · 1 条");
        expect(result.tone).toBe("running");
    });

    test("describes the current statement dropdown action", () => {
        const sql = "select 1;\nselect 2;";
        const result = buildSqlCurrentStatementHint({
            fullText: sql,
            cursorOffset: sql.indexOf("select 2"),
            isExecuting: false,
        });

        expect(result).toEqual({
            tone: "ready",
            label: "将执行当前语句 · 第 2 条",
            title: "点击运行当前语句会执行光标所在 SQL 语句",
            runTitle: "执行当前语句",
        });
    });

    test("describes Run All as a sequential script target", () => {
        const result = buildSqlScriptExecutionHint({
            sqlText: "select 1;\nselect 2;",
            source: "all",
            isExecuting: false,
            stopRequested: false,
        });

        expect(result).toEqual({
            tone: "ready",
            label: "将按顺序执行全部 SQL · 2 条",
            title: "点击运行全部会按顺序执行编辑器内的 2 条 SQL",
            runTitle: "按顺序执行全部 SQL",
        });
    });

    test("describes a running script without implying focused execution", () => {
        const result = buildSqlScriptExecutionHint({
            sqlText: "select 1;\nselect 2;",
            source: "selection",
            isExecuting: true,
            stopRequested: false,
        });

        expect(result.label).toBe("正在按顺序执行已选取 SQL · 2 条");
        expect(result.tone).toBe("running");
    });
});

describe("SQL editor script execution state", () => {
    function snapshot(state: SqlExecutionSnapshot["state"]): SqlExecutionSnapshot {
        return {
            executionId: "execution-1",
            queryId: "query-1",
            tabId: "runtime-tab",
            state,
            revision: state === "succeeded" ? 2 : 1,
            statementClass: "read",
            startedAt: 1_000,
            finishedAt: state === "succeeded" ? 1_010 : null,
            progressAvailable: false,
            summary: null,
            outcome:
                state === "succeeded"
                    ? {
                          kind: "rows",
                          result: {
                              columns: [],
                              rows: [],
                              hasNextPage: false,
                              sourceWritable: false,
                              sourceInsertable: false,
                              primaryKeyColumns: [],
                              stableOrderColumns: [],
                          },
                      }
                    : null,
            failure: null,
            cancelMessage: null,
        };
    }

    test("creates an ordered script batch from executable statements", () => {
        const batch = createSqlScriptBatch({
            sqlText: "select 1;\n-- comment\nselect 2;",
            context: { database: "app", schema: null },
            pageSize: 100,
        });

        expect(batch.statements.map((item) => item.sql)).toEqual([
            "select 1",
            "-- comment\nselect 2",
        ]);
        expect(batch.selectedStatementId).toBe("statement-1");
        expect(batch.summaryLabel).toBe("准备按顺序执行 2 条 SQL");
        expect(buildSqlScriptExecutionSummary(batch)).toEqual({
            total: 2,
            succeeded: 0,
            failed: 0,
            timedOut: 0,
            canceled: 0,
            cancelFailed: 0,
            skipped: 0,
            running: 0,
            pending: 2,
        });
    });

    test("marks succeeded script statements without mutating the original batch", () => {
        const batch = createSqlScriptBatch({
            sqlText: "select 1;",
            context: { database: "app", schema: null },
            pageSize: 100,
        });

        const running = applySqlScriptStatementSnapshot(
            batch,
            "statement-1",
            snapshot("running"),
        );
        const succeeded = applySqlScriptStatementSnapshot(
            running,
            "statement-1",
            snapshot("succeeded"),
        );

        expect(batch.statements[0].status).toBe("pending");
        expect(succeeded.statements[0].status).toBe("succeeded");
        expect(succeeded.statements[0].outcome?.kind).toBe("rows");
        expect(succeeded.activeStatementId).toBeNull();
    });

    test("marks failed script statement and skips remaining statements", () => {
        const batch = createSqlScriptBatch({
            sqlText: "select 1;\nselect broken;\nselect 3;",
            context: { database: "app", schema: null },
            pageSize: 100,
        });
        const failed = markSqlScriptStatementStartFailed(batch, "statement-2", {
            code: "QUERY_SYNTAX_ERROR",
            message: "bad SQL",
        });
        const skipped = markSqlScriptRemainingSkipped(failed, 1);

        expect(skipped.statements.map((item) => item.status)).toEqual([
            "pending",
            "failed",
            "skipped",
        ]);
        expect(buildSqlScriptExecutionSummary(skipped)).toEqual({
            total: 3,
            succeeded: 0,
            failed: 1,
            timedOut: 0,
            canceled: 0,
            cancelFailed: 0,
            skipped: 1,
            running: 0,
            pending: 1,
        });
    });

    test("stops queued script statements after current statement settles", () => {
        const batch = createSqlScriptBatch({
            sqlText: "select 1;\nselect 2;\nselect 3;",
            context: { database: "app", schema: null },
            pageSize: 100,
        });
        const stopped = requestSqlScriptQueueStop(batch);
        const skipped = markSqlScriptRemainingSkipped(stopped, 0);

        expect(skipped.stopRequested).toBe(true);
        expect(skipped.statements.map((item) => item.status)).toEqual([
            "pending",
            "skipped",
            "skipped",
        ]);
    });
});
