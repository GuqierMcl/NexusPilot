import type { ContainerRef } from "@/types/ipc";

import type { SqlCompletionObject } from "./sql-completion";
import { findExecutableStatementAtOffset } from "./sql-statement-ranges";

export interface SqlColumnCompletionTrigger {
    qualifier: string;
    normalizedQualifier: string;
}

export interface SqlColumnCompletionTarget {
    qualifier: string;
    object: SqlCompletionObject;
}

type SqlToken = {
    text: string;
    normalized: string;
};

const RESERVED_ALIAS_WORDS = new Set([
    "ON",
    "WHERE",
    "JOIN",
    "LEFT",
    "RIGHT",
    "INNER",
    "OUTER",
    "FULL",
    "CROSS",
    "GROUP",
    "ORDER",
    "HAVING",
    "LIMIT",
    "OFFSET",
    "UNION",
]);

export function resolveSqlColumnCompletionTrigger(params: {
    sqlText: string;
    cursorOffset: number;
}): SqlColumnCompletionTrigger | null {
    const prefix = params.sqlText.slice(0, params.cursorOffset);
    const match =
        /((?:[A-Za-z_][A-Za-z0-9_$]*)|(?:"(?:""|[^"])+")|(?:`(?:``|[^`])+`))\.$/.exec(
            prefix,
        );
    if (!match?.[1]) return null;

    return {
        qualifier: match[1],
        normalizedQualifier: normalizeSqlIdentifier(match[1]),
    };
}

export function extractSqlAliasMap(statementText: string): Record<string, string> {
    const tokens = tokenizeSqlForAliases(statementText);
    const aliases: Record<string, string> = {};

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token == null) continue;

        const keyword = token.normalized.toUpperCase();
        if (keyword !== "FROM" && keyword !== "JOIN") continue;

        const objectToken = tokens[index + 1];
        if (objectToken == null) continue;

        const maybeAs = tokens[index + 2];
        const aliasToken =
            maybeAs?.normalized.toUpperCase() === "AS"
                ? tokens[index + 3]
                : maybeAs;
        if (aliasToken == null) continue;
        if (RESERVED_ALIAS_WORDS.has(aliasToken.normalized.toUpperCase())) {
            continue;
        }

        aliases[aliasToken.normalized] = objectToken.normalized;
    }

    return aliases;
}

export function resolveSqlColumnCompletionTarget(params: {
    sqlText: string;
    cursorOffset: number;
    objects: SqlCompletionObject[];
}): SqlColumnCompletionTarget | null {
    const trigger = resolveSqlColumnCompletionTrigger(params);
    if (!trigger) return null;

    const currentStatement =
        findExecutableStatementAtOffset(params.sqlText, params.cursorOffset) ??
        null;
    const aliasMap = currentStatement
        ? extractSqlAliasMap(currentStatement.text)
        : {};
    const objectName =
        aliasMap[trigger.normalizedQualifier] ?? trigger.normalizedQualifier;
    const object = params.objects.find(
        (item) => item.name.toLowerCase() === objectName.toLowerCase(),
    );
    if (!object) return null;

    return {
        qualifier: trigger.normalizedQualifier,
        object,
    };
}

export function toSqlColumnContainerRef(
    object: SqlCompletionObject,
): ContainerRef | null {
    if (object.kind !== "table") return null;

    return {
        kind: "table",
        database: object.database ?? null,
        schema: object.schema ?? null,
        objectName: object.name,
        table: object.name,
    };
}

function normalizeSqlIdentifier(identifier: string): string {
    if (identifier.startsWith('"') && identifier.endsWith('"')) {
        return identifier.slice(1, -1).replaceAll('""', '"');
    }
    if (identifier.startsWith("`") && identifier.endsWith("`")) {
        return identifier.slice(1, -1).replaceAll("``", "`");
    }
    return identifier;
}

function tokenizeSqlForAliases(sqlText: string): SqlToken[] {
    const tokens: SqlToken[] = [];
    const tokenPattern =
        /"(?:""|[^"])+?"|`(?:``|[^`])+?`|[A-Za-z_][A-Za-z0-9_$]*/g;
    for (const match of sqlText.matchAll(tokenPattern)) {
        const text = match[0];
        tokens.push({
            text,
            normalized: normalizeSqlIdentifier(text),
        });
    }
    return tokens;
}
