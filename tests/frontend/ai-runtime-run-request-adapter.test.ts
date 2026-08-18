import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import {
    RunRequestAdapterError,
    buildRunCreateRequestFromAiSdkMessages,
    createPrepareRunSendMessagesRequest,
    formatRunRequestAdapterError,
} from "../../src/features/workbench/agent/runtime/run-request-adapter";

const selectedModel = {
    providerId: "openai",
    modelId: "gpt-4o",
};

function userMessage(input: Partial<UIMessage>): UIMessage {
    return {
        id: "msg_user_1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
        ...input,
    } as UIMessage;
}

function assistantMessage(input: Partial<UIMessage>): UIMessage {
    return {
        id: "msg_assistant_1",
        role: "assistant",
        parts: [{ type: "text", text: "Previous answer" }],
        ...input,
    } as UIMessage;
}

function expectRunRequestAdapterError(
    action: () => unknown,
    code: RunRequestAdapterError["code"],
): RunRequestAdapterError {
    try {
        action();
    } catch (error) {
        expect(error).toBeInstanceOf(RunRequestAdapterError);
        const adapterError = error as RunRequestAdapterError;
        expect(adapterError.code).toBe(code);
        return adapterError;
    }

    throw new Error(`Expected RunRequestAdapterError with code ${code}`);
}

describe("buildRunCreateRequestFromAiSdkMessages", () => {
    test("builds NexusPilot RunCreateRequest from the last user text message", () => {
        const request = buildRunCreateRequestFromAiSdkMessages({
            messages: [
                userMessage({
                    id: "msg_old_user",
                    parts: [{ type: "text", text: "Old question" }],
                }),
                assistantMessage({ id: "msg_old_assistant" }),
                userMessage({
                    id: "msg_new_user",
                    parts: [
                        { type: "text", text: " First " },
                        { type: "text", text: "Second" },
                    ],
                }),
            ],
            selectedModel,
            conversationId: "conv_1234567890",
            trigger: "submit-message",
            messageId: undefined,
            clientThreadId: "client-thread-1",
        });

        expect(request).toEqual({
            response_mode: "stream",
            conversation_id: "conv_1234567890",
            model: {
                provider_id: "openai",
                model_id: "gpt-4o",
            },
            agent_mode: "ask",
            input: {
                parts: [
                    { type: "text", text: "First" },
                    { type: "text", text: "Second" },
                ],
            },
            metadata: {
                client_thread_id: "client-thread-1",
                client_user_message_id: "msg_new_user",
                request_trigger: "submit-message",
            },
        });
    });

    test("normalizes selected model ids before building the request", () => {
        const request = buildRunCreateRequestFromAiSdkMessages({
            messages: [userMessage({ id: "msg_user_1" })],
            selectedModel: {
                providerId: " openai ",
                modelId: " gpt-4o ",
            },
        });

        expect(request.model).toEqual({
            provider_id: "openai",
            model_id: "gpt-4o",
        });
    });

    test("uses the selected agent mode when building the request", () => {
        const request = buildRunCreateRequestFromAiSdkMessages({
            messages: [userMessage({ id: "msg_user_1" })],
            selectedModel,
            selectedAgentMode: "query",
        });

        expect(request.agent_mode).toBe("query");
    });

    test("includes the Runtime replacement boundary for an edited user message", () => {
        const request = buildRunCreateRequestFromAiSdkMessages({
            messages: [
                userMessage({
                    id: "msg_rewritten_user",
                    parts: [{ type: "text", text: "Rewritten question" }],
                }),
            ],
            selectedModel,
            conversationId: "conv_1234567890",
            replaceFromMessageId: "msg_original_user",
        });

        expect(request).toMatchObject({
            conversation_id: "conv_1234567890",
            replace_from_message_id: "msg_original_user",
            input: {
                parts: [{ type: "text", text: "Rewritten question" }],
            },
        });
    });

    test("omits optional conversation_id and unavailable metadata fields", () => {
        const request = buildRunCreateRequestFromAiSdkMessages({
            messages: [userMessage({ id: "msg_user_1" })],
            selectedModel,
        });

        expect(request).toEqual({
            response_mode: "stream",
            model: {
                provider_id: "openai",
                model_id: "gpt-4o",
            },
            agent_mode: "ask",
            input: {
                parts: [{ type: "text", text: "Hello" }],
            },
            metadata: {
                client_user_message_id: "msg_user_1",
            },
        });
    });

    test("does not include AI SDK passthrough or internal Runtime control fields", () => {
        const request = buildRunCreateRequestFromAiSdkMessages({
            messages: [userMessage({ id: "msg_user_1" })],
            selectedModel,
            trigger: "submit-message",
            clientThreadId: "client-thread-1",
        }) as Record<string, unknown>;

        expect(request.messages).toBeUndefined();
        expect(request.system).toBeUndefined();
        expect(request.tools).toBeUndefined();
        expect(request.limits).toBeUndefined();
        expect(request.config).toBeUndefined();
        expect(request.callSettings).toBeUndefined();
        expect(request.mode).toBeUndefined();
    });

    test("throws typed error when no selected model is available", () => {
        expectRunRequestAdapterError(
            () =>
                buildRunCreateRequestFromAiSdkMessages({
                    messages: [userMessage({ id: "msg_user_1" })],
                    selectedModel: null,
                }),
            "missing_model",
        );
    });

    test("throws typed error when selected model ids are blank", () => {
        expectRunRequestAdapterError(
            () =>
                buildRunCreateRequestFromAiSdkMessages({
                    messages: [userMessage({ id: "msg_user_1" })],
                    selectedModel: {
                        providerId: "",
                        modelId: "gpt-4o",
                    },
                }),
            "missing_model",
        );

        expectRunRequestAdapterError(
            () =>
                buildRunCreateRequestFromAiSdkMessages({
                    messages: [userMessage({ id: "msg_user_1" })],
                    selectedModel: {
                        providerId: "openai",
                        modelId: "   ",
                    },
                }),
            "missing_model",
        );
    });

    test("throws typed error when there is no user message", () => {
        expectRunRequestAdapterError(
            () =>
                buildRunCreateRequestFromAiSdkMessages({
                    messages: [assistantMessage({ id: "msg_assistant_1" })],
                    selectedModel,
                }),
            "missing_user_message",
        );
    });

    test("throws typed error for empty text input", () => {
        expectRunRequestAdapterError(
            () =>
                buildRunCreateRequestFromAiSdkMessages({
                    messages: [
                        userMessage({
                            parts: [{ type: "text", text: "   " }],
                        }),
                    ],
                    selectedModel,
                }),
            "empty_user_input",
        );
    });

    test("throws typed error for non text parts", () => {
        const error = expectRunRequestAdapterError(
            () =>
                buildRunCreateRequestFromAiSdkMessages({
                    messages: [
                        userMessage({
                            parts: [
                                { type: "text", text: "Hello" },
                                {
                                    type: "file",
                                    mediaType: "application/pdf",
                                    filename: "schema.pdf",
                                    url: "https://example.com/schema.pdf",
                                },
                            ],
                        }),
                    ],
                    selectedModel,
                }),
            "unsupported_input_part",
        );

        expect(error.partType).toBe("file");
    });

    test("throws typed error for regenerate trigger in first version", () => {
        expectRunRequestAdapterError(
            () =>
                buildRunCreateRequestFromAiSdkMessages({
                    messages: [userMessage({ id: "msg_user_1" })],
                    selectedModel,
                    trigger: "regenerate-message",
                    messageId: "msg_assistant_1",
                }),
            "unsupported_trigger",
        );
    });
});

