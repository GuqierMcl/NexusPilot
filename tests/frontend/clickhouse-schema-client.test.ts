import { expect, test } from "bun:test";

import {
    alterClickHouseTable,
    createClickHouseDatabase,
    createClickHouseTable,
    describeClickHouseTableSchema,
    dropClickHouseDatabase,
    dropClickHouseTable,
    executeClickHouseColumnAction,
    executeClickHouseProjectionChange,
    executeClickHouseSkippingIndexChange,
    previewAlterClickHouseTable,
    previewClickHouseColumnAction,
    previewClickHouseProjectionChange,
    previewClickHouseSkippingIndexChange,
    previewCreateClickHouseDatabase,
    previewCreateClickHouseTable,
    previewDropClickHouseDatabase,
    previewDropClickHouseTable,
    type ClickHouseSchemaTransport,
} from "../../src/lib/clickhouse-schema-client";
import type { ApiInvokeOptions } from "../../src/lib/api-client";
import { queryKeys } from "../../src/lib/query-keys";
import type {
    ClickHouseAlterTableTarget,
    ClickHouseCreateTableTarget,
    ClickHouseTableSchema,
    ContainerRef,
    NativeSchemaExecuteChangeRequest,
    NativeSchemaChangeTarget,
} from "../../src/types/ipc";

const tableContainer: ContainerRef = {
    kind: "table",
    database: "analytics",
    table: "events",
};

const schemaFixture: ClickHouseTableSchema = {
    identity: {
        database: "analytics",
        name: "events",
        objectKind: "table",
        uuid: null,
    },
    engine: {
        family: "MergeTree",
        arguments: [],
        rawExpression: "MergeTree",
    },
    columns: [],
    keys: {
        orderBy: "tuple()",
        partitionBy: null,
        primaryKey: null,
        sampleBy: null,
    },
    tableTtl: null,
    comment: null,
    settings: [],
    projections: [],
    skippingIndexes: [],
    editability: { mode: "editable", blockers: [] },
    baseline: {
        canonicalCreateQuery:
            "CREATE TABLE analytics.events ENGINE = MergeTree ORDER BY tuple()",
        revisionHash: "0".repeat(64),
    },
};

class FakeTransport implements ClickHouseSchemaTransport {
    readonly calls: Array<{
        command: string;
        args: Record<string, unknown>;
    }> = [];
    readonly options: Array<ApiInvokeOptions | undefined> = [];

    async invoke<T>(
        command: string,
        args: Record<string, unknown>,
        options?: ApiInvokeOptions,
    ): Promise<T> {
        this.calls.push({ command, args });
        this.options.push(options);
        return schemaFixture as T;
    }
}

test("describe client forwards profile and table ownership", async () => {
    const fake = new FakeTransport();

    const result = await describeClickHouseTableSchema(fake, {
        profileId: "profile-1",
        container: tableContainer,
    });

    expect(fake.calls).toEqual([
        {
            command: "describe_clickhouse_table_schema",
            args: {
                profileId: "profile-1",
                container: tableContainer,
            },
        },
    ]);
    expect(result.identity.name).toBe("events");
});

test("describe client rejects invalid table ownership before invoke", async () => {
    const fake = new FakeTransport();
    const invalidContainers: ContainerRef[] = [
        { kind: "view", database: "analytics", table: "events" },
        { kind: "table", table: "events" },
        { kind: "table", database: "analytics", table: "   " },
    ];

    for (const container of invalidContainers) {
        await expect(
            describeClickHouseTableSchema(fake, {
                profileId: "profile-1",
                container,
            }),
        ).rejects.toThrow();
    }

    expect(fake.calls).toEqual([]);
});

test("ClickHouse design query key owns profile tab and container", () => {
    expect(
        queryKeys.clickHouseTableDesign(
            "profile-1",
            "runtime-tab-1",
            tableContainer,
        ),
    ).toEqual([
        "metadata",
        "profile-1",
        "runtime-tab-1",
        "clickHouseTableDesign",
        JSON.stringify(tableContainer),
    ]);
});

const createTarget: ClickHouseCreateTableTarget = {
    database: "analytics",
    name: "events",
    columns: [
        {
            name: "id",
            typeName: "UInt64",
            defaultKind: "none",
            defaultExpression: null,
            codecs: [],
            ttlExpression: null,
            comment: null,
        },
    ],
    engine: { family: "MergeTree", arguments: [] },
    keys: {
        orderBy: "tuple()",
        partitionBy: null,
        primaryKey: null,
        sampleBy: null,
    },
    tableTtl: null,
    comment: null,
    settings: [],
};

