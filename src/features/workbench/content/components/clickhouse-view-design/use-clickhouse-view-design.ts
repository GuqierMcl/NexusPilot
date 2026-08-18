import { useCallback, useEffect, useMemo } from "react";

import {
    useClickHouseViewRuntimeSupport,
    useClickHouseViewSchema,
    useCreateClickHouseView,
    useExecuteClickHouseViewChange,
    usePreviewChangeClickHouseView,
    usePreviewCreateClickHouseView,
} from "@/hooks/queries/use-db-metadata";
import { formatIpcError } from "@/lib/ipc-error";
import { useTabRuntimeStateStore, useWorkbenchTabsStore } from "@/store";
import type {
    ClickHouseViewDesignDraft,
    ClickHouseViewDesignMode,
} from "@/types/clickhouse-view-design";
import type {
    ClickHouseViewChangeTarget,
    ContainerRef,
    NativeSchemaConfirmationInput,
    NativeSchemaMutationPreview,
} from "@/types/ipc";

import {
    completeClickHouseViewDesignExecution,
    createClickHouseViewDesignState,
    loadClickHouseViewDesignSchema,
    recordClickHouseViewDesignPreview,
    updateClickHouseViewDesignDraft,
} from "./clickhouse-view-design-lifecycle";
import {
    clickHouseViewDraftKey,
    validateClickHouseViewDraft,
} from "./clickhouse-view-design-validation";

interface UseClickHouseViewDesignInput {
    tabId: string;
    profileId: string;
    mode: ClickHouseViewDesignMode;
    container: ContainerRef | null;
    ownerTabRuntimeId: string | null;
    initialDraft: ClickHouseViewDesignDraft;
    isActive: boolean;
}

function confirmationForPreview(
    preview: NativeSchemaMutationPreview,
    draft: ClickHouseViewDesignDraft,
): NativeSchemaConfirmationInput | null | false {
    const objectName = draft.address.name;
    const clusterName =
        draft.scope.kind === "cluster" ? draft.scope.value.clusterName : null;
    switch (preview.requiredConfirmation) {
        case "none":
            return null;
        case "confirm":
            return globalThis.confirm(`确认执行 ${objectName} 的结构变更？`)
                ? { accepted: true, objectName: null, clusterName: null }
                : false;
        case "typeObjectName":
            return globalThis.prompt(`请输入对象名 ${objectName} 以确认`) === objectName
                ? { accepted: true, objectName, clusterName: null }
                : false;
        case "typeObjectAndCluster": {
            const typedObject = globalThis.prompt(`请输入对象名 ${objectName} 以确认`);
            const typedCluster = globalThis.prompt(
                `请输入集群名 ${clusterName ?? ""} 以确认`,
            );
            return typedObject === objectName && typedCluster === clusterName
                ? { accepted: true, objectName, clusterName }
                : false;
        }
    }
}

