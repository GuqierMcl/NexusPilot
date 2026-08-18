import {
    defaultClickHouseSchemaTransport,
    dropClickHouseDatabase,
    dropClickHouseTable,
    previewDropClickHouseDatabase,
    previewDropClickHouseTable,
    type ClickHouseSchemaTransport,
} from "@/lib/clickhouse-schema-client";
import {
    dropDatabase,
    dropTable,
    previewDropDatabase,
    previewDropTable,
} from "@/lib/tauri/schema-mutations";
import type {
    ClickHouseDropDatabaseResult,
    ClickHouseDropTableResult,
    ContainerRef,
    DropDatabaseInput,
    DropDatabaseResult,
    DropTableInput,
    DropTableResult,
    NativeSchemaChangePlan,
    SchemaMutationPreview,
} from "@/types/ipc";

export interface SchemaDropAppliedResult {
    name: string;
    container: ContainerRef;
}

export interface SchemaDropPreview {
    statements: string[];
}

export interface SchemaDropOperation<
    TTarget,
    TPreview extends SchemaDropPreview,
    TResult,
> {
    preview(profileId: string, target: TTarget): Promise<TPreview>;
    execute(
        profileId: string,
        target: TTarget,
        preview: TPreview,
        confirmDestructive: true,
    ): Promise<TResult>;
    toAppliedResult(result: TResult): SchemaDropAppliedResult | null;
}

interface RelationalTableDropDependencies {
    preview(
        profileId: string,
        input: DropTableInput,
    ): Promise<SchemaMutationPreview>;
    execute(profileId: string, input: DropTableInput): Promise<DropTableResult>;
}

interface RelationalDatabaseDropDependencies {
    preview(
        profileId: string,
        input: DropDatabaseInput,
    ): Promise<SchemaMutationPreview>;
    execute(
        profileId: string,
        input: DropDatabaseInput,
    ): Promise<DropDatabaseResult>;
}

export function createRelationalTableDropOperation(
    dependencies: RelationalTableDropDependencies = {
        preview: previewDropTable,
        execute: dropTable,
    },
): SchemaDropOperation<
    ContainerRef,
    SchemaMutationPreview,
    DropTableResult
> {
    return {
        preview: (profileId, container) =>
            dependencies.preview(profileId, { container }),
        execute: (profileId, container, _preview, confirmDestructive) =>
            dependencies.execute(profileId, {
                container,
                confirmDestructive,
            }),
        toAppliedResult: (result) => ({
            name: result.tableName,
            container: result.container,
        }),
    };
}

type RelationalDatabaseDropAdapterResult = SchemaDropAppliedResult;

export function createRelationalDatabaseDropOperation(
    dependencies: RelationalDatabaseDropDependencies = {
        preview: previewDropDatabase,
        execute: dropDatabase,
    },
): SchemaDropOperation<
    ContainerRef,
    SchemaMutationPreview,
    RelationalDatabaseDropAdapterResult
> {
    return {
        preview: (profileId, container) =>
            dependencies.preview(profileId, { container }),
        execute: async (profileId, container) => {
            const result = await dependencies.execute(profileId, { container });
            return { name: result.name, container };
        },
        toAppliedResult: (result) => result,
    };
}

export function createClickHouseTableDropOperation(
    transport: ClickHouseSchemaTransport = defaultClickHouseSchemaTransport,
): SchemaDropOperation<
    ContainerRef,
    NativeSchemaChangePlan,
    ClickHouseDropTableResult
> {
    return {
        preview: (profileId, container) =>
            previewDropClickHouseTable(transport, {
                profileId,
                target: { container },
            }),
        execute: (profileId, container, preview, confirmDestructive) =>
            dropClickHouseTable(transport, {
                profileId,
                request: {
                    target: {
                        kind: "clickhouse_table_drop",
                        target: { container },
                    },
                    baseline: preview.baseline,
                    expectedPlanHash: preview.planHash,
                    confirmation: confirmDestructive
                        ? {
                              accepted: true,
                              objectName: null,
                              clusterName: null,
                          }
                        : null,
                },
            }),
        toAppliedResult: (result) =>
            result.status === "applied" && result.absent
                ? { name: result.tableName, container: result.container }
                : null,
    };
}

export function createClickHouseDatabaseDropOperation(
    transport: ClickHouseSchemaTransport = defaultClickHouseSchemaTransport,
): SchemaDropOperation<
    ContainerRef,
    NativeSchemaChangePlan,
    ClickHouseDropDatabaseResult
> {
    return {
        preview: (profileId, container) =>
            previewDropClickHouseDatabase(transport, {
                profileId,
                target: { container },
            }),
        execute: (profileId, container, preview, confirmDestructive) =>
            dropClickHouseDatabase(transport, {
                profileId,
                request: {
                    target: {
                        kind: "clickhouse_database_drop",
                        target: { container },
                    },
                    baseline: preview.baseline,
                    expectedPlanHash: preview.planHash,
                    confirmation: confirmDestructive
                        ? {
                              accepted: true,
                              objectName: null,
                              clusterName: null,
                          }
                        : null,
                },
            }),
        toAppliedResult: (result) =>
            result.status === "applied" && result.absent
                ? { name: result.name, container: result.container }
                : null,
    };
}

export const relationalTableDropOperation =
    createRelationalTableDropOperation();
export const relationalDatabaseDropOperation =
    createRelationalDatabaseDropOperation();
export const clickHouseTableDropOperation =
    createClickHouseTableDropOperation();
export const clickHouseDatabaseDropOperation =
    createClickHouseDatabaseDropOperation();

export async function submitSchemaDropWithFreshPreview<
    TTarget,
    TPreview extends SchemaDropPreview,
    TResult,
>(
    operation: SchemaDropOperation<TTarget, TPreview, TResult>,
    profileId: string,
    target: TTarget,
    isCurrent: () => boolean,
): Promise<SchemaDropAppliedResult | null> {
    const freshPreview = await operation.preview(profileId, target);
    if (!isCurrent()) return null;
    const result = await operation.execute(
        profileId,
        target,
        freshPreview,
        true,
    );
    return operation.toAppliedResult(result);
}