test("native create clients use only ClickHouse strong command names and camelCase args", async () => {
    const fake = new FakeTransport();
    const planHash = "a".repeat(64);

    await previewCreateClickHouseDatabase(fake, {
        profileId: "profile-1",
        target: { name: "analytics" },
    });
    await createClickHouseDatabase(fake, {
        profileId: "profile-1",
        request: {
            target: { name: "analytics" },
            expectedPlanHash: planHash,
            confirmation: null,
        },
    });
    await previewCreateClickHouseTable(fake, {
        profileId: "profile-1",
        target: createTarget,
    });
    await createClickHouseTable(fake, {
        profileId: "profile-1",
        request: {
            target: createTarget,
            expectedPlanHash: planHash,
            confirmation: null,
        },
    });

    expect(fake.calls).toEqual([
        {
            command: "preview_create_clickhouse_database",
            args: {
                profileId: "profile-1",
                target: { name: "analytics" },
            },
        },
        {
            command: "create_clickhouse_database",
            args: {
                profileId: "profile-1",
                request: {
                    target: { name: "analytics" },
                    expectedPlanHash: planHash,
                    confirmation: null,
                },
            },
        },
        {
            command: "preview_create_clickhouse_table",
            args: { profileId: "profile-1", target: createTarget },
        },
        {
            command: "create_clickhouse_table",
            args: {
                profileId: "profile-1",
                request: {
                    target: createTarget,
                    expectedPlanHash: planHash,
                    confirmation: null,
                },
            },
        },
    ]);
    expect(
        fake.calls.some(({ command }) =>
            ["preview_create_table", "create_table"].includes(command),
        ),
    ).toBe(false);
    expect(fake.options).toEqual([
        { silent: true },
        undefined,
        { silent: true },
        undefined,
    ]);
});

const alterTarget: ClickHouseAlterTableTarget = {
    baseline: schemaFixture,
    desired: { ...createTarget, comment: "changed" },
    columnRenames: [],
};

const alterRequest: NativeSchemaExecuteChangeRequest = {
    target: { kind: "clickhouse_table_alter", target: alterTarget },
    baseline: { kind: "clickhouse_table", baseline: schemaFixture },
    expectedPlanHash: "b".repeat(64),
    confirmation: {
        accepted: true,
        objectName: null,
        clusterName: null,
    },
};

test("native change clients use exact strong commands arguments and preview silence", async () => {
    const fake = new FakeTransport();
    const columnTarget = {
        kind: "clickhouse_column_clear" as const,
        target: { baseline: schemaFixture, columnName: "id" },
    };
    const columnRequest: NativeSchemaExecuteChangeRequest = {
        ...alterRequest,
        target: columnTarget,
    };
    const tableDropTarget = { container: tableContainer };
    const tableDropRequest: NativeSchemaExecuteChangeRequest = {
        ...alterRequest,
        target: { kind: "clickhouse_table_drop", target: tableDropTarget },
    };
    const databaseContainer: ContainerRef = {
        kind: "database",
        database: "analytics",
    };
    const databaseDropTarget = { container: databaseContainer };
    const databaseDropRequest: NativeSchemaExecuteChangeRequest = {
        ...alterRequest,
        target: {
            kind: "clickhouse_database_drop",
            target: databaseDropTarget,
        },
        baseline: {
            kind: "clickhouse_database",
            baseline: {
                name: "analytics",
                engine: "Atomic",
                uuid: null,
                objects: [],
            },
        },
    };

    await previewAlterClickHouseTable(fake, {
        profileId: "profile-1",
        target: alterTarget,
    });
    await alterClickHouseTable(fake, {
        profileId: "profile-1",
        request: alterRequest,
    });
    await previewClickHouseColumnAction(fake, {
        profileId: "profile-1",
        target: columnTarget,
    });
    await executeClickHouseColumnAction(fake, {
        profileId: "profile-1",
        request: columnRequest,
    });
    await previewDropClickHouseTable(fake, {
        profileId: "profile-1",
        target: tableDropTarget,
    });
    await dropClickHouseTable(fake, {
        profileId: "profile-1",
        request: tableDropRequest,
    });
    await previewDropClickHouseDatabase(fake, {
        profileId: "profile-1",
        target: databaseDropTarget,
    });
    await dropClickHouseDatabase(fake, {
        profileId: "profile-1",
        request: databaseDropRequest,
    });

    expect(fake.calls).toEqual([
        {
            command: "preview_alter_clickhouse_table",
            args: { profileId: "profile-1", target: alterTarget },
        },
        {
            command: "alter_clickhouse_table",
            args: { profileId: "profile-1", request: alterRequest },
        },
        {
            command: "preview_clickhouse_column_action",
            args: { profileId: "profile-1", target: columnTarget },
        },
        {
            command: "execute_clickhouse_column_action",
            args: { profileId: "profile-1", request: columnRequest },
        },
        {
            command: "preview_drop_clickhouse_table",
            args: { profileId: "profile-1", target: tableDropTarget },
        },
        {
            command: "drop_clickhouse_table",
            args: { profileId: "profile-1", request: tableDropRequest },
        },
        {
            command: "preview_drop_clickhouse_database",
            args: { profileId: "profile-1", target: databaseDropTarget },
        },
        {
            command: "drop_clickhouse_database",
            args: { profileId: "profile-1", request: databaseDropRequest },
        },
    ]);
    expect(fake.options).toEqual([
        { silent: true },
        undefined,
        { silent: true },
        undefined,
        { silent: true },
        undefined,
        { silent: true },
        undefined,
    ]);
});

