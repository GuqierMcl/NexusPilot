import type {
    SqlScriptExecutionBatch,
    SqlScriptStatementResult,
    SqlScriptStatementStatus,
} from "@/store";
import type { IAppError, SqlExecutionSnapshot } from "@/types/ipc";
import type { SqlExecutionContext } from "@/types/saved-queries";

import { normalizeSqlContext } from "./sql-editor-utils";
import { parseSqlStatementRanges } from "./sql-statement-ranges";

export interface SqlScriptExecutionSummary {
    total: number;
    succeeded: number;
    failed: number;
    timedOut: number;
    canceled: number;
    cancelFailed: number;
    skipped: number;
    running: number;
    pending: number;
}

export function buildSqlScriptExecutionSummary(
    batch: SqlScriptExecutionBatch,
): SqlScriptExecutionSummary {
    const summary: SqlScriptExecutionSummary = {
        total: batch.statements.length,
        succeeded: 0,
        failed: 0,
        timedOut: 0,
        canceled: 0,
        cancelFailed: 0,
        skipped: 0,
        running: 0,
        pending: 0,
    };
    for (const statement of batch.statements) {
        switch (statement.status) {
            case "succeeded":
                summary.succeeded += 1;
                break;
            case "failed":
                summary.failed += 1;
                break;
            case "timedOut":
                summary.timedOut += 1;
                break;
            case "canceled":
                summary.canceled += 1;
                break;
            case "cancelFailed":
                summary.cancelFailed += 1;
                break;
            case "skipped":
                summary.skipped += 1;
                break;
            case "running":
                summary.running += 1;
                break;
            case "pending":
                summary.pending += 1;
                break;
        }
    }
    return summary;
}

export function createSqlScriptBatch(params: {
    sqlText: string;
    context: SqlExecutionContext;
    pageSize: number;
}): SqlScriptExecutionBatch {
    const statements = parseSqlStatementRanges(params.sqlText)
        .filter((range) => range.executable)
        .map<SqlScriptStatementResult>((range, index) => ({
            id: `statement-${index + 1}`,
            index: index + 1,
            sql: range.text,
            range: {
                startOffset: range.startOffset,
                endOffset: range.endOffset,
                startLine: range.startLineNumber,
                startColumn: range.startColumn,
                endLine: range.endLineNumber,
                endColumn: range.endColumn,
            },
            status: "pending",
            executionId: null,
            queryId: null,
            snapshot: null,
            outcome: null,
            error: null,
            startedAt: null,
            finishedAt: null,
            elapsedMs: null,
        }));

    return {
        id: `script-${Date.now()}`,
        mode: "script",
        context: normalizeSqlContext(params.context),
        pageSize: params.pageSize,
        startedAt: Date.now(),
        finishedAt: null,
        activeStatementId: null,
        selectedStatementId: statements[0]?.id ?? null,
        stopRequested: false,
        cancelRequested: false,
        summaryLabel: `准备按顺序执行 ${statements.length} 条 SQL`,
        statements,
    };
}

function statusFromSnapshot(
    state: SqlExecutionSnapshot["state"],
): SqlScriptStatementStatus {
    switch (state) {
        case "queued":
            return "pending";
        case "starting":
        case "running":
        case "canceling":
            return "running";
        case "succeeded":
        case "failed":
        case "timedOut":
        case "canceled":
        case "cancelFailed":
            return state;
    }
}

function failureToAppError(snapshot: SqlExecutionSnapshot): IAppError | null {
    return snapshot.failure
        ? {
              code: snapshot.failure.code,
              runtimeImpact: snapshot.failure.runtimeImpact,
              message: snapshot.failure.message,
              details: snapshot.failure.details ?? undefined,
          }
        : null;
}

export function applySqlScriptStatementSnapshot(
    batch: SqlScriptExecutionBatch,
    statementId: string,
    snapshot: SqlExecutionSnapshot,
): SqlScriptExecutionBatch {
    const status = statusFromSnapshot(snapshot.state);
    const terminal =
        status !== "running" &&
        status !== "pending" &&
        status !== "skipped";
    return {
        ...batch,
        activeStatementId: terminal ? null : statementId,
        selectedStatementId: statementId,
        statements: batch.statements.map((statement) =>
            statement.id === statementId
                ? {
                      ...statement,
                      status,
                      executionId: snapshot.executionId,
                      queryId: snapshot.queryId,
                      snapshot,
                      outcome: snapshot.outcome,
                      error: failureToAppError(snapshot),
                      startedAt: snapshot.startedAt,
                      finishedAt: snapshot.finishedAt,
                      elapsedMs:
                          snapshot.finishedAt == null
                              ? null
                              : Math.max(
                                    0,
                                    snapshot.finishedAt - snapshot.startedAt,
                                ),
                  }
                : statement,
        ),
    };
}

