import { expect, test } from "bun:test";

import {
    resolveLastPageTarget,
    validateRequestedPageAgainstTotal,
} from "../../../../src/features/workbench/content/components/table-data/table-pagination-utils";

test("disables direct last-page navigation above u32", () => {
    expect(resolveLastPageTarget(12)).toBe(12);
    expect(resolveLastPageTarget("4294967296")).toBeNull();
});

test("compares requested pages against string totals exactly", () => {
    expect(
        validateRequestedPageAgainstTotal("42", "9007199254740992"),
    ).toBe(42);
    expect(validateRequestedPageAgainstTotal("43", 42)).toBeNull();
});
