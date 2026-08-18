import {
    skipToken,
    useMutation,
    useQuery,
    useQueryClient,
    type QueryClient,
} from "@tanstack/react-query";

import { apiInvoke } from "@/lib/api-client";
import {
    alterClickHouseTable,
    createClickHouseDatabase,
    createClickHouseTable,
    defaultClickHouseSchemaTransport,
    describeClickHouseTableSchema,
    dropClickHouseDatabase,
    dropClickHouseTable,
    executeClickHouseColumnAction,
    executeClickHouseProjectionChange,
    executeClickHouseSkippingIndexChange,
    isClickHouseTableSchemaContainer,
    previewAlterClickHouseTable,
    previewClickHouseColumnAction,
    previewClickHouseProjectionChange,
    previewClickHouseSkippingIndexChange,
    previewCreateClickHouseDatabase,
    previewCreateClickHouseTable,
    previewDropClickHouseDatabase,
    previewDropClickHouseTable,
} from "@/lib/clickhouse-schema-client";
import {
    createClickHouseView,
    defaultClickHouseViewSchemaTransport,
    describeClickHouseViewSchema,
    executeClickHouseViewChange,
    getClickHouseViewRuntimeSupport,
    isClickHouseViewContainer,
    listClickHouseTemporaryViews,
    previewChangeClickHouseView,
    previewCreateClickHouseView,
} from "@/lib/clickhouse-view-schema-client";
import { shouldRetryIpcError } from "@/lib/ipc-error";
import {
    clickHouseViewMutationInvalidationKeys,
    queryKeys,
    type PaginationParams,
} from "@/lib/query-keys";
import { useConnectionSessionStore } from "@/store/slices/connection-session-slice";
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
    ClickHouseViewChangeResult,
    ClickHouseViewChangeTarget,
    ClickHouseViewCreateResult,
    ClickHouseViewCreateTarget,
    ClickHouseViewFamily,
    ClickHouseViewRuntimeSupport,
    ClickHouseViewSchema,
    ContainerRef,
    CreateTableInput,
    CreateTableResult,
    DataContainer,
    DropTableInput,
    DropTableResult,
    IAppError,
    NativeSchemaChangePlan,
    NativeSchemaChangeTarget,
    NativeSchemaExecuteChangeRequest,
    NativeSchemaExecuteCreateRequest,
    NativeSchemaBackgroundWork,
    NativeSchemaMutationPreview,
    QueryResult,
    RedisCreateKeyValueRequest,
    RedisDeleteKeyPrefixRequest,
    RedisDeleteKeyRequest,
    RedisDeleteKeyResult,
    RedisKeyRef,
    RedisKeyMutationResult,
    RedisRenameKeyRequest,
    RedisKeyTreeRequest,
    RedisKeyTreeResult,
    RedisKeyValue,
    RedisScanRequest,
    RedisScanResult,
    RedisSetKeyTtlRequest,
    RedisSetKeyValueRequest,
    SchemaMutationPreview,
    TableSchema,
    UpdateTableInput,
    UpdateTableResult,
} from "@/types/ipc";

// ─── useContainers ───────────────────────────────────────────────────────────

export function useContainers(
    profileId: string,
    parent?: ContainerRef | null,
    enabled = true,
) {
    const status = useConnectionSessionStore((s) => s.sessions[profileId]?.status);

    return useQuery<DataContainer[], IAppError>({
        queryKey: queryKeys.containers(profileId, parent),
        queryFn: () =>
            apiInvoke<DataContainer[]>(
                "list_containers",
                { profileId, parent: parent ?? null },
                { silent: true },
            ),
        enabled: enabled && status === "connected",
        staleTime: 60_000,
        retry: shouldRetryIpcError,
    });
}

// ─── useTableData ───────────────────────────────────────────────────────────

export function useTableData(
    profileId: string,
    tabRuntimeId: string,
    container: ContainerRef,
    params: PaginationParams,
) {
    const status = useConnectionSessionStore((s) => s.sessions[profileId]?.status);

    return useQuery<QueryResult, IAppError>({
        queryKey: queryKeys.tableData(profileId, tabRuntimeId, container, params),
        queryFn: () =>
            apiInvoke<QueryResult>(
                "browse_table_data",
                {
                    profileId,
                    tabId: tabRuntimeId,
                    container,
                    page: params.page,
                    pageSize: params.pageSize,
                    query: params.query,
                },
                { silent: true },
            ),
        enabled:
            status === "connected" &&
            (container.kind === "table" ||
                container.kind === "view" ||
                container.kind === "materialized_view"),
        staleTime: 10_000,
        retry: shouldRetryIpcError,
    });
}

