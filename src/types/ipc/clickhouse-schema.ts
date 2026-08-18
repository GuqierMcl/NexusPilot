import type { ContainerRef } from "./metadata";
import type {
    ClickHouseClusterViewBaseline,
    ClickHouseViewAlterTarget,
    ClickHouseViewChangeResult,
    ClickHouseViewCreateResult,
    ClickHouseViewCreateTarget,
    ClickHouseViewDropTarget,
    ClickHouseViewRenameTarget,
    ClickHouseViewSchema,
} from "./clickhouse-view-schema";

export type ClickHouseColumnDefaultKind =
    | "none"
    | "default"
    | "materialized"
    | "alias"
    | "ephemeral";

export type ClickHouseSchemaEditabilityMode =
    | "editable"
    | "restricted"
    | "readonly";

export interface ClickHouseSchemaBlocker {
    code: string;
    path: string;
    message: string;
}

export interface ClickHouseSchemaEditability {
    mode: ClickHouseSchemaEditabilityMode;
    blockers: ClickHouseSchemaBlocker[];
}

export interface ClickHouseTableIdentity {
    database: string;
    name: string;
    objectKind: "table";
    uuid: string | null;
}

export interface ClickHouseEngineSchema {
    family: string;
    arguments: string[];
    rawExpression: string;
}

export interface ClickHouseColumnSchema {
    name: string;
    typeName: string;
    position: number;
    defaultKind: ClickHouseColumnDefaultKind;
    defaultExpression: string | null;
    codecExpression: string | null;
    ttlExpression: string | null;
    comment: string | null;
    editability: ClickHouseSchemaEditability;
}

export interface ClickHouseKeySchema {
    orderBy: string;
    partitionBy: string | null;
    primaryKey: string | null;
    sampleBy: string | null;
}

export interface ClickHouseSettingSchema {
    name: string;
    value: string;
    explicit: boolean;
}

export interface ClickHouseProjectionSchema {
    name: string;
    query: string;
    editability: ClickHouseSchemaEditability;
}

export interface ClickHouseSkippingIndexSchema {
    name: string;
    expression: string;
    indexType: string;
    typeArguments: string[];
    granularity: number | null;
    editability: ClickHouseSchemaEditability;
}

export interface ClickHouseSchemaBaseline {
    canonicalCreateQuery: string;
    revisionHash: string;
}

export interface ClickHouseTableSchema {
    identity: ClickHouseTableIdentity;
    engine: ClickHouseEngineSchema;
    columns: ClickHouseColumnSchema[];
    keys: ClickHouseKeySchema;
    tableTtl: string | null;
    comment: string | null;
    settings: ClickHouseSettingSchema[];
    projections: ClickHouseProjectionSchema[];
    skippingIndexes: ClickHouseSkippingIndexSchema[];
    editability: ClickHouseSchemaEditability;
    baseline: ClickHouseSchemaBaseline;
}

export interface ClickHouseCodecTarget {
    name: string;
    arguments: string[];
}

export interface ClickHouseCreateColumnTarget {
    name: string;
    typeName: string;
    defaultKind: ClickHouseColumnDefaultKind;
    defaultExpression: string | null;
    codecs: ClickHouseCodecTarget[];
    ttlExpression: string | null;
    comment: string | null;
}

export interface ClickHouseCreateEngineTarget {
    family: string;
    arguments: string[];
}

export interface ClickHouseCreateSettingTarget {
    name: string;
    value: string;
}

export interface ClickHouseCreateDatabaseTarget {
    name: string;
}

export interface ClickHouseCreateTableTarget {
    database: string;
    name: string;
    columns: ClickHouseCreateColumnTarget[];
    engine: ClickHouseCreateEngineTarget;
    keys: ClickHouseKeySchema;
    tableTtl: string | null;
    comment: string | null;
    settings: ClickHouseCreateSettingTarget[];
}

export interface ClickHouseExecuteCreateDatabaseRequest {
    target: ClickHouseCreateDatabaseTarget;
    expectedPlanHash: string;
    confirmation: NativeSchemaConfirmationInput | null;
}

export interface ClickHouseExecuteCreateTableRequest {
    target: ClickHouseCreateTableTarget;
    expectedPlanHash: string;
    confirmation: NativeSchemaConfirmationInput | null;
}

export interface ClickHouseCreateDatabaseResult {
    name: string;
    container: ContainerRef;
}

export interface ClickHouseCreateTableResult {
    container: ContainerRef;
    tableName: string;
    schema: ClickHouseTableSchema;
}

export type NativeSchemaCreateTarget =
    | {
          kind: "clickhouse_database";
          target: ClickHouseCreateDatabaseTarget;
      }
    | {
          kind: "clickhouse_table";
          target: ClickHouseCreateTableTarget;
      }
    | {
          kind: "clickhouse_view";
          target: ClickHouseViewCreateTarget;
      };

