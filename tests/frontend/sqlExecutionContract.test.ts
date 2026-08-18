import { expect, test } from "bun:test";
import { join } from "node:path";

import { formatIpcError } from "../../src/lib/ipc-error";
import type {
    SqlExecutionFeatures,
    SqlExecutionSnapshot,
    SqlExecutionSummary,
} from "../../src/types/ipc";

test("managed SQL execution contract keeps optional exact metrics", () => {
    const features: SqlExecutionFeatures = {
        managedLifecycle: true,
        statementAccess: "readOnly",
        activeCancel: true,
        liveProgress: true,
        querySummary: true,
        rawResult: false,
        configurableTimeout: true,
    };
    const summary: SqlExecutionSummary = {
        readRows: "9007199254740992",
        source: "merged",
        completeness: "partial",
    };
    const snapshot = {
        executionId: "execution-1",
        queryId: "query-1",
        tabId: "tab-1",
        state: "running",
        revision: 2,
        statementClass: "read",
        startedAt: 1,
        finishedAt: null,
        progressAvailable: true,
        summary,
        outcome: null,
        failure: null,
        cancelMessage: null,
    } satisfies SqlExecutionSnapshot;

    expect(features.statementAccess).toBe("readOnly");
    expect(snapshot.summary?.readRows).toBe("9007199254740992");
});

test("operation timeout is distinct from a network timeout", () => {
    expect(
        formatIpcError({
            code: "OPERATION_TIMEOUT",
            runtimeImpact: "businessOnly",
            message: "查询执行超过 30 秒",
        }),
    ).toBe("操作超时：查询执行超过 30 秒");
});

test("operation outcome unknown keeps its retryable reconciliation message", () => {
    expect(
        formatIpcError({
            code: "OPERATION_OUTCOME_UNKNOWN",
            runtimeImpact: "retryable",
            message: "ClickHouse 创建结果待确认",
        }),
    ).toBe("操作结果待确认：ClickHouse 创建结果待确认");
});

test("managed snapshots carry optional bounded observation warnings", async () => {
    const snapshot = {
        executionId: "execution-1",
        queryId: "query-1",
        tabId: "runtime-tab",
        state: "running",
        revision: 3,
        statementClass: "read",
        startedAt: 1,
        finishedAt: null,
        progressAvailable: false,
        summary: null,
        outcome: null,
        failure: null,
        cancelMessage: null,
        observationWarnings: ["progress unavailable"],
    } satisfies SqlExecutionSnapshot;

    expect(snapshot.observationWarnings).toEqual([
        "progress unavailable",
    ]);

    const contractSource = await Bun.file(
        join(import.meta.dir, "../../src/types/ipc/query.ts"),
    ).text();
    expect(contractSource).toContain(
        "observationWarnings?: string[];",
    );
});
