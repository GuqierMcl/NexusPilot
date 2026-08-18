import { create } from "zustand";

import {
    subscribeRuntimeFailure,
    type RuntimeFailureEvent,
} from "@/lib/connection-runtime-events";
import { apiInvoke } from "@/lib/api-client";
import { formatIpcError } from "@/lib/ipc-error";
import {
    cancelRuntimeRecovery,
    DEFAULT_RUNTIME_RECONNECT_DELAYS_MS,
    sleepWithAbort,
    startRuntimeRecovery,
} from "@/store/slices/connection-runtime-recovery";
import {
    beginRuntimeConnectAttempt,
    cancelRuntimeConnectAttempt,
    finishRuntimeConnectAttempt,
} from "@/store/slices/connection-runtime-connect-attempts";
import {
    canStartRuntime,
    isRuntimeMaterialized,
    reduceRuntimeSession,
} from "@/store/slices/connection-runtime-state";
import type {
    ConnectionStatus,
    ISessionState,
    RuntimeSessionEvent,
} from "@/types/connection-runtime";
import type { ConnectionRuntimeInfo, PingResult } from "@/types/ipc";
import type {
    ConnectionRuntimeChangedEvent,
    ConnectionRuntimeSnapshot,
} from "@/types/ipc";

export type { ConnectionStatus, ISessionState } from "@/types/connection-runtime";

const MAX_RECONNECT_ATTEMPTS = DEFAULT_RUNTIME_RECONNECT_DELAYS_MS.length;

interface ConnectionSessionStore {
    /** profileId → 数据库运行时会话状态。 */
    sessions: Record<string, ISessionState>;

    /** 将本地 profile 物化为可工作的数据库运行时会话。 */
    connect: (profileId: string) => Promise<void>;

    /** 释放运行时资源，但保留本地 profile。 */
    disconnect: (profileId: string) => Promise<void>;

    /** 接收 apiInvoke 发布的 profile 级运行时故障。 */
    reportRuntimeFailure: (failure: RuntimeFailureEvent) => void;

    applyRuntimeChanged: (event: ConnectionRuntimeChangedEvent) => void;
    reconcileRuntimeSnapshots: (
        snapshots: ConnectionRuntimeSnapshot[],
    ) => string[];

    setActiveDatabase: (profileId: string, dbName: string) => void;
    getSession: (profileId: string) => ISessionState;
}

