import { afterEach, describe, expect, test } from "bun:test";

import {
    decideConnectionExpandAction,
} from "../../src/features/workbench/explorer/components/ConnectionTreeNode";
import {
    createExplorerMetadataStore,
} from "../../src/features/workbench/explorer/useExplorerMetadataStore";
import type { ExplorerTreeNode } from "../../src/features/workbench/explorer/types";
import { useConnectionSessionStore } from "../../src/store/slices/connection-session-slice";
import type { DriverCapabilities } from "../../src/types/ipc";

const capabilities: DriverCapabilities = {
    schemaBrowser: true,
    schemaMutator: false,
    dataTableBrowser: false,
    tableRowMutator: false,
    tableRowInserter: false,
    transactionManager: false,
    sqlExecutor: true,
    keyValueBrowser: false,
    graphQueryer: false,
    vectorSearcher: false,
};

const connectionNode = {
    id: "profile-1",
    type: "connection",
    label: "Primary",
    status: "unknown",
    connection: {},
    children: [],
} as ExplorerTreeNode;

afterEach(() => {
    useConnectionSessionStore.setState({ sessions: {} });
});

describe("Explorer hydration after Runtime Snapshot recovery", () => {
    test("loads metadata for an already-connected session without reconnecting", async () => {
        useConnectionSessionStore.setState({
            sessions: {
                "profile-1": {
                    status: "connected",
                    capabilities,
                },
            },
        });
        let loads = 0;
        const metadataStore = createExplorerMetadataStore(async () => {
            loads += 1;
            return [];
        });

        await metadataStore.getState().loadChildren(connectionNode);
        await metadataStore.getState().loadChildren(connectionNode);

        expect(loads).toBe(1);
        expect(metadataStore.getState().loadedChildren["profile-1"]).toEqual([]);
        expect(
            useConnectionSessionStore.getState().sessions["profile-1"]?.status,
        ).toBe("connected");
    });

    test("hydrates an uninitialized connection node and does not reload an empty result", () => {
        expect(decideConnectionExpandAction(false, false)).toBe("hydrate");
        expect(decideConnectionExpandAction(true, false)).toBe("none");
        expect(decideConnectionExpandAction(true, true)).toBe("toggle");
    });
});
