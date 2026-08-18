import type {
    ErrorCode,
    IAppError,
    RuntimeErrorImpact,
} from "@/types/ipc";

const ERROR_CODES = new Set<ErrorCode>([
    "AUTH_FAILED",
    "NETWORK_TIMEOUT",
    "OPERATION_TIMEOUT",
    "OPERATION_OUTCOME_UNKNOWN",
    "QUERY_SYNTAX_ERROR",
    "RESOURCE_NOT_FOUND",
    "VALIDATION_FAILED",
    "RESOURCE_CONFLICT",
    "SYSTEM_INTERNAL",
    "OPERATION_CANCELED",
]);

function isErrorCode(value: unknown): value is ErrorCode {
    return typeof value === "string" && ERROR_CODES.has(value as ErrorCode);
}

function isRuntimeErrorImpact(value: unknown): value is RuntimeErrorImpact {
    return (
        value === "businessOnly" ||
        value === "retryable" ||
        value === "terminal"
    );
}

function unknownToDetails(value: unknown): string {
    if (value instanceof Error) {
        return value.stack ?? value.message;
    }

    if (typeof value === "string") {
        return value;
    }

    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

export function isIAppError(value: unknown): value is IAppError {
    return (
        typeof value === "object" &&
        value !== null &&
        "code" in value &&
        "message" in value &&
        isErrorCode((value as IAppError).code) &&
        "runtimeImpact" in value &&
        isRuntimeErrorImpact((value as IAppError).runtimeImpact) &&
        typeof (value as IAppError).message === "string" &&
        (!("details" in value) ||
            (value as IAppError).details == null ||
            typeof (value as IAppError).details === "string")
    );
}

export function normalizeIpcError(raw: unknown): IAppError {
    if (isIAppError(raw)) {
        return raw;
    }

    if (
        typeof raw === "object" &&
        raw !== null &&
        "code" in raw &&
        "message" in raw &&
        isErrorCode((raw as { code: unknown }).code) &&
        typeof (raw as { message: unknown }).message === "string"
    ) {
        const details =
            "details" in raw &&
            ((raw as { details?: unknown }).details == null ||
                typeof (raw as { details?: unknown }).details === "string")
                ? (raw as { details?: string }).details
                : undefined;
        return {
            code: (raw as { code: ErrorCode }).code,
            message: (raw as { message: string }).message,
            details,
            runtimeImpact: "businessOnly",
        };
    }

    return {
        code: "SYSTEM_INTERNAL",
        message: "发生了意外错误，请重试。",
        details: unknownToDetails(raw),
        runtimeImpact: "businessOnly",
    };
}

export function formatIpcError(error: unknown): string {
    const appError = normalizeIpcError(error);

    switch (appError.code) {
        case "AUTH_FAILED":
            return `认证失败：${appError.message}`;
        case "NETWORK_TIMEOUT":
            return `网络超时：${appError.message}`;
        case "OPERATION_TIMEOUT":
            return `操作超时：${appError.message}`;
        case "OPERATION_OUTCOME_UNKNOWN":
            return `操作结果待确认：${appError.message}`;
        case "QUERY_SYNTAX_ERROR":
            return `SQL 语法错误：${appError.message}`;
        case "RESOURCE_NOT_FOUND":
            return `资源未找到：${appError.message}`;
        case "VALIDATION_FAILED":
            return `参数无效：${appError.message}`;
        case "RESOURCE_CONFLICT":
            return `资源冲突：${appError.message}`;
        case "FEATURE_UNAVAILABLE":
            return `功能不可用：${appError.message}`;
        case "PERMISSION_DENIED":
            return `权限不足：${appError.message}`;
        case "OPERATION_CANCELED":
            return "操作已取消";
        case "SYSTEM_INTERNAL":
            return `内部错误：${appError.message}`;
    }
}

export function getIpcErrorToastMessage(error: IAppError): string {
    return formatIpcError(error);
}

export function shouldRetryIpcError(
    failureCount: number,
    error: unknown,
): boolean {
    const appError = normalizeIpcError(error);

    if (appError.runtimeImpact !== "retryable") {
        return false;
    }

    return failureCount < 3;
}