export function useTableSchema(
    profileId: string,
    tabRuntimeId: string,
    container?: ContainerRef | null,
    enabled = true,
) {
    const status = useConnectionSessionStore((s) => s.sessions[profileId]?.status);
    const canFetch =
        enabled &&
        status === "connected" &&
        container != null &&
        container.kind === "table";

    return useQuery<TableSchema, IAppError>({
        queryKey: queryKeys.tableDesign(profileId, tabRuntimeId, container),
        queryFn: canFetch
            ? () =>
                  apiInvoke<TableSchema>(
                      "describe_table",
                      { profileId, container },
                      { silent: true },
                  )
            : skipToken,
        enabled: canFetch,
        staleTime: 30_000,
        retry: shouldRetryIpcError,
    });
}

export function useClickHouseTableSchema(
    profileId: string,
    tabRuntimeId: string,
    container?: ContainerRef | null,
    enabled = true,
) {
    const status = useConnectionSessionStore((s) => s.sessions[profileId]?.status);
    const canFetch =
        enabled &&
        status === "connected" &&
        isClickHouseTableSchemaContainer(container);

    return useQuery<ClickHouseTableSchema, IAppError>({
        queryKey: queryKeys.clickHouseTableDesign(
            profileId,
            tabRuntimeId,
            container,
        ),
        queryFn: canFetch
            ? () =>
                  describeClickHouseTableSchema(
                      defaultClickHouseSchemaTransport,
                      { profileId, container },
                  )
            : skipToken,
        enabled: canFetch,
        staleTime: 30_000,
        retry: shouldRetryIpcError,
    });
}

export function useClickHouseViewRuntimeSupport(
    profileId: string,
    database: string | null,
    ownerTabRuntimeId: string | null,
    clusterRevision: string | null,
    enabled = true,
) {
    const status = useConnectionSessionStore((s) => s.sessions[profileId]?.status);
    const canFetch =
        enabled &&
        status === "connected" &&
        (ownerTabRuntimeId == null || ownerTabRuntimeId.trim().length > 0);
    return useQuery<ClickHouseViewRuntimeSupport, IAppError>({
        queryKey: queryKeys.clickHouseViewSupport(
            profileId,
            ownerTabRuntimeId,
            database,
            clusterRevision,
        ),
        queryFn: canFetch
            ? () =>
                  getClickHouseViewRuntimeSupport(
                      defaultClickHouseViewSchemaTransport,
                      { profileId, database, ownerTabRuntimeId },
                  )
            : skipToken,
        enabled: canFetch,
        staleTime: 30_000,
        retry: shouldRetryIpcError,
    });
}

export interface UseClickHouseViewSchemaInput {
    profileId: string;
    ownerTabRuntimeId: string | null;
    scope: "local" | "cluster" | "temporary";
    family: ClickHouseViewFamily;
    container: ContainerRef | null;
    clusterRevision: string | null;
    backgroundWork?: NativeSchemaBackgroundWork | null;
    enabled?: boolean;
}

export function useClickHouseViewSchema(input: UseClickHouseViewSchemaInput) {
    const status = useConnectionSessionStore(
        (s) => s.sessions[input.profileId]?.status,
    );
    const temporaryOwnerValid =
        input.scope !== "temporary" ||
        (input.ownerTabRuntimeId != null &&
            input.ownerTabRuntimeId.trim().length > 0);
    const canFetch =
        (input.enabled ?? true) &&
        status === "connected" &&
        temporaryOwnerValid &&
        isClickHouseViewContainer(input.container);
    const container = isClickHouseViewContainer(input.container)
        ? input.container
        : null;
    return useQuery<ClickHouseViewSchema, IAppError>({
        queryKey: queryKeys.clickHouseViewDesign(
            input.profileId,
            input.ownerTabRuntimeId,
            input.scope,
            input.family,
            container ?? { kind: "view", table: "" },
            input.clusterRevision,
        ),
        queryFn: canFetch && container != null
            ? () =>
                  describeClickHouseViewSchema(
                      defaultClickHouseViewSchemaTransport,
                      {
                          profileId: input.profileId,
                          request: {
                              container,
                              ownerTabRuntimeId:
                                  input.scope === "temporary"
                                      ? input.ownerTabRuntimeId
                                      : null,
                          },
                      },
                  )
            : skipToken,
        enabled: canFetch,
        staleTime: 30_000,
        refetchInterval:
            input.backgroundWork?.state === "running" ? 2_000 : false,
        retry: shouldRetryIpcError,
    });
}

