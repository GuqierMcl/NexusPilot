import { expect, test } from "bun:test";

import { supportsSchemaMutation } from "../../src/lib/schema-mutation-capabilities";
import type { DriverCapabilities } from "../../src/types/ipc";

const capabilities: DriverCapabilities = {
    schemaBrowser: true,
    schemaMutator: true,
    schemaMutation: {
        objects: [
            {
                kind: "database",
                operations: ["create", "alter", "drop"],
            },
            {
                kind: "table",
                operations: ["create", "alter", "drop"],
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
};

test("supportsSchemaMutation checks the requested object operation", () => {
    expect(supportsSchemaMutation(capabilities, "table", "alter")).toBe(true);
    expect(supportsSchemaMutation(capabilities, "table", "clear")).toBe(false);
    expect(supportsSchemaMutation(capabilities, "view", "create")).toBe(false);
    expect(supportsSchemaMutation(undefined, "table", "create")).toBe(false);
});

test("legacy schemaMutator and native extension availability do not publish operations", () => {
    const closedCapabilities: DriverCapabilities = {
        ...capabilities,
        schemaMutator: false,
        schemaMutation: undefined,
    };

    for (const kind of ["database", "table"] as const) {
        for (const operation of ["create", "alter", "drop"] as const) {
            expect(
                supportsSchemaMutation(
                    closedCapabilities,
                    kind,
                    operation,
                ),
            ).toBe(false);
        }
    }
});

test("ClickHouse Phase 5B publishes only database and table create", () => {
    const clickHouseCapabilities: DriverCapabilities = {
        ...capabilities,
        schemaMutator: false,
        schemaMutation: {
            objects: [
                { kind: "database", operations: ["create"] },
                { kind: "table", operations: ["create"] },
            ],
            ddlPreview: true,
            destructiveConfirmation: false,
            remoteDriftProtection: false,
        },
    };

    expect(
        supportsSchemaMutation(clickHouseCapabilities, "database", "create"),
    ).toBe(true);
    expect(
        supportsSchemaMutation(clickHouseCapabilities, "table", "create"),
    ).toBe(true);
    for (const kind of ["database", "table"] as const) {
        for (const operation of ["alter", "drop"] as const) {
            expect(
                supportsSchemaMutation(
                    clickHouseCapabilities,
                    kind,
                    operation,
                ),
            ).toBe(false);
        }
    }
});

test("ClickHouse Phase 5C keeps every Phase 5D object operation closed", () => {
    const phaseFiveC: DriverCapabilities = {
        ...capabilities,
        schemaMutator: false,
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
    };

    for (const kind of ["projection", "index"] as const) {
        for (const operation of [
            "create",
            "drop",
            "clear",
            "materialize",
        ] as const) {
            expect(supportsSchemaMutation(phaseFiveC, kind, operation)).toBe(
                false,
            );
        }
    }

    const projectionCreateOnly: DriverCapabilities = {
        ...phaseFiveC,
        schemaMutation: {
            ...phaseFiveC.schemaMutation!,
            objects: [
                ...phaseFiveC.schemaMutation!.objects,
                { kind: "projection", operations: ["create"] },
            ],
        },
    };
    expect(
        supportsSchemaMutation(projectionCreateOnly, "projection", "create"),
    ).toBe(true);
    expect(
        supportsSchemaMutation(projectionCreateOnly, "projection", "drop"),
    ).toBe(false);
    expect(
        supportsSchemaMutation(projectionCreateOnly, "index", "create"),
    ).toBe(false);
});

test("ClickHouse Phase 5D publishes the exact protected object matrix", () => {
    const phaseFiveD: DriverCapabilities = {
        ...capabilities,
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
            ],
            ddlPreview: true,
            destructiveConfirmation: true,
            remoteDriftProtection: true,
        },
    };

    expect(phaseFiveD.schemaMutator).toBe(false);
    for (const kind of ["projection", "index"] as const) {
        for (const operation of [
            "create",
            "drop",
            "clear",
            "materialize",
        ] as const) {
            expect(supportsSchemaMutation(phaseFiveD, kind, operation)).toBe(
                true,
            );
        }
    }
    expect(phaseFiveD.schemaMutation).toMatchObject({
        ddlPreview: true,
        destructiveConfirmation: true,
        remoteDriftProtection: true,
    });
    for (const kind of ["view", "materialized_view"] as const) {
        for (const operation of ["create", "alter", "rename", "drop"] as const) {
            expect(supportsSchemaMutation(phaseFiveD, kind, operation)).toBe(
                false,
            );
        }
    }
});

test("ClickHouse Phase 5E baseline adds exact View and Materialized View operations", () => {
    const phaseFiveE: DriverCapabilities = {
        ...capabilities,
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
    };

    expect(phaseFiveE.schemaMutator).toBe(false);
    for (const kind of ["view", "materialized_view"] as const) {
        for (const operation of ["create", "alter", "rename", "drop"] as const) {
            expect(supportsSchemaMutation(phaseFiveE, kind, operation)).toBe(true);
        }
    }
});
