import { expect, test } from "bun:test";

import { mysqlDriverConfig } from "../../src/features/workbench/explorer/driver-configs/mysql";
import { postgresDriverConfig } from "../../src/features/workbench/explorer/driver-configs/postgres";
import { redisDriverConfig } from "../../src/features/workbench/explorer/driver-configs/redis";
import {
    buildSavedQueryGroupForRemoteNode,
    shouldAttachSavedQueryGroupToRemoteNode,
} from "../../src/features/workbench/explorer/savedQueryNodes";
import type { ExplorerTreeNode } from "../../src/features/workbench/explorer/types";
import type { SavedQuery } from "../../src/types/saved-queries";

const queries = [
    {
        id: "query-1",
        profileId: "profile-1",
        title: "List users",
        driver: "postgres",
        databaseName: "app",
        schemaName: "public",
        sqlText: "select * from users",
        createdAt: 1,
        updatedAt: 1,
    },
] satisfies SavedQuery[];

function databaseNode(): ExplorerTreeNode {
    return {
        id: "profile-1::database::app",
        type: "database",
        label: "app",
        metadata: {
            profileId: "profile-1",
            container: {
                kind: "database",
                database: "app",
            },
        },
        isLeaf: false,
    };
}

function schemaNode(): ExplorerTreeNode {
    return {
        id: "profile-1::schema::app::public",
        type: "schema",
        label: "public",
        metadata: {
            profileId: "profile-1",
            container: {
                kind: "schema",
                database: "app",
                schema: "public",
            },
        },
        isLeaf: false,
    };
}

test("driver config places contextual saved queries under MySQL database nodes", () => {
    const node = databaseNode();

    expect(shouldAttachSavedQueryGroupToRemoteNode(node, mysqlDriverConfig)).toBe(
        true,
    );

    const group = buildSavedQueryGroupForRemoteNode(
        node,
        queries,
        mysqlDriverConfig,
    );

    expect(group?.type).toBe("saved_query_group");
    expect(group?.context).toEqual({ database: "app", schema: null });
});

test("driver config prevents PostgreSQL database-level query groups", () => {
    const node = databaseNode();

    expect(
        shouldAttachSavedQueryGroupToRemoteNode(node, postgresDriverConfig),
    ).toBe(false);

    expect(
        buildSavedQueryGroupForRemoteNode(node, queries, postgresDriverConfig),
    ).toBeNull();
});

test("driver config places contextual saved queries under PostgreSQL schema nodes", () => {
    const node = schemaNode();

    expect(shouldAttachSavedQueryGroupToRemoteNode(node, postgresDriverConfig)).toBe(
        true,
    );

    const group = buildSavedQueryGroupForRemoteNode(
        node,
        queries,
        postgresDriverConfig,
    );

    expect(group?.type).toBe("saved_query_group");
    expect(group?.context).toEqual({ database: "app", schema: "public" });
    expect(group?.children).toHaveLength(1);
});

test("PostgreSQL database-only legacy saved queries do not create database-level query groups", () => {
    const legacyDatabaseOnlyQuery = [
        {
            id: "legacy-db-only",
            profileId: "profile-1",
            title: "Legacy DB query",
            driver: "postgres",
            databaseName: "app",
            schemaName: null,
            sqlText: "select 1",
            createdAt: 1,
            updatedAt: 1,
        },
    ] satisfies SavedQuery[];

    expect(
        buildSavedQueryGroupForRemoteNode(
            databaseNode(),
            legacyDatabaseOnlyQuery,
            postgresDriverConfig,
        ),
    ).toBeNull();

    const schemaGroup = buildSavedQueryGroupForRemoteNode(
        schemaNode(),
        legacyDatabaseOnlyQuery,
        postgresDriverConfig,
    );

    expect(schemaGroup?.type).toBe("saved_query_group");
    expect(schemaGroup?.context).toEqual({ database: "app", schema: "public" });
    expect(schemaGroup?.children).toEqual([]);
});

test("driver config disables SQL saved-query groups for Redis", () => {
    expect(shouldAttachSavedQueryGroupToRemoteNode(databaseNode(), redisDriverConfig)).toBe(
        false,
    );
    expect(shouldAttachSavedQueryGroupToRemoteNode(schemaNode(), redisDriverConfig)).toBe(
        false,
    );
});
