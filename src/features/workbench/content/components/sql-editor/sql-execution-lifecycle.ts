import { normalizeIpcError } from "@/lib/ipc-error";
import type { StartSqlExecutionInput } from "@/lib/sql-execution-client";
import type { SqlExecutionTimeoutMs } from "@/store/slices/tab-runtime-state-slice";
import type {
    QueryResult,
    SqlExecutionHandle,
    SqlExecutionSnapshot,
    SqlResultMode,
    StartSqlExecutionRequest,
} from "@/types/ipc";
import type { SqlExecutionContext } from "@/types/saved-queries";

import {
    isTerminalSqlExecutionState,
    reduceSqlExecutionSnapshot,
} from "./sql-execution-state";

export interface SqlExecutionLifecycleDependencies {
    startManaged(input: StartSqlExecutionInput): Promise<SqlExecutionHandle>;
    getManagedSnapshot(
        profileId: string,
        runtimeTabId: string,
        executionId: string,
    ): Promise<SqlExecutionSnapshot>;
    executeLegacy(input: SqlExecutionRunInput): Promise<QueryResult>;
    waitForReconciliation(): Promise<void>;
    now(): number;
    createLegacyId(): string;
    onSnapshot(snapshot: SqlExecutionSnapshot): void;
    onReconciliationError(error: unknown): void;
}

export interface SqlExecutionRunInput {
    mode: "managed" | "legacy";
    profileId: string;
    runtimeTabId: string;
    context: SqlExecutionContext;
    sql: string;
    page: number;
    pageSize: number;
    timeoutMs: SqlExecutionTimeoutMs;
    resultMode: SqlResultMode;
}

export function toStartRequest(
    input: SqlExecutionRunInput,
): StartSqlExecutionRequest {
    return {
        context: input.context,
        sql: input.sql,
        options: {
            resultMode: input.resultMode,
            timeoutMs: input.timeoutMs,
            page: input.page,
            pageSize: input.pageSize,
        },
    };
}

async function executeManagedSqlLifecycle(
    dependencies: SqlExecutionLifecycleDependencies,
    input: SqlExecutionRunInput,
): Promise<SqlExecutionSnapshot> {
    let current: SqlExecutionSnapshot | null = null;
    let expectedExecutionId: string | null = null;
    const readCurrent = (): SqlExecutionSnapshot | null => current;
    let resolveTerminal!: (snapshot: SqlExecutionSnapshot) => void;
    const terminalSignal = new Promise<SqlExecutionSnapshot>((resolve) => {
        resolveTerminal = resolve;
    });

    const applySnapshot = (incoming: SqlExecutionSnapshot): void => {
        if (
            expectedExecutionId !== null &&
            incoming.executionId !== expectedExecutionId
        ) {
            return;
        }
        const next = reduceSqlExecutionSnapshot(current, incoming);
        if (next === current || next == null) return;
        current = next;
        dependencies.onSnapshot(next);
        if (
            expectedExecutionId !== null &&
            isTerminalSqlExecutionState(next.state)
        ) {
            resolveTerminal(next);
        }
    };

    const handle = await dependencies.startManaged({
        profileId: input.profileId,
        tabId: input.runtimeTabId,
        request: toStartRequest(input),
        onEvent: (event) => applySnapshot(event.snapshot),
    });
    expectedExecutionId = handle.executionId;
    const channelSnapshot = readCurrent();
    if (
        channelSnapshot &&
        channelSnapshot.executionId !== expectedExecutionId
    ) {
        current = null;
    }
    const handleSnapshot = readCurrent();
    if (
        handleSnapshot &&
        isTerminalSqlExecutionState(handleSnapshot.state)
    ) {
        resolveTerminal(handleSnapshot);
    }

    const reconcile = async (): Promise<void> => {
        try {
            applySnapshot(
                await dependencies.getManagedSnapshot(
                    input.profileId,
                    input.runtimeTabId,
                    handle.executionId,
                ),
            );
        } catch (error) {
            dependencies.onReconciliationError(error);
        }
    };

    await reconcile();

    while (true) {
        const snapshot = readCurrent();
        if (snapshot && isTerminalSqlExecutionState(snapshot.state)) break;
        await Promise.race([
            terminalSignal,
            dependencies.waitForReconciliation(),
        ]);
        const snapshotAfterWait = readCurrent();
        if (
            snapshotAfterWait &&
            isTerminalSqlExecutionState(snapshotAfterWait.state)
        ) {
            break;
        }
        await reconcile();
    }

    const terminal = readCurrent();
    if (!terminal) {
        throw new Error(
            "Managed execution ended without an authoritative snapshot",
        );
    }
    return terminal;
}

async function executeLegacySqlLifecycle(
    dependencies: SqlExecutionLifecycleDependencies,
    input: SqlExecutionRunInput,
): Promise<SqlExecutionSnapshot> {
    const executionId = dependencies.createLegacyId();
    const starting: SqlExecutionSnapshot = {
        executionId,
        queryId: executionId,
        tabId: input.runtimeTabId,
        state: "starting",
        revision: 1,
        statementClass: "unknown",
        startedAt: dependencies.now(),
        finishedAt: null,
        progressAvailable: false,
        summary: null,
        outcome: null,
        failure: null,
        cancelMessage: null,
    };
    dependencies.onSnapshot(starting);

    try {
        const result = await dependencies.executeLegacy(input);
        const succeeded: SqlExecutionSnapshot = {
            ...starting,
            state: "succeeded",
            revision: 2,
            finishedAt: dependencies.now(),
            outcome: { kind: "rows", result },
        };
        dependencies.onSnapshot(succeeded);
        return succeeded;
    } catch (error) {
        const failed: SqlExecutionSnapshot = {
            ...starting,
            state: "failed",
            revision: 2,
            finishedAt: dependencies.now(),
            failure: normalizeIpcError(error),
        };
        dependencies.onSnapshot(failed);
        return failed;
    }
}

export function executeSqlLifecycle(
    dependencies: SqlExecutionLifecycleDependencies,
    input: SqlExecutionRunInput,
): Promise<SqlExecutionSnapshot> {
    return input.mode === "managed"
        ? executeManagedSqlLifecycle(dependencies, input)
        : executeLegacySqlLifecycle(dependencies, input);
}
