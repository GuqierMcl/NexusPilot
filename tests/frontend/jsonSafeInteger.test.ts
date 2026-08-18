import { expect, test } from "bun:test";

import {
    compareJsonSafeInteger,
    formatJsonSafeInteger,
    jsonSafeIntegerToU32,
    parseRequestedU32Page,
} from "../../src/lib/json-safe-integer";

test("keeps exact large totals without Number coercion", () => {
    expect(formatJsonSafeInteger("18446744073709551615")).toBe(
        "18,446,744,073,709,551,615",
    );
    expect(compareJsonSafeInteger(42, "9007199254740992")).toBe(-1);
    expect(jsonSafeIntegerToU32("4294967295")).toBe(4294967295);
    expect(jsonSafeIntegerToU32("4294967296")).toBeNull();
});

test("accepts only decimal u32 page requests", () => {
    expect(parseRequestedU32Page("1")).toBe(1);
    expect(parseRequestedU32Page("4294967295")).toBe(4294967295);
    expect(parseRequestedU32Page("4294967296")).toBeNull();
    expect(parseRequestedU32Page("1e3")).toBeNull();
    expect(parseRequestedU32Page("1.5")).toBeNull();
});
