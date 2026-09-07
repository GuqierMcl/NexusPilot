import type { HttpChatTransportInitOptions, UIMessage } from "ai";
import { useComposerRecovery } from "../composer/composer-recovery";

import {
    AI_RUNTIME_RUNS_PATH,
    type RunAgentMode,
    type RunModelSelection,
} from "@/lib/ai-runtime/runs";
import type { AiRuntimeHealthStatus } from "@/store/slices/ai-runtime-endpoint-slice";
import { appendAiRuntimeAuthorization } from "@/lib/ai-runtime/endpoint";
import {
    getAiRuntimeUserFacingErrorMessage,
    isAiRuntimeTransportError,
} from "@/lib/ai-runtime/error";

import {
    createPrepareRunSendMessagesRequest,
    formatRunRequestAdapterError,
    type ResolveRunConversationIdContext,
} from "./run-request-adapter";

export interface CreateAgentRuntimeTransportOptionsInput {
    baseUrl: string;
    accessToken?: string | null;
    getSelectedModel: () => RunModelSelection | null;
    getSelectedAgentMode?: () => RunAgentMode;
    getConversationId?: (
        context: ResolveRunConversationIdContext,
    ) => string | null | undefined;
    consumeReplacementMessageId?: () => string | null | undefined;
    getActiveRunId?: (
        context: ResolveRunConversationIdContext,
    ) => string | null;
    fetch?: HttpChatTransportInitOptions<UIMessage>["fetch"];
    onRuntimeResponse?: (headers: AgentRuntimeResponseHeaders) => void;
    onRequestAdapterError?: (message: string) => void;
}

export interface AgentRuntimeResponseHeaders {
    conversationId: string | null;
    runId: string | null;
    messageId: string | null;
    clientThreadId: string | null;
}

export function buildAgentRuntimeApiUrl(baseUrl: string): string {
    return `${baseUrl.replace(/\/+$/, "")}${AI_RUNTIME_RUNS_PATH}`;
}

export function createAgentRuntimeTransportOptions(
    input: CreateAgentRuntimeTransportOptionsInput,
): HttpChatTransportInitOptions<UIMessage> {
    return {
        api: buildAgentRuntimeApiUrl(input.baseUrl),
        fetch: createRuntimeHeaderAwareFetch(input),
        prepareSendMessagesRequest: async (request) => {
            let replacementId: string | undefined;
            const userMessage = request.messages.at(-1);
            const prepareRunSendMessagesRequest = createPrepareRunSendMessagesRequest({
                ...input,
                consumeReplacementMessageId: () => {
                    replacementId = input.consumeReplacementMessageId?.() ?? undefined;
                    return replacementId;
                },
            });
            const stage = (failed: boolean): void => {
                if (userMessage?.role === "user") useComposerRecovery.getState().stage(request.id, {
                    message: userMessage, replaceFromMessageId: replacementId, failed,
                });
            };
            try {
                const prepared = await prepareRunSendMessagesRequest(request);
                stage(false);
                return prepared;
            } catch (error) {
                stage(true);
                const message = formatRunRequestAdapterError(error);
                if (message) {
                    input.onRequestAdapterError?.(message);
                }
                throw error;
            }
        },
    };
}

export function shouldDisableAgentRuntimeSend(
    input: {
        selectedModel: RunModelSelection | null;
        runtimeHealthStatus: AiRuntimeHealthStatus;
        runtimeChecking: boolean;
    },
): boolean {
    return (
        input.runtimeHealthStatus !== "healthy" ||
        input.selectedModel === null
    );
}

function createRuntimeHeaderAwareFetch(
    input: Pick<CreateAgentRuntimeTransportOptionsInput, "accessToken" | "fetch" | "onRuntimeResponse">,
): NonNullable<HttpChatTransportInitOptions<UIMessage>["fetch"]> {
    return async (requestInput, init) => {
        const fetchImpl = input.fetch ?? globalThis.fetch.bind(globalThis);
        const clientThreadId = await readClientThreadIdFromRequest(requestInput, init);
        let response: Response;
        try {
            response = await fetchImpl(requestInput, {
                ...init,
                headers: appendAiRuntimeAuthorization(init?.headers, input.accessToken ?? null),
            });
        } catch (error) {
            if (clientThreadId) useComposerRecovery.getState().fail(clientThreadId);
            if (isAiRuntimeTransportError(error)) {
                throw new Error(getAiRuntimeUserFacingErrorMessage(error));
            }
            throw error;
        }

        if (clientThreadId) {
            if (response.ok) useComposerRecovery.getState().clear(clientThreadId);
            else useComposerRecovery.getState().fail(clientThreadId);
        }
        input.onRuntimeResponse?.({
            conversationId: response.headers.get("x-nexus-conversation-id"),
            runId: response.headers.get("x-nexus-run-id"),
            messageId: response.headers.get("x-nexus-message-id"),
            clientThreadId,
        });

        return response;
    };
}

async function readClientThreadIdFromRequest(
    requestInput: Parameters<NonNullable<HttpChatTransportInitOptions<UIMessage>["fetch"]>>[0],
    init: Parameters<NonNullable<HttpChatTransportInitOptions<UIMessage>["fetch"]>>[1],
): Promise<string | null> {
    const initBodyThreadId = readClientThreadIdFromBody(init?.body);
    if (initBodyThreadId) {
        return initBodyThreadId;
    }

    if (typeof Request !== "undefined" && requestInput instanceof Request) {
        try {
            const payload = (await requestInput.clone().json()) as unknown;
            return readClientThreadIdFromPayload(payload);
        } catch {
            return null;
        }
    }

    return null;
}

function readClientThreadIdFromBody(body: BodyInit | null | undefined): string | null {
    if (typeof body !== "string") {
        return null;
    }

    try {
        return readClientThreadIdFromPayload(JSON.parse(body) as unknown);
    } catch {
        return null;
    }
}

function readClientThreadIdFromPayload(payload: unknown): string | null {
    if (!isRecord(payload)) {
        return null;
    }

    const metadata = payload.metadata;
    if (!isRecord(metadata)) {
        return null;
    }

    const clientThreadId = metadata.client_thread_id;
    return typeof clientThreadId === "string" && clientThreadId.trim().length > 0
        ? clientThreadId
        : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
