import { expect, test } from "bun:test";
import { Database } from "lucide-react";

import {
    buildExplorerNodeActionSet,
    type ExplorerNodeActionContext,
    type ExplorerNodeActionContributor,
    type ExplorerNodeActionHandlers,
} from "../../src/features/workbench/explorer/actions";
import { collectExplorerNodeActionContributions } from "../../src/features/workbench/explorer/actions/actionContributors";
import { buildRemoteNodeActionSet } from "../../src/features/workbench/explorer/actions/remoteActionContributors";
import type { ExplorerTreeNode } from "../../src/features/workbench/explorer/types";
import type { DriverCapabilities } from "../../src/types/ipc";

const fullCapabilities: DriverCapabilities = {
    schemaBrowser: true,
    schemaMutator: true,
    schemaMutation: {
        objects: [
            {
                kind: "database",
                operations: ["create", "alter", "drop"],
            },
            {
                kind: "table",
                operations: ["create", "alter", "drop"],
            },
        ],
        ddlPreview: true,
        destructiveConfirmation: true,
        remoteDriftProtection: true,
    },
    dataTableBrowser: true,
    tableRowMutator: false,
    tableRowInserter: false,
    transactionManager: false,
    sqlExecutor: true,
    keyValueBrowser: true,
    graphQueryer: false,
    vectorSearcher: false,
};

const clickHousePhase5BCapabilities: DriverCapabilities = {
    ...fullCapabilities,
    schemaMutator: false,
    schemaMutation: {
        objects: [
            { kind: "database", operations: ["create"] },
            { kind: "table", operations: ["create"] },
        ],
        ddlPreview: true,
        destructiveConfirmation: false,
        remoteDriftProtection: false,
    },
};

const clickHousePhase5CCapabilities: DriverCapabilities = {
    ...clickHousePhase5BCapabilities,
    schemaMutation: {
        objects: [
            { kind: "database", operations: ["create", "drop"] },
            { kind: "table", operations: ["create", "alter", "drop"] },
            { kind: "column", operations: ["clear", "materialize"] },
        ],
        ddlPreview: true,
        destructiveConfirmation: true,
        remoteDriftProtection: true,
    },
};

const clickHouseViewCapabilities: DriverCapabilities = {
    ...clickHousePhase5CCapabilities,
    schemaMutation: {
        ...clickHousePhase5CCapabilities.schemaMutation!,
        objects: [
            ...clickHousePhase5CCapabilities.schemaMutation!.objects,
            { kind: "view", operations: ["create", "alter", "rename", "drop"] },
            {
                kind: "materialized_view",
                operations: ["create", "alter", "rename", "drop"],
            },
        ],
    },
};

const legacyBooleanOnlyCapabilities: DriverCapabilities = {
    ...fullCapabilities,
    schemaMutation: undefined,
};

const handlers: ExplorerNodeActionHandlers = {
    refreshNode: () => undefined,
    createDatabase: () => undefined,
    editDatabase: () => undefined,
    deleteDatabase: () => undefined,
    openSqlEditor: () => undefined,
    openTableData: () => undefined,
    openTableDesign: () => undefined,
    deleteTable: () => undefined,
    openKeyValues: () => undefined,
    copyText: () => undefined,
};

function makeContext(
    node: ExplorerTreeNode,
    overrides: Partial<ExplorerNodeActionContext> = {},
): ExplorerNodeActionContext {
    return {
        node,
        connectionDriver: "mysql",
        connectionRuntimeState: "connected",
        capabilities: fullCapabilities,
        isNodeLoading: false,
        isLeafNode: "isLeaf" in node ? node.isLeaf === true : false,
        hasChildren: false,
        hasLoadedChildren: false,
        handlers,
        ...overrides,
    };
}

function databaseNode(): ExplorerTreeNode {
    return {
        id: "profile-1::database::app",
        type: "database",
        label: "app",
        metadata: {
            profileId: "profile-1",
            dbName: "app",
            container: {
                kind: "database",
                database: "app",
            },
        },
        isLeaf: false,
    };
}

