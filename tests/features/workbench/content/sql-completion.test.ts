import { describe, expect, test } from "bun:test";

import {
    buildSqlCompletionItems,
    buildSqlCompletionObjectsFromContainers,
    findSqlAssetGroup,
    quoteSqlIdentifier,
} from "../../../../src/features/workbench/content/components/sql-editor/sql-completion";
import {
    extractSqlAliasMap,
    resolveSqlColumnCompletionTarget,
    resolveSqlColumnCompletionTrigger,
    toSqlColumnContainerRef,
} from "../../../../src/features/workbench/content/components/sql-editor/sql-column-completion";
import {
    buildSqlColumnsFromTableSchema,
    resolveSqlCompletionObjectParent,
} from "../../../../src/features/workbench/content/components/sql-editor/useSqlCompletionMetadata";
import type { DataContainer } from "../../../../src/types/ipc";

function container(
    name: string,
    kind: DataContainer["kind"],
    database = "app",
    schema: string | null = null,
): DataContainer {
    return {
        id: `${database}:${schema ?? "none"}:${kind}:${name}`,
        name,
        kind,
        isLeaf: true,
        container: {
            kind,
            database,
            schema,
            objectName: name,
            table: kind === "table" ? name : null,
        },
    };
}

describe("SQL completion item builder", () => {
    test("builds Level C MySQL completions without schema names", () => {
        const items = buildSqlCompletionItems({
            driverName: "mysql",
            showSchema: false,
            databases: ["app"],
            schemas: ["public"],
            objects: [
                { kind: "table", name: "users", database: "app", schema: null },
                {
                    kind: "view",
                    name: "active_users",
                    database: "app",
                    schema: null,
                },
            ],
        });

        expect(items.some((item) => item.label === "SELECT")).toBe(true);
        expect(items.some((item) => item.label === "SELECT ... FROM ...")).toBe(
            true,
        );
        expect(items).toContainEqual(
            expect.objectContaining({ label: "app", kind: "database" }),
        );
        expect(items).toContainEqual(
            expect.objectContaining({ label: "users", kind: "table" }),
        );
        expect(items).toContainEqual(
            expect.objectContaining({ label: "active_users", kind: "view" }),
        );
        expect(items).not.toContainEqual(
            expect.objectContaining({ label: "public", kind: "schema" }),
        );
        expect(items).not.toContainEqual(
            expect.objectContaining({ label: "id", kind: "column" }),
        );
    });

    test("builds Level C PostgreSQL completions with schemas and materialized views", () => {
        const items = buildSqlCompletionItems({
            driverName: "postgresql",
            showSchema: true,
            databases: ["warehouse"],
            schemas: ["public"],
            objects: [
                {
                    kind: "materialized_view",
                    name: "daily_rollup",
                    database: "warehouse",
                    schema: "public",
                },
            ],
        });

        expect(items).toContainEqual(
            expect.objectContaining({ label: "warehouse", kind: "database" }),
        );
        expect(items).toContainEqual(
            expect.objectContaining({ label: "public", kind: "schema" }),
        );
        expect(items).toContainEqual(
            expect.objectContaining({
                label: "daily_rollup",
                kind: "materialized_view",
            }),
        );
    });

    test("builds column-only completions for active column targets", () => {
        const items = buildSqlCompletionItems(
            {
                driverName: "postgresql",
                showSchema: true,
                databases: ["warehouse"],
                schemas: ["public"],
                objects: [
                    {
                        kind: "table",
                        name: "users",
                        database: "warehouse",
                        schema: "public",
                    },
                ],
                columns: [
                    {
                        name: "id",
                        typeName: "integer",
                        nullable: false,
                        objectName: "users",
                    },
                    {
                        name: "display name",
                        typeName: "text",
                        nullable: true,
                        objectName: "users",
                    },
                ],
            },
            { mode: "columns" },
        );

        expect(items).toEqual([
            expect.objectContaining({
                label: "id",
                kind: "column",
                insertText: "id",
                detail: "integer NOT NULL",
            }),
            expect.objectContaining({
                label: "display name",
                kind: "column",
                insertText: '"display name"',
                detail: "text",
            }),
        ]);
        expect(items.some((item) => item.label === "SELECT")).toBe(false);
    });

    test("quotes identifiers only when needed and uses the driver quote style", () => {
        expect(quoteSqlIdentifier("users", "mysql")).toBe("users");
        expect(quoteSqlIdentifier("order detail", "mysql")).toBe(
            "`order detail`",
        );
        expect(quoteSqlIdentifier("order detail", "postgresql")).toBe(
            '"order detail"',
        );
        expect(quoteSqlIdentifier('needs"escape', "postgresql")).toBe(
            '"needs""escape"',
        );
    });

    test("extracts SQL object completions and ignores columns", () => {
        const containers: DataContainer[] = [
            container("users", "table"),
            container("active_users", "view"),
            container("daily_rollup", "materialized_view", "warehouse", "public"),
            container("id", "column"),
        ];

        expect(buildSqlCompletionObjectsFromContainers(containers)).toEqual([
            { kind: "table", name: "users", database: "app", schema: null },
            { kind: "view", name: "active_users", database: "app", schema: null },
            {
                kind: "materialized_view",
                name: "daily_rollup",
                database: "warehouse",
                schema: "public",
            },
        ]);
    });

    test("finds requested SQL asset groups", () => {
        const groups: DataContainer[] = [
            {
                id: "app::tables",
                name: "表",
                kind: "asset_group",
                isLeaf: false,
                container: {
                    kind: "asset_group",
                    groupType: "tables",
                    database: "app",
                    schema: null,
                },
            },
        ];

        expect(findSqlAssetGroup(groups, "tables")?.id).toBe("app::tables");
        expect(findSqlAssetGroup(groups, "views")).toBeNull();
    });

    test("resolves the object metadata parent from the active driver context", () => {
        const databaseContainers = [
            container("app", "database", "app"),
            container("warehouse", "database", "warehouse"),
        ];
        const schemaContainers = [
            container("public", "schema", "warehouse", "public"),
        ];

        expect(
            resolveSqlCompletionObjectParent({
                context: { database: "app", schema: null },
                showSchema: false,
                databaseContainers,
                schemaContainers,
            }),
        ).toEqual(databaseContainers[0].container);
        expect(
            resolveSqlCompletionObjectParent({
                context: { database: "warehouse", schema: "public" },
                showSchema: true,
                databaseContainers,
                schemaContainers,
            }),
        ).toEqual(schemaContainers[0].container);
        expect(
            resolveSqlCompletionObjectParent({
                context: { database: "warehouse", schema: "missing" },
                showSchema: true,
                databaseContainers,
                schemaContainers,
            }),
        ).toBeNull();
    });
});

