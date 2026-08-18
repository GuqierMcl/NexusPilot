import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { product } from "../../../../website/src/shared/config/product";

const readSource = (path: string) => readFileSync(path, "utf8");

describe("planned database support", () => {
    test("lists ClickHouse as planned in the public database matrix", () => {
        expect(product.databases).toContainEqual({
            name: "ClickHouse",
            type: "列式分析型",
            status: "planned",
        });
        expect(product.databases).toContainEqual({
            name: "Oracle",
            type: "关系型",
            status: "available",
        });
    });

    test("enables the ClickHouse connection preview in the desktop picker", () => {
        const source = readSource(
            "src/features/workbench/explorer/components/SelectDatabaseTypeDialog.tsx",
        );
        const iconSource = readSource("src/components/icons/database/index.ts");

        expect(source).toContain('displayName: "ClickHouse"');
        expect(source).toContain('driver: "clickhouse", displayName: "ClickHouse"');
        expect(source).toContain('iconKey: "clickhouse"');
        expect(source).toContain('badge: "连接预览"');
        expect(iconSource).toContain("clickhouse: ClickHouseIcon");
    });
});
