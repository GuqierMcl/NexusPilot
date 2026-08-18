import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ClickHouseProjectionsEdit } from "../../src/features/workbench/content/components/clickhouse-table-design/tabs/clickhouse-projections-edit";
import { ClickHouseSkippingIndexesEdit } from "../../src/features/workbench/content/components/clickhouse-table-design/tabs/clickhouse-skipping-indexes-edit";
import { resolveSchemaDesignerSurface } from "../../src/features/workbench/content/schema-designer-surface-registry";
import { supportsSchemaMutation } from "../../src/lib/schema-mutation-capabilities";
import type { DriverCapabilities } from "../../src/types/ipc";

const clickHouseClosedCapabilities = {
    schemaBrowser: true,
    schemaMutator: false,
    dataTableBrowser: true,
    tableRowMutator: false,
    tableRowInserter: false,
    transactionManager: false,
    sqlExecutor: true,
    keyValueBrowser: false,
    graphQueryer: false,
    vectorSearcher: false,
} satisfies DriverCapabilities;

const postgresCapabilities = {
    ...clickHouseClosedCapabilities,
    schemaMutator: true,
    schemaMutation: {
        objects: [
            {
                kind: "table",
                operations: ["create", "alter", "drop"],
            },
        ],
        ddlPreview: true,
        destructiveConfirmation: true,
        remoteDriftProtection: true,
    },
} satisfies DriverCapabilities;

const clickHouseCreateCapabilities = {
    ...clickHouseClosedCapabilities,
    schemaMutation: {
        objects: [
            { kind: "database", operations: ["create"] },
            { kind: "table", operations: ["create"] },
        ],
        ddlPreview: true,
        destructiveConfirmation: false,
        remoteDriftProtection: false,
    },
} satisfies DriverCapabilities;

const clickHouseAlterCapabilities = {
    ...clickHouseClosedCapabilities,
    schemaMutation: {
        objects: [
            { kind: "database", operations: ["create", "drop"] },
            { kind: "table", operations: ["create", "alter", "drop"] },
            { kind: "column", operations: ["clear", "materialize"] },
        ],
        ddlPreview: true,
        destructiveConfirmation: true,
        remoteDriftProtection: true,
    },
} satisfies DriverCapabilities;

const clickHousePhaseFiveDCapabilities = {
    ...clickHouseAlterCapabilities,
    schemaMutation: {
        ...clickHouseAlterCapabilities.schemaMutation,
        objects: [
            ...clickHouseAlterCapabilities.schemaMutation.objects,
            {
                kind: "projection",
                operations: ["create", "drop", "clear", "materialize"],
            },
            {
                kind: "index",
                operations: ["create", "drop", "clear", "materialize"],
            },
        ],
    },
} satisfies DriverCapabilities;

const clickHousePhaseFiveECapabilities = {
    ...clickHousePhaseFiveDCapabilities,
    schemaMutation: {
        ...clickHousePhaseFiveDCapabilities.schemaMutation,
        objects: [
            ...clickHousePhaseFiveDCapabilities.schemaMutation.objects,
            {
                kind: "view",
                operations: ["create", "alter", "rename", "drop"],
            },
            {
                kind: "materialized_view",
                operations: ["create", "alter", "rename", "drop"],
            },
        ],
    },
} satisfies DriverCapabilities;

test("ClickHouse Phase 5B capability fixture resolves edit to the native read-only table surface", () => {
    const input = {
        driverName: "clickhouse",
        objectKind: "table",
        mode: "edit",
        capabilities: clickHouseCreateCapabilities,
    } as const;
    const surface = resolveSchemaDesignerSurface(input);
    expect(clickHouseCreateCapabilities.schemaMutator).toBe(false);
    expect(clickHouseCreateCapabilities.schemaMutation).toMatchObject({
        destructiveConfirmation: false,
        remoteDriftProtection: false,
    });
    expect(surface?.tabType).toBe("clickhouse_table_design");
    expect(surface?.canWrite(input)).toBe(false);
});

