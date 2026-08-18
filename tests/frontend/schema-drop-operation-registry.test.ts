import { expect, test } from "bun:test";

import {
    createClickHouseDatabaseDropOperation,
    createClickHouseTableDropOperation,
    createRelationalDatabaseDropOperation,
    createRelationalTableDropOperation,
    submitSchemaDropWithFreshPreview,
} from "../../src/features/workbench/explorer/driver-configs/schema-drop-operations";
import { getDriverConfig } from "../../src/features/workbench/explorer/driver-configs";
import type { ClickHouseSchemaTransport } from "../../src/lib/clickhouse-schema-client";
import type {
    ClickHouseTableSchema,
    ContainerRef,
    NativeSchemaChangePlan,
} from "../../src/types/ipc";

const tableContainer: ContainerRef = {
    kind: "table",
    database: "analytics",
    table: "events",
};
const databaseContainer: ContainerRef = {
    kind: "database",
    database: "analytics",
};
const schema: ClickHouseTableSchema = {
    identity: {
        database: "analytics",
        name: "events",
        objectKind: "table",
        uuid: null,
    },
    engine: { family: "MergeTree", arguments: [], rawExpression: "MergeTree" },
    columns: [],
    keys: {
        orderBy: "tuple()",
        partitionBy: null,
        primaryKey: null,
        sampleBy: null,
    },
    tableTtl: null,
    comment: null,
    settings: [],
    projections: [],
    skippingIndexes: [],
    editability: { mode: "editable", blockers: [] },
    baseline: {
        canonicalCreateQuery:
            "CREATE TABLE analytics.events ENGINE = MergeTree ORDER BY tuple()",
        revisionHash: "0".repeat(64),
    },
};

function tablePlan(planHash: string): NativeSchemaChangePlan {
    return {
        statements: ["DROP TABLE `analytics`.`events`"],
        warnings: [],
        destructive: true,
        longRunning: false,
        riskFlags: ["destructive"],
        requiredConfirmation: "confirm",
        planHash,
        expectedTargetRevision: null,
        operations: [
            {
                code: "drop_table",
                objectName: "events",
                destructive: true,
                longRunning: false,
            },
        ],
        baseline: { kind: "clickhouse_table", baseline: schema },
    };
}

class FakeTransport implements ClickHouseSchemaTransport {
    readonly calls: Array<{
        command: string;
        args: Record<string, unknown>;
    }> = [];
    private previewCount = 0;

    async invoke<T>(
        command: string,
        args: Record<string, unknown>,
    ): Promise<T> {
        this.calls.push({ command, args });
        if (command === "preview_drop_clickhouse_table") {
            this.previewCount += 1;
            return tablePlan(`plan-${this.previewCount}`) as T;
        }
        if (command === "drop_clickhouse_table") {
            return {
                status: "applied",
                progress: {
                    appliedCount: 1,
                    failedStatementIndex: null,
                    remainingCount: 0,
                    queryIds: ["query-1"],
                },
                container: tableContainer,
                tableName: "events",
                absent: true,
            } as T;
        }
        throw new Error(`unexpected command ${command}`);
    }
}

test("ClickHouse table drop executes only the current fresh preview", async () => {
    const transport = new FakeTransport();
    const operation = createClickHouseTableDropOperation(transport);
    const stale = await operation.preview("p1", tableContainer);
    const displayed = await operation.preview("p1", tableContainer);
    const result = await submitSchemaDropWithFreshPreview(
        operation,
        "p1",
        tableContainer,
        () => true,
    );

    expect(stale.planHash === displayed.planHash).toBe(false);
    expect(transport.calls[3]).toEqual({
        command: "drop_clickhouse_table",
        args: {
            profileId: "p1",
            request: {
                target: {
                    kind: "clickhouse_table_drop",
                    target: { container: tableContainer },
                },
                baseline: tablePlan("plan-3").baseline,
                expectedPlanHash: "plan-3",
                confirmation: {
                    accepted: true,
                    objectName: null,
                    clusterName: null,
                },
            },
        },
    });
    expect(result).toEqual({ name: "events", container: tableContainer });
});

