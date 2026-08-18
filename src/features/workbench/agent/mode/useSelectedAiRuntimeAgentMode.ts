import { useMemo } from "react";

import { useAiRuntimeAgentModesQuery } from "@/hooks/queries/use-ai-runtime-agent-modes";
import type { AvailableAgentMode } from "@/lib/ai-runtime/agent-modes";
import type { RunAgentMode } from "@/lib/ai-runtime/runs";
import { useSettingsStore } from "@/store/slices/settings-slice";

import {
    resolveAgentModeOptions,
    resolveSelectedAgentModeOption,
} from "./agent-mode-options";

export interface SelectedAiRuntimeAgentModeState {
    selectedAgentMode: RunAgentMode;
    selectedAgentModeOption: AvailableAgentMode | null;
    agentModeOptions: AvailableAgentMode[];
    isLoading: boolean;
    isRuntimeCatalogKnown: boolean;
    error: Error | null;
}

export function useSelectedAiRuntimeAgentMode(): SelectedAiRuntimeAgentModeState {
    const selectedAgentMode = useSettingsStore(
        (state) => state.ai.selectedAgentMode,
    );
    const agentModesQuery = useAiRuntimeAgentModesQuery();
    const agentModeOptions = useMemo(
        () => resolveAgentModeOptions(agentModesQuery.data),
        [agentModesQuery.data],
    );
    const selectedAgentModeOption = useMemo(
        () => resolveSelectedAgentModeOption(agentModeOptions, selectedAgentMode),
        [agentModeOptions, selectedAgentMode],
    );

    return {
        selectedAgentMode:
            selectedAgentModeOption?.agentMode ?? selectedAgentMode,
        selectedAgentModeOption,
        agentModeOptions,
        isLoading: agentModesQuery.isLoading,
        isRuntimeCatalogKnown: agentModesQuery.isSuccess,
        error: agentModesQuery.error ?? null,
    };
}