test("ClickHouse edit write controls require the exact table ALTER capability", () => {
    const input = {
        driverName: "clickhouse",
        objectKind: "table",
        mode: "edit",
        capabilities: clickHouseAlterCapabilities,
    } as const;
    const surface = resolveSchemaDesignerSurface(input);
    expect(clickHouseAlterCapabilities.schemaMutator).toBe(false);
    expect(clickHouseAlterCapabilities.schemaMutation).toEqual({
        objects: [
            { kind: "database", operations: ["create", "drop"] },
            { kind: "table", operations: ["create", "alter", "drop"] },
            { kind: "column", operations: ["clear", "materialize"] },
        ],
        ddlPreview: true,
        destructiveConfirmation: true,
        remoteDriftProtection: true,
    });
    expect(surface?.tabType).toBe("clickhouse_table_design");
    expect(surface?.canWrite(input)).toBe(true);
    for (const kind of ["projection", "index"] as const) {
        for (const operation of [
            "create",
            "drop",
            "clear",
            "materialize",
        ] as const) {
            expect(
                supportsSchemaMutation(
                    clickHouseAlterCapabilities,
                    kind,
                    operation,
                ),
            ).toBe(false);
        }
    }
});

test("Phase 5C object sections preserve definitions without enabled write actions", () => {
    const closedProps = {
        disabled: false,
        canCreate: false,
        canDrop: false,
        canClear: false,
        canMaterialize: false,
        onRequestAction: () => {
            throw new Error("closed capability must not expose an action");
        },
    };
    const projections = renderToStaticMarkup(
        createElement(ClickHouseProjectionsEdit, {
            ...closedProps,
            projections: [
                {
                    name: "by_tenant",
                    query: "SELECT tenant_id ORDER BY tenant_id",
                    editability: { mode: "editable", blockers: [] },
                },
            ],
        }),
    );
    const indexes = renderToStaticMarkup(
        createElement(ClickHouseSkippingIndexesEdit, {
            ...closedProps,
            indexes: [
                {
                    name: "message_custom",
                    expression: "message",
                    indexType: "custom_family",
                    typeArguments: ["raw"],
                    granularity: 4,
                    editability: {
                        mode: "readonly",
                        blockers: [
                            {
                                code: "unsupported_index_family",
                                path: "skippingIndexes.message_custom",
                                message: "未知索引 family 保持只读",
                            },
                        ],
                    },
                },
            ],
        }),
    );

    expect(projections).toContain("by_tenant");
    expect(projections).toContain("SELECT tenant_id ORDER BY tenant_id");
    expect(projections).not.toContain(">Drop<");
    expect(projections).not.toContain(">Materialize<");
    expect(projections).not.toContain(">Clear<");
    expect(projections).toMatch(/<button[^>]*disabled[^>]*>.*Create.*<\/button>/su);
    expect(indexes).toContain("message_custom");
    expect(indexes).toContain("custom_family(raw)");
    expect(indexes).toContain("未知索引 family 保持只读");
    expect(indexes).not.toContain(">Drop<");
    expect(indexes).not.toContain(">Materialize<");
    expect(indexes).not.toContain(">Clear<");
    expect(indexes).toMatch(/<button[^>]*disabled[^>]*>.*Create.*<\/button>/su);
});

test("Phase 5D edit surface exposes every exact protected object capability", () => {
    const input = {
        driverName: "clickhouse",
        objectKind: "table",
        mode: "edit",
        capabilities: clickHousePhaseFiveDCapabilities,
    } as const;
    const surface = resolveSchemaDesignerSurface(input);
    expect(surface?.tabType).toBe("clickhouse_table_design");
    expect(surface?.canWrite(input)).toBe(true);
    expect(clickHousePhaseFiveDCapabilities.schemaMutator).toBe(false);
    for (const kind of ["projection", "index"] as const) {
        for (const operation of [
            "create",
            "drop",
            "clear",
            "materialize",
        ] as const) {
            expect(
                supportsSchemaMutation(
                    clickHousePhaseFiveDCapabilities,
                    kind,
                    operation,
                ),
            ).toBe(true);
        }
    }
});

test("ClickHouse create remains unavailable without table create capability", () => {
    expect(
        resolveSchemaDesignerSurface({
            driverName: "clickhouse",
            objectKind: "table",
            mode: "create",
            capabilities: clickHouseClosedCapabilities,
        }),
    ).toBeNull();

    expect(
        resolveSchemaDesignerSurface({
            driverName: "clickhouse",
            objectKind: "table",
            mode: "create",
            capabilities: clickHouseCreateCapabilities,
        })?.tabType,
    ).toBe("clickhouse_table_design");
});

test("ClickHouse View and Materialized View resolve to the dedicated closed-capability surface", () => {
    for (const objectKind of ["view", "materialized_view"] as const) {
        for (const mode of ["create", "edit"] as const) {
            const input = {
                driverName: "clickhouse",
                objectKind,
                mode,
                capabilities: clickHousePhaseFiveDCapabilities,
            } as const;
            const surface = resolveSchemaDesignerSurface(input);
            expect(surface?.tabType).toBe("clickhouse_view_design");
            expect(surface?.canWrite(input)).toBe(false);
        }
    }
});

