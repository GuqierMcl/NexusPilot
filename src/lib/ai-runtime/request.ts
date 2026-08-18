import { toast } from "@/components/ui/toast";

import { useAiRuntimeEndpointStore } from "@/store/slices/ai-runtime-endpoint-slice";
import { appendAiRuntimeAuthorization } from "./endpoint";
import {
    getAiRuntimeUserFacingErrorMessage,
    isAiRuntimeTransportError,
} from "./error";

export interface AiRuntimeRequestOptions extends Omit<RequestInit, "body"> {
    json?: unknown;
    silent?: boolean;
}

export class AiRuntimeRequestError extends Error {
    status: number | null;
    details: unknown;

    constructor(message: string, status: number | null = null, details?: unknown) {
        super(message);
        this.name = "AiRuntimeRequestError";
        this.status = status;
        this.details = details;
    }
}

function buildUrl(baseUrl: string, path: string): string {
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `${normalizedBaseUrl}${normalizedPath}`;
}

function getErrorMessage(error: unknown): string {
    return getAiRuntimeUserFacingErrorMessage(error) || "AI Runtime 请求失败";
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}

function getApiErrorMessage(payload: unknown): string | null {
    if (typeof payload !== "object" || payload === null) {
        return null;
    }

    if ("message" in payload && typeof payload.message === "string") {
        return payload.message;
    }

    if ("detail" in payload) {
        if (typeof payload.detail === "string") {
            return payload.detail;
        }

        return JSON.stringify(payload.detail);
    }

    return null;
}

async function readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) {
        return null;
    }

    try {
        return JSON.parse(text);
    } catch (error) {
        throw new AiRuntimeRequestError(
            "AI Runtime 返回了无法解析的数据",
            response.status,
            error,
        );
    }
}

export async function aiRuntimeRequest<T>(
    path: string,
    options: AiRuntimeRequestOptions = {},
): Promise<T> {
    const endpoint = useAiRuntimeEndpointStore.getState().endpoint;
    const { json, silent = false, headers, ...requestInit } = options;

    try {
        if (!endpoint) {
            throw new AiRuntimeRequestError("AI Runtime endpoint 尚未就绪");
        }

        const requestHeaders = new Headers(headers);
        requestHeaders.set("Accept", "application/json");
        if (json !== undefined) {
            requestHeaders.set("Content-Type", "application/json");
        }

        const response = await fetch(buildUrl(endpoint.baseUrl, path), {
            ...requestInit,
            headers: appendAiRuntimeAuthorization(requestHeaders, endpoint.accessToken),
            body: json !== undefined ? JSON.stringify(json) : undefined,
        });
        const payload = await readJson(response);

        if (!response.ok) {
            throw new AiRuntimeRequestError(
                getApiErrorMessage(payload) ?? `AI Runtime 请求失败：HTTP ${response.status}`,
                response.status,
                payload,
            );
        }

        if (
            typeof payload === "object" &&
            payload !== null &&
            "code" in payload &&
            payload.code !== "success"
        ) {
            throw new AiRuntimeRequestError(
                getApiErrorMessage(payload) ?? "AI Runtime 返回业务错误",
                response.status,
                payload,
            );
        }

        return payload as T;
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }

        if (import.meta.env.DEV) {
            console.error("[aiRuntimeRequest] 请求失败", {
                path,
                error,
            });
        }

        const message = getErrorMessage(error);
        if (!silent) {
            toast.error(message);
        }

        if (isAiRuntimeTransportError(error)) {
            throw new AiRuntimeRequestError(message, null, error);
        }

        throw error;
    }
}
