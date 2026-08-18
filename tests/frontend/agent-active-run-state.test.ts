import { describe, expect, test } from "bun:test";

import { AgentActiveRunState } from "../../src/features/workbench/agent/runtime/active-run-state";

describe("AgentActiveRunState", () => {
    test("records and clears active run ids by thread and conversation", () => {
        const state = new AgentActiveRunState();
        state.record({
            clientThreadId: "__LOCALID_thread",
            conversationId: "conv_1",
            runId: "run_1",
        });

        expect(state.getRunId({ clientThreadId: "__LOCALID_thread" })).toBe("run_1");
        expect(state.getRunId({ conversationId: "conv_1" })).toBe("run_1");

        state.clear({ runId: "run_1" });
        expect(state.getRunId({ clientThreadId: "__LOCALID_thread" })).toBeNull();
        expect(state.getRunId({ conversationId: "conv_1" })).toBeNull();
    });
});
