import {
    createClickHouseDatabase,
    defaultClickHouseSchemaTransport,
    previewCreateClickHouseDatabase,
    type ClickHouseSchemaTransport,
} from "@/lib/clickhouse-schema-client";
import {
    createDatabase,
    previewCreateDatabase,
} from "@/lib/tauri/schema-mutations";
import type {
    ClickHouseCreateDatabaseResult,
    ClickHouseCreateDatabaseTarget,
    CreateDatabaseInput,
    CreateDatabaseResult,
    NativeSchemaMutationPreview,
    SchemaMutationPreview,
} from "@/types/ipc";

export interface CreateDatabaseOperation<TInput, TPreview, TResult> {
    preview(profileId: string, input: TInput): Promise<TPreview>;
    execute(
        profileId: string,
        input: TInput,
        preview: TPreview,
    ): Promise<TResult>;
    getResultName(result: TResult): string;
}

interface RelationalCreateDatabaseDependencies {
    preview(
        profileId: string,
        input: CreateDatabaseInput,
    ): Promise<SchemaMutationPreview>;
    execute(
        profileId: string,
        input: CreateDatabaseInput,
    ): Promise<CreateDatabaseResult>;
}

export function createRelationalCreateDatabaseOperation(
    dependencies: RelationalCreateDatabaseDependencies = {
        preview: previewCreateDatabase,
        execute: createDatabase,
    },
): CreateDatabaseOperation<
    CreateDatabaseInput,
    SchemaMutationPreview,
    CreateDatabaseResult
> {
    return {
        preview: dependencies.preview,
        execute: (profileId, input) =>
            dependencies.execute(profileId, input),
        getResultName: (result) => result.name,
    };
}

export const relationalCreateDatabaseOperation =
    createRelationalCreateDatabaseOperation();

export function createClickHouseCreateDatabaseOperation(
    transport: ClickHouseSchemaTransport = defaultClickHouseSchemaTransport,
): CreateDatabaseOperation<
    ClickHouseCreateDatabaseTarget,
    NativeSchemaMutationPreview,
    ClickHouseCreateDatabaseResult
> {
    return {
        preview: (profileId, target) =>
            previewCreateClickHouseDatabase(transport, {
                profileId,
                target,
            }),
        execute: (profileId, target, preview) =>
            createClickHouseDatabase(transport, {
                profileId,
                request: {
                    target,
                    expectedPlanHash: preview.planHash,
                    confirmation: null,
                },
            }),
        getResultName: (result) => result.name,
    };
}

export const clickHouseCreateDatabaseOperation =
    createClickHouseCreateDatabaseOperation();

export async function submitCreateDatabaseWithFreshPreview<
    TInput,
    TPreview,
    TResult,
>(
    operation: CreateDatabaseOperation<TInput, TPreview, TResult>,
    profileId: string,
    input: TInput,
    isCurrent: () => boolean,
): Promise<TResult | null> {
    const freshPreview = await operation.preview(profileId, input);
    if (!isCurrent()) {
        return null;
    }
    return operation.execute(profileId, input, freshPreview);
}
