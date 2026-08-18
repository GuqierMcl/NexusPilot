import { describe, expect, test } from "bun:test";

import {
    buildConversationInterruptActiveRunPath,
    buildRunInterruptPath,
} from "../../src/lib/ai-runtime/runs";

describe("AI Runtime run command paths", () => {
    test("builds interrupt command paths", () => {
        expect(buildRunInterruptPath("run_1")).toBe("/v1/runs/run_1/interrupt");
        expect(buildConversationInterruptActiveRunPath("conv_1")).toBe(
            "/v1/conversations/conv_1/interrupt-active-run",
        );
    });
});
