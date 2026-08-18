import { expect, test } from "bun:test";

import { mysqlTableDesignProfile } from "../../src/features/workbench/content/components/table-design/driver-profiles/mysql-table-design-profile";
import { oracleTableDesignProfile } from "../../src/features/workbench/content/components/table-design/driver-profiles/oracle-table-design-profile";
import { postgresTableDesignProfile } from "../../src/features/workbench/content/components/table-design/driver-profiles/postgres-table-design-profile";
import { parseColumnType } from "../../src/features/workbench/content/components/table-design/columns/column-type-parser";

test("parses mysql unsigned decimal", () => {
    const parsed = parseColumnType("decimal(12,2) unsigned", mysqlTableDesignProfile);

    expect(parsed).toMatchObject({
        mode: "structured",
        baseType: "decimal",
        precision: "12",
        scale: "2",
        unsigned: true,
    });
});

test("parses postgres timestamp precision", () => {
    const parsed = parseColumnType("timestamptz(3)", postgresTableDesignProfile);

    expect(parsed).toMatchObject({
        mode: "structured",
        baseType: "timestamptz",
        timePrecision: "3",
    });
});

test("parses oracle char semantics", () => {
    const parsed = parseColumnType("VARCHAR2(80 CHAR)", oracleTableDesignProfile);

    expect(parsed).toMatchObject({
        mode: "structured",
        baseType: "VARCHAR2",
        length: "80",
        charSemantics: "char",
    });
});

test("falls back to raw for custom type", () => {
    const parsed = parseColumnType("GEOGRAPHY(Point, 4326)", postgresTableDesignProfile);

    expect(parsed).toMatchObject({
        mode: "raw",
        family: "custom",
        rawTypeName: "GEOGRAPHY(Point, 4326)",
    });
});
