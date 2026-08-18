import { describe, expect, test } from "bun:test";

import { appendAiRuntimeAuthorization } from "../../src/lib/ai-runtime/endpoint";

describe("AI Runtime frontend authorization", () => {
    test("adds and owns the per-launch Bearer credential", () => {
        const headers = appendAiRuntimeAuthorization(
            { Authorization: "Bearer caller-controlled", Accept: "application/json" },
            "launch-token",
        );

        expect(headers.get("authorization")).toBe("Bearer launch-token");
        expect(headers.get("accept")).toBe("application/json");
    });

    test("does not add authorization in tokenless development mode", () => {
        const headers = appendAiRuntimeAuthorization(undefined, null);
        expect(headers.has("authorization")).toBe(false);
    });
});
