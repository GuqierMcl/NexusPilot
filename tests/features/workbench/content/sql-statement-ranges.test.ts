import { describe, expect, test } from "bun:test";

import {
    countExecutableSqlStatements,
    findExecutableStatementAtOffset,
    parseSqlStatementRanges,
} from "../../../../src/features/workbench/content/components/sql-editor/sql-statement-ranges";

function offsetOf(sql: string, marker: string): number {
    const index = sql.indexOf(marker);
    if (index < 0) {
        throw new Error(`Marker ${marker} not found`);
    }
    return index;
}

describe("SQL statement ranges", () => {
    test("splits semicolon-separated executable statements", () => {
        const ranges = parseSqlStatementRanges("select 1;\nselect 2;");

        expect(ranges.map((range) => range.text)).toEqual([
            "select 1",
            "select 2",
        ]);
        expect(ranges.map((range) => range.executable)).toEqual([true, true]);
        expect(countExecutableSqlStatements("select 1;\nselect 2;")).toBe(2);
    });

    test("ignores semicolons in strings and identifiers", () => {
        const sql = [
            "select ';' as value;",
            'select "semi;colon" from users;',
            "select `semi;colon` from users;",
        ].join("\n");

        expect(parseSqlStatementRanges(sql).map((range) => range.text)).toEqual([
            "select ';' as value",
            'select "semi;colon" from users',
            "select `semi;colon` from users",
        ]);
    });

    test("ignores semicolons in line comments and block comments", () => {
        const sql = [
            "-- ignored;",
            "select 1;",
            "/* ignored; */",
            "select 2;",
            "# mysql comment;",
        ].join("\n");

        expect(parseSqlStatementRanges(sql).map((range) => range.text)).toEqual([
            "-- ignored;\nselect 1",
            "/* ignored; */\nselect 2",
        ]);
        expect(countExecutableSqlStatements(sql)).toBe(2);
    });

    test("keeps PostgreSQL dollar-quoted bodies inside one statement", () => {
        const sql = [
            "create function f() returns void as $$",
            "begin",
            "raise notice 'x;y';",
            "end",
            "$$ language plpgsql;",
            "select 1;",
        ].join("\n");

        expect(parseSqlStatementRanges(sql).map((range) => range.text)).toEqual([
            [
                "create function f() returns void as $$",
                "begin",
                "raise notice 'x;y';",
                "end",
                "$$ language plpgsql",
            ].join("\n"),
            "select 1",
        ]);
    });

    test("finds the executable statement containing the cursor", () => {
        const sql = "select 1;\nselect 2;\nselect 3";

        expect(
            findExecutableStatementAtOffset(sql, offsetOf(sql, "select 2"))?.text,
        ).toBe("select 2");
        expect(
            findExecutableStatementAtOffset(sql, offsetOf(sql, "select 3"))?.text,
        ).toBe("select 3");
    });

    test("returns null when cursor is between executable statements", () => {
        const sql = "select 1;\n\nselect 2";
        const gapOffset = sql.indexOf("\n\n") + 1;

        expect(findExecutableStatementAtOffset(sql, gapOffset)).toBeNull();
    });

    test("returns line and column locations for Monaco consumers", () => {
        const [first, second] = parseSqlStatementRanges("select 1;\n  select 2");

        expect(first.startLineNumber).toBe(1);
        expect(first.startColumn).toBe(1);
        expect(first.endLineNumber).toBe(1);
        expect(first.endColumn).toBe(9);
        expect(second.startLineNumber).toBe(2);
        expect(second.startColumn).toBe(3);
    });
});
