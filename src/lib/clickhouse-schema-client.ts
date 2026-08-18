import { apiInvoke, type ApiInvokeOptions } from "@/lib/api-client";
import type {
    ClickHouseAlterTableTarget,
    ClickHouseColumnActionResult,
    ClickHouseCreateDatabaseResult,
    ClickHouseCreateDatabaseTarget,
    ClickHouseCreateTableResult,
    ClickHouseCreateTableTarget,
    ClickHouseExecuteCreateDatabaseRequest,
    ClickHouseExecuteCreateTableRequest,
    ClickHouseDropDatabaseResult,
    ClickHouseDropDatabaseTarget,
    ClickHouseDropTableResult,
    ClickHouseDropTableTarget,
    ClickHouseProjectionChangeResult,
    ClickHouseSkippingIndexChangeResult,
    ClickHouseTableAlterResult,
    ClickHouseTableSchema,
    ContainerRef,
    NativeSchemaChangePlan,
    NativeSchemaChangeTarget,
    NativeSchemaExecuteChangeRequest,
    NativeSchemaMutationPreview,
} from "@/types/ipc";

export interface ClickHouseSchemaTransport {
    invoke<T>(
        command: string,
        args: Record<string, unknown>,
        options?: ApiInvokeOptions,
    ): Promise<T>;
}

export interface DescribeClickHouseTableSchemaInput {
    profileId: string;
    container: ContainerRef;
}

export type ClickHouseTableSchemaContainer = ContainerRef & {
    kind: "table";
    database: string;
    table: string;
};

export function isClickHouseTableSchemaContainer(
    container: ContainerRef | null | undefined,
): container is ClickHouseTableSchemaContainer {
    return (
        container?.kind === "table" &&
        typeof container.database === "string" &&
        container.database.trim().length > 0 &&
        typeof container.table === "string" &&
        container.table.trim().length > 0
    );
}

export type ClickHouseDatabaseSchemaContainer = ContainerRef & {
    kind: "database";
    database: string;
};

export function isClickHouseDatabaseSchemaContainer(
    container: ContainerRef | null | undefined,
): container is ClickHouseDatabaseSchemaContainer {
    return (
        container?.kind === "database" &&
        typeof container.database === "string" &&
        container.database.trim().length > 0 &&
        container.groupType == null &&
        container.schema == null &&
        container.table == null &&
        container.column == null &&
        container.objectName == null &&
        container.dbIndex == null &&
        container.key == null &&
        container.pattern == null
    );
}

class TauriClickHouseSchemaTransport implements ClickHouseSchemaTransport {
    invoke<T>(
        command: string,
        args: Record<string, unknown>,
        options?: ApiInvokeOptions,
    ): Promise<T> {
        return apiInvoke<T>(command, args, options);
    }
}

export const defaultClickHouseSchemaTransport: ClickHouseSchemaTransport =
    new TauriClickHouseSchemaTransport();

export async function describeClickHouseTableSchema(
    transport: ClickHouseSchemaTransport,
    input: DescribeClickHouseTableSchemaInput,
): Promise<ClickHouseTableSchema> {
    const { container } = input;
    if (!isClickHouseTableSchemaContainer(container)) {
        throw new Error(
            "ClickHouse schema Describe requires a table with database and table ownership",
        );
    }

    return transport.invoke<ClickHouseTableSchema>(
        "describe_clickhouse_table_schema",
        {
            profileId: input.profileId,
            container,
        },
        { silent: true },
    );
}

export async function previewCreateClickHouseDatabase(
    transport: ClickHouseSchemaTransport,
    input: {
        profileId: string;
        target: ClickHouseCreateDatabaseTarget;
    },
): Promise<NativeSchemaMutationPreview> {
    return transport.invoke<NativeSchemaMutationPreview>(
        "preview_create_clickhouse_database",
        {
            profileId: input.profileId,
            target: input.target,
        },
        { silent: true },
    );
}

export async function createClickHouseDatabase(
    transport: ClickHouseSchemaTransport,
    input: {
        profileId: string;
        request: ClickHouseExecuteCreateDatabaseRequest;
    },
): Promise<ClickHouseCreateDatabaseResult> {
    return transport.invoke<ClickHouseCreateDatabaseResult>(
        "create_clickhouse_database",
        {
            profileId: input.profileId,
            request: input.request,
        },
    );
}

export async function previewCreateClickHouseTable(
    transport: ClickHouseSchemaTransport,
    input: {
        profileId: string;
        target: ClickHouseCreateTableTarget;
    },
): Promise<NativeSchemaMutationPreview> {
    return transport.invoke<NativeSchemaMutationPreview>(
        "preview_create_clickhouse_table",
        {
            profileId: input.profileId,
            target: input.target,
        },
        { silent: true },
    );
}