function connectionNode(): ExplorerTreeNode {
    return {
        id: "profile-1",
        type: "connection",
        label: "ClickHouse",
        connection: {
            id: "profile-1",
            name: "ClickHouse",
            driver: "clickhouse",
            environment: "development",
            host: "localhost",
            port: 8123,
            username: "default",
            password: "",
            savePassword: false,
            defaultDatabase: "default",
            protocol: "http",
            connectTimeoutSeconds: 5,
            sshTunnel: {
                enabled: false,
                host: "",
                port: 22,
                username: "",
                authMethod: "password",
                password: "",
                privateKeyPath: "",
                privateKeyPassphrase: "",
                hostVerification: "trust-on-first-use",
                hostKeyFingerprint: null,
            },
            folderId: null,
            createdAt: 0,
            updatedAt: 0,
            tagLabel: "",
        },
    };
}

function tablesAssetGroupNode(): ExplorerTreeNode {
    return {
        id: "profile-1::asset-group::app::tables",
        type: "asset_group",
        label: "表",
        metadata: {
            profileId: "profile-1",
            dbName: "app",
            container: {
                kind: "asset_group",
                groupType: "tables",
                database: "app",
            },
        },
        isLeaf: false,
    };
}

function tableNode(): ExplorerTreeNode {
    return {
        id: "profile-1::table::app::users",
        type: "table",
        label: "users",
        isLeaf: false,
        metadata: {
            profileId: "profile-1",
            dbName: "app",
            tableName: "users",
            container: {
                kind: "table",
                database: "app",
                table: "users",
            },
        },
    };
}

function redisKeyNode(): ExplorerTreeNode {
    return {
        id: "profile-1::redis-key::session:1",
        type: "redis_key",
        label: "session:1",
        isLeaf: true,
        metadata: {
            profileId: "profile-1",
            dbName: "0",
            container: {
                kind: "redis_key",
                dbIndex: 0,
                key: "session:1",
                pattern: "session:*",
            },
        },
    };
}

function viewAssetGroupNode(
    groupType: "views" | "materialized_views",
): ExplorerTreeNode {
    return {
        id: `profile-1::asset-group::app::${groupType}`,
        type: "asset_group",
        label: groupType,
        metadata: {
            profileId: "profile-1",
            dbName: "app",
            container: { kind: "asset_group", groupType, database: "app" },
        },
        isLeaf: false,
    };
}

function viewNode(kind: "view" | "materialized_view"): ExplorerTreeNode {
    return {
        id: `profile-1::${kind}::app::daily`,
        type: kind,
        label: "daily",
        isLeaf: false,
        metadata: {
            profileId: "profile-1",
            dbName: "app",
            tableName: "daily",
            container: { kind, database: "app", table: "daily" },
        },
    };
}

function readOnlyMetadataLeafNode(
    type: "dictionary" | "projection" | "index" | "partition",
): ExplorerTreeNode {
    return {
        id: `profile-1::${type}::analytics::events::object`,
        type,
        label: "object",
        isLeaf: true,
        metadata: {
            profileId: "profile-1",
            dbName: "analytics",
            tableName: type === "dictionary" ? undefined : "events",
            container: {
                kind: type,
                database: "analytics",
                table: type === "dictionary" ? undefined : "events",
                objectName: "object",
            },
        },
    };
}

function actionIds(
    actionSet: ReturnType<typeof buildRemoteNodeActionSet>,
    groupId: string,
): string[] {
    return (
        actionSet.groups
            .find((group) => group.id === groupId)
            ?.actions.map((action) => action.id) ?? []
    );
}

test("collector filters hidden actions, merges groups, and keeps first primary action", () => {
    const contributors: ExplorerNodeActionContributor[] = [
        () => ({
            groupId: "browse",
            primaryActionId: "contributor.first",
            actions: [
                {
                    id: "contributor.hidden",
                    label: "Hidden",
                    group: "browse",
                    visible: false,
                    run: () => undefined,
                },
                {
                    id: "contributor.first",
                    label: "First",
                    group: "browse",
                    run: () => undefined,
                },
            ],
        }),
        () => ({
            groupId: "browse",
            primaryActionId: "contributor.second",
            actions: [
                {
                    id: "contributor.second",
                    label: "Second",
                    group: "browse",
                    run: () => undefined,
                },
            ],
        }),
    ];

    const collected = collectExplorerNodeActionContributions(
        makeContext(databaseNode()),
        contributors,
    );

    expect(collected.primaryActionId).toBe("contributor.first");
    expect(collected.groups).toHaveLength(1);
    expect(collected.groups[0]?.id).toBe("browse");
    expect(collected.groups[0]?.actions.map((action) => action.id)).toEqual([
        "contributor.first",
        "contributor.second",
    ]);
});