export function useClickHouseTemporaryViews(
    profileId: string,
    ownerTabRuntimeId: string,
    enabled = true,
) {
    const status = useConnectionSessionStore((s) => s.sessions[profileId]?.status);
    const canFetch =
        enabled &&
        status === "connected" &&
        ownerTabRuntimeId.trim().length > 0;
    return useQuery<ClickHouseViewSchema[], IAppError>({
        queryKey: queryKeys.clickHouseTemporaryViews(profileId, ownerTabRuntimeId),
        queryFn: canFetch
            ? () =>
                  listClickHouseTemporaryViews(
                      defaultClickHouseViewSchemaTransport,
                      { profileId, ownerTabRuntimeId },
                  )
            : skipToken,
        enabled: canFetch,
        staleTime: 5_000,
        retry: shouldRetryIpcError,
    });
}

export function usePreviewCreateClickHouseView(profileId: string) {
    return useMutation<
        NativeSchemaMutationPreview,
        IAppError,
        ClickHouseViewCreateTarget
    >({
        mutationFn: (target) =>
            previewCreateClickHouseView(defaultClickHouseViewSchemaTransport, {
                profileId,
                target,
            }),
    });
}

export function useCreateClickHouseView(profileId: string) {
    const queryClient = useQueryClient();
    return useMutation<
        ClickHouseViewCreateResult,
        IAppError,
        NativeSchemaExecuteCreateRequest
    >({
        mutationFn: (request) =>
            createClickHouseView(defaultClickHouseViewSchemaTransport, {
                profileId,
                request,
            }),
        onSuccess: (result, request) => {
            if (request.target.kind !== "clickhouse_view") {
                return;
            }
            const target = request.target.target.desired;
            invalidateClickHouseViewMutation(queryClient, {
                profileId,
                ownerTabRuntimeId: ownerFromTargetScope(target.scope),
                scope: target.scope.kind,
                family: target.family,
                clusterRevision:
                    request.baseline?.kind === "clickhouse_cluster_view"
                        ? request.baseline.baseline.topologyRevision
                        : null,
                source: viewContainer(target.address),
                destination: null,
                status: result.status,
            });
        },
    });
}

export function usePreviewChangeClickHouseView(profileId: string) {
    return useMutation<
        NativeSchemaChangePlan,
        IAppError,
        ClickHouseViewChangeTarget
    >({
        mutationFn: (target) =>
            previewChangeClickHouseView(defaultClickHouseViewSchemaTransport, {
                profileId,
                target,
            }),
    });
}

export function useExecuteClickHouseViewChange(profileId: string) {
    const queryClient = useQueryClient();
    return useMutation<
        ClickHouseViewChangeResult,
        IAppError,
        NativeSchemaExecuteChangeRequest
    >({
        mutationFn: (request) =>
            executeClickHouseViewChange(defaultClickHouseViewSchemaTransport, {
                profileId,
                request,
            }),
        onSuccess: (result, request) => {
            const context = viewChangeInvalidationContext(profileId, request);
            if (context == null) {
                return;
            }
            invalidateClickHouseViewMutation(queryClient, {
                ...context,
                destination: result.destination,
                status: result.status,
            });
        },
        onError: (error, request) => {
            if (error.code !== "RESOURCE_CONFLICT") {
                return;
            }
            const context = viewChangeInvalidationContext(profileId, request);
            if (context != null) {
                invalidateClickHouseViewMutation(queryClient, {
                    ...context,
                    status: "outcomeUnknown",
                });
            }
        },
    });
}

function ownerFromTargetScope(
    scope: ClickHouseViewCreateTarget["desired"]["scope"],
): string | null {
    return scope.kind === "temporary" ? scope.value.ownerTabRuntimeId : null;
}

