import { useMemo } from "react";

import { useAvailableAiRuntimeModelsQuery } from "@/hooks/queries/use-ai-runtime-models";
import type { AvailableRuntimeModel } from "@/lib/ai-runtime/providers";
import { useSettingsStore } from "@/store/slices/settings-slice";

export interface SelectedAiRuntimeModelState {
    selectedModel: AvailableRuntimeModel | null;
    selectedModelPreference: {
        providerId: string;
        modelId: string;
    } | null;
    availableModels: AvailableRuntimeModel[];
    isLoading: boolean;
    isAvailabilityKnown: boolean;
    error: Error | null;
    hasStaleSelection: boolean;
    canRun: boolean;
}

export function canRunSelectedAiRuntimeModel(input: {
    selectedModel: AvailableRuntimeModel | null;
    isAvailabilityKnown: boolean;
    isFetching: boolean;
    error: Error | null;
}): boolean {
    return (
        input.isAvailabilityKnown &&
        input.error === null &&
        input.selectedModel !== null
    );
}

export function useSelectedAiRuntimeModel(): SelectedAiRuntimeModelState {
    const selectedModelPreference = useSettingsStore(
        (state) => state.ai.selectedModel,
    );
    const availableModelsQuery = useAvailableAiRuntimeModelsQuery();
    const availableModels = availableModelsQuery.data ?? [];
    const selectedModel = useMemo(() => {
        if (!selectedModelPreference) {
            return null;
        }

        return (
            availableModels.find(
                (model) =>
                    model.providerId === selectedModelPreference.providerId &&
                    model.modelId === selectedModelPreference.modelId,
            ) ?? null
        );
    }, [availableModels, selectedModelPreference]);
    const isAvailabilityKnown = availableModelsQuery.isSuccess;

    return {
        selectedModel,
        selectedModelPreference,
        availableModels,
        isLoading: availableModelsQuery.isLoading,
        isAvailabilityKnown,
        error: availableModelsQuery.error ?? null,
        hasStaleSelection:
            isAvailabilityKnown &&
            selectedModelPreference !== null &&
            selectedModel === null,
        canRun: canRunSelectedAiRuntimeModel({
            selectedModel,
            isAvailabilityKnown,
            isFetching: availableModelsQuery.isFetching,
            error: availableModelsQuery.error ?? null,
        }),
    };
}