test("remote table contributors preserve table browse actions and primary action", () => {
    const actionSet = buildRemoteNodeActionSet(makeContext(tableNode()));

    expect(actionIds(actionSet, "remote")).toEqual([
        "remote.copyName",
        "remote.copyContainerRef",
        "remote.refreshChildren",
    ]);
    expect(actionIds(actionSet, "browse")).toEqual([
        "remote.table.openData",
        "remote.table.openDesign",
        "remote.table.copyQualifiedName",
    ]);
    expect(actionSet.primaryActionId).toBe("remote.table.openData");
});

test("remote tables asset group contributor preserves create-table action", () => {
    const actionSet = buildRemoteNodeActionSet(
        makeContext(tablesAssetGroupNode()),
    );

    expect(actionIds(actionSet, "browse")).toContain(
        "remote.table.createTable",
    );
});

test("remote redis contributors preserve key browse actions and primary action", () => {
    const actionSet = buildRemoteNodeActionSet(makeContext(redisKeyNode()));

    expect(actionIds(actionSet, "browse")).toEqual([
        "remote.redis.openKeyValues",
        "remote.redis.copyPattern",
        "remote.redis.copyKey",
    ]);
    expect(actionSet.primaryActionId).toBe("remote.redis.openKeyValues");
});

test("View and Materialized View actions require their exact neutral capabilities", () => {
    for (const [kind, groupType] of [
        ["view", "views"],
        ["materialized_view", "materialized_views"],
    ] as const) {
        const closedGroup = buildRemoteNodeActionSet(
            makeContext(viewAssetGroupNode(groupType), {
                connectionDriver: "clickhouse",
                capabilities: clickHousePhase5CCapabilities,
            }),
        );
        expect(actionIds(closedGroup, "browse")).not.toContain(
            `remote.${kind}.create`,
        );
        const closedLeaf = buildRemoteNodeActionSet(
            makeContext(viewNode(kind), {
                connectionDriver: "clickhouse",
                capabilities: clickHousePhase5CCapabilities,
            }),
        );
        expect(actionIds(closedLeaf, "browse")).toContain(
            `remote.${kind}.openDesign`,
        );
        expect(actionIds(closedLeaf, "metadata")).not.toContain(
            `remote.${kind}.rename`,
        );
        expect(actionIds(closedLeaf, "metadata")).not.toContain(
            `remote.${kind}.drop`,
        );

        const group = buildRemoteNodeActionSet(
            makeContext(viewAssetGroupNode(groupType), {
                connectionDriver: "clickhouse",
                capabilities: clickHouseViewCapabilities,
            }),
        );
        const leaf = buildRemoteNodeActionSet(
            makeContext(viewNode(kind), {
                connectionDriver: "clickhouse",
                capabilities: clickHouseViewCapabilities,
            }),
        );
        expect(actionIds(group, "browse")).toContain(`remote.${kind}.create`);
        expect(actionIds(leaf, "browse")).toEqual(
            expect.arrayContaining([
                "remote.table.openData",
                `remote.${kind}.openDesign`,
            ]),
        );
        expect(actionIds(leaf, "metadata")).toEqual(
            expect.arrayContaining([
                `remote.${kind}.rename`,
                `remote.${kind}.drop`,
            ]),
        );
    }
});

