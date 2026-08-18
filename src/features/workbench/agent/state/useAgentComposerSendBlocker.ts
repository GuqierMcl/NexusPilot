import { useAuiState } from "@assistant-ui/react";

import { useSelectedAiRuntimeModel } from "@/features/workbench/agent/model";
import { useAiRuntimeEndpointStore } from "@/store/slices/ai-runtime-endpoint-slice";

import {
    getAgentComposerSendBlocker,
    type AgentComposerSendBlocker,
} from "./agent-panel-state";

/**
 * Derives the current agent send blocker from the shared assistant runtime.
 *
 * The result is intentionally UI-agnostic so the composer and the workbench
 * status bar can present the same condition without maintaining duplicate
 * lifecycle state.
 */
export function useAgentComposerSendBlocker(): AgentComposerSendBlocker | null {
    const healthStatus = useAiRuntimeEndpointStore((state) => state.healthStatus);
    const runtimeChecking = useAiRuntimeEndpointStore((state) => state.isChecking);
    const threadRunning = useAuiState((state) => state.thread.isRunning);
    const threadLoading = useAuiState((state) => state.thread.isLoading);
    const threadsLoading = useAuiState((state) => state.threads.isLoading);
    const {
        selectedModel,
        selectedModelPreference,
        isAvailabilityKnown,
    } = useSelectedAiRuntimeModel();

    return getAgentComposerSendBlocker({
        runtimeAvailable: healthStatus === "healthy",
        runtimeChecking,
        threadRunning,
        threadRecovering: threadLoading && !threadRunning && !threadsLoading,
        modelPreferenceSelected: selectedModelPreference !== null,
        selectedModelAvailable: selectedModel !== null,
        modelAvailabilityKnown: isAvailabilityKnown,
        adapterErrorMessage: null,
    });
}
