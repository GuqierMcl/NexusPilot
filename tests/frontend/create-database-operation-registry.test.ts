import { expect, test } from "bun:test";

import {
    createClickHouseCreateDatabaseOperation,
    createRelationalCreateDatabaseOperation,
    submitCreateDatabaseWithFreshPreview,
} from "../../src/features/workbench/explorer/driver-configs/create-database-operations";
import type { ClickHouseSchemaTransport } from "../../src/lib/clickhouse-schema-client";
import type {
    CreateDatabaseInput,
    CreateDatabaseResult,
    NativeSchemaMutationPreview,
    SchemaMutationPreview,
} from "../../src/types/ipc";

test("relational adapter preserves preview then execute behavior", async () => {
    const calls: string[] = [];
    const preview: SchemaMutationPreview = {
        statements: ["CREATE DATABASE app"],
        warnings: [],
        destructive: false,
        longRunning: false,
    };
    const result: CreateDatabaseResult = {
        name: "app",
        container: { kind: "database", database: "app" },
    };
    const operation = createRelationalCreateDatabaseOperation({
        preview: async (profileId, input) => {
            calls.push(`preview:${profileId}:${input.name}`);
            return preview;
        },
        execute: async (profileId, input) => {
            calls.push(`execute:${profileId}:${input.name}`);
            return result;
        },
    });
    const input: CreateDatabaseInput = { name: "app" };

    expect(await operation.preview("profile-1", input)).toBe(preview);
    expect(await operation.execute("profile-1", input, preview)).toBe(result);
    expect(operation.getResultName(result)).toBe("app");
    expect(calls).toEqual([
        "preview:profile-1:app",
        "execute:profile-1:app",
    ]);
});

class RecordingTransport implements ClickHouseSchemaTransport {
    readonly calls: Array<{
        command: string;
        args: Record<string, unknown>;
    }> = [];

    async invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
        this.calls.push({ command, args });
        if (command.startsWith("preview_")) {
            return {
                statements: ["CREATE DATABASE ` analytics `"],
                warnings: [],
                destructive: false,
                longRunning: false,
                riskFlags: [],
                requiredConfirmation: "none",
                planHash: "a".repeat(64),
            } as T;
        }
        return {
            name: " analytics ",
            container: { kind: "database", database: " analytics " },
        } as T;
    }
}

test("ClickHouse adapter uses name-only native target and binds execute to preview hash", async () => {
    const transport = new RecordingTransport();
    const operation = createClickHouseCreateDatabaseOperation(transport);
    const target = { name: " analytics " };

    const preview = await operation.preview("profile-1", target);
    const result = await operation.execute("profile-1", target, preview);

    expect(operation.getResultName(result)).toBe(" analytics ");
    expect(transport.calls).toEqual([
        {
            command: "preview_create_clickhouse_database",
            args: { profileId: "profile-1", target },
        },
        {
            command: "create_clickhouse_database",
            args: {
                profileId: "profile-1",
                request: {
                    target,
                    expectedPlanHash: "a".repeat(64),
                    confirmation: null,
                },
            },
        },
    ]);
    expect(Object.keys(target)).toEqual(["name"]);
});

test("submit always acquires a fresh preview and passes that exact object to execute", async () => {
    const displayPreview: NativeSchemaMutationPreview = {
        statements: ["display"],
        warnings: [],
        destructive: false,
        longRunning: false,
        riskFlags: [],
        requiredConfirmation: "none",
        planHash: "d".repeat(64),
    };
    const freshPreview: NativeSchemaMutationPreview = {
        statements: ["fresh"],
        warnings: [],
        destructive: false,
        longRunning: false,
        riskFlags: [],
        requiredConfirmation: "none",
        planHash: "f".repeat(64),
    };
    const previews = [displayPreview, freshPreview];
    let executePreview: NativeSchemaMutationPreview | null = null;
    let executeCalls = 0;
    const operation = {
        preview: async () => previews.shift()!,
        execute: async (
            _profileId: string,
            input: { name: string },
            preview: NativeSchemaMutationPreview,
        ) => {
            executeCalls += 1;
            executePreview = preview;
            return { name: input.name };
        },
        getResultName: (result: { name: string }) => result.name,
    };

    await operation.preview("profile-1", { name: "analytics" });
    const result = await submitCreateDatabaseWithFreshPreview(
        operation,
        "profile-1",
        { name: "analytics" },
        () => true,
    );

    expect(result).toEqual({ name: "analytics" });
    expect(executeCalls).toBe(1);
    expect(executePreview).toBe(freshPreview);
    expect(previews).toEqual([]);
});

test("fresh preview failure or stale input prevents execute", async () => {
    let executeCalls = 0;
    const failed = {
        preview: async () => {
            throw new Error("preview failed");
        },
        execute: async () => {
            executeCalls += 1;
            return { name: "never" };
        },
        getResultName: (result: { name: string }) => result.name,
    };
    await expect(
        submitCreateDatabaseWithFreshPreview(
            failed,
            "profile-1",
            { name: "analytics" },
            () => true,
        ),
    ).rejects.toThrow("preview failed");

    const stale = {
        ...failed,
        preview: async () => ({
            statements: ["fresh"],
            warnings: [],
            destructive: false,
            longRunning: false,
            riskFlags: [],
            requiredConfirmation: "none",
            planHash: "a".repeat(64),
        }),
    };
    expect(
        await submitCreateDatabaseWithFreshPreview(
            stale,
            "profile-1",
            { name: "analytics" },
            () => false,
        ),
    ).toBeNull();
    expect(executeCalls).toBe(0);
});

test("public CreateDatabaseDialog has no ClickHouse driver branch", async () => {
    const source = await Bun.file(
        "src/features/workbench/explorer/components/CreateDatabaseDialog.tsx",
    ).text();
    expect(source).not.toMatch(/connection\.driver\s*={2,3}\s*["']clickhouse["']/);
    expect(source).not.toContain('case "clickhouse"');
});
