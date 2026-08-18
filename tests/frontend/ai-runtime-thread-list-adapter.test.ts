import { describe, expect, test } from "bun:test";

import {
    createAgentThreadTitleFromMessages,
    createAiRuntimeThreadListAdapter,
    reloadRuntimeThreadHistorySnapshot,
    toAiSdkMessageRepository,
    mapRuntimeConversationToThreadMetadata,
} from "../../src/features/workbench/agent/runtime/ai-runtime-thread-list-adapter";
import {
    buildAiRuntimeEventsUrl,
    parseAiRuntimeEventData,
    parseAiRuntimeSseEventBlock,
    subscribeAiRuntimeEvents,
} from "../../src/lib/ai-runtime/events";
import { isRuntimeConversationId } from "../../src/lib/ai-runtime/runtime-ids";

describe("createAiRuntimeThreadListAdapter", () => {
    test("maps Runtime conversation summaries to assistant-ui thread metadata", async () => {
        const adapter = createAiRuntimeThreadListAdapter({
            listConversations: async () => [
                {
                    id: "conv_123",
                    title: "SQL 优化讨论",
                    status: { type: "busy", runId: "run_123" },
                    active_run_id: "run_123",
                    time: {
                        created: 1,
                        updated: 2,
                    },
                    metadata: {
                        source: "test",
                    },
                },
            ],
        });

        await expect(adapter.list()).resolves.toEqual({
            threads: [
                {
                    remoteId: "conv_123",
                    title: "SQL 优化讨论",
                    status: "regular",
                    lastMessageAt: new Date(2),
                    custom: {
                        runtimeStatus: { type: "busy", runId: "run_123" },
                        activeRunId: "run_123",
                        time: {
                            created: 1,
                            updated: 2,
                        },
                        metadata: {
                            source: "test",
                        },
                    },
                },
            ],
        });
    });

    test("fetches one Runtime conversation when available", async () => {
        const adapter = createAiRuntimeThreadListAdapter({
            getConversation: async (conversationId) => ({
                id: conversationId,
                title: "已恢复会话",
                status: { type: "idle" },
                time: {
                    created: 10,
                    updated: 20,
                },
            }),
        });

        await expect(adapter.fetch("conv_fetch")).resolves.toEqual({
            remoteId: "conv_fetch",
            title: "已恢复会话",
            status: "regular",
            lastMessageAt: new Date(20),
            custom: {
                runtimeStatus: { type: "idle" },
                time: {
                    created: 10,
                    updated: 20,
                },
            },
        });
    });

    test("rejects non Runtime ids instead of fabricating persisted thread metadata", async () => {
        const adapter = createAiRuntimeThreadListAdapter();

        await expect(adapter.fetch("__LOCALID_missing")).rejects.toThrow(
            "is not a Runtime conversation id",
        );
    });

    test("keeps non-404 conversation fetch failures visible", async () => {
        const adapter = createAiRuntimeThreadListAdapter({
            getConversation: async () => {
                throw new Error("backend unavailable");
            },
        });

        await expect(adapter.fetch("conv_unavailable")).rejects.toThrow(
            "backend unavailable",
        );
    });

    test("initializes a local assistant-ui thread without creating a Runtime conversation", async () => {
        const initialized: Array<{
            localThreadId: string;
            conversationId: string;
        }> = [];
        let createConversationCalled = false;
        const adapter = createAiRuntimeThreadListAdapter({
            createConversation: async () => {
                createConversationCalled = true;
                throw new Error("should not create a Runtime conversation");
            },
            onConversationInitialized: (input) => {
                initialized.push(input);
            },
        });

        await expect(adapter.initialize("__LOCALID_test")).resolves.toEqual({
            remoteId: "__LOCALID_test",
            externalId: "__LOCALID_test",
        });
        expect(createConversationCalled).toBe(false);
        expect(initialized).toEqual([]);
    });

    test("streams the latest Runtime title for a mapped local assistant-ui thread", async () => {
        const requestedConversationIds: string[] = [];
        const adapter = createAiRuntimeThreadListAdapter({
            resolveConversationId: (threadId) =>
                threadId === "__LOCALID_123" ? "conv_123" : null,
            getConversation: async (conversationId) => {
                requestedConversationIds.push(conversationId);
                return {
                    id: conversationId,
                    title: "EventBus 跨域故障排查",
                    status: { type: "idle" },
                    time: {
                        created: 10,
                        updated: 20,
                    },
                };
            },
        });
        const stream = await adapter.generateTitle("__LOCALID_123", []);
        const chunks: unknown[] = [];
        const reader = stream.getReader();

        while (true) {
            const result = await reader.read();
            if (result.done) {
                break;
            }
            chunks.push(result.value);
        }

        expect(requestedConversationIds).toEqual(["conv_123"]);
        expect(chunks).toEqual([
            {
                type: "part-start",
                path: [],
                part: { type: "text" },
            },
            {
                type: "text-delta",
                path: [0],
                textDelta: "EventBus 跨域故障排查",
            },
            {
                type: "part-finish",
                path: [0],
            },
        ]);
    });

    test("keeps title generation empty until a local thread has a Runtime mapping", async () => {
        const adapter = createAiRuntimeThreadListAdapter({
            getConversation: async () => {
                throw new Error("should not fetch an unmapped conversation");
            },
        });
        const stream = await adapter.generateTitle("__LOCALID_missing", []);

        await expect(stream.getReader().read()).resolves.toEqual({
            done: true,
            value: undefined,
        });
    });

    test("derives local thread titles from the first user text message", () => {
        expect(
            createAgentThreadTitleFromMessages([
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "  请帮我分析这个 SQL 查询为什么很慢，需要看执行计划  ",
                        },
                    ],
                },
            ]),
        ).toBe("请帮我分析这个 SQL 查询为什么很慢，需要看执行计划");

        expect(
            createAgentThreadTitleFromMessages([
                {
                    role: "assistant",
                    content: [{ type: "text", text: "Hello" }],
                },
            ]),
        ).toBeNull();
    });

    test("guards mutation commands against local assistant-ui thread ids", async () => {
        const adapter = createAiRuntimeThreadListAdapter();

        await expect(adapter.rename("__LOCALID_123", "new title")).rejects.toThrow(
            "is not a Runtime conversation id",
        );
        await expect(adapter.archive("__LOCALID_123")).rejects.toThrow(
            "is not a Runtime conversation id",
        );
        await expect(adapter.unarchive("__LOCALID_123")).rejects.toThrow(
            "is not a Runtime conversation id",
        );
        await expect(adapter.delete("__LOCALID_123")).rejects.toThrow(
            "is not a Runtime conversation id",
        );
    });

    test("maps archived Runtime conversation status to archived thread metadata", () => {
        expect(
            mapRuntimeConversationToThreadMetadata({
                id: "conv_archived",
                title: "归档会话",
                status: { type: "archived" },
                time: {
                    created: 1,
                    updated: 2,
                    archived: 3,
                },
            }).status,
        ).toBe("archived");
    });

    test("keeps Runtime status and updated time available for History View", () => {
        const metadata = mapRuntimeConversationToThreadMetadata({
            id: "conv_history",
            title: "历史恢复",
            status: { type: "error", error: { name: "APIError" } },
            active_run_id: "run_error",
            time: {
                created: 100,
                updated: 200,
            },
        });

        expect(metadata.lastMessageAt).toEqual(new Date(200));
        expect(metadata.custom).toEqual({
            runtimeStatus: { type: "error", error: { name: "APIError" } },
            activeRunId: "run_error",
            time: {
                created: 100,
                updated: 200,
            },
        });
    });
});