export interface NativeSchemaExecuteCreateRequest {
    target: NativeSchemaCreateTarget;
    expectedPlanHash: string;
    confirmation: NativeSchemaConfirmationInput | null;
    baseline?: NativeSchemaChangeBaseline;
}

export type NativeSchemaRiskFlag =
    | "destructive"
    | "dataLoss"
    | "longRunning"
    | "backgroundWork"
    | "clusterNonAtomic"
    | "experimental"
    | "deprecated";

export type NativeSchemaRequiredConfirmation =
    | "none"
    | "confirm"
    | "typeObjectName"
    | "typeObjectAndCluster";

export interface NativeSchemaConfirmationInput {
    accepted: boolean;
    objectName: string | null;
    clusterName: string | null;
}

export type NativeSchemaBackgroundWorkKind =
    | "initialRefresh"
    | "populate"
    | "windowInitialization"
    | "distributedDdl";

export type NativeSchemaBackgroundWorkState =
    | "submitted"
    | "running"
    | "succeeded"
    | "failed"
    | "unknown";

export interface NativeSchemaBackgroundWork {
    kind: NativeSchemaBackgroundWorkKind;
    state: NativeSchemaBackgroundWorkState;
}

export interface NativeSchemaMutationPreview {
    statements: string[];
    warnings: string[];
    destructive: boolean;
    longRunning: boolean;
    riskFlags: NativeSchemaRiskFlag[];
    requiredConfirmation: NativeSchemaRequiredConfirmation;
    planHash: string;
    baseline?: NativeSchemaChangeBaseline;
}

export type NativeSchemaCreateResult =
    | {
          kind: "clickhouse_database";
          result: ClickHouseCreateDatabaseResult;
      }
    | {
          kind: "clickhouse_table";
          result: ClickHouseCreateTableResult;
      }
    | {
          kind: "clickhouse_view";
          result: ClickHouseViewCreateResult;
      };

export interface ClickHouseColumnRenameIntent {
    from: string;
    to: string;
}

export interface ClickHouseAlterTableTarget {
    baseline: ClickHouseTableSchema;
    desired: ClickHouseCreateTableTarget;
    columnRenames: ClickHouseColumnRenameIntent[];
}

export interface ClickHouseDropTableTarget {
    container: ContainerRef;
}

export interface ClickHouseDropDatabaseTarget {
    container: ContainerRef;
}

export interface ClickHouseColumnDataActionTarget {
    baseline: ClickHouseTableSchema;
    columnName: string;
}

export interface ClickHouseProjectionTarget {
    name: string;
    query: string;
}

export interface ClickHouseProjectionCreateTarget {
    baseline: ClickHouseTableSchema;
    projection: ClickHouseProjectionTarget;
}

export interface ClickHouseProjectionActionTarget {
    baseline: ClickHouseTableSchema;
    projectionName: string;
}

export interface ClickHouseSkippingIndexTarget {
    name: string;
    expression: string;
    indexType: string;
    typeArguments: string[];
    granularity: number;
}

export interface ClickHouseSkippingIndexCreateTarget {
    baseline: ClickHouseTableSchema;
    index: ClickHouseSkippingIndexTarget;
}

export interface ClickHouseSkippingIndexActionTarget {
    baseline: ClickHouseTableSchema;
    indexName: string;
}

export interface ClickHouseDatabaseObjectBaseline {
    name: string;
    engine: string;
    uuid: string | null;
    canonicalCreateQuery: string;
}

export interface ClickHouseDatabaseBaseline {
    name: string;
    engine: string;
    uuid: string | null;
    objects: ClickHouseDatabaseObjectBaseline[];
}

export type NativeSchemaExecutionStatus =
    | "applied"
    | "submitted"
    | "partiallyApplied"
    | "outcomeUnknown";

export interface NativeSchemaStatementProgress {
    appliedCount: number;
    failedStatementIndex: number | null;
    remainingCount: number;
    queryIds: string[];
}