test("ClickHouse Phase 5E View and Materialized View surfaces publish write controls", () => {
    for (const objectKind of ["view", "materialized_view"] as const) {
        for (const mode of ["create", "edit"] as const) {
            const input = {
                driverName: "clickhouse",
                objectKind,
                mode,
                capabilities: clickHousePhaseFiveECapabilities,
            } as const;
            const surface = resolveSchemaDesignerSurface(input);
            expect(surface?.tabType).toBe("clickhouse_view_design");
            expect(surface?.canWrite(input)).toBe(true);
        }
    }
});

test("relational table edit continues to resolve to the shared designer", () => {
    expect(
        resolveSchemaDesignerSurface({
            driverName: "postgres",
            objectKind: "table",
            mode: "edit",
            capabilities: postgresCapabilities,
        })?.tabType,
    ).toBe("table_design");
});

test("relational table create resolves only with structured create capability", () => {
    expect(
        resolveSchemaDesignerSurface({
            driverName: "postgres",
            objectKind: "table",
            mode: "create",
            capabilities: postgresCapabilities,
        })?.tabType,
    ).toBe("table_design");

    expect(
        resolveSchemaDesignerSurface({
            driverName: "postgres",
            objectKind: "view",
            mode: "edit",
            capabilities: postgresCapabilities,
        }),
    ).toBeNull();
});

test("ClickHouse Phase 5D sections expose exact capability-gated object editors", () => {
    const projections = readFileSync(
        resolve(
            import.meta.dir,
            "../../src/features/workbench/content/components/clickhouse-table-design/tabs/clickhouse-projections-edit.tsx",
        ),
        "utf8",
    );
    const indexes = readFileSync(
        resolve(
            import.meta.dir,
            "../../src/features/workbench/content/components/clickhouse-table-design/tabs/clickhouse-skipping-indexes-edit.tsx",
        ),
        "utf8",
    );
    const view = readFileSync(
        resolve(
            import.meta.dir,
            "../../src/features/workbench/content/components/clickhouse-table-design/clickhouse-table-edit-view.tsx",
        ),
        "utf8",
    );

    expect(projections).toContain("ClickHouseProjectionsEdit");
    expect(projections).toContain("name");
    expect(projections).toContain("query");
    for (const operation of ["Drop", "Materialize", "Clear"]) {
        expect(projections).toContain(operation);
    }
    expect(projections).toContain('editability.mode === "editable"');
    expect(projections).toContain("blockers");
    expect(indexes).toContain("ClickHouseSkippingIndexesEdit");
    for (const indexType of [
        "minmax",
        "set",
        "bloom_filter",
        "ngrambf_v1",
        "tokenbf_v1",
    ]) {
        expect(indexes).toContain(indexType);
    }
    expect(indexes).toContain("granularity");
    expect(indexes).toContain("typeArguments");

    for (const capability of [
        '"projection", "create"',
        '"projection", "drop"',
        '"projection", "clear"',
        '"projection", "materialize"',
        '"index", "create"',
        '"index", "drop"',
        '"index", "clear"',
        '"index", "materialize"',
    ]) {
        expect(view).toContain(capability);
    }
    expect(view).toContain("hasTableObjectDependencies");
    expect(view).toContain("mainStructureDisabled");
    expect(view).toContain("objectActionsDisabled");
    expect(view).toContain("SchemaDdlPreviewDrawer");
    expect(view).toContain("AlertDialog");
    expect(view).not.toContain("ClickHouseProjectionsReadOnly");
    expect(view).not.toContain("ClickHouseSkippingIndexesReadOnly");
});

test("public Workbench shells remain free of ClickHouse driver-name branches", () => {
    for (const relativePath of [
        "../../src/features/workbench/content/WorkbenchContentPanel.tsx",
        "../../src/features/workbench/content/components/ContentToolbar.tsx",
        "../../src/features/workbench/explorer/WorkbenchExplorerPanel.tsx",
        "../../src/features/workbench/explorer/actions/remoteActionContributors.ts",
        "../../src/features/workbench/status-bar/WorkbenchStatusBar.tsx",
    ]) {
        const source = readFileSync(resolve(import.meta.dir, relativePath), "utf8");
        expect(source).not.toMatch(/driver\s*===\s*["']clickhouse["']/u);
        expect(source).not.toMatch(/case\s+["']clickhouse["']/u);
    }
});