function viewContainer(address: {
    database: string | null;
    name: string;
    objectKind: ContainerRef["kind"];
}): ContainerRef {
    return {
        kind: address.objectKind,
        database: address.database ?? undefined,
        table: address.name,
    };
}

function viewChangeInvalidationContext(
    profileId: string,
    request: NativeSchemaExecuteChangeRequest,
) {
    const target = request.target;
    if (
        target.kind !== "clickhouse_view_alter" &&
        target.kind !== "clickhouse_view_rename" &&
        target.kind !== "clickhouse_view_drop"
    ) {
        return null;
    }
    const baseline = target.target.baseline;
    return {
        profileId,
        ownerTabRuntimeId:
            baseline.scope.kind === "temporary"
                ? baseline.scope.value.ownerTabRuntimeId
                : null,
        scope: baseline.scope.kind,
        family: baseline.family,
        clusterRevision:
            request.baseline.kind === "clickhouse_cluster_view"
                ? request.baseline.baseline.topologyRevision
                : null,
        source: viewContainer(baseline.identity.address),
        destination:
            target.kind === "clickhouse_view_rename"
                ? viewContainer(target.target.destination)
                : null,
    } as const;
}

function invalidateClickHouseViewMutation(
    queryClient: QueryClient,
    input: Parameters<typeof clickHouseViewMutationInvalidationKeys>[0],
): void {
    for (const queryKey of clickHouseViewMutationInvalidationKeys(input)) {
        void queryClient.invalidateQueries({ queryKey });
    }
    if (input.status !== "applied") {
        return;
    }
    const containers = [input.source, input.destination].filter(
        (container): container is ContainerRef => container != null,
    );
    for (const container of containers) {
        const database = container.database;
        if (typeof database === "string" && database.trim().length > 0) {
            const groupType =
                input.family === "materialized" ||
                input.family === "refreshable_materialized"
                    ? "materialized_views"
                    : "views";
            void queryClient.invalidateQueries({
                queryKey: queryKeys.containers(input.profileId, {
                    kind: "asset_group",
                    groupType,
                    database,
                }),
            });
        }
    }
    const containerKeys = new Set(containers.map((container) => JSON.stringify(container)));
    void queryClient.invalidateQueries({
        predicate: (query) => {
            const key = query.queryKey;
            return (
                key[0] === "metadata" &&
                key[1] === input.profileId &&
                key[3] === "tableData" &&
                typeof key[4] === "string" &&
                containerKeys.has(key[4])
            );
        },
    });
}

export function usePreviewCreateClickHouseDatabase(profileId: string) {
    return useMutation<
        NativeSchemaMutationPreview,
        IAppError,
        ClickHouseCreateDatabaseTarget
    >({
        mutationFn: (target) =>
            previewCreateClickHouseDatabase(defaultClickHouseSchemaTransport, {
                profileId,
                target,
            }),
    });
}

export function useCreateClickHouseDatabase(profileId: string) {
    return useMutation<
        ClickHouseCreateDatabaseResult,
        IAppError,
        ClickHouseExecuteCreateDatabaseRequest
    >({
        mutationFn: (request) =>
            createClickHouseDatabase(defaultClickHouseSchemaTransport, {
                profileId,
                request,
            }),
    });
}

export function usePreviewCreateClickHouseTable(profileId: string) {
    return useMutation<
        NativeSchemaMutationPreview,
        IAppError,
        ClickHouseCreateTableTarget
    >({
        mutationFn: (target) =>
            previewCreateClickHouseTable(defaultClickHouseSchemaTransport, {
                profileId,
                target,
            }),
    });
}

export function useCreateClickHouseTable(profileId: string) {
    return useMutation<
        ClickHouseCreateTableResult,
        IAppError,
        ClickHouseExecuteCreateTableRequest
    >({
        mutationFn: (request) =>
            createClickHouseTable(defaultClickHouseSchemaTransport, {
                profileId,
                request,
            }),
    });
}

export function usePreviewAlterClickHouseTable(profileId: string) {
    return useMutation<
        NativeSchemaChangePlan,
        IAppError,
        ClickHouseAlterTableTarget
    >({
        mutationFn: (target) =>
            previewAlterClickHouseTable(defaultClickHouseSchemaTransport, {
                profileId,
                target,
            }),
    });
}

