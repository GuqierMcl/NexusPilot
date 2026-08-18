import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { useContainers } from "@/hooks/queries/use-db-metadata";
import { apiInvoke } from "@/lib/api-client";
import { shouldRetryIpcError } from "@/lib/ipc-error";
import { queryKeys } from "@/lib/query-keys";
import { useConnectionSessionStore } from "@/store/slices/connection-session-slice";
import type {
    ContainerRef,
    DataContainer,
    IAppError,
    TableSchema,
} from "@/types/ipc";
import type { SqlExecutionContext } from "@/types/saved-queries";

import {
    buildSqlCompletionObjectsFromContainers,
    findSqlAssetGroup,
    type SqlCompletionColumn,
    type SqlCompletionObject,
} from "./sql-completion";
import {
    resolveSqlColumnCompletionTarget,
    toSqlColumnContainerRef,
} from "./sql-column-completion";

interface UseSqlCompletionMetadataInput {
    profileId: string;
    context: SqlExecutionContext;
    showSchema: boolean;
    databaseContainers?: DataContainer[];
    schemaContainers?: DataContainer[];
    sqlText?: string;
    cursorOffset?: number;
}

interface ResolveSqlCompletionObjectParentInput {
    context: SqlExecutionContext;
    showSchema: boolean;
    databaseContainers?: DataContainer[];
    schemaContainers?: DataContainer[];
}

export interface SqlCompletionMetadata {
    objects: SqlCompletionObject[];
    columns: SqlCompletionColumn[];
    isFetching: boolean;
}

export function resolveSqlCompletionObjectParent({
    context,
    showSchema,
    databaseContainers,
    schemaContainers,
}: ResolveSqlCompletionObjectParentInput): ContainerRef | null {
    if (showSchema) {
        return (
            schemaContainers?.find(
                (container) =>
                    container.kind === "schema" &&
                    container.container.database === context.database &&
                    container.container.schema === context.schema,
            )?.container ?? null
        );
    }

    return (
        databaseContainers?.find(
            (container) =>
                container.kind === "database" &&
                container.container.database === context.database,
        )?.container ?? null
    );
}

export function buildSqlColumnsFromTableSchema(params: {
    objectName: string;
    schema: TableSchema;
}): SqlCompletionColumn[] {
    return params.schema.columns.map((column) => ({
        name: column.name,
        typeName: column.typeName,
        nullable: column.nullable,
        objectName: params.objectName,
    }));
}

export function useSqlCompletionMetadata({
    profileId,
    context,
    showSchema,
    databaseContainers,
    schemaContainers,
    sqlText = "",
    cursorOffset = 0,
}: UseSqlCompletionMetadataInput): SqlCompletionMetadata {
    const status = useConnectionSessionStore((s) => s.sessions[profileId]?.status);
    const objectParent = useMemo(
        () =>
            resolveSqlCompletionObjectParent({
                context,
                showSchema,
                databaseContainers,
                schemaContainers,
            }),
        [context, databaseContainers, schemaContainers, showSchema],
    );
    const assetGroupQuery = useContainers(
        profileId,
        objectParent,
        objectParent != null,
    );
    const tableGroup = findSqlAssetGroup(assetGroupQuery.data, "tables");
    const viewGroup = findSqlAssetGroup(assetGroupQuery.data, "views");
    const materializedViewGroup = findSqlAssetGroup(
        assetGroupQuery.data,
        "materialized_views",
    );
    const tableQuery = useContainers(
        profileId,
        tableGroup?.container ?? null,
        tableGroup != null,
    );
    const viewQuery = useContainers(
        profileId,
        viewGroup?.container ?? null,
        viewGroup != null,
    );
    const materializedViewQuery = useContainers(
        profileId,
        materializedViewGroup?.container ?? null,
        materializedViewGroup != null,
    );
    const objects = useMemo(
        () => [
            ...buildSqlCompletionObjectsFromContainers(tableQuery.data),
            ...buildSqlCompletionObjectsFromContainers(viewQuery.data),
            ...buildSqlCompletionObjectsFromContainers(materializedViewQuery.data),
        ],
        [materializedViewQuery.data, tableQuery.data, viewQuery.data],
    );
    const columnTarget = useMemo(
        () =>
            resolveSqlColumnCompletionTarget({
                sqlText,
                cursorOffset,
                objects,
            }),
        [cursorOffset, objects, sqlText],
    );
    const columnContainer = useMemo(
        () => (columnTarget ? toSqlColumnContainerRef(columnTarget.object) : null),
        [columnTarget],
    );
    const columnQuery = useQuery<TableSchema, IAppError>({
        queryKey: queryKeys.tableSchema(profileId, columnContainer),
        queryFn: () =>
            apiInvoke<TableSchema>(
                "describe_table",
                { profileId, container: columnContainer },
                { silent: true },
            ),
        enabled: status === "connected" && columnContainer != null,
        staleTime: 60_000,
        retry: shouldRetryIpcError,
    });
    const columns = useMemo(
        () =>
            columnTarget && columnQuery.data
                ? buildSqlColumnsFromTableSchema({
                      objectName: columnTarget.object.name,
                      schema: columnQuery.data,
                  })
                : [],
        [columnQuery.data, columnTarget],
    );

    return {
        objects,
        columns,
        isFetching:
            assetGroupQuery.isFetching ||
            tableQuery.isFetching ||
            viewQuery.isFetching ||
            materializedViewQuery.isFetching ||
            columnQuery.isFetching,
    };
}
