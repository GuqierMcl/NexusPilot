import { describe, expect, test } from "bun:test";

import {
    canLoadRemoteMetadata,
    canStartRuntime,
    decideConnectionMetadataAction,
    isRuntimeMaterialized,
    reduceRuntimeSession,
} from "../../src/store/slices/connection-runtime-state";
import type { ISessionState } from "../../src/types/connection-runtime";
import type { ConnectionRuntimeInfo, DriverCapabilities } from "../../src/types/ipc";

const NO_CAPABILITIES: DriverCapabilities = {
    schemaBrowser: false,
    schemaMutator: false,
    dataTableBrowser: false,
    tableRowMutator: false,
    tableRowInserter: false,
    transactionManager: false,
    sqlExecutor: false,
    keyValueBrowser: false,
    graphQueryer: false,
    vectorSearcher: false,
};

const RUNTIME: ConnectionRuntimeInfo = {
    profileId: "profile-1",
    driverName: "clickhouse",
    capabilities: NO_CAPABILITIES,
};

function session(
    status: ISessionState["status"],
    overrides: Partial<ISessionState> = {},
): ISessionState {
    return { status, ...overrides };
}

describe("database runtime session reducer", () => {
    test("moves through connect and healthy runtime transitions", () => {
        const connecting = reduceRuntimeSession(session("idle"), {
            type: "connectRequested",
        });
        expect(connecting.status).toBe("connecting");

        const connected = reduceRuntimeSession(connecting, {
            type: "connectSucceeded",
            runtime: RUNTIME,
            ping: 9,
        });
        expect(connected).toEqual({
            status: "connected",
            ping: 9,
            capabilities: NO_CAPABILITIES,
        });
    });

    test("moves a retryable failure through bounded recovery", () => {
        const degraded = reduceRuntimeSession(
            session("connected", {
                activeDatabase: "analytics",
                capabilities: NO_CAPABILITIES,
            }),
            {
                type: "retryableFailure",
                message: "transport unavailable",
                occurredAt: 10,
            },
        );
        expect(degraded).toEqual({
            status: "degraded",
            activeDatabase: "analytics",
            capabilities: NO_CAPABILITIES,
            errorMsg: "transport unavailable",
            recovery: {
                attempt: 0,
                maxAttempts: 3,
                lastFailureAt: 10,
            },
        });

        const reconnecting = reduceRuntimeSession(degraded, {
            type: "reconnectStarted",
            attempt: 1,
            maxAttempts: 3,
        });
        expect(reconnecting.status).toBe("reconnecting");
        expect(reconnecting.recovery?.attempt).toBe(1);

        const recovered = reduceRuntimeSession(reconnecting, {
            type: "probeSucceeded",
            ping: 12,
        });
        expect(recovered).toEqual({
            status: "connected",
            activeDatabase: "analytics",
            capabilities: NO_CAPABILITIES,
            ping: 12,
        });
    });

    test("enters error after the final failed probe", () => {
        const result = reduceRuntimeSession(
            session("reconnecting", {
                capabilities: NO_CAPABILITIES,
                recovery: { attempt: 2, maxAttempts: 3 },
            }),
            {
                type: "probeFailed",
                attempt: 3,
                maxAttempts: 3,
                message: "still unavailable",
                occurredAt: 30,
            },
        );

        expect(result.status).toBe("error");
        expect(result.errorMsg).toBe("still unavailable");
        expect(result.recovery).toEqual({
            attempt: 3,
            maxAttempts: 3,
            lastFailureAt: 30,
        });
    });

    test("keeps non-final probe failures in reconnecting", () => {
        const result = reduceRuntimeSession(
            session("reconnecting", {
                recovery: { attempt: 1, maxAttempts: 3 },
            }),
            {
                type: "probeFailed",
                attempt: 1,
                maxAttempts: 3,
                message: "first probe failed",
                occurredAt: 11,
            },
        );

        expect(result.status).toBe("reconnecting");
        expect(result.recovery).toEqual({
            attempt: 1,
            maxAttempts: 3,
            lastFailureAt: 11,
        });
    });

    test("moves terminal runtime failures directly to error", () => {
        const result = reduceRuntimeSession(
            session("connected", { capabilities: NO_CAPABILITIES }),
            {
                type: "terminalFailure",
                message: "credentials rejected",
            },
        );

        expect(result).toEqual({
            status: "error",
            capabilities: NO_CAPABILITIES,
            errorMsg: "credentials rejected",
        });
    });

    test("ignores retryable failures before a runtime is materialized", () => {
        const connecting = session("connecting");
        const result = reduceRuntimeSession(connecting, {
            type: "retryableFailure",
            message: "connect request failed",
            occurredAt: 10,
        });

        expect(result).toBe(connecting);
    });

    test("does not let a late probe resurrect a disconnecting session", () => {
        const disconnecting = reduceRuntimeSession(session("connected"), {
            type: "disconnectRequested",
        });
        expect(disconnecting.status).toBe("disconnecting");

        const staleSuccess = reduceRuntimeSession(disconnecting, {
            type: "probeSucceeded",
            ping: 4,
        });
        expect(staleSuccess).toBe(disconnecting);

        expect(
            reduceRuntimeSession(disconnecting, {
                type: "disconnectFinished",
            }),
        ).toEqual({ status: "idle" });
    });

    test("updates active database without discarding runtime facts", () => {
        const connected = session("connected", {
            ping: 7,
            capabilities: NO_CAPABILITIES,
        });

        expect(
            reduceRuntimeSession(connected, {
                type: "activeDatabaseChanged",
                database: "events",
            }),
        ).toEqual({
            ...connected,
            activeDatabase: "events",
        });
    });
});

