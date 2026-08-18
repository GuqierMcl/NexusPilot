export interface BaseResponse<T> {
    code: string;
    message: string;
    data: T | null;
}

export interface AiRuntimeHealthResponse {
    status: string;
    version: string;
    backendBridge?: {
        state: "waiting" | "ready" | "disconnected";
        lastHeartbeatAt?: number;
    };
}

export interface AiRuntimeHealthResult {
    status: "ok";
    version: string;
    backendBridge: AiRuntimeHealthResponse["backendBridge"];
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
    };
}
