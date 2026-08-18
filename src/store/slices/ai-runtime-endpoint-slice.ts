import { create } from "zustand";

import type { AiRuntimeEndpoint } from "@/lib/ai-runtime/endpoint";
import type { AiRuntimeHealthResponse } from "@/lib/ai-runtime/health";

export type AiRuntimeHealthStatus =
    | "unknown"
    | "healthy"
    | "unhealthy";

export interface AiRuntimeHealthUpdate {
    healthStatus?: AiRuntimeHealthStatus;
    isChecking?: boolean;
    version?: string | null;
    lastCheckedAt?: number | null;
    errorMessage?: string | null;
    backendBridge?: AiRuntimeHealthResponse["backendBridge"] | null;
}

interface AiRuntimeEndpointState {
    endpoint: AiRuntimeEndpoint | null;
    healthStatus: AiRuntimeHealthStatus;
    isChecking: boolean;
    version: string | null;
    lastCheckedAt: number | null;
    errorMessage: string | null;
    backendBridge: AiRuntimeHealthResponse["backendBridge"] | null;
    setEndpoint: (endpoint: AiRuntimeEndpoint) => void;
    setHealthStatus: (update: AiRuntimeHealthUpdate) => void;
    resetHealthStatus: () => void;
}

export const useAiRuntimeEndpointStore = create<AiRuntimeEndpointState>((set) => ({
    endpoint: null,
    healthStatus: "unknown",
    isChecking: false,
    version: null,
    lastCheckedAt: null,
    errorMessage: null,
    backendBridge: null,
    setEndpoint: (endpoint) =>
        set({
            endpoint,
            healthStatus: "unknown",
            isChecking: false,
            version: null,
            lastCheckedAt: null,
            errorMessage: null,
            backendBridge: null,
        }),
    setHealthStatus: (update) =>
        set((state) => ({
            healthStatus: update.healthStatus ?? state.healthStatus,
            isChecking:
                "isChecking" in update
                    ? update.isChecking ?? false
                    : state.isChecking,
            version: "version" in update ? update.version ?? null : state.version,
            lastCheckedAt:
                "lastCheckedAt" in update
                    ? update.lastCheckedAt ?? null
                    : state.lastCheckedAt,
            errorMessage:
                "errorMessage" in update
                    ? update.errorMessage ?? null
                    : state.errorMessage,
            backendBridge:
                "backendBridge" in update
                    ? update.backendBridge ?? null
                    : state.backendBridge,
        })),
    resetHealthStatus: () =>
        set({
            healthStatus: "unknown",
            isChecking: false,
            version: null,
            lastCheckedAt: null,
            errorMessage: null,
            backendBridge: null,
        }),
}));