export function useAlterClickHouseTable(
    profileId: string,
    tabRuntimeId: string,
    container: ContainerRef,
) {
    const queryClient = useQueryClient();
    const queryKey = queryKeys.clickHouseTableDesign(
        profileId,
        tabRuntimeId,
        container,
    );
    return useMutation<
        ClickHouseTableAlterResult,
        IAppError,
        NativeSchemaExecuteChangeRequest
    >({
        mutationFn: (request) =>
            alterClickHouseTable(defaultClickHouseSchemaTransport, {
                profileId,
                request,
            }),
        onSuccess: (result) => {
            if (result.status === "applied" && result.schema != null) {
                queryClient.setQueryData<ClickHouseTableSchema>(
                    queryKey,
                    result.schema,
                );
                return;
            }
            void queryClient.invalidateQueries({ queryKey });
        },
    });
}

export function usePreviewClickHouseColumnAction(profileId: string) {
    return useMutation<
        NativeSchemaChangePlan,
        IAppError,
        NativeSchemaChangeTarget
    >({
        mutationFn: (target) =>
            previewClickHouseColumnAction(defaultClickHouseSchemaTransport, {
                profileId,
                target,
            }),
    });
}

export function useExecuteClickHouseColumnAction(
    profileId: string,
    tabRuntimeId: string,
    container: ContainerRef,
) {
    const queryClient = useQueryClient();
    const queryKey = queryKeys.clickHouseTableDesign(
        profileId,
        tabRuntimeId,
        container,
    );
    return useMutation<
        ClickHouseColumnActionResult,
        IAppError,
        NativeSchemaExecuteChangeRequest
    >({
        mutationFn: (request) =>
            executeClickHouseColumnAction(defaultClickHouseSchemaTransport, {
                profileId,
                request,
            }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey });
        },
    });
}

export function usePreviewClickHouseProjectionChange(profileId: string) {
    return useMutation<
        NativeSchemaChangePlan,
        IAppError,
        NativeSchemaChangeTarget
    >({
        mutationFn: (target) =>
            previewClickHouseProjectionChange(
                defaultClickHouseSchemaTransport,
                { profileId, target },
            ),
    });
}

export function useExecuteClickHouseProjectionChange(
    profileId: string,
    tabRuntimeId: string,
    container: ContainerRef,
) {
    const queryClient = useQueryClient();
    return useMutation<
        ClickHouseProjectionChangeResult,
        IAppError,
        NativeSchemaExecuteChangeRequest
    >({
        mutationFn: (request) =>
            executeClickHouseProjectionChange(
                defaultClickHouseSchemaTransport,
                { profileId, request },
            ),
        onSuccess: (result) => {
            invalidateClickHouseTableObjectQueries(
                queryClient,
                profileId,
                tabRuntimeId,
                container,
                "projections",
                result.status === "applied" &&
                    (result.operation === "create" ||
                        result.operation === "drop"),
            );
        },
        onError: (error) => {
            if (error.code === "RESOURCE_CONFLICT") {
                invalidateClickHouseTableObjectDescribe(
                    queryClient,
                    profileId,
                    tabRuntimeId,
                    container,
                );
            }
        },
    });
}

export function usePreviewClickHouseSkippingIndexChange(profileId: string) {
    return useMutation<
        NativeSchemaChangePlan,
        IAppError,
        NativeSchemaChangeTarget
    >({
        mutationFn: (target) =>
            previewClickHouseSkippingIndexChange(
                defaultClickHouseSchemaTransport,
                { profileId, target },
            ),
    });
}

export function useExecuteClickHouseSkippingIndexChange(
    profileId: string,
    tabRuntimeId: string,
    container: ContainerRef,
) {
    const queryClient = useQueryClient();
    return useMutation<
        ClickHouseSkippingIndexChangeResult,
        IAppError,
        NativeSchemaExecuteChangeRequest
    >({
        mutationFn: (request) =>
            executeClickHouseSkippingIndexChange(
                defaultClickHouseSchemaTransport,
                { profileId, request },
            ),
        onSuccess: (result) => {
            invalidateClickHouseTableObjectQueries(
                queryClient,
                profileId,
                tabRuntimeId,
                container,
                "indexes",
                result.status === "applied" &&
                    (result.operation === "create" ||
                        result.operation === "drop"),
            );
        },
        onError: (error) => {
            if (error.code === "RESOURCE_CONFLICT") {
                invalidateClickHouseTableObjectDescribe(
                    queryClient,
                    profileId,
                    tabRuntimeId,
                    container,
                );
            }
        },
    });
}

