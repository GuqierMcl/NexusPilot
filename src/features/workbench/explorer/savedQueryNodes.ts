import type {
    ExplorerTreeNode,
    ExplorerTreeSavedQueryGroupNode,
} from "@/features/workbench/explorer/types";
import type { AnyExplorerDriverConfig } from "@/features/workbench/explorer/driver-configs/types";
import type { SavedQuery, SqlExecutionContext } from "@/types/saved-queries";

type NormalizedContext = {
    database: string | null;
    schema: string | null;
};

function normalizeContext(
    context?: SqlExecutionContext | null,
): NormalizedContext {
    return {
        database: context?.database?.trim() || null,
        schema: context?.schema?.trim() || null,
    };
}

function normalizeQueryContext(query: SavedQuery): NormalizedContext {
    return {
        database: query.databaseName?.trim() || null,
        schema: query.schemaName?.trim() || null,
    };
}

function queryMatchesContext(
    query: SavedQuery,
    context: SqlExecutionContext,
): boolean {
    const queryContext = normalizeQueryContext(query);
    const targetContext = normalizeContext(context);
    return (
        queryContext.database === targetContext.database &&
        queryContext.schema === targetContext.schema
    );
}

function savedQueryNode(profileId: string, query: SavedQuery): ExplorerTreeNode {
    return {
        id: `${profileId}::saved_query::${query.id}`,
        type: "saved_query",
        label: query.title,
        profileId,
        query,
        isLeaf: true,
    };
}

export function filterSavedQueriesForRemoteNode(
    node: ExplorerTreeNode,
    queries: SavedQuery[],
): SavedQuery[] {
    if (!("metadata" in node)) return [];

    const container = node.metadata.container;
    if (!container) return [];

    if (node.type === "schema") {
        return queries.filter((query) =>
            queryMatchesContext(query, {
                database: container.database ?? null,
                schema: container.schema ?? null,
            }),
        );
    }

    if (node.type === "database") {
        return queries.filter((query) =>
            queryMatchesContext(query, {
                database: container.database ?? null,
                schema: null,
            }),
        );
    }

    return [];
}

export function buildContextSavedQueryGroup(params: {
    profileId: string;
    parentNodeId: string;
    context: SqlExecutionContext;
    queries: SavedQuery[];
}): ExplorerTreeSavedQueryGroupNode {
    return {
        id: `${params.parentNodeId}::saved_queries`,
        type: "saved_query_group",
        label: "查询",
        profileId: params.profileId,
        context: normalizeContext(params.context),
        defaultExpanded: true,
        isLeaf: false,
        children: params.queries.map((query) =>
            savedQueryNode(params.profileId, query),
        ),
    };
}

export function buildSavedQueryGroupForRemoteNode(
    node: ExplorerTreeNode,
    queries: SavedQuery[],
    driverConfig?: AnyExplorerDriverConfig | null,
): ExplorerTreeSavedQueryGroupNode | null {
    if (!("metadata" in node) || !node.metadata.container) return null;
    if (node.type !== "database" && node.type !== "schema") return null;
    if (!shouldAttachSavedQueryGroupToRemoteNode(node, driverConfig)) {
        return null;
    }

    const container = node.metadata.container;
    return buildContextSavedQueryGroup({
        profileId: node.metadata.profileId,
        parentNodeId: node.id,
        context: {
            database: container.database ?? null,
            schema: node.type === "schema" ? container.schema ?? null : null,
        },
        queries: filterSavedQueriesForRemoteNode(node, queries),
    });
}

export function shouldAttachSavedQueryGroupToRemoteNode(
    node: ExplorerTreeNode,
    driverConfig?: AnyExplorerDriverConfig | null,
): boolean {
    if (!("metadata" in node) || !node.metadata.container) return false;
    if (node.type !== "database" && node.type !== "schema") return false;

    return driverConfig?.savedQueryContextLevels?.includes(node.type) ?? false;
}

export function buildUnscopedSavedQueryGroup(
    profileId: string,
    queries: SavedQuery[],
): ExplorerTreeSavedQueryGroupNode | null {
    const unscoped = queries.filter((query) => {
        const context = normalizeQueryContext(query);
        return context.database == null && context.schema == null;
    });
    if (unscoped.length === 0) return null;

    return {
        id: `${profileId}::saved_queries::unscoped`,
        type: "saved_query_group",
        label: "查询（未指定上下文）",
        profileId,
        context: { database: null, schema: null },
        defaultExpanded: true,
        isLeaf: false,
        children: unscoped.map((query) => savedQueryNode(profileId, query)),
    };
}