export async function createClickHouseTable(
    transport: ClickHouseSchemaTransport,
    input: {
        profileId: string;
        request: ClickHouseExecuteCreateTableRequest;
    },
): Promise<ClickHouseCreateTableResult> {
    return transport.invoke<ClickHouseCreateTableResult>(
        "create_clickhouse_table",
        {
            profileId: input.profileId,
            request: input.request,
        },
    );
}

export async function previewAlterClickHouseTable(
    transport: ClickHouseSchemaTransport,
    input: { profileId: string; target: ClickHouseAlterTableTarget },
): Promise<NativeSchemaChangePlan> {
    assertAlterTarget(input.target);
    return transport.invoke<NativeSchemaChangePlan>(
        "preview_alter_clickhouse_table",
        { profileId: input.profileId, target: input.target },
        { silent: true },
    );
}

export async function alterClickHouseTable(
    transport: ClickHouseSchemaTransport,
    input: { profileId: string; request: NativeSchemaExecuteChangeRequest },
): Promise<ClickHouseTableAlterResult> {
    if (
        input.request.target.kind !== "clickhouse_table_alter" ||
        input.request.baseline.kind !== "clickhouse_table"
    ) {
        throw new Error(
            "ClickHouse table alter requires a table alter target and table baseline",
        );
    }
    assertAlterTarget(input.request.target.target);
    return transport.invoke<ClickHouseTableAlterResult>(
        "alter_clickhouse_table",
        { profileId: input.profileId, request: input.request },
    );
}

export async function previewClickHouseColumnAction(
    transport: ClickHouseSchemaTransport,
    input: { profileId: string; target: NativeSchemaChangeTarget },
): Promise<NativeSchemaChangePlan> {
    assertColumnActionTarget(input.target);
    return transport.invoke<NativeSchemaChangePlan>(
        "preview_clickhouse_column_action",
        { profileId: input.profileId, target: input.target },
        { silent: true },
    );
}

export async function executeClickHouseColumnAction(
    transport: ClickHouseSchemaTransport,
    input: { profileId: string; request: NativeSchemaExecuteChangeRequest },
): Promise<ClickHouseColumnActionResult> {
    if (input.request.baseline.kind !== "clickhouse_table") {
        throw new Error("ClickHouse column action requires a table baseline");
    }
    assertColumnActionTarget(input.request.target);
    return transport.invoke<ClickHouseColumnActionResult>(
        "execute_clickhouse_column_action",
        { profileId: input.profileId, request: input.request },
    );
}

export async function previewClickHouseProjectionChange(
    transport: ClickHouseSchemaTransport,
    input: { profileId: string; target: NativeSchemaChangeTarget },
): Promise<NativeSchemaChangePlan> {
    assertProjectionChangeTarget(input.target);
    return transport.invoke<NativeSchemaChangePlan>(
        "preview_clickhouse_projection_change",
        { profileId: input.profileId, target: input.target },
        { silent: true },
    );
}

export async function executeClickHouseProjectionChange(
    transport: ClickHouseSchemaTransport,
    input: { profileId: string; request: NativeSchemaExecuteChangeRequest },
): Promise<ClickHouseProjectionChangeResult> {
    if (input.request.baseline.kind !== "clickhouse_table") {
        throw new Error("ClickHouse projection change requires a table baseline");
    }
    assertProjectionChangeTarget(input.request.target);
    return transport.invoke<ClickHouseProjectionChangeResult>(
        "execute_clickhouse_projection_change",
        { profileId: input.profileId, request: input.request },
    );
}

export async function previewClickHouseSkippingIndexChange(
    transport: ClickHouseSchemaTransport,
    input: { profileId: string; target: NativeSchemaChangeTarget },
): Promise<NativeSchemaChangePlan> {
    assertSkippingIndexChangeTarget(input.target);
    return transport.invoke<NativeSchemaChangePlan>(
        "preview_clickhouse_skipping_index_change",
        { profileId: input.profileId, target: input.target },
        { silent: true },
    );
}

export async function executeClickHouseSkippingIndexChange(
    transport: ClickHouseSchemaTransport,
    input: { profileId: string; request: NativeSchemaExecuteChangeRequest },
): Promise<ClickHouseSkippingIndexChangeResult> {
    if (input.request.baseline.kind !== "clickhouse_table") {
        throw new Error(
            "ClickHouse skipping-index change requires a table baseline",
        );
    }
    assertSkippingIndexChangeTarget(input.request.target);
    return transport.invoke<ClickHouseSkippingIndexChangeResult>(
        "execute_clickhouse_skipping_index_change",
        { profileId: input.profileId, request: input.request },
    );
}

export async function previewDropClickHouseTable(
    transport: ClickHouseSchemaTransport,
    input: { profileId: string; target: ClickHouseDropTableTarget },
): Promise<NativeSchemaChangePlan> {
    assertTableContainer(input.target.container, "table drop");
    return transport.invoke<NativeSchemaChangePlan>(
        "preview_drop_clickhouse_table",
        { profileId: input.profileId, target: input.target },
        { silent: true },
    );
}

