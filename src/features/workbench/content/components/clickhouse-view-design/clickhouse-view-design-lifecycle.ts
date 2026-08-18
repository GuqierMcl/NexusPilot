import type {
    ClickHouseViewDesignAction,
    ClickHouseViewDesignDraft,
    ClickHouseViewDesignRuntimeState,
} from "@/types/clickhouse-view-design";
import type {
    ClickHouseViewFamily,
    ClickHouseViewSchema,
    NativeSchemaChangePlan,
    NativeSchemaMutationPreview,
} from "@/types/ipc";

import {
    clickHouseViewDraftKey,
    cloneClickHouseViewDraft,
} from "./clickhouse-view-design-validation";

export function createClickHouseViewDesignState(input: {
    mode: ClickHouseViewDesignRuntimeState["mode"];
    family: ClickHouseViewFamily;
    draft: ClickHouseViewDesignDraft;
}): ClickHouseViewDesignRuntimeState {
    return {
        mode: input.mode,
        family: input.family,
        draft: cloneClickHouseViewDraft(input.draft),
        snapshot: cloneClickHouseViewDraft(input.draft),
        schema: null,
        support: null,
        preview: null,
        pendingAction: null,
        conflictRemoteSchema: null,
        outcome: null,
        backgroundWork: null,
    };
}

export function draftFromClickHouseViewSchema(
    schema: ClickHouseViewSchema,
): ClickHouseViewDesignDraft {
    return {
        address: structuredClone(schema.identity.address),
        family: schema.family,
        scope:
            schema.scope.kind === "temporary"
                ? {
                      kind: "temporary",
                      value: {
                          ownerTabRuntimeId: schema.scope.value.ownerTabRuntimeId,
                      },
                  }
                : structuredClone(schema.scope),
        columns: structuredClone(schema.columns),
        query: schema.query,
        security: structuredClone(schema.security),
        comment: schema.comment,
        familyDefinition: structuredClone(schema.familyDefinition),
    };
}

export function loadClickHouseViewDesignSchema(
    state: ClickHouseViewDesignRuntimeState,
    schema: ClickHouseViewSchema,
): ClickHouseViewDesignRuntimeState {
    const draft = draftFromClickHouseViewSchema(schema);
    const revisionChanged =
        state.schema?.baseline.revisionHash !== schema.baseline.revisionHash ||
        state.support?.supportRevision !== schema.serverSupport.supportRevision;
    return {
        ...state,
        family: schema.family,
        draft,
        snapshot: cloneClickHouseViewDraft(draft),
        schema,
        support: schema.serverSupport,
        preview: revisionChanged ? null : state.preview,
        conflictRemoteSchema: null,
    };
}

export function updateClickHouseViewDesignDraft(
    state: ClickHouseViewDesignRuntimeState,
    draft: ClickHouseViewDesignDraft,
): ClickHouseViewDesignRuntimeState {
    return {
        ...state,
        family: draft.family,
        draft: cloneClickHouseViewDraft(draft),
        preview: null,
        outcome: null,
    };
}

export function recordClickHouseViewDesignPreview(
    state: ClickHouseViewDesignRuntimeState,
    preview: NativeSchemaMutationPreview | NativeSchemaChangePlan,
): ClickHouseViewDesignRuntimeState {
    return {
        ...state,
        preview: {
            preview,
            draftKey: clickHouseViewDraftKey(state.draft),
            supportRevision:
                state.support?.supportRevision ??
                state.schema?.baseline.supportRevision ??
                "",
            baselineRevision: state.schema?.baseline.revisionHash ?? null,
        },
        pendingAction: null,
    };
}

function supportForFamily(
    state: ClickHouseViewDesignRuntimeState,
    family: ClickHouseViewFamily,
) {
    const support = state.support;
    if (!support) return null;
    switch (family) {
        case "normal":
            return support.normal;
        case "parameterized":
            return support.parameterized;
        case "temporary":
            return support.temporary;
        case "materialized":
            return support.materialized;
        case "refreshable_materialized":
            return support.refreshableMaterialized;
        case "window":
            return support.window;
        case "live":
            return support.live;
    }
}

function previewIsCurrent(state: ClickHouseViewDesignRuntimeState): boolean {
    return (
        state.preview != null &&
        state.preview.draftKey === clickHouseViewDraftKey(state.draft) &&
        state.preview.supportRevision ===
            (state.support?.supportRevision ?? state.schema?.baseline.supportRevision ?? "") &&
        state.preview.baselineRevision ===
            (state.schema?.baseline.revisionHash ?? null)
    );
}

function operationForAction(
    state: ClickHouseViewDesignRuntimeState,
    action: ClickHouseViewDesignAction,
): "create" | "alter" | "rename" | "drop" | "describe" | null {
    switch (action) {
        case "refreshSupport":
        case "refreshDefinition":
            return "describe";
        case "preview":
        case "apply":
            return state.mode === "create" ? "create" : "alter";
        case "rename":
            return "rename";
        case "drop":
            return "drop";
    }
}

export function canStartClickHouseViewDesignAction(
    state: ClickHouseViewDesignRuntimeState,
    action: ClickHouseViewDesignAction,
): boolean {
    if (state.pendingAction != null) return false;
    const operation = operationForAction(state, action);
    if (operation === "describe") return true;
    if (operation == null) return false;
    const familySupport = supportForFamily(state, state.family);
    if (familySupport?.[operation].state !== "supported") return false;
    if (state.schema && state.schema.editability.mode !== "editable") return false;
    if (action === "apply" && !previewIsCurrent(state)) return false;
    return true;
}

export function beginClickHouseViewDesignAction(
    state: ClickHouseViewDesignRuntimeState,
    action: ClickHouseViewDesignAction,
): ClickHouseViewDesignRuntimeState {
    if (!canStartClickHouseViewDesignAction(state, action)) {
        throw new Error("A schema action is already pending or the requested action is unavailable");
    }
    return { ...state, pendingAction: action };
}

export function completeClickHouseViewDesignExecution(
    state: ClickHouseViewDesignRuntimeState,
    result: {
        status: ClickHouseViewDesignRuntimeState["outcome"];
        schema: ClickHouseViewSchema | null;
        backgroundWork: ClickHouseViewDesignRuntimeState["backgroundWork"];
    },
): ClickHouseViewDesignRuntimeState {
    const withFacts = result.schema
        ? loadClickHouseViewDesignSchema(state, result.schema)
        : state;
    return {
        ...withFacts,
        pendingAction: null,
        outcome: result.status,
        backgroundWork: result.backgroundWork,
    };
}
