import type {
    ClickHouseViewDefinitionTarget,
    ClickHouseViewFamily,
    ClickHouseViewRuntimeSupport,
    ClickHouseViewSchema,
    NativeSchemaBackgroundWork,
    NativeSchemaExecutionStatus,
    NativeSchemaChangePlan,
    NativeSchemaMutationPreview,
} from "@/types/ipc";

export type ClickHouseViewDesignMode = "create" | "edit" | "temporary";

export type ClickHouseViewDesignAction =
    | "refreshSupport"
    | "refreshDefinition"
    | "preview"
    | "apply"
    | "rename"
    | "drop";

export type ClickHouseViewDesignDraft = ClickHouseViewDefinitionTarget;

export interface ClickHouseViewDesignPreviewState {
    preview: NativeSchemaMutationPreview | NativeSchemaChangePlan;
    draftKey: string;
    supportRevision: string;
    baselineRevision: string | null;
}

export interface ClickHouseViewDesignRuntimeState {
    mode: ClickHouseViewDesignMode;
    family: ClickHouseViewFamily;
    draft: ClickHouseViewDesignDraft;
    snapshot: ClickHouseViewDesignDraft;
    schema: ClickHouseViewSchema | null;
    support: ClickHouseViewRuntimeSupport | null;
    preview: ClickHouseViewDesignPreviewState | null;
    pendingAction: ClickHouseViewDesignAction | null;
    conflictRemoteSchema: ClickHouseViewSchema | null;
    outcome: NativeSchemaExecutionStatus | null;
    backgroundWork: NativeSchemaBackgroundWork | null;
}

export interface ClickHouseViewDesignIssue {
    code: string;
    path: string;
    message: string;
}
