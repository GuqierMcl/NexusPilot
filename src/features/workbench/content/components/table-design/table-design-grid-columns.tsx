import type { DataTableColumn } from "@/components/data-table";

import { CONSTRAINT_KIND_OPTIONS } from "./table-design-constants";
import { typeOptionsForDriver } from "./table-design-utils";

export function buildColumnColumns(driver: string | null): DataTableColumn[] {
    return [
        { id: "name", header: "列名", width: 160 },
        {
            id: "typeName",
            header: "类型",
            width: 160,
            dataCategory: "enum",
            enumValues: typeOptionsForDriver(driver),
        },
        { id: "nullable", header: "可空", width: 92, dataCategory: "boolean" },
        { id: "defaultValue", header: "默认值", width: 140 },
        { id: "isPrimaryKey", header: "主键", width: 92, dataCategory: "boolean" },
        { id: "isUnique", header: "唯一", width: 92, dataCategory: "boolean" },
        { id: "isIdentity", header: "自增", width: 92, dataCategory: "boolean" },
        { id: "comment", header: "注释", width: 180, maxWidth: 280 },
    ];
}

export function buildIndexColumns(): DataTableColumn[] {
    return [
        { id: "name", header: "索引名", width: 160 },
        { id: "columns", header: "列", width: 220 },
        { id: "isUnique", header: "唯一", width: 92, dataCategory: "boolean" },
        { id: "method", header: "方法", width: 120 },
        { id: "comment", header: "注释", width: 180, maxWidth: 280 },
    ];
}

export function buildConstraintColumns(): DataTableColumn[] {
    return [
        { id: "name", header: "约束名", width: 160 },
        {
            id: "kind",
            header: "类型",
            width: 140,
            dataCategory: "enum",
            enumValues: CONSTRAINT_KIND_OPTIONS,
        },
        { id: "columns", header: "列", width: 220 },
        { id: "reference", header: "引用", width: 200 },
        { id: "expression", header: "表达式", width: 200, maxWidth: 320 },
        { id: "comment", header: "注释", width: 180, maxWidth: 280 },
    ];
}