test("stale final preview never executes", async () => {
    let executeCalls = 0;
    const operation = {
        preview: async () => tablePlan("fresh"),
        execute: async () => {
            executeCalls += 1;
            return { status: "outcomeUnknown" as const };
        },
        toAppliedResult: () => null,
    };

    const result = await submitSchemaDropWithFreshPreview(
        operation,
        "p1",
        tableContainer,
        () => false,
    );

    expect(result).toBe(null);
    expect(executeCalls).toBe(0);
});

test("relational adapters preserve existing command inputs and project generic success", async () => {
    const tableCalls: unknown[] = [];
    const tableOperation = createRelationalTableDropOperation({
        preview: async (profileId, input) => {
            tableCalls.push(["preview", profileId, input]);
            return { statements: ["DROP TABLE events"] };
        },
        execute: async (profileId, input) => {
            tableCalls.push(["execute", profileId, input]);
            return { container: tableContainer, tableName: "events" };
        },
    });
    const tablePreview = await tableOperation.preview("p1", tableContainer);
    const tableResult = await tableOperation.execute(
        "p1",
        tableContainer,
        tablePreview,
        true,
    );

    expect(tableCalls).toEqual([
        ["preview", "p1", { container: tableContainer }],
        [
            "execute",
            "p1",
            { container: tableContainer, confirmDestructive: true },
        ],
    ]);
    expect(tableOperation.toAppliedResult(tableResult)).toEqual({
        name: "events",
        container: tableContainer,
    });

    const databaseCalls: unknown[] = [];
    const databaseOperation = createRelationalDatabaseDropOperation({
        preview: async (profileId, input) => {
            databaseCalls.push(["preview", profileId, input]);
            return { statements: ["DROP DATABASE analytics"] };
        },
        execute: async (profileId, input) => {
            databaseCalls.push(["execute", profileId, input]);
            return { name: "analytics" };
        },
    });
    const databasePreview = await databaseOperation.preview(
        "p1",
        databaseContainer,
    );
    const databaseResult = await databaseOperation.execute(
        "p1",
        databaseContainer,
        databasePreview,
        true,
    );

    expect(databaseCalls).toEqual([
        ["preview", "p1", { container: databaseContainer }],
        ["execute", "p1", { container: databaseContainer }],
    ]);
    expect(databaseOperation.toAppliedResult(databaseResult)).toEqual({
        name: "analytics",
        container: databaseContainer,
    });
});

test("driver registry selects drop operations without public driver branching", () => {
    for (const driver of ["mysql", "postgres", "oracle"] as const) {
        expect(getDriverConfig(driver).dropTable == null).toBe(false);
        expect(getDriverConfig(driver).dropDatabase == null).toBe(false);
    }
    expect(getDriverConfig("clickhouse").dropTable == null).toBe(false);
    expect(getDriverConfig("clickhouse").dropDatabase == null).toBe(false);
    expect(getDriverConfig("redis").dropTable == null).toBe(true);
    expect(getDriverConfig("sqlite").dropDatabase == null).toBe(true);
});

test("ClickHouse database operation keeps unknown result unapplied", () => {
    const operation = createClickHouseDatabaseDropOperation({
        invoke: async () => {
            throw new Error("not called");
        },
    });
    expect(
        operation.toAppliedResult({
            status: "outcomeUnknown",
            progress: {
                appliedCount: 0,
                failedStatementIndex: null,
                remainingCount: 0,
                queryIds: ["query-1"],
            },
            container: databaseContainer,
            name: "analytics",
            absent: false,
        }),
    ).toBe(null);
});

test("public drop dialogs use registration and the fresh-preview submit gate", async () => {
    for (const file of [
        "src/features/workbench/explorer/components/DeleteTableDialog.tsx",
        "src/features/workbench/explorer/components/DeleteDatabaseDialog.tsx",
    ]) {
        const source = await Bun.file(file).text();
        expect(source.includes("submitSchemaDropWithFreshPreview")).toBe(true);
        expect(source.includes("driverConfig")).toBe(true);
        expect(source.includes("@/lib/tauri/schema-mutations")).toBe(false);
        expect(source.includes('driver === "clickhouse"')).toBe(false);
        expect(source.includes('case "clickhouse"')).toBe(false);
    }
});
