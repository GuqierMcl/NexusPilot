import { describe, expect, test } from "bun:test";

import {
    cancelRuntimeRecovery,
    recoverRuntimeSession,
    shouldStartRuntimeRecovery,
    startRuntimeRecovery,
} from "../../src/store/slices/connection-runtime-recovery";
import { reduceRuntimeSession } from "../../src/store/slices/connection-runtime-state";
import type { RuntimeFailureEvent } from "../../src/lib/connection-runtime-events";
import type {
    ISessionState,
    RuntimeSessionEvent,
} from "../../src/types/connection-runtime";
import type { PingResult } from "../../src/types/ipc";

const RETRYABLE_ERROR = {
    code: "NETWORK_TIMEOUT" as const,
    message: "transport unavailable",
    runtimeImpact: "retryable" as const,
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe("runtime recovery loop", () => {
    test("retries with bounded delays and stops after the first success", async () => {
        const delays: number[] = [];
        const events: RuntimeSessionEvent[] = [];
        let attempts = 0;

        await recoverRuntimeSession({
            profileId: "profile-recover",
            maxAttempts: 3,
            delaysMs: [0, 500, 1500],
            probe: async () => {
                attempts += 1;
                if (attempts === 1) {
                    throw RETRYABLE_ERROR;
                }
                return { latencyMs: 12 };
            },
            sleep: async (delayMs) => {
                delays.push(delayMs);
            },
            dispatch: (event) => events.push(event),
            isCurrent: () => true,
            now: () => 100 + attempts,
        });

        expect(attempts).toBe(2);
        expect(delays).toEqual([0, 500]);
        expect(events.map((event) => event.type)).toEqual([
            "reconnectStarted",
            "probeFailed",
            "reconnectStarted",
            "probeSucceeded",
        ]);
        expect(events.at(-1)).toEqual({
            type: "probeSucceeded",
            ping: 12,
        });
    });

    test("ends the reducer session in error after three failed probes", async () => {
        let state: ISessionState = {
            status: "degraded",
            errorMsg: "transport unavailable",
            recovery: { attempt: 0, maxAttempts: 3 },
        };

        await recoverRuntimeSession({
            profileId: "profile-exhausted",
            maxAttempts: 3,
            delaysMs: [0, 500, 1500],
            probe: async () => {
                throw RETRYABLE_ERROR;
            },
            sleep: async () => undefined,
            dispatch: (event) => {
                state = reduceRuntimeSession(state, event);
            },
            isCurrent: () => true,
            now: () => 200,
        });

        expect(state.status).toBe("error");
        expect(state.recovery?.attempt).toBe(3);
        expect(state.errorMsg).toBe("transport unavailable");
    });

    test("does not start recovery for a terminal failure event", () => {
        const terminal: RuntimeFailureEvent = {
            profileId: "profile-auth",
            code: "AUTH_FAILED",
            runtimeImpact: "terminal",
            message: "credentials rejected",
            command: "test_connection",
            occurredAt: 1,
        };

        expect(shouldStartRuntimeRecovery(terminal)).toBe(false);
        expect(
            shouldStartRuntimeRecovery({
                ...terminal,
                code: "NETWORK_TIMEOUT",
                runtimeImpact: "retryable",
            }),
        ).toBe(true);
    });

    test("deduplicates concurrent recovery for the same profile", async () => {
        const pending = deferred<PingResult>();
        let probes = 0;
        const options = {
            profileId: "profile-deduplicated",
            maxAttempts: 3,
            delaysMs: [0, 500, 1500] as const,
            probe: () => {
                probes += 1;
                return pending.promise;
            },
            sleep: async () => undefined,
            dispatch: () => undefined,
            now: () => 1,
        };

        const first = startRuntimeRecovery(options);
        const second = startRuntimeRecovery(options);

        expect(second).toBe(first);
        await Promise.resolve();
        expect(probes).toBe(1);

        pending.resolve({ latencyMs: 4 });
        await first;
    });

    test("cancellation prevents a late probe from publishing success", async () => {
        const pending = deferred<PingResult>();
        const events: RuntimeSessionEvent[] = [];
        const recovery = startRuntimeRecovery({
            profileId: "profile-canceled",
            maxAttempts: 3,
            delaysMs: [0, 500, 1500],
            probe: () => pending.promise,
            sleep: async () => undefined,
            dispatch: (event) => events.push(event),
            now: () => 1,
        });

        await Promise.resolve();
        cancelRuntimeRecovery("profile-canceled");
        pending.resolve({ latencyMs: 2 });
        await recovery;

        expect(events.some((event) => event.type === "probeSucceeded")).toBe(
            false,
        );
    });
});
