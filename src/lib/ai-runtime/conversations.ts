import type { UIMessage } from "ai";

import { aiRuntimeRequest } from "./request";
export { isRuntimeConversationId, isRuntimeId } from "./runtime-ids";

export interface AiRuntimeConversationSummary {
    id: string;
    title: string;
    status: Record<string, unknown>;
    active_run_id?: string;
    time: {
        created: number;
        updated: number;
        archived?: number;
        compacting?: number;
    };
    metadata?: Record<string, unknown>;
}

export type AiRuntimeMessageHistoryFormat = "ai_sdk";
export type AiRuntimeMessageHistoryView = "active" | "transcript";

export interface AiRuntimeTranscriptRunSnapshot {
    id: string;
    conversation_id: string;
    parent_run_id?: string;
    supersedes_run_id?: string;
    agent_mode: "ask" | "query" | "agent";
    provider_id: string;
    model_id: string;
    status: string;
    finish?: string;
    time: {
        created: number;
        started?: number;
        completed?: number;
    };
}

export interface AiRuntimeContextCompactionActivity {
    id: string;
    conversationId: string;
    runId: string;
    requestIndex: number;
    boundaryStepIndex?: number;
    attemptIndex: number;
    trigger:
        | "auto_pre_turn"
        | "auto_mid_turn"
        | "manual"
        | "provider_overflow"
        | "model_switch";
    status: "preparing" | "created" | "failed" | "recovered" | "interrupted";
    checkpointId?: string;
    beforeEstimatedInputTokens: number;
    afterEstimatedInputTokens?: number;
    startedAt: number;
    completedAt?: number;
}

export interface CreateRuntimeConversationInput {
    title?: string;
    metadata?: Record<string, unknown>;
}

export interface RenameRuntimeConversationInput {
    title: string;
}

export interface RuntimeConversationReadOptions {
    silent?: boolean;
}

interface ListRuntimeConversationsResponse {
    conversations: AiRuntimeConversationSummary[];
}

interface GetRuntimeConversationResponse {
    conversation: AiRuntimeConversationSummary;
}

interface CreateRuntimeConversationResponse {
    conversation: AiRuntimeConversationSummary;
}

interface RuntimeConversationMutationResponse {
    conversation: AiRuntimeConversationSummary;
}

interface DeleteRuntimeConversationResponse {
    deleted: boolean;
    conversation_id: string;
}

export interface AiRuntimeConversationMessagesSnapshot<
    TFormat extends AiRuntimeMessageHistoryFormat = AiRuntimeMessageHistoryFormat,
> {
    conversation_id: string;
    active_head_run_id?: string;
    revision: number;
    view: AiRuntimeMessageHistoryView;
    format: TFormat;
    messages: UIMessage[];
    context_compaction_activities: AiRuntimeContextCompactionActivity[];
    runs?: AiRuntimeTranscriptRunSnapshot[];
}

export async function listRuntimeConversations(
    signal?: AbortSignal,
): Promise<AiRuntimeConversationSummary[]> {
    const response = await aiRuntimeRequest<ListRuntimeConversationsResponse>(
        "/v1/conversations",
        { signal },
    );

    return response.conversations;
}

export async function createRuntimeConversation(
    input: CreateRuntimeConversationInput = {},
    signal?: AbortSignal,
): Promise<AiRuntimeConversationSummary> {
    const response = await aiRuntimeRequest<CreateRuntimeConversationResponse>(
        "/v1/conversations",
        {
            method: "POST",
            json: input,
            signal,
        },
    );

    return response.conversation;
}

export async function getRuntimeConversation(
    conversationId: string,
    signal?: AbortSignal,
    options: RuntimeConversationReadOptions = {},
): Promise<AiRuntimeConversationSummary> {
    const encodedConversationId = encodeURIComponent(conversationId);
    const response = await aiRuntimeRequest<GetRuntimeConversationResponse>(
        `/v1/conversations/${encodedConversationId}`,
        { signal, silent: options.silent },
    );

    return response.conversation;
}

export async function renameRuntimeConversation(
    conversationId: string,
    input: RenameRuntimeConversationInput,
    signal?: AbortSignal,
): Promise<AiRuntimeConversationSummary> {
    const encodedConversationId = encodeURIComponent(conversationId);
    const response = await aiRuntimeRequest<RuntimeConversationMutationResponse>(
        `/v1/conversations/${encodedConversationId}`,
        {
            method: "PATCH",
            json: input,
            signal,
        },
    );

    return response.conversation;
}

export async function archiveRuntimeConversation(
    conversationId: string,
    signal?: AbortSignal,
): Promise<AiRuntimeConversationSummary> {
    return mutateRuntimeConversation(conversationId, "archive", signal);
}

export async function unarchiveRuntimeConversation(
    conversationId: string,
    signal?: AbortSignal,
): Promise<AiRuntimeConversationSummary> {
    return mutateRuntimeConversation(conversationId, "unarchive", signal);
}

export async function pinRuntimeConversation(
    conversationId: string,
    signal?: AbortSignal,
): Promise<AiRuntimeConversationSummary> {
    return mutateRuntimeConversation(conversationId, "pin", signal);
}

export async function unpinRuntimeConversation(
    conversationId: string,
    signal?: AbortSignal,
): Promise<AiRuntimeConversationSummary> {
    return mutateRuntimeConversation(conversationId, "unpin", signal);
}

export async function deleteRuntimeConversation(
    conversationId: string,
    signal?: AbortSignal,
): Promise<DeleteRuntimeConversationResponse> {
    const encodedConversationId = encodeURIComponent(conversationId);
    return await aiRuntimeRequest<DeleteRuntimeConversationResponse>(
        `/v1/conversations/${encodedConversationId}`,
        {
            method: "DELETE",
            signal,
        },
    );
}

export async function getRuntimeConversationMessages(
    format: "ai_sdk",
    conversationId: string,
    signal?: AbortSignal,
    options: RuntimeConversationReadOptions = {},
): Promise<UIMessage[]> {
    const snapshot = await getRuntimeConversationMessagesSnapshot(
        format,
        conversationId,
        signal,
        options,
    );
    return snapshot.messages;
}

export async function getRuntimeConversationMessagesSnapshot(
    format: "ai_sdk",
    conversationId: string,
    signal?: AbortSignal,
    options: RuntimeConversationReadOptions = {},
): Promise<AiRuntimeConversationMessagesSnapshot<typeof format>> {
    const encodedConversationId = encodeURIComponent(conversationId);
    const encodedFormat = encodeURIComponent(format);
    const response = await aiRuntimeRequest<AiRuntimeConversationMessagesSnapshot<typeof format>>(
        `/v1/conversations/${encodedConversationId}/messages?format=${encodedFormat}`,
        { signal, silent: options.silent },
    );

    return response;
}

async function mutateRuntimeConversation(
    conversationId: string,
    command: "archive" | "unarchive" | "pin" | "unpin",
    signal?: AbortSignal,
): Promise<AiRuntimeConversationSummary> {
    const encodedConversationId = encodeURIComponent(conversationId);
    const response = await aiRuntimeRequest<RuntimeConversationMutationResponse>(
        `/v1/conversations/${encodedConversationId}/${command}`,
        {
            method: "POST",
            signal,
        },
    );

    return response.conversation;
}
