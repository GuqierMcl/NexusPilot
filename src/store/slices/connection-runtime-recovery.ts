import type { RuntimeFailureEvent } from "@/lib/connection-runtime-events";
import { normalizeIpcError } from "@/lib/ipc-error";
import type { RuntimeSessionEvent } from "@/types/connection-runtime";
import type { PingResult } from "@/types/ipc";

export const DEFAULT_RUNTIME_RECONNECT_DELAYS_MS = [0, 500, 1500] as const;

export interface RuntimeRecoveryOptions {
    profileId: string;
    maxAttempts: number;
    delaysMs: readonly number[];
    probe: () => Promise<PingResult>;
    sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
    dispatch: (event: RuntimeSessionEvent) => void;
    isCurrent: () => boolean;
    now: () => number;
    signal?: AbortSignal;
}

export type StartRuntimeRecoveryOptions = Omit<
    RuntimeRecoveryOptions,
    "isCurrent" | "signal"
>;

interface ActiveRecovery {
    controller: AbortController;
    promise: Promise<void>;
}

const activeRecoveries = new Map<string, ActiveRecovery>();

function canContinue(options: RuntimeRecoveryOptions): boolean {
    return !options.signal?.aborted && options.isCurrent();
}

export function shouldStartRuntimeRecovery(
    failure: RuntimeFailureEvent,
): boolean {
    return failure.runtimeImpact === "retryable";
}

export async function recoverRuntimeSession(
    options: RuntimeRecoveryOptions,
): Promise<void> {
    const attemptCount = Math.min(
        options.maxAttempts,
        options.delaysMs.length,
    );

    for (let index = 0; index < attemptCount; index += 1) {
        const attempt = index + 1;
        await options.sleep(options.delaysMs[index] ?? 0, options.signal);
        if (!canContinue(options)) {
            return;
        }

        options.dispatch({
            type: "reconnectStarted",
            attempt,
            maxAttempts: options.maxAttempts,
        });

        try {
            const result = await options.probe();
            if (!canContinue(options)) {
                return;
            }
            options.dispatch({
                type: "probeSucceeded",
                ping: result.latencyMs,
            });
            return;
        } catch (raw) {
            if (!canContinue(options)) {
                return;
            }
            const error = normalizeIpcError(raw);
            if (error.runtimeImpact === "terminal") {
                options.dispatch({
                    type: "terminalFailure",
                    message: error.message,
                });
                return;
            }
            options.dispatch({
                type: "probeFailed",
                attempt,
                maxAttempts: options.maxAttempts,
                message: error.message,
                occurredAt: options.now(),
            });
        }
    }
}

export function startRuntimeRecovery(
    options: StartRuntimeRecoveryOptions,
): Promise<void> {
    const existing = activeRecoveries.get(options.profileId);
    if (existing) {
        return existing.promise;
    }

    const controller = new AbortController();
    const active: ActiveRecovery = {
        controller,
        promise: Promise.resolve(),
    };
    activeRecoveries.set(options.profileId, active);

    active.promise = recoverRuntimeSession({
        ...options,
        signal: controller.signal,
        isCurrent: () => activeRecoveries.get(options.profileId) === active,
    }).finally(() => {
        if (activeRecoveries.get(options.profileId) === active) {
            activeRecoveries.delete(options.profileId);
        }
    });

    return active.promise;
}

export function cancelRuntimeRecovery(profileId: string): void {
    const active = activeRecoveries.get(profileId);
    if (!active) {
        return;
    }
    activeRecoveries.delete(profileId);
    active.controller.abort();
}

export function sleepWithAbort(
    delayMs: number,
    signal?: AbortSignal,
): Promise<void> {
    if (signal?.aborted) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const timer = globalThis.setTimeout(resolve, delayMs);
        signal?.addEventListener(
            "abort",
            () => {
                globalThis.clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });
}
