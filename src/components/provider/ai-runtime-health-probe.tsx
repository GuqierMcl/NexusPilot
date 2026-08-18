import { useEffect } from "react";

import { useAiRuntimeHealthQuery } from "@/hooks/queries/use-ai-runtime-health";
import { getAiRuntimeUserFacingErrorMessage } from "@/lib/ai-runtime/error";
import { useAiRuntimeEndpointStore } from "@/store/slices/ai-runtime-endpoint-slice";

export function AiRuntimeHealthProbe() {
    const endpoint = useAiRuntimeEndpointStore((s) => s.endpoint);
    const setHealthStatus = useAiRuntimeEndpointStore((s) => s.setHealthStatus);
    const resetHealthStatus = useAiRuntimeEndpointStore((s) => s.resetHealthStatus);
    const healthQuery = useAiRuntimeHealthQuery();

    useEffect(() => {
        if (!endpoint) {
            resetHealthStatus();
        }
    }, [endpoint, resetHealthStatus]);

    useEffect(() => {
        if (endpoint && healthQuery.fetchStatus === "fetching") {
            setHealthStatus({
                isChecking: true,
                errorMessage: null,
            });
        }
    }, [
        endpoint,
        healthQuery.fetchStatus,
        setHealthStatus,
    ]);

    useEffect(() => {
        if (!endpoint || !healthQuery.data || healthQuery.dataUpdatedAt === 0) {
            return;
        }

        setHealthStatus({
            healthStatus: "healthy",
            isChecking: false,
            version: healthQuery.data.version,
            backendBridge: healthQuery.data.backendBridge ?? null,
            lastCheckedAt: healthQuery.dataUpdatedAt,
            errorMessage: null,
        });
    }, [
        endpoint,
        healthQuery.data,
        healthQuery.dataUpdatedAt,
        setHealthStatus,
    ]);

    useEffect(() => {
        if (!endpoint || !healthQuery.error || healthQuery.errorUpdatedAt === 0) {
            return;
        }

        setHealthStatus({
            healthStatus: "unhealthy",
            isChecking: false,
            version: null,
            lastCheckedAt: healthQuery.errorUpdatedAt,
            errorMessage: getAiRuntimeUserFacingErrorMessage(healthQuery.error),
            backendBridge: null,
        });
    }, [
        endpoint,
        healthQuery.error,
        healthQuery.errorUpdatedAt,
        setHealthStatus,
    ]);

    return null;
}
