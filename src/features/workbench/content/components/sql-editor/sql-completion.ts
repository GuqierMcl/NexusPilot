import type { AssetGroupType, DataContainer } from "@/types/ipc";

export type SqlCompletionDialect = "generic" | "mysql" | "postgresql" | "oracle";

export type SqlCompletionKind =
    | "keyword"
    | "snippet"
    | "database"
    | "schema"
    | "table"
    | "view"
    | "materialized_view"
    | "column";

export interface SqlCompletionItem {
    label: string;
    kind: SqlCompletionKind;
    insertText: string;
    detail: string;
    sortText: string;
    filterText?: string;
    insertAsSnippet?: boolean;
}

export interface SqlCompletionObject {
    kind: "table" | "view" | "materialized_view";
    name: string;
    database?: string | null;
    schema?: string | null;
}

export interface SqlCompletionColumn {
    name: string;
    typeName?: string | null;
    nullable?: boolean | null;
    objectName?: string | null;
}

export interface SqlCompletionBuildInput {
    driverName?: string | null;
    showSchema: boolean;
    databases: string[];
    schemas: string[];
    objects: SqlCompletionObject[];
    columns?: SqlCompletionColumn[];
}

export interface SqlCompletionBuildOptions {
    mode?: "global" | "columns";
}

const SQL_KEYWORDS = [
    "SELECT",
    "FROM",
    "WHERE",
    "JOIN",
    "LEFT JOIN",
    "RIGHT JOIN",
    "INNER JOIN",
    "GROUP BY",
    "ORDER BY",
    "HAVING",
    "LIMIT",
    "OFFSET",
    "INSERT",
    "INSERT INTO",
    "UPDATE",
    "DELETE",
    "DELETE FROM",
    "CREATE",
    "ALTER",
    "DROP",
    "WITH",
    "UNION",
    "UNION ALL",
    "CASE",
    "WHEN",
    "THEN",
    "ELSE",
    "END",
] as const;

const SQL_SNIPPETS: Array<Pick<SqlCompletionItem, "label" | "insertText">> = [
    {
        label: "SELECT ... FROM ...",
        insertText: "SELECT ${1:*}\nFROM ${2:table_name};",
    },
    {
        label: "INSERT INTO ...",
        insertText:
            "INSERT INTO ${1:table_name} (${2:column_name})\nVALUES (${3:value});",
    },
    {
        label: "UPDATE ... SET ...",
        insertText:
            "UPDATE ${1:table_name}\nSET ${2:column_name} = ${3:value}\nWHERE ${4:condition};",
    },
];

type SqlObjectGroupType = Extract<
    AssetGroupType,
    "tables" | "views" | "materialized_views"
>;

export function resolveSqlCompletionDialect(
    driverName?: string | null,
): SqlCompletionDialect {
    const normalized = driverName?.trim().toLowerCase();
    if (normalized === "mysql") return "mysql";
    if (normalized === "postgres" || normalized === "postgresql") {
        return "postgresql";
    }
    if (normalized === "oracle") return "oracle";
    return "generic";
}

export function quoteSqlIdentifier(
    identifier: string,
    dialect: SqlCompletionDialect,
): string {
    if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(identifier)) {
        return identifier;
    }

    if (dialect === "mysql") {
        return `\`${identifier.replaceAll("`", "``")}\``;
    }

    return `"${identifier.replaceAll('"', '""')}"`;
}

export function buildSqlCompletionItems(
    input: SqlCompletionBuildInput,
    options: SqlCompletionBuildOptions = {},
): SqlCompletionItem[] {
    const dialect = resolveSqlCompletionDialect(input.driverName);
    if (options.mode === "columns") {
        return dedupeCompletionItems(
            (input.columns ?? []).map((column, index) => ({
                label: column.name,
                kind: "column" as const,
                insertText: quoteSqlIdentifier(column.name, dialect),
                detail: formatColumnCompletionDetail(column),
                sortText: `0-${index.toString().padStart(3, "0")}-${column.name}`,
            })),
        );
    }

    const items: SqlCompletionItem[] = [
        ...SQL_KEYWORDS.map((keyword, index) => ({
            label: keyword,
            kind: "keyword" as const,
            insertText: keyword,
            detail: "SQL keyword",
            sortText: `0-${index.toString().padStart(3, "0")}-${keyword}`,
        })),
        ...SQL_SNIPPETS.map((snippet, index) => ({
            label: snippet.label,
            kind: "snippet" as const,
            insertText: snippet.insertText,
            detail: "SQL snippet",
            sortText: `1-${index.toString().padStart(3, "0")}-${snippet.label}`,
            insertAsSnippet: true,
        })),
        ...input.databases.map((database, index) => ({
            label: database,
            kind: "database" as const,
            insertText: quoteSqlIdentifier(database, dialect),
            detail: "Database",
            sortText: `2-${index.toString().padStart(3, "0")}-${database}`,
        })),
        ...(input.showSchema
            ? input.schemas.map((schema, index) => ({
                  label: schema,
                  kind: "schema" as const,
                  insertText: quoteSqlIdentifier(schema, dialect),
                  detail: "Schema",
                  sortText: `3-${index.toString().padStart(3, "0")}-${schema}`,
              }))
            : []),
        ...input.objects.map((object, index) => ({
            label: object.name,
            kind: object.kind,
            insertText: quoteSqlIdentifier(object.name, dialect),
            detail: getObjectDetail(object.kind),
            sortText: `4-${index.toString().padStart(3, "0")}-${object.name}`,
        })),
    ];

    return dedupeCompletionItems(items);
}

export function buildSqlCompletionObjectsFromContainers(
    containers?: DataContainer[] | null,
): SqlCompletionObject[] {
    return (containers ?? [])
        .filter(
            (container) =>
                container.kind === "table" ||
                container.kind === "view" ||
                container.kind === "materialized_view",
        )
        .map((container) => ({
            kind: container.kind as SqlCompletionObject["kind"],
            name: container.name,
            database: container.container.database ?? null,
            schema: container.container.schema ?? null,
        }));
}

export function findSqlAssetGroup(
    containers: DataContainer[] | undefined,
    groupType: SqlObjectGroupType,
): DataContainer | null {
    return (
        containers?.find(
            (container) =>
                container.kind === "asset_group" &&
                container.container.groupType === groupType,
        ) ?? null
    );
}

function getObjectDetail(kind: SqlCompletionObject["kind"]): string {
    switch (kind) {
        case "table":
            return "Table";
        case "view":
            return "View";
        case "materialized_view":
            return "Materialized view";
    }
}

function formatColumnCompletionDetail(column: SqlCompletionColumn): string {
    const typeName = column.typeName?.trim();
    const nullability = column.nullable === false ? " NOT NULL" : "";
    return typeName ? `${typeName}${nullability}` : "Column";
}

function dedupeCompletionItems(items: SqlCompletionItem[]): SqlCompletionItem[] {
    const seen = new Set<string>();
    return items.filter((item) => {
        const key = `${item.kind}:${item.label.toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
