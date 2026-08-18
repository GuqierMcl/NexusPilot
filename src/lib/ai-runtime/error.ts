const RUNTIME_UNAVAILABLE_MESSAGE =
    "AI Runtime 暂不可用，请检查智能体运行时是否已启动后重试。";

export function getAiRuntimeUserFacingErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message.trim() : "";
    if (isAiRuntimeTransportError(error)) {
        return RUNTIME_UNAVAILABLE_MESSAGE;
    }

    return message;
}

export function isAiRuntimeTransportError(error: unknown): boolean {
    const message = error instanceof Error ? error.message.trim() : "";
    const normalized = message.toLowerCase();
    return (
        normalized.length === 0 ||
        normalized.includes("failed to fetch") ||
        normalized.includes("fail to fetch") ||
        normalized.includes("load failed") ||
        normalized.includes("networkerror") ||
        normalized.includes("network request failed") ||
        normalized.includes("connection refused") ||
        normalized.includes("err_connection_refused") ||
        normalized.includes("econnrefused") ||
        normalized.includes("endpoint 尚未就绪") ||
        normalized.includes("health check failed") ||
        normalized.includes("health check returned unhealthy")
    );
}
