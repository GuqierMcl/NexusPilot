import type { JsonSafeInteger } from "@/types/ipc";

const DECIMAL_INTEGER_PATTERN = /^(0|[1-9]\d*)$/;
const U32_MAX = 4_294_967_295n;

function parseJsonSafeInteger(value: JsonSafeInteger): bigint | null {
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || value < 0) return null;
        return BigInt(value);
    }

    if (!DECIMAL_INTEGER_PATTERN.test(value)) return null;

    try {
        return BigInt(value);
    } catch {
        return null;
    }
}

export function compareJsonSafeInteger(
    left: JsonSafeInteger,
    right: JsonSafeInteger,
): -1 | 0 | 1 {
    const parsedLeft = parseJsonSafeInteger(left);
    const parsedRight = parseJsonSafeInteger(right);
    if (parsedLeft == null || parsedRight == null) {
        throw new RangeError("JsonSafeInteger must be a non-negative decimal integer");
    }
    if (parsedLeft < parsedRight) return -1;
    if (parsedLeft > parsedRight) return 1;
    return 0;
}

export function formatJsonSafeInteger(value: JsonSafeInteger): string {
    const parsed = parseJsonSafeInteger(value);
    if (parsed == null) {
        throw new RangeError("JsonSafeInteger must be a non-negative decimal integer");
    }
    return parsed.toLocaleString("en-US");
}

export function jsonSafeIntegerToU32(
    value: JsonSafeInteger,
): number | null {
    const parsed = parseJsonSafeInteger(value);
    if (parsed == null || parsed > U32_MAX) return null;
    return Number(parsed);
}

export function parseRequestedU32Page(value: string): number | null {
    if (!DECIMAL_INTEGER_PATTERN.test(value)) return null;
    const parsed = jsonSafeIntegerToU32(value);
    return parsed != null && parsed >= 1 ? parsed : null;
}
