import { afterEach, describe, expect, test } from "bun:test";

import { useConnectionSessionStore } from "../../src/store/slices/connection-session-slice";
import type {
    ConnectionRuntimeSnapshot,
    DriverCapabilities,
} from "../../src/types/ipc";

const capabilities: DriverCapabilities = {
    schemaBrowser: true,
    schemaMutator: false,
    dataTableBrowser: true,
    tableRowMutator: false,
    tableRowInserter: false,
    transactionManager: false,
    sqlExecutor: true,
    keyValueBrowser: false,
    graphQueryer: false,
    vectorSearcher: false,
};

function snapshot(
    profileId: string,
    status: ConnectionRuntimeSnapshot["health"]["status"] = "healthy",
): ConnectionRuntimeSnapshot {
    return {
        profileId,
        runtime: {
            profileId,
            driverName: "mysql",
            capabilities,
        },
        health: {
            profileId,
            status,
            consecutiveFailures: status === "healthy" ? 0 : 1,
        },
    };
}

afterEach(() => {
    useConnectionSessionStore.setState({ sessions: {} });
});

describe("Workbench runtime projection", () => {
    test("projects upsert and removed events without a second connection state machine", () => {
        const store = useConnectionSessionStore.getState();
        store.applyRuntimeChanged({
            kind: "upsert",
            origin: "aiRuntime",
            snapshot: snapshot("profile-1"),
        });

        expect(useConnectionSessionStore.getState().sessions["profile-1"]).toEqual({
            status: "connected",
            capabilities,
        });

        useConnectionSessionStore.getState().applyRuntimeChanged({
            kind: "removed",
            origin: "aiRuntime",
            profileId: "profile-1",
        });
        expect(useConnectionSessionStore.getState().sessions["profile-1"]).toBeUndefined();
    });

    test("reconciles materialized sessions from the authoritative snapshot", () => {
        useConnectionSessionStore.setState({
            sessions: {
                stale: { status: "connected", capabilities },
                localError: { status: "error", errorMsg: "local failure" },
            },
        });

        const removed = useConnectionSessionStore
            .getState()
            .reconcileRuntimeSnapshots([
                snapshot("profile-2", "degraded"),
                snapshot("profile-1"),
            ]);

        expect(removed).toEqual(["stale"]);
        expect(Object.keys(useConnectionSessionStore.getState().sessions)).toEqual([
            "localError",
            "profile-2",
            "profile-1",
        ]);
        expect(useConnectionSessionStore.getState().sessions["profile-2"]).toEqual({
            status: "degraded",
            capabilities,
        });
    });
});
