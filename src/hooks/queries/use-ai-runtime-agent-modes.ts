import { useQuery } from "@tanstack/react-query";

import {
    listAgentModes,
    type AvailableAgentMode,
} from "@/lib/ai-runtime/agent-modes";
import { queryKeys } from "@/lib/query-keys";
import { useAiRuntimeEndpointStore } from "@/store/slices/ai-runtime-endpoint-slice";

export function useAiRuntimeAgentModesQuery() {
    const isAiRuntimeHealthy = useAiRuntimeEndpointStore(
        (state) => state.healthStatus === "healthy",
    );

    return useQuery<AvailableAgentMode[], Error>({
        queryKey: queryKeys.aiRuntimeAgentModes(),
        queryFn: ({ signal }) => listAgentModes(signal),
        enabled: isAiRuntimeHealthy,
    });
}
