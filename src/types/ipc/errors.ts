// 必须与 `src-tauri/src/error.rs` 中的 ErrorCode 枚举保持同步。

/** 连接引擎 IPC 命令返回的结构化错误码。 */
export type ErrorCode =
    | "AUTH_FAILED"
    | "NETWORK_TIMEOUT"
    | "OPERATION_TIMEOUT"
    | "OPERATION_OUTCOME_UNKNOWN"
    | "QUERY_SYNTAX_ERROR"
    | "RESOURCE_NOT_FOUND"
    | "VALIDATION_FAILED"
    | "RESOURCE_CONFLICT"
    | "FEATURE_UNAVAILABLE"
    | "PERMISSION_DENIED"
    | "SYSTEM_INTERNAL"
    | "OPERATION_CANCELED";

/** 当前请求错误对所属数据库运行时会话健康度的影响。 */
export type RuntimeErrorImpact =
    | "businessOnly"
    | "retryable"
    | "terminal";

/** Rust 引擎命令序列化的 IPC 错误对象。 */
export interface IAppError {
    code: ErrorCode;
    /** 由后端明确给出；前端不得仅凭错误码推断会话健康。 */
    runtimeImpact: RuntimeErrorImpact;
    /** 适合在界面展示的人类可读错误信息。 */
    message: string;
    /** Rust 端底层原始错误字符串，仅 DEV 构建下有。 */
    details?: string;
}
