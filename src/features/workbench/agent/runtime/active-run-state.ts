export interface ActiveRunMappingInput {
    clientThreadId?: string | null;
    conversationId?: string | null;
    runId?: string | null;
}

export class AgentActiveRunState {
    private readonly runIdByClientThreadId = new Map<string, string>();
    private readonly runIdByConversationId = new Map<string, string>();

    record(input: ActiveRunMappingInput): void {
        const runId = normalize(input.runId);
        if (!runId) {
            return;
        }

        const clientThreadId = normalize(input.clientThreadId);
        if (clientThreadId) {
            this.runIdByClientThreadId.set(clientThreadId, runId);
        }

        const conversationId = normalize(input.conversationId);
        if (conversationId) {
            this.runIdByConversationId.set(conversationId, runId);
        }
    }

    clear(input: ActiveRunMappingInput): void {
        const runId = normalize(input.runId);
        const clientThreadId = normalize(input.clientThreadId);
        const conversationId = normalize(input.conversationId);

        if (clientThreadId) {
            this.runIdByClientThreadId.delete(clientThreadId);
        }
        if (conversationId) {
            this.runIdByConversationId.delete(conversationId);
        }

        if (runId) {
            for (const [key, value] of this.runIdByClientThreadId) {
                if (value === runId) {
                    this.runIdByClientThreadId.delete(key);
                }
            }
            for (const [key, value] of this.runIdByConversationId) {
                if (value === runId) {
                    this.runIdByConversationId.delete(key);
                }
            }
        }
    }

    getRunId(input: {
        clientThreadId?: string | null;
        conversationId?: string | null;
    }): string | null {
        const clientThreadId = normalize(input.clientThreadId);
        if (clientThreadId) {
            const runId = this.runIdByClientThreadId.get(clientThreadId);
            if (runId) {
                return runId;
            }
        }

        const conversationId = normalize(input.conversationId);
        return conversationId ? this.runIdByConversationId.get(conversationId) ?? null : null;
    }

    hasRunId(runId: string | null | undefined): boolean {
        const normalizedRunId = normalize(runId);
        if (!normalizedRunId) {
            return false;
        }

        return (
            [...this.runIdByClientThreadId.values()].includes(normalizedRunId) ||
            [...this.runIdByConversationId.values()].includes(normalizedRunId)
        );
    }
}

function normalize(value: string | null | undefined): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}
