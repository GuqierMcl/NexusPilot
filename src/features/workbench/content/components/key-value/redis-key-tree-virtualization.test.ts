import { describe, expect, test } from "bun:test";

import { flattenRedisKeyTree } from "./redis-key-tree-virtualization";
import type { RedisKeyTreeNode } from "@/types/ipc";

function prefixNode(
    id: string,
    label: string,
    children: RedisKeyTreeNode[],
): RedisKeyTreeNode {
    return {
        id,
        label,
        nodeType: "prefix",
        prefix: `${label}:`,
        pattern: `${label}:*`,
        key: null,
        keyCount: children.length,
        valueType: null,
        children,
    };
}

function keyNode(id: string, label: string): RedisKeyTreeNode {
    return {
        id,
        label,
        nodeType: "key",
        prefix: null,
        pattern: null,
        key: label,
        keyCount: 1,
        valueType: "string",
        children: [],
    };
}

describe("flattenRedisKeyTree", () => {
    test("returns expanded visible rows in display order with depth", () => {
        const tree = [
            prefixNode("prefix:medicine:", "medicine", [
                prefixNode("prefix:medicine:node:", "node", [
                    keyNode("key:medicine:node:1", "medicine:node:1"),
                    keyNode("key:medicine:node:2", "medicine:node:2"),
                ]),
            ]),
            keyNode("key:session", "session"),
        ];

        const rows = flattenRedisKeyTree(tree, new Set());

        expect(rows.map((row) => row.node.id)).toEqual([
            "prefix:medicine:",
            "prefix:medicine:node:",
            "key:medicine:node:1",
            "key:medicine:node:2",
            "key:session",
        ]);
        expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 2, 0]);
    });

    test("does not include children of collapsed prefix rows", () => {
        const tree = [
            prefixNode("prefix:medicine:", "medicine", [
                keyNode("key:medicine:1", "medicine:1"),
            ]),
        ];

        const rows = flattenRedisKeyTree(
            tree,
            new Set(["prefix:medicine:"]),
        );

        expect(rows.map((row) => row.node.id)).toEqual(["prefix:medicine:"]);
    });
});
