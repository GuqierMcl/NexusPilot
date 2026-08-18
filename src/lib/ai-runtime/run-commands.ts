import { aiRuntimeRequest } from "./request";
import {
    buildConversationInterruptActiveRunPath,
    buildRunInterruptPath,
    type ConversationInterruptActiveRunResponse,
    type RunInterruptRequest,
    type RunInterruptResponse,
} from "./runs";

export async function interruptRuntimeRun(
    runId: string,
    request: RunInterruptRequest = {},
): Promise<RunInterruptResponse> {
    return aiRuntimeRequest<RunInterruptResponse>(buildRunInterruptPath(runId), {
        method: "POST",
        json: buildInterruptRequestBody(request),
    });
}

export async function interruptRuntimeConversationActiveRun(
    conversationId: string,
    request: RunInterruptRequest = {},
): Promise<ConversationInterruptActiveRunResponse> {
    return aiRuntimeRequest<ConversationInterruptActiveRunResponse>(
        buildConversationInterruptActiveRunPath(conversationId),
        {
            method: "POST",
            json: buildInterruptRequestBody(request),
        },
    );
}

function buildInterruptRequestBody(request: RunInterruptRequest): RunInterruptRequest {
    return {
        reason: request.reason ?? "user_stop",
        ...(request.message ? { message: request.message } : {}),
        ...(request.client_request_id
            ? { client_request_id: request.client_request_id }
            : {}),
    };
}
