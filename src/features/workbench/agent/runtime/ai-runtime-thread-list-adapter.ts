import { type RemoteThreadListAdapter } from "@assistant-ui/react";
import type { UIMessage } from "ai";

import { type AiRuntimeConversationSummary } from "@/lib/ai-runtime/conversations";
import { isRuntimeConversationId } from "@/lib/ai-runtime/runtime-ids";

export type AiRuntimeRemoteThreadMetadata = Awaited<
    ReturnType<RemoteThreadListAdapter["list"]>
>["threads"][number];
type AiRuntimeAssistantStream = Awaited<
    ReturnType<RemoteThreadListAdapter["generateTitle"]>
>;
type AgentThreadMessageLike = {
    role?: string;
    content?: unknown;
    parts?: unknown;
};

export interface AiSdkMessageRepository {
    headId?: string | null;
    messages: Array<{
        parentId: string | null;
        message: UIMessage;
    }>;
}

export interface ReloadRuntimeThreadHistorySnapshotInput {
    conversationId: string | null | undefined;
    loadMessages?: (conversationId: string) => Promise<UIMessage[]>;
    importExternalState: (repository: AiSdkMessageRepository) => void;
}

export interface CreateAiRuntimeThreadListAdapterInput {
    listConversations?: () => Promise<AiRuntimeConversationSummary[]>;
    getConversation?: (
        conversationId: string,
    ) => Promise<AiRuntimeConversationSummary | null>;
    resolveConversationId?: (threadId: string) => string | null;
    /**
     * Deprecated compatibility hook. New assistant-ui local threads must not
     * create Runtime conversations until the first real /v1/runs request.
     */
    createConversation?: (
        input: { metadata?: Record<string, unknown> },
    ) => Promise<AiRuntimeConversationSummary>;
    /**
     * Deprecated compatibility hook kept for old tests/call sites. Runtime
     * conversation mapping now comes from /v1/runs response headers.
     */
    onConversationInitialized?: (input: {
        localThreadId: string;
        conversationId: string;
    }) => void;
    unstableProvider?: RemoteThreadListAdapter["unstable_Provider"];
}

export function createAiRuntimeThreadListAdapter(
    input: CreateAiRuntimeThreadListAdapterInput = {},
): RemoteThreadListAdapter {
    return {
        async list() {
            const conversations = await loadConversations(input);
            return {
                threads: conversations.map(mapRuntimeConversationToThreadMetadata),
            };
        },
        async fetch(remoteId) {
            if (!isRuntimeConversationId(remoteId)) {
                throw new Error(
                    `AI Runtime thread id ${remoteId} is not a Runtime conversation id.`,
                );
            }

            const conversation = await loadConversation(input, remoteId);
            if (!conversation) {
                throw new Error(`AI Runtime conversation ${remoteId} not found.`);
            }

            return mapRuntimeConversationToThreadMetadata(conversation);
        },
        async initialize(threadId) {
            return {
                remoteId: threadId,
                externalId: threadId,
            };
        },
        async rename(remoteId, newTitle) {
            assertRuntimeConversationId(remoteId);
            const { renameRuntimeConversation } = await import(
                "@/lib/ai-runtime/conversations"
            );
            await renameRuntimeConversation(remoteId, { title: newTitle });
        },
        async archive(remoteId) {
            assertRuntimeConversationId(remoteId);
            const { archiveRuntimeConversation } = await import(
                "@/lib/ai-runtime/conversations"
            );
            await archiveRuntimeConversation(remoteId);
        },
        async unarchive(remoteId) {
            assertRuntimeConversationId(remoteId);
            const { unarchiveRuntimeConversation } = await import(
                "@/lib/ai-runtime/conversations"
            );
            await unarchiveRuntimeConversation(remoteId);
        },
        async delete(remoteId) {
            assertRuntimeConversationId(remoteId);
            const { deleteRuntimeConversation } = await import(
                "@/lib/ai-runtime/conversations"
            );
            await deleteRuntimeConversation(remoteId);
        },
        async generateTitle(remoteId) {
            const conversationId = resolveRuntimeConversationId(input, remoteId);
            if (!conversationId) {
                return createEmptyAssistantStream();
            }

            const conversation = await loadConversation(input, conversationId);
            const title = conversation?.title?.trim();
            return title
                ? createAssistantTextStream(title)
                : createEmptyAssistantStream();
        },
        ...(input.unstableProvider
            ? { unstable_Provider: input.unstableProvider }
            : {}),
    };
}

export async function reloadRuntimeThreadHistorySnapshot(
    input: ReloadRuntimeThreadHistorySnapshotInput,
): Promise<boolean> {
    if (!isRuntimeConversationId(input.conversationId)) {
        return false;
    }

    const messages = input.loadMessages
        ? await input.loadMessages(input.conversationId)
        : await loadDefaultAiSdkMessages(input.conversationId);
    input.importExternalState(toAiSdkMessageRepository(messages));
    return true;
}

export function toAiSdkMessageRepository(
    messages: UIMessage[],
): AiSdkMessageRepository {
    if (messages.length === 0) {
        return { messages: [] };
    }

    return {
        headId: messages[messages.length - 1]!.id,
        messages: messages.map((message, index) => ({
            parentId: index === 0 ? null : messages[index - 1]!.id,
            message,
        })),
    };
}

export function mapRuntimeConversationToThreadMetadata(
    conversation: AiRuntimeConversationSummary,
): AiRuntimeRemoteThreadMetadata {
    return {
        remoteId: conversation.id,
        title: conversation.title || undefined,
        status: readThreadStatus(conversation),
        lastMessageAt: new Date(conversation.time.updated),
        custom: buildThreadCustomMetadata(conversation),
    };
}

