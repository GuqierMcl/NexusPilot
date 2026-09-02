export interface BaseResponse<T> {
    code: string;
    message: string;
    data: T | null;
}

export interface AiRuntimeHealthResponse {
    status: "ok" | "unhealthy";
    version: string;
    backendBridge?: {
        state: "waiting" | "ready" | "disconnected";
        lastHeartbeatAt?: number;
    };
    attachments?: {
        status: "ok" | "warning" | "unavailable";
        warnings: string[];
    };
}

export interface AiRuntimeHealthResult {
    status: "ok";
    version: string;
    backendBridge: AiRuntimeHealthResponse["backendBridge"];
    attachments: AiRuntimeHealthResponse["attachments"];
}

export async function checkAiRuntimeHealth(
    baseUrl: string,
    signal?: AbortSignal,
): Promise<AiRuntimeHealthResult> {
    const response = await fetch(`${baseUrl}/health`, { signal });

    if (!response.ok) {
        throw new Error(`AI Runtime health check failed: HTTP ${response.status}`);
    }

    const body = (await response.json()) as BaseResponse<AiRuntimeHealthResponse>;

    if (body.code !== "success" || body.data?.status !== "ok") {
        throw new Error(body.message || "AI Runtime health check returned unhealthy");
    }

    return {
        status: "ok",
        version: body.data.version,
        backendBridge: body.data.backendBridge,
        attachments: body.data.attachments,
    };
}