describe("Runtime thread history snapshot import", () => {
    test("builds an AI SDK message repository with parent links and head id", () => {
        expect(
            toAiSdkMessageRepository([
                {
                    id: "msg_user",
                    role: "user",
                    parts: [{ type: "text", text: "Hello" }],
                },
                {
                    id: "msg_assistant",
                    role: "assistant",
                    parts: [{ type: "text", text: "Hi" }],
                },
            ]),
        ).toEqual({
            headId: "msg_assistant",
            messages: [
                {
                    parentId: null,
                    message: {
                        id: "msg_user",
                        role: "user",
                        parts: [{ type: "text", text: "Hello" }],
                    },
                },
                {
                    parentId: "msg_user",
                    message: {
                        id: "msg_assistant",
                        role: "assistant",
                        parts: [{ type: "text", text: "Hi" }],
                    },
                },
            ],
        });
    });

    test("reloads Runtime conversation messages into the current AI SDK thread", async () => {
        const imported: unknown[] = [];

        await expect(
            reloadRuntimeThreadHistorySnapshot({
                conversationId: "conv_123",
                loadMessages: async () => [
                    {
                        id: "msg_user",
                        role: "user",
                        parts: [{ type: "text", text: "Hello" }],
                    },
                ],
                importExternalState: (repository) => {
                    imported.push(repository);
                },
            }),
        ).resolves.toBe(true);

        expect(imported).toEqual([
            {
                headId: "msg_user",
                messages: [
                    {
                        parentId: null,
                        message: {
                            id: "msg_user",
                            role: "user",
                            parts: [{ type: "text", text: "Hello" }],
                        },
                    },
                ],
            },
        ]);
    });

    test("skips history reload when there is no Runtime conversation id", async () => {
        const imported: unknown[] = [];

        await expect(
            reloadRuntimeThreadHistorySnapshot({
                conversationId: "__LOCALID_missing",
                loadMessages: async () => {
                    throw new Error("should not load");
                },
                importExternalState: (repository) => {
                    imported.push(repository);
                },
            }),
        ).resolves.toBe(false);

        expect(imported).toEqual([]);
    });
});

