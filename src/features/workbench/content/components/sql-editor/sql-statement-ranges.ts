export interface SqlStatementRange {
    text: string;
    startOffset: number;
    endOffset: number;
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
    executable: boolean;
}

function readDollarQuoteTag(sql: string, startIndex: number): string | null {
    if (sql[startIndex] !== "$") return null;

    const firstTagChar = sql[startIndex + 1];
    if (firstTagChar === "$") return "$$";
    if (firstTagChar == null || !/[A-Za-z_]/.test(firstTagChar)) return null;

    let endIndex = startIndex + 2;
    while (endIndex < sql.length && /[A-Za-z0-9_]/.test(sql[endIndex])) {
        endIndex += 1;
    }

    if (sql[endIndex] !== "$") return null;
    return sql.slice(startIndex, endIndex + 1);
}

function offsetToLineColumn(
    sql: string,
    offset: number,
): { lineNumber: number; column: number } {
    let lineNumber = 1;
    let column = 1;
    const safeOffset = Math.min(Math.max(0, offset), sql.length);

    for (let index = 0; index < safeOffset; index += 1) {
        if (sql[index] === "\n") {
            lineNumber += 1;
            column = 1;
        } else {
            column += 1;
        }
    }

    return { lineNumber, column };
}

function trimStatementBounds(
    sql: string,
    startOffset: number,
    endOffset: number,
): { startOffset: number; endOffset: number } {
    let trimmedStart = startOffset;
    let trimmedEnd = endOffset;

    while (trimmedStart < trimmedEnd && /\s/.test(sql[trimmedStart])) {
        trimmedStart += 1;
    }
    while (trimmedEnd > trimmedStart && /\s/.test(sql[trimmedEnd - 1])) {
        trimmedEnd -= 1;
    }

    return {
        startOffset: trimmedStart,
        endOffset: trimmedEnd,
    };
}

function containsExecutableToken(sql: string): boolean {
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inBacktick = false;

    for (let index = 0; index < sql.length; index += 1) {
        const ch = sql[index];
        const next = sql[index + 1];

        if (inSingleQuote) {
            if (ch === "\\" && next != null) {
                index += 1;
                continue;
            }
            if (ch === "'" && next === "'") {
                index += 1;
                continue;
            }
            if (ch === "'") inSingleQuote = false;
            continue;
        }
        if (inDoubleQuote) {
            if (ch === "\"" && next === "\"") {
                index += 1;
                continue;
            }
            if (ch === "\"") inDoubleQuote = false;
            continue;
        }
        if (inBacktick) {
            if (ch === "`" && next === "`") {
                index += 1;
                continue;
            }
            if (ch === "`") inBacktick = false;
            continue;
        }

        if (ch === "-" && next === "-") {
            while (index < sql.length && sql[index] !== "\n") index += 1;
            continue;
        }
        if (ch === "/" && next === "*") {
            index += 2;
            while (
                index < sql.length &&
                !(sql[index] === "*" && sql[index + 1] === "/")
            ) {
                index += 1;
            }
            index += 1;
            continue;
        }
        if (ch === "#") {
            while (index < sql.length && sql[index] !== "\n") index += 1;
            continue;
        }

        const nextDollarQuoteTag =
            ch === "$" ? readDollarQuoteTag(sql, index) : null;
        if (nextDollarQuoteTag) {
            return true;
        }
        if (ch === "'") {
            inSingleQuote = true;
            return true;
        }
        if (ch === "\"") {
            inDoubleQuote = true;
            return true;
        }
        if (ch === "`") {
            inBacktick = true;
            return true;
        }
        if (!/\s/.test(ch)) {
            return true;
        }
    }

    return false;
}

export function parseSqlStatementRanges(sql: string): SqlStatementRange[] {
    const ranges: SqlStatementRange[] = [];
    let statementStartOffset = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inBacktick = false;
    let dollarQuoteTag: string | null = null;

    function pushRange(rawEndOffset: number) {
        const trimmed = trimStatementBounds(
            sql,
            statementStartOffset,
            rawEndOffset,
        );
        if (trimmed.endOffset <= trimmed.startOffset) {
            return;
        }

        const text = sql.slice(trimmed.startOffset, trimmed.endOffset);
        const executable = containsExecutableToken(text);
        if (!executable) {
            return;
        }

        const startLocation = offsetToLineColumn(sql, trimmed.startOffset);
        const endLocation = offsetToLineColumn(sql, trimmed.endOffset);
        ranges.push({
            text,
            startOffset: trimmed.startOffset,
            endOffset: trimmed.endOffset,
            startLineNumber: startLocation.lineNumber,
            startColumn: startLocation.column,
            endLineNumber: endLocation.lineNumber,
            endColumn: endLocation.column,
            executable,
        });
    }

    for (let index = 0; index < sql.length; index += 1) {
        const ch = sql[index];
        const next = sql[index + 1];

        if (dollarQuoteTag) {
            if (sql.startsWith(dollarQuoteTag, index)) {
                index += dollarQuoteTag.length - 1;
                dollarQuoteTag = null;
            }
            continue;
        }
        if (inSingleQuote) {
            if (ch === "\\" && next != null) {
                index += 1;
                continue;
            }
            if (ch === "'" && next === "'") {
                index += 1;
                continue;
            }
            if (ch === "'") inSingleQuote = false;
            continue;
        }
        if (inDoubleQuote) {
            if (ch === "\"" && next === "\"") {
                index += 1;
                continue;
            }
            if (ch === "\"") inDoubleQuote = false;
            continue;
        }
        if (inBacktick) {
            if (ch === "`" && next === "`") {
                index += 1;
                continue;
            }
            if (ch === "`") inBacktick = false;
            continue;
        }

        if (ch === "-" && next === "-") {
            while (index < sql.length && sql[index] !== "\n") index += 1;
            continue;
        }
        if (ch === "/" && next === "*") {
            index += 2;
            while (
                index < sql.length &&
                !(sql[index] === "*" && sql[index + 1] === "/")
            ) {
                index += 1;
            }
            index += 1;
            continue;
        }
        if (ch === "#") {
            while (index < sql.length && sql[index] !== "\n") index += 1;
            continue;
        }

        const nextDollarQuoteTag =
            ch === "$" ? readDollarQuoteTag(sql, index) : null;
        if (nextDollarQuoteTag) {
            dollarQuoteTag = nextDollarQuoteTag;
            index += nextDollarQuoteTag.length - 1;
            continue;
        }
        if (ch === "'") {
            inSingleQuote = true;
            continue;
        }
        if (ch === "\"") {
            inDoubleQuote = true;
            continue;
        }
        if (ch === "`") {
            inBacktick = true;
            continue;
        }
        if (ch === ";") {
            pushRange(index);
            statementStartOffset = index + 1;
        }
    }

    pushRange(sql.length);
    return ranges;
}

export function countExecutableSqlStatements(sql: string): number {
    return parseSqlStatementRanges(sql).filter((range) => range.executable)
        .length;
}

export function hasMultipleExecutableSqlStatements(sql: string): boolean {
    return countExecutableSqlStatements(sql) > 1;
}

export function findExecutableStatementAtOffset(
    sql: string,
    offset: number,
): SqlStatementRange | null {
    const safeOffset = Math.min(Math.max(0, offset), sql.length);
    return (
        parseSqlStatementRanges(sql).find(
            (range) =>
                range.executable &&
                range.startOffset <= safeOffset &&
                safeOffset <= range.endOffset,
        ) ?? null
    );
}
