import type { AssetGroupType, DataContainer } from "@/types/ipc";
import type {
    ExplorerTreeDatabaseNode,
    ExplorerTreeNode,
    ExplorerTreeRemoteEntityNode,
} from "@/features/workbench/explorer/types";

type RemoteContainerNodeType =
    | "asset_group"
    | "database"
    | "schema"
    | "table"
    | "view"
    | "materialized_view"
    | "function"
    | "procedure"
    | "trigger"
    | "index"
    | "dictionary"
    | "projection"
    | "sequence"
    | "extension"
    | "event"
    | "column"
    | "collection"
    | "document"
    | "field"
    | "node_label"
    | "relationship_type"
    | "vector_collection"
    | "partition"
    | "search_index"
    | "data_stream"
    | "mapping_field"
    | "redis_database"
    | "redis_key_prefix"
    | "redis_key";

const ASSET_GROUP_LABELS: Partial<Record<AssetGroupType, string>> = {
    tables: "表",
    views: "视图",
    materialized_views: "物化视图",
    functions: "函数",
    procedures: "存储过程",
    indexes: "索引",
    dictionaries: "字典",
    projections: "投影",
    triggers: "触发器",
    sequences: "序列",
    extensions: "扩展",
    events: "事件",
    collections: "集合",
    documents: "文档",
    fields: "字段",
    node_labels: "节点标签",
    relationship_types: "关系类型",
    vector_collections: "向量集合",
    partitions: "分区",
    search_indexes: "搜索索引",
    data_streams: "数据流",
    templates: "模板",
    mappings: "映射",
    constraints: "约束",
    columns: "列",
};

function nodeTypeFromContainer(
    container: DataContainer,
): RemoteContainerNodeType {
    switch (container.kind) {
        case "asset_group":
            return "asset_group";
        case "database":
            return "database";
        case "schema":
            return "schema";
        case "table":
            return "table";
        case "view":
            return "view";
        case "materialized_view":
            return "materialized_view";
        case "function":
            return "function";
        case "procedure":
            return "procedure";
        case "trigger":
            return "trigger";
        case "index":
            return "index";
        case "dictionary":
            return "dictionary";
        case "projection":
            return "projection";
        case "sequence":
            return "sequence";
        case "extension":
            return "extension";
        case "event":
            return "event";
        case "column":
            return "column";
        case "collection":
            return "collection";
        case "document":
            return "document";
        case "field":
            return "field";
        case "node_label":
            return "node_label";
        case "relationship_type":
            return "relationship_type";
        case "vector_collection":
            return "vector_collection";
        case "partition":
            return "partition";
        case "search_index":
            return "search_index";
        case "data_stream":
            return "data_stream";
        case "mapping_field":
            return "mapping_field";
        case "redis_database":
            return "redis_database";
        case "redis_key_prefix":
            return "redis_key_prefix";
        case "redis_key":
            return "redis_key";
        default:
            throw new Error(
                `Unsupported remote container kind: ${container.kind}`,
            );
    }
}

function buildLabel(container: DataContainer): string {
    if (container.kind === "asset_group") {
        const groupType = container.container.groupType;
        return groupType
            ? (ASSET_GROUP_LABELS[groupType] ?? container.name)
            : container.name;
    }
    if (container.kind === "column" && container.typeName) {
        return `${container.name}: ${container.typeName}${container.nullable ? "" : " NOT NULL"}`;
    }
    if (container.kind === "redis_key" && container.typeName) {
        return `${container.name} (${container.typeName})`;
    }
    return container.name;
}

export function buildRemoteNodes(
    profileId: string,
    containers: DataContainer[],
): ExplorerTreeNode[] {
    return containers.map((container) => {
        const type = nodeTypeFromContainer(container);
        const base = {
            id: `${profileId}::${container.id}`,
            label: buildLabel(container),
            metadata: {
                profileId,
                container: container.container,
                dbName:
                    container.container.database ??
                    (container.container.dbIndex != null
                        ? String(container.container.dbIndex)
                        : undefined),
                schemaName: container.container.schema ?? undefined,
                tableName: container.container.table ?? undefined,
                typeName: container.typeName ?? undefined,
                nullable: container.nullable ?? undefined,
                itemCount: container.itemCount ?? undefined,
                properties: container.properties?.map((property) => ({
                    ...property,
                })),
            },
            isLeaf: container.isLeaf,
        };

        if (type === "database" || type === "asset_group") {
            return {
                ...base,
                type,
            } satisfies ExplorerTreeDatabaseNode;
        }

        return {
            ...base,
            type,
        } satisfies ExplorerTreeRemoteEntityNode;
    });
}
