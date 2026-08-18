import { useQuery } from "@tanstack/react-query";

import {
    checkAiRuntimeHealth,
    type AiRuntimeHealthResult,
} from "@/lib/ai-runtime/health";
import { useAiRuntimeEndpointStore } from "@/store/slices/ai-runtime-endpoint-slice";

const HEALTH_CHECK_INTERVAL_MS = 5_000;

export function useAiRuntimeHealthQuery() {
    const endpoint = useAiRuntimeEndpointStore((s) => s.endpoint);

    return useQuery<AiRuntimeHealthResult, Error>({
        queryKey: ["ai-runtime", "health", endpoint?.baseUrl],
        queryFn: ({ signal }) => {
            if (!endpoint) {
                throw new Error("AI Runtime endpoint is not available");
            }

            return checkAiRuntimeHealth(endpoint.baseUrl, signal);
        },
        enabled: endpoint !== null,
        refetchInterval: HEALTH_CHECK_INTERVAL_MS,
        retry: false,
        networkMode: "always",
        staleTime: 0,
    });
}
