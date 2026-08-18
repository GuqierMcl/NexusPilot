import { create } from "zustand";

import type { AgentComposerSendBlocker } from "./agent-panel-state";

export interface AgentStatusSnapshot {
    composerSendBlocker: AgentComposerSendBlocker | null;
    activeRunCloseSnapshot: AgentRunCloseSnapshot;
}

/**
 * A read-only projection of the currently active Agent transport for
 * application-close handling. Runtime commands remain inside the Agent panel
 * boundary; consumers may only decide whether a close confirmation is needed.
 */
export interface AgentRunCloseSnapshot {
    isTransportActive: boolean;
    conversationId: string | null;
    runId: string | null;
}

interface AgentStatusSnapshotStore extends AgentStatusSnapshot {
    setComposerSendBlocker: (
        composerSendBlocker: AgentComposerSendBlocker | null,
    ) => void;
    setActiveRunTransportActive: (isTransportActive: boolean) => void;
    setActiveRunCloseSnapshot: (input: {
        conversationId: string | null;
        runId: string | null;
    }) => void;
    clearActiveRunCloseSnapshot: (input?: {
        conversationId?: string | null;
        runId?: string | null;
    }) => void;
}

const emptyAgentRunCloseSnapshot: AgentRunCloseSnapshot = {
    isTransportActive: false,
    conversationId: null,
    runId: null,
};

/**
 * Cross-surface snapshot published by the Agent panel and consumed read-only
 * by the workbench status bar and application-close guard. It deliberately
 * contains no runtime actions.
 */
export const useAgentStatusSnapshotStore = create<AgentStatusSnapshotStore>(
    (set) => ({
        composerSendBlocker: null,
        activeRunCloseSnapshot: emptyAgentRunCloseSnapshot,
        setComposerSendBlocker: (composerSendBlocker) =>
            set({ composerSendBlocker }),
        setActiveRunTransportActive: (isTransportActive) =>
            set((state) => ({
                activeRunCloseSnapshot: isTransportActive
                    ? {
                          ...state.activeRunCloseSnapshot,
                          isTransportActive: true,
                      }
                    : emptyAgentRunCloseSnapshot,
            })),
        setActiveRunCloseSnapshot: ({ conversationId, runId }) =>
            set({
                activeRunCloseSnapshot: {
                    isTransportActive: true,
                    conversationId,
                    runId,
                },
            }),
        clearActiveRunCloseSnapshot: (input = {}) =>
            set((state) => {
                const current = state.activeRunCloseSnapshot;
                const inputRunId = input.runId ?? null;
                const inputConversationId = input.conversationId ?? null;
                const runMatches =
                    inputRunId === null ||
                    current.runId === null ||
                    current.runId === inputRunId;
                const conversationMatches =
                    inputConversationId === null ||
                    current.conversationId === null ||
                    current.conversationId === inputConversationId;

                return runMatches && conversationMatches
                    ? { activeRunCloseSnapshot: emptyAgentRunCloseSnapshot }
                    : {};
            }),
    }),
);
