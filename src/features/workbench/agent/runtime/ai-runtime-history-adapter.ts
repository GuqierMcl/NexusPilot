import type {
    MessageFormatAdapter,
    MessageFormatRepository,
    ThreadHistoryAdapter,
} from "@assistant-ui/react";
import type { UIMessage } from "ai";

import { isRuntimeConversationId } from "@/lib/ai-runtime/runtime-ids";

export interface CreateAiRuntimeHistoryAdapterInput {
    getConversationId: () => string | null | undefined;
    loadMessages?: (conversationId: string, signal?: AbortSignal) => Promise<UIMessage[]>;
}

export function createAiRuntimeHistoryAdapter(
    input: CreateAiRuntimeHistoryAdapterInput,
): ThreadHistoryAdapter {
    return {
        async load() {
            return { messages: [] };
        },
        async append() {},
        withFormat<TMessage, TStorageFormat extends Record<string, unknown>>(
            formatAdapter: MessageFormatAdapter<TMessage, TStorageFormat>,
        ) {
            return {
                load: async () => {
                    const conversationId = normalizeConversationId(input.getConversationId());
                    if (!conversationId) {
                        return { messages: [] };
                    }

                    const messages = (await loadAiSdkMessages(
                        input,
                        conversationId,
                    )) as TMessage[];
                    return toMessageFormatRepository(messages, formatAdapter);
                },
                async append() {},
                async update() {},
                async delete() {},
            };
        },
    };
}

function toMessageFormatRepository<TMessage>(
    messages: TMessage[],
    formatAdapter: Pick<MessageFormatAdapter<TMessage, Record<string, unknown>>, "getId">,
): MessageFormatRepository<TMessage> {
    if (messages.length === 0) {
        return { messages: [] };
    }

    return {
        headId: formatAdapter.getId(messages[messages.length - 1]!),
        messages: messages.map((message, index) => ({
            parentId: index === 0 ? null : formatAdapter.getId(messages[index - 1]!),
            message,
        })),
    };
}

async function loadAiSdkMessages(
    input: CreateAiRuntimeHistoryAdapterInput,
    conversationId: string,
): Promise<UIMessage[]> {
    if (input.loadMessages) {
        return await input.loadMessages(conversationId);
    }

    const { getRuntimeConversationMessages } = await import(
        "@/lib/ai-runtime/conversations"
    );
    return await getRuntimeConversationMessages("ai_sdk", conversationId);
}

function normalizeConversationId(value: string | null | undefined): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const normalized = value.trim();
    return isRuntimeConversationId(normalized) ? normalized : null;
}
