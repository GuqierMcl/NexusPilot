import { expect, test } from "bun:test";
import { join } from "node:path";

import { buildSqlExecutionDetailModel } from "../../../../src/features/workbench/content/components/sql-editor/ExecutionDetailDrawer";
import type { SqlExecutionDetailContext } from "../../../../src/features/workbench/content/components/sql-editor/execution-detail-contributor-registry";

test("detail drawer keeps actions out of the neutral observability shell", async () => {
    const source = await Bun.file(
        join(
            import.meta.dir,
            "../../../../src/features/workbench/content/components/sql-editor/ExecutionDetailDrawer.tsx",
        ),
    ).text();

    expect(source).toContain("DrawerTitle");
    expect(source).toContain("DrawerDescription");
    for (const forbidden of [
        "cancelSqlExecution",
        "startSqlExecution",
        "execute_sql",
        "Retry",
        "Save",
        "<Button",
    ]) {
        expect(source).not.toContain(forbidden);
    }
});

test("builds neutral detail rows without SQL text or temp paths", () => {
    const context = detailContext("fake-db");
    const model = buildSqlExecutionDetailModel({
        context,
        timeline: [
            {
                executionId: "execution-1",
                revision: 1,
                state: "starting",
                observedAt: 1,
            },
            {
                executionId: "execution-1",
                revision: 2,
                state: "running",
                observedAt: 2,
            },
        ],
        options: { timeoutMs: 30_000, resultMode: "grid" },
    });

    expect(model.identity).toEqual([
        ["Execution ID", "execution-1"],
        ["Query ID", "query-1"],
        ["语句类型", "READ"],
    ]);
    expect(model.summary.map((row) => row.label)).toContain("读取行数");
    expect(JSON.stringify(model)).not.toContain("SELECT");
    expect(JSON.stringify(model)).not.toContain("tempPath");
});

test("detail model exposes failure context but excludes developer details", () => {
    const context = detailContext("fake-db");
    context.snapshot = {
        ...context.snapshot,
        state: "failed",
        finishedAt: 3,
        failure: {
            code: "QUERY_SYNTAX_ERROR",
            runtimeImpact: "businessOnly",
            message: "syntax error",
            details: "developer-only stack",
        },
    };

    const model = buildSqlExecutionDetailModel({
        context,
        timeline: [],
        options: { timeoutMs: null, resultMode: "grid" },
    });

    expect(model.failure).toEqual([
        ["错误码", "QUERY_SYNTAX_ERROR"],
        ["运行时影响", "businessOnly"],
        ["错误信息", "syntax error"],
    ]);
    expect(JSON.stringify(model)).not.toContain("developer-only stack");
});

test("detail model exposes Raw artifact metadata without preview or paths", () => {
    const context = detailContext("fake-db");
    context.snapshot = {
        ...context.snapshot,
        state: "succeeded",
        finishedAt: 3,
        outcome: {
            kind: "raw",
            format: "CSVWithNames",
            mediaType: "text/csv",
            byteLength: "9007199254740993",
            preview: "sensitive preview",
            previewTruncated: true,
            artifactId: "artifact-1",
        },
    };

    const model = buildSqlExecutionDetailModel({
        context,
        timeline: [],
        options: { timeoutMs: 30_000, resultMode: "raw" },
    });

    expect(model.rawArtifact).toEqual([
        ["格式", "CSVWithNames"],
        ["媒体类型", "text/csv"],
        ["字节数", "9007199254740993"],
        ["预览状态", "已截断"],
        ["Artifact ID", "artifact-1"],
        ["可用操作", "可另存"],
    ]);
    expect(JSON.stringify(model)).not.toContain("sensitive preview");
    expect(JSON.stringify(model)).not.toContain("tempPath");
    expect(JSON.stringify(model)).not.toContain("destinationPath");
});

function detailContext(driverName: string): SqlExecutionDetailContext {
    return {
        uiTabId: "sql-tab",
        profileId: "profile-1",
        driverName,
        features: {
            managedLifecycle: true,
            statementAccess: "readOnly",
            activeCancel: false,
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
            summary: {
                readRows: "9007199254740992",
                source: "livePoll",
                completeness: "partial",
            },
            outcome: null,
            failure: null,
            cancelMessage: null,
        },
    };
}
