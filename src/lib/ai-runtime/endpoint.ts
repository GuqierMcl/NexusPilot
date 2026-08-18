import { invoke } from "@tauri-apps/api/core";

export type AiRuntimeMode = "development" | "production";

export interface AiRuntimeEndpoint {
    baseUrl: string;
    host: string;
    port: number;
    mode: AiRuntimeMode;
    accessToken: string | null;
}

export function appendAiRuntimeAuthorization(
    headers: HeadersInit | undefined,
    accessToken: string | null,
): Headers {
    const result = new Headers(headers);
    if (accessToken) {
        result.set("Authorization", `Bearer ${accessToken}`);
    }
    return result;
}

export async function getAiRuntimeEndpoint(): Promise<AiRuntimeEndpoint> {
    return await invoke<AiRuntimeEndpoint>("get_ai_runtime_endpoint");
}
