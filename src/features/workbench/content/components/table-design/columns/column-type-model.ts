export type ColumnTypeMode = "structured" | "raw";

export type ColumnTypeFamily =
    | "string"
    | "number"
    | "datetime"
    | "boolean"
    | "json"
    | "binary"
    | "uuid"
    | "custom";

export interface ColumnTypeDraft {
    mode: ColumnTypeMode;
    family: ColumnTypeFamily;
    baseType: string;
    length: string;
    precision: string;
    scale: string;
    timePrecision: string;
    unsigned: boolean;
    charSemantics: "" | "byte" | "char";
    enumValues: string[];
    rawTypeName: string;
}

export interface ColumnTypeDefinition {
    family: ColumnTypeFamily;
    baseType: string;
    label: string;
    supportsLength?: boolean;
    supportsPrecisionScale?: boolean;
    supportsTimePrecision?: boolean;
    supportsUnsigned?: boolean;
    supportsCharSemantics?: boolean;
    supportsEnumValues?: boolean;
    defaultLength?: string;
    defaultPrecision?: string;
    defaultScale?: string;
    defaultTimePrecision?: string;
}

export function createRawColumnTypeDraft(typeName: string): ColumnTypeDraft {
    const rawTypeName = typeName.trim();

    return {
        mode: "raw",
        family: "custom",
        baseType: rawTypeName,
        length: "",
        precision: "",
        scale: "",
        timePrecision: "",
        unsigned: false,
        charSemantics: "",
        enumValues: [],
        rawTypeName,
    };
}

export function createStructuredColumnTypeDraft(
    definition: ColumnTypeDefinition,
): ColumnTypeDraft {
    return {
        mode: "structured",
        family: definition.family,
        baseType: definition.baseType,
        length: definition.defaultLength ?? "",
        precision: definition.defaultPrecision ?? "",
        scale: definition.defaultScale ?? "",
        timePrecision: definition.defaultTimePrecision ?? "",
        unsigned: false,
        charSemantics: "",
        enumValues: [],
        rawTypeName: "",
    };
}
