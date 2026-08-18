import { aiRuntimeRequest } from "@/lib/ai-runtime/request";

const AI_RUNTIME_V1_PREFIX = "/v1";

export type AutoApproveMaxRisk = "none" | "low" | "medium";
export type NetworkAccessScope = "local-and-public" | "public-only";

export interface RuntimeToolPolicySettings {
    autoApproveMaxRisk: AutoApproveMaxRisk;
}

export interface RuntimeSettings {
    toolPolicy: RuntimeToolPolicySettings;
    networkPolicy: {
        accessScope: NetworkAccessScope;
    };
}

interface RawRuntimeSettings {
    tool_policy: {
        auto_approve_max_risk: AutoApproveMaxRisk;
    };
    network_policy: {
        access_scope: NetworkAccessScope;
    };
}

function toRuntimeSettings(raw: RawRuntimeSettings): RuntimeSettings {
    return {
        toolPolicy: {
            autoApproveMaxRisk: raw.tool_policy.auto_approve_max_risk,
        },
        networkPolicy: {
            accessScope: raw.network_policy.access_scope,
        },
    };
}

export async function getRuntimeSettings(
    signal?: AbortSignal,
): Promise<RuntimeSettings> {
    const response = await aiRuntimeRequest<RawRuntimeSettings>(
        `${AI_RUNTIME_V1_PREFIX}/settings`,
        { signal },
    );
    return toRuntimeSettings(response);
}
export async function updateRuntimeSettings(
    settings: RuntimeSettings,
): Promise<RuntimeSettings> {
    const response = await aiRuntimeRequest<RawRuntimeSettings>(
        `${AI_RUNTIME_V1_PREFIX}/settings`,
        {
            method: "PUT",
            json: {
                tool_policy: {
                    auto_approve_max_risk:
                        settings.toolPolicy.autoApproveMaxRisk,
                },
                network_policy: {
                    access_scope: settings.networkPolicy.accessScope,
                },
            },
        },
    );
    return toRuntimeSettings(response);
}
