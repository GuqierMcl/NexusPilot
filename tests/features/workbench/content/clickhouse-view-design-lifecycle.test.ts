import { describe, expect, test } from "bun:test";

import {
    beginClickHouseViewDesignAction,
    canStartClickHouseViewDesignAction,
    completeClickHouseViewDesignExecution,
    createClickHouseViewDesignState,
    loadClickHouseViewDesignSchema,
    recordClickHouseViewDesignPreview,
    updateClickHouseViewDesignDraft,
} from "../../../../src/features/workbench/content/components/clickhouse-view-design/clickhouse-view-design-lifecycle";
import { createClickHouseViewDraft } from "../../../../src/features/workbench/content/components/clickhouse-view-design/clickhouse-view-design-validation";
import type {
    ClickHouseViewRuntimeSupport,
    ClickHouseViewSchema,
    NativeSchemaMutationPreview,
} from "../../../../src/types/ipc";

const supportedOperation = { state: "supported", reason: null } as const;
const familySupport = {
    describe: supportedOperation,
    create: supportedOperation,
    alter: supportedOperation,
    rename: supportedOperation,
    drop: supportedOperation,
};
const support = {
    serverVersion: "25.6",
    databaseEngine: "Atomic",
    normal: familySupport,
    parameterized: familySupport,
    temporary: familySupport,
    materialized: familySupport,
    refreshableMaterialized: familySupport,
    window: familySupport,
    live: familySupport,
    clusterDdl: {
        discoverable: true,
        executable: true,
        observable: true,
        driftVerifiable: true,
    },
    supportRevision: "support-1",
} satisfies ClickHouseViewRuntimeSupport;

const schema = {
    identity: {
        address: { database: "analytics", name: "daily", objectKind: "view" },
        uuid: "uuid-1",
    },
    family: "normal",
    scope: { kind: "local" },
    columns: { kind: "none" },
    query: "SELECT 1",
    security: { definer: null, sqlSecurity: null },
    comment: null,
    familyDefinition: { kind: "normal" },
    serverSupport: support,
    editability: { mode: "editable", blockers: [] },
    baseline: {
        canonicalCreateQuery: "CREATE VIEW analytics.daily AS SELECT 1",
        revisionHash: "revision-1",
        serverVersion: "25.6",
        family: "normal",
        supportRevision: "support-1",
    },
} satisfies ClickHouseViewSchema;

const preview = {
    statements: ["CREATE OR REPLACE VIEW `analytics`.`daily` AS SELECT 2"],
    warnings: [],
    destructive: false,
    longRunning: false,
    riskFlags: [],
    requiredConfirmation: "none",
    planHash: "plan-1",
} satisfies NativeSchemaMutationPreview;

describe("ClickHouse View design lifecycle", () => {
    test("loads verified facts and invalidates preview after draft or support drift", () => {
        const initial = createClickHouseViewDesignState({
            mode: "edit",
            family: "normal",
            draft: createClickHouseViewDraft({
                family: "normal",
                database: "analytics",
                name: "daily",
                ownerTabRuntimeId: null,
            }),
        });
        const loaded = loadClickHouseViewDesignSchema(initial, schema);
        const previewed = recordClickHouseViewDesignPreview(loaded, preview);
        expect(canStartClickHouseViewDesignAction(previewed, "apply")).toBe(true);

        const changedDraft = structuredClone(previewed.draft);
        changedDraft.query = "SELECT 2";
        const changed = updateClickHouseViewDesignDraft(previewed, changedDraft);
        expect(changed.preview).toBeNull();
        expect(canStartClickHouseViewDesignAction(changed, "apply")).toBe(false);

        const driftedSchema = structuredClone(schema);
        driftedSchema.serverSupport.supportRevision = "support-2";
        driftedSchema.baseline.supportRevision = "support-2";
        const drifted = loadClickHouseViewDesignSchema(previewed, driftedSchema);
        expect(drifted.preview).toBeNull();
    });

    test("allows only one pending schema action per tab", () => {
        const state = recordClickHouseViewDesignPreview(
            loadClickHouseViewDesignSchema(
                createClickHouseViewDesignState({
                    mode: "edit",
                    family: "normal",
                    draft: createClickHouseViewDraft({
                        family: "normal",
                        database: "analytics",
                        name: "daily",
                        ownerTabRuntimeId: null,
                    }),
                }),
                schema,
            ),
            preview,
        );
        const applying = beginClickHouseViewDesignAction(state, "apply");
        expect(applying.pendingAction).toBe("apply");
        expect(canStartClickHouseViewDesignAction(applying, "rename")).toBe(false);
        expect(() => beginClickHouseViewDesignAction(applying, "drop")).toThrow(
            "schema action",
        );
    });

    test("verified execution clears the pending action after loading returned facts", () => {
        const applying = beginClickHouseViewDesignAction(
            recordClickHouseViewDesignPreview(
                loadClickHouseViewDesignSchema(
                    createClickHouseViewDesignState({
                        mode: "edit",
                        family: "normal",
                        draft: createClickHouseViewDraft({
                            family: "normal",
                            database: "analytics",
                            name: "daily",
                            ownerTabRuntimeId: null,
                        }),
                    }),
                    schema,
                ),
                preview,
            ),
            "apply",
        );
        const completed = completeClickHouseViewDesignExecution(applying, {
            status: "applied",
            schema,
            backgroundWork: null,
        });
        expect(completed.pendingAction).toBeNull();
        expect(completed.outcome).toBe("applied");
        expect(completed.schema?.baseline.revisionHash).toBe("revision-1");
    });
});