export function createAgentThreadTitleFromMessages(
    messages: readonly unknown[],
): string | null {
    for (const message of messages) {
        const record = isRecord(message)
            ? (message as AgentThreadMessageLike)
            : null;
        if (record?.role !== "user") {
            continue;
        }

        const text = readThreadMessageText(record);
        if (text) {
            return createCompactThreadTitle(text);
        }
    }

    return null;
}

async function loadConversations(
    input: CreateAiRuntimeThreadListAdapterInput,
): Promise<AiRuntimeConversationSummary[]> {
    if (input.listConversations) {
        return await input.listConversations();
    }

    const { listRuntimeConversations } = await import(
        "@/lib/ai-runtime/conversations"
    );
    return await listRuntimeConversations();
}

async function loadConversation(
    input: CreateAiRuntimeThreadListAdapterInput,
    conversationId: string,
): Promise<AiRuntimeConversationSummary | null> {
    if (input.getConversation) {
        return await input.getConversation(conversationId);
    }

    try {
        const { getRuntimeConversation } = await import(
            "@/lib/ai-runtime/conversations"
        );
        return await getRuntimeConversation(conversationId);
    } catch (error) {
        if (isAiRuntimeNotFoundError(error)) {
            return null;
        }

        throw error;
    }
}

async function loadDefaultAiSdkMessages(
    conversationId: string,
): Promise<UIMessage[]> {
    const { getRuntimeConversationMessages } = await import(
        "@/lib/ai-runtime/conversations"
    );

    return await getRuntimeConversationMessages("ai_sdk", conversationId);
}

function assertRuntimeConversationId(remoteId: string): asserts remoteId is string {
    if (!isRuntimeConversationId(remoteId)) {
        throw new Error(
            `AI Runtime thread id ${remoteId} is not a Runtime conversation id.`,
        );
    }
}

function readThreadStatus(
    conversation: AiRuntimeConversationSummary,
): AiRuntimeRemoteThreadMetadata["status"] {
    if (readRuntimeStatusType(conversation.status) === "archived" || conversation.time.archived) {
        return "archived";
    }

    return "regular";
}

function buildThreadCustomMetadata(
    conversation: AiRuntimeConversationSummary,
): Record<string, unknown> {
    const pinnedAt = readPinnedAt(conversation.metadata);

    return {
        runtimeStatus: conversation.status,
        ...(conversation.active_run_id
            ? { activeRunId: conversation.active_run_id }
            : {}),
        ...(pinnedAt !== null ? { pinnedAt } : {}),
        time: conversation.time,
        ...(conversation.metadata ? { metadata: conversation.metadata } : {}),
    };
}

function readPinnedAt(metadata: Record<string, unknown> | undefined): number | null {
    const ui = isRecord(metadata?.ui) ? metadata.ui : null;
    const pinnedAt = ui?.pinnedAt;
    return typeof pinnedAt === "number" && Number.isFinite(pinnedAt)
        ? pinnedAt
        : null;
}

function createEmptyAssistantStream(): AiRuntimeAssistantStream {
    return new ReadableStream<unknown>({
        start(controller) {
            controller.close();
        },
    }) as unknown as AiRuntimeAssistantStream;
}

function createAssistantTextStream(title: string): AiRuntimeAssistantStream {
    return new ReadableStream<unknown>({
        start(controller) {
            controller.enqueue({
                type: "part-start",
                path: [],
                part: { type: "text" },
            });
            controller.enqueue({
                type: "text-delta",
                path: [0],
                textDelta: title,
            });
            controller.enqueue({
                type: "part-finish",
                path: [0],
            });
            controller.close();
        },
    }) as unknown as AiRuntimeAssistantStream;
}

function resolveRuntimeConversationId(
    input: CreateAiRuntimeThreadListAdapterInput,
    threadId: string,
): string | null {
    if (isRuntimeConversationId(threadId)) {
        return threadId;
    }

    const conversationId = input.resolveConversationId?.(threadId) ?? null;
    return isRuntimeConversationId(conversationId) ? conversationId : null;
}

function readRuntimeStatusType(status: Record<string, unknown>): string | null {
    return typeof status.type === "string" ? status.type : null;
}

function readThreadMessageText(message: AgentThreadMessageLike): string | null {
    if (typeof message.content === "string") {
        return normalizeText(message.content);
    }

    const contentText = Array.isArray(message.content)
        ? readTextFromParts(message.content)
        : null;
    if (contentText) {
        return contentText;
    }

    return Array.isArray(message.parts) ? readTextFromParts(message.parts) : null;
}

function readTextFromParts(parts: readonly unknown[]): string | null {
    const texts: string[] = [];

    for (const part of parts) {
        const record = isRecord(part) ? part : null;
        if (record?.type === "text" && typeof record.text === "string") {
            const text = normalizeText(record.text);
            if (text) {
                texts.push(text);
            }
        }
    }

    return texts.length > 0 ? texts.join(" ") : null;
}

function createCompactThreadTitle(text: string): string {
    const normalized = normalizeText(text);
    const maxLength = 34;
    const chars = Array.from(normalized);

    if (chars.length < maxLength) {
        return normalized;
    }

    return `${chars.slice(0, maxLength - 3).join("")}...`;
}

function normalizeText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function isAiRuntimeNotFoundError(error: unknown): boolean {
    return (
        isRecord(error) &&
        error.name === "AiRuntimeRequestError" &&
        error.status === 404
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