export function markSqlScriptStatementStartFailed(
    batch: SqlScriptExecutionBatch,
    statementId: string,
    error: IAppError,
): SqlScriptExecutionBatch {
    const finishedAt = Date.now();
    return {
        ...batch,
        activeStatementId: null,
        selectedStatementId: statementId,
        statements: batch.statements.map((statement) =>
            statement.id === statementId
                ? {
                      ...statement,
                      status: "failed",
                      executionId: null,
                      queryId: null,
                      snapshot: null,
                      outcome: null,
                      error,
                      finishedAt,
                      elapsedMs: null,
                  }
                : statement,
        ),
    };
}

export function markSqlScriptRemainingSkipped(
    batch: SqlScriptExecutionBatch,
    completedStatementIndex: number,
): SqlScriptExecutionBatch {
    const finishedAt = Date.now();
    return {
        ...batch,
        activeStatementId: null,
        statements: batch.statements.map((statement, index) =>
            index > completedStatementIndex &&
            (statement.status === "pending" || statement.status === "running")
                ? {
                      ...statement,
                      status: "skipped",
                      finishedAt,
                      elapsedMs: null,
                  }
                : statement,
        ),
    };
}

export function requestSqlScriptQueueStop(
    batch: SqlScriptExecutionBatch,
): SqlScriptExecutionBatch {
    return {
        ...batch,
        stopRequested: true,
        summaryLabel: "已请求停止，当前 SQL 完成后不会继续执行队列",
    };
}

export function requestSqlScriptActiveCancel(
    batch: SqlScriptExecutionBatch,
): SqlScriptExecutionBatch {
    return {
        ...batch,
        stopRequested: true,
        cancelRequested: true,
        summaryLabel: "已请求取消当前 SQL，后续队列不会继续执行",
    };
}

function nonSuccessSummaryParts(summary: SqlScriptExecutionSummary): string[] {
    const parts: string[] = [];
    if (summary.failed > 0) parts.push(`失败 ${summary.failed} 条`);
    if (summary.timedOut > 0) parts.push(`超时 ${summary.timedOut} 条`);
    if (summary.canceled > 0) parts.push(`取消 ${summary.canceled} 条`);
    if (summary.cancelFailed > 0) {
        parts.push(`取消未确认 ${summary.cancelFailed} 条`);
    }
    if (summary.skipped > 0) parts.push(`跳过 ${summary.skipped} 条`);
    return parts;
}

export function markSqlScriptBatchFinished(
    batch: SqlScriptExecutionBatch,
): SqlScriptExecutionBatch {
    const summary = buildSqlScriptExecutionSummary(batch);
    const suffix = nonSuccessSummaryParts(summary);
    return {
        ...batch,
        activeStatementId: null,
        finishedAt: Date.now(),
        summaryLabel: `脚本执行完成：成功 ${summary.succeeded}/${summary.total} 条${
            suffix.length > 0 ? `，${suffix.join("，")}` : ""
        }`,
    };
}

export function buildSqlScriptResultHeader(
    batch: SqlScriptExecutionBatch,
): string {
    const summary = buildSqlScriptExecutionSummary(batch);
    if (batch.finishedAt == null) {
        if (summary.running > 0) {
            return `脚本执行中 · 成功 ${summary.succeeded}/${summary.total} 条`;
        }
        return `脚本准备执行 · ${summary.total} 条 SQL`;
    }
    const nonSuccess = nonSuccessSummaryParts(summary);
    if (nonSuccess.length > 0) {
        return `脚本已停止 · 成功 ${summary.succeeded}/${summary.total} 条，${nonSuccess.join("，")}`;
    }
    return `脚本执行完成 · 成功 ${summary.succeeded}/${summary.total} 条`;
}
