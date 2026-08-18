import { describe, expect, test } from "bun:test";

import {
    buildSqlExecutionOutcomePresentation,
    type SqlExecutionOutcomePresentation,
} from "../../../../src/features/workbench/content/components/sql-editor/sql-execution-outcome";
import type {
    QueryResult,
    SqlExecutionOutcome,
} from "../../../../src/types/ipc";

const emptyLegacyResult: QueryResult = {
    columns: [],
    rows: [],
    hasNextPage: false,
    sourceWritable: false,
    sourceInsertable: false,
    primaryKeyColumns: [],
    stableOrderColumns: [],
};

describe("SQL execution outcome presentation", () => {
    test("command without summary completes without inventing zero rows", () => {
        const outcome: SqlExecutionOutcome = {
            kind: "command",
            statementClass: "ddl",
            completionMessage: "DDL 执行完成",
            summary: null,
            mutationSubmitted: false,
        };

        expect(buildSqlExecutionOutcomePresentation(outcome, null)).toEqual({
            kind: "command",
            headline: "DDL 执行完成",
            metricLabel: null,
            warning: null,
        } satisfies SqlExecutionOutcomePresentation);
    });

    test("command shows exact JSON-safe written rows only when supplied", () => {
        const outcome: SqlExecutionOutcome = {
            kind: "command",
            statementClass: "insert",
            completionMessage: "INSERT 执行完成",
            summary: {
                writtenRows: "9007199254740993",
                source: "merged",
                completeness: "final",
            },
            mutationSubmitted: false,
        };

        expect(
            buildSqlExecutionOutcomePresentation(outcome, null),
        ).toMatchObject({
            metricLabel: "写入 9,007,199,254,740,993 行",
        });
    });

    test("mutation carries an asynchronous boundary warning", () => {
        const outcome: SqlExecutionOutcome = {
            kind: "command",
            statementClass: "mutation",
            completionMessage: "Mutation 请求已提交",
            summary: null,
            mutationSubmitted: true,
        };

        expect(
            buildSqlExecutionOutcomePresentation(outcome, null),
        ).toMatchObject({
            warning:
                "请求已提交；服务端 mutation 可能继续异步执行，请勿把提交成功理解为数据变更已完成。",
        });
    });

    test("legacy empty result names affected rows only when the field exists", () => {
        expect(
            buildSqlExecutionOutcomePresentation(null, emptyLegacyResult),
        ).toMatchObject({ emptyLabel: "执行完成" });
        expect(
            buildSqlExecutionOutcomePresentation(null, {
                ...emptyLegacyResult,
                affectedRows: 0,
            }),
        ).toMatchObject({ emptyLabel: "影响 0 行" });
    });

    test("Raw outcome remains a neutral first-class presentation", () => {
        const outcome: Extract<SqlExecutionOutcome, { kind: "raw" }> = {
            kind: "raw",
            format: "CSVWithNames",
            mediaType: "text/csv",
            byteLength: "9007199254740993",
            preview: "id\n1\n",
            previewTruncated: false,
            artifactId: "artifact-1",
        };

        expect(buildSqlExecutionOutcomePresentation(outcome, null)).toEqual({
            kind: "raw",
            outcome,
        } satisfies SqlExecutionOutcomePresentation);
    });
});
