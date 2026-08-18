import type {
    ClickHouseViewFamily,
    ContainerRef,
    NativeSchemaExecutionStatus,
    RedisKeyRef,
    RedisKeyTreeRequest,
    RedisScanRequest,
    TableBrowseQuery,
} from "@/types/ipc";
import type { SqlExecutionContext } from "@/types/saved-queries";

// ─── 分页参数 ──────────────────────────────────────────────────────────────

export interface PaginationParams {
    page: number;
    pageSize: number;
    query?: TableBrowseQuery;
}

export interface SqlExecutionSnapshot {
    sql: string;
    context: SqlExecutionContext;
    page: number;
    pageSize: number;
}

export type ClickHouseTableObjectGroupType = "projections" | "indexes";

function containerKey(container?: ContainerRef | null): string {
    return container ? JSON.stringify(container) : "root";
}

// ─── Query Key 工厂 ───────────────────────────────────────────────────────

/**
 * 连接引擎的集中式 TanStack Query key 工厂。
 *
 * 所有 key 都共享 `["metadata", profileId, ...]` 前缀，因此
 * 可以通过 `queryClient.cancelQueries` + `removeQueries` 使用该前缀，在显式断开时
 * 取消并移除某个 profile 的所有远端缓存，避免失效查询意外重取数据。
 */
export const queryKeys = {
    aiRuntimeProviders: () => ["ai-runtime", "providers"] as const,
    aiRuntimeEnabledProviders: () =>
        ["ai-runtime", "providers", "enabled"] as const,
    aiRuntimeProvider: (providerId: string) =>
        ["ai-runtime", "providers", providerId] as const,
    aiRuntimeAvailableModels: () =>
        ["ai-runtime", "models", "available"] as const,
    aiRuntimeCatalogStatus: () =>
        ["ai-runtime", "catalog", "status"] as const,
    aiRuntimeAgentModes: () => ["ai-runtime", "agent-modes"] as const,
    aiRuntimeSettings: () => ["ai-runtime", "settings"] as const,

    /** 某个 profile 的所有 metadata key（便于批量失效处理）。 */
    profile: (profileId: string) => ["metadata", profileId] as const,

    /** 已连接 profile 下某个父容器的子容器列表。 */
    containers: (profileId: string, parent?: ContainerRef | null) =>
        ["metadata", profileId, "containers", containerKey(parent)] as const,

    savedQueries: (profileId: string) =>
        ["metadata", profileId, "savedQueries"] as const,

    /** 某张表的分页行数据（包含分页参数）。 */
    tableData: (
        profileId: string,
        tabRuntimeId: string,
        container: ContainerRef,
        params: PaginationParams,
    ) =>
        [
            "metadata",
            profileId,
            tabRuntimeId,
            "tableData",
            containerKey(container),
            params,
        ] as const,

    sqlExecution: (
        profileId: string,
        tabRuntimeId: string,
        snapshot: SqlExecutionSnapshot,
    ) =>
        ["metadata", profileId, tabRuntimeId, "sqlExecution", snapshot] as const,

    tableDesign: (
        profileId: string,
        tabRuntimeId: string,
        context?: ContainerRef | null,
    ) =>
        [
            "metadata",
            profileId,
            tabRuntimeId,
            "tableDesign",
            containerKey(context),
        ] as const,

    clickHouseTableDesign: (
        profileId: string,
        tabRuntimeId: string,
        container?: ContainerRef | null,
    ) =>
        [
            "metadata",
            profileId,
            tabRuntimeId,
            "clickHouseTableDesign",
            containerKey(container),
        ] as const,

    clickHouseTableChildren: (
        profileId: string,
        container: ContainerRef,
    ) =>
        [
            "metadata",
            profileId,
            "containers",
            containerKey(container),
        ] as const,

    clickHouseTableObjectGroup: (
        profileId: string,
        container: ContainerRef,
        groupType: ClickHouseTableObjectGroupType,
    ) =>
        [
            "metadata",
            profileId,
            "containers",
            containerKey({
                kind: "asset_group",
                groupType,
                database: container.database,
                table: container.table,
            }),
        ] as const,

    clickHouseViewSupport: (
        profileId: string,
        ownerTabRuntimeId: string | null,
        database: string | null,
        clusterRevision: string | null,
    ) =>
        [
            "metadata",
            profileId,
            ownerTabRuntimeId,
            "clickHouseViewSupport",
            database,
            clusterRevision,
        ] as const,

    clickHouseViewDesign: (
        profileId: string,
        ownerTabRuntimeId: string | null,
        scope: "local" | "cluster" | "temporary",
        family: ClickHouseViewFamily,
        container: ContainerRef,
        clusterRevision: string | null,
    ) =>
        [
            "metadata",
            profileId,
            ownerTabRuntimeId,
            "clickHouseViewDesign",
            scope,
            family,
            containerKey(container),
            clusterRevision,
        ] as const,

    clickHouseTemporaryViews: (
        profileId: string,
        ownerTabRuntimeId: string,
    ) =>
        [
            "metadata",
            profileId,
            ownerTabRuntimeId,
            "clickHouseTemporaryViews",
        ] as const,

    clickHouseViewGroup: (
        profileId: string,
        database: string,
        kind: "views" | "materialized_views",
    ) => ["metadata", profileId, "clickHouseViewGroup", database, kind] as const,

    clickHouseViewDependencies: (
        profileId: string,
        container: ContainerRef,
    ) =>
        [
            "metadata",
            profileId,
            "clickHouseViewDependencies",
            containerKey(container),
        ] as const,

    tableSchema: (profileId: string, context?: ContainerRef | null) =>
        [
            "metadata",
            profileId,
            "tableSchema",
            containerKey(context),
        ] as const,

    keyValues: (profileId: string, request: RedisScanRequest) =>
        ["metadata", profileId, "keyValues", request] as const,

    keyTree: (profileId: string, request: RedisKeyTreeRequest) =>
        ["metadata", profileId, "keyTree", request] as const,

    keyValue: (profileId: string, keyRef: RedisKeyRef | null) =>
        ["metadata", profileId, "keyValue", keyRef] as const,
} as const;

