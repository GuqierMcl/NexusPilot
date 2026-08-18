import { useCallback, useEffect, useRef } from "react";

import { apiInvoke } from "@/lib/api-client";
import { normalizeIpcError } from "@/lib/ipc-error";
import {
    cancelSqlExecution,
    defaultSqlExecutionTransport,
    getSqlExecutionSnapshot,
    releaseSqlExecution,
    startSqlExecution,
} from "@/lib/sql-execution-client";
import {
    useTabRuntimeStateStore,
    useWorkbenchTabsStore,
} from "@/store";
import type {
    IAppError,
    QueryResult,
    SqlExecutionFailure,
    SqlExecutionFeatures,
    SqlExecutionSnapshot,
    SqlResultMode,
} from "@/types/ipc";

import {
    executeSqlLifecycle,
    type SqlExecutionLifecycleDependencies,
    type SqlExecutionRunInput,
} from "./sql-execution-lifecycle";
import {
    appendSqlExecutionTimeline,
    canCancelSqlExecution,
    isActiveSqlExecutionState,
    isTerminalSqlExecutionState,
    reduceSqlExecutionSnapshot,
    resolveSqlExecutionMode,
} from "./sql-execution-state";

export interface UseSqlExecutionLifecycleInput {
    tabId: string;
    runtimeTabId: string;
    profileId: string;
    features?: SqlExecutionFeatures;
}

export interface SqlExecutionRunCallbacks {
    onSnapshot?(snapshot: SqlExecutionSnapshot): void;
}

export function resolveSqlExecutionResultMode(
    override: SqlResultMode | undefined,
    tabDefault: SqlResultMode,
): SqlResultMode {
    return override ?? tabDefault;
}

export type SqlExecutionExecuteInput = Omit<
    SqlExecutionRunInput,
    | "mode"
    | "profileId"
    | "runtimeTabId"
    | "timeoutMs"
    | "resultMode"
> &
    SqlExecutionRunCallbacks & {
        resultMode?: SqlResultMode;
    };

export interface UseSqlExecutionLifecycleResult {
    execute(input: SqlExecutionExecuteInput): Promise<SqlExecutionSnapshot>;
    cancelActive(): Promise<SqlExecutionSnapshot | null>;
    releaseCurrent(): Promise<void>;
    isExecuting: boolean;
}

function executionFailureToAppError(
    failure: SqlExecutionFailure,
): IAppError {
    return {
        code: failure.code,
        runtimeImpact: failure.runtimeImpact,
        message: failure.message,
        details: failure.details ?? undefined,
    };
}

function logLifecycleError(
    operation: string,
    profileId: string,
    runtimeTabId: string,
    error: unknown,
): void {
    const normalized = normalizeIpcError(error);
    console.error(`[sql-editor] ${operation}`, {
        profileId,
        runtimeTabId,
        code: normalized.code,
        message: normalized.message,
    });
}

