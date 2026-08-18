"use client";

import {
    createContext,
    useContext,
    useMemo,
    type MutableRefObject,
    type ReactNode,
} from "react";
import { useAui } from "@assistant-ui/react";

import {
    interruptRuntimeConversationActiveRun,
    interruptRuntimeRun,
} from "@/lib/ai-runtime/run-commands";
import { isRuntimeConversationId } from "@/lib/ai-runtime/runtime-ids";

import type { AgentActiveRunState } from "./active-run-state";

export interface AgentRuntimeInterruptController {
    interruptCurrentRun(input?: { message?: string }): Promise<void>;
    interruptConversation(input: {
        conversationId: string;
        message?: string;
    }): Promise<void>;
}

interface AgentRuntimeInterruptProviderProps {
    activeRunStateRef: MutableRefObject<AgentActiveRunState>;
    children: ReactNode;
}

const AgentRuntimeInterruptContext =
    createContext<AgentRuntimeInterruptController | null>(null);

export function AgentRuntimeInterruptProvider({
    activeRunStateRef,
    children,
}: AgentRuntimeInterruptProviderProps) {
    const aui = useAui();
    const controller = useMemo<AgentRuntimeInterruptController>(
        () => ({
            async interruptCurrentRun(input = {}) {
                const threadState = readCurrentThreadState(aui);
                const conversationId = isRuntimeConversationId(threadState.remoteId)
                    ? threadState.remoteId
                    : null;
                const runId = activeRunStateRef.current.getRunId({
                    clientThreadId: threadState.id,
                    conversationId,
                });

                if (runId) {
                    const response = await interruptRuntimeRun(runId, {
                        reason: "user_stop",
                        message: input.message,
                    });
                    activeRunStateRef.current.clear({
                        clientThreadId: threadState.id,
                        conversationId: response.conversation_id,
                        runId: response.run_id,
                    });
                    return;
                }

                if (conversationId) {
                    await interruptRuntimeConversationActiveRun(conversationId, {
                        reason: "user_stop",
                        message: input.message,
                    });
                }
            },
            async interruptConversation(input) {
                const response = await interruptRuntimeConversationActiveRun(
                    input.conversationId,
                    {
                        reason: "user_stop",
                        message: input.message,
                    },
                );

                activeRunStateRef.current.clear({
                    conversationId: input.conversationId,
                    runId: response.run_id,
                });
            },
        }),
        [activeRunStateRef, aui],
    );

    return (
        <AgentRuntimeInterruptContext.Provider value={controller}>
            {children}
        </AgentRuntimeInterruptContext.Provider>
    );
}

export function useAgentRuntimeInterruptController(): AgentRuntimeInterruptController {
    const controller = useContext(AgentRuntimeInterruptContext);
    if (!controller) {
        throw new Error("AgentRuntimeInterruptProvider is missing.");
    }

    return controller;
}

function readCurrentThreadState(aui: ReturnType<typeof useAui>): {
    id: string | null;
    remoteId: string | null;
} {
    const state = aui.threadListItem().getState() as {
        id?: unknown;
        remoteId?: unknown;
    };

    return {
        id: typeof state.id === "string" ? state.id : null,
        remoteId: typeof state.remoteId === "string" ? state.remoteId : null,
    };
}