test("ClickHouse Phase 5B capability fixture keeps registered Phase 5C Explorer actions closed", () => {
    expect(clickHousePhase5BCapabilities.schemaMutator).toBe(false);
    expect(clickHousePhase5BCapabilities.schemaMutation).toEqual({
        objects: [
            { kind: "database", operations: ["create"] },
            { kind: "table", operations: ["create"] },
        ],
        ddlPreview: true,
        destructiveConfirmation: false,
        remoteDriftProtection: false,
    });

    const tableActions = buildRemoteNodeActionSet(
        makeContext(tableNode(), {
            connectionDriver: "clickhouse",
            capabilities: clickHousePhase5BCapabilities,
        }),
    );
    const tablesGroupActions = buildRemoteNodeActionSet(
        makeContext(tablesAssetGroupNode(), {
            connectionDriver: "clickhouse",
            capabilities: clickHousePhase5BCapabilities,
        }),
    );
    const connectionActions = buildExplorerNodeActionSet(
        makeContext(connectionNode(), {
            connectionDriver: "clickhouse",
            capabilities: clickHousePhase5BCapabilities,
        }),
    );
    const databaseActions = buildRemoteNodeActionSet(
        makeContext(databaseNode(), {
            connectionDriver: "clickhouse",
            capabilities: clickHousePhase5BCapabilities,
        }),
    );

    expect(actionIds(tableActions, "browse")).toContain(
        "remote.table.openDesign",
    );
    expect(actionIds(tableActions, "metadata")).not.toContain(
        "remote.table.deleteTable",
    );
    expect(actionIds(tablesGroupActions, "browse")).toContain(
        "remote.table.createTable",
    );
    expect(actionIds(connectionActions, "connection")).toContain(
        "connection.createDatabase",
    );
    expect(actionIds(databaseActions, "metadata")).toContain(
        "remote.database.createDatabase",
    );
    expect(actionIds(databaseActions, "browse")).toContain(
        "remote.table.createTable",
    );
    expect(actionIds(databaseActions, "metadata")).not.toContain(
        "remote.database.editDatabase",
    );
    expect(actionIds(databaseActions, "metadata")).not.toContain(
        "remote.database.deleteDatabase",
    );
});

test("ClickHouse Phase 5C drop actions derive only from schemaMutation capability", () => {
    expect(clickHousePhase5CCapabilities.schemaMutator).toBe(false);
    expect(clickHousePhase5CCapabilities.schemaMutation).toEqual({
        objects: [
            { kind: "database", operations: ["create", "drop"] },
            { kind: "table", operations: ["create", "alter", "drop"] },
            { kind: "column", operations: ["clear", "materialize"] },
        ],
        ddlPreview: true,
        destructiveConfirmation: true,
        remoteDriftProtection: true,
    });

    const tableActions = buildRemoteNodeActionSet(
        makeContext(tableNode(), {
            connectionDriver: "clickhouse",
            capabilities: clickHousePhase5CCapabilities,
        }),
    );
    const databaseActions = buildRemoteNodeActionSet(
        makeContext(databaseNode(), {
            connectionDriver: "clickhouse",
            capabilities: clickHousePhase5CCapabilities,
        }),
    );

    expect(actionIds(tableActions, "metadata")).toContain(
        "remote.table.deleteTable",
    );
    expect(actionIds(databaseActions, "metadata")).toContain(
        "remote.database.deleteDatabase",
    );
});

test("MySQL and PostgreSQL retain structured table and database mutation actions", () => {
    for (const connectionDriver of ["mysql", "postgres"] as const) {
        const tableActions = buildRemoteNodeActionSet(
            makeContext(tableNode(), {
                connectionDriver,
                capabilities: fullCapabilities,
            }),
        );
        const tablesGroupActions = buildRemoteNodeActionSet(
            makeContext(tablesAssetGroupNode(), {
                connectionDriver,
                capabilities: fullCapabilities,
            }),
        );
        const connectionActions = buildExplorerNodeActionSet(
            makeContext(connectionNode(), {
                connectionDriver,
                capabilities: fullCapabilities,
            }),
        );
        const databaseActions = buildRemoteNodeActionSet(
            makeContext(databaseNode(), {
                connectionDriver,
                capabilities: fullCapabilities,
            }),
        );

        expect(actionIds(tableActions, "browse")).toContain(
            "remote.table.openDesign",
        );
        expect(actionIds(tableActions, "metadata")).toContain(
            "remote.table.deleteTable",
        );
        expect(actionIds(tablesGroupActions, "browse")).toContain(
            "remote.table.createTable",
        );
        expect(actionIds(connectionActions, "connection")).toContain(
            "connection.createDatabase",
        );
        expect(actionIds(databaseActions, "metadata")).toContain(
            "remote.database.createDatabase",
        );
    }
});