export const useConnectionSessionStore = create<ConnectionSessionStore>(
    (set, get) => {
        const dispatch = (
            profileId: string,
            event: RuntimeSessionEvent,
        ): void => {
            set((state) => {
                const current = state.sessions[profileId] ?? {
                    status: "idle",
                };
                const next = reduceRuntimeSession(current, event);
                if (next === current) {
                    return state;
                }
                return {
                    sessions: {
                        ...state.sessions,
                        [profileId]: next,
                    },
                };
            });
        };

        return {
            sessions: {},

            connect: async (profileId) => {
                const status = get().sessions[profileId]?.status ?? "idle";
                if (!canStartRuntime(status)) {
                    return;
                }

                cancelRuntimeRecovery(profileId);
                dispatch(profileId, { type: "connectRequested" });
                const attempt = beginRuntimeConnectAttempt(profileId);

                try {
                    const runtime = await apiInvoke<ConnectionRuntimeInfo>(
                        "connect_profile",
                        { profileId },
                        { silent: true },
                    );
                    if (!finishRuntimeConnectAttempt(profileId, attempt)) {
                        return;
                    }
                    dispatch(profileId, {
                        type: "connectSucceeded",
                        runtime,
                    });
                } catch (raw) {
                    if (!finishRuntimeConnectAttempt(profileId, attempt)) {
                        return;
                    }
                    dispatch(profileId, {
                        type: "connectFailed",
                        message: formatIpcError(raw),
                    });
                }
            },

            disconnect: async (profileId) => {
                dispatch(profileId, { type: "disconnectRequested" });
                cancelRuntimeConnectAttempt(profileId);
                cancelRuntimeRecovery(profileId);

                try {
                    await apiInvoke(
                        "disconnect_profile",
                        { profileId },
                        { silent: true, trackRuntimeHealth: false },
                    );
                } catch {
                    // 本地生命周期仍必须结束，避免残留不可操作的 UI 会话。
                } finally {
                    dispatch(profileId, { type: "disconnectFinished" });
                    set((state) => {
                        const sessions = { ...state.sessions };
                        delete sessions[profileId];
                        return { sessions };
                    });
                }
            },

            reportRuntimeFailure: (failure) => {
                const current = get().sessions[failure.profileId];
                if (!current || !isRuntimeMaterialized(current.status)) {
                    return;
                }

                if (failure.runtimeImpact === "terminal") {
                    cancelRuntimeRecovery(failure.profileId);
                    dispatch(failure.profileId, {
                        type: "terminalFailure",
                        message: failure.message,
                    });
                    return;
                }

                dispatch(failure.profileId, {
                    type: "retryableFailure",
                    message: failure.message,
                    occurredAt: failure.occurredAt,
                });

                void startRuntimeRecovery({
                    profileId: failure.profileId,
                    maxAttempts: MAX_RECONNECT_ATTEMPTS,
                    delaysMs: DEFAULT_RUNTIME_RECONNECT_DELAYS_MS,
                    probe: () =>
                        apiInvoke<PingResult>(
                            "test_connection",
                            { profileId: failure.profileId },
                            {
                                silent: true,
                                trackRuntimeHealth: false,
                            },
                        ),
                    sleep: sleepWithAbort,
                    dispatch: (event) => dispatch(failure.profileId, event),
                    now: Date.now,
                }).catch((error: unknown) => {
                    console.error(
                        `[runtime-session] recovery failed for ${failure.profileId}`,
                        error,
                    );
                });
            },

            applyRuntimeChanged: (event) => {
                if (event.kind === "removed") {
                    cancelRuntimeConnectAttempt(event.profileId);
                    cancelRuntimeRecovery(event.profileId);
                    set((state) => {
                        const sessions = { ...state.sessions };
                        delete sessions[event.profileId];
                        return { sessions };
                    });
                    return;
                }

                const snapshot = event.snapshot;
                cancelRuntimeRecovery(snapshot.profileId);
                set((state) => ({
                    sessions: {
                        ...state.sessions,
                        [snapshot.profileId]: projectRuntimeSnapshot(
                            snapshot,
                            state.sessions[snapshot.profileId],
                        ),
                    },
                }));
            },

            reconcileRuntimeSnapshots: (snapshots) => {
                const snapshotByProfile = new Map(
                    snapshots.map((snapshot) => [snapshot.profileId, snapshot]),
                );
                const removedProfileIds: string[] = [];
                set((state) => {
                    const sessions = { ...state.sessions };
                    for (const [profileId, session] of Object.entries(sessions)) {
                        if (
                            isRuntimeMaterialized(session.status) &&
                            !snapshotByProfile.has(profileId)
                        ) {
                            delete sessions[profileId];
                            cancelRuntimeRecovery(profileId);
                            removedProfileIds.push(profileId);
                        }
                    }
                    for (const snapshot of snapshots) {
                        cancelRuntimeRecovery(snapshot.profileId);
                        sessions[snapshot.profileId] = projectRuntimeSnapshot(
                            snapshot,
                            sessions[snapshot.profileId],
                        );
                    }
                    return { sessions };
                });
                return removedProfileIds;
            },

            setActiveDatabase: (profileId, dbName) => {
                set((state) => {
                    const current = state.sessions[profileId] ?? {
                        status: "connected" as ConnectionStatus,
                    };
                    return {
                        sessions: {
                            ...state.sessions,
                            [profileId]: reduceRuntimeSession(current, {
                                type: "activeDatabaseChanged",
                                database: dbName,
                            }),
                        },
                    };
                });
            },

            getSession: (profileId) =>
                get().sessions[profileId] ?? { status: "idle" },
        };
    },
);

function projectRuntimeSnapshot(
    snapshot: ConnectionRuntimeSnapshot,
    current?: ISessionState,
): ISessionState {
    const status: ConnectionStatus =
        snapshot.health.status === "healthy"
            ? "connected"
            : snapshot.health.status === "degraded"
              ? "degraded"
              : "error";
    return {
        status,
        activeDatabase: current?.activeDatabase,
        capabilities: snapshot.runtime.capabilities,
    };
}

subscribeRuntimeFailure((failure) => {
    useConnectionSessionStore.getState().reportRuntimeFailure(failure);
});
