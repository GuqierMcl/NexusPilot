import { describe, expect, test } from "bun:test";

import { deleteAgentHistoryItem } from "../src/features/workbench/agent/history/agent-history-actions";

describe("deleteAgentHistoryItem", () => {
    test("deletes through assistant-ui thread item before reloading history", async () => {
        const calls: string[] = [];

        await deleteAgentHistoryItem({
            item: { id: "conv_deleted", active: false },
            deleteThread: async (threadId) => {
                calls.push(`delete:${threadId}`);
            },
            switchToNewThread: async () => {
                calls.push("switch-new");
            },
            reloadThreads: async () => {
                calls.push("reload");
            },
            onConversationSelected: () => {
                calls.push("selected");
            },
        });

        expect(calls).toEqual(["delete:conv_deleted", "reload"]);
    });

    test("switches to a new thread after deleting the active history item", async () => {
        const calls: string[] = [];

        await deleteAgentHistoryItem({
            item: { id: "conv_active", active: true },
            deleteThread: async (threadId) => {
                calls.push(`delete:${threadId}`);
            },
            switchToNewThread: async () => {
                calls.push("switch-new");
            },
            reloadThreads: async () => {
                calls.push("reload");
            },
            onConversationSelected: () => {
                calls.push("selected");
            },
        });

        expect(calls).toEqual([
            "delete:conv_active",
            "switch-new",
            "selected",
            "reload",
        ]);
    });
});
