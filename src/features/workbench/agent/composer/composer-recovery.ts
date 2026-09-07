import { create } from "zustand";
import type { UIMessage } from "ai";

export interface ComposerRecovery {
    message: UIMessage;
    replaceFromMessageId?: string;
    failed: boolean;
}
/** Ephemeral per-thread recovery, never a second persistent transcript. */
export const useComposerRecovery = create<{
    drafts: Readonly<Record<string, ComposerRecovery>>;
    stage: (threadId: string, draft: ComposerRecovery) => void;
    fail: (threadId: string) => void;
    clear: (threadId: string) => void;
}>((set) => ({
    drafts: {},
    stage: (threadId, draft) =>
        set((state) => ({ drafts: { ...state.drafts, [threadId]: draft } })),
    fail: (threadId) =>
        set((state) => {
            const draft = state.drafts[threadId];
            return draft
                ? {
                      drafts: {
                          ...state.drafts,
                          [threadId]: { ...draft, failed: true },
                      },
                  }
                : state;
        }),
    clear: (threadId) =>
        set((state) => {
            const drafts = { ...state.drafts };
            delete drafts[threadId];
            return { drafts };
        }),
}));
