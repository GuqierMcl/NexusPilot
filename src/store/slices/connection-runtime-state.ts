import type {
    ConnectionMetadataAction,
    ConnectionStatus,
    ISessionState,
    RuntimeSessionEvent,
} from "@/types/connection-runtime";

export const DEFAULT_RUNTIME_MAX_ATTEMPTS = 3;

export function canStartRuntime(status: ConnectionStatus): boolean {
    return status === "idle" || status === "error";
}

export function canStopRuntime(status: ConnectionStatus): boolean {
    return (
        status === "connecting" ||
        status === "connected" ||
        status === "degraded" ||
        status === "reconnecting" ||
        status === "error"
    );
}

export function isRuntimeMaterialized(status: ConnectionStatus): boolean {
    return (
        status === "connected" ||
        status === "degraded" ||
        status === "reconnecting"
    );
}

export function canLoadRemoteMetadata(session?: ISessionState): boolean {
    return (
        session?.status === "connected" &&
        session.capabilities?.schemaBrowser === true
    );
}

export function decideConnectionMetadataAction(
    session?: ISessionState,
): ConnectionMetadataAction {
    if (!session || canStartRuntime(session.status)) {
        return "connect";
    }

    if (session.status === "connected") {
        return canLoadRemoteMetadata(session) ? "load" : "unsupported";
    }

    return "wait";
}

export function reduceRuntimeSession(
    session: ISessionState,
    event: RuntimeSessionEvent,
): ISessionState {
    switch (event.type) {
        case "connectRequested":
            if (!canStartRuntime(session.status)) {
                return session;
            }
            return {
                status: "connecting",
                activeDatabase: session.activeDatabase,
            };

        case "connectSucceeded":
            if (session.status !== "connecting") {
                return session;
            }
            return {
                status: "connected",
                ping: event.ping,
                activeDatabase: session.activeDatabase,
                capabilities: event.runtime.capabilities,
            };

        case "connectFailed":
            if (session.status !== "connecting") {
                return session;
            }
            return {
                status: "error",
                activeDatabase: session.activeDatabase,
                errorMsg: event.message,
            };

        case "retryableFailure": {
            if (!isRuntimeMaterialized(session.status)) {
                return session;
            }
            const recovery = session.recovery ?? {
                attempt: 0,
                maxAttempts: DEFAULT_RUNTIME_MAX_ATTEMPTS,
            };
            return {
                ...session,
                status:
                    session.status === "reconnecting"
                        ? "reconnecting"
                        : "degraded",
                errorMsg: event.message,
                recovery: {
                    ...recovery,
                    lastFailureAt: event.occurredAt,
                },
            };
        }

        case "terminalFailure":
            if (!isRuntimeMaterialized(session.status)) {
                return session;
            }
            return {
                ...session,
                status: "error",
                ping: undefined,
                errorMsg: event.message,
                recovery: undefined,
            };

        case "reconnectStarted":
            if (
                session.status !== "degraded" &&
                session.status !== "reconnecting"
            ) {
                return session;
            }
            return {
                ...session,
                status: "reconnecting",
                recovery: {
                    ...session.recovery,
                    attempt: event.attempt,
                    maxAttempts: event.maxAttempts,
                },
            };

        case "probeSucceeded":
            if (
                session.status !== "reconnecting" &&
                session.status !== "degraded"
            ) {
                return session;
            }
            return {
                ...session,
                status: "connected",
                ping: event.ping,
                errorMsg: undefined,
                recovery: undefined,
            };

        case "probeFailed":
            if (session.status !== "reconnecting") {
                return session;
            }
            return {
                ...session,
                status:
                    event.attempt >= event.maxAttempts
                        ? "error"
                        : "reconnecting",
                ping: undefined,
                errorMsg: event.message,
                recovery: {
                    attempt: event.attempt,
                    maxAttempts: event.maxAttempts,
                    lastFailureAt: event.occurredAt,
                },
            };

        case "disconnectRequested":
            if (session.status === "idle" || session.status === "disconnecting") {
                return session;
            }
            return {
                ...session,
                status: "disconnecting",
            };

        case "disconnectFinished":
            if (session.status !== "disconnecting") {
                return session;
            }
            return { status: "idle" };

        case "activeDatabaseChanged":
            return {
                ...session,
                activeDatabase: event.database,
            };

        default: {
            const exhaustive: never = event;
            return exhaustive;
        }
    }
}
