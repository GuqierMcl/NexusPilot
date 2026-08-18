import { expect, test } from "bun:test";

import {
    cancelSqlExecution,
    getSqlExecutionSnapshot,
    releaseSqlExecution,
    saveSqlExecutionArtifact,
    startSqlExecution,
    type SqlExecutionChannel,
    type SqlExecutionTransport,
} from "../../src/lib/sql-execution-client";
import type {
    SqlExecutionEvent,
    SqlExecutionHandle,
    SqlExecutionSnapshot,
    StartSqlExecutionRequest,
} from "../../src/types/ipc";

function snapshot(revision: number): SqlExecutionSnapshot {
    return {
        executionId: "execution-1",
        queryId: "query-1",
        tabId: "tab-1",
        state: "running",
        revision,
        statementClass: "read",
        startedAt: 1,
        finishedAt: null,
        progressAvailable: false,
        summary: null,
        outcome: null,
        failure: null,
        cancelMessage: null,
    };
}

function request(sql: string): StartSqlExecutionRequest {
    return {
        context: {},
        sql,
        options: {
            resultMode: "grid",
            timeoutMs: 30_000,
            page: 1,
            pageSize: 100,
        },
    };
}

class FakeTransport implements SqlExecutionTransport {
    readonly commands: string[] = [];
    readonly calls: Array<{
        command: string;
        args: Record<string, unknown>;
    }> = [];
    private channel: SqlExecutionChannel<SqlExecutionEvent> | null = null;

    createChannel<T>(): SqlExecutionChannel<T> {
        const channel: SqlExecutionChannel<T> = { onmessage: null };
        this.channel = channel as SqlExecutionChannel<SqlExecutionEvent>;
        return channel;
    }

    async invoke<T>(
        command: string,
        args: Record<string, unknown>,
    ): Promise<T> {
        this.commands.push(command);
        this.calls.push({ command, args });
        if (command === "start_sql_execution") {
            return {
                executionId: "execution-1",
                queryId: "query-1",
                tabId: "tab-1",
                state: "starting",
                startedAt: 1,
            } as T;
        }
        return snapshot(2) as T;
    }

    emit(event: SqlExecutionEvent): void {
        this.channel?.onmessage?.(event);
    }
}

test("managed start forwards channel snapshots and exposes reconciliation commands", async () => {
    const events: SqlExecutionEvent[] = [];
    const fake = new FakeTransport();
    const handle: SqlExecutionHandle = await startSqlExecution(fake, {
        profileId: "p",
        tabId: "t",
        request: request("SELECT 1"),
        onEvent: (event) => events.push(event),
    });

    fake.emit({ kind: "snapshot", snapshot: snapshot(2) });
    expect(handle.executionId).toBe("execution-1");
    expect(events[0]?.snapshot.revision).toBe(2);
    await getSqlExecutionSnapshot(fake, "p", "t", "execution-1");
    await cancelSqlExecution(fake, "p", "t", "execution-1");
    await releaseSqlExecution(fake, "p", "t", "execution-1");
    expect(fake.commands).toEqual([
        "start_sql_execution",
        "get_sql_execution_snapshot",
        "cancel_sql_execution",
        "release_sql_execution",
    ]);
});

test("artifact save forwards opaque ownership and destination arguments", async () => {
    const fake = new FakeTransport();

    await saveSqlExecutionArtifact(fake, {
        profileId: "profile-1",
        tabId: "runtime-tab-1",
        executionId: "execution-1",
        artifactId: "artifact-1",
        destinationPath: "D:\\exports\\result.csv",
    });

    expect(fake.calls.at(-1)).toEqual({
        command: "save_sql_execution_artifact",
        args: {
            profileId: "profile-1",
            tabId: "runtime-tab-1",
            executionId: "execution-1",
            artifactId: "artifact-1",
            destinationPath: "D:\\exports\\result.csv",
        },
    });
});
