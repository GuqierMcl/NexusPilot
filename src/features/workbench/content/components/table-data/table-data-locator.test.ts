import { describe, expect, test } from "bun:test";

import type { TableDataChangeSet } from "@/store";

import { changeSetToRequest, rowLocatorToId } from "./table-data-utils";

describe("DataTable row locator contract", () => {
    test("keeps primary-key and row-snapshot locators distinct", () => {
        const primaryKey = {
            kind: "primaryKey" as const,
            parts: [{ column: "id", value: 1 }],
        };
        const rowSnapshot = {
            kind: "rowSnapshot" as const,
            parts: [
                { column: "id", value: 1 },
                { column: "name", value: "before" },
            ],
            expectedMatches: 1,
        };

        expect(rowLocatorToId(primaryKey) === rowLocatorToId(rowSnapshot)).toBe(false);
    });

    test("serializes neutral locators without overloading a primaryKey field", () => {
        const locator = {
            kind: "rowSnapshot" as const,
            parts: [
                { column: "id", value: "18446744073709551615" },
                { column: "name", value: "before" },
            ],
            expectedMatches: 1,
        };
        const changeSet: TableDataChangeSet = {
            inserts: {},
            updates: {
                row: {
                    locator,
                    changes: { name: "after" },
                },
            },
            deletes: {},
        };

        const request = changeSetToRequest(changeSet);

        expect(request.updates[0]?.locator).toEqual(locator);
        expect("primaryKey" in request.updates[0]!).toBe(false);
    });
});