export function useClickHouseViewDesign(input: UseClickHouseViewDesignInput) {
    const initialState = useMemo(
        () =>
            createClickHouseViewDesignState({
                mode: input.mode,
                family: input.initialDraft.family,
                draft: input.initialDraft,
            }),
        [input.initialDraft, input.mode],
    );
    const storedState = useTabRuntimeStateStore(
        (state) => state.clickHouseViewDesignByTabId[input.tabId],
    );
    const state = storedState ?? initialState;
    const getOrCreateState = useTabRuntimeStateStore(
        (store) => store.getOrCreateClickHouseViewDesignState,
    );
    const patchState = useTabRuntimeStateStore(
        (store) => store.patchClickHouseViewDesignState,
    );
    const getOrCreateSchemaState = useTabRuntimeStateStore(
        (store) => store.getOrCreateSchemaDesignState,
    );
    const patchSchemaState = useTabRuntimeStateStore(
        (store) => store.patchSchemaDesignState,
    );
    const setDirty = useWorkbenchTabsStore((store) => store.setDirty);
    const setExecuting = useWorkbenchTabsStore((store) => store.setExecuting);
    const retarget = useWorkbenchTabsStore(
        (store) => store.retargetClickHouseViewDesignTabToEdit,
    );
    const database = state.draft.address.database;
    const scope = state.draft.scope.kind;
    const clusterRevision =
        state.preview?.preview.baseline?.kind === "clickhouse_cluster_view"
            ? state.preview.preview.baseline.baseline.topologyRevision
            : null;
    const supportQuery = useClickHouseViewRuntimeSupport(
        input.profileId,
        database,
        input.ownerTabRuntimeId,
        clusterRevision,
        input.isActive,
    );
    const schemaQuery = useClickHouseViewSchema({
        profileId: input.profileId,
        ownerTabRuntimeId: input.ownerTabRuntimeId,
        scope,
        family: state.family,
        container: input.container,
        clusterRevision,
        backgroundWork: state.backgroundWork,
        enabled: input.isActive && input.mode === "edit",
    });
    const previewCreate = usePreviewCreateClickHouseView(input.profileId);
    const createView = useCreateClickHouseView(input.profileId);
    const previewChange = usePreviewChangeClickHouseView(input.profileId);
    const executeChange = useExecuteClickHouseViewChange(input.profileId);

    useEffect(() => {
        getOrCreateState(input.tabId, initialState);
        getOrCreateSchemaState(input.tabId, {
            mode: input.mode === "edit" ? "edit" : "create",
        });
    }, [getOrCreateSchemaState, getOrCreateState, initialState, input.mode, input.tabId]);

    useEffect(() => {
        if (!supportQuery.data) return;
        patchState(input.tabId, (current) => ({
            support: supportQuery.data,
            preview:
                current.support?.supportRevision ===
                supportQuery.data.supportRevision
                    ? current.preview
                    : null,
        }));
    }, [input.tabId, patchState, supportQuery.data]);

    useEffect(() => {
        if (!schemaQuery.data) return;
        patchState(input.tabId, (current) =>
            loadClickHouseViewDesignSchema(current, schemaQuery.data),
        );
    }, [input.tabId, patchState, schemaQuery.data]);

    const issues = useMemo(
        () => validateClickHouseViewDraft(state.draft),
        [state.draft],
    );
    const isDirty =
        clickHouseViewDraftKey(state.draft) !==
        clickHouseViewDraftKey(state.snapshot);
    const pending =
        state.pendingAction != null ||
        previewCreate.isPending ||
        previewChange.isPending ||
        createView.isPending ||
        executeChange.isPending;

    useEffect(() => {
        setDirty(input.tabId, isDirty);
        setExecuting(input.tabId, pending);
        return () => setExecuting(input.tabId, false);
    }, [input.tabId, isDirty, pending, setDirty, setExecuting]);

    useEffect(() => {
        const expired =
            state.schema?.scope.kind === "temporary" &&
            state.schema.scope.value.sessionState === "expired";
        const loadState = expired
            ? "sessionExpired"
            : state.schema?.editability.mode === "readonly"
              ? "readonly"
              : state.schema?.editability.mode === "restricted"
                ? "restricted"
                : schemaQuery.isError
                  ? "error"
                  : input.mode === "edit" && !state.schema
                    ? "loading"
                    : "ready";
        const executionOutcome =
            state.outcome === "applied" ? "idle" : (state.outcome ?? "idle");
        const operationState =
            state.backgroundWork?.state === "running"
                ? "backgroundRunning"
                : state.pendingAction === "preview"
                  ? "previewing"
                  : state.pendingAction != null
                    ? "applying"
                    : state.preview != null
                      ? "previewReady"
                      : executionOutcome;
        patchSchemaState(input.tabId, {
            mode: input.mode === "edit" ? "edit" : "create",
            loadState,
            operationState,
            blockerCount:
                state.schema?.editability.blockers.length ?? issues.length,
            errorMessage:
                schemaQuery.error?.message ?? supportQuery.error?.message ?? null,
            isDirty,
        });
    }, [
        input.mode,
        input.tabId,
        isDirty,
        issues.length,
        patchSchemaState,
        schemaQuery.error,
        schemaQuery.isError,
        state.backgroundWork?.state,
        state.outcome,
        state.pendingAction,
        state.preview,
        state.schema,
        supportQuery.error,
    ]);

    const updateDraft = useCallback(
        (draft: ClickHouseViewDesignDraft) => {
            patchState(input.tabId, (current) =>
                updateClickHouseViewDesignDraft(current, draft),
            );
        },
        [input.tabId, patchState],
    );

    const refresh = useCallback(() => {
        void supportQuery.refetch();
        if (input.mode === "edit") void schemaQuery.refetch();
    }, [input.mode, schemaQuery, supportQuery]);

    const reset = useCallback(() => {
        patchState(input.tabId, (current) => ({
            draft: structuredClone(current.snapshot),
            preview: null,
            conflictRemoteSchema: null,
            outcome: null,
        }));
    }, [input.tabId, patchState]);

    const preview = useCallback(async () => {
        if (issues.length > 0 || !state.support) return;
        patchState(input.tabId, { pendingAction: "preview" });
        try {
            const nextPreview =
                input.mode === "edit" && state.schema
                    ? await previewChange.mutateAsync({
                          kind: "alter",
                          target: {
                              baseline: state.schema,
                              desired: state.draft,
                              expectedSupportRevision:
                                  state.support.supportRevision,
                          },
                      })
                    : await previewCreate.mutateAsync({
                          desired: state.draft,
                          expectedSupportRevision:
                              state.support.supportRevision,
                      });
            patchState(input.tabId, (current) =>
                recordClickHouseViewDesignPreview(current, nextPreview),
            );
        } catch (error) {
            console.error("Failed to preview ClickHouse View mutation", error);
            patchState(input.tabId, { pendingAction: null });
        }
    }, [
        input.mode,
        input.tabId,
        issues.length,
        patchState,
        previewChange,
        previewCreate,
        state.draft,
        state.schema,
        state.support,
    ]);

    const apply = useCallback(async () => {
        const recorded = state.preview?.preview;
        if (!recorded || issues.length > 0) return;
        const confirmation = confirmationForPreview(recorded, state.draft);
        if (confirmation === false) return;
        patchState(input.tabId, { pendingAction: "apply" });
        try {
            const changeBaseline = recorded.baseline;
            if (input.mode === "edit" && state.schema && changeBaseline) {
                const target: ClickHouseViewChangeTarget = {
                    kind: "alter",
                    target: {
                        baseline: state.schema,
                        desired: state.draft,
                        expectedSupportRevision:
                            state.support?.supportRevision ??
                            state.schema.baseline.supportRevision,
                    },
                };
                const result = await executeChange.mutateAsync({
                    target: { kind: "clickhouse_view_alter", target: target.target },
                    baseline: changeBaseline,
                    expectedPlanHash: recorded.planHash,
                    confirmation,
                });
                patchState(input.tabId, (current) =>
                    completeClickHouseViewDesignExecution(current, result),
                );
                return;
            }

            const result = await createView.mutateAsync({
                target: {
                    kind: "clickhouse_view",
                    target: {
                        desired: state.draft,
                        expectedSupportRevision:
                            state.support?.supportRevision ?? "",
                    },
                },
                expectedPlanHash: recorded.planHash,
                confirmation,
                ...(recorded.baseline ? { baseline: recorded.baseline } : {}),
            });
            patchState(input.tabId, (current) =>
                completeClickHouseViewDesignExecution(current, result),
            );
            if (
                result.status === "applied" &&
                result.schema != null &&
                state.draft.scope.kind !== "temporary"
            ) {
                retarget(input.tabId, result.container);
            }
        } catch (error) {
            console.error(
                `Failed to execute ClickHouse View mutation: ${formatIpcError(error)}`,
                error,
            );
            patchState(input.tabId, { pendingAction: null });
        }
    }, [
        createView,
        executeChange,
        input.mode,
        input.tabId,
        issues.length,
        patchState,
        retarget,
        state.draft,
        state.preview?.preview,
        state.schema,
        state.support?.supportRevision,
    ]);

    return {
        state,
        issues,
        isDirty,
        pending,
        supportQuery,
        schemaQuery,
        updateDraft,
        refresh,
        reset,
        preview,
        apply,
    };
}