function invalidateClickHouseTableObjectDescribe(
    queryClient: QueryClient,
    profileId: string,
    tabRuntimeId: string,
    container: ContainerRef,
): void {
    void queryClient.invalidateQueries({
        queryKey: queryKeys.clickHouseTableDesign(
            profileId,
            tabRuntimeId,
            container,
        ),
    });
}

function invalidateClickHouseTableObjectQueries(
    queryClient: QueryClient,
    profileId: string,
    tabRuntimeId: string,
    container: ContainerRef,
    groupType: "projections" | "indexes",
    refreshExplorer: boolean,
): void {
    invalidateClickHouseTableObjectDescribe(
        queryClient,
        profileId,
        tabRuntimeId,
        container,
    );
    if (!refreshExplorer) {
        return;
    }
    void queryClient.invalidateQueries({
        queryKey: queryKeys.clickHouseTableObjectGroup(
            profileId,
            container,
            groupType,
        ),
    });
    void queryClient.invalidateQueries({
        queryKey: queryKeys.clickHouseTableChildren(profileId, container),
    });
}

export function usePreviewDropClickHouseTable(profileId: string) {
    return useMutation<
        NativeSchemaChangePlan,
        IAppError,
        ClickHouseDropTableTarget
    >({
        mutationFn: (target) =>
            previewDropClickHouseTable(defaultClickHouseSchemaTransport, {
                profileId,
                target,
            }),
    });
}

export function useDropClickHouseTable(profileId: string) {
    const queryClient = useQueryClient();
    return useMutation<
        ClickHouseDropTableResult,
        IAppError,
        NativeSchemaExecuteChangeRequest
    >({
        mutationFn: (request) =>
            dropClickHouseTable(defaultClickHouseSchemaTransport, {
                profileId,
                request,
            }),
        onSuccess: (result) => {
            const database = result.container.database;
            const queryKey =
                typeof database === "string" && database.trim().length > 0
                    ? queryKeys.containers(profileId, {
                          kind: "database",
                          database,
                      })
                    : queryKeys.profile(profileId);
            void queryClient.invalidateQueries({ queryKey });
        },
    });
}

export function usePreviewDropClickHouseDatabase(profileId: string) {
    return useMutation<
        NativeSchemaChangePlan,
        IAppError,
        ClickHouseDropDatabaseTarget
    >({
        mutationFn: (target) =>
            previewDropClickHouseDatabase(defaultClickHouseSchemaTransport, {
                profileId,
                target,
            }),
    });
}

export function useDropClickHouseDatabase(profileId: string) {
    const queryClient = useQueryClient();
    return useMutation<
        ClickHouseDropDatabaseResult,
        IAppError,
        NativeSchemaExecuteChangeRequest
    >({
        mutationFn: (request) =>
            dropClickHouseDatabase(defaultClickHouseSchemaTransport, {
                profileId,
                request,
            }),
        onSuccess: () => {
            void queryClient.invalidateQueries({
                queryKey: queryKeys.containers(profileId, null),
            });
        },
    });
}

export function usePreviewCreateTable(profileId: string) {
    return useMutation<SchemaMutationPreview, IAppError, CreateTableInput>({
        mutationFn: (input) =>
            apiInvoke<SchemaMutationPreview>(
                "preview_create_table",
                { profileId, input },
                { silent: true },
            ),
    });
}

export function useCreateTable(profileId: string) {
    return useMutation<CreateTableResult, IAppError, CreateTableInput>({
        mutationFn: (input) =>
            apiInvoke<CreateTableResult>("create_table", {
                profileId,
                input,
            }),
    });
}

export function usePreviewUpdateTable(profileId: string) {
    return useMutation<SchemaMutationPreview, IAppError, UpdateTableInput>({
        mutationFn: (input) =>
            apiInvoke<SchemaMutationPreview>(
                "preview_update_table",
                { profileId, input },
                { silent: true },
            ),
    });
}

export function useUpdateTable(profileId: string) {
    return useMutation<UpdateTableResult, IAppError, UpdateTableInput>({
        mutationFn: (input) =>
            apiInvoke<UpdateTableResult>("update_table", {
                profileId,
                input,
            }),
    });
}

