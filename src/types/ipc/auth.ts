export type AuthSessionPhase =
    | "restoring"
    | "anonymous"
    | "authenticated"
    | "reauthenticationRequired";

export type AuthOperation =
    | "idle"
    | "signingIn"
    | "refreshing"
    | "signingOut";

export type AuthProviderAvailability =
    | "unknown"
    | "available"
    | "temporarilyUnavailable";

export type AuthErrorCode =
    | "AUTH_CONFIG_INVALID"
    | "AUTH_SECURE_STORAGE_UNAVAILABLE"
    | "AUTH_SECURE_STORAGE_ACCESS_DENIED"
    | "AUTH_SECURE_STORAGE_CORRUPTED"
    | "AUTH_SECURE_STORAGE_ITEM_TOO_LARGE"
    | "AUTH_PERSISTENT_LOGOUT_NOT_GUARANTEED"
    | "AUTH_PROVIDER_UNAVAILABLE"
    | "AUTH_PROVIDER_UNSUPPORTED"
    | "AUTH_BROWSER_OPEN_FAILED"
    | "AUTH_SIGN_IN_CANCELED"
    | "AUTH_SIGN_IN_EXPIRED"
    | "AUTH_CALLBACK_INVALID"
    | "AUTH_TOKEN_EXCHANGE_FAILED"
    | "AUTH_TOKEN_VALIDATION_FAILED"
    | "AUTH_REFRESH_REJECTED"
    | "AUTH_PROVIDER_CHANGED"
    | "AUTH_REAUTHENTICATION_REQUIRED"
    | "AUTH_SYSTEM_INTERNAL";

export interface AuthPublicError {
    code: AuthErrorCode;
    message: string;
    retryable: boolean;
    occurredAt: string;
}

export interface AuthProviderSummary {
    id: string;
    displayName: string;
}

export interface AuthUser {
    providerId: string;
    issuer: string;
    subject: string;
    displayName: string | null;
    handle: string | null;
    email: string | null;
    emailVerified: boolean | null;
    /** 本地净化头像的内容版本；不包含 Provider picture URL。 */
    avatarRevision: string | null;
}

/**
 * WebView 可见的只读认证投影。Token、OIDC 临时参数和原始 Claims 不属于该契约。
 */
export interface AuthSessionSnapshot {
    phase: AuthSessionPhase;
    operation: AuthOperation;
    providerAvailability: AuthProviderAvailability;
    provider: AuthProviderSummary | null;
    user: AuthUser | null;
    hasUsableAccessToken: boolean;
    accessTokenExpiresAt: string | null;
    lastAuthenticatedAt: string | null;
    lastRefreshedAt: string | null;
    error: AuthPublicError | null;
}
