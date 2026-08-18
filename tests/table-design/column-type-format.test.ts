import { expect, test } from "bun:test";

import { mysqlTableDesignProfile } from "../../src/features/workbench/content/components/table-design/driver-profiles/mysql-table-design-profile";
import { oracleTableDesignProfile } from "../../src/features/workbench/content/components/table-design/driver-profiles/oracle-table-design-profile";
import { postgresTableDesignProfile } from "../../src/features/workbench/content/components/table-design/driver-profiles/postgres-table-design-profile";
import { formatColumnType } from "../../src/features/workbench/content/components/table-design/columns/column-type-format";

test("formats mysql decimal precision scale and unsigned", () => {
    expect(
        formatColumnType(
            {
                mode: "structured",
                family: "number",
                baseType: "decimal",
                length: "",
                precision: "12",
                scale: "2",
                timePrecision: "",
                unsigned: true,
                charSemantics: "",
                enumValues: [],
                rawTypeName: "",
            },
            mysqlTableDesignProfile,
        ),
    ).toBe("decimal(12,2) unsigned");
});

test("formats postgres timestamptz time precision", () => {
    expect(
        formatColumnType(
            {
                mode: "structured",
                family: "datetime",
                baseType: "timestamptz",
                length: "",
                precision: "",
                scale: "",
                timePrecision: "3",
                unsigned: false,
                charSemantics: "",
                enumValues: [],
                rawTypeName: "",
            },
            postgresTableDesignProfile,
        ),
    ).toBe("timestamptz(3)");
});

test("formats oracle varchar2 char semantics", () => {
    expect(
        formatColumnType(
            {
                mode: "structured",
                family: "string",
                baseType: "VARCHAR2",
                length: "80",
                precision: "",
                scale: "",
                timePrecision: "",
                unsigned: false,
                charSemantics: "char",
                enumValues: [],
                rawTypeName: "",
            },
            oracleTableDesignProfile,
        ),
    ).toBe("VARCHAR2(80 CHAR)");
});
