import type { AiRuntimeEventEnvelope } from "@/lib/ai-runtime/events";

export interface PendingRuntimeHistoryScope {
    global: boolean;
    conversationIds: Set<string>;
    titleConversationIds: Set<string>;
    runningReloadConversationIds: Set<string>;
}

export function createEmptyPendingRuntimeHistoryScope(): PendingRuntimeHistoryScope {
    return {
        global: false,
        conversationIds: new Set<string>(),
        titleConversationIds: new Set<string>(),
        runningReloadConversationIds: new Set<string>(),
    };
}

export function markPendingRuntimeHistoryScope(
    pending: PendingRuntimeHistoryScope,
    event: AiRuntimeEventEnvelope,
): void {
    if (event.type === "context.compaction.updated") {
        if (event.scope.kind === "conversation") {
            pending.runningReloadConversationIds.add(event.scope.conversation_id);
        } else if (
            event.scope.kind === "run" &&
            event.scope.conversation_id
        ) {
            pending.runningReloadConversationIds.add(event.scope.conversation_id);
        }
    }

    if (
        event.type === "conversation.updated" &&
        event.scope.kind === "conversation"
    ) {
        pending.titleConversationIds.add(event.scope.conversation_id);
    }

    if (event.scope.kind === "global") {
        pending.global = true;
        return;
    }

    if (event.scope.kind === "conversation") {
        pending.conversationIds.add(event.scope.conversation_id);
        return;
    }

    if (event.scope.conversation_id) {
        pending.conversationIds.add(event.scope.conversation_id);
        return;
    }

    pending.global = true;
}

export function shouldReloadRuntimeHistory(input: {
    conversationId: string;
    isRunning: boolean;
    pending: PendingRuntimeHistoryScope;
}): boolean {
    if (
        !input.pending.global &&
        !input.pending.conversationIds.has(input.conversationId)
    ) {
        return false;
    }

    return !input.isRunning || input.pending.runningReloadConversationIds.has(
        input.conversationId,
    );
}
