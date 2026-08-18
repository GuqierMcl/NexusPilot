import { beforeEach, describe, expect, test } from "bun:test";

import { useAgentStatusSnapshotStore } from "../../src/features/workbench/agent/state";

describe("agent status snapshot store", () => {
    beforeEach(() => {
        useAgentStatusSnapshotStore
            .getState()
            .setComposerSendBlocker(null);
    });

    test("publishes and clears the current composer blocker", () => {
        const store = useAgentStatusSnapshotStore.getState();

        store.setComposerSendBlocker({
            code: "missing_model",
            message: "请选择模型",
        });
        expect(
            useAgentStatusSnapshotStore.getState().composerSendBlocker,
        ).toEqual({
            code: "missing_model",
            message: "请选择模型",
        });

        store.setComposerSendBlocker(null);
        expect(
            useAgentStatusSnapshotStore.getState().composerSendBlocker,
        ).toBeNull();
    });
});
