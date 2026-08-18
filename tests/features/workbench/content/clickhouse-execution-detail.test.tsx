import { expect, test } from "bun:test";

import {
    buildClickHouseExecutionDetailModel,
    clickhouseExecutionDetailContributor,
} from "../../../../src/features/workbench/content/components/sql-editor/clickhouse-execution-detail-contributor";
import type { SqlExecutionDetailContext } from "../../../../src/features/workbench/content/components/sql-editor/execution-detail-contributor-registry";
import type { SqlExecutionSnapshot } from "../../../../src/types/ipc";

test("builds ClickHouse observation details without SQL or developer payload", () => {
    const model = buildClickHouseExecutionDetailModel(
        clickhouseContext({
            progressAvailable: false,
            summary: {
                memoryUsage: "9007199254740992",
                source: "merged",
                completeness: "partial",
            },
            observationWarnings: [
                "system.processes 权限不足，实时进度不可用",
            ],
        }),
    );

    expect(model).toEqual({
        progressLabel: "不可用",
        summarySource: "merged",
        summaryCompleteness: "partial",
        memoryUsage: "9,007,199,254,740,992 B",
        warnings: ["system.processes 权限不足，实时进度不可用"],
    });
    expect(JSON.stringify(model)).not.toContain("SELECT");
    expect(JSON.stringify(model)).not.toContain("tempPath");
    expect(JSON.stringify(model)).not.toContain("developer-only");
});

test("ClickHouse contributor supports only ClickHouse inside the registry boundary", () => {
    expect(
        clickhouseExecutionDetailContributor.supports(clickhouseContext({})),
    ).toBe(true);
    expect(
        clickhouseExecutionDetailContributor.supports(
            clickhouseContext({}, "postgres"),
        ),
    ).toBe(false);
});

function clickhouseContext(
    snapshotOverrides: Partial<SqlExecutionSnapshot>,
    driverName = "clickhouse",
): SqlExecutionDetailContext {
    return {
        uiTabId: "sql-tab",
        profileId: "profile-1",
        driverName,
        features: {
            managedLifecycle: true,
            statementAccess: "readOnly",
            activeCancel: true,
            liveProgress: true,
            querySummary: true,
            rawResult: false,
            configurableTimeout: true,
        },
        snapshot: {
            executionId: "execution-1",
            queryId: "query-1",
            tabId: "runtime-tab",
            state: "running",
            revision: 2,
            statementClass: "read",
            startedAt: 1,
            finishedAt: null,
            progressAvailable: true,
            summary: null,
            outcome: null,
            failure: null,
            cancelMessage: null,
            ...snapshotOverrides,
        },
    };
}
