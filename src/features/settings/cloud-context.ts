import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
    getCloudDesktopState,
    listenToCloudDesktopStateChanges,
    refreshCloudDesktopState,
} from "@/lib/tauri/cloud";
import { useAuthSessionStore } from "@/store";
import type {
    CloudDesktopStateProjection,
    CloudPublicError,
    CloudSyncSetupContext,
    CloudSyncRuntimeProjection,
} from "@/types/ipc";

const REFRESH_INDICATOR_TIMEOUT_MS = 5_000;
const AUTOMATIC_REFRESH_DEDUP_MS = 10_000;

let desktopStateSnapshot: CloudDesktopStateProjection | null = null;
const desktopStateSubscribers = new Set<() => void>();
let desktopStateBridgeStarted = false;
let desktopStateHydrationRequest: Promise<void> | null = null;

function publishDesktopState(state: CloudDesktopStateProjection): void {
    desktopStateSnapshot = state;
    desktopStateSubscribers.forEach((subscriber) => subscriber());
}

function subscribeDesktopState(subscriber: () => void): () => void {
    desktopStateSubscribers.add(subscriber);
    return () => desktopStateSubscribers.delete(subscriber);
}

function readDesktopState(): CloudDesktopStateProjection | null {
    return desktopStateSnapshot;
}

/**
 * The Cloud bridge is process-wide.  Individual panels subscribe to the same
 * external snapshot instead of creating one Tauri listener and one initial
 * invoke per mounted component.
 */
function ensureDesktopStateBridge(): void {
    if (!desktopStateBridgeStarted) {
        desktopStateBridgeStarted = true;
        void listenToCloudDesktopStateChanges((nextState) => {
            publishDesktopState(nextState);
        }).catch((error: unknown) => {
            console.error("[cloud] failed to subscribe to desktop state", error);
            desktopStateBridgeStarted = false;
        });
    }

    if (!desktopStateSnapshot && !desktopStateHydrationRequest) {
        desktopStateHydrationRequest = getCloudDesktopState()
            .then((nextState) => publishDesktopState(nextState))
            .catch((error: unknown) => {
                console.error("[cloud] failed to load desktop state", error);
            })
            .finally(() => {
                desktopStateHydrationRequest = null;
            });
    }
}

export function useCloudDesktopState(): {
    state: CloudDesktopStateProjection | null;
    refresh: (force?: boolean) => Promise<CloudDesktopStateProjection>;
} {
    const state = useSyncExternalStore(
        subscribeDesktopState,
        readDesktopState,
        readDesktopState,
    );

    useEffect(() => {
        ensureDesktopStateBridge();
    }, []);

    const refresh = useCallback(async (force = true) => {
        const current = desktopStateSnapshot;
        if (
            !force &&
            current?.context &&
            current.refresh.lastCompletedAt &&
            Date.now() - new Date(current.refresh.lastCompletedAt).getTime() <
                AUTOMATIC_REFRESH_DEDUP_MS
        ) {
            return current;
        }
        const nextState = await refreshCloudDesktopState();
        publishDesktopState(nextState);
        return nextState;
    }, []);

    return { state, refresh };
}

export interface CloudSetupContextState {
    authenticated: boolean;
    context: CloudSyncSetupContext | null;
    loading: boolean;
    refreshTimedOut: boolean;
    refreshing: boolean;
    error: CloudPublicError | null;
    runtime: CloudSyncRuntimeProjection | null;
    refresh: () => Promise<void>;
}

export function useCloudSetupContext(): CloudSetupContextState {
    const snapshot = useAuthSessionStore((state) => state.snapshot);
    const authenticated = snapshot.phase === "authenticated" && Boolean(snapshot.user);
    const cloudAccountIdentity =
        authenticated && snapshot.user
            ? [snapshot.user.providerId, snapshot.user.issuer, snapshot.user.subject].join("\u0000")
            : null;
    const { state: desktopState, refresh: refreshDesktopState } = useCloudDesktopState();
    const context = desktopState?.context ?? null;
    const [loading, setLoading] = useState(false);
    const [refreshTimedOut, setRefreshTimedOut] = useState(false);
    const [error, setError] = useState<CloudPublicError | null>(null);
    const loadGeneration = useRef(0);

    const load = useCallback(async (force: boolean): Promise<void> => {
        if (!cloudAccountIdentity) {
            loadGeneration.current += 1;
            setLoading(false);
            setRefreshTimedOut(false);
            setError(null);
            return;
        }
        const generation = ++loadGeneration.current;
        setLoading(true);
        setRefreshTimedOut(false);
        setError(null);
        const timeout = window.setTimeout(() => {
            if (generation === loadGeneration.current) {
                setLoading(false);
                setRefreshTimedOut(true);
            }
        }, REFRESH_INDICATOR_TIMEOUT_MS);
        try {
            await refreshDesktopState(force);
            if (generation === loadGeneration.current) {
                setError(null);
                setRefreshTimedOut(false);
            }
        } catch (contextError: unknown) {
            console.error("[cloud] failed to load setup context", contextError);
            if (generation === loadGeneration.current) {
                setRefreshTimedOut(false);
                setError(toCloudError(contextError));
            }
        } finally {
            window.clearTimeout(timeout);
            if (generation === loadGeneration.current) {
                setLoading(false);
            }
        }
    }, [cloudAccountIdentity, refreshDesktopState]);

    const refresh = useCallback((): Promise<void> => load(true), [load]);

    useEffect(() => {
        void load(false);
    }, [cloudAccountIdentity, load]);

    useEffect(() => {
        if (desktopState?.refresh.lastSucceededAt && !desktopState.refresh.inFlight) {
            // A sibling Cloud surface can complete the shared refresh. Clear a
            // local error left by an older request when that happens.
            setError(null);
            setRefreshTimedOut(false);
        }
    }, [desktopState?.refresh.lastSucceededAt, desktopState?.refresh.inFlight]);

    return {
        authenticated,
        context,
        loading,
        refreshTimedOut,
        refreshing: desktopState?.refresh.inFlight ?? false,
        error: error ?? desktopState?.refresh.lastError ?? null,
        runtime: desktopState?.runtime ?? null,
        refresh,
    };
}

export function toCloudError(error: unknown): CloudPublicError {
    if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        "message" in error &&
        typeof error.code === "string" &&
        typeof error.message === "string"
    ) {
        return error as CloudPublicError;
    }
    return {
        code: "CLOUD_TEMPORARILY_UNAVAILABLE",
        message: "NexusPilot Cloud 暂时不可用，请稍后重试。",
        retryable: true,
        occurredAt: new Date().toISOString(),
    };
}
