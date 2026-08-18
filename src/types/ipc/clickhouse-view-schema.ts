import type {
    ClickHouseCreateEngineTarget,
    ClickHouseCreateSettingTarget,
    ClickHouseSchemaEditability,
    NativeSchemaBackgroundWork,
    NativeSchemaExecutionStatus,
    NativeSchemaStatementProgress,
} from "./clickhouse-schema";
import type { ErrorCode } from "./errors";
import type {
    ContainerKind,
    ContainerRef,
    SchemaMutationOperation,
} from "./metadata";

export type ClickHouseViewFamily =
    | "normal"
    | "parameterized"
    | "temporary"
    | "materialized"
    | "refreshable_materialized"
    | "window"
    | "live";

export type ClickHouseSupportState = "supported" | "unsupported" | "unknown";

export type ClickHouseTemporarySessionState = "active" | "expired";

export type ClickHouseViewScope =
    | { kind: "local" }
    | { kind: "cluster"; value: { clusterName: string } }
    | {
          kind: "temporary";
          value: {
              ownerTabRuntimeId: string;
              sessionState: ClickHouseTemporarySessionState;
          };
      };

export type ClickHouseViewScopeTarget =
    | { kind: "local" }
    | { kind: "cluster"; value: { clusterName: string } }
    | {
          kind: "temporary";
          value: { ownerTabRuntimeId: string };
      };

export interface ClickHouseViewAddress {
    database: string | null;
    name: string;
    objectKind: ContainerKind;
}

export interface ClickHouseViewDescribeRequest {
    container: ContainerRef;
    ownerTabRuntimeId: string | null;
}

export interface ClickHouseViewIdentity {
    address: ClickHouseViewAddress;
    uuid: string | null;
}

export interface ClickHouseViewTypedColumn {
    name: string;
    typeName: string;
}

export type ClickHouseViewColumnDefinition =
    | { kind: "none" }
    | { kind: "aliases"; value: string[] }
    | { kind: "typed"; value: ClickHouseViewTypedColumn[] };

export type ClickHouseViewDefiner =
    | { kind: "current_user" }
    | { kind: "named_user"; value: string };

export type ClickHouseViewSqlSecurity = "definer" | "invoker" | "none";

export interface ClickHouseViewSecurity {
    definer: ClickHouseViewDefiner | null;
    sqlSecurity: ClickHouseViewSqlSecurity | null;
}

export interface ClickHouseViewParameter {
    name: string;
    typeName: string;
    occurrences: number;
}

export type ClickHouseViewIntervalUnit =
    | "second"
    | "minute"
    | "hour"
    | "day"
    | "week"
    | "month"
    | "year";

export interface ClickHouseViewInterval {
    value: number;
    unit: ClickHouseViewIntervalUnit;
}

export type ClickHouseMaterializedStorage =
    | {
          kind: "to_table";
          value: { target: ContainerRef; targetColumns: string[] };
      }
    | {
          kind: "inner_table";
          value: {
              engine: ClickHouseCreateEngineTarget;
              orderBy: string;
              partitionBy: string | null;
              settings: ClickHouseCreateSettingTarget[];
          };
      };

export type ClickHouseRefreshMode = "every" | "after" | "dependsOnly";

export interface ClickHouseRefreshSettings {
    refreshRetries: number | null;
    refreshRetryInitialBackoffMs: number | null;
    refreshRetryMaxBackoffMs: number | null;
    allReplicas: boolean | null;
}

export interface ClickHouseRefreshDefinition {
    mode: ClickHouseRefreshMode;
    interval: ClickHouseViewInterval | null;
    offset: ClickHouseViewInterval | null;
    randomizeFor: ClickHouseViewInterval | null;
    dependencies: ClickHouseViewAddress[];
    settings: ClickHouseRefreshSettings;
}

export type ClickHouseWindowWatermark =
    | { kind: "none" }
    | { kind: "strictly_ascending" }
    | { kind: "ascending" }
    | { kind: "bounded"; value: ClickHouseViewInterval };

export type ClickHouseViewFamilyDefinition =
    | { kind: "normal" }
    | {
          kind: "parameterized";
          value: { parameters: ClickHouseViewParameter[] };
      }
    | { kind: "temporary" }
    | {
          kind: "materialized";
          value: { storage: ClickHouseMaterializedStorage; populate: boolean };
      }
    | {
          kind: "refreshable_materialized";
          value: {
              storage: ClickHouseMaterializedStorage;
              refresh: ClickHouseRefreshDefinition;
              append: boolean;
              empty: boolean;
          };
      }
    | {
          kind: "window";
          value: {
              destination: ContainerRef | null;
              innerEngine: string | null;
              resultEngine: string | null;
              watermark: ClickHouseWindowWatermark;
              allowedLateness: ClickHouseViewInterval | null;
              populate: boolean;
              timeWindowFunction: string;
          };
      }
    | {
          kind: "live";
          value: {
              timeoutSeconds: number | null;
              refreshSeconds: number | null;
              canonicalLegacyOptions: string[];
          };
      };

export interface ClickHouseViewSchema {
    identity: ClickHouseViewIdentity;
    family: ClickHouseViewFamily;
    scope: ClickHouseViewScope;
    columns: ClickHouseViewColumnDefinition;
    query: string;
    security: ClickHouseViewSecurity;
    comment: string | null;
    familyDefinition: ClickHouseViewFamilyDefinition;
    serverSupport: ClickHouseViewRuntimeSupport;
    editability: ClickHouseSchemaEditability;
    baseline: ClickHouseViewBaseline;
}

