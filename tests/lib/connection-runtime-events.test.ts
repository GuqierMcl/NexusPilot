import { describe, expect, test } from "bun:test";

import {
    publishRuntimeFailure,
    subscribeRuntimeFailure,
    toRuntimeFailureEvent,
} from "../../src/lib/connection-runtime-events";

describe("connection runtime failure events", () => {
    test("builds a safe event for an explicit retryable runtime failure", () => {
        const event = toRuntimeFailureEvent(
            "list_containers",
            { profileId: "profile-1", password: "must-not-leak" },
            {
                code: "NETWORK_TIMEOUT",
                message: "transport unavailable",
                details: "https://default:secret@example.test",
                runtimeImpact: "retryable",
            },
            42,
        );

        expect(event).toEqual({
            profileId: "profile-1",
            code: "NETWORK_TIMEOUT",
            runtimeImpact: "retryable",
            message: "transport unavailable",
            command: "list_containers",
            occurredAt: 42,
        });
        expect(JSON.stringify(event)).not.toContain("must-not-leak");
        expect(JSON.stringify(event)).not.toContain("secret");
    });

    test("does not infer runtime health from a business-only error code", () => {
        expect(
            toRuntimeFailureEvent(
                "execute_sql",
                { profileId: "profile-1" },
                {
                    code: "NETWORK_TIMEOUT",
                    message: "individual query timed out",
                    runtimeImpact: "businessOnly",
                },
                10,
            ),
        ).toBeNull();
    });

    test("ignores errors without a profile runtime boundary", () => {
        expect(
            toRuntimeFailureEvent(
                "test_connection_config",
                { driver: "clickhouse" },
                {
                    code: "AUTH_FAILED",
                    message: "credentials rejected",
                    runtimeImpact: "terminal",
                },
                10,
            ),
        ).toBeNull();
    });

    test("publishes to current subscribers and supports unsubscribe", () => {
        const received: string[] = [];
        const event = {
            profileId: "profile-1",
            code: "AUTH_FAILED" as const,
            runtimeImpact: "terminal" as const,
            message: "credentials rejected",
            command: "test_connection",
            occurredAt: 50,
        };
        const unsubscribe = subscribeRuntimeFailure((failure) => {
            received.push(`${failure.profileId}:${failure.runtimeImpact}`);
        });

        publishRuntimeFailure(event);
        unsubscribe();
        publishRuntimeFailure(event);

        expect(received).toEqual(["profile-1:terminal"]);
    });
});
