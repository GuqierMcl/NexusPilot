import type { ConnectionRuntimeInfo, ContainerRef } from "@/types/ipc";
import type { SqlExecutionContext } from "@/types/saved-queries";
import type { TableDesignMode } from "@/types/table-design";

export interface TableDataPayload {
    profileId: string;
    tabRuntimeId: string;
    runtime: ConnectionRuntimeInfo;
    container: ContainerRef;
}

export interface KeyValuePayload {
    profileId: string;
    dbIndex: number;
    pattern?: string;
    selectedKey?: string;
}

export interface SqlEditorPayload {
    profileId: string;
    tabRuntimeId: string;
    runtime: ConnectionRuntimeInfo;
    savedQueryId?: string | null;
    initialContext?: SqlExecutionContext | null;
}

export interface TableDesignPayload {
    profileId: string;
    tabRuntimeId: string;
    mode: TableDesignMode;
    container?: ContainerRef | null;
    parentContainer?: ContainerRef | null;
}

export type ClickHouseTableDesignPayload =
    | {
          profileId: string;
          tabRuntimeId: string;
          mode: "create";
          container: null;
          parentContainer: ContainerRef;
      }
    | {
          profileId: string;
          tabRuntimeId: string;
          mode: "edit";
          container: ContainerRef;
          parentContainer: null;
      };

export type ClickHouseViewDesignPayload =
    | {
          profileId: string;
          tabRuntimeId: string;
          mode: "create";
          parentContainer: ContainerRef;
          ownerTabRuntimeId: null;
      }
    | {
          profileId: string;
          tabRuntimeId: string;
          mode: "edit";
          container: ContainerRef;
          ownerTabRuntimeId: null;
      }
    | {
          profileId: string;
          tabRuntimeId: string;
          mode: "temporary";
          container: null;
          ownerTabRuntimeId: string;
      };

export type JsonViewerPayload = Record<string, never>;

export type GraphTopologyPayload = Record<string, never>;

export type DashboardPayload = Record<string, never>;