describe("AI Runtime EventBus helpers", () => {
    test("adds the per-launch Bearer token to SSE requests", async () => {
        let resolveAuthorization!: (value: string | null) => void;
        const authorization = new Promise<string | null>((resolve) => {
            resolveAuthorization = resolve;
        });
        const unsubscribe = subscribeAiRuntimeEvents({
            baseUrl: "http://127.0.0.1:8787",
            accessToken: "launch-token",
            reconnectDelayMs: 250,
            fetch: async (_input, init) => {
                resolveAuthorization(new Headers(init?.headers).get("authorization"));
                return new Response("");
            },
            onEvent: () => {},
        });

        expect(await authorization).toBe("Bearer launch-token");
        unsubscribe();
    });

    test("builds live-only SSE URLs with optional scope", () => {
        expect(buildAiRuntimeEventsUrl("http://127.0.0.1:8787")).toBe(
            "http://127.0.0.1:8787/v1/events",
        );
        expect(
            buildAiRuntimeEventsUrl("http://127.0.0.1:8787/", {
                conversationId: "conv_123",
            }),
        ).toBe("http://127.0.0.1:8787/v1/events?conversation_id=conv_123");
        expect(
            buildAiRuntimeEventsUrl("http://127.0.0.1:8787/", {
                runId: "run_123",
            }),
        ).toBe("http://127.0.0.1:8787/v1/events?run_id=run_123");
    });

    test("rejects mutually exclusive EventBus subscription scopes on the client side", () => {
        expect(() =>
            buildAiRuntimeEventsUrl("http://127.0.0.1:8787", {
                conversationId: "conv_123",
                runId: "run_123",
            } as never),
        ).toThrow("mutually exclusive");
    });

    test("parses named SSE event blocks without relying on EventSource message events", () => {
        expect(
            parseAiRuntimeSseEventBlock(
                [
                    "id: evt_123",
                    "event: conversation.updated",
                    'data: {"id":"evt_123","type":"conversation.updated","scope":{"kind":"conversation","conversation_id":"conv_123"},"occurred_at":100,"version":1,"payload":{"event":{"type":"conversation.updated"}}}',
                    "",
                ].join("\n"),
            ),
        ).toEqual({
            id: "evt_123",
            type: "conversation.updated",
            scope: {
                kind: "conversation",
                conversation_id: "conv_123",
            },
            occurred_at: 100,
            version: 1,
            payload: {
                event: {
                    type: "conversation.updated",
                },
            },
        });
    });

    test("ignores keepalive comments and invalid event data", () => {
        expect(parseAiRuntimeSseEventBlock(": keepalive")).toBeNull();
        expect(parseAiRuntimeEventData("not-json")).toBeNull();
    });

    test("recognizes Runtime conversation ids and rejects local assistant-ui thread ids", () => {
        expect(isRuntimeConversationId("conv_abc")).toBe(true);
        expect(isRuntimeConversationId("__LOCALID_abc")).toBe(false);
        expect(isRuntimeConversationId("")).toBe(false);
    });
});
