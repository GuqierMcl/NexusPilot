import { describe, expect, test } from "bun:test";

import {
    cloneClickHouseViewDraft,
    createClickHouseViewDraft,
    validateClickHouseViewDraft,
} from "../../../../src/features/workbench/content/components/clickhouse-view-design/clickhouse-view-design-validation";
import type { ClickHouseViewFamily } from "../../../../src/types/ipc";

const families = [
    "normal",
    "parameterized",
    "temporary",
    "materialized",
    "refreshable_materialized",
    "window",
    "live",
] satisfies ClickHouseViewFamily[];

describe("ClickHouse View draft validation", () => {
    test("creates a valid exhaustive draft for every stable family", () => {
        for (const family of families) {
            const draft = createClickHouseViewDraft({
                family,
                database: family === "temporary" ? null : "analytics",
                name: `${family}_view`,
                ownerTabRuntimeId:
                    family === "temporary" ? "sql-runtime-1" : null,
            });
            expect(draft.familyDefinition.kind).toBe(family);
            expect(validateClickHouseViewDraft(draft)).toEqual([]);
        }
    });

    test("rejects cross-family, ownership and family-specific invalid state", () => {
        const temporary = createClickHouseViewDraft({
            family: "temporary",
            database: null,
            name: "session_view",
            ownerTabRuntimeId: "sql-runtime-1",
        });
        const brokenTemporary = cloneClickHouseViewDraft(temporary);
        brokenTemporary.address.database = "analytics";
        expect(validateClickHouseViewDraft(brokenTemporary).map((issue) => issue.code)).toContain(
            "temporary_database_forbidden",
        );

        const materialized = createClickHouseViewDraft({
            family: "materialized",
            database: "analytics",
            name: "events_mv",
            ownerTabRuntimeId: null,
        });
        if (materialized.familyDefinition.kind !== "materialized") {
            throw new Error("expected materialized draft");
        }
        materialized.familyDefinition.value.storage = {
            kind: "to_table",
            value: {
                target: { kind: "table", database: "analytics", table: "events" },
                targetColumns: [],
            },
        };
        materialized.familyDefinition.value.populate = true;
        expect(validateClickHouseViewDraft(materialized).map((issue) => issue.code)).toContain(
            "populate_to_conflict",
        );

        const refreshable = createClickHouseViewDraft({
            family: "refreshable_materialized",
            database: "analytics",
            name: "rollup_mv",
            ownerTabRuntimeId: null,
        });
        if (refreshable.familyDefinition.kind !== "refreshable_materialized") {
            throw new Error("expected refreshable draft");
        }
        refreshable.familyDefinition.value.refresh.dependencies = [
            { ...refreshable.address },
        ];
        expect(validateClickHouseViewDraft(refreshable).map((issue) => issue.code)).toContain(
            "dependency_cycle",
        );

        const window = createClickHouseViewDraft({
            family: "window",
            database: "analytics",
            name: "windowed",
            ownerTabRuntimeId: null,
        });
        if (window.familyDefinition.kind !== "window") {
            throw new Error("expected window draft");
        }
        window.familyDefinition.value.timeWindowFunction = "";
        expect(validateClickHouseViewDraft(window).map((issue) => issue.code)).toContain(
            "time_window_required",
        );
    });
});
