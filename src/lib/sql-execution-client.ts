import { Channel } from "@tauri-apps/api/core";

import { apiInvoke } from "@/lib/api-client";
import type {
    SqlExecutionEvent,
    SqlExecutionHandle,
    SqlExecutionSnapshot,
    StartSqlExecutionRequest,
} from "@/types/ipc";

export interface SqlExecutionChannel<T> {
    onmessage: ((message: T) => void) | null;
}

export interface SqlExecutionTransport {
    createChannel<T>(): SqlExecutionChannel<T>;
    invoke<T>(command: string, args: Record<string, unknown>): Promise<T>;
}

export interface StartSqlExecutionInput {
    profileId: string;
    tabId: string;
    request: StartSqlExecutionRequest;
    onEvent: (event: SqlExecutionEvent) => void;
}

export interface SaveSqlExecutionArtifactInput {
    profileId: string;
    tabId: string;
    executionId: string;
    artifactId: string;
    destinationPath: string;
}

class TauriSqlExecutionTransport implements SqlExecutionTransport {
    createChannel<T>(): SqlExecutionChannel<T> {
        return new Channel<T>();
    }

    invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
        return apiInvoke<T>(command, args);
    }
}

export const defaultSqlExecutionTransport: SqlExecutionTransport =
    new TauriSqlExecutionTransport();

export async function startSqlExecution(
    transport: SqlExecutionTransport,
    input: StartSqlExecutionInput,
): Promise<SqlExecutionHandle> {
    const channel = transport.createChannel<SqlExecutionEvent>();
    channel.onmessage = input.onEvent;
    return transport.invoke<SqlExecutionHandle>("start_sql_execution", {
        profileId: input.profileId,
        tabId: input.tabId,
        request: input.request,
        onEvent: channel,
    });
}

export function getSqlExecutionSnapshot(
    transport: SqlExecutionTransport,
    profileId: string,
    tabId: string,
    executionId: string,
): Promise<SqlExecutionSnapshot> {
    return transport.invoke<SqlExecutionSnapshot>("get_sql_execution_snapshot", {
        profileId,
        tabId,
        executionId,
    });
}

export function cancelSqlExecution(
    transport: SqlExecutionTransport,
    profileId: string,
    tabId: string,
    executionId: string,
): Promise<SqlExecutionSnapshot> {
    return transport.invoke<SqlExecutionSnapshot>("cancel_sql_execution", {
        profileId,
        tabId,
        executionId,
    });
}

export function releaseSqlExecution(
    transport: SqlExecutionTransport,
    profileId: string,
    tabId: string,
    executionId: string,
): Promise<void> {
    return transport.invoke<void>("release_sql_execution", {
        profileId,
        tabId,
        executionId,
    });
}

export function saveSqlExecutionArtifact(
    transport: SqlExecutionTransport,
    input: SaveSqlExecutionArtifactInput,
): Promise<void> {
    return transport.invoke<void>("save_sql_execution_artifact", {
        profileId: input.profileId,
        tabId: input.tabId,
        executionId: input.executionId,
        artifactId: input.artifactId,
        destinationPath: input.destinationPath,
    });
}
