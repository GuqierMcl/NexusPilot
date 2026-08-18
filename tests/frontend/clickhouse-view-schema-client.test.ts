import { expect, test } from "bun:test";

import type { ApiInvokeOptions } from "../../src/lib/api-client";
import {
    createClickHouseView,
    describeClickHouseViewSchema,
    executeClickHouseViewChange,
    getClickHouseViewRuntimeSupport,
    listClickHouseTemporaryViews,
    previewChangeClickHouseView,
    previewCreateClickHouseView,
    type ClickHouseViewSchemaTransport,
} from "../../src/lib/clickhouse-view-schema-client";
import type {
    ClickHouseViewChangeTarget,
    ClickHouseViewCreateTarget,
    ContainerRef,
    NativeSchemaExecuteChangeRequest,
    NativeSchemaExecuteCreateRequest,
} from "../../src/types/ipc";

class FakeTransport implements ClickHouseViewSchemaTransport {
    readonly calls: Array<{
        command: string;
        args: Record<string, unknown>;
        options?: ApiInvokeOptions;
    }> = [];

    async invoke<T>(
        command: string,
        args: Record<string, unknown>,
        options?: ApiInvokeOptions,
    ): Promise<T> {
        this.calls.push({ command, args, options });
        return {} as T;
    }
}

const viewContainer: ContainerRef = {
    kind: "view",
    database: "analytics",
    table: "events_view",
};

const createTarget: ClickHouseViewCreateTarget = {
    desired: {
        address: {
            database: "analytics",
            name: "events_view",
            objectKind: "view",
        },
        family: "normal",
        scope: { kind: "local" },
        columns: { kind: "none" },
        query: "SELECT 1 AS value",
        security: { definer: null, sqlSecurity: null },
        comment: null,
        familyDefinition: { kind: "normal" },
    },
    expectedSupportRevision: "a".repeat(64),
};

const viewSchema = {
    identity: { address: createTarget.desired.address, uuid: null },
    family: "normal" as const,
    scope: { kind: "local" as const },
    columns: { kind: "none" as const },
    query: createTarget.desired.query,
    security: createTarget.desired.security,
    comment: null,
    familyDefinition: { kind: "normal" as const },
    serverSupport: null as never,
    editability: { mode: "editable" as const, blockers: [] },
    baseline: {
        canonicalCreateQuery: "CREATE VIEW analytics.events_view AS SELECT 1",
        revisionHash: "b".repeat(64),
        serverVersion: "25.3.1",
        family: "normal" as const,
        supportRevision: "a".repeat(64),
    },
};

const changeTarget: ClickHouseViewChangeTarget = {
    kind: "alter",
    target: {
        baseline: viewSchema,
        desired: { ...createTarget.desired, comment: "changed" },
        expectedSupportRevision: "a".repeat(64),
    },
};

const createRequest: NativeSchemaExecuteCreateRequest = {
    target: { kind: "clickhouse_view", target: createTarget },
    expectedPlanHash: "c".repeat(64),
    confirmation: null,
};

const changeRequest: NativeSchemaExecuteChangeRequest = {
    target: { kind: "clickhouse_view_alter", target: changeTarget.target },
    baseline: { kind: "clickhouse_view", baseline: viewSchema },
    expectedPlanHash: "d".repeat(64),
    confirmation: null,
};

test("View clients map every strong command to its exact payload", async () => {
    const transport = new FakeTransport();
    const describeRequest = {
        container: viewContainer,
        ownerTabRuntimeId: null,
    };

    await getClickHouseViewRuntimeSupport(transport, {
        profileId: "profile-1",
        database: "analytics",
        ownerTabRuntimeId: null,
    });
    await describeClickHouseViewSchema(transport, {
        profileId: "profile-1",
        request: describeRequest,
    });
    await previewCreateClickHouseView(transport, {
        profileId: "profile-1",
        target: createTarget,
    });
    await createClickHouseView(transport, {
        profileId: "profile-1",
        request: createRequest,
    });
    await previewChangeClickHouseView(transport, {
        profileId: "profile-1",
        target: changeTarget,
    });
    await executeClickHouseViewChange(transport, {
        profileId: "profile-1",
        request: changeRequest,
    });
    await listClickHouseTemporaryViews(transport, {
        profileId: "profile-1",
        ownerTabRuntimeId: "runtime-tab-1",
    });

    expect(transport.calls).toEqual([
        {
            command: "get_clickhouse_view_runtime_support",
            args: {
                profileId: "profile-1",
                database: "analytics",
                ownerTabRuntimeId: null,
            },
            options: { silent: true },
        },
        {
            command: "describe_clickhouse_view_schema",
            args: { profileId: "profile-1", request: describeRequest },
            options: { silent: true },
        },
        {
            command: "preview_create_clickhouse_view",
            args: { profileId: "profile-1", target: createTarget },
            options: { silent: true },
        },
        {
            command: "create_clickhouse_view",
            args: { profileId: "profile-1", request: createRequest },
            options: undefined,
        },
        {
            command: "preview_change_clickhouse_view",
            args: { profileId: "profile-1", target: changeTarget },
            options: { silent: true },
        },
        {
            command: "execute_clickhouse_view_change",
            args: { profileId: "profile-1", request: changeRequest },
            options: undefined,
        },
        {
            command: "list_clickhouse_temporary_views",
            args: {
                profileId: "profile-1",
                ownerTabRuntimeId: "runtime-tab-1",
            },
            options: { silent: true },
        },
    ]);
});

test("View clients reject cross-family tags and invalid ownership before invoke", async () => {
    const transport = new FakeTransport();

    await expect(
        describeClickHouseViewSchema(transport, {
            profileId: "profile-1",
            request: {
                container: { ...viewContainer, kind: "table" },
                ownerTabRuntimeId: null,
            },
        }),
    ).rejects.toThrow();
    await expect(
        previewCreateClickHouseView(transport, {
            profileId: "profile-1",
            target: {
                ...createTarget,
                desired: {
                    ...createTarget.desired,
                    address: {
                        ...createTarget.desired.address,
                        objectKind: "table",
                    },
                },
            },
        }),
    ).rejects.toThrow();
    await expect(
        createClickHouseView(transport, {
            profileId: "profile-1",
            request: {
                ...createRequest,
                target: {
                    kind: "clickhouse_table",
                    target: null as never,
                },
            },
        }),
    ).rejects.toThrow();
    await expect(
        executeClickHouseViewChange(transport, {
            profileId: "profile-1",
            request: {
                ...changeRequest,
                target: {
                    kind: "clickhouse_table_drop",
                    target: null as never,
                },
            },
        }),
    ).rejects.toThrow();
    await expect(
        listClickHouseTemporaryViews(transport, {
            profileId: "profile-1",
            ownerTabRuntimeId: "   ",
        }),
    ).rejects.toThrow();

    expect(transport.calls).toEqual([]);
});
