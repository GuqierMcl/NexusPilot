import type { ComponentType, ReactNode, SVGProps } from "react";

import type { ExplorerNodeActionContributor } from "@/features/workbench/explorer/actions/types";
import type { ExplorerTreeNode } from "@/features/workbench/explorer/types";
import type { CreateDatabaseOperation } from "@/features/workbench/explorer/driver-configs/create-database-operations";
import type {
    SchemaDropOperation,
    SchemaDropPreview,
} from "@/features/workbench/explorer/driver-configs/schema-drop-operations";
import type {
    IClickHousePayload,
    IMysqlPayload,
    IOraclePayload,
    IPostgresPayload,
    IRedisPayload,
    ISqlitePayload,
} from "@/types";
import type { ContainerRef, DatabaseCharacterSet } from "@/types/ipc";

export type DatabaseCategory =
    | "rdbms"
    | "analytics"
    | "document"
    | "key-value"
    | "vector"
    | "graph"
    | "search";

export const DATABASE_CATEGORY_LABELS: Record<DatabaseCategory, string> = {
    rdbms: "关系型数据库",
    analytics: "分析型数据库",
    document: "文档型数据库",
    "key-value": "键值数据库",
    vector: "向量数据库",
    graph: "图数据库",
    search: "搜索引擎",
};

export type DriverContextMenuItem = {
    key: string;
    label: string;
    actionId: string;
    icon?: ComponentType<SVGProps<SVGSVGElement>>;
    disabled?: boolean;
};

export type DriverContextMenuGroup = {
    label: string;
    items: DriverContextMenuItem[];
};

export type DatabaseNameFormValue = {
    name: string;
};

export type MysqlCreateDatabaseFormValue = {
    name: string;
    characterSet: string;
};

export type MysqlEditDatabaseFormValue = {
    characterSet: string;
};

export type PostgresCreateDatabaseFormValue = {
    name: string;
};

export type PostgresEditDatabaseFormValue = {
    name: string;
    comment: string;
    tablespace: string;
};

export type DatabaseMutationContext = {
    connectionDriver: ImplementedDriver;
    connectionId: string;
    connectionName: string;
    node?: ExplorerTreeNode | null;
    characterSets?: DatabaseCharacterSet[];
    isCharacterSetsLoading?: boolean;
    currentDatabaseCharacterSet?: string | null;
    isCurrentDatabaseCharacterSetLoading?: boolean;
};

export type DatabaseMutationFormRenderProps<TValue> = {
    value: TValue;
    onChange: (value: TValue) => void;
    disabled?: boolean;
    context: DatabaseMutationContext;
};

export type DatabaseMutationFormSpec<TValue, TInput> = {
    createDefaultValue: (context: DatabaseMutationContext) => TValue;
    validate: (value: TValue, context: DatabaseMutationContext) => string | null;
    buildInput: (value: TValue, context: DatabaseMutationContext) => TInput;
    renderForm: (props: DatabaseMutationFormRenderProps<TValue>) => ReactNode;
};

export type CreateDatabaseFormSpec<
    TValue,
    TInput,
    TPreview,
    TResult,
> = DatabaseMutationFormSpec<TValue, TInput> & {
    operation: CreateDatabaseOperation<TInput, TPreview, TResult>;
};

export type EditDatabaseFormSpec<TValue, TInput> =
    DatabaseMutationFormSpec<TValue, TInput>;

/**
 * 物理连接模型类型。
 * 与 `src/types/connections.ts` 中的三大物理连接模型一一对应：
 * - `network`    → INetworkConfig（MySQL、Postgres、Redis 等网络直连型）
 * - `local-file` → ILocalFileConfig（SQLite 等本地文件型）
 * - `cloud-api`  → ICloudApiConfig（Pinecone、Qdrant Cloud 等云端 API 型）
 */
export type ConnectionModel = "network" | "local-file" | "cloud-api";

export type SavedQueryContextLevel = "database" | "schema";

export type ExplorerDriverTreeVisual = {
    icon: ComponentType<SVGProps<SVGSVGElement>>;
    iconClassName: string;
};

/**
 * 已实现驱动的配置值映射表。
 * 每个驱动的值为其对应的 Payload 类型（去掉 `driver` 判别字段，由外部提供）。
 * 新增驱动时只需在此处添加一行，并在对应配置文件中实现 ExplorerDriverConfig。
 */
export type DriverConfigValueMap = {
    clickhouse: Omit<IClickHousePayload, "driver">;
    mysql:    Omit<IMysqlPayload,    "driver">;
    postgres: Omit<IPostgresPayload, "driver">;
    oracle:   Omit<IOraclePayload,   "driver">;
    redis:    Omit<IRedisPayload,    "driver">;
    sqlite:   Omit<ISqlitePayload,   "driver">;
};

/** 已实现驱动的 driver key 集合（对 DbDriver 的子集） */
export type ImplementedDriver = keyof DriverConfigValueMap;

/** 所有已注册驱动的配置联合（避免用 `ExplorerDriverConfig` 默认泛参时 validate 参数逆变不兼容） */
export type AnyExplorerDriverConfig = {
    [K in ImplementedDriver]: ExplorerDriverConfig<K>;
}[ImplementedDriver];

export type ExplorerDriverConfig<
    TDriver extends ImplementedDriver = ImplementedDriver,
> = {
    driver: TDriver;
    displayName: string;
    pickerDescription: string;
    pickerIcon: ComponentType<SVGProps<SVGSVGElement>>;
    category: DatabaseCategory;
    treeVisual: ExplorerDriverTreeVisual;
    /**
     * 该驱动所属的物理连接模型。
     * 系统根据此字段自动注入对应的通用右键菜单条目（如"复制 Host"）。
     */
    connectionModel: ConnectionModel;
    /**
     * SQL 保存查询分组应挂载到的上下文层级。
     *
     * MySQL 使用 database 级查询组，PostgreSQL 使用 schema 级查询组。
     * 非 SQL 驱动应提供空数组或省略该字段。
     */
    savedQueryContextLevels?: SavedQueryContextLevel[];
    /**
     * Optional remote-node action contributors supplied by a driver.
     *
     * Built-in generic contributors cover common table, Redis, column, SQL,
     * and database-management actions. Drivers can append remote actions here
     * without editing the shared Explorer action builder.
     */
    remoteActionContributors?: ExplorerNodeActionContributor[];
    /**
     * 驱动独有的右键菜单条目（可选）。
     * 这些条目会追加在模型通用条目之后。
     * 若驱动无特殊菜单需求，可不填。
     */
    driverMenuItems?: DriverContextMenuItem[];
    createDatabase?: CreateDatabaseFormSpec<any, any, any, any>;
    editDatabase?: EditDatabaseFormSpec<any, any>;
    dropDatabase?: SchemaDropOperation<ContainerRef, SchemaDropPreview, any>;
    dropTable?: SchemaDropOperation<ContainerRef, SchemaDropPreview, any>;
    createDefaultConfig: () => DriverConfigValueMap[TDriver];
    validate: (config: DriverConfigValueMap[TDriver]) => string | null;
    renderForm: (props: {
        value: DriverConfigValueMap[TDriver];
        onChange: (value: DriverConfigValueMap[TDriver]) => void;
        disabled?: boolean;
    }) => ReactNode;
};
