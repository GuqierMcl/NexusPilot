import { describe, expect, test } from "bun:test";

import {
    buildAgentRuntimeApiUrl,
    createAgentRuntimeTransportOptions,
    shouldDisableAgentRuntimeSend,
} from "../../src/features/workbench/agent/runtime/create-agent-chat-transport";

describe("agent AI SDK transport options", () => {
    test("points AssistantChatTransport to /v1/runs", () => {
        expect(buildAgentRuntimeApiUrl("http://127.0.0.1:8787")).toBe(
            "http://127.0.0.1:8787/v1/runs",
        );
        expect(buildAgentRuntimeApiUrl("http://127.0.0.1:8787/")).toBe(
            "http://127.0.0.1:8787/v1/runs",
        );
    });

    test("creates transport options with prepareSendMessagesRequest", () => {
        const options = createAgentRuntimeTransportOptions({
            baseUrl: "http://127.0.0.1:8787",
            getSelectedModel: () => ({
                providerId: "openai",
                modelId: "gpt-4o",
            }),
            getConversationId: () => null,
        });

        expect(options.api).toBe("http://127.0.0.1:8787/v1/runs");
        expect(typeof options.prepareSendMessagesRequest).toBe("function");
    });

    test("passes selected agent mode into prepared Run request body", async () => {
        const options = createAgentRuntimeTransportOptions({
            baseUrl: "http://127.0.0.1:8787",
            getSelectedModel: () => ({
                providerId: "openai",
                modelId: "gpt-4o",
            }),
            getSelectedAgentMode: () => "query",
            getConversationId: () => null,
        });

        const prepared = await options.prepareSendMessagesRequest?.({
            id: "client-thread-1",
            api: "http://127.0.0.1:8787/v1/runs",
            messages: [
                {
                    id: "msg_user_1",
                    role: "user",
                    parts: [{ type: "text", text: "Hello" }],
                },
            ],
            body: undefined,
            credentials: undefined,
            headers: undefined,
            requestMetadata: undefined,
            trigger: "submit-message",
            messageId: undefined,
        } as never);

        expect(prepared?.body).toMatchObject({
            agent_mode: "query",
        });
    });

    test("disables sending until Runtime and selected model can be used", () => {
        expect(
            shouldDisableAgentRuntimeSend({
                selectedModel: null,
                runtimeHealthStatus: "healthy",
                runtimeChecking: false,
            }),
        ).toBe(true);
        expect(
            shouldDisableAgentRuntimeSend({
                selectedModel: {
                    providerId: "openai",
                    modelId: "gpt-4o",
                },
                runtimeHealthStatus: "unknown",
                runtimeChecking: true,
            }),
        ).toBe(true);
        expect(
            shouldDisableAgentRuntimeSend({
                selectedModel: {
                    providerId: "openai",
                    modelId: "gpt-4o",
                },
                runtimeHealthStatus: "unhealthy",
                runtimeChecking: false,
            }),
        ).toBe(true);
        expect(
            shouldDisableAgentRuntimeSend({
                selectedModel: {
                    providerId: "openai",
                    modelId: "gpt-4o",
                },
                runtimeHealthStatus: "healthy",
                runtimeChecking: false,
            }),
        ).toBe(false);
        expect(
            shouldDisableAgentRuntimeSend({
                selectedModel: {
                    providerId: "openai",
                    modelId: "gpt-4o",
                },
                runtimeHealthStatus: "healthy",
                runtimeChecking: true,
            }),
        ).toBe(false);
    });

    test("captures Runtime ids from response headers", async () => {
        const captured: Record<string, string | null> = {};
        const options = createAgentRuntimeTransportOptions({
            baseUrl: "http://127.0.0.1:8787",
            getSelectedModel: () => ({
                providerId: "openai",
                modelId: "gpt-4o",
            }),
            getConversationId: () => null,
            onRuntimeResponse: (headers) => {
                captured.conversationId = headers.conversationId;
                captured.runId = headers.runId;
                captured.messageId = headers.messageId;
                captured.clientThreadId = headers.clientThreadId;
            },
            fetch: async () =>
                new Response("ok", {
                    headers: {
                        "x-nexus-conversation-id": "conv_1234567890",
                        "x-nexus-run-id": "run_1234567890",
                        "x-nexus-message-id": "msg_1234567890",
                    },
                }),
        });

        const response = await options.fetch?.("http://127.0.0.1:8787/v1/runs", {
            body: JSON.stringify({
                metadata: {
                    client_thread_id: "__LOCALID_thread",
                },
            }),
        });

        expect(await response?.text()).toBe("ok");
        expect(captured).toEqual({
            conversationId: "conv_1234567890",
            runId: "run_1234567890",
            messageId: "msg_1234567890",
            clientThreadId: "__LOCALID_thread",
        });
    });

    test("adds the per-launch Bearer token to Run requests", async () => {
        let authorization: string | null = null;
        const options = createAgentRuntimeTransportOptions({
            baseUrl: "http://127.0.0.1:8787",
            accessToken: "launch-token",
            getSelectedModel: () => ({
                providerId: "openai",
                modelId: "gpt-4o",
            }),
            fetch: async (_input, init) => {
                authorization = new Headers(init?.headers).get("authorization");
                return new Response("ok");
            },
        });

        await options.fetch?.("http://127.0.0.1:8787/v1/runs", {
            headers: { Authorization: "Bearer caller-controlled" },
        });

        expect(authorization).toBe("Bearer launch-token");
    });

    test("reports friendly adapter errors while still blocking invalid requests", async () => {
        const reported: string[] = [];
        const options = createAgentRuntimeTransportOptions({
            baseUrl: "http://127.0.0.1:8787",
            getSelectedModel: () => ({
                providerId: "openai",
                modelId: "gpt-4o",
            }),
            getConversationId: () => null,
            onRequestAdapterError: (message) => {
                reported.push(message);
            },
        });

        await expect(
            options.prepareSendMessagesRequest?.({
                id: "client-thread-1",
                api: "http://127.0.0.1:8787/v1/runs",
                messages: [
                    {
                        id: "msg_user_1",
                        role: "user",
                        parts: [{ type: "text", text: "Hello" }],
                    },
                ],
                body: undefined,
                credentials: undefined,
                headers: undefined,
                requestMetadata: undefined,
                trigger: "regenerate-message",
                messageId: "msg_assistant_1",
            } as never),
        ).rejects.toThrow("当前阶段暂不支持重新生成消息");

        expect(reported).toEqual(["该操作即将支持"]);
    });
});
