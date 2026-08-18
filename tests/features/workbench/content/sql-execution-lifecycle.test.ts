import { expect, test } from "bun:test";
import { join } from "node:path";

import {
    executeSqlLifecycle,
    toStartRequest,
    type SqlExecutionLifecycleDependencies,
    type SqlExecutionRunInput,
} from "../../../../src/features/workbench/content/components/sql-editor/sql-execution-lifecycle";
import type {
    QueryResult,
    SqlExecutionHandle,
    SqlExecutionSnapshot,
} from "../../../../src/types/ipc";
import { resolveSqlExecutionResultMode } from "../../../../src/features/workbench/content/components/sql-editor/useSqlExecutionLifecycle";

test("per-run result mode overrides without changing the Grid tab default", () => {
    const tabDefault = "grid" as const;

    expect(resolveSqlExecutionResultMode("raw", tabDefault)).toBe("raw");
    expect(resolveSqlExecutionResultMode(undefined, tabDefault)).toBe("grid");
    expect(tabDefault).toBe("grid");
});

test("React adapter keeps UI and runtime tab identities separate without driver routing", async () => {
    const source = await Bun.file(
        join(
            import.meta.dir,
            "../../../../src/features/workbench/content/components/sql-editor/useSqlExecutionLifecycle.ts",
        ),
    ).text();

    expect(source).toContain("tabId");
    expect(source).toContain("runtimeTabId");
    expect(source).toContain("generationRef");
    expect(source).toContain("resolveSqlExecutionMode");
    expect(source).toContain("input.onSnapshot?.(snapshot)");
    expect(source).toContain("const { onSnapshot: _onSnapshot, ...runInput } = input");
    expect(source).toContain("...runInput");
    expect(source).toContain("resolveSqlExecutionResultMode");
    expect(source).not.toContain("driverName");
});

test("managed request preserves context, SQL, paging, timeout, and result mode", () => {
    expect(toStartRequest(managedRunInput())).toEqual({
        context: { database: "default", schema: null },
        sql: "SELECT 1",
        options: {
            resultMode: "grid",
            timeoutMs: 30_000,
            page: 1,
            pageSize: 100,
        },
    });
});

test("managed execution reaches terminal state through snapshot reconciliation when channel is silent", async () => {
    const snapshots: SqlExecutionSnapshot[] = [];
    const running = managedSnapshot("running", 2);
    const succeeded = managedSnapshot("succeeded", 3);
    const fake = createFakeLifecycle({
        startHandle: managedHandle(),
        reconciliations: [running, succeeded],
        onSnapshot: (value) => snapshots.push(value),
    });

    const terminal = await executeSqlLifecycle(
        fake.dependencies,
        managedRunInput(),
    );

    expect(terminal.state).toBe("succeeded");
    expect(snapshots.map((value) => value.revision)).toEqual([2, 3]);
    expect(fake.commands).toEqual([
        "start_sql_execution",
        "get_sql_execution_snapshot",
        "get_sql_execution_snapshot",
    ]);
});

test("managed execution keeps a newer channel snapshot emitted before the handle returns", async () => {
    const snapshots: SqlExecutionSnapshot[] = [];
    const fake = createFakeLifecycle({
        startEvent: managedSnapshot("running", 2),
        reconciliations: [managedSnapshot("succeeded", 3)],
        onSnapshot: (value) => snapshots.push(value),
    });

    const terminal = await executeSqlLifecycle(
        fake.dependencies,
        managedRunInput(),
    );

    expect(terminal.state).toBe("succeeded");
    expect(snapshots.map((value) => value.revision)).toEqual([2, 3]);
});

test("legacy execution never calls managed commands and wraps rows outcome", async () => {
    const snapshots: SqlExecutionSnapshot[] = [];
    const fake = createFakeLifecycle({
        legacyResult: rowsResult([[1]]),
        onSnapshot: (value) => snapshots.push(value),
    });

    const terminal = await executeSqlLifecycle(
        fake.dependencies,
        legacyRunInput(),
    );

    expect(terminal.state).toBe("succeeded");
    expect(terminal.outcome?.kind).toBe("rows");
    expect(snapshots.map((value) => value.state)).toEqual([
        "starting",
        "succeeded",
    ]);
    expect(fake.commands).toEqual([]);
    expect(fake.legacyInputs).toHaveLength(1);
});