describe("SQL column completion parsing", () => {
    const objects = [
        { kind: "table" as const, name: "users", database: "app", schema: null },
        { kind: "table" as const, name: "orders", database: "app", schema: null },
        {
            kind: "table" as const,
            name: "order detail",
            database: "app",
            schema: null,
        },
        {
            kind: "view" as const,
            name: "active_users",
            database: "app",
            schema: null,
        },
    ];

    test("detects unquoted and quoted column completion qualifiers", () => {
        expect(
            resolveSqlColumnCompletionTrigger({
                sqlText: "select users.",
                cursorOffset: "select users.".length,
            }),
        ).toEqual({ qualifier: "users", normalizedQualifier: "users" });

        expect(
            resolveSqlColumnCompletionTrigger({
                sqlText: 'select "order detail".',
                cursorOffset: 'select "order detail".'.length,
            }),
        ).toEqual({
            qualifier: '"order detail"',
            normalizedQualifier: "order detail",
        });

        expect(
            resolveSqlColumnCompletionTrigger({
                sqlText: "select `order detail`.",
                cursorOffset: "select `order detail`.".length,
            }),
        ).toEqual({
            qualifier: "`order detail`",
            normalizedQualifier: "order detail",
        });

        expect(
            resolveSqlColumnCompletionTrigger({
                sqlText: "select ",
                cursorOffset: "select ".length,
            }),
        ).toBeNull();
    });

    test("extracts simple FROM and JOIN aliases from a statement", () => {
        expect(
            extractSqlAliasMap(
                'select * from users u join "order detail" as od on od.user_id = u.id',
            ),
        ).toEqual({
            u: "users",
            od: "order detail",
        });
    });

    test("resolves direct object and alias qualifiers to known table objects", () => {
        expect(
            resolveSqlColumnCompletionTarget({
                sqlText: "select users.",
                cursorOffset: "select users.".length,
                objects,
            }),
        ).toEqual({
            qualifier: "users",
            object: objects[0],
        });

        expect(
            resolveSqlColumnCompletionTarget({
                sqlText: "select u. from users u",
                cursorOffset: "select u.".length,
                objects,
            }),
        ).toEqual({
            qualifier: "u",
            object: objects[0],
        });
    });

    test("converts table completion objects to describe_table containers only", () => {
        expect(toSqlColumnContainerRef(objects[0])).toEqual({
            kind: "table",
            database: "app",
            schema: null,
            objectName: "users",
            table: "users",
        });

        expect(toSqlColumnContainerRef(objects[3])).toBeNull();
    });

    test("maps table schema columns into SQL completion columns", () => {
        expect(
            buildSqlColumnsFromTableSchema({
                objectName: "users",
                schema: {
                    basics: {
                        tableName: "users",
                        databaseName: "app",
                        schemaName: "",
                        engine: null,
                        charset: null,
                        collation: null,
                        comment: null,
                        partition: null,
                    },
                    columns: [
                        {
                            name: "id",
                            typeName: "int",
                            nullable: false,
                            defaultValue: null,
                            isPrimaryKey: true,
                            isUnique: true,
                            isIdentity: false,
                            comment: null,
                            identity: null,
                            generated: null,
                            charset: null,
                            collation: null,
                        },
                    ],
                    indexes: [],
                    constraints: [],
                },
            }),
        ).toEqual([
            {
                name: "id",
                typeName: "int",
                nullable: false,
                objectName: "users",
            },
        ]);
    });
});
