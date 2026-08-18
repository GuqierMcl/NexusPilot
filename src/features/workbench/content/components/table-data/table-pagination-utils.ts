import {
    compareJsonSafeInteger,
    jsonSafeIntegerToU32,
    parseRequestedU32Page,
} from "@/lib/json-safe-integer";
import type { JsonSafeInteger } from "@/types/ipc";

export function resolveLastPageTarget(
    totalPages: JsonSafeInteger,
): number | null {
    const target = jsonSafeIntegerToU32(totalPages);
    return target != null && target >= 1 ? target : null;
}

export function validateRequestedPageAgainstTotal(
    requestedPage: string,
    totalPages: JsonSafeInteger,
): number | null {
    const parsed = parseRequestedU32Page(requestedPage);
    if (parsed == null) return null;
    return compareJsonSafeInteger(parsed, totalPages) <= 0 ? parsed : null;
}
