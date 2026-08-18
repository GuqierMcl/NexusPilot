import { describe, expect, test } from "bun:test";

import {
    applySqlScriptStatementSnapshot,
    buildSqlScriptExecutionSummary,
    buildSqlScriptResultHeader,
    createSqlScriptBatch,
    markSqlScriptBatchFinished,
    markSqlScriptRemainingSkipped,
    requestSqlScriptActiveCancel,
    requestSqlScriptQueueStop,
} from "../../../../src/features/workbench/content/components/sql-editor/sql-script-lifecycle";
import type { SqlExecutionSnapshot } from "../../../../src/types/ipc";

function snapshot(
    state: SqlExecutionSnapshot["state"],
    revision: number,
    executionId = "execution-1",
): SqlExecutionSnapshot {
    return {
        executionId,
        queryId: `query-${executionId}`,
        tabId: "runtime-tab",
        state,
        revision,
        statementClass: "read",
        startedAt: 1_000,
        finishedAt: state === "succeeded" ? 1_250 : null,
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
        cancelMessage: state === "canceled" ? "查询已取消" : null,
    };
}

describe("managed SQL script lifecycle", () => {
    test("stores per-statement identity snapshot and outcome", () => {
        const batch = createSqlScriptBatch({
            sqlText: "SELECT 1; SELECT 2;",
            context: { database: "app", schema: null },
            pageSize: 100,
        });
        const running = applySqlScriptStatementSnapshot(
            batch,
            "statement-1",
            snapshot("running", 2),
        );
        const succeeded = applySqlScriptStatementSnapshot(
            running,
            "statement-1",
            snapshot("succeeded", 3),
        );

        expect(succeeded.statements[0]).toMatchObject({
            status: "succeeded",
            executionId: "execution-1",
            queryId: "query-execution-1",
            elapsedMs: 250,
        });
        expect(succeeded.statements[0]?.outcome?.kind).toBe("rows");
        expect(succeeded.activeStatementId).toBeNull();
    });

    test("stops after timedOut canceled cancelFailed or failed terminal", () => {
        for (const state of [
            "timedOut",
            "canceled",
            "cancelFailed",
            "failed",
        ] as const) {
            const batch = createSqlScriptBatch({
                sqlText: "SELECT 1; SELECT 2; SELECT 3;",
                context: { database: "app", schema: null },
                pageSize: 100,
            });
            const terminal = applySqlScriptStatementSnapshot(
                batch,
                "statement-1",
                snapshot(state, 4),
            );
            const stopped = markSqlScriptRemainingSkipped(terminal, 0);
            expect(stopped.statements.map((item) => item.status)).toEqual([
                state,
                "skipped",
                "skipped",
            ]);
        }
    });

    test("Stop Queue leaves active execution while Cancel Active also stops queue", () => {
        const running = applySqlScriptStatementSnapshot(
            createSqlScriptBatch({
                sqlText: "SELECT 1; SELECT 2;",
                context: { database: "app", schema: null },
                pageSize: 100,
            }),
            "statement-1",
            snapshot("running", 2),
        );
        const stopped = requestSqlScriptQueueStop(running);
        expect(stopped.activeStatementId).toBe("statement-1");
        expect(stopped.stopRequested).toBe(true);
        expect(stopped.cancelRequested).toBe(false);

        const canceled = requestSqlScriptActiveCancel(running);
        expect(canceled.activeStatementId).toBe("statement-1");
        expect(canceled.stopRequested).toBe(true);
        expect(canceled.cancelRequested).toBe(true);
        expect(canceled.statements[0]?.status).toBe("running");
    });

    test("summarizes every terminal class without hiding missing counters", () => {
        let batch = createSqlScriptBatch({
            sqlText: "SELECT 1; SELECT 2; SELECT 3; SELECT 4; SELECT 5; SELECT 6;",
            context: { database: "app", schema: null },
            pageSize: 100,
        });
        for (const [index, state] of [
            "succeeded",
            "failed",
            "timedOut",
            "canceled",
            "cancelFailed",
        ].entries()) {
            batch = applySqlScriptStatementSnapshot(
                batch,
                `statement-${index + 1}`,
                snapshot(
                    state as SqlExecutionSnapshot["state"],
                    2,
                    `execution-${index + 1}`,
                ),
            );
        }
        batch = markSqlScriptRemainingSkipped(batch, 4);

        expect(buildSqlScriptExecutionSummary(batch)).toEqual({
            total: 6,
            succeeded: 1,
            failed: 1,
            timedOut: 1,
            canceled: 1,
            cancelFailed: 1,
            skipped: 1,
            running: 0,
            pending: 0,
        });
        const finished = markSqlScriptBatchFinished(batch);
        expect(finished.summaryLabel).toContain("失败 1 条");
        expect(finished.summaryLabel).toContain("超时 1 条");
        expect(finished.summaryLabel).toContain("取消 1 条");
        expect(finished.summaryLabel).toContain("取消未确认 1 条");
        expect(finished.summaryLabel).toContain("跳过 1 条");
        expect(buildSqlScriptResultHeader(finished)).toContain("脚本已停止");
    });
});
