import { expect, test } from "bun:test";

import { mysqlDriverConfig } from "../../src/features/workbench/explorer/driver-configs/mysql";
import { postgresDriverConfig } from "../../src/features/workbench/explorer/driver-configs/postgres";
import { buildSavedQueryGroupForRemoteNode } from "../../src/features/workbench/explorer/savedQueryNodes";
import type { ExplorerTreeNode } from "../../src/features/workbench/explorer/types";

function databaseNode(profileId: string): ExplorerTreeNode {
    return {
        id: `${profileId}::database::app`,
        type: "database",
        label: "app",
        metadata: {
            profileId,
            dbName: "app",
            container: {
                kind: "database",
                database: "app",
            },
        },
    };
}

function schemaNode(profileId: string): ExplorerTreeNode {
    return {
        id: `${profileId}::schema::app::public`,
        type: "schema",
        label: "public",
        isLeaf: false,
        metadata: {
            profileId,
            dbName: "app",
            schemaName: "public",
            container: {
                kind: "schema",
                database: "app",
                schema: "public",
            },
        },
    };
}

test("does not inject saved query group directly under PostgreSQL database nodes", () => {
    const postgresDatabaseGroup = buildSavedQueryGroupForRemoteNode(
        databaseNode("postgres-profile"),
        [],
        postgresDriverConfig,
    );

    expect(postgresDatabaseGroup).toBeNull();
});

test("keeps saved query group under MySQL database nodes", () => {
    const mysqlDatabaseGroup = buildSavedQueryGroupForRemoteNode(
        databaseNode("mysql-profile"),
        [],
        mysqlDriverConfig,
    );

    expect(mysqlDatabaseGroup?.context).toEqual({ database: "app", schema: null });
});

test("keeps saved query group under PostgreSQL schema nodes", () => {
    const postgresSchemaGroup = buildSavedQueryGroupForRemoteNode(
        schemaNode("postgres-profile"),
        [],
        postgresDriverConfig,
    );

    expect(postgresSchemaGroup?.context).toEqual({
        database: "app",
        schema: "public",
    });
});
