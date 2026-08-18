import { describe, expect, test } from "bun:test";

import { mysqlDriverConfig } from "../../../../src/features/workbench/explorer/driver-configs/mysql";
import { postgresDriverConfig } from "../../../../src/features/workbench/explorer/driver-configs/postgres";
import {
    buildContextSavedQueryGroup,
    buildSavedQueryGroupForRemoteNode,
    buildUnscopedSavedQueryGroup,
    filterSavedQueriesForRemoteNode,
} from "../../../../src/features/workbench/explorer/savedQueryNodes";
import type { ExplorerTreeNode } from "../../../../src/features/workbench/explorer/types";
import type { SavedQuery } from "../../../../src/types/saved-queries";

function savedQuery(
    id: string,
    databaseName: string | null,
    schemaName: string | null,
): SavedQuery {
    return {
        id,
        profileId: "profile-1",
        title: `Query ${id}`,
        driver: "mysql",
        databaseName,
        schemaName,
        sqlText: "SELECT 1",
        createdAt: 1,
        updatedAt: 1,
        sortOrder: null,
    };
}

function databaseNode(database: string): ExplorerTreeNode {
    return {
        id: `profile-1::database::${database}`,
        type: "database",
        label: database,
        isLeaf: false,
        metadata: {
            profileId: "profile-1",
            dbName: database,
            container: { kind: "database", database },
        },
    };
}

function schemaNode(database: string, schema: string): ExplorerTreeNode {
    return {
        id: `profile-1::schema::${database}::${schema}`,
        type: "schema",
        label: schema,
        isLeaf: false,
        metadata: {
            profileId: "profile-1",
            dbName: database,
            schemaName: schema,
            container: { kind: "schema", database, schema },
        },
    };
}

describe("saved query Explorer placement", () => {
    test("places MySQL-style queries under the matching database node", () => {
        const queries = [
            savedQuery("traffic", "traffic_monitor", null),
            savedQuery("mysql", "mysql", null),
            savedQuery("unscoped", null, null),
        ];

        expect(
            filterSavedQueriesForRemoteNode(
                databaseNode("traffic_monitor"),
                queries,
            ),
        ).toEqual([queries[0]]);
    });

    test("places PostgreSQL schema-bound queries under the matching schema node", () => {
        const queries = [
            savedQuery("public", "app", "public"),
            savedQuery("admin", "app", "admin"),
            savedQuery("db-only", "app", null),
        ];

        expect(
            filterSavedQueriesForRemoteNode(schemaNode("app", "public"), queries),
        ).toEqual([queries[0]]);
        expect(filterSavedQueriesForRemoteNode(databaseNode("app"), queries))
            .toEqual([queries[2]]);
    });

    test("builds query group nodes with context for new-query actions", () => {
        const group = buildContextSavedQueryGroup({
            profileId: "profile-1",
            parentNodeId: "profile-1::database::traffic_monitor",
            context: { database: "traffic_monitor", schema: null },
            queries: [savedQuery("traffic", "traffic_monitor", null)],
        });

        expect(group?.label).toBe("查询");
        expect(group?.context).toEqual({
            database: "traffic_monitor",
            schema: null,
        });
        expect(group?.children?.[0]?.type).toBe("saved_query");
    });

    test("builds an empty context query group as a new-query entry point", () => {
        const group = buildContextSavedQueryGroup({
            profileId: "profile-1",
            parentNodeId: "profile-1::database::traffic_monitor",
            context: { database: "traffic_monitor", schema: null },
            queries: [],
        });

        expect(group?.label).toBe("查询");
        expect(group?.children).toEqual([]);
        expect(group?.context).toEqual({
            database: "traffic_monitor",
            schema: null,
        });
    });

    test("builds empty database and schema query groups for remote context nodes", () => {
        const databaseGroup = buildSavedQueryGroupForRemoteNode(
            databaseNode("traffic_monitor"),
            [],
            mysqlDriverConfig,
        );
        const schemaGroup = buildSavedQueryGroupForRemoteNode(
            schemaNode("app", "public"),
            [],
            postgresDriverConfig,
        );

        expect(databaseGroup?.label).toBe("查询");
        expect(databaseGroup?.context).toEqual({
            database: "traffic_monitor",
            schema: null,
        });
        expect(databaseGroup?.children).toEqual([]);
        expect(schemaGroup?.label).toBe("查询");
        expect(schemaGroup?.context).toEqual({
            database: "app",
            schema: "public",
        });
        expect(schemaGroup?.children).toEqual([]);
    });

    test("keeps context-less saved queries reachable through a fallback group", () => {
        const group = buildUnscopedSavedQueryGroup("profile-1", [
            savedQuery("unscoped", null, null),
            savedQuery("traffic", "traffic_monitor", null),
        ]);

        expect(group?.label).toBe("查询（未指定上下文）");
        expect(group?.children?.map((node) => node.label)).toEqual([
            "Query unscoped",
        ]);
    });

    test("does not show the unscoped fallback group when no unscoped queries exist", () => {
        expect(
            buildUnscopedSavedQueryGroup("profile-1", [
                savedQuery("traffic", "traffic_monitor", null),
            ]),
        ).toBeNull();
    });
});