export async function dropClickHouseTable(
    transport: ClickHouseSchemaTransport,
    input: { profileId: string; request: NativeSchemaExecuteChangeRequest },
): Promise<ClickHouseDropTableResult> {
    if (
        input.request.target.kind !== "clickhouse_table_drop" ||
        input.request.baseline.kind !== "clickhouse_table"
    ) {
        throw new Error(
            "ClickHouse table drop requires a table drop target and table baseline",
        );
    }
    assertTableContainer(input.request.target.target.container, "table drop");
    return transport.invoke<ClickHouseDropTableResult>(
        "drop_clickhouse_table",
        { profileId: input.profileId, request: input.request },
    );
}

export async function previewDropClickHouseDatabase(
    transport: ClickHouseSchemaTransport,
    input: { profileId: string; target: ClickHouseDropDatabaseTarget },
): Promise<NativeSchemaChangePlan> {
    assertDatabaseContainer(input.target.container);
    return transport.invoke<NativeSchemaChangePlan>(
        "preview_drop_clickhouse_database",
        { profileId: input.profileId, target: input.target },
        { silent: true },
    );
}

export async function dropClickHouseDatabase(
    transport: ClickHouseSchemaTransport,
    input: { profileId: string; request: NativeSchemaExecuteChangeRequest },
): Promise<ClickHouseDropDatabaseResult> {
    if (
        input.request.target.kind !== "clickhouse_database_drop" ||
        input.request.baseline.kind !== "clickhouse_database"
    ) {
        throw new Error(
            "ClickHouse database drop requires a database drop target and database baseline",
        );
    }
    assertDatabaseContainer(input.request.target.target.container);
    return transport.invoke<ClickHouseDropDatabaseResult>(
        "drop_clickhouse_database",
        { profileId: input.profileId, request: input.request },
    );
}

function assertAlterTarget(target: ClickHouseAlterTableTarget): void {
    assertSchemaOwnership(target.baseline, "table alter");
    if (
        target.desired.database !== target.baseline.identity.database ||
        target.desired.name !== target.baseline.identity.name
    ) {
        throw new Error(
            "ClickHouse table alter desired identity must match its baseline",
        );
    }
}

function assertColumnActionTarget(target: NativeSchemaChangeTarget): void {
    if (
        target.kind !== "clickhouse_column_clear" &&
        target.kind !== "clickhouse_column_materialize"
    ) {
        throw new Error(
            "ClickHouse column action requires a CLEAR or MATERIALIZE target",
        );
    }
    assertSchemaOwnership(target.target.baseline, "column action");
    if (target.target.columnName.trim().length === 0) {
        throw new Error("ClickHouse column action requires a column name");
    }
}

function assertProjectionChangeTarget(
    target: NativeSchemaChangeTarget,
): void {
    if (
        target.kind !== "clickhouse_projection_create" &&
        target.kind !== "clickhouse_projection_drop" &&
        target.kind !== "clickhouse_projection_materialize" &&
        target.kind !== "clickhouse_projection_clear"
    ) {
        throw new Error("ClickHouse projection change requires a projection target");
    }
    assertSchemaOwnership(target.target.baseline, "projection change");
    const name =
        target.kind === "clickhouse_projection_create"
            ? target.target.projection.name
            : target.target.projectionName;
    if (name.trim().length === 0) {
        throw new Error("ClickHouse projection change requires a projection name");
    }
}

function assertSkippingIndexChangeTarget(
    target: NativeSchemaChangeTarget,
): void {
    if (
        target.kind !== "clickhouse_skipping_index_create" &&
        target.kind !== "clickhouse_skipping_index_drop" &&
        target.kind !== "clickhouse_skipping_index_materialize" &&
        target.kind !== "clickhouse_skipping_index_clear"
    ) {
        throw new Error(
            "ClickHouse skipping-index change requires a skipping-index target",
        );
    }
    assertSchemaOwnership(target.target.baseline, "skipping-index change");
    const name =
        target.kind === "clickhouse_skipping_index_create"
            ? target.target.index.name
            : target.target.indexName;
    if (name.trim().length === 0) {
        throw new Error(
            "ClickHouse skipping-index change requires a skipping-index name",
        );
    }
}

function assertSchemaOwnership(
    schema: ClickHouseTableSchema,
    operation: string,
): void {
    assertTableContainer(
        {
            kind: schema.identity.objectKind,
            database: schema.identity.database,
            table: schema.identity.name,
        },
        operation,
    );
}

function assertTableContainer(container: ContainerRef, operation: string): void {
    if (!isClickHouseTableSchemaContainer(container) || container.schema != null) {
        throw new Error(
            `ClickHouse ${operation} requires a table with database and table ownership`,
        );
    }
}

function assertDatabaseContainer(container: ContainerRef): void {
    if (!isClickHouseDatabaseSchemaContainer(container)) {
        throw new Error(
            "ClickHouse database drop requires an exact database container",
        );
    }
}