test("legacy execution normalizes a query failure into a terminal snapshot", async () => {
    const fake = createFakeLifecycle({
        legacyError: {
            code: "QUERY_SYNTAX_ERROR",
            runtimeImpact: "businessOnly",
            message: "syntax error",
        },
    });

    const terminal = await executeSqlLifecycle(
        fake.dependencies,
        legacyRunInput(),
    );

    expect(terminal.state).toBe("failed");
    expect(terminal.failure?.code).toBe("QUERY_SYNTAX_ERROR");
    expect(terminal.outcome).toBeNull();
});

test("reconciliation failure is diagnostic only and the next snapshot may finish", async () => {
    const diagnostics: unknown[] = [];
    const fake = createFakeLifecycle({
        reconciliations: [
            new Error("channel gap"),
            managedSnapshot("succeeded", 4),
        ],
        onReconciliationError: (error) => diagnostics.push(error),
    });

    const terminal = await executeSqlLifecycle(
        fake.dependencies,
        managedRunInput(),
    );

    expect(terminal.state).toBe("succeeded");
    expect(diagnostics).toHaveLength(1);
});

function managedHandle(): SqlExecutionHandle {
    return {
        executionId: "execution-1",
        queryId: "query-1",
        tabId: "runtime-tab",
        state: "starting",
        startedAt: 1,
    };
}

function managedSnapshot(
    state: SqlExecutionSnapshot["state"],
    revision: number,
): SqlExecutionSnapshot {
    return {
        ...managedHandle(),
        state,
        revision,
        statementClass: "read",
        finishedAt: state === "succeeded" ? 2 : null,
        progressAvailable: false,
        summary: null,
        outcome:
            state === "succeeded"
                ? { kind: "rows", result: rowsResult([[1]]) }
                : null,
        failure: null,
        cancelMessage: null,
    };
}

function rowsResult(rows: unknown[][]): QueryResult {
    return {
        columns: [],
        rows,
        hasNextPage: false,
        sourceWritable: false,
        sourceInsertable: false,
        primaryKeyColumns: [],
        stableOrderColumns: [],
    };
}

function managedRunInput(): SqlExecutionRunInput {
    return {
        mode: "managed",
        profileId: "profile-1",
        runtimeTabId: "runtime-tab",
        context: { database: "default", schema: null },
        sql: "SELECT 1",
        page: 1,
        pageSize: 100,
        timeoutMs: 30_000,
        resultMode: "grid",
    };
}

function legacyRunInput(): SqlExecutionRunInput {
    return { ...managedRunInput(), mode: "legacy" };
}

interface FakeLifecycleOptions {
    startHandle?: SqlExecutionHandle;
    startEvent?: SqlExecutionSnapshot;
    reconciliations?: Array<SqlExecutionSnapshot | Error>;
    legacyResult?: QueryResult;
    legacyError?: unknown;
    onSnapshot?: (snapshot: SqlExecutionSnapshot) => void;
    onReconciliationError?: (error: unknown) => void;
}

function createFakeLifecycle(options: FakeLifecycleOptions = {}) {
    const commands: string[] = [];
    const legacyInputs: SqlExecutionRunInput[] = [];
    const reconciliations = [
        ...(options.reconciliations ?? [managedSnapshot("succeeded", 2)]),
    ];
    const dependencies: SqlExecutionLifecycleDependencies = {
        startManaged: async (input) => {
            commands.push("start_sql_execution");
            if (options.startEvent) {
                input.onEvent({ kind: "snapshot", snapshot: options.startEvent });
            }
            return options.startHandle ?? managedHandle();
        },
        getManagedSnapshot: async () => {
            commands.push("get_sql_execution_snapshot");
            const next =
                reconciliations.shift() ?? managedSnapshot("succeeded", 9);
            if (next instanceof Error) throw next;
            return next;
        },
        executeLegacy: async (input) => {
            legacyInputs.push(input);
            if (options.legacyError !== undefined) {
                throw options.legacyError;
            }
            return options.legacyResult ?? rowsResult([[1]]);
        },
        waitForReconciliation: async () => undefined,
        now: () => 2,
        createLegacyId: () => "legacy-1",
        onSnapshot: options.onSnapshot ?? (() => undefined),
        onReconciliationError:
            options.onReconciliationError ?? (() => undefined),
    };
    return { dependencies, commands, legacyInputs };
}