export interface ClickHouseViewInvalidationInput {
    profileId: string;
    ownerTabRuntimeId: string | null;
    scope: "local" | "cluster" | "temporary";
    family: ClickHouseViewFamily;
    clusterRevision: string | null;
    source: ContainerRef;
    destination?: ContainerRef | null;
    status: NativeSchemaExecutionStatus;
}

export function clickHouseViewMutationInvalidationKeys(
    input: ClickHouseViewInvalidationInput,
): ReadonlyArray<readonly unknown[]> {
    const destination = input.destination ?? null;
    const keys: Array<readonly unknown[]> = [
        queryKeys.clickHouseViewSupport(
            input.profileId,
            input.ownerTabRuntimeId,
            input.source.database ?? null,
            input.clusterRevision,
        ),
        queryKeys.clickHouseViewDesign(
            input.profileId,
            input.ownerTabRuntimeId,
            input.scope,
            input.family,
            input.source,
            input.clusterRevision,
        ),
    ];
    if (destination != null) {
        keys.push(
            queryKeys.clickHouseViewDesign(
                input.profileId,
                input.ownerTabRuntimeId,
                input.scope,
                input.family,
                destination,
                input.clusterRevision,
            ),
        );
    }
    if (input.status !== "applied") {
        return keys;
    }
    if (input.scope === "temporary" && input.ownerTabRuntimeId != null) {
        keys.push(
            queryKeys.clickHouseTemporaryViews(
                input.profileId,
                input.ownerTabRuntimeId,
            ),
        );
        return keys;
    }

    const groupKind =
        input.family === "materialized" ||
        input.family === "refreshable_materialized"
            ? "materialized_views"
            : "views";
    for (const container of [input.source, destination]) {
        if (container == null || typeof container.database !== "string") {
            continue;
        }
        keys.push(
            queryKeys.clickHouseViewGroup(
                input.profileId,
                container.database,
                groupKind,
            ),
            queryKeys.clickHouseViewDependencies(input.profileId, container),
        );
    }
    return keys;
}
