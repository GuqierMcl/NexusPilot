// 必须与 `src-tauri/src/engine/types.rs` 保持同步。

import type { ErrorCode } from "@/types/ipc/errors";

export type SqlStatementAccess = "readOnly" | "direct";

export interface SqlExecutionFeatures {
    managedLifecycle: boolean;
    statementAccess: SqlStatementAccess;
    activeCancel: boolean;
    liveProgress: boolean;
    querySummary: boolean;
    rawResult: boolean;
    configurableTimeout: boolean;
}

export type SchemaMutationOperation =
    | "create"
    | "alter"
    | "rename"
    | "drop"
    | "clear"
    | "materialize";

export interface SchemaMutationObjectFeatures {
    kind: ContainerKind;
    operations: SchemaMutationOperation[];
}

export interface SchemaMutationFeatures {
    objects: SchemaMutationObjectFeatures[];
    ddlPreview: boolean;
    destructiveConfirmation: boolean;
    remoteDriftProtection: boolean;
}

export interface DriverCapabilities {
    schemaBrowser: boolean;
    schemaMutator: boolean;
    schemaMutation?: SchemaMutationFeatures;
    dataTableBrowser: boolean;
    tableRowMutator: boolean;
    tableRowInserter: boolean;
    transactionManager: boolean;
    sqlExecutor: boolean;
    sqlExecution?: SqlExecutionFeatures;
    keyValueBrowser: boolean;
    graphQueryer: boolean;
    vectorSearcher: boolean;
}

export interface ConnectionRuntimeInfo {
    profileId: string;
    driverName: string;
    capabilities: DriverCapabilities;
}

export type ContainerKind =
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

export type AssetGroupType =
    | "tables"
    | "views"
    | "materialized_views"
    | "functions"
    | "procedures"
    | "indexes"
    | "dictionaries"
    | "projections"
    | "triggers"
    | "sequences"
    | "extensions"
    | "events"
    | "collections"
    | "documents"
    | "fields"
    | "node_labels"
    | "relationship_types"
    | "vector_collections"
    | "partitions"
    | "search_indexes"
    | "data_streams"
    | "templates"
    | "mappings"
    | "constraints"
    | "columns";

export interface ContainerRef {
    kind: ContainerKind;
    groupType?: AssetGroupType | null;
    database?: string | null;
    schema?: string | null;
    table?: string | null;
    column?: string | null;
    objectName?: string | null;
    dbIndex?: number | null;
    key?: string | null;
    pattern?: string | null;
}

export interface ContainerProperty {
    key: string;
    label: string;
    value: string;
}

export interface DataContainer {
    id: string;
    name: string;
    kind: ContainerKind;
    isLeaf: boolean;
    container: ContainerRef;
    typeName?: string | null;
    nullable?: boolean | null;
    itemCount?: number | null;
    properties?: ContainerProperty[];
}

export type RuntimeHealthStatus = "healthy" | "degraded" | "error";

export interface RuntimeHealthSnapshot {
    profileId: string;
    status: RuntimeHealthStatus;
    consecutiveFailures: number;
    lastSuccessAtMs?: number | null;
    lastFailureAtMs?: number | null;
    lastErrorCode?: ErrorCode | null;
}

export interface ConnectionRuntimeSnapshot {
    profileId: string;
    runtime: ConnectionRuntimeInfo;
    health: RuntimeHealthSnapshot;
}

export type RuntimeChangeOrigin = "frontend" | "aiRuntime";

export type ConnectionRuntimeChangedEvent =
    | {
          kind: "upsert";
          origin: RuntimeChangeOrigin;
          snapshot: ConnectionRuntimeSnapshot;
      }
    | {
          kind: "removed";
          origin: RuntimeChangeOrigin;
          profileId: string;
      };

export interface CreateDatabaseInput {
    name: string;
    characterSet?: string | null;
}

export interface CreateDatabaseResult {
    name: string;
}

export interface SchemaMutationPreview {
    statements: string[];
    warnings?: string[];
    destructive?: boolean;
}

export interface UpdateDatabaseInput {
    container: ContainerRef;
    name?: string | null;
    comment?: string | null;
    tablespace?: string | null;
    characterSet?: string | null;
}

export interface UpdateDatabaseResult {
    oldName: string;
    name: string;
}

export interface DropDatabaseInput {
    container: ContainerRef;
}

export interface DropDatabaseResult {
    name: string;
}

export interface DropTableInput {
    container: ContainerRef;
    confirmDestructive?: boolean;
}

export interface DropTableResult {
    container: ContainerRef;
    tableName: string;
}

export interface DatabaseCharacterSet {
    name: string;
    description?: string | null;
    defaultCollation: string;
    maxlen: number;
}

export interface TableSchemaBasics {
    tableName: string;
    databaseName: string;
    schemaName: string;
    engine?: string | null;
    charset?: string | null;
    collation?: string | null;
    comment?: string | null;
    partition?: TablePartitionOptions | null;
}

export type TableIdentityGeneration = "always" | "by_default";

export interface TableIdentityOptions {
    generation: TableIdentityGeneration;
    start?: string | null;
    increment?: string | null;
    minValue?: string | null;
    maxValue?: string | null;
    cache?: string | null;
    cycle: boolean;
}

export type TableGeneratedColumnStorage = "virtual" | "stored";

export interface TableGeneratedColumn {
    expression: string;
    storage: TableGeneratedColumnStorage;
}

export interface TableColumnSchema {
    name: string;
    typeName: string;
    nullable: boolean;
    defaultValue?: string | null;
    isPrimaryKey: boolean;
    isUnique: boolean;
    isIdentity: boolean;
    comment?: string | null;
    identity?: TableIdentityOptions | null;
    generated?: TableGeneratedColumn | null;
    charset?: string | null;
    collation?: string | null;
}

export interface TableIndexSchema {
    name: string;
    columns: string[];
    isUnique: boolean;
    method?: string | null;
    comment?: string | null;
}

export type TableConstraintKind =
    | "primary_key"
    | "unique"
    | "foreign_key"
    | "check";

export type TableReferentialAction =
    | "no_action"
    | "restrict"
    | "cascade"
    | "set_null"
    | "set_default";

export interface TableForeignKeyReference {
    databaseName?: string | null;
    schemaName?: string | null;
    tableName: string;
    columns: string[];
    onUpdate?: TableReferentialAction | null;
    onDelete?: TableReferentialAction | null;
}

export interface TablePartitionOptions {
    expression?: string | null;
    rawClause?: string | null;
    readonlyDescription?: string | null;
}

export interface TableConstraintSchema {
    name: string;
    kind: TableConstraintKind;
    columns: string[];
    reference?: string | null;
    expression?: string | null;
    comment?: string | null;
    foreignKey?: TableForeignKeyReference | null;
    enforced?: boolean | null;
}

export interface TableSchema {
    basics: TableSchemaBasics;
    columns: TableColumnSchema[];
    indexes: TableIndexSchema[];
    constraints: TableConstraintSchema[];
}

export interface CreateTableInput {
    basics: TableSchemaBasics;
    columns: TableColumnSchema[];
    indexes: TableIndexSchema[];
    constraints: TableConstraintSchema[];
}

export interface CreateTableResult {
    container: ContainerRef;
    tableName: string;
}

export interface TableColumnRename {
    oldName: string;
    newName: string;
}

export interface UpdateTableInput {
    container: ContainerRef;
    baseline: TableSchema;
    target: TableSchema;
    columnRenames?: TableColumnRename[];
    confirmDestructive?: boolean;
}

export interface UpdateTableResult {
    container: ContainerRef;
    tableName: string;
}
