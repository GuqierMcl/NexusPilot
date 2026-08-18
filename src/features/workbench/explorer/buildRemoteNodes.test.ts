import { describe, expect, test } from "bun:test";

import { buildRemoteNodes } from "@/features/workbench/explorer/buildRemoteNodes";
import type { DataContainer } from "@/types/ipc";

describe("buildRemoteNodes", () => {
    test("maps optional container itemCount into remote node metadata", () => {
        const nodes = buildRemoteNodes("profile-1", [
            {
                id: "profile-1::redis-db::0",
                name: "DB 0",
                kind: "redis_database",
                isLeaf: false,
                container: {
                    kind: "redis_database",
                    dbIndex: 0,
                    pattern: "*",
                },
                itemCount: 42,
            } as DataContainer,
        ]);

        const [node] = nodes;

        expect(node?.type).toBe("redis_database");
        expect("metadata" in node! ? node.metadata.itemCount : undefined).toBe(42);
    });
});