describe("formatRunRequestAdapterError", () => {
    test("maps typed adapter errors to friendly user-facing messages", () => {
        expect(
            formatRunRequestAdapterError(
                new RunRequestAdapterError(
                    "unsupported_trigger",
                    "当前阶段暂不支持重新生成消息。",
                ),
            ),
        ).toBe("该操作即将支持");

        expect(
            formatRunRequestAdapterError(
                new RunRequestAdapterError(
                    "unsupported_input_part",
                    "当前阶段暂不支持 file 输入。",
                    { partType: "file" },
                ),
            ),
        ).toBe("当前版本暂不支持此输入类型");

        expect(
            formatRunRequestAdapterError(
                new RunRequestAdapterError("empty_user_input", "用户输入不能为空。"),
            ),
        ).toBeNull();

        expect(formatRunRequestAdapterError(new Error("boom"))).toBeNull();
    });
});

describe("createPrepareRunSendMessagesRequest", () => {
    test("creates AI SDK prepareSendMessagesRequest callback that returns only NexusPilot body", async () => {
        const prepare = createPrepareRunSendMessagesRequest({
            getSelectedModel: () => selectedModel,
            getConversationId: () => "conv_1234567890",
        });

        const prepared = await prepare({
            id: "client-thread-1",
            api: "http://localhost:8787/v1/runs",
            messages: [userMessage({ id: "msg_user_1" })],
            body: {
                system: "do not forward",
                tools: {},
                config: {},
                callSettings: {},
            },
            credentials: undefined,
            headers: undefined,
            requestMetadata: { ignored: true },
            trigger: "submit-message",
            messageId: undefined,
        });

        expect(prepared.body).toEqual({
            response_mode: "stream",
            conversation_id: "conv_1234567890",
            model: {
                provider_id: "openai",
                model_id: "gpt-4o",
            },
            agent_mode: "ask",
            input: {
                parts: [{ type: "text", text: "Hello" }],
            },
            metadata: {
                client_thread_id: "client-thread-1",
                client_user_message_id: "msg_user_1",
                request_trigger: "submit-message",
            },
        });
        expect(prepared.headers).toBeUndefined();
        expect(prepared.credentials).toBeUndefined();
        expect(prepared.api).toBeUndefined();
    });

    test("consumes a pending replacement boundary only for the next edited send", async () => {
        const replacementIds = ["msg_original_user", null];
        const prepare = createPrepareRunSendMessagesRequest({
            getSelectedModel: () => selectedModel,
            getConversationId: () => "conv_1234567890",
            consumeReplacementMessageId: () => replacementIds.shift() ?? null,
        });
        const request = {
            id: "client-thread-1",
            api: "http://localhost:8787/v1/runs",
            messages: [userMessage({ id: "msg_rewritten_user" })],
            body: {},
            credentials: undefined,
            headers: undefined,
            requestMetadata: undefined,
            trigger: "submit-message" as const,
            messageId: "msg_rewritten_user",
        };

        const edited = await prepare(request);
        const normal = await prepare(request);

        expect(edited.body).toMatchObject({
            replace_from_message_id: "msg_original_user",
        });
        expect(normal.body).not.toHaveProperty("replace_from_message_id");
    });
});
