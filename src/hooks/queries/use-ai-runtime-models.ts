import { useQuery } from "@tanstack/react-query";

import {
    listAvailableRuntimeModels,
    type AvailableRuntimeModel,
} from "@/lib/ai-runtime/providers";
import { queryKeys } from "@/lib/query-keys";
import { useAiRuntimeEndpointStore } from "@/store/slices/ai-runtime-endpoint-slice";

export function useAvailableAiRuntimeModelsQuery() {
    const isAiRuntimeHealthy = useAiRuntimeEndpointStore(
        (state) => state.healthStatus === "healthy",
    );

    return useQuery<AvailableRuntimeModel[], Error>({
        queryKey: queryKeys.aiRuntimeAvailableModels(),
        queryFn: ({ signal }) => listAvailableRuntimeModels(signal),
        enabled: isAiRuntimeHealthy,
    });
}
