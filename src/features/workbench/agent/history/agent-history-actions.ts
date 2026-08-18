export interface DeleteAgentHistoryItemInput {
    item: {
        id: string;
        active: boolean;
    };
    deleteThread: (threadId: string) => Promise<void>;
    switchToNewThread: () => Promise<void>;
    reloadThreads: () => Promise<void>;
    onConversationSelected: () => void;
}

export async function deleteAgentHistoryItem(
    input: DeleteAgentHistoryItemInput,
): Promise<void> {
    await input.deleteThread(input.item.id);

    if (input.item.active) {
        await input.switchToNewThread();
        input.onConversationSelected();
    }

    await input.reloadThreads();
}
