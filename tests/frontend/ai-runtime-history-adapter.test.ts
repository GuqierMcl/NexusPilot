import { describe, expect, test } from "bun:test";
import type { MessageFormatAdapter } from "@assistant-ui/react";
import type { UIMessage } from "ai";

import { createAiRuntimeHistoryAdapter } from "../../src/features/workbench/agent/runtime/ai-runtime-history-adapter";

const formatAdapter: MessageFormatAdapter<UIMessage, Record<string, unknown>> = {
    format: "ai-sdk/v6",
    encode: ({ message }) => message as unknown as Record<string, unknown>,
    decode: (stored) => ({
        parentId: stored.parent_id,
        message: {
            id: stored.id,
            ...(stored.content as Omit<UIMessage, "id">),
        },
    }),
    getId: (message) => message.id,
};

describe("createAiRuntimeHistoryAdapter", () => {
    test("loads an empty repository when no Runtime conversation id is available", async () => {
        let loadCount = 0;
        const adapter = createAiRuntimeHistoryAdapter({
            getConversationId: () => null,
            loadMessages: async () => {
                loadCount += 1;
                return [];
            },
        });

        const formatted = adapter.withFormat?.(formatAdapter);

        expect(await formatted?.load()).toEqual({ messages: [] });
        expect(loadCount).toBe(0);
    });

    test("loads AI SDK messages as a linear history repository", async () => {
        const messages: UIMessage[] = [
            {
                id: "msg_user",
                role: "user",
                parts: [{ type: "text", text: "Hello" }],
            },
            {
                id: "msg_assistant",
                role: "assistant",
                parts: [{ type: "text", text: "Recovered answer" }],
            },
        ];
        const adapter = createAiRuntimeHistoryAdapter({
            getConversationId: () => "conv_history",
            loadMessages: async (conversationId) => {
                expect(conversationId).toBe("conv_history");
                return messages;
            },
        });

        const formatted = adapter.withFormat?.(formatAdapter);

        expect(await formatted?.load()).toEqual({
            headId: "msg_assistant",
            messages: [
                { parentId: null, message: messages[0] },
                { parentId: "msg_user", message: messages[1] },
            ],
        });
    });

    test("does not persist frontend history because Runtime Store is the source of truth", async () => {
        const adapter = createAiRuntimeHistoryAdapter({
            getConversationId: () => "conv_history",
            loadMessages: async () => [],
        });
        const formatted = adapter.withFormat?.(formatAdapter);

        await expect(
            formatted?.append({
                parentId: null,
                message: {
                    id: "msg_user",
                    role: "user",
                    parts: [{ type: "text", text: "Hello" }],
                },
            }),
        ).resolves.toBeUndefined();
    });
});