export type NativeSchemaChangeTarget =
    | {
          kind: "clickhouse_table_alter";
          target: ClickHouseAlterTableTarget;
      }
    | {
          kind: "clickhouse_table_drop";
          target: ClickHouseDropTableTarget;
      }
    | {
          kind: "clickhouse_database_drop";
          target: ClickHouseDropDatabaseTarget;
      }
    | {
          kind: "clickhouse_column_clear";
          target: ClickHouseColumnDataActionTarget;
      }
    | {
          kind: "clickhouse_column_materialize";
          target: ClickHouseColumnDataActionTarget;
      }
    | {
          kind: "clickhouse_projection_create";
          target: ClickHouseProjectionCreateTarget;
      }
    | {
          kind: "clickhouse_projection_drop";
          target: ClickHouseProjectionActionTarget;
      }
    | {
          kind: "clickhouse_projection_materialize";
          target: ClickHouseProjectionActionTarget;
      }
    | {
          kind: "clickhouse_projection_clear";
          target: ClickHouseProjectionActionTarget;
      }
    | {
          kind: "clickhouse_skipping_index_create";
          target: ClickHouseSkippingIndexCreateTarget;
      }
    | {
          kind: "clickhouse_skipping_index_drop";
          target: ClickHouseSkippingIndexActionTarget;
      }
    | {
          kind: "clickhouse_skipping_index_materialize";
          target: ClickHouseSkippingIndexActionTarget;
      }
    | {
          kind: "clickhouse_skipping_index_clear";
          target: ClickHouseSkippingIndexActionTarget;
      }
    | {
          kind: "clickhouse_view_alter";
          target: ClickHouseViewAlterTarget;
      }
    | {
          kind: "clickhouse_view_rename";
          target: ClickHouseViewRenameTarget;
      }
    | {
          kind: "clickhouse_view_drop";
          target: ClickHouseViewDropTarget;
      };

export type NativeSchemaChangeBaseline =
    | {
          kind: "clickhouse_table";
          baseline: ClickHouseTableSchema;
      }
    | {
          kind: "clickhouse_database";
          baseline: ClickHouseDatabaseBaseline;
      }
    | {
          kind: "clickhouse_view";
          baseline: ClickHouseViewSchema;
      }
    | {
          kind: "clickhouse_cluster_view";
          baseline: ClickHouseClusterViewBaseline;
      };

export interface NativeSchemaOperationSummary {
    code: string;
    objectName: string;
    destructive: boolean;
    longRunning: boolean;
}

export interface NativeSchemaChangePlan {
    statements: string[];
    warnings: string[];
    destructive: boolean;
    longRunning: boolean;
    riskFlags: NativeSchemaRiskFlag[];
    requiredConfirmation: NativeSchemaRequiredConfirmation;
    planHash: string;
    expectedTargetRevision: string | null;
    operations: NativeSchemaOperationSummary[];
    baseline: NativeSchemaChangeBaseline;
}

export interface NativeSchemaExecuteChangeRequest {
    target: NativeSchemaChangeTarget;
    baseline: NativeSchemaChangeBaseline;
    expectedPlanHash: string;
    confirmation: NativeSchemaConfirmationInput | null;
}

export interface ClickHouseTableAlterResult {
    status: NativeSchemaExecutionStatus;
    progress: NativeSchemaStatementProgress;
    container: ContainerRef;
    tableName: string;
    schema: ClickHouseTableSchema | null;
}

export interface ClickHouseColumnActionResult {
    status: NativeSchemaExecutionStatus;
    progress: NativeSchemaStatementProgress;
    container: ContainerRef;
    columnName: string;
    operation: "clear" | "materialize";
    schema: ClickHouseTableSchema | null;
}

export type ClickHouseTableObjectOperation =
    | "create"
    | "drop"
    | "clear"
    | "materialize";

export interface ClickHouseProjectionChangeResult {
    status: NativeSchemaExecutionStatus;
    progress: NativeSchemaStatementProgress;
    container: ContainerRef;
    projectionName: string;
    operation: ClickHouseTableObjectOperation;
    schema: ClickHouseTableSchema | null;
}

export interface ClickHouseSkippingIndexChangeResult {
    status: NativeSchemaExecutionStatus;
    progress: NativeSchemaStatementProgress;
    container: ContainerRef;
    indexName: string;
    operation: ClickHouseTableObjectOperation;
    schema: ClickHouseTableSchema | null;
}

export interface ClickHouseDropTableResult {
    status: NativeSchemaExecutionStatus;
    progress: NativeSchemaStatementProgress;
    container: ContainerRef;
    tableName: string;
    absent: boolean;
}

export interface ClickHouseDropDatabaseResult {
    status: NativeSchemaExecutionStatus;
    progress: NativeSchemaStatementProgress;
    container: ContainerRef;
    name: string;
    absent: boolean;
}

export type NativeSchemaChangeResult =
    | {
          kind: "clickhouse_table_alter";
          result: ClickHouseTableAlterResult;
      }
    | {
          kind: "clickhouse_column_action";
          result: ClickHouseColumnActionResult;
      }
    | {
          kind: "clickhouse_table_drop";
          result: ClickHouseDropTableResult;
      }
    | {
          kind: "clickhouse_database_drop";
          result: ClickHouseDropDatabaseResult;
      }
    | {
          kind: "clickhouse_projection_change";
          result: ClickHouseProjectionChangeResult;
      }
    | {
          kind: "clickhouse_skipping_index_change";
          result: ClickHouseSkippingIndexChangeResult;
      }
    | {
          kind: "clickhouse_view_change";
          result: ClickHouseViewChangeResult;
      };