test("legacy schemaMutator does not authorize concrete schema operations", () => {
    const tableActions = buildRemoteNodeActionSet(
        makeContext(tableNode(), {
            connectionDriver: "postgres",
            capabilities: legacyBooleanOnlyCapabilities,
        }),
    );
    const tablesGroupActions = buildRemoteNodeActionSet(
        makeContext(tablesAssetGroupNode(), {
            connectionDriver: "postgres",
            capabilities: legacyBooleanOnlyCapabilities,
        }),
    );

    expect(actionIds(tableActions, "browse")).not.toContain(
        "remote.table.openDesign",
    );
    expect(actionIds(tableActions, "metadata")).not.toContain(
        "remote.table.deleteTable",
    );
    expect(actionIds(tablesGroupActions, "browse")).not.toContain(
        "remote.table.createTable",
    );
});

test("read-only metadata leaves expose copy actions without a primary action", () => {
    for (const type of [
        "dictionary",
        "projection",
        "index",
        "partition",
    ] as const) {
        const actionSet = buildRemoteNodeActionSet(
            makeContext(readOnlyMetadataLeafNode(type)),
        );

        expect(actionIds(actionSet, "remote")).toEqual([
            "remote.copyName",
            "remote.copyContainerRef",
        ]);
        expect(actionSet.primaryActionId).toBeUndefined();
        expect(actionSet.groups.map((group) => group.id)).toEqual(["remote"]);
    }
});

test("remote action set accepts extra driver-provided contributors", () => {
    const driverContributor: ExplorerNodeActionContributor = () => ({
        groupId: "driver",
        label: "Driver",
        primaryActionId: "driver.remote.inspect",
        actions: [
            {
                id: "driver.remote.inspect",
                label: "Inspect",
                icon: Database,
                group: "driver",
                run: () => undefined,
            },
        ],
    });

    const actionSet = buildRemoteNodeActionSet(makeContext(databaseNode()), [
        driverContributor,
    ]);

    expect(actionIds(actionSet, "driver")).toEqual(["driver.remote.inspect"]);
    expect(actionSet.primaryActionId).toBe("driver.remote.inspect");
});

test("public explorer action builder still delegates remote table actions", () => {
    const actionSet = buildExplorerNodeActionSet(makeContext(tableNode()));

    expect(actionIds(actionSet, "browse")).toContain("remote.table.openData");
    expect(actionSet.primaryActionId).toBe("remote.table.openData");
});

test("connection actions expose teardown throughout runtime ownership states", () => {
    const runtimeStates = [
        "connecting",
        "connected",
        "degraded",
        "reconnecting",
        "error",
    ] as const;

    for (const connectionRuntimeState of runtimeStates) {
        const actionSet = buildExplorerNodeActionSet(
            makeContext(connectionNode(), {
                connectionRuntimeState,
                handlers: {
                    ...handlers,
                    openConnection: () => true,
                    closeConnection: () => undefined,
                },
            }),
        );
        const connectionActions =
            actionSet.groups.find((group) => group.id === "connection")
                ?.actions ?? [];
        const open = connectionActions.find(
            (action) => action.id === "connection.open",
        );

        expect(connectionActions.map((action) => action.id)).toContain(
            "connection.close",
        );
        expect(open?.disabled).toBe(
            connectionRuntimeState === "error" ? false : true,
        );
    }
});

test("connection actions do not offer teardown without owned runtime work", () => {
    for (const connectionRuntimeState of [
        "idle",
        "disconnecting",
        "loading",
    ] as const) {
        const actionSet = buildExplorerNodeActionSet(
            makeContext(connectionNode(), {
                connectionRuntimeState,
                handlers: {
                    ...handlers,
                    openConnection: () => true,
                    closeConnection: () => undefined,
                },
            }),
        );
        const connectionActions =
            actionSet.groups.find((group) => group.id === "connection")
                ?.actions ?? [];
        const open = connectionActions.find(
            (action) => action.id === "connection.open",
        );

        expect(connectionActions.map((action) => action.id)).not.toContain(
            "connection.close",
        );
        expect(open?.disabled).toBe(connectionRuntimeState !== "idle");
    }
});