export function useSqlExecutionLifecycle({
    tabId,
    runtimeTabId,
    profileId,
    features,
}: UseSqlExecutionLifecycleInput): UseSqlExecutionLifecycleResult {
    const generationRef = useRef(0);
    const patchSqlEditorState = useTabRuntimeStateStore(
        (state) => state.patchSqlEditorState,
    );
    const activeExecution = useTabRuntimeStateStore(
        (state) =>
            state.sqlEditorByTabId[tabId]?.activeExecution ?? null,
    );
    const setExecuting = useWorkbenchTabsStore((state) => state.setExecuting);

    const applySnapshot = useCallback(
        (snapshot: SqlExecutionSnapshot, generation: number): void => {
            if (generationRef.current !== generation) return;

            let acceptedState: SqlExecutionSnapshot["state"] | null = null;
            patchSqlEditorState(tabId, (current) => {
                const next = reduceSqlExecutionSnapshot(
                    current.activeExecution,
                    snapshot,
                );
                if (next == null || next === current.activeExecution) return {};

                acceptedState = next.state;
                const terminal = isTerminalSqlExecutionState(next.state);
                const rowsOutcome =
                    next.outcome?.kind === "rows" ? next.outcome : null;
                return {
                    activeExecution: next,
                    lastOutcome: next.outcome,
                    executionTimeline: appendSqlExecutionTimeline(
                        current.executionTimeline,
                        next,
                        Date.now(),
                    ),
                    result: rowsOutcome
                        ? rowsOutcome.result
                        : terminal
                          ? null
                          : current.result,
                    error: next.failure
                        ? executionFailureToAppError(next.failure)
                        : null,
                };
            });

            if (acceptedState !== null) {
                setExecuting(
                    tabId,
                    isActiveSqlExecutionState(acceptedState),
                );
            }
        },
        [patchSqlEditorState, setExecuting, tabId],
    );

    useEffect(
        () => () => {
            generationRef.current += 1;
            setExecuting(tabId, false);
        },
        [profileId, runtimeTabId, setExecuting, tabId],
    );

    const execute = useCallback<UseSqlExecutionLifecycleResult["execute"]>(
        async (input) => {
            const currentState =
                useTabRuntimeStateStore.getState().sqlEditorByTabId[tabId];
            const previous = currentState?.activeExecution ?? null;
            if (previous && isActiveSqlExecutionState(previous.state)) {
                throw {
                    code: "RESOURCE_CONFLICT",
                    runtimeImpact: "businessOnly",
                    message: "当前标签页已有 SQL 正在执行",
                } satisfies IAppError;
            }

            const generation = generationRef.current + 1;
            generationRef.current = generation;

            try {
                if (previous && isTerminalSqlExecutionState(previous.state)) {
                    if (!previous.executionId.startsWith("legacy-")) {
                        await releaseSqlExecution(
                            defaultSqlExecutionTransport,
                            profileId,
                            runtimeTabId,
                            previous.executionId,
                        );
                    }
                    patchSqlEditorState(tabId, {
                        activeExecution: null,
                        lastOutcome: null,
                        executionTimeline: [],
                    });
                }

                const executionOptions =
                    useTabRuntimeStateStore.getState().sqlEditorByTabId[tabId]
                        ?.executionOptions ?? {
                        timeoutMs: 30_000 as const,
                        resultMode: "grid" as const,
                    };
                const dependencies: SqlExecutionLifecycleDependencies = {
                    startManaged: (startInput) =>
                        startSqlExecution(
                            defaultSqlExecutionTransport,
                            startInput,
                        ),
                    getManagedSnapshot: (
                        nextProfileId,
                        nextRuntimeTabId,
                        executionId,
                    ) =>
                        getSqlExecutionSnapshot(
                            defaultSqlExecutionTransport,
                            nextProfileId,
                            nextRuntimeTabId,
                            executionId,
                        ),
                    executeLegacy: (legacyInput) =>
                        apiInvoke<QueryResult>(
                            "execute_sql",
                            {
                                profileId: legacyInput.profileId,
                                tabId: legacyInput.runtimeTabId,
                                context: legacyInput.context,
                                sql: legacyInput.sql,
                                page: legacyInput.page,
                                pageSize: legacyInput.pageSize,
                            },
                            { silent: true },
                        ),
                    waitForReconciliation: () =>
                        new Promise((resolve) => {
                            globalThis.setTimeout(resolve, 2_000);
                        }),
                    now: Date.now,
                    createLegacyId: () =>
                        `legacy-${globalThis.crypto.randomUUID()}`,
                    onSnapshot: (snapshot) => {
                        applySnapshot(snapshot, generation);
                        if (generationRef.current === generation) {
                            input.onSnapshot?.(snapshot);
                        }
                    },
                    onReconciliationError: (error) =>
                        logLifecycleError(
                            "execution snapshot reconciliation failed",
                            profileId,
                            runtimeTabId,
                            error,
                        ),
                };

                const { onSnapshot: _onSnapshot, ...runInput } = input;
                return await executeSqlLifecycle(dependencies, {
                    ...runInput,
                    mode: resolveSqlExecutionMode(features),
                    profileId,
                    runtimeTabId,
                    timeoutMs: executionOptions.timeoutMs,
                    resultMode: resolveSqlExecutionResultMode(
                        input.resultMode,
                        executionOptions.resultMode,
                    ),
                });
            } catch (error) {
                logLifecycleError(
                    "execution lifecycle failed",
                    profileId,
                    runtimeTabId,
                    error,
                );
                const normalized = normalizeIpcError(error);
                if (generationRef.current === generation) {
                    patchSqlEditorState(tabId, {
                        result: null,
                        error: normalized,
                    });
                    setExecuting(tabId, false);
                }
                throw normalized;
            }
        },
        [
            applySnapshot,
            features,
            patchSqlEditorState,
            profileId,
            runtimeTabId,
            setExecuting,
            tabId,
        ],
    );

    const cancelActive = useCallback(async () => {
        const snapshot =
            useTabRuntimeStateStore.getState().sqlEditorByTabId[tabId]
                ?.activeExecution ?? null;
        if (!canCancelSqlExecution(features, snapshot)) {
            return null;
        }

        const generation = generationRef.current;
        try {
            const canceled = await cancelSqlExecution(
                defaultSqlExecutionTransport,
                profileId,
                runtimeTabId,
                snapshot.executionId,
            );
            applySnapshot(canceled, generation);
            return canceled;
        } catch (error) {
            logLifecycleError(
                "execution cancellation failed",
                profileId,
                runtimeTabId,
                error,
            );
            throw normalizeIpcError(error);
        }
    }, [applySnapshot, features, profileId, runtimeTabId, tabId]);

    const releaseCurrent = useCallback(async () => {
        const snapshot =
            useTabRuntimeStateStore.getState().sqlEditorByTabId[tabId]
                ?.activeExecution ?? null;
        if (!snapshot || !isTerminalSqlExecutionState(snapshot.state)) return;

        generationRef.current += 1;
        try {
            if (!snapshot.executionId.startsWith("legacy-")) {
                await releaseSqlExecution(
                    defaultSqlExecutionTransport,
                    profileId,
                    runtimeTabId,
                    snapshot.executionId,
                );
            }
            patchSqlEditorState(tabId, (current) =>
                current.activeExecution?.executionId === snapshot.executionId
                    ? {
                          activeExecution: null,
                          executionTimeline: [],
                      }
                    : {},
            );
            setExecuting(tabId, false);
        } catch (error) {
            logLifecycleError(
                "execution release failed",
                profileId,
                runtimeTabId,
                error,
            );
            throw normalizeIpcError(error);
        }
    }, [
        patchSqlEditorState,
        profileId,
        runtimeTabId,
        setExecuting,
        tabId,
    ]);

    return {
        execute,
        cancelActive,
        releaseCurrent,
        isExecuting:
            activeExecution != null &&
            isActiveSqlExecutionState(activeExecution.state),
    };
}