describe("database runtime session policy selectors", () => {
    test("starts a runtime only from idle or error", () => {
        expect(canStartRuntime("idle")).toBe(true);
        expect(canStartRuntime("error")).toBe(true);

        for (const status of [
            "connecting",
            "connected",
            "degraded",
            "reconnecting",
            "disconnecting",
        ] as const) {
            expect(canStartRuntime(status)).toBe(false);
        }
    });

    test("recognizes materialized runtime states", () => {
        expect(isRuntimeMaterialized("connected")).toBe(true);
        expect(isRuntimeMaterialized("degraded")).toBe(true);
        expect(isRuntimeMaterialized("reconnecting")).toBe(true);
        expect(isRuntimeMaterialized("idle")).toBe(false);
        expect(isRuntimeMaterialized("connecting")).toBe(false);
        expect(isRuntimeMaterialized("error")).toBe(false);
        expect(isRuntimeMaterialized("disconnecting")).toBe(false);
    });

    test("loads metadata only for connected schema-browser runtimes", () => {
        const schemaBrowser = {
            ...NO_CAPABILITIES,
            schemaBrowser: true,
        };

        expect(
            canLoadRemoteMetadata(
                session("connected", { capabilities: schemaBrowser }),
            ),
        ).toBe(true);
        expect(
            canLoadRemoteMetadata(
                session("connected", { capabilities: NO_CAPABILITIES }),
            ),
        ).toBe(false);
        expect(
            canLoadRemoteMetadata(
                session("degraded", { capabilities: schemaBrowser }),
            ),
        ).toBe(false);
    });

    test("decides how Explorer should handle connection metadata", () => {
        expect(decideConnectionMetadataAction(undefined)).toBe("connect");
        expect(decideConnectionMetadataAction(session("idle"))).toBe("connect");
        expect(decideConnectionMetadataAction(session("error"))).toBe("connect");

        expect(
            decideConnectionMetadataAction(
                session("connected", {
                    capabilities: {
                        ...NO_CAPABILITIES,
                        schemaBrowser: true,
                    },
                }),
            ),
        ).toBe("load");
        expect(
            decideConnectionMetadataAction(
                session("connected", { capabilities: NO_CAPABILITIES }),
            ),
        ).toBe("unsupported");

        for (const status of [
            "connecting",
            "degraded",
            "reconnecting",
            "disconnecting",
        ] as const) {
            expect(decideConnectionMetadataAction(session(status))).toBe("wait");
        }
    });
});
