"use client";

import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from "react";

import { appendAiRuntimeAuthorization } from "@/lib/ai-runtime/endpoint";
import type { ToolPermissionSnapshot } from "@/lib/ai-runtime/runs";

interface ToolPermissionContextValue {
    baseUrl: string;
    accessToken: string | null;
}

interface ToolPermissionProviderProps extends ToolPermissionContextValue {
    children: ReactNode;
}

interface ToolPermissionLoadState {
    permission: ToolPermissionSnapshot | null;
    loading: boolean;
    error: string | null;
}

const ToolPermissionContext = createContext<ToolPermissionContextValue | null>(
    null,
);

export function AgentToolPermissionProvider({
    baseUrl,
    accessToken,
    children,
}: ToolPermissionProviderProps) {
    const value = useMemo(
        () => ({ baseUrl, accessToken }),
        [accessToken, baseUrl],
    );
    return (
        <ToolPermissionContext.Provider value={value}>
            {children}
        </ToolPermissionContext.Provider>
    );
}

export function useToolPermissionSnapshot(
    approvalId: string | undefined,
): ToolPermissionLoadState {
    const context = useContext(ToolPermissionContext);
    const [state, setState] = useState<ToolPermissionLoadState>({
        permission: null,
        loading: Boolean(approvalId),
        error: null,
    });

    useEffect(() => {
        if (!context || !approvalId) {
            setState({ permission: null, loading: false, error: null });
            return;
        }

        const controller = new AbortController();
        setState({ permission: null, loading: true, error: null });
        const path = approvalId.startsWith("perm_")
            ? `/v1/permissions/${encodeURIComponent(approvalId)}`
            : `/v1/tool-approvals/${encodeURIComponent(approvalId)}/permission`;
        const load = async (): Promise<void> => {
            let response: Response | null = null;
            for (let attempt = 0; attempt < 6; attempt += 1) {
                response = await fetch(
                    `${context.baseUrl.replace(/\/+$/, "")}${path}`,
                    {
                        headers: appendAiRuntimeAuthorization(
                            undefined,
                            context.accessToken,
                        ),
                        signal: controller.signal,
                    },
                );
                if (
                    response.status !== 404 ||
                    approvalId.startsWith("perm_") ||
                    attempt === 5
                ) {
                    break;
                }
                await waitForPermissionBinding(controller.signal, 150);
            }
            if (!response) {
                throw new Error("Permission snapshot request did not start");
            }
            if (!response.ok) {
                throw new Error(
                    `Permission snapshot request failed (${response.status})`,
                );
            }
            const payload = (await response.json()) as {
                permission?: ToolPermissionSnapshot;
            };
            if (!payload.permission) {
                throw new Error("Permission snapshot response is incomplete");
            }
            setState({
                permission: payload.permission,
                loading: false,
                error: null,
            });
        };
        void load().catch((error: unknown) => {
            if (controller.signal.aborted) {
                return;
            }
            setState({
                permission: null,
                loading: false,
                error:
                    error instanceof Error
                        ? error.message
                        : "Permission snapshot request failed",
            });
        });

        return () => controller.abort();
    }, [approvalId, context]);

    return state;
}

function waitForPermissionBinding(
    signal: AbortSignal,
    delayMs: number,
): Promise<void> {
    return new Promise((resolve) => {
        const timer = window.setTimeout(resolve, delayMs);
        signal.addEventListener(
            "abort",
            () => {
                window.clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });
}
