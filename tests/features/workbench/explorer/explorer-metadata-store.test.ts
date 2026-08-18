import { expect, test } from "bun:test";

import { createExplorerMetadataStore } from "../../../../src/features/workbench/explorer/useExplorerMetadataStore";
import type { ExplorerTreeNode } from "../../../../src/features/workbench/explorer/types";
import { useConnectionSessionStore } from "../../../../src/store/slices/connection-session-slice";
import type {
    AssetGroupType,
    ContainerRef,
    DataContainer,
    DriverCapabilities,
} from "../../../../src/types/ipc";

const SCHEMA_BROWSER_CAPABILITIES: DriverCapabilities = {
    schemaBrowser: true,
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

function seedSession(
    profileId: string,
    status: "connected" | "degraded",
): void {
    useConnectionSessionStore.setState((state) => ({
        sessions: {
            ...state.sessions,
            [profileId]: {
                status,
                capabilities: SCHEMA_BROWSER_CAPABILITIES,
            },
        },
    }));
}

function groupNode(
    profileId: string,
    groupType: AssetGroupType,
): ExplorerTreeNode {
    return {
        id: `${profileId}::analytics::${groupType}`,
        type: "asset_group",
        label: groupType,
        isLeaf: false,
        metadata: {
            profileId,
            dbName: "analytics",
            container: {
                kind: "asset_group",
                groupType,
                database: "analytics",
                table: "events",
            },
        },
    };
}

function leafContainer(
    kind: "column" | "projection",
    name: string,
): DataContainer {
    const container: ContainerRef =
        kind === "column"
            ? {
                  kind,
                  database: "analytics",
                  table: "events",
                  column: name,
              }
            : {
                  kind,
                  database: "analytics",
                  table: "events",
                  objectName: name,
              };
    return {
        id: `${kind}::${name}`,
        name,
        kind,
        isLeaf: true,
        container,
    };
}

test("a failed metadata group keeps successful siblings and can retry itself", async () => {
    useConnectionSessionStore.setState({ sessions: {} });
    seedSession("profile-1", "connected");
    let projectionDenied = true;
    const calls: AssetGroupType[] = [];
    const loader = async (
        _profileId: string,
        parent: ContainerRef | null,
    ): Promise<DataContainer[]> => {
        const group = parent?.groupType;
        if (!group) throw new Error("group required");
        calls.push(group);
        if (group === "projections" && projectionDenied) {
            throw {
                code: "SYSTEM_INTERNAL",
                runtimeImpact: "businessOnly",
                message: "ClickHouse metadata access denied",
            };
        }
        return group === "columns"
            ? [leafContainer("column", "id")]
            : [leafContainer("projection", "daily")];
    };
    const store = createExplorerMetadataStore(loader);
    const columns = groupNode("profile-1", "columns");
    const projections = groupNode("profile-1", "projections");

    await store.getState().loadChildren(columns);
    await store.getState().loadChildren(projections);

    expect(store.getState().loadedChildren[columns.id]).toHaveLength(1);
    expect(store.getState().errorKeys[projections.id]).toContain(
        "metadata access denied",
    );
    expect(store.getState().loadedChildren[projections.id]).toBeUndefined();
    expect(useConnectionSessionStore.getState().sessions["profile-1"]?.status).toBe(
        "connected",
    );

    projectionDenied = false;
    await store.getState().reloadChildren(projections);

    expect(store.getState().errorKeys[projections.id]).toBeUndefined();
    expect(store.getState().loadedChildren[projections.id]).toHaveLength(1);
    expect(calls).toEqual(["columns", "projections", "projections"]);
});

test("degraded runtime keeps stale metadata and blocks new requests", async () => {
    useConnectionSessionStore.setState({ sessions: {} });
    seedSession("profile-1", "connected");
    let calls = 0;
    const store = createExplorerMetadataStore(async () => {
        calls += 1;
        return [leafContainer("column", "stale")];
    });
    const columns = groupNode("profile-1", "columns");

    await store.getState().loadChildren(columns);
    seedSession("profile-1", "degraded");
    await store.getState().reloadChildren(columns);

    expect(calls).toBe(1);
    expect(store.getState().loadedChildren[columns.id]?.[0]?.label).toBe("stale");
});

test("clearForProfile respects the complete profile id boundary", () => {
    const store = createExplorerMetadataStore(async () => []);
    store.setState({
        loadedChildren: {
            "profile-1::root": [],
            "profile-10::root": [],
        },
        errorKeys: {
            "profile-1::root": "denied",
            "profile-10::root": "other",
        },
        loadingKeys: new Set(["profile-1::root", "profile-10::root"]),
    });

    store.getState().clearForProfile("profile-1");

    expect(Object.keys(store.getState().loadedChildren)).toEqual([
        "profile-10::root",
    ]);
    expect(Object.keys(store.getState().errorKeys)).toEqual([
        "profile-10::root",
    ]);
    expect([...store.getState().loadingKeys]).toEqual(["profile-10::root"]);
});