export interface ClickHouseViewDefinitionTarget {
    address: ClickHouseViewAddress;
    family: ClickHouseViewFamily;
    scope: ClickHouseViewScopeTarget;
    columns: ClickHouseViewColumnDefinition;
    query: string;
    security: ClickHouseViewSecurity;
    comment: string | null;
    familyDefinition: ClickHouseViewFamilyDefinition;
}

export interface ClickHouseViewBaseline {
    canonicalCreateQuery: string;
    revisionHash: string;
    serverVersion: string;
    family: ClickHouseViewFamily;
    supportRevision: string;
}

export interface ClickHouseViewOperationSupport {
    state: ClickHouseSupportState;
    reason: string | null;
}

export interface ClickHouseViewFamilySupport {
    describe: ClickHouseViewOperationSupport;
    create: ClickHouseViewOperationSupport;
    alter: ClickHouseViewOperationSupport;
    rename: ClickHouseViewOperationSupport;
    drop: ClickHouseViewOperationSupport;
}

export interface ClickHouseClusterDdlSupport {
    discoverable: boolean;
    executable: boolean;
    observable: boolean;
    driftVerifiable: boolean;
}

export interface ClickHouseViewRuntimeSupport {
    serverVersion: string;
    databaseEngine: string | null;
    normal: ClickHouseViewFamilySupport;
    parameterized: ClickHouseViewFamilySupport;
    temporary: ClickHouseViewFamilySupport;
    materialized: ClickHouseViewFamilySupport;
    refreshableMaterialized: ClickHouseViewFamilySupport;
    window: ClickHouseViewFamilySupport;
    live: ClickHouseViewFamilySupport;
    clusterDdl: ClickHouseClusterDdlSupport;
    supportRevision: string;
}

export type ClickHouseClusterObjectState = "absent" | "present" | "unknown";

export interface ClickHouseClusterViewBaseline {
    clusterName: string;
    topologyRevision: string;
    nodes: ClickHouseClusterViewNodeBaseline[];
}

export interface ClickHouseClusterViewNodeBaseline {
    nodeIdentityHash: string;
    shard: number;
    replica: number;
    reachable: boolean;
    objectState: ClickHouseClusterObjectState;
    family: ClickHouseViewFamily | null;
    revisionHash: string | null;
}

export type ClickHouseClusterNodeExecutionState =
    | "pending"
    | "applied"
    | "failed"
    | "unreachable"
    | "unknown";

export interface ClickHouseClusterExecutionOutcome {
    clusterName: string;
    expectedNodes: number;
    observedNodes: number;
    nodes: ClickHouseClusterExecutionNode[];
}

export interface ClickHouseClusterExecutionNode {
    nodeIdentityHash: string;
    shard: number;
    replica: number;
    state: ClickHouseClusterNodeExecutionState;
    errorCode: ErrorCode | null;
}

export interface ClickHouseViewCreateTarget {
    desired: ClickHouseViewDefinitionTarget;
    expectedSupportRevision: string;
}

export interface ClickHouseViewAlterTarget {
    baseline: ClickHouseViewSchema;
    desired: ClickHouseViewDefinitionTarget;
    expectedSupportRevision: string;
}

export interface ClickHouseViewRenameTarget {
    baseline: ClickHouseViewSchema;
    destination: ClickHouseViewAddress;
    expectedDestinationAbsenceRevision: string;
    expectedSupportRevision: string;
}

export interface ClickHouseViewDropTarget {
    baseline: ClickHouseViewSchema;
    expectedSupportRevision: string;
}

export type ClickHouseViewChangeTarget =
    | { kind: "alter"; target: ClickHouseViewAlterTarget }
    | { kind: "rename"; target: ClickHouseViewRenameTarget }
    | { kind: "drop"; target: ClickHouseViewDropTarget };

export interface ClickHouseViewCreateResult {
    status: NativeSchemaExecutionStatus;
    progress: NativeSchemaStatementProgress;
    container: ContainerRef;
    schema: ClickHouseViewSchema | null;
    backgroundWork: NativeSchemaBackgroundWork | null;
    clusterOutcome: ClickHouseClusterExecutionOutcome | null;
}

export interface ClickHouseViewChangeResult {
    status: NativeSchemaExecutionStatus;
    progress: NativeSchemaStatementProgress;
    operation: SchemaMutationOperation;
    source: ContainerRef;
    destination: ContainerRef | null;
    schema: ClickHouseViewSchema | null;
    backgroundWork: NativeSchemaBackgroundWork | null;
    clusterOutcome: ClickHouseClusterExecutionOutcome | null;
}

export type NativeSchemaSupportRequest = {
    kind: "clickhouse_view";
    database: string | null;
    clusterName: string | null;
};

export type NativeSchemaSupportDocument = {
    kind: "clickhouse_view";
    document: ClickHouseViewRuntimeSupport;
};

export type NativeSchemaSessionListRequest = "clickhouse_temporary_views";

export type NativeSchemaSessionDocuments = {
    kind: "clickhouse_views";
    documents: ClickHouseViewSchema[];
};
