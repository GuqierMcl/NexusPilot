import { expect, test } from "bun:test";

import {
    buildClickHouseTableDesignTabOpenRequest,
} from "../../src/features/workbench/content/content-tab-lifecycle-registry";
import { resolveSchemaDesignerSurface } from "../../src/features/workbench/content/schema-designer-surface-registry";
import {
    alterClickHouseTable,
    dropClickHouseDatabase,
    dropClickHouseTable,
    executeClickHouseProjectionChange,
    executeClickHouseSkippingIndexChange,
    executeClickHouseColumnAction,
    previewAlterClickHouseTable,
    previewClickHouseColumnAction,
    previewDropClickHouseDatabase,
    previewDropClickHouseTable,
    previewClickHouseProjectionChange,
    previewClickHouseSkippingIndexChange,
} from "../../src/lib/clickhouse-schema-client";
import { supportsSchemaMutation } from "../../src/lib/schema-mutation-capabilities";
import { useWorkbenchTabsStore } from "../../src/store/slices/workbench-tabs-slice";
import type { DriverCapabilities } from "../../src/types/ipc";

const publishedClickHouseCapabilities = {
    schemaBrowser: true,
    schemaMutator: false,
    schemaMutation: {
        objects: [
            { kind: "database", operations: ["create", "drop"] },
            { kind: "table", operations: ["create", "alter", "drop"] },
            { kind: "column", operations: ["clear", "materialize"] },
            {
                kind: "projection",
                operations: ["create", "drop", "clear", "materialize"],
            },
            {
                kind: "index",
                operations: ["create", "drop", "clear", "materialize"],
            },
            {
                kind: "view",
                operations: ["create", "alter", "rename", "drop"],
            },
            {
                kind: "materialized_view",
                operations: ["create", "alter", "rename", "drop"],
            },
        ],
        ddlPreview: true,
        destructiveConfirmation: true,
        remoteDriftProtection: true,
    },
    dataTableBrowser: true,
    tableRowMutator: false,
    tableRowInserter: false,
    transactionManager: false,
    sqlExecutor: true,
    keyValueBrowser: false,
    graphQueryer: false,
    vectorSearcher: false,
} satisfies DriverCapabilities;

const database = {
    kind: "database",
    database: "analytics",
} as const;

test("ClickHouse Phase 5E baseline clients and write surface use the published exact capability", () => {
    expect([
        previewAlterClickHouseTable,
        alterClickHouseTable,
        previewClickHouseColumnAction,
        executeClickHouseColumnAction,
        previewDropClickHouseTable,
        dropClickHouseTable,
        previewDropClickHouseDatabase,
        dropClickHouseDatabase,
        previewClickHouseProjectionChange,
        executeClickHouseProjectionChange,
        previewClickHouseSkippingIndexChange,
        executeClickHouseSkippingIndexChange,
    ].every((client) => typeof client === "function")).toBe(true);

    expect(publishedClickHouseCapabilities.schemaMutator).toBe(false);
    expect(publishedClickHouseCapabilities.schemaMutation).toEqual({
        objects: [
            { kind: "database", operations: ["create", "drop"] },
            { kind: "table", operations: ["create", "alter", "drop"] },
            { kind: "column", operations: ["clear", "materialize"] },
            {
                kind: "projection",
                operations: ["create", "drop", "clear", "materialize"],
            },
            {
                kind: "index",
                operations: ["create", "drop", "clear", "materialize"],
            },
            {
                kind: "view",
                operations: ["create", "alter", "rename", "drop"],
            },
            {
                kind: "materialized_view",
                operations: ["create", "alter", "rename", "drop"],
            },
        ],
        ddlPreview: true,
        destructiveConfirmation: true,
        remoteDriftProtection: true,
    });
    for (const kind of ["projection", "index"] as const) {
        for (const operation of [
            "create",
            "drop",
            "clear",
            "materialize",
        ] as const) {
            expect(
                supportsSchemaMutation(
                    publishedClickHouseCapabilities,
                    kind,
                    operation,
                ),
            ).toBe(true);
        }
    }
    for (const kind of ["view", "materialized_view"] as const) {
        for (const operation of ["create", "alter", "rename", "drop"] as const) {
            expect(
                supportsSchemaMutation(
                    publishedClickHouseCapabilities,
                    kind,
                    operation,
                ),
            ).toBe(true);
        }
    }

    const editInput = {
        driverName: "clickhouse",
        objectKind: "table",
        mode: "edit",
        capabilities: publishedClickHouseCapabilities,
    } as const;
    const editSurface = resolveSchemaDesignerSurface(editInput);
    expect(editSurface?.tabType).toBe("clickhouse_table_design");
    expect(editSurface?.canWrite(editInput)).toBe(true);
});

test("ClickHouse create opens only through the published capability gate", () => {
    expect(
        resolveSchemaDesignerSurface({
            driverName: "clickhouse",
            objectKind: "table",
            mode: "create",
            capabilities: publishedClickHouseCapabilities,
        }),
    ).toMatchObject({ tabType: "clickhouse_table_design" });
    expect(
        resolveSchemaDesignerSurface({
            driverName: "clickhouse",
            objectKind: "table",
            mode: "edit",
            capabilities: publishedClickHouseCapabilities,
        })?.tabType,
    ).toBe("clickhouse_table_design");

    const manualRequest = buildClickHouseTableDesignTabOpenRequest(
        "profile-1",
        { mode: "create", parentContainer: database },
    );
    expect(manualRequest.type).toBe("clickhouse_table_design");
    expect(manualRequest.payload.mode).toBe("create");

    const previous = useWorkbenchTabsStore.getState();
    useWorkbenchTabsStore.setState({ tabs: [], activeTabId: null });
    try {
        useWorkbenchTabsStore.getState().openSchemaDesignTab(
            "profile-1",
            "clickhouse",
            publishedClickHouseCapabilities,
            {
                mode: "create",
                objectKind: "table",
                parentContainer: database,
            },
        );
        expect(useWorkbenchTabsStore.getState().tabs).toHaveLength(1);
        expect(useWorkbenchTabsStore.getState().tabs[0]).toMatchObject({
            type: "clickhouse_table_design",
            payload: {
                mode: "create",
                container: null,
                parentContainer: database,
            },
        });
    } finally {
        useWorkbenchTabsStore.setState({
            tabs: previous.tabs,
            activeTabId: previous.activeTabId,
        });
    }
});
