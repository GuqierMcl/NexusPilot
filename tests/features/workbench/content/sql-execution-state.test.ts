import { describe, expect, test } from "bun:test";

import {
    appendSqlExecutionTimeline,
    canCancelSqlExecution,
    isActiveSqlExecutionState,
    isTerminalSqlExecutionState,
    reduceSqlExecutionEvent,
    resolveSqlExecutionMode,
} from "../../../../src/features/workbench/content/components/sql-editor/sql-execution-state";
import {
    useTabRuntimeStateStore,
    type SqlExecutionTimelineEntry,
} from "../../../../src/store";
import type {
    SqlExecutionEvent,
    SqlExecutionFeatures,
    SqlExecutionSnapshot,
} from "../../../../src/types/ipc";

function features(managedLifecycle: boolean): SqlExecutionFeatures {
    return {
        managedLifecycle,
        statementAccess: "readOnly",
        activeCancel: false,
        liveProgress: false,
        querySummary: false,
        rawResult: false,
        configurableTimeout: true,
    };
}

function cancelFeatures(
    managedLifecycle: boolean,
    activeCancel: boolean,
): SqlExecutionFeatures {
    return {
        managedLifecycle,
        statementAccess: "readOnly",
        activeCancel,
        liveProgress: false,
        querySummary: false,
        rawResult: false,
        configurableTimeout: true,
    };
}

function snapshot(
    executionId: string,
    state: SqlExecutionSnapshot["state"],
    revision: number,
): SqlExecutionSnapshot {
    return {
        executionId,
        queryId: `query-${executionId}`,
        tabId: "runtime-tab",
        state,
        revision,
        statementClass: "read",
        startedAt: 1,
        finishedAt: isTerminalSqlExecutionState(state) ? 2 : null,
        progressAvailable: false,
        summary: null,
        outcome: null,
        failure: null,
        cancelMessage: null,
    };
}

function event(value: SqlExecutionSnapshot): SqlExecutionEvent {
    return { kind: "snapshot", snapshot: value };
}

describe("SQL execution revision reducer", () => {
    test("accepts only matching newer snapshots and keeps terminal state", () => {
        const running = reduceSqlExecutionEvent(
            null,
            event(snapshot("e1", "running", 2)),
        );
        expect(running?.state).toBe("running");
        expect(
            reduceSqlExecutionEvent(
                running,
                event(snapshot("e1", "starting", 1)),
            ),
        ).toBe(running);
        expect(
            reduceSqlExecutionEvent(
                running,
                event(snapshot("e2", "running", 9)),
            ),
        ).toBe(running);

        const terminal = reduceSqlExecutionEvent(
            running,
            event(snapshot("e1", "succeeded", 3)),
        );
        expect(terminal?.state).toBe("succeeded");
        expect(
            reduceSqlExecutionEvent(
                terminal,
                event(snapshot("e1", "running", 4)),
            ),
        ).toBe(terminal);
    });

    test("selects managed mode only from the optional capability", () => {
        expect(resolveSqlExecutionMode(undefined)).toBe("legacy");
        expect(resolveSqlExecutionMode(features(false))).toBe("legacy");
        expect(resolveSqlExecutionMode(features(true))).toBe("managed");
    });

    test("classifies active and terminal states explicitly", () => {
        expect(isActiveSqlExecutionState("starting")).toBe(true);
        expect(isActiveSqlExecutionState("canceling")).toBe(true);
        expect(isTerminalSqlExecutionState("cancelFailed")).toBe(true);
        expect(isTerminalSqlExecutionState("running")).toBe(false);
    });

    test("timeline records state changes but not every progress revision", () => {
        const starting = snapshot("e1", "starting", 1);
        const running = snapshot("e1", "running", 2);
        const progress = snapshot("e1", "running", 3);
        const succeeded = snapshot("e1", "succeeded", 4);
        const timeline = [starting, running, progress, succeeded].reduce(
            (current, value) =>
                appendSqlExecutionTimeline(
                    current,
                    value,
                    value.revision * 10,
                ),
            [] as SqlExecutionTimelineEntry[],
        );
        expect(
            timeline.map((entry) => [entry.state, entry.revision]),
        ).toEqual([
            ["starting", 1],
            ["running", 2],
            ["succeeded", 4],
        ]);
    });
});

test("SQL editor runtime defaults to a 30 second grid execution", () => {
    useTabRuntimeStateStore.getState().removeTabRuntimeState("sql-tab");
    const state = useTabRuntimeStateStore
        .getState()
        .getOrCreateSqlEditorState("sql-tab");
    expect(state.activeExecution).toBeNull();
    expect(state.lastOutcome).toBeNull();
    expect(state.executionTimeline).toEqual([]);
    expect(state.executionOptions).toEqual({
        timeoutMs: 30_000,
        resultMode: "grid",
    });
    expect(state.executionDetailOpen).toBe(false);
});

test("cancel eligibility requires managed activeCancel and a cancelable state", () => {
    const running = snapshot("e1", "running", 2);
    expect(canCancelSqlExecution(cancelFeatures(true, true), running)).toBe(true);
    expect(canCancelSqlExecution(cancelFeatures(true, false), running)).toBe(false);
    expect(canCancelSqlExecution(cancelFeatures(false, true), running)).toBe(false);
    expect(
        canCancelSqlExecution(cancelFeatures(true, true), {
            ...running,
            state: "canceling",
        }),
    ).toBe(false);
    expect(
        canCancelSqlExecution(cancelFeatures(true, true), {
            ...running,
            state: "succeeded",
        }),
    ).toBe(false);
    expect(canCancelSqlExecution(undefined, running)).toBe(false);
});
