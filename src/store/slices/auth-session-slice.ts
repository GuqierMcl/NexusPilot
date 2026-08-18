import { create } from "zustand";

import {
    cancelAuthSignIn,
    getAuthSnapshot,
    retryAuthSession,
    signOutAuthSession,
    startAuthSignIn,
} from "@/features/account/auth-client";
import { listenToAuthSessionChanges } from "@/features/account/auth-events";
import { clearSyncSetupContextCache } from "@/lib/tauri/cloud";
import type {
    AuthErrorCode,
    AuthPublicError,
    AuthSessionSnapshot,
} from "@/types/ipc";

const AUTH_ERROR_CODES: readonly AuthErrorCode[] = [
    "AUTH_CONFIG_INVALID",
    "AUTH_SECURE_STORAGE_UNAVAILABLE",
    "AUTH_SECURE_STORAGE_ACCESS_DENIED",
    "AUTH_SECURE_STORAGE_CORRUPTED",
    "AUTH_SECURE_STORAGE_ITEM_TOO_LARGE",
    "AUTH_PERSISTENT_LOGOUT_NOT_GUARANTEED",
    "AUTH_PROVIDER_UNAVAILABLE",
    "AUTH_PROVIDER_UNSUPPORTED",
    "AUTH_BROWSER_OPEN_FAILED",
    "AUTH_SIGN_IN_CANCELED",
    "AUTH_SIGN_IN_EXPIRED",
    "AUTH_CALLBACK_INVALID",
    "AUTH_TOKEN_EXCHANGE_FAILED",
    "AUTH_TOKEN_VALIDATION_FAILED",
    "AUTH_REFRESH_REJECTED",
    "AUTH_PROVIDER_CHANGED",
    "AUTH_REAUTHENTICATION_REQUIRED",
    "AUTH_SYSTEM_INTERNAL",
];

const INITIAL_AUTH_SNAPSHOT: AuthSessionSnapshot = {
    phase: "restoring",
    operation: "idle",
    providerAvailability: "unknown",
    provider: null,
    user: null,
    hasUsableAccessToken: false,
    accessTokenExpiresAt: null,
    lastAuthenticatedAt: null,
    lastRefreshedAt: null,
    error: null,
};

const AUTH_IPC_UNAVAILABLE: AuthPublicError = {
    code: "AUTH_SYSTEM_INTERNAL",
    message: "账号功能暂时不可用，本地工作台仍可正常使用。",
    retryable: true,
    occurredAt: new Date(0).toISOString(),
};

export interface AuthSessionState {
    snapshot: AuthSessionSnapshot;
    initialized: boolean;
    setSnapshot: (snapshot: AuthSessionSnapshot) => void;
    startSignIn: () => Promise<void>;
    cancelSignIn: () => Promise<void>;
    retrySession: () => Promise<void>;
    signOut: () => Promise<void>;
}

type AuthAction = () => Promise<AuthSessionSnapshot>;

function isAuthErrorCode(value: unknown): value is AuthErrorCode {
    return (
        typeof value === "string" &&
        AUTH_ERROR_CODES.includes(value as AuthErrorCode)
    );
}

function safePublicError(error: unknown): AuthPublicError {
    if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        "message" in error &&
        "retryable" in error &&
        "occurredAt" in error &&
        isAuthErrorCode(error.code) &&
        typeof error.message === "string" &&
        typeof error.retryable === "boolean" &&
        typeof error.occurredAt === "string"
    ) {
        return error as AuthPublicError;
    }

    return {
        ...AUTH_IPC_UNAVAILABLE,
        occurredAt: new Date().toISOString(),
    };
}

async function runAction(actionName: string, action: AuthAction): Promise<void> {
    try {
        const snapshot = await action();
        useAuthSessionStore.getState().setSnapshot(snapshot);
    } catch (error) {
        const publicError = safePublicError(error);
        console.error(`[auth-session] ${actionName}: ${publicError.code}`);
        useAuthSessionStore.setState((state) => ({
            snapshot: {
                ...state.snapshot,
                operation: "idle",
                error: publicError,
            },
        }));
    }
}

export const useAuthSessionStore = create<AuthSessionState>((set) => ({
    snapshot: INITIAL_AUTH_SNAPSHOT,
    initialized: false,
    setSnapshot: (snapshot) =>
        set((state) => {
            if (authIdentity(state.snapshot) !== authIdentity(snapshot)) {
                clearSyncSetupContextCache();
            }
            return { snapshot, initialized: true };
        }),
    startSignIn: () => runAction("start sign in", startAuthSignIn),
    cancelSignIn: () => runAction("cancel sign in", cancelAuthSignIn),
    retrySession: () => runAction("retry session", retryAuthSession),
    signOut: () => runAction("sign out", signOutAuthSession),
}));

function authIdentity(snapshot: AuthSessionSnapshot): string | null {
    if (snapshot.phase !== "authenticated" || !snapshot.user) return null;
    return [snapshot.user.providerId, snapshot.user.issuer, snapshot.user.subject].join("\u0000");
}

let initialization: Promise<void> | null = null;
let eventRevision = 0;

/**
 * 先订阅事件再读取 Snapshot；若读取期间收到更新，则保留事件中的较新状态。
 * 初始化本身幂等，以兼容 React StrictMode 的开发期重复挂载。
 */
export function initializeAuthSession(): Promise<void> {
    if (initialization) {
        return initialization;
    }

    initialization = (async () => {
        try {
            await listenToAuthSessionChanges((snapshot) => {
                eventRevision += 1;
                useAuthSessionStore.getState().setSnapshot(snapshot);
            });
        } catch {
            console.error("[auth-session] event subscription unavailable");
        }

        const revisionBeforeRead = eventRevision;
        try {
            const snapshot = await getAuthSnapshot();
            if (eventRevision === revisionBeforeRead) {
                useAuthSessionStore.getState().setSnapshot(snapshot);
            }
        } catch (error) {
            const publicError = safePublicError(error);
            console.error(`[auth-session] initial snapshot: ${publicError.code}`);
            if (eventRevision === revisionBeforeRead) {
                useAuthSessionStore.setState({
                    snapshot: {
                        ...INITIAL_AUTH_SNAPSHOT,
                        phase: "anonymous",
                        providerAvailability: "temporarilyUnavailable",
                        error: publicError,
                    },
                    initialized: true,
                });
            }
        }
    })();

    return initialization;
}
