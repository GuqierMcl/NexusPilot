import type { SqlExecutionTimelineEntry } from "@/store/slices/tab-runtime-state-slice";
import type {
    SqlExecutionEvent,
    SqlExecutionFeatures,
    SqlExecutionSnapshot,
    SqlExecutionState,
} from "@/types/ipc";

export type SqlExecutionMode = "managed" | "legacy";

const ACTIVE_STATES = new Set<SqlExecutionState>([
    "queued",
    "starting",
    "running",
    "canceling",
]);

const TERMINAL_STATES = new Set<SqlExecutionState>([
    "succeeded",
    "failed",
    "timedOut",
    "canceled",
    "cancelFailed",
]);

export function isActiveSqlExecutionState(
    state: SqlExecutionState,
): boolean {
    return ACTIVE_STATES.has(state);
}

export function isTerminalSqlExecutionState(
    state: SqlExecutionState,
): boolean {
    return TERMINAL_STATES.has(state);
}

export function resolveSqlExecutionMode(
    features?: SqlExecutionFeatures,
): SqlExecutionMode {
    return features?.managedLifecycle === true ? "managed" : "legacy";
}

export function canCancelSqlExecution(
    features: SqlExecutionFeatures | undefined,
    snapshot: SqlExecutionSnapshot | null,
): snapshot is SqlExecutionSnapshot {
    return (
        features?.managedLifecycle === true &&
        features.activeCancel === true &&
        snapshot != null &&
        (snapshot.state === "starting" || snapshot.state === "running")
    );
}

export function reduceSqlExecutionSnapshot(
    current: SqlExecutionSnapshot | null,
    incoming: SqlExecutionSnapshot,
): SqlExecutionSnapshot | null {
    if (current == null) return incoming;
    if (current.executionId !== incoming.executionId) return current;
    if (isTerminalSqlExecutionState(current.state)) return current;
    if (incoming.revision <= current.revision) return current;
    return incoming;
}

export function reduceSqlExecutionEvent(
    current: SqlExecutionSnapshot | null,
    event: SqlExecutionEvent,
): SqlExecutionSnapshot | null {
    return reduceSqlExecutionSnapshot(current, event.snapshot);
}

export function appendSqlExecutionTimeline(
    current: SqlExecutionTimelineEntry[],
    snapshot: SqlExecutionSnapshot,
    observedAt: number,
): SqlExecutionTimelineEntry[] {
    const last = current.at(-1);
    if (last?.executionId !== snapshot.executionId) {
        return [
            {
                executionId: snapshot.executionId,
                revision: snapshot.revision,
                state: snapshot.state,
                observedAt,
            },
        ];
    }
    if (last.state === snapshot.state) return current;
    return [
        ...current,
        {
            executionId: snapshot.executionId,
            revision: snapshot.revision,
            state: snapshot.state,
            observedAt,
        },
    ];
}