test("native change clients reject cross-command targets and invalid ownership", async () => {
    const fake = new FakeTransport();
    const invalidTable: ContainerRef = {
        kind: "view",
        database: "analytics",
        table: "events",
    };
    const invalidDatabase: ContainerRef = {
        kind: "database",
        database: "analytics",
        table: "events",
    };

    await expect(
        previewDropClickHouseTable(fake, {
            profileId: "profile-1",
            target: { container: invalidTable },
        }),
    ).rejects.toThrow();
    await expect(
        previewDropClickHouseDatabase(fake, {
            profileId: "profile-1",
            target: { container: invalidDatabase },
        }),
    ).rejects.toThrow();
    await expect(
        executeClickHouseColumnAction(fake, {
            profileId: "profile-1",
            request: alterRequest,
        }),
    ).rejects.toThrow();
    expect(fake.calls).toEqual([]);
});

test("Phase 5D clients use exact commands preview silence and strong target guards", async () => {
    const fake = new FakeTransport();
    const projectionTarget = {
        kind: "clickhouse_projection_create",
        target: {
            baseline: schemaFixture,
            projection: {
                name: "by_tenant",
                query: "SELECT tenant_id ORDER BY tenant_id",
            },
        },
    } satisfies NativeSchemaChangeTarget;
    const indexTarget = {
        kind: "clickhouse_skipping_index_create",
        target: {
            baseline: schemaFixture,
            index: {
                name: "payload_bf",
                expression: "payload",
                indexType: "tokenbf_v1",
                typeArguments: ["256", "2", "0"],
                granularity: 1,
            },
        },
    } satisfies NativeSchemaChangeTarget;
    const request = (
        target: NativeSchemaChangeTarget,
    ): NativeSchemaExecuteChangeRequest => ({
        target,
        baseline: { kind: "clickhouse_table", baseline: schemaFixture },
        expectedPlanHash: "d".repeat(64),
        confirmation: null,
    });

    await previewClickHouseProjectionChange(fake, {
        profileId: "profile-1",
        target: projectionTarget,
    });
    await executeClickHouseProjectionChange(fake, {
        profileId: "profile-1",
        request: request(projectionTarget),
    });
    await previewClickHouseSkippingIndexChange(fake, {
        profileId: "profile-1",
        target: indexTarget,
    });
    await executeClickHouseSkippingIndexChange(fake, {
        profileId: "profile-1",
        request: request(indexTarget),
    });

    expect(fake.calls).toEqual([
        {
            command: "preview_clickhouse_projection_change",
            args: { profileId: "profile-1", target: projectionTarget },
        },
        {
            command: "execute_clickhouse_projection_change",
            args: {
                profileId: "profile-1",
                request: request(projectionTarget),
            },
        },
        {
            command: "preview_clickhouse_skipping_index_change",
            args: { profileId: "profile-1", target: indexTarget },
        },
        {
            command: "execute_clickhouse_skipping_index_change",
            args: { profileId: "profile-1", request: request(indexTarget) },
        },
    ]);
    expect(fake.options).toEqual([
        { silent: true },
        undefined,
        { silent: true },
        undefined,
    ]);

    const guarded = new FakeTransport();
    await expect(
        previewClickHouseSkippingIndexChange(guarded, {
            profileId: "profile-1",
            target: projectionTarget,
        }),
    ).rejects.toThrow();
    await expect(
        executeClickHouseSkippingIndexChange(guarded, {
            profileId: "profile-1",
            request: request(projectionTarget),
        }),
    ).rejects.toThrow();
    await expect(
        executeClickHouseProjectionChange(guarded, {
            profileId: "profile-1",
            request: {
                ...request(projectionTarget),
                baseline: {
                    kind: "clickhouse_database",
                    baseline: {
                        name: "analytics",
                        engine: "Atomic",
                        uuid: null,
                        objects: [],
                    },
                },
            },
        }),
    ).rejects.toThrow();
    expect(guarded.calls).toEqual([]);
});
