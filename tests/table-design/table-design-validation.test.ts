import { expect, test } from "bun:test";

import { mysqlTableDesignProfile } from "../../src/features/workbench/content/components/table-design/driver-profiles/mysql-table-design-profile";
import { createColumnDraft } from "../../src/features/workbench/content/components/table-design/table-design-utils";
import { validateTableDesignDraft } from "../../src/features/workbench/content/components/table-design/validation/table-design-validation";
import type { TableSchemaDraft } from "../../src/types/table-design";

function baseDraft(): TableSchemaDraft {
    return {
        basics: {
            tableName: "users",
            databaseName: "app",
            schemaName: "",
            engine: "",
            charset: "",
            collation: "",
            comment: "",
            partitionExpression: "",
            partitionRawClause: "",
            partitionReadonlyDescription: "",
        },
        columns: [],
        indexes: [],
        constraints: [],
    };
}

test("blocks duplicate column names", () => {
    const first = { ...createColumnDraft(mysqlTableDesignProfile), name: "id" };
    const second = { ...createColumnDraft(mysqlTableDesignProfile), name: "ID" };
    const issues = validateTableDesignDraft(
        { ...baseDraft(), columns: [first, second] },
        mysqlTableDesignProfile,
        "create",
    );

    expect(issues).toContainEqual(
        expect.objectContaining({
            severity: "error",
            scope: "column",
            message: "列名重复：ID",
        }),
    );
});

test("blocks numeric scale greater than precision", () => {
    const column = {
        ...createColumnDraft(mysqlTableDesignProfile),
        name: "amount",
        typeDraft: {
            ...mysqlTableDesignProfile.defaults.columnType,
            family: "number" as const,
            baseType: "decimal",
            precision: "4",
            scale: "8",
        },
        typeName: "decimal(4,8)",
    };
    const issues = validateTableDesignDraft(
        { ...baseDraft(), columns: [column] },
        mysqlTableDesignProfile,
        "create",
    );

    expect(issues).toContainEqual(
        expect.objectContaining({
            severity: "error",
            scope: "column",
            field: "scale",
            message: "小数位不能大于精度",
        }),
    );
});

test("blocks index columns that do not exist", () => {
    const column = { ...createColumnDraft(mysqlTableDesignProfile), name: "id" };
    const issues = validateTableDesignDraft(
        {
            ...baseDraft(),
            columns: [column],
            indexes: [
                {
                    id: "index::missing",
                    name: "idx_missing",
                    columns: "missing_id",
                    isUnique: false,
                    method: "btree",
                    comment: "",
                },
            ],
        },
        mysqlTableDesignProfile,
        "create",
    );

    expect(issues).toContainEqual(
        expect.objectContaining({
            severity: "error",
            scope: "index",
            field: "columns",
        }),
    );
});

test("warns but does not block raw column type", () => {
    const column = {
        ...createColumnDraft(mysqlTableDesignProfile),
        name: "shape",
        typeName: "GEOMETRY",
        typeDraft: {
            mode: "raw" as const,
            family: "custom" as const,
            baseType: "GEOMETRY",
            length: "",
            precision: "",
            scale: "",
            timePrecision: "",
            unsigned: false,
            charSemantics: "" as const,
            enumValues: [],
            rawTypeName: "GEOMETRY",
        },
    };
    const issues = validateTableDesignDraft(
        { ...baseDraft(), columns: [column] },
        mysqlTableDesignProfile,
        "create",
    );

    expect(issues).toContainEqual(
        expect.objectContaining({
            severity: "warning",
            scope: "column",
            field: "typeName",
        }),
    );
    expect(issues.some((issue) => issue.severity === "error")).toBe(false);
});
