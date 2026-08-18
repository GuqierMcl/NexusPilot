import { describe, expect, test } from "bun:test";

import { buildRemoteNodes } from "../../../../src/features/workbench/explorer/buildRemoteNodes";
import type { AssetGroupType, DataContainer } from "../../../../src/types/ipc";

function assetGroup(groupType: AssetGroupType, name: string): DataContainer {
    return {
        id: `database::app::${groupType}`,
        name,
        kind: "asset_group",
        isLeaf: false,
        container: {
            kind: "asset_group",
            groupType,
            database: "app",
        },
    };
}

describe("remote Explorer node labels", () => {
    test("localizes relationship asset groups to Chinese labels", () => {
        const nodes = buildRemoteNodes("profile-1", [
            assetGroup("tables", "Tables"),
            assetGroup("views", "Views"),
            assetGroup("materialized_views", "Materialized Views"),
            assetGroup("functions", "Functions"),
            assetGroup("procedures", "Procedures"),
            assetGroup("indexes", "Indexes"),
            assetGroup("triggers", "Triggers"),
            assetGroup("sequences", "Sequences"),
            assetGroup("extensions", "Extensions"),
            assetGroup("events", "Events"),
        ]);

        expect(nodes.map((node) => node.label)).toEqual([
            "表",
            "视图",
            "物化视图",
            "函数",
            "存储过程",
            "索引",
            "触发器",
            "序列",
            "扩展",
            "事件",
        ]);
    });

    test("keeps real remote object labels unchanged", () => {
        const [node] = buildRemoteNodes("profile-1", [
            {
                id: "database::app::table::user_profile",
                name: "user_profile",
                kind: "table",
                isLeaf: false,
                container: {
                    kind: "table",
                    database: "app",
                    table: "user_profile",
                },
            },
        ]);

        expect(node?.label).toBe("user_profile");
    });

    test("maps dictionaries projections and generic properties without changing ids", () => {
        const containers: DataContainer[] = [
            {
                id: "dictionary-id",
                name: "geo",
                kind: "dictionary",
                isLeaf: true,
                container: {
                    kind: "dictionary",
                    database: "analytics",
                    objectName: "geo",
                },
                properties: [
                    { key: "status", label: "状态", value: "LOADED" },
                ],
            },
            {
                id: "projection-id",
                name: "daily",
                kind: "projection",
                isLeaf: true,
                container: {
                    kind: "projection",
                    database: "analytics",
                    table: "events",
                    objectName: "daily",
                },
                properties: [
                    {
                        key: "definition",
                        label: "定义",
                        value: "SELECT day",
                    },
                ],
            },
        ];

        const nodes = buildRemoteNodes("profile-1", containers);

        expect(nodes.map((node) => node.type)).toEqual([
            "dictionary",
            "projection",
        ]);
        expect(nodes[0]?.id).toBe("profile-1::dictionary-id");
        expect(
            "metadata" in nodes[0]! ? nodes[0].metadata.properties : undefined,
        ).toEqual(containers[0]?.properties);
    });

    test("localizes dictionary and projection asset groups", () => {
        const nodes = buildRemoteNodes("profile-1", [
            assetGroup("dictionaries", "Dictionaries"),
            assetGroup("projections", "Projections"),
        ]);

        expect(nodes.map((node) => node.label)).toEqual(["字典", "投影"]);
    });

    test("keeps driver family badges on neutral View kinds without shared Temporary nodes", () => {
        const nodes = buildRemoteNodes("profile-1", [
            {
                id: "window",
                name: "windowed",
                kind: "view",
                isLeaf: false,
                container: { kind: "view", database: "app", table: "windowed" },
                properties: [{ key: "viewFamily", label: "Family", value: "window" }],
            },
            {
                id: "live",
                name: "legacy_live",
                kind: "view",
                isLeaf: false,
                container: { kind: "view", database: "app", table: "legacy_live" },
                properties: [{ key: "viewFamily", label: "Family", value: "live" }],
            },
            {
                id: "refreshable",
                name: "refreshable_mv",
                kind: "materialized_view",
                isLeaf: false,
                container: {
                    kind: "materialized_view",
                    database: "app",
                    table: "refreshable_mv",
                },
                properties: [
                    {
                        key: "viewFamily",
                        label: "Family",
                        value: "refreshable_materialized",
                    },
                ],
            },
        ]);
        expect(nodes.map((node) => node.type)).toEqual([
            "view",
            "view",
            "materialized_view",
        ]);
        expect(
            nodes.flatMap((node) =>
                "metadata" in node ? (node.metadata.properties ?? []) : [],
            ),
        ).not.toContainEqual(expect.objectContaining({ value: "temporary" }));
    });
});