export function usePreviewDropTable(profileId: string) {
    return useMutation<SchemaMutationPreview, IAppError, DropTableInput>({
        mutationFn: (input) =>
            apiInvoke<SchemaMutationPreview>(
                "preview_drop_table",
                { profileId, input },
                { silent: true },
            ),
    });
}

export function useDropTable(profileId: string) {
    return useMutation<DropTableResult, IAppError, DropTableInput>({
        mutationFn: (input) =>
            apiInvoke<DropTableResult>("drop_table", {
                profileId,
                input,
            }),
    });
}

// ─── Redis key-value hooks ───────────────────────────────────────────────────

export function useKeyValues(profileId: string, request: RedisScanRequest) {
    const status = useConnectionSessionStore((s) => s.sessions[profileId]?.status);

    return useQuery<RedisScanResult, IAppError>({
        queryKey: queryKeys.keyValues(profileId, request),
        queryFn: () =>
            apiInvoke<RedisScanResult>(
                "scan_key_values",
                { profileId, request },
                { silent: true },
            ),
        enabled: status === "connected",
        staleTime: 10_000,
        retry: shouldRetryIpcError,
    });
}

export function useKeyTree(profileId: string, request: RedisKeyTreeRequest) {
    const status = useConnectionSessionStore((s) => s.sessions[profileId]?.status);

    return useQuery<RedisKeyTreeResult, IAppError>({
        queryKey: queryKeys.keyTree(profileId, request),
        queryFn: () =>
            apiInvoke<RedisKeyTreeResult>(
                "browse_key_tree",
                { profileId, request },
                { silent: true },
            ),
        enabled: status === "connected",
        staleTime: 10_000,
        retry: shouldRetryIpcError,
    });
}

export function useKeyValue(profileId: string, keyRef: RedisKeyRef | null) {
    const status = useConnectionSessionStore((s) => s.sessions[profileId]?.status);
    const canFetchKeyValue =
        status === "connected" && keyRef != null && keyRef.key.length > 0;

    return useQuery<RedisKeyValue, IAppError>({
        queryKey: queryKeys.keyValue(profileId, keyRef),
        queryFn: canFetchKeyValue
            ? () =>
                  apiInvoke<RedisKeyValue>(
                      "get_key_value",
                      { profileId, keyRef },
                      { silent: true },
                  )
            : skipToken,
        enabled: canFetchKeyValue,
        staleTime: 5_000,
        retry: shouldRetryIpcError,
    });
}

export function useSetKeyValue(profileId: string) {
    return useMutation<RedisKeyMutationResult, IAppError, RedisSetKeyValueRequest>({
        mutationFn: (request) =>
            apiInvoke<RedisKeyMutationResult>("set_key_value", {
                profileId,
                request,
            }),
    });
}

export function useCreateKeyValue(profileId: string) {
    return useMutation<RedisKeyMutationResult, IAppError, RedisCreateKeyValueRequest>({
        mutationFn: (request) =>
            apiInvoke<RedisKeyMutationResult>("create_key_value", {
                profileId,
                request,
            }),
    });
}

export function useDeleteKey(profileId: string) {
    return useMutation<RedisDeleteKeyResult, IAppError, RedisDeleteKeyRequest>({
        mutationFn: (request) =>
            apiInvoke<RedisDeleteKeyResult>("delete_key", {
                profileId,
                request,
            }),
    });
}

export function useDeleteKeyPrefix(profileId: string) {
    return useMutation<RedisDeleteKeyResult, IAppError, RedisDeleteKeyPrefixRequest>({
        mutationFn: (request) =>
            apiInvoke<RedisDeleteKeyResult>("delete_key_prefix", {
                profileId,
                request,
            }),
    });
}

export function useRenameKey(profileId: string) {
    return useMutation<RedisKeyMutationResult, IAppError, RedisRenameKeyRequest>({
        mutationFn: (request) =>
            apiInvoke<RedisKeyMutationResult>("rename_key", {
                profileId,
                request,
            }),
    });
}

export function useSetKeyTtl(profileId: string) {
    return useMutation<RedisKeyMutationResult, IAppError, RedisSetKeyTtlRequest>({
        mutationFn: (request) =>
            apiInvoke<RedisKeyMutationResult>("set_key_ttl", {
                profileId,
                request,
            }),
    });
}
